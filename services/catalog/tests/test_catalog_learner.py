"""API для сервисов и ученика (INTERNAL_API §1.4, bff.ts): пары, снимок курса с ETag (без ключей ответов), каталог
сценариев без полного графа, медиатека с правами и аудиторией, аудио (AT-31, AT-37, AT-38)."""

from __future__ import annotations

import base64
import uuid

import ts_contract as ts
from catalog_kit import CONTENT_MANAGER, LANG, READER, exercise, media, scenario, seed

PAIR_FIELDS = set(ts.fields("content.ts", "LanguagePair"))
OGG = b"OggS\x00\x02" + b"\x01" * 64


def learner(env) -> dict[str, str]:
    return env.learner(uuid.uuid4())


# ---------------------------------------------------------------- пары (AT-31)


async def test_pairs_for_services(env) -> None:
    for caller in ("telegram-bff", "learning-plan", "diagnostics"):
        r = await env.c.get("/internal/v1/pairs", headers=env.svc(caller))
        assert r.status_code == 200, caller
    items = r.json()["items"]
    assert all(set(i) == PAIR_FIELDS for i in items)
    status = {i["pair_id"]: i["status"] for i in items}
    assert status == {"en-kk": "planned", "en-uz": "planned", "ru-en": "published", "ru-kk": "planned",
                      "ru-uz": "planned"}
    assert next(i for i in items if i["pair_id"] == "ru-en")["course_id"] == "en-core"
    r = await env.c.get("/internal/v1/pairs", headers=env.svc("notifications"))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    assert (await env.c.get("/internal/v1/pairs")).status_code == 401
    # архивная пара ученику не показывается
    kk = next(i for i in items if i["pair_id"] == "ru-kk")
    r = await env.c.put("/admin/v1/language-pairs/ru-kk", json={**kk, "status": "archived", "reason": "Не планируем"},
                        headers=env.h(LANG))
    assert r.status_code == 200, r.text
    items = (await env.c.get("/internal/v1/pairs", headers=env.svc("diagnostics"))).json()["items"]
    assert "ru-kk" not in {i["pair_id"] for i in items}


# ---------------------------------------------------------------- снимок курса


async def test_course_snapshot_shape_and_no_answers(env) -> None:
    r = await env.c.get("/internal/v1/courses/en-core/snapshot", headers=env.svc("learning-plan"))
    assert r.status_code == 200
    snap = r.json()
    assert set(snap) == set(ts.fields("bff.ts", "CourseSnapshot"))
    assert [m["module_id"] for m in snap["modules"]] == ["m1-meet", "m2-city"]
    assert [les["lesson_id"] for les in snap["lessons"]] == ["l-01-greetings", "l-07-coffee"]
    lesson_fields = set(ts.fields("bff.ts", "LessonCard")) | {
        "audience", "goals", "topics", "secondary_skill_ids", "prerequisite_skill_ids", "control_item_types"}
    assert set(snap["lessons"][0]) == lesson_fields
    assert snap["lessons"][0]["control_item_types"] == ["single_choice", "gap_fill", "order_words"]
    assert set(snap["lessons"][0]["stages"][0]) == {"type", "minutes"}
    assert [s["skill_id"] for s in snap["skills"]] == ["en.func.greet", "en.gram.to-be", "en.func.order-drink"]
    assert set(snap["skills"][0]) == {"skill_id", "area", "title", "level", "prerequisites", "diagnostic_tags"}
    assert '"answer"' not in r.text and "Good night!" not in r.text  # ни ключей, ни вариантов ответов
    assert r.headers["etag"] == f'"{snap["snapshot_version"]}"'


async def test_snapshot_etag_and_changes(env) -> None:
    h = env.svc("diagnostics")
    first = await env.c.get("/internal/v1/courses/en-core/snapshot", headers=h)
    etag = first.headers["etag"]
    same = await env.c.get("/internal/v1/courses/en-core/snapshot", headers={**h, "If-None-Match": etag})
    assert same.status_code == 304 and same.content == b""
    v2 = await env.edit_published("lesson", "l-07-coffee", 1, {"hints": []})
    await env.publish("lesson", "l-07-coffee", v2)
    changed = await env.c.get("/internal/v1/courses/en-core/snapshot", headers={**h, "If-None-Match": etag})
    assert changed.status_code == 200 and changed.headers["etag"] != etag
    r = await env.c.get("/internal/v1/courses/en-other/snapshot", headers=h)
    assert r.status_code == 404 and r.json()["code"] == "COURSE_NOT_FOUND"
    r = await env.c.get("/internal/v1/courses/en-core/snapshot", headers=env.svc("notifications"))
    assert r.status_code == 403
    r = await env.c.get("/internal/v1/courses/en-core/snapshot", headers=env.h(READER))
    assert r.status_code == 403  # admin-bff — не вызывающий этого API


