"""Fenced legacy admission usage; contains no prompts, provider clients or retries."""
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select

from rabbit_hole.persistence.database import job_checkpoints
from rabbit_hole.persistence.sql import dialect_insert, ownership_guard

STAGE = 'main_ai_usage'
UNKNOWN = {'reserved', 'submitted', 'retrying', 'received', 'uncertain', 'cancelled'}
STATUSES = UNKNOWN | {'succeeded', 'failed'}


class LegacyAIError(ValueError):
    """A fenced legacy AI reservation requires explicit human resolution."""


async def _lease(jobs, connection, job):
    await ownership_guard(connection, kind='jobs', identifier=job.id)
    current = await jobs._require_current_lease(connection, job.id, job.leased_by, job.lease_token, jobs._clock.now())
    if current.attempt != job.attempt or current.payload != job.payload:
        raise LegacyAIError('legacy AI lease input changed')
    return current


async def _calls(connection, job):
    value = await connection.scalar(select(job_checkpoints.c.data).where(
        job_checkpoints.c.job_id == job.id, job_checkpoints.c.stage == STAGE))
    if value is None:
        return []
    if not isinstance(value, dict) or set(value) != {'calls'} or not isinstance(value['calls'], list):
        raise LegacyAIError('legacy AI usage invalid')
    calls = value['calls']
    fields = {'id', 'attempt', 'operation', 'status'}
    if len(calls) > 60 or any(not isinstance(item, dict) or set(item) != fields
        or type(item['attempt']) is not int or item['attempt'] < 0
        or item['status'] not in STATUSES or item['operation'] not in {'extract', 'keywords', 'expand', 'verify', 'direction'}
        for item in calls):
        raise LegacyAIError('legacy AI usage invalid')
    return [dict(item) for item in calls]


async def _save(connection, job, calls):
    statement = dialect_insert(connection, job_checkpoints).values(
        job_id=job.id, stage=STAGE, data={'calls': calls}, created_at=datetime.now(UTC))
    await connection.execute(statement.on_conflict_do_update(
        index_elements=[job_checkpoints.c.job_id, job_checkpoints.c.stage],
        set_={'data': statement.excluded.data}))


async def reserve_legacy_ai(jobs, job, operation):
    if operation not in {'extract', 'keywords', 'expand', 'verify', 'direction'}:
        raise LegacyAIError('legacy AI operation invalid')
    async with jobs._transaction() as connection:
        current = await _lease(jobs, connection, job)
        calls = await _calls(connection, job)
        if any(item.get('status') in UNKNOWN for item in calls):
            raise LegacyAIError('legacy AI submission unknown; manual reconciliation required')
        # Original enqueue admission has already charged the daily quota. Never
        # mint a native action or reserve that same admission a second time.
        if len(calls) >= min(current.payload.estimated_ai_calls, 60):
            raise LegacyAIError('legacy AI admitted budget exhausted')
        rid = str(uuid4())
        calls.append({'id': rid, 'attempt': job.attempt, 'operation': operation, 'status': 'reserved'})
        await _save(connection, job, calls)
        return rid


async def record_legacy_ai(jobs, job, reservation_id, status):
    if status not in STATUSES:
        raise LegacyAIError('legacy AI status invalid')
    async with jobs._transaction() as connection:
        await _lease(jobs, connection, job)
        calls = await _calls(connection, job)
        entry = next((item for item in calls if item.get('id') == reservation_id), None)
        if entry is None or entry.get('attempt') != job.attempt:
            raise LegacyAIError('legacy AI reservation mismatch')
        if entry['status'] == status:
            return
        if entry['status'] in {'uncertain', 'cancelled', 'succeeded', 'failed'}:
            raise LegacyAIError('legacy AI submission unknown; manual reconciliation required')
        entry['status'] = status
        await _save(connection, job, calls)
