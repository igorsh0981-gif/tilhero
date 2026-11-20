"""Спринт 5, словарь курса (INTERNAL_API §2.2–2.4): построение статей course при миграции и публикации (уроки,
медиа, тексты), приоритеты (course > ai; первая публикация главнее; правка через версию того же контента), поиск для
memory (слово в опубликованной версии, locator, выражения, апострофы, черновик → 404), переводы ИИ (upsert, гонка),
статьи по формам, задания проверок удержания, события catalog.glossary.changed.v1."""

from __future__ import annotations

import asyncio
import copy
import uuid
from typing import Any

import ts_contract as ts
from catalog_kit import (
    CONTENT_MANAGER,
    GLOSSARIST,
    PUBLISHER,
    READER,
    L,
    lesson,
    media,
    reading,
)

from tilhero_common.testing import assert_event_conforms

CHANGED = "catalog.glossary.changed.v1"
LOOKUP = "/internal/v1/glossary/lookup"
AI = "/internal/v1/glossary/ai-entries"
FORMS = "/internal/v1/glossary/forms"
ENTRY_FIELDS = set(ts.fields("content.ts", "GlossaryEntry"))


def ref(kind: str = "reading", key: str = "r-a1-coffee-shop", version: int = 1,
        locator: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": kind, "key": key, "version": version}
    if locator is not None:
        out["locator"] = locator
    return out


async def entries(env, *forms: str, pair: str = "ru-en") -> dict[str, dict[str, Any] | None]:
    r = await env.c.get(FORMS, params=[("pair_id", pair), *(("forms", f) for f in forms)], headers=env.memory())
    assert r.status_code == 200, r.text
    return {i["form"]: i["entry"] for i in r.json()["items"]}


async def one(env, form: str) -> dict[str, Any]:
    found = (await entries(env, form))[form]
    assert found is not None, form
    return found


async def detail(env, entry_id: str) -> dict[str, Any]:
    r = await env.c.get(f"/admin/v1/glossary/{entry_id}", headers=env.h(READER))
    assert r.status_code == 200, r.text
    return dict(r.json())


def ai_body(surface: str, *, lemma: str | None = None, forms: list[str] | None = None,
            content: dict[str, Any] | None = None, confidence: float = 0.9) -> dict[str, Any]:
    return {"pair_id": "ru-en", "surface": surface, "lemma": lemma or surface, "part_of_speech": "noun",
            "gloss": L(f"[ru] {surface}", f"[uz] {surface}"), "forms": forms or [], "confidence": confidence,
            "agent_version": "teaching_coach@2", "content_ref": content or ref()}


async def changed(env) -> list[dict[str, Any]]:
    await env.flush()
    out = []
    for e in env.events(CHANGED):
        assert_event_conforms(e)
        out.append(e.payload)
    return out


FILLER = [("apple", "яблоко", "olma"), ("bread", "хлеб", "non"), ("water", "вода", "suv")]


def lesson_with(lesson_id: str, key_words: list[dict[str, Any]]) -> dict[str, Any]:
    """Урок с заданными опорными словами (до 4 — дополняется общими: apple, bread, water)."""
    p = lesson(lesson_id)
    p["key_words"] = key_words + [kw(*f) for f in FILLER[:max(0, 4 - len(key_words))]]
    return p


def kw(en: str, ru: str, uz: str, example: str = "Example sentence.") -> dict[str, Any]:
    return {"en": en, "gloss": L(ru, uz), "example_en": example}


# ---------------------------------------------------------------- построение: миграция


async def test_migration_builds_course_entries_from_published(env) -> None:
    found = await entries(env, "hello", "nice to meet you", "what would you like", "small or large", "come back",
                          "cat", "tea", "nope")
    hello = found["hello"]
    assert hello is not None and set(hello) == ENTRY_FIELDS
    assert (hello["source"], hello["review_status"], hello["forms"], hello["lemma"]) == (
        "course", "not_required", ["hello"], "hello")
    assert hello["gloss"] == L("привет, здравствуйте", "salom") and hello["example_en"] == "Hello, I'm Sam."
    assert hello["refs"] == [ref("lesson", "l-01-greetings")] and hello["part_of_speech"] is None
    phrase = found["nice to meet you"]
    assert phrase is not None and phrase["part_of_speech"] == "phrase"
    media_phrase = found["what would you like"]
    assert media_phrase is not None and media_phrase["lemma"] == "What would you like"
    assert media_phrase["example_en"] == "Hi! What would you like?"
    assert media_phrase["refs"] == [ref("media_asset", "m-own-coffee-order")]
    come_back = found["come back"]
    assert come_back is not None and come_back["refs"] == [ref("reading", "r-a1-coffee-shop")]
    assert come_back["example_en"] == "Anna likes her new drink and decides to come back tomorrow."
    assert found["cat"] is not None and found["nope"] is None
    d = await detail(env, hello["entry_id"])
    assert [h["action"] for h in d["history"]] == ["created"] and d["history"][0]["by"] is None
    assert d["refs_titles"][0]["title"] == L("Привет! Как тебя зовут?", "Salom! Isming nima?")
    assert d["conflicts"] == []
    rows = await env.sql("SELECT count(*) AS n FROM glossary_entries WHERE source = 'course'")
    assert rows[0]["n"] == 8 + 2 + 5 + 4  # 2 урока × 4, медиа × 2, тексты 5 + 4


# ---------------------------------------------------------------- построение: публикация


async def test_publish_lesson_builds_and_first_publication_wins(env) -> None:
    hello_before = await one(env, "hello")
    p = lesson_with("l-02-polite", [
        kw("hello", "алло", "allo"),  # форма уже у статьи course другого урока → только ref
        kw("thank you", "спасибо", "rahmat", "Thank you, Tom!"),
        kw("Goodbye! / Bye!", "до свидания / пока", "xayr"),
        kw("My name is …", "меня зовут…", "mening ismim…"),
    ])
    await env.published_new("lesson", p)
    events = await changed(env)
    created = [e for e in events if e["change"] == "created"]
    assert sorted(tuple(e["forms"]) for e in created) == [("goodbye", "bye"), ("my name is",), ("thank you",)]
    hello = await one(env, "hello")
    assert hello["entry_id"] == hello_before["entry_id"] and hello["gloss"] == hello_before["gloss"]
    assert hello["refs"] == [ref("lesson", "l-01-greetings"), ref("lesson", "l-02-polite")]
    d = await detail(env, hello["entry_id"])
    assert d["conflicts"] == [{"ref": ref("lesson", "l-02-polite"), "gloss": L("алло", "allo")}]
    assert [h["action"] for h in d["history"]] == ["created"]  # дописанный ref — не правка
    bye = await one(env, "bye")
    assert bye["forms"] == ["goodbye", "bye"] and bye["lemma"] == "Goodbye / Bye"
    assert bye["part_of_speech"] is None
    assert (await one(env, "my name is"))["lemma"] == "My name is …"
    hist = (await detail(env, bye["entry_id"]))["history"]
    assert hist[0]["by"] == PUBLISHER.id and hist[0]["reason"] == "Публикация lesson:l-02-polite@1"
    # повтор той же версии (no-op публикации) — без изменений
    r = await env.publish("lesson", "l-02-polite", 1)
    assert r.status_code == 200
    env.bus.published.clear()
    assert await changed(env) == []


async def test_republish_same_content_updates_gloss_and_rollback(env) -> None:
    hello = await one(env, "hello")
    key_words = copy.deepcopy(lesson("x")["key_words"])
    key_words[0]["gloss"] = L("привет", "salom!")
    v2 = await env.edit_published("lesson", "l-01-greetings", 1, {"key_words": key_words})
    assert (await env.publish("lesson", "l-01-greetings", v2)).status_code == 200
    after = await one(env, "hello")
    assert after["entry_id"] == hello["entry_id"] and after["gloss"] == L("привет", "salom!")
    assert after["refs"] == [ref("lesson", "l-01-greetings", v2)]  # одна ссылка на ключ контента
    events = await changed(env)
    assert [(e["change"], e["forms"]) for e in events] == [("updated", ["hello"])]
    d = await detail(env, hello["entry_id"])
    assert [h["action"] for h in d["history"]] == ["updated", "created"]
    assert d["history"][0]["before"]["gloss"] == L("привет, здравствуйте", "salom")
    # откат к v1 — перевод v1 снова
    r = await env.c.post("/admin/v1/content/lesson/l-01-greetings/rollback",
                         json={"to_version": 1, "reason": "Вернуть прежний текст"}, headers=env.h(PUBLISHER))
    assert r.status_code == 200, r.text
    back = await one(env, "hello")
    assert back["gloss"] == L("привет, здравствуйте", "salom") and back["refs"] == [ref("lesson", "l-01-greetings")]


async def test_course_replaces_ai_entry(env) -> None:
    r = await env.c.post(AI, json=ai_body("barista", content=ref(locator="s3")), headers=env.memory())
    assert r.status_code == 201, r.text
    ai_entry = r.json()
    await env.published_new("lesson", lesson_with("l-03-cafe", [kw("barista", "бариста", "barista"),
                                                                kw("cup", "чашка", "piyola")]))
    course = await one(env, "barista")
    assert course["source"] == "course" and course["entry_id"] != ai_entry["entry_id"]
    old = await detail(env, ai_entry["entry_id"])
    assert old["archived_at"] is not None and old["history"][0]["action"] == "archived"
    events = await changed(env)
    assert ("archived", ai_entry["entry_id"]) in [(e["change"], e["entry_id"]) for e in events]
    assert ("created", course["entry_id"]) in [(e["change"], e["entry_id"]) for e in events]


async def test_methodist_entry_keeps_form_and_gets_ref(env) -> None:
    r = await env.c.post("/admin/v1/glossary", json={"pair_id": "ru-en", "lemma": "thank you", "forms": ["thank you"],
                                                     "part_of_speech": "phrase", "gloss": L("спасибо", "rahmat"),
                                                     "example_en": None, "reason": None},
                         headers=env.h(GLOSSARIST))
    assert r.status_code == 201, r.text
    entry_id = r.json()["entry_id"]
    await env.published_new("lesson", lesson_with("l-04-thanks", [kw("Thank you!", "благодарю", "tashakkur")]))
    entry = await one(env, "thank you")
    assert entry["entry_id"] == entry_id and entry["source"] == "methodist" and entry["gloss"] == L("спасибо",
                                                                                                    "rahmat")
    assert entry["refs"] == [ref("lesson", "l-04-thanks")]
    assert (await detail(env, entry_id))["conflicts"] == [{"ref": ref("lesson", "l-04-thanks"),
                                                           "gloss": L("благодарю", "tashakkur")}]


async def test_partial_overlap_of_alternatives(env) -> None:
    small = await one(env, "small")
    await env.published_new("lesson", lesson_with("l-05-sizes", [kw("small / medium / large", "маленький / средний"
                                                                    " / большой", "kichik / oʻrta / katta")]))
    medium = await one(env, "medium")
    assert medium["forms"] == ["medium", "large"] and medium["lemma"] == "small / medium / large"
    assert (await one(env, "large"))["entry_id"] == medium["entry_id"]
    after = await one(env, "small")
    assert after["entry_id"] == small["entry_id"] and len(after["refs"]) == 2


async def test_media_phrases_only_with_dictionary_use(env) -> None:
    p = media("m-no-dict", allowed_uses=["listen", "show_transcript"])
    p["phrases"] = [{"en": "Have a nice day!", "gloss": L("хорошего дня", "kuningiz yaxshi oʻtsin"), "t_ms": 9000}]
    await env.published_new("media_asset", p)
    assert (await entries(env, "have a nice day"))["have a nice day"] is None
    p2 = media("m-with-dict")
    p2["phrases"] = p["phrases"]
    await env.published_new("media_asset", p2)
    entry = await one(env, "have a nice day")
    assert entry["refs"] == [ref("media_asset", "m-with-dict")]
    assert entry["example_en"] == "Here you go. Have a nice day!"


async def test_reading_publish_builds_entries(env) -> None:
    p = reading("r-a1-new-words")
    p["glossary"].append({"en": "barista", "gloss": L("бариста", "barista"),
                          "note": L("кто готовит кофе", "qahva tayyorlovchi")})
    await env.published_new("reading", p)
    entry = await one(env, "barista")
    assert entry["refs"] == [ref("reading", "r-a1-new-words")]
    assert entry["example_en"] == "The barista, Tom, always says hello and asks about her day."
    # статьи из уже существующих форм получили ссылку
    assert ref("reading", "r-a1-new-words") in (await one(env, "coffee shop"))["refs"]


# ---------------------------------------------------------------- поиск для memory


async def lookup(env, text: str, content: dict[str, Any], pair: str = "ru-en"):
    return await env.c.post(LOOKUP, json={"pair_id": pair, "text": text, "content_ref": content},
                            headers=env.memory())


async def test_lookup_found_with_entry(env) -> None:
    r = await lookup(env, "coffee shop", ref())
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"in_content", "sentence_en", "locator", "entry", "rejected", "note"}
    assert body["in_content"] is True and body["locator"] == "s1" and body["rejected"] is False
    assert body["sentence_en"] == "Every morning, Anna goes to a small coffee shop near her office."
    assert body["entry"]["lemma"] == "coffee shop" and set(body["entry"]) == ENTRY_FIELDS
    # слово контента без статьи — in_content, entry null (memory идёт к ИИ)
    r = await lookup(env, "office", ref())
    assert r.status_code == 200 and r.json()["entry"] is None and r.json()["locator"] == "s1"
    # пояснение глоссария текста
    r = await lookup(env, "Come back", ref())
    assert r.json()["note"] == L("фразовый глагол", "frazali feʼl")


