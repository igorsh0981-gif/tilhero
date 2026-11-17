from __future__ import annotations

import asyncio
import itertools
import uuid
from typing import Any

import pytest
from exp_actors import EDITOR, PUBLISHER, READER, SUPPORT
from sqlalchemy import text

from tilhero_common.internal_auth import issue_token
from tilhero_common.testing import assert_event_conforms

BASE = "/admin/v1/experience"


def new_version(payload: dict[str, Any], version: str = "2.0.4", note: str = "Тест: новая тема") -> dict:
    return {"version": version, "payload": payload, "change_note": note}


# ---------------------------------------------------------------- GET current


async def test_current_miniapp_is_seeded_dark_premium(env) -> None:
    r = await env.current("miniapp")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
    cfg = r.json()
    assert cfg["app"] == "miniapp" and cfg["version"] == "2.0.3"
    assert cfg["theme"]["id"] == "default" and cfg["theme"]["version"] == "2.0.3"
    assert cfg["theme"]["tokens"]["--accent"] == "#DFFF56" and cfg["theme"]["tokens"]["--bg"] == "#090C16"
    assert cfg["home"] == {"welcome_mode": "first_visit_only", "sections": [
        {"type": "event_carousel", "key": "best_for_you", "variant": "large", "enabled": True},
        {"type": "watch_changes", "key": "watch", "variant": "compact", "enabled": True},
        {"type": "event_carousel", "key": "sales_soon", "variant": "compact", "enabled": True},
        {"type": "news_carousel", "key": "news", "variant": "compact", "enabled": True},
    ]}
    assert set(cfg["flags"]) == {"ai_concierge", "group_trip", "calendar_export", "premium_teaser"}
    assert 7.0 <= cfg["hotel_rating_min"] <= 10.0
    # форма = ExperienceConfig из bff.ts (без лишних полей)
    assert set(cfg) == {"app", "version", "theme", "home", "flags", "hotel_rating_min"}
    admin = await env.current("admin", issuer="admin-bff")
    assert admin.status_code == 200 and admin.json()["version"] == "1.0.0"
    assert admin.json()["layout"]["density"] == "compact"


async def test_seed_history(env) -> None:
    state = (await env.c.get(f"{BASE}/miniapp/state", headers=env.h(READER))).json()
    assert state["current"]["version"] == "2.0.3" and state["previous_version"] == "2.0.2"
    prev = await env.seed_payload("miniapp", "2.0.2")
    assert prev["theme"]["tokens"]["--accent"] == "#8EF5C2"  # мятный акцент
    assert prev["theme"]["tokens"]["--r-card"] == "14px"
    versions = (await env.c.get(f"{BASE}/miniapp/versions", headers=env.h(READER))).json()
    assert [(v["version"], v["status"]) for v in versions["items"]] == [
        ("2.0.3", "current"), ("2.0.2", "previous")]
    assert all(len(v["checksum"]) == 64 for v in versions["items"])
    acts = (await env.c.get(f"{BASE}/miniapp/activations", headers=env.h(READER))).json()["items"]
    assert [(a["version"], a["previous_version"]) for a in acts] == [("2.0.3", "2.0.2"), ("2.0.2", None)]
    admin_state = (await env.c.get(f"{BASE}/admin/state", headers=env.h(READER))).json()
    assert admin_state["current"]["version"] == "1.0.0" and admin_state["previous_version"] is None


async def test_current_auth_and_errors(env) -> None:
    path = "/internal/v1/experience/miniapp/current"
    assert (await env.c.get(path)).status_code == 401
    forged = issue_token("x" * 40, issuer="telegram-bff", audience="experience-config")
    bad = await env.c.get(path, headers={"x-internal-token": forged})
    assert bad.status_code == 401 and bad.json()["code"] == "INTERNAL_TOKEN_INVALID"
    wrong_aud = issue_token("t" * 40, issuer="telegram-bff", audience="preferences")
    assert (await env.c.get(path, headers={"x-internal-token": wrong_aud})).status_code == 401
    other = await env.current("miniapp", issuer="support")
    assert other.status_code == 403 and other.json()["code"] == "CALLER_NOT_ALLOWED"
    unknown = await env.current("bank")
    assert unknown.status_code == 404 and unknown.json()["code"] == "EXPERIENCE_APP_UNKNOWN"


