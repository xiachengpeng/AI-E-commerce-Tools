"""A paused desktop handoff preserves both sources and recoverable prior state."""
import json
from pathlib import Path
import pytest
from scripts.desktop import prepare_data


def fixture(tmp_path):
    import sqlite3
    source=tmp_path/'source';source.mkdir()
    db=source/'history.db'
    with sqlite3.connect(db) as c:c.execute('create table sample(value text)');c.execute("insert into sample values('original')")
    assets=source/'static';assets.mkdir();(assets/'image.png').write_bytes(b'image')
    config=source/'research.json';config.write_text(json.dumps({'enabled':True,'worker_mode':'active'}));config.chmod(0o600)
    root=tmp_path/'research';root.mkdir(mode=0o700)
    candidate=tmp_path/'preparation'
    prepare_data.prepare_candidate(db,assets,candidate,config_files={'research.json':config},research_root=root,offline_check=lambda *a:None)
    desktop=tmp_path/'desktop';desktop.mkdir(mode=0o700)
    (desktop/'profile').mkdir();(desktop/'profile/keep').write_text('browser profile')
    (desktop/'research.json').write_text('{}')
    return dict(preparation=candidate,source_database=db,source_static=assets,source_config=config,
                research_root=root,data_root=desktop,recovery=tmp_path/'recovery',
                offline_check=lambda *a:None,read_check=lambda *a:True)


def install(**kwargs):
    from scripts.desktop.install_data import install_candidate
    return install_candidate(**kwargs)


def test_install_preserves_source_and_profile_and_fences_old_launcher(tmp_path):
    args=fixture(tmp_path);before=args['source_database'].read_bytes()
    result=install(**args)
    assert result['phase']=='local_active'
    assert args['source_database'].read_bytes()==before
    assert prepare_data.database_stats(args['data_root']/'history.db')==prepare_data.database_stats(args['source_database'])
    assert (args['data_root']/'static/image.png').read_bytes()==b'image'
    assert (args['data_root']/'profile/keep').read_text()=='browser profile'
    current=json.loads((args['data_root']/'research.json').read_text())
    assert current['enabled'] is True and current['worker_mode']=='paused'
    assert current['data_root']==str(args['research_root'])
    old=json.loads(args['source_config'].read_text())
    assert old['cutover_ledger']==current['cutover_ledger']
    assert json.loads(Path(current['cutover_ledger']).read_text())['database']==str(args['data_root']/'history.db')
    assert (args['recovery']/'previous/research.json').read_text()=='{}'
    assert prepare_data.verify_candidate(args['preparation'])['verified']


def test_changed_source_refused_without_modifying_desktop(tmp_path):
    args=fixture(tmp_path);(args['source_static']/'image.png').write_bytes(b'changed')
    with pytest.raises(ValueError):install(**args)
    assert not args['recovery'].exists()
    assert (args['data_root']/'research.json').read_text()=='{}'


def test_failed_install_restores_both_configs_and_preserves_failed_payload(tmp_path):
    args=fixture(tmp_path);original=args['source_config'].read_bytes()
    def fail(stage):
        if stage=='installed:history.db':raise RuntimeError('synthetic interruption')
    with pytest.raises(RuntimeError):install(**args,step_hook=fail)
    assert args['source_config'].read_bytes()==original
    assert (args['data_root']/'research.json').read_text()=='{}'
    assert not (args['data_root']/'history.db').exists()
    assert (args['recovery']/'failed/history.db').is_file()
    assert json.loads((args['recovery']/'handoff.json').read_text())['phase']=='rolled_back'


def test_readonly_research_failure_prevents_install(tmp_path):
    args=fixture(tmp_path);args['read_check']=lambda *a:False
    with pytest.raises(ValueError):install(**args)
    assert not args['recovery'].exists()


def test_existing_recovery_never_overwritten(tmp_path):
    args=fixture(tmp_path);args['recovery'].mkdir();(args['recovery']/'keep').write_text('keep')
    with pytest.raises(FileExistsError):install(**args)
    assert (args['recovery']/'keep').read_text()=='keep'


def test_busy_runtime_refuses_without_mutations(tmp_path):
    args=fixture(tmp_path)
    def busy(*a):raise ValueError('busy')
    args['offline_check']=busy
    with pytest.raises(ValueError):install(**args)
    assert not args['recovery'].exists()


