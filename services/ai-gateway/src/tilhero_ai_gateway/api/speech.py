"""Оценка произношения: `POST /internal/v1/speech/pronunciation` (вызывающий — только memory; INTERNAL_API §1.9, §3.2).

Вход: тело — WAV (PCM 16 бит, моно, 16 000 Гц, 0,5..15 с, ≤ 600 000 байт), `Content-Type: audio/wav`; заголовок
`X-Speech-Meta` = base64url(JSON SpeechAssessMeta). Ответ — всегда 200 `PronunciationResult`
(`ok | insufficient_evidence | unavailable`): memory сохраняет попытку и отвечает ученику.

Ошибки: 401 нет токена / нет `sub` (USER_CONTEXT_REQUIRED); 403 вызывающий не memory (CALLER_NOT_ALLOWED),
`user_id` меты ≠ `sub`/`lrn` токена (USER_CONTEXT_MISMATCH); 422 SPEECH_META_INVALID {errors} — нет заголовка, не
base64url, не JSON, не по контракту; 422 AUDIO_INVALID {reason: format | too_short | too_long | too_large};
422 IDEMPOTENCY_KEY_REUSED — тот же request_id с другой метой или аудио; 409 IDEMPOTENCY_IN_PROGRESS.

Идемпотентность: повтор `request_id` за 24 ч → сохранённый результат (Redis, без аудио; отпечаток — хеш меты и
SHA-256 аудио), заголовок `idempotent-replay: true`. Аудиторию kids задают и claims токена (`lrn` ≠ `sub`, `age_band`
6–13) — мягкие советы.

Тело больше общего лимита сервисов (256 КиБ, tilhero_common.app) читает `SpeechBodyMiddleware` — снаружи общего
middleware и только для маршрутов речи: не больше 600 000 байт, байты — в состоянии запроса до его конца.

Спринт 7 (INTERNAL_API §4, ai.ts SpeechTranscribe*): `POST /internal/v1/speech:transcribe` — распознавание голосового
хода парной комнаты, вызывающий только lessons (иначе 403 CALLER_NOT_ALLOWED). Тело — тот же WAV, мета —
`X-Speech-Meta` = base64url(JSON SpeechTranscribeMeta {request_id, user_id, room_id, audience, language}).
Ответ 200 SpeechTranscribeResult {text, words, duration_ms, provider, latency_ms}; тишина — пустые text и words.
Ошибки: 422 SPEECH_META_INVALID {errors}, AUDIO_INVALID {reason}, IDEMPOTENCY_KEY_REUSED; 403 USER_CONTEXT_MISMATCH,
KIDS_NOT_ALLOWED (audience kids или детский токен — детям в комнате только выбор реплик); 409 IDEMPOTENCY_IN_PROGRESS;
503 SPEECH_UNAVAILABLE (аварийная остановка, распознаватель не настроен или выключен, tts недоступен или не успел).
Повтор request_id ≤ 24 ч — сохранённый результат; 503 не сохраняется (повтор распознаёт заново).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
import time
from typing import Any, Final

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from redis.exceptions import RedisError

from tilhero_ai_gateway.api.common import (
    InvokeCache,
    check_user,
    is_child_token,
    settings_of,
    speech_auth,
    speech_deps_of,
    transcribe_auth,
    transcribe_deps_of,
)
from tilhero_ai_gateway.contracts import SpeechAssessMeta, SpeechTranscribeMeta, error_list
from tilhero_ai_gateway.domain.speech import assess
from tilhero_ai_gateway.domain.transcribe import SpeechUnavailable, transcribe
from tilhero_ai_gateway.domain.wav import MAX_AUDIO_BYTES, AudioInvalid, parse_wav
from tilhero_common.errors import ApiError, forbidden, unavailable, unprocessable
from tilhero_common.internal_auth import Principal
from tilhero_common.redis_tools import fingerprint

router = APIRouter(prefix="/internal/v1", tags=["internal"])
log = logging.getLogger("tilhero.ai_gateway.speech_api")

SPEECH_PATH: Final = "/internal/v1/speech/pronunciation"
TRANSCRIBE_PATH: Final = "/internal/v1/speech:transcribe"
AUDIO_PATHS: Final = frozenset({SPEECH_PATH, TRANSCRIBE_PATH})
AUDIO_KEY: Final = "speech_audio"
TOO_LARGE_KEY: Final = "speech_audio_too_large"
WAV_TYPES: Final = frozenset({"audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"})
META_MAX: Final = 4096
PENDING_TTL: Final = 60  # две попытки ≤ 15 с + запас
DUPLICATE_WAIT_S: Final = 14.0


class SpeechBodyMiddleware:
    """Чистый ASGI middleware маршрута оценки произношения (снаружи RequestContextMiddleware): читает тело сам — не
    больше MAX_AUDIO_BYTES (+1 байт для признака «слишком большое»), кладёт байты в `scope["state"]` на время запроса и
    передаёт внутрь пустое тело с `content-length: 0` (иначе общий лимит 256 КиБ ответил бы 413 до обработчика).
    После ответа байты удаляются из состояния запроса. Аудио никуда не пишется."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or scope.get("path") not in AUDIO_PATHS or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return
        declared = None
        for key, value in scope.get("headers", []):
            if key.lower() == b"content-length" and value.isdigit():
                declared = int(value)
        chunks: list[bytes] = []
        size, too_large = 0, declared is not None and declared > MAX_AUDIO_BYTES
        more = not too_large
        while more:
            message = await receive()
            if message.get("type") == "http.disconnect":
                return
            body = message.get("body", b"")
            size += len(body)
            if size > MAX_AUDIO_BYTES:
                too_large = True
                break
            chunks.append(body)
            more = bool(message.get("more_body", False))
        state = scope.setdefault("state", {})
        state[AUDIO_KEY] = None if too_large else b"".join(chunks)
        state[TOO_LARGE_KEY] = too_large
        chunks.clear()
        headers = [(k, v) for k, v in scope.get("headers", []) if k.lower() != b"content-length"]
        inner = {**scope, "headers": [*headers, (b"content-length", b"0")]}
        delivered = False

        async def inner_receive() -> dict[str, Any]:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"", "more_body": False}
            message: dict[str, Any] = await receive()
            return message

        try:
            await self.app(inner, inner_receive, send)
        finally:
            state.pop(AUDIO_KEY, None)


