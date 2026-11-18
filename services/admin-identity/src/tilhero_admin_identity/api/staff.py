"""Staff API (admin-bff с actor). Права проверяются здесь по роли сотрудника из БД ∩ actor.permissions (защита
в глубину: admin-bff проверяет тоже; токен может лишь сузить права), инварианты — в домене.
Step-up проверяет admin-bff перед вызовом изменяющих команд."""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import JSONResponse

from tilhero_admin_identity.api.deps import NO_STORE, bff_only, get_identity, require_actor, required_idempotency_key
from tilhero_admin_identity.domain import approvals as approvals_domain
from tilhero_admin_identity.domain import staff as staff_domain
from tilhero_admin_identity.domain.auth import Identity
from tilhero_admin_identity.domain.catalog import RoleCode
from tilhero_admin_identity.domain.store import (
    acting_staff,
    authorize,
    lock_identity,
    require_staff,
    staff_out,
    summaries,
)
from tilhero_admin_identity.schemas import (
    ApprovalDecisionOut,
    ApprovalEnvelope,
    ApprovalGrantEnvelope,
    ApprovalOut,
    ApprovalPage,
    ApprovalStatus,
    DecisionIn,
    LookupOut,
    ReasonIn,
    RolesOut,
    RoleUpdate,
    StaffCreate,
    StaffCreated,
    StaffOut,
    StaffPage,
    StaffPatch,
    TemporaryPassword,
)
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unprocessable
from tilhero_common.internal_auth import Principal
from tilhero_common.redis_tools import IdempotencyStore, fingerprint

router = APIRouter(prefix="/admin/v1", tags=["staff"])

STAFF_MANAGE = "staff.manage"
ROLES_MANAGE = "roles.manage"


# ---------------------------------------------------------------- staff

@router.get("/staff", response_model=StaffPage)
async def list_staff(
    principal: Principal = Depends(bff_only),
    rt: Runtime = Depends(get_runtime),
    q: str | None = Query(default=None, max_length=120),
    role: RoleCode | None = None,
    status: Literal["ACTIVE", "LOCKED", "DISABLED"] | None = None,
    cursor: str | None = Query(default=None, max_length=256),
    limit: int = Query(default=20, ge=1, le=100),
) -> StaffPage:
    actor = require_actor(principal)
    async with rt.transaction() as session:
        await authorize(session, actor, STAFF_MANAGE)
        return await staff_domain.list_staff(session, q=q, role=role, status=status, cursor=cursor, limit=limit)


@router.get("/staff/lookup", response_model=LookupOut)
async def lookup(principal: Principal = Depends(bff_only), rt: Runtime = Depends(get_runtime),
                 ids: str = Query(min_length=1, max_length=4000)) -> LookupOut:
    """Имена сотрудников (например, операторов тикетов) — любой активный сотрудник."""
    actor = require_actor(principal)
    parts = [p.strip() for p in ids.split(",") if p.strip()]
    if not parts or len(parts) > 100:
        raise unprocessable("VALIDATION_ERROR", "Нужно от 1 до 100 идентификаторов",
                            {"errors": [{"loc": ["query", "ids"], "msg": "1..100 ids", "type": "value_error"}]})
    try:
        wanted = [uuid.UUID(p) for p in parts]
    except ValueError as exc:
        raise unprocessable("VALIDATION_ERROR", "Некорректный идентификатор сотрудника",
                            {"errors": [{"loc": ["query", "ids"], "msg": "invalid uuid", "type": "uuid_parsing"}]}
                            ) from exc
    async with rt.transaction() as session:
        await acting_staff(session, actor)  # отключённый/несуществующий сотрудник с живым токеном — 403
        found = await summaries(session, wanted)
    return LookupOut(items=[found[i] for i in dict.fromkeys(wanted) if i in found])


@router.get("/staff/{staff_id}", response_model=StaffOut)
async def get_staff(staff_id: uuid.UUID, principal: Principal = Depends(bff_only),
                    rt: Runtime = Depends(get_runtime)) -> StaffOut:
    actor = require_actor(principal)
    async with rt.transaction() as session:
        await authorize(session, actor, STAFF_MANAGE)
        return staff_out(await require_staff(session, staff_id))


