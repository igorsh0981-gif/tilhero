"""Сессии ученика (INTERNAL_API §2.2–2.4, bff.ts «Спринт 4»): карточка урока, старт урока/сценария/медиа/повтора,
текущий шаг, ответы, подсказки, «проще», пауза/продолжение/отмена, повтор ролевой ситуации, итоги, история.

Транзакции короткие: контент catalog (версии неизменяемы, кеш) и вызовы ИИ/assessment выполняются ВНЕ транзакции
с блокировкой ученика; команда затем перепроверяет состояние под блокировкой (повтор/гонка — идемпотентно).
Перед каждой командой ученика — «уборка» его незавершённой сессии (авто-пауза после бездействия, истечение).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, conflict, unprocessable
from tilhero_lessons import clients
from tilhero_lessons.catalog import CatalogGateway, ContentGone, catalog_unavailable
from tilhero_lessons.domain import evaluation, flow, machine
from tilhero_lessons.domain.common import (
    IdempotencyReused,
    answer_invalid,
    decode_cursor,
    digest,
    encode_cursor,
    free_text_not_allowed,
    iso,
    kids_not_allowed,
    lesson_not_available,
    lock_user,
    no_exercises,
    pair_not_available,
    seeded_order,
    session_active,
    session_not_found,
    session_state,
    step_not_current,
)
from tilhero_lessons.domain.content import MEDIA_ITEM_TYPES, Bundle, find_control_item, load_bundle, ref
from tilhero_lessons.domain.users import Learner, audience_for, ensure_not_deleted, is_child
from tilhero_lessons.models import ReviewItem, Session, Step, Turn
from tilhero_lessons.settings import Settings

SeedFactory = Callable[[], str]
log = logging.getLogger("tilhero.lessons.sessions")
RETRIEVAL_MAX = 3
KEYS_SEEN_SESSIONS = 50  # прошлых сессий урока, итоги которых просматриваются (R2-01)
MEDIA_TZ = "Asia/Tashkent"


def default_seed() -> str:
    return secrets.token_hex(16)


@dataclass
class Ctx:
    """Всё, что нужно команде: рантайм, catalog, настройки, часы, ученик."""

    rt: Runtime
    catalog: CatalogGateway
    settings: Settings
    now: datetime
    learner: Learner
    seed_factory: SeedFactory = default_seed


# ---------------------------------------------------------------- представления


def session_view(s: Session, settings: Settings) -> dict[str, Any]:
    """LessonSession (bff.ts)."""
    return {
        "session_id": str(s.session_id), "kind": s.kind, "title": s.title, "lesson_id": s.lesson_id,
        "scenario_id": s.scenario_id, "asset_id": s.asset_id, "status": s.status,
        "stage": s.stage if s.step_index > 0 else None, "stages": flow.stage_views(s), "ai_mode": s.ai_mode,
        "ai_degraded": s.ai_degraded, "started_at": iso(s.started_at), "paused_at": iso(s.paused_at),
        "finished_at": iso(s.finished_at), "expires_at": iso(machine.expires_at(s, settings)),
        "minutes": s.minutes if s.status in machine.TERMINAL else machine.minutes_of(s),
    }


def history_item(s: Session) -> dict[str, Any]:
    passed = s.evaluation.get("passed") if isinstance(s.evaluation, dict) else None
    return {"session_id": str(s.session_id), "kind": s.kind, "title": s.title, "status": s.status,
            "outcome": s.outcome if s.status == "completed" else None,
            "passed": passed if isinstance(passed, bool) else None,
            "minutes": s.minutes if s.status in machine.TERMINAL else machine.minutes_of(s),
            "evaluation_id": str(s.evaluation_id) if s.evaluation_id else None,
            "finished_at": iso(s.finished_at), "started_at": iso(s.started_at)}


# ---------------------------------------------------------------- общее


async def own(db: AsyncSession, learner: Learner, session_id: uuid.UUID, *, lock: bool = False) -> Session:
    """Сессия ученика из токена; чужая или несуществующая — 404 (не раскрываем существование)."""
    await ensure_not_deleted(db, learner.user_id)
    if lock:
        await lock_user(db, learner.user_id)
    s = await db.get(Session, session_id, populate_existing=True)
    if s is None or s.user_id != learner.user_id:
        raise session_not_found()
    return s


async def housekeep(ctx: Ctx) -> str | None:
    """Авто-пауза и истечение незавершённой сессии ученика (своя транзакция — фиксируется до команды)."""
    async with ctx.rt.transaction() as db:
        await ensure_not_deleted(db, ctx.learner.user_id)
        await lock_user(db, ctx.learner.user_id)
        s = (await db.execute(select(Session).where(
            Session.user_id == ctx.learner.user_id, Session.status.in_(machine.ACTIVE)))).scalar_one_or_none()
        if s is None:
            return None
        return await machine.housekeep(db, s, ctx.now, ctx.settings)


async def bundle_for(ctx: Ctx, s: Session) -> Bundle:
    """Контент зафиксированных версий. Версия исчезла из catalog (404) — сессия failed (content_unpublished)."""
    try:
        return await load_bundle(ctx.catalog, s.content_versions)
    except ContentGone:
        async with ctx.rt.transaction() as db:
            fresh = await own(db, ctx.learner, s.session_id, lock=True)
            if fresh.status in machine.ACTIVE:
                await machine.terminate(db, fresh, "failed", "content_unpublished", ctx.now, ctx.settings,
                                        fail_reason="content_unavailable")
        raise session_state("failed", reason="content_unavailable") from None


async def _load(ctx: Ctx, session_id: uuid.UUID) -> Session:
    async with ctx.rt.transaction() as db:
        return await own(db, ctx.learner, session_id)


def _ensure_active(s: Session) -> None:
    if s.status in machine.TERMINAL:
        raise session_state(s.status)


async def _wake(db: AsyncSession, s: Session, ctx: Ctx) -> None:
    """Команда шага у paused — авто-продолжение; у in_progress — учёт активного времени."""
    if s.status == "paused":
        await machine.resume(db, s, ctx.now)
    elif s.status == "ready":
        raise session_state(s.status)
    else:
        machine.accrue(s, ctx.now, ctx.settings)


# ---------------------------------------------------------------- пары, курс, урок


async def _course(ctx: Ctx, pair_id: str) -> tuple[bool, str]:
    info = await ctx.catalog.pair(pair_id)
    s = ctx.settings
    course = (info.course_id if info else None) or (s.default_course_id if pair_id == s.default_pair_id else "")
    return (info is not None and info.available and bool(course)), course


async def _snapshot_lesson(ctx: Ctx, course: str, lesson_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    snapshot = await ctx.catalog.snapshot(course) if course else None
    if snapshot is None:
        raise catalog_unavailable()
    entry = next((x for x in snapshot["lessons"] if x.get("lesson_id") == lesson_id), None)
    if entry is None:
        raise lesson_not_available()
    return snapshot, entry


async def _audience(ctx: Ctx, hint: str | None) -> str:
    async with ctx.rt.transaction() as db:
        await ensure_not_deleted(db, ctx.learner.user_id)
        return await audience_for(db, ctx.learner, hint)


async def card(ctx: Ctx, lesson_id: str, pair_id: str, hint: str | None) -> dict[str, Any]:
    """LessonCardDetail (APP-LESS-01): опубликованная версия урока, этапы с минутами, навык, формат ролевой ситуации."""
    available_pair, course = await _course(ctx, pair_id)
    if not course:
        raise lesson_not_available()
    snapshot, entry = await _snapshot_lesson(ctx, course, lesson_id)
    audience = await _audience(ctx, hint)
    published = await ctx.catalog.published("lesson", lesson_id, hint=_int_or_none(entry.get("version")))
    if published is None:
        raise lesson_not_available()
    version, lesson = published
    async with ctx.rt.transaction() as db:
        active = (await db.execute(select(Session.session_id).where(
            Session.user_id == ctx.learner.user_id, Session.status.in_(machine.ACTIVE), Session.kind == "lesson",
            Session.lesson_id == lesson_id))).scalar_one_or_none()
    skill_titles = {sk["skill_id"]: sk["title"] for sk in snapshot.get("skills") or []}
    primary = lesson["primary_skill_id"]
    audience_ok = audience in (lesson.get("audience") or [])
    reason = None if audience_ok and available_pair else ("audience" if not audience_ok else "pair_not_available")
    return {
        "lesson_id": lesson["lesson_id"], "module_id": lesson["module_id"], "title": lesson["title"],
        "goal": lesson["goal"], "level": lesson["level"], "kind": lesson["kind"],
        "duration_min": lesson["duration_min"], "primary_skill_id": primary, "scenario_id": lesson.get("scenario_id"),
        "stages": [{"type": x["type"], "minutes": x["minutes"]} for x in lesson["stages"]],
        "version": version,
        "primary_skill": {"skill_id": primary, "title": skill_titles.get(primary) or {"ru": primary, "uz": primary}},
        "stages_detail": [{"type": x["type"], "minutes": x["minutes"], "instructions": x["instructions"]}
                          for x in lesson["stages"]],
        "key_words_count": len(lesson.get("key_words") or []),
        # ИИ выключен (аварийная остановка) — карточка не обещает свободный ответ (ревью спринта 4)
        "roleplay_mode": None if not lesson.get("scenario_id") else await _ai_mode(ctx, audience),
        "available": reason is None, "unavailable_reason": reason,
        "active_session_id": str(active) if active else None,
    }


def _int_or_none(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 1 else None


# ---------------------------------------------------------------- старт


def _request_hash(*parts: object) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()


async def _replay(ctx: Ctx, key: str, rhash: str) -> Session | None:
    async with ctx.rt.transaction() as db:
        await ensure_not_deleted(db, ctx.learner.user_id)
        existing = (await db.execute(select(Session).where(
            Session.user_id == ctx.learner.user_id, Session.idempotency_key == key))).scalar_one_or_none()
    if existing is not None and existing.request_hash != rhash:
        raise IdempotencyReused
    return existing


async def _insert(ctx: Ctx, s: Session, key: str, rhash: str) -> tuple[Session, bool]:
    """Вставка под блокировкой ученика: повтор ключа → та же сессия; есть незавершённая → 409 SESSION_ACTIVE."""
    async with ctx.rt.transaction() as db:
        await ensure_not_deleted(db, ctx.learner.user_id)
        await lock_user(db, ctx.learner.user_id)
        existing = (await db.execute(select(Session).where(
            Session.user_id == ctx.learner.user_id, Session.idempotency_key == key))).scalar_one_or_none()
        if existing is not None:
            if existing.request_hash != rhash:
                raise IdempotencyReused
            return existing, True
        active = (await db.execute(select(Session).where(
            Session.user_id == ctx.learner.user_id, Session.status.in_(machine.ACTIVE)))).scalar_one_or_none()
        if active is not None:
            raise session_active(active.session_id, active.kind, active.title)
        s.idempotency_key, s.request_hash = key, rhash
        db.add(s)
        await db.flush()
        await machine.record_created(db, s, ctx.now)
    return s, False


def _new_session(ctx: Ctx, *, kind: str, pair_id: str, course_id: str | None, audience: str, locale: str,
                 title: dict[str, Any], level: str | None, duration: int, cv: dict[str, Any],
                 plan: list[dict[str, Any]], seed: str, ai_mode: str, **targets: Any) -> Session:
    return Session(
        session_id=uuid.uuid4(), user_id=ctx.learner.user_id, account_id=ctx.learner.account_id, kind=kind,
        pair_id=pair_id, course_id=course_id, title=title, level=level, audience=audience, locale=locale,
        # взрослый в «вариантах» на старте — ИИ выключен (_ai_mode): плашка упрощённого режима сразу; review — норма
        ai_mode=ai_mode, ai_degraded=ai_mode == "choices" and audience != "kids" and kind != "review",
        ai_used=False, hints_used=0, seed=seed, content_versions=cv,
        plan={"stages": plan}, state={"cursor": {"stage": 0, "unit": 0}, "turns": 0}, status="ready", stage=None,
        step_index=0, duration_min=duration, created_at=ctx.now, active_seconds=0, minutes=0,
        practice_only=kind == "review", evaluation_status="none", evaluation_attempts=0,
        summary=None, **targets)


async def _retrieval(ctx: Ctx, *, pair_id: str, lesson: dict[str, Any], snapshot: dict[str, Any], audience: str,
                     seed: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Повторение (AT-40): 2–3 задания — сначала очередь повторения (сроки наступили), иначе контрольные задания
    опубликованных уроков, где основной навык — предпосылка текущего; нечего — notice."""
    units: list[dict[str, Any]] = []
    refs: dict[tuple[str, int], dict[str, Any]] = {}
    async with ctx.rt.transaction() as db:
        due = (await db.execute(
            select(ReviewItem).where(ReviewItem.user_id == ctx.learner.user_id, ReviewItem.pair_id == pair_id,
                                     ReviewItem.resolved_at.is_(None), ReviewItem.due_at <= ctx.now,
                                     ReviewItem.lesson_id != lesson["lesson_id"])
            .order_by(ReviewItem.due_at, ReviewItem.id).limit(10))).scalars().all()
    for row in due:
        try:
            payload = await ctx.catalog.version("lesson", row.lesson_id, row.lesson_version)
        except ContentGone:
            continue
        if find_control_item(payload, row.item_id) is None:
            continue
        refs[(row.lesson_id, row.lesson_version)] = ref(row.lesson_id, row.lesson_version)
        units.append({"t": "item", "src": "retrieval", "key": row.lesson_id, "version": row.lesson_version,
                      "item_id": row.item_id, "review_item_id": str(row.id)})
        if len(units) == RETRIEVAL_MAX:
            break
    if len(units) < 2 and lesson.get("prerequisite_skill_ids"):
        prereqs = list(lesson["prerequisite_skill_ids"])
        states = await clients.skill_states(ctx.rt, ctx.learner.user_id, pair_id)
        rank = {"learning": 0, "demonstrated": 1, "retained": 2}
        prereqs.sort(key=lambda sk: rank.get((states or {}).get(sk, ""), 3))
        pools: list[list[dict[str, Any]]] = []
        for skill in prereqs:
            pool: list[dict[str, Any]] = []
            for entry in snapshot["lessons"]:
                if entry.get("primary_skill_id") != skill or entry.get("lesson_id") == lesson["lesson_id"] \
                        or audience not in (entry.get("audience") or []):
                    continue
                found = await ctx.catalog.published("lesson", entry["lesson_id"],
                                                    hint=_int_or_none(entry.get("version")))
                if found is None:
                    continue
                version, payload = found
                # сначала задания навыка-предпосылки, затем остальные задания того же урока — чтобы набрать 2–3,
                # когда у навыка в уроке одно задание (e2e спринта 4: l-20 давал одно задание)
                every = list(payload.get("control_items") or [])
                own_skill = [c for c in every if c.get("skill_id") == skill]
                rest = [c for c in every if c.get("skill_id") != skill]
                ordered = [*seeded_order(seed, f"retrieval:{skill}", own_skill, key=lambda c: str(c["item_id"])),
                           *seeded_order(seed, f"retrieval:{skill}:rest", rest, key=lambda c: str(c["item_id"]))]
                for c in ordered:
                    pool.append({"t": "item", "src": "retrieval", "key": entry["lesson_id"], "version": version,
                                 "item_id": c["item_id"], "review_item_id": None})
            pools.append(pool)
        taken = {(u["key"], u["item_id"]) for u in units}
        while len(units) < RETRIEVAL_MAX and any(pools):
            for pool in pools:
                while pool and (pool[0]["key"], pool[0]["item_id"]) in taken:
                    pool.pop(0)
                if pool and len(units) < RETRIEVAL_MAX:
                    u = pool.pop(0)
                    taken.add((u["key"], u["item_id"]))
                    refs[(u["key"], int(u["version"]))] = ref(u["key"], int(u["version"]))
                    units.append(u)
    return (units or [{"t": "notice"}]), list(refs.values())


