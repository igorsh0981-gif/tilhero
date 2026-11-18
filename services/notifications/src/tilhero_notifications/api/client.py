"""Центр уведомлений (INTERNAL_API §4) — вызывает только telegram-bff; `sub` = ученик (для детского профиля — его
записи). user_id — только из токена (IDOR): чужие записи не видны и не отмечаются прочитанными."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import cast

from fastapi import APIRouter, Depends, Query, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unauthorized
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_notifications import broadcasts, store
from tilhero_notifications.domain.pagination import decode_cursor, encode_cursor
from tilhero_notifications.models import Notification
from tilhero_notifications.schemas import InboxItem, InboxPage, InboxReadIn, UnreadOut
from tilhero_notifications.settings import Settings

router = APIRouter(prefix="/internal/v1/me", tags=["client"])
bff_only = InternalAuth({"telegram-bff"})


def learner_id(principal: Principal) -> uuid.UUID:
    try:
        return uuid.UUID(principal.user_id)
    except ValueError as exc:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from exc


def _horizon(rt: Runtime, now: datetime) -> datetime:
    return now - timedelta(days=cast(Settings, rt.settings).retention_days)


def _item(n: Notification) -> InboxItem:
    return InboxItem(
        notification_id=n.notification_id,
        category=n.category,  # type: ignore[arg-type]
        title=n.title or "",
        body=n.body or "",
        startapp=n.startapp,
        created_at=n.created_at,
        read_at=n.read_at,
        telegram=n.telegram_status,  # type: ignore[arg-type]
    )


async def _unread(rt: Runtime, user: uuid.UUID, now: datetime) -> int:
    async with rt.transaction() as session:
        return await store.unread_count(session, user, not_older=_horizon(rt, now))


@router.get("/inbox", response_model=InboxPage)
async def inbox(
    request: Request,
    principal: Principal = Depends(bff_only),
    rt: Runtime = Depends(get_runtime),
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=512),
) -> InboxPage:
    user = learner_id(principal)
    after = decode_cursor(cursor) if cursor else None
    now = datetime.now(UTC)
    await broadcasts.sync(rt, user, now, request.app.state.templates)
    async with rt.transaction() as session:
        rows = await store.inbox_page(session, user, limit=limit, after=after, not_older=_horizon(rt, now))
    page = rows[:limit]
    next_cursor = encode_cursor(page[-1].created_at, page[-1].notification_id) if len(rows) > limit else None
    return InboxPage(items=[_item(n) for n in page], next_cursor=next_cursor)


@router.get("/inbox/unread-count", response_model=UnreadOut)
async def unread_count(
    request: Request, principal: Principal = Depends(bff_only), rt: Runtime = Depends(get_runtime)
) -> UnreadOut:
    user = learner_id(principal)
    now = datetime.now(UTC)
    await broadcasts.sync(rt, user, now, request.app.state.templates)
    return UnreadOut(unread=await _unread(rt, user, now))


@router.post("/inbox:read", response_model=UnreadOut)
async def mark_read(
    body: InboxReadIn, request: Request, principal: Principal = Depends(bff_only), rt: Runtime = Depends(get_runtime)
) -> UnreadOut:
    """Идемпотентно: повтор не меняет read_at; неизвестные и чужие id игнорируются (без раскрытия)."""
    user = learner_id(principal)
    now = datetime.now(UTC)
    await broadcasts.sync(rt, user, now, request.app.state.templates)
    async with rt.transaction() as session:
        await store.mark_read(
            session, user, ids=None if body.all else body.ids, now=now, not_older=_horizon(rt, now)
        )
    return UnreadOut(unread=await _unread(rt, user, now))
