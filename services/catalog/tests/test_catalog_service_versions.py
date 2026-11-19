"""Спринт 4 (INTERNAL_API §4): версии контента с ключами для lessons и assessment, упражнения к медиа без ключей для
lessons; доступ lessons к снимку курса, парам, сценариям и медиа."""

from __future__ import annotations

import uuid

from catalog_kit import CONTENT_MANAGER, PUBLISHER, READER, exercise, media, scenario

V_LESSON = "/internal/v1/versions/lesson/l-01-greetings/1"
IMMUTABLE = "private, max-age=31536000, immutable"


def lessons_h(env, **claims) -> dict[str, str]:
    return env.svc("lessons", str(uuid.uuid4()), **claims)


# ---------------------------------------------------------------- версии с ключами


async def test_released_version_with_keys_for_lessons_and_assessment(env) -> None:
    for caller in ("lessons", "assessment"):
        r = await env.c.get(V_LESSON, headers=env.svc(caller))
        assert r.status_code == 200, (caller, r.text)
        body = r.json()
        assert set(body) == {"kind", "key", "version", "payload", "payload_hash"}
        assert body["kind"] == "lesson" and body["key"] == "l-01-greetings" and body["version"] == 1
        # полное тело с ключами — только здесь
        assert all("answer" in item for item in body["payload"]["control_items"])
        assert r.headers["cache-control"] == IMMUTABLE
        assert r.headers["etag"] == f'"{body["payload_hash"]}"'
    meta = await env.get_version("lesson", "l-01-greetings", 1)
    assert body["payload_hash"] == meta["payload_hash"] and body["payload"] == meta["payload"]
    r304 = await env.c.get(V_LESSON, headers={**env.svc("assessment"), "If-None-Match": r.headers["etag"]})
    assert r304.status_code == 304 and r304.content == b"" and r304.headers["cache-control"] == IMMUTABLE
    other = await env.c.get(V_LESSON, headers={**env.svc("assessment"), "If-None-Match": '"nope"'})
    assert other.status_code == 200
    # другие виды: сценарий с полным графом, рубрика
    sc = await env.c.get("/internal/v1/versions/scenario/sc-cafe-coffee/1", headers=env.svc("lessons"))
    assert sc.status_code == 200 and "nodes" in sc.json()["payload"]
    rb = await env.c.get("/internal/v1/versions/rubric/r-lesson-core/1", headers=env.svc("assessment"))
    assert rb.status_code == 200 and rb.json()["payload"]["rubric_id"] == "r-lesson-core"


async def test_released_version_access(env) -> None:
    assert (await env.c.get(V_LESSON)).status_code == 401
    bad = {"x-internal-token": "garbage"}
    assert (await env.c.get(V_LESSON, headers=bad)).status_code == 401
    for caller in ("telegram-bff", "learning-plan", "diagnostics", "notifications", "ai-gateway"):
        r = await env.c.get(V_LESSON, headers=env.svc(caller, str(uuid.uuid4())))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
    r = await env.c.get(V_LESSON, headers=env.h(READER))  # admin-bff с правом content.read — не этот API
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"


