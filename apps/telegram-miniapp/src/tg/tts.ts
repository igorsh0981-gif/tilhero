/**
 * Server speech (release 4.1, bff.ts SpeechRequest): English phrases of the content come as MP3 from the BFF
 * (POST /v1/speech → tts) and play through ONE shared HTMLAudioElement of the app. Unlike the device synthesis it works
 * inside Telegram on Android (no speechSynthesis there) and follows the phone volume on iOS (the synthesis goes to a
 * silent channel there).
 *
 * iOS allows play() only from a user gesture. playSpeech() must be called synchronously in the tap handler:
 *  - the MP3 is already cached → `el.src = url; el.play()` right in the handler;
 *  - not yet → in the handler the element is unlocked with a short silent MP3 (`el.src = SILENT; el.play()`), then,
 *    after the fetch, `el.src = url; el.play()` (an unlocked element keeps playing without a gesture).
 *
 * Fallback: the BFF answers 503 / 502 / 504, there is no network, or the file does not start — the device synthesis
 * (speech.ts) if it has an English voice; otherwise SpeechUnavailableError and the caller shows «недоступно». Other
 * errors (429, 422, 401…) reach the caller as they are (ApiError).
 *
 * Object URLs are cached in memory by `variant|speed|text`, at most 200 entries; the oldest are evicted with
 * revokeObjectURL. Phrases are content (the same for every learner) — the cache survives a learner switch.
 *
 * Media files of the BFF (GET /v1/media/{id}/audio) play on the same element the same way: preloadAudio() fetches the
 * file when the screen shows, playUrl() plays it in the tap (or unlocks the element in the tap if it is still loading).
 */
import type { SpeechRequest } from "@tilhero/contracts/bff";
import { loadVoices, pickEnglishVoice, speak, stopSpeaking, type EnVariant } from "./speech";

export type SpeechSpeed = "normal" | "slow";
export type SpeechBody = Required<SpeechRequest>;
/** The BFF call (bff.speech): MP3 as a Blob. `quiet` — background prefetch (never toggles «Нет связи»). */
export type SpeechSource = (req: SpeechBody, opts: { quiet: boolean }) => Promise<Blob>;

export interface PlayOptions {
  speed?: SpeechSpeed;
  signal?: AbortSignal;
  /** the sound actually started (the file or the device voice) — the moment a listening is counted */
  onStart?: () => void;
}

/** Neither the server speech nor an English device voice: the caller says «недоступно». */
export class SpeechUnavailableError extends Error {
  constructor(message = "speech unavailable") {
    super(message);
    this.name = "SpeechUnavailableError";
  }
}

/** A file did not start playing (decoding failed, play() refused, no start within the timeout). */
export class AudioPlaybackError extends Error {
  constructor(message = "audio playback failed") {
    super(message);
    this.name = "AudioPlaybackError";
  }
}

/** A media file loaded ahead (preloadAudio). */
export interface PreloadedFile {
  /** the object URL when loaded, else the pending load (a new one after a failure) */
  src(): string | Promise<string>;
  dispose(): void;
}

