"""Pydantic-модели API.

Ответы повторяют типы packages/contracts/src/bff.ts (BFF проксирует без перекладывания).

Вход — extra="forbid". Формат PIN намеренно НЕ проверяется схемой: доменная проверка возвращает бизнес-код
PIN_FORMAT (контракт), а не общий VALIDATION_ERROR.
"""

from __future__ import annotations

import re
import uuid
import zoneinfo
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Locale = Literal["ru", "en"]
PublicStatus = Literal["ACTIVE", "DISABLED", "DELETION_REQUESTED"]

HHMM_RE = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
_TZ_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-]+){0,2}$")


def _check_hhmm(value: str) -> str:
    if not HHMM_RE.match(value):
        raise ValueError("ожидается время HH:MM (00:00–23:59)")
    return value


def _check_timezone(value: str) -> str:
    if not _TZ_RE.match(value):
        raise ValueError("ожидается IANA-зона, например Asia/Tashkent")
    try:
        zoneinfo.ZoneInfo(value)
    except (zoneinfo.ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("неизвестная IANA-зона") from exc
    return value


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# ---------- вход ----------

class TelegramLoginRequest(_In):
    """Снимок пользователя из проверенного BFF initData."""

    telegram_user_id: int = Field(ge=1, le=2**53)
    username: str | None = Field(default=None, max_length=64)
    first_name: str = Field(min_length=1, max_length=64)
    last_name: str | None = Field(default=None, max_length=64)
    language_code: str | None = Field(default=None, max_length=35)


class QuietHoursIn(_In):
    start: str = Field(max_length=5)
    end: str = Field(max_length=5)

    @field_validator("start", "end")
    @classmethod
    def _hhmm(cls, v: str) -> str:
        return _check_hhmm(v)

    @model_validator(mode="after")
    def _distinct(self) -> QuietHoursIn:
        if self.start == self.end:
            raise ValueError("начало и конец тихих часов совпадают")
        return self


class NotificationSettingsPatch(_In):
    enabled: bool | None = None
    quiet_hours: QuietHoursIn | None = None  # явный null — выключить тихие часы
    digest_time: str | None = Field(default=None, max_length=5)
    timezone: str | None = Field(default=None, max_length=64)

    @field_validator("digest_time")
    @classmethod
    def _digest(cls, v: str | None) -> str | None:
        return None if v is None else _check_hhmm(v)

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str | None) -> str | None:
        return None if v is None else _check_timezone(v)


class SettingsPatch(_In):
    locale: Locale | None = None
    notifications: NotificationSettingsPatch | None = None


class PinSetRequest(_In):
    pin: str = Field(max_length=16)
    current_pin: str | None = Field(default=None, max_length=16)


class PinRemoveRequest(_In):
    current_pin: str = Field(max_length=16)


class PinVerifyRequest(_In):
    pin: str = Field(max_length=16)


class PinResetConfirmRequest(_In):
    code: str = Field(pattern=r"^[0-9]{6}$")
    new_pin: str = Field(max_length=16)


class BiometricVerifyRequest(_In):
    biometric_token: str = Field(min_length=1, max_length=128)


class ConsentRequest(_In):
    policy_version: str = Field(min_length=1, max_length=20)
    purposes: list[str] = Field(max_length=10)
    # Контракт: `true`. Отсутствие/false → 422 AGE_CONFIRMATION_REQUIRED (бизнес-код, а не VALIDATION_ERROR).
    age_confirmed_18_plus: bool = False

    @field_validator("purposes")
    @classmethod
    def _purposes(cls, v: list[str]) -> list[str]:
        if any(len(p) > 32 for p in v):
            raise ValueError("код цели длиннее 32 символов")
        return v


class DeletionRequestIn(_In):
    pin: str | None = Field(default=None, max_length=16)
    confirm_word: str | None = Field(default=None, max_length=32)


class BotStatusRequest(_In):
    blocked: bool


# ---------- выход (bff.ts) ----------

class UserSummary(BaseModel):
    user_id: uuid.UUID
    display_name: str
    username: str | None
    locale: Locale
    status: PublicStatus
    is_new: bool


class SecurityState(BaseModel):
    pin_enabled: bool
    pin_length: Literal[4, 6] | None
    biometric_enabled: bool
    pin_required: bool
    locked_until: datetime | None


class ConsentState(BaseModel):
    accepted: bool
    policy_version: str | None
    current_policy_version: str
    accepted_at: datetime | None
    evidence_hash: str | None
    age_confirmed_18_plus: bool


class QuietHours(BaseModel):
    start: str
    end: str


class NotificationSettings(BaseModel):
    enabled: bool
    quiet_hours: QuietHours | None
    digest_time: str
    timezone: str


class MeResponse(BaseModel):
    user: UserSummary
    security: SecurityState
    consent: ConsentState
    settings: NotificationSettings


class LoginResponse(MeResponse):
    # Заполняет BFF из preferences; домен identity не владеет онбордингом.
    onboarding_completed: None = None


class OkResponse(BaseModel):
    ok: Literal[True] = True


class PinResetRequestResponse(BaseModel):
    expires_in: int


class BiometricEnableResponse(BaseModel):
    biometric_token: str
    security: SecurityState


class PolicyPurposeOut(BaseModel):
    code: str
    required: bool
    title: str
    description: str


class PolicyDocument(BaseModel):
    version: str
    purposes: list[PolicyPurposeOut]
    text: str


class DeletionResponse(BaseModel):
    request_id: uuid.UUID
    status: Literal["REQUESTED"]
    domains: list[str]


class DeliveryInfo(BaseModel):
    telegram_user_id: int
    locale: Locale
    notifications_enabled: bool
    quiet_hours: QuietHours | None
    digest_time: str  # "HH:MM" в timezone пользователя — дайджест notifications (спринт 6, §5)
    timezone: str
    status: PublicStatus


# ---------- админ-контур (спринт 2, docs/sprint2/INTERNAL_API.md) ----------

AdminStatus = Literal["ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED"]


class RevealRequest(_In):
    """admin.ts RevealRequest. Причина обязательна (≥ 5 символов) — попадает в журнал аудита."""

    field: Literal["telegram_user_id"]
    reason: str = Field(min_length=5, max_length=500)

    @field_validator("reason")
    @classmethod
    def _reason(cls, v: str) -> str:
        if re.search(r"[\x00-\x1f\x7f]", v):
            raise ValueError("недопустимые управляющие символы")
        return v


class RevealResult(BaseModel):
    field: Literal["telegram_user_id"]
    value: str
    expires_in: int


class AdminConsent(BaseModel):
    policy_version: str | None
    purposes: list[str]
    accepted_at: datetime | None
    age_confirmed_18_plus: bool
    revoked_at: datetime | None


class AdminSecurity(BaseModel):
    pin_enabled: bool
    biometric_enabled: bool


class AdminIdentityUser(BaseModel):
    """Снимок профиля для read-модели user-admin. Полного Telegram ID нет — только маска."""

    user_id: uuid.UUID
    username: str | None
    display_name: str | None
    telegram_id_masked: str
    locale: Locale
    status: AdminStatus
    created_at: datetime
    updated_at: datetime
    last_seen_at: datetime | None
    consent: AdminConsent
    security: AdminSecurity


class AdminIdentityUserPage(BaseModel):
    items: list[AdminIdentityUser]
    next_cursor: str | None
