/**
 * Speech synthesis of the device (Web Speech API, speechSynthesis). Since release 4.1 it is only the fallback of the
 * server speech (tts.ts: MP3 from POST /v1/speech): inside Telegram on Android there is no synthesis at all, on iOS it
 * goes to a channel the volume buttons do not control. Used only when the server speech is unavailable (503 / no
 * network / the file does not start). No en-* voice → the caller says «недоступно».
 * Voices load asynchronously in Chrome / Android WebView: wait for `voiceschanged` (bounded).
 */
export type EnVariant = "en-GB" | "en-US";

interface VoiceLike {
  lang: string;
  name: string;
  localService?: boolean;
  default?: boolean;
}

function synth(): SpeechSynthesis | null {
  try {
    return typeof window !== "undefined" && "speechSynthesis" in window && window.speechSynthesis ? window.speechSynthesis : null;
  } catch {
    return null;
  }
}

const norm = (lang: string) => lang.replace("_", "-").toLowerCase();

/** The English voice to use: the preferred variant, then en-GB, en-US, then any en-*; local voices first. */
export function pickEnglishVoice<V extends VoiceLike>(voices: readonly V[], prefer?: EnVariant): V | null {
  const en = voices.filter((v) => norm(v.lang).startsWith("en"));
  if (!en.length) return null;
  const order = [prefer, "en-GB", "en-US"].filter(Boolean).map((x) => x!.toLowerCase());
  const score = (v: V) => {
    const i = order.indexOf(norm(v.lang));
    return (i < 0 ? order.length : i) * 2 + (v.localService === false ? 1 : 0);
  };
  return [...en].sort((a, b) => score(a) - score(b))[0] ?? null;
}

/** Device voices, waiting up to `timeoutMs` for the first `voiceschanged`. */
export function loadVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return Promise.resolve([]);
  const now = s.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      s.removeEventListener?.("voiceschanged", finish);
      resolve(s.getVoices());
    };
    s.addEventListener?.("voiceschanged", finish);
    setTimeout(finish, timeoutMs);
  });
}

/** Is there an English voice on this device? */
export async function hasEnglishVoice(timeoutMs?: number): Promise<boolean> {
  return pickEnglishVoice(await loadVoices(timeoutMs)) !== null;
}

/** No `start` from the engine within this time — the phrase is given up (some WebViews accept speak() and stay silent). */
export const SPEAK_START_TIMEOUT_MS = 5000;

export interface SpeakOptions {
  voice?: SpeechSynthesisVoice | null;
  variant?: EnVariant;
  rate?: number;
  /** the phrase actually started sounding (`start`, or a normal `end` without one) */
  onStart?: () => void;
  startTimeoutMs?: number;
}

/**
 * Speak one phrase; resolves when it ends, fails or is cancelled — with `true` if it actually sounded. A previous
 * phrase is cancelled.
 */
export function speak(text: string, opts: SpeakOptions = {}): Promise<boolean> {
  const s = synth();
  if (!s || typeof SpeechSynthesisUtterance === "undefined") return Promise.reject(new Error("no speech synthesis"));
  return new Promise((resolve) => {
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = opts.voice ?? null;
    if (v) u.voice = v;
    u.lang = v?.lang ?? opts.variant ?? "en-GB";
    u.rate = opts.rate ?? 0.95;
    let started = false;
    let done = false;
    const start = () => {
      if (started || done) return;
      started = true;
      clearTimeout(timer);
      opts.onStart?.();
    };
    const finish = (ok: boolean) => {
      if (done) return;
      if (ok) start();
      done = true;
      clearTimeout(timer);
      resolve(started);
    };
    const timer = setTimeout(() => {
      if (started || done) return;
      finish(false);
      s.cancel();
    }, opts.startTimeoutMs ?? SPEAK_START_TIMEOUT_MS);
    u.onstart = () => start();
    u.onend = () => finish(true);
    u.onerror = () => finish(false);
    s.speak(u);
  });
}

export function stopSpeaking(): void {
  synth()?.cancel();
}
