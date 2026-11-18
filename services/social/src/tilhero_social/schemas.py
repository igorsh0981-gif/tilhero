"""Pydantic-модели API social. Формы ответов = типы bff.ts (Invite, InvitePreview, InviteAcceptResult, Family)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

InviteKind = Literal["family", "friend", "referral"]
InviteStatus = Literal["active", "accepted", "revoked", "expired"]
Reason = Literal["self", "already_member", "already_friends", "already_used", "expired", "revoked", "not_allowed"]
Role = Literal["owner", "adult", "teen", "child"]


class CreateInviteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: InviteKind


class OpenInviteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=1, max_length=64)


class InviteOut(BaseModel):
    invite_id: str
    kind: InviteKind
    link: str
    status: InviteStatus
    expires_at: datetime | None
    created_at: datetime
    accepted_count: int


class InvitePage(BaseModel):
    items: list[InviteOut]
    next_cursor: str | None


class InvitePreviewOut(BaseModel):
    invite_id: str
    kind: InviteKind
    inviter_display_name: str
    status: InviteStatus
    can_accept: bool
    reason: Reason | None


class FamilyMemberOut(BaseModel):
    user_id: str
    display_name: str
    role: Role
    is_me: bool


class FamilyOut(BaseModel):
    family_id: str
    members: list[FamilyMemberOut]


class InviteAcceptOut(BaseModel):
    invite_id: str
    kind: InviteKind
    family: FamilyOut | None


class TickOut(BaseModel):
    reminders: int
    expired: int
