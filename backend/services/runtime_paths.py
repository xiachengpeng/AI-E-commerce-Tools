"""Resource-independent writable roots; defaults preserve browser deployments."""
import os
from pathlib import Path


def static_root() -> Path:
    configured = os.environ.get('AI_ECOMMERCE_DATA_DIR')
    if configured:
        root = Path(configured).expanduser()
        if not root.is_absolute():
            raise ValueError('AI_ECOMMERCE_DATA_DIR must be absolute')
        return root / 'static'
    return Path(__file__).resolve().parents[1] / 'static'
