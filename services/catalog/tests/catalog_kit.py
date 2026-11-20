"""Набор для тестов catalog: сотрудники, ученики, тела контента (из сида migrations/seed), сквозные помощники."""

from __future__ import annotations

import copy
import json
import uuid
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import asyncpg
import httpx
from sqlalchemy.engine import make_url

from tilhero_catalog.content import KEY_FIELDS
from tilhero_catalog.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.internal_auth import HEADER, Actor, issue_token
from tilhero_common.messaging import Envelope, InMemoryBus
from tilhero_common.testing import TEST_ADMIN_URL, internal_headers

# Маленький собственный сид тестов (полный сид методистов — migrations/seed, его проверяет test_catalog_seed.py)
SEED_DIR = Path(__file__).resolve().parent / "fixtures" / "seed"


def _actor(role: str, *perms: str) -> Actor:
    return Actor(id=str(uuid.uuid4()), role=role, permissions=frozenset(perms))


# PLAN «Права и роли»: content_manager — read/edit/media.rights/dashboard; methodist — read/edit/review/publish
CONTENT_MANAGER = _actor("content_manager", "content.read", "content.edit", "media.rights", "dashboard.read")
EDITOR2 = _actor("content_manager", "content.read", "content.edit")
METHODIST = _actor("methodist", "content.read", "content.edit", "content.review", "content.publish")
REVIEWER = _actor("methodist", "content.read", "content.review")
PUBLISHER = _actor("methodist", "content.read", "content.publish")
RIGHTS = _actor("content_manager", "content.read", "media.rights")
LANG = _actor("super_admin", "content.read", "lang.manage")
READER = _actor("analyst", "content.read")
DASHBOARD = _actor("analyst", "dashboard.read")
SUPPORT = _actor("support", "support.reply", "users.read")
# спринт 5: словарь курса — methodist и content_manager (glossary.manage)
GLOSSARIST = _actor("methodist", "content.read", "glossary.manage")
GLOSSARIST2 = _actor("content_manager", "content.read", "content.edit", "glossary.manage")


def seed(kind: str, key: str) -> dict[str, Any]:
    """Тело из сида миграции 0003 (копия) — основа валидных тел тестов."""
    name = {"course": "course", "skill": "skills", "module": "modules", "lesson": "lessons", "rubric": "rubrics",
            "scenario": "scenarios", "media_asset": "media", "reading": "readings"}[kind]
    data = json.loads((SEED_DIR / f"{name}.json").read_text(encoding="utf-8"))
    items = data if isinstance(data, list) else [data]
    for item in items:
        if item[KEY_FIELDS[kind]] == key:
            return copy.deepcopy(item)
    raise KeyError(key)


def L(ru: str, uz: str) -> dict[str, str]:
    return {"ru": ru, "uz": uz}


def skill(skill_id: str, *, prerequisites: list[str] | None = None, course: str = "en-core",
          level: str = "A1") -> dict[str, Any]:
    p = seed("skill", "en.func.order-drink")
    p.update(skill_id=skill_id, course_id=course, prerequisites=prerequisites or [], level=level,
             diagnostic_tags=[skill_id.removeprefix("en.")])
    return p


def rubric(rubric_id: str) -> dict[str, Any]:
    p = seed("rubric", "r-lesson-core")
    p["rubric_id"] = rubric_id
    return p


def lesson(lesson_id: str, *, module_id: str = "m1-meet", scenario_id: str | None = None,
           audience: list[str] | None = None) -> dict[str, Any]:
    p = seed("lesson", "l-01-greetings")
    p.update(lesson_id=lesson_id, module_id=module_id, scenario_id=scenario_id)
    if audience is not None:
        p["audience"] = audience
    return p


def scenario(scenario_id: str, *, audience: list[str] | None = None) -> dict[str, Any]:
    p = seed("scenario", "sc-cafe-coffee")
    p["scenario_id"] = scenario_id
    if audience is not None:
        p["audience"] = audience
    return p


def media(asset_id: str, **rights: Any) -> dict[str, Any]:
    p = seed("media_asset", "m-own-coffee-order")
    p["asset_id"] = asset_id
    p["rights"].update(rights)
    return p


