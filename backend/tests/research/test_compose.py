"""The initializer must execute a shell despite the mc image's entrypoint."""

import os
import subprocess
from pathlib import Path

import yaml


def test_app_healthcheck_uses_core_readiness_endpoint():
    compose = yaml.safe_load((Path(__file__).parents[1] / "compose.yaml").read_text())
    command = compose["services"]["api"]["healthcheck"]["test"]

    assert any("/ready" in item for item in command)


def test_minio_init_overrides_mc_entrypoint_and_preserves_bucket_setup(tmp_path):
    compose = yaml.safe_load((Path(__file__).parents[1] / "compose.yaml").read_text())
    service = compose["services"]["minio-init"]
    # The pinned image defaults to ENTRYPOINT ["mc"]. Compose command replaces
    # only CMD: putting /bin/sh there would invoke `mc /bin/sh -ec ...`.
    entrypoint = service.get("entrypoint", ["mc"])
    command = service["command"]
    assert isinstance(entrypoint, list) and isinstance(command, list)
    effective_argv = entrypoint + command
    assert effective_argv[:2] == ["/bin/sh", "-ec"]
    assert len(effective_argv) == 3

    # Exercise the parsed script using a local mc boundary. This checks ordering,
    # retry and shell quoting without pretending that Docker or MinIO ran.
    mc = tmp_path / "mc"
    mc.write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$*" >> "$CALL_LOG"\n'
        'if [ "$1" = alias ] && [ ! -e "$READY_MARKER" ]; then\n'
        '  touch "$READY_MARKER"; exit 1\n'
        "fi\n"
        'if [ "${FAIL_VERSION:-0}" = 1 ] && [ "$1" = version ]; then exit 17; fi\n'
    )
    mc.chmod(0o700)
    log = tmp_path / "calls"
    environment = {
        **os.environ,
        "PATH": f"{tmp_path}:{os.environ['PATH']}",
        "CALL_LOG": str(log),
        "READY_MARKER": str(tmp_path / "ready"),
        "MINIO_ROOT_USER": "task-user",
        "MINIO_ROOT_PASSWORD": "task-only secret",
        "RABBIT_HOLE_S3_BUCKET": "task-candidates",
    }
    # Compose substitutes $$ with a literal $ before launching the container.
    argv = [*effective_argv[:2], effective_argv[2].replace("$$", "$")]
    subprocess.run(argv, env=environment, check=True, timeout=10)
    assert log.read_text().splitlines() == [
        "alias set local http://minio:9000 task-user task-only secret",
        "alias set local http://minio:9000 task-user task-only secret",
        "mb --ignore-existing local/task-candidates",
        "version enable local/task-candidates",
        "anonymous set none local/task-candidates",
    ]
    failed = subprocess.run(
        argv, env={**environment, "FAIL_VERSION": "1"}, timeout=10, check=False
    )
    assert failed.returncode == 17
    assert log.read_text().splitlines()[-1] == "version enable local/task-candidates"
