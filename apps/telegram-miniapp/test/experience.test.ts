import { afterEach, describe, expect, it } from "vitest";
import { FALLBACK_CONFIG, REMOTE_STYLE_ID, applyTheme, flag, homeSections, sanitizeTokenValue, sanitizeTokens, themeCss, validateConfig } from "../src/config/experience";

/** experience-config seed miniapp 1.0.0 (abridged) */
const SEED = {
  app: "miniapp",
  version: "1.0.0",
  theme: { id: "notebook", version: "1.0.0", tokens: { "--paper": "#FBFCFE", "--pen": "#2F4BE0", "--scrim": "rgba(18,22,44,.45)", "--r-card": "14px", "--gutter": "18px", "--font-hand": "Caveat" } },
  home: {
    sections: [
      { type: "today_plan", key: "today_plan", variant: "large", enabled: true },
      { type: "lesson_of_day", key: "lesson_of_day", variant: "large", enabled: true },
      { type: "review", key: "review", variant: "compact", enabled: true },
      { type: "whats_new", key: "whats_new", variant: "compact", enabled: true },
      { type: "family", key: "family", variant: "compact", enabled: false },
      { type: "news", key: "news", variant: "compact", enabled: true },
    ],
  },
  flags: { whats_new_on_login: true, news: true, family_invites: true, uz_ui: true, voice_lesson: false },
};

afterEach(() => {
  document.getElementById(REMOTE_STYLE_ID)?.remove();
});

describe("Remote Experience Config", () => {
  it("accepts the server shape 1.0.0 (theme notebook, TilHero sections, flags)", () => {
    const c = validateConfig(SEED)!;
    expect(c).not.toBeNull();
    expect(c.theme.id).toBe("notebook");
    expect(c.home.sections.map((s) => s.type)).toEqual(["today_plan", "lesson_of_day", "review", "whats_new", "family", "news"]);
    expect(homeSections(c)).toEqual(["today_plan", "lesson_of_day", "review", "whats_new", "news"]);
    expect(flag(c, "voice_lesson")).toBe(false);
    expect(flag(c, "news")).toBe(true);
    expect(flag(c, "unknown_flag")).toBe(true);
  });
  it("drops unknown sections and repeated types; unknown theme → notebook", () => {
    const c = validateConfig({
      ...SEED,
      theme: { ...SEED.theme, id: "bank" },
      home: { sections: [...SEED.home.sections, { type: "event_carousel", key: "x", variant: "large", enabled: true }, { type: "news", key: "news2", variant: "large", enabled: true }] },
    })!;
    expect(c.theme.id).toBe("notebook");
    expect(c.home.sections.filter((s) => s.type === "news")).toHaveLength(1);
    expect(c.home.sections.some((s) => (s.type as string) === "event_carousel")).toBe(false);
  });
  it("rejects payloads that are not a config", () => {
    expect(validateConfig(null)).toBeNull();
    expect(validateConfig({ version: "1" })).toBeNull();
    expect(validateConfig({ ...SEED, home: { sections: "x" } })).toBeNull();
  });
  it("sanitizes token values: colours, lengths, brand fonts only", () => {
    expect(sanitizeTokenValue("color", "#2F4BE0")).toBe("#2F4BE0");
    expect(sanitizeTokenValue("color", "red; background:url(x)")).toBeNull();
    expect(sanitizeTokenValue("length", "14px")).toBe("14px");
    expect(sanitizeTokenValue("length", "calc(1px+1px)")).toBeNull();
    expect(sanitizeTokenValue("font", "Onest")).toContain('"Onest"');
    expect(sanitizeTokenValue("font", "Comic Sans")).toBeNull();
    // idempotent: an already sanitised stack stays the same
    const onest = sanitizeTokenValue("font", "Onest")!;
    expect(sanitizeTokenValue("font", onest)).toBe(onest);
    expect(sanitizeTokens({ "--paper": "#fff", "--evil": "#000", "--pen": "var(--x)" })).toEqual({ "--paper": "#fff" });
  });
  it("notebook: remote colours apply to the light scheme only, lengths and fonts always", () => {
    const css = themeCss(validateConfig(SEED)!);
    expect(css).toContain(":root { --r-card: 14px; --gutter: 18px; --font-hand:");
    expect(css).toContain(':root:not([data-scheme="dark"]) { --paper: #FBFCFE; --pen: #2F4BE0; --scrim: rgba(18,22,44,.45); }');
  });
  it("notebook_dark pins its colours for every scheme; applying replaces the previous tokens", () => {
    const dark = validateConfig({ ...SEED, theme: { id: "notebook_dark", version: "1.1.0", tokens: { "--paper": "#11152B" } } })!;
    applyTheme(validateConfig(SEED)!);
    applyTheme(dark);
    const el = document.getElementById(REMOTE_STYLE_ID)!;
    expect(el.textContent).toBe(":root { --paper: #11152B; }");
    expect(document.documentElement.dataset.theme).toBe("notebook_dark");
    applyTheme(FALLBACK_CONFIG);
    expect(el.textContent).toBe("");
    expect(document.querySelectorAll(`#${REMOTE_STYLE_ID}`)).toHaveLength(1);
  });
});
