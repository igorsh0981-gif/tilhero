/**
 * Release 4.1 — the server speech player (src/tg/tts.ts): the object URL cache (key variant|speed|text, one request per
 * phrase, eviction with revokeObjectURL), the iOS order of calls (cached → play in the tap; not cached → silent unlock in
 * the tap, the phrase after the fetch), the fallback to the device voice (503 / network / the file does not start), the
 * «недоступно» error, other errors as they are, stop, and the moment a listening is counted (onStart only when the
 * sound actually started). Media files on the same element: preloadFile (fetched when shown, retried after a failure,
 * revoked on dispose) and playUrl (ready → play in the tap; pending → silent unlock in the tap; no fallback).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors";
import { AudioPlaybackError, createSpeechPlayer, serverSpeechDown, SILENT_MP3, speechKey, SpeechUnavailableError, type AudioLike, type SpeechBody } from "../src/tg/tts";

class FakeAudio implements AudioLike {
  src = "";
  readonly plays: string[] = [];
  paused = 0;
  /** ok — play() resolves (the sound started); reject — NotAllowedError; hang — never starts */
  mode: "ok" | "reject" | "hang" = "ok";
  private readonly ls = new Map<string, Set<() => void>>();
  play(): Promise<void> {
    this.plays.push(this.src);
    if (this.mode === "reject") return Promise.reject(new DOMException("gesture", "NotAllowedError"));
    if (this.mode === "hang") return new Promise(() => undefined);
    return Promise.resolve();
  }
  pause(): void {
    this.paused += 1;
  }
  addEventListener(type: string, fn: () => void): void {
    if (!this.ls.has(type)) this.ls.set(type, new Set());
    this.ls.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.ls.get(type)?.delete(fn);
  }
  emit(type: string): void {
    for (const fn of [...(this.ls.get(type) ?? [])]) fn();
  }
  listeners(type: string): number {
    return this.ls.get(type)?.size ?? 0;
  }
}

const VOICE = { lang: "en-GB", name: "UK" } as SpeechSynthesisVoice;

