from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, Field, JsonValue


class Clock(Protocol):
    def now(self) -> datetime: ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


class JobKind(StrEnum):
    NICHE_DISCOVERY = "niche_discovery"
    NICHE_RESEARCH = "niche_research"
    KEYWORD_SEED = "keyword_seed"
    KEYWORD_SCAN = "keyword_scan"
    LINK_VALIDATION = "link_validation"
    META_SCAN = "meta_scan"
    LANDING_SCAN = "landing_scan"
    TRENDS_SCAN = "trends_scan"
    EVALUATE = "evaluate"
    FEISHU_WRITEBACK = "feishu_writeback"


class JobStatus(StrEnum):
    READY = "ready"
    RUNNING = "running"
    DELAYED = "delayed"
    SUCCEEDED = "succeeded"
    NEEDS_HUMAN = "needs_human"


class BusinessStatus(StrEnum):
    NICHE_PENDING_GENERATION = "待生成"
    NICHE_PENDING_RESEARCH = "待研究"
    NICHE_PENDING_HUMAN_SELECTION = "待人工选择"
    NICHE_ENABLED = "已启用"
    NICHE_PAUSED = "暂停"

    KEYWORD_PENDING_REVIEW = "待审核"
    KEYWORD_ENABLED = "已启用"
    KEYWORD_PENDING_SCAN = "待扫描"
    KEYWORD_SCANNING = "扫描中"
    KEYWORD_THROTTLED = "降频"
    KEYWORD_SUGGEST_PAUSE = "建议暂停"
    KEYWORD_PAUSED = "暂停"

    SEARCH_BATCH_PENDING = "待执行"
    SEARCH_BATCH_RUNNING = "执行中"
    SEARCH_BATCH_COMPLETE = "已完成"
    SEARCH_BATCH_DELAYED_RETRY = "待延迟重试"
    SEARCH_BATCH_NEEDS_HUMAN = "需人工处理"

    CANDIDATE_PENDING_COMPLETION = "待补充"
    CANDIDATE_START_VALIDATION = "开始验证"
    CANDIDATE_QUEUED = "队列中"
    CANDIDATE_COLLECTING = "采集中"
    CANDIDATE_IDENTIFY_PRODUCT = "待识别具体产品"
    CANDIDATE_CONFIRM_CREATIVE = "待确认创意"
    CANDIDATE_REQUEST_QUOTE = "待询价"
    CANDIDATE_SUPPLEMENT_EVIDENCE = "待补充证据"
    CANDIDATE_OBSERVATION = "观察池"
    CANDIDATE_PENDING_SCORE = "待评分"
    CANDIDATE_INPUT_CHANGED = "输入已变更"
    CANDIDATE_NEEDS_HUMAN = "需人工处理"
    CANDIDATE_PENDING_HUMAN_REVIEW = "待人工复核"
    CANDIDATE_TEST_POOL = "测试池"
    CANDIDATE_BACKUP_POOL = "备选池"
    CANDIDATE_ELIMINATED_POOL = "淘汰池"


class EvidenceTrust(StrEnum):
    VERIFIED = "verified"
    INFERRED = "inferred"
    UNKNOWN = "unknown"


class JobPayload(BaseModel):
    kind: JobKind
    record_id: str
    input_version: str
    protected_input_hash: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )
    market: str = "US"
    data: dict[str, JsonValue] = Field(default_factory=dict)
    estimated_ai_calls: int = Field(default=0, ge=0)
    estimated_cost_usd: float = Field(default=0, ge=0)
    input_error: Literal["supplier_quote_source_invalid"] | None = None


@dataclass(frozen=True, slots=True)
class Job:
    id: UUID
    idempotency_key: str
    payload: JobPayload
    status: JobStatus
    attempt: int
    available_at: datetime
    lease_until: datetime | None
    leased_by: str | None
    lease_token: UUID | None
    failure_code: str | None
    failure_detail: str | None
    created_at: datetime
    updated_at: datetime
