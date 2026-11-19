"""Сессии и результаты диагностики (INTERNAL_API §2.2–2.3, AT-32…34, AT-38).

- Текущее задание не хранится: оно вычисляется engine.next_item из (версия теста, seed, ответы, аудирование) —
  поэтому подбор воспроизводим, а «ответ не на текущее задание» проверяется сравнением с вычисленным.
- Сессия живёт 24 ч; просроченная in_progress считается abandoned (DIAGNOSTIC_SESSION_EXPIRED на командах).
  На (ученик, пара) — не больше одной in_progress: новая сессия (и уточнение) прерывает прежнюю.
- Уточнение (followup) — отдельная сессия той же версии теста и seed, привязанная к результату; её завершение
  даёт новую ревизию результата по всем ответам (основная сессия + завершённые уточнения). Прежние ревизии
  неизменяемы (триггер results_immutable).
- Повтор: не чаще retest_days (DIAG_RETEST_DAYS) от последнего результата, где оценена хотя бы одна область.
"""

from __future__ import annotations

import secrets
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, not_found, unprocessable
from tilhero_common.messaging import emit
from tilhero_diagnostics import engine
from tilhero_diagnostics.domain import skills as skills_domain
from tilhero_diagnostics.domain import tests as tests_domain
from tilhero_diagnostics.domain.users import ensure_not_deleted, lock_user, segment_for, test_audience
from tilhero_diagnostics.models import Answer, Result, Session
from tilhero_diagnostics.testdef import BANDS, Item, TestDef

SESSION_TTL = timedelta(hours=24)
FOLLOWUP_WINDOW = timedelta(hours=24)
COMPLETED = "diagnostics.completed.v1"
PRODUCER = "diagnostics"

SeedFactory = Callable[[], str]


def default_seed() -> str:
    return secrets.token_hex(16)


# ---------------------------------------------------------------- ошибки


def session_not_found() -> ApiError:
    return not_found("DIAGNOSTIC_SESSION_NOT_FOUND", "Сессия диагностики не найдена")


def result_not_found() -> ApiError:
    return not_found("DIAGNOSTIC_RESULT_NOT_FOUND", "Результат диагностики не найден")


def pair_not_available(pair_id: str) -> ApiError:
    return conflict("PAIR_NOT_AVAILABLE", "Языковая пара пока недоступна", {"pair_id": pair_id})


class IdempotencyReused(Exception):
    pass


# ---------------------------------------------------------------- состояние сессии


def effective_status(s: Session, now: datetime) -> str:
    if s.status == "in_progress" and now >= s.expires_at:
        return "abandoned"
    return s.status


def ensure_open(s: Session, now: datetime) -> None:
    if s.status == "in_progress" and now >= s.expires_at:
        raise conflict("DIAGNOSTIC_SESSION_EXPIRED", "Сессия диагностики истекла (24 ч) — начните заново")
    if s.status != "in_progress":
        raise conflict("DIAGNOSTIC_SESSION_CLOSED", "Сессия диагностики уже завершена или прервана",
                       {"status": s.status})


def _answered(a: Answer) -> engine.Answered:
    return engine.Answered(a.item_id, a.area, a.band, a.correct, a.dont_know)


@dataclass
class Context:
    """Всё, что нужно подбору и оценке сессии."""

    session: Session
    test: TestDef
    history: list[engine.Answered]  # основная сессия + завершённые уточнения + эта сессия (для подбора)
    own: list[engine.Answered]  # ответы этой сессии
    base: Session  # основная сессия (для уточнения — сессия ревизии 1)

    @property
    def quotas(self) -> dict[str, int]:
        cfg = self.test.config
        if self.session.followup_area is not None:
            return {self.session.followup_area: cfg.followup_items}
        return {a: cfg.items_per_area for a in cfg.areas}

    def current(self) -> Item | None:
        return engine.next_item(self.test, self.session.seed, self.history, session_answers=self.own,
                                quotas=self.quotas, listening_available=self.session.listening_available)

    def total_estimate(self) -> int:
        cfg = self.test.config
        if self.session.followup_area is not None:
            return cfg.followup_items
        areas = [a for a in cfg.areas if self.session.listening_available or a != "listening"]
        return cfg.items_per_area * len(areas)


