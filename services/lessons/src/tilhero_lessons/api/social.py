"""API ученика спринта 7 (Mini App → telegram-bff → lessons; INTERNAL_API §3, §9; формы bff.ts «Дуэли», «Парный
урок»): сессии заданий дуэли и разбор, парные комнаты (приглашение, ответ, вход, присутствие, лента long-poll, ходы,
голос, отчёт).

Ученик — `lrn` токена; партнёр — `member_id`. Чужая комната или сессия — 404. Создающие команды — Idempotency-Key.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal, cast

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse, Response

from tilhero_lessons.api.common import clock_of, idempotency_key, learner_ctx, locale_param, settings_of
from tilhero_lessons.audio import audio_of
from tilhero_lessons.domain import rooms
from tilhero_lessons.domain import sessions as svc
from tilhero_lessons.domain.common import IdempotencyReused
from tilhero_lessons.domain.pair import RoomHub
from tilhero_lessons.domain.sessions import Ctx
from tilhero_lessons.schemas import DuelSessionIn, PairRoomInviteIn, PairTurnIn

router = APIRouter(prefix="/internal/v1/me", tags=["client"])

_ROOM: dict[int | str, dict[str, Any]] = {
    404: {"description": "ROOM_NOT_FOUND (чужая неотличима)"},
    409: {"description": "ROOM_STATE {status} | ROOM_NOT_ACTIVE {status}"},
    410: {"description": "USER_DELETED"},
}


def room_ctx(request: Request, ctx: Ctx = Depends(learner_ctx)) -> rooms.RoomCtx:
    hub = cast(RoomHub, request.app.state.room_hub)
    return rooms.RoomCtx(rt=ctx.rt, catalog=ctx.catalog, settings=settings_of(request), now=ctx.now,
                         learner=ctx.learner, hub=hub, clock=clock_of(request))


def _created(body: dict[str, Any], replayed: bool) -> JSONResponse:
    if replayed:
        return JSONResponse(body, status_code=200, headers={"Idempotent-Replayed": "true"})
    return JSONResponse(body, status_code=201)


# ---------------------------------------------------------------- дуэль


@router.post("/duel-sessions", status_code=201, responses={
    200: {"description": "повтор — та же сессия (одна на участника)"},
    404: {"description": "DUEL_NOT_FOUND"}, 409: {"description": "DUEL_CLOSED"}, 410: {"description": "USER_DELETED"},
    422: {"description": "IDEMPOTENCY_KEY_REUSED | IDEMPOTENCY_KEY_INVALID"}})
async def start_duel_session(body: DuelSessionIn, locale: str = Depends(locale_param),
                             key: str | None = Header(default=None, alias="Idempotency-Key"),
                             ctx: Ctx = Depends(learner_ctx)) -> JSONResponse:
    """→ LessonSession kind duel (ready): задания — общими маршрутами /sessions/{id}/… (без подсказок и ИИ)."""
    try:
        s, replayed = await svc.start_duel(ctx, body.duel_id, locale, idempotency_key(key))
    except IdempotencyReused:
        raise svc.idempotency_reused() from None
    return _created(svc.session_view(s, ctx.settings), replayed)


@router.get("/duel-sessions/{session_id}/review", responses={
    404: {"description": "SESSION_NOT_FOUND"}, 409: {"description": "DUEL_NOT_FINISHED"}})
async def duel_review(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """DuelReview — свои ответы и верные ответы только после завершения дуэли; ответов соперника нет никогда."""
    return await svc.duel_review(ctx, session_id)


# ---------------------------------------------------------------- парные комнаты


@router.post("/pair-rooms", status_code=201, responses={
    200: {"description": "повтор с тем же Idempotency-Key"},
    403: {"description": "BLOCKED | SOCIAL_RESTRICTED {until} | PARTNER_NOT_ALLOWED | FRIENDS_NOT_ALLOWED {reason}"},
    404: {"description": "MEMBER_NOT_FOUND | LESSON_NOT_AVAILABLE"},
    409: {"description": "ROOM_LIMIT {room_id} | PAIR_NOT_AVAILABLE"},
    422: {"description": "VALIDATION_ERROR (start, себе) | IDEMPOTENCY_KEY_REUSED"},
    503: {"description": "UPSTREAM_UNAVAILABLE {service: social} | CATALOG_UNAVAILABLE"}})
async def invite(body: PairRoomInviteIn, key: str | None = Header(default=None, alias="Idempotency-Key"),
                 rc: rooms.RoomCtx = Depends(room_ctx)) -> JSONResponse:
    """PairRoomInvite → PairRoomView (invited)."""
    try:
        view, replayed = await rooms.invite(rc, partner_member_id=body.partner_member_id, pair_id=body.pair_id,
                                            scenario_id=body.scenario_id, start=body.start, key=idempotency_key(key))
    except IdempotencyReused:
        raise svc.idempotency_reused() from None
    return _created(view, replayed)


@router.get("/pair-rooms", responses={400: {"description": "INVALID_CURSOR"}, 410: {"description": "USER_DELETED"}})
async def list_rooms(status: Literal["active", "finished"] = Query(default="active"),
                     cursor: str | None = Query(default=None, max_length=300),
                     limit: int = Query(default=20, ge=1, le=100),
                     rc: rooms.RoomCtx = Depends(room_ctx)) -> dict[str, Any]:
    """Page<PairRoomView>: active — invited, waiting, in_progress, paused (приглашения в обе стороны и комнаты)."""
    return await rooms.list_rooms(rc, status, cursor, limit)


@router.get("/pair-rooms/{room_id}", responses=_ROOM)
async def get_room(room_id: uuid.UUID, rc: rooms.RoomCtx = Depends(room_ctx)) -> dict[str, Any]:
    return await rooms.get_room(rc, room_id)


@router.post("/pair-rooms/{room_id}/accept", responses={**_ROOM, 403: {"description": "BLOCKED | SOCIAL_RESTRICTED"},
                                                       409: {"description": "ROOM_STATE {status} | ROOM_LIMIT"}})
async def accept(room_id: uuid.UUID, rc: rooms.RoomCtx = Depends(room_ctx)) -> dict[str, Any]:
    return await rooms.accept(rc, room_id)


@router.post("/pair-rooms/{room_id}/decline", responses=_ROOM)
async def decline(room_id: uuid.UUID, rc: rooms.RoomCtx = Depends(room_ctx)) -> dict[str, Any]:
    return await rooms.decline(rc, room_id)


@router.post("/pair-rooms/{room_id}/cancel", responses=_ROOM)
async def cancel(room_id: uuid.UUID, rc: rooms.RoomCtx = Depends(room_ctx)) -> dict[str, Any]:
    return await rooms.cancel(rc, room_id)


@router.post("/pair-rooms/{room_id}/join", responses={**_ROOM, 503: {"description": "CATALOG_UNAVAILABLE"}})
async def join(room_id: uuid.UUID, locale: str = Depends(locale_param),
               rc: rooms.RoomCtx = Depends(room_ctx)) -> dict[str, Any]:
    """→ PairRoomState (оба вошли — in_progress; повторный вход и возврат ≤ 3 мин — та же комната и сессия)."""
    return await rooms.join(rc, room_id, locale)


@router.post("/pair-rooms/{room_id}/heartbeat", status_code=204, responses=_ROOM)
async def heartbeat(room_id: uuid.UUID, rc: rooms.RoomCtx = Depends(room_ctx)) -> Response:
    await rooms.heartbeat(rc, room_id)
    return Response(status_code=204)


@router.post("/pair-rooms/{room_id}/leave", responses=_ROOM)
async def leave(room_id: uuid.UUID, rc: rooms.RoomCtx = Depends(room_ctx)) -> dict[str, Any]:
    return await rooms.leave(rc, room_id)


@router.get("/pair-rooms/{room_id}/state", responses=_ROOM)
async def room_state(room_id: uuid.UUID, after_seq: int = Query(default=0, ge=0, le=1_000_000),
                     locale: Literal["ru", "uz"] | None = Query(default=None),
                     rc: rooms.RoomCtx = Depends(room_ctx)) -> dict[str, Any]:
    """PairRoomState — long-poll до 25 с: сразу, если есть события новее after_seq или статус изменился."""
    return await rooms.state(rc, room_id, after_seq, locale)


@router.post("/pair-rooms/{room_id}/turns", responses={
    **_ROOM, 403: {"description": "KIDS_NOT_ALLOWED"},
    409: {"description": "NOT_YOUR_TURN | ROOM_NOT_ACTIVE {status} | FREE_TEXT_NOT_ALLOWED"},
    422: {"description": "ANSWER_INVALID {field} | VALIDATION_ERROR | IDEMPOTENCY_KEY_REUSED"}})
async def turn(room_id: uuid.UUID, body: PairTurnIn, key: str | None = Header(default=None, alias="Idempotency-Key"),
               rc: rooms.RoomCtx = Depends(room_ctx)) -> dict[str, Any]:
    """PairTurnRequest → PairRoomState (повтор ключа — тот же ответ, без второго хода)."""
    data = {"text": body.text, "choice_id": body.choice_id,
            "audio_id": str(body.audio_id) if body.audio_id else None}
    try:
        return await rooms.turn(rc, room_id, data, idempotency_key(key))
    except IdempotencyReused:
        raise svc.idempotency_reused() from None


@router.post("/pair-rooms/{room_id}/audio", responses={
    **_ROOM, 403: {"description": "VOICE_CONSENT_REQUIRED {who} | KIDS_NOT_ALLOWED"},
    409: {"description": "NOT_YOUR_TURN | ROOM_NOT_ACTIVE {status} | FREE_TEXT_NOT_ALLOWED"},
    422: {"description": "AUDIO_INVALID {reason: format | too_short | too_long | too_large}"},
    503: {"description": "SPEECH_UNAVAILABLE"}})
async def audio(room_id: uuid.UUID, request: Request, rc: rooms.RoomCtx = Depends(room_ctx)) -> dict[str, Any]:
    """Тело — audio/wav (0,5..15 с, ≤ 600 000 байт) → PairAudio; аудио не хранится."""
    data, too_large = audio_of(request.scope)
    try:
        return await rooms.audio(rc, room_id, data, request.headers.get("content-type"), too_large)
    finally:
        del data


@router.get("/pair-rooms/{room_id}/report", responses=_ROOM)
async def report(room_id: uuid.UUID, rc: rooms.RoomCtx = Depends(room_ctx)) -> dict[str, Any]:
    """PairRoomReport — только свой (после завершения; раньше — 409 ROOM_STATE)."""
    return await rooms.report(rc, room_id)
