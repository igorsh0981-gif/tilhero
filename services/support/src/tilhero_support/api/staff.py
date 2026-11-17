"""Staff API (только admin-bff, права сотрудника проверяются здесь — скрытие в UI не защита)."""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, Query, Response

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import forbidden, unprocessable
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_support.api.common import cfg, idempotency_key
from tilhero_support.domain import tickets as svc
from tilhero_support.domain.constants import CATEGORIES, OPEN_STATUSES, STATUSES
from tilhero_support.schemas import (
    EscalationIn,
    EscalationOut,
    Priority,
    SlaPoliciesOut,
    SlaPoliciesPut,
    SlaState,
    StaffMessageIn,
    StaffPatchIn,
    StaffTicketOut,
    StaffTicketPage,
    SupportStatsOut,
    TicketOut,
)

router = APIRouter(prefix="/admin/v1/support", tags=["staff"])
admin_bff = InternalAuth({"admin-bff"})
_STAFF_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@:\-]{0,63}$")


def _statuses(raw: str | None) -> list[str] | None:
    """status=open (NEW+IN_PROGRESS+WAITING_CUSTOMER) | all | NEW,IN_PROGRESS,…"""
    if raw is None or raw == "all":
        return None
    if raw == "open":
        return list(OPEN_STATUSES)
    values = [v.strip() for v in raw.split(",") if v.strip()]
    bad = [v for v in values if v not in STATUSES]
    if bad or not values:
        raise unprocessable("SUPPORT_FILTER_INVALID", "Неизвестный статус в фильтре", {"status": bad[:5]})
    return values


@router.get("/tickets", response_model=StaffTicketPage)
async def list_tickets(
    principal: Principal = Depends(admin_bff),
    rt: Runtime = Depends(get_runtime),
    status: str | None = Query(default=None, max_length=120),
    category: str | None = Query(default=None, max_length=40),
    priority: Priority | None = None,
    assignee: str | None = Query(default=None, max_length=64, description="staff id | _me | _none"),
    user_id: uuid.UUID | None = Query(default=None, description="обращения пользователя (карточка в Users)"),
    sla: SlaState | None = None,
    sort: Literal["created", "sla"] = "created",
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=512),
) -> StaffTicketPage:
    actor = principal.require_permission("support.read")
    statuses = _statuses(status)
    if category is not None and category not in CATEGORIES:
        raise unprocessable(
            "SUPPORT_FILTER_INVALID", "Неизвестная категория в фильтре", {"category": category}
        )
    unassigned = assignee == "_none"
    assignee_id = actor.id if assignee == "_me" else (None if unassigned else assignee)
    if assignee_id is not None and not _STAFF_ID.match(assignee_id):
        raise unprocessable("SUPPORT_FILTER_INVALID", "Некорректный идентификатор оператора")
    now = datetime.now(UTC)
    soon = cfg(rt).sla_soon_minutes
    async with rt.transaction() as session:
        rows, next_cursor = await svc.staff_list(
            session,
            statuses=statuses,
            category=category,
            priority=priority,
            assignee=assignee_id,
            unassigned=unassigned,
            user_id=user_id,
            sla=sla,
            sort=sort,
            limit=limit,
            cursor=cursor,
            now=now,
            soon_minutes=soon,
        )
    return StaffTicketPage(items=[svc.staff_summary(t, now, soon) for t in rows], next_cursor=next_cursor)


@router.get("/stats", response_model=SupportStatsOut)
async def stats(
    principal: Principal = Depends(admin_bff),
    rt: Runtime = Depends(get_runtime),
    period: Literal["today", "7d", "30d"] = "today",
) -> SupportStatsOut:
    """Блок «Поддержка» Dashboard: support.read или dashboard.read."""
    actor = principal.actor
    if actor is None:
        raise forbidden("STAFF_CONTEXT_REQUIRED", "Команда доступна только сотрудникам")
    if not {"support.read", "dashboard.read"} & actor.permissions:
        raise forbidden("PERMISSION_DENIED", "Недостаточно прав", {"permission": "dashboard.read"})
    now = datetime.now(UTC)
    if period == "today":
        tz = ZoneInfo(cfg(rt).stats_timezone)
        since = now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    else:
        since = now - timedelta(days=7 if period == "7d" else 30)
    async with rt.transaction() as session:
        return await svc.support_stats(session, since=since, now=now, soon_minutes=cfg(rt).sla_soon_minutes)


