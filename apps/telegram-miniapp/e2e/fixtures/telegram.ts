import type { Page } from "@playwright/test";

/**
 * Fake window.Telegram.WebApp (Bot API 8.0) for e2e of the native bridge — ported from aievent
 * (e2e/fixtures/telegram.ts: MainButton / BackButton, themeParams + colorScheme, haptics, showPopup, CloudStorage kept in
 * localStorage under "__tgcloud:<key>" so it survives a reload like the real per-user cloud, addToHomeScreen /
 * checkHomeScreenStatus) without BiometricManager, plus TilHero's full screen: requestFullscreen → isFullscreen,
 * the insets of the mode (safeAreaInset + contentSafeAreaInset) and the events fullscreenChanged / safeAreaChanged /
 * contentSafeAreaChanged, or fullscreenFailed. Every call is recorded in window.__tgCalls.
 */
export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface TelegramOptions {
  colorScheme?: "light" | "dark";
  startParam?: string;
  languageCode?: string;
  version?: string;
  platform?: string;
  cloudStorage?: boolean;
  /** Bot API 8.0 home screen; onAdd — whether homeScreenAdded arrives */
  homeScreen?: { status: "unsupported" | "unknown" | "added" | "missed"; onAdd?: "event" | "silent" };
  /** Bot API 8.0 full screen: insets reported once in full screen; fail — answer fullscreenFailed {error} */
  fullscreen?: { safe: Insets; content: Insets; fail?: "UNSUPPORTED" };
}

/** iPhone 14-ish in Telegram full screen: status bar 47, Telegram's «Закрыть» / «⋯» row 46, home indicator 34. */
export const IOS_FULLSCREEN = { safe: { top: 47, bottom: 34, left: 0, right: 0 }, content: { top: 46, bottom: 0, left: 0, right: 0 } };

export type TgWindow = Window & {
  __tgCalls: unknown[][];
  Telegram: { WebApp: { BackButton: { click(): void; isVisible: boolean }; isFullscreen: boolean; colorScheme: string } };
};

