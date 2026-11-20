"""Карточки (INTERNAL_API §1.2, §1.10): из урока, медиа и ошибок оценки, переоценка, ручное добавление слова из
контента, словарь, «Знаю это», удаление, журнал ошибок, проверка «в словаре», изоляция и доступ."""

from __future__ import annotations

import copy
import uuid
from typing import Any

from tilhero_common.internal_auth import HEADER

READING = {"kind": "reading", "key": "r-a1-coffee", "version": 1}
ERRORS = [
    {"turn_id": "T3", "evidence": "I from Tashkent", "correction": "I am from Tashkent.", "error_code": "missing_be",
     "severity": "high"},
    {"turn_id": "OA1", "evidence": "she go to work", "correction": "She goes to work.", "error_code": "agreement",
     "severity": "medium"},
    {"turn_id": "l-01-c2", "evidence": "is", "correction": "am", "error_code": "other", "severity": "low"},
]


async def cards_of(env: Any, user: uuid.UUID, **filters: str) -> list[dict[str, Any]]:
    query = "&".join(f"{k}={v}" for k, v in filters.items())
    return list((await env.get(user, f"cards?limit=100&{query}"))["items"])


async def test_lesson_feed_creates_word_and_phrase_cards(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    hello = env.catalog.by_form("hello")
    hello["forms"] = ["hello", "hullo"]  # статья словаря курса с формами → допустимые ответы
    await env.lesson_done(user)
    items = await cards_of(env, user)
    lesson = env.catalog.data["lesson"]["l-01-greetings"]
    assert len(items) == len(lesson["key_words"]) == 10
    by_text = {c["text_en"]: c for c in items}
    assert by_text["Hello!"]["kind"] == "word" and by_text["Nice to meet you."]["kind"] == "phrase"
    assert by_text["Hello!"]["gloss"] == lesson["key_words"][0]["gloss"]
    assert all(c["status"] == "new" and c["strength"] == "new" and c["gloss_source"] == "course" for c in items)
    assert all(c["due_at"] == "2026-11-20T05:00:00.000Z" for c in items)
    rows = dict(await env.sql("SELECT text_en, answers_en FROM cards WHERE user_id = :u", u=user))
    assert "hullo" in rows["Hello!"]
    assert rows["Goodbye! / Bye!"][:2] == ["Goodbye!", "Bye!"]
    detail = await env.get(user, f"cards/{by_text['Hello!']['card_id']}")
    assert detail["example_en"] == "Hello! I'm Malika."
    assert detail["sources"][0]["kind"] == "lesson" and detail["sources"][0]["title"] == lesson["title"]
    assert detail["error"] is None and detail["history"] == [] and detail["last_pronunciation"] is None


async def test_feed_is_idempotent_and_new_source_does_not_duplicate(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    ev = await env.lesson_done(user)
    feed = env.assessment.feeds[ev]
    await env.publish("assessment.completed.v1", {
        "evaluation_id": ev, "user_id": str(user), "pair_id": "ru-en", "session_id": feed["session_id"],
        "kind": "lesson", "skill_outcomes": [], "practice_only": False, "created_at": "2026-11-20T05:00:00Z"},
        "assessment")
    assert env.assessment.calls == 1  # повтор по evaluation_id — без нового запроса и без дублей
    payload = copy.deepcopy(env.catalog.data["lesson"]["l-01-greetings"])
    payload["key_words"][0]["example_en"] = "Hello, Tom!"
    env.catalog.publish("lesson", "l-01-greetings", payload)
    await env.lesson_done(user, version=2)
    assert len(await cards_of(env, user)) == 10
    [(sources,)] = await env.sql("SELECT sources FROM cards WHERE user_id = :u AND key = 'hello'", u=user)
    assert [(s["kind"], s["version"]) for s in sources] == [("lesson", 1), ("lesson", 2)]


async def test_media_phrases_only_with_dictionary_rights(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user, kind="media", media="m-own-coffee-order")
    items = await cards_of(env, user)
    phrases = env.catalog.data["media_asset"]["m-own-coffee-order"]["phrases"]
    assert len(items) == len(phrases)
    [(example,)] = await env.sql("SELECT example_en FROM cards WHERE user_id = :u AND text_en = :t", u=user,
                                 t=phrases[1]["en"])
    assert example and phrases[1]["en"].lower()[:10] in example.lower()
    other = uuid.uuid4()
    media = copy.deepcopy(env.catalog.data["media_asset"]["m-own-market-chat"])
    media["rights"]["allowed_uses"] = ["listen", "show_transcript", "exercises"]
    env.catalog.publish("media_asset", "m-own-market-chat", media)
    await env.lesson_done(other, kind="media", media="m-own-market-chat", version=2)
    assert await cards_of(env, other) == []


async def test_error_cards_for_adults_only_from_free_text(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    env.identity.set(user, age_band="18+")
    await env.lesson_done(user, errors=ERRORS)
    errors = await cards_of(env, user, kind="error")
    assert sorted(c["text_en"] for c in errors) == ["I am from Tashkent.", "She goes to work."]
    journal = (await env.get(user, "errors"))["items"]
    assert len(journal) == 2 and all("evidence" not in j for j in journal)
    item = next(j for j in journal if j["error_code"] == "missing_be")
    assert item["explanation"]["ru"] == "Пропущен глагол be" and item["severity"] == "high"
    assert item["lesson_title"] == env.catalog.data["lesson"]["l-01-greetings"]["title"]
    detail = await env.get(user, f"cards/{item['card_id']}")
    assert detail["error"]["evidence"] == "I from Tashkent" and detail["error"]["correction"] == "I am from Tashkent."


async def test_no_error_cards_for_children(env) -> None:  # type: ignore[no-untyped-def]
    child, kid_known = uuid.uuid4(), uuid.uuid4()
    env.identity.set(child, age_band="6-9", kind="child")
    await env.lesson_done(child, errors=ERRORS)
    assert await cards_of(env, child, kind="error") == [] and len(await cards_of(env, child)) == 10
    # детская полоса уже известна из claims — identity не спрашивается
    await env.get(kid_known, "overview", age_band="10-13")
    calls = env.identity.calls
    await env.lesson_done(kid_known, errors=ERRORS)
    assert env.identity.calls == calls and await cards_of(env, kid_known, kind="error") == []
    assert (await env.get(kid_known, "errors", age_band="10-13"))["items"] == []


async def test_identity_down_retries_feed(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    env.identity.down = True
    await env.lesson_done(user, errors=ERRORS)
    assert env.bus.transient and await cards_of(env, user) == []
    env.identity.down = False
    env.assessment.down = True
    other = uuid.uuid4()
    await env.lesson_done(other)
    assert len(env.bus.transient) == 2 and await cards_of(env, other) == []


async def test_reevaluation_archives_removed_errors(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    env.identity.set(user)
    sid = str(uuid.uuid4())
    ev = await env.lesson_done(user, errors=ERRORS[:2], session_id=sid)
    new_ev = env.assessment.feed(user, errors=ERRORS[:1], session_id=sid)
    env.assessment.feeds[ev]["superseded_by"] = new_ev
    await env.publish("assessment.reevaluated.v1", {
        "evaluation_id": new_ev, "supersedes": ev, "session_id": sid, "user_id": str(user), "pair_id": "ru-en",
        "skill_outcomes": [], "created_at": "2026-11-20T06:00:00Z"}, "assessment")
    errors = await cards_of(env, user, kind="error")
    assert [c["text_en"] for c in errors] == ["I am from Tashkent."]
    rows = await env.sql("SELECT l.actor, l.reason, l.grade, l.after->>'status' FROM review_log l JOIN cards c "
                         "ON c.card_id = l.card_id WHERE c.user_id = :u AND c.key = 'she goes to work'", u=user)
    assert rows == [("system", "reevaluated", None, "archived")]


async def test_untrusted_producer_ignored(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    ev = env.assessment.feed(user)
    await env.publish("assessment.completed.v1", {
        "evaluation_id": ev, "user_id": str(user), "pair_id": "ru-en", "session_id": str(uuid.uuid4()),
        "kind": "lesson", "skill_outcomes": [], "practice_only": False, "created_at": "2026-11-20T05:00:00Z"},
        "lessons")
    assert await cards_of(env, user) == [] and env.assessment.calls == 0


async def test_manual_add_from_reading_with_ai_gloss(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    body = {"text_en": "croissant", "source": READING}
    card = await env.post(user, "cards", body, 201, key="add-croissant-1")
    assert card["gloss"] == {"ru": "[ru] croissant", "uz": "[uz] croissant"} and card["gloss_source"] == "ai"
    assert card["kind"] == "word" and card["status"] == "new"
    assert await env.post(user, "cards", body, 201, key="add-croissant-1") == card  # повтор ключа — тот же ответ
    again = await env.post(user, "cards", body, 200, key="add-croissant-2")  # уже есть — 200, без дубля
    assert again["card_id"] == card["card_id"]
    r = await env.c.post("/internal/v1/cards", json={"text_en": "barista", "source": READING},
                         headers={**env.h(user), "Idempotency-Key": "add-croissant-1"})
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    # форма INTERNAL_API: {source: {kind, key, version, text_en}}
    lesson_word = await env.post(user, "cards", {"source": {"kind": "lesson", "key": "l-01-greetings", "version": 1,
                                                            "text_en": "Nice to meet you."}}, 201, key="add-nice-01")
    assert lesson_word["gloss_source"] == "course" and lesson_word["kind"] == "phrase"
    [(example,)] = await env.sql("SELECT example_en FROM cards WHERE card_id = :c",
                                 c=uuid.UUID(card["card_id"]))
    assert example == "She orders a cup of tea and a croissant."


async def test_manual_add_errors(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    async def add(body: dict[str, Any], status: int, code: str | None = None, key: str | None = None) -> None:
        headers = env.h(user)
        if key is not None:
            headers["Idempotency-Key"] = key
        r = await env.c.post("/internal/v1/cards", json=body, headers=headers)
        assert r.status_code == status, r.text
        if code:
            assert r.json()["code"] == code

    await add({"text_en": "pizza", "source": READING}, 422, "WORD_NOT_IN_CONTENT", "k-pizza-01")
    await add({"text_en": "barista", "source": {**READING, "version": 9}}, 404, "CONTENT_NOT_FOUND", "k-bar-0001")
    env.catalog.drafts.add(("reading", "r-a1-coffee", 1))
    await add({"text_en": "barista", "source": READING}, 404, "CONTENT_NOT_FOUND", "k-bar-0002")
    env.catalog.drafts.clear()
    env.ai.gloss_mode = "unavailable"
    await add({"text_en": "barista", "source": READING}, 422, "GLOSS_UNAVAILABLE", "k-bar-0003")
    await add({"text_en": "barista", "source": READING}, 400, "IDEMPOTENCY_KEY_REQUIRED")
    await add({"text_en": "barista", "source": READING}, 422, "IDEMPOTENCY_KEY_INVALID", "short")
    await add({"text_en": "x" * 121, "source": READING}, 422, "VALIDATION_ERROR", "k-long-001")
    await add({"text_en": "barista", "source": {**READING, "kind": "course"}}, 422, "VALIDATION_ERROR", "k-kind-01")
    await add({"text_en": "barista", "source": READING, "extra": 1}, 422, "VALIDATION_ERROR", "k-extra-1")
    env.catalog.down = True
    await add({"text_en": "barista", "source": READING}, 503, "CATALOG_UNAVAILABLE", "k-down-001")


async def test_cards_limit(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    env.settings.cards_limit = 10
    await env.lesson_done(user)
    await env.lesson_done(user, "l-02-where-from")  # лимит — новые карточки пропускаются
    assert len(await cards_of(env, user)) == 10
    r = await env.c.post("/internal/v1/cards", json={"text_en": "croissant", "source": READING},
                         headers={**env.h(user), "Idempotency-Key": "k-limit-01"})
    assert r.status_code == 422 and r.json() == {**r.json(), "code": "CARDS_LIMIT", "details": {"limit": 10}}


async def test_dictionary_filters_search_and_pagination(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    words = await cards_of(env, user, kind="word")
    assert {c["text_en"] for c in words} == {"Hello!", "Hi!"}
    found = await cards_of(env, user, q="привет")
    assert {c["text_en"] for c in found} == {"Hello!", "Hi!"}
    assert {c["text_en"] for c in await cards_of(env, user, q="MEET")} == {"Nice to meet you."}
    page1 = await env.get(user, "cards?limit=4")
    page2 = await env.get(user, f"cards?limit=4&cursor={page1['next_cursor']}")
    page3 = await env.get(user, f"cards?limit=4&cursor={page2['next_cursor']}")
    ids = [c["card_id"] for p in (page1, page2, page3) for c in p["items"]]
    assert len(ids) == len(set(ids)) == 10 and page3["next_cursor"] is None
    r = await env.c.get("/internal/v1/cards?cursor=@@@", headers=env.h(user))
    assert r.status_code == 400 and r.json()["code"] == "INVALID_CURSOR"
    r = await env.c.get("/internal/v1/cards?status=archived", headers=env.h(user))
    assert r.status_code == 422


async def test_known_unknown_and_delete(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    card = (await cards_of(env, user))[0]
    cid = card["card_id"]
    known = await env.post(user, f"cards/{cid}/known")
    assert known["status"] == "known" and known["due_at"] is None
    assert (await env.post(user, f"cards/{cid}/known"))["status"] == "known"  # повтор
    env.now = env.now.replace(hour=8)
    r = await env.c.delete(f"/internal/v1/cards/{cid}/known", headers=env.h(user))
    assert r.status_code == 200 and r.json()["status"] == "new" and r.json()["due_at"] == "2026-11-20T08:00:00.000Z"
    log = await env.sql("SELECT task_type, grade, answer_mode FROM review_log WHERE card_id = :c ORDER BY created_at",
                        c=uuid.UUID(cid))
    assert log == [("known", None, "manual"), ("unknown", None, "manual")]
    r = await env.c.delete(f"/internal/v1/cards/{cid}", headers=env.h(user))
    assert r.status_code == 204
    assert (await env.c.delete(f"/internal/v1/cards/{cid}", headers=env.h(user))).status_code == 204
    assert cid not in {c["card_id"] for c in await cards_of(env, user)}
    assert (await env.c.get(f"/internal/v1/cards/{cid}", headers=env.h(user))).status_code == 404
    r = await env.c.post(f"/internal/v1/cards/{cid}/known", headers=env.h(user))
    assert r.status_code == 404 and r.json()["code"] == "CARD_NOT_FOUND"
    # удалённую учеником карточку урок не возвращает; ручное добавление — возвращает
    await env.lesson_done(user)
    assert cid not in {c["card_id"] for c in await cards_of(env, user)}
    restored = await env.post(user, "cards", {"text_en": card["text_en"], "source": {
        "kind": "lesson", "key": "l-01-greetings", "version": 1}}, 200, key="k-restore-1")
    assert restored["card_id"] == cid and restored["status"] == "new"


async def test_lookup_in_dictionary(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    res = await env.post(user, "cards/lookup", {"texts": ["Hello!", "HELLO", "pizza", "Nice to meet you"]})
    items = res["items"]
    assert items[0]["card_id"] and items[0]["card_id"] == items[1]["card_id"]
    assert items[2] == {"text": "pizza", "card_id": None} and items[3]["card_id"]
    other = uuid.uuid4()
    assert all(i["card_id"] is None for i in (await env.post(other, "cards/lookup", {"texts": ["Hello!"]}))["items"])
    r = await env.c.post("/internal/v1/cards/lookup", json={"texts": ["a"] * 51}, headers=env.h(user))
    assert r.status_code == 422


async def test_isolation_and_auth(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    await env.lesson_done(user)
    cid = (await cards_of(env, user))[0]["card_id"]
    intruder = uuid.uuid4()
    for method, path in (("GET", f"cards/{cid}"), ("POST", f"cards/{cid}/known"), ("DELETE", f"cards/{cid}"),
                         ("DELETE", f"cards/{cid}/known")):
        r = await env.c.request(method, f"/internal/v1/{path}", headers=env.h(intruder))
        assert r.status_code == 404, path
    assert await cards_of(env, intruder) == []
    assert (await env.c.get("/internal/v1/cards")).status_code == 401
    r = await env.c.get("/internal/v1/cards", headers={HEADER: "garbage"})
    assert r.status_code == 401
    r = await env.c.get("/internal/v1/cards", headers=env.h(user, issuer="admin-bff"))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.get("/internal/v1/cards", headers=env.h(user, issuer="lessons"))
    assert r.status_code == 403


async def test_feed_of_deleted_learner_is_skipped_without_retry(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    """410 от assessment (ученик удалён; например, повтор старых событий новым consumer) — событие подтверждается без
    карточек и без повторной доставки (иначе бесконечные повторы до DLQ)."""
    ev = env.assessment.feed(user)
    env.assessment.gone.add(ev)
    feed = env.assessment.feeds[ev]
    await env.publish("assessment.completed.v1", {
        "evaluation_id": ev, "user_id": str(user), "pair_id": "ru-en", "session_id": feed["session_id"],
        "kind": "lesson", "skill_outcomes": [], "practice_only": False, "created_at": "2026-11-20T05:00:00Z"},
        "assessment")
    assert env.assessment.calls == 1
    assert await cards_of(env, user) == []

