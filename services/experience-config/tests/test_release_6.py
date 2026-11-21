"""Релиз 6.1: иллюстрации «Что нового» (ключ из каталога, миграция 0006) и автопубликация заметки релиза при выкладке
(миграция 0007): s6-heroes (подростки и взрослые), s6-heroes-kids (дети), иллюстрация приветствия, архив черновика
2026.11; событие публикации и аудит — как у публикации сотрудником; обратимость."""

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
from exp_actors import WN_EDITOR, WN_PUBLISHER
from sqlalchemy import text
from test_release_notes import BASE, CYRILLIC, DRAFT, WELCOME, _alembic, any_note, create, ids_for_me, note, publish
from test_release_notes import staff_note as active_note

from tilhero_common.testing import assert_event_conforms
from tilhero_experience.domain import release_notes as rn

ADULT, KIDS = "s6-heroes", "s6-heroes-kids"
BEFORE_RELEASE = "2026-11-18T07:00:00Z"  # ученик занимается с 18.11 — до выкладки 6.1
PUBLISHED = "experience.release_note.published.v1"
AUDIT = "admin.audit.recorded.v1"
# Апострофы узбекской латиницы: oʻ / gʻ — только U+02BB (как в сиде 0004); ’ — лишь в «TilHero’da» (как «TilHero’ga»)
WRONG_APOSTROPHES = re.compile("['`‘ʼ]")


