"""Тестовый набор lessons: заглушки доменов (httpx.MockTransport) на РЕАЛЬНОМ сиде catalog
(`services/catalog/migrations/seed/*.json`) и ответы «ученика» по ключам из сида.

- FakeCatalog: пары, снимок курса (ETag), версии с ключами `/internal/v1/versions/{kind}/{key}[/{version}]`,
  упражнения к медиа без ключей; снятие с публикации, удаление версии, «недоступен»;
- FakeAI: conversation_partner (намерение по совпадению слов с examples_en, как fake-провайдер ai-gateway; режимы
  ok | unclear | off_topic | unavailable | refused | error | garbage), teaching_coach (шаблон);
- FakeAssessment: независимая оценка по ключам сида (не по данным lessons), идемпотентно по session_id;
  режимы ok | down | timeout | garbage;
- FakePlan (траектория: следующий урок), FakeDiagnostics (карта навыков).
"""

from __future__ import annotations

import asyncio
import copy
import json
import re
import uuid
from pathlib import Path
from typing import Any

import httpx
import jwt

SEED = Path(__file__).resolve().parents[2] / "catalog" / "migrations" / "seed"
BAND_ORDER = ["A0", "A1", "A2", "B1", "B2"]
KIND_FILES = {"course": "course.json", "module": "modules.json", "skill": "skills.json", "lesson": "lessons.json",
              "scenario": "scenarios.json", "rubric": "rubrics.json", "media_asset": "media.json",
              "media_exercise": "media_exercises.json"}
KEY_FIELD = {"course": "course_id", "module": "module_id", "skill": "skill_id", "lesson": "lesson_id",
             "scenario": "scenario_id", "rubric": "rubric_id", "media_asset": "asset_id",
             "media_exercise": "exercise_id"}


def load_seed() -> dict[str, dict[str, dict[str, Any]]]:
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for kind, name in KIND_FILES.items():
        data = json.loads((SEED / name).read_text(encoding="utf-8"))
        items = data if isinstance(data, list) else [data]
        out[kind] = {str(x[KEY_FIELD[kind]]): x for x in items}
    return out


SEED_DATA = load_seed()


def load_seed_readings() -> dict[str, dict[str, Any]]:
    """Сид текстов catalog спринта 5 (исполнитель B), если уже есть — сквозная проверка совместимости форм."""
    path = SEED / "readings.json"
    if not path.exists():
        return {}
    return {str(x["reading_id"]): x for x in json.loads(path.read_text(encoding="utf-8"))}


SEED_READINGS = load_seed_readings()


def _loc(ru: str, uz: str) -> dict[str, str]:
    return {"ru": ru, "uz": uz}


def _sentences(*rows: tuple[str, str, str]) -> list[dict[str, Any]]:
    return [{"s_id": sid, "text_en": en, "gloss": _loc(ru, ru)} for sid, en, ru in rows]


