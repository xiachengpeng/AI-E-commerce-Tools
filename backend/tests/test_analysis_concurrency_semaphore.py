import asyncio
import pytest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_multi_url_analysis_concurrency_limited_by_semaphore():
    urls = [f"https://www.example.com/product-{i}" for i in range(6)]
    active_count = 0
    max_active = 0

    async def mock_deep_process(u, *args, **kwargs):
        nonlocal active_count, max_active
        active_count += 1
        if active_count > max_active:
            max_active = active_count
        await asyncio.sleep(0.05)
        active_count -= 1
        return {
            "source_url": u,
            "product_name": f"Product for {u}",
            "core_selling_points": [{"point": "Test point"}],
            "price": "$99",
            "target_audience": "Pros",
            "strengths": ["Fast"],
            "weaknesses": ["None"],
        }

    fake_score = {
        "opportunity_score": 80,
        "difficulty_score": 40,
        "final_decision": "Buy",
        "decision_details": {"confidence": "medium", "reason": ""},
        "sub_scores": {"opportunity": {}, "difficulty": {}},
    }

    with patch("main.process_single_url_deep", side_effect=mock_deep_process), \
         patch("main.calculate_score", new=AsyncMock(return_value=fake_score)), \
         patch("main.compare_products", new=AsyncMock(return_value={"market_position": "ok", "recommendation_list": []})):

        res = client.post("/compare", json={"urls": urls})
        assert res.status_code == 200
        assert max_active <= 3, f"Expected concurrency <= 3, but observed {max_active}"
