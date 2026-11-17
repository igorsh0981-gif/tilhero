import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, FALLBACK_CONFIG, fetchExperience, sanitizeTokens, sanitizeTokenValue, validateConfig } from "../src/config/experience";
import { I18nProvider } from "../src/i18n";
import { draftFromPreferences, type PrefDraft } from "../src/state/prefs";
import { applyThemeParams, mainButtonStore, parseStartParam, popupStore, resolveBoot, showPopup, useMainButton } from "../src/tg";
import type { TgWebApp } from "../src/tg/types";
import { BudgetControl, DeparturesControl } from "../src/ui/prefControls";
import type { Api } from "../src/api/endpoints";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_FONTS_CSS, loadBrandFonts } from "../src/fonts";
import { makeFormatters } from "../src/i18n";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.scheme;
});

describe("deep links (start_param)", () => {
  it("parses sections and tickets", () => {
    expect(parseStartParam("events")).toEqual({ kind: "tab", tab: "catalog" });
    expect(parseStartParam("watch")).toEqual({ kind: "tab", tab: "watch" });
    expect(parseStartParam("profile")).toEqual({ kind: "tab", tab: "profile" });
    expect(parseStartParam("support")).toEqual({ kind: "supportList" });
    expect(parseStartParam("ticket_TCK-3081")).toEqual({ kind: "ticket", number: "TCK-3081" });
    expect(parseStartParam("ticket_tck-3081")).toEqual({ kind: "ticket", number: "TCK-3081" });
    expect(parseStartParam("evt_f1_auh_2026")).toEqual({ kind: "tab", tab: "catalog" });
  });
  it("rejects garbage", () => {
    for (const v of [null, "", "ticket_", "ticket_../x", "<script>", "a".repeat(80), "ticket_TCK-3081;drop"]) expect(parseStartParam(v)).toBeNull();
  });
});

describe("boot mode", () => {
  const wa = (initData: string) => ({ initData, initDataUnsafe: { start_param: "watch", user: { id: 1, first_name: "I", language_code: "en" } } }) as unknown as TgWebApp;
  it("inside Telegram uses the signed initData and start_param", () => {
    expect(resolveBoot({ wa: wa("signed"), isDev: false, devInitData: "", search: "" })).toEqual({ kind: "telegram", initData: "signed", startParam: "watch", languageCode: "en" });
  });
  it("dev build in a browser uses VITE_DEV_INIT_DATA and ?startapp=", () => {
    const init = `user=${encodeURIComponent(JSON.stringify({ id: 1, language_code: "ru" }))}&hash=x`;
    expect(resolveBoot({ wa: wa(""), isDev: true, devInitData: init, search: "?startapp=support" })).toEqual({ kind: "dev", initData: init, startParam: "support", languageCode: "ru" });
  });
  it("production outside Telegram → «Откройте TilHero в Telegram» (dev init data ignored)", () => {
    expect(resolveBoot({ wa: wa(""), isDev: false, devInitData: "x", search: "", navigatorLanguage: "en" })).toEqual({ kind: "outside", languageCode: "en" });
    expect(resolveBoot({ wa: null, isDev: false, devInitData: "", search: "" }).kind).toBe("outside");
  });
});

