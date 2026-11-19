"""Справочник языков и пар (ADM-LANG-01/02, AT-31): новая пара — запись без изменения кода; published — только
с готовым курсом; права lang.manage; аудит lang.*."""

from __future__ import annotations

import ts_contract as ts
from catalog_kit import CONTENT_MANAGER as LANG_EDITOR
from catalog_kit import LANG, READER, SUPPORT

LANGUAGE = {"code": "de", "name": {"ru": "Немецкий", "uz": "Nemis tili", "en": "German"}, "script": "Latn",
            "variants": ["de-DE"], "asr": None, "tts": {"provider": "device", "voices": ["de-DE"]},
            "limitations": None, "status": "planned"}
PAIR = {"pair_id": "ru-de", "source": "ru", "target": "de", "explanation_locales": ["ru"], "ui_locales": ["ru", "uz"],
        "title": {"ru": "Немецкий (объяснения на русском)", "uz": "Nemis tili (izohlar rus tilida)"},
        "status": "planned", "release_at": None, "course_id": None, "reason": "Новая пара в планах"}


async def test_languages_list_and_upsert(env) -> None:
    r = await env.c.get("/admin/v1/languages", headers=env.h(READER))
    assert r.status_code == 200
    items = r.json()["items"]
    assert [i["code"] for i in items] == ["en", "kk", "ru", "uz"]
    assert all(set(i) == set(ts.fields("content.ts", "Language")) for i in items)
    assert (await env.c.get("/admin/v1/languages", headers=env.h(SUPPORT))).status_code == 403
    r = await env.c.put("/admin/v1/languages/de", json=LANGUAGE, headers=env.h(READER))
    assert r.status_code == 403 and r.json()["details"] == {"permission": "lang.manage"}
    r = await env.c.put("/admin/v1/languages/de", json=LANGUAGE, headers=env.h(LANG))
    assert r.status_code == 200 and r.json() == LANGUAGE
    r = await env.c.put("/admin/v1/languages/de", json={**LANGUAGE, "status": "active"}, headers=env.h(LANG))
    assert r.json()["status"] == "active"
    r = await env.c.put("/admin/v1/languages/fr", json=LANGUAGE, headers=env.h(LANG))
    assert r.status_code == 422 and r.json()["code"] == "LANGUAGE_CODE_MISMATCH"
    r = await env.c.put("/admin/v1/languages/de", json={**LANGUAGE, "script": "Arab"}, headers=env.h(LANG))
    assert r.status_code == 422
    created = await env.audit("lang.language_created")
    updated = await env.audit("lang.language_updated")
    assert len(created) == 1 and len(updated) == 1 and updated[0]["before"]["status"] == "planned"


async def test_pair_cards_readiness(env) -> None:
    r = await env.c.get("/admin/v1/language-pairs", headers=env.h(READER))
    assert r.status_code == 200
    cards = {c["pair_id"]: c for c in r.json()["items"]}
    assert set(cards["ru-en"]) == set(ts.fields("admin.ts", "PairCard"))
    assert cards["ru-en"]["readiness"] == {"skills": 3, "lessons_published": 2, "scenarios_published": 1,
                                           "rubrics_published": 1, "media_published": 1, "diagnostic_test": None,
                                           "locales_checked_pct": 100.0}
    assert cards["ru-uz"]["readiness"]["lessons_published"] == 0 and cards["ru-uz"]["learners"] == 0


