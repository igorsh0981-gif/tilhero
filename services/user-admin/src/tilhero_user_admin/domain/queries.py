"""Чтение read-модели: поиск со фильтрами и курсором, карточка, статистика (без FastAPI)."""

from __future__ import annotations

import base64
import json
import re
import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import Select, and_, false, func, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import bad_request, unprocessable
from tilhero_user_admin.domain.projection import LEVEL_CODE, STATUSES, ticket_number
from tilhero_user_admin.models import TicketRef, UserSummary
from tilhero_user_admin.schemas import (
    AccessLevelView,
    AdminUserCard,
    AdminUserRow,
    CardConsent,
    CardPreferences,
    CardSecurity,
    UserStats,
)

_USERNAME_CHARS = re.compile(r"^[A-Za-z0-9_]{1,64}$")


# ---------------------------------------------------------------- представления

def access_level_view(r: UserSummary, now: datetime) -> AccessLevelView:
    """Действующий уровень: ручное назначение, если не истекло (истечение ai-control событием не сообщает — срок
    сравнивается здесь); иначе — уровень по умолчанию (код известен, только если пришло событие сброса)."""
    if r.access_level_source == "manual" and (r.access_level_expires_at is None or r.access_level_expires_at > now):
        return AccessLevelView(level=r.access_level, source="manual", expires_at=r.access_level_expires_at)
    level = r.access_level if r.access_level_source == "default" else None
    return AccessLevelView(level=level, source="default", expires_at=None)


def row_view(r: UserSummary, now: datetime | None = None) -> AdminUserRow:
    return AdminUserRow(
        user_id=r.user_id,
        username=r.username,
        display_name=r.display_name,
        telegram_id_masked=r.telegram_id_masked,
        locale=r.locale,
        status=r.status,  # type: ignore[arg-type]
        onboarding_completed=r.onboarding_completed,
        open_tickets=r.open_tickets,
        tickets_total=r.tickets_total,
        created_at=r.created_at,
        last_seen_at=r.last_seen_at,
        access_level=access_level_view(r, now or datetime.now(UTC)),
        deletion_stuck_at=r.deletion_stuck_at,
    )


def card_view(r: UserSummary, refreshed_at: datetime, now: datetime | None = None) -> AdminUserCard:
    return AdminUserCard(
        **row_view(r, now).model_dump(),
        consent=CardConsent(
            policy_version=r.consent_policy_version,
            purposes=list(r.consent_purposes or []),
            accepted_at=r.consent_accepted_at,
            age_confirmed_18_plus=r.age_confirmed_18_plus,
            revoked_at=r.consent_revoked_at,
        ),
        security=CardSecurity(pin_enabled=r.pin_enabled, biometric_enabled=r.biometric_enabled),
        preferences=CardPreferences(
            onboarding_completed=r.onboarding_completed,
            updated_at=r.preferences_updated_at,
            changed_fields=list(r.preferences_changed_fields or []),
        ),
        refreshed_at=refreshed_at,
    )


# ---------------------------------------------------------------- список

