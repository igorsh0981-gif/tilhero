"""Распознавание речи для оценки произношения (релиз 5.1, решение владельца 20.11.2026: свой сервер вместо Azure).

**whisper** — faster-whisper (CTranslate2, CPU, `compute_type=int8`), модель `ASR_MODEL` (по умолчанию `base.en`) из
образа (`ASR_MODEL_DIR/<ASR_MODEL>`, скачивается при сборке Dockerfile по закреплённому коммиту Hugging Face).
Загружается при старте — без модели сервис не стартует (как голоса Piper). Параметры распознавания:
`language="en"`, `beam_size` из настроек (1–5), `word_timestamps=True` (слова с временем и вероятностью),
`vad_filter=True` (тишина по краям и паузы не распознаются как слова), `temperature=0` (без повторов с «разогревом» —
предсказуемое время), `condition_on_previous_text=False`, **без `initial_prompt`**: эталонная фраза модели не
подсказывается, иначе модель «исправит» произношение и пропущенные или искажённые слова не будут видны.
Не больше `ASR_CONCURRENCY` распознаваний одновременно (CPU); очередь и распознавание — в пределах
`ASR_TIMEOUT_SECONDS`. Место в очереди освобождается, только когда поток распознавания действительно закончил (поток
нельзя прервать: иначе после таймаута на CPU работали бы два распознавания).

**fake** (dev/test, CI, стенд; в stage/prod запрещён): средняя |амплитуда| < 200 → слов нет; иначе слова из
комментария WAV (`LIST/INFO/ICMT`) с вероятностью 0,9 и равномерным временем; нет комментария — слов нет.

Аудио — только аргумент вызова на время запроса: не пишется на диск, в Redis и логи.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Final, Protocol

from tilhero_tts.settings import Settings
from tilhero_tts.wav import WavInfo, mean_amplitude

log = logging.getLogger("tilhero.tts.asr")

SILENCE_AMPLITUDE: Final = 200
FAKE_PROBABILITY: Final = 0.9
_FAKE_WORD = re.compile(r"\S+")


@dataclass(frozen=True)
class Word:
    word: str
    start_ms: int
    end_ms: int
    probability: float


@dataclass(frozen=True)
class Recognition:
    text: str
    words: list[Word] = field(default_factory=list)


class Recognizer(Protocol):
    model_name: str

    def ready(self) -> bool: ...

    async def recognize(self, wav: bytes, info: WavInfo) -> Recognition: ...


class FakeRecognizer:
    model_name = "fake"

    def __init__(self) -> None:
        self.calls = 0

    def ready(self) -> bool:
        return True

    async def recognize(self, wav: bytes, info: WavInfo) -> Recognition:
        self.calls += 1
        if mean_amplitude(wav, info) < SILENCE_AMPLITUDE or not info.comment:
            return Recognition(text="")
        tokens = _FAKE_WORD.findall(info.comment)
        step = info.duration_ms // max(len(tokens), 1)
        words = [Word(word=t, start_ms=i * step, end_ms=(i + 1) * step, probability=FAKE_PROBABILITY)
                 for i, t in enumerate(tokens)]
        return Recognition(text=" ".join(tokens), words=words)


class WhisperRecognizer:
    def __init__(self, settings: Settings, model: Any | None = None) -> None:
        """model — для тестов (подмена WhisperModel); в prod загружается `load()` при старте."""
        self.settings = settings
        self._model = model
        self._sem = asyncio.Semaphore(settings.asr_concurrency)
        self.model_name = f"faster-whisper-{settings.asr_model}"

    def load(self) -> None:
        from faster_whisper import WhisperModel  # тяжёлый импорт (ctranslate2) — только в prod-движке

        path = self.settings.asr_model_path
        if not (path / "model.bin").is_file() or not (path / "config.json").is_file():
            raise RuntimeError(f"ASR model not found: {self.settings.asr_model}")
        self._model = WhisperModel(str(path), device="cpu", compute_type="int8",
                                   cpu_threads=self.settings.asr_cpu_threads, num_workers=1, local_files_only=True)
        log.info("asr model loaded", extra={"model": self.model_name})

    def ready(self) -> bool:
        return self._model is not None

    async def recognize(self, wav: bytes, info: WavInfo) -> Recognition:
        pcm = wav[info.data_offset:info.data_offset + info.data_size]
        deadline = time.monotonic() + self.settings.asr_timeout_seconds
        await asyncio.wait_for(self._sem.acquire(), timeout=self.settings.asr_timeout_seconds)
        task = asyncio.ensure_future(asyncio.to_thread(self._run, pcm))
        task.add_done_callback(lambda _: self._sem.release())  # очередь — после реального конца распознавания
        return await asyncio.wait_for(asyncio.shield(task), timeout=max(0.01, deadline - time.monotonic()))

    def transcribe_options(self) -> dict[str, Any]:
        return {"language": "en", "task": "transcribe", "beam_size": self.settings.asr_beam_size,
                "word_timestamps": True, "vad_filter": True, "initial_prompt": None, "temperature": 0.0,
                "condition_on_previous_text": False}

    def _run(self, pcm: bytes) -> Recognition:
        import numpy as np

        if self._model is None:
            raise RuntimeError("ASR model is not loaded")
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        segments, _ = self._model.transcribe(audio, **self.transcribe_options())
        texts: list[str] = []
        words: list[Word] = []
        for segment in segments:  # генератор: распознавание идёт при обходе
            texts.append(str(segment.text).strip())
            for w in segment.words or []:
                text = str(w.word).strip()
                if text:
                    words.append(Word(word=text, start_ms=max(0, round(float(w.start) * 1000)),
                                      end_ms=max(0, round(float(w.end) * 1000)),
                                      probability=round(min(1.0, max(0.0, float(w.probability))), 4)))
        return Recognition(text=" ".join(t for t in texts if t), words=words)


def build_recognizer(settings: Settings) -> FakeRecognizer | WhisperRecognizer:
    if settings.asr_engine == "fake":
        return FakeRecognizer()
    recognizer = WhisperRecognizer(settings)
    recognizer.load()
    return recognizer
