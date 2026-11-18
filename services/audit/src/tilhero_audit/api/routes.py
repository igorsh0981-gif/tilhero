from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select

from tilhero_audit.domain import append, decode_cursor, encode_cursor, verify_chain
from tilhero_audit.models import AuditRecord
from tilhero_audit.schemas import ChainVerification, RecordIn, RecordOut, RecordPage, RecordWriteIn
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import bad_request, conflict, forbidden, not_found
from tilhero_common.internal_auth import InternalAuth, Principal

router = APIRouter()

# Синхронный аудит (запись ДО выдачи результата). Доменные сервисы TilHero пишут аудит событием
# admin.audit.recorded.v1 через outbox (consumers.AUDIT_EVENT_PRODUCERS); по HTTP — только перечисленные здесь,
# явно, по принципу минимальных прав (остальные → 403 CALLER_NOT_ALLOWED до разбора тела).
# Спринт 2 (docs/sprint2/INTERNAL_API.md §3 «audit»): identity-consent (раскрытие Telegram ID — запись до выдачи
# значения). admin-identity пишет аудит только событием через outbox — HTTP-права у него нет (ревью спринта 2).
# admin-bff — только собственные действия BFF от имени сотрудника из actor-токена (dev.impersonate в ENV=dev,
# резервная запись auth.logout, когда admin-identity недоступен) — список ONLY_ACTIONS.
WRITERS: frozenset[str] = frozenset({"identity-consent", "admin-bff"})
ONLY_ACTIONS: dict[str, frozenset[str]] = {"admin-bff": frozenset({"dev.impersonate", "auth.logout"})}
# Делегирование (сотрудник в теле, on_behalf_of) — узкое исключение: издатель + перечисленные действия, которые он
# пишет синхронно от имени сотрудника (claim actor принимается только от admin-bff, поэтому домен передаёт сотрудника
# из своего actor-токена в теле). identity-consent: раскрытие Telegram ID ученика (`sensitive.view`, без записи значение
# не выдаётся) и отказ по лимиту раскрытий (`sensitive.view_rate_limited`).
DELEGATION: dict[str, frozenset[str]] = {
    "identity-consent": frozenset({"sensitive.view", "sensitive.view_rate_limited"}),
}
writer = InternalAuth(set(WRITERS))
admin_only = InternalAuth({"admin-bff"})


def actor_from_token(principal: Principal, body: RecordWriteIn | None = None) -> dict[str, Any]:
    """Кто действовал — из подписанного токена издателя; тело может указать сотрудника (on_behalf_of) только
    по списку DELEGATION (издатель + действие) и только без собственного actor/sub в токене."""
    delegated = body.on_behalf_of if body is not None else None
    if delegated is not None:
        allowed = DELEGATION.get(principal.issuer, frozenset())
        if body is None or body.action not in allowed or principal.actor is not None or principal.subject:
            raise forbidden("DELEGATION_NOT_ALLOWED",
                            "Указывать сотрудника в теле нельзя для этого сервиса или действия")
        return {"actor_type": "staff", "actor_id": delegated.actor_id, "actor_role": delegated.actor_role}
    if principal.actor is not None:  # claim actor принимается только от admin-bff (internal_auth)
        return {"actor_type": "staff", "actor_id": principal.actor.id[:64], "actor_role": principal.actor.role[:64]}
    if principal.subject:
        return {"actor_type": "user", "actor_id": principal.subject[:64], "actor_role": None}
    return {"actor_type": "service", "actor_id": principal.issuer[:64], "actor_role": None}


@router.post("/internal/v1/records", response_model=RecordOut, status_code=201, tags=["internal"])
async def write_record(
    body: RecordWriteIn, principal: Principal = Depends(writer), rt: Runtime = Depends(get_runtime)
) -> RecordOut:
    only = ONLY_ACTIONS.get(principal.issuer)
    if only is not None and (body.action not in only or principal.actor is None):
        raise forbidden("ACTION_NOT_ALLOWED", "Этот сервис не может писать такое действие")
    record_in = RecordIn(**body.model_dump(exclude={"on_behalf_of"}), **actor_from_token(principal, body))
    async with rt.transaction() as session:
        record = await append(session, record_in, source=principal.issuer)
        if record.source != principal.issuer:
            # повтор record_id идемпотентен только для своего издателя: чужую запись по её id не прочитать
            raise conflict("AUDIT_RECORD_CONFLICT", "Запись с таким record_id уже существует")
        return RecordOut.model_validate(record)


@router.get("/admin/v1/audit/records", response_model=RecordPage, tags=["staff"])
async def list_records(
    request: Request,
    principal: Principal = Depends(admin_only),
    rt: Runtime = Depends(get_runtime),
    action: str | None = Query(default=None, max_length=80),
    actor_id: str | None = Query(default=None, max_length=64),
    object_type: str | None = Query(default=None, max_length=64),
    object_id: str | None = Query(default=None, max_length=128),
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = None,
) -> RecordPage:
    principal.require_permission("audit.read")
    stmt = select(AuditRecord).order_by(AuditRecord.seq.desc()).limit(limit + 1)
    if action:
        stmt = stmt.where(AuditRecord.action == action)
    if actor_id:
        stmt = stmt.where(AuditRecord.actor_id == actor_id)
    if object_type:
        stmt = stmt.where(AuditRecord.object_type == object_type)
    if object_id:
        stmt = stmt.where(AuditRecord.object_id == object_id)
    if date_from:
        stmt = stmt.where(AuditRecord.occurred_at >= date_from)
    if date_to:
        stmt = stmt.where(AuditRecord.occurred_at <= date_to)
    if cursor:
        try:
            stmt = stmt.where(AuditRecord.seq < decode_cursor(cursor))
        except Exception as exc:
            raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc
    async with rt.transaction() as session:
        rows = (await session.execute(stmt)).scalars().all()
    items = [RecordOut.model_validate(r) for r in rows[:limit]]
    next_cursor = encode_cursor(rows[limit - 1].seq) if len(rows) > limit else None
    return RecordPage(items=items, next_cursor=next_cursor)


@router.get("/admin/v1/audit/records/{record_id}", response_model=RecordOut, tags=["staff"])
async def get_record(
    record_id: uuid.UUID, principal: Principal = Depends(admin_only), rt: Runtime = Depends(get_runtime)
) -> RecordOut:
    principal.require_permission("audit.read")
    async with rt.transaction() as session:
        rec = (await session.execute(select(AuditRecord).where(AuditRecord.record_id == record_id))).scalar()
    if rec is None:
        raise not_found("AUDIT_RECORD_NOT_FOUND", "Запись журнала не найдена")
    return RecordOut.model_validate(rec)


@router.get("/admin/v1/audit/verify", response_model=ChainVerification, tags=["staff"])
async def verify(principal: Principal = Depends(admin_only), rt: Runtime = Depends(get_runtime)) -> ChainVerification:
    principal.require_permission("audit.read")
    async with rt.transaction() as session:
        return await verify_chain(session)