async def test_released_version_only_published_or_formerly_published(env) -> None:
    h = env.svc("assessment")
    # черновик v2 опубликованного урока
    assert (await env.new_version("lesson", "l-01-greetings", 1)).status_code == 201
    r = await env.c.get("/internal/v1/versions/lesson/l-01-greetings/2", headers=h)
    assert r.status_code == 404 and r.json()["code"] == "VERSION_NOT_FOUND"
    # на проверке и одобренная — тоже 404
    sc = scenario("sc-flow")
    await env.create("scenario", sc)
    await env.act("scenario", "sc-flow", 1, "test-run", CONTENT_MANAGER)
    await env.submit("scenario", "sc-flow", 1)
    r = await env.c.get("/internal/v1/versions/scenario/sc-flow/1", headers=h)
    assert r.status_code == 404
    await env.approve("scenario", "sc-flow", 1)
    r = await env.c.get("/internal/v1/versions/scenario/sc-flow/1", headers=h)
    assert r.status_code == 404
    assert (await env.publish("scenario", "sc-flow", 1)).status_code == 200
    first = await env.c.get("/internal/v1/versions/scenario/sc-flow/1", headers=h)
    assert first.status_code == 200
    # новая публикация: v1 → archived (бывшая опубликованной) — по-прежнему отдаётся тем же телом
    v2 = await env.edit_published("scenario", "sc-flow", 1, {"difficulty": 2})
    assert (await env.publish("scenario", "sc-flow", v2)).status_code == 200
    again = await env.c.get("/internal/v1/versions/scenario/sc-flow/1", headers=h)
    assert again.status_code == 200 and again.json() == first.json()
    assert again.headers["etag"] == first.headers["etag"]
    new = await env.c.get(f"/internal/v1/versions/scenario/sc-flow/{v2}", headers=h)
    assert new.status_code == 200 and new.json()["payload"]["difficulty"] == 2
    # снятие с публикации: архивная, бывшая опубликованной — отдаётся
    r = await env.c.post("/admin/v1/content/scenario/sc-flow/archive", json={"reason": "Снять в тесте"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 200, r.text
    r = await env.c.get(f"/internal/v1/versions/scenario/sc-flow/{v2}", headers=h)
    assert r.status_code == 200
    r = await env.c.get("/internal/v1/versions/scenario/sc-flow", headers=h)  # текущей опубликованной нет
    assert r.status_code == 404 and r.json()["code"] == "VERSION_NOT_FOUND"


async def test_released_version_displaced_approved_is_not_released(env) -> None:
    """Одобренная, но вытесненная более новой публикацией (approved → archived без публикации) — 404."""
    h = env.svc("lessons")
    v2 = await env.edit_published("lesson", "l-07-coffee", 1, {"hints": []})
    v3 = await env.edit_published("lesson", "l-07-coffee", 1, {"hints": [], "duration_min": 20})
    assert (await env.publish("lesson", "l-07-coffee", v3)).status_code == 200
    rows = await env.sql("SELECT status, published_at FROM content_versions WHERE kind = 'lesson' "
                         "AND key = 'l-07-coffee' AND version = $1", v2)
    assert rows[0]["status"] == "archived" and rows[0]["published_at"] is None
    r = await env.c.get(f"/internal/v1/versions/lesson/l-07-coffee/{v2}", headers=h)
    assert r.status_code == 404 and r.json()["code"] == "VERSION_NOT_FOUND"
    for v in (1, v3):  # бывшая опубликованной и текущая — отдаются
        assert (await env.c.get(f"/internal/v1/versions/lesson/l-07-coffee/{v}", headers=h)).status_code == 200


async def test_released_version_not_found_and_validation(env) -> None:
    h = env.svc("lessons")
    for path, code in (("/internal/v1/versions/lesson/l-nope/1", "VERSION_NOT_FOUND"),
                       ("/internal/v1/versions/lesson/l-01-greetings/99", "VERSION_NOT_FOUND"),
                       ("/internal/v1/versions/lesson/BAD KEY/1", "VERSION_NOT_FOUND"),
                       ("/internal/v1/versions/lesson/l-01-greetings/0", "VERSION_NOT_FOUND"),
                       ("/internal/v1/versions/lesson/l-01-greetings/99999999999", "VERSION_NOT_FOUND"),
                       ("/internal/v1/versions/widget/l-01-greetings/1", "CONTENT_KIND_UNKNOWN")):
        r = await env.c.get(path, headers=h)
        assert r.status_code == 404 and r.json()["code"] == code, path
    r = await env.c.get("/internal/v1/versions/lesson/l-01-greetings/one", headers=h)
    assert r.status_code == 422


async def test_suspended_media_version_not_released(env) -> None:
    """Приостановленное медиа (права истекли) по версии не отдаётся — показывать его нельзя."""
    p = media("m-expiring", valid_to="2026-11-20")
    v = await env.published_new("media_asset", p)
    h = env.svc("lessons")
    assert (await env.c.get(f"/internal/v1/versions/media_asset/m-expiring/{v}", headers=h)).status_code == 200
    from datetime import date

    env.set_today(date(2026, 11, 21))
    r = await env.c.post("/internal/v1/catalog:tick", headers=env.scheduler())
    assert r.status_code == 200, r.text
    r = await env.c.get(f"/internal/v1/versions/media_asset/m-expiring/{v}", headers=h)
    assert r.status_code == 404 and r.json()["code"] == "VERSION_NOT_FOUND"


# ---------------------------------------------------------------- упражнения к медиа без ключей


async def test_media_exercises_without_keys(env) -> None:
    await env.published_new("media_exercise", exercise("mx-b"))
    gap = {**exercise("mx-a", kind="gap_fill"), "prompt_en": "A hot ___, please.", "options": [],
           "answer": ["chocolate"]}
    await env.published_new("media_exercise", gap)
    await env.create("media_exercise", exercise("mx-draft"))  # черновик не виден
    r = await env.c.get("/internal/v1/media/m-own-coffee-order/exercises", params={"audience": "kids"},
                        headers=lessons_h(env))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["asset_id"] == "m-own-coffee-order" and body["asset_version"] == 1
    assert [i["exercise_id"] for i in body["items"]] == ["mx-a", "mx-b"]
    assert set(body["items"][0]) == {"exercise_id", "version", "asset_id", "type", "skill_id", "level",
                                     "instruction", "prompt_en", "options", "line_index", "rubric_id"}
    assert all(i["version"] == 1 for i in body["items"])
    assert '"answer"' not in r.text and "chocolate\"]" not in r.text  # ни ключа, ни допустимых ответов пропуска
    assert body["items"][1]["options"] == ["A hot chocolate", "A tea", "A juice"]
    # ключи — только по версии
    full = await env.c.get("/internal/v1/versions/media_exercise/mx-a/1", headers=env.svc("assessment"))
    assert full.json()["payload"]["answer"] == ["chocolate"]


async def test_media_exercises_audience_and_rights(env) -> None:
    adult = media("m-adult")
    adult["audience"] = ["adults"]
    await env.published_new("media_asset", adult)
    await env.published_new("media_exercise", exercise("mx-adult", asset_id="m-adult"))
    h = lessons_h(env)
    r = await env.c.get("/internal/v1/media/m-adult/exercises", params={"audience": "adults"}, headers=h)
    assert r.status_code == 200 and [i["exercise_id"] for i in r.json()["items"]] == ["mx-adult"]
    r = await env.c.get("/internal/v1/media/m-adult/exercises", params={"audience": "kids"}, headers=h)
    assert r.status_code == 404 and r.json()["code"] == "MEDIA_NOT_AVAILABLE"
    # детский профиль по claims — kids принудительно, что бы ни пришло в ?audience=
    account, child = uuid.uuid4(), uuid.uuid4()
    for kid in (env.svc("lessons", str(account), lrn=str(child)), env.svc("lessons", str(child), age_band="10-13")):
        r = await env.c.get("/internal/v1/media/m-adult/exercises", params={"audience": "adults"}, headers=kid)
        assert r.status_code == 404
    # аудитория обязательна
    r = await env.c.get("/internal/v1/media/m-adult/exercises", headers=h)
    assert r.status_code == 422
    # лицензия без exercises — пустой список (как exercises_available = false)
    no_ex = media("m-no-ex", allowed_uses=["listen", "show_transcript"])
    await env.published_new("media_asset", no_ex)
    r = await env.c.get("/internal/v1/media/m-no-ex/exercises", params={"audience": "adults"}, headers=h)
    assert r.status_code == 200 and r.json()["items"] == []
    # права ещё не действуют / медиа нет / черновик медиа
    await env.published_new("media_asset", media("m-future", valid_from="2026-12-01"))
    for asset in ("m-future", "m-nope"):
        r = await env.c.get(f"/internal/v1/media/{asset}/exercises", params={"audience": "adults"}, headers=h)
        assert r.status_code == 404 and r.json()["code"] == "MEDIA_NOT_AVAILABLE", asset


async def test_media_exercises_access(env) -> None:
    path = "/internal/v1/media/m-own-coffee-order/exercises?audience=adults"
    assert (await env.c.get(path)).status_code == 401
    for caller in ("telegram-bff", "assessment", "learning-plan", "notifications"):
        r = await env.c.get(path, headers=env.svc(caller, str(uuid.uuid4())))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
    assert (await env.c.get(path, headers=env.h(READER))).status_code == 403


# ---------------------------------------------------------------- lessons — снимок курса, пары, сценарии, медиа


async def test_lessons_reads_course_pairs_scenarios_media(env) -> None:
    h = lessons_h(env)
    assert (await env.c.get("/internal/v1/pairs", headers=h)).status_code == 200
    snap = await env.c.get("/internal/v1/courses/en-core/snapshot", headers=h)
    assert snap.status_code == 200 and '"answer"' not in snap.text
    sc = await env.c.get("/internal/v1/scenarios/sc-cafe-coffee", params={"audience": "adults"}, headers=h)
    assert sc.status_code == 200 and "nodes" not in sc.text  # граф — только по версии
    assert (await env.c.get("/internal/v1/scenarios", params={"audience": "kids"}, headers=h)).status_code == 200
    md = await env.c.get("/internal/v1/media/m-own-coffee-order", params={"audience": "kids"}, headers=h)
    assert md.status_code == 200
    assert (await env.c.get("/internal/v1/media", params={"audience": "kids"}, headers=h)).status_code == 200
    # аудио и заявки — не lessons
    for path in ("/internal/v1/media/m-own-coffee-order/audio", "/internal/v1/media/requests"):
        r = await env.c.get(path, headers=h)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", path
    # assessment ученических каталогов не читает
    r = await env.c.get("/internal/v1/scenarios", params={"audience": "kids"}, headers=env.svc("assessment"))
    assert r.status_code == 403


# ---------------------------------------------------------------- текущая опубликованная версия (без номера)


async def test_current_published_version(env) -> None:
    h = env.svc("lessons")
    r = await env.c.get("/internal/v1/versions/lesson/l-07-coffee", headers=h)
    assert r.status_code == 200 and r.json()["version"] == 1
    assert "answer" in r.json()["payload"]["control_items"][0]
    assert r.headers["cache-control"] == "private, no-cache"
    assert r.headers["etag"] == f'"1.{r.json()["payload_hash"]}"'
    cur = "/internal/v1/versions/lesson/l-07-coffee"
    same = await env.c.get(cur, headers={**h, "If-None-Match": r.headers["etag"]})
    assert same.status_code == 304
    v2 = await env.edit_published("lesson", "l-07-coffee", 1, {"hints": []})
    r = await env.c.get("/internal/v1/versions/lesson/l-07-coffee", headers=h)
    assert r.json()["version"] == 1  # одобренная, но не опубликованная — не текущая
    await env.publish("lesson", "l-07-coffee", v2)
    r = await env.c.get(cur, headers={**h, "If-None-Match": same.headers["etag"]})
    assert r.status_code == 200 and r.json()["version"] == v2
    # не опубликован (черновик), нет ключа, неизвестный вид
    await env.create("scenario", scenario("sc-draft-only"))
    for path, code in (("/internal/v1/versions/scenario/sc-draft-only", "VERSION_NOT_FOUND"),
                       ("/internal/v1/versions/lesson/l-nope", "VERSION_NOT_FOUND"),
                       ("/internal/v1/versions/lesson/BAD KEY", "VERSION_NOT_FOUND"),
                       ("/internal/v1/versions/widget/l-07-coffee", "CONTENT_KIND_UNKNOWN")):
        r = await env.c.get(path, headers=env.svc("assessment"))
        assert r.status_code == 404 and r.json()["code"] == code, path
    assert (await env.c.get("/internal/v1/versions/lesson/l-07-coffee")).status_code == 401
    for caller in ("telegram-bff", "learning-plan", "diagnostics"):
        r = await env.c.get("/internal/v1/versions/lesson/l-07-coffee", headers=env.svc(caller))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller


async def test_current_version_of_suspended_media_is_not_found(env) -> None:
    from datetime import date

    v = await env.published_new("media_asset", media("m-ending", valid_to="2026-11-20"))
    h = env.svc("lessons")
    assert (await env.c.get("/internal/v1/versions/media_asset/m-ending", headers=h)).json()["version"] == v
    env.set_today(date(2026, 11, 21))
    assert (await env.c.post("/internal/v1/catalog:tick", headers=env.scheduler())).status_code == 200
    r = await env.c.get("/internal/v1/versions/media_asset/m-ending", headers=h)
    assert r.status_code == 404 and r.json()["code"] == "VERSION_NOT_FOUND"