async def _answers_of(session: AsyncSession, session_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, list[Answer]]:
    out: dict[uuid.UUID, list[Answer]] = {sid: [] for sid in session_ids}
    if session_ids:
        rows = (await session.execute(
            select(Answer).where(Answer.session_id.in_(list(session_ids))).order_by(Answer.session_id, Answer.seq)
        )).scalars().all()
        for a in rows:
            out[a.session_id].append(a)
    return out


async def _followup_chain(session: AsyncSession, result_id: uuid.UUID) -> tuple[Session, list[Session]]:
    """Основная сессия результата и завершённые уточнения (в порядке завершения)."""
    base_id = (await session.execute(
        select(Result.session_id).where(Result.result_id == result_id, Result.revision == 1)
    )).scalar_one()
    base = await session.get(Session, base_id)
    assert base is not None
    followups = (await session.execute(
        select(Session).where(Session.result_id == result_id, Session.status == "finished")
        .order_by(Session.finished_at, Session.session_id)
    )).scalars().all()
    return base, list(followups)


async def load_context(session: AsyncSession, s: Session) -> Context:
    test = await tests_domain.by_version(session, s.test_id, s.test_version)
    if s.result_id is None:
        answers = (await _answers_of(session, [s.session_id]))[s.session_id]
        own = [_answered(a) for a in answers]
        return Context(s, test, list(own), own, s)
    base, done = await _followup_chain(session, s.result_id)
    chain = [base, *[f for f in done if f.session_id != s.session_id], s]
    by_session = await _answers_of(session, [x.session_id for x in chain])
    history = [_answered(a) for x in chain for a in by_session[x.session_id]]
    own = [_answered(a) for a in by_session[s.session_id]]
    return Context(s, test, history, own, base)


async def own_session(session: AsyncSession, user_id: uuid.UUID, session_id: uuid.UUID, *,
                      for_update: bool = False) -> Session:
    stmt = select(Session).where(Session.session_id == session_id, Session.user_id == user_id)
    if for_update:
        stmt = stmt.with_for_update()
    s = (await session.execute(stmt)).scalar_one_or_none()
    if s is None:  # чужая и несуществующая неразличимы (IDOR)
        raise session_not_found()
    return s


def session_out(ctx: Context, now: datetime) -> dict[str, Any]:
    s = ctx.session
    return {
        "session_id": s.session_id, "pair_id": s.pair_id, "test_version": ctx.test.ref,
        "status": effective_status(s, now), "answered": len(ctx.own), "total_estimate": ctx.total_estimate(),
        "started_at": s.started_at, "expires_at": s.expires_at, "followup_area": s.followup_area,
    }


def item_out(ctx: Context, item: Item | None) -> dict[str, Any] | None:
    return item.public(len(ctx.own) + 1) if item is not None else None


# ---------------------------------------------------------------- результаты


def _area_out(area: Mapping[str, Any]) -> dict[str, Any]:
    """Область результата наружу. Ревизии, сохранённые до решения ревью, хранят отметки по заданиям
    ({item_id, band, correct}) — они неизменяемы и при чтении сворачиваются в основания по полосам; для
    not_assessed — []. Отметки по заданиям наружу не уходят никогда."""
    out = {k: area.get(k) for k in ("area", "status", "band", "confidence", "reason", "needs_followup")}
    evidence = area.get("evidence") or []
    if area.get("status") != "assessed":
        out["evidence"] = []
    elif any(isinstance(e, Mapping) and "item_id" in e for e in evidence):
        out["evidence"] = engine.band_evidence(evidence)
    else:
        out["evidence"] = [{"band": e["band"], "answered": int(e["answered"]), "correct": int(e["correct"])}
                           for e in evidence if isinstance(e, Mapping) and e.get("band") in BANDS]
    out["needs_followup"] = bool(out["needs_followup"])
    return out


