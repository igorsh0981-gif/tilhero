"""Правила независимой оценки (INTERNAL_API §3.2) — чистые функции без БД и HTTP.

- Закрытые задания сравниваются только с ключом опубликованной версии catalog: single_choice / translate_choice /
  comprehension / phrase_meaning — индекс варианта; gap_fill — без регистра, лишних пробелов и концевой пунктуации
  (типографский апостроф = обычный); order_words / order_lines — точный порядок.
- Критерии рубрики без текста ученика: vocabulary, grammar, fluency, pronunciation — null; task — по исходу ролевой
  ситуации (success 3, alt_success 2, fail 1, не дошёл до конца или не ответил ни разу — 0); independence — по числу
  подсказок (0 → 3, 1 → 2, 2 → 1, 3+ → 0); comprehension — по доле верных закрытых заданий.
  Уточнение (нет ролевой ситуации — медиа, урок без сценария): task — по доле верных закрытых заданий; у медиа
  vocabulary — по доле верных gap_fill и phrase_meaning (иначе рубрика медиа не набирала бы 2 оценённых критерия).
- Правило зачёта — по оценённым критериям (null не входят; веса нормируются); оценённых < 2 → вердикта нет.
- Навык demonstrated — верно без подсказок ≥ 2/3 его заданий (и хотя бы одно) при зачтённой рубрике.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

CRITERIA = ("task", "vocabulary", "grammar", "independence", "pronunciation", "fluency", "comprehension")
CHOICE_TYPES = frozenset({"single_choice", "translate_choice", "comprehension", "phrase_meaning"})
LESSON_ITEM_TYPES = frozenset({"single_choice", "gap_fill", "order_words", "translate_choice"})
MEDIA_GRADABLE = frozenset({"comprehension", "gap_fill", "order_lines", "phrase_meaning"})
MEDIA_VOCABULARY = frozenset({"gap_fill", "phrase_meaning"})
SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2}
OUTCOME_SCORE = {"success": 3, "alt_success": 2, "fail": 1}
ERROR_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
MAX_ERRORS = 5
KEY_ERRORS = 3
EVIDENCE_MAX, CORRECTION_MAX, ANSWER_MAX = 120, 200, 300
_TRAILING = ".,!?;:…。"
_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "ʼ": "'", "`": "'"})


class ContentInvalid(ValueError):
    """Версия контента catalog не годится для оценки (нет ключа, неизвестный тип) — ошибка данных catalog."""


# ---------------------------------------------------------------- рубрика


@dataclass(frozen=True)
class Criterion:
    code: str
    weight: float
    title: dict[str, str]
    bands: list[dict[str, Any]]


@dataclass(frozen=True)
class Rubric:
    rubric_id: str
    version: int
    criteria: tuple[Criterion, ...]
    min_weighted: float
    min_per_criterion: int

    @property
    def codes(self) -> list[str]:
        return [c.code for c in self.criteria]

    def snapshot(self) -> dict[str, Any]:
        return {"criteria": [{"code": c.code, "weight": c.weight, "title": c.title} for c in self.criteria],
                "pass_rule": {"min_weighted": self.min_weighted, "min_per_criterion": self.min_per_criterion}}


def _localized(value: Any) -> dict[str, str]:
    if isinstance(value, Mapping) and isinstance(value.get("ru"), str) and isinstance(value.get("uz"), str):
        return {"ru": value["ru"], "uz": value["uz"]}
    raise ContentInvalid("localized text expected")


def rubric_from_payload(payload: Mapping[str, Any], version: int) -> Rubric:
    try:
        criteria = []
        for c in payload["criteria"]:
            code = str(c["code"])
            if code not in CRITERIA:
                raise ContentInvalid(f"unknown criterion {code}")
            bands = [{"score": int(b["score"]), "descriptor": _localized(b["descriptor"])} for b in c["bands"]]
            criteria.append(Criterion(code, float(c["weight"]), _localized(c["title"]), bands))
        rule = payload["pass_rule"]
        rubric = Rubric(str(payload["rubric_id"]), version, tuple(criteria), float(rule["min_weighted"]),
                        int(rule["min_per_criterion"]))
    except (KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, ContentInvalid):
            raise
        raise ContentInvalid("rubric payload is malformed") from exc
    if len(rubric.criteria) < 2 or len(set(rubric.codes)) != len(rubric.codes):
        raise ContentInvalid("rubric criteria are malformed")
    return rubric


def rubric_from_snapshot(rubric_id: str, version: int, snap: Mapping[str, Any]) -> Rubric:
    rule = snap["pass_rule"]
    return Rubric(rubric_id, version,
                  tuple(Criterion(c["code"], float(c["weight"]), dict(c["title"]), []) for c in snap["criteria"]),
                  float(rule["min_weighted"]), int(rule["min_per_criterion"]))


def verdict(rubric: Rubric, scores: Mapping[str, int | None]) -> tuple[float | None, bool | None, int]:
    """(weighted 0..3, passed, число оценённых критериев). Оценённых < 2 → (None, None, n)."""
    evaluated = [(c, scores.get(c.code)) for c in rubric.criteria if scores.get(c.code) is not None]
    if len(evaluated) < 2:
        return None, None, len(evaluated)
    total_w = sum(c.weight for c, _ in evaluated)
    if total_w <= 0:
        return None, None, len(evaluated)
    weighted = round(sum(c.weight * float(s) for c, s in evaluated if s is not None) / total_w, 3)
    weighted = min(3.0, max(0.0, weighted))
    passed = weighted + 1e-9 >= rubric.min_weighted and all(
        s is not None and s >= rubric.min_per_criterion for _, s in evaluated)
    return weighted, passed, len(evaluated)


# ---------------------------------------------------------------- ключи заданий


@dataclass(frozen=True)
class KeyItem:
    item_id: str
    type: str
    skill_id: str
    prompt_en: str
    options: tuple[str, ...]
    answer: Any


def _str_list(value: Any) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ContentInvalid("list of strings expected")
    return list(value)


def _check_key(item: KeyItem) -> KeyItem:
    n = len(item.options)
    if item.type in CHOICE_TYPES:
        if isinstance(item.answer, bool) or not isinstance(item.answer, int) or not 0 <= item.answer < n:
            raise ContentInvalid(f"{item.item_id}: choice key out of range")
    elif item.type == "gap_fill":
        if not item.answer or not all(isinstance(a, str) and a.strip() for a in item.answer):
            raise ContentInvalid(f"{item.item_id}: gap_fill key is empty")
    elif item.type == "order_words":
        if not item.answer or not all(isinstance(a, str) for a in item.answer):
            raise ContentInvalid(f"{item.item_id}: order_words key is empty")
    elif item.type == "order_lines":
        ok = (isinstance(item.answer, list) and sorted(item.answer) == list(range(n))
              and all(isinstance(a, int) and not isinstance(a, bool) for a in item.answer))
        if not ok:
            raise ContentInvalid(f"{item.item_id}: order_lines key is not a permutation")
    else:
        raise ContentInvalid(f"{item.item_id}: type {item.type} is not gradable")
    return item


def lesson_key_items(payload: Mapping[str, Any]) -> list[KeyItem]:
    try:
        out = []
        for ci in payload["control_items"]:
            if ci["type"] not in LESSON_ITEM_TYPES:
                raise ContentInvalid(f"unknown control item type {ci['type']}")
            answer = ci["answer"] if ci["type"] in CHOICE_TYPES else _str_list(ci["answer"])
            out.append(_check_key(KeyItem(str(ci["item_id"]), str(ci["type"]), str(ci["skill_id"]),
                                          str(ci.get("prompt_en") or ""), tuple(_str_list(ci.get("options") or [])),
                                          answer)))
        return out
    except (KeyError, TypeError) as exc:
        raise ContentInvalid("lesson control items are malformed") from exc


def exercise_key_item(payload: Mapping[str, Any]) -> KeyItem | None:
    """Упражнение к медиа → ключ; shadowing и roleplay (до голоса) не оцениваются правилами → None."""
    try:
        kind = str(payload["type"])
        if kind not in MEDIA_GRADABLE:
            return None
        answer = payload["answer"]
        if kind == "gap_fill":
            answer = _str_list(answer)
        return _check_key(KeyItem(str(payload["exercise_id"]), kind, str(payload["skill_id"]),
                                  str(payload.get("prompt_en") or ""), tuple(_str_list(payload.get("options") or [])),
                                  answer))
    except (KeyError, TypeError) as exc:
        raise ContentInvalid("media exercise is malformed") from exc


# ---------------------------------------------------------------- сравнение ответов


def normalize_gap(value: str) -> str:
    """gap_fill: NFC, типографские апострофы → ', пробелы схлопнуты, без регистра, без концевой пунктуации."""
    s = unicodedata.normalize("NFC", value).translate(_APOSTROPHES)
    s = " ".join(s.split()).casefold()
    while s and (s[-1] in _TRAILING or s[-1].isspace()):
        s = s[:-1]
    return s.strip()


