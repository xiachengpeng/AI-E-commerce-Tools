"""Isolated manual browser acceptance server. No production data or sources."""

import asyncio
import os
from uuid import uuid4

import uvicorn
from alembic.config import Config
from sqlalchemy.ext.asyncio import create_async_engine
from testcontainers.postgres import PostgresContainer

from alembic import command
from rabbit_hole.runtime.server import create_app
from rabbit_hole.persistence.projects import WorkbenchStore


def main() -> None:
    with PostgresContainer("postgres:16-alpine") as postgres:
        url = postgres.get_connection_url().replace(
            "postgresql+psycopg2", "postgresql+psycopg"
        )
        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", url)
        command.upgrade(config, "head")
        engine = create_async_engine(url)
        store = WorkbenchStore(engine)

        async def seed() -> None:
            await store.create(
                "隔离验收 · 不是真实经营数据",
                "测试配置与流程，不访问外部采集源",
                "US",
                str(uuid4()),
            )
            await engine.dispose()

        asyncio.run(seed())
        app = create_app(checks={})
        app.state.workbench_store = store
        uvicorn.run(
            app,
            host="127.0.0.1",
            port=int(os.environ.get("WORKBENCH_PREVIEW_PORT", "8012")),
        )


if __name__ == "__main__":
    main()
