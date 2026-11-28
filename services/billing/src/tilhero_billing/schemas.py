"""Pydantic-модели входа API billing (extra="forbid"; строки — с ограничением длины). Формы ответов — словари домена
по контрактам bff.ts «Спринт 8», web.ts, admin.ts «Деньги» (INTERNAL_API §1.17)."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------- ученик (telegram-bff)


class OrderBody(_In):
    product_code: str = Field(pattern=r"^[a-z0-9_]{2,40}$")
    provider: Literal["telegram_stars", "payme", "click", "uzum"]
    start_mode: Literal["after_current", "now"] | None = None
    confirm_forfeit: bool = False
    beneficiary_id: uuid.UUID | None = None
    offer_version: str = Field(min_length=1, max_length=20)


class StarsSubscriptionBody(_In):
    auto_renew: bool


# ---------------------------------------------------------------- lessons


class HoldBody(_In):
    user_id: uuid.UUID
    feature: Literal["ai_lessons", "pair_lessons"]
    ref_kind: Literal["session", "room"]
    ref_id: uuid.UUID
    minutes_planned: int = Field(ge=1, le=120)


# ---------------------------------------------------------------- админка


class CatalogDraftBody(_In):
    payload: dict[str, Any]
    comment: str | None = Field(default=None, max_length=500)


class CommentBody(_In):
    comment: str = Field(min_length=10, max_length=500)


class RefundBody(_In):
    reason: str = Field(min_length=10, max_length=500)
    force: bool = False


class NoteBody(_In):
    note: str = Field(min_length=10, max_length=500)


class ApproveBody(_In):
    note: str | None = Field(default=None, max_length=500)


class AdjustmentBody(_In):
    kind: Literal["minutes", "grant_period", "revoke_period"]
    minutes: int | None = None
    days: int | None = None
    period_id: uuid.UUID | None = None
    reason: str = Field(min_length=10, max_length=500)


class ResolveBody(_In):
    status: Literal["resolved", "ignored"]
    note: str = Field(min_length=10, max_length=500)


class FxBody(_In):
    usd_in_tiyin: int
    valid_from: date
    reason: str = Field(max_length=500)


class StarRateBody(_In):
    star_in_tiyin: int
    valid_from: date
    reason: str = Field(max_length=500)


class GrantAllBody(_In):
    reason: str = Field(min_length=10, max_length=500)
