"""Доработка 9.4 «Что нового»: заметки о релизах — черновик, публикация с подтверждением, архив, лента для telegram-bff,
права config.*, аудит через outbox, неизменность опубликованной (триггер), белые списки маршрутов и иконок."""

from __future__ import annotations

import copy
import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from exp_actors import EDITOR, PUBLISHER, READER, SUPPORT
from sqlalchemy import text

from tilhero_common.testing import assert_event_conforms
from tilhero_experience.domain import release_notes as rn

BASE = "/admin/v1/release-notes"
FEED = "/internal/v1/release-notes/published"
SEED_SLUG = "2026.11"
CATALOG = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "release-notes.json"


def note(slug: str = "2026.12", **over: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "slug": slug,
        "title": {"ru": "Декабрь 2026", "en": "December 2026"},
        "items": [
            {"title": {"ru": "Новое", "en": "New"}, "text": {"ru": "Коротко о новом.", "en": "Short news."},
             "link": "catalog", "icon": "spark"},
            {"title": {"ru": "Без ссылки", "en": "No link"}, "text": {"ru": "Текст.", "en": "Text."}},
        ],
        "audience": "existing",
    }
    body.update(over)
    return body


async def create(env, body: dict | None = None, actor=EDITOR) -> dict:
    r = await env.c.post(BASE, json=body or note(), headers=env.h(actor))
    assert r.status_code == 201, r.text
    return r.json()


async def publish(env, n: dict, reason: str = "Релиз декабря", actor=PUBLISHER, **headers: str):
    return await env.c.post(f"{BASE}/{n['release_note_id']}/publish",
                            json={"expected_version": n["version"], "reason": reason},
                            headers=env.h(actor, **headers))


async def feed(env, issuer: str = "telegram-bff"):
    return await env.c.get(FEED, headers=env.h(issuer=issuer))


def audits(env, action: str | None = None) -> list:
    return [e for e in env.events("admin.audit.recorded.v1")
            if e.payload["object_type"] == "release_note" and (action is None or e.payload["action"] == action)]


# ---------------------------------------------------------------- каталог и сид


def test_catalog_matches_contract() -> None:
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    assert tuple(cat["routes"]) == rn.ROUTES
    assert tuple(cat["icons"]) == rn.ICONS
    lim = cat["limits"]
    assert lim["slug_pattern"] == rn.SLUG_PATTERN
    assert (lim["title_max"], lim["item_title_max"], lim["item_text_max"]) == (
        rn.TITLE_MAX, rn.ITEM_TITLE_MAX, rn.ITEM_TEXT_MAX)
    assert (lim["items_min"], lim["items_max"], lim["client_max_notes"]) == (
        rn.ITEMS_MIN, rn.ITEMS_MAX, rn.CLIENT_MAX_NOTES)


async def test_seed_is_unpublished_draft_with_valid_content(env) -> None:
    r = await env.c.get(BASE, headers=env.h(READER))
    assert r.status_code == 200
    seeds = [n for n in r.json()["items"] if n["slug"] == SEED_SLUG]
    assert len(seeds) == 1
    seed = seeds[0]
    assert seed["status"] == "draft" and seed["published_at"] is None and seed["created_by"] == "system:seed"
    assert seed["title"] == {"ru": "Ноябрь 2026", "en": "November 2026"}
    assert [i["link"] for i in seed["items"]] == ["catalog", "catalog", "profile"]
    assert [i["icon"] for i in seed["items"]] == ["pin", "globe", "phone"]
    # содержимое сида проходит ту же проверку, что и заметка из админки
    rn.NoteContent.model_validate({k: seed[k] for k in ("slug", "title", "items", "audience")})
    # черновик не виден пользователям
    assert (await feed(env)).json() == {"items": []}


# ---------------------------------------------------------------- жизненный цикл


