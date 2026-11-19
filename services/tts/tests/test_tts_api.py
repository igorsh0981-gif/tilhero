"""POST /internal/v1/speech: MP3, голос по варианту, скорость, кеш, валидация текста, доступ только telegram-bff."""

from __future__ import annotations

import pytest
from conftest import Env

from tilhero_tts.api import normalize
from tilhero_tts.settings import Settings


async def test_speech_returns_mp3_with_cache_headers(env: Env) -> None:
    r = await env.speak("Excuse me, where is the train station?", "en-US")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.headers["cache-control"] == "private, max-age=86400" and r.headers["x-tts-cache"] == "miss"
    assert r.content.startswith(b"ID3")
    assert env.synth.calls == [("Excuse me, where is the train station?", "en-us-ryan-high", "normal")]


async def test_voice_by_variant_and_speed(env: Env) -> None:
    gb = await env.speak("Good morning!", "en-GB")
    us = await env.speak("Good morning!", "en-US")
    slow = await env.speak("Good morning!", "en-GB", "slow")
    assert len({gb.content, us.content, slow.content}) == 3
    assert [c[1:] for c in env.synth.calls] == [("en-gb-southern_english_female-low", "normal"),
                                                ("en-us-ryan-high", "normal"),
                                                ("en-gb-southern_english_female-low", "slow")]


async def test_cache_hit_skips_synthesis_and_whitespace_is_normalized(env: Env) -> None:
    first = await env.speak("  Nice   to meet you. ")
    again = await env.speak("Nice to meet you.")
    assert first.headers["x-tts-cache"] == "miss" and again.headers["x-tts-cache"] == "hit"
    assert first.content == again.content and len(env.synth.calls) == 1
    assert env.synth.calls[0][0] == "Nice to meet you."


async def test_without_redis_synthesizes_every_time(env_no_redis: Env) -> None:
    for _ in range(2):
        r = await env_no_redis.speak("Thank you.")
        assert r.status_code == 200 and r.headers["x-tts-cache"] == "miss"
    assert len(env_no_redis.synth.calls) == 2


@pytest.mark.parametrize("text", ["   ", "Привет, как дела?", "x" * 401, "Hello\x00world", "12345"])
async def test_invalid_text_422(env: Env, text: str) -> None:
    r = await env.speak(text)
    assert r.status_code == 422 and r.json()["code"] in ("TEXT_INVALID", "VALIDATION_ERROR"), r.text
    assert env.synth.calls == []


async def test_invalid_variant_and_extra_fields_422(env: Env) -> None:
    for body in ({"text": "Hi", "variant": "en-AU"}, {"text": "Hi", "variant": "en-GB", "speed": "fast"},
                 {"text": "Hi", "variant": "en-GB", "voice": "x"}):
        r = await env.c.post("/internal/v1/speech", json=body, headers=env.h())
        assert r.status_code == 422, body


async def test_only_telegram_bff_may_call(env: Env) -> None:
    assert (await env.c.post("/internal/v1/speech", json={"text": "Hi", "variant": "en-GB"})).status_code == 401
    r = await env.speak("Hi", issuer="admin-bff")
    assert r.status_code == 403
    assert env.synth.calls == []


async def test_synthesis_failure_is_503(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(*_: object) -> bytes:
        raise TimeoutError

    monkeypatch.setattr(env.synth, "mp3", boom)
    r = await env.speak("Where is the bus stop?")
    assert r.status_code == 503 and r.json()["code"] == "SPEECH_UNAVAILABLE"


def test_normalize_and_settings_guard() -> None:
    assert normalize("Hi,\n  Tom!", 400) == "Hi, Tom!"
    assert normalize("It's 5 o'clock.", 400) == "It's 5 o'clock."
    with pytest.raises(ValueError, match="TTS_ENGINE"):
        Settings(env="prod", internal_jwt_secret="s" * 40, internal_jwt_private_key="a" * 43, tts_engine="fake")
