"""Распознавание голосового хода парной комнаты — `POST /internal/v1/speech:transcribe` (спринт 7, INTERNAL_API §4;
ai.ts SpeechTranscribeMeta / SpeechTranscribeResult). Вызывающий — только lessons.

Распознаёт сервис tts (`POST {TTS_URL}/internal/v1/recognize`, faster-whisper — как провайдер whisper релиза 5.1):
расход $0 (модель `whisper-base-en`), бюджеты ИИ не проверяются и не тратятся; Azure не используется. На стенде и в
тестах (`SPEECH_PROVIDER=fake`) — детерминированный `fake_speech` (модель `fake-speech`, 0 $).

Порядок:
1. Доступность: аварийная остановка (`ai_enabled = false`) → `ai_disabled`; распознаватель не настроен (нет
   `TTS_URL`) или модель речи выключена в админке → `not_configured` — 503 SPEECH_UNAVAILABLE без вызова tts.
2. tts: таймаут попытки ≤ 12 с; один повтор при сетевой ошибке и 502/504, если до дедлайна (14,5 с от приёма) осталось
   ≥ 4 с; 503 `RECOGNITION_UNAVAILABLE`, прочие ответы и неверное тело — без повтора (CPU tts не перегружается) →
   503 SPEECH_UNAVAILABLE (`provider_error` | `timeout`, код — в `speech.last_error` админки).
3. Ответ tts → `{text ≤ 600, words ≤ 120 [{word, start_ms, end_ms}], duration_ms}`: управляющие символы убираются,
   время слов — в пределах записи; длительность — по заголовку WAV. Тишина — пустые text и words (не ошибка).
4. Учёт — строка `usage` без текста: агент `cooperative_lesson_coach` (распознавание — часть парного урока),
   `session_kind pair`, `session_id = room_id`, модель и провайдер речи, `audio_ms`, стоимость 0, статус `ok` или
   `unavailable` с причиной.

Аудио и распознанный текст — только в памяти на время запроса: в БД, логи и события не пишутся (результат хранит
лишь кеш идемпотентности request_id на 24 ч — его стирает сага удаления).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Literal, Protocol

from sqlalchemy import update

from tilhero_ai_gateway.contracts import (
    CONTROL_RE,
    TRANSCRIBE_TEXT_MAX,
    TRANSCRIBE_WORDS_MAX,
    SpeechTranscribeMeta,
    SpeechTranscribeResult,
)
from tilhero_ai_gateway.domain.provider_status import ProviderStatus
from tilhero_ai_gateway.domain.wav import WavInfo, mean_amplitude, parse_wav
from tilhero_ai_gateway.models import BudgetRow, DeletedUser, ModelRow, UsageRow
from tilhero_ai_gateway.providers.speech import RECOGNIZE_PATH, RETRYABLE_STATUS, TTS
from tilhero_ai_gateway.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.http_client import CircuitOpen, UpstreamError

log = logging.getLogger("tilhero.ai_gateway.transcribe")

AGENT_ID: Final = "cooperative_lesson_coach"
SESSION_KIND: Final = "pair"
DEADLINE_S: Final = 14.5
ATTEMPT_TIMEOUT_S: Final = 12.0
RETRY_MIN_REMAINING_S: Final = 4.0
MARGIN_S: Final = 0.5
MIN_ATTEMPT_S: Final = 1.0
WORD_MAX: Final = 60
SILENCE_AMPLITUDE: Final = 200
FAKE_WORDS: Final = ("hello", "nice", "to", "meet", "you")

TranscriberName = Literal["whisper", "fake_speech"]


class TranscribeError(Exception):
    """Ошибка распознавателя: code — короткий код без тела ответа; retryable — сеть и 502/504 (один повтор)."""

    def __init__(self, code: str, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


class SpeechUnavailable(Exception):
    """→ 503 SPEECH_UNAVAILABLE (reason — для логов и учёта, наружу не отдаётся)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class Transcriber(Protocol):
    name: TranscriberName
    model_id: str

    def ready(self) -> bool:
        """Настроен ли распознаватель: whisper — задан TTS_URL (сеть не проверяется)."""
        ...

    async def recognize(self, audio: bytes, timeout_s: float) -> dict[str, Any]:
        """Ответ в формате tts `{text, words: [{word, start_ms, end_ms, probability}], duration_ms}`."""
        ...