@router.get("/tickets/{ticket_ref}/client-view", response_model=TicketOut)
async def client_view(
    ticket_ref: str, principal: Principal = Depends(admin_bff), rt: Runtime = Depends(get_runtime)
) -> TicketOut:
    """«Как видит клиент» (A42): тот же сериализатор и та же выборка, что у клиентского API, — без внутренних
    заметок, user_id и служебных полей. Только чтение: счётчик непрочитанных клиента не сбрасывается."""
    principal.require_permission("support.read")
    async with rt.transaction() as session:
        ticket = await svc.load_ticket(session, ticket_ref)
        messages, history = await svc.load_thread(session, ticket, include_internal=False)
    return svc.client_ticket(ticket, messages, history)


@router.post("/tickets/{ticket_ref}/take", response_model=StaffTicketOut)
async def take(
    ticket_ref: str, principal: Principal = Depends(admin_bff), rt: Runtime = Depends(get_runtime)
) -> StaffTicketOut:
    actor = principal.require_permission("support.reply")
    async with rt.transaction() as session:
        ticket = await svc.staff_take(session, actor=actor, ref=ticket_ref, producer=cfg(rt).service_name)
        return await svc.staff_ticket(session, ticket, datetime.now(UTC), cfg(rt).sla_soon_minutes)


@router.get("/tickets/{ticket_ref}", response_model=StaffTicketOut)
async def get_ticket(
    ticket_ref: str, principal: Principal = Depends(admin_bff), rt: Runtime = Depends(get_runtime)
) -> StaffTicketOut:
    principal.require_permission("support.read")
    async with rt.transaction() as session:
        ticket = await svc.load_ticket(session, ticket_ref)
        return await svc.staff_ticket(session, ticket, datetime.now(UTC), cfg(rt).sla_soon_minutes)


@router.post("/tickets/{ticket_ref}/messages", response_model=StaffTicketOut)
async def post_message(
    ticket_ref: str,
    body: StaffMessageIn,
    principal: Principal = Depends(admin_bff),
    rt: Runtime = Depends(get_runtime),
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
) -> StaffTicketOut:
    actor = principal.require_permission("support.reply")
    key = idempotency_key(idem, required=False)
    async with rt.transaction() as session:
        ticket = await svc.staff_add_message(
            session, actor=actor, ref=ticket_ref, body=body, client_key=key, producer=cfg(rt).service_name
        )
        return await svc.staff_ticket(session, ticket, datetime.now(UTC), cfg(rt).sla_soon_minutes)


@router.patch("/tickets/{ticket_ref}", response_model=StaffTicketOut)
async def patch_ticket(
    ticket_ref: str,
    body: StaffPatchIn,
    principal: Principal = Depends(admin_bff),
    rt: Runtime = Depends(get_runtime),
) -> StaffTicketOut:
    actor = principal.require_permission("support.reply")
    async with rt.transaction() as session:
        ticket = await svc.staff_patch(
            session, actor=actor, ref=ticket_ref, patch=body, producer=cfg(rt).service_name
        )
        return await svc.staff_ticket(session, ticket, datetime.now(UTC), cfg(rt).sla_soon_minutes)


@router.post("/tickets/{ticket_ref}/escalations", response_model=EscalationOut, status_code=201)
async def escalate(
    ticket_ref: str,
    body: EscalationIn,
    response: Response,
    principal: Principal = Depends(admin_bff),
    rt: Runtime = Depends(get_runtime),
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
) -> EscalationOut:
    actor = principal.require_permission("support.reply")
    key = idempotency_key(idem, required=False)
    async with rt.transaction() as session:
        escalation, replayed = await svc.staff_escalate(
            session,
            actor=actor,
            ref=ticket_ref,
            body=body,
            idempotency_key=key,
            producer=cfg(rt).service_name,
        )
    if replayed:
        response.headers["Idempotent-Replayed"] = "true"
    return svc.escalation_out(escalation)


@router.get("/sla-policies", response_model=SlaPoliciesOut)
async def get_sla(
    principal: Principal = Depends(admin_bff), rt: Runtime = Depends(get_runtime)
) -> SlaPoliciesOut:
    principal.require_permission("support.manage")
    async with rt.transaction() as session:
        return await svc.get_sla_policies(session)


@router.put("/sla-policies", response_model=SlaPoliciesOut)
async def put_sla(
    body: SlaPoliciesPut, principal: Principal = Depends(admin_bff), rt: Runtime = Depends(get_runtime)
) -> SlaPoliciesOut:
    actor = principal.require_permission("support.manage")
    async with rt.transaction() as session:
        return await svc.put_sla_policies(session, actor=actor, body=body, producer=cfg(rt).service_name)
