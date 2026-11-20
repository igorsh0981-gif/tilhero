"""Спринт 5, тексты для чтения (INTERNAL_API §2.1, content.ts ReadingPayload): каждое правило проверки (чистые
функции), жизненный цикл как у остальных видов (черновик → проверка вторым методистом → публикация → архив),
событие с kind reading, API ученика (карточки и текст без ответов, дети — только kids), версии с ключами для lessons,
assessment и memory, сид методистов (migrations/seed/readings.json — пропуск, если файла ещё нет)."""

from __future__ import annotations

import copy
import uuid
from datetime import date
from pathlib import Path
from typing import Any

import pytest
import ts_contract as ts
from catalog_kit import (
    CONTENT_MANAGER,
    PUBLISHER,
    READER,
    SEED_DIR,
    L,
    codes,
    reading,
    skill,
)
from conftest import SERVICE_DIR

from tilhero_catalog.content import KEY_FIELDS
from tilhero_catalog.domain.readings import words_of
from tilhero_catalog.domain.seed import check_seed, load_readings, load_seed_dir
from tilhero_catalog.domain.validation import RefContext, validate
from tilhero_common.testing import assert_event_conforms

TODAY = date(2026, 11, 19)
REAL_SEED = Path(SERVICE_DIR) / "migrations" / "seed"
PUBLISHED = "catalog.version.published.v1"


def _ctx(mode: str = "submit") -> RefContext:
    view = {(k, p[KEY_FIELDS[k]]): p for k, p in load_seed_dir(SEED_DIR)}
    base: dict[str, Any] = {"mode": mode, "today": TODAY, "existing": dict(view), "published": dict(view),
                            "pairs": {"ru-en"}}
    if mode == "publish":
        base.update(locale_checks={"ru": "checked", "uz": "checked"})
    return RefContext(**base)


def rule(payload: dict[str, Any], mode: str = "submit") -> list[tuple[str, str]]:
    return [(i.code, i.path) for i in validate("reading", payload, _ctx(mode))]


def rule_codes(payload: dict[str, Any], mode: str = "submit") -> set[str]:
    return {c for c, _ in rule(payload, mode)}


def sentence(s_id: str, text: str) -> dict[str, Any]:
    return {"s_id": s_id, "text_en": text, "gloss": L("Перевод", "Tarjima")}


# ---------------------------------------------------------------- правила (§2.1), чистые функции


def test_fixture_readings_are_valid() -> None:
    for kids in (False, True):
        p = reading("r-ok", kids=kids)
        assert rule(p) == [] and rule(p, "publish") == []
        assert 60 <= words_of(p) <= 250


BASE = "Anna orders tea in the coffee shop, waits in line, pays by card and will come back."  # 17 слов