def result_out(r: Result) -> dict[str, Any]:
    p = r.profile
    return {
        "result_id": r.result_id, "revision": r.revision, "pair_id": r.pair_id,
        "test_version": f"{r.test_id}@{r.test_version}", "provisional_level": r.provisional_level,
        "areas": [_area_out(a) for a in p.get("areas", [])], "weak_areas": p.get("weak_areas", []),
        "recommended_start": p.get("recommended_start"), "cefr_certificate": False, "created_at": r.created_at,
    }


def _assessed(r: Result) -> bool:
    return any(a.get("status") == "assessed" for a in r.profile.get("areas", []))


async def latest_results(session: AsyncSession, user_id: uuid.UUID, pair_id: str | None,
                         limit: int = 50) -> list[Result]:
    """Последняя ревизия каждого результата, новые сверху."""
    stmt = select(Result).where(Result.user_id == user_id)
    if pair_id is not None:
        stmt = stmt.where(Result.pair_id == pair_id)
    rows = (await session.execute(stmt.order_by(Result.created_at.desc(), Result.revision.desc()))).scalars().all()
    first: dict[uuid.UUID, datetime] = {}
    latest: dict[uuid.UUID, Result] = {}
    for r in rows:
        if r.revision == 1:
            first[r.result_id] = r.created_at
        cur = latest.get(r.result_id)
        if cur is None or r.revision > cur.revision:
            latest[r.result_id] = r
    ordered = sorted(latest.values(), key=lambda r: (first.get(r.result_id, r.created_at), r.result_id),
                     reverse=True)
    return ordered[:limit]


async def result_revision(session: AsyncSession, user_id: uuid.UUID, result_id: uuid.UUID,
                          revision: int | None = None) -> Result:
    stmt = select(Result).where(Result.result_id == result_id, Result.user_id == user_id)
    if revision is not None:
        stmt = stmt.where(Result.revision == revision)
    r = (await session.execute(stmt.order_by(Result.revision.desc()).limit(1))).scalar_one_or_none()
    if r is None:
        raise result_not_found()
    return r


UNASSESSED_LIMIT = 3


async def next_allowed_at(session: AsyncSession, user_id: uuid.UUID, pair_id: str, retest_days: int,
                          now: datetime) -> datetime | None:
    """Момент, с которого можно начать диагностику снова (решения ревью):
    - последний результат (ревизия 1), где оценена хотя бы одна область, + retest_days;
    - результаты без оценённых областей (прервали в самом начале) повтор не блокируют, но их не больше
      UNASSESSED_LIMIT за retest_days: при лимите — самый ранний из них в окне + retest_days.
    Возвращает наибольший из сроков (может быть в прошлом — тогда повтор уже разрешён)."""
    window = timedelta(days=retest_days)
    rows = (await session.execute(
        select(Result).where(Result.user_id == user_id, Result.pair_id == pair_id, Result.revision == 1)
        .order_by(Result.created_at.desc()).limit(50)
    )).scalars().all()
    deadlines: list[datetime] = []
    last = next((r for r in rows if _assessed(r)), None)
    if last is not None:
        deadlines.append(last.created_at + window)
    recent = sorted(r.created_at for r in rows if not _assessed(r) and r.created_at > now - window)
    if len(recent) >= UNASSESSED_LIMIT:
        # разрешено, когда в окне останется меньше лимита: выпадет (len − лимит + 1)-й с начала
        deadlines.append(recent[len(recent) - UNASSESSED_LIMIT] + window)
    return max(deadlines) if deadlines else None


# ---------------------------------------------------------------- команды ученика


