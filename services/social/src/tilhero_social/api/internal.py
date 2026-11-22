"""Связь учеников для доменов лиг, дуэлей и парных уроков (§1.2): вызывающие — только gamification и lessons
(telegram-bff и остальные — 403 CALLER_NOT_ALLOWED). member_id переводится в user_id только внутри доменов."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import Principal
from tilhero_social.api.common import clock_of, domain_auth, gateway_of, person_of, settings_of
from tilhero_social.domain import friends, members
from tilhero_social.domain.access import audience, social_reason
from tilhero_social.domain.common import is_deleted, iso, member_not_found
from tilhero_social.domain.restrictions import active_ban

router = APIRouter(prefix="/internal/v1", tags=["internal"])

_ERR: dict[int | str, dict[str, Any]] = {
    401: {"description": "INTERNAL_TOKEN_*"}, 403: {"description": "CALLER_NOT_ALLOWED"},
    404: {"description": "MEMBER_NOT_FOUND"}, 503: {"description": "UPSTREAM_UNAVAILABLE {service}"}}


@router.get("/members/{member_id}", responses=_ERR)
async def member(member_id: str, _: Principal = Depends(domain_auth),
                 rt: Runtime = Depends(get_runtime)) -> dict[str, str]:
    """member_id → {user_id}; неизвестный, некорректный и удалённый — 404 MEMBER_NOT_FOUND (неотличимо)."""
    async with rt.transaction() as session:
        user_id = await members.resolve(session, member_id)
    if user_id is None:
        raise member_not_found()
    return {"user_id": str(user_id)}


@router.get("/relations/{user_a}/{user_b}", responses=_ERR)
async def relations(user_a: uuid.UUID, user_b: uuid.UUID, request: Request, _: Principal = Depends(domain_auth),
                    rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """{friends, same_family, blocked_any, a_restricted, b_restricted, a_audience, b_audience} + сроки санкций,
    доступ к друзьям (14–17 — с согласием родителя, цель social) и member_id обоих. Ученик удалён или неизвестен
    identity-consent — 404 MEMBER_NOT_FOUND; identity-consent недоступен — 503."""
    if user_a == user_b:
        raise member_not_found()
    gateway = gateway_of(request)
    pa, pb = await asyncio.gather(person_of(rt, gateway, user_a), person_of(rt, gateway, user_b))
    if pa is None or pb is None:
        raise member_not_found()
    now = clock_of(request)()
    async with rt.transaction() as session:
        if await is_deleted(session, user_a) or await is_deleted(session, user_b):
            raise member_not_found()
        a_ban, b_ban = await active_ban(session, user_a, now), await active_ban(session, user_b, now)
        mids = await members.register(session, settings_of(request).member_key_bytes(), [user_a, user_b])
        return {
            "friends": await friends.are_friends(session, user_a, user_b),
            "same_family": await friends.same_family(session, user_a, user_b),
            "blocked_any": await friends.blocked_any(session, user_a, user_b),
            "a_restricted": a_ban[0], "b_restricted": b_ban[0],
            "a_restricted_until": iso(a_ban[1]) if a_ban[0] else None,
            "b_restricted_until": iso(b_ban[1]) if b_ban[0] else None,
            "a_audience": audience(pa), "b_audience": audience(pb),
            "a_social_allowed": social_reason(pa) is None, "b_social_allowed": social_reason(pb) is None,
            "a_member_id": mids[user_a], "b_member_id": mids[user_b],
        }
