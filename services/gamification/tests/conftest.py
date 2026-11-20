from __future__ import annotations

import copy
import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import text

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import HEADER, Actor, issue_token
from tilhero_common.messaging import ConsumerSpec, Envelope, InMemoryBus, make_envelope
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    TEST_REDIS_URL,
    assert_event_conforms,
    create_schema,
    drop_schema,
    migrate,
    unique_schema,
)
from tilhero_gamification.main import build_app
from tilhero_gamification.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
# 10:00 в Ташкенте (UTC+5)
T0 = datetime(2026, 11, 20, 5, 0, tzinfo=UTC)
SCHEDULER_TOKEN = "s" * 40
ALL_PERMS = ("game.read", "game.manage", "game.publish", "wallet.adjust")
AUDIENCE_ALL = ("kids", "teens", "adults")


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {"env": "test", "internal_jwt_secret": "t" * 40, "scheduler_token": SCHEDULER_TOKEN,
                            "redis_url": TEST_REDIS_URL}
    base.update(kw)
    return Settings(**base)


class RecordingBus(InMemoryBus):
    """Шина в памяти, которая запоминает исключения обработчиков (InMemoryBus прячет их в DLQ)."""

    def __init__(self) -> None:
        super().__init__()
        self.errors: list[BaseException] = []

    async def subscribe(self, spec: ConsumerSpec) -> None:
        orig = spec.handler

        async def handler(env: Envelope) -> None:
            try:
                await orig(env)
            except Exception as exc:
                self.errors.append(exc)
                raise

        spec.handler = handler
        await super().subscribe(spec)


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime, bus: RecordingBus,
                 app: Any) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus
        self.app = app
        self.now = T0

        def clock() -> datetime:
            # каждое обращение — +1 мс: порядок операций разных запросов детерминирован
            self.now += timedelta(milliseconds=1)
            return self.now

        runtime.clock = clock  # type: ignore[attr-defined]

    @property
    def today(self) -> date:
        return (self.now + timedelta(hours=5)).date()

    # ---------- заголовки
    def h(self, user: uuid.UUID, *, age_band: str | None = "18+", account: uuid.UUID | None = None,
          issuer: str = "telegram-bff") -> dict[str, str]:
        extra: dict[str, Any] = {"lrn": str(user)}
        if age_band:
            extra["age_band"] = age_band
        token = issue_token(self.settings.internal_jwt_secret.get_secret_value(), issuer=issuer,
                            audience="gamification", subject=str(account or user), extra=extra)
        return {HEADER: token}

    def svc(self, issuer: str = "telegram-bff") -> dict[str, str]:
        token = issue_token(self.settings.internal_jwt_secret.get_secret_value(), issuer=issuer,
                            audience="gamification")
        return {HEADER: token}

    def staff(self, *perms: str, step_up: bool = True, issuer: str = "admin-bff", actor: bool = True,
              staff_id: str | None = None) -> dict[str, str]:
        a = Actor(id=staff_id or str(uuid.uuid4()), role="operations", permissions=frozenset(perms or ALL_PERMS),
                  name="Оператор")
        token = issue_token(self.settings.internal_jwt_secret.get_secret_value(), issuer=issuer,
                            audience="gamification", actor=a if actor else None)
        out = {HEADER: token}
        if step_up:
            out["X-Step-Up"] = "ok"
        return out

    # ---------- события и данные
    async def flush(self) -> None:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    async def events(self, event_type: str, user: uuid.UUID | None = None) -> list[Envelope]:
        await self.flush()
        found = [e for e in self.bus.of_type(event_type) if user is None or e.payload.get("user_id") == str(user)]
        for e in found:
            assert_event_conforms(e)
            assert e.producer == "gamification"
        return found

    async def publish(self, event_type: str, payload: dict[str, Any], producer: str,
                      env: Envelope | None = None) -> Envelope:
        self.now += timedelta(seconds=1)  # порядок операций разных событий
        e = env or make_envelope(event_type, payload, producer=producer)
        assert_event_conforms(e)
        before = len(self.bus.errors)
        await self.bus.publish(e)
        if len(self.bus.errors) > before:
            raise self.bus.errors[-1]
        await self.flush()
        return e

    async def sql(self, stmt: str, **params: Any) -> Any:
        async with self.runtime.transaction() as s:
            result = await s.execute(text(stmt), params)
            return result.all() if result.returns_rows else None

    async def tick(self, expect: int = 200) -> dict[str, Any]:
        r = await self.c.post("/internal/v1/game:tick", headers={"Authorization": f"Bearer {SCHEDULER_TOKEN}"})
        assert r.status_code == expect, r.text
        return dict(r.json())

    # ---------- события учёбы
    def ts(self) -> str:
        return self.now.isoformat().replace("+00:00", "Z")

    async def lesson(self, user: uuid.UUID, kind: str = "lesson", *, status: str = "completed",
                     passed: bool | None = None, practice_only: bool = False, session_id: uuid.UUID | None = None,
                     env: Envelope | None = None, evaluation_id: uuid.UUID | None = None,
                     finished_at: datetime | None = None) -> uuid.UUID:
        sid = session_id or uuid.uuid4()
        await self.publish("lesson.session.completed.v1", {
            "session_id": str(sid), "user_id": str(user), "kind": kind, "pair_id": "ru-en",
            "lesson_id": "l-01" if kind == "lesson" else None, "scenario_id": None, "asset_id": None,
            "status": status, "outcome": None, "minutes": 12, "local_date": self.today.isoformat(),
            "evaluation_id": str(evaluation_id) if evaluation_id else None, "passed": passed,
            "practice_only": practice_only,
            "finished_at": (finished_at or self.now).isoformat().replace("+00:00", "Z")},
            "lessons", env=env)
        return sid

    async def review(self, user: uuid.UUID, reviewed: int = 10, correct: int = 8, *, status: str = "completed",
                     session_id: uuid.UUID | None = None) -> uuid.UUID:
        sid = session_id or uuid.uuid4()
        await self.publish("memory.review.completed.v1", {
            "session_id": str(sid), "user_id": str(user), "pair_id": "ru-en", "status": status, "minutes": 5,
            "reviewed": reviewed, "correct": correct, "finished_at": self.ts()}, "memory")
        return sid

    async def skills(self, user: uuid.UUID, changes: list[tuple[str, str, str]], source: str = "lesson",
                     *, occurred_at: datetime | None = None, evidence: uuid.UUID | None = None) -> Envelope:
        extra = {"evidence_id": str(evidence)} if evidence else {}
        return await self.publish("skills.state.changed.v1", {
            "user_id": str(user), "pair_id": "ru-en",
            "occurred_at": (occurred_at or self.now).isoformat().replace("+00:00", "Z"),
            "changes": [{"skill_id": s, "from": f, "to": t, "source": source, **extra} for s, f, t in changes]},
            "diagnostics")

    async def demonstrate(self, user: uuid.UUID, n: int, start: int = 0, source: str = "lesson") -> None:
        await self.skills(user, [(f"en.skill.{i}", "learning", "demonstrated") for i in range(start, start + n)],
                          source)

    async def profile(self, user: uuid.UUID, kind: str = "account", age_band: str | None = "18+",
                      guardian: uuid.UUID | None = None) -> None:
        await self.publish("user.profile.created.v1", {
            "user_id": str(user), "kind": kind, "locale": "ru", "age_band": age_band,
            "guardian_user_id": str(guardian) if guardian else None, "created_at": self.ts()}, "identity-consent")

    async def invite(self, inviter: uuid.UUID, invitee: uuid.UUID, kind: str = "referral") -> None:
        await self.publish("social.invite.accepted.v1", {
            "invite_id": str(uuid.uuid4()), "inviter_user_id": str(inviter), "invitee_user_id": str(invitee),
            "kind": kind, "accepted_at": self.ts()}, "social")

    async def missed(self, user: uuid.UUID, day: date | None = None, producer: str = "learning-plan") -> Envelope:
        d = day or (self.today - timedelta(days=1))
        return await self.publish("learning.session.missed.v1", {
            "user_id": str(user), "local_date": d.isoformat(), "slot_time": "19:00", "timezone": "Asia/Tashkent",
            "consecutive_missed": 1, "next_slot_date": None}, producer)

    async def activity(self, user: uuid.UUID, streak: int | None) -> None:
        await self.publish("learning.activity.recorded.v1", {
            "user_id": str(user), "activity_id": str(uuid.uuid4()), "local_date": self.today.isoformat(),
            "kind": "lesson", "minutes": 10, "recorded_at": self.ts(), "streak_days": streak}, "learning-plan")

    async def plan(self, user: uuid.UUID, tz: str = "Asia/Tashkent") -> None:
        await self.publish("learning.plan.updated.v1", {
            "user_id": str(user), "changed_fields": ["timezone"], "goal": None, "ui_lang": "ru",
            "course_pair": "ru-en", "timezone": tz, "days": [1, 2, 3, 4, 5, 6, 7], "preferred_time": "19:00",
            "duration_min": 20, "reminders_enabled": True, "onboarding_completed": True, "level_self": None,
            "preset": "daily"}, "learning-plan")

    # ---------- API ученика
    async def get(self, user: uuid.UUID, path: str, expect: int = 200, params: dict[str, Any] | None = None,
                  **hk: Any) -> Any:
        r = await self.c.get(f"/internal/v1/game/{path}", headers=self.h(user, **hk), params=params)
        assert r.status_code == expect, r.text
        return r.json()

    async def send(self, method: str, user: uuid.UUID, path: str, body: Any = None, expect: int = 200, *,
                   key: str | None = None, **hk: Any) -> Any:
        headers = self.h(user, **hk)
        if key is not None:
            headers["Idempotency-Key"] = key
        r = await self.c.request(method, f"/internal/v1/game/{path}", json=body, headers=headers)
        assert r.status_code == expect, r.text
        return r.json() if r.content else None

    async def buy(self, user: uuid.UUID, item: str, expect: int = 201, key: str | None = None, **hk: Any) -> Any:
        return await self.send("POST", user, "purchases", {"item_code": item}, expect,
                               key=key or f"k-{uuid.uuid4()}", **hk)

    async def wallet(self, user: uuid.UUID) -> dict[str, int]:
        rows = await self.sql("SELECT xp_total, til_balance, freeze_stock, level FROM wallets WHERE user_id = :u",
                              u=user)
        if not rows:
            return {"xp": 0, "til": 0, "freeze": 0, "level": 1}
        xp, til, fr, lvl = rows[0]
        return {"xp": int(xp), "til": int(til), "freeze": int(fr), "level": int(lvl)}

    async def ops(self, user: uuid.UUID, *, bonus: bool = False) -> list[Any]:
        """Операции ученика по порядку; bonus=False — без бонуса регистрации (он выдаётся при первом ходе)."""
        rows = await self.sql("SELECT currency, amount, reason, capped, multiplier, rules_version, status, "
                              "idempotency_key, op_id FROM ledger WHERE user_id = :u ORDER BY created_at, op_id",
                              u=user)
        return [r for r in rows if bonus or r.reason != "registration_bonus"]

    async def grant(self, user: uuid.UUID, currency: str, amount: int) -> dict[str, Any]:
        """Ручное начисление сотрудником (для подготовки баланса)."""
        await self.ensure(user)
        r = await self.c.post(f"/internal/v1/admin/game/wallets/{user}/adjustments",
                              json={"currency": currency, "amount": amount, "reason": "подготовка теста"},
                              headers={**self.staff(), "Idempotency-Key": f"k-{uuid.uuid4()}"})
        assert r.status_code == 201, r.text
        return dict(r.json())

    async def ensure(self, user: uuid.UUID, **hk: Any) -> None:
        await self.get(user, "settings", **hk)

    # ---------- правила и события недели через админ-API
    async def active_rules(self) -> dict[str, Any]:
        items = (await self.adm("GET", "rules"))["items"]
        [active] = [v for v in items if v["status"] == "active"]
        return dict(await self.adm("GET", f"rules/{active['version']}"))

    async def activate(self, mutate: Callable[[dict[str, Any]], None]) -> int:
        """Черновик из активной версии → mutate → проверка → активация; → номер новой активной версии."""
        active = await self.active_rules()
        payload = copy.deepcopy(active["payload"])
        mutate(payload)
        await self.adm("PUT", "rules/draft", {"payload": payload, "comment": "тест", "based_on": active["version"]})
        check = await self.adm("POST", "rules/draft/validate")
        assert check["ok"], check
        out = await self.adm("POST", "rules/draft/activate", {"comment": "тестовая активация правил"})
        return int(out["version"])

    async def week_event(self, multipliers: list[dict[str, Any]], *, audiences: tuple[str, ...] = AUDIENCE_ALL,
                         code: str | None = None, days: int = 7) -> dict[str, Any]:
        """Опубликованное событие недели, начавшееся (часы сдвигаются на 2 минуты вперёд)."""
        starts = self.now + timedelta(minutes=1)
        ev = await self.adm("POST", "events", {
            "code": code or f"ev_{uuid.uuid4().hex[:8]}", "title": {"ru": "Неделя", "uz": "Hafta"},
            "description": {"ru": "Больше опыта", "uz": "Koʻproq tajriba"},
            "starts_at": starts.isoformat(), "ends_at": (starts + timedelta(days=days)).isoformat(),
            "audiences": list(audiences), "multipliers": multipliers}, 201, key=f"k-{uuid.uuid4()}")
        ev = await self.adm("POST", f"events/{ev['event_id']}/publish", {"comment": None})
        self.now += timedelta(minutes=2)
        return dict(ev)

    # ---------- админ-API
    async def adm(self, method: str, path: str, body: Any = None, expect: int = 200, *, perms: tuple[str, ...] = (),
                  step_up: bool = True, key: str | None = None, headers: dict[str, str] | None = None,
                  staff_id: str | None = None) -> Any:
        h = self.staff(*perms, step_up=step_up, staff_id=staff_id)
        if key is not None:
            h["Idempotency-Key"] = key
        h.update(headers or {})
        r = await self.c.request(method, f"/internal/v1/admin/game/{path}", json=body, headers=h)
        assert r.status_code == expect, r.text
        return r.json() if r.content and r.headers.get("content-type", "").startswith("application/json") else None


@pytest.fixture
async def env():
    schema = unique_schema("game")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    await migrate(SERVICE_DIR, settings)
    bus = RecordingBus()
    runtime = Runtime(settings, bus=bus)
    app = build_app(settings, runtime)
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gamification")
        e = Env(settings, client, runtime, bus, app)
        await e.flush()
        yield e
        await client.aclose()
        assert bus.dlq == [], bus.dlq
    await drop_schema(schema)


@pytest.fixture
def user() -> uuid.UUID:
    return uuid.uuid4()


__all__ = ["ALL_PERMS", "T0", "Env", "make_settings"]