async def test_new_pair_without_code_change_and_readiness_gate(env) -> None:
    r = await env.c.put("/admin/v1/language-pairs/ru-de", json=PAIR, headers=env.h(LANG))
    assert r.status_code == 422 and r.json()["code"] == "UNKNOWN_LANGUAGE"
    assert r.json()["details"] == {"field": "target"}
    await env.c.put("/admin/v1/languages/de", json=LANGUAGE, headers=env.h(LANG))
    r = await env.c.put("/admin/v1/language-pairs/ru-de", json=PAIR, headers=env.h(LANG))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "planned" and r.json()["readiness"]["skills"] == 0
    pairs = (await env.c.get("/internal/v1/pairs", headers=env.svc("telegram-bff"))).json()["items"]
    assert "ru-de" in {p["pair_id"] for p in pairs}
    r = await env.c.put("/admin/v1/language-pairs/ru-de", json={**PAIR, "status": "published"}, headers=env.h(LANG))
    assert r.status_code == 422 and r.json()["code"] == "PAIR_NOT_READY"
    assert r.json()["details"] == {"missing": ["course"]}
    r = await env.c.put("/admin/v1/language-pairs/ru-de", json={**PAIR, "course_id": "en-core"}, headers=env.h(LANG))
    assert r.status_code == 422 and r.json()["code"] == "PAIR_INVALID"  # курс другой пары
    r = await env.c.put("/admin/v1/language-pairs/ru-de", json={**PAIR, "source": "de"}, headers=env.h(LANG))
    assert r.status_code == 422 and r.json()["code"] == "PAIR_INVALID"
    r = await env.c.put("/admin/v1/language-pairs/ru-xx", json=PAIR, headers=env.h(LANG))
    assert r.status_code == 422 and r.json()["code"] == "PAIR_ID_MISMATCH"
    for bad in ({"reason": ""}, {"reason": "   ab   "}, {"release_at": "скоро"}, {"ui_locales": ["kk"]}):
        r = await env.c.put("/admin/v1/language-pairs/ru-de", json={**PAIR, **bad}, headers=env.h(LANG))
        assert r.status_code == 422, bad
    r = await env.c.put("/admin/v1/language-pairs/ru-de", json={**PAIR, "release_at": "2027-03-01T09:00:00Z"},
                        headers=env.h(LANG))
    assert r.status_code == 200 and r.json()["release_at"] == "2027-03-01T09:00:00Z"
    r = await env.c.put("/admin/v1/language-pairs/ru-de", json=PAIR, headers=env.h(READER))
    assert r.status_code == 403
    [audit] = await env.audit("lang.pair_created")
    assert audit["reason"] == "Новая пара в планах" and audit["object_id"] == "ru-de"


async def test_published_pair_stays_published_on_edit(env) -> None:
    cards = {c["pair_id"]: c for c in (await env.c.get("/admin/v1/language-pairs", headers=env.h(READER))).json()[
        "items"]}
    ru_en = {k: v for k, v in cards["ru-en"].items() if k not in ("readiness", "learners")}
    r = await env.c.put("/admin/v1/language-pairs/ru-en",
                        json={**ru_en, "title": {"ru": "Английский язык", "uz": "Ingliz tili"},
                              "reason": "Уточнить название"}, headers=env.h(LANG))
    assert r.status_code == 200 and r.json()["title"]["ru"] == "Английский язык"
    r = await env.c.put("/admin/v1/language-pairs/ru-en", json={**ru_en, "status": "pilot", "reason": "Пилот"},
                        headers=env.h(LANG))
    assert r.status_code == 200
    r = await env.c.put("/admin/v1/language-pairs/ru-en", json={**ru_en, "status": "published",
                                                                "reason": "Снова опубликовать"}, headers=env.h(LANG))
    assert r.status_code == 200 and r.json()["status"] == "published"  # курс готов: проверка пройдена


async def test_course_change_on_published_pair_requires_readiness(env) -> None:
    """Смена course_id у опубликованной пары — та же проверка готовности, что и публикация (ревью)."""
    cards = {c["pair_id"]: c for c in (await env.c.get("/admin/v1/language-pairs", headers=env.h(READER))).json()[
        "items"]}
    ru_en = {k: v for k, v in cards["ru-en"].items() if k not in ("readiness", "learners")}
    draft_course = {"course_id": "en-core-2", "pair_id": "ru-en", "title": {"ru": "Новый курс", "uz": "Yangi kurs"},
                    "description": {"ru": "Черновик", "uz": "Qoralama"}, "level_start": "A0", "level_end": "A1",
                    "module_ids": []}
    assert (await env.c.post("/admin/v1/content/course", json={"payload": draft_course},
                             headers=env.h(LANG_EDITOR))).status_code == 201
    r = await env.c.put("/admin/v1/language-pairs/ru-en",
                        json={**ru_en, "course_id": "en-core-2", "reason": "Новый курс"}, headers=env.h(LANG))
    assert r.status_code == 422 and r.json()["code"] == "PAIR_NOT_READY"
    assert r.json()["details"] == {"missing": ["course"]}
    r = await env.c.put("/admin/v1/language-pairs/ru-en", json={**ru_en, "course_id": None, "reason": "Без курса"},
                        headers=env.h(LANG))
    assert r.status_code == 422 and r.json()["code"] == "PAIR_NOT_READY"
    pair = await env.sql("SELECT course_id, status FROM language_pairs WHERE pair_id = 'ru-en'")
    assert (pair[0]["course_id"], pair[0]["status"]) == ("en-core", "published")  # ничего не изменилось
    # не опубликованная пара курс меняет свободно
    r = await env.c.put("/admin/v1/language-pairs/ru-en",
                        json={**ru_en, "status": "pilot", "course_id": "en-core-2", "reason": "Пилот нового курса"},
                        headers=env.h(LANG))
    assert r.status_code == 200