def _meaning_unit(lesson: dict[str, Any], seed: str, locale: str) -> dict[str, Any] | None:
    """Проверка понимания: «что значит …» по ключевому слову; варианты — переводы других слов урока."""
    words = list(enumerate(lesson.get("key_words") or []))
    if len(words) < 2:
        return None
    word_i, word = seeded_order(seed, "meaning", words, key=lambda w: str(w[1]["en"]))[0]
    seen = {word["gloss"][locale]}
    others = []
    for i, w in seeded_order(seed, "meaning:distractors", words, key=lambda w: str(w[1]["en"])):
        if i != word_i and w["gloss"][locale] not in seen:
            seen.add(w["gloss"][locale])
            others.append(i)
        if len(others) == 2:
            break
    options = seeded_order(seed, "meaning:options", [word_i, *others], key=str)
    return {"t": "meaning", "word": word_i, "options": options, "correct": options.index(word_i)}


async def _keys_seen(ctx: Ctx, lesson_id: str) -> set[str]:
    """R2-01: задания урока, верный ответ к которым ученик уже видел — в итогах прошлых сессий этого урока (и повтора
    его ошибок) верный ответ показывается для заданий с ошибкой; история доступна в любой момент. В новой сессии
    такие задания уходят в оценку как `hinted` (правильность засчитывается, «демонстрирует» — нет)."""
    async with ctx.rt.transaction() as db:
        rows = (await db.execute(
            select(Session.evaluation).where(
                Session.user_id == ctx.learner.user_id, Session.lesson_id == lesson_id,
                Session.kind.in_(("lesson", "review")), Session.status == "completed",
                Session.evaluation.is_not(None))
            .order_by(Session.finished_at.desc()).limit(KEYS_SEEN_SESSIONS)
        )).scalars().all()
    return {str(i["item_id"]) for ev in rows if isinstance(ev, dict) for i in ev.get("items") or []
            if isinstance(i, dict) and i.get("correct") is False and i.get("item_id")}


