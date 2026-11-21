"""Ядро парной комнаты (INTERNAL_API §3.2): загрузка и блокировки, учёт времени, лента событий, ленивое обслуживание
(истечение приглашений, offline по heartbeat, соло после 3 минут, неактивность, предел 20 минут, молчание),
завершение (события, отчёты), независимая оценка участников, tick, сага, реакции на события social.

Блокировки: каждая команда над комнатой берёт блокировки обоих участников (lock_user, в одном порядке) и после этого
проверяет отметку удаления ученика — сага держит блокировку удаляемого до фиксации, поэтому параллельная команда ждёт
и видит удаление, а не создаёт данные заново.

Время участника (`active_seconds`) идёт, пока комната `in_progress`, а участник вошёл, не вышел и на связи: копится
от `clock_at` при каждом изменении (accrue). Повторный вход ничего не удваивает — время считается по часам, а не по
числу входов; сессия участника одна: `session_id = uuid5(room_id, str(user_id))`. Минуты = ⌈секунды / 60⌉ —
учитываются, но не списываются (спринт 8).
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, conflict, not_found
from tilhero_common.messaging import emit
from tilhero_lessons import clients
from tilhero_lessons.domain.common import COMPLETED, PRODUCER, iso, loc, lock_user, lock_users
from tilhero_lessons.models import (
    ROOM_ACTIVE,
    ROOM_ENDED,
    DeletedUser,
    PairRoom,
    RoomAudio,
    RoomEvent,
    RoomParticipant,
)
from tilhero_lessons.settings import Settings

log = logging.getLogger("tilhero.lessons.pair")

PAIR_INVITED = "lesson.pair.invited.v1"
PAIR_STARTING = "lesson.pair.starting.v1"
PAIR_COMPLETED = "lesson.pair.completed.v1"
LIVE = frozenset({"in_progress", "paused"})
ROLES = ("A", "B")
MAX_EVENT_MINUTES = 240
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
MAX_SPEAKING = 7200
TURN_TEXT_MAX = 300

PARTNER_LEFT_EN = "Your partner has left. Let's go on together — it's your turn."
SILENCE_EN = "Take your time — it's your turn. Choose a line or say something."
TEAM_REACHED = loc("Отличная командная работа — вы вместе справились с задачей!",
                   "Ajoyib jamoaviy ish — vazifani birgalikda bajardingiz!")
TEAM_PARTIAL = loc("Хорошее начало! В следующий раз попробуйте вместе дойти до конца сцены.",
                   "Yaxshi boshlanish! Keyingi safar sahnani birga oxiriga yetkazishga harakat qiling.")
TEAM_KIDS = loc("Здорово получилось — вы отлично поработали вместе!", "Zoʻr chiqdi — birga ajoyib ishladingiz!")
TIPS = {
    "full": loc("Отвечай полными предложениями — так партнёру проще продолжить разговор.",
                "Toʻliq gaplar bilan javob ber — sherigingga suhbatni davom ettirish osonroq boʻladi."),
    "ask": loc("Задавай партнёру вопросы — так сцена идёт живее.",
               "Sherigingga savollar ber — sahna jonliroq boʻladi."),
    "voice": loc("Попробуй ответить голосом — это хорошая тренировка речи.",
                 "Ovoz bilan javob berib koʻr — bu nutq uchun yaxshi mashq."),
    "more": loc("Говори чаще: каждая реплика — это практика.", "Koʻproq gapir: har bir gap — bu mashq."),
}
_PII = re.compile(r"(https?://|www\.|t\.me/|@[A-Za-z0-9_]{4,}|\+?\d[\d\s()-]{7,}\d|[\w.+-]+@[\w-]+\.\w+)")


def room_not_found() -> ApiError:
    return not_found("ROOM_NOT_FOUND", "Комната не найдена")


def room_state(status: str, **extra: Any) -> ApiError:
    return conflict("ROOM_STATE", "Действие недоступно в текущем состоянии комнаты", {"status": status, **extra})


def room_not_active(status: str, **extra: Any) -> ApiError:
    return conflict("ROOM_NOT_ACTIVE", "Комната сейчас неактивна", {"status": status, **extra})


# ---------------------------------------------------------------- уведомления лент и фоновые задачи


class RoomHub:
    """Пробуждение long-poll в этом процессе (другие экземпляры увидят изменения при опросе БД раз в
    PAIR_POLL_INTERVAL_SECONDS) и фоновые задачи после фиксации (независимая оценка участников)."""

    def __init__(self) -> None:
        # комната → [событие, число ожидающих]: запись живёт, только пока кто-то ждёт (без роста и без O(n) чистки)
        self._events: dict[uuid.UUID, list[Any]] = {}
        self.jobs: set[asyncio.Task[Any]] = set()

    def notify(self, room_id: uuid.UUID) -> None:
        entry = self._events.pop(room_id, None)
        if entry is not None:
            entry[0].set()

    async def wait(self, room_id: uuid.UUID, seconds: float) -> None:
        entry = self._events.get(room_id)
        if entry is None:
            entry = [asyncio.Event(), 0]
            self._events[room_id] = entry
        entry[1] += 1
        try:
            await asyncio.wait_for(entry[0].wait(), timeout=max(seconds, 0.0))
        except TimeoutError:
            pass
        finally:
            entry[1] -= 1
            if entry[1] <= 0 and self._events.get(room_id) is entry:
                del self._events[room_id]

    @property
    def waiting_rooms(self) -> int:
        return len(self._events)

    def spawn(self, coro: Any) -> None:
        task = asyncio.create_task(coro)
        self.jobs.add(task)
        task.add_done_callback(self.jobs.discard)

    async def drain(self) -> None:
        while self.jobs:
            await asyncio.gather(*list(self.jobs), return_exceptions=True)


@dataclass
class Effects:
    """Что сделать после фиксации транзакции: разбудить ленту, оценить участников, позвать коуча."""

    notify: bool = False
    evaluate: list[str] = field(default_factory=list)  # стороны участников
    coach: str | None = None  # trigger повторного вызова коуча (ответ не пришёл)
    silence: bool = False

    def merge(self, other: Effects) -> Effects:
        self.notify = self.notify or other.notify
        self.evaluate += [s for s in other.evaluate if s not in self.evaluate]
        self.coach = self.coach or other.coach
        self.silence = self.silence or other.silence
        return self


# ---------------------------------------------------------------- комната и участники


@dataclass
class Room:
    r: PairRoom
    parts: dict[str, RoomParticipant]

    @property
    def users(self) -> list[uuid.UUID]:
        return [p.user_id for p in self.parts.values() if p.user_id is not None]

    def me(self, user_id: uuid.UUID) -> RoomParticipant | None:
        return next((p for p in self.parts.values() if p.user_id == user_id), None)

    def other(self, side: str) -> RoomParticipant:
        return self.parts["invitee" if side == "inviter" else "inviter"]

    def by_role(self, role: str | None) -> RoomParticipant | None:
        return next((p for p in self.parts.values() if role is not None and p.role == role), None)


async def load(db: AsyncSession, room_id: uuid.UUID, *, fresh: bool = False) -> Room | None:
    opts = {"populate_existing": True} if fresh else {}
    r = await db.get(PairRoom, room_id, **opts)  # type: ignore[arg-type]
    if r is None:
        return None
    parts = (await db.execute(select(RoomParticipant).where(RoomParticipant.room_id == room_id)
                              .execution_options(**opts))).scalars().all()
    return Room(r, {p.side: p for p in parts})




async def is_deleted(db: AsyncSession, user_id: uuid.UUID) -> bool:
    return await db.get(DeletedUser, user_id) is not None


def st(r: PairRoom) -> dict[str, Any]:
    return dict(r.state or {})


def put(r: PairRoom, **changes: Any) -> None:
    r.state = {**st(r), **changes}


def session_id_for(room_id: uuid.UUID, user_id: uuid.UUID) -> uuid.UUID:
    """Своя сессия участника (§10, п. 3): у двух событий одной комнаты — разные session_id."""
    return uuid.uuid5(room_id, str(user_id))


def present(p: RoomParticipant) -> bool:
    return p.joined_at is not None and p.left_at is None and p.network == "online" and not p.abandoned


def in_room(p: RoomParticipant) -> bool:
    """Вошёл и не выбыл (offline до 3 минут — ещё в комнате)."""
    return p.joined_at is not None and not p.abandoned


def add_event(db: AsyncSession, room: Room, kind: str, now: datetime, *, side: str | None = None,
              role: str | None = None, text: str | None = None, mode: str | None = None, turn: bool = False,
              key: str | None = None, rhash: str | None = None) -> RoomEvent:
    r = room.r
    r.seq += 1
    turn_id = None
    if turn:
        r.turn_seq += 1
        turn_id = f"T{r.turn_seq}"
    ev = RoomEvent(room_id=r.room_id, seq=r.seq, kind=kind, side=side, role=role,
                   text=text[:600] if text is not None else None, mode=mode, turn_id=turn_id, at=now,
                   idempotency_key=key, request_hash=rhash)
    db.add(ev)
    r.updated_at = now
    return ev


def accrue(room: Room, now: datetime) -> None:
    """Время комнаты в in_progress и время присутствующих участников — от clock_at до now (целые секунды)."""
    r = room.r
    if r.clock_at is None:
        r.clock_at = now
        return
    delta = int((now - r.clock_at).total_seconds())
    if delta <= 0:
        return
    if r.status == "in_progress":
        r.progress_seconds += delta
        for p in room.parts.values():
            if present(p):
                p.active_seconds += delta
    r.clock_at = r.clock_at + timedelta(seconds=delta)


def remaining_seconds(r: PairRoom, settings: Settings, now: datetime) -> int:
    live = int((now - r.clock_at).total_seconds()) if r.status == "in_progress" and r.clock_at else 0
    return max(0, settings.pair_room_max_minutes * 60 - r.progress_seconds - max(live, 0))


def minutes_of(p: RoomParticipant) -> int:
    return min(math.ceil(max(p.active_seconds, 0) / 60), MAX_EVENT_MINUTES)


def release_slots(room: Room) -> None:
    for p in room.parts.values():
        p.holds_slot = False


def join_deadline(r: PairRoom, settings: Settings) -> datetime:
    base = max(r.start_at, r.accepted_at or r.start_at)
    return base + timedelta(minutes=settings.pair_invite_minutes)


def safety_flags(text: str | None) -> list[str]:
    """Простые проверки последней реплики (safety_quality_gate у ai-gateway — основной фильтр)."""
    return ["personal_data"] if text and _PII.search(text) else []


def pause(db: AsyncSession, room: Room, reason: str, now: datetime) -> None:
    """in_progress → paused (offline в свой ход, выход, безопасность): время хода на паузе не идёт."""
    r = room.r
    r.status = "paused"
    put(r, pause_reason=reason, paused_at=now.isoformat())
    add_event(db, room, "paused", now)


def resume(db: AsyncSession, room: Room, now: datetime) -> None:
    """paused → in_progress: время ожидания хода продолжается с момента паузы."""
    r = room.r
    paused_at = _ts(st(r).get("paused_at"))
    if r.prompt_at is not None and paused_at > EPOCH:
        r.prompt_at = min(now, r.prompt_at + max(now - paused_at, timedelta(0)))
    r.status = "in_progress"
    put(r, pause_reason=None, paused_at=None)
    add_event(db, room, "resumed", now)


def set_turn(room: Room, role: str | None, now: datetime) -> None:
    """Следующий говорящий (соло — всегда оставшаяся роль) и время начала хода."""
    solo = st(room.r).get("solo")
    if solo and role is not None:
        role = solo
    room.r.next_speaker = role
    room.r.prompt_at = now if role is not None else None


# ---------------------------------------------------------------- обслуживание (лениво и tick)


def needs_tend(room: Room, now: datetime, settings: Settings) -> bool:
    r = room.r
    if r.status == "invited":
        return now > r.respond_until
    if r.status == "waiting":
        return r.started_at is None and now > join_deadline(r, settings)
    if r.status not in LIVE:
        return False
    offline_before = now - timedelta(seconds=settings.pair_offline_seconds)
    reconnect = timedelta(minutes=settings.pair_reconnect_minutes)
    for p in room.parts.values():
        if present(p) and (p.last_seen_at is None or p.last_seen_at < offline_before):
            return True
        if in_room(p) and p.absent_since is not None and now - p.absent_since > reconnect:
            return True
    idle = timedelta(minutes=settings.pair_inactivity_minutes)
    if r.last_activity_at is not None and now - r.last_activity_at > idle:
        return True
    if r.status == "in_progress" and remaining_seconds(r, settings, now) <= 0:
        return True
    s = st(r)
    pending = s.get("pending")
    if pending and _ts(pending.get("at")) < now - timedelta(seconds=settings.ai_timeout_seconds + 5):
        return True
    return bool(r.status == "in_progress" and r.next_speaker and not pending and r.prompt_at is not None
                and now - r.prompt_at > timedelta(seconds=settings.pair_silence_seconds)
                and s.get("silence_for") != r.turn_seq)


def next_due(room: Room, settings: Settings) -> datetime | None:
    """Срок следующего обслуживания комнаты (для планировщика): ближайший из сроков, при которых needs_tend станет
    истинным; None — комнату обслуживать не нужно (завершена)."""
    r = room.r
    if r.status == "invited":
        return r.respond_until
    if r.status == "waiting":
        return join_deadline(r, settings) if r.started_at is None else None
    if r.status not in LIVE:
        return None
    due: list[datetime] = []
    if r.last_activity_at is not None:
        due.append(r.last_activity_at + timedelta(minutes=settings.pair_inactivity_minutes))
    for p in room.parts.values():
        if present(p) and p.last_seen_at is not None:
            due.append(p.last_seen_at + timedelta(seconds=settings.pair_offline_seconds))
        if in_room(p) and p.absent_since is not None:
            due.append(p.absent_since + timedelta(minutes=settings.pair_reconnect_minutes))
    if r.status == "in_progress" and r.clock_at is not None:
        due.append(r.clock_at + timedelta(seconds=max(0, settings.pair_room_max_minutes * 60 - r.progress_seconds)))
    s = st(r)
    pending = s.get("pending")
    if pending:
        due.append(_ts(pending.get("at")) + timedelta(seconds=settings.ai_timeout_seconds + 5))
    elif r.status == "in_progress" and r.next_speaker and r.prompt_at is not None \
            and s.get("silence_for") != r.turn_seq:
        due.append(r.prompt_at + timedelta(seconds=settings.pair_silence_seconds))
    return min(due) if due else None


def schedule(room: Room, settings: Settings) -> None:
    room.r.due_at = next_due(room, settings)


def _ts(value: Any) -> datetime:
    try:
        dt = datetime.fromisoformat(str(value))
    except ValueError:
        return EPOCH
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


async def tend(db: AsyncSession, room: Room, now: datetime, settings: Settings) -> Effects:
    """Под блокировками участников: всё, что следует из времени (идемпотентно — повтор ничего не меняет)."""
    eff = Effects()
    r = room.r
    accrue(room, now)
    if r.status == "invited" and now > r.respond_until:
        r.status = "expired"
        r.ended_at = now
        release_slots(room)
        eff.notify = True
        return eff
    if r.status == "waiting" and r.started_at is None and now > join_deadline(r, settings):
        r.status = "expired"
        r.ended_at = now
        release_slots(room)
        eff.notify = True
        return eff
    if r.status not in LIVE:
        return eff
    offline_before = now - timedelta(seconds=settings.pair_offline_seconds)
    for p in room.parts.values():
        if present(p) and (p.last_seen_at is None or p.last_seen_at < offline_before):
            seen = p.last_seen_at or now
            # время без heartbeat (≤ 30 с до обнаружения) в учёт не идёт
            p.active_seconds = max(0, p.active_seconds - max(0, int((now - seen).total_seconds())))
            p.network = "offline"
            p.absent_since = seen
            add_event(db, room, "offline", now, side=p.side, role=p.role)
            eff.notify = True
            if r.status == "in_progress" and r.next_speaker == p.role and not st(r).get("solo"):
                pause(db, room, "offline", now)
    reconnect = timedelta(minutes=settings.pair_reconnect_minutes)
    newly = []
    for p in room.parts.values():
        if in_room(p) and p.absent_since is not None and now - p.absent_since > reconnect:
            p.abandoned = True
            if p.left_at is None:
                add_event(db, room, "left", now, side=p.side, role=p.role)
            newly.append(p)
            eff.notify = True
    staying = [p for p in room.parts.values() if in_room(p)]
    if newly and not staying:
        return eff.merge(await finish(db, room, "abandoned", "participant_left", now, settings))
    if newly and staying:
        solo = staying[0]
        put(r, solo=solo.role)
        if r.status == "paused" and st(r).get("pause_reason") == "offline":
            resume(db, room, now)
        add_event(db, room, "coach", now, text=PARTNER_LEFT_EN, turn=True)
        if not st(r).get("pending"):
            set_turn(room, solo.role, now)
    idle = timedelta(minutes=settings.pair_inactivity_minutes)
    if r.last_activity_at is not None and now - r.last_activity_at > idle:
        return eff.merge(await finish(db, room, "abandoned", "inactivity", now, settings))
    if r.status == "in_progress" and remaining_seconds(r, settings, now) <= 0:
        alone = bool(st(r).get("solo"))
        return eff.merge(await finish(db, room, "abandoned" if alone else "finished",
                                      "participant_left" if alone else "completed", now, settings))
    s = st(r)
    pending = s.get("pending")
    if pending and _ts(pending.get("at")) < now - timedelta(seconds=settings.ai_timeout_seconds + 5):
        put(r, pending={**pending, "at": now.isoformat()})  # повтор не чаще таймаута ИИ
        eff.coach = str(pending.get("trigger") or "turn")
    elif r.status == "in_progress" and r.next_speaker and not pending and r.prompt_at is not None \
            and now - r.prompt_at > timedelta(seconds=settings.pair_silence_seconds) \
            and s.get("silence_for") != r.turn_seq:
        put(r, silence_for=r.turn_seq)
        if r.engine == "ai":
            eff.silence = True
        else:
            add_event(db, room, "coach", now, text=SILENCE_EN, turn=True)
            eff.notify = True
    return eff


async def refresh(rt: Runtime, room_id: uuid.UUID, now: datetime, settings: Settings, *,
                  reschedule: bool = False) -> Effects:
    """Обслуживание комнаты своей транзакцией (фиксируется до команды); блокировки — только если что-то изменится
    (или планировщик пересчитывает срок следующего обслуживания — reschedule)."""
    async with rt.transaction() as db:
        room = await load(db, room_id)
        if room is None or not (reschedule or needs_tend(room, now, settings)):
            return Effects()
    async with rt.transaction() as db:
        room = await load(db, room_id)
        if room is None:
            return Effects()
        await lock_users(db, *room.users)
        room = await load(db, room_id, fresh=True)
        if room is None:
            return Effects()
        eff = await tend(db, room, now, settings) if needs_tend(room, now, settings) else Effects()
        schedule(room, settings)
        return eff


# ---------------------------------------------------------------- завершение, отчёты, события


def outcome_of(r: PairRoom) -> str | None:
    s = st(r)
    if r.engine == "script" and s.get("outcome") in ("success", "alt_success", "fail"):
        return str(s["outcome"])
    return "success" if r.team_goal_reached else None


def build_report(room: Room, p: RoomParticipant) -> dict[str, Any]:
    """Приватный отчёт участника: похвала команде (общая, без ошибок), 1–3 подсказки своей роли, навыки по своим
    доказательствам. Чужие ошибки сюда не попадают; реплики — только свои (из ленты при чтении)."""
    r = room.r
    s = st(r)
    ai_report = s.get("report") if isinstance(s.get("report"), dict) else None
    summary = None
    if ai_report and isinstance(ai_report.get("team_summary"), dict):
        summary = {"ru": str(ai_report["team_summary"].get("ru", ""))[:200],
                   "uz": str(ai_report["team_summary"].get("uz", ""))[:200]}
    if summary is None:
        summary = TEAM_KIDS if r.audience == "kids" else (TEAM_REACHED if r.team_goal_reached else TEAM_PARTIAL)
    tips: list[dict[str, str]] = []
    skills: list[str] = []
    if p.turns > 0:
        if ai_report:
            tips = [{"ru": str(t["text"].get("ru", ""))[:160], "uz": str(t["text"].get("uz", ""))[:160]}
                    for t in ai_report.get("tips") or []
                    if isinstance(t, dict) and t.get("role") == p.role and isinstance(t.get("text"), dict)][:3]
        if not tips:
            keys = ["full", "ask"] if r.mode == "free" else ["more"]
            if r.mode == "free" and p.voice:
                keys.append("voice")
            tips = [TIPS[k] for k in keys][:3]
        skills = list(dict.fromkeys(str(e["skill_id"]) for e in p.evidence or []
                                    if isinstance(e, dict) and e.get("skill_id")))
        if not skills:
            skills = [str(x) for x in s.get("scenario_skills") or []][:5]
    return {"team_summary": summary, "tips": tips, "skills": skills[:8]}


async def finish(db: AsyncSession, room: Room, status: str, end_reason: str, now: datetime,
                 settings: Settings, *, goal_reached: bool | None = None) -> Effects:
    """Итог комнаты (один раз): отчёты, минуты, вклад; события lesson.pair.completed.v1 и
    lesson.session.completed.v1 по каждому вошедшему участнику; оценка — после фиксации (Effects.evaluate)."""
    eff = Effects(notify=True)
    r = room.r
    if r.status not in ROOM_ACTIVE:
        return Effects()
    accrue(room, now)
    if goal_reached is not None:
        r.team_goal_reached = goal_reached
    r.status = status
    r.ended_at = now
    r.end_reason = end_reason
    r.next_speaker = None
    r.prompt_at = None
    r.due_at = None
    put(r, pending=None, options=None)
    add_event(db, room, "stopped" if status == "stopped" else "finished", now)
    release_slots(room)
    joined = [p for p in room.parts.values() if p.joined_at is not None]
    for p in joined:
        p.minutes = minutes_of(p)
        p.contributed = p.turns > 0
        p.report = build_report(room, p)
        if p.contributed and p.user_id is not None and r.content_versions.get("rubric"):
            p.evaluation_status = "pending"
            eff.evaluate.append(p.side)
    known = [p for p in joined if p.user_id is not None]
    if known:
        await emit(db, PAIR_COMPLETED, {
            "room_id": str(r.room_id), "scenario_id": r.scenario_id, "pair_id": r.pair_id, "status": status,
            "end_reason": end_reason, "team_goal_reached": bool(r.team_goal_reached),
            "participants": [{"user_id": str(p.user_id), "role": p.role, "contributed": p.contributed,
                              "turns": min(p.turns, 500), "speaking_seconds": min(p.speaking_seconds, MAX_SPEAKING),
                              "minutes": p.minutes} for p in known],
            "ended_at": iso(now)}, producer=PRODUCER)
    for p in known:
        assert p.user_id is not None
        await emit(db, COMPLETED, {
            "session_id": str(p.session_id), "user_id": str(p.user_id), "kind": "pair", "pair_id": r.pair_id,
            "lesson_id": None, "scenario_id": r.scenario_id, "asset_id": None, "status": "completed",
            "outcome": None, "minutes": p.minutes, "local_date": None, "evaluation_id": None, "passed": None,
            "practice_only": False, "finished_at": iso(now), "room_id": str(r.room_id)}, producer=PRODUCER)
    return eff


async def emit_invited(db: AsyncSession, room: Room, nickname: str | None) -> None:
    r = room.r
    nick = nickname if isinstance(nickname, str) and 3 <= len(nickname) <= 20 else None
    await emit(db, PAIR_INVITED, {
        "room_id": str(r.room_id), "inviter_user_id": str(r.inviter), "invitee_user_id": str(r.invitee),
        "inviter_nickname": nick, "pair_id": r.pair_id, "scenario_id": r.scenario_id, "mode": r.mode,
        "start_at": iso(r.start_at), "invited_at": iso(r.created_at)}, producer=PRODUCER)


# ---------------------------------------------------------------- независимая оценка участника (assessment)


async def evaluation_body(db: AsyncSession, room: Room, p: RoomParticipant) -> dict[str, Any] | None:
    """EvaluationRequest участника (§3.2): kind scenario, его сессия, сценарий и рубрика; реплики — только его
    (learner) и коуча (character): реплики партнёра не передаются никогда."""
    r = room.r
    if p.user_id is None:
        return None
    events = (await db.execute(select(RoomEvent).where(
        RoomEvent.room_id == r.room_id, RoomEvent.text.is_not(None), RoomEvent.turn_id.is_not(None),
        or_(RoomEvent.kind == "coach", and_(RoomEvent.kind == "turn", RoomEvent.side == p.side)))
        .order_by(RoomEvent.seq))).scalars().all()
    assisted = {str(e.get("turn_id")) for e in p.evidence or [] if isinstance(e, dict) and e.get("assist_used")}
    turns = []
    for ev in events:
        learner = ev.kind == "turn"
        turns.append({"turn_id": ev.turn_id, "speaker": "learner" if learner else "character",
                      "text": (ev.text or "")[:500],
                      "mode": ("choice" if ev.mode == "choice" else "text") if learner else None,
                      "hinted": learner and ev.turn_id in assisted, "node_id": None})
    if not any(t["speaker"] == "learner" for t in turns):
        return None
    cv = r.content_versions
    return {"session_id": str(p.session_id), "user_id": str(p.user_id), "kind": "scenario", "pair_id": r.pair_id,
            "audience": p.audience, "locale": p.locale,
            "content_refs": {"scenario": cv.get("scenario"), "rubric": cv.get("rubric")},
            "answers": [], "turns": turns[-120:], "roleplay": {"outcome": outcome_of(r), "hints": 0},
            "open_answer": None, "practice_only": False}


async def evaluate(rt: Runtime, room_id: uuid.UUID, side: str, now: datetime) -> bool | None:
    """Отправка в assessment (вне транзакции) → True — оценка получена; False — нет (повтор — tick); None — нечего."""
    async with rt.transaction() as db:
        room = await load(db, room_id)
        p = room.parts.get(side) if room is not None else None
        if room is None or p is None or p.evaluation_status != "pending" or p.user_id is None:
            return None
        body = await evaluation_body(db, room, p)
        user_id = p.user_id
        if body is None:
            p.evaluation_status = "none"
            return None
    result = await clients.request_evaluation(rt, user_id, body)
    async with rt.transaction() as db:
        await lock_user(db, user_id)
        if await is_deleted(db, user_id):  # после блокировки: сага уже обезличила участника
            return None
        p = await db.get(RoomParticipant, (room_id, side), populate_existing=True)
        if p is None or p.user_id != user_id or p.evaluation_status != "pending":
            return None
        p.evaluation_attempts = min(p.evaluation_attempts + 1, 30000)
        if result is None:
            return False
        p.evaluation_id = uuid.UUID(str(result.view["evaluation_id"]))
        p.evaluation_status = "done"
    return True


# ---------------------------------------------------------------- tick


async def tick(rt: Runtime, hub: RoomHub, settings: Settings, now: datetime) -> dict[str, int]:
    """`lessons:tick`: истечение приглашений, offline/соло/неактивность/предел времени, «скоро начнётся»
    (за PAIR_STARTING_MINUTES до start_at принятой комнаты), просроченные записи голоса, повторная оценка."""
    counts = {"pair_rooms_tended": 0, "pair_rooms_ended": 0, "pair_starting_sent": 0, "pair_audio_purged": 0,
              "pair_evaluations_sent": 0, "pair_evaluations_failed": 0, "pair_evaluations_given_up": 0}
    async with rt.transaction() as db:
        # только комнаты, которым пора что-то сделать (срок следующего обслуживания; NULL — ещё не рассчитан)
        ids = list((await db.execute(select(PairRoom.room_id).where(
            PairRoom.status.in_(ROOM_ACTIVE), or_(PairRoom.due_at.is_(None), PairRoom.due_at <= now))
            .order_by(PairRoom.due_at.asc().nulls_first()).limit(settings.tick_batch_size))).scalars().all())
    for room_id in ids:
        eff = await refresh(rt, room_id, now, settings, reschedule=True)
        if eff.notify:
            counts["pair_rooms_tended"] += 1
            hub.notify(room_id)
        if eff.evaluate:
            counts["pair_rooms_ended"] += 1
        for side in eff.evaluate:
            await evaluate(rt, room_id, side, now)
    soon = now + timedelta(minutes=settings.pair_starting_minutes)
    async with rt.transaction() as db:
        rows = (await db.execute(select(PairRoom).where(
            PairRoom.status == "waiting", PairRoom.started_at.is_(None), PairRoom.starting_sent_at.is_(None),
            PairRoom.start_at > now, PairRoom.start_at <= soon).with_for_update(skip_locked=True)
            .limit(settings.tick_batch_size))).scalars().all()
        for r in rows:
            r.starting_sent_at = now
            if r.inviter is None or r.invitee is None:
                continue
            await emit(db, PAIR_STARTING, {"room_id": str(r.room_id), "user_ids": [str(r.inviter), str(r.invitee)],
                                           "scenario_id": r.scenario_id, "start_at": iso(r.start_at)},
                       producer=PRODUCER)
            counts["pair_starting_sent"] += 1
        purged = await db.execute(delete(RoomAudio).where(RoomAudio.expires_at < now))
        counts["pair_audio_purged"] = int(getattr(purged, "rowcount", 0) or 0)
    counts.update(await resend_evaluations(rt, settings, now))
    return counts


async def resend_evaluations(rt: Runtime, settings: Settings, now: datetime) -> dict[str, int]:
    oldest = now - timedelta(days=settings.evaluation_retry_days)
    async with rt.transaction() as db:
        given_up = await db.execute(update(RoomParticipant).where(
            RoomParticipant.evaluation_status == "pending",
            RoomParticipant.room_id.in_(select(PairRoom.room_id).where(PairRoom.ended_at < oldest)))
            .values(evaluation_status="failed"))
        rows = (await db.execute(select(RoomParticipant.room_id, RoomParticipant.side).join(
            PairRoom, PairRoom.room_id == RoomParticipant.room_id).where(
            RoomParticipant.evaluation_status == "pending", PairRoom.ended_at >= oldest)
            .order_by(PairRoom.ended_at).limit(settings.tick_batch_size))).all()
    sent = failed = 0
    started = time.monotonic()
    for room_id, side in rows:
        if time.monotonic() - started > settings.tick_resend_budget_seconds:
            break
        ok = await evaluate(rt, room_id, side, now)
        if ok is True:
            sent += 1
        elif ok is False:
            failed += 1
    return {"pair_evaluations_sent": sent, "pair_evaluations_failed": failed,
            "pair_evaluations_given_up": int(getattr(given_up, "rowcount", 0) or 0)}


async def redact(db: AsyncSession, cutoff: datetime, now: datetime, limit: int) -> int:
    """Срок хранения текстов (TEXT_RETENTION_DAYS): реплики учеников и коуча в ленте и распознанный голос."""
    keys = select(RoomEvent.room_id, RoomEvent.seq).where(RoomEvent.text.is_not(None), RoomEvent.at < cutoff) \
        .limit(limit).subquery()
    result = await db.execute(update(RoomEvent).where(RoomEvent.room_id == keys.c.room_id,
                                                      RoomEvent.seq == keys.c.seq)
                              .values(text=None, redacted_at=now))
    return int(getattr(result, "rowcount", 0) or 0)


# ---------------------------------------------------------------- события social (блокировки, санкции)


async def cancel_rooms(db: AsyncSession, rooms: list[uuid.UUID], now: datetime, statuses: tuple[str, ...],
                       locked: set[uuid.UUID]) -> int:
    """Отмена неначатых комнат: приглашения и ожидание старта. Блокировки всех участников уже взяты вызывающим одним
    упорядоченным набором (locked); комната с участником вне набора (появилась между запросом и блокировкой)
    пропускается — её отсечёт проверка при принятии (проекция и relations social)."""
    n = 0
    for room_id in rooms:
        room = await load(db, room_id, fresh=True)
        if room is None or not set(room.users) <= locked:
            continue
        if room is None or room.r.status not in statuses or room.r.started_at is not None:
            continue
        room.r.status = "cancelled"
        room.r.ended_at = now
        room.r.updated_at = now
        room.r.due_at = None
        release_slots(room)
        n += 1
    return n


async def cancel_between(db: AsyncSession, a: uuid.UUID, b: uuid.UUID, now: datetime) -> int:
    """Блокировка A→B отменяет приглашения в парный урок между ними в обе стороны (invited, waiting). Блокировки A и B
    уже взяты (members.alive)."""
    ids = list((await db.execute(select(PairRoom.room_id).where(
        PairRoom.status.in_(("invited", "waiting")),
        or_(and_(PairRoom.inviter == a, PairRoom.invitee == b), and_(PairRoom.inviter == b, PairRoom.invitee == a)))
    )).scalars().all())
    return await cancel_rooms(db, ids, now, ("invited", "waiting"), {a, b})


async def invite_partners(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Партнёры по неотвеченным приглашениям ученика — их блокировки берутся вместе с его (один порядок)."""
    rows = (await db.execute(select(PairRoom.inviter, PairRoom.invitee).where(
        PairRoom.status == "invited", or_(PairRoom.inviter == user_id, PairRoom.invitee == user_id)))).all()
    return [u for row in rows for u in row if u is not None and u != user_id]


