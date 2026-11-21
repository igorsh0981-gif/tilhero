"""«Что нового» TilHero (AT-11): staff API заметок (черновик → публикация → снятие, RU/UZ, аудитории и сегменты,
событие публикации, аудит, неизменность опубликованной) и ученический API (for-me, seen, feed) через telegram-bff."""

from __future__ import annotations

import asyncio
import copy
import json
import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from exp_actors import DASHBOARD, EDITOR, PUBLISHER, READER, SUPPORT, WN_EDITOR, WN_PUBLISHER
from sqlalchemy import text

from tilhero_common.testing import assert_event_conforms
from tilhero_experience.domain import release_notes as rn

BASE = "/admin/v1/release-notes"
FOR_ME = "/internal/v1/release-notes/for-me"
SEEN = "/internal/v1/release-notes/seen"
FEED = "/internal/v1/release-notes/feed"
WELCOME, DRAFT = "welcome-1", "2026.11"
CATALOG = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "release-notes.json"
WHATSNEW_DIR = Path(__file__).resolve().parents[3] / "apps" / "telegram-miniapp" / "public" / "whatsnew"
NOTE_KEYS = {"release_note_id", "slug", "title", "items", "audience", "illustration", "published_at"}
RELEASE_6 = ("s6-heroes", "s6-heroes-kids")  # заметки релиза 6.1 (миграция 0007), опубликованы при выкладке
CYRILLIC = re.compile(r"[А-Яа-яЁё]")


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def note(slug: str = "2026.12", **over: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "slug": slug,
        "title": {"ru": "Декабрь 2026", "uz": "2026-yil dekabr"},
        "items": [
            {"title": {"ru": "Разговор с героем", "uz": "Qahramon bilan suhbat"},
             "text": {"ru": "Пять минут живой речи после урока.", "uz": "Darsdan keyin besh daqiqa jonli nutq."},
             "link": "lessons", "icon": "chat"},
            {"title": {"ru": "Без ссылки", "uz": "Havolasiz"}, "text": {"ru": "Текст.", "uz": "Matn."}},
        ],
        "audience": "existing",
    }
    body.update(over)
    return body


async def create(env, body: dict | None = None, actor=WN_EDITOR) -> dict:
    r = await env.c.post(BASE, json=body or note(), headers=env.h(actor))
    assert r.status_code == 201, r.text
    return r.json()


async def publish(env, n: dict, reason: str = "Релиз декабря", actor=WN_PUBLISHER, **headers: str):
    return await env.c.post(f"{BASE}/{n['release_note_id']}/publish",
                            json={"expected_version": n["version"], "reason": reason},
                            headers=env.h(actor, **headers))


async def published(env, slug: str, **over: Any) -> dict:
    n = await create(env, note(slug, **over))
    r = await publish(env, n)
    assert r.status_code == 201, r.text
    return r.json()


async def archive(env, n: dict, reason: str = "Снять с показа"):
    return await env.c.post(f"{BASE}/{n['release_note_id']}/archive", json={"reason": reason},
                            headers=env.h(WN_PUBLISHER))


async def staff_note(env, slug: str) -> dict:
    items = (await env.c.get(BASE, params={"limit": 100}, headers=env.h(WN_EDITOR))).json()["items"]
    return next(n for n in items if n["slug"] == slug and n["status"] != "archived")


async def any_note(env, slug: str) -> dict:
    """Последняя заметка с меткой — в любом статусе (и архивная)."""
    items = (await env.c.get(BASE, params={"limit": 100}, headers=env.h(WN_EDITOR))).json()["items"]
    return next(n for n in items if n["slug"] == slug)


async def feed(env, lang: str = "ru", age: str = "adults", **params: Any):
    return await env.c.get(FEED, params={"lang": lang, "age": age, **params}, headers=env.learner(uuid.uuid4()))


async def ids_for_me(env, user, **kw) -> tuple[str, list[str]]:
    r = await env.for_me(user, **kw)
    assert r.status_code == 200, r.text
    return r.json()["mode"], [n["slug"] for n in r.json()["notes"]]


def audits(env, action: str | None = None) -> list:
    return [e for e in env.events("admin.audit.recorded.v1")
            if e.payload["object_type"] == "release_note" and (action is None or e.payload["action"] == action)]


# ---------------------------------------------------------------- каталог и сид


def test_catalog_matches_contract() -> None:
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    assert tuple(cat["locales"]) == rn.LOCALES
    assert tuple(cat["audiences"]) == rn.AUDIENCES
    assert tuple(cat["segments"]["age"]) == rn.AGE_SEGMENTS and tuple(cat["segments"]["ui_lang"]) == rn.UI_LANGS
    assert tuple(cat["routes"]) == rn.ROUTES
    assert tuple(cat["icons"]) == rn.ICONS
    lim = cat["limits"]
    assert lim["slug_pattern"] == rn.SLUG_PATTERN
    assert (lim["title_max"], lim["item_title_max"], lim["item_text_max"]) == (
        rn.TITLE_MAX, rn.ITEM_TITLE_MAX, rn.ITEM_TEXT_MAX)
    assert (lim["items_min"], lim["items_max"], lim["client_max_notes"]) == (
        rn.ITEMS_MIN, rn.ITEMS_MAX, rn.CLIENT_MAX_NOTES)
    # Literal-типы схемы совпадают с каталогом
    assert rn.Route.__args__ == rn.ROUTES and rn.IconName.__args__ == rn.ICONS  # type: ignore[attr-defined]
    assert rn.Audience.__args__ == rn.AUDIENCES  # type: ignore[attr-defined]
    # релиз 6.1: иллюстрации — ключ, размер; файл лежит в Mini App и действительно такого размера (16:9)
    assert {i["key"]: (i["width"], i["height"]) for i in cat["illustrations"]} == rn.ILLUSTRATIONS
    assert rn.Illustration.__args__ == tuple(rn.ILLUSTRATIONS)  # type: ignore[attr-defined]
    assert lim["illustration_pattern"] == rn.ILLUSTRATION_PATTERN
    for key, (width, height) in rn.ILLUSTRATIONS.items():
        assert re.fullmatch(rn.ILLUSTRATION_PATTERN, key), key
        assert width * 9 == height * 16, key
        assert webp_size(WHATSNEW_DIR / f"{key}.webp") == (width, height), key
    assert {"heroes", "shop", "badges", "game_history", "game_settings", "dictionary", "reading"} <= set(rn.ROUTES)


