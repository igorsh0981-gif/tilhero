"""Запросы и представления: сотрудники, роли, права. Без FastAPI."""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_admin_identity.domain.catalog import PERMISSIONS, ROLE_CODES, SUPER_ADMIN, privileged_by
from tilhero_admin_identity.models import Role, RolePermission, Staff
from tilhero_admin_identity.schemas import PrincipalOut, StaffOut, StaffSummary
from tilhero_common.errors import bad_request, conflict, forbidden, not_found
from tilhero_common.internal_auth import Actor

# Все изменения учёток/ролей/заявок сериализуются: инварианты «последний super_admin» и four-eyes
# проверяются и применяются атомарно даже при нескольких репликах.
_LOCK_KEY = 0x41444D49  # 'ADMI'


def now() -> datetime:
    return datetime.now(UTC)


async def lock_identity(session: AsyncSession) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _LOCK_KEY})


# ---------------------------------------------------------------- представления

def staff_summary(s: Staff) -> StaffSummary:
    return StaffSummary(staff_id=s.staff_id, email=s.email, display_name=s.display_name, role=s.role)  # type: ignore[arg-type]


def staff_out(s: Staff) -> StaffOut:
    return StaffOut(
        staff_id=s.staff_id, email=s.email, display_name=s.display_name, role=s.role,  # type: ignore[arg-type]
        status=s.status, auth_provider=s.auth_provider,  # type: ignore[arg-type]
        mfa_enabled=s.mfa_enabled, must_change_password=s.must_change_password, last_login_at=s.last_login_at,
        created_at=s.created_at, created_by=s.created_by,
    )


def sort_permissions(perms: Iterable[str]) -> list[str]:
    order = {p: i for i, p in enumerate(PERMISSIONS)}
    return sorted({p for p in perms if p in order}, key=order.__getitem__)


def sort_roles(codes: Iterable[str]) -> list[str]:
    order = {c: i for i, c in enumerate(ROLE_CODES)}
    return sorted(codes, key=lambda c: order.get(c, len(order)))


async def role_permissions(session: AsyncSession, role: str) -> list[str]:
    rows = await session.execute(select(RolePermission.permission).where(RolePermission.role == role))
    return sort_permissions(rows.scalars().all())


async def get_role(session: AsyncSession, code: str) -> Role | None:
    return await session.get(Role, code)


async def is_privileged(session: AsyncSession, role: str) -> bool:
    """По коду роли (контракт) и по текущему набору прав — флаг roles.privileged лишь отображение."""
    r = await get_role(session, role)
    if r is None:
        return False
    return r.privileged or privileged_by(role, await role_permissions(session, role))


async def principal_out(session: AsyncSession, s: Staff) -> PrincipalOut:
    return PrincipalOut(
        staff=staff_summary(s), permissions=await role_permissions(session, s.role),  # type: ignore[arg-type]
        mfa_enabled=s.mfa_enabled, must_change_password=s.must_change_password,
        session_version=s.session_version, status=s.status,  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------- запросы

async def get_staff(session: AsyncSession, staff_id: uuid.UUID, *, for_update: bool = False) -> Staff | None:
    stmt = select(Staff).where(Staff.staff_id == staff_id)
    if for_update:
        stmt = stmt.with_for_update()
    return (await session.execute(stmt)).scalar_one_or_none()


async def require_staff(session: AsyncSession, staff_id: uuid.UUID, *, for_update: bool = False) -> Staff:
    s = await get_staff(session, staff_id, for_update=for_update)
    if s is None:
        raise not_found("STAFF_NOT_FOUND", "Сотрудник не найден")
    return s


async def staff_by_email(session: AsyncSession, email: str, *, for_update: bool = False) -> Staff | None:
    stmt = select(Staff).where(Staff.email == email)
    if for_update:
        stmt = stmt.with_for_update()
    return (await session.execute(stmt)).scalar_one_or_none()


async def active_super_admin_ids(session: AsyncSession) -> list[uuid.UUID]:
    rows = await session.execute(
        select(Staff.staff_id).where(Staff.role == SUPER_ADMIN, Staff.status == "ACTIVE")
    )
    return list(rows.scalars().all())


async def summaries(session: AsyncSession, ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, StaffSummary]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = (await session.execute(select(Staff).where(Staff.staff_id.in_(wanted)))).scalars().all()
    return {s.staff_id: staff_summary(s) for s in rows}


async def acting_staff(session: AsyncSession, actor: Actor) -> Staff:
    """Сотрудник из actor-токена admin-bff: должен существовать и быть активным (защита в глубину)."""
    try:
        staff_id = uuid.UUID(actor.id)
    except ValueError as exc:
        raise forbidden("ACTOR_UNKNOWN", "Сотрудник не найден") from exc
    s = await get_staff(session, staff_id)
    if s is None:
        raise forbidden("ACTOR_UNKNOWN", "Сотрудник не найден")
    if s.status != "ACTIVE":
        raise forbidden("ACCOUNT_DISABLED", "Учётная запись отключена")
    return s


async def authorize(session: AsyncSession, actor: Actor, *permissions: str) -> Staff:
    """Права — по роли сотрудника из БД (actor-токен лишь сужает: dev-имперсонация admin-bff), fail-closed:
    нужно хотя бы одно из прав и в БД, и в токене. В details — первое (основное) право."""
    s = await acting_staff(session, actor)
    granted = set(await role_permissions(session, s.role)) & set(actor.permissions)
    if not any(p in granted for p in permissions):
        raise forbidden("PERMISSION_DENIED", "Недостаточно прав", {"permission": permissions[0]})
    return s


def bump_session(s: Staff) -> None:
    """Рост session_version отзывает все сессии сотрудника в admin-bff."""
    s.session_version = s.session_version + 1
    s.updated_at = now()


async def ensure_not_last_super_admin(session: AsyncSession, target: Staff) -> None:
    if target.role != SUPER_ADMIN or target.status != "ACTIVE":
        return
    others = [i for i in await active_super_admin_ids(session) if i != target.staff_id]
    if not others:
        raise conflict("LAST_SUPER_ADMIN", "Нельзя снять или заблокировать последнего активного суперадминистратора")


async def ensure_no_escalation(session: AsyncSession, requester: Staff, role: str) -> None:
    """Защита от эскалации через staff.manage: не super_admin управляет только сотрудниками (и выдаёт только
    роли), чьи права ⊆ его собственных. Иначе он мог бы сбросить пароль/MFA более сильной учётки и войти
    под ней или выдать себе «соседу» права, которых у него нет. Роли super_admin — только super_admin."""
    if requester.role == SUPER_ADMIN:
        return
    mine = set(await role_permissions(session, requester.role))
    missing = [p for p in await role_permissions(session, role) if p not in mine]
    if role == SUPER_ADMIN or missing:
        raise forbidden("PERMISSION_DENIED", "Нельзя управлять сотрудником с правами шире собственных",
                        {"permission": missing[0] if missing else "roles.manage", "role": role})


async def staff_counts(session: AsyncSession) -> dict[str, int]:
    rows = await session.execute(
        select(Staff.role, func.count()).where(Staff.status != "DISABLED").group_by(Staff.role)
    )
    return {role: int(n) for role, n in rows.all()}


# ---------------------------------------------------------------- курсоры

def encode_cursor(at: datetime, ident: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(json.dumps([at.isoformat(), str(ident)]).encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw: Any = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        return datetime.fromisoformat(raw[0]), uuid.UUID(raw[1])
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc
