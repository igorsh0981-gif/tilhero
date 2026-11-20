"""`POST /internal/v1/recognize` — распознавание записи для оценки произношения (релиз 5.1). Вызывающий — только
ai-gateway (он сравнивает распознанные слова с эталоном; эталон сюда не передаётся — модели нечего «подсказывать»).

Вход: тело `audio/wav` (PCM 16 бит, моно, 16 000 Гц, 0,5..15 с, ≤ 600 000 байт). Ответ 200:
`{text, words: [{word, start_ms, end_ms, probability}], duration_ms, model}`; тишина или неразборчивая речь — пустые
`text` и `words` (не ошибка). Ошибки: 401/403 — нет токена или чужой вызывающий; 422 `AUDIO_INVALID {reason: format |
too_short | too_long | too_large}`; 503 `RECOGNITION_UNAVAILABLE` — распознавание не удалось или не уложилось в
`ASR_TIMEOUT_SECONDS` (вместе с ожиданием очереди).

Тело больше общего лимита сервисов (256 КиБ, tilhero_common.app) читает `AudioBodyMiddleware` — снаружи общего
middleware и только для этого маршрута: не больше 600 000 байт, байты — в состоянии запроса до его конца. Аудио и
распознанный текст в лог не пишутся — только длительность, число слов, задержка и модель.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Final, cast

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse

from tilhero_common.errors import ApiError, unavailable, unprocessable
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_tts.asr import Recognizer
from tilhero_tts.wav import MAX_AUDIO_BYTES, AudioInvalid, parse_wav

log = logging.getLogger("tilhero.tts.recognize")

router = APIRouter(prefix="/internal/v1", tags=["recognize"])
gateway_auth = InternalAuth({"ai-gateway"})

RECOGNIZE_PATH: Final = "/internal/v1/recognize"
AUDIO_KEY: Final = "asr_audio"
TOO_LARGE_KEY: Final = "asr_audio_too_large"
WAV_TYPES: Final = frozenset({"audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"})


class AudioBodyMiddleware:
    """Чистый ASGI middleware маршрута распознавания: тело ≤ MAX_AUDIO_BYTES (+1 байт — признак «слишком большое»)
    читается здесь и кладётся в `scope["state"]` на время запроса; внутрь уходит пустое тело с `content-length: 0`
    (иначе общий лимит 256 КиБ ответил бы 413 до обработчика). После ответа байты удаляются из состояния запроса."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or scope.get("path") != RECOGNIZE_PATH or scope.get("method") != "POST":
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
    return unprocessable("AUDIO_INVALID", "Запись не подходит для распознавания", {"reason": reason})


@router.post("/recognize",
             responses={422: {"description": "AUDIO_INVALID {reason}"},
                        503: {"description": "RECOGNITION_UNAVAILABLE"}})
async def recognize(request: Request, _: Principal = Depends(gateway_auth),
                    content_type: str | None = Header(default=None, alias="Content-Type")) -> JSONResponse:
    """{text, words: [{word, start_ms, end_ms, probability}], duration_ms, model}."""
    started = time.perf_counter()
    state = request.scope.get("state") or {}
    audio = state.get(AUDIO_KEY)
    if state.get(TOO_LARGE_KEY):
        raise audio_invalid("too_large")
    media = (content_type or "").split(";", 1)[0].strip().lower()
    if media not in WAV_TYPES or not isinstance(audio, bytes | bytearray):
        raise audio_invalid("format")
    try:
        info = parse_wav(bytes(audio))
    except AudioInvalid as exc:
        raise audio_invalid(exc.reason) from None
    recognizer = cast(Recognizer, request.app.state.recognizer)
    try:
        result = await recognizer.recognize(bytes(audio), info)
    except Exception as exc:  # таймаут, сбой модели — ai-gateway вернёт unavailable: provider_error
        log.warning("recognition failed", extra={"error_type": type(exc).__name__, "duration_ms": info.duration_ms})
        raise unavailable("RECOGNITION_UNAVAILABLE", "Распознавание речи временно недоступно") from exc
    latency = int((time.perf_counter() - started) * 1000)
    log.info("recognize", extra={"duration_ms": info.duration_ms, "words": len(result.words), "latency_ms": latency,
                                 "model": recognizer.model_name})
    return JSONResponse({
        "text": result.text,
        "words": [{"word": w.word, "start_ms": w.start_ms, "end_ms": w.end_ms, "probability": w.probability}
                  for w in result.words],
        "duration_ms": info.duration_ms,
        "model": recognizer.model_name,
    })
