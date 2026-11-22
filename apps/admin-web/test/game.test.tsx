/**
 * Sprint 6 logic of «Игра»: routes; the rules form (numbers as text, parse with paths, the client mirror of the
 * validator — errors and warnings, normalised server paths, the diff, the activation gate); hero drafts (the form from
 * the draft or the live version, checks, the live ↔ draft comparison, the publish gate); pictures by their bytes (PNG
 * IHDR, WebP VP8X / VP8L / VP8, size and dimensions); shop items (checks per status, the PATCH of a published item);
 * events (period ≤ 14 days, multipliers, overlap); wallets (a manual operation, reversals, actors); the raw upload of
 * the API client; the overview block and the commands hidden without their permissions.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminGameEvent, AdminHero, AdminLedgerOperation, AdminShopItem, AdminWallet, Dashboard, GameRules, Permission } from "@tilhero/contracts/admin";
import { AdminApi, api } from "../src/api/client";
import { I18nProvider, translate } from "../src/i18n";
import { SessionCtx, type Session } from "../src/state/session";
import { ToastProvider } from "../src/ui/toasts";
import { Overview } from "../src/screens/overview/Overview";
import { WalletTab, badgeName } from "../src/screens/game/WalletTab";
import { orderedItems } from "../src/state/nav";
import { ConfirmCommand } from "../src/ui/overlays";
import * as G from "../src/screens/game/model";

const RULES = (): GameRules => ({
  earn: {
    lesson: { xp: 20, til: 5 },
    lesson_passed_bonus: { xp: 10, til: 0 },
    lesson_practice: { xp: 10, til: 2 },
    scenario: { xp: 15, til: 4 },
    media: { xp: 10, til: 3 },
    reading: { xp: 10, til: 3 },
    review: { min_cards: 5, xp_base: 10, xp_per_correct_cap: 20, til: 3 },
    skill_demonstrated: { xp: 15, til: 5 },
    skill_retained: { xp: 25, til: 10 },
    skill_max_per_event: 10,
  },
  caps: { xp_per_day: 300, til_per_day: 60 },
  levels: [0, 100, 250, 450, 700],
  hero: { stage_thresholds: [0, 5, 15] },
  freeze: { price_til: 40, max_stock: 5 },
  bonuses: { registration_freeze: 2, referral_freeze: 2, referral_monthly_cap: 10 },
  quests: {
    per_day: 3,
    all_done_bonus: { xp: 10, til: 10 },
    templates: [
      { code: "lesson_1", kind: "lesson_complete", target: 1, reward: { xp: 10, til: 5 }, audiences: ["kids", "teens", "adults"], weight: 3 },
      { code: "review_10", kind: "review_cards", target: 10, reward: { xp: 10, til: 5 }, audiences: ["kids", "teens", "adults"], weight: 3 },
      { code: "reading_1", kind: "reading_complete", target: 1, reward: { xp: 10, til: 5 }, audiences: ["kids", "teens", "adults"], weight: 2 },
      { code: "xp_50", kind: "xp_earned", target: 50, reward: { xp: 0, til: 5 }, audiences: ["teens", "adults"], weight: 2 },
    ],
  },
  badges: { streak: [7, 30, 100], skills: [10, 50], reviews_cards: [100, 1000], readings: [10] },
});
const codes = (xs: G.Issue[]) => xs.map((x) => `${G.normPath(x.path)}:${x.code}`);
const UID = "a1000000-0000-4000-8000-000000000001";
const PID = "c1000000-0000-4000-8000-0000000000f1";
const PID2 = "c1000000-0000-4000-8000-0000000000b2";

describe("routes", () => {
  it("#/game tabs: rules version, shop item / new, wallet by UUID; garbage is dropped", () => {
    expect(G.parseGameRoute(null)).toEqual({ tab: null, id: null });
    expect(G.parseGameRoute("rules")).toEqual({ tab: "rules", id: null });
    expect(G.parseGameRoute("rules/12")).toEqual({ tab: "rules", id: "12" });
    expect(G.parseGameRoute("rules/x")).toEqual({ tab: "rules", id: null });
    expect(G.parseGameRoute("shop/new")).toEqual({ tab: "shop", id: "new" });
    expect(G.parseGameRoute("shop/frame_gold")).toEqual({ tab: "shop", id: "frame_gold" });
    expect(G.parseGameRoute(`wallets/${UID.toUpperCase()}`)).toEqual({ tab: "wallets", id: UID });
    expect(G.parseGameRoute("wallets/nope")).toEqual({ tab: "wallets", id: null });
    expect(G.parseGameRoute("bogus")).toEqual({ tab: null, id: null });
    expect(G.parseItemRoute("pet_1", G.HERO_CODE_RE)).toBe("pet_1");
    expect(G.parseItemRoute("dragon", G.HERO_CODE_RE)).toBeNull();
    expect(G.parseItemRoute("new", G.EVENT_ROUTE_RE)).toBe("new");
  });
  it("the experience-config id game_events is the events section", () => {
    expect(orderedItems([{ id: "game_events", enabled: true }])[0]!.id).toBe("events");
  });
});

describe("rules form", () => {
  it("numbers travel as text and back; an empty or non-integer value is a problem at its path", () => {
    const f = G.rulesForm(RULES());
    expect(f.earn.lesson.xp).toBe("20");
    expect(f.quests.templates[0]!.code).toBe("lesson_1");
    expect(f.quests.templates[0]!.audiences).toEqual(["kids", "teens", "adults"]);
    expect(G.parseRules(f)).toEqual({ rules: RULES(), issues: [] });
    const bad = G.setAt(G.setAt(G.setAt(f, "earn.lesson.xp", ""), "levels[2]", "2.5"), "caps.til_per_day", "-1");
    expect(codes(G.parseRules(bad).issues)).toEqual(["earn.lesson.xp:required", "caps.til_per_day:negative", "levels[2]:not_integer"]);
  });
  it("setAt / getAt address nested objects and arrays immutably", () => {
    const f = G.rulesForm(RULES());
    const g = G.setAt(f, "quests.templates[1].reward.til", "9");
    expect(G.getAt(g, "quests.templates[1].reward.til")).toBe("9");
    expect(G.getAt(f, "quests.templates[1].reward.til")).toBe("5");
    expect(g.levels).toBe(f.levels);
  });
  it("the seed rules pass the client validator; the 2nd stage above 10 is only a warning", () => {
    const ok = G.checkRules(G.rulesForm(RULES()), RULES());
    expect(ok.errors).toEqual([]);
    expect(ok.warnings).toEqual([]);
    const r = RULES();
    r.hero.stage_thresholds = [0, 12, 30];
    expect(codes(G.checkRules(G.rulesForm(r)).warnings)).toEqual(["hero.stage_thresholds[1]:stage2_high"]);
  });
  it("levels: first 0, strictly increasing, 2..100; stages: exactly 3 increasing from 0", () => {
    const r = RULES();
    r.levels = [10, 100, 100];
    r.hero.stage_thresholds = [1, 5, 5];
    expect(codes(G.checkRules(G.rulesForm(r)).errors)).toEqual(["levels[0]:first_zero", "levels[2]:not_increasing", "hero.stage_thresholds[0]:first_zero", "hero.stage_thresholds[2]:not_increasing"]);
    r.levels = [0];
    expect(codes(G.checkRules(G.rulesForm(r)).errors)).toContain("levels:length");
  });
  it("caps not below the largest single award (review: base + the cap of correct answers)", () => {
    expect(G.maxSingleAward(RULES(), "xp")).toBe(30);
    expect(G.maxSingleAward(RULES(), "til")).toBe(10);
    const r = RULES();
    r.caps = { xp_per_day: 29, til_per_day: 9 };
    expect(codes(G.checkRules(G.rulesForm(r)).errors)).toEqual(["caps.xp_per_day:caps_below_reward", "caps.til_per_day:caps_below_reward"]);
  });
  it("quests: templates per audience ≥ per_day, unique codes, known kinds, audiences and weight 1..10", () => {
    const r = RULES();
    r.quests.per_day = 4;
    r.quests.templates[1]!.code = "lesson_1";
    r.quests.templates[2]!.kind = "dance" as never;
    r.quests.templates[3]!.weight = 11;
    r.quests.templates[3]!.audiences = [];
    expect(codes(G.checkRules(G.rulesForm(r)).errors)).toEqual([
      "quests.templates[1].code:duplicate",
      "quests.templates[2].kind:unknown_kind",
      "quests.templates[3].audiences:audiences_empty",
      "quests.templates[3].weight:range",
      "quests.templates:per_audience_kids",
      "quests.templates:per_audience_teens",
      "quests.templates:per_audience_adults",
    ]);
  });
  it("freeze, bonuses and badges ranges; a reward more than ×2 the active one is a warning", () => {
    const r = RULES();
    r.freeze = { price_til: 0, max_stock: 31 };
    r.bonuses.referral_monthly_cap = 101;
    r.badges.streak = [7, 7];
    r.earn.reading = { xp: 21, til: 3 };
    const c = G.checkRules(G.rulesForm(r), RULES());
    expect(codes(c.errors)).toEqual(["freeze.price_til:range", "freeze.max_stock:range", "bonuses.referral_monthly_cap:range", "badges.streak[1]:not_increasing"]);
    expect(codes(c.warnings)).toEqual(["earn.reading.xp:reward_growth"]);
  });
  it("server paths are normalised (pydantic loc «a.2.b» = «a[2].b»); issues of a section are found below it", () => {
    expect(G.normPath("quests.templates.2.reward.til")).toBe("quests.templates[2].reward.til");
    expect(G.normPath("payload.levels.3")).toBe("levels[3]");
    const xs = [{ path: "quests.templates.2.code", code: "duplicate" }, { path: "levels.1", code: "not_increasing" }];
    expect(G.issuesAt(xs, "quests.templates[2].code")).toHaveLength(1);
    expect(G.issuesUnder(xs, "quests")).toHaveLength(1);
    expect(G.fieldId("gr", "quests.templates.2.reward.til")).toBe("gr-quests-templates-2-reward-til");
  });
  it("the diff lists changed leaves; a changed list of numbers of another length is one row", () => {
    const b = RULES();
    b.earn.reading.til = 5;
    b.levels = [...b.levels, 1000];
    expect(G.diffValues(RULES(), b)).toEqual([
      { path: "earn.reading.til", from: 3, to: 5 },
      { path: "levels", from: [0, 100, 250, 450, 700], to: [0, 100, 250, 450, 700, 1000] },
    ]);
    expect(G.diffValues(RULES(), RULES())).toEqual([]);
    expect(G.showValue([1, 2])).toBe("1, 2");
    expect(G.showValue(null)).toBe("—");
  });
  it("activation gate: unsaved → invalid → not validated after the last save → ready", () => {
    const d = { status: "draft" as const, updated_at: "2026-11-20T10:00:00Z", validated_at: null as string | null };
    expect(G.activationGate(null, false, 0, null)).toBe("no_draft");
    expect(G.activationGate(d, true, 0, null)).toBe("unsaved");
    expect(G.activationGate(d, false, 2, null)).toBe("invalid");
    expect(G.activationGate(d, false, 0, { ok: false, at: d.updated_at })).toBe("invalid");
    expect(G.activationGate(d, false, 0, null)).toBe("not_validated");
    expect(G.activationGate({ ...d, validated_at: "2026-11-20T09:00:00Z" }, false, 0, null)).toBe("not_validated");
    expect(G.activationGate({ ...d, validated_at: "2026-11-20T10:00:01Z" }, false, 0, { ok: true, at: d.updated_at })).toBeNull();
  });
  it("a new quest template gets a free code and safe defaults", () => {
    const t = G.newTemplate([{ code: "quest_1" }]);
    expect(t.code).toBe("quest_2");
    expect(t.audiences).toEqual(["kids", "teens", "adults"]);
  });
});

/* ---------------------------------------------------------------- heroes */

