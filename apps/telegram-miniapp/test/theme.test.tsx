/**
 * Profile → «Тема»: «Как в Telegram» (default) / «Светлая» / «Тёмная». The choice wins over Telegram's colour scheme
 * and over the server's theme id; kept in Telegram CloudStorage (6.9+, key theme_pref) with a localStorage copy;
 * applied before the first render; the native header / background of Telegram are repainted after a change.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, themeCss, validateConfig } from "../src/config/experience";
import { I18nProvider } from "../src/i18n";
import { ThemeScreen } from "../src/screens/profile/ThemeScreen";
import { AppProvider, type AppCtx } from "../src/state/app";
import {
  LOCAL_PREFIX,
  THEME_PREF_KEY,
  bindTelegramEnvironment,
  getThemePref,
  parseThemePref,
  resetThemeForTests,
  resolveScheme,
  restoreThemePref,
  setPlatformScheme,
  setThemePref,
  themeStorageKind,
  type KvStore,
} from "../src/tg";
import { installTg, uninstallTg } from "./tgFake";

const root = document.documentElement;
const LOCAL_KEY = LOCAL_PREFIX + THEME_PREF_KEY;

function memStore(kind: KvStore["kind"], init: Record<string, string> = {}, delay = 0): KvStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  const later = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), delay));
  return {
    kind,
    data,
    get: (k) => later(data.get(k) ?? null),
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
  };
}

beforeEach(() => {
  resetThemeForTests();
  localStorage.clear();
  delete root.dataset.scheme;
  delete root.dataset.theme;
  delete root.dataset.themePref;
  document.getElementById("remote-theme")?.remove();
});
afterEach(() => uninstallTg());

describe("theme choice — rules", () => {
  it("parse and resolve: the user's choice wins, «Как в Telegram» follows Telegram", () => {
    expect(parseThemePref("dark")).toBe("dark");
    expect(parseThemePref("Dark")).toBeNull();
    expect(parseThemePref(null)).toBeNull();
    expect(resolveScheme("system", "dark")).toBe("dark");
    expect(resolveScheme("system", "light")).toBe("light");
    expect(resolveScheme("light", "dark")).toBe("light");
    expect(resolveScheme("dark", "light")).toBe("dark");
  });

  it("before the first render: the local copy is applied synchronously, then the CloudStorage copy wins", async () => {
    installTg({ colorScheme: "light" });
    localStorage.setItem(LOCAL_KEY, "dark");
    const cloud = memStore("cloud", { theme_pref: "light" }, 5);
    const local = memStore("local");
    const p = restoreThemePref({ cloud, local });
    // synchronously, before any await: no flash of the light notebook
    expect(root.dataset.scheme).toBe("dark");
    expect(root.dataset.theme).toBe("notebook_dark");
    expect(root.dataset.themePref).toBe("dark");
    expect(await p).toBe("light");
    expect(root.dataset.scheme).toBe("light");
    expect(local.data.get(THEME_PREF_KEY)).toBe("light");
  });

  it("nothing saved — «Как в Telegram» with Telegram's scheme; garbage in storage is ignored", async () => {
    installTg({ colorScheme: "dark" });
    localStorage.setItem(LOCAL_KEY, "purple");
    await restoreThemePref({ cloud: memStore("cloud", { theme_pref: "<script>" }), local: memStore("local") });
    expect(getThemePref()).toBe("system");
    expect(root.dataset.scheme).toBe("dark");
  });

  it("a choice made while CloudStorage is still answering is not overridden by the late answer", async () => {
    installTg({ colorScheme: "light" });
    const cloud = memStore("cloud", { theme_pref: "light" }, 20);
    const p = restoreThemePref({ cloud, local: memStore("local") });
    await setThemePref("dark", { cloud, local: memStore("local") });
    await p;
    expect(getThemePref()).toBe("dark");
    expect(root.dataset.scheme).toBe("dark");
  });

  it("«Как в Telegram» follows themeChanged; an explicit choice does not", () => {
    const tg = installTg({ colorScheme: "light" });
    const off = bindTelegramEnvironment();
    expect(root.dataset.scheme).toBe("light");
    tg.wa.colorScheme = "dark";
    tg.emit("themeChanged");
    expect(root.dataset.scheme).toBe("dark");
    void setThemePref("light", { cloud: memStore("cloud"), local: memStore("local") });
    tg.wa.colorScheme = "dark";
    tg.emit("themeChanged");
    expect(root.dataset.scheme).toBe("light");
    setPlatformScheme("light");
    expect(root.dataset.scheme).toBe("light");
    off();
  });

  it("inside Telegram 6.9+: stored in CloudStorage (key theme_pref) and the local copy; the native colours are repainted", async () => {
    const tg = installTg({ colorScheme: "light" });
    // the notebook paper of each scheme (ui-tokens are not loaded in jsdom)
    const style = document.createElement("style");
    style.textContent = ':root { --paper: #FBFCFE; --card: #FFFFFF; } :root[data-scheme="dark"] { --paper: #11152B; --card: #191E3B; }';
    document.head.appendChild(style);
    expect(themeStorageKind()).toBe("cloud");
    await setThemePref("dark");
    expect(tg.cloud.get("theme_pref")).toBe("dark");
    expect(localStorage.getItem(LOCAL_KEY)).toBe("dark");
    const header = tg.calls.filter((c) => c[0] === "setHeaderColor").map((c) => String(c[1]).toUpperCase());
    expect(header.at(-1)).toBe("#11152B");
    expect(tg.calls.filter((c) => c[0] === "setBackgroundColor").length).toBeGreaterThan(0);
    style.remove();
  });

  it("outside Telegram and on clients older than 6.9 — localStorage only", async () => {
    expect(themeStorageKind()).toBe("local");
    await setThemePref("light");
    expect(localStorage.getItem(LOCAL_KEY)).toBe("light");
    const old = installTg({ version: "6.2" });
    expect(themeStorageKind()).toBe("local");
    await setThemePref("dark");
    expect(old.cloud.size).toBe(0);
    expect(localStorage.getItem(LOCAL_KEY)).toBe("dark");
  });

  it("localStorage that throws (sandboxed webview) never breaks the app", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    await expect(setThemePref("dark")).resolves.toBeDefined();
    expect(root.dataset.scheme).toBe("dark");
    spy.mockRestore();
  });

  it("server theme notebook_dark does not override the user's «Светлая»; its colours tune the dark notebook only", async () => {
    const cfg = validateConfig({ version: "1.1.0", theme: { id: "notebook_dark", version: "1.1.0", tokens: { "--paper": "#11152B" } }, home: { sections: [] }, flags: {} })!;
    await setThemePref("light", { cloud: memStore("cloud"), local: memStore("local") });
    applyTheme(cfg);
    expect(root.dataset.scheme).toBe("light");
    expect(root.dataset.theme).toBe("notebook");
    expect(themeCss(cfg)).toBe(':root[data-scheme="dark"] { --paper: #11152B; }');
    await setThemePref("dark", { cloud: memStore("cloud"), local: memStore("local") });
    expect(root.dataset.theme).toBe("notebook_dark");
  });

  it("public/theme-boot.js applies the saved light / dark before the app (same key), leaves «Как в Telegram» to the app", () => {
    const src = readFileSync(join(__dirname, "../public/theme-boot.js"), "utf8");
    expect(src).toContain(`"${LOCAL_KEY}"`);
    localStorage.setItem(LOCAL_KEY, "dark");
    new Function(src)();
    expect(root.dataset.scheme).toBe("dark");
    expect(root.dataset.theme).toBe("notebook_dark");
    root.dataset.scheme = "light";
    localStorage.setItem(LOCAL_KEY, "system");
    new Function(src)();
    expect(root.dataset.scheme).toBe("light");
    const html = readFileSync(join(__dirname, "../index.html"), "utf8");
    expect(html.indexOf('src="/theme-boot.js"')).toBeGreaterThan(html.indexOf("telegram-web-app.js"));
    expect(html.indexOf('src="/theme-boot.js"')).toBeLessThan(html.indexOf("/src/main.tsx"));
  });
});

describe("Profile → «Тема» screen", () => {
  const ctx = { nav: { back: vi.fn() } } as unknown as AppCtx;
  const mount = (lang: "ru" | "uz" = "ru") =>
    render(
      <I18nProvider initial={lang}>
        <AppProvider value={ctx}>
          <ThemeScreen />
        </AppProvider>
      </I18nProvider>,
    );

  it("three choices, «Как в Telegram» by default; «Тёмная» switches at once and is kept in Telegram", async () => {
    const tg = installTg({ colorScheme: "light" });
    await act(async () => {
      await restoreThemePref();
    });
    mount();
    expect(screen.getByRole("heading", { name: "Тема" })).toBeInTheDocument();
    expect(screen.getByTestId("theme-system")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("theme-system")).toHaveTextContent("Как в Telegram");
    expect(screen.getByTestId("theme-light")).toHaveTextContent("Светлая");
    expect(screen.getByText(/тема будет такой же на других ваших устройствах/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("theme-dark"));
    expect(screen.getByTestId("theme-dark")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("theme-system")).toHaveAttribute("aria-pressed", "false");
    expect(root.dataset.scheme).toBe("dark");
    await vi.waitFor(() => expect(tg.cloud.get("theme_pref")).toBe("dark"));
    await userEvent.click(screen.getByTestId("theme-system"));
    expect(root.dataset.scheme).toBe("light");
    await vi.waitFor(() => expect(tg.cloud.get("theme_pref")).toBe("system"));
  });

  it("UZ texts; outside Telegram — «saved on this device»", () => {
    mount("uz");
    expect(screen.getByTestId("theme-system")).toHaveTextContent("Telegramdagidek");
    expect(screen.getByTestId("theme-dark")).toHaveTextContent("Qorongʻi");
    expect(screen.getByText("Tanlov shu qurilmada saqlandi.")).toBeInTheDocument();
  });
});
