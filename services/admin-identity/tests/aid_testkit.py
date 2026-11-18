"""Помощники тестов admin-identity (уникальное имя модуля — без конфликтов с другими сервисами)."""

from __future__ import annotations

import base64
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import text

from tilhero_admin_identity.domain.crypto import digest, hotp
from tilhero_admin_identity.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import Envelope, InMemoryBus
from tilhero_common.testing import internal_headers

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
AUDIT = "admin.audit.recorded.v1"
ROOT_EMAIL = "root@tilhero.test"
ROOT_PASSWORD = "Bootstrap-Passw0rd-1"
NEW_PASSWORD = "Strong-New-Passw0rd"


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {
        "env": "test",
        "internal_jwt_secret": "t" * 40,
        "argon2_time_cost": 1,
        "argon2_memory_cost": 1024,
        "argon2_parallelism": 1,
        "admin_bootstrap_email": ROOT_EMAIL,
        "admin_bootstrap_password": ROOT_PASSWORD,
        "admin_bootstrap_display_name": "Root Admin",
    }
    base.update(kw)
    return Settings(**base)


def code_at(secret_b32: str, offset_steps: int = 0) -> str:
    """Код TOTP шага «сейчас + offset_steps». Между двумя вызовами может смениться 30-секундный шаг, поэтому код,
    который тест повторяет (проверка повтора), вычисляется один раз и переиспользуется, а не пересчитывается."""
    secret = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8))
    return hotp(secret, int(time.time() // 30) + offset_steps)


def bad_code(secret_b32: str) -> str:
    """Заведомо неверный код: не совпадает ни с одним кодом окна ±1 шаг (сервер принимает всё окно, поэтому
    сравнения только с текущим кодом мало — «000000» изредка оказывается верным кодом соседнего шага)."""
    window = {code_at(secret_b32, d) for d in (-2, -1, 0, 1, 2)}  # ±2: запас на смену шага во время теста
    return next(c for c in ("000000", "111111", "222222", "333333", "444444", "555555") if c not in window)


@dataclass
class Person:
    staff_id: str
    email: str
    password: str
    secret: str | None
    principal: dict[str, Any]
    secrets: list[str] = field(default_factory=list)  # всё, что не должно утечь (пароли, challenge, коды)

    @property
    def actor(self) -> Actor:
        """Как admin-bff строит actor из principal."""
        return Actor(id=self.staff_id, role=self.principal["staff"]["role"],
                     permissions=frozenset(self.principal["permissions"]),
                     name=self.principal["staff"]["display_name"])


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime, bus: InMemoryBus,
                 app: Any) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus
        self.app = app
        self.leaks: list[str] = []

    def h(self, actor: Actor | None = None, issuer: str = "admin-bff", **extra: str) -> dict[str, str]:
        return {**internal_headers(self.settings, issuer=issuer, actor=actor), **extra}

    async def flush(self) -> None:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    async def audit(self) -> list[Envelope]:
        await self.flush()
        return self.bus.of_type(AUDIT)

    async def actions(self) -> list[str]:
        return [e.payload["action"] for e in await self.audit()]

    async def sql(self, stmt: str, **params: Any) -> Any:
        async with self.runtime.transaction() as s:
            return (await s.execute(text(stmt), params)).all()

    async def reset_last_step(self, staff_id: str) -> None:
        """В тестах много TOTP-входов подряд: повтор шага запрещён, поэтому сбрасываем mfa_last_step."""
        await self.sql("UPDATE staff SET mfa_last_step = NULL WHERE staff_id = :i RETURNING staff_id", i=staff_id)

    def challenge_key(self, challenge: str) -> str:
        return f"{self.settings.redis_namespace}:ch:{digest(challenge)}"

    # ---------- вход
    async def post(self, path: str, body: dict[str, Any], **kw: Any) -> httpx.Response:
        return await self.c.post(f"/internal/v1{path}", json=body, headers=kw.pop("headers", None) or self.h(), **kw)

    async def login(self, email: str, password: str, **extra: Any) -> httpx.Response:
        return await self.post("/auth/login", {"email": email, "password": password, **extra})

    async def first_login(self, email: str, temp_password: str, new_password: str = NEW_PASSWORD) -> Person:
        """must_change_password → (mfa_enroll) → done."""
        r = await self.login(email, temp_password)
        assert r.status_code == 200, r.text
        step = r.json()
        assert step["next"] == "password_change", step
        leaks = [temp_password, new_password, step["challenge"]]
        r = await self.post("/auth/password", {"challenge": step["challenge"], "new_password": new_password})
        assert r.status_code == 200, r.text
        step = r.json()
        secret = None
        if step["next"] == "mfa_enroll":
            leaks.append(step["challenge"])
            r = await self.post("/auth/mfa/enroll/start", {"challenge": step["challenge"]})
            assert r.status_code == 200, r.text
            secret = r.json()["secret"]
            code = code_at(secret)
            leaks += [secret, r.json()["otpauth_uri"]]
            r = await self.post("/auth/mfa/enroll/confirm", {"challenge": step["challenge"], "code": code})
            assert r.status_code == 200, r.text
            step = r.json()
        assert step["next"] == "done" and step["principal"] is not None, step
        self.leaks += leaks
        p = step["principal"]
        return Person(str(p["staff"]["staff_id"]), email, new_password, secret, p, leaks)

    async def mfa_login(self, person: Person) -> dict[str, Any]:
        await self.reset_last_step(person.staff_id)
        r = await self.login(person.email, person.password)
        assert r.status_code == 200 and r.json()["next"] == "mfa", r.text
        ch = r.json()["challenge"]
        assert person.secret is not None
        r = await self.post("/auth/mfa/verify", {"challenge": ch, "code": code_at(person.secret)})
        assert r.status_code == 200, r.text
        self.leaks.append(ch)
        return r.json()

    async def principal(self, staff_id: str) -> httpx.Response:
        return await self.c.get(f"/internal/v1/staff/{staff_id}/principal", headers=self.h())

    async def refresh(self, person: Person) -> Person:
        r = await self.principal(person.staff_id)
        assert r.status_code == 200, r.text
        person.principal = r.json()
        return person

    # ---------- staff API
    async def create_staff(self, actor: Actor, email: str, role: str, name: str = "Сотрудник",
                           **headers: str) -> httpx.Response:
        return await self.c.post("/admin/v1/staff", json={"email": email, "display_name": name, "role": role},
                                 headers=self.h(actor, **headers))

    async def onboard(self, actor: Actor, email: str, role: str, name: str = "Сотрудник") -> Person:
        r = await self.create_staff(actor, email, role, name)
        assert r.status_code == 201, r.text
        temp = r.json()["temporary_password"]
        assert temp
        return await self.first_login(email, temp)

    async def patch(self, actor: Actor, staff_id: str, body: dict[str, Any]) -> httpx.Response:
        return await self.c.patch(f"/admin/v1/staff/{staff_id}", json=body, headers=self.h(actor))

    async def approve(self, actor: Actor, approval_id: str, note: str | None = None,
                      action: str = "approve") -> httpx.Response:
        return await self.c.post(f"/admin/v1/approvals/{approval_id}/{action}", json={"note": note},
                                 headers=self.h(actor))


def new_email(prefix: str = "staff") -> str:
    return f"{prefix}.{uuid.uuid4().hex[:8]}@tilhero.test"
