"""API для сервисов и BFF (INTERNAL_API §1.4 спринта 3 и §4 спринта 4, формы — bff.ts), без actor.

- пары и снимок курса — telegram-bff, learning-plan, diagnostics, lessons (снимок кешируется по ETag =
  snapshot_version);
- сценарии и медиатека — telegram-bff и lessons (аудио — только telegram-bff); `audience` обязателен (BFF знает возраст
  ученика): детям 6–13 — только kids.
  Защита в глубину: детский профиль по claims (`lrn` ≠ `sub` или `age_band` 6–13) — аудитория kids принудительно,
  что бы ни пришло в `?audience=` (и для аудио без параметра);
- заявки на песни и фильмы — telegram-bff, sub = аккаунт (детский профиль → 403 KIDS_NOT_ALLOWED на создание и чтение);
  заявка по id — ещё notifications (без ссылки и комментария ученика);
- упражнения к медиа без ключей — lessons (выбор упражнений сессии, версии для фиксации);
- версия контента по номеру С КЛЮЧАМИ — только lessons и assessment (оценщик берёт ключи только отсюда); тело версии
  неизменяемо: `Cache-Control: private, max-age=31536000, immutable`, ETag = payload_hash (If-None-Match → 304);
  без номера — текущая опубликованная (lessons фиксирует номера при старте сессии): `private, no-cache`.
Ответы ученику — без ключей ответов и полного графа сценария; медиа — только с действующими сегодня правами.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import JSONResponse

from tilhero_catalog.api.common import (
    IdempotencyKey,
    content_readers,
    course_readers,
    exercise_readers,
    is_child_profile,
    learner_auth,
    policy_of,
    request_readers,
    settings_of,
    subject_id,
    version_readers,
)
from tilhero_catalog.content import CONTENT_KINDS, ID_PATTERN, AudienceSegment, Band, GoalCode, MediaType, TopicCode
from tilhero_catalog.domain import languages, learner, requests
from tilhero_catalog.schemas import MediaRequestCreateIn
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import forbidden, not_found
from tilhero_common.internal_auth import Principal

router = APIRouter(prefix="/internal/v1", tags=["internal"])

_KEY_RE = re.compile(ID_PATTERN)
IMMUTABLE_CACHE = "private, max-age=31536000, immutable"


def effective_audience(principal: Principal, requested: str) -> str:
    """Детский профиль видит только kids, независимо от запрошенной аудитории (решение по ревью)."""
    return "kids" if is_child_profile(principal) else requested


def optional_audience(principal: Principal, requested: str | None) -> str | None:
    """Аудио: без ?audience= детский профиль всё равно ограничен kids."""
    return "kids" if is_child_profile(principal) else requested


def forbid_child(principal: Principal) -> None:
    if is_child_profile(principal):
        raise forbidden("KIDS_NOT_ALLOWED", "Заявки на песни и фильмы отправляет взрослый из своего профиля")


@router.get("/pairs")
async def pairs(_: Principal = Depends(course_readers), rt: Runtime = Depends(get_runtime)) -> dict:
    """{items: LanguagePair[]} — кроме archived; неопубликованные ученик видит «скоро»."""
    async with rt.transaction() as session:
        rows = await languages.list_pairs(session, include_archived=False)
    return {"items": [languages.pair_view(r) for r in rows]}


@router.get("/courses/{course_id}/snapshot", responses={304: {"description": "If-None-Match совпал"},
                                                         404: {"description": "COURSE_NOT_FOUND"}})
async def course_snapshot(course_id: str, _: Principal = Depends(course_readers), rt: Runtime = Depends(get_runtime),
                          if_none_match: str | None = Header(default=None, alias="If-None-Match",
                                                             max_length=200)) -> Response:
    """CourseSnapshot: опубликованные курс, модули, уроки (без ключей ответов), навыки; ETag = snapshot_version."""
    async with rt.transaction() as session:
        snapshot = await learner.course_snapshot(session, course_id[:64])
    etag = f'"{snapshot["snapshot_version"]}"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if if_none_match is not None and etag in [t.strip() for t in if_none_match.split(",")]:
        return Response(status_code=304, headers=headers)
    return JSONResponse(snapshot, headers=headers)


@router.get("/scenarios")
async def scenarios(principal: Principal = Depends(content_readers), rt: Runtime = Depends(get_runtime),
                    audience: AudienceSegment = Query(), goal: GoalCode | None = Query(default=None),
                    level: Band | None = Query(default=None), topic: TopicCode | None = Query(default=None),
                    limit: int = Query(default=20, ge=1, le=100),
                    cursor: str | None = Query(default=None, max_length=200)) -> dict:
    """Page<ScenarioCard> опубликованных сценариев аудитории ученика."""
    async with rt.transaction() as session:
        return await learner.scenario_cards(session, audience=effective_audience(principal, audience),
                                            goal=goal, level=level, topic=topic,
                                            cursor=cursor, limit=limit)


@router.get("/scenarios/{scenario_id}", responses={404: {"description": "SCENARIO_NOT_FOUND"}})
async def scenario(scenario_id: str, principal: Principal = Depends(content_readers),
                   rt: Runtime = Depends(get_runtime),
                   audience: AudienceSegment = Query()) -> dict:
    """ScenarioDetail: задача, персонажи, критерии, первая реплика и варианты ответа, исходы — без полного графа."""
    async with rt.transaction() as session:
        return await learner.scenario_detail(session, scenario_id[:64],
                                             effective_audience(principal, audience))


@router.get("/media")
async def media(principal: Principal = Depends(content_readers), rt: Runtime = Depends(get_runtime),
                audience: AudienceSegment = Query(), type: MediaType | None = Query(default=None),
                level: Band | None = Query(default=None), topic: TopicCode | None = Query(default=None),
                limit: int = Query(default=20, ge=1, le=100),
                cursor: str | None = Query(default=None, max_length=200)) -> dict:
    """Page<MediaCard>: опубликованные, права действуют сегодня, территория UZ, аудитория ученика."""
    policy = policy_of(rt)
    async with rt.transaction() as session:
        return await learner.media_cards(session, audience=effective_audience(principal, audience),
                                         media_type=type, level=level, topic=topic,
                                         cursor=cursor, limit=limit, today=policy.today,
                                         external_sources=policy.external_sources)


# ---------------------------------------------------------------- заявки (до /media/{asset_id})


@router.post("/media/requests", status_code=201,
             responses={403: {"description": "KIDS_NOT_ALLOWED"}, 410: {"description": "USER_DELETED"},
                        429: {"description": "MEDIA_REQUEST_LIMIT {retry_after}"}})
async def create_request(body: MediaRequestCreateIn, principal: Principal = Depends(learner_auth),
                         rt: Runtime = Depends(get_runtime),
                         idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    """Заявка на песню или фильм от аккаунта (sub). Ничего не скачивается и не расшифровывается."""
    user_id = subject_id(principal)
    forbid_child(principal)
    async with rt.transaction() as session:
        row, _ = await requests.create(session, user_id, kind=body.kind, title=body.title, link=body.link,
                                       comment=body.comment or None, ui_locale=body.ui_locale,
                                       idempotency_key=idempotency_key,
                                       per_day=settings_of(rt).media_requests_per_day)
        out = requests.learner_view(row)
    return JSONResponse(out, status_code=201)


@router.get("/media/requests", responses={403: {"description": "KIDS_NOT_ALLOWED"},
                                          410: {"description": "USER_DELETED"}})
async def own_requests(principal: Principal = Depends(learner_auth), rt: Runtime = Depends(get_runtime)) -> dict:
    """{items: MediaRequest[]} — свои заявки, новые первыми."""
    user_id = subject_id(principal)
    forbid_child(principal)
    async with rt.transaction() as session:
        return {"items": await requests.list_own(session, user_id)}


@router.get("/media/requests/{request_id}", responses={403: {"description": "KIDS_NOT_ALLOWED"},
                                                       404: {"description": "MEDIA_REQUEST_NOT_FOUND"}})
async def get_request(request_id: uuid.UUID, principal: Principal = Depends(request_readers),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """notifications — без ссылки и комментария ученика; telegram-bff — только своя (чужая → 404)."""
    if principal.issuer == "telegram-bff":
        forbid_child(principal)
    async with rt.transaction() as session:
        row = await requests.get(session, request_id)
    if principal.issuer == "telegram-bff":
        if row.user_id is None or row.user_id != subject_id(principal):
            raise requests.request_not_found()
        return requests.learner_view(row)
    return requests.service_view(row)


# ---------------------------------------------------------------- медиа по id


@router.get("/media/{asset_id}", responses={404: {"description": "MEDIA_NOT_AVAILABLE"}})
async def media_item(asset_id: str, principal: Principal = Depends(content_readers), rt: Runtime = Depends(get_runtime),
                     audience: AudienceSegment = Query()) -> dict:
    """MediaDetail: транскрипт — только при allowed_uses ∋ show_transcript; атрибуция — всегда."""
    policy = policy_of(rt)
    async with rt.transaction() as session:
        return await learner.media_detail(session, asset_id[:64], effective_audience(principal, audience),
                                          policy.today, policy.external_sources)


@router.get("/media/{asset_id}/audio", responses={304: {"description": "If-None-Match совпал"},
                                                  404: {"description": "MEDIA_NOT_AVAILABLE | AUDIO_NOT_FOUND"}})
async def media_audio(asset_id: str, request: Request, principal: Principal = Depends(learner_auth),
                      rt: Runtime = Depends(get_runtime),
                      audience: AudienceSegment | None = Query(default=None)) -> Response:
    """Байты аудио (Cache-Control: private, max-age=3600; ETag = sha256)."""
    policy = policy_of(rt)
    async with rt.transaction() as session:
        blob = await learner.media_audio(session, asset_id[:64], optional_audience(principal, audience),
                                         policy.today, policy.external_sources)
    etag = f'"{blob.sha256}"'
    headers = {"ETag": etag, "Cache-Control": "private, max-age=3600"}
    inm = request.headers.get("if-none-match")
    if inm is not None and etag in [t.strip() for t in inm.split(",")]:
        return Response(status_code=304, headers=headers)
    return Response(blob.bytes, media_type=blob.content_type, headers=headers)


@router.get("/media/{asset_id}/exercises", responses={404: {"description": "MEDIA_NOT_AVAILABLE"}})
async def media_exercises(asset_id: str, principal: Principal = Depends(exercise_readers),
                          rt: Runtime = Depends(get_runtime), audience: AudienceSegment = Query()) -> dict:
    """{asset_id, asset_version, items}: опубликованные упражнения к медиа без ключей ответов (lessons выбирает
    упражнения и фиксирует версии; ключи assessment берёт из /versions). Аудитория и права — как у карточки медиа."""
    policy = policy_of(rt)
    async with rt.transaction() as session:
        return await learner.media_exercises(session, asset_id[:64], effective_audience(principal, audience),
                                             policy.today, policy.external_sources)


# ---------------------------------------------------------------- версии контента с ключами (lessons, assessment)


@router.get("/versions/{kind}/{key}",
            responses={304: {"description": "If-None-Match совпал"},
                       404: {"description": "VERSION_NOT_FOUND | CONTENT_KIND_UNKNOWN"}})
async def current_version(kind: str, key: str, _: Principal = Depends(version_readers),
                          rt: Runtime = Depends(get_runtime),
                          if_none_match: str | None = Header(default=None, alias="If-None-Match",
                                                             max_length=200)) -> Response:
    """Текущая опубликованная версия С КЛЮЧАМИ (lessons фиксирует номера версий при старте сессии; дальше читает по
    номеру). Указатель меняется публикацией — `Cache-Control: private, no-cache`, ETag = «версия.payload_hash»."""
    if kind not in CONTENT_KINDS:
        raise not_found("CONTENT_KIND_UNKNOWN", "Неизвестный вид контента")
    if not _KEY_RE.match(key):
        raise not_found("VERSION_NOT_FOUND", "Нет опубликованной версии")
    async with rt.transaction() as session:
        row = await learner.current_version(session, kind, key)
        body = learner.released_view(row)
    etag = f'"{row.version}.{row.payload_hash}"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if if_none_match is not None and etag in [t.strip() for t in if_none_match.split(",")]:
        return Response(status_code=304, headers=headers)
    return JSONResponse(body, headers=headers)


@router.get("/versions/{kind}/{key}/{version}",
            responses={304: {"description": "If-None-Match совпал"},
                       404: {"description": "VERSION_NOT_FOUND | CONTENT_KIND_UNKNOWN"}})
async def released_version(kind: str, key: str, version: int, _: Principal = Depends(version_readers),
                           rt: Runtime = Depends(get_runtime),
                           if_none_match: str | None = Header(default=None, alias="If-None-Match",
                                                              max_length=200)) -> Response:
    """Полное тело версии С КЛЮЧАМИ (published или archived, бывшая опубликованной; остальное — 404). Тело версии
    неизменяемо — вызывающие кешируют бессрочно (`immutable`), ETag = payload_hash."""
    if kind not in CONTENT_KINDS:
        raise not_found("CONTENT_KIND_UNKNOWN", "Неизвестный вид контента")
    if not _KEY_RE.match(key) or not 1 <= version <= 1_000_000:
        raise not_found("VERSION_NOT_FOUND", "Нет опубликованной версии")
    async with rt.transaction() as session:
        row = await learner.released_version(session, kind, key, version)
        body = learner.released_view(row)
    etag = f'"{row.payload_hash}"'
    headers = {"ETag": etag, "Cache-Control": IMMUTABLE_CACHE}
    if if_none_match is not None and etag in [t.strip() for t in if_none_match.split(",")]:
        return Response(status_code=304, headers=headers)
    return JSONResponse(body, headers=headers)