async def state(session: AsyncSession, *, user_id: uuid.UUID, pair_id: str, hint: str | None, now: datetime,
                retest_override: int | None) -> dict[str, Any]:
    await ensure_not_deleted(session, user_id)
    segment = await segment_for(session, user_id, hint)
    test = await tests_domain.published(session, pair_id, test_audience(segment))
    if test is None:
        raise pair_not_available(pair_id)
    current = (await session.execute(
        select(Session).where(Session.user_id == user_id, Session.pair_id == pair_id,
                              Session.status == "in_progress").limit(1)
    )).scalar_one_or_none()
    session_view = None
    if current is not None and effective_status(current, now) == "in_progress":
        session_view = session_out(await load_context(session, current), now)
    results = await latest_results(session, user_id, pair_id, limit=1)
    allowed = await next_allowed_at(session, user_id, pair_id, retest_override or test.config.retest_days, now)
    status = "in_progress" if session_view else ("completed" if results else "none")
    return {
        "pair_id": pair_id, "status": status, "session": session_view,
        "last_result": result_out(results[0]) if results else None,
        "next_allowed_at": allowed if allowed is not None and allowed > now else None,
        "audience": test.audience,
    }


async def create_session(session: AsyncSession, *, user_id: uuid.UUID, pair_id: str, pair_available: bool,
                         hint: str | None, key: str, now: datetime, retest_override: int | None,
                         seed_factory: SeedFactory) -> tuple[dict[str, Any], bool]:
    """→ (DiagnosticSession, replayed). Повтор с тем же Idempotency-Key — та же сессия без изменений."""
    await lock_user(session, user_id)
    await ensure_not_deleted(session, user_id)
    existing = (await session.execute(
        select(Session).where(Session.user_id == user_id, Session.idempotency_key == key)
    )).scalar_one_or_none()
    if existing is not None:
        if existing.pair_id != pair_id:
            raise IdempotencyReused
        return session_out(await load_context(session, existing), now), True
    if not pair_available:
        raise pair_not_available(pair_id)
    segment = await segment_for(session, user_id, hint)
    test = await tests_domain.published(session, pair_id, test_audience(segment))
    if test is None:
        raise pair_not_available(pair_id)
    allowed = await next_allowed_at(session, user_id, pair_id, retest_override or test.config.retest_days, now)
    if allowed is not None and allowed > now:
        raise conflict("DIAGNOSTIC_TOO_SOON", "Повторная диагностика пока недоступна",
                       {"next_allowed_at": allowed.isoformat().replace("+00:00", "Z")})
    await session.execute(
        update(Session).where(Session.user_id == user_id, Session.pair_id == pair_id,
                              Session.status == "in_progress").values(status="abandoned")
    )
    s = Session(session_id=uuid.uuid4(), user_id=user_id, pair_id=pair_id, test_id=test.test_id,
                test_version=test.version, seed=seed_factory(), segment=segment, status="in_progress",
                listening_available=True, followup_area=None, result_id=None, idempotency_key=key,
                started_at=now, expires_at=now + SESSION_TTL)
    session.add(s)
    await session.flush()
    return session_out(Context(s, test, [], [], s), now), False


async def next_item(session: AsyncSession, *, user_id: uuid.UUID, session_id: uuid.UUID,
                    now: datetime) -> dict[str, Any] | None:
    """DiagnosticItem или None (готово). Завершённая сессия — None; прерванная/просроченная — 409."""
    await ensure_not_deleted(session, user_id)
    s = await own_session(session, user_id, session_id)
    if s.status == "finished":
        return None
    ensure_open(s, now)
    ctx = await load_context(session, s)
    return item_out(ctx, ctx.current())


