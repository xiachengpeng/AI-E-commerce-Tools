"""Exercise concrete observation logic with disposable files and fake OS output."""
import plistlib
from pathlib import Path
from types import SimpleNamespace

import pytest


def result(code=0, stdout='', stderr=''):
    return SimpleNamespace(returncode=code,stdout=stdout,stderr=stderr)


@pytest.fixture
def fixture(tmp_path):
    root=tmp_path/'source';root.mkdir()
    data=tmp_path/'data';data.mkdir()
    db=data/'workbench.db';db.write_bytes(b'synthetic db')
    evidence=data/'evidence';evidence.mkdir();(evidence/'.signing-key').write_bytes(b'e'*32)
    provider=data/'providers';provider.mkdir()
    config=data/'runtime.json';config.write_text('{}')
    integration=data/'integration.json';integration.write_text('{}')
    services=tmp_path/'LaunchAgents';services.mkdir()
    plist=services/'api.plist';plist.write_bytes(plistlib.dumps({'Label':'fixture.api','WorkingDirectory':str(root)}))
    roster={'version':1,'source_root':str(root),'expected_head':'fixture-head',
            'databases':[str(db)],'object_roots':[str(evidence)],'config_roots':[str(provider)],
            'config_files':[str(config),str(integration)],'signing_files':[str(evidence/'.signing-key')],
            'service_roots':[str(services)],'services':[{'domain':'gui/501','label':'fixture.api','plist':str(plist)}]}
    resolved={'database':str(db),'storage':str(evidence),'signing':str(evidence/'.signing-key')}
    calls=[]
    def run(argv,**kwargs):
        calls.append(argv)
        if argv[0]=='lsof':return result(1)
        if argv[:2]==['launchctl','print-disabled']:return result(stdout='"fixture.api" => disabled\n')
        if argv[:2]==['launchctl','print']:return result(113,stderr='Could not find service "fixture.api" in domain for user gui: 501\n')
        if argv[0]=='crontab':return result(1,stderr='crontab: no crontab for fixture\n')
        if argv[0]=='git':return result(stdout='fixture-head\n' if argv[-2:]==['rev-parse','HEAD'] else '')
        raise AssertionError(argv)
    return roster,resolved,run,calls


def test_gap_without_canonical_group_never_runs_unbounded_lsof(tmp_path,fixture):
    from scripts.full_merge.collector import database_holders
    roster,resolved,run,calls=fixture
    canonical=tmp_path/'history.db';recovery=tmp_path/'old.db';recovery.write_bytes(b'backup')
    assert database_holders([canonical],run=run)==[]
    assert calls==[]
    assert database_holders([canonical,recovery],run=run)==[]
    assert calls==[['lsof','-t','--',str(recovery)]]


def test_nonpython_database_writer_is_never_filtered(fixture):
    from scripts.full_merge.collector import collect_source
    roster,resolved,run,calls=fixture
    def cli(argv,**kwargs):
        if argv[0]=='lsof':return result(stdout='678\n') # sqlite3 or arbitrary executable
        return run(argv,**kwargs)
    observation=collect_source(roster,resolved,run=cli)
    assert observation['writers']==[678]


@pytest.mark.parametrize('kind',['lsof_status','lsof_error','lsof_malformed','launchctl_permission','launchctl_wrong_absence','disabled_error','cron_error','git_error'])
def test_inspection_errors_never_mean_frozen(fixture,kind):
    from scripts.full_merge.collector import collect_source
    roster,resolved,run,calls=fixture
    def broken(argv,**kwargs):
        if kind=='lsof_status' and argv[0]=='lsof':return result(2)
        if kind=='lsof_error' and argv[0]=='lsof':return result(1,stderr='permission denied')
        if kind=='lsof_malformed' and argv[0]=='lsof':return result(0,stdout='unparsed')
        if kind=='launchctl_permission' and argv[:2]==['launchctl','print']:return result(1,stderr='permission denied')
        if kind=='launchctl_wrong_absence' and argv[:2]==['launchctl','print']:return result(113,stderr='Could not find domain')
        if kind=='disabled_error' and argv[:2]==['launchctl','print-disabled']:return result(1)
        if kind=='cron_error' and argv[0]=='crontab':return result(1,stderr='permission denied')
        if kind=='git_error' and argv[0]=='git':return result(128,stderr='error')
        return run(argv,**kwargs)
    with pytest.raises(ValueError):collect_source(roster,resolved,run=broken)


@pytest.mark.parametrize('field',['runtime.json','integration.json'])
def test_all_consumed_configuration_changes_frozen_digest(fixture,field):
    from scripts.full_merge.collector import collect_source
    roster,resolved,run,calls=fixture
    before=collect_source(roster,resolved,run=run)
    path=next(Path(x) for x in roster['config_files'] if Path(x).name==field)
    path.write_text('{"changed":true}')
    after=collect_source(roster,resolved,run=run)
    assert before['source_state_sha256']!=after['source_state_sha256']


@pytest.mark.parametrize('field',['database','storage','signing'])
def test_effective_native_path_outside_reviewed_roster_rejected(fixture,field,tmp_path):
    from scripts.full_merge.collector import collect_source
    roster,resolved,run,calls=fixture
    resolved[field]=str(tmp_path/'unreviewed')
    with pytest.raises(ValueError,match='roster'):collect_source(roster,resolved,run=run)
    assert calls==[]


