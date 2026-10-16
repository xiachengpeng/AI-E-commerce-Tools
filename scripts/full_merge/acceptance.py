"""Fail-closed local acceptance accounting; no live data or external I/O.

JUnit evidence establishes local automated contracts, not live external parity.
Operational cutover proof and seven actual use days remain separate gates.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

from scripts.full_merge.inventory import validate_coverage, validate_original_inventory

INVENTORY = 'backend/tests/test_full_merge_inventory.py::test_full_merge_coverage_matrix'
VERSIONS = 'backend/tests/test_full_merge_data.py::test_all_versions_and_original_key_bytes'
DATA = 'backend/tests/test_full_merge_data.py::test_raw_rows_preserved_and_idempotent'
ROUTES = 'backend/tests/test_research_facade.py::test_all_local_v1_routes_reuse_lifecycle_and_session'
ACTIONS = 'backend/tests/test_research_facade.py::test_idempotency_and_user_action_allowlist'
KINDS = 'backend/tests/test_full_merge_no_remote.py::test_all_legacy_kinds_keep_actual_baseline_queue_behavior'
NATIVE = 'backend/tests/test_research_workbench_routes.py::test_original_business_route_inventory'
PRODUCT = 'backend/tests/test_research_integration.py::test_direct_product_route_is_guarded_and_ownership_validated'
HISTORY = 'backend/tests/test_research_workbench_routes.py::test_native_history_canonical_projection_cursor_and_private_payload'
RECEIPT = 'backend/tests/test_research_workbench_routes.py::test_native_draft_receipt_is_scoped_read_only_and_private'
UNSUPPORTED = {'meta_scan', 'landing_scan', 'trends_scan', 'evaluate', 'feishu_writeback'}
ADDITIVE = (
    ('additive:product', '/api/research/v1/projects/{project_id}/products/{product_id}', PRODUCT),
    ('additive:history', '/api/research/workbench/v1/history', HISTORY),
    ('additive:receipt', '/api/research/workbench/v1/projects/{project_id}/commands/{command_id}', RECEIPT),
    ('additive:evidence_versions', 'private evidence all VersionIds and original key bytes', VERSIONS),
)


# Independent named merchant-workflow requirements, separate from 217+4 inventory identities.
NATIVE_WORKFLOW_FILE = 'frontend/tests/research-workbench/native-workflows.test.mjs'
NATIVE_WORKFLOWS = (
    'native Trends initial merchant workflow preserves explicit market query, identity and one enqueue',
    'native Trends uncertain submit preserves typed input and forbids automatic duplicate or changed replay',
    'native verification initial review stop and deliberate mismatch parking preserve contracts',
    'native Feishu status preview exact approval stale rejection and original blocked retry have no entry mutations',
    'native progress refresh consumes projections outside first twenty, preserves edits and cleans poll with late scope fence',
    'native Feishu ambiguous approval submits once and missing credentials remain actionable',
    'native verification unknown outcome never enables new verify or review replay',
    'native mismatch batch saves every eligible original product with progressive versions and retains partial failure identity',
    'native Feishu successful approval refreshes durable status and stale local preview never submits',
    'native late sync preview and status after project switch cannot approve or overwrite current page',
    'native actual workbench queue completion and return refresh project without mutation or global refresh',
    'native polling preserves the current dirty product form DOM and its original submission version',
    'native dirty form remount keeps saved base version after authoritative background update',
    'native header refresh keeps open product form edits and captured base version',
    'native mismatch partial failure remains visible when redraw disposes the old page',
    'native Feishu uncertain_create explicit retry preserves original checkpoint run and never starts a new sync',
    'native in-flight mismatch remount releases transient lock but preserves uncertain command identity',
    'native in-flight Feishu approval and original retry retain uncertainty before unmount snapshot and late rejection',
)

def native_workflow_gate(report_root: Path, components: dict) -> dict:
    path = report_root / 'main/native-workflows.xml'
    failures = []
    code = components.get('main', {}).get('native_workflows')
    if type(code) is not int or code != 0:
        failures.append('failed_or_missing_native_workflow_component')
    try:
        cases = list(ET.parse(path).getroot().iter('testcase'))
        if not cases or any(case.find(tag) is not None for case in cases for tag in ('failure', 'error', 'skipped')):
            failures.append('failed_or_empty_native_workflow_evidence')
        for name in NATIVE_WORKFLOWS:
            matches = [case for case in cases if case.get('name') == name
                       and case.get('file', '').replace('\\', '/').endswith('/' + NATIVE_WORKFLOW_FILE)]
            if len(matches) != 1 or any(matches[0].find(tag) is not None for tag in ('failure', 'error', 'skipped')):
                failures.append('unproved_native_workflow:' + name)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    except (OSError, ET.ParseError):
        failures.append('missing_native_workflow_evidence')
        digest = None
    return {'accepted': not failures, 'failures': failures, 'path': str(path), 'sha256': digest,
            'required_file': NATIVE_WORKFLOW_FILE, 'required_cases': list(NATIVE_WORKFLOWS),
            'scope': 'required native DOM/fake HTTP merchant workflows; no live external parity'}


def _case_status(path: Path) -> dict[str, bool]:
    root = ET.parse(path).getroot()
    result = {}
    for case in root.iter('testcase'):
        prefix = case.get('classname', '').replace('.', '/') + '.py::'
        name = case.get('name', '')
        pointer = prefix + name.split('[')[0]
        passed = not any(case.find(tag) is not None for tag in ('failure', 'error', 'skipped'))
        result[prefix + name] = passed
        result[pointer] = result.get(pointer, True) and passed
    return result


def acceptance(coverage: Path, report_root: Path) -> dict:
    failures, rows = [], []
    reports = {}
    original = {}
    native = {'accepted': False, 'failures': ['missing_native_workflow_evidence']}
    try:
        matrix = json.loads(coverage.read_text())
        original = validate_original_inventory(matrix)
        failures.extend(original['failures'])
        checked = validate_coverage(matrix)
        failures.extend(checked['failures'])
        components = json.loads((report_root / 'component-results.json').read_text())
        native = native_workflow_gate(report_root, components)
        failures.extend(native['failures'])
        required = {'main': {'pytest', 'frontend'}, 'research': {'pytest', 'frontend', 'ruff', 'mypy', 'tailwind', 'frontend_build'}}
        for suite, names in required.items():
            if not names <= components.get(suite, {}).keys() or any(type(components[suite].get(name)) is not int or components[suite][name] != 0 for name in names):
                failures.append('failed_or_missing_components:' + suite)
            path = report_root / suite / 'pytest.xml'
            xml = ET.parse(path).getroot()
            if not list(xml.iter('testcase')) or list(xml.iter('failure')) or list(xml.iter('error')):
                failures.append('failed_or_empty_junit:' + suite)
            reports[suite] = {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'cases': _case_status(path)}
            log = (report_root / suite / 'frontend.log').read_text()
            if '# fail 0' not in log or '# pass ' not in log:
                failures.append('missing_frontend_summary:' + suite)
        def add(identity, target, pointers, status='local_contract_verified'):
            for pointer in pointers:
                if reports['main']['cases'].get(pointer) is not True:
                    failures.append('unproved_case:' + identity + ':' + pointer)
            rows.append({'id':identity, 'target':target, 'tests':pointers, 'report':reports['main']['path'], 'status':status})
        for row in matrix['coverage']:
            kind, source = row['kind'], row['source']
            test = DATA if kind == 'table' else KINDS if kind == 'job_kind' else ACTIONS if kind == 'action' else ROUTES if source == 'research' and kind == 'route' else INVENTORY
            if kind == 'job_kind':
                test = KINDS + '[' + row['name'] + ']'
            status = 'baseline_unsupported_verified' if kind == 'job_kind' and row['name'] in UNSUPPORTED else 'local_contract_verified'
            target = row['target']
            notes = 'local fixture/contract; external execution not verified'
            if source == 'research' and kind == 'route':
                path = row['path']
                if path.startswith('/workbench/api'):
                    target = '/api/research/workbench/v1' + path.removeprefix('/workbench/api')
                    test = NATIVE
                elif path.startswith('/internal/integration/v1'):
                    target = 'ResearchFacade local methods + /api/research/v1: ' + path.removeprefix('/internal/integration/v1')
                else:
                    target = 'native frontend/index.html + runtime lifecycle diagnostics; archived source transport: ' + path
                    notes = 'source shell/static/operations endpoint inventory retained; native equivalent, not identical public URL'
                    status = 'retired_transport_inventory_verified'
            elif source == 'research' and kind == 'page':
                target = ('frontend/index.html native research workspace' if row['name'].startswith('frontend/')
                          else 'backend/tests/research/' + row['name'].removeprefix('tests/'))
                if row['name'].startswith('tests/'):
                    status = 'preserved_test_fixture_inventory_verified'
            elif source == 'research' and kind == 'action':
                target = '/api/research/workbench/v1/projects/{project_id}/commands + original Store USER_ACTIONS: ' + row['name']
            add(row['id'], target, list(dict.fromkeys([INVENTORY, test])), status)
            rows[-1]['limits'] = notes
        for identity, target, pointer in ADDITIVE:
            add(identity, target, [pointer])
    except (OSError, ValueError, KeyError, TypeError, ET.ParseError) as exc:
        failures.append('invalid_or_missing_evidence:' + type(exc).__name__)
    return {'local_code_accepted': not failures, 'failures': sorted(set(failures)),
            'original_inventory': original.get('authority'), 'native_workflow_gate': native,
            'coverage_count':len(rows), 'status_counts':dict(Counter(row['status'] for row in rows)),
            'rows':rows, 'reports':{k:{a:b for a,b in v.items() if a != 'cases'} for k,v in reports.items()},
            'scope':'local automated contracts; inventory-only row proof is not exhaustive per-endpoint behavior proof',
            'external':{'status':'not_verified'},
            'observation':{'status':'pending_actual_use_days', 'required_days':7, 'verified_days':0}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--coverage', type=Path, required=True)
    parser.add_argument('--report-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = acceptance(args.coverage, args.report_root)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({key:value for key,value in result.items() if key not in {'rows','reports'}}, ensure_ascii=False))
    raise SystemExit(0 if result['local_code_accepted'] else 1)
