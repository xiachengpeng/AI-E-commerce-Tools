import base64
from io import BytesIO
from unittest.mock import AsyncMock, MagicMock

import pytest
from PIL import Image

from services.ai_adapters import (
    OpenAICompatibleAdapter,
    extract_validated_inline_images,
)
from services.ai_config_service import ProviderSnapshot
from services.image_validation import (
    ValidatedImage,
    validate_image_payload,
)


def _make_tiny_image(fmt: str) -> tuple[bytes, str]:
    buf = BytesIO()
    img = Image.new("RGB", (2, 2), color="red")
    img.save(buf, format=fmt)
    data = buf.getvalue()
    b64 = base64.b64encode(data).decode("ascii")
    return data, b64


JPEG_BYTES, JPEG_BASE64 = _make_tiny_image("JPEG")
PNG_BYTES, PNG_BASE64 = _make_tiny_image("PNG")
WEBP_BYTES, WEBP_BASE64 = _make_tiny_image("WEBP")


def test_validate_image_payload_strict_mime_rejects_mismatch():
    # Strict mode (default) rejects mismatch
    with pytest.raises(ValueError, match="图片 MIME 类型与内容不一致"):
        validate_image_payload(JPEG_BYTES, "image/png", strict_mime=True)


def test_validate_image_payload_non_strict_corrects_mime_type():
    # Non-strict mode accepts valid image and corrects mime_type to actual format
    validated = validate_image_payload(JPEG_BYTES, "image/png", strict_mime=False)
    assert isinstance(validated, ValidatedImage)
    assert validated.image_format == "JPEG"
    assert validated.mime_type == "image/jpeg"

    # Also accepts application/octet-stream
    validated_stream = validate_image_payload(
        PNG_BYTES, "application/octet-stream", strict_mime=False
    )
    assert validated_stream.image_format == "PNG"
    assert validated_stream.mime_type == "image/png"

    # Also handles WebP
    validated_webp = validate_image_payload(
        WEBP_BYTES, "image/jpeg", strict_mime=False
    )
    assert validated_webp.image_format == "WEBP"
    assert validated_webp.mime_type == "image/webp"


def test_extract_validated_inline_images_tolerates_mismatched_declared_mime():
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": "Ref image"},
                    # User uploaded a JPEG but browser labeled it image/png
                    {"inlineData": {"mimeType": "image/png", "data": JPEG_BASE64}},
                ]
            }
        ]
    }
    images = extract_validated_inline_images(payload)
    assert len(images) == 1
    assert images[0].image_format == "JPEG"
    assert images[0].mime_type == "image/jpeg"


@pytest.mark.asyncio
async def test_openai_image_to_image_accepts_mismatched_inline_reference():
    response = MagicMock()
    response.json.return_value = {"data": [{"b64_json": PNG_BASE64}]}
    transport = MagicMock()
    transport.post = AsyncMock(return_value=response)
    adapter = OpenAICompatibleAdapter(client=transport)

    snapshot = ProviderSnapshot(
        id=99,
        name="Test",
        protocol="openai_compatible",
        base_url="https://api.example.com",
        api_key="sk-test",
        vertex_project_id=None,
        vertex_location=None,
        vertex_key_path=None,
        model="gpt-image-2",
        capability="image",
        timeout_seconds=30,
        max_retries=0,
        config_version=1,
        incarnation_id=1,
        image_generation_mode="image_to_image",
    )

    # Reference image has declared mimeType image/png, but content is JPEG!
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": "Create detail section"},
                    {"inlineData": {"mimeType": "image/png", "data": JPEG_BASE64}},
                ]
            }
        ]
    }

    result = await adapter.generate(snapshot, payload)
    assert result["candidates"][0]["content"]["parts"][0]["inlineData"]["data"] == PNG_BASE64

    # Verify that the multipart file sent upstream used the actual JPEG format and mime
    files = transport.post.await_args.kwargs["files"]
    assert len(files) == 1
    field_name, (filename, file_data, file_mime) = files[0]
    assert field_name == "image"
    assert filename.endswith(".jpg")
    assert file_mime == "image/jpeg"
    assert file_data == JPEG_BYTES
