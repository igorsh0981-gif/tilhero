"""Задания «Повторения дня» (INTERNAL_API §1.3): тип по стадии карточки, содержимое (без ключа) и ключ, проверка
ответа и оценка — правила, не ИИ (скилл spaced_repetition_coach). Вариант детерминирован: seed = session_id + card_id.

| Ответ | Оценка |
|---|---|
| неверно, «Не помню» (раскрытие) или пропуск | again |
| верно выбором (meaning_choice, listen_choice) | hard — выбор не равен воспроизведению |
| верно вводом / сборкой с подсказкой «первая буква», или почти верно (опечатка) | hard |
| верно вводом / сборкой без подсказки | good |
`easy` не ставится никогда.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Final

from tilhero_memory.domain import explanations
from tilhero_memory.domain.common import digest, seeded_order, seeded_pick
from tilhero_memory.domain.normalize import (
    check_gap,
    check_order,
    compare,
    find_in_sentence,
    letters_of,
    normalize,
    ws,
)
from tilhero_memory.models import Card

CHOICE_TASKS: Final = frozenset({"meaning_choice", "listen_choice"})
TEXT_TASKS: Final = frozenset({"typed", "cloze", "error_fix"})
GRADED_CARD_TASKS: Final = frozenset({"meaning_choice", "listen_choice", "typed", "cloze", "assemble", "error_fix"})
ANSWER_MODE: Final = {"meaning_choice": "choice", "listen_choice": "listen", "typed": "typed", "cloze": "typed",
                      "error_fix": "typed", "assemble": "assemble", "intro": "manual"}
CHECK_CHOICE: Final = frozenset({"single_choice", "translate_choice"})
MAX_LETTER_TILES: Final = 12
RECOGNITION_STABILITY: Final = 3.0
GAP: Final = "___"


@dataclass
class Built:
    type: str
    payload: dict[str, Any]  # что показано ученику (без ключа)
    key: dict[str, Any]  # ключ — только у сервиса


def prompt(**fields: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"text_en": None, "gloss": None, "example_en": None, "example_gap": None,
                            "speech_text": None, "explanation": None, "evidence": None, "instruction": None,
                            "prompt_en": None}
    base.update(fields)
    return base


def _payload(p: dict[str, Any], *, answer_kind: str, hints: list[str], options: list[str] | None = None,
             tiles: list[str] | None = None, check: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"prompt": p, "options": options or [], "tiles": tiles or [], "answer_kind": answer_kind,
            "hints": hints, "check": check}


def card_task_type(card: Card, *, young: bool, seed: str) -> str:
    """Тип задания по стадии: new → intro; learning / review с S < 3 → узнавание; review с S ≥ 3 → воспроизведение
    (дети 6–9 — сборка); карточка ошибки → error_fix (цитата стёрта — typed по исправлению с объяснением)."""
    if card.kind == "error":
        if young:
            return "assemble"
        return "error_fix" if (card.error or {}).get("evidence") else "typed"
    if card.fsrs_state == "new":
        return "intro"
    if card.fsrs_state == "learning" or (card.stability or 0) < RECOGNITION_STABILITY:
        return "meaning_choice" if seeded_pick(seed + ":rec", 2) == 0 else "listen_choice"
    if young:
        if card.kind == "phrase" or 0 < len(letters_of(card.text_en)) <= MAX_LETTER_TILES:
            return "assemble"
        return "meaning_choice"
    if _cloze_fragment(card) is not None and seeded_pick(seed + ":prod", 2) == 1:
        return "cloze"
    return "typed"


def _answers(card: Card) -> list[str]:
    base = card.error["correction"] if card.error is not None else card.text_en
    return list(dict.fromkeys([base, *[a for a in card.answers_en if isinstance(a, str)]]))


def _display(card: Card) -> str:
    return str(card.error["correction"]) if card.error is not None else card.text_en


def _cloze_fragment(card: Card) -> str | None:
    if not card.example_en:
        return None
    return find_in_sentence(card.example_en, _answers(card))


def _gap(sentence: str, fragment: str) -> str:
    idx = sentence.lower().find(fragment.lower())
    if idx < 0:
        return sentence
    return sentence[:idx] + GAP + sentence[idx + len(fragment):]


def _gloss_text(gloss: Any, locale: str) -> str:
    return str(gloss.get(locale) or gloss.get("ru") or "") if isinstance(gloss, dict) else ""


def _options(card: Card, pool: list[dict[str, Any]], seed: str, *, english: bool, locale: str) -> tuple[list[str], int]:
    """4 варианта: верный + до 3 отвлекающих (варианты карточки — ключевые слова того же урока — и карточки ученика),
    без дублей; порядок — по seed."""
    right = card.text_en if english else _gloss_text(card.gloss, locale)
    seen = {normalize(right)}
    candidates: list[str] = []
    for d in [*card.distractors, *pool]:
        text = str(d.get("en") or "") if english else _gloss_text(d.get("gloss"), locale)
        n = normalize(text)
        if text and n and n not in seen:
            seen.add(n)
            candidates.append(text)
    picked = seeded_order(seed + ":distractors", candidates, key=lambda t: t)[:3]
    options = seeded_order(seed + ":options", [right, *picked], key=lambda t: t)
    return options, options.index(right)


def _shuffle_tiles(tiles: list[str], seed: str) -> list[str]:
    """Перемешанные плитки, не совпадающие с правильным порядком (если это возможно)."""
    indexed = list(enumerate(tiles))
    for attempt in range(8):
        order = seeded_order(f"{seed}:tiles:{attempt}", indexed, key=lambda it: f"{it[0]}")
        out = [t for _, t in order]
        if out != tiles or len(set(tiles)) <= 1:
            return out
    return list(reversed(tiles))


def _assemble_target(text: str, phrase: bool) -> list[str]:
    if phrase:
        return [t for t in ws(text).split(" ") if t]
    return letters_of(text)


def build_card_task(card: Card, task_type: str, *, seed: str, locale: str, pool: list[dict[str, Any]]) -> Built:
    gloss = dict(card.gloss)
    reveal_only = ["reveal"]
    full = ["first_letter", "reveal"]
    if task_type == "intro":
        return Built(task_type, _payload(prompt(text_en=card.text_en, gloss=gloss, example_en=card.example_en),
                                         answer_kind="none", hints=[]), {})
    if task_type in CHOICE_TASKS:
        english = task_type == "listen_choice"
        options, correct = _options(card, pool, seed, english=english, locale=locale)
        p = prompt(speech_text=card.text_en) if english else prompt(text_en=card.text_en)
        return Built(task_type, _payload(p, answer_kind="choice", hints=reveal_only, options=options),
                     {"correct": correct, "display": options[correct]})
    if task_type == "assemble":
        text = _display(card)
        phrase = card.kind != "word" or len(letters_of(text)) > MAX_LETTER_TILES or len(text.split()) > 1
        target = _assemble_target(text, phrase)
        tiles = _shuffle_tiles(target, seed)
        p = prompt(gloss=gloss if card.kind != "error" else None,
                   explanation=explanations.explanation(card.error_code) if card.kind == "error" else None)
        return Built(task_type, _payload(p, answer_kind="order", hints=full, tiles=tiles),
                     {"target": target, "display": text, "unit": "word" if phrase else "letter"})
    if task_type == "error_fix":
        err = card.error or {}
        p = prompt(explanation=explanations.explanation(card.error_code), evidence=err.get("evidence"))
        return Built(task_type, _payload(p, answer_kind="text", hints=full),
                     {"answers": _answers(card), "display": _display(card)})
    if task_type == "cloze":
        fragment = _cloze_fragment(card) or card.text_en
        example = card.example_en or ""
        p = prompt(example_gap=_gap(example, fragment), gloss=gloss)
        return Built(task_type, _payload(p, answer_kind="text", hints=full),
                     {"answers": list(dict.fromkeys([fragment, *_answers(card)])), "display": fragment})
    # typed
    gap_fragment = _cloze_fragment(card)
    if card.kind == "error":
        p = prompt(gloss=gloss, explanation=explanations.explanation(card.error_code))
    else:
        p = prompt(gloss=gloss, example_gap=_gap(card.example_en, gap_fragment)
                   if gap_fragment and card.example_en else None)
    return Built("typed", _payload(p, answer_kind="text", hints=full),
                 {"answers": _answers(card), "display": _display(card)})


def build_check_task(item: dict[str, Any], *, check_id: str, skill_title: dict[str, str] | None, position: int,
                     of: int, seed: str) -> Built:
    """Контрольное задание урока без подсказок; верный ответ — только в конце блока проверки."""
    typ = str(item["type"])
    options = [str(o) for o in item.get("options") or []]
    check = {"check_id": check_id, "skill_title": skill_title, "position": position, "of": of}
    p = prompt(instruction=item.get("instruction"), prompt_en=item.get("prompt_en"))
    key: dict[str, Any] = {"type": typ, "answer": item.get("answer"), "prompt_en": item.get("prompt_en"),
                           "options": options}
    if typ in CHECK_CHOICE:
        return Built("check_item", _payload(p, answer_kind="choice", hints=[], options=options, check=check), key)
    if typ == "order_words":
        target = [str(w) for w in item.get("answer") or []]
        shown = _shuffle_tiles(options or target, seed)
        key["options"] = shown
        return Built("check_item", _payload(p, answer_kind="order", hints=[], options=shown, check=check), key)
    return Built("check_item", _payload(p, answer_kind="text", hints=[], check=check), key)


def valid_check_item(item: Any) -> bool:
    if not isinstance(item, dict) or not isinstance(item.get("item_id"), str):
        return False
    typ, answer, options = item.get("type"), item.get("answer"), item.get("options") or []
    if typ in CHECK_CHOICE:
        return isinstance(answer, int) and not isinstance(answer, bool) and 0 <= answer < len(options)
    if typ in ("gap_fill", "order_words"):
        return isinstance(answer, list) and bool(answer) and all(isinstance(a, str) for a in answer)
    return False


# ---------------------------------------------------------------- проверка ответа и оценка


class AnswerInvalid(Exception):
    def __init__(self, field: str) -> None:
        super().__init__(field)
        self.field = field


@dataclass
class Checked:
    result: str  # correct | almost | incorrect
    shown_answer: str | None  # ответ ученика для итогов проверки (check_item)


def _given_kind(body: dict[str, Any]) -> str | None:
    present = [k for k in ("choice", "text", "order") if body.get(k) is not None]
    if len(present) > 1:
        raise AnswerInvalid(present[1])
    return present[0] if present else None


def check_answer(task_type: str, payload: dict[str, Any], key: dict[str, Any], body: dict[str, Any]) -> Checked:
    """Ответ без нужного поля — пропуск (incorrect → again). Чужое поле, индекс вне диапазона, не перестановка → 422."""
    if body.get("known") is not None:
        raise AnswerInvalid("known")
    kind = payload["answer_kind"]
    given = _given_kind(body)
    if given is None:
        return Checked("incorrect", None)
    expected = {"choice": "choice", "text": "text", "order": "order"}.get(kind)
    if given != expected:
        raise AnswerInvalid(given)
    if task_type == "check_item":
        return _check_item(key, body, given)
    if given == "choice":
        choice = body["choice"]
        if not 0 <= choice < len(payload["options"]):
            raise AnswerInvalid("choice")
        return Checked("correct" if choice == key["correct"] else "incorrect", payload["options"][choice])
    if given == "text":
        text = str(body["text"])
        return Checked(compare(text, key["answers"]) if text.strip() else "incorrect", text[:200])
    seq = _sequence(payload["tiles"], body["order"])
    return Checked("correct" if check_order(seq, key["target"]) else "incorrect", None)


def _sequence(tiles: list[str], order: Any) -> list[str]:
    if not isinstance(order, list) or len(order) != len(tiles) or len(set(order)) != len(order) \
            or not all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(tiles) for i in order):
        raise AnswerInvalid("order")
    return [tiles[i] for i in order]


def _check_item(key: dict[str, Any], body: dict[str, Any], given: str) -> Checked:
    typ = key["type"]
    options = [str(o) for o in key.get("options") or []]
    if typ in CHECK_CHOICE:
        choice = body["choice"]
        if not 0 <= choice < len(options):
            raise AnswerInvalid("choice")
        return Checked("correct" if choice == key["answer"] else "incorrect", options[choice][:200])
    if typ == "gap_fill":
        text = str(body["text"])
        return Checked("correct" if check_gap(text, key["answer"]) else "incorrect", text[:200])
    seq = _sequence(options, body["order"])
    return Checked("correct" if check_order(seq, key["answer"]) else "incorrect", " ".join(seq)[:200])


def correct_check_answer(key: dict[str, Any]) -> str:
    typ, answer, options = key["type"], key["answer"], key.get("options") or []
    if typ in CHECK_CHOICE:
        return str(options[answer])
    if typ == "gap_fill":
        return str(answer[0])
    return " ".join(str(w) for w in answer)


def grade_for(task_type: str, result: str, hints: list[str]) -> str:
    """Оценка строго по таблице (INTERNAL_API §1.3); easy не ставится никогда."""
    if "reveal" in hints or result == "incorrect":
        return "again"
    if task_type in CHOICE_TASKS:
        return "hard"
    if result == "almost" or "first_letter" in hints:
        return "hard"
    return "good"


def hint_text(kind: str, key: dict[str, Any]) -> str:
    display = str(key.get("display") or "")
    if kind == "reveal":
        return display
    if key.get("unit") == "word":
        first = display.split(" ")[0] if display else ""
        return f"{first}…"
    letters = [ch for ch in display if ch.isalpha()]
    return f"{letters[0] if letters else display[:1]}…"


def task_seed(session_id: str, target: str, n: int) -> str:
    return digest(session_id, target, n)


_GAP_RE = re.compile(re.escape(GAP))


def has_gap(text: str | None) -> bool:
    return bool(text) and bool(_GAP_RE.search(text or ""))
