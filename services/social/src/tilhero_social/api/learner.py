"""Социальное ученика (спринт 7, INTERNAL_API §1.1–§1.4, §9; формы ответов — bff.ts «Спринт 7», telegram-bff
проксирует их как есть). Вызывающий — только telegram-bff; ученик — claim `lrn` (активный ученик), иначе `sub`.

Другие ученики — только как member_id и ник: user_id, имени, Telegram и возраста в ответах нет. Вызовы
identity-consent (возраст, согласие родителя, цель social) — вне транзакций БД. Команды — под advisory-блокировкой
учеников (в порядке uuid), «удалён?» проверяется после блокировки (сага держит ту же блокировку).
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import ApiError
from tilhero_social.api.common import (
    clock_of,
    current_learner,
    gateway_of,
    idempotency_key,
    person_of,
    settings_of,
)
from tilhero_social.domain import campaigns, community, friends, members, moderation, nicknames, referrals
from tilhero_social.domain import family as fam
from tilhero_social.domain.access import Me, require_social, social_reason
from tilhero_social.domain.common import (
    cursor_time_id,
    decode_cursor,
    encode_cursor,
    friends_not_allowed,
    is_deleted,
    iso,
    member_not_found,
    self_not_allowed,
    user_deleted,
    validation_error,
    zone,
)
from tilhero_social.domain.common import idempotent_replay as replay_of
from tilhero_social.domain.common import idempotent_store as store_idem
from tilhero_social.domain.restrictions import active_ban, require_not_banned
from tilhero_social.models import CommunityProfile, Sanction
from tilhero_social.schemas import AppealIn, CommunityPatchIn, ComplaintIn, MemberIn, NicknameIn
from tilhero_social.settings import Settings

router = APIRouter(prefix="/internal/v1/me", tags=["client"])

_ERR_COMMON: dict[int | str, dict[str, Any]] = {
    401: {"description": "INTERNAL_TOKEN_* | USER_CONTEXT_*"},
    403: {"description": "CALLER_NOT_ALLOWED"},
    503: {"description": "UPSTREAM_UNAVAILABLE {service: identity-consent}"},
}


async def _locked(session: AsyncSession, me: uuid.UUID, *others: uuid.UUID) -> None:
    """Блокировка учеников (порядок uuid) и «удалён?» — после неё: удалённый не получает новых данных."""
    await fam.lock_users(session, [me, *others])
    if await is_deleted(session, me):
        raise user_deleted()


async def _target(rt: Runtime, member_id: str, me: Me) -> uuid.UUID:
    """member_id → user_id (404 MEMBER_NOT_FOUND — нет, некорректен или удалён); себя — 422."""
    async with rt.transaction() as session:
        target = await members.resolve(session, member_id)
    if target is None:
        raise member_not_found()
    if target == me.user_id:
        raise self_not_allowed()
    return target


def _replayed(status: int, body: dict[str, Any], replay: bool) -> JSONResponse:
    resp = JSONResponse(body, status_code=200 if replay else status)
    if replay:
        resp.headers["Idempotent-Replayed"] = "true"
    return resp


# ---------------------------------------------------------------- профиль сообщества


async def _profile(rt: Runtime, request: Request, me: Me,
                   mutate: Callable[[AsyncSession, CommunityProfile, str, datetime], Awaitable[CommunityProfile]]
                   | None = None) -> dict[str, Any]:
    settings = settings_of(request)
    reason = "kids" if me.kids else social_reason(await person_of(rt, gateway_of(request), me.user_id))
    now = clock_of(request)()
    async with rt.transaction() as session:
        await _locked(session, me.user_id)
        row = await community.ensure(session, me.user_id, now)
        [mid] = (await members.register(session, settings.member_key_bytes(), [me.user_id])).values()
        if mutate is not None:
            row = await mutate(session, row, mid, now)
        ban = await active_ban(session, me.user_id, now)
        return community.view(row, mid, ban=ban, cooldown_days=settings.nickname_cooldown_days, now=now,
                              friends_reason=reason, friend_code=row.friend_code)


@router.get("/community", responses=_ERR_COMMON)
async def get_community(request: Request, me: Me = Depends(current_learner),
                        rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """CommunityProfile (создаётся при первом обращении: ник null, новый код друга)."""
    return await _profile(rt, request, me)


@router.patch("/community", responses=_ERR_COMMON)
async def patch_community(body: CommunityPatchIn, request: Request, me: Me = Depends(current_learner),
                          rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Скрытие игрового профиля → social.profile.updated.v1."""

    async def mutate(s: AsyncSession, row: CommunityProfile, mid: str, now: datetime) -> CommunityProfile:
        if body.game_profile_hidden is None:
            return row
        return await community.set_hidden(s, row, body.game_profile_hidden, mid, now)

    return await _profile(rt, request, me, mutate)


