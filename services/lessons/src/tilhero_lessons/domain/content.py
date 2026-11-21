"""Контент сессии: версии, зафиксированные при старте (content_versions), и работа с заданиями и графом сценария.

content_versions: {"lesson"|"scenario"|"rubric"|"media_asset"|"reading": {"key", "version"}, "media_exercises":
[{"key", "version"}], "retrieval": [{"key", "version"}]} — уроки, из которых взяты задания повторения.
Ключи ответов (control_items[].answer, упражнения) используются только здесь — для проверки повторения и проверки
понимания; в ответах ученику их нет (render_* строят StepItem без answer).
"""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from tilhero_lessons.catalog import CatalogGateway
from tilhero_lessons.domain.common import Localized, answer_invalid, loc, seeded_order

CHOICE_TYPES = frozenset({"single_choice", "translate_choice", "comprehension", "phrase_meaning", "meaning_check"})
GAP_TYPES = frozenset({"gap_fill", "gap_fill_media"})
ORDER_TYPES = frozenset({"order_words", "order_lines"})
MEDIA_ITEM_TYPES = {"comprehension": "comprehension", "gap_fill": "gap_fill_media", "order_lines": "order_lines",
                    "phrase_meaning": "phrase_meaning"}  # shadowing и roleplay — до голоса (пропускаются)
MAX_GAP_ANSWER = 100
_TRAILING = re.compile(r"[\s.,!?;:…»\"')]+$")
_LEADING = re.compile(r"^[\s«\"'(]+")


@dataclass
class Bundle:
    lesson: dict[str, Any] | None = None
    scenario: dict[str, Any] | None = None
    rubric: dict[str, Any] | None = None
    media: dict[str, Any] | None = None
    reading: dict[str, Any] | None = None
    exercises: dict[str, dict[str, Any]] = field(default_factory=dict)
    retrieval: dict[tuple[str, int], dict[str, Any]] = field(default_factory=dict)
    # спринт 7: задания дуэли — снимки набора с ключами (duel_sets.items) и seed набора (перемешивание одинаково у
    # обоих участников)
    duel: list[dict[str, Any]] = field(default_factory=list)
    duel_seed: str = ""


def ref(key: str, version: int) -> dict[str, Any]:
    return {"key": key, "version": version}


async def load_bundle(catalog: CatalogGateway, cv: dict[str, Any]) -> Bundle:
    """Версии сессии из catalog (кеш бессрочный). 404 любой версии → ContentGone (сессия → failed)."""
    b = Bundle()
    for kind, attr in (("lesson", "lesson"), ("scenario", "scenario"), ("rubric", "rubric"),
                       ("media_asset", "media"), ("reading", "reading")):
        r = cv.get(kind)
        if isinstance(r, dict):
            setattr(b, attr, await catalog.version(kind, r["key"], int(r["version"])))
    for r in cv.get("media_exercises") or []:
        b.exercises[r["key"]] = await catalog.version("media_exercise", r["key"], int(r["version"]))
    for r in cv.get("retrieval") or []:
        b.retrieval[(r["key"], int(r["version"]))] = await catalog.version("lesson", r["key"], int(r["version"]))
    return b


# ---------------------------------------------------------------- задания


def find_control_item(lesson: dict[str, Any], item_id: str) -> dict[str, Any] | None:
    return next((c for c in lesson.get("control_items") or [] if c.get("item_id") == item_id), None)


def item_view(item_id: str, item_type: str, instruction: Localized, prompt_en: str | None,
              options: list[str]) -> dict[str, Any]:
    """StepItem (bff.ts): без ключа ответа."""
    return {"item_id": item_id, "item_type": item_type, "instruction": instruction, "prompt_en": prompt_en or "",
            "options": list(options)}


def order_key(item_type: str, options: list[str], answer: Any) -> list[str] | None:
    """Верный порядок задания «по порядку» строками: order_words — answer (слова); order_lines — options по индексам
    answer. Ключ не по формату — None."""
    if item_type == "order_words" and isinstance(answer, list) and all(isinstance(a, str) for a in answer):
        return list(answer)
    if item_type == "order_lines" and isinstance(answer, list) and all(
            isinstance(a, int) and not isinstance(a, bool) and 0 <= a < len(options) for a in answer):
        return [str(options[a]) for a in answer]
    return None


def shown_options(seed: str, item_id: str, item_type: str, options: list[str], answer: Any) -> list[str]:
    """Варианты для показа. Слова order_words и реплики order_lines перемешиваются по seed сессии (R1-13):
    воспроизводимо для сессии, у разных сессий — по-разному; совпал перемешанный порядок с ответом — сдвиг на один.
    У order_words без вариантов (опубликовано до запрета в catalog) — слова ответа. Остальные типы — как в контенте
    (ответ — индекс варианта)."""
    if item_type not in ORDER_TYPES:
        return list(options)
    key = order_key(item_type, options, answer)
    pool = [str(o) for o in options] or (list(key) if item_type == "order_words" and key else [])
    ordered = [w for _, w in seeded_order(seed, f"order:{item_id}", list(enumerate(pool)), key=lambda p: str(p[0]))]
    if key is not None and len(ordered) > 1 and ordered == key:
        ordered = ordered[1:] + ordered[:1]
    return ordered


