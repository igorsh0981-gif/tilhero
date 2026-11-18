"""Чтение read-модели: поиск с фильтрами и курсором, карточка, статистика дашборда (без FastAPI)."""

from __future__ import annotations

import base64
import json
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import ColumnElement, Select, and_, false, func, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from tilhero_common.errors import bad_request, unprocessable
from tilhero_user_admin.domain.projection import ticket_number
from tilhero_user_admin.models import (
    AGE_BANDS,
    EMPTY_CONSENT,
    EMPTY_SECURITY,
    LOCALES,
    STATUSES,
    LearnerSummary,
    TicketRef,
)
from tilhero_user_admin.schemas import (
    AdminLearnerCard,
    AdminLearnerPlan,
    AdminLearnerRow,
    CardConsent,
    CardNotifications,
    CardSecurity,
    DashboardLearners,
)

_USERNAME_CHARS = re.compile(r"^[A-Za-z0-9_]{1,64}$")
L = LearnerSummary


# ---------------------------------------------------------------- представления

def children_count_expr() -> ColumnElement[int]:
    """Число действующих детских профилей аккаунта — считается при чтении (индекс ix_learner_guardian), без
    денормализованного счётчика, который пришлось бы блокировать вместе со строкой ребёнка."""
    child = aliased(LearnerSummary)
    return (
        select(func.count())
        .where(child.guardian_user_id == L.user_id, child.kind == "child", child.profile_known,
               child.status != "DELETED")
        .correlate(L)
        .scalar_subquery()
    )


def row_view(r: LearnerSummary, children_count: int = 0) -> AdminLearnerRow:
    return AdminLearnerRow(
        user_id=r.user_id,
        kind=r.kind,  # type: ignore[arg-type]  # CHECK ck_learner_kind
        guardian_user_id=r.guardian_user_id,
        display_name=r.display_name,
        username=r.username,
        telegram_id_masked=r.telegram_id_masked,
        locale=r.locale,  # type: ignore[arg-type]  # CHECK ck_learner_locale
        age_band=r.age_band,  # type: ignore[arg-type]  # CHECK ck_learner_age_band
        guardian_consent=r.guardian_consent,  # type: ignore[arg-type]  # CHECK ck_learner_guardian_consent
        status=r.status,  # type: ignore[arg-type]  # CHECK ck_learner_status
        onboarding_completed=r.onboarding_completed,
        goal=r.goal,  # type: ignore[arg-type]  # CHECK ck_learner_goal
        reminders_enabled=r.reminders_enabled,
        children_count=children_count if r.kind == "account" else 0,
        open_tickets=r.open_tickets,
        tickets_total=r.tickets_total,
        created_at=r.created_at,
        last_activity_at=r.last_activity_at,
    )


def card_view(r: LearnerSummary, *, children: list[AdminLearnerRow], guardian: AdminLearnerRow | None,
              refreshed_at: datetime) -> AdminLearnerCard:
    consent: dict[str, Any] = {**EMPTY_CONSENT, **(r.consent or {})}
    security: dict[str, Any] = {**EMPTY_SECURITY, **(r.security or {})}
    return AdminLearnerCard(
        **row_view(r, len(children)).model_dump(),
        consent=CardConsent.model_validate(consent),
        security=CardSecurity.model_validate(security),
        notifications=CardNotifications.model_validate(r.notifications) if r.notifications else None,
        plan=AdminLearnerPlan.model_validate(r.plan) if r.plan else None,
        children=children if r.kind == "account" else [],
        guardian=guardian if r.kind == "child" else None,
        refreshed_at=refreshed_at,
    )


async def load_card_relations(session: AsyncSession, r: LearnerSummary
                              ) -> tuple[list[AdminLearnerRow], AdminLearnerRow | None]:
    """Детские профили аккаунта (кроме удалённых, старые первыми) или опекун детского профиля."""
    if r.kind == "account":
        rows = (await session.execute(
            select(L, children_count_expr())
            .where(L.guardian_user_id == r.user_id, L.kind == "child", L.profile_known, L.status != "DELETED")
            .order_by(L.created_at, L.user_id)
        )).all()
        return [row_view(c, int(n)) for c, n in rows], None
    if r.guardian_user_id is None:
        return [], None
    found = (await session.execute(
        select(L, children_count_expr()).where(L.user_id == r.guardian_user_id, L.profile_known)
    )).first()
    return [], (row_view(found[0], int(found[1])) if found else None)


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


def like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _csv(raw: str | None) -> list[str] | None:
    if raw is None or raw.strip() in ("", "all"):
        return None
    return list(dict.fromkeys(v.strip() for v in raw.split(",") if v.strip())) or None


def parse_statuses(raw: str | None) -> list[str] | None:
    values = _csv(raw)
    if values is None:
        return None
    values = [v.upper() for v in values]
    bad = [v for v in values if v not in STATUSES]
    if bad:
        raise unprocessable("LEARNER_FILTER_INVALID", "Неизвестный статус в фильтре", {"status": bad[:5]})
    return values


def parse_age_bands(raw: str | None) -> list[str] | None:
    """`age_band=6-9,14-17` (+ `unknown` — возраст не выбран). «18+» без %2B приходит как «18 » — принимается."""
    values = _csv(raw)
    if values is None:
        return None
    values = ["18+" if v == "18" else v for v in values]
    bad = [v for v in values if v not in (*AGE_BANDS, "unknown")]
    if bad:
        raise unprocessable("LEARNER_FILTER_INVALID", "Неизвестная возрастная группа в фильтре",
                            {"age_band": bad[:5]})
    return values


