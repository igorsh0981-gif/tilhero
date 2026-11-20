/**
 * Sprint 6 — the game: pure logic (domain/game.ts). The level bar from the server's thresholds, the polling of the
 * rewards of a session (pending → every 1.5 s, at most 8 more times), the texts of «не хватает тилов», the purchase
 * key that survives a lost answer, the order of heroes for children, a day closed by a freeze, safe image URLs and
 * cosmetic tokens, the ledger in words, celebrations and reduced motion.
 */
import type { BadgeView, GameOperation, GameReason, HeroView, SessionRewards } from "@tilhero/contracts/bff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors";
import {
  accentVar,
  amountText,
  assetSrc,
  bgVar,
  badgePct,
  celebrationMode,
  equippedCodes,
  hasRewards,
  heroesForOnboarding,
  heroFallback,
  heroLine,
  keepPurchaseKey,
  levelProgress,
  missingTils,
  orderHeroes,
  pollRewards,
  PurchaseKeys,
  purchaseProblem,
  questPct,
  questText,
  reasonKey,
  REWARDS_MAX_POLLS,
  REWARDS_POLL_MS,
  rewardTotals,
  shortageText,
  sortBadges,
  stageOf,
  themeVars,
  weekState,
  withTimeout,
} from "../src/domain/game";
import { makeI18n } from "../src/i18n";
import { ru } from "../src/i18n/ru";
import { uz } from "../src/i18n/uz";

const RU = makeI18n("ru");
const UZ = makeI18n("uz");

afterEach(() => {
  vi.useRealTimers();
});

/* ---------------------------------------------------------------- level */

describe("levelProgress — the XP bar from GameSummary", () => {
  it("inside a level: XP of the level, the span to the next threshold, a floor percentage", () => {
    expect(levelProgress({ level: 2, xp_total: 120, xp_level_start: 100, xp_next_level: 250 })).toEqual({ level: 2, next: 3, inLevel: 20, span: 150, pct: 13, toNext: 130 });
    // one XP short of the threshold never shows a full bar
    expect(levelProgress({ level: 2, xp_total: 249, xp_level_start: 100, xp_next_level: 250 }).pct).toBe(99);
    expect(levelProgress({ level: 1, xp_total: 0, xp_level_start: 0, xp_next_level: 100 })).toMatchObject({ inLevel: 0, pct: 0, toNext: 100 });
  });
  it("the last level: a full bar, nothing to the next", () => {
    expect(levelProgress({ level: 20, xp_total: 11000, xp_level_start: 10450, xp_next_level: null })).toEqual({ level: 20, next: null, inLevel: 550, span: 0, pct: 100, toNext: null });
  });
  it("odd answers are clamped, never a negative or >100 bar", () => {
    expect(levelProgress({ level: 3, xp_total: 50, xp_level_start: 250, xp_next_level: 450 })).toMatchObject({ inLevel: 0, pct: 0, toNext: 400 });
    expect(levelProgress({ level: 3, xp_total: 900, xp_level_start: 250, xp_next_level: 450 })).toMatchObject({ inLevel: 200, pct: 100, toNext: 0 });
    expect(levelProgress({ level: 3, xp_total: 300, xp_level_start: 300, xp_next_level: 300 })).toMatchObject({ span: 0, pct: 100 });
  });
});

/* ---------------------------------------------------------------- rewards polling */

const rw = (status: SessionRewards["status"], over: Partial<SessionRewards> = {}): SessionRewards => ({
  status,
  operations: [],
  level_up: null,
  hero_stage_up: null,
  badges: [],
  quests_completed: [],
  ...over,
});

