"""Static, non-executing inventory. Never imports application modules."""
import ast
import hashlib
import json
from pathlib import Path

EXCLUDED = {'.git', '.venv', 'node_modules', 'dist', 'debug', '.codex-run-logs', '.worktrees', '__pycache__', '.superpowers'}
SOURCE_SUFFIXES = {'.py', '.js', '.html', '.css', '.toml', '.sql'}


def inventory(root: Path) -> dict:
    root = Path(root)
    if not root.is_dir():
        raise FileNotFoundError(root)
    result = dict(source_hashes={}, routes=[], user_actions=[], job_kinds=[], pages=[], schema=[], dependencies=[], unresolved=[])
    actions, jobs = set(), set()
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root)
        if any(part in EXCLUDED for part in relative.parts) or path.is_symlink() or not path.is_file():
            continue
        name = relative.as_posix()
        if path.name in {'requirements.txt', 'package.json', 'package-lock.json', 'pyproject.toml', 'uv.lock'}:
            result['dependencies'].append({'file': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        if path.suffix not in SOURCE_SUFFIXES:
            continue
        result['source_hashes'][name] = hashlib.sha256(path.read_bytes()).hexdigest()
        if path.suffix == '.html':
            result['pages'].append(name)
        if path.suffix != '.py':
            continue
        try:
            tree = ast.parse(path.read_text(encoding='utf-8'))
        except (SyntaxError, UnicodeError):
            result['unresolved'].append({'file': name, 'reason': 'parse_error'})
            continue
        prefixes = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        if isinstance(node.value.func, ast.Name) and node.value.func.id in {'APIRouter', 'FastAPI'}:
                            prefixes[target.id] = next((k.value.value for k in node.value.keywords if k.arg == 'prefix' and isinstance(k.value, ast.Constant) and isinstance(k.value.value, str)), '')
                            if any(k.arg == 'prefix' and not (isinstance(k.value, ast.Constant) and isinstance(k.value.value, str)) for k in node.value.keywords):
                                result['unresolved'].append({'file': name, 'line': node.lineno, 'reason': 'dynamic_prefix'})
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    if isinstance(target, ast.Name) and target.id == 'USER_ACTIONS':
                        value = node.value
                        if isinstance(value, ast.Call) and value.args and isinstance(value.func, ast.Name) and value.func.id in {'frozenset', 'set', 'tuple'}:
                            value = value.args[0]
                        if not isinstance(value, (ast.Dict, ast.Set, ast.List, ast.Tuple)):
                            result['unresolved'].append({'file': name, 'line': node.lineno, 'reason': 'dynamic_user_actions'})
                        elements = value.keys if isinstance(value, ast.Dict) else value.elts if isinstance(value, (ast.Set, ast.List, ast.Tuple)) else []
                        actions.update(k.value for k in elements if isinstance(k, ast.Constant) and isinstance(k.value, str))
                    if isinstance(target, (ast.Name, ast.Attribute)) and (target.id if isinstance(target, ast.Name) else target.attr) == 'job_kind' and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                        jobs.add(node.value.value)
            if isinstance(node, ast.keyword) and node.arg == 'job_kind' and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                jobs.add(node.value.value)
            if isinstance(node, ast.ClassDef):
                if node.name == 'JobKind':
                    for statement in node.body:
                        if isinstance(statement, (ast.Assign, ast.AnnAssign)) and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str):
                            jobs.add(statement.value.value)
                fields = []
                for statement in node.body:
                    if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
                        fields.append(statement.target.id)
                    elif isinstance(statement, ast.Assign) and isinstance(statement.value, ast.Call) and isinstance(statement.value.func, ast.Name) and statement.value.func.id in {'Column', 'mapped_column'}:
                        fields.extend(t.id for t in statement.targets if isinstance(t, ast.Name))
                if fields:
                    result['schema'].append({'file': name, 'class': node.name, 'fields': sorted(fields)})
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                    continue
                method = decorator.func.attr
                if method not in {'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'api_route', 'websocket'}:
                    continue
                argument = decorator.args[0] if decorator.args else next((k.value for k in decorator.keywords if k.arg == 'path'), None)
                if not isinstance(argument, ast.Constant) or not isinstance(argument.value, str):
                    result['unresolved'].append({'file': name, 'line': node.lineno, 'reason': 'dynamic_route'})
                    continue
                receiver = decorator.func.value.id if isinstance(decorator.func.value, ast.Name) else ''
                methods = [method.upper()]
                if method == 'api_route':
                    keyword = next((k.value for k in decorator.keywords if k.arg == 'methods'), None)
                    if keyword is None:
                        methods = ['GET']
                    elif isinstance(keyword, (ast.List, ast.Tuple)) and all(isinstance(v, ast.Constant) and isinstance(v.value, str) for v in keyword.elts):
                        methods = [v.value.upper() for v in keyword.elts]
                    else:
                        result['unresolved'].append({'file': name, 'line': node.lineno, 'reason': 'dynamic_methods'})
                        continue
                for verb in methods:
                    result['routes'].append({'method': verb, 'path': prefixes.get(receiver, '') + argument.value, 'file': name, 'handler': node.name})
    result['user_actions'], result['job_kinds'] = sorted(actions), sorted(jobs)
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    print(json.dumps(inventory(args.root), indent=2, ensure_ascii=False))


def validate_coverage(matrix: dict) -> dict:
    """Validate stored source identity coverage; business parity remains a separate gate."""
    expected = {}
    pointer = 'backend/tests/test_full_merge_inventory.py::test_full_merge_coverage_matrix'
    failures = []
    try:
        for source, data in matrix['inventories'].items():
            for route in data['routes']:
                key = f"{source}:route:{route['method']}:{route['path']}:{route['file']}:{route['handler']}"
                expected[key] = (source, 'route', route, 22 if source == 'main' else 7, route['path'] if source == 'main' else 'backend/research/' + route['file'].removeprefix('src/rabbit_hole/'))
            for kind, field, task, target in [('action', 'user_actions', 7, 'ResearchFacade.command'), ('job_kind', 'job_kinds', 5, 'research worker'), ('page', 'pages', 12, 'frontend research workspace'), ('table', 'tables', 18, None)]:
                for value in data[field]:
                    key = f'{source}:{kind}:{value}'
                    destination = 'backend/history.db:' + value if kind == 'table' else value if source == 'main' else target
                    expected[key] = (source, kind, {'name': value}, 22 if source == 'main' else task, destination)
        seen = set()
        for entry in matrix['coverage']:
            key = entry['id']
            if key in seen or key not in expected:
                failures.append('duplicate_or_extra_identity')
                continue
            seen.add(key)
            source, kind, identity, task, target = expected[key]
            if entry.get('source') != source or entry.get('kind') != kind or any(entry.get(k) != v for k, v in identity.items()):
                failures.append('identity_mismatch')
            if type(entry.get('task')) is not int or entry['task'] != task or entry.get('target') != target or entry.get('test') != pointer:
                failures.append('invalid_mapping')
        if seen != set(expected):
            failures.append('missing_identity')
    except (KeyError, TypeError, AttributeError):
        failures.append('invalid_matrix')
    return {'verified': not failures, 'expected': len(expected), 'failures': failures}
