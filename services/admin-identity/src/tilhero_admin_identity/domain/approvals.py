"""Four-eyes: заявки на привилегированные изменения (назначение привилегированной роли, создание
привилегированного сотрудника, изменение матрицы прав).

- Решает второй активный super_admin (≠ автор), применение — в той же транзакции, что и решение.
- Срок заявки — 72 ч (истёкшие помечаются EXPIRED лениво — при любом обращении к заявкам).
- Исключение: автор — единственный активный super_admin → применяется сразу, waived="single_super_admin", аудит.
  Не действует, если автор сам понижал/отключал super_admin (staff.privileged_revoke) за последние 72 ч —
  иначе «стать единственным» и затем раздать роли без второго человека (B1).
- Понижение/отключение super_admin при ≥ 2 активных — только заявкой staff.privileged_revoke.
- Сброс пароля/MFA привилегированного сотрудника — заявкой staff.privileged_reset (N1): временный пароль
  генерируется при применении и выдаётся только решающему; для цели-super_admin исключение не действует никогда.
- Включение (DISABLED → ACTIVE) сотрудника с привилегированной ролью — заявкой staff.reactivate_privileged (P2-2).
- При применении staff.create_privileged, staff.role_grant и staff.reactivate_privileged учётные данные цели
  аннулируются (новый временный пароль, сброс MFA и сессий, P2-1): пароль — решающему, при waived — автору.
- Заявку автора, который уже не ACTIVE, согласовать нельзя; при отключении сотрудника его PENDING-заявки → REJECTED.
- Не больше одной PENDING-заявки на объект (частичный UNIQUE по target).
- staff.create_privileged отклонена или истекла: учётка-заглушка (роль-заглушка, ACTIVE, без пароля) — «мёртвая»,
  переводится в DISABLED с аудитом staff.disabled (ревью P2-1, замечание без оценки). Истечение фиксируется лениво —
  при обращении к заявкам и сотрудникам (список, карточка, команды) — под lock_identity (порядок как у команд).
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_admin_identity.domain import audit
from tilhero_admin_identity.domain.catalog import SUPER_ADMIN, privileged_by
from tilhero_admin_identity.domain.policy import mask_email
from tilhero_admin_identity.domain.resets import (
    ResetContext,
    apply_credentials_reset,
    apply_mfa_reset,
    apply_password_reset,
)
from tilhero_admin_identity.domain.store import (
    active_super_admin_ids,
    bump_session,
    decode_cursor,
    encode_cursor,
    ensure_not_last_super_admin,
    get_role,
    get_staff,
    is_privileged,
    lock_identity,
    now,
    role_permissions,
    summaries,
)
from tilhero_admin_identity.models import Approval, RolePermission, Staff
from tilhero_admin_identity.schemas import ApprovalOut, ApprovalPage
from tilhero_common.errors import ApiError, conflict, forbidden, not_found

WAIVED = "single_super_admin"
REVOKE = "staff.privileged_revoke"
RESET = "staff.privileged_reset"
REACTIVATE = "staff.reactivate_privileged"
CREATE_PRIVILEGED = "staff.create_privileged"
ROLE_GRANT = "staff.role_grant"
# Заявки, при применении которых у цели аннулируются учётные данные и выдаётся новый временный пароль (P2-1, P2-2)
CREDENTIAL_KINDS = frozenset({CREATE_PRIVILEGED, ROLE_GRANT, REACTIVATE})
# Заявки, после применения которых сбрасываются счётчики попыток входа/MFA цели
UNLOCK_KINDS = CREDENTIAL_KINDS | {RESET}
# Причина отключения учётки-заглушки (аудит staff.disabled), по исходу заявки staff.create_privileged
PLACEHOLDER_DISABLED_REASON = {
    "REJECTED": "Заявка на создание сотрудника отклонена",
    "EXPIRED": "Заявка на создание сотрудника истекла",
}


def audit_summary(summary: dict[str, Any]) -> dict[str, Any]:
    """Сводка заявки для журнала: email сотрудника — только маской (в ответе API — полностью, для решающего)."""
    out = dict(summary)
    staff = out.get("staff")
    if isinstance(staff, dict) and isinstance(staff.get("email"), str):
        out["staff"] = {**staff, "email": mask_email(staff["email"])}
    return out


def approval_out_with(a: Approval, people: dict[uuid.UUID, Any]) -> ApprovalOut:
    return ApprovalOut(
        approval_id=a.approval_id, kind=a.kind, status=a.status, summary=a.summary,  # type: ignore[arg-type]
        reason=a.reason, requested_by=people[a.requested_by], requested_at=a.requested_at,
        decided_by=people.get(a.decided_by) if a.decided_by else None, decided_at=a.decided_at,
        decision_note=a.decision_note, waived=a.waived, expires_at=a.expires_at,  # type: ignore[arg-type]
    )


async def approval_out(session: AsyncSession, a: Approval) -> ApprovalOut:
    people = await summaries(session, [a.requested_by, *([a.decided_by] if a.decided_by else [])])
    return approval_out_with(a, people)


async def expire_overdue(session: AsyncSession) -> None:
    """PENDING с истёкшим сроком → EXPIRED; у истёкших staff.create_privileged отключаются заглушки. Блокировка
    lock_identity берётся, только если есть что помечать (повторный захват в той же транзакции безопасен)."""
    due = (Approval.status == "PENDING", Approval.expires_at <= now())
    if (await session.execute(select(Approval.approval_id).where(*due).limit(1))).first() is None:
        return
    await lock_identity(session)  # порядок как у команд: lock_identity → заявки → сотрудники
    expired = (await session.execute(
        update(Approval).where(*due).values(status="EXPIRED").returning(Approval.approval_id, Approval.kind)
        .execution_options(synchronize_session=False)
    )).all()
    for approval_id, kind in expired:
        if kind != CREATE_PRIVILEGED:
            continue
        a = await session.get(Approval, approval_id, populate_existing=True)
        if a is not None:
            await disable_placeholder(session, a, None)


async def disable_placeholder(session: AsyncSession, a: Approval, by: Staff | None) -> None:
    """Заявка staff.create_privileged отклонена или истекла → учётка-заглушка в DISABLED (аудит staff.disabled,
    причина — исход заявки; при истечении — системное действие). Заглушку уже изменили (роль, статус, выдан пароль
    прямым сбросом) — это обычный сотрудник, не трогаем."""
    if a.kind != CREATE_PRIVILEGED or a.status not in PLACEHOLDER_DISABLED_REASON:
        return
    p = a.payload
    target = await get_staff(session, uuid.UUID(p["staff_id"]), for_update=True)
    if (target is None or target.status != "ACTIVE" or target.role != p["placeholder_role"]
            or target.password_hash is not None):
        return
    target.status = "DISABLED"
    bump_session(target)
    await audit.record(session, "staff.disabled", actor_id=by.staff_id if by else None,
                       actor_role=by.role if by else None, object_type="staff", object_id=target.staff_id,
                       before={"status": "ACTIVE", "role": target.role},
                       after={"status": "DISABLED", "approval_id": str(a.approval_id),
                              "approval_status": a.status},
                       reason=PLACEHOLDER_DISABLED_REASON[a.status])
    await session.flush()


async def pending_for(session: AsyncSession, target: str) -> Approval | None:
    stmt = select(Approval).where(Approval.target == target, Approval.status == "PENDING")
    return (await session.execute(stmt)).scalar_one_or_none()


async def create(*args: Any, **kw: Any) -> Approval:
    a, _ = await create_ex(*args, **kw)
    return a


async def create_ex(
    session: AsyncSession,
    *,
    kind: str,
    target: str,
    payload: dict[str, Any],
    summary: dict[str, Any],
    reason: str,
    requester: Staff,
    ttl_hours: int,
    ctx: ResetContext | None = None,
    waivable: bool = True,
) -> tuple[Approval, str | None]:
    """Вызывающий держит lock_identity. → (заявка PENDING либо APPLIED с waived, временный пароль при
    немедленном применении сброса пароля — его получает сам автор как единственный super_admin)."""
    temp: str | None = None
    await expire_overdue(session)
    if await pending_for(session, target) is not None:
        raise conflict("APPROVAL_PENDING", "По этому объекту уже есть заявка на согласовании")
    at = now()
    a = Approval(
        approval_id=uuid.uuid4(), kind=kind, target=target, payload=payload, summary=summary, reason=reason,
        status="PENDING", requested_by=requester.staff_id, requested_at=at,
        expires_at=at + timedelta(hours=ttl_hours),
    )
    session.add(a)
    await session.flush()
    await audit.record(session, _requested_action(kind),
                       actor_id=requester.staff_id, actor_role=requester.role, object_type="approval",
                       object_id=a.approval_id, after={"kind": kind, "summary": audit_summary(summary)}, reason=reason)
    supers = await active_super_admin_ids(session)
    if (waivable and kind != REVOKE and requester.role == SUPER_ADMIN and requester.status == "ACTIVE"
            and supers == [requester.staff_id]
            and not await revoked_super_admin_recently(session, requester.staff_id, hours=ttl_hours)):
        temp = await _apply(session, a, requester, ctx)
        a.status = "APPLIED"
        a.waived = WAIVED
        a.decided_at = now()
        await audit.record(session, "approval.waived", actor_id=requester.staff_id, actor_role=requester.role,
                           object_type="approval", object_id=a.approval_id,
                           after={"kind": kind, "waived": WAIVED}, reason=reason)
        await audit.record(session, "approval.applied", actor_id=requester.staff_id, actor_role=requester.role,
                           object_type="approval", object_id=a.approval_id,
                           after={"kind": kind, "summary": audit_summary(summary), "waived": WAIVED})
        await session.flush()
    return a, temp


async def revoked_super_admin_recently(session: AsyncSession, staff_id: uuid.UUID, *, hours: int) -> bool:
    stmt = select(Approval.approval_id).where(
        Approval.kind == REVOKE, Approval.requested_by == staff_id, Approval.status == "APPLIED",
        Approval.decided_at > now() - timedelta(hours=hours),
    ).limit(1)
    return (await session.execute(stmt)).scalar_one_or_none() is not None


async def supersede_pending(session: AsyncSession, target: str, by: Staff, *, cause: str) -> None:
    """PENDING-заявки на сброс по объекту → REJECTED (с аудитом), когда сброс выполнен другим путём."""
    await expire_overdue(session)
    rows = (await session.execute(
        select(Approval).where(Approval.target == target, Approval.kind == RESET, Approval.status == "PENDING")
        .with_for_update()
    )).scalars().all()
    for a in rows:
        a.status = "REJECTED"
        a.decided_by = by.staff_id
        a.decided_at = now()
        a.decision_note = "Заменена перевыпуском временного пароля"
        await audit.record(session, "approval.rejected", actor_id=by.staff_id, actor_role=by.role,
                           object_type="approval", object_id=a.approval_id,
                           after={"kind": a.kind, "summary": audit_summary(a.summary), "cause": cause})
    await session.flush()


async def reject_pending_of(session: AsyncSession, author: Staff, by: Staff, *, cause: str) -> None:
    """Отключённый сотрудник не может оставлять «висящие» заявки: его PENDING-заявки отклоняются."""
    rows = (await session.execute(
        select(Approval).where(Approval.requested_by == author.staff_id, Approval.status == "PENDING")
        .with_for_update()
    )).scalars().all()
    for a in rows:
        a.status = "REJECTED"
        a.decided_by = by.staff_id
        a.decided_at = now()
        a.decision_note = "Автор заявки отключён"
        await audit.record(session, "approval.rejected", actor_id=by.staff_id, actor_role=by.role,
                           object_type="approval", object_id=a.approval_id,
                           after={"kind": a.kind, "summary": audit_summary(a.summary), "cause": cause})
        await disable_placeholder(session, a, by)
    await session.flush()


def _requested_action(kind: str) -> str:
    # Матрица прав — role.permissions_requested (INTERNAL_API); заявка по сотруднику — approval.requested
    return "role.permissions_requested" if kind == "role.permissions_change" else "approval.requested"


def not_applicable(message: str) -> ApiError:
    return conflict("APPROVAL_NOT_APPLICABLE", message)


async def _apply(session: AsyncSession, a: Approval, decider: Staff, ctx: ResetContext | None) -> str | None:
    """→ временный пароль (staff.privileged_reset/password и CREDENTIAL_KINDS) — отдаётся тому, кто применил."""
    p = a.payload
    if a.kind == RESET:
        target = await get_staff(session, uuid.UUID(p["staff_id"]), for_update=True)
        if target is None or target.role != p["role"]:
            raise not_applicable("Сотрудник изменился после подачи заявки — подайте новую")
        if p["action"] == "password":
            assert ctx is not None, "ResetContext is required to apply a password reset"
            return await apply_password_reset(session, target, decider, a.reason, ctx, approval_id=a.approval_id)
        await apply_mfa_reset(session, target, decider, a.reason, approval_id=a.approval_id)
        await session.flush()
        return None
    if a.kind in (ROLE_GRANT, CREATE_PRIVILEGED):
        assert ctx is not None, "ResetContext is required to apply a privileged grant"
        target = await get_staff(session, uuid.UUID(p["staff_id"]), for_update=True)
        expected = p["from_role"] if a.kind == ROLE_GRANT else p["placeholder_role"]
        if target is None or target.role != expected:
            raise not_applicable("Сотрудник изменился после подачи заявки — подайте новую")
        if target.status != "ACTIVE":
            raise not_applicable("Сотрудник отключён")
        new_role = p["to_role"] if a.kind == ROLE_GRANT else p["role"]
        if target.role == SUPER_ADMIN and new_role != SUPER_ADMIN:
            await ensure_not_last_super_admin(session, target)
        target.role = new_role
        temp = await apply_credentials_reset(session, target, decider, a.reason, ctx, approval_id=a.approval_id,
                                             cause=a.kind)
        await session.flush()
        return temp
    if a.kind == REACTIVATE:
        assert ctx is not None, "ResetContext is required to apply a reactivation"
        target = await get_staff(session, uuid.UUID(p["staff_id"]), for_update=True)
        if target is None or target.status == "ACTIVE" or target.role != p["role"]:
            raise not_applicable("Сотрудник изменился после подачи заявки — подайте новую")
        new_role = p.get("to_role") or target.role
        if await get_role(session, new_role) is None:
            raise not_applicable("Роль не найдена")
        before = {"status": target.status, "role": target.role}
        target.status = "ACTIVE"
        target.role = new_role
        await audit.record(session, "staff.updated", actor_id=decider.staff_id, actor_role=decider.role,
                           object_type="staff", object_id=target.staff_id, before=before,
                           after={"status": "ACTIVE", "role": new_role, "approval_id": str(a.approval_id)},
                           reason=a.reason)
        temp = await apply_credentials_reset(session, target, decider, a.reason, ctx, approval_id=a.approval_id,
                                             cause=a.kind)
        await session.flush()
        return temp
    if a.kind == REVOKE:
        target = await get_staff(session, uuid.UUID(p["staff_id"]), for_update=True)
        if target is None or target.role != SUPER_ADMIN or target.status != "ACTIVE":
            raise not_applicable("Сотрудник изменился после подачи заявки — подайте новую")
        await ensure_not_last_super_admin(session, target)
        if p.get("to_role"):
            target.role = p["to_role"]
        if p.get("status") == "DISABLED":
            target.status = "DISABLED"
            await reject_pending_of(session, target, decider, cause="author_disabled")
        bump_session(target)
    elif a.kind == "role.permissions_change":
        role = await get_role(session, p["role"])
        if role is None:
            raise not_applicable("Роль не найдена")
        if await role_permissions(session, role.code) != p["before"]:
            raise not_applicable("Матрица прав изменилась после подачи заявки — подайте новую")
        was_privileged = await is_privileged(session, role.code)
        await session.execute(delete(RolePermission).where(RolePermission.role == role.code))
        for perm in p["permissions"]:
            session.add(RolePermission(role=role.code, permission=perm))
        role.privileged = privileged_by(role.code, p["permissions"])
        if role.privileged and not was_privileged:
            # роль стала привилегированной: сессии её сотрудников отзываются, при входе — подключение MFA
            await session.execute(
                update(Staff).where(Staff.role == role.code)
                .values(session_version=Staff.session_version + 1, updated_at=now())
            )
        role.updated_at = now()
        role.updated_by = a.requested_by
    await session.flush()
    return None


async def decide(session: AsyncSession, approval_id: uuid.UUID, decider: Staff, *, approve: bool,
                 note: str | None, ctx: ResetContext | None = None
                 ) -> tuple[Approval | None, ApiError | None, str | None]:
    """→ (заявка, отложенная ошибка). Истечение фиксируется в БД, поэтому APPROVAL_EXPIRED возвращается
    вызывающему после commit, а не исключением внутри транзакции."""
    if decider.role != SUPER_ADMIN:
        raise forbidden("PERMISSION_DENIED", "Решение по заявке принимает суперадминистратор",
                        {"permission": "roles.manage", "role": SUPER_ADMIN})
    a = (await session.execute(
        select(Approval).where(Approval.approval_id == approval_id).with_for_update()
    )).scalar_one_or_none()
    if a is None:
        raise not_found("APPROVAL_NOT_FOUND", "Заявка не найдена")
    if a.status == "PENDING" and a.expires_at <= now():
        a.status = "EXPIRED"
        await session.flush()
        await disable_placeholder(session, a, None)
        return None, conflict("APPROVAL_EXPIRED", "Срок заявки истёк"), None
    if a.status == "EXPIRED":
        raise conflict("APPROVAL_EXPIRED", "Срок заявки истёк")
    if a.status != "PENDING":
        raise conflict("APPROVAL_NOT_PENDING", "Заявка уже рассмотрена", {"status": a.status})
    if a.requested_by == decider.staff_id:
        raise conflict("FOUR_EYES_SAME_PERSON", "Автор заявки не может её согласовать")
    if approve:
        author = await get_staff(session, a.requested_by)
        if author is None or author.status != "ACTIVE":
            raise not_applicable("Автор заявки отключён — согласовать нельзя, только отклонить")
    a.decided_by = decider.staff_id
    a.decided_at = now()
    a.decision_note = note
    brief = {"kind": a.kind, "summary": audit_summary(a.summary)}
    common: dict[str, Any] = {"actor_id": decider.staff_id, "actor_role": decider.role, "object_type": "approval",
                              "object_id": a.approval_id, "reason": note}
    if not approve:
        a.status = "REJECTED"
        await audit.record(session, "approval.rejected", after=brief, **common)
        await disable_placeholder(session, a, decider)
        await session.flush()
        return a, None, None
    a.status = "APPROVED"
    await audit.record(session, "approval.approved", after=brief, **common)
    temp = await _apply(session, a, decider, ctx)
    a.status = "APPLIED"
    await audit.record(session, "approval.applied", after=brief, **common)
    await session.flush()
    return a, None, temp


async def list_page(session: AsyncSession, *, status: str | None, cursor: str | None, limit: int) -> ApprovalPage:
    await expire_overdue(session)
    stmt = select(Approval).order_by(Approval.requested_at.desc(), Approval.approval_id.desc()).limit(limit + 1)
    if status:
        stmt = stmt.where(Approval.status == status)
    if cursor:
        at, ident = decode_cursor(cursor)
        stmt = stmt.where(
            (Approval.requested_at < at) | ((Approval.requested_at == at) & (Approval.approval_id < ident))
        )
    rows = list((await session.execute(stmt)).scalars().all())
    page = rows[:limit]
    people = await summaries(session, [x for a in page for x in (a.requested_by, a.decided_by) if x])
    next_cursor = encode_cursor(page[-1].requested_at, page[-1].approval_id) if len(rows) > limit else None
    return ApprovalPage(items=[approval_out_with(a, people) for a in page], next_cursor=next_cursor)


def staff_brief(s: Staff) -> dict[str, Any]:
    return {"staff_id": str(s.staff_id), "email": s.email, "display_name": s.display_name}
