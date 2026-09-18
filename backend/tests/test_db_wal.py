"""Tests for SQLite WAL mode and PRAGMA settings."""

import sqlite3
from sqlalchemy import create_engine, text
from db import enable_sqlite_foreign_keys


def test_sqlite_wal_and_pragma_settings(tmp_path):
    db_file = tmp_path / "test_wal.db"
    test_engine = create_engine(f"sqlite:///{db_file}")
    enable_sqlite_foreign_keys(test_engine)

    with test_engine.connect() as conn:
        journal_mode = conn.execute(text("PRAGMA journal_mode;")).scalar()
        busy_timeout = conn.execute(text("PRAGMA busy_timeout;")).scalar()
        sync_mode = conn.execute(text("PRAGMA synchronous;")).scalar()
        foreign_keys = conn.execute(text("PRAGMA foreign_keys;")).scalar()

    assert str(journal_mode).lower() == "wal"
    assert busy_timeout == 5000
    assert sync_mode == 1  # 1 corresponds to NORMAL in SQLite
    assert foreign_keys == 1
