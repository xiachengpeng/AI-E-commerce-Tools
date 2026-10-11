"""Human-owned marketing facts, independent from competitor claims and scores."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import uuid4

KEYS = frozenset(
    {"product_name", "category", "material", "dimensions", "features", "warranty"}
)


def confirm_marketing_fact(
    state: dict[str, Any], payload: dict[str, Any], actor: str, now: datetime
) -> None:
    from rabbit_hole.domain.project import WorkbenchError, _find, _url

    if actor != "local_user" or payload.get("own_product") is not True:
        raise WorkbenchError(
            "human_confirmation_required", "请人工核实这是自有产品的事实"
        )
    product = _find(state["products"], payload.get("product_id"), "product")
    identity = product.get("identity_revision", 1)
    if (
        type(payload.get("identity_revision")) is not int
        or payload["identity_revision"] != identity
        or payload.get("market") != state["market"]
    ):
        raise WorkbenchError("version_conflict", "商品身份或研究国家已更新", 409)
    key, value = payload.get("key"), payload.get("value")
    if (
        not isinstance(key, str)
        or key not in KEYS
        or not isinstance(value, str)
        or not value.strip()
        or len(value) > 2000
    ):
        raise WorkbenchError(
            "invalid_fact", "请选择事实字段并填写不超过2000字的已核实内容"
        )
    reference = _url(payload.get("source_url"), "source_url", required=True)
    history = product.setdefault("marketing_facts", [])
    if len(history) >= 200:
        raise WorkbenchError("limit_reached", "事实核实记录达到上限")
    history.append(
        {
            "id": str(uuid4()),
            "key": key,
            "value": value.strip(),
            "source_url": reference,
            "own_product": True,
            "identity_revision": identity,
            "market": state["market"],
            "provenance": "manual",
            "operator": actor,
            "confirmed_at": now.isoformat(),
        }
    )
