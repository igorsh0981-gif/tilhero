"""Управление сотрудниками и ролями (staff.manage / roles.manage). Вызывающий держит транзакцию;
все команды берут lock_identity — инварианты проверяются и применяются атомарно."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_admin_identity.domain import approvals, audit
from tilhero_admin_identity.domain.catalog import DEFAULT_ROLE, PERMISSIONS, ROLE_CODES, SUPER_ADMIN, privileged_by
from tilhero_admin_identity.domain.crypto import temporary_password
from tilhero_admin_identity.domain.policy import mask_email
from tilhero_admin_identity.domain.resets import ResetContext, apply_mfa_reset, apply_password_reset
from tilhero_admin_identity.domain.store import (
    active_super_admin_ids,
    bump_session,
    decode_cursor,
    encode_cursor,
    ensure_no_escalation,
    ensure_not_last_super_admin,
    get_role,
    is_privileged,
    lock_identity,
    now,
    require_staff,
    role_permissions,
    sort_permissions,
    staff_counts,
    staff_out,
)
from tilhero_admin_identity.models import Approval, Role, RolePermission, Staff
from tilhero_admin_identity.schemas import (
    RoleName,
    RoleOut,
    RolesOut,
    StaffCreate,
    StaffPage,
    StaffPatch,
)
from tilhero_common.errors import conflict, not_found


def self_action() -> Exception:
    return conflict("SELF_ACTION", "Нельзя менять роль, статус, пароль или MFA своей учётной записи здесь")


@dataclass
class CreateResult:
    staff: Staff
    temporary_password: str | None  # null — привилегированная роль ждёт решения (пароль получит решающий, P2-1)
    approval: Approval | None


@dataclass
class PatchResult:
    staff: Staff
    approval: Approval | None
    changed_email: str | None  # учётка разблокирована → сбросить счётчик попыток входа
    temporary_password: str | None = None  # заявка применена сразу (waived) — автору как единственному решающему


async def list_staff(session: AsyncSession, *, q: str | None, role: str | None, status: str | None,
                     cursor: str | None, limit: int) -> StaffPage:
    await approvals.expire_overdue(session)  # заглушки истёкших заявок на создание — уже DISABLED в списке
    stmt = select(Staff).order_by(Staff.created_at.desc(), Staff.staff_id.desc()).limit(limit + 1)
    if q:
        pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(or_(Staff.email.ilike(pattern, escape="\\"), Staff.display_name.ilike(pattern, escape="\\")))
    if role:
        stmt = stmt.where(Staff.role == role)
    if status:
        stmt = stmt.where(Staff.status == status)
    if cursor:
        at, ident = decode_cursor(cursor)
        stmt = stmt.where((Staff.created_at < at) | ((Staff.created_at == at) & (Staff.staff_id < ident)))
    rows = list((await session.execute(stmt)).scalars().all())
    page = rows[:limit]
    nxt = encode_cursor(page[-1].created_at, page[-1].staff_id) if len(rows) > limit else None
    return StaffPage(items=[staff_out(s) for s in page], next_cursor=nxt)


async def create_staff(session: AsyncSession, body: StaffCreate, requester: Staff, *, ctx: ResetContext,
                       approval_ttl_hours: int) -> CreateResult:
    """Непривилегированная роль — сразу, временный пароль автору. Привилегированная (P2-1) — учётка в роли
    read_only БЕЗ пароля (войти под ней до решения нельзя) + заявка staff.create_privileged; пароль выпускается
    при применении и выдаётся решающему (при waived — автору, он и есть единственный решающий)."""
    await lock_identity(session)
    email = body.email
    if (await session.execute(select(Staff.staff_id).where(Staff.email == email))).scalar_one_or_none():
        raise conflict("STAFF_EMAIL_EXISTS", "Сотрудник с таким email уже существует")
    role = await get_role(session, body.role)
    if role is None:
        raise not_found("ROLE_NOT_FOUND", "Роль не найдена")
    privileged = await is_privileged(session, role.code)  # по коду и текущим правам роли (M2)
    if not privileged:  # привилегированную роль решает super_admin (four-eyes)
        await ensure_no_escalation(session, requester, role.code)
    temp = None if privileged else temporary_password()
    at = now()
    s = Staff(
        staff_id=uuid.uuid4(), email=email, display_name=body.display_name,
        role=DEFAULT_ROLE if privileged else role.code,
        password_hash=await ctx.passwords.hash(temp) if temp is not None else None,
        temp_password_expires_at=at + timedelta(hours=ctx.temp_ttl_hours) if temp is not None else None,
        must_change_password=True, mfa_enabled=False, status="ACTIVE", session_version=1,
        created_at=at, updated_at=at, created_by=requester.staff_id,
    )
    session.add(s)
    await session.flush()
    await audit.record(session, "staff.created", actor_id=requester.staff_id, actor_role=requester.role,
                       object_type="staff", object_id=s.staff_id,
                       after={"email": mask_email(email), "display_name": s.display_name, "role": s.role,
                              "requested_role": role.code, "must_change_password": True,
                              "temporary_password_issued": temp is not None})
    approval = None
    if privileged:
        approval, temp = await approvals.create_ex(
            session, kind=approvals.CREATE_PRIVILEGED, target=f"staff:{s.staff_id}",
            payload={"staff_id": str(s.staff_id), "placeholder_role": DEFAULT_ROLE, "role": role.code},
            summary={"staff": approvals.staff_brief(s), "role": role.code},
            reason=f"Создание сотрудника с ролью {role.code}", requester=requester, ttl_hours=approval_ttl_hours,
            ctx=ctx,
        )
    return CreateResult(s, temp, approval)


async def patch_staff(session: AsyncSession, staff_id: uuid.UUID, body: StaffPatch, requester: Staff, *,
                      ctx: ResetContext, approval_ttl_hours: int) -> PatchResult:
    await lock_identity(session)
    await approvals.expire_overdue(session)  # цель — заглушка истёкшей заявки на создание: сначала её исход
    target = await require_staff(session, staff_id, for_update=True)
    role_change = body.role is not None and body.role != target.role
    status_change = body.status is not None and body.status != target.status
    name_change = body.display_name is not None and body.display_name.strip() != target.display_name
    if target.staff_id == requester.staff_id and (role_change or status_change):
        raise self_action()
    new_role: Role | None = None
    if role_change:
        new_role = await get_role(session, body.role)  # type: ignore[arg-type]
        if new_role is None:
            raise not_found("ROLE_NOT_FOUND", "Роль не найдена")
    # Включение (DISABLED → ACTIVE) сотрудника с привилегированной ролью — до или после смены роли в той же
    # команде — только заявкой staff.reactivate_privileged (P2-2): иначе решение двух людей об отключении
    # отменяет один. Роль из той же команды входит в заявку.
    reactivate = status_change and body.status == "ACTIVE"
    reactivate_privileged = reactivate and (
        await is_privileged(session, target.role)
        or (new_role is not None and await is_privileged(session, new_role.code)))
    # Понижение/отключение super_admin (B1): последнего — нельзя; при ≥ 2 активных — только four-eyes
    revoke = not reactivate_privileged and target.role == SUPER_ADMIN and (
        role_change or (status_change and body.status == "DISABLED"))
    if revoke:
        await ensure_not_last_super_admin(session, target)
    await ensure_no_escalation(session, requester, target.role)
    needs_approval = False
    if new_role is not None and not revoke and not reactivate_privileged:
        needs_approval = await is_privileged(session, new_role.code)
        if not needs_approval:
            await ensure_no_escalation(session, requester, new_role.code)
    # status=ACTIVE снимает и временную блокировку входа/MFA (счётчики в Redis), даже если статус в БД уже
    # ACTIVE — так администратор разблокирует сотрудника, не дожидаясь 15 минут (прямой командой)
    unlock = body.status == "ACTIVE" and target.staff_id != requester.staff_id and not reactivate_privileged
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    if name_change:
        before["display_name"], after["display_name"] = target.display_name, body.display_name.strip()  # type: ignore[union-attr]
        target.display_name = after["display_name"]
    apply_status = status_change and not revoke and not reactivate_privileged
    apply_role = role_change and not needs_approval and not revoke and not reactivate_privileged
    if apply_status:
        before["status"], after["status"] = target.status, body.status
        target.status = body.status  # type: ignore[assignment]
    if apply_role:
        before["role"], after["role"] = target.role, body.role
        target.role = body.role  # type: ignore[assignment]
    if apply_status or apply_role:
        bump_session(target)
    elif name_change:
        target.updated_at = now()
    if unlock and not status_change:
        after["login_attempts_reset"] = True
    if after:
        await audit.record(session, "staff.updated", actor_id=requester.staff_id, actor_role=requester.role,
                           object_type="staff", object_id=target.staff_id, before=before, after=after,
                           reason=body.reason)
    if apply_status and body.status == "DISABLED":
        await approvals.reject_pending_of(session, target, requester, cause="author_disabled")
    approval: Approval | None = None
    temp: str | None = None
    if reactivate_privileged:
        to_role = body.role if role_change else None
        approval, temp = await approvals.create_ex(
            session, kind=approvals.REACTIVATE, target=f"staff:{target.staff_id}",
            payload={"staff_id": str(target.staff_id), "role": target.role, "to_role": to_role,
                     "from_status": target.status},
            summary={"staff": approvals.staff_brief(target), "role": target.role, "to_role": to_role,
                     "from_status": target.status},
            reason=body.reason, requester=requester, ttl_hours=approval_ttl_hours, ctx=ctx,
        )
    elif revoke:
        to_status = "DISABLED" if status_change and body.status == "DISABLED" else None
        to_role = body.role if role_change else None
        approval = await approvals.create(
            session, kind=approvals.REVOKE, target=f"staff:{target.staff_id}",
            payload={"staff_id": str(target.staff_id), "from_role": target.role, "to_role": to_role,
                     "status": to_status},
            summary={"staff": approvals.staff_brief(target), "from_role": target.role, "to_role": to_role,
                     "status": to_status},
            reason=body.reason, requester=requester, ttl_hours=approval_ttl_hours,
        )
    elif needs_approval:
        approval, temp = await approvals.create_ex(
            session, kind=approvals.ROLE_GRANT, target=f"staff:{target.staff_id}",
            payload={"staff_id": str(target.staff_id), "from_role": target.role, "to_role": body.role},
            summary={"staff": approvals.staff_brief(target), "from_role": target.role, "to_role": body.role},
            reason=body.reason, requester=requester, ttl_hours=approval_ttl_hours, ctx=ctx,
        )
    await session.flush()
    applied = approval is None or approval.status == "APPLIED"
    changed_email = target.email if (unlock or (approval is not None and applied and temp is not None)) else None
    return PatchResult(target, approval, changed_email, temp)


@dataclass
class ResetResult:
    target: Staff
    temporary_password: str | None  # только при немедленном сбросе пароля
    approval: Approval | None       # four-eyes (привилегированная цель)


async def reissue_allowed(session: AsyncSession, target: Staff, requester: Staff) -> bool:
    """Выход из тупика four-eyes: перевыпуск временного пароля сотрудника, который ещё ни разу не входил, — автором
    его учётки и без заявки, но ТОЛЬКО когда согласовать заявку некому (кроме автора и самой цели нет других
    активных super_admin). Автор и так получал первый временный пароль при создании. Если есть третий решающий,
    обычный путь заявки (N1): иначе автор, реактивировав давно не входившую учётку,
    получил бы второй голос (ревью M-1)."""
    if not (target.created_by == requester.staff_id and target.last_login_at is None
            and target.must_change_password and target.status == "ACTIVE"):
        return False
    others = set(await active_super_admin_ids(session)) - {requester.staff_id, target.staff_id}
    if not others:
        return True
    # решающим считается только тот, кто уже входил: два ни разу не входивших super_admin не блокируют друг друга
    rows = (await session.execute(
        select(Staff.staff_id).where(Staff.staff_id.in_(others), Staff.last_login_at.is_not(None)).limit(1)
    )).first()
    return rows is None


async def _reset(session: AsyncSession, staff_id: uuid.UUID, action: str, reason: str, requester: Staff, *,
                 ctx: ResetContext, approval_ttl_hours: int) -> ResetResult:
    """Сброс пароля/MFA. Привилегированная цель (в т.ч. коллега с тем же набором привилегированных прав) —
    только заявкой staff.privileged_reset (N1): иначе один super_admin/держатель staff.manage сбрасывает пароль
    и MFA другого, входит под ним и согласует собственные заявки. Временный пароль — решающему."""
    await lock_identity(session)
    await approvals.expire_overdue(session)
    target = await require_staff(session, staff_id, for_update=True)
    temp: str | None
    if target.staff_id == requester.staff_id:
        raise self_action()
    await ensure_no_escalation(session, requester, target.role)
    if not await is_privileged(session, target.role):
        if action == "password":
            temp = await apply_password_reset(session, target, requester, reason, ctx)
            return ResetResult(target, temp, None)
        await apply_mfa_reset(session, target, requester, reason)
        return ResetResult(target, None, None)
    if action == "password" and await reissue_allowed(session, target, requester):
        # висящая заявка на сброс этой цели (тупик, из-за которого и перевыпуск) больше не нужна
        await approvals.supersede_pending(session, f"staff:{target.staff_id}", requester, cause="superseded_by_reissue")
        temp = await apply_password_reset(session, target, requester, reason, ctx, reissue=True)
        return ResetResult(target, temp, None)
    a, temp = await approvals.create_ex(
        session, kind=approvals.RESET, target=f"staff:{target.staff_id}",
        payload={"staff_id": str(target.staff_id), "action": action, "role": target.role},
        summary={"staff": approvals.staff_brief(target), "action": action, "role": target.role},
        reason=reason, requester=requester, ttl_hours=approval_ttl_hours, ctx=ctx,
        # цель — super_admin: исключение single_super_admin не действует никогда
        waivable=target.role != SUPER_ADMIN,
    )
    return ResetResult(target, temp, a)


async def reset_password(session: AsyncSession, staff_id: uuid.UUID, reason: str, requester: Staff, *,
                         ctx: ResetContext, approval_ttl_hours: int) -> ResetResult:
    return await _reset(session, staff_id, "password", reason, requester, ctx=ctx,
                        approval_ttl_hours=approval_ttl_hours)


async def reset_mfa(session: AsyncSession, staff_id: uuid.UUID, reason: str, requester: Staff, *,
                    ctx: ResetContext, approval_ttl_hours: int) -> ResetResult:
    return await _reset(session, staff_id, "mfa", reason, requester, ctx=ctx, approval_ttl_hours=approval_ttl_hours)


# ---------------------------------------------------------------- роли

async def list_roles(session: AsyncSession) -> RolesOut:
    roles = {r.code: r for r in (await session.execute(select(Role))).scalars().all()}
    perms: dict[str, list[str]] = {}
    for role, perm in (await session.execute(select(RolePermission.role, RolePermission.permission))).all():
        perms.setdefault(role, []).append(perm)
    counts = await staff_counts(session)
    order = [c for c in ROLE_CODES if c in roles] + sorted(c for c in roles if c not in ROLE_CODES)
    items = [
        RoleOut(code=r.code, name=RoleName(ru=r.name_ru, en=r.name_en),  # type: ignore[arg-type]
                permissions=sort_permissions(perms.get(r.code, [])),  # type: ignore[arg-type]
                privileged=r.privileged or privileged_by(r.code, perms.get(r.code, [])),
                staff_count=counts.get(r.code, 0), updated_at=r.updated_at,
                updated_by=r.updated_by)
        for r in (roles[c] for c in order)
    ]
    return RolesOut(items=items, permissions=list(PERMISSIONS))  # type: ignore[arg-type]


async def request_role_change(session: AsyncSession, code: str, permissions: list[str], reason: str,
                              requester: Staff, *, approval_ttl_hours: int) -> Approval:
    await lock_identity(session)
    role = await get_role(session, code)
    if role is None:
        raise not_found("ROLE_NOT_FOUND", "Роль не найдена")
    wanted = sort_permissions(permissions)
    if code == SUPER_ADMIN and "roles.manage" not in wanted:
        raise conflict("SUPER_ADMIN_ROLES_MANAGE", "Нельзя убрать roles.manage у роли super_admin")
    current = await role_permissions(session, code)
    if wanted == current:
        raise conflict("ROLE_UNCHANGED", "Матрица прав роли не изменилась")
    summary = {"role": code, "added": [p for p in wanted if p not in current],
               "removed": [p for p in current if p not in wanted]}
    return await approvals.create(
        session, kind="role.permissions_change", target=f"role:{code}",
        payload={"role": code, "permissions": wanted, "before": current}, summary=summary, reason=reason,
        requester=requester, ttl_hours=approval_ttl_hours,
    )
