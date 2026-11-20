/**
 * The microphone of «Произнести» with a mocked Web Audio and getUserMedia (jsdom has neither): the microphone is always
 * released (tracks stopped, the context closed) — after a normal stop, a refusal, and a failure while the graph is being
 * built; errors come out as RecorderError; the 0,5 s minimum is counted in 16 kHz samples; auto-stop at the limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecorderError, startRecording } from "../src/audio/recorder";
import { isTooShort, MIN_WAV_SAMPLES, toWav } from "../src/audio/wav";

type Fail = "source" | "processor" | "connect" | null;

class FakeNode {
  constructor(private readonly fail: boolean) {}
  connect(): void {
    if (this.fail) throw new DOMException("connect failed", "InvalidStateError");
  }
  disconnect(): void {}
}
class FakeProcessor extends FakeNode {
  onaudioprocess: ((e: { inputBuffer: { getChannelData: (i: number) => Float32Array } }) => void) | null = null;
}

let failAt: Fail = null;
let contexts: FakeCtx[] = [];
class FakeCtx {
  sampleRate = 48_000;
  closed = 0;
  destination = {};
  processor: FakeProcessor | null = null;
  constructor() {
    contexts.push(this);
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed += 1;
    return Promise.resolve();
  }
  createMediaStreamSource() {
    if (failAt === "source") throw new DOMException("no source", "NotSupportedError");
    return new FakeNode(failAt === "connect");
  }
  createScriptProcessor() {
    if (failAt === "processor") throw new DOMException("no processor", "NotSupportedError");
    this.processor = new FakeProcessor(false);
    return this.processor;
  }
  createGain() {
    return Object.assign(new FakeNode(false), { gain: { value: 1 } });
  }
}

const tracks = () => [{ stop: vi.fn() }, { stop: vi.fn() }];
let stream: { getTracks: () => Array<{ stop: () => void }> };
let streamTracks: Array<{ stop: ReturnType<typeof vi.fn> }>;
let gum: ReturnType<typeof vi.fn>;

const win = window as unknown as { AudioContext?: unknown };
const savedCtx = win.AudioContext;
const savedDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

beforeEach(() => {
  failAt = null;
  contexts = [];
  streamTracks = tracks();
  stream = { getTracks: () => streamTracks };
  gum = vi.fn(async () => stream);
  win.AudioContext = FakeCtx;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: gum } });
});
afterEach(() => {
  win.AudioContext = savedCtx;
  if (savedDevices) Object.defineProperty(navigator, "mediaDevices", savedDevices);
  else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
});

/** Feed `seconds` of a 48 kHz tone through the processor in 4096-sample buffers. */
function feed(ctx: FakeCtx, seconds: number): void {
  const total = Math.round(48_000 * seconds);
  for (let at = 0; at < total; at += 4096) {
    const n = Math.min(4096, total - at);
    const data = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(((at + i) * 2 * Math.PI * 220) / 48_000));
    ctx.processor!.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } });
  }
}
const released = (ctx: FakeCtx) => ctx.closed > 0 && streamTracks.every((t) => t.stop.mock.calls.length > 0);

describe("recorder: the microphone is always released", () => {
  for (const at of ["source", "processor", "connect"] as const) {
    it(`a failure while building the graph (${at}) → RecorderError, tracks stopped, the context closed`, async () => {
      failAt = at;
      const err = await startRecording().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RecorderError);
      expect((err as RecorderError).reason).toBe("failed");
      expect(gum).toHaveBeenCalledTimes(1);
      expect(released(contexts[0]!)).toBe(true);
    });
  }

  it("a refusal → RecorderError denied, the context closed, asked once", async () => {
    gum.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    const err = await startRecording().catch((e: unknown) => e);
    expect((err as RecorderError).reason).toBe("denied");
    expect(contexts[0]!.closed).toBe(1);
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it("no getUserMedia → unsupported, nothing asked", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    const err = await startRecording().catch((e: unknown) => e);
    expect((err as RecorderError).reason).toBe("unsupported");
    expect(contexts).toHaveLength(0);
  });

  it("stop → a 16 kHz WAV of the recorded length; the microphone released; a second stop gets the same result", async () => {
    const rec = await startRecording();
    const ctx = contexts[0]!;
    feed(ctx, 0.6);
    const r = await rec.stop();
    expect(released(ctx)).toBe(true);
    expect(r.wav.type).toBe("audio/wav");
    expect(r.samples).toBeGreaterThanOrEqual(9_000);
    expect(isTooShort(r)).toBe(false);
    expect(await rec.stop()).toBe(r);
  });

  it("cancel throws the samples away and releases the microphone", async () => {
    const rec = await startRecording();
    feed(contexts[0]!, 0.2);
    rec.cancel();
    expect(released(contexts[0]!)).toBe(true);
  });

  it("auto-stop at the limit: once, exactly maxMs of audio", async () => {
    const onAutoStop = vi.fn();
    await startRecording({ maxMs: 1_000, onAutoStop });
    feed(contexts[0]!, 1.5);
    await Promise.resolve();
    await Promise.resolve();
    expect(onAutoStop).toHaveBeenCalledTimes(1);
    expect(onAutoStop.mock.calls[0]![0].samples).toBe(16_000);
    expect(released(contexts[0]!)).toBe(true);
  });
});

describe("the 0,5 s minimum counts 16 kHz samples (as the BFF: data ≥ 16 000 bytes)", () => {
  it("8000 samples is enough, 7999 is not", () => {
    expect(MIN_WAV_SAMPLES).toBe(8_000);
    expect(isTooShort({ samples: 7_999 })).toBe(true);
    expect(isTooShort({ samples: 8_000 })).toBe(false);
  });
  it("a recording that rounds to 500 ms but has fewer samples is too short", () => {
    // 23 990 samples of 48 kHz → 7 997 samples of 16 kHz = 499.8 ms, rounded to 500
    const r = toWav(new Float32Array(23_990), 48_000);
    expect(r.durationMs).toBe(500);
    expect(r.samples).toBe(7_997);
    expect(isTooShort(r)).toBe(true);
    expect(isTooShort(toWav(new Float32Array(24_000), 48_000))).toBe(false);
  });
});
