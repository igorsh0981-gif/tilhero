"""Синтез речи: Piper (нейронные голоса, CPU) → MP3 (lameenc). Fake — детерминированная заглушка для dev/test.

MP3 моно: играет в `HTMLAudioElement` на iOS (WKWebView) и Android (WebView) без перекодирования.
Громкость: Piper нормализует амплитуду (`normalize_audio`), поверх — небольшой запас до 0 dBFS (`volume`).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from pathlib import Path
from typing import Any, Literal, Protocol

from tilhero_tts.settings import Settings, Variant

log = logging.getLogger("tilhero.tts.synth")

Speed = Literal["normal", "slow"]

# кадр MPEG-1 Layer III, 64 кбит/с, 22,05 кГц… — для fake достаточно валидного заголовка ID3 + данных
_FAKE_HEADER = b"ID3\x04\x00\x00\x00\x00\x00\x00"


class Synthesizer(Protocol):
    def voices_ready(self) -> bool: ...

    async def mp3(self, text: str, variant: Variant, speed: Speed) -> bytes: ...


class FakeSynthesizer:
    """dev/test: байты зависят от (голос, скорость, текст) — тесты проверяют кеш и маршрутизацию голосов."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.calls: list[tuple[str, str, str]] = []

    def voices_ready(self) -> bool:
        return True

    async def mp3(self, text: str, variant: Variant, speed: Speed) -> bytes:
        voice = self.settings.voice_for(variant)
        self.calls.append((text, voice, speed))
        digest = hashlib.sha256(f"{voice}|{speed}|{text}".encode()).digest()
        return _FAKE_HEADER + digest * 8


class PiperSynthesizer:
    """Голоса грузятся при старте (сбой — сервис не стартует, healthcheck не пройдёт). Синтез — в потоке, не больше
    `tts_concurrency` одновременно; длинный синтез обрывается по таймауту ожидания (поток досчитает и освободится)."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._voices: dict[str, Any] = {}
        self._sem = asyncio.Semaphore(settings.tts_concurrency)

    def load(self) -> None:
        from piper import PiperVoice  # тяжёлый импорт (onnxruntime) — только в prod-движке

        base = Path(self.settings.tts_voices_dir)
        for name in {self.settings.tts_voice_en_us, self.settings.tts_voice_en_gb}:
            model = base / f"{name}.onnx"
            config = base / f"{name}.onnx.json"
            if not model.is_file() or not config.is_file():
                raise RuntimeError(f"voice model not found: {name}")
            self._voices[name] = PiperVoice.load(model, config_path=config)
            log.info("voice loaded", extra={"voice": name})

    def voices_ready(self) -> bool:
        return {self.settings.tts_voice_en_us, self.settings.tts_voice_en_gb} <= set(self._voices)

    async def mp3(self, text: str, variant: Variant, speed: Speed) -> bytes:
        voice = self._voices[self.settings.voice_for(variant)]
        scale = self.settings.tts_length_scale_slow if speed == "slow" else self.settings.tts_length_scale_normal
        async with self._sem:
            return await asyncio.wait_for(asyncio.to_thread(self._render, voice, text, scale),
                                          self.settings.tts_synth_timeout_seconds)

    def _render(self, voice: Any, text: str, length_scale: float) -> bytes:
        import lameenc
        from piper.config import SynthesisConfig

        cfg = SynthesisConfig(length_scale=length_scale, normalize_audio=True, volume=0.95)
        pcm = bytearray()
        rate = channels = 0
        for chunk in voice.synthesize(text, syn_config=cfg):
            rate, channels = chunk.sample_rate, chunk.sample_channels
            pcm += chunk.audio_int16_bytes
        if not pcm:
            raise RuntimeError("empty synthesis")
        # 150 мс тишины в начале: первые миллисекунды на мобильных WebView иногда «съедаются» при старте вывода
        lead = bytes(int(rate * 0.15) * 2 * channels)
        enc = lameenc.Encoder()
        enc.set_bit_rate(self.settings.tts_mp3_bitrate_kbps)
        enc.set_in_sample_rate(rate)
        enc.set_channels(channels)
        enc.set_quality(2)
        return bytes(enc.encode(lead + bytes(pcm)) + enc.flush())


def build_synthesizer(settings: Settings) -> FakeSynthesizer | PiperSynthesizer:
    if settings.tts_engine == "fake":
        return FakeSynthesizer(settings)
    synth = PiperSynthesizer(settings)
    synth.load()
    return synth
