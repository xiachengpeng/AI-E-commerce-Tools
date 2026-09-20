import pytest
from unittest.mock import AsyncMock, patch
from main import process_single_url_deep, process_single_url


MALFORMED_AI_RESPONSE = """Here is the extracted product analysis for you:
```json
{
  "product_name": "Ergonomic Office Chair ||| 人体工学办公椅",
  "category": "Office Furniture ||| 办公家具",
  "price": "$199",
  "reviews_count": "1,250",
  "core_selling_points": [
    {"point": "Adjustable lumbar support ||| 自适应腰托", "confidence": "high"},
  ],
  "target_audience": ["Remote workers ||| 居家办公人群"],
  "strengths": "Great lumbar support ||| 优质腰托",
  "weaknesses": "Heavy packaging ||| 包装较重",
}
```
Feel free to ask if you need further adjustments!"""


@pytest.mark.asyncio
async def test_process_single_url_deep_handles_trailing_comma_and_fences():
    with patch("main._safe_fetch_markdown", new_callable=AsyncMock) as mock_fetch, \
         patch("main.clean_content", return_value="cleaned markdown content"), \
         patch("main.check_block", return_value=False), \
         patch("main.is_amazon", return_value=False), \
         patch("main.parse_general", return_value={"product_data": {"price": "$199"}}), \
         patch("main.analyze_single_deep", new_callable=AsyncMock) as mock_ai:

        mock_fetch.return_value = "# Product Info"
        mock_ai.return_value = MALFORMED_AI_RESPONSE

        # Before fix, json.loads() throws JSONDecodeError on trailing commas
        result = await process_single_url_deep("https://example.com/chair", mode="deep")

        assert result is not None
        assert "Ergonomic Office Chair" in result.get("product_name", "")
        assert len(result.get("core_selling_points", [])) == 1


@pytest.mark.asyncio
async def test_process_single_url_handles_trailing_comma_and_fences():
    with patch("main._safe_fetch_markdown", new_callable=AsyncMock) as mock_fetch, \
         patch("main.clean_content", return_value="cleaned markdown content"), \
         patch("main.check_block", return_value=False), \
         patch("main.is_amazon", return_value=False), \
         patch("main.parse_general", return_value={"product_data": {"price": "$199"}}), \
         patch("main.analyze_single_extract", new_callable=AsyncMock) as mock_ai:

        mock_fetch.return_value = "# Product Info"
        mock_ai.return_value = MALFORMED_AI_RESPONSE

        # Before fix, json.loads() throws JSONDecodeError on trailing commas
        result = await process_single_url("https://example.com/chair")

        assert result is not None
        assert "Ergonomic Office Chair" in result.get("product_name", "")
