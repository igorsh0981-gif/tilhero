"""Релиз 8: «Что нового» о подписке за Telegram Stars (миграция 0011) — ЧЕРНОВИКИ до включения продаж (PLAN спринта
8, решение 20): s8-plus (подростки и взрослые, на «вы») и s8-plus-kids (дети, на «ты», без цен и покупок);
иллюстрации и переходы — в основных списках каталога (перенос из planned — поток I); ученики их не видят, пока
сотрудник не опубликует; анти-стиринг (только Stars: ни сайта, ни фиатных провайдеров, ни сумов); аудит создания
от system:release; обратимость."""

from __future__ import annotations

import importlib.util
import json
import re
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from conftest import SERVICE_DIR
from exp_actors import WN_PUBLISHER
from sqlalchemy import text
from test_release_notes import CYRILLIC, WELCOME, _alembic, create, feed, ids_for_me, note, publish, staff_note

from tilhero_common.testing import assert_event_conforms
from tilhero_experience.domain import release_notes as rn

ADULT, KIDS = "s8-plus", "s8-plus-kids"
CATALOG = Path(SERVICE_DIR).parents[1] / "packages" / "contracts" / "release-notes.json"
PUBLISHED = "experience.release_note.published.v1"
AUDIT = "admin.audit.recorded.v1"
WRONG_APOSTROPHES = re.compile("['`‘ʼ’]")  # узбекская латиница: oʻ / gʻ — только U+02BB
# анти-стиринг (решение владельца В1, AT-100): ни сайта оплаты, ни фиатных провайдеров, ни сумов, ни ссылок
STEERING = re.compile(r"payme|paycom|click|uzum|http|www\.|\.uz\b|\.com\b|сайт|веб|браузер|sayt|brauzer|интернет|"
                      r"internet|\bсум|soʻm|so'm|\bsom\b|uzs|тийин|tiyin|карт[аоуы]|karta|дешевле|arzon|другим способ|"
                      r"другой способ|boshqa usul", re.I)


