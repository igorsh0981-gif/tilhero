"""Bootstrap, отсутствие секретов в логах/аудите, контракт события, криптопримитивы, настройки, схема/роли БД."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid
from typing import Any

import httpx
import pytest
from aid_testkit import (
    NEW_PASSWORD,
    ROOT_EMAIL,
    ROOT_PASSWORD,
    SERVICE_DIR,
    Env,
    Person,
    bad_code,
    code_at,
    make_settings,
    new_email,
)
from pydantic import ValidationError

from tilhero_admin_identity.domain.crypto import (
    SecretBox,
    hotp,
    match_totp,
    otpauth_uri,
    temporary_password,
    totp,
)
from tilhero_admin_identity.main import build_app
from tilhero_admin_identity.models import Base
from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus, messaging_metadata
from tilhero_common.testing import (
    TEST_REDIS_URL,
    assert_event_conforms,
    ddl_allowed_for,
    internal_headers,
    migrated_under_roles,
    schema_drift,
)


async def _super_admins(env: Env) -> int:
    return (await env.sql("SELECT count(*) FROM staff WHERE role = 'super_admin'"))[0][0]


async def test_bootstrap_is_idempotent(env_factory) -> None:
    env = await env_factory()
    assert await _super_admins(env) == 1
    row = (await env.sql("SELECT email, must_change_password, created_by, "
                         "extract(epoch FROM temp_password_expires_at - created_at) FROM staff"))[0]
    assert row == (ROOT_EMAIL, True, None, 72 * 3600)  # пароль из переменной — временный, 72 ч
    # повторный вызов и перезапуск сервиса над той же БД — ничего не создают
    assert await env.app.state.identity.bootstrap(env.runtime) is False
    env2 = await env_factory()
    assert await _super_admins(env2) == 1
    # другой email в переменных после появления super_admin — тоже ничего
    env3 = await env_factory(admin_bootstrap_email="other@tilhero.test")
    assert (await env3.sql("SELECT count(*) FROM staff"))[0][0] == 1
    boot = [e.payload for e in await env.audit() if e.payload["action"] == "staff.bootstrap"]
    assert len(boot) == 1 and boot[0]["actor_type"] == "system" and boot[0]["actor_id"] is None
    assert boot[0]["after"] == {"email": "r***@tilhero.test", "role": "super_admin", "must_change_password": True,
                                "password_ttl_hours": 72}
    assert (await env2.audit()) == [] and (await env3.audit()) == []
    first = await env.first_login(ROOT_EMAIL, ROOT_PASSWORD)
    assert first.principal["staff"]["role"] == "super_admin"


async def test_bootstrap_skipped_without_variables(env_factory) -> None:
    env = await env_factory(admin_bootstrap_email=None, admin_bootstrap_password=None)
    assert (await env.sql("SELECT count(*) FROM staff"))[0][0] == 0


async def test_no_secrets_in_logs_or_audit(env: Env, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    root = await env.first_login(ROOT_EMAIL, ROOT_PASSWORD)
    assert root.secret is not None
    await env.login(ROOT_EMAIL, "Wrong-passw0rd-zz")
    await env.login("ghost.user@tilhero.test", "Wrong-passw0rd-zz")
    await env.mfa_login(root)
    await env.reset_last_step(root.staff_id)
    step_code = code_at(root.secret)
    await env.post("/auth/step-up", {"staff_id": root.staff_id, "code": step_code})
    created = await env.create_staff(root.actor, new_email("leak"), "support")
    temp = created.json()["temporary_password"]
    rp = await env.c.post(f"/admin/v1/staff/{created.json()['staff']['staff_id']}/reset-password",
                          json={"reason": "Проверка"}, headers=env.h(root.actor))
    temp2 = rp.json()["temporary_password"]
    await env.post("/auth/logout", {"staff_id": root.staff_id, "session_id": "cookie-secret-session-id-value"})
    secrets = [*env.leaks, root.password, ROOT_PASSWORD, NEW_PASSWORD, temp, temp2, step_code,
               "Wrong-passw0rd-zz", "cookie-secret-session-id-value", root.secret]
    events = await env.audit()
    assert events
    dump = json.dumps([e.payload for e in events], ensure_ascii=False)
    async with env.runtime.transaction() as s:
        from sqlalchemy import text

        outbox = json.dumps([r[0] for r in (await s.execute(text("SELECT envelope FROM outbox"))).all()],
                            ensure_ascii=False)
    assert len(caplog.records) > 10
    logs = caplog.text + "\n".join(json.dumps(r.__dict__, default=str, ensure_ascii=False) for r in caplog.records)
    for secret in secrets:
        assert secret not in dump, secret
        assert secret not in outbox, secret
        assert secret not in logs, secret
    assert "ghost.user@tilhero.test" not in dump and "ghost.user" not in logs
    # секрет MFA в БД только зашифрован
    raw = (await env.sql("SELECT mfa_secret_enc FROM staff WHERE staff_id = :i", i=root.staff_id))[0][0]
    assert base64.b32decode(root.secret + "=" * (-len(root.secret) % 8)) not in bytes(raw)


async def test_audit_events_conform_to_contract(env: Env, root: Person, root2: Person) -> None:
    await env.login(root.email, "Wrong-passw0rd-zz")
    t = await env.onboard(root.actor, new_email("c"), "support")
    r = await env.patch(root.actor, t.staff_id, {"role": "billing", "reason": "Контракт"})
    await env.approve(root2.actor, r.json()["approval"]["approval_id"])
    await env.post("/auth/logout", {"staff_id": root.staff_id, "session_id": "abc"})
    events = await env.audit()
    actions = {e.payload["action"] for e in events}
    assert {"staff.bootstrap", "auth.login", "auth.login_failed", "auth.password_changed", "auth.mfa_enrolled",
            "staff.created", "approval.waived", "approval.applied", "approval.approved", "auth.logout"} <= actions
    from tilhero_audit.consumers import AUDIT_EVENT_PRODUCERS
    from tilhero_audit.schemas import RecordIn

    assert "admin-identity" in AUDIT_EVENT_PRODUCERS
    for e in events:
        assert e.producer == "admin-identity"
        assert_event_conforms(e)
        RecordIn.model_validate(e.payload)  # audit-service примет запись как есть
        assert e.payload["actor_type"] in {"staff", "system"}


async def test_parallel_use_of_one_challenge_succeeds_once(env: Env, root: Person) -> None:
    assert root.secret is not None
    await env.reset_last_step(root.staff_id)
    ch = (await env.login(root.email, root.password)).json()["challenge"]
    codes = [code_at(root.secret, 0), code_at(root.secret, 1)]
    results = await asyncio.gather(*(env.post("/auth/mfa/verify", {"challenge": ch, "code": c}) for c in codes))
    assert sorted(r.status_code for r in results) == [200, 401]


# ---------------------------------------------------------------- криптопримитивы и настройки

def test_totp_rfc6238_vectors() -> None:
    secret = b"12345678901234567890"  # RFC 6238, приложение B (SHA-1)
    assert hotp(secret, 59 // 30, digits=8) == "94287082"
    assert hotp(secret, 1111111109 // 30, digits=8) == "07081804"
    assert hotp(secret, 2000000000 // 30, digits=8) == "69279037"
    now = 1_700_000_000.0
    code = totp(secret, now)
    step = int(now // 30)
    assert match_totp(secret, code, None, now) == step
    assert match_totp(secret, code, step, now) is None  # повтор шага
    assert match_totp(secret, hotp(secret, step - 1), None, now) == step - 1  # окно −1
    assert match_totp(secret, hotp(secret, step + 1), None, now) == step + 1  # окно +1
    assert match_totp(secret, hotp(secret, step + 2), None, now) is None
    uri = otpauth_uri(secret, "TilHero Admin", "a@b.io")
    assert uri.startswith("otpauth://totp/TilHero%20Admin:a@b.io?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&")
    assert "issuer=TilHero%20Admin" in uri and "digits=6" in uri and "period=30" in uri


def test_secret_box_binds_staff_id() -> None:
    box = SecretBox(b"k" * 32)
    a, b = uuid.uuid4(), uuid.uuid4()
    blob = box.encrypt(b"secret-bytes", a)
    assert box.decrypt(blob, a) == b"secret-bytes"
    assert box.decrypt(blob, b) is None  # AAD = staff_id
    assert SecretBox(b"x" * 32).decrypt(blob, a) is None  # другой ключ (ротация) → переподключение MFA
    assert box.decrypt(blob[:-1] + bytes([blob[-1] ^ 1]), a) is None
    assert box.encrypt(b"same", a) != box.encrypt(b"same", a)  # случайный nonce


def test_temporary_password_shape() -> None:
    values = {temporary_password() for _ in range(50)}
    assert len(values) == 50
    for v in values:
        assert len(v) == 20 and v.isalnum() and any(c.isdigit() for c in v) and any(c.isalpha() for c in v)


def test_settings_guards() -> None:
    key = base64.urlsafe_b64encode(b"z" * 32).decode().rstrip("=")
    s = make_settings(admin_mfa_enc_key=key)
    assert s.mfa_key == b"z" * 32 and s.port == 8120 and s.service_name == "admin-identity"
    with pytest.raises(ValidationError):
        make_settings(admin_mfa_enc_key=base64.urlsafe_b64encode(b"short").decode())
    with pytest.raises(ValidationError):
        make_settings(admin_bootstrap_password="short")
    prod = {"env": "prod", "internal_jwt_secret": "p" * 40, "internal_jwt_private_key": key,
            "redis_url": "redis://r:6379/0", "database_url": "postgresql://db/tilhero"}
    with pytest.raises(ValidationError, match="ADMIN_MFA_ENC_KEY"):
        make_settings(**prod)
    assert make_settings(**prod, admin_mfa_enc_key=key).mfa_key == b"z" * 32
    for missing, var in (("redis_url", "REDIS_URL"), ("database_url", "DATABASE_URL")):
        with pytest.raises(ValidationError, match=var):
            make_settings(**{**prod, missing: None}, admin_mfa_enc_key=key)
        with pytest.raises(ValidationError, match=var):
            make_settings(**{**prod, missing: None, "env": "stage"}, admin_mfa_enc_key=key)
    dev = make_settings()
    assert len(dev.mfa_key) == 32 and dev.mfa_key == make_settings().mfa_key  # детерминированный dev-ключ


# ---------------------------------------------------------------- БД: модели = миграции, роли

async def test_models_match_migrations_and_runtime_role() -> None:
    ns = f"t:adminid:{uuid.uuid4().hex[:10]}"

    def make(**kw):
        return make_settings(redis_url=TEST_REDIS_URL, redis_namespace=ns, **kw)

    async with migrated_under_roles(SERVICE_DIR, make, "aid_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in ("staff", "roles", "role_permissions", "approvals", "outbox"):
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        runtime = Runtime(settings, bus=InMemoryBus())
        app = build_app(settings, runtime)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://aid") as c:
                r = await c.post("/internal/v1/auth/login", json={"email": ROOT_EMAIL, "password": ROOT_PASSWORD},
                                 headers=internal_headers(settings, issuer="admin-bff"))
                assert r.status_code == 200 and r.json()["next"] == "password_change"
            assert runtime.redis is not None
            keys = [k async for k in runtime.redis.scan_iter(match=f"{ns}*")]
            if keys:
                await runtime.redis.delete(*keys)


async def test_parallel_wrong_codes_on_one_challenge_are_capped(env: Env, root: Person) -> None:
    assert root.secret is not None
    ch = (await env.login(root.email, root.password)).json()["challenge"]
    bad = bad_code(root.secret)
    burst = await asyncio.gather(*(env.post("/auth/mfa/verify", {"challenge": ch, "code": bad}) for _ in range(8)))
    codes = sorted(r.json()["code"] for r in burst)
    # 4 неверных кода → пятый блокирует MFA сотрудника (423), остальные — challenge сгорел
    assert codes == ["CHALLENGE_INVALID"] * 3 + ["MFA_INVALID"] * 4 + ["MFA_LOCKED"], codes
    assert sorted(r.json()["details"]["remaining"] for r in burst if r.json()["code"] == "MFA_INVALID") == [
        1, 2, 3, 4]


class _PausedAfterFirstCommand:
    """Клиент Redis, который после первой команды ждёт gate: запрос «застрял» между чтением и записью."""

    def __init__(self, redis: Any, gate: asyncio.Event) -> None:
        self._redis, self._gate, self._first = redis, gate, True

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._redis, name)
        if name == "pipeline" or not callable(attr):
            return attr

        async def call(*args: Any, **kw: Any) -> Any:  # команды redis.asyncio возвращают awaitable
            result = await attr(*args, **kw)
            if self._first:
                self._first = False
                await self._gate.wait()
            return result
        return call


async def test_reservation_started_before_lock_cannot_pass_after_it(env: Env) -> None:
    """Спринт 9 (Q9), причина нестабильности test_parallel_burst_cannot_exceed_attempt_limit: запрос прочитал
    «не заблокировано», сосед тем временем исчерпал лимит (блокировка + удаление счётчика), запрос сделал INCR
    по пустому счётчику и получил попытку с полным запасом. Резервирование атомарно — оба запроса блокируются."""
    from tilhero_admin_identity.domain.attempts import ReservingLimiter

    redis = env.runtime.redis
    assert redis is not None
    ns, subject, gate = f"{env.settings.redis_namespace}:race", "s", asyncio.Event()
    first = ReservingLimiter(redis, ns, 5, 900)
    for left in (4, 3, 2, 1, 0):
        assert (await first.reserve(subject)).remaining == left
    late = ReservingLimiter(_PausedAfterFirstCommand(redis, gate), ns, 5, 900)  # type: ignore[arg-type]  # прокси Redis
    pending = asyncio.create_task(late.reserve(subject))
    await asyncio.sleep(0.05)
    assert (await first.reserve(subject)).locked
    gate.set()
    assert (await pending).locked
