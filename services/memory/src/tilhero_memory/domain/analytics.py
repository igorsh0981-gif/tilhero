"""Аналитика забывания (ADM-MEM-02) и блок обзора — только агрегаты, без user_id и текстов учеников.

k-анонимность: группа (навык, урок, код ошибки, слово), в которой меньше K_MIN (5) учеников, скрыта —
`hidden: true`, значения обнулены / null. Самые забываемые слова — при ≥ 20 ответах и ≥ 5 учениках.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any, Final
from zoneinfo import ZoneInfo

from sqlalchemy import Integer, case, distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_memory.clients import CatalogGateway
from tilhero_memory.domain import explanations
from tilhero_memory.domain.common import iso
from tilhero_memory.models import Card, RetentionCheck, ReviewLog, ReviewSession

K_MIN: Final = 5
FORGOTTEN_MIN_ANSWERS: Final = 20
FORGOTTEN_TOP: Final = 20


def _pct(part: int, whole: int) -> float | None:
    return round(part * 100.0 / whole, 1) if whole else None


def _rate(scheduled: int, passed: int, failed: int, learners: int) -> dict[str, Any]:
    if learners < K_MIN:
        return {"scheduled": 0, "passed": 0, "failed": 0, "pass_pct": None, "hidden": True}
    return {"scheduled": scheduled, "passed": passed, "failed": failed, "pass_pct": _pct(passed, passed + failed),
            "hidden": False}


async def _check_rates(db: AsyncSession, pair_id: str, since: datetime) -> dict[tuple[str, str], dict[str, Any]]:
    """(skill_id | '*', stage) → CheckRate: назначено (создано за период), пройдено / провалено (итог за период)."""
    rows = (await db.execute(select(RetentionCheck.skill_id, RetentionCheck.stage, RetentionCheck.user_id,
                                    RetentionCheck.status, RetentionCheck.created_at, RetentionCheck.checked_at)
                             .where(RetentionCheck.pair_id == pair_id,
                                    (RetentionCheck.created_at >= since) | (RetentionCheck.checked_at >= since)))
            ).all()
    acc: dict[tuple[str, str], dict[str, Any]] = defaultdict(lambda: {"s": 0, "p": 0, "f": 0, "u": set()})
    for skill_id, stage, user_id, status, created_at, checked_at in rows:
        for key in ((skill_id, stage), ("*", stage)):
            a = acc[key]
            a["u"].add(user_id)
            if created_at >= since:
                a["s"] += 1
            if checked_at is not None and checked_at >= since:
                if status == "passed":
                    a["p"] += 1
                elif status == "failed":
                    a["f"] += 1
    return {k: _rate(v["s"], v["p"], v["f"], len(v["u"])) for k, v in acc.items()}


async def forgetting(db: AsyncSession, catalog: CatalogGateway, pair_id: str, period: str,
                     now: datetime) -> dict[str, Any]:
    """ForgettingAnalytics (admin.ts)."""
    since = now - timedelta(days=90 if period == "90d" else 30)
    empty = _rate(0, 0, 0, 0)
    rates = await _check_rates(db, pair_id, since)
    skills = sorted({k[0] for k in rates if k[0] != "*"})
    by_skill = [{"skill_id": sid, "title": await catalog.skill_title(sid, pair_id),
                 "d7": rates.get((sid, "d7"), empty), "d30": rates.get((sid, "d30"), empty)} for sid in skills]

    is_again = func.sum(case((ReviewLog.grade == "again", 1), else_=0)).cast(Integer)
    graded = (ReviewLog.created_at >= since, ReviewLog.grade.is_not(None), ReviewLog.actor == "learner")
    # уроки: карточки урока (созданы за период) и доля again по ним за период
    lesson_cards: dict[str, tuple[int, int]] = {}  # урок → (карточек, учеников)
    for lid, n, users in (await db.execute(
            select(Card.origin_lesson_id, func.count(), func.count(distinct(Card.user_id))).where(
                Card.pair_id == pair_id, Card.origin_lesson_id.is_not(None), Card.created_at >= since)
            .group_by(Card.origin_lesson_id))).all():
        if lid is not None:
            lesson_cards[str(lid)] = (int(n), int(users))
    lesson_answers: dict[str, tuple[int, int]] = {}  # урок → (ответов, again)
    for lid, total, again in (await db.execute(
            select(Card.origin_lesson_id, func.count(), is_again).select_from(ReviewLog)
            .join(Card, Card.card_id == ReviewLog.card_id)
            .where(Card.pair_id == pair_id, Card.origin_lesson_id.is_not(None), *graded)
            .group_by(Card.origin_lesson_id))).all():
        if lid is not None:
            lesson_answers[str(lid)] = (int(total), int(again or 0))
    by_lesson = []
    for lid in sorted(set(lesson_cards) | set(lesson_answers)):
        cards_n, learners_n = lesson_cards.get(lid, (0, 0))
        hidden = learners_n < K_MIN
        total, again = lesson_answers.get(lid, (0, 0))
        by_lesson.append({"lesson_id": lid, "title": await catalog.title("lesson", lid),
                          "cards": 0 if hidden else cards_n,
                          "again_pct": None if hidden else _pct(again, total), "hidden": hidden})

    # повторные ошибки: учеников с ≥ 2 again по карточке ошибки этого кода; всего карточек кода
    err_cards: dict[str | None, tuple[int, int]] = {code: (int(n), int(u)) for code, n, u in (await db.execute(
        select(Card.error_code, func.count(), func.count(distinct(Card.user_id))).where(
            Card.pair_id == pair_id, Card.kind == "error", Card.created_at >= since).group_by(Card.error_code))).all()}
    per_card = (select(Card.error_code.label("code"), Card.user_id.label("uid"), Card.card_id.label("cid"),
                       is_again.label("again"))
                .select_from(ReviewLog).join(Card, Card.card_id == ReviewLog.card_id)
                .where(Card.pair_id == pair_id, Card.kind == "error", *graded)
                .group_by(Card.error_code, Card.user_id, Card.card_id).subquery())
    repeats: dict[str | None, int] = {code: int(n) for code, n in (await db.execute(
        select(per_card.c.code, func.count(distinct(per_card.c.uid))).where(per_card.c.again >= 2)
        .group_by(per_card.c.code))).all()}
    repeated_errors = []
    for code in sorted(set(err_cards) | set(repeats), key=lambda c: c or ""):
        n, learners = err_cards.get(code, (0, 0))
        hidden = learners < K_MIN
        repeated_errors.append({"error_code": code or "other", "label": explanations.label(code),
                                "learners_with_repeats": 0 if hidden else int(repeats.get(code, 0)),
                                "cards": 0 if hidden else n, "hidden": hidden})

    words = (await db.execute(
        select(Card.key, func.min(Card.text_en), func.count(), is_again, func.count(distinct(Card.user_id)))
        .select_from(ReviewLog).join(Card, Card.card_id == ReviewLog.card_id)
        .where(Card.pair_id == pair_id, Card.kind.in_(("word", "phrase")), *graded)
        .group_by(Card.key)
        .having(func.count() >= FORGOTTEN_MIN_ANSWERS, func.count(distinct(Card.user_id)) >= K_MIN))).all()
    scored = [(float(_pct(int(again or 0), int(total)) or 0.0), str(text), int(total))
              for _, text, total, again, _ in words]
    scored.sort(key=lambda w: (-w[0], w[1]))
    forgotten = [{"text_en": text, "answers": total, "again_pct": pct} for pct, text, total in scored]
    return {"period": period, "pair_id": pair_id, "generated_at": iso(now),
            "checks": {"d7": rates.get(("*", "d7"), empty), "d30": rates.get(("*", "d30"), empty)},
            "by_skill": by_skill, "by_lesson": by_lesson, "repeated_errors": repeated_errors,
            "forgotten_words": forgotten[:FORGOTTEN_TOP]}


def period_start(period: str, now: datetime, tz_name: str) -> datetime:
    if period == "today":
        tz = ZoneInfo(tz_name)
        return now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    return now - timedelta(days=7 if period == "7d" else 30)


async def stats(db: AsyncSession, period: str, now: datetime, tz_name: str) -> dict[str, Any]:
    """MemoryStats (admin.ts) — блок обзора. ai_glosses_pending — очередь catalog (дописывает admin-bff), здесь null."""
    since = period_start(period, now, tz_name)
    sessions = (await db.execute(select(ReviewSession.user_id, ReviewSession.minutes).where(
        ReviewSession.status.in_(("completed", "expired")), ReviewSession.finished_at >= since))).all()
    learners = {u for u, _ in sessions}
    hidden = len(learners) < K_MIN
    d30 = (await db.execute(select(RetentionCheck.status, RetentionCheck.user_id).where(
        RetentionCheck.stage == "d30", RetentionCheck.status.in_(("passed", "failed")),
        RetentionCheck.checked_at >= since))).all()
    d30_users = {u for _, u in d30}
    passed = sum(1 for st, _ in d30 if st == "passed")
    due_cards = int(await db.scalar(select(func.count()).select_from(Card).where(
        Card.status.in_(("learning", "review")), Card.due_at <= now)) or 0)
    with_cards = int(await db.scalar(select(func.count(distinct(Card.user_id))).where(
        Card.status.in_(("learning", "review")))) or 0)
    return {"period": period, "review_sessions": len(sessions), "learners_reviewing": len(learners),
            "median_minutes": None if hidden or not sessions else float(statistics.median(m for _, m in sessions)),
            "d30_pass_pct": None if len(d30_users) < K_MIN else _pct(passed, len(d30)),
            "avg_due_per_learner": None if with_cards < K_MIN else round(due_cards / with_cards, 1),
            "ai_glosses_pending": None}
