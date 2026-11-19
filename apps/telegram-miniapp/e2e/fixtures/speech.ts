import type { Page } from "@playwright/test";

/**
 * Device speech synthesis and audio playback for e2e: headless Chromium has no voices and no audio output. The fake
 * speechSynthesis reports the given voices (none → «нет голоса en-*»), records every phrase in window.__spoken and ends
 * each phrase after 120 ms; HTMLMediaElement.play resolves and «ends» after 300 ms (window.__played counts plays).
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

export async function installSpeech(page: Page, voices: FakeVoice[] = EN_VOICES): Promise<void> {
  await page.addInitScript((vs) => {
    const w = window as unknown as Record<string, unknown>;
    const spoken: Array<{ text: string; lang: string; voice: string | null }> = [];
    w.__spoken = spoken;
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
      getVoices: () => vs.map((v) => ({ ...v, localService: true, default: false, voiceURI: v.name })),
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
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, writable: true, value: Utterance });
    HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
      w.__played = Number(w.__played) + 1;
      setTimeout(() => this.dispatchEvent(new Event("ended")), 300);
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function pause() {};
  }, voices);
}

export const spoken = (page: Page) => page.evaluate(() => (window as unknown as { __spoken: Array<{ text: string; lang: string; voice: string | null }> }).__spoken);
export const played = (page: Page) => page.evaluate(() => Number((window as unknown as { __played: number }).__played));