def apply_query(stmt: Select, q: str | None, *, can_search_tickets: bool) -> Select:
    """q: UUID ученика | @username (префикс) | TCK-номер (→ автор обращения; только с правом support.read) |
    часть имени или username (ILIKE по search_text, `%`/`_` — литералы)."""
    if q is None or not q.strip():
        return stmt
    q = q.strip()
    try:
        return stmt.where(L.user_id == uuid.UUID(q))
    except ValueError:
        pass
    number = ticket_number(q)
    if number is not None:
        if not can_search_tickets:
            return stmt.where(false())  # без support.read поиск по номеру обращения не выполняется
        owner = select(TicketRef.user_id).where(TicketRef.number == number, TicketRef.user_id.is_not(None))
        return stmt.where(L.user_id.in_(owner.scalar_subquery()))
    if q.startswith("@"):
        name = q[1:]
        if not _USERNAME_CHARS.match(name):
            return stmt.where(false())  # такого username быть не может
        return stmt.where(func.lower(L.username).like(like_escape(name.lower()) + "%", escape="\\"))
    return stmt.where(L.search_text.ilike("%" + like_escape(q.lower()) + "%", escape="\\"))


async def list_learners(
    session: AsyncSession,
    *,
    q: str | None,
    kind: str | None,
    age_bands: list[str] | None,
    statuses: list[str] | None,
    locale: str | None,
    has_open_tickets: bool | None,
    limit: int,
    cursor: str | None,
    can_search_tickets: bool,
) -> tuple[list[AdminLearnerRow], str | None]:
    # Строка, созданная событием другого домена раньше профиля (profile_known=false), в списке не показывается:
    # до первого user.profile.created.v1 или снимка identity-consent о ученике ничего достоверного не известно.
    stmt = apply_query(select(L, children_count_expr()).where(L.profile_known), q,
                       can_search_tickets=can_search_tickets)
    if kind:
        stmt = stmt.where(L.kind == kind)
    if age_bands:
        known = [b for b in age_bands if b != "unknown"]
        conds = [L.age_band.in_(known)] if known else []
        if "unknown" in age_bands:
            conds.append(L.age_band.is_(None))
        stmt = stmt.where(or_(*conds))
    if statuses:
        stmt = stmt.where(L.status.in_(statuses))
    if locale:
        stmt = stmt.where(L.locale == locale)
    if has_open_tickets is True:
        stmt = stmt.where(L.open_tickets > 0)
    elif has_open_tickets is False:
        stmt = stmt.where(L.open_tickets == 0)
    if cursor:
        created, uid = _decode_cursor(cursor)
        stmt = stmt.where(tuple_(L.created_at, L.user_id) < tuple_(created, uid))
    stmt = stmt.order_by(L.created_at.desc(), L.user_id.desc()).limit(limit + 1)
    rows = (await session.execute(stmt)).all()
    nxt = _encode_cursor(rows[limit - 1][0].created_at, rows[limit - 1][0].user_id) if len(rows) > limit else None
    return [row_view(r, int(n)) for r, n in rows[:limit]], nxt


# ---------------------------------------------------------------- статистика

def period_start(period: str, now: datetime, tz_name: str) -> datetime:
    if period == "today":
        local = now.astimezone(ZoneInfo(tz_name))
        return local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    return now - timedelta(days=7 if period == "7d" else 30)


def _pct(part: int, total: int) -> float:
    return round(100.0 * part / total, 1) if total else 0.0


async def stats(session: AsyncSession, *, since: datetime) -> DashboardLearners:
    """Действующие ученики (профиль подтверждён, не удалены):
    - total_accounts / total_children — по виду;
    - new_in_period — профили, созданные с начала периода (включая позже удалённые: это приток);
    - active_in_period — с занятием (learning.activity.recorded.v1) с начала периода;
    - onboarding_completed_pct / reminders_enabled_pct — доля среди действующих, 1 знак;
    - by_age_band / by_locale — по действующим (`unknown` — не выбран)."""
    alive = and_(L.profile_known, L.status != "DELETED")
    accounts, children, onboarded, reminders, active = (await session.execute(
        select(func.count().filter(L.kind == "account"), func.count().filter(L.kind == "child"),
               func.count().filter(L.onboarding_completed), func.count().filter(L.reminders_enabled),
               func.count().filter(L.last_activity_at >= since))
        .where(alive)
    )).one()
    new_in_period = (await session.execute(
        select(func.count()).where(L.profile_known, L.created_at >= since)
    )).scalar_one()
    by_age = {b: 0 for b in (*AGE_BANDS, "unknown")}
    for band, count in (await session.execute(select(L.age_band, func.count()).where(alive).group_by(L.age_band))):
        by_age[band if band in AGE_BANDS else "unknown"] += int(count)
    by_locale = {lang: 0 for lang in (*LOCALES, "unknown")}
    for lang, count in (await session.execute(select(L.locale, func.count()).where(alive).group_by(L.locale))):
        by_locale[lang if lang in LOCALES else "unknown"] += int(count)
    total = int(accounts) + int(children)
    return DashboardLearners(
        total_accounts=int(accounts), total_children=int(children), new_in_period=int(new_in_period),
        active_in_period=int(active), onboarding_completed_pct=_pct(int(onboarded), total),
        reminders_enabled_pct=_pct(int(reminders), total), by_age_band=by_age, by_locale=by_locale,
    )
