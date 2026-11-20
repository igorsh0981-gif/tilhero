"""Настоящая модель faster-whisper (если доступна — ASR_TEST_MODEL_DIR, каталог с model.bin, config.json, …; в образе
/app/asr/base.en): тишина → слов нет; фраза, озвученная Piper (если ещё доступны голоса — TTS_TEST_VOICES_DIR),
распознаётся по словам с временем и вероятностью.

В CI модели нет (Hugging Face со стенда закрыт) — тест пропускается; распознавание на модели проверяется сборкой
образа и smoke после выкладки.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from tilhero_tts.asr import WhisperRecognizer
from tilhero_tts.settings import Settings
from tilhero_tts.wav import make_wav, parse_wav

MODEL_DIR = os.environ.get("ASR_TEST_MODEL_DIR", "")
VOICES = os.environ.get("TTS_TEST_VOICES_DIR", "/app/voices")
pytestmark = pytest.mark.skipif(not MODEL_DIR or not (Path(MODEL_DIR) / "model.bin").is_file(),
                                reason="модель faster-whisper не установлена (ASR_TEST_MODEL_DIR)")


def _recognizer() -> WhisperRecognizer:
    path = Path(MODEL_DIR)
    rec = WhisperRecognizer(Settings(env="test", asr_model_dir=str(path.parent), asr_model=path.name,
                                     asr_timeout_seconds=60))
    rec.load()
    return rec


async def test_silence_has_no_words() -> None:
    rec = _recognizer()
    wav = make_wav(2000, amplitude=0)
    result = await rec.recognize(wav, parse_wav(wav))
    assert result.words == []


@pytest.mark.skipif(not (Path(VOICES) / "en-us-ryan-high.onnx").is_file(), reason="голоса Piper не установлены")
async def test_piper_phrase_is_recognized() -> None:
    import numpy as np
    from piper import PiperVoice

    voice = PiperVoice.load(Path(VOICES) / "en-us-ryan-high.onnx")
    chunks = list(voice.synthesize("Good morning, I have a reservation."))
    pcm = np.frombuffer(b"".join(c.audio_int16_bytes for c in chunks), dtype="<i2").astype(np.float32)
    rate = chunks[0].sample_rate
    # линейная передискретизация в 16 кГц (Piper даёт 22 050 Гц)
    target = np.interp(np.arange(0, len(pcm), rate / 16_000), np.arange(len(pcm)), pcm).astype("<i2")
    wav = make_wav(0, pcm=target.tobytes())
    rec = _recognizer()
    result = await rec.recognize(wav, parse_wav(wav))
    said = [re.sub(r"[^a-z']", "", w.word.lower()) for w in result.words]
    assert said == ["good", "morning", "i", "have", "a", "reservation"], result
    assert all(0 <= w.start_ms <= w.end_ms and 0 < w.probability <= 1 for w in result.words)
