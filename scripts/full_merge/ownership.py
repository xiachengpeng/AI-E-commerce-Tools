"""Explicit backup-gated ownership preparation and operator-signed handoff issuance."""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from pathlib import Path
from types import SimpleNamespace


def prepare_ownership(paths, *, snapshot_id, dataset_id, owner_generation, backup_verified):
    from services.research_runtime import _validate_path
    if backup_verified is not True or not dataset_id or type(owner_generation) is not int or owner_generation < 1:
        raise ValueError('verified backup and explicit ownership identity required')
    _validate_path(paths.database)
    with sqlite3.connect(f'file:{paths.database}?mode=rw', uri=True) as c:
        c.execute('BEGIN IMMEDIATE')
        if c.execute('SELECT revision FROM full_merge_schema WHERE id=1').fetchone() != (4,):
            raise ValueError('prepared revision 4 required')
        row = c.execute('SELECT cutover_state FROM full_merge_ledger WHERE source_snapshot_id=?', (snapshot_id,)).fetchone()
        if row != ('imported',):
            raise ValueError('imported snapshot required')
        columns = {r[1] for r in c.execute('PRAGMA table_info(full_merge_ledger)')}
        extension = {'dataset_id', 'owner_generation', 'activation_digest'}
        if columns & extension and not extension <= columns:
            raise ValueError('partial ownership schema')
        if not extension <= columns:
            raise ValueError('explicit ownership schema preparation required')
        old = c.execute('SELECT dataset_id,owner_generation FROM full_merge_ledger WHERE source_snapshot_id=?', (snapshot_id,)).fetchone()
        if old != (None, None) and old != (dataset_id, owner_generation):
            raise ValueError('ownership already assigned')
        c.execute('UPDATE full_merge_ledger SET dataset_id=?,owner_generation=? WHERE source_snapshot_id=?', (dataset_id, owner_generation, snapshot_id))
    # Candidate must be closed/checkpointed before its initial hash is recorded.
    with sqlite3.connect(paths.database) as c:
        c.execute('PRAGMA wal_checkpoint(TRUNCATE)')


def issue_activation(report: dict, *, source_frozen: bool) -> dict:
    from services.research_activation import canonical, read_key
    from services.research_runtime import _validate_path
    if source_frozen is not True or report.get('source_owner_stopped') is not True or report.get('source_writers_frozen') is not True:
        raise ValueError('verified source freeze required')
    if (type(report.get('unresolved_nonidempotent')) is not int or report['unresolved_nonidempotent'] < 0
            or report['unresolved_nonidempotent'] != len(report.get('quarantine', []))):
        raise ValueError('unresolved nonidempotent outcomes')
    now = time.time()
    if not (0 < report['source_frozen_at'] <= report['snapshot_created_at'] <= now < report['expires_at'] <= now + 86400):
        raise ValueError('stale snapshot or freeze')
    root = Path(report['keys_root'])
    _validate_path(root, private=True)
    if not root.is_dir():
        raise ValueError('prepared key root required')
    path = root / 'activation.key'
    _validate_path(path, private=True)
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(secrets.token_bytes(32))
            stream.flush()
            os.fsync(stream.fileno())
    resolutions = []
    previous_path = root / 'activation.json'
    if previous_path.exists():
        import json
        from services.research_activation import load_activation
        previous = load_activation(SimpleNamespace(keys_root=root))
        key = read_key(SimpleNamespace(keys_root=root))
        if not hmac.compare_digest(previous.get('signature', ''), hmac.new(key, canonical(previous), hashlib.sha256).hexdigest()):
            raise ValueError('previous activation invalid')
        next_entries = {(item['kind'], item['id']): item for item in report.get('quarantine', [])}
        for prior in previous.get('quarantine', []):
            identity = (prior['kind'], prior['id'])
            if identity in next_entries and next_entries[identity] != prior:
                raise ValueError('resolution required before changing quarantined identity')
        retained = set(next_entries)
        removed = [item for item in previous.get('quarantine', []) if (item['kind'], item['id']) not in retained]
        if removed:
            if report['owner_generation'] <= previous['owner_generation'] or report['dataset_id'] != previous['dataset_id']:
                raise ValueError('resolution requires a new owner generation')
            for proof_path in report.get('resolution_files', []):
                proof_path = Path(proof_path)
                _validate_path(proof_path, private=True)
                with os.fdopen(os.open(proof_path, os.O_RDONLY | os.O_NOFOLLOW), 'r') as stream:
                    raw = stream.read(65537)
                if len(raw) > 65536:
                    raise ValueError('resolution proof too large')
                proof = json.loads(raw)
                identity = {field: proof.get(field) for field in ('kind', 'id', 'attempt', 'payload_sha256')}
                if identity not in removed or proof.get('verified') is not True or proof.get('outcome') not in {'succeeded', 'aborted', 'not_submitted'}:
                    raise ValueError('resolution proof invalid')
                evidence = Path(proof['evidence_file'])
                _validate_path(evidence, private=True)
                with os.fdopen(os.open(evidence, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
                    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                if digest != proof.get('evidence_sha256'):
                    raise ValueError('resolution evidence hash mismatch')
                resolutions.append({**identity, 'outcome':proof['outcome'], 'proof_sha256':hashlib.sha256(raw.encode()).hexdigest(), 'evidence_sha256':digest})
            if {(item['kind'], item['id']) for item in resolutions} != {(item['kind'], item['id']) for item in removed}:
                raise ValueError('resolution proof required for every removed resource')
    result = {k: v for k, v in report.items() if k not in {'keys_root', 'signature', 'resolution_files'}}
    if resolutions:
        result['resolutions'] = resolutions

    result.update(source_frozen=True, issued_at=now)
    key = read_key(SimpleNamespace(keys_root=root))
    result['signature'] = hmac.new(key, canonical(result), hashlib.sha256).hexdigest()
    return result