@router.post("/staff", response_model=StaffCreated, status_code=201)
async def create_staff(
    body: StaffCreate,
    principal: Principal = Depends(bff_only),
    rt: Runtime = Depends(get_runtime),
    idn: Identity = Depends(get_identity),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    """Idempotency-Key обязателен (admin.ts): повтор с тем же ключом и телом от того же сотрудника возвращает
    сохранённый ответ без временного пароля (он выдаётся один раз и нигде не хранится). Привилегированная роль —
    temporary_password: null (пароль получит решающий в ответе approve; при waived — автор), ревью P2-1."""
    actor = require_actor(principal)
    async with rt.transaction() as session:  # права — до idempotency (кэш не отдаётся без права)
        await authorize(session, actor, STAFF_MANAGE)
    key = required_idempotency_key(idempotency_key)
    store = IdempotencyStore(idn.redis(rt), f"{idn.settings.redis_namespace}:staff-create")
    fp = fingerprint(body.model_dump(mode="json"))
    cached = await store.begin(actor.id, key, fp)
    if cached is not None:
        return JSONResponse(cached, status_code=201, headers=NO_STORE)
    try:
        async with rt.transaction() as session:
            requester = await authorize(session, actor, STAFF_MANAGE)
            res = await staff_domain.create_staff(session, body, requester, ctx=idn.reset_ctx,
                                                  approval_ttl_hours=idn.settings.approval_ttl_hours)
            approval = await approvals_domain.approval_out(session, res.approval) if res.approval else None
            out = StaffCreated(staff=staff_out(res.staff), temporary_password=res.temporary_password,
                               approval=approval)
    except BaseException:
        await store.abort(actor.id, key)
        raise
    body_json = out.model_dump(mode="json")
    await store.complete(actor.id, key, fp, {**body_json, "temporary_password": None})
    return JSONResponse(body_json, status_code=201, headers=NO_STORE)


@router.patch("/staff/{staff_id}", response_model=StaffOut, responses={202: {"model": ApprovalGrantEnvelope}})
async def patch_staff(staff_id: uuid.UUID, body: StaffPatch, principal: Principal = Depends(bff_only),
                      rt: Runtime = Depends(get_runtime), idn: Identity = Depends(get_identity)) -> JSONResponse:
    """200 Staff — применено сразу; 202 {approval} — заявка (role_grant, privileged_revoke, reactivate_privileged).
    Заявка применена сразу (waived) с выпуском учётных данных — 202 {approval, temporary_password}: пароль цели
    получает автор как единственный решающий (P2-1/P2-2), один раз, no-store."""
    actor = require_actor(principal)
    async with rt.transaction() as session:
        requester = await authorize(session, actor, STAFF_MANAGE)
        res = await staff_domain.patch_staff(session, staff_id, body, requester, ctx=idn.reset_ctx,
                                             approval_ttl_hours=idn.settings.approval_ttl_hours)
        if res.approval is not None:
            envelope = ApprovalGrantEnvelope(approval=await approvals_domain.approval_out(session, res.approval),
                                             temporary_password=res.temporary_password)
            # ключ temporary_password — только когда пароль действительно выдан
            payload = envelope.model_dump(mode="json", exclude={"temporary_password"}
                                          if res.temporary_password is None else None)
            status = 202
        else:
            payload = staff_out(res.staff).model_dump(mode="json")
            status = 200
    if res.changed_email:
        await idn.unlock_login(rt, res.changed_email, res.staff.staff_id)
    return JSONResponse(payload, status_code=status, headers=NO_STORE)


async def _reset(staff_id: uuid.UUID, body: ReasonIn, principal: Principal, rt: Runtime, idn: Identity,
                 action: str) -> JSONResponse:
    actor = require_actor(principal)
    async with rt.transaction() as session:
        requester = await authorize(session, actor, STAFF_MANAGE)
        fn = staff_domain.reset_password if action == "password" else staff_domain.reset_mfa
        res = await fn(session, staff_id, body.reason, requester, ctx=idn.reset_ctx,
                       approval_ttl_hours=idn.settings.approval_ttl_hours)
        applied = res.approval is None or res.approval.status == "APPLIED"
        if res.approval is not None and not applied:
            payload: dict = ApprovalEnvelope(
                approval=await approvals_domain.approval_out(session, res.approval)).model_dump(mode="json")
        elif action == "password":
            payload = {"temporary_password": res.temporary_password}
        else:
            payload = staff_out(res.target).model_dump(mode="json")
        email = res.target.email
    if not applied:  # привилегированная цель — four-eyes (N1): пароль получит решающий, не автор
        return JSONResponse(payload, status_code=202, headers=NO_STORE)
    if action == "password":
        await idn.unlock_login(rt, email)
    else:
        await idn.unlock_mfa(rt, staff_id)  # новое подключение MFA начинается с чистого счётчика
    return JSONResponse(payload, headers=NO_STORE)


@router.post("/staff/{staff_id}/reset-password", response_model=TemporaryPassword,
             responses={202: {"model": ApprovalEnvelope}})
async def reset_password(staff_id: uuid.UUID, body: ReasonIn, principal: Principal = Depends(bff_only),
                         rt: Runtime = Depends(get_runtime), idn: Identity = Depends(get_identity)) -> JSONResponse:
    return await _reset(staff_id, body, principal, rt, idn, "password")


@router.post("/staff/{staff_id}/reset-mfa", response_model=StaffOut, responses={202: {"model": ApprovalEnvelope}})
async def reset_mfa(staff_id: uuid.UUID, body: ReasonIn, principal: Principal = Depends(bff_only),
                    rt: Runtime = Depends(get_runtime), idn: Identity = Depends(get_identity)) -> JSONResponse:
    return await _reset(staff_id, body, principal, rt, idn, "mfa")


# ---------------------------------------------------------------- roles

@router.get("/roles", response_model=RolesOut)
async def list_roles(principal: Principal = Depends(bff_only), rt: Runtime = Depends(get_runtime)) -> RolesOut:
    actor = require_actor(principal)
    async with rt.transaction() as session:
        await authorize(session, actor, STAFF_MANAGE, ROLES_MANAGE)
        return await staff_domain.list_roles(session)


@router.put("/roles/{code}", response_model=ApprovalEnvelope, status_code=202)
async def update_role(code: str, body: RoleUpdate, principal: Principal = Depends(bff_only),
                      rt: Runtime = Depends(get_runtime), idn: Identity = Depends(get_identity)) -> ApprovalEnvelope:
    actor = require_actor(principal)
    async with rt.transaction() as session:
        requester = await authorize(session, actor, ROLES_MANAGE)
        a = await staff_domain.request_role_change(session, code[:32], list(body.permissions), body.reason,
                                                   requester, approval_ttl_hours=idn.settings.approval_ttl_hours)
        return ApprovalEnvelope(approval=await approvals_domain.approval_out(session, a))


# ---------------------------------------------------------------- approvals

@router.get("/approvals", response_model=ApprovalPage)
async def list_approvals(
    principal: Principal = Depends(bff_only),
    rt: Runtime = Depends(get_runtime),
    status: ApprovalStatus | None = None,
    cursor: str | None = Query(default=None, max_length=256),
    limit: int = Query(default=20, ge=1, le=100),
) -> ApprovalPage:
    actor = require_actor(principal)
    async with rt.transaction() as session:
        await authorize(session, actor, STAFF_MANAGE, ROLES_MANAGE)
        return await approvals_domain.list_page(session, status=status, cursor=cursor, limit=limit)


async def _decide(approval_id: uuid.UUID, body: DecisionIn, principal: Principal, rt: Runtime, idn: Identity,
                  approve: bool) -> JSONResponse:
    actor = require_actor(principal)
    async with rt.transaction() as session:
        # права токена ∩ роли из БД (токен может только сузить); решающий — super_admin по БД (domain.decide)
        decider = await authorize(session, actor, STAFF_MANAGE, ROLES_MANAGE)
        await lock_identity(session)
        a, deferred, temp = await approvals_domain.decide(session, approval_id, decider, approve=approve,
                                                          note=body.note, ctx=idn.reset_ctx)
        out = await approvals_domain.approval_out(session, a) if a is not None else None
        # сброс применён (N1) или учётные данные цели выпущены заново (P2-1/P2-2) — счётчики попыток цели с нуля
        reset = (a.payload.get("action"), uuid.UUID(a.payload["staff_id"]), a.summary["staff"]["email"]) \
            if a is not None and a.kind in approvals_domain.UNLOCK_KINDS and a.status == "APPLIED" else None
    if deferred is not None:
        raise deferred
    assert out is not None
    if reset is not None:
        action, target_id, email = reset
        if action == "password":
            await idn.unlock_login(rt, email)
        elif action == "mfa":
            await idn.unlock_mfa(rt, target_id)
        else:
            await idn.unlock_login(rt, email, target_id)
    payload = out.model_dump(mode="json")
    if temp is not None:
        # ApprovalDecision: временный пароль — только решающему, один раз (N1); не кэшируется
        payload["temporary_password"] = temp
    return JSONResponse(payload, headers=NO_STORE)


@router.post("/approvals/{approval_id}/approve", response_model=ApprovalDecisionOut)
async def approve(approval_id: uuid.UUID, body: DecisionIn, principal: Principal = Depends(bff_only),
                  rt: Runtime = Depends(get_runtime), idn: Identity = Depends(get_identity)) -> JSONResponse:
    return await _decide(approval_id, body, principal, rt, idn, approve=True)


@router.post("/approvals/{approval_id}/reject", response_model=ApprovalOut)
async def reject(approval_id: uuid.UUID, body: DecisionIn, principal: Principal = Depends(bff_only),
                 rt: Runtime = Depends(get_runtime), idn: Identity = Depends(get_identity)) -> JSONResponse:
    return await _decide(approval_id, body, principal, rt, idn, approve=False)
