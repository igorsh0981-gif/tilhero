"""Pydantic-модели API notifications: центр уведомлений (bff.ts InboxItem, Page<InboxItem>, InboxReadRequest),
транзакционная отправка (identity-consent), запуск обработки (n8n)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_serializer, model_validator

from tilhero_notifications.templates import DIRECT_TEMPLATES

# bff.ts NotificationCategory (спринт 7: + game)
InboxCategory = Literal["reminders", "missed", "social", "support", "product", "service", "game"]
InboxTelegram = Literal["sent", "scheduled", "in_app_only", "failed"]


def iso_z(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


class InboxItem(BaseModel):
    notification_id: uuid.UUID
    category: InboxCategory
    title: str
    body: str
    startapp: str | None
    created_at: datetime
    read_at: datetime | None
    telegram: InboxTelegram

    @field_serializer("created_at", "read_at")
    def _ts(self, value: datetime | None) -> str | None:
        return iso_z(value) if value is not None else None


class InboxPage(BaseModel):
    items: list[InboxItem]
    next_cursor: str | None


class InboxReadIn(BaseModel):
    """bff.ts InboxReadRequest: ids (≤ 100) или all=true; ни того ни другого → 422."""

    model_config = ConfigDict(extra="forbid")

    ids: Annotated[list[uuid.UUID], Field(max_length=100)] | None = None
    all: Literal[True] | None = None

    @model_validator(mode="after")
    def _something(self) -> InboxReadIn:
        if not self.all and not self.ids:
            raise ValueError("нужно ids или all")
        return self


class UnreadOut(BaseModel):
    unread: int


class TransactionalIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    notification_id: uuid.UUID
    user_id: uuid.UUID
    template: Literal["pin.reset_code", "pin.reset_scheduled"]
    params: dict[str, Any]
    dedup_key: Annotated[str, Field(min_length=1, max_length=200)]


class TransactionalOut(BaseModel):
    notification_id: uuid.UUID
    status: Literal["queued", "sent", "failed", "skipped"]
    reason: str | None = None


class DispatchOut(BaseModel):
    sent: int
    scheduled: int
    in_app_only: int
    failed: int


if set(TransactionalIn.model_fields["template"].annotation.__args__) != set(DIRECT_TEMPLATES):  # type: ignore[union-attr]
    raise RuntimeError("TransactionalIn.template must list exactly the direct-only templates")


# ---------------------------------------------------------------- staff API (спринт 2, admin.ts)
# Структура — pydantic (лишние поля → 422 VALIDATION_ERROR); содержание (пустой язык, длины, плейсхолдеры,
# управляющие символы, давление) — domain/texts.py → 422 TEMPLATE_INVALID / CAMPAIGN_INVALID {fields}.

UiLang = Literal["ru", "uz"]
_IN = ConfigDict(extra="forbid")


class TextIn(BaseModel):
    model_config = _IN

    title: Annotated[str, Field(max_length=2000)] | None = None
    body: Annotated[str, Field(max_length=8000)] | None = None
    button: Annotated[str, Field(max_length=500)] | None = None


class TextsIn(BaseModel):
    model_config = _IN

    ru: TextIn | None = None
    uz: TextIn | None = None


class TemplateVersionIn(BaseModel):
    model_config = _IN

    texts: TextsIn
    note: Annotated[str, Field(max_length=2000)]


class PreviewIn(BaseModel):
    model_config = _IN

    lang: UiLang
    sample: Annotated[dict[str, Annotated[str, Field(max_length=200)]], Field(max_length=20)] | None = None


class ReasonIn(BaseModel):
    model_config = _IN

    reason: Annotated[str, Field(min_length=3, max_length=300)]


class TestSendIn(BaseModel):
    model_config = _IN

    lang: UiLang
    recipient: int


class SegmentIn(BaseModel):
    model_config = _IN

    ui_lang: Annotated[list[Annotated[str, Field(max_length=16)]], Field(max_length=10)] | None = None
    age: Annotated[list[Annotated[str, Field(max_length=16)]], Field(max_length=10)] | None = None
    onboarded: bool | None = None
    active_days: int | None = None


class CampaignContentIn(BaseModel):
    """CampaignContent (POST) и Partial<CampaignContent> (PATCH): что пришло — `model_fields_set`."""

    model_config = _IN

    title: Annotated[str, Field(max_length=2000)] | None = None
    texts: TextsIn | None = None
    route: Annotated[str, Field(max_length=64)] | None = None
    segment: SegmentIn | None = None


class CampaignPatchIn(CampaignContentIn):
    expected_version: Annotated[int, Field(ge=1)]


class CampaignScheduleIn(BaseModel):
    model_config = _IN

    expected_version: Annotated[int, Field(ge=1)]
    send_at: datetime | None  # null — «Отправить сейчас» по часам сервера (QA D2-03, ревью T2-11); ключ обязателен
    reason: Annotated[str, Field(min_length=3, max_length=300)]
