#!/usr/bin/env python3
"""Compatibility CLI wrapper around :mod:`rabbit_hole.scoring`."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, cast

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from rabbit_hole.config import MarketSettings
from rabbit_hole.domain.legacy import EvidenceTrust
from rabbit_hole.scoring import (
    AUDITED_EVIDENCE_FIELDS,
    EvaluationInput,
    EvaluationResult,
    EvidenceSnapshot,
    OrderEconomics,
)
from rabbit_hole.scoring import (
    evaluate as evaluate_input,
)

YES = {"yes", "true", "1"}
NO = {"no", "false", "0"}
UNKNOWN = {"unknown", "inferred"}


def _decimal(row: dict[str, str], field: str) -> Decimal | None:
    value = (row.get(field) or "").strip()
    if not value:
        return None
    try:
        return Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"字段 {field!r} 不是数字: {value!r}") from exc


def _int(row: dict[str, str], field: str) -> int | None:
    value = _decimal(row, field)
    return None if value is None else int(value)


def _text(row: dict[str, str], field: str) -> str | None:
    value = (row.get(field) or "").strip().lower()
    return value or None


def _bool(row: dict[str, str], field: str) -> bool | None:
    value = _text(row, field)
    if value is None or value in UNKNOWN:
        return None
    if value in YES:
        return True
    if value in NO:
        return False
    raise ValueError(f"字段 {field!r} 不是规范 boolean: {value!r}")


def _trust(row: dict[str, str], field: str) -> EvidenceTrust:
    value = _text(row, field)
    if value is None:
        return EvidenceTrust.UNKNOWN
    try:
        return EvidenceTrust(value)
    except ValueError as exc:
        raise ValueError(f"字段 {field!r} 不是有效证据 trust: {value!r}") from exc


def _audited_trust(
    row: dict[str, str], trust_field: str, source_field: str
) -> EvidenceTrust:
    trust = _trust(row, trust_field)
    source = (row.get(source_field) or "").strip()
    if trust is EvidenceTrust.VERIFIED and not source:
        return EvidenceTrust.UNKNOWN
    return trust


def _values(row: dict[str, str], field: str) -> tuple[str, ...] | None:
    value = (row.get(field) or "").strip()
    return (
        tuple(item.strip().lower() for item in value.split("|") if item.strip()) or None
    )


def _market(row: dict[str, str], config: dict[str, Any]) -> MarketSettings:
    code = (_text(row, "target_market") or config.get("default_market", "US")).upper()
    try:
        raw = config["markets"][code]
    except KeyError as exc:
        raise ValueError(f"未知目标市场 {code!r}") from exc
    values: dict[str, Any] = {
        "code": code,
        "currency": raw.get("currency", "USD"),
        "min_aov": raw.get("min_aov", raw.get("min_price_usd", 50)),
        "max_aov": raw.get("max_aov", raw.get("max_price_usd", 100)),
        "payment_percent": raw.get("payment_percent"),
        "payment_fixed": raw.get("payment_fixed"),
        "loss_reserve_percent": raw.get("loss_reserve_percent"),
    }
    override_trust = _trust(row, "payment_rate_trust")
    override_source = (row.get("payment_rate_source") or "").strip()
    if override_trust is EvidenceTrust.VERIFIED and override_source:
        for name in ("payment_percent", "payment_fixed", "loss_reserve_percent"):
            override = _decimal(row, name)
            if override is None:
                raise ValueError(f"字段 {name!r} 的 verified override 缺少值")
            values[name] = override
    return MarketSettings(**values)


def _input(row: dict[str, str], config: dict[str, Any]) -> EvaluationInput:
    cost_fields = (
        "goods_cost",
        "shipping",
        "packaging",
        "tax_and_duty",
        "acquisition_cost",
        "packed_weight_kg",
    )
    meta_fields = tuple(
        field
        for field in AUDITED_EVIDENCE_FIELDS
        if field
        not in {
            "unit_price",
            "expected_aov",
            "bundle_quantity",
            "goods_cost",
            "shipping",
            "packaging",
            "tax_and_duty",
            "acquisition_cost",
            "packed_weight_kg",
            "supplier_quote",
        }
    )
    order = OrderEconomics(
        unit_price=cast(Decimal, _decimal(row, "unit_price")),
        bundle_quantity=cast(int, _int(row, "bundle_quantity")),
        expected_aov=cast(Decimal, _decimal(row, "expected_aov")),
        goods_cost=_decimal(row, "goods_cost"),
        shipping=_decimal(row, "shipping"),
        packaging=_decimal(row, "packaging"),
        tax_and_duty=_decimal(row, "tax_and_duty"),
        acquisition_cost=_decimal(row, "acquisition_cost"),
        packed_weight_kg=_decimal(row, "packed_weight_kg"),
        supplier_quote_unit_cost=_decimal(row, "supplier_quote_unit_cost"),
        supplier_quote_bundle_cost=_decimal(row, "supplier_quote_bundle_cost"),
        supplier_quote_confirmed=_bool(row, "supplier_quote_confirmed"),
        supplier_quote_valid=_bool(row, "supplier_quote_valid"),
        supplier_quote_source=(row.get("supplier_quote_source") or None),
        supplier_quote_collected_at=datetime.fromisoformat(
            row["supplier_quote_collected_at"]
        )
        if row.get("supplier_quote_collected_at")
        else None,
        bundle_evidence_trust=_audited_trust(
            row, "bundle_evidence_trust", "bundle_evidence_source"
        ),
        bundle_justification=row.get("bundle_justification") or None,
        cost_trust={
            field: _audited_trust(row, f"{field}_trust", f"{field}_source")
            for field in cost_fields
        },
        order_trust={
            field: _audited_trust(row, f"{field}_trust", f"{field}_source")
            for field in ("unit_price", "expected_aov", "bundle_quantity")
        },
    )
    meta = EvidenceSnapshot(
        active_days=_int(row, "active_days"),
        verified_creatives=_int(row, "verified_creatives"),
        trend_12m=_text(row, "trend_12m"),
        trend_5y=_text(row, "trend_5y"),
        logistics_difficulty=_text(row, "logistics_difficulty"),
        compliance_risk=_text(row, "compliance_risk"),
        ip_risk=_text(row, "ip_risk"),
        creative_formats=_values(row, "creative_formats"),
        creative_scenarios=_values(row, "creative_scenarios"),
        creative_hooks=_values(row, "creative_hooks"),
        ugc_or_demo=_bool(row, "ugc_or_demo"),
        advertiser_count=_int(row, "advertiser_count"),
        search_truncated=_bool(row, "search_truncated"),
        query_coverage_verified=_bool(row, "query_coverage_verified"),
        brand_concentration=_text(row, "brand_concentration"),
        differentiation=_text(row, "differentiation"),
        certification_required=_bool(row, "certification_required"),
        certification_verified=_bool(row, "certification_verified"),
        trust={
            field: _audited_trust(row, f"{field}_trust", f"{field}_source")
            for field in meta_fields
        },
        supplier_quote_trust=_audited_trust(
            row, "supplier_quote_trust", "supplier_quote_source"
        ),
    )
    return EvaluationInput(
        product_name=(row.get("name") or "").strip() or None,
        market=_market(row, config),
        order=order,
        meta=meta,
    )


@dataclass(frozen=True)
class Evaluation:
    row: dict[str, str]
    result: EvaluationResult

    @property
    def margin_pct(self) -> Decimal | None:
        return self.result.margin.margin_percent if self.result.margin else None

    @property
    def hard_gate_failures(self) -> tuple[str, ...]:
        return self.result.hard_gate_failures

    @property
    def scores(self) -> dict[str, int]:
        return self.result.scores

    @property
    def total(self) -> int | None:
        return self.result.total

    @property
    def bucket(self) -> str:
        return self.result.suggestion or self.result.status


def evaluate(row: dict[str, str], config: dict[str, Any]) -> Evaluation:
    return Evaluation(dict(row), evaluate_input(_input(row, config)))


def render(evaluations: list[Evaluation], source: Path) -> str:
    lines = [
        "# 兔子洞选品评估报告",
        "",
        f"数据源：`{source.name}`　候选品：{len(evaluations)} 个",
        "",
        "| 产品 | 市场 | 贡献毛利率 | 总分 | 系统建议 | 状态 |",
        "|---|---|---:|---:|---|---|",
    ]
    for item in sorted(
        evaluations, key=lambda x: (bool(x.hard_gate_failures), -(x.total or 0))
    ):
        margin_text = "未知" if item.margin_pct is None else f"{item.margin_pct:.1f}%"
        score_text = "未评分" if item.total is None else f"{item.total}/25"
        lines.append(
            f"| {item.row.get('name') or '未命名'} | {(item.row.get('target_market') or 'US').upper()} | {margin_text} | {score_text} | {item.bucket} | {item.result.status} |"
        )
    for item in evaluations:
        name = item.row.get("name") or "未命名"
        lines.extend(
            [
                "",
                f"## {name}",
                "",
                f"系统建议：**{item.bucket}**",
                f"状态：{item.result.status}",
                "",
            ]
        )
        if item.result.missing_fields:
            lines.append("待补充字段：" + "、".join(item.result.missing_fields))
        elif item.hard_gate_failures:
            lines.append("硬门槛失败：")
            lines.extend(f"- {failure}" for failure in item.hard_gate_failures)
        else:
            lines.append("硬门槛：全部通过。")
        if item.scores:
            lines.extend(
                [
                    "",
                    "评分："
                    + "；".join(
                        f"{key} {value}/5" for key, value in item.scores.items()
                    ),
                ]
            )
        urls = [
            url.strip()
            for url in (item.row.get("evidence_urls") or "").split("|")
            if url.strip()
        ]
        if urls:
            lines.extend(["", "证据：", *[f"- {url}" for url in urls]])
        notes = (item.row.get("notes") or "").strip()
        if notes:
            lines.extend(["", f"备注：{notes}"])
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="兔子洞选品 SOP 自动评分")
    parser.add_argument("input", type=Path, help="候选品 CSV")
    parser.add_argument(
        "--config", type=Path, default=Path(__file__).with_name("config.json")
    )
    parser.add_argument("--output", type=Path, default=Path("report.md"))
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    with args.input.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        raise SystemExit("CSV 中没有候选品")
    evaluations = [evaluate(row, config) for row in rows]
    args.output.write_text(render(evaluations, args.input), encoding="utf-8")
    print(f"已评估 {len(evaluations)} 个候选品，报告已写入 {args.output}")


if __name__ == "__main__":
    main()
