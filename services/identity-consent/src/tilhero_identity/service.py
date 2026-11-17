"""Сценарии identity-consent. Каждая изменяющая команда — одна транзакция с блокировкой строки пользователя
(SELECT … FOR UPDATE сериализует параллельные команды одного пользователя) и событиями через outbox.

Секреты (PIN, код сброса, биометрический токен) не попадают ни в логи, ни в ответы, ни в события, ни в outbox:
код сброса уходит синхронным вызовом notifications /internal/v1/notifications/transactional (ревью P2).
"""

from __future__ import annotations

import base64
import json
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, time, timedelta
from typing import Any, NoReturn

from sqlalchemy import delete, func, select, tuple_, update
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.context import get_correlation_id, pseudonymize
from tilhero_common.errors import ApiError, bad_request, conflict, not_found, too_many, unavailable, unprocessable
from tilhero_common.http_client import UpstreamError
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import Envelope, emit
from tilhero_common.redis_tools import AttemptState, rate_limit
from tilhero_identity.deletion import saga as deletion_saga
from tilhero_identity.deletion import store as deletion_store
from tilhero_identity.domain.attempts import BIOMETRIC_INVALID, PIN_INVALID, Failure, PinAttempts, pin_locked
from tilhero_identity.domain.evidence import evidence_hash, iso_utc_ms, truncate_ms
from tilhero_identity.domain.locale import locale_from_language_code
from tilhero_identity.domain.pin import (
    PinHasher,
    new_biometric_token,
    pin_problem,
    token_digest,
    token_matches,
)
from tilhero_identity.domain.policy import get_policy, normalize_purposes
from tilhero_identity.domain.reset_codes import ResetCodeStore
from tilhero_identity.models import BiometricCredential, Consent, DeletionRequest, PinCredential, User
from tilhero_identity.schemas import (
    AdminConsent,
    AdminIdentityUser,
    AdminIdentityUserPage,
    AdminSecurity,
    BiometricEnableResponse,
    ConsentRequest,
    ConsentState,
    DeletionRequestIn,
    DeletionResponse,
    DeliveryInfo,
    LoginResponse,
    MeResponse,
    NotificationSettings,
    PinSetRequest,
    QuietHours,
    RevealResult,
    SecurityState,
    SettingsPatch,
    TelegramLoginRequest,
    UserSummary,
)
from tilhero_identity.settings import Settings

log = logging.getLogger("tilhero.identity")

DOMAIN = "identity-consent"
CHANNEL = "telegram"
DELETION_WORDS = frozenset({"УДАЛИТЬ", "DELETE"})

EV_PROFILE_CREATED = "user.profile.created.v1"
EV_SECURITY_CHANGED = "user.security.changed.v1"
EV_STATUS_CHANGED = "user.status.changed.v1"
EV_CONSENT_ACCEPTED = "consent.accepted.v1"
EV_CONSENT_REVOKED = "consent.revoked.v1"
EV_DELETION_REQUESTED = "user.deletion.requested.v1"
EV_DOMAIN_DELETED = "user.domain.deleted.v1"
RESET_TEMPLATE = "pin.reset_code"
AUDIT_SENSITIVE_VIEW = "sensitive.view"
AUDIT_SENSITIVE_VIEW_LIMITED = "sensitive.view_rate_limited"
MASK = "\u2022"  # •

_hasher = PinHasher()


def _now() -> datetime:
    return datetime.now(UTC)


def _hhmm(value: time | None) -> str | None:
    return value.strftime("%H:%M") if value is not None else None


def _parse_hhmm(value: str) -> time:
    hours, minutes = value.split(":")
    return time(int(hours), int(minutes))


def _user_not_found() -> ApiError:
    return not_found("USER_NOT_FOUND", "Пользователь не найден")


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


def mask_telegram_id(telegram_user_id: int | None) -> str:
    """Маска для админки: «••••••789». Полный Telegram ID — только reveal с аудитом."""
    if telegram_user_id is None:
        return MASK * 9
    return MASK * 6 + str(telegram_user_id)[-3:]


