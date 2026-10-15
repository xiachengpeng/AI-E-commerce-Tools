"""Feishu Base boundary.

This module deliberately keeps Feishu's mutable UI schema behind a small,
declarative adapter.  The field type strings and API paths below were verified
against the installed ``lark-base`` skill (v1.2.2): fields use the current
``text``/``number``/``select``/``datetime``/``link``/``formula``/``checkbox``
constants and records use Base v3 list/get/create/PATCH operations.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
import time
from collections.abc import Callable, Coroutine, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from functools import wraps
from typing import Any, Concatenate, Protocol

import httpx

from rabbit_hole.domain.legacy import BusinessStatus, JobKind, JobPayload
from rabbit_hole.input_urls import canonical_supplier_inputs
from rabbit_hole.persistence.legacy_jobs import AdmissionLimitReached, EnqueueReceipt

API_ROOT = "https://open.feishu.cn/open-apis"
API_TENANT_TOKEN = f"{API_ROOT}/auth/v3/tenant_access_token/internal"
API_TABLE_LIST = f"{API_ROOT}/base/v3/bases/{{base_token}}/tables"
API_FIELD_LIST = f"{API_ROOT}/base/v3/bases/{{base_token}}/tables/{{table_id}}/fields"
API_FIELD_UPDATE = API_FIELD_LIST + "/{field_id}"
API_RECORD_LIST = f"{API_ROOT}/base/v3/bases/{{base_token}}/tables/{{table_id}}/records"
API_RECORD_BATCH_GET = API_RECORD_LIST + "/batch_get"
API_RECORD_GET = API_RECORD_BATCH_GET  # compatibility alias: v3 reads use batch_get
API_VIEW_LIST = f"{API_ROOT}/base/v3/bases/{{base_token}}/tables/{{table_id}}/views"
API_VIEW_UPDATE = API_VIEW_LIST + "/{view_id}"
API_VIEW_FILTER = API_VIEW_UPDATE + "/filter"

# Confirmed Lark Base Field JSON type constants (lark-base v1.2.2 reference).
FEISHU_FIELD_TYPES = frozenset(
    {"text", "number", "select", "datetime", "link", "formula", "checkbox"}
)
# Confirmed Base v3 operations (lark-base record-upsert reference).
FEISHU_RECORD_OPERATIONS = {
    "list": "GET /base/v3/bases/:base_token/tables/:table_id/records",
    "get": "POST /base/v3/bases/:base_token/tables/:table_id/records/batch_get",
    "create": "POST /base/v3/bases/:base_token/tables/:table_id/records",
    "update": "PATCH /base/v3/bases/:base_token/tables/:table_id/records/:record_id",
}
AUTO_FIELD_PREFIX = "AUTO｜"
HUMAN_FIELD_PREFIX = "人工｜"
DEFAULT_TIMEOUT_SECONDS = 10.0

type Json = dict[str, Any]


_PROTECTED_INPUT_KEYS = frozenset(
    {
        "link",
        "url",
        "meta_url",
        "landing_url",
        "query",
        "market",
        "product_name",
        "expected_order",
        "bundle_quantity",
        "price",
        "aov",
        "goods_cost",
        "shipping_cost",
        "packaging_cost",
        "tax_cost",
        "ad_cost",
        "payment_rate",
        "payment_fixed",
        "loss_reserve_rate",
        "weight",
        "trend_classification",
        "logistics_risk",
        "compliance_risk",
        "ip_risk",
        "supplier_quote_unit_cost",
        "supplier_quote_bundle_cost",
        "supplier_quote_confirmed",
        "supplier_quote_valid",
        "supplier_quote_trust",
        "supplier_quote_source",
        "evaluation",
    }
)


def protected_input_hash(fields: Mapping[str, Any]) -> str:
    """Hash only user-owned workflow inputs, never automation output fields."""

    snapshot, _ = canonical_supplier_inputs(fields)
    protected = {
        str(name): value
        for name, value in snapshot.items()
        if str(name).startswith(HUMAN_FIELD_PREFIX)
        or str(name) in _PROTECTED_INPUT_KEYS
    }
    canonical = json.dumps(
        protected,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


class FeishuAPIError(RuntimeError):
    def __init__(self, status_code: int, body: Any) -> None:
        self.status_code = status_code
        self.body = body
        super().__init__(f"Feishu API request failed ({status_code}): {body}")


class WriteConflict(RuntimeError):
    """A human changed a protected input after the job snapshot."""


@dataclass(frozen=True, slots=True)
class FieldSchema:
    key: str
    display_name: str
    type: str
    owner: str = "auto"
    options: tuple[str, ...] = ()
    link_table: str | None = None
    expression: str | None = None
    style_type: str | None = None
    multiple: bool = False

    def __post_init__(self) -> None:
        if self.type not in FEISHU_FIELD_TYPES:
            raise ValueError(f"unsupported Feishu field type: {self.type}")
        prefix = AUTO_FIELD_PREFIX if self.owner == "auto" else HUMAN_FIELD_PREFIX
        if self.display_name.startswith(prefix) is False:
            raise ValueError(f"{self.key} must use the {prefix!r} ownership prefix")
        if self.type == "link" and self.link_table is None:
            raise ValueError(f"link field {self.key} must name a target table")

    def create_payload(self, table_ids: Mapping[str, str]) -> Json:
        payload: Json = {"type": self.type, "name": self.display_name}
        if self.type == "select":
            payload.update(
                {
                    "multiple": self.multiple or self.key in MULTI_SELECT_KEYS,
                    "options": [{"name": option} for option in self.options],
                }
            )
        if self.type == "link":
            payload["link_table"] = table_ids.get(
                self.link_table or "", self.link_table
            )
            payload["bidirectional"] = False
        if self.type == "formula":
            payload["expression"] = self.expression or '""'
        if self.type == "text" and self.style_type is not None:
            payload["style"] = {"type": self.style_type}
        return payload


@dataclass(frozen=True, slots=True)
class TableSchema:
    name: str
    logical_key: str
    fields: tuple[FieldSchema, ...]
    trigger_states: tuple[str, ...] = ()

    @property
    def field_map(self) -> dict[str, FieldSchema]:
        return {item.key: item for item in self.fields}


@dataclass(frozen=True, slots=True)
class BaseSchema:
    tables: tuple[TableSchema, ...]

    @classmethod
    def default(cls) -> BaseSchema:
        return cls(_TABLES)


def _auto(key: str, label: str, kind: str, **kwargs: Any) -> FieldSchema:
    return FieldSchema(key, AUTO_FIELD_PREFIX + label, kind, **kwargs)


def _human(key: str, label: str, kind: str, **kwargs: Any) -> FieldSchema:
    return FieldSchema(key, HUMAN_FIELD_PREFIX + label, kind, owner="human", **kwargs)


def _url(key: str, label: str, *, owner: str = "auto") -> FieldSchema:
    factory = _auto if owner == "auto" else _human
    return factory(key, label, "text", style_type="url")


def _select(options: Sequence[str]) -> dict[str, tuple[str, ...]]:
    return {"options": tuple(options)}


MULTI_SELECT_KEYS = frozenset(
    {
        "audience",
        "pain_points",
        "scenarios",
        "angles",
        "source_keywords",
        "creative_signals",
    }
)

_TABLES = (
    TableSchema(
        "细分领域池",
        "niche_key",
        (
            _auto("niche_key", "领域唯一键", "text"),
            _human("category", "大类", "text"),
            _auto("niche", "细分领域", "text"),
            _auto("market", "目标市场", "select", **_select(("US",))),
            _auto("priority", "研究优先级", "select", **_select(("高", "中", "低"))),
            _human(
                "status",
                "状态",
                "select",
                **_select(
                    tuple(
                        item.value
                        for item in (
                            BusinessStatus.NICHE_PENDING_GENERATION,
                            BusinessStatus.NICHE_PENDING_RESEARCH,
                            BusinessStatus.NICHE_PENDING_HUMAN_SELECTION,
                            BusinessStatus.NICHE_ENABLED,
                            BusinessStatus.NICHE_PAUSED,
                        )
                    )
                ),
            ),
            _auto("audience", "目标人群", "select"),
            _auto("pain_points", "核心问题", "select"),
            _auto("recommendation", "AI推荐理由", "text"),
            _human("selected_category", "选择大类", "text"),
            _auto("research_card", "研究证据卡", "text"),
            _human("confirmed_research_card", "研究证据卡", "text"),
            _human("research_confirmed", "研究证据已确认", "checkbox"),
            _human("generate_seeds", "生成种子词", "checkbox"),
            _auto("seed_batch", "种子词批次", "text"),
            _human("human_conclusion", "人工结论", "text"),
            _auto("trend_evidence", "趋势证据", "link", link_table="证据表"),
            _auto("competition_evidence", "竞争证据", "link", link_table="证据表"),
            _auto("supply_evidence", "供应链证据", "link", link_table="证据表"),
            _auto(
                "supply_availability",
                "供应链可得性",
                "select",
                **_select(("未知", "可得", "受限", "不可得")),
            ),
            _auto(
                "logistics_feasibility",
                "物流可得性",
                "select",
                **_select(("未知", "可行", "不可行")),
            ),
            _auto(
                "creative_feasibility",
                "素材可得性",
                "select",
                **_select(("未知", "可行", "不可行")),
            ),
        ),
        (BusinessStatus.NICHE_PENDING_GENERATION.value,),
    ),
    TableSchema(
        "关键词库",
        "keyword_key",
        (
            _auto("keyword_key", "关键词唯一键", "text"),
            _auto("search_text", "实际搜索词", "text"),
            _auto("chinese_meaning", "中文含义", "text"),
            _auto("normalized", "规范词", "text"),
            _auto("synonym_variants", "同义变体", "text"),
            _auto("market", "市场", "text"),
            _auto("locale", "语言地区", "text"),
            _auto(
                "keyword_type",
                "关键词类型",
                "select",
                **_select(("类目", "功能", "人群", "痛点", "场景/节日", "品牌/产品")),
            ),
            _human(
                "status",
                "状态",
                "select",
                **_select(
                    tuple(
                        item.value
                        for item in (
                            BusinessStatus.KEYWORD_PENDING_REVIEW,
                            BusinessStatus.KEYWORD_ENABLED,
                            BusinessStatus.KEYWORD_PENDING_SCAN,
                            BusinessStatus.KEYWORD_SCANNING,
                            BusinessStatus.KEYWORD_THROTTLED,
                            BusinessStatus.KEYWORD_SUGGEST_PAUSE,
                            BusinessStatus.KEYWORD_PAUSED,
                        )
                    )
                ),
            ),
            _auto("source_niche", "来源领域", "link", link_table="细分领域池"),
            _auto("source_keywords", "来源关键词", "link", link_table="关键词库"),
            _auto("source_ads", "来源广告", "link", link_table="广告与素材"),
            _auto("source_products", "来源产品", "link", link_table="产品主表"),
            _auto("scan_count", "扫描次数", "number"),
            _auto("ad_hits", "广告命中数", "number"),
            _auto("relevant_ads", "相关广告数", "number"),
            _auto("ads_30_days", "30天广告数", "number"),
            _auto("products_3_creatives", "三创意产品数", "number"),
            _auto("deep_worthy", "值得深入数", "number"),
            _auto("candidate_count", "候选品数", "number"),
            _auto("test_pool_count", "测试池数", "number"),
            _auto("hard_gate_rejected", "硬门槛淘汰数", "number"),
            _auto("rabbit_hole_depth", "兔子洞深度", "number"),
            _auto("next_scan", "下次扫描", "datetime"),
        ),
        (BusinessStatus.KEYWORD_PENDING_SCAN.value,),
    ),
    TableSchema(
        "搜索批次",
        "task_id",
        (
            _auto("task_id", "任务ID", "text"),
            _auto("keyword", "关键词", "link", link_table="关键词库"),
            _auto(
                "status",
                "状态",
                "select",
                **_select(("待执行", "执行中", "已完成", "待延迟重试", "需人工处理")),
            ),
            _auto("market", "市场", "text"),
            _auto("filters", "筛选条件", "text"),
            _auto("query", "实际查询", "text"),
            _auto("checkpoint", "检查点摘要", "text"),
            _auto("error", "错误", "text"),
            _auto("evidence_object_id", "证据对象ID", "text"),
            _auto("result_count", "结果数", "number"),
            _auto("refreshes", "刷新次数", "number"),
            _auto("retries", "重试次数", "number"),
            _auto("truncated", "已截断", "checkbox"),
            _auto("stop_reason", "停止原因", "text"),
            _auto(
                "completeness",
                "结果完整度",
                "select",
                **_select(("完整", "截断", "未知")),
            ),
            _auto("failure_type", "失败类型", "text"),
            _auto("screenshot_object_id", "截图对象ID", "text"),
            _auto("started_at", "开始时间", "datetime"),
            _auto("ended_at", "结束时间", "datetime"),
            _auto("retry_at", "下次重试", "datetime"),
            _auto("row_type", "记录类型", "text"),
            _auto("first_seen", "首次出现", "datetime"),
            _auto("last_seen", "最后出现", "datetime"),
            _auto("occurrence_count", "累计次数", "number"),
        ),
    ),
    TableSchema(
        "产品主表",
        "product_fingerprint",
        (
            _auto("product_fingerprint", "产品指纹", "text"),
            _auto("product_name", "标准产品名称", "text"),
            _auto("category", "品类", "text"),
            _auto("niche", "关联领域", "link", link_table="细分领域池"),
            _auto(
                "status",
                "状态",
                "select",
                **_select(("待识别具体产品", "待确认创意", "待补充")),
            ),
            _url("product_url", "商品链接", owner="human"),
            _url("landing_url", "落地页链接"),
            _auto("domain", "标准化域名", "text"),
            _auto(
                "page_type",
                "落地页类型",
                "select",
                **_select(("商品页", "分类页", "首页", "未知")),
            ),
            _auto("audience", "人群", "select"),
            _auto("pain_points", "痛点", "select"),
            _auto("scenarios", "场景", "select"),
            _auto("angles", "卖点角度", "select"),
            _auto("ads", "关联广告", "link", link_table="广告与素材"),
            _auto("keywords", "关联关键词", "link", link_table="关键词库"),
            _auto("suppliers", "供应商报价", "link", link_table="供应商报价"),
        ),
    ),
    TableSchema(
        "市场评估表",
        "product_market_key",
        (
            _auto("product_market_key", "产品市场唯一键", "text"),
            _auto("product", "产品", "link", link_table="产品主表"),
            _url("input_link", "广告或落地页链接", owner="human"),
            _human("product_name", "产品名称", "text"),
            _human("generic_query", "通用产品词", "text"),
            _human("approved_synonyms", "已审核同义词", "text"),
            _human("evidence_confirmed", "证据已确认", "checkbox"),
            _human("creative_formats", "创意形式", "text"),
            _human("creative_scenarios", "使用场景", "text"),
            _human("creative_hooks", "创意角度", "text"),
            _human("ugc_or_demo", "可持续演示", "checkbox"),
            _human("certification_required", "需要认证", "checkbox"),
            _human("certification_verified", "认证已确认", "checkbox"),
            _human(
                "brand_concentration",
                "品牌集中度",
                "select",
                **_select(("低", "中", "高", "未知")),
            ),
            _human(
                "differentiation",
                "产品差异化",
                "select",
                **_select(("低", "中", "高", "未知")),
            ),
            _human("bundle_justification", "订单组合依据", "text"),
            _human("bundle_confirmed", "订单组合已确认", "checkbox"),
            _human("supplier_quote_collected_at", "供应商报价采集时间", "datetime"),
            _human("market", "市场", "select", **_select(("US",))),
            _human(
                "status",
                "状态",
                "select",
                **_select(
                    tuple(
                        item.value
                        for item in (
                            BusinessStatus.CANDIDATE_PENDING_COMPLETION,
                            BusinessStatus.CANDIDATE_START_VALIDATION,
                            BusinessStatus.CANDIDATE_QUEUED,
                            BusinessStatus.CANDIDATE_COLLECTING,
                            BusinessStatus.CANDIDATE_IDENTIFY_PRODUCT,
                            BusinessStatus.CANDIDATE_CONFIRM_CREATIVE,
                            BusinessStatus.CANDIDATE_REQUEST_QUOTE,
                            BusinessStatus.CANDIDATE_SUPPLEMENT_EVIDENCE,
                            BusinessStatus.CANDIDATE_PENDING_SCORE,
                            BusinessStatus.CANDIDATE_INPUT_CHANGED,
                            BusinessStatus.CANDIDATE_NEEDS_HUMAN,
                            BusinessStatus.CANDIDATE_PENDING_HUMAN_REVIEW,
                            BusinessStatus.CANDIDATE_TEST_POOL,
                            BusinessStatus.CANDIDATE_BACKUP_POOL,
                            BusinessStatus.CANDIDATE_OBSERVATION,
                            BusinessStatus.CANDIDATE_ELIMINATED_POOL,
                        )
                    )
                ),
            ),
            _auto(
                "run_status",
                "运行状态",
                "select",
                **_select(("队列中", "采集中", "输入已变更", "待回写", "已完成")),
            ),
            _human("expected_order", "预计订单组合", "text"),
            _human("bundle_quantity", "订单件数", "number"),
            _human("price", "单品售价", "number"),
            _human("aov", "预计客单价", "number"),
            _human("goods_cost", "订单货值", "number"),
            _human("shipping_cost", "订单运费", "number"),
            _human("packaging_cost", "订单包装", "number"),
            _human("tax_cost", "税费关税", "number"),
            _human("ad_cost", "预计广告成本", "number"),
            _human("payment_rate", "支付百分比费率", "number"),
            _human("payment_fixed", "支付固定费", "number"),
            _human("loss_reserve_rate", "损耗准备金率", "number"),
            _human("weight", "订单重量", "number"),
            _human("supplier_quote_unit_cost", "供应商单件报价", "number"),
            _human("supplier_quote_bundle_cost", "供应商订单报价", "number"),
            _human("supplier_quote_confirmed", "供应商报价已确认", "checkbox"),
            _human("supplier_quote_valid", "供应商报价有效", "checkbox"),
            _human(
                "supplier_quote_trust",
                "供应商报价可信度",
                "select",
                **_select(("verified", "inferred", "unknown")),
            ),
            _url("supplier_quote_source", "供应商报价来源", owner="human"),
            _human(
                "trend_classification",
                "趋势分类",
                "select",
                **_select(
                    (
                        "rising",
                        "stable-high",
                        "seasonal",
                        "declining",
                        "peaked",
                        "insufficient-data",
                    )
                ),
            ),
            _human(
                "logistics_risk",
                "物流风险",
                "select",
                **_select(("低", "中", "高", "未知")),
            ),
            _human(
                "compliance_risk",
                "合规风险",
                "select",
                **_select(("低", "中", "高", "未知")),
            ),
            _human(
                "ip_risk", "侵权风险", "select", **_select(("低", "中", "高", "未知"))
            ),
            _auto("usd_conversion", "美元折算", "number"),
            _human("human_conclusion", "人工结论", "text"),
            _auto("contribution_margin", "贡献毛利率", "number"),
            _auto("demand_score", "需求趋势分", "number"),
            _auto("creative_score", "素材空间分", "number"),
            _auto("profit_score", "利润物流分", "number"),
            _auto("competition_score", "竞争强度分", "number"),
            _auto("risk_score", "合规风险分", "number"),
            _auto("total_score", "总分", "number"),
            _auto("rule_version", "规则版本", "text"),
            _auto("current_recommendation", "当前建议", "text"),
            _auto("evidence", "证据", "link", link_table="证据表"),
            _auto("score_history", "评分历史", "link", link_table="评分记录"),
            _auto(
                "display_key", "显示键", "formula", expression="[AUTO｜产品市场唯一键]"
            ),
        ),
        (BusinessStatus.CANDIDATE_START_VALIDATION.value,),
    ),
    TableSchema(
        "广告与素材",
        "meta_ad_id",
        (
            _auto("meta_ad_id", "Meta广告ID", "text"),
            _auto("status", "采集状态", "select", **_select(("已采集",))),
            _auto("advertiser", "广告主", "text"),
            _auto("page_id", "页面ID", "text"),
            _auto("ad_text", "文案", "text"),
            _auto("hook", "前三秒Hook", "text"),
            _auto("creative_fingerprint", "素材指纹", "text"),
            _auto("evidence_object_id", "证据对象ID", "text"),
            _auto("started_at", "开始投放日期", "datetime"),
            _auto("observed_at", "观察时间", "datetime"),
            _auto("active_days", "可观察活跃天数", "number"),
            _auto("duration", "视频时长", "number"),
            _auto("rhythm_30s", "前30秒节奏摘要", "text"),
            _auto("comment_signals", "评论与UGC信号", "text"),
            _auto("active", "当前活跃", "checkbox"),
            _auto("distinct_creative", "独立创意", "checkbox"),
            _auto(
                "creative_type",
                "创意类型",
                "select",
                **_select(("视频", "图片", "UGC", "Before-After", "专家背书", "其他")),
            ),
            _auto("creative_signals", "创意信号", "select", multiple=True),
            _url("creative_url", "素材链接"),
            _auto("extractor_version", "提取器版本", "text"),
            _auto("product", "产品", "link", link_table="产品主表"),
            _auto("keywords", "关键词", "link", link_table="关键词库"),
        ),
    ),
    TableSchema(
        "证据表",
        "evidence_id",
        (
            _auto("evidence_id", "证据ID", "text"),
            _auto(
                "evidence_type",
                "证据类型",
                "select",
                **_select(("Meta", "Trends", "落地页", "供应商", "人工")),
            ),
            _auto(
                "trust",
                "可信等级",
                "select",
                **_select(("verified", "inferred", "unknown")),
            ),
            _auto(
                "status",
                "确认状态",
                "select",
                **_select(("待确认", "已确认", "已过期")),
            ),
            _auto("collector_version", "采集器版本", "text"),
            _auto("model_version", "模型版本", "text"),
            _auto("evidence_version", "证据版本", "text"),
            _auto("raw_value", "原始值", "text"),
            _auto("normalized_value", "标准化值", "text"),
            _url("source_url", "来源URL"),
            _auto("snapshot_object_id", "快照对象ID", "text"),
            _auto("confidence", "置信度", "number"),
            _auto("collected_at", "采集时间", "datetime"),
            _auto("expires_at", "有效期", "datetime"),
            _auto("object_reference", "对象引用", "text"),
            _human("human_confirmed", "人工确认", "checkbox"),
        ),
    ),
    TableSchema(
        "供应商报价",
        "quote_key",
        (
            _auto("fx_rate_at", "汇率时间", "datetime"),
            _auto(
                "status",
                "状态",
                "select",
                **_select(("待人工选择", "已采用", "未采用")),
            ),
            _auto("quote_key", "报价唯一键", "text"),
            _auto("product", "产品", "link", link_table="产品主表"),
            _auto(
                "platform",
                "来源平台",
                "select",
                **_select(("Alibaba", "1688", "AliExpress", "其他")),
            ),
            _auto("supplier", "供应商", "text"),
            _auto("sku", "SKU", "text"),
            _auto("currency", "币种", "text"),
            _auto("shipping_method", "运输方式", "text"),
            _auto("certification", "认证", "text"),
            _auto("quantity", "适用数量", "number"),
            _auto("moq", "MOQ", "number"),
            _auto("unit_cost", "原币单件报价", "number"),
            _auto("fx_rate", "汇率", "number"),
            _auto("usd_unit_cost", "美元单件货值", "number"),
            _auto("order_goods_cost", "订单货值", "number"),
            _auto("weight", "包装重量", "number"),
            _auto("packaging_cost", "订单包装成本", "number"),
            _auto("us_shipping_cost", "美国订单运费", "number"),
            _auto("lead_time_days", "交期天数", "number"),
            _url("url", "商品链接"),
            _auto("quote_date", "报价日期", "datetime"),
            _human("selected", "是否采用", "checkbox"),
        ),
    ),
    TableSchema(
        "评分记录",
        "score_id",
        (
            _human(
                "review_result",
                "人工复核结果",
                "select",
                **_select(("批准测试", "转备选", "继续观察", "退回补充", "淘汰")),
            ),
            _auto("score_id", "评分ID", "text"),
            _auto("input_snapshot", "输入证据快照", "text"),
            _auto("market_evaluation", "市场评估", "link", link_table="市场评估表"),
            _auto("scored_at", "评分时间", "datetime"),
            _auto("rule_version", "规则版本", "text"),
            _auto("reasons", "评分理由", "text"),
            _auto(
                "completeness", "证据完整度", "select", **_select(("完整", "不完整"))
            ),
            _auto(
                "meta_screen",
                "Meta粗筛结果",
                "select",
                **_select(("通过", "未通过", "证据不足")),
            ),
            _auto(
                "gate_result",
                "硬门槛结果",
                "select",
                **_select(("通过", "未通过", "待补充")),
            ),
            _auto("status", "评分状态", "select", **_select(("待人工复核", "已复核"))),
            _auto(
                "recommendation",
                "系统建议",
                "select",
                **_select(("测试", "备选", "淘汰", "待补充")),
            ),
            _auto("demand_score", "需求趋势分", "number"),
            _auto("creative_score", "素材空间分", "number"),
            _auto("profit_score", "利润物流分", "number"),
            _auto("competition_score", "竞争强度分", "number"),
            _auto("risk_score", "合规风险分", "number"),
            _auto("total_score", "总分", "number"),
            _auto("margin", "贡献毛利率", "number"),
            _human("reviewed_at", "人工复核时间", "datetime"),
            _human("review_reason", "人工复核理由", "text"),
        ),
    ),
)

# Stable key -> Feishu display label mappers, one entry for every table.
FIELD_MAPPERS = {
    table.name: {field.key: field.display_name for field in table.fields}
    for table in _TABLES
}


@dataclass(frozen=True, slots=True)
class ViewSchema:
    table: str
    name: str
    field_key: str | None = None
    state: str | None = None


TRIGGER_VIEWS = (
    ViewSchema("细分领域池", "触发｜待研究证据卡", "status", "待研究"),
    ViewSchema("细分领域池", "触发｜已批准领域种子词", "status", "已启用"),
    ViewSchema(
        "细分领域池",
        "触发｜待生成",
        "status",
        BusinessStatus.NICHE_PENDING_GENERATION.value,
    ),
    ViewSchema(
        "关键词库", "触发｜待扫描", "status", BusinessStatus.KEYWORD_PENDING_SCAN.value
    ),
    ViewSchema(
        "市场评估表",
        "触发｜开始验证",
        "status",
        BusinessStatus.CANDIDATE_START_VALIDATION.value,
    ),
)
OPERATION_VIEWS = (
    ViewSchema("搜索批次", "运营｜运行告警", "row_type", "运行告警"),
    ViewSchema("市场评估表", "运营｜观察池", "status", "观察池"),
    ViewSchema("市场评估表", "运营｜测试池", "status", "测试池"),
    ViewSchema("市场评估表", "运营｜待确认创意", "status", "待确认创意"),
    ViewSchema("市场评估表", "运营｜粗筛通过", "current_recommendation", "值得深入"),
    ViewSchema(
        "细分领域池",
        "运营｜待研究",
        "status",
        BusinessStatus.NICHE_PENDING_RESEARCH.value,
    ),
    ViewSchema(
        "细分领域池",
        "运营｜待人工选择",
        "status",
        BusinessStatus.NICHE_PENDING_HUMAN_SELECTION.value,
    ),
    ViewSchema(
        "关键词库",
        "运营｜待审核",
        "status",
        BusinessStatus.KEYWORD_PENDING_REVIEW.value,
    ),
    ViewSchema(
        "关键词库", "运营｜扫描中", "status", BusinessStatus.KEYWORD_SCANNING.value
    ),
    ViewSchema("搜索批次", "运营｜待执行", "status", "待执行"),
    ViewSchema("搜索批次", "运营｜需人工处理", "status", "需人工处理"),
    ViewSchema("产品主表", "运营｜待识别具体产品", "status", "待识别具体产品"),
    ViewSchema(
        "市场评估表",
        "运营｜待询价",
        "status",
        BusinessStatus.CANDIDATE_REQUEST_QUOTE.value,
    ),
    ViewSchema(
        "市场评估表",
        "运营｜待补充证据",
        "status",
        BusinessStatus.CANDIDATE_SUPPLEMENT_EVIDENCE.value,
    ),
    ViewSchema(
        "市场评估表",
        "运营｜待评分",
        "status",
        BusinessStatus.CANDIDATE_PENDING_SCORE.value,
    ),
    ViewSchema(
        "市场评估表",
        "运营｜待人工复核",
        "status",
        BusinessStatus.CANDIDATE_PENDING_HUMAN_REVIEW.value,
    ),
    ViewSchema(
        "市场评估表",
        "运营｜输入已变更",
        "run_status",
        BusinessStatus.CANDIDATE_INPUT_CHANGED.value,
    ),
    ViewSchema("供应商报价", "运营｜待人工选择", "status", "待人工选择"),
    ViewSchema("评分记录", "运营｜待人工复核", "status", "待人工复核"),
)
ALL_VIEWS = TRIGGER_VIEWS + OPERATION_VIEWS


@dataclass(frozen=True, slots=True)
class RecordVersion:
    record_id: str
    version: str
    fields: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class TriggerRecord:
    table: str
    record_id: str
    state: str
    version: str
    fields: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class BootstrapPlan:
    tables: int
    fields: int
    views: tuple[str, ...]
    destructive_operations: int = 0
    incompatible: tuple[str, ...] = ()


class Outbox(Protocol):
    async def enqueue(
        self, record_id: str, record_version: str, payload: Json
    ) -> Any: ...


class RecordWriter(Protocol):
    async def get_record(self, table_id: str, record_id: str) -> RecordVersion: ...

    async def update_record(
        self, table_id: str, record_id: str, fields: Mapping[str, Any]
    ) -> RecordVersion: ...


def _credential_operation[**P, R](method: Callable[Concatenate[FeishuClient, P], Coroutine[Any, Any, R]]) -> Callable[Concatenate[FeishuClient, P], Coroutine[Any, Any, R]]:
    """Keep one injected credential snapshot across nested public lookups/requests."""
    @wraps(method)
    async def operation(self: FeishuClient, /, *args: P.args, **kwargs: P.kwargs) -> R:
        if self._credentials_resolver is None or self._credential_owner is asyncio.current_task():
            return await method(self, *args, **kwargs)
        async with self._credential_lock:
            self._refresh_credentials(force=True)
            self._credential_owner = asyncio.current_task()
            try:
                return await method(self, *args, **kwargs)
            finally:
                self._credential_owner = None
    return operation


class FeishuClient:
    def __init__(
        self,
        app_id: str = "",
        app_secret: str = "",
        base_token: str = "",
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        retries: int = 3,
        http_client: httpx.AsyncClient | None = None,
        credentials_resolver: Callable[[], Mapping[str, str]] | None = None,
        allow_external: bool = True,
    ) -> None:
        self.app_id, self.app_secret, self._base_token = app_id, app_secret, base_token
        self._credentials_resolver = credentials_resolver
        self._credential_lock = asyncio.Lock()
        self._credential_owner: asyncio.Task[Any] | None = None
        self._allow_external = allow_external
        self._timeout = timeout
        self._client = http_client
        self._owns_client = http_client is None
        self._retries = retries
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._table_ids: dict[str, str] = {}
        self._view_ids: dict[tuple[str, str], str] = {}

    @property
    def base_token(self) -> str:
        if self._credentials_resolver is not None:
            self._refresh_credentials()
        return self._base_token

    def _refresh_credentials(self, *, force: bool = False) -> None:
        if self._credential_owner is not None and not force:
            return
        assert self._credentials_resolver is not None
        data = self._credentials_resolver()
        current = (data.get("app_id", ""), data.get("app_secret", ""), data.get("base_app_token", ""))
        if current != (self.app_id, self.app_secret, self._base_token):
            self.app_id, self.app_secret, self._base_token = current
            self._token = None
            self._token_expires_at = 0.0
            self._table_ids.clear()
            self._view_ids.clear()

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()

    async def _tenant_token(self) -> str:
        if not self._allow_external:
            raise PermissionError("feishu_external_not_authorized")
        if self._credentials_resolver is not None:
            self._refresh_credentials()
        if not self.app_id or not self.app_secret or not self._base_token:
            raise ValueError("feishu_unconfigured")
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(self._timeout))
        if self._token is not None and time.monotonic() < self._token_expires_at:
            return self._token
        for attempt in range(self._retries + 1):
            response = await self._client.post(
                API_TENANT_TOKEN,
                json={"app_id": self.app_id, "app_secret": self.app_secret},
            )
            body = self._json(response)
            if not self._retryable(response, body) or attempt == self._retries:
                if response.is_error or body.get("code", 0) != 0:
                    raise FeishuAPIError(response.status_code, body)
                token = body.get("tenant_access_token")
                if not isinstance(token, str):
                    raise FeishuAPIError(response.status_code, body)
                self._token = token
                self._token_expires_at = time.monotonic() + max(
                    1, int(body.get("expire", 7200)) - 60
                )
                return token
            await asyncio.sleep(self._retry_delay(response, attempt))
        raise AssertionError("token retry loop exhausted")

    @staticmethod
    def _json(response: httpx.Response) -> Json:
        try:
            body = response.json()
        except ValueError:
            body = {"raw": response.text}
        return body if isinstance(body, dict) else {"body": body}

    @staticmethod
    def _retryable(response: httpx.Response, body: Json) -> bool:
        return (
            response.status_code == 429
            or response.status_code >= 500
            or body.get("code") == 1254291
        )

    @staticmethod
    def _retry_delay(response: httpx.Response, attempt: int) -> float:
        value = response.headers.get("Retry-After")
        if value is None:
            return float(2**attempt)
        try:
            return max(0.0, float(value))
        except ValueError:
            try:
                retry_at = parsedate_to_datetime(value)
                if retry_at.tzinfo is None:
                    retry_at = retry_at.replace(tzinfo=UTC)
                return max(0.0, (retry_at - datetime.now(UTC)).total_seconds())
            except (TypeError, ValueError, IndexError):
                return float(2**attempt)

    async def _request(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, str | int] | None = None,
        json: Json | None = None,
        retry: bool = True,
    ) -> Json:
        token = await self._tenant_token()
        assert self._client is not None  # _tenant_token initializes the transport.
        attempts = self._retries if retry else 0
        for attempt in range(attempts + 1):
            response = await self._client.request(
                method,
                url,
                params=params,
                json=json,
                headers={"Authorization": f"Bearer {token}"},
            )
            body = self._json(response)
            retryable = self._retryable(response, body)
            if not retryable or attempt == attempts:
                if response.is_error or body.get("code", 0) != 0:
                    raise FeishuAPIError(response.status_code, body)
                return body
            await asyncio.sleep(self._retry_delay(response, attempt))
        raise AssertionError("retry loop exhausted")

    @_credential_operation
    async def resolve_table_id(self, table_name_or_id: str) -> str:
        if table_name_or_id.startswith("tbl"):
            return table_name_or_id
        if table_name_or_id not in self._table_ids:
            self._table_ids = {
                str(item["name"]): str(item["id"]) for item in await self.list_tables()
            }
        try:
            return self._table_ids[table_name_or_id]
        except KeyError as exc:
            raise KeyError(f"Feishu table not found: {table_name_or_id}") from exc

    @_credential_operation
    async def resolve_view_id(self, table_name_or_id: str, view_name: str) -> str:
        table_id = await self.resolve_table_id(table_name_or_id)
        cache_key = (table_id, view_name)
        if cache_key not in self._view_ids:
            self._view_ids.update(
                {
                    (table_id, str(item["name"])): str(item["id"])
                    for item in await self.list_views(table_id)
                }
            )
        try:
            return self._view_ids[cache_key]
        except KeyError as exc:
            raise KeyError(f"Feishu view not found: {view_name}") from exc

    @_credential_operation
    async def list_records(
        self, table_id: str, *, view_id: str | None = None, view_name: str | None = None
    ) -> list[Json]:
        items: list[Json] = []
        offset: int | None = None
        resolved_table_id = await self.resolve_table_id(table_id)
        if view_name is not None:
            view_id = await self.resolve_view_id(resolved_table_id, view_name)
        url = API_RECORD_LIST.format(
            base_token=self.base_token, table_id=resolved_table_id
        )
        while True:
            params: dict[str, str | int] = {"limit": 100}
            if view_id is not None:
                params["view_id"] = view_id
            if offset is not None:
                params["offset"] = offset
            body = await self._request("GET", url, params=params)
            data = body.get("data", {})
            if not isinstance(data, dict):
                raise FeishuAPIError(200, body)
            page_items = self._record_items(data, body)
            items.extend(page_items)
            if not data.get("has_more"):
                return items
            next_offset = data.get("offset")
            if not isinstance(next_offset, int):
                raise FeishuAPIError(200, body)
            offset = next_offset

    @staticmethod
    def _record_items(data: Json, body: Json) -> list[Json]:
        records = data.get("records")
        if records is not None:
            if not isinstance(records, list) or not all(
                isinstance(item, dict) for item in records
            ):
                raise FeishuAPIError(200, body)
            return records
        if not any(key in data for key in ("data", "fields", "record_id_list")):
            return []
        rows = data.get("data")
        fields = data.get("fields")
        record_ids = data.get("record_id_list")
        if (
            not isinstance(rows, list)
            or not isinstance(fields, list)
            or not all(isinstance(field, str) for field in fields)
            or not isinstance(record_ids, list)
            or not all(isinstance(record_id, str) for record_id in record_ids)
            or len(rows) != len(record_ids)
        ):
            raise FeishuAPIError(200, body)
        items: list[Json] = []
        for record_id, row in zip(record_ids, rows, strict=True):
            if not isinstance(row, list) or len(row) != len(fields):
                raise FeishuAPIError(200, body)
            # ``rev`` is the table revision shared by every returned row. It
            # changes when an unrelated record is written and therefore cannot
            # fence one record. Omitting it lets ``record_version`` derive the
            # stable protected-input hash used by the workflow adapter.
            items.append(
                {
                    "id": record_id,
                    "fields": dict(zip(fields, row, strict=True)),
                }
            )
        return items

    @_credential_operation
    async def list_tables(self) -> list[Json]:
        items: list[Json] = []
        offset = 0
        while True:
            body = await self._request(
                "GET",
                API_TABLE_LIST.format(base_token=self.base_token),
                params={"limit": 100, "offset": offset},
            )
            data = body.get("data", {})
            page = (
                data.get("tables", data.get("items", []))
                if isinstance(data, dict)
                else []
            )
            if not isinstance(page, list) or not all(
                isinstance(item, dict) for item in page
            ):
                raise FeishuAPIError(200, body)
            items.extend(page)
            if not isinstance(data, dict) or not data.get("has_more"):
                return items
            next_offset = data.get("offset")
            if not isinstance(next_offset, int):
                raise FeishuAPIError(200, body)
            offset = next_offset

    @_credential_operation
    async def create_table(self, table_name: str) -> str:
        body = await self._request(
            "POST",
            API_TABLE_LIST.format(base_token=self.base_token),
            json={"name": table_name},
        )
        data = body.get("data", {})
        table_id = data.get("id") if isinstance(data, dict) else None
        if not isinstance(table_id, str):
            raise FeishuAPIError(200, body)
        self._table_ids[table_name] = table_id
        return table_id

    @_credential_operation
    async def list_views(self, table_id: str) -> list[Json]:
        return await self._list_directory(
            API_VIEW_LIST.format(base_token=self.base_token, table_id=table_id)
        )

    @_credential_operation
    async def create_view(self, table_id: str, name: str, filter_payload: Json) -> str:
        # Base v3 rejects `filter` on the create-view payload.  The filter is
        # applied through the dedicated endpoint immediately after creation.
        body = await self._request(
            "POST",
            API_VIEW_LIST.format(base_token=self.base_token, table_id=table_id),
            json={"name": name, "type": "grid"},
        )
        data = body.get("data", {})
        view_id = data.get("id") if isinstance(data, dict) else None
        if not isinstance(view_id, str):
            raise FeishuAPIError(200, body)
        self._view_ids[(table_id, name)] = view_id
        return view_id

    @_credential_operation
    async def update_view(
        self, table_id: str, view_id: str, filter_payload: Json
    ) -> None:
        await self._request(
            "PUT",
            API_VIEW_FILTER.format(
                base_token=self.base_token, table_id=table_id, view_id=view_id
            ),
            json=filter_payload,
        )

    @_credential_operation
    async def get_view_filter(self, table_id: str, view_id: str) -> Json:
        body = await self._request(
            "GET",
            API_VIEW_FILTER.format(
                base_token=self.base_token, table_id=table_id, view_id=view_id
            ),
        )
        data = body.get("data", {})
        if not isinstance(data, dict):
            raise FeishuAPIError(200, body)
        logic = data.get("logic", "and")
        conditions = data.get("conditions", [])
        if not isinstance(logic, str) or not isinstance(conditions, list):
            raise FeishuAPIError(200, body)
        return {"logic": logic, "conditions": conditions}

    @_credential_operation
    async def list_fields(self, table_id: str) -> list[Json]:
        return await self._list_directory(
            API_FIELD_LIST.format(base_token=self.base_token, table_id=table_id)
        )

    async def _list_directory(self, url: str) -> list[Json]:
        items: list[Json] = []
        offset = 0
        while True:
            body = await self._request(
                "GET", url, params={"limit": 100, "offset": offset}
            )
            data = body.get("data", {})
            page = []
            if isinstance(data, dict):
                for key in ("items", "fields", "views"):
                    if key in data:
                        page = data[key]
                        break
            if not isinstance(page, list) or not all(
                isinstance(item, dict) for item in page
            ):
                raise FeishuAPIError(200, body)
            items.extend(page)
            if not isinstance(data, dict) or not data.get("has_more"):
                return items
            next_offset = data.get("offset")
            if not isinstance(next_offset, int):
                raise FeishuAPIError(200, body)
            offset = next_offset

    @_credential_operation
    async def get_field(self, table_id: str, field_id: str) -> Json:
        body = await self._request(
            "GET",
            API_FIELD_UPDATE.format(
                base_token=self.base_token, table_id=table_id, field_id=field_id
            ),
        )
        data = body.get("data", {})
        field_data = data.get("field", data) if isinstance(data, dict) else {}
        if not isinstance(field_data, dict):
            raise FeishuAPIError(200, body)
        return field_data

    @_credential_operation
    async def create_field(self, table_id: str, payload: Json) -> str:
        body = await self._request(
            "POST",
            API_FIELD_LIST.format(base_token=self.base_token, table_id=table_id),
            json=payload,
        )
        data = body.get("data", {})
        field_id = data.get("id") if isinstance(data, dict) else None
        if not isinstance(field_id, str):
            raise FeishuAPIError(200, body)
        return field_id

    @_credential_operation
    async def update_field(self, table_id: str, field_id: str, payload: Json) -> str:
        """Additive select-option update; callers must preserve current options."""
        body = await self._request(
            "PUT",
            API_FIELD_UPDATE.format(
                base_token=self.base_token, table_id=table_id, field_id=field_id
            ),
            json=payload,
        )
        data = body.get("data", {})
        updated_id = data.get("id") if isinstance(data, dict) else None
        if not isinstance(updated_id, str):
            raise FeishuAPIError(200, body)
        return updated_id

    @_credential_operation
    async def get_record(self, table_id: str, record_id: str) -> RecordVersion:
        resolved_table_id = await self.resolve_table_id(table_id)
        body = await self._request(
            "POST",
            API_RECORD_BATCH_GET.format(
                base_token=self.base_token, table_id=resolved_table_id
            ),
            json={"record_id_list": [record_id]},
        )
        data = body.get("data", {}) if isinstance(body.get("data"), dict) else {}
        records = self._record_items(data, body)
        record = (
            next(
                (
                    item
                    for item in records
                    if isinstance(item, dict)
                    and item.get("id", item.get("record_id")) == record_id
                ),
                None,
            )
            if isinstance(records, list)
            else None
        )
        if not isinstance(record, dict):
            raise FeishuAPIError(200, body)
        fields = record.get("fields", {})
        if not isinstance(fields, dict):
            raise FeishuAPIError(200, body)
        return self.record_version(record)

    @staticmethod
    def record_version(record: Mapping[str, Any]) -> RecordVersion:
        """Normalize Base v3 cells without inventing absent record revisions."""
        record_id = record.get("id", record.get("record_id"))
        fields = record.get("fields")
        if (
            not isinstance(record_id, str)
            or not record_id
            or not isinstance(fields, dict)
        ):
            raise FeishuAPIError(200, {"code": "record_schema_invalid"})
        singles = {
            item.display_name
            for table in BaseSchema.default().tables
            for item in table.fields
            if item.type == "select"
            and not (item.multiple or item.key in MULTI_SELECT_KEYS)
        }
        links = {
            item.display_name
            for table in BaseSchema.default().tables
            for item in table.fields
            if item.type == "link"
        }
        normalized = {
            name: (value[0] if len(value) == 1 else None)
            if name in singles and isinstance(value, list)
            else value
            for name, value in fields.items()
        }
        for name in links.intersection(normalized):
            value = normalized[name]
            if isinstance(value, list):
                normalized[name] = [
                    item.get("id") if isinstance(item, dict) else item for item in value
                ]
        urls = {
            item.display_name
            for table in BaseSchema.default().tables
            for item in table.fields
            if item.style_type == "url"
        }
        for name in urls.intersection(normalized):
            value = normalized[name]
            if isinstance(value, str):
                wrapped = re.fullmatch(r"\[[^\]]*\]\((https?://\S+)\)", value)
                if wrapped:
                    normalized[name] = wrapped[1]
        version = record.get("revision", record.get("version"))
        if version is None or str(version) == "":
            safe, _ = canonical_supplier_inputs(normalized)
            version = (
                "sha256:"
                + hashlib.sha256(
                    json.dumps(
                        safe, sort_keys=True, ensure_ascii=False, default=str
                    ).encode()
                ).hexdigest()
            )
        return RecordVersion(record_id, str(version), normalized)

    @_credential_operation
    async def write_workflow_record(
        self, mutation: Any, *, record_id: str | None = None
    ) -> str:
        """Write one validated mutation using documented Base v3 batch cells.

        No remote CAS is claimed: the workflow adapter owns read/version guards.
        Only its validated state may cross the otherwise AUTO-only boundary.
        Creates are never automatically retried after an ambiguous response.
        """
        from rabbit_hole.pipeline import FeishuMutation

        checked = FeishuMutation.model_validate(mutation.model_dump())
        schema = next(
            table
            for table in BaseSchema.default().tables
            if table.name == checked.table
        )
        fields = dict(checked.fields)
        fields[schema.field_map["status"].display_name] = checked.state
        if checked.unique_key:
            fields[schema.field_map[schema.logical_key].display_name] = (
                checked.unique_key
            )
        definitions = {item.display_name: item for item in schema.fields}
        cells: Json = {}
        for name, value in fields.items():
            definition = definitions.get(name)
            if definition is None or definition.type == "formula":
                raise ValueError(
                    "workflow field is not writable in the declared schema"
                )
            if definition.type == "select" and value is not None:
                value = value if isinstance(value, list) else [value]
            elif definition.type == "link" and value is not None:
                value = [
                    {"id": item} if isinstance(item, str) else item for item in value
                ]
            cells[name] = value
        table_id = await self.resolve_table_id(checked.table)
        url = API_RECORD_LIST.format(base_token=self.base_token, table_id=table_id)
        if record_id is None:
            body = await self._request(
                "POST",
                url + "/batch_create",
                json={"create_records": [cells]},
                retry=False,
            )
            ids = body.get("data", {}).get("record_id_list", [])
            if (
                not isinstance(ids, list)
                or len(ids) != 1
                or not isinstance(ids[0], str)
            ):
                raise FeishuAPIError(200, {"code": "create_response_invalid"})
            return ids[0]
        body = await self._request(
            "POST",
            url + "/batch_update",
            json={"update_records": {record_id: cells}},
            retry=False,
        )
        if body.get("data", {}).get("ignored_fields"):
            raise FeishuAPIError(200, {"code": "workflow_fields_ignored"})
        return record_id

    @_credential_operation
    async def probe_token(self) -> bool:
        await self._tenant_token()
        return True

    @_credential_operation
    async def update_record(
        self, table_id: str, record_id: str, fields: Mapping[str, Any]
    ) -> RecordVersion:
        self._require_auto_fields(fields)
        resolved_table_id = await self.resolve_table_id(table_id)
        body = await self._request(
            "PATCH",
            API_RECORD_LIST.format(
                base_token=self.base_token, table_id=resolved_table_id
            )
            + f"/{record_id}",
            json=dict(fields),
        )
        data = body.get("data", {}) if isinstance(body.get("data"), dict) else {}
        records = data.get("records", []) if isinstance(data, dict) else []
        record = (
            records[0]
            if isinstance(records, list) and records
            else data.get("record", {})
        )
        if not isinstance(record, dict):
            raise FeishuAPIError(200, body)
        return RecordVersion(
            str(record.get("id", record.get("record_id", record_id))),
            str(record.get("revision", record.get("version", ""))),
            dict(record.get("fields", {})),
        )

    @staticmethod
    def _require_auto_fields(fields: Mapping[str, Any]) -> None:
        invalid = [name for name in fields if not name.startswith(AUTO_FIELD_PREFIX)]
        if invalid:
            raise ValueError(
                f"Feishu automation cannot write human/protected fields: {invalid}"
            )

    @_credential_operation
    async def list_trigger_records(self) -> list[TriggerRecord]:
        records: list[TriggerRecord] = []
        for trigger in TRIGGER_VIEWS:
            # The API receives resolved IDs; human names remain schema keys only.
            for item in await self.list_records(trigger.table, view_name=trigger.name):
                record = self.record_version(item)
                fields = record.fields
                state = fields.get(FIELD_MAPPERS[trigger.table]["status"])
                if state == trigger.state:
                    records.append(
                        TriggerRecord(
                            trigger.table,
                            record.record_id,
                            str(state),
                            record.version,
                            fields,
                        )
                    )
        return records

    @staticmethod
    async def safe_write(
        client: RecordWriter,
        *,
        table: str,
        expected: RecordVersion,
        fields: Mapping[str, Any],
        protected_fields: Iterable[str],
        outbox: Outbox,
    ) -> RecordVersion:
        FeishuClient._require_auto_fields(fields)
        current = await client.get_record(table, expected.record_id)
        changed = current.version != expected.version or any(
            current.fields.get(name) != expected.fields.get(name)
            for name in protected_fields
        )
        payload = {
            "table": table,
            "record_id": expected.record_id,
            "fields": dict(fields),
            "reason": BusinessStatus.CANDIDATE_INPUT_CHANGED.value
            if changed
            else "write_failed",
        }
        if changed:
            payload["fields"] = {
                AUTO_FIELD_PREFIX
                + "运行状态": BusinessStatus.CANDIDATE_INPUT_CHANGED.value
            }
            await outbox.enqueue(expected.record_id, current.version, payload)
            raise WriteConflict(f"record {expected.record_id} input changed")
        try:
            return await client.update_record(table, expected.record_id, fields)
        except Exception:
            await outbox.enqueue(expected.record_id, expected.version, payload)
            raise

    @staticmethod
    async def consume_outbox_event(
        client: RecordWriter, event: Mapping[str, Any]
    ) -> RecordVersion:
        """Apply an already fenced, automation-only outbox payload."""
        table = event.get("table")
        record_id = event.get("record_id")
        fields = event.get("fields")
        if (
            not isinstance(table, str)
            or not isinstance(record_id, str)
            or not isinstance(fields, dict)
        ):
            raise TypeError("invalid Feishu outbox event")
        return await client.update_record(table, record_id, fields)


class JobEnqueuer(Protocol):
    async def enqueue(self, payload: JobPayload) -> Any: ...

    async def enqueue_with_receipt(self, payload: JobPayload) -> EnqueueReceipt: ...


class TriggerSource(Protocol):
    async def list_trigger_records(self) -> list[TriggerRecord]: ...


class TriggerPoller:
    def __init__(self, feishu: TriggerSource, jobs: JobEnqueuer) -> None:
        self._feishu, self._jobs = feishu, jobs

    async def poll_once(self) -> int:
        mapping = {
            (
                "细分领域池",
                BusinessStatus.NICHE_PENDING_GENERATION.value,
            ): JobKind.NICHE_DISCOVERY,
            (
                "关键词库",
                BusinessStatus.KEYWORD_PENDING_SCAN.value,
            ): JobKind.KEYWORD_SCAN,
            (
                "市场评估表",
                BusinessStatus.CANDIDATE_START_VALIDATION.value,
            ): JobKind.LINK_VALIDATION,
            ("细分领域池", "已启用"): JobKind.KEYWORD_SEED,
            ("细分领域池", "待研究"): JobKind.NICHE_RESEARCH,
        }
        count = 0
        for record in await self._feishu.list_trigger_records():
            kind = mapping.get((record.table, record.state))
            if kind is None:
                continue
            if kind is JobKind.NICHE_RESEARCH and (
                not record.fields.get("AUTO｜研究证据卡")
                or not record.fields.get("AUTO｜细分领域")
            ):
                continue
            if kind is JobKind.KEYWORD_SEED and (
                record.fields.get("人工｜生成种子词") is not True
                or record.fields.get("人工｜研究证据已确认") is not True
                or record.fields.get("AUTO｜种子词批次")
            ):
                continue
            snapshot, invalid_source = canonical_supplier_inputs(record.fields)
            try:
                payload = JobPayload(
                    kind=kind,
                    record_id=record.record_id,
                    input_version=record.version,
                    protected_input_hash=protected_input_hash(snapshot),
                    data=snapshot,
                    input_error=(
                        "supplier_quote_source_invalid" if invalid_source else None
                    ),
                )
                enqueue_with_receipt = getattr(self._jobs, "enqueue_with_receipt", None)
                if callable(enqueue_with_receipt):
                    receipt = await enqueue_with_receipt(payload)
                    created = receipt.created
                else:
                    # Older adapters cannot expose the durable signal. Preserve
                    # their historical count semantics without guessing from
                    # timestamps or queue state.
                    await self._jobs.enqueue(payload)
                    created = True
            except AdmissionLimitReached:
                # Keep manual triggers unchanged; admitted work and other
                # non-scan actions continue without Phase 3 scheduling.
                continue
            count += int(created)
        return count

    async def run_forever(self, *, interval: float = 60.0) -> None:
        """Cancellable bounded poll loop; cancellation propagates to the caller."""
        if interval <= 0:
            raise ValueError("interval must be positive")
        while True:
            await self.poll_once()
            await asyncio.sleep(interval)


async def bootstrap_base(
    client: Any, *, schema: BaseSchema | None = None, dry_run: bool = False
) -> BootstrapPlan:
    """Create missing schema components; never delete or overwrite an incompatible field."""
    schema = schema or BaseSchema.default()
    if dry_run:
        return BootstrapPlan(
            len(schema.tables),
            sum(len(table.fields) for table in schema.tables),
            tuple(item.name for item in ALL_VIEWS),
        )
    existing_tables = {
        str(item.get("name", item.get("table_name"))): str(
            item.get("id", item.get("table_id"))
        )
        for item in await client.list_tables()
        if item.get("name", item.get("table_name"))
        and item.get("id", item.get("table_id"))
    }
    for table in schema.tables:
        if table.name not in existing_tables:
            existing_tables[table.name] = await client.create_table(table.name)
    incompatible: list[str] = []
    table_fields: dict[str, list[Json]] = {}
    for table in schema.tables:
        table_id = existing_tables[table.name]
        current = {
            str(item.get("name", item.get("field_name"))): item
            for item in await client.list_fields(table_id)
            if item.get("name", item.get("field_name"))
        }
        for item in table.fields:
            found = current.get(item.display_name)
            if found is None:
                await client.create_field(
                    table_id, item.create_payload(existing_tables)
                )
                continue
            field_id = found.get("id", found.get("field_id"))
            if not isinstance(field_id, str):
                incompatible.append(
                    f"{table.name}.{item.display_name}: missing field id"
                )
                continue
            remote = await client.get_field(table_id, field_id)
            reason = _field_incompatibility(item, remote, existing_tables)
            if reason is not None:
                incompatible.append(f"{table.name}.{item.display_name}: {reason}")
                continue
            if item.type == "select":
                if "dynamic_options_source" in remote:
                    incompatible.append(
                        f"{table.name}.{item.display_name}: dynamic options source cannot be merged safely"
                    )
                    continue
                options = remote.get("options", [])
                names = {
                    option.get("name") for option in options if isinstance(option, dict)
                }
                missing = [option for option in item.options if option not in names]
                if missing:
                    if not isinstance(options, list) or not all(
                        isinstance(option, dict) for option in options
                    ):
                        incompatible.append(
                            f"{table.name}.{item.display_name}: cannot safely preserve option definition"
                        )
                        continue
                    payload = copy.deepcopy(remote)
                    payload.pop("id", None)
                    payload["options"] = [
                        copy.deepcopy(option) for option in options
                    ] + [{"name": option} for option in missing]
                    await client.update_field(table_id, field_id, payload)
        table_fields[table.name] = await client.list_fields(table_id)
    for view in ALL_VIEWS:
        if view.table not in table_fields:
            continue
        table_id = existing_tables[view.table]
        field_ids = {
            str(item.get("name", item.get("field_name"))): str(
                item.get("id", item.get("field_id"))
            )
            for item in table_fields[view.table]
            if item.get("name", item.get("field_name"))
            and item.get("id", item.get("field_id"))
        }
        if view.field_key is None or view.state is None:
            incompatible.append(f"{view.table}.{view.name}: missing required predicate")
            continue
        display_name = FIELD_MAPPERS[view.table][view.field_key]
        field_id = field_ids.get(display_name)
        if field_id is None:
            incompatible.append(
                f"{view.table}.{view.name}: missing filter field {display_name}"
            )
            continue
        field_type = next(
            field.type
            for table in schema.tables
            if table.name == view.table
            for field in table.fields
            if field.key == view.field_key
        )
        condition = (
            [field_id, "intersects", [view.state]]
            if field_type == "select"
            else [field_id, "==", view.state]
        )
        filter_payload: Json = {
            "logic": "and",
            "conditions": [condition],
        }
        if view.table == "搜索批次" and view.field_key != "row_type":
            row_type_id = field_ids.get(FIELD_MAPPERS[view.table]["row_type"])
            if row_type_id is None:
                incompatible.append(
                    f"{view.table}.{view.name}: missing alert row discriminator"
                )
                continue
            filter_payload["conditions"].append([row_type_id, "!=", "运行告警"])
        views = {
            str(item.get("name")): str(item.get("id"))
            for item in await client.list_views(table_id)
            if item.get("name") and item.get("id")
        }
        view_id = views.get(view.name)
        if view_id is None:
            view_id = await client.create_view(table_id, view.name, filter_payload)
        current_filter = await client.get_view_filter(table_id, view_id)
        current_conditions = current_filter.get("conditions", [])
        normalized_conditions = [
            [field_ids.get(str(condition[0]), condition[0]), *condition[1:]]
            if isinstance(condition, list) and condition
            else condition
            for condition in current_conditions
        ]
        normalized_filter = {
            "logic": current_filter.get("logic", "and"),
            "conditions": normalized_conditions,
        }
        if normalized_filter == filter_payload:
            continue
        # Newly-created views can take a moment to become addressable by the
        # filter endpoint; tolerate that short eventual-consistency window.
        for attempt in range(3):
            try:
                await client.update_view(table_id, view_id, filter_payload)
                break
            except FeishuAPIError as exc:
                code = exc.body.get("code") if isinstance(exc.body, dict) else None
                if code == 800004135:
                    incompatible.append(
                        f"{view.table}.{view.name}: view filter update is limited for the application identity"
                    )
                    break
                if attempt == 2 or code != 800030501:
                    raise
                await asyncio.sleep(1.0)
    return BootstrapPlan(
        len(schema.tables),
        sum(len(table.fields) for table in schema.tables),
        tuple(item.name for item in ALL_VIEWS),
        incompatible=tuple(incompatible),
    )


def _field_incompatibility(
    field_schema: FieldSchema, remote: Mapping[str, Any], table_ids: Mapping[str, str]
) -> str | None:
    if remote.get("type") != field_schema.type:
        return f"type {remote.get('type')} != {field_schema.type}"
    if field_schema.type == "select" and bool(remote.get("multiple", False)) != (
        field_schema.multiple or field_schema.key in MULTI_SELECT_KEYS
    ):
        return "select multiple differs"
    if field_schema.type == "link" and remote.get("link_table") != table_ids.get(
        field_schema.link_table or ""
    ):
        return "link target differs"
    if field_schema.type == "text" and field_schema.style_type is not None:
        style = remote.get("style", {})
        if not isinstance(style, dict) or style.get("type") != field_schema.style_type:
            return "text style differs"
    if (
        field_schema.type == "formula"
        and remote.get("expression") != field_schema.expression
    ):
        return "formula expression differs"
    return None
