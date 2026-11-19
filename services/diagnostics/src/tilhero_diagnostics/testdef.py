"""Формат теста диагностики (INTERNAL_API §2.1) и его проверка — общая для сида (миграция 0002) и публикации.

Файл теста: `{test_id, version, pair_id, audience, config, items[]}`; задание —
`{item_id, area, band, tags[], skill_ids[], type, instruction{ru,uz}, prompt_en, passage_en|null,
audio_text_en|null, options[], answer: index | string[]}`. Ключ ответа (`answer`) ученику не отдаётся никогда.

Ошибки проверки — список `{path, code, message}` (как ContentValidationError админки); любая ошибка — тест
не публикуется, миграция сида падает.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

BANDS: tuple[str, ...] = ("A0", "A1", "A2", "B1", "B2")
TEST_AREAS: tuple[str, ...] = ("vocabulary", "grammar", "reading", "listening")
ALL_AREAS: tuple[str, ...] = (*TEST_AREAS, "speaking", "writing")
AUDIENCES = ("adults", "kids")
CHOICE_TYPES = frozenset({"single_choice", "gap_choice", "read_choice", "listen_choice"})
ITEM_TYPES = frozenset({*CHOICE_TYPES, "order_words"})
CONFIG_KEYS = frozenset({"areas", "items_per_area", "start_band", "min_items_assessed", "followup_items",
                         "retest_days", "time_limit_min"})
# необязательные поля config (значение по умолчанию — при разборе; в БД хранится config как в файле)
CONFIG_OPTIONAL = {"min_correct_per_band": 2}
ITEM_KEYS = frozenset({"item_id", "area", "band", "tags", "skill_ids", "type", "instruction", "prompt_en",
                       "passage_en", "audio_text_en", "options", "answer"})

ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
REF_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
PAIR_RE = re.compile(r"^[a-z]{2,3}-[a-z]{2,3}$")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_CYRILLIC_RE = re.compile(r"[Ѐ-ӿ]")
# внешние ссылки запрещены в любом тексте задания (дети — CONVENTIONS §8; взрослым тест тоже без ссылок)
_LINK_RE = re.compile(r"(?i)(https?://|www\.|t\.me/|\b[a-z0-9-]+\.(com|ru|uz|org|net|io)\b)")
# детский тест — без давления: ни спешки, ни «провала» (CONVENTIONS §8, AT-38)
_KIDS_PRESSURE = ("быстрее", "скорее", "поторопись", "провал", "не успе", "время вышло", "ошибся", "ошиблась",
                  "tezroq", "shoshil", "vaqt tugadi", "muvaffaqiyatsiz", "xato qilding")

MAX_PASSAGE = 600
MAX_AUDIO_TEXT = 300
MAX_PROMPT = 300
MAX_INSTRUCTION = 300
MAX_OPTION = 120
MAX_ITEMS = 500


class TestInvalid(Exception):
    __test__ = False  # не тестовый класс pytest

    def __init__(self, errors: list[dict[str, str]]) -> None:
        super().__init__(f"diagnostic test invalid: {len(errors)} error(s)")
        self.errors = errors


@dataclass(frozen=True)
class Item:
    item_id: str
    area: str
    band: str
    tags: tuple[str, ...]
    skill_ids: tuple[str, ...]
    type: str
    instruction: Mapping[str, str]
    prompt_en: str
    passage_en: str | None
    audio_text_en: str | None
    options: tuple[str, ...]
    answer: int | tuple[str, ...]

    @property
    def band_index(self) -> int:
        return BANDS.index(self.band)

    def is_correct(self, answer: int | Sequence[str] | None) -> bool:
        if answer is None:
            return False
        if isinstance(self.answer, int):
            return isinstance(answer, int) and not isinstance(answer, bool) and answer == self.answer
        return not isinstance(answer, int) and tuple(answer) == self.answer

    def answer_shape_ok(self, answer: int | Sequence[str]) -> bool:
        """Форма ответа ученика: индекс варианта или все слова вариантов по одному разу (порядок слов)."""
        if self.type == "order_words":
            return not isinstance(answer, int) and sorted(answer) == sorted(self.options)
        return isinstance(answer, int) and not isinstance(answer, bool) and 0 <= answer < len(self.options)

    def public(self, position: int) -> dict[str, Any]:
        """DiagnosticItem (bff.ts) — без ключа ответа, тегов и полосы."""
        return {
            "item_id": self.item_id,
            "area": self.area,
            "type": self.type,
            "instruction": {"ru": self.instruction["ru"], "uz": self.instruction["uz"]},
            "prompt_en": self.prompt_en,
            "passage_en": self.passage_en,
            "audio_text_en": self.audio_text_en,
            "options": list(self.options),
            "position": position,
        }


@dataclass(frozen=True)
class TestConfig:
    __test__ = False
    areas: tuple[str, ...]
    items_per_area: int
    start_band: str
    min_items_assessed: int
    followup_items: int
    retest_days: int
    time_limit_min: int
    # верных ответов внутри полосы, нужных для её зачёта (взрослые 2, дети 1 — §2.3)
    min_correct_per_band: int = 2

    @property
    def total_estimate(self) -> int:
        return self.items_per_area * len(self.areas)


@dataclass(frozen=True)
class TestDef:
    __test__ = False
    test_id: str
    version: int
    pair_id: str
    audience: str
    config: TestConfig
    items: tuple[Item, ...]

    @property
    def ref(self) -> str:
        return f"{self.test_id}@{self.version}"

    def item(self, item_id: str) -> Item | None:
        return self._index.get(item_id)

    @property
    def _index(self) -> dict[str, Item]:
        idx = self.__dict__.get("_idx")
        if idx is None:
            idx = {i.item_id: i for i in self.items}
            object.__setattr__(self, "_idx", idx)
        return idx


def checksum(data: Mapping[str, Any]) -> str:
    canonical = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def coverage(items: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, int]]:
    """area → band → число заданий (DiagnosticTestVersion.coverage)."""
    counts = Counter((str(i.get("area")), str(i.get("band"))) for i in items)
    areas = list(dict.fromkeys([*TEST_AREAS, *(a for a, _ in counts)]))
    return {a: {b: counts.get((a, b), 0) for b in BANDS} for a in areas if any(counts.get((a, b)) for b in BANDS)}


# ---------------------------------------------------------------- проверка


class _Errors:
    def __init__(self) -> None:
        self.items: list[dict[str, str]] = []

    def add(self, path: str, code: str, message: str) -> None:
        if len(self.items) < 200:
            self.items.append({"path": path, "code": code, "message": message})


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _text(errs: _Errors, path: str, value: Any, *, max_len: int, required: bool = True) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip():
        errs.add(path, "TEXT_REQUIRED", "Нужен непустой текст")
        return None
    if len(value) > max_len:
        errs.add(path, "TEXT_TOO_LONG", f"Не длиннее {max_len} символов")
    if _CONTROL_RE.search(value):
        errs.add(path, "TEXT_CONTROL_CHARS", "Управляющие символы запрещены")
    if _LINK_RE.search(value):
        errs.add(path, "EXTERNAL_LINK", "Внешние ссылки в задании запрещены")
    return value


def _int_in(errs: _Errors, path: str, value: Any, lo: int, hi: int) -> int | None:
    if not _is_int(value) or not lo <= value <= hi:
        errs.add(path, "OUT_OF_RANGE", f"Целое от {lo} до {hi}")
        return None
    return int(value)


def _config(errs: _Errors, raw: Any) -> TestConfig | None:
    if not isinstance(raw, dict):
        errs.add("config", "CONFIG_INVALID", "config — объект")
        return None
    for key in sorted(set(raw) - CONFIG_KEYS - set(CONFIG_OPTIONAL)):
        errs.add(f"config.{key}", "UNKNOWN_FIELD", "Неизвестное поле")
    for key in sorted(CONFIG_KEYS - set(raw)):
        errs.add(f"config.{key}", "REQUIRED", "Обязательное поле")
    areas = raw.get("areas")
    ok_areas: tuple[str, ...] = ()
    if (not isinstance(areas, list) or not areas or len(set(map(str, areas))) != len(areas)
            or any(a not in TEST_AREAS for a in areas)):
        errs.add("config.areas", "AREAS_INVALID", "Области — непустой список без повторов из " + ", ".join(TEST_AREAS))
    elif list(areas) != [a for a in TEST_AREAS if a in areas]:
        errs.add("config.areas", "AREAS_ORDER", "Порядок областей — словарь → грамматика → чтение → аудирование")
    else:
        ok_areas = tuple(areas)
    per_area = _int_in(errs, "config.items_per_area", raw.get("items_per_area"), 1, 20)
    start = raw.get("start_band")
    if start not in BANDS:
        errs.add("config.start_band", "BAND_INVALID", "Полоса из A0, A1, A2, B1, B2")
    min_items = _int_in(errs, "config.min_items_assessed", raw.get("min_items_assessed"), 1, per_area or 20)
    followup = _int_in(errs, "config.followup_items", raw.get("followup_items"), 1, 10)
    retest = _int_in(errs, "config.retest_days", raw.get("retest_days"), 1, 365)
    limit = _int_in(errs, "config.time_limit_min", raw.get("time_limit_min"), 5, 60)
    min_correct = _int_in(errs, "config.min_correct_per_band",
                          raw.get("min_correct_per_band", CONFIG_OPTIONAL["min_correct_per_band"]), 1, 5)
    if not ok_areas or None in (per_area, min_items, followup, retest, limit, min_correct) or start not in BANDS:
        return None
    assert per_area and min_items and followup and retest and limit and min_correct
    return TestConfig(ok_areas, per_area, str(start), min_items, followup, retest, limit, min_correct)


def _str_list(errs: _Errors, path: str, value: Any, *, max_items: int) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > max_items or any(
            not isinstance(v, str) or not REF_RE.match(v) for v in value):
        errs.add(path, "REFS_INVALID", f"Список идентификаторов [a-z0-9._-], не больше {max_items}")
        return ()
    return tuple(value)


def _item(errs: _Errors, idx: int, raw: Any, config: TestConfig | None, kids: bool) -> Item | None:
    p = f"items[{idx}]"
    if not isinstance(raw, dict):
        errs.add(p, "ITEM_INVALID", "Задание — объект")
        return None
    before = len(errs.items)
    for field in sorted(set(raw) - ITEM_KEYS):
        errs.add(f"{p}.{field}", "UNKNOWN_FIELD", "Неизвестное поле")
    for field in sorted(ITEM_KEYS - set(raw)):
        errs.add(f"{p}.{field}", "REQUIRED", "Обязательное поле")
    item_id = raw.get("item_id")
    if not isinstance(item_id, str) or not REF_RE.match(item_id):
        errs.add(f"{p}.item_id", "ID_INVALID", "Идентификатор [a-z0-9._-], до 64 символов")
    area, band, typ = raw.get("area"), raw.get("band"), raw.get("type")
    if area not in TEST_AREAS or (config is not None and area not in config.areas):
        errs.add(f"{p}.area", "AREA_INVALID", "Область не из config.areas")
    if band not in BANDS:
        errs.add(f"{p}.band", "BAND_INVALID", "Полоса из A0, A1, A2, B1, B2")
    if typ not in ITEM_TYPES:
        errs.add(f"{p}.type", "TYPE_INVALID", "Тип из " + ", ".join(sorted(ITEM_TYPES)))
    elif (area == "reading") != (typ == "read_choice") or (area == "listening") != (typ == "listen_choice"):
        errs.add(f"{p}.type", "TYPE_AREA_MISMATCH", "Чтение — read_choice, аудирование — listen_choice")
    tags = _str_list(errs, f"{p}.tags", raw.get("tags"), max_items=10)
    skills = _str_list(errs, f"{p}.skill_ids", raw.get("skill_ids"), max_items=10)
    instruction = raw.get("instruction")
    if not isinstance(instruction, dict) or set(instruction) != {"ru", "uz"}:
        errs.add(f"{p}.instruction", "LOCALE_MISSING", "Инструкция — {ru, uz}")
        instruction = {}
    else:
        for loc in ("ru", "uz"):
            _text(errs, f"{p}.instruction.{loc}", instruction.get(loc), max_len=MAX_INSTRUCTION)
        if isinstance(instruction.get("uz"), str) and _CYRILLIC_RE.search(instruction["uz"]):
            errs.add(f"{p}.instruction.uz", "LOCALE_SCRIPT", "Узбекский — латиница")
        if kids:
            text = " ".join(str(v) for v in instruction.values()).lower()
            if any(word in text for word in _KIDS_PRESSURE):
                errs.add(f"{p}.instruction", "KIDS_PRESSURE", "Детский тест — без спешки и слов о провале")
    prompt = _text(errs, f"{p}.prompt_en", raw.get("prompt_en"), max_len=MAX_PROMPT)
    passage = _text(errs, f"{p}.passage_en", raw.get("passage_en"), max_len=MAX_PASSAGE,
                    required=typ == "read_choice")
    if typ != "read_choice" and raw.get("passage_en") is not None:
        errs.add(f"{p}.passage_en", "PASSAGE_UNEXPECTED", "Текст для чтения — только у read_choice")
    audio = _text(errs, f"{p}.audio_text_en", raw.get("audio_text_en"), max_len=MAX_AUDIO_TEXT,
                  required=typ == "listen_choice")
    if typ != "listen_choice" and raw.get("audio_text_en") is not None:
        errs.add(f"{p}.audio_text_en", "AUDIO_UNEXPECTED", "Текст для синтеза речи — только у listen_choice")
    options = raw.get("options")
    # порядок слов: 2–10 слов (слово может повторяться); выбор: 2–6 разных вариантов
    max_options, unique = (10, False) if typ == "order_words" else (6, True)
    if (not isinstance(options, list) or not 2 <= len(options) <= max_options
            or any(not isinstance(o, str) or not o.strip() or len(o) > MAX_OPTION for o in options)
            or (unique and len(set(options)) != len(options))):
        errs.add(f"{p}.options", "OPTIONS_INVALID",
                 f"2–{max_options} непустых вариантов до {MAX_OPTION} символов" + (" без повторов" if unique else ""))
        options = []
    else:
        for j, o in enumerate(options):
            if _CONTROL_RE.search(o) or _LINK_RE.search(o):
                errs.add(f"{p}.options[{j}]", "TEXT_INVALID", "Управляющие символы и ссылки запрещены")
    answer = raw.get("answer")
    key: int | tuple[str, ...] | None = None
    if typ == "order_words":
        if (not isinstance(answer, list) or any(not isinstance(a, str) for a in answer)
                or sorted(answer) != sorted(options)):
            errs.add(f"{p}.answer", "ANSWER_INVALID", "Ключ порядка слов — все варианты по одному разу")
        elif answer == options:
            errs.add(f"{p}.answer", "ANSWER_SHOWN", "Варианты показываются в порядке ключа — перемешайте")
        else:
            key = tuple(answer)
    elif typ in CHOICE_TYPES:
        if isinstance(answer, int) and not isinstance(answer, bool) and 0 <= answer < len(options):
            key = answer
        else:
            errs.add(f"{p}.answer", "ANSWER_INVALID", "Ключ — индекс варианта")
    if len(errs.items) != before or key is None:
        return None
    assert isinstance(item_id, str) and isinstance(prompt, str)
    return Item(item_id=item_id, area=str(area), band=str(band), tags=tags, skill_ids=skills, type=str(typ),
                instruction={"ru": instruction["ru"], "uz": instruction["uz"]}, prompt_en=prompt,
                passage_en=passage, audio_text_en=audio, options=tuple(options), answer=key)


def validate(raw: Any) -> TestDef:
    """Проверяет файл/тело теста целиком; ошибки → TestInvalid(errors)."""
    errs = _Errors()
    if not isinstance(raw, dict):
        raise TestInvalid([{"path": "", "code": "TEST_INVALID", "message": "Тест — JSON-объект"}])
    for key in sorted(set(raw) - {"test_id", "version", "pair_id", "audience", "config", "items"}):
        errs.add(key, "UNKNOWN_FIELD", "Неизвестное поле")
    test_id = raw.get("test_id")
    if not isinstance(test_id, str) or not ID_RE.match(test_id):
        errs.add("test_id", "ID_INVALID", "Идентификатор [a-z0-9._-], 2–64 символа")
    version = _int_in(errs, "version", raw.get("version"), 1, 10_000)
    pair_id = raw.get("pair_id")
    if not isinstance(pair_id, str) or not PAIR_RE.match(pair_id):
        errs.add("pair_id", "PAIR_INVALID", "Пара вида ru-en")
    audience = raw.get("audience")
    if audience not in AUDIENCES:
        errs.add("audience", "AUDIENCE_INVALID", "adults или kids")
    config = _config(errs, raw.get("config"))
    raw_items = raw.get("items")
    items: list[Item] = []
    if not isinstance(raw_items, list) or not raw_items or len(raw_items) > MAX_ITEMS:
        errs.add("items", "ITEMS_INVALID", f"От 1 до {MAX_ITEMS} заданий")
    else:
        seen: set[str] = set()
        for idx, raw_item in enumerate(raw_items):
            item = _item(errs, idx, raw_item, config, audience == "kids")
            if item is None:
                continue
            if item.item_id in seen:
                errs.add(f"items[{idx}].item_id", "ID_DUPLICATE", "Идентификатор задания повторяется")
            seen.add(item.item_id)
            items.append(item)
        if config is not None and len(items) == len(raw_items):
            per_area = Counter(i.area for i in items)
            need = config.items_per_area + config.followup_items
            for area in config.areas:
                if per_area[area] < need:
                    errs.add(f"items[area={area}]", "COVERAGE_LOW",
                             f"В области нужно не меньше {need} заданий (items_per_area + followup_items)")
    if errs.items:
        raise TestInvalid(errs.items)
    assert config is not None and version is not None
    return TestDef(test_id=str(test_id), version=version, pair_id=str(pair_id), audience=str(audience),
                   config=config, items=tuple(items))


def from_row(test_id: str, version: int, pair_id: str, audience: str, config: Mapping[str, Any],
             items: Sequence[Mapping[str, Any]]) -> TestDef:
    """Тест из строки tests (данные проверены при загрузке)."""
    return validate({"test_id": test_id, "version": version, "pair_id": pair_id, "audience": audience,
                     "config": dict(config), "items": [dict(i) for i in items]})
