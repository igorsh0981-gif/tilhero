"""Подмножество JSON Schema рантайма (domain/jsonschema_lite) — сверка с библиотекой jsonschema (dev-зависимость):
на схемах вывода сида и наборе значений результат «валидно / нет» совпадает."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from conftest import SERVICE_DIR
from gw_kit import SEED_DIR

from tilhero_ai_gateway.domain.jsonschema_lite import check_schema, json_equal, validate

REAL_SEED = Path(SERVICE_DIR) / "migrations" / "seed" / "agents"


def _schemas() -> list[tuple[str, dict[str, Any]]]:
    out = []
    for directory in (SEED_DIR / "agents", REAL_SEED):
        for path in sorted(directory.glob("*.json")):
            out.append((f"{directory.parent.name}/{path.name}",
                        json.loads(path.read_text(encoding="utf-8"))["output_schema"]))
    return out


EV = {"status": "ok", "scores": {"task": 3, "grammar": None, "pronunciation": None}, "task_completed": True,
      "confirmed_errors": [{"turn_id": "T1", "evidence": "I am agree", "correction": "I agree",
                            "error_code": "extra_be", "severity": "medium"}],
      "support_used": False, "confidence": 0.8, "pronunciation_score": None, "cefr_certificate": False,
      "requires_human_review": False}
INSTANCES: list[Any] = [
    {"intent": "order", "reply_en": "Sure!", "hint_offered": False},
    {"intent": "order", "reply_en": "x" * 241, "hint_offered": False},
    {"intent": "order", "reply_en": "Sure!", "hint_offered": "no"},
    {"intent": "order", "reply_en": "Sure!"},
    {"intent": "order", "reply_en": "Sure!", "hint_offered": False, "extra": 1},
    {"explanation": "Проще", "example_en": "Hi!", "example_gloss": "Привет"},
    {"explanation": "Проще", "example_en": "x" * 161, "example_gloss": "Привет"},
    {"explanation": 1, "example_en": "Hi!", "example_gloss": "Привет"},
    EV,
    {**EV, "cefr_certificate": True},
    {**EV, "pronunciation_score": 2},
    {**EV, "scores": {"task": 4}},
    {**EV, "scores": {"task": 3.0}},
    {**EV, "scores": {"task": True}},
    {**EV, "scores": {"pronunciation": 1}},
    {**EV, "confidence": 1.5},
    {**EV, "status": "great"},
    {**EV, "confirmed_errors": [EV["confirmed_errors"][0]] * 6},
    {**EV, "confirmed_errors": [{**EV["confirmed_errors"][0], "severity": "critical"}]},
    {**EV, "confirmed_errors": [{"turn_id": "T1"}]},
    {**EV, "task_completed": None},
    [], "text", None, 3,
]


@pytest.mark.parametrize(("name", "schema"), _schemas(), ids=[n for n, _ in _schemas()])
def test_seed_schemas_supported_and_agree_with_jsonschema(name: str, schema: dict[str, Any]) -> None:
    assert check_schema(schema) == [], name
    jsonschema.Draft202012Validator.check_schema(schema)
    validator = jsonschema.Draft202012Validator(schema)
    for instance in INSTANCES:
        expected = validator.is_valid(instance)
        assert (validate(instance, schema) == []) is expected, (name, instance)


@pytest.mark.parametrize(("schema", "instance"), [
    ({"type": "object", "properties": {"a": {"anyOf": [{"type": "string", "maxLength": 2}, {"type": "null"}]}}},
     {"a": "abc"}),
    ({"type": "object", "properties": {"a": {"anyOf": [{"type": "string", "maxLength": 2}, {"type": "null"}]}}},
     {"a": None}),
    ({"type": "object", "properties": {"a": {"pattern": "^[a-z]+$"}}}, {"a": "Abc"}),
    ({"type": "object", "properties": {"a": {"pattern": "b"}}}, {"a": "abc"}),
    ({"type": "object", "properties": {"a": {"const": 1}}}, {"a": True}),
    ({"type": "object", "properties": {"a": {"enum": [1, "x"]}}}, {"a": 1.0}),
    ({"type": "object", "properties": {"a": {"type": "integer"}}}, {"a": 2.0}),
    ({"type": "object", "properties": {"a": {"type": "array", "minItems": 1, "items": {"minimum": 0}}}},
     {"a": []}),
    ({"type": "object", "properties": {"a": {"type": "array", "items": {"minimum": 0}}}}, {"a": [1, -1]}),
    ({"type": "object", "additionalProperties": {"type": "integer"}}, {"x": 1, "y": "2"}),
    ({"type": "object", "required": ["a"], "properties": {"a": {"minLength": 2}}}, {"a": "é"}),
])
def test_keywords_agree_with_jsonschema(schema: dict[str, Any], instance: Any) -> None:
    assert check_schema(schema) == []
    expected = jsonschema.Draft202012Validator(schema).is_valid(instance)
    assert (validate(instance, schema) == []) is expected


@pytest.mark.parametrize("schema", [
    {"type": "object", "oneOf": [{}]},
    {"type": "object", "allOf": [{}]},
    {"type": "object", "properties": {"a": {"format": "email"}}},
    {"type": "object", "properties": {"a": {"items": [{"type": "string"}]}}},
    {"type": "object", "required": "a"},
    {"type": "object", "maxLength": -1},
    {"type": "string"},
    "not a schema",
])
def test_unsupported_or_invalid_schema_rejected(schema: Any) -> None:
    assert check_schema(schema)


def test_json_equal_distinguishes_bool_and_number() -> None:
    assert json_equal(1, 1.0) and not json_equal(True, 1) and not json_equal(0, False)
    assert json_equal({"a": [1, None]}, {"a": [1.0, None]}) and not json_equal("1", 1)
