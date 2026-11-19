"""«Контроль диалогов» — блок lessons (INTERNAL_API §2.5, admin.ts SessionRow / SessionCard / Transcript).

- журнал сессий (qa.read): поля SessionRow, известные lessons, — без cost_usd/models/p95 (их добавляет admin-bff из
  ai-gateway) и без флагов appealed/flagged (assessment); без текстов учеников и без user_id;
- карточка (qa.read): версии контента, история статусов, шаги (тип, результат, подсказка), реплики — только
  метаданные; ученик — обезличенный user_ref: первые 8 hex HMAC-SHA256(user_id, USER_REF_SECRET) — сотрудник,
  знающий user_id (users.read), без секрета lessons псевдоним не сопоставит (R2-06);
- транскрипт (qa.transcripts, причина ≥ 10 символов): тексты реплик и ответов; каждое открытие — запись аудита
  `qa.transcript_viewed` (outbox, та же транзакция); стёртые по сроку хранения — text = null, redacted = true.
"""

from __future__ import annotations

import hashlib
import hmac
import statistics
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import Select, and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.errors import not_found, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit
from tilhero_lessons.domain import machine
from tilhero_lessons.domain.common import AUDIT_EVENT, PRODUCER, decode_cursor, encode_cursor, iso
from tilhero_lessons.domain.content import answer_text
from tilhero_lessons.models import Session, StatusHistory, Step, Turn

LESSONS_FLAGS = ("ai_used", "ai_unavailable", "hints", "human_review", "failed")
OTHER_FLAGS = ("appealed", "flagged")  # ведёт assessment — фильтрует admin-bff


def session_not_found() -> Any:
    return not_found("SESSION_NOT_FOUND", "Сессия не найдена")


def _passed(s: Session) -> bool | None:
    passed = s.evaluation.get("passed") if isinstance(s.evaluation, dict) else None
    return passed if isinstance(passed, bool) else None


def _human_review(s: Session) -> bool:
    """requires_human_review из ответа assessment (или статус оценки partial / pending_review)."""
    return bool((s.summary or {}).get("requires_human_review")) or (
        isinstance(s.evaluation, dict) and s.evaluation.get("status") in ("partial", "pending_review"))


def flags(s: Session) -> list[str]:
    out = []
    if s.ai_used:
        out.append("ai_used")
    if s.ai_degraded:
        out.append("ai_unavailable")
    if s.hints_used > 0:
        out.append("hints")
    if _human_review(s):
        out.append("human_review")
    if s.status == "failed":
        out.append("failed")
    return out


def row(s: Session) -> dict[str, Any]:
    return {
        "session_id": str(s.session_id), "kind": s.kind, "title": s.title, "lesson_id": s.lesson_id,
        "scenario_id": s.scenario_id, "asset_id": s.asset_id, "level": s.level, "status": s.status,
        "outcome": s.outcome if s.status == "completed" else None, "passed": _passed(s),
        "minutes": s.minutes if s.status in machine.TERMINAL else machine.minutes_of(s),
        "audience": s.audience, "ai_mode": s.ai_mode, "flags": flags(s),
        "started_at": iso(s.started_at), "finished_at": iso(s.finished_at),
        "evaluation_id": str(s.evaluation_id) if s.evaluation_id else None,
    }


def _flag_filter(stmt: Select[Any], flag: str) -> Select[Any]:
    if flag == "ai_used":
        return stmt.where(Session.ai_used.is_(True))
    if flag == "ai_unavailable":
        return stmt.where(Session.ai_degraded.is_(True))
    if flag == "hints":
        return stmt.where(Session.hints_used > 0)
    if flag == "human_review":
        return stmt.where(or_(Session.summary["requires_human_review"].astext == "true",
                              Session.evaluation["status"].astext.in_(("partial", "pending_review"))))
    if flag == "failed":
        return stmt.where(Session.status == "failed")
    raise unprocessable("FLAG_NOT_SUPPORTED", "Флаг ведёт другой домен (assessment)", {"flag": flag})


