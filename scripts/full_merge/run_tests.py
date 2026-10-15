"""Run complete suites in separate source-only sandboxes, never live local state."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Literal

ROOT = Path(__file__).resolve().parents[2]
COMPAT = Path("backend/modules/research/compat")


def copy_source(source: Path, destination: Path) -> None:
    if source.is_symlink():
        raise ValueError(f"Symlink is not source: {source.name}")
    if source.is_dir():
        destination.mkdir(parents=True, exist_ok=True)
        for child in source.iterdir():
            if (
                child.name.startswith((".env", ".venv"))
                or child.name
                in {"node_modules", "dist", "__pycache__", ".pytest_cache", "static"}
                or child.name.endswith(
                    (
                        ".db",
                        ".sqlite",
                        ".sqlite3",
                        ".pyc",
                        ".db-wal",
                        ".db-shm",
                        ".db-journal",
                        ".sqlite-wal",
                        ".sqlite-shm",
                        ".sqlite-journal",
                        ".sqlite3-wal",
                        ".sqlite3-shm",
                        ".sqlite3-journal",
                    )
                )
            ):
                continue
            copy_source(child, destination / child.name)
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def prepare_sandbox(suite: Literal["main", "research"], output: Path) -> Path:
    if suite not in ("main", "research"):
        raise ValueError("suite must be main or research")
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    sandbox = output / "source"
    if sandbox.exists():
        raise FileExistsError("Use a new private output directory per run")
    sandbox.mkdir()
    if suite == "main":
        for relative in (
            "backend",
            "frontend",
            "scripts/full_merge",
            "docs/merge-assessment",
            "run.py",
            "pytest.ini",
        ):
            copy_source(ROOT / relative, sandbox / relative)
        if (ROOT / "_research_tests").exists():
            if (sandbox / "backend/tests/research").exists():
                shutil.rmtree(sandbox / "backend/tests/research")
            copy_source(ROOT / "_research_tests", sandbox / "_research_tests")
        else:
            shutil.move(sandbox / "backend/tests/research", sandbox / "_research_tests")
        # Source-only fixture imports retain their original tests.research name,
        # without exposing the research conftest to main collection.
        fixture_package = sandbox / "backend/tests/research"
        fixture_package.mkdir()
        (fixture_package / "__init__.py").write_text(
            "from pathlib import Path\n"
            "__path__ = [str(Path(__file__).resolve().parents[3] / '_research_tests')]\n"
        )
    else:
        copy_source(
            ROOT
            / (
                "_research_tests"
                if (ROOT / "_research_tests").exists()
                else "backend/tests/research"
            ),
            sandbox / "tests",
        )
        copy_source(ROOT / COMPAT, sandbox)
        copy_source(
            ROOT / "backend/modules/research/rabbit_hole", sandbox / "src/rabbit_hole"
        )
        # Source tests now exercise the unified adapters/usage schema. Copy only
        # explicit source modules; never import the live checkout or its state.
        for relative in ("models", "services", "migrations", "db.py", "config.py"):
            copy_source(ROOT / "backend" / relative, sandbox / "main" / relative)
    guards = sandbox / "_isolation"
    guards.mkdir()
    for name in ("sitecustomize.py", "node_guard.cjs"):
        shutil.copy2(ROOT / "scripts/full_merge" / name, guards / name)
    return sandbox


def sandbox_environment(sandbox: Path, suite: str) -> dict[str, str]:
    # Allowlist inherited process settings. No provider credentials, DB endpoints,
    # proxies, real HOME/config files, or application .env are inherited.
    env = {
        key: value
        for key, value in os.environ.items()
        if key
        in {"PATH", "SYSTEMROOT", "LANG", "LC_ALL", "TERM", "PLAYWRIGHT_BROWSERS_PATH"}
    }
    home = sandbox / "_home"
    home.mkdir(exist_ok=True)
    env.update(
        FULL_MERGE_SUITE=suite,
        HOME=str(home),
        TMPDIR=str(home),
        FULL_MERGE_SANDBOX=str(sandbox),
        PYTHONPATH=os.pathsep.join(
            [
                str(sandbox / "_isolation"),
                str(sandbox / ("src" if suite == "research" else "backend")),
                str(sandbox / "main"),
                str(sandbox),
            ]
        ),
        NODE_OPTIONS="--require="
        + json.dumps(str(sandbox / "_isolation/node_guard.cjs"), ensure_ascii=False),
        PYTEST_DISABLE_PLUGIN_AUTOLOAD="1",
        SQLITE_DB_PATH=str(home / "main-test.db"),
        FIRECRAWL_API_KEY="synthetic-isolation-fixture-key",
        RABBIT_HOLE_TEST_SQLITE="1",
        RABBIT_HOLE_TEST_FILES="1",
        RABBIT_HOLE_SKIP_POSTGRES_TESTS="1",
        AWS_EC2_METADATA_DISABLED="true",
        RABBIT_HOLE_DATABASE_URL="sqlite+aiosqlite:///"
        + str(home / "research-test.db"),
    )
    return env


def build_research_frontend(sandbox: Path, env: dict[str, str]) -> dict[str, int]:
    cli = ROOT / COMPAT / "frontend/node_modules/@tailwindcss/cli/dist/index.mjs"
    if not cli.is_file():
        raise RuntimeError(
            "Install pinned compat frontend dependencies before research tests"
        )
    frontend = sandbox / "frontend"
    tailwind = subprocess.run(
        [
            "node",
            str(cli),
            "-i",
            str(ROOT / COMPAT / "frontend/styles/ui.css"),
            "-o",
            "dist/tailwind.css",
            "--minify",
        ],
        cwd=frontend,
        env=env,
        check=False,
        stdout=subprocess.DEVNULL,
    )
    build = subprocess.run(
        ["node", "build.mjs"],
        cwd=frontend,
        env=env,
        check=False,
        stdout=subprocess.DEVNULL,
    )

    return {"tailwind": tailwind.returncode, "frontend_build": build.returncode}


def run_isolated_suite(suite: Literal["main", "research", "all"], output: Path) -> int:
    if suite not in ("main", "research", "all"):
        raise ValueError("Unknown suite")
    statuses = {}
    components = {}
    for current in ("main", "research") if suite == "all" else (suite,):
        sandbox = prepare_sandbox(current, output / current)
        env = sandbox_environment(sandbox, current)
        components[current] = {}
        if current == "research":
            components[current].update(build_research_frontend(sandbox, env) or {})
        command = [
            sys.executable,
            "-m",
            "pytest",
            "-p",
            "pytest_asyncio.plugin",
            "--import-mode=prepend",
            "--junitxml=" + str((output / current / "pytest.xml").resolve()),
        ]
        if current == "main":
            command.extend(["-c", "pytest.ini", "backend/tests", "--ignore=backend/tests/research", "-q"])
        else:
            command.extend(["-c", "pyproject.toml", "tests", "-q"])
        with (output / current / "pytest.log").open("w") as log:
            result = subprocess.run(
                command,
                cwd=sandbox,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
            )
        test_files = sorted((sandbox / "frontend/tests").glob("*.test.*"))
        if current == "main":
            test_files += sorted((sandbox / "frontend/tests/research-workbench").glob("*.test.mjs"))
        with (output / current / "frontend.log").open("w") as log:
            frontend = subprocess.run(
                ["node", "--test", "--test-isolation=none", "--test-reporter=tap", *map(str, test_files)],
                cwd=sandbox,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
            )
        components[current].update(
            pytest=result.returncode, frontend=frontend.returncode
        )
        statuses[current] = int(any(code != 0 for code in components[current].values()))
        if current == "research":
            tools = [
                (
                    "ruff",
                    [
                        "check",
                        "src",
                        "--no-respect-gitignore",
                        "--config",
                        "pyproject.toml",
                    ],
                ),
                ("mypy", ["-p", "rabbit_hole", "--config-file", "pyproject.toml"]),
            ]
            env["MYPYPATH"] = os.pathsep.join([str(sandbox / "src"), str(sandbox / "main")])
            for tool, arguments in tools:
                with (output / current / f"{tool}.log").open("w") as log:
                    checked = subprocess.run(
                        [str(Path(sys.executable).parent / tool), *arguments],
                        cwd=sandbox,
                        env=env,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        check=False,
                    )
                components[current][tool] = checked.returncode
                statuses[current] = int(
                    any(code != 0 for code in components[current].values())
                )
        (output / "component-results.json").write_text(json.dumps(components, indent=2) + "\n")
        (output / "result.json").write_text(json.dumps(statuses, indent=2) + "\n")
        print(
            f"{current}: exit {statuses[current]}; {output / current / 'pytest.log'}",
            flush=True,
        )
    (output / "component-results.json").write_text(
        json.dumps(components, indent=2) + "\n"
    )
    (output / "result.json").write_text(json.dumps(statuses, indent=2) + "\n")
    return max(statuses.values())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", required=True, choices=["main", "research", "all"])
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    raise SystemExit(run_isolated_suite(args.suite, args.output))
