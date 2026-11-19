from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import HEADER, issue_token
from tilhero_common.testing import TEST_REDIS_URL
from tilhero_tts.main import build_app
from tilhero_tts.settings import Settings
from tilhero_tts.synth import FakeSynthesizer


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {"env": "test", "internal_jwt_secret": "t" * 40, "redis_url": TEST_REDIS_URL,
                            "tts_engine": "fake", "tts_cache_namespace": f"t:tts:{uuid.uuid4().hex[:10]}"}
    base.update(kw)
    return Settings(**base)


class Env:
    def __init__(self, c: httpx.AsyncClient, settings: Settings, synth: FakeSynthesizer) -> None:
        self.c, self.settings, self.synth = c, settings, synth

    def h(self, issuer: str = "telegram-bff") -> dict[str, str]:
        token = issue_token(self.settings.internal_jwt_secret.get_secret_value(), issuer=issuer,
                            audience=self.settings.service_name, subject=str(uuid.uuid4()))
        return {HEADER: token}

    async def speak(self, text: str, variant: str = "en-GB", speed: str | None = None,
                    issuer: str = "telegram-bff") -> httpx.Response:
        body: dict[str, Any] = {"text": text, "variant": variant}
        if speed:
            body["speed"] = speed
        return await self.c.post("/internal/v1/speech", json=body, headers=self.h(issuer))


async def _env(**kw: Any) -> AsyncIterator[Env]:
    settings = make_settings(**kw)
    synth = FakeSynthesizer(settings)
    app = build_app(settings, Runtime(settings), synth=synth)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://tts") as c:
            yield Env(c, settings, synth)


@pytest.fixture
async def env() -> AsyncIterator[Env]:
    async for e in _env():
        yield e


@pytest.fixture
async def env_no_redis() -> AsyncIterator[Env]:
    async for e in _env(redis_url=None):
        yield e
