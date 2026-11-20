"""Обзор игры в админке (§1.11 GET /overview, admin.ts GameOverview): итоги 7 и 30 дней из обезличенной
daily_stats (по дням ученика), активная версия правил, активные события недели."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_gamification.domain.common import AUDIENCES, iso, local_date, zone
from tilhero_gamification.domain.engine import events_active
from tilhero_gamification.domain.rules import active_rules
from tilhero_gamification.models import DailyStat


async def overview(session: AsyncSession, period: str, now: datetime, tz_name: str) -> dict[str, Any]:
    days = 7 if period == "7d" else 30
    today = local_date(now, zone(tz_name, "Asia/Tashkent"))
    since = today - timedelta(days=days - 1)
    rows = (await session.execute(select(DailyStat.audience, DailyStat.metric, func.sum(DailyStat.value))
                                  .where(DailyStat.local_date >= since, DailyStat.local_date <= today)
                                  .group_by(DailyStat.audience, DailyStat.metric))).all()
    by: dict[str, dict[str, int]] = {a: {} for a in AUDIENCES}
    total: dict[str, int] = {}
    for audience, metric, value in rows:
        by.setdefault(audience, {})[metric] = int(value or 0)
        total[metric] = total.get(metric, 0) + int(value or 0)
    rules = await active_rules(session)
    events = await events_active(session, now, None)
    return {
        "period": period, "active_rules_version": rules.version,
        "earned": {"xp": total.get("earned_xp", 0), "til": total.get("earned_til", 0)},
        "spent_til": total.get("spent_til", 0),
        "freezes": {"granted": total.get("freezes_granted", 0), "bought": total.get("freezes_bought", 0),
                    "used": total.get("freezes_used", 0)},
        "quests_completed": total.get("quests_completed", 0), "badges_earned": total.get("badges_earned", 0),
        "purchases": total.get("purchases", 0),
        "by_audience": [{"audience": a, "earned_xp": by[a].get("earned_xp", 0),
                         "earned_til": by[a].get("earned_til", 0),
                         "quests_completed": by[a].get("quests_completed", 0)} for a in AUDIENCES],
        "active_events": [{"event_id": str(e.event_id), "title": e.title, "ends_at": iso(e.ends_at)} for e in events],
    }
