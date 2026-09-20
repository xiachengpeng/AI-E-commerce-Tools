import pytest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

from main import app
from models.request import ScoreCard

client = TestClient(app)


def test_single_url_analysis_pipeline_eliminates_redundant_extract():
    test_url = "https://www.amazon.com/dp/B0EXAMPLE1"
    fake_markdown = "# Test Product Markdown"
    fake_deep_data = {
        "product_name": "Ergonomic Office Chair ||| 人体工学办公椅",
        "core_selling_points": [{"point": "Lumbar support"}],
        "target_audience": "Office workers",
        "pricing_strategy": "$199",
        "user_pain_points": [{"pain": "Back pain"}],
        "differentiation_opportunities": [{"opportunity": "Mesh back"}],
    }
    fake_score_data = {
        "product": "Ergonomic Office Chair",
        "opportunity_score": 88,
        "difficulty_score": 35,
        "final_decision": "Strong Buy ||| 强烈建议",
        "decision_details": {"confidence": "high", "reason": "High demand"},
        "sub_scores": {"opportunity": {}, "difficulty": {}},
    }

    with patch("main._safe_fetch_markdown", new=AsyncMock(return_value=fake_markdown)), \
         patch("main.process_single_url", new=AsyncMock()) as mock_basic, \
         patch("main.process_single_url_deep", new=AsyncMock(return_value=fake_deep_data)) as mock_deep, \
         patch("main.calculate_score", new=AsyncMock(return_value=fake_score_data)) as mock_score:

        response = client.post("/compare", json={"urls": [test_url]})

        assert response.status_code == 200
        res_json = response.json()
        assert res_json["status"] == "success"
        data = res_json["data"]

        # 1. 深度单品数据存在且完整
        assert data["single_data"]["product_name"] == fake_deep_data["product_name"]

        # 2. 评分基于单品数据计算
        assert len(data["scores"]) == 1
        assert data["scores"][0]["opportunity_score"] == 88

        # 3. URL 状态正常标记
        assert len(data["url_statuses"]) == 1
        assert data["url_statuses"][0]["status"] == "success"
        assert data["url_statuses"][0]["product_name"] == fake_deep_data["product_name"]

        # 4. 关键验证：多余的浅层提取 process_single_url 绝不应被调用！
        assert mock_basic.called is False, "process_single_url should NOT be called in single-URL mode"
        # 且 process_single_url_deep 与 calculate_score 各被调用 1 次
        assert mock_deep.await_count == 1
        assert mock_score.await_count == 1