async def cancel_invites_of(db: AsyncSession, user_id: uuid.UUID, now: datetime,
                            locked: set[uuid.UUID]) -> int:
    """Санкция social_ban: неотвеченные приглашения ученика (в обе стороны) отменяются; принятые и идущие —
    доигрываются."""
    ids = list((await db.execute(select(PairRoom.room_id).where(
        PairRoom.status == "invited", or_(PairRoom.inviter == user_id, PairRoom.invitee == user_id)))).scalars().all())
    return await cancel_rooms(db, ids, now, ("invited",), locked)


# ---------------------------------------------------------------- сага удаления


async def forget_user(db: AsyncSession, user_id: uuid.UUID, now: datetime, settings: Settings) -> None:
    """Комнаты ученика (под его блокировкой, её держит сага): неначатые — удаляются; начатые — обезличиваются:
    его сторона без user_id, отчёта и доказательств, его реплики стёрты, запись голоса удалена. Отчёт и реплики
    партнёра не трогаются. Идущая комната: участник считается вышедшим — партнёр доигрывает соло (tick/лента).
    Комната без участников удаляется."""
    rows = (await db.execute(select(RoomParticipant).where(RoomParticipant.user_id == user_id)
                             .execution_options(populate_existing=True))).scalars().all()
    for p in rows:
        room = await load(db, p.room_id, fresh=True)
        if room is None:
            continue
        r = room.r
        if r.started_at is None:
            await _drop(db, room)
            continue
        accrue(room, now)
        await _forget_coach_lines(db, room, p, now)
        if r.status in LIVE and in_room(p):
            p.left_at = p.left_at or now
            p.network = "offline"
            p.absent_since = now - timedelta(minutes=settings.pair_reconnect_minutes, seconds=1)
        p.user_id = None
        p.report = None
        p.evidence = []
        p.holds_slot = False
        if p.evaluation_status == "pending":
            p.evaluation_status = "none"
        if r.inviter == user_id:
            r.inviter = None
        if r.invitee == user_id:
            r.invitee = None
        r.updated_at = now
        await db.execute(update(RoomEvent).where(RoomEvent.room_id == r.room_id, RoomEvent.side == p.side,
                                                 RoomEvent.text.is_not(None)).values(text=None, redacted_at=now))
        await db.execute(delete(RoomAudio).where(RoomAudio.room_id == r.room_id, RoomAudio.side == p.side))
        if all(x.user_id is None for x in room.parts.values()):
            await _drop(db, room)
        else:
            schedule(room, settings)