/** The part of HTMLAudioElement the player uses (tests pass a fake). */
export interface AudioLike {
  src: string;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface DeviceSpeech {
  /** an English device voice for the variant; null — no synthesis or no voice */
  voice(variant: EnVariant): Promise<SpeechSynthesisVoice | null>;
  /** true — the phrase sounded */
  speak(text: string, o: { voice: SpeechSynthesisVoice; variant: EnVariant; rate: number; onStart: () => void }): Promise<boolean>;
  stop(): void;
}

export interface SpeechDeps {
  createAudio(): AudioLike | null;
  createObjectURL(b: Blob): string;
  revokeObjectURL(u: string): void;
  device: DeviceSpeech;
  /** cache size (default 200) */
  maxEntries?: number;
  /** the file did not start within this time — fallback (default 10 s) */
  startTimeoutMs?: number;
}

export const SPEECH_CACHE_MAX = 200;
const START_TIMEOUT_MS = 10_000;

/** ~0.2 s of silence: 8 frames of MPEG-1 Layer III (32 kbit/s, 48 kHz, mono) with empty side info. */
export const SILENT_MP3 = `data:audio/mpeg;base64,${`//sUwA${"A".repeat(122)}`.repeat(8)}`;

/** The text the server speaks: whitespace collapsed (the BFF and tts normalise the same way — one cache key). */
export const speechText = (text: string): string => text.replace(/\s+/g, " ").trim();
export const speechKey = (b: SpeechBody): string => `${b.variant}|${b.speed}|${b.text}`;

/** The server speech is unavailable (fall back to the device): no network, 502–504 of the edge or SPEECH_UNAVAILABLE,
 *  no source, or a failure that is not an HTTP answer (reading the body, object URL). */
export function serverSpeechDown(e: unknown): boolean {
  if (e instanceof SpeechUnavailableError) return true;
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return true;
  return status === 0 || status === 502 || status === 503 || status === 504;
}

export function createSpeechPlayer(deps: SpeechDeps) {
  const max = deps.maxEntries ?? SPEECH_CACHE_MAX;
  const startTimeout = deps.startTimeoutMs ?? START_TIMEOUT_MS;
  let source: SpeechSource | null = null;
  /** bumped with every new source: an answer of the previous one is not cached */
  let generation = 0;
  const cache = new Map<string, string>();
  const inflight = new Map<string, Promise<string>>();
  let el: AudioLike | null | undefined;
  let token = 0;
  let current: { token: number; finish(): void } | null = null;

  const audio = (): AudioLike | null => {
    if (el === undefined) {
      try {
        el = deps.createAudio();
      } catch {
        el = null;
      }
    }
    return el;
  };

  /** Put (or refresh) an entry; evict the least recently used beyond `max`. */
  const remember = (key: string, url: string) => {
    cache.delete(key);
    cache.set(key, url);
    while (cache.size > max) {
      const [oldKey, oldUrl] = cache.entries().next().value as [string, string];
      cache.delete(oldKey);
      deps.revokeObjectURL(oldUrl);
    }
  };

  const clear = () => {
    for (const url of cache.values()) deps.revokeObjectURL(url);
    cache.clear();
  };

  const body = (text: string, variant: EnVariant, speed: SpeechSpeed): SpeechBody => ({ text: speechText(text), variant, speed });

  /** MP3 of the phrase as an object URL (cached; one request per phrase at a time). */
  function fetchSpeech(text: string, variant: EnVariant, speed: SpeechSpeed = "normal", o: { quiet?: boolean } = {}): Promise<string> {
    const req = body(text, variant, speed);
    const key = speechKey(req);
    const hit = cache.get(key);
    if (hit) {
      remember(key, hit);
      return Promise.resolve(hit);
    }
    const pending = inflight.get(key);
    if (pending) return pending;
    if (!source) return Promise.reject(new SpeechUnavailableError("no speech source"));
    const gen = generation;
    const p = source(req, { quiet: !!o.quiet })
      .then((blob) => {
        const url = deps.createObjectURL(blob);
        if (gen === generation) remember(key, url);
        return url;
      })
      .finally(() => {
        if (inflight.get(key) === p) inflight.delete(key);
      });
    inflight.set(key, p);
    return p;
  }

  /** Warm the cache (the item is on screen, the next line of a dialogue); failures are silent. */
  function prefetchSpeech(text: string, variant: EnVariant, speed: SpeechSpeed = "normal"): Promise<void> {
    return fetchSpeech(text, variant, speed, { quiet: true }).then(
      () => undefined,
      () => undefined,
    );
  }

  /** Stop whatever is playing (file or device voice); its playSpeech() promise resolves. */
  function stopSpeech(): void {
    token += 1;
    const c = current;
    current = null;
    try {
      el?.pause();
    } catch {
      /* ignore */
    }
    deps.device.stop();
    c?.finish();
  }

  /**
   * The core of playSpeech / playUrl on the shared element. `ready` — the URL is at hand: src + play() right in the call
   * (the tap handler); otherwise the silent unlock in the call, then `load()`. `fallback` — another way to sound (the
   * device voice) when the load fails with an error `fallbackOn` accepts or the file does not start; without it those
   * errors reach the caller (a file that does not start — AudioPlaybackError).
   */
  function playCore(
    o: PlayOptions,
    plan: {
      ready: string | undefined;
      load: () => Promise<string>;
      fallback: ((onStart: () => void, live: () => boolean) => Promise<boolean>) | null;
      fallbackOn: (e: unknown) => boolean;
    },
  ): Promise<void> {
    stopSpeech();
    const my = ++token;
    const a = audio();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let started = false;
      let off = () => {};
      const live = () => token === my && !settled;
      const onAbort = () => {
        if (token === my) stopSpeech();
      };
      const done = (err?: unknown) => {
        if (settled) return;
        settled = true;
        off();
        if (current?.token === my) current = null;
        o.signal?.removeEventListener("abort", onAbort);
        if (err === undefined) resolve();
        else reject(err);
      };
      const start = () => {
        if (started || !live()) return;
        started = true;
        o.onStart?.();
      };
      current = { token: my, finish: () => done() };
      if (o.signal?.aborted) {
        stopSpeech();
        return;
      }
      o.signal?.addEventListener("abort", onAbort);

      /** the file / the load failed before any sound */
      const other = async (err: unknown) => {
        off();
        if (!plan.fallback) return done(err);
        try {
          const ok = await plan.fallback(start, live);
          if (!live()) return;
          done(ok || started ? undefined : new SpeechUnavailableError());
        } catch {
          if (live()) done(new SpeechUnavailableError());
        }
      };

      const playFile = (el: AudioLike, url: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onPlaying = () => {
          clearTimeout(timer);
          start();
        };
        const onEnded = () => done();
        const onFail = () => {
          if (!live()) return;
          if (started) return done();
          try {
            el.pause();
          } catch {
            /* ignore */
          }
          void other(new AudioPlaybackError());
        };
        off = () => {
          clearTimeout(timer);
          el.removeEventListener("playing", onPlaying);
          el.removeEventListener("ended", onEnded);
          el.removeEventListener("error", onFail);
        };
        el.addEventListener("playing", onPlaying);
        el.addEventListener("ended", onEnded);
        el.addEventListener("error", onFail);
        timer = setTimeout(onFail, startTimeout);
        el.src = url; // a new src restarts from the beginning
        let p: Promise<void> | void;
        try {
          p = el.play();
        } catch {
          onFail();
          return;
        }
        if (p && typeof p.then === "function") p.then(onPlaying, onFail);
      };

      if (a && plan.ready) {
        playFile(a, plan.ready); // in the tap handler: iOS lets it play
        return;
      }
      if (a) {
        // unlock the element in the gesture: the sound plays after the load, without a gesture
        try {
          a.src = SILENT_MP3;
          const p = a.play();
          if (p && typeof p.catch === "function") p.catch(() => undefined);
        } catch {
          /* ignore */
        }
      }
      let loading: Promise<string>;
      try {
        loading = plan.ready ? Promise.resolve(plan.ready) : plan.load();
      } catch (e) {
        loading = Promise.reject(e);
      }
      loading.then(
        (url) => {
          if (!live()) return;
          if (a) playFile(a, url);
          else void other(new AudioPlaybackError("no audio element"));
        },
        (e: unknown) => {
          if (!live()) return;
          if (plan.fallbackOn(e)) void other(e);
          else done(e);
        },
      );
    });
  }

  /**
   * Play one phrase. Call it synchronously in the tap handler (iOS). Resolves when the phrase ends or is stopped;
   * rejects with SpeechUnavailableError (neither the server nor the device can speak) or the ApiError of the BFF.
   */
  function playSpeech(text: string, variant: EnVariant, o: PlayOptions = {}): Promise<void> {
    const speed = o.speed ?? "normal";
    const req = body(text, variant, speed);
    const key = speechKey(req);
    const cached = cache.get(key);
    if (cached) remember(key, cached);
    return playCore(o, {
      ready: cached,
      load: () => fetchSpeech(req.text, variant, speed),
      fallback: async (onStart, live) => {
        const voice = await deps.device.voice(variant);
        if (!voice || !live()) return false;
        return deps.device.speak(req.text, { voice, variant, rate: speed === "slow" ? 0.85 : 0.95, onStart });
      },
      fallbackOn: serverSpeechDown,
    });
  }

  /**
   * Play an audio file (a media file of the BFF) on the same shared element, the same way: a ready object URL plays
   * right in the call (the tap handler); a pending one — after the silent unlock in the call. Resolves on `ended` or
   * stop; rejects with the load error (ApiError) or AudioPlaybackError (the file did not start). No fallback.
   */
  function playUrl(src: string | Promise<string>, o: Omit<PlayOptions, "speed"> = {}): Promise<void> {
    return playCore(o, {
      ready: typeof src === "string" ? src : undefined,
      load: () => src as Promise<string>,
      fallback: null,
      fallbackOn: () => false,
    });
  }

  /** File loads in flight by key: a screen shown again meanwhile (React StrictMode mounts twice) shares the request. */
  const fileLoads = new Map<string, Promise<Blob>>();
  const loadShared = (key: string | undefined, load: () => Promise<Blob>): Promise<Blob> => {
    if (key === undefined) return load();
    const pending = fileLoads.get(key);
    if (pending) return pending;
    const p = load().finally(() => {
      if (fileLoads.get(key) === p) fileLoads.delete(key);
    });
    fileLoads.set(key, p);
    return p;
  };

  /**
   * A media file fetched ahead (when the screen shows). `src()` — the object URL once loaded (playUrl plays it right in
   * the tap) or the pending load (playUrl unlocks the element in the tap); after a failed load the next src() loads
   * again. `dispose()` revokes the URL (unmount). `key` (the asset id) — loads in flight are shared.
   */
  function preloadFile(load: () => Promise<Blob>, key?: string): PreloadedFile {
    let url: string | null = null;
    let pending: Promise<string> | null = null;
    let disposed = false;
    const fetchIt = (): Promise<string> => {
      const p = loadShared(key, load).then((blob) => {
        const u = deps.createObjectURL(blob);
        if (disposed) {
          deps.revokeObjectURL(u);
          throw new AudioPlaybackError("disposed");
        }
        url = u;
        return u;
      });
      pending = p;
      p.then(
        () => {
          if (pending === p) pending = null;
        },
        () => {
          if (pending === p) pending = null; // the next src() tries again
        },
      );
      return p;
    };
    void fetchIt().catch(() => undefined);
    return {
      src: () => url ?? pending ?? fetchIt(),
      dispose: () => {
        disposed = true;
        if (url) deps.revokeObjectURL(url);
        url = null;
      },
    };
  }

  return {
    fetchSpeech,
    prefetchSpeech,
    playSpeech,
    playUrl,
    preloadFile,
    stopSpeech,
    /** The BFF call; a new source (another client) starts with an empty cache. */
    setSource(s: SpeechSource | null): void {
      if (s === source) return;
      source = s;
      generation += 1;
      inflight.clear();
      clear();
    },
    clear,
    get size(): number {
      return cache.size;
    },
  };
}

export type SpeechPlayer = ReturnType<typeof createSpeechPlayer>;

const browser: SpeechDeps = {
  createAudio: () => {
    if (typeof Audio === "undefined") return null;
    const a = new Audio();
    a.preload = "auto";
    return a;
  },
  createObjectURL: (b) => URL.createObjectURL(b),
  revokeObjectURL: (u) => {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* ignore */
    }
  },
  device: {
    voice: async (variant) => pickEnglishVoice(await loadVoices(1500), variant),
    speak: (text, o) => speak(text, o),
    stop: () => stopSpeaking(),
  },
};

/** The app's player: one audio element, one cache. */
export const speechPlayer = createSpeechPlayer(browser);
export const fetchSpeech = speechPlayer.fetchSpeech;
export const prefetchSpeech = speechPlayer.prefetchSpeech;
export const playSpeech = speechPlayer.playSpeech;
export const playUrl = speechPlayer.playUrl;
export const preloadAudio = speechPlayer.preloadFile;
export const stopSpeech = speechPlayer.stopSpeech;
/** Bind the BFF (App.tsx, once the client exists). */
export const setSpeechSource = speechPlayer.setSource;
