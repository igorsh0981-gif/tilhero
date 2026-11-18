/**
 * Fake window.Telegram.WebApp for unit tests (Bot API 8.0): versions, platform, events, full screen, the home screen
 * (from aievent test/s94.test.tsx), CloudStorage in memory, theme / native colours. Every call is recorded.
 */
import { vi } from "vitest";
import type { TgHomeScreenStatus, TgInsets } from "../src/tg/types";

type Handler = (p?: unknown) => void;

export interface FakeTg {
  version: string;
  platform: string;
  /** null — the client does not answer checkHomeScreenStatus */
  status: TgHomeScreenStatus | null;
  /** what addToHomeScreen does: homeScreenAdded / nothing / only homeScreenChecked / homeScreenFailed / throws */
  onAdd: "event" | "silent" | "checked" | "failed" | "throw";
  /** what requestFullscreen does */
  onFullscreen: "ok" | "unsupported" | "throw";
  handlers: Map<string, Set<Handler>>;
  added: number;
  calls: unknown[][];
  cloud: Map<string, string>;
  wa: Record<string, unknown>;
  emit(ev: string, p?: unknown): void;
}

export interface FakeTgOptions {
  version?: string;
  platform?: string;
  status?: TgHomeScreenStatus | null;
  onAdd?: FakeTg["onAdd"];
  onFullscreen?: FakeTg["onFullscreen"];
  initData?: string;
  /** home screen methods present (8.0 clients without them exist) */
  methods?: boolean;
  fullscreenMethods?: boolean;
  colorScheme?: "light" | "dark";
  cloudStorage?: boolean;
  cloud?: Record<string, string>;
  /** insets reported once in full screen */
  fullscreenInsets?: { safe: TgInsets; content: TgInsets };
}

const ZERO: TgInsets = { top: 0, bottom: 0, left: 0, right: 0 };

export function installTg(o: FakeTgOptions = {}): FakeTg {
  const tg: FakeTg = {
    version: o.version ?? "8.0",
    platform: o.platform ?? "android",
    status: o.status === undefined ? "missed" : o.status,
    onAdd: o.onAdd ?? "event",
    onFullscreen: o.onFullscreen ?? "ok",
    handlers: new Map(),
    added: 0,
    calls: [],
    cloud: new Map(Object.entries(o.cloud ?? {})),
    wa: {},
    emit(ev, p) {
      for (const h of [...(this.handlers.get(ev) ?? [])]) h(p);
    },
  };
  const cmp = (a: string, b: string) => {
    const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
    for (let i = 0; i < 2; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  const rec = (...c: unknown[]) => tg.calls.push(c);
  const wa: Record<string, unknown> = {
    initData: o.initData ?? "query_id=1&hash=abc",
    initDataUnsafe: {},
    version: tg.version,
    platform: tg.platform,
    colorScheme: o.colorScheme ?? "light",
    themeParams: {},
    isExpanded: true,
    viewportHeight: 844,
    viewportStableHeight: 844,
    safeAreaInset: { ...ZERO },
    contentSafeAreaInset: { ...ZERO },
    isFullscreen: false,
    isVersionAtLeast: (v: string) => cmp(tg.version, v) >= 0,
    onEvent: (ev: string, h: Handler) => {
      if (!tg.handlers.has(ev)) tg.handlers.set(ev, new Set());
      tg.handlers.get(ev)!.add(h);
    },
    offEvent: (ev: string, h: Handler) => tg.handlers.get(ev)?.delete(h),
    ready: () => rec("ready"),
    expand: () => rec("expand"),
    disableVerticalSwipes: () => rec("disableVerticalSwipes"),
    setHeaderColor: (c: string) => rec("setHeaderColor", c),
    setBackgroundColor: (c: string) => rec("setBackgroundColor", c),
    setBottomBarColor: (c: string) => rec("setBottomBarColor", c),
    MainButton: { setParams: vi.fn(), onClick: vi.fn(), offClick: vi.fn(), show: vi.fn(), hide: vi.fn(), showProgress: vi.fn(), hideProgress: vi.fn() },
    BackButton: { onClick: vi.fn(), offClick: vi.fn(), show: vi.fn(), hide: vi.fn() },
    HapticFeedback: { impactOccurred: vi.fn(), notificationOccurred: vi.fn(), selectionChanged: vi.fn() },
  };
  if (o.fullscreenMethods !== false) {
    wa.requestFullscreen = () => {
      rec("requestFullscreen");
      if (tg.onFullscreen === "throw") throw new Error("WebAppMethodUnsupported");
      if (tg.onFullscreen === "unsupported") {
        setTimeout(() => tg.emit("fullscreenFailed", { error: "UNSUPPORTED" }), 0);
        return;
      }
      wa.isFullscreen = true;
      if (o.fullscreenInsets) {
        wa.safeAreaInset = o.fullscreenInsets.safe;
        wa.contentSafeAreaInset = o.fullscreenInsets.content;
      }
      setTimeout(() => {
        tg.emit("fullscreenChanged");
        tg.emit("safeAreaChanged");
        tg.emit("contentSafeAreaChanged");
      }, 0);
    };
    wa.exitFullscreen = () => rec("exitFullscreen");
  }
  if (o.methods !== false) {
    wa.checkHomeScreenStatus = (cb?: (s: TgHomeScreenStatus) => void) => {
      rec("checkHomeScreenStatus");
      if (tg.status !== null) setTimeout(() => cb?.(tg.status!), 0);
    };
    wa.addToHomeScreen = () => {
      rec("addToHomeScreen");
      if (tg.onAdd === "throw") throw new Error("WebAppMethodUnsupported");
      if (tg.onAdd === "silent") return;
      if (tg.onAdd === "failed") {
        setTimeout(() => tg.emit("homeScreenFailed", { error: "UNSUPPORTED" }), 0);
        return;
      }
      tg.added += 1;
      tg.status = "added";
      setTimeout(() => (tg.onAdd === "event" ? tg.emit("homeScreenAdded") : tg.emit("homeScreenChecked", { status: "added" })), 0);
    };
  }
  if (o.cloudStorage !== false) {
    const cs = {
      getItem: (k: string, cb: (e: string | null, v?: string) => void) => {
        rec("CloudStorage.getItem", k);
        setTimeout(() => cb(null, tg.cloud.get(k) ?? ""), 0);
        return cs;
      },
      setItem: (k: string, v: string, cb?: (e: string | null, ok?: boolean) => void) => {
        rec("CloudStorage.setItem", k, v);
        tg.cloud.set(k, v);
        setTimeout(() => cb?.(null, true), 0);
        return cs;
      },
      removeItem: (k: string, cb?: (e: string | null, ok?: boolean) => void) => {
        tg.cloud.delete(k);
        setTimeout(() => cb?.(null, true), 0);
        return cs;
      },
    };
    wa.CloudStorage = cs;
  }
  tg.wa = wa;
  (window as unknown as { Telegram: unknown }).Telegram = { WebApp: wa };
  return tg;
}

export function uninstallTg(): void {
  delete (window as unknown as { Telegram?: unknown }).Telegram;
}

export const listenerCount = (tg: FakeTg, ev?: string) =>
  ev ? (tg.handlers.get(ev)?.size ?? 0) : [...tg.handlers.values()].reduce((n, s) => n + s.size, 0);
