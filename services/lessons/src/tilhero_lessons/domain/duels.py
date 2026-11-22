"""Задания дуэли (duel_host — код, не LLM; INTERNAL_API §3.1, bff.ts «Дуэли»).

- `POST /internal/v1/duel-sets` (только gamification, при принятии вызова): 10 закрытых заданий (выбор, пропуск,
  порядок) из опубликованных уроков пары и полосы уровня с ключами — снимок в наборе (наружу ключи не уходят).
  Выбор детерминирован (sha256(duel_id)) и сбалансирован по навыкам (по одному заданию на навык по кругу); аудитория —
  самая строгая из участников (ребёнок или возраст неизвестен — только детские уроки). Один набор на дуэль: повтор —
  тот же set_id. Мало заданий в полосе — добираются соседние уровни (сначала ниже).
- Сессия `kind duel` (`POST /internal/v1/me/duel-sessions`): только участник набора; одна на участника (повтор — та же);
  вне правила одной активной сессии; шаги — общие маршруты сессий спринта 4: задания без подсказок и ИИ, ответ
  проверяется по ключу снимка, правильность не показывается; повтор ответа — тот же результат (шаг неизменяем).
  Перемешивание вариантов — по seed набора: оба участника видят одинаковые задания.
- После срока набора (play_deadline) — 409 DUEL_CLOSED; незаконченная сессия закрывается (completed, неотвеченные —
  неверные) с событием `lesson.session.completed.v1 {kind: duel, duel_id, score, practice_only: true}`; в assessment
  не идёт. Разбор ответов (`GET …/duel-sessions/{id}/review`) — только после `game.duel.finished.v1`.
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, conflict, not_found, unavailable
from tilhero_lessons.catalog import CatalogGateway, ContentGone
from tilhero_lessons.domain import machine
from tilhero_lessons.domain.common import (
    IdempotencyReused,
    iso,
    lock_users,
    seeded_order,
    session_not_found,
    user_deleted,
)
from tilhero_lessons.domain.content import Bundle, answer_text, correct_text, grade_control_item
from tilhero_lessons.domain.members import projected_audience, strictest
from tilhero_lessons.models import DeletedUser, DuelSet, Session, Step
from tilhero_lessons.settings import Settings

log = logging.getLogger("tilhero.lessons.duels")

LEVELS = ("A0", "A1", "A2", "B1", "B2")
BAND_LEVELS: dict[str, tuple[str, ...]] = {"A0-A1": ("A0", "A1"), "A2": ("A2",), "B1+": ("B1", "B2")}
BAND_TO_LEVEL = {"A0-A1": "A1", "A2": "A2", "B1+": "B1"}
# закрытые задания, которые сервер проверяет по ключу (content.grade_control_item)
GRADABLE = frozenset({"single_choice", "translate_choice", "gap_fill", "order_words"})
TITLE = {"ru": "Дуэль", "uz": "Duel"}
FINISHED_PRODUCER = "gamification"


def duel_not_found() -> ApiError:
    return not_found("DUEL_NOT_FOUND", "Дуэль не найдена")


def duel_closed() -> ApiError:
    return conflict("DUEL_CLOSED", "Время дуэли вышло")


def duel_not_finished() -> ApiError:
    return conflict("DUEL_NOT_FINISHED", "Разбор откроется после завершения дуэли")


def set_unavailable() -> ApiError:
    return unavailable("DUEL_SET_UNAVAILABLE", "Не удалось подобрать задания для дуэли — попробуйте позже")


def set_view(ds: DuelSet) -> dict[str, Any]:
    """Ответ gamification: без заданий и ключей."""
    return {"set_id": str(ds.set_id), "duel_id": str(ds.duel_id), "pair_id": ds.pair_id,
            "level_band": ds.level_band, "items_total": ds.items_total, "play_deadline": iso(ds.play_deadline)}


def _level_order(band: str) -> list[str]:
    """Уровни полосы, затем соседние по удалённости (при равной — сначала ниже)."""
    own = BAND_LEVELS[band]
    idx = [LEVELS.index(lv) for lv in own]
    rest = [lv for lv in LEVELS if lv not in own]
    rest.sort(key=lambda lv: (min(abs(LEVELS.index(lv) - i) for i in idx), LEVELS.index(lv) > max(idx)))
    return [*own, *rest]


async def _pool(catalog: CatalogGateway, settings: Settings, pair_id: str, band: str,
                audiences: set[str]) -> list[dict[str, Any]]:
    """Задания опубликованных уроков курса пары подходящей аудитории — по уровням полосы, пока не наберётся набор."""
    info = await catalog.pair(pair_id)
    course = (info.course_id if info else None) or (
        settings.default_course_id if pair_id == settings.default_pair_id else None)
    if info is None or not info.available or not course:
        raise set_unavailable()
    snapshot = await catalog.snapshot(course)
    if snapshot is None:
        raise set_unavailable()
    by_level: dict[str, list[dict[str, Any]]] = {}
    for entry in snapshot.get("lessons") or []:
        if not audiences <= set(entry.get("audience") or []) or entry.get("level") not in LEVELS:
            continue
        by_level.setdefault(str(entry["level"]), []).append(entry)
    pool: list[dict[str, Any]] = []
    seen: set[str] = set()
    for level in _level_order(band):
        for entry in sorted(by_level.get(level, []), key=lambda e: str(e["lesson_id"])):
            hint = entry.get("version") if isinstance(entry.get("version"), int) else None
            try:
                found = await catalog.published("lesson", str(entry["lesson_id"]), hint=hint)
            except ContentGone:
                continue
            if found is None:
                continue
            version, lesson = found
            if not audiences <= set(lesson.get("audience") or []):
                continue
            for item in lesson.get("control_items") or []:
                if item.get("type") in GRADABLE and item.get("item_id") not in seen:
                    seen.add(str(item["item_id"]))
                    pool.append({"lesson_id": str(entry["lesson_id"]), "version": version,
                                 "skill_id": str(item.get("skill_id") or ""), "item": item})
        if len(pool) >= settings.duel_items:
            break
    return pool


def pick(seed: str, pool: list[dict[str, Any]], total: int) -> list[dict[str, Any]]:
    """Сбалансировано по навыкам: навыки и задания внутри навыка — в порядке sha256(seed), по одному заданию от
    навыка по кругу; итоговый порядок показа — тоже по seed."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for p in pool:
        groups.setdefault(p["skill_id"], []).append(p)
    skills = seeded_order(seed, "skills", list(groups), key=str)
    queues = {sk: seeded_order(seed, f"items:{sk}", groups[sk], key=lambda p: str(p["item"]["item_id"]))
              for sk in skills}
    chosen: list[dict[str, Any]] = []
    while len(chosen) < total and any(queues.values()):
        for sk in skills:
            if queues[sk] and len(chosen) < total:
                chosen.append(queues[sk].pop(0))
    return seeded_order(seed, "order", chosen, key=lambda p: str(p["item"]["item_id"]))


