"""tts: серверная озвучка фраз контента и распознавание речи для оценки произношения (релиз 5.1). Без БД и шины:
Redis — кеш MP3 (отдельный бинарный клиент: общий клиент Runtime декодирует ответы в строки). Голоса Piper и модель
faster-whisper грузятся при старте — без них сервис не стартует."""

from __future__ import annotations

import asyncio
import logging

from fastapi import FastAPI
from redis.asyncio import Redis

from tilhero_common.app import Runtime, create_app
from tilhero_tts.api import router
from tilhero_tts.asr import FakeRecognizer, WhisperRecognizer, build_recognizer
from tilhero_tts.recognize import AudioBodyMiddleware
from tilhero_tts.recognize import router as recognize_router
from tilhero_tts.settings import Settings, get_settings
from tilhero_tts.synth import FakeSynthesizer, PiperSynthesizer, build_synthesizer

log = logging.getLogger("tilhero.tts")


def build_app(settings: Settings | None = None, runtime: Runtime | None = None, *,
              synth: FakeSynthesizer | PiperSynthesizer | None = None,
              recognizer: FakeRecognizer | WhisperRecognizer | None = None) -> FastAPI:
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    app = create_app(settings, routers=[router, recognize_router], runtime=runtime, title="TilHero tts-service")
    # WAV до 600 000 байт для маршрута распознавания при общем лимите тела 256 КиБ — снаружи общего middleware
    app.add_middleware(AudioBodyMiddleware)
    app.state.synth = synth
    app.state.recognizer = recognizer
    app.state.audio_cache = None

    async def startup(_: Runtime) -> None:
        if app.state.synth is None:
            # загрузка моделей (~1–3 с) — в потоке, чтобы не держать цикл событий
            app.state.synth = await asyncio.to_thread(build_synthesizer, settings)
        if app.state.recognizer is None:
            app.state.recognizer = await asyncio.to_thread(build_recognizer, settings)
        if settings.redis_url:
            app.state.audio_cache = Redis.from_url(settings.redis_url, decode_responses=False)

    async def shutdown(_: Runtime) -> None:
        cache = app.state.audio_cache
        if cache is not None:
            await cache.aclose()
            app.state.audio_cache = None

    runtime.on_startup(startup)
    runtime.on_shutdown(shutdown)
    return app


app = build_app()