describe("pollRewards — GET /v1/game/rewards?source_session_id=", () => {
  it("the first read at once; pending → every 1.5 s until ready", async () => {
    vi.useFakeTimers();
    const answers = [rw("pending"), rw("pending"), rw("ready", { operations: [op("xp", 30)] })];
    const read = vi.fn(async () => answers.shift() ?? rw("ready"));
    const end = vi.fn();
    const update = vi.fn();
    pollRewards(read, { update, end });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REWARDS_POLL_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REWARDS_POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
    expect(end).toHaveBeenCalledTimes(1);
    expect(end.mock.calls[0]![0]).toBe("ready");
    expect(update).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("pending forever: 1 + 8 reads over 12 s, then «позже» (late)", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => rw("pending"));
    const end = vi.fn();
    pollRewards(read, { end });
    await vi.advanceTimersByTimeAsync(REWARDS_POLL_MS * REWARDS_MAX_POLLS + 10);
    expect(REWARDS_MAX_POLLS).toBe(8);
    expect(read).toHaveBeenCalledTimes(9);
    expect(end).toHaveBeenCalledWith("late", expect.objectContaining({ status: "pending" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(9);
  });
  it("none ends at once; GAME_UNAVAILABLE ends as unavailable; a network failure counts as an attempt", async () => {
    vi.useFakeTimers();
    const end = vi.fn();
    pollRewards(async () => rw("none"), { end });
    await vi.advanceTimersByTimeAsync(0);
    expect(end).toHaveBeenLastCalledWith("none", expect.objectContaining({ status: "none" }));

    const down = vi.fn(async () => {
      throw new ApiError(503, "GAME_UNAVAILABLE", "x");
    });
    pollRewards(down, { end });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(down).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenLastCalledWith("unavailable", null);

    let n = 0;
    const flaky = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new ApiError(0, "NETWORK", "x");
      return rw("ready", { operations: [op("til", 5)] });
    });
    pollRewards(flaky, { end });
    await vi.advanceTimersByTimeAsync(REWARDS_POLL_MS + 5);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenLastCalledWith("ready", expect.objectContaining({ status: "ready" }));
  });
  it("stop (the screen closed): no more reads, no callbacks", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => rw("pending"));
    const end = vi.fn();
    const stop = pollRewards(read, { end });
    await vi.advanceTimersByTimeAsync(REWARDS_POLL_MS + 5);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(end).not.toHaveBeenCalled();
  });
});

function op(currency: GameOperation["currency"], amount: number, over: Partial<GameOperation> = {}): GameOperation {
  return { op_id: `op-${currency}-${amount}`, currency, amount, reason: "lesson", capped: false, multiplier: 1, status: "confirmed", created_at: "2026-11-20T10:00:00Z", ...over };
}

describe("rewardTotals / hasRewards", () => {
  it("sums confirmed operations by currency; a cut by the daily limit and the multiplier of an event are told", () => {
    const r = rw("ready", { operations: [op("xp", 30, { multiplier: 2 }), op("xp", 10, { reason: "quest" }), op("til", 2, { capped: true }), op("til", 5, { status: "reversed" })] });
    expect(rewardTotals(r)).toEqual({ xp: 40, til: 2, freeze: 0, capped: true, multiplier: 2 });
    expect(hasRewards(r)).toBe(true);
  });
  it("ready with nothing to show is not shown; a level or a badge alone is", () => {
    expect(hasRewards(rw("ready"))).toBe(false);
    expect(hasRewards(rw("ready", { level_up: { from: 2, to: 3 } }))).toBe(true);
    expect(hasRewards(rw("ready", { badges: [badge("first_lesson", "2026-11-20T10:00:00Z")] }))).toBe(true);
  });
});

/* ---------------------------------------------------------------- the shop */

