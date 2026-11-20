"""Входные модели API memory (extra="forbid"). Ответы — формы bff.ts / admin.ts «Спринт 5», собираются доменом."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, field_validator, model_validator

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
CONTENT_ID = r"^[a-z0-9][a-z0-9._-]{1,63}$"


def _clean(v: str | None) -> str | None:
    return _CONTROL.sub(" ", v) if v is not None else None


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ContentRefIn(_In):
    """ContentRef (bff.ts): locator — s_id предложения, индекс реплики, ex:<i> / kw:<i>, node_id."""

    kind: Literal["lesson", "media_asset", "reading", "scenario"]
    key: str = Field(min_length=2, max_length=64, pattern=CONTENT_ID)
    version: StrictInt = Field(ge=1, le=1_000_000)
    locator: str | None = Field(default=None, min_length=1, max_length=32, pattern=r"^[A-Za-z0-9:._-]+$")


class SourceIn(ContentRefIn):
    """Источник ручного добавления: ContentRef (+ text_en — форма INTERNAL_API §1.2)."""

    text_en: str | None = Field(default=None, min_length=1, max_length=120)


class AddCardIn(_In):
    """AddCardRequest (bff.ts) {text_en, source: ContentRef} или {source: {kind, key, version, text_en}}."""

    text_en: str | None = Field(default=None, min_length=1, max_length=120)
    source: SourceIn

    @model_validator(mode="after")
    def _text(self) -> AddCardIn:
        text = self.text_en or self.source.text_en
        if not text or not text.strip():
            raise ValueError("text_en is required")
        self.text_en = _clean(text.strip())
        return self


class LookupIn(_In):
    texts: list[Annotated[StrictStr, Field(min_length=1, max_length=120)]] = Field(max_length=50)


class TranslateIn(_In):
    """TranslateRequest: {text ≤ 60, content: ContentRef} (bff.ts) или {text, content_ref} (INTERNAL_API §1.7)."""

    text: str = Field(min_length=1, max_length=60)
    content_ref: ContentRefIn | None = None
    content: ContentRefIn | None = None

    @model_validator(mode="after")
    def _ref(self) -> TranslateIn:
        if (self.content_ref is None) == (self.content is None):
            raise ValueError("exactly one of content_ref / content is required")
        self.text = _clean(self.text) or ""
        return self

    @property
    def ref(self) -> ContentRefIn:
        ref = self.content_ref or self.content
        assert ref is not None
        return ref


class ReviewAnswerIn(_In):
    """ReviewAnswer (bff.ts): choice — индекс; text ≤ 200; order — порядок плиток/вариантов; known — «Знаю это»."""

    choice: StrictInt | None = Field(default=None, ge=0, le=50)
    text: str | None = Field(default=None, max_length=200)
    order: list[StrictInt] | None = Field(default=None, max_length=60)
    known: StrictBool | None = None

    @field_validator("text")
    @classmethod
    def _text(cls, v: str | None) -> str | None:
        return _clean(v)

    def as_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.model_dump().items() if v is not None}


class HintIn(_In):
    kind: Literal["first_letter", "reveal"]


class CardActionIn(_In):
    """CardAction (admin.ts): reschedule {due_at}; reset; freeze; unfreeze — причина ≥ 10 символов."""

    action: Literal["reschedule", "reset", "freeze", "unfreeze"]
    due_at: datetime | None = None
    reason: str = Field(min_length=10, max_length=300)

    @field_validator("reason")
    @classmethod
    def _reason(cls, v: str) -> str:
        v = (_clean(v) or "").strip()
        if len(v) < 10:
            raise ValueError("reason must be at least 10 characters")
        return v

    @model_validator(mode="after")
    def _due(self) -> CardActionIn:
        if self.action == "reschedule":
            if self.due_at is None or self.due_at.tzinfo is None:
                raise ValueError("due_at (with timezone) is required for reschedule")
        elif self.due_at is not None:
            raise ValueError("due_at is allowed only for reschedule")
        return self
