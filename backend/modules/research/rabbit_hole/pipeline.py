"""Durable orchestration for Rabbit Hole research workflows.

The module separates deterministic workflow decisions from the mutable
Feishu transport. ``FeishuMutation.state`` is chosen only by the state
machine; inferred extraction values can appear only in automation-owned
fields and evidence snapshots.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any, ClassVar, Literal, Protocol, cast
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from rabbit_hole.config import MarketSettings
from rabbit_hole.discovery import (
    Keyword,
    NicheCandidate,
    StructuredGenerator,
    generate_niche_candidates,
    generate_seed_batch,
    niche_research_queries,
    normalize_keyword,
)
from rabbit_hole.domain.legacy import Clock, EvidenceTrust, Job, JobKind, SystemClock
from rabbit_hole.extraction import ExtractionInput, ProductExtraction
from rabbit_hole.input_urls import canonical_research_url, canonical_supplier_inputs
from rabbit_hole.integrations.collectors.base import CollectorError, CollectorResult
from rabbit_hole.integrations.collectors.google import GoogleTrendsEvidence
from rabbit_hole.integrations.collectors.landing import LandingSnapshot
from rabbit_hole.integrations.collectors.meta import (
    CoarseScreenResult,
    MetaProductGroup,
    MetaQuery,
    SearchBatchResult,
    coarse_screen,
    group_ads,
)
from rabbit_hole.integrations.feishu import (
    AUTO_FIELD_PREFIX,
    FIELD_MAPPERS,
    RecordVersion,
    WriteConflict,
    protected_input_hash,
)
from rabbit_hole.persistence.legacy_jobs import StaleLeaseError
from rabbit_hole.scoring import (
    EvaluationInput,
    EvaluationResult,
    EvidenceSnapshot,
    evaluate,
)
from rabbit_hole.trends import TrendLabel

CHECKPOINT_STAGES = (
    "identify_link",
    "meta",
    "landing",
    "trends",
    "extract",
    "evaluate",
    "writeback",
)
RULE_VERSION = "phase1-v2"

_FINAL_POOLS = frozenset({"测试池", "备选池", "淘汰池"})
_REASONED_REVIEW_TARGETS = frozenset({*_FINAL_POOLS, "观察池"})
_REVALIDATION_SOURCES = frozenset(
    {
        "待识别具体产品",
        "待确认创意",
        "待询价",
        "待补充证据",
        "观察池",
        "输入已变更",
        "需人工处理",
        "待人工复核",
        *_FINAL_POOLS,
    }
)
_ORDER_MISSING_FIELDS = frozenset(
    {
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
        "payment_percent",
        "payment_fixed",
        "loss_reserve_percent",
    }
)


class ForbiddenTransition(ValueError):
    """The requested workflow edge is not allowed for that actor."""


class ReasonRequired(ValueError):
    """A human final-pool action omitted its audit reason."""


class RevalidationRequired(ValueError):
    """A new evidence run was attempted without an explicit human trigger."""


class RetryablePipelineError(RuntimeError):
    """An infrastructure failure that the queue may retry."""

    def __init__(
        self,
        code: str,
        detail: str,
        *,
        attempt: int | None = None,
        retry_kind: JobKind | None = None,
    ) -> None:
        self.code = _bounded_text(code, 80)
        self.detail = _bounded_text(detail, 500)
        self.attempt = attempt
        self.retry_kind = retry_kind
        super().__init__(self.detail)


class TerminalPipelineError(RuntimeError):
    """A typed non-retryable job failure requiring human action."""

    def __init__(self, code: str, detail: str) -> None:
        self.code = _bounded_text(code, 80)
        self.detail = _bounded_text(detail, 500)
        super().__init__(self.detail)


class StateMachine:
    """Pure transition guard; AI output never selects an edge."""

    # This is an internal boundary sentinel, never a value written to Feishu.
    # It makes record creation explicit instead of treating an absent source
    # state as permission to select any table status.
    INITIAL_STATE: ClassVar[str] = "新建"

    _allowed: frozenset[tuple[str, str, str]] = frozenset(
        {
            ("待生成", "待研究", "automation"),
            ("待研究", "待人工选择", "automation"),
            ("待人工选择", "已启用", "human"),
            ("待人工选择", "暂停", "human"),
            ("待审核", "已启用", "human"),
            ("已启用", "待扫描", "human"),
            ("已启用", "暂停", "human"),
            ("待扫描", "扫描中", "automation"),
            ("待扫描", "输入已变更", "automation"),
            ("扫描中", "已启用", "automation"),
            ("扫描中", "输入已变更", "automation"),
            ("扫描中", "降频", "automation"),
            ("扫描中", "建议暂停", "automation"),
            ("扫描中", "暂停", "human"),
            ("建议暂停", "暂停", "human"),
            ("暂停", "已启用", "human"),
            ("降频", "待扫描", "human"),
            ("待执行", "执行中", "automation"),
            ("执行中", "已完成", "automation"),
            ("执行中", "待延迟重试", "automation"),
            ("执行中", "需人工处理", "automation"),
            ("待延迟重试", "执行中", "automation"),
            ("待补充", "开始验证", "human"),
            ("待生成", "输入已变更", "automation"),
            ("待研究", "输入已变更", "automation"),
            ("开始验证", "输入已变更", "automation"),
            ("开始验证", "队列中", "automation"),
            ("队列中", "输入已变更", "automation"),
            ("队列中", "采集中", "automation"),
            ("采集中", "待识别具体产品", "automation"),
            ("采集中", "待确认创意", "automation"),
            ("采集中", "待询价", "automation"),
            ("采集中", "待补充证据", "automation"),
            ("待补充证据", "采集中", "automation"),
            # Observation is the conservative coarse-screen outcome, not an
            # automated final rejection.
            ("采集中", "观察池", "automation"),
            ("采集中", "待评分", "automation"),
            ("采集中", "输入已变更", "automation"),
            ("采集中", "需人工处理", "automation"),
            ("待评分", "待人工复核", "automation"),
            ("待人工复核", "测试池", "human"),
            ("待人工复核", "备选池", "human"),
            ("待人工复核", "观察池", "human"),
            ("待人工复核", "淘汰池", "human"),
            ("待人工复核", "待补充", "human"),
        }
    )

    _table_states: ClassVar[dict[str, frozenset[str]]] = {
        "细分领域池": frozenset(
            {"待生成", "待研究", "待人工选择", "已启用", "暂停", "输入已变更"}
        ),
        "关键词库": frozenset(
            {
                "待审核",
                "已启用",
                "待扫描",
                "扫描中",
                "降频",
                "建议暂停",
                "暂停",
                "输入已变更",
            }
        ),
        "搜索批次": frozenset(
            {"待执行", "执行中", "已完成", "待延迟重试", "需人工处理"}
        ),
        "产品主表": frozenset({"待识别具体产品", "待确认创意", "待补充"}),
        "市场评估表": frozenset(
            {
                "待补充",
                "开始验证",
                "队列中",
                "采集中",
                "待识别具体产品",
                "待确认创意",
                "待询价",
                "待补充证据",
                "待评分",
                "输入已变更",
                "需人工处理",
                "待人工复核",
                "测试池",
                "备选池",
                "观察池",
                "淘汰池",
            }
        ),
        "广告与素材": frozenset({"已采集"}),
        "证据表": frozenset({"待确认", "已确认", "已过期"}),
        "供应商报价": frozenset({"待人工选择", "已采用", "未采用"}),
        "评分记录": frozenset({"待人工复核", "已复核"}),
    }

    # Tables below are append-only observations or newly discovered records.
    # The allowed initial values deliberately exclude human final decisions and
    # active workflow states.  Any existing record must use ``update`` or an
    # observed-state ``upsert`` and therefore traverse ``_allowed``.
    _initial_states: ClassVar[dict[str, frozenset[str]]] = {
        "细分领域池": frozenset({"待研究"}),
        "关键词库": frozenset({"待审核"}),
        "搜索批次": frozenset({"待执行", "已完成", "待延迟重试", "需人工处理"}),
        "产品主表": frozenset({"待识别具体产品", "待确认创意", "待补充"}),
        "市场评估表": frozenset(
            {"待识别具体产品", "待确认创意", "待询价", "待补充证据", "观察池"}
        ),
        "广告与素材": frozenset({"已采集"}),
        "证据表": frozenset({"待确认"}),
        "评分记录": frozenset({"待人工复核"}),
    }

    def validate_state(self, target: str, *, table: str | None = None) -> str:
        """Validate closed state values before any Feishu mutation."""

        if table is not None:
            allowed = self._table_states.get(table)
            if allowed is not None and target not in allowed:
                raise ForbiddenTransition(
                    f"unknown state {target!r} for Feishu table {table!r}"
                )
            if allowed is None:
                known = frozenset().union(*self._table_states.values())
                if target not in known:
                    raise ForbiddenTransition(f"unknown Feishu state {target!r}")
        return target

    def transition(
        self,
        current: str,
        target: str,
        *,
        actor: str,
        reason: str | None = None,
        explicit_revalidation: bool = False,
        revalidate: bool | None = None,
        table: str | None = None,
    ) -> str:
        self.validate_state(target, table=table)
        if current == self.INITIAL_STATE:
            allowed = self._initial_states.get(table or "")
            if actor != "automation" or allowed is None or target not in allowed:
                raise ForbiddenTransition(
                    f"{target!r} is not an allowed initial state for {table!r}"
                )
            return target
        self.validate_state(current, table=table)
        if revalidate is not None:
            explicit_revalidation = explicit_revalidation or revalidate
        if target == "开始验证" and current in _REVALIDATION_SOURCES:
            if actor != "human":
                raise ForbiddenTransition(
                    "only a human can explicitly start revalidation"
                )
            if not explicit_revalidation:
                raise RevalidationRequired(
                    f"{current} requires an explicit revalidation trigger"
                )
            return target
        edge = (current, target, actor)
        if edge not in self._allowed:
            raise ForbiddenTransition(
                f"forbidden transition {current!r} -> {target!r} by {actor!r}"
            )
        if (
            current == "待人工复核"
            and target in _REASONED_REVIEW_TARGETS
            and not (reason or "").strip()
        ):
            raise ReasonRequired(f"a reason is required for {target}")
        return target


class FeishuMutation(BaseModel):
    """One deterministic, idempotent mutation at the Feishu boundary.

    ``fields`` accepts automation-owned columns only. ``state`` is separate so
    an adapter can apply the guarded transition without treating inferred
    output as a human field update.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    operation_key: str
    table: str
    action: Literal["create", "upsert", "update"]
    record_id: str | None = None
    unique_key: str | None = None
    expected_version: str | None = None
    state: str
    current_state: str
    actor: Literal["automation", "human"]
    explicit_revalidation: bool
    fields: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _validate_boundary(self) -> FeishuMutation:
        if not self.operation_key.strip():
            raise ValueError("operation_key must not be empty")
        state_machine = StateMachine()
        if self.action == "create":
            if not self.unique_key:
                raise ValueError("creates require a unique_key")
            if self.current_state != StateMachine.INITIAL_STATE:
                raise ValueError("creates require the explicit new-record state")
            state_machine.transition(
                self.current_state,
                self.state,
                actor=self.actor,
                explicit_revalidation=self.explicit_revalidation,
                table=self.table,
            )
        else:
            if self.current_state == StateMachine.INITIAL_STATE:
                if self.action == "upsert":
                    raise ValueError(
                        "upserts require an observed state; use action='create'"
                    )
                raise ValueError("updates require an observed current_state")
            if self.current_state != self.state:
                state_machine.transition(
                    self.current_state,
                    self.state,
                    actor=self.actor,
                    explicit_revalidation=self.explicit_revalidation,
                    table=self.table,
                )
            else:
                state_machine.validate_state(self.state, table=self.table)
        if any(not name.startswith(AUTO_FIELD_PREFIX) for name in self.fields):
            raise ValueError("pipeline mutations may contain only AUTO fields")
        if self.action == "update":
            if not self.record_id or self.expected_version is None:
                raise ValueError("updates require record_id and expected_version")
        elif not self.unique_key:
            raise ValueError("upserts require a unique_key")
        return self