def webp_size(path: Path) -> tuple[int, int]:
    """Ширина и высота WebP по заголовку (VP8 / VP8L / VP8X) — без зависимостей."""
    head = path.read_bytes()[:30]
    assert head[:4] == b"RIFF" and head[8:12] == b"WEBP", path
    chunk = head[12:16]
    if chunk == b"VP8 ":
        return int.from_bytes(head[26:28], "little") & 0x3FFF, int.from_bytes(head[28:30], "little") & 0x3FFF
    if chunk == b"VP8L":
        bits = int.from_bytes(head[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    assert chunk == b"VP8X", chunk
    return int.from_bytes(head[24:27], "little") + 1, int.from_bytes(head[27:30], "little") + 1


async def test_seed_welcome_published_and_draft_archived_by_release(env) -> None:
    welcome, draft = await staff_note(env, WELCOME), await any_note(env, DRAFT)
    assert (welcome["status"], welcome["audience"], welcome["segments"]) == ("published", "new", {})
    assert welcome["published_by"] == "system:seed" and welcome["published_at"].endswith("Z")
    assert welcome["illustration"] == "welcome"  # релиз 6.1 (миграция 0007)
    assert [(i["icon"], i["link"]) for i in welcome["items"]] == [
        ("hero", "progress"), ("clock", "lessons"), ("book", "review"), ("calendar", "schedule"), ("users", "family")]
    assert welcome["title"] == {"ru": "Добро пожаловать в TilHero", "uz": "TilHero’ga xush kelibsiz"}
    # черновик 2026.11 устарел — релиз 6.1 архивировал его (содержание покрыто приветствием и s6-heroes)
    assert (draft["status"], draft["audience"], draft["published_at"]) == ("archived", "existing", None)
    assert draft["archived_by"] == "system:release" and draft["archived_at"].endswith("Z")
    for n in (welcome, draft):
        # содержимое сида проходит ту же проверку, что и заметка из админки, переводы полные
        content = rn.NoteContent.model_validate(
            {k: n[k] for k in ("slug", "title", "items", "audience", "illustration")})
        assert rn.dump_content(content)["items"] == n["items"]
        assert rn.missing_translations(n["title"], n["items"]) == []
        uz = [n["title"]["uz"], *(i[p]["uz"] for i in n["items"] for p in ("title", "text"))]
        assert not any(CYRILLIC.search(t) for t in uz), uz  # узбекский — латиница
        ru = " ".join([n["title"]["ru"], *(i[p]["ru"] for i in n["items"] for p in ("title", "text"))]).lower()
        for pressure in ("потеряешь", "потеряете", "провал", "серия сгорит"):  # без давления (CONVENTIONS §8)
            assert pressure not in ru
    # туристический сид «Бот турист» не перенесён
    all_slugs = [n["slug"] for n in (await env.c.get(BASE, headers=env.h(WN_EDITOR))).json()["items"]]
    assert sorted(all_slugs) == sorted([WELCOME, DRAFT, *RELEASE_6])
    # архив не виден ученикам; лента взрослого — заметка релиза 6.1 и welcome-1
    assert [n["slug"] for n in (await feed(env)).json()["items"]] == ["s6-heroes", WELCOME]


# ---------------------------------------------------------------- AT-11: for-me и seen


async def test_welcome_after_first_registration_then_nothing(env) -> None:
    user = uuid.uuid4()
    r = await env.for_me(user, onboarded_at=iso(datetime.now(UTC)))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "welcome" and [n["slug"] for n in body["notes"]] == [WELCOME]
    n = body["notes"][0]
    assert set(n) == NOTE_KEYS and n["audience"] == "new" and n["illustration"] == "welcome"
    assert n["title"] == "Добро пожаловать в TilHero"
    assert [i["title"] for i in n["items"]] == [
        "Герой растёт вместе с вами", "Урок — 20 минут", "Повторения в нужный момент", "Ваш график и напоминания",
        "Учитесь всей семьёй"]
    assert all(set(i) == {"title", "text", "link", "icon"} for i in n["items"])
    uz = (await env.for_me(user, lang="uz")).json()["notes"][0]
    assert uz["title"] == "TilHero’ga xush kelibsiz" and uz["items"][1]["title"] == "Dars — 20 daqiqa"
    # показали → отметка на сервере → больше не показываем (и после переустановки Mini App)
    assert (await env.seen(user, [n["release_note_id"]])).status_code == 204
    assert await ids_for_me(env, user) == ("none", [])
    again = await env.seen(user, [n["release_note_id"]])  # повтор — идемпотентно
    assert again.status_code == 204
    async with env.runtime.transaction() as s:
        rows = (await s.execute(text("SELECT count(*) FROM release_note_views WHERE user_id = :u"),
                                {"u": user})).scalar()
    assert rows == 1
    # другой ученик своё знакомство ещё не видел
    assert await ids_for_me(env, uuid.uuid4()) == ("welcome", [WELCOME])


async def test_nothing_before_onboarding_is_complete(env) -> None:
    assert (await env.for_me(uuid.uuid4(), onboarded_at=None)).json() == {"mode": "none", "notes": []}


async def test_updates_on_each_next_login(env) -> None:
    user = uuid.uuid4()
    welcome = await staff_note(env, WELCOME)
    await env.seen(user, [welcome["release_note_id"]])
    onboarded = env.onboarded()
    assert await ids_for_me(env, user, onboarded_at=onboarded) == ("none", [])
    a = await published(env, "2026.12", audience="existing")
    b = await published(env, "2026.12b", audience="all")
    await create(env, note("2027.01"))  # черновик не показывается
    assert await ids_for_me(env, user, onboarded_at=onboarded) == ("updates", ["2026.12b", "2026.12"])
    # каждая — один раз
    await env.seen(user, [b["release_note_id"]])
    assert await ids_for_me(env, user, onboarded_at=onboarded) == ("updates", ["2026.12"])
    # снятая с показа заметка пропадает
    assert (await archive(env, a)).status_code == 201
    assert await ids_for_me(env, user, onboarded_at=onboarded) == ("none", [])
    # опубликованное до онбординга ученика — не «новое» для него
    late = uuid.uuid4()
    await env.seen(late, [welcome["release_note_id"]])
    assert await ids_for_me(env, late, onboarded_at=iso(datetime.now(UTC) + timedelta(seconds=5))) == ("none", [])


async def test_welcome_adds_latest_all_and_is_limited_to_five(env) -> None:
    await published(env, "all-1", audience="all")
    await published(env, "all-2", audience="all")
    await published(env, "existing-1", audience="existing")
    user = uuid.uuid4()
    assert await ids_for_me(env, user, onboarded_at=env.onboarded()) == ("welcome", ["all-2", WELCOME])
    for k in range(5):
        await published(env, f"welcome-x{k}", audience="new")
    mode, slugs = await ids_for_me(env, uuid.uuid4())
    assert mode == "welcome" and len(slugs) == rn.CLIENT_MAX_NOTES
    assert slugs == ["welcome-x4", "welcome-x3", "welcome-x2", "welcome-x1", "welcome-x0"]  # новые первыми
    # увидел знакомство — дальше режим updates, новые заметки new ему не показываются
    seen_user = uuid.uuid4()
    await env.seen(seen_user, [(await staff_note(env, WELCOME))["release_note_id"]])
    mode, slugs = await ids_for_me(env, seen_user, onboarded_at=env.onboarded())
    assert mode == "updates" and not any(s.startswith("welcome") for s in slugs)
    assert slugs == ["existing-1", "all-2", "all-1"]


async def test_segments_language_and_age(env) -> None:
    await published(env, "kids-uz", segments={"age": ["kids"], "ui_lang": ["uz"]})
    await published(env, "teens-adults", segments={"age": ["adults", "teens", "adults"]})
    await published(env, "teens-new", audience="new", segments={"age": ["teens"]})
    welcome = (await staff_note(env, WELCOME))["release_note_id"]
    teens_new = (await staff_note(env, "teens-new"))["release_note_id"]

    async def updates(lang: str, age: str) -> list[str]:
        user = uuid.uuid4()
        await env.seen(user, [welcome, teens_new])
        mode, slugs = await ids_for_me(env, user, onboarded_at=env.onboarded(), lang=lang, age=age)
        return slugs if mode == "updates" else []

    assert await updates("uz", "kids") == ["kids-uz"]
    assert await updates("ru", "kids") == []
    assert await updates("ru", "adults") == ["teens-adults"]
    assert await updates("uz", "teens") == ["teens-adults"]
    # знакомство подростка — общее + подростковое; взрослому подростковое не показывается
    assert await ids_for_me(env, uuid.uuid4(), age="teens") == ("welcome", ["teens-new", WELCOME])
    assert await ids_for_me(env, uuid.uuid4(), age="adults") == ("welcome", [WELCOME])
    # лента — тоже по сегменту
    assert [n["slug"] for n in (await feed(env, "uz", "kids")).json()["items"]] == [
        "kids-uz", "s6-heroes-kids", WELCOME]
    assert [n["slug"] for n in (await feed(env, "ru", "teens")).json()["items"]] == [
        "teens-new", "teens-adults", "s6-heroes", WELCOME]
    staff = await staff_note(env, "teens-adults")
    assert staff["segments"] == {"age": ["teens", "adults"]}  # без повторов, в порядке каталога


async def test_seen_ignores_unknown_and_drafts_and_isolates_learners(env) -> None:
    alice, bob = uuid.uuid4(), uuid.uuid4()
    welcome = (await staff_note(env, WELCOME))["release_note_id"]
    draft = await create(env, note("2026.12", audience="all"))
    r = await env.seen(alice, [str(uuid.uuid4()), draft["release_note_id"], welcome, welcome])
    assert r.status_code == 204 and r.content == b""
    async with env.runtime.transaction() as s:
        rows = (await s.execute(text("SELECT release_note_id FROM release_note_views WHERE user_id = :u"),
                                {"u": alice})).scalars().all()
    assert [str(x) for x in rows] == [welcome]  # черновик и неизвестный id не записаны
    # опубликованный позже черновик — для Алисы новый
    assert (await publish(env, draft)).status_code == 201
    assert await ids_for_me(env, alice, onboarded_at=env.onboarded()) == ("updates", ["2026.12"])
    # отметки Алисы не влияют на Боба (ученик — только из sub токена)
    assert await ids_for_me(env, bob, onboarded_at=env.onboarded()) == ("welcome", ["2026.12", WELCOME])


async def test_learner_api_validation_and_auth(env) -> None:
    user = uuid.uuid4()
    welcome = (await staff_note(env, WELCOME))["release_note_id"]
    for body in ({"release_note_ids": []}, {"release_note_ids": [welcome] * 21}, {"release_note_ids": ["x"]},
                 {"release_note_ids": [welcome], "user_id": str(uuid.uuid4())}, {}):
        r = await env.c.post(SEEN, json=body, headers=env.learner(user))
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", body
    bad_segment = ({"age": "adults"}, {"lang": "ru"}, {"lang": "en", "age": "adults"}, {"lang": "ru", "age": "seniors"})
    for params in (*bad_segment, {"lang": "ru", "age": "adults", "onboarded_at": "вчера"}):
        r = await env.c.get(FOR_ME, params=params, headers=env.learner(user))
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", params
    for params in bad_segment:
        assert (await env.c.get(FEED, params=params, headers=env.learner(user))).status_code == 422, params
    ok = {"lang": "ru", "age": "adults"}
    seen_body = {"json": {"release_note_ids": [welcome]}}
    for method, path, kw in (("GET", FOR_ME, {"params": ok}), ("POST", SEEN, seen_body), ("GET", FEED, {"params": ok})):
        assert (await env.c.request(method, path, **kw)).status_code == 401
        for issuer in ("admin-bff", "notifications", "support"):
            r = await env.c.request(method, path, headers=env.learner(user, issuer=issuer), **kw)
            assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", (path, issuer)
    for method, path, kw in (("GET", FOR_ME, {"params": ok}), ("POST", SEEN, seen_body)):
        no_sub = await env.c.request(method, path, headers=env.h(issuer="telegram-bff"), **kw)
        assert no_sub.status_code == 401 and no_sub.json()["code"] == "USER_CONTEXT_REQUIRED"
        not_uuid = await env.c.request(method, path, headers=env.learner("tg-12345"), **kw)
        assert not_uuid.status_code == 401 and not_uuid.json()["code"] == "USER_CONTEXT_INVALID"
    # наивное время онбординга трактуется как UTC
    naive = (datetime.now(UTC) - timedelta(days=1)).replace(tzinfo=None).isoformat()
    assert (await env.for_me(user, onboarded_at=naive)).json()["mode"] == "welcome"


async def test_feed_pagination(env) -> None:
    for k in range(4):
        await published(env, f"2027.0{k + 1}")
    first = (await feed(env, limit=2)).json()
    assert [n["slug"] for n in first["items"]] == ["2027.04", "2027.03"] and first["next_cursor"]
    assert all(set(n) == NOTE_KEYS for n in first["items"])
    assert first["items"][0]["title"] == "Декабрь 2026" and first["items"][0]["items"][0]["link"] == "lessons"
    second = (await feed(env, limit=2, cursor=first["next_cursor"])).json()
    third = (await feed(env, limit=2, cursor=second["next_cursor"])).json()
    assert [n["slug"] for n in second["items"] + third["items"]] == ["2027.02", "2027.01", "s6-heroes", WELCOME]
    assert third["next_cursor"] is None
    uz = (await feed(env, "uz", limit=1)).json()["items"][0]
    assert uz["title"] == "2026-yil dekabr" and uz["items"][0]["text"] == "Darsdan keyin besh daqiqa jonli nutq."
    for cursor in ("@@", "bm9wZQ", "e30"):
        bad = await feed(env, cursor=cursor)
        assert bad.status_code == 400 and bad.json()["code"] == "INVALID_CURSOR", cursor
    for limit in (0, 101):
        assert (await feed(env, limit=limit)).status_code == 422


# ---------------------------------------------------------------- staff: жизненный цикл


async def test_lifecycle_create_edit_publish_archive_with_events(env) -> None:
    n = await create(env, note(segments={"ui_lang": ["uz", "ru"], "age": []}))
    assert n["status"] == "draft" and n["version"] == 1 and n["created_by"] == WN_EDITOR.id
    assert n["segments"] == {"ui_lang": ["ru", "uz"]}
    body = note(title={"ru": "Декабрь", "uz": "Dekabr"}, audience="all", segments={"age": ["kids"]})
    r = await env.c.put(f"{BASE}/{n['release_note_id']}", json={**body, "expected_version": 1},
                        headers=env.h(WN_EDITOR))
    assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["title"] == {"ru": "Декабрь", "uz": "Dekabr"}
    assert (r.json()["audience"], r.json()["segments"]) == ("all", {"age": ["kids"]})
    same = await env.c.put(f"{BASE}/{n['release_note_id']}", json={**body, "expected_version": 2},
                           headers=env.h(WN_EDITOR))
    assert same.status_code == 200 and same.json()["version"] == 2  # повтор той же правки — no-op
    stale = await env.c.put(f"{BASE}/{n['release_note_id']}", json={**note(), "expected_version": 1},
                            headers=env.h(WN_EDITOR))
    assert stale.status_code == 409 and stale.json()["code"] == "RELEASE_NOTE_VERSION_CONFLICT"
    assert stale.json()["details"]["current_version"] == 2
    bad = await publish(env, n)  # сотрудник подтверждал другое содержимое
    assert bad.status_code == 409 and bad.json()["code"] == "RELEASE_NOTE_VERSION_CONFLICT"
    pub = await publish(env, r.json())
    assert pub.status_code == 201, pub.text
    p = pub.json()
    assert p["status"] == "published" and p["published_by"] == WN_PUBLISHER.id and p["published_at"].endswith("Z")
    again = await publish(env, r.json())
    assert again.status_code == 200 and again.json()["published_at"] == p["published_at"]
    edit = await env.c.put(f"{BASE}/{n['release_note_id']}", json={**note(), "expected_version": p["version"]},
                           headers=env.h(WN_EDITOR))
    assert edit.status_code == 409 and edit.json()["code"] == "RELEASE_NOTE_NOT_DRAFT"
    assert "2026.12" in [x["slug"] for x in (await feed(env, age="kids")).json()["items"]]
    arc = await archive(env, n, "Опечатка в тексте")
    assert arc.status_code == 201 and arc.json()["status"] == "archived"
    assert arc.json()["archived_by"] == WN_PUBLISHER.id
    assert (await archive(env, n, "Опечатка в тексте")).status_code == 200
    assert "2026.12" not in [x["slug"] for x in (await feed(env, age="kids")).json()["items"]]
    re_pub = await publish(env, arc.json())
    assert re_pub.status_code == 409 and re_pub.json()["code"] == "RELEASE_NOTE_NOT_DRAFT"
    await create(env)  # метку можно занять новой заметкой

    await env.flush()
    events = env.events("experience.release_note.published.v1")
    assert len(events) == 1
    assert events[0].payload == {"release_note_id": n["release_note_id"], "slug": "2026.12", "audience": "all",
                                 "segments": {"age": ["kids"]}, "published_at": p["published_at"]}
    assert events[0].producer == "experience-config"
    assert_event_conforms(events[0])
    actions = [e.payload["action"] for e in audits(env)]
    assert actions == ["release_note.create", "release_note.update", "release_note.publish", "release_note.archive",
                       "release_note.create"]
    from tilhero_audit.schemas import RecordIn  # запись принимается audit-service как есть

    for e in audits(env):
        assert_event_conforms(e)
        RecordIn.model_validate(e.payload)
        assert e.payload["actor_type"] == "staff" and e.payload["object_type"] == "release_note"
    pub_audit = audits(env, "release_note.publish")[0].payload
    assert pub_audit["reason"] == "Релиз декабря" and pub_audit["object_id"] == n["release_note_id"]
    assert pub_audit["before"] == {"status": "draft"} and pub_audit["after"]["status"] == "published"
    assert audits(env, "release_note.archive")[0].payload["reason"] == "Опечатка в тексте"


async def test_seed_draft_archived_by_release_is_not_published(env) -> None:
    """Черновик сида 2026.11 архивирован релизом 6.1: опубликовать его нельзя, ученики его не видят, метка свободна."""
    draft = await any_note(env, DRAFT)
    pub = await publish(env, draft, reason="Релиз ноября")
    assert pub.status_code == 409 and pub.json()["code"] == "RELEASE_NOTE_NOT_DRAFT"
    user = uuid.uuid4()
    await env.seen(user, [(await staff_note(env, WELCOME))["release_note_id"]])
    assert await ids_for_me(env, user, onboarded_at="2026-11-18T07:00:00Z") == ("updates", ["s6-heroes"])
    assert DRAFT not in [n["slug"] for n in (await feed(env)).json()["items"]]
    again = await create(env, note(DRAFT))  # архив метку не занимает
    assert again["status"] == "draft" and again["release_note_id"] != draft["release_note_id"]


async def test_translation_required(env) -> None:
    async def missing(body: dict, method: str = "POST", path: str = BASE) -> list[str]:
        r = await env.c.request(method, path, json=body, headers=env.h(WN_EDITOR))
        assert r.status_code == 422 and r.json()["code"] == "RELEASE_NOTE_TRANSLATION_MISSING", r.text
        return r.json()["details"]["missing"]

    b = note()
    b["title"]["uz"] = ""
    assert await missing(b) == ["title.uz"]
    b = note()
    del b["items"][1]["text"]["uz"]
    b["items"][0]["title"]["ru"] = "   "
    assert await missing(b) == ["items[0].title.ru", "items[1].text.uz"]
    n = await create(env)
    b = note()
    b["items"][0]["text"]["uz"] = ""
    assert await missing({**b, "expected_version": 1}, "PUT", f"{BASE}/{n['release_note_id']}") == [
        "items[0].text.uz"]
    # черновик без перевода в обход API (SQL) — не публикуется
    async with env.runtime.transaction() as s:
        await s.execute(text("UPDATE release_notes SET title = jsonb_set(title, '{uz}', '\"\"') WHERE id = :id"),
                        {"id": uuid.UUID(n["release_note_id"])})
    r = await publish(env, n)
    assert r.status_code == 422 and r.json()["code"] == "RELEASE_NOTE_TRANSLATION_MISSING"
    assert r.json()["details"]["missing"] == ["title.uz"]
    assert (await staff_note(env, "2026.12"))["status"] == "draft"
    await env.flush()
    assert env.events("experience.release_note.published.v1") == []


async def test_publish_rechecks_route_and_icon(env) -> None:
    """AT-19: запрещённый маршрут (или иконка) не сохраняется (422) и не публикуется, даже если попал в черновик в
    обход API (SQL): публикация перепроверяет заметку той же схемой, что и сохранение."""
    for link in ("catalog", "javascript:alert(1)"):
        bad = note()
        bad["items"][0]["link"] = link
        r = await env.c.post(BASE, json=bad, headers=env.h(WN_EDITOR))
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", link
        assert any("link" in e["loc"] for e in r.json()["details"]["errors"]), r.json()
    n = await create(env)
    for patch, field in (("jsonb_set(items, '{0,link}', '\"https://evil.example\"')", "link"),
                         ("jsonb_set(items, '{1,icon}', '\"plane\"')", "icon")):
        async with env.runtime.transaction() as s:
            await s.execute(text(f"UPDATE release_notes SET items = {patch} WHERE id = :id"),  # noqa: S608
                            {"id": uuid.UUID(n["release_note_id"])})
        r = await publish(env, n)
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", r.text
        assert any(field in e["loc"] for e in r.json()["details"]["errors"]), r.json()
        assert (await env.c.get(f"{BASE}/{n['release_note_id']}", headers=env.h(WN_EDITOR))).json()[
            "status"] == "draft"
        async with env.runtime.transaction() as s:  # вернуть корректное значение для следующего случая
            await s.execute(text("UPDATE release_notes SET items = CAST(:items AS jsonb) WHERE id = :id"),
                            {"items": json.dumps(n["items"]), "id": uuid.UUID(n["release_note_id"])})
    assert (await publish(env, n)).status_code == 201
    await env.flush()
    assert len(env.events("experience.release_note.published.v1")) == 1
    assert [e.payload["action"] for e in audits(env)] == ["release_note.create", "release_note.publish"]


def _bad(mut) -> dict:
    body = copy.deepcopy(note())
    mut(body)
    return body


INVALID = [
    ("7 пунктов", lambda b: b.update(items=b["items"] * 3 + [b["items"][0]])),
    ("0 пунктов", lambda b: b.update(items=[])),
    ("текст > 200", lambda b: b["items"][0]["text"].update(ru="а" * 201)),
    ("заголовок > 80", lambda b: b["title"].update(uz="x" * 81)),
    ("маршрут не из каталога", lambda b: b["items"][0].update(link="https://evil.example")),
    ("маршрут «Бот турист»", lambda b: b["items"][0].update(link="catalog")),
    ("javascript-ссылка", lambda b: b["items"][0].update(link="javascript:alert(1)")),
    ("иконка не из набора", lambda b: b["items"][0].update(icon="skull")),
    ("иконка «Бот турист»", lambda b: b["items"][0].update(icon="plane")),
    ("лишнее поле", lambda b: b["items"][0].update(html="<b>x</b>")),
    ("лишнее поле заметки", lambda b: b.update(css="body{}")),
    ("английский текст", lambda b: b["title"].update(en="December")),
    ("перевод строки", lambda b: b["items"][0]["text"].update(ru="строка\nвторая")),
    ("управляющий символ", lambda b: b["title"].update(ru="Ноябрь\x00")),
    ("bidi-символ", lambda b: b["title"].update(uz="abc‮dcba")),
    *[(f"U+{c:04X}", (lambda ch: lambda b: b["items"][0]["text"].update(uz=f"a{ch}b"))(chr(c)))
      for c in (0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x061C, 0x2060, 0xFEFF, 0x202A, 0x202E, 0x2066, 0x2069)],
    ("плохая метка", lambda b: b.update(slug="../2026")),
    ("аудитория", lambda b: b.update(audience="vip")),
    ("сегмент возраста", lambda b: b.update(segments={"age": ["seniors"]})),
    ("сегмент языка", lambda b: b.update(segments={"ui_lang": ["en"]})),
    ("сегмент сверх схемы", lambda b: b.update(segments={"platform": ["ios"]})),
    ("сегмент строкой", lambda b: b.update(segments={"age": "kids"})),
    ("слишком много возрастов", lambda b: b.update(segments={"age": ["kids", "teens", "adults", "kids"]})),
    ("число вместо текста", lambda b: b["title"].update(ru=12)),
]


@pytest.mark.parametrize(("case", "mut"), INVALID, ids=[c for c, _ in INVALID])
async def test_invalid_content_rejected(env, case: str, mut) -> None:
    r = await env.c.post(BASE, json=_bad(mut), headers=env.h(WN_EDITOR))
    assert r.status_code == 422, (case, r.text)
    assert r.json()["code"] == "VALIDATION_ERROR"


async def test_markup_is_stored_as_plain_text_and_whitespace_normalized(env) -> None:
    """XSS: разметка — просто символы текста (клиенты выводят её как текст); пробелы схлопываются."""
    xss = '<img src=x onerror="alert(1)"> <script>alert(2)</script>'
    body = note()
    body["items"][0]["text"]["ru"] = xss
    body["title"]["ru"] = "  Декабрь   2026 "
    n = await create(env, body)
    assert n["items"][0]["text"]["ru"] == xss and n["title"]["ru"] == "Декабрь 2026"
    assert (await publish(env, n)).status_code == 201
    assert (await feed(env)).json()["items"][0]["items"][0]["text"] == xss


async def test_idempotency_key_replays_publish(env) -> None:
    n = await create(env)
    first = await publish(env, n, **{"Idempotency-Key": "pub-0001-abcdef"})
    second = await publish(env, n, **{"Idempotency-Key": "pub-0001-abcdef"})
    assert first.status_code == 201 and second.status_code == 201
    assert second.headers.get("idempotent-replay") == "true" and second.json() == first.json()
    await env.flush()
    assert len(audits(env, "release_note.publish")) == 1
    assert len(env.events("experience.release_note.published.v1")) == 1


async def test_slug_unique_among_active(env) -> None:
    await create(env)
    dup = await env.c.post(BASE, json=note(), headers=env.h(WN_EDITOR))
    assert dup.status_code == 409 and dup.json()["code"] == "RELEASE_NOTE_SLUG_EXISTS"
    for slug in (WELCOME, *RELEASE_6):
        assert (await env.c.post(BASE, json=note(slug=slug), headers=env.h(WN_EDITOR))).status_code == 409
    # 2026.11 в архиве (релиз 6.1) — метка свободна
    assert (await env.c.post(BASE, json=note(slug=DRAFT), headers=env.h(WN_EDITOR))).status_code == 201


async def test_staff_permissions_and_callers(env) -> None:
    """AT-17: права «Что нового» — whatsnew.manage (чтение, черновик, правка, статистика) и whatsnew.publish
    (публикация, снятие); права конфигурации (config.*) к заметкам больше не допускают — домен проверяет сам."""
    n = await create(env)
    nid = n["release_note_id"]
    edit_body = {**note(), "expected_version": 1}
    manage_calls = [("GET", BASE, None), ("GET", f"{BASE}/{nid}", None), ("GET", f"{BASE}/{nid}/stats", None),
                    ("POST", BASE, note("x1")), ("PUT", f"{BASE}/{nid}", edit_body)]
    publish_calls = [("POST", f"{BASE}/{nid}/publish", {"expected_version": 1, "reason": "нет права"}),
                     ("POST", f"{BASE}/{nid}/archive", {"reason": "нет права"})]
    for method, path, body in manage_calls + publish_calls:
        perm = "whatsnew.publish" if (method, path, body) in publish_calls else "whatsnew.manage"
        assert (await env.c.request(method, path, json=body)).status_code == 401, path
        no_actor = await env.c.request(method, path, json=body, headers=env.h(None))
        assert no_actor.status_code == 403 and no_actor.json()["code"] == "STAFF_CONTEXT_REQUIRED", path
        tg = await env.c.request(method, path, json=body, headers=env.h(WN_PUBLISHER, issuer="telegram-bff"))
        assert tg.status_code == 403 and tg.json()["code"] == "CALLER_NOT_ALLOWED", path
        # config.read / config.edit / config.publish, поддержка и аналитик — не допускаются
        for actor in (READER, EDITOR, PUBLISHER, SUPPORT, DASHBOARD):
            r = await env.c.request(method, path, json=body, headers=env.h(actor))
            assert r.status_code == 403, (path, actor.id, r.text)
            assert r.json()["code"] == "PERMISSION_DENIED" and r.json()["details"] == {"permission": perm}
    # whatsnew.manage без whatsnew.publish: черновик — да, публикация и снятие — нет
    for method, path, body in publish_calls:
        r = await env.c.request(method, path, json=body, headers=env.h(WN_EDITOR))
        assert r.status_code == 403 and r.json()["details"] == {"permission": "whatsnew.publish"}, path
    assert (await env.c.get(f"{BASE}/{nid}", headers=env.h(WN_EDITOR))).json()["status"] == "draft"
    await env.flush()
    assert env.events("experience.release_note.published.v1") == []
    assert [e.payload["action"] for e in audits(env)] == ["release_note.create"]  # отказы аудит не пишут
    # только whatsnew.publish (без manage) — публикует (step-up — в admin-bff)
    only_publish = type(WN_PUBLISHER)(id="staff-comms-8", role="communications",
                                      permissions=frozenset({"whatsnew.publish"}))
    assert (await publish(env, n, actor=only_publish)).status_code == 201

    tg = await env.c.get(BASE, headers=env.h(WN_PUBLISHER, issuer="telegram-bff"))
    assert tg.status_code == 403 and tg.json()["code"] == "CALLER_NOT_ALLOWED"
    missing = await env.c.get(f"{BASE}/{uuid.uuid4()}", headers=env.h(WN_EDITOR))
    assert missing.status_code == 404 and missing.json()["code"] == "RELEASE_NOTE_NOT_FOUND"
    assert (await env.c.get(f"{BASE}/not-a-uuid", headers=env.h(WN_EDITOR))).status_code == 422
    missing_pub = await env.c.post(f"{BASE}/{uuid.uuid4()}/publish", json={"expected_version": 1, "reason": "нет"},
                                   headers=env.h(WN_PUBLISHER))
    assert missing_pub.status_code == 404
    missing_arc = await env.c.post(f"{BASE}/{uuid.uuid4()}/archive", json={"reason": "нет"},
                                   headers=env.h(WN_PUBLISHER))
    assert missing_arc.status_code == 404 and missing_arc.json()["code"] == "RELEASE_NOTE_NOT_FOUND"
    await create(env, note("x2"))
    drafts = await env.c.get(BASE, params={"status": "draft"}, headers=env.h(WN_EDITOR))
    assert [i["status"] for i in drafts.json()["items"]] == ["draft"]
    assert (await env.c.get(BASE, params={"status": "deleted"}, headers=env.h(WN_EDITOR))).status_code == 422
    # 6 заметок: welcome-1, 2026.11 (архив), s6-heroes, s6-heroes-kids, опубликованная n и черновик x2
    page1 = (await env.c.get(BASE, params={"limit": 4}, headers=env.h(WN_EDITOR))).json()
    page2 = (await env.c.get(BASE, params={"limit": 4, "cursor": page1["next_cursor"]},
                             headers=env.h(WN_EDITOR))).json()
    assert len(page1["items"]) == 4 and len(page2["items"]) == 2 and page2["next_cursor"] is None
    bad = await env.c.get(BASE, params={"cursor": "@@"}, headers=env.h(WN_EDITOR))
    assert bad.status_code == 400 and bad.json()["code"] == "INVALID_CURSOR"


async def test_config_permissions_do_not_cover_release_notes_and_vice_versa(env) -> None:
    """config.publish больше не публикует заметку; whatsnew.* не даёт менять конфигурацию интерфейса."""
    n = await create(env)
    denied = await publish(env, n, actor=PUBLISHER)
    assert denied.status_code == 403 and denied.json()["details"] == {"permission": "whatsnew.publish"}
    for path, body in (("/admin/v1/experience/miniapp/rollback", {"reason": "попытка"}),
                       ("/admin/v1/experience/admin/activate", {"version": "1.0.0", "reason": "попытка"})):
        r = await env.c.post(path, json=body, headers=env.h(WN_PUBLISHER))
        assert r.status_code == 403 and r.json()["details"] == {"permission": "config.publish"}, path
    r = await env.c.get("/admin/v1/experience/miniapp/versions", headers=env.h(WN_PUBLISHER))
    assert r.status_code == 403 and r.json()["details"] == {"permission": "config.read"}


# ---------------------------------------------------------------- статистика показов (AT-18)


async def seen_as(env, user, ids: list[str], lang: str | None = None, age: str | None = None):
    params = {k: v for k, v in (("lang", lang), ("age", age)) if v is not None}
    r = await env.c.post(SEEN, json={"release_note_ids": ids}, params=params, headers=env.learner(user))
    assert r.status_code == 204, r.text
    return r


async def stats(env, nid: str, actor=WN_EDITOR):
    return await env.c.get(f"{BASE}/{nid}/stats", headers=env.h(actor))


async def test_views_total_in_list_and_card_without_n_plus_1(env) -> None:
    welcome = await staff_note(env, WELCOME)
    a = await published(env, "2026.12", audience="all")
    draft = await create(env, note("2027.01"))
    for _ in range(3):
        await seen_as(env, uuid.uuid4(), [welcome["release_note_id"], a["release_note_id"]], "ru", "adults")
    repeat = uuid.uuid4()
    await seen_as(env, repeat, [welcome["release_note_id"]], "uz", "kids")
    await seen_as(env, repeat, [welcome["release_note_id"]], "ru", "adults")  # повтор — тот же ученик
    # отметка в обход API на черновик не попадает в views_total (у черновика показов нет по определению)
    async with env.runtime.transaction() as s:
        await s.execute(text("INSERT INTO release_note_views (user_id, release_note_id) VALUES (:u, :n)"),
                        {"u": uuid.uuid4(), "n": uuid.UUID(draft["release_note_id"])})

    from sqlalchemy import event

    assert env.runtime.db is not None
    engine = env.runtime.db.engine
    statements: list[str] = []

    def count_sql(_conn, _cursor, statement, *_a) -> None:
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", count_sql)
    try:
        page = (await env.c.get(BASE, params={"limit": 100}, headers=env.h(WN_EDITOR))).json()
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", count_sql)
    views = {i["slug"]: (i["status"], i["views_total"]) for i in page["items"]}
    assert views == {WELCOME: ("published", 4), "2026.12": ("published", 3), "2027.01": ("draft", 0),
                     DRAFT: ("archived", 0), "s6-heroes": ("published", 0), "s6-heroes-kids": ("published", 0)}
    # одна выборка заметок + один GROUP BY по отметкам, не запрос на каждую заметку
    assert sum("release_note_views" in sql for sql in statements) == 1, statements
    card = (await env.c.get(f"{BASE}/{a['release_note_id']}", headers=env.h(WN_EDITOR))).json()
    assert card["views_total"] == 3 and set(card) >= {"views_total", "release_note_id", "version", "segments"}
    assert (await env.c.get(f"{BASE}/{draft['release_note_id']}", headers=env.h(WN_EDITOR))).json()[
        "views_total"] == 0
    # архив сохраняет показы; ответ команды тоже несёт views_total
    arc = await archive(env, a)
    assert arc.status_code == 201 and arc.json()["views_total"] == 3
    assert (await archive(env, a)).json()["views_total"] == 3
    fresh = await create(env, note("2027.02"))
    assert fresh["views_total"] == 0
    pub = await publish(env, fresh)
    assert pub.json()["views_total"] == 0


async def test_at18_publish_once_for_existing_learner_archive_and_stats(env) -> None:
    """AT-18 (домен): черновик RU+UZ → публикация (whatsnew.publish) → ученик existing видит её при следующем входе
    один раз → статистика показов растёт → снятие убирает заметку из «Что нового» и ленты."""
    learner = uuid.uuid4()
    await env.seen(learner, [(await staff_note(env, WELCOME))["release_note_id"]])  # знакомство уже видел
    n = await create(env, note("2026.12", audience="existing"), actor=WN_EDITOR)
    assert await ids_for_me(env, learner, onboarded_at=env.onboarded(), lang="uz") == ("none", [])  # черновик не виден
    assert (await publish(env, n, actor=WN_PUBLISHER)).status_code == 201
    r = await env.for_me(learner, onboarded_at=env.onboarded(), lang="uz", age="teens")
    assert r.json()["mode"] == "updates" and [x["title"] for x in r.json()["notes"]] == ["2026-yil dekabr"]
    await seen_as(env, learner, [n["release_note_id"]], "uz", "teens")  # шторка закрыта
    assert await ids_for_me(env, learner, onboarded_at=env.onboarded(), lang="uz", age="teens") == ("none", [])
    st = (await stats(env, n["release_note_id"])).json()
    assert (st["views_total"], st["views_by_lang"], st["views_by_age"]) == (
        1, {"ru": 0, "uz": 1}, {"kids": 0, "teens": 1, "adults": 0})
    other = uuid.uuid4()
    await env.seen(other, [(await staff_note(env, WELCOME))["release_note_id"]])
    assert await ids_for_me(env, other, onboarded_at=env.onboarded()) == ("updates", ["2026.12"])
    assert (await archive(env, n)).status_code == 201
    assert await ids_for_me(env, other, onboarded_at=env.onboarded()) == ("none", [])
    assert "2026.12" not in [x["slug"] for x in (await feed(env)).json()["items"]]
    assert (await stats(env, n["release_note_id"])).json()["views_total"] == 1


async def test_stats_by_language_and_age(env) -> None:
    n = await published(env, "2026.12", audience="all")
    nid = n["release_note_id"]
    empty = await stats(env, nid)
    assert empty.status_code == 200, empty.text
    assert empty.json() == {"release_note_id": nid, "views_total": 0, "views_by_lang": {"ru": 0, "uz": 0},
                            "views_by_age": {"kids": 0, "teens": 0, "adults": 0},
                            "first_view_at": None, "last_view_at": None}
    first = uuid.uuid4()
    await seen_as(env, first, [nid], "ru", "adults")
    await seen_as(env, uuid.uuid4(), [nid], "uz", "kids")
    await seen_as(env, uuid.uuid4(), [nid], "uz", "teens")
    await seen_as(env, uuid.uuid4(), [nid], "uz")  # возраст не передан — только в разрезе языка
    await seen_as(env, uuid.uuid4(), [nid])  # сегмент не передан (старый клиент BFF) — только views_total
    # повторная отметка не меняет сегмент первого показа (ученик сменил язык после показа)
    await seen_as(env, first, [nid], "uz", "teens")
    # старая отметка до миграции 0005 — без сегмента
    async with env.runtime.transaction() as s:
        await s.execute(text("INSERT INTO release_note_views (user_id, release_note_id, seen_at) "
                             "VALUES (:u, :n, now() - interval '2 days')"), {"u": uuid.uuid4(), "n": uuid.UUID(nid)})
    r = await stats(env, nid)
    body = r.json()
    assert body["views_total"] == 6
    assert body["views_by_lang"] == {"ru": 1, "uz": 3}
    assert body["views_by_age"] == {"kids": 1, "teens": 1, "adults": 1}
    first_at = datetime.fromisoformat(body["first_view_at"].replace("Z", "+00:00"))
    last_at = datetime.fromisoformat(body["last_view_at"].replace("Z", "+00:00"))
    assert body["first_view_at"].endswith("Z") and first_at < last_at
    assert datetime.now(UTC) - first_at > timedelta(days=1)  # самая ранняя — старая отметка
    # статистика растёт с каждым новым учеником, повтор её не меняет
    await seen_as(env, first, [nid], "ru", "adults")
    assert (await stats(env, nid)).json()["views_total"] == 6
    await seen_as(env, uuid.uuid4(), [nid], "ru", "teens")
    grown = (await stats(env, nid)).json()
    assert grown["views_total"] == 7 and grown["views_by_lang"]["ru"] == 2 and grown["views_by_age"]["teens"] == 2
    # снятая с показа заметка — статистика остаётся
    await archive(env, n)
    assert (await stats(env, nid)).json()["views_total"] == 7
    # в ответе нет идентификаторов учеников
    assert str(first) not in r.text


async def test_stats_not_found_draft_and_auth(env) -> None:
    missing = await stats(env, str(uuid.uuid4()))
    assert missing.status_code == 404 and missing.json()["code"] == "RELEASE_NOTE_NOT_FOUND"
    assert (await env.c.get(f"{BASE}/not-a-uuid/stats", headers=env.h(WN_EDITOR))).status_code == 422
    draft = await create(env)
    r = await stats(env, draft["release_note_id"])
    assert r.status_code == 200 and r.json()["views_total"] == 0 and r.json()["first_view_at"] is None
    assert (await stats(env, draft["release_note_id"], actor=WN_PUBLISHER)).status_code == 200


async def test_seen_segment_validation(env) -> None:
    user = uuid.uuid4()
    welcome = (await staff_note(env, WELCOME))["release_note_id"]
    for params in ({"lang": "en"}, {"age": "seniors"}, {"lang": "ru", "age": "6-9"}):
        r = await env.c.post(SEEN, json={"release_note_ids": [welcome]}, params=params, headers=env.learner(user))
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", params
    async with env.runtime.transaction() as s:
        count = (await s.execute(text("SELECT count(*) FROM release_note_views WHERE user_id = :u"),
                                 {"u": user})).scalar()
    assert count == 0
    # БД не принимает сегмент вне каталога и в обход API
    for col, value in (("ui_lang", "en"), ("age_segment", "seniors")):
        with pytest.raises(Exception, match="ck_release_note_views"):
            async with env.runtime.transaction() as s:
                await s.execute(text(f"INSERT INTO release_note_views (user_id, release_note_id, {col}) "  # noqa: S608
                                     "VALUES (:u, :n, :v)"), {"u": user, "n": uuid.UUID(welcome), "v": value})


# ---------------------------------------------------------------- сводка для Обзора


async def test_summary_for_dashboard(env) -> None:
    path = f"{BASE}/summary"
    r = await env.c.get(path, headers=env.h(DASHBOARD))
    assert r.status_code == 200, r.text
    # после выкладки 6.1: welcome-1 и обе заметки релиза опубликованы, черновик сида — в архиве
    kids = await staff_note(env, "s6-heroes-kids")  # вставлена последней — «последняя опубликованная»
    assert r.json() == {"published": 3, "drafts": 0, "latest": {
        "release_note_id": kids["release_note_id"], "slug": "s6-heroes-kids",
        "title": "Новое в TilHero: герои, тилы и повторения", "views_total": 0, "published_at": kids["published_at"]}}
    a = await published(env, "2026.12", audience="all")
    await create(env, note("2027.01"))
    for _ in range(2):
        await seen_as(env, uuid.uuid4(), [a["release_note_id"]], "uz", "adults")
    s = (await env.c.get(path, headers=env.h(WN_PUBLISHER))).json()
    assert (s["published"], s["drafts"]) == (4, 1)
    assert s["latest"]["slug"] == "2026.12" and s["latest"]["title"] == "Декабрь 2026"  # заголовок — RU
    assert s["latest"]["views_total"] == 2 and s["latest"]["published_at"] == a["published_at"]
    # снятая — не «последняя опубликованная» и не считается
    await archive(env, a)
    s = (await env.c.get(path, headers=env.h(DASHBOARD))).json()
    assert (s["published"], s["drafts"]) == (3, 1) and s["latest"]["slug"] == "s6-heroes-kids"
    for slug in (WELCOME, *RELEASE_6):
        await archive(env, await staff_note(env, slug))
    s = (await env.c.get(path, headers=env.h(DASHBOARD))).json()
    assert s == {"published": 0, "drafts": 1, "latest": None}


async def test_summary_auth(env) -> None:
    path = f"{BASE}/summary"
    assert (await env.c.get(path)).status_code == 401
    for actor in (WN_EDITOR, READER, SUPPORT):  # без dashboard.read
        r = await env.c.get(path, headers=env.h(actor))
        assert r.status_code == 403 and r.json()["details"] == {"permission": "dashboard.read"}, actor.id
    no_actor = await env.c.get(path, headers=env.h(None))
    assert no_actor.status_code == 403 and no_actor.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    tg = await env.c.get(path, headers=env.h(DASHBOARD, issuer="telegram-bff"))
    assert tg.status_code == 403 and tg.json()["code"] == "CALLER_NOT_ALLOWED"
    learner = await env.c.get(path, headers=env.learner(uuid.uuid4()))
    assert learner.status_code == 403


# ---------------------------------------------------------------- неизменность в БД и миграции


async def test_published_note_is_immutable_in_db(env) -> None:
    n = await create(env)
    nid = uuid.UUID(n["release_note_id"])
    draft = await create(env, note(slug="tmp-1"))
    async with env.runtime.transaction() as s:  # черновик можно удалить (уборка вручную)
        await s.execute(text("DELETE FROM release_notes WHERE id = :id"), {"id": uuid.UUID(draft["release_note_id"])})
    assert (await publish(env, n)).status_code == 201
    for stmt in ("UPDATE release_notes SET items = '[]'::jsonb WHERE id = :id",
                 "UPDATE release_notes SET title = '{\"ru\": \"x\", \"uz\": \"x\"}'::jsonb WHERE id = :id",
                 "UPDATE release_notes SET segments = '{\"age\": [\"kids\"]}'::jsonb WHERE id = :id",
                 "UPDATE release_notes SET audience = 'new' WHERE id = :id",
                 "UPDATE release_notes SET status = 'draft', published_at = NULL WHERE id = :id",
                 "DELETE FROM release_notes WHERE id = :id"):
        with pytest.raises(Exception, match="release note"):
            async with env.runtime.transaction() as s:
                await s.execute(text(stmt), {"id": nid})
    assert (await archive(env, n, "архив")).status_code == 201
    with pytest.raises(Exception, match="archived"):
        async with env.runtime.transaction() as s:
            await s.execute(text("UPDATE release_notes SET status = 'published' WHERE id = :id"), {"id": nid})


async def test_audit_carries_no_note_text(env) -> None:
    """В журнал уходят метка, статус, аудитория и счётчики, а не тексты заметки."""
    body = note()
    body["items"][0]["text"]["ru"] = "секретный-маркер-текста"
    n = await create(env, body)
    await publish(env, n)
    await env.flush()
    dumped = json.dumps([e.payload for e in audits(env)], ensure_ascii=False)
    assert "секретный-маркер-текста" not in dumped and "Darsdan" not in dumped


async def _alembic(env, action: str, revision: str) -> None:
    from alembic import command
    from alembic.config import Config
    from conftest import SERVICE_DIR

    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = env.settings
    await asyncio.to_thread(getattr(command, action), cfg, revision)


async def test_migrations_down_and_up_again(env) -> None:
    """head → 0003 (down): 0007 удаляет заметки релиза 6.1 и возвращает черновик, 0004 удаляет черновик сида,
    опубликованная welcome-1 остаётся (триггер); повторный upgrade не падает на дубле (ON CONFLICT DO NOTHING).
    0003 → 0002: таблицы «Что нового» снимаются целиком."""

    async def count(sql: str, **params: str) -> int:
        async with env.runtime.transaction() as s:
            return (await s.execute(text(sql), params)).scalar_one()

    await _alembic(env, "downgrade", "0003")
    assert await count("SELECT count(*) FROM release_notes WHERE status = 'draft'") == 0
    assert await count("SELECT count(*) FROM release_notes WHERE slug = 'welcome-1'") == 1
    assert await count("SELECT count(*) FROM release_notes") == 1
    await _alembic(env, "upgrade", "head")
    assert await count("SELECT count(*) FROM release_notes") == 4  # welcome-1, 2026.11 (архив), s6-heroes, -kids
    await _alembic(env, "downgrade", "0002")
    assert await count("SELECT count(*) FROM information_schema.tables WHERE table_schema = :schema "
                       "AND table_name IN ('release_notes', 'release_note_views', 'deleted_users')",
                       schema=env.settings.db_schema) == 0
    await _alembic(env, "upgrade", "head")
    assert [n["slug"] for n in (await feed(env)).json()["items"]] == ["s6-heroes", WELCOME]


async def test_parallel_creates_with_same_slug_one_wins_other_409(env) -> None:
    """Гонка за метку: проверка без блокировки пропускает обе команды — вторую останавливает индекс → 409, не 500."""
    rs = await asyncio.gather(*[env.c.post(BASE, json=note("race-1"), headers=env.h(WN_EDITOR)) for _ in range(4)])
    assert sorted(r.status_code for r in rs) == [201, 409, 409, 409], [r.text for r in rs]
    assert {r.json()["code"] for r in rs if r.status_code == 409} == {"RELEASE_NOTE_SLUG_EXISTS"}


async def test_slug_unique_index_maps_to_409_even_without_precheck(env, monkeypatch) -> None:
    taken = await create(env, note("dup-1"))
    other = await create(env, note("dup-2"))

    async def never_taken(*_a, **_k) -> bool:
        return False

    monkeypatch.setattr(rn, "_slug_taken", never_taken)
    r = await env.c.post(BASE, json=note("dup-1"), headers=env.h(WN_EDITOR))
    assert r.status_code == 409 and r.json()["code"] == "RELEASE_NOTE_SLUG_EXISTS", r.text
    u = await env.c.put(f"{BASE}/{other['release_note_id']}", json={**note("dup-1"), "expected_version": 1},
                        headers=env.h(WN_EDITOR))
    assert u.status_code == 409 and u.json()["code"] == "RELEASE_NOTE_SLUG_EXISTS", u.text
    assert (await env.c.get(f"{BASE}/{taken['release_note_id']}", headers=env.h(WN_EDITOR))).json()["slug"] == "dup-1"
    await env.flush()
    assert len(audits(env, "release_note.create")) == 2  # отказ не оставил записи аудита


# ---------------------------------------------------------------- сага удаления (AT-14)


def deletion(user: uuid.UUID | str, request_id: str | None = None, producer: str = "identity-consent",
             attempt: int = 1):
    from tilhero_common.messaging import make_envelope

    return make_envelope("user.deletion.requested.v1",
                         {"user_id": str(user), "request_id": request_id or str(uuid.uuid4()),
                          "requested_at": iso(datetime.now(UTC)), "attempt": attempt},
                         producer=producer)


async def acks(env) -> list:
    await env.flush()
    return env.events("user.domain.deleted.v1")


async def test_deletion_removes_views_and_acks(env) -> None:
    user, other = uuid.uuid4(), uuid.uuid4()
    welcome = (await staff_note(env, WELCOME))["release_note_id"]
    n = await published(env, "2026.12", audience="all")
    for u in (user, other):
        assert (await env.seen(u, [welcome, n["release_note_id"]])).status_code == 204
    ev = deletion(user)
    assert_event_conforms(ev)
    await env.bus.publish(ev)
    async with env.runtime.transaction() as s:
        left = (await s.execute(text("SELECT user_id FROM release_note_views"))).scalars().all()
    assert set(left) == {other}  # отметки ученика удалены физически, чужие — на месте
    got = await acks(env)
    assert [a.payload for a in got] == [{"user_id": str(user), "request_id": ev.payload["request_id"],
                                         "domain": "experience-config", "mode": "deleted"}]
    assert_event_conforms(got[0])
    # после ACK данные ученика больше не принимаются
    gone = await env.seen(user, [welcome])
    assert gone.status_code == 410 and gone.json()["code"] == "USER_DELETED"
    assert (await env.for_me(user)).json()["code"] == "USER_DELETED"
    assert await ids_for_me(env, other, onboarded_at=env.onboarded()) == ("none", [])
    # повтор рассылки сагой (тот же request_id, новый event_id) — снова ACK, без ошибок
    await env.bus.publish(deletion(user, ev.payload["request_id"], attempt=2))
    assert len(await acks(env)) == 2
    # повторная доставка того же события — inbox
    spec = next(s for s in env.bus.specs if s.durable == "experience-config.user_deleted")
    await spec.handler(ev)
    assert len(await acks(env)) == 2


async def test_deletion_only_from_identity_consent_and_tolerates_bad_ids(env) -> None:
    user = uuid.uuid4()
    welcome = (await staff_note(env, WELCOME))["release_note_id"]
    await env.seen(user, [welcome])
    for producer in ("telegram-bff", "social", "support"):
        await env.bus.publish(deletion(user, producer=producer))
    assert await acks(env) == []
    assert await ids_for_me(env, user) == ("none", [])  # отметка на месте
    bad = deletion("not-a-uuid")
    await env.bus.publish(bad)  # данных нет — подтверждаем, сага не зависает
    assert [a.payload["user_id"] for a in await acks(env)] == ["not-a-uuid"]
    assert env.bus.dlq == []


async def test_race_deletion_vs_seen_leaves_no_views(env) -> None:
    welcome = (await staff_note(env, WELCOME))["release_note_id"]
    outcomes = set()
    for _ in range(6):
        user = uuid.uuid4()
        r, _ = await asyncio.gather(env.seen(user, [welcome]), env.bus.publish(deletion(user)))
        assert r.status_code in (204, 410), r.text
        outcomes.add(r.status_code)
        async with env.runtime.transaction() as s:
            left = (await s.execute(text("SELECT count(*) FROM release_note_views WHERE user_id = :u"),
                                    {"u": user})).scalar()
        assert left == 0
    assert outcomes <= {204, 410}
