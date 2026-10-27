from pathlib import Path
import importlib.util


def auditor():
    spec=importlib.util.spec_from_file_location('customer_audit',Path(__file__).resolve().parents[2]/'scripts/desktop/verify_customer.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def test_customer_content_audit_rejects_keys_and_private_paths(tmp_path):
    (tmp_path/'app.js').write_text('const key="sk-'+('a'*36)+'";')
    assert any('embedded-secret:' in p for p in auditor().audit_content(tmp_path))
    (tmp_path/'app.js').write_text('const root="/Users/developer/private-project";')
    assert any('developer-path:' in p for p in auditor().audit_content(tmp_path))


def test_customer_content_audit_accepts_secret_field_names_without_values(tmp_path):
    (tmp_path/'app.js').write_text('const fields={api_key:"", token:"", secret_access_key:""};')
    assert auditor().audit_content(tmp_path)==[]


def test_runtime_frontend_staging_is_allowlisted(tmp_path):
    spec=importlib.util.spec_from_file_location('customer_build',Path(__file__).resolve().parents[2]/'scripts/desktop/build_customer.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    root=tmp_path/'source';root.mkdir()
    for name in ('css','js','assets'):(root/name).mkdir()
    (root/'dist').mkdir();(root/'dist/output.css').write_text('body{}')
    (root/'index.html').write_text('<html>https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2.1.1/src/regular/style.css</html>')
    (root/'.env').write_text('private')
    (root/'history.db').write_text('private')
    (root/'js/app.js').write_text('const value=1;')
    icons=tmp_path/'icons';(icons/'src/regular').mkdir(parents=True)
    (icons/'src/regular/style.css').write_text('font{}');(icons/'LICENSE').write_text('license')
    out=tmp_path/'out'
    module.stage_frontend(root,out,icons)
    assert not (out/'.env').exists() and not (out/'history.db').exists()
    assert 'https://cdn.jsdelivr.net/npm/@phosphor' not in (out/'index.html').read_text()
    assert (out/'assets/phosphor/LICENSE').is_file()
