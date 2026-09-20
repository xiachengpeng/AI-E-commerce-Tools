import pytest
from unittest.mock import AsyncMock, MagicMock
from services.ai_adapters import OpenAICompatibleAdapter
from tests.test_ai_adapters import TINY_PNG_BASE64, TINY_PNG_BYTES, make_snapshot


@pytest.mark.asyncio
async def test_openai_image_edit_single_image_uses_standard_image_field():
    response = MagicMock()
    response.json.return_value = {"data": [{"b64_json": TINY_PNG_BASE64}]}
    transport = MagicMock()
    transport.post = AsyncMock(return_value=response)
    adapter = OpenAICompatibleAdapter(client=transport)

    await adapter.generate(
        make_snapshot(
            capability="image",
            image_generation_mode="image_to_image",
        ),
        {
            "contents": [
                {
                    "parts": [
                        {"text": "Modify hero image"},
                        {
                            "inlineData": {
                                "mimeType": "image/png",
                                "data": TINY_PNG_BASE64,
                            }
                        },
                    ]
                }
            ],
            "generationConfig": {
                "imageConfig": {
                    "aspectRatio": "1:1",
                }
            },
        },
    )

    request = transport.post.await_args
    assert request.args[0] == "https://api.example.com/v1/images/edits"
    # Single image must use standard RFC field name "image", not "image[]"
    assert len(request.kwargs["files"]) == 1
    field_name, file_tuple = request.kwargs["files"][0]
    assert field_name == "image", f"Expected 'image' field for single file, got {field_name}"
    assert file_tuple[0] == "reference-1.png"
    assert file_tuple[1] == TINY_PNG_BYTES
    assert file_tuple[2] == "image/png"
