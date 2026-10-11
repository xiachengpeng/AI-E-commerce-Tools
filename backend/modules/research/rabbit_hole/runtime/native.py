"""Private host configuration and native API/worker entry points."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import stat
import sys
from pathlib import Path

from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError


def load_environment(path: Path) -> dict[str, str]:
    """Reject container configuration and report no credential-bearing details."""
    try:
        if any(part.is_symlink() for part in (path, *path.parents)):
            raise ValueError
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "r") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError
            raw = stream.read(131073)
        if len(raw) > 131072:
            raise ValueError
        value = json.loads(raw)
        if not isinstance(value, dict) or not value:
            raise ValueError
        for key, item in value.items():
            if not isinstance(key, str) or not (key.startswith("RABBIT_HOLE_") or key == "PLAYWRIGHT_BROWSERS_PATH"):
                raise ValueError
            if not isinstance(item, str) or "\x00" in key + item:
                raise ValueError
        url = make_url(value["RABBIT_HOLE_DATABASE_URL"])
        if url.drivername != "sqlite+aiosqlite" or not url.database or not Path(url.database).is_absolute() or url.query or url.database == "/app" or url.database.startswith("/app/"):
            raise ValueError
        if value["RABBIT_HOLE_STORAGE_BACKEND"] != "files" or not value["RABBIT_HOLE_LAN_IP"]:
            raise ValueError
        for key in ("RABBIT_HOLE_STORAGE_PATH", "RABBIT_HOLE_PROVIDER_SECRETS_PATH", "PLAYWRIGHT_BROWSERS_PATH"):
            item = value[key]
            if not Path(item).is_absolute() or item == "/app" or item.startswith(("/app/", "/ms-playwright")):
                raise ValueError
        return value
    except (OSError, ValueError, KeyError, TypeError, ArgumentError):
        raise ValueError("Native configuration unavailable or invalid") from None


def main() -> int:
    parser = argparse.ArgumentParser(description="Native Rabbit Hole runtime")
    parser.add_argument("--config", required=True, type=Path)
    roles = parser.add_subparsers(dest="role", required=True)
    api = roles.add_parser("api")
    api.add_argument("--port", type=int, default=8000)
    roles.add_parser("worker")
    roles.add_parser("worker-health")
    args = parser.parse_args()
    try:
        os.environ.update(load_environment(args.config))
        # Validate typed application settings before Uvicorn can log raw values.
        from rabbit_hole.config import get_settings
        get_settings()
    except ValueError:
        print("Native configuration unavailable or invalid", file=sys.stderr)
        return 2
    if args.role == "api":
        import uvicorn
        uvicorn.run("rabbit_hole.runtime.server:create_app", host="0.0.0.0", port=args.port,
                    factory=True, access_log=False)
        return 0
    from rabbit_hole.runtime.workbench_worker import healthcheck
    from rabbit_hole.runtime.workbench_worker import main as worker_main
    if args.role == "worker-health":
        try:
            return 0 if asyncio.run(healthcheck()) else 1
        except Exception:  # noqa: BLE001 -- health probes expose no configuration
            return 1
    return worker_main()


if __name__ == "__main__":
    sys.exit(main())
