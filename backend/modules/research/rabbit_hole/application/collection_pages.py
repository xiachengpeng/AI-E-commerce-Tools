"""Bounded, free local page observations admitted with a collection receipt."""
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, UUID, uuid5

from sqlalchemy import insert, select


async def schedule_collection_pages(connection, project, action, payload):
    # Called only inside WorkbenchRunner.save's fenced collection transaction.
    # Reusing the standard landing fingerprint/dedupe slot prevents duplication
    # with manual reads and verification dependencies, including after recovery.
    from rabbit_hole.application.actions import actions, target_signature
    from rabbit_hole.persistence.sql import transaction_lock

    if action['kind'] != 'scan' or payload.get('status') != 'complete':
        return
    ad_ids = {str(ad.get('id')) for ad in payload.get('ads', [])}
    keyword_id = payload.get('keyword_id')
    if keyword_id != action.get('keyword_id'):
        return
    await transaction_lock(connection, project['id'])
    rows = (await connection.execute(select(actions).where(
        actions.c.project_id == UUID(project['id']), actions.c.kind == 'landing',
    ))).mappings().all()
    now, admitted = datetime.now(UTC), 0
    for product in project.get('products', []):
        if (product.get('merged_into') or not product.get('url')
                or product.get('triage', {}).get('state', 'pending') not in {'pending', 'retained'}
                or product.get('landing_snapshot')
                or not any(s.get('keyword_id') == keyword_id and s.get('ad_id') in ad_ids
                           for s in product.get('candidate_sources', []))):
            continue
        data = {'product_id': product['id']}
        fingerprint = target_signature(project, 'landing', data)
        # Failed/uncertain reads need an explicit user retry. Never restart them
        # just because the same ad is collected again, or switch paid modes.
        if any(r['product_id'] == product['id'] and (
            r['status'] in {'ready', 'running'} or r['payload'].get('fingerprint') == fingerprint
        ) for r in rows):
            continue
        if admitted >= 20:
            break
        dedupe = f"{project['id']}:landing::{product['id']}:{fingerprint}"
        await connection.execute(insert(actions).values(
            id=uuid5(NAMESPACE_URL, dedupe), dedupe_key=dedupe,
            project_id=UUID(project['id']), product_id=product['id'], keyword_id=None,
            kind='landing', status='ready', input_version=project['version'],
            payload={'fingerprint': fingerprint, 'query': None, 'execution_mode': 'ui',
                     'landing_mode': 'local', 'collection_action_id': str(action['id'])},
            created_at=now, updated_at=now, attempt=0,
        ))
        admitted += 1
