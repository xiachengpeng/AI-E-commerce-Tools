"""
集成测试 —— FastAPI /compare 端点 + URL 校验 + CORS
"""
import asyncio
import base64
import json
import os
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi.testclient import TestClient

from main import app
from main import (
    STATIC_DIR,
    align_comparison_winner,
    best_product_index_by_scores,
    build_consistent_recommendations,
    investment_score,
    normalize_input_url,
    normalize_ai_json_object,
)
from models.request import (
    AdCopyGenerateRequest,
    CompareRequest,
    ListingComplianceRequest,
    ListingGenerateRequest,
    ListingImageExtractRequest,
    TranslationRequest,
)
from services.ai_router import AIProviderRequestError, diagnose_provider_error

client = TestClient(app)


def test_normalize_ai_json_object_accepts_single_item_list():
    """AI 偶尔返回 [{...}] 时，后端应兼容为对象。"""
    result = normalize_ai_json_object([{"product_name": "Pool"}])
    assert result == {"product_name": "Pool"}


def test_normalize_ai_json_object_rejects_non_object_list():
    """非对象数组不应继续被当成产品对象处理。"""
    result = normalize_ai_json_object(["bad"])
    assert result == {}


def test_best_product_index_uses_opportunity_and_difficulty():
    """赢家规则：机会越高越好，难度越低越好。"""
    scores = [
        {"opportunity_score": 81, "difficulty_score": 50},
        {"opportunity_score": 52, "difficulty_score": 83},
    ]
    assert investment_score(scores[0]) == 131
    assert investment_score(scores[1]) == 69
    assert best_product_index_by_scores(scores) == 0


def test_align_comparison_winner_overrides_ai_contradiction():
    """横向分析若与评分卡矛盾，后端按确定性投资分校准 Winner。"""
    comp_result = {"winner_product": "庭院伞 ||| Patio Umbrella"}
    products = [
        {"product_name": "泳池 ||| Pool"},
        {"product_name": "庭院伞 ||| Patio Umbrella"},
    ]
    scores = [
        {"opportunity_score": 81, "difficulty_score": 50},
        {"opportunity_score": 52, "difficulty_score": 83},
    ]

    result = align_comparison_winner(comp_result, products, scores)

    assert result["winner_product"] == "泳池 ||| Pool"


def test_build_consistent_recommendations_uses_score_winner():
    products = [
        {"product_name": "泳池 ||| Pool"},
        {"product_name": "庭院伞 ||| Patio Umbrella"},
    ]
    scores = [
        {
            "opportunity_score": 81,
            "difficulty_score": 50,
            "decision_details": {"reason": "社媒传播强 ||| Strong social media potential"},
        },
        {
            "opportunity_score": 52,
            "difficulty_score": 83,
            "decision_details": {"reason": "物流风险高 ||| High logistics risk"},
        },
    ]

    recommendations = build_consistent_recommendations(products, scores)

    assert recommendations[0]["action"].startswith("主推建议")
    assert "泳池" in recommendations[0]["content"]
    assert "庭院伞" in recommendations[1]["content"]


# ============================================================
# URL 校验
# ============================================================

def test_compare_empty_urls():
    """空 URL 列表 → 错误"""
    resp = client.post("/compare", json={"urls": []})
    assert resp.status_code == 200  # CompareResponse 总是 200
    assert resp.json()["status"] == "error"


def test_compare_invalid_url_format():
    """非法 URL 格式 → 校验拒绝"""
    resp = client.post("/compare", json={"urls": ["not-a-valid-url"]})
    data = resp.json()
    assert data["status"] == "error"
    assert "URL 格式无效" in data["message"]


def test_normalize_input_url_accepts_bare_domain():
    assert normalize_input_url("fineboo.com") == "https://fineboo.com"
    assert normalize_input_url("example.com/products/a") == "https://example.com/products/a"
    assert normalize_input_url("https://example.com") == "https://example.com"


def test_compare_url_too_long():
    """URL 超过长度限制 → 校验拒绝"""
    long_url = "https://example.com/" + "x" * 3000
    resp = client.post("/compare", json={"urls": [long_url]})
    data = resp.json()
    assert data["status"] == "error"
    assert "长度超过限制" in data["message"]


