from fastapi.testclient import TestClient
from main import app
from db import init_db, SessionLocal, AIProviderConfig, FirecrawlConfig, StorageConfig

from routes.research import _session_token
client = TestClient(app, client=('127.0.0.1', 50000), base_url='http://127.0.0.1:9503', headers={'X-Research-Token': _session_token, 'Origin': 'http://127.0.0.1:9502'})


def test_reveal_provider_secret():
    init_db()
    db = SessionLocal()
    try:
        provider = AIProviderConfig(
            name="Reveal Test Provider",
            protocol="openai_compatible",
            base_url="https://api.example.com/v1",
            api_key="sk-live-super-secret-123456",
            balance_access_token="tok-balance-9999",
            balance_custom_key="cust-key-8888",
            supports_text=True,
            supports_image=False,
            text_model="gpt-4o",
            enabled=True,
        )
        db.add(provider)
        db.commit()
        db.refresh(provider)
        provider_id = provider.id

        # 1. Reveal API Key
        resp = client.post("/api/settings/secrets/reveal", json={
            "category": "ai_provider",
            "field": "api_key",
            "id": provider_id,
        })
        assert resp.status_code == 200
        assert resp.json()["status"] == "success"
        assert resp.json()["secret"] == "sk-live-super-secret-123456"

        # 2. Reveal Balance Access Token
        resp = client.post("/api/settings/secrets/reveal", json={
            "category": "ai_provider",
            "field": "balance_access_token",
            "id": provider_id,
        })
        assert resp.status_code == 200
        assert resp.json()["status"] == "success"
        assert resp.json()["secret"] == "tok-balance-9999"

        # 3. Reveal Usage Query Custom Key
        resp = client.post("/api/settings/secrets/reveal", json={
            "category": "usage_query",
            "field": "balance_custom_key",
            "id": provider_id,
        })
        assert resp.status_code == 200
        assert resp.json()["status"] == "success"
        assert resp.json()["secret"] == "cust-key-8888"

        # 4. Forbidden field
        resp = client.post("/api/settings/secrets/reveal", json={
            "category": "ai_provider",
            "field": "non_existent_field",
            "id": provider_id,
        })
        assert resp.status_code == 200
        assert resp.json()["status"] == "forbidden"

        # 5. Non-existent provider
        resp = client.post("/api/settings/secrets/reveal", json={
            "category": "ai_provider",
            "field": "api_key",
            "id": 99999999,
        })
        assert resp.status_code == 200
        assert resp.json()["status"] == "not_found"

    finally:
        db.close()


def test_reveal_crawler_and_storage_secrets():
    init_db()
    db = SessionLocal()
    try:
        # Crawler secret
        crawler = db.query(FirecrawlConfig).first()
        if not crawler:
            crawler = FirecrawlConfig(api_key="fc-test-key-0000")
            db.add(crawler)
        else:
            crawler.api_key = "fc-test-key-0000"
        db.commit()

        resp = client.post("/api/settings/secrets/reveal", json={
            "category": "crawler",
            "field": "api_key",
        })
        assert resp.status_code == 200
        assert resp.json()["status"] == "success"
        assert resp.json()["secret"] == "fc-test-key-0000"

        # Storage secret
        storage = StorageConfig(
            storage_type="r2",
            name="R2 Test Store",
            r2_secret_access_key="r2-super-secret-key-1111",
            r2_account_id="acc123",
            r2_access_key_id="key123",
            r2_bucket_name="bkt",
        )
        db.add(storage)
        db.commit()
        db.refresh(storage)
        storage_id = storage.id

        resp = client.post("/api/settings/secrets/reveal", json={
            "category": "storage",
            "field": "r2_secret_key",
            "id": storage_id,
        })
        assert resp.status_code == 200
        assert resp.json()["status"] == "success"
        assert resp.json()["secret"] == "r2-super-secret-key-1111"

    finally:
        db.close()


def test_reveal_requires_local_session_and_cannot_be_cached():
    anonymous=TestClient(app,client=('127.0.0.1',50000),base_url='http://127.0.0.1:9503')
    payload={'category':'crawler','field':'api_key'}
    assert anonymous.post('/api/settings/secrets/reveal',json=payload).status_code==401
    assert client.post('/api/settings/secrets/reveal',headers={'Origin':'https://evil.invalid'},json=payload).status_code==403
    assert client.post('/api/settings/secrets/reveal',json=payload).headers['cache-control']=='no-store'
