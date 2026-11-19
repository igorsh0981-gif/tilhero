"""Проверка JSON Schema вывода агента — подмножество draft 2020-12 без внешних зависимостей.

`jsonschema` есть только в dev-группе workspace (в образ сервиса не попадает), поэтому рантайм проверяет вывод
этим модулем. Поддерживаются ключевые слова: type, enum, const, required, properties, additionalProperties,
items (одна схема), minLength, maxLength, minItems, maxItems, minimum, maximum, pattern, anyOf; аннотации
($schema, $id, title, description, default, examples, $comment) игнорируются. Схема с другими ключевыми словами
($ref, oneOf, allOf, if/then, format …) отклоняется при сохранении версии и загрузке сида (`check_schema`) — версия
не может «молча» не проверять то, что в ней написано. Тест сверяет результаты с библиотекой jsonschema.
"""

from __future__ import annotations

import json
import re
from typing import Any, Final

SUPPORTED: Final = frozenset({
    "type", "enum", "const", "required", "properties", "additionalProperties", "items", "minLength", "maxLength",
    "minItems", "maxItems", "minimum", "maximum", "pattern", "anyOf",
})
ANNOTATIONS: Final = frozenset({"$schema", "$id", "title", "description", "default", "examples", "$comment"})
TYPES: Final = frozenset({"object", "array", "string", "integer", "number", "boolean", "null"})
MAX_DEPTH: Final = 24
MAX_SCHEMA_BYTES: Final = 64 * 1024
MAX_ERRORS: Final = 20


def _is_int(v: Any) -> bool:
    return (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer())