async def start_lesson(ctx: Ctx, lesson_id: str, pair_id: str, hint: str | None, locale: str,
                       key: str) -> tuple[Session, bool]:
    rhash = _request_hash("lesson", lesson_id, pair_id)
    existing = await _replay(ctx, key, rhash)
    if existing is not None:
        return existing, True
    await housekeep(ctx)
    available_pair, course = await _course(ctx, pair_id)
    if not available_pair:
        raise pair_not_available(pair_id)
    snapshot, entry = await _snapshot_lesson(ctx, course, lesson_id)
    audience = await _audience(ctx, hint)
    if audience not in (entry.get("audience") or []):
        raise lesson_not_available()
    published = await ctx.catalog.published("lesson", lesson_id, hint=_int_or_none(entry.get("version")))
    if published is None:
        raise lesson_not_available()
    version, lesson = published
    if audience not in (lesson.get("audience") or []):
        raise lesson_not_available()
    rubric = await ctx.catalog.published("rubric", lesson["rubric_id"])
    if rubric is None:
        raise lesson_not_available()
    cv: dict[str, Any] = {"lesson": ref(lesson_id, version), "rubric": ref(lesson["rubric_id"], rubric[0])}
    scenario = None
    if lesson.get("scenario_id"):
        found = await ctx.catalog.published("scenario", lesson["scenario_id"])
        if found is not None and audience in (found[1].get("audience") or []):
            scenario = found
            cv["scenario"] = ref(lesson["scenario_id"], found[0])
    seed = ctx.seed_factory()
    retrieval, retrieval_refs = await _retrieval(ctx, pair_id=pair_id, lesson=lesson, snapshot=snapshot,
                                                 audience=audience, seed=seed)
    if retrieval_refs:
        cv["retrieval"] = retrieval_refs
    ai_mode = await _ai_mode(ctx, audience)
    meaning = _meaning_unit(lesson, seed, locale)
    seen = await _keys_seen(ctx, lesson_id)
    assessment: list[dict[str, Any]] = [{"t": "item", "src": "lesson", "item_id": c["item_id"],
                                         **({"key_seen": True} if c["item_id"] in seen else {})}
                                        for c in lesson.get("control_items") or []]
    if ai_mode == "full":
        assessment.append({"t": "open_answer"})  # открытое задание для оценщика — не детям, при ИИ
    plan = [
        {"type": "retrieval", "units": retrieval},
        {"type": "explanation", "units": [{"t": "explanation"}, *([meaning] if meaning else [])]},
        {"type": "roleplay", "units": [{"t": "roleplay"}] if scenario else []},
        {"type": "assessment", "units": assessment},
        {"type": "summary", "units": [{"t": "done"}]},
    ]
    s = _new_session(ctx, kind="lesson", pair_id=pair_id, course_id=course, audience=audience, locale=locale,
                     title=lesson["title"], level=lesson.get("level"), duration=int(lesson["duration_min"]), cv=cv,
                     plan=plan, seed=seed, ai_mode=ai_mode, lesson_id=lesson_id,
                     scenario_id=lesson.get("scenario_id") if scenario else None)
    return await _insert(ctx, s, key, rhash)


