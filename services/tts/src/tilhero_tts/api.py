"""`POST /internal/v1/speech` — озвучка фразы для telegram-bff (bff.ts SpeechRequest). Ответ — MP3 (`audio/mpeg`).

Кеш MP3 в Redis по (голос, скорость, sha256 текста): фразы контента одинаковы у всех учеников — синтез один раз.
Текст фразы не пишется в лог (только длина и попадание в кеш).
"""

from __future__ import annotations

import hashlib
import logging
import re
import unicodedata
from typing import Annotated, cast

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from redis.asyncio import Redis
from redis.exceptions import RedisError

from tilhero_common.errors import unavailable, unprocessable
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_tts.settings import Settings, Variant
from tilhero_tts.synth import Speed, Synthesizer

log = logging.getLogger("tilhero.tts.api")

router = APIRouter(prefix="/internal/v1", tags=["speech"])
bff_auth = InternalAuth({"telegram-bff"})

_LATIN = re.compile(r"[A-Za-z]")
_SPACES = re.compile(r"\s+")


class SpeechIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, Field(min_length=1, max_length=2000)]
    variant: Variant
    speed: Speed = "normal"


def normalize(text: str, max_chars: int) -> str:
    """Пробелы схлопываются, управляющие символы запрещены, нужна хотя бы одна латинская буква (английский текст)."""
    if any(unicodedata.category(ch) == "Cc" and ch not in "\n\t\r" for ch in text):
        raise unprocessable("TEXT_INVALID", "Недопустимые символы в тексте", {"field": "text"})
    norm = _SPACES.sub(" ", text).strip()
    if not norm or len(norm) > max_chars or not _LATIN.search(norm):
        raise unprocessable("TEXT_INVALID", "Текст для озвучки пуст, слишком длинный или не английский",
                            {"field": "text", "max_chars": max_chars})
    return norm


def cache_key(settings: Settings, voice: str, speed: str, text: str) -> str:
    return f"{settings.tts_cache_namespace}:{voice}:{speed}:{hashlib.sha256(text.encode()).hexdigest()}"


def _headers(cache: str) -> dict[str, str]:
    return {"Cache-Control": "private, max-age=86400", "X-TTS-Cache": cache}


@router.post("/speech", response_class=Response,
             responses={200: {"content": {"audio/mpeg": {}}, "description": "MP3, моно"},
                        422: {"description": "TEXT_INVALID"}, 503: {"description": "SPEECH_UNAVAILABLE"}})
async def speech(body: SpeechIn, request: Request, _: Principal = Depends(bff_auth)) -> Response:
    settings = cast(Settings, request.app.state.runtime.settings)
    synth = cast(Synthesizer, request.app.state.synth)
    cache = cast("Redis | None", request.app.state.audio_cache)
    text = normalize(body.text, settings.tts_max_text_chars)
    voice = settings.voice_for(body.variant)
    key = cache_key(settings, voice, body.speed, text)
    if cache is not None:
        try:
            hit = await cache.get(key)
        except RedisError as exc:  # кеш необязателен: синтезируем заново
            log.warning("tts cache read failed", extra={"error_type": type(exc).__name__})
            hit = None
        if hit:
            log.info("speech", extra={"chars": len(text), "cache": "hit", "voice": voice})
            return Response(content=hit, media_type="audio/mpeg", headers=_headers("hit"))
    try:
        audio = await synth.mp3(text, body.variant, body.speed)
    except Exception as exc:  # синтез не удался (таймаут, сбой модели) — клиент откатится на синтез устройства
        log.warning("speech synthesis failed", extra={"error_type": type(exc).__name__, "chars": len(text)})
        raise unavailable("SPEECH_UNAVAILABLE", "Озвучка временно недоступна") from exc
    if cache is not None:
        try:
            await cache.set(key, audio, ex=settings.tts_cache_ttl_days * 86400)
        except RedisError as exc:
            log.warning("tts cache write failed", extra={"error_type": type(exc).__name__})
    log.info("speech", extra={"chars": len(text), "cache": "miss", "voice": voice, "bytes": len(audio)})
    return Response(content=audio, media_type="audio/mpeg", headers=_headers("miss"))