def _ws(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())


@dataclass(frozen=True)
class Graded:
    item: KeyItem
    correct: bool
    answered: bool
    hinted: bool
    your_answer: str | None
    correct_answer: str


def _clip(value: str, n: int = ANSWER_MAX) -> str:
    return value if len(value) <= n else value[:n]


def correct_answer_text(item: KeyItem) -> str:
    if item.type in CHOICE_TYPES:
        return item.options[item.answer]
    if item.type == "gap_fill":
        return item.answer[0]
    if item.type == "order_words":
        return " ".join(item.answer)
    return " / ".join(item.options[i] for i in item.answer)


def _sequence(item: KeyItem, answer: Any) -> list[str] | None:
    """Ответ «по порядку» → последовательность строк: слова/реплики или индексы вариантов; строка order_words —
    по словам. Неподходящая форма → None."""
    if isinstance(answer, str) and item.type == "order_words":
        return answer.split()
    if not isinstance(answer, list) or not answer:
        return None
    out: list[str] = []
    for a in answer:
        if isinstance(a, bool):
            return None
        if isinstance(a, int):
            if not 0 <= a < len(item.options):
                return None
            out.append(item.options[a])
        elif isinstance(a, str):
            out.append(a)
        else:
            return None
    return out


def _render(item: KeyItem, answer: Any) -> str | None:
    if answer is None:
        return None
    if item.type in CHOICE_TYPES and isinstance(answer, int) and not isinstance(answer, bool) \
            and 0 <= answer < len(item.options):
        return _clip(item.options[answer])
    if isinstance(answer, str):
        return _clip(answer)
    seq = _sequence(item, answer)
    if seq is not None:
        return _clip((" / " if item.type == "order_lines" else " ").join(seq))
    return _clip(str(answer))


