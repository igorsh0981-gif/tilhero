"""Расписание n8n (каждый час): POST /internal/v1/invites:tick — вход только по SCHEDULER_TOKEN (спринт 7: + заявки,
рефералы, санкции — domain/social_tick.py)."""

from __future__ import annotations

import logging
from datetime import timedelta

from fastapi import APIRouter, Depends, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_social.api.common import clock_of, gateway_of, scheduler_only, settings_of
from tilhero_social.domain import social_tick
from tilhero_social.domain.tick import run_tick
from tilhero_social.schemas import SocialTickOut

router = APIRouter(prefix="/internal/v1", tags=["scheduler"])
log = logging.getLogger("tilhero.social.tick")


@router.post("/invites:tick", response_model=SocialTickOut)
async def invites_tick(request: Request, _: str = Depends(scheduler_only),
                       rt: Runtime = Depends(get_runtime)) -> SocialTickOut:
    """Истёкшие → expired; открытые ≥ 24 ч без ответа → одно напоминание получателю, если он сейчас может
    принять приглашение (D-02). Спринт 7: заявки в друзья (30 дней), рефералы по окну, санкции по сроку.
    Повтор безопасен."""
    settings = settings_of(request)
    result = await run_tick(rt, gateway_of(request), clock=clock_of(request), producer=settings.service_name,
                            remind_after=timedelta(hours=settings.invite_reminder_after_hours),
                            max_age=timedelta(days=settings.invite_reminder_max_age_days),
                            batch_size=settings.tick_batch_size, family_max=settings.family_max_members)
    if result.deferred:
        log.info("invites:tick: reminders deferred (invitee cannot accept now)", extra={"count": result.deferred})
    social = await social_tick.run(rt, settings, clock_of(request)())
    return SocialTickOut(reminders=result.reminders, expired=result.expired,
                         friend_requests_expired=social.friend_requests_expired,
                         referrals_expired=social.referrals_expired, sanctions_expired=social.sanctions_expired)