async def test_lifecycle_create_edit_publish_archive_with_audit(env) -> None:
    n = await create(env)
    assert n["status"] == "draft" and n["version"] == 1 and n["created_by"] == EDITOR.id
    # правка черновика
    body = note(title={"ru": "Декабрь", "en": "December"})
    r = await env.c.put(f"{BASE}/{n['release_note_id']}", json={**body, "expected_version": 1}, headers=env.h(EDITOR))
    assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["title"]["ru"] == "Декабрь"
    # повтор той же правки — no-op
    same = await env.c.put(f"{BASE}/{n['release_note_id']}", json={**body, "expected_version": 2},
                           headers=env.h(EDITOR))
    assert same.status_code == 200 and same.json()["version"] == 2
    # устаревшая версия
    stale = await env.c.put(f"{BASE}/{n['release_note_id']}", json={**note(), "expected_version": 1},
                            headers=env.h(EDITOR))
    assert stale.status_code == 409 and stale.json()["code"] == "RELEASE_NOTE_VERSION_CONFLICT"
    assert stale.json()["details"]["current_version"] == 2
    # публикация по устаревшей версии — нет (сотрудник подтверждал другое содержимое)
    bad = await publish(env, n)
    assert bad.status_code == 409 and bad.json()["code"] == "RELEASE_NOTE_VERSION_CONFLICT"
    pub = await publish(env, r.json())
    assert pub.status_code == 201, pub.text
    p = pub.json()
    assert p["status"] == "published" and p["published_by"] == PUBLISHER.id and p["published_at"].endswith("Z")
    # повтор публикации — no-op 200
    again = await publish(env, r.json())
    assert again.status_code == 200 and again.json()["published_at"] == p["published_at"]
    # в ленте telegram-bff — без сотрудников
    items = (await feed(env)).json()["items"]
    assert [i["release_note_id"] for i in items] == [n["release_note_id"]]
    assert set(items[0]) == {"release_note_id", "slug", "title", "items", "audience", "published_at"}
    # опубликованную править нельзя
    edit = await env.c.put(f"{BASE}/{n['release_note_id']}", json={**note(), "expected_version": p["version"]},
                           headers=env.h(EDITOR))
    assert edit.status_code == 409 and edit.json()["code"] == "RELEASE_NOTE_NOT_DRAFT"
    # архив → пропадает из ленты; повтор — no-op
    arc = await env.c.post(f"{BASE}/{n['release_note_id']}/archive", json={"reason": "Опечатка в тексте"},
                           headers=env.h(PUBLISHER))
    assert arc.status_code == 201 and arc.json()["status"] == "archived" and arc.json()["archived_by"] == PUBLISHER.id
    arc2 = await env.c.post(f"{BASE}/{n['release_note_id']}/archive", json={"reason": "Опечатка в тексте"},
                            headers=env.h(PUBLISHER))
    assert arc2.status_code == 200
    assert (await feed(env)).json()["items"] == []
    # архивную опубликовать нельзя; метку можно занять новой заметкой
    re_pub = await publish(env, arc.json())
    assert re_pub.status_code == 409 and re_pub.json()["code"] == "RELEASE_NOTE_NOT_DRAFT"
    await create(env)

    await env.flush()
    actions = [e.payload["action"] for e in audits(env)]
    assert actions == ["release_note.create", "release_note.update", "release_note.publish", "release_note.archive",
                       "release_note.create"]
    from tilhero_audit.schemas import RecordIn

    for e in audits(env):
        assert_event_conforms(e)
        RecordIn.model_validate(e.payload)
        assert e.payload["actor_type"] == "staff" and e.payload["object_type"] == "release_note"
    pub_audit = audits(env, "release_note.publish")[0].payload
    assert pub_audit["reason"] == "Релиз декабря" and pub_audit["object_id"] == n["release_note_id"]
    assert pub_audit["before"] == {"status": "draft"} and pub_audit["after"]["status"] == "published"
    assert audits(env, "release_note.archive")[0].payload["reason"] == "Опечатка в тексте"


async def test_feed_newest_first_and_limit(env) -> None:
    ids = []
    for k in range(4):
        n = await create(env, note(slug=f"2027.0{k + 1}"))
        assert (await publish(env, n)).status_code == 201
        ids.append(n["release_note_id"])
    items = (await feed(env)).json()["items"]
    assert [i["release_note_id"] for i in items] == list(reversed(ids))
    two = (await env.c.get(FEED, params={"limit": 2}, headers=env.h(issuer="telegram-bff"))).json()["items"]
    assert len(two) == 2
    big = await env.c.get(FEED, params={"limit": 500}, headers=env.h(issuer="telegram-bff"))
    assert big.status_code == 422