async def _bounded[T](call: Awaitable[T], seconds: float, fallback: T, what: str) -> T:
    """Необязательный вызов домена с собственным сроком (клиент runtime таймаут на запрос не принимает): не уложился —
    fallback, команда ученика не ждёт (цепочка таймаутов — README «Таймауты»)."""
    try:
        async with asyncio.timeout(seconds):
            return await call
    except TimeoutError:
        log.info("optional call timed out", extra={"call": what, "timeout_s": seconds})
        return fallback


async def _ai_mode(ctx: Ctx, audience: str) -> str:
    """Режим занятия на старте: дети и выключенный ИИ (аварийная остановка, провайдер не готов) — «варианты»
    (INTERNAL_API §2.1); исчерпание бюджета заранее не известно — деградация на первом отказе. Статус ai-gateway —
    не дольше AI_STATUS_TIMEOUT_SECONDS (2 с, R1-16): нет ответа — как ошибка связи, режим full (деградация на первом
    вызове), старт не ждёт таймаут вызова агента."""
    if audience == "kids":
        return "choices"
    available = await _bounded(clients.ai_available(ctx.rt), ctx.settings.ai_status_timeout_seconds, True,
                               "ai_status")
    return "full" if available else "choices"


async def start_scenario(ctx: Ctx, scenario_id: str, pair_id: str, hint: str | None, locale: str,
                         key: str) -> tuple[Session, bool]:
    """Практика «Разыграть» (AT-48): только ролевая ситуация → оценка по рубрике сценария → итоги."""
    rhash = _request_hash("scenario", scenario_id, pair_id)
    existing = await _replay(ctx, key, rhash)
    if existing is not None:
        return existing, True
    await housekeep(ctx)
    available_pair, course = await _course(ctx, pair_id)
    if not available_pair:
        raise pair_not_available(pair_id)
    audience = await _audience(ctx, hint)
    found = await ctx.catalog.published("scenario", scenario_id)
    if found is None or audience not in (found[1].get("audience") or []):
        raise lesson_not_available()
    version, scenario = found
    rubric = await ctx.catalog.published("rubric", scenario["rubric_id"])
    if rubric is None:
        raise lesson_not_available()
    cv = {"scenario": ref(scenario_id, version), "rubric": ref(scenario["rubric_id"], rubric[0])}
    plan = [{"type": "roleplay", "units": [{"t": "roleplay"}]}, {"type": "summary", "units": [{"t": "done"}]}]
    s = _new_session(ctx, kind="scenario", pair_id=pair_id, course_id=course or None, audience=audience,
                     locale=locale, title=scenario["title"], level=scenario.get("level"),
                     duration=ctx.settings.practice_duration_min, cv=cv, plan=plan, seed=ctx.seed_factory(),
                     ai_mode=await _ai_mode(ctx, audience), scenario_id=scenario_id)
    return await _insert(ctx, s, key, rhash)


def _rights_ok(media: dict[str, Any], today: date) -> bool:
    rights = media.get("rights") or {}
    if "UZ" not in (rights.get("territories") or []):
        return False
    try:
        if date.fromisoformat(rights["valid_from"]) > today:
            return False
        if rights.get("valid_to") and date.fromisoformat(rights["valid_to"]) < today:
            return False
    except (KeyError, TypeError, ValueError):
        return False
    return True


