import type { Page } from "@playwright/test";

/**
 * A fake microphone for «Произнести» (headless Chromium has none): getUserMedia answers with a 220 Hz tone from an
 * oscillator (ok), refuses with NotAllowedError (denied), or navigator.mediaDevices is missing (none — an old webview).
 * window.__gum counts the prompts (APP-VOICE-04: no loop of prompts after a refusal).
 */
export async function installMic(page: Page, mode: "ok" | "denied" | "none" = "ok"): Promise<void> {
  await page.addInitScript((m) => {
    const w = window as unknown as Record<string, unknown>;
    w.__gum = 0;
    if (m === "none") {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
      return;
    }
    const devices = navigator.mediaDevices;
    const fake = async (): Promise<MediaStream> => {
      w.__gum = Number(w.__gum) + 1;
      if (m === "denied") throw new DOMException("Permission denied", "NotAllowedError");
      const ctx = new AudioContext();
      await ctx.resume().catch(() => undefined);
      const osc = ctx.createOscillator();
      osc.frequency.value = 220;
      const gain = ctx.createGain();
      gain.gain.value = 0.4;
      const dst = ctx.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dst);
      osc.start();
      return dst.stream;
    };
    Object.defineProperty(devices, "getUserMedia", { configurable: true, value: fake });
  }, mode);
}

export const gumCalls = (page: Page) => page.evaluate(() => Number((window as unknown as { __gum: number }).__gum));
