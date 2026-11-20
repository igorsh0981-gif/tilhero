import type {
  BadgeView,
  GameCurrency,
  GameImage,
  GameOperation,
  GameSettings,
  GameSummary,
  HeroLine,
  HeroStage,
  HeroStageView,
  HeroView,
  Quest,
  SessionRewards,
  ShopItemView,
  TodayPlan,
} from "@tilhero/contracts/bff";
import tokenNames from "@tilhero/ui-tokens/token-names.json";
import { ApiError } from "../api/errors";
import type { MessageKey, Vars } from "../i18n";

/**
 * Sprint 6 — the game of the learner (APP-GAME-01…07, APP-PROG-01, APP-PROG-03): pure logic of the screens. The game never
 * changes learning: every number here comes from the server ledger (gamification via telegram-bff), the client only
 * shows it. No sums, reasons or prices are computed or sent by the client.
 */

type T = (key: MessageKey, vars?: Vars) => string;
type TP = (key: MessageKey, n: number) => string;

/* ---------------------------------------------------------------- shapes of the BFF answers (bff.ts, спринт 6) */

import type { BadgesResponse, HeroesResponse, ShopResponse } from "@tilhero/contracts/bff";

export type { BadgesResponse, HeroesResponse, ShopResponse };

/* ---------------------------------------------------------------- level and XP */

export interface LevelProgress {
  level: number;
  /** null — the last level */
  next: number | null;
  /** XP inside the current level */
  inLevel: number;
  /** XP from the start of the level to the next threshold (0 — the last level) */
  span: number;
  /** 0..100, floor — never shows a full bar before the threshold */
  pct: number;
  /** XP left to the next level; null — the last level */
  toNext: number | null;
}

/** Progress of the level bar from GameSummary (xp_level_start / xp_next_level are the server's thresholds). */
export function levelProgress(s: Pick<GameSummary, "level" | "xp_total" | "xp_level_start" | "xp_next_level">): LevelProgress {
  const xp = Math.max(0, Math.floor(s.xp_total));
  const start = Math.max(0, Math.floor(s.xp_level_start));
  const level = Math.max(0, Math.floor(s.level));
  if (s.xp_next_level == null) return { level, next: null, inLevel: Math.max(0, xp - start), span: 0, pct: 100, toNext: null };
  const end = Math.floor(s.xp_next_level);
  const span = Math.max(0, end - start);
  const inLevel = Math.min(span, Math.max(0, xp - start));
  const pct = span > 0 ? Math.min(100, Math.floor((inLevel / span) * 100)) : 100;
  return { level, next: level + 1, inLevel, span, pct, toNext: Math.max(0, end - xp) };
}

/* ---------------------------------------------------------------- heroes */

const LINES: readonly HeroLine[] = ["robot", "pet", "human"];

export function heroLine(code: string): HeroLine {
  const l = code.split("_")[0] as HeroLine;
  return LINES.includes(l) ? l : "robot";
}

/** The catalogue order of the server; children (6–13) see the dragons first (AT-65), the rest keeps its order. */
export function orderHeroes(items: readonly HeroView[], kid: boolean): HeroView[] {
  if (!kid) return [...items];
  const rank = (h: HeroView) => (h.line === "pet" ? 0 : 1);
  return items
    .map((h, i) => ({ h, i }))
    .sort((a, b) => rank(a.h) - rank(b.h) || a.i - b.i)
    .map((x) => x.h);
}

export function stageOf(hero: HeroView, stage: HeroStage): HeroStageView | null {
  return hero.stages.find((s) => s.stage === stage) ?? hero.stages[0] ?? null;
}

/** Bundled art (public/heroes) — shown when the image of the catalogue cannot be loaded. */
const STATIC_FILES = new Set(["robot_0_1", "robot_0_2", "robot_1_2", "pet_0_1", "pet_0_3", "human_0_2"]);
const STATIC_BY_LINE: Record<HeroLine, Record<HeroStage, string>> = {
  robot: { 1: "robot_0_1", 2: "robot_0_2", 3: "robot_1_2" },
  pet: { 1: "pet_0_1", 2: "pet_0_3", 3: "pet_0_3" },
  human: { 1: "human_0_2", 2: "human_0_2", 3: "human_0_2" },
};
export function heroFallback(code: string, stage: HeroStage): string {
  const exact = `${code}_${stage}`;
  return `/heroes/${STATIC_FILES.has(exact) ? exact : STATIC_BY_LINE[heroLine(code)][stage]}.webp`;
}

