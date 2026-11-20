/**
 * WAV для тестов произношения: заголовок RIFF/WAVE + чанк fmt (PCM) + data. Отсчёты — повторяющийся маркер
 * AUDIO_MARK (тест «байты аудио не попадают в логи» ищет его в логах).
 */
export const AUDIO_MARK = Buffer.from("AUDIO-SAMPLES-MARK");

export interface WavOptions {
  ms?: number;
  sampleRate?: number;
  channels?: number;
  bits?: number;
  format?: number;
  /** чанк LIST перед data (как у некоторых записывающих) */
  listChunk?: boolean;
  /** объявленный размер data больше фактического (обрезанный файл) */
  truncated?: boolean;
}

export function makeWav(o: WavOptions = {}): Buffer {
  const sampleRate = o.sampleRate ?? 16_000;
  const channels = o.channels ?? 1;
  const bits = o.bits ?? 16;
  const blockAlign = (channels * bits) / 8;
  const dataBytes = Math.round(((o.ms ?? 1500) / 1000) * sampleRate) * blockAlign;
  const data = Buffer.alloc(dataBytes);
  for (let i = 0; i + AUDIO_MARK.length <= dataBytes; i += AUDIO_MARK.length) AUDIO_MARK.copy(data, i);
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(o.format ?? 1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * blockAlign, 16);
  fmt.writeUInt16LE(blockAlign, 20);
  fmt.writeUInt16LE(bits, 22);
  const list = o.listChunk ? Buffer.concat([Buffer.from("LIST", "ascii"), Buffer.from([3, 0, 0, 0]), Buffer.from("abc\0", "ascii")]) : Buffer.alloc(0);
  const dataHead = Buffer.alloc(8);
  dataHead.write("data", 0, "ascii");
  dataHead.writeUInt32LE(o.truncated ? dataBytes + 1000 : dataBytes, 4);
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, list, dataHead, data]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