async def test_lookup_word_not_in_content(env) -> None:
    for text in ("spaceship", "eet", "off", "coffee  barista", "!!!", "shop coffee"):
        r = await lookup(env, text, ref())
        assert r.status_code == 422 and r.json()["code"] == "WORD_NOT_IN_CONTENT", text


async def test_lookup_locator(env) -> None:
    r = await lookup(env, "tea", ref(locator="s2"))
    assert r.status_code == 200 and r.json()["sentence_en"] == "She usually orders a cup of tea with milk."
    r = await lookup(env, "tea", ref(locator="s1"))  # есть в тексте, но не в этом предложении
    assert r.status_code == 422 and r.json()["code"] == "WORD_NOT_IN_CONTENT"
    assert (await lookup(env, "tea", ref(locator="s99"))).status_code == 422
    # медиа — индекс реплики; урок — ex:<i> / kw:<i>; сценарий — node_id
    r = await lookup(env, "hot chocolate", ref("media_asset", "m-own-coffee-order", locator="1"))
    assert r.status_code == 200 and r.json()["sentence_en"] == "A hot chocolate, please."
    assert (await lookup(env, "hot chocolate", ref("media_asset", "m-own-coffee-order", locator="0"))
            ).status_code == 422
    r = await lookup(env, "Dina", ref("lesson", "l-01-greetings", locator="ex:1"))
    assert r.status_code == 200 and r.json()["sentence_en"] == "My name is Dina. Nice to meet you!"
    r = await lookup(env, "Sam", ref("lesson", "l-01-greetings", locator="kw:0"))
    assert r.status_code == 200 and r.json()["sentence_en"] == "Hello, I'm Sam."
    r = await lookup(env, "hello", ref("lesson", "l-01-greetings", locator="kw:0"))
    assert r.json()["sentence_en"] == "Hello, I'm Sam." and r.json()["entry"]["lemma"] == "hello"
    r = await lookup(env, "What can I get you", ref("scenario", "sc-cafe-coffee", locator="n1"))
    assert r.status_code == 200 and r.json()["sentence_en"] == "Hi there! What can I get you?"
    # ключи ответов (gap_fill answer «is» не входит, но слово есть в тексте урока) — по prompt и примерам
    r = await lookup(env, "Good night", ref("lesson", "l-01-greetings"))
    assert r.status_code == 200 and r.json()["locator"] == "ci:0"