def control_item_view(item: dict[str, Any], seed: str) -> dict[str, Any]:
    options = shown_options(seed, item["item_id"], item["type"], item.get("options") or [], item.get("answer"))
    return item_view(item["item_id"], item["type"], item["instruction"], item.get("prompt_en"), options)


def exercise_view(ex: dict[str, Any], seed: str) -> dict[str, Any]:
    item_type = MEDIA_ITEM_TYPES[ex["type"]]
    options = shown_options(seed, ex["exercise_id"], item_type, ex.get("options") or [], ex.get("answer"))
    return item_view(ex["exercise_id"], item_type, ex["instruction"], ex.get("prompt_en"), options)


def normalize_gap(value: str) -> str:
    """gap_fill: без регистра, лишних пробелов и концевой пунктуации (как в assessment)."""
    v = _LEADING.sub("", _TRAILING.sub("", value.strip()))
    return " ".join(v.casefold().split())


def validate_answer(item_type: str, options: list[str], answer: Any, dont_know: bool) -> Any:
    """Ответ на задание по типу (422 ANSWER_INVALID): индекс варианта | строка пропуска | слова/реплики по порядку
    (перестановка показанных вариантов) | None («не знаю»)."""
    if dont_know:
        if answer not in (None, "", []):
            raise answer_invalid("answer", "При «не знаю» ответ не передаётся")
        return None
    if item_type in CHOICE_TYPES:
        if not isinstance(answer, int) or isinstance(answer, bool) or not 0 <= answer < len(options):
            raise answer_invalid("answer", "Выберите один из вариантов")
        return answer
    if item_type in GAP_TYPES:
        if not isinstance(answer, str) or not answer.strip() or len(answer) > MAX_GAP_ANSWER:
            raise answer_invalid("answer", "Впишите слово (до 100 символов)")
        return answer.strip()
    if item_type in ORDER_TYPES:
        if not isinstance(answer, list) or not all(isinstance(a, str) for a in answer) \
                or sorted(answer) != sorted(options):
            raise answer_invalid("answer", "Расставьте все показанные варианты по порядку")
        return list(answer)
    raise answer_invalid("answer")


def grade_control_item(item: dict[str, Any], answer: Any) -> bool:
    """Проверка по ключу опубликованной версии (только повторение — проверку без подсказок оценивает assessment)."""
    key = item.get("answer")
    if answer is None:
        return False
    if item["type"] in ("single_choice", "translate_choice"):
        return isinstance(key, int) and answer == key
    if item["type"] == "gap_fill":
        keys = key if isinstance(key, list) else [key]
        return isinstance(answer, str) and normalize_gap(answer) in {normalize_gap(str(k)) for k in keys}
    if item["type"] == "order_words":
        return isinstance(key, list) and list(answer) == [str(k) for k in key]
    return False


def correct_text(item: dict[str, Any]) -> str | None:
    """Верный ответ текстом — для обратной связи повторения после ответа ученика."""
    key = item.get("answer")
    options = item.get("options") or []
    if item["type"] in ("single_choice", "translate_choice") and isinstance(key, int) and 0 <= key < len(options):
        return str(options[key])
    if item["type"] == "gap_fill" and isinstance(key, list) and key:
        return str(key[0])
    if item["type"] == "order_words" and isinstance(key, list):
        return " ".join(str(k) for k in key)
    return None


def item_hint(item: dict[str, Any], n: int) -> Localized:
    """Подсказка к заданию повторения (отмечается): первая буква / первое слово / разбор вариантов."""
    key = item.get("answer")
    if item["type"] == "gap_fill" and isinstance(key, list) and key and str(key[0]):
        first = str(key[0])[0]
        return loc(f"Слово начинается на «{first}».", f"Soʻz «{first}» harfi bilan boshlanadi.")
    if item["type"] == "order_words" and isinstance(key, list) and key:
        first = str(key[0])
        return loc(f"Фраза начинается со слова «{first}».", f"Ibora «{first}» soʻzi bilan boshlanadi.")
    if n <= 1:
        return loc("Прочитайте все варианты и уберите явно неподходящие.",
                   "Barcha variantlarni oʻqing va aniq mos kelmaydiganlarini chiqarib tashlang.")
    return loc("Вспомните пример из прошлого урока — ответ похож на него.",
               "Oʻtgan darsdagi misolni eslang — javob unga oʻxshaydi.")


