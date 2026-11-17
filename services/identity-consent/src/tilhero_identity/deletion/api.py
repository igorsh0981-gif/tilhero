"""API саги удаления (INTERNAL_API §1.4).

- `GET /admin/v1/deletions`, `GET /admin/v1/deletions/{request_id}` — admin-bff с actor и правом `users.read`;
- `POST /admin/v1/deletions/{request_id}:retry` — admin-bff, `ops.queues.manage` (step-up — admin-bff),
  `Idempotency-Key`, `{reason}` 3..300 → синхронный аудит `user.deletion.retry` **до** повтора (audit недоступен →
  503 AUDIT_UNAVAILABLE, ничего не меняется) → внеочередной повтор → `DeletionDetail`. Закрытый → 409
  DELETION_NOT_OPEN; чаще раза в `DELETION_MANUAL_RETRY_MIN_SECONDS` → 409 DELETION_RETRY_TOO_SOON {retry_after}.
  Повтор с тем же ключом и телом — тот же ответ и `Idempotent-Replayed: true` без нового аудита и рассылки;
  тот же ключ с другим телом — 422 IDEMPOTENCY_KEY_REUSED;
- `GET /internal/v1/deletions:stats` — только ops-monitor, без контекста пользователя и сотрудника.

Принудительного завершения удаления без ACK доменов нет — ни в API, ни в коде.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.context import get_correlation_id
from tilhero_common.errors import ApiError, conflict, forbidden, not_found, unprocessable
from tilhero_common.internal_auth import Actor, InternalAuth, Principal
from tilhero_common.redis_tools import fingerprint
from tilhero_identity.deletion import saga, store
from tilhero_identity.deletion.models import DeletionIdempotencyKey, DeletionRequest
from tilhero_identity.deletion.schemas import DeletionDetail, DeletionPage, DeletionRetryIn, DeletionStats
from tilhero_identity.settings import Settings

log = logging.getLogger("tilhero.identity.deletion")

PERM_READ = "users.read"
PERM_RETRY = "ops.queues.manage"
AUDIT_ACTION = "user.deletion.retry"
AUDIT_CLIENT = "audit"
_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,128}$")
_RECORD_NS = uuid.UUID("5d1e7c2a-9b40-4f6e-8a31-0c9d2e7f4b18")

admin_bff_only = InternalAuth({"admin-bff"})
ops_monitor_only = InternalAuth({"ops-monitor"})

admin_router = APIRouter(prefix="/admin/v1/deletions", tags=["admin", "deletion"])
internal_router = APIRouter(prefix="/internal/v1", tags=["internal", "deletion"])


def _now() -> datetime:
    return datetime.now(UTC)


def _not_found() -> ApiError:
    return not_found("DELETION_NOT_FOUND", "Запрос удаления не найден")


def audit_unavailable() -> ApiError:
    return ApiError(503, "AUDIT_UNAVAILABLE", "Журнал аудита недоступен — изменение не выполнено", {"service": "audit"})


def _idempotency_key(value: str | None) -> str:
    if value is None:
        raise ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key")
    if not _IDEMPOTENCY_RE.match(value):
        raise unprocessable("IDEMPOTENCY_KEY_INVALID",
                            "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)")
    return value


async def _write_audit(rt: Runtime, *, actor: Actor, key: str, req: DeletionRequest, reason: str,
                       at: datetime) -> None:
    """Синхронная запись `user.deletion.retry` от имени сотрудника (on_behalf_of: claim actor audit принимает только от
    admin-bff). record_id выводится из (сотрудник, ключ, действие, запрос): повтор после сбоя не дублирует запись."""
    record_id = uuid.uuid5(_RECORD_NS, f"{actor.id[:64]}|{key}|{AUDIT_ACTION}|{req.request_id}")
    pending = saga.pending_domains(req.expected_domains, req.acked_domains)
    client = rt.clients.get(AUDIT_CLIENT)
    if client is None:
        raise audit_unavailable()
    try:
        await client.post("/internal/v1/records", json={
            "record_id": str(record_id),
            "occurred_at": at.isoformat().replace("+00:00", "Z"),
            "action": AUDIT_ACTION,
            "object_type": "deletion_request",
            "object_id": str(req.request_id),
            "before": {"status": req.status, "attempts": req.attempts, "pending_domains": pending},
            "after": {"attempt": req.attempts + 1, "user_id": str(req.user_id)},
            "reason": reason,
            "trace_id": get_correlation_id()[:64],
            "on_behalf_of": {"actor_id": actor.id[:64], "actor_role": actor.role[:64]},
        }, idempotency_key=str(record_id))
    except Exception as exc:
        log.warning("audit write failed, deletion retry not applied",
                    extra={"error_type": type(exc).__name__, "status": getattr(exc, "status", None),
                           "error_code": getattr(exc, "code", None)})
        raise audit_unavailable() from None


async def _replay(session: AsyncSession, actor_id: str, idem: str, fp: str) -> JSONResponse | None:
    """Ключ уже использован: тот же запрос → прежний ответ (Idempotent-Replayed); другое тело → 422."""
    row = (await session.execute(
        select(DeletionIdempotencyKey)
        .where(DeletionIdempotencyKey.actor_id == actor_id, DeletionIdempotencyKey.key == idem)
    )).scalar_one_or_none()
    if row is None:
        return None
    if row.fingerprint != fp:
        raise unprocessable("IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными")
    return JSONResponse(row.response, status_code=row.status_code or 200, headers={"Idempotent-Replayed": "true"})


def _check_retry(req: DeletionRequest | None, now: datetime, settings: Settings) -> DeletionRequest:
    if req is None:
        raise _not_found()
    if not saga.can_retry(req.status):
        raise conflict("DELETION_NOT_OPEN", "Удаление уже завершено — повторять нечего", {"status": req.status})
    wait = saga.manual_retry_wait(req.last_sent_at, now, settings.deletion_manual_retry_min_seconds)
    if wait > 0:
        raise conflict("DELETION_RETRY_TOO_SOON", "Запрос удаления отправлялся недавно — повторите позже",
                       {"retry_after": wait})
    return req


async def retry_deletion(rt: Runtime, *, request_id: uuid.UUID, actor: Actor, key: str | None,
                         reason: str) -> JSONResponse:
    """Ручной повтор (§1.4). Синхронный аудит идёт ДО действия, но не под блокировкой строки (ревью спринта 9): сетевой
    вызов audit не держит FOR UPDATE запроса, на котором ждут ACK доменов. Порядок: проверка без блокировки → аудит
    (record_id детерминирован — повтор не дублирует запись) → ключ + FOR UPDATE → повторная проверка → рассылка."""
    settings: Settings = rt.settings  # type: ignore[assignment]
    idem = _idempotency_key(key)
    fp = fingerprint({"op": AUDIT_ACTION, "request_id": str(request_id), "reason": reason})
    actor_id = actor.id[:64]
    # 1. без блокировки: повтор ключа, существование, «открыт», не чаще раза в N с
    async with rt.transaction() as session:
        # сначала запрос, потом ключ: параллельный тот же ключ коммитит рассылку и ответ ключа вместе — если запрос
        # уже прочитан «после», ключ тоже будет виден, и повтор вернёт прежний ответ, а не 409 TOO_SOON
        current = await session.get(DeletionRequest, request_id)
        replay = await _replay(session, actor_id, idem, fp)
        if replay is not None:
            return replay
        req = _check_retry(current, _now(), settings)
        snapshot = DeletionRequest(request_id=req.request_id, user_id=req.user_id, status=req.status,
                                   attempts=req.attempts, expected_domains=list(req.expected_domains),
                                   acked_domains=list(req.acked_domains))
    # 2. аудит до действия, вне транзакции
    now = _now()
    await _write_audit(rt, actor=actor, key=idem, req=snapshot, reason=reason, at=now)
    # 3. ключ, блокировка и повторная проверка: пока шёл аудит, запрос могли завершить или повторить
    async with rt.transaction() as session:
        claimed = (await session.execute(
            pg_insert(DeletionIdempotencyKey).values(actor_id=actor_id, key=idem, fingerprint=fp)
            .on_conflict_do_nothing().returning(DeletionIdempotencyKey.key)
        )).first()
        if claimed is None:  # параллельный запрос с тем же ключом успел первым
            replay = await _replay(session, actor_id, idem, fp)
            if replay is not None:
                return replay
        locked = (await session.execute(
            select(DeletionRequest).where(DeletionRequest.request_id == request_id).with_for_update()
        )).scalar_one_or_none()
        req = _check_retry(locked, _now(), settings)
        await store.send_retry(session, req, now=now, by=actor_id, schedule=settings.deletion_retry_schedule)
        body: dict[str, Any] = (await store.detail_view(session, req)).model_dump(mode="json")
        row = (await session.execute(
            select(DeletionIdempotencyKey)
            .where(DeletionIdempotencyKey.actor_id == actor_id, DeletionIdempotencyKey.key == idem)
        )).scalar_one()
        row.status_code = 200
        row.response = body
    return JSONResponse(body, status_code=200)


# ---------------------------------------------------------------- маршруты

@admin_router.get("", response_model=DeletionPage)
async def list_deletions(
    principal: Principal = Depends(admin_bff_only),
    rt: Runtime = Depends(get_runtime),
    status: Literal["open", "stuck", "completed"] | None = Query(default=None),
    cursor: str | None = Query(default=None, max_length=256),
    limit: int = Query(default=20, ge=1, le=100),
) -> DeletionPage:
    principal.require_permission(PERM_READ)
    async with rt.transaction() as session:
        return await store.list_requests(session, status=status, cursor=cursor, limit=limit)


@admin_router.get("/{request_id}", response_model=DeletionDetail)
async def get_deletion(
    request_id: uuid.UUID,
    principal: Principal = Depends(admin_bff_only),
    rt: Runtime = Depends(get_runtime),
) -> DeletionDetail:
    principal.require_permission(PERM_READ)
    async with rt.transaction() as session:
        req = await session.get(DeletionRequest, request_id)
        if req is None:
            raise _not_found()
        return await store.detail_view(session, req)


@admin_router.post("/{request_id}:retry", response_model=DeletionDetail)
async def retry(
    request_id: uuid.UUID,
    body: DeletionRetryIn,
    principal: Principal = Depends(admin_bff_only),
    rt: Runtime = Depends(get_runtime),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    actor = principal.require_permission(PERM_RETRY)
    return await retry_deletion(rt, request_id=request_id, actor=actor, key=idempotency_key, reason=body.reason)


@internal_router.get("/deletions:stats", response_model=DeletionStats)
async def deletion_stats(
    principal: Principal = Depends(ops_monitor_only),
    rt: Runtime = Depends(get_runtime),
) -> DeletionStats:
    if principal.actor is not None or principal.subject:
        raise forbidden("CALLER_CONTEXT_NOT_ALLOWED", "Вызов допускается только без контекста пользователя")
    async with rt.transaction() as session:
        return await store.stats(session)