def test_all_roster_files_and_sidecars_are_inventoried(fixture):
    from scripts.full_merge.collector import collect_source
    roster,resolved,run,calls=fixture
    db=Path(resolved['database'])
    for suffix in ['-wal','-shm','-journal']:Path(str(db)+suffix).write_bytes(b'fixture')
    collect_source(roster,resolved,run=run)
    lsof=next(call for call in calls if call[0]=='lsof')
    for path in [*roster['config_files'],*roster['signing_files'],resolved['database'],str(db)+'-wal',str(db)+'-shm',str(db)+'-journal']:
        assert path in lsof
    assert '-p' not in lsof


def test_snapshot_guard_rechecks_same_roster_and_effective_paths(fixture):
    from scripts.full_merge.collector import snapshot_guard
    roster,resolved,run,calls=fixture
    with pytest.raises(ValueError,match='changed'):
        with snapshot_guard(roster,lambda:resolved,run=run):
            Path(roster['config_files'][0]).write_text('changed')


def test_new_source_launch_agent_requires_roster_review(fixture):
    from scripts.full_merge.collector import collect_source
    roster,resolved,run,calls=fixture
    agent=Path(roster['service_roots'][0])/'other.plist'
    agent.write_bytes(plistlib.dumps({'Label':'other.writer','ProgramArguments':['sqlite3',resolved['database']]}))
    with pytest.raises(ValueError,match='service'):collect_source(roster,resolved,run=run)


def test_actual_local_barrier_handles_canonical_rename_gap(fixture,tmp_path):
    from scripts.full_merge.collector import collect_local
    roster,resolved,run,calls=fixture
    candidate=tmp_path/'candidate';candidate.mkdir();(candidate/'history.db').write_bytes(b'candidate')
    recovery=tmp_path/'recovery';recovery.mkdir();(recovery/'history.db').write_bytes(b'old')
    plan={'database':str(tmp_path/'absent/history.db'),'candidate':str(candidate),'candidate_database':'history.db','recovery_root':str(recovery)}
    assert collect_local(plan,run=run)==[]
    inventory=calls[0]
    assert inventory==['lsof','-t','--',str(candidate/'history.db'),str(recovery/'history.db')]
    assert all(call!=['lsof','-t','--'] for call in calls)


def test_snapshot_sources_cover_entire_reviewed_roster(fixture):
    from scripts.full_merge.collector import snapshot_sources,source_files
    roster,resolved,run,calls=fixture
    sources=snapshot_sources(roster)
    covered=set(sources['databases']+sources['key_files'])
    for root in sources['object_roots']:covered.update(p for p in root.rglob('*') if p.is_file())
    assert set(source_files(roster)) <= covered


def test_effective_value_changes_frozen_digest(fixture):
    from scripts.full_merge.collector import collect_source
    roster,resolved,run,calls=fixture
    before=collect_source(roster,dict(resolved,effective_sha256='a'*64),run=run)
    after=collect_source(roster,dict(resolved,effective_sha256='b'*64),run=run)
    assert before['source_state_sha256']!=after['source_state_sha256']


def test_snapshot_requires_recorded_frozen_state_before_reading(fixture):
    from scripts.full_merge.collector import snapshot_guard
    roster,resolved,run,calls=fixture
    entered=[]
    with pytest.raises(ValueError,match='before snapshot'):
        with snapshot_guard(roster,lambda:resolved,expected_state='0'*64,run=run):entered.append(True)
    assert not entered


def test_snapshot_keeps_original_sidecars_as_private_provenance(fixture):
    from scripts.full_merge.collector import snapshot_sources
    roster,resolved,run,calls=fixture
    sidecar=Path(resolved['database']+'-wal');sidecar.write_bytes(b'original')
    assert sidecar in snapshot_sources(roster)['key_files']



def test_partial_lsof_selection_preserves_known_holders(fixture):
    from scripts.full_merge.collector import file_holders, snapshot_guard
    roster,resolved,run,calls=fixture
    def partial(argv,**kwargs):
        if argv[0]=='lsof':return result(1,stdout='660\n670\n')
        return run(argv,**kwargs)
    # macOS returns 1 when a named closed config is selected alongside an open DB.
    assert file_holders(roster['config_files']+[resolved['database']],run=partial)==[660,670]
    with pytest.raises(ValueError,match='source writers not frozen'):
        with snapshot_guard(roster,lambda:resolved,run=partial):
            pytest.fail('known source holders must never count as frozen')


@pytest.mark.parametrize('code,stdout,stderr',[
    (1,'660\n','permission denied'),
    (1,'660\nmalformed\n',''),
    (2,'660\n',''),
])
def test_partial_lsof_selection_never_hides_inspection_errors(fixture,code,stdout,stderr):
    from scripts.full_merge.collector import file_holders
    roster,resolved,run,calls=fixture
    def broken(argv,**kwargs):return result(code,stdout=stdout,stderr=stderr)
    with pytest.raises(ValueError):file_holders(roster['config_files'],run=broken)
