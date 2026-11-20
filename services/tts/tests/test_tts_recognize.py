"""POST /internal/v1/recognize (релиз 5.1): распознавание записи для оценки произношения — вызывающий только ai-gateway,
WAV (PCM 16 бит, моно, 16 кГц, 0,5..15 с, ≤ 600 000 байт — больше общего лимита тела 256 КиБ), ответ {text, words,
duration_ms, model}; ошибки 422 AUDIO_INVALID / 503 RECOGNITION_UNAVAILABLE; параметры faster-whisper (en, слова со
временем, VAD, без подсказки эталона); очередь распознаваний; аудио и текст — не в логах."""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace
from typing import Any

import pytest
from conftest import Env, _env

from tilhero_tts.asr import WhisperRecognizer
from tilhero_tts.settings import Settings
from tilhero_tts.wav import make_wav, parse_wav

PHRASE = "Good morning, I have a reservation"


async def test_recognize_fake_words(env: Env) -> None:
    r = await env.recognize(make_wav(2400, comment=PHRASE))
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"text", "words", "duration_ms", "model"}
    assert (body["text"], body["duration_ms"], body["model"]) == (PHRASE, 2400, "fake")
    assert [w["word"] for w in body["words"]] == ["Good", "morning,", "I", "have", "a", "reservation"]
    assert body["words"][0] == {"word": "Good", "start_ms": 0, "end_ms": 400, "probability": 0.9}
    assert all(set(w) == {"word", "start_ms", "end_ms", "probability"} for w in body["words"])


@pytest.mark.parametrize("wav", [make_wav(1500, amplitude=20, comment=PHRASE), make_wav(1500)])
async def test_silence_or_nothing_said_is_empty_not_error(env: Env, wav: bytes) -> None:
    r = await env.recognize(wav)
    assert r.status_code == 200 and r.json()["words"] == [] and r.json()["text"] == ""


async def test_fifteen_seconds_above_common_body_limit(env: Env) -> None:
    long = make_wav(15_000, comment="Hello")
    assert 256 * 1024 < len(long) <= 600_000
    r = await env.recognize(long)
    assert r.status_code == 200 and r.json()["duration_ms"] == 15_000
    r = await env.recognize(long + b"\0" * 200_000)
    assert r.status_code == 422 and r.json() == {**r.json(), "code": "AUDIO_INVALID"}
    assert r.json()["details"] == {"reason": "too_large"}


@pytest.mark.parametrize(("wav", "content_type", "reason"), [
    (b"OggS" + b"\0" * 200, "audio/wav", "format"),
    (make_wav(2000, channels=2), "audio/wav", "format"),
    (make_wav(2000, rate=44_100), "audio/wav", "format"),
    (make_wav(2000, bits=8), "audio/wav", "format"),
    (make_wav(2000), "audio/ogg", "format"),
    (b"", "audio/wav", "format"),
    (make_wav(400), "audio/wav", "too_short"),
    (make_wav(15_200), "audio/wav", "too_long"),
    (make_wav(15_000) + b"\0" * 130_000, "audio/wav", "too_large"),
])
async def test_audio_invalid(env: Env, wav: bytes, content_type: str, reason: str) -> None:
    r = await env.recognize(wav, content_type=content_type)
    assert r.status_code == 422 and r.json()["code"] == "AUDIO_INVALID", r.text
    assert r.json()["details"] == {"reason": reason}
    assert env.recognizer.calls == 0  # type: ignore[union-attr]


async def test_only_ai_gateway_may_call(env: Env) -> None:
    r = await env.recognize(make_wav(1000), token=False)
    assert r.status_code == 401
    for issuer in ("telegram-bff", "memory", "admin-bff"):
        r = await env.recognize(make_wav(1000, comment="Hi"), issuer=issuer)
        assert r.status_code == 403, issuer
    assert env.recognizer.calls == 0  # type: ignore[union-attr]


