"""Входные модели API lessons (extra="forbid"). Ответы — формы bff.ts / admin.ts, собираются доменом."""

from __future__ import annotations

import re
import uuid
from typing import Annotated, Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

OrderAnswer = Annotated[list[Annotated[StrictStr, Field(max_length=300)]], Field(max_length=30)]


class StepAnswerIn(BaseModel):
    """StepAnswer (bff.ts): answer — индекс | слова/реплики по порядку | строка пропуска; dont_know; choice_id или
    text (≤ 500) — ролевая ситуация; text — открытый ответ (≤ 300)."""

    model_config = ConfigDict(extra="forbid")

    answer: StrictInt | OrderAnswer | Annotated[StrictStr, Field(max_length=300)] | None = None
    dont_know: StrictBool = False
    choice_id: str | None = Field(default=None, min_length=2, max_length=8, pattern=r"^c[0-9]{1,3}$")
    text: str | None = Field(default=None, max_length=500)

    @field_validator("text")
    @classmethod
    def _clean_text(cls, v: str | None) -> str | None:
        # управляющие символы в реплике ученика не храним и не передаём ИИ
        return _CONTROL.sub(" ", v) if v is not None else None


class TranscriptIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=10, max_length=500)

    @field_validator("reason")
    @classmethod
    def _reason(cls, v: str) -> str:
        v = _CONTROL.sub(" ", v).strip()
        if len(v) < 10:
            raise ValueError("reason must be at least 10 characters")
        return v


# ---------------------------------------------------------------- спринт 7: дуэли и парные комнаты


class DuelSetIn(BaseModel):
    """POST /internal/v1/duel-sets (gamification): play_deadline — необязательное расширение (срок прохождения из
    дуэли; нет — LESSONS DUEL_PLAY_HOURS от выдачи набора)."""

    model_config = ConfigDict(extra="forbid")

    duel_id: uuid.UUID
    pair_id: str = Field(min_length=5, max_length=17, pattern=r"^[a-z]{2,8}-[a-z]{2,8}$")
    level_band: Literal["A0-A1", "A2", "B1+"]
    user_ids: list[uuid.UUID] = Field(min_length=2, max_length=2)
    play_deadline: AwareDatetime | None = None

    @field_validator("user_ids")
    @classmethod
    def _distinct(cls, v: list[uuid.UUID]) -> list[uuid.UUID]:
        if len(set(v)) != 2:
            raise ValueError("user_ids must be two different learners")
        return v


class DuelSessionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    duel_id: uuid.UUID


class PairRoomInviteIn(BaseModel):
    """PairRoomInvite (bff.ts): start — «now» или ISO-8601 не дальше 7 дней."""

    model_config = ConfigDict(extra="forbid")

    partner_member_id: str = Field(min_length=25, max_length=25, pattern=r"^mb_[A-Za-z0-9_-]{22}$")
    pair_id: str = Field(min_length=5, max_length=17, pattern=r"^[a-z]{2,8}-[a-z]{2,8}$")
    scenario_id: str = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9][a-z0-9._-]{1,63}$")
    start: str = Field(min_length=3, max_length=40)


class PairTurnIn(BaseModel):
    """PairTurnRequest: ровно одно поле — text (≤ 300), choice_id или audio_id."""

    model_config = ConfigDict(extra="forbid")

    text: str | None = Field(default=None, max_length=300)
    choice_id: str | None = Field(default=None, min_length=2, max_length=8, pattern=r"^c[0-9]{1,3}$")
    audio_id: uuid.UUID | None = None

    @field_validator("text")
    @classmethod
    def _clean_text(cls, v: str | None) -> str | None:
        return _CONTROL.sub(" ", v) if v is not None else None

    @model_validator(mode="after")
    def _one(self) -> PairTurnIn:
        if sum(x is not None for x in (self.text, self.choice_id, self.audio_id)) != 1:
            raise ValueError("exactly one of text, choice_id, audio_id is required")
        return self


class PairRoomStopIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=10, max_length=500)

    @field_validator("reason")
    @classmethod
    def _reason(cls, v: str) -> str:
        v = _CONTROL.sub(" ", v).strip()
        if len(v) < 10:
            raise ValueError("reason must be at least 10 characters")
        return v

