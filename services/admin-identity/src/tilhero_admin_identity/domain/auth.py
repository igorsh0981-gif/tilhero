"""Вход сотрудника: пароль → (смена пароля) → (подключение MFA) → (TOTP) → done; step-up; principal; bootstrap.

Безопасность:
- счётчик неудач — по HMAC-SHA256(нормализованный email) в Redis, одинаково для существующих и несуществующих
  учёток (5 → 423 ACCOUNT_LOCKED на 15 мин); для неизвестного email проверяется фиктивный argon2-хеш;
- challenge — одноразовый, 5 мин, привязан к staff_id/шагу/session_version, 5 попыток кода;
- TOTP: окно ±1, повтор шага запрещён (mfa_last_step под блокировкой строки);
- в аудит/логи не попадают пароли, коды, секреты, challenge, id сессии (только хеш), email неудачного входа.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import uuid
from datetime import timedelta
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from redis.asyncio import Redis
from sqlalchemy import select

from tilhero_admin_identity.domain import audit
from tilhero_admin_identity.domain.attempts import ReservingLimiter
from tilhero_admin_identity.domain.catalog import SUPER_ADMIN
from tilhero_admin_identity.domain.challenges import ChallengeData, Challenges, challenge_invalid
from tilhero_admin_identity.domain.crypto import (
    Passwords,
    SecretBox,
    b32,
    digest,
    match_totp,
    new_totp_secret,
    otpauth_uri,
)
from tilhero_admin_identity.domain.policy import ensure_strong, is_valid_email, mask_email, normalize_email
from tilhero_admin_identity.domain.resets import ResetContext
from tilhero_admin_identity.domain.store import (
    get_staff,
    is_privileged,
    lock_identity,
    now,
    principal_out,
    require_staff,
    staff_by_email,
)
from tilhero_admin_identity.models import Staff
from tilhero_admin_identity.schemas import (
    LoginIn,
    LoginStepOut,
    MfaEnrollStartOut,
    PasswordIn,
    PrincipalOut,
)
from tilhero_admin_identity.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, conflict, forbidden, unauthorized, unavailable
from tilhero_common.redis_tools import AttemptState

log = logging.getLogger("tilhero.admin_identity.auth")


def account_locked(retry_after: int) -> ApiError:
    return ApiError(423, "ACCOUNT_LOCKED", "Слишком много неудачных попыток — вход временно заблокирован",
                    {"retry_after": max(int(retry_after), 1)})


def invalid_credentials(remaining: int) -> ApiError:
    return ApiError(401, "INVALID_CREDENTIALS", "Неверный email или пароль", {"remaining": remaining})


def mfa_invalid(remaining: int) -> ApiError:
    return ApiError(401, "MFA_INVALID", "Неверный код подтверждения", {"remaining": remaining})


def mfa_locked(retry_after: int) -> ApiError:
    return ApiError(423, "MFA_LOCKED", "Слишком много неверных кодов — подтверждение временно заблокировано",
                    {"retry_after": max(int(retry_after), 1)})


def account_disabled() -> ApiError:
    return forbidden("ACCOUNT_DISABLED", "Учётная запись отключена")


def mfa_reset_required() -> ApiError:
    return conflict("MFA_RESET_REQUIRED", "MFA нужно подключить заново — обратитесь к администратору")


# auth.login_failed не чаще раза в LOGIN_FAILED_WINDOW с на email_hash; остальные неудачи — счётчиком
LOGIN_FAILED_WINDOW = 60
_AGGREGATE = """
local c = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], 3600)
if redis.call('SET', KEYS[2], '1', 'NX', 'EX', tonumber(ARGV[1])) then
  redis.call('DEL', KEYS[1])
  return c