# Тексты для чтения (ReadingPayload, content.ts) — сид catalog спринта 5 делает исполнитель B; здесь — свои по
# INTERNAL_API §2.1 спринта 5 (взрослый/подростковый и детский).
READINGS: dict[str, dict[str, Any]] = {
    "r-a1-coffee-shop": {
        "reading_id": "r-a1-coffee-shop", "title": _loc("В кофейне", "Qahvaxonada"), "level": "A1",
        "audience": ["teens", "adults"], "topics": ["food"], "skill_ids": ["read-a1-short-texts"],
        "paragraphs": [
            {"p_id": "p1", "sentences": _sentences(
                ("s1", "Anna works near a small coffee shop.", "Анна работает рядом с маленькой кофейней."),
                ("s2", "Every morning she orders a latte and a croissant.",
                 "Каждое утро она заказывает латте и круассан."))},
            {"p_id": "p2", "sentences": _sentences(
                ("s3", "The barista knows her name and smiles.", "Бариста знает её имя и улыбается."),
                ("s4", "On Fridays Anna pays for her friend too.", "По пятницам Анна платит и за подругу."))},
        ],
        "glossary": [
            {"en": "orders", "gloss": _loc("заказывает", "buyurtma qiladi"), "note": None},
            {"en": "barista", "gloss": _loc("бариста", "barista"), "note": None},
            {"en": "pays for", "gloss": _loc("платит за", "toʻlaydi"), "note": _loc("глагол с предлогом",
                                                                                     "predlogli fe'l")},
        ],
        "questions": [
            {"question_id": "rq-coffee-1", "type": "single_choice", "instruction": _loc("Выберите ответ",
                                                                                          "Javobni tanlang"),
             "prompt_en": "What does Anna order every morning?",
             "options": ["Tea and a cake", "A latte and a croissant", "Orange juice"], "answer": 1},
            {"question_id": "rq-coffee-2", "type": "true_false", "instruction": _loc("Верно или нет?",
                                                                                       "Toʻgʻrimi yoki yoʻqmi?"),
             "prompt_en": "The barista does not know Anna.", "options": ["True", "False"], "answer": 1},
            {"question_id": "rq-coffee-3", "type": "gap_fill", "instruction": _loc("Вставьте слово",
                                                                                     "Soʻzni qoʻying"),
             "prompt_en": "On Fridays Anna ___ for her friend too.", "options": [], "answer": ["pays"]},
        ],
        "voice": "en-GB", "est_minutes": 5,
    },
    "r-a0-my-cat": {
        "reading_id": "r-a0-my-cat", "title": _loc("Мой кот", "Mening mushugim"), "level": "A0",
        "audience": ["kids"], "topics": ["home"], "skill_ids": ["read-a0-words"],
        "paragraphs": [{"p_id": "p1", "sentences": _sentences(
            ("s1", "I have a cat.", "У меня есть кот."), ("s2", "My cat is black.", "Мой кот чёрный."),
            ("s3", "He likes milk.", "Он любит молоко."))}],
        "glossary": [{"en": "cat", "gloss": _loc("кот", "mushuk"), "note": None},
                     {"en": "black", "gloss": _loc("чёрный", "qora"), "note": None},
                     {"en": "milk", "gloss": _loc("молоко", "sut"), "note": None}],
        "questions": [
            {"question_id": "rq-cat-1", "type": "true_false", "instruction": _loc("Верно?", "Toʻgʻrimi?"),
             "prompt_en": "The cat is white.", "options": ["True", "False"], "answer": 1},
            {"question_id": "rq-cat-2", "type": "single_choice", "instruction": _loc("Выбери", "Tanla"),
             "prompt_en": "What does the cat like?", "options": ["milk", "fish", "bread"], "answer": 0},
            {"question_id": "rq-cat-3", "type": "gap_fill", "instruction": _loc("Вставь слово", "Soʻzni qoʻy"),
             "prompt_en": "I have a ___.", "options": [], "answer": ["cat"]},
        ],
        "voice": "en-US", "est_minutes": 3,
    },
}


def error(status: int, code: str) -> httpx.Response:
    return httpx.Response(status, json={"code": code, "message": code, "trace_id": "t", "details": {}})


def slow(response: httpx.Response, seconds: float) -> Any:
    """Ответ домена с задержкой (MockTransport принимает корутину) — проверка сроков необязательных вызовов."""
    async def later() -> httpx.Response:
        await asyncio.sleep(seconds)
        return response
    return later()


