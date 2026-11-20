"""Ответы API ученика (bff.ts «Спринт 6»): GameSummary, история операций, награды занятия, настройки мотивации.
Сводка и задания выпускают задания дня лениво (первый запрос дня) — поэтому идут в пишущей транзакции хода."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_gamification.domain import assets, badges, game_events, heroes, quests, shop, wallets
from tilhero_gamification.domain.engine import Turn, learner_audience
from tilhero_gamification.models import Ledger, Quest, SessionReward


def settings_view(turn: Turn) -> dict[str, Any]:
    lr = turn.learner
    return {"auto_freeze": bool(lr.auto_freeze), "quests_hidden": bool(lr.quests_hidden),
            "celebrations": lr.celebrations, "game_notifications": bool(lr.game_notifications)}


async def summary(session: AsyncSession, turn: Turn) -> dict[str, Any]:
    levels = turn.rules.levels
    level = int(turn.wallet.level)
    start = levels[min(level, len(levels)) - 1]
    nxt = levels[level] if level < len(levels) else None
    events = await turn.active_events()
    return {
        "level": level, "xp_total": int(turn.wallet.xp_total), "xp_level_start": start, "xp_next_level": nxt,
        "til_balance": int(turn.wallet.til_balance), "freeze_stock": int(turn.wallet.freeze_stock),
        "freeze_max": turn.rules.freeze_max, "freeze_price_til": turn.rules.freeze_price,
        "hero": await heroes.my_hero(session, turn),
        "quests": await quests.daily_view(turn),
        "events": [game_events.learner_view(e) for e in events],
        "equipment": await shop.equipment_view(session, turn),
        "settings": settings_view(turn),
        "purchase_available": False,
    }


def apply_settings(turn: Turn, changes: dict[str, Any]) -> None:
    for key in ("auto_freeze", "quests_hidden", "celebrations", "game_notifications"):
        if key in changes and changes[key] is not None:
            setattr(turn.learner, key, changes[key])
    if changes:
        turn.learner.settings_customized = True
        turn.learner.updated_at = turn.now


async def history(session: AsyncSession, turn: Turn, currency: str | None, cursor: str | None,
                  limit: int) -> dict[str, Any]:
    rows, nxt = await wallets.page(session, turn.user_id, currency=currency, cursor=cursor, limit=limit)
    return {"items": [wallets.learner_op(op) for op in rows], "next_cursor": nxt}


async def rewards(session: AsyncSession, turn: Turn, session_id: uuid.UUID) -> dict[str, Any]:
    """SessionRewards: pending — событие занятия ещё не обработано; ready — есть начисления или итоги; none —
    обработано без наград (лимит, повтор) или чужая сессия (без 403: не раскрываем существование)."""
    row = await session.get(SessionReward, (turn.user_id, session_id))
    if row is None:
        foreign = (await session.execute(select(SessionReward.user_id).where(
            SessionReward.session_id == session_id).limit(1))).first()
        return {"status": "none" if foreign else "pending", "operations": [], "level_up": None,
                "hero_stage_up": None, "badges": [], "quests_completed": []}
    linked = [uuid.UUID(x) for x in row.op_ids or []]
    ops = (await session.execute(select(Ledger).where(
        Ledger.user_id == turn.user_id,
        or_(Ledger.source_session_id == session_id, Ledger.op_id.in_(linked)) if linked
        else Ledger.source_session_id == session_id).order_by(Ledger.created_at, Ledger.op_id))).scalars().all()
    codes = [str(c) for c in row.badges]
    images = await assets.learner_images(session, await badges.template_asset_ids(session))
    badge_views = await badges.views(session, turn, images, codes=codes) if codes else []
    quest_rows = []
    for day, slot in row.quests:
        q = (await session.execute(select(Quest).where(Quest.user_id == turn.user_id,
                                                       Quest.local_date == _date(day), Quest.slot == int(slot))
                                   )).scalar_one_or_none()
        if q is not None:
            quest_rows.append(quests.quest_view(q))
    level_up = {"from": row.level_from, "to": row.level_to} if row.level_to else None
    stage_up = {"from": row.stage_from, "to": row.stage_to} if row.stage_to else None
    ready = bool(ops or level_up or stage_up or badge_views or quest_rows)
    return {"status": "ready" if ready else "none", "operations": [wallets.learner_op(o) for o in ops],
            "level_up": level_up, "hero_stage_up": stage_up, "badges": badge_views, "quests_completed": quest_rows}


def _date(value: Any) -> date:
    return date.fromisoformat(str(value))


async def badge_list(session: AsyncSession, turn: Turn) -> dict[str, Any]:
    images = await assets.learner_images(session, await badges.template_asset_ids(session))
    return {"items": await badges.views(session, turn, images)}


__all__ = ["apply_settings", "badge_list", "history", "learner_audience", "rewards", "settings_view", "summary"]
