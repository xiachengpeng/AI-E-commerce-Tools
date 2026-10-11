"""Per-user launchd management; credentials remain in the private JSON file."""
from __future__ import annotations

import argparse
import os
import plistlib
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

from rabbit_hole.runtime.native import load_environment


def service_plist(component: str, project_root: Path, data_root: Path) -> dict[str, Any]:
    if component not in {"api", "worker"} or not project_root.is_absolute() or not data_root.is_absolute():
        raise ValueError("invalid native service")
    return {
        "Label": "com.rabbit-hole." + component,
        "ProgramArguments": [str(project_root / ".venv-macos/bin/python"), "-m",
            "rabbit_hole.runtime.native", "--config", str(data_root / "runtime.json"), component],
        "WorkingDirectory": str(project_root),
        "EnvironmentVariables": {"PYTHONPATH": str(project_root / "src"),
            "PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"},
        "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10, "ExitTimeOut": 30,
        "Umask": 0o077, "ProcessType": "Background",
        "StandardOutPath": str(data_root / "logs" / (component + ".log")),
        "StandardErrorPath": str(data_root / "logs" / (component + ".err.log")),
    }


def _loaded(label: str) -> bool:
    return subprocess.run(["/bin/launchctl", "print", f"gui/{os.getuid()}/{label}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode == 0


def _service_pid(label: str) -> int | None:
    result = subprocess.run(["/bin/launchctl", "print", f"gui/{os.getuid()}/{label}"],
        capture_output=True, text=True, check=False)
    match = re.search(r"^\s*pid = (\d+)", result.stdout, re.MULTILINE)
    return int(match.group(1)) if match else None


def wait_for_exit(pids: list[int], *, timeout: float = 35) -> None:
    """bootout returns before SIGTERM cleanup; wait before restart or backup."""
    deadline = time.monotonic() + timeout
    remaining = set(pids)
    while remaining:
        for pid in list(remaining):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                remaining.remove(pid)
        if not remaining:
            return
        if time.monotonic() >= deadline:
            raise TimeoutError("Native stop incomplete: existing processes have not exited")
        time.sleep(.05)


def _worker_healthy(project: Path, data: Path) -> bool:
    return subprocess.run([str(project / ".venv-macos/bin/python"), "-m",
        "rabbit_hole.runtime.native", "--config", str(data / "runtime.json"), "worker-health"],
        env={**os.environ, "PYTHONPATH": str(project / "src")},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False).returncode == 0


def ensure_can_start(project: Path, data: Path, *, api_loaded: bool, worker_loaded: bool, port: int = 8000) -> None:
    if not api_loaded:
        with socket.socket() as connection:
            connection.settimeout(.5)
            if connection.connect_ex(("127.0.0.1", port)) == 0:
                raise RuntimeError("Native start refused: port is already in use")
    if not worker_loaded and _worker_healthy(project, data):
        raise RuntimeError("Native start refused: another worker is still live")


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage native workbench LaunchAgents")
    parser.add_argument("action", choices=["install", "start", "stop", "restart", "status"])
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--data-root", type=Path, default=Path.home() / "rabbit-hole-data")
    args = parser.parse_args()
    if sys.platform != "darwin":
        print("Native service management requires macOS", file=sys.stderr)
        return 2
    project, data = args.project_root, args.data_root
    config = data / "runtime.json"
    agents = Path.home() / "Library/LaunchAgents"
    if args.action == "install":
        load_environment(config)
        if not (project / ".venv-macos/bin/python").is_file():
            raise ValueError("native Python environment not installed")
        agents.mkdir(parents=True, exist_ok=True)
        (data / "logs").mkdir(mode=0o700, exist_ok=True)
        for component in ("api", "worker"):
            fd, name = tempfile.mkstemp(dir=agents)
            try:
                with os.fdopen(fd, "wb") as stream:
                    plistlib.dump(service_plist(component, project, data), stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(name, agents / ("com.rabbit-hole." + component + ".plist"))
            finally:
                if os.path.exists(name):
                    os.unlink(name)
        print("Native LaunchAgents installed; start them after Docker worker is stopped")
        return 0
    if args.action in {"stop", "restart"}:
        stopped_pids: list[int] = []
        for component in ("api", "worker"):
            label = "com.rabbit-hole." + component
            if _loaded(label):
                pid = _service_pid(label)
                if pid is not None:
                    stopped_pids.append(pid)
                subprocess.run(["/bin/launchctl", "bootout", f"gui/{os.getuid()}/{label}"], check=True)
        wait_for_exit(stopped_pids)
    if args.action in {"start", "restart"}:
        load_environment(config)
        ensure_can_start(project, data, api_loaded=_loaded("com.rabbit-hole.api"),
                         worker_loaded=_loaded("com.rabbit-hole.worker"))
    healthy = True
    for component in ("api", "worker"):
        label = "com.rabbit-hole." + component
        loaded = _loaded(label)
        if args.action in {"start", "restart"} and not loaded:
            subprocess.run(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}",
                str(agents / (label + ".plist"))], check=True)
            loaded = True
        if args.action == "status":
            good = False
            if loaded and component == "api":
                try:
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    with opener.open("http://127.0.0.1:8000/ready", timeout=5) as response:
                        good = response.status == 200
                except OSError:
                    pass
            elif loaded:
                good = _worker_healthy(project, data)
            healthy = healthy and loaded and good
            print(f"{component}: {'loaded' if loaded else 'stopped'}, {'healthy' if good else 'unavailable'}")
    return 0 if healthy else 1


if __name__ == "__main__":
    sys.exit(main())