@pytest.mark.parametrize('suffix',['-journal','-wal','-shm'])
def test_sqlite_sidecars_block_replacement_before_any_mutation(tmp_path,suffix):
    args=fixture(tmp_path)
    sidecar=args['data_root']/('history.db'+suffix);sidecar.write_bytes(b'pending transaction')
    with pytest.raises(ValueError):install(**args)
    assert not args['recovery'].exists()
    assert sidecar.read_bytes()==b'pending transaction'


def test_post_activation_rollback_is_refused_to_preserve_new_writes(tmp_path):
    args=fixture(tmp_path);install(**args)
    from scripts.desktop.install_data import recover_install
    with pytest.raises(ValueError):recover_install(args['recovery'],offline_check=lambda *a:None)


def test_interrupted_install_can_be_recovered_without_deleting_payload(tmp_path):
    args=fixture(tmp_path);old=args['source_config'].read_bytes()
    def crash(stage):
        if stage=='installed:static':raise KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):install(**args,step_hook=crash)
    from scripts.desktop.install_data import recover_install
    recover_install(args['recovery'],offline_check=lambda *a:None)
    assert args['source_config'].read_bytes()==old
    assert (args['recovery']/'failed/static/image.png').is_file()
    assert (args['data_root']/'research.json').read_text()=='{}'


@pytest.mark.parametrize('stage',['research.json','history.db','static','.env'])
def test_each_interruption_restores_existing_desktop_resources(tmp_path,stage):
    args=fixture(tmp_path)
    (args['data_root']/'history.db').write_bytes(b'prior database fixture')
    (args['data_root']/'static').mkdir();(args['data_root']/'static/prior').write_bytes(b'prior image')
    (args['data_root']/'.env').write_bytes(b'FIXTURE=prior')
    before={n:prepare_data.inventory(args['data_root']/n) if (args['data_root']/n).is_dir() else (args['data_root']/n).read_bytes() for n in ('research.json','history.db','static','.env')}
    def crash(current):
        if current=='installed:'+stage:raise KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):install(**args,step_hook=crash)
    from scripts.desktop.install_data import recover_install
    recover_install(args['recovery'],offline_check=lambda *a:None)
    after={n:prepare_data.inventory(args['data_root']/n) if (args['data_root']/n).is_dir() else (args['data_root']/n).read_bytes() for n in before}
    assert before==after


def interrupted_fixture(tmp_path):
    args=fixture(tmp_path)
    def crash(stage):
        if stage=='installed:history.db':raise KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):install(**args,step_hook=crash)
    return args


def test_recovery_fences_desktop_database_and_all_affected_files(tmp_path):
    args=interrupted_fixture(tmp_path);seen=[]
    def guard(database,roots):seen.append((database,roots))
    from scripts.desktop.install_data import recover_install
    recover_install(args['recovery'],offline_check=guard)
    assert args['data_root']/'history.db' in [db for db,roots in seen]
    roster={p for db,roots in seen for p in roots}
    assert args['data_root']/'research.json' in roster


def test_recovery_resumes_a_matching_source_config_temporary(tmp_path):
    args=interrupted_fixture(tmp_path)
    restore=args['source_config'].with_name('research.json.desktop-restore')
    raw=(args['recovery']/'source-config.original').read_bytes();restore.write_bytes(raw);restore.chmod(0o600)
    from scripts.desktop.install_data import recover_install
    recover_install(args['recovery'],offline_check=lambda *a:None)
    assert args['source_config'].read_bytes()==raw


def test_recovery_preserves_conflicting_temporary_before_any_move(tmp_path):
    args=interrupted_fixture(tmp_path)
    restore=args['source_config'].with_name('research.json.desktop-restore');restore.write_bytes(b'other data')
    installed=(args['data_root']/'history.db').read_bytes()
    from scripts.desktop.install_data import recover_install
    with pytest.raises(ValueError):recover_install(args['recovery'],offline_check=lambda *a:None)
    assert restore.read_bytes()==b'other data'
    assert (args['data_root']/'history.db').read_bytes()==installed


def test_failed_install_does_not_rollback_while_a_new_writer_is_present(tmp_path):
    args=fixture(tmp_path);calls=[]
    def guard(*a):
        calls.append(True)
        if len(calls)>1:raise ValueError('new owner')
    args['offline_check']=guard
    with pytest.raises(ValueError):install(**args)
    assert json.loads((args['recovery']/'handoff.json').read_text())['phase']=='preparing'
    assert (args['data_root']/'history.db').is_file()
