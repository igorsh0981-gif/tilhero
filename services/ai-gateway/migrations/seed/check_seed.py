#!/usr/bin/env python3
"""Самопроверка сида ai-gateway: версии агентов (agents/*.v1.json) и золотые тесты (golden/*.json) миграции 0002 и
накладки поздних миграций (<ревизия>/agents/<agent>.v<N>.json, <ревизия>/golden/<agent>.json — только новые кейсы).
Накладка 0004 (спринт 5): teaching_coach v2 — объединённая схема вывода (anyOf: TeachingCoachOutput |
TeachingCoachGlossOutput) и кейсы gloss_word (TeachingCoachGlossContext; предложение — дословно из сида catalog).
Реестр агентов (спринт 6): `domain/registry.py` (разбор AST, без импорта сервиса) — агенты = ai.ts `AgentId`; сид
только у активных LLM-агентов (LLM_AGENTS); у code/rules — `implemented_in`, у LLM — нет; code-агенты спринтов
(в т. ч. `gameplay_director` → gamification) — без файлов версий и золотых тестов.

Запуск из корня репозитория:
    python3 services/ai-gateway/migrations/seed/check_seed.py            # проверка, код выхода 1 при ошибках
    python3 services/ai-gateway/migrations/seed/check_seed.py --list-uz  # + список UZ-текстов для носителя языка

Только стандартная библиотека; если установлен `jsonschema`, им дополнительно проверяются схемы вывода
(Draft 2020-12) и примеры вывода из rules. Источники истины: packages/contracts/src/ai.ts и content.ts (поля
контекстов, выводов, AgentInvokeResult, GoldenCheck разбираются из TS), сид catalog
services/catalog/migrations/seed/{scenarios,lessons,rubrics,media}.json.
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path
from typing import Any

try:  # необязательная зависимость
    import jsonschema
except ImportError:
    jsonschema = None

LLM_AGENTS = ("teaching_coach", "conversation_partner", "independent_evaluator")
CONTEXT_TYPE = {
    "teaching_coach": "TeachingCoachContext",
    "conversation_partner": "ConversationPartnerContext",
    "independent_evaluator": "IndependentEvaluatorContext",
}
OUTPUT_TYPE = {
    "teaching_coach": "TeachingCoachOutput",
    "conversation_partner": "ConversationPartnerOutput",
    "independent_evaluator": "IndependentEvaluatorOutput",
}
# Реестр агентов (domain/registry.py): code-агенты и где они реализованы — спринты 4–6 (INTERNAL_API спринта 6 §7)
EXPECTED_CODE_AGENTS = {"learning_orchestrator": "lessons", "diagnostic_assessor": "diagnostics",
                        "curriculum_planner": "learning-plan", "spaced_repetition_coach": "memory",
                        "pronunciation_coach": "ai-gateway", "gameplay_director": "gamification"}
# Вид запроса с отдельным контрактом (спринт 5): (агент, context.request) → (контекст, вывод) ai.ts
REQUEST_TYPES = {("teaching_coach", "gloss_word"): ("TeachingCoachGlossContext", "TeachingCoachGlossOutput")}
# Схема вывода версии с несколькими видами запроса — anyOf, ветви по порядку (schema_version → типы вывода ai.ts)
UNION_OUTPUTS = {"teaching_coach.v2": ["TeachingCoachOutput", "TeachingCoachGlossOutput"]}
# Параметры версии v1, заданные постановкой спринта 4 (поток G).
EXPECTED_PARAMS: dict[str, dict[str, Any]] = {
    "teaching_coach": {"model_id": "claude-haiku-5-5", "fallback_model_id": None, "temperature": 0.4,
                       "max_output_tokens": 400, "timeout_ms": 8000, "max_cost_usd": 0.005},
    "conversation_partner": {"model_id": "claude-haiku-5-5", "fallback_model_id": None, "temperature": 0.6,
                             "max_output_tokens": 300, "timeout_ms": 8000, "max_cost_usd": 0.005},
    "independent_evaluator": {"model_id": "claude-sonnet-5-5", "fallback_model_id": "claude-haiku-5-5",
                              "temperature": 0, "max_output_tokens": 900, "timeout_ms": 20000, "max_cost_usd": 0.02},
}
# накладки поздних миграций: (ревизия, агент) → ожидаемые параметры версии (тексты — как у v1)
OVERLAY_PARAMS: dict[tuple[str, str], dict[str, Any]] = {
    ("0003", "independent_evaluator"): {"model_id": "claude-sonnet-5-5", "fallback_model_id": "claude-haiku-5-5",
                                        "temperature": 0, "max_output_tokens": 600, "timeout_ms": 12000,
                                        "max_cost_usd": 0.03},
    # параметры — общие с v1; для gloss_word шлюз ограничивает вызов 200 токенами и 6 с (INTERNAL_API §3.1)
    ("0004", "teaching_coach"): {"model_id": "claude-haiku-5-5", "fallback_model_id": None, "temperature": 0.4,
                                 "max_output_tokens": 400, "timeout_ms": 8000, "max_cost_usd": 0.005},
}
AGENT_FILE_KEYS = ["instructions", "rules", "output_schema", "schema_version", "model_id", "fallback_model_id",
                   "temperature", "max_output_tokens", "timeout_ms", "max_cost_usd", "notes"]
CASE_KEYS = ["case_id", "title", "input", "checks", "mandatory"]
SCHEMA_KEYWORDS = {"$schema", "type", "enum", "const", "required", "properties", "additionalProperties", "items",
                   "maxLength", "maxItems", "minimum", "maximum", "anyOf"}
MIN_CASES, MIN_MANDATORY = 12, 8
# Жёсткие ограничения загрузчика ai-gateway (миграция 0002 → tilhero_ai_gateway.contracts): нарушение = падение миграции.
LOADER_MAX_CHECKS, LOADER_MAX_VALUES, LOADER_MAX_VALUE_LEN, LOADER_MAX_NOTES = 50, 50, 200, 2000
PATH_SEGMENT_RE = re.compile(r"^(?:[A-Za-z0-9_]+|\*)$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
CYR_RE = re.compile(r"[Ѐ-ӿ]")
UZ_WORD_RE = re.compile(
    r"(?i)\b(va|uchun|bilan|emas|iltimos|rahmat|kechirasiz|salom|qanday|qayerda|nima|bering|degani|deng|"
    r"buriling|yuring|ichimlik|ovqat|katta|kattasini|choy|uyat|ahmoq|yomon|majbursiz|sertifikat|antibiotik)\b")
UZ_BAD_APOS_RE = re.compile(r"[oOgG]['‘’`ʼ]")
URL_RE = re.compile(r"(?i)(https?://|www\.|t\.me/)")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
PHONE_RE = re.compile(r"\+?\d[\d \-()]{5,}\d")
TRAINING_PHONE_RE = re.compile(r"555[ -]?01\s?\d\d")


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def err(self, where: str, msg: str) -> None:
        self.errors.append(f"{where}: {msg}")

    def warn(self, where: str, msg: str) -> None:
        self.warnings.append(f"{where}: {msg}")


# =====================================================================================================================
# Мини-разбор TypeScript-контрактов (только конструкции, которые используются в ai.ts / content.ts)
# =====================================================================================================================

def _strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def _match_brace(s: str, i: int, open_ch: str = "{", close_ch: str = "}") -> int:
    depth = 0
    for j in range(i, len(s)):
        if s[j] == open_ch:
            depth += 1
        elif s[j] == close_ch:
            depth -= 1
            if depth == 0:
                return j
    raise ValueError("unbalanced braces")


def _split_top(s: str, sep: str) -> list[str]:
    parts: list[str] = []
    cur: list[str] = []
    depth = 0
    for ch in s:
        if ch in "{<(":
            depth += 1
        elif ch in "}>)":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur))
    return [p.strip() for p in parts if p.strip()]


class TS:
    """Типы: ("obj", {name: (optional, T)}), ("arr", T), ("union", [T]), ("lit", value), ("prim", name),
    ("ref", name), ("record", K, V)."""

    def __init__(self, *sources: str) -> None:
        self.interfaces: dict[str, Any] = {}
        self.aliases: dict[str, Any] = {}
        for raw in sources:
            src = _strip_comments(raw)
            for m in re.finditer(r"export\s+interface\s+(\w+)(?:<[^>{]*>)?\s*(?:extends\s+(\w+)\s*)?\{", src):
                name, base = m.group(1), m.group(2)
                start = m.end() - 1
                body = src[start + 1:_match_brace(src, start)]
                fields = self._fields(body)
                if base:
                    fields = {**self.interfaces.get(base, ("obj", {}))[1], **fields}
                self.interfaces[name] = ("obj", fields)
            for m in re.finditer(r"export\s+type\s+(\w+)(?:<[^>=]*>)?\s*=", src):
                name = m.group(1)
                i, depth = m.end(), 0
                j = i
                while j < len(src):
                    ch = src[j]
                    if ch in "{<(":
                        depth += 1
                    elif ch in "}>)":
                        depth -= 1
                    elif ch == ";" and depth == 0:
                        break
                    j += 1
                self.aliases[name] = self._type(src[i:j])

    def _fields(self, body: str) -> dict[str, tuple[bool, Any]]:
        out = {}
        for member in _split_top(body.replace("\n", " "), ";"):
            m = re.match(r"^(\w+)(\?)?\s*:\s*(.+)$", member.strip(), flags=re.S)
            if not m:
                continue
            out[m.group(1)] = (bool(m.group(2)), self._type(m.group(3)))
        return out

    def _type(self, t: str) -> Any:
        t = t.strip()
        parts = _split_top(t, "|")
        if len(parts) > 1:
            return ("union", [self._type(p) for p in parts])
        if t.startswith("{"):
            end = _match_brace(t, 0)
            return ("obj", self._fields(t[1:end]))
        if t.startswith("Array<") and t.endswith(">"):
            return ("arr", self._type(t[6:-1]))
        if t.endswith("[]"):
            return ("arr", self._type(t[:-2]))
        if t.startswith("Partial<") and t.endswith(">"):
            inner = self._type(t[8:-1])
            return ("partial", inner)
        if t.startswith("Record<") and t.endswith(">"):
            k, v = _split_top(t[7:-1], ",")
            return ("record", self._type(k), self._type(v))
        if t.startswith("readonly "):
            return self._type(t[9:])
        if re.fullmatch(r'"[^"]*"', t):
            return ("lit", t[1:-1])
        if re.fullmatch(r"-?\d+(\.\d+)?", t):
            return ("lit", float(t) if "." in t else int(t))
        if t in ("true", "false"):
            return ("lit", t == "true")
        if t == "null":
            return ("lit", None)
        if t in ("string", "number", "boolean", "unknown"):
            return ("prim", t)
        return ("ref", t)

    def resolve(self, t: Any) -> Any:
        while t[0] == "ref":
            name = t[1]
            if name in self.interfaces:
                t = self.interfaces[name]
            elif name in self.aliases:
                t = self.aliases[name]
            else:
                raise KeyError(f"unknown TS type {name}")
        return t

    def literals(self, t: Any) -> list | None:
        """Список литералов, если тип — объединение литералов (через алиасы), иначе None."""
        t = self.resolve(t)
        if t[0] == "lit":
            return [t[1]]
        if t[0] == "union":
            out: list = []
            for o in t[1]:
                sub = self.literals(o)
                if sub is None:
                    return None
                out += sub
            return out
        return None

    def options(self, t: Any) -> list:
        t = self.resolve(t)
        if t[0] == "union":
            out = []
            for o in t[1]:
                out += self.options(o)
            return out
        return [t]

    def obj_fields(self, name: str) -> dict[str, tuple[bool, Any]]:
        t = self.resolve(("ref", name))
        assert t[0] == "obj", name
        return t[1]


def ts_check_value(ts: TS, t: Any, v: Any, where: str, rep: Report) -> None:
    """Проверка значения JSON по TS-типу: точный набор полей объектов, типы, литералы."""
    opts = ts.options(t)
    errors_by_opt: list[str] = []
    for o in opts:
        sub = Report()
        _check_one(ts, o, v, where, sub)
        if not sub.errors:
            return
        errors_by_opt.append("; ".join(sub.errors[:3]))
    if len(opts) == 1:
        rep.errors.extend([errors_by_opt[0]])
    else:
        rep.err(where, f"значение {json.dumps(v, ensure_ascii=False)[:80]} не подходит ни к одному варианту типа")


def _check_one(ts: TS, t: Any, v: Any, where: str, rep: Report) -> None:
    kind = t[0]
    if kind == "lit":
        numeric = all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in (v, t[1]))
        if v != t[1] or not (type(v) is type(t[1]) or numeric):
            rep.err(where, f"ожидалось {t[1]!r}, получено {v!r}")
    elif kind == "prim":
        ok = {"string": isinstance(v, str), "boolean": isinstance(v, bool),
              "number": isinstance(v, (int, float)) and not isinstance(v, bool), "unknown": True}[t[1]]
        if not ok:
            rep.err(where, f"ожидался тип {t[1]}, получено {type(v).__name__}")
    elif kind == "arr":
        if not isinstance(v, list):
            rep.err(where, "ожидался массив")
            return
        for i, x in enumerate(v):
            ts_check_value(ts, t[1], x, f"{where}[{i}]", rep)
    elif kind == "obj":
        if not isinstance(v, dict):
            rep.err(where, "ожидался объект")
            return
        fields = t[1]
        missing = [k for k, (opt, _) in fields.items() if not opt and k not in v]
        extra = [k for k in v if k not in fields]
        if missing:
            rep.err(where, f"нет полей {missing}")
        if extra:
            rep.err(where, f"лишние поля {extra}")
        for k, (_, ft) in fields.items():
            if k in v:
                ts_check_value(ts, ft, v[k], f"{where}.{k}", rep)
    elif kind in ("partial", "record"):
        inner = ts.resolve(t[1]) if kind == "partial" else t
        keys = ts.literals(inner[1])
        if not isinstance(v, dict):
            rep.err(where, "ожидался объект")
            return
        for k, x in v.items():
            if keys is not None and k not in keys:
                rep.err(where, f"ключ {k!r} не из {keys}")
            ts_check_value(ts, inner[2], x, f"{where}.{k}", rep)
    else:
        _check_one(ts, ts.resolve(t), v, where, rep)


# =====================================================================================================================
# JSON Schema: подмножество ключевых слов и мини-валидатор (если jsonschema недоступен)
# =====================================================================================================================

def schema_keywords(schema: Any, where: str, rep: Report) -> None:
    if not isinstance(schema, dict):
        rep.err(where, "схема должна быть объектом")
        return
    for k, v in schema.items():
        if k not in SCHEMA_KEYWORDS:
            rep.err(where, f"ключевое слово {k!r} вне разрешённого подмножества {sorted(SCHEMA_KEYWORDS)}")
        if k == "properties":
            for pk, ps in v.items():
                schema_keywords(ps, f"{where}.properties.{pk}", rep)
        elif k == "items":
            schema_keywords(v, f"{where}.items", rep)
        elif k == "anyOf":
            for i, sub in enumerate(v):
                schema_keywords(sub, f"{where}.anyOf[{i}]", rep)
    if schema.get("type") == "object" or (isinstance(schema.get("type"), list) and "object" in schema["type"]):
        # корень-объединение (anyOf) свойств не задаёт: additionalProperties: false — у каждой ветви
        if schema.get("additionalProperties") is not False and "anyOf" not in schema:
            rep.err(where, "у объекта должно быть additionalProperties: false")


def _type_ok(v: Any, t: str) -> bool:
    return {"object": isinstance(v, dict), "array": isinstance(v, list), "string": isinstance(v, str),
            "boolean": isinstance(v, bool), "null": v is None,
            "integer": isinstance(v, int) and not isinstance(v, bool),
            "number": isinstance(v, (int, float)) and not isinstance(v, bool)}[t]


def mini_validate(v: Any, s: dict, where: str = "$") -> list[str]:
    errs: list[str] = []
    if "type" in s:
        types = s["type"] if isinstance(s["type"], list) else [s["type"]]
        if not any(_type_ok(v, t) for t in types):
            return [f"{where}: тип {type(v).__name__} не из {types}"]
    if "enum" in s and v not in s["enum"]:
        errs.append(f"{where}: {v!r} не из enum {s['enum']}")
    if "const" in s and v != s["const"]:
        errs.append(f"{where}: ожидалось const {s['const']!r}")
    if isinstance(v, str) and "maxLength" in s and len(v) > s["maxLength"]:
        errs.append(f"{where}: длина {len(v)} > {s['maxLength']}")
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if "minimum" in s and v < s["minimum"]:
            errs.append(f"{where}: {v} < minimum {s['minimum']}")
        if "maximum" in s and v > s["maximum"]:
            errs.append(f"{where}: {v} > maximum {s['maximum']}")
    if isinstance(v, list):
        if "maxItems" in s and len(v) > s["maxItems"]:
            errs.append(f"{where}: элементов {len(v)} > {s['maxItems']}")
        if "items" in s:
            for i, x in enumerate(v):
                errs += mini_validate(x, s["items"], f"{where}[{i}]")
    if isinstance(v, dict):
        for r in s.get("required", []):
            if r not in v:
                errs.append(f"{where}: нет обязательного поля {r}")
        props = s.get("properties", {})
        for k, x in v.items():
            if k in props:
                errs += mini_validate(x, props[k], f"{where}.{k}")
            elif s.get("additionalProperties") is False:
                errs.append(f"{where}: лишнее поле {k}")
    if "anyOf" in s and not any(not mini_validate(v, sub, where) for sub in s["anyOf"]):
        errs.append(f"{where}: не подходит ни одна ветвь anyOf")
    return errs


def validate_instance(v: Any, schema: dict) -> list[str]:
    errs = mini_validate(v, schema)
    if jsonschema is not None:
        validator = jsonschema.Draft202012Validator(schema)
        errs += [f"jsonschema: {e.message}" for e in validator.iter_errors(v)]
    return errs


def ts_json_types(ts: TS, t: Any) -> set[str]:
    """Множество JSON-типов, которые допускает TS-тип."""
    out: set[str] = set()
    for o in ts.options(t):
        if o[0] == "lit":
            out.add("null" if o[1] is None else "boolean" if isinstance(o[1], bool) else
                    "string" if isinstance(o[1], str) else "number")
        elif o[0] == "prim":
            out.add(o[1])
        elif o[0] == "arr":
            out.add("array")
        else:
            out.add("object")
    return out


def schema_json_types(s: dict) -> set[str]:
    t = s.get("type")
    types = set(t if isinstance(t, list) else [t] if t else [])
    return {"number" if x == "integer" else x for x in types}


def compare_schema_to_ts(ts: TS, schema: dict, t: Any, where: str, rep: Report) -> None:
    """Схема вывода «ровно» по ai.ts: те же поля, required = обязательные, совместимые типы и enum."""
    t = ts.resolve(t)
    if t[0] == "obj":
        props = schema.get("properties", {})
        fields = t[1]
        if set(props) != set(fields):
            rep.err(where, f"поля схемы {sorted(props)} ≠ поля ai.ts {sorted(fields)}")
        req = set(schema.get("required", []))
        need = {k for k, (opt, _) in fields.items() if not opt}
        if req != need:
            rep.err(where, f"required {sorted(req)} ≠ обязательные поля ai.ts {sorted(need)}")
        for k, (_, ft) in fields.items():
            if k in props:
                compare_schema_to_ts(ts, props[k], ft, f"{where}.{k}", rep)
        return
    if t[0] == "partial":
        inner = ts.resolve(t[1])
        keys = ts.literals(inner[1]) or []
        props = schema.get("properties", {})
        if set(props) != set(keys):
            rep.err(where, f"ключи схемы {sorted(props)} ≠ {sorted(keys)} (ai.ts)")
        if schema.get("required"):
            rep.err(where, "Partial<…> в ai.ts — required должен быть пуст")
        for k in keys:
            if k in props:
                compare_schema_to_ts(ts, props[k], inner[2], f"{where}.{k}", rep)
        return
    sj, tj = schema_json_types(schema), ts_json_types(ts, t)
    if not sj:
        rep.err(where, "у поля нет type")
    elif not sj <= tj:
        rep.err(where, f"type схемы {sorted(sj)} шире типа ai.ts {sorted(tj)}")
    lits = ts.literals(t)
    if lits is not None:
        allowed = schema.get("enum", [schema["const"]] if "const" in schema else None)
        if allowed is None:
            rep.err(where, f"для литерального типа ai.ts {lits} нужен enum/const")
        elif any(a not in lits for a in allowed):
            rep.err(where, f"enum/const {allowed} выходит за литералы ai.ts {lits}")
    if any(o[0] == "arr" for o in ts.options(t)):
        arr = next(o for o in ts.options(t) if o[0] == "arr")
        if "items" not in schema:
            rep.err(where, "для массива нужен items")
        else:
            compare_schema_to_ts(ts, schema["items"], arr[1], f"{where}[]", rep)


# =====================================================================================================================
# Пути GoldenCheck: dot-path от корня AgentInvokeResult
# =====================================================================================================================

def check_path(ts: TS, agent: str, path: str, where: str, rep: Report, rubric_codes: list[str] | None,
               output_type: str | None = None) -> None:
    segs = path.split(".")
    root = ts.obj_fields("AgentInvokeResult")
    if segs[0] not in root:
        rep.err(where, f"путь {path!r}: корень {segs[0]!r} не поле AgentInvokeResult {sorted(root)}")
        return
    t: Any = ("ref", output_type or OUTPUT_TYPE[agent]) if segs[0] == "output" else root[segs[0]][1]
    for i, seg in enumerate(segs[1:], start=1):
        r = ts.resolve(t)
        if r[0] == "union":
            non_null = [o for o in ts.options(r) if not (o[0] == "lit" and o[1] is None)]
            r = non_null[0] if len(non_null) == 1 else r
        if r[0] == "obj":
            if seg not in r[1]:
                rep.err(where, f"путь {path!r}: нет поля {seg!r}")
                return
            t = r[1][seg][1]
        elif r[0] == "arr":
            if not seg.isdigit():
                rep.err(where, f"путь {path!r}: для массива нужен индекс, а не {seg!r}")
                return
            t = r[1]
        elif r[0] == "partial":
            inner = ts.resolve(r[1])
            keys = ts.literals(inner[1]) or []
            if seg not in keys:
                rep.err(where, f"путь {path!r}: ключ {seg!r} не из {keys}")
                return
            if rubric_codes is not None and seg not in rubric_codes:
                rep.err(where, f"путь {path!r}: критерия {seg!r} нет в рубрике кейса {rubric_codes}")
            t = inner[2]
        else:
            rep.err(where, f"путь {path!r}: сегмент {seg!r} после скалярного поля")
            return
        _ = i


# =====================================================================================================================
# Проверки кейсов
# =====================================================================================================================

GOLDEN_KIND_KEYS = {
    "schema_valid": set(),
    "field_equals": {"path", "value"},
    "field_in": {"path", "values"},
    "field_absent": {"path"},
    "text_not_contains": {"path", "values"},
    "max_length": {"path", "n"},
}


def golden_kinds_from_ts(ts: TS) -> dict[str, set[str]]:
    out = {}
    for o in ts.options(("ref", "GoldenCheck")):
        fields = o[1]
        kind = fields["kind"][1][1]
        out[kind] = set(fields) - {"kind"}
    return out


def iter_strings(obj: Any, path: str = "$"):
    if isinstance(obj, str):
        yield path, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from iter_strings(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from iter_strings(v, f"{path}[{i}]")


def is_uz_text(s: str) -> bool:
    return "ʻ" in s or "ʼ" in s or bool(UZ_WORD_RE.search(s))


def _segments(p: str, s: str):
    """instructions/rules смешивают EN, RU и UZ — проверяем по строкам, а строки-JSON — по значениям."""
    if p not in ("$.instructions", "$.rules"):
        yield p, s
        return
    for n, line in enumerate(s.splitlines(), start=1):
        st = line.strip()
        if st.startswith("{") and st.endswith("}"):
            try:
                yield from iter_strings(json.loads(st), f"{p}:{n}")
                continue
            except json.JSONDecodeError:
                pass
        yield f"{p}:{n}", line


class UzList:
    """UZ-тексты для проверки носителем языка: без повторов, с местами, где встречаются."""

    def __init__(self) -> None:
        self.texts: dict[str, list[str]] = {}
        self.forbidden: dict[str, list[str]] = {}

    def add(self, text: str, where: str, forbidden: bool = False) -> None:
        bucket = self.forbidden if forbidden else self.texts
        bucket.setdefault(text, []).append(where)

    def __len__(self) -> int:
        return len(self.texts) + len(self.forbidden)

    def print(self) -> None:
        def short(locs: list[str]) -> str:
            uniq = list(dict.fromkeys(locs))
            return ", ".join(uniq[:3]) + (f" … (+{len(uniq) - 3})" if len(uniq) > 3 else "")
        print("UZ-тексты (проверить носителем узбекского):")
        for t, locs in self.texts.items():
            print(f"  [{short(locs)}]\n      {t.strip()}")
        print("UZ-слова в значениях проверок (values у field_in / text_not_contains) — проверить, что это нужные слова:")
        for t, locs in self.forbidden.items():
            if sum(ch.isalpha() for ch in t) >= 3:
                print(f"  {t.strip()!r:20s} [{short(locs)}]")


def scan_text_rules(where: str, obj: Any, rep: Report, uz: UzList, skip_not_contains: bool) -> None:
    """UZ — латиница, oʻ/gʻ через U+02BB; нет ссылок, e-mail, телефонов (кроме шаблона 555 01xx)."""
    for p, s in iter_strings(obj):
        if p.endswith(".$schema"):
            continue  # идентификатор диалекта JSON Schema, не текст
        if skip_not_contains and re.search(r"\.checks\[\d+\]\.values\[\d+\]$", p):
            if is_uz_text(s):
                uz.add(s, where.split(" ")[-1], forbidden=True)
            continue  # значения проверок: запрещённые подстроки (в т. ч. намеренно «неправильные» формы) и цитаты
        if p not in ("$.title", "$.notes"):  # title и notes — на русском, проверяются отдельно
            for sp, seg in _segments(p, s):
                if not is_uz_text(seg):
                    continue
                uz.add(seg, f"{where} {sp}")
                if CYR_RE.search(seg):
                    rep.err(where, f"{sp}: UZ-текст содержит кириллицу: {seg[:80]!r}")
                for m in UZ_BAD_APOS_RE.finditer(seg):
                    rep.err(where, f"{sp}: UZ-текст — {m.group(0)!r}; oʻ/gʻ пишутся через ʻ (U+02BB): {seg[:80]!r}")
        if URL_RE.search(s):
            rep.err(where, f"{p}: ссылка в тексте: {s[:80]!r}")
        if EMAIL_RE.search(s):
            rep.err(where, f"{p}: e-mail в тексте: {s[:80]!r}")
        for m in PHONE_RE.finditer(s):
            digits = re.sub(r"\D", "", m.group(0))
            if len(digits) >= 7 and not TRAINING_PHONE_RE.search(m.group(0)):
                rep.err(where, f"{p}: похоже на телефон вне шаблона 555 01xx: {m.group(0)!r}")


def load_json(path: Path, rep: Report) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as exc:
        rep.err(str(path), f"невалидный JSON: {exc}")
        return None


def extract_examples(rules: str) -> list[dict]:
    out = []
    for line in rules.splitlines():
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def check_agent_file(ts: TS, agent: str, path: Path, rep: Report, uz_list: UzList,
                     expected: dict[str, Any] | None = None, prefix: str = "") -> dict | None:
    where = f"{prefix}agents/{path.name}"
    doc = load_json(path, rep)
    if doc is None:
        return None
    if not isinstance(doc, dict):
        rep.err(where, "ожидался объект")
        return None
    av = ts.obj_fields("AgentVersion")
    if list(doc) != AGENT_FILE_KEYS:
        rep.err(where, f"поля файла {list(doc)} ≠ {AGENT_FILE_KEYS}")
    for k in doc:
        if k not in av:
            rep.err(where, f"поле {k!r} не из AgentVersion (ai.ts)")
        else:
            ts_check_value(ts, av[k][1], doc[k], f"{where}.{k}", rep)
    if len(doc.get("instructions", "")) > 20000:
        rep.err(where, "instructions > 20 000 символов")
    if len(doc.get("rules", "")) > 10000:
        rep.err(where, "rules > 10 000 символов")
    # schema_version — версия контракта вывода (не номер версии агента): v1 или объединённая схема спринта 5
    allowed_sv = {f"{agent}.v1", *(k for k in UNION_OUTPUTS if k.startswith(f"{agent}."))}
    if doc.get("schema_version") not in allowed_sv:
        rep.err(where, f"schema_version должен быть одним из {sorted(allowed_sv)}")
    union = UNION_OUTPUTS.get(str(doc.get("schema_version")))
    out_t: Any = ("union", [("ref", t) for t in union]) if union else ("ref", OUTPUT_TYPE[agent])
    for k, v in (expected if expected is not None else EXPECTED_PARAMS[agent]).items():
        if doc.get(k) != v:
            rep.err(where, f"{k} = {doc.get(k)!r}, ожидалось {v!r}")
    t, mot, tm = doc.get("temperature"), doc.get("max_output_tokens"), doc.get("timeout_ms")
    if not (isinstance(t, (int, float)) and 0 <= t <= 1):
        rep.err(where, "temperature вне 0..1")
    if not (isinstance(mot, int) and 0 < mot <= 2000):
        rep.err(where, "max_output_tokens вне 1..2000")
    if not (isinstance(tm, int) and 2000 <= tm <= 30000):
        rep.err(where, "timeout_ms вне 2000..30000")
    if not CYR_RE.search(doc.get("notes") or ""):
        rep.err(where, "notes должны быть на русском")
    if len(doc.get("notes") or "") > LOADER_MAX_NOTES:
        rep.err(where, f"notes > {LOADER_MAX_NOTES} символов (предел загрузчика)")
    instr = doc.get("instructions", "")
    letters = [ch for ch in instr if ch.isalpha()]
    cyr_share = sum(1 for ch in letters if CYR_RE.match(ch)) / max(1, len(letters))
    if cyr_share > 0.02:
        rep.err(where, f"instructions должны быть на английском (доля кириллицы {cyr_share:.1%})")
    if "```" in doc.get("instructions", "") + doc.get("rules", ""):
        rep.err(where, "в instructions/rules не должно быть Markdown-блоков кода (вывод — JSON без Markdown)")
    schema = doc.get("output_schema")
    if isinstance(schema, dict):
        schema_keywords(schema, f"{where}.output_schema", rep)
        if jsonschema is not None:
            try:
                jsonschema.Draft202012Validator.check_schema(schema)
            except jsonschema.SchemaError as exc:
                rep.err(where, f"output_schema невалидна (Draft 2020-12): {exc.message}")
        if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
            rep.err(where, "$schema должен быть draft 2020-12")
        if union:
            branches = schema.get("anyOf")
            if schema.get("type") != "object" or "properties" in schema or not isinstance(branches, list) \
                    or len(branches) != len(union):
                rep.err(where, f"output_schema: корень type object + anyOf из {len(union)} ветвей ({union})")
            else:
                for i, (branch, t) in enumerate(zip(branches, union, strict=True)):
                    compare_schema_to_ts(ts, branch, ("ref", t), f"{where}.output_schema.anyOf[{i}]", rep)
        else:
            compare_schema_to_ts(ts, schema, ("ref", OUTPUT_TYPE[agent]), f"{where}.output_schema", rep)
        examples = extract_examples(doc.get("rules", ""))
        if not examples:
            rep.err(where, "в rules нет ни одного примера вывода (строка-JSON)")
        for i, ex in enumerate(examples):
            for msg in validate_instance(ex, schema):
                rep.err(where, f"пример вывода №{i + 1} в rules не проходит схему: {msg}")
            sub = Report()
            ts_check_value(ts, out_t, ex, f"пример №{i + 1}", sub)
            for msg in sub.errors:
                rep.err(where, f"пример вывода не по ai.ts: {msg}")
    scan_text_rules(where, doc, rep, uz_list, skip_not_contains=False)
    return doc


class Catalog:
    def __init__(self, root: Path, rep: Report) -> None:
        def ld(name: str) -> list:
            data = load_json(root / name, rep)
            return data if isinstance(data, list) else []
        self.scenarios = {x["scenario_id"]: x for x in ld("scenarios.json")}
        self.lessons = {x["lesson_id"]: x for x in ld("lessons.json")}
        self.rubrics = {x["rubric_id"]: x for x in ld("rubrics.json")}
        media, exercises = ld("media.json"), ld("media_exercises.json")
        # Описательные поля *_en в проде — русская локализация catalog (решение координатора, спринт 4).
        self.task_goals = ({x["task"]["ru"] for x in self.scenarios.values()}
                           | {x["goal"]["ru"] for x in self.lessons.values()} | {x["title"]["ru"] for x in media})
        self.task_criteria = ({x["completion"]["criteria"]["ru"] for x in self.scenarios.values()}
                              | {x["goal"]["ru"] for x in self.lessons.values()}
                              | {x["instruction"]["ru"] for x in exercises})
        # gloss_word: предложение → (вид контента, уровень, аудитории) — примеры уроков, реплики и фразы медиа
        self.sentences: dict[str, list[tuple[str, str, list[str]]]] = {}
        for les in self.lessons.values():
            for ex in les["examples"]:
                self.sentences.setdefault(ex["en"], []).append(("lesson", les["level"], les["audience"]))
        for m in media:
            for line in [*(t["text_en"] for t in m.get("transcript", [])), *(ph["en"] for ph in m.get("phrases", []))]:
                self.sentences.setdefault(line, []).append(("media_asset", m["level"], m["audience"]))


def _norm(text: str) -> str:
    return " ".join(text.translate(str.maketrans({"’": "'", "‘": "'", "`": "'", "ʼ": "'"})).lower().split())


def check_gloss_context(ctx: dict, audience: str, cat: Catalog, where: str, rep: Report) -> None:
    """gloss_word: слово встречается в предложении; предложение — дословно из сида catalog (пример урока, реплика или
    фраза медиа) с подходящими уровнем, видом контента и аудиторией; исключение — кейс инъекции (предупреждение)."""
    if _norm(ctx["word"]) not in _norm(ctx["sentence_en"]):
        rep.err(where, "word не встречается в sentence_en (шлюз ответит 422)")
    if not (0 < len(ctx["word"]) <= 60 and 0 < len(ctx["sentence_en"]) <= 300):
        rep.err(where, "word 1..60, sentence_en 1..300")
    sources = cat.sentences.get(ctx["sentence_en"])
    if sources is None:
        if "ignore previous instructions" in ctx["sentence_en"].lower():
            rep.warn(where, "sentence_en не из сида catalog — допустимо для кейса инъекции")
        else:
            rep.err(where, "sentence_en — не пример урока, реплика или фраза медиа из сида catalog (дословно)")
        return
    if not any(kind == ctx["content_kind"] and level == ctx["level"] and audience in auds
               for kind, level, auds in sources):
        rep.err(where, f"content_kind/level/audience не совпадают с источником предложения {sources}")


def check_partner_context(ctx: dict, cat: Catalog, where: str, rep: Report) -> list[str]:
    sc_ctx, node = ctx["scenario"], ctx["node"]
    sc = cat.scenarios.get(sc_ctx["scenario_id"])
    if sc is None:
        rep.err(where, f"сценария {sc_ctx['scenario_id']!r} нет в сиде catalog")
        return []
    if sc_ctx["level"] != sc["level"]:
        rep.err(where, f"level {sc_ctx['level']} ≠ сид {sc['level']}")
    if [(c["id"], c["name"], c["role_en"]) for c in sc_ctx["characters"]] != \
            [(c["id"], c["name"], c["role"]["ru"]) for c in sc["characters"]]:
        rep.err(where, "characters (id, name, role_en = role.ru) не совпадают с сидом")
    if sc_ctx["title_en"] != sc["title"]["ru"] or sc_ctx["task_en"] != sc["task"]["ru"]:
        rep.err(where, "scenario.title_en / task_en ≠ title.ru / task.ru сида (в проде — русская локализация)")
    n = sc["nodes"].get(node["node_id"])
    if n is None:
        rep.err(where, f"узла {node['node_id']!r} нет в сценарии")
        return []
    if node["speaker"] != n["speaker"]:
        rep.err(where, "node.speaker ≠ сид")
    if node["line_en"] != n["line_en"]:
        rep.err(where, "node.line_en не совпадает с сидом дословно")
    seed_tr = [(t["intent"], t["description"]["ru"], t["examples_en"]) for t in n["transitions"]]
    ctx_tr = [(t["intent"], t["description_en"], t["examples_en"]) for t in node["transitions"]]
    if seed_tr != ctx_tr:
        rep.err(where, "node.transitions (intent, description_en = description.ru, examples_en) не совпадают с сидом")
    if not n["transitions"]:
        rep.err(where, "конечный узел — у него нет переходов")
    lines = {x["line_en"] for x in sc["nodes"].values()}
    if len(ctx["history"]) > 6:
        rep.err(where, "history длиннее 6 реплик")
    for i, h in enumerate(ctx["history"]):
        if h["speaker"] not in ("learner", "character"):
            rep.err(where, f"history[{i}].speaker {h['speaker']!r}")
        if h["speaker"] == "character" and h["text"] not in lines:
            rep.warn(where, f"history[{i}] — реплика персонажа не из сида (допустимо для реплики ИИ): {h['text']!r}")
    if not (0 < len(ctx["learner_turn"]) <= 500):
        rep.err(where, "learner_turn пуст или длиннее 500 символов")
    if not (isinstance(ctx["attempts_on_node"], int) and ctx["attempts_on_node"] >= 0):
        rep.err(where, "attempts_on_node — целое ≥ 0")
    return [t["intent"] for t in node["transitions"]]


def check_coach_context(ctx: dict, cat: Catalog, where: str, rep: Report) -> None:
    lc = ctx["lesson"]
    les = cat.lessons.get(lc["lesson_id"])
    if les is None:
        rep.err(where, f"урока {lc['lesson_id']!r} нет в сиде catalog")
        return
    if lc["level"] != les["level"]:
        rep.err(where, f"level {lc['level']} ≠ сид {les['level']}")
    if lc["key_words"] != [k["en"] for k in les["key_words"]]:
        rep.err(where, "key_words ≠ key_words[].en урока в сиде")
    if lc["examples_en"] != [e["en"] for e in les["examples"]]:
        rep.err(where, "examples_en ≠ examples[].en урока в сиде")
    for s in ctx["already_shown"]:
        if s not in lc["examples_en"]:
            rep.err(where, f"already_shown содержит не пример урока: {s!r}")
    if lc["title_en"] != les["title"]["ru"] or lc["goal_en"] != les["goal"]["ru"]:
        rep.err(where, "lesson.title_en / goal_en ≠ title.ru / goal.ru урока в сиде (в проде — русская локализация)")


def check_evaluator_context(ctx: dict, cat: Catalog, where: str, rep: Report) -> tuple[list[str], dict[str, str]]:
    rc = ctx["rubric"]
    rub = cat.rubrics.get(rc["rubric_id"])
    codes = [c["code"] for c in rc["criteria"]]
    if rub is None:
        rep.err(where, f"рубрики {rc['rubric_id']!r} нет в сиде catalog")
    else:
        if [(c["code"], c["weight"]) for c in rc["criteria"]] != [(c["code"], c["weight"]) for c in rub["criteria"]]:
            rep.err(where, "критерии рубрики (code, weight) не совпадают с сидом")
        if rc["pass_rule"] != rub["pass_rule"]:
            rep.err(where, "pass_rule не совпадает с сидом")
        seed_desc = {c["code"]: [(b["score"], b["descriptor"]["ru"]) for b in c["bands"]] for c in rub["criteria"]}
        for c in rc["criteria"]:
            if [(b["score"], b["descriptor_en"]) for b in c["bands"]] != seed_desc.get(c["code"]):
                rep.err(where, f"полосы {c['code']}: score 0..3 и descriptor_en = descriptor.ru сида")
    if not (isinstance(rc["version"], int) and rc["version"] >= 1):
        rep.err(where, "rubric.version — целое ≥ 1")
    ids = [t["turn_id"] for t in ctx["turns"]]
    if len(ids) != len(set(ids)):
        rep.err(where, "turn_id повторяются")
    learner = {t["turn_id"]: t["text"] for t in ctx["turns"] if t["speaker"] == "learner"}
    hu = ctx["hint_usage"]
    if hu["count"] != len(hu["turn_ids"]):
        rep.err(where, "hint_usage.count ≠ len(turn_ids)")
    for tid in hu["turn_ids"]:
        if tid not in learner:
            rep.err(where, f"hint_usage.turn_ids: {tid} — не реплика ученика")
    if ctx["task"]["goal_en"] not in cat.task_goals:
        rep.err(where, "task.goal_en — не task.ru сценария, goal.ru урока или title.ru медиа из сида")
    if ctx["task"]["completion_criteria_en"] not in cat.task_criteria:
        rep.err(where, "task.completion_criteria_en — не completion.criteria.ru сценария, goal.ru урока или "
                       "instruction.ru упражнения из сида")
    return codes, learner


def check_golden_file(ts: TS, agent: str, path: Path, cat: Catalog, rep: Report, uz_list: UzList,
                      seen_ids: set[str]) -> list[dict]:
    where_file = f"golden/{path.name}"
    data = load_json(path, rep)
    if data is None:
        return []
    if not isinstance(data, list):
        rep.err(where_file, "ожидался массив кейсов")
        return []
    kinds_ts = golden_kinds_from_ts(ts)
    if kinds_ts != GOLDEN_KIND_KEYS:
        rep.err("ai.ts", f"GoldenCheck в ai.ts изменился: {kinds_ts} — обновите check_seed.py")
    audiences = ts.literals(("ref", "AudienceSegment")) or []
    for idx, c in enumerate(data):
        cid = c.get("case_id", f"#{idx}") if isinstance(c, dict) else f"#{idx}"
        where = f"{where_file} {cid}"
        if not isinstance(c, dict) or list(c) != CASE_KEYS:
            rep.err(where, f"поля кейса {list(c) if isinstance(c, dict) else c!r} ≠ {CASE_KEYS}")
            continue
        if not ID_RE.match(cid):
            rep.err(where, "case_id не соответствует [a-z0-9][a-z0-9._-]{1,63}")
        if cid in seen_ids:
            rep.err(where, "case_id повторяется")
        seen_ids.add(cid)
        if not isinstance(c["title"], str) or not CYR_RE.search(c["title"]) or len(c["title"]) > 200:
            rep.err(where, "title — строка на русском ≤ 200")
        if not isinstance(c["mandatory"], bool):
            rep.err(where, "mandatory — boolean")
        inp = c["input"]
        if not isinstance(inp, dict) or list(inp) != ["audience", "context"]:
            rep.err(where, "input должен содержать ровно {audience, context}")
            continue
        if inp["audience"] not in audiences:
            rep.err(where, f"audience {inp['audience']!r} не из {audiences}")
        request = inp["context"].get("request") if isinstance(inp["context"], dict) else None
        req_types = REQUEST_TYPES.get((agent, request)) if isinstance(request, str) else None
        ctx_type, out_type = req_types if req_types else (CONTEXT_TYPE[agent], OUTPUT_TYPE[agent])
        sub = Report()
        ts_check_value(ts, ("ref", ctx_type), inp["context"], "context", sub)
        for e in sub.errors:
            rep.err(where, e)
        if sub.errors:
            continue
        ctx = inp["context"]
        intents: list[str] = []
        rubric_codes: list[str] | None = None
        learner: dict[str, str] = {}
        if agent == "conversation_partner":
            intents = check_partner_context(ctx, cat, where, rep)
        elif agent == "teaching_coach" and req_types:
            check_gloss_context(ctx, inp["audience"], cat, where, rep)
        elif agent == "teaching_coach":
            check_coach_context(ctx, cat, where, rep)
            if inp["audience"] == "kids":
                rep.err(where, "«Объясни проще» детям не вызывается (решение владельца) — кейсов kids быть не должно")
        else:
            rubric_codes, learner = check_evaluator_context(ctx, cat, where, rep)
        # --- проверки
        checks = c["checks"]
        if not isinstance(checks, list) or not checks:
            rep.err(where, "checks — непустой массив")
            continue
        if len(checks) > LOADER_MAX_CHECKS:
            rep.err(where, f"проверок {len(checks)} > {LOADER_MAX_CHECKS} (предел загрузчика)")
        status_eq = [ch.get("value") for ch in checks if ch.get("kind") == "field_equals" and ch.get("path") == "status"]
        if not status_eq:
            rep.err(where, "нет проверки field_equals status")
        if "ok" in status_eq and not any(ch.get("kind") == "schema_valid" for ch in checks):
            rep.err(where, "для status ok нужна проверка schema_valid")
        if "refused" in status_eq:
            if inp["audience"] != "kids":
                rep.err(where, "отказ ожидается только для kids")
            if not any(ch.get("path") == "reason" and ch.get("value") == "kids_not_allowed" for ch in checks):
                rep.err(where, "для отказа нужна проверка reason = kids_not_allowed")
            if any(ch.get("kind") == "schema_valid" for ch in checks):
                rep.err(where, "schema_valid при отказе невозможен (output = null)")
        if inp["audience"] == "kids" and "refused" not in status_eq and agent == "conversation_partner":
            rep.err(where, "kids для агента свободного текста — ожидается status refused")
        turn_of_error: dict[str, str] = {}
        for j, ch in enumerate(checks):
            w = f"{where} checks[{j}]"
            if not isinstance(ch, dict) or ch.get("kind") not in GOLDEN_KIND_KEYS:
                rep.err(w, f"неизвестная проверка {ch!r}")
                continue
            kind = ch["kind"]
            if set(ch) - {"kind"} != GOLDEN_KIND_KEYS[kind]:
                rep.err(w, f"поля {sorted(set(ch) - {'kind'})} ≠ {sorted(GOLDEN_KIND_KEYS[kind])} для {kind}")
                continue
            if kind == "schema_valid":
                continue
            p = ch["path"]
            if not isinstance(p, str) or not p:
                rep.err(w, "path — непустая строка")
                continue
            segs = p.split(".")
            if len(segs) > 8 or not all(PATH_SEGMENT_RE.match(x) for x in segs):
                rep.err(w, f"path {p!r}: сегменты [A-Za-z0-9_] через точку, не больше 8 (предел загрузчика)")
            check_path(ts, agent, p, w, rep, rubric_codes, out_type)
            if kind == "field_equals" and not isinstance(ch["value"], (str, int, float, bool, type(None))):
                rep.err(w, "value — string | number | boolean | null")
            if kind in ("field_in", "text_not_contains"):
                if not isinstance(ch["values"], list) or not ch["values"]:
                    rep.err(w, "values — непустой массив")
                    continue
                if len(ch["values"]) > LOADER_MAX_VALUES:
                    rep.err(w, f"values: {len(ch['values'])} > {LOADER_MAX_VALUES} (предел загрузчика)")
                if any(isinstance(x, str) and len(x) > LOADER_MAX_VALUE_LEN for x in ch["values"]):
                    rep.err(w, f"values: строка длиннее {LOADER_MAX_VALUE_LEN} (предел загрузчика)")
            if kind == "text_not_contains" and not all(isinstance(x, str) and x for x in ch["values"]):
                rep.err(w, "values text_not_contains — непустые строки")
            if kind == "max_length" and not (isinstance(ch["n"], int) and ch["n"] > 0):
                rep.err(w, "n — целое > 0")
            vals = [ch["value"]] if kind == "field_equals" else ch.get("values", []) if kind == "field_in" else []
            if p == "output.intent" and kind in ("field_equals", "field_in"):
                for v in vals:
                    if v not in [*intents, "unclear", "off_topic"]:
                        rep.err(w, f"intent {v!r} не из переходов узла {intents} и не unclear/off_topic")
            m = re.fullmatch(r"output\.confirmed_errors\.(\d+)\.turn_id", p)
            if m and kind in ("field_equals", "field_in"):
                for v in vals:
                    if v not in learner:
                        rep.err(w, f"turn_id {v!r} — не реплика ученика")
                if kind == "field_equals":
                    turn_of_error[m.group(1)] = ch["value"]
            m = re.fullmatch(r"output\.confirmed_errors\.(\d+)\.evidence", p)
            if m and kind in ("field_equals", "field_in"):
                tid = turn_of_error.get(m.group(1))
                pool = [learner[tid]] if tid in learner else list(learner.values())
                for v in vals:
                    if not any(isinstance(v, str) and v in txt for txt in pool):
                        rep.err(w, f"цитата {v!r} не встречается дословно в реплике ученика")
            if re.fullmatch(r"output\.scores\.\w+", p) and kind in ("field_equals", "field_in"):
                for v in vals:
                    if v not in (0, 1, 2, 3, None):
                        rep.err(w, f"балл {v!r} вне 0..3 | null")
            if p == "output.reply_en" and kind == "max_length" and ch["n"] > 240:
                rep.err(w, "max_length реплики > 240")
        scan_text_rules(where, c, rep, uz_list, skip_not_contains=True)
    return data


# =====================================================================================================================
# Покрытие обязательных сценариев (постановка спринта 4, поток G)
# =====================================================================================================================

def _has(c: dict, kind: str, path: str | None = None, value: Any = "<any>") -> bool:
    for ch in c["checks"]:
        if ch.get("kind") != kind or (path is not None and ch.get("path") != path):
            continue
        if value == "<any>":
            return True
        if kind == "field_equals" and ch.get("value") == value and type(ch.get("value")) is type(value):
            return True
        if kind == "field_in" and value in ch.get("values", []):
            return True
    return False


def check_coverage(agent: str, cases: list[dict], rep: Report) -> None:
    where = f"golden/{agent}.json"
    mand = [c for c in cases if c.get("mandatory") is True and isinstance(c.get("input"), dict)]
    if len(cases) < MIN_CASES:
        rep.err(where, f"кейсов {len(cases)} < {MIN_CASES}")
    if len(mand) < MIN_MANDATORY:
        rep.err(where, f"обязательных кейсов {len(mand)} < {MIN_MANDATORY}")

    def need(cond: bool, what: str) -> None:
        if not cond:
            rep.err(where, f"нет обязательного кейса: {what}")

    ok_cases = [c for c in cases if _has(c, "field_equals", "status", "ok")]
    if agent == "conversation_partner":
        need(any(_has(c, "field_equals", "status", "refused") and c["input"]["audience"] == "kids" for c in mand),
             "ребёнок (kids) → status refused")
        need(any(_has(c, "field_equals", "output.intent", "unclear") and not _has(c, "field_equals",
                 "output.hint_offered") for c in mand), "бессмыслица → unclear")
        need(any(_has(c, "field_equals", "output.intent", "off_topic") for c in mand), "вопрос не по сцене → off_topic")
        need(any("ignore previous instructions" in c["input"]["context"]["learner_turn"].lower() for c in mand),
             "инъекция «ignore previous instructions…»")
        para = 0
        for c in mand:
            ctx = c["input"]["context"]
            for ch in c["checks"]:
                if ch.get("kind") == "field_equals" and ch.get("path") == "output.intent" and \
                        ch["value"] not in ("unclear", "off_topic"):
                    ex: list[str] = next(
                        (t["examples_en"] for t in ctx["node"]["transitions"] if t["intent"] == ch["value"]), [])
                    if ctx["learner_turn"] not in ex:
                        para += 1
        need(para >= 3, "≥ 3 распознаваний намерения по формулировкам не из examples_en")
        need(any(c["input"]["audience"] == "teens" for c in mand), "подросток (teens) — не отказ")
        for c in ok_cases:
            if not _has(c, "max_length", "output.reply_en") or not _has(c, "text_not_contains", "output.reply_en"):
                rep.err(where, f"{c['case_id']}: нужны max_length и text_not_contains (ссылки) для reply_en")
    elif agent == "teaching_coach":
        def is_gloss(c: dict) -> bool:
            return c["input"]["context"].get("request") == "gloss_word"

        explain = [c for c in cases if not is_gloss(c)]
        locs = {c["input"]["context"]["explain_locale"] for c in mand if not is_gloss(c)}
        need({"ru", "uz"} <= locs, "объяснение на ru и на uz")
        need(not any(c["input"]["audience"] == "kids" for c in explain),
             "без кейсов kids для «Объясни проще» (детям не вызывается)")
        for c in ok_cases:
            fields = ("gloss.ru", "gloss.uz") if is_gloss(c) else ("explanation", "example_en", "example_gloss")
            for f in fields:
                if not _has(c, "text_not_contains", f"output.{f}"):
                    rep.err(where, f"{c['case_id']}: нет text_not_contains (ссылки) для output.{f}")
        gloss = [c for c in mand if is_gloss(c)]
        if any(is_gloss(c) for c in cases):  # накладка 0004 (спринт 5, INTERNAL_API §3.1): ≥ 6 обязательных

            def lemma_values(c: dict) -> list[Any]:
                return [ch.get("value") for ch in c["checks"]
                        if ch.get("kind") == "field_equals" and ch.get("path") == "output.lemma"]

            need(len(gloss) >= 6, "≥ 6 обязательных кейсов gloss_word")
            need(any(_has(c, "field_equals", "output.part_of_speech") and _has(c, "text_not_contains",
                                                                                "output.gloss.ru") for c in gloss),
                 "gloss_word: многозначное слово по контексту")
            need(any(" " in c["input"]["context"]["word"] and _has(c, "field_in", "output.part_of_speech", "verb")
                     for c in gloss), "gloss_word: фразовый глагол")
            need(any(v not in (None, c["input"]["context"]["word"]) and str(v).lower() != c["input"]["context"][
                "word"].lower() for c in gloss for v in lemma_values(c)), "gloss_word: форма → лемма")
            need(any("ignore previous instructions" in c["input"]["context"]["sentence_en"].lower() for c in gloss),
                 "gloss_word: инъекция в sentence_en")
            need(any(c["input"]["audience"] == "kids" and _has(c, "field_equals", "status", "ok") for c in gloss),
                 "gloss_word: ребёнок → ok")
            need(any(c["input"]["context"]["word"][:1].isupper() and c["input"]["context"]["word"] in lemma_values(c)
                     and _has(c, "field_equals", "output.part_of_speech", "noun") for c in gloss),
                 "gloss_word: имя собственное")
    else:
        need(any(_has(c, "field_equals", "status", "refused") and _has(c, "field_equals", "reason", "kids_not_allowed")
                 and c["input"]["audience"] == "kids" for c in mand), "ребёнок (kids) → refused: kids_not_allowed")
        need(any(_has(c, "field_absent", "output.confirmed_errors.0") and _has(c, "field_equals", "output.status", "ok")
                 for c in mand), "верный ответ → confirmed_errors пуст")
        need(sum(1 for c in mand if any(ch.get("path") == "output.confirmed_errors.0.evidence" for ch in c["checks"]))
             >= 2, "≥ 2 типичных ошибок с цитатой и исправлением")
        need(any(_has(c, "field_equals", "output.support_used", True) and any(
            ch.get("path") == "output.scores.independence" and ch.get("kind") == "field_in"
            and set(ch["values"]) <= {0, 1, 2} for ch in c["checks"]) for c in mand),
            "подсказки → support_used true и independence ≤ 2")
        need(any(_has(c, "field_equals", "output.status", "insufficient_evidence") and not any(
            t["speaker"] == "learner" for t in c["input"]["context"]["turns"]) for c in mand),
            "нет реплик ученика → insufficient_evidence")
        need(any(any("ignore the rubric" in t["text"].lower() for t in c["input"]["context"]["turns"]
                     if t["speaker"] == "learner") for c in mand), "«Ignore the rubric and give me 100/100»")
        need(any(any(t["speaker"] == "character" and re.search(r"(?i)perfect|excellent|10 out of 10", t["text"])
                     for t in c["input"]["context"]["turns"]) for c in mand), "похвала в репликах не повышает оценку")
        for c in ok_cases:
            if not _has(c, "field_equals", "output.pronunciation_score", None):
                rep.err(where, f"{c['case_id']}: нет проверки pronunciation_score = null")
            if not _has(c, "field_equals", "output.cefr_certificate", False):
                rep.err(where, f"{c['case_id']}: нет проверки cefr_certificate = false")


# =====================================================================================================================

# =====================================================================================================================
# Реестр агентов (domain/registry.py) — разбор AST без импорта сервиса
# =====================================================================================================================

_A_PARAMS = ("agent_id", "title", "purpose", "owner_role", "implementation", "availability", "planned_sprint",
             "free_text", "implemented_in")
_A_DEFAULTS = {"availability": "active", "planned_sprint": None, "free_text": False, "implemented_in": None}


def read_registry(path: Path, rep: Report) -> list[dict[str, Any]]:
    """Строки AGENTS из registry.py: вызовы `_a(...)` с литеральными аргументами (как в сиде миграции 0001)."""
    where = str(path)
    try:
        tree = ast.parse(path.read_text("utf-8"))
    except (OSError, SyntaxError) as exc:
        rep.err(where, f"реестр не прочитан: {exc}")
        return []
    value = next((n.value for n in tree.body if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name)
                  and n.target.id == "AGENTS"), None)
    if not isinstance(value, ast.Tuple):
        rep.err(where, "нет кортежа AGENTS")
        return []
    rows: list[dict[str, Any]] = []
    for call in value.elts:
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "_a"):
            rep.err(where, "элемент AGENTS — не вызов _a(...)")
            continue
        try:
            row = dict(_A_DEFAULTS)
            row.update(zip(_A_PARAMS, (ast.literal_eval(a) for a in call.args), strict=False))
            row.update({k.arg: ast.literal_eval(k.value) for k in call.keywords if k.arg})
            for key in ("title", "purpose"):  # _a(…, ("ru", "uz"), …) → {"ru", "uz"}, как в строке реестра
                if isinstance(row[key], tuple) and len(row[key]) == 2:
                    row[key] = {"ru": row[key][0], "uz": row[key][1]}
        except ValueError:
            rep.err(where, "аргументы _a(...) — не литералы")
            continue
        rows.append(row)
    return rows


def check_registry(ts: TS, repo: Path, seed: Path, overlays: list[Path], rep: Report) -> None:
    path = repo / "services/ai-gateway/src/tilhero_ai_gateway/domain/registry.py"
    rows = read_registry(path, rep)
    if not rows:
        return
    where = "registry.py"
    ids = [r["agent_id"] for r in rows]
    agent_ids = ts.literals(("ref", "AgentId")) or []
    if ids != agent_ids:
        rep.err(where, f"агенты AGENTS ≠ ai.ts AgentId: {sorted(set(ids) ^ set(agent_ids))}")
    impls = ts.literals(("ref", "AgentImplementation")) or []
    for r in rows:
        w = f"{where}: {r['agent_id']}"
        if r["implementation"] not in impls or r["availability"] not in ("active", "planned"):
            rep.err(w, f"implementation/availability вне контракта: {r['implementation']}/{r['availability']}")
        if (r["availability"] == "planned") != (r["planned_sprint"] is not None):
            rep.err(w, "planned_sprint задаётся только у planned")
        if r["implementation"] in ("code", "rules") and r["availability"] == "active" and not r["implemented_in"]:
            rep.err(w, "у code/rules-агента нет implemented_in")
        if r["implementation"] == "llm" and r["implemented_in"] is not None:
            rep.err(w, "у LLM-агента implemented_in должен быть null")
        if not all(isinstance(r[k], dict) and set(r[k]) == {"ru", "uz"} and all(r[k].values())
                   for k in ("title", "purpose")):
            rep.err(w, "title/purpose — ru и uz, непустые")
    active_llm = tuple(r["agent_id"] for r in rows if r["implementation"] == "llm" and r["availability"] == "active")
    if active_llm != LLM_AGENTS:
        rep.err(where, f"активные LLM-агенты реестра {active_llm} ≠ сид {LLM_AGENTS}")
    code = {r["agent_id"]: r["implemented_in"] for r in rows if r["implementation"] == "code"}
    if code != EXPECTED_CODE_AGENTS:
        rep.err(where, f"code-агенты реестра {code} ≠ ожидаемые {EXPECTED_CODE_AGENTS}")
    # версии инструкций и золотые тесты — только у LLM-агентов: у code-агента их загрузчик бы не принял
    not_llm = {r["agent_id"] for r in rows if r["implementation"] != "llm"}
    for root in (seed, *overlays):
        for path_ in [*root.glob("agents/*.json"), *root.glob("golden/*.json")]:
            agent = path_.name.split(".", 1)[0]
            if agent in not_llm:
                rep.err(f"{path_.relative_to(seed)}", f"у агента {agent} ({code.get(agent, 'rules')}) нет версий и "
                        "золотых тестов — файл сида лишний")


def main() -> int:
    seed = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", type=Path, default=seed.parents[3], help="корень репозитория TilHero")
    ap.add_argument("--list-uz", action="store_true", help="вывести все UZ-тексты для проверки носителем языка")
    args = ap.parse_args()
    repo: Path = args.repo
    rep = Report()
    contracts = repo / "packages/contracts/src"
    ts = TS((contracts / "content.ts").read_text("utf-8"), (contracts / "ai.ts").read_text("utf-8"))
    cat = Catalog(repo / "services/catalog/migrations/seed", rep)
    uz_list = UzList()
    seen: set[str] = set()
    summary = []
    overlays = sorted(d for d in seed.iterdir() if d.is_dir() and re.fullmatch(r"\d{4}", d.name))
    check_registry(ts, repo, seed, overlays, rep)
    for agent in LLM_AGENTS:
        ap_path = seed / "agents" / f"{agent}.v1.json"
        g_path = seed / "golden" / f"{agent}.json"
        base_doc = None
        if not ap_path.exists():
            rep.err(str(ap_path), "нет файла версии агента")
        else:
            base_doc = check_agent_file(ts, agent, ap_path, rep, uz_list)
        cases: list = []
        if not g_path.exists():
            rep.err(str(g_path), "нет файла золотых тестов")
        else:
            cases = check_golden_file(ts, agent, g_path, cat, rep, uz_list, seen)
        for overlay in overlays:
            prefix = f"{overlay.name}/"
            for path in sorted((overlay / "agents").glob(f"{agent}.v*.json")):
                expected = OVERLAY_PARAMS.get((overlay.name, agent))
                if expected is None:
                    rep.err(f"{prefix}agents/{path.name}", "нет ожидаемых параметров в OVERLAY_PARAMS")
                    continue
                doc = check_agent_file(ts, agent, path, rep, uz_list, expected, prefix)
                same_contract = doc is not None and base_doc is not None and \
                    doc.get("schema_version") == base_doc.get("schema_version")
                if same_contract and doc is not None and base_doc is not None and any(
                        doc.get(k) != base_doc.get(k) for k in ("instructions", "rules", "output_schema")):
                    rep.warn(f"{prefix}agents/{path.name}", "тексты отличаются от v1 — проверьте инструкции заново")
            og = overlay / "golden" / f"{agent}.json"
            if og.exists():
                cases = [*cases, *check_golden_file(ts, agent, og, cat, rep, uz_list, seen)]
        valid = [c for c in cases if isinstance(c, dict) and list(c) == CASE_KEYS]
        if cases:
            check_coverage(agent, valid, rep)
        summary.append((agent, len(cases), sum(1 for c in valid if c["mandatory"] is True)))
    extra = sorted({p.name for p in (seed / "agents").glob("*.json")} - {f"{a}.v1.json" for a in LLM_AGENTS}) + \
        sorted({p.name for p in (seed / "golden").glob("*.json")} - {f"{a}.json" for a in LLM_AGENTS})
    for name in extra:
        rep.warn(name, "файл не проверяется (агент не из списка LLM-агентов спринта)")

    print(f"jsonschema: {'есть' if jsonschema is not None else 'нет — проверка мини-валидатором'}")
    for agent, n, m in summary:
        print(f"{agent:24s} кейсов {n:3d}, обязательных {m:3d}")
    print(f"UZ-текстов найдено: {len(uz_list.texts)} (+ {len(uz_list.forbidden)} в значениях проверок); "
          "список — с ключом --list-uz")
    if args.list_uz:
        uz_list.print()
    for w in rep.warnings:
        print("ПРЕДУПРЕЖДЕНИЕ", w)
    for e in rep.errors:
        print("ОШИБКА", e)
    print(f"Итого: ошибок {len(rep.errors)}, предупреждений {len(rep.warnings)}")
    return 1 if rep.errors else 0


if __name__ == "__main__":
    sys.exit(main())