async def test_snapshot_shows_only_published(env) -> None:
    await env.new_version("lesson", "l-01-greetings", 1)  # черновик v2 не виден
    snap = (await env.c.get("/internal/v1/courses/en-core/snapshot", headers=env.svc("telegram-bff"))).json()
    assert snap["lessons"][0]["title"] == seed("lesson", "l-01-greetings")["title"]


# ---------------------------------------------------------------- сценарии (AT-37, AT-38)


async def test_scenario_catalog_audience_and_filters(env) -> None:
    await env.published_new("scenario", {**scenario("sc-adult-work", audience=["adults"]), "goals": ["work"],
                                         "topics": ["work"], "level": "A2"})
    h = learner(env)
    r = await env.c.get("/internal/v1/scenarios", headers=h)
    assert r.status_code == 422  # аудитория обязательна (BFF знает возраст ученика)
    kids = (await env.c.get("/internal/v1/scenarios", params={"audience": "kids"}, headers=h)).json()
    assert [c["scenario_id"] for c in kids["items"]] == ["sc-cafe-coffee"]
    card = kids["items"][0]
    assert set(card) == set(ts.fields("bff.ts", "ScenarioCard"))
    assert card["characters"] == [{"name": "Mia", "role": {"ru": "Бариста", "uz": "Barista"}}]
    adults = (await env.c.get("/internal/v1/scenarios", params={"audience": "adults"}, headers=h)).json()
    assert [c["scenario_id"] for c in adults["items"]] == ["sc-cafe-coffee", "sc-adult-work"]  # по уровню
    work = (await env.c.get("/internal/v1/scenarios", params={"audience": "adults", "goal": "work"},
                            headers=h)).json()
    assert [c["scenario_id"] for c in work["items"]] == ["sc-adult-work"]
    food = (await env.c.get("/internal/v1/scenarios", params={"audience": "adults", "topic": "food", "level": "A1"},
                            headers=h)).json()
    assert [c["scenario_id"] for c in food["items"]] == ["sc-cafe-coffee"]
    page = (await env.c.get("/internal/v1/scenarios", params={"audience": "adults", "limit": 1}, headers=h)).json()
    nxt = (await env.c.get("/internal/v1/scenarios", params={"audience": "adults", "limit": 1,
                                                              "cursor": page["next_cursor"]}, headers=h)).json()
    assert [c["scenario_id"] for c in page["items"] + nxt["items"]] == ["sc-cafe-coffee", "sc-adult-work"]
    assert nxt["next_cursor"] is None
    r = await env.c.get("/internal/v1/scenarios", params={"audience": "adults"}, headers=env.svc("learning-plan"))
    assert r.status_code == 403


async def test_scenario_detail_without_full_graph(env) -> None:
    await env.published_new("scenario", scenario("sc-adult", audience=["teens", "adults"]))
    h = learner(env)
    r = await env.c.get("/internal/v1/scenarios/sc-cafe-coffee", params={"audience": "kids"}, headers=h)
    assert r.status_code == 200
    d = r.json()
    assert set(d) == set(ts.fields("bff.ts", "ScenarioDetail"))
    assert d["opening"]["speaker"] == "Mia" and d["opening"]["line_en"] == "Hi there! What can I get you?"
    assert [x["example_en"] for x in d["opening"]["replies"]] == ["A hot chocolate, please.",
                                                                  "Can I see the menu, please?"]
    assert [o["outcome"] for o in d["outcomes"]] == ["success", "alt_success"]
    assert "nodes" not in r.text and "Sure! Small or large?" not in r.text  # граф не раскрывается
    r = await env.c.get("/internal/v1/scenarios/sc-adult", params={"audience": "kids"}, headers=h)
    assert r.status_code == 404 and r.json()["code"] == "SCENARIO_NOT_FOUND"
    await env.create("scenario", scenario("sc-draft"))
    r = await env.c.get("/internal/v1/scenarios/sc-draft", params={"audience": "adults"}, headers=h)
    assert r.status_code == 404