describe("Remote Experience Config", () => {
  it("applies only allow-listed tokens with valid values", () => {
    expect(
      sanitizeTokens({
        "--accent": "#8EF5C2",
        "--r-card": "14px",
        "--rail-w": ".8",
        "--font-display": "Manrope",
        "--bg": "url(https://evil)",
        "--ink": "red; } body { display:none",
        "--unknown": "#fff",
        "--surface": "var(--accent)",
        "--muted": 12,
      }),
    ).toEqual({ "--accent": "#8EF5C2", "--r-card": "14px", "--rail-w": ".8", "--font-display": '"Manrope", "Manrope Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' });
    expect(sanitizeTokenValue("color", "rgba(10, 20, 30, .5)")).toBe("rgba(10, 20, 30, .5)");
    expect(sanitizeTokenValue("font", "Comic Sans")).toBeNull();
    expect(sanitizeTokenValue("number", "42")).toBeNull();
  });

  it("validates the payload and drops unknown section types", () => {
    const c = validateConfig({
      version: "2.0.4",
      theme: { id: "evil", version: "2.0.4", tokens: {} },
      home: { welcome_mode: "nope", sections: [{ type: "event_carousel", key: "best_for_you", variant: "large", enabled: true }, { type: "script", key: "x", variant: "large", enabled: true }] },
      flags: { a: true, b: "yes" },
    });
    expect(c!.theme.id).toBe("default");
    expect(c!.home.welcome_mode).toBe("first_visit_only");
    expect(c!.home.sections.map((s) => s.key)).toEqual(["best_for_you"]);
    expect(c!.flags).toEqual({ a: true });
    expect(validateConfig({ nope: 1 })).toBeNull();
  });

  it("rollback: applying a previous version removes tokens of the newer one (AT-33)", () => {
    const root = document.documentElement;
    applyTheme({ ...FALLBACK_CONFIG, version: "2.0.2", theme: { id: "default", version: "2.0.2", tokens: { "--accent": "#8EF5C2", "--r-card": "14px" } } });
    expect(root.style.getPropertyValue("--accent")).toBe("#8EF5C2");
    expect(root.dataset.themeVersion).toBe("2.0.2");
    applyTheme({ ...FALLBACK_CONFIG, theme: { id: "bank", version: "2.0.3", tokens: { "--r-card": "16px" } } });
    expect(root.style.getPropertyValue("--accent")).toBe("");
    expect(root.style.getPropertyValue("--r-card")).toBe("16px");
    expect(root.dataset.theme).toBe("bank");
  });

  it("falls back to the bundled config on failure or timeout", async () => {
    await expect(fetchExperience(() => Promise.reject(new Error("503")))).resolves.toEqual({ config: FALLBACK_CONFIG, source: "local" });
    const slow = (signal: AbortSignal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("abort"))));
    await expect(fetchExperience(slow, 20)).resolves.toMatchObject({ source: "local" });
  });
});

describe("Telegram bridge", () => {
  it("themeParams → --tg-theme-* and colorScheme → data-scheme", () => {
    applyThemeParams({ bg_color: "#ffffff", button_color: "#2481cc", text_color: "javascript:x" }, "light");
    const s = document.documentElement.style;
    expect(s.getPropertyValue("--tg-theme-bg-color")).toBe("#ffffff");
    expect(s.getPropertyValue("--tg-theme-button-color")).toBe("#2481cc");
    expect(s.getPropertyValue("--tg-theme-text-color")).toBe("");
    expect(document.documentElement.dataset.scheme).toBe("light");
  });

  it("showPopup falls back to the in-app popup outside Telegram", async () => {
    const p = showPopup({ title: "PIN", message: "m", buttons: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }, { id: "d", text: "D" }] });
    const top = popupStore.top()!;
    expect(top.buttons).toHaveLength(4);
    top.resolve("c");
    await expect(p).resolves.toBe("c");
    expect(popupStore.top()).toBeNull();
  });

  it("MainButton: the latest registrant wins (screen → sheet) and the previous one is restored", () => {
    const screenClick = vi.fn();
    const sheetClick = vi.fn();
    const a = renderHook(() => useMainButton({ text: "Продолжить", onClick: screenClick }));
    expect(mainButtonStore.top()!.text).toBe("Продолжить");
    const b = renderHook(({ disabled }) => useMainButton({ text: "Сохранить", onClick: sheetClick, disabled }), { initialProps: { disabled: true } });
    expect(mainButtonStore.top()).toMatchObject({ text: "Сохранить", disabled: true });
    b.rerender({ disabled: false });
    mainButtonStore.top()!.onClick();
    expect(sheetClick).toHaveBeenCalledOnce();
    b.unmount();
    expect(mainButtonStore.top()!.text).toBe("Продолжить");
    a.unmount();
    expect(mainButtonStore.top()).toBeNull();
  });
});

function Harness({ children }: { children: (d: PrefDraft, set: (fn: (d: PrefDraft) => PrefDraft) => void) => React.ReactNode }) {
  const [d, setD] = useState<PrefDraft>(draftFromPreferences(null));
  return <I18nProvider initial="ru">{children(d, (fn) => setD((x) => fn(x)))}</I18nProvider>;
}

