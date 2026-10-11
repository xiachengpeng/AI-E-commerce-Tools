"""Test-only fail-closed network/subprocess boundary inherited by Python children."""

import hashlib
import ipaddress
import json
import os
import shlex
import shutil
import socket
import subprocess
import sys
from pathlib import Path


def loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def permitted_browser_url(browser, url):
    from urllib.parse import unquote, urlsplit

    parsed = urlsplit(url)
    if parsed.scheme in ("about", "data"):
        return True
    if parsed.scheme == "file":
        return (
            Path(unquote(parsed.path))
            .resolve()
            .is_relative_to(Path(os.environ["FULL_MERGE_SANDBOX"]).resolve())
        )
    return loopback(parsed.hostname or "") or bool(
        getattr(browser, "_full_merge_loopback_proxy", False)
    )


original_connect = socket.socket.connect
original_connect_ex = socket.socket.connect_ex
original_sendto = socket.socket.sendto


def check_address(sock, address):
    if sock.family in (socket.AF_INET, socket.AF_INET6) and not loopback(address[0]):
        raise RuntimeError("isolated test network blocks non-loopback destinations")


def connect(sock, address):
    check_address(sock, address)
    return original_connect(sock, address)


def connect_ex(sock, address):
    check_address(sock, address)
    return original_connect_ex(sock, address)


def sendto(sock, data, *args):
    check_address(sock, args[-1])
    return original_sendto(sock, data, *args)


socket.socket.connect = connect
socket.socket.connect_ex = connect_ex
socket.socket.sendto = sendto
original_popen = subprocess.Popen


def validate_python_options(args):
    for flag in args[1:]:
        if flag in ("-c", "-m", "--") or not str(flag).startswith("-"):
            break
        # Only source-suite interpreter options that preserve site/PYTHONPATH.
        if not flag.startswith("--") and flag[1:] and set(flag[1:]) <= set("bBuqsv"):
            continue
        raise RuntimeError("isolated test subprocess blocks unsafe Python options")


def child_sandbox(kwargs):
    parent = Path(os.environ["FULL_MERGE_SANDBOX"]).resolve()
    requested = Path(
        (kwargs.get("env") or {}).get("FULL_MERGE_SANDBOX", str(parent))
    ).resolve()
    if not requested.is_relative_to(parent):
        raise RuntimeError("isolated test subprocess blocks sandbox escape")
    return requested


def inherited_environment(kwargs):
    env = dict(kwargs.get("env") if kwargs.get("env") is not None else os.environ)
    env.pop("PYTHONHOME", None)
    env["PYTHONPATH"] = (
        str(Path(__file__).parent) + os.pathsep + env.get("PYTHONPATH", "")
    )
    env["FULL_MERGE_SANDBOX"] = str(child_sandbox(kwargs))
    env["NODE_OPTIONS"] = "--require=" + json.dumps(
        str(Path(__file__).parent / "node_guard.cjs"), ensure_ascii=False
    )
    for name in ("PLAYWRIGHT_BROWSERS_PATH", "FULL_MERGE_SUITE"):
        if name in os.environ:
            env[name] = os.environ[name]
    return env


class IsolatedPopen(original_popen):
    def __init__(self, args, *positional, **kwargs):
        allowed = False
        if kwargs.get("executable") is not None:
            raise RuntimeError("isolated test subprocess blocks executable override")
        if isinstance(args, (list, tuple)) and args:
            executable = Path(
                shutil.which(
                    str(args[0]), path=(kwargs.get("env") or os.environ).get("PATH")
                )
                or str(args[0])
            ).resolve()
            if executable == Path(sys.executable).resolve():
                validate_python_options(args)
                allowed = True
                kwargs["env"] = inherited_environment(kwargs)
            elif (
                executable.name == "python"
                and executable.is_file()
                and executable.read_bytes().startswith(b"#!/bin/sh\nexec ")
            ):
                expected = "#!/bin/sh\nexec " + shlex.quote(sys.executable) + ' "$@"\n'
                if executable.read_text() == expected and str(executable).startswith(
                    os.environ["FULL_MERGE_SANDBOX"] + os.sep
                ):
                    args = [sys.executable, *args[1:]]
                    validate_python_options(args)
                    allowed = True
                    kwargs["env"] = inherited_environment(kwargs)
            elif str(args[0]) == "ssh":
                # Replace the retained local SSH test stub with its guarded Python
                # payload. Real ssh and arbitrary shell scripts remain forbidden.
                env = kwargs.get("env") or os.environ
                stub = shutil.which("ssh", path=env.get("PATH"))
                payload = (
                    Path(stub).read_text()
                    if stub
                    and Path(stub).is_file()
                    and str(Path(stub).resolve()).startswith(
                        os.environ["FULL_MERGE_SANDBOX"] + os.sep
                    )
                    else ""
                )
                expected_code = 'import socket,time;s=socket.socket();s.bind(("127.0.0.1",19503));s.listen();time.sleep(30)'
                if (
                    payload
                    == "#!/bin/sh\nexec "
                    + shlex.quote(sys.executable)
                    + " -c "
                    + shlex.quote(expected_code)
                    + "\n"
                ):
                    args = [sys.executable, "-c", expected_code]
                    validate_python_options(args)
                    kwargs["env"] = inherited_environment(kwargs)
                    allowed = True
            elif (
                executable.name == "node"
                and executable.parent.name == "driver"
                and "playwright" in str(executable)
                and len(args) == 3
                and Path(args[1]).resolve() == executable.parent / "package/cli.js"
                and args[2] == "run-driver"
            ):
                kwargs["env"] = inherited_environment(kwargs)
                allowed = True
            elif (
                executable == Path(shutil.which("node") or "/missing-node").resolve()
                and len(args) >= 3
                and args[1] == "--test"
                and all(
                    Path(item)
                    .resolve()
                    .is_relative_to(child_sandbox(kwargs) / "frontend/tests")
                    for item in args[2:]
                    if item != "--test-isolation=none"
                )
            ):
                allowed = True
                kwargs["env"] = inherited_environment(kwargs)
            elif str(args[0]) == "/bin/sh" and len(args) == 3 and args[1] == "-ec":
                # The retained Compose test runs ONLY its synthetic mc shell fixture.
                env = kwargs.get("env", {})
                fixture = Path(env.get("PATH", "").split(os.pathsep)[0]) / "mc"
                if (
                    fixture.is_file()
                    and hashlib.sha256(fixture.read_bytes()).hexdigest()
                    == "608ee93e825ab69fdfefdf7ac73286bb0ebcfcc64c47b5881efc2482ba667ee7"
                    and hashlib.sha256(args[2].encode()).hexdigest()
                    == "917adb3c2bcafabd8dd8a26ca40e814fc23f4dafacb96c23930fa4951716b147"
                    and env.get("MINIO_ROOT_USER") == "task-user"
                    and env.get("MINIO_ROOT_PASSWORD") == "task-only secret"
                ):
                    allowed = True
        if not allowed or kwargs.get("shell"):
            raise RuntimeError("isolated test subprocess blocks unguarded executables")
        super().__init__(args, *positional, **kwargs)