describe("«Не хватает N тилов» — no payment screens", () => {
  it("RU plurals after «не хватает»: 1 тила, 2 / 5 / 11 тилов, 21 тила", () => {
    const line = (n: number) => shortageText(RU.t, RU.tp, n, false);
    expect(line(1)).toBe("Не хватает 1 тила. Заработайте в уроках — покупка тилов скоро");
    expect(line(2)).toBe("Не хватает 2 тилов. Заработайте в уроках — покупка тилов скоро");
    expect(line(5)).toBe("Не хватает 5 тилов. Заработайте в уроках — покупка тилов скоро");
    expect(line(11)).toBe("Не хватает 11 тилов. Заработайте в уроках — покупка тилов скоро");
    expect(line(21)).toBe("Не хватает 21 тила. Заработайте в уроках — покупка тилов скоро");
  });
  it("children: on «ты», softer, without the purchase of tils (money only through a parent)", () => {
    const kid = shortageText(RU.t, RU.tp, 20, true);
    expect(kid).toBe("Не хватает 20 тилов. Их можно заработать в уроках!");
    expect(kid).not.toMatch(/покупк|купи/i);
  });
  it("UZ: Latin, the noun does not change after numerals", () => {
    expect(shortageText(UZ.t, UZ.tp, 35, false)).toBe("35 til yetmayapti. Darslarda ishlab oling — til sotib olish tez orada");
  });
  it("missingTils never negative, whole tils", () => {
    expect(missingTils(40, 35)).toBe(5);
    expect(missingTils(40, 85)).toBe(0);
    expect(missingTils(40, -3)).toBe(40);
  });
  it("purchaseProblem reads the 409 / 410 answers of the contract", () => {
    expect(purchaseProblem(new ApiError(409, "INSUFFICIENT_TILS", "x", { price: 40, balance: 10, missing: 30, purchase_available: false }), 40, 85)).toEqual({ kind: "short", missing: 30 });
    // without `missing`: from price and balance of the answer, then of the screen
    expect(purchaseProblem(new ApiError(409, "INSUFFICIENT_TILS", "x", { price: 120, balance: 85 }), 120, 999)).toEqual({ kind: "short", missing: 35 });
    expect(purchaseProblem(new ApiError(409, "INSUFFICIENT_TILS", "x"), 50, 45)).toEqual({ kind: "short", missing: 5 });
    expect(purchaseProblem(new ApiError(409, "FREEZE_STOCK_FULL", "x", { max: 5 }), 40, 85)).toEqual({ kind: "full", max: 5 });
    expect(purchaseProblem(new ApiError(409, "ALREADY_OWNED", "x"), 40, 85)).toEqual({ kind: "owned" });
    expect(purchaseProblem(new ApiError(410, "ITEM_NOT_AVAILABLE", "x"), 40, 85)).toEqual({ kind: "gone" });
    expect(purchaseProblem(new ApiError(0, "NETWORK", "x"), 40, 85)).toEqual({ kind: "other" });
    expect(purchaseProblem(new Error("x"), 40, 85)).toEqual({ kind: "other" });
  });
  it("the Idempotency-Key survives a lost answer (network, 5xx, 429) and is dropped after a sure answer", () => {
    expect(keepPurchaseKey(new ApiError(0, "NETWORK", "x"))).toBe(true);
    expect(keepPurchaseKey(new ApiError(503, "GAME_UNAVAILABLE", "x"))).toBe(true);
    expect(keepPurchaseKey(new ApiError(429, "RATE_LIMITED", "x"))).toBe(true);
    expect(keepPurchaseKey(new ApiError(409, "INSUFFICIENT_TILS", "x"))).toBe(false);
    expect(keepPurchaseKey(new ApiError(422, "IDEMPOTENCY_KEY_REUSED", "x"))).toBe(false);
    let n = 0;
    const keys = new PurchaseKeys(() => `k${++n}`);
    expect(keys.get("streak_freeze")).toBe("k1");
    expect(keys.get("streak_freeze")).toBe("k1");
    expect(keys.get("bg_space")).toBe("k2");
    keys.drop("streak_freeze");
    expect(keys.get("streak_freeze")).toBe("k3");
  });
  it("equipment: the other slot is kept", () => {
    const item = (code: string, kind: "background" | "hero_frame", equipped: boolean) => ({ code, kind, equipped }) as never;
    expect(equippedCodes([item("bg_a", "background", false), item("bg_b", "background", true), item("fr", "hero_frame", true)])).toEqual({ background_code: "bg_b", frame_code: "fr" });
    expect(equippedCodes([])).toEqual({ background_code: null, frame_code: null });
  });
  it("cosmetics: a light token for the background, a saturated one for the accent, never CSS", () => {
    expect(bgVar("pen-soft")).toBe("var(--pen-soft)");
    expect(bgVar("--card")).toBe("var(--card)");
    for (const light of ["paper", "card", "grid", "margin", "mark", "ok-soft", "warn-soft", "err-soft"]) expect(bgVar(light), light).toBe(`var(--${light})`);
    expect(accentVar("--ok")).toBe("var(--ok)");
    for (const sat of ["pen", "ok", "warn", "err"]) expect(accentVar(sat), sat).toBe(`var(--${sat})`);
    // dark or saturated tokens as a background — the text of the card would be unreadable
    for (const dark of ["ink", "--ink", "ink2", "pen", "err", "scrim", "pen-ink"]) expect(bgVar(dark), dark).toBeNull();
    // light ones as an accent — the frame would vanish
    for (const pale of ["pen-soft", "card", "paper", "ink"]) expect(accentVar(pale), pale).toBeNull();
    expect(bgVar("r-card")).toBeNull(); // a length, not a colour
    expect(bgVar("red; background: url(https://x)")).toBeNull();
    expect(bgVar(null)).toBeNull();
  });
  it("themeVars: both parts valid — or the theme is ignored as a whole (the default look)", () => {
    expect(themeVars({ bg: "pen-soft", accent: "pen" })).toEqual({ "--game-bg": "var(--pen-soft)", "--game-accent": "var(--pen)" });
    expect(themeVars({ bg: "warn-soft", accent: "warn" })).toEqual({ "--game-bg": "var(--warn-soft)", "--game-accent": "var(--warn)" });
    expect(themeVars({ bg: "ink", accent: "pen" })).toEqual({});
    expect(themeVars({ bg: "--ink", accent: "ok" })).toEqual({});
    expect(themeVars({ bg: "card", accent: "pen-soft" })).toEqual({});
    expect(themeVars({ bg: "#ff0000", accent: "expression(alert(1))" })).toEqual({});
    expect(themeVars(null)).toEqual({});
  });
});

