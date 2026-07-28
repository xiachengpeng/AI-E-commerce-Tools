import base64
import io

import pytest
from PIL import Image, ImageDraw
from pydantic import ValidationError

from models.request import WatermarkRegion, WatermarkRemovalRequest
from services.watermark_removal_service import (
    decode_data_url,
    validate_mask,
)


def make_data_url(width=10, height=10):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def make_mask_url(regions, width=10, height=10):
    buffer = io.BytesIO()
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    for x, y, region_width, region_height in regions:
        draw.rectangle(
            (x, y, x + region_width - 1, y + region_height - 1),
            fill=255,
        )
    mask.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def test_request_rejects_empty_regions():
    with pytest.raises(ValidationError, match="至少框选一个"):
        WatermarkRemovalRequest(
            filename="sample.png",
            image_data=make_data_url(),
            mask_data=make_mask_url([(1, 1, 3, 3)]),
            regions=[],
        )


@pytest.mark.parametrize("region", [
    {"x": -0.1, "y": 0, "width": 0.2, "height": 0.2},
    {"x": 0, "y": 0, "width": 0, "height": 0.2},
    {"x": 0.9, "y": 0, "width": 0.2, "height": 0.2},
])
def test_request_rejects_invalid_region(region):
    with pytest.raises(ValidationError):
        WatermarkRegion(**region)


def test_validate_mask_rejects_size_mismatch():
    source = decode_data_url(make_data_url(10, 10))
    mask = decode_data_url(
        make_mask_url([(1, 1, 3, 3)], 8, 8),
        require_png=True,
    )
    with pytest.raises(ValueError, match="尺寸必须与原图一致"):
        validate_mask(
            source,
            mask,
            [WatermarkRegion(x=.1, y=.1, width=.3, height=.3)],
        )


def test_validate_mask_accepts_multiple_matching_regions():
    regions = [
        WatermarkRegion(x=.1, y=.1, width=.3, height=.3),
        WatermarkRegion(x=.6, y=.6, width=.2, height=.2),
    ]
    source = decode_data_url(make_data_url(10, 10))
    mask = decode_data_url(
        make_mask_url([(1, 1, 3, 3), (6, 6, 2, 2)]),
        require_png=True,
    )
    validate_mask(source, mask, regions)