class WhisperTranscriber:
    """Сервис tts (общий ServiceClient Runtime, сырое тело audio/wav; ученика tts не знает)."""

    name: TranscriberName = "whisper"
    model_id = "whisper-base-en"

    def __init__(self, runtime: Runtime, tts_url: str | None) -> None:
        self._rt = runtime
        self._url = tts_url

    def ready(self) -> bool:
        return bool(self._url)

    async def recognize(self, audio: bytes, timeout_s: float) -> dict[str, Any]:
        client = self._rt.clients.get(TTS) if self._url else None
        if client is None:
            raise TranscribeError("not_configured")
        try:
            data = await client.post(RECOGNIZE_PATH, content=audio, headers={"Content-Type": "audio/wav"})
        except CircuitOpen:
            raise TranscribeError("circuit_open") from None
        except UpstreamError as exc:
            if exc.code == "UPSTREAM_UNAVAILABLE":
                raise TranscribeError("network", retryable=True) from None
            log.warning("tts recognize error status", extra={"status": exc.status, "code": exc.code[:64]})
            raise TranscribeError(f"http_{exc.status}", retryable=exc.status in RETRYABLE_STATUS) from None
        if not isinstance(data, dict):
            raise TranscribeError("bad_response")
        return data

    def __repr__(self) -> str:
        return f"WhisperTranscriber(tts_configured={bool(self._url)})"