class FakeCatalog:
    def __init__(self) -> None:
        self.data = copy.deepcopy(SEED_DATA)
        # (kind, key) → {version: payload}; опубликована версия 1
        self.versions: dict[tuple[str, str], dict[int, dict[str, Any]]] = {
            (kind, key): {1: payload} for kind, items in self.data.items() for key, payload in items.items()}
        for key, payload in {**SEED_READINGS, **READINGS}.items():
            self.versions[("reading", key)] = {1: copy.deepcopy(payload)}
        self.published: dict[tuple[str, str], int | None] = {k: 1 for k in self.versions}
        # тексты для чтения: catalog «забыл» проверить аудиторию — проверка в lessons (защита в глубину)
        self.reading_ignores_audience = False
        self.reading_without_version = False  # ответ /readings/{id} без номера версии
        self.down = False
        self.snapshot_versions = False
        self.calls: list[str] = []
        self.pairs = [
            {"pair_id": "ru-en", "source": "ru", "target": "en", "explanation_locales": ["ru"],
             "ui_locales": ["ru", "uz"], "title": {"ru": "Английский", "uz": "Ingliz tili"}, "status": "published",
             "release_at": None, "course_id": "en-core"},
            {"pair_id": "ru-uz", "source": "ru", "target": "uz", "explanation_locales": ["ru"],
             "ui_locales": ["ru", "uz"], "title": {"ru": "Узбекский", "uz": "Oʻzbek tili"},
             "status": "planned", "release_at": None, "course_id": None},
        ]

    # ---------- управление
    def publish(self, kind: str, key: str, payload: dict[str, Any]) -> int:
        versions = self.versions.setdefault((kind, key), {})
        v = max(versions, default=0) + 1
        versions[v] = payload
        self.published[(kind, key)] = v
        return v

    def unpublish(self, kind: str, key: str) -> None:
        self.published[(kind, key)] = None

    def drop_version(self, kind: str, key: str, version: int) -> None:
        self.versions[(kind, key)].pop(version, None)

    def payload(self, kind: str, key: str) -> dict[str, Any]:
        v = self.published[(kind, key)]
        assert v is not None
        return self.versions[(kind, key)][v]

    # ---------- снимок курса (как catalog.domain.learner.course_snapshot)
    def snapshot(self) -> dict[str, Any]:
        course = self.payload("course", "en-core")
        lessons_out, modules_out = [], []
        for mid in course["module_ids"]:
            if self.published.get(("module", mid)) is None:
                continue
            m = self.payload("module", mid)
            ids = [lid for lid in m["lesson_ids"] if self.published.get(("lesson", lid))]
            modules_out.append({"module_id": mid, "title": m["title"], "goal": m["goal"], "theme": m["theme"],
                                "lesson_ids": ids})
            for lid in ids:
                p = self.payload("lesson", lid)
                card = {"lesson_id": lid, "module_id": p["module_id"], "title": p["title"], "goal": p["goal"],
                        "level": p["level"], "kind": p["kind"], "duration_min": p["duration_min"],
                        "primary_skill_id": p["primary_skill_id"], "scenario_id": p["scenario_id"],
                        "stages": [{"type": s["type"], "minutes": s["minutes"]} for s in p["stages"]],
                        "audience": p["audience"], "goals": p["goals"], "topics": p["topics"],
                        "secondary_skill_ids": p["secondary_skill_ids"],
                        "prerequisite_skill_ids": p["prerequisite_skill_ids"],
                        "control_item_types": [c["type"] for c in p["control_items"]]}
                if self.snapshot_versions:
                    card["version"] = self.published[("lesson", lid)]
                lessons_out.append(card)
        skills = sorted((self.payload("skill", k) for (kind, k) in self.versions if kind == "skill"),
                        key=lambda s: (BAND_ORDER.index(s["level"]), s["skill_id"]))
        return {"course_id": "en-core", "pair_id": "ru-en", "snapshot_version": "fake",
                "title": course["title"], "level_start": "A0", "level_end": "B1", "modules": modules_out,
                "skills": [{"skill_id": s["skill_id"], "area": s["area"], "title": s["title"], "level": s["level"],
                            "prerequisites": s["prerequisites"], "diagnostic_tags": s["diagnostic_tags"]}
                           for s in skills],
                "lessons": lessons_out}

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append(path)
        assert request.headers.get("x-internal-token"), "internal JWT is required"
        if self.down:
            return error(503, "UNAVAILABLE")
        if path == "/internal/v1/pairs":
            return httpx.Response(200, json={"items": self.pairs})
        if path == "/internal/v1/courses/en-core/snapshot":
            return httpx.Response(200, json=self.snapshot(), headers={"etag": '"fake"'})
        m = re.fullmatch(r"/internal/v1/versions/([a-z_]+)/([^/]+)(?:/(\d+))?", path)
        if m:
            kind, key, version = m.group(1), m.group(2), m.group(3)
            versions = self.versions.get((kind, key)) or {}
            v = int(version) if version else self.published.get((kind, key))
            if v is None or v not in versions:
                return error(404, "VERSION_NOT_FOUND")
            status = "published" if self.published.get((kind, key)) == v else "archived"
            return httpx.Response(200, json={"kind": kind, "key": key, "version": v, "status": status,
                                             "payload": versions[v]})
        m = re.fullmatch(r"/internal/v1/readings/([^/]+)", path)
        if m:  # INTERNAL_API §2.1 спринта 5: опубликованная версия без ключей вопросов
            key = m.group(1)
            v = self.published.get(("reading", key))
            if v is None:
                return error(404, "READING_NOT_FOUND")
            p = self.versions[("reading", key)][v]
            if request.url.params.get("audience") not in p["audience"] and not self.reading_ignores_audience:
                return error(404, "READING_NOT_FOUND")
            view = {**{k: val for k, val in p.items() if k != "questions"},
                    "questions": [{k: val for k, val in q.items() if k != "answer"} for q in p["questions"]]}
            if not self.reading_without_version:
                view["version"] = v
            return httpx.Response(200, json=view)
        m = re.fullmatch(r"/internal/v1/media/([^/]+)/exercises", path)
        if m:
            asset = m.group(1)
            audience = request.url.params.get("audience")
            if self.published.get(("media_asset", asset)) is None:
                return error(404, "MEDIA_NOT_AVAILABLE")
            media = self.payload("media_asset", asset)
            if audience not in media["audience"]:
                return error(404, "MEDIA_NOT_AVAILABLE")
            items = []
            for (kind, key), v in self.published.items():
                if kind != "media_exercise" or v is None:
                    continue
                p = self.versions[(kind, key)][v]
                if p["asset_id"] == asset:
                    items.append({**{k: val for k, val in p.items() if k != "answer"}, "version": v})
            return httpx.Response(200, json={"items": items})
        return error(404, "NOT_FOUND")