async def start_media(ctx: Ctx, asset_id: str, pair_id: str, hint: str | None, locale: str,
                      key: str) -> tuple[Session, bool]:
    """Практика к медиа (AT-48, APP-MEDIA-02): прослушивание → упражнения (понимание, пропуски, порядок реплик,
    значение фразы; shadowing и roleplay — до голоса) → оценка по ключам → итоги. Нет упражнений → 404."""
    rhash = _request_hash("media", asset_id, pair_id)
    existing = await _replay(ctx, key, rhash)
    if existing is not None:
        return existing, True
    await housekeep(ctx)
    available_pair, course = await _course(ctx, pair_id)
    if not available_pair:
        raise pair_not_available(pair_id)
    audience = await _audience(ctx, hint)
    found = await ctx.catalog.published("media_asset", asset_id)
    today = ctx.now.astimezone(ZoneInfo(MEDIA_TZ)).date()
    if found is None or audience not in (found[1].get("audience") or []) or not _rights_ok(found[1], today):
        raise lesson_not_available()
    version, media = found
    if "exercises" not in ((media.get("rights") or {}).get("allowed_uses") or []):
        raise no_exercises()
    listed = await ctx.catalog.media_exercises(asset_id, audience)
    if listed is None:
        raise lesson_not_available()
    exercises: list[tuple[int, dict[str, Any]]] = []
    for item in sorted(listed, key=lambda x: str(x["exercise_id"])):
        if item.get("type") not in MEDIA_ITEM_TYPES or item.get("asset_id", asset_id) != asset_id:
            continue
        hint_v = _int_or_none(item.get("version"))
        got = await ctx.catalog.published("media_exercise", item["exercise_id"], hint=hint_v)
        if got is None or got[1].get("type") not in MEDIA_ITEM_TYPES:
            continue
        exercises.append(got)
    if not exercises:
        raise no_exercises()
    cv: dict[str, Any] = {"media_asset": ref(asset_id, version),
                          "media_exercises": [ref(p["exercise_id"], v) for v, p in exercises]}
    rubric_id = next((p.get("rubric_id") for _, p in exercises if p.get("rubric_id")), None)
    if rubric_id:
        rubric = await ctx.catalog.published("rubric", str(rubric_id))
        if rubric is not None:
            cv["rubric"] = ref(str(rubric_id), rubric[0])
    plan = [{"type": "listen", "units": [{"t": "listen"}]},
            {"type": "exercises", "units": [{"t": "exercise", "key": p["exercise_id"], "version": v}
                                            for v, p in exercises]},
            {"type": "summary", "units": [{"t": "done"}]}]
    s = _new_session(ctx, kind="media", pair_id=pair_id, course_id=course or None, audience=audience, locale=locale,
                     title=media["title"], level=media.get("level"), duration=ctx.settings.practice_duration_min,
                     cv=cv, plan=plan, seed=ctx.seed_factory(), ai_mode=await _ai_mode(ctx, audience),
                     asset_id=asset_id)
    return await _insert(ctx, s, key, rhash)


async def start_review(ctx: Ctx, source_id: uuid.UUID, locale: str, key: str) -> tuple[Session, bool]:
    """Повтор проблемных заданий из итогов (без влияния на освоение — practice_only)."""
    rhash = _request_hash("review", source_id)
    existing = await _replay(ctx, key, rhash)
    if existing is not None:
        return existing, True
    await housekeep(ctx)
    async with ctx.rt.transaction() as db:
        src = await own(db, ctx.learner, source_id)
        audience = await audience_for(db, ctx.learner, None)
    wrong = [str(i.get("item_id")) for i in ((src.evaluation or {}).get("items") or [])
             if isinstance(i, dict) and i.get("correct") is False]
    if src.status != "completed" or not wrong:
        raise conflict("NOTHING_TO_REVIEW", "Заданий с ошибками для повтора нет")
    b = await bundle_for(ctx, src)
    units: list[dict[str, Any]] = []
    cv = {k: v for k, v in src.content_versions.items() if k != "retrieval"}
    exercises = {r["key"]: int(r["version"]) for r in cv.get("media_exercises") or []}
    for item_id in wrong:
        if b.lesson is not None and find_control_item(b.lesson, item_id) is not None:
            units.append({"t": "item", "src": "lesson", "item_id": item_id})
        elif item_id in exercises:
            units.append({"t": "exercise", "key": item_id, "version": exercises[item_id]})
    if not units:
        raise conflict("NOTHING_TO_REVIEW", "Заданий с ошибками для повтора нет")
    plan = [{"type": "assessment", "units": units}, {"type": "summary", "units": [{"t": "done"}]}]
    s = _new_session(ctx, kind="review", pair_id=src.pair_id, course_id=src.course_id, audience=audience,
                     locale=locale, title=src.title, level=src.level, duration=ctx.settings.practice_duration_min,
                     cv=cv, plan=plan, seed=ctx.seed_factory(), ai_mode="choices", source_session_id=src.session_id,
                     lesson_id=src.lesson_id, scenario_id=src.scenario_id, asset_id=src.asset_id)
    return await _insert(ctx, s, key, rhash)


# ---------------------------------------------------------------- просмотр, шаги


async def active(ctx: Ctx) -> dict[str, Any] | None:
    await housekeep(ctx)
    async with ctx.rt.transaction() as db:
        s = (await db.execute(select(Session).where(
            Session.user_id == ctx.learner.user_id, Session.status.in_(machine.ACTIVE)))).scalar_one_or_none()
        return session_view(s, ctx.settings) if s is not None else None


async def view(ctx: Ctx, session_id: uuid.UUID) -> dict[str, Any]:
    await housekeep(ctx)
    async with ctx.rt.transaction() as db:
        return session_view(await own(db, ctx.learner, session_id), ctx.settings)


async def current(ctx: Ctx, session_id: uuid.UUID) -> dict[str, Any]:
    """Текущий шаг: первый запрос → in_progress; у paused — авто-продолжение (ролевая ситуация — с ближайшей точки
    восстановления); шаги не теряются при обрыве и повторном входе."""
    await housekeep(ctx)
    s = await _load(ctx, session_id)
    _ensure_active(s)
    b = await bundle_for(ctx, s)
    async with ctx.rt.transaction() as db:
        s = await own(db, ctx.learner, session_id, lock=True)
        _ensure_active(s)
        if s.status == "ready":
            await machine.start(db, s, ctx.now)
            step = await flow.first_step(db, s, b, ctx.now)
        else:
            if s.status == "paused":
                await machine.resume(db, s, ctx.now)
                await flow.rewind_roleplay(db, s, b, ctx.now)
            else:
                machine.accrue(s, ctx.now, ctx.settings)
            found = await flow.current_step(db, s)
            step = found if found is not None else await flow.first_step(db, s, b, ctx.now)
        await db.flush()
        return await flow.render(db, s, step)


def _normalized(step_type: str, body: dict[str, Any]) -> dict[str, Any]:
    """Ответ в виде для хранения и сравнения повтора (тот же ответ → тот же результат)."""
    if step_type == "roleplay":
        if body.get("text") is not None:
            return {"text_sha": hashlib.sha256(str(body["text"]).strip().encode()).hexdigest()}
        return {"choice_id": body.get("choice_id")}
    if step_type == "item":
        dk = bool(body.get("dont_know"))
        value = body.get("answer")
        return {"answer": None if dk else (value.strip() if isinstance(value, str) else value), "dont_know": dk}
    if step_type == "open_answer":
        dk = bool(body.get("dont_know"))
        text = body.get("text") if body.get("text") is not None else body.get("answer")
        return {"text": None if dk or not isinstance(text, str) else text.strip(), "dont_know": dk}
    return {}


