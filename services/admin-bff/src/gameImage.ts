/**
 * Картинки игры (спринт 6): формат — по сигнатуре байтов, размеры — по заголовку (PNG IHDR; WebP VP8 / VP8L / VP8X),
 * без декодирования и без сторонних библиотек. Первая линия у admin-bff до вызова gamification (домен проверяет
 * повторно и решает окончательно): заявленный тип не совпадает с байтами, мусор, пустое тело, больше 1024×1024 →
 * 422 ASSET_INVALID {reason}; больше 300 КБ → 413 ASSET_TOO_LARGE (читается потоком, лишнее не буферизуется).
 */
import { AppError } from "@tilhero/ts-common";
import { ASSET_MAX_BYTES, ASSET_MAX_SIDE, ASSET_TYPES } from "./schemas.js";

export type AssetType = (typeof ASSET_TYPES)[number];

export interface ImageHeader {
  type: AssetType;
  width: number;
  height: number;
}

/** Причина 422 ASSET_INVALID: тип не из списка, пустое тело, байты не картинка, тип ≠ байтам, размеры. */
export type AssetInvalidReason = "content_type" | "empty" | "signature" | "type_mismatch" | "dimensions";

export const assetInvalid = (reason: AssetInvalidReason): AppError =>
  new AppError(422, "ASSET_INVALID", "Картинка не подходит: нужен WebP или PNG не больше 1024×1024", { reason });

export const assetTooLarge = (): AppError =>
  new AppError(413, "ASSET_TOO_LARGE", "Картинка больше 300 КБ", { max_bytes: ASSET_MAX_BYTES });

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ascii = (b: Buffer, at: number, s: string) => b.length >= at + s.length && b.toString("latin1", at, at + s.length) === s;

/** Формат и размеры по заголовку; null — не PNG и не WebP (или заголовок обрезан). */
export function readImageHeader(b: Buffer): ImageHeader | null {
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG_SIG) && ascii(b, 12, "IHDR")) {
    return { type: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (!(ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP"))) return null;
  // VP8 (с потерями): кадр-тег (3 байта), стартовый код 9d 01 2a, затем ширина и высота по 14 бит
  if (ascii(b, 12, "VP8 ") && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { type: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  // VP8L (без потерь): сигнатура 0x2f, затем 14 бит ширины − 1 и 14 бит высоты − 1
  if (ascii(b, 12, "VP8L") && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  // VP8X (расширенный): холст — 24 бита ширины − 1 и 24 бита высоты − 1
  if (ascii(b, 12, "VP8X") && b.length >= 30) {
    return { type: "image/webp", width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/** Тип из заголовка Content-Type (без параметров, в нижнем регистре). */
export function mediaTypeOf(header: string | string[] | undefined): string {
  return (typeof header === "string" ? header : "").split(";")[0]!.trim().toLowerCase();
}

export function isAssetType(t: string): t is AssetType {
  return (ASSET_TYPES as readonly string[]).includes(t);
}

/** Проверка загружаемой картинки: тело ≤ 300 КБ уже прочитано парсером. Иначе — 422 ASSET_INVALID {reason}. */
export function inspectAsset(bytes: Buffer, declared: string): ImageHeader {
  if (!isAssetType(declared)) throw assetInvalid("content_type");
  if (bytes.length === 0) throw assetInvalid("empty");
  if (bytes.length > ASSET_MAX_BYTES) throw assetTooLarge();
  const h = readImageHeader(bytes);
  if (!h) throw assetInvalid("signature");
  if (h.type !== declared) throw assetInvalid("type_mismatch");
  if (h.width < 1 || h.height < 1 || h.width > ASSET_MAX_SIDE || h.height > ASSET_MAX_SIDE) throw assetInvalid("dimensions");
  return h;
}
