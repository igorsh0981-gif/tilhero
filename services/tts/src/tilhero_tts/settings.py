"""Настройки tts. Голоса Piper лежат в образе (`TTS_VOICES_DIR`, скачиваются при сборке Dockerfile)."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator

from tilhero_common.settings import ServiceSettings

Variant = Literal["en-GB", "en-US"]


class Settings(ServiceSettings):
    service_name: str = "tts"
    port: int = 8115

    # piper — нейронный синтез (prod); fake — детерминированный MP3-заглушка без модели (dev/test, CI)
    tts_engine: Literal["piper", "fake"] = "piper"
    tts_voices_dir: str = "/app/voices"
    # голос по варианту: имя модели `<name>.onnx` (+ `.onnx.json`) в TTS_VOICES_DIR; выбор владельца 19.11.2026
    tts_voice_en_us: str = "en-us-ryan-high"
    tts_voice_en_gb: str = "en-gb-southern_english_female-low"
    # скорость: length_scale Piper (> 1 — медленнее); slow — дети 6–13
    tts_length_scale_normal: float = Field(default=1.0, gt=0.5, le=2.0)
    tts_length_scale_slow: float = Field(default=1.2, gt=0.5, le=2.0)
    tts_max_text_chars: int = Field(default=400, ge=10, le=2000)
    tts_mp3_bitrate_kbps: int = Field(default=64, ge=32, le=192)
    # одновременных синтезов (CPU); остальные ждут
    tts_concurrency: int = Field(default=2, ge=1, le=16)
    tts_synth_timeout_seconds: float = Field(default=12.0, gt=0, le=60)
    # кеш MP3 в Redis: фразы контента повторяются у всех учеников
    tts_cache_ttl_days: int = Field(default=30, ge=1, le=365)
    tts_cache_namespace: str = "tts:v1"

    @model_validator(mode="after")
    def _engine_guard(self) -> Settings:
        if self.is_secure_env and self.tts_engine == "fake":
            raise ValueError("TTS_ENGINE=fake is not allowed in stage/prod")
        return self

    def voice_for(self, variant: Variant) -> str:
        return self.tts_voice_en_us if variant == "en-US" else self.tts_voice_en_gb


@lru_cache
def get_settings() -> Settings:
    return Settings()
