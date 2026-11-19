import type { Page } from "@playwright/test";

/**
 * Device speech synthesis and audio playback for e2e: headless Chromium has no voices and no audio output. The fake
 * speechSynthesis reports the given voices (none → «нет голоса en-*»; `null` — no speechSynthesis at all, as inside
 * Telegram on Android), records every phrase in window.__spoken and ends each phrase after 120 ms;
 * HTMLMediaElement.play resolves and «ends» after 300 ms unless the src changed meanwhile (as a real load drops the old
 * clip's events). window.__sources — every src played; window.__played counts plays of real audio (the silent MP3 the
 * server speech player unlocks iOS with is a data: URI and is not counted).
 */
export interface FakeVoice {
  lang: string;
  name: string;
}

export const EN_VOICES: FakeVoice[] = [
  { lang: "en-GB", name: "Fake English (UK)" },
  { lang: "en-US", name: "Fake English (US)" },
  { lang: "ru-RU", name: "Fake Russian" },
];

export async function installSpeech(page: Page, voices: FakeVoice[] | null = EN_VOICES): Promise<void> {
  await page.addInitScript((vs) => {
    const w = window as unknown as Record<string, unknown>;
    const spoken: Array<{ text: string; lang: string; voice: string | null }> = [];
    const sources: string[] = [];
    w.__spoken = spoken;
    w.__sources = sources;
    w.__played = 0;
    class Utterance {
      text: string;
      lang = "";
      voice: { name: string } | null = null;
      rate = 1;
      onend: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    const synth = {
      speaking: false,
      pending: false,
      paused: false,
      onvoiceschanged: null,
      getVoices: () => (vs ?? []).map((v) => ({ ...v, localService: true, default: false, voiceURI: v.name })),
      speak(u: Utterance) {
        spoken.push({ text: u.text, lang: u.lang, voice: u.voice?.name ?? null });
        setTimeout(() => u.onend?.(new Event("end")), 120);
      },
      cancel() {},
      pause() {},
      resume() {},
      addEventListener() {},
      removeEventListener() {},
    };
    if (vs) {
      Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
      Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, writable: true, value: Utterance });
    } else {
      // Telegram on Android: no synthesis at all
      delete (window as unknown as Record<string, unknown>).speechSynthesis;
      Object.defineProperty(window, "speechSynthesis", { configurable: true, value: undefined });
    }
    HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
      const src = this.src;
      sources.push(src);
      if (!src.startsWith("data:")) w.__played = Number(w.__played) + 1;
      setTimeout(() => {
        if (this.src === src) this.dispatchEvent(new Event("ended"));
      }, 300);
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function pause() {};
  }, voices);
}

export const spoken = (page: Page) => page.evaluate(() => (window as unknown as { __spoken: Array<{ text: string; lang: string; voice: string | null }> }).__spoken);
export const played = (page: Page) => page.evaluate(() => Number((window as unknown as { __played: number }).__played));
export const sources = (page: Page) => page.evaluate(() => (window as unknown as { __sources: string[] }).__sources);