async def list_sessions(db: AsyncSession, *, date_from: datetime | None, date_to: datetime | None,
                        kind: str | None, status: str | None, outcome: str | None, flag: str | None,
                        lesson_id: str | None, level: str | None, cursor: str | None, limit: int) -> dict[str, Any]:
    stmt = select(Session)
    if date_from is not None:
        stmt = stmt.where(Session.created_at >= date_from)
    if date_to is not None:
        stmt = stmt.where(Session.created_at < date_to)
    if kind:
        stmt = stmt.where(Session.kind == kind)
    if status:
        stmt = stmt.where(Session.status == status)
    if outcome:
        stmt = stmt.where(Session.outcome == outcome, Session.status == "completed")
    if lesson_id:
        stmt = stmt.where(Session.lesson_id == lesson_id)
    if level:
        stmt = stmt.where(Session.level == level)
    if flag:
        stmt = _flag_filter(stmt, flag)
    after = decode_cursor(cursor, 2)
    if after is not None:
        try:
            at, sid = datetime.fromisoformat(str(after[0])), uuid.UUID(str(after[1]))
        except ValueError:
            raise unprocessable("INVALID_CURSOR", "Некорректный курсор") from None
        stmt = stmt.where(or_(Session.created_at < at, and_(Session.created_at == at, Session.session_id < sid)))
    rows = (await db.execute(stmt.order_by(Session.created_at.desc(), Session.session_id.desc())
                             .limit(limit + 1))).scalars().all()
    page = list(rows[:limit])
    nxt = encode_cursor(page[-1].created_at.isoformat(), str(page[-1].session_id)) \
        if len(rows) > limit and page else None
    return {"items": [row(s) for s in page], "next_cursor": nxt}


def user_ref(user_id: uuid.UUID, key: bytes) -> str:
    """Псевдоним ученика: 8 hex HMAC-SHA256(user_id, USER_REF_SECRET) — стабилен для сессий ученика, необратим без
    секрета (простой sha256(user_id) перебирается по известным user_id)."""
    return hmac.new(key, str(user_id).encode(), hashlib.sha256).hexdigest()[:8]


def content_versions(cv: dict[str, Any]) -> dict[str, int]:
    """Record<string, number>: lesson / scenario / rubric / media_asset — номер версии; упражнения и уроки
    повторения — `media_exercise:<id>` / `retrieval:<lesson_id>`."""
    out: dict[str, int] = {}
    for kind in ("lesson", "scenario", "rubric", "media_asset"):
        r = cv.get(kind)
        if isinstance(r, dict):
            out[kind] = int(r["version"])
    for r in cv.get("media_exercises") or []:
        out[f"media_exercise:{r['key']}"] = int(r["version"])
    for r in cv.get("retrieval") or []:
        out[f"retrieval:{r['key']}"] = int(r["version"])
    return out


async def _get(db: AsyncSession, session_id: uuid.UUID) -> Session:
    s = await db.get(Session, session_id)
    if s is None:
        raise session_not_found()
    return s


async def card(db: AsyncSession, session_id: uuid.UUID, *, ref_key: bytes) -> dict[str, Any]:
    s = await _get(db, session_id)
    history = (await db.execute(select(StatusHistory).where(StatusHistory.session_id == s.session_id)
                                .order_by(StatusHistory.seq))).scalars().all()
    steps = (await db.execute(select(Step).where(Step.session_id == s.session_id).order_by(Step.seq))).scalars().all()
    turns = (await db.execute(select(Turn).where(Turn.session_id == s.session_id).order_by(Turn.seq))).scalars().all()
    return {
        **row(s),
        "user_ref": user_ref(s.user_id, ref_key),
        "content_versions": content_versions(s.content_versions),
        "ai_degraded": s.ai_degraded,
        "status_history": [{"from": h.from_status, "to": h.to_status, "reason": h.reason, "at": iso(h.at)}
                           for h in history],
        "steps": [{"step_id": st.step_id, "stage": st.stage, "type": st.type, "result": st.result,
                   "hinted": st.hints > 0 or bool((st.ref or {}).get("key_seen")),
                   "answered_at": iso(st.answered_at)} for st in steps],
        "turns_meta": [{"turn_id": t.turn_id, "speaker": t.speaker, "mode": t.mode, "intent": t.intent,
                        "ai_call_id": t.ai_call_id, "redacted": t.redacted_at is not None} for t in turns],
    }


