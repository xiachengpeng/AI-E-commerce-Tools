# Inactive research source

Copied from approved research commit `b749491c29fce8ac5bdad613f1ef569cb6df186b`.
Source archive SHA256: `45f2311698da4d9fa6a2c0f59829bb362a4ca3ea2d448204396f6fc1cef269eb`.

`rabbit_hole/` retains all 79 Python files and its seed JSON byte for byte.
`backend/tests/research/` retains all 116 original test/fixture files; four Trends
JSON fixtures have trailing blank lines normalized, with identical JSON data.
`compat/` retains Alembic, the compatibility CLI, reviewed automation data,
source frontend and icon attribution, container metadata used as test fixtures,
and the operations runbook read by source tests. The approved snapshot has no
project-root LICENSE; `compat/frontend/ui-icons/LICENSE` is preserved verbatim.
The document screenshot and unrelated operational reports are not fixtures and
are omitted. This package is not mounted or enabled in the main application.

Install the unified environment from `backend/requirements-full-merge.lock`.
The lock preserves the existing main runtime and pytest/pytest-asyncio versions;
the old optional test bounds in the original compatibility `pyproject.toml`
remain historical metadata and are not the installation entry point.

Use `scripts/full_merge/run_tests.py --suite main|research|all --output <private-temp>`
with the worktree Python. Install pinned compat frontend packages first, and set
`PLAYWRIGHT_BROWSERS_PATH` to the worktree-only Chromium cache. Research frontend
assets are rebuilt from audited source into each temporary sandbox. Main and
research collectors, homes, SQLite databases and environment variables remain
separate. Real provider keys, live databases, .env variants and production static
assets are excluded. Network calls use fixtures or loopback servers; arbitrary
shell, SSH, paid SDK and upload/publish subprocesses are not enabled.

The ten original frontend assertions are retained and mapped to Tasks 12–15 in
`docs/merge-assessment/full-merge-coverage.json`; retention does not claim native
UI behavior parity or external-service acceptance.
