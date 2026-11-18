"""Pydantic-модели user-admin.

Ответы повторяют packages/contracts/src/admin.ts (AdminUserRow, AdminUserCard без tickets/ai_conversations — их
добавляет admin-bff, Dashboard.users). Вход из identity-consent (IdentitySnapshot) — снимок профиля без полного
Telegram ID.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

AppUserStatus = Literal["ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED"]
MASK = "\u2022"  # •
_MASK_RE = re.compile(r"\u2022{6}[0-9]{3}|\u2022{9}")


def safe_mask(value: str) -> str:
    """Защита в глубину: в read-модель попадает только маска «••••••789». Если источник по ошибке прислал полный
    Telegram ID (или иной формат), он маскируется здесь же и не сохраняется."""
    if _MASK_RE.fullmatch(value):
        return value
    digits = re.sub(r"[^0-9]", "", value)
    return MASK * 6 + digits[-3:] if len(digits) >= 3 else MASK * 9


# ---------------------------------------------------------------- вход: снимок identity-consent

class SnapshotConsent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    policy_version: str | None = Field(default=None, max_length=20)
    purposes: list[str] = Field(default_factory=list, max_length=20)
    accepted_at: datetime | None = None
    age_confirmed_18_plus: bool = False
    revoked_at: datetime | None = None


class SnapshotSecurity(BaseModel):
    model_config = ConfigDict(extra="ignore")

    pin_enabled: bool = False
    biometric_enabled: bool = False


class IdentitySnapshot(BaseModel):
    """GET identity-consent /admin/v1/users[/{id}] (docs/sprint2/INTERNAL_API.md)."""

    model_config = ConfigDict(extra="ignore")

    user_id: uuid.UUID
    username: str | None = Field(default=None, max_length=64)
    display_name: str | None = Field(default=None, max_length=160)
    telegram_id_masked: str = Field(max_length=32)
    locale: str | None = Field(default=None, max_length=8)
    status: AppUserStatus
    created_at: datetime
    updated_at: datetime
    last_seen_at: datetime | None = None
    consent: SnapshotConsent = Field(default_factory=SnapshotConsent)
    security: SnapshotSecurity = Field(default_factory=SnapshotSecurity)

    @field_validator("telegram_id_masked")
    @classmethod
    def _masked(cls, v: str) -> str:
        return safe_mask(v)


# ---------------------------------------------------------------- выход (admin.ts)

class AccessLevelView(BaseModel):
    """Уровень доступа к AI (спринт 7, проекция ai-control). `level = null` — уровень по умолчанию, код которого
    read-модель не знает (событий не было или ручное назначение истекло); `source = manual` — действующее ручное
    назначение (с `expires_at`, если задан срок). Authoritative-значение — ai-control `GET /access/users/{id}`."""

    level: str | None
    source: Literal["default", "manual"]
    expires_at: datetime | None


class AdminUserRow(BaseModel):
    user_id: uuid.UUID
    username: str | None
    display_name: str | None
    telegram_id_masked: str
    locale: str | None
    status: AppUserStatus
    onboarding_completed: bool
    open_tickets: int
    tickets_total: int
    created_at: datetime
    last_seen_at: datetime | None
    plan: Literal["FREE"] = "FREE"
    access_level: AccessLevelView  # спринт 7
    # спринт 9: «удаление зависло» (user.deletion.stuck.v1 от identity-consent); null — нет или удаление завершено
    deletion_stuck_at: datetime | None = None


class CardConsent(BaseModel):
    policy_version: str | None
    purposes: list[str]
    accepted_at: datetime | None
    age_confirmed_18_plus: bool
    revoked_at: datetime | None


class CardSecurity(BaseModel):
    pin_enabled: bool
    biometric_enabled: bool


class CardPreferences(BaseModel):
    onboarding_completed: bool
    updated_at: datetime | None
    changed_fields: list[str]


class AdminUserCard(AdminUserRow):
    """AdminUserCard без tickets и ai_conversations (их добавляет admin-bff из support и, со спринта 6, AI)."""

    consent: CardConsent
    security: CardSecurity
    preferences: CardPreferences
    refreshed_at: datetime


class AdminUserPage(BaseModel):
    items: list[AdminUserRow]
    next_cursor: str | None


class UserStats(BaseModel):
    """Dashboard.users без available (его добавляет admin-bff)."""

    total: int
    new_in_period: int
    onboarding_completed_pct: float
    by_status: dict[AppUserStatus, int]
    # спринт 8 (INTERNAL_API §7.1): неудалённые, заходившие в Mini App с начала периода / с начала дня (Ташкент)
    active_in_period: int
    active_today: int