@router.put("/community/nickname", responses={
    **_ERR_COMMON, 409: {"description": "NICKNAME_TAKEN"},
    422: {"description": "NICKNAME_INVALID {reason: length | chars | forbidden}"},
    429: {"description": "NICKNAME_COOLDOWN {until}"}})
async def put_nickname(body: NicknameIn, request: Request, me: Me = Depends(current_learner),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Ник: формат, запрещённые слова, двойники, уникальность без учёта регистра, раз в 7 дней. Тот же ник — 200."""
    cooldown = settings_of(request).nickname_cooldown_days

    async def mutate(s: AsyncSession, row: CommunityProfile, mid: str, now: datetime) -> CommunityProfile:
        return await community.set_nickname(s, row, body.nickname, mid, now, cooldown)

    return await _profile(rt, request, me, mutate)


@router.post("/community/friend-code:rotate", responses={**_ERR_COMMON,
                                                         429: {"description": "FRIEND_CODE_LIMIT {until}"}})
async def rotate_code(request: Request, me: Me = Depends(current_learner),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Новый код друга, прежний сразу перестаёт находиться; не чаще 3 раз в сутки."""
    per_day = settings_of(request).friend_code_rotations_per_day

    async def mutate(s: AsyncSession, row: CommunityProfile, _mid: str, now: datetime) -> CommunityProfile:
        return await community.rotate_code(s, row, now, per_day)

    return await _profile(rt, request, me, mutate)


# ---------------------------------------------------------------- поиск и заявки


def _require_friends(me: Me) -> None:
    if me.kids:
        raise friends_not_allowed("kids")


@router.get("/friends/search", responses={**_ERR_COMMON, 403: {
    "description": "FRIENDS_NOT_ALLOWED {reason} | CONSENT_REQUIRED {purpose}"}})
async def search(request: Request, q: str = Query(min_length=1, max_length=40), me: Me = Depends(current_learner),
                 rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """MemberSearchResult: точный код друга или ник → 0 или 1 карточка. Не находятся: заблокированные в любую
    сторону, дети, ученики без доступа к друзьям (и удалённые)."""
    _require_friends(me)
    settings, gateway = settings_of(request), gateway_of(request)
    require_social(await person_of(rt, gateway, me.user_id))
    now = clock_of(request)()
    code = nicknames.parse_friend_code(q)
    async with rt.transaction() as session:
        row = await community.find_by_code(session, code) if code else None
        if row is None and nicknames.MIN_LEN <= len(q.strip()) <= nicknames.MAX_LEN:
            row = await community.find_by_nickname(session, q)
        if row is None or await is_deleted(session, row.user_id):
            return {"items": []}
        target = row.user_id
        if target != me.user_id and await friends.blocked_any(session, me.user_id, target):
            return {"items": []}
    if target != me.user_id and social_reason(await person_of(rt, gateway, target)) is not None:
        return {"items": []}
    async with rt.transaction() as session:
        rel, request_id = await friends.relation(session, me.user_id, target, now, settings.friend_request_ttl_days)
        [mid] = (await members.register(session, settings.member_key_bytes(), [target])).values()
        nick = (await community.nicknames_of(session, [target]))[target]
    return {"items": [{"member_id": mid, "nickname": nick, "relation": rel,
                       "request_id": str(request_id) if request_id else None}]}


def _other(req: Any, me: uuid.UUID) -> uuid.UUID:
    return uuid.UUID(str(req.to_user if req.from_user == me else req.from_user))


async def _requests_out(session: AsyncSession, settings: Settings, me: uuid.UUID, reqs: list[Any],
                        now: datetime) -> list[dict[str, Any]]:
    """Вторая сторона — member_id и ник; реестр — одним вызовом (блокировки в порядке uuid)."""
    others = [_other(r, me) for r in reqs]
    mids = await members.register(session, settings.member_key_bytes(), others)
    nicks = await community.nicknames_of(session, list(dict.fromkeys(others)))
    return [friends.request_view(r, me, mids[o], nicks[o], now, settings.friend_request_ttl_days)
            for r, o in zip(reqs, others, strict=True)]


async def _request_out(session: AsyncSession, settings: Settings, me: uuid.UUID, req: Any,
                       now: datetime) -> dict[str, Any]:
    [out] = await _requests_out(session, settings, me, [req], now)
    return out


@router.post("/friend-requests", status_code=201, responses={
    **_ERR_COMMON, 403: {"description": "BLOCKED | SOCIAL_RESTRICTED {until} | FRIENDS_NOT_ALLOWED {reason} | "
                                        "CONSENT_REQUIRED {purpose}"},
    404: {"description": "MEMBER_NOT_FOUND"},
    409: {"description": "ALREADY_FRIENDS | REQUEST_EXISTS | FRIENDS_LIMIT {limit}"},
    422: {"description": "VALIDATION_ERROR (себе) | IDEMPOTENCY_KEY_REUSED"},
    429: {"description": "REQUESTS_LIMIT {limit}"}})
async def create_request(body: MemberIn, request: Request,
                         idem: str | None = Header(default=None, alias="Idempotency-Key"),
                         me: Me = Depends(current_learner), rt: Runtime = Depends(get_runtime)) -> JSONResponse:
    """FriendRequestView 201; встречная pending-заявка — принятие (200, status accepted). Повтор ключа — 200 тот же
    ответ."""
    key = idempotency_key(idem)
    _require_friends(me)
    settings, gateway = settings_of(request), gateway_of(request)
    req_body = {"member_id": body.member_id}
    async with rt.transaction() as session:
        prior = await replay_of(session, me.user_id, "friend_request", key, req_body)
    if prior is not None:
        return _replayed(201, prior, True)
    target = await _target(rt, body.member_id, me)
    me_person, target_person = await asyncio.gather(person_of(rt, gateway, me.user_id),
                                                    person_of(rt, gateway, target))
    require_social(me_person)
    if social_reason(target_person) is not None:
        raise member_not_found()  # ученик без доступа к друзьям неотличим от несуществующего
    now = clock_of(request)()
    async with rt.transaction() as session:
        await _locked(session, me.user_id, target)
        prior = await replay_of(session, me.user_id, "friend_request", key, req_body)
        if prior is not None:
            return _replayed(201, prior, True)
        if await is_deleted(session, target):
            raise member_not_found()
        await require_not_banned(session, me.user_id, now)
        my_row = await community.ensure(session, me.user_id, now)
        req, created = await friends.create_request(
            session, me.user_id, target, now, ttl_days=settings.friend_request_ttl_days,
            per_day=settings.friend_requests_per_day, friends_max=settings.friends_max, my_nickname=my_row.nickname)
        out = await _request_out(session, settings, me.user_id, req, now)
        status = 201 if created else 200
        await store_idem(session, me.user_id, "friend_request", key, req_body, status, out, now)
    return JSONResponse(out, status_code=status)


@router.get("/friend-requests", responses=_ERR_COMMON)
async def list_requests(request: Request, direction: Literal["in", "out"] = Query(default="in"),
                        limit: int = Query(default=20, ge=1, le=100), cursor: str | None = Query(default=None,
                                                                                                  max_length=500),
                        me: Me = Depends(current_learner), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Page<FriendRequestView> — только действующие pending, новые сверху."""
    _require_friends(me)
    settings = settings_of(request)
    now = clock_of(request)()
    after = cursor_time_id(cursor)
    async with rt.transaction() as session:
        rows = await friends.list_requests(session, me.user_id, direction, now,
                                           ttl_days=settings.friend_request_ttl_days, limit=limit, after=after)
        page = list(rows[:limit])
        items = await _requests_out(session, settings, me.user_id, page, now)
    nxt = encode_cursor(iso(page[-1].created_at), str(page[-1].request_id)) if len(rows) > limit else None
    return {"items": items, "next_cursor": nxt}


async def _decide(rt: Runtime, request: Request, me: Me, request_id: uuid.UUID, action: str) -> dict[str, Any]:
    settings = settings_of(request)
    if action == "accept":
        _require_friends(me)
        require_social(await person_of(rt, gateway_of(request), me.user_id))
    now = clock_of(request)()
    async with rt.transaction() as session:
        req = await friends.load_request(session, request_id, me.user_id)
        other = req.to_user if req.from_user == me.user_id else req.from_user
        await _locked(session, me.user_id, other)
        req = await friends.load_request(session, request_id, me.user_id)
        if action == "accept" and friends.effective_status(req, now, settings.friend_request_ttl_days) == "pending":
            await require_not_banned(session, me.user_id, now)
        my_row = await community.get(session, me.user_id)
        req = await friends.decide(session, req, me.user_id, action, now, ttl_days=settings.friend_request_ttl_days,
                                   friends_max=settings.friends_max,
                                   my_nickname=my_row.nickname if my_row is not None else None)
        return await _request_out(session, settings, me.user_id, req, now)


@router.post("/friend-requests/{request_id}/accept", responses={
    **_ERR_COMMON, 403: {"description": "SOCIAL_RESTRICTED | BLOCKED | FRIENDS_NOT_ALLOWED | CONSENT_REQUIRED"},
    404: {"description": "REQUEST_NOT_FOUND"}, 409: {"description": "REQUEST_STATE {status} | FRIENDS_LIMIT"}})
async def accept_request(request_id: uuid.UUID, request: Request, me: Me = Depends(current_learner),
                         rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    return await _decide(rt, request, me, request_id, "accept")


@router.post("/friend-requests/{request_id}/decline", responses={
    **_ERR_COMMON, 404: {"description": "REQUEST_NOT_FOUND"}, 409: {"description": "REQUEST_STATE {status}"}})
async def decline_request(request_id: uuid.UUID, request: Request, me: Me = Depends(current_learner),
                          rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    return await _decide(rt, request, me, request_id, "decline")


@router.post("/friend-requests/{request_id}/cancel", responses={
    **_ERR_COMMON, 404: {"description": "REQUEST_NOT_FOUND"}, 409: {"description": "REQUEST_STATE {status}"}})
async def cancel_request(request_id: uuid.UUID, request: Request, me: Me = Depends(current_learner),
                         rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    return await _decide(rt, request, me, request_id, "cancel")


# ---------------------------------------------------------------- друзья


@router.get("/friends", responses=_ERR_COMMON)
async def list_friends(request: Request, limit: int = Query(default=20, ge=1, le=100),
                       cursor: str | None = Query(default=None, max_length=500), me: Me = Depends(current_learner),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Page<FriendView>: по нику (без учёта регистра), без ника — в конце; код друга не показывается."""
    _require_friends(me)
    settings = settings_of(request)
    after = decode_cursor(cursor, 3)
    async with rt.transaction() as session:
        pairs = await friends.friend_ids(session, me.user_id)
        mids = await members.register(session, settings.member_key_bytes(), [u for u, _ in pairs])
        nicks = await community.nicknames_of(session, [u for u, _ in pairs])
    rows = sorted(((0 if nicks[u] else 1, (nicks[u] or "").casefold(), mids[u], since) for u, since in pairs),
                  key=lambda t: (t[0], t[1], t[2]))
    if after is not None:
        rows = [r for r in rows if (r[0], r[1], r[2]) > (int(after[0]), str(after[1]), str(after[2]))]
    page = rows[:limit]
    by_mid = {mids[u]: u for u, _ in pairs}
    items = [{"member_id": mid, "nickname": nicks[by_mid[mid]], "since": iso(since)} for _, _, mid, since in page]
    nxt = encode_cursor(page[-1][0], page[-1][1], page[-1][2]) if len(rows) > limit else None
    return {"items": items, "next_cursor": nxt}


@router.delete("/friends/{member_id}", status_code=204, responses={**_ERR_COMMON,
                                                                  404: {"description": "MEMBER_NOT_FOUND"}})
async def remove_friend(member_id: str, request: Request, me: Me = Depends(current_learner),
                        rt: Runtime = Depends(get_runtime)) -> Response:
    """Удалить из друзей (повтор — 204; второй стороне — без уведомления, событие removed)."""
    target = await _target(rt, member_id, me)
    now = clock_of(request)()
    async with rt.transaction() as session:
        await _locked(session, me.user_id, target)
        await friends.remove_friendship(session, me.user_id, target, now, source="removed")
    return Response(status_code=204)


# ---------------------------------------------------------------- блокировки


@router.post("/blocks", status_code=201, responses={**_ERR_COMMON, 403: {"description": "KIDS_NOT_ALLOWED"},
                                                    404: {"description": "MEMBER_NOT_FOUND"}})
async def create_block(body: MemberIn, request: Request, me: Me = Depends(current_learner),
                       rt: Runtime = Depends(get_runtime)) -> JSONResponse:
    """BlockView (201; повтор — 200). Удаляет дружбу, отменяет заявки в обе стороны."""
    me.require_not_kids()
    target = await _target(rt, body.member_id, me)
    now = clock_of(request)()
    async with rt.transaction() as session:
        await _locked(session, me.user_id, target)
        if await is_deleted(session, target):
            raise member_not_found()
        row, created = await friends.block(session, me.user_id, target, now)
        nick = (await community.nicknames_of(session, [target]))[target]
    return JSONResponse({"member_id": body.member_id, "nickname": nick, "created_at": iso(row.created_at)},
                        status_code=201 if created else 200)


@router.get("/blocks", responses={**_ERR_COMMON, 403: {"description": "KIDS_NOT_ALLOWED"}})
async def list_blocks(request: Request, me: Me = Depends(current_learner),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    me.require_not_kids()
    settings = settings_of(request)
    async with rt.transaction() as session:
        rows = await friends.my_blocks(session, me.user_id)
        mids = await members.register(session, settings.member_key_bytes(), [b.blocked for b in rows])
        nicks = await community.nicknames_of(session, [b.blocked for b in rows])
    return {"items": [{"member_id": mids[b.blocked], "nickname": nicks[b.blocked], "created_at": iso(b.created_at)}
                      for b in rows]}


@router.delete("/blocks/{member_id}", status_code=204, responses={**_ERR_COMMON,
                                                                 403: {"description": "KIDS_NOT_ALLOWED"},
                                                                 404: {"description": "MEMBER_NOT_FOUND"}})
async def remove_block(member_id: str, request: Request, me: Me = Depends(current_learner),
                       rt: Runtime = Depends(get_runtime)) -> Response:
    """Снять блокировку (дружба не возвращается); повтор — 204."""
    me.require_not_kids()
    target = await _target(rt, member_id, me)
    now = clock_of(request)()
    async with rt.transaction() as session:
        await _locked(session, me.user_id, target)
        await friends.unblock(session, me.user_id, target, now)
    return Response(status_code=204)


# ---------------------------------------------------------------- жалобы, санкции, обжалование

_SUBJECT_REQUIRED = frozenset({"friend_request", "invite", "duel", "pair_room"})


@router.post("/complaints", status_code=201, responses={
    **_ERR_COMMON, 403: {"description": "KIDS_NOT_ALLOWED"}, 404: {"description": "MEMBER_NOT_FOUND"},
    422: {"description": "VALIDATION_ERROR | IDEMPOTENCY_KEY_REUSED"},
    429: {"description": "COMPLAINTS_LIMIT {limit}"}})
async def create_complaint(body: ComplaintIn, request: Request,
                           idem: str | None = Header(default=None, alias="Idempotency-Key"),
                           me: Me = Depends(current_learner), rt: Runtime = Depends(get_runtime)) -> JSONResponse:
    """ComplaintResult 201: дело модерации; повтор на ту же цель за 24 ч — 200 тот же case_id; block=true —
    блокировка. Комментарий — только модератору (в логи, события и аудит не идёт)."""
    key = idempotency_key(idem)
    me.require_not_kids()
    if (body.subject_kind in _SUBJECT_REQUIRED) != (body.subject_id is not None):
        raise validation_error("subject_id", "required" if body.subject_kind in _SUBJECT_REQUIRED else "must be null")
    settings = settings_of(request)
    req_body = body.model_dump(mode="json")
    async with rt.transaction() as session:
        prior = await replay_of(session, me.user_id, "complaint", key, req_body)
    if prior is not None:
        return _replayed(201, prior, True)
    target = await _target(rt, body.member_id, me)
    now = clock_of(request)()
    async with rt.transaction() as session:
        await _locked(session, me.user_id, target)
        prior = await replay_of(session, me.user_id, "complaint", key, req_body)
        if prior is not None:
            return _replayed(201, prior, True)
        if await is_deleted(session, target):
            raise member_not_found()
        if not await moderation.subject_related(session, body.subject_kind, body.subject_id, me.user_id, target):
            raise validation_error("subject_id", "not related to the reporter and the target")
        case = await moderation.recent_case(session, me.user_id, target, body.subject_kind, body.subject_id, now)
        status = 200
        if case is None:
            if await moderation.complaints_today(session, me.user_id, now) >= settings.complaints_per_day:
                raise ApiError(429, "COMPLAINTS_LIMIT", "Слишком много жалоб за сутки",
                               {"limit": settings.complaints_per_day})
            case = await moderation.create_case(session, me.user_id, target, subject_kind=body.subject_kind,
                                                subject_id=body.subject_id, reason=body.reason,
                                                comment=body.comment or None, now=now)
            status = 201
        if body.block:
            await friends.block(session, me.user_id, target, now)
        out = {"case_id": str(case.case_id), "created_at": iso(case.created_at), "blocked": body.block}
        await store_idem(session, me.user_id, "complaint", key, req_body, status, out, now)
    return JSONResponse(out, status_code=status)


async def _sanction_items(session: AsyncSession, rows: list[Sanction], now: datetime) -> list[dict[str, Any]]:
    appeals = await moderation.appeals_of(session, [s.sanction_id for s in rows])
    return [moderation.sanction_view(s, appeals.get(s.sanction_id), now) for s in rows]


@router.get("/sanctions", responses=_ERR_COMMON)
async def my_sanctions(request: Request, me: Me = Depends(current_learner),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """SanctionsResponse: активные и прошлые (новые сверху) с основанием и сроком; кто решал — не показывается."""
    now = clock_of(request)()
    async with rt.transaction() as session:
        rows = list(await moderation.sanctions_of(session, me.user_id))
        return {"items": await _sanction_items(session, rows, now)}


@router.post("/sanctions/{sanction_id}/appeal", status_code=201, responses={
    **_ERR_COMMON, 404: {"description": "SANCTION_NOT_FOUND"},
    409: {"description": "APPEAL_EXISTS | SANCTION_STATE"}})
async def appeal(sanction_id: uuid.UUID, body: AppealIn, request: Request,
                 idem: str | None = Header(default=None, alias="Idempotency-Key"),
                 me: Me = Depends(current_learner), rt: Runtime = Depends(get_runtime)) -> JSONResponse:
    """SanctionView 201 (повтор ключа — 200). Одно обжалование на санкцию."""
    key = idempotency_key(idem)
    now = clock_of(request)()
    async with rt.transaction() as session:
        await _locked(session, me.user_id)
        s, a, created = await moderation.create_appeal(session, me.user_id, sanction_id, body.text, key, now)
        out = moderation.sanction_view(s, a, now)
    return _replayed(201, out, not created)


# ---------------------------------------------------------------- рефералы


@router.get("/referrals", responses={**_ERR_COMMON, 403: {"description": "KIDS_NOT_ALLOWED"}})
async def my_referrals(request: Request, limit: int = Query(default=20, ge=1, le=100),
                       cursor: str | None = Query(default=None, max_length=500), me: Me = Depends(current_learner),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """ReferralsResponse: мои приглашённые (новые сверху), условия активной кампании, квалификации месяца."""
    me.require_not_kids()
    tz = zone(settings_of(request).social_timezone)
    now = clock_of(request)()
    after = cursor_time_id(cursor)
    async with rt.transaction() as session:
        rows, more = await referrals.my_page(session, me.user_id, limit, after)
        items = [await referrals.learner_view(session, r) for r in rows]
        camp = await campaigns.active(session)
        qualified = await referrals.month_count(session, me.user_id, now, tz)
    nxt = encode_cursor(iso(rows[-1].accepted_at), str(rows[-1].referral_id)) if more else None
    return {"items": items, "next_cursor": nxt, "terms": referrals.terms(camp),
            "month": {"qualified": qualified, "cap": int(camp.payload["monthly_cap"])}}
