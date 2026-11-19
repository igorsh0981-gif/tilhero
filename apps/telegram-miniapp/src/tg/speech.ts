/**
 * Speech synthesis of the device (Web Speech API, speechSynthesis) for the listening items of the placement test and
 * the media without an audio file (INTERNAL_API: «аудирование — синтез речи устройства, голос en-*»). No en-* voice on
 * the device → the caller reports listening as unavailable (diagnostics) or offers the transcript (media).
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

/** Speak one phrase; resolves when it ends (or fails). A previous phrase is cancelled. */
export function speak(text: string, opts: { voice?: SpeechSynthesisVoice | null; variant?: EnVariant; rate?: number } = {}): Promise<void> {
  const s = synth();
  if (!s || typeof SpeechSynthesisUtterance === "undefined") return Promise.reject(new Error("no speech synthesis"));
  return new Promise((resolve) => {
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = opts.voice ?? null;
    if (v) u.voice = v;
    u.lang = v?.lang ?? opts.variant ?? "en-GB";
    u.rate = opts.rate ?? 0.95;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    s.speak(u);
  });
}

/** Speak lines one after another (media without an audio file); `signal` stops between and inside lines. */
export async function speakLines(lines: ReadonlyArray<{ text: string; variant: EnVariant }>, voices: readonly SpeechSynthesisVoice[], signal: { stopped: boolean }): Promise<void> {
  for (const l of lines) {
    if (signal.stopped) return;
    await speak(l.text, { voice: pickEnglishVoice(voices, l.variant), variant: l.variant });
  }
}

export function stopSpeaking(): void {
  synth()?.cancel();
}
