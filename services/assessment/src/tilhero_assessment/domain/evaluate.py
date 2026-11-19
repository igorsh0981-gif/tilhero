"""Независимая оценка сессии (INTERNAL_API §3.2, AT-44/45): `POST /internal/v1/evaluations` от lessons.

Порядок (без удержания блокировок на время внешних вызовов):
1. повтор по session_id → актуальная запись цепочки (без новых событий и вызовов ИИ);
2. версии контента с ключами и рубрика — из catalog по ссылкам запроса (`resolve`), правильность от lessons не
   принимается вовсе (в запросе её нет — только ответы ученика);
3. свободный текст ученика (ролевая ситуация в режиме текста, открытый ответ; не дети) → `independent_evaluator`
   через ai-gateway; ИИ необязателен;
4. расчёт (`compute`) по правилам `rules` + наложение баллов оценщика;
5. запись под блокировками ученика и сессии (повторная проверка гонки) + `assessment.completed.v1` (outbox).
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_assessment.content import ContentGateway
from tilhero_assessment.domain import rules
from tilhero_assessment.domain.common import COMPLETED, emit_event, iso_z, lock_session, lock_user
from tilhero_assessment.domain.users import ensure_not_deleted
from tilhero_assessment.domain.views import appeal_of_session, chain_of, evaluation_result, public_outcomes
from tilhero_assessment.evaluator import EvaluatorResult
from tilhero_assessment.models import Evaluation
from tilhero_assessment.schemas import EvaluationRequestIn
from tilhero_common.errors import ApiError, conflict, unavailable, unprocessable

OPEN_ANSWER_TURN = "OA1"
OPEN_ANSWER_PROMPT_TURN = "Q1"


def refs_invalid(reason: str, **details: Any) -> ApiError:
    return unprocessable("CONTENT_REFS_INVALID", "Ссылки на версии контента не подходят для оценки",
                         {"reason": reason, **details})


def content_invalid() -> ApiError:
    return unavailable("CATALOG_INVALID_RESPONSE", "Версия контента в каталоге не годится для оценки",
                       {"service": "catalog"})


# ---------------------------------------------------------------- версии контента


@dataclass
class Plan:
    """Что оценивается — только по версиям catalog."""

    content: str  # lesson | scenario | media
    refs: list[dict[str, Any]]
    rubric: rules.Rubric
    rubric_bands: dict[str, list[dict[str, Any]]]
    key_items: dict[str, rules.KeyItem]
    evaluate_all: bool  # lesson/media — все задания версии (без ответа = неверно); review — только отвеченные
    skills: list[str]
    level: str
    goal: dict[str, str] | None
    completion: dict[str, str] | None
    outcomes: set[str] | None  # исходы концов сценария (проверка исхода от lessons)
    non_gradable: set[str] = field(default_factory=set)


def _loc(value: Any) -> dict[str, str] | None:
    if isinstance(value, Mapping) and isinstance(value.get("ru"), str) and isinstance(value.get("uz"), str):
        return {"ru": value["ru"], "uz": value["uz"]}
    return None


def _scenario_outcomes(payload: Mapping[str, Any]) -> set[str]:
    nodes = payload.get("nodes")
    if not isinstance(nodes, Mapping):
        raise content_invalid()
    return {n["end"]["outcome"] for n in nodes.values()
            if isinstance(n, Mapping) and isinstance(n.get("end"), Mapping) and n["end"].get("outcome")}


async def resolve(gateway: ContentGateway, req: EvaluationRequestIn) -> Plan:
    refs = [r.model_dump() for r in req.content_refs]
    seen: set[tuple[str, str]] = set()
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for r in refs:
        if (r["kind"], r["key"]) in seen:
            raise refs_invalid("duplicate_ref", kind=r["kind"], key=r["key"])
        seen.add((r["kind"], r["key"]))
        by_kind.setdefault(r["kind"], []).append(r)

    def count(kind: str) -> int:
        return len(by_kind.get(kind, []))

    lesson_form = count("lesson") == 1 and count("media_asset") == 0 and count("media_exercise") == 0
    media_form = count("media_exercise") >= 1 and count("media_asset") <= 1 and count("lesson") == 0 \
        and count("scenario") == 0
    shapes = {
        "lesson": lesson_form and count("scenario") <= 1,
        "scenario": count("scenario") == 1 and len(by_kind) == 2,
        "media": media_form,
        "review": (lesson_form and count("scenario") <= 1) or media_form,
    }
    if count("rubric") != 1 or not shapes[req.kind]:
        raise refs_invalid("refs_shape", kind=req.kind)

    fetched = await asyncio.gather(*(gateway.version(r["kind"], r["key"], r["version"]) for r in refs))
    payloads: dict[tuple[str, str], dict[str, Any]] = {(r["kind"], r["key"]): p for r, p in zip(refs, fetched,
                                                                                             strict=True)}

    def one(kind: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        items = by_kind.get(kind, [])
        return (items[0], payloads[(kind, items[0]["key"])]) if items else None

    rubric_ref, rubric_payload = one("rubric")  # type: ignore[misc]
    try:
        rubric = rules.rubric_from_payload(rubric_payload, rubric_ref["version"])
    except rules.ContentInvalid:
        raise content_invalid() from None
    bands = {c.code: c.bands for c in rubric.criteria}
    scenario = one("scenario")
    try:
        if lesson_form:
            _, lesson = one("lesson")  # type: ignore[misc]
            if lesson.get("rubric_id") != rubric.rubric_id:
                raise refs_invalid("rubric_mismatch", expected=lesson.get("rubric_id"))
            if scenario is not None and lesson.get("scenario_id") != scenario[0]["key"]:
                raise refs_invalid("scenario_mismatch", expected=lesson.get("scenario_id"))
            key_items = {k.item_id: k for k in rules.lesson_key_items(lesson)}
            scen_payload = scenario[1] if scenario else None
            return Plan(
                content="lesson", refs=refs, rubric=rubric, rubric_bands=bands, key_items=key_items,
                evaluate_all=req.kind == "lesson",
                skills=[str(lesson["primary_skill_id"]), *[str(s) for s in lesson.get("secondary_skill_ids", [])]],
                level=str(lesson.get("level", "A1")), goal=_loc(lesson.get("goal")),
                completion=_loc((scen_payload or {}).get("completion", {}).get("criteria")) or _loc(lesson.get("goal")),
                outcomes=_scenario_outcomes(scen_payload) if scen_payload else None)
        if req.kind == "scenario":
            _, scen = scenario  # type: ignore[misc]
            if scen.get("rubric_id") != rubric.rubric_id:
                raise refs_invalid("rubric_mismatch", expected=scen.get("rubric_id"))
            return Plan(content="scenario", refs=refs, rubric=rubric, rubric_bands=bands, key_items={},
                        evaluate_all=True, skills=[str(s) for s in scen.get("skill_ids", [])],
                        level=str(scen.get("level", "A1")), goal=_loc(scen.get("task")),
                        completion=_loc(scen.get("completion", {}).get("criteria")),
                        outcomes=_scenario_outcomes(scen))
        # медиа: упражнения одного медиа, рубрика — одна из рубрик упражнений
        asset = one("media_asset")
        exercises = [payloads[("media_exercise", r["key"])] for r in by_kind["media_exercise"]]
        assets = {str(e.get("asset_id")) for e in exercises}
        if len(assets) != 1 or (asset is not None and asset[0]["key"] not in assets):
            raise refs_invalid("media_mismatch")
        rubric_ids = {e.get("rubric_id") for e in exercises} - {None}
        if rubric_ids and rubric.rubric_id not in rubric_ids:
            raise refs_invalid("rubric_mismatch", expected=sorted(str(r) for r in rubric_ids))
        key_items, non_gradable = {}, set()
        for e in exercises:
            k = rules.exercise_key_item(e)
            if k is None:
                non_gradable.add(str(e.get("exercise_id")))
            else:
                key_items[k.item_id] = k
        skills = [str(s) for s in asset[1].get("skill_ids", [])] if asset is not None else []
        level = str((asset[1] if asset is not None else exercises[0]).get("level", "A1"))
        return Plan(content="media", refs=refs, rubric=rubric, rubric_bands=bands, key_items=key_items,
                    evaluate_all=req.kind == "media", skills=skills, level=level, goal=None, completion=None,
                    outcomes=None, non_gradable=non_gradable)
    except rules.ContentInvalid:
        raise content_invalid() from None
    except (KeyError, TypeError, AttributeError):
        raise content_invalid() from None


# ---------------------------------------------------------------- расчёт


@dataclass
class Computed:
    status: str
    scores: dict[str, int | None]
    weighted: float | None
    passed: bool | None
    task_completed: bool | None
    outcome: str | None
    confirmed_errors: list[dict[str, Any]]
    items: list[dict[str, Any]]
    turns: list[dict[str, Any]]
    skill_outcomes: list[dict[str, Any]]
    practice_only: bool
    support_used: bool
    evaluator: dict[str, Any] | None
    ai_status: str
    ai_reason: str | None
    requires_human_review: bool


def _learner_turns(req: EvaluationRequestIn) -> list[Any]:
    return [t for t in req.turns if t.speaker == "learner"]


def learner_texts(req: EvaluationRequestIn) -> dict[str, str]:
    """Свободный текст ученика по turn_id (реплики в режиме текста и открытый ответ) — то, что видит оценщик и где
    ищутся цитаты ошибок. Выбранные варианты реплик — текст контента: ошибкой не считаются."""
    out = {t.turn_id: t.text for t in _learner_turns(req) if t.mode == "text" and t.text.strip()}
    if req.open_answer is not None and req.open_answer.text.strip():
        out[OPEN_ANSWER_TURN] = req.open_answer.text
    return out


def needs_evaluator(req: EvaluationRequestIn) -> bool:
    """Оценщик — только при свободном тексте ученика; детям 6–13 свободный текст в ИИ не отправляется никогда."""
    return req.audience != "kids" and bool(learner_texts(req))


def validate_request(req: EvaluationRequestIn, plan: Plan) -> None:
    ids = [a.item_id for a in req.answers]
    if len(set(ids)) != len(ids):
        raise unprocessable("ANSWERS_INVALID", "Ответ на задание передан дважды", {"reason": "duplicate_item"})
    for item_id in ids:
        if item_id in plan.non_gradable:
            raise unprocessable("ANSWERS_INVALID", "Задание не оценивается правилами",
                                {"reason": "not_gradable", "item_id": item_id})
        if item_id not in plan.key_items:
            raise unprocessable("ANSWERS_INVALID", "Задания нет в версии контента",
                                {"reason": "unknown_item", "item_id": item_id})
    turn_ids = [t.turn_id for t in req.turns]
    if len(set(turn_ids)) != len(turn_ids):
        raise unprocessable("TURNS_INVALID", "Повторяющийся turn_id", {"reason": "duplicate_turn"})
    if plan.content == "media" and (req.turns or req.roleplay is not None):
        raise unprocessable("TURNS_INVALID", "У медиа нет ролевой ситуации", {"reason": "no_roleplay"})
    if req.roleplay is not None and req.roleplay.outcome is not None and plan.outcomes is not None \
            and req.roleplay.outcome not in plan.outcomes:
        raise unprocessable("OUTCOME_INVALID", "У сценария нет такого исхода", {"outcome": req.roleplay.outcome})


# Описательные поля контекста `*_en` (goal_en, completion_criteria_en, descriptor_en): английского текста для них в
# контенте нет — русская локализация из catalog (ai.ts, шапка; INTERNAL_API §9), независимо от языка интерфейса
# ученика. Реплики и ответы ученика — как есть.
DESCRIPTIVE_LOCALE = "ru"


def _evaluator_context(req: EvaluationRequestIn, plan: Plan, hints: int, hinted_turns: list[str]) -> dict[str, Any]:
    """IndependentEvaluatorContext (ai.ts) — только нужное: рубрика, задача и исход, реплики сцены и открытый ответ,
    подсказки, целевой уровень."""
    loc = DESCRIPTIVE_LOCALE
    criteria = [{"code": c.code, "weight": c.weight,
                 "bands": [{"score": b["score"], "descriptor_en": b["descriptor"][loc]}
                           for b in plan.rubric_bands.get(c.code, [])]} for c in plan.rubric.criteria]
    turns: list[dict[str, str]] = [{"turn_id": t.turn_id, "speaker": t.speaker, "text": t.text[:500]}
                                   for t in req.turns if t.text.strip()]
    if req.open_answer is not None and req.open_answer.text.strip():
        prompt = (req.open_answer.prompt or (plan.goal or {}).get(loc) or "").strip()
        if prompt:
            turns.append({"turn_id": OPEN_ANSWER_PROMPT_TURN, "speaker": "task", "text": prompt[:500]})
        turns.append({"turn_id": OPEN_ANSWER_TURN, "speaker": "learner", "text": req.open_answer.text[:500]})
    return {
        "rubric": {"rubric_id": plan.rubric.rubric_id, "version": plan.rubric.version, "criteria": criteria,
                   "pass_rule": {"min_weighted": plan.rubric.min_weighted,
                                 "min_per_criterion": plan.rubric.min_per_criterion}},
        "task": {"goal_en": (plan.goal or {}).get(loc, ""),
                 "completion_criteria_en": (plan.completion or {}).get(loc, ""),
                 "outcome": req.roleplay.outcome if req.roleplay is not None else None},
        "turns": turns,
        "hint_usage": {"count": hints, "turn_ids": hinted_turns},
        "cefr_target": plan.level,
    }


def hints_of(req: EvaluationRequestIn) -> tuple[int, list[str]]:
    hinted_turns = [t.turn_id for t in _learner_turns(req) if t.hinted]
    roleplay_hints = max(req.roleplay.hints if req.roleplay is not None else 0, len(hinted_turns))
    return roleplay_hints + sum(1 for a in req.answers if a.hinted), hinted_turns


def evaluator_context(req: EvaluationRequestIn, plan: Plan) -> dict[str, Any]:
    hints, hinted_turns = hints_of(req)
    return _evaluator_context(req, plan, hints, hinted_turns)


def compute(req: EvaluationRequestIn, plan: Plan, ai: EvaluatorResult | None, *,
            min_confidence: float) -> Computed:
    answers = {a.item_id: a for a in req.answers}
    keys = plan.key_items.values() if plan.evaluate_all else [plan.key_items[i] for i in answers]
    graded = [rules.grade(k, answers[k.item_id].answer if k.item_id in answers else None,
                          hinted=answers[k.item_id].hinted if k.item_id in answers else False,
                          dont_know=answers[k.item_id].dont_know if k.item_id in answers else False)
              for k in keys]
    learner = _learner_turns(req)
    hints, _ = hints_of(req)
    roleplay = req.roleplay is not None or bool(req.turns)
    outcome = req.roleplay.outcome if req.roleplay is not None else None
    ctx = rules.RuleContext(content=plan.content, graded=graded, roleplay=roleplay, outcome=outcome,
                            learner_turns=len(learner), hints=hints)
    rule_scores = rules.rule_scores(plan.rubric, ctx)
    task_completed: bool | None = (outcome in ("success", "alt_success")) if roleplay else None
    support_used = hints > 0
    scores, evaluator_meta = dict(rule_scores), None
    ai_status, ai_reason, human_review, ai_errors = "not_used", None, False, []
    ai_insufficient = False
    if ai is not None:
        ai_status = ai.status
        ai_reason = ai.reason
        if ai.status == "ok" and ai.output is not None:
            out = ai.output
            evaluator_meta = ai.meta
            ai_errors = rules.verify_ai_errors(out.get("confirmed_errors"), learner_texts(req))
            confidence = out.get("confidence")
            human_review = bool(out.get("requires_human_review")) or (
                confidence is not None and float(confidence) < min_confidence)
            support_used = support_used or bool(out.get("support_used"))
            if out["status"] == "ok":
                scores = rules.combine_scores(plan.rubric, rule_scores, out.get("scores") or {},
                                              closed_present=bool(graded))
                if not roleplay and isinstance(out.get("task_completed"), bool):
                    task_completed = out["task_completed"]
            else:
                ai_insufficient = True
        else:
            human_review = True  # открытая часть не оценена — ручная проверка
    weighted, passed, evaluated = rules.verdict(plan.rubric, scores)
    if ai is not None and ai.status != "ok":
        status = "partial" if evaluated >= 2 else "pending_review"
    elif evaluated < 2:
        # §3.2 п.4: insufficient_evidence — только когда оценённых критериев меньше двух
        status, weighted, passed = "insufficient_evidence", None, None
    elif ai_insufficient:
        # ревью R1-01: оценщику не хватило доказательств в свободном тексте — его критерии null, но правила оценили
        # ≥ 2 критериев (закрытые задания, исход сценария, подсказки): вердикт и навыки — по правилам, статус partial;
        # ручная проверка — как решил оценщик (флаг или низкая уверенность)
        status = "partial"
    else:
        status = "ok"
    practice_only = req.practice_only or req.kind == "review"
    outcomes = [] if practice_only else rules.skill_outcomes(plan.skills, graded, passed)
    items = [{"item_id": g.item.item_id, "skill_id": g.item.skill_id, "type": g.item.type, "correct": g.correct,
              "hinted": g.hinted, "answered": g.answered, "prompt_en": g.item.prompt_en, "your_answer": g.your_answer,
              "correct_answer": g.correct_answer} for g in graded]
    turns = [{"turn_id": t.turn_id, "mode": t.mode or "choice", "hinted": t.hinted} for t in learner]
    if req.open_answer is not None and req.open_answer.text.strip():
        turns.append({"turn_id": OPEN_ANSWER_TURN, "mode": "text", "hinted": False})
    return Computed(
        status=status, scores=scores, weighted=weighted, passed=passed, task_completed=task_completed,
        outcome=outcome, confirmed_errors=rules.rank_errors([*ai_errors, *rules.closed_errors(graded)]), items=items,
        turns=turns, skill_outcomes=outcomes, practice_only=practice_only, support_used=support_used,
        evaluator=evaluator_meta, ai_status=ai_status, ai_reason=ai_reason, requires_human_review=human_review)


# ---------------------------------------------------------------- запись


async def existing_result(session: AsyncSession, session_id: uuid.UUID,
                          user_id: uuid.UUID) -> dict[str, Any] | None:
    """Повтор оценки той же сессии → актуальная запись цепочки; сессия другого ученика → 409."""
    chain = await chain_of(session, session_id)
    if not chain:
        return None
    if chain[0].user_id != user_id:
        raise conflict("SESSION_CONFLICT", "Оценка этой сессии принадлежит другому ученику")
    return evaluation_result(chain[-1], appeal=await appeal_of_session(session, session_id))


async def persist(session: AsyncSession, req: EvaluationRequestIn, user_id: uuid.UUID, plan: Plan, c: Computed,
                  now: datetime) -> tuple[dict[str, Any], bool]:
    await lock_user(session, user_id)
    await lock_session(session, req.session_id)
    await ensure_not_deleted(session, user_id)
    replay = await existing_result(session, req.session_id, user_id)
    if replay is not None:
        return replay, False
    ev = Evaluation(
        evaluation_id=uuid.uuid4(), session_id=req.session_id, user_id=user_id, kind=req.kind, pair_id=req.pair_id,
        audience=req.audience, content_refs=plan.refs, rubric_id=plan.rubric.rubric_id,
        rubric_version=plan.rubric.version, rubric=plan.rubric.snapshot(), status=c.status, scores=c.scores,
        weighted=c.weighted, passed=c.passed, task_completed=c.task_completed, outcome=c.outcome,
        confirmed_errors=c.confirmed_errors, items=c.items, turns=c.turns, skill_outcomes=c.skill_outcomes,
        practice_only=c.practice_only, support_used=c.support_used, evaluator=c.evaluator, ai_status=c.ai_status,
        ai_reason=c.ai_reason, requires_human_review=c.requires_human_review, created_at=now)
    session.add(ev)
    await session.flush()
    await emit_event(session, COMPLETED, completed_payload(ev))
    return evaluation_result(ev), True


def completed_payload(ev: Evaluation) -> dict[str, Any]:
    return {"evaluation_id": str(ev.evaluation_id), "user_id": str(ev.user_id), "pair_id": ev.pair_id,
            "session_id": str(ev.session_id), "kind": ev.kind, "skill_outcomes": public_outcomes(ev),
            "passed": ev.passed, "practice_only": ev.practice_only, "supersedes": None,
            "created_at": iso_z(ev.created_at)}

