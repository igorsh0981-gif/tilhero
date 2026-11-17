"""Сценарии identity-consent. Каждая изменяющая команда — одна транзакция с блокировкой строки аккаунта
(SELECT … FOR UPDATE сериализует параллельные команды одного аккаунта, в т.ч. над его детскими профилями) и событиями
через outbox.

Секреты (PIN, код сброса, биометрический токен, токен ссылки родителя) не попадают ни в логи, ни в события, ни в
outbox: код сброса уходит синхронным вызовом notifications /internal/v1/notifications/transactional, токен ссылки
родителя возвращается только создателю (BFF собирает ссылку), в БД — только sha256.

Субъекты (INTERNAL_API §1): `/me/*` — `sub` = аккаунт Telegram (`kind=account`); детский профиль 6–13 (`kind=child`)
сам ничего не вызывает — им управляет опекун через `/me/learners/{id}`.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any, NoReturn

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.context import pseudonymize
from tilhero_common.errors import ApiError, conflict, forbidden, not_found, unavailable, unprocessable
from tilhero_common.http_client import UpstreamError
from tilhero_common.messaging import Envelope, emit
from tilhero_common.redis_tools import AttemptState, fingerprint
from tilhero_identity.deletion import saga as deletion_saga
from tilhero_identity.deletion import store as deletion_store
from tilhero_identity.domain.age import (
    TEEN,
    guardian_consent_for,
    is_adult,
    is_minor,
    optional_purposes_allowed,
)
from tilhero_identity.domain.attempts import BIOMETRIC_INVALID, PIN_INVALID, Failure, PinAttempts, pin_locked
from tilhero_identity.domain.evidence import evidence_hash, iso_utc_ms, truncate_ms
from tilhero_identity.domain.guardian import derive_token, token_hash, token_key, well_formed
from tilhero_identity.domain.locale import locale_from_language_code
from tilhero_identity.domain.notify import (
    CATEGORIES,
    DEFAULT_CATEGORIES,
    DEFAULT_QUIET_END,
    DEFAULT_QUIET_START,
    QuietHoursError,
    apply_categories,
    hhmm,
    normalize_categories,
    parse_quiet_hours,
)
from tilhero_identity.domain.pin import PinHasher, new_biometric_token, pin_problem, token_digest, token_matches
from tilhero_identity.domain.policy import get_policy, normalize_purposes
from tilhero_identity.domain.reset_codes import ResetCodeStore
from tilhero_identity.models import (
    BiometricCredential,
    Consent,
    DeletionRequest,
    GuardianConsentRequest,
    GuardianLink,
    PinCredential,
    User,
)
from tilhero_identity.schemas import (
    AgeRequest,
    BiometricEnableResponse,
    ConsentRequest,
    ConsentState,
    CreateChildRequest,
    DeletionRequestIn,
    DeletionResponse,
    DeliveryInfo,
    GuardianConsentPreview,
    GuardianConsentRequestOut,
    LearnerDetail,
    LearnerList,
    LearnerPatch,
    LearnerSummary,
    LoginResponse,
    MeResponse,
    NotificationCategories,
    NotificationSettings,
    NotificationSettingsPatch,
    PinSetRequest,
    PublicProfile,
    QuietHours,
    SecurityState,
    SettingsPatch,
    TelegramLoginRequest,
    UserSummary,
)
from tilhero_identity.settings import Settings

log = logging.getLogger("tilhero.identity")

DOMAIN = "identity-consent"
CHANNEL = "telegram"
# Слово подтверждения удаления без кода родителя (bff.ts DeletionRequest): RU и UZ (латиница, «oʻ» — U+02BB).
DELETION_WORDS = frozenset({"УДАЛИТЬ", "OʻCHIRISH"})
_APOSTROPHES = str.maketrans(dict.fromkeys("'‘’ʼ`´", "ʻ"))
LIVE_STATUSES = ("ACTIVE", "DISABLED")  # ученик виден в списке и управляется

EV_PROFILE_CREATED = "user.profile.created.v1"
EV_PROFILE_UPDATED = "user.profile.updated.v1"
EV_NOTIFY_CHANGED = "user.notification_settings.changed.v1"
EV_SECURITY_CHANGED = "user.security.changed.v1"
EV_STATUS_CHANGED = "user.status.changed.v1"
EV_CONSENT_ACCEPTED = "consent.accepted.v1"
EV_CONSENT_REVOKED = "consent.revoked.v1"
EV_DELETION_REQUESTED = "user.deletion.requested.v1"
EV_DOMAIN_DELETED = "user.domain.deleted.v1"
RESET_TEMPLATE = "pin.reset_code"

_hasher = PinHasher()


def _now() -> datetime:
    return datetime.now(UTC)


def _user_not_found() -> ApiError:
    return not_found("USER_NOT_FOUND", "Пользователь не найден")


def _learner_not_found() -> ApiError:
    return not_found("LEARNER_NOT_FOUND", "Профиль ученика не найден")


def _guardian_consent_not_found() -> ApiError:
    return not_found("GUARDIAN_CONSENT_NOT_FOUND", "Ссылка согласия не найдена")


def _adult_required(age_band: str | None) -> ApiError:
    return forbidden("ADULT_REQUIRED", "Действие доступно только взрослому (18+)", {"age_band": age_band})


def _bot_blocked() -> ApiError:
    return conflict("BOT_BLOCKED", "Бот TilHero заблокирован в Telegram — разблокируйте его, чтобы получить код")


def _ensure_mutable(user: User) -> None:
    if user.status == "DELETION_REQUESTED":
        raise conflict("USER_DELETION_REQUESTED", "Профиль удаляется — изменения недоступны")


def _display_name(first_name: str, last_name: str | None) -> str:
    return " ".join(p for p in (first_name.strip(), (last_name or "").strip()) if p)[:160]


def _username(raw: str | None) -> str | None:
    value = (raw or "").strip().lstrip("@")
    return value or None


def _deletion_word(raw: str | None) -> str:
    return (raw or "").strip().upper().translate(_APOSTROPHES)


def effective_delivery(learner: User, recipient: User) -> bool:
    """Доставка в Telegram (центр уведомлений работает всегда): выключатель ученика, оба профиля активны, адресат
    (сам аккаунт или опекун ребёнка) не заблокировал бота и не обезличен."""
    return bool(
        learner.notifications_enabled
        and learner.status == "ACTIVE"
        and recipient.status == "ACTIVE"
        and not recipient.bot_blocked
        and recipient.telegram_user_id is not None
    )


# ---------- представления ----------

def user_summary(user: User, *, is_new: bool = False) -> UserSummary:
    return UserSummary(
        user_id=user.user_id,
        display_name=user.display_name or "",
        username=user.username,
        locale=user.locale,  # type: ignore[arg-type]
        status=user.status,  # type: ignore[arg-type]
        is_new=is_new,
        age_band=user.age_band,  # type: ignore[arg-type]
        guardian_consent=user.guardian_consent,  # type: ignore[arg-type]
    )


def learner_summary(user: User, *, is_self: bool) -> LearnerSummary:
    return LearnerSummary(
        learner_id=user.user_id,
        kind="self" if is_self else "child",
        display_name=user.display_name or "",
        age_band=user.age_band,  # type: ignore[arg-type]
        is_active=is_self,  # активного ученика сессии знает BFF; по умолчанию активен сам аккаунт
        onboarding_completed=False,  # заполняет BFF из learning-plan
    )


def learner_detail(user: User, *, is_self: bool) -> LearnerDetail:
    return LearnerDetail(**learner_summary(user, is_self=is_self).model_dump(), settings=notification_settings(user))


def quiet_hours(user: User) -> QuietHours | None:
    if user.quiet_hours_start is None or user.quiet_hours_end is None:
        return None
    return QuietHours(start=hhmm(user.quiet_hours_start), end=hhmm(user.quiet_hours_end))


def notification_settings(user: User) -> NotificationSettings:
    enabled = set(user.notify_categories)
    return NotificationSettings(
        enabled=user.notifications_enabled,
        categories=NotificationCategories(**{c: c in enabled for c in CATEGORIES}),
        quiet_hours=quiet_hours(user),
        timezone=user.timezone,
    )


def consent_state(active: Consent | None, current_version: str) -> ConsentState:
    return ConsentState(
        accepted=active is not None,
        policy_version=active.policy_version if active else None,
        current_policy_version=current_version,
        accepted_at=active.accepted_at if active else None,
        evidence_hash=active.evidence_hash if active else None,
        purposes=list(active.purposes) if active else [],
    )


def _preview_status(row: GuardianConsentRequest, now: datetime) -> str:
    if row.status in ("granted", "declined"):
        return row.status
    if row.status == "pending" and row.expires_at > now:
        return "pending"
    return "expired"  # истёк срок, отозвана новой ссылкой или удалением


class IdentityService:
    def __init__(self, runtime: Runtime) -> None:
        self.rt = runtime
        self.settings: Settings = runtime.settings  # type: ignore[assignment]
        self._locked_users: list[uuid.UUID] = []  # pin_locked — опубликовать после отката основной транзакции

    @asynccontextmanager
    async def _tx(self) -> AsyncIterator[AsyncSession]:
        """Транзакция команды. Факт блокировки PIN фиксируется отдельной транзакцией ПОСЛЕ завершения основной
        (она откатывается исключением 423): событие не пишется во втором соединении, пока первое держит FOR UPDATE
        строки пользователя, — при массовых блокировках пул не исчерпывается."""
        try:
            async with self.rt.transaction() as session:
                yield session
        finally:
            while self._locked_users:
                user_id = self._locked_users.pop()
                try:
                    async with self.rt.transaction() as session:
                        await self._emit_security(session, user_id, "pin_locked")
                except Exception:
                    log.error("pin_locked event was not recorded", exc_info=True)

    # ---------- инфраструктура ----------
    @property
    def redis(self):
        if self.rt.redis is None:
            raise unavailable("REDIS_UNAVAILABLE", "Хранилище попыток недоступно")
        return self.rt.redis

    @property
    def attempts(self) -> PinAttempts:
        return PinAttempts(self.redis, self.settings.pin_max_attempts, self.settings.pin_lock_seconds)

    @property
    def reset_codes(self) -> ResetCodeStore:
        s = self.settings
        return ResetCodeStore(
            self.redis,
            s.internal_jwt_secret.get_secret_value(),
            ttl_seconds=s.pin_reset_code_ttl_seconds,
            max_attempts=s.pin_reset_code_max_attempts,
            min_interval_seconds=s.pin_reset_min_interval_seconds,
            daily_limit=s.pin_reset_daily_limit,
        )

    @property
    def _token_key(self) -> bytes:
        return token_key(self.settings.internal_jwt_secret.get_secret_value())

    async def _emit(self, session: AsyncSession, event_type: str, payload: dict[str, Any]) -> Envelope:
        user_id = payload.get("user_id")
        if user_id:
            # Любое изменение ученика (в т.ч. PIN, согласие — другие таблицы) двигает users.updated_at: по нему
            # read-модель админки (спринт 2) курсорно сверяется с identity.
            await session.execute(
                update(User)
                .where(User.user_id == uuid.UUID(str(user_id)))
                .values(updated_at=func.now())
                .execution_options(synchronize_session=False)
            )
        return await emit(session, event_type, payload, producer=self.settings.service_name)

    async def _emit_security(self, session: AsyncSession, user_id: uuid.UUID, change: str) -> None:
        await self._emit(session, EV_SECURITY_CHANGED, {"user_id": str(user_id), "change": change})

    async def _profile_updated(self, session: AsyncSession, user: User, changed_fields: list[str]) -> None:
        """user.profile.updated.v1 — без PII (имя ребёнка не передаётся, только факт изменения)."""
        await self._emit(session, EV_PROFILE_UPDATED, {
            "user_id": str(user.user_id),
            "changed_fields": changed_fields,
            "age_band": user.age_band,
            "is_minor": is_minor(user.age_band),
            "locale": user.locale,
            "guardian_consent": user.guardian_consent,
        })

    async def _notify_changed(self, session: AsyncSession, learner: User, recipient: User) -> None:
        """user.notification_settings.changed.v1 — сброс кэша адресации в notifications. `enabled` — итоговая
        доставка в Telegram (как DeliveryInfo.notifications_enabled), `categories` — включённые категории."""
        await self._emit(session, EV_NOTIFY_CHANGED, {
            "user_id": str(learner.user_id),
            "enabled": effective_delivery(learner, recipient),
            "categories": normalize_categories(learner.notify_categories),
        })

    async def _load_user(self, session: AsyncSession, user_id: uuid.UUID, *, lock: bool = False) -> User:
        stmt = select(User).where(User.user_id == user_id)
        if lock:
            stmt = stmt.with_for_update()
        user = (await session.execute(stmt)).scalar_one_or_none()
        if user is None or user.status == "DELETED":
            raise _user_not_found()
        return user

    async def _load_account(self, session: AsyncSession, user_id: uuid.UUID, *, lock: bool = False) -> User:
        """`sub` аккаунтных команд — только аккаунт Telegram; детский профиль сам ничего не вызывает (404)."""
        user = await self._load_user(session, user_id, lock=lock)
        if user.kind != "account":
            raise _user_not_found()
        return user

    @staticmethod
    async def _active_consent(
        session: AsyncSession, user_id: uuid.UUID, *, lock: bool = False
    ) -> Consent | None:
        stmt = select(Consent).where(Consent.user_id == user_id, Consent.revoked_at.is_(None))
        if lock:
            stmt = stmt.with_for_update()
        return (await session.execute(stmt)).scalar_one_or_none()

    @staticmethod
    async def _children(
        session: AsyncSession, guardian_id: uuid.UUID, *, lock: bool = False,
        statuses: tuple[str, ...] = LIVE_STATUSES,
    ) -> list[User]:
        stmt = (
            select(User)
            .join(GuardianLink, GuardianLink.child_user_id == User.user_id)
            .where(GuardianLink.guardian_user_id == guardian_id, User.status.in_(statuses))
            .order_by(GuardianLink.created_at, User.user_id)
        )
        if lock:
            stmt = stmt.with_for_update(of=User)
        return list((await session.execute(stmt)).scalars().all())

    @staticmethod
    async def _guardian_of(session: AsyncSession, child: User) -> User | None:
        link = await session.get(GuardianLink, child.user_id)
        return None if link is None else await session.get(User, link.guardian_user_id)

    async def _find_learner(
        self, session: AsyncSession, account: User, learner_id: uuid.UUID, *, lock: bool = False
    ) -> tuple[User, bool]:
        """Свой профиль или свой ребёнок; чужой и несуществующий неотличимы → 404 LEARNER_NOT_FOUND."""
        if learner_id == account.user_id:
            return account, True
        stmt = (
            select(User)
            .join(GuardianLink, GuardianLink.child_user_id == User.user_id)
            .where(GuardianLink.guardian_user_id == account.user_id, User.user_id == learner_id,
                   User.status.in_(LIVE_STATUSES))
        )
        if lock:
            stmt = stmt.with_for_update(of=User)
        child = (await session.execute(stmt)).scalar_one_or_none()
        if child is None:
            raise _learner_not_found()
        return child, False

    async def _security(
        self, user_id: uuid.UUID, pin: PinCredential | None, bio: BiometricCredential | None
    ) -> SecurityState:
        locked_until = None
        if self.rt.redis is not None:
            try:
                state = await self.attempts.state(user_id)
                if state.locked:
                    locked_until = _now().replace(microsecond=0) + timedelta(seconds=state.retry_after)
            except Exception:  # отображение статуса не должно падать из-за Redis; проверки PIN — fail-closed
                log.warning("attempt state unavailable", exc_info=True)
        return SecurityState(
            pin_enabled=pin is not None,
            pin_length=pin.pin_length if pin else None,  # type: ignore[arg-type]
            biometric_enabled=bio is not None,
            # Домен сообщает «для новой сессии нужен код родителя»; BFF уточняет по состоянию конкретной сессии.
            pin_required=pin is not None,
            locked_until=locked_until,
        )

    async def _security_for(self, session: AsyncSession, user_id: uuid.UUID) -> SecurityState:
        pin = await session.get(PinCredential, user_id)
        bio = await session.get(BiometricCredential, user_id)
        return await self._security(user_id, pin, bio)

    async def _learners(self, session: AsyncSession, account: User) -> list[LearnerSummary]:
        children = await self._children(session, account.user_id)
        return [learner_summary(account, is_self=True), *(learner_summary(c, is_self=False) for c in children)]

    async def _me(self, session: AsyncSession, user: User, *, is_new: bool = False) -> MeResponse:
        active = await self._active_consent(session, user.user_id)
        return MeResponse(
            user=user_summary(user, is_new=is_new),
            security=await self._security_for(session, user.user_id),
            consent=consent_state(active, self.settings.current_policy_version),
            settings=notification_settings(user),
            learners=await self._learners(session, user),
        )

    @staticmethod
    def _apply_notifications(user: User, patch: NotificationSettingsPatch, *, disabled: bool) -> bool:
        """Частичное обновление настроек уведомлений ученика → True, если что-то изменилось."""
        fields = patch.model_fields_set
        changed = False
        if "enabled" in fields and patch.enabled is not None:
            if patch.enabled and disabled:
                raise conflict("USER_DISABLED", "TilHero отключён — сначала включите его")
            if user.notifications_enabled != patch.enabled:
                user.notifications_enabled = patch.enabled
                changed = True
        if "quiet_hours" in fields:
            if patch.quiet_hours is None:
                start, end = None, None
            else:
                try:
                    start, end = parse_quiet_hours(patch.quiet_hours.start, patch.quiet_hours.end)
                except QuietHoursError as exc:
                    raise unprocessable(
                        "QUIET_HOURS_INVALID", "Тихие часы — время ЧЧ:ММ, начало и конец различаются",
                        {"field": f"quiet_hours.{exc.field}", "reason": exc.reason},
                    ) from None
            if (user.quiet_hours_start, user.quiet_hours_end) != (start, end):
                user.quiet_hours_start, user.quiet_hours_end = start, end
                changed = True
        if patch.timezone is not None and patch.timezone != user.timezone:
            user.timezone = patch.timezone
            changed = True
        if patch.categories is not None:
            current = normalize_categories(user.notify_categories)
            updated = apply_categories(current, patch.categories.model_dump(exclude_none=True))
            if updated != current:
                user.notify_categories = updated
                changed = True
        return changed

    def _new_consent(
        self, user: User, *, purposes: list[str], basis: str, granted_by: uuid.UUID | None, locale: str,
        now: datetime,
    ) -> Consent:
        current = self.settings.current_policy_version
        text_sha = get_policy(current).text_sha256(locale)  # type: ignore[arg-type]
        accepted_at = truncate_ms(now)
        return Consent(
            consent_id=uuid.uuid4(),
            user_id=user.user_id,
            policy_version=current,
            purposes=purposes,
            accepted_at=accepted_at,
            channel=CHANNEL,
            locale=locale,
            age_band=user.age_band,
            basis=basis,
            granted_by_user_id=granted_by,
            policy_text_sha256=text_sha,
            evidence_hash=evidence_hash(
                user_id=user.user_id, policy_version=current, purposes=purposes, accepted_at=accepted_at,
                channel=CHANNEL, locale=locale, policy_text_sha256=text_sha, age_band=user.age_band, basis=basis,
                granted_by=granted_by,
            ),
        )

    async def _consent_accepted(self, session: AsyncSession, consent: Consent) -> None:
        await self._emit(session, EV_CONSENT_ACCEPTED, {
            "user_id": str(consent.user_id), "consent_id": str(consent.consent_id),
            "policy_version": consent.policy_version, "purposes": list(consent.purposes),
            "age_band": consent.age_band,
        })

    # ---------- проверка секретов с общим счётчиком ----------
    async def _fail(self, user_id: uuid.UUID, failure: Failure, reserved: AttemptState) -> NoReturn:
        state = await self.attempts.failed(user_id, reserved)
        if state.locked:
            # Внешняя транзакция будет откатана исключением, а факт блокировки должен остаться: событие пишет _tx()
            # после её завершения (без второго соединения под блокировкой строки).
            self._locked_users.append(user_id)
            log.warning("pin attempts exhausted, locked")
            raise pin_locked(state.retry_after)
        raise ApiError(401, failure.code, failure.message, {"remaining": state.remaining})

    async def _check_pin(self, user_id: uuid.UUID, cred: PinCredential, pin: str) -> None:
        reserved = await self.attempts.reserve(user_id)  # попытка занята до проверки (атомарно)
        result = await _hasher.verify(cred.pin_hash, pin)
        if not result.ok:
            await self._fail(user_id, PIN_INVALID, reserved)
        await self.attempts.succeeded(user_id)
        if result.rehash:
            cred.pin_hash = result.rehash

    @staticmethod
    def _require_pin_format(pin: str) -> None:
        problem = pin_problem(pin)
        if problem:
            raise unprocessable("PIN_FORMAT", "Код родителя — 4 или 6 цифр, без простых комбинаций вроде 0000 и 1234",
                                {"reason": problem})

    # ---------- профиль ----------
    async def telegram_login(self, body: TelegramLoginRequest) -> LoginResponse:
        now = _now()
        username = _username(body.username)
        display_name = _display_name(body.first_name, body.last_name)
        async with self._tx() as session:
            by_tg = select(User).where(User.telegram_user_id == body.telegram_user_id).with_for_update()
            user = (await session.execute(by_tg)).scalar_one_or_none()
            is_new = False
            if user is None:
                locale = locale_from_language_code(body.language_code)
                created_id = (
                    await session.execute(
                        pg_insert(User)
                        .values(
                            user_id=uuid.uuid4(),
                            kind="account",
                            telegram_user_id=body.telegram_user_id,
                            username=username,
                            display_name=display_name,
                            locale=locale,
                            status="ACTIVE",
                            guardian_consent="not_required",
                            # уведомления включает согласие; категории — только support до явного включения
                            notifications_enabled=False,
                            notify_categories=list(DEFAULT_CATEGORIES),
                            quiet_hours_start=DEFAULT_QUIET_START,
                            quiet_hours_end=DEFAULT_QUIET_END,
                            timezone=self.settings.default_timezone,
                            created_at=now,
                            last_seen_at=now,
                            updated_at=now,
                        )
                        .on_conflict_do_nothing(index_elements=["telegram_user_id"])
                        .returning(User.user_id)
                    )
                ).scalar_one_or_none()
                if created_id is not None:
                    is_new = True
                    await self._emit(session, EV_PROFILE_CREATED, {
                        "user_id": str(created_id), "kind": "account", "locale": locale, "age_band": None,
                        "guardian_user_id": None, "created_at": iso_utc_ms(now),
                    })
                # Параллельный вход того же Telegram ID: INSERT дождался чужого коммита и ничего не вставил.
                user = (await session.execute(by_tg.execution_options(populate_existing=True))).scalar_one()
            if not is_new and user.status != "DELETION_REQUESTED":
                user.username = username
                user.display_name = display_name
            user.last_seen_at = now
            me = await self._me(session, user, is_new=is_new)
        if is_new:
            log.info("user profile created", extra={"user_pid": pseudonymize(str(user.user_id))})
        return LoginResponse(**me.model_dump())

    async def me(self, user_id: uuid.UUID) -> MeResponse:
        async with self._tx() as session:
            return await self._me(session, await self._load_account(session, user_id))

    async def patch_settings(self, user_id: uuid.UUID, patch: SettingsPatch) -> MeResponse:
        async with self._tx() as session:
            user = await self._load_account(session, user_id, lock=True)
            _ensure_mutable(user)
            if patch.locale is not None and patch.locale != user.locale:
                user.locale = patch.locale
                await self._profile_updated(session, user, ["locale"])
                # язык сообщений ребёнку = язык опекуна (адресат — родитель): дети следуют за аккаунтом
                for child in await self._children(session, user.user_id, lock=True):
                    child.locale = patch.locale
                    await self._profile_updated(session, child, ["locale"])
            if patch.notifications is not None and self._apply_notifications(
                user, patch.notifications, disabled=user.status == "DISABLED"
            ):
                await self._notify_changed(session, user, user)
            await session.flush()
            return await self._me(session, user)

    async def set_age(self, user_id: uuid.UUID, body: AgeRequest) -> MeResponse:
        """Возраст аккаунта выбирается один раз (дальше — через поддержку). 14-17 → guardian_consent=pending."""
        async with self._tx() as session:
            user = await self._load_account(session, user_id, lock=True)
            _ensure_mutable(user)
            if user.age_band is not None:
                if user.age_band == body.age_band:  # повтор того же выбора — без изменений
                    return await self._me(session, user)
                raise conflict("AGE_ALREADY_SET", "Возраст уже выбран — изменить его можно через поддержку",
                               {"age_band": user.age_band})
            user.age_band = body.age_band
            user.age_set_at = _now()
            changed = ["age_band"]
            consent = guardian_consent_for(body.age_band)
            if user.guardian_consent != consent:
                user.guardian_consent = consent
                changed.append("guardian_consent")
            await self._profile_updated(session, user, changed)
            await session.flush()
            return await self._me(session, user)

    async def set_status(self, user_id: uuid.UUID, target: str) -> MeResponse:
        async with self._tx() as session:
            user = await self._load_account(session, user_id, lock=True)
            _ensure_mutable(user)
            if user.status != target:
                previous = user.status
                user.status = target
                if target == "DISABLED":
                    user.notifications_enabled = False
                else:  # включение восстанавливает уведомления по действующему согласию
                    user.notifications_enabled = await self._active_consent(session, user_id) is not None
                await self._emit(session, EV_STATUS_CHANGED, {
                    "user_id": str(user_id), "status": target, "previous_status": previous,
                    "reason_code": "user_disabled" if target == "DISABLED" else "user_enabled",
                })
            await session.flush()
            return await self._me(session, user)

    # ---------- ученики: сам аккаунт и детские профили ----------
    async def list_learners(self, user_id: uuid.UUID) -> LearnerList:
        async with self._tx() as session:
            account = await self._load_account(session, user_id)
            return LearnerList(items=await self._learners(session, account))

    async def get_learner(self, user_id: uuid.UUID, learner_id: uuid.UUID) -> LearnerDetail:
        async with self._tx() as session:
            account = await self._load_account(session, user_id)
            learner, is_self = await self._find_learner(session, account, learner_id)
            return learner_detail(learner, is_self=is_self)

    async def create_child(
        self, user_id: uuid.UUID, body: CreateChildRequest, idempotency_key: str | None
    ) -> LearnerDetail:
        """Детский профиль 6–13 на аккаунте родителя 18+. Создание = согласие родителя на обработку данных ребёнка
        (галочка в Mini App): запись consents с основанием `guardian` и обязательными целями политики."""
        fp = fingerprint({"op": "create_child", **body.model_dump(mode="json")})
        async with self._tx() as session:
            account = await self._load_account(session, user_id, lock=True)  # сериализует лимит и ключ
            _ensure_mutable(account)
            if idempotency_key is not None:
                link = (await session.execute(
                    select(GuardianLink).where(GuardianLink.guardian_user_id == account.user_id,
                                               GuardianLink.idempotency_key == idempotency_key)
                )).scalar_one_or_none()
                if link is not None:
                    if link.request_fingerprint != fp:
                        raise unprocessable("IDEMPOTENCY_KEY_REUSED",
                                            "Ключ идемпотентности уже использован с другими данными")
                    replayed = await session.get(User, link.child_user_id)
                    if replayed is None:  # FK не даёт — защитно
                        raise _learner_not_found()
                    return learner_detail(replayed, is_self=False)
            if not is_adult(account.age_band):
                raise _adult_required(account.age_band)
            count = (await session.execute(
                select(func.count()).select_from(GuardianLink)
                .join(User, User.user_id == GuardianLink.child_user_id)
                .where(GuardianLink.guardian_user_id == account.user_id, User.status != "DELETED")
            )).scalar_one()
            if count >= self.settings.max_children:
                raise conflict("CHILDREN_LIMIT",
                               f"Можно создать не больше {self.settings.max_children} детских профилей",
                               {"limit": self.settings.max_children})
            now = _now()
            child = User(
                user_id=uuid.uuid4(), kind="child", telegram_user_id=None, username=None,
                display_name=body.display_name, locale=account.locale, status="ACTIVE", age_band=body.age_band,
                age_set_at=now, guardian_consent="granted", notifications_enabled=True,
                notify_categories=list(DEFAULT_CATEGORIES), quiet_hours_start=DEFAULT_QUIET_START,
                quiet_hours_end=DEFAULT_QUIET_END, timezone=account.timezone, bot_blocked=False,
                created_at=now, last_seen_at=now, updated_at=now,
            )
            session.add(child)
            await session.flush()
            session.add(GuardianLink(
                child_user_id=child.user_id, guardian_user_id=account.user_id, created_at=now,
                idempotency_key=idempotency_key, request_fingerprint=fp if idempotency_key is not None else None,
            ))
            policy = get_policy(self.settings.current_policy_version)
            consent = self._new_consent(
                child, purposes=[c for c in policy.purpose_codes if c in policy.required_purposes],
                basis="guardian", granted_by=account.user_id, locale=account.locale, now=now,
            )
            session.add(consent)
            await session.flush()
            await self._emit(session, EV_PROFILE_CREATED, {
                "user_id": str(child.user_id), "kind": "child", "locale": child.locale, "age_band": child.age_band,
                "guardian_user_id": str(account.user_id), "created_at": iso_utc_ms(now),
            })
            await self._consent_accepted(session, consent)
            log.info("child profile created", extra={"user_pid": pseudonymize(str(child.user_id))})
            return learner_detail(child, is_self=False)

    async def patch_learner(self, user_id: uuid.UUID, learner_id: uuid.UUID, body: LearnerPatch) -> LearnerDetail:
        """Только детский профиль: имя ребёнка и его настройки уведомлений (адресат — опекун)."""
        async with self._tx() as session:
            account = await self._load_account(session, user_id, lock=True)
            _ensure_mutable(account)
            child, is_self = await self._find_learner(session, account, learner_id, lock=True)
            if is_self:  # свой профиль меняется через PATCH /me/settings
                raise _learner_not_found()
            if body.display_name is not None and body.display_name != child.display_name:
                child.display_name = body.display_name
                await self._profile_updated(session, child, ["display_name"])
            if body.settings is not None and self._apply_notifications(
                child, body.settings, disabled="DISABLED" in (account.status, child.status)
            ):
                await self._notify_changed(session, child, account)
            await session.flush()
            return learner_detail(child, is_self=False)

    # ---------- согласие родителя для 14–17 ----------
    async def create_guardian_consent_request(
        self, user_id: uuid.UUID, idempotency_key: str | None
    ) -> GuardianConsentRequestOut:
        async with self._tx() as session:
            teen = await self._load_account(session, user_id, lock=True)
            _ensure_mutable(teen)
            if idempotency_key is not None:
                row = (await session.execute(
                    select(GuardianConsentRequest).where(GuardianConsentRequest.teen_user_id == teen.user_id,
                                                         GuardianConsentRequest.idempotency_key == idempotency_key)
                )).scalar_one_or_none()
                if row is not None:  # повтор команды — та же ссылка (токен выводится из id, не хранится)
                    return GuardianConsentRequestOut(token=derive_token(self._token_key, row.id),
                                                     expires_at=row.expires_at)
            if teen.age_band != TEEN or teen.guardian_consent == "granted":
                raise conflict("GUARDIAN_CONSENT_NOT_REQUIRED", "Согласие родителя не требуется",
                               {"age_band": teen.age_band, "guardian_consent": teen.guardian_consent})
            await session.execute(
                update(GuardianConsentRequest)
                .where(GuardianConsentRequest.teen_user_id == teen.user_id, GuardianConsentRequest.status == "pending")
                .values(status="revoked")
                .execution_options(synchronize_session=False)
            )
            now = _now()
            request_id = uuid.uuid4()
            token = derive_token(self._token_key, request_id)
            row = GuardianConsentRequest(
                id=request_id, teen_user_id=teen.user_id, token_hash=token_hash(token), status="pending",
                idempotency_key=idempotency_key, created_at=now,
                expires_at=now + timedelta(seconds=self.settings.guardian_consent_ttl_seconds),
            )
            session.add(row)
            if teen.guardian_consent != "pending":  # после отказа подросток может попросить снова
                teen.guardian_consent = "pending"
                await self._profile_updated(session, teen, ["guardian_consent"])
            await session.flush()
            return GuardianConsentRequestOut(token=token, expires_at=row.expires_at)

    async def guardian_consent_preview(self, token: str) -> GuardianConsentPreview:
        if not well_formed(token):
            raise _guardian_consent_not_found()
        async with self._tx() as session:
            row = (await session.execute(
                select(GuardianConsentRequest).where(GuardianConsentRequest.token_hash == token_hash(token))
            )).scalar_one_or_none()
            teen = None if row is None else await session.get(User, row.teen_user_id)
            if row is None or teen is None or teen.status == "DELETED":
                raise _guardian_consent_not_found()
            return GuardianConsentPreview(teen_display_name=teen.display_name or "",
                                          status=_preview_status(row, _now()),  # type: ignore[arg-type]
                                          expires_at=row.expires_at)

    async def decide_guardian_consent(self, token: str, guardian_id: uuid.UUID, accept: bool) -> GuardianConsentPreview:
        """Родитель (взрослый аккаунт, не сам подросток) принимает или отклоняет согласие. Повтор решения — 200 без
        изменений; решение по уже решённой ссылке не меняется (новая ссылка — новый запрос подростка)."""
        if not well_formed(token):
            raise _guardian_consent_not_found()
        digest = token_hash(token)
        async with self._tx() as session:
            teen_id = (await session.execute(
                select(GuardianConsentRequest.teen_user_id).where(GuardianConsentRequest.token_hash == digest)
            )).scalar_one_or_none()
            if teen_id is None:
                raise _guardian_consent_not_found()
            # порядок блокировок как у подростка (аккаунт → ссылки): без взаимной блокировки с новой ссылкой
            teen = (await session.execute(select(User).where(User.user_id == teen_id).with_for_update())).scalar_one()
            row = (await session.execute(
                select(GuardianConsentRequest).where(GuardianConsentRequest.token_hash == digest).with_for_update()
            )).scalar_one()
            if teen.status == "DELETED":
                raise _guardian_consent_not_found()
            if guardian_id == teen.user_id:
                raise conflict("GUARDIAN_CONSENT_SELF",
                               "Подтвердить согласие за себя нельзя — отправьте ссылку родителю")
            guardian = await self._load_account(session, guardian_id)
            if not is_adult(guardian.age_band):
                raise _adult_required(guardian.age_band)
            _ensure_mutable(guardian)
            now = _now()
            if row.status in ("granted", "declined"):
                return GuardianConsentPreview(teen_display_name=teen.display_name or "",
                                              status=row.status,  # type: ignore[arg-type]
                                              expires_at=row.expires_at)
            if (row.status != "pending" or row.expires_at <= now or teen.status not in LIVE_STATUSES
                    or teen.age_band != TEEN):
                raise ApiError(410, "GUARDIAN_CONSENT_EXPIRED", "Ссылка устарела — попросите отправить новую")
            row.status = "granted" if accept else "declined"
            row.guardian_user_id = guardian.user_id
            row.decided_at = now
            teen.guardian_consent = row.status
            await self._profile_updated(session, teen, ["guardian_consent"])
            await session.flush()
            log.info("guardian consent decided", extra={"user_pid": pseudonymize(str(teen.user_id)),
                                                        "decision": row.status})
            return GuardianConsentPreview(teen_display_name=teen.display_name or "",
                                          status=row.status,  # type: ignore[arg-type]
                                          expires_at=row.expires_at)

    # ---------- PIN (код родителя) ----------
    async def set_pin(self, user_id: uuid.UUID, body: PinSetRequest) -> SecurityState:
        self._require_pin_format(body.pin)
        async with self._tx() as session:
            user = await self._load_account(session, user_id, lock=True)
            _ensure_mutable(user)
            cred = await session.get(PinCredential, user_id)
            bio = await session.get(BiometricCredential, user_id)
            if cred is None:
                cred = PinCredential(
                    user_id=user_id, pin_hash=await _hasher.hash(body.pin), pin_length=len(body.pin)
                )
                session.add(cred)
                change = "pin_set"
            else:
                # Смена — только с текущим кодом (повторная установка без него не перезаписывает).
                if body.current_pin is None:
                    raise conflict("PIN_ALREADY_SET", "Код уже задан — для смены укажите текущий код")
                await self._check_pin(user_id, cred, body.current_pin)
                cred.pin_hash = await _hasher.hash(body.pin)
                cred.pin_length = len(body.pin)
                cred.updated_at = _now()
                change = "pin_changed"
            await self._emit_security(session, user_id, change)
            return await self._security(user_id, cred, bio)

    async def remove_pin(self, user_id: uuid.UUID, current_pin: str) -> SecurityState:
        async with self._tx() as session:
            user = await self._load_account(session, user_id, lock=True)
            _ensure_mutable(user)
            cred = await session.get(PinCredential, user_id)
            if cred is None:
                raise conflict("PIN_NOT_SET", "Код не задан")
            await self._check_pin(user_id, cred, current_pin)
            bio = await session.get(BiometricCredential, user_id)
            await session.delete(cred)
            await self._emit_security(session, user_id, "pin_removed")
            if bio is not None:  # биометрия — надстройка над кодом и без него не существует
                await session.delete(bio)
                await self._emit_security(session, user_id, "biometric_disabled")
            return await self._security(user_id, None, None)

    async def verify_pin(self, user_id: uuid.UUID, pin: str) -> None:
        async with self._tx() as session:
            # FOR UPDATE: проверки одного пользователя идут по очереди, параллельные запросы не обходят лимит.
            await self._load_account(session, user_id, lock=True)
            cred = await session.get(PinCredential, user_id)
            if cred is None:
                raise conflict("PIN_NOT_SET", "Код не задан")
            await self._check_pin(user_id, cred, pin)

    async def request_pin_reset(self, user_id: uuid.UUID) -> int:
        """Код сброса: Redis хранит только HMAC; сам код уходит синхронно в notifications (в событиях и outbox
        его нет). notifications недоступен → 503 UPSTREAM_UNAVAILABLE, лимит частоты не расходуется."""
        async with self._tx() as session:
            user = await self._load_account(session, user_id, lock=True)
            _ensure_mutable(user)
            if await session.get(PinCredential, user_id) is None:
                raise conflict("PIN_NOT_SET", "Код не задан — сбрасывать нечего")
            if user.bot_blocked:
                raise _bot_blocked()
        store = self.reset_codes
        await store.throttle(user_id)  # резерв: параллельный запрос получит 429
        try:
            code = await store.issue(user_id)
            outcome = await self._send_reset_code(user_id, code)
        except BaseException:
            await self._release_reset(store, user_id)
            raise
        if outcome == "blocked":
            await self._release_reset(store, user_id)
            raise _bot_blocked()
        if outcome != "ok":
            await self._release_reset(store, user_id)
            raise unavailable("UPSTREAM_UNAVAILABLE", "Не удалось отправить код. Попробуйте позже")
        return self.settings.pin_reset_code_ttl_seconds

    async def _send_reset_code(self, user_id: uuid.UUID, code: str) -> str:
        """→ ok | blocked | failed. ok — отправлено или поставлено в очередь с повтором."""
        notification_id = uuid.uuid4()
        try:
            result = await self.rt.client("notifications").post(
                "/internal/v1/notifications/transactional",
                json={
                    "notification_id": str(notification_id),
                    "user_id": str(user_id),
                    "template": RESET_TEMPLATE,
                    "params": {"code": code, "ttl_minutes": max(1, self.settings.pin_reset_code_ttl_seconds // 60)},
                    "dedup_key": f"pin_reset:{user_id}:{notification_id.hex}",
                },
                idempotency_key=str(notification_id),
            )
        except UpstreamError as exc:
            log.warning("pin reset code delivery unavailable", extra={"status": exc.status, "error_code": exc.code})
            return "failed"
        status = (result or {}).get("status")
        if status in ("sent", "queued"):
            return "ok"
        reason = (result or {}).get("reason")
        log.warning("pin reset code not delivered", extra={"delivery_status": str(status), "reason": str(reason)})
        return "blocked" if reason == "blocked" else "failed"

    async def _release_reset(self, store: ResetCodeStore, user_id: uuid.UUID) -> None:
        try:
            await store.discard(user_id)
            await store.release(user_id)
        except Exception:  # ключи истекут по TTL; ответ клиенту важнее
            log.warning("pin reset reservation release failed", exc_info=True)

    async def confirm_pin_reset(self, user_id: uuid.UUID, code: str, new_pin: str) -> SecurityState:
        self._require_pin_format(new_pin)  # до погашения попытки: ошибка формата не тратит код
        async with self._tx() as session:
            user = await self._load_account(session, user_id, lock=True)
            _ensure_mutable(user)
            cred = await session.get(PinCredential, user_id)
            if cred is None:
                raise conflict("PIN_NOT_SET", "Код не задан — сбрасывать нечего")
            result = await self.reset_codes.consume(user_id, code)
            if result.expired:
                raise ApiError(410, "RESET_CODE_EXPIRED", "Код истёк или уже использован — запросите новый")
            if not result.ok:
                raise ApiError(401, "RESET_CODE_INVALID", "Неверный код", {"remaining": result.remaining})
            cred.pin_hash = await _hasher.hash(new_pin)
            cred.pin_length = len(new_pin)
            cred.updated_at = _now()
            bio = await session.get(BiometricCredential, user_id)
            await self._emit_security(session, user_id, "pin_reset")
            if bio is not None:  # учётные данные переустанавливаются целиком: биометрию нужно включить заново
                await session.delete(bio)
                await self._emit_security(session, user_id, "biometric_disabled")
            await self.attempts.succeeded(user_id)  # успешный сброс снимает блокировку и обнуляет счётчик
            return await self._security(user_id, cred, None)

    # ---------- биометрия ----------
    async def enable_biometric(self, user_id: uuid.UUID) -> BiometricEnableResponse:
        async with self._tx() as session:
            user = await self._load_account(session, user_id, lock=True)
            _ensure_mutable(user)
            pin = await session.get(PinCredential, user_id)
            if pin is None:
                raise conflict("PIN_REQUIRED", "Сначала задайте код родителя — биометрия работает поверх него")
            token = new_biometric_token()
            bio = await session.get(BiometricCredential, user_id)
            if bio is None:
                bio = BiometricCredential(user_id=user_id, token_hash=token_digest(token), created_at=_now())
                session.add(bio)
            else:  # повторное включение выпускает новый токен, старый перестаёт действовать
                bio.token_hash = token_digest(token)
                bio.created_at = _now()
            await self._emit_security(session, user_id, "biometric_enabled")
            security = await self._security(user_id, pin, bio)
        return BiometricEnableResponse(biometric_token=token, security=security)

    async def disable_biometric(self, user_id: uuid.UUID) -> SecurityState:
        async with self._tx() as session:
            user = await self._load_account(session, user_id, lock=True)
            _ensure_mutable(user)
            bio = await session.get(BiometricCredential, user_id)
            if bio is not None:
                await session.delete(bio)
                await self._emit_security(session, user_id, "biometric_disabled")
            return await self._security(user_id, await session.get(PinCredential, user_id), None)

    async def verify_biometric(self, user_id: uuid.UUID, token: str) -> None:
        async with self._tx() as session:
            await self._load_account(session, user_id, lock=True)
            bio = await session.get(BiometricCredential, user_id)
            if bio is None:
                raise conflict("BIOMETRIC_NOT_ENABLED", "Биометрия не включена")
            reserved = await self.attempts.reserve(user_id)
            if not token_matches(token, bio.token_hash):
                await self._fail(user_id, BIOMETRIC_INVALID, reserved)
            await self.attempts.succeeded(user_id)

    # ---------- согласие ----------
    async def accept_consent(self, user_id: uuid.UUID, body: ConsentRequest) -> ConsentState:
        current = self.settings.current_policy_version
        if body.policy_version != current:
            raise conflict("POLICY_VERSION_OUTDATED", "Политика обновилась — ознакомьтесь с новой версией",
                           {"current_policy_version": current})
        policy = get_policy(current)
        purposes, unknown, missing = normalize_purposes(policy, body.purposes)
        if unknown:
            raise unprocessable("CONSENT_PURPOSES_INVALID", "Неизвестные цели согласия", {"unknown": unknown})
        if missing:
            raise unprocessable("CONSENT_REQUIRED_PURPOSES", "Без обязательных согласий TilHero не работает",
                                {"missing": missing})
        optional = [p for p in purposes if p in policy.optional_purposes]
        async with self._tx() as session:
            user = await self._load_account(session, user_id, lock=True)
            _ensure_mutable(user)
            if optional and not optional_purposes_allowed(user.age_band, user.guardian_consent):
                # 14–17 без согласия родителя (и возраст не выбран): необязательные функции выключены (AT-03)
                raise forbidden("GUARDIAN_CONSENT_REQUIRED",
                                "Для необязательных функций нужно согласие родителя",
                                {"age_band": user.age_band, "guardian_consent": user.guardian_consent,
                                 "purposes": optional})
            active = await self._active_consent(session, user_id, lock=True)
            if active is not None and active.policy_version == current and list(active.purposes) == purposes:
                return consent_state(active, current)  # повтор того же согласия — без новой записи
            now = _now()
            if active is not None:
                active.revoked_at = truncate_ms(now)
                active.revoke_reason = "superseded"
                await session.flush()  # освобождаем уникальный индекс действующего согласия
            consent = self._new_consent(user, purposes=purposes, basis="self", granted_by=None, locale=user.locale,
                                        now=now)
            session.add(consent)
            await self._consent_accepted(session, consent)
            # первое согласие (или после отзыва) включает уведомления; категории — только явным выбором
            if active is None and user.status == "ACTIVE" and not user.notifications_enabled:
                user.notifications_enabled = True
                await self._notify_changed(session, user, user)
            return consent_state(consent, current)

    async def revoke_consent(self, user_id: uuid.UUID) -> ConsentState:
        current = self.settings.current_policy_version
        async with self._tx() as session:
            user = await self._load_account(session, user_id, lock=True)
            _ensure_mutable(user)
            active = await self._active_consent(session, user_id, lock=True)
            if active is not None:
                active.revoked_at = truncate_ms(_now())
                active.revoke_reason = "user"
                user.notifications_enabled = False
                await self._emit(session, EV_CONSENT_REVOKED, {
                    "user_id": str(user_id), "consent_id": str(active.consent_id),
                    "policy_version": active.policy_version,
                })
            return consent_state(None, current)

    # ---------- удаление ----------
    def _deletion_response(self, req: DeletionRequest, learners: int) -> DeletionResponse:
        return DeletionResponse(request_id=req.request_id, status="REQUESTED",
                                domains=[*req.expected_domains, DOMAIN], learners=learners)

    async def request_deletion(self, user_id: uuid.UUID, body: DeletionRequestIn) -> DeletionResponse:
        """Удаление аккаунта и каждого его детского профиля: отдельный request_id на ученика (запрос ребёнка
        ссылается на запрос аккаунта), каждый проходит сагу независимо (AT-14)."""
        async with self._tx() as session:
            user = await self._load_account(session, user_id, lock=True)
            if user.status == "DELETION_REQUESTED":  # повтор: тот же запрос, без новых событий
                req = (await session.execute(
                    select(DeletionRequest).where(DeletionRequest.user_id == user_id,
                                                  DeletionRequest.status.in_(deletion_saga.OPEN_STATUSES))
                )).scalar_one()
                child_requests = (await session.execute(
                    select(func.count()).select_from(DeletionRequest)
                    .where(DeletionRequest.parent_request_id == req.request_id)
                )).scalar_one()
                return self._deletion_response(req, 1 + int(child_requests))
            cred = await session.get(PinCredential, user_id)
            if cred is not None:
                if not body.pin:
                    raise unprocessable("DELETION_CONFIRMATION_REQUIRED", "Подтвердите удаление кодом родителя",
                                        {"method": "pin"})
                await self._check_pin(user_id, cred, body.pin)
            elif _deletion_word(body.confirm_word) not in DELETION_WORDS:
                raise unprocessable("DELETION_CONFIRMATION_REQUIRED",
                                    "Введите слово УДАЛИТЬ, чтобы подтвердить", {"method": "confirm_word"})
            now = _now()
            children = await self._children(session, user_id, lock=True)
            account_req = await self._start_deletion(session, user, now)
            requests = [account_req]
            for child in children:
                requests.append(await self._start_deletion(session, child, now, parent=account_req))
            # ссылки согласия родителя подростка больше не действуют
            await session.execute(
                update(GuardianConsentRequest)
                .where(GuardianConsentRequest.teen_user_id == user_id, GuardianConsentRequest.status == "pending")
                .values(status="revoked")
                .execution_options(synchronize_session=False)
            )
            response = self._deletion_response(account_req, len(requests))
            if not account_req.expected_domains:  # нечего ждать — обезличиваем сразу
                for req in requests:
                    await self._anonymize(session, req)
        log.info("deletion requested", extra={"learners": response.learners})
        return response

    async def _start_deletion(
        self, session: AsyncSession, user: User, now: datetime, *, parent: DeletionRequest | None = None
    ) -> DeletionRequest:
        req = DeletionRequest(
            request_id=uuid.uuid4(), user_id=user.user_id, status="REQUESTED", requested_at=now,
            expected_domains=list(dict.fromkeys(self.settings.deletion_domains)), acked_domains=[],
            attempts=1, last_sent_at=now,
            next_retry_at=deletion_saga.next_retry_at(now, now, self.settings.deletion_retry_schedule),
            parent_request_id=parent.request_id if parent is not None else None,
        )
        session.add(req)
        previous = user.status
        user.status = "DELETION_REQUESTED"
        user.notifications_enabled = False
        await session.flush()
        requested = await self._emit(session, EV_DELETION_REQUESTED, deletion_store.requested_payload(req, attempt=1))
        # attempt 1 и расписание повторов неответившим доменам (deletion/sweeper.py)
        deletion_store.record_initial(session, req, sent_at=now, event_id=requested.event_id,
                                      schedule=self.settings.deletion_retry_schedule)
        await self._emit(session, EV_STATUS_CHANGED, {
            "user_id": str(user.user_id), "status": "DELETION_REQUESTED", "previous_status": previous,
            "reason_code": "deletion_requested" if parent is None else "guardian_deletion_requested",
        })
        return req

    async def on_domain_deleted(self, session: AsyncSession, env: Envelope) -> None:
        """ACK домена (user.domain.deleted.v1). Когда подтвердили все — обезличиваем ученика."""
        payload = env.payload
        domain = payload.get("domain")
        if domain == DOMAIN:
            return  # собственное событие
        if env.producer != domain:
            # ACK за домен присылает только сам домен (иначе один сервис мог бы «подтвердить» удаление за другой)
            log.warning("deletion ack ignored: producer mismatch", extra={"domain": str(domain)[:64]})
            return
        try:
            request_id = uuid.UUID(str(payload["request_id"]))
            user_id = uuid.UUID(str(payload["user_id"]))
        except (KeyError, ValueError):
            log.warning("deletion ack ignored: malformed payload", extra={"event_id": env.event_id})
            return
        req = (await session.execute(
            select(DeletionRequest).where(DeletionRequest.request_id == request_id).with_for_update()
        )).scalar_one_or_none()
        if req is None or req.user_id != user_id:
            log.warning("deletion ack ignored: unknown request", extra={"event_id": env.event_id})
            return
        if req.status == deletion_saga.COMPLETED:
            return  # поздний или повторный ACK (повтор запроса уходит всем доменам) — без побочных эффектов
        if domain not in req.expected_domains:
            log.warning("deletion ack ignored: unexpected domain", extra={"domain": str(domain)[:64]})
            return
        # ACK по доменам со временем; повторный ACK того же домена ничего не меняет. STUCK тоже принимает ACK
        await deletion_store.record_ack(session, req, domain=domain, mode=payload.get("mode"),
                                        event_id=env.event_id, at=_now())
        if deletion_saga.all_acked(req.expected_domains, req.acked_domains):
            await self._anonymize(session, req)

    async def _anonymize(self, session: AsyncSession, req: DeletionRequest) -> None:
        now = _now()
        user = (await session.execute(
            select(User).where(User.user_id == req.user_id).with_for_update()
        )).scalar_one()
        previous = user.status
        user.telegram_user_id = None
        user.username = None
        user.display_name = None
        user.status = "DELETED"
        user.age_band = None
        user.guardian_consent = "not_required"
        user.notifications_enabled = False
        user.notify_categories = list(DEFAULT_CATEGORIES)
        user.quiet_hours_start = user.quiet_hours_end = None
        user.timezone = self.settings.default_timezone
        user.bot_blocked = False
        await session.execute(delete(PinCredential).where(PinCredential.user_id == req.user_id))
        await session.execute(delete(BiometricCredential).where(BiometricCredential.user_id == req.user_id))
        # связь ребёнка с опекуном — персональные данные отношения; у ребёнка она снимается при его обезличивании
        await session.execute(delete(GuardianLink).where(GuardianLink.child_user_id == req.user_id))
        await session.execute(
            update(GuardianConsentRequest)
            .where(GuardianConsentRequest.teen_user_id == req.user_id, GuardianConsentRequest.status == "pending")
            .values(status="revoked")
            .execution_options(synchronize_session=False)
        )
        # Согласия остаются доказательством (в них нет PII: user_id — псевдоним, без Telegram ID и имени).
        await session.execute(
            update(Consent)
            .where(Consent.user_id == req.user_id, Consent.revoked_at.is_(None))
            .values(revoked_at=truncate_ms(now), revoke_reason="deletion")
        )
        deletion_store.mark_completed(req, now=now)
        await self._emit(session, EV_DOMAIN_DELETED, {
            "user_id": str(req.user_id), "request_id": str(req.request_id),
            "domain": DOMAIN, "mode": "anonymized",
        })
        await self._emit(session, EV_STATUS_CHANGED, {
            "user_id": str(req.user_id), "status": "DELETED", "previous_status": previous,
            "reason_code": "deletion_completed",
        })
        if self.rt.redis is not None and user.kind == "account":
            try:
                await self.attempts.succeeded(req.user_id)
                await self.reset_codes.clear(req.user_id)
            except Exception:  # ключи всё равно истекут по TTL
                log.warning("redis cleanup after anonymization failed", exc_info=True)
        log.info("user anonymized after deletion acks", extra={"request_id": str(req.request_id)})

    # ---------- служебные ----------
    async def delivery(self, user_id: uuid.UUID) -> DeliveryInfo:
        """Адресация notifications. Ребёнок → адресат опекун (его Telegram ID, блокировка бота, язык)."""
        async with self._tx() as session:
            learner = await session.get(User, user_id)
            if learner is None or learner.status == "DELETED":
                raise _user_not_found()
            recipient = await self._guardian_of(session, learner) if learner.kind == "child" else learner
            if recipient is None or recipient.status == "DELETED" or recipient.telegram_user_id is None:
                raise _user_not_found()
            return DeliveryInfo(
                user_id=learner.user_id,
                kind=learner.kind,  # type: ignore[arg-type]
                recipient_telegram_user_id=recipient.telegram_user_id,
                recipient_is_guardian=recipient is not learner,
                learner_display_name=learner.display_name or "",
                locale=recipient.locale,  # type: ignore[arg-type]
                age_band=learner.age_band,  # type: ignore[arg-type]
                is_minor=is_minor(learner.age_band),
                notifications_enabled=effective_delivery(learner, recipient),
                categories=normalize_categories(learner.notify_categories),
                quiet_hours=quiet_hours(learner),
                timezone=learner.timezone,
                status=learner.status,  # type: ignore[arg-type]
            )

    async def public_profile(self, user_id: uuid.UUID) -> PublicProfile:
        async with self._tx() as session:
            user = await session.get(User, user_id)
            if user is None or user.status == "DELETED":
                raise _user_not_found()
            return PublicProfile(
                user_id=user.user_id,
                display_name=user.display_name or "",
                kind=user.kind,  # type: ignore[arg-type]
                age_band=user.age_band,  # type: ignore[arg-type]
                guardian_consent=user.guardian_consent,  # type: ignore[arg-type]
                status=user.status,  # type: ignore[arg-type]
            )

    async def set_bot_status(self, telegram_user_id: int, blocked: bool) -> None:
        """Блокировка бота не меняет настройки: пока бот заблокирован, доставка в Telegram выключена для аккаунта и
        его детей (DeliveryInfo.notifications_enabled=false, центр уведомлений работает); разблокировка
        возвращает доставку по настройкам."""
        async with self._tx() as session:
            user = (await session.execute(
                select(User).where(User.telegram_user_id == telegram_user_id).with_for_update()
            )).scalar_one_or_none()
            if user is None:
                raise _user_not_found()
            if user.bot_blocked == blocked:
                return
            user.bot_blocked = blocked
            await self._notify_changed(session, user, user)
            for child in await self._children(session, user.user_id):
                await self._notify_changed(session, child, user)
