"""API ученика спринта 7 (`/internal/v1/game/leagues*`, `/internal/v1/game/duels*`; вызывающий — только
telegram-bff; ученик — claim `lrn`). Формы — bff.ts «Спринт 7» (LeaguesView, LeagueResult, DuelView). Другие ученики —
только member_id, ник, герой, XP, место, разрешённые значки; user_id наружу не отдаётся.

Вызовы social и lessons — вне транзакций БД (сначала проверки и чтение, затем вызов, затем запись под блокировками
учеников). Недоступность: social — 503 UPSTREAM_UNAVAILABLE {service}, lessons — 503 DUEL_SET_UNAVAILABLE."""

from __future__ import annotations

import logging
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unprocessable
from tilhero_gamification import clients
from tilhero_gamification.api.common import (
    LearnerRef,
    current_learner,
    idempotency_key,
    learner_read,
    learner_turn,
    now,
    settings_of,
)
from tilhero_gamification.domain import duels, leagues, members
from tilhero_gamification.domain.common import duel_state, lock_users, member_not_found, request_hash
from tilhero_gamification.models import Duel
from tilhero_gamification.schemas import DuelChallengeIn

router = APIRouter(prefix="/internal/v1/game", tags=["learner-social"])
log = logging.getLogger("tilhero.gamification.social")

_AUTH: dict[int | str, dict[str, Any]] = {401: {"description": "INTERNAL_TOKEN_*"},
                                          403: {"description": "CALLER_NOT_ALLOWED"},
                                          410: {"description": "USER_DELETED"}}


# ---------------------------------------------------------------- лиги


