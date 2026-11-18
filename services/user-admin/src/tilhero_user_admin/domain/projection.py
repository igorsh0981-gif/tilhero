"""Проекция admin_user_summary из событий и снимков identity-consent (без FastAPI).

Правила:
- каждое событие применяется ровно один раз (inbox — в Runtime.add_consumer);
- порядок доставки не гарантирован: у каждой группы полей своя версия (момент события или `updated_at` снимка),
  событие старше версии ничего не меняет (`_newer`);
- DELETED — конечный статус: после него username/имя стёрты, связь с обращениями разорвана, ничто не возвращает
  пользователя в другой статус;
- события принимаются только от домена-владельца (иначе — предупреждение без данных, событие отмечено в inbox).
PII (username, имя) в логи не попадает: в логах только тип события и псевдонимы.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import Envelope
from tilhero_user_admin.models import MASK_NONE, OPEN_TICKET_STATUSES, TICKET_STATUSES, TicketRef, UserSummary
from tilhero_user_admin.schemas import IdentitySnapshot

log = logging.getLogger("tilhero.user_admin.projection")

IDENTITY = "identity-consent"
EV_PROFILE_CREATED = "user.profile.created.v1"
EV_STATUS_CHANGED = "user.status.changed.v1"
EV_CONSENT_ACCEPTED = "consent.accepted.v1"
EV_CONSENT_REVOKED = "consent.revoked.v1"
EV_PREFERENCES_UPDATED = "user.preferences.updated.v1"
EV_SECURITY_CHANGED = "user.security.changed.v1"
EV_DELETION_REQUESTED = "user.deletion.requested.v1"
EV_DOMAIN_DELETED = "user.domain.deleted.v1"
EV_DELETION_STUCK = "user.deletion.stuck.v1"  # спринт 9: сага удаления identity-consent (ADR-009)
EV_TICKET_CREATED = "support.ticket.created.v1"
EV_TICKET_STATUS_CHANGED = "support.ticket.status.changed.v1"
EV_ACCESS_LEVEL_CHANGED = "user.access_level.changed.v1"  # спринт 7: ai-control (§2.7)

# Производитель-владелец каждого события (ревью P4: чужой издатель не может переписать read-модель)
PRODUCERS: dict[str, str] = {
    EV_PROFILE_CREATED: IDENTITY,
    EV_STATUS_CHANGED: IDENTITY,
    EV_CONSENT_ACCEPTED: IDENTITY,
    EV_CONSENT_REVOKED: IDENTITY,
    EV_SECURITY_CHANGED: IDENTITY,
    EV_DELETION_REQUESTED: IDENTITY,
    EV_DOMAIN_DELETED: IDENTITY,
    EV_DELETION_STUCK: IDENTITY,
    EV_PREFERENCES_UPDATED: "preferences",
    EV_TICKET_CREATED: "support",
    EV_TICKET_STATUS_CHANGED: "support",
    EV_ACCESS_LEVEL_CHANGED: "ai-control",
}
EVENT_TYPES = list(PRODUCERS)

STATUSES = ("ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED")
_TCK = re.compile(r"^TCK-(\d{1,12})$")
LEVEL_CODE = re.compile(r"^[a-z][a-z0-9_]{1,31}$")
ACCESS_SOURCES = ("default", "manual")


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
            parsed = datetime.fromisoformat(value)
            if parsed.tzinfo is not None:
                return parsed.astimezone(UTC)
        except ValueError:
            pass
    return None


def _ts(value: Any, default: datetime) -> datetime:
    parsed = _aware(value)
    return default if parsed is None else parsed


def ticket_number(value: Any) -> int | None:
    m = _TCK.match(str(value or "").strip().upper())
    return int(m.group(1)) if m else None


# ---------------------------------------------------------------- строки и счётчики

async def lock_summary(session: AsyncSession, user_id: uuid.UUID, *, created_at: datetime) -> tuple[UserSummary, bool]:
    """Строка пользователя под FOR UPDATE (создаётся при первом упоминании). → (строка, создана сейчас)."""
    inserted = (
        await session.execute(
            insert(UserSummary)
            .values(user_id=user_id, created_at=created_at, status="ACTIVE")
            .on_conflict_do_nothing(index_elements=[UserSummary.user_id])
            .returning(UserSummary.user_id)
        )
    ).first()
    row = (
        await session.execute(
            select(UserSummary)
            .where(UserSummary.user_id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    if inserted is not None:
        await refresh_ticket_counters(session, user_id)
    return row, inserted is not None


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
        update(UserSummary)
        .where(UserSummary.user_id == user_id)
        .values(open_tickets=int(open_count), tickets_total=int(total))
        .execution_options(synchronize_session="fetch")
    )


async def erase(session: AsyncSession, row: UserSummary, at: datetime) -> None:
    """Удаление завершено (TG-FR-006): стираем PII копии и связь с обращениями."""
    # уровень доступа — данные пользователя (сага удаления ai-control удаляет назначение): в read-модели не остаётся.
    # Очищается до смены статуса: UPDATE ticket_refs ниже делает autoflush (CHECK ck_summary_deleted_access_level)
    row.access_level = None
    row.access_level_source = None
    row.access_level_expires_at = None
    row.access_level_version = None
    row.deletion_stuck_at = None  # удаление завершено — «зависло» больше не актуально (CHECK ck_summary_deleted_stuck)
    row.status = "DELETED"
    row.status_at = max(at, row.status_at) if row.status_at else at
    row.username = None
    row.display_name = None
    row.telegram_id_masked = MASK_NONE
    if row.erased_at is None:
        row.erased_at = utcnow()
    await session.execute(
        update(TicketRef)
        .where(TicketRef.user_id == row.user_id)
        .values(user_id=None, anonymized=True)
        .execution_options(synchronize_session=False)
    )
    row.open_tickets = 0
    row.tickets_total = 0


async def apply_status(
    session: AsyncSession, row: UserSummary, status: str, at: datetime, *, force: bool = False
) -> None:
    if status not in STATUSES:
        return
    if row.status == "DELETED" and row.erased_at is not None:
        return  # конечный статус
    if status == "DELETED":
        if force or _newer(at, row.status_at):
            await erase(session, row, at)
        return
    if _newer(at, row.status_at):
        row.status = status
        row.status_at = at


# ---------------------------------------------------------------- события

async def apply_event(session: AsyncSession, env: Envelope) -> bool:
    """→ True, если событие относится к read-модели и применено (или осознанно пропущено как устаревшее)."""
    owner = PRODUCERS.get(env.event_type)
    if owner is None:
        return False
    p = env.payload or {}
    if env.event_type == EV_DOMAIN_DELETED and p.get("domain") != IDENTITY:
        return False  # ACK других доменов не относятся к профилю (identity-consent пришлёт свой после всех)
    if env.producer != owner:
        log.warning("event from unexpected producer ignored",
                    extra={"event_type": env.event_type, "producer": env.producer[:64]})
        return False
    at = env.occurred_at.astimezone(UTC)
    if env.event_type in (EV_TICKET_CREATED, EV_TICKET_STATUS_CHANGED):
        return await _apply_ticket(session, env, at)
    user_id = _uuid(p.get("user_id"))
    if user_id is None:
        log.warning("event without valid user_id ignored", extra={"event_type": env.event_type})
        return False
    created_hint = _ts(p.get("created_at"), at) if env.event_type == EV_PROFILE_CREATED else at
    row, _ = await lock_summary(session, user_id, created_at=created_hint)
    if row.erased_at is not None:
        return True  # удалён: поздние события ничего не возвращают

    match env.event_type:
        case "user.profile.created.v1":
            if not row.profile_known:  # см. apply_snapshot: created_at неизменен после profile_known
                row.created_at = created_hint
                row.profile_known = True
            locale = p.get("locale")
            if isinstance(locale, str) and row.identity_version is None:
                row.locale = locale[:8]
            if row.status_at is None:
                row.status_at = at  # профиль создан ACTIVE; любое более позднее событие статуса победит
        case "user.status.changed.v1":
            await apply_status(session, row, str(p.get("status")), at)
        case "user.deletion.requested.v1":
            await apply_status(session, row, "DELETION_REQUESTED", at)
        case "user.deletion.stuck.v1":
            # «удаление зависло» (колонка админки): запрос удаления открыт дольше DELETION_STUCK_HOURS
            await apply_status(session, row, "DELETION_REQUESTED", at)
            if row.status == "DELETION_REQUESTED":
                row.deletion_stuck_at = _ts(p.get("stuck_at"), at)
        case "user.domain.deleted.v1":
            await apply_status(session, row, "DELETED", at, force=True)
        case "consent.accepted.v1":
            if _newer(at, row.consent_at):
                row.consent_policy_version = str(p.get("policy_version") or "")[:20] or None
                row.consent_purposes = [str(x)[:32] for x in (p.get("purposes") or [])][:20]
                row.consent_accepted_at = at
                row.consent_revoked_at = None
                row.age_confirmed_18_plus = p.get("age_confirmed_18_plus") is not False
                row.consent_at = at
        case "consent.revoked.v1":
            if _newer(at, row.consent_at):
                row.consent_revoked_at = at
                if p.get("policy_version"):
                    row.consent_policy_version = str(p["policy_version"])[:20]
                row.consent_at = at
        case "user.security.changed.v1":
            _apply_security(row, str(p.get("change")), at)
        case "user.access_level.changed.v1":
            _apply_access_level(row, p, env)
        case "user.preferences.updated.v1":
            if _newer(at, row.preferences_updated_at):
                row.preferences_updated_at = at
                row.preferences_changed_fields = [str(x)[:64] for x in (p.get("changed_fields") or [])][:50]
            done = p.get("onboarding_completed")
            if isinstance(done, bool) and _newer(at, row.onboarding_at):
                row.onboarding_completed = done
                row.onboarding_at = at
    return True


def _apply_access_level(row: UserSummary, p: dict[str, Any], env: Envelope) -> None:
    """Назначение уровня (ai-control). Порядок — по `version` назначения (монотонна на пользователя): старая или та же
    версия ничего не меняет. Битый payload — предупреждение без данных (событие отмечено в inbox, не «ядовитое»)."""
    level, source, version = p.get("level"), p.get("source"), p.get("version")
    raw_expires = p.get("expires_at")
    expires = None if raw_expires is None else _aware(raw_expires)
    valid = (isinstance(level, str) and LEVEL_CODE.match(level) is not None and source in ACCESS_SOURCES
             and isinstance(version, int) and not isinstance(version, bool) and version >= 1
             and (raw_expires is None or expires is not None) and (expires is None or source == "manual"))
    if not valid or not isinstance(version, int):  # isinstance — сужение типа для mypy (уже проверено в valid)
        log.warning("access level event with invalid payload ignored", extra={"event_type": env.event_type})
        return
    if row.access_level_version is not None and version <= row.access_level_version:
        return  # устаревшее или повтор
    row.access_level = level
    row.access_level_source = source
    row.access_level_expires_at = expires
    row.access_level_version = version


def _apply_security(row: UserSummary, change: str, at: datetime) -> None:
    pin: bool | None = None
    bio: bool | None = None
    if change in ("pin_set", "pin_changed", "pin_reset"):
        pin = True
    elif change == "pin_removed":
        pin, bio = False, False  # биометрия без PIN не существует
    elif change == "biometric_enabled":
        bio = True
    elif change == "biometric_disabled":
        bio = False
    if pin is not None and _newer(at, row.pin_at):
        row.pin_enabled, row.pin_at = pin, at
    if bio is not None and _newer(at, row.biometric_at):
        row.biometric_enabled, row.biometric_at = bio, at


async def _apply_ticket(session: AsyncSession, env: Envelope, at: datetime) -> bool:
    p = env.payload or {}
    ticket_id = _uuid(p.get("ticket_id"))
    number = ticket_number(p.get("number"))
    if ticket_id is None or number is None:
        log.warning("ticket event without valid id/number ignored", extra={"event_type": env.event_type})
        return False
    status = "NEW" if env.event_type == EV_TICKET_CREATED else str(p.get("to_status"))
    if status not in TICKET_STATUSES:
        return False
    user_id = _uuid(p.get("user_id"))
    explicitly_anonymized = env.event_type == EV_TICKET_STATUS_CHANGED and "user_id" in p and p["user_id"] is None
    if user_id is not None:
        owner = (await session.execute(
            select(UserSummary.erased_at).where(UserSummary.user_id == user_id)
        )).first()
        if owner is not None and owner.erased_at is not None:
            user_id, explicitly_anonymized = None, True  # пользователь уже удалён — не связываем
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
        return True
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
    return True


# ---------------------------------------------------------------- снимок identity-consent

async def apply_snapshot(session: AsyncSession, snap: IdentitySnapshot, *, read_at: datetime) -> UserSummary:
    """Authoritative-снимок профиля. Версия — users.updated_at источника: событие новее снимка не затирается,
    событие старше — уже учтено в снимке."""
    v = snap.updated_at.astimezone(UTC)
    row, _ = await lock_summary(session, snap.user_id, created_at=snap.created_at)
    row.refreshed_at = read_at
    if row.erased_at is not None:
        return row
    if not row.profile_known:
        # created_at — ключ сортировки и курсора списка: фиксируется один раз, когда профиль подтверждён (снимком или
        # user.profile.created.v1), и дальше не меняется — иначе курсорная пагинация даёт пропуски и дубли.
        # До этого строка в список не попадает (queries.list_users: profile_known).
        row.created_at = snap.created_at
        row.profile_known = True
    if snap.status == "DELETED":
        await apply_status(session, row, "DELETED", v, force=True)
        return row
    if _newer(v, row.identity_version):
        row.username = snap.username
        row.display_name = snap.display_name
        row.telegram_id_masked = snap.telegram_id_masked
        row.locale = snap.locale
        row.last_seen_at = snap.last_seen_at
        row.identity_version = v
    await apply_status(session, row, snap.status, v)
    if _newer(v, row.consent_at):
        c = snap.consent
        row.consent_policy_version = c.policy_version
        row.consent_purposes = [p[:32] for p in c.purposes]
        row.consent_accepted_at = c.accepted_at
        row.consent_revoked_at = c.revoked_at
        row.age_confirmed_18_plus = c.age_confirmed_18_plus
        row.consent_at = v
    if _newer(v, row.pin_at):
        row.pin_enabled, row.pin_at = snap.security.pin_enabled, v
    if _newer(v, row.biometric_at):
        row.biometric_enabled, row.biometric_at = snap.security.biometric_enabled, v
    return row