def grade(item: KeyItem, answer: Any, *, hinted: bool = False, dont_know: bool = False) -> Graded:
    """Правильность — только по ключу; форма ответа, не подходящая типу задания, — неверный ответ (не ошибка API)."""
    if dont_know or answer is None or answer == "" or answer == []:
        return Graded(item, False, False, hinted, None, correct_answer_text(item))
    correct = False
    if item.type in CHOICE_TYPES:
        idx: Any = answer
        if isinstance(answer, str):  # текст варианта вместо индекса — только точное совпадение
            matches = [i for i, o in enumerate(item.options) if o == answer]
            idx = matches[0] if len(matches) == 1 else None
        correct = isinstance(idx, int) and not isinstance(idx, bool) and idx == item.answer
    elif item.type == "gap_fill":
        value = answer[0] if isinstance(answer, list) and len(answer) == 1 else answer
        if isinstance(value, str):
            norm = normalize_gap(value)
            correct = bool(norm) and any(norm == normalize_gap(a) for a in item.answer)
    else:
        seq = _sequence(item, answer)
        expected = list(item.answer) if item.type == "order_words" else [item.options[i] for i in item.answer]
        correct = seq is not None and [_ws(s) for s in seq] == [_ws(s) for s in expected]
    return Graded(item, correct, True, hinted, _render(item, answer), correct_answer_text(item))


def closed_error_code(item_type: str) -> str:
    return {"gap_fill": "gap_fill", "order_words": "word_order", "order_lines": "line_order"}.get(
        item_type, "wrong_choice")


def closed_errors(graded: Iterable[Graded]) -> list[dict[str, Any]]:
    """Неверные закрытые задания с ответом ученика (цитата) и верным ответом из ключа; без ответа — не «ошибка с
    доказательством» (в items видно как неверное)."""
    out = []
    for g in graded:
        if g.correct or not g.answered or not g.your_answer:
            continue
        out.append({"turn_id": g.item.item_id, "evidence": g.your_answer[:EVIDENCE_MAX],
                    "correction": g.correct_answer[:CORRECTION_MAX], "error_code": closed_error_code(g.item.type),
                    "severity": "medium"})
    return out


# ---------------------------------------------------------------- критерии


def share_score(correct: int, total: int) -> int | None:
    if total <= 0:
        return None
    share = correct / total
    if share >= 0.8:
        return 3
    if share >= 0.6:
        return 2
    if share >= 0.3:
        return 1
    return 0


def hints_score(hints: int) -> int:
    return max(0, 3 - max(0, hints))


def outcome_score(outcome: str | None, learner_turns: int) -> int:
    """Исход сценария: success 3, alt_success 2, fail 1; не дошёл до конца или не ответил ни разу (отказ) — 0."""
    if outcome is None or learner_turns == 0:
        return 0
    return OUTCOME_SCORE[outcome]


@dataclass(frozen=True)
class RuleContext:
    content: str  # вид оцениваемого контента: lesson | scenario | media (review — вид исходной сессии)
    graded: Sequence[Graded]
    roleplay: bool  # ролевая ситуация была (есть исход или реплики)
    outcome: str | None
    learner_turns: int
    hints: int


