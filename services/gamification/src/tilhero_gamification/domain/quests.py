"""Задания дня (§1.5): выпуск лениво (первый запрос дня или первое событие дня ученика), прогресс по событиям,
награда при выполнении (множитель действия `quest`, под дневным лимитом), бонус за все (slot 0, без множителя и
лимита). Выбор детерминированный: шаблоны аудитории без повторов, взвешенно, зерно sha256(user_id, день, версия).
Скрытые задания (`quests_hidden`) не выпускаются и не продвигаются. Невыполненные сгорают в полночь (tick)."""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from tilhero_gamification.domain.common import ACTIVITY_REASONS, seeded_fraction
from tilhero_gamification.domain.engine import Turn, bump
from tilhero_gamification.domain.rules import rules_by_version
from tilhero_gamification.models import Quest

BONUS_SLOT = 0


def choose(user_id: str, day: date, version: int, templates: list[dict[str, Any]], n: int) -> list[dict[str, Any]]:
    """n шаблонов без повторов, вероятность ∝ weight; один и тот же день ученика — один и тот же выбор."""
    pool = sorted(templates, key=lambda t: str(t["code"]))
    picks: list[dict[str, Any]] = []
    for i in range(min(n, len(pool))):
        total = sum(int(t["weight"]) for t in pool)
        r = seeded_fraction(user_id, day.isoformat(), version, i) * total
        acc = 0.0
        index = len(pool) - 1
        for j, t in enumerate(pool):
            acc += int(t["weight"])
            if r < acc:
                index = j
                break
        picks.append(pool.pop(index))
    return picks


async def today_quests(turn: Turn) -> list[Quest]:
    rows = (await turn.session.execute(select(Quest).where(
        Quest.user_id == turn.user_id, Quest.local_date == turn.today).order_by(Quest.slot)
        .execution_options(populate_existing=True))).scalars().all()
    return list(rows)


async def ensure_today(turn: Turn) -> list[Quest]:
    """Задания текущего дня ученика; выпускаются один раз (повтор — ON CONFLICT DO NOTHING)."""
    existing = await today_quests(turn)
    if any(q.slot >= 1 for q in existing) or turn.learner.quests_hidden or not turn.current_day:
        return existing  # прошедший день (запоздавшее событие) — только существующие задания
    cfg = turn.rules.quests
    templates = [t for t in cfg["templates"] if turn.audience in t["audiences"]]
    picks = choose(str(turn.user_id), turn.today, turn.rules.version, templates, int(cfg["per_day"]))
    for slot, t in enumerate(picks, start=1):
        await turn.session.execute(insert(Quest).values(
            user_id=turn.user_id, local_date=turn.today, slot=slot, template_code=t["code"], kind=t["kind"],
            target=int(t["target"]), progress=0, status="active", reward_xp=int(t["reward"]["xp"]),
            reward_til=int(t["reward"]["til"]), completed_at=None, rules_version=turn.rules.version,
            created_at=turn.now).on_conflict_do_nothing(index_elements=["user_id", "local_date", "slot"]))
    return await today_quests(turn)


async def advance(turn: Turn, kind: str, *, delta: int | None = None, value: int | None = None) -> None:
    """Прогресс заданий вида kind: delta — прибавить, value — выставить (xp_earned). Выполненные — награда."""
    if turn.learner.quests_hidden:
        return
    for q in await ensure_today(turn):
        if q.slot < 1 or q.kind != kind or q.status != "active":
            continue
        new = value if value is not None else q.progress + int(delta or 0)
        q.progress = max(q.progress, min(int(new), q.target))
        if q.progress >= q.target:
            await _complete(turn, q)


async def advance_xp(turn: Turn) -> None:
    """xp_earned — XP за день по операциям активностей (без заданий)."""
    if turn.learner.quests_hidden:
        return
    await advance(turn, "xp_earned", value=await turn.earned_today("xp", ACTIVITY_REASONS))


async def _complete(turn: Turn, q: Quest) -> None:
    q.status = "completed"
    q.completed_at = turn.now
    turn.effects.quests.append((q.local_date, q.slot))
    await bump(turn.session, turn.stats_day, turn.audience, "quests_completed")
    await turn.earn(reason="quest", action="quest", amounts={"xp": q.reward_xp, "til": q.reward_til},
                    key=f"quest:{turn.user_id}:{q.local_date.isoformat()}:{q.slot}",
                    source_ref=f"quest:{q.local_date.isoformat()}:{q.slot}", rules_version=q.rules_version)
    await _bonus(turn, q.local_date)


async def _bonus(turn: Turn, day: date) -> None:
    rows = (await turn.session.execute(select(Quest).where(Quest.user_id == turn.user_id, Quest.local_date == day)
                                       )).scalars().all()
    slots = [q for q in rows if q.slot >= 1]
    if not slots or any(q.status != "completed" for q in slots) or any(q.slot == BONUS_SLOT for q in rows):
        return
    version = slots[0].rules_version
    rules = await rules_by_version(turn.session, version) or turn.rules
    bonus = rules.quests["all_done_bonus"]
    turn.session.add(Quest(user_id=turn.user_id, local_date=day, slot=BONUS_SLOT, template_code="all_done",
                           kind="all_done", target=len(slots), progress=len(slots), status="completed",
                           reward_xp=int(bonus["xp"]), reward_til=int(bonus["til"]), completed_at=turn.now,
                           rules_version=version, created_at=turn.now))
    await turn.session.flush()
    for currency in ("xp", "til"):
        await turn.post(currency=currency, amount=int(bonus[currency]), reason="quest_bonus",
                        key=f"quest_bonus:{turn.user_id}:{day.isoformat()}:{currency}", source_kind="event",
                        source_ref=f"quest_bonus:{day.isoformat()}", rules_version=version)
    if int(bonus["xp"]) > 0:
        await turn.check_level()


def quest_view(q: Quest) -> dict[str, Any]:
    return {"slot": q.slot, "code": q.template_code, "kind": q.kind, "target": q.target, "progress": q.progress,
            "status": q.status, "reward": {"xp": q.reward_xp, "til": q.reward_til}}


async def daily_view(turn: Turn) -> dict[str, Any]:
    """DailyQuests (bff.ts): задания дня; скрыты — items пусто."""
    rows = await ensure_today(turn)
    items = [quest_view(q) for q in rows if q.slot >= 1]
    version = rows[0].rules_version if rows else turn.rules.version
    rules = await rules_by_version(turn.session, version) or turn.rules
    bonus = rules.quests["all_done_bonus"]
    hidden = bool(turn.learner.quests_hidden)
    return {"local_date": turn.today.isoformat(), "hidden": hidden, "items": [] if hidden else items,
            "all_done_bonus": {"xp": int(bonus["xp"]), "til": int(bonus["til"])},
            "bonus_received": any(q.slot == BONUS_SLOT for q in rows)}
