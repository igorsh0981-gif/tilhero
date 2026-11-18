"""Сброс пароля/MFA сотрудника — общая механика для прямой команды (непривилегированная цель) и для применения
four-eyes-заявки staff.privileged_reset (ревью N1). Временный пароль возвращается только тому, кто применил
сброс (решающему по заявке), в БД — только argon2-хеш; в аудит/события/логи не попадает."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_admin_identity.domain import audit
from tilhero_admin_identity.domain.crypto import Passwords, temporary_password
from tilhero_admin_identity.domain.store import bump_session, now
from tilhero_admin_identity.models import Staff


@dataclass(frozen=True)
class ResetContext:
    passwords: Passwords
    temp_ttl_hours: int


async def apply_password_reset(session: AsyncSession, target: Staff, by: Staff, reason: str, ctx: ResetContext,
                               *, approval_id: uuid.UUID | None = None, reissue: bool = False) -> str:
    temp = temporary_password()
    target.password_hash = await ctx.passwords.hash(temp)
    target.must_change_password = True
    target.temp_password_expires_at = now() + timedelta(hours=ctx.temp_ttl_hours)
    bump_session(target)
    after: dict[str, object] = {"must_change_password": True, "sessions_revoked": True,
                                "temporary_password_ttl_hours": ctx.temp_ttl_hours}
    if approval_id is not None:
        after["approval_id"] = str(approval_id)
    if reissue:
        after["reissued_before_first_login"] = True
    await audit.record(session, "staff.password_reset", actor_id=by.staff_id, actor_role=by.role,
                       object_type="staff", object_id=target.staff_id, after=after, reason=reason)
    return temp


async def apply_mfa_reset(session: AsyncSession, target: Staff, by: Staff, reason: str, *,
                          approval_id: uuid.UUID | None = None) -> None:
    before = {"mfa_enabled": target.mfa_enabled}
    target.mfa_secret_enc = None
    target.mfa_enabled = False
    target.mfa_last_step = None
    bump_session(target)
    after: dict[str, object] = {"mfa_enabled": False, "sessions_revoked": True}
    if approval_id is not None:
        after["approval_id"] = str(approval_id)
    await audit.record(session, "staff.mfa_reset", actor_id=by.staff_id, actor_role=by.role, object_type="staff",
                       object_id=target.staff_id, before=before, after=after, reason=reason)