/* ---------------------------------------------------------------- heroes, the week, images */

const hero = (code: string, line: HeroView["line"]): HeroView => ({
  code,
  line,
  name: { ru: code, uz: code },
  tagline: { ru: "", uz: "" },
  stages: [1, 2, 3].map((s) => ({ stage: s as 1 | 2 | 3, name: { ru: `s${s}`, uz: `s${s}` }, image: { asset_id: `a${s}`, url: `/v1/game/assets/a${s}/${"0".repeat(64)}`, width: 300, height: 460 }, skills_required: [0, 5, 15][s - 1]! })),
});

describe("heroes", () => {
  const all = [hero("robot_0", "robot"), hero("robot_1", "robot"), hero("pet_0", "pet"), hero("pet_1", "pet"), hero("human_0", "human")];
  it("children see the dragons first; the order inside the lines is the server's", () => {
    expect(orderHeroes(all, true).map((h) => h.code)).toEqual(["pet_0", "pet_1", "robot_0", "robot_1", "human_0"]);
    expect(orderHeroes(all, false).map((h) => h.code)).toEqual(all.map((h) => h.code));
  });
  it("the stage view and the line of a code", () => {
    expect(stageOf(all[0]!, 2)?.skills_required).toBe(5);
    expect(heroLine("pet_2")).toBe("pet");
    expect(heroLine("weird")).toBe("robot");
  });
  it("the bundled art when the catalogue image cannot be loaded", () => {
    expect(heroFallback("robot_0", 1)).toBe("/heroes/robot_0_1.webp");
    expect(heroFallback("robot_2", 2)).toBe("/heroes/robot_0_2.webp");
    expect(heroFallback("pet_1", 3)).toBe("/heroes/pet_0_3.webp");
    expect(heroFallback("human_2", 1)).toBe("/heroes/human_0_2.webp");
  });
  it("heroesForOnboarding: only when the game answers in time and no hero is chosen", async () => {
    const res = { items: all, selected: null, stage: 1 as const };
    expect(await heroesForOnboarding(async () => res)).toBe(res);
    expect(await heroesForOnboarding(async () => ({ ...res, selected: "pet_0" }))).toBeNull();
    expect(await heroesForOnboarding(async () => ({ ...res, items: [] }))).toBeNull();
    expect(
      await heroesForOnboarding(async () => {
        throw new ApiError(503, "GAME_UNAVAILABLE", "x");
      }),
    ).toBeNull();
    vi.useFakeTimers();
    const slow = heroesForOnboarding(() => new Promise(() => undefined), 4000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await slow).toBeNull();
  });
});

