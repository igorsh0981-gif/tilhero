"""Настоящий Piper (если голоса доступны — TTS_TEST_VOICES_DIR или /app/voices в образе): MP3 корректен, slow длиннее.

В CI голосов нет — тест пропускается; синтез на голосах проверяется сборкой образа (Dockerfile) и smoke после выкладки.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from tilhero_tts.settings import Settings
from tilhero_tts.synth import PiperSynthesizer

VOICES = os.environ.get("TTS_TEST_VOICES_DIR", "/app/voices")
NEEDED = ("en-us-ryan-high", "en-gb-southern_english_female-low")
pytestmark = pytest.mark.skipif(not all((Path(VOICES) / f"{n}.onnx").is_file() for n in NEEDED),
                                reason="голоса Piper не установлены (TTS_TEST_VOICES_DIR)")


async def test_piper_mp3_both_voices_and_speed() -> None:
    synth = PiperSynthesizer(Settings(env="test", tts_voices_dir=VOICES))
    synth.load()
    assert synth.voices_ready()
    us = await synth.mp3("Excuse me, could you tell me where the train station is?", "en-US", "normal")
    gb = await synth.mp3("Excuse me, could you tell me where the train station is?", "en-GB", "normal")
    slow = await synth.mp3("Excuse me, could you tell me where the train station is?", "en-GB", "slow")
    for audio in (us, gb, slow):
        # MPEG audio: кадр начинается с синхрослова 0xFFE / 0xFFF
        assert len(audio) > 10_000 and audio[0] == 0xFF and audio[1] & 0xE0 == 0xE0
    assert len(slow) > len(gb)
