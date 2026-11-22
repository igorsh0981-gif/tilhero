"""Контракт ai.ts / admin.ts ↔ ai-gateway: pydantic-модели контекстов и выводов повторяют интерфейсы ai.ts 1:1,
перечисления совпадают, ключи ответов API — поля интерфейсов (AgentRow, AgentVersionRow — без *_name: имена
подставляет admin-bff, здесь *_by / author_id)."""

from __future__ import annotations

import re
import types
import typing
from typing import Any, Literal, get_args, get_origin

import pytest
import ts_contract as ts
from gw_kit import ANALYST, OPERATIONS, ie_context, speech_meta
from pydantic import BaseModel

from tilhero_ai_gateway import contracts
from tilhero_ai_gateway.api.internal import InvokeIn
from tilhero_ai_gateway.domain.registry import AGENT_IDS
from tilhero_ai_gateway.domain.wav import make_wav
from tilhero_ai_gateway.models import REASONS_SQL


def _models_in(annotation: Any) -> list[type[BaseModel]]:
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
    if get_origin(annotation) in (typing.Union, types.UnionType, list, dict, typing.Annotated) or get_args(annotation):
        for arg in get_args(annotation):
            values |= _literal_values(arg)
    return values


def _compare(ts_fields: dict[str, str], model: type[BaseModel], where: str) -> None:
    assert set(model.model_fields) == set(ts_fields), (
        f"{where}: поля pydantic {sorted(model.model_fields)} ≠ ai.ts {sorted(ts_fields)}")
    for name, type_text in ts_fields.items():
        annotation = model.model_fields[name].annotation
        inline = ts.inline_object(type_text)
        if inline is not None:
            nested = _models_in(annotation)
            assert nested, f"{where}.{name}: встроенный объект без модели"
            _compare(inline, nested[0], f"{where}.{name}")
            continue
        lits = ts.literals(type_text)
        if lits is not None and all(isinstance(v, str) for v in lits):
            assert {v for v in _literal_values(annotation) if isinstance(v, str)} == lits, f"{where}.{name}"
        alias = type_text.replace("[]", "").replace("| null", "").strip()
        if alias in ts.type_aliases("ai.ts"):
            assert _literal_values(annotation) == ts.type_aliases("ai.ts")[alias], f"{where}.{name}: {alias}"


@pytest.mark.parametrize("iface", ["ConversationPartnerContext", "ConversationPartnerOutput", "TeachingCoachContext",
                                   "TeachingCoachOutput", "IndependentEvaluatorContext", "IndependentEvaluatorOutput",
                                   "ConfirmedError", "TeachingCoachGlossContext", "TeachingCoachGlossOutput",
                                   "SpeechAssessMeta", "PronunciationResult", "AiStatus",
                                   # спринт 7: коуч парного урока и распознавание голосового хода комнаты
                                   "CooperativeCoachContext", "CooperativeCoachOutput", "SpeechTranscribeMeta",
                                   "SpeechTranscribeResult"])
def test_agent_models_match_ai_ts(iface: str) -> None:
    _compare(ts.fields("ai.ts", iface), getattr(contracts, iface), iface)


def test_speech_enums_match_ai_ts() -> None:
    aliases = ts.type_aliases("ai.ts")
    assert set(get_args(contracts.PronunciationErrorType)) == aliases["PronunciationErrorType"]
    pos = ts.literals(ts.fields("ai.ts", "TeachingCoachGlossOutput")["part_of_speech"])
    assert pos is not None and set(get_args(contracts.PartOfSpeech)) == pos
    # AiSessionKind = SessionKind | "memory" | "pair" (спринт 7); SessionKind + duel
    assert set(get_args(contracts.AiSessionKind)) == aliases["SessionKind"] | {"memory", "pair"}
    assert 'export type AiSessionKind = SessionKind | "memory" | "pair"' in ts.source("ai.ts")
    assert "duel" in aliases["SessionKind"] and "duel" in get_args(contracts.SessionKind)
    assert set(get_args(contracts.CoachRole)) == aliases["CoachRole"]
    transcribe = ts.fields("ai.ts", "SpeechTranscribeResult")
    assert ts.literals(transcribe["provider"]) == {"whisper", "fake_speech"}
    model = ts.fields("ai.ts", "AiModel")
    assert ts.literals(model["provider"]) == {"anthropic", "fake", "whisper", "azure_speech", "fake_speech"}
    speech = ts.inline_object(ts.fields("ai.ts", "AiProviderStatus")["speech"])
    assert speech is not None and ts.literals(speech["provider"]) == {"whisper", "azure_speech", "fake_speech"}


def test_invoke_request_matches_ai_ts() -> None:
    assert set(InvokeIn.model_fields) == set(ts.fields("ai.ts", "AgentInvokeRequest"))


def test_enums_match_ai_ts() -> None:
    aliases = ts.type_aliases("ai.ts")
    assert set(AGENT_IDS) == aliases["AgentId"] == set(get_args(contracts.AgentIdLit))
    for name in ("RubricCriterionCode", "SessionKind", "AgentImplementation", "AgentVersionStatus",
                 "AgentUnavailableReason", "AgentRefusedReason"):
        assert set(get_args(getattr(contracts, name))) == aliases[name], name
    reasons = {r.strip().strip("'") for r in REASONS_SQL.split(",")}
    assert reasons == aliases["AgentUnavailableReason"] | aliases["AgentRefusedReason"]
    kinds = set(re.findall(r'\{ kind: "(\w+)"', ts.source("ai.ts")))
    assert len(kinds) == 6
    assert {get_args(m.model_fields["kind"].annotation)[0] for m in get_args(get_args(contracts.GoldenCheck)[0])} == \
        kinds


