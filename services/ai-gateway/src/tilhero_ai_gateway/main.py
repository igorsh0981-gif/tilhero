from __future__ import annotations

import logging

import httpx
from fastapi import FastAPI

from tilhero_ai_gateway.api.admin_agents import router as agents_router
from tilhero_ai_gateway.api.admin_costs import router as costs_router
from tilhero_ai_gateway.api.common import now_of
from tilhero_ai_gateway.api.internal import router as internal_router
from tilhero_ai_gateway.api.speech import SpeechBodyMiddleware
from tilhero_ai_gateway.api.speech import router as speech_router
from tilhero_ai_gateway.consumers import CONSUMER_USER_DELETED, DELETION_REQUESTED, deletion_handler
from tilhero_ai_gateway.domain import stand
from tilhero_ai_gateway.domain.invoke import Deps
from tilhero_ai_gateway.domain.provider_status import ProviderStatus
from tilhero_ai_gateway.domain.speech import ATTEMPT_TIMEOUT_S
from tilhero_ai_gateway.domain.transcribe import make_transcriber
from tilhero_ai_gateway.domain.versions import fail_stale_runs
from tilhero_ai_gateway.providers import Provider, make_provider
from tilhero_ai_gateway.providers.speech import TTS, SpeechProvider, make_speech_provider
from tilhero_ai_gateway.settings import Settings, get_settings
from tilhero_common.app import Runtime, create_app

log = logging.getLogger("tilhero.ai_gateway")


def build_app(settings: Settings | None = None, runtime: Runtime | None = None, *, provider: Provider | None = None,
              transport: httpx.AsyncBaseTransport | None = None, speech: SpeechProvider | None = None,
              speech_transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    """provider / transport — для тестов (подмена провайдера или транспорта httpx Anthropic); speech /
    speech_transport — то же для оценки произношения (транспорт Azure Speech или клиента tts для whisper)."""
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    ai = provider or make_provider(settings, transport)
    if settings.speech_provider != "fake" and settings.tts_url:
        # релиз 5.1: распознавание — сервис tts; повторы и таймаут попытки — в domain/speech.py (не в клиенте).
        # Спринт 7: голосовой ход парной комнаты распознаёт tts при любом провайдере оценки (Azure — только оценка)
        runtime.register_client(TTS, settings.tts_url, timeout=ATTEMPT_TIMEOUT_S + 1, retries=0,
                                transport=speech_transport)
    speech_provider = speech or make_speech_provider(settings, speech_transport, runtime)
    transcriber = make_transcriber(settings, runtime)

    def configure(rt: Runtime) -> None:
        rt.add_consumer(CONSUMER_USER_DELETED, [DELETION_REQUESTED], deletion_handler(rt))

        async def on_start(rt: Runtime) -> None:
            if rt.db is None:
                return
            async with rt.transaction() as session:
                stale = await fail_stale_runs(session, now_of(rt), settings.golden_run_stale_minutes)
            if stale:
                log.warning("stale golden runs marked failed", extra={"runs": stale})
            if settings.speech_provider != "fake" and not speech_provider.ready():
                log.info("pronunciation assessment not configured", extra={"provider": settings.speech_provider})
            # dev/e2e-стенд (AI_ALLOW_FAKE_TEST_PUBLISH, fake): черновики сида — прогон на fake и публикация
            deps = Deps(rt=rt, settings=settings, provider=ai, clock=lambda: now_of(rt),
                        status=ProviderStatus(rt.redis, settings.cache_namespace))
            try:
                published = await stand.publish_seed_drafts(deps)
            except Exception as exc:  # стенд: публикация сида не должна мешать старту
                log.warning("stand seed publication failed", extra={"error_type": type(exc).__name__})
            else:
                if published:
                    log.info("stand seed drafts processed", extra={"versions": published})

        async def on_stop(_: Runtime) -> None:
            await ai.aclose()
            await speech_provider.aclose()

        rt.on_startup(on_start)
        rt.on_shutdown(on_stop)

    app = create_app(settings, routers=[internal_router, speech_router, agents_router, costs_router],
                     runtime=runtime, configure=configure, title="TilHero ai-gateway")
    # WAV до 600 000 байт для одного маршрута при общем лимите тела 256 КиБ — снаружи общего middleware
    app.add_middleware(SpeechBodyMiddleware)
    app.state.provider = ai
    app.state.speech = speech_provider
    app.state.transcriber = transcriber
    return app


app = build_app()