# ---------------------------------------------------------------- ИИ


def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z']+", text.lower()))


class FakeAI:
    def __init__(self) -> None:
        self.mode: dict[str, str] = {"conversation_partner": "ok", "teaching_coach": "ok"}
        self.requests: list[dict[str, Any]] = []
        self.available: bool | None = True  # GET /internal/v1/status; None — ai-gateway отвечает 500
        self.status_delay = 0.0  # статус отвечает через N секунд
        self.hint_offered = False  # conversation_partner: персонаж подсказал в ответе

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers.get("x-internal-token")
        if request.url.path == "/internal/v1/status":
            if self.available is None:
                return error(500, "INTERNAL_ERROR")
            resp = httpx.Response(200, json={"ai_available": self.available})
            return slow(resp, self.status_delay) if self.status_delay else resp
        m = re.fullmatch(r"/internal/v1/agents/([a-z_]+)/invoke", request.url.path)
        assert m, request.url.path
        agent = m.group(1)
        body = json.loads(request.content)
        self.requests.append({"agent": agent, **body})
        mode = self.mode.get(agent, "ok")
        base = {"agent_id": agent, "agent_version": 1, "prompt_version": f"{agent}@1",
                "schema_version": f"{agent}.v1", "model_id": "fake", "canary": False, "cost_usd": 0,
                "latency_ms": 1, "warnings": []}
        if mode == "error":
            return error(500, "INTERNAL_ERROR")
        if mode == "busy":  # тот же request_id ещё в работе у шлюза (дубль не дождался первого вызова)
            return error(409, "IDEMPOTENCY_IN_PROGRESS")
        if mode == "garbage":
            return httpx.Response(200, json={"hello": "world"})
        if mode == "unavailable":
            return httpx.Response(200, json={**base, "status": "unavailable", "reason": "budget_exceeded",
                                             "output": None})
        if mode == "refused" or (agent == "conversation_partner" and body["audience"] == "kids"):
            return httpx.Response(200, json={**base, "status": "refused", "reason": "kids_not_allowed",
                                             "output": None})
        if agent == "teaching_coach":
            return httpx.Response(200, json={**base, "status": "ok", "reason": None, "output": {
                "explanation": "Проще говоря: поздоровайтесь и назовите имя.", "example_en": "Hi! I'm Tom.",
                "example_gloss": "Привет! Я Том."}})
        ctx = body["context"]
        intent = "unclear"
        if mode == "off_topic":
            intent = "off_topic"
        elif mode == "ok":
            said = _words(ctx["learner_turn"])
            best = 0
            for t in ctx["node"]["transitions"]:
                score = max((len(said & _words(e)) for e in t["examples_en"]), default=0)
                if score > best:
                    best, intent = score, t["intent"]
        reply = "Nice! Let's go on." if intent not in ("unclear", "off_topic") else "Sorry, can you say it again?"
        return httpx.Response(200, json={**base, "status": "ok", "reason": None,
                                         "output": {"intent": intent, "reply_en": reply,
                                                    "hint_offered": self.hint_offered}})


# ---------------------------------------------------------------- оценка


def _norm(v: str) -> str:
    return " ".join(re.sub(r"[\s.,!?;:]+$", "", v.strip()).casefold().split())