describe("the week: a missed day closed by a freeze", () => {
  const d = (o: Partial<{ scheduled: boolean; done: boolean; missed: boolean; frozen: boolean }>) => ({ local_date: "2026-11-18", scheduled: true, done: false, missed: false, frozen: false, ...o });
  it("frozen is its own state (missed stays true on the server)", () => {
    expect(weekState(d({ missed: true, frozen: true }))).toBe("frozen");
    expect(weekState(d({ missed: true }))).toBe("missed");
    expect(weekState(d({ done: true, frozen: true }))).toBe("done");
    expect(weekState(d({}))).toBe("planned");
    expect(weekState(d({ scheduled: false }))).toBe("rest");
    // an older BFF without the field
    expect(weekState({ local_date: "2026-11-18", scheduled: true, done: false, missed: true } as never)).toBe("missed");
  });
});

const SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
describe("assetSrc — only the BFF path of this very image", () => {
  it("/v1/game/assets/{asset_id}/{sha256} of the same asset_id, on the BFF origin", () => {
    const id = "3f0e6c1a-2b4d-4c8e-9a1b-5d6e7f8a9b0c";
    expect(assetSrc({ asset_id: id, url: `/v1/game/assets/${id}/${SHA}` }, "https://bff.tilhero.uz")).toBe(`https://bff.tilhero.uz/v1/game/assets/${id}/${SHA}`);
    expect(assetSrc({ asset_id: "as-robot_0-1", url: `/v1/game/assets/as-robot_0-1/${SHA}` }, "/__bff")).toBe(`/__bff/v1/game/assets/as-robot_0-1/${SHA}`);
  });
  it("another asset, an absolute URL, a short or odd sha, a stray string — null", () => {
    const bad: Array<{ asset_id: string; url: string } | null | undefined> = [
      { asset_id: "a", url: `/v1/game/assets/b/${SHA}` },
      { asset_id: "a", url: `https://cdn.tilhero.uz/v1/game/assets/a/${SHA}` },
      { asset_id: "a", url: `https://bff.tilhero.uz/v1/game/assets/a/${SHA}` },
      { asset_id: "a", url: "/v1/game/assets/a/abc123" },
      { asset_id: "a", url: `/v1/game/assets/a/${SHA.toUpperCase()}x` },
      { asset_id: "a", url: `/v1/game/assets/a/${SHA}?x=1` },
      { asset_id: "..", url: `/v1/game/assets/../${SHA}` },
      { asset_id: "a", url: "javascript:alert(1)" },
      { asset_id: "a", url: "data:image/png;base64,AA" },
      { asset_id: "a", url: "/v1/profile" },
      null,
      undefined,
    ];
    for (const b of bad) expect(assetSrc(b, "/__bff"), JSON.stringify(b)).toBeNull();
  });
  it("withTimeout gives up with null", async () => {
    expect(await withTimeout(Promise.resolve(5), 100)).toBe(5);
    vi.useFakeTimers();
    const slow = withTimeout(new Promise<number>(() => undefined), 1500);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await slow).toBeNull();
  });
});

/* ---------------------------------------------------------------- texts */

