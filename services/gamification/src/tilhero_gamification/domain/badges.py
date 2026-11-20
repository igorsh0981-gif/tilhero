"""Значки (§1.6): предикаты кодом, пороги — из активных правил. Выдаются в транзакции события, неизменяемы
(триггер), без операций в реестре. Основание — метрика, значение и порог на момент выдачи, событие-источник.
Каждый значок → game.badge.earned.v1 (notify = настройка game_notifications)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_gamification.domain.common import BADGE_EARNED, emit_event, iso, render
from tilhero_gamification.domain.engine import Turn, bump
from tilhero_gamification.domain.rules import Rules
from tilhero_gamification.models import Badge, BadgeTemplate, Learner


@dataclass(frozen=True)
class BadgeDef:
    code: str
    family: str  # код шаблона текстов
    metric: str
    threshold: int


def definitions(rules: Rules) -> list[BadgeDef]:
    b = rules.badges
    return [
        BadgeDef("first_lesson", "first_lesson", "lessons", 1),
        *[BadgeDef(f"streak_{n}", "streak", "streak", n) for n in b.get("streak", [])],
        *[BadgeDef(f"skills_{n}", "skills", "skills", n) for n in b.get("skills", [])],
        BadgeDef("skill_retained", "skill_retained", "skill_retained", 1),
        *[BadgeDef(f"reviews_{n}", "reviews", "reviews_cards", n) for n in b.get("reviews_cards", [])],
        *[BadgeDef(f"readings_{n}", "readings", "readings", n) for n in b.get("readings", [])],
        BadgeDef("first_freeze", "first_freeze", "freeze", 1),
    ]


def metric_value(learner: Learner, metric: str) -> int:
    return int({
        "lessons": learner.lessons_completed, "streak": learner.streak_best, "skills": learner.confirmed_skills,
        "skill_retained": learner.skills_retained, "reviews_cards": learner.reviews_cards,
        "readings": learner.readings_completed, "freeze": learner.freezes_used,
    }[metric])


def family_of(code: str) -> str:
    for prefix, family in (("streak_", "streak"), ("skills_", "skills"), ("reviews_", "reviews"),
                           ("readings_", "readings")):
        if code.startswith(prefix):
            return family
    return code


async def check(turn: Turn, metrics: set[str]) -> list[str]:
    """Выдать значки по изменившимся метрикам; повтор — без второй выдачи."""
    earned: list[str] = []
    for d in definitions(turn.rules):
        if d.metric not in metrics:
            continue
        value = metric_value(turn.learner, d.metric)
        if value < d.threshold:
            continue
        inserted = (await turn.session.execute(insert(Badge).values(
            user_id=turn.user_id, badge_code=d.code, metric=d.metric, value=value, threshold=d.threshold,
            event_id=turn.event_id, earned_at=turn.now).on_conflict_do_nothing(
            index_elements=["user_id", "badge_code"]).returning(Badge.badge_code))).scalar()
        if inserted is None:
            continue
        earned.append(d.code)
        turn.effects.badges.append(d.code)
        await bump(turn.session, turn.stats_day, turn.audience, "badges_earned")
        await emit_event(turn.session, BADGE_EARNED, {
            "user_id": str(turn.user_id), "badge_code": d.code, "notify": turn.notify,
            "earned_at": iso(turn.now)}, causation_id=turn.event_id)
    return earned


async def templates(session: AsyncSession) -> dict[str, BadgeTemplate]:
    return {t.code: t for t in (await session.execute(select(BadgeTemplate))).scalars().all()}


def _texts(tpl: BadgeTemplate | None, code: str, threshold: int) -> tuple[dict[str, str], dict[str, str]]:
    if tpl is None:
        return {"ru": code, "uz": code}, {"ru": "", "uz": ""}
    return render(tpl.title, threshold, tpl.unit), render(tpl.description, threshold, tpl.unit)


async def views(session: AsyncSession, turn: Turn, images: dict[uuid.UUID, dict[str, Any]],
                codes: list[str] | None = None) -> list[dict[str, Any]]:
    """BadgeView: выданные (основание) первыми, затем невыданные текущих правил (прогресс). codes — только эти."""
    tpls = await templates(session)
    rows = {b.badge_code: b for b in (await session.execute(
        select(Badge).where(Badge.user_id == turn.user_id))).scalars().all()}
    defs = {d.code: d for d in definitions(turn.rules)}
    out_earned: list[tuple[Any, dict[str, Any]]] = []
    out_open: list[dict[str, Any]] = []
    for code, b in rows.items():
        if codes is not None and code not in codes:
            continue
        tpl = tpls.get(family_of(code))
        title, desc = _texts(tpl, code, b.threshold)
        out_earned.append((b.earned_at, {
            "code": code, "title": title, "description": desc,
            "image": images.get(tpl.asset_id) if tpl is not None and tpl.asset_id else None,
            "earned_at": iso(b.earned_at), "basis": {"metric": b.metric, "value": b.value, "threshold": b.threshold}}))
    if codes is None:
        for d in defs.values():
            if d.code in rows:
                continue
            tpl = tpls.get(d.family)
            title, desc = _texts(tpl, d.code, d.threshold)
            out_open.append({
                "code": d.code, "title": title, "description": desc,
                "image": images.get(tpl.asset_id) if tpl is not None and tpl.asset_id else None, "earned_at": None,
                "basis": {"metric": d.metric, "value": min(metric_value(turn.learner, d.metric), d.threshold),
                          "threshold": d.threshold}})
    out_earned.sort(key=lambda x: (x[0], x[1]["code"]), reverse=True)
    return [v for _, v in out_earned] + out_open


async def template_asset_ids(session: AsyncSession) -> list[uuid.UUID]:
    return [a for a in (await session.execute(select(BadgeTemplate.asset_id).where(
        BadgeTemplate.asset_id.is_not(None)))).scalars().all() if a is not None]