def audio_invalid(reason: str) -> ApiError:
    return unprocessable("AUDIO_INVALID", "Запись не подходит для оценки произношения", {"reason": reason})


def parse_meta(header: str | None) -> SpeechAssessMeta:
    """X-Speech-Meta: base64url (без выравнивания или с ним) JSON → SpeechAssessMeta; ошибки — без значений."""
    return _parse_meta(header, SpeechAssessMeta)


def _parse_meta[M: (SpeechAssessMeta, SpeechTranscribeMeta)](header: str | None, model: type[M]) -> M:
    def invalid(errors: list[dict[str, str]]) -> ApiError:
        return unprocessable("SPEECH_META_INVALID", "Заголовок X-Speech-Meta не соответствует контракту",
                             {"errors": errors})

    if header is None or not header.strip():
        raise invalid([{"path": "X-Speech-Meta", "message": "обязательный заголовок"}])
    raw = header.strip()
    if len(raw) > META_MAX:
        raise invalid([{"path": "X-Speech-Meta", "message": f"длиннее {META_MAX} символов"}])
    try:
        decoded = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
        data = json.loads(decoded.decode("utf-8"))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        raise invalid([{"path": "X-Speech-Meta", "message": "ожидается base64url(JSON)"}]) from None
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise invalid(error_list(exc)) from None


def _content_type_ok(value: str | None) -> bool:
    return value is not None and value.split(";", 1)[0].strip().lower() in WAV_TYPES


@router.post("/speech/pronunciation",
             responses={422: {"description": "SPEECH_META_INVALID {errors} | AUDIO_INVALID {reason} | "
                                             "IDEMPOTENCY_KEY_REUSED"},
                        409: {"description": "IDEMPOTENCY_IN_PROGRESS"}})
