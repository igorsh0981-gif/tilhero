"""Выгрузка планов для сверки read-модели админки (user-admin, INTERNAL_API §3).

Курсор — (updated_at, user_id) по возрастанию (индекс ix_plans_updated); `updated_after` — строго позже. План по
умолчанию (создан при первом чтении, без события) тоже выгружается: это действующий план ученика. Удалённых учеников
нет — их планы удалены сагой.
"""

from __future__ import annotations

import base64
import json
import uuid
from datetime import UTC, datetime

from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import bad_request
from tilhero_learning_plan.domain import schedule as sch
from tilhero_learning_plan.models import Plan
from tilhero_learning_plan.schemas import AdminPlanOut, AdminPlanPage


def encode_cursor(updated_at: datetime, user_id: uuid.UUID) -> str:
    raw = json.dumps({"t": updated_at.astimezone(UTC).isoformat(), "u": str(user_id)}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        data = json.loads(base64.urlsafe_b64decode((cursor + "=" * (-len(cursor) % 4)).encode()).decode())
        at = datetime.fromisoformat(str(data["t"]))
        if at.tzinfo is None:
            raise ValueError("naive")
        return at, uuid.UUID(str(data["u"]))
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


def admin_view(p: Plan) -> AdminPlanOut:
    return AdminPlanOut.model_validate({
        "user_id": str(p.user_id),
        "goal": p.goal,
        "level_self": p.level_self,
        "ui_lang": p.ui_lang,
        "schedule": {
            "preset": p.preset,
            "days": sorted(p.days),
            "preferred_time": sch.fmt_hhmm(p.preferred_time),
            "duration_min": p.duration_min,
            "reminders_enabled": p.reminders_enabled,
            "timezone": p.timezone,
        },
        "onboarding_completed_at": p.onboarding_completed_at,
        "updated_at": p.updated_at,
    })


async def list_plans(session: AsyncSession, *, updated_after: datetime | None, cursor: str | None,
                     limit: int) -> AdminPlanPage:
    stmt = select(Plan)
    if updated_after is not None:
        stmt = stmt.where(Plan.updated_at > updated_after)
    if cursor:
        at, uid = decode_cursor(cursor)
        stmt = stmt.where(tuple_(Plan.updated_at, Plan.user_id) > tuple_(at, uid))
    rows = list((await session.execute(
        stmt.order_by(Plan.updated_at, Plan.user_id).limit(limit + 1)
    )).scalars().all())
    nxt = encode_cursor(rows[limit - 1].updated_at, rows[limit - 1].user_id) if len(rows) > limit else None
    return AdminPlanPage(items=[admin_view(p) for p in rows[:limit]], next_cursor=nxt)