const img = (id: string) => ({ asset_id: id, sha256: "a".repeat(64), url: `/admin/v1/game/assets/${id}/content`, width: 362, height: 460, size: 21000 });
const hero = (p: Partial<AdminHero> = {}): AdminHero => ({
  code: "pet_0",
  line: "pet",
  order: 4,
  name: { ru: "Дракончик Мятик", uz: "Ajdarcha Yalpiz" },
  tagline: { ru: "Растёт вместе с тобой", uz: "Sen bilan birga oʻsadi" },
  audiences: ["kids", "teens", "adults"],
  stages: [1, 2, 3].map((s) => ({ stage: s as 1 | 2 | 3, name: { ru: `Ступень ${s}`, uz: `Bosqich ${s}` }, asset_id: `a${s}` })),
  version: 3,
  published_at: "2026-11-01T10:00:00Z",
  published_by: { staff_id: "s", name: "Тимур" },
  images: [1, 2, 3].map((s) => ({ stage: s as 1 | 2 | 3, image: img(`a${s}`) })),
  draft: null,
  learners: 182,
  ...p,
});

describe("hero drafts", () => {
  it("the form starts from the draft when there is one; the body trims texts", () => {
    const h = hero();
    expect(G.heroForm(h).stages.map((s) => s.asset_id)).toEqual(["a1", "a2", "a3"]);
    const d = { ...G.heroBody(G.heroForm(h)), stages: G.heroForm(h).stages.map((s, i) => (i === 1 ? { ...s, asset_id: "n2" } : s)), images: [], updated_at: "2026-11-20T10:00:00Z" };
    const withDraft = hero({ draft: d });
    expect(G.heroForm(withDraft).stages[1]!.asset_id).toBe("n2");
    expect(G.liveForm(withDraft).stages[1]!.asset_id).toBe("a2");
    expect(G.heroBody({ ...G.heroForm(h), name: { ru: "  Мятик ", uz: " Yalpiz " } }).name).toEqual({ ru: "Мятик", uz: "Yalpiz" });
  });
  it("checks: RU/UZ required and limits, UZ in Latin, a picture per stage; no audiences is allowed (hidden)", () => {
    const f = G.heroForm(hero());
    expect(G.checkHero({ ...f, audiences: [] })).toEqual([]);
    const bad = { ...f, name: { ru: "", uz: "Мятик" }, tagline: { ru: "x".repeat(81), uz: "ok" }, stages: f.stages.map((s, i) => (i === 2 ? { ...s, asset_id: "" } : s)) };
    expect(codes(G.checkHero(bad))).toEqual(["name.ru:required", "name.uz:uz_script", "tagline.ru:too_long", "stages[2].asset_id:required"]);
  });
  it("live ↔ draft: changed fields and pictures are marked", () => {
    const live = G.heroForm(hero());
    const draft = { ...live, audiences: ["kids" as const], stages: live.stages.map((s, i) => (i === 0 ? { ...s, asset_id: "new" } : s)) };
    const changed = G.heroDiff(live, draft).filter((r) => r.changed).map((r) => r.key);
    expect(changed).toEqual(["audiences", "stages[0].asset_id"]);
  });
  it("publish gate: unsaved edits, no draft, problems", () => {
    expect(G.heroGate(hero(), true, 0)).toBe("unsaved");
    expect(G.heroGate(hero(), false, 0)).toBe("no_draft");
    const h = hero({ draft: { ...G.heroBody(G.heroForm(hero())), images: [], updated_at: "x" } });
    expect(G.heroGate(h, false, 1)).toBe("invalid");
    expect(G.heroGate(h, false, 0)).toBeNull();
  });
});