async def test_failure_is_503_and_no_audio_or_text_in_logs(env: Env, monkeypatch: pytest.MonkeyPatch,
                                                           caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    r = await env.recognize(make_wav(1800, comment="Zebracorn marmalade"))
    assert r.status_code == 200
    assert "zebracorn" not in caplog.text.lower() and "RIFF" not in caplog.text
    assert any(getattr(rec, "duration_ms", None) == 1800 and getattr(rec, "words", None) == 2
               for rec in caplog.records)

    async def boom(*_: object) -> Any:
        raise TimeoutError

    monkeypatch.setattr(env.recognizer, "recognize", boom)
    r = await env.recognize(make_wav(1000, comment="Hi"))
    assert r.status_code == 503 and r.json()["code"] == "RECOGNITION_UNAVAILABLE"


def test_parse_wav_comment_and_settings_guard() -> None:
    info = parse_wav(make_wav(1000, comment="I'm here"))
    assert (info.duration_ms, info.comment) == (1000, "I'm here")
    assert parse_wav(make_wav(1000)).comment is None
    with pytest.raises(ValueError, match="ASR_ENGINE"):
        Settings(env="prod", internal_jwt_secret="s" * 40, internal_jwt_private_key="a" * 43, tts_engine="piper",
                 asr_engine="fake")
    s = Settings(env="test", asr_model_dir="/m", asr_model="small.en")
    assert str(s.asr_model_path) == "/m/small.en"
    with pytest.raises(ValueError):
        Settings(env="test", asr_beam_size=6)


# ---------------------------------------------------------------- WhisperRecognizer без настоящей модели


class FakeModel:
    """Подмена faster_whisper.WhisperModel: записывает параметры transcribe, отдаёт заданные сегменты."""

    def __init__(self, segments: list[Any], delay: float = 0.0) -> None:
        self.segments = segments
        self.delay = delay
        self.calls: list[dict[str, Any]] = []
        self.audio_len: list[int] = []

    def transcribe(self, audio: Any, **kw: Any) -> tuple[Any, Any]:
        import time

        self.calls.append(kw)
        self.audio_len.append(len(audio))
        if self.delay:
            time.sleep(self.delay)
        return iter(self.segments), SimpleNamespace(language="en")


def _seg(text: str, *words: tuple[str, float, float, float]) -> Any:
    return SimpleNamespace(text=text, words=[SimpleNamespace(word=w, start=s, end=e, probability=p)
                                             for w, s, e, p in words])


async def test_whisper_recognizer_options_and_mapping() -> None:
    model = FakeModel([_seg(" Good morning.", (" Good", 0.0, 0.42, 0.97), (" morning.", 0.42, 1.004, 0.71)),
                       _seg(" I have a", (" I", 1.3, 1.4, 1.2), (" ", 1.4, 1.5, 0.5))])
    settings = Settings(env="test", asr_engine="fake", asr_beam_size=3)
    rec = WhisperRecognizer(settings, model=model)
    wav = make_wav(1600)
    result = await rec.recognize(wav, parse_wav(wav))
    assert model.calls == [{"language": "en", "task": "transcribe", "beam_size": 3, "word_timestamps": True,
                            "vad_filter": True, "initial_prompt": None, "temperature": 0.0,
                            "condition_on_previous_text": False}]
    assert model.audio_len == [1600 * 16]  # отсчёты PCM 16 кГц
    assert result.text == "Good morning. I have a"
    assert [(w.word, w.start_ms, w.end_ms, w.probability) for w in result.words] == [
        ("Good", 0, 420, 0.97), ("morning.", 420, 1004, 0.71), ("I", 1300, 1400, 1.0)]
    assert rec.model_name == "faster-whisper-base.en" and rec.ready()


async def test_whisper_concurrency_and_timeout() -> None:
    """Не больше ASR_CONCURRENCY распознаваний; таймаут — ошибка (503 в API), а место в очереди освобождается только
    после реального конца распознавания."""
    model = FakeModel([_seg(" Hi", (" Hi", 0.0, 0.3, 0.9))], delay=0.6)
    settings = Settings(env="test", asr_engine="fake", asr_concurrency=1, asr_timeout_seconds=0.2)
    rec = WhisperRecognizer(settings, model=model)
    wav = make_wav(1000)
    with pytest.raises(TimeoutError):
        await rec.recognize(wav, parse_wav(wav))
    with pytest.raises(TimeoutError):  # первый ещё считает — второй не дождался места в очереди
        await rec.recognize(wav, parse_wav(wav))
    assert len(model.calls) == 1
    await asyncio.sleep(0.4)  # первый поток закончил (0,6 с) — место освободилось
    settings.asr_timeout_seconds = 2.0
    result = await rec.recognize(wav, parse_wav(wav))
    assert [w.word for w in result.words] == ["Hi"] and len(model.calls) == 2


async def test_api_with_whisper_recognizer() -> None:
    model = FakeModel([_seg(" I'd like tea.", (" I'd", 0.1, 0.3, 0.88), (" like", 0.3, 0.5, 0.93),
                            (" tea.", 0.5, 0.9, 0.64))])
    rec = WhisperRecognizer(Settings(env="test", asr_engine="fake"), model=model)
    async for env in _env(recognizer=rec):
        r = await env.recognize(make_wav(1200))
        assert r.status_code == 200, r.text
        assert r.json()["model"] == "faster-whisper-base.en" and r.json()["text"] == "I'd like tea."
        assert [w["probability"] for w in r.json()["words"]] == [0.88, 0.93, 0.64]


def test_load_without_model_fails(tmp_path: Any) -> None:
    rec = WhisperRecognizer(Settings(env="test", asr_model_dir=str(tmp_path)))
    with pytest.raises(RuntimeError, match="ASR model not found"):
        rec.load()
