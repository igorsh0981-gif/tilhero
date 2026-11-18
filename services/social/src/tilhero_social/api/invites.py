"""Приглашения и семья (Mini App → telegram-bff → social), INTERNAL_API §3. `sub` — аккаунт.

user_id — только из внутреннего токена; чужое приглашение неотличимо от несуществующего (404 INVITE_NOT_FOUND).
Имена — у identity-consent (вне транзакций БД).
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy import select

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import not_found, unprocessable
from tilhero_social.api.common import clock_of, current_user, gateway_of, idempotency_key, settings_of
from tilhero_social.domain import family as fam
from tilhero_social.domain import invites as inv
from tilhero_social.domain import rules
from tilhero_social.identity import IdentityGateway, PublicProfile
from tilhero_social.models import Invite
from tilhero_social.schemas import (
    CreateInviteIn,
    FamilyOut,
    InviteAcceptOut,
    InviteOut,
    InvitePage,
    InvitePreviewOut,
    OpenInviteIn,
)

router = APIRouter(prefix="/internal/v1", tags=["client"])


def _invite_uuid(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise inv.invite_not_found() from None


async def family_view(rt: Runtime, gateway: IdentityGateway, family_id: uuid.UUID, me: uuid.UUID) -> FamilyOut | None:
    async with rt.transaction() as session:
        members = await fam.members(session, family_id)
    if not members:
        return None
    names = await gateway.names(m.user_id for m in members)
    return FamilyOut.model_validate({
        "family_id": str(family_id),
        "members": [
            {"user_id": str(m.user_id), "display_name": names[m.user_id], "role": m.role, "is_me": m.user_id == me}
            for m in members if names[m.user_id] is not None  # удалённый (сага в процессе) не показываем
        ],
    })


async def _viewer(rt: Runtime, gateway: IdentityGateway, me: uuid.UUID) -> PublicProfile | None:
    """Открыть и посмотреть приглашение — только при действующем согласии (P-3): иначе 403 CONSENT_REQUIRED
    {purpose: terms}, до любых данных приглашения (и до записи открытия)."""
    me_pub = await gateway.public(me)
    async with rt.transaction() as session:
        rules.check_consent(await inv.person_for(session, me, me_pub), social=False)
    return me_pub


async def _preview(rt: Runtime, gateway: IdentityGateway, invite_id: uuid.UUID, me: uuid.UUID,
                   request: Request, me_pub: PublicProfile | None) -> InvitePreviewOut:
    settings = settings_of(request)
    async with rt.transaction() as session:
        invite = await session.get(Invite, invite_id)
    if invite is None:
        raise inv.invite_not_found()
    inviter_pub = await gateway.public(invite.inviter_user_id)
    if inviter_pub is None:
        raise inv.invite_not_found()
    now = clock_of(request)()
    async with rt.transaction() as session:
        invite = await session.get(Invite, invite_id, populate_existing=True)
        if invite is None:
            raise inv.invite_not_found()
        person = await inv.person_for(session, me, me_pub)
        facts = await inv.viewer_facts(session, invite, me, settings.family_max_members)
    return inv.preview_out(invite, inviter_pub.display_name, me, person, facts, now)


@router.post("/me/invites", response_model=InviteOut, status_code=201,
             responses={403: {"description": "ADULT_REQUIRED | INVITES_NOT_ALLOWED | "
                                             "CONSENT_REQUIRED {purpose: terms | social}"},
                        409: {"description": "INVITES_LIMIT {limit, window}"}})
async def create_invite(
    body: CreateInviteIn,
    request: Request,
    response: Response,
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
    me: uuid.UUID = Depends(current_user),
    rt: Runtime = Depends(get_runtime),
) -> InviteOut:
    key = idempotency_key(idem)
    settings = settings_of(request)
    now = clock_of(request)()
    try:
        async with rt.transaction() as session:
            replay = await inv.find_replay(session, me, key, body.kind)
        if replay is not None:
            invite, replayed = replay, True
        else:
            pub = await gateway_of(request).public(me)
            async with rt.transaction() as session:
                person = await inv.person_for(session, me, pub)
                invite, replayed = await inv.create(session, me, person, body.kind, key=key, now=now,
                                                    settings=settings)
    except inv.IdempotencyReused:
        raise unprocessable("IDEMPOTENCY_KEY_REUSED",
                            "Ключ идемпотентности уже использован с другими данными") from None
    if replayed:
        response.headers["Idempotent-Replayed"] = "true"
    return inv.to_out(invite, settings, now)


@router.get("/me/invites", response_model=InvitePage)
async def list_invites(
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=200),
    me: uuid.UUID = Depends(current_user),
    rt: Runtime = Depends(get_runtime),
) -> InvitePage:
    settings = settings_of(request)
    now = clock_of(request)()
    async with rt.transaction() as session:
        rows, next_cursor = await inv.list_mine(session, me, limit=limit, cursor=cursor)
    return InvitePage(items=[inv.to_out(r, settings, now) for r in rows], next_cursor=next_cursor)


@router.delete("/me/invites/{invite_id}", response_model=InviteOut)
async def revoke_invite(
    invite_id: str,
    request: Request,
    me: uuid.UUID = Depends(current_user),
    rt: Runtime = Depends(get_runtime),
) -> InviteOut:
    now = clock_of(request)()
    async with rt.transaction() as session:
        invite = await inv.revoke(session, me, _invite_uuid(invite_id), now)
    return inv.to_out(invite, settings_of(request), now)


@router.post("/invites:open", response_model=InvitePreviewOut,
             responses={403: {"description": "CONSENT_REQUIRED {purpose: terms}"},
                        404: {"description": "INVITE_NOT_FOUND"}})
async def open_invite(
    body: OpenInviteIn,
    request: Request,
    me: uuid.UUID = Depends(current_user),
    rt: Runtime = Depends(get_runtime),
) -> InvitePreviewOut:
    gateway = gateway_of(request)
    me_pub = await _viewer(rt, gateway, me)
    async with rt.transaction() as session:
        invite = await inv.find_by_token(session, body.token)
    if invite is None:
        raise inv.invite_not_found()
    now = clock_of(request)()
    async with rt.transaction() as session:
        # FOR KEY SHARE: удаление пригласившего (сага) не уберёт приглашение посреди записи открытия
        locked = (await session.execute(
            select(Invite).where(Invite.invite_id == invite.invite_id).with_for_update(read=True, key_share=True)
        )).scalar_one_or_none()
        if locked is None:
            raise inv.invite_not_found()
        await inv.record_open(session, locked, me, now, settings_of(request).service_name)
    return await _preview(rt, gateway, invite.invite_id, me, request, me_pub)


@router.get("/invites/{invite_id}/preview", response_model=InvitePreviewOut,
            responses={403: {"description": "CONSENT_REQUIRED {purpose: terms}"},
                       404: {"description": "INVITE_NOT_FOUND"}})
async def preview_invite(
    invite_id: str,
    request: Request,
    me: uuid.UUID = Depends(current_user),
    rt: Runtime = Depends(get_runtime),
) -> InvitePreviewOut:
    """Повторный показ карточки (кнопка из напоминания startapp=invite_<id>) — только тому, кто уже открывал."""
    iid = _invite_uuid(invite_id)
    gateway = gateway_of(request)
    me_pub = await _viewer(rt, gateway, me)
    async with rt.transaction() as session:
        if await inv.redemption(session, iid, me) is None:
            raise inv.invite_not_found()
    return await _preview(rt, gateway, iid, me, request, me_pub)


@router.post("/invites/{invite_id}/accept", response_model=InviteAcceptOut,
             responses={403: {"description": "INVITES_NOT_ALLOWED | CONSENT_REQUIRED {purpose: terms | social}"},
                        404: {"description": "INVITE_NOT_FOUND"},
                        409: {"description": "INVITE_SELF | INVITE_ALREADY_USED | INVITE_EXPIRED | INVITE_REVOKED | "
                                             "FAMILY_ALREADY_MEMBER | FAMILY_FULL | ALREADY_FRIENDS"}})
async def accept_invite(
    invite_id: str,
    request: Request,
    me: uuid.UUID = Depends(current_user),
    rt: Runtime = Depends(get_runtime),
) -> InviteAcceptOut:
    iid = _invite_uuid(invite_id)
    gateway = gateway_of(request)
    async with rt.transaction() as session:
        invite = await session.get(Invite, iid)
    if invite is None:
        raise inv.invite_not_found()
    me_pub = await gateway.public(me)
    now = clock_of(request)()
    async with rt.transaction() as session:
        person = await inv.person_for(session, me, me_pub)
        invite, family_id = await inv.accept(session, iid, invite.inviter_user_id, me, person, now=now,
                                             settings=settings_of(request))
    family = await family_view(rt, gateway, family_id, me) if family_id is not None else None
    return InviteAcceptOut.model_validate({"invite_id": str(invite.invite_id), "kind": invite.kind,
                                           "family": family})


@router.post("/invites/{invite_id}/decline", response_model=InvitePreviewOut,
             responses={403: {"description": "CONSENT_REQUIRED {purpose: terms}"},
                        404: {"description": "INVITE_NOT_FOUND"}, 409: {"description": "INVITE_SELF"}})
async def decline_invite(
    invite_id: str,
    request: Request,
    me: uuid.UUID = Depends(current_user),
    rt: Runtime = Depends(get_runtime),
) -> InvitePreviewOut:
    iid = _invite_uuid(invite_id)
    gateway = gateway_of(request)
    me_pub = await _viewer(rt, gateway, me)  # ответ — карточка приглашения: как «посмотреть»
    async with rt.transaction() as session:
        await inv.decline(session, iid, me, now=clock_of(request)(), producer=settings_of(request).service_name)
    return await _preview(rt, gateway, iid, me, request, me_pub)


@router.get("/me/family", response_model=FamilyOut, responses={404: {"description": "FAMILY_NOT_FOUND"}})
async def my_family(
    request: Request,
    me: uuid.UUID = Depends(current_user),
    rt: Runtime = Depends(get_runtime),
) -> FamilyOut:
    async with rt.transaction() as session:
        member = await fam.membership(session, me)
    view = await family_view(rt, gateway_of(request), member.family_id, me) if member is not None else None
    if view is None:
        raise not_found("FAMILY_NOT_FOUND", "Семьи пока нет")
    return view