/* ---------------------------------------------------------------- pictures */

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
function webp(chunk: "VP8X" | "VP8L" | "VP8 ", w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  const s = (o: number, t: string) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  s(0, "RIFF");
  s(8, "WEBP");
  s(12, chunk);
  const dv = new DataView(b.buffer);
  if (chunk === "VP8X") {
    dv.setUint16(24, (w - 1) & 0xffff, true);
    b[26] = ((w - 1) >> 16) & 0xff;
    dv.setUint16(27, (h - 1) & 0xffff, true);
    b[29] = ((h - 1) >> 16) & 0xff;
  } else if (chunk === "VP8L") {
    b[20] = 0x2f;
    dv.setUint32(21, ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), true);
  } else {
    b.set([0x9d, 0x01, 0x2a], 23);
    dv.setUint16(26, w, true);
    dv.setUint16(28, h, true);
  }
  return b;
}

describe("pictures by their bytes", () => {
  it("PNG IHDR and the three WebP headers give type and size", () => {
    expect(G.sniffImage(png(300, 380))).toEqual({ type: "image/png", width: 300, height: 380 });
    expect(G.sniffImage(webp("VP8X", 362, 460))).toEqual({ type: "image/webp", width: 362, height: 460 });
    expect(G.sniffImage(webp("VP8L", 128, 64))).toEqual({ type: "image/webp", width: 128, height: 64 });
    expect(G.sniffImage(webp("VP8 ", 200, 100))).toEqual({ type: "image/webp", width: 200, height: 100 });
    expect(G.sniffImage(new TextEncoder().encode("GIF89a........................"))).toBeNull();
  });
  it("a seed picture of gamification is recognised (VP8X 362×460)", () => {
    const f = resolve(__dirname, "../../../services/gamification/migrations/seed/heroes/pet_0_1.webp");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(f));
    } catch {
      return; // the seed is not in this checkout — the synthetic headers above cover the parser
    }
    expect(G.checkImage({ name: "pet_0_1.webp", size: bytes.length }, bytes.subarray(0, 64))).toEqual({ ok: true, type: "image/webp", width: 362, height: 460 });
  });
  it("rejects by extension, emptiness, size, signature (a renamed file) and dimensions", () => {
    expect(G.checkImage({ name: "a.gif", size: 10 }, png(1, 1))).toEqual({ ok: false, reason: "type" });
    expect(G.checkImage({ name: "a.png", size: 0 }, png(1, 1))).toEqual({ ok: false, reason: "empty" });
    expect(G.checkImage({ name: "a.png", size: 300 * 1024 + 1 }, png(1, 1))).toEqual({ ok: false, reason: "size" });
    expect(G.checkImage({ name: "a.webp", size: 100 }, png(10, 10))).toEqual({ ok: false, reason: "signature" });
    expect(G.checkImage({ name: "a.png", size: 100 }, png(1025, 10))).toEqual({ ok: false, reason: "dims" });
    expect(G.checkImage({ name: "A.PNG", size: 100 }, png(1024, 1024))).toEqual({ ok: true, type: "image/png", width: 1024, height: 1024 });
  });
  it("a chosen file: extension and size first (an oversized file is never read), then only its first 64 bytes", async () => {
    const fake = (name: string, size: number, bytes: Uint8Array) => {
      const slice = vi.fn((a: number, b: number) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer }));
      return { file: { name, size, slice }, slice };
    };
    const big = fake("huge.png", 50 * 1024 * 1024, png(10, 10));
    expect(await G.inspectImageFile(big.file)).toEqual({ ok: false, reason: "size" });
    expect(big.slice).not.toHaveBeenCalled();
    const gif = fake("a.gif", 10, png(1, 1));
    expect(await G.inspectImageFile(gif.file)).toEqual({ ok: false, reason: "type" });
    expect(gif.slice).not.toHaveBeenCalled();
    const fine = fake("pet.png", 2048, png(362, 460));
    expect(await G.inspectImageFile(fine.file)).toEqual({ ok: true, type: "image/png", width: 362, height: 460 });
    expect(fine.slice).toHaveBeenCalledTimes(1);
    expect(fine.slice).toHaveBeenCalledWith(0, 64);
    const wide = fake("wide.png", 2048, png(2000, 10));
    expect(await G.inspectImageFile(wide.file)).toEqual({ ok: false, reason: "dims" });
  });
});