async def test_slug_unique_among_active(env) -> None:
    await create(env)
    dup = await env.c.post(BASE, json=note(), headers=env.h(EDITOR))
    assert dup.status_code == 409 and dup.json()["code"] == "RELEASE_NOTE_SLUG_EXISTS"
    seed_dup = await env.c.post(BASE, json=note(slug=SEED_SLUG), headers=env.h(EDITOR))
    assert seed_dup.status_code == 409


async def test_idempotency_key_replays_publish(env) -> None:
    n = await create(env)
    first = await publish(env, n, **{"Idempotency-Key": "pub-0001-abcdef"})
    second = await publish(env, n, **{"Idempotency-Key": "pub-0001-abcdef"})
    assert first.status_code == 201 and second.status_code == 201
    assert second.headers.get("idempotent-replay") == "true" and second.json() == first.json()
    await env.flush()
    assert len(audits(env, "release_note.publish")) == 1


# ---------------------------------------------------------------- права и вызывающие


async def test_permissions_and_callers(env) -> None:
    n = await create(env)
    nid = n["release_note_id"]
    assert (await env.c.get(BASE)).status_code == 401
    assert (await env.c.get(BASE, headers=env.h(SUPPORT))).status_code == 403
    assert (await env.c.post(BASE, json=note("x1"), headers=env.h(READER))).status_code == 403
    # config.edit без config.publish: черновик — да, публикация и архив — нет
    denied = await publish(env, n, actor=EDITOR)
    assert denied.status_code == 403 and denied.json()["code"] == "PERMISSION_DENIED"
    arc = await env.c.post(f"{BASE}/{nid}/archive", json={"reason": "нет права"}, headers=env.h(EDITOR))
    assert arc.status_code == 403
    # staff API — только admin-bff; лента — только telegram-bff
    tg = await env.c.get(BASE, headers=env.h(PUBLISHER, issuer="telegram-bff"))
    assert tg.status_code == 403 and tg.json()["code"] == "CALLER_NOT_ALLOWED"
    assert (await feed(env, issuer="admin-bff")).status_code == 403
    assert (await feed(env, issuer="offers")).status_code == 403
    assert (await env.c.get(FEED)).status_code == 401
    # 404
    missing = await env.c.get(f"{BASE}/{uuid.uuid4()}", headers=env.h(READER))
    assert missing.status_code == 404 and missing.json()["code"] == "RELEASE_NOTE_NOT_FOUND"
    assert (await env.c.get(f"{BASE}/not-a-uuid", headers=env.h(READER))).status_code == 422
    missing_pub = await env.c.post(f"{BASE}/{uuid.uuid4()}/publish", json={"expected_version": 1, "reason": "нет"},
                                   headers=env.h(PUBLISHER))
    assert missing_pub.status_code == 404
    status = await env.c.get(BASE, params={"status": "draft"}, headers=env.h(READER))
    assert {i["status"] for i in status.json()["items"]} == {"draft"}
    assert (await env.c.get(BASE, params={"status": "deleted"}, headers=env.h(READER))).status_code == 422


# ---------------------------------------------------------------- проверка содержимого


def _bad(mut) -> dict:
    body = note()
    mut(body)
    return body


