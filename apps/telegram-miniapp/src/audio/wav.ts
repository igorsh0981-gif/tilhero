/**
 * WAV for «Произнести» (bff.ts PronunciationView; INTERNAL_API §1.9): PCM 16 bit, mono, 16 000 Hz, 0.5..15 s,
 * ≤ 600 000 bytes. The recording of Web Audio (any device rate, often 44.1 or 48 kHz) is mixed to mono, resampled to
 * 16 kHz and written with the classic 44-byte header. Pure functions: the bytes live only in memory until they are sent.
 */

export const WAV_RATE = 16_000;
export const MIN_RECORD_MS = 500;
export const MAX_RECORD_MS = 15_000;
export const MAX_WAV_BYTES = 600_000;
export const WAV_HEADER_BYTES = 44;
/** 0,5 s of 16 kHz: the BFF compares the data size (≥ 16 000 bytes), so the client counts samples, not rounded ms */
export const MIN_WAV_SAMPLES = (WAV_RATE * MIN_RECORD_MS) / 1000;

/** Channels → one (the mean of the samples). */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!;
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of channels) s += c[i]!;
    out[i] = s / channels.length;
  }
  return out;
}

/** Recorded buffers one after another. */
export function concatChunks(chunks: readonly Float32Array[]): Float32Array {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Float32Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Resample to `to` Hz. Down-sampling averages the input samples that fall into each output sample (a box filter — enough
 * against aliasing for speech); up-sampling interpolates linearly. The output length is round(n · to / from).
 */
export function resample(input: Float32Array, from: number, to: number = WAV_RATE): Float32Array {
  if (!(from > 0) || !(to > 0)) throw new RangeError("sample rate");
  if (from === to) return input;
  const n = Math.round((input.length * to) / from);
  const out = new Float32Array(n);
  const ratio = from / to;
  if (ratio > 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let s = 0;
      for (let k = a; k < b; k++) s += input[k]!;
      out[i] = s / (b - a);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const x = i * ratio;
      const a = Math.floor(x);
      const b = Math.min(input.length - 1, a + 1);
      const f = x - a;
      out[i] = (input[a] ?? 0) * (1 - f) + (input[b] ?? 0) * f;
    }
  }
  return out;
}

/** Float samples −1..1 → a WAV file (PCM 16 bit little-endian, mono, `rate` Hz). */
export function encodeWav(samples: Float32Array, rate: number = WAV_RATE): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // size of the fmt chunk
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // byte rate = rate · channels · 2
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  let at = WAV_HEADER_BYTES;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(at, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
    at += 2;
  }
  return buf;
}

export interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
}

/** The header of a WAV file (the canonical 44-byte layout); null — not a RIFF/WAVE PCM file. */
export function wavInfo(buf: ArrayBuffer): WavInfo | null {
  if (buf.byteLength < WAV_HEADER_BYTES) return null;
  const v = new DataView(buf);
  const ascii = (at: number, n: number) => String.fromCharCode(...Array.from({ length: n }, (_, i) => v.getUint8(at + i)));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE" || ascii(12, 4) !== "fmt " || ascii(36, 4) !== "data") return null;
  const channels = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const bitsPerSample = v.getUint16(34, true);
  const dataBytes = v.getUint32(40, true);
  const frame = channels * (bitsPerSample / 8);
  return { format: v.getUint16(20, true), channels, sampleRate, bitsPerSample, dataBytes, durationMs: frame && sampleRate ? Math.round((dataBytes / frame / sampleRate) * 1000) : 0 };
}

/** Loudness of a buffer, 0..1 (RMS scaled so that normal speech fills the meter). */
export function level(frame: Float32Array): number {
  if (!frame.length) return 0;
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i]! * frame[i]!;
  return Math.min(1, Math.sqrt(s / frame.length) * 4);
}

/**
 * The recording → a WAV Blob of at most `maxMs`: mono samples of `rate` Hz resampled to 16 kHz. `durationMs` is the
 * length of the audio actually written.
 */
export function toWav(samples: Float32Array, rate: number, maxMs: number = MAX_RECORD_MS): { wav: Blob; durationMs: number; bytes: number; samples: number } {
  const limit = Math.floor((rate * maxMs) / 1000);
  const cut = samples.length > limit ? samples.subarray(0, limit) : samples;
  const pcm = resample(cut, rate, WAV_RATE);
  const buf = encodeWav(pcm, WAV_RATE);
  return { wav: new Blob([buf], { type: "audio/wav" }), durationMs: Math.round((pcm.length / WAV_RATE) * 1000), bytes: buf.byteLength, samples: pcm.length };
}

/** Shorter than 0,5 s by the number of 16 kHz samples written (as the BFF checks it): not sent, «Слишком коротко». */
export const isTooShort = (r: { samples: number }): boolean => r.samples < MIN_WAV_SAMPLES;
