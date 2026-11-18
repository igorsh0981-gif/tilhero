from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ActorType = Literal["staff", "user", "system", "service"]


class RecordIn(BaseModel):
    """Команда записи. record_id задаёт источник — повтор с тем же record_id идемпотентен."""

    model_config = ConfigDict(extra="forbid")

    record_id: uuid.UUID
    occurred_at: datetime
    actor_type: ActorType
    actor_id: str | None = Field(default=None, max_length=64)
    actor_role: str | None = Field(default=None, max_length=64)
    action: str = Field(min_length=3, max_length=80, pattern=r"^[a-z][a-z0-9_.]*$")
    object_type: str | None = Field(default=None, max_length=64)
    object_id: str | None = Field(default=None, max_length=128)
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    reason: str | None = Field(default=None, max_length=2000)
    ip: str | None = Field(default=None, max_length=64)
    session_id: str | None = Field(default=None, max_length=64)
    trace_id: str | None = Field(default=None, max_length=64)


class DelegatedActor(BaseModel):
    """Сотрудник, от имени которого доменный сервис выполнил команду (actor пришёл ему в токене admin-bff).
    Принимается только по списку DELEGATION в api/routes.py (издатель + действие)."""

    model_config = ConfigDict(extra="forbid")

    actor_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._@:\-]*$")
    actor_role: str = Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_]*$")


class RecordWriteIn(BaseModel):
    """HTTP-запись в журнал (писатели — api/routes.py WRITERS: identity-consent, admin-bff). Кто действовал
    (actor_*), сервис берёт ТОЛЬКО из внутреннего токена (ревью P4): сотрудник — из claim actor (его выпускает только
    admin-bff), иначе — пользователь из sub или сам сервис-издатель. Поля actor_* в теле → 422.

    Исключение — синхронная запись доменного сервиса о команде сотрудника: claim actor принимается только от
    admin-bff, поэтому домен передаёт сотрудника в `on_behalf_of`. Разрешено только по списку издатель → действия
    (api/routes.py DELEGATION: identity-consent → sensitive.view, sensitive.view_rate_limited)."""

    model_config = ConfigDict(extra="forbid")

    on_behalf_of: DelegatedActor | None = None

    record_id: uuid.UUID
    occurred_at: datetime
    action: str = Field(min_length=3, max_length=80, pattern=r"^[a-z][a-z0-9_.]*$")
    object_type: str | None = Field(default=None, max_length=64)
    object_id: str | None = Field(default=None, max_length=128)
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    reason: str | None = Field(default=None, max_length=2000)
    ip: str | None = Field(default=None, max_length=64)
    session_id: str | None = Field(default=None, max_length=64)
    trace_id: str | None = Field(default=None, max_length=64)


class RecordOut(BaseModel):
    seq: int
    record_id: uuid.UUID
    occurred_at: datetime
    recorded_at: datetime
    source: str
    actor_type: str
    actor_id: str | None
    actor_role: str | None
    action: str
    object_type: str | None
    object_id: str | None
    before: dict[str, Any] | None
    after: dict[str, Any] | None
    reason: str | None
    ip: str | None
    session_id: str | None
    trace_id: str | None
    prev_hash: str
    hash: str

    model_config = ConfigDict(from_attributes=True)


class RecordPage(BaseModel):
    items: list[RecordOut]
    next_cursor: str | None


class ChainVerification(BaseModel):
    valid: bool
    checked: int
    first_seq: int | None
    last_seq: int | None
    broken_at_seq: int | None = None
