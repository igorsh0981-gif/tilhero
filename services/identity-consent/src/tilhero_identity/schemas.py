"""Pydantic-модели API.

Ответы повторяют типы packages/contracts/src/bff.ts (BFF проксирует без перекладывания) и INTERNAL_API §1.

Вход — extra="forbid". Формат PIN и тихих часов намеренно НЕ проверяется схемой: доменная проверка возвращает
бизнес-коды PIN_FORMAT / QUIET_HOURS_INVALID (контракт), а не общий VALIDATION_ERROR.
"""

from __future__ import annotations

import re
import uuid
import zoneinfo
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool, field_validator

Locale = Literal["ru", "uz"]
AgeBand = Literal["6-9", "10-13", "14-17", "18+"]
GuardianConsent = Literal["not_required", "pending", "granted", "declined"]
PublicStatus = Literal["ACTIVE", "DISABLED", "DELETION_REQUESTED"]
UserKind = Literal["account", "child"]

_TZ_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-]+){0,2}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f​-‏‪-‮⁦-⁩]")


def _check_timezone(value: str) -> str:
    if not _TZ_RE.match(value):
        raise ValueError("ожидается IANA-зона, например Asia/Tashkent")
    try:
        zoneinfo.ZoneInfo(value)
    except (zoneinfo.ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("неизвестная IANA-зона") from exc
    return value


def _check_name(value: str) -> str:
    if _CONTROL_RE.search(value):
        raise ValueError("недопустимые управляющие символы")
    return value


# Имя ребёнка: 1..40 символов после обрезки пробелов, без управляющих и невидимых символов направления текста
ChildName = Annotated[str, Field(min_length=1, max_length=40), AfterValidator(_check_name)]


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


class NotificationCategoriesPatch(_In):
    reminders: StrictBool | None = None
    missed: StrictBool | None = None
    social: StrictBool | None = None
    support: StrictBool | None = None
    product: StrictBool | None = None


class NotificationSettingsPatch(_In):
    """bff.ts SettingsPatch.notifications: Partial<NotificationSettings> + categories?: Partial<...>."""

    enabled: StrictBool | None = None
    quiet_hours: QuietHoursIn | None = None  # явный null — выключить тихие часы
    timezone: str | None = Field(default=None, max_length=64)
    categories: NotificationCategoriesPatch | None = None

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str | None) -> str | None:
        return None if v is None else _check_timezone(v)


class SettingsPatch(_In):
    """bff.ts SettingsPatch без display_name (имя аккаунта приходит из Telegram; имя ребёнка — PATCH learners)."""

    locale: Locale | None = None
    notifications: NotificationSettingsPatch | None = None


class AgeRequest(_In):
    """Аккаунт может быть только 14-17 или 18+ (ребёнок 6–13 — детский профиль у родителя)."""

    age_band: Literal["14-17", "18+"]


class CreateChildRequest(_In):
    display_name: ChildName
    age_band: Literal["6-9", "10-13"]


class LearnerPatch(_In):
    """PATCH /me/learners/{id} — только детский профиль: имя и настройки уведомлений ребёнка."""

    display_name: ChildName | None = None
    settings: NotificationSettingsPatch | None = None


class VoiceConsentRequest(_In):
    """PUT /me/learners/{child_id}/voice-consent (спринт 5, bff.ts VoiceConsentRequest): опекун разрешает или
    запрещает запись голоса детского профиля."""

    granted: StrictBool


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


class PinResetCancelRequest(_In):
    current_pin: str = Field(max_length=16)


class BiometricVerifyRequest(_In):
    biometric_token: str = Field(min_length=1, max_length=128)


class ConsentRequest(_In):
    """bff.ts ConsentRequest: обязательные terms, privacy, learning; необязательные voice_recording, social,
    product_news."""

    policy_version: str = Field(min_length=1, max_length=20)
    purposes: list[str] = Field(max_length=10)

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
    age_band: AgeBand | None
    guardian_consent: GuardianConsent


class LearnerSummary(BaseModel):
    """`is_active` и `onboarding_completed` уточняет BFF (сессия и learning-plan); домен отдаёт: сам аккаунт —
    активный по умолчанию, онбординг — false."""

    learner_id: uuid.UUID
    kind: Literal["self", "child"]
    display_name: str
    age_band: AgeBand | None
    is_active: bool
    onboarding_completed: bool
    # спринт 5: запись голоса разрешена (аккаунт — своё согласие с voice_recording, подросток — после согласия
    # родителя; детский профиль — согласие опекуна)
    voice_consent: bool


class LearnerList(BaseModel):
    items: list[LearnerSummary]


class SecurityState(BaseModel):
    pin_enabled: bool
    pin_length: Literal[4, 6] | None
    biometric_enabled: bool
    pin_required: bool
    locked_until: datetime | None
    # Ожидающий сброс кода (ревью T-8): с этого времени действует новый код; null — сброса нет (или уже действует).
    pin_reset_effective_at: datetime | None = None


class ConsentState(BaseModel):
    accepted: bool
    policy_version: str | None
    current_policy_version: str
    accepted_at: datetime | None
    evidence_hash: str | None
    purposes: list[str]


class QuietHours(BaseModel):
    start: str
    end: str


class NotificationCategories(BaseModel):
    reminders: bool
    missed: bool
    social: bool
    support: bool
    product: bool


class NotificationSettings(BaseModel):
    enabled: bool
    categories: NotificationCategories
    quiet_hours: QuietHours | None
    timezone: str


class LearnerDetail(LearnerSummary):
    """GET/PATCH /me/learners/{id}: LearnerSummary + настройки уведомлений этого ученика (дополнение к контракту:
    BFF собирает Profile.notifications активного ученика, в т.ч. детского профиля, — иначе их негде прочитать)."""

    settings: NotificationSettings