# ---------------------------------------------------------------- медиатека (AT-29, AT-38)


async def test_media_catalog_and_detail(env) -> None:
    h = learner(env)
    cards = (await env.c.get("/internal/v1/media", params={"audience": "kids"}, headers=h)).json()
    assert [c["asset_id"] for c in cards["items"]] == ["m-own-coffee-order"]
    card = cards["items"][0]
    assert set(card) == set(ts.fields("bff.ts", "MediaCard"))
    assert card["source_label"] == "TilHero" and card["has_audio"] is False
    d = (await env.c.get("/internal/v1/media/m-own-coffee-order", params={"audience": "kids"}, headers=h)).json()
    assert set(d) == set(ts.fields("bff.ts", "MediaDetail"))
    assert len(d["transcript"]) == 5 and d["phrases"][0] == {"en": "What would you like?",
                                                             "gloss": {"ru": "Что бы вы хотели?",
                                                                       "uz": "Nima xohlaysiz?"}}
    assert d["voices"] == {"Mia": "en-GB", "Tim": "en-US"} and d["exercises_available"] is False
    assert all(line["gloss"] and line["gloss"]["ru"] for line in d["transcript"]), "translation разрешён — перевод есть"
    await env.published_new("media_exercise", exercise("mx-1"))
    d = (await env.c.get("/internal/v1/media/m-own-coffee-order", params={"audience": "kids"}, headers=h)).json()
    assert d["exercises_available"] is True


async def test_media_license_limits_what_learner_sees(env) -> None:
    pd = media("m-pd", license_type="public_domain", owner="Народная песня",
               allowed_uses=["listen", "exercises"])
    pd.update(origin="public_domain", audience=["teens", "adults"], type="song")
    await env.published_new("media_asset", pd)
    h = learner(env)
    d = (await env.c.get("/internal/v1/media/m-pd", params={"audience": "adults"}, headers=h)).json()
    assert d["transcript"] is None and d["phrases"] == [] and d["source_label"] == "Общественное достояние"
    assert d["voices"] == {"Mia": "en-GB", "Tim": "en-US"}
    r = await env.c.get("/internal/v1/media/m-pd", params={"audience": "kids"}, headers=h)
    assert r.status_code == 404 and r.json()["code"] == "MEDIA_NOT_AVAILABLE"
    # транскрипт разрешён, перевод — нет: реплики без gloss
    nt = media("m-no-translation", allowed_uses=["listen", "show_transcript", "dictionary"])
    nt.update(audience=["teens", "adults"])
    await env.published_new("media_asset", nt)
    d = (await env.c.get("/internal/v1/media/m-no-translation", params={"audience": "adults"}, headers=h)).json()
    assert d["transcript"] and all(line["gloss"] is None and line["text_en"] for line in d["transcript"])
    songs = (await env.c.get("/internal/v1/media", params={"audience": "adults", "type": "song"}, headers=h)).json()
    assert [c["asset_id"] for c in songs["items"]] == ["m-pd"]
    future = media("m-future", valid_from="2026-12-01")
    await env.published_new("media_asset", future)
    all_items = (await env.c.get("/internal/v1/media", params={"audience": "adults"}, headers=h)).json()["items"]
    assert "m-future" not in {c["asset_id"] for c in all_items}  # права ещё не начали действовать
    r = await env.c.get("/internal/v1/media/m-nope", params={"audience": "adults"}, headers=h)
    assert r.status_code == 404


