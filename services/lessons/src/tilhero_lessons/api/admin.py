"""Admin API lessons — «Контроль диалогов» (только admin-bff; права сотрудника из actor проверяются здесь — защита
в глубину): qa.read — журнал и карточка сессии без текстов; qa.transcripts — тексты реплик и ответов с причиной
(каждое открытие — аудит qa.transcript_viewed)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import forbidden
from tilhero_common.internal_auth import Principal
from tilhero_lessons.api.common import CONTENT_ID, clock_of, settings_of, staff_auth
from tilhero_lessons.domain import admin as svc
from tilhero_lessons.schemas import TranscriptIn

router = APIRouter(prefix="/admin/v1/lesson-sessions", tags=["staff"])

READ, TRANSCRIPTS, DASHBOARD = "qa.read", "qa.transcripts", "dashboard.read"
Flag = Literal["ai_used", "ai_unavailable", "hints", "human_review", "appealed", "flagged", "failed"]


@router.get("", responses={400: {"description": "INVALID_CURSOR"},
                           403: {"description": "PERMISSION_DENIED | STAFF_CONTEXT_REQUIRED"},
                           422: {"description": "FLAG_NOT_SUPPORTED (appealed, flagged — assessment)"}})
async def list_sessions(
    date_from: datetime | None = Query(default=None, alias="from"),
    date_to: datetime | None = Query(default=None, alias="to"),
    kind: Literal["lesson", "scenario", "media", "review"] | None = Query(default=None),
    status: Literal["ready", "in_progress", "paused", "completed", "failed", "cancelled"] | None = Query(default=None),
    outcome: Literal["success", "alt_success", "fail"] | None = Query(default=None),
    flag: Flag | None = Query(default=None),
    lesson_id: str | None = Query(default=None, max_length=64, pattern=CONTENT_ID),
    level: Literal["A0", "A1", "A2", "B1", "B2"] | None = Query(default=None),
    cursor: str | None = Query(default=None, max_length=300),
    limit: int = Query(default=20, ge=1, le=100),
    principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
) -> dict[str, Any]:
    """Page<SessionRow-поля lessons> (без cost_usd/models/p95 — их добавляет admin-bff из ai-gateway)."""
    principal.require_permission(READ)
    async with rt.transaction() as session:
        return await svc.list_sessions(session, date_from=date_from, date_to=date_to, kind=kind, status=status,
                                       outcome=outcome, flag=flag, lesson_id=lesson_id, level=level, cursor=cursor,
                                       limit=limit)


@router.get("/stats", responses={403: {"description": "PERMISSION_DENIED | STAFF_CONTEXT_REQUIRED"}})
async def get_stats(request: Request, period: Literal["today", "7d", "30d"] = Query(default="today"),
                    principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """LessonStats (без appeals_open / human_review_open — assessment). Period как в admin.ts: today — с начала суток
    (STATS_TIMEZONE), 7d — 7 дней, 30d — 30 дней. Право dashboard.read или qa.read."""
    actor = principal.actor
    if actor is None:
        raise forbidden("STAFF_CONTEXT_REQUIRED", "Команда доступна только сотрудникам")
    if DASHBOARD not in actor.permissions and READ not in actor.permissions:
        raise forbidden("PERMISSION_DENIED", "Недостаточно прав", {"permission": DASHBOARD})
    now = clock_of(request)()
    if period == "today":
        tz = ZoneInfo(settings_of(request).stats_timezone)
        since = now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    else:
        since = now - timedelta(days=7 if period == "7d" else 30)
    async with rt.transaction() as session:
        return await svc.stats(session, period=period, since=since)


@router.get("/{session_id}", responses={403: {"description": "PERMISSION_DENIED"},
                                        404: {"description": "SESSION_NOT_FOUND"}})
async def get_card(session_id: uuid.UUID, request: Request, principal: Principal = Depends(staff_auth),
                   rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """SessionCard.session: версии контента, история статусов, шаги и метаданные реплик — без текстов ученика;
    ученик — user_ref (HMAC с USER_REF_SECRET)."""
    principal.require_permission(READ)
    async with rt.transaction() as session:
        return await svc.card(session, session_id, ref_key=settings_of(request).user_ref_key())


@router.post("/{session_id}/transcript", responses={403: {"description": "PERMISSION_DENIED"},
                                                    404: {"description": "SESSION_NOT_FOUND"},
                                                    422: {"description": "VALIDATION_ERROR (reason ≥ 10)"}})
async def post_transcript(session_id: uuid.UUID, body: TranscriptIn, principal: Principal = Depends(staff_auth),
                          rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Transcript: тексты реплик и ответов (стёртые по сроку — text null, redacted true); аудит qa.transcript_viewed."""
    actor = principal.require_permission(TRANSCRIPTS)
    async with rt.transaction() as session:
        return await svc.transcript(session, session_id, actor, body.reason)
