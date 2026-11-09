"""Private, project-bound canvas assets and conservative task records."""
import hashlib
import io
import json
import os
import re
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path

from PIL import Image, UnidentifiedImageError


class CanvasStore:
    def __init__(self, root: Path, *, max_asset_bytes: int = 25 * 1024 * 1024, max_total_bytes: int = 2 * 1024 * 1024 * 1024):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.assets = self.root / 'assets'
        self.assets.mkdir(exist_ok=True, mode=0o700)
        self.leases = self.root / 'leases'
        self.leases.mkdir(exist_ok=True, mode=0o700)
        self.max_asset_bytes = max_asset_bytes
        self.max_total_bytes = max_total_bytes
        self.db_path = self.root / 'canvas.sqlite3'
        with self._connect() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS canvas_provider_models(provider_incarnation TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY(provider_incarnation,model));
            CREATE TABLE IF NOT EXISTS canvas_text_provider_models(provider_incarnation TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY(provider_incarnation,model));
            CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), filename TEXT NOT NULL, bytes INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), operation_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL, result_asset_id TEXT REFERENCES assets(id), UNIQUE(project_id,operation_key));
            ''')
            if 'format' not in {row['name'] for row in db.execute('PRAGMA table_info(projects)')}:
                db.execute("ALTER TABLE projects ADD COLUMN format TEXT NOT NULL DEFAULT 'invoke-v1'")
            if 'archived' not in {row['name'] for row in db.execute('PRAGMA table_info(projects)')}:
                db.execute('ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
            if 'request_json' not in {row['name'] for row in db.execute('PRAGMA table_info(tasks)')}:
                db.execute("ALTER TABLE tasks ADD COLUMN request_json TEXT NOT NULL DEFAULT '{}'")
            if 'reviewed' not in {row['name'] for row in db.execute('PRAGMA table_info(tasks)')}:
                db.execute('ALTER TABLE tasks ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0')
            if 'result_text' not in {row['name'] for row in db.execute('PRAGMA table_info(tasks)')}:
                db.execute('ALTER TABLE tasks ADD COLUMN result_text TEXT')
            if 'error_message' not in {row['name'] for row in db.execute('PRAGMA table_info(tasks)')}:
                db.execute('ALTER TABLE tasks ADD COLUMN error_message TEXT')

    @contextmanager
    def _connect(self):
        db=sqlite3.connect(self.db_path,timeout=30)
        try:
            db.row_factory=sqlite3.Row
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('PRAGMA busy_timeout=30000')
            with db:
                yield db
        finally:
            db.close()

    @contextmanager
    def task_lease(self, task_id):
        # A per-task OS lock survives separate backend processes and is released
        # automatically if the owner crashes. Task IDs are generated internally.
        if not isinstance(task_id,str) or len(task_id)!=32 or any(c not in '0123456789abcdef' for c in task_id):
            raise ValueError('任务编号无效')
        stream=(self.leases/task_id).open('a+b')
        acquired=False
        try:
            if os.name=='nt':
                import msvcrt
                stream.seek(0);stream.write(b'0');stream.flush();stream.seek(0)
                try: msvcrt.locking(stream.fileno(),msvcrt.LK_NBLCK,1);acquired=True
                except OSError: pass
            else:
                import fcntl
                try: fcntl.flock(stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB);acquired=True
                except BlockingIOError: pass
            yield acquired
        finally:
            if acquired:
                if os.name=='nt':
                    stream.seek(0);msvcrt.locking(stream.fileno(),msvcrt.LK_UNLCK,1)
                else: fcntl.flock(stream.fileno(),fcntl.LOCK_UN)
            stream.close()

    def provider_models(self, incarnation):
        with self._connect() as db:
            return [row['model'] for row in db.execute('SELECT model FROM canvas_provider_models WHERE provider_incarnation=? ORDER BY model',(incarnation,))]

    def add_provider_model(self, incarnation, model):
        if not isinstance(incarnation,str) or not incarnation or not isinstance(model,str) or len(model)>160 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]*',model):
            raise ValueError('模型名称无效')
        with self._connect() as db: db.execute('INSERT OR IGNORE INTO canvas_provider_models(provider_incarnation,model) VALUES (?,?)',(incarnation,model))

    def delete_provider_model(self, incarnation, model):
        with self._connect() as db: db.execute('DELETE FROM canvas_provider_models WHERE provider_incarnation=? AND model=?',(incarnation,model))

    def text_provider_models(self, incarnation):
        with self._connect() as db: return [row['model'] for row in db.execute('SELECT model FROM canvas_text_provider_models WHERE provider_incarnation=? ORDER BY model',(incarnation,))]

    def add_text_provider_model(self, incarnation, model):
        if not isinstance(incarnation,str) or not incarnation or not isinstance(model,str) or len(model)>160 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]*',model): raise ValueError('模型名称无效')
        with self._connect() as db: db.execute('INSERT OR IGNORE INTO canvas_text_provider_models(provider_incarnation,model) VALUES (?,?)',(incarnation,model))

    def delete_text_provider_model(self, incarnation, model):
        with self._connect() as db: db.execute('DELETE FROM canvas_text_provider_models WHERE provider_incarnation=? AND model=?',(incarnation,model))

    @staticmethod
    def _id():
        return uuid.uuid4().hex

    def create_project(self, title, *, format='invoke-v1', project_id=None):
        title=str(title).strip()
        if not title or len(title)>200: raise ValueError('画布名称无效')
        if format not in {'invoke-v1','node-v1'}: raise ValueError('画布格式无效')
        if project_id is not None and (format!='node-v1' or not isinstance(project_id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',project_id)):
            raise ValueError('画布编号无效')
        project_id=project_id or self._id()
        try:
            with self._connect() as db: db.execute('INSERT INTO projects (id,title,revision,document,format) VALUES (?, ?, 0, ?, ?)',(project_id,title,'{}',format))
        except sqlite3.IntegrityError as exc:
            raise ValueError('画布编号已存在') from exc
        return self.get_project(project_id)

    def list_projects(self, *, format='invoke-v1', archived=False):
        if format not in {'invoke-v1','node-v1'}: raise ValueError('画布格式无效')
        with self._connect() as db:
            rows=db.execute('SELECT id,title,revision,format FROM projects WHERE format=? AND archived=? ORDER BY rowid DESC',(format,int(archived))).fetchall()
        return [dict(row) for row in rows]

    def get_project(self, project_id):
        with self._connect() as db: row=db.execute('SELECT * FROM projects WHERE id=?',(project_id,)).fetchone()
        if row is None: raise ValueError('画布不存在')
        return {'id':row['id'],'title':row['title'],'revision':row['revision'],'document':json.loads(row['document']),'format':row['format'],'archived':bool(row['archived'])}

    def archive_project(self, project_id):
        with self._connect() as db:
            changed=db.execute("UPDATE projects SET archived=1 WHERE id=? AND format='node-v1' AND archived=0",(project_id,)).rowcount
            if changed!=1: raise ValueError('节点画布不存在或已归档')
        return self.get_project(project_id)

    def restore_project(self, project_id):
        with self._connect() as db:
            changed=db.execute("UPDATE projects SET archived=0 WHERE id=? AND format='node-v1' AND archived=1",(project_id,)).rowcount
            if changed!=1: raise ValueError('节点画布不存在或未归档')
        return self.get_project(project_id)

    def save_project(self, project_id, revision, document):
        if not isinstance(document,dict): raise ValueError('画布资料无效')
        encoded=json.dumps(document,ensure_ascii=False,allow_nan=False,separators=(',',':'))
        if len(encoded.encode())>4*1024*1024: raise ValueError('画布资料超过上限')
        references=set()
        def collect(value):
            if isinstance(value,dict):
                for key,item in value.items():
                    if key=='asset_id':
                        if not isinstance(item,str): raise ValueError('图片引用无效')
                        references.add(item)
                    else: collect(item)
            elif isinstance(value,list):
                for item in value: collect(item)
        collect(document)
        with self._connect() as db:
            for asset_id in references:
                if db.execute('SELECT 1 FROM assets WHERE project_id=? AND id=?',(project_id,asset_id)).fetchone() is None:
                    raise ValueError('图片引用不存在或不属于当前画布')
            result=db.execute('UPDATE projects SET document=?,revision=revision+1 WHERE id=? AND revision=?',(encoded,project_id,revision))
            if result.rowcount!=1: raise ValueError('画布不存在或已发生更改，请刷新后重试')
        return self.get_project(project_id)

    def put_asset(self, project_id, data, *, task_id=None):
        self.get_project(project_id)
        if not isinstance(data,bytes) or not data or len(data)>self.max_asset_bytes: raise ValueError('图片为空或超过大小上限')
        try:
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in {'PNG','JPEG','WEBP'} or image.width*image.height>40_000_000: raise ValueError('图片格式或尺寸不支持')
                image.verify()
        except (UnidentifiedImageError,OSError,Image.DecompressionBombError) as exc: raise ValueError('图片无效') from exc
        asset_id=('result-'+task_id) if task_id else self._id();final=self.assets/asset_id;temporary=self.assets/(asset_id+'.tmp')
        moved=False
        try:
            with temporary.open('xb') as f:
                f.write(data);f.flush();os.fsync(f.fileno())
            with self._connect() as db:
                db.execute('BEGIN IMMEDIATE')
                used=db.execute('SELECT COALESCE(SUM(bytes),0) FROM assets').fetchone()[0]
                if used+len(data)>self.max_total_bytes: raise ValueError('画布存储空间已达上限')
                if task_id and db.execute("SELECT 1 FROM tasks WHERE id=? AND project_id=? AND status IN ('submitted','unknown')",(task_id,project_id)).fetchone() is None:
                    raise ValueError('任务不存在或状态已变化')
                os.replace(temporary,final)
                moved=True
                db.execute('INSERT INTO assets VALUES (?,?,?,?)',(asset_id,project_id,asset_id,len(data)))
                if task_id:
                    db.execute("UPDATE tasks SET status='complete',result_asset_id=?,error_message=NULL WHERE id=?",(asset_id,task_id))
        except BaseException:
            temporary.unlink(missing_ok=True)
            if moved: final.unlink(missing_ok=True)
            raise
        return {'id':asset_id,'size':len(data)}

    def put_task_result(self, task_id, project_id, data):
        self.put_asset(project_id,data,task_id=task_id)
        return self.get_task(task_id)

    def read_asset(self, project_id, asset_id):
        with self._connect() as db: row=db.execute('SELECT filename FROM assets WHERE project_id=? AND id=?',(project_id,asset_id)).fetchone()
        if row is None: raise ValueError('图片不存在')
        return (self.assets/row['filename']).read_bytes()

    def asset_info(self, project_id, asset_id):
        data=self.read_asset(project_id,asset_id)
        with Image.open(io.BytesIO(data)) as image:
            return {'id':asset_id,'mime_type':Image.MIME[image.format], 'width':image.width,'height':image.height,'size':len(data)}

    def create_task(self, project_id, operation_key, request, *, expected_revision=None):
        if not isinstance(operation_key,str) or not 1<=len(operation_key)<=200: raise ValueError('操作编号无效')
        request_json=json.dumps(request,sort_keys=True,ensure_ascii=False,allow_nan=False,separators=(',',':'))
        request_hash=hashlib.sha256(request_json.encode()).hexdigest()
        task_id=self._id()
        with self._connect() as db:
            if expected_revision is not None:
                db.execute('BEGIN IMMEDIATE')
                existing=db.execute('SELECT 1 FROM tasks WHERE project_id=? AND operation_key=?',(project_id,operation_key)).fetchone()
                if not existing and db.execute("SELECT 1 FROM projects WHERE id=? AND format='node-v1' AND archived=0 AND revision=?",(project_id,expected_revision)).fetchone() is None:
                    raise ValueError('画布已更改，请保存并重新确认')
                node_context=request.get('node_context') or {}
                node_id=node_context.get('node_id')
                if not existing:
                    active=db.execute("SELECT request_json FROM tasks WHERE project_id=? AND (status='submitted' OR (status='unknown' AND reviewed=0))",(project_id,)).fetchall()
                    blocked=any(
                        not node_id
                        or not (prior_node_id:=json.loads(row['request_json']).get('node_context',{}).get('node_id'))
                        or prior_node_id==node_id
                        for row in active
                    )
                    if blocked:
                        raise ValueError('当前节点存在进行中或结果未确认的任务，请先核对该任务记录')
                if not existing:
                    batch = node_context.get('batch_id')
                    pending = db.execute("SELECT request_json FROM tasks WHERE project_id=? AND status='prepared'", (project_id,)).fetchall()
                    blocked=any(
                        (not batch or prior.get('node_context',{}).get('batch_id')!=batch)
                        and (
                            not node_id
                            or not (prior_node_id:=prior.get('node_context',{}).get('node_id'))
                            or prior_node_id==node_id
                        )
                        for row in pending
                        for prior in (json.loads(row['request_json']),)
                    )
                    if blocked:
                        raise ValueError('当前节点存在未提交的任务，请先核对该任务记录')
            db.execute('INSERT OR IGNORE INTO tasks(id,project_id,operation_key,request_hash,status,request_json) VALUES (?,?,?,?,?,?)',(task_id,project_id,operation_key,request_hash,'prepared',request_json))
            row=db.execute('SELECT * FROM tasks WHERE project_id=? AND operation_key=?',(project_id,operation_key)).fetchone()
            if row is None or row['request_hash']!=request_hash: raise ValueError('操作编号已用于其他请求')
            task_id=row['id']
        return self.get_task(task_id)

    def get_task(self, task_id):
        with self._connect() as db: row=db.execute('SELECT id,project_id,status,result_asset_id,result_text,error_message,request_json,reviewed FROM tasks WHERE id=?',(task_id,)).fetchone()
        if row is None: raise ValueError('任务不存在')
        result=dict(row);result['request']=json.loads(result.pop('request_json'));result['reviewed']=bool(result['reviewed']);return result

    def list_tasks(self, project_id, limit=50, offset=0):
        self.get_project(project_id)
        with self._connect() as db:
            rows=db.execute('SELECT id,project_id,operation_key,status,result_asset_id,result_text,error_message,request_json,reviewed FROM tasks WHERE project_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?', (project_id,max(1,min(int(limit),200)),max(0,int(offset)))).fetchall()
        results=[]
        for row in rows:
            item=dict(row);item['request']=json.loads(item.pop('request_json'));item['reviewed']=bool(item['reviewed']);results.append(item)
        return results

    def task_by_operation(self, project_id, operation_key):
        with self._connect() as db:
            row=db.execute('SELECT id,project_id,status,result_asset_id,result_text,error_message,request_json,reviewed FROM tasks WHERE project_id=? AND operation_key=?',(project_id,operation_key)).fetchone()
        if row is None: raise ValueError('任务不存在')
        result=dict(row);result['request']=json.loads(result.pop('request_json'));result['reviewed']=bool(result['reviewed']);return result

    def acknowledge_unknown(self, project_id, operation_key):
        with self._connect() as db:
            changed=db.execute("UPDATE tasks SET reviewed=1 WHERE project_id=? AND operation_key=? AND status='unknown'",(project_id,operation_key)).rowcount
            if changed!=1: raise ValueError('只能核对状态不确定的任务')
        return self.task_by_operation(project_id,operation_key)

    def cancel_reservation(self, project_id, operation_key):
        with self._connect() as db:
            changed=db.execute("UPDATE tasks SET status='failed',error_message='任务尚未提交给服务商，已取消。' WHERE project_id=? AND operation_key=? AND status='prepared'",(project_id,operation_key)).rowcount
            if changed!=1: raise ValueError('任务已提交或不存在，不能取消预留')
        return self.task_by_operation(project_id,operation_key)

    def complete_task(self, task_id, asset_id):
        with self._connect() as db:
            result=db.execute("""UPDATE tasks SET status='complete',result_asset_id=?,error_message=NULL
                WHERE id=? AND status='submitted' AND EXISTS
                (SELECT 1 FROM assets WHERE assets.id=? AND assets.project_id=tasks.project_id)""",(asset_id,task_id,asset_id))
            if result.rowcount!=1: raise ValueError('结果图片与任务不匹配或任务状态已变化')
        return self.get_task(task_id)

    def complete_text_task(self, task_id, result_text):
        if not isinstance(result_text,str) or not result_text.strip() or len(result_text)>100_000: raise ValueError('文本结果无效')
        with self._connect() as db:
            changed=db.execute("UPDATE tasks SET status='complete',result_text=?,error_message=NULL WHERE id=? AND status='submitted'",(result_text,task_id)).rowcount
            if changed!=1: raise ValueError('任务不存在或状态已变化')
        return self.get_task(task_id)

    def claim_task(self, task_id, *, expected_revision=None):
        with self._connect() as db:
            if expected_revision is None:
                return db.execute("UPDATE tasks SET status='submitted' WHERE id=? AND status='prepared'",(task_id,)).rowcount==1
            db.execute('BEGIN IMMEDIATE')
            claimed=db.execute("""UPDATE tasks SET status='submitted' WHERE id=? AND status='prepared'
                AND EXISTS(SELECT 1 FROM projects WHERE projects.id=tasks.project_id AND projects.format='node-v1' AND projects.archived=0 AND projects.revision=?)""",(task_id,expected_revision)).rowcount==1
            if not claimed:
                db.execute("UPDATE tasks SET status='failed',error_message='画布内容已更改；旧任务未提交。请保存后重新生成。' WHERE id=? AND status='prepared'",(task_id,))
            return claimed

    def mark_task(self, task_id, status, *, error_message=None):
        if status not in {'failed','unknown'}: raise ValueError('任务状态无效')
        if error_message is not None and (not isinstance(error_message,str) or len(error_message)>1000): raise ValueError('任务错误说明无效')
        with self._connect() as db:
            result=db.execute("UPDATE tasks SET status=?,error_message=? WHERE id=? AND status='submitted'",(status,error_message,task_id))
            if result.rowcount!=1: raise ValueError('任务不存在或状态已变化')
        return self.get_task(task_id)

    def recover_pending(self):
        with self._connect() as db:
            rows=db.execute("SELECT id,project_id FROM tasks WHERE status IN ('prepared','submitted','unknown')").fetchall()
        recovered=0
        for row in rows:
            with self.task_lease(row['id']) as acquired:
                if not acquired: continue
                with self._connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    current=db.execute('SELECT status,error_message FROM tasks WHERE id=?',(row['id'],)).fetchone()
                    if not current or current['status'] not in {'prepared','submitted','unknown'}: continue
                    asset_id='result-'+row['id'];path=self.assets/asset_id
                    temporary=self.assets/(asset_id+'.tmp')
                    candidate=path if path.is_file() else temporary
                    valid=False
                    if candidate.is_file() and current['status']!='prepared':
                        try:
                            size=candidate.stat().st_size
                            if 0<size<=self.max_asset_bytes:
                                with Image.open(candidate) as image:
                                    if image.format in {'PNG','JPEG','WEBP'} and image.width*image.height<=40_000_000:
                                        image.verify();valid=True
                        except (OSError, UnidentifiedImageError, Image.DecompressionBombError):
                            pass
                    if valid:
                        if candidate != path: os.replace(candidate,path)
                        db.execute('INSERT OR IGNORE INTO assets VALUES (?,?,?,?)',(asset_id,row['project_id'],asset_id,size))
                        db.execute("UPDATE tasks SET status='complete',result_asset_id=?,error_message=NULL WHERE id=?",(asset_id,row['id']))
                    elif current['status']=='submitted':
                        recovered+=db.execute("UPDATE tasks SET status='unknown',error_message=COALESCE(error_message,?) WHERE id=?",('应用恢复时未收到服务商最终回执；请核对服务商任务记录，再决定是否重新生成。',row['id'])).rowcount
                    elif current['status']=='prepared':
                        recovered+=db.execute("UPDATE tasks SET status='failed',error_message=COALESCE(error_message,?) WHERE id=?",('任务尚未提交给服务商，可以重新生成。',row['id'])).rowcount
                    elif current['status']=='unknown' and not current['error_message']:
                        db.execute("UPDATE tasks SET error_message=? WHERE id=?",('服务商尚未返回最终结果；请核对服务商任务记录，再决定是否重新生成。',row['id']))
        return recovered
