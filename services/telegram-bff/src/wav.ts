/**
 * Проверка заголовка WAV для оценки произношения (bff.ts PronunciationView, INTERNAL_API §1.9, §8) — ДО отправки в
 * memory: RIFF/WAVE, чанк `fmt ` — PCM (1), 16 бит, моно, 16 000 Гц; чанк `data` целиком в теле; длительность 0,5..15 с;
 * тело ≤ 600 000 байт. Ошибка → 422 AUDIO_INVALID {reason: format | too_short | too_long | too_large}.
 *
 * Читаются только заголовки чанков; сами отсчёты не разбираются, не копируются и никуда не пишутся. Причина отказа —
 * без содержимого файла.
 */
import { AppError } from "@tilhero/ts-common";

export const WAV_MAX_BYTES = 600_000;
export const WAV_SAMPLE_RATE = 16_000;
export const WAV_MIN_MS = 500;
export const WAV_MAX_MS = 15_000;
const BYTES_PER_SECOND = WAV_SAMPLE_RATE * 2; // моно, 16 бит

export type AudioInvalidReason = "format" | "too_short" | "too_long" | "too_large";

export const audioInvalid = (reason: AudioInvalidReason) =>
  new AppError(
    422,
    "AUDIO_INVALID",
    reason === "format"
      ? "Запись не в формате WAV PCM 16 бит, моно, 16 кГц"
      : reason === "too_short"
        ? "Запись слишком короткая — от 0,5 секунды"
        : reason === "too_long"
          ? "Запись слишком длинная — до 15 секунд"
          : "Запись слишком большая",
    { reason },
  );

export interface WavInfo {
  /** длительность по размеру чанка data, мс */
  durationMs: number;
  dataBytes: number;
}

/** Разбор заголовка; любая неувязка формата → AUDIO_INVALID format, длительность вне 0,5..15 с → too_short / too_long. */
export function checkWav(buf: Uint8Array): WavInfo {
  if (buf.byteLength > WAV_MAX_BYTES) throw audioInvalid("too_large");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (at: number) => String.fromCharCode(buf[at]!, buf[at + 1]!, buf[at + 2]!, buf[at + 3]!);
  if (buf.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw audioInvalid("format");

  let fmtOk = false;
  let dataBytes: number | null = null;
  let pos = 12;
  // чанков немного (fmt, LIST, data); каждый ≥ 8 байт — цикл конечен
  while (pos + 8 <= buf.byteLength) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > buf.byteLength) throw audioInvalid("format");
      const audioFormat = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const byteRate = view.getUint32(body + 8, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      if (audioFormat !== 1 || channels !== 1 || sampleRate !== WAV_SAMPLE_RATE || bits !== 16 || blockAlign !== 2 || byteRate !== BYTES_PER_SECOND) {
        throw audioInvalid("format");
      }
      fmtOk = true;
    } else if (id === "data") {
      // data — после fmt и целиком в теле (без «бесконечного» размера потоковых записей)
      if (!fmtOk || size > buf.byteLength - body || size % 2 !== 0) throw audioInvalid("format");
      dataBytes = size;
      break;
    }
    // чанки выровнены по 2 байта
    pos = body + size + (size % 2);
  }
  if (!fmtOk || dataBytes === null) throw audioInvalid("format");
  // границы — по байтам (без округления): 0,5 с = 16 000 байт, 15 с = 480 000 байт
  if (dataBytes < (BYTES_PER_SECOND * WAV_MIN_MS) / 1000) throw audioInvalid("too_short");
  if (dataBytes > (BYTES_PER_SECOND * WAV_MAX_MS) / 1000) throw audioInvalid("too_long");
  return { durationMs: Math.round((dataBytes / BYTES_PER_SECOND) * 1000), dataBytes };
}
