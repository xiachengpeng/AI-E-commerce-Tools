"""Named competitor crawler accounts; legacy active row remains runtime authority.

Uses the existing JSON settings table, without a database migration. SQLite's
write reservation covers read/modify/write, including other app processes.
"""
import copy
import datetime
import os
import re
import uuid
from fastapi import HTTPException
from sqlalchemy import text
from db import AppSetting, FirecrawlConfig
from services.firecrawl import mask_secret, is_masked_or_empty
from services.security_utils import validate_outbound_url

CATALOG_KEY = 'competitor_firecrawl_profiles_v1'
DEFAULT_URL = 'https://api.firecrawl.dev/v1/scrape'


class CrawlerConfigService:
    def __init__(self, db): self.db = db

    def _load(self):
        row = self.db.get(AppSetting, CATALOG_KEY)
        cfg = self.db.query(FirecrawlConfig).first()
        legacy = dict(api_url=(cfg.api_url or DEFAULT_URL) if cfg else (os.getenv('FIRECRAWL_API_URL') or DEFAULT_URL),
                      api_key=(cfg.api_key or '') if cfg else (os.getenv('FIRECRAWL_API_KEY') or ''),
                      last_test_status=cfg.last_test_status if cfg else None,
                      last_test_message=cfg.last_test_message if cfg else None,
                      last_tested_at=cfg.last_tested_at.isoformat() if cfg and cfg.last_tested_at else None)
        if row:
            catalog = copy.deepcopy(row.value)
            if not isinstance(catalog, dict) or not catalog.get('profiles') or catalog.get('active') not in catalog['profiles']:
                raise HTTPException(503, '账号目录无法读取，请从备份恢复后重试')
            # Old app versions may have edited the active row. Keep it authoritative.
            active = catalog['profiles'][catalog['active']]
            if any(active.get(k) != legacy[k] for k in ('api_key','api_url')):
                active.update(legacy); active['version'] += 1; catalog['revision'] += 1
        else:
            catalog = dict(active='default', revision=1, profiles={'default':dict(name='原有账号',version=1,**legacy)})
        return catalog

    def _begin(self):
        self.db.rollback()
        self.db.execute(text('BEGIN IMMEDIATE'))
        self.db.expire_all()
        return self._load()

    def _profile(self, catalog, profile_id):
        profile_id = profile_id or catalog['active']
        if profile_id not in catalog['profiles']: raise HTTPException(404, '账号不存在，请重新读取')
        return profile_id, catalog['profiles'][profile_id]

    @staticmethod
    def _check(actual, expected):
        if expected is None or expected != actual: raise HTTPException(409, '账号配置已变化，请重新读取后再操作')

    def _store(self, catalog):
        row = self.db.get(AppSetting, CATALOG_KEY)
        if row: row.value = copy.deepcopy(catalog)
        else: self.db.add(AppSetting(key=CATALOG_KEY, value=copy.deepcopy(catalog)))
        active = catalog['profiles'][catalog['active']]
        cfg = self.db.query(FirecrawlConfig).first()
        if not cfg: cfg = FirecrawlConfig(); self.db.add(cfg)
        cfg.api_key = active.get('api_key') or ''
        cfg.api_url = active['api_url']
        cfg.last_test_status = active.get('last_test_status')
        cfg.last_test_message = active.get('last_test_message')
        cfg.last_tested_at = datetime.datetime.fromisoformat(active['last_tested_at']) if active.get('last_tested_at') else None
        self.db.commit()

    def read(self, profile_id=None):
        catalog = self._load()
        pid, profile = self._profile(catalog, profile_id)
        def public(p):
            return dict(api_url=p['api_url'], has_api_key=bool(p.get('api_key')), api_key_masked=mask_secret(p.get('api_key')),
                        **{k:p.get(k) for k in ('last_test_status','last_test_message','last_tested_at')})
        return dict(**public(profile), profile_id=pid, name=profile['name'], version=profile['version'],
                    active_profile_id=catalog['active'], active_version=catalog['revision'],
                    active_config=public(catalog['profiles'][catalog['active']]),
                    profiles=[dict(id=k,name=p['name'],version=p['version'],has_api_key=bool(p.get('api_key')),api_key_masked=mask_secret(p.get('api_key'))) for k,p in catalog['profiles'].items()])

    def save(self, profile_id, data, legacy=False):
        try:
            catalog = self._begin()
            if legacy: profile_id = catalog['active']
            creating = profile_id is None
            if creating:
                if len(catalog['profiles']) >= 20: raise HTTPException(400, '最多保存20个账号')
                profile_id = uuid.uuid4().hex
                profile = dict(name='',version=0,api_key='',api_url=DEFAULT_URL)
            else:
                _, profile = self._profile(catalog, profile_id)
                if not legacy: self._check(profile['version'], data.get('expected_version'))
            name = str(data.get('name',profile['name'])).strip()
            if not name or len(name)>60 or re.search(r'[\x00-\x1f\x7f]',name): raise HTTPException(400,'账号名称需为1至60个字符')
            if any(k != profile_id and p['name'].casefold() == name.casefold() for k,p in catalog['profiles'].items()): raise HTTPException(409,'账号名称已存在')
            url = (data.get('api_url') or profile['api_url']).strip()
            safe, _ = validate_outbound_url(url, allow_local=True, require_http=True)
            if not safe: raise HTTPException(400,'非法的爬虫服务器地址')
            old_credentials = (profile['api_url'], profile.get('api_key') or '')
            key = data.get('api_key')
            if key is not None:
                key = key.strip()
                if len(key)>2048 or re.search(r'\s',key): raise HTTPException(400,'密钥格式不正确')
                if key and not is_masked_or_empty(key): profile['api_key'] = key
            changed = creating or old_credentials != (url, profile.get('api_key') or '')
            profile.update(name=name,api_url=url,version=profile['version']+1)
            if changed:
                profile.update(last_test_status=None,last_test_message=None,last_tested_at=None)
            catalog['profiles'][profile_id]=profile; catalog['revision']+=1
            self._store(catalog)
            return self.read(profile_id)
        except Exception:
            self.db.rollback(); raise

    def activate(self, profile_id, expected_version, expected_active_version):
        try:
            catalog=self._begin(); _,profile=self._profile(catalog,profile_id)
            self._check(profile['version'],expected_version); self._check(catalog['revision'],expected_active_version)
            if not profile.get('api_key') and 'api.firecrawl.dev' in profile['api_url'].lower(): raise HTTPException(400,'请先保存此账号的 API Key')
            catalog['active']=profile_id; catalog['revision']+=1; self._store(catalog)
            return self.read(profile_id)
        except Exception:
            self.db.rollback(); raise

    def credentials(self, profile_id=None, expected_version=None):
        catalog=self._load(); _,profile=self._profile(catalog,profile_id)
        if profile_id: self._check(profile['version'],expected_version)
        return profile['api_url'], profile.get('api_key') or ''

    def record_test(self, profile_id, expected_version, credentials, success, duration, message):
        try:
            catalog=self._begin(); _,profile=self._profile(catalog,profile_id)
            if profile['version'] != expected_version or (profile['api_url'],profile.get('api_key') or '') != credentials:
                self.db.rollback(); return False
            profile.update(last_test_status='success' if success else 'error', last_test_message=f'{message}（{duration} ms）',last_tested_at=datetime.datetime.now().isoformat())
            self._store(catalog); return True
        except Exception:
            self.db.rollback(); raise
