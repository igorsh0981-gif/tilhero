"""API ученика (Mini App → telegram-bff → memory), INTERNAL_API §1.10, формы bff.ts «Спринт 5».

Ученик — `lrn` внутреннего токена, аккаунт — `sub` (никогда из пути или тела): чужие карточки и сессии — 404.
Ключи ответов наружу не уходят; верный ответ проверки удержания — только в конце блока.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse, Response

from tilhero_memory.api.common import idempotency_key, learner_ctx, pair_param
from tilhero_memory.audio import audio_of
from tilhero_memory.domain import cards, glossary, learners, pronunciation, review
from tilhero_memory.domain.context import Ctx
from tilhero_memory.domain.normalize import normalize
from tilhero_memory.schemas import AddCardIn, HintIn, LookupIn, ReviewAnswerIn, TranslateIn

router = APIRouter(prefix="/internal/v1", tags=["client"])

_COMMON: dict[int | str, dict[str, Any]] = {
    401: {"description": "INTERNAL_TOKEN_*"}, 403: {"description": "CALLER_NOT_ALLOWED"},
    410: {"description": "USER_DELETED"},
}
_SESSION: dict[int | str, dict[str, Any]] = {
    **_COMMON, 404: {"description": "REVIEW_SESSION_NOT_FOUND | TASK_NOT_FOUND"},
    409: {"description": "REVIEW_SESSION_STATE {status} | TASK_NOT_CURRENT {current_task_id} | HINTS_NOT_ALLOWED"},
}


# ---------------------------------------------------------------- обзор и словарь


@router.get("/overview", responses=_COMMON)
async def overview(pair_id: str | None = Depends(pair_param), ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """MemoryOverview."""
    return await review.overview(ctx, pair_id)


@router.get("/cards", responses={**_COMMON, 400: {"description": "INVALID_CURSOR"}})
async def list_cards(kind: Literal["word", "phrase", "error"] | None = Query(default=None),
                     status: Literal["new", "learning", "review", "known", "frozen"] | None = Query(default=None),
                     q: str | None = Query(default=None, max_length=60),
                     cursor: str | None = Query(default=None, max_length=300),
                     limit: int = Query(default=20, ge=1, le=100),
                     ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """Page<DictionaryCard> — свои карточки (без archived), новые первыми; q — по английскому и переводу."""
    return await cards.dictionary(ctx, kind=kind, status=status, q=q, cursor=cursor, limit=limit)


@router.post("/cards/lookup", responses=_COMMON)
async def lookup_cards(body: LookupIn, pair_id: str | None = Depends(pair_param),
                       ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """{items: [{text, card_id | null}]} — есть ли слова в словаре ученика (ReadingView.glossary[].in_dictionary)."""
    return await cards.lookup(ctx, list(body.texts), pair_id)


@router.post("/cards", status_code=201, responses={
    **_COMMON, 200: {"description": "карточка уже была — источник добавлен (или повтор Idempotency-Key)"},
    404: {"description": "CONTENT_NOT_FOUND"},
    422: {"description": "WORD_NOT_IN_CONTENT | GLOSS_UNAVAILABLE | CARDS_LIMIT {limit} | IDEMPOTENCY_KEY_*"},
    503: {"description": "CATALOG_UNAVAILABLE"}})
async def add_card(body: AddCardIn, key: str | None = Header(default=None, alias="Idempotency-Key"),
                   ctx: Ctx = Depends(learner_ctx)) -> JSONResponse:
    """DictionaryCard: только слово или фраза опубликованного контента (проверяется catalog), свой текст — нельзя."""
    k = idempotency_key(key)
    source = body.source.model_dump(exclude={"text_en"})
    status, card = await cards.add_manual(ctx, str(body.text_en), source, k)
    return JSONResponse(card, status_code=status)


@router.get("/cards/{card_id}", responses={**_COMMON, 404: {"description": "CARD_NOT_FOUND"}})
async def card_detail(card_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """DictionaryCardDetail."""
    return await cards.detail(ctx, card_id)


@router.post("/cards/{card_id}/known", responses={**_COMMON, 404: {"description": "CARD_NOT_FOUND"},
                                                  409: {"description": "CARD_STATE {status}"}})
async def mark_known(card_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """«Знаю это» — status known (не оценка FSRS), в повторение не попадает."""
    return await cards.mark_known(ctx, card_id, True)


@router.delete("/cards/{card_id}/known", responses={**_COMMON, 404: {"description": "CARD_NOT_FOUND"}})
async def unmark_known(card_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """Вернуть в повторение (срок — сейчас)."""
    return await cards.mark_known(ctx, card_id, False)


@router.delete("/cards/{card_id}", status_code=204, response_class=Response,
               responses={**_COMMON, 404: {"description": "CARD_NOT_FOUND"}})
async def delete_card(card_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> Response:
    """Убрать из словаря (archived)."""
    await cards.archive(ctx, card_id)
    return Response(status_code=204)


@router.get("/errors", responses={**_COMMON, 400: {"description": "INVALID_CURSOR"}})
async def errors_journal(cursor: str | None = Query(default=None, max_length=300),
                         limit: int = Query(default=20, ge=1, le=100),
                         ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """Page<ErrorJournalItem> — без цитаты ошибки; у детей журнала нет."""
    async with ctx.rt.transaction() as db:
        await learners.ensure_not_deleted(db, ctx.user_id)
        prof = await learners.profile(db, ctx.learner, ctx.settings)
    return await cards.errors_journal(ctx, cursor=cursor, limit=limit, kids=prof.kids)


# ---------------------------------------------------------------- «Повторение дня»


@router.post("/review-sessions", status_code=201, responses={
    **_COMMON, 200: {"description": "активная сессия или повтор Idempotency-Key"},
    409: {"description": "NOTHING_TO_REVIEW {next_due_at}"},
    422: {"description": "IDEMPOTENCY_KEY_INVALID"}})
async def start_session(pair_id: str | None = Depends(pair_param),
                        key: str | None = Header(default=None, alias="Idempotency-Key"),
                        ctx: Ctx = Depends(learner_ctx)) -> JSONResponse:
    """ReviewSession."""
    status, body = await review.start(ctx, pair_id, idempotency_key(key))
    return JSONResponse(body, status_code=status)


@router.get("/review-sessions/active", responses=_COMMON)
async def active_session(ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    return {"session": await review.active_session(ctx)}


@router.get("/review-sessions/{session_id}", responses=_SESSION)
async def get_session(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    return await review.get_session(ctx, session_id)


@router.get("/review-sessions/{session_id}/current", responses=_SESSION)
async def current_task(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """ReviewTask (без ключа). Все задания пройдены — 409 TASK_NOT_CURRENT {current_task_id: null} → finish."""
    return await review.current(ctx, session_id)


@router.post("/review-sessions/{session_id}/tasks/{task_id}",
             responses={**_SESSION, 422: {"description": "ANSWER_INVALID {field}"}})
async def answer_task(session_id: uuid.UUID, task_id: uuid.UUID, body: ReviewAnswerIn,
                      ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """ReviewTaskResult. Повтор — тот же результат."""
    return await review.answer(ctx, session_id, task_id, body.as_dict())


@router.post("/review-sessions/{session_id}/tasks/{task_id}/hint", responses=_SESSION)
async def task_hint(session_id: uuid.UUID, task_id: uuid.UUID, body: HintIn,
                    ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """ReviewHint: first_letter | reveal («Не помню» — оценка again)."""
    return await review.hint(ctx, session_id, task_id, body.kind)


@router.post("/review-sessions/{session_id}/finish", responses=_SESSION)
async def finish_session(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """ReviewSummary (повтор — тот же итог)."""
    return await review.finish(ctx, session_id)


@router.post("/review-sessions/{session_id}/cancel", responses=_SESSION)
async def cancel_session(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """ReviewSession (cancelled; ответы остаются)."""
    return await review.cancel(ctx, session_id)


# ---------------------------------------------------------------- перевод и произношение


@router.post("/translate", responses={**_COMMON, 404: {"description": "CONTENT_NOT_FOUND"},
                                      422: {"description": "WORD_NOT_IN_CONTENT"},
                                      503: {"description": "CATALOG_UNAVAILABLE"}})
async def translate(body: TranslateIn, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """WordGloss: словарь курса → кеш → teaching_coach (gloss_word). Только слово из этого опубликованного текста."""
    ref = body.ref.model_dump(exclude_none=True)
    async with ctx.rt.transaction() as db:
        await learners.ensure_not_deleted(db, ctx.user_id)
        prof = await learners.profile(db, ctx.learner, ctx.settings)
    resolved = await glossary.resolve(ctx, prof, body.text, ref)
    entry = resolved.entry
    keys = [normalize(body.text)]
    if entry is not None and isinstance(entry.get("lemma"), str):
        keys.append(normalize(entry["lemma"]))
    async with ctx.rt.transaction() as db:
        card_id = await cards.in_dictionary(db, ctx.user_id, prof.pair_id, keys)
    return glossary.word_gloss(body.text, entry, card_id, resolved.note)


@router.post("/pronunciation", responses={
    **_COMMON, 403: {"description": "VOICE_CONSENT_REQUIRED {who: self | guardian} | CALLER_NOT_ALLOWED"},
    404: {"description": "CARD_NOT_FOUND | CONTENT_NOT_FOUND"},
    422: {"description": "AUDIO_INVALID {reason: format | too_short | too_long | too_large} | REFERENCE_INVALID"},
    503: {"description": "SPEECH_UNAVAILABLE | CATALOG_UNAVAILABLE"}})
async def assess_pronunciation(request: Request,
                               target_kind: Literal["card", "sentence"] | None = Query(default=None),
                               target: str = Query(min_length=3, max_length=160),
                               ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """PronunciationView. Тело — audio/wav; эталонный текст подставляет сервер; аудио нигде не сохраняется."""
    audio, too_large = audio_of(request.scope)
    try:
        if too_large:
            raise pronunciation.audio_invalid("too_large")
        return await pronunciation.assess(ctx, target_kind, target, audio, request.headers.get("content-type"))
    finally:
        del audio