def _validate_shape(step_type: str, body: dict[str, Any]) -> None:
    has_text, has_choice = body.get("text") is not None, body.get("choice_id") is not None
    if step_type == "roleplay":
        if has_text == has_choice:
            raise answer_invalid("choice_id", "Нужен choice_id или text")
        if has_text and not str(body["text"]).strip():
            raise answer_invalid("text", "Пустая реплика")
    elif step_type == "open_answer":
        text = body.get("text") if has_text else body.get("answer")
        if not body.get("dont_know") and (not isinstance(text, str) or not text.strip()):
            raise answer_invalid("text", "Напишите ответ")
        if isinstance(text, str) and len(text.strip()) > flow.OPEN_ANSWER_MAX:
            raise answer_invalid("text", f"Не больше {flow.OPEN_ANSWER_MAX} символов")
    elif has_text or has_choice:
        raise answer_invalid("answer", "Этот шаг принимает только answer / dont_know")


async def _replayed(db: AsyncSession, s: Session, step: Step) -> dict[str, Any]:
    resp = dict(step.response or {})
    nxt = await flow.step_at(db, s, int(resp.get("next_seq", 0)))
    reply = resp.get("reply")
    if isinstance(reply, dict) and resp.get("reply_turn"):
        turn = (await db.execute(select(Turn).where(Turn.session_id == s.session_id,
                                                    Turn.turn_id == resp["reply_turn"]))).scalar_one_or_none()
        reply = {**reply, "text_en": (turn.text or "") if turn is not None else ""}
    return {"accepted": True, "feedback": resp.get("feedback"), "reply": reply,
            "next": await flow.render(db, s, nxt) if nxt is not None else None}


async def answer(ctx: Ctx, session_id: uuid.UUID, step_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """StepAnswer → StepResult. Повтор того же ответа на шаг → тот же результат; ответ не на текущий шаг →
    409 STEP_NOT_CURRENT; свободный текст ребёнку → 403 KIDS_NOT_ALLOWED."""
    await housekeep(ctx)
    s = await _load(ctx, session_id)
    if body.get("text") is not None:
        async with ctx.rt.transaction() as db:
            if s.audience == "kids" or await is_child(db, ctx.learner):
                raise kids_not_allowed()
    _ensure_active(s)
    b = await bundle_for(ctx, s)
    ai: clients.AgentResult | None = None
    if body.get("text") is not None:
        ai = await _converse(ctx, s, b, step_id, str(body["text"]).strip())
    async with ctx.rt.transaction() as db:
        s = await own(db, ctx.learner, session_id, lock=True)
        step = await flow.step_by_id(db, s, step_id)
        if step is None:
            raise step_not_current(f"s{s.step_index}" if s.step_index else None)
        _validate_shape(step.type, body)
        normalized = _normalized(step.type, body)
        if step.answered_at is not None:
            if step.answer == normalized:
                return await _replayed(db, s, step)
            raise step_not_current(f"s{s.step_index}")
        _ensure_active(s)
        if step.seq != s.step_index:
            raise step_not_current(f"s{s.step_index}")
        await _wake(db, s, ctx)
        result: str | None = None
        feedback: dict[str, Any] | None = None
        reply: dict[str, Any] | None = None
        reply_turn: str | None = None
        stored: Any = normalized
        if step.type == "done":
            raise session_state(s.status, action="finish")
        if step.type == "item":
            result, feedback, stored = await flow.answer_item(db, s, b, step, body.get("answer"),
                                                              bool(body.get("dont_know")), ctx.now, ctx.settings)
            nxt = await flow.advance(db, s, b, ctx.now)
        elif step.type == "roleplay":
            if body.get("choice_id") is not None:
                reply, nxt = await flow.roleplay_choice(db, s, b, step, str(body["choice_id"]), ctx.now)
            else:
                if not step.payload.get("free_text_allowed"):
                    raise free_text_not_allowed()
                agent = ai or clients.AgentResult("unavailable", "provider_error", None, str(uuid.uuid4()))
                turns_before = int(flow.st(s).get("turns", 0))
                reply, nxt = await flow.roleplay_text(db, s, b, step, str(body["text"]).strip(), agent, ctx.now)
                if agent.status == "ok" and reply.get("gloss") is None:
                    # текст ИИ хранится только в реплике (стирается по сроку), в ответе шага — ссылка
                    reply_turn = await _reply_turn(db, s, turns_before)
        elif step.type == "open_answer":
            result = "skipped" if normalized["dont_know"] else None
            nxt = await flow.advance(db, s, b, ctx.now)
        else:  # notice, explanation, listen, roleplay_end — «Дальше»
            nxt = await flow.advance(db, s, b, ctx.now)
        response = {"feedback": feedback, "reply": ({**reply, "text_en": None} if reply_turn and reply else reply),
                    "reply_turn": reply_turn, "next_seq": nxt.seq}
        flow.mark_answered(step, stored, result, response, ctx.now)
        await db.flush()
        return {"accepted": True, "feedback": feedback, "reply": reply, "next": await flow.render(db, s, nxt)}


async def _reply_turn(db: AsyncSession, s: Session, turns_before: int) -> str | None:
    """Реплика персонажа от ИИ, добавленная этим ответом (первая character-реплика после turns_before)."""
    await db.flush()
    row = (await db.execute(select(Turn.turn_id).where(
        Turn.session_id == s.session_id, Turn.seq > turns_before, Turn.speaker == "character", Turn.mode == "text")
        .order_by(Turn.seq).limit(1))).scalar_one_or_none()
    return row


async def _converse(ctx: Ctx, s: Session, b: Bundle, step_id: str, text: str) -> clients.AgentResult | None:
    """conversation_partner для свободной реплики (вне транзакции).
    None — ИИ не нужен (повтор ответа, не тот шаг, только варианты)."""
    async with ctx.rt.transaction() as db:
        s = await own(db, ctx.learner, s.session_id)
        step = await flow.step_by_id(db, s, step_id)
        if step is None or step.answered_at is not None or step.seq != s.step_index or step.type != "roleplay" \
                or not step.payload.get("free_text_allowed") or b.scenario is None:
            return None
        history = await flow.ai_history(db, s, step)
    scn = b.scenario
    node = scn["nodes"][step.payload["node_id"]]
    context = {
        "scenario": {"scenario_id": scn["scenario_id"], "title_en": scn["title"]["ru"], "task_en": scn["task"]["ru"],
                     "level": scn["level"],
                     "characters": [{"id": c["id"], "name": c["name"], "role_en": c["role"]["ru"]}
                                    for c in scn.get("characters") or []]},
        "node": {"node_id": step.payload["node_id"], "speaker": node["speaker"], "line_en": node["line_en"],
                 "transitions": [{"intent": t["intent"], "description_en": t["description"]["ru"],
                                  "examples_en": list(t.get("examples_en") or [])}
                                 for t in node.get("transitions") or []]},
        "history": history,
        "learner_turn": text[:500],
        "attempts_on_node": int(step.payload.get("unclear_attempts", 0)),
    }
    request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"lessons:{s.session_id}:{step_id}:{digest(text)}"))
    return await clients.invoke_agent(ctx.rt, "conversation_partner", request_id=request_id, session_id=s.session_id,
                                      session_kind=s.kind, user_id=s.user_id, audience=s.audience, locale=s.locale,
                                      context=context)