def _encode_cursor(updated_at: datetime, user_id: uuid.UUID) -> str:
    raw = json.dumps({"t": updated_at.astimezone(UTC).isoformat(), "u": str(user_id)}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        if len(cursor) > 256:
            raise ValueError("too long")
        data = json.loads(base64.urlsafe_b64decode((cursor + "=" * (-len(cursor) % 4)).encode()).decode())
        when = datetime.fromisoformat(str(data["t"]))
        if when.tzinfo is None:
            raise ValueError("naive")
        return when, uuid.UUID(str(data["u"]))
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


# ---------- представления ----------

def user_summary(user: User, *, is_new: bool = False) -> UserSummary:
    return UserSummary(
        user_id=user.user_id,
        display_name=user.display_name or "",
        username=user.username,
        locale=user.locale,  # type: ignore[arg-type]
        status=user.status,  # type: ignore[arg-type]
        is_new=is_new,
    )


def notification_settings(user: User) -> NotificationSettings:
    quiet = None
    if user.quiet_hours_start is not None and user.quiet_hours_end is not None:
        quiet = QuietHours(start=user.quiet_hours_start.strftime("%H:%M"), end=user.quiet_hours_end.strftime("%H:%M"))
    return NotificationSettings(
        enabled=user.notifications_enabled,
        quiet_hours=quiet,
        digest_time=_hhmm(user.digest_time) or "09:00",
        timezone=user.timezone,
    )


def consent_state(user: User, active: Consent | None, current_version: str) -> ConsentState:
    return ConsentState(
        accepted=active is not None,
        policy_version=active.policy_version if active else None,
        current_policy_version=current_version,
        accepted_at=active.accepted_at if active else None,
        evidence_hash=active.evidence_hash if active else None,
        age_confirmed_18_plus=user.age_confirmed_18_plus,
    )


class IdentityService:
    def __init__(self, runtime: Runtime) -> None:
        self.rt = runtime
        self.settings: Settings = runtime.settings  # type: ignore[assignment]
        self._locked_users: list[uuid.UUID] = []  # pin_locked — опубликовать после отката основной транзакции

    @asynccontextmanager
    async def _tx(self) -> AsyncIterator[AsyncSession]:
        """Транзакция команды. Факт блокировки PIN фиксируется отдельной транзакцией ПОСЛЕ завершения основной
        (она откатывается исключением 423): раньше событие писалось во втором соединении, пока первое держало
        FOR UPDATE строки пользователя, — при массовых блокировках пул исчерпывался (ревью #13)."""
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

    async def _emit(self, session: AsyncSession, event_type: str, payload: dict[str, Any]) -> Envelope:
        user_id = payload.get("user_id")
        if user_id:
            # Любое изменение пользователя (в т.ч. PIN, биометрия, согласие — другие таблицы) двигает users.updated_at:
            # по нему user-admin курсорно сверяет read-модель (GET /admin/v1/users?updated_after=).
            await session.execute(
                update(User)
                .where(User.user_id == uuid.UUID(str(user_id)))
                .values(updated_at=func.now())
                .execution_options(synchronize_session=False)
            )
        return await emit(session, event_type, payload, producer=self.settings.service_name)

    async def _emit_security(self, session: AsyncSession, user_id: uuid.UUID, change: str) -> None:
        await self._emit(session, EV_SECURITY_CHANGED, {"user_id": str(user_id), "change": change})

    async def _load_user(self, session: AsyncSession, user_id: uuid.UUID, *, lock: bool = False) -> User:
        stmt = select(User).where(User.user_id == user_id)
        if lock:
            stmt = stmt.with_for_update()
        user = (await session.execute(stmt)).scalar_one_or_none()
        if user is None or user.status == "DELETED":
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
            # Домен сообщает «для новой сессии нужен PIN»; BFF уточняет по состоянию конкретной сессии.
            pin_required=pin is not None,
            locked_until=locked_until,
        )

    async def _security_for(self, session: AsyncSession, user_id: uuid.UUID) -> SecurityState:
        pin = await session.get(PinCredential, user_id)
        bio = await session.get(BiometricCredential, user_id)
        return await self._security(user_id, pin, bio)

    async def _me(self, session: AsyncSession, user: User, *, is_new: bool = False) -> MeResponse:
        active = await self._active_consent(session, user.user_id)
        return MeResponse(
            user=user_summary(user, is_new=is_new),
            security=await self._security_for(session, user.user_id),
            consent=consent_state(user, active, self.settings.current_policy_version),
            settings=notification_settings(user),
        )

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
        reserved = await self.attempts.reserve(user_id)  # спринт 9: попытка занята до проверки (атомарно)
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
            raise unprocessable("PIN_FORMAT", "PIN — 4 или 6 цифр, без простых комбинаций вроде 0000 и 1234",
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
                            telegram_user_id=body.telegram_user_id,
                            username=username,
                            display_name=display_name,
                            locale=locale,
                            status="ACTIVE",
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
                        "user_id": str(created_id), "locale": locale, "created_at": iso_utc_ms(now),
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
            return await self._me(session, await self._load_user(session, user_id))

    async def patch_settings(self, user_id: uuid.UUID, patch: SettingsPatch) -> MeResponse:
        async with self._tx() as session:
            user = await self._load_user(session, user_id, lock=True)
            _ensure_mutable(user)
            if patch.locale is not None:
                user.locale = patch.locale
            n = patch.notifications
            if n is not None:
                fields = n.model_fields_set
                if "enabled" in fields and n.enabled is not None:
                    if n.enabled and user.status == "DISABLED":
                        raise conflict("USER_DISABLED", "TilHero отключён — сначала включите его")
                    user.notifications_enabled = n.enabled
                if "quiet_hours" in fields:
                    if n.quiet_hours is None:
                        user.quiet_hours_start = user.quiet_hours_end = None
                    else:
                        user.quiet_hours_start = _parse_hhmm(n.quiet_hours.start)
                        user.quiet_hours_end = _parse_hhmm(n.quiet_hours.end)
                if n.digest_time is not None:
                    user.digest_time = _parse_hhmm(n.digest_time)
                if n.timezone is not None:
                    user.timezone = n.timezone
            await session.flush()
            return await self._me(session, user)

    async def set_status(self, user_id: uuid.UUID, target: str) -> MeResponse:
        async with self._tx() as session:
            user = await self._load_user(session, user_id, lock=True)
            _ensure_mutable(user)
            if user.status != target:
                previous = user.status
                user.status = target
                if target == "DISABLED":
                    user.notifications_enabled = False
                else:
                    active = await self._active_consent(session, user_id)
                    user.notifications_enabled = bool(
                        active is not None and "notifications" in active.purposes and not user.bot_blocked
                    )
                await self._emit(session, EV_STATUS_CHANGED, {
                    "user_id": str(user_id), "status": target, "previous_status": previous,
                    "reason_code": "user_disabled" if target == "DISABLED" else "user_enabled",
                })
            await session.flush()
            return await self._me(session, user)

    # ---------- PIN ----------
    async def set_pin(self, user_id: uuid.UUID, body: PinSetRequest) -> SecurityState:
        self._require_pin_format(body.pin)
        async with self._tx() as session:
            user = await self._load_user(session, user_id, lock=True)
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
                # Дефект FinAdvisor S6: set-pin перезаписывал PIN без старого. Здесь смена — только с текущим.
                if body.current_pin is None:
                    raise conflict("PIN_ALREADY_SET", "PIN уже задан — для смены укажите текущий PIN")
                await self._check_pin(user_id, cred, body.current_pin)
                cred.pin_hash = await _hasher.hash(body.pin)
                cred.pin_length = len(body.pin)
                cred.updated_at = _now()
                change = "pin_changed"
            await self._emit_security(session, user_id, change)
            return await self._security(user_id, cred, bio)

    async def remove_pin(self, user_id: uuid.UUID, current_pin: str) -> SecurityState:
        async with self._tx() as session:
            user = await self._load_user(session, user_id, lock=True)
            _ensure_mutable(user)
            cred = await session.get(PinCredential, user_id)
            if cred is None:
                raise conflict("PIN_NOT_SET", "PIN не задан")
            await self._check_pin(user_id, cred, current_pin)
            bio = await session.get(BiometricCredential, user_id)
            await session.delete(cred)
            await self._emit_security(session, user_id, "pin_removed")
            if bio is not None:  # биометрия — надстройка над PIN и без него не существует
                await session.delete(bio)
                await self._emit_security(session, user_id, "biometric_disabled")
            return await self._security(user_id, None, None)

    async def verify_pin(self, user_id: uuid.UUID, pin: str) -> None:
        async with self._tx() as session:
            # FOR UPDATE: проверки одного пользователя идут по очереди, параллельные запросы не обходят лимит.
            await self._load_user(session, user_id, lock=True)
            cred = await session.get(PinCredential, user_id)
            if cred is None:
                raise conflict("PIN_NOT_SET", "PIN не задан")
            await self._check_pin(user_id, cred, pin)

    async def request_pin_reset(self, user_id: uuid.UUID) -> int:
        """Код сброса: Redis хранит только HMAC; сам код уходит синхронно в notifications (в событиях и outbox
        его нет). notifications недоступен → 503 UPSTREAM_UNAVAILABLE, лимит частоты не расходуется."""
        async with self._tx() as session:
            user = await self._load_user(session, user_id, lock=True)
            _ensure_mutable(user)
            if await session.get(PinCredential, user_id) is None:
                raise conflict("PIN_NOT_SET", "PIN не задан — сбрасывать нечего")
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
            user = await self._load_user(session, user_id, lock=True)
            _ensure_mutable(user)
            cred = await session.get(PinCredential, user_id)
            if cred is None:
                raise conflict("PIN_NOT_SET", "PIN не задан — сбрасывать нечего")
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
            user = await self._load_user(session, user_id, lock=True)
            _ensure_mutable(user)
            pin = await session.get(PinCredential, user_id)
            if pin is None:
                raise conflict("PIN_REQUIRED", "Сначала задайте PIN — биометрия работает поверх него")
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
            user = await self._load_user(session, user_id, lock=True)
            _ensure_mutable(user)
            bio = await session.get(BiometricCredential, user_id)
            if bio is not None:
                await session.delete(bio)
                await self._emit_security(session, user_id, "biometric_disabled")
            return await self._security(user_id, await session.get(PinCredential, user_id), None)

    async def verify_biometric(self, user_id: uuid.UUID, token: str) -> None:
        async with self._tx() as session:
            await self._load_user(session, user_id, lock=True)
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
        if not body.age_confirmed_18_plus:
            raise unprocessable("AGE_CONFIRMATION_REQUIRED",
                                "TilHero доступен только с 18 лет — подтвердите возраст")
        if body.policy_version != current:
            raise conflict("POLICY_VERSION_OUTDATED", "Политика обновилась — ознакомьтесь с новой версией",
                           {"current_policy_version": current})
        policy = get_policy(current)
        purposes, unknown, missing = normalize_purposes(policy, body.purposes)
        if unknown or missing:
            raise unprocessable("CONSENT_PURPOSES_INVALID", "Некорректный набор целей согласия",
                                {"unknown": unknown, "missing_required": missing})
        async with self._tx() as session:
            user = await self._load_user(session, user_id, lock=True)
            _ensure_mutable(user)
            active = await self._active_consent(session, user_id, lock=True)
            if active is not None and active.policy_version == current and list(active.purposes) == purposes:
                return consent_state(user, active, current)  # повтор того же согласия — без новой записи
            now = truncate_ms(_now())
            if active is not None:
                active.revoked_at = now
                active.revoke_reason = "superseded"
                await session.flush()  # освобождаем уникальный индекс действующего согласия
            text_sha = policy.text_sha256(user.locale)  # type: ignore[arg-type]
            consent = Consent(
                consent_id=uuid.uuid4(),
                user_id=user_id,
                policy_version=current,
                purposes=purposes,
                accepted_at=now,
                channel=CHANNEL,
                locale=user.locale,
                age_confirmed_18_plus=True,
                policy_text_sha256=text_sha,
                evidence_hash=evidence_hash(
                    user_id=user_id, policy_version=current, purposes=purposes, accepted_at=now,
                    channel=CHANNEL, locale=user.locale, policy_text_sha256=text_sha,
                ),
            )
            session.add(consent)
            if not user.age_confirmed_18_plus:
                user.age_confirmed_18_plus = True
                user.age_confirmed_at = now
            if user.status == "ACTIVE":
                user.notifications_enabled = "notifications" in purposes
            await self._emit(session, EV_CONSENT_ACCEPTED, {
                "user_id": str(user_id), "consent_id": str(consent.consent_id), "policy_version": current,
                "purposes": purposes, "age_confirmed_18_plus": True,
            })
            return consent_state(user, consent, current)

    async def revoke_consent(self, user_id: uuid.UUID) -> ConsentState:
        current = self.settings.current_policy_version
        async with self._tx() as session:
            user = await self._load_user(session, user_id, lock=True)
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
            return consent_state(user, None, current)

    # ---------- удаление ----------
    def _deletion_response(self, req: DeletionRequest) -> DeletionResponse:
        return DeletionResponse(request_id=req.request_id, status="REQUESTED",
                                domains=[*req.expected_domains, DOMAIN])

    async def request_deletion(self, user_id: uuid.UUID, body: DeletionRequestIn) -> DeletionResponse:
        async with self._tx() as session:
            user = await self._load_user(session, user_id, lock=True)
            if user.status == "DELETION_REQUESTED":  # повтор: тот же запрос, без новых событий
                req = (await session.execute(
                    select(DeletionRequest).where(DeletionRequest.user_id == user_id,
                                                  DeletionRequest.status.in_(deletion_saga.OPEN_STATUSES))
                )).scalar_one()
                return self._deletion_response(req)
            cred = await session.get(PinCredential, user_id)
            if cred is not None:
                if not body.pin:
                    raise unprocessable("DELETION_CONFIRMATION_REQUIRED", "Подтвердите удаление PIN-кодом",
                                        {"method": "pin"})
                await self._check_pin(user_id, cred, body.pin)
            elif (body.confirm_word or "").strip().upper() not in DELETION_WORDS:
                raise unprocessable("DELETION_CONFIRMATION_REQUIRED",
                                    "Введите слово УДАЛИТЬ, чтобы подтвердить", {"method": "confirm_word"})
            now = _now()
            req = DeletionRequest(
                request_id=uuid.uuid4(), user_id=user_id, status="REQUESTED", requested_at=now,
                expected_domains=list(dict.fromkeys(self.settings.deletion_domains)), acked_domains=[],
                attempts=1, last_sent_at=now,
                next_retry_at=deletion_saga.next_retry_at(now, now, self.settings.deletion_retry_schedule),
            )
            session.add(req)
            previous = user.status
            user.status = "DELETION_REQUESTED"
            user.notifications_enabled = False
            await session.flush()
            requested = await self._emit(session, EV_DELETION_REQUESTED,
                                         deletion_store.requested_payload(req, attempt=1))
            # сага (спринт 9): attempt 1, расписание повторов неответившим доменам (deletion/sweeper.py)
            deletion_store.record_initial(session, req, sent_at=now, event_id=requested.event_id,
                                          schedule=self.settings.deletion_retry_schedule)
            await self._emit(session, EV_STATUS_CHANGED, {
                "user_id": str(user_id), "status": "DELETION_REQUESTED", "previous_status": previous,
                "reason_code": "deletion_requested",
            })
            response = self._deletion_response(req)
            if not req.expected_domains:  # нечего ждать — обезличиваем сразу
                await self._anonymize(session, req)
        return response

    async def on_domain_deleted(self, session: AsyncSession, env: Envelope) -> None:
        """ACK домена (user.domain.deleted.v1). Когда подтвердили все — обезличиваем профиль."""
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
        # ACK по доменам со временем (спринт 9); повторный ACK того же домена ничего не меняет. STUCK тоже принимает ACK
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
        user.notifications_enabled = False
        user.quiet_hours_start = user.quiet_hours_end = None
        user.timezone = self.settings.default_timezone
        user.bot_blocked = False
        await session.execute(delete(PinCredential).where(PinCredential.user_id == req.user_id))
        await session.execute(delete(BiometricCredential).where(BiometricCredential.user_id == req.user_id))
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
        if self.rt.redis is not None:
            try:
                await self.attempts.succeeded(req.user_id)
                await self.reset_codes.clear(req.user_id)
            except Exception:  # ключи всё равно истекут по TTL
                log.warning("redis cleanup after anonymization failed", exc_info=True)
        log.info("user anonymized after deletion acks")

    # ---------- админ-контур (спринт 2) ----------
    async def _admin_views(self, session: AsyncSession, users: list[User]) -> list[AdminIdentityUser]:
        ids = [u.user_id for u in users]
        if not ids:
            return []
        pins = set((await session.execute(
            select(PinCredential.user_id).where(PinCredential.user_id.in_(ids)))).scalars().all())
        bios = set((await session.execute(
            select(BiometricCredential.user_id).where(BiometricCredential.user_id.in_(ids)))).scalars().all())
        # Последнее согласие пользователя (действующее или отозванное) — DISTINCT ON по user_id
        latest = (await session.execute(
            select(Consent)
            .where(Consent.user_id.in_(ids))
            .order_by(Consent.user_id, Consent.accepted_at.desc())
            .ext(distinct_on(Consent.user_id))
        )).scalars().all()
        consents = {c.user_id: c for c in latest}
        out = []
        for u in users:
            c = consents.get(u.user_id)
            out.append(AdminIdentityUser(
                user_id=u.user_id,
                username=u.username,
                display_name=u.display_name,
                telegram_id_masked=mask_telegram_id(u.telegram_user_id),
                locale=u.locale,  # type: ignore[arg-type]
                status=u.status,  # type: ignore[arg-type]
                created_at=u.created_at,
                updated_at=u.updated_at,
                last_seen_at=u.last_seen_at,
                consent=AdminConsent(
                    policy_version=c.policy_version if c else None,
                    purposes=list(c.purposes) if c else [],
                    accepted_at=c.accepted_at if c else None,
                    age_confirmed_18_plus=u.age_confirmed_18_plus,
                    revoked_at=c.revoked_at if c else None,
                ),
                security=AdminSecurity(pin_enabled=u.user_id in pins, biometric_enabled=u.user_id in bios),
            ))
        return out

    async def admin_list_users(
        self, *, updated_after: datetime | None, cursor: str | None, limit: int
    ) -> AdminIdentityUserPage:
        """Курсорная выгрузка для сверки user-admin: по (updated_at, user_id) по возрастанию. Удалённые профили
        (DELETED, обезличены) тоже отдаются — read-модель должна узнать об удалении."""
        stmt = select(User).order_by(User.updated_at, User.user_id).limit(limit + 1)
        if updated_after is not None:
            stmt = stmt.where(User.updated_at > updated_after)
        if cursor:
            at, uid = _decode_cursor(cursor)
            stmt = stmt.where(tuple_(User.updated_at, User.user_id) > tuple_(at, uid))
        async with self._tx() as session:
            rows = list((await session.execute(stmt)).scalars().all())
            page = rows[:limit]
            items = await self._admin_views(session, page)
        next_cursor = _encode_cursor(page[-1].updated_at, page[-1].user_id) if len(rows) > limit else None
        return AdminIdentityUserPage(items=items, next_cursor=next_cursor)

    async def admin_get_user(self, user_id: uuid.UUID) -> AdminIdentityUser:
        async with self._tx() as session:
            user = await session.get(User, user_id)
            if user is None:
                raise _user_not_found()
            return (await self._admin_views(session, [user]))[0]

    async def _audit_sensitive(
        self, action: str, *, user_id: uuid.UUID, actor: Actor, field: str, reason: str,
        extra: dict[str, Any] | None = None,
    ) -> None:
        """Синхронная запись в audit о раскрытии/попытке раскрытия (сотрудник — в on_behalf_of: claim actor audit
        принимает только от admin-bff; делегирование разрешено только identity-consent и только sensitive.view*)."""
        record_id = str(uuid.uuid4())
        await self.rt.client("audit").post(
            "/internal/v1/records",
            json={
                "record_id": record_id,
                "occurred_at": _now().isoformat(),
                "action": action,
                "object_type": "user",
                "object_id": str(user_id),
                "after": {"field": field, **(extra or {})},
                "reason": reason,
                "trace_id": get_correlation_id()[:64],
                "on_behalf_of": {"actor_id": actor.id[:64], "actor_role": actor.role[:64]},
            },
            idempotency_key=record_id,  # повтор безопасен: audit идемпотентен по record_id
        )

    async def reveal(self, user_id: uuid.UUID, *, actor: Actor, field: str, reason: str) -> RevealResult:
        """Раскрытие полного Telegram ID сотруднику.
        1) квота на сотрудника (reveal_limit_per_window за reveal_window_seconds, Redis): превышение → 429
           RATE_LIMITED {retry_after} + запись `sensitive.view_rate_limited` (значение не выдаётся);
        2) синхронная запись `sensitive.view` в audit (сотрудник, причина, user_id); audit недоступен или отказал →
           503, значение не выдаётся."""
        async with self._tx() as session:
            user = await session.get(User, user_id)
            if user is None or user.status == "DELETED" or user.telegram_user_id is None:
                raise _user_not_found()
            value = str(user.telegram_user_id)
        s = self.settings
        quota = await rate_limit(self.redis, f"identity:reveal:{actor.id[:64]}", s.reveal_limit_per_window,
                                 s.reveal_window_seconds)
        if not quota.allowed:
            log.warning("sensitive reveal quota exceeded", extra={"staff_id": actor.id[:64]})
            try:
                await self._audit_sensitive(AUDIT_SENSITIVE_VIEW_LIMITED, user_id=user_id, actor=actor, field=field,
                                            reason=reason, extra={"limit": s.reveal_limit_per_window,
                                                                  "window_seconds": s.reveal_window_seconds})
            except Exception as exc:
                log.warning("reveal rate-limit not audited",
                            extra={"error_type": type(exc).__name__, "status": getattr(exc, "status", None)})
            raise too_many("RATE_LIMITED", "Превышен лимит просмотров чувствительных данных",
                           quota.reset_seconds or s.reveal_window_seconds)
        try:
            await self._audit_sensitive(AUDIT_SENSITIVE_VIEW, user_id=user_id, actor=actor, field=field, reason=reason)
        except Exception as exc:
            log.warning("sensitive view not audited, value withheld",
                        extra={"error_type": type(exc).__name__, "status": getattr(exc, "status", None)})
            raise unavailable("UPSTREAM_UNAVAILABLE", "Журнал аудита недоступен — значение не показано",
                              {"service": "audit"}) from exc
        log.info("sensitive field revealed", extra={"field": field, "staff_id": actor.id[:64]})
        return RevealResult(field="telegram_user_id", value=value,
                            expires_in=self.settings.reveal_expires_in_seconds)

    # ---------- служебные ----------
    async def delivery(self, user_id: uuid.UUID) -> DeliveryInfo:
        async with self._tx() as session:
            user = await session.get(User, user_id)
            if user is None or user.status == "DELETED" or user.telegram_user_id is None:
                raise _user_not_found()
            settings = notification_settings(user)
            return DeliveryInfo(
                telegram_user_id=user.telegram_user_id,
                locale=user.locale,  # type: ignore[arg-type]
                notifications_enabled=user.notifications_enabled,
                quiet_hours=settings.quiet_hours,
                digest_time=settings.digest_time,
                timezone=user.timezone,
                status=user.status,  # type: ignore[arg-type]
            )

    async def set_bot_status(self, telegram_user_id: int, blocked: bool) -> None:
        async with self._tx() as session:
            user = (await session.execute(
                select(User).where(User.telegram_user_id == telegram_user_id).with_for_update()
            )).scalar_one_or_none()
            if user is None:
                raise _user_not_found()
            user.bot_blocked = blocked
            if blocked:
                # Разблокировка бота уведомления обратно не включает: пользователь решает сам в настройках.
                user.notifications_enabled = False
