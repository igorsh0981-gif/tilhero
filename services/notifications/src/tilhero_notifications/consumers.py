"""Потребители событий notifications (INTERNAL_API §4; inbox-дедупликация + outbox в одной транзакции).

Приём только создаёт запись журнала (telegram_status=scheduled) с ключом дедупликации; отрисовка на языке
ученика, политика и доставка — в момент отправки (dispatcher.py), чтобы настройки, тихие часы и блокировка бота
учитывались свежими.

Событие → шаблон → кому (ключ дедупликации):
- learning.reminder.due.v1 → lesson.reminder(.kid) → ученику, ребёнку — опекуну (reminder:<user>:<date>);
  позже слота + 3 ч — только центр;
- learning.session.missed.v1 → lesson.missed(.kid); consecutive_missed ≥ 4 — lesson.comeback(.kid) не чаще раза
  в 7 дней (missed:<user>:<date>); не раньше слота следующего дня, после 22:00 следующего дня — только центр;
- social.invite.accepted.v1 → invite.accepted → пригласившему (invite.accepted:<invite>:<invitee>; семья —
  family.joined:<inviter>:<invitee>, общий ключ с family.joined владельцу — без двойного сообщения);
- social.invite.declined.v1 → invite.declined → пригласившему, только центр (invite.declined:<invite>:<invitee>);
- social.invite.reminder_due.v1 → invite.pending → получателю (invite.pending:<invite>:<invitee>);
- social.family.member_added.v1 → family.joined → владельцу (family.joined:<owner>:<member>); role owner —
  проекция владельца семьи; role child — без сообщения (ребёнка добавляет сам родитель);
- support.ticket.replied.v1 / status.changed→RESOLVED → support.reply / support.resolved (как aievent);
- experience.release_note.published.v1 → broadcasts (запись центра — при чтении центра, broadcasts.py);
- catalog.media_request.decided.v1 (спринт 3, только от catalog) → media_request.decided → ученику, категория
  support (media_request.decided:<request>:<status>; повтор того же решения — без дубля, изменённое решение — новое
  сообщение); заявки бывают только у аккаунтов 14+, но общая политика (в т.ч. правила детей) не обходится;
- assessment.appeal.decided.v1 (спринт 4, только от assessment) → appeal_decided(.kid) → ученику, ребёнку —
  опекуну, категория support (appeal_decided:<appeal>; одно сообщение на апелляцию, повтор — без дубля); текст
  решения сотрудника не включается; кнопка → «Уроки» (route_lessons);
- memory.reviews.due.v1 (спринт 5, только от memory) → reviews_due(.kid) → ученику, ребёнку — опекуну, категория
  reminders (reviews_due:<user>:<date>; одно в местный день); позже 19:00 + 3 ч — только центр; кнопка →
  «Повторение» (route_review);
- game.streak.frozen.v1 / game.badge.earned.v1 / game.hero.stage_reached.v1 (спринт 6, только от gamification) →
  streak_frozen / badge_earned / hero_stage_reached (*.kid), категория game (выключатель — GAME_CATEGORY_GATE,
  пока reminders; лимит дня — общий); ученику, детям 6–13 — только центр детского профиля (опекуну «в сводке»,
  без Telegram). badge_earned и hero_stage_reached с notify=false (game_notifications выключены) — без записи;
  streak_frozen — всегда (информация о серии). Ключи: streak_frozen:<user>:<date> (одно на день),
  badge_earned:<user>:<badge> (значок выдаётся один раз), hero_stage_reached:<user>:<stage> (ступень не
  понижается). Заморозка — после 22:00 следующего дня только центр; значок и ступень — позже события +
  GAME_STALE_HOURS только центр;
- спринт 7 (INTERNAL_API §5; издатель проверяется: social.* — только social, game.duel.*/game.league.closed — только
  gamification, lesson.pair.* — только lessons; чужой — WARNING без user_id и без записи). Детям 6–13 — только центр
  детского профиля (kid_in_app_only), тексты *.kid — родителю; ник — из события (неподходящий → «Друг»):
  - social.friend_request.created.v1 → friend_request → to_user_id (friend_request:<request>), social;
  - social.friendship.changed.v1 (added + source request) → friend_accepted → requester_user_id
    (friend_accepted:<requester>:<accepter>:<at>), social;
  - game.duel.challenged.v1 → duel_challenged → сопернику (duel_challenged:<duel>), game; после срока принятия —
    только центр;
  - game.duel.finished.v1 (status finished) → duel_finished → обоим: свой исход и свой счёт
    (duel_finished:<duel>:<user>:<result_version> — переоценка даёт новое сообщение), game;
  - game.league.closed.v1 (каждая версия) → league_closed → каждому из standings
    (league_closed:<group>:<user>:<place>:<prize_til> — без изменений места и приза повтор не уходит), game;
  - lesson.pair.invited.v1 → pair_invited → приглашённому (pair_invited:<room>), social; после start_at + 15 мин —
    только центр; lesson.pair.starting.v1 → pair_starting → обоим (pair_starting:<room>:<user>), после начала —
    только центр; lesson.pair.completed.v1 (end_reason stopped) → pair_stopped → участникам
    (pair_stopped:<room>:<user>), social;
  - game.referral.rewarded.v1 (только от gamification; outcome нет или rewarded, inviter_reward не null) →
    referral_qualified → пригласившему, награда — из inviter_reward (referral_qualified:<referral>), social. legacy и
    inviter_capped — без сообщения (пригласившему ничего не начислено; при лимите месяца social публикует
    social.referral.rejected.v1 monthly_cap). social.referral.qualified.v1 не слушается: квалификация — ещё не награда
    (лимит месяца и награда по правилу спринта 6 решаются в gamification);
  - social.referral.rejected.v1 → referral_rejected → пригласившему (referral_rejected:<referral>), social; причина —
    публичный код (в т. ч. monthly_cap);
  - social.sanction.changed.v1 (change applied) → sanction_applied (sanction_applied:<sanction>) и
    social.appeal.decided.v1 → sanction_appeal_decided (sanction_appeal_decided:<appeal>) — категория service
    (не выключается настройкой категорий); social.case.resolved.v1 → complaint_resolved жалобщику
    (complaint_resolved:<case>), social, без подробностей;
- user.deletion.requested.v1 (только от identity-consent) → удаление → user.domain.deleted.v1 {domain: notifications};
- user.status.changed / consent.revoked / user.notification_settings.changed / user.profile.updated — сброс кэша
  адресации.

Код сброса PIN через шину не принимается: только синхронный HTTP (api/internal.py).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope, emit
from tilhero_notifications import store
from tilhero_notifications.broadcasts import notification_id_for
from tilhero_notifications.delivery import forget
from tilhero_notifications.dispatcher import Dispatcher
from tilhero_notifications.domain.policy import at_local, zone
from tilhero_notifications.settings import Settings
from tilhero_notifications.templates import TEMPLATES, TemplateError, valid_nickname

log = logging.getLogger("tilhero.notifications.consumers")

REMINDER_DUE = "learning.reminder.due.v1"
SESSION_MISSED = "learning.session.missed.v1"
INVITE_ACCEPTED = "social.invite.accepted.v1"
INVITE_DECLINED = "social.invite.declined.v1"
INVITE_REMINDER = "social.invite.reminder_due.v1"
MEMBER_ADDED = "social.family.member_added.v1"
TICKET_REPLIED = "support.ticket.replied.v1"
TICKET_STATUS_CHANGED = "support.ticket.status.changed.v1"
RELEASE_NOTE = "experience.release_note.published.v1"
DELETION_REQUESTED = "user.deletion.requested.v1"
MEDIA_REQUEST_DECIDED = "catalog.media_request.decided.v1"
# Решения по заявкам публикует только catalog (защита в глубину: чужой издатель — лог и подтверждение без записи)
CATALOG_PRODUCERS = frozenset({"catalog"})
APPEAL_DECIDED = "assessment.appeal.decided.v1"
# Решения по апелляциям публикует только assessment (спринт 4)
ASSESSMENT_PRODUCERS = frozenset({"assessment"})
REVIEWS_DUE = "memory.reviews.due.v1"
# Вечернее напоминание о повторении публикует только memory (спринт 5)
MEMORY_PRODUCERS = frozenset({"memory"})
REVIEWS_DUE_TIME = "19:00"  # местное время напоминания memory (окно 19:00–19:14) — «слот» для устаревания
# Сагу удаления ведёт только identity-consent: запрос от другого издателя не исполняется (защита в глубину, P-7)
DELETION_PRODUCERS = frozenset({"identity-consent"})
STREAK_FROZEN = "game.streak.frozen.v1"
BADGE_EARNED = "game.badge.earned.v1"
HERO_STAGE_REACHED = "game.hero.stage_reached.v1"
# События игры публикует только gamification (спринт 6)
GAME_PRODUCERS = frozenset({"gamification"})
# Спринт 7: социальное — только social; дуэли и лиги — только gamification; парные комнаты — только lessons
FRIEND_REQUEST = "social.friend_request.created.v1"
FRIENDSHIP_CHANGED = "social.friendship.changed.v1"
SANCTION_CHANGED = "social.sanction.changed.v1"
CASE_RESOLVED = "social.case.resolved.v1"
SANCTION_APPEAL_DECIDED = "social.appeal.decided.v1"
REFERRAL_REJECTED = "social.referral.rejected.v1"
COMMUNITY_EVENTS = [FRIEND_REQUEST, FRIENDSHIP_CHANGED, SANCTION_CHANGED, CASE_RESOLVED, SANCTION_APPEAL_DECIDED,
                    REFERRAL_REJECTED]
# награда за приглашение решена в gamification (лимит месяца, правило спринта 6) — только от gamification
REFERRAL_REWARDED = "game.referral.rewarded.v1"
SOCIAL_PRODUCERS = frozenset({"social"})
DUEL_CHALLENGED = "game.duel.challenged.v1"
DUEL_FINISHED = "game.duel.finished.v1"
LEAGUE_CLOSED = "game.league.closed.v1"
PAIR_INVITED = "lesson.pair.invited.v1"
PAIR_STARTING = "lesson.pair.starting.v1"
PAIR_COMPLETED = "lesson.pair.completed.v1"
LESSONS_PRODUCERS = frozenset({"lessons"})
PAIR_INVITE_TTL = timedelta(minutes=15)  # без ответа приглашение истекает через start_at + 15 мин (§3.2)
SCHEDULED_AFTER = timedelta(minutes=1)  # start_at позже приглашения больше чем на минуту — запланированная комната
CACHE_EVENTS = [
    "user.status.changed.v1",
    "consent.revoked.v1",
    "user.notification_settings.changed.v1",
    "user.profile.updated.v1",
]

Handler = Callable[[AsyncSession, Envelope], Awaitable[None]]
HHMM = Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]
InviteKind = Literal["family", "friend", "referral"]


class _Payload(BaseModel):
    """Терпимый читатель: обязательные поля проверяются строго, новые необязательные поля не ломают потребителя.
    Невалидный payload → DLQ."""

    model_config = ConfigDict(extra="ignore")


class ReminderDue(_Payload):
    user_id: uuid.UUID
    local_date: date
    slot_time: HHMM
    timezone: Annotated[str, Field(max_length=200)]
    duration_min: Literal[10, 15, 20, 30]
    streak_days: Annotated[int, Field(ge=0)] | None = None


class SessionMissed(_Payload):
    user_id: uuid.UUID
    local_date: date
    slot_time: HHMM
    timezone: Annotated[str, Field(max_length=200)]
    consecutive_missed: Annotated[int, Field(ge=1)]
    next_slot_date: date | None = None


class InviteEvent(_Payload):
    invite_id: uuid.UUID
    inviter_user_id: uuid.UUID
    invitee_user_id: uuid.UUID
    kind: InviteKind


class MemberAdded(_Payload):
    family_id: uuid.UUID
    user_id: uuid.UUID
    role: Literal["owner", "adult", "teen", "child"]
    owner_user_id: uuid.UUID


class TicketReplied(_Payload):
    ticket_id: uuid.UUID
    number: str
    user_id: uuid.UUID
    message_id: uuid.UUID


class TicketStatusChanged(_Payload):
    ticket_id: uuid.UUID
    number: str
    user_id: uuid.UUID | None = None
    to_status: str


class ReleaseNotePublished(_Payload):
    release_note_id: uuid.UUID
    slug: Annotated[str, Field(min_length=1, max_length=200)]
    audience: Literal["new", "existing", "all"]
    segments: dict[str, Any] | None = None
    published_at: datetime


class DeletionRequested(_Payload):
    user_id: uuid.UUID
    request_id: uuid.UUID


class MediaRequestDecided(_Payload):
    request_id: uuid.UUID
    user_id: uuid.UUID
    status: Literal["authored_alternative", "licensed", "rejected", "duplicate"]
    title: Annotated[str, Field(min_length=1, max_length=200)]
    linked_asset_id: Annotated[str, Field(max_length=200)] | None = None
    decided_at: datetime


class ReviewsDue(_Payload):
    user_id: uuid.UUID
    local_date: date
    due_count: Annotated[int, Field(ge=1, le=2000)]
    timezone: Annotated[str, Field(max_length=200)]


class AppealDecided(_Payload):
    appeal_id: uuid.UUID
    evaluation_id: uuid.UUID
    user_id: uuid.UUID
    decision: Literal["upheld", "corrected"]
    decided_at: datetime


class StreakFrozen(_Payload):
    user_id: uuid.UUID
    local_date: date
    op_id: uuid.UUID
    freeze_left: Annotated[int, Field(ge=0)]
    frozen_at: AwareDatetime


class BadgeEarned(_Payload):
    user_id: uuid.UUID
    badge_code: Annotated[str, Field(pattern=r"^[a-z0-9_]{3,40}$")]
    notify: bool
    earned_at: AwareDatetime


class HeroStageReached(_Payload):
    user_id: uuid.UUID
    hero_code: Annotated[str, Field(pattern=r"^(robot|pet|human)_[0-9]$")]
    stage: Literal[2, 3]
    confirmed_skills: Annotated[int, Field(ge=0)]
    notify: bool
    reached_at: AwareDatetime


# ---------------------------------------------------------------- спринт 7: социальное


class FriendRequestCreated(_Payload):
    request_id: uuid.UUID
    from_user_id: uuid.UUID
    to_user_id: uuid.UUID
    from_nickname: str | None = None


class FriendshipChanged(_Payload):
    user_a: uuid.UUID
    user_b: uuid.UUID
    status: Literal["added", "removed"]
    source: str
    requester_user_id: uuid.UUID | None = None
    accepter_nickname: str | None = None
    at: AwareDatetime


class DuelChallenged(_Payload):
    duel_id: uuid.UUID
    challenger_user_id: uuid.UUID
    opponent_user_id: uuid.UUID
    challenger_nickname: str | None = None
    accept_deadline: AwareDatetime


class DuelScore(_Payload):
    correct: Annotated[int, Field(ge=0, le=50)]
    total: Annotated[int, Field(ge=1, le=50)]


class DuelScores(_Payload):
    challenger: DuelScore | None = None
    opponent: DuelScore | None = None


class DuelFinished(_Payload):
    duel_id: uuid.UUID
    challenger_user_id: uuid.UUID
    opponent_user_id: uuid.UUID
    status: Literal["finished", "cancelled"]
    result: Literal["challenger", "opponent", "draw", "none"]
    technical: bool
    result_version: Annotated[int, Field(ge=1)]
    scores: DuelScores
    finished_at: AwareDatetime


class Standing(_Payload):
    user_id: uuid.UUID
    place: Annotated[int, Field(ge=1, le=100)]
    xp: Annotated[int, Field(ge=0)]
    prize_til: Annotated[int, Field(ge=0, le=10_000)]


class LeagueClosed(_Payload):
    week: date
    group_id: uuid.UUID
    version: Annotated[int, Field(ge=1)]
    standings: Annotated[list[Standing], Field(max_length=50)]
    closed_at: AwareDatetime


class PairInvited(_Payload):
    room_id: uuid.UUID
    inviter_user_id: uuid.UUID
    invitee_user_id: uuid.UUID
    inviter_nickname: str | None = None
    start_at: AwareDatetime
    invited_at: AwareDatetime


class PairStarting(_Payload):
    room_id: uuid.UUID
    user_ids: Annotated[list[uuid.UUID], Field(min_length=1, max_length=2)]
    start_at: AwareDatetime


class PairParticipant(_Payload):
    user_id: uuid.UUID


class PairCompleted(_Payload):
    room_id: uuid.UUID
    status: str
    end_reason: Literal["completed", "participant_left", "inactivity", "stopped"]
    participants: Annotated[list[PairParticipant], Field(min_length=1, max_length=2)]
    ended_at: AwareDatetime


class Reward(_Payload):
    freeze: Annotated[int, Field(ge=0, le=10)]
    til: Annotated[int, Field(ge=0, le=10_000)]


class ReferralRewarded(_Payload):
    """game.referral.rewarded.v1: outcome нет — rewarded (издатель до поля outcome); inviter_reward — что начислено
    пригласившему (null — ничего)."""

    referral_id: uuid.UUID
    inviter_user_id: uuid.UUID
    outcome: Literal["rewarded", "legacy", "inviter_capped"] | None = None
    inviter_reward: Reward | None = None


class ReferralRejected(_Payload):
    referral_id: uuid.UUID
    inviter_user_id: uuid.UUID
    reject_code: Literal["not_new_user", "family_member", "window_expired", "review_rejected", "monthly_cap"]


class SanctionChanged(_Payload):
    user_id: uuid.UUID
    sanction_id: uuid.UUID
    kind: Literal["warning", "social_ban", "nickname_reset"]
    until: AwareDatetime | None = None
    change: Literal["applied", "expired", "revoked", "overturned"]


class SanctionAppealDecided(_Payload):
    appeal_id: uuid.UUID
    user_id: uuid.UUID
    decision: Literal["upheld", "overturned"]


class CaseResolved(_Payload):
    case_id: uuid.UUID
    reporter_user_id: uuid.UUID
    outcome: Literal["action_taken", "dismissed"]


def duel_outcome(d: DuelFinished, user_id: uuid.UUID) -> tuple[str | None, DuelScore | None]:
    """Исход дуэли для участника (win | loss | draw | technical_win | technical_loss) и его собственный счёт."""
    role = "challenger" if user_id == d.challenger_user_id else "opponent"
    score = d.scores.challenger if role == "challenger" else d.scores.opponent
    if d.result == "none":
        return None, score
    if d.result == "draw":
        return "draw", score
    won = d.result == role
    if d.technical:
        return ("technical_win" if won else "technical_loss"), score
    return ("win" if won else "loss"), score


Accept = Callable[..., Awaitable[str]]


def build_handlers(runtime: Runtime, dispatcher: Dispatcher) -> tuple[Accept, dict[str, tuple[list[str], Handler]]]:
    """→ (accept — общий приём записи для потребителей и POST …/transactional, {durable: (события, обработчик)})."""
    settings: Settings = runtime.settings  # type: ignore[assignment]

    def wake_after_commit(session: AsyncSession) -> None:
        event.listen(session.sync_session, "after_commit", lambda _s: dispatcher.wake(), once=True)

    async def accept(
        session: AsyncSession,
        env: Envelope | None,
        *,
        user_id: uuid.UUID,
        template: str,
        params: dict[str, Any] | None,
        dedup_key: str,
        kind: str = "standard",
        subject_user_id: uuid.UUID | None = None,
        center_only: bool = False,
        not_before: datetime | None = None,
        stale_after: datetime | None = None,
        notification_id: uuid.UUID | None = None,
        direct: bool = False,
    ) -> str:
        """→ scheduled | failed | skipped (ученик удалён — без записи) | duplicate."""
        now = datetime.now(UTC)
        await store.lock_user(session, user_id)
        if await store.is_deleted(session, user_id):
            log.info("notification skipped: user deleted", extra={"template": template})
            return "skipped"
        spec = TEMPLATES.get(template)
        status, reason = "scheduled", None
        if spec is None:
            status, reason = "failed", "template_unknown"
        elif spec.direct_only and not direct:
            status, reason = "failed", "direct_only"  # секрет пришёл не тем путём — не храним и не отправляем
        else:
            try:
                spec.validate(params)
            except TemplateError:
                status, reason = "failed", "params_invalid"
        nid = notification_id or notification_id_for(dedup_key)
        inserted = await store.insert_notification(
            session,
            notification_id=nid,
            user_id=user_id,
            category=spec.category if spec is not None else "service",
            kind=kind,
            template=template,
            params=params,
            dedup_key=dedup_key,
            now=now,
            subject_user_id=subject_user_id,
            center_only=center_only,
            not_before=not_before,
            stale_after=stale_after,
            source_event_id=env.event_id if env is not None else None,
            telegram_status=status,
            reason=reason,
        )
        if not inserted:
            log.info("duplicate notification suppressed", extra={"template": template})
            return "duplicate"
        if status == "failed":
            log.error("notification rejected", extra={"template": template, "reason": reason})
            await emit(
                session,
                store.DELIVERY_FAILED,
                {"notification_id": str(nid), "user_id": str(user_id), "reason": "error"},
                producer=settings.service_name,
            )
            return "failed"
        if not direct:
            wake_after_commit(session)
        return "scheduled"

    # ---------------------------------------------------------------- learning-plan

    async def on_learning(session: AsyncSession, env: Envelope) -> None:
        if env.event_type == REMINDER_DUE:
            r = ReminderDue.model_validate(env.payload)
            slot = at_local(r.local_date, r.slot_time, zone(r.timezone, settings.default_timezone))
            await accept(
                session,
                env,
                user_id=r.user_id,
                template="lesson.reminder",
                params={
                    "local_date": r.local_date.isoformat(),
                    "slot_time": r.slot_time,
                    "duration_min": r.duration_min,
                    "streak_days": r.streak_days,
                },
                dedup_key=f"reminder:{r.user_id}:{r.local_date.isoformat()}",
                stale_after=slot + timedelta(hours=settings.reminder_stale_hours),
            )
            return
        m = SessionMissed.model_validate(env.payload)
        await on_missed(session, env, m)

    async def on_missed(session: AsyncSession, env: Envelope, m: SessionMissed) -> None:
        tz = zone(m.timezone, settings.default_timezone)
        next_day = m.local_date + timedelta(days=1)
        # Утром следующего дня — в слот-время (preferred_time); позже 22:00 следующего дня — только центр
        not_before = at_local(next_day, m.slot_time, tz)
        stale_after = max(at_local(next_day, settings.missed_stale_time, tz), not_before + timedelta(hours=1))
        await store.lock_user(session, m.user_id)
        if m.consecutive_missed <= 3:
            template = "lesson.missed"
            params: dict[str, Any] = {
                "local_date": m.local_date.isoformat(),
                "consecutive_missed": m.consecutive_missed,
                "next_slot_date": m.next_slot_date.isoformat() if m.next_slot_date else None,
            }
        else:
            last = await store.missed_last_date(session, m.user_id)
            if last is not None and (m.local_date - last).days < settings.comeback_min_days:
                log.info("comeback throttled", extra={"consecutive_missed": m.consecutive_missed})
                return
            template = "lesson.comeback"
            params = {"local_date": m.local_date.isoformat(), "consecutive_missed": m.consecutive_missed}
        outcome = await accept(
            session,
            env,
            user_id=m.user_id,
            template=template,
            params=params,
            dedup_key=f"missed:{m.user_id}:{m.local_date.isoformat()}",
            not_before=not_before,
            stale_after=stale_after,
        )
        if outcome == "scheduled":
            await store.set_missed_date(session, m.user_id, m.local_date, datetime.now(UTC))

    # ---------------------------------------------------------------- social

    async def on_social(session: AsyncSession, env: Envelope) -> None:
        if env.event_type == MEMBER_ADDED:
            await on_member_added(session, env, MemberAdded.model_validate(env.payload))
            return
        i = InviteEvent.model_validate(env.payload)
        if i.inviter_user_id == i.invitee_user_id:
            return  # самоприглашение social отклоняет; на всякий случай — без сообщений себе
        params = {"invite_id": str(i.invite_id), "kind": i.kind}
        if env.event_type == INVITE_ACCEPTED:
            # Семья: тот же ключ, что у family.joined владельцу — пригласивший-владелец получит одно сообщение
            dedup = (
                f"family.joined:{i.inviter_user_id}:{i.invitee_user_id}"
                if i.kind == "family"
                else f"invite.accepted:{i.invite_id}:{i.invitee_user_id}"
            )
            await accept(
                session,
                env,
                user_id=i.inviter_user_id,
                template="invite.accepted",
                params=params,
                dedup_key=dedup,
                subject_user_id=i.invitee_user_id,
            )
        elif env.event_type == INVITE_DECLINED:
            await accept(
                session,
                env,
                user_id=i.inviter_user_id,
                template="invite.declined",
                params=params,
                dedup_key=f"invite.declined:{i.invite_id}:{i.invitee_user_id}",
                center_only=True,
            )
        elif env.event_type == INVITE_REMINDER:
            await accept(
                session,
                env,
                user_id=i.invitee_user_id,
                template="invite.pending",
                params=params,
                dedup_key=f"invite.pending:{i.invite_id}:{i.invitee_user_id}",
                subject_user_id=i.inviter_user_id,
            )

    async def on_member_added(session: AsyncSession, env: Envelope, m: MemberAdded) -> None:
        now = datetime.now(UTC)
        if m.role == "owner":
            await store.set_family_owner(session, m.family_id, m.user_id, now)
            return
        await store.set_family_owner(session, m.family_id, m.owner_user_id, now)
        if m.role == "child":
            return  # ребёнка добавляет сам родитель — сообщать некому
        owner = m.owner_user_id
        if owner == m.user_id:
            return
        await accept(
            session,
            env,
            user_id=owner,
            template="family.joined",
            params={"family_id": str(m.family_id), "role": m.role},
            dedup_key=f"family.joined:{owner}:{m.user_id}",
            subject_user_id=m.user_id,
        )

    # ---------------------------------------------------------------- support

    async def on_support(session: AsyncSession, env: Envelope) -> None:
        if env.event_type == TICKET_REPLIED:
            t = TicketReplied.model_validate(env.payload)
            # Только номер обращения: текст ответа читается в Mini App (не уходит в Telegram)
            await accept(
                session,
                env,
                user_id=t.user_id,
                template="support.reply",
                params={"number": t.number},
                dedup_key=f"support.reply:{t.message_id}",
            )
            return
        s = TicketStatusChanged.model_validate(env.payload)
        if s.to_status == "RESOLVED" and s.user_id is not None:
            await accept(
                session,
                env,
                user_id=s.user_id,
                template="support.resolved",
                params={"number": s.number},
                dedup_key=f"support.resolved:{s.ticket_id}:{env.event_id}",
            )

    # ---------------------------------------------------------------- experience-config

    async def on_release_note(session: AsyncSession, env: Envelope) -> None:
        r = ReleaseNotePublished.model_validate(env.payload)
        await store.insert_broadcast(
            session,
            broadcast_id=r.release_note_id,
            slug=r.slug,
            audience=r.audience,
            segments=r.segments,
            published_at=r.published_at,
            now=datetime.now(UTC),
        )

    # ---------------------------------------------------------------- catalog (спринт 3)

    async def on_catalog(session: AsyncSession, env: Envelope) -> None:
        """Решение по заявке на песню/фильм (AT-30) → запись ученику через общую политику доставки. В журнал — без
        названия заявки (это текст ученика)."""
        if env.producer not in CATALOG_PRODUCERS:
            log.warning("media request decision from unexpected producer ignored",
                        extra={"event_type": env.event_type, "producer": env.producer[:64]})
            return
        d = MediaRequestDecided.model_validate(env.payload)
        await accept(
            session,
            env,
            user_id=d.user_id,
            template="media_request.decided",
            params={
                "request_id": str(d.request_id),
                "request_title": d.title,
                "status": d.status,
                "linked_asset_id": d.linked_asset_id,
            },
            dedup_key=f"media_request.decided:{d.request_id}:{d.status}",
        )

    # ---------------------------------------------------------------- assessment (спринт 4)

    async def on_assessment(session: AsyncSession, env: Envelope) -> None:
        """Решение по апелляции на оценку урока (AT-47) → запись ученику (ребёнку — опекуну) через общую политику
        доставки: тихие часы, окно детей, выключатель Telegram; категория support. Одно сообщение на апелляцию."""
        if env.producer not in ASSESSMENT_PRODUCERS:
            log.warning("appeal decision from unexpected producer ignored",
                        extra={"event_type": env.event_type, "producer": env.producer[:64]})
            return
        d = AppealDecided.model_validate(env.payload)
        await accept(
            session,
            env,
            user_id=d.user_id,
            template="appeal_decided",
            params={"appeal_id": str(d.appeal_id), "evaluation_id": str(d.evaluation_id), "decision": d.decision},
            dedup_key=f"appeal_decided:{d.appeal_id}",
        )

    # ---------------------------------------------------------------- memory (спринт 5)

    async def on_memory(session: AsyncSession, env: Envelope) -> None:
        """Слова к повторению (AT-59) → reviews_due ученику (ребёнку 6–13 — reviews_due.kid опекуну), категория
        reminders: тихие часы, окно детей, выключатель, лимит дня — общая политика, как у lesson.reminder. Одно
        напоминание в местный день; позже 19:00 + REMINDER_STALE_HOURS — только центр."""
        if env.producer not in MEMORY_PRODUCERS:
            log.warning("reviews due from unexpected producer ignored",
                        extra={"event_type": env.event_type, "producer": env.producer[:64]})
            return
        r = ReviewsDue.model_validate(env.payload)
        slot = at_local(r.local_date, REVIEWS_DUE_TIME, zone(r.timezone, settings.default_timezone))
        await accept(
            session,
            env,
            user_id=r.user_id,
            template="reviews_due",
            params={"local_date": r.local_date.isoformat(), "due_count": r.due_count},
            dedup_key=f"reviews_due:{r.user_id}:{r.local_date.isoformat()}",
            stale_after=slot + timedelta(hours=settings.reminder_stale_hours),
        )

    # ---------------------------------------------------------------- gamification (спринт 6)

    async def on_game(session: AsyncSession, env: Envelope) -> None:
        """Заморозка серии, новый значок, ступень героя (AT-66, AT-70, AT-65) → запись ученику через общую политику
        доставки (категория game, тихие часы, выключатель, лимит дня); детям 6–13 — только центр детского профиля.
        notify=false у значка и ступени — без записи (game_notifications выключены у ученика)."""
        if env.producer not in GAME_PRODUCERS:
            log.warning("game event from unexpected producer ignored",
                        extra={"event_type": env.event_type, "producer": env.producer[:64]})
            return
        stale = timedelta(hours=settings.game_stale_hours)
        if env.event_type == STREAK_FROZEN:
            f = StreakFrozen.model_validate(env.payload)
            # пропуск выпускается после местной полуночи; утром следующего дня — сообщение, после 22:00 — только
            # центр (как lesson.missed). Пояса в событии нет — пояс по умолчанию; ночь закрывают тихие часы ученика
            tz = zone(None, settings.default_timezone)
            await accept(
                session,
                env,
                user_id=f.user_id,
                template="streak_frozen",
                params={"local_date": f.local_date.isoformat(), "freeze_left": f.freeze_left},
                dedup_key=f"streak_frozen:{f.user_id}:{f.local_date.isoformat()}",
                stale_after=at_local(f.local_date + timedelta(days=1), settings.missed_stale_time, tz),
            )
            return
        if env.event_type == BADGE_EARNED:
            b = BadgeEarned.model_validate(env.payload)
            if not b.notify:
                log.info("game notification turned off by learner", extra={"event_type": env.event_type})
                return
            await accept(
                session,
                env,
                user_id=b.user_id,
                template="badge_earned",
                params={"badge_code": b.badge_code},
                dedup_key=f"badge_earned:{b.user_id}:{b.badge_code}",
                stale_after=b.earned_at + stale,
            )
            return
        h = HeroStageReached.model_validate(env.payload)
        if not h.notify:
            log.info("game notification turned off by learner", extra={"event_type": env.event_type})
            return
        await accept(
            session,
            env,
            user_id=h.user_id,
            template="hero_stage_reached",
            params={"hero_code": h.hero_code, "stage": h.stage},
            dedup_key=f"hero_stage_reached:{h.user_id}:{h.stage}",
            stale_after=h.reached_at + stale,
        )

    # ---------------------------------------------------------------- спринт 7: социальное

    def foreign(env: Envelope, allowed: frozenset[str]) -> bool:
        if env.producer in allowed:
            return False
        log.warning("social event from unexpected producer ignored",
                    extra={"event_type": env.event_type, "producer": env.producer[:64]})
        return True

    async def on_community(session: AsyncSession, env: Envelope) -> None:
        """Друзья, рефералы и модерация (social, AT-73, AT-78, AT-79)."""
        if foreign(env, SOCIAL_PRODUCERS):
            return
        if env.event_type == FRIEND_REQUEST:
            fr = FriendRequestCreated.model_validate(env.payload)
            if fr.from_user_id == fr.to_user_id:
                return
            await accept(session, env, user_id=fr.to_user_id, template="friend_request",
                         params={"request_id": str(fr.request_id), "nickname": valid_nickname(fr.from_nickname)},
                         dedup_key=f"friend_request:{fr.request_id}", subject_user_id=fr.from_user_id)
        elif env.event_type == FRIENDSHIP_CHANGED:
            fc = FriendshipChanged.model_validate(env.payload)
            requester = fc.requester_user_id
            if fc.status != "added" or fc.source != "request" or requester not in (fc.user_a, fc.user_b):
                return
            accepter = fc.user_b if requester == fc.user_a else fc.user_a
            await accept(session, env, user_id=requester, template="friend_accepted",
                         params={"nickname": valid_nickname(fc.accepter_nickname)},
                         dedup_key=f"friend_accepted:{requester}:{accepter}:{fc.at.isoformat()}",
                         subject_user_id=accepter)
        elif env.event_type == REFERRAL_REJECTED:
            rr = ReferralRejected.model_validate(env.payload)
            await accept(session, env, user_id=rr.inviter_user_id, template="referral_rejected",
                         params={"referral_id": str(rr.referral_id), "reject_code": rr.reject_code},
                         dedup_key=f"referral_rejected:{rr.referral_id}")
        elif env.event_type == SANCTION_CHANGED:
            sc = SanctionChanged.model_validate(env.payload)
            if sc.change != "applied":
                return  # истечение, снятие и отмена по обжалованию — без сообщения (обжалование — своё сообщение)
            await accept(session, env, user_id=sc.user_id, template="sanction_applied",
                         params={"sanction_id": str(sc.sanction_id), "kind": sc.kind,
                                 "until": sc.until.isoformat() if sc.until is not None else None},
                         dedup_key=f"sanction_applied:{sc.sanction_id}")
        elif env.event_type == SANCTION_APPEAL_DECIDED:
            ad = SanctionAppealDecided.model_validate(env.payload)
            await accept(session, env, user_id=ad.user_id, template="sanction_appeal_decided",
                         params={"appeal_id": str(ad.appeal_id), "decision": ad.decision},
                         dedup_key=f"sanction_appeal_decided:{ad.appeal_id}")
        elif env.event_type == CASE_RESOLVED:
            cr = CaseResolved.model_validate(env.payload)
            await accept(session, env, user_id=cr.reporter_user_id, template="complaint_resolved",
                         params={"case_id": str(cr.case_id), "outcome": cr.outcome},
                         dedup_key=f"complaint_resolved:{cr.case_id}")

    async def on_referral_rewarded(session: AsyncSession, env: Envelope) -> None:
        """Награда пригласившему начислена (gamification, AT-78) → «Приглашение засчитано» с наградой из события.
        legacy / inviter_capped — пригласившему ничего, сообщения нет (о лимите месяца — referral_rejected)."""
        if foreign(env, GAME_PRODUCERS):
            return
        rr = ReferralRewarded.model_validate(env.payload)
        if rr.outcome not in (None, "rewarded"):
            return
        if rr.inviter_reward is None:
            log.warning("referral rewarded without inviter_reward: no message",
                        extra={"event_type": env.event_type, "event_id": env.event_id})
            return
        if rr.inviter_reward.freeze <= 0 and rr.inviter_reward.til <= 0:
            return  # кампания ничего не дала пригласившему — «вы получили» не пишем
        await accept(session, env, user_id=rr.inviter_user_id, template="referral_qualified",
                     params={"referral_id": str(rr.referral_id), "freeze": rr.inviter_reward.freeze,
                             "til": rr.inviter_reward.til},
                     dedup_key=f"referral_qualified:{rr.referral_id}")

    async def on_duels_leagues(session: AsyncSession, env: Envelope) -> None:
        """Дуэли и итоги общей лиги (gamification, AT-74, AT-75): категория game."""
        if foreign(env, GAME_PRODUCERS):
            return
        stale = timedelta(hours=settings.game_stale_hours)
        if env.event_type == DUEL_CHALLENGED:
            dc = DuelChallenged.model_validate(env.payload)
            await accept(session, env, user_id=dc.opponent_user_id, template="duel_challenged",
                         params={"duel_id": str(dc.duel_id), "nickname": valid_nickname(dc.challenger_nickname),
                                 "accept_deadline": dc.accept_deadline.isoformat()},
                         dedup_key=f"duel_challenged:{dc.duel_id}", subject_user_id=dc.challenger_user_id,
                         stale_after=dc.accept_deadline)
        elif env.event_type == DUEL_FINISHED:
            df = DuelFinished.model_validate(env.payload)
            if df.status != "finished":
                return  # никто не сыграл — дуэль отменена, итога нет
            for user_id in (df.challenger_user_id, df.opponent_user_id):
                outcome, score = duel_outcome(df, user_id)
                if outcome is None:
                    continue
                await accept(session, env, user_id=user_id, template="duel_finished",
                             params={"duel_id": str(df.duel_id), "outcome": outcome,
                                     "result_version": df.result_version,
                                     "correct": score.correct if score else None,
                                     "total": score.total if score else None},
                             dedup_key=f"duel_finished:{df.duel_id}:{user_id}:{df.result_version}",
                             stale_after=df.finished_at + stale)
        else:
            lc = LeagueClosed.model_validate(env.payload)
            for st in lc.standings:
                await accept(session, env, user_id=st.user_id, template="league_closed",
                             params={"week": lc.week.isoformat(), "place": st.place, "xp": st.xp,
                                     "prize_til": st.prize_til},
                             dedup_key=f"league_closed:{lc.group_id}:{st.user_id}:{st.place}:{st.prize_til}",
                             stale_after=lc.closed_at + stale)

    async def on_pair(session: AsyncSession, env: Envelope) -> None:
        """Парные уроки (lessons, AT-76): приглашение, скорый старт, остановка администратором."""
        if foreign(env, LESSONS_PRODUCERS):
            return
        if env.event_type == PAIR_INVITED:
            pi = PairInvited.model_validate(env.payload)
            if pi.inviter_user_id == pi.invitee_user_id:
                return
            await accept(session, env, user_id=pi.invitee_user_id, template="pair_invited",
                         params={"room_id": str(pi.room_id), "nickname": valid_nickname(pi.inviter_nickname),
                                 "start_at": pi.start_at.isoformat(),
                                 "scheduled": pi.start_at - pi.invited_at > SCHEDULED_AFTER},
                         dedup_key=f"pair_invited:{pi.room_id}", subject_user_id=pi.inviter_user_id,
                         stale_after=pi.start_at + PAIR_INVITE_TTL)
        elif env.event_type == PAIR_STARTING:
            ps = PairStarting.model_validate(env.payload)
            for user_id in dict.fromkeys(ps.user_ids):
                await accept(session, env, user_id=user_id, template="pair_starting",
                             params={"room_id": str(ps.room_id)}, dedup_key=f"pair_starting:{ps.room_id}:{user_id}",
                             stale_after=ps.start_at)
        else:
            pc = PairCompleted.model_validate(env.payload)
            if pc.end_reason != "stopped":
                return
            for user_id in dict.fromkeys(p.user_id for p in pc.participants):
                await accept(session, env, user_id=user_id, template="pair_stopped",
                             params={"room_id": str(pc.room_id)}, dedup_key=f"pair_stopped:{pc.room_id}:{user_id}",
                             stale_after=pc.ended_at + timedelta(hours=settings.game_stale_hours))

    # ---------------------------------------------------------------- identity-consent

    async def on_user_deleted(session: AsyncSession, env: Envelope) -> None:
        """Сагу удаления ведёт только identity-consent (P-7): чужой издатель — лог без PII, подтверждение шине
        без удаления и без ACK."""
        if env.producer not in DELETION_PRODUCERS:
            log.warning("deletion request from unexpected producer ignored",
                        extra={"event_type": env.event_type, "producer": env.producer[:64]})
            return
        d = DeletionRequested.model_validate(env.payload)
        await store.lock_user(session, d.user_id)
        await store.mark_deleted(session, d.user_id, d.request_id, datetime.now(UTC))
        await store.delete_user(session, d.user_id)
        await forget(runtime, prefix=settings.redis_key_prefix, user_id=d.user_id)
        await emit(
            session,
            store.DOMAIN_DELETED,
            {"user_id": str(d.user_id), "request_id": str(d.request_id), "domain": "notifications", "mode": "deleted"},
            producer=settings.service_name,
        )

    async def on_user_changed(session: AsyncSession, env: Envelope) -> None:
        """Настройки, статус, согласие, возраст/язык действуют сразу, а не через 5 мин TTL кэша адресации."""
        raw = env.payload.get("user_id")
        if raw:
            await forget(runtime, prefix=settings.redis_key_prefix, user_id=str(uuid.UUID(str(raw))))

    return accept, {
        "notifications.learning": ([REMINDER_DUE, SESSION_MISSED], on_learning),
        "notifications.social": ([INVITE_ACCEPTED, INVITE_DECLINED, INVITE_REMINDER, MEMBER_ADDED], on_social),
        "notifications.support": ([TICKET_REPLIED, TICKET_STATUS_CHANGED], on_support),
        "notifications.product": ([RELEASE_NOTE], on_release_note),
        "notifications.catalog": ([MEDIA_REQUEST_DECIDED], on_catalog),
        "notifications.assessment": ([APPEAL_DECIDED], on_assessment),
        "notifications.memory": ([REVIEWS_DUE], on_memory),
        "notifications.game": ([STREAK_FROZEN, BADGE_EARNED, HERO_STAGE_REACHED], on_game),
        "notifications.community": (COMMUNITY_EVENTS, on_community),
        "notifications.duels_leagues": ([DUEL_CHALLENGED, DUEL_FINISHED, LEAGUE_CLOSED], on_duels_leagues),
        "notifications.referral_rewards": ([REFERRAL_REWARDED], on_referral_rewarded),
        "notifications.pair_rooms": ([PAIR_INVITED, PAIR_STARTING, PAIR_COMPLETED], on_pair),
        "notifications.user_deleted": ([DELETION_REQUESTED], on_user_deleted),
        "notifications.delivery_cache": (CACHE_EVENTS, on_user_changed),
    }
