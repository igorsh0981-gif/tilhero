"""Pydantic-модели API social. Формы ответов = типы bff.ts (Invite, InvitePreview, InviteAcceptResult, Family)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

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
    member_id: str  # спринт 7 (§0, §10 п. 1): по нему семья вызывает на дуэль и зовёт в парный урок
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


# ===================================================================== спринт 7 (вход; ответы — формы bff.ts/admin.ts)

Text10 = Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=500)]
MemberIdStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
SubjectKind = Literal["user", "nickname", "friend_request", "invite", "duel", "pair_room"]
ComplaintReason = Literal["spam", "abuse", "inappropriate_nickname", "cheating", "other"]


class NicknameIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nickname: str = Field(max_length=64)


class CommunityPatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    game_profile_hidden: bool | None = None


class MemberIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    member_id: MemberIdStr


class ComplaintIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    member_id: MemberIdStr
    subject_kind: SubjectKind
    subject_id: uuid.UUID | None = None
    reason: ComplaintReason
    comment: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None
    block: bool = False


class AppealIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=1000)]


class CaseResolveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["dismiss", "warning", "social_ban", "nickname_reset"]
    days: int | None = Field(default=None, ge=1, le=30)
    basis: Text10


class ReasonIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Text10


class AppealDecisionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["upheld", "overturned"]
    note: Text10


class CampaignDraftIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payload: Any
    comment: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None
    based_on: int | None = Field(default=None, ge=1)


class CommentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    comment: Text10


class ReferralApproveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note: Text10


class ReferralRejectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reject_code: Literal["not_new_user", "family_member", "review_rejected"]
    note: Text10


class SocialTickOut(TickOut):
    """invites:tick (спринт 7): + истечение заявок в друзья, рефералов по окну, санкций по сроку."""

    friend_requests_expired: int
    referrals_expired: int
    sanctions_expired: int
