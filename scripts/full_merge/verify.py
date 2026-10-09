"""Verify private recovery sets without returning business records or credentials."""
import hashlib
import json
from pathlib import Path
from scripts.full_merge.backup import database_stats


def verify_snapshot(directory: Path) -> dict:
    directory = Path(directory).resolve()
    manifest = json.loads((directory / 'manifest.json').read_text())
    result = {'verified': True, 'databases': 0, 'tables': 0, 'objects': 0, 'keys': 0, 'failures': []}
    for category in ('databases', 'objects', 'keys'):
        for index, entry in enumerate(manifest.get(category, [])):
            path = (directory / entry['path']).resolve()
            valid = path.is_relative_to(directory) and path.is_file()
            if valid:
                if category == 'databases':
                    stats = database_stats(path)
                    valid = stats == entry['stats'] and stats['integrity_ok'] and stats['foreign_key_errors'] == 0
                    result['tables'] += len(stats['tables'])
                else:
                    valid = hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256'] and path.stat().st_size == entry['bytes']
            result[category] += 1
            if not valid:
                result['verified'] = False
                result['failures'].append({'category': category, 'index': index})
    return result