def test_compare_valid_url_accepted():
    """合法 URL 通过校验，不会被 URL 格式错误拒绝"""
    with patch("main.fetch_markdown", new=AsyncMock(side_effect=Exception("stop after validation"))):
        resp = client.post("/compare", json={"urls": ["https://example.com/product"]})
    data = resp.json()
    # 不管后续处理成功还是失败，都不应该是 URL 格式错误
    assert "URL 格式无效" not in data.get("message", "")
    assert "长度超过限制" not in data.get("message", "")


# ============================================================
# CORS
# ============================================================

def test_cors_headers():
    """CORS 中间件：返回 Access-Control-Allow-Origin"""
    resp = client.options(
        "/compare",
        headers={
            "Origin": "http://localhost:8080",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert resp.status_code in (200, 405)
    if "access-control-allow-origin" in resp.headers:
        assert resp.headers["access-control-allow-origin"] == "http://localhost:8080"


def test_static_asset_cors_headers():
    """静态图片给 html2canvas/fetch 跨端口读取时必须带 CORS 头。"""
    outputs_dir = os.path.join(STATIC_DIR, "outputs")
    os.makedirs(outputs_dir, exist_ok=True)
    file_path = os.path.join(outputs_dir, "cors-test.png")
    with open(file_path, "wb") as f:
        f.write(base64.b64decode("iVBORw0KGgo="))

    resp = client.get(
        "/static/outputs/cors-test.png",
        headers={"Origin": "http://localhost:8080"},
    )

    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == "http://localhost:8080"
    assert resp.headers["cross-origin-resource-policy"] == "cross-origin"
    assert resp.headers["cache-control"] == "no-store"


# ============================================================
# Config 端点
# ============================================================

def test_config_exposes_public_routes_without_secrets():
    """GET /config 只返回当前公共路由信息，不暴露连接配置。"""
    resp = client.get("/config")
    assert resp.status_code == 200
    data = resp.json()
    assert data["TEXT_ROUTE"]["capability"] == "text"
    assert data["IMAGE_ROUTE"]["capability"] == "image"
    assert set(data) == {
        "TEXT_ROUTE",
        "IMAGE_ROUTE",
        "CONCURRENCY_LIMIT",
        "STAGGER_DELAY",
    }
    assert set(data["TEXT_ROUTE"]) == {
        "capability",
        "name",
        "protocol",
        "model",
    }
    assert set(data["IMAGE_ROUTE"]) == {
        "capability",
        "name",
        "protocol",
        "model",
    }
    serialized = json.dumps(data).lower()
    assert "api_key" not in serialized
    assert "base_url" not in serialized
    assert "vertex_key_path" not in serialized


def test_config_represents_unconfigured_routes_without_internal_details():
    with patch("main.get_snapshot", side_effect=ValueError("secret path /tmp/key.json")):
        data = client.get("/config").json()

    assert data["TEXT_ROUTE"] == {
        "capability": "text",
        "name": None,
        "protocol": None,
        "model": None,
    }
    assert data["IMAGE_ROUTE"] == {
        "capability": "image",
        "name": None,
        "protocol": None,
        "model": None,
    }
    assert "secret" not in json.dumps(data).lower()
    assert "/tmp/key.json" not in json.dumps(data)


@pytest.mark.parametrize(
    ("model_class", "payload"),
    [
        (CompareRequest, {"urls": ["https://example.com"]}),
        (TranslationRequest, {"text": "你好"}),
        (ListingGenerateRequest, {
            "name": "吊灯",
            "points": "藤编",
            "platform": "Amazon",
            "region": "US Market",
        }),
        (ListingImageExtractRequest, {"image_data": "data:image/png;base64,YQ=="}),
        (ListingComplianceRequest, {"listing": {}}),
        (AdCopyGenerateRequest, {
            "image_data": "data:image/png;base64,YQ==",
            "platforms": ["facebook"],
            "region": "US Market",
        }),
    ],
)
def test_business_request_models_ignore_ai_provider(model_class, payload):
    request = model_class.model_validate({**payload, "ai_provider": "vertex"})

    assert "ai_provider" not in request.model_dump()


def test_ai_generate_endpoint_routes_by_capability_and_ignores_browser_routing():
    """POST /api/ai/generate 仅接受能力与 payload 作为路由输入"""
    result = {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}
    with patch("services.ai_service.AIService.generate_content",
               new=AsyncMock(return_value=result)) as mock_generate:
        payload = {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]}
        resp = client.post("/api/ai/generate", json={
            "capability": "image",
            "model": "gemini-test",
            "provider": "vertex",
            "api_key": "browser-secret",
            "payload": payload,
        })

    assert resp.status_code == 200
    assert resp.json() == result
    mock_generate.assert_awaited_once_with(
        payload=payload,
        capability="image",
    )


@pytest.mark.parametrize(
    ("capability", "message"),
    [
        ("text", "文本 AI 未配置，请前往设置页面配置"),
        ("image", "图片 AI 未配置，请前往设置页面配置"),
    ],
)
def test_ai_generate_endpoint_sanitizes_unconfigured_capability(
    capability,
    message,
):
    with patch(
        "services.ai_service.AIService.generate_content",
        new=AsyncMock(side_effect=ValueError("secret /tmp/provider-key.json")),
    ):
        resp = client.post("/api/ai/generate", json={
            "capability": capability,
            "payload": {},
        })

    assert resp.status_code == 409
    assert resp.json() == {"detail": message}
    serialized = json.dumps(resp.json()).lower()
    assert "secret" not in serialized
    assert "/tmp/provider-key.json" not in serialized


class _ProviderHTTPFailure(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code


@pytest.mark.parametrize(
    ("failure", "category", "expected_status", "expected_upstream"),
    [
        (
            _ProviderHTTPFailure(401, "api_key=browser-secret rejected"),
            "authentication",
            401,
            "api_key=[REDACTED]",
        ),
        (
            _ProviderHTTPFailure(404, "model missing"),
            "model_not_found",
            404,
            "model missing",
        ),
        (
            _ProviderHTTPFailure(429, "rate limit reached"),
            "rate_limit",
            429,
            "rate limit reached",
        ),
        (
            asyncio.TimeoutError("request timed out"),
            "timeout",
            504,
            "request timed out",
        ),
        (
            ValueError("unsupported response schema"),
            "protocol_incompatible",
            502,
            "unsupported response schema",
        ),
        (
            RuntimeError("upstream unavailable"),
            "upstream_failure",
            502,
            "upstream unavailable",
        ),
    ],
)
def test_provider_http_error_returns_sanitized_diagnostic(
    failure,
    category,
    expected_status,
    expected_upstream,
):
    diagnostic = diagnose_provider_error(failure)
    provider_error = AIProviderRequestError(category, diagnostic)
    safe_client = TestClient(app, raise_server_exceptions=False)

    with patch(
        "services.ai_service.AIService.generate_content",
        new=AsyncMock(side_effect=provider_error),
    ):
        response = safe_client.post(
            "/api/ai/generate",
            json={"capability": "text", "payload": {}},
        )

    assert response.status_code == expected_status
    detail = response.json()["detail"]
    assert detail["category"] == category
    assert detail["diagnostic"]["category"] == category
    assert detail["diagnostic"]["upstream_message"] == expected_upstream
    assert "browser-secret" not in response.text


@pytest.mark.parametrize("body", [{}, {"capability": "audio", "payload": {}}])
def test_ai_generate_endpoint_rejects_missing_or_invalid_capability(body):
    resp = client.post("/api/ai/generate", json=body)

    assert resp.status_code == 422
    assert resp.json()["detail"] == "capability 必须是 text 或 image"


def test_listing_generate_endpoint():
    result = {"title": {"target": "Lamp", "zh": "灯"}}
    with patch("main.generate_listing", new=AsyncMock(return_value=result)) as mock_generate:
        resp = client.post("/api/listing/generate", json={
            "name": "吊灯",
            "points": "藤编\n暖光",
            "platform": "Amazon",
            "region": "US Market",
        })

    assert resp.status_code == 200
    assert resp.json()["status"] == "success"
    assert resp.json()["data"]["title"]["target"] == "Lamp"
    mock_generate.assert_awaited_once()


def test_listing_generate_rejects_missing_required_fields():
    resp = client.post("/api/listing/generate", json={
        "name": "",
        "points": "",
        "platform": "Amazon",
        "region": "US Market",
    })

    assert resp.status_code == 200
    assert resp.json()["status"] == "error"


def test_listing_extract_endpoint():
    result = {"name": "吊灯", "points": "卖点1\n卖点2", "keywords": "吊灯, 藤编灯"}
    image = "data:image/png;base64,YWFhYQ=="
    with patch("main.extract_listing_inputs", new=AsyncMock(return_value=result)) as mock_extract:
        resp = client.post("/api/listing/extract", json={"image_data": image})

    assert resp.status_code == 200
    assert resp.json()["status"] == "success"
    assert resp.json()["data"]["name"] == "吊灯"
    assert resp.json()["data"]["keywords"] == "吊灯, 藤编灯"
    mock_extract.assert_awaited_once()


def test_listing_compliance_endpoint():
    result = {"overall_level": "low", "summary": "风险较低", "risks": [], "rewrite_suggestions": []}
    with patch("main.check_listing_compliance", new=AsyncMock(return_value=result)) as mock_check:
        resp = client.post("/api/listing/compliance", json={
            "listing": {"title": {"target": "Lamp", "zh": "灯"}},
            "platform": "Amazon",
            "region": "US Market",
        })

    assert resp.status_code == 200
    assert resp.json()["data"]["overall_level"] == "low"
    mock_check.assert_awaited_once()


def test_ads_generate_rejects_missing_platforms():
    image = "data:image/png;base64," + base64.b64encode(b"fake").decode()
    resp = client.post("/api/ads/generate", json={
        "image_data": image,
        "platforms": [],
        "region": "US Market",
        "target_language": "English",
    })

    assert resp.status_code == 422


def test_ads_generate_endpoint():
    image = "data:image/png;base64," + base64.b64encode(b"fake").decode()
    result = {"product": {"name": {"target": "Lamp", "zh": "灯"}}, "styles": []}

    with patch("main.generate_ad_copy", new=AsyncMock(return_value=result)) as mock_generate, \
         patch("main.persist_ads_history") as mock_persist:
        resp = client.post("/api/ads/generate", json={
            "image_data": image,
            "platforms": ["facebook", "google"],
            "region": "US Market",
            "target_language": "English",
        })

    assert resp.status_code == 200
    assert resp.json()["status"] == "success"
    assert resp.json()["data"]["product"]["name"]["target"] == "Lamp"
    mock_generate.assert_awaited_once()
    mock_persist.assert_called_once()


# ============================================================
# 方图重绘 API
# ============================================================

def make_route_image(width=10, height=20):
    import io
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("utf-8")


def clear_square_redraw_route_tables():
    from db import SessionLocal, SquareRedrawBatch, SquareRedrawItem

    db = SessionLocal()
    try:
        db.query(SquareRedrawItem).delete()
        db.query(SquareRedrawBatch).delete()
        db.commit()
    finally:
        db.close()


def test_square_redraw_create_rejects_empty_batch():
    resp = client.post("/api/square-redraw/batches", json={"images": []})
    assert resp.status_code in {200, 422}
    data = resp.json()
    assert data.get("status") == "error" or "detail" in data


def test_square_redraw_create_accepts_square_image():
    clear_square_redraw_route_tables()
    resp = client.post("/api/square-redraw/batches", json={
        "images": [{
            "filename": "square.png",
            "image_data": make_route_image(12, 12),
            "width": 12,
            "height": 12,
        }]
    })
    data = resp.json()
    assert data["status"] == "success"
    assert data["data"]["summary"]["skipped"] == 1


def test_square_redraw_delete_item_updates_batch():
    clear_square_redraw_route_tables()
    create_resp = client.post("/api/square-redraw/batches", json={
        "images": [{
            "filename": "square.png",
            "image_data": make_route_image(12, 12),
            "width": 12,
            "height": 12,
        }]
    })
    create_data = create_resp.json()
    batch_id = create_data["data"]["id"]
    item_id = create_data["data"]["items"][0]["id"]

    delete_resp = client.delete(f"/api/square-redraw/batches/{batch_id}/items/{item_id}")
    delete_data = delete_resp.json()

    assert delete_data["status"] == "success"
    assert delete_data["data"]["summary"]["total"] == 0


def test_square_redraw_process_item_runs_single_task():
    clear_square_redraw_route_tables()
    create_resp = client.post("/api/square-redraw/batches", json={
        "images": [{
            "filename": "portrait.png",
            "image_data": make_route_image(12, 24),
            "width": 12,
            "height": 24,
        }]
    })
    create_data = create_resp.json()
    batch_id = create_data["data"]["id"]
    item_id = create_data["data"]["items"][0]["id"]
    assert create_data["data"]["items"][0]["status"] == "queued"

    ai_response = {
        "candidates": [{
            "content": {
                "parts": [{
                    "inlineData": {
                        "mimeType": "image/png",
                        "data": make_route_image(2, 2).split(",", 1)[1],
                    }
                }]
            }
        }]
    }
    with patch("services.square_redraw_service.AIService.generate_content", new=AsyncMock(return_value=ai_response)):
        process_resp = client.post(f"/api/square-redraw/batches/{batch_id}/items/{item_id}/process")

    process_data = process_resp.json()
    assert process_data["status"] == "success"
    assert process_data["data"]["items"][0]["status"] == "done"
    assert process_data["data"]["items"][0]["output_url"]


def test_square_redraw_get_missing_batch_returns_error():
    resp = client.get("/api/square-redraw/batches/999999")
    data = resp.json()
    assert data["status"] == "error"


# ============================================================
# Log 端点
# ============================================================

def test_log_endpoint(monkeypatch):
    """POST /log 接收前端日志并写入结构化日志服务"""
    emit = MagicMock()
    monkeypatch.setattr("main.app_logs.emit", emit)

    resp = client.post(
        "/log",
        json={"level": "info", "message": "test log"},
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
    emit.assert_called_once_with(
        level="info",
        source="frontend",
        message="test log",
        capability=None,
        provider=None,
        model=None,
        duration_ms=None,
        retry=None,
    )


def test_initialize_ai_settings_imports_defaults_and_closes_session(
    monkeypatch,
):
    import main

    db = MagicMock()
    monkeypatch.setattr(main, "SessionLocal", MagicMock(return_value=db))
    import_defaults = MagicMock()
    monkeypatch.setattr(
        main,
        "import_env_defaults_if_empty",
        import_defaults,
        raising=False,
    )

    main.initialize_ai_settings()

    import_defaults.assert_called_once_with(db)
    db.close.assert_called_once_with()


def test_initialize_ai_settings_logs_unconfigured_repair_state(monkeypatch):
    import main

    db = MagicMock()
    db.query.return_value.first.return_value = None
    monkeypatch.setattr(main, "SessionLocal", MagicMock(return_value=db))
    monkeypatch.setattr(
        main,
        "import_env_defaults_if_empty",
        MagicMock(return_value=False),
    )
    emit = MagicMock()
    monkeypatch.setattr(main.app_logs, "emit", emit)

    main.initialize_ai_settings()

    emit.assert_called_once_with(
        level="warning",
        source="system",
        message="AI 尚未配置，可在设置中修复",
    )
    db.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_app_lifespan_closes_global_async_clients(monkeypatch):
    import main

    close_ai = AsyncMock()
    close_crawler = AsyncMock()
    monkeypatch.setattr(main, "close_adapters", close_ai)
    monkeypatch.setattr(main, "close_firecrawl_client", close_crawler)

    async with main.app_lifespan(main.app):
        pass

    close_ai.assert_awaited_once_with()
    close_crawler.assert_awaited_once_with()


def test_analysis_cache_key_changes_with_provider_incarnation(monkeypatch):
    import main
    from services.ai_config_service import ProviderSnapshot

    db = MagicMock()
    db.close = MagicMock()
    snapshots = [
        ProviderSnapshot(
            id=1,
            incarnation_id="first-incarnation",
            capability="text",
            name="First",
            protocol="gemini",
            base_url=None,
            api_key="key",
            vertex_project_id=None,
            vertex_location=None,
            vertex_key_path=None,
            model="model-a",
            timeout_seconds=30,
            max_retries=0,
            config_version=1,
        ),
        ProviderSnapshot(
            id=1,
            incarnation_id="second-incarnation",
            capability="text",
            name="Second",
            protocol="gemini",
            base_url=None,
            api_key="key",
            vertex_project_id=None,
            vertex_location=None,
            vertex_key_path=None,
            model="model-b",
            timeout_seconds=30,
            max_retries=0,
            config_version=1,
        ),
    ]
    monkeypatch.setattr(main, "SessionLocal", lambda: db)
    monkeypatch.setattr(main, "get_snapshot", MagicMock(side_effect=snapshots))

    first = main.analysis_cache_key(["https://example.com/product"])
    second = main.analysis_cache_key(["https://example.com/product"])

    assert first != second
    assert first.endswith("|text-route=1:first-incarnation:1")
    assert second.endswith("|text-route=1:second-incarnation:1")
    assert db.close.call_count == 2


# ============================================================
# 历史 API
# ============================================================

def test_history_list_empty():
    """GET /api/history/analysis 空数据库返回 []"""
    resp = client.get("/api/history/analysis")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_history_invalid_module():
    """GET /api/history/invalid → 空列表"""
    resp = client.get("/api/history/invalid")
    assert resp.status_code == 200
    assert resp.json() == []


def test_square_redraw_history_save_and_list():
    payload = {
        "batch_id": 123,
        "target_aspect_ratio": "1:1",
        "result": {
            "id": 123,
            "target_aspect_ratio": "1:1",
            "summary": {"done": 1, "skipped": 0, "failed": 0},
            "items": [{"filename": "image.png", "status": "done", "output_url": "/static/out.png"}],
        },
    }
    save_resp = client.post("/api/history/square-redraw", json=payload)
    assert save_resp.status_code == 200
    assert save_resp.json()["status"] == "success"

    list_resp = client.get("/api/history/square-redraw")
    data = list_resp.json()
    assert data
    saved = next(item for item in data if item["batch_id"] == 123)
    assert saved["target_aspect_ratio"] == "1:1"
    assert saved["result"]["summary"]["done"] == 1


def test_history_save_and_delete_emit_structured_events(monkeypatch):
    emit = MagicMock()
    monkeypatch.setattr("main.app_logs.emit", emit)

    saved = client.post(
        "/api/history/listing",
        json={
            "name": "private product name",
            "platform": "Amazon",
            "result": {"private": "response content"},
        },
    )
    history_id = saved.json()["id"]
    deleted = client.delete(f"/api/history/listing/{history_id}")

    assert saved.json()["status"] == "success"
    assert deleted.json()["status"] == "success"
    messages = [call.kwargs["message"] for call in emit.call_args_list]
    assert messages == ["历史记录保存成功", "历史记录删除成功"]
    assert all(call.kwargs["source"] == "history" for call in emit.call_args_list)
    rendered = repr(emit.call_args_list)
    assert "private product name" not in rendered
    assert "response content" not in rendered


def test_invalid_history_save_emits_failure(monkeypatch):
    emit = MagicMock()
    monkeypatch.setattr("main.app_logs.emit", emit)

    response = client.post(
        "/api/history/invalid",
        json={"image_data": "data:image/png;base64,PRIVATE"},
    )

    assert response.json()["status"] == "error"
    assert emit.call_args.kwargs["source"] == "history"
    assert emit.call_args.kwargs["message"] == "历史记录保存失败"
    assert "PRIVATE" not in repr(emit.call_args)


# ============================================================
# 翻译端点
# ============================================================

def test_translate_text_no_langs():
    """翻译端点：无目标语言 → 默认 English"""
    with patch("services.ai_service.AIService.translate_text_batch",
               new=AsyncMock(return_value={"English": "Hello"})) as mocked:
        resp = client.post("/api/translate-text", json={
            "text": "你好",
            "ai_provider": "vertex",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "success"
        assert data["translations"]["English"] == "Hello"
        mocked.assert_awaited_once_with(
            text="你好",
            target_langs=["English"],
        )


def test_translate_text_multi_lang():
    """翻译端点：多语言"""
    result = {"English": "Hello", "Japanese": "こんにちは"}
    with patch("services.ai_service.AIService.translate_text_batch",
               new=AsyncMock(return_value=result)):
        resp = client.post("/api/translate-text", json={
            "text": "你好",
            "target_langs": ["English", "Japanese"],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["translations"]["Japanese"] == "こんにちは"