def migration() -> ModuleType:
    path = Path(SERVICE_DIR) / "migrations" / "versions" / "0011_release_8.py"
    spec = importlib.util.spec_from_file_location("exp_migration_0011", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def texts(n: dict[str, Any], lang: str) -> list[str]:
    return [n["title"][lang], *(i[p][lang] for i in n["items"] for p in ("title", "text"))]


async def scalar(env, sql: str, **params: Any) -> Any:
    async with env.runtime.transaction() as s:
        return (await s.execute(text(sql), params)).scalar()


# ---------------------------------------------------------------- каталог


def test_catalog_release_8_keys() -> None:
    """Иллюстрации и переходы релиза 8 — в основных списках каталога (поток I перенёс их из planned до публикации
    заметок); блока planned больше нет."""
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    assert "planned" not in cat
    keys = {i["key"] for i in cat["illustrations"]}
    assert {ADULT, KIDS} <= keys and {"subscription", "til_shop"} <= set(cat["routes"])
    assert rn.ILLUSTRATIONS[ADULT] == rn.ILLUSTRATIONS[KIDS] == (1200, 675)
    assert {"subscription", "til_shop"} <= set(rn.ROUTES)
    assert {ADULT, KIDS} <= set(rn.Illustration.__args__)  # type: ignore[attr-defined]


# ---------------------------------------------------------------- черновики при выкладке


async def test_release_notes_created_as_drafts(env) -> None:
    adult, kids = await staff_note(env, ADULT), await staff_note(env, KIDS)
    for n, age, art in ((adult, ["teens", "adults"], ADULT), (kids, ["kids"], KIDS)):
        assert (n["status"], n["audience"], n["segments"], n["illustration"], n["version"]) == (
            "draft", "existing", {"age": age}, art, 1)
        assert n["created_by"] == "system:release"
        assert n["published_by"] is None and n["published_at"] is None
        # та же проверка, что у заметки из админки (переводы, лимиты длины, каталог)
        content = rn.NoteContent.model_validate(
            {k: n[k] for k in ("slug", "title", "items", "audience", "segments", "illustration")})
        assert rn.dump_content(content)["items"] == n["items"]
        assert rn.missing_translations(n["title"], n["items"]) == []
        uz = texts(n, "uz")
        assert not any(CYRILLIC.search(t) for t in uz), uz
        assert not any(WRONG_APOSTROPHES.search(t) for t in uz), uz
        assert any("ʻ" in t for t in uz)
        for lang in ("ru", "uz"):
            joined = " ".join(texts(n, lang))
            assert not STEERING.search(joined), (n["slug"], lang, STEERING.search(joined))
    assert [(i["icon"], i["link"]) for i in adult["items"]] == [
        ("star", "subscription"), ("chat", "subscription"), ("users", "friends"), ("gift", "subscription"),
        ("hero", "til_shop"), ("book", "lessons")]
    by_title = {i["title"]["ru"]: i["text"]["ru"] for i in adult["items"]}
    assert "Telegram" in by_title["Подписка за Telegram Stars"] and "согласия родителя" in by_title[
        "Подписка за Telegram Stars"]
    assert "ИИ-минут" in by_title["Уроки с ИИ"] and "«Подписка»" in by_title["Уроки с ИИ"]
    assert "один раз за урок" in by_title["Уроки вдвоём"] and "без подписки" in by_title["Уроки вдвоём"]
    assert "7 дней и 60 ИИ-минут" in by_title["Пробный период"]
    assert "детский профиль" in by_title["Тилы за Stars"]
    assert "без подписки" in by_title["Бесплатное остаётся бесплатным"]


async def test_kids_note_soft_without_prices_or_purchases() -> None:
    """Детская версия: на «ты», без давления, без цен, покупок и «попроси родителя»."""
    m = migration()
    kids = next(n for n in m.NOTES if n["slug"] == KIDS)
    ru, uz = " ".join(texts(kids, "ru")), " ".join(texts(kids, "uz"))
    assert not re.search(r"\b(вы|вас|вам|ваш\w*|выберите|нажмите|оформите|купите)\b", ru, re.IGNORECASE), ru
    assert not re.search(r"\bsiz\w*|\w+ingiz\b", uz, re.IGNORECASE), uz
    assert "⭐" not in ru and "⭐" not in uz
    # по началу слова («сценарий» — не «цена»)
    for absent in ("stars", "звёзд", "тил", "купи", "покуп", "оплат", "цен", "стоим", "бесплатн", "попрос", "друг",
                   "приглас"):
        assert not re.search(rf"(?<![а-яё]){absent}", ru.lower()), absent
    for absent in ("stars", "yulduz", "til", "sotib", "toʻlov", "narx", "bepul", "soʻra", "doʻst", "taklif"):
        assert not re.search(rf"\b{absent}", uz.lower()), absent
    for pressure in ("потер", "теря", "провал", "штраф", "сгор", "проигр", "yoʻqot", "muvaffaqiyatsiz", "jarima"):
        assert pressure not in ru.lower() and pressure not in uz.lower(), pressure
    assert kids["illustration"] == KIDS
    assert next(n for n in m.NOTES if n["slug"] == ADULT)["illustration"] == ADULT
    assert [n["id"] for n in m.NOTES] == [m.ADULT_ID, m.KIDS_ID] and m.ACTOR == rn.RELEASE_ACTOR
    assert m.STATUS == "draft"


async def test_drafts_not_shown_to_learners(env) -> None:
    """Пока продажи не включены, ученик заметку релиза 8 не видит: ни в «Что нового», ни в ленте."""
    welcome = (await staff_note(env, WELCOME))["release_note_id"]
    user = uuid.uuid4()
    s7 = await staff_note(env, "s7-social")
    await env.seen(user, [welcome, s7["release_note_id"],
                          (await staff_note(env, "s6-heroes"))["release_note_id"]])
    mode, slugs = await ids_for_me(env, user, onboarded_at="2026-11-20T07:00:00Z")
    assert ADULT not in slugs and KIDS not in slugs and mode == "none"
    for age in ("adults", "teens", "kids"):
        items = [n["slug"] for n in (await feed(env, age=age)).json()["items"]]
        assert ADULT not in items and KIDS not in items, age


async def test_audit_create_without_publication_event(env) -> None:
    events = [e for e in env.migration_events if e.event_type == PUBLISHED and e.payload["slug"] in (ADULT, KIDS)]
    assert events == []
    audits = [e for e in env.migration_events if e.event_type == AUDIT and e.payload["object_type"] == "release_note"
              and e.payload["after"]["slug"] in (ADULT, KIDS)]
    assert sorted((e.payload["after"]["slug"], e.payload["action"]) for e in audits) == [
        (ADULT, "release_note.create"), (KIDS, "release_note.create")]
    for e in audits:
        assert_event_conforms(e)
        assert (e.payload["actor_type"], e.payload["actor_id"], e.payload["actor_role"]) == (
            "system", "system:release", None)
        assert e.payload["after"]["status"] == "draft"
    dumped = json.dumps([e.payload for e in audits], ensure_ascii=False)
    assert "Telegram Stars" not in dumped and "Oila obunasi" not in dumped  # без текстов заметки


async def test_staff_publishes_draft_when_sales_enabled(env) -> None:
    """В день включения продаж сотрудник публикует черновик (whatsnew.publish + TOTP в admin-bff): дальше — как
    обычная заметка: событие публикации, ученик видит её один раз."""
    adult = await staff_note(env, ADULT)
    r = await publish(env, adult, reason="Продажи за Stars включены")
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "published" and r.json()["published_by"] == WN_PUBLISHER.id
    await env.flush()
    [event] = [e for e in env.events(PUBLISHED) if e.payload["slug"] == ADULT]
    assert_event_conforms(event)
    user = uuid.uuid4()
    for slug in (WELCOME, "s6-heroes", "s7-social"):
        await env.seen(user, [(await staff_note(env, slug))["release_note_id"]])
    mode, slugs = await ids_for_me(env, user, onboarded_at="2026-11-20T07:00:00Z")
    assert (mode, slugs) == ("updates", [ADULT])


# ---------------------------------------------------------------- обратимость и метка


async def test_downgrade_removes_release_notes(env) -> None:
    adult = await staff_note(env, ADULT)
    await publish(env, adult, reason="Проверка отката")
    viewer = uuid.uuid4()
    await env.seen(viewer, [adult["release_note_id"]])
    assert env.runtime.relay is not None
    await env.runtime.relay.stop()
    try:
        await _alembic(env, "downgrade", "0010")
        assert await scalar(env, "SELECT count(*) FROM release_notes WHERE slug LIKE 's8-%'") == 0
        assert await scalar(env, "SELECT count(*) FROM release_note_views WHERE user_id = :u", u=viewer) == 0
        assert await scalar(env, "SELECT count(*) FROM release_notes WHERE slug LIKE 's7-%'") == 2  # 7 не тронут
        await _alembic(env, "upgrade", "head")
    finally:
        env.runtime.relay.start()
    again = await staff_note(env, ADULT)
    assert again["status"] == "draft" and again["release_note_id"] == adult["release_note_id"]


async def test_upgrade_fails_when_staff_note_holds_the_label(env) -> None:
    await _alembic(env, "downgrade", "0010")
    taken = await create(env, note(KIDS))
    with pytest.raises(RuntimeError, match="label is taken"):
        await _alembic(env, "upgrade", "head")
    assert await scalar(env, "SELECT count(*) FROM release_notes WHERE created_by = 'system:release' "
                             "AND slug LIKE 's8-%'") == 0
    r = await env.c.post(f"/admin/v1/release-notes/{taken['release_note_id']}/archive",
                         json={"reason": "Освободить метку"}, headers=env.h(WN_PUBLISHER))
    assert r.status_code == 201
    await _alembic(env, "upgrade", "head")
    assert (await staff_note(env, KIDS))["created_by"] == "system:release"


def test_migration_notes_pass_service_checks() -> None:
    m = migration()
    assert [m.checked(n)["slug"] for n in m.NOTES] == [ADULT, KIDS]
    broken = {**m.NOTES[0], "items": [{**m.NOTES[0]["items"][0], "link": "web_pay"}]}
    with pytest.raises(RuntimeError, match="invalid content"):
        m.checked(broken)
    too_long = {**m.NOTES[0], "items": [{**m.NOTES[0]["items"][0],
                                         "text": {"ru": "д" * (rn.ITEM_TEXT_MAX + 1), "uz": "x"}}]}
    with pytest.raises(RuntimeError, match="invalid content"):
        m.checked(too_long)
    empty_uz = {**m.NOTES[1], "title": {"ru": "Заголовок", "uz": ""}}
    with pytest.raises(RuntimeError, match="RELEASE_NOTE_TRANSLATION_MISSING"):
        m.checked(empty_uz)