class PipelineResult(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    status: str
    suggestion: str | None = None
    missing_fields: tuple[str, ...] = ()
    evidence: dict[str, Any] = Field(default_factory=dict)
    score: dict[str, Any] | None = None
    retryable: bool = False
    needs_human: bool = False
    failure_code: str | None = None
    retry_attempt: int | None = Field(default=None, ge=1, le=6)
    retry_kind: JobKind | None = None
    checkpoint_stage: Literal["writeback"] = "writeback"


class CheckpointRepository(Protocol):
    async def checkpoint(
        self,
        job_id: UUID,
        stage: str,
        data: dict[str, Any],
        *,
        worker: str,
        lease_token: UUID | None,
    ) -> None: ...

    async def get_checkpoint(
        self, job_id: UUID, stage: str
    ) -> dict[str, Any] | None: ...


class FeishuWorkflow(Protocol):
    async def get_record(self, table: str, record_id: str) -> RecordVersion: ...

    async def apply(self, mutation: FeishuMutation) -> str: ...


class MetaCollector(Protocol):
    async def collect(
        self,
        query: MetaQuery,
        *,
        job_id: UUID,
        record_id: str,
        worker: str,
        lease_token: UUID | None,
        attempt: int = 1,
        manage_retries: bool = True,
        checkpoint_scope: str | None = None,
    ) -> CollectorResult[SearchBatchResult]: ...


class LandingCollector(Protocol):
    async def collect(self, url: str) -> CollectorResult[LandingSnapshot]: ...


class TrendsCollector(Protocol):
    async def collect(
        self,
        query: str,
        geo: str = "US",
        windows: Sequence[str] = ("12m", "5y"),
        synonyms: Sequence[str] = (),
    ) -> CollectorResult[GoogleTrendsEvidence]: ...


class ProductExtractor(Protocol):
    async def extract(
        self, source: ExtractionInput
    ) -> ProductExtraction | Mapping[str, Any]: ...


class StoredEvidenceReference(Protocol):
    object_id: str


class EvidenceWriter(Protocol):
    def put(
        self,
        *,
        market: str,
        record_id: str,
        collected_at: datetime,
        raw: bytes,
        source_url: str,
        content_type: str,
    ) -> StoredEvidenceReference: ...


class Pipeline:
    """Run one leased job through resumable, idempotent stage checkpoints."""

    def __init__(
        self,
        *,
        jobs: CheckpointRepository,
        feishu: FeishuWorkflow,
        meta_collector: MetaCollector | None = None,
        landing_collector: LandingCollector | None = None,
        trends_collector: TrendsCollector | None = None,
        extractor: ProductExtractor | None = None,
        discovery_generator: StructuredGenerator | None = None,
        storage: EvidenceWriter | None = None,
        market: MarketSettings | None = None,
        clock: Clock | None = None,
        state_machine: StateMachine | None = None,
        niche_count: int = 12,
    ) -> None:
        if niche_count < 1:
            raise ValueError("niche_count must be positive")
        self._jobs = jobs
        self._feishu = feishu
        self._meta = meta_collector
        self._landing = landing_collector
        self._trends = trends_collector
        self._extractor = extractor
        self._discovery_generator = discovery_generator
        self._storage = storage
        self._market = market
        self._clock = clock or SystemClock()
        self._states = state_machine or StateMachine()
        self._niche_count = niche_count

    async def run(self, job: Job) -> PipelineResult:
        """Resume or execute one leased job and persist ``writeback`` last."""

        self._require_lease(job)
        existing = await self._jobs.get_checkpoint(job.id, "writeback")
        if existing is not None and existing.get("status") == "complete":
            value = existing.get("result")
            if not isinstance(value, dict):
                raise TerminalPipelineError(
                    "checkpoint_corrupt", "writeback result is not an object"
                )
            return PipelineResult.model_validate(value)
        intents = await self._jobs.get_checkpoint(job.id, "mutation_intents") or {}
        for intent in intents.values():
            await self._apply(job, FeishuMutation.model_validate(intent["mutation"]))
        if job.payload.market != "US":
            raise TerminalPipelineError(
                "unsupported_market", "Phase 1 executes only the US market"
            )
        if job.payload.kind is JobKind.NICHE_DISCOVERY:
            return await self._run_niche(job)
        if job.payload.kind is JobKind.NICHE_RESEARCH:
            return await self._run_niche_research(job)
        if job.payload.kind is JobKind.KEYWORD_SEED:
            return await self._run_seeds(job)
        if job.payload.kind is JobKind.KEYWORD_SCAN:
            return await self._run_keyword(job)
        if job.payload.kind is JobKind.LINK_VALIDATION:
            return await self._run_link(job)
        raise TerminalPipelineError(
            "unsupported_job_kind", f"Pipeline cannot run {job.payload.kind.value}"
        )

    async def _run_niche_research(self, job: Job) -> PipelineResult:
        """Consume bounded Phase 1 research without creating/scanning seed keywords."""
        current = await self._feishu.get_record("细分领域池", job.payload.record_id)
        if await self._input_changed(job, current):
            return await self._write_input_changed(job, current, evidence={})
        state = _record_state("细分领域池", current)
        own_progress = await self._jobs.get_checkpoint(job.id, "source_progress")
        if state != "待研究" and not (state == "待人工选择" and own_progress):
            raise TerminalPipelineError(
                "research_state_changed",
                "Niche research requires a pending research card",
            )
        try:
            card = json.loads(str(job.payload.data.get("AUTO｜研究证据卡", "")))
            queries = niche_research_queries(card)
            generic = str(card["generic_term"]).strip()
            if not generic:
                raise ValueError("missing generic term")
        except (KeyError, TypeError, ValueError):
            raise TerminalPipelineError(
                "research_card_incomplete",
                "Research card requires a generic term and 5–10 distinct representative queries",
            ) from None
        trends_stage, trends = await self._collect_trends(job, generic, ())
        trend_refs = await self._write_source_evidence(
            job, trends_stage, source_type="Trends"
        )
        observations: list[dict[str, Any]] = []
        meta_refs: list[str] = []
        all_ads: dict[str, Any] = {}
        retry_stage: dict[str, Any] | None = None
        for index, query in enumerate(queries):
            if retry_stage is not None:
                observations.append(
                    {
                        "query": query,
                        "status": "pending",
                        "advertisers": None,
                        "creatives": None,
                        "source": [],
                    }
                )
                continue
            stage, batch = await self._collect_meta(
                job, MetaQuery(query=query, max_ads=100), scope=f"research_meta_{index}"
            )
            references = await self._write_source_evidence(
                job, stage, source_type="Meta"
            )
            meta_refs.extend(references)
            counts = None if batch is None else len({ad.advertiser for ad in batch.ads})
            creatives = (
                None
                if batch is None
                else len({ad.media_hash for ad in batch.ads if ad.media_hash}) or None
            )
            observations.append(
                {
                    "query": query,
                    "status": stage["status"],
                    "advertisers": counts,
                    "creatives": creatives,
                    "truncated": batch.truncated if batch else None,
                    "coverage_verified": batch.competition_verified if batch else False,
                    "source": list(references),
                    "failure": stage.get("error"),
                }
            )
            if batch is not None:
                all_ads.update({ad.ad_id: ad for ad in batch.ads})
            elif _stage_is_retryable(stage):
                retry_stage = stage
        complete = all(item["status"] == "complete" for item in observations)
        trend_ok = trends is not None and not trends.errors
        trend_label = trends.label.value if trend_ok and trends else "unknown"
        positive_trend = trend_label in {"rising", "stable-high", "seasonal"}
        priority = (
            "medium" if complete and trend_ok and positive_trend and all_ads else "low"
        )
        reasons = {
            "trends": trend_label,
            "meta": f"{sum(item['status'] == 'complete' for item in observations)}/{len(queries)} queries observed; coverage and truncation retained per query",
            "creative_space": "only observed media fingerprints counted; inaccessible media remains unknown",
            "logistics_compliance": "preliminary warnings are inferred; human feasibility confirmation required",
            "supply_chain": "unknown without supplier sample; priority cannot be high",
        }
        card.update(
            {
                "trends": {
                    "conclusion": trend_label,
                    "source": list(trend_refs),
                    "errors": [error.code for error in trends.errors]
                    if trends
                    else ["unavailable"],
                },
                "meta": {
                    "representative_keywords": list(queries),
                    "observations": observations,
                    "source": meta_refs,
                    "observed_ad_ids": sorted(all_ads),
                    "advertisers": len({ad.advertiser for ad in all_ads.values()})
                    if complete
                    else None,
                    "creatives": len(
                        {ad.media_hash for ad in all_ads.values() if ad.media_hash}
                    )
                    or None
                    if complete
                    else None,
                    "coverage": "observed sample, not exhaustive",
                },
                "supply_chain": "unknown",
                "priority": priority,
                "priority_reasons": reasons,
                "research_required": not (complete and trend_ok),
                "research_job": str(job.id),
            }
        )
        await self._checkpoint(
            job,
            "evaluate",
            {
                "status": "complete" if complete and trend_ok else "incomplete",
                "value": card,
            },
        )
        latest = await self._feishu.get_record("细分领域池", job.payload.record_id)
        if await self._input_changed(job, latest):
            return await self._write_input_changed(
                job, latest, evidence={"research": card}
            )
        target = "待研究" if retry_stage else "待人工选择"
        await self._apply_source_update(
            job,
            table="细分领域池",
            current_state=_record_state("细分领域池", latest),
            state=target,
            expected_version=latest.version,
            suffix=f"research-{job.attempt}",
            fields=_fields(
                "细分领域池",
                {
                    "research_card": json.dumps(
                        card, ensure_ascii=False, sort_keys=True
                    ),
                    "priority": "中" if priority == "medium" else "低",
                    "recommendation": json.dumps(reasons, ensure_ascii=False),
                    "trend_evidence": list(trend_refs),
                    "competition_evidence": meta_refs,
                    "supply_availability": "未知",
                },
            ),
        )
        outcome = (
            _pipeline_failure_fields(retry_stage)
            if retry_stage
            else {"needs_human": not (complete and trend_ok)}
        )
        result = PipelineResult(status=target, evidence={"research": card}, **outcome)
        await self._checkpoint_result(job, result)
        return result

    async def _run_seeds(self, job: Job) -> PipelineResult:
        current = await self._feishu.get_record("细分领域池", job.payload.record_id)
        if await self._input_changed(job, current):
            return await self._write_input_changed(job, current, evidence={})
        if (
            _record_state("细分领域池", current) != "已启用"
            or current.fields.get("人工｜研究证据已确认") is not True
        ):
            raise TerminalPipelineError(
                "niche_approval_required",
                "Human niche approval and research confirmation are required",
            )
        if current.fields.get(FIELD_MAPPERS["细分领域池"]["niche_key"]):
            try:
                automatic = json.loads(str(current.fields.get("AUTO｜研究证据卡", "")))
                research = await self._jobs.get_checkpoint(
                    UUID(automatic["research_job"]), "evaluate"
                )
                if not research or research.get("value") != automatic:
                    raise ValueError("research checkpoint missing or changed")
            except (ValueError, TypeError, KeyError):
                raise TerminalPipelineError(
                    "system_research_required",
                    "System research must run for a generated niche before seed generation",
                ) from None
        try:
            card = json.loads(
                str(
                    current.fields.get("人工｜研究证据卡")
                    or current.fields.get("AUTO｜研究证据卡", "")
                )
            )
            if (
                not all(
                    key in card
                    for key in (
                        "generic_term",
                        "target_audience",
                        "core_problem",
                        "filming_scenarios",
                        "potential_price_band",
                        "logistics_warnings",
                        "compliance_warnings",
                        "trends",
                        "meta",
                    )
                )
                or not (card["trends"]["source"] and card["meta"]["source"])
                or not 5 <= len(card["meta"]["representative_keywords"]) <= 10
            ):
                raise ValueError("missing research evidence")
        except (ValueError, TypeError, KeyError):
            raise TerminalPipelineError(
                "research_card_incomplete",
                "Confirmed research card needs Trends and 5–10 Meta query observations",
            ) from None
        prior = await self._jobs.get_checkpoint(job.id, "extract")
        if prior is None:
            if self._discovery_generator is None:
                raise TerminalPipelineError(
                    "missing_discovery_generator",
                    "Seed generation requires structured generator",
                )
            keywords = await generate_seed_batch(
                self._discovery_generator,
                niche=NicheCandidate(
                    name=str(current.fields.get("AUTO｜细分领域", "")), enabled=True
                ),
                source_niche_record_id=job.payload.record_id,
            )
            await self._checkpoint(
                job,
                "extract",
                {"status": "complete", "value": [_json(item) for item in keywords]},
            )
        else:
            keywords = [Keyword.model_validate(item) for item in prior["value"]]
        for keyword in keywords:
            key = f"US|en|{keyword.normalized_keyword}"
            await self._apply(
                job,
                FeishuMutation(
                    operation_key=self._operation_key(job, "seed", key),
                    table="关键词库",
                    action="create",
                    unique_key=key,
                    state="待审核",
                    current_state=StateMachine.INITIAL_STATE,
                    actor="automation",
                    explicit_revalidation=False,
                    fields={
                        **keyword.to_feishu_fields(
                            source_niche_record_id=job.payload.record_id
                        ),
                        FIELD_MAPPERS["关键词库"]["keyword_key"]: key,
                    },
                ),
            )
        await self._apply_source_update(
            job,
            table="细分领域池",
            expected_version=current.version,
            current_state="已启用",
            state="已启用",
            fields={FIELD_MAPPERS["细分领域池"]["seed_batch"]: str(job.id)},
        )
        result = PipelineResult(
            status="已启用",
            evidence={"keywords": len(keywords), "human_research_card": card},
        )
        await self._checkpoint_result(job, result)
        return result

    async def _run_niche(self, job: Job) -> PipelineResult:
        await self._skip(job, "identify_link", "niche initialization")
        await self._skip(job, "meta", "niche initialization")
        await self._skip(job, "landing", "niche initialization")
        await self._skip(job, "trends", "niche initialization")
        extraction = await self._jobs.get_checkpoint(job.id, "extract")
        candidates: list[NicheCandidate]
        if extraction is not None and extraction.get("status") == "complete":
            value = extraction.get("value")
            if not isinstance(value, list):
                raise TerminalPipelineError(
                    "checkpoint_corrupt", "niche extraction is not a list"
                )
            candidates = [NicheCandidate.model_validate(item) for item in value]
        else:
            if self._discovery_generator is None:
                raise TerminalPipelineError(
                    "missing_discovery_generator",
                    "niche discovery requires a structured generator",
                )
            candidates = await generate_niche_candidates(
                self._discovery_generator,
                market="US",
                count=self._niche_count,
                category_key=_first_text(job.payload.data, "人工｜选择大类"),
            )
            await self._checkpoint(
                job,
                "extract",
                {
                    "status": "complete",
                    "kind": "niche_candidates",
                    "value": [_json(item) for item in candidates],
                },
            )
        await self._checkpoint(
            job,
            "evaluate",
            {
                "status": "skipped",
                "reason": "niche candidates require human research",
            },
        )
        current = await self._feishu.get_record("细分领域池", job.payload.record_id)
        if await self._input_changed(job, current):
            return await self._write_input_changed(job, current, evidence={})
        for index, candidate in enumerate(candidates):
            key = "|".join(
                (
                    candidate.market,
                    candidate.category_key or "uncategorized",
                    normalize_keyword(candidate.name),
                )
            )
            fields = {
                **candidate.to_feishu_fields(),
                FIELD_MAPPERS["细分领域池"]["niche_key"]: key,
            }
            await self._apply(
                job,
                FeishuMutation(
                    operation_key=self._operation_key(job, "niche", str(index)),
                    table="细分领域池",
                    action="create",
                    unique_key=key,
                    current_state=StateMachine.INITIAL_STATE,
                    state="待研究",
                    actor="automation",
                    explicit_revalidation=False,
                    fields=fields,
                ),
            )
        self._states.transition(
            _record_state("细分领域池", current),
            "待研究",
            actor="automation",
            table="细分领域池",
        )
        try:
            await self._apply_source_update(
                job,
                table="细分领域池",
                expected_version=current.version,
                state="待研究",
                fields={},
                current_state=_record_state("细分领域池", current),
            )
        except WriteConflict:
            latest = await self._feishu.get_record("细分领域池", job.payload.record_id)
            return await self._write_input_changed(job, latest, evidence={})
        result = PipelineResult(
            status="待研究", evidence={"generated_candidates": len(candidates)}
        )
        await self._checkpoint_result(job, result)
        return result

    async def _run_keyword(self, job: Job) -> PipelineResult:
        await self._skip(job, "identify_link", "keyword scan")
        data = job.payload.data
        query_text = _first_text(
            data,
            "query",
            "search_text",
            FIELD_MAPPERS["关键词库"]["search_text"],
        )
        if query_text is None:
            raise TerminalPipelineError(
                "missing_keyword", "keyword scan needs an actual search query"
            )
        synonyms = _synonyms(
            _value(
                data,
                "approved_synonyms",
                "synonym_variants",
                FIELD_MAPPERS["市场评估表"]["approved_synonyms"],
                FIELD_MAPPERS["关键词库"]["synonym_variants"],
            )
        )
        meta_stage, batch = await self._collect_meta(
            job, MetaQuery(query=query_text, approved_synonyms=synonyms)
        )
        await self._skip(job, "landing", "keyword scan stops after Meta grouping")
        await self._skip(job, "trends", "keyword scan stops before market evaluation")
        await self._skip(job, "extract", "keyword scan stops before product extraction")
        if batch is None:
            await self._checkpoint(
                job,
                "evaluate",
                {
                    "status": "complete",
                    "value": {
                        "groups": [],
                        "source_error": meta_stage.get("error"),
                    },
                },
            )
            return await self._write_keyword_failure(job, meta_stage)

        decisions = [(group, coarse_screen(group)) for group in group_ads(batch.ads)]
        await self._checkpoint(
            job,
            "evaluate",
            {
                "status": "complete",
                "kind": "coarse_screen",
                "value": [
                    {
                        "group": _json(group),
                        "decision": _json(decision),
                    }
                    for group, decision in decisions
                ],
            },
        )
        current = await self._feishu.get_record("关键词库", job.payload.record_id)
        if await self._input_changed(job, current):
            return await self._write_input_changed(
                job, current, evidence=_stage_evidence(meta_stage)
            )
        await self._write_source_evidence(job, meta_stage, source_type="Meta")
        await self._write_search_batch(job, query_text, batch)
        for group_index, (group, decision) in enumerate(decisions):
            await self._write_meta_group(
                job,
                group,
                decision,
                group_index=group_index,
                keyword_record_id=job.payload.record_id,
            )
        try:
            if _record_state("关键词库", current) == "待扫描":
                current = await self._transition_source_state(
                    job,
                    table="关键词库",
                    current=current,
                    state="扫描中",
                    fields={},
                    suffix="scan-start",
                )
            if _record_state(
                "关键词库", current
            ) == "已启用" and await self._jobs.get_checkpoint(
                job.id, "source_progress"
            ):
                result = PipelineResult(
                    status="已启用", evidence=_stage_evidence(meta_stage)
                )
                await self._checkpoint_result(job, result)
                return result
            if _record_state("关键词库", current) != "扫描中":
                raise RevalidationRequired("keyword scan is no longer in progress")
            await self._transition_source_state(
                job,
                table="关键词库",
                current=current,
                state="已启用",
                fields={
                    FIELD_MAPPERS["关键词库"]["scan_count"]: (
                        _nonnegative_int(
                            current.fields.get(FIELD_MAPPERS["关键词库"]["scan_count"])
                        )
                        + 1
                    ),
                    FIELD_MAPPERS["关键词库"]["ad_hits"]: len(batch.ads),
                    FIELD_MAPPERS["关键词库"]["relevant_ads"]: sum(
                        item.relevance_verified for item in batch.ads
                    ),
                    FIELD_MAPPERS["关键词库"]["ads_30_days"]: sum(
                        item.relevance_verified
                        and item.is_active
                        and (item.observable_active_days or 0) >= 30
                        for item in batch.ads
                    ),
                    FIELD_MAPPERS["关键词库"]["products_3_creatives"]: sum(
                        decision.verified_active_creatives >= 3
                        for _, decision in decisions
                    ),
                    FIELD_MAPPERS["关键词库"]["deep_worthy"]: sum(
                        decision.passed for _, decision in decisions
                    ),
                    FIELD_MAPPERS["关键词库"]["candidate_count"]: len(decisions),
                },
                suffix="scan-complete",
            )
        except WriteConflict:
            latest = await self._feishu.get_record("关键词库", job.payload.record_id)
            return await self._write_input_changed(
                job, latest, evidence=_stage_evidence(meta_stage)
            )
        result = PipelineResult(
            status="已启用",
            evidence=_stage_evidence(meta_stage),
        )
        await self._checkpoint_result(job, result)
        return result

    async def _run_link(self, job: Job) -> PipelineResult:
        links = job.payload.data.get(FIELD_MAPPERS["市场评估表"]["product"])
        if isinstance(links, list) and len(links) == 1 and isinstance(links[0], str):
            linked = await self._jobs.get_checkpoint(job.id, "linked_product")
            if linked is None:
                product = await self._feishu.get_record("产品主表", links[0])
                product_fields, _ = canonical_supplier_inputs(product.fields)
                linked = {
                    "record_id": product.record_id,
                    "version": product.version,
                    "fields": product_fields,
                }
                await self._checkpoint(job, "linked_product", linked)
            hydrated = dict(job.payload.data)
            product_fields = linked["fields"]
            if not _first_text(
                hydrated,
                "人工｜广告或落地页链接",
                "link",
                "url",
                "meta_url",
                "landing_url",
                "人工｜商品链接",
            ):
                hydrated["人工｜广告或落地页链接"] = _first_text(
                    product_fields, "人工｜商品链接", "AUTO｜落地页链接"
                )
            if not _first_text(hydrated, "人工｜产品名称", "product_name"):
                hydrated["人工｜产品名称"] = _first_text(
                    product_fields, "AUTO｜标准产品名称"
                )
            job = replace(
                job, payload=job.payload.model_copy(update={"data": hydrated})
            )
        try:
            identify = await self._identify_link_stage(job)
            raw_link = _required_link(job.payload.data)
            query_text = _query_for_link(job.payload.data, raw_link)
        except TerminalPipelineError as exc:
            if exc.code not in {"missing_query", "missing_link", "invalid_link"}:
                raise
            return await self._stop_product_identification(job)
        value = identify.get("value")
        if not isinstance(value, dict):
            raise TerminalPipelineError(
                "checkpoint_corrupt", "link identity value is invalid"
            )
        link_kind = str(value["kind"])
        synonyms = _synonyms(
            _value(
                job.payload.data,
                "approved_synonyms",
                "synonym_variants",
                FIELD_MAPPERS["市场评估表"]["approved_synonyms"],
                FIELD_MAPPERS["关键词库"]["synonym_variants"],
            )
        )
        meta_stage, batch = await self._collect_meta(
            job,
            MetaQuery(query=query_text, approved_synonyms=synonyms),
        )
        original_batch = batch
        if batch is not None:
            ad_id = (
                parse_qs(urlsplit(raw_link).query).get("id", [None])[0]
                if link_kind == "meta"
                else None
            )
            selected = tuple(
                ad
                for ad in batch.ads
                if (ad_id is not None and ad.ad_id == ad_id)
                or (
                    link_kind == "landing"
                    and _safe_checkpoint_url(
                        ad.final_landing_url
                        or ad.landing_url
                        or "https://invalid.example/"
                    )
                    == _safe_checkpoint_url(raw_link)
                )
            )
            if ad_id is not None and selected:
                target_url = selected[0].final_landing_url or selected[0].landing_url
                target_fingerprint = selected[0].product_fingerprint
                selected = tuple(
                    ad
                    for ad in batch.ads
                    if ad in selected
                    or (
                        target_url
                        and (ad.final_landing_url or ad.landing_url) == target_url
                    )
                    or (
                        target_fingerprint
                        and ad.product_fingerprint == target_fingerprint
                    )
                )
            batch = batch.model_copy(
                update={"ads": selected, "competition_verified": False}
            )
            await self._checkpoint(
                job,
                "identify_link",
                {
                    **identify,
                    "target_ad_ids": [ad.ad_id for ad in selected],
                    "target_supported": bool(selected),
                    "target_url": _safe_checkpoint_url(raw_link),
                },
            )
            if not selected:
                meta_stage = {**meta_stage, "status": "unattributed"}
        if original_batch is not None:
            await self._write_search_batch(job, query_text, original_batch)
        else:
            await self._write_keyword_failure(job, meta_stage)
        landing_url = _landing_url(job.payload.data, raw_link, link_kind, batch)
        landing_stage, landing = await self._collect_landing(job, landing_url)
        trends_stage, trends = await self._collect_trends(job, query_text, synonyms)
        extract_stage, extraction = await self._extract(
            job, landing=landing, batch=batch
        )
        evaluation = await self._evaluate_link(
            job,
            batch=batch,
            landing=landing,
            trends=trends,
            extraction=extraction,
            meta_stage=meta_stage,
            landing_stage=landing_stage,
            trends_stage=trends_stage,
            extract_stage=extract_stage,
        )
        evidence: dict[str, Any] = {
            "meta": _stage_evidence(meta_stage),
            "landing": _stage_evidence(landing_stage),
            "trends": _stage_evidence(trends_stage),
        }
        evaluation_input, _ = self._evaluation_input(job.payload.data)
        supplier_quote_source = (
            evaluation_input.order.supplier_quote_source
            if evaluation_input is not None
            else None
        )
        supplier_quote_trust = (
            _supplier_quote_evidence_trust(evaluation_input)
            if evaluation_input is not None
            else EvidenceTrust.UNKNOWN
        )
        evidence_record_ids = [
            *await self._write_source_evidence(job, meta_stage, source_type="Meta"),
            *await self._write_source_evidence(
                job, landing_stage, source_type="落地页"
            ),
            *await self._write_source_evidence(job, trends_stage, source_type="Trends"),
        ]
        if supplier_quote_source is not None:
            evidence_record_ids.extend(
                await self._write_supplier_quote_evidence(
                    job,
                    source_url=supplier_quote_source,
                    trust=supplier_quote_trust,
                    collected_at=evaluation_input.order.supplier_quote_collected_at
                    if evaluation_input
                    else None,
                )
            )
            evidence["supplier_quote"] = {
                "source_url": supplier_quote_source,
                "record_ids": tuple(evidence_record_ids[-1:]),
            }
        await self._write_score_history(
            job, evaluation, supplier_quote_source=supplier_quote_source
        )

        current = await self._feishu.get_record("市场评估表", job.payload.record_id)
        if await self._input_changed(job, current):
            return await self._write_input_changed(
                job,
                current,
                evidence=evidence,
                evaluation=evaluation,
            )
        status = self._link_status(
            evaluation,
            batch=batch,
            landing=landing,
            meta_stage=meta_stage,
            landing_stage=landing_stage,
            trends_stage=trends_stage,
            extract_stage=extract_stage,
        )
        try:
            if _record_state("市场评估表", current) == "开始验证":
                current = await self._transition_source_state(
                    job,
                    table="市场评估表",
                    current=current,
                    state="队列中",
                    fields={},
                    suffix="queue",
                )
            if _record_state("市场评估表", current) == "队列中":
                current = await self._transition_source_state(
                    job,
                    table="市场评估表",
                    current=current,
                    state="采集中",
                    fields={},
                    suffix="collecting",
                )
            if _record_state("市场评估表", current) == "待补充证据" and job.attempt > 0:
                current = await self._transition_source_state(
                    job,
                    table="市场评估表",
                    current=current,
                    state="采集中",
                    fields={},
                    suffix=f"resume-{job.attempt}",
                )
            if _record_state("市场评估表", current) not in {"采集中", "待评分", status}:
                raise RevalidationRequired("market evaluation is no longer collecting")
            if (
                status == "待人工复核"
                and _record_state("市场评估表", current) == "采集中"
            ):
                current = await self._transition_source_state(
                    job,
                    table="市场评估表",
                    current=current,
                    state="待评分",
                    fields={},
                    suffix="pending-score",
                )
            await self._transition_source_state(
                job,
                table="市场评估表",
                current=current,
                state=status,
                fields=self._evaluation_fields(evaluation, evidence_record_ids),
                suffix=f"final-{job.attempt}",
            )
        except WriteConflict:
            latest = await self._feishu.get_record("市场评估表", job.payload.record_id)
            return await self._write_input_changed(
                job,
                latest,
                evidence=evidence,
                evaluation=evaluation,
            )
        result = PipelineResult(
            status=status,
            suggestion=evaluation.suggestion,
            missing_fields=evaluation.missing_fields,
            evidence=evidence,
            score=_json(evaluation),
            **_pipeline_failure_fields(meta_stage),
        )
        await self._checkpoint_result(job, result)
        return result

    async def _stop_product_identification(self, job: Job) -> PipelineResult:
        current = await self._feishu.get_record("市场评估表", job.payload.record_id)
        if await self._input_changed(job, current):
            return await self._write_input_changed(job, current, evidence={})
        evaluation = EvaluationResult(
            status="待补充证据", missing_fields=("product_identity", "generic_query")
        )
        await self._checkpoint(
            job,
            "evaluate",
            {
                "status": "incomplete",
                "input": job.payload.data,
                "value": _json(evaluation),
            },
        )
        for source, target in (
            ("开始验证", "队列中"),
            ("队列中", "采集中"),
            ("采集中", "待识别具体产品"),
        ):
            if _record_state("市场评估表", current) == source:
                current = await self._transition_source_state(
                    job,
                    table="市场评估表",
                    current=current,
                    state=target,
                    fields=self._evaluation_fields(evaluation, []),
                    suffix=f"identify-{target}",
                )
        result = PipelineResult(
            status="待识别具体产品", missing_fields=evaluation.missing_fields
        )
        await self._checkpoint_result(job, result)
        return result

    async def _collect_meta(
        self, job: Job, query: MetaQuery, *, scope: str | None = None
    ) -> tuple[dict[str, Any], SearchBatchResult | None]:
        stage_key = scope or "meta"
        prior = await self._jobs.get_checkpoint(job.id, stage_key)
        if prior is not None and prior.get("status") == "complete":
            value = prior.get("value")
            if not isinstance(value, dict):
                raise TerminalPipelineError(
                    "checkpoint_corrupt", "Meta checkpoint is not an object"
                )
            return prior, SearchBatchResult.model_validate(value)
        if (
            prior is not None
            and prior.get("status") == "failed"
            and not _stage_is_retryable(prior)
        ):
            return prior, None
        if self._meta is None:
            stage = _failed_stage(
                CollectorError(
                    code="meta_unconfigured",
                    detail="Meta collector is not configured",
                    retriable=False,
                    source="meta-ad-library",
                )
            )
            await self._checkpoint(job, stage_key, stage)
            return stage, None
        attempt = max(1, min(6, job.attempt + 1))
        if scope is not None:
            # One niche-research job consumes several representative Meta
            # observations. A delayed observation resumes its own durable
            # recovery sequence; it must not inherit another query's retry
            # count from the outer queue row.
            recovery = await self._jobs.get_checkpoint(job.id, f"meta_collect:{scope}")
            previous_attempt = _checkpoint_attempt(recovery) or _checkpoint_attempt(
                prior
            )
            attempt = min(6, previous_attempt + 1) if previous_attempt else 1
        try:
            result = await self._meta.collect(
                query,
                job_id=job.id,
                record_id=job.payload.record_id,
                worker=cast(str, job.leased_by),
                lease_token=job.lease_token,
                attempt=attempt,
                # The collector must never clear this lease while the pipeline
                # still has checkpoints and Feishu mutations to persist.  The
                # worker owns the one durable retry transition after return.
                manage_retries=False,
                **({"checkpoint_scope": scope} if scope else {}),
            )
        except StaleLeaseError:
            raise
        except Exception as exc:  # noqa: BLE001 -- a source error is partial evidence
            result = CollectorResult[SearchBatchResult].failure(
                CollectorError(
                    code="meta_exception",
                    detail=type(exc).__name__,
                    source="meta-ad-library",
                )
            )
        if result.ok:
            assert result.value is not None
            archived = self._archive_structured_evidence(
                job,
                "meta",
                result.value,
                source_url="https://www.facebook.com/ads/library/",
            )
            stage = {
                "status": "complete",
                "value": _json(result.value),
                "evidence": {**result.evidence, **archived},
            }
            batch = result.value
        else:
            assert result.error is not None
            stage = _failed_stage(result.error, evidence=result.evidence)
            recovery = await self._jobs.get_checkpoint(
                job.id, f"meta_collect:{scope}" if scope else "meta_collect"
            )
            retry_attempt = _checkpoint_attempt(recovery) or max(
                1, min(6, job.attempt + 1)
            )
            stage["retry_attempt"] = retry_attempt
            stage["retry_kind"] = JobKind.META_SCAN.value
            batch = None
        await self._checkpoint(job, stage_key, stage)
        return stage, batch

    async def _collect_landing(
        self, job: Job, url: str | None
    ) -> tuple[dict[str, Any], LandingSnapshot | None]:
        prior = await self._jobs.get_checkpoint(job.id, "landing")
        if prior is not None and prior.get("input_url") != url:
            prior = None
        if prior is not None and prior.get("status") == "complete":
            value = prior.get("value")
            if not isinstance(value, dict):
                raise TerminalPipelineError(
                    "checkpoint_corrupt", "landing checkpoint is not an object"
                )
            return prior, LandingSnapshot.model_validate(value)
        if prior is not None and prior.get("status") == "failed":
            return prior, None
        if self._landing is None or url is None:
            stage = _failed_stage(
                CollectorError(
                    code="landing_unavailable",
                    detail=(
                        "Landing collector is not configured"
                        if self._landing is None
                        else "No landing URL was identified"
                    ),
                    retriable=False,
                    source="landing",
                )
            )
            stage["input_url"] = url
            await self._checkpoint(job, "landing", stage)
            return stage, None
        try:
            result = await self._landing.collect(url)
        except StaleLeaseError:
            raise
        except Exception as exc:  # noqa: BLE001 -- preserve other source results
            result = CollectorResult[LandingSnapshot].failure(
                CollectorError(
                    code="landing_exception",
                    detail=type(exc).__name__,
                    source="landing",
                )
            )
        if result.ok:
            assert result.value is not None
            archived = self._archive_structured_evidence(
                job,
                "landing",
                result.value,
                source_url=result.value.final_url,
            )
            stage = {
                "status": "complete",
                "value": _json(result.value),
                "evidence": {**result.evidence, **archived},
            }
            snapshot = result.value
        else:
            assert result.error is not None
            stage = _failed_stage(result.error, evidence=result.evidence)
            snapshot = None
        stage["input_url"] = url
        await self._checkpoint(job, "landing", stage)
        return stage, snapshot

    async def _collect_trends(
        self, job: Job, query: str, synonyms: tuple[str, ...]
    ) -> tuple[dict[str, Any], GoogleTrendsEvidence | None]:
        prior = await self._jobs.get_checkpoint(job.id, "trends")
        if prior is not None and prior.get("status") == "complete":
            value = prior.get("value")
            if not isinstance(value, dict):
                raise TerminalPipelineError(
                    "checkpoint_corrupt", "Trends checkpoint is not an object"
                )
            return prior, GoogleTrendsEvidence.model_validate(value)
        if prior is not None and prior.get("status") == "failed":
            return prior, None
        if self._trends is None:
            stage = _failed_stage(
                CollectorError(
                    code="trends_unconfigured",
                    detail="Google Trends collector is not configured",
                    retriable=False,
                    source="google-trends",
                )
            )
            await self._checkpoint(job, "trends", stage)
            return stage, None
        try:
            result = await self._trends.collect(
                query, geo="US", windows=("12m", "5y"), synonyms=synonyms
            )
        except StaleLeaseError:
            raise
        except Exception as exc:  # noqa: BLE001 -- preserve other source results
            result = CollectorResult[GoogleTrendsEvidence].failure(
                CollectorError(
                    code="trends_exception",
                    detail=type(exc).__name__,
                    source="google-trends",
                )
            )
        if result.ok:
            assert result.value is not None
            archived = self._archive_structured_evidence(
                job,
                "trends",
                result.value,
                source_url="https://trends.google.com/trends/explore",
            )
            stage = {
                "status": "complete",
                "value": _json(result.value),
                "evidence": {**result.evidence, **archived},
            }
            evidence = result.value
        else:
            assert result.error is not None
            stage = _failed_stage(result.error, evidence=result.evidence)
            evidence = None
        await self._checkpoint(job, "trends", stage)
        return stage, evidence

    async def _extract(
        self,
        job: Job,
        *,
        landing: LandingSnapshot | None,
        batch: SearchBatchResult | None,
    ) -> tuple[dict[str, Any], ProductExtraction | Mapping[str, Any] | None]:
        prior = await self._jobs.get_checkpoint(job.id, "extract")
        dependencies = _digest(
            {"landing": landing, "ads": batch.ads if batch else None}
        )
        if prior is not None and prior.get("dependencies") != dependencies:
            prior = None
        if prior is not None and prior.get("status") == "complete":
            value = prior.get("value")
            if not isinstance(value, dict):
                raise TerminalPipelineError(
                    "checkpoint_corrupt", "extraction checkpoint is not an object"
                )
            return prior, value
        if prior is not None and prior.get("status") == "failed":
            return prior, None
        if self._extractor is None or (landing is None and batch is None):
            stage = _failed_stage(
                CollectorError(
                    code="extraction_unavailable",
                    detail=(
                        "Product extractor is not configured"
                        if self._extractor is None
                        else "No source snapshot is available for extraction"
                    ),
                    retriable=False,
                    source="extraction",
                )
            )
            stage["dependencies"] = dependencies
            await self._checkpoint(job, "extract", stage)
            return stage, None
        source = ExtractionInput(
            landing=landing,
            meta_ads=() if batch is None else batch.ads,
            captured_at=self._clock.now().astimezone(UTC),
        )
        try:
            extracted = await self._extractor.extract(source)
        except StaleLeaseError:
            raise
        except Exception as exc:  # noqa: BLE001 -- an AI failure is missing evidence
            stage = _failed_stage(
                CollectorError(
                    code="extraction_error",
                    detail=type(exc).__name__,
                    source="extraction",
                )
            )
            stage["dependencies"] = dependencies
            await self._checkpoint(job, "extract", stage)
            return stage, None
        value = _json(extracted)
        if not isinstance(value, dict):
            raise TerminalPipelineError(
                "invalid_extraction", "product extraction must be an object"
            )
        stage = {"status": "complete", "dependencies": dependencies, "value": value}
        await self._checkpoint(job, "extract", stage)
        return stage, cast(Mapping[str, Any], extracted)

    async def _evaluate_link(
        self,
        job: Job,
        *,
        batch: SearchBatchResult | None,
        landing: LandingSnapshot | None,
        trends: GoogleTrendsEvidence | None,
        extraction: ProductExtraction | Mapping[str, Any] | None,
        meta_stage: Mapping[str, Any],
        landing_stage: Mapping[str, Any],
        trends_stage: Mapping[str, Any],
        extract_stage: Mapping[str, Any],
    ) -> EvaluationResult:
        prior = await self._jobs.get_checkpoint(job.id, "evaluate")
        dependencies = _digest(
            {
                "meta": meta_stage,
                "landing": landing_stage,
                "trends": trends_stage,
                "extract": extract_stage,
            }
        )
        if (
            prior is not None
            and prior.get("status") == "complete"
            and prior.get("dependencies") == dependencies
        ):
            value = prior.get("value")
            if not isinstance(value, dict):
                raise TerminalPipelineError(
                    "checkpoint_corrupt", "evaluation checkpoint is not an object"
                )
            return EvaluationResult.model_validate(value)
        base, parsing_missing = self._evaluation_input(job.payload.data)
        missing = list(parsing_missing)
        if meta_stage.get("status") != "complete" or batch is None:
            missing.extend(("active_days", "verified_creatives"))
        if landing_stage.get("status") != "complete" or landing is None:
            missing.append("landing")
        if (
            trends_stage.get("status") != "complete"
            or trends is None
            or trends.label is TrendLabel.INSUFFICIENT_DATA
        ):
            missing.extend(("trend_12m", "trend_5y"))
        if extract_stage.get("status") != "complete" or extraction is None:
            missing.append("extract")
        if base is None:
            result = EvaluationResult.incomplete(_ordered_unique(missing))
        else:
            base = self._merge_deterministic_sources(base, batch=batch, trends=trends)
            deterministic = evaluate(base, now=self._clock.now())
            missing.extend(deterministic.missing_fields)
            result = (
                EvaluationResult.incomplete(_ordered_unique(missing))
                if missing
                else deterministic
            )
        await self._checkpoint(
            job,
            "evaluate",
            {
                "status": "complete",
                "dependencies": dependencies,
                "input": _json(base),
                "sources": {
                    "meta": _json(meta_stage),
                    "landing": _json(landing_stage),
                    "trends": _json(trends_stage),
                    "extract": _json(extract_stage),
                },
                "value": _json(result),
            },
        )
        return result

    def _evaluation_input(
        self, data: Mapping[str, JsonValue]
    ) -> tuple[EvaluationInput | None, tuple[str, ...]]:
        supplied = data.get("evaluation")
        if isinstance(supplied, dict):
            try:
                return EvaluationInput.model_validate(supplied), ()
            except ValueError:
                # A Feishu record may persist the same object as a flat set of
                # display-name fields.  Try the explicit flat mapping below
                # before treating the record as incomplete.
                flattened = self._flat_evaluation_input(data, supplied)
                if flattened is not None:
                    return flattened
                return None, ("evaluation_input",)
        flattened = self._flat_evaluation_input(data)
        if flattened is not None:
            return flattened
        market = self._market
        order = data.get("order")
        evidence = data.get("meta")
        if (
            market is None
            or not isinstance(order, dict)
            or not isinstance(evidence, dict)
        ):
            return None, ("evaluation_input",)
        try:
            return (
                EvaluationInput.model_validate(
                    {
                        "product_name": data.get("product_name"),
                        "market": market.model_dump(mode="json"),
                        "order": order,
                        "meta": evidence,
                    }
                ),
                (),
            )
        except ValueError:
            return None, ("evaluation_input",)

    def _flat_evaluation_input(
        self,
        data: Mapping[str, JsonValue],
        supplied: Mapping[str, Any] | None = None,
    ) -> tuple[EvaluationInput | None, tuple[str, ...]] | None:
        """Build an evaluation from Feishu's display-name fields.

        The API adapter intentionally returns raw record fields so that input
        hashes remain auditable.  This compatibility mapper is therefore kept
        at the pipeline boundary.  Human-entered numeric fields are considered
        human-confirmed; inferred AI fields still require their explicit trust
        metadata and never satisfy a hard gate by themselves.
        """

        source: Mapping[str, Any] = supplied or data
        market_source = self._market
        if market_source is None:
            return None
        market_values = market_source.model_dump(mode="python")
        market_aliases = {
            "code": ("market", "人工｜市场", "目标市场"),
            "currency": ("currency", "币种"),
            "min_aov": ("min_aov", "最低客单价"),
            "max_aov": ("max_aov", "最高客单价"),
            "payment_percent": (
                "payment_percent",
                "人工｜支付百分比费率",
                "支付百分比费率",
            ),
            "payment_fixed": (
                "payment_fixed",
                "人工｜支付固定费",
                "支付固定费",
            ),
            "loss_reserve_percent": (
                "loss_reserve_percent",
                "人工｜损耗准备金率",
                "损耗准备金率",
            ),
        }
        for field, aliases in market_aliases.items():
            value = _flat_value(source, *aliases)
            if value is not None:
                market_values[field] = value

        order_source = source.get("order")
        if not isinstance(order_source, Mapping):
            order_source = source
        order_aliases = {
            "unit_price": ("unit_price", "price", "人工｜单品售价"),
            "expected_aov": ("expected_aov", "aov", "人工｜预计客单价"),
            "bundle_quantity": (
                "bundle_quantity",
                "order_quantity",
                "quantity",
                "人工｜订单件数",
            ),
            "goods_cost": ("goods_cost", "人工｜订单货值"),
            "shipping": ("shipping", "shipping_cost", "人工｜订单运费"),
            "packaging": ("packaging", "packaging_cost", "人工｜订单包装"),
            "tax_and_duty": ("tax_and_duty", "tax_cost", "人工｜税费关税"),
            "acquisition_cost": (
                "acquisition_cost",
                "ad_cost",
                "人工｜预计广告成本",
            ),
            "packed_weight_kg": (
                "packed_weight_kg",
                "weight",
                "人工｜订单重量",
            ),
            "supplier_quote_unit_cost": (
                "supplier_quote_unit_cost",
                "人工｜供应商单件报价",
            ),
            "supplier_quote_bundle_cost": (
                "supplier_quote_bundle_cost",
                "人工｜供应商订单报价",
            ),
            "supplier_quote_confirmed": (
                "supplier_quote_confirmed",
                "supplier_quote_verified",
                "人工｜供应商报价已确认",
            ),
            "supplier_quote_valid": (
                "supplier_quote_valid",
                "人工｜供应商报价有效",
            ),
            "supplier_quote_trust": (
                "supplier_quote_trust",
                "人工｜供应商报价可信度",
            ),
            "supplier_quote_source": (
                "supplier_quote_source",
                "人工｜供应商报价来源",
            ),
            "supplier_quote_collected_at": (
                "supplier_quote_collected_at",
                "人工｜供应商报价采集时间",
            ),
            "bundle_justification": ("bundle_justification", "人工｜订单组合依据"),
            "bundle_evidence_trust": ("bundle_evidence_trust",),
            "cost_trust": ("cost_trust",),
            "order_trust": ("order_trust",),
        }
        order: dict[str, Any] = {}
        for field, aliases in order_aliases.items():
            value = _flat_value(order_source, *aliases)
            if value is not None:
                order[field] = value
        # Flat human-entered cost cells have no separate provenance column in
        if source.get("人工｜订单组合已确认") is True:
            order["bundle_evidence_trust"] = EvidenceTrust.VERIFIED
        # the Phase 1 Base.  Mark only those present cells as human-confirmed;
        # absent cells remain unknown and still block scoring.
        costs = (
            "goods_cost",
            "shipping",
            "packaging",
            "tax_and_duty",
            "acquisition_cost",
            "packed_weight_kg",
        )
        cost_trust = dict(order.get("cost_trust", {}))
        for field in costs:
            if field in order and field not in cost_trust:
                cost_trust[field] = EvidenceTrust.VERIFIED
        if cost_trust:
            order["cost_trust"] = cost_trust
        order_trust = dict(order.get("order_trust", {}))
        for field in ("unit_price", "expected_aov", "bundle_quantity"):
            if field in order and field not in order_trust:
                order_trust[field] = EvidenceTrust.VERIFIED
        if order_trust:
            order["order_trust"] = order_trust
        quote_value = order.get("supplier_quote_confirmed")
        has_quote = any(
            order.get(field) is not None
            for field in ("supplier_quote_unit_cost", "supplier_quote_bundle_cost")
        )
        if has_quote and quote_value is True:
            order.setdefault("supplier_quote_trust", EvidenceTrust.VERIFIED)
            order.setdefault("order_trust", order_trust)
            order["order_trust"].setdefault("supplier_quote", EvidenceTrust.VERIFIED)

        meta = source.get("meta")
        if not isinstance(meta, Mapping):
            meta = {}
        meta = dict(meta)
        labels = {"低": "low", "中": "medium", "高": "high", "未知": "unknown"}
        for name, field in {
            "logistics_difficulty": "人工｜物流风险",
            "compliance_risk": "人工｜合规风险",
            "ip_risk": "人工｜侵权风险",
            "creative_formats": "人工｜创意形式",
            "creative_scenarios": "人工｜使用场景",
            "creative_hooks": "人工｜创意角度",
            "ugc_or_demo": "人工｜可持续演示",
            "certification_required": "人工｜需要认证",
            "certification_verified": "人工｜认证已确认",
            "brand_concentration": "人工｜品牌集中度",
            "differentiation": "人工｜产品差异化",
        }.items():
            if field in source:
                item = source[field]
                meta[name] = labels.get(item, item) if isinstance(item, str) else item
                meta.setdefault("trust", {})[name] = (
                    "verified" if source.get("人工｜证据已确认") is True else "unknown"
                )
        product_name = _flat_value(
            source,
            "product_name",
            "人工｜产品名称",
            "AUTO｜标准产品名称",
            "AUTO｜产品名称",
        )
        candidate = {
            "product_name": product_name,
            "market": market_values,
            "order": order,
            "meta": dict(meta),
        }
        try:
            return EvaluationInput.model_validate(candidate), ()
        except ValueError:
            # This helper is optional: a record with no evaluation-shaped
            # fields should fall through to the normal missing-input result.
            if not order and not meta and product_name is None:
                return None
            return None, ("evaluation_input",)

    @staticmethod
    def _merge_deterministic_sources(
        base: EvaluationInput,
        *,
        batch: SearchBatchResult | None,
        trends: GoogleTrendsEvidence | None,
    ) -> EvaluationInput:
        values = base.meta.model_dump(mode="python")
        trust = dict(base.meta.trust)
        if batch is None:
            values["active_days"] = None
            values["verified_creatives"] = None
            trust["active_days"] = EvidenceTrust.UNKNOWN
            trust["verified_creatives"] = EvidenceTrust.UNKNOWN
        else:
            groups = group_ads(batch.ads)
            selected = max(
                groups,
                key=lambda group: (
                    coarse_screen(group).verified_active_creatives,
                    coarse_screen(group).max_observable_active_days or -1,
                ),
                default=None,
            )
            decision = coarse_screen(selected) if selected is not None else None
            values["active_days"] = (
                decision.max_observable_active_days if decision is not None else None
            )
            values["verified_creatives"] = (
                decision.verified_active_creatives if decision is not None else None
            )
            trust["active_days"] = EvidenceTrust.VERIFIED
            trust["verified_creatives"] = EvidenceTrust.VERIFIED
            advertisers = {item.advertiser.casefold() for item in batch.ads}
            values["advertiser_count"] = len(advertisers)
            values["search_truncated"] = batch.truncated
            values["query_coverage_verified"] = batch.competition_verified
            coverage_trust = (
                EvidenceTrust.VERIFIED
                if batch.competition_verified
                else EvidenceTrust.UNKNOWN
            )
            for name in (
                "advertiser_count",
                "search_truncated",
                "query_coverage_verified",
            ):
                trust[name] = coverage_trust
        if trends is None or trends.label is TrendLabel.INSUFFICIENT_DATA:
            values["trend_12m"] = None
            values["trend_5y"] = None
            trust["trend_12m"] = EvidenceTrust.UNKNOWN
            trust["trend_5y"] = EvidenceTrust.UNKNOWN
        else:
            values["trend_12m"] = trends.label.value
            values["trend_5y"] = trends.label.value
            trust["trend_12m"] = EvidenceTrust.VERIFIED
            trust["trend_5y"] = EvidenceTrust.VERIFIED
        values["trust"] = trust
        return base.model_copy(update={"meta": EvidenceSnapshot.model_validate(values)})

    def _link_status(
        self,
        evaluation: EvaluationResult,
        *,
        batch: SearchBatchResult | None,
        landing: LandingSnapshot | None,
        meta_stage: Mapping[str, Any],
        landing_stage: Mapping[str, Any],
        trends_stage: Mapping[str, Any],
        extract_stage: Mapping[str, Any],
    ) -> str:
        if landing is not None and landing.needs_product_resolution:
            return "待识别具体产品"
        if meta_stage.get("status") == "unattributed":
            return "待识别具体产品"
        if batch is not None:
            decisions = [coarse_screen(group) for group in group_ads(batch.ads)]
            if any(item.status == "待识别具体产品" for item in decisions):
                return "待识别具体产品"
            if any(item.status == "待确认创意" for item in decisions):
                return "待确认创意"
        if any(
            stage.get("status") != "complete"
            for stage in (meta_stage, landing_stage, trends_stage, extract_stage)
        ):
            return "待补充证据"
        if evaluation.status == "待补充证据":
            if evaluation.missing_fields and set(evaluation.missing_fields).issubset(
                _ORDER_MISSING_FIELDS
            ):
                return "待询价"
            return "待补充证据"
        if evaluation.status == "观察池":
            return "观察池"
        if evaluation.status == "待人工复核":
            return "待人工复核"
        return "需人工处理"

    async def _write_keyword_failure(
        self, job: Job, stage: Mapping[str, Any]
    ) -> PipelineResult:
        error = stage.get("error")
        retriable = isinstance(error, dict) and error.get("retriable") is True
        state = "待延迟重试" if retriable else "需人工处理"
        await self._apply_batch(
            job,
            FeishuMutation(
                operation_key=self._operation_key(job, "search-batch", "failure"),
                table="搜索批次",
                action="create",
                unique_key=str(job.id),
                current_state=StateMachine.INITIAL_STATE,
                state=state,
                actor="automation",
                explicit_revalidation=False,
                fields=_fields(
                    "搜索批次",
                    {
                        "task_id": str(job.id),
                        "status": state,
                        "market": "US",
                        "error": (
                            error.get("detail", "unknown")
                            if isinstance(error, dict)
                            else "unknown"
                        ),
                        "failure_type": (
                            error.get("code", "unknown")
                            if isinstance(error, dict)
                            else "unknown"
                        ),
                    },
                ),
            ),
        )
        result = PipelineResult(
            status=state,
            evidence={"meta": _stage_evidence(stage)},
            retryable=retriable,
            needs_human=not retriable,
            failure_code=(
                str(error.get("code", "meta_failure"))
                if isinstance(error, dict)
                else "meta_failure"
            ),
            retry_attempt=_checkpoint_attempt(stage) or max(1, min(6, job.attempt + 1)),
            retry_kind=JobKind.META_SCAN if retriable else None,
        )
        await self._checkpoint_result(job, result)
        return result

    async def _write_search_batch(
        self, job: Job, query: str, batch: SearchBatchResult
    ) -> None:
        screenshot_ids = [
            evidence_id
            for coverage in batch.coverage
            for evidence_id in coverage.screenshot_evidence_ids
        ]
        await self._apply_batch(
            job,
            FeishuMutation(
                operation_key=self._operation_key(job, "search-batch"),
                table="搜索批次",
                action="create",
                unique_key=str(job.id),
                current_state=StateMachine.INITIAL_STATE,
                state="已完成",
                actor="automation",
                explicit_revalidation=False,
                fields=_fields(
                    "搜索批次",
                    {
                        "task_id": str(job.id),
                        "keyword": [job.payload.record_id]
                        if job.payload.kind is JobKind.KEYWORD_SCAN
                        else None,
                        "status": "已完成",
                        "market": "US",
                        "query": query,
                        "filters": "US|active|video|exact_phrase",
                        "evidence_object_id": "|".join(screenshot_ids),
                        "result_count": len(batch.ads),
                        "truncated": batch.truncated,
                        "stop_reason": "|".join(
                            item.stop_reason for item in batch.coverage
                        ),
                        "completeness": "未知"
                        if job.payload.kind is JobKind.LINK_VALIDATION
                        else "截断"
                        if batch.truncated
                        else "完整",
                        "started_at": batch.collected_at.isoformat(),
                        "ended_at": batch.collected_at.isoformat(),
                    },
                ),
            ),
        )

    async def _apply_batch(self, job: Job, mutation: FeishuMutation) -> str:
        saved = await self._jobs.get_checkpoint(job.id, "search_batch")
        if saved is None:
            record_id = await self._apply(
                job,
                FeishuMutation(
                    operation_key=self._operation_key(job, "batch-create"),
                    table="搜索批次",
                    action="create",
                    unique_key=str(job.id),
                    state="待执行",
                    current_state=StateMachine.INITIAL_STATE,
                    actor="automation",
                    explicit_revalidation=False,
                    fields=_fields(
                        "搜索批次",
                        {
                            "task_id": str(job.id),
                            "market": job.payload.market,
                            "status": "待执行",
                        },
                    ),
                ),
            )
            saved = {"record_id": record_id}
            await self._checkpoint(job, "search_batch", saved)
        current = await self._feishu.get_record("搜索批次", saved["record_id"])
        state = _record_state("搜索批次", current)
        if state in {"待执行", "待延迟重试"}:
            await self._apply(
                job,
                FeishuMutation(
                    operation_key=self._operation_key(
                        job, "batch-running", str(job.attempt)
                    ),
                    table="搜索批次",
                    action="update",
                    record_id=current.record_id,
                    expected_version=current.version,
                    current_state=state,
                    state="执行中",
                    actor="automation",
                    explicit_revalidation=False,
                    fields={},
                ),
            )
            current = await self._feishu.get_record("搜索批次", current.record_id)
        fields = dict(mutation.fields)
        meta = await self._jobs.get_checkpoint(job.id, "meta") or {}
        query = _first_text(
            job.payload.data,
            "query",
            "search_text",
            "人工｜通用产品词",
            "AUTO｜实际搜索词",
        )
        fields.update(
            _fields(
                "搜索批次",
                {
                    "query": query,
                    "checkpoint": json.dumps(meta, ensure_ascii=False)[:4000],
                    "retries": meta.get("retry_attempt", job.attempt),
                    "retry_at": (self._clock.now() + timedelta(minutes=15)).isoformat()
                    if mutation.state == "待延迟重试"
                    else None,
                    "evidence_object_id": "|".join(_stage_evidence(meta).values()),
                },
                include_missing=True,
            )
        )
        return await self._apply(
            job,
            mutation.model_copy(
                update={
                    "operation_key": self._operation_key(
                        job, "batch-outcome", str(job.attempt), mutation.state
                    ),
                    "action": "update",
                    "record_id": current.record_id,
                    "expected_version": current.version,
                    "current_state": _record_state("搜索批次", current),
                    "fields": fields,
                }
            ),
        )

    async def _write_meta_group(
        self,
        job: Job,
        group: MetaProductGroup,
        decision: CoarseScreenResult,
        *,
        group_index: int,
        keyword_record_id: str,
    ) -> None:
        for ad_index, ad in enumerate(group.ads):
            await self._apply(
                job,
                FeishuMutation(
                    operation_key=self._operation_key(
                        job, "meta-ad", f"{group_index}-{ad_index}-{ad.ad_id}"
                    ),
                    table="广告与素材",
                    action="create",
                    unique_key=ad.ad_id,
                    current_state=StateMachine.INITIAL_STATE,
                    state="已采集",
                    actor="automation",
                    explicit_revalidation=False,
                    fields=_fields(
                        "广告与素材",
                        {
                            "meta_ad_id": ad.ad_id,
                            "advertiser": ad.advertiser,
                            "page_id": ad.page_id,
                            "ad_text": ad.primary_text,
                            "hook": ad.hook,
                            "creative_fingerprint": ad.media_hash or ad.perceptual_hash,
                            "started_at": (
                                ad.start_date.isoformat()
                                if ad.start_date is not None
                                else None
                            ),
                            "observed_at": self._clock.now()
                            .astimezone(UTC)
                            .isoformat(),
                            "active_days": ad.observable_active_days,
                            "active": ad.is_active,
                            "creative_type": "视频",
                            "creative_url": ad.final_landing_url or ad.landing_url,
                            "extractor_version": "meta-v1",
                            "keywords": [keyword_record_id],
                        },
                    ),
                ),
            )
        fingerprint = group.product_fingerprint or group.group_key
        product_name = fingerprint.replace("-", " ").replace("_", " ").title()
        product_state = (
            "待识别具体产品"
            if decision.status == "待识别具体产品"
            else "待确认创意"
            if decision.status == "待确认创意"
            else "待补充"
        )
        product_id = await self._apply(
            job,
            FeishuMutation(
                operation_key=self._operation_key(job, "product", str(group_index)),
                table="产品主表",
                action="create",
                unique_key=fingerprint,
                current_state=StateMachine.INITIAL_STATE,
                state=product_state,
                actor="automation",
                explicit_revalidation=False,
                fields=_fields(
                    "产品主表",
                    {
                        "product_fingerprint": fingerprint,
                        "product_name": product_name,
                        "status": product_state,
                        "landing_url": group.normalized_landing_url,
                        "domain": _host(group.normalized_landing_url),
                        "page_type": (
                            "商品页"
                            if group.identity_status == "已识别具体产品"
                            else "未知"
                        ),
                        "keywords": [keyword_record_id],
                    },
                ),
            ),
        )
        market_key = f"{fingerprint}|US"
        market_state = decision.status if not decision.passed else "待询价"
        await self._apply(
            job,
            FeishuMutation(
                operation_key=self._operation_key(job, "market", str(group_index)),
                table="市场评估表",
                action="create",
                unique_key=market_key,
                current_state=StateMachine.INITIAL_STATE,
                state=market_state,
                actor="automation",
                explicit_revalidation=False,
                fields=_fields(
                    "市场评估表",
                    {
                        "product_market_key": market_key,
                        "product": [product_id],
                        "run_status": "已完成",
                        "current_recommendation": (
                            "值得深入" if decision.passed else decision.status
                        ),
                    },
                ),
            ),
        )

    async def _write_source_evidence(
        self,
        job: Job,
        stage: Mapping[str, Any],
        *,
        source_type: str,
    ) -> tuple[str, ...]:
        source_url = {
            "Meta": "https://www.facebook.com/ads/library/",
            "落地页": _stage_url(stage),
            "Trends": "https://trends.google.com/trends/explore",
        }.get(source_type)
        raw_value = _stage_json_value(stage)
        expires_at = (
            self._clock.now().astimezone(UTC)
            + timedelta(days=30 if source_type == "Trends" else 7)
        ).isoformat()
        record_ids: list[str] = []
        for name, object_id in _stage_evidence(stage).items():
            snapshot_key = f"{source_type}-{name}-{_digest(object_id)}"
            evidence_id = f"{job.id}:{snapshot_key}"
            record_id = await self._apply(
                job,
                FeishuMutation(
                    operation_key=self._operation_key(job, "evidence", snapshot_key),
                    table="证据表",
                    action="create",
                    unique_key=evidence_id,
                    current_state=StateMachine.INITIAL_STATE,
                    state="待确认",
                    actor="automation",
                    explicit_revalidation=False,
                    fields=_fields(
                        "证据表",
                        {
                            "evidence_id": evidence_id,
                            "evidence_type": source_type,
                            "trust": "verified",
                            "status": "待确认",
                            "collector_version": "phase1-v1",
                            "evidence_version": str(job.id),
                            "source_url": source_url,
                            "raw_value": raw_value,
                            "normalized_value": raw_value,
                            "snapshot_object_id": object_id,
                            "collected_at": self._clock.now()
                            .astimezone(UTC)
                            .isoformat(),
                            "expires_at": expires_at,
                            "object_reference": job.payload.record_id,
                        },
                    ),
                ),
            )
            record_ids.append(record_id)
        return tuple(record_ids)

    async def _write_supplier_quote_evidence(
        self,
        job: Job,
        *,
        source_url: str,
        trust: EvidenceTrust,
        collected_at: datetime | None = None,
    ) -> tuple[str, ...]:
        """Persist the human quote URL as reviewable evidence, not just input."""

        evidence_id = f"{job.id}:供应商:quote"
        observed_at = (
            collected_at.astimezone(UTC)
            if collected_at is not None and collected_at.tzinfo is not None
            else None
        )
        record_id = await self._apply(
            job,
            FeishuMutation(
                operation_key=self._operation_key(job, "evidence", "supplier-quote"),
                table="证据表",
                action="create",
                unique_key=evidence_id,
                current_state=StateMachine.INITIAL_STATE,
                state="待确认",
                actor="automation",
                explicit_revalidation=False,
                fields=_fields(
                    "证据表",
                    {
                        "evidence_id": evidence_id,
                        "evidence_type": "供应商",
                        "trust": trust.value,
                        "status": "待确认",
                        "collector_version": "human-input-v1",
                        "evidence_version": str(job.id),
                        "source_url": source_url,
                        "raw_value": source_url,
                        "normalized_value": source_url,
                        "collected_at": observed_at.isoformat()
                        if observed_at
                        else None,
                        "expires_at": (observed_at + timedelta(days=14)).isoformat()
                        if observed_at
                        else None,
                        "object_reference": job.payload.record_id,
                    },
                ),
            ),
        )
        return (record_id,)

    async def _write_score_history(
        self,
        job: Job,
        evaluation: EvaluationResult,
        *,
        supplier_quote_source: str | None,
    ) -> None:
        scores = evaluation.scores
        recommendation = {
            "测试池": "测试",
            "备选池": "备选",
            "淘汰池": "淘汰",
        }.get(evaluation.suggestion or "", "待补充")
        snapshot = await self._jobs.get_checkpoint(job.id, "evaluate") or {}
        history_digest = _digest({"snapshot": snapshot, "result": evaluation})
        await self._apply(
            job,
            FeishuMutation(
                operation_key=self._operation_key(job, "score-history", history_digest),
                table="评分记录",
                action="create",
                unique_key=f"{job.id}:{history_digest}",
                current_state=StateMachine.INITIAL_STATE,
                state="待人工复核",
                actor="automation",
                explicit_revalidation=False,
                fields=_fields(
                    "评分记录",
                    {
                        "score_id": f"{job.id}:{history_digest}",
                        "market_evaluation": [job.payload.record_id],
                        "scored_at": self._clock.now().astimezone(UTC).isoformat(),
                        "rule_version": RULE_VERSION,
                        "input_snapshot": json.dumps(
                            snapshot, ensure_ascii=False, sort_keys=True
                        ),
                        "reasons": "|".join(
                            (
                                *evaluation.reasons,
                                *evaluation.hard_gate_failures,
                                *evaluation.dimension_explanations.values(),
                                *(
                                    (f"供应商报价来源：{supplier_quote_source}",)
                                    if supplier_quote_source is not None
                                    else ()
                                ),
                            )
                        ),
                        "completeness": (
                            "完整" if not evaluation.missing_fields else "不完整"
                        ),
                        "meta_screen": (
                            "证据不足"
                            if evaluation.missing_fields
                            else "通过"
                            if evaluation.status == "待人工复核"
                            else "未通过"
                        ),
                        "gate_result": (
                            "待补充"
                            if evaluation.missing_fields
                            else "未通过"
                            if evaluation.hard_gate_failures
                            else "通过"
                        ),
                        "status": "待人工复核",
                        "recommendation": recommendation,
                        "demand_score": scores.get("需求与趋势"),
                        "creative_score": scores.get("素材空间"),
                        "profit_score": scores.get("利润与物流"),
                        "competition_score": scores.get("竞争强度"),
                        "risk_score": scores.get("合规风险"),
                        "total_score": evaluation.total,
                        "margin": (
                            float(evaluation.margin.margin_percent)
                            if evaluation.margin is not None
                            else None
                        ),
                    },
                ),
            ),
        )

    def _evaluation_fields(
        self, evaluation: EvaluationResult, evidence_record_ids: Sequence[str]
    ) -> dict[str, Any]:
        scores = evaluation.scores
        return _fields(
            "市场评估表",
            {
                "run_status": "已完成",
                "contribution_margin": (
                    float(evaluation.margin.margin_percent)
                    if evaluation.margin is not None
                    else None
                ),
                "demand_score": scores.get("需求与趋势"),
                "creative_score": scores.get("素材空间"),
                "profit_score": scores.get("利润与物流"),
                "competition_score": scores.get("竞争强度"),
                "risk_score": scores.get("合规风险"),
                "total_score": evaluation.total,
                "rule_version": RULE_VERSION,
                "current_recommendation": evaluation.suggestion or evaluation.status,
                "evidence": list(evidence_record_ids),
            },
            include_missing=True,
        )

    async def _write_input_changed(
        self,
        job: Job,
        current: RecordVersion,
        *,
        evidence: dict[str, Any],
        evaluation: EvaluationResult | None = None,
    ) -> PipelineResult:
        table = _source_table(job.payload.kind)
        await self._apply_source_update(
            job,
            table=table,
            expected_version=current.version,
            state="输入已变更",
            fields=(
                {FIELD_MAPPERS["市场评估表"]["run_status"]: "输入已变更"}
                if table == "市场评估表"
                else {}
            ),
            current_state=_record_state(table, current),
            suffix="input-changed",
        )
        result = PipelineResult(
            status="输入已变更",
            suggestion=evaluation.suggestion if evaluation is not None else None,
            missing_fields=(
                evaluation.missing_fields if evaluation is not None else ()
            ),
            evidence=evidence,
            score=_json(evaluation) if evaluation is not None else None,
        )
        await self._checkpoint_result(job, result)
        return result

    async def _apply_source_update(
        self,
        job: Job,
        *,
        table: str,
        expected_version: str,
        state: str,
        fields: dict[str, Any],
        current_state: str,
        suffix: str = "final",
    ) -> str:
        return await self._apply(
            job,
            FeishuMutation(
                operation_key=self._operation_key(job, "source", suffix),
                table=table,
                action="update",
                record_id=job.payload.record_id,
                expected_version=expected_version,
                state=state,
                fields=fields,
                current_state=current_state,
                actor="automation",
                explicit_revalidation=False,
            ),
        )

    async def _transition_source_state(
        self,
        job: Job,
        *,
        table: str,
        current: RecordVersion,
        state: str,
        fields: dict[str, Any],
        suffix: str,
    ) -> RecordVersion:
        """Persist one legal source-state edge and return its fenced revision.

        The state machine contains real operational states (queued, collecting,
        and pending score), so they cannot be collapsed into a final Base
        update.  Each edge receives its own durable outbox key.  The fallback
        preserves deterministic fake-adapter tests whose read model is static;
        a real adapter always returns the freshly written Base state.
        """

        current_state = _record_state(table, current)
        if current_state == state:
            return current
        self._states.transition(current_state, state, actor="automation", table=table)
        await self._apply_source_update(
            job,
            table=table,
            expected_version=current.version,
            state=state,
            fields=fields,
            current_state=current_state,
            suffix=suffix,
        )
        observed = await self._feishu.get_record(table, job.payload.record_id)
        if _record_state(table, observed) == state:
            return observed
        patched = dict(observed.fields)
        patched[FIELD_MAPPERS[table]["status"]] = state
        return RecordVersion(observed.record_id, observed.version, patched)

    async def _identify_link_stage(self, job: Job) -> dict[str, Any]:
        prior = await self._jobs.get_checkpoint(job.id, "identify_link")
        if prior is not None and prior.get("status") == "complete":
            value = prior.get("value")
            if isinstance(value, dict) and value.get("kind") in {"meta", "landing"}:
                return prior
            raise TerminalPipelineError(
                "checkpoint_corrupt", "link identity checkpoint is invalid"
            )
        raw_link = _required_link(job.payload.data)
        kind = _link_kind(raw_link)
        stage = {
            "status": "complete",
            "value": {"kind": kind, "url": _safe_checkpoint_url(raw_link)},
        }
        await self._checkpoint(job, "identify_link", stage)
        return stage

    async def _skip(self, job: Job, stage: str, reason: str) -> None:
        if await self._jobs.get_checkpoint(job.id, stage) is None:
            await self._checkpoint(job, stage, {"status": "skipped", "reason": reason})

    async def _checkpoint_result(self, job: Job, result: PipelineResult) -> None:
        checkpoint_status = (
            "complete"
            if not result.retryable and not result.needs_human
            else "retryable"
            if result.retryable
            else "needs_human"
        )
        await self._checkpoint(
            job,
            "writeback",
            {"status": checkpoint_status, "result": _json(result)},
        )

    async def _checkpoint(self, job: Job, stage: str, data: dict[str, Any]) -> None:
        if (
            stage not in CHECKPOINT_STAGES
            and re.fullmatch(r"research_meta_[0-9]", stage) is None
            and stage
            not in {
                "worker_failure",
                "mutation_intents",
                "source_progress",
                "search_batch",
                "linked_product",
            }
        ):
            raise ValueError(f"unknown pipeline checkpoint stage: {stage}")
        await self._jobs.checkpoint(
            job.id,
            stage,
            data,
            worker=cast(str, job.leased_by),
            lease_token=job.lease_token,
        )

    @staticmethod
    def _require_lease(job: Job) -> None:
        if job.leased_by is None or job.lease_token is None:
            raise StaleLeaseError(f"job {job.id} has no active lease identity")

    async def _input_changed(self, job: Job, current: RecordVersion) -> bool:
        linked = await self._jobs.get_checkpoint(job.id, "linked_product")
        if linked is not None:
            product = await self._feishu.get_record("产品主表", linked["record_id"])
            if product.version != linked["version"]:
                return True
        progress = await self._jobs.get_checkpoint(job.id, "source_progress")
        if progress is not None:
            return bool(
                current.version != progress["version"]
                or protected_input_hash(current.fields) != progress["hash"]
            )
        expected_hash = job.payload.protected_input_hash or protected_input_hash(
            job.payload.data
        )
        return (
            current.version != job.payload.input_version
            or protected_input_hash(current.fields) != expected_hash
        )

    async def _apply(self, job: Job, mutation: FeishuMutation) -> str:
        """Checkpoint the exact request before delivery; never regenerate retry payloads."""
        intents = await self._jobs.get_checkpoint(job.id, "mutation_intents") or {}
        intent = intents.get(mutation.operation_key)
        if intent is None:
            intent = {"mutation": mutation.model_dump(mode="json")}
            if (
                mutation.action == "update"
                and mutation.record_id == job.payload.record_id
                and mutation.table == _source_table(job.payload.kind)
            ):
                original = await self._feishu.get_record(
                    mutation.table, mutation.record_id
                )
                predicted = dict(original.fields)
                predicted[FIELD_MAPPERS[mutation.table]["status"]] = mutation.state
                intent["source_hash"] = protected_input_hash(predicted)
            intents[mutation.operation_key] = intent
            await self._checkpoint(job, "mutation_intents", intents)
        immutable = FeishuMutation.model_validate(intent["mutation"])
        record_id = await self._feishu.apply(immutable)
        if "source_hash" in intent:
            current = await self._feishu.get_record(immutable.table, record_id)
            if protected_input_hash(current.fields) == intent["source_hash"]:
                await self._checkpoint(
                    job,
                    "source_progress",
                    {"version": current.version, "hash": intent["source_hash"]},
                )
        return record_id

    @staticmethod
    def _operation_key(job: Job, *parts: str) -> str:
        return ":".join((job.idempotency_key, *parts))

    def _archive_structured_evidence(
        self,
        job: Job,
        stage: str,
        value: object,
        *,
        source_url: str,
    ) -> dict[str, str]:
        if self._storage is None:
            return {}
        raw = json.dumps(
            _json(value),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        try:
            stored = self._storage.put(
                market=job.payload.market,
                record_id=f"{job.payload.record_id}-{stage}",
                collected_at=self._clock.now().astimezone(UTC),
                raw=raw,
                source_url=_safe_checkpoint_url(source_url),
                content_type="application/json",
            )
        except Exception as exc:
            raise RetryablePipelineError(
                "evidence_storage_error",
                type(exc).__name__,
            ) from exc
        return {"structured": stored.object_id}


def _digest(value: object) -> str:
    return sha256(
        json.dumps(_json(value), sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def _json(value: object) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, Mapping):
        return {str(key): _json(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json(item) for item in value]
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    if isinstance(value, UUID):
        return str(value)
    return value


def _fields(
    table: str, values: Mapping[str, Any], *, include_missing: bool = False
) -> dict[str, Any]:
    mapper = FIELD_MAPPERS[table]
    return {
        mapper[key]: _json(value)
        for key, value in values.items()
        if value is not None or include_missing
    }


def _value(data: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in data:
            return data[name]
    return None


def _flat_value(data: Mapping[str, Any], *names: str) -> Any:
    """Return the first present non-empty flat record value."""

    for name in names:
        if name not in data:
            continue
        value = data[name]
        if isinstance(value, str) and not value.strip():
            continue
        return value
    return None


def _first_text(data: Mapping[str, Any], *names: str) -> str | None:
    for name in names:
        value = data.get(name)
        if isinstance(value, str) and (normalized := " ".join(value.split())):
            return normalized
    return None


def _synonyms(value: Any) -> tuple[str, ...]:
    if isinstance(value, str):
        items: Sequence[Any] = re.split(r"[|,\n]", value)
    elif isinstance(value, Sequence):
        items = value
    else:
        return ()
    result: list[str] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, str):
            continue
        normalized = " ".join(item.split())
        folded = normalized.casefold()
        if normalized and folded not in seen:
            seen.add(folded)
            result.append(normalized)
    return tuple(result)


def _required_link(data: Mapping[str, Any]) -> str:
    link = _first_text(
        data,
        "link",
        "url",
        "meta_url",
        "landing_url",
        "人工｜广告或落地页链接",
        "人工｜商品链接",
    )
    if link is None:
        raise TerminalPipelineError(
            "missing_link", "link validation needs one Meta or landing-page URL"
        )
    return link


def _link_kind(url: str) -> Literal["meta", "landing"]:
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").casefold().rstrip(".")
    except ValueError as exc:
        raise TerminalPipelineError("invalid_link", "link is malformed") from exc
    if parsed.scheme not in {"http", "https"} or not host:
        raise TerminalPipelineError(
            "invalid_link", "link must be an absolute HTTP or HTTPS URL"
        )
    if host in {"facebook.com", "www.facebook.com", "m.facebook.com", "fb.com"}:
        return "meta"
    return "landing"


def _safe_checkpoint_url(url: str) -> str:
    return canonical_research_url(url)


def _query_for_link(data: Mapping[str, Any], url: str) -> str:
    supplied = _first_text(
        data,
        "query",
        "trend_query",
        "product_name",
        "人工｜通用产品词",
        "人工｜产品名称",
    )
    if supplied is not None:
        return supplied
    words = re.findall(r"[a-z0-9]+", urlsplit(url).path.casefold())
    ignored = {
        "products",
        "product",
        "collections",
        "collection",
        "p",
        "ads",
        "library",
    }
    derived = " ".join(word for word in words if word not in ignored)[:120]
    if not derived:
        raise TerminalPipelineError(
            "missing_query", "link validation needs a generic product query"
        )
    return derived


def _landing_url(
    data: Mapping[str, Any],
    raw_link: str,
    link_kind: str,
    batch: SearchBatchResult | None,
) -> str | None:
    if link_kind == "landing":
        return raw_link
    supplied = _first_text(data, "landing_url", "人工｜商品链接")
    if supplied is not None:
        return supplied
    if batch is None:
        return None
    for ad in batch.ads:
        candidate = ad.final_landing_url or ad.landing_url
        if candidate:
            return candidate
    return None


def _host(url: str | None) -> str | None:
    if url is None:
        return None
    try:
        return urlsplit(url).hostname
    except ValueError:
        return None


def _failed_stage(
    error: CollectorError, *, evidence: Mapping[str, str] | None = None
) -> dict[str, Any]:
    return {
        "status": "failed",
        "error": error.model_dump(mode="json"),
        "evidence": dict(evidence or {}),
    }


def _stage_is_retryable(stage: Mapping[str, Any]) -> bool:
    error = stage.get("error")
    return isinstance(error, Mapping) and error.get("retriable") is True


def _checkpoint_attempt(value: Mapping[str, Any] | None) -> int | None:
    if value is None:
        return None
    candidate = value.get("retry_attempt", value.get("recovery_attempt"))
    if isinstance(candidate, int) and 1 <= candidate <= 6:
        return candidate
    return None


def _pipeline_failure_fields(stage: Mapping[str, Any]) -> dict[str, Any]:
    """Translate a collector failure into worker-owned queue control data."""

    error = stage.get("error")
    if not isinstance(error, Mapping):
        return {}
    retriable = error.get("retriable") is True
    return {
        "retryable": retriable,
        "needs_human": not retriable,
        "failure_code": str(error.get("code", "source_failure")),
        "retry_attempt": _checkpoint_attempt(stage),
        "retry_kind": JobKind.META_SCAN if retriable else None,
    }


def _supplier_quote_evidence_trust(data: EvaluationInput) -> EvidenceTrust:
    """Preserve the supplied provenance grade when mirroring quote evidence."""

    if data.order.supplier_quote_confirmed is True:
        return EvidenceTrust.VERIFIED
    trusts = tuple(
        trust
        for trust in (
            data.order.supplier_quote_trust,
            data.order.order_trust.get("supplier_quote"),
            data.meta.supplier_quote_trust,
            data.meta.trust.get("supplier_quote"),
        )
        if trust is not None
    )
    if trusts and all(trust is EvidenceTrust.VERIFIED for trust in trusts):
        return EvidenceTrust.VERIFIED
    if EvidenceTrust.INFERRED in trusts:
        return EvidenceTrust.INFERRED
    return EvidenceTrust.UNKNOWN


def _stage_evidence(stage: Mapping[str, Any]) -> dict[str, str]:
    value = stage.get("evidence")
    if not isinstance(value, dict):
        return {}
    return {
        str(name): str(object_id)
        for name, object_id in value.items()
        if isinstance(name, str) and isinstance(object_id, str)
    }


def _stage_url(stage: Mapping[str, Any]) -> str | None:
    value = stage.get("value")
    if isinstance(value, Mapping):
        for key in ("final_url", "url", "source_url"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return _safe_checkpoint_url(candidate)
    candidate = stage.get("source_url")
    return _safe_checkpoint_url(candidate) if isinstance(candidate, str) else None


def _stage_json_value(stage: Mapping[str, Any]) -> str | None:
    value = stage.get("value")
    if value is None:
        return None
    try:
        encoded = json.dumps(_json(value), ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return None
    return encoded[:4000]


def _source_table(kind: JobKind) -> str:
    return {
        JobKind.NICHE_DISCOVERY: "细分领域池",
        JobKind.NICHE_RESEARCH: "细分领域池",
        JobKind.KEYWORD_SEED: "细分领域池",
        JobKind.KEYWORD_SCAN: "关键词库",
        JobKind.LINK_VALIDATION: "市场评估表",
    }.get(kind, "市场评估表")


def _record_state(table: str, record: RecordVersion) -> str:
    """Read a source's human workflow state using the declared schema name."""

    field = FIELD_MAPPERS[table]["status"]
    value = record.fields.get(field)
    if not isinstance(value, str) or not value.strip():
        raise TerminalPipelineError(
            "missing_source_state", f"{table} record has no human workflow state"
        )
    return value.strip()


def _ordered_unique(items: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(items))


def _bounded_text(value: str, limit: int) -> str:
    return " ".join(str(value).split())[:limit]


def _nonnegative_int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, float) and value >= 0 and value.is_integer():
        return int(value)
    return 0


__all__ = [
    "CHECKPOINT_STAGES",
    "FeishuMutation",
    "FeishuWorkflow",
    "ForbiddenTransition",
    "Pipeline",
    "PipelineResult",
    "ReasonRequired",
    "RetryablePipelineError",
    "RevalidationRequired",
    "StateMachine",
    "TerminalPipelineError",
]
