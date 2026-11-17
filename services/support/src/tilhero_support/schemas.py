"""Pydantic-модели API support-service.

Вход — строгий (extra="forbid"): лишнее поле контекста обращения → 422 (TG-FR-041, TG-FR-044: в контекст
не попадают лишние персональные данные). Формы клиентских ответов совпадают с packages/contracts/src/bff.ts.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    field_serializer,
    field_validator,
    model_serializer,
    model_validator,
)

from tilhero_support.domain.constants import (
    ANY_CATEGORY,
    CATEGORIES,
    ESCALATION_TYPES,
    PRIORITIES,
    STATUSES,
)

# Строки из пользовательского ввода: без NUL и управляющих символов (кроме перевода строки и табуляции).
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SINGLE_LINE_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


def _no_control(value: str) -> str:
    if _CONTROL_RE.search(value):
        raise ValueError("недопустимые управляющие символы")
    return value


def _single_line(value: str) -> str:
    if _SINGLE_LINE_CONTROL_RE.search(value):
        raise ValueError("недопустимые управляющие символы")
    return value


Text4000 = Annotated[str, Field(min_length=1, max_length=4000), AfterValidator(_no_control)]
Identifier = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:\-]*$")]


class StrictIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# ---------------------------------------------------------------- context (TG-FR-041)


_AMOUNT_RE = re.compile(r"^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$")
_CENTS = Decimal("0.01")


def _decimal_string(value: object) -> Decimal:
    """Деньги в контракте — строка-десятичное с ≤ 2 знаками («850.00»). JSON-число (float) отклоняется:
    двоичная плавающая точка искажает суммы (CONVENTIONS §2, ревью T3)."""
    if isinstance(value, Decimal):
        return value.quantize(_CENTS)
    if not isinstance(value, str) or not _AMOUNT_RE.match(value):
        raise ValueError('сумма — строка-десятичное с не более чем 2 знаками, например "850.00"')
    return Decimal(value).quantize(_CENTS)


MoneyString = Annotated[Decimal, BeforeValidator(_decimal_string)]


class PriceSnapshot(StrictIn):
    amount: MoneyString
    currency: Literal["USD"]
    fetched_at: datetime

    @field_validator("fetched_at")
    @classmethod
    def _aware(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("нужен часовой пояс (ISO-8601 с Z)")
        return v.astimezone(UTC)

    @field_serializer("amount")
    def _amount(self, v: Decimal) -> str:
        # bff.ts: amount — строка «850.00»; хранится Decimal-строкой в JSONB (без потери точности)
        return f"{v.quantize(_CENTS):f}"


def _https_url(value: str) -> str:
    if any(ch.isspace() for ch in value) or _SINGLE_LINE_CONTROL_RE.search(value):
        raise ValueError("ссылка содержит пробелы или управляющие символы")
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.hostname:
        raise ValueError("допустима только https-ссылка")
    if parts.username or parts.password:
        raise ValueError("ссылка не должна содержать учётные данные")
    return value


class TicketContextIn(StrictIn):
    """Технический контекст из event detail. Никаких персональных данных и переписки с AI (ТЗ Admin §3)."""

    event_id: Identifier | None = None
    offer_id: Identifier | None = None
    provider_id: Identifier | None = None
    deeplink: Annotated[str, Field(min_length=9, max_length=2048), AfterValidator(_https_url)] | None = None
    price_snapshot: PriceSnapshot | None = None
    event_title: Annotated[str, Field(min_length=1, max_length=200), AfterValidator(_single_line)] | None = (
        None
    )
    client_version: Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._\-]+$")]


class CreateTicketIn(StrictIn):
    # Категория проверяется в домене, чтобы отдать бизнес-код SUPPORT_CATEGORY_INVALID (bff.ts)
    category: Annotated[str, Field(min_length=1, max_length=40)]
    subject: Annotated[str, Field(min_length=3, max_length=120), AfterValidator(_single_line)]
    message: Text4000
    context: TicketContextIn | None = None


class UserMessageIn(StrictIn):
    text: Text4000


# ---------------------------------------------------------------- client responses (bff.ts)

TicketStatus = Literal["NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"]


class TicketContextOut(BaseModel):
    event_id: str | None = None
    offer_id: str | None = None
    provider_id: str | None = None
    deeplink: str | None = None
    price_snapshot: PriceSnapshot | None = None
    event_title: str | None = None
    client_version: str

    @model_serializer(mode="wrap")
    def _drop_absent(self, handler: SerializerFunctionWrapHandler) -> dict:
        # bff.ts: необязательные поля контекста отсутствуют, а не равны null
        return {k: v for k, v in handler(self).items() if v is not None}


class TicketMessageOut(BaseModel):
    message_id: uuid.UUID
    sender_type: Literal["user", "operator", "system"]
    author_name: str | None
    text: str
    created_at: datetime


class StatusPoint(BaseModel):
    status: TicketStatus
    at: datetime


class TicketSummaryOut(BaseModel):
    ticket_id: uuid.UUID
    number: str
    category: str
    subject: str
    status: TicketStatus
    created_at: datetime
    updated_at: datetime
    last_message_at: datetime
    unread_operator_replies: int


class TicketOut(TicketSummaryOut):
    context: TicketContextOut | None
    sla_first_response_at: datetime | None
    messages: list[TicketMessageOut]
    status_history: list[StatusPoint]


class TicketPage(BaseModel):
    items: list[TicketSummaryOut]
    next_cursor: str | None


class CategoryLabel(BaseModel):
    ru: str
    en: str


class CategoryOut(BaseModel):
    code: str
    label: CategoryLabel
    available: bool
    default_priority: str


class CategoryList(BaseModel):
    items: list[CategoryOut]


# ---------------------------------------------------------------- staff

Visibility = Literal["public", "internal"]
Priority = Literal["low", "normal", "high", "urgent"]
EscalationType = Literal["billing_review", "provider_issue", "content_review", "security_privacy"]
StaffId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._@:\-]*$")]

assert set(Priority.__args__) == set(PRIORITIES)  # type: ignore[attr-defined]
assert set(EscalationType.__args__) == set(ESCALATION_TYPES)  # type: ignore[attr-defined]
assert set(TicketStatus.__args__) == set(STATUSES)  # type: ignore[attr-defined]


class StaffMessageIn(StrictIn):
    """Имя оператора — только из claim actor.name внутреннего токена admin-bff (ревью P5), не из тела."""

    text: Text4000
    visibility: Visibility


class StaffPatchIn(StrictIn):
    status: TicketStatus | None = None
    priority: Priority | None = None
    assignee_id: StaffId | None = None

    @model_validator(mode="after")
    def _not_empty(self) -> StaffPatchIn:
        if not self.model_fields_set:
            raise ValueError("нужно изменить хотя бы одно поле: status, priority или assignee_id")
        if "status" in self.model_fields_set and self.status is None:
            raise ValueError("status не может быть null")
        if "priority" in self.model_fields_set and self.priority is None:
            raise ValueError("priority не может быть null")
        return self


class EscalationIn(StrictIn):
    type: EscalationType
    note: Annotated[str, Field(min_length=3, max_length=2000), AfterValidator(_no_control)]


class EscalationOut(BaseModel):
    escalation_id: uuid.UUID
    ticket_id: uuid.UUID
    type: str
    note: str
    status: str
    created_by: str
    created_at: datetime


class StaffMessageOut(BaseModel):
    message_id: uuid.UUID
    sender_type: Literal["user", "operator", "system"]
    visibility: Visibility
    author_id: str | None
    author_name: str | None
    text: str
    created_at: datetime


class StaffStatusPoint(BaseModel):
    from_status: str | None
    status: str
    at: datetime
    changed_by: str
    actor_id: str | None


SlaState = Literal["breached", "soon", "ok"]


class StaffTicketSummaryOut(BaseModel):
    ticket_id: uuid.UUID
    number: str
    user_id: uuid.UUID | None
    channel: str
    category: str
    subject: str
    status: str
    priority: str
    assignee_id: str | None
    has_event_context: bool
    anonymized: bool
    created_at: datetime
    updated_at: datetime
    last_message_at: datetime
    first_response_at: datetime | None
    sla_first_response_at: datetime
    sla_resolution_at: datetime
    sla_target: Literal["first_response", "resolution"] | None
    sla_due_at: datetime | None
    sla_state: SlaState
    sla_paused: bool


class StaffTicketOut(StaffTicketSummaryOut):
    context: TicketContextOut | None
    correlation_id: str | None
    resolved_at: datetime | None
    closed_at: datetime | None
    user_unread_operator_replies: int
    messages: list[StaffMessageOut]
    status_history: list[StaffStatusPoint]
    escalations: list[EscalationOut]


class StaffTicketPage(BaseModel):
    items: list[StaffTicketSummaryOut]
    next_cursor: str | None


class SlaPolicyItem(StrictIn):
    category: Annotated[str, Field(min_length=1, max_length=32)]
    priority: Priority
    first_response_minutes: Annotated[int, Field(ge=1, le=30 * 24 * 60)]
    resolution_minutes: Annotated[int, Field(ge=2, le=90 * 24 * 60)]

    @field_validator("category")
    @classmethod
    def _category(cls, v: str) -> str:
        if v != ANY_CATEGORY and v not in CATEGORIES:
            raise ValueError("неизвестная категория")
        return v

    @model_validator(mode="after")
    def _order(self) -> SlaPolicyItem:
        if self.resolution_minutes <= self.first_response_minutes:
            raise ValueError("срок решения должен быть больше срока первого ответа")
        return self


class SlaPoliciesPut(StrictIn):
    items: Annotated[list[SlaPolicyItem], Field(min_length=1, max_length=60)]
    reason: Annotated[str, Field(min_length=5, max_length=500), AfterValidator(_single_line)]

    @model_validator(mode="after")
    def _unique(self) -> SlaPoliciesPut:
        keys = [(i.category, i.priority) for i in self.items]
        if len(keys) != len(set(keys)):
            raise ValueError("повтор пары category/priority")
        return self


class SlaPolicyOut(BaseModel):
    category: str
    priority: str
    first_response_minutes: int
    resolution_minutes: int
    updated_at: datetime
    updated_by: str | None


class SlaPoliciesOut(BaseModel):
    items: list[SlaPolicyOut]
    category_defaults: dict[str, str]


class SupportStatsOut(BaseModel):
    """GET /admin/v1/support/stats → блок support Dashboard (admin.ts). open/in_progress/waiting_customer/breached —
    текущее состояние очереди; средние — по обращениям, получившим первый ответ / решение за период."""

    open: int
    in_progress: int
    waiting_customer: int
    breached: int
    avg_first_response_minutes: float | None
    avg_resolution_minutes: float | None
