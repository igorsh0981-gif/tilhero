/**
 * Full screen on phones (Bot API 8.0): tgReady → ready, expand, requestFullscreen on iOS / Android; fullscreenFailed is
 * silent (the app stays expanded); fullscreenChanged re-reads the insets so every header starts below --safe-top.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isFullscreen, requestFullscreenOnMobile, resetFullscreenForTests, tgReady, wantsFullscreen } from "../src/tg";
import { installTg, uninstallTg, type FakeTg } from "./tgFake";

const IOS_INSETS = { safe: { top: 47, bottom: 34, left: 0, right: 0 }, content: { top: 46, bottom: 0, left: 0, right: 0 } };
const root = document.documentElement;
const cssVar = (n: string) => root.style.getPropertyValue(n);
const called = (tg: FakeTg, name: string) => tg.calls.filter((c) => c[0] === name).length;
const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  resetFullscreenForTests();
  root.removeAttribute("style");
});
afterEach(() => uninstallTg());

describe("full screen (Bot API 8.0)", () => {
  it("iOS 8.0: ready → expand → requestFullscreen; fullscreenChanged → data-fullscreen and the insets of the mode", async () => {
    const tg = installTg({ platform: "ios", fullscreenInsets: IOS_INSETS });
    tgReady();
    expect(tg.calls.map((c) => c[0]).slice(0, 4)).toEqual(["ready", "expand", "disableVerticalSwipes", "requestFullscreen"]);
    await flush();
    expect(root.dataset.fullscreen).toBe("true");
    expect(isFullscreen()).toBe(true);
    expect(cssVar("--tg-safe-top")).toBe("47px");
    expect(cssVar("--tg-content-safe-top")).toBe("46px");
    expect(cssVar("--tg-safe-bottom")).toBe("34px");
  });

  it.each(["ios", "android", "android_x"])("phones (%s) ask for full screen", (platform) => {
    const tg = installTg({ platform });
    expect(wantsFullscreen()).toBe(true);
    tgReady();
    expect(called(tg, "requestFullscreen")).toBe(1);
  });

  it.each(["tdesktop", "macos", "weba", "webk", "unknown"])("desktop / web (%s) stay as they are", (platform) => {
    const tg = installTg({ platform });
    tgReady();
    expect(called(tg, "expand")).toBe(1);
    expect(called(tg, "requestFullscreen")).toBe(0);
  });

  it("older clients (7.10), clients without the method and outside Telegram — only expand", () => {
    let tg = installTg({ platform: "ios", version: "7.10" });
    tgReady();
    expect(called(tg, "expand")).toBe(1);
    expect(called(tg, "requestFullscreen")).toBe(0);
    tg = installTg({ platform: "ios", fullscreenMethods: false });
    expect(requestFullscreenOnMobile()).toBe(false);
    tg = installTg({ platform: "ios", initData: "" });
    tgReady();
    expect(tg.calls).toEqual([]);
  });

  it("fullscreenFailed UNSUPPORTED — silently stays expanded; ALREADY_FULLSCREEN — full screen", async () => {
    const tg = installTg({ platform: "ios", onFullscreen: "unsupported" });
    expect(() => tgReady()).not.toThrow();
    await flush();
    expect(root.dataset.fullscreen).toBe("false");
    expect(called(tg, "expand")).toBe(1);
    tg.emit("fullscreenFailed", { error: "ALREADY_FULLSCREEN" });
    expect(root.dataset.fullscreen).toBe("true");
  });

  it("an exception of the client is swallowed", () => {
    installTg({ platform: "android", onFullscreen: "throw" });
    expect(() => tgReady()).not.toThrow();
    expect(root.dataset.fullscreen).toBe("false");
  });

  it("asked once per launch (StrictMode runs effects twice); leaving full screen is followed", async () => {
    const tg = installTg({ platform: "ios", fullscreenInsets: IOS_INSETS });
    tgReady();
    tgReady();
    expect(called(tg, "requestFullscreen")).toBe(1);
    await flush();
    tg.wa.isFullscreen = false;
    tg.wa.safeAreaInset = { top: 0, bottom: 0, left: 0, right: 0 };
    tg.wa.contentSafeAreaInset = { top: 0, bottom: 0, left: 0, right: 0 };
    tg.emit("fullscreenChanged");
    expect(root.dataset.fullscreen).toBe("false");
    expect(cssVar("--tg-safe-top")).toBe("0px");
    expect(cssVar("--tg-content-safe-top")).toBe("0px");
  });

  it("already in full screen at start (BotFather setting) — no request, the insets are applied", () => {
    const tg = installTg({ platform: "ios" });
    tg.wa.isFullscreen = true;
    tg.wa.safeAreaInset = IOS_INSETS.safe;
    tg.wa.contentSafeAreaInset = IOS_INSETS.content;
    tgReady();
    expect(called(tg, "requestFullscreen")).toBe(0);
    expect(root.dataset.fullscreen).toBe("true");
    expect(cssVar("--tg-content-safe-top")).toBe("46px");
  });
});
