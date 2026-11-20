"""Проверка WAV оценки произношения (INTERNAL_API §1.9, §3.2): RIFF/WAVE, PCM 16 бит, моно, 16 000 Гц, 0,5..15 с,
≤ 600 000 байт. Ошибка → 422 AUDIO_INVALID {reason: format | too_short | too_long | too_large}.

Аудио живёт только в памяти процесса на время запроса: модуль читает байты и ничего не сохраняет.
"""

from __future__ import annotations

import array
import struct
import sys
from dataclasses import dataclass
from typing import Final, Literal

MAX_AUDIO_BYTES: Final = 600_000
MIN_DURATION_MS: Final = 500
MAX_DURATION_MS: Final = 15_000
SAMPLE_RATE: Final = 16_000
BYTES_PER_SAMPLE: Final = 2
BYTES_PER_MS: Final = SAMPLE_RATE * BYTES_PER_SAMPLE // 1000  # 32
MAX_CHUNKS: Final = 32
PCM: Final = 1

AudioReason = Literal["format", "too_short", "too_long", "too_large"]


class AudioInvalid(ValueError):
    def __init__(self, reason: AudioReason) -> None:
        super().__init__(reason)
        self.reason: AudioReason = reason


@dataclass(frozen=True)
class WavInfo:
    duration_ms: int
    data_offset: int
    data_size: int


def parse_wav(body: bytes) -> WavInfo:
    """Заголовок и длительность. Порядок проверок: размер → формат → длительность."""
    if len(body) > MAX_AUDIO_BYTES:
        raise AudioInvalid("too_large")
    if len(body) < 44 or body[0:4] != b"RIFF" or body[8:12] != b"WAVE":
        raise AudioInvalid("format")
    offset, fmt_ok, chunks = 12, False, 0
    while offset + 8 <= len(body) and chunks < MAX_CHUNKS:
        chunks += 1
        chunk_id = body[offset:offset + 4]
        (size,) = struct.unpack_from("<I", body, offset + 4)
        start = offset + 8
        if chunk_id == b"fmt ":
            if size < 16 or start + 16 > len(body):
                raise AudioInvalid("format")
            audio_format, channels, rate, byte_rate, block_align, bits = struct.unpack_from("<HHIIHH", body, start)
            if (audio_format, channels, rate, bits, block_align, byte_rate) != (
                    PCM, 1, SAMPLE_RATE, 16, BYTES_PER_SAMPLE, SAMPLE_RATE * BYTES_PER_SAMPLE):
                raise AudioInvalid("format")
            fmt_ok = True
        elif chunk_id == b"data":
            if not fmt_ok:
                raise AudioInvalid("format")
            # потоковые записи пишут размер 0 / 0xFFFFFFFF — берём фактически присланные байты
            available = len(body) - start
            data_size = available if size in (0, 0xFFFFFFFF) else min(size, available)
            data_size -= data_size % BYTES_PER_SAMPLE
            duration_ms = data_size // BYTES_PER_MS
            if duration_ms < MIN_DURATION_MS:
                raise AudioInvalid("too_short")
            if duration_ms > MAX_DURATION_MS:
                raise AudioInvalid("too_long")
            return WavInfo(duration_ms=duration_ms, data_offset=start, data_size=data_size)
        offset = start + size + (size & 1)
    raise AudioInvalid("format")


def mean_amplitude(body: bytes, info: WavInfo) -> float:
    """Средняя |амплитуда| отсчётов PCM 16 бит (fake-оценка: тишина < 200 → insufficient_evidence)."""
    samples = array.array("h")
    samples.frombytes(body[info.data_offset:info.data_offset + info.data_size])
    if sys.byteorder != "little":  # pragma: no cover — WAV всегда little-endian
        samples.byteswap()
    if not samples:
        return 0.0
    return sum(abs(v) for v in samples) / len(samples)


def make_wav(duration_ms: int, amplitude: int = 3000, *, rate: int = SAMPLE_RATE, channels: int = 1,
             bits: int = 16, data_size_field: int | None = None) -> bytes:
    """Синтетический WAV (тесты и стенд): прямоугольный сигнал заданной амплитуды."""
    n = rate * duration_ms // 1000
    frame = struct.pack("<h", amplitude) * 8 + struct.pack("<h", -amplitude) * 8
    data = (frame * (n // 16 + 1))[: n * BYTES_PER_SAMPLE]
    block_align = channels * bits // 8
    fmt = struct.pack("<HHIIHH", PCM, channels, rate, rate * block_align, block_align, bits)
    size = len(data) if data_size_field is None else data_size_field
    return (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE" + b"fmt " + struct.pack("<I", 16) + fmt
            + b"data" + struct.pack("<I", size) + data)