end
return 0
"""
_TAKE_COUNT = """
local c = redis.call('GET', KEYS[1])
redis.call('DEL', KEYS[1])
return tonumber(c or '0')
"""


class Identity:
    """Зависимости домена (без FastAPI): настройки, argon2, шифрование MFA."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.passwords = Passwords(settings.argon2_time_cost, settings.argon2_memory_cost,
                                   settings.argon2_parallelism)
        self.box = SecretBox(settings.mfa_key)
        self.reset_ctx = ResetContext(self.passwords, settings.temp_password_ttl_hours)
        self._email_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                               info=b"tilhero-admin-identity/email-hmac/v1").derive(settings.mfa_key)

    # ---------- Redis-примитивы
    @staticmethod
    def redis(rt: Runtime) -> Redis:
        if rt.redis is None:
            raise unavailable("REDIS_UNAVAILABLE", "Хранилище сессий входа недоступно")
        return rt.redis

    def login_limiter(self, rt: Runtime) -> ReservingLimiter:
        s = self.settings
        return ReservingLimiter(self.redis(rt), f"{s.redis_namespace}:login", s.login_max_attempts,
                              s.login_lock_seconds)

    def mfa_limiter(self, rt: Runtime) -> ReservingLimiter:
        """Неверные TOTP-коды по staff_id — общий счётчик для входа (mfa), подключения MFA и step-up: новый
        challenge (после верного пароля) не даёт новых попыток. 5 неудач → 423 MFA_LOCKED на 15 мин (M1)."""
        s = self.settings
        return ReservingLimiter(self.redis(rt), f"{s.redis_namespace}:mfa", s.mfa_max_attempts,
                              s.mfa_lock_seconds)

    def challenges(self, rt: Runtime) -> Challenges:
        s = self.settings
        return Challenges(self.redis(rt), s.redis_namespace, s.challenge_ttl_seconds, s.mfa_max_attempts)

    def email_subject(self, email: str) -> str:
        """HMAC-SHA256(нормализованный email) ключом из HKDF(ADMIN_MFA_ENC_KEY): ключи Redis и email_hash в
        аудите не перебираются по словарю адресов. Смена ключа меняет хеши (счётчики попыток обнуляются)."""
        return hmac.new(self._email_key, normalize_email(email).encode("utf-8"), hashlib.sha256).hexdigest()

    async def unlock_login(self, rt: Runtime, email: str, staff_id: uuid.UUID | None = None) -> None:
        await self.login_limiter(rt).reset(self.email_subject(email))
        if staff_id is not None:
            await self.unlock_mfa(rt, staff_id)

    async def unlock_mfa(self, rt: Runtime, staff_id: uuid.UUID) -> None:
        await self.mfa_limiter(rt).reset(str(staff_id))

    # ---------- шаги
    async def next_step(self, session: Any, s: Staff) -> str:
        if s.must_change_password:
            return "password_change"
        if s.mfa_enabled:
            return "mfa"
        if await is_privileged(session, s.role):
            return "mfa_enroll"
        return "done"

    async def _advance(self, rt: Runtime, session: Any, s: Staff, *, ip: str | None = None,
                       mfa_passed: bool = False) -> LoginStepOut:
        step = "done" if mfa_passed else await self.next_step(session, s)
        if step == "done":
            s.last_login_at = now()
            await audit.record(session, "auth.login", actor_id=s.staff_id, actor_role=s.role, object_type="staff",
                               object_id=s.staff_id, after={"mfa": s.mfa_enabled}, ip=ip)
            return LoginStepOut(next="done", challenge=None, principal=await principal_out(session, s))
        challenge = await self.challenges(rt).issue(s.staff_id, step, s.session_version)
        return LoginStepOut(next=step, challenge=challenge, principal=None)  # type: ignore[arg-type]

    async def _load(self, rt: Runtime, session: Any, challenge: str, step: str) -> tuple[ChallengeData, Staff]:
        ch = self.challenges(rt)
        peek = await ch.load(challenge, step)
        s = await get_staff(session, peek.staff_id, for_update=True)
        # Все шаги одного сотрудника сериализуются блокировкой строки staff; challenge (одноразовость, счётчик
        # попыток) перечитывается уже под блокировкой — параллельный залп кодов не обходит лимит.
        data = await ch.load(challenge, step)
        if s is None or s.session_version != data.session_version or data.staff_id != s.staff_id:
            await self.challenges(rt).discard(data)
            raise challenge_invalid()
        if s.status != "ACTIVE":
            await self.challenges(rt).discard(data)
            raise account_disabled()
        return data, s

    # ---------- вход
    async def login(self, rt: Runtime, body: LoginIn) -> LoginStepOut:
        email = normalize_email(body.email)
        subject = self.email_subject(email)
        limiter = self.login_limiter(rt)
        state = await limiter.reserve(subject)
        if state.locked:
            raise account_locked(state.retry_after)
        async with rt.transaction() as session:
            staff = await staff_by_email(session, email) if is_valid_email(email) else None
            staff_id = staff.staff_id if staff else None
        # для неизвестного email — фиктивный хеш: время ответа не выдаёт существование учётки
        ok = await self.passwords.verify(staff.password_hash if staff is not None else None, body.password)
        if not ok or staff is None:
            state = await limiter.failed(subject, state)
            await self._audit_login_failure(rt, subject, state, object_id=staff_id, ip=body.ip)
            if state.locked:
                raise account_locked(state.retry_after)
            raise invalid_credentials(state.remaining)
        await limiter.reset(subject)
        deferred: ApiError | None = None
        result: LoginStepOut | None = None
        async with rt.transaction() as session:
            s = await require_staff(session, staff.staff_id, for_update=True)
            if s.status != "ACTIVE":
                await audit.record(session, "auth.login_failed", actor_id=s.staff_id, actor_role=s.role,
                                   object_type="staff", object_id=s.staff_id,
                                   after={"email_hash": subject, "cause": "account_disabled"}, ip=body.ip)
                deferred = account_disabled()
            elif s.must_change_password and s.temp_password_expires_at and s.temp_password_expires_at <= now():
                await audit.record(session, "auth.login_failed", actor_id=s.staff_id, actor_role=s.role,
                                   object_type="staff", object_id=s.staff_id,
                                   after={"email_hash": subject, "cause": "temporary_password_expired"}, ip=body.ip)
                deferred = unauthorized("TEMPORARY_PASSWORD_EXPIRED",
                                        "Срок временного пароля истёк — обратитесь к администратору")
            else:
                if s.password_hash and self.passwords.needs_rehash(s.password_hash):
                    s.password_hash = await self.passwords.hash(body.password)
                result = await self._advance(rt, session, s, ip=body.ip)
        if deferred is not None:
            raise deferred
        assert result is not None
        return result

    async def _audit_login_failure(self, rt: Runtime, subject: str, state: AttemptState, *,
                                   object_id: uuid.UUID | None, ip: str | None = None, actor: Staff | None = None,
                                   cause: str | None = None) -> None:
        """Неаутентифицированный трафик не раздувает журнал: auth.login_failed — не чаще раза в минуту на
        email_hash со счётчиком неудач за окно; на блокировке — одна запись auth.locked (с остатком счётчика);
        попытки во время блокировки сюда не попадают вовсе (отсекаются до проверки пароля)."""
        r = self.redis(rt)
        cnt = f"{self.settings.redis_namespace}:lfa:cnt:{subject}"
        gate = f"{self.settings.redis_namespace}:lfa:gate:{subject}"
        if state.locked:
            action, failures = "auth.locked", int(await r.eval(_TAKE_COUNT, 1, cnt)) + 1
        else:
            action, failures = "auth.login_failed", int(
                await r.eval(_AGGREGATE, 2, cnt, gate, LOGIN_FAILED_WINDOW))
            if failures == 0:
                return
        after: dict[str, Any] = {"email_hash": subject, "failures": failures}
        if cause:
            after["cause"] = cause
        if state.locked:
            after["lock_seconds"] = self.settings.login_lock_seconds
        else:
            after["remaining"] = state.remaining
            after["window_seconds"] = LOGIN_FAILED_WINDOW
        async with rt.transaction() as session:
            await audit.record(session, action, actor_id=actor.staff_id if actor else None,
                               actor_role=actor.role if actor else None, object_type="staff", object_id=object_id,
                               after=after, ip=ip)

    # ---------- пароль
    async def change_password(self, rt: Runtime, body: PasswordIn) -> LoginStepOut:
        if body.challenge is not None:
            return await self._change_password_step(rt, body.challenge, body.new_password)
        assert body.staff_id is not None and body.current_password is not None
        return await self._change_own_password(rt, body.staff_id, body.current_password, body.new_password)

    async def _set_password(self, session: Any, s: Staff, new_password: str, *, same: bool) -> None:
        ensure_strong(new_password, email=s.email, same_as_previous=same)
        s.password_hash = await self.passwords.hash(new_password)
        s.must_change_password = False
        s.temp_password_expires_at = None
        s.password_changed_at = now()
        s.session_version += 1
        s.updated_at = now()
        await audit.record(session, "auth.password_changed", actor_id=s.staff_id, actor_role=s.role,
                           object_type="staff", object_id=s.staff_id, after={"sessions_revoked": True})

    async def _change_password_step(self, rt: Runtime, challenge: str, new_password: str) -> LoginStepOut:
        async with rt.transaction() as session:
            data, s = await self._load(rt, session, challenge, "password_change")
            same = await self.passwords.verify(s.password_hash, new_password)
            await self._set_password(session, s, new_password, same=same)
            await self.challenges(rt).consume(data)
            return await self._advance(rt, session, s)

    async def _change_own_password(self, rt: Runtime, staff_id: uuid.UUID, current: str, new: str) -> LoginStepOut:
        async with rt.transaction() as session:
            s = await require_staff(session, staff_id)
            if s.status != "ACTIVE":
                raise account_disabled()
            subject = self.email_subject(s.email)
        limiter = self.login_limiter(rt)
        state = await limiter.reserve(subject)
        if state.locked:
            raise account_locked(state.retry_after)
        if not await self.passwords.verify(s.password_hash, current):
            state = await limiter.failed(subject, state)
            await self._audit_login_failure(rt, subject, state, object_id=s.staff_id, actor=s,
                                            cause="password_change_current_invalid")
            if state.locked:
                raise account_locked(state.retry_after)
            raise invalid_credentials(state.remaining)
        await limiter.reset(subject)
        async with rt.transaction() as session:
            s = await require_staff(session, staff_id, for_update=True)
            await self._set_password(session, s, new, same=hmac.compare_digest(current.encode(), new.encode()))
            return LoginStepOut(next="done", challenge=None, principal=await principal_out(session, s))

    # ---------- MFA
    async def enroll_start(self, rt: Runtime, challenge: str) -> MfaEnrollStartOut:
        async with rt.transaction() as session:
            _, s = await self._load(rt, session, challenge, "mfa_enroll")
            if s.mfa_enabled:
                raise challenge_invalid()
            secret = new_totp_secret()
            s.mfa_secret_enc = self.box.encrypt(secret, s.staff_id)
            s.mfa_last_step = None
            s.updated_at = now()
            issuer = self.settings.totp_issuer
            return MfaEnrollStartOut(secret=b32(secret), otpauth_uri=otpauth_uri(secret, issuer, s.email),
                                     issuer=issuer, account=s.email)

    async def _check_code(self, rt: Runtime, session: Any, data: ChallengeData, s: Staff, code: str,
                          context: str) -> tuple[int | None, ApiError | None]:
        secret = self.box.decrypt(s.mfa_secret_enc, s.staff_id) if s.mfa_secret_enc else None
        if secret is None:
            if context == "enroll":
                return None, conflict("MFA_ENROLL_NOT_STARTED", "Сначала получите секрет для подключения MFA")
            await self.challenges(rt).discard(data)
            return None, mfa_reset_required()
        limiter = self.mfa_limiter(rt)
        subject = str(s.staff_id)
        state = await limiter.reserve(subject)  # до проверки кода: залп не перебирает больше лимита
        if state.locked:
            return None, mfa_locked(state.retry_after)  # без аудита: только auth.locked при блокировке
        step = match_totp(secret, code, s.mfa_last_step)
        if step is not None:
            await limiter.reset(subject)
            return step, None
        state = await limiter.failed(subject, state)
        remaining = min(await self.challenges(rt).fail(data), state.remaining)
        await audit.record(session, "auth.mfa_failed", actor_id=s.staff_id, actor_role=s.role, object_type="staff",
                           object_id=s.staff_id, after={"context": context, "remaining": remaining})
        if state.locked:
            await self._audit_mfa_locked(session, s, "login_mfa" if context == "login" else "mfa_enroll")
            return None, mfa_locked(state.retry_after)
        return None, mfa_invalid(remaining)

    async def _audit_mfa_locked(self, session: Any, s: Staff, context: str) -> None:
        await audit.record(session, "auth.locked", actor_id=s.staff_id, actor_role=s.role, object_type="staff",
                           object_id=s.staff_id, after={"context": context,
                                                        "lock_seconds": self.settings.mfa_lock_seconds})

    async def enroll_confirm(self, rt: Runtime, challenge: str, code: str) -> LoginStepOut:
        deferred: ApiError | None = None
        async with rt.transaction() as session:
            data, s = await self._load(rt, session, challenge, "mfa_enroll")
            if s.mfa_enabled:
                raise challenge_invalid()
            step, deferred = await self._check_code(rt, session, data, s, code, "enroll")
            if deferred is None:
                assert step is not None
                await self.challenges(rt).consume(data)
                s.mfa_enabled = True
                s.mfa_last_step = step
                s.updated_at = now()
                await audit.record(session, "auth.mfa_enrolled", actor_id=s.staff_id, actor_role=s.role,
                                   object_type="staff", object_id=s.staff_id, after={"mfa_enabled": True})
                result = await self._advance(rt, session, s, mfa_passed=True)
        if deferred is not None:
            raise deferred
        return result

    async def mfa_verify(self, rt: Runtime, challenge: str, code: str) -> LoginStepOut:
        deferred: ApiError | None = None
        async with rt.transaction() as session:
            data, s = await self._load(rt, session, challenge, "mfa")
            step, deferred = await self._check_code(rt, session, data, s, code, "login")
            if deferred is None:
                assert step is not None
                await self.challenges(rt).consume(data)
                s.mfa_last_step = step
                result = await self._advance(rt, session, s, mfa_passed=True)
        if deferred is not None:
            raise deferred
        return result

    async def step_up(self, rt: Runtime, staff_id: uuid.UUID, code: str) -> None:
        limiter = self.mfa_limiter(rt)
        subject = str(staff_id)
        deferred: ApiError | None = None
        async with rt.transaction() as session:
            s = await require_staff(session, staff_id, for_update=True)
            if s.status != "ACTIVE":
                raise account_disabled()
            if not s.mfa_enabled or not s.mfa_secret_enc:
                raise conflict("MFA_NOT_ENABLED", "MFA не подключена")
            secret = self.box.decrypt(s.mfa_secret_enc, s.staff_id)
            if secret is None:
                raise mfa_reset_required()
            state = await limiter.reserve(subject)
            if state.locked:
                raise mfa_locked(state.retry_after)
            step = match_totp(secret, code, s.mfa_last_step)
            if step is None:
                state = await limiter.failed(subject, state)
                await audit.record(session, "auth.mfa_failed", actor_id=s.staff_id, actor_role=s.role,
                                   object_type="staff", object_id=s.staff_id,
                                   after={"context": "step_up", "remaining": state.remaining})
                if state.locked:
                    await self._audit_mfa_locked(session, s, "step_up")
                deferred = mfa_locked(state.retry_after) if state.locked else mfa_invalid(state.remaining)
            else:
                s.mfa_last_step = step
                await audit.record(session, "auth.step_up", actor_id=s.staff_id, actor_role=s.role,
                                   object_type="staff", object_id=s.staff_id)
        if deferred is not None:
            raise deferred
        await limiter.reset(subject)

    # ---------- principal / logout
    async def principal(self, rt: Runtime, staff_id: uuid.UUID) -> PrincipalOut:
        async with rt.transaction() as session:
            s = await require_staff(session, staff_id)
            if s.status != "ACTIVE":
                raise account_disabled()
            return await principal_out(session, s)

    async def logout(self, rt: Runtime, staff_id: uuid.UUID, session_id: str) -> None:
        async with rt.transaction() as session:
            s = await require_staff(session, staff_id)
            # id сессии — секрет cookie: в журнал только префикс хеша
            await audit.record(session, "auth.logout", actor_id=s.staff_id, actor_role=s.role, object_type="staff",
                               object_id=s.staff_id, session_id=digest(session_id)[:32])

    # ---------- bootstrap
    async def bootstrap(self, rt: Runtime) -> bool:
        """Первый super_admin из ADMIN_BOOTSTRAP_EMAIL/PASSWORD (пароль уже проверен правилами в Settings).
        Идемпотентно: если есть активный super_admin — не создаёт (INTERNAL_API §1). Пароль из переменной
        временный: срок 72 ч, при первом входе — смена (must_change_password) и подключение TOTP.
        Пока первый вход не выполнен — предупреждение в лог при каждом старте; если срок истёк, а bootstrap-учётка
        по-прежнему единственный super_admin, — пароль из переменной выдаётся заново (иначе тупик без консоли).
        True — учётка создана."""
        st = self.settings
        if not st.admin_bootstrap_email or st.admin_bootstrap_password is None:
            return False
        email = normalize_email(st.admin_bootstrap_email)
        if not is_valid_email(email):
            log.error("admin bootstrap skipped: ADMIN_BOOTSTRAP_EMAIL is not a valid email")
            return False
        password = st.admin_bootstrap_password.get_secret_value()
        ttl = timedelta(hours=st.bootstrap_password_ttl_hours)
        async with rt.transaction() as session:
            await lock_identity(session)
            supers = list((await session.execute(
                select(Staff).where(Staff.role == SUPER_ADMIN, Staff.status == "ACTIVE")
            )).scalars().all())
            if supers:
                await self._bootstrap_pending(session, supers, email, password, ttl)
                return False
            if await staff_by_email(session, email) is not None:
                log.warning("admin bootstrap skipped: bootstrap email belongs to an existing staff account")
                return False
            at = now()
            s = Staff(staff_id=uuid.uuid4(), email=email, display_name=st.admin_bootstrap_display_name[:120],
                      role=SUPER_ADMIN, password_hash=await self.passwords.hash(password),
                      must_change_password=True, temp_password_expires_at=at + ttl, mfa_enabled=False,
                      status="ACTIVE", session_version=1, created_at=at, updated_at=at, created_by=None)
            session.add(s)
            await session.flush()
            await audit.record(session, "staff.bootstrap", object_type="staff", object_id=s.staff_id,
                               after={"email": mask_email(email), "role": SUPER_ADMIN, "must_change_password": True,
                                      "password_ttl_hours": st.bootstrap_password_ttl_hours})
        log.warning("admin bootstrap: first super_admin created; complete the first login within %s h, "
                    "then remove ADMIN_BOOTSTRAP_EMAIL/ADMIN_BOOTSTRAP_PASSWORD", st.bootstrap_password_ttl_hours)
        return True

    async def _bootstrap_pending(self, session: Any, supers: list[Staff], email: str, password: str,
                                 ttl: timedelta) -> None:
        boot = next((x for x in supers if x.email == email and x.created_by is None and x.must_change_password
                     and x.last_login_at is None and x.status == "ACTIVE"), None)
        if boot is None:
            # Переменные нужны только до первого входа — напоминаем удалить (значения не логируем)
            log.warning("admin bootstrap skipped: active super_admin already exists; "
                        "remove ADMIN_BOOTSTRAP_EMAIL/ADMIN_BOOTSTRAP_PASSWORD from the environment")
            return
        expires = boot.temp_password_expires_at
        if expires is not None and expires <= now() and len(supers) == 1:
            boot.password_hash = await self.passwords.hash(password)
            boot.temp_password_expires_at = now() + ttl
            boot.session_version += 1
            boot.updated_at = now()
            await audit.record(session, "staff.bootstrap", object_type="staff", object_id=boot.staff_id,
                               after={"refreshed": True,
                                      "password_ttl_hours": self.settings.bootstrap_password_ttl_hours})
            log.warning("admin bootstrap: temporary password had expired and was re-issued "
                        "from ADMIN_BOOTSTRAP_PASSWORD")
            return
        log.warning("admin bootstrap: first login of the bootstrap super_admin is not completed yet "
                    "(temporary password valid until %s)", expires.isoformat() if expires else "n/a")
