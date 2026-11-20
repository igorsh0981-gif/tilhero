"""Подтверждённые ошибки оценки для memory (спринт 5, INTERNAL_API §5, §1.2): `GET /internal/v1/evaluations/{id}/
memory-feed` — источник карточек урока, медиа и сценария и журнала ошибок ученика.

- Вызывающий — только memory; ученик — `sub` токена (user_id из события assessment): чужая или несуществующая
  оценка — 404 (существование не раскрывается).
- Отдаётся **актуальная запись цепочки** (как ученику): запрошенная заменена переоценкой → её данные не отдаются,
  `evaluation_id` — id актуальной записи, `superseded_by` — тот же id (иначе null).
- `errors` — только ошибки **текста ученика**: `turn_id` реплики свободным текстом (`T{n}`) или открытого ответа
  (`OA1`; в INTERNAL_API — `O{n}`); закрытые задания (их `turn_id` — id задания) не входят — их повторяет очередь
  lessons. Детский профиль — ошибок нет (свободного текста у детей нет; защита в глубину).
- `evidence` (цитата ученика ≤ 120) — null, если стёрта по сроку хранения: сессии старше
  `MEMORY_EVIDENCE_RETENTION_DAYS` (90 — как текст реплик в lessons и цитата в карточке memory) или цитата пуста.
  Оценка в assessment при этом не меняется (неизменяема; цитата — основание оценки, PLAN спринта 4).
- `content_refs` — версии контента по видам (см. README «memory-feed»).
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_assessment.domain.common import evaluation_not_found
from tilhero_assessment.domain.users import ensure_not_deleted
from tilhero_assessment.domain.views import chain_of
from tilhero_assessment.models import Evaluation

SINGLE_REFS = ("lesson", "scenario", "media_asset", "reading", "rubric")


def content_refs(refs: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """[{kind, key, version}] оценки → {lesson|scenario|media_asset|reading|rubric: {key, version} | null,
    media_exercises: [{key, version}]} — ключи и версии для `GET catalog /internal/v1/versions/{kind}/{key}/{version}`
    (kind в catalog: lesson | scenario | media_asset | reading | rubric | media_exercise)."""
    out: dict[str, Any] = dict.fromkeys(SINGLE_REFS)
    out["media_exercises"] = []
    for r in refs:
        ref = {"key": str(r["key"]), "version": int(r["version"])}
        if r["kind"] == "media_exercise":
            out["media_exercises"].append(ref)
        elif r["kind"] in SINGLE_REFS and out[r["kind"]] is None:
            out[r["kind"]] = ref
    return out


def text_turns(ev: Evaluation) -> set[str]:
    """turn_id свободного текста ученика в этой оценке (реплики mode=text, открытый ответ)."""
    return {str(t["turn_id"]) for t in ev.turns if isinstance(t, dict) and t.get("mode") == "text"}


def feed_errors(ev: Evaluation, *, evidence_expired: bool) -> list[dict[str, Any]]:
    if ev.audience == "kids":
        return []
    turns = text_turns(ev)
    out = []
    for e in ev.confirmed_errors:
        if not isinstance(e, dict) or str(e.get("turn_id")) not in turns:
            continue  # закрытое задание (turn_id = id задания) — не ошибка текста ученика
        evidence = e.get("evidence")
        out.append({"turn_id": str(e["turn_id"]),
                    "evidence": None if evidence_expired or not isinstance(evidence, str) or not evidence.strip()
                    else evidence,
                    "correction": str(e["correction"]), "error_code": str(e["error_code"]),
                    "severity": str(e["severity"])})
    return out


async def memory_feed(session: AsyncSession, *, user_id: uuid.UUID, evaluation_id: uuid.UUID, now: datetime,
                      evidence_days: int) -> dict[str, Any]:
    await ensure_not_deleted(session, user_id)
    ev = await session.get(Evaluation, evaluation_id)
    if ev is None or ev.user_id != user_id:
        raise evaluation_not_found()
    chain = await chain_of(session, ev.session_id)
    actual = chain[-1] if chain else ev
    # срок хранения цитаты — от сессии (исходной оценки), а не от переоценки, скопировавшей цитату
    session_at = chain[0].created_at if chain else ev.created_at
    expired = now - session_at > timedelta(days=evidence_days)
    return {
        "evaluation_id": actual.evaluation_id,
        "session_id": actual.session_id,
        "user_id": actual.user_id,
        "pair_id": actual.pair_id,
        "kind": actual.kind,
        "content_refs": content_refs(actual.content_refs),
        "practice_only": actual.practice_only,
        "superseded_by": actual.evaluation_id if actual.evaluation_id != evaluation_id else None,
        "errors": feed_errors(actual, evidence_expired=expired),
    }