async def test_lookup_expressions_apostrophes_and_case(env) -> None:
    r = await lookup(env, "Nice to meet you", ref("lesson", "l-01-greetings"))
    assert r.status_code == 200 and r.json()["entry"]["forms"] == ["nice to meet you"]
    r = await lookup(env, "NICE  to meet   you!", ref("lesson", "l-01-greetings"))
    assert r.status_code == 200 and r.json()["entry"]["lemma"] == "nice to meet you"
    # апострофы: I’m ≡ I'm; What's
    for text in ("I'm", "I’m", "i‘m", "What's"):
        r = await lookup(env, text, ref("lesson", "l-01-greetings"))
        assert r.status_code == 200, text
    assert (await lookup(env, "Im", ref("lesson", "l-01-greetings"))).status_code == 422
    # выражение из реплики медиа с пунктуацией внутри
    r = await lookup(env, "Small, please", ref("media_asset", "m-own-coffee-order"))
    assert r.status_code == 200 and r.json()["locator"] == "3"
    r = await lookup(env, "small or large?", ref("media_asset", "m-own-coffee-order"))
    assert r.json()["entry"]["lemma"] == "Small or large"
    # «Goodbye! / Bye!» — статья по любой из форм
    await env.published_new("lesson", lesson_with("l-06-bye", [kw("Goodbye! / Bye!", "до свидания / пока", "xayr",
                                                                  "Bye, Tom! Goodbye, everyone!")]))
    r = await lookup(env, "bye", ref("lesson", "l-06-bye"))
    assert r.status_code == 200 and r.json()["entry"]["forms"] == ["goodbye", "bye"]