/**
 * The src of a catalogue image: only the BFF path of this very image — GameImage.url must be
 * /v1/game/assets/{asset_id}/{sha256} with the same asset_id (INTERNAL_API §1.12) — on the BFF origin. Anything else
 * (another asset, an absolute URL, javascript:, data:, a stray string) is not an image of the game — null.
 */
export function assetSrc(image: Pick<GameImage, "asset_id" | "url"> | null | undefined, bffBase: string): string | null {
  if (!image || typeof image.url !== "string" || typeof image.asset_id !== "string") return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(image.asset_id)) return null;
  const m = /^\/v1\/game\/assets\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{64})$/.exec(image.url);
  if (!m || m[1] !== image.asset_id) return null;
  return `${bffBase}${image.url}`;
}

/** A promise that gives up after `ms` (null): a slow game never holds a screen of learning. */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([p, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Onboarding offers the choice of a hero after the plan (skippable) only when the game answers in time and no hero is
 * chosen yet: a slow or absent game never holds the end of onboarding.
 */
export async function heroesForOnboarding(load: () => Promise<HeroesResponse>, ms = 4000): Promise<HeroesResponse | null> {
  try {
    const r = await withTimeout(load(), ms);
    return r && r.selected == null && r.items.length > 0 ? r : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- the week: a day closed by a freeze */

export type WeekState = "done" | "frozen" | "missed" | "planned" | "rest";

/** A missed day of the schedule saved by a streak freeze (sprint 6: `frozen`, `missed` stays true) has its own state. */
export function weekState(w: TodayPlan["week"][number]): WeekState {
  if (w.done) return "done";
  if (w.frozen) return "frozen";
  if (w.missed) return "missed";
  return w.scheduled ? "planned" : "rest";
}

/* ---------------------------------------------------------------- the shop */

export function missingTils(price: number, balance: number): number {
  return Math.max(0, Math.ceil(price) - Math.max(0, Math.floor(balance)));
}

/** «Не хватает N тилов…» — no payment screens in sprint 6: the tils are earned in lessons, buying them comes later.
 *  Children get a softer line without the purchase (money only through a parent, sprint 8). */
export function shortageText(t: T, tp: TP, missing: number, kid: boolean): string {
  return t(kid ? "game.shop.shortKid" : "game.shop.short", { n: missing, w: tp("game.tilsGen", missing) });
}

export type PurchaseProblem =
  | { kind: "short"; missing: number }
  | { kind: "full"; max: number | null }
  | { kind: "owned" }
  | { kind: "gone" }
  | { kind: "other" };

/** 409 INSUFFICIENT_TILS {price, balance, missing} / FREEZE_STOCK_FULL {max} / ALREADY_OWNED, 410 ITEM_NOT_AVAILABLE. */
export function purchaseProblem(e: unknown, price: number, balance: number): PurchaseProblem {
  if (!(e instanceof ApiError)) return { kind: "other" };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  switch (e.code) {
    case "INSUFFICIENT_TILS": {
      const d = e.details;
      const missing = num(d.missing) ?? (num(d.price) != null && num(d.balance) != null ? missingTils(num(d.price)!, num(d.balance)!) : missingTils(price, balance));
      return { kind: "short", missing: Math.max(1, missing) };
    }
    case "FREEZE_STOCK_FULL":
      return { kind: "full", max: num(e.details.max) };
    case "ALREADY_OWNED":
      return { kind: "owned" };
    case "ITEM_NOT_AVAILABLE":
    case "ITEM_NOT_FOUND":
      return { kind: "gone" };
    default:
      return { kind: "other" };
  }
}

/**
 * The Idempotency-Key of a purchase must survive a lost answer (the second tap repeats the same purchase — no second
 * charge) and must be dropped once the server has answered for sure (success or a business refusal): the next purchase
 * of a freeze is a new one.
 */
export function keepPurchaseKey(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return e.status === 0 || e.status === 429 || e.status >= 500;
}

export class PurchaseKeys {
  private keys = new Map<string, string>();
  constructor(private readonly make: () => string) {}
  get(code: string): string {
    let k = this.keys.get(code);
    if (!k) {
      k = this.make();
      this.keys.set(code, k);
    }
    return k;
  }
  drop(code: string): void {
    this.keys.delete(code);
  }
}

/** Current equipment from the shop (the flags `equipped`): the other slot is kept when one is changed. */
export function equippedCodes(items: readonly ShopItemView[]): { background_code: string | null; frame_code: string | null } {
  return {
    background_code: items.find((i) => i.kind === "background" && i.equipped)?.code ?? null,
    frame_code: items.find((i) => i.kind === "hero_frame" && i.equipped)?.code ?? null,
  };
}

/**
 * Cosmetics are drawn with the tokens of the theme (ShopItemRef.theme — names of tokens, never CSS), only colour tokens
 * of the allowlist (packages/ui-tokens/token-names.json): the background — only a light token (the text of the card stays
 * readable on it), the accent of a frame — only a saturated one. Anything else — the theme is ignored as a whole (the
 * card keeps its default look).
 */
const COLOR_TOKENS: ReadonlySet<string> = new Set(
  Object.entries((tokenNames as { tokens: Record<string, string> }).tokens)
    .filter(([, kind]) => kind === "color")
    .map(([name]) => name),
);
const LIGHT_TOKENS: ReadonlySet<string> = new Set(
  ["--paper", "--card", "--grid", "--margin", "--mark", "--pen-soft", "--ok-soft", "--warn-soft", "--err-soft"].filter((n) => COLOR_TOKENS.has(n)),
);
const SATURATED_TOKENS: ReadonlySet<string> = new Set(["--pen", "--ok", "--warn", "--err"].filter((n) => COLOR_TOKENS.has(n)));
function tokenName(key: string | null | undefined): string | null {
  if (typeof key !== "string" || !/^(--)?[a-z0-9-]{1,32}$/.test(key)) return null;
  return key.startsWith("--") ? key : `--${key}`;
}
/** `var(--…)` of a light token for a background, or null */
export function bgVar(key: string | null | undefined): string | null {
  const n = tokenName(key);
  return n && LIGHT_TOKENS.has(n) ? `var(${n})` : null;
}
/** `var(--…)` of a saturated token for an accent, or null */
export function accentVar(key: string | null | undefined): string | null {
  const n = tokenName(key);
  return n && SATURATED_TOKENS.has(n) ? `var(${n})` : null;
}
export function themeVars(theme: { bg: string; accent: string } | null | undefined): Record<string, string> {
  const bg = bgVar(theme?.bg);
  const accent = accentVar(theme?.accent);
  return bg && accent ? { "--game-bg": bg, "--game-accent": accent } : {};
}

/* ---------------------------------------------------------------- the ledger in words */

export function amountText(op: { currency: GameCurrency; amount: number }, tp: TP): string {
  const n = Math.abs(Math.trunc(op.amount));
  const sign = op.amount < 0 ? "−" : "+";
  const unit = op.currency === "xp" ? "XP" : op.currency === "til" ? tp("game.tilsWord", n) : tp("game.freezeWord", n);
  return `${sign}${n} ${unit}`;
}

/** The reason of an operation in words; a staff operation is «Корректировка поддержки» — the staff comment is never shown. */
export function reasonKey(op: Pick<GameOperation, "reason">): MessageKey {
  return `game.reason.${op.reason}` as MessageKey;
}

/* ---------------------------------------------------------------- quests and badges */

export function questText(q: Pick<Quest, "kind" | "target">, t: T, tp: TP, kid: boolean): string {
  return t(`game.quest.${q.kind}${kid ? ".kid" : ""}` as MessageKey, { n: q.target, cards: tp("game.cardsAcc", q.target) });
}

export function questPct(q: Pick<Quest, "progress" | "target" | "status">): number {
  if (q.status === "completed") return 100;
  if (q.target <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((q.progress / q.target) * 100)));
}

export function badgePct(b: Pick<BadgeView, "basis" | "earned_at">): number {
  if (b.earned_at) return 100;
  const { value, threshold } = b.basis;
  if (threshold <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((value / threshold) * 100)));
}

/** Earned first (the newest on top), then the open ones closest to their threshold. */
export function sortBadges(items: readonly BadgeView[]): BadgeView[] {
  return [...items].sort((a, b) => {
    if (!!a.earned_at !== !!b.earned_at) return a.earned_at ? -1 : 1;
    if (a.earned_at && b.earned_at) return a.earned_at < b.earned_at ? 1 : a.earned_at > b.earned_at ? -1 : 0;
    return badgePct(b) - badgePct(a);
  });
}

/* ---------------------------------------------------------------- rewards after a session */

export const REWARDS_POLL_MS = 1500;
export const REWARDS_MAX_POLLS = 8;

export type RewardsEnd = "ready" | "none" | "late" | "unavailable";

/**
 * GET /v1/game/rewards?source_session_id=: rewards are credited asynchronously by events. The first read goes at once;
 * while the answer is `pending` it is read again every 1.5 s, at most 8 more times; then «позже» (`late`). A failed
 * read counts as an attempt; GAME_UNAVAILABLE (or the session is not ours — `none`) ends at once. Returns `stop`.
 */
export function pollRewards(
  read: () => Promise<SessionRewards>,
  on: { update?: (r: SessionRewards) => void; end: (how: RewardsEnd, last: SessionRewards | null) => void },
  opts: { interval?: number; maxPolls?: number } = {},
): () => void {
  const interval = opts.interval ?? REWARDS_POLL_MS;
  const maxPolls = opts.maxPolls ?? REWARDS_MAX_POLLS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: SessionRewards | null = null;
  const again = (polls: number) => {
    if (polls >= maxPolls) {
      on.end("late", last);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      attempt(polls + 1);
    }, interval);
  };
  const attempt = (polls: number) => {
    if (stopped) return;
    read().then(
      (r) => {
        if (stopped) return;
        last = r;
        on.update?.(r);
        if (r.status === "ready") on.end("ready", r);
        else if (r.status === "none") on.end("none", r);
        else again(polls);
      },
      (e: unknown) => {
        if (stopped) return;
        if (e instanceof ApiError && (e.code === "GAME_UNAVAILABLE" || e.status === 404 || e.status === 401 || e.status === 403)) on.end("unavailable", last);
        else again(polls);
      },
    );
  };
  attempt(0);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

export interface RewardTotals {
  xp: number;
  til: number;
  freeze: number;
  capped: boolean;
  /** the largest multiplier of a week event among the operations (1 — none) */
  multiplier: number;
}

export function rewardTotals(r: Pick<SessionRewards, "operations">): RewardTotals {
  const out: RewardTotals = { xp: 0, til: 0, freeze: 0, capped: false, multiplier: 1 };
  for (const op of r.operations) {
    if (op.status !== "confirmed") continue;
    out[op.currency] += op.amount;
    if (op.capped) out.capped = true;
    if (op.multiplier > out.multiplier) out.multiplier = op.multiplier;
  }
  return out;
}

/** Anything to show at all (`ready` may carry only a capped zero). */
export function hasRewards(r: SessionRewards): boolean {
  const s = rewardTotals(r);
  return s.xp > 0 || s.til > 0 || s.freeze > 0 || s.capped || !!r.level_up || !!r.hero_stage_up || r.badges.length > 0 || r.quests_completed.length > 0;
}

/* ---------------------------------------------------------------- celebrations */

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** `quiet` — no animation and no confetti: the learner's setting (children by default), and always when the device asks
 *  for reduced motion. Unknown settings — quiet for a child, full otherwise. */
export function celebrationMode(settings: Pick<GameSettings, "celebrations"> | null | undefined, kid: boolean, reducedMotion: boolean): "full" | "quiet" {
  if (reducedMotion) return "quiet";
  if (!settings) return kid ? "quiet" : "full";
  return settings.celebrations === "full" ? "full" : "quiet";
}