subprocess.Popen = IsolatedPopen
# Browser transports run in Playwright's Node driver. Intercept at Chromium's
# context boundary before any page exists; later fixture routes can still fulfill
# synthetic external URLs without hitting a real network.
try:
    from playwright.async_api import Browser

    original_context = Browser.new_context

    async def new_context(browser, *args, **kwargs):
        kwargs["service_workers"] = "block"
        context = await original_context(browser, *args, **kwargs)

        async def guard(route):

            if permitted_browser_url(browser, route.request.url):
                await route.continue_()
            else:
                await route.abort("blockedbyclient")

        await context.route("**/*", guard)
        return context

    Browser.new_context = new_context
except ImportError:
    pass

# DNS itself can transmit externally, even without a subsequent connection.
original_getaddrinfo = socket.getaddrinfo


def getaddrinfo(host, *args, **kwargs):
    if os.environ.get("FULL_MERGE_SUITE") == "main" and host in {
        "api.firecrawl.dev",
        "example.com",
        "amazon.com",
        "mywp.com",
        "my-store.com",
        "my-store.myshopify.com",
        "mystore.myshopify.com",
        "shopify-staged-uploads.storage.googleapis.com",
    }:
        port = args[0] if args and args[0] is not None else 0
        return [
            (
                socket.AF_INET,
                socket.SOCK_STREAM,
                socket.IPPROTO_TCP,
                "",
                ("93.184.216.34", port),
            )
        ]
    if host is not None and not loopback(host):
        raise RuntimeError("isolated test network blocks external DNS")
    return original_getaddrinfo(host, *args, **kwargs)


socket.getaddrinfo = getaddrinfo

try:
    from playwright.async_api import Browser as AsyncBrowser

    original_page = AsyncBrowser.new_page

    async def new_page(browser, *args, **kwargs):
        kwargs["service_workers"] = "block"
        page = await original_page(browser, *args, **kwargs)

        async def guard(route):

            if permitted_browser_url(browser, route.request.url):
                await route.continue_()
            else:
                await route.abort("blockedbyclient")

        await page.context.route("**/*", guard)
        return page

    AsyncBrowser.new_page = new_page
    from playwright.sync_api import Browser as SyncBrowser

    original_sync_context = SyncBrowser.new_context

    def sync_context(browser, *args, **kwargs):
        kwargs["service_workers"] = "block"
        context = original_sync_context(browser, *args, **kwargs)

        def guard(route):

            if permitted_browser_url(browser, route.request.url):
                route.continue_()
            else:
                route.abort("blockedbyclient")

        context.route("**/*", guard)
        return context

    SyncBrowser.new_context = sync_context
except ImportError:
    pass

try:
    from playwright.async_api import BrowserType

    original_launch = BrowserType.launch

    async def launch(browser_type, *args, **kwargs):
        from urllib.parse import urlsplit

        proxy = kwargs.get("proxy")
        pinned_proxy = bool(
            proxy and loopback(urlsplit(proxy.get("server", "")).hostname or "")
        )
        if proxy and not pinned_proxy:
            raise RuntimeError("isolated test network blocks external browser proxy")
        kwargs["args"] = [
            *kwargs.get("args", []),
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1",
            "--disable-background-networking",
        ]
        browser = await original_launch(browser_type, *args, **kwargs)
        browser._full_merge_loopback_proxy = pinned_proxy
        return browser

    BrowserType.launch = launch
except ImportError:
    pass