def _is_number(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


def _non_neg_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def json_equal(a: Any, b: Any) -> bool:
    """Равенство JSON-значений: true ≠ 1, 1 = 1.0, порядок ключей объекта не важен."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_number(a) and _is_number(b):
        return bool(a == b)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(json_equal(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(json_equal(a[k], b[k]) for k in a)
    return type(a) is type(b) and bool(a == b)


def type_matches(value: Any, name: str) -> bool:
    if name == "object":
        return isinstance(value, dict)
    if name == "array":
        return isinstance(value, list)
    if name == "string":
        return isinstance(value, str)
    if name == "integer":
        return _is_int(value)
    if name == "number":
        return _is_number(value)
    if name == "boolean":
        return isinstance(value, bool)
    if name == "null":
        return value is None
    return False


# ---------------------------------------------------------------- проверка самой схемы


def check_schema(schema: Any) -> list[str]:
    """Проблемы схемы вывода (пусто — схема поддерживается и корректна). Корень — объект с type: object."""
    problems: list[str] = []
    try:
        size = len(json.dumps(schema, ensure_ascii=False))
    except (TypeError, ValueError):
        return ["$: схема не сериализуется в JSON"]
    if size > MAX_SCHEMA_BYTES:
        return [f"$: схема больше {MAX_SCHEMA_BYTES} байт"]
    if not isinstance(schema, dict) or schema.get("type") != "object":
        problems.append("$: корень схемы — объект с type: object")
    _check(schema, "$", 0, problems)
    return problems[:MAX_ERRORS]


def _check(schema: Any, path: str, depth: int, problems: list[str]) -> None:
    if depth > MAX_DEPTH:
        problems.append(f"{path}: слишком глубокая вложенность")
        return
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        problems.append(f"{path}: схема должна быть объектом")
        return
    for key in schema:
        if key not in SUPPORTED and key not in ANNOTATIONS:
            problems.append(f"{path}: ключевое слово «{key}» не поддерживается "
                            f"(допустимы: {', '.join(sorted(SUPPORTED))})")
    if "type" in schema:
        t = schema["type"]
        names = t if isinstance(t, list) else [t]
        if not names or not all(isinstance(n, str) and n in TYPES for n in names) or len(set(names)) != len(names):
            problems.append(f"{path}.type: неизвестный тип {t!r}")
    if "enum" in schema and (not isinstance(schema["enum"], list) or not schema["enum"]):
        problems.append(f"{path}.enum: непустой массив")
    if "required" in schema:
        req = schema["required"]
        if not isinstance(req, list) or not all(isinstance(r, str) for r in req) or len(set(req)) != len(req):
            problems.append(f"{path}.required: массив уникальных строк")
    for key in ("minLength", "maxLength", "minItems", "maxItems"):
        if key in schema and not _non_neg_int(schema[key]):
            problems.append(f"{path}.{key}: неотрицательное целое")
    for key in ("minimum", "maximum"):
        if key in schema and not _is_number(schema[key]):
            problems.append(f"{path}.{key}: число")
    if "pattern" in schema:
        pattern = schema["pattern"]
        if not isinstance(pattern, str) or len(pattern) > 500:
            problems.append(f"{path}.pattern: строка ≤ 500")
        else:
            try:
                re.compile(pattern)
            except re.error:
                problems.append(f"{path}.pattern: некорректное регулярное выражение")
    if "properties" in schema:
        props = schema["properties"]
        if not isinstance(props, dict):
            problems.append(f"{path}.properties: объект")
        else:
            for name, sub in props.items():
                _check(sub, f"{path}.properties.{name}", depth + 1, problems)
    if "additionalProperties" in schema:
        _check(schema["additionalProperties"], f"{path}.additionalProperties", depth + 1, problems)
    if "items" in schema:
        if isinstance(schema["items"], list):
            problems.append(f"{path}.items: кортежная форма не поддерживается")
        else:
            _check(schema["items"], f"{path}.items", depth + 1, problems)
    if "anyOf" in schema:
        variants = schema["anyOf"]
        if not isinstance(variants, list) or not variants:
            problems.append(f"{path}.anyOf: непустой массив схем")
        else:
            for i, sub in enumerate(variants):
                _check(sub, f"{path}.anyOf[{i}]", depth + 1, problems)


# ---------------------------------------------------------------- проверка значения


def validate(instance: Any, schema: Any) -> list[str]:
    """Ошибки значения по схеме (пусто — значение соответствует). Схема должна пройти `check_schema`."""
    errors: list[str] = []
    _validate(instance, schema, "$", errors, 0)
    return errors[:MAX_ERRORS]


def _validate(value: Any, schema: Any, path: str, errors: list[str], depth: int) -> None:
    if len(errors) >= MAX_ERRORS or depth > MAX_DEPTH:
        return
    if schema is True:
        return
    if schema is False:
        errors.append(f"{path}: значение запрещено схемой")
        return
    if not isinstance(schema, dict):
        errors.append(f"{path}: некорректная схема")
        return
    if "type" in schema:
        names = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(type_matches(value, n) for n in names):
            errors.append(f"{path}: ожидается {'|'.join(names)}")
            return
    if "enum" in schema and not any(json_equal(value, e) for e in schema["enum"]):
        errors.append(f"{path}: значение вне enum")
    if "const" in schema and not json_equal(value, schema["const"]):
        errors.append(f"{path}: значение не равно const")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: короче {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path}: длиннее {schema['maxLength']}")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            errors.append(f"{path}: не соответствует шаблону")
    if _is_number(value):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: меньше {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: больше {schema['maximum']}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: элементов меньше {schema['minItems']}")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: элементов больше {schema['maxItems']}")
        if "items" in schema:
            for i, item in enumerate(value):
                _validate(item, schema["items"], f"{path}[{i}]", errors, depth + 1)
    if isinstance(value, dict):
        for name in schema.get("required", []):
            if name not in value:
                errors.append(f"{path}.{name}: обязательное поле")
        props = schema.get("properties", {})
        for name, item in value.items():
            if name in props:
                _validate(item, props[name], f"{path}.{name}", errors, depth + 1)
            elif "additionalProperties" in schema:
                extra = schema["additionalProperties"]
                if extra is False:
                    errors.append(f"{path}.{name}: лишнее поле")
                else:
                    _validate(item, extra, f"{path}.{name}", errors, depth + 1)
    if "anyOf" in schema and not any(not validate_branch(value, sub, depth) for sub in schema["anyOf"]):
        errors.append(f"{path}: не подходит ни один вариант anyOf")


def validate_branch(value: Any, schema: Any, depth: int) -> list[str]:
    errs: list[str] = []
    _validate(value, schema, "$", errs, depth + 1)
    return errs
