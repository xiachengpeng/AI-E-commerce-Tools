"""Fail-closed private recovery verification, without business records or credentials."""
import hashlib
import json
import sqlite3
from pathlib import Path
from scripts.full_merge.backup import database_stats


def verify_snapshot(directory: Path, *, expected_digest: str | None = None) -> dict:
    directory = Path(directory).resolve()
    result = {'verified': False, 'integrity_verified': False, 'completeness_verified': False, 'databases': 0, 'tables': 0, 'objects': 0, 'keys': 0, 'failures': []}
    try:
        manifest_bytes = (directory / 'manifest.json').read_bytes()
        manifest = json.loads(manifest_bytes)
        if expected_digest is not None and hashlib.sha256(manifest_bytes).hexdigest() != expected_digest:
            raise ValueError('external manifest anchor mismatch')
        if not isinstance(manifest, dict) or manifest.get('version') != 1:
            raise ValueError('manifest version')
        categories = ('databases', 'objects', 'keys')
        if any(not isinstance(manifest.get(category), list) for category in categories) or not any(manifest[category] for category in categories):
            raise ValueError('manifest categories')
        roster = manifest.get('requested_sources')
        counts = manifest.get('expected_counts')
        if not isinstance(roster, list) or not roster or not isinstance(counts, dict):
            raise ValueError('missing source roster')
        seen_sources = set()
        for source in roster:
            category, index = source['category'], source['index']
            if category not in categories or type(index) is not int or index < 0 or (category, index) in seen_sources or type(source['files']) is not int or source['files'] < 0 or not isinstance(source['source_id'], str) or len(source['source_id']) != 64:
                raise ValueError('invalid source roster')
            seen_sources.add((category, index))
            matching = [e for e in manifest[category] if isinstance(e, dict) and e.get('path', '').startswith(f'{category}/{index}/')] if category != 'databases' else [e for e in manifest[category] if isinstance(e, dict) and e.get('path') == f'databases/{index}.db']
            if len(matching) != source['files']:
                raise ValueError('source file count mismatch')
        for category in categories:
            if type(counts.get(category)) is not int or counts[category] != len(manifest[category]) or sum(s['files'] for s in roster if s['category'] == category) != counts[category]:
                raise ValueError('category count mismatch')
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        result['failures'].append({'category': 'manifest', 'reason': 'invalid_manifest'})
        return result
    result['verified'] = True
    seen = set()
    for category in categories:
        for index, entry in enumerate(manifest[category]):
            valid = False
            try:
                if not isinstance(entry, dict) or not isinstance(entry.get('path'), str):
                    raise ValueError('invalid entry')
                raw_path = Path(entry['path'])
                path = (directory / raw_path).resolve()
                if raw_path.is_absolute() or not path.is_relative_to(directory) or not path.is_file() or path in seen:
                    raise ValueError('invalid path')
                seen.add(path)
                if category == 'databases':
                    stats = database_stats(path)
                    valid = entry.get('verified') is True and stats == entry.get('stats') and stats['integrity_ok'] and stats['foreign_key_errors'] == 0
                    result['tables'] += len(stats['tables'])
                else:
                    valid = hashlib.sha256(path.read_bytes()).hexdigest() == entry.get('sha256') and path.stat().st_size == entry.get('bytes')
            except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
                valid = False
            result[category] += 1
            if not valid:
                result['verified'] = False
                result['failures'].append({'category': category, 'index': index})
    result['integrity_verified'] = result['verified']
    result['completeness_verified'] = result['verified'] and expected_digest is not None
    return result