class FakeTranscriber:
    """Стенд и тесты: средняя |амплитуда| < 200 — тишина (пустой ответ), иначе «hello nice to meet you» по записи."""

    name: TranscriberName = "fake_speech"
    model_id = "fake-speech"

    def ready(self) -> bool:
        return True

    async def recognize(self, audio: bytes, timeout_s: float) -> dict[str, Any]:
        info = parse_wav(audio)
        if mean_amplitude(audio, info) < SILENCE_AMPLITUDE:
            return {"text": "", "words": [], "duration_ms": info.duration_ms}
        step = max(1, info.duration_ms // (len(FAKE_WORDS) + 1))
        words = [{"word": w, "start_ms": i * step, "end_ms": (i + 1) * step, "probability": 0.95}
                 for i, w in enumerate(FAKE_WORDS)]
        return {"text": "Hello, nice to meet you.", "words": words, "duration_ms": info.duration_ms}


def make_transcriber(settings: Settings, runtime: Runtime) -> Transcriber:
    if settings.speech_provider == "fake":
        return FakeTranscriber()
    return WhisperTranscriber(runtime, settings.tts_url)


@dataclass
class TranscribeDeps:
    rt: Runtime
    settings: Settings
    transcriber: Transcriber
    clock: Callable[[], datetime]
    status: ProviderStatus


def _clean(value: Any, limit: int) -> str:
    text = CONTROL_RE.sub("", str(value or "")).replace("\n", " ").replace("\r", " ").replace("\t", " ")
    return " ".join(text.split())[:limit]


def _int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return int(value)


def normalize(data: dict[str, Any], duration_ms: int) -> tuple[str, list[dict[str, Any]]]:
    """Ответ tts → (text ≤ 600, words ≤ 120): без управляющих символов, время слов — в пределах записи. Неверная
    форма → TranscribeError bad_response."""
    raw_words = data.get("words")
    if not isinstance(raw_words, list) or not all(isinstance(w, dict) for w in raw_words):
        raise TranscribeError("bad_response")
    words: list[dict[str, Any]] = []
    for item in raw_words:
        if len(words) >= TRANSCRIBE_WORDS_MAX:
            break
        word = _clean(item.get("word"), WORD_MAX)
        start, end = _int(item.get("start_ms")), _int(item.get("end_ms"))
        if not word or start is None or end is None:
            continue
        start = max(0, min(start, duration_ms))
        end = max(start, min(end, duration_ms))
        words.append({"word": word, "start_ms": start, "end_ms": end})
    text = _clean(data.get("text"), TRANSCRIBE_TEXT_MAX + 1)
    if not text and words:
        text = " ".join(w["word"] for w in words)
    if len(text) > TRANSCRIBE_TEXT_MAX:  # обрезка по слову
        cut = text[:TRANSCRIBE_TEXT_MAX]
        text = cut.rsplit(" ", 1)[0] if " " in cut else cut
    return text, words


def _ms(started: float) -> int:
    return max(0, int((time.perf_counter() - started) * 1000))


async def transcribe(deps: TranscribeDeps, meta: SpeechTranscribeMeta, audio: bytes, info: WavInfo, *, caller: str,
                     received: float) -> dict[str, Any]:
    """Одна запись → SpeechTranscribeResult. Недоступность — SpeechUnavailable (503). `received` — time.monotonic()
    приёма запроса (дедлайн)."""
    started = time.perf_counter()
    deadline = received + DEADLINE_S
    tr = deps.transcriber
    call_id = uuid.uuid4()
    async with deps.rt.transaction() as s:
        user_id: uuid.UUID | None = meta.user_id
        if await s.get(DeletedUser, meta.user_id) is not None:
            user_id = None  # удалённый ученик: учёт без идентификатора
        budget = await s.get(BudgetRow, 1)
        model = await s.get(ModelRow, tr.model_id)
    base: dict[str, Any] = {
        "call_id": call_id, "request_id": meta.request_id, "caller": caller[:32], "agent_id": AGENT_ID,
        "model_id": tr.model_id, "provider": tr.name, "session_id": meta.room_id, "session_kind": SESSION_KIND,
        "user_id": user_id, "audio_ms": info.duration_ms, "created_at": deps.clock(),
    }

    async def early(reason: str) -> SpeechUnavailable:
        async with deps.rt.transaction() as s:
            s.add(UsageRow(**base, status="unavailable", reason=reason, latency_ms=_ms(started),
                           finished_at=deps.clock()))
        _log("unavailable", reason, info.duration_ms, _ms(started), 0, tr.name, caller)
        return SpeechUnavailable(reason)

    if budget is None or not budget.ai_enabled:
        raise await early("ai_disabled")
    if not tr.ready() or model is None or not model.active:
        raise await early("not_configured")
    async with deps.rt.transaction() as s:
        s.add(UsageRow(**base, status="pending"))

    attempts = 0
    data: dict[str, Any] | None = None
    failure = "provider_error"
    while True:
        remaining = deadline - time.monotonic()
        timeout_s = min(ATTEMPT_TIMEOUT_S, remaining - MARGIN_S)
        if timeout_s < MIN_ATTEMPT_S:
            failure = "timeout"
            break
        attempts += 1
        try:
            async with asyncio.timeout(timeout_s):
                data = await tr.recognize(audio, timeout_s)
            break
        except TimeoutError:
            failure = "timeout"
            await deps.status.record_error("timeout", deps.clock())
            break
        except TranscribeError as exc:
            failure = "provider_error"
            await deps.status.record_error(exc.code, deps.clock())
            if exc.retryable and attempts < 2 and deadline - time.monotonic() >= RETRY_MIN_REMAINING_S:
                continue
            break
        except Exception as exc:  # распознаватель не должен ронять запрос: комната перейдёт на текст
            failure = "provider_error"
            log.warning("transcriber failed", extra={"error_type": type(exc).__name__})
            await deps.status.record_error("unexpected", deps.clock())
            break
    result: dict[str, Any] | None = None
    if data is not None:
        try:
            text, words = normalize(data, info.duration_ms)
            result = SpeechTranscribeResult.model_validate(
                {"text": text, "words": words, "duration_ms": info.duration_ms, "provider": tr.name,
                 "latency_ms": _ms(started)}).model_dump(mode="json")
        except TranscribeError as exc:
            await deps.status.record_error(exc.code, deps.clock())
            result = None
    latency = _ms(started)
    status, reason = ("ok", None) if result is not None else ("unavailable", failure)
    async with deps.rt.transaction() as s:
        await s.execute(update(UsageRow).where(UsageRow.call_id == call_id).values(
            status=status, reason=reason, cost_usd=0, reserved_usd=0, latency_ms=latency, attempts=attempts,
            finished_at=deps.clock()).execution_options(synchronize_session=False))
    _log(status, reason, info.duration_ms, latency, attempts, tr.name, caller)
    if result is None:
        raise SpeechUnavailable(failure)
    result["latency_ms"] = latency
    return result


def _log(status: str, reason: str | None, audio_ms: int, latency: int, attempts: int, provider: str,
         caller: str) -> None:
    """Только метаданные — без текста, слов и аудио."""
    log.info("speech transcribed", extra={"status": status, "reason": reason, "audio_ms": audio_ms,
                                          "latency_ms": latency, "attempts": attempts, "provider": provider,
                                          "caller": caller})
