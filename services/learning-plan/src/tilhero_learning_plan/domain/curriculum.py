"""Траектория уроков (INTERNAL_API §3, AT-36, AT-34) — детерминированные правила навыка `curriculum_planner`
без LLM. Чистые функции: снимок курса + входы ученика → обязательные и дополнительные уроки с причинами.

Алгоритм:
1. Подходят только уроки своей аудитории: детям 6–13 — с audience ∋ kids, подросткам — ∋ teens, взрослым — ∋ adults.
   Порядок курса — модули снимка по порядку, внутри — `lesson_ids` модуля.
2. Старт: есть диагностика — рекомендованный ею урок (если он core и подходит аудитории), иначе то же правило,
   что у diagnostics: первый core-урок, чей основной навык не освоен и не ниже уровня ученика, с закрытыми
   предпосылками (нет такого — первый из не освоенных и не ниже уровня; все ниже уровня — первый не освоенный урок
   высшего уровня курса); нет диагностики — первый core-урок курса.
3. Обязательные — core-уроки по порядку курса от старта, кроме уроков с освоенным основным навыком
   (demonstrated | retained). Перед уроком вставляются уроки, закрывающие его недостающие предпосылки
   (`prerequisite_skill_ids` урока ∪ `prerequisites` его основного навыка; рекурсивно, без повторов). Предпосылка
   закрыта, если навык освоен, его уже даёт урок выше в плане или уровень навыка не выше полосы, оценённой
   диагностикой в его области (функции и неоценённые области — не выше предварительного уровня) — то же
   правило, что у стартовой рекомендации diagnostics: следующий урок плана после диагностики = её рекомендация.
4. Дополнительные — optional-уроки с совпадением цели или тем ученика (≤ N): сначала с большим числом совпадений,
   затем по порядку курса; уроки с освоенным навыком и уже вошедшие в план — нет.
5. Следующий — первый обязательный (нет обязательных — первый дополнительный).

Причины (`ReasonCode`, bff.ts): основная — `start_after_diagnostic` | `no_diagnostic` (первый урок от старта),
`prerequisite_missing` (вставленный), `next_in_course` (остальные); уточняющие — `weak_area` (область основного
навыка ниже предварительного уровня по диагностике), `goal_match`, `topic_match`. Объяснение — Localized RU/UZ из
кодов; детям — мягкие формулировки без сравнения.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

from tilhero_learning_plan.directory import GOALS
from tilhero_learning_plan.domain.snapshot import BANDS, CourseSnapshot, SnapLesson, SnapSkill

ReasonCode = Literal[
    "start_after_diagnostic", "no_diagnostic", "prerequisite_missing", "weak_area", "goal_match", "topic_match",
    "next_in_course",
]
REASON_CODES: tuple[ReasonCode, ...] = (
    "start_after_diagnostic", "no_diagnostic", "prerequisite_missing", "weak_area", "goal_match", "topic_match",
    "next_in_course",
)
MASTERED = frozenset({"demonstrated", "retained"})
DIAGNOSTIC_AREAS = frozenset({"vocabulary", "grammar", "reading", "listening", "speaking", "writing"})
# Версия правил: смена алгоритма = другие входы (basis) → новая ревизия при следующем чтении
ALGORITHM = "cp-2"  # cp-2: предпосылка закрыта уровнем ≤ полосы (как в diagnostics, ревью спринта 3)
_RANK: dict[str, int] = {b: i for i, b in enumerate(BANDS)}


@dataclass(frozen=True)
class AreaResult:
    status: str  # assessed | not_assessed
    band: str | None


@dataclass(frozen=True)
class Diagnostic:
    """Последний результат диагностики ученика по паре (проекция diagnostics.completed.v1)."""

    result_id: str
    revision: int
    provisional_level: str | None
    areas: Mapping[str, AreaResult]
    recommended_start_lesson_id: str | None

    def assessed_band(self, area: str) -> str | None:
        a = self.areas.get(area)
        return a.band if a is not None and a.status == "assessed" and a.band in _RANK else None

    def weak_areas(self) -> frozenset[str]:
        """Оценённые области с полосой ниже предварительного уровня (медианы). not_assessed слабой не считается:
        говорение и письмо до спринта 4 не оцениваются у всех."""
        level = self.provisional_level
        if level not in _RANK:
            return frozenset()
        return frozenset(
            area for area in self.areas
            if (band := self.assessed_band(area)) is not None and _RANK[band] < _RANK[level]
        )


@dataclass(frozen=True)
class Learner:
    audience: str  # kids | teens | adults
    goal: str | None = None
    topics: tuple[str, ...] = ()
    diagnostic: Diagnostic | None = None
    skills: Mapping[str, str] = field(default_factory=dict)  # skill_id → состояние карты навыков

    def mastered(self, skill_id: str) -> bool:
        return self.skills.get(skill_id) in MASTERED


@dataclass(frozen=True)
class Planned:
    lesson: SnapLesson
    reason_codes: tuple[ReasonCode, ...]


@dataclass(frozen=True)
class TrajectoryPlan:
    mandatory: tuple[Planned, ...]
    optional: tuple[Planned, ...]

    @property
    def next(self) -> Planned | None:
        if self.mandatory:
            return self.mandatory[0]
        return self.optional[0] if self.optional else None


def course_order(snapshot: CourseSnapshot) -> list[SnapLesson]:
    """Уроки в порядке курса: модули снимка по порядку, внутри — lesson_ids модуля (без повторов; уроки вне
    модулей курса в траекторию не входят)."""
    by_id = {lesson.lesson_id: lesson for lesson in snapshot.lessons}
    seen: set[str] = set()
    ordered: list[SnapLesson] = []
    for module in snapshot.modules:
        for lesson_id in module.lesson_ids:
            lesson = by_id.get(lesson_id)
            if lesson is not None and lesson_id not in seen:
                seen.add(lesson_id)
                ordered.append(lesson)
    return ordered


def _dedup(items: Iterable[str]) -> list[str]:
    out: list[str] = []
    for item in items:
        if item not in out:
            out.append(item)
    return out


class _Planner:
    def __init__(self, snapshot: CourseSnapshot, learner: Learner) -> None:
        self.learner = learner
        self.skills: dict[str, SnapSkill] = {s.skill_id: s for s in snapshot.skills}
        self.eligible = [lesson for lesson in course_order(snapshot) if learner.audience in lesson.audience]
        self.index = {lesson.lesson_id: i for i, lesson in enumerate(self.eligible)}
        self.core = [lesson for lesson in self.eligible if lesson.kind == "core"]
        self.weak = learner.diagnostic.weak_areas() if learner.diagnostic is not None else frozenset()
        self.mandatory: list[Planned] = []
        self.in_plan: set[str] = set()
        self.taught: set[str] = set()  # основные навыки уроков, уже стоящих в плане

    def prerequisites(self, lesson: SnapLesson) -> list[str]:
        primary = self.skills.get(lesson.primary_skill_id)
        own = primary.prerequisites if primary is not None else []
        return [p for p in _dedup([*lesson.prerequisite_skill_ids, *own]) if p != lesson.primary_skill_id]

    def level_gap(self, skill_id: str) -> int | None:
        """Полоса ученика в области навыка минус уровень навыка (в ступенях) — как engine.recommend_start
        diagnostics: оценённая полоса своей области; функции, говорение, письмо и неоценённые области —
        предварительный уровень; уровня нет — только оценённые области. None — сравнить не с чем."""
        diag, skill = self.learner.diagnostic, self.skills.get(skill_id)
        if diag is None or skill is None or skill.level not in _RANK:
            return None
        band = diag.assessed_band(skill.area) if skill.area in DIAGNOSTIC_AREAS else None
        band = band or (diag.provisional_level if diag.provisional_level in _RANK else None)
        return _RANK[band] - _RANK[skill.level] if band is not None else None

    def covered_by_level(self, skill_id: str) -> bool:
        """Предпосылка закрыта уровнем (решение ревью, то же правило, что у diagnostics): уровень не выше полосы."""
        gap = self.level_gap(skill_id)
        return gap is not None and gap >= 0

    def below_level(self, skill_id: str) -> bool:
        """Основной навык урока строго ниже полосы ученика — урок не стартовый (ученик A2 начинает с уроков A2)."""
        gap = self.level_gap(skill_id)
        return gap is not None and gap > 0

    def satisfied(self, skill_id: str) -> bool:
        return self.learner.mastered(skill_id) or skill_id in self.taught or self.covered_by_level(skill_id)

    def teacher(self, skill_id: str) -> SnapLesson | None:
        """Урок, дающий навык: core раньше optional, затем по порядку курса."""
        candidates = [lesson for lesson in self.eligible if lesson.primary_skill_id == skill_id]
        candidates.sort(key=lambda lesson: (lesson.kind != "core", self.index[lesson.lesson_id]))
        return candidates[0] if candidates else None

    def modifiers(self, lesson: SnapLesson) -> list[ReasonCode]:
        out: list[ReasonCode] = []
        primary = self.skills.get(lesson.primary_skill_id)
        if primary is not None and primary.area in self.weak:
            out.append("weak_area")
        if self.learner.goal is not None and self.learner.goal in lesson.goals:
            out.append("goal_match")
        if set(self.learner.topics) & set(lesson.topics):
            out.append("topic_match")
        return out

    def append(self, lesson: SnapLesson, code: ReasonCode) -> None:
        self.mandatory.append(Planned(lesson, (code, *self.modifiers(lesson))))
        self.in_plan.add(lesson.lesson_id)
        self.taught.add(lesson.primary_skill_id)

    def add(self, lesson: SnapLesson, code: ReasonCode, path: frozenset[str]) -> None:
        for skill_id in self.prerequisites(lesson):
            if self.satisfied(skill_id):
                continue
            teacher = self.teacher(skill_id)
            if teacher is None or teacher.lesson_id in self.in_plan or teacher.lesson_id in path:
                continue  # навык никто не даёт (для этой аудитории) или цикл — не вставляем
            self.add(teacher, "prerequisite_missing", path | {lesson.lesson_id})
        if lesson.lesson_id not in self.in_plan:
            self.append(lesson, code)

    def start_index(self) -> int:
        diag = self.learner.diagnostic
        if diag is None:
            return 0
        recommended = diag.recommended_start_lesson_id
        for i, lesson in enumerate(self.core):
            if lesson.lesson_id == recommended:
                return i
        # рекомендации нет (снимка не было у diagnostics, урок не core или не для этой аудитории, ученик выше
        # курса) — то же правило, что у diagnostics: уроки с освоенным или строго ниже уровня основным навыком
        # не стартовые; первый с закрытыми предпосылками, иначе первый из остальных (недостающие предпосылки
        # вставит add); все ниже уровня — первый не освоенный урок высшего уровня курса
        open_ = [i for i, lesson in enumerate(self.core)
                 if not self.learner.mastered(lesson.primary_skill_id)
                 and not self.below_level(lesson.primary_skill_id)]
        for i in open_:
            if all(self.learner.mastered(p) or self.covered_by_level(p) for p in self.prerequisites(self.core[i])):
                return i
        if open_:
            return open_[0]
        levels = [_RANK[lesson.level] for lesson in self.core if lesson.level in _RANK]
        top = max(levels, default=-1)
        for i, lesson in enumerate(self.core):
            if _RANK.get(lesson.level) == top and not self.learner.mastered(lesson.primary_skill_id):
                return i
        return len(self.core)

    def build_mandatory(self) -> None:
        first: ReasonCode = "start_after_diagnostic" if self.learner.diagnostic is not None else "no_diagnostic"
        started = False
        for lesson in self.core[self.start_index():]:
            if lesson.lesson_id in self.in_plan or self.learner.mastered(lesson.primary_skill_id):
                continue
            self.add(lesson, "next_in_course" if started else first, frozenset())
            started = True

    def build_optional(self, limit: int) -> list[Planned]:
        ranked: list[tuple[int, int, Planned]] = []
        for lesson in self.eligible:
            if lesson.kind != "optional" or lesson.lesson_id in self.in_plan:
                continue
            if self.learner.mastered(lesson.primary_skill_id):
                continue
            mods = self.modifiers(lesson)
            matches = [m for m in mods if m in ("goal_match", "topic_match")]
            if not matches:
                continue
            ranked.append((-len(matches), self.index[lesson.lesson_id], Planned(lesson, tuple(mods))))
        ranked.sort(key=lambda item: (item[0], item[1]))
        return [planned for _, _, planned in ranked[:limit]]


def plan_trajectory(snapshot: CourseSnapshot, learner: Learner, *, optional_max: int = 8) -> TrajectoryPlan:
    planner = _Planner(snapshot, learner)
    planner.build_mandatory()
    return TrajectoryPlan(tuple(planner.mandatory), tuple(planner.build_optional(optional_max)))


# ---------------------------------------------------------------- объяснение «почему этот урок»

_GOAL_LABELS = {item["code"]: item["label"] for item in GOALS}

_TEXTS: dict[str, dict[str, str]] = {
    "start_after_diagnostic": {
        "ru": "По итогам диагностики начать лучше с этого урока.",
        "uz": "Diagnostika natijalariga koʻra shu darsdan boshlash tavsiya etiladi.",
    },
    "no_diagnostic": {
        "ru": "Диагностика ещё не пройдена, поэтому план начинается с начала курса. Пройдите её — план "
              "подстроится под ваш уровень.",
        "uz": "Diagnostika hali oʻtilmagan, shuning uchun reja kurs boshidan boshlanadi. Undan oʻting — reja "
              "darajangizga moslashadi.",
    },
    "prerequisite_missing": {
        "ru": "Этот урок даёт навык, без которого следующие уроки будут трудными.",
        "uz": "Bu dars keyingi darslar uchun zarur boʻlgan koʻnikmani beradi.",
    },
    "weak_area": {
        "ru": "Тренирует область, которая по диагностике пока отстаёт от остальных.",
        "uz": "Diagnostikaga koʻra hozircha ortda qolayotgan sohani mashq qildiradi.",
    },
    "topic_match": {
        "ru": "Касается тем, которые вы выбрали.",
        "uz": "Siz tanlagan mavzularga oid.",
    },
    "next_in_course": {
        "ru": "Следующий шаг по программе курса.",
        "uz": "Kurs dasturi boʻyicha navbatdagi qadam.",
    },
}
# Детям 6–13 — без давления и сравнения (CONVENTIONS §8)
_KID_TEXTS: dict[str, dict[str, str]] = {
    "start_after_diagnostic": {"ru": "С этого урока удобно начать.", "uz": "Shu darsdan boshlash qulay."},
    "no_diagnostic": {"ru": "Начнём с самого начала — шаг за шагом.", "uz": "Eng boshidan, qadamma-qadam boshlaymiz."},
    "prerequisite_missing": {
        "ru": "Этот урок поможет подготовиться к следующим.",
        "uz": "Bu dars keyingi darslarga tayyorlanishga yordam beradi.",
    },
    "weak_area": {
        "ru": "Здесь можно ещё немного потренировать то, что пока получается не сразу.",
        "uz": "Bu yerda hozircha birdaniga chiqmayotgan narsalarni yana biroz mashq qilish mumkin.",
    },
    "topic_match": {"ru": "В уроке — выбранные темы.", "uz": "Darsda tanlangan mavzular bor."},
    "next_in_course": {"ru": "Следующий шаг по курсу.", "uz": "Kurs boʻyicha navbatdagi qadam."},
}


def _goal_sentence(goal: str | None, lang: str, kids: bool) -> str:
    label = _GOAL_LABELS.get(goal or "")
    if label is None:
        return "Подходит под выбранную цель." if lang == "ru" else "Tanlangan maqsadga mos keladi."
    if lang == "ru":
        return f"Подходит под цель «{label['ru']}»." if kids else f"Подходит под вашу цель «{label['ru']}»."
    return f"«{label['uz']}» maqsadiga mos keladi." if kids else f"«{label['uz']}» maqsadingizga mos keladi."


def explain(codes: Sequence[str], *, goal: str | None, kids: bool) -> dict[str, str]:
    """Объяснение «почему этот урок» на RU/UZ из кодов причин (в порядке кодов, без повторов)."""
    texts = _KID_TEXTS if kids else _TEXTS
    out: dict[str, str] = {}
    for lang in ("ru", "uz"):
        sentences: list[str] = []
        for code in _dedup(codes):
            if code == "goal_match":
                sentences.append(_goal_sentence(goal, lang, kids))
            elif code in texts:
                sentences.append(texts[code][lang])
        out[lang] = " ".join(sentences) or texts["next_in_course"][lang]
    return out