async def create_set(rt: Runtime, catalog: CatalogGateway, settings: Settings, now: datetime, *, duel_id: uuid.UUID,
                     pair_id: str, level_band: str, user_ids: list[uuid.UUID],
                     play_deadline: datetime | None) -> tuple[DuelSet, bool]:
    """→ (набор, повтор). Повтор на ту же дуэль — тот же набор; другие участники — 409 DUEL_SET_CONFLICT."""
    a, b = sorted(user_ids, key=str)
    async with rt.transaction() as db:
        existing = (await db.execute(select(DuelSet).where(DuelSet.duel_id == duel_id))).scalar_one_or_none()
        if existing is not None:
            return _same(existing, a, b), True
        for u in (a, b):
            if await db.get(DeletedUser, u) is not None:
                raise user_deleted()
        audiences = {await projected_audience(db, a), await projected_audience(db, b)}
    known = {x for x in audiences if x is not None}
    required = {"kids"} if None in audiences or "kids" in known else known
    seed = hashlib.sha256(str(duel_id).encode()).hexdigest()
    pool = await _pool(catalog, settings, pair_id, level_band, required)
    chosen = pick(seed, pool, settings.duel_items)
    if len(chosen) < min(settings.duel_items, 3):
        log.warning("duel set: not enough items", extra={"items": len(chosen)})
        raise set_unavailable()
    deadline = play_deadline or now + timedelta(hours=settings.duel_play_hours)
    ds = DuelSet(set_id=uuid.uuid4(), duel_id=duel_id, pair_id=pair_id, level_band=level_band, user_a=a, user_b=b,
                 audience=strictest(*required), seed=seed, items=chosen, items_total=len(chosen),
                 play_deadline=deadline, status="open", created_at=now)
    async with rt.transaction() as db:
        await lock_users(db, a, b)
        existing = (await db.execute(select(DuelSet).where(DuelSet.duel_id == duel_id))).scalar_one_or_none()
        if existing is not None:
            return _same(existing, a, b), True
        for u in (a, b):  # удаление проверяется после блокировки учеников (сага держит ту же блокировку)
            if await db.get(DeletedUser, u) is not None:
                raise user_deleted()
        db.add(ds)
    return ds, False