/* ---------------------------------------------------------------- shop */

const item = (p: Partial<AdminShopItem> = {}): AdminShopItem => ({
  code: "frame_gold",
  kind: "hero_frame",
  title: { ru: "Золотая рамка", uz: "Oltin ramka" },
  description: { ru: "", uz: "" },
  image: img("f1"),
  theme: null,
  price_til: 300,
  audiences: ["teens", "adults"],
  available_from: null,
  available_until: null,
  status: "draft",
  order: 20,
  owners: 0,
  updated_at: "2026-11-20T10:00:00Z",
  ...p,
});

describe("time of the game: the Tashkent wall clock ↔ UTC (whatever the zone of the browser)", () => {
  it("datetime-local in Asia/Tashkent ↔ ISO UTC", () => {
    expect(G.GAME_TZ).toBe("Asia/Tashkent");
    expect(G.toZoneInput("2026-11-23T05:30:00Z")).toBe("2026-11-23T10:30");
    expect(G.fromZoneInput("2026-11-23T10:30")).toBe("2026-11-23T05:30:00.000Z");
    expect(G.fromZoneInput("2026-11-24T00:00")).toBe("2026-11-23T19:00:00.000Z");
    expect(G.fromZoneInput(G.toZoneInput("2026-12-31T22:15:00Z"))).toBe("2026-12-31T22:15:00.000Z");
    expect(G.fromZoneInput("")).toBeNull();
    expect(G.fromZoneInput("23.11.2026")).toBeNull();
    expect(G.fromZoneInput("2026-02-30T10:00")).toBeNull();
    expect(G.toZoneInput(null)).toBe("");
  });
  it("another zone with DST: a summer offset, a non-existent spring hour", () => {
    expect(G.toZoneInput("2026-07-01T00:00:00Z", "Europe/Berlin")).toBe("2026-07-01T02:00");
    expect(G.fromZoneInput("2026-07-01T02:00", "Europe/Berlin")).toBe("2026-07-01T00:00:00.000Z");
    expect(G.fromZoneInput("2026-01-15T02:00", "Europe/Berlin")).toBe("2026-01-15T01:00:00.000Z");
    expect(G.fromZoneInput("2026-03-29T02:30", "Europe/Berlin")).toBeNull();
  });
  it("shown on the Tashkent clock in the language of the interface", () => {
    expect(G.zoneDateTime("ru", "2026-11-23T19:00:00Z")).toBe("24.11.2026 00:00");
    expect(G.zoneDateTime("ru", null)).toBe("");
  });
});