export async function installTelegram(page: Page, opts: TelegramOptions = {}): Promise<void> {
  await page.addInitScript((o) => {
    const calls: unknown[][] = [];
    (window as unknown as { __tgCalls: unknown[][] }).__tgCalls = calls;
    const button = (name: string) => {
      const b = {
        text: "",
        isVisible: false,
        isActive: true,
        isProgressVisible: false,
        cbs: [] as Array<() => void>,
        setParams(p: Record<string, unknown>) {
          if (typeof p.text === "string") b.text = p.text;
          if (typeof p.is_visible === "boolean") b.isVisible = p.is_visible;
          calls.push([`${name}.setParams`, p]);
          return b;
        },
        onClick(cb: () => void) {
          b.cbs.push(cb);
          return b;
        },
        offClick(cb: () => void) {
          b.cbs = b.cbs.filter((x) => x !== cb);
          return b;
        },
        show() {
          b.isVisible = true;
          return b;
        },
        hide() {
          b.isVisible = false;
          return b;
        },
        showProgress() {
          b.isProgressVisible = true;
          return b;
        },
        hideProgress() {
          b.isProgressVisible = false;
          return b;
        },
        click() {
          b.cbs.forEach((cb) => cb());
        },
      };
      return b;
    };
    const handlers: Record<string, Array<(p?: unknown) => void>> = {};
    const emit = (e: string, p?: unknown) => (handlers[e] ?? []).slice().forEach((h) => h(p));
    const ver = (a: string, b: string) => {
      const x = a.split(".").map(Number);
      const y = b.split(".").map(Number);
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
      return 0;
    };
    const user = { id: 918273645, first_name: "Aziz", language_code: o.languageCode ?? "ru" };
    const version = o.version ?? "8.0";
    const CLOUD = "__tgcloud:";
    const cloud = {
      getItem(k: string, cb: (e: string | null, v?: string) => void) {
        calls.push(["CloudStorage.getItem", k]);
        setTimeout(() => cb(null, localStorage.getItem(CLOUD + k) ?? ""), 10);
        return cloud;
      },
      setItem(k: string, v: string, cb?: (e: string | null, ok?: boolean) => void) {
        calls.push(["CloudStorage.setItem", k, v]);
        localStorage.setItem(CLOUD + k, v);
        setTimeout(() => cb?.(null, true), 10);
        return cloud;
      },
      removeItem(k: string, cb?: (e: string | null, ok?: boolean) => void) {
        localStorage.removeItem(CLOUD + k);
        setTimeout(() => cb?.(null, true), 10);
        return cloud;
      },
    };
    const zero = { top: 0, bottom: 0, left: 0, right: 0 };
    const wa: Record<string, unknown> = {
      initData: `query_id=AAE&user=${encodeURIComponent(JSON.stringify(user))}&auth_date=1791370000&hash=tg-e2e`,
      initDataUnsafe: { user, start_param: o.startParam },
      version,
      platform: o.platform ?? "ios",
      colorScheme: o.colorScheme ?? "light",
      themeParams:
        o.colorScheme === "dark"
          ? { bg_color: "#17212b", text_color: "#f5f5f5", link_color: "#6ab3f3", button_color: "#5288c1", button_text_color: "#ffffff" }
          : { bg_color: "#ffffff", text_color: "#000000", link_color: "#2481cc", button_color: "#2481cc", button_text_color: "#ffffff" },
      isExpanded: true,
      isFullscreen: false,
      viewportHeight: window.innerHeight,
      viewportStableHeight: window.innerHeight,
      safeAreaInset: { ...zero },
      contentSafeAreaInset: { ...zero },
      isVersionAtLeast: (v: string) => ver(version, v) >= 0,
      setHeaderColor: (c: string) => calls.push(["setHeaderColor", c]),
      setBackgroundColor: (c: string) => calls.push(["setBackgroundColor", c]),
      setBottomBarColor: (c: string) => calls.push(["setBottomBarColor", c]),
      disableVerticalSwipes: () => calls.push(["disableVerticalSwipes"]),
      onEvent: (e: string, h: (p?: unknown) => void) => (handlers[e] ??= []).push(h),
      offEvent: (e: string, h: (p?: unknown) => void) => (handlers[e] = (handlers[e] ?? []).filter((x) => x !== h)),
      ready: () => calls.push(["ready"]),
      expand: () => calls.push(["expand"]),
      close: () => calls.push(["close"]),
      openLink: (u: string) => calls.push(["openLink", u]),
      openTelegramLink: (u: string) => calls.push(["openTelegramLink", u]),
      showPopup: (p: { title: string }, cb: (id: string) => void) => {
        calls.push(["showPopup", p.title]);
        (window as unknown as { __tgPopup: unknown }).__tgPopup = { p, cb };
      },
      showConfirm: (_m: string, cb: (ok: boolean) => void) => cb(true),
      requestWriteAccess: (cb: (g: boolean) => void) => {
        calls.push(["requestWriteAccess"]);
        cb(true);
      },
      BackButton: button("BackButton"),
      MainButton: button("MainButton"),
      SecondaryButton: button("SecondaryButton"),
      HapticFeedback: {
        impactOccurred: (s: string) => calls.push(["haptic.impact", s]),
        notificationOccurred: (t: string) => calls.push(["haptic.notify", t]),
        selectionChanged: () => calls.push(["haptic.selection"]),
      },
      requestFullscreen: () => {
        calls.push(["requestFullscreen"]);
        const fs = o.fullscreen;
        if (fs?.fail) {
          setTimeout(() => emit("fullscreenFailed", { error: fs.fail }), 20);
          return;
        }
        wa.isFullscreen = true;
        if (fs) {
          wa.safeAreaInset = fs.safe;
          wa.contentSafeAreaInset = fs.content;
        }
        setTimeout(() => {
          emit("fullscreenChanged");
          emit("safeAreaChanged");
          emit("contentSafeAreaChanged");
        }, 20);
      },
      exitFullscreen: () => {
        calls.push(["exitFullscreen"]);
        wa.isFullscreen = false;
        wa.safeAreaInset = { ...zero };
        wa.contentSafeAreaInset = { ...zero };
        setTimeout(() => {
          emit("fullscreenChanged");
          emit("safeAreaChanged");
          emit("contentSafeAreaChanged");
        }, 20);
      },
      ...(o.cloudStorage === false ? {} : { CloudStorage: cloud }),
      ...(o.homeScreen
        ? {
            checkHomeScreenStatus: (cb?: (s: string) => void) => {
              calls.push(["checkHomeScreenStatus"]);
              setTimeout(() => cb?.(o.homeScreen!.status), 10);
            },
            addToHomeScreen: () => {
              calls.push(["addToHomeScreen"]);
              if (o.homeScreen!.onAdd === "silent") return;
              o.homeScreen!.status = "added";
              setTimeout(() => emit("homeScreenAdded"), 50);
            },
          }
        : {}),
    };
    (window as unknown as { Telegram: unknown }).Telegram = { WebApp: wa };
    (window as unknown as { __tgEmit: typeof emit }).__tgEmit = emit;
  }, opts);
}

