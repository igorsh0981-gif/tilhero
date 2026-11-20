"""Pydantic-модели входа API gamification (extra="forbid"; строки с max_length). Формы — bff.ts «Спринт 6» и
admin.ts «Игра и герои». Ответы собираются в domain/* как dict (формы контрактов)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Audience = Literal["kids", "teens", "adults"]
CODE_PATTERN = r"^[a-z0-9_]{3,40}$"


class In(BaseModel):
    model_config = ConfigDict(extra="forbid")


Text60 = Annotated[str, Field(min_length=1, max_length=60, pattern=r"\S")]
Text80 = Annotated[str, Field(min_length=1, max_length=80, pattern=r"\S")]
Text200 = Annotated[str, Field(min_length=1, max_length=200, pattern=r"\S")]
Text300 = Annotated[str, Field(min_length=1, max_length=300, pattern=r"\S")]


class Localized60(In):
    """Тексты RU и UZ обязательны: пустой перевод не сохраняется."""

    ru: Text60
    uz: Text60


class Localized80(In):
    ru: Text80
    uz: Text80


class Localized200(In):
    ru: Text200
    uz: Text200


class Localized300(In):
    ru: Text300
    uz: Text300


def _unique(values: list[Any], what: str) -> list[Any]:
    if len(set(values)) != len(values):
        raise ValueError(f"duplicate {what}")
    return values


# ---------------------------------------------------------------- ученик


class SelectHeroIn(In):
    hero_code: str = Field(pattern=r"^(robot|pet|human)_[0-9]$")


class PurchaseIn(In):
    item_code: str = Field(pattern=CODE_PATTERN)


class EquipmentIn(In):
    background_code: str | None = Field(pattern=CODE_PATTERN)
    frame_code: str | None = Field(pattern=CODE_PATTERN)


class SettingsPatch(In):
    auto_freeze: bool | None = None
    quests_hidden: bool | None = None
    celebrations: Literal["full", "quiet"] | None = None
    game_notifications: bool | None = None


# ---------------------------------------------------------------- админка: общее


class CommentIn(In):
    comment: str | None = Field(default=None, max_length=300)


class ActivateIn(In):
    comment: str = Field(min_length=10, max_length=300)

    @field_validator("comment")
    @classmethod
    def _strip(cls, v: str) -> str:
        if len(v.strip()) < 10:
            raise ValueError("comment must have at least 10 characters")
        return v.strip()


class ReasonIn(In):
    reason: str = Field(min_length=10, max_length=300)

    @field_validator("reason")
    @classmethod
    def _strip(cls, v: str) -> str:
        if len(v.strip()) < 10:
            raise ValueError("reason must have at least 10 characters")
        return v.strip()


# ---------------------------------------------------------------- правила


class RulesDraftIn(In):
    payload: dict[str, Any]
    comment: str | None = Field(default=None, max_length=300)
    based_on: int | None = Field(default=None, ge=1)


# ---------------------------------------------------------------- герои


class HeroStageIn(In):
    stage: Literal[1, 2, 3]
    name: Localized60
    asset_id: uuid.UUID


class HeroDraftIn(In):
    name: Localized60
    tagline: Localized80
    audiences: list[Audience] = Field(max_length=3)
    stages: list[HeroStageIn] = Field(min_length=3, max_length=3)

    @model_validator(mode="after")
    def _check(self) -> HeroDraftIn:
        _unique(self.audiences, "audience")
        if sorted(s.stage for s in self.stages) != [1, 2, 3]:
            raise ValueError("stages must be 1, 2, 3")
        return self


# ---------------------------------------------------------------- магазин


class ThemeIn(In):
    bg: str = Field(max_length=40)
    accent: str = Field(max_length=40)


class ShopItemCreateIn(In):
    code: str = Field(pattern=CODE_PATTERN)
    kind: Literal["background", "hero_frame"]
    title: Localized60
    description: Localized200
    asset_id: uuid.UUID | None
    theme: ThemeIn | None
    price_til: int = Field(ge=1, le=10_000)
    audiences: list[Audience] = Field(min_length=1, max_length=3)
    available_from: datetime | None
    available_until: datetime | None
    order: int = Field(ge=0, le=1000)

    @model_validator(mode="after")
    def _check(self) -> ShopItemCreateIn:
        _unique(self.audiences, "audience")
        if self.available_from and self.available_until and self.available_until <= self.available_from:
            raise ValueError("available_until must be after available_from")
        return self


class ShopItemPatchIn(In):
    kind: Literal["background", "hero_frame"] | None = None
    title: Localized60 | None = None
    description: Localized200 | None = None
    asset_id: uuid.UUID | None = None
    theme: ThemeIn | None = None
    price_til: int | None = Field(default=None, ge=1, le=10_000)
    audiences: list[Audience] | None = Field(default=None, min_length=1, max_length=3)
    available_from: datetime | None = None
    available_until: datetime | None = None
    order: int | None = Field(default=None, ge=0, le=1000)

    @model_validator(mode="after")
    def _check(self) -> ShopItemPatchIn:
        if self.audiences is not None:
            _unique(self.audiences, "audience")
        for name in ("kind", "title", "description", "price_til", "audiences", "order"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self

    def changes(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for name in self.model_fields_set:
            value = getattr(self, name)
            out[name] = value.model_dump() if isinstance(value, BaseModel) else value
        return out


# ---------------------------------------------------------------- события недели


class MultiplierIn(In):
    action: Literal["lesson", "scenario", "media", "reading", "review", "skill", "quest"]
    currency: Literal["xp", "til"]
    factor: float

    @field_validator("factor")
    @classmethod
    def _factor(cls, v: float) -> float:
        if v not in (1.5, 2.0, 3.0):
            raise ValueError("factor must be 1.5, 2 or 3")
        return v


class GameEventIn(In):
    code: str = Field(pattern=CODE_PATTERN)
    title: Localized80
    description: Localized300
    starts_at: datetime
    ends_at: datetime
    audiences: list[Audience] = Field(min_length=1, max_length=3)
    multipliers: list[MultiplierIn] = Field(min_length=1, max_length=5)

    @field_validator("starts_at", "ends_at")
    @classmethod
    def _aware(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("timezone is required")
        return v

    @model_validator(mode="after")
    def _check(self) -> GameEventIn:
        _unique(self.audiences, "audience")
        return self

    def data(self) -> dict[str, Any]:
        out = self.model_dump()
        out["multipliers"] = [m.model_dump() for m in self.multipliers]
        return out


class GameEventPatchIn(In):
    code: str | None = Field(default=None, pattern=CODE_PATTERN)
    title: Localized80 | None = None
    description: Localized300 | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    audiences: list[Audience] | None = Field(default=None, min_length=1, max_length=3)
    multipliers: list[MultiplierIn] | None = Field(default=None, min_length=1, max_length=5)

    @model_validator(mode="after")
    def _check(self) -> GameEventPatchIn:
        for name in self.model_fields_set:
            value = getattr(self, name)
            if value is None:
                raise ValueError(f"{name} cannot be null")
            if isinstance(value, datetime) and value.tzinfo is None:
                raise ValueError("timezone is required")
        if self.audiences is not None:
            _unique(self.audiences, "audience")
        return self

    def changes(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for name in self.model_fields_set:
            value = getattr(self, name)
            if isinstance(value, BaseModel):
                value = value.model_dump()
            elif isinstance(value, list):
                value = [v.model_dump() if isinstance(v, BaseModel) else v for v in value]
            out[name] = value
        return out


# ---------------------------------------------------------------- кошельки


class AdjustmentIn(In):
    currency: Literal["xp", "til", "freeze"]
    amount: int
    reason: str = Field(min_length=10, max_length=300)

    @model_validator(mode="after")
    def _check(self) -> AdjustmentIn:
        limit = {"xp": 100_000, "til": 10_000, "freeze": 100}[self.currency]
        if self.amount == 0 or abs(self.amount) > limit:
            raise ValueError(f"amount must be ±1..{limit}")
        if len(self.reason.strip()) < 10:
            raise ValueError("reason must have at least 10 characters")
        self.reason = self.reason.strip()
        return self