async def submit_answer(session: AsyncSession, *, user_id: uuid.UUID, session_id: uuid.UUID, item_id: str,
                        answer: int | list[str] | None, dont_know: bool, time_ms: int,
                        now: datetime) -> tuple[dict[str, Any], bool]:
    """→ (AnswerResult, replayed). Правильность ученику не сообщается."""
    await lock_user(session, user_id)
    await ensure_not_deleted(session, user_id)
    s = await own_session(session, user_id, session_id, for_update=True)
    ensure_open(s, now)
    ctx = await load_context(session, s)
    if any(a.item_id == item_id for a in ctx.own):
        nxt = ctx.current()
        return {"accepted": True, "next": item_out(ctx, nxt), "done": nxt is None}, True
    current = ctx.current()
    if current is None or current.item_id != item_id:
        raise conflict("ITEM_NOT_CURRENT", "Ответ не на текущее задание — запросите следующее задание")
    if dont_know and answer is not None:
        raise unprocessable("ANSWER_INVALID", "При «Не знаю» ответ не передаётся", {"field": "answer"})
    if not dont_know and (answer is None or not current.answer_shape_ok(answer)):
        raise unprocessable("ANSWER_INVALID", "Ответ не подходит к заданию", {"field": "answer"})
    correct = (not dont_know) and current.is_correct(answer)
    session.add(Answer(session_id=s.session_id, seq=len(ctx.own) + 1, item_id=current.item_id, area=current.area,
                       band=current.band, answer=answer, correct=correct, dont_know=dont_know, time_ms=time_ms,
                       answered_at=now))
    await session.flush()
    done_answer = engine.Answered(current.item_id, current.area, current.band, correct, dont_know)
    ctx.own.append(done_answer)
    ctx.history.append(done_answer)
    nxt = ctx.current()
    return {"accepted": True, "next": item_out(ctx, nxt), "done": nxt is None}, False


async def listening_unavailable(session: AsyncSession, *, user_id: uuid.UUID, session_id: uuid.UUID,
                                now: datetime) -> None:
    """Нет голоса en-* на устройстве: аудирование больше не подбирается; в результате — not_assessed
    (no_speech_voice). Повтор безопасен."""
    await lock_user(session, user_id)
    await ensure_not_deleted(session, user_id)
    s = await own_session(session, user_id, session_id, for_update=True)
    ensure_open(s, now)
    s.listening_available = False


