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