describe("the ledger and quests in words", () => {
  it("amounts with a sign and a unit (not colour)", () => {
    expect(amountText({ currency: "xp", amount: 20 }, RU.tp)).toBe("+20 XP");
    expect(amountText({ currency: "til", amount: -40 }, RU.tp)).toBe("−40 тилов");
    expect(amountText({ currency: "til", amount: 1 }, RU.tp)).toBe("+1 тил");
    expect(amountText({ currency: "til", amount: 3 }, RU.tp)).toBe("+3 тила");
    expect(amountText({ currency: "freeze", amount: 2 }, RU.tp)).toBe("+2 заморозки");
    expect(amountText({ currency: "freeze", amount: -1 }, RU.tp)).toBe("−1 заморозка");
    expect(amountText({ currency: "til", amount: 5 }, UZ.tp)).toBe("+5 til");
  });
  it("every reason of the ledger has a text in both languages; a staff one is «Корректировка поддержки»", () => {
    const reasons: GameReason[] = ["lesson", "scenario", "media", "reading", "review", "skill_demonstrated", "skill_retained", "quest", "quest_bonus", "registration_bonus", "referral_bonus", "streak_freeze", "shop", "manual", "reversal", "purchase"];
    for (const r of reasons) {
      const k = reasonKey({ reason: r });
      expect(ru[k as keyof typeof ru], r).toBeTruthy();
      expect(uz[k], r).toBeTruthy();
    }
    expect(RU.t(reasonKey({ reason: "manual" }))).toBe("Корректировка поддержки");
  });
  it("quests: adults and children (on «ты»), cards in the accusative", () => {
    expect(questText({ kind: "review_cards", target: 10 }, RU.t, RU.tp, false)).toBe("Повторить 10 карточек");
    expect(questText({ kind: "review_cards", target: 2 }, RU.t, RU.tp, false)).toBe("Повторить 2 карточки");
    expect(questText({ kind: "review_cards", target: 1 }, RU.t, RU.tp, true)).toBe("Повтори 1 карточку");
    expect(questText({ kind: "lesson_complete", target: 1 }, RU.t, RU.tp, true)).toBe("Пройди урок");
    expect(questText({ kind: "xp_earned", target: 50 }, RU.t, RU.tp, false)).toBe("Набрать 50 XP за день");
    expect(questText({ kind: "review_cards", target: 10 }, UZ.t, UZ.tp, false)).toBe("10 ta kartani takrorlash");
    expect(questPct({ progress: 4, target: 10, status: "active" })).toBe(40);
    expect(questPct({ progress: 0, target: 1, status: "completed" })).toBe(100);
    expect(questPct({ progress: 12, target: 10, status: "active" })).toBe(100);
  });
});

function badge(code: string, earned: string | null, value = 1, threshold = 1): BadgeView {
  return { code, title: { ru: code, uz: code }, description: { ru: "", uz: "" }, image: null, earned_at: earned, basis: { metric: "lessons", value, threshold } };
}

describe("badges", () => {
  it("earned first (the newest on top), then the open ones closest to their threshold", () => {
    const out = sortBadges([badge("a", null, 1, 10), badge("b", "2026-11-12T10:00:00Z"), badge("c", null, 8, 10), badge("d", "2026-11-18T10:00:00Z")]);
    expect(out.map((b) => b.code)).toEqual(["d", "b", "c", "a"]);
    expect(badgePct(badge("x", null, 4, 7))).toBe(57);
    expect(badgePct(badge("x", "2026-11-12T10:00:00Z", 0, 7))).toBe(100);
  });
});

describe("celebrations", () => {
  it("quiet with reduced motion always; the learner's setting otherwise; unknown — quiet for a child", () => {
    expect(celebrationMode({ celebrations: "full" }, false, true)).toBe("quiet");
    expect(celebrationMode({ celebrations: "full" }, false, false)).toBe("full");
    expect(celebrationMode({ celebrations: "quiet" }, false, false)).toBe("quiet");
    expect(celebrationMode({ celebrations: "full" }, true, false)).toBe("full");
    expect(celebrationMode(null, true, false)).toBe("quiet");
    expect(celebrationMode(null, false, false)).toBe("full");
  });
});