async def transcript(db: AsyncSession, session_id: uuid.UUID, actor: Actor, reason: str) -> dict[str, Any]:
    s = await _get(db, session_id)
    steps = (await db.execute(select(Step).where(Step.session_id == s.session_id).order_by(Step.seq))).scalars().all()
    turns = (await db.execute(select(Turn).where(Turn.session_id == s.session_id).order_by(Turn.seq))).scalars().all()
    answers = []
    open_answer: str | None = None
    for st in steps:
        if st.answered_at is None:
            continue
        if st.type == "item":
            a = st.answer if isinstance(st.answer, dict) else {}
            value = None if a.get("dont_know") else a.get("answer")
            answers.append({"step_id": st.step_id, "item_id": st.payload["item"]["item_id"],
                            "answer": answer_text(st.payload["item"]["options"], value)})
        elif st.type == "open_answer" and isinstance(st.answer, dict) and isinstance(st.answer.get("text"), str):
            open_answer = st.answer["text"]
    out = {
        "session_id": str(s.session_id),
        "turns": [{"turn_id": t.turn_id, "speaker": t.speaker, "text": t.text, "mode": t.mode,
                   "redacted": t.redacted_at is not None} for t in turns],
        "answers": answers,
        "open_answer": open_answer,
    }
    await emit(db, AUDIT_EVENT, {
        "record_id": str(uuid.uuid4()),
        "occurred_at": iso(datetime.now(UTC)),
        "actor_type": "staff", "actor_id": actor.id[:64], "actor_role": actor.role[:64],
        "action": "qa.transcript_viewed", "object_type": "lesson_session", "object_id": str(s.session_id),
        "before": None,
        "after": {"session_id": str(s.session_id), "turns": len(turns), "answers": len(answers),
                  "redacted": sum(1 for t in turns if t.redacted_at is not None)},
        "reason": reason, "trace_id": context.get_trace_id()[:64],
    }, producer=PRODUCER)
    return out


# ---------------------------------------------------------------- обзор (LessonStats, admin.ts)


def _pct(part: int, total: int) -> float | None:
    return round(100.0 * part / total, 1) if total else None


async def stats(db: AsyncSession, *, period: str, since: datetime) -> dict[str, Any]:
    """LessonStats без appeals_open / human_review_open (их добавляет admin-bff из assessment).
    started — сессии, начатые (ready → in_progress) за период; completed — завершённые за период;
    completion_pct — доля завершённых среди начатых за период (null при 0 начатых); median_minutes — медиана minutes
    завершённых за период; by_kind — начатые по видам (все 4 ключа); ai_degraded_pct — доля начатых в упрощённом
    режиме (ИИ недоступен)."""
    started_rows = (await db.execute(
        select(Session.kind, Session.status, Session.ai_degraded).where(Session.started_at >= since)
    )).all()
    by_kind = dict.fromkeys(("lesson", "scenario", "media", "review"), 0)
    for kind, _, _ in started_rows:
        by_kind[kind] = by_kind.get(kind, 0) + 1
    started = len(started_rows)
    minutes = list((await db.execute(
        select(Session.minutes).where(Session.status == "completed", Session.finished_at >= since)
    )).scalars().all())
    completed_of_started = sum(1 for _, status, _ in started_rows if status == "completed")
    degraded = sum(1 for _, _, d in started_rows if d)
    return {
        "period": period, "started": started, "completed": len(minutes),
        "completion_pct": _pct(completed_of_started, started),
        "median_minutes": float(statistics.median(minutes)) if minutes else None,
        "by_kind": by_kind,
        "ai_degraded_pct": _pct(degraded, started),
    }

