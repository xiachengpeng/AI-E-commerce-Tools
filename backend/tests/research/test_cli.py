from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import UUID

import pytest

from rabbit_hole import cli
from rabbit_hole.worker import WorkerRunResult

FIXTURES = Path(__file__).parent / "fixtures" / "meta"


def _run_meta_smoke(
    fixture: str, evidence_dir: Path
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(Path(__file__).parents[1] / "src")
    environment["RABBIT_HOLE_META_SMOKE_FIXTURE"] = str(FIXTURES / fixture)
    environment["RABBIT_HOLE_META_SMOKE_EVIDENCE_DIR"] = str(evidence_dir)
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "rabbit_hole.cli",
            "meta-smoke",
            "--market",
            "US",
            "--query",
            "portable organizer",
            "--limit",
            "5",
        ],
        cwd=Path(__file__).parents[1],
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def test_meta_smoke_command_returns_ads_and_screenshot_evidence(tmp_path: Path) -> None:
    completed = _run_meta_smoke("smoke.html", tmp_path)

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["ok"] is True
    assert payload["market"] == "US"
    assert payload["query"] == "portable organizer"
    assert payload["limit"] == 5
    assert [item["ad_id"] for item in payload["ads"]] == ["1001", "1002"]
    assert payload["displayed_filters"] == {
        "market": "US",
        "status": "active",
        "media_type": "video",
        "search_mode": "exact_phrase",
        "query": '"portable organizer"',
    }
    screenshot = Path(payload["screenshot_evidence"]["path"])
    assert screenshot.parent == tmp_path
    assert screenshot.stat().st_size == payload["screenshot_evidence"]["bytes"]
    assert (
        hashlib.sha256(screenshot.read_bytes()).hexdigest()
        == payload["screenshot_evidence"]["sha256"]
    )


def test_meta_smoke_command_rejects_untyped_empty_success(tmp_path: Path) -> None:
    completed = _run_meta_smoke("empty-smoke.html", tmp_path)

    assert completed.returncode == 2
    payload = json.loads(completed.stdout)
    assert payload == {
        "ok": False,
        "error": {"type": "meta_health", "code": "empty_results"},
    }


def test_meta_smoke_command_returns_typed_captcha_failure(tmp_path: Path) -> None:
    completed = _run_meta_smoke("captcha.html", tmp_path)

    assert completed.returncode == 2
    payload = json.loads(completed.stdout)
    assert payload == {
        "ok": False,
        "error": {"type": "meta_health", "code": "captcha"},
    }


def test_meta_smoke_command_fails_closed_when_filter_reverts(tmp_path: Path) -> None:
    completed = _run_meta_smoke("reverted-filter.html", tmp_path)

    assert completed.returncode == 2
    payload = json.loads(completed.stdout)
    assert payload == {
        "ok": False,
        "error": {
            "type": "meta_health",
            "code": "displayed_filters_mismatch",
        },
    }


class FakeOperatorRuntime:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []
        self.closed = False

    async def poll_once(self) -> int:
        self.calls.append(("poll-once", None))
        return 3

    async def worker_once(self) -> WorkerRunResult:
        self.calls.append(("worker-once", None))
        return WorkerRunResult(outcome="idle")

    async def bootstrap_feishu(self, *, dry_run: bool) -> object:
        self.calls.append(("bootstrap-feishu", dry_run))
        return {"tables": 9, "dry_run": dry_run}

    async def requeue(self, job_id: UUID) -> object:
        self.calls.append(("requeue", job_id))
        return {"job_id": str(job_id), "status": "ready"}

    async def purge_expired_evidence(self, *, dry_run: bool) -> list[str]:
        self.calls.append(("purge-expired-evidence", dry_run))
        return ["evidence/US/expired"]

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.parametrize(
    ("arguments", "expected_call"),
    [
        (["poll-once"], ("poll-once", None)),
        (["worker-once"], ("worker-once", None)),
        (["bootstrap-feishu", "--dry-run"], ("bootstrap-feishu", True)),
        (
            ["requeue", "00000000-0000-0000-0000-000000000001"],
            ("requeue", UUID(int=1)),
        ),
        (
            ["purge-expired-evidence", "--dry-run"],
            ("purge-expired-evidence", True),
        ),
    ],
)
def test_operator_commands_dispatch_once_and_close_runtime(
    arguments: list[str],
    expected_call: tuple[str, object],
    capsys: pytest.CaptureFixture[str],
) -> None:
    runtime = FakeOperatorRuntime()

    assert cli.main(arguments, runtime=runtime) == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["command"] == arguments[0]
    assert runtime.calls == [expected_call]
    assert runtime.closed is True


def test_purge_command_requires_explicit_dry_run() -> None:
    with pytest.raises(SystemExit):
        cli._parser().parse_args(["purge-expired-evidence"])


def test_operator_command_fails_closed_without_complete_settings() -> None:
    environment = {
        name: value
        for name, value in os.environ.items()
        if not name.startswith("RABBIT_HOLE_")
    }
    environment["PYTHONPATH"] = str(Path(__file__).parents[1] / "src")

    completed = subprocess.run(
        [sys.executable, "-m", "rabbit_hole.cli", "poll-once"],
        cwd=Path(__file__).parents[1],
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert completed.returncode == 2
    assert json.loads(completed.stdout) == {
        "ok": False,
        "error": {"type": "configuration", "code": "owned_local_runtime_required"},
    }


def test_production_worker_main_fails_closed_without_settings() -> None:
    environment = {
        name: value
        for name, value in os.environ.items()
        if not name.startswith("RABBIT_HOLE_")
    }
    environment["PYTHONPATH"] = str(Path(__file__).parents[1] / "src")

    completed = subprocess.run(
        [sys.executable, "-m", "rabbit_hole.worker"],
        cwd=Path(__file__).parents[1],
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert completed.returncode == 2
    assert json.loads(completed.stdout) == {
        "ok": False,
        "error": {"type": "configuration", "code": "owned_local_runtime_required"},
    }
