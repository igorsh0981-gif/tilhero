"""Парный урок — команды ученика (INTERNAL_API §3.2, bff.ts «Парный урок»: PairRoomView, PairRoomState, PairAudio,
PairRoomReport).

Ученик — `lrn` токена; партнёр — только `member_id` (никогда user_id наружу). Чужая комната неотличима от
несуществующей (404 ROOM_NOT_FOUND). Каждая команда: обслуживание комнаты (своя транзакция) → блокировки обоих
участников → проверка удаления после блокировки → действие → события в той же транзакции → после фиксации —
пробуждение ленты, коуч (вне транзакции), оценка участников (фоном).

Спринт 8 (INTERNAL_API §5, BILLING_ENFORCED): урок вдвоём 14+ без ребёнка в комнате приглашает только подписчик с
функцией pair_lessons (billing `access`; нет — 403 SUBSCRIPTION_REQUIRED, billing недоступен — 503
BILLING_UNAVAILABLE); пригласивший — плательщик комнаты. Старт с коучем: перед первым вызовом коуча (вне транзакции) —
удержание у плательщика (ref room, PAIR_ROOM_MAX_MINUTES; повтор и переподключение — то же удержание); отказ или
billing недоступен — комната без коуча (сценарий с выбором реплик, ai_degraded, mode_changed) и без списания.
Приглашённому подписка не нужна (В8); комната с ребёнком и комната без коуча бесплатны (В9).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import time
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, conflict, forbidden, unprocessable
from tilhero_lessons import clients
from tilhero_lessons.catalog import CatalogGateway, ContentGone, catalog_unavailable
from tilhero_lessons.domain import coach, members, pair
from tilhero_lessons.domain.common import (
    IdempotencyReused,
    answer_invalid,
    decode_cursor,
    encode_cursor,
    free_text_not_allowed,
    iso,
    kids_not_allowed,
    lesson_not_available,
    pair_not_available,
    user_deleted,
)
from tilhero_lessons.domain.content import ref
from tilhero_lessons.domain.pair import Effects, Room, RoomHub, add_event, put, st
from tilhero_lessons.domain.users import Learner, audience_for
from tilhero_lessons.models import (
    ROOM_ACTIVE,
    ROOM_ENDED,
    PairRoom,
    RoomAudio,
    RoomEvent,
    RoomParticipant,
)
from tilhero_lessons.settings import Settings

log = logging.getLogger("tilhero.lessons.rooms")

EVENTS_MAX = 50
VOICE_PURPOSE = "voice_recording"
KIDS_BANDS = frozenset({"6-9", "10-13"})
WAV_TYPES = frozenset({"audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"})
AUDIO_MAX_BYTES = 600_000
JOIN_EARLY = timedelta(minutes=5)
START_SKEW = timedelta(seconds=60)


@dataclass
class RoomCtx:
    rt: Runtime
    catalog: CatalogGateway
    settings: Settings
    now: datetime
    learner: Learner
    hub: RoomHub
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)

    @property
    def user(self) -> uuid.UUID:
        return self.learner.user_id

    def member_key(self) -> bytes:
        return self.settings.member_key()


def not_your_turn() -> ApiError:
    return conflict("NOT_YOUR_TURN", "Сейчас ход партнёра")


def room_limit(room_id: uuid.UUID | None) -> ApiError:
    return conflict("ROOM_LIMIT", "Уже есть активная парная комната", {"room_id": str(room_id) if room_id else None})


def voice_consent_required(who: str) -> ApiError:
    return forbidden("VOICE_CONSENT_REQUIRED", "Нужно согласие на запись голоса", {"who": who})


def _hash(*parts: Any) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


# ---------------------------------------------------------------- представления


async def _partner(db: AsyncSession, room: Room, me: RoomParticipant, key: bytes) -> dict[str, Any]:
    other = room.other(me.side)
    uid = other.user_id
    nick = (await members.nicknames(db, [uid])).get(uid) if uid is not None else None
    return {"member_id": members.member_id(uid or members.DELETED_USER, key), "nickname": nick, "hero": None}


def _live_seconds(room: Room, p: RoomParticipant, now: datetime) -> int:
    extra = 0
    if room.r.status == "in_progress" and room.r.clock_at is not None and pair.present(p):
        extra = max(0, int((now - room.r.clock_at).total_seconds()))
    return p.active_seconds + extra


def _minutes(room: Room, p: RoomParticipant, now: datetime) -> int:
    if room.r.status in ROOM_ENDED:
        return p.minutes
    return min(math.ceil(_live_seconds(room, p, now) / 60), pair.MAX_EVENT_MINUTES)


def can_join(room: Room, me: RoomParticipant, now: datetime) -> bool:
    r = room.r
    if me.abandoned or r.status not in ("waiting", "in_progress", "paused"):
        return False
    return r.status != "waiting" or now >= r.start_at - JOIN_EARLY


async def room_view(db: AsyncSession, room: Room, me: RoomParticipant, now: datetime, key: bytes) -> dict[str, Any]:
    """PairRoomView (bff.ts)."""
    r = room.r
    return {
        "room_id": str(r.room_id), "status": r.status, "side": me.side,
        "partner": await _partner(db, room, me, key), "pair_id": r.pair_id,
        "scenario": {"scenario_id": r.scenario_id, "title": r.title, "level": r.level},
        "mode": r.mode, "start_at": iso(r.start_at),
        "respond_until": iso(r.respond_until) if r.status == "invited" else None,
        "created_at": iso(r.created_at), "started_at": iso(r.started_at), "ended_at": iso(r.ended_at),
        "end_reason": r.end_reason, "my_role": me.role,
        "can_accept": me.side == "invitee" and r.status == "invited" and now <= r.respond_until,
        "can_join": can_join(room, me, now), "minutes": _minutes(room, me, now),
        "report_available": r.status in ROOM_ENDED and me.joined_at is not None,
    }


async def state_view(db: AsyncSession, room: Room, me: RoomParticipant, after_seq: int,
                     locale: str | None) -> dict[str, Any]:
    """PairRoomState: события ленты после after_seq (≤ 50), подсказка и варианты для моего хода."""
    r = room.r
    s = st(r)
    rows = (await db.execute(select(RoomEvent).where(RoomEvent.room_id == r.room_id, RoomEvent.seq > after_seq)
                             .order_by(RoomEvent.seq).limit(EVENTS_MAX))).scalars().all()
    seq = rows[-1].seq if len(rows) == EVENTS_MAX else r.seq
    mine = r.next_speaker is not None and r.next_speaker in (me.role, "both") and not s.get("pending")
    roles: dict[str, Any] = s["roles"] if isinstance(s.get("roles"), dict) else {}
    gloss: dict[str, Any] | None = s["prompt_gloss"] if isinstance(s.get("prompt_gloss"), dict) else None
    lang = locale or me.locale
    return {
        "room_id": str(r.room_id), "status": r.status, "seq": seq,
        "events": [{"seq": e.seq, "kind": e.kind, "role": e.role, "text": e.text, "at": iso(e.at)} for e in rows],
        "mode": r.mode, "my_role": me.role, "my_role_brief": roles.get(me.role) if me.role else None,
        "team_goal": s.get("team_goal"), "team_goal_progress": round(float(s.get("progress", 0.0)), 3),
        "next_speaker": r.next_speaker if r.status in pair.LIVE else None,
        "prompt": s.get("prompt") if r.status in pair.LIVE else None,
        "prompt_gloss": gloss.get(lang) if gloss and r.status in pair.LIVE else None,
        "options": s.get("options") if r.mode == "choices" and mine and r.status == "in_progress" else None,
        "participants": [{"role": p.role, "me": p.side == me.side,
                          "network": "online" if pair.present(p) else "offline"}
                         for p in sorted(room.parts.values(), key=lambda x: x.side != me.side)],
        "ai_degraded": r.ai_degraded,
        "voice_available": bool(r.mode == "free" and me.voice and me.audience != "kids"
                                and r.status in pair.LIVE),
        "my_speaking_seconds": me.speaking_seconds,
    }


# ---------------------------------------------------------------- загрузка под блокировкой


async def _guard_user(db: AsyncSession, user_id: uuid.UUID) -> None:
    if await pair.is_deleted(db, user_id):
        raise user_deleted()


@asynccontextmanager
async def _locked(rc: RoomCtx, room_id: uuid.UUID) -> AsyncIterator[tuple[AsyncSession, Room, RoomParticipant]]:
    """Комната ученика под блокировками обоих участников; удаление ученика — проверка после блокировки."""
    async with rc.rt.transaction() as db:
        room = await pair.load(db, room_id)
        if room is None or room.me(rc.user) is None:
            await _guard_user(db, rc.user)
            raise pair.room_not_found()
        await pair.lock_users(db, *room.users, rc.user)
        await _guard_user(db, rc.user)
        room = await pair.load(db, room_id, fresh=True)
        me = room.me(rc.user) if room is not None else None
        if room is None or me is None:
            raise pair.room_not_found()
        yield db, room, me
        pair.schedule(room, rc.settings)  # срок следующего обслуживания — для планировщика


async def _after(rc: RoomCtx, room_id: uuid.UUID, eff: Effects, *, inline: bool = False) -> None:
    """После фиксации: пробуждение ленты, коуч, оценка участников (фоном). Коуч ждётся в запросе только для
    собственной команды (ход, вход — inline); повтор неполученного ответа и молчание, найденные обслуживанием
    (лента long-poll, heartbeat, карточка, выход), — фоновой задачей: запрос не ждёт ИИ (до 20 с)."""
    if eff.coach and inline:
        eff.merge(await run_coach(rc, room_id, eff.coach))
    elif eff.coach:
        rc.hub.spawn(_coach_job(rc, room_id, eff.coach))
    if eff.silence:
        rc.hub.spawn(_coach_job(rc, room_id, "silence"))
    if eff.notify or eff.evaluate:
        rc.hub.notify(room_id)
    for side in eff.evaluate:
        rc.hub.spawn(pair.evaluate(rc.rt, room_id, side, rc.now))


async def _coach_job(rc: RoomCtx, room_id: uuid.UUID, trigger: str) -> None:
    """Фоновый вызов коуча (своё время — по часам сервиса); ошибки не роняют процесс — повтор по сроку ожидания."""
    job = replace(rc, now=rc.clock())
    try:
        eff = await run_coach(job, room_id, trigger)
        eff.coach = None
        eff.silence = False
        await _after(job, room_id, eff)
    except Exception as exc:  # фоновая задача: только тип ошибки в лог, комната продолжится по сроку ожидания
        log.warning("background coach failed", extra={"error_type": type(exc).__name__, "trigger": trigger})


async def refresh(rc: RoomCtx, room_id: uuid.UUID) -> None:
    await _after(rc, room_id, await pair.refresh(rc.rt, room_id, rc.now, rc.settings))


async def scenario_of(rc: RoomCtx, r: PairRoom) -> dict[str, Any]:
    sref = r.content_versions.get("scenario") or {}
    try:
        return await rc.catalog.version("scenario", str(sref["key"]), int(sref["version"]))
    except (ContentGone, KeyError) as exc:
        log.warning("pair room scenario version missing", extra={"error_type": type(exc).__name__})
        raise catalog_unavailable() from None


# ---------------------------------------------------------------- коуч (вне транзакции)


async def run_coach(rc: RoomCtx, room_id: uuid.UUID, trigger: str) -> Effects:
    """Вызов коуча по ожиданию (pending) или молчанию; ответ применяется, если комната не ушла вперёд. Ошибка ИИ →
    сценарий с выбором реплик (молчание — без последствий). AiBusy — ответ ещё готовится: ожидание остаётся."""
    async with rc.rt.transaction() as db:
        room = await pair.load(db, room_id)
        if room is None or room.r.status not in pair.LIVE or room.r.engine != "ai":
            return Effects()
        r = room.r
        s = st(r)
        pending = s.get("pending")
        if trigger == "silence":
            if pending or r.status != "in_progress" or r.next_speaker is None:
                return Effects()
            speaker = room.by_role(r.next_speaker) if r.next_speaker in ("A", "B") else None
        else:
            if not pending:
                return Effects()
            trigger = str(pending.get("trigger") or trigger)
            speaker = room.parts.get(str(pending.get("side") or "inviter"))
        turn_no = r.turn_seq
        scn = await scenario_of(rc, r)
        ctx_body = await coach.context(db, room, scn, trigger, rc.now, rc.settings)
        caller = speaker if speaker is not None and speaker.user_id is not None else next(
            (p for p in room.parts.values() if p.user_id is not None), None)
        if caller is None or caller.user_id is None:
            return Effects()
        user_id, locale, audience = caller.user_id, caller.locale, coach.coach_audience(room)
        last_role = speaker.role if speaker is not None else None
        payer = r.billing_payer_user_id if trigger == "start" and r.billing_hold_id is None else None
        # оплаченная комната: коуч — от имени плательщика (его тариф у ai-gateway; при paid_only бесплатный
        # приглашённый иначе остановил бы коуча, за которого заплатил пригласивший)
        paid_by = r.billing_payer_user_id if r.billing_hold_id is not None else None
    if payer is not None and rc.settings.billing_enforced:
        hold = await clients.create_hold(rc.rt, user_id=payer, feature="pair_lessons", ref_kind="room",
                                         ref_id=room_id, minutes_planned=rc.settings.pair_room_max_minutes)
        if not hold.allowed or hold.hold_id is None:
            return await _no_coach(rc, room_id, scn, turn_no, hold.reason or clients.BILLING_UNAVAILABLE)
        await _keep_hold(rc, room_id, payer, hold)
        paid_by = payer
    try:
        result = await clients.invoke_agent(
            rc.rt, coach.AGENT, request_id=coach.request_id(room_id, trigger, turn_no), session_id=room_id,
            session_kind="pair", user_id=paid_by or user_id, audience=audience, locale=locale, context=ctx_body)
    except clients.AiBusy:
        return Effects()
    parsed = coach.parse(result.output, room) if result.status == "ok" else None
    if result.status != "ok" or parsed is None:
        log.info("coach unavailable", extra={"reason": (result.reason or "invalid_output")[:40]})
    async with rc.rt.transaction() as db:
        room = await pair.load(db, room_id)
        if room is None:
            return Effects()
        await pair.lock_users(db, *room.users)
        room = await pair.load(db, room_id, fresh=True)
        if room is None or room.r.status not in pair.LIVE or room.r.engine != "ai" or room.r.turn_seq != turn_no:
            return Effects()
        s = st(room.r)
        pair.accrue(room, rc.now)
        if trigger == "silence":
            if s.get("pending") or parsed is None:
                return Effects()
            eff = await coach.apply(db, room, scn, parsed, trigger, result.cost_usd, rc.now, rc.settings)
        elif not s.get("pending"):
            return Effects()
        elif parsed is None:
            room.r.ai_cost_usd = (room.r.ai_cost_usd or 0) + result.cost_usd
            nxt = "A" if trigger == "start" else coach.other_role(last_role)
            eff = await coach.degrade(db, room, scn, rc.now, rc.settings, next_role=nxt)
        else:
            eff = await coach.apply(db, room, scn, parsed, trigger, result.cost_usd, rc.now, rc.settings)
        pair.schedule(room, rc.settings)
        return eff


async def _keep_hold(rc: RoomCtx, room_id: uuid.UUID, payer: uuid.UUID, hold: clients.Hold) -> None:
    """Удержание комнаты записывается сразу (до ответа коуча): событие завершения понесёт hold_id при любом исходе."""
    async with rc.rt.transaction() as db:
        room = await pair.load(db, room_id)
        if room is None:
            return
        await pair.lock_users(db, *room.users)
        room = await pair.load(db, room_id, fresh=True)
        if room is None or room.r.billing_payer_user_id != payer or room.r.billing_hold_id is not None:
            return
        room.r.billing_hold_id = hold.hold_id
        put(room.r, billing={"outcome": "held", "minutes_left": hold.minutes_left})
        if room.r.status not in pair.LIVE:
            # комната успела закончиться без удержания (событие уже ушло) — минуты вернёт истечение удержания
            log.warning("pair room hold after finish", extra={"status": room.r.status})


async def _no_coach(rc: RoomCtx, room_id: uuid.UUID, scn: dict[str, Any], turn_no: int, reason: str) -> Effects:
    """Удержание не дано (нет подписки, функции, минут) или billing недоступен: комната без коуча — сценарий с выбором
    реплик (mode_changed, ai_degraded), без списания; в суточный лимит комнат с коучем не идёт."""
    log.info("pair room without coach (billing)", extra={"reason": reason[:40]})
    async with rc.rt.transaction() as db:
        room = await pair.load(db, room_id)
        if room is None:
            return Effects()
        await pair.lock_users(db, *room.users)
        room = await pair.load(db, room_id, fresh=True)
        if room is None or room.r.status not in pair.LIVE or room.r.engine != "ai" or room.r.turn_seq != turn_no \
                or not st(room.r).get("pending") or room.r.billing_hold_id is not None:
            return Effects()
        pair.accrue(room, rc.now)
        room.r.coach_used = False
        put(room.r, billing={"outcome": reason})
        eff = await coach.degrade(db, room, scn, rc.now, rc.settings, next_role="A")
        pair.schedule(room, rc.settings)
        return eff


# ---------------------------------------------------------------- приглашение


def parse_start(value: str, now: datetime, settings: Settings) -> datetime:
    if value == "now":
        return now
    try:
        at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise unprocessable("VALIDATION_ERROR", "start — «now» или время ISO-8601", {"field": "start"}) from None
    if at.tzinfo is None:
        raise unprocessable("VALIDATION_ERROR", "Время start — с часовым поясом", {"field": "start"})
    at = at.astimezone(UTC)
    if at < now - START_SKEW or at > now + timedelta(days=settings.pair_schedule_days):
        raise unprocessable("VALIDATION_ERROR", "start — не в прошлом и не дальше 7 дней", {"field": "start"})
    return max(at, now)


async def _room_by_key(rc: RoomCtx, key: str, rhash: str) -> dict[str, Any] | None:
    async with rc.rt.transaction() as db:
        await _guard_user(db, rc.user)
        rid = (await db.execute(select(PairRoom.room_id).where(PairRoom.inviter == rc.user,
                                                               PairRoom.idempotency_key == key))).scalar_one_or_none()
        if rid is None:
            return None
        room = await pair.load(db, rid)
        assert room is not None
        if room.r.request_hash != rhash:
            raise IdempotencyReused
        me = room.me(rc.user)
        assert me is not None
        return await room_view(db, room, me, rc.now, rc.member_key())


async def invite(rc: RoomCtx, *, partner_member_id: str, pair_id: str, scenario_id: str, start: str,
                 key: str) -> tuple[dict[str, Any], bool]:
    """POST /internal/v1/me/pair-rooms (Idempotency-Key) → (PairRoomView, повтор)."""
    rhash = _hash("pair_room", partner_member_id, pair_id, scenario_id, start)
    replay = await _room_by_key(rc, key, rhash)
    if replay is not None:
        return replay, True
    start_at = parse_start(start, rc.now, rc.settings)
    await _tend_mine(rc)  # просроченная старая комната сначала обслуживается (истечение), а не даёт ROOM_LIMIT
    partner = await members.resolve(rc.rt, rc.rt.transaction, partner_member_id, rc.member_key())
    if partner == rc.user:
        raise unprocessable("VALIDATION_ERROR", "Нельзя пригласить себя", {"field": "partner_member_id"})
    async with rc.rt.transaction() as db:
        await _guard_user(db, rc.user)
        my_audience = await audience_for(db, rc.learner, None)
    adm = await members.admit(rc.rt, rc.rt.transaction, rc.user, partner, my_audience, rc.now, rc.member_key())
    info = await rc.catalog.pair(pair_id)
    if info is None or not info.available:
        raise pair_not_available(pair_id)
    audiences = {adm.me_audience, adm.partner_audience}
    found = await rc.catalog.published("scenario", scenario_id)
    if found is None or not audiences <= set(found[1].get("audience") or []):
        raise lesson_not_available()
    version, scn = found
    rubric = await rc.catalog.published("rubric", str(scn.get("rubric_id"))) if scn.get("rubric_id") else None
    cv: dict[str, Any] = {"scenario": ref(scenario_id, version)}
    if rubric is not None:
        cv["rubric"] = ref(str(scn["rubric_id"]), rubric[0])
    kids = "kids" in audiences
    payer = await _payer(rc, kids)
    room_id = uuid.uuid4()
    r = PairRoom(
        room_id=room_id, pair_id=pair_id, scenario_id=scenario_id, content_versions=cv, title=scn["title"],
        level=scn.get("level"), mode="choices" if kids else "free", engine="script" if kids else "ai",
        ai_degraded=False, audience=members.strictest(*audiences), status="invited", inviter=rc.user,
        invitee=partner, start_at=start_at,
        respond_until=start_at + timedelta(minutes=rc.settings.pair_invite_minutes), created_at=rc.now,
        team_goal_reached=False, seq=0, turn_seq=0, progress_seconds=0,
        state={"progress": 0.0, "scenario_skills": coach.scenario_skills(scn)},
        idempotency_key=key, request_hash=rhash, updated_at=rc.now, billing_payer_user_id=payer,
        coach_active_seconds=0)
    r.due_at = r.respond_until
    parts = [RoomParticipant(room_id=room_id, side="inviter", user_id=rc.user,
                             session_id=pair.session_id_for(room_id, rc.user), audience=adm.me_audience,
                             holds_slot=True, evidence=[]),
             RoomParticipant(room_id=room_id, side="invitee", user_id=partner,
                             session_id=pair.session_id_for(room_id, partner), audience=adm.partner_audience,
                             holds_slot=False, evidence=[])]
    try:
        async with rc.rt.transaction() as db:
            await pair.lock_users(db, rc.user, partner)
            await _guard_user(db, rc.user)  # после блокировки (сага держит её до фиксации)
            if await pair.is_deleted(db, partner):
                raise members.member_not_found()
            replay_id = (await db.execute(select(PairRoom.room_id).where(
                PairRoom.inviter == rc.user, PairRoom.idempotency_key == key))).scalar_one_or_none()
            if replay_id is None:
                await _check_limits(db, rc.user, partner)
                if await members.blocked_between(db, rc.user, partner):
                    raise members.blocked()
                await members.ensure_not_restricted(db, rc.user, rc.now)
                db.add(r)
                await db.flush()
                for p in parts:
                    db.add(p)
                await db.flush()
                room = Room(r, {p.side: p for p in parts})
                nick = (await members.nicknames(db, [rc.user])).get(rc.user)
                await pair.emit_invited(db, room, nick)
    except IntegrityError:
        raise room_limit(None) from None
    if replay_id is not None:
        replay = await _room_by_key(rc, key, rhash)
        assert replay is not None
        return replay, True
    async with rc.rt.transaction() as db:
        room2 = await pair.load(db, room_id)
        assert room2 is not None
        me = room2.me(rc.user)
        assert me is not None
        return await room_view(db, room2, me, rc.now, rc.member_key()), False


async def _payer(rc: RoomCtx, kids: bool) -> uuid.UUID | None:
    """Спринт 8: плательщик урока вдвоём — пригласивший с подпиской (функция pair_lessons). Пэйвол выключен или в
    комнате ребёнок (только сценарий, без ИИ) — бесплатно, billing не вызывается."""
    if not rc.settings.billing_enforced or kids:
        return None
    found = await clients.access(rc.rt, rc.user, "pair_lessons")
    if found is None:
        raise clients.billing_unavailable()
    if not found.allowed:
        raise clients.subscription_required("pair_lessons", found.reason or "no_subscription")
    return rc.user


async def _tend_mine(rc: RoomCtx) -> None:
    """Обслуживание активных комнат ученика (истекшие приглашения и ожидание, брошенные комнаты) до проверки
    лимита: просроченная комната не держит «слот» до планировщика."""
    async with rc.rt.transaction() as db:
        ids = list((await db.execute(select(RoomParticipant.room_id).join(
            PairRoom, PairRoom.room_id == RoomParticipant.room_id).where(
            RoomParticipant.user_id == rc.user, PairRoom.status.in_(ROOM_ACTIVE)).limit(10))).scalars().all())
    for room_id in ids:
        await refresh(rc, room_id)


async def _check_limits(db: AsyncSession, me: uuid.UUID, partner: uuid.UUID) -> None:
    """≤ 1 активной комнаты на ученика (слот); встречное неотвеченное приглашение от партнёра — принять его."""
    mine = (await db.execute(select(RoomParticipant.room_id).where(
        RoomParticipant.user_id == me, RoomParticipant.holds_slot.is_(True)))).scalar_one_or_none()
    if mine is not None:
        raise room_limit(mine)
    incoming = (await db.execute(select(PairRoom.room_id).where(
        PairRoom.status == "invited", PairRoom.inviter == partner, PairRoom.invitee == me))).scalar_one_or_none()
    if incoming is not None:
        raise room_limit(incoming)


# ---------------------------------------------------------------- список, карточка


async def list_rooms(rc: RoomCtx, status: str, cursor: str | None, limit: int) -> dict[str, Any]:
    after = decode_cursor(cursor, 2)
    statuses = ROOM_ACTIVE if status == "active" else tuple(s for s in (
        "declined", "expired", "cancelled", "finished", "abandoned", "stopped"))
    async with rc.rt.transaction() as db:
        await _guard_user(db, rc.user)
        stmt = select(PairRoom).join(RoomParticipant, RoomParticipant.room_id == PairRoom.room_id).where(
            RoomParticipant.user_id == rc.user, PairRoom.status.in_(statuses))
        if after is not None:
            try:
                at, rid = datetime.fromisoformat(str(after[0])), uuid.UUID(str(after[1]))
            except ValueError:
                raise unprocessable("INVALID_CURSOR", "Некорректный курсор") from None
            stmt = stmt.where(or_(PairRoom.created_at < at, and_(PairRoom.created_at == at, PairRoom.room_id < rid)))
        rows = list((await db.execute(stmt.order_by(PairRoom.created_at.desc(), PairRoom.room_id.desc())
                                      .limit(limit + 1))).scalars().all())
        page = rows[:limit]
        items = []
        for r in page:
            room = await pair.load(db, r.room_id)
            assert room is not None
            me = room.me(rc.user)
            assert me is not None
            items.append(await room_view(db, room, me, rc.now, rc.member_key()))
    nxt = encode_cursor(page[-1].created_at.isoformat(), str(page[-1].room_id)) if len(rows) > limit else None
    return {"items": items, "next_cursor": nxt}


async def get_room(rc: RoomCtx, room_id: uuid.UUID) -> dict[str, Any]:
    await refresh(rc, room_id)
    async with rc.rt.transaction() as db:
        await _guard_user(db, rc.user)
        room = await pair.load(db, room_id)
        me = room.me(rc.user) if room is not None else None
        if room is None or me is None:
            raise pair.room_not_found()
        return await room_view(db, room, me, rc.now, rc.member_key())


# ---------------------------------------------------------------- принять, отклонить, отменить


async def _view_after(rc: RoomCtx, room_id: uuid.UUID, eff: Effects) -> dict[str, Any]:
    await _after(rc, room_id, eff)
    return await get_room(rc, room_id)


async def accept(rc: RoomCtx, room_id: uuid.UUID) -> dict[str, Any]:
    """Приглашённый принимает: санкции и блокировки — по проекции и по relations social (синхронно: проекция могла
    ещё не получить событие); ≤ 1 активной комнаты."""
    await _tend_mine(rc)
    async with rc.rt.transaction() as db:
        room0 = await pair.load(db, room_id)
        inviter = room0.parts["inviter"].user_id if room0 is not None and room0.me(rc.user) is not None else None
        pending = room0 is not None and room0.r.status == "invited" and room0.r.accepted_at is None
    if inviter is not None and pending and inviter != rc.user:
        rel = await clients.relation(rc.rt, rc.user, inviter)
        if rel is not None:
            if rel.a_restricted:
                async with rc.rt.transaction() as db:
                    await members.ensure_not_restricted(db, rc.user, rc.now, True, rel.a_until)
            if rel.blocked_any:
                raise members.blocked()
    eff = Effects()
    async with _locked(rc, room_id) as (db, room, me):
        r = room.r
        if me.side != "invitee":
            raise pair.room_state(r.status, side=me.side)
        if r.accepted_at is not None and r.status not in ("cancelled", "expired", "declined"):
            pass  # повтор с тем же исходом
        elif r.status != "invited":
            raise pair.room_state(r.status)
        else:
            await members.ensure_not_restricted(db, rc.user, rc.now)
            if room.users and len(room.users) == 2 and await members.blocked_between(db, room.users[0],
                                                                                    room.users[1]):
                raise members.blocked()
            other_slot = (await db.execute(select(RoomParticipant.room_id).where(
                RoomParticipant.user_id == rc.user, RoomParticipant.holds_slot.is_(True),
                RoomParticipant.room_id != room_id))).scalar_one_or_none()
            if other_slot is not None:
                raise room_limit(other_slot)
            me.holds_slot = True
            r.status = "waiting"
            r.accepted_at = rc.now
            r.updated_at = rc.now
            eff.notify = True
    return await _view_after(rc, room_id, eff)


async def decline(rc: RoomCtx, room_id: uuid.UUID) -> dict[str, Any]:
    await refresh(rc, room_id)
    eff = Effects()
    async with _locked(rc, room_id) as (_db, room, me):
        r = room.r
        if me.side != "invitee":
            raise pair.room_state(r.status, side=me.side)
        if r.status == "invited":
            r.status = "declined"
            r.ended_at = rc.now
            r.updated_at = rc.now
            pair.release_slots(room)
            eff.notify = True
        elif r.status != "declined":
            raise pair.room_state(r.status)
    return await _view_after(rc, room_id, eff)


async def cancel(rc: RoomCtx, room_id: uuid.UUID) -> dict[str, Any]:
    await refresh(rc, room_id)
    eff = Effects()
    async with _locked(rc, room_id) as (_db, room, _me):
        r = room.r
        if r.status in ("invited", "waiting") and r.started_at is None:
            r.status = "cancelled"
            r.ended_at = rc.now
            r.updated_at = rc.now
            pair.release_slots(room)
            eff.notify = True
        elif r.status != "cancelled":
            raise pair.room_state(r.status)
    return await _view_after(rc, room_id, eff)


# ---------------------------------------------------------------- вход, присутствие, выход


async def _voice_allowed(rc: RoomCtx, me_audience: str) -> bool:
    """Голос в комнате: не ребёнок, согласие на запись голоса (identity-consent, политика 1.1+) и распознавание
    включено (ai-gateway status speech_available)."""
    if me_audience == "kids" or rc.learner.child_by_claims:
        return False
    public, speech = await asyncio.gather(clients.public_profile(rc.rt, rc.user), clients.speech_available(rc.rt))
    return bool(public is not None and has_voice_consent(public) and speech)


def has_voice_consent(public: dict[str, Any]) -> bool:
    purposes = public.get("purposes")
    return isinstance(purposes, list) and VOICE_PURPOSE in purposes and public.get("status") in (None, "ACTIVE")


def who_must_consent(public: dict[str, Any], learner: Learner) -> str:
    band = public.get("age_band")
    if public.get("kind") == "child" or band in KIDS_BANDS or learner.child_by_claims:
        return "guardian"
    if band == "14-17" and public.get("guardian_consent") != "granted":
        return "guardian"
    return "self"


def _resume_if_back(db: AsyncSession, room: Room, now: datetime) -> bool:
    """Пауза из-за потери связи снимается, когда все, кто в комнате, снова на связи."""
    r = room.r
    if r.status != "paused" or st(r).get("pause_reason") != "offline":
        return False
    if any(pair.in_room(p) and not pair.present(p) for p in room.parts.values()):
        return False
    pair.resume(db, room, now)
    return True


async def join(rc: RoomCtx, room_id: uuid.UUID, locale: str) -> dict[str, Any]:
    """Вход (повторный вход и возврат ≤ 3 мин — та же комната и та же сессия). Оба вошли → in_progress, коуч
    раздаёт роли и цель (без ИИ — сценарий с выбором реплик)."""
    await refresh(rc, room_id)
    async with rc.rt.transaction() as db:
        room = await pair.load(db, room_id)
        me = room.me(rc.user) if room is not None else None
        if room is None or me is None:
            await _guard_user(db, rc.user)
            raise pair.room_not_found()
        need_voice = me.joined_at is None and room.r.mode == "free" and me.audience != "kids"
    voice = await _voice_allowed(rc, me.audience) if need_voice else None
    eff = Effects()
    async with _locked(rc, room_id) as (db, room, me):
        r = room.r
        if me.abandoned:
            raise pair.room_not_active("abandoned")
        if r.status not in ("waiting", "in_progress", "paused"):
            raise pair.room_not_active(r.status)
        if r.status == "waiting" and rc.now < r.start_at - JOIN_EARLY:
            raise pair.room_not_active(r.status, start_at=iso(r.start_at))
        pair.accrue(room, rc.now)
        first = me.joined_at is None
        was_away = not first and not pair.present(me)
        if first:
            me.joined_at = rc.now
            me.locale = locale
            if voice is not None:
                me.voice = voice
        me.left_at = None
        me.absent_since = None
        me.network = "online"
        me.last_seen_at = rc.now
        if first or was_away:
            add_event(db, room, "joined" if first else "online", rc.now, side=me.side, role=me.role)
            r.last_activity_at = rc.now
            eff.notify = True
        if r.status == "waiting" and all(pair.present(p) for p in room.parts.values()):
            eff.merge(await _start(rc, db, room))
        elif _resume_if_back(db, room, rc.now):
            eff.notify = True
        elif r.status == "paused" and st(r).get("pause_reason") == "safety" and not first:
            pair.resume(db, room, rc.now)
            eff.notify = True
    await _after(rc, room_id, eff, inline=True)  # старт коуча — часть входа
    return await _state(rc, room_id, 0, locale)


async def _start(rc: RoomCtx, db: AsyncSession, room: Room) -> Effects:
    """Оба вошли: роли A (пригласивший) и B, старт урока; коуч ИИ — после фиксации (pending start)."""
    r = room.r
    r.status = "in_progress"
    r.started_at = rc.now
    r.clock_at = rc.now
    r.last_activity_at = rc.now
    room.parts["inviter"].role = "A"
    room.parts["invitee"].role = "B"
    if r.engine == "ai" and await _coach_limit_reached(rc, db, room):
        # суточный лимит комнат с ИИ-коучем у кого-то из участников — комната идёт сценарием с выбором реплик
        r.engine = "script"
        r.mode = "choices"
        r.ai_degraded = True
        put(r, ai_limited=True)
        add_event(db, room, "mode_changed", rc.now)
    if r.engine == "ai":
        r.coach_used = True
        put(r, pending={"trigger": "start", "side": "inviter", "at": rc.now.isoformat()})
        r.next_speaker = None
        return Effects(notify=True, coach="start")
    scn = await scenario_of(rc, r)
    return await coach.script_start(db, room, scn, rc.now, rc.settings)


async def _coach_limit_reached(rc: RoomCtx, db: AsyncSession, room: Room) -> bool:
    """Комнат с коучем, начатых участником за местные сутки (STATS_TIMEZONE), ≥ PAIR_AI_ROOMS_PER_DAY."""
    limit = rc.settings.pair_ai_rooms_per_day
    if limit <= 0:
        return True
    tz = ZoneInfo(rc.settings.stats_timezone)
    day_start = rc.now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    for uid in room.users:
        used = (await db.execute(select(func.count(func.distinct(PairRoom.room_id))).select_from(PairRoom).join(
            RoomParticipant, RoomParticipant.room_id == PairRoom.room_id).where(
            RoomParticipant.user_id == uid, PairRoom.coach_used.is_(True), PairRoom.started_at >= day_start,
            PairRoom.room_id != room.r.room_id))).scalar_one()
        if int(used) >= limit:
            return True
    return False


async def heartbeat(rc: RoomCtx, room_id: uuid.UUID) -> None:
    """Каждые 10 с; без него 30 с — offline (в свой ход — пауза). Возврат на связь снимает паузу."""
    eff = Effects()
    async with _locked(rc, room_id) as (db, room, me):
        r = room.r
        if r.status not in ("waiting", "in_progress", "paused") or me.joined_at is None or me.left_at is not None \
                or me.abandoned:
            raise pair.room_not_active("abandoned" if me.abandoned else r.status)
        # сначала время до этого момента (отправитель на связи с последнего heartbeat), затем отметка присутствия
        # и только потом обслуживание (offline других, соло, сроки)
        pair.accrue(room, rc.now)
        if me.last_seen_at is None or me.last_seen_at >= rc.now - timedelta(seconds=rc.settings.pair_offline_seconds):
            me.last_seen_at = rc.now
        eff.merge(await pair.tend(db, room, rc.now, rc.settings))
        if r.status not in ("waiting", "in_progress", "paused") or me.abandoned:
            raise pair.room_not_active("abandoned" if me.abandoned else r.status)
        if me.network != "online":
            me.network = "online"
            add_event(db, room, "online", rc.now, side=me.side, role=me.role)
            eff.notify = True
        me.absent_since = None
        me.last_seen_at = rc.now
        if _resume_if_back(db, room, rc.now):
            eff.notify = True
    await _after(rc, room_id, eff)


async def leave(rc: RoomCtx, room_id: uuid.UUID) -> dict[str, Any]:
    """Выход: в ожидании — из лобби; в уроке — отсутствие (возврат ≤ 3 мин — та же комната), в свой ход — пауза;
    оставшийся в соло или второй вышедший — завершение (participant_left)."""
    eff = Effects()
    async with _locked(rc, room_id) as (db, room, me):
        r = room.r
        eff.merge(await pair.tend(db, room, rc.now, rc.settings))
        if r.status not in ("waiting", "in_progress", "paused"):
            raise pair.room_not_active(r.status)
        if me.joined_at is not None and me.left_at is None and not me.abandoned:
            pair.accrue(room, rc.now)
            if r.status == "waiting":
                me.joined_at = None
                me.network = None
                add_event(db, room, "left", rc.now, side=me.side, role=me.role)
            else:
                me.left_at = rc.now
                me.network = "offline"
                me.absent_since = rc.now
                add_event(db, room, "left", rc.now, side=me.side, role=me.role)
                others = [p for p in room.parts.values() if p.side != me.side and pair.in_room(p)]
                if st(r).get("solo") == me.role or not others:
                    eff.merge(await pair.finish(db, room, "abandoned", "participant_left", rc.now, rc.settings))
                elif r.status == "in_progress" and r.next_speaker == me.role:
                    pair.pause(db, room, "offline", rc.now)
            eff.notify = True
    return await _view_after(rc, room_id, eff)


# ---------------------------------------------------------------- лента (long-poll)


async def _state(rc: RoomCtx, room_id: uuid.UUID, after_seq: int, locale: str | None) -> dict[str, Any]:
    async with rc.rt.transaction() as db:
        await _guard_user(db, rc.user)
        room = await pair.load(db, room_id)
        me = room.me(rc.user) if room is not None else None
        if room is None or me is None:
            raise pair.room_not_found()
        return await state_view(db, room, me, after_seq, locale)


async def state(rc: RoomCtx, room_id: uuid.UUID, after_seq: int, locale: str | None) -> dict[str, Any]:
    """GET …/state?after_seq=N — сразу, если в ленте есть события новее N, статус изменился или комната не идёт;
    иначе ждём до PAIR_POLL_SECONDS (≤ 25 с) — пробуждение в процессе и опрос БД раз в интервал."""
    deadline = time.monotonic() + rc.settings.pair_poll_seconds
    start_status: str | None = None
    while True:
        if start_status is not None:
            rc.now = rc.clock()
        await refresh(rc, room_id)
        async with rc.rt.transaction() as db:
            await _guard_user(db, rc.user)
            room = await pair.load(db, room_id)
            me = room.me(rc.user) if room is not None else None
            if room is None or me is None:
                raise pair.room_not_found()
            r = room.r
            start_status = start_status or r.status
            left = deadline - time.monotonic()
            if r.seq > after_seq or after_seq > r.seq or r.status != start_status \
                    or r.status not in ("invited", "waiting", "in_progress", "paused") or left <= 0:
                return await state_view(db, room, me, after_seq, locale)
        await rc.hub.wait(room_id, min(rc.settings.pair_poll_interval_seconds, left))


# ---------------------------------------------------------------- ход


def _turn_hash(body: dict[str, Any]) -> str:
    return _hash("turn", body.get("text"), body.get("choice_id"), body.get("audio_id"))


async def turn(rc: RoomCtx, room_id: uuid.UUID, body: dict[str, Any], key: str) -> dict[str, Any]:
    """Ход по очереди (Idempotency-Key: повтор — тот же ответ без второго хода). Ровно одно поле: text (≤ 300; детям
    — 403 KIDS_NOT_ALLOWED), choice_id (из options) или audio_id (распознанный голос, один раз, 5 минут)."""
    await refresh(rc, room_id)
    rhash = _turn_hash(body)
    eff = Effects()
    scn: dict[str, Any] | None = None
    async with rc.rt.transaction() as db:
        room = await pair.load(db, room_id)
        if room is not None and room.r.engine == "script" and room.me(rc.user) is not None:
            scn = await scenario_of(rc, room.r)
    async with _locked(rc, room_id) as (db, room, me):
        r = room.r
        if r.engine == "script" and scn is None:
            scn = await scenario_of(rc, r)
        prior = (await db.execute(select(RoomEvent).where(
            RoomEvent.room_id == room_id, RoomEvent.side == me.side, RoomEvent.idempotency_key == key))
            ).scalar_one_or_none()
        if prior is not None:
            if prior.request_hash != rhash:
                raise IdempotencyReused
            before = prior.seq - 1
        else:
            before = r.seq
            free = body.get("text") is not None or body.get("audio_id") is not None
            if free and (me.audience == "kids" or rc.learner.child_by_claims):
                raise kids_not_allowed()
            if pair.in_room(me) and me.left_at is None and me.network != "online":
                # ход — признак присутствия (heartbeat мог потеряться): снова на связи, пауза из-за него снимается
                pair.accrue(room, rc.now)
                me.network = "online"
                me.absent_since = None
                me.last_seen_at = rc.now
                add_event(db, room, "online", rc.now, side=me.side, role=me.role)
                _resume_if_back(db, room, rc.now)
            if r.status != "in_progress" or not pair.in_room(me) or me.left_at is not None:
                raise pair.room_not_active("abandoned" if me.abandoned else r.status)
            if r.next_speaker not in (me.role, "both") or st(r).get("pending"):
                raise not_your_turn()
            if free and r.mode != "free":
                raise free_text_not_allowed()
            if body.get("choice_id") is not None and r.mode != "choices":
                raise answer_invalid("choice_id", "Сейчас ответ — текстом или голосом")
            pair.accrue(room, rc.now)
            text, mode, seconds, option = await _turn_content(db, room, me, body, rc.now)
            add_event(db, room, "turn", rc.now, side=me.side, role=me.role, text=text, mode=mode, turn=True,
                      key=key, rhash=rhash)
            me.turns += 1
            me.contributed = True
            me.speaking_seconds = min(me.speaking_seconds + seconds, pair.MAX_SPEAKING)
            me.last_seen_at = rc.now
            r.last_activity_at = rc.now
            eff.notify = True
            if r.engine == "script":
                assert scn is not None and option is not None
                eff.merge(await coach.script_after_turn(db, room, scn, me.role, option, rc.now, rc.settings))
            else:
                wrap = pair.remaining_seconds(r, rc.settings, rc.now) <= 120 and not st(r).get("wrap_up")
                trigger = "wrap_up" if wrap else "turn"
                put(r, pending={"trigger": trigger, "side": me.side, "at": rc.now.isoformat()})
                r.next_speaker = None
                r.prompt_at = None
                eff.coach = trigger
    await _after(rc, room_id, eff, inline=True)  # ответ коуча на свой ход
    return await _state(rc, room_id, before, None)


async def _turn_content(db: AsyncSession, room: Room, me: RoomParticipant, body: dict[str, Any],
                        now: datetime) -> tuple[str, str, int, dict[str, Any] | None]:
    """→ (текст реплики, вид, секунды речи, вариант сценария). Без голоса секунды речи — от подсказки до ответа
    (≤ 60 с на ход); голос — длительность записи."""
    r = room.r
    waited = int((now - r.prompt_at).total_seconds()) if r.prompt_at is not None else 0
    typed = min(max(waited, 0), 60)
    if body.get("choice_id") is not None:
        option = coach.chosen_option(room, str(body["choice_id"]))
        return option["text"], "choice", typed, option
    if body.get("audio_id") is not None:
        try:
            audio_id = uuid.UUID(str(body["audio_id"]))
        except ValueError:
            raise answer_invalid("audio_id", "Запись не найдена") from None
        rec = await db.get(RoomAudio, audio_id, populate_existing=True)
        if rec is None or rec.room_id != r.room_id or rec.side != me.side or rec.used_at is not None \
                or rec.expires_at < now:
            raise answer_invalid("audio_id", "Запись не найдена или устарела — запишите ещё раз")
        text = " ".join(rec.text.split())[:pair.TURN_TEXT_MAX]
        if not text:
            raise answer_invalid("audio_id", "Речь не распознана — повторите или ответьте текстом")
        rec.used_at = now
        return text, "voice", math.ceil(rec.duration_ms / 1000), None
    text = " ".join(str(body.get("text") or "").split())
    if not text:
        raise answer_invalid("text", "Пустая реплика")
    if len(text) > pair.TURN_TEXT_MAX:
        raise answer_invalid("text", f"Не больше {pair.TURN_TEXT_MAX} символов")
    return text, "text", typed, None


# ---------------------------------------------------------------- голос


def wav_duration_ms(data: bytes) -> int:
    """RIFF/WAVE: PCM, моно, 16 000 Гц, 16 бит; 0,5..15 с; ≤ 600 000 байт (как произношение спринта 5)."""
    import struct

    if len(data) > AUDIO_MAX_BYTES:
        raise clients.audio_invalid("too_large")
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise clients.audio_invalid("format")
    pos, fmt_ok, data_len = 12, False, None
    while pos + 8 <= len(data):
        chunk, size = data[pos:pos + 4], struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = pos + 8
        if chunk == b"fmt ":
            if size < 16 or body + 16 > len(data):
                raise clients.audio_invalid("format")
            audio_format, channels, rate, _, _, bits = struct.unpack("<HHIIHH", data[body:body + 16])
            fmt_ok = audio_format == 1 and channels == 1 and rate == 16_000 and bits == 16
            if not fmt_ok:
                raise clients.audio_invalid("format")
        elif chunk == b"data":
            data_len = min(size, len(data) - body)
            break
        pos = body + size + (size & 1)
    if not fmt_ok or data_len is None:
        raise clients.audio_invalid("format")
    ms = data_len * 1000 // (16_000 * 2)
    if ms < 500:
        raise clients.audio_invalid("too_short")
    if ms > 15_000:
        raise clients.audio_invalid("too_long")
    return int(ms)


async def audio(rc: RoomCtx, room_id: uuid.UUID, data: bytes, content_type: str | None,
                too_large: bool) -> dict[str, Any]:
    """POST …/audio (WAV) → PairAudio: проверки комнаты и хода → дети 403 → согласие на голос 403 → распознавание
    (ai-gateway speech:transcribe) → audio_id на 5 минут. Аудио не хранится (только распознанный текст до хода)."""
    async with rc.rt.transaction() as db:
        await _guard_user(db, rc.user)
        room = await pair.load(db, room_id)
        me = room.me(rc.user) if room is not None else None
        if room is None or me is None:
            raise pair.room_not_found()
        r = room.r
        if me.audience == "kids" or rc.learner.child_by_claims:
            raise kids_not_allowed()
        if r.status != "in_progress" or not pair.in_room(me) or me.left_at is not None:
            raise pair.room_not_active(r.status)
        if r.next_speaker not in (me.role, "both") or st(r).get("pending"):
            raise not_your_turn()
        if r.mode != "free":
            raise free_text_not_allowed()
        side, audience = me.side, me.audience
    if too_large:
        raise clients.audio_invalid("too_large")
    if (content_type or "").split(";")[0].strip().lower() not in WAV_TYPES:
        raise clients.audio_invalid("format")
    wav_duration_ms(data)
    public = await clients.public_profile(rc.rt, rc.user)
    if public is None:
        raise clients.speech_unavailable()
    if not has_voice_consent(public):
        raise voice_consent_required(who_must_consent(public, rc.learner))
    audio_id = uuid.uuid4()
    result = await clients.transcribe(rc.rt, data, {"request_id": str(audio_id), "user_id": str(rc.user),
                                                    "room_id": str(room_id), "audience": audience,
                                                    "language": "en-US"})
    expires = rc.now + timedelta(minutes=rc.settings.pair_audio_minutes)
    async with rc.rt.transaction() as db:
        await pair.lock_users(db, rc.user)
        await _guard_user(db, rc.user)
        db.add(RoomAudio(audio_id=audio_id, room_id=room_id, side=side, text=result["text"],
                         duration_ms=result["duration_ms"], created_at=rc.now, expires_at=expires))
    log.info("pair audio recognized", extra={"audio_ms": result["duration_ms"]})
    return {"audio_id": str(audio_id), "text": result["text"][:pair.TURN_TEXT_MAX],
            "duration_ms": result["duration_ms"], "expires_at": iso(expires)}


# ---------------------------------------------------------------- отчёт


async def report(rc: RoomCtx, room_id: uuid.UUID) -> dict[str, Any]:
    """PairRoomReport — только свой (после завершения): свои реплики, секунды, навыки, подсказки, итог команды."""
    await refresh(rc, room_id)
    async with rc.rt.transaction() as db:
        await _guard_user(db, rc.user)
        room = await pair.load(db, room_id)
        me = room.me(rc.user) if room is not None else None
        if room is None or me is None:
            raise pair.room_not_found()
        r = room.r
        if r.status not in ROOM_ENDED:
            raise pair.room_state(r.status)
        lines = (await db.execute(select(RoomEvent.text, RoomEvent.at).where(
            RoomEvent.room_id == room_id, RoomEvent.kind == "turn", RoomEvent.side == me.side,
            RoomEvent.text.is_not(None)).order_by(RoomEvent.seq))).all()
        rep = me.report or {}
        course = None
        info = await rc.catalog.pair(r.pair_id)
        if info is not None:
            course = info.course_id
    titles: dict[str, Any] = {}
    if rep.get("skills"):
        snapshot = await rc.catalog.snapshot(course or rc.settings.default_course_id)
        titles = {sk["skill_id"]: sk["title"] for sk in (snapshot or {}).get("skills") or []}
    return {
        "room_id": str(r.room_id), "scenario": {"scenario_id": r.scenario_id, "title": r.title},
        "status": r.status, "end_reason": r.end_reason, "ended_at": iso(r.ended_at),
        "team": {"goal_reached": bool(r.team_goal_reached), "progress": round(float(st(r).get("progress", 0.0)), 3),
                 "summary": rep.get("team_summary")},
        "me": {"role": me.role, "contributed": me.contributed, "turns": me.turns,
               "speaking_seconds": me.speaking_seconds, "minutes": me.minutes,
               "lines": [{"text": t, "at": iso(at)} for t, at in lines],
               "skills": [{"skill_id": sk, "title": titles.get(sk) or {"ru": sk, "uz": sk}}
                          for sk in rep.get("skills") or []],
               "tips": list(rep.get("tips") or []),
               "evaluation_id": str(me.evaluation_id) if me.evaluation_id else None},
    }