def _encode_cursor(created_at: datetime, user_id: uuid.UUID) -> str:
    raw = json.dumps({"c": created_at.astimezone(UTC).isoformat(), "u": str(user_id)}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        data = json.loads(base64.urlsafe_b64decode((cursor + "=" * (-len(cursor) % 4)).encode()).decode())
        created = datetime.fromisoformat(str(data["c"]))
        if created.tzinfo is None:
            raise ValueError("naive")
        return created, uuid.UUID(str(data["u"]))
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


def _like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def parse_statuses(raw: str | None) -> list[str] | None:
    if raw is None or raw.strip() in ("", "all"):
        return None
    values = [v.strip().upper() for v in raw.split(",") if v.strip()]
    bad = [v for v in values if v not in STATUSES]
    if bad:
        raise unprocessable("USER_FILTER_INVALID", "Неизвестный статус в фильтре", {"status": bad[:5]})
    return values


def parse_access_levels(raw: str | None) -> list[str] | None:
    """`access_level=plus[,vip]` — коды уровней (≤ 10) действующих ручных назначений."""
    if raw is None or not raw.strip():
        return None
    values = list(dict.fromkeys(v.strip() for v in raw.split(",") if v.strip()))
    bad = [v for v in values if not LEVEL_CODE.match(v)]
    if bad or len(values) > 10:
        raise unprocessable("USER_FILTER_INVALID", "Некорректный уровень доступа в фильтре",
                            {"access_level": bad[:5] or values[:5]})
    return values


def apply_access_filter(stmt: Select, *, levels: list[str] | None, source: str | None, now: datetime) -> Select:
    """Фильтр по действующему уровню: `levels` — ручные назначения с этими кодами, не истёкшие; `source=manual` —
    любое действующее ручное назначение; `source=default` — без действующего ручного назначения (уровень по
    умолчанию, в том числе без событий и с истёкшим сроком)."""
    active_manual = and_(UserSummary.access_level_source == "manual",
                         or_(UserSummary.access_level_expires_at.is_(None), UserSummary.access_level_expires_at > now))
    if levels:
        stmt = stmt.where(active_manual, UserSummary.access_level.in_(levels))
    if source == "manual":
        stmt = stmt.where(active_manual)
    elif source == "default":
        # не NOT(active_manual): при access_level_source IS NULL (событий не было) он дал бы NULL и потерял строку
        stmt = stmt.where(or_(UserSummary.access_level_source.is_distinct_from("manual"),
                              and_(UserSummary.access_level_expires_at.is_not(None),
                                   UserSummary.access_level_expires_at <= now)))
    return stmt


def apply_query(stmt: Select, q: str | None) -> Select:
    """q: UUID пользователя | @username (префикс) | TCK-номер (→ владелец обращения) | часть имени или username."""
    if q is None or not q.strip():
        return stmt
    q = q.strip()
    try:
        return stmt.where(UserSummary.user_id == uuid.UUID(q))
    except ValueError:
        pass
    number = ticket_number(q)
    if number is not None:
        owner = select(TicketRef.user_id).where(TicketRef.number == number, TicketRef.user_id.is_not(None))
        return stmt.where(UserSummary.user_id.in_(owner.scalar_subquery()))
    if q.startswith("@"):
        name = q[1:]
        if not _USERNAME_CHARS.match(name):
            return stmt.where(false())  # такого username быть не может
        return stmt.where(func.lower(UserSummary.username).like(_like_escape(name.lower()) + "%", escape="\\"))
    pattern = "%" + _like_escape(q) + "%"
    return stmt.where(or_(UserSummary.display_name.ilike(pattern, escape="\\"),
                          UserSummary.username.ilike(pattern, escape="\\")))


async def list_users(
    session: AsyncSession,
    *,
    q: str | None,
    statuses: list[str] | None,
    locale: str | None,
    has_open_tickets: bool | None,
    limit: int,
    cursor: str | None,
    access_levels: list[str] | None = None,
    access_level_source: str | None = None,
    now: datetime | None = None,
) -> tuple[list[UserSummary], str | None]:
    # Строка, созданная событием другого домена раньше профиля (profile_known=false), в списке не показывается:
    # до первого user.profile.created.v1 или снимка identity-consent о пользователе ничего достоверного не известно.
    stmt = apply_query(select(UserSummary).where(UserSummary.profile_known), q)
    if statuses:
        stmt = stmt.where(UserSummary.status.in_(statuses))
    if locale:
        stmt = stmt.where(UserSummary.locale == locale)
    if has_open_tickets is True:
        stmt = stmt.where(UserSummary.open_tickets > 0)
    elif has_open_tickets is False:
        stmt = stmt.where(UserSummary.open_tickets == 0)
    stmt = apply_access_filter(stmt, levels=access_levels, source=access_level_source, now=now or datetime.now(UTC))
    if cursor:
        created, uid = _decode_cursor(cursor)
        stmt = stmt.where(tuple_(UserSummary.created_at, UserSummary.user_id) < tuple_(created, uid))
    stmt = stmt.order_by(UserSummary.created_at.desc(), UserSummary.user_id.desc()).limit(limit + 1)
    rows = list((await session.execute(stmt)).scalars().all())
    nxt = _encode_cursor(rows[limit - 1].created_at, rows[limit - 1].user_id) if len(rows) > limit else None
    return rows[:limit], nxt


# ---------------------------------------------------------------- статистика

def period_start(period: str, now: datetime, tz_name: str) -> datetime:
    if period == "today":
        local = now.astimezone(ZoneInfo(tz_name))
        return local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    return now - timedelta(days=7 if period == "7d" else 30)


async def stats(session: AsyncSession, *, since: datetime, today: datetime | None = None) -> UserStats:
    """total — все неудалённые; new_in_period — профили, созданные с начала периода (включая позже удалённые);
    onboarding_completed_pct — доля завершивших онбординг среди неудалённых, 1 знак.
    Спринт 8: active_in_period / active_today — неудалённые с `last_seen_at` ≥ начала периода / начала сегодняшнего
    дня (`today`, по умолчанию — `since`); `last_seen_at` — вход в Mini App (синхронизация с identity-consent)."""
    by_status = {s: 0 for s in STATUSES}
    for status, count in (await session.execute(
        select(UserSummary.status, func.count()).where(UserSummary.profile_known).group_by(UserSummary.status)
    )).all():
        by_status[status] = int(count)
    alive = UserSummary.status != "DELETED"
    total, onboarded = (await session.execute(
        select(func.count().filter(alive), func.count().filter(alive, UserSummary.onboarding_completed))
        .where(UserSummary.profile_known)
    )).one()
    new_in_period = (await session.execute(
        select(func.count()).where(UserSummary.created_at >= since, UserSummary.profile_known)
    )).scalar_one()
    pct = round(100.0 * int(onboarded) / int(total), 1) if total else 0.0
    today = since if today is None else today
    active, active_today = (await session.execute(
        select(func.count().filter(UserSummary.last_seen_at >= since),
               func.count().filter(UserSummary.last_seen_at >= today))
        .where(UserSummary.profile_known, alive, UserSummary.last_seen_at >= min(since, today))
    )).one()
    return UserStats(total=int(total), new_in_period=int(new_in_period), onboarding_completed_pct=pct,
                     by_status=by_status, active_in_period=int(active),  # type: ignore[arg-type]
                     active_today=int(active_today))
