"""Личный словарь (INTERNAL_API §1.1, §1.2, §1.10): карточки из уроков, медиа и ошибок оценки, ручное добавление
слова из контента, «Знаю это», удаление, словарь и журнал ошибок.

- Карточка одна на (ученик, пара, вид, ключ): новый источник дописывает `sources`, пример (если его не было),
  допустимые ответы и отвлекающие варианты — дубль не создаётся.
- Свой текст ученика в карточки не попадает: только слова и фразы опубликованного контента и исправления оценщика
  (цитата ошибки `evidence` — только в карточке ошибки, стирается через 90 дней).
- Детям карточек ошибок не бывает (у них нет свободного текста).
- Не больше CARDS_LIMIT (2000) карточек на ученика → 422 CARDS_LIMIT.
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Final

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, TransientError, conflict
from tilhero_common.messaging import Envelope
from tilhero_memory import clients
from tilhero_memory.clients import CatalogGateway, ContentGone
from tilhero_memory.domain import explanations, fsrs, learners
from tilhero_memory.domain.common import (
    KIDS_BANDS,
    Localized,
    card_not_found,
    cards_limit,
    cursor_time_id,
    days_until,
    encode_cursor,
    gloss_unavailable,
    idempotency_reused,
    iso,
    lock_user,
    request_hash,
)
from tilhero_memory.domain.context import Ctx, now_of, settings_of
from tilhero_memory.domain.glossary import resolve
from tilhero_memory.domain.normalize import normalize, split_alternatives, word_count
from tilhero_memory.domain.views import dictionary_card, snapshot, strength
from tilhero_memory.models import Card, DeletedUser, FeedLog, Idempotency, PronunciationAttempt, ReviewLog
from tilhero_memory.settings import Settings

log = logging.getLogger("tilhero.memory.cards")

FEED_KINDS: Final = frozenset({"lesson", "scenario", "media"})
TURN_RE: Final = re.compile(r"^(?:T[0-9]{1,4}|O[0-9]{1,4}|OA[0-9]{1,3})$")
SEVERITIES: Final = frozenset({"low", "medium", "high"})
MAX_SOURCES: Final = 20
MAX_ANSWERS: Final = 8
MAX_DISTRACTORS: Final = 11
SOURCE_TITLE_KIND: Final = {"lesson": "lesson", "media": "media_asset", "reading": "reading", "scenario": "scenario"}
CONTENT_TO_SOURCE: Final = {"lesson": "lesson", "media_asset": "media", "reading": "reading", "scenario": "scenario"}


class CardsLimitReached(Exception):
    pass


@dataclass
class CardSpec:
    kind: str
    text_en: str
    gloss: Localized
    gloss_source: str
    example_en: str | None
    answers: list[str]
    source: dict[str, Any]
    distractors: list[dict[str, Any]] = field(default_factory=list)
    origin_lesson_id: str | None = None
    error: dict[str, Any] | None = None

    @property
    def key(self) -> str:
        text = self.error["correction"] if self.error is not None else self.text_en
        return normalize(text)[:200]


def _loc(value: Any) -> Localized | None:
    if isinstance(value, dict) and isinstance(value.get("ru"), str) and isinstance(value.get("uz"), str):
        return {"ru": value["ru"], "uz": value["uz"]}
    return None


def _merge_unique(base: list[Any], extra: list[Any], key: Any, limit: int) -> list[Any]:
    out = list(base)
    seen = {key(x) for x in out}
    for x in extra:
        k = key(x)
        if k and k not in seen and len(out) < limit:
            out.append(x)
            seen.add(k)
    return out


def log_row(card: Card, before: dict[str, Any], now: datetime, *, task_type: str, answer_mode: str,
            grade: str | None = None, hinted: bool = False, revealed: bool = False, elapsed_days: float | None = None,
            actor: str = "learner", actor_name: str | None = None, reason: str | None = None,
            session_id: uuid.UUID | None = None, task_id: uuid.UUID | None = None) -> ReviewLog:
    return ReviewLog(log_id=uuid.uuid4(), card_id=card.card_id, user_id=card.user_id, session_id=session_id,
                     task_id=task_id, task_type=task_type, answer_mode=answer_mode, grade=grade, hinted=hinted,
                     revealed=revealed, elapsed_days=round(elapsed_days, 6) if elapsed_days is not None else None,
                     before=before, after=snapshot(card), algorithm=fsrs.ALGORITHM,
                     params_version=fsrs.PARAMS_VERSION, actor=actor, actor_name=actor_name,
                     reason=reason[:300] if reason else None, created_at=now)


async def upsert_card(session: AsyncSession, user_id: uuid.UUID, pair_id: str, spec: CardSpec, now: datetime,
                      settings: Settings, *, restore_deleted: bool, actor: str = "learner") -> tuple[Card, bool]:
    """Новая карточка (status new, срок — сейчас) или новый источник существующей. restore_deleted — вернуть
    карточку, удалённую учеником (ручное добавление); архив системы (ошибка 90 дней, переоценка) возвращается всегда."""
    key = spec.key
    card = (await session.execute(select(Card).where(
        Card.user_id == user_id, Card.pair_id == pair_id, Card.kind == spec.kind, Card.key == key,
    ).with_for_update())).scalar_one_or_none()
    answers = list(dict.fromkeys(a.strip() for a in spec.answers if a and a.strip()))[:MAX_ANSWERS]
    if card is None:
        count = await session.scalar(select(func.count()).select_from(Card).where(
            Card.user_id == user_id, Card.status != "archived"))
        if int(count or 0) >= settings.cards_limit:
            raise CardsLimitReached()
        card = Card(card_id=uuid.uuid4(), user_id=user_id, pair_id=pair_id, kind=spec.kind, key=key,
                    text_en=spec.text_en[:200], gloss=spec.gloss, gloss_source=spec.gloss_source,
                    example_en=spec.example_en[:200] if spec.example_en else None, answers_en=answers,
                    distractors=spec.distractors[:MAX_DISTRACTORS], error=spec.error,
                    error_code=spec.error["error_code"] if spec.error else None,
                    origin_lesson_id=spec.origin_lesson_id, sources=[spec.source], status="new", fsrs_state="new",
                    stability=None, difficulty=None, reps=0, lapses=0, last_review_at=None, due_at=now,
                    archived_by=None, created_at=now, updated_at=now)
        session.add(card)
        await session.flush()
        return card, True
    src_key = (spec.source.get("kind"), spec.source.get("key"), spec.source.get("version"))
    if all((s.get("kind"), s.get("key"), s.get("version")) != src_key for s in card.sources) \
            and len(card.sources) < MAX_SOURCES:
        card.sources = [*card.sources, spec.source]
    if spec.example_en and not card.example_en:
        card.example_en = spec.example_en[:200]
    card.answers_en = _merge_unique(list(card.answers_en), answers, lambda a: normalize(a), MAX_ANSWERS)
    card.distractors = _merge_unique(list(card.distractors), spec.distractors,
                                     lambda d: normalize(str(d.get("en", ""))), MAX_DISTRACTORS)
    if card.origin_lesson_id is None and spec.origin_lesson_id:
        card.origin_lesson_id = spec.origin_lesson_id
    if spec.error is not None and card.error is not None:
        merged = dict(card.error)
        sessions = list(dict.fromkeys([*merged.get("sessions", []), *spec.error.get("sessions", [])]))[-20:]
        merged.update({"sessions": sessions, "evaluation_id": spec.error["evaluation_id"],
                       "turn_id": spec.error["turn_id"], "error_code": spec.error["error_code"]})
        if spec.error.get("evidence") and not merged.get("evidence"):
            merged["evidence"] = spec.error["evidence"]
        order = ["low", "medium", "high"]
        merged["severity"] = max(merged.get("severity", "low"), spec.error["severity"], key=order.index)
        card.error = merged
        card.error_code = merged["error_code"]
    if card.status == "archived" and (card.archived_by == "system" or restore_deleted):
        before = snapshot(card)
        card.status = card.fsrs_state
        card.archived_by = None
        if card.due_at is None or card.due_at < now:
            card.due_at = now
        session.add(log_row(card, before, now, task_type="restored", answer_mode="manual", actor=actor))
    card.updated_at = now
    return card, False


# ---------------------------------------------------------------- карточки из оценки (consumer assessment.*)


def parse_refs(raw: Any) -> dict[str, tuple[str, int]]:
    """content_refs записи оценки: список {kind, key, version} или словарь {lesson: {key, version}, …}."""
    out: dict[str, tuple[str, int]] = {}

    def add(kind: Any, ref: Any) -> None:
        if isinstance(ref, dict) and isinstance(ref.get("key"), str) and isinstance(ref.get("version"), int) \
                and not isinstance(ref.get("version"), bool) and isinstance(kind, str):
            out.setdefault(kind, (ref["key"], int(ref["version"])))

    if isinstance(raw, dict):
        for kind, refs in raw.items():
            for ref in refs if isinstance(refs, list) else [refs]:
                add(kind, ref)
    elif isinstance(raw, list):
        for ref in raw:
            if isinstance(ref, dict):
                add(ref.get("kind"), ref)
    return out


def _siblings(items: list[tuple[str, Localized]], own: str) -> list[dict[str, Any]]:
    return [{"en": en, "gloss": gloss} for en, gloss in items if en != own][:MAX_DISTRACTORS]


def specs_from_lesson(payload: dict[str, Any], key: str, version: int, at: str) -> list[CardSpec]:
    words = [(str(kw["en"]), g) for kw in payload.get("key_words") or []
             if isinstance(kw, dict) and isinstance(kw.get("en"), str) and (g := _loc(kw.get("gloss")))]
    examples = {str(kw.get("en")): kw.get("example_en") for kw in payload.get("key_words") or []
                if isinstance(kw, dict)}
    out = []
    for en, gloss in words:
        if not normalize(en):
            continue
        example = examples.get(en)
        out.append(CardSpec(
            kind="word" if word_count(en) == 1 else "phrase", text_en=en[:120], gloss=gloss, gloss_source="course",
            example_en=str(example)[:200] if isinstance(example, str) and example.strip() else None,
            answers=split_alternatives(en), distractors=_siblings(words, en),
            source={"kind": "lesson", "key": key, "version": version, "at": at}, origin_lesson_id=key))
    return out


def specs_from_media(payload: dict[str, Any], key: str, version: int, at: str) -> list[CardSpec]:
    """Фразы медиа — только если `rights.allowed_uses ∋ dictionary`; пример — реплика транскрипта с этой фразой."""
    raw_rights = payload.get("rights")
    rights: dict[str, Any] = raw_rights if isinstance(raw_rights, dict) else {}
    if "dictionary" not in (rights.get("allowed_uses") or []):
        return []
    phrases = [(str(p["en"]), g, p.get("t_ms")) for p in payload.get("phrases") or []
               if isinstance(p, dict) and isinstance(p.get("en"), str) and (g := _loc(p.get("gloss")))]
    lines = [ln for ln in payload.get("transcript") or [] if isinstance(ln, dict)]
    pairs = [(en, gloss) for en, gloss, _ in phrases]
    out = []
    for en, gloss, t_ms in phrases:
        if not normalize(en):
            continue
        example = None
        for ln in lines:
            start, end = ln.get("t_start_ms"), ln.get("t_end_ms")
            if isinstance(t_ms, int) and isinstance(start, int) and isinstance(end, int) and start <= t_ms < end:
                example = ln.get("text_en") if isinstance(ln.get("text_en"), str) else None
                break
        out.append(CardSpec(
            kind="word" if word_count(en) == 1 else "phrase", text_en=en[:120], gloss=gloss, gloss_source="course",
            example_en=example[:200] if example else None, answers=split_alternatives(en),
            distractors=_siblings(pairs, en), source={"kind": "media", "key": key, "version": version, "at": at}))
    return out


def error_specs(errors: Any, evaluation_id: str, session_id: str | None, content: dict[str, Any] | None,
                origin_lesson: str | None, at: str) -> list[CardSpec]:
    """Подтверждённые ошибки текста ученика (turn_id реплики T{n} или открытого ответа OA{n} / O{n}) → карточки
    error; ошибки закрытых заданий (item_id) не входят — их повторяет очередь lessons."""
    out: list[CardSpec] = []
    for e in errors if isinstance(errors, list) else []:
        if not isinstance(e, dict) or not isinstance(e.get("turn_id"), str) or not TURN_RE.match(e["turn_id"]):
            continue
        correction = e.get("correction")
        if not isinstance(correction, str) or not normalize(correction):
            continue
        code = explanations.known_code(e.get("error_code") if isinstance(e.get("error_code"), str) else None)
        evidence = e.get("evidence") if isinstance(e.get("evidence"), str) and e["evidence"].strip() else None
        error = {"correction": correction[:200], "evidence": evidence[:120] if evidence else None, "error_code": code,
                 "severity": e.get("severity") if e.get("severity") in SEVERITIES else "medium",
                 "evaluation_id": evaluation_id, "turn_id": e["turn_id"],
                 "sessions": [session_id] if session_id else []}
        source = content or {"kind": "evaluation", "key": evaluation_id, "version": None, "at": at}
        out.append(CardSpec(kind="error", text_en=correction[:200], gloss=explanations.label(code),
                            gloss_source="course", example_en=None, answers=[correction[:200]],
                            source={**source, "at": at}, origin_lesson_id=origin_lesson, error=error))
    return out


async def _is_kid(rt: Runtime, session: AsyncSession, user_id: uuid.UUID) -> bool:
    known = await learners.known_kid(session, user_id)
    if known is not None:
        return known
    prof = await clients.public_profile(rt, user_id)
    if prof is None:
        raise TransientError("identity-consent unavailable")
    band = prof.get("age_band")
    if band in learners.AGE_BANDS:
        await learners.upsert_age_band(session, user_id, str(band))
    return prof.get("kind") == "child" or band in KIDS_BANDS


async def on_assessment_event(rt: Runtime, catalog: CatalogGateway, session: AsyncSession, env: Envelope,
                              *, reevaluated: bool) -> None:
    """assessment.completed.v1 / assessment.reevaluated.v1 → memory-feed → карточки. Идемпотентно по evaluation_id
    (feed_log). Переоценка: ошибки сессии, которых нет в новой записи, архивируются (actor system, reevaluated)."""
    p = env.payload
    evaluation_id = uuid.UUID(str(p["evaluation_id"]))
    user_id = uuid.UUID(str(p["user_id"]))
    settings = settings_of(rt)
    now = now_of(rt)
    if await session.get(DeletedUser, user_id) is not None:
        return
    if await session.get(FeedLog, evaluation_id) is not None:
        return
    event_kind = str(p.get("kind") or "")
    if not reevaluated and event_kind not in FEED_KINDS:
        await lock_user(session, user_id)
        if await session.get(DeletedUser, user_id) is not None:
            return
        session.add(FeedLog(evaluation_id=evaluation_id, user_id=user_id, session_id=None, kind=event_kind[:10],
                            cards_added=0, processed_at=now))
        return
    feed = await clients.memory_feed(rt, evaluation_id, user_id)
    if feed is None or str(feed.get("user_id")) != str(user_id):
        session.add(FeedLog(evaluation_id=evaluation_id, user_id=user_id, session_id=None, kind=event_kind[:10] or "-",
                            cards_added=0, processed_at=now))
        return
    kind = str(feed.get("kind") or event_kind)
    pair_id = str(feed.get("pair_id") or p.get("pair_id") or settings.default_pair_id)[:16]
    feed_eval = str(feed.get("evaluation_id") or evaluation_id)
    feed_session = str(feed["session_id"]) if feed.get("session_id") else None
    at = iso(now) or ""
    refs = parse_refs(feed.get("content_refs"))
    specs: list[CardSpec] = []
    content: dict[str, Any] | None = None
    origin_lesson: str | None = None
    try:
        if kind == "lesson" and "lesson" in refs:
            key, ver = refs["lesson"]
            origin_lesson, content = key, {"kind": "lesson", "key": key, "version": ver}
            specs = specs_from_lesson(await catalog.version("lesson", key, ver), key, ver, at)
        elif kind == "media" and "media_asset" in refs:
            key, ver = refs["media_asset"]
            content = {"kind": "media", "key": key, "version": ver}
            specs = specs_from_media(await catalog.version("media_asset", key, ver), key, ver, at)
        elif kind == "scenario" and "scenario" in refs:
            key, ver = refs["scenario"]
            content = {"kind": "scenario", "key": key, "version": ver}
    except ContentGone:
        log.info("feed content gone", extra={"kind": kind})
        specs = []
    except ApiError:
        raise TransientError("catalog unavailable") from None
    errors = error_specs(feed.get("errors"), feed_eval, feed_session, content, origin_lesson, at) \
        if kind in FEED_KINDS else []
    if errors and await _is_kid(rt, session, user_id):
        errors = []
    if specs:
        entries = await catalog.forms(pair_id, [normalize(a) for s in specs for a in s.answers])
        for s in specs:
            own = {normalize(a) for a in s.answers}
            for entry in entries:
                forms = [f for f in entry.get("forms") or [] if isinstance(f, str)]
                if own & {normalize(f) for f in forms}:
                    s.answers = list(dict.fromkeys([*s.answers, *forms]))
    await lock_user(session, user_id)
    # повторная проверка под блокировкой: сага могла удалить ученика, пока шли запросы к assessment и catalog
    if await session.get(DeletedUser, user_id) is not None:
        return
    added = skipped = 0
    for s in [*specs, *errors]:
        try:
            _, created = await upsert_card(session, user_id, pair_id, s, now, settings, restore_deleted=False,
                                           actor="system")
            added += int(created)
        except CardsLimitReached:
            skipped += 1
    if reevaluated and feed_session:
        await _archive_reevaluated(session, user_id, feed_session, {s.key for s in errors}, now)
    if skipped:
        log.info("cards limit reached", extra={"skipped_count": skipped})
    for ev_id in dict.fromkeys([evaluation_id, uuid.UUID(feed_eval)]):
        if await session.get(FeedLog, ev_id) is None:
            session.add(FeedLog(evaluation_id=ev_id, user_id=user_id,
                                session_id=uuid.UUID(feed_session) if feed_session else None, kind=kind[:10],
                                cards_added=added, processed_at=now))


async def _archive_reevaluated(session: AsyncSession, user_id: uuid.UUID, session_id: str, keep: set[str],
                               now: datetime) -> None:
    rows = (await session.execute(select(Card).where(
        Card.user_id == user_id, Card.kind == "error", Card.status != "archived").with_for_update())).scalars().all()
    for card in rows:
        err = dict(card.error or {})
        sessions = [s for s in err.get("sessions", []) if isinstance(s, str)]
        if session_id not in sessions or card.key in keep:
            continue
        sessions.remove(session_id)
        err["sessions"] = sessions
        card.error = err
        if sessions:
            continue
        before = snapshot(card)
        card.status = "archived"
        card.archived_by = "system"
        card.updated_at = now
        session.add(log_row(card, before, now, task_type="manual", answer_mode="manual", actor="system",
                            reason="reevaluated"))


# ---------------------------------------------------------------- ручное добавление (ученик)


def _content_ref(source: dict[str, Any]) -> dict[str, Any]:
    ref = {"kind": source["kind"], "key": source["key"], "version": source["version"]}
    if source.get("locator"):
        ref["locator"] = source["locator"]
    return ref


async def add_manual(ctx: Ctx, text_en: str, source: dict[str, Any], idem_key: str) -> tuple[int, dict[str, Any]]:
    """POST /internal/v1/cards: слово или фраза опубликованного контента (catalog lookup) с переводом словаря курса
    (или ИИ). 201 — новая, 200 — уже была (источник добавлен). Повтор Idempotency-Key — тот же ответ."""
    prof = await _profile(ctx)
    ref = _content_ref(source)
    fp = request_hash({"text_en": text_en, "source": ref})
    async with ctx.rt.transaction() as db:
        await learners.ensure_not_deleted(db, ctx.user_id)
        prior = await db.get(Idempotency, (ctx.user_id, "cards.add", idem_key))
        if prior is not None:
            if prior.request_hash != fp:
                raise idempotency_reused()
            return prior.status_code, dict(prior.response)
    resolved = await resolve(ctx, prof, text_en, ref)
    entry = resolved.entry
    if entry is None:
        raise gloss_unavailable()
    gloss = _loc(entry.get("gloss"))
    if gloss is None:
        raise gloss_unavailable()
    forms = [f for f in entry.get("forms") or [] if isinstance(f, str)]
    example = entry.get("example_en") if isinstance(entry.get("example_en"), str) else None
    # текст карточки — фрагмент предложения контента (не сырой ввод ученика)
    surface = (resolved.surface or text_en).strip()[:120]
    spec = CardSpec(kind="word" if word_count(surface) == 1 else "phrase", text_en=surface, gloss=gloss,
                    gloss_source=str(entry.get("source")) if entry.get("source") in ("course", "methodist", "ai")
                    else "course",
                    example_en=(resolved.sentence_en or example or None),
                    answers=[*split_alternatives(surface), *forms],
                    source={"kind": CONTENT_TO_SOURCE[ref["kind"]], "key": ref["key"], "version": ref["version"],
                            "at": iso(ctx.now)},
                    origin_lesson_id=ref["key"] if ref["kind"] == "lesson" else None)
    async with ctx.rt.transaction() as db:
        await lock_user(db, ctx.user_id)
        await learners.ensure_not_deleted(db, ctx.user_id)
        prior = await db.get(Idempotency, (ctx.user_id, "cards.add", idem_key))
        if prior is not None:
            if prior.request_hash != fp:
                raise idempotency_reused()
            return prior.status_code, dict(prior.response)
        try:
            card, created = await upsert_card(db, ctx.user_id, prof.pair_id, spec, ctx.now, ctx.settings,
                                              restore_deleted=True)
        except CardsLimitReached:
            raise cards_limit(ctx.settings.cards_limit) from None
        status = 201 if created else 200
        body = dictionary_card(card, ctx.now)
        db.add(Idempotency(user_id=ctx.user_id, scope="cards.add", key=idem_key, request_hash=fp, status_code=status,
                           response=body, created_at=ctx.now))
    return status, body


async def _profile(ctx: Ctx) -> learners.Profile:
    async with ctx.rt.transaction() as db:
        return await learners.profile(db, ctx.learner, ctx.settings)


# ---------------------------------------------------------------- «Знаю это», удаление


async def _own(db: AsyncSession, user_id: uuid.UUID, card_id: uuid.UUID, *, lock: bool = True) -> Card:
    stmt = select(Card).where(Card.card_id == card_id, Card.user_id == user_id)
    card = (await db.execute(stmt.with_for_update() if lock else stmt)).scalar_one_or_none()
    if card is None or card.status == "archived":
        raise card_not_found()
    return card


def card_state(status: str) -> ApiError:
    return conflict("CARD_STATE", "Действие недоступно для карточки в этом состоянии", {"status": status})


async def mark_known(ctx: Ctx, card_id: uuid.UUID, known: bool) -> dict[str, Any]:
    async with ctx.rt.transaction() as db:
        await lock_user(db, ctx.user_id)
        await learners.ensure_not_deleted(db, ctx.user_id)
        card = await _own(db, ctx.user_id, card_id)
        if known and card.status in ("new", "learning", "review"):
            before = snapshot(card)
            card.status = "known"
            card.updated_at = ctx.now
            db.add(log_row(card, before, ctx.now, task_type="known", answer_mode="manual"))
        elif not known and card.status == "known":
            before = snapshot(card)
            card.status = card.fsrs_state
            card.due_at = ctx.now
            card.updated_at = ctx.now
            db.add(log_row(card, before, ctx.now, task_type="unknown", answer_mode="manual"))
        elif card.status == "frozen":
            raise card_state(card.status)
        return dictionary_card(card, ctx.now)


async def archive(ctx: Ctx, card_id: uuid.UUID) -> None:
    """DELETE /internal/v1/cards/{id} → archived (повтор — 204)."""
    async with ctx.rt.transaction() as db:
        await lock_user(db, ctx.user_id)
        await learners.ensure_not_deleted(db, ctx.user_id)
        card = (await db.execute(select(Card).where(Card.card_id == card_id, Card.user_id == ctx.user_id)
                                 .with_for_update())).scalar_one_or_none()
        if card is None:
            raise card_not_found()
        if card.status == "archived":
            return
        before = snapshot(card)
        card.status = "archived"
        card.archived_by = "learner"
        card.updated_at = ctx.now
        db.add(log_row(card, before, ctx.now, task_type="archived", answer_mode="manual"))


# ---------------------------------------------------------------- словарь, карточка, журнал ошибок


async def dictionary(ctx: Ctx, *, kind: str | None, status: str | None, q: str | None, cursor: str | None,
                     limit: int) -> dict[str, Any]:
    after = cursor_time_id(cursor)
    async with ctx.rt.transaction() as db:
        await learners.ensure_not_deleted(db, ctx.user_id)
        stmt = select(Card).where(Card.user_id == ctx.user_id, Card.status != "archived")
        if kind:
            stmt = stmt.where(Card.kind == kind)
        if status:
            stmt = stmt.where(Card.status == status)
        if q and q.strip():
            like = "%" + q.strip().lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            stmt = stmt.where(or_(func.lower(Card.text_en).like(like, escape="\\"),
                                  func.lower(Card.gloss["ru"].astext).like(like, escape="\\"),
                                  func.lower(Card.gloss["uz"].astext).like(like, escape="\\")))
        if after is not None:
            stmt = stmt.where(or_(Card.created_at < after[0], and_(Card.created_at == after[0],
                                                                   Card.card_id < after[1])))
        rows = (await db.execute(stmt.order_by(Card.created_at.desc(), Card.card_id.desc()).limit(limit + 1))
                ).scalars().all()
    items = [dictionary_card(c, ctx.now) for c in rows[:limit]]
    nxt = encode_cursor(rows[limit - 1].created_at.isoformat(), str(rows[limit - 1].card_id)) \
        if len(rows) > limit else None
    return {"items": items, "next_cursor": nxt}


async def _source_views(catalog: CatalogGateway, sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for s in sources:
        kind = str(s.get("kind"))
        title = None
        if kind in SOURCE_TITLE_KIND and isinstance(s.get("key"), str):
            title = await catalog.title(SOURCE_TITLE_KIND[kind], s["key"])
        out.append({"kind": kind if kind in ("lesson", "media", "reading", "scenario", "evaluation", "manual")
                    else "manual", "title": title, "at": s.get("at")})
    return out


async def detail(ctx: Ctx, card_id: uuid.UUID) -> dict[str, Any]:
    """DictionaryCardDetail: история последних 10 оценок, последняя попытка произношения."""
    async with ctx.rt.transaction() as db:
        await learners.ensure_not_deleted(db, ctx.user_id)
        card = await _own(db, ctx.user_id, card_id, lock=False)
        history = (await db.execute(select(ReviewLog).where(ReviewLog.card_id == card.card_id)
                                    .order_by(ReviewLog.created_at.desc(), ReviewLog.log_id.desc()).limit(10)
                                    )).scalars().all()
        pron = (await db.execute(select(PronunciationAttempt).where(
            PronunciationAttempt.user_id == ctx.user_id, PronunciationAttempt.card_id == card.card_id,
            PronunciationAttempt.status != "unavailable",
        ).order_by(PronunciationAttempt.created_at.desc()).limit(1))).scalar_one_or_none()
    body = dictionary_card(card, ctx.now)
    err = card.error
    body.update({
        "example_en": card.example_en,
        "error": {"correction": err.get("correction"), "evidence": err.get("evidence"),
                  "error_code": card.error_code or "other", "explanation": explanations.label(card.error_code)}
        if err is not None else None,
        "sources": await _source_views(ctx.catalog, list(card.sources)),
        "history": [{"at": iso(h.created_at), "grade": h.grade, "mode": h.answer_mode} for h in history],
        "next_review_in_days": None if card.status in ("known", "frozen") else days_until(card.due_at, ctx.now),
        "last_pronunciation": {"at": iso(pron.created_at), "intelligibility": pron.intelligibility}
        if pron is not None else None,
    })
    return body


async def errors_journal(ctx: Ctx, *, cursor: str | None, limit: int, kids: bool) -> dict[str, Any]:
    """Журнал ошибок (APP-MEM-01): карточки error и их сила, без цитаты; у детей журнала нет."""
    if kids:
        return {"items": [], "next_cursor": None}
    after = cursor_time_id(cursor)
    async with ctx.rt.transaction() as db:
        await learners.ensure_not_deleted(db, ctx.user_id)
        stmt = select(Card).where(Card.user_id == ctx.user_id, Card.kind == "error", Card.status != "archived")
        if after is not None:
            stmt = stmt.where(or_(Card.created_at < after[0], and_(Card.created_at == after[0],
                                                                   Card.card_id < after[1])))
        rows = (await db.execute(stmt.order_by(Card.created_at.desc(), Card.card_id.desc()).limit(limit + 1))
                ).scalars().all()
    items = []
    for c in rows[:limit]:
        err = c.error or {}
        lesson_title = None
        for s in c.sources:
            if s.get("kind") in SOURCE_TITLE_KIND and isinstance(s.get("key"), str):
                lesson_title = await ctx.catalog.title(SOURCE_TITLE_KIND[str(s["kind"])], s["key"])
                break
        items.append({"card_id": str(c.card_id), "correction": err.get("correction") or c.text_en,
                      "error_code": c.error_code or "other", "explanation": explanations.label(c.error_code),
                      "severity": err.get("severity") if err.get("severity") in SEVERITIES else "medium",
                      "strength": strength(c, ctx.now), "lesson_title": lesson_title, "created_at": iso(c.created_at)})
    nxt = encode_cursor(rows[limit - 1].created_at.isoformat(), str(rows[limit - 1].card_id)) \
        if len(rows) > limit else None
    return {"items": items, "next_cursor": nxt}


async def in_dictionary(db: AsyncSession, user_id: uuid.UUID, pair_id: str, keys: list[str]) -> uuid.UUID | None:
    keys = [k for k in dict.fromkeys(keys) if k]
    if not keys:
        return None
    return (await db.execute(select(Card.card_id).where(
        Card.user_id == user_id, Card.pair_id == pair_id, Card.kind.in_(("word", "phrase")), Card.key.in_(keys),
        Card.status != "archived").order_by(Card.created_at).limit(1))).scalar_one_or_none()


async def lookup(ctx: Ctx, texts: list[str], pair_hint: str | None) -> dict[str, Any]:
    """POST /internal/v1/cards/lookup: есть ли слова в словаре ученика (нормализация §1.6; любые карточки, кроме
    archived) — для ReadingView.glossary[].in_dictionary."""
    async with ctx.rt.transaction() as db:
        await learners.ensure_not_deleted(db, ctx.user_id)
        prof = await learners.profile(db, ctx.learner, ctx.settings, pair_hint, remember=False)
        keys = {t: normalize(t)[:200] for t in texts}
        wanted = [k for k in dict.fromkeys(keys.values()) if k]
        found: dict[str, uuid.UUID] = {}
        if wanted:
            rows = (await db.execute(select(Card.key, Card.card_id).where(
                Card.user_id == ctx.user_id, Card.pair_id == prof.pair_id, Card.key.in_(wanted),
                Card.status != "archived").order_by(Card.created_at))).all()
            for key, card_id in rows:
                found.setdefault(key, card_id)
    return {"items": [{"text": t, "card_id": str(found[keys[t]]) if keys[t] in found else None} for t in texts]}