async def test_lookup_only_released_versions(env) -> None:
    # черновик новой версии урока — 404; бывшая опубликованной (архивная) — по-прежнему ищется
    r = await env.new_version("lesson", "l-07-coffee", 1)
    assert r.status_code == 201
    r = await lookup(env, "tea", ref("lesson", "l-07-coffee", 2))
    assert r.status_code == 404 and r.json()["code"] == "CONTENT_NOT_FOUND"
    await env.create("reading", reading("r-draft-only"))
    assert (await lookup(env, "coffee shop", ref("reading", "r-draft-only"))).status_code == 404
    assert (await lookup(env, "tea", ref("reading", "r-nope"))).status_code == 404
    r = await env.c.post("/admin/v1/content/reading/r-a1-coffee-shop/archive", json={"reason": "Снять текст"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 200
    assert (await lookup(env, "coffee shop", ref())).status_code == 200  # бывшая опубликованной


async def test_lookup_rejected_ai_entry(env) -> None:
    r = await env.c.post(AI, json=ai_body("office"), headers=env.memory())
    assert r.status_code == 201
    entry_id = r.json()["entry_id"]
    assert (await lookup(env, "office", ref())).json()["entry"]["entry_id"] == entry_id
    r = await env.c.post(f"/admin/v1/glossary/{entry_id}/review", json={"decision": "reject", "note": "неверно"},
                         headers=env.h(GLOSSARIST))
    assert r.status_code == 200, r.text
    body = (await lookup(env, "office", ref())).json()
    assert body["entry"] is None and body["rejected"] is True
    # ИИ не создаёт статью заново: форма занята отклонённой
    r = await env.c.post(AI, json=ai_body("office"), headers=env.memory())
    assert r.status_code == 200 and r.json()["review_status"] == "rejected"


async def test_lookup_auth_and_validation(env) -> None:
    body = {"pair_id": "ru-en", "text": "tea", "content_ref": ref()}
    assert (await env.c.post(LOOKUP, json=body)).status_code == 401
    for caller in ("telegram-bff", "lessons", "assessment"):
        r = await env.c.post(LOOKUP, json=body, headers=env.svc(caller))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
    assert (await env.c.post(LOOKUP, json=body, headers=env.h(READER))).status_code == 403
    for bad in ({**body, "text": ""}, {**body, "text": "x" * 121}, {**body, "pair_id": "RU"},
                {**body, "content_ref": ref("rubric", "r-lesson-core")}, {**body, "extra": 1},
                {**body, "content_ref": {**ref(), "version": 0}}, {**body, "text": "tea‮"}):
        assert (await env.c.post(LOOKUP, json=bad, headers=env.memory())).status_code == 422, bad


# ---------------------------------------------------------------- переводы ИИ


async def test_ai_entry_create_and_existing(env) -> None:
    r = await env.c.post(AI, json=ai_body("Orders", lemma="order", forms=["ordered", "orders"],
                                          content=ref(locator="s2")), headers=env.memory())
    assert r.status_code == 200  # «orders» — уже статья course из глоссария текста
    assert r.json()["source"] == "course"
    r = await env.c.post(AI, json=ai_body("usually", lemma="usually", forms=["Usually"]), headers=env.memory())
    assert r.status_code == 201, r.text
    e = r.json()
    assert set(e) == ENTRY_FIELDS
    assert (e["source"], e["review_status"], e["confidence"], e["agent_version"]) == (
        "ai", "pending", 0.9, "teaching_coach@2")
    assert e["forms"] == ["usually"] and e["refs"] == [ref()] and e["updated_by"] is None
    events = await changed(env)
    assert [(x["change"], x["entry_id"]) for x in events] == [("created", e["entry_id"])]
    again = await env.c.post(AI, json=ai_body("usually"), headers=env.memory())
    assert again.status_code == 200 and again.json()["entry_id"] == e["entry_id"]
    # другая форма той же леммы → та же статья
    other = await env.c.post(AI, json=ai_body("goes", lemma="go", forms=["usually"]), headers=env.memory())
    assert other.status_code == 200 and other.json()["entry_id"] == e["entry_id"]


async def test_ai_entry_requires_word_in_content(env) -> None:
    r = await env.c.post(AI, json=ai_body("spaceship"), headers=env.memory())
    assert r.status_code == 422 and r.json()["code"] == "WORD_NOT_IN_CONTENT"
    r = await env.c.post(AI, json=ai_body("tea", content=ref("reading", "r-nope")), headers=env.memory())
    assert r.status_code == 404 and r.json()["code"] == "CONTENT_NOT_FOUND"
    r = await env.c.post(AI, json={**ai_body("office"), "pair_id": "xx-yy"}, headers=env.memory())
    assert r.status_code == 404 and r.json()["code"] == "PAIR_NOT_FOUND"
    bad = ai_body("office")
    bad["gloss"]["ru"] = "x" * 81
    assert (await env.c.post(AI, json=bad, headers=env.memory())).status_code == 422
    assert (await env.c.post(AI, json={**ai_body("office"), "confidence": 1.5}, headers=env.memory())
            ).status_code == 422
    assert (await env.c.post(AI, json=ai_body("office"), headers=env.svc("telegram-bff"))).status_code == 403


async def test_ai_entry_race_two_requests(env) -> None:
    """Два параллельных перевода одного слова: одна статья (201), второй получает её же (200)."""
    body = ai_body("milk", content=ref(locator="s2"))
    first, second = await asyncio.gather(env.c.post(AI, json=body, headers=env.memory()),
                                         env.c.post(AI, json=ai_body("Milk", lemma="milk"), headers=env.memory()))
    assert sorted([first.status_code, second.status_code]) == [200, 201]
    assert first.json()["entry_id"] == second.json()["entry_id"]
    rows = await env.sql("SELECT count(*) AS n FROM glossary_forms WHERE form_key = 'milk'")
    assert rows[0]["n"] == 1


# ---------------------------------------------------------------- статьи по формам


async def test_forms_lookup(env) -> None:
    found = await entries(env, "hello", "Nice to meet you!", "got it, thanks", "his / hello")
    assert found["hello"]["lemma"] == "hello"
    assert found["Nice to meet you!"]["lemma"] == "nice to meet you"
    assert found["got it, thanks"] is None
    assert found["his / hello"]["lemma"] == "hello"  # варианты через « / »
    # одно значение через запятую — и целиком, и по частям
    r = await env.c.get(FORMS, params={"pair_id": "ru-en", "forms": "hello,tea"}, headers=env.memory())
    items = {i["form"]: i["entry"] for i in r.json()["items"]}
    assert set(items) == {"hello,tea", "hello", "tea"} and items["tea"]["lemma"] == "tea"
    other_pair = await entries(env, "hello", pair="ru-uz")
    assert other_pair["hello"] is None
    too_many = [("pair_id", "ru-en"), *(("forms", f"w{i}") for i in range(51))]
    assert (await env.c.get(FORMS, params=too_many, headers=env.memory())).status_code == 422
    assert (await env.c.get(FORMS, params={"pair_id": "ru-en"}, headers=env.memory())).status_code == 422
    assert (await env.c.get(FORMS, params={"pair_id": "ru-en", "forms": "a"}, headers=env.svc("lessons"))
            ).status_code == 403


# ---------------------------------------------------------------- задания проверок удержания (§2.4)


async def test_check_items_with_keys_order_and_limits(env) -> None:
    url = "/internal/v1/skills/en.func.greet/check-items"
    r = await env.c.get(url, params={"audience": "adults", "pair_id": "ru-en"}, headers=env.memory())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["skill_id"] == "en.func.greet" and body["title"]["ru"]
    items = body["items"]
    # сначала задания навыка, затем остальные задания урока навыка; с ключами
    assert [(i["lesson_id"], i["version"], i["item"]["item_id"]) for i in items] == [
        ("l-01-greetings", 1, "ci-01"), ("l-01-greetings", 1, "ci-03"), ("l-01-greetings", 1, "ci-02")]
    assert all("answer" in i["item"] for i in items)
    # порядок стабильный, не больше 20
    for n in range(2, 9):
        p = lesson(f"l-greet-{n}")
        await env.published_new("lesson", p)
    again = (await env.c.get(url, params={"audience": "adults"}, headers=env.memory())).json()["items"]
    assert len(again) == 20 and again[:2] == items[:2]
    assert again == (await env.c.get(url, params={"audience": "adults"}, headers=env.memory())).json()["items"]


async def test_check_items_audience_pair_and_errors(env) -> None:
    await env.published_new("lesson", lesson("l-greet-adults", audience=["adults"]))
    url = "/internal/v1/skills/en.func.greet/check-items"
    kids = (await env.c.get(url, params={"audience": "kids"}, headers=env.memory())).json()["items"]
    assert {i["lesson_id"] for i in kids} == {"l-01-greetings"}
    adults = (await env.c.get(url, params={"audience": "adults"}, headers=env.memory())).json()["items"]
    assert {i["lesson_id"] for i in adults} == {"l-01-greetings", "l-greet-adults"}
    other = (await env.c.get(url, params={"audience": "adults", "pair_id": "ru-uz"}, headers=env.memory())).json()
    assert other["items"] == []
    # детский профиль в claims — только kids
    child = uuid.uuid4()
    forced = (await env.c.get(url, params={"audience": "adults"},
                              headers=env.memory(child, lrn=str(child), age_band="10-13"))).json()["items"]
    assert {i["lesson_id"] for i in forced} == {"l-01-greetings"}
    # навык без уроков — пусто; неопубликованный / несуществующий — 404
    r = await env.c.get("/internal/v1/skills/en.gram.to-be/check-items", params={"audience": "adults"},
                        headers=env.memory())
    assert r.status_code == 200 and r.json()["items"] == []
    for skill_id in ("en.nope", "BAD KEY"):
        r = await env.c.get(f"/internal/v1/skills/{skill_id}/check-items", params={"audience": "adults"},
                            headers=env.memory())
        assert r.status_code == 404 and r.json()["code"] == "SKILL_NOT_FOUND"
    assert (await env.c.get(url, headers=env.memory())).status_code == 422
    assert (await env.c.get(url, params={"audience": "adults"})).status_code == 401
    for caller in ("lessons", "telegram-bff", "assessment", "diagnostics"):
        r = await env.c.get(url, params={"audience": "adults"}, headers=env.svc(caller))
        assert r.status_code == 403, caller
    assert CONTENT_MANAGER.id


# ---------------------------------------------------------------- дети — только детский контент (CONVENTIONS §8)


async def test_kids_only_kids_content_in_lookup_and_ai_entries(env) -> None:
    await env.published_new("lesson", lesson("l-adults-only", audience=["adults"]))
    adult_text, kids_text = ref(), ref("reading", "r-a0-my-cat")

    async def look(text: str, content: dict[str, Any], audience: str | None = None, headers=None):
        body: dict[str, Any] = {"pair_id": "ru-en", "text": text, "content_ref": content}
        if audience is not None:
            body["audience"] = audience
        return await env.c.post(LOOKUP, json=body, headers=headers or env.memory())

    # ребёнок + взрослый текст / урок → 404, как будто контента нет
    for text, content in (("coffee shop", adult_text), ("hello", ref("lesson", "l-adults-only"))):
        r = await look(text, content, "kids")
        assert r.status_code == 404 and r.json()["code"] == "CONTENT_NOT_FOUND", content
    # ребёнок + детский текст, урок и медиа для всех аудиторий → ok
    for text, content in (("cat", kids_text), ("hello", ref("lesson", "l-01-greetings")),
                          ("hot chocolate", ref("media_asset", "m-own-coffee-order")),
                          ("What can I get you", ref("scenario", "sc-cafe-coffee"))):
        r = await look(text, content, "kids")
        assert r.status_code == 200, (content, r.text)
    # взрослый и без audience (обратная совместимость) — как раньше
    assert (await look("coffee shop", adult_text, "adults")).status_code == 200
    assert (await look("coffee shop", adult_text)).status_code == 200
    assert (await look("hello", ref("lesson", "l-adults-only"), "teens")).status_code == 200
    # детский профиль по claims — kids принудительно, что бы ни пришло
    child = uuid.uuid4()
    r = await look("coffee shop", adult_text, "adults", env.memory(child, lrn=str(child), age_band="6-9"))
    assert r.status_code == 404 and r.json()["code"] == "CONTENT_NOT_FOUND"
    assert (await look("bad", adult_text, "elders")).status_code == 422
    # перевод ИИ: ребёнок + взрослый текст → 404, ребёнок + детский → 201
    r = await env.c.post(AI, json={**ai_body("office"), "audience": "kids"}, headers=env.memory())
    assert r.status_code == 404 and r.json()["code"] == "CONTENT_NOT_FOUND"
    assert (await env.c.get(FORMS, params={"pair_id": "ru-en", "forms": "office"}, headers=env.memory())
            ).json()["items"][0]["entry"] is None
    r = await env.c.post(AI, json={**ai_body("bed", content=ref("reading", "r-a0-my-cat", locator="s4")),
                                   "audience": "kids"}, headers=env.memory())
    assert r.status_code == 201, r.text
    assert (await env.c.post(AI, json={**ai_body("office"), "audience": "adults"}, headers=env.memory())
            ).status_code == 201


async def test_kids_only_kids_versions_for_memory(env) -> None:
    await env.published_new("lesson", lesson("l-adults-only", audience=["adults"]))
    child = uuid.uuid4()
    child_claims = env.memory(child, lrn=str(child), age_band="10-13")
    for path in ("/internal/v1/versions/reading/r-a1-coffee-shop/1", "/internal/v1/versions/reading/r-a1-coffee-shop",
                 "/internal/v1/versions/lesson/l-adults-only/1", "/internal/v1/versions/lesson/l-adults-only"):
        r = await env.c.get(path, params={"audience": "kids"}, headers=env.memory())
        assert r.status_code == 404 and r.json()["code"] == "VERSION_NOT_FOUND", path
        r = await env.c.get(path, headers=child_claims)  # детский профиль в claims — и без параметра
        assert r.status_code == 404, path
        assert (await env.c.get(path, headers=env.memory())).status_code == 200, path  # без audience — как раньше
        assert (await env.c.get(path, params={"audience": "adults"}, headers=env.memory())).status_code == 200
    for path in ("/internal/v1/versions/reading/r-a0-my-cat/1", "/internal/v1/versions/lesson/l-01-greetings/1",
                 "/internal/v1/versions/media_asset/m-own-coffee-order",
                 "/internal/v1/versions/scenario/sc-cafe-coffee/1"):
        r = await env.c.get(path, params={"audience": "kids"}, headers=env.memory())
        assert r.status_code == 200, path
    # lessons и assessment — без изменений (claims не ограничивают; виды без аудитории — без фильтра)
    lessons_child = env.svc("lessons", str(child), lrn=str(child), age_band="6-9")
    assert (await env.c.get("/internal/v1/versions/lesson/l-adults-only/1", headers=lessons_child)).status_code == 200
    r = await env.c.get("/internal/v1/versions/rubric/r-lesson-core/1", params={"audience": "kids"},
                        headers=env.svc("assessment"))
    assert r.status_code == 200
    assert (await env.c.get("/internal/v1/versions/reading/r-a0-my-cat/1", params={"audience": "elders"},
                            headers=env.memory())).status_code == 422