class FakeAssessment:
    """Независимая оценка: ключи — из сида catalog по версиям (а не из данных lessons)."""

    def __init__(self, catalog: FakeCatalog) -> None:
        self.catalog = catalog
        self.mode = "ok"
        self.requests: list[dict[str, Any]] = []
        self.subjects: list[str] = []
        self.ids: dict[str, str] = {}
        self.human_review = False
        # переоценка: session_id → поля актуальной записи цепочки (повторный POST возвращает её)
        self.reevaluated: dict[str, dict[str, Any]] = {}
        self.delay = 0.0  # ответ через N секунд

    def _key_item(self, refs: dict[str, Any], item_id: str) -> tuple[str, dict[str, Any]] | None:
        reading = refs.get("reading")
        if reading:
            p = self.catalog.versions[("reading", reading["key"])][reading["version"]]
            for q in p["questions"]:
                if q["question_id"] == item_id:
                    return "reading", {**q, "skill_id": (p["skill_ids"] or [""])[0]}
        lesson = refs.get("lesson")
        if lesson:
            p = self.catalog.versions[("lesson", lesson["key"])][lesson["version"]]
            for c in p["control_items"]:
                if c["item_id"] == item_id:
                    return "lesson", c
        for r in refs.get("media_exercises") or []:
            if r["key"] == item_id:
                return "exercise", self.catalog.versions[("media_exercise", r["key"])][r["version"]]
        return None

    def grade(self, kind: str, item: dict[str, Any], answer: Any) -> bool:
        key = item["answer"]
        if answer is None:
            return False
        t = item["type"]
        if t in ("single_choice", "translate_choice", "comprehension", "phrase_meaning", "true_false"):
            return answer == key
        if t == "gap_fill":
            return isinstance(answer, str) and _norm(answer) in {_norm(k) for k in key}
        if t == "order_words":
            return answer == key
        if t == "order_lines":
            return answer == [item["options"][i] for i in key]
        return False

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers.get("x-internal-token")
        assert request.url.path == "/internal/v1/evaluations"
        body = json.loads(request.content)
        self.requests.append(body)
        self.subjects.append(str(jwt.decode(request.headers["x-internal-token"],
                                            options={"verify_signature": False}).get("sub")))
        if self.mode == "down":
            return error(503, "UNAVAILABLE")
        if self.mode == "timeout":
            raise httpx.ReadTimeout("timeout", request=request)
        if self.mode == "garbage":
            return httpx.Response(200, json={"status": "maybe"})
        refs = body["content_refs"]
        items, by_skill = [], {}
        for a in body["answers"]:
            found = self._key_item(refs, a["item_id"])
            assert found is not None, a["item_id"]
            kind, item = found
            correct = self.grade(kind, item, a["answer"])
            items.append({"item_id": a["item_id"], "prompt_en": item.get("prompt_en") or "",
                          "your_answer": None if a["answer"] is None else str(a["answer"]),
                          "correct": correct, "hinted": a["hinted"],
                          "correct_answer": None if correct else str(item["answer"])})
            by_skill.setdefault(item["skill_id"], []).append(correct and not a["hinted"])
        share = sum(i["correct"] for i in items) / len(items) if items else None
        outcome = (body.get("roleplay") or {}).get("outcome")
        passed = None if share is None and outcome is None else (
            (share is None or share >= 0.6) and outcome != "fail")
        eid = self.ids.setdefault(body["session_id"], str(uuid.uuid4()))
        view = {
            "evaluation_id": eid, "status": "ok", "passed": passed,
            "task_completed": None if outcome is None else outcome in ("success", "alt_success"),
            "scores": [{"code": "task", "title": {"ru": "Задача", "uz": "Vazifa"},
                        "score": {"success": 3, "alt_success": 2, "fail": 1}.get(outcome or "", None)}],
            "key_errors": [], "items": items, "practice_only": body["practice_only"],
            "rubric_version": ("reading-comprehension@1" if refs.get("reading") else
                               f"{(refs.get('rubric') or {}).get('key')}@{(refs.get('rubric') or {}).get('version')}"),
            "evaluator": None, "superseded_by": None, "appeal": None, "created_at": "2026-11-19T07:30:00Z",
        }
        if refs.get("reading"):
            share_score = None if share is None else (3 if share >= 0.8 else 2 if share >= 0.6 else
                                                      1 if share >= 0.3 else 0)
            view["scores"] = [{"code": "comprehension", "title": {"ru": "Понимание", "uz": "Tushunish"},
                               "score": share_score}]
            view["task_completed"] = None
        outcomes = [] if body["practice_only"] else [
            {"skill_id": sk, "outcome": "demonstrated" if sum(v) >= max(1, (2 * len(v) + 2) // 3) and passed
             else "learning"} for sk, v in by_skill.items()]
        view.update(self.reevaluated.get(body["session_id"], {}))
        resp = httpx.Response(200, json={**view, "session_id": body["session_id"], "skill_outcomes": outcomes,
                                         "requires_human_review": self.human_review})
        return slow(resp, self.delay) if self.delay else resp


class FakePlan:
    def __init__(self, catalog: FakeCatalog) -> None:
        self.catalog = catalog
        self.next_lesson: str | None = "l-02-where-from"
        self.down = False
        self.delay = 0.0

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/internal/v1/plan/trajectory"
        if self.down or self.next_lesson is None:
            return error(503, "UNAVAILABLE")
        if self.delay:
            delay, self.delay = self.delay, 0.0
            return slow(self.handler(request), delay)
        p = self.catalog.payload("lesson", self.next_lesson)
        card = {"lesson_id": p["lesson_id"], "module_id": p["module_id"], "title": p["title"], "goal": p["goal"],
                "level": p["level"], "kind": p["kind"], "duration_min": p["duration_min"],
                "primary_skill_id": p["primary_skill_id"], "scenario_id": p["scenario_id"],
                "stages": [{"type": s["type"], "minutes": s["minutes"]} for s in p["stages"]],
                "reason_codes": ["next_in_course"], "explanation": {"ru": "Дальше", "uz": "Keyin"}}
        return httpx.Response(200, json={"pair_id": "ru-en", "course_id": "en-core", "revision": 2, "next": card,
                                         "mandatory": [], "optional": [], "completed": [], "lessons_available": True})


class FakeDiagnostics:
    def __init__(self) -> None:
        self.states: dict[str, str] = {}
        self.down = False
        self.delay = 0.0

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/internal/v1/skills/map"
        if self.down:
            return error(503, "UNAVAILABLE")
        if self.delay:
            delay, self.delay = self.delay, 0.0
            return slow(self.handler(request), delay)
        return httpx.Response(200, json={"pair_id": "ru-en", "course_id": "en-core", "counts": {}, "skills": [
            {"skill_id": k, "state": v} for k, v in self.states.items()]})


# ---------------------------------------------------------------- ответы «ученика»


def find_item(item: dict[str, Any], locale: str = "ru") -> tuple[str, dict[str, Any]]:
    """Задание из сида по StepItem: control item урока | упражнение к медиа | проверка понимания."""
    iid = item["item_id"]
    if item["item_type"] == "meaning_check":
        for lesson in SEED_DATA["lesson"].values():
            for kw in lesson["key_words"]:
                if kw["en"] == item["prompt_en"]:
                    return "meaning", {"options": item["options"], "answer": item["options"].index(
                        kw["gloss"][locale]), "type": "meaning_check"}
    if iid in SEED_DATA["media_exercise"]:
        return "exercise", SEED_DATA["media_exercise"][iid]
    for reading in READINGS.values():
        for q in reading["questions"]:
            if q["question_id"] == iid:
                return "reading", q
    for lesson in SEED_DATA["lesson"].values():
        for c in lesson["control_items"]:
            if c["item_id"] == iid:
                return "lesson", c
    raise AssertionError(f"unknown item {iid}")


def correct_answer(item: dict[str, Any]) -> Any:
    _, full = find_item(item)
    t, key = full["type"], full["answer"]
    if t == "gap_fill":
        return key[0]
    if t == "order_lines":
        return [full["options"][i] for i in key]
    return key


def wrong_answer(item: dict[str, Any]) -> Any:
    _, full = find_item(item)
    t, key = full["type"], full["answer"]
    if t == "gap_fill":
        return "zzz"
    if t == "true_false":
        return 1 - key
    if t in ("order_words", "order_lines"):
        right = correct_answer(item)
        wrong = list(reversed(right))
        return wrong if wrong != right else right[1:] + right[:1]
    return (key + 1) % len(item["options"])


def assert_no_keys(obj: Any, path: str = "$") -> None:
    """В ответах ученику нет ключей ответов, служебных ссылок и полного графа сценария."""
    forbidden = {"answer", "ref", "turn_mark", "intent", "transitions", "nodes", "examples_en", "control_items",
                 "seed", "plan", "state", "content_versions", "account_id", "user_id"}
    if isinstance(obj, dict):
        for k, v in obj.items():
            assert k not in forbidden, f"{path}.{k} leaked"
            assert_no_keys(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            assert_no_keys(v, f"{path}[{i}]")