def migration() -> ModuleType:
    path = Path(SERVICE_DIR) / "migrations" / "versions" / "0007_release_6.py"
    spec = importlib.util.spec_from_file_location("exp_migration_0007", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def texts(n: dict[str, Any], lang: str) -> list[str]:
    return [n["title"][lang], *(i[p][lang] for i in n["items"] for p in ("title", "text"))]


def expected_items() -> list[tuple[str, str, str, str]]:
    """(иконка, переход, заголовок RU, заголовок UZ) пунктов s6-heroes — по заданию владельца."""
    return [
        ("hero", "heroes", "Выберите героя", "Qahramon tanlang"),
        ("gift", "home", "Тилы и задания дня", "Tillar va kunlik vazifalar"),
        ("flame", "shop", "Серия под защитой", "Seriya himoyada"),
        ("book", "review", "Повторение дня", "Kun takrori"),
        ("mic", "dictionary", "Произношение", "Talaffuz"),
        ("book", "reading", "Чтение с переводом", "Tarjimali oʻqish"),
    ]


async def outbox_unsent(env, event_type: str) -> int:
    """Неотправленные события заметок релиза: публикация (payload.slug) или аудит (payload.after.slug)."""
    async with env.runtime.transaction() as s:
        return (await s.execute(text(
            "SELECT count(*) FROM outbox WHERE published_at IS NULL AND event_type = :t AND COALESCE("
            "envelope -> 'payload' ->> 'slug', envelope -> 'payload' -> 'after' ->> 'slug') "
            "IN ('s6-heroes', 's6-heroes-kids')"), {"t": event_type})).scalar_one()


async def scalar(env, sql: str, **params: Any) -> Any:
    async with env.runtime.transaction() as s:
        return (await s.execute(text(sql), params)).scalar()


# ---------------------------------------------------------------- (а), (б): заметки релиза опубликованы при выкладке


async def test_release_notes_published_at_deploy(env) -> None:
    adult, kids = await active_note(env, ADULT), await active_note(env, KIDS)
    for n, age in ((adult, ["teens", "adults"]), (kids, ["kids"])):
        assert (n["status"], n["audience"], n["segments"], n["illustration"]) == (
            "published", "existing", {"age": age}, "s6-heroes")
        assert n["published_by"] == n["created_by"] == "system:release"
        # published_at — время миграции: после старта теста-фикстуры, до готовности окружения
        published_at = datetime.fromisoformat(n["published_at"].replace("Z", "+00:00"))
        assert published_at <= env.ready_at and (env.ready_at - published_at).total_seconds() < 60
        assert n["title"] == {"ru": "Новое в TilHero: герои, тилы и повторения",
                              "uz": "TilHero’da yangi: qahramonlar, tillar va takrorlash"}
        assert [(i["icon"], i["link"]) for i in n["items"]] == [(e[0], e[1]) for e in expected_items()]
        # та же проверка, что у заметки из админки (переводы, лимиты длины, каталог)
        content = rn.NoteContent.model_validate(
            {k: n[k] for k in ("slug", "title", "items", "audience", "segments", "illustration")})
        assert rn.dump_content(content)["items"] == n["items"]
        assert rn.missing_translations(n["title"], n["items"]) == []
        assert len(n["title"]["ru"]) <= rn.TITLE_MAX and len(n["title"]["uz"]) <= rn.TITLE_MAX
        assert all(len(i["text"][lang]) <= rn.ITEM_TEXT_MAX for i in n["items"] for lang in rn.LOCALES)
        uz = texts(n, "uz")
        assert not any(CYRILLIC.search(t) for t in uz), uz
        assert not any(WRONG_APOSTROPHES.search(t) for t in uz), uz
        assert all("’" not in t or t.startswith("TilHero’da") for t in uz), uz
        assert any("ʻ" in t for t in uz)
    assert [(i["title"]["ru"], i["title"]["uz"]) for i in adult["items"]] == [(e[2], e[3]) for e in expected_items()]
    assert adult["items"][0]["text"]["ru"] == ("9 героев растут вместе с вами: новая ступень — за навыки, "
                                               "подтверждённые в уроках. Сменить героя можно в любой момент.")
    assert adult["items"][2]["text"]["uz"].endswith("yana ikkitasi — oʻqishni boshlagan doʻst uchun.")
    assert "«Talaffuz qilish»" in adult["items"][4]["text"]["uz"]  # кнопка — как в Mini App (pn.button)


async def test_kids_note_is_soft_without_referrals_and_with_parent() -> None:
    """Детская версия: на «ты», без давления, дети не приглашают друзей, голос — с разрешения родителя."""
    m = migration()
    kids = next(n for n in m.NOTES if n["slug"] == KIDS)
    ru, uz = " ".join(texts(kids, "ru")), " ".join(texts(kids, "uz"))
    assert not re.search(r"\b(вы|вас|вам|ваш\w*|выберите|нажмите)\b", ru, re.IGNORECASE), ru
    assert not re.search(r"\bsiz\w*|\w+ingiz\b", uz, re.IGNORECASE), uz
    assert "друг" not in ru.lower() and "doʻst" not in uz.lower()  # без приглашений и рефералов
    for pressure in ("потер", "теря", "провал", "штраф", "сгор", "yoʻqot", "muvaffaqiyatsiz", "jarima"):
        assert pressure not in ru.lower() and pressure not in uz.lower(), pressure
    mic = next(i for i in kids["items"] if i["icon"] == "mic")
    assert "С разрешения родителя" in mic["text"]["ru"] and "Ota-onang ruxsat bersa" in mic["text"]["uz"]
    freeze = next(i for i in kids["items"] if i["link"] == "shop")
    assert freeze["text"]["ru"].startswith("Заморозка сохранит серию, если пропустишь день.")
    # пункты те же, что у взрослых (иконка и переход)
    adult = next(n for n in m.NOTES if n["slug"] == ADULT)
    assert [(i["icon"], i["link"]) for i in kids["items"]] == [(i["icon"], i["link"]) for i in adult["items"]]
    assert [n["id"] for n in m.NOTES] == [m.ADULT_ID, m.KIDS_ID] and m.ACTOR == rn.RELEASE_ACTOR


async def test_events_like_staff_publication(env) -> None:
    """В outbox миграции — событие публикации той же формы, что у сотрудника (notifications положит заметку в центр
    уведомлений), и аудит system:release без текстов заметок."""
    adult, kids = await active_note(env, ADULT), await active_note(env, KIDS)
    events = [e for e in env.migration_events if e.event_type == PUBLISHED and e.payload["slug"] in (ADULT, KIDS)]
    assert len(events) == 2
    by_slug = {e.payload["slug"]: e for e in events}
    for n in (adult, kids):
        e = by_slug[n["slug"]]
        assert e.producer == "experience-config"
        assert e.payload == {"release_note_id": n["release_note_id"], "slug": n["slug"], "audience": "existing",
                             "segments": n["segments"], "published_at": n["published_at"]}
        assert e.payload == rn.published_payload(uuid.UUID(n["release_note_id"]), n["slug"], n["audience"],
                                                 n["segments"], datetime.fromisoformat(
                                                     n["published_at"].replace("Z", "+00:00")))
        assert_event_conforms(e)
    audits = [e for e in env.migration_events if e.event_type == AUDIT and e.payload["object_type"] == "release_note"
              and not e.payload["after"]["slug"].startswith("s7-")]  # релиз 7 — test_release_7.py
    for e in audits:
        assert_event_conforms(e)
        assert (e.payload["actor_type"], e.payload["actor_id"], e.payload["actor_role"]) == (
            "system", "system:release", None)
    actions = sorted((e.payload["after"]["slug"], e.payload["action"]) for e in audits)
    assert actions == sorted([(ADULT, "release_note.publish"), (KIDS, "release_note.publish"),
                              (WELCOME, "release_note.update"), (DRAFT, "release_note.archive")])
    publish_audit = next(e for e in audits if e.payload["after"]["slug"] == ADULT)
    assert publish_audit.payload["after"] == {"slug": ADULT, "status": "published", "items": 6,
                                              "audience": "existing", "segments": {"age": ["teens", "adults"]},
                                              "illustration": "s6-heroes", "published_at": adult["published_at"]}
    welcome_audit = next(e for e in audits if e.payload["after"]["slug"] == WELCOME)
    assert (welcome_audit.payload["before"], welcome_audit.payload["after"]) == (
        {"illustration": None}, {"slug": WELCOME, "changed": ["illustration"], "illustration": "welcome"})
    dumped = json.dumps([e.payload for e in audits], ensure_ascii=False)
    assert "Выберите героя" not in dumped and "Qahramon" not in dumped


# ---------------------------------------------------------------- (в), (г)


async def test_welcome_gets_illustration_and_old_draft_archived(env) -> None:
    welcome, draft = await active_note(env, WELCOME), await any_note(env, DRAFT)
    assert welcome["illustration"] == "welcome" and welcome["published_by"] == "system:seed"
    assert welcome["updated_by"] == "system:release"
    assert (draft["status"], draft["archived_by"]) == ("archived", "system:release")
    # опубликованная заметка снова неизменна: триггер вернулся после UPDATE миграции
    with pytest.raises(Exception, match="release note"):
        async with env.runtime.transaction() as s:
            await s.execute(text("UPDATE release_notes SET illustration = NULL WHERE slug = 'welcome-1'"))


# ---------------------------------------------------------------- ученики: кто что видит при следующем входе


async def test_learners_see_release_note_once_at_next_login(env) -> None:
    welcome = (await active_note(env, WELCOME))["release_note_id"]

    async def existing(lang: str, age: str) -> dict:
        user = uuid.uuid4()
        await env.seen(user, [welcome])  # занимается давно: знакомство уже видел
        r = await env.for_me(user, onboarded_at=BEFORE_RELEASE, lang=lang, age=age)
        assert r.status_code == 200, r.text
        body = r.json()
        # с 18.11 вышли релизы 6.1 и 7 — обе заметки сегмента, новая первой
        assert body["mode"] == "updates" and len(body["notes"]) == 2, body
        assert body["notes"][0]["slug"].startswith("s7-social"), body
        n = body["notes"][1]
        ids = [x["release_note_id"] for x in body["notes"]]
        assert (await env.seen(user, ids)).status_code == 204
        assert await ids_for_me(env, user, onboarded_at=BEFORE_RELEASE, lang=lang, age=age) == ("none", [])
        return n

    adult = await existing("ru", "adults")
    assert (adult["slug"], adult["illustration"]) == (ADULT, "s6-heroes")
    assert adult["title"] == "Новое в TilHero: герои, тилы и повторения"
    assert [i["link"] for i in adult["items"]] == ["heroes", "home", "shop", "review", "dictionary", "reading"]
    teen = await existing("uz", "teens")
    assert teen["slug"] == ADULT and teen["items"][0]["title"] == "Qahramon tanlang"
    kid = await existing("ru", "kids")
    assert (kid["slug"], kid["illustration"]) == (KIDS, "s6-heroes") and kid["items"][0]["title"] == "Выбери героя"
    # новичок после выкладки: знакомство с иллюстрацией; заметка релиза — не «новое» для него
    newbie = uuid.uuid4()
    r = (await env.for_me(newbie)).json()
    assert r["mode"] == "welcome" and [(n["slug"], n["illustration"]) for n in r["notes"]] == [(WELCOME, "welcome")]
    await env.seen(newbie, [welcome])
    assert await ids_for_me(env, newbie) == ("none", [])


# ---------------------------------------------------------------- иллюстрация в API сотрудника


async def test_illustration_from_catalog_only(env) -> None:
    n = await create(env, note(illustration="s6-heroes"))
    assert n["illustration"] == "s6-heroes"
    for bad in ("nope", "S6-heroes", "../x", "", 1):
        r = await env.c.post(BASE, json=note(f"bad-{uuid.uuid4().hex[:6]}", illustration=bad),
                             headers=env.h(WN_EDITOR))
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", (bad, r.text)
    # без поля — без иллюстрации (клиенты до 6.1); правка без поля не снимает иллюстрацию черновика
    plain = await create(env, note("plain-1"))
    assert plain["illustration"] is None
    kept = await create(env, note("kept-1", illustration="welcome"))
    r = await env.c.put(f"{BASE}/{kept['release_note_id']}",
                        json={**note("kept-1", title={"ru": "Правка", "uz": "Tahrir"}), "expected_version": 1},
                        headers=env.h(WN_EDITOR))
    assert r.status_code == 200 and r.json()["illustration"] == "welcome" and r.json()["title"]["ru"] == "Правка"
    # правка черновика меняет иллюстрацию (и снимает её)
    r = await env.c.put(f"{BASE}/{n['release_note_id']}", json={**note(illustration="welcome"), "expected_version": 1},
                        headers=env.h(WN_EDITOR))
    assert r.status_code == 200 and r.json()["illustration"] == "welcome" and r.json()["version"] == 2
    r = await env.c.put(f"{BASE}/{n['release_note_id']}", json={**note(illustration=None), "expected_version": 2},
                        headers=env.h(WN_EDITOR))
    assert r.status_code == 200 and r.json()["illustration"] is None and r.json()["version"] == 3
    r = await env.c.put(f"{BASE}/{n['release_note_id']}",
                        json={**note(illustration="s6-heroes"), "expected_version": 3}, headers=env.h(WN_EDITOR))
    assert r.status_code == 200
    pub = await publish(env, r.json())
    assert pub.status_code == 201 and pub.json()["illustration"] == "s6-heroes"
    learner = uuid.uuid4()
    await env.seen(learner, [(await active_note(env, WELCOME))["release_note_id"]])
    body = (await env.for_me(learner)).json()
    assert [(x["slug"], x["illustration"]) for x in body["notes"]] == [("2026.12", "s6-heroes")]
    await env.flush()
    create_audit = next(e for e in env.events(AUDIT) if e.payload["action"] == "release_note.create")
    assert create_audit.payload["after"]["illustration"] == "s6-heroes"


async def test_publish_rechecks_illustration_and_db_format(env) -> None:
    """Защита в глубину: черновик с ключом не из каталога (в обход API) не публикуется; БД не примет ключ не того
    формата."""
    n = await create(env, note("bypass-1"))
    async with env.runtime.transaction() as s:
        await s.execute(text("UPDATE release_notes SET illustration = 'unknown-key' WHERE id = :id"),
                        {"id": uuid.UUID(n["release_note_id"])})
    r = await publish(env, n)
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", r.text
    assert r.json()["details"]["errors"][0]["loc"] == ["note", "illustration"]
    with pytest.raises(Exception, match="ck_release_notes_illustration"):
        async with env.runtime.transaction() as s:
            await s.execute(text("UPDATE release_notes SET illustration = '../x.webp' WHERE id = :id"),
                            {"id": uuid.UUID(n["release_note_id"])})


# ---------------------------------------------------------------- обратимость и повторная выкладка


async def test_downgrade_removes_release_notes_and_restores_draft(env) -> None:
    adult = await active_note(env, ADULT)
    viewer = uuid.uuid4()
    await env.seen(viewer, [adult["release_note_id"]])
    assert env.runtime.relay is not None
    await env.runtime.relay.stop()  # события новой выкладки остаются в outbox неотправленными
    try:
        await _alembic(env, "downgrade", "0006")
        assert await scalar(env, "SELECT count(*) FROM release_notes WHERE published_by = 'system:release'") == 0
        assert await scalar(env, "SELECT count(*) FROM release_note_views WHERE user_id = :u", u=viewer) == 0
        assert await scalar(env, "SELECT status FROM release_notes WHERE slug = :s", s=DRAFT) == "draft"
        assert await scalar(env, "SELECT archived_by FROM release_notes WHERE slug = :s", s=DRAFT) is None
        assert await scalar(env, "SELECT illustration FROM release_notes WHERE slug = :s", s=WELCOME) is None
        # повторная выкладка: всё на месте, события — в outbox
        await _alembic(env, "upgrade", "head")
        assert await outbox_unsent(env, PUBLISHED) == 2
        assert await scalar(env, "SELECT status FROM release_notes WHERE slug = :s", s=DRAFT) == "archived"
        # откат до отправки — события публикации удалённых заметок не уходят, аудит остаётся
        await _alembic(env, "downgrade", "0006")
        assert await outbox_unsent(env, PUBLISHED) == 0
        assert await outbox_unsent(env, AUDIT) == 2
        await _alembic(env, "upgrade", "head")
    finally:
        env.runtime.relay.start()
    assert (await active_note(env, ADULT))["status"] == "published"
    assert (await active_note(env, WELCOME))["illustration"] == "welcome"


async def test_upgrade_fails_when_staff_note_holds_the_label(env) -> None:
    """Метку s6-heroes заняла действующая заметка сотрудника — выкладка падает с понятной ошибкой, ничего не
    публикуется; после архива той заметки выкладка проходит."""
    await _alembic(env, "downgrade", "0006")
    taken = await create(env, note(ADULT))
    with pytest.raises(RuntimeError, match="label is taken"):
        await _alembic(env, "upgrade", "head")
    assert await scalar(env, "SELECT count(*) FROM release_notes WHERE published_by = 'system:release'") == 0
    assert await scalar(env, "SELECT status FROM release_notes WHERE slug = :s", s=DRAFT) == "draft"
    r = await env.c.post(f"{BASE}/{taken['release_note_id']}/archive", json={"reason": "Освободить метку"},
                         headers=env.h(WN_PUBLISHER))
    assert r.status_code == 201
    await _alembic(env, "upgrade", "head")
    assert (await active_note(env, ADULT))["published_by"] == "system:release"


def test_migration_notes_pass_service_checks() -> None:
    m = migration()
    assert [m.checked(n)["slug"] for n in m.NOTES] == [ADULT, KIDS]
    broken = {**m.NOTES[0], "items": [{**m.NOTES[0]["items"][0], "link": "events"}]}
    with pytest.raises(RuntimeError, match="invalid content"):
        m.checked(broken)
    empty_uz = {**m.NOTES[0], "title": {"ru": "Заголовок", "uz": ""}}
    with pytest.raises(RuntimeError, match="RELEASE_NOTE_TRANSLATION_MISSING"):
        m.checked(empty_uz)
    long_text = {**m.NOTES[0], "items": [{**m.NOTES[0]["items"][0], "text": {"ru": "я" * 201, "uz": "x"}}]}
    with pytest.raises(RuntimeError, match="invalid content"):
        m.checked(long_text)
