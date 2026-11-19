"""Входные модели API lessons (extra="forbid"). Ответы — формы bff.ts / admin.ts, собираются доменом."""

from __future__ import annotations

import re
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, field_validator

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
