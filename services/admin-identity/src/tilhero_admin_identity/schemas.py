"""Формы API. Ответы /admin/v1/* совпадают с packages/contracts/src/admin.ts (Staff, Role, Approval, …)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from tilhero_admin_identity.domain.catalog import Permission, RoleCode
from tilhero_admin_identity.domain.policy import is_valid_email, normalize_email

StaffStatus = Literal["ACTIVE", "LOCKED", "DISABLED"]
LoginNext = Literal["done", "mfa", "mfa_enroll", "password_change"]
# staff.privileged_revoke — понижение/отключение super_admin при ≥ 2 активных (B1);
# staff.privileged_reset — сброс пароля/MFA привилегированного сотрудника (N1)
ApprovalKind = Literal["staff.role_grant", "staff.create_privileged", "role.permissions_change",
                       "staff.privileged_revoke", "staff.privileged_reset"]
ApprovalStatus = Literal["PENDING", "APPROVED", "REJECTED", "EXPIRED", "APPLIED"]

Challenge = Field(min_length=20, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
TotpCode = Field(min_length=6, max_length=6, pattern=r"^[0-9]{6}$")
Password = Field(min_length=1, max_length=256)
Reason = Field(min_length=3, max_length=1000)


class In(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------- staff

class StaffSummary(BaseModel):
    staff_id: uuid.UUID
    email: str
    display_name: str
    role: RoleCode


class StaffOut(StaffSummary):
    status: StaffStatus
    mfa_enabled: bool
    must_change_password: bool
    last_login_at: datetime | None
    created_at: datetime
    created_by: uuid.UUID | None


class StaffPage(BaseModel):
    items: list[StaffOut]
    next_cursor: str | None


class StaffCreate(In):
    email: str = Field(min_length=3, max_length=254)
    display_name: str = Field(min_length=1, max_length=120)
    role: RoleCode

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = normalize_email(v)
        if not is_valid_email(v):
            raise ValueError("invalid email")
        return v

    @field_validator("display_name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("display_name is empty")
        return v


class StaffPatch(In):
    role: RoleCode | None = None
    status: Literal["ACTIVE", "DISABLED"] | None = None
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    reason: str = Reason

    @model_validator(mode="after")
    def _something(self) -> StaffPatch:
        if self.role is None and self.status is None and self.display_name is None:
            raise ValueError("nothing to change")
        if self.display_name is not None and not self.display_name.strip():
            raise ValueError("display_name is empty")
        return self


class ReasonIn(In):
    reason: str = Reason


class TemporaryPassword(BaseModel):
    temporary_password: str


class LookupOut(BaseModel):
    items: list[StaffSummary]


# ---------------------------------------------------------------- roles

class RoleName(BaseModel):
    ru: str
    en: str


class RoleOut(BaseModel):
    code: RoleCode
    name: RoleName
    permissions: list[Permission]
    privileged: bool
    staff_count: int
    updated_at: datetime
    updated_by: uuid.UUID | None


class RolesOut(BaseModel):
    items: list[RoleOut]
    permissions: list[Permission]


class RoleUpdate(In):
    permissions: list[Permission] = Field(max_length=64)
    reason: str = Reason

    @field_validator("permissions")
    @classmethod
    def _unique(cls, v: list[str]) -> list[str]:
        if len(set(v)) != len(v):
            raise ValueError("permissions must be unique")
        return v


# ---------------------------------------------------------------- approvals

class ApprovalOut(BaseModel):
    approval_id: uuid.UUID
    kind: ApprovalKind
    status: ApprovalStatus
    summary: dict[str, Any]
    reason: str
    requested_by: StaffSummary
    requested_at: datetime
    decided_by: StaffSummary | None
    decided_at: datetime | None
    decision_note: str | None
    waived: Literal["single_super_admin"] | None
    expires_at: datetime


class ApprovalDecisionOut(ApprovalOut):
    """ApprovalDecision (admin.ts): temporary_password — только в ответе approve заявки staff.privileged_reset
    (action "password"), решающему, один раз."""

    temporary_password: str | None = None


class ApprovalEnvelope(BaseModel):
    approval: ApprovalOut


class ApprovalPage(BaseModel):
    items: list[ApprovalOut]
    next_cursor: str | None


class DecisionIn(In):
    note: str | None = Field(default=None, max_length=1000)


class StaffCreated(BaseModel):
    staff: StaffOut
    temporary_password: str | None
    approval: ApprovalOut | None


# ---------------------------------------------------------------- auth (internal, admin-bff)

class PrincipalOut(BaseModel):
    staff: StaffSummary
    permissions: list[Permission]
    mfa_enabled: bool
    must_change_password: bool
    session_version: int
    status: StaffStatus


class LoginIn(In):
    email: str = Field(min_length=1, max_length=254)
    password: str = Password
    ip: str | None = Field(default=None, max_length=64)
    user_agent: str | None = Field(default=None, max_length=512)


class LoginStepOut(BaseModel):
    next: LoginNext
    challenge: str | None = None
    principal: PrincipalOut | None = None


class PasswordIn(In):
    """С challenge — шаг входа; иначе — смена своего пароля в сессии (staff_id из сессии admin-bff + текущий)."""

    challenge: str | None = Field(default=None, min_length=20, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    staff_id: uuid.UUID | None = None
    current_password: str | None = Field(default=None, min_length=1, max_length=256)
    new_password: str = Password

    @model_validator(mode="after")
    def _mode(self) -> PasswordIn:
        by_challenge = self.challenge is not None
        by_session = self.staff_id is not None or self.current_password is not None
        if by_challenge == by_session:
            raise ValueError("either challenge or staff_id+current_password is required")
        if by_session and (self.staff_id is None or self.current_password is None):
            raise ValueError("staff_id and current_password are required together")
        return self


class ChallengeIn(In):
    challenge: str = Challenge


class CodeIn(In):
    challenge: str = Challenge
    code: str = TotpCode


class MfaEnrollStartOut(BaseModel):
    secret: str
    otpauth_uri: str
    issuer: str
    account: str


class StepUpIn(In):
    staff_id: uuid.UUID
    code: str = TotpCode


class OkOut(BaseModel):
    ok: Literal[True] = True


class LogoutIn(In):
    staff_id: uuid.UUID
    session_id: str = Field(min_length=1, max_length=128)