def _same(ds: DuelSet, a: uuid.UUID, b: uuid.UUID) -> DuelSet:
    if {ds.user_a, ds.user_b} - {None} - {a, b}:
        raise conflict("DUEL_SET_CONFLICT", "Набор этой дуэли уже выдан другим участникам")
    return ds


# ---------------------------------------------------------------- сессия дуэли


def _request_hash(duel_id: uuid.UUID) -> str:
    return hashlib.sha256(f"duel|{duel_id}".encode()).hexdigest()


def is_participant(ds: DuelSet, user_id: uuid.UUID) -> bool:
    return user_id in (ds.user_a, ds.user_b)


def is_closed(ds: DuelSet, now: datetime) -> bool:
    return ds.status != "open" or now >= ds.play_deadline


async def start_session(db: AsyncSession, *, user_id: uuid.UUID, account_id: uuid.UUID, audience: str, locale: str,
                        duel_id: uuid.UUID, key: str, now: datetime, settings: Settings) -> tuple[Session, bool]:
    """Под блокировкой ученика (вызывающий). → (сессия, повтор)."""
    rhash = _request_hash(duel_id)
    by_key = (await db.execute(select(Session).where(Session.user_id == user_id, Session.idempotency_key == key))
              ).scalar_one_or_none()
    if by_key is not None:
        if by_key.request_hash != rhash:
            raise IdempotencyReused
        return by_key, True
    ds = (await db.execute(select(DuelSet).where(DuelSet.duel_id == duel_id))).scalar_one_or_none()
    if ds is None or not is_participant(ds, user_id):
        raise duel_not_found()
    mine = (await db.execute(select(Session).where(Session.kind == "duel", Session.duel_id == duel_id,
                                                   Session.user_id == user_id))).scalar_one_or_none()
    if mine is not None:
        return mine, True
    if is_closed(ds, now):
        raise duel_closed()
    units = [{"t": "duel_item", "n": i} for i in range(ds.items_total)]
    s = Session(
        session_id=uuid.uuid4(), user_id=user_id, account_id=account_id, kind="duel", pair_id=ds.pair_id,
        course_id=None, title=dict(TITLE), level=BAND_TO_LEVEL.get(ds.level_band), audience=audience, locale=locale,
        ai_mode="choices", ai_degraded=False, ai_used=False, hints_used=0, seed=ds.seed,
        content_versions={"duel_set": {"set_id": str(ds.set_id)}},
        plan={"stages": [{"type": "assessment", "units": units}, {"type": "summary", "units": [{"t": "done"}]}]},
        state={"cursor": {"stage": 0, "unit": 0}, "turns": 0}, status="ready", stage=None, step_index=0,
        duration_min=settings.practice_duration_min, created_at=now, active_seconds=0, minutes=0,
        practice_only=True, evaluation_status="none", evaluation_attempts=0, summary=None, duel_id=duel_id,
        idempotency_key=key, request_hash=rhash)
    db.add(s)
    await db.flush()
    await machine.record_created(db, s, now)
    return s, False