def _keys(iface: str, file: str = "ai.ts") -> set[str]:
    return set(ts.fields(file, iface))


def _no_names(fields: set[str]) -> set[str]:
    return {f for f in fields if not f.endswith("_name")}


async def test_invoke_result_keys(env) -> None:
    res = await env.ok("independent_evaluator", ie_context("He go home."))
    assert set(res) == _keys("AgentInvokeResult")
    assert set(res["output"]) == _keys("IndependentEvaluatorOutput")
    assert set(res["output"]["confirmed_errors"][0]) == _keys("ConfirmedError")
    await env.publish_v2()
    gloss = (await env.gloss()).json()
    assert set(gloss) == _keys("AgentInvokeResult") and set(gloss["output"]) == _keys("TeachingCoachGlossOutput")
    pair = ts.inline_object(ts.fields("ai.ts", "TeachingCoachGlossOutput")["gloss"])
    assert pair is not None and set(gloss["output"]["gloss"]) == set(pair)


async def test_pronunciation_result_keys(env) -> None:
    res = (await env.speech(make_wav(2000), speech_meta(reference_text="Good morning, everybody"))).json()
    fields = ts.fields("ai.ts", "PronunciationResult")
    assert set(res) == set(fields)
    for nested, value in (("scores", res["scores"]), ("words", res["words"][0]), ("tips", res["tips"][0])):
        inline = ts.inline_object(fields[nested])
        assert inline is not None and set(value) == set(inline), nested


async def test_admin_response_keys(env) -> None:
    v = await env.tested_draft("teaching_coach")
    agents = (await env.c.get("/admin/v1/ai/agents", headers=env.h(ANALYST))).json()["items"]
    row = next(a for a in agents if a["agent_id"] == "teaching_coach")
    assert set(row) == _keys("AgentRow", "admin.ts")
    assert set(row["rollout"]) == _keys("AgentRollout")
    published = ts.inline_object(ts.fields("admin.ts", "AgentRow")["published"])
    assert published is not None
    assert set(row["published"]) == _no_names(set(published)) | {"published_by"}
    assert set(row["last_test_run"]) == _keys("TestRunSummary")
    assert next(a for a in agents if a["agent_id"] == "error_analyst")["rollout"] is None
    detail = await env.agent("teaching_coach")
    assert set(detail) == _keys("AgentRow", "admin.ts") | {"versions"}
    assert set(detail["versions"][0]) == _no_names(_keys("AgentVersionRow", "admin.ts")) | {"author_id",
                                                                                             "published_by"}
    version = (await env.c.get(env.url("teaching_coach", "versions", v["version"]), headers=env.h(ANALYST))).json()
    assert set(version) == _keys("AgentVersion") | {"updated_at", "canary"}
    runs = await env.sql("SELECT run_id FROM test_runs ORDER BY seq DESC LIMIT 1")
    run = (await env.c.get(env.url("teaching_coach", "versions", v["version"], "test-runs", runs[0]["run_id"]),
                           headers=env.h(ANALYST))).json()
    assert set(run) == _keys("TestRun")
    result_fields = ts.inline_object(ts.fields("ai.ts", "TestRun")["results"])
    assert result_fields is not None and set(run["results"][0]) == set(result_fields)
    cases = (await env.c.get(env.url("teaching_coach", "golden-cases"), headers=env.h(ANALYST))).json()
    assert set(cases["items"][0]) == _keys("GoldenCase")
    models = (await env.c.get("/admin/v1/ai/models", headers=env.h(ANALYST))).json()["items"]
    assert all(set(m) == _keys("AiModel") for m in models)
    provider = (await env.c.get("/admin/v1/ai/provider", headers=env.h(ANALYST))).json()
    assert set(provider) == _keys("AiProviderStatus")
    speech_fields = ts.inline_object(ts.fields("ai.ts", "AiProviderStatus")["speech"])
    assert speech_fields is not None and set(provider["speech"]) == set(speech_fields)
    assert set((await env.c.get("/admin/v1/ai/budget", headers=env.h(OPERATIONS))).json()) == _keys("AiBudget")
    await env.ok()
    summary = (await env.c.get("/admin/v1/ai/usage/summary", params={"period": "week"},
                               headers=env.h(OPERATIONS))).json()
    fields = ts.fields("admin.ts", "AiUsageSummary")
    assert set(summary) == set(fields)
    for nested in ("by_agent", "by_model", "by_day"):
        inline = ts.inline_object(fields[nested])
        assert inline is not None and summary[nested] and set(summary[nested][0]) == set(inline), nested
    speech = ts.inline_object(fields["speech"])
    assert speech is not None and set(summary["speech"]) == set(speech)
    status = (await env.c.get("/internal/v1/status", headers=env.svc("memory"))).json()
    assert set(status) == _keys("AiStatus")
    calls = (await env.c.get("/admin/v1/ai/usage", params={"agent_id": "conversation_partner"},
                             headers=env.h(OPERATIONS))).json()
    assert set(calls) == {"items", "next_cursor"} and set(calls["items"][0]) == _keys("AiCall", "admin.ts")