async def pronunciation(request: Request, principal: Principal = Depends(speech_auth),
                        x_speech_meta: str | None = Header(default=None, alias="X-Speech-Meta"),
                        content_type: str | None = Header(default=None, alias="Content-Type")) -> JSONResponse:
    """PronunciationResult — оценка по словам, 1–2 совета (ai.ts). Аудио — только в памяти на время запроса."""
    received = time.monotonic()
    meta = parse_meta(x_speech_meta)
    check_user(principal, meta.user_id)
    state = request.scope.get("state") or {}
    audio = state.get(AUDIO_KEY)
    if state.get(TOO_LARGE_KEY):
        raise audio_invalid("too_large")
    if not _content_type_ok(content_type) or not isinstance(audio, bytes | bytearray):
        raise audio_invalid("format")
    try:
        info = parse_wav(bytes(audio))
    except AudioInvalid as exc:
        raise audio_invalid(exc.reason) from None
    audience = "kids" if is_child_token(principal) else meta.audience
    deps = speech_deps_of(request)
    rt = deps.rt
    caller = principal.issuer
    request_key = str(meta.request_id)
    fp = fingerprint({"meta": meta.model_dump(mode="json"), "audience": audience,
                      "audio_sha256": hashlib.sha256(audio).hexdigest()})
    cache: InvokeCache | None = None
    if rt.redis is not None:
        conf = settings_of(rt)
        cache = InvokeCache(rt.redis, conf.cache_namespace, conf.invoke_cache_ttl_seconds, PENDING_TTL, kind="speech")
        try:
            replay = await cache.begin(caller, request_key, fp, wait_until=received + DUPLICATE_WAIT_S)
        except RedisError:
            log.warning("speech cache unavailable, executing without idempotency")
            cache, replay = None, None
        if replay is not None:
            return JSONResponse(replay, headers={"idempotent-replay": "true"})
    try:
        result = await assess(deps, meta, bytes(audio), info, caller=caller, audience=audience, received=received)
    except BaseException:
        if cache is not None:
            try:
                await cache.abort(caller, request_key)
            except RedisError:
                log.warning("speech cache abort failed")
        raise
    if cache is not None:
        try:
            await cache.complete(caller, request_key, fp, result, str(meta.user_id))
        except RedisError:
            log.warning("speech cache complete failed")
    return JSONResponse(result)


def _audio(request: Request, content_type: str | None) -> tuple[bytes, Any]:
    """Тело маршрута речи → (байты, WavInfo) или 422 AUDIO_INVALID."""
    state = request.scope.get("state") or {}
    audio = state.get(AUDIO_KEY)
    if state.get(TOO_LARGE_KEY):
        raise audio_invalid("too_large")
    if not _content_type_ok(content_type) or not isinstance(audio, bytes | bytearray):
        raise audio_invalid("format")
    try:
        return bytes(audio), parse_wav(bytes(audio))
    except AudioInvalid as exc:
        raise audio_invalid(exc.reason) from None


@router.post("/speech:transcribe",
             responses={403: {"description": "CALLER_NOT_ALLOWED | USER_CONTEXT_MISMATCH | KIDS_NOT_ALLOWED"},
                        422: {"description": "SPEECH_META_INVALID {errors} | AUDIO_INVALID {reason} | "
                                             "IDEMPOTENCY_KEY_REUSED"},
                        409: {"description": "IDEMPOTENCY_IN_PROGRESS"},
                        503: {"description": "SPEECH_UNAVAILABLE"}})
async def transcribe_turn(request: Request, principal: Principal = Depends(transcribe_auth),
                          x_speech_meta: str | None = Header(default=None, alias="X-Speech-Meta"),
                          content_type: str | None = Header(default=None, alias="Content-Type")) -> JSONResponse:
    """SpeechTranscribeResult — текст голосового хода парной комнаты (ai.ts). Аудио — только в памяти запроса."""
    received = time.monotonic()
    meta = _parse_meta(x_speech_meta, SpeechTranscribeMeta)
    check_user(principal, meta.user_id)
    if meta.audience == "kids" or is_child_token(principal):
        raise forbidden("KIDS_NOT_ALLOWED", "Детям в парной комнате доступен только выбор реплик")
    audio, info = _audio(request, content_type)
    deps = transcribe_deps_of(request)
    rt = deps.rt
    caller = principal.issuer
    request_key = str(meta.request_id)
    fp = fingerprint({"meta": meta.model_dump(mode="json"), "audio_sha256": hashlib.sha256(audio).hexdigest()})
    cache: InvokeCache | None = None
    if rt.redis is not None:
        conf = settings_of(rt)
        cache = InvokeCache(rt.redis, conf.cache_namespace, conf.invoke_cache_ttl_seconds, PENDING_TTL,
                            kind="transcribe")
        try:
            replay = await cache.begin(caller, request_key, fp, wait_until=received + DUPLICATE_WAIT_S)
        except RedisError:
            log.warning("transcribe cache unavailable, executing without idempotency")
            cache, replay = None, None
        if replay is not None:
            return JSONResponse(replay, headers={"idempotent-replay": "true"})
    try:
        result = await transcribe(deps, meta, audio, info, caller=caller, received=received)
    except BaseException as exc:
        if cache is not None:
            try:
                await cache.abort(caller, request_key)
            except RedisError:
                log.warning("transcribe cache abort failed")
        if isinstance(exc, SpeechUnavailable):
            raise unavailable("SPEECH_UNAVAILABLE", "Распознавание речи сейчас недоступно — продолжите текстом") \
                from None
        raise
    if cache is not None:
        try:
            await cache.complete(caller, request_key, fp, result, str(meta.user_id))
        except RedisError:
            log.warning("transcribe cache complete failed")
    return JSONResponse(result)
