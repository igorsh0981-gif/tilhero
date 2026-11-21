"""Pydantic-модели API experience-config (вход — extra="forbid")."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer

from tilhero_experience.domain.payload import SEMVER, AdminPayload, MiniAppPayload


def _iso_z(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


UtcDateTime = Annotated[datetime, PlainSerializer(_iso_z, return_type=str)]
_IN = ConfigDict(extra="forbid")


class VersionCreateIn(BaseModel):
    model_config = _IN

    version: str = Field(pattern=SEMVER, description="semver, неизменяем после создания")
    payload: dict[str, Any] = Field(description="форма ExperienceConfig без app/version (см. README)")
    change_note: str = Field(min_length=3, max_length=500)


class ActivateIn(BaseModel):
    model_config = _IN

    version: str = Field(pattern=SEMVER)
    reason: str = Field(min_length=3, max_length=500)


class RollbackIn(BaseModel):
    model_config = _IN

    reason: str = Field(min_length=3, max_length=500)


class VersionSummary(BaseModel):
    version_id: uuid.UUID
    app: str
    version: str
    checksum: str
    change_note: str
    created_by: str
    created_at: UtcDateTime
    status: Literal["current", "previous"] | None = None


class VersionDetail(VersionSummary):
    payload: dict[str, Any]


class VersionPage(BaseModel):
    items: list[VersionSummary]
    next_cursor: str | None


class ActivationOut(BaseModel):
    activation_id: uuid.UUID
    app: str
    version: str
    previous_version: str | None
    kind: Literal["activate", "rollback"]
    reason: str
    activated_by: str
    activated_at: UtcDateTime


class ActivationPage(BaseModel):
    items: list[ActivationOut]
    next_cursor: str | None


class StateOut(BaseModel):
    app: str
    current: ActivationOut | None
    previous_version: str | None


class MiniAppExperienceConfig(MiniAppPayload):
    """GET current для miniapp = ExperienceConfig из bff.ts."""

    app: Literal["miniapp"]
    version: str


class AdminExperienceConfig(AdminPayload):
    app: Literal["admin"]
    version: str


# ---------------------------------------------------------------- «Что нового» (формы bff.ts)


class ReleaseNoteItemOut(BaseModel):
    title: str
    text: str
    link: str | None
    icon: str | None


class WhatsNewNoteOut(BaseModel):
    release_note_id: uuid.UUID
    slug: str
    title: str
    items: list[ReleaseNoteItemOut]
    audience: Literal["new", "existing", "all"]
    illustration: str | None
    published_at: str


class WhatsNewOut(BaseModel):
    mode: Literal["welcome", "updates", "none"]
    notes: list[WhatsNewNoteOut]


class WhatsNewPage(BaseModel):
    items: list[WhatsNewNoteOut]
    next_cursor: str | None


class SeenIn(BaseModel):
    """WhatsNewSeenRequest (bff.ts): 1…20 id заметок."""

    model_config = _IN

    release_note_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)


# ---------------------------------------------------------------- «Что нового»: статистика (формы admin.ts)


class ReleaseNoteStatsOut(BaseModel):
    """ReleaseNoteStats: показы — уникальные ученики; разрезы — по сегменту на момент показа (без старых отметок)."""

    release_note_id: uuid.UUID
    views_total: int
    views_by_lang: dict[Literal["ru", "uz"], int]
    views_by_age: dict[Literal["kids", "teens", "adults"], int]
    first_view_at: str | None
    last_view_at: str | None


class LatestReleaseNoteOut(BaseModel):
    release_note_id: uuid.UUID
    slug: str
    title: str
    views_total: int
    published_at: str


class ReleaseNotesSummaryOut(BaseModel):
    """DashboardWhatsNew: действующие опубликованные, черновики, последняя опубликованная (заголовок RU)."""

    published: int
    drafts: int
    latest: LatestReleaseNoteOut | None
