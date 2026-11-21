"""Админ-API social (спринт 7, admin.ts «Социальное»; вызывающий — только admin-bff с actor). Права проверяются
здесь по actor (защита в глубину): social.read — карточка ученика; dashboard.read | social.read — блок дашборда;
moderation.manage — дела, санкции, обжалования (step-up: social_ban больше 7 дней и бессрочный); referral.read —
кампании, очередь, статистика; referral.manage — черновик, проверка, активация (step-up), одобрение и отклонение
реферала. Каждая команда — аудит admin.audit.recorded.v1. Модератор не видит переписку: только предмет жалобы."""

from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Query, Request, Response

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import forbidden
from tilhero_common.internal_auth import Principal
from tilhero_social.api.common import clock_of, require_staff, settings_of, staff_auth
from tilhero_social.domain import admin_view, campaigns, moderation, referrals
from tilhero_social.domain import family as fam
from tilhero_social.domain.common import (
    DASHBOARD_READ,
    MODERATION_MANAGE,
    REFERRAL_MANAGE,
    REFERRAL_READ,
    SOCIAL_READ,
    cursor_time_id,
    day_start,
    encode_cursor,
    iso,
    validation_error,
    zone,
)
from tilhero_social.models import Referral
from tilhero_social.schemas import (
    AppealDecisionIn,
    CampaignDraftIn,
    CaseResolveIn,
    CommentIn,
    ReasonIn,
    ReferralApproveIn,
    ReferralRejectIn,
)

router = APIRouter(prefix="/internal/v1/admin", tags=["staff"])

_AUTH: dict[int | str, dict[str, Any]] = {
    401: {"description": "INTERNAL_TOKEN_*"},
    403: {"description": "PERMISSION_DENIED | STAFF_CONTEXT_REQUIRED | CALLER_NOT_ALLOWED | STEP_UP_REQUIRED"}}
_Cursor = Query(default=None, max_length=500)
_Limit = Query(default=20, ge=1, le=100)


# ---------------------------------------------------------------- карточка и дашборд