def with_words(total: int) -> dict[str, Any]:
    """Текст фикстуры ровно из total слов: предложение со всеми словами глоссария + наполнитель по ≤ 30 слов."""
    p = reading("r-words")
    rest = total - 17
    chunks = [30] * (rest // 30) + ([rest % 30] if rest % 30 else [])
    sentences = [sentence("s0", BASE)] + [sentence(f"f{i}", " ".join(["word"] * n)) for i, n in enumerate(chunks)]
    p["paragraphs"] = [{"p_id": f"p{i}", "sentences": sentences[i * 8:(i + 1) * 8]}
                       for i in range((len(sentences) + 7) // 8)]
    assert words_of(p) == total
    return p


def test_word_count_bounds() -> None:
    for total, ok in ((59, False), (60, True), (250, True), (251, False)):
        found = rule(with_words(total))
        assert (("READING_WORDS", "payload.paragraphs") in found) is not ok, total
        assert [c for c, _ in found if c != "READING_WORDS"] == [], (total, found)


def test_sentence_at_most_30_words() -> None:
    p = reading("r-long-sentence")
    long_text = " ".join(["word"] * 31)
    p["paragraphs"][0]["sentences"][0]["text_en"] = long_text
    assert ("SENTENCE_TOO_LONG", "payload.paragraphs[0].sentences[0].text_en") in rule(p)
    p["paragraphs"][0]["sentences"][0]["text_en"] = " ".join(["word"] * 30)
    assert "SENTENCE_TOO_LONG" not in rule_codes(p)
    # дефисное слово — одно (well-known), апостроф внутри слова (isn't) — одно
    p["paragraphs"][0]["sentences"][0]["text_en"] = " ".join(["well-known"] * 15 + ["isn't"] * 15)
    assert "SENTENCE_TOO_LONG" not in rule_codes(p)


def test_ids_unique() -> None:
    p = reading("r-dup")
    p["paragraphs"][1]["sentences"][0]["s_id"] = "s1"
    p["paragraphs"][1]["p_id"] = "p1"
    found = rule(p)
    assert ("DUPLICATE_ID", "payload.paragraphs[1].sentences[0].s_id") in found
    assert ("DUPLICATE_ID", "payload.paragraphs[1]") in found
    p = reading("r-dup-q")
    p["questions"][1]["question_id"] = "q1"
    assert ("DUPLICATE_ID", "payload.questions[1]") in rule(p)


def test_paragraph_and_sentence_counts() -> None:
    p = reading("r-par")
    p["paragraphs"] = []
    assert ("COUNT_OUT_OF_RANGE", "payload.paragraphs") in rule(p)
    p = reading("r-par9")
    p["paragraphs"] = [{"p_id": f"p{i}", "sentences": [sentence(f"s{i}", "Anna drinks tea in the coffee shop.")]}
                       for i in range(9)]
    assert ("COUNT_OUT_OF_RANGE", "payload.paragraphs") in rule(p)
    p = reading("r-sent9")
    p["paragraphs"][0]["sentences"] = [sentence(f"x{i}", "Anna drinks tea.") for i in range(9)]
    assert ("COUNT_OUT_OF_RANGE", "payload.paragraphs[0].sentences") in rule(p)


def test_glossary_rules() -> None:
    p = reading("r-gl")
    p["glossary"] = p["glossary"][:2]
    assert ("COUNT_OUT_OF_RANGE", "payload.glossary") in rule(p)
    p = reading("r-gl21")
    p["glossary"] = [copy.deepcopy(p["glossary"][0]) | {"en": w} for w in
                     ["Anna", "goes", "to", "a", "small", "coffee", "shop", "near", "her", "office", "she", "usually",
                      "orders", "cup", "of", "tea", "with", "milk", "the", "barista", "Tom"]]
    assert ("COUNT_OUT_OF_RANGE", "payload.glossary") in rule(p)
    # каждая статья встречается в тексте по границам слов (без учёта регистра)
    p = reading("r-gl-text")
    p["glossary"][0]["en"] = "Coffee Shop"
    assert rule(p) == []
    p["glossary"][0]["en"] = "off"  # есть внутри «office», но не словом
    assert ("GLOSSARY_NOT_IN_TEXT", "payload.glossary[0].en") in rule(p)
    p["glossary"][0]["en"] = "spaceship"
    assert ("GLOSSARY_NOT_IN_TEXT", "payload.glossary[0].en") in rule(p)
    p["glossary"][0]["en"] = "pays by card"
    assert ("DUPLICATE_ID", "payload.glossary[3].en") in rule(p)
    p = reading("r-gl-len")
    p["glossary"][0]["gloss"]["ru"] = "к" * 81
    p["glossary"][4]["note"]["uz"] = "a" * 161
    found = rule(p)
    assert ("TEXT_TOO_LONG", "payload.glossary[0].gloss.ru") in found
    assert ("TEXT_TOO_LONG", "payload.glossary[4].note.uz") in found


def test_question_rules() -> None:
    p = reading("r-q")
    p["questions"] = p["questions"][:2]
    assert ("COUNT_OUT_OF_RANGE", "payload.questions") in rule(p)
    p = reading("r-q9")
    p["questions"] = [copy.deepcopy(p["questions"][0]) | {"question_id": f"q{i}x"} for i in range(9)]
    assert ("COUNT_OUT_OF_RANGE", "payload.questions") in rule(p)
    p = reading("r-q-sc")
    p["questions"][0]["answer"] = 3
    assert ("ANSWER_INVALID", "payload.questions[0].answer") in rule(p)
    p["questions"][0]["answer"] = ["Tea with milk"]
    assert ("ANSWER_INVALID", "payload.questions[0].answer") in rule(p)
    p["questions"][0]["answer"] = 0
    p["questions"][0]["options"] = ["Tea with milk", "Hot chocolate"]
    assert ("ANSWER_INVALID", "payload.questions[0].options") in rule(p)
    p["questions"][0]["options"] = ["Tea", "Tea", "Juice"]
    assert ("ANSWER_INVALID", "payload.questions[0].options") in rule(p)
    p = reading("r-q-tf")
    p["questions"][1]["options"] = ["Yes", "No"]
    p["questions"][1]["answer"] = 2
    found = rule(p)
    assert ("ANSWER_INVALID", "payload.questions[1].options") in found
    assert ("ANSWER_INVALID", "payload.questions[1].answer") in found
    p = reading("r-q-gap")
    p["questions"][2]["answer"] = []
    assert ("ANSWER_INVALID", "payload.questions[2].answer") in rule(p)
    p["questions"][2]["answer"] = [" "]
    assert ("ANSWER_INVALID", "payload.questions[2].answer") in rule(p)
    p["questions"][2]["answer"] = 0
    assert ("ANSWER_INVALID", "payload.questions[2].answer") in rule(p)
    p["questions"][2]["answer"] = ["ten"]
    p["questions"][2]["options"] = ["ten", "five"]
    assert ("ANSWER_INVALID", "payload.questions[2].options") in rule(p)
    p = reading("r-q-prompt")
    p["questions"][0]["prompt_en"] = "  "
    assert ("VALUE_REQUIRED", "payload.questions[0].prompt_en") in rule(p)


def test_translations_ru_uz() -> None:
    p = reading("r-tr")
    p["paragraphs"][0]["sentences"][1]["gloss"]["uz"] = ""
    p["paragraphs"][1]["sentences"][0]["gloss"]["ru"] = " "
    found = rule(p)
    assert ("LOCALE_MISSING", "payload.paragraphs[0].sentences[1].gloss.uz") in found
    assert ("LOCALE_MISSING", "payload.paragraphs[1].sentences[0].gloss.ru") in found
    p = reading("r-tr-script")
    p["paragraphs"][0]["sentences"][0]["gloss"]["uz"] = "Каждое утро"
    assert ("LOCALE_SCRIPT", "payload.paragraphs[0].sentences[0].gloss.uz") in rule(p)


def test_kids_audience_only_kids() -> None:
    p = reading("r-kids-mixed", kids=True)
    p["audience"] = ["kids", "teens"]
    assert ("KIDS_CONTENT", "payload.audience") in rule(p)
    p["audience"] = []
    assert ("AUDIENCE_EMPTY", "payload.audience") in rule(p)
    p = reading("r-kids-link", kids=True)
    p["paragraphs"][0]["sentences"][0]["text_en"] = "This is my cat from www.cats.com."
    assert ("KIDS_CONTENT", "payload.paragraphs[0].sentences[0].text_en") in rule(p)


def test_minutes_skills_and_refs() -> None:
    for minutes in (2, 16):
        p = reading("r-min", est_minutes=minutes)
        assert ("COUNT_OUT_OF_RANGE", "payload.est_minutes") in rule(p)
    for minutes in (3, 15):
        assert "COUNT_OUT_OF_RANGE" not in rule_codes(reading("r-min", est_minutes=minutes))
    p = reading("r-sk", skill_ids=["en.func.greet", "en.gram.to-be", "en.func.order-drink", "en.func.greet"])
    found = rule(p)
    assert ("COUNT_OUT_OF_RANGE", "payload.skill_ids") in found and ("DUPLICATE_ID", "payload.skill_ids[3]") in found
    p = reading("r-sk-unknown", skill_ids=["en.read.nope"])
    assert ("UNKNOWN_REF", "payload.skill_ids[0]") in rule(p)
    assert ("LOCALE_NOT_CHECKED", "locale_checks.ru") not in rule(reading("r-ok"), "publish")


def test_schema_formats() -> None:
    from tilhero_catalog.domain.validation import parse_schema

    p = reading("r-schema")
    p["paragraphs"][0]["sentences"][0]["s_id"] = "S-1"
    model, issues = parse_schema("reading", p)
    assert model is None and issues[0].code == "SCHEMA_INVALID"
    p = reading("r-schema", voice="en-AU")
    assert parse_schema("reading", p)[0] is None
    p = reading("r-schema")
    p["paragraphs"][0]["sentences"][0]["text_en"] = "x" * 241
    assert parse_schema("reading", p)[0] is None
    p = reading("r-schema", extra=1)
    assert parse_schema("reading", p)[0] is None


def test_seed_check_includes_readings() -> None:
    entries = load_readings(SEED_DIR)
    assert [p["reading_id"] for _, p in entries] == ["r-a1-coffee-shop", "r-a0-my-cat"]
    published = {(k, p[KEY_FIELDS[k]]): p for k, p in load_seed_dir(SEED_DIR)}
    assert len(check_seed(entries, published=published, pairs={"ru-en"}, blobs=set(), today=TODAY,
                          external_sources=False)) == 2
    assert load_readings(SEED_DIR / "missing") == []


def test_real_readings_seed_if_present() -> None:
    """Сид методистов (исполнитель G): 12 текстов A0–A2, 8 взрослых и 4 детских, все правила §2.1 в режиме
    публикации. Пока файла нет — пропуск."""
    entries = load_readings(REAL_SEED)
    if not entries:
        pytest.skip("migrations/seed/readings.json ещё нет")
    published = {(k, p[KEY_FIELDS[k]]): p for k, p in load_seed_dir(REAL_SEED)}
    checked = check_seed(entries, published=published, pairs={"ru-en"}, blobs=set(), today=TODAY,
                         external_sources=False)
    kids = [p for _, p in checked if p["audience"] == ["kids"]]
    assert len(checked) == 12 and len(kids) == 4
    assert {p["level"] for _, p in checked} <= {"A0", "A1", "A2"}
    for _, p in checked:
        assert validate("reading", p, RefContext(mode="publish", today=TODAY, existing=published,
                                                 published=published, pairs={"ru-en"},
                                                 locale_checks={"ru": "checked", "uz": "checked"})) == []


# ---------------------------------------------------------------- жизненный цикл (API)


async def test_reading_lifecycle_event_and_audit(env) -> None:
    p = reading("r-a1-life")
    r = await env.create("reading", p)
    assert r.status_code == 201, r.text
    assert (r.json()["kind"], r.json()["status"]) == ("reading", "draft")
    bad = copy.deepcopy(p)
    bad["glossary"][0]["en"] = "spaceship"
    v = r.json()
    r = await env.put("reading", "r-a1-life", 1, bad, v["payload_hash"])
    assert r.status_code == 200
    r = await env.submit("reading", "r-a1-life", 1)
    assert r.status_code == 422 and "GLOSSARY_NOT_IN_TEXT" in codes(r)
    current = await env.get_version("reading", "r-a1-life", 1)
    r = await env.put("reading", "r-a1-life", 1, p, current["payload_hash"])
    assert r.status_code == 200
    version = await env.to_approved("reading", p, version=1)
    # проверка вторым методистом: автор не проверяет свою версию — общий механизм
    r = await env.publish("reading", "r-a1-life", version)
    assert r.status_code == 200, r.text
    await env.flush()
    [event] = [e for e in env.events(PUBLISHED) if e.payload["key"] == "r-a1-life"]
    assert event.payload["kind"] == "reading" and event.payload["action"] == "published"
    assert event.payload["course_id"] is None
    assert_event_conforms(event)
    [audit] = [a for a in await env.audit("content.published") if a["object_id"] == "reading:r-a1-life@1"]
    assert audit["actor_id"] == PUBLISHER.id
    # опубликованное — только новой версией; архив
    r = await env.c.put(env.url("reading", "r-a1-life", 1), json={"payload": p, "expected_hash": "0" * 64},
                        headers=env.h(CONTENT_MANAGER))
    assert r.status_code == 409 and r.json()["code"] == "VERSION_NOT_DRAFT"
    r = await env.c.post("/admin/v1/content/reading/r-a1-life/archive", json={"reason": "Снять текст"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 200, r.text
    rows = (await env.c.get("/admin/v1/content/reading", headers=env.h(READER))).json()["items"]
    assert {row["key"] for row in rows} >= {"r-a1-life", "r-a1-coffee-shop", "r-a0-my-cat"}
    summary = (await env.c.get("/admin/v1/content/summary", headers=env.h(READER))).json()
    assert summary["by_kind"]["reading"]["published"] == 2


async def test_reading_publish_requires_published_skill(env) -> None:
    r = await env.create("skill", skill("en.read.draft-skill"))
    assert r.status_code == 201
    p = reading("r-a1-skill", skill_ids=["en.read.draft-skill"])
    version = await env.to_approved("reading", p)
    r = await env.publish("reading", "r-a1-skill", version)
    assert r.status_code == 422 and "UNKNOWN_REF" in codes(r)


async def test_skill_in_use_by_reading_cannot_be_archived(env) -> None:
    await env.published_new("reading", reading("r-a1-uses-skill", skill_ids=["en.func.greet"]))
    r = await env.c.post("/admin/v1/content/skill/en.func.greet/archive", json={"reason": "Снять навык"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 409 and {"kind": "reading", "key": "r-a1-uses-skill"} in r.json()["details"]["refs"]


# ---------------------------------------------------------------- версии с ключами: lessons, assessment, memory


async def test_versions_of_reading_with_keys(env) -> None:
    for caller in ("lessons", "assessment", "memory"):
        r = await env.c.get("/internal/v1/versions/reading/r-a1-coffee-shop/1", headers=env.svc(caller))
        assert r.status_code == 200, caller
        assert r.json()["payload"]["questions"][0]["answer"] == 0
        cur = await env.c.get("/internal/v1/versions/reading/r-a1-coffee-shop", headers=env.svc(caller))
        assert cur.status_code == 200 and cur.json()["version"] == 1
    # memory — только lesson, media_asset, reading, scenario
    for kind, key in (("lesson", "l-01-greetings"), ("media_asset", "m-own-coffee-order"),
                      ("scenario", "sc-cafe-coffee")):
        assert (await env.c.get(f"/internal/v1/versions/{kind}/{key}/1", headers=env.memory())).status_code == 200
    for kind, key in (("rubric", "r-lesson-core"), ("skill", "en.func.greet"), ("course", "en-core")):
        for path in (f"/internal/v1/versions/{kind}/{key}/1", f"/internal/v1/versions/{kind}/{key}"):
            r = await env.c.get(path, headers=env.memory())
            assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", path
    r = await env.c.get("/internal/v1/versions/reading/r-a1-coffee-shop/1", headers=env.svc("telegram-bff"))
    assert r.status_code == 403


# ---------------------------------------------------------------- API ученика (telegram-bff, lessons)


async def test_reading_cards_by_audience_and_level(env) -> None:
    await env.published_new("reading", reading("r-a2-extra", level="A2"))
    h = env.learner(uuid.uuid4())
    r = await env.c.get("/internal/v1/readings", params={"audience": "adults"}, headers=h)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [i["reading_id"] for i in items] == ["r-a1-coffee-shop", "r-a2-extra"]  # уровень, затем ключ
    card_fields = set(ts.fields("bff.ts", "ReadingCard")) - {"last_result"} | {"version"}
    assert set(items[0]) == card_fields
    assert items[0]["word_count"] == words_of(reading("x")) and items[0]["est_minutes"] == 5
    kids = (await env.c.get("/internal/v1/readings", params={"audience": "kids"}, headers=h)).json()["items"]
    assert [i["reading_id"] for i in kids] == ["r-a0-my-cat"]
    lvl = (await env.c.get("/internal/v1/readings", params={"audience": "adults", "level": "A2"},
                           headers=env.svc("lessons"))).json()["items"]
    assert [i["reading_id"] for i in lvl] == ["r-a2-extra"]
    # пагинация
    page = (await env.c.get("/internal/v1/readings", params={"audience": "teens", "limit": 1}, headers=h)).json()
    assert len(page["items"]) == 1 and page["next_cursor"]
    nxt = (await env.c.get("/internal/v1/readings", params={"audience": "teens", "limit": 1,
                                                           "cursor": page["next_cursor"]}, headers=h)).json()
    assert [i["reading_id"] for i in nxt["items"]] == ["r-a2-extra"] and nxt["next_cursor"] is None
    # пара: только с изучаемым английским
    assert len((await env.c.get("/internal/v1/readings", params={"audience": "adults", "pair_id": "ru-en"},
                                headers=h)).json()["items"]) == 2
    assert (await env.c.get("/internal/v1/readings", params={"audience": "adults", "pair_id": "ru-uz"},
                            headers=h)).json()["items"] == []
    # без аудитории — 422 (возраст знает только BFF)
    assert (await env.c.get("/internal/v1/readings", headers=h)).status_code == 422


async def test_child_profile_sees_only_kids_texts(env) -> None:
    child = uuid.uuid4()
    h = env.learner(child, lrn=str(child), age_band="6-9")
    items = (await env.c.get("/internal/v1/readings", params={"audience": "adults"}, headers=h)).json()["items"]
    assert [i["reading_id"] for i in items] == ["r-a0-my-cat"]
    r = await env.c.get("/internal/v1/readings/r-a1-coffee-shop", params={"audience": "adults"}, headers=h)
    assert r.status_code == 404 and r.json()["code"] == "READING_NOT_AVAILABLE"
    assert (await env.c.get("/internal/v1/readings/r-a0-my-cat", params={"audience": "adults"},
                            headers=h)).status_code == 200


async def test_reading_detail_without_answers(env) -> None:
    h = env.svc("lessons", str(uuid.uuid4()))
    r = await env.c.get("/internal/v1/readings/r-a1-coffee-shop", params={"audience": "teens"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert '"answer"' not in r.text
    view_fields = set(ts.fields("bff.ts", "ReadingView"))
    assert view_fields <= set(body)
    assert body["version"] == 1 and body["questions_count"] == 3
    assert body["question_types"] == ["single_choice", "true_false", "gap_fill"]
    assert set(body["questions"][0]) == {"question_id", "type", "instruction", "prompt_en", "options"}
    assert body["glossary"][4] == {"en": "come back", "gloss": L("вернуться, прийти снова", "qaytib kelmoq"),
                                   "note": L("фразовый глагол", "frazali feʼl")}
    assert body["paragraphs"][0]["sentences"][0]["s_id"] == "s1"
    # детский текст взрослой аудитории не отдаётся; снятый с публикации и черновик — 404
    r = await env.c.get("/internal/v1/readings/r-a0-my-cat", params={"audience": "adults"}, headers=h)
    assert r.status_code == 404 and r.json()["code"] == "READING_NOT_AVAILABLE"
    await env.create("reading", reading("r-draft"))
    for rid in ("r-draft", "r-nope", "BAD KEY"):
        r = await env.c.get(f"/internal/v1/readings/{rid}", params={"audience": "adults"}, headers=h)
        assert r.status_code == 404, rid


async def test_reading_api_callers(env) -> None:
    url = "/internal/v1/readings"
    assert (await env.c.get(url, params={"audience": "adults"})).status_code == 401
    for caller in ("memory", "assessment", "notifications", "learning-plan"):
        r = await env.c.get(url, params={"audience": "adults"}, headers=env.svc(caller))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
    r = await env.c.get(url, params={"audience": "adults"}, headers=env.h(READER))
    assert r.status_code == 403
    r = await env.c.get(url, params={"audience": "elders"}, headers=env.svc("lessons"))
    assert r.status_code == 422


async def test_migration_without_readings_file(tmp_path) -> None:
    """Нет readings.json — миграция 0005 ничего не загружает (сид текстов ещё не готов)."""
    import shutil

    import asyncpg as pg
    from conftest import make_settings
    from sqlalchemy.engine import make_url

    from tilhero_common.testing import TEST_ADMIN_URL, create_schema, drop_schema, migrate, unique_schema

    for f in SEED_DIR.glob("*.json"):
        if f.name != "readings.json":
            shutil.copy(f, tmp_path / f.name)
    schema = unique_schema("catalog_noread")
    await create_schema(schema)
    try:
        settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema, seed_dir=str(tmp_path))
        await migrate(SERVICE_DIR, settings)
        url = make_url(TEST_ADMIN_URL).set(drivername="postgresql").render_as_string(hide_password=False)
        conn = await pg.connect(url, server_settings={"search_path": schema})
        try:
            assert await conn.fetchval("SELECT count(*) FROM content_versions WHERE kind = 'reading'") == 0
            assert await conn.fetchval("SELECT version_num FROM alembic_version") == "0005"
            assert await conn.fetchval("SELECT count(*) FROM glossary_entries") == 10  # уроки и медиа фикстуры
        finally:
            await conn.close()
    finally:
        await drop_schema(schema)