def _recommended(raw: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if raw is None:
        return None
    title, level = raw.get("title"), raw.get("level")
    if not (isinstance(title, Mapping) and isinstance(title.get("ru"), str) and isinstance(title.get("uz"), str)
            and level in BANDS and isinstance(raw.get("lesson_id"), str)):
        return None
    return {"lesson_id": raw["lesson_id"], "title": {"ru": title["ru"], "uz": title["uz"]}, "level": level}


async def finish(session: AsyncSession, *, user_id: uuid.UUID, session_id: uuid.UUID, now: datetime,
                 snapshot: Mapping[str, Any] | None) -> dict[str, Any]:
    """Завершение → неизменяемый результат (ревизия 1 или ревизия уточнения), карта навыков, события.
    Повтор для завершённой сессии возвращает её результат."""
    await lock_user(session, user_id)
    await ensure_not_deleted(session, user_id)
    s = await own_session(session, user_id, session_id, for_update=True)
    if s.status == "finished":
        done = (await session.execute(select(Result).where(Result.session_id == s.session_id))).scalar_one()
        return result_out(done)
    ensure_open(s, now)
    ctx = await load_context(session, s)
    if not ctx.own:
        raise unprocessable("DIAGNOSTIC_EMPTY", "Нет ни одного ответа — результат не сохраняется")
    test = ctx.test
    if s.result_id is None:
        result_id, revision = uuid.uuid4(), 1
    else:
        result_id = s.result_id
        revision = int((await session.execute(
            select(Result.revision).where(Result.result_id == result_id).order_by(Result.revision.desc()).limit(1)
        )).scalar_one()) + 1
    prof = engine.profile(test, ctx.history, listening_available=ctx.base.listening_available)
    states = await skills_domain.apply_diagnostic(
        session, user_id=user_id, pair_id=s.pair_id, result_id=result_id, test=test, answers=ctx.own,
        snapshot=snapshot, now=now)
    area_bands = {a.area: a.band for a in prof.areas if a.status == "assessed"}
    recommended = _recommended(engine.recommend_start(snapshot, states, area_bands, prof.provisional_level,
                                                      s.segment)) if snapshot is not None else None
    areas = [a.public() for a in prof.areas]
    r = Result(result_id=result_id, revision=revision, session_id=s.session_id, user_id=user_id, pair_id=s.pair_id,
               test_id=test.test_id, test_version=test.version,
               profile={"areas": areas, "weak_areas": prof.weak_areas, "recommended_start": recommended,
                        "listening_available": ctx.base.listening_available, "segment": s.segment},
               provisional_level=prof.provisional_level,
               recommended_start_lesson_id=recommended["lesson_id"] if recommended else None, created_at=now)
    session.add(r)
    s.status, s.finished_at = "finished", now
    await session.flush()
    await emit(session, COMPLETED, {
        "user_id": str(user_id), "pair_id": s.pair_id, "result_id": str(result_id), "revision": revision,
        "test_id": test.test_id, "test_version": test.version, "provisional_level": prof.provisional_level,
        "areas": {a["area"]: {"status": a["status"], "band": a["band"], "confidence": a["confidence"]}
                  for a in areas},
        "recommended_start_lesson_id": r.recommended_start_lesson_id,
        "completed_at": now.isoformat().replace("+00:00", "Z"),
    }, producer=PRODUCER)
    return result_out(r)


async def start_followup(session: AsyncSession, *, user_id: uuid.UUID, result_id: uuid.UUID, area: str,
                         now: datetime) -> tuple[dict[str, Any], bool]:
    """Уточнение области результата → (DiagnosticSession, replayed). Только при needs_followup в последней
    ревизии, в течение 24 ч после завершения диагностики, один раз на область; незавершённое уточнение той же
    области возвращается как есть."""
    await lock_user(session, user_id)
    await ensure_not_deleted(session, user_id)
    latest = await result_revision(session, user_id, result_id)
    first = await result_revision(session, user_id, result_id, 1)

    def unavailable(reason: str) -> ApiError:
        return conflict("FOLLOWUP_NOT_AVAILABLE", "Уточнение по этой области недоступно",
                        {"area": area, "reason": reason})

    area_result = next((a for a in latest.profile.get("areas", []) if a.get("area") == area), None)
    if area_result is None or not area_result.get("needs_followup"):
        raise unavailable("not_needed")
    if now > first.created_at + FOLLOWUP_WINDOW:
        raise unavailable("window_closed")
    previous = (await session.execute(
        select(Session).where(Session.result_id == result_id, Session.followup_area == area)
        .order_by(Session.started_at.desc())
    )).scalars().all()
    if any(p.status == "finished" for p in previous):
        raise unavailable("already_done")
    open_one = next((p for p in previous if effective_status(p, now) == "in_progress"), None)
    if open_one is not None:
        return session_out(await load_context(session, open_one), now), True
    base = await session.get(Session, first.session_id)
    assert base is not None
    s = Session(session_id=uuid.uuid4(), user_id=user_id, pair_id=base.pair_id, test_id=base.test_id,
                test_version=base.test_version, seed=base.seed, segment=base.segment, status="in_progress",
                listening_available=True, followup_area=area, result_id=result_id, idempotency_key=None,
                started_at=now, expires_at=now + SESSION_TTL)
    ctx = await load_context_for_new(session, s)
    if ctx.current() is None:
        raise unavailable("no_items")
    await session.execute(
        update(Session).where(Session.user_id == user_id, Session.pair_id == base.pair_id,
                              Session.status == "in_progress").values(status="abandoned")
    )
    session.add(s)
    await session.flush()
    return session_out(ctx, now), False


async def load_context_for_new(session: AsyncSession, s: Session) -> Context:
    """Контекст ещё не сохранённой сессии уточнения (ответов у неё нет)."""
    assert s.result_id is not None
    test = await tests_domain.by_version(session, s.test_id, s.test_version)
    base, done = await _followup_chain(session, s.result_id)
    chain = [base, *done]
    by_session = await _answers_of(session, [x.session_id for x in chain])
    history = [_answered(a) for x in chain for a in by_session[x.session_id]]
    return Context(s, test, history, [], base)
