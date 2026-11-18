"""Проекция admin_learner_summary из событий и снимков источников (без FastAPI).

Правила:
- каждое событие применяется ровно один раз (inbox — в Runtime.add_consumer);
- порядок доставки не гарантирован: у каждой группы полей своя версия (момент события или `updated_at` снимка),
  событие старше версии ничего не меняет (`_newer`);
- DELETED — конечный статус: имя, username, маска, связь с опекуном, план и настройки стёрты, связь с обращениями
  разорвана, ничто не возвращает ученика в другой статус;
- события принимаются только от домена-владельца (иначе — предупреждение без данных, событие отмечено в inbox).
PII (username, имя) в логи не попадает: в логах только тип события.
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_user_admin.models import (
    AGE_BANDS,
    CATEGORIES,
    EMPTY_SECURITY,
    GOALS,
    GUARDIAN_CONSENTS,
    LEVELS,
    OPEN_TICKET_STATUSES,
    STATUSES,
    TICKET_STATUSES,
    LearnerSummary,
    TicketRef,
)
from tilhero_user_admin.schemas import IdentitySnapshot, PlanSnapshot, norm_locale

log = logging.getLogger("tilhero.user_admin.projection")

IDENTITY = "identity-consent"
LEARNING_PLAN = "learning-plan"
SUPPORT = "support"

EV_PROFILE_CREATED = "user.profile.created.v1"
EV_PROFILE_UPDATED = "user.profile.updated.v1"
EV_STATUS_CHANGED = "user.status.changed.v1"
EV_CONSENT_ACCEPTED = "consent.accepted.v1"
EV_CONSENT_REVOKED = "consent.revoked.v1"
EV_NOTIFY_CHANGED = "user.notification_settings.changed.v1"
EV_SECURITY_CHANGED = "user.security.changed.v1"
EV_DELETION_REQUESTED = "user.deletion.requested.v1"
EV_DOMAIN_DELETED = "user.domain.deleted.v1"
EV_PLAN_UPDATED = "learning.plan.updated.v1"
EV_ACTIVITY_RECORDED = "learning.activity.recorded.v1"
EV_TICKET_CREATED = "support.ticket.created.v1"
EV_TICKET_STATUS_CHANGED = "support.ticket.status.changed.v1"

# Производитель-владелец каждого события: чужой издатель не может переписать read-модель
PRODUCERS: dict[str, str] = {
    EV_PROFILE_CREATED: IDENTITY,
    EV_PROFILE_UPDATED: IDENTITY,
    EV_STATUS_CHANGED: IDENTITY,
    EV_CONSENT_ACCEPTED: IDENTITY,
    EV_CONSENT_REVOKED: IDENTITY,
    EV_NOTIFY_CHANGED: IDENTITY,
    EV_SECURITY_CHANGED: IDENTITY,
    EV_DELETION_REQUESTED: IDENTITY,
    EV_DOMAIN_DELETED: IDENTITY,
    EV_PLAN_UPDATED: LEARNING_PLAN,
    EV_ACTIVITY_RECORDED: LEARNING_PLAN,
    EV_TICKET_CREATED: SUPPORT,
    EV_TICKET_STATUS_CHANGED: SUPPORT,
}
EVENT_TYPES = list(PRODUCERS)

# learning-plan: дни пресетов графика (domain/schedule.py PRESET_DAYS) — для оценки пресета по событию
PRESET_DAYS: dict[str, tuple[int, ...]] = {
    "daily": (1, 2, 3, 4, 5, 6, 7),
    "weekdays": (1, 2, 3, 4, 5),
    "three_per_week": (1, 3, 5),
}
_TCK = re.compile(r"^TCK-(\d{1,12})$")
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_PIN_ON = ("pin_set", "pin_changed", "pin_reset")


@dataclass(frozen=True)
class Applied:
    """Итог применения события: relevant — событие относится к read-модели; wake_* — досрочная сверка источника
    (данных, которых нет в событии: имя/username — identity-consent, уровень/пресет — learning-plan)."""

    relevant: bool
    wake_identity: bool = False
    wake_plans: bool = False


IGNORED = Applied(False)
DONE = Applied(True)


def utcnow() -> datetime:
    return datetime.now(UTC)


def _newer(at: datetime, version: datetime | None) -> bool:
    """Событие/снимок не старше текущей версии полей (равные — та же правда, применять безопасно)."""
    return version is None or at >= version


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _aware(value: Any) -> datetime | None:
    """ISO-8601 с часовым поясом → UTC; иначе None."""
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                return parsed.astimezone(UTC)
        except ValueError:
            pass
    return None


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def ticket_number(value: Any) -> int | None:
    m = _TCK.match(str(value or "").strip().upper())
    return int(m.group(1)) if m else None


def search_text(display_name: str | None, username: str | None) -> str | None:
    text = " ".join(p for p in (display_name, username) if p).strip().lower()
    return text or None


# ---------------------------------------------------------------- строки и счётчики

async def lock_summary(session: AsyncSession, user_id: uuid.UUID, *, created_at: datetime) -> LearnerSummary:
    """Строка ученика под FOR UPDATE (создаётся при первом упоминании)."""
    inserted = (
        await session.execute(
            insert(LearnerSummary)
            .values(user_id=user_id, created_at=created_at, status="ACTIVE")
            .on_conflict_do_nothing(index_elements=[LearnerSummary.user_id])
            .returning(LearnerSummary.user_id)
        )
    ).first()
    row = (
        await session.execute(
            select(LearnerSummary)
            .where(LearnerSummary.user_id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    if inserted is not None:
        await refresh_ticket_counters(session, user_id)
    return row


async def refresh_ticket_counters(session: AsyncSession, user_id: uuid.UUID | None) -> None:
    """open/total пересчитываются из ticket_refs — идемпотентно и независимо от порядка событий."""
    if user_id is None:
        return
    open_count, total = (
        await session.execute(
            select(
                func.count().filter(TicketRef.status.in_(OPEN_TICKET_STATUSES)),
                func.count(),
            ).where(TicketRef.user_id == user_id)
        )
    ).one()
    await session.execute(
        update(LearnerSummary)
        .where(LearnerSummary.user_id == user_id)
        .values(open_tickets=int(open_count), tickets_total=int(total))
        .execution_options(synchronize_session="fetch")
    )


async def erase(session: AsyncSession, row: LearnerSummary, at: datetime) -> None:
    """Удаление завершено (TG-FR-006): стираем копии PII, связь с опекуном, план, настройки и связь с обращениями.
    Согласие (без PII) остаётся как в identity-consent — доказательство."""
    row.status = "DELETED"
    row.status_at = max(at, row.status_at) if row.status_at else at
    row.display_name = None
    row.username = None
    row.telegram_id_masked = None
    row.search_text = None
    row.guardian_user_id = None
    row.age_band = None
    row.plan = None
    row.goal = None
    row.reminders_enabled = False
    row.onboarding_completed = False
    row.notifications = None
    row.security = dict(EMPTY_SECURITY)
    row.last_activity_at = None
    if row.erased_at is None:
        row.erased_at = utcnow()
    # flush до UPDATE ticket_refs: autoflush строки в середине стирания нарушил бы CHECK ck_learner_deleted_erased
    await session.flush()
    await session.execute(
        update(TicketRef)
        .where(TicketRef.user_id == row.user_id)
        .values(user_id=None, anonymized=True)
        .execution_options(synchronize_session=False)
    )
    row.open_tickets = 0
    row.tickets_total = 0


async def apply_status(
    session: AsyncSession, row: LearnerSummary, status: str, at: datetime, *, force: bool = False
) -> None:
    if status not in STATUSES:
        return
    if row.erased_at is not None:
        return  # конечный статус
    if status == "DELETED":
        if force or _newer(at, row.status_at):
            await erase(session, row, at)
        return
    if _newer(at, row.status_at):
        row.status = status
        row.status_at = at


# ---------------------------------------------------------------- события

async def apply_event(session: AsyncSession, env: Envelope) -> Applied:
    """→ Applied: relevant=True, если событие относится к read-модели и применено (или осознанно пропущено как
    устаревшее)."""
    owner = PRODUCERS.get(env.event_type)
    if owner is None:
        return IGNORED
    p = env.payload or {}
    if env.event_type == EV_DOMAIN_DELETED and p.get("domain") != IDENTITY:
        return IGNORED  # ACK других доменов не относятся к профилю (identity-consent пришлёт свой после всех)
    if env.producer != owner:
        log.warning("event from unexpected producer ignored",
                    extra={"event_type": env.event_type, "producer": env.producer[:64]})
        return IGNORED
    at = env.occurred_at.astimezone(UTC)
    if env.event_type in (EV_TICKET_CREATED, EV_TICKET_STATUS_CHANGED):
        return await _apply_ticket(session, env, at)
    user_id = _uuid(p.get("user_id"))
    if user_id is None:
        log.warning("event without valid user_id ignored", extra={"event_type": env.event_type})
        return IGNORED
    created_hint = (_aware(p.get("created_at")) or at) if env.event_type == EV_PROFILE_CREATED else at
    row = await lock_summary(session, user_id, created_at=created_hint)
    if row.erased_at is not None:
        return DONE  # удалён: поздние события ничего не возвращают

    match env.event_type:
        case "user.profile.created.v1":
            _apply_profile_created(row, p, at, created_hint)
            return Applied(True, wake_identity=True)  # имя и username есть только в identity-consent
        case "user.profile.updated.v1":
            _apply_profile(row, p, at)
            changed = {str(x) for x in (p.get("changed_fields") or [])}
            return Applied(True, wake_identity=bool(changed & {"display_name", "username"}))
        case "user.status.changed.v1":
            await apply_status(session, row, str(p.get("status")), at)
        case "user.deletion.requested.v1":
            await apply_status(session, row, "DELETION_REQUESTED", at)
        case "user.domain.deleted.v1":
            await apply_status(session, row, "DELETED", at, force=True)
        case "consent.accepted.v1":
            _apply_consent_accepted(row, p, at)
        case "consent.revoked.v1":
            _apply_consent_revoked(row, p, at)
        case "user.notification_settings.changed.v1":
            _apply_notifications(row, p, at)
        case "user.security.changed.v1":
            _apply_security(row, str(p.get("change")), at)
        case "learning.plan.updated.v1":
            return Applied(True, wake_plans=_apply_plan_event(row, p, at))
        case "learning.activity.recorded.v1":
            recorded = _aware(p.get("recorded_at")) or at
            if row.last_activity_at is None or recorded > row.last_activity_at:
                row.last_activity_at = recorded
    return DONE


def _apply_profile_created(row: LearnerSummary, p: dict[str, Any], at: datetime, created_at: datetime) -> None:
    if not row.profile_known:
        # created_at — ключ сортировки и курсора списка: фиксируется один раз, когда профиль подтверждён (событием
        # или снимком identity-consent), и дальше не меняется — иначе курсорная пагинация даёт пропуски и дубли
        row.created_at = created_at
        row.profile_known = True
    if row.source_updated_at is None:  # вид и опекун — из снимка, если он уже был
        kind = p.get("kind")
        if kind in ("account", "child"):
            row.kind = kind
        guardian = _uuid(p.get("guardian_user_id")) if row.kind == "child" else None
        row.guardian_user_id = guardian if guardian != row.user_id else None
        if row.kind == "child":
            row.username = None
            row.telegram_id_masked = None
            row.search_text = search_text(row.display_name, None)
    _apply_profile(row, p, at)
    if row.status_at is None:
        row.status_at = at  # профиль создан ACTIVE; любое более позднее событие статуса победит


def _apply_profile(row: LearnerSummary, p: dict[str, Any], at: datetime) -> None:
    """Язык, возраст и согласие родителя (user.profile.created|updated.v1 несут текущие значения)."""
    if not _newer(at, row.profile_at):
        return
    if "locale" in p:
        row.locale = norm_locale(p.get("locale"))
    if "age_band" in p:
        band = p.get("age_band")
        row.age_band = band if band in AGE_BANDS else None
    if p.get("guardian_consent") in GUARDIAN_CONSENTS:
        row.guardian_consent = str(p["guardian_consent"])
    row.profile_at = at


def _apply_consent_accepted(row: LearnerSummary, p: dict[str, Any], at: datetime) -> None:
    if not _newer(at, row.consent_at):
        return
    basis = p.get("basis") if p.get("basis") in ("self", "guardian") else None
    row.consent = {
        "policy_version": str(p.get("policy_version") or "")[:20] or None,
        "purposes": [str(x)[:32] for x in (p.get("purposes") or [])][:20],
        "accepted_at": _iso(at),
        "revoked_at": None,
        "basis": basis,
    }
    row.consent_at = at


def _apply_consent_revoked(row: LearnerSummary, p: dict[str, Any], at: datetime) -> None:
    """Отзыв действующего согласия. Отзыв согласия другого основания (родитель отозвал своё у подростка, а действует
    согласие самого подростка) блок согласия не меняет — это видно по guardian_consent (user.profile.updated.v1)."""
    if not _newer(at, row.consent_at):
        return
    basis = p.get("basis")
    current = row.consent.get("basis")
    if basis in ("self", "guardian") and current in ("self", "guardian") and basis != current:
        return
    consent = dict(row.consent)
    consent["revoked_at"] = _iso(at)
    if p.get("policy_version"):
        consent["policy_version"] = str(p["policy_version"])[:20]
    row.consent = consent
    row.consent_at = at


def _apply_notifications(row: LearnerSummary, p: dict[str, Any], at: datetime) -> None:
    if not _newer(at, row.notifications_at) or not isinstance(p.get("enabled"), bool):
        return
    enabled = {str(c) for c in (p.get("categories") or [])}
    row.notifications = {"enabled": p["enabled"], "categories": {c: c in enabled for c in CATEGORIES}}
    row.notifications_at = at


def _apply_security(row: LearnerSummary, change: str, at: datetime) -> None:
    pin: bool | None = None
    reset: bool | None = None
    if change in _PIN_ON:
        pin, reset = True, False
    elif change == "pin_removed":
        pin, reset = False, False
    elif change == "pin_reset_requested":
        reset = True
    elif change == "pin_reset_cancelled":
        reset = False
    security = dict(row.security)
    if pin is not None and _newer(at, row.pin_at):
        security["pin_enabled"], row.pin_at = pin, at
    if reset is not None and _newer(at, row.pin_reset_at):
        security["pin_reset_pending"], row.pin_reset_at = reset, at
    row.security = security


def _set_plan(row: LearnerSummary, plan: dict[str, Any] | None, at: datetime) -> None:
    row.plan = plan
    row.plan_at = at
    row.goal = plan.get("goal") if plan else None
    schedule = (plan or {}).get("schedule") or {}
    row.reminders_enabled = bool(schedule.get("reminders_enabled", False))
    row.onboarding_completed = bool(plan and plan.get("onboarding_completed_at"))


def _apply_plan_event(row: LearnerSummary, p: dict[str, Any], at: datetime) -> bool:
    """learning.plan.updated.v1 несёт текущие цель, язык и график, но не уровень и пресет: их известное значение
    сохраняется, изменившееся или неизвестное уточняет досрочная сверка с learning-plan. → нужна ли сверка."""
    if not _newer(at, row.plan_at):
        return False
    old = row.plan or {}
    old_schedule = old.get("schedule") or {}
    changed = {str(x) for x in (p.get("changed_fields") or [])}
    # С спринта 2 событие несёт level_self и preset; у старых событий их нет — тогда уточняет досрочная сверка.
    has_level, has_preset = "level_self" in p, p.get("preset") in PRESET_DAYS or p.get("preset") == "custom"
    wake = not old or ("level_self" in changed and not has_level) or ("preset" in changed and not has_preset)

    goal = p.get("goal") if p.get("goal") in GOALS else None
    level = p.get("level_self") if has_level else (old.get("level_self") if "level_self" not in changed else None)
    level = level if level in LEVELS else None
    ui_lang = norm_locale(p.get("ui_lang")) if "ui_lang" in p else old.get("ui_lang")

    days_raw = p.get("days")
    days = (sorted({d for d in days_raw if isinstance(d, int) and not isinstance(d, bool) and 1 <= d <= 7})
            if isinstance(days_raw, list) else old_schedule.get("days"))
    time_raw = p.get("preferred_time")
    preferred = time_raw if isinstance(time_raw, str) and _HHMM.match(time_raw) else old_schedule.get("preferred_time")
    duration = p.get("duration_min")
    duration = duration if isinstance(duration, int) and not isinstance(duration, bool) else \
        old_schedule.get("duration_min")
    reminders = p.get("reminders_enabled")
    reminders = reminders if isinstance(reminders, bool) else old_schedule.get("reminders_enabled")
    tz = p.get("timezone")
    tz = tz[:64] if isinstance(tz, str) and tz else old_schedule.get("timezone")
    if has_preset:
        preset = p["preset"]
    elif old_schedule.get("preset") and "preset" not in changed and "days" not in changed:
        preset = old_schedule["preset"]
    else:
        preset = next((name for name, d in PRESET_DAYS.items() if days and tuple(days) == d), "custom")
        wake = True  # «custom» с днями пресета неотличим по событию
    schedule: dict[str, Any] | None = {
        "preset": preset, "days": days, "preferred_time": preferred, "duration_min": duration,
        "reminders_enabled": reminders, "timezone": tz,
    }
    if schedule is not None and any(v is None or v == [] for v in schedule.values()):
        schedule, wake = None, True

    completed = p.get("onboarding_completed")
    if completed is True:
        onboarding = old.get("onboarding_completed_at") or _iso(at)
    elif completed is False:
        onboarding = None
    else:
        onboarding = old.get("onboarding_completed_at")
    _set_plan(row, {"goal": goal, "level_self": level, "ui_lang": ui_lang, "schedule": schedule,
                    "onboarding_completed_at": onboarding, "updated_at": _iso(at)}, at)
    return wake


async def _apply_ticket(session: AsyncSession, env: Envelope, at: datetime) -> Applied:
    p = env.payload or {}
    ticket_id = _uuid(p.get("ticket_id"))
    number = ticket_number(p.get("number"))
    if ticket_id is None or number is None:
        log.warning("ticket event without valid id/number ignored", extra={"event_type": env.event_type})
        return IGNORED
    status = "NEW" if env.event_type == EV_TICKET_CREATED else str(p.get("to_status"))
    if status not in TICKET_STATUSES:
        return IGNORED
    user_id = _uuid(p.get("user_id"))
    explicitly_anonymized = env.event_type == EV_TICKET_STATUS_CHANGED and "user_id" in p and p["user_id"] is None
    if user_id is not None:
        owner = (await session.execute(
            select(LearnerSummary.erased_at).where(LearnerSummary.user_id == user_id)
        )).first()
        if owner is not None and owner.erased_at is not None:
            user_id, explicitly_anonymized = None, True  # ученик уже удалён — не связываем
    await session.execute(
        insert(TicketRef)
        .values(ticket_id=ticket_id, number=number, user_id=user_id, status=status, status_at=at,
                anonymized=explicitly_anonymized)
        .on_conflict_do_nothing()  # и повтор ticket_id, и чужой ticket_id с тем же номером
    )
    ref = (await session.execute(
        select(TicketRef).where(TicketRef.ticket_id == ticket_id).with_for_update()
        .execution_options(populate_existing=True)
    )).scalar_one_or_none()
    if ref is None:
        # Номер уже занят другим обращением (в support номера уникальны — так бывает только после пересоздания БД
        # support на стенде). Не «ядовитое» сообщение: пропускаем с предупреждением, без бесконечных повторов.
        log.warning("ticket number collision, event skipped", extra={"event_type": env.event_type})
        return DONE
    affected = {ref.user_id, user_id}
    if explicitly_anonymized and not ref.anonymized:
        ref.user_id = None
        ref.anonymized = True
    elif ref.user_id is None and user_id is not None and not ref.anonymized:
        ref.user_id = user_id
    if _newer(at, ref.status_at):
        ref.status = status
        ref.status_at = at
    await session.flush()
    for uid in affected:
        await refresh_ticket_counters(session, uid)
    return DONE


# ---------------------------------------------------------------- снимки источников

async def apply_snapshot(session: AsyncSession, snap: IdentitySnapshot, *, read_at: datetime) -> LearnerSummary:
    """Authoritative-снимок identity-consent. Версия — users.updated_at источника: событие новее снимка не
    затирается, событие старше — уже учтено в снимке."""
    v = snap.updated_at.astimezone(UTC)
    row = await lock_summary(session, snap.user_id, created_at=snap.created_at)
    row.refreshed_at = read_at
    if row.erased_at is not None:
        return row
    if not row.profile_known:
        row.created_at = snap.created_at  # см. _apply_profile_created: дальше не меняется
        row.profile_known = True
    if snap.status == "DELETED":
        await apply_status(session, row, "DELETED", v, force=True)
        return row
    if _newer(v, row.source_updated_at):
        row.kind = snap.kind
        row.guardian_user_id = snap.guardian_user_id
        row.display_name = snap.display_name
        row.username = snap.username
        row.telegram_id_masked = snap.telegram_id_masked
        row.search_text = search_text(snap.display_name, snap.username)
        row.source_updated_at = v
    if _newer(v, row.profile_at):
        row.locale = snap.locale
        row.age_band = snap.age_band
        row.guardian_consent = snap.guardian_consent
        row.profile_at = v
    await apply_status(session, row, snap.status, v)
    if _newer(v, row.consent_at):
        c = snap.consent
        row.consent = {"policy_version": c.policy_version, "purposes": list(c.purposes),
                       "accepted_at": _iso(c.accepted_at), "revoked_at": _iso(c.revoked_at), "basis": c.basis}
        row.consent_at = v
    security = dict(row.security)
    if _newer(v, row.pin_at):
        security["pin_enabled"], row.pin_at = snap.security.pin_enabled, v
    if _newer(v, row.pin_reset_at):
        security["pin_reset_pending"], row.pin_reset_at = snap.security.pin_reset_pending, v
    row.security = security
    if snap.notifications is not None and _newer(v, row.notifications_at):
        row.notifications = snap.notifications.as_json()
        row.notifications_at = v
    return row


async def apply_plan_snapshot(session: AsyncSession, snap: PlanSnapshot, *, read_at: datetime) -> LearnerSummary:
    """Authoritative-снимок плана learning-plan (версия — plans.updated_at)."""
    v = snap.updated_at.astimezone(UTC)
    row = await lock_summary(session, snap.user_id, created_at=read_at)
    if row.erased_at is not None or not _newer(v, row.plan_at):
        return row
    schedule = snap.schedule.model_dump() if snap.schedule is not None else None
    _set_plan(row, {"goal": snap.goal, "level_self": snap.level_self, "ui_lang": snap.ui_lang, "schedule": schedule,
                    "onboarding_completed_at": _iso(snap.onboarding_completed_at), "updated_at": _iso(v)}, v)
    return row
