"""Правила диагностики без LLM (навык diagnostic_assessor, INTERNAL_API §2.2–2.4) — чистые функции.

Всё детерминировано: одинаковые (версия теста, seed, ответы, доступность аудирования) → одинаковые задания,
профиль, рекомендация и переходы навыков. Модуль не знает о БД и HTTP: его проверяют unit-тесты.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Any

from tilhero_diagnostics.testdef import ALL_AREAS, BANDS, TEST_AREAS, Item, TestDef

NOT_IN_TEST = ("speaking", "writing")
FOLLOWUP_THRESHOLD = Fraction(1, 2)


@dataclass(frozen=True)
class Answered:
    """Ответ ученика в истории подбора/оценки (без самого ответа: правильность уже посчитана)."""

    item_id: str
    area: str
    band: str
    correct: bool
    dont_know: bool = False

    @property
    def band_index(self) -> int:
        return BANDS.index(self.band)


# ---------------------------------------------------------------- подбор (§2.2)


def item_rank(seed: str, item_id: str) -> str:
    """Порядок заданий внутри (область, полоса): минимальный sha256(seed + item_id)."""
    return hashlib.sha256(f"{seed}{item_id}".encode()).hexdigest()


def target_band(test: TestDef, history: Sequence[Answered], area: str) -> int:
    """Лестница области: старт — start_band; после верного ответа — полоса выше, после неверного или «не знаю» —
    ниже (A0…B2). Отсчёт — от полосы последнего показанного задания области (а не от желаемой)."""
    last = next((a for a in reversed(history) if a.area == area), None)
    if last is None:
        return BANDS.index(test.config.start_band)
    step = 1 if last.correct else -1
    return min(max(last.band_index + step, 0), len(BANDS) - 1)


def pick_in_area(test: TestDef, seed: str, history: Sequence[Answered], area: str) -> Item | None:
    """Ещё не показанное задание области: нужная полоса, иначе ближайшая доступная (при равенстве — ниже),
    внутри полосы — минимальный sha256(seed + item_id). None — задания области кончились."""
    seen = {a.item_id for a in history}
    candidates = [i for i in test.items if i.area == area and i.item_id not in seen]
    if not candidates:
        return None
    target = target_band(test, history, area)
    best_band = min({i.band_index for i in candidates}, key=lambda b: (abs(b - target), b))
    return min((i for i in candidates if i.band_index == best_band), key=lambda i: item_rank(seed, i.item_id))


def next_item(
    test: TestDef,
    seed: str,
    history: Sequence[Answered],
    *,
    session_answers: Sequence[Answered],
    quotas: Mapping[str, int],
    listening_available: bool,
) -> Item | None:
    """Следующее задание сессии или None (готово).

    history — все ответы, влияющие на подбор (основная сессия + уточнения того же результата), по порядку;
    session_answers — ответы текущей сессии (для квот); quotas — сколько заданий области в этой сессии.
    Области — по кругу в порядке config.areas (V → G → R → L), начиная со следующей после последнего ответа
    сессии; пропускаются области с исчерпанной квотой, без заданий и аудирование, если голоса нет."""
    areas = [a for a in test.config.areas if a in quotas and (listening_available or a != "listening")]
    if not areas:
        return None
    counts = {a: sum(1 for x in session_answers if x.area == a) for a in areas}
    order = list(test.config.areas)
    start = 0
    if session_answers:
        start = (order.index(session_answers[-1].area) + 1) % len(order)
    for shift in range(len(order)):
        area = order[(start + shift) % len(order)]
        if area not in counts or counts[area] >= quotas[area]:
            continue
        item = pick_in_area(test, seed, history, area)
        if item is not None:
            return item
    return None


# ---------------------------------------------------------------- оценка (§2.3)


@dataclass
class AreaScore:
    area: str
    status: str  # assessed | not_assessed
    band: str | None
    confidence: float | None
    reason: str | None  # too_few_items | no_speech_voice | not_in_test_yet
    # основания по полосам: [{band, answered, correct}] по возрастанию; для not_assessed — []
    evidence: list[dict[str, Any]] = field(default_factory=list)
    needs_followup: bool = False
    # точное значение уверенности (для проверки порога без ошибок округления)
    exact_confidence: Fraction | None = None

    def public(self) -> dict[str, Any]:
        return {"area": self.area, "status": self.status, "band": self.band, "confidence": self.confidence,
                "reason": self.reason, "evidence": self.evidence, "needs_followup": self.needs_followup}


def area_band(test: TestDef, answers: Sequence[Answered]) -> int:
    """Наивысшая полоса, где внутри этой полосы верных ≥ min_correct_per_band (взрослые 2, дети 1) и точность
    ≥ 0,6; если таких нет — на ступень ниже стартовой (минимум A0)."""
    need = test.config.min_correct_per_band
    for b in reversed(range(len(BANDS))):
        at = [a for a in answers if a.band_index == b]
        correct = sum(1 for a in at if a.correct)
        if at and correct >= need and Fraction(correct, len(at)) >= Fraction(3, 5):
            return b
    return max(BANDS.index(test.config.start_band) - 1, 0)


def consistency(answers: Sequence[Answered], band: int) -> Fraction:
    """Доля ответов, согласных с итоговой полосой: верный ответ на полосе ≤ итоговой или неверный (и «не знаю»)
    на полосе выше итоговой."""
    agree = sum(1 for a in answers if (a.band_index <= band) == a.correct)
    return Fraction(agree, len(answers))


def jumps(answers: Sequence[Answered]) -> int:
    """Скачки: верные ответы на полосе выше самой низкой полосы с ошибкой (или «не знаю») в области —
    провал простого и успех сложного (признак угадывания или неровного знания)."""
    wrong = [a.band_index for a in answers if not a.correct]
    if not wrong:
        return 0
    lowest_wrong = min(wrong)
    return sum(1 for a in answers if a.correct and a.band_index > lowest_wrong)


def confidence(answers: Sequence[Answered], band: int) -> Fraction:
    """clamp(0,2 + 0,1·n + 0,4·согласованность − 0,2·скачки, 0, 1) — точно, в дробях."""
    n = len(answers)
    raw = Fraction(1, 5) + Fraction(n, 10) + Fraction(2, 5) * consistency(answers, band) - Fraction(1, 5) * jumps(
        answers)
    return min(max(raw, Fraction(0)), Fraction(1))


def band_evidence(answers: Iterable[Any]) -> list[dict[str, Any]]:
    """Основания области по полосам (по возрастанию): сколько заданий полосы показано и сколько верно.
    Без item_id и отметок по отдельным заданиям — результат не должен быть «оракулом» ключей банка (ревью).
    Принимает Answered или сохранённые отметки {band, correct} старых ревизий."""
    answered: dict[str, int] = {}
    correct: dict[str, int] = {}
    for a in answers:
        band, ok = (a.get("band"), a.get("correct")) if isinstance(a, Mapping) else (a.band, a.correct)
        if band not in BANDS:
            continue
        answered[band] = answered.get(band, 0) + 1
        correct[band] = correct.get(band, 0) + (1 if ok else 0)
    return [{"band": b, "answered": answered[b], "correct": correct[b]} for b in BANDS if b in answered]


def score_area(test: TestDef, area: str, answers: Sequence[Answered], *, listening_available: bool) -> AreaScore:
    """Оценка одной области по её ответам (в порядке ответов)."""
    if area in NOT_IN_TEST or area not in test.config.areas:
        return AreaScore(area, "not_assessed", None, None, "not_in_test_yet")
    if area == "listening" and not listening_available:
        return AreaScore(area, "not_assessed", None, None, "no_speech_voice")
    if len(answers) < test.config.min_items_assessed:
        return AreaScore(area, "not_assessed", None, None, "too_few_items")
    band = area_band(test, answers)
    conf = confidence(answers, band)
    return AreaScore(area, "assessed", BANDS[band], float(round(conf, 2)), None, band_evidence(answers),
                     needs_followup=conf < FOLLOWUP_THRESHOLD, exact_confidence=conf)


def median_band(bands: Iterable[str]) -> str | None:
    """Медиана оценённых областей; при чётном числе — нижняя из двух средних (округление вниз); < 2 — None."""
    idx = sorted(BANDS.index(b) for b in bands)
    if len(idx) < 2:
        return None
    return BANDS[idx[(len(idx) - 1) // 2]]


@dataclass
class Profile:
    areas: list[AreaScore]
    provisional_level: str | None
    weak_areas: list[str]


def profile(test: TestDef, answers: Sequence[Answered], *, listening_available: bool) -> Profile:
    """Профиль по всем шести областям (говорение и письмо — not_in_test_yet), предварительный уровень и слабые
    стороны: сначала оценённые области с полосой ниже медианы, затем области теста без оценки (not_assessed)."""
    scores = [score_area(test, area, [a for a in answers if a.area == area], listening_available=listening_available)
              for area in ALL_AREAS]
    assessed = [s for s in scores if s.status == "assessed" and s.band is not None]
    level = median_band(s.band for s in assessed if s.band is not None)
    weak: list[str] = []
    if level is not None:
        weak = [s.area for s in assessed if s.band is not None and BANDS.index(s.band) < BANDS.index(level)]
    weak += [s.area for s in scores if s.status == "not_assessed" and s.area in TEST_AREAS
             and s.area in test.config.areas]
    return Profile(scores, level, weak)


# ---------------------------------------------------------------- карта навыков (§2.4)


@dataclass(frozen=True)
class SkillOutcome:
    skill_id: str
    outcome: str  # positive | negative
    band: str
    confidence: float


def item_skills(item: Item, tag_index: Mapping[str, set[str]] | None,
                course_skills: set[str] | None) -> set[str]:
    """Навыки задания: skill_ids задания ∪ навыки курса, у которых diagnostic_tags пересекаются с tags задания.
    Если снимок курса есть — только навыки курса; без снимка — skill_ids задания."""
    skills = set(item.skill_ids)
    if tag_index is not None:
        for tag in item.tags:
            skills |= tag_index.get(tag, set())
    if course_skills is not None:
        skills &= course_skills
    return skills


def skill_outcomes(answers: Sequence[Answered], skills_of: Mapping[str, set[str]]) -> list[SkillOutcome]:
    """Свидетельство диагностики по навыку (одно на навык и результат):
    есть верные и нет неверных той же или ниже полосы (чем наивысший верный) → positive (demonstrated);
    есть неверные → negative (learning); навык не затронут — свидетельства нет."""
    by_skill: dict[str, list[Answered]] = {}
    for a in answers:
        for skill in skills_of.get(a.item_id, ()):
            by_skill.setdefault(skill, []).append(a)
    out: list[SkillOutcome] = []
    for skill in sorted(by_skill):
        group = by_skill[skill]
        correct = [a.band_index for a in group if a.correct]
        wrong = [a.band_index for a in group if not a.correct]
        if correct and not any(w <= max(correct) for w in wrong):
            supporting = len(correct)
            out.append(SkillOutcome(skill, "positive", BANDS[max(correct)],
                                    float(round(Fraction(supporting, len(group)), 2))))
        elif wrong:
            out.append(SkillOutcome(skill, "negative", BANDS[min(wrong)],
                                    float(round(Fraction(len(wrong), len(group)), 2))))
    return out


def transition(current: str, outcome: str, previous_outcome: str | None) -> str:
    """Переход состояния навыка по новому свидетельству. retained ставят только проверки удержания (спринт 5);
    понижение demonstrated/retained → learning — только при двух отрицательных свидетельствах подряд."""
    if outcome == "positive":
        return current if current in ("demonstrated", "retained") else "demonstrated"
    if current in ("demonstrated", "retained"):
        return "learning" if previous_outcome == "negative" else current
    return "learning"


# ---------------------------------------------------------------- рекомендация старта (§2.3)


AREA_OF_SKILL = {"vocabulary": "vocabulary", "grammar": "grammar", "reading": "reading", "listening": "listening"}


def recommend_start(
    snapshot: Mapping[str, Any],
    states: Mapping[str, str],
    area_bands: Mapping[str, str | None],
    provisional_level: str | None,
    segment: str,
) -> dict[str, Any] | None:
    """Стартовый урок (INTERNAL_API §2.3). Core-уроки курса в порядке модулей и уроков, только для сегмента
    ученика (дети — audience kids):
    1. урок пропускается, если его основной навык demonstrated/retained или уровня строго ниже оценённой полосы
       своей области (функции, говорение, письмо и неоценённые области — ниже предварительного уровня; уровня нет —
       только по полосам оценённых областей): ученик A2 не получает урок A0 только потому, что тест стартует с A1;
    2. первый непропущенный урок, каждая предпосылка которого (урока и основного навыка) demonstrated/retained или
       уровня не выше полосы своей области (та же полоса, включительно), — рекомендация;
    3. если пропущены все core-уроки сегмента (ученик выше курса) — первый не освоенный core-урок самого высокого
       уровня курса для сегмента; нет такого — None. Урок, заблокированный непроверенной предпосылкой, тоже даёт
       None (не предполагаем непроверенных предпосылок)."""
    skills = {s["skill_id"]: s for s in snapshot.get("skills", []) if isinstance(s, Mapping) and "skill_id" in s}
    lessons = {ls["lesson_id"]: ls for ls in snapshot.get("lessons", [])
               if isinstance(ls, Mapping) and "lesson_id" in ls}
    order: list[str] = []
    for module in snapshot.get("modules", []):
        for lesson_id in module.get("lesson_ids", []) if isinstance(module, Mapping) else []:
            if lesson_id in lessons and lesson_id not in order:
                order.append(lesson_id)

    def done(skill_id: str) -> bool:
        return states.get(skill_id) in ("demonstrated", "retained")

    def level_gap(skill_id: str) -> int | None:
        """Полоса ученика в области навыка минус уровень навыка (в ступенях); None — сравнить не с чем.
        Полоса — оценённая полоса своей области; функции, говорение, письмо и неоценённые области — предварительный
        уровень; уровня нет — только оценённые области."""
        skill = skills.get(skill_id)
        if skill is None or skill.get("level") not in BANDS:
            return None
        area = AREA_OF_SKILL.get(str(skill.get("area")))
        band = (area_bands.get(area) if area else None) or provisional_level
        return BANDS.index(band) - BANDS.index(str(skill["level"])) if band is not None else None

    def below_band(skill_id: str) -> bool:
        """Основной навык урока: строго ниже полосы — урок пропускается (ученик A2 начинает с уроков A2)."""
        gap = level_gap(skill_id)
        return gap is not None and gap > 0

    def within_band(skill_id: str) -> bool:
        """Предпосылка: уровень не выше полосы — засчитана (ученик с полосой A2 владеет навыками A2)."""
        gap = level_gap(skill_id)
        return gap is not None and gap >= 0

    def card(lesson_id: str) -> dict[str, Any]:
        lesson = lessons[lesson_id]
        level = lesson.get("level")
        return {"lesson_id": lesson_id, "title": lesson.get("title"), "level": level if level in BANDS else None}

    core = [lid for lid in order
            if lessons[lid].get("kind") == "core" and segment in (lessons[lid].get("audience") or [])]
    skipped_all = True
    for lesson_id in core:
        lesson = lessons[lesson_id]
        primary = str(lesson.get("primary_skill_id", ""))
        if done(primary) or below_band(primary):
            continue
        skipped_all = False
        prereqs = [*lesson.get("prerequisite_skill_ids", []), *skills.get(primary, {}).get("prerequisites", [])]
        if all(done(p) or within_band(p) for p in dict.fromkeys(prereqs)):
            return card(lesson_id)
    if not core or not skipped_all:
        return None
    levels = [BANDS.index(lessons[lid]["level"]) for lid in core if lessons[lid].get("level") in BANDS]
    if not levels:
        return None
    top = BANDS[max(levels)]
    for lesson_id in core:
        if lessons[lesson_id].get("level") == top and not done(str(lessons[lesson_id].get("primary_skill_id", ""))):
            return card(lesson_id)
    return None