def answer_text(options: list[str], answer: Any) -> str | None:
    """Ответ ученика текстом (транскрипт для QA, «ваш ответ»)."""
    if answer is None:
        return None
    if isinstance(answer, bool):
        return str(answer)
    if isinstance(answer, int):
        return str(options[answer]) if 0 <= answer < len(options) else str(answer)
    if isinstance(answer, list):
        return " ".join(str(a) for a in answer)
    if isinstance(answer, dict):
        return str(answer["text"]) if isinstance(answer.get("text"), str) else None
    return str(answer)


# ---------------------------------------------------------------- текст для чтения (спринт 5)


# Вопрос текста → тип шага (StepItemType, bff.ts): в StepItemType нет `true_false` — это выбор из двух вариантов
# ["True", "False"] (ответ — индекс, как у single_choice); gap_fill — строка (сравнение в assessment).
READING_ITEM_TYPES = {"single_choice": "single_choice", "true_false": "single_choice", "gap_fill": "gap_fill"}


def find_question(reading: dict[str, Any], question_id: str) -> dict[str, Any] | None:
    return next((q for q in reading.get("questions") or [] if q.get("question_id") == question_id), None)


def question_view(question: dict[str, Any]) -> dict[str, Any]:
    """StepItem вопроса на понимание — без ключа (answer остаётся в catalog/assessment)."""
    item_type = READING_ITEM_TYPES[str(question["type"])]
    options = [] if item_type == "gap_fill" else [str(o) for o in question.get("options") or []]
    return item_view(str(question["question_id"]), item_type, question["instruction"], question.get("prompt_en"),
                     options)


def reading_view(reading: dict[str, Any], version: int) -> dict[str, Any]:
    """ReadingView (bff.ts): текст по предложениям с переводом, глоссарий (подсветка), число и типы вопросов — без
    вопросов и ответов. `in_dictionary` — null: есть ли слово в словаре ученика, знает memory (дополняет BFF)."""
    questions = reading.get("questions") or []
    types: list[str] = []
    for q in questions:
        if q.get("type") not in types:
            types.append(str(q.get("type")))
    return {
        "reading_id": reading["reading_id"], "version": version, "title": reading["title"],
        "level": reading["level"], "voice": reading.get("voice") or "en-GB",
        "paragraphs": [{"p_id": str(p["p_id"]),
                        "sentences": [{"s_id": str(x["s_id"]), "text_en": x["text_en"], "gloss": x["gloss"]}
                                      for x in p.get("sentences") or []]}
                       for p in reading.get("paragraphs") or []],
        "glossary": [{"en": g["en"], "gloss": g["gloss"], "note": g.get("note"), "in_dictionary": None}
                     for g in reading.get("glossary") or []],
        "questions_count": len(questions), "question_types": types,
        "est_minutes": int(reading.get("est_minutes") or 0),
    }


def reading_audience_ok(reading: dict[str, Any], audience: str) -> bool:
    """Аудитория текста подходит ученику; ребёнку — только детский текст (аудитория ровно [kids])."""
    segments = [str(a) for a in reading.get("audience") or []]
    if audience == "kids":
        return segments == ["kids"]
    return audience in segments


# ---------------------------------------------------------------- граф сценария


def scenario_node(scenario: dict[str, Any], node_id: str) -> dict[str, Any]:
    return dict(scenario["nodes"][node_id])


def character(scenario: dict[str, Any], speaker: str) -> dict[str, Any]:
    for c in scenario.get("characters") or []:
        if c.get("id") == speaker:
            return {"id": c["id"], "name": c["name"], "role": c["role"], "voice": c.get("voice", "en-GB")}
    return {"id": speaker, "name": speaker, "role": loc(speaker, speaker), "voice": "en-GB"}


def distance_to_end(scenario: dict[str, Any], start: str) -> int:
    """Число переходов до ближайшего конечного узла (оценка длины этапа для stage_total)."""
    nodes = scenario["nodes"]
    seen = {start}
    queue: deque[tuple[str, int]] = deque([(start, 0)])
    while queue:
        nid, d = queue.popleft()
        node = nodes.get(nid) or {}
        if node.get("end") is not None:
            return d
        for t in node.get("transitions") or []:
            if t.get("to") in nodes and t["to"] not in seen:
                seen.add(t["to"])
                queue.append((t["to"], d + 1))
    return 0


def voices(transcript: list[dict[str, Any]]) -> dict[str, str]:
    """Голоса синтеза речи по говорящим (как catalog): по очереди en-GB / en-US."""
    out: dict[str, str] = {}
    for line in transcript:
        speaker = str(line.get("speaker"))
        if speaker not in out:
            out[speaker] = "en-GB" if len(out) % 2 == 0 else "en-US"
    return out
