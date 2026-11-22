"""Релиз 7: «Что нового» о социальном контуре публикуется при выкладке (миграция 0009): s7-social (подростки и
взрослые) и s7-social-kids (дети, только семья); иллюстрация s7-social из каталога; событие публикации и аудит — как у
публикации сотрудником; обратимость; метка, занятая сотрудником."""

from __future__ import annotations

import importlib.util
import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from conftest import SERVICE_DIR
from exp_actors import WN_PUBLISHER
from sqlalchemy import text
from test_release_notes import CYRILLIC, WELCOME, _alembic, create, ids_for_me, note
from test_release_notes import staff_note as active_note

from tilhero_common.testing import assert_event_conforms
from tilhero_experience.domain import release_notes as rn

ADULT, KIDS = "s7-social", "s7-social-kids"
BEFORE_RELEASE = "2026-11-20T07:00:00Z"  # занимается с 20.11: после 6.1, до выкладки 7
PUBLISHED = "experience.release_note.published.v1"
AUDIT = "admin.audit.recorded.v1"
WRONG_APOSTROPHES = re.compile("['`‘ʼ’]")  # узбекская латиница: oʻ / gʻ — только U+02BB


def migration() -> ModuleType:
    path = Path(SERVICE_DIR) / "migrations" / "versions" / "0009_release_7.py"
    spec = importlib.util.spec_from_file_location("exp_migration_0009", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def texts(n: dict[str, Any], lang: str) -> list[str]:
    return [n["title"][lang], *(i[p][lang] for i in n["items"] for p in ("title", "text"))]


# (иконка, переход, заголовок RU, заголовок UZ) — по заданию владельца
ADULT_ITEMS = [
    ("users", "friends", "Друзья по нику", "Nik orqali doʻstlar"),
    ("trophy", "leagues", "Лиги недели", "Hafta ligalari"),
    ("star", "duels", "Дуэли", "Duellar"),
    ("chat", "friends", "Урок вдвоём", "Juftlikda dars"),
    ("gift", "referrals", "Пригласите друга", "Doʻstingizni taklif qiling"),
    ("shield", "friends", "Безопасность", "Xavfsizlik"),
]
KIDS_ITEMS = [
    ("trophy", "leagues", "Лига семьи", "Oila ligasi"),
    ("star", "duels", "Дуэль с родными", "Oila bilan duel"),
    ("chat", "friends", "Урок вдвоём", "Juftlikda dars"),
    ("shield", "friends", "Только свои", "Faqat yaqinlaring"),
]


async def scalar(env, sql: str, **params: Any) -> Any:
    async with env.runtime.transaction() as s:
        return (await s.execute(text(sql), params)).scalar()


async def outbox_unsent(env, event_type: str) -> int:
    """Неотправленные события заметок релиза 7: публикация (payload.slug) или аудит (payload.after.slug)."""
    async with env.runtime.transaction() as s:
        return (await s.execute(text(
            "SELECT count(*) FROM outbox WHERE published_at IS NULL AND event_type = :t AND COALESCE("
            "envelope -> 'payload' ->> 'slug', envelope -> 'payload' -> 'after' ->> 'slug') "
            "IN ('s7-social', 's7-social-kids')"), {"t": event_type})).scalar_one()


# ---------------------------------------------------------------- каталог


def test_illustration_in_catalog() -> None:
    """s7-social — взрослым (друзья, лиги, дуэли); s7-family — детям (семья вместе, без пьедестала: у детей нет
    призовых мест). Файлы и размеры сверяет test_release_notes::test_catalog_matches_contract."""
    assert rn.ILLUSTRATIONS["s7-social"] == rn.ILLUSTRATIONS["s7-family"] == (1200, 675)
    assert list(rn.ILLUSTRATIONS)[-2:] == ["s7-social", "s7-family"]
    assert {"s7-social", "s7-family"} <= set(rn.Illustration.__args__)  # type: ignore[attr-defined]
    assert {"friends", "leagues", "duels", "referrals"} <= set(rn.ROUTES)


# ---------------------------------------------------------------- заметки опубликованы при выкладке


async def test_release_notes_published_at_deploy(env) -> None:
    adult, kids = await active_note(env, ADULT), await active_note(env, KIDS)
    for n, age, art, expected in ((adult, ["teens", "adults"], "s7-social", ADULT_ITEMS),
                                  (kids, ["kids"], "s7-family", KIDS_ITEMS)):
        assert (n["status"], n["audience"], n["segments"], n["illustration"]) == (
            "published", "existing", {"age": age}, art)
        assert n["published_by"] == n["created_by"] == "system:release"
        published_at = datetime.fromisoformat(n["published_at"].replace("Z", "+00:00"))
        assert published_at <= env.ready_at and (env.ready_at - published_at).total_seconds() < 60
        assert [(i["icon"], i["link"], i["title"]["ru"], i["title"]["uz"]) for i in n["items"]] == expected
        # та же проверка, что у заметки из админки (переводы, лимиты длины, каталог)
        content = rn.NoteContent.model_validate(
            {k: n[k] for k in ("slug", "title", "items", "audience", "segments", "illustration")})
        assert rn.dump_content(content)["items"] == n["items"]
        assert rn.missing_translations(n["title"], n["items"]) == []
        assert all(len(n["title"][lang]) <= rn.TITLE_MAX for lang in rn.LOCALES)
        assert all(len(i["title"][lang]) <= rn.ITEM_TITLE_MAX and len(i["text"][lang]) <= rn.ITEM_TEXT_MAX
                   for i in n["items"] for lang in rn.LOCALES)
        uz = texts(n, "uz")
        assert not any(CYRILLIC.search(t) for t in uz), uz
        assert not any(WRONG_APOSTROPHES.search(t) for t in uz), uz
        assert any("ʻ" in t for t in uz)
    assert adult["title"] == {"ru": "Учимся вместе: друзья, лиги и дуэли",
                              "uz": "Birga oʻrganamiz: doʻstlar, ligalar va duellar"}
    by_title = {i["title"]["ru"]: i["text"] for i in adult["items"]}
    assert "ник" in by_title["Друзья по нику"]["ru"] and "кодом друга" in by_title["Друзья по нику"]["ru"]
    assert "заблокировать" in by_title["Друзья по нику"]["ru"]
    league = by_title["Лиги недели"]["ru"]
    assert "с 14 лет" in league and "по желанию" in league and "ник" in league and "1–3 места" in league
    assert "тилами" in league
    duel = by_title["Дуэли"]["ru"]
    assert "10 одинаковых заданий" in duel and "48 часов" in duel and "XP" in duel and "ставок нет" in duel
    pair = by_title["Урок вдвоём"]
    assert "ИИ-коуч" in pair["ru"] and "свой отчёт" in pair["ru"] and "согласия на запись голоса" in pair["ru"]
    assert "SI-murabbiy" in pair["uz"]  # как в Mini App (pair.what)
    ref = by_title["Пригласите друга"]["ru"]
    assert "проверку уровня" in ref and "3 урока в 2 разных дня" in ref and "2 заморозки" in ref
    assert "переписку" in by_title["Безопасность"]["ru"]


async def test_kids_note_family_only_soft_without_voice() -> None:
    """Детская версия: на «ты», без давления, только семья — без друзей, приглашений, общей лиги и голоса;
    урок вдвоём — выбор реплик."""
    m = migration()
    kids = next(n for n in m.NOTES if n["slug"] == KIDS)
    ru, uz = " ".join(texts(kids, "ru")), " ".join(texts(kids, "uz"))
    assert not re.search(r"\b(вы|вас|вам|ваш\w*|выберите|нажмите|пригласите)\b", ru, re.IGNORECASE), ru
    assert not re.search(r"\bsiz\w*|\w+ingiz\b", uz, re.IGNORECASE), uz
    for absent in ("друг", "ник или", "общая лига", "14 лет", "приглас", "голосом", "тилами", "XP"):
        assert absent.lower() not in ru.lower(), absent
    for absent in ("doʻst", "taklif", "umumiy liga", "ovoz bilan"):
        assert absent not in uz.lower(), absent
    for pressure in ("потер", "теря", "провал", "штраф", "сгор", "проигр", "yoʻqot", "muvaffaqiyatsiz", "jarima"):
        assert pressure not in ru.lower() and pressure not in uz.lower(), pressure
    assert {i["link"] for i in kids["items"]} <= {"leagues", "duels", "friends"}  # без referrals
    league = next(i for i in kids["items"] if i["link"] == "leagues")
    assert "вместе" in league["text"]["ru"] and "набрали все вместе" in league["text"]["ru"]
    pair = next(i for i in kids["items"] if i["icon"] == "chat")
    assert "выбираешь реплики" in pair["text"]["ru"] and "говорить не нужно" in pair["text"]["ru"]
    assert "replikalarni tanlaysan" in pair["text"]["uz"] and "gapirish ham shart emas" in pair["text"]["uz"]
    assert "семь" in kids["title"]["ru"] and "Oila" in kids["title"]["uz"]
    # детская иллюстрация — семья вместе, без пьедестала лиги (фронтенд-ревью спринта 7 🟡7)
    assert kids["illustration"] == "s7-family"
    assert next(n for n in m.NOTES if n["slug"] == ADULT)["illustration"] == "s7-social"
    assert [n["id"] for n in m.NOTES] == [m.ADULT_ID, m.KIDS_ID] and m.ACTOR == rn.RELEASE_ACTOR


async def test_events_like_staff_publication(env) -> None:
    """В outbox миграции — событие публикации той же формы, что у сотрудника, и аудит system:release без текстов."""
    adult, kids = await active_note(env, ADULT), await active_note(env, KIDS)
    events = [e for e in env.migration_events if e.event_type == PUBLISHED and e.payload["slug"] in (ADULT, KIDS)]
    assert len(events) == 2
    by_slug = {e.payload["slug"]: e for e in events}
    for n in (adult, kids):
        e = by_slug[n["slug"]]
        assert e.producer == "experience-config"
        assert e.payload == rn.published_payload(uuid.UUID(n["release_note_id"]), n["slug"], n["audience"],
                                                 n["segments"], datetime.fromisoformat(
                                                     n["published_at"].replace("Z", "+00:00")))
        assert_event_conforms(e)
    audits = [e for e in env.migration_events if e.event_type == AUDIT and e.payload["object_type"] == "release_note"
              and e.payload["after"]["slug"] in (ADULT, KIDS)]
    assert sorted((e.payload["after"]["slug"], e.payload["action"]) for e in audits) == [
        (ADULT, "release_note.publish"), (KIDS, "release_note.publish")]
    for e in audits:
        assert_event_conforms(e)
        assert (e.payload["actor_type"], e.payload["actor_id"], e.payload["actor_role"]) == (
            "system", "system:release", None)
    adult_audit = next(e for e in audits if e.payload["after"]["slug"] == ADULT)
    assert adult_audit.payload["after"] == {"slug": ADULT, "status": "published", "items": 6, "audience": "existing",
                                            "segments": {"age": ["teens", "adults"]}, "illustration": "s7-social",
                                            "published_at": adult["published_at"]}
    kids_audit = next(e for e in audits if e.payload["after"]["slug"] == KIDS)
    assert kids_audit.payload["after"]["illustration"] == "s7-family"
    dumped = json.dumps([e.payload for e in audits], ensure_ascii=False)
    assert "Друзья по нику" not in dumped and "Oila ligasi" not in dumped


# ---------------------------------------------------------------- ученики: кто что видит при следующем входе


async def test_learners_see_release_note_once_at_next_login(env) -> None:
    welcome = (await active_note(env, WELCOME))["release_note_id"]
    adult = await existing_after_s6(env, welcome, "ru", "adults")
    assert (adult["slug"], adult["illustration"]) == (ADULT, "s7-social")
    assert adult["title"] == "Учимся вместе: друзья, лиги и дуэли"
    assert [i["link"] for i in adult["items"]] == ["friends", "leagues", "duels", "friends", "referrals", "friends"]
    teen = await existing_after_s6(env, welcome, "uz", "teens")
    assert teen["slug"] == ADULT and teen["items"][0]["title"] == "Nik orqali doʻstlar"
    kid = await existing_after_s6(env, welcome, "ru", "kids")
    assert (kid["slug"], kid["illustration"]) == (KIDS, "s7-family") and kid["items"][0]["title"] == "Лига семьи"
    # новичок после выкладки: знакомство; заметки релизов — не «новое» для него
    newbie = uuid.uuid4()
    r = (await env.for_me(newbie)).json()
    assert r["mode"] == "welcome" and [n["slug"] for n in r["notes"]] == [WELCOME]


async def existing_after_s6(env, welcome: str, lang: str, age: str) -> dict:
    """Ученик занимается давно и уже видел знакомство и заметку 6.1 своего сегмента: при следующем входе — одна
    заметка релиза 7, один раз."""
    user = uuid.uuid4()
    s6 = await active_note(env, "s6-heroes-kids" if age == "kids" else "s6-heroes")
    await env.seen(user, [welcome, s6["release_note_id"]])
    r = await env.for_me(user, onboarded_at=BEFORE_RELEASE, lang=lang, age=age)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "updates" and len(body["notes"]) == 1, body
    n = body["notes"][0]
    assert (await env.seen(user, [n["release_note_id"]])).status_code == 204
    assert await ids_for_me(env, user, onboarded_at=BEFORE_RELEASE, lang=lang, age=age) == ("none", [])
    return n


# ---------------------------------------------------------------- обратимость и повторная выкладка


async def test_downgrade_removes_release_notes(env) -> None:
    adult = await active_note(env, ADULT)
    viewer = uuid.uuid4()
    await env.seen(viewer, [adult["release_note_id"]])
    assert env.runtime.relay is not None
    await env.runtime.relay.stop()  # события новой выкладки остаются в outbox неотправленными
    try:
        await _alembic(env, "downgrade", "0008")
        assert await scalar(env, "SELECT count(*) FROM release_notes WHERE slug LIKE 's7-%'") == 0
        assert await scalar(env, "SELECT count(*) FROM release_note_views WHERE user_id = :u", u=viewer) == 0
        assert await scalar(env, "SELECT count(*) FROM release_notes WHERE slug LIKE 's6-%'") == 2  # 6.1 не тронут
        await _alembic(env, "upgrade", "head")
        assert await outbox_unsent(env, PUBLISHED) == 2
        # откат до отправки — события публикации удалённых заметок не уходят, аудит остаётся
        await _alembic(env, "downgrade", "0008")
        assert await outbox_unsent(env, PUBLISHED) == 0
        assert await outbox_unsent(env, AUDIT) == 2
        await _alembic(env, "upgrade", "head")
    finally:
        env.runtime.relay.start()
    assert (await active_note(env, ADULT))["status"] == "published"
    # опубликованная заметка неизменна: триггер вернулся после отката
    with pytest.raises(Exception, match="release note"):
        async with env.runtime.transaction() as s:
            await s.execute(text("UPDATE release_notes SET illustration = NULL WHERE slug = 's7-social'"))


async def test_upgrade_fails_when_staff_note_holds_the_label(env) -> None:
    await _alembic(env, "downgrade", "0008")
    taken = await create(env, note(KIDS))
    with pytest.raises(RuntimeError, match="label is taken"):
        await _alembic(env, "upgrade", "head")
    assert await scalar(env, "SELECT count(*) FROM release_notes WHERE published_by = 'system:release' "
                             "AND slug LIKE 's7-%'") == 0
    r = await env.c.post(f"/admin/v1/release-notes/{taken['release_note_id']}/archive",
                         json={"reason": "Освободить метку"}, headers=env.h(WN_PUBLISHER))
    assert r.status_code == 201
    await _alembic(env, "upgrade", "head")
    assert (await active_note(env, KIDS))["published_by"] == "system:release"


def test_migration_notes_pass_service_checks() -> None:
    m = migration()
    assert [m.checked(n)["slug"] for n in m.NOTES] == [ADULT, KIDS]
    broken = {**m.NOTES[0], "items": [{**m.NOTES[0]["items"][0], "link": "pair_rooms"}]}
    with pytest.raises(RuntimeError, match="invalid content"):
        m.checked(broken)
    too_long = {**m.NOTES[0], "items": [{**m.NOTES[0]["items"][0],
                                         "text": {"ru": "д" * (rn.ITEM_TEXT_MAX + 1), "uz": "x"}}]}
    with pytest.raises(RuntimeError, match="invalid content"):
        m.checked(too_long)
    empty_uz = {**m.NOTES[1], "title": {"ru": "Заголовок", "uz": ""}}
    with pytest.raises(RuntimeError, match="RELEASE_NOTE_TRANSLATION_MISSING"):
        m.checked(empty_uz)
