"""Загрузчик сида (миграция 0002): формат файлов, JSON Schema вывода, контексты по ai.ts, проверки GoldenCheck —
невалидный сид падает со списком ошибок и ничего не пишет."""

from __future__ import annotations

import copy
import json
import shutil
from pathlib import Path
from typing import Any

import pytest
from gw_kit import SEED_DIR

from tilhero_ai_gateway.domain.registry import MODELS
from tilhero_ai_gateway.domain.seed import SeedInvalid, load_seed_dir

MODEL_IDS = {m["model_id"] for m in MODELS}


@pytest.fixture
def seed_copy(tmp_path: Path) -> Path:
    target = tmp_path / "seed"
    shutil.copytree(SEED_DIR, target)
    return target


def _edit(path: Path, change) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    data = change(data) or data
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _problems(directory: Path) -> str:
    with pytest.raises(SeedInvalid) as exc:
        load_seed_dir(directory, MODEL_IDS)
    return "\n".join(exc.value.problems)


def test_fixture_seed_is_valid() -> None:
    seed = load_seed_dir(SEED_DIR, MODEL_IDS)
    assert set(seed.versions) == {"teaching_coach", "conversation_partner", "independent_evaluator"}
    assert len(seed.cases) == 11 and len({c["case_id"] for c in seed.cases}) == 11


def test_missing_directory_is_empty_seed(tmp_path: Path) -> None:
    seed = load_seed_dir(tmp_path / "nope")
    assert seed.versions == {} and seed.cases == []


@pytest.mark.parametrize(("field", "value", "fragment"), [
    ("output_schema", {"type": "object", "properties": {"a": {"$ref": "#/x"}}}, "«$ref» не поддерживается"),
    ("output_schema", {"type": "array"}, "корень схемы"),
    ("output_schema", {"type": "object", "properties": {"a": {"type": "text"}}}, "неизвестный тип"),
    ("output_schema", {"type": "object", "properties": {"a": {"type": "string", "pattern": "("}}},
     "регулярное выражение"),
    ("temperature", 1.5, "temperature"),
    ("max_output_tokens", 5000, "max_output_tokens"),
    ("timeout_ms", 1000, "timeout_ms"),
    ("instructions", "x" * 20_001, "instructions"),
    ("model_id", "gpt-4o", "нет в таблице models"),
    ("fallback_model_id", "claude-haiku-5-5", "совпадает"),
    ("agent_id", "teaching_coach", "agent_id"),
])
def test_invalid_version_file(seed_copy: Path, field: str, value: Any, fragment: str) -> None:
    def change(data: dict[str, Any]) -> None:
        data[field] = value
    _edit(seed_copy / "agents" / "conversation_partner.v1.json", change)
    if field == "fallback_model_id":
        _edit(seed_copy / "agents" / "conversation_partner.v1.json", lambda d: d.update(model_id="claude-haiku-5-5"))
    assert fragment in _problems(seed_copy)


def test_bad_file_names_and_agents(seed_copy: Path) -> None:
    (seed_copy / "agents" / "conversation_partner.json").write_text("{}", encoding="utf-8")
    shutil.copy(seed_copy / "agents" / "teaching_coach.v1.json", seed_copy / "agents" / "learning_orchestrator.v1.json")
    shutil.copy(seed_copy / "agents" / "teaching_coach.v1.json", seed_copy / "agents" / "teaching_coach.v2.json")
    (seed_copy / "golden" / "unknown_agent.json").write_text("[]", encoding="utf-8")
    (seed_copy / "golden" / "README.md").write_text("ignored", encoding="utf-8")
    text = _problems(seed_copy)
    assert "<agent_id>.v<N>.json" in text and "learning_orchestrator — не LLM-агент" in text
    assert "больше одного файла версии" in text and "unknown_agent — не LLM-агент" in text


def test_not_json(seed_copy: Path) -> None:
    (seed_copy / "golden" / "teaching_coach.json").write_text("[{", encoding="utf-8")
    assert "не JSON" in _problems(seed_copy)


def _case(seed_copy: Path, agent: str, index: int, change) -> None:
    def apply(data: list[dict[str, Any]]) -> None:
        change(data[index])
    _edit(seed_copy / "golden" / f"{agent}.json", apply)


@pytest.mark.parametrize(("agent", "change", "fragment"), [
    ("conversation_partner", lambda c: c["input"]["context"].pop("learner_turn"), "learner_turn"),
    ("conversation_partner", lambda c: c["input"]["context"].update(extra=1), "extra"),
    ("conversation_partner", lambda c: c["input"].update(audience="babies"), "audience"),
    ("conversation_partner", lambda c: c["input"]["context"]["scenario"].update(level="C2"), "level"),
    ("teaching_coach", lambda c: c["input"]["context"].update(request="translate"), "request"),
    ("independent_evaluator", lambda c: c["input"]["context"]["rubric"]["criteria"][0].update(code="meaning"),
     "code"),
    ("conversation_partner", lambda c: c["checks"].append({"kind": "field_contains", "path": "x"}), "checks"),
    ("conversation_partner", lambda c: c["checks"].append({"kind": "field_equals", "path": "a..b", "value": 1}),
     "путь"),
    ("conversation_partner", lambda c: c["checks"].append({"kind": "field_equals", "path": "$result.status",
                                                           "value": 1}), "путь"),
    ("conversation_partner", lambda c: c["checks"].append({"kind": "max_length", "path": "output.x", "n": -1}),
     "checks"),
    ("conversation_partner", lambda c: c.update(checks=[]), "от 1 до 50"),
    ("conversation_partner", lambda c: c.update(mandatory="yes"), "mandatory"),
    ("conversation_partner", lambda c: c.update(case_id="Bad ID"), "case_id"),
    ("conversation_partner", lambda c: c.update(title=""), "title"),
    ("conversation_partner", lambda c: c.update(agent_id="x"), "лишние поля"),
])
def test_invalid_golden_case(seed_copy: Path, agent: str, change, fragment: str) -> None:
    _case(seed_copy, agent, 0, change)
    assert fragment in _problems(seed_copy)


def test_duplicate_case_id_across_files(seed_copy: Path) -> None:
    _case(seed_copy, "teaching_coach", 0, lambda c: c.update(case_id="cp-order-coffee"))
    assert "повторяется" in _problems(seed_copy)


def test_golden_file_must_be_array(seed_copy: Path) -> None:
    data = json.loads((seed_copy / "golden" / "teaching_coach.json").read_text(encoding="utf-8"))
    (seed_copy / "golden" / "teaching_coach.json").write_text(json.dumps({"cases": copy.deepcopy(data)}),
                                                              encoding="utf-8")
    assert "ожидается массив" in _problems(seed_copy)