describe("preference controls", () => {
  it("custom budget: fixed $ prefix, typing letters keeps digits only", async () => {
    const user = userEvent.setup();
    render(<Harness>{(d, set) => <BudgetControl d={d} set={set} />}</Harness>);
    await user.click(screen.getByRole("button", { name: "Свой" }));
    expect(screen.getByText("$")).toBeInTheDocument();
    const input = screen.getByLabelText("Сумма в долларах");
    expect(screen.getByText("Введите сумму, например 1500")).toBeInTheDocument();
    await user.type(input, "1a5$0,0");
    expect(input).toHaveValue("1500");
    expect(screen.getByText("Только цифры, валюта — USD")).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "20");
    expect(screen.getByText("Не меньше $50")).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "250000");
    expect(screen.getByText("Не больше $100 000")).toBeInTheDocument();
  });

  it("departures start empty, add and remove from the directory", async () => {
    const user = userEvent.setup();
    const airports = vi.fn(async (q: string) => ({
      items: [
        { iata: "TAS", city: "Tashkent", country: "Uzbekistan", country_code: "UZ", name: "Tashkent Intl" },
        { iata: "SKD", city: "Samarkand", country: "Uzbekistan", country_code: "UZ", name: "Samarkand Intl" },
      ].filter((a) => !q || a.city.toLowerCase().includes(q.toLowerCase())),
    }));
    const api = { directory: { airports } } as unknown as Api;
    render(<Harness>{(d, set) => <DeparturesControl d={d} set={set} api={api} />}</Harness>);
    expect(screen.getByText("Пока ничего не выбрано — добавьте город")).toBeInTheDocument();
    const add = await screen.findByRole("button", { name: "Добавить Tashkent" });
    await user.click(add);
    expect(screen.getByText("выбрано: 1")).toBeInTheDocument();
    const removes = screen.getAllByRole("button", { name: "Удалить Tashkent" });
    expect(removes).toHaveLength(2); // tag × and the directory row
    await act(async () => {
      await user.click(removes[0]!);
    });
    expect(screen.getByText("Пока ничего не выбрано — добавьте город")).toBeInTheDocument();
    expect(airports).toHaveBeenCalledWith("", expect.anything());
  });
});

describe("fonts do not block rendering (review 🟡-11)", () => {
  const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
  it("index.html has no render-blocking font stylesheet, only preconnect + preload of the same URL", () => {
    expect(html).not.toMatch(/rel="stylesheet"[^>]*fonts\.googleapis/);
    expect(html).toMatch(/rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin/);
    const preload = /rel="preload"\s+as="style"\s+href="([^"]+)"/.exec(html);
    expect(preload?.[1]).toBe(BRAND_FONTS_CSS);
    expect(BRAND_FONTS_CSS).toContain("display=swap");
  });
  it("the stylesheet is attached once from the app script", () => {
    const a = loadBrandFonts(document);
    const b = loadBrandFonts(document);
    expect(a).toBe(b);
    expect(document.querySelectorAll("link[data-brand-fonts]")).toHaveLength(1);
    expect(a.rel).toBe("stylesheet");
    expect(a.href).toBe(BRAND_FONTS_CSS);
  });
  it("brand stacks start with the brand face, then its metric-matched fallback", () => {
    const tokens = readFileSync(join(__dirname, "..", "..", "..", "packages", "ui-tokens", "styles", "tokens.css"), "utf8");
    const base = readFileSync(join(__dirname, "..", "..", "..", "packages", "ui-tokens", "styles", "base.css"), "utf8");
    for (const f of ["Manrope", "Unbounded", "JetBrains Mono"]) {
      expect(tokens).toContain(`"${f}", "${f} Fallback"`);
      expect(base).toContain(`font-family: "${f} Fallback"`);
    }
  });
});

describe("money from the contract: decimal strings (review 🟠-4 / T3)", () => {
  it("formats without float arithmetic and rejects malformed values", () => {
    const ru = makeFormatters("ru");
    const en = makeFormatters("en");
    expect(en.usdDecimal("850.00")).toBe("$850");
    expect(en.usdDecimal("1250.5")).toBe("$1,250.50");
    expect(en.usdDecimal("0.30")).toBe("$0.30");
    expect(ru.usdDecimal("850.05")).toMatch(/^\$850,05$/);
    for (const bad of ["", "1e3", "-5.00", "850.001", "NaN", "0.30000000000000004"]) expect(en.usdDecimal(bad), bad).toBe("");
    expect(en.usdDecimal(850 as unknown as string)).toBe("");
  });
});
