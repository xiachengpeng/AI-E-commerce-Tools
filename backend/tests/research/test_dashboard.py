from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import delete, insert

from rabbit_hole.runtime.server import create_app


@pytest.fixture
async def dashboard_job(db_engine):
    from rabbit_hole.persistence.database import job_checkpoints, runtime_jobs

    job_id = uuid4()
    try:
        yield db_engine, job_id
    finally:
        async with db_engine.begin() as connection:
            await connection.execute(
                delete(job_checkpoints).where(job_checkpoints.c.job_id == job_id)
            )
            await connection.execute(
                delete(runtime_jobs).where(runtime_jobs.c.id == job_id)
            )


def test_dashboard_shell_and_unavailable_data_fail_closed():
    from fastapi.testclient import TestClient

    with TestClient(create_app(checks={})) as client:
        assert client.get("/").status_code == 200
        response = client.get("/dashboard/data")
        assert response.status_code == 503
        assert response.json() == {"status": "unavailable"}


@pytest.mark.asyncio
async def test_dashboard_reports_checkpoints_without_payload_or_secret(dashboard_job):
    from rabbit_hole.dashboard import read_dashboard
    from rabbit_hole.persistence.database import job_checkpoints, runtime_jobs

    db_engine, job_id = dashboard_job
    now = datetime.now(UTC)
    async with db_engine.begin() as connection:
        await connection.execute(
            insert(runtime_jobs).values(
                id=job_id,
                idempotency_key=str(job_id),
                kind="keyword_scan",
                status="succeeded",
                payload={
                    "data": {
                        "AUTO｜实际搜索词": "<script>alert(1)</script>",
                        "secret": "password-secret",
                    }
                },
                attempt=0,
                available_at=now,
                created_at=now,
                updated_at=now,
                failure_detail="password-secret",
            )
        )
        await connection.execute(
            insert(job_checkpoints),
            [
                {
                    "job_id": job_id,
                    "stage": "meta",
                    "data": {"status": "complete", "value": {"ads": [{}, {}]}},
                    "created_at": now,
                },
                {
                    "job_id": job_id,
                    "stage": "trends",
                    "data": {"status": "skipped"},
                    "created_at": now,
                },
                {
                    "job_id": job_id,
                    "stage": "writeback",
                    "data": {"status": "complete", "result": {"status": "已启用"}},
                    "created_at": now,
                },
            ],
        )

    async def reader():
        return await read_dashboard(db_engine)

    app = create_app(checks={}, dashboard_reader=reader)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test"
    ) as client:
        response = await client.get("/dashboard/data")
    assert response.status_code == 200
    assert "password-secret" not in response.text
    job = next(item for item in response.json()["jobs"] if item["id"] == str(job_id))
    assert job["ads"] == 2
    assert job["result"] == "已启用"
    assert next(x for x in job["stages"] if x["key"] == "trends")["state"] == "skipped"
    assert next(x for x in job["stages"] if x["key"] == "landing")["state"] == "unknown"
    assert response.headers["cache-control"] == "no-store"
