"""Pydantic-модели user-admin.

Ответы повторяют packages/contracts/src/admin.ts (AdminLearnerRow, AdminLearnerCard без `tickets` — их добавляет
admin-bff, DashboardLearners). Вход — снимки источников: identity-consent `GET /admin/v1/users[/{id}]` (профиль без
полного Telegram ID) и learning-plan `GET /admin/v1/plans` (план и график) — docs/sprint2/INTERNAL_API.md §2–3.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

from tilhero_user_admin.models import CATEGORIES, LOCALES, MASK

LearnerKind = Literal["account", "child"]
LearnerStatus = Literal["ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED"]
AgeBand = Literal["6-9", "10-13", "14-17", "18+"]
GuardianConsent = Literal["not_required", "pending", "granted", "declined"]
UiLang = Literal["ru", "uz"]
Goal = Literal["work", "career", "travel", "daily", "study", "exam"]
LevelSelf = Literal["zero", "beginner", "some", "confident"]
SchedulePreset = Literal["daily", "weekdays", "three_per_week", "custom"]
ConsentBasis = Literal["self", "guardian"]

_MASK_RE = re.compile(MASK + r"{6}[0-9]{3}")
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def safe_mask(value: str | None) -> str | None:
    """Защита в глубину: в read-модель попадает только маска «••••••789». Если источник по ошибке прислал полный
    Telegram ID, он маскируется здесь же и не сохраняется; иной формат — маски нет (null)."""
    if value is None:
        return None
    if _MASK_RE.fullmatch(value):
        return value
    digits = re.sub(r"[^0-9]", "", value)
    return MASK * 6 + digits[-3:] if len(digits) >= 3 else None


def norm_locale(value: Any) -> str | None:
    return value if isinstance(value, str) and value in LOCALES else None


# ---------------------------------------------------------------- вход: снимки источников (сверка)

class SourceSnapshot(BaseModel):
    """Снимок источника сверки: версия — `updated_at` строки источника (водяной знак сверки)."""

    model_config = ConfigDict(extra="ignore")

    updated_at: AwareDatetime


# ---------------------------------------------------------------- вход: снимок identity-consent

class SnapshotConsent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    policy_version: str | None = Field(default=None, max_length=20)
    purposes: list[str] = Field(default_factory=list, max_length=20)
    accepted_at: AwareDatetime | None = None
    revoked_at: AwareDatetime | None = None
    basis: ConsentBasis | None = None

    @field_validator("purposes")
    @classmethod
    def _purposes(cls, v: list[str]) -> list[str]:
        return [p[:32] for p in v]


class SnapshotSecurity(BaseModel):
    model_config = ConfigDict(extra="ignore")

    pin_enabled: bool = False
    pin_reset_pending: bool = False


class SnapshotNotifications(BaseModel):
    model_config = ConfigDict(extra="ignore")

    enabled: bool
    categories: dict[str, bool] = Field(default_factory=dict)

    def as_json(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "categories": {c: bool(self.categories.get(c, False)) for c in CATEGORIES}}


class IdentitySnapshot(SourceSnapshot):
    """identity-consent `GET /admin/v1/users[/{id}]` (INTERNAL_API §3): поля AdminLearnerRow, принадлежащие
    identity-consent, + consent/security/notifications карточки + updated_at. Поля других доменов (план, обращения,
    число детей) из снимка не берутся — их считает read-модель."""

    model_config = ConfigDict(extra="ignore")

    user_id: uuid.UUID
    kind: LearnerKind = "account"
    guardian_user_id: uuid.UUID | None = None
    display_name: str | None = Field(default=None, max_length=160)
    username: str | None = Field(default=None, max_length=64)
    telegram_id_masked: str | None = Field(default=None, max_length=32)
    locale: str | None = Field(default=None, max_length=8)
    age_band: AgeBand | None = None
    guardian_consent: GuardianConsent = "not_required"
    status: LearnerStatus
    created_at: AwareDatetime
    consent: SnapshotConsent = Field(default_factory=SnapshotConsent)
    security: SnapshotSecurity = Field(default_factory=SnapshotSecurity)
    notifications: SnapshotNotifications | None = None

    @field_validator("telegram_id_masked")
    @classmethod
    def _masked(cls, v: str | None) -> str | None:
        return safe_mask(v)

    @field_validator("locale")
    @classmethod
    def _locale(cls, v: str | None) -> str | None:
        return norm_locale(v)

    @model_validator(mode="after")
    def _kind_rules(self) -> IdentitySnapshot:
        if self.kind == "child":  # у детского профиля нет своего Telegram
            self.telegram_id_masked = None
            self.username = None
        else:
            self.guardian_user_id = None
        if self.guardian_user_id == self.user_id:
            self.guardian_user_id = None
        return self


# ---------------------------------------------------------------- вход: снимок learning-plan

class PlanSchedule(BaseModel):
    model_config = ConfigDict(extra="ignore")

    preset: SchedulePreset
    days: list[int] = Field(min_length=1, max_length=7)
    preferred_time: str
    duration_min: int = Field(ge=1, le=240)
    reminders_enabled: bool
    timezone: str = Field(min_length=1, max_length=64)

    @field_validator("days")
    @classmethod
    def _days(cls, v: list[int]) -> list[int]:
        if any(d < 1 or d > 7 for d in v):
            raise ValueError("days must be 1..7")
        return sorted(set(v))

    @field_validator("preferred_time")
    @classmethod
    def _time(cls, v: str) -> str:
        if not _HHMM.match(v):
            raise ValueError("preferred_time must be HH:MM")
        return v


class PlanSnapshot(SourceSnapshot):
    """learning-plan `GET /admin/v1/plans` (INTERNAL_API §3)."""

    model_config = ConfigDict(extra="ignore")

    user_id: uuid.UUID
    goal: Goal | None = None
    level_self: LevelSelf | None = None
    ui_lang: UiLang | None = None
    schedule: PlanSchedule | None = None
    onboarding_completed_at: AwareDatetime | None = None


# ---------------------------------------------------------------- выход (admin.ts)

class AdminLearnerRow(BaseModel):
    user_id: uuid.UUID
    kind: LearnerKind
    guardian_user_id: uuid.UUID | None
    display_name: str | None
    username: str | None
    telegram_id_masked: str | None
    locale: UiLang | None
    age_band: AgeBand | None
    guardian_consent: GuardianConsent
    status: LearnerStatus
    onboarding_completed: bool
    goal: Goal | None
    reminders_enabled: bool
    children_count: int
    open_tickets: int
    tickets_total: int
    created_at: datetime
    last_activity_at: datetime | None


class AdminLearnerPage(BaseModel):
    items: list[AdminLearnerRow]
    next_cursor: str | None


class CardSchedule(BaseModel):
    preset: SchedulePreset
    days: list[int]
    preferred_time: str
    duration_min: int
    reminders_enabled: bool
    timezone: str


class AdminLearnerPlan(BaseModel):
    goal: Goal | None
    level_self: LevelSelf | None
    ui_lang: UiLang | None
    schedule: CardSchedule | None
    onboarding_completed_at: datetime | None
    updated_at: datetime | None


class CardConsent(BaseModel):
    policy_version: str | None
    purposes: list[str]
    accepted_at: datetime | None
    revoked_at: datetime | None
    basis: ConsentBasis | None


class CardSecurity(BaseModel):
    pin_enabled: bool
    pin_reset_pending: bool


class CardCategories(BaseModel):
    reminders: bool
    missed: bool
    social: bool
    support: bool
    product: bool


class CardNotifications(BaseModel):
    enabled: bool
    categories: CardCategories


class AdminLearnerCard(AdminLearnerRow):
    """AdminLearnerCard без `tickets` (их добавляет admin-bff из support)."""

    consent: CardConsent
    security: CardSecurity
    notifications: CardNotifications | None
    plan: AdminLearnerPlan | None
    children: list[AdminLearnerRow]
    guardian: AdminLearnerRow | None
    refreshed_at: datetime


class DashboardLearners(BaseModel):
    """Dashboard.learners.data (admin.ts) — без available/service (их добавляет admin-bff)."""

    total_accounts: int
    total_children: int
    new_in_period: int
    active_in_period: int
    onboarding_completed_pct: float
    reminders_enabled_pct: float
    by_age_band: dict[str, int]  # "6-9" | "10-13" | "14-17" | "18+" | "unknown"
    by_locale: dict[str, int]  # "ru" | "uz" | "unknown"


# ---------------------------------------------------------------- сверка (n8n)

class ReconcileSourceOut(BaseModel):
    ok: bool
    applied: int
    error: str | None


class ReconcileOut(BaseModel):
    identity: ReconcileSourceOut
    plans: ReconcileSourceOut
