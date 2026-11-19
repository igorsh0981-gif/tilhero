"""Контракт content.ts ↔ pydantic-модели catalog (INTERNAL_API: «pydantic-модели повторяют их 1:1, контрактный тест
сверяет поля»): поля интерфейсов (в т. ч. встроенных объектов), перечисления и объединения литералов."""

from __future__ import annotations

import types
import typing
from typing import Any, Literal, get_args, get_origin

import pytest
import ts_contract as ts
from pydantic import BaseModel

import tilhero_catalog.content as content

INTERFACES = sorted(ts.interfaces("content.ts"))


def _models_in(annotation: Any) -> list[type[BaseModel]]:
    """Вложенные pydantic-модели аннотации (Optional, list, dict, Annotated)."""
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return [annotation]
    out: list[type[BaseModel]] = []
    for arg in get_args(annotation):
        out.extend(_models_in(arg))
    return out


def _literal_values(annotation: Any) -> set[Any]:
    if get_origin(annotation) is Literal:
        return set(get_args(annotation))
    values: set[Any] = set()
    origin = get_origin(annotation)
    if origin in (typing.Union, types.UnionType, list, dict, typing.Annotated) or get_args(annotation):
        for arg in get_args(annotation):
            values |= _literal_values(arg)
    return values


def _compare(ts_fields: dict[str, str], model: type[BaseModel], where: str) -> None:
    assert set(model.model_fields) == set(ts_fields), (
        f"{where}: поля pydantic {sorted(model.model_fields)} ≠ content.ts {sorted(ts_fields)}")
    for name, type_text in ts_fields.items():
        annotation = model.model_fields[name].annotation
        inline = ts.inline_object(type_text)
        if inline is not None:
            nested = _models_in(annotation)
            assert nested, f"{where}.{name}: встроенный объект без модели"
            _compare(inline, nested[0], f"{where}.{name}")
            continue
        lits = ts.literals(type_text)
        if lits is not None:
            assert _literal_values(annotation) == lits, f"{where}.{name}: {lits}"
        alias = type_text.replace("[]", "").replace("| null", "").strip()
        if alias in ts.type_aliases("content.ts"):
            assert _literal_values(annotation) == ts.type_aliases("content.ts")[alias], f"{where}.{name}: {alias}"


@pytest.mark.parametrize("iface", INTERFACES)
def test_model_fields_match_content_ts(iface: str) -> None:
    model = getattr(content, iface, None)
    assert isinstance(model, type) and issubclass(model, BaseModel), f"нет модели {iface} в content.py"
    _compare(ts.fields("content.ts", iface), model, iface)


def test_every_interface_and_payload_kind_is_covered() -> None:
    assert len(INTERFACES) >= 22
    assert set(content.PAYLOAD_MODELS) == set(ts.type_aliases("content.ts")["ContentKind"])
    for kind, model in content.PAYLOAD_MODELS.items():
        assert content.KEY_FIELDS[kind] in model.model_fields


@pytest.mark.parametrize("alias", [
    "Band", "AudienceSegment", "GoalCode", "TopicCode", "ContentKind", "VersionStatus", "LocaleCheck", "PairStatus",
    "SkillArea", "LessonStageType", "ControlItemType", "MediaType", "MediaOrigin", "MediaUse", "MediaExerciseType",
    "MediaRequestStatus",
])
def test_enums_match_content_ts(alias: str) -> None:
    assert set(get_args(getattr(content, alias))) == ts.type_aliases("content.ts")[alias]


def test_stage_order_and_bands_constants() -> None:
    assert content.BANDS == ("A0", "A1", "A2", "B1", "B2")
    assert content.STAGE_ORDER == ("retrieval", "explanation", "roleplay", "assessment", "summary")


def test_models_reject_unknown_fields() -> None:
    payload = {"ru": "a", "uz": "b", "en": "c"}
    with pytest.raises(ValueError):
        content.Localized.model_validate(payload)