async def test_media_audio_bytes_and_cache(env) -> None:
    up = await env.c.post("/admin/v1/content/blobs", headers=env.h(CONTENT_MANAGER),
                          json={"filename": "s.ogg", "content_type": "audio/ogg",
                                "data_base64": base64.b64encode(OGG).decode()})
    blob = up.json()
    p = media("m-voiced")
    p["audio_blob_id"] = blob["blob_id"]
    await env.published_new("media_asset", p)
    h = learner(env)
    r = await env.c.get("/internal/v1/media/m-voiced/audio", headers=h)
    assert r.status_code == 200 and r.content == OGG and r.headers["content-type"] == "audio/ogg"
    assert r.headers["cache-control"] == "private, max-age=3600" and r.headers["etag"] == f'"{blob["sha256"]}"'
    r304 = await env.c.get("/internal/v1/media/m-voiced/audio", headers={**h, "If-None-Match": r.headers["etag"]})
    assert r304.status_code == 304
    r = await env.c.get("/internal/v1/media/m-voiced/audio", params={"audience": "kids"}, headers=h)
    assert r.status_code == 200
    card = (await env.c.get("/internal/v1/media/m-voiced", params={"audience": "adults"}, headers=h)).json()
    assert card["has_audio"] is True
    r = await env.c.get("/internal/v1/media/m-own-coffee-order/audio", headers=h)
    assert r.status_code == 404 and r.json()["code"] == "AUDIO_NOT_FOUND"
    r = await env.c.get("/internal/v1/media/m-voiced/audio", headers=env.svc("learning-plan"))
    assert r.status_code == 403


# ---------------------------------------------------------------- защита в глубину по аудитории (ревью)


async def test_child_profile_forced_to_kids_audience(env) -> None:
    """Детский профиль (lrn ≠ sub или age_band 6–13) видит только kids, что бы ни пришло в ?audience=."""
    await env.published_new("scenario", scenario("sc-adult", audience=["adults"]))
    up = await env.c.post("/admin/v1/content/blobs", headers=env.h(CONTENT_MANAGER),
                          json={"filename": "a.ogg", "content_type": "audio/ogg",
                                "data_base64": base64.b64encode(OGG).decode()})
    adult_media = media("m-adult")
    adult_media.update(audience=["adults"], audio_blob_id=up.json()["blob_id"])
    await env.published_new("media_asset", adult_media)
    account, child = uuid.uuid4(), uuid.uuid4()
    adult = env.learner(account)
    for kid in (env.learner(account, lrn=str(child)), env.learner(child, age_band="6-9")):
        sc = (await env.c.get("/internal/v1/scenarios", params={"audience": "adults"}, headers=kid)).json()
        assert [c["scenario_id"] for c in sc["items"]] == ["sc-cafe-coffee"]
        r = await env.c.get("/internal/v1/scenarios/sc-adult", params={"audience": "adults"}, headers=kid)
        assert r.status_code == 404
        md = (await env.c.get("/internal/v1/media", params={"audience": "adults"}, headers=kid)).json()
        assert [c["asset_id"] for c in md["items"]] == ["m-own-coffee-order"]
        r = await env.c.get("/internal/v1/media/m-adult", params={"audience": "adults"}, headers=kid)
        assert r.status_code == 404 and r.json()["code"] == "MEDIA_NOT_AVAILABLE"
        for params in ({}, {"audience": "adults"}):  # аудио: и без параметра — по claims
            r = await env.c.get("/internal/v1/media/m-adult/audio", params=params, headers=kid)
            assert r.status_code == 404, params
    # взрослый аккаунт (lrn = sub, age_band 18+) видит взрослое
    adult18 = env.learner(account, lrn=str(account), age_band="18+")
    for h in (adult, adult18):
        r = await env.c.get("/internal/v1/scenarios/sc-adult", params={"audience": "adults"}, headers=h)
        assert r.status_code == 200
        assert (await env.c.get("/internal/v1/media/m-adult/audio", headers=h)).status_code == 200


async def test_has_audio_requires_listen_license(env) -> None:
    up = await env.c.post("/admin/v1/content/blobs", headers=env.h(CONTENT_MANAGER),
                          json={"filename": "a.ogg", "content_type": "audio/ogg",
                                "data_base64": base64.b64encode(OGG).decode()})
    p = media("m-no-listen", allowed_uses=["show_transcript", "exercises"])
    p["audio_blob_id"] = up.json()["blob_id"]
    await env.published_new("media_asset", p)
    h = learner(env)
    cards = (await env.c.get("/internal/v1/media", params={"audience": "adults"}, headers=h)).json()["items"]
    assert next(c for c in cards if c["asset_id"] == "m-no-listen")["has_audio"] is False
    d = (await env.c.get("/internal/v1/media/m-no-listen", params={"audience": "adults"}, headers=h)).json()
    assert d["has_audio"] is False
    r = await env.c.get("/internal/v1/media/m-no-listen/audio", headers=h)
    assert r.status_code == 404 and r.json()["code"] == "AUDIO_NOT_FOUND"