class MeResponse(BaseModel):
    user: UserSummary
    security: SecurityState
    consent: ConsentState
    settings: NotificationSettings
    learners: list[LearnerSummary]


class LoginResponse(MeResponse):
    """INTERNAL_API §1: {user, security, consent, learners} (+ settings — как GET /me, BFF не делает второй вызов)."""


class GuardianConsentRequestOut(BaseModel):
    """Ссылку `https://t.me/<bot>/<app>?startapp=gc_<token>` собирает BFF (bff.ts GuardianConsentLink)."""

    token: str
    expires_at: datetime


class GuardianConsentPreview(BaseModel):
    teen_display_name: str
    status: Literal["pending", "granted", "declined", "expired"]
    expires_at: datetime


class GuardianConsentGrant(BaseModel):
    """bff.ts GuardianConsentGrant: последнее решение этого родителя по подростку; `decided_at` — время решения или
    отзыва."""

    teen_user_id: uuid.UUID
    teen_display_name: str
    status: Literal["granted", "declined"]
    decided_at: datetime


class GuardianConsentGrantList(BaseModel):
    items: list[GuardianConsentGrant]


class OkResponse(BaseModel):
    ok: Literal[True] = True


class PinVerifyResponse(OkResponse):
    """`{ok: true}` + `pin_reset_applied`: эта проверка ввела в действие ожидающий сброс кода (срок наступил) —
    BFF отзывает прежние сессии аккаунта (ревью T-8). BFF событий не потребляет, поэтому признак — в ответе."""

    pin_reset_applied: bool = False


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
    learners: int  # сколько профилей удаляется (аккаунт + дети)


class DeliveryInfo(BaseModel):
    """Адресация notifications. Для детского профиля адресат — опекун: его Telegram ID, его блокировка бота и язык;
    категории, тихие часы и часовой пояс — ребёнка."""

    user_id: uuid.UUID
    kind: UserKind
    recipient_telegram_user_id: int
    recipient_is_guardian: bool
    learner_display_name: str
    locale: Locale
    age_band: AgeBand | None
    is_minor: bool
    notifications_enabled: bool
    categories: list[str]
    quiet_hours: QuietHours | None
    timezone: str
    status: PublicStatus


# ---------- админ-контур (спринт 2, docs/sprint2/INTERNAL_API.md §3; типы — admin.ts «Ученики») ----------

LearnerStatus = Literal["ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED"]


class RevealRequest(_In):
    """admin.ts RevealRequest: причина 5..300 символов (после обрезки пробелов) — попадает в журнал аудита."""

    field: Literal["telegram_user_id"]
    reason: str = Field(min_length=5, max_length=300)

    @field_validator("reason")
    @classmethod
    def _reason(cls, v: str) -> str:
        if _CONTROL_RE.search(v):
            raise ValueError("недопустимые управляющие символы")
        return v


class RevealResult(BaseModel):
    field: Literal["telegram_user_id"]
    value: str
    expires_in: int


class AdminConsent(BaseModel):
    """AdminLearnerCard.consent: согласие, по которому работают функции ученика (у аккаунта — своё, у детского
    профиля — родителя); нет действующего — последнее отозванное этого основания (с `revoked_at`)."""

    policy_version: str | None
    purposes: list[str]
    accepted_at: datetime | None
    revoked_at: datetime | None
    basis: Literal["self", "guardian"] | None


class AdminSecurity(BaseModel):
    pin_enabled: bool
    pin_reset_pending: bool


class AdminNotifications(BaseModel):
    """Выбор ученика (как NotificationSettings), без фильтра целей согласия и блокировки бота."""

    enabled: bool
    categories: NotificationCategories


class AdminLearnerSnapshot(BaseModel):
    """GET /admin/v1/users[/{id}] (только user-admin): поля AdminLearnerRow, которыми владеет identity-consent, и
    AdminLearnerCard.consent|security|notifications + `updated_at` (курсор сверки). Полного Telegram ID нет — только
    маска `••••••789` (у детского профиля и обезличенного ученика — null)."""

    user_id: uuid.UUID
    kind: UserKind
    guardian_user_id: uuid.UUID | None
    display_name: str | None
    username: str | None
    telegram_id_masked: str | None
    locale: Locale | None
    age_band: AgeBand | None
    guardian_consent: GuardianConsent
    status: LearnerStatus
    children_count: int
    created_at: datetime
    updated_at: datetime
    consent: AdminConsent
    security: AdminSecurity
    notifications: AdminNotifications | None


class AdminLearnerSnapshotPage(BaseModel):
    items: list[AdminLearnerSnapshot]
    next_cursor: str | None


class AudienceMember(BaseModel):
    user_id: uuid.UUID
    locale: Locale


class AudiencePage(BaseModel):
    items: list[AudienceMember]
    next_cursor: str | None


class AudienceByLang(BaseModel):
    ru: int
    uz: int


class AudienceCount(BaseModel):
    count: int
    by_lang: AudienceByLang


class PublicProfile(BaseModel):
    """Для social и notifications: имя без username и Telegram ID; guardian_consent — чтобы social решал, может ли
    подросток 14–17 приглашать и принимать приглашения. `consent_accepted` — действующее согласие с terms и privacy
    (у детского профиля — согласие родителя с основанием guardian), `purposes` — его цели; необязательные — только
    если они сейчас разрешены (18+ или 14–17 с согласием родителя; детский профиль — только voice_recording, если её
    дал опекун, спринт 5), INTERNAL_API §11."""

    user_id: uuid.UUID
    display_name: str
    kind: UserKind
    age_band: AgeBand | None
    guardian_consent: GuardianConsent
    status: PublicStatus
    consent_accepted: bool
    purposes: list[str]
