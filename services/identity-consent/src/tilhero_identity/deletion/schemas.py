"""Pydantic-модели API саги удаления (INTERNAL_API §1.4; типы admin.ts «Спринт 9» — пакет Q4).

PII в ответах нет: `user_id` — псевдоним, Telegram ID, username и имя сюда не попадают (профиль уже в статусе
DELETION_REQUESTED или DELETED). `stats` для ops-monitor — только числа, домены и request_id, без `user_id`.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

DeletionStatus = Literal["REQUESTED", "STUCK", "COMPLETED"]
AckMode = Literal["deleted", "anonymized"]


class DeletionRetryIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    reason: str = Field(min_length=3, max_length=300)


class DeletionRow(BaseModel):
    request_id: uuid.UUID
    user_id: uuid.UUID
    status: DeletionStatus
    requested_at: datetime
    completed_at: datetime | None
    stuck_at: datetime | None
    attempts: int
    next_retry_at: datetime | None
    acked: int
    expected: int
    pending_domains: list[str]


class DeletionDomain(BaseModel):
    domain: str
    acked_at: datetime | None  # null — не подтвердил, либо подтвердил до спринта 9 (время неизвестно; mode тоже null)
    mode: AckMode | None
    acked: bool  # дополнение к контракту: отличает «ACK до спринта 9» (acked_at = null) от «не подтвердил»


class DeletionHistoryItem(BaseModel):
    attempt: int
    sent_at: datetime
    by: str  # user — первичный запрос; system — таймер; иначе staff_id сотрудника


class DeletionDetail(DeletionRow):
    domains: list[DeletionDomain]
    history: list[DeletionHistoryItem]


class DeletionPage(BaseModel):
    items: list[DeletionRow]
    next_cursor: str | None


class StuckItem(BaseModel):
    request_id: uuid.UUID
    requested_at: datetime
    stuck_at: datetime
    attempts: int
    pending_domains: list[str]


class DeletionStats(BaseModel):
    open: int  # открытые = REQUESTED + STUCK
    stuck: int
    oldest_open_at: datetime | None
    pending_by_domain: dict[str, int]  # только домены с n > 0
    stuck_items: list[StuckItem]  # ≤ 50, старые сверху