async def set_of(db: AsyncSession, s: Session) -> DuelSet | None:
    if s.duel_id is None:
        return None
    return (await db.execute(select(DuelSet).where(DuelSet.duel_id == s.duel_id))).scalar_one_or_none()


async def bundle(db: AsyncSession, s: Session) -> Bundle:
    ds = await set_of(db, s)
    if ds is None:  # набор не удаляется, пока есть сессия участника
        raise duel_not_found()
    return Bundle(duel=list(ds.items), duel_seed=ds.seed)


async def score_of(db: AsyncSession, s: Session, total: int) -> dict[str, int]:
    steps = (await db.execute(select(Step).where(Step.session_id == s.session_id))).scalars().all()
    correct = sum(1 for st in steps if (st.ref or {}).get("src") == "duel" and st.result == "correct")
    return {"correct": min(correct, total), "total": max(total, 1)}


async def close_session(db: AsyncSession, s: Session, ds: DuelSet, now: datetime, settings: Settings) -> bool:
    """Незаконченная сессия к сроку или итогу дуэли → completed со счётом по отвеченному (неотвеченные — неверные)."""
    if s.status not in machine.ACTIVE:
        return False
    s.summary = {"skills": [], "key_words": [], "can_review": False,
                 "score": await score_of(db, s, ds.items_total)}
    await machine.close_deadline(db, s, now, settings)
    return True


async def finish(db: AsyncSession, s: Session, now: datetime, settings: Settings) -> None:
    """Завершение с шага done: счёт по ключам снимка (сервер), без assessment."""
    ds = await set_of(db, s)
    total = ds.items_total if ds is not None else len((s.plan.get("stages") or [{}])[0].get("units") or [])
    s.summary = {"skills": [], "key_words": [], "can_review": False, "score": await score_of(db, s, total)}
    await machine.finish(db, s, now, settings)


async def review(db: AsyncSession, s: Session) -> dict[str, Any]:
    """DuelReview: свои ответы, верные ответы и счёт — только после завершения дуэли (game.duel.finished.v1)."""
    ds = await set_of(db, s)
    if ds is None:
        raise session_not_found()
    if ds.finished_at is None:
        raise duel_not_finished()
    steps = {int((st.ref or {}).get("n", -1)): st for st in (await db.execute(
        select(Step).where(Step.session_id == s.session_id))).scalars().all() if (st.ref or {}).get("src") == "duel"}
    items = []
    for n, entry in enumerate(ds.items):
        item = entry["item"]
        st = steps.get(n)
        answer = st.answer if st is not None and isinstance(st.answer, dict) else {}
        value = None if answer.get("dont_know") else answer.get("answer")
        options = (st.payload.get("item") or {}).get("options") if st is not None else item.get("options")
        your = answer_text(list(options or []), value) if st is not None and st.answered_at is not None else None
        items.append({"item_id": str(item["item_id"]), "prompt_en": str(item.get("prompt_en") or ""),
                      "your_answer": your, "correct_answer": correct_text(item) or "",
                      "correct": bool(st is not None and st.result == "correct")})
    score = (s.summary or {}).get("score") or await score_of(db, s, ds.items_total)
    return {"session_id": str(s.session_id), "duel_id": str(ds.duel_id),
            "score": {"correct": int(score["correct"]), "total": int(score["total"])}, "items": items}


def grade(b: Bundle, n: int, value: Any) -> bool:
    return grade_control_item(b.duel[n]["item"], value)


# ---------------------------------------------------------------- закрытие наборов (tick, game.duel.finished.v1)


