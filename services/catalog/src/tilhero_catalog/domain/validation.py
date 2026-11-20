"""Проверка тел версий контента (INTERNAL_API §1.2, AT-27/28/29). Чистые функции без БД.

Уровни:
1. **Схема** вида (`content.py`, pydantic 1:1 с content.ts) — при создании и правке черновика; ошибка → 422
   CONTENT_INVALID c кодом SCHEMA_INVALID.
2. **Бизнес-правила** — при отправке на проверку (`mode="submit"`) и при публикации/откате/сухой проверке
   (`mode="publish"`). Коды: LOCALE_MISSING, LOCALE_SCRIPT, LOCALE_NOT_CHECKED, UNKNOWN_REF, REF_MISMATCH, PREREQ_CYCLE,
   NO_CONTROL_ITEMS, STAGES_INVALID, RUBRIC_WEIGHTS, RUBRIC_BANDS, RUBRIC_MISMATCH, SCENARIO_TEST_FAILED, коды графа
   сценария (UNREACHABLE_NODE, DEAD_END, …), END_HAS_TRANSITIONS, RIGHTS_REQUIRED, EXTERNAL_SOURCE_DISABLED,
   TRANSCRIPT_INVALID, MEDIA_TOO_LONG, MEDIA_TOO_SHORT, EMBED_INVALID, AUDIENCE_EMPTY, KIDS_CONTENT,
   COUNT_OUT_OF_RANGE, DUPLICATE_ID, VALUE_REQUIRED, ANSWER_INVALID, LEVEL_RANGE; тексты для чтения (спринт 5) —
   ещё READING_WORDS (60..250 слов), SENTENCE_TOO_LONG (> 30 слов), GLOSSARY_NOT_IN_TEXT, TEXT_TOO_LONG.

Ссылки:
- «вниз» (зависимости: курс → модули → уроки → навыки/сценарий/рубрика, навык → предпосылки, упражнение → медиа) —
  при отправке ключ должен существовать (любая версия), при публикации — быть опубликованным;
- «вверх» (на контейнер: навык/модуль/урок → курс, урок → модуль) — только существование: иначе курс и модули
  нельзя было бы опубликовать (курс ждёт модули, модули — курс).
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Final, Literal

from pydantic import BaseModel, ValidationError

from tilhero_catalog.content import (
    BANDS,
    KEY_FIELDS,
    PAYLOAD_MODELS,
    STAGE_ORDER,
    Localized,
)
from tilhero_catalog.domain.scenario_test import run_test
from tilhero_catalog.domain.text import contains, form_key, word_count

Mode = Literal["submit", "publish"]
Ref = tuple[str, str]

LOCALES: Final = ("ru", "uz")
_CYRILLIC: Final = re.compile("[Ѐ-ӿ]")
_BAD_OKINA: Final = re.compile("[oOgG]['‘’`]")
_EXTERNAL_ORIGINS: Final = ("licensed", "platform_embed")
_LINK: Final = re.compile(r"(https?://|www\.|\b[a-z0-9-]+\.(com|ru|uz|org|net|io|me)\b)", re.IGNORECASE)
# поля, которые ученик не видит (номер договора и т. п.): ссылки в них детям не показываются
_HIDDEN_FROM_LEARNER: Final = ("payload.rights.license_ref",)
_LICENSES_BY_ORIGIN: Final[dict[str, tuple[str, ...]]] = {
    "own_recording": ("own",),
    "public_domain": ("public_domain", "cc0"),
    "open_license": ("cc0", "cc_by", "cc_by_sa"),
    "licensed": ("contract",),
    "platform_embed": ("contract",),
}
MEDIA_MIN_S, MEDIA_MAX_S = 5, 90
# тексты для чтения (INTERNAL_API §2.1, content.ts ReadingPayload)
READING_WORDS_MIN, READING_WORDS_MAX = 60, 250
SENTENCE_WORDS_MAX = 30
READING_GLOSS_MAX, READING_NOTE_MAX = 80, 160


@dataclass(frozen=True)
class Issue:
    path: str
    code: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {"path": self.path, "code": self.code, "message": self.message}


@dataclass
class RefContext:
    """Что видит проверка: последние версии ключей (любой статус) и опубликованные, пары, аудио, мета версии."""

    mode: Mode
    today: date
    external_sources: bool = False
    existing: dict[Ref, dict[str, Any]] = field(default_factory=dict)
    published: dict[Ref, dict[str, Any]] = field(default_factory=dict)
    pairs: set[str] = field(default_factory=set)
    blobs: set[str] = field(default_factory=set)
    # только mode=publish: мета проверяемой версии
    locale_checks: dict[str, str] | None = None
    rights_approved: bool = False
    test_run_ok: bool = False

    def down(self, kind: str, key: str) -> dict[str, Any] | None:
        """Зависимость: при публикации — только опубликованная версия, при отправке — любая последняя."""
        return (self.published if self.mode == "publish" else self.existing).get((kind, key))

    def up(self, kind: str, key: str) -> dict[str, Any] | None:
        """Контейнер: достаточно существования (последняя версия), иначе — опубликованная."""
        return self.existing.get((kind, key)) or self.published.get((kind, key))


# ---------------------------------------------------------------- ссылки тела (для загрузки контекста)


def refs_of(kind: str, p: dict[str, Any]) -> set[Ref]:
    """Ключи, на которые ссылается тело (вверх и вниз) — их версии загружает слой БД перед проверкой."""
    refs: set[Ref] = set()

    def add(k: str, key: Any) -> None:
        if isinstance(key, str) and key:
            refs.add((k, key))

    if kind == "course":
        for m in p.get("module_ids") or []:
            add("module", m)
    elif kind == "skill":
        add("course", p.get("course_id"))
        add("rubric", p.get("rubric_id"))
        for s in p.get("prerequisites") or []:
            add("skill", s)
    elif kind == "module":
        add("course", p.get("course_id"))
        for les in p.get("lesson_ids") or []:
            add("lesson", les)
    elif kind == "lesson":
        add("course", p.get("course_id"))
        add("module", p.get("module_id"))
        add("scenario", p.get("scenario_id"))
        add("rubric", p.get("rubric_id"))
        for s in [p.get("primary_skill_id"), *(p.get("secondary_skill_ids") or []),
                  *(p.get("prerequisite_skill_ids") or [])]:
            add("skill", s)
        for item in p.get("control_items") or []:
            if isinstance(item, dict):
                add("skill", item.get("skill_id"))
    elif kind == "scenario":
        add("rubric", p.get("rubric_id"))
        for s in p.get("skill_ids") or []:
            add("skill", s)
    elif kind == "media_asset":
        for s in p.get("skill_ids") or []:
            add("skill", s)
    elif kind == "media_exercise":
        add("media_asset", p.get("asset_id"))
        add("skill", p.get("skill_id"))
        add("rubric", p.get("rubric_id"))
    elif kind == "reading":
        for s in p.get("skill_ids") or []:
            add("skill", s)
    return refs


DOWN_REFS: Final[dict[str, tuple[str, ...]]] = {
    "course": ("module",),
    "module": ("lesson",),
    "lesson": ("skill", "scenario", "rubric"),
    "skill": ("skill", "rubric"),
    "scenario": ("skill", "rubric"),
    "media_asset": ("skill",),
    "media_exercise": ("media_asset", "skill", "rubric"),
    "reading": ("skill",),
}


def down_refs_of(kind: str, p: dict[str, Any]) -> set[Ref]:
    """Только зависимости (без контейнеров): по ним считается CONTENT_IN_USE при снятии с публикации."""
    allowed = DOWN_REFS.get(kind, ())
    return {r for r in refs_of(kind, p) if r[0] in allowed}


# ---------------------------------------------------------------- схема


def _loc_path(loc: tuple[Any, ...]) -> str:
    out = "payload"
    for part in loc:
        out += f"[{part}]" if isinstance(part, int) else f".{part}"
    return out


def parse_schema(kind: str, payload: Any) -> tuple[BaseModel | None, list[Issue]]:
    model = PAYLOAD_MODELS[kind]
    try:
        return model.model_validate(payload), []
    except ValidationError as exc:
        issues = [Issue(_loc_path(tuple(e["loc"])), "SCHEMA_INVALID", str(e["msg"]))
                  for e in exc.errors()[:50]]
        return None, issues


def normalized(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json")


# ---------------------------------------------------------------- локализации


def _walk_localized(value: Any, path: str) -> Iterator[tuple[str, Localized]]:
    if isinstance(value, Localized):
        yield path, value
    elif isinstance(value, BaseModel):
        for name in type(value).model_fields:
            yield from _walk_localized(getattr(value, name), f"{path}.{name}")
    elif isinstance(value, list):
        for i, item in enumerate(value):
            yield from _walk_localized(item, f"{path}[{i}]")
    elif isinstance(value, dict):
        for k, item in value.items():
            yield from _walk_localized(item, f"{path}.{k}")


def locale_issues(model: BaseModel) -> list[Issue]:
    issues: list[Issue] = []
    for path, loc in _walk_localized(model, "payload"):
        for lang in LOCALES:
            text = getattr(loc, lang)
            if not text.strip():
                issues.append(Issue(f"{path}.{lang}", "LOCALE_MISSING", f"Пустой текст на {lang.upper()}"))
        if _CYRILLIC.search(loc.uz):
            issues.append(Issue(f"{path}.uz", "LOCALE_SCRIPT", "Узбекский текст — только латиницей"))
        elif _BAD_OKINA.search(loc.uz):
            issues.append(Issue(f"{path}.uz", "LOCALE_SCRIPT", "oʻ и gʻ пишутся с ʻ (U+02BB), а не с апострофом"))
    return issues


def locale_state(model: BaseModel) -> dict[str, str]:
    """Отметки локализаций черновика: missing — есть пустой текст на языке, иначе draft (ждёт проверки)."""
    state = {lang: "draft" for lang in LOCALES}
    for _, loc in _walk_localized(model, "payload"):
        for lang in LOCALES:
            if not getattr(loc, lang).strip():
                state[lang] = "missing"
    return state


# ---------------------------------------------------------------- правила по видам


class _Checker:
    def __init__(self, kind: str, p: dict[str, Any], ctx: RefContext) -> None:
        self.kind = kind
        self.p = p
        self.ctx = ctx
        self.issues: list[Issue] = []

    def add(self, path: str, code: str, message: str) -> None:
        self.issues.append(Issue(path, code, message))

    def count(self, path: str, items: list[Any], lo: int, hi: int | None, what: str) -> None:
        n = len(items)
        if n < lo or (hi is not None and n > hi):
            rng = f"{lo}..{hi}" if hi is not None else f"не меньше {lo}"
            self.add(path, "COUNT_OUT_OF_RANGE", f"{what}: {n}, нужно {rng}")

    def unique(self, path: str, values: list[Any], what: str) -> None:
        seen: set[Any] = set()
        for i, v in enumerate(values):
            if v in seen:
                self.add(f"{path}[{i}]", "DUPLICATE_ID", f"{what} «{v}» повторяется")
            seen.add(v)

    def required(self, path: str, value: str | None, what: str) -> None:
        if value is None or not value.strip():
            self.add(path, "VALUE_REQUIRED", f"Заполните: {what}")

    def ref_down(self, path: str, kind: str, key: str | None) -> dict[str, Any] | None:
        if key is None:
            return None
        found = self.ctx.down(kind, key)
        if found is None:
            state = "не опубликован" if self.ctx.mode == "publish" else "не существует"
            self.add(path, "UNKNOWN_REF", f"{kind} «{key}» {state}")
        return found

    def ref_up(self, path: str, kind: str, key: str) -> dict[str, Any] | None:
        found = self.ctx.up(kind, key)
        if found is None:
            self.add(path, "UNKNOWN_REF", f"{kind} «{key}» не существует")
        return found

    def audience(self) -> None:
        if not self.p.get("audience"):
            self.add("payload.audience", "AUDIENCE_EMPTY", "Укажите аудиторию: kids, teens или adults")

    def rubric_for(self, path: str, rubric_id: str | None, target: str) -> None:
        rubric = self.ref_down(path, "rubric", rubric_id)
        if rubric is not None and target not in (rubric.get("applies_to") or []):
            self.add(path, "RUBRIC_MISMATCH", f"Рубрика «{rubric_id}» не применяется к {target}")

    def skill_in_course(self, path: str, skill_id: str, course_id: str) -> None:
        skill = self.ref_down(path, "skill", skill_id)
        if skill is not None and skill.get("course_id") != course_id:
            self.add(path, "REF_MISMATCH", f"Навык «{skill_id}» из другого курса")

    # -------------------------------------------------------------- виды

    def course(self) -> None:
        p = self.p
        self.count("payload.module_ids", p["module_ids"], 1, None, "Модулей")
        self.unique("payload.module_ids", p["module_ids"], "Модуль")
        if BANDS.index(p["level_start"]) > BANDS.index(p["level_end"]):
            self.add("payload.level_end", "LEVEL_RANGE", "Конечный уровень ниже начального")
        if p["pair_id"] not in self.ctx.pairs:
            self.add("payload.pair_id", "UNKNOWN_REF", f"Языковая пара «{p['pair_id']}» не существует")
        for i, module_id in enumerate(p["module_ids"]):
            module = self.ref_down(f"payload.module_ids[{i}]", "module", module_id)
            if module is not None and module.get("course_id") != p["course_id"]:
                self.add(f"payload.module_ids[{i}]", "REF_MISMATCH", f"Модуль «{module_id}» из другого курса")

    def skill(self) -> None:
        p = self.p
        self.ref_up("payload.course_id", "course", p["course_id"])
        self.unique("payload.prerequisites", p["prerequisites"], "Предпосылка")
        for i, pre in enumerate(p["prerequisites"]):
            path = f"payload.prerequisites[{i}]"
            if pre == p["skill_id"]:
                self.add(path, "PREREQ_CYCLE", "Навык не может быть предпосылкой самого себя")
                continue
            self.skill_in_course(path, pre, p["course_id"])
        if p["rubric_id"] is not None:
            self.ref_down("payload.rubric_id", "rubric", p["rubric_id"])
        self.unique("payload.diagnostic_tags", p["diagnostic_tags"], "Тег")
        cycle = self._prereq_cycle()
        if cycle:
            self.add("payload.prerequisites", "PREREQ_CYCLE", "Цикл предпосылок: " + " → ".join(cycle))

    def _prereq_cycle(self) -> list[str] | None:
        source = self.ctx.published if self.ctx.mode == "publish" else self.ctx.existing
        graph: dict[str, list[str]] = {
            key: [str(x) for x in payload.get("prerequisites") or []]
            for (kind, key), payload in source.items() if kind == "skill"
        }
        me = self.p["skill_id"]
        graph[me] = [x for x in self.p["prerequisites"] if x != me]
        # путь от предпосылок обратно к себе
        stack: list[tuple[str, list[str]]] = [(x, [me, x]) for x in graph[me]]
        seen: set[str] = set()
        while stack:
            node, path = stack.pop()
            if node == me:
                return path
            if node in seen:
                continue
            seen.add(node)
            for nxt in graph.get(node, []):
                stack.append((nxt, [*path, nxt]))
        return None

    def module(self) -> None:
        p = self.p
        self.ref_up("payload.course_id", "course", p["course_id"])
        self.count("payload.lesson_ids", p["lesson_ids"], 1, None, "Уроков")
        self.unique("payload.lesson_ids", p["lesson_ids"], "Урок")
        for i, lesson_id in enumerate(p["lesson_ids"]):
            lesson = self.ref_down(f"payload.lesson_ids[{i}]", "lesson", lesson_id)
            if lesson is not None and (lesson.get("module_id") != p["module_id"]
                                       or lesson.get("course_id") != p["course_id"]):
                self.add(f"payload.lesson_ids[{i}]", "REF_MISMATCH",
                         f"Урок «{lesson_id}» относится к другому модулю или курсу")

    def lesson(self) -> None:
        p = self.p
        course_id = p["course_id"]
        self.ref_up("payload.course_id", "course", course_id)
        module = self.ref_up("payload.module_id", "module", p["module_id"])
        if module is not None and module.get("course_id") != course_id:
            self.add("payload.module_id", "REF_MISMATCH", "Модуль из другого курса")
        self.audience()
        self.skill_in_course("payload.primary_skill_id", p["primary_skill_id"], course_id)
        self.count("payload.secondary_skill_ids", p["secondary_skill_ids"], 0, 3, "Дополнительных навыков")
        self.unique("payload.secondary_skill_ids", p["secondary_skill_ids"], "Навык")
        for i, s in enumerate(p["secondary_skill_ids"]):
            if s == p["primary_skill_id"]:
                self.add(f"payload.secondary_skill_ids[{i}]", "DUPLICATE_ID", "Основной навык не дублируется")
            else:
                self.skill_in_course(f"payload.secondary_skill_ids[{i}]", s, course_id)
        self.unique("payload.prerequisite_skill_ids", p["prerequisite_skill_ids"], "Навык")
        for i, s in enumerate(p["prerequisite_skill_ids"]):
            self.skill_in_course(f"payload.prerequisite_skill_ids[{i}]", s, course_id)
        self._stages()
        self.count("payload.key_words", p["key_words"], 4, 12, "Опорных слов")
        for i, kw in enumerate(p["key_words"]):
            self.required(f"payload.key_words[{i}].en", kw["en"], "слово (EN)")
            self.required(f"payload.key_words[{i}].example_en", kw["example_en"], "пример (EN)")
        self.count("payload.examples", p["examples"], 2, 8, "Примеров")
        for i, ex in enumerate(p["examples"]):
            self.required(f"payload.examples[{i}].en", ex["en"], "пример (EN)")
        self.count("payload.hints", p["hints"], 0, 5, "Подсказок")
        if p["scenario_id"] is not None:
            scenario = self.ref_down("payload.scenario_id", "scenario", p["scenario_id"])
            if scenario is not None and "kids" in p["audience"] and "kids" not in (scenario.get("audience") or []):
                self.add("payload.scenario_id", "KIDS_CONTENT",
                         f"Урок для детей ссылается на недетский сценарий «{p['scenario_id']}»")
        self.rubric_for("payload.rubric_id", p["rubric_id"], "lesson")
        self._control_items()

    def _stages(self) -> None:
        p = self.p
        stages = p["stages"]
        types = [s["type"] for s in stages]
        if types != list(STAGE_ORDER):
            self.add("payload.stages", "STAGES_INVALID",
                     "Этапы — все пять по одному в порядке: " + " → ".join(STAGE_ORDER))
        for i, s in enumerate(stages):
            if not 1 <= s["minutes"] <= 10:
                self.add(f"payload.stages[{i}].minutes", "STAGES_INVALID", "Этап — от 1 до 10 минут")
        total = sum(s["minutes"] for s in stages)
        if total != p["duration_min"]:
            self.add("payload.stages", "STAGES_INVALID",
                     f"Сумма минут этапов {total} ≠ длительности урока {p['duration_min']}")

    def _control_items(self) -> None:
        p = self.p
        items = p["control_items"]
        if len(items) < 3:
            self.add("payload.control_items", "NO_CONTROL_ITEMS",
                     f"Контрольных заданий {len(items)} — нужно не меньше 3")
        self.unique("payload.control_items", [it["item_id"] for it in items], "Задание")
        for i, it in enumerate(items):
            path = f"payload.control_items[{i}]"
            self.skill_in_course(f"{path}.skill_id", it["skill_id"], p["course_id"])
            self.required(f"{path}.prompt_en", it["prompt_en"], "текст задания (EN)")
            options, answer, kind = it["options"], it["answer"], it["type"]
            if kind in ("single_choice", "translate_choice"):
                if len(options) < 2:
                    self.add(f"{path}.options", "ANSWER_INVALID", "Нужно не меньше двух вариантов")
                if not isinstance(answer, int) or answer >= max(len(options), 1):
                    self.add(f"{path}.answer", "ANSWER_INVALID", "Ответ — индекс одного из вариантов")
            elif kind == "gap_fill":
                if not isinstance(answer, list) or not answer or any(not a.strip() for a in answer):
                    self.add(f"{path}.answer", "ANSWER_INVALID", "Укажите допустимые ответы")
            elif kind == "order_words":
                # R1-13: варианты — слова для порядка (ученику показываются перемешанными); не пусто и не в порядке
                # ответа, иначе задание решается без знаний
                if not isinstance(answer, list) or len(answer) < 2:
                    self.add(f"{path}.answer", "ANSWER_INVALID", "Ответ — слова в правильном порядке")
                elif not options:
                    self.add(f"{path}.options", "ANSWER_INVALID", "Укажите слова для порядка")
                elif sorted(options) != sorted(answer):
                    self.add(f"{path}.answer", "ANSWER_INVALID", "Порядок слов должен состоять из слов вариантов")
                elif list(options) == list(answer):
                    self.add(f"{path}.options", "ANSWER_INVALID",
                             "Слова в вариантах стоят в порядке ответа — перемешайте их")

    def rubric(self) -> None:
        p = self.p
        self.count("payload.applies_to", p["applies_to"], 1, None, "Областей применения")
        self.unique("payload.applies_to", p["applies_to"], "Область")
        criteria = p["criteria"]
        self.count("payload.criteria", criteria, 2, None, "Критериев")
        self.unique("payload.criteria", [c["code"] for c in criteria], "Критерий")
        weights = [c["weight"] for c in criteria]
        for i, w in enumerate(weights):
            if not 0 < w <= 1:
                self.add(f"payload.criteria[{i}].weight", "RUBRIC_WEIGHTS", "Вес критерия — больше 0 и не больше 1")
        if abs(sum(weights) - 1) > 1e-6:
            self.add("payload.criteria", "RUBRIC_WEIGHTS", f"Сумма весов {round(sum(weights), 4)} ≠ 1")
        for i, c in enumerate(criteria):
            if [b["score"] for b in c["bands"]] != [0, 1, 2, 3]:
                self.add(f"payload.criteria[{i}].bands", "RUBRIC_BANDS",
                         "Нужны все четыре балла 0, 1, 2, 3 по возрастанию")

    def scenario(self) -> None:
        p = self.p
        self.audience()
        self.count("payload.characters", p["characters"], 1, None, "Персонажей")
        self.unique("payload.characters", [c["id"] for c in p["characters"]], "Персонаж")
        self.count("payload.nodes", list(p["nodes"]), 5, 30, "Узлов")
        for node_id, node in p["nodes"].items():
            path = f"payload.nodes.{node_id}"
            self.required(f"{path}.line_en", node["line_en"], "реплика (EN)")
            if node["end"] is not None and node["transitions"]:
                self.add(f"{path}.transitions", "END_HAS_TRANSITIONS", "У конечного узла не бывает переходов")
            for i, t in enumerate(node["transitions"]):
                self.count(f"{path}.transitions[{i}].examples_en", t["examples_en"], 1, 4, "Образцов реплик")
                for j, ex in enumerate(t["examples_en"]):
                    self.required(f"{path}.transitions[{i}].examples_en[{j}]", ex, "образец реплики (EN)")
        run = run_test(p, "")
        for item in run["issues"]:
            node_id = item["node_id"]
            path = f"payload.nodes.{node_id}" if node_id else (
                "payload.start_node" if item["code"] == "START_MISSING" else "payload.nodes")
            self.add(path, str(item["code"]), str(item["detail"]))
        for i, s in enumerate(p["skill_ids"]):
            self.ref_down(f"payload.skill_ids[{i}]", "skill", s)
        self.rubric_for("payload.rubric_id", p["rubric_id"], "scenario")
        if self.ctx.mode == "publish" and not self.ctx.test_run_ok:
            self.add("test_run", "SCENARIO_TEST_FAILED",
                     "Нужен успешный тестовый прогон этой версии (после последней правки)")

    def media_asset(self) -> None:
        p = self.p
        self.audience()
        dur = p["duration_s"]
        if dur > MEDIA_MAX_S:
            self.add("payload.duration_s", "MEDIA_TOO_LONG", f"Фрагмент {dur} с — допустимо не больше {MEDIA_MAX_S}")
        elif dur < MEDIA_MIN_S:
            self.add("payload.duration_s", "MEDIA_TOO_SHORT", f"Фрагмент {dur} с — нужно не меньше {MEDIA_MIN_S}")
        self._transcript(dur * 1000)
        if not self.ctx.external_sources and (p["origin"] in _EXTERNAL_ORIGINS or p["embed"] is not None):
            self.add("payload.origin", "EXTERNAL_SOURCE_DISABLED",
                     "Лицензированные материалы и встраивание платформ закрыты флагом media.external_sources")
        embed = p["embed"]
        if embed is not None:
            if p["origin"] != "platform_embed":
                self.add("payload.embed", "EMBED_INVALID", "Встраивание — только для origin platform_embed")
            span = embed["end_s"] - embed["start_s"]
            if span <= 0 or span > MEDIA_MAX_S:
                self.add("payload.embed", "EMBED_INVALID", f"Фрагмент встраивания — от 1 до {MEDIA_MAX_S} с")
        if p["audio_blob_id"] is not None and p["audio_blob_id"] not in self.ctx.blobs:
            self.add("payload.audio_blob_id", "UNKNOWN_REF", "Аудиофайл не найден — загрузите его заново")
        for i, s in enumerate(p["skill_ids"]):
            self.ref_down(f"payload.skill_ids[{i}]", "skill", s)
        self._rights()

    def _transcript(self, limit_ms: int) -> None:
        lines = self.p["transcript"]
        if not lines:
            self.add("payload.transcript", "TRANSCRIPT_INVALID", "Нужна хотя бы одна строка транскрипта")
        prev_end = -1
        for i, line in enumerate(lines):
            path = f"payload.transcript[{i}]"
            if line["t_start_ms"] >= line["t_end_ms"]:
                self.add(path, "TRANSCRIPT_INVALID", "Начало строки должно быть раньше конца")
            if line["t_end_ms"] > limit_ms:
                self.add(path, "TRANSCRIPT_INVALID", "Строка выходит за длительность фрагмента")
            if line["t_start_ms"] < prev_end:
                self.add(path, "TRANSCRIPT_INVALID", "Строки идут по времени и не перекрываются")
            prev_end = max(prev_end, line["t_end_ms"])
            if not line["text_en"].strip() or not line["speaker"].strip():
                self.add(path, "TRANSCRIPT_INVALID", "Нужны говорящий и текст строки")
        for i, ph in enumerate(self.p["phrases"]):
            self.required(f"payload.phrases[{i}].en", ph["en"], "фраза (EN)")
            if ph["t_ms"] > limit_ms:
                self.add(f"payload.phrases[{i}].t_ms", "TRANSCRIPT_INVALID", "Фраза за пределами фрагмента")

    def _rights(self) -> None:
        r = self.p["rights"]

        def need(path: str, message: str) -> None:
            self.add(f"payload.rights.{path}", "RIGHTS_REQUIRED", message)

        if not r["owner"].strip():
            need("owner", "Укажите правообладателя")
        if r["license_type"] not in _LICENSES_BY_ORIGIN[self.p["origin"]]:
            need("license_type", f"Лицензия {r['license_type']} не подходит для источника {self.p['origin']}")
        if r["license_type"] in ("cc_by", "cc_by_sa") and not (r["attribution"] or "").strip():
            need("attribution", "Для CC BY нужна атрибуция — она показывается ученику")
        if r["license_type"] == "contract" and not (r["license_ref"] or "").strip():
            need("license_ref", "Укажите номер договора или ссылку на лицензию")
        if "UZ" not in r["territories"]:
            need("territories", "Права должны действовать в Узбекистане (UZ)")
        if not r["allowed_uses"]:
            need("allowed_uses", "Укажите разрешённые действия")
        valid_from = date.fromisoformat(r["valid_from"])
        if r["valid_to"] is not None:
            valid_to = date.fromisoformat(r["valid_to"])
            if valid_to < valid_from:
                need("valid_to", "Срок окончания раньше начала")
            elif valid_to < self.ctx.today:
                need("valid_to", "Срок прав истёк")
        if self.ctx.mode == "publish" and not self.ctx.rights_approved:
            self.add("rights_approved", "RIGHTS_REQUIRED", "Права не подтверждены (media.rights)")

    def media_exercise(self) -> None:
        p = self.p
        asset = self.ref_down("payload.asset_id", "media_asset", p["asset_id"])
        if asset is not None and "exercises" not in ((asset.get("rights") or {}).get("allowed_uses") or []):
            self.add("payload.asset_id", "RIGHTS_REQUIRED", "Лицензия материала не разрешает упражнения")
        self.ref_down("payload.skill_id", "skill", p["skill_id"])
        if p["rubric_id"] is not None:
            self.rubric_for("payload.rubric_id", p["rubric_id"], "media_exercise")
        kind, options, answer = p["type"], p["options"], p["answer"]
        if kind in ("comprehension", "phrase_meaning"):
            self.required("payload.prompt_en", p["prompt_en"], "вопрос (EN)")
            if len(options) < 2:
                self.add("payload.options", "ANSWER_INVALID", "Нужно не меньше двух вариантов")
            if not isinstance(answer, int) or answer >= max(len(options), 1):
                self.add("payload.answer", "ANSWER_INVALID", "Ответ — индекс одного из вариантов")
        elif kind == "gap_fill":
            if "___" not in (p["prompt_en"] or ""):
                self.add("payload.prompt_en", "ANSWER_INVALID", "Строка с пропуском ___")
            if not isinstance(answer, list) or not answer or not all(isinstance(a, str) and a.strip()
                                                                    for a in answer):
                self.add("payload.answer", "ANSWER_INVALID", "Укажите допустимые ответы")
        elif kind == "order_lines":
            self._order_lines(options, answer, asset)
        elif kind == "shadowing":
            if p["line_index"] is None:
                self.add("payload.line_index", "ANSWER_INVALID", "Укажите строку транскрипта")
            if answer is not None:
                self.add("payload.answer", "ANSWER_INVALID", "У повторения за диктором нет ответа")
        elif kind == "roleplay" and answer is not None:
            self.add("payload.answer", "ANSWER_INVALID", "У ролевой игры нет ответа — цель в инструкции")
        # line_index — реплика-источник (shadowing — обязательно; gap_fill и другие — чтобы плеер её проиграл)
        if p["line_index"] is not None and asset is not None and p["line_index"] >= len(asset.get("transcript") or []):
            self.add("payload.line_index", "ANSWER_INVALID", "Строки с таким номером нет в транскрипте")

    def _order_lines(self, options: list[str], answer: Any, asset: dict[str, Any] | None) -> None:
        """options — перемешанные реплики транскрипта, answer — индексы options в правильном порядке. Реплики в порядке
        ответа (answer = 0, 1, 2, …) — задание решается без знаний (R1-13)."""
        if len(options) < 2:
            self.add("payload.options", "ANSWER_INVALID", "Нужно не меньше двух реплик")
        if not isinstance(answer, list) or len(answer) != len(options) or sorted(
                a for a in answer if isinstance(a, int)) != list(range(len(options))):
            self.add("payload.answer", "ANSWER_INVALID", "Ответ — правильный порядок индексов реплик")
            return
        if len(options) >= 2 and list(answer) == list(range(len(options))):
            self.add("payload.options", "ANSWER_INVALID", "Реплики в вариантах стоят в порядке ответа — перемешайте их")
        if asset is None:
            return
        lines = [str(t.get("text_en")) for t in asset.get("transcript") or []]
        if any(o not in lines for o in options):
            self.add("payload.options", "ANSWER_INVALID", "Реплики берутся из транскрипта материала")
            return
        positions = [lines.index(options[a]) for a in answer]
        if positions != sorted(positions):
            self.add("payload.answer", "ANSWER_INVALID", "Порядок ответа не совпадает с порядком реплик транскрипта")

    # -------------------------------------------------------------- спринт 5: текст для чтения

    def reading(self) -> None:
        p = self.p
        self.audience()
        if "kids" in p["audience"] and p["audience"] != ["kids"]:
            self.add("payload.audience", "KIDS_CONTENT", "Детский текст — только для аудитории kids")
        self.count("payload.skill_ids", p["skill_ids"], 0, 3, "Навыков")
        self.unique("payload.skill_ids", p["skill_ids"], "Навык")
        for i, s in enumerate(p["skill_ids"]):
            self.ref_down(f"payload.skill_ids[{i}]", "skill", s)
        if not 3 <= p["est_minutes"] <= 15:
            self.add("payload.est_minutes", "COUNT_OUT_OF_RANGE", f"Минут: {p['est_minutes']}, нужно 3..15")
        self._reading_text()
        self._reading_glossary()
        self._reading_questions()

    def _reading_text(self) -> None:
        paragraphs = self.p["paragraphs"]
        self.count("payload.paragraphs", paragraphs, 1, 8, "Абзацев")
        self.unique("payload.paragraphs", [para["p_id"] for para in paragraphs], "Абзац")
        seen: set[str] = set()
        total = 0
        for i, para in enumerate(paragraphs):
            path = f"payload.paragraphs[{i}]"
            self.count(f"{path}.sentences", para["sentences"], 1, 8, "Предложений в абзаце")
            for j, sentence in enumerate(para["sentences"]):
                s_path = f"{path}.sentences[{j}]"
                if sentence["s_id"] in seen:
                    self.add(f"{s_path}.s_id", "DUPLICATE_ID", f"Предложение «{sentence['s_id']}» повторяется")
                seen.add(sentence["s_id"])
                self.required(f"{s_path}.text_en", sentence["text_en"], "предложение (EN)")
                words = word_count(sentence["text_en"])
                total += words
                if words > SENTENCE_WORDS_MAX:
                    self.add(f"{s_path}.text_en", "SENTENCE_TOO_LONG",
                             f"В предложении {words} слов — не больше {SENTENCE_WORDS_MAX}")
        if not READING_WORDS_MIN <= total <= READING_WORDS_MAX:
            self.add("payload.paragraphs", "READING_WORDS",
                     f"В тексте {total} слов — нужно {READING_WORDS_MIN}..{READING_WORDS_MAX}")

    def _reading_glossary(self) -> None:
        glossary = self.p["glossary"]
        self.count("payload.glossary", glossary, 3, 20, "Слов глоссария")
        sentences = [s["text_en"] for para in self.p["paragraphs"] for s in para["sentences"]]
        keys: set[str] = set()
        for i, item in enumerate(glossary):
            path = f"payload.glossary[{i}]"
            self.required(f"{path}.en", item["en"], "слово или выражение (EN)")
            key = form_key(item["en"])
            if key and key in keys:
                self.add(f"{path}.en", "DUPLICATE_ID", f"Слово «{item['en']}» повторяется в глоссарии")
            keys.add(key)
            if key and not any(contains(text, item["en"]) for text in sentences):
                self.add(f"{path}.en", "GLOSSARY_NOT_IN_TEXT", f"«{item['en']}» не встречается в тексте")
            for lang in LOCALES:
                if len(item["gloss"][lang]) > READING_GLOSS_MAX:
                    self.add(f"{path}.gloss.{lang}", "TEXT_TOO_LONG", f"Перевод — до {READING_GLOSS_MAX} знаков")
                if item["note"] is not None and len(item["note"][lang]) > READING_NOTE_MAX:
                    self.add(f"{path}.note.{lang}", "TEXT_TOO_LONG", f"Пояснение — до {READING_NOTE_MAX} знаков")

    def _reading_questions(self) -> None:
        questions = self.p["questions"]
        self.count("payload.questions", questions, 3, 8, "Вопросов")
        self.unique("payload.questions", [q["question_id"] for q in questions], "Вопрос")
        for i, q in enumerate(questions):
            path = f"payload.questions[{i}]"
            self.required(f"{path}.prompt_en", q["prompt_en"], "вопрос (EN)")
            options, answer, kind = q["options"], q["answer"], q["type"]
            if kind == "single_choice":
                if not 3 <= len(options) <= 4:
                    self.add(f"{path}.options", "ANSWER_INVALID", "У вопроса с выбором 3–4 варианта")
                if any(not o.strip() for o in options) or len(set(options)) != len(options):
                    self.add(f"{path}.options", "ANSWER_INVALID", "Варианты непустые и не повторяются")
                if not isinstance(answer, int) or answer >= max(len(options), 1):
                    self.add(f"{path}.answer", "ANSWER_INVALID", "Ответ — индекс одного из вариантов")
            elif kind == "true_false":
                if options != ["True", "False"]:
                    self.add(f"{path}.options", "ANSWER_INVALID", "Варианты «верно / неверно» — [\"True\", \"False\"]")
                if not isinstance(answer, int) or answer > 1:
                    self.add(f"{path}.answer", "ANSWER_INVALID", "Ответ — 0 (True) или 1 (False)")
            elif kind == "gap_fill":
                if options:
                    self.add(f"{path}.options", "ANSWER_INVALID", "У вопроса с пропуском нет вариантов")
                if not isinstance(answer, list) or not answer or any(not a.strip() for a in answer):
                    self.add(f"{path}.answer", "ANSWER_INVALID", "Укажите допустимые ответы")


def _strings(value: Any, path: str) -> Iterator[tuple[str, str]]:
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        for k, item in value.items():
            yield from _strings(item, f"{path}.{k}")
    elif isinstance(value, list):
        for i, item in enumerate(value):
            yield from _strings(item, f"{path}[{i}]")


def kids_issues(kind: str, p: dict[str, Any]) -> list[Issue]:
    """Детский контент (audience ∋ kids, CONVENTIONS §8): без внешних ссылок в текстах ученику и без встраивания."""
    if "kids" not in (p.get("audience") or []):
        return []
    out = [Issue(path, "KIDS_CONTENT", "В детском контенте не бывает внешних ссылок")
           for path, text in _strings(p, "payload")
           if path not in _HIDDEN_FROM_LEARNER and _LINK.search(text)]
    if kind == "media_asset" and p.get("embed") is not None:
        out.append(Issue("payload.embed", "KIDS_CONTENT", "Детям — только собственные материалы, без встраивания"))
    return out


def validate(kind: str, payload: dict[str, Any], ctx: RefContext) -> list[Issue]:
    """Полная проверка тела: схема → локализации → правила вида → (publish) отметки локализаций."""
    model, issues = parse_schema(kind, payload)
    if model is None:
        return issues
    issues = locale_issues(model)
    body = normalized(model)
    checker = _Checker(kind, body, ctx)
    getattr(checker, kind)()
    issues.extend(checker.issues)
    issues.extend(kids_issues(kind, body))
    if ctx.mode == "publish":
        checks = ctx.locale_checks or {}
        for lang in LOCALES:
            if checks.get(lang) != "checked":
                issues.append(Issue(f"locale_checks.{lang}", "LOCALE_NOT_CHECKED",
                                    f"Локализация {lang.upper()} не проверена"))
    return issues


def key_of(kind: str, payload: dict[str, Any]) -> str | None:
    value = payload.get(KEY_FIELDS[kind]) if isinstance(payload, dict) else None
    return value if isinstance(value, str) else None