@router.get("/leagues", responses=_AUTH)
async def leagues_view(request: Request, ref: LearnerRef = Depends(current_learner),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """LeaguesView: лига друзей (ребёнку — null), семейная (нет семьи — null), общая (группа недели)."""
    async with rt.transaction() as db:
        turn = await learner_read(db, request, ref)
        return await leagues.learner_view(db, settings_of(request), turn, now(request))


@router.get("/leagues/history", responses={**_AUTH, 400: {"description": "INVALID_CURSOR"}})
async def leagues_history(request: Request, cursor: str | None = Query(default=None, max_length=200),
                          limit: int = Query(default=20, ge=1, le=50), ref: LearnerRef = Depends(current_learner),
                          rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Page<LeagueResult> — мои итоги общей лиги, новые сверху."""
    async with rt.transaction() as db:
        await learner_read(db, request, ref)
        return await leagues.history(db, ref.user_id, cursor, limit)


# ---------------------------------------------------------------- дуэли


@router.post("/duels", status_code=201, responses={
    **_AUTH, 400: {"description": "IDEMPOTENCY_KEY_REQUIRED"},
    403: {"description": "BLOCKED | SOCIAL_RESTRICTED {until} | PARTNER_NOT_ALLOWED | FRIENDS_NOT_ALLOWED {reason}"},
    404: {"description": "MEMBER_NOT_FOUND"},
    409: {"description": "DUELS_LIMIT {limit} | DUEL_EXISTS {duel_id} | LEVELS_INCOMPATIBLE"},
    422: {"description": "VALIDATION_ERROR (себе; pair_id — не активная пара) | IDEMPOTENCY_KEY_REUSED"},
    503: {"description": "UPSTREAM_UNAVAILABLE {service: social}"}})
async def duel_challenge(body: DuelChallengeIn, request: Request,
                         key: str | None = Header(default=None, alias="Idempotency-Key"),
                         ref: LearnerRef = Depends(current_learner), rt: Runtime = Depends(get_runtime)
                         ) -> JSONResponse:
    """Вызов → DuelView (201; повтор ключа — 200 та же дуэль)."""
    k = idempotency_key(key)
    settings, t, me = settings_of(request), now(request), ref.user_id
    body_hash = request_hash(body.model_dump())
    async with rt.transaction() as db:
        await learner_read(db, request, ref)
        prior = await duels.replay(db, me, k, body_hash)
        if prior is not None:
            return JSONResponse((await duels.learner_views(db, settings, me, [prior], t))[0], status_code=200)
        opponent = await members.resolve_local(db, settings, me, body.opponent_member_id)
    if opponent is None:
        opponent = await clients.member_user(rt, body.opponent_member_id)
    if opponent is None:
        raise member_not_found()
    if opponent == me:
        raise unprocessable("VALIDATION_ERROR", "Нельзя вызвать на дуэль себя")
    rel = await clients.relations(rt, me, opponent)
    if rel is None:
        raise member_not_found()
    if rel.b_member_id is not None and rel.b_member_id != body.opponent_member_id:
        log.warning("member_id mismatch with social", extra={"code": "MEMBER_ID_KEY_MISMATCH"})
    async with rt.transaction() as db:
        await lock_users(db, me, opponent)
        turn = await learner_turn(db, request, ref)
        duel, created = await duels.challenge(db, settings, turn, opponent, rel, body.pair_id, k, body_hash, t)
        view = (await duels.learner_views(db, settings, me, [duel], t))[0]
    return JSONResponse(view, status_code=201 if created else 200)


@router.get("/duels", responses={**_AUTH, 400: {"description": "INVALID_CURSOR"}})
async def duel_list(request: Request, status: Literal["active", "finished"] = Query(default="active"),
                    cursor: str | None = Query(default=None, max_length=300),
                    ref: LearnerRef = Depends(current_learner), rt: Runtime = Depends(get_runtime)
                    ) -> dict[str, Any]:
    """Page<DuelView>: active — challenged и accepted; finished — завершённые, отклонённые, истёкшие, отменённые."""
    async with rt.transaction() as db:
        await learner_read(db, request, ref)
        return await duels.learner_list(db, settings_of(request), ref.user_id, status, cursor, now(request))


@router.get("/duels/{duel_id}", responses={**_AUTH, 404: {"description": "DUEL_NOT_FOUND"}})
async def duel_get(duel_id: uuid.UUID, request: Request, ref: LearnerRef = Depends(current_learner),
                   rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """DuelView; чужая дуэль неотличима (404). Счёт обоих — только после завершения."""
    async with rt.transaction() as db:
        await learner_read(db, request, ref)
        return await duels.learner_get(db, settings_of(request), ref.user_id, duel_id, now(request))


@router.post("/duels/{duel_id}/accept", responses={
    **_AUTH, 403: {"description": "BLOCKED | SOCIAL_RESTRICTED {until}"}, 404: {"description": "DUEL_NOT_FOUND"},
    409: {"description": "DUEL_STATE {status}"}, 503: {"description": "DUEL_SET_UNAVAILABLE"}})
async def duel_accept(duel_id: uuid.UUID, request: Request, ref: LearnerRef = Depends(current_learner),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Принятие → DuelView: набор заданий — синхронно в lessons (недоступен — 503 DUEL_SET_UNAVAILABLE, дуэль
    остаётся challenged). Повтор — 200 (тот же набор)."""
    settings, t, me = settings_of(request), now(request), ref.user_id
    async with rt.transaction() as db:
        await learner_read(db, request, ref)
        duel = await db.get(Duel, duel_id)
        state = duels.check_accept(duel, me, t)
        assert duel is not None
        if state == "accepted":
            return (await duels.learner_views(db, settings, me, [duel], t))[0]
        if state == "go" and not await duels.precheck_accept(db, me, duel, t):
            state = "cancel"
        pair_id, band, users = duel.pair_id, duel.level_band, [u for u in (duel.challenger, duel.opponent) if u]
    if state == "expire":
        async with rt.transaction() as db:
            await duels.expire_one(db, duel_id, t)
        raise duel_state("expired")
    if state == "cancel":
        async with rt.transaction() as db:
            await duels.cancel_one(db, duel_id, t)
        raise duel_state("cancelled")
    set_id = await clients.duel_set(rt, duel_id, pair_id, band, users)
    async with rt.transaction() as db:
        duel = await duels.accept(db, me, duel_id, set_id, t)
        view = (await duels.learner_views(db, settings, me, [duel], t))[0]
    if view["status"] != "accepted":
        raise duel_state(view["status"])
    return view


@router.post("/duels/{duel_id}/decline", responses={**_AUTH, 404: {"description": "DUEL_NOT_FOUND"},
                                                    409: {"description": "DUEL_STATE {status}"}})
async def duel_decline(duel_id: uuid.UUID, request: Request, ref: LearnerRef = Depends(current_learner),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Отказ → DuelView; повтор — 200."""
    settings, t = settings_of(request), now(request)
    async with rt.transaction() as db:
        duel = await duels.decline(db, ref.user_id, duel_id, t)
        return (await duels.learner_views(db, settings, ref.user_id, [duel], t))[0]
