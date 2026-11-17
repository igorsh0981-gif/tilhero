"""Клиентский API (через telegram-bff). Формы ответов = bff.ts; user_id — только из токена."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Query, Response
from sqlalchemy.exc import IntegrityError

from tilhero_common import context
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_support.api.common import CHANNEL_BY_ISSUER, cfg, idempotency_key, user_uuid
from tilhero_support.domain import tickets as svc
from tilhero_support.domain.constants import CATEGORIES, default_priority
from tilhero_support.schemas import (
    CategoryLabel,
    CategoryList,
    CategoryOut,
    CreateTicketIn,
    TicketOut,
    TicketPage,
    UserMessageIn,
)

router = APIRouter(prefix="/internal/v1", tags=["client"])
bff_only = InternalAuth({"telegram-bff"})
any_bff = InternalAuth({"telegram-bff", "admin-bff"})


@router.get("/support/categories", response_model=CategoryList)
async def categories(_: Principal = Depends(any_bff)) -> CategoryList:
    return CategoryList(
        items=[
            CategoryOut(
                code=code,
                label=CategoryLabel(ru=str(meta["ru"]), en=str(meta["en"])),
                available=bool(meta["available"]),
                default_priority=default_priority(code),
            )
            for code, meta in CATEGORIES.items()
        ]
    )


@router.post("/me/tickets", response_model=TicketOut, status_code=201)
async def create_ticket(
    body: CreateTicketIn,
    response: Response,
    principal: Principal = Depends(bff_only),
    rt: Runtime = Depends(get_runtime),
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
) -> TicketOut:
    user_id = user_uuid(principal)
    key = idempotency_key(idem, required=True)
    assert key is not None
    settings = cfg(rt)

    async def attempt() -> tuple[TicketOut, bool]:
        async with rt.transaction() as session:
            ticket, replayed = await svc.create_ticket(
                session,
                user_id=user_id,
                body=body,
                idempotency_key=key,
                channel=CHANNEL_BY_ISSUER.get(principal.issuer, "telegram"),
                correlation_id=context.get_correlation_id(),
                producer=settings.service_name,
                max_open=settings.max_open_tickets,
                max_messages_per_hour=settings.max_user_messages_per_hour,
            )
            messages, history = await svc.load_thread(session, ticket, include_internal=False)
            return svc.client_ticket(ticket, messages, history), replayed

    try:
        out, replayed = await attempt()
    except IntegrityError:
        # Гонка двух первых запросов с одним ключом: уникальный индекс победил — отдаём сохранённый результат
        out, replayed = await attempt()
    if replayed:
        response.headers["Idempotent-Replayed"] = "true"
    return out


@router.get("/me/tickets", response_model=TicketPage)
async def list_tickets(
    principal: Principal = Depends(bff_only),
    rt: Runtime = Depends(get_runtime),
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=512),
) -> TicketPage:
    user_id = user_uuid(principal)
    async with rt.transaction() as session:
        rows, next_cursor = await svc.list_user_tickets(session, user_id, limit=limit, cursor=cursor)
    return TicketPage(items=[svc.client_summary(t) for t in rows], next_cursor=next_cursor)


@router.get("/me/tickets/{ticket_ref}", response_model=TicketOut)
async def get_ticket(
    ticket_ref: str, principal: Principal = Depends(bff_only), rt: Runtime = Depends(get_runtime)
) -> TicketOut:
    user_id = user_uuid(principal)
    async with rt.transaction() as session:
        ticket = await svc.open_user_ticket(session, user_id, ticket_ref)
        messages, history = await svc.load_thread(session, ticket, include_internal=False)
    return svc.client_ticket(ticket, messages, history)


@router.post("/me/tickets/{ticket_ref}/messages", response_model=TicketOut)
async def post_message(
    ticket_ref: str,
    body: UserMessageIn,
    principal: Principal = Depends(bff_only),
    rt: Runtime = Depends(get_runtime),
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
) -> TicketOut:
    user_id = user_uuid(principal)
    key = idempotency_key(idem, required=False)
    async with rt.transaction() as session:
        ticket = await svc.add_user_message(
            session,
            user_id=user_id,
            ref=ticket_ref,
            text_=body.text,
            client_key=key,
            producer=cfg(rt).service_name,
            max_messages_per_hour=cfg(rt).max_user_messages_per_hour,
        )
        messages, history = await svc.load_thread(session, ticket, include_internal=False)
    return svc.client_ticket(ticket, messages, history)


@router.post("/me/tickets/{ticket_ref}/close", response_model=TicketOut)
async def close_ticket(
    ticket_ref: str, principal: Principal = Depends(bff_only), rt: Runtime = Depends(get_runtime)
) -> TicketOut:
    user_id = user_uuid(principal)
    async with rt.transaction() as session:
        ticket = await svc.close_by_user(
            session, user_id=user_id, ref=ticket_ref, producer=rt.settings.service_name
        )
        messages, history = await svc.load_thread(session, ticket, include_internal=False)
    return svc.client_ticket(ticket, messages, history)