function setup(o: { max?: number; voice?: boolean; startTimeoutMs?: number } = {}) {
  const audio = new FakeAudio();
  let n = 0;
  const revoked: string[] = [];
  const calls: SpeechBody[] = [];
  const answers: Array<(req: SpeechBody) => Promise<Blob>> = [];
  const spoken: Array<{ text: string; rate: number; variant: string }> = [];
  const device = {
    voice: vi.fn(async () => (o.voice === false ? null : VOICE)),
    speak: vi.fn(async (text: string, d: { voice: SpeechSynthesisVoice; variant: "en-GB" | "en-US"; rate: number; onStart: () => void }) => {
      spoken.push({ text, rate: d.rate, variant: d.variant });
      d.onStart();
      return true;
    }),
    stop: vi.fn(),
  };
  const player = createSpeechPlayer({
    createAudio: () => audio,
    createObjectURL: () => `blob:tts/${++n}`,
    revokeObjectURL: (u) => void revoked.push(u),
    device,
    maxEntries: o.max,
    startTimeoutMs: o.startTimeoutMs,
  });
  player.setSource((req) => {
    calls.push(req);
    const next = answers.shift();
    return next ? next(req) : Promise.resolve(new Blob([new Uint8Array([0xff, 0xfb])], { type: "audio/mpeg" }));
  });
  /** the next source answer is held until `release()` (or fails with `fail`) */
  const hold = () => {
    let release!: () => void;
    let fail!: (e: unknown) => void;
    answers.push(
      () =>
        new Promise<Blob>((res, rej) => {
          release = () => res(new Blob([new Uint8Array([1])], { type: "audio/mpeg" }));
          fail = rej;
        }),
    );
    return { release: () => release(), fail: (e: unknown) => fail(e) };
  };
  const failNext = (e: unknown) => answers.push(() => Promise.reject(e));
  return { player, audio, calls, revoked, device, spoken, hold, failNext };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const down503 = () => new ApiError(503, "SPEECH_UNAVAILABLE", "x", { service: "tts" });

afterEach(() => {
  vi.useRealTimers();
});

describe("cache", () => {
  it("one request per phrase: the key is variant|speed|text with whitespace collapsed; parallel calls share it", async () => {
    const { player, calls } = setup();
    const [a, b] = await Promise.all([player.fetchSpeech("Hello  there.", "en-GB"), player.fetchSpeech(" Hello there. ", "en-GB")]);
    expect(a).toBe(b);
    expect(await player.fetchSpeech("Hello\nthere.", "en-GB", "normal")).toBe(a);
    expect(calls).toEqual([{ text: "Hello there.", variant: "en-GB", speed: "normal" }]);
    await player.fetchSpeech("Hello there.", "en-GB", "slow");
    await player.fetchSpeech("Hello there.", "en-US");
    expect(calls.map(speechKey)).toEqual(["en-GB|normal|Hello there.", "en-GB|slow|Hello there.", "en-US|normal|Hello there."]);
    expect(player.size).toBe(3);
  });

  it("at most N entries: the least recently used is evicted with revokeObjectURL; a failed fetch is not cached", async () => {
    const { player, calls, revoked, failNext } = setup({ max: 3 });
    const u1 = await player.fetchSpeech("one", "en-GB");
    const u2 = await player.fetchSpeech("two", "en-GB");
    await player.fetchSpeech("three", "en-GB");
    await player.fetchSpeech("one", "en-GB"); // touched → «two» is now the oldest
    await player.fetchSpeech("four", "en-GB");
    expect(revoked).toEqual([u2]);
    expect(player.size).toBe(3);
    expect(await player.fetchSpeech("one", "en-GB")).toBe(u1);
    failNext(down503());
    await expect(player.fetchSpeech("five", "en-GB")).rejects.toMatchObject({ code: "SPEECH_UNAVAILABLE" });
    await player.fetchSpeech("five", "en-GB");
    expect(calls.map((c) => c.text)).toEqual(["one", "two", "three", "four", "five", "five"]);
  });

  it("prefetch is quiet and never throws; a new source starts with an empty cache", async () => {
    const { player, revoked } = setup();
    const quiet: boolean[] = [];
    player.setSource((_req, o) => {
      quiet.push(o.quiet);
      return Promise.resolve(new Blob([new Uint8Array([1])]));
    });
    await player.prefetchSpeech("Hi there", "en-GB");
    expect(quiet).toEqual([true]);
    player.setSource(() => Promise.reject(down503()));
    expect(revoked).toHaveLength(1);
    await expect(player.prefetchSpeech("Hi there", "en-GB")).resolves.toBeUndefined();
  });

  it("no source bound → the server counts as unavailable (fallback), not a crash", async () => {
    const player = createSpeechPlayer({ createAudio: () => null, createObjectURL: () => "x", revokeObjectURL: () => undefined, device: { voice: async () => null, speak: async () => false, stop: () => undefined } });
    await expect(player.fetchSpeech("Hello", "en-GB")).rejects.toBeInstanceOf(SpeechUnavailableError);
    await expect(player.playSpeech("Hello", "en-GB")).rejects.toBeInstanceOf(SpeechUnavailableError);
  });
});

describe("playback (iOS order of calls)", () => {
  it("cached: src and play() right in the call (the tap handler); onStart once; resolves on ended", async () => {
    const { player, audio } = setup();
    const url = await player.fetchSpeech("Could I have tea?", "en-GB");
    const onStart = vi.fn();
    const p = player.playSpeech("Could I have tea?", "en-GB", { onStart });
    expect(audio.plays).toEqual([url]); // synchronous — no silent unlock needed
    expect(audio.src).toBe(url);
    await flush();
    audio.emit("playing");
    expect(onStart).toHaveBeenCalledTimes(1);
    let done = false;
    void p.then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    audio.emit("ended");
    await p;
    expect(audio.listeners("ended")).toBe(0);
  });

  it("not cached: the silent MP3 unlocks the element in the tap; the phrase plays after the fetch; the silent clip is not a start", async () => {
    const { player, audio, hold } = setup();
    const h = hold();
    const onStart = vi.fn();
    const p = player.playSpeech("Where is the station?", "en-US", { onStart, speed: "slow" });
    expect(audio.plays).toEqual([SILENT_MP3]);
    await flush();
    expect(onStart).not.toHaveBeenCalled();
    h.release();
    await flush();
    expect(audio.plays).toHaveLength(2);
    expect(audio.plays[1]).toMatch(/^blob:tts\//);
    expect(onStart).toHaveBeenCalledTimes(1);
    audio.emit("ended");
    await p;
  });

  it("the silent MP3 is a valid MPEG frame header (FF FB) in a data URI", () => {
    expect(SILENT_MP3.startsWith("data:audio/mpeg;base64,")).toBe(true);
    const bytes = Uint8Array.from(atob(SILENT_MP3.split(",")[1]!), (c) => c.charCodeAt(0));
    expect(bytes.length).toBe(8 * 96);
    expect([...bytes.slice(0, 4)]).toEqual([0xff, 0xfb, 0x14, 0xc0]);
    expect([...bytes.slice(96, 100)]).toEqual([0xff, 0xfb, 0x14, 0xc0]);
  });

  it("stopSpeech resolves the pending play; a late fetch never plays and is not counted", async () => {
    const { player, audio, hold } = setup();
    const h = hold();
    const onStart = vi.fn();
    const p = player.playSpeech("Late phrase", "en-GB", { onStart });
    player.stopSpeech();
    await p;
    h.release();
    await flush();
    expect(audio.plays).toEqual([SILENT_MP3]);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("a new play stops the previous one; AbortSignal stops too", async () => {
    const { player, audio } = setup();
    await player.fetchSpeech("first", "en-GB");
    await player.fetchSpeech("second", "en-GB");
    const first = player.playSpeech("first", "en-GB");
    const second = player.playSpeech("second", "en-GB");
    await first; // resolved by the second call
    const ac = new AbortController();
    const third = player.playSpeech("first", "en-GB", { signal: ac.signal });
    ac.abort();
    await Promise.all([second, third]);
    expect(audio.paused).toBeGreaterThanOrEqual(3);
  });
});

describe("fallback to the device voice", () => {
  it("503 SPEECH_UNAVAILABLE → the device voice (slow — rate 0.85); the sound started → counted", async () => {
    const { player, failNext, spoken, device } = setup();
    failNext(down503());
    const onStart = vi.fn();
    await player.playSpeech("A cup of tea, please.", "en-US", { speed: "slow", onStart });
    expect(device.voice).toHaveBeenCalledWith("en-US");
    expect(spoken).toEqual([{ text: "A cup of tea, please.", rate: 0.85, variant: "en-US" }]);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("no network (status 0), 502, 504 → the device voice", async () => {
    for (const e of [new ApiError(0, "NETWORK", "x"), new ApiError(502, "SERVICE_UNAVAILABLE", "x"), new ApiError(504, "SERVICE_UNAVAILABLE", "x")]) {
      const { player, failNext, spoken } = setup();
      failNext(e);
      await player.playSpeech("Hello", "en-GB");
      expect(spoken, e.code).toHaveLength(1);
    }
    expect(serverSpeechDown(new TypeError("body"))).toBe(true);
    expect(serverSpeechDown(new ApiError(429, "RATE_LIMITED", "x"))).toBe(false);
  });

  it("neither the server nor an English device voice → SpeechUnavailableError, nothing counted", async () => {
    const { player, failNext } = setup({ voice: false });
    failNext(new ApiError(0, "NETWORK", "x"));
    const onStart = vi.fn();
    await expect(player.playSpeech("Hello", "en-GB", { onStart })).rejects.toBeInstanceOf(SpeechUnavailableError);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("the device engine stayed silent (speak → false) → SpeechUnavailableError", async () => {
    const { player, failNext, device } = setup();
    device.speak.mockImplementationOnce(async () => false);
    failNext(down503());
    const onStart = vi.fn();
    await expect(player.playSpeech("Hello", "en-GB", { onStart })).rejects.toBeInstanceOf(SpeechUnavailableError);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("other errors (429, 422) reach the caller as they are — no fallback, nothing counted", async () => {
    const { player, failNext, spoken } = setup();
    failNext(new ApiError(429, "RATE_LIMITED", "x", { retry_after: 4, policy: "tg.speech" }));
    await expect(player.playSpeech("Hello", "en-GB")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    failNext(new ApiError(422, "TEXT_INVALID", "x"));
    await expect(player.playSpeech("Hello", "en-GB")).rejects.toMatchObject({ code: "TEXT_INVALID" });
    expect(spoken).toHaveLength(0);
  });

  it("the file refuses to play (NotAllowedError) → the device voice", async () => {
    const { player, audio, spoken } = setup();
    await player.fetchSpeech("Hello", "en-GB");
    audio.mode = "reject";
    const onStart = vi.fn();
    await player.playSpeech("Hello", "en-GB", { onStart });
    expect(spoken).toHaveLength(1);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("the file never starts → after the start timeout the device voice", async () => {
    vi.useFakeTimers();
    const { player, audio, spoken } = setup({ startTimeoutMs: 3000 });
    await player.fetchSpeech("Hello", "en-GB");
    audio.mode = "hang";
    const p = player.playSpeech("Hello", "en-GB");
    await vi.advanceTimersByTimeAsync(2900);
    expect(spoken).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(spoken).toHaveLength(1);
  });

  it("an error after the sound started ends the play without a fallback", async () => {
    const { player, audio, spoken } = setup();
    await player.fetchSpeech("Hello", "en-GB");
    const onStart = vi.fn();
    const p = player.playSpeech("Hello", "en-GB", { onStart });
    await flush();
    audio.emit("error");
    await p;
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(spoken).toHaveLength(0);
  });
});

describe("media files on the shared element (playUrl, preloadFile)", () => {
  const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" });

  it("preloadFile fetches at once; a ready file plays right in the call (the tap), from the start; stop as with speech", async () => {
    const { player, audio, device } = setup();
    const load = vi.fn(async () => blob());
    const f = player.preloadFile(load);
    expect(load).toHaveBeenCalledTimes(1);
    const url = await f.src();
    expect(typeof f.src()).toBe("string");
    const onStart = vi.fn();
    const p = player.playUrl(f.src(), { onStart });
    expect(audio.plays).toEqual([url]); // synchronous, no silent unlock
    await flush();
    expect(onStart).toHaveBeenCalledTimes(1);
    audio.emit("ended");
    await p;
    const again = player.playUrl(f.src());
    expect(audio.plays).toEqual([url, url]);
    player.stopSpeech();
    await again;
    expect(device.speak).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("still loading: the silent MP3 unlocks the element in the call, the file plays when it arrives", async () => {
    const { player, audio } = setup();
    let release!: (b: Blob) => void;
    const f = player.preloadFile(() => new Promise<Blob>((r) => (release = r)));
    const onStart = vi.fn();
    const p = player.playUrl(f.src(), { onStart });
    expect(audio.plays).toEqual([SILENT_MP3]);
    await flush();
    expect(onStart).not.toHaveBeenCalled();
    release(blob());
    await flush();
    await flush();
    expect(audio.plays).toHaveLength(2);
    expect(audio.plays[1]).toMatch(/^blob:tts\//);
    expect(onStart).toHaveBeenCalledTimes(1);
    audio.emit("ended");
    await p;
  });

  it("a failed preload: the error reaches playUrl (no fallback); the next src() loads again", async () => {
    const { player, device } = setup();
    const load = vi.fn<() => Promise<Blob>>().mockRejectedValueOnce(new ApiError(404, "AUDIO_NOT_FOUND", "x")).mockResolvedValue(blob());
    const f = player.preloadFile(load);
    await expect(player.playUrl(f.src())).rejects.toMatchObject({ code: "AUDIO_NOT_FOUND" });
    expect(device.speak).not.toHaveBeenCalled();
    const second = f.src();
    expect(load).toHaveBeenCalledTimes(2);
    await expect(second).resolves.toMatch(/^blob:tts\//);
  });

  it("the file does not start → AudioPlaybackError, nothing counted, no device voice", async () => {
    const { player, audio, device } = setup();
    audio.mode = "reject";
    const onStart = vi.fn();
    await expect(player.playUrl("blob:tts/file", { onStart })).rejects.toBeInstanceOf(AudioPlaybackError);
    expect(onStart).not.toHaveBeenCalled();
    expect(device.speak).not.toHaveBeenCalled();
  });

  it("the same key while loading (a screen mounted twice) shares one request; each handle has its own URL", async () => {
    const { player } = setup();
    let release!: (b: Blob) => void;
    const load = vi.fn(() => new Promise<Blob>((r) => (release = r)));
    const first = player.preloadFile(load, "m-own-coffee");
    first.dispose();
    const second = player.preloadFile(load, "m-own-coffee");
    expect(load).toHaveBeenCalledTimes(1);
    release(blob());
    await expect(second.src()).resolves.toMatch(/^blob:tts\//);
    player.preloadFile(load, "m-own-coffee"); // finished loads are not shared — a new screen fetches again
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("dispose revokes the URL; a load that finishes after dispose is revoked at once", async () => {
    const { player, revoked } = setup();
    const f = player.preloadFile(async () => blob());
    const url = await f.src();
    f.dispose();
    expect(revoked).toEqual([url]);
    let release!: (b: Blob) => void;
    const g = player.preloadFile(() => new Promise<Blob>((r) => (release = r)));
    const pending = g.src();
    g.dispose();
    release(blob());
    await expect(pending).rejects.toBeInstanceOf(AudioPlaybackError);
    expect(revoked).toHaveLength(2);
  });
});
