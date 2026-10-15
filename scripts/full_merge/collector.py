"""Portable, read-only cutover observation. No host paths, credentials or SSH here.

Operator configuration is a reviewed source roster. Native settings resolution is
supplied separately and checked against it on EVERY observation and snapshot.
OS inspectors must be able to see all holders of the named deployment files;
errors/warnings never count as an empty inventory. All subprocesses are bounded.
"""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import plistlib
import subprocess
import time


def _path(value):
    path=Path(value)
    if not path.is_absolute() or '..' in path.parts or any(p.is_symlink() for p in (path,*path.parents)):
        raise ValueError('reviewed absolute nonsymlink roster required')
    return path


def _run(argv,run):
    result=run(argv,capture_output=True,text=True,timeout=15)
    if not isinstance(result.stdout,str) or not isinstance(result.stderr,str):
        raise ValueError('inspection response invalid')
    return result


def file_holders(paths, *, run=subprocess.run):
    """No executable filtering. Empty lists must NEVER invoke unbounded lsof."""
    names=sorted({str(_path(path)) for path in paths if _path(path).exists()})
    if not names:return []
    found=set()
    # Bound argv length without weakening individual-file coverage.
    for offset in range(0,len(names),128):
        response=_run(['lsof','-t','--',*names[offset:offset+128]],run)
        lines=response.stdout.splitlines()
        if response.stderr.strip() or response.returncode not in (0,1):
            raise ValueError('file-holder inspection unavailable')
        # macOS may return 1 for a mixed selection of open and closed files.
        # Valid emitted PIDs still prove holders, so preserve them as blockers.
        if (response.returncode==0 and not lines or
                any(not re.fullmatch(r'[1-9][0-9]*',line) for line in lines)):
            raise ValueError('file-holder inspection malformed')
        found.update(int(line) for line in lines)
    return sorted(found)


def database_holders(databases, *, run=subprocess.run):
    return file_holders([Path(str(database)+suffix) for database in databases
                         for suffix in ('','-wal','-shm','-journal')],run=run)


def validate_resolved(roster,resolved):
    if roster.get('version')!=1:raise ValueError('unsupported source roster')
    for field,role in (('database','databases'),('storage','object_roots'),('signing','signing_files')):
        if str(_path(resolved[field])) not in roster[role]:
            raise ValueError('effective source path outside reviewed roster')
    # More than one database can be backed up (for example translation cache), but
    # the resolver must identify exactly the reviewed native primary and key.
    if not roster['services'] or not roster['databases'] or not roster['object_roots']:
        raise ValueError('incomplete source roster')


def _service_roster(roster):
    if not roster.get('service_roots'):raise ValueError('service inventory roots required')
    reviewed={entry['plist']:entry['label'] for entry in roster['services']}
    needles=[roster['source_root'],*roster['databases'],*roster['object_roots'],*roster['config_roots']]
    for raw in roster['service_roots']:
        root=_path(raw)
        if not root.exists():continue
        if not root.is_dir():raise ValueError('invalid service inventory root')
        for file in root.glob('*.plist'):
            _path(file)
            try:
                content=plistlib.loads(file.read_bytes())
                # Searching serialized plist values also covers nested arguments
                # and environment paths, without exporting their contents.
                encoded=repr(content)
            except (OSError,ValueError,plistlib.InvalidFileException):
                raise ValueError('service definition inspection unavailable') from None
            if any(needle in encoded for needle in needles):
                if reviewed.get(str(file))!=content.get('Label'):
                    raise ValueError('unreviewed source service definition')


def source_files(roster):
    """Return complete current file roster; additions in roots change its digest."""
    _service_roster(roster)
    files=set()
    for role in ('databases','config_files','signing_files'):
        for raw in roster[role]:
            path=_path(raw)
            if not path.is_file():raise ValueError('required source roster file missing')
            files.add(path)
    for entry in roster['services']:
        path=_path(entry['plist'])
        if not path.is_file():raise ValueError('required service definition missing')
        files.add(path)
    for raw in roster.get('optional_config_files',[]):
        path=_path(raw)
        if path.exists():
            if not path.is_file():raise ValueError('invalid optional configuration')
            files.add(path)
    for role in ('object_roots','config_roots'):
        for raw in roster[role]:
            path=_path(raw)
            if not path.is_dir():raise ValueError('required source roster root missing')
            for child in path.rglob('*'):
                _path(child)
                if child.is_file():files.add(child)
                elif not child.is_dir():raise ValueError('unsupported source file type')
    for raw in roster['databases']:
        for suffix in ('-wal','-shm','-journal'):
            path=_path(raw+suffix)
            if path.exists():
                if not path.is_file():raise ValueError('invalid database sidecar')
                files.add(path)
    return sorted(files)