async def _locked_set(db: AsyncSession, **where: Any) -> DuelSet | None:
    """Набор под блокировками участников: единый порядок — сначала ученики (как сага удаления и команды ученика),
    затем строка набора FOR UPDATE (без взаимной блокировки с forget_user)."""
    cond = [getattr(DuelSet, k) == v for k, v in where.items()]
    users = (await db.execute(select(DuelSet.user_a, DuelSet.user_b).where(*cond))).first()
    if users is None:
        return None
    await lock_users(db, *users)
    return (await db.execute(select(DuelSet).where(*cond).with_for_update()
                             .execution_options(populate_existing=True))).scalar_one_or_none()


async def _close_sessions(db: AsyncSession, ds: DuelSet, now: datetime, settings: Settings) -> int:
    """Под блокировками участников набора (вызывающий — _locked_set)."""
    closed = 0
    rows = (await db.execute(select(Session).where(
        Session.kind == "duel", Session.duel_id == ds.duel_id, Session.status.in_(machine.ACTIVE))
        .execution_options(populate_existing=True))).scalars().all()
    for s in rows:
        if await close_session(db, s, ds, now, settings):
            closed += 1
    return closed


async def on_duel_finished(db: AsyncSession, payload: dict[str, Any], now: datetime, settings: Settings) -> None:
    """game.duel.finished.v1 (только от gamification): разбор открывается, незаконченные сессии закрываются.
    Повтор и переоценка (новая result_version) не меняют закрытые сессии."""
    duel_id = uuid.UUID(str(payload["duel_id"]))
    ds = await _locked_set(db, duel_id=duel_id)
    if ds is None:  # вызов не принят (набора нет) — нечего закрывать
        return
    version = payload.get("result_version")
    version = version if isinstance(version, int) and not isinstance(version, bool) else None
    await _close_sessions(db, ds, now, settings)
    if ds.finished_at is None:
        ds.finished_at = now
        ds.closed_at = ds.closed_at or now
    ds.status = "finished"
    if version is not None and (ds.result_version is None or version > ds.result_version):
        ds.result_version = version


async def close_due(rt: Runtime, settings: Settings, now: datetime) -> dict[str, int]:
    """tick: наборы с прошедшим сроком → closed; незаконченные сессии — completed со счётом."""
    async with rt.transaction() as db:
        ids = list((await db.execute(select(DuelSet.set_id).where(
            DuelSet.status == "open", DuelSet.play_deadline <= now).order_by(DuelSet.play_deadline)
            .limit(settings.tick_batch_size))).scalars().all())
    sets_closed = sessions_closed = 0
    for set_id in ids:
        async with rt.transaction() as db:
            ds = await _locked_set(db, set_id=set_id)
            if ds is None or ds.status != "open":
                continue
            sessions_closed += await _close_sessions(db, ds, now, settings)
            ds.status = "closed"
            ds.closed_at = now
            sets_closed += 1
    return {"duel_sets_closed": sets_closed, "duel_sessions_closed": sessions_closed}


async def close_if_due(db: AsyncSession, s: Session, now: datetime, settings: Settings) -> bool:
    """Ленивая проверка срока у команды ученика (под его блокировкой): → набор закрыт (сессия закрыта сейчас или
    раньше)."""
    ds = await set_of(db, s)
    if ds is None or not is_closed(ds, now):
        return False
    await close_session(db, s, ds, now, settings)
    return True


async def forget_user(db: AsyncSession, user_id: uuid.UUID) -> None:
    """Сага (под блокировкой удаляемого): участник в наборах обезличивается (набор остаётся второму); набор без
    участников удаляется. Взаимной блокировки нет: все остальные пути (on_duel_finished, tick, выдача набора) берут
    сначала блокировки обоих участников, потом строку набора — значит, строку набора с этим учеником может держать
    только транзакция, уже владеющая блокировкой удаляемого, а её держит сага."""
    rows = (await db.execute(select(DuelSet).where(or_(DuelSet.user_a == user_id, DuelSet.user_b == user_id))
                             .with_for_update().execution_options(populate_existing=True))).scalars().all()
    for ds in rows:
        if ds.user_a == user_id:
            ds.user_a = None
        if ds.user_b == user_id:
            ds.user_b = None
        if ds.user_a is None and ds.user_b is None:
            await db.delete(ds)