async def test_offers_reads_miniapp_current_only(env) -> None:
    """Спринт 5 (INTERNAL_API §3): offers читает текущую конфигурацию Mini App (порог рейтинга отеля), но не
    служебные маршруты админки."""
    r = await env.current("miniapp", issuer="offers")
    assert r.status_code == 200 and isinstance(r.json()["hotel_rating_min"], int | float)
    staff = await env.c.get(f"{BASE}/miniapp/versions", headers=env.h(PUBLISHER, issuer="offers"))
    assert staff.status_code == 403 and staff.json()["code"] == "CALLER_NOT_ALLOWED"
    admin_current = await env.current("admin", issuer="offers")
    assert admin_current.status_code == 403 and admin_current.json()["code"] == "CALLER_NOT_ALLOWED"
    for issuer in ("telegram-bff", "admin-bff"):  # прежние читатели конфигурации админки — без изменений
        assert (await env.current("admin", issuer=issuer)).status_code == 200


async def test_current_cache_and_invalidation(env) -> None:
    first = await env.current()
    assert first.headers["x-cache"] == "miss"
    second = await env.current()
    assert second.headers["x-cache"] == "hit" and second.json() == first.json()
    ttl = await env.runtime.redis.ttl(f"{env.settings.cache_namespace}:current:miniapp")
    assert 0 < ttl <= 60
    # изменение в БД в обход API не видно, пока жив кэш (60 с)
    async with env.runtime.transaction() as s:
        await s.execute(text(
            "INSERT INTO activations (id, app, version, previous_version, kind, reason, activated_by) "
            "VALUES (:id, 'miniapp', '2.0.2', '2.0.3', 'rollback', 'db', 'dba')"), {"id": uuid.uuid4()})
    assert (await env.current()).json()["version"] == "2.0.3"
    # активация через API сразу обновляет кэш
    r = await env.c.post(f"{BASE}/miniapp/activate", json={"version": "2.0.3", "reason": "Вернуть премиум"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 201
    after = await env.current()
    assert after.headers["x-cache"] == "hit" and after.json()["version"] == "2.0.3"
    rb = await env.c.post(f"{BASE}/miniapp/rollback", json={"reason": "Демо отката"},
                          headers=env.h(PUBLISHER))
    assert rb.status_code == 201 and rb.json()["version"] == "2.0.2"
    assert (await env.current()).json()["theme"]["tokens"]["--accent"] == "#8EF5C2"


async def test_cache_never_goes_back_in_time(env) -> None:
    """Запоздавший читатель/публикатор со старой активацией не затирает в кэше более новую."""
    from tilhero_experience.api.common import cache_of

    cache = cache_of(env.runtime)
    assert await cache.put("miniapp", 10, '{"version":"new"}') is True
    assert await cache.put("miniapp", 9, '{"version":"stale"}') is False
    assert await cache.put("miniapp", 10, '{"version":"same-seq"}') is False
    assert await cache.get("miniapp") == '{"version":"new"}'
    raw = await env.runtime.redis.get(cache.key("miniapp"))
    assert raw == '10|{"version":"new"}'
    # повреждённое значение — промах, ответ из БД
    await env.runtime.redis.set(cache.key("miniapp"), "garbage", ex=60)
    r = await env.current()
    assert r.headers["x-cache"] == "miss" and r.json()["version"] == "2.0.3"


async def test_current_works_without_cache(env) -> None:
    await env.runtime.redis.delete(f"{env.settings.cache_namespace}:current:admin")
    redis = env.runtime.redis
    env.runtime.redis = None  # Redis недоступен — читаем из БД
    try:
        r = await env.current("admin", issuer="admin-bff")
        assert r.status_code == 200 and r.json()["version"] == "1.0.0"
    finally:
        env.runtime.redis = redis


# ---------------------------------------------------------------- версии


async def test_create_version_happy_and_immutable(env) -> None:
    payload = await env.seed_payload()
    payload["theme"]["version"] = "2.0.4"
    payload["theme"]["tokens"]["--r-card"] = "18px"
    payload["home"]["sections"].reverse()
    payload["flags"]["calendar_export"] = True
    r = await env.c.post(f"{BASE}/miniapp/versions", json=new_version(payload), headers=env.h(EDITOR))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["version"] == "2.0.4" and body["status"] is None and body["created_by"] == EDITOR.id
    assert body["payload"]["theme"]["tokens"]["--r-card"] == "18px"
    # повтор того же запроса — тот же результат, без второй версии
    again = await env.c.post(f"{BASE}/miniapp/versions", json=new_version(payload), headers=env.h(EDITOR))
    assert again.status_code == 201 and again.json()["version_id"] == body["version_id"]
    # та же версия с другим содержимым — неизменяема
    payload["theme"]["tokens"]["--r-card"] = "20px"
    changed = await env.c.post(f"{BASE}/miniapp/versions", json=new_version(payload), headers=env.h(EDITOR))
    assert changed.status_code == 409 and changed.json()["code"] == "EXPERIENCE_VERSION_EXISTS"
    seeded = await env.c.post(f"{BASE}/miniapp/versions", json=new_version(payload, version="2.0.3"),
                              headers=env.h(EDITOR))
    assert seeded.status_code == 409
    # БД не даёт изменить или удалить версию даже в обход API
    for sql in ("UPDATE config_versions SET change_note = 'x'", "DELETE FROM config_versions",
                "UPDATE activations SET reason = 'x'", "DELETE FROM activations", "TRUNCATE activations"):
        with pytest.raises(Exception, match="append-only"):
            async with env.runtime.transaction() as s:
                await s.execute(text(sql))
    # создание версии не меняет текущую
    assert (await env.current()).json()["version"] == "2.0.3"
    await env.flush()
    audits = env.events("admin.audit.recorded.v1")
    assert len(audits) == 1 and audits[0].payload["action"] == "config.create"
    assert audits[0].payload["object_id"] == "miniapp@2.0.4"
    assert audits[0].payload["reason"] == "Тест: новая тема"
    assert_event_conforms(audits[0])


INVALID: list[tuple[str, Any, str, str]] = [
    ("tokens url()", ("theme", "tokens", "--accent", "url(https://evil.example/a.png)"),
     "payload.theme.tokens.--accent", "forbidden_construct"),
    ("tokens expression()", ("theme", "tokens", "--bg", "expression(alert(document.cookie))"),
     "payload.theme.tokens.--bg", "forbidden_construct"),
    ("tokens javascript:", ("theme", "tokens", "--focus", "javascript:alert(1)"),
     "payload.theme.tokens.--focus", "forbidden_construct"),
    ("tokens css injection", ("theme", "tokens", "--ink", "#fff;}body{background:url(x)"),
     "payload.theme.tokens.--ink", "forbidden_construct"),
    ("unknown token", ("theme", "tokens", "--custom-css", "#fff"), "payload.theme.tokens.--custom-css",
     "unknown_token"),
    ("bad color", ("theme", "tokens", "--accent", "lime"), "payload.theme.tokens.--accent", "invalid_color"),
    ("bad length", ("theme", "tokens", "--r-card", "22"), "payload.theme.tokens.--r-card", "invalid_length"),
    ("radius range", ("theme", "tokens", "--r-card", "120px"), "payload.theme.tokens.--r-card",
     "out_of_range"),
    ("bad font", ("theme", "tokens", "--font-body", '"Papyrus"'), "payload.theme.tokens.--font-body",
     "invalid_font"),
    ("rail percent", ("theme", "tokens", "--rail-w", "86%"), "payload.theme.tokens.--rail-w",
     "invalid_number"),
    ("theme id", ("theme", "id", "neon"), "payload.theme.id", "not_allowed"),
    ("css_url", ("theme", "css_url", "https://static.example/default.css"), "payload.theme.css_url",
     "unknown_field"),
    ("theme version", ("theme", "version", "2.0"), "payload.theme.version", "invalid_format"),
    ("welcome", ("home", "welcome_mode", "sometimes"), "payload.home.welcome_mode", "not_allowed"),
    ("hotel low", ("hotel_rating_min", None, None, 6.9), "payload.hotel_rating_min", "out_of_range"),
    ("hotel high", ("hotel_rating_min", None, None, 10.5), "payload.hotel_rating_min", "out_of_range"),
    ("hotel str", ("hotel_rating_min", None, None, "8.5"), "payload.hotel_rating_min", "invalid_type"),
    ("flag not bool", ("flags", "ai_concierge", None, "yes"), "payload.flags.ai_concierge", "invalid_type"),
    ("flag name", ("flags", "Bad-Flag", None, True), "payload.flags.Bad-Flag", "invalid_format"),
    ("script field", ("script", None, None, "alert(1)"), "payload.script", "unknown_field"),
]


def _mutate(payload: dict, spec: tuple) -> dict:
    """spec = (*путь, значение); None в пути пропускается."""
    *keys, value = [x for x in spec if x is not None]
    target = payload
    for key in keys[:-1]:
        target = target[key]
    target[keys[-1]] = value
    return payload


@pytest.mark.parametrize(("name", "mutation", "path", "reason"), INVALID, ids=[i[0] for i in INVALID])
async def test_create_version_validation(env, name, mutation, path, reason) -> None:
    payload = _mutate(await env.seed_payload(), mutation)
    r = await env.c.post(f"{BASE}/miniapp/versions", json=new_version(payload), headers=env.h(EDITOR))
    assert r.status_code == 422, r.text
    err = r.json()
    assert err["code"] == "EXPERIENCE_CONFIG_INVALID"
    assert (err["details"]["path"], err["details"]["reason"]) == (path, reason)
    assert {"path": path, "reason": reason} in err["details"]["errors"]
    versions = (await env.c.get(f"{BASE}/miniapp/versions", headers=env.h(READER))).json()["items"]
    assert len(versions) == 2  # ничего не создано


async def test_create_version_section_rules(env) -> None:
    async def errors(mutate) -> dict:
        payload = await env.seed_payload()
        mutate(payload)
        r = await env.c.post(f"{BASE}/miniapp/versions", json=new_version(payload), headers=env.h(EDITOR))
        assert r.status_code == 422, r.text
        return r.json()["details"]

    d = await errors(lambda p: p["home"]["sections"].append(dict(p["home"]["sections"][0])))
    assert (d["path"], d["reason"]) == ("payload.home.sections[4].key", "duplicate")
    d = await errors(lambda p: p["home"]["sections"][1].update(type="html_block"))
    assert (d["path"], d["reason"]) == ("payload.home.sections[1].type", "not_allowed")
    d = await errors(lambda p: p["home"]["sections"][2].update(variant="hero"))
    assert (d["path"], d["reason"]) == ("payload.home.sections[2].variant", "not_allowed")
    d = await errors(lambda p: p["home"]["sections"][0].update(enabled="true"))
    assert (d["path"], d["reason"]) == ("payload.home.sections[0].enabled", "invalid_type")
    d = await errors(lambda p: p["home"].update(sections=[]))
    assert (d["path"], d["reason"]) == ("payload.home.sections", "too_few")
    d = await errors(lambda p: p["home"]["sections"][0].update(onclick="alert(1)"))
    assert (d["path"], d["reason"]) == ("payload.home.sections[0].onclick", "unknown_field")
    d = await errors(lambda p: p.pop("theme"))
    assert (d["path"], d["reason"]) == ("payload.theme", "required")


async def test_create_version_envelope_and_auth(env) -> None:
    payload = await env.seed_payload()
    bad_ver = await env.c.post(f"{BASE}/miniapp/versions", json=new_version(payload, version="v2"),
                               headers=env.h(EDITOR))
    assert bad_ver.status_code == 422 and bad_ver.json()["code"] == "VALIDATION_ERROR"
    no_note = await env.c.post(f"{BASE}/miniapp/versions", json={"version": "2.0.5", "payload": payload},
                               headers=env.h(EDITOR))
    assert no_note.status_code == 422
    reader = await env.c.post(f"{BASE}/miniapp/versions", json=new_version(payload), headers=env.h(READER))
    assert reader.status_code == 403 and reader.json()["details"] == {"permission": "config.edit"}
    # admin payload в miniapp и наоборот не проходит
    admin_payload = await env.seed_payload("admin", "1.0.0")
    cross = await env.c.post(f"{BASE}/miniapp/versions", json=new_version(admin_payload),
                             headers=env.h(EDITOR))
    assert cross.status_code == 422 and cross.json()["code"] == "EXPERIENCE_CONFIG_INVALID"
    admin_payload["theme"]["version"] = "1.0.1"
    ok = await env.c.post(f"{BASE}/admin/versions", json=new_version(admin_payload, version="1.0.1"),
                          headers=env.h(EDITOR))
    assert ok.status_code == 201 and ok.json()["app"] == "admin"


async def test_get_version_detail(env) -> None:
    r = await env.c.get(f"{BASE}/miniapp/versions/2.0.2", headers=env.h(READER))
    assert r.status_code == 200 and r.json()["status"] == "previous"
    assert (await env.c.get(f"{BASE}/miniapp/versions/9.9.9", headers=env.h(READER))).json()["code"] == \
        "EXPERIENCE_VERSION_NOT_FOUND"
    traversal = await env.c.get(f"{BASE}/miniapp/versions/..%2F..%2Fetc", headers=env.h(READER))
    assert traversal.status_code == 404
    assert (await env.c.get(f"{BASE}/admin/versions/2.0.3", headers=env.h(READER))).status_code == 404


# ---------------------------------------------------------------- активация и откат


async def test_activate_rollback_and_repeat_rollback(env) -> None:
    payload = await env.seed_payload()
    payload["theme"]["version"] = "2.0.4"
    payload["theme"]["tokens"]["--accent"] = "#C6F432"
    assert (await env.c.post(f"{BASE}/miniapp/versions", json=new_version(payload),
                             headers=env.h(EDITOR))).status_code == 201
    act = await env.c.post(f"{BASE}/miniapp/activate", json={"version": "2.0.4", "reason": "Новый лайм"},
                           headers=env.h(PUBLISHER))
    assert act.status_code == 201, act.text
    a = act.json()
    assert (a["version"], a["previous_version"], a["kind"], a["activated_by"]) == (
        "2.0.4", "2.0.3", "activate", PUBLISHER.id)
    assert (await env.current()).json()["theme"]["tokens"]["--accent"] == "#C6F432"
    # повторная активация текущей версии — no-op
    same = await env.c.post(f"{BASE}/miniapp/activate", json={"version": "2.0.4", "reason": "Ещё раз"},
                            headers=env.h(PUBLISHER))
    assert same.status_code == 200 and same.json()["activation_id"] == a["activation_id"]

    rb1 = (await env.c.post(f"{BASE}/miniapp/rollback", json={"reason": "Жалобы на контраст"},
                            headers=env.h(PUBLISHER))).json()
    assert (rb1["version"], rb1["previous_version"], rb1["kind"]) == ("2.0.3", "2.0.4", "rollback")
    assert (await env.current()).json()["version"] == "2.0.3"
    rb2 = (await env.c.post(f"{BASE}/miniapp/rollback", json={"reason": "Вернуть"},
                            headers=env.h(PUBLISHER))).json()
    # повторный откат возвращает обратно
    assert (rb2["version"], rb2["previous_version"]) == ("2.0.4", "2.0.3")
    assert (await env.current()).json()["version"] == "2.0.4"

    history = (await env.c.get(f"{BASE}/miniapp/activations", headers=env.h(READER))).json()["items"]
    assert [(h["version"], h["kind"]) for h in history] == [
        ("2.0.4", "rollback"), ("2.0.3", "rollback"), ("2.0.4", "activate"), ("2.0.3", "activate"),
        ("2.0.2", "activate")]
    page1 = (await env.c.get(f"{BASE}/miniapp/activations?limit=2", headers=env.h(READER))).json()
    page2 = (await env.c.get(f"{BASE}/miniapp/activations?limit=2&cursor={page1['next_cursor']}",
                             headers=env.h(READER))).json()
    assert [h["activation_id"] for h in page1["items"] + page2["items"]] == [h["activation_id"]
                                                                             for h in history[:4]]
    bad_cursor = await env.c.get(f"{BASE}/miniapp/activations?cursor=@@", headers=env.h(READER))
    assert bad_cursor.status_code == 400 and bad_cursor.json()["code"] == "INVALID_CURSOR"

    await env.flush()
    activated = env.events("experience.config.activated.v1")
    assert [(e.payload["version"], e.payload["previous_version"]) for e in activated] == [
        ("2.0.4", "2.0.3"), ("2.0.3", "2.0.4"), ("2.0.4", "2.0.3")]
    for e in activated:
        assert_event_conforms(e)
        assert e.payload["app"] == "miniapp" and e.producer == "experience-config"
    audits = [e for e in env.events("admin.audit.recorded.v1") if e.payload["action"] != "config.create"]
    assert [(e.payload["action"], e.payload["before"], e.payload["after"]["version"]) for e in audits] == [
        ("config.publish", {"version": "2.0.3"}, "2.0.4"),
        ("config.rollback", {"version": "2.0.4"}, "2.0.3"),
        ("config.rollback", {"version": "2.0.3"}, "2.0.4")]
    for e in audits:
        assert_event_conforms(e)
        p = e.payload
        assert (p["actor_type"], p["actor_id"], p["actor_role"]) == ("staff", PUBLISHER.id, "super_admin")
        assert p["object_type"] == "experience_config"
        assert p["object_id"] == f"miniapp@{p['after']['version']}"
        assert p["reason"] in {"Новый лайм", "Жалобы на контраст", "Вернуть"}
    try:  # запись принимается audit-service как есть (его RecordIn строже JSON Schema)
        from tilhero_audit.schemas import RecordIn
    except ImportError:  # pragma: no cover
        return
    for e in audits:
        RecordIn.model_validate(e.payload)


async def test_activate_errors_and_permissions(env) -> None:
    unknown = await env.c.post(f"{BASE}/miniapp/activate", json={"version": "9.9.9", "reason": "нет такой"},
                               headers=env.h(PUBLISHER))
    assert unknown.status_code == 404 and unknown.json()["code"] == "EXPERIENCE_VERSION_NOT_FOUND"
    other_app = await env.c.post(f"{BASE}/admin/activate", json={"version": "2.0.3", "reason": "чужая"},
                                 headers=env.h(PUBLISHER))
    assert other_app.status_code == 404
    no_prev = await env.c.post(f"{BASE}/admin/rollback", json={"reason": "некуда"}, headers=env.h(PUBLISHER))
    assert no_prev.status_code == 409 and no_prev.json()["code"] == "EXPERIENCE_NO_PREVIOUS"
    no_reason = await env.c.post(f"{BASE}/miniapp/rollback", json={}, headers=env.h(PUBLISHER))
    assert no_reason.status_code == 422
    short = await env.c.post(f"{BASE}/miniapp/rollback", json={"reason": "x"}, headers=env.h(PUBLISHER))
    assert short.status_code == 422
    for actor in (EDITOR, READER, SUPPORT):
        for path, body in (("activate", {"version": "2.0.2", "reason": "попытка"}),
                           ("rollback", {"reason": "попытка"})):
            r = await env.c.post(f"{BASE}/miniapp/{path}", json=body, headers=env.h(actor))
            assert r.status_code == 403 and r.json()["details"] == {"permission": "config.publish"}
    assert (await env.current()).json()["version"] == "2.0.3"
    await env.flush()
    assert env.events("experience.config.activated.v1") == []


async def test_staff_endpoints_auth(env) -> None:
    gets = [f"{BASE}/miniapp/versions", f"{BASE}/miniapp/versions/2.0.3", f"{BASE}/miniapp/activations",
            f"{BASE}/miniapp/state"]
    posts = [(f"{BASE}/miniapp/versions", {"version": "2.0.9", "payload": {}, "change_note": "тест"}),
             (f"{BASE}/miniapp/activate", {"version": "2.0.2", "reason": "тест"}),
             (f"{BASE}/miniapp/rollback", {"reason": "тест"})]
    for method, path, body in [("GET", p, None) for p in gets] + [("POST", p, b) for p, b in posts]:
        assert (await env.c.request(method, path, json=body)).status_code == 401
        tg = await env.c.request(method, path, json=body, headers=env.h(PUBLISHER, issuer="telegram-bff"))
        assert tg.status_code == 403 and tg.json()["code"] == "CALLER_NOT_ALLOWED"
        no_actor = await env.c.request(method, path, json=body, headers=env.h(None))
        assert no_actor.status_code == 403 and no_actor.json()["code"] == "STAFF_CONTEXT_REQUIRED"
        support = await env.c.request(method, path, json=body, headers=env.h(SUPPORT))
        assert support.status_code == 403 and support.json()["code"] == "PERMISSION_DENIED"
        unknown_app = await env.c.request(method, path.replace("/miniapp/", "/web/"), json=body,
                                          headers=env.h(PUBLISHER))
        assert unknown_app.status_code == 404 and unknown_app.json()["code"] == "EXPERIENCE_APP_UNKNOWN"


async def test_idempotency_key_prevents_double_rollback(env) -> None:
    h = env.h(PUBLISHER, **{"Idempotency-Key": "rollback-click-0001"})
    first = await env.c.post(f"{BASE}/miniapp/rollback", json={"reason": "Двойной клик"}, headers=h)
    second = await env.c.post(f"{BASE}/miniapp/rollback", json={"reason": "Двойной клик"}, headers=h)
    assert first.status_code == second.status_code == 201
    assert second.json() == first.json() and second.headers.get("idempotent-replay") == "true"
    assert (await env.current()).json()["version"] == "2.0.2"  # откат выполнен ровно один раз
    reused = await env.c.post(f"{BASE}/miniapp/rollback", json={"reason": "Другое тело"}, headers=h)
    assert reused.status_code == 422 and reused.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    # ключ другого сотрудника — другой scope
    other = await env.c.post(f"{BASE}/miniapp/rollback", json={"reason": "Двойной клик"},
                             headers=env.h(EDITOR, **{"Idempotency-Key": "rollback-click-0001"}))
    assert other.status_code == 403
    # неудачная команда не «съедает» ключ
    fail_h = env.h(PUBLISHER, **{"Idempotency-Key": "activate-missing-01"})
    missing = {"version": "7.7.7", "reason": "нет"}
    bad = await env.c.post(f"{BASE}/admin/activate", json=missing, headers=fail_h)
    assert bad.status_code == 404
    again = await env.c.post(f"{BASE}/admin/activate", json=missing, headers=fail_h)
    assert again.status_code == 404 and again.headers.get("idempotent-replay") is None
    short_key = await env.c.post(f"{BASE}/miniapp/rollback", json={"reason": "ключ"},
                                 headers=env.h(PUBLISHER, **{"Idempotency-Key": "k"}))
    assert short_key.status_code == 422
    await env.flush()
    assert len(env.events("experience.config.activated.v1")) == 1


async def test_concurrent_rollbacks_are_serialized(env) -> None:
    results = await asyncio.gather(*[
        env.c.post(f"{BASE}/miniapp/rollback", json={"reason": f"параллельно {i}"}, headers=env.h(PUBLISHER))
        for i in range(4)])
    assert all(r.status_code == 201 for r in results)
    resp = await env.c.get(f"{BASE}/miniapp/activations?limit=100", headers=env.h(READER))
    history = resp.json()["items"]
    # каждая запись ссылается на предыдущую текущую — цепочка без «развилок»
    chain = list(reversed(history))
    for prev, cur in itertools.pairwise(chain):
        assert cur["previous_version"] == prev["version"]
    assert (await env.current()).json()["version"] == "2.0.3"  # чётное число откатов