def fingerprint(roster):
    files=source_files(roster)
    entries=[]
    for path in files:
        before=path.stat()
        with path.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
        after=path.stat()
        if (before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns):
            raise ValueError('source changed during fingerprint')
        entries.append((str(path),digest))
    if files!=source_files(roster):raise ValueError('source roster changed during observation')
    # Includes all role/path definitions, optional absence and service identity.
    roster_hash=hashlib.sha256(json.dumps(roster,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    digest=hashlib.sha256(json.dumps([roster_hash,entries],separators=(',',':')).encode()).hexdigest()
    return digest,files,roster_hash


def service_autostart(services, *, run=subprocess.run):
    result={}
    for service in services:
        domain,label=service['domain'],service['label']
        if not re.fullmatch(r'gui/[0-9]+',domain) or not re.fullmatch(r'[A-Za-z0-9_.-]+',label):
            raise ValueError('invalid reviewed service identity')
        disabled=_run(['launchctl','print-disabled',domain],run)
        if disabled.returncode!=0 or disabled.stderr.strip():raise ValueError('launchd disabled inspection unavailable')
        is_disabled=re.search(r'"'+re.escape(label)+r'"\s*=>\s*disabled\b',disabled.stdout) is not None
        loaded=_run(['launchctl','print',domain+'/'+label],run)
        if loaded.returncode==0:
            if loaded.stderr.strip() or not loaded.stdout.strip():raise ValueError('launchd loaded inspection invalid')
            exists=True
        else:
            # launchctl's exact expected missing-SERVICE result, not missing
            # domain, permission denial, SSH failure or arbitrary nonzero exit.
            expected=f'Could not find service "{label}" in domain for user gui: {domain.split("/")[1]}'
            lines=[line.strip() for line in loaded.stderr.splitlines() if line.strip()]
            if loaded.returncode!=113 or loaded.stdout.strip() or lines not in ([expected],['Bad request.',expected]):
                raise ValueError('launchd service absence unconfirmed')
            exists=False
        result[label]=exists or not is_disabled
    return result


def collect_source(roster,resolved, *, run=subprocess.run):
    validate_resolved(roster,resolved)
    before,files,roster_hash=fingerprint(roster)
    writers=file_holders(files,run=run)
    autostart=service_autostart(roster['services'],run=run)
    cron=_run(['crontab','-l'],run)
    if cron.returncode==0:
        if cron.stderr.strip():raise ValueError('cron inspection unavailable')
        if cron.stdout.strip():raise ValueError('unreviewed scheduled writers')
    elif not (cron.returncode==1 and not cron.stdout.strip() and re.fullmatch(r'crontab: no crontab for [^\r\n]+\n?',cron.stderr)):
        raise ValueError('cron absence unconfirmed')
    root=str(_path(roster['source_root']))
    head=_run(['git','-C',root,'rev-parse','HEAD'],run)
    status=_run(['git','-C',root,'status','--short'],run)
    if (head.returncode or status.returncode or head.stderr.strip() or status.stderr.strip()
            or head.stdout.strip()!=roster['expected_head'] or status.stdout.strip()):
        raise ValueError('source code inspection mismatch or unavailable')
    after,_,_=fingerprint(roster)
    if before!=after:raise ValueError('source changed during observation')
    effective=hashlib.sha256(json.dumps(resolved,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    bound=hashlib.sha256((after+effective).encode()).hexdigest()
    return {'observed_at':time.time(),'writers':writers,'autostart':autostart,
            'source_state_sha256':bound,'roster_sha256':roster_hash}


@contextmanager
def snapshot_guard(roster,resolve, *, expected_state=None,run=subprocess.run):
    """Same live logic before/after backup; no boolean freeze attestation bypass."""
    before=collect_source(roster,resolve(),run=run)
    if before['writers'] or any(before['autostart'].values()):raise ValueError('source writers not frozen')
    if expected_state is not None and before['source_state_sha256']!=expected_state:
        raise ValueError('source changed before snapshot')
    yield before
    after=collect_source(roster,resolve(),run=run)
    if before!=dict(after,observed_at=before['observed_at']):
        raise ValueError('source changed during snapshot')


def snapshot_sources(roster):
    """One reviewed roster drives both observation and original-byte backups."""
    source_files(roster) # Required paths, symlinks and discovered services validate.
    keys=[_path(p) for p in roster['config_files']+roster['signing_files']]
    keys.extend(_path(s['plist']) for s in roster['services'])
    keys.extend(_path(db+suffix) for db in roster['databases'] for suffix in ('-wal','-shm','-journal') if _path(db+suffix).exists())
    keys.extend(_path(p) for p in roster.get('optional_config_files',[]) if _path(p).exists())
    return {'databases':[_path(p) for p in roster['databases']],
            'object_roots':[_path(p) for p in roster['object_roots']+roster['config_roots']],
            'key_files':list(dict.fromkeys(keys))}


def collect_local(plan, *, run=subprocess.run):
    """Concrete local half of the barrier, including the intentional rename gap."""
    databases=[_path(plan['database']),_path(plan['candidate'])/plan['candidate_database'],
               _path(plan['recovery_root'])/'history.db']
    writers=database_holders(databases,run=run)
    ports=_run(['lsof','-nP','-iTCP:9502','-iTCP:9503','-sTCP:LISTEN','-t'],run)
    if ports.returncode not in (0,1) or ports.stderr.strip():raise ValueError('listener inspection unavailable')
    lines=ports.stdout.splitlines()
    if (ports.returncode==1 and lines or ports.returncode==0 and
            (not lines or any(not re.fullmatch(r'[1-9][0-9]*',line) for line in lines))):
        raise ValueError('listener inspection malformed')
    return sorted(set(writers)|{int(line) for line in lines})
