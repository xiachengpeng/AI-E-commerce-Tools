"""The bundle gate must reject private state, not merely a missing executable."""
import importlib.util
from pathlib import Path


def checker():
    path=Path(__file__).resolve().parents[2]/'scripts/desktop/verify_bundle.py'
    spec=importlib.util.spec_from_file_location('verify_desktop_bundle',path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_rejects_private_files_and_escaping_links(tmp_path):
    (tmp_path/'.env').write_text('not-real')
    (tmp_path/'history.db').write_bytes(b'not-a-db')
    outside=tmp_path.parent/'outside-file'
    outside.write_bytes(b'fixture')
    (tmp_path/'escape').symlink_to(outside)
    issues=checker().validate(tmp_path)
    assert 'private-state:.env' in issues
    assert 'private-state:history.db' in issues
    assert 'escaping-symlink:escape' in issues


def test_clean_resources_are_accepted(tmp_path):
    for name in ['backend/ai-ecommerce-backend','frontend/index.html','frontend/dist/output.css','frontend/js/research-workbench/index.mjs','frontend/assets/phosphor/regular/style.css']:
        p=tmp_path/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('fixture')
    import json
    inventory={}
    for name in ('chromium','chromium-headless-shell','ffmpeg'):
        executable=tmp_path/'browsers'/name
        executable.parent.mkdir(exist_ok=True)
        executable.write_text('fixture');executable.chmod(0o700)
        inventory[name]='browsers/'+name
    (tmp_path/'browser-inventory.json').write_text(json.dumps(inventory))
    assert checker().validate(tmp_path)==[]


def test_rejects_missing_matching_bundled_browser(tmp_path):
    issues=checker().validate(tmp_path)
    assert any(x.startswith('missing-browser:') for x in issues)


def test_python_runtime_copy_preserves_framework_structure(tmp_path):
    path=Path(__file__).resolve().parents[2]/'scripts/desktop/build_backend.py'
    spec=importlib.util.spec_from_file_location('build_desktop_backend',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    source=tmp_path/'source';(source/'Versions/3.12').mkdir(parents=True)
    (source/'Versions/3.12/Python').write_text('fixture')
    (source/'Versions/Current').symlink_to('3.12')
    (source/'Python').symlink_to('Versions/Current/Python')
    target=tmp_path/'target'
    module.copy_runtime(source,target)
    assert (target/'Python').is_symlink()
    assert (target/'Versions/Current').is_symlink()
    assert (target/'Python').read_text()=='fixture'