INVALID = [
    ("7 пунктов", lambda b: b.update(items=b["items"] * 3 + [b["items"][0]])),
    ("0 пунктов", lambda b: b.update(items=[])),
    ("текст > 200", lambda b: b["items"][0]["text"].update(ru="а" * 201)),
    ("заголовок > 80", lambda b: b["title"].update(en="x" * 81)),
    ("маршрут не из списка", lambda b: b["items"][0].update(link="https://evil.example")),
    ("javascript-ссылка", lambda b: b["items"][0].update(link="javascript:alert(1)")),
    ("иконка не из набора", lambda b: b["items"][0].update(icon="skull")),
    ("лишнее поле", lambda b: b["items"][0].update(html="<b>x</b>")),
    ("лишнее поле заметки", lambda b: b.update(css="body{}")),
    ("перевод строки", lambda b: b["items"][0]["text"].update(ru="строка\nвторая")),
    ("управляющий символ", lambda b: b["title"].update(ru="Ноябрь\x00")),
    ("bidi-символ", lambda b: b["title"].update(ru="abc\u202edcba")),
    # ревью 9.4: невидимые и bidi-символы (scratchpad/rev94repro/bidi_chars.txt)
    *[(f"U+{c:04X}", (lambda ch: lambda b: b["items"][0]["text"].update(ru=f"a{ch}b"))(chr(c)))
      for c in (0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x061C, 0x2060, 0xFEFF, 0x202A, 0x202E, 0x2066, 0x2069)],
    ("пустой после trim", lambda b: b["title"].update(ru="   ")),
    ("нет EN", lambda b: b["title"].pop("en")),
    ("плохая метка", lambda b: b.update(slug="../2026")),
    ("аудитория", lambda b: b.update(audience="vip")),
    ("число вместо текста", lambda b: b["title"].update(ru=12)),
]


@pytest.mark.parametrize(("case", "mut"), INVALID, ids=[c for c, _ in INVALID])
async def test_invalid_content_rejected(env, case: str, mut) -> None:
    r = await env.c.post(BASE, json=_bad(mut), headers=env.h(EDITOR))
    assert r.status_code == 422, (case, r.text)
    assert r.json()["code"] == "VALIDATION_ERROR"


async def test_markup_is_stored_as_plain_text_and_whitespace_normalized(env) -> None:
    """XSS: разметка — просто символы текста (клиенты выводят её как текст); пробелы схлопываются."""
    xss = '<img src=x onerror="alert(1)"> <script>alert(2)</script>'
    body = note()
    body["items"][0]["text"]["ru"] = xss
    body["title"]["ru"] = "  Декабрь   2026 "
    n = await create(env, body)
    assert n["items"][0]["text"]["ru"] == xss
    assert n["title"]["ru"] == "Декабрь 2026"
    assert (await publish(env, n)).status_code == 201
    assert (await feed(env)).json()["items"][0]["items"][0]["text"]["ru"] == xss


# ---------------------------------------------------------------- неизменность в БД


async def test_published_note_is_immutable_in_db(env) -> None:
    n = await create(env)
    nid = uuid.UUID(n["release_note_id"])
    # черновик можно удалить (например, уборка вручную)
    draft = await create(env, note(slug="tmp-1"))
    async with env.runtime.transaction() as s:
        await s.execute(text("DELETE FROM release_notes WHERE id = :id"), {"id": uuid.UUID(draft["release_note_id"])})
    assert (await publish(env, n)).status_code == 201
    for stmt in ("UPDATE release_notes SET items = '[]'::jsonb WHERE id = :id",
                 "UPDATE release_notes SET title = '{\"ru\": \"x\", \"en\": \"x\"}'::jsonb WHERE id = :id",
                 "UPDATE release_notes SET status = 'draft', published_at = NULL WHERE id = :id",
                 "DELETE FROM release_notes WHERE id = :id"):
        with pytest.raises(Exception, match="release note"):
            async with env.runtime.transaction() as s:
                await s.execute(text(stmt), {"id": nid})
    arc = await env.c.post(f"{BASE}/{nid}/archive", json={"reason": "архив"}, headers=env.h(PUBLISHER))
    assert arc.status_code == 201
    with pytest.raises(Exception, match="archived"):
        async with env.runtime.transaction() as s:
            await s.execute(text("UPDATE release_notes SET status = 'published' WHERE id = :id"), {"id": nid})


async def test_audit_carries_no_note_text(env) -> None:
    """В журнал уходят метка, статус и счётчики, а не тексты заметки."""
    body = copy.deepcopy(note())
    body["items"][0]["text"]["ru"] = "секретный-маркер-текста"
    await create(env, body)
    await env.flush()
    assert "секретный-маркер-текста" not in json.dumps([e.payload for e in audits(env)], ensure_ascii=False)