async def hint(ctx: Ctx, session_id: uuid.UUID, step_id: str) -> dict[str, Any]:
    await housekeep(ctx)
    s = await _load(ctx, session_id)
    _ensure_active(s)
    b = await bundle_for(ctx, s)
    async with ctx.rt.transaction() as db:
        s = await own(db, ctx.learner, session_id, lock=True)
        _ensure_active(s)
        step = flow.ensure_current(s, await flow.current_step(db, s), step_id)
        await _wake(db, s, ctx)
        return {"hint": await flow.hint(db, s, b, step)}


async def simpler(ctx: Ctx, session_id: uuid.UUID, locale: str | None = None) -> dict[str, Any]:
    """«Объясни проще» (APP-COACH): ИИ teaching_coach при ai_mode full (не детям), иначе следующий пример урока;
    позиция урока не меняется. ИИ недоступен — пример урока, ИИ не вызывается до конца этапа."""
    await housekeep(ctx)
    s = await _load(ctx, session_id)
    _ensure_active(s)
    b = await bundle_for(ctx, s)

    def _check(sess: Session, step: Any) -> None:
        if step is None or step.stage != "explanation" or b.lesson is None:
            raise conflict("SIMPLER_NOT_AVAILABLE", "«Объясни проще» доступно на этапе объяснения")

    async with ctx.rt.transaction() as db:
        s = await own(db, ctx.learner, session_id)
        _ensure_active(s)
        _check(s, await flow.current_step(db, s))
        child = await is_child(db, ctx.learner)
    shown = list(flow.st(s).get("simpler_shown") or [])
    ai: clients.AgentResult | None = None
    if s.ai_mode == "full" and s.audience != "kids" and not child and not flow.ai_off(s, "explanation"):
        assert b.lesson is not None
        lesson = b.lesson
        context = {
            "lesson": {"lesson_id": lesson["lesson_id"], "title_en": lesson["title"]["ru"],
                       "goal_en": lesson["goal"]["ru"], "level": lesson["level"],
                       "key_words": [k["en"] for k in lesson.get("key_words") or []],
                       "examples_en": [e["en"] for e in lesson.get("examples") or []]},
            "request": "simpler_example", "explain_locale": locale or s.locale,
            "already_shown": [*(e["en"] for e in lesson.get("examples") or []), *shown][-20:],
        }
        n = int(flow.st(s).get("simpler", 0))
        ai = await clients.invoke_agent(
            ctx.rt, "teaching_coach", request_id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"lessons:{s.session_id}:sim:{n}")),
            session_id=s.session_id, session_kind=s.kind, user_id=s.user_id, audience=s.audience,
            locale=locale or s.locale, context=context)
    async with ctx.rt.transaction() as db:
        s = await own(db, ctx.learner, session_id, lock=True)
        _ensure_active(s)
        _check(s, await flow.current_step(db, s))
        await _wake(db, s, ctx)
        n = int(flow.st(s).get("simpler", 0))
        flow.put(s, simpler=n + 1)
        if ai is not None and ai.status == "ok" and ai.output is not None:
            out = ai.output
            s.ai_used = True
            example = str(out.get("example_en") or "")[:160]
            flow.put(s, simpler_shown=[*shown, example][-10:])
            text, gloss = str(out.get("explanation") or "")[:400], str(out.get("example_gloss") or "")[:200]
            return {"explanation": {"ru": text, "uz": text}, "example_en": example,
                    "example_gloss": {"ru": gloss, "uz": gloss}, "source": "ai"}
        if ai is not None:
            if ai.status == "unavailable":
                s.ai_degraded = True
            flow.put(s, ai_off="all" if ai.status == "refused" else "explanation")
        examples = flow.lesson_examples(b)
        en, gloss_l = examples[n % len(examples)]
        return {"explanation": None, "example_en": en, "example_gloss": gloss_l, "source": "lesson"}


async def retry(ctx: Ctx, session_id: uuid.UUID) -> dict[str, Any]:
    await housekeep(ctx)
    s = await _load(ctx, session_id)
    _ensure_active(s)
    b = await bundle_for(ctx, s)
    async with ctx.rt.transaction() as db:
        s = await own(db, ctx.learner, session_id, lock=True)
        _ensure_active(s)
        step = await flow.current_step(db, s)
        if step is None:
            raise conflict("RETRY_NOT_AVAILABLE", "Повторная попытка недоступна")
        await _wake(db, s, ctx)
        nxt = await flow.roleplay_retry(db, s, b, step, ctx.now)
        await db.flush()
        return await flow.render(db, s, nxt)


# ---------------------------------------------------------------- пауза, продолжение, отмена


async def pause(ctx: Ctx, session_id: uuid.UUID) -> dict[str, Any]:
    happened = await housekeep(ctx)
    async with ctx.rt.transaction() as db:
        s = await own(db, ctx.learner, session_id, lock=True)
        if not (s.status == "paused" and happened == "auto_pause"):
            await machine.pause(db, s, ctx.now, ctx.settings)
        return session_view(s, ctx.settings)


async def resume(ctx: Ctx, session_id: uuid.UUID) -> dict[str, Any]:
    await housekeep(ctx)
    s = await _load(ctx, session_id)
    if s.status != "paused":
        raise session_state(s.status)
    b = await bundle_for(ctx, s)
    async with ctx.rt.transaction() as db:
        s = await own(db, ctx.learner, session_id, lock=True)
        await machine.resume(db, s, ctx.now)
        await flow.rewind_roleplay(db, s, b, ctx.now)
        return session_view(s, ctx.settings)


async def cancel(ctx: Ctx, session_id: uuid.UUID) -> dict[str, Any]:
    await housekeep(ctx)
    async with ctx.rt.transaction() as db:
        s = await own(db, ctx.learner, session_id, lock=True)
        await machine.terminate(db, s, "cancelled", "cancel", ctx.now, ctx.settings)
        return session_view(s, ctx.settings)


