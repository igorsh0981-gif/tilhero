from __future__ import annotations

from typing import Annotated
from urllib.parse import urlsplit

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator


def _https(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise ValueError("кнопка-ссылка: только https без учётных данных")
    if any(ch.isspace() for ch in value):
        raise ValueError("ссылка содержит пробелы")
    return value


class ButtonIn(BaseModel):
    """Кнопка: либо startapp (web_app в Mini App), либо внешняя https-ссылка."""

    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, Field(min_length=1, max_length=64)]
    startapp: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")] | None = None
    url: Annotated[str, Field(min_length=9, max_length=2048), AfterValidator(_https)] | None = None

    @model_validator(mode="after")
    def _one_target(self) -> ButtonIn:
        if (self.startapp is None) == (self.url is None):
            raise ValueError("нужно ровно одно из полей: startapp или url")
        return self


class SendMessageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    telegram_user_id: Annotated[int, Field(gt=0, lt=2**53)]
    # HTML (parse_mode=HTML); параметры шаблонов уже экранированы в notifications
    text: Annotated[str, Field(min_length=1, max_length=4096)]
    buttons: (
        Annotated[list[Annotated[list[ButtonIn], Field(min_length=1, max_length=4)]], Field(max_length=8)]
        | None
    ) = None
    disable_notification: bool = False
    idempotency_key: Annotated[str, Field(pattern=r"^[A-Za-z0-9._:\-]{8,128}$")]


class SendMessageOut(BaseModel):
    message_id: int


class OpsButtonIn(BaseModel):
    """Кнопка-ссылка ops-сообщения; домен (ADMIN_WEB_URL) проверяет обработчик — он знает настройки."""

    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, Field(min_length=1, max_length=40)]
    url: Annotated[str, Field(min_length=9, max_length=2048), AfterValidator(_https)]


class OpsMessageIn(BaseModel):
    """POST /internal/v1/ops-messages (спринт 8, §6): обычный текст без разметки, чат — только из OPS_ALERT_CHAT_ID."""

    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, Field(min_length=1, max_length=3500)]
    button: OpsButtonIn | None = None
    # спринт 9 (INTERNAL_API §6.2): кнопка «Runbook» — только раздел runbook'ов репозитория (RUNBOOK_BASE_URL)
    runbook_button: OpsButtonIn | None = None
    dedup_key: Annotated[str, Field(pattern=r"^[A-Za-z0-9._:\-]{8,128}$")]
