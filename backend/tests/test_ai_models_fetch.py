import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from backend.main import app
from backend.db import get_db, AIProviderConfig
from sqlalchemy.orm import Session


@pytest.fixture
def client():
    return TestClient(app)


def test_fetch_models_openai_compatible_draft(client):
    def mock_get(url, headers=None, timeout=None, **kwargs):
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = {
            "object": "list",
            "data": [
                {"id": "gpt-4o", "object": "model"},
                {"id": "gpt-4o-mini", "object": "model"},
                {"id": "claude-3-5-sonnet", "object": "model"},
                {"id": "dall-e-3", "object": "model"},
            ]
        }
        return resp

    with patch("httpx.AsyncClient.get", side_effect=mock_get):
        payload = {
            "protocol": "openai_compatible",
            "base_url": "https://api.openai-test.com/v1",
            "api_key": "sk-mock-key-12345",
        }
        res = client.post("/api/settings/ai/providers/models/fetch", json=payload)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "success"
        assert "gpt-4o" in data["models"]
        assert "dall-e-3" in data["models"]
        assert data["count"] == 4


def test_fetch_models_gemini_draft(client):
    def mock_get(url, headers=None, timeout=None, **kwargs):
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = {
            "models": [
                {"name": "models/gemini-2.5-pro", "displayName": "Gemini 2.5 Pro"},
                {"name": "models/gemini-2.5-flash", "displayName": "Gemini 2.5 Flash"},
                {"name": "models/imagen-3.0-generate-002", "displayName": "Imagen 3"},
            ]
        }
        return resp

    with patch("httpx.AsyncClient.get", side_effect=mock_get):
        payload = {
            "protocol": "gemini",
            "api_key": "AIzaSyMockKeyForGemini",
        }
        res = client.post("/api/settings/ai/providers/models/fetch", json=payload)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "success"
        assert "gemini-2.5-pro" in data["models"]
        assert "imagen-3.0-generate-002" in data["models"]
        assert data["count"] == 3


def test_fetch_models_with_saved_provider_id(client):
    # Create a provider first
    create_payload = {
        "name": "Fetch Test Provider",
        "protocol": "openai_compatible",
        "base_url": "https://api.saved-fetch.com/v1",
        "api_key": "sk-saved-secret-key",
        "text_model": "gpt-4o",
        "supports_text": 1,
        "supports_image": 0,
    }
    create_res = client.post("/api/settings/ai/providers", json=create_payload)
    assert create_res.status_code in (200, 201)
    provider_id = create_res.json()["id"]

    try:
        def mock_get(url, headers=None, timeout=None, **kwargs):
            # Assert authorization header uses the saved secret key
            auth = headers.get("Authorization", "") if headers else ""
            assert "sk-saved-secret-key" in auth
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {
                "data": [
                    {"id": "deepseek-chat"},
                    {"id": "deepseek-reasoner"},
                ]
            }
            return resp

        with patch("httpx.AsyncClient.get", side_effect=mock_get):
            # Pass only provider_id, no api_key or base_url in payload
            res = client.post(
                "/api/settings/ai/providers/models/fetch",
                json={"provider_id": provider_id}
            )
            assert res.status_code == 200
            data = res.json()
            assert data["status"] == "success"
            assert data["models"] == ["deepseek-chat", "deepseek-reasoner"]
            assert data["count"] == 2
    finally:
        # Cleanup
        client.delete(f"/api/settings/ai/providers/{provider_id}")


def test_fetch_models_upstream_error(client):
    def mock_get(url, headers=None, timeout=None, **kwargs):
        resp = MagicMock()
        resp.status_code = 401
        resp.text = "Unauthorized: Invalid API Key"
        return resp

    with patch("httpx.AsyncClient.get", side_effect=mock_get):
        payload = {
            "protocol": "openai_compatible",
            "base_url": "https://api.error-test.com/v1",
            "api_key": "sk-invalid",
        }
        res = client.post("/api/settings/ai/providers/models/fetch", json=payload)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "error"
        assert data["models"] == []
        assert data["count"] == 0
        assert "401" in data["message"] or "失败" in data["message"]


def test_fetch_models_vertex(client):
    mock_model1 = MagicMock()
    mock_model1.name = "publishers/google/models/gemini-2.5-flash"
    mock_model2 = MagicMock()
    mock_model2.name = "publishers/google/models/gemini-2.5-pro"
    mock_model3 = MagicMock()
    mock_model3.name = "publishers/google/models/gemini-3.1-flash-image"

    mock_client_instance = MagicMock()
    mock_client_instance.models.list.return_value = [mock_model1, mock_model2, mock_model3]

    with patch("google.genai.Client", return_value=mock_client_instance):
        payload = {
            "protocol": "vertex",
            "vertex_project_id": "test-project-123",
            "vertex_location": "us-central1",
        }
        res = client.post("/api/settings/ai/providers/models/fetch", json=payload)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "success"
        assert "gemini-2.5-flash" in data["models"]
        assert "gemini-2.5-pro" in data["models"]
        assert "gemini-3.1-flash-image" in data["models"]
        assert data["count"] == 3