@router.get("/social/users/{user_id}", responses={**_AUTH, 404: {"description": "SOCIAL_PROFILE_NOT_FOUND"}})
async def social_card(user_id: uuid.UUID, request: Request, principal: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """AdminSocialCard: профиль сообщества, число друзей, заявки (статусы и даты), блокировки (числа), дела, санкции."""
    require_staff(principal, SOCIAL_READ)
    settings = settings_of(request)
    async with rt.transaction() as session:
        return await admin_view.social_card(session, user_id, clock_of(request)(),
                                            member_key=settings.member_key_bytes(),
                                            ttl_days=settings.friend_request_ttl_days)


@router.get("/social/stats", responses=_AUTH)
async def social_stats(request: Request, period: Literal["today", "7d", "30d"] = Query(default="today"),
                       principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                       ) -> dict[str, Any]:
    """SocialStats для Dashboard.social (dashboard.read или social.read); today — с начала суток Ташкента."""
    actor = principal.actor
    if actor is None:
        raise forbidden("STAFF_CONTEXT_REQUIRED", "Команда доступна только сотрудникам")
    if DASHBOARD_READ not in actor.permissions and SOCIAL_READ not in actor.permissions:
        raise forbidden("PERMISSION_DENIED", "Недостаточно прав", {"permission": DASHBOARD_READ})
    now = clock_of(request)()
    since = admin_view.period_start(period, now, day_start(now, zone(settings_of(request).social_timezone)))
    async with rt.transaction() as session:
        return await admin_view.stats(session, period, since)


# ---------------------------------------------------------------- модерация


def _page(items: list[dict[str, Any]], more: bool, last: tuple[Any, Any] | None) -> dict[str, Any]:
    return {"items": items, "next_cursor": encode_cursor(iso(last[0]), str(last[1])) if more and last else None}


@router.get("/moderation/cases", responses=_AUTH)
async def list_cases(request: Request, status: Literal["open", "resolved", "dismissed"] | None = Query(default=None),
                     cursor: str | None = _Cursor, limit: int = _Limit, principal: Principal = Depends(staff_auth),
                     rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Page<AdminCaseRow> (open — старые сверху)."""
    require_staff(principal, MODERATION_MANAGE)
    async with rt.transaction() as session:
        rows, more = await moderation.list_cases(session, status, limit, cursor_time_id(cursor))
        items = await moderation.case_rows(session, rows, clock_of(request)())
    return _page(items, more, (rows[-1].created_at, rows[-1].case_id) if rows else None)


@router.get("/moderation/cases/{case_id}", responses={**_AUTH, 404: {"description": "CASE_NOT_FOUND"}})
async def get_case(case_id: uuid.UUID, request: Request, principal: Principal = Depends(staff_auth),
                   rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """AdminCase: предмет жалобы без переписки, решение, история санкций цели."""
    require_staff(principal, MODERATION_MANAGE)
    async with rt.transaction() as session:
        return await moderation.case_full(session, await moderation.load_case(session, case_id), clock_of(request)())


@router.post("/moderation/cases/{case_id}/resolve", responses={
    **_AUTH, 404: {"description": "CASE_NOT_FOUND"}, 409: {"description": "CASE_STATE {status}"},
    422: {"description": "VALIDATION_ERROR (days только для social_ban; basis 10..500)"}})
async def resolve_case(case_id: uuid.UUID, body: CaseResolveIn, request: Request,
                       principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                       ) -> dict[str, Any]:
    """Решение по делу (moderation.manage; social_ban больше 7 дней и бессрочный — step-up)."""
    actor = require_staff(principal, MODERATION_MANAGE)
    if body.action != "social_ban" and body.days is not None:
        raise validation_error("days", "only for social_ban")
    if body.action == "social_ban" and (body.days is None or body.days > 7):
        require_staff(principal, MODERATION_MANAGE, request, step_up=True)
    now = clock_of(request)()
    async with rt.transaction() as session:
        # санкция цели — под блокировкой цели: сага удаления держит ту же блокировку («удалён?» — после неё)
        target = (await moderation.load_case(session, case_id)).target_user_id
        if target is not None:
            await fam.lock_users(session, [target])
        c = await moderation.load_case(session, case_id, for_update=True)
        c = await moderation.resolve_case(session, actor, c, action=body.action, days=body.days, basis=body.basis,
                                          now=now, member_key=settings_of(request).member_key_bytes())
        return await moderation.case_full(session, c, now)


@router.get("/moderation/sanctions", responses=_AUTH)
async def list_sanctions(request: Request, user_id: uuid.UUID | None = Query(default=None),
                         active: bool | None = Query(default=None), cursor: str | None = _Cursor,
                         limit: int = _Limit, principal: Principal = Depends(staff_auth),
                         rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Page<AdminSanction> (новые сверху)."""
    require_staff(principal, MODERATION_MANAGE)
    now = clock_of(request)()
    async with rt.transaction() as session:
        rows, more = await moderation.list_sanctions(session, user_id, active, now, limit, cursor_time_id(cursor))
        appeals = await moderation.appeals_of(session, [s.sanction_id for s in rows])
        items = [moderation.admin_sanction(s, appeals.get(s.sanction_id), now) for s in rows]
    return _page(items, more, (rows[-1].decided_at, rows[-1].sanction_id) if rows else None)


@router.post("/moderation/sanctions/{sanction_id}/revoke", responses={
    **_AUTH, 404: {"description": "SANCTION_NOT_FOUND"}, 409: {"description": "SANCTION_STATE"}})
async def revoke_sanction(sanction_id: uuid.UUID, body: ReasonIn, request: Request,
                          principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                          ) -> dict[str, Any]:
    actor = require_staff(principal, MODERATION_MANAGE)
    now = clock_of(request)()
    async with rt.transaction() as session:
        s = await moderation.load_sanction(session, sanction_id, for_update=True)
        s = await moderation.revoke(session, actor, s, body.reason, now)
        appeal = (await moderation.appeals_of(session, [s.sanction_id])).get(s.sanction_id)
        return moderation.admin_sanction(s, appeal, now)


@router.get("/moderation/appeals", responses=_AUTH)
async def list_appeals(request: Request,
                       status: Literal["open", "upheld", "overturned"] | None = Query(default=None),
                       cursor: str | None = _Cursor, limit: int = _Limit, principal: Principal = Depends(staff_auth),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Page<AdminSanctionAppeal> (open — старые сверху)."""
    require_staff(principal, MODERATION_MANAGE)
    now = clock_of(request)()
    async with rt.transaction() as session:
        rows, more = await moderation.list_appeals(session, status, limit, cursor_time_id(cursor))
        items = [await moderation.appeal_view(session, a, now) for a in rows]
    return _page(items, more, (rows[-1].created_at, rows[-1].appeal_id) if rows else None)


@router.post("/moderation/appeals/{appeal_id}/decide", responses={
    **_AUTH, 404: {"description": "APPEAL_NOT_FOUND"}, 409: {"description": "APPEAL_STATE {status}"}})
async def decide_appeal(appeal_id: uuid.UUID, body: AppealDecisionIn, request: Request,
                        principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                        ) -> dict[str, Any]:
    """overturned снимает санкцию; ученик получает appeal_decided (ответ видит)."""
    actor = require_staff(principal, MODERATION_MANAGE)
    now = clock_of(request)()
    async with rt.transaction() as session:
        a = await moderation.load_appeal(session, appeal_id, for_update=True)
        a = await moderation.decide_appeal(session, actor, a, body.decision, body.note, now)
        return await moderation.appeal_view(session, a, now)


# ---------------------------------------------------------------- реферальные кампании


@router.get("/referrals/campaigns", responses=_AUTH)
async def campaigns_list(principal: Principal = Depends(staff_auth),
                         rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """{items: ReferralCampaignSummary[]} (новые сверху)."""
    require_staff(principal, REFERRAL_READ)
    async with rt.transaction() as session:
        return await campaigns.list_versions(session)


@router.get("/referrals/campaigns/stats", responses=_AUTH)
async def campaigns_stats(principal: Principal = Depends(staff_auth),
                          rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """{items: ReferralCampaignStats[]}."""
    require_staff(principal, REFERRAL_READ)
    async with rt.transaction() as session:
        return await referrals.campaign_stats(session)


@router.put("/referrals/campaigns/draft", responses={**_AUTH, 409: {"description": "DRAFT_CONFLICT {updated_at}"},
                                                     422: {"description": "CAMPAIGN_INVALID {errors}"}})
async def campaign_put_draft(body: CampaignDraftIn, request: Request,
                             if_match: str | None = Header(default=None, alias="If-Match", max_length=64),
                             principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                             ) -> dict[str, Any]:
    """Создать или заменить черновик (замена — If-Match: updated_at черновика)."""
    actor = require_staff(principal, REFERRAL_MANAGE)
    async with rt.transaction() as session:
        return await campaigns.put_draft(session, actor, body.payload, body.comment, body.based_on, if_match,
                                         clock_of(request)())


@router.delete("/referrals/campaigns/draft", status_code=204,
               responses={**_AUTH, 404: {"description": "CAMPAIGN_VERSION_NOT_FOUND"}})
async def campaign_delete_draft(principal: Principal = Depends(staff_auth),
                                rt: Runtime = Depends(get_runtime)) -> Response:
    actor = require_staff(principal, REFERRAL_MANAGE)
    async with rt.transaction() as session:
        await campaigns.delete_draft(session, actor)
    return Response(status_code=204)


@router.post("/referrals/campaigns/draft/validate",
             responses={**_AUTH, 404: {"description": "CAMPAIGN_VERSION_NOT_FOUND"}})
async def campaign_validate(request: Request, principal: Principal = Depends(staff_auth),
                            rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """RulesValidation {ok, errors, warnings}; ok — ставит validated_at."""
    actor = require_staff(principal, REFERRAL_MANAGE)
    async with rt.transaction() as session:
        return await campaigns.validate_draft(session, actor, clock_of(request)())


@router.post("/referrals/campaigns/draft/activate", responses={
    **_AUTH, 404: {"description": "CAMPAIGN_VERSION_NOT_FOUND"}, 409: {"description": "CAMPAIGN_NOT_VALIDATED"},
    422: {"description": "CAMPAIGN_INVALID | comment < 10"}})
async def campaign_activate(body: CommentIn, request: Request, principal: Principal = Depends(staff_auth),
                            rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Активация (referral.manage + step-up): прежняя → archived; рефералы остаются на своей версии."""
    actor = require_staff(principal, REFERRAL_MANAGE, request, step_up=True)
    async with rt.transaction() as session:
        return await campaigns.activate_draft(session, actor, body.comment, clock_of(request)())


@router.get("/referrals/campaigns/{version}", responses={**_AUTH,
                                                        404: {"description": "CAMPAIGN_VERSION_NOT_FOUND"}})
async def campaign_get(version: int, principal: Principal = Depends(staff_auth),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """ReferralCampaignVersion: payload + diff с активной."""
    require_staff(principal, REFERRAL_READ)
    async with rt.transaction() as session:
        return await campaigns.get_version(session, version)


# ---------------------------------------------------------------- очередь проверки рефералов

_ReferralStatus = Literal["invited", "diagnostic_done", "learning", "review", "qualified", "rewarded", "rejected",
                          "expired", "capped"]


@router.get("/referrals", responses=_AUTH)
async def referrals_list(status: _ReferralStatus | None = Query(default=None), cursor: str | None = _Cursor,
                         limit: int = _Limit, principal: Principal = Depends(staff_auth),
                         rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Page<AdminReferralRow> (review — старые сверху): факты и флаги риска, без ПДн."""
    require_staff(principal, REFERRAL_READ)
    async with rt.transaction() as session:
        rows, more = await referrals.admin_page(session, status, limit, cursor_time_id(cursor))
        items = [await referrals.admin_row(session, r) for r in rows]
    return _page(items, more, (rows[-1].accepted_at, rows[-1].referral_id) if rows else None)


@router.get("/referrals/{referral_id}", responses={**_AUTH, 404: {"description": "REFERRAL_NOT_FOUND"}})
async def referral_get(referral_id: uuid.UUID, request: Request, principal: Principal = Depends(staff_auth),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """AdminReferral: уроки (даты и минуты), квалификации месяца, история решений."""
    require_staff(principal, REFERRAL_READ)
    async with rt.transaction() as session:
        r = await session.get(Referral, referral_id)
        if r is None:
            raise referrals.referral_not_found()
        return await referrals.admin_full(session, r, zone(settings_of(request).social_timezone))


@router.post("/referrals/{referral_id}/approve", responses={
    **_AUTH, 404: {"description": "REFERRAL_NOT_FOUND"}, 409: {"description": "REFERRAL_STATE {status}"}})
async def referral_approve(referral_id: uuid.UUID, body: ReferralApproveIn, request: Request,
                           principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                           ) -> dict[str, Any]:
    """review или отклонённый оператором (пересмотр, один раз) → правила кампании (без рисков) → qualified → лимит
    месяца → capped или награда; не проходит правила — 409 REFERRAL_STATE {status, outcome}."""
    actor = require_staff(principal, REFERRAL_MANAGE)
    policy = referrals.policy_of(settings_of(request))
    async with rt.transaction() as session:
        r = await referrals.load_locked(session, referral_id)
        await referrals.approve(session, actor, r, body.note, clock_of(request)(), policy)
        return await referrals.admin_full(session, r, policy.tz)


@router.post("/referrals/{referral_id}/reject", responses={
    **_AUTH, 404: {"description": "REFERRAL_NOT_FOUND"}, 409: {"description": "REFERRAL_STATE {status}"}})
async def referral_reject(referral_id: uuid.UUID, body: ReferralRejectIn, request: Request,
                          principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                          ) -> dict[str, Any]:
    """Только review → rejected с публичным кодом. Выданную награду отменяет обратная запись в кошельке."""
    actor = require_staff(principal, REFERRAL_MANAGE)
    tz = zone(settings_of(request).social_timezone)
    async with rt.transaction() as session:
        r = await referrals.load_locked(session, referral_id)
        await referrals.reject(session, actor, r, body.reject_code, body.note, clock_of(request)())
        return await referrals.admin_full(session, r, tz)
