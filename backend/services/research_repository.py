"""Separate additive SQLite schema. Never changes legacy tables or auto-migrates."""
import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from uuid import uuid4

SCHEMA_REVISION = 1


class RepositoryError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def migrate(path):
    """Explicit deployment operation, after backup. Idempotent; no DROP/ALTER."""
    with sqlite3.connect(path, timeout=5) as connection:
        connection.execute('BEGIN IMMEDIATE')
        connection.execute('CREATE TABLE IF NOT EXISTS research_schema (revision INTEGER PRIMARY KEY)')
        revisions = [r[0] for r in connection.execute('SELECT revision FROM research_schema')]
        if revisions and revisions != [SCHEMA_REVISION]:
            raise RepositoryError(503, '研究关联数据库版本不兼容')
        connection.execute('CREATE TABLE IF NOT EXISTS research_links (id TEXT PRIMARY KEY, name TEXT NOT NULL, source_ref TEXT NOT NULL, market TEXT NOT NULL, revision INTEGER NOT NULL, artifacts TEXT NOT NULL)')
        connection.execute('CREATE TABLE IF NOT EXISTS research_import_events (id TEXT PRIMARY KEY, digest TEXT NOT NULL, link_id TEXT NOT NULL REFERENCES research_links(id), snapshot TEXT NOT NULL, created_at TEXT NOT NULL)')
        connection.execute('INSERT OR IGNORE INTO research_schema VALUES (?)', (SCHEMA_REVISION,))


class ResearchRepository:
    def __init__(self, path):
        self.path = str(path)

    @contextmanager
    def connection(self, write=False):
        # URI mode=rw forbids silently creating a missing database.
        from pathlib import Path
        try:
            connection = sqlite3.connect(Path(self.path).resolve().as_uri() + '?mode=rw', uri=True, timeout=5)
        except sqlite3.Error:
            raise RepositoryError(503, '研究档案存储尚未就绪') from None
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        try:
            revisions = connection.execute('SELECT revision FROM research_schema').fetchall()
            if len(revisions) != 1 or revisions[0][0] != SCHEMA_REVISION:
                raise RepositoryError(503, '研究关联数据库版本不兼容')
            if write:
                connection.execute('BEGIN IMMEDIATE')
            yield connection
            if write:
                connection.commit()
        except sqlite3.Error:
            connection.rollback()
            raise RepositoryError(503, '研究档案存储尚未就绪或忙碌；请稍后核对状态') from None
        finally:
            connection.close()

    def lookup(self, import_id, request_digest=None):
        with self.connection() as connection:
            row = connection.execute('SELECT * FROM research_import_events WHERE id=?', (str(import_id),)).fetchone()
            if not row:
                return None
            if request_digest and row['digest'] != request_digest:
                raise RepositoryError(409, '导入编号已用于其他内容，请核对已有记录')
            return self.event(row)

    @staticmethod
    def event(row):
        return {'import_id': row['id'], 'link_id': row['link_id'], 'created_at': row['created_at'],
                'snapshot': json.loads(row['snapshot'])}

    def save(self, import_id, request_digest, name, snapshot):
        with self.connection(write=True) as connection:
            row = connection.execute('SELECT * FROM research_import_events WHERE id=?', (str(import_id),)).fetchone()
            if row:
                if row['digest'] != request_digest:
                    raise RepositoryError(409, '导入编号已用于其他内容')
                return self.event(row)
            link_id = str(uuid4())
            connection.execute('INSERT INTO research_links VALUES (?,?,?,?,?,?)',
                               (link_id, name, canonical(snapshot['source_ref']), snapshot['market'], 1, '[]'))
            connection.execute('INSERT INTO research_import_events VALUES (?,?,?,?,?)',
                               (str(import_id), request_digest, link_id, canonical(snapshot), datetime.now(timezone.utc).isoformat()))
            row = connection.execute('SELECT * FROM research_import_events WHERE id=?', (str(import_id),)).fetchone()
            return self.event(row)

    def list(self, limit=20, cursor=None):
        with self.connection() as connection:
            rows = connection.execute('SELECT e.*,l.name,l.revision,l.artifacts FROM research_import_events e JOIN research_links l ON e.link_id=l.id WHERE (? IS NULL OR e.id>?) ORDER BY e.id LIMIT ?', (cursor, cursor, limit + 1)).fetchall()
            return {'imports': [{**self.event(r), 'name': r['name'], 'revision': r['revision'],
                                 'artifacts': json.loads(r['artifacts'])} for r in rows[:limit]],
                    'next_cursor': rows[limit-1]['id'] if len(rows) > limit else None}

    def attach(self, import_id, expected_revision, module, history_id, expected_history_timestamp=None):
        from db import AnalysisHistory, ListingHistory, AdsHistory, RenderHistory
        tables = {'analysis': AnalysisHistory.__tablename__, 'listing': ListingHistory.__tablename__,
                  'ads': AdsHistory.__tablename__, 'details': RenderHistory.__tablename__}
        if module not in tables:
            raise RepositoryError(422, '不支持的营销成果类型')
        with self.connection(write=True) as connection:
            row = connection.execute('SELECT l.* FROM research_links l JOIN research_import_events e ON e.link_id=l.id WHERE e.id=?', (str(import_id),)).fetchone()
            if not row:
                raise RepositoryError(404, '营销档案不存在')
            history = connection.execute(f'SELECT id,timestamp FROM {tables[module]} WHERE id=?', (history_id,)).fetchone()
            if not history:
                raise RepositoryError(404, '营销历史记录不存在')
            created_at = datetime.fromisoformat(history['timestamp']).isoformat() if history['timestamp'] else None
            if created_at != expected_history_timestamp:
                raise RepositoryError(409, '营销历史已变化，请重新读取并选择成果')
            artifacts = json.loads(row['artifacts'])
            ref = {'module': module, 'history_id': history_id, 'created_at': created_at}
            if ref in artifacts:
                return {'revision': row['revision'], 'artifacts': artifacts}
            if row['revision'] != expected_revision:
                raise RepositoryError(409, '档案关联已更新，请刷新后重试')
            if len(artifacts) >= 100:
                raise RepositoryError(422, '此档案成果关联已达上限')
            artifacts.append(ref)
            revision = row['revision'] + 1
            connection.execute('UPDATE research_links SET artifacts=?,revision=? WHERE id=?', (canonical(artifacts), revision, row['id']))
            return {'revision': revision, 'artifacts': artifacts}