async def test_migrations_down_and_up_again(env) -> None:
    """0004 → 0003 → 0002 (down) и обратно: сид-черновик удаляется и создаётся снова, таблица снимается целиком."""
    import asyncio

    from alembic import command
    from alembic.config import Config
    from conftest import SERVICE_DIR

    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = env.settings

    async def count(sql: str, **params: str) -> int:
        async with env.runtime.transaction() as s:
            return (await s.execute(text(sql), params)).scalar_one()

    await asyncio.to_thread(command.downgrade, cfg, "0003")
    assert await count("SELECT count(*) FROM release_notes") == 0
    await asyncio.to_thread(command.downgrade, cfg, "0002")
    assert await count("SELECT count(*) FROM information_schema.tables WHERE table_name = 'release_notes' "
                       "AND table_schema = :schema", schema=env.settings.db_schema) == 0
    await asyncio.to_thread(command.upgrade, cfg, "head")
    assert await count("SELECT count(*) FROM release_notes WHERE status = 'draft'") == 1


# ---------------------------------------------------------------- ревью 9.4


async def test_parallel_creates_with_same_slug_one_wins_other_409(env) -> None:
    """Гонка за метку: проверка без блокировки пропускает обе команды — вторую останавливает индекс → 409, не 500."""
    import asyncio

    rs = await asyncio.gather(*[env.c.post(BASE, json=note("race-1"), headers=env.h(EDITOR)) for _ in range(4)])
    codes = sorted(r.status_code for r in rs)
    assert codes == [201, 409, 409, 409], [r.text for r in rs]
    assert {r.json()["code"] for r in rs if r.status_code == 409} == {"RELEASE_NOTE_SLUG_EXISTS"}


async def test_slug_unique_index_maps_to_409_even_without_precheck(env, monkeypatch) -> None:
    """Детерминированно: предварительная проверка «не видит» занятую метку (как в гонке) — create и update."""
    taken = await create(env, note("dup-1"))
    other = await create(env, note("dup-2"))

    async def never_taken(*_a, **_k) -> bool:
        return False

    monkeypatch.setattr(rn, "_slug_taken", never_taken)
    r = await env.c.post(BASE, json=note("dup-1"), headers=env.h(EDITOR))
    assert r.status_code == 409 and r.json()["code"] == "RELEASE_NOTE_SLUG_EXISTS", r.text
    u = await env.c.put(f"{BASE}/{other['release_note_id']}", json={**note("dup-1"), "expected_version": 1},
                        headers=env.h(EDITOR))
    assert u.status_code == 409 and u.json()["code"] == "RELEASE_NOTE_SLUG_EXISTS", u.text
    assert (await env.c.get(f"{BASE}/{taken['release_note_id']}", headers=env.h(READER))).json()["slug"] == "dup-1"
    await env.flush()
    assert len(audits(env, "release_note.create")) == 2  # отказ не оставил записи аудита


async def test_seed_published_then_downgrade_0004_and_upgrade_again(env) -> None:
    """scratchpad/rev94repro/roles_rollback.py: сид опубликован → откат 0004 его не удаляет (триггер) → повторный
    upgrade не падает на дубле (ON CONFLICT DO NOTHING), сид остаётся один и опубликованный."""
    import asyncio

    from alembic import command
    from alembic.config import Config
    from conftest import SERVICE_DIR

    seed = next(n for n in (await env.c.get(BASE, headers=env.h(READER))).json()["items"] if n["slug"] == SEED_SLUG)
    assert (await publish(env, seed, reason="Релиз ноября")).status_code == 201
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = env.settings
    await asyncio.to_thread(command.downgrade, cfg, "0003")
    await asyncio.to_thread(command.upgrade, cfg, "head")
    rows = [n for n in (await env.c.get(BASE, headers=env.h(READER))).json()["items"] if n["slug"] == SEED_SLUG]
    assert [(n["release_note_id"], n["status"]) for n in rows] == [(seed["release_note_id"], "published")]