def exercise(exercise_id: str, *, asset_id: str = "m-own-coffee-order", kind: str = "comprehension") -> dict[str, Any]:
    base: dict[str, Any] = {
        "exercise_id": exercise_id, "asset_id": asset_id, "type": kind, "skill_id": "en.func.order-drink",
        "level": "A1", "instruction": L("Ответьте на вопрос", "Savolga javob bering"),
        "prompt_en": "What does Tim order?", "options": ["A hot chocolate", "A tea", "A juice"], "answer": 0,
        "line_index": None, "rubric_id": "r-lesson-core",
    }
    return base


def reading(reading_id: str, *, kids: bool = False, **changes: Any) -> dict[str, Any]:
    """Текст для чтения из фикстуры сида (r-a1-coffee-shop или детский r-a0-my-cat) с новым ключом."""
    p = seed("reading", "r-a0-my-cat" if kids else "r-a1-coffee-shop")
    p["reading_id"] = reading_id
    p.update(changes)
    return p


def module(module_id: str, lesson_ids: list[str]) -> dict[str, Any]:
    p = seed("module", "m1-meet")
    p.update(module_id=module_id, lesson_ids=lesson_ids)
    return p


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime, bus: InMemoryBus,
                 schema: str) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus
        self.schema = schema

    # ---------------------------------------------------------------- заголовки

    def h(self, actor: Actor | None = None, issuer: str = "admin-bff", **extra: str) -> dict[str, str]:
        return {**internal_headers(self.settings, issuer=issuer, actor=actor), **extra}

    def svc(self, issuer: str = "telegram-bff", subject: str | None = None, **claims: Any) -> dict[str, str]:
        token = issue_token(self.settings.internal_jwt_secret.get_secret_value(), issuer=issuer,
                            audience=self.settings.service_name, subject=subject, extra=claims or None)
        return {HEADER: token}

    def learner(self, user_id: uuid.UUID | str, **claims: Any) -> dict[str, str]:
        return self.svc("telegram-bff", str(user_id), **claims)

    def memory(self, user_id: uuid.UUID | str | None = None, **claims: Any) -> dict[str, str]:
        """Вызывающий memory (спринт 5): словарь курса, версии, проверки удержания."""
        return self.svc("memory", str(user_id or uuid.uuid4()), **claims)

    def set_today(self, day: date) -> None:
        """«Сегодня» сервиса (11:00 по Ташкенту выбранного дня)."""
        self.runtime.clock = lambda: datetime(day.year, day.month, day.day, 6, 0, tzinfo=UTC)  # type: ignore[attr-defined]

    def scheduler(self, token: str | None = None) -> dict[str, str]:
        return {"Authorization": f"Bearer {token or self.settings.scheduler_token.get_secret_value()}"}

    # ---------------------------------------------------------------- события и БД

    async def flush(self) -> None:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    def events(self, event_type: str) -> list[Envelope]:
        return self.bus.of_type(event_type)

    async def audit(self, action: str) -> list[dict[str, Any]]:
        await self.flush()
        return [e.payload for e in self.events("admin.audit.recorded.v1") if e.payload["action"] == action]

    async def sql(self, query: str, *args: Any) -> list[asyncpg.Record]:
        url = make_url(TEST_ADMIN_URL).set(drivername="postgresql").render_as_string(hide_password=False)
        conn = await asyncpg.connect(url, server_settings={"search_path": self.schema})
        try:
            return await conn.fetch(query, *args)
        finally:
            await conn.close()

    # ---------------------------------------------------------------- контент

    def url(self, kind: str, key: str | None = None, version: int | None = None, action: str | None = None) -> str:
        out = f"/admin/v1/content/{kind}"
        if key is not None:
            out += f"/{key}"
        if version is not None:
            out += f"/versions/{version}"
        if action is not None:
            out += f"/{action}"
        return out

    async def create(self, kind: str, payload: dict[str, Any], actor: Actor = CONTENT_MANAGER,
                     **headers: str) -> httpx.Response:
        return await self.c.post(self.url(kind), json={"payload": payload}, headers=self.h(actor, **headers))

    async def act(self, kind: str, key: str, version: int, action: str, actor: Actor,
                  body: dict[str, Any] | None = None, **headers: str) -> httpx.Response:
        return await self.c.post(self.url(kind, key, version, action), json=body,
                                 headers=self.h(actor, **headers))

    async def submit(self, kind: str, key: str, version: int, actor: Actor = CONTENT_MANAGER) -> httpx.Response:
        return await self.act(kind, key, version, "submit", actor)

    async def approve(self, kind: str, key: str, version: int, actor: Actor = REVIEWER) -> httpx.Response:
        return await self.act(kind, key, version, "review", actor,
                              {"decision": "approve", "note": "Проверено методистом",
                               "locale_checks": {"ru": "checked", "uz": "checked"}})

    async def publish(self, kind: str, key: str, version: int, actor: Actor = PUBLISHER,
                      **headers: str) -> httpx.Response:
        return await self.act(kind, key, version, "publish", actor, {"reason": "Публикация в тесте"}, **headers)

    async def to_approved(self, kind: str, payload: dict[str, Any], *, version: int | None = None,
                          author: Actor = CONTENT_MANAGER) -> int:
        """Черновик (новый ключ или новая версия) → на проверке → одобрен (+ прогон / права). Возвращает версию."""
        key = payload[KEY_FIELDS[kind]]
        if version is None:
            r = await self.create(kind, payload, author)
            assert r.status_code == 201, r.text
            version = int(r.json()["version"])
        if kind == "scenario":
            r = await self.act(kind, key, version, "test-run", author)
            assert r.status_code == 200 and r.json()["ok"], r.text
        if kind == "media_asset":
            r = await self.act(kind, key, version, "rights-approve", RIGHTS, {"note": "Права проверены"})
            assert r.status_code == 200, r.text
        r = await self.submit(kind, key, version, author)
        assert r.status_code == 200, r.text
        r = await self.approve(kind, key, version)
        assert r.status_code == 200, r.text
        return version

    async def published_new(self, kind: str, payload: dict[str, Any], author: Actor = CONTENT_MANAGER) -> int:
        version = await self.to_approved(kind, payload, author=author)
        r = await self.publish(kind, payload[KEY_FIELDS[kind]], version)
        assert r.status_code == 200, r.text
        return version

    async def new_version(self, kind: str, key: str, from_version: int,
                          actor: Actor = CONTENT_MANAGER) -> httpx.Response:
        return await self.c.post(self.url(kind, key) + "/versions", json={"from_version": from_version},
                                 headers=self.h(actor))

    async def put(self, kind: str, key: str, version: int, payload: dict[str, Any], expected_hash: str,
                  actor: Actor = CONTENT_MANAGER) -> httpx.Response:
        return await self.c.put(self.url(kind, key, version), json={"payload": payload,
                                                                    "expected_hash": expected_hash},
                                headers=self.h(actor))

    async def get_version(self, kind: str, key: str, version: int) -> dict[str, Any]:
        r = await self.c.get(self.url(kind, key, version), headers=self.h(READER))
        assert r.status_code == 200, r.text
        return dict(r.json())

    async def edit_published(self, kind: str, key: str, from_version: int, change: dict[str, Any],
                             author: Actor = CONTENT_MANAGER) -> int:
        """Новая версия из опубликованной с правкой полей → одобрена; возвращает её номер."""
        r = await self.new_version(kind, key, from_version, author)
        assert r.status_code == 201, r.text
        v = r.json()
        payload = {**v["payload"], **change}
        r = await self.put(kind, key, v["version"], payload, v["payload_hash"], author)
        assert r.status_code == 200, r.text
        return await self.to_approved(kind, payload, version=v["version"], author=author)


def codes(response: httpx.Response) -> list[str]:
    return [e["code"] for e in response.json()["details"]["errors"]]


def paths(response: httpx.Response, code: str) -> list[str]:
    return [e["path"] for e in response.json()["details"]["errors"] if e["code"] == code]