def _norm(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s']", " ", text.casefold()).split())


async def _forget_coach_lines(db: AsyncSession, room: Room, p: RoomParticipant, now: datetime) -> None:
    """Сага: реплики коуча, которые отвечают удалённому (следующая реплика коуча после его хода) или цитируют его
    (содержат его реплику), стираются; из состояния комнаты убираются подсказка и варианты, адресованные его роли
    (или процитировавшие его), его роль-описание и подсказки отчёта коуча для его роли. Реплики и отчёт партнёра
    не трогаются."""
    r = room.r
    events = (await db.execute(select(RoomEvent).where(RoomEvent.room_id == r.room_id,
                                                       RoomEvent.kind.in_(("turn", "coach")))
                               .order_by(RoomEvent.seq))).scalars().all()
    quotes = [_norm(e.text) for e in events if e.kind == "turn" and e.side == p.side and e.text]
    quotes = [q for q in quotes if len(q) >= 8]
    erase: list[int] = []
    after_his_turn = False
    for e in events:
        if e.kind == "turn":
            after_his_turn = e.side == p.side
            continue
        if e.text and (after_his_turn or any(q in _norm(e.text) for q in quotes)):
            erase.append(e.seq)
        after_his_turn = False
    erased_texts = {e.text for e in events if e.seq in erase}
    if erase:
        await db.execute(update(RoomEvent).where(RoomEvent.room_id == r.room_id, RoomEvent.seq.in_(erase),
                                                 RoomEvent.text.is_not(None)).values(text=None, redacted_at=now))
    s = st(r)
    role = p.role
    changes: dict[str, Any] = {}
    if r.engine == "ai" and (s.get("prompt") in erased_texts or (role and r.next_speaker in (role, "both"))):
        changes.update(prompt=None, prompt_gloss=None, options=None)
    if role and isinstance(s.get("roles"), dict) and role in s["roles"]:
        changes["roles"] = {k: v for k, v in s["roles"].items() if k != role}
    report = s.get("report")
    if role and isinstance(report, dict):
        changes["report"] = {**report, "tips": [t for t in report.get("tips") or []
                                                if isinstance(t, dict) and t.get("role") != role]}
    if changes:
        put(r, **changes)


async def _drop(db: AsyncSession, room: Room) -> None:
    """Удаление комнаты целиком (участники, лента и голос — каскадом в БД)."""
    await db.flush()
    await db.execute(delete(PairRoom).where(PairRoom.room_id == room.r.room_id))
    for obj in (room.r, *room.parts.values()):
        db.expunge(obj)


async def ended_count(db: AsyncSession, since: datetime) -> dict[str, Any]:
    rows = (await db.execute(select(PairRoom.status, func.count()).where(
        PairRoom.status.in_(ROOM_ENDED), PairRoom.ended_at >= since).group_by(PairRoom.status))).all()
    by = {s: 0 for s in ROOM_ENDED}
    for s, n in rows:
        by[str(s)] = int(n)
    return {"pair_rooms_finished": sum(by.values()), "by_status": by}
