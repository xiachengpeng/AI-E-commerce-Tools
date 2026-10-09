"""Fail-closed private recovery verification, without business records or credentials."""
import hashlib
import json
import sqlite3
from pathlib import Path
from scripts.full_merge.backup import database_stats


def verify_snapshot(directory: Path) -> dict:
    directory = Path(directory).resolve()
    result = {'verified': False, 'databases': 0, 'tables': 0, 'objects': 0, 'keys': 0, 'failures': []}
    try:
        manifest = json.loads((directory / 'manifest.json').read_text())
        if not isinstance(manifest, dict) or manifest.get('version') != 1:
            raise ValueError('manifest version')
        categories = ('databases', 'objects', 'keys')
        if any(not isinstance(manifest.get(category), list) for category in categories) or not any(manifest[category] for category in categories):
            raise ValueError('manifest categories')
    except (OSError, ValueError, TypeError):
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
    return result
