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
    trees = {}
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
        trees[name] = tree
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
                    result['routes'].append({'method': verb, 'path': prefixes.get(receiver, '') + argument.value, 'file': name, 'handler': node.name, 'receiver': receiver})
    _resolve_mounts(result, trees)
    result['user_actions'], result['job_kinds'] = sorted(actions), sorted(jobs)
    return result


def _resolve_mounts(result, trees):
    """Resolve literal include_router edges and imported router aliases without imports."""
    edges = {}
    prefixes = {}
    for file, tree in trees.items():
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                if isinstance(node.value.func, ast.Name) and node.value.func.id in {'APIRouter', 'FastAPI'}:
                    prefix = next((k.value.value for k in node.value.keywords if k.arg == 'prefix' and isinstance(k.value, ast.Constant) and isinstance(k.value.value, str)), '')
                    for target in node.targets:
                        if isinstance(target, ast.Name):
                            prefixes[(file, target.id)] = prefix
    for file, tree in trees.items():
        if any(part in {'tests', 'docs'} for part in Path(file).parts) or Path(file).name.startswith('test_'):
            continue
        imports = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                suffix = node.module.replace('.', '/') + '.py'
                if node.level:
                    base = Path(file).parent
                    for _ in range(node.level - 1):
                        base = base.parent
                    candidates = [str(base / suffix)] if str(base / suffix) in trees else []
                else:
                    candidates = [f for f in trees if f == suffix or f.endswith('/' + suffix)]
                if len(candidates) == 1:
                    for alias in node.names:
                        imports[alias.asname or alias.name] = (candidates[0], alias.name)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute) or node.func.attr != 'include_router':
                continue
            child = node.args[0] if node.args else next((k.value for k in node.keywords if k.arg == 'router'), None)
            prefix = next((k.value for k in node.keywords if k.arg == 'prefix'), ast.Constant(value=''))
            parent = node.func.value
            if not isinstance(child, ast.Name) or not isinstance(parent, ast.Name) or not isinstance(prefix, ast.Constant) or not isinstance(prefix.value, str):
                result['unresolved'].append({'file': file, 'line': node.lineno, 'reason': 'dynamic_include_router'})
                continue
            identity = imports.get(child.id, (file, child.id))
            if identity[0] not in trees or identity not in prefixes:
                result['unresolved'].append({'file': file, 'line': node.lineno, 'reason': 'unresolved_include_router'})
                continue
            edges.setdefault(identity, []).append(((file, parent.id), prefix.value, node.lineno))
    result['route_declarations'] = [dict(r) for r in result['routes']]
    mounted = []
    def resolve(identity, visited):
        if identity in visited:
            result['unresolved'].append({'file': identity[0], 'reason': 'cyclic_include_router'})
            return []
        if identity not in edges:
            return [('', [])]
        values = []
        for parent, prefix, line in edges[identity]:
            for upstream, mounts in resolve(parent, visited | {identity}):
                values.append((upstream + prefixes.get(parent, '') + prefix, mounts + [{'file': parent[0], 'line': line, 'prefix': prefix}]))
        return values
    for route in result['route_declarations']:
        for prefix, mounts in resolve((route['file'], route['receiver']), set()):
            mounted.append({**route, 'path': prefix + route['path'], 'declaration_path': route['path'], 'mounts': mounts})
    result['routes'] = mounted


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
        for source, runtime in matrix.get('runtime_routes', {}).items():
            actual = {(r['method'], r['path']) for r in matrix['inventories'][source]['routes']}
            if actual != {tuple(route) for route in runtime}:
                failures.append('runtime_route_mismatch')
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
