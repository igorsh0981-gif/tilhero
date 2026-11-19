"""API ученика (Mini App → telegram-bff → lessons), INTERNAL_API §2.4, формы bff.ts «Спринт 4».

Ученик — `lrn` внутреннего токена, аккаунт — `sub` (никогда из пути или тела): чужая сессия — 404. Ключи ответов
наружу не уходят; правильность проверки без подсказок не показывается до итогов.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Path, Query
from fastapi.responses import JSONResponse

from tilhero_lessons.api.common import (
    CONTENT_ID,
    audience_param,
    idempotency_key,
    learner_ctx,
    locale_param,
    pair_param,
)
from tilhero_lessons.domain import sessions as svc
from tilhero_lessons.domain.common import IdempotencyReused
from tilhero_lessons.domain.sessions import Ctx
from tilhero_lessons.schemas import StepAnswerIn

router = APIRouter(prefix="/internal/v1", tags=["client"])

def _content_id() -> Any:
    # новый объект Path на каждый параметр: FastAPI дописывает в него имя параметра (lesson_id / scenario_id / …)
    return Path(min_length=2, max_length=64, pattern=CONTENT_ID)


def _step_id() -> Any:
    return Path(min_length=2, max_length=8, pattern=r"^s[0-9]{1,6}$")

_COMMON: dict[int | str, dict[str, Any]] = {
    404: {"description": "SESSION_NOT_FOUND"},
    409: {"description": "SESSION_STATE {status}"},
    410: {"description": "USER_DELETED"},
    503: {"description": "CATALOG_UNAVAILABLE"},
}
_START: dict[int | str, dict[str, Any]] = {
    200: {"description": "повтор с тем же Idempotency-Key (Idempotent-Replayed: true)"},
    404: {"description": "LESSON_NOT_AVAILABLE | NO_EXERCISES"},
    409: {"description": "SESSION_ACTIVE {session_id, kind, title} | PAIR_NOT_AVAILABLE {pair_id}"},
    410: {"description": "USER_DELETED"},
    422: {"description": "IDEMPOTENCY_KEY_REUSED | IDEMPOTENCY_KEY_INVALID | VALIDATION_ERROR"},
    503: {"description": "CATALOG_UNAVAILABLE"},
}


async def _started(ctx: Ctx, start: Any) -> JSONResponse:
    try:
        s, replayed = await start
    except IdempotencyReused:
        raise svc.idempotency_reused() from None
    body = svc.session_view(s, ctx.settings)
    if replayed:
        return JSONResponse(body, status_code=200, headers={"Idempotent-Replayed": "true"})
    return JSONResponse(body, status_code=201)


@router.get("/lessons/{lesson_id}/card", responses={404: {"description": "LESSON_NOT_AVAILABLE"},
                                                   410: {"description": "USER_DELETED"},
                                                   503: {"description": "CATALOG_UNAVAILABLE"}})
async def lesson_card(lesson_id: str = _content_id(), pair_id: str = Depends(pair_param),
                      audience: str | None = Depends(audience_param),
                      ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """LessonCardDetail."""
    return await svc.card(ctx, lesson_id, pair_id, audience)


@router.post("/lessons/{lesson_id}/sessions", status_code=201, responses=_START)
async def start_lesson(lesson_id: str = _content_id(), pair_id: str = Depends(pair_param),
                       audience: str | None = Depends(audience_param), locale: str = Depends(locale_param),
                       key: str | None = Header(default=None, alias="Idempotency-Key"),
                       ctx: Ctx = Depends(learner_ctx)) -> JSONResponse:
    """→ LessonSession (ready). Первый GET …/current переводит в in_progress."""
    return await _started(ctx, svc.start_lesson(ctx, lesson_id, pair_id, audience, locale, idempotency_key(key)))


@router.post("/scenarios/{scenario_id}/sessions", status_code=201, responses=_START)
async def start_scenario(scenario_id: str = _content_id(), pair_id: str = Depends(pair_param),
                         audience: str | None = Depends(audience_param), locale: str = Depends(locale_param),
                         key: str | None = Header(default=None, alias="Idempotency-Key"),
                         ctx: Ctx = Depends(learner_ctx)) -> JSONResponse:
    return await _started(ctx, svc.start_scenario(ctx, scenario_id, pair_id, audience, locale,
                                                  idempotency_key(key)))


@router.post("/media/{asset_id}/sessions", status_code=201, responses=_START)
async def start_media(asset_id: str = _content_id(), pair_id: str = Depends(pair_param),
                      audience: str | None = Depends(audience_param), locale: str = Depends(locale_param),
                      key: str | None = Header(default=None, alias="Idempotency-Key"),
                      ctx: Ctx = Depends(learner_ctx)) -> JSONResponse:
    return await _started(ctx, svc.start_media(ctx, asset_id, pair_id, audience, locale, idempotency_key(key)))


@router.post("/sessions/{session_id}/review", status_code=201,
             responses={**_START, 409: {"description": "SESSION_ACTIVE | NOTHING_TO_REVIEW"}})
async def start_review(session_id: uuid.UUID, locale: str = Depends(locale_param),
                       key: str | None = Header(default=None, alias="Idempotency-Key"),
                       ctx: Ctx = Depends(learner_ctx)) -> JSONResponse:
    """Повтор заданий с ошибками из итогов — без влияния на освоение (practice_only)."""
    return await _started(ctx, svc.start_review(ctx, session_id, locale, idempotency_key(key)))


@router.get("/sessions/active", responses={410: {"description": "USER_DELETED"}})
async def active_session(ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """{session: LessonSession | null} — незавершённая сессия ученика."""
    return {"session": await svc.active(ctx)}


@router.get("/sessions", responses={400: {"description": "INVALID_CURSOR"}, 410: {"description": "USER_DELETED"}})
async def history(kind: Literal["lesson", "scenario", "media", "review"] | None = Query(default=None),
                  cursor: str | None = Query(default=None, max_length=300),
                  limit: int = Query(default=20, ge=1, le=100), ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """Page<LessonHistoryItem> — свои занятия, новые первыми."""
    return await svc.history(ctx, kind, cursor, limit)


@router.get("/sessions/{session_id}", responses=_COMMON)
async def get_session(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    return await svc.view(ctx, session_id)


@router.get("/sessions/{session_id}/current", responses=_COMMON)
async def get_current(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """LessonStep — текущий шаг (ready → in_progress; paused → авто-продолжение)."""
    return await svc.current(ctx, session_id)


@router.post("/sessions/{session_id}/steps/{step_id}",
             responses={**_COMMON, 403: {"description": "KIDS_NOT_ALLOWED"},
                        409: {"description": "STEP_NOT_CURRENT {current_step_id} | SESSION_STATE | "
                                             "FREE_TEXT_NOT_ALLOWED | AI_BUSY (та же реплика ещё обрабатывается "
                                             "ИИ — повторить через 2 с; сессия не изменена)"},
                        422: {"description": "ANSWER_INVALID {field} | VALIDATION_ERROR"}})
async def post_answer(body: StepAnswerIn, session_id: uuid.UUID, step_id: str = _step_id(),
                      ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """StepAnswer → StepResult (повтор того же ответа — тот же результат)."""
    return await svc.answer(ctx, session_id, step_id, body.model_dump())


@router.post("/sessions/{session_id}/steps/{step_id}/hint",
             responses={**_COMMON, 409: {"description": "HINTS_NOT_ALLOWED | STEP_NOT_CURRENT | SESSION_STATE"}})
async def post_hint(session_id: uuid.UUID, step_id: str = _step_id(),
                    ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """{hint: Localized} — подсказка отмечается; на проверке без подсказок — 409."""
    return await svc.hint(ctx, session_id, step_id)


@router.post("/sessions/{session_id}/simpler",
             responses={**_COMMON, 409: {"description": "SIMPLER_NOT_AVAILABLE | SESSION_STATE | AI_BUSY"}})
async def post_simpler(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx),
                      locale: str | None = Query(default=None, pattern="^(ru|uz)$",
                                                 description="язык объяснения; по умолчанию — язык сессии")
                      ) -> dict[str, Any]:
    """SimplerExplanation — позиция урока не меняется."""
    return await svc.simpler(ctx, session_id, locale)


@router.post("/sessions/{session_id}/roleplay/retry",
             responses={**_COMMON, 409: {"description": "RETRY_NOT_AVAILABLE | SESSION_STATE"}})
async def post_retry(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """LessonStep — одна повторная попытка после исхода fail с ближайшей точки восстановления."""
    return await svc.retry(ctx, session_id)


@router.post("/sessions/{session_id}/pause", responses=_COMMON)
async def post_pause(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    return await svc.pause(ctx, session_id)


@router.post("/sessions/{session_id}/resume", responses=_COMMON)
async def post_resume(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    return await svc.resume(ctx, session_id)


@router.post("/sessions/{session_id}/cancel", responses=_COMMON)
async def post_cancel(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    return await svc.cancel(ctx, session_id)


@router.post("/sessions/{session_id}/finish",
             responses={**_COMMON, 409: {"description": "STEP_NOT_CURRENT — не все шаги пройдены | SESSION_STATE"}})
async def post_finish(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    """LessonSummary (повтор — тот же итог, без новых событий)."""
    return await svc.finish(ctx, session_id)


@router.get("/sessions/{session_id}/summary", responses=_COMMON)
async def get_summary(session_id: uuid.UUID, ctx: Ctx = Depends(learner_ctx)) -> dict[str, Any]:
    return await svc.summary(ctx, session_id)