describe("shop items", () => {
  it("create: code, RU/UZ title and description, price 1..10000, audiences, a picture or theme tokens, the sale window", () => {
    const f = { ...G.emptyItemForm(), code: "Bad Code", price: "0", audiences: [], look: "image" as const, from: "2026-12-10T00:00", until: "2026-12-01T00:00" };
    expect(codes(G.checkItem(f, "create"))).toEqual(["code:code_format", "title.ru:required", "description.ru:required", "title.uz:required", "description.uz:required", "price_til:price_range", "audiences:audiences_empty", "asset_id:required", "available_until:until_before_from"]);
    const ok = { ...G.emptyItemForm(), code: "bg_mint", title: { ru: "Мята", uz: "Yalpiz" }, description: { ru: "Мятный фон", uz: "Yalpiz fon" } };
    expect(G.checkItem(ok, "create")).toEqual([]);
    expect(G.itemBody(ok)).toMatchObject({ code: "bg_mint", kind: "background", asset_id: null, theme: { bg: "--paper", accent: "--pen" }, price_til: 100, available_from: null });
    // the sale window is entered on the Tashkent clock and saved in UTC
    expect(G.itemBody({ ...ok, from: "2026-12-01T00:00" }).available_from).toBe("2026-11-30T19:00:00.000Z");
  });
  it("theme: the background only a light token, the accent only a saturated one", () => {
    const ok = { ...G.emptyItemForm(), code: "bg_mint", title: { ru: "Мята", uz: "Yalpiz" }, description: { ru: "Мятный фон", uz: "Yalpiz fon" } };
    expect(codes(G.checkItem({ ...ok, bg: "#fff" }, "create"))).toEqual(["theme.bg:token_bg"]);
    expect(codes(G.checkItem({ ...ok, bg: "--ink" }, "create"))).toEqual(["theme.bg:token_bg"]);
    expect(codes(G.checkItem({ ...ok, accent: "--paper" }, "create"))).toEqual(["theme.accent:token_accent"]);
    expect(codes(G.checkItem({ ...ok, accent: "--pen-soft" }, "create"))).toEqual(["theme.accent:token_accent"]);
    for (const bg of G.BG_TOKENS) for (const accent of G.ACCENT_TOKENS) expect(G.checkItem({ ...ok, bg, accent }, "create")).toEqual([]);
  });
  it("PATCH: a draft sends what changed; a published item only the end of sale and the order; retired — nothing", () => {
    const d = item();
    expect(G.itemPatch(d, G.itemFormOf(d))).toBeNull();
    expect(G.itemPatch(d, { ...G.itemFormOf(d), price: "250", order: "5" })).toEqual({ price_til: 250, order: 5 });
    const p = item({ status: "published" });
    expect(G.itemPatch(p, { ...G.itemFormOf(p), price: "1", order: "7", until: "2026-12-31T23:00" })).toEqual({ available_until: "2026-12-31T18:00:00.000Z", order: 7 });
    expect(G.checkItem({ ...G.itemFormOf(p), price: "0" }, "published")).toEqual([]);
    expect(G.itemPatch(item({ status: "retired" }), G.itemFormOf(item()))).toBeNull();
  });
  it("on sale: published and inside the window", () => {
    const now = Date.parse("2026-11-20T10:00:00Z");
    expect(G.onSale(item({ status: "published" }), now)).toBe(true);
    expect(G.onSale(item({ status: "draft" }), now)).toBe(false);
    expect(G.onSale(item({ status: "published", available_from: "2026-11-21T00:00:00Z" }), now)).toBe(false);
    expect(G.onSale(item({ status: "published", available_until: "2026-11-20T09:00:00Z" }), now)).toBe(false);
  });
  it("the theme tokens are colour tokens of the Mini App allowlist (packages/ui-tokens/token-names.json)", () => {
    const names = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/ui-tokens/token-names.json"), "utf8")) as { tokens: Record<string, string> };
    for (const t of [...G.BG_TOKENS, ...G.ACCENT_TOKENS]) expect(names.tokens[t], t).toBe("color");
  });
  it("the preview uses the Mini App colours (the light «notebook» theme); backgrounds are light, accents saturated", () => {
    const css = readFileSync(resolve(__dirname, "../../../packages/ui-tokens/styles/themes/notebook.css"), "utf8");
    const light = /:root\s*\{([\s\S]*?)\}/.exec(css)![1]!;
    const value = (name: string) => new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})\\s*;`).exec(light)?.[1]?.toUpperCase();
    for (const t of [...G.BG_TOKENS, ...G.ACCENT_TOKENS]) expect(G.MINIAPP_COLORS[t]?.toUpperCase(), t).toBe(value(t));
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    for (const t of G.BG_TOKENS) expect(lum(G.MINIAPP_COLORS[t]!), t).toBeGreaterThan(0.4);
    for (const t of G.ACCENT_TOKENS) expect(lum(G.MINIAPP_COLORS[t]!), t).toBeLessThan(0.2);
    expect(G.BG_TOKENS.filter((t) => (G.ACCENT_TOKENS as readonly string[]).includes(t))).toEqual([]);
  });
});

/* ---------------------------------------------------------------- events */

const ev = (p: Partial<AdminGameEvent> = {}): AdminGameEvent => ({
  event_id: "e1",
  code: "reading_week",
  title: { ru: "Неделя чтения", uz: "Oʻqish haftaligi" },
  description: { ru: "", uz: "" },
  starts_at: "2026-11-18T00:00:00Z",
  ends_at: "2026-11-25T00:00:00Z",
  audiences: ["kids", "teens", "adults"],
  multipliers: [{ action: "reading", currency: "xp", factor: 2 }],
  status: "published",
  created_by: { staff_id: "s", name: "Ольга" },
  published_by: null,
  updated_at: "2026-11-17T00:00:00Z",
  ...p,
});

describe("events of the week", () => {
  it("a new event: next Monday 00:00 → +7 days on the Tashkent clock, all audiences, «reading ×2 XP»", () => {
    const f = G.emptyEventForm(Date.parse("2026-11-20T10:00:00Z")); // Friday 15:00 in Tashkent
    expect(f.starts).toBe("2026-11-23T00:00");
    expect(f.ends).toBe("2026-11-30T00:00");
    expect(G.eventBody({ ...f, code: "c", title: { ru: "А", uz: "A" }, description: { ru: "Б", uz: "B" } })).toMatchObject({ starts_at: "2026-11-22T19:00:00.000Z", ends_at: "2026-11-29T19:00:00.000Z" });
    expect(f.multipliers).toEqual([{ action: "reading", currency: "xp", factor: 2 }]);
    expect(G.emptyEventForm(Date.parse("2026-11-23T04:00:00Z")).starts).toBe("2026-11-30T00:00"); // Monday → the next one
    // Sunday 20:00 UTC is already Monday 01:00 in Tashkent — the Tashkent clock decides
    expect(G.emptyEventForm(Date.parse("2026-11-22T20:00:00Z")).starts).toBe("2026-11-30T00:00");
  });
  it("checks: code, texts (title and description RU/UZ), the period ≤ 14 days and after its start, audiences, 1..5 unique multipliers", () => {
    const now = Date.parse("2026-11-20T10:00:00Z");
    const f = { ...G.emptyEventForm(now), code: "x", ends: "2026-12-10T00:00", audiences: [], multipliers: [{ action: "reading" as const, currency: "xp" as const, factor: 2 as const }, { action: "reading" as const, currency: "xp" as const, factor: 3 as const }] };
    expect(codes(G.checkEvent(f, "create", now).errors)).toEqual(["code:code_format", "title.ru:required", "description.ru:required", "title.uz:required", "description.uz:required", "ends_at:too_long_period", "audiences:audiences_empty", "multipliers[1]:duplicate"]);
    const back = { ...G.emptyEventForm(now), code: "ok_code", title: { ru: "А", uz: "A" }, description: { ru: "Б", uz: "B" }, ends: "2026-11-22T00:00" };
    expect(codes(G.checkEvent(back, "create", now).errors)).toEqual(["ends_at:ends_before_starts"]);
    const past = { ...back, starts: "2026-11-19T00:00", ends: "2026-11-22T00:00" };
    expect(codes(G.checkEvent(past, "draft", now).warnings)).toEqual(["starts_at:starts_past"]);
    expect(G.periodDays("2026-11-23T00:00:00Z", "2026-11-30T00:00:00Z")).toBe(7);
  });
  it("PATCH of a draft: only what changed; the code stays", () => {
    const d = ev({ status: "draft" });
    expect(G.eventPatch(d, G.eventFormOf(d))).toBeNull();
    const f = { ...G.eventFormOf(d), code: "renamed", multipliers: [{ action: "review" as const, currency: "til" as const, factor: 1.5 as const }] };
    expect(G.eventPatch(d, f)).toEqual({ multipliers: [{ action: "review", currency: "til", factor: 1.5 }] });
  });
  it("overlap: a published event, intersecting periods, a shared audience and the same action + currency", () => {
    const pub = ev();
    const kids = ev({ event_id: "e2", status: "draft", starts_at: "2026-11-21T00:00:00Z", ends_at: "2026-11-24T00:00:00Z", audiences: ["kids"] });
    expect(G.overlapping(kids, [pub, kids]).map((e) => e.event_id)).toEqual(["e1"]);
    expect(G.overlapping({ ...kids, multipliers: [{ action: "reading", currency: "til", factor: 2 }] }, [pub])).toEqual([]);
    expect(G.overlapping({ ...kids, starts_at: "2026-11-25T00:00:00Z", ends_at: "2026-11-27T00:00:00Z" }, [pub])).toEqual([]);
    expect(G.overlapping(kids, [ev({ status: "cancelled" })])).toEqual([]);
    expect(G.runningNow(pub, Date.parse("2026-11-20T00:00:00Z"))).toBe(true);
    expect(G.runningNow(pub, Date.parse("2026-11-26T00:00:00Z"))).toBe(false);
  });
});

/* ---------------------------------------------------------------- wallets */

const W = { xp_total: 355, til_balance: 105, freeze_stock: 3 };
const op = (p: Partial<AdminLedgerOperation> = {}): AdminLedgerOperation => ({
  op_id: "o1",
  currency: "til",
  amount: 25,
  reason: "manual",
  source: { kind: "staff", ref: "r" },
  rules_version: null,
  multiplier: 1,
  capped: false,
  local_date: "2026-11-20",
  status: "confirmed",
  reversed_by: null,
  reversal_of: null,
  actor: "staff:s1",
  comment: "Компенсация за сбой урока",
  created_at: "2026-11-20T10:00:00Z",
  ...p,
});

describe("wallets", () => {
  it("manual operation: amount 1..10000 (XP 1..100000), not below zero, reason 10..300; debit is negative", () => {
    const f = { ...G.emptyAdjust(), amount: "40", reason: "Компенсация по обращению TCK-1042" };
    expect(G.adjustmentBody(f, W)).toEqual({ body: { currency: "til", amount: 40, reason: "Компенсация по обращению TCK-1042" }, issues: [] });
    expect(G.adjustmentBody({ ...f, direction: "debit" }, W).body?.amount).toBe(-40);
    expect(codes(G.adjustmentBody({ ...f, direction: "debit", amount: "106" }, W).issues)).toEqual(["amount:below_zero"]);
    expect(codes(G.adjustmentBody({ ...f, amount: "10001" }, W).issues)).toEqual(["amount:amount_range"]);
    expect(G.adjustmentBody({ ...f, currency: "xp", amount: "100000" }, W).body?.amount).toBe(100000);
    expect(codes(G.adjustmentBody({ ...f, amount: "1.5", reason: "коротко" }, W).issues)).toEqual(["amount:amount_range", "reason:reason_short"]);
    expect(codes(G.adjustmentBody({ ...f, amount: "", reason: "x".repeat(301) }, W).issues)).toEqual(["amount:required", "reason:reason_long"]);
  });
  it("reversal: only a confirmed non-reversal operation; tils and freezes never below zero", () => {
    expect(G.canReverse(op())).toBe(true);
    expect(G.canReverse(op({ status: "reversed" }))).toBe(false);
    expect(G.canReverse(op({ reason: "reversal", reversal_of: "o0" }))).toBe(false);
    // a purchase is cancelled only by a refund (409 OPERATION_NOT_REVERSIBLE)
    expect(G.canReverse(op({ reason: "shop", amount: -40, source: { kind: "command", ref: PID } }))).toBe(false);
    expect(G.canReverse(op({ reason: "purchase", amount: -40 }))).toBe(false);
    expect(G.reversalBelowZero(op({ amount: 200 }), W)).toBe(true);
    expect(G.reversalBelowZero(op({ amount: 25 }), W)).toBe(false);
    expect(G.reversalBelowZero(op({ currency: "xp", amount: 1000 }), W)).toBe(false);
    expect(G.reversalBelowZero(op({ amount: -120 }), W)).toBe(false);
  });
  it("a shop operation leads to its purchase (source.ref = purchase_id): one «Вернуть покупку» per purchase, a freeze too", () => {
    const freezeTil = op({ op_id: "f1", reason: "shop", currency: "til", amount: -40, source: { kind: "command", ref: PID } });
    const freezeOne = op({ op_id: "f2", reason: "shop", currency: "freeze", amount: 1, source: { kind: "command", ref: PID } });
    const bg = op({ op_id: "b1", reason: "shop", amount: -120, source: { kind: "command", ref: PID2.toUpperCase() } });
    expect(G.purchaseOf(freezeTil)).toBe(PID);
    expect(G.purchaseOf(bg)).toBe(PID2);
    expect(G.purchaseOf(op())).toBeNull();
    expect(G.purchaseOf(op({ reason: "shop", status: "reversed", source: { kind: "command", ref: PID } }))).toBeNull();
    expect(G.purchaseOf(op({ reason: "shop", source: { kind: "command", ref: "not-a-uuid" } }))).toBeNull();
    expect([...G.refundAnchors([op(), freezeTil, freezeOne, bg]).entries()]).toEqual([
      ["f1", PID],
      ["b1", PID2],
    ]);
  });
  it("comments and reasons of every command: 10..300 characters", () => {
    expect(G.COMMENT_MIN).toBe(10);
    expect(G.COMMENT_MAX).toBe(300);
    expect(G.commentProblem("коротко")).toBe("reason_short");
    expect(G.commentProblem("  " + "x".repeat(10) + "  ")).toBeNull();
    expect(G.commentProblem("x".repeat(300))).toBeNull();
    expect(G.commentProblem("x".repeat(301))).toBe("reason_long");
  });
  it("problems of a domain 422: paths normalised, junk dropped", () => {
    expect(G.serverIssues({ errors: [{ path: "payload.title.uz", code: "uz_script" }, { path: "multipliers.1.factor", code: "factor" }, { nope: 1 }] })).toEqual([
      { path: "title.uz", code: "uz_script" },
      { path: "multipliers[1].factor", code: "factor" },
    ]);
    expect(G.serverIssues({})).toEqual([]);
    expect(G.serverIssues(null)).toEqual([]);
  });
  it("actors and signed amounts", () => {
    expect(G.actorOf("system")).toEqual({ kind: "system", id: null });
    expect(G.actorOf("staff:0b6c")).toEqual({ kind: "staff", id: "0b6c" });
    expect(G.signed(-40, String)).toBe("−40");
    expect(G.signed(5, String)).toBe("+5");
  });
  it("badge names: thresholds and single badges, unknown codes stay readable", () => {
    const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate("ru", k, v);
    expect(badgeName(t, "streak_7")).toBe("Серия 7 дней");
    expect(badgeName(t, "first_freeze")).toBe("Первая заморозка");
    expect(badgeName(t, "mystery")).toBe("mystery");
  });
});

/* ---------------------------------------------------------------- API client: raw upload */

describe("upload of a picture", () => {
  it("sends the bytes as a Blob of the image type with CSRF, not JSON", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = new AdminApi((async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ asset_id: "x" }), { status: 201, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch);
    c.setCsrf("csrf-9");
    await c.upload("/game/assets?purpose=hero_stage", png(10, 10), "image/png");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe("/admin/v1/game/assets?purpose=hero_stage");
    expect(h["Content-Type"]).toBe("image/png");
    expect(h["X-CSRF-Token"]).toBe("csrf-9");
    const b = calls[0]!.init.body as Blob;
    expect(b).toBeInstanceOf(Blob);
    expect(b.type).toBe("image/png");
    expect(b.size).toBe(33);
  });
});

/* ---------------------------------------------------------------- components */

type Handler = (method: string, path: string, body: unknown) => { status: number; body?: unknown } | undefined;
let handler: Handler = () => undefined;
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const path = url.pathname.replace("/admin/v1", "");
    const r = handler(init?.method ?? "GET", path, init?.body ? JSON.parse(String(init.body)) : undefined) ?? { status: 404, body: { code: "NOT_FOUND", message: "", trace_id: "", details: {} } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  });
  api.setCsrf("csrf-test");
  api.hooks = {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const session = (perms: Permission[]): Session => {
  const set = new Set(perms);
  return { me: null, can: (p) => set.has(p), canAny: (ps) => ps.some((p) => set.has(p)), refreshMe: async () => null, setMe: () => undefined, signOut: async () => undefined, reloadTheme: async () => undefined, themeVersion: null, adminLayout: null };
};
const ui = (node: ReactNode, perms: Permission[]) =>
  render(
    <I18nProvider initial="ru">
      <SessionCtx.Provider value={session(perms)}>
        <ToastProvider>{node}</ToastProvider>
      </SessionCtx.Provider>
    </I18nProvider>,
  );

const wallet: AdminWallet = {
  user_id: UID,
  audience: "adults",
  level: 3,
  xp_total: 355,
  til_balance: 105,
  freeze_stock: 3,
  hero: { code: "robot_0", stage: 2 },
  confirmed_skills: 7,
  owned_items: [{ code: "bg_night_notebook", kind: "background", purchased_at: "2026-11-17T10:00:00Z", purchase_id: "p1" }],
  quests_today: [{ code: "review_10", kind: "review_cards", target: 10, progress: 6, status: "active" }],
  badges: [{ code: "streak_7", earned_at: "2026-11-14T10:00:00Z" }],
  referrals: { pending: 1, rewarded: 2, capped: 0 },
  settings: { auto_freeze: true, quests_hidden: false },
};

describe("a command comment: 10..300 characters (ConfirmCommand)", () => {
  it("a reason longer than maxReason is refused with a text, the counter shows it, nothing is sent", async () => {
    const onConfirm = vi.fn(async () => null);
    ui(<ConfirmCommand title="T" ok="OK" minReason={10} maxReason={300} onConfirm={onConfirm} onClose={() => undefined} testId="cc" />, []);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "x".repeat(301) } });
    expect(screen.getByTestId("cmd-reason-count")).toHaveTextContent("301/300");
    fireEvent.click(screen.getByTestId("confirm-ok"));
    expect(await screen.findByText("Причина — не длиннее 300 символов")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "x".repeat(300) } });
    fireEvent.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("x".repeat(300)));
  });
});

describe("wallet screen by permission", () => {
  const routes: Handler = (_m, p) => {
    if (p === `/game/wallets/${UID}`) return { status: 200, body: wallet };
    if (p === `/game/wallets/${UID}/ledger`) return { status: 200, body: { items: [op()], next_cursor: null } };
    if (p === "/game/heroes") return { status: 200, body: { items: [] } };
    return undefined;
  };
  it("game.read only: balance, inventory and the ledger with the staff reason — no manual operation, reversal or refund", async () => {
    handler = routes;
    ui(<WalletTab userId={UID} />, ["game.read"]);
    expect(await screen.findByTestId("wl-til")).toHaveTextContent("105");
    expect(await screen.findByTestId("wl-op-o1")).toBeInTheDocument();
    expect(screen.getByTestId("wl-op-comment-o1")).toHaveTextContent("Компенсация за сбой урока");
    expect(screen.queryByTestId("wl-adjust")).toBeNull();
    expect(screen.queryByTestId("wl-reverse-o1")).toBeNull();
    expect(screen.queryByTestId("wl-refund-bg_night_notebook")).toBeNull();
    expect(screen.getByTestId("wl-ro")).toHaveTextContent("wallet.adjust");
  });
  it("wallet.adjust: the commands are offered", async () => {
    handler = routes;
    ui(<WalletTab userId={UID} />, ["game.read", "wallet.adjust"]);
    expect(await screen.findByTestId("wl-adjust")).toBeInTheDocument();
    expect(await screen.findByTestId("wl-reverse-o1")).toBeInTheDocument();
    expect(screen.getByTestId("wl-refund-bg_night_notebook")).toBeInTheDocument();
  });
  it("a shop operation is not reversed — its purchase is refunded (a freeze too), with the purchase operations named", async () => {
    const freezeTil = op({ op_id: "f1", reason: "shop", currency: "til", amount: -40, source: { kind: "command", ref: PID }, actor: "learner", comment: null });
    const freezeOne = op({ op_id: "f2", reason: "shop", currency: "freeze", amount: 1, source: { kind: "command", ref: PID }, actor: "learner", comment: null });
    handler = (m, p) => (p === `/game/wallets/${UID}/ledger` ? { status: 200, body: { items: [freezeTil, freezeOne, op()], next_cursor: null } } : routes(m, p, undefined));
    ui(<WalletTab userId={UID} />, ["game.read", "wallet.adjust"]);
    expect(await screen.findByTestId("wl-reverse-o1")).toBeInTheDocument();
    expect(screen.queryByTestId("wl-reverse-f1")).toBeNull();
    expect(screen.queryByTestId("wl-reverse-f2")).toBeNull();
    expect(screen.queryByTestId("wl-refund-op-f2")).toBeNull();
    fireEvent.click(screen.getByTestId("wl-refund-op-f1"));
    const dlg = await screen.findByTestId("wl-refund-dialog");
    expect(within(dlg).getByTestId("wl-refund-purchase")).toHaveTextContent(PID);
    expect(within(dlg).getByTestId("wl-refund-ops")).toHaveTextContent("−40 тилов · +1 заморозка");
  });
  it("no wallet yet (404) — a calm empty state", async () => {
    handler = (_m, p) => (p.startsWith("/game/wallets/") ? { status: 404, body: { code: "WALLET_NOT_FOUND", message: "", trace_id: "", details: {} } } : p === "/game/heroes" ? { status: 200, body: { items: [] } } : undefined);
    ui(<WalletTab userId={UID} />, ["game.read"]);
    expect(await screen.findByTestId("wl-none")).toBeInTheDocument();
  });
});

describe("overview block «Игра»", () => {
  const off = (service: string) => ({ available: false, data: null, service });
  const d: Dashboard = {
    period: "today",
    generated_at: "2026-11-20T10:00:00Z",
    learners: off("user-admin"),
    support: off("support"),
    whats_new: off("experience-config"),
    campaigns: off("notifications"),
    content: off("catalog"),
    diagnostics: off("diagnostics"),
    lessons: off("lessons"),
    ai: off("ai-gateway"),
    memory: off("memory"),
    game: { available: true, data: { period: "7d", earned_xp: 1240, earned_til: 310, freezes_used: 4, quests_completed: 57, active_event: { title: { ru: "Неделя чтения", uz: "Oʻqish haftaligi" }, ends_at: "2026-11-23T19:00:00Z" } } },
    social: off("social"),
    money: off("billing"),
  };
  it("XP and tils, freezes, quests and the active event; the link needs game.read", async () => {
    handler = (_m, p) => (p === "/dashboard" ? { status: 200, body: d } : undefined);
    ui(<Overview />, ["dashboard.read"]);
    expect(await screen.findByTestId("dgm-xp")).toHaveTextContent(/^Начислено XP, 7 дней\s*1\s240$/);
    // «today» asked, the game answers 7 days — the block says so
    expect(screen.getByTestId("dgm-period-note")).toHaveTextContent("Итоги игры — за 7 дней");
    expect(screen.getByTestId("dgm-til")).toHaveTextContent("310");
    expect(screen.getByTestId("dgm-freezes")).toHaveTextContent("4");
    expect(screen.getByTestId("dgm-quests")).toHaveTextContent("57");
    expect(screen.getByTestId("dgm-event")).toHaveTextContent("Неделя чтения");
    expect(screen.queryByTestId("dgm-open")).toBeNull();
    cleanup();
    ui(<Overview />, ["dashboard.read", "game.read"]);
    await waitFor(() => expect(screen.getByTestId("dgm-open")).toBeInTheDocument());
  });
  it("the game source is down: only its block says so", async () => {
    handler = (_m, p) => (p === "/dashboard" ? { status: 200, body: { ...d, game: off("gamification") } } : undefined);
    ui(<Overview />, ["dashboard.read"]);
    expect(await screen.findByTestId("block-game-off")).toHaveTextContent("gamification");
  });
});