export const tgCalls = (page: Page): Promise<unknown[][]> => page.evaluate(() => (window as unknown as TgWindow).__tgCalls);
export const tgCalled = async (page: Page, name: string): Promise<number> => (await tgCalls(page)).filter((c) => c[0] === name).length;
export const tgBack = (page: Page): Promise<void> => page.evaluate(() => (window as unknown as TgWindow).Telegram.WebApp.BackButton.click());
/** Telegram changes its colour scheme (Settings → Night mode). */
export const tgSetScheme = (page: Page, scheme: "light" | "dark"): Promise<void> =>
  page.evaluate((s) => {
    const w = window as unknown as TgWindow & { __tgEmit(e: string): void };
    w.Telegram.WebApp.colorScheme = s;
    w.__tgEmit("themeChanged");
  }, scheme);

/**
 * Screenshot aid (test only): draws what Telegram draws over a full-screen Mini App on iOS — the status bar and the
 * «Закрыть» / «⋯» buttons — so the shot shows that the app's header starts below them. pointer-events: none.
 */
export async function drawTelegramChrome(page: Page, insets = IOS_FULLSCREEN): Promise<void> {
  await page.evaluate((i) => {
    const top = i.safe.top;
    const h = i.content.top;
    const layer = document.createElement("div");
    layer.id = "__tg-chrome";
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText = `position:fixed;left:0;right:0;top:0;height:${top + h}px;pointer-events:none;z-index:99999;font:600 15px -apple-system,system-ui,sans-serif;`;
    const status = document.createElement("div");
    status.style.cssText = `position:absolute;left:0;right:0;top:0;height:${top}px;display:flex;align-items:center;justify-content:space-between;padding:0 30px;color:#888;box-sizing:border-box;`;
    status.innerHTML = "<span>9:41</span><span>●●● ▮</span>";
    const pill = (text: string, side: "left" | "right") => {
      const p = document.createElement("div");
      p.textContent = text;
      p.style.cssText = `position:absolute;${side}:12px;top:${top + 6}px;height:${h - 12}px;padding:0 14px;border-radius:${(h - 12) / 2}px;background:rgba(60,60,67,.55);color:#fff;display:flex;align-items:center;`;
      return p;
    };
    layer.append(status, pill("✕ Закрыть", "left"), pill("⋯", "right"));
    const guide = document.createElement("div");
    guide.style.cssText = `position:absolute;left:0;right:0;top:${top + h}px;border-top:1px dashed rgba(220,40,60,.8);`;
    layer.append(guide);
    document.body.appendChild(layer);
  }, insets);
}
