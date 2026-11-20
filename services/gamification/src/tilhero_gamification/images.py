"""Проверка картинок без сторонних библиотек (бриф спринта 6): формат — по сигнатуре байтов, размеры — из заголовка.

- PNG: сигнатура `89 50 4E 47 0D 0A 1A 0A`, первый чанк `IHDR` (ширина и высота — big-endian uint32);
- WebP: `RIFF <size LE> WEBP` и первый чанк:
  - `VP8 ` (с потерями): тег кадра 3 байта, стартовый код `9D 01 2A`, ширина и высота — 14 бит LE;
  - `VP8L` (без потерь): сигнатура `0x2F`, затем 14 бит ширина − 1 и 14 бит высота − 1;
  - `VP8X` (расширенный): флаги 4 байта, ширина − 1 и высота − 1 — по 24 бита LE.

Content-Type запроса не доверяется: заявленный тип должен совпасть с сигнатурой.
"""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MIME_WEBP = "image/webp"
MIME_PNG = "image/png"
MIMES = (MIME_WEBP, MIME_PNG)


class ImageInvalid(ValueError):
    """Картинка не прошла проверку: reason — код для ответа (ASSET_INVALID {reason})."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class ImageInfo:
    mime: str
    width: int
    height: int
    size: int
    sha256: str


def _png(data: bytes) -> tuple[int, int]:
    if len(data) < 33 or data[12:16] != b"IHDR" or struct.unpack(">I", data[8:12])[0] != 13:
        raise ImageInvalid("header")
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def _webp(data: bytes) -> tuple[int, int]:
    if len(data) < 30 or data[8:12] != b"WEBP":
        raise ImageInvalid("signature")
    riff_size = struct.unpack("<I", data[4:8])[0]
    # RIFF-размер — всё после первых 8 байт (чётное выравнивание чанка допускает 1 лишний байт)
    if riff_size + 8 not in (len(data), len(data) - 1) or riff_size % 2:
        raise ImageInvalid("header")
    chunk = data[12:16]
    if chunk == b"VP8 ":
        if data[23:26] != b"\x9d\x01\x2a":
            raise ImageInvalid("header")
        w, h = struct.unpack("<HH", data[26:30])
        return w & 0x3FFF, h & 0x3FFF
    if chunk == b"VP8L":
        if data[20] != 0x2F:
            raise ImageInvalid("header")
        bits = struct.unpack("<I", data[21:25])[0]
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8X":
        w = int.from_bytes(data[24:27], "little") + 1
        h = int.from_bytes(data[27:30], "little") + 1
        return w, h
    raise ImageInvalid("header")


def sniff(data: bytes) -> str | None:
    if data.startswith(PNG_SIGNATURE):
        return MIME_PNG
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return MIME_WEBP
    return None


def inspect_image(data: bytes, declared: str | None = None, *, max_px: int = 1024) -> ImageInfo:
    """Формат по сигнатуре, размеры по заголовку. declared — Content-Type запроса (должен совпасть с сигнатурой)."""
    if not data:
        raise ImageInvalid("empty")
    mime = sniff(data)
    if mime is None:
        raise ImageInvalid("signature")
    if declared is not None and declared != mime:
        raise ImageInvalid("signature")
    width, height = _png(data) if mime == MIME_PNG else _webp(data)
    if width < 1 or height < 1:
        raise ImageInvalid("header")
    if width > max_px or height > max_px:
        raise ImageInvalid("dimensions")
    return ImageInfo(mime=mime, width=width, height=height, size=len(data), sha256=hashlib.sha256(data).hexdigest())