def rule_scores(rubric: Rubric, ctx: RuleContext) -> dict[str, int | None]:
    """Баллы по правилам для всех критериев рубрики (null — не оценивался)."""
    total = len(ctx.graded)
    correct = sum(1 for g in ctx.graded if g.correct)
    closed_share = share_score(correct, total)
    vocab_items = [g for g in ctx.graded if g.item.type in MEDIA_VOCABULARY]
    out: dict[str, int | None] = {}
    for code in rubric.codes:
        value: int | None = None
        if code == "task":
            value = outcome_score(ctx.outcome, ctx.learner_turns) if ctx.roleplay else closed_share
        elif code == "independence":
            value = hints_score(ctx.hints) if (ctx.roleplay or total) else None
        elif code == "comprehension":
            value = closed_share
        elif code == "vocabulary" and ctx.content == "media" and vocab_items:
            value = share_score(sum(1 for g in vocab_items if g.correct), len(vocab_items))
        out[code] = value
    return out


def combine_scores(rubric: Rubric, rules: Mapping[str, int | None], ai: Mapping[str, Any], *,
                   closed_present: bool) -> dict[str, int | None]:
    """Наложение баллов оценщика на баллы правил:
    pronunciation и fluency — всегда null (по тексту не оцениваются); independence — по правилам (число подсказок
    объективно); comprehension — по правилам, если есть закрытые задания; task — не выше балла правил, если он есть
    (исход по графу сценария не завышается словами); vocabulary, grammar — оценщик."""
    out: dict[str, int | None] = {}
    for code in rubric.codes:
        rule = rules.get(code)
        raw = ai.get(code)
        value = raw if isinstance(raw, int) and not isinstance(raw, bool) and 0 <= raw <= 3 else None
        if code in ("pronunciation", "fluency"):
            out[code] = None
        elif code == "independence" or (code == "comprehension" and closed_present):
            out[code] = rule
        elif code == "task":
            out[code] = min(rule, value) if rule is not None and value is not None else (
                value if value is not None else rule)
        else:
            out[code] = value if value is not None else rule
    return out


# ---------------------------------------------------------------- навыки


def skill_outcomes(skills: Sequence[str], graded: Sequence[Graded], passed: bool | None) -> list[dict[str, Any]]:
    """demonstrated — без подсказок верно ≥ 2/3 заданий навыка (не меньше 1) и рубрика зачтена; иначе learning;
    навыки без заданий — not_assessed. Подсказанный ответ не засчитывается как верный для demonstrated."""
    order: list[str] = []
    for s in [*skills, *(g.item.skill_id for g in graded)]:
        if s and s not in order:
            order.append(s)
    out = []
    for skill in order:
        mine = [g for g in graded if g.item.skill_id == skill]
        if not mine:
            out.append({"skill_id": skill, "outcome": "not_assessed", "evidence_refs": []})
            continue
        clean = sum(1 for g in mine if g.correct and not g.hinted)
        demonstrated = passed is True and clean >= 1 and clean * 3 >= 2 * len(mine)
        out.append({"skill_id": skill, "outcome": "demonstrated" if demonstrated else "learning",
                    "evidence_refs": [g.item.item_id for g in mine]})
    return out


# ---------------------------------------------------------------- ошибки оценщика


def verify_ai_errors(errors: Any, learner_texts: Mapping[str, str]) -> list[dict[str, Any]]:
    """Ошибки оценщика принимаются только с turn_id реплики ученика (свободный текст) и цитатой, дословно
    встречающейся в ней (с точностью до пробелов); остальные отбрасываются. Не больше 5."""
    if not isinstance(errors, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for e in errors:
        if not isinstance(e, Mapping):
            continue
        turn_id, evidence, correction = e.get("turn_id"), e.get("evidence"), e.get("correction")
        code, severity = e.get("error_code"), e.get("severity")
        if not (isinstance(turn_id, str) and isinstance(evidence, str) and isinstance(correction, str)
                and isinstance(code, str) and isinstance(severity, str)):
            continue
        evidence_n = _ws(evidence)
        if not evidence_n or len(evidence_n) > EVIDENCE_MAX or not correction.strip() \
                or len(correction) > CORRECTION_MAX or severity not in SEVERITY_RANK or not ERROR_CODE_RE.match(code):
            continue
        text = learner_texts.get(turn_id)
        if text is None or evidence_n not in _ws(text) or (turn_id, evidence_n) in seen:
            continue
        seen.add((turn_id, evidence_n))
        out.append({"turn_id": turn_id, "evidence": evidence_n, "correction": correction.strip(), "error_code": code,
                    "severity": severity})
        if len(out) == MAX_ERRORS:
            break
    return out


def rank_errors(errors: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """По severity (high → low), при равенстве — в исходном порядке; не больше 5."""
    return sorted(errors, key=lambda e: SEVERITY_RANK.get(e.get("severity", "low"), 2))[:MAX_ERRORS]


def key_errors(errors: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return rank_errors(errors)[:KEY_ERRORS]