# ---------------------------------------------------------------- итоги


async def _skill_titles(ctx: Ctx, s: Session) -> dict[str, Any]:
    course = s.course_id or ctx.settings.default_course_id
    snapshot = await ctx.catalog.snapshot(course)
    return {sk["skill_id"]: sk["title"] for sk in (snapshot or {}).get("skills") or []}


async def _next_lesson(ctx: Ctx, s: Session) -> dict[str, Any] | None:
    if s.status != "completed":
        return None
    card_ = await _bounded(clients.next_lesson_card(ctx.rt, s.user_id, s.pair_id, s.audience),
                           ctx.settings.summary_aux_timeout_seconds, None, "next_lesson")
    # план ещё не пересчитан по событию (тот же урок) — следующий урок появится позже
    if card_ is not None and s.kind == "lesson" and card_["lesson_id"] == s.lesson_id:
        return None
    return card_


async def _before_and_titles(ctx: Ctx, s: Session) -> tuple[dict[str, str] | None, dict[str, Any]]:
    """«Было» навыков (diagnostics) и названия навыков (снимок курса) — параллельно, до запроса оценки (после него
    карта может уже измениться по событию assessment) и не дольше SUMMARY_AUX_TIMEOUT_SECONDS: не успели — итоги
    без изменений навыков / с кодами навыков вместо названий."""
    if s.kind == "review":
        return None, {}
    before, titles = await asyncio.gather(
        _bounded(clients.skill_states(ctx.rt, s.user_id, s.pair_id), ctx.settings.summary_aux_timeout_seconds,
                 None, "skill_states"),
        _bounded(_skill_titles(ctx, s), ctx.settings.summary_aux_timeout_seconds, {}, "skill_titles"))
    return before, titles


async def finish(ctx: Ctx, session_id: uuid.UUID) -> dict[str, Any]:
    """POST …/finish (идемпотентно): EvaluationRequest → assessment (ASSESSMENT_TIMEOUT_SECONDS, 30 с) → completed,
    событие (один раз), LessonSummary. assessment недоступен — completed без оценки («оценка появится позже»),
    повтор — tick. Вместе с второстепенными вызовами (≤ 2 + 2 с) — меньше таймаута BFF для finish (35 с)."""
    await housekeep(ctx)
    async with ctx.rt.transaction() as db:
        s = await own(db, ctx.learner, session_id)
        if s.status == "completed":
            done = s
        else:
            done = None
            _ensure_active(s)
            step = await flow.current_step(db, s)
            if step is None or step.type != "done":
                raise step_not_current(step.step_id if step is not None else None)
            body = evaluation.build_request(s, await evaluation.steps_of(db, s), await evaluation.turns_of(db, s))
    if done is not None:
        return evaluation.summary_view(done, await _next_lesson(ctx, done))
    b = await bundle_for(ctx, s)
    before, titles = await _before_and_titles(ctx, s)
    result = await clients.request_evaluation(ctx.rt, s.user_id, body)
    async with ctx.rt.transaction() as db:
        s = await own(db, ctx.learner, session_id, lock=True)
        if s.status != "completed":
            _ensure_active(s)
            step = await flow.current_step(db, s)
            if step is None or step.type != "done":
                raise step_not_current(step.step_id if step is not None else None)
            s.summary = {"skills": [], "key_words": evaluation.key_words(s, b), "can_review": False}
            if result is not None:
                await evaluation.apply(db, s, b, result, before, titles, ctx.now, ctx.settings)
            else:
                s.evaluation_status = "pending"
            await machine.finish(db, s, ctx.now, ctx.settings)
    return evaluation.summary_view(s, await _next_lesson(ctx, s))


async def summary(ctx: Ctx, session_id: uuid.UUID) -> dict[str, Any]:
    """Итоги завершённой сессии. Актуальная оценка (после переоценки или апелляции) — повторным POST в assessment
    (идемпотентен по session_id, оценка уже есть — без ИИ); assessment недоступен или не ответил за
    SUMMARY_REFRESH_TIMEOUT_SECONDS (5 с, меньше таймаута BFF 25 с) — сохранённая копия."""
    async with ctx.rt.transaction() as db:
        s = await own(db, ctx.learner, session_id)
        body = (evaluation.build_request(s, await evaluation.steps_of(db, s), await evaluation.turns_of(db, s))
                if s.status == "completed" and s.evaluation_status == "done" else None)
    if s.status not in machine.TERMINAL:
        raise session_state(s.status)
    if body is not None:
        result = await _bounded(clients.request_evaluation(ctx.rt, s.user_id, body),
                                ctx.settings.summary_refresh_timeout_seconds, None, "evaluation_refresh")
        if result is not None and result.view.get("evaluation_id") is not None:
            async with ctx.rt.transaction() as db:
                s = await own(db, ctx.learner, session_id, lock=True)
                if s.evaluation_status == "done":
                    evaluation.store(s, result, ctx.now)
    return evaluation.summary_view(s, await _next_lesson(ctx, s))


async def history(ctx: Ctx, kind: str | None, cursor: str | None, limit: int) -> dict[str, Any]:
    """Page<LessonHistoryItem>: свои сессии, новые первыми."""
    after = decode_cursor(cursor, 2)
    async with ctx.rt.transaction() as db:
        await ensure_not_deleted(db, ctx.learner.user_id)
        stmt = select(Session).where(Session.user_id == ctx.learner.user_id)
        if kind:
            stmt = stmt.where(Session.kind == kind)
        if after is not None:
            try:
                at, sid = datetime.fromisoformat(str(after[0])), uuid.UUID(str(after[1]))
            except ValueError:
                raise unprocessable("INVALID_CURSOR", "Некорректный курсор") from None
            stmt = stmt.where(or_(Session.created_at < at, and_(Session.created_at == at, Session.session_id < sid)))
        rows = (await db.execute(stmt.order_by(Session.created_at.desc(), Session.session_id.desc())
                                 .limit(limit + 1))).scalars().all()
    page = list(rows[:limit])
    nxt = encode_cursor(page[-1].created_at.isoformat(), str(page[-1].session_id)) \
        if len(rows) > limit and page else None
    return {"items": [history_item(r) for r in page], "next_cursor": nxt}


def idempotency_reused() -> ApiError:
    return unprocessable("IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными")


__all__ = ["Ctx", "IdempotencyReused"]
