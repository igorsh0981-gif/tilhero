/**
 * «Игра» (sprint 6, ADM-GAME-01/03/04/05, AT-71, AT-72): pure helpers of the three sections — «Герои», «Геймификация»
 * (rules, shop, wallets, overview) and «События и сезоны».
 *
 * - routes and the lists of codes (audiences, actions, currencies, reasons, statuses) with their tones;
 * - the rules form: GameRules with every number kept as the typed string (an invalid entry stays visible), its parse
 *   back with the path of each problem, the client mirror of the gamification validator (INTERNAL_API §1.3 — the server
 *   stays the authority: POST …/rules/draft/validate), the diff of two rule sets, the activation gate;
 * - hero drafts: the fields of the draft (or of the live version), their checks, the live ↔ draft comparison;
 * - pictures: type by the byte signature and the size from the header (PNG IHDR, WebP VP8 / VP8L / VP8X), ≤ 300 KB,
 *   ≤ 1024×1024 — the same checks gamification repeats;
 * - shop items and events of the week: forms, checks (code, texts, price, period ≤ 14 days, multipliers), bodies of
 *   POST and PATCH (what a published item still allows), the overlap of two events;
 * - wallets: the body of a manual operation (±1..10000, XP ±1..100000, never below zero, reason 10..300), which
 *   operation can be reversed, the actor of an operation.
 */
import type {
  AdminGameEvent,
  AdminHero,
  AdminHeroFields,
  AdminLedgerOperation,
  AdminShopItem,
  AdminWallet,
  GameAudience,
  GameEventFields,
  GameEventStatus,
  GameMultiplier,
  GameRules,
  Localized,
  RulesStatus,
  RulesVersion,
  ShopItemCreate,
  ShopItemStatus,
  WalletAdjustment,
} from "@tilhero/contracts/admin";
import type { GameAction, GameCurrency, GameReason, HeroLine, HeroStage, QuestKind, ShopItemKind } from "@tilhero/contracts/bff";
import type { Tone } from "../../ui/kit";

/* ---------------------------------------------------------------- codes */

export const AUDIENCES: readonly GameAudience[] = ["kids", "teens", "adults"];
export const HERO_LINES: readonly HeroLine[] = ["robot", "pet", "human"];
export const HERO_STAGES: readonly HeroStage[] = [1, 2, 3];
export const QUEST_KINDS: readonly QuestKind[] = ["lesson_complete", "review_cards", "reading_complete", "scenario_complete", "media_complete", "xp_earned", "skill_confirmed"];
export const GAME_ACTIONS: readonly GameAction[] = ["lesson", "scenario", "media", "reading", "review", "skill", "quest"];
export const CURRENCIES: readonly GameCurrency[] = ["xp", "til", "freeze"];
export const MULTIPLIER_CURRENCIES: readonly GameMultiplier["currency"][] = ["xp", "til"];
export const FACTORS: readonly GameMultiplier["factor"][] = [1.5, 2, 3];
export const REASONS: readonly GameReason[] = [
  "lesson", "scenario", "media", "reading", "review", "skill_demonstrated", "skill_retained", "quest", "quest_bonus", "registration_bonus",
  "referral_bonus", "streak_freeze", "shop", "manual", "reversal", "purchase",
];
export const SHOP_KINDS: readonly ShopItemKind[] = ["background", "hero_frame", "streak_freeze"];
/** the kinds a staff member can create: cosmetics only — nothing that touches learning or assessment (ADM-GAME-05) */
export const CREATABLE_KINDS: readonly ShopItemCreate["kind"][] = ["background", "hero_frame"];
export const SHOP_STATUSES: readonly ShopItemStatus[] = ["draft", "published", "retired"];
export const EVENT_STATUSES: readonly GameEventStatus[] = ["draft", "published", "finished", "cancelled"];
export const RULES_STATUSES: readonly RulesStatus[] = ["draft", "active", "archived"];
export const GAME_TABS = ["overview", "rules", "shop", "wallets"] as const;
export type GameTab = (typeof GAME_TABS)[number];
export const OVERVIEW_PERIODS = ["7d", "30d"] as const;
/**
 * Colour tokens of the Mini App theme «Тетрадь» a shop item may reference (packages/ui-tokens/token-names.json): the
 * background of the home screen — light tokens only (the text of the screen stays readable on it), the accent (a hero
 * frame, marks) — saturated ones. The values are the light «notebook» theme (packages/ui-tokens/styles/themes/
 * notebook.css) — the preview shows the item in the colours of the Mini App, not of the admin.
 */
export const BG_TOKENS = ["--paper", "--card", "--grid", "--mark", "--margin", "--pen-soft", "--ok-soft", "--warn-soft", "--err-soft"] as const;
export const ACCENT_TOKENS = ["--pen", "--ink", "--ink2", "--ok", "--warn", "--err"] as const;
export const MINIAPP_COLORS: Readonly<Record<string, string>> = {
  "--paper": "#FBFCFE", "--grid": "#E8ECF5", "--ink": "#1C2340", "--ink2": "#4A5272", "--card": "#FFFFFF", "--pen": "#2F4BE0",
  "--pen-soft": "#E9EDFF", "--mark": "#FFE45C", "--margin": "#F2A7B0", "--err": "#C8323C", "--err-soft": "#FDECEE", "--ok": "#1E7A4F",
  "--ok-soft": "#E3F3EA", "--warn": "#8F5300", "--warn-soft": "#FFF1D6",
};
/** The zone in which staff see and enter the dates of events and sales (the learners' default day, INTERNAL_API §0). */
export const GAME_TZ = "Asia/Tashkent";

/** every comment / reason of a game command: 10..300 characters (audit; ledger.comment ≤ 300) */
export const COMMENT_MIN = 10;
export const COMMENT_MAX = 300;
export const REASON_MIN = 10;
export const REASON_MAX = 300;
export const EVENT_MAX_DAYS = 14;
export const MULTIPLIERS_MAX = 5;
export const CODE_RE = /^[a-z0-9_]{3,40}$/;
export const PRICE_MIN = 1;
export const PRICE_MAX = 10_000;
export const ADJUST_MAX: Record<GameCurrency, number> = { xp: 100_000, til: 10_000, freeze: 10_000 };
const DAY = 86_400_000;

export const RULES_TONE: Record<RulesStatus, Tone> = { draft: "info", active: "good", archived: "neutral" };
export const SHOP_TONE: Record<ShopItemStatus, Tone> = { draft: "info", published: "good", retired: "neutral" };
export const EVENT_TONE: Record<GameEventStatus, Tone> = { draft: "info", published: "good", finished: "neutral", cancelled: "warn" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string | null | undefined): s is string => !!s && UUID_RE.test(s.trim());
const CYR = /[\u0400-\u04ff]/;

/* ---------------------------------------------------------------- routes */

export interface GameRoute {
  tab: GameTab | null;
  /** rules: an opened version; shop: an item code or «new»; wallets: a learner UUID */
  id: string | null;
}

/** #/game[/overview] · #/game/rules[/<version>] · #/game/shop[/new | /<code>] · #/game/wallets[/<user_id>] */
export function parseGameRoute(id: string | null): GameRoute {
  const [head, rest] = (id ?? "").split("/");
  if (!head || !(GAME_TABS as readonly string[]).includes(head)) return { tab: null, id: null };
  const tab = head as GameTab;
  if (!rest) return { tab, id: null };
  if (tab === "rules") return { tab, id: /^\d{1,6}$/.test(rest) ? rest : null };
  if (tab === "shop") return { tab, id: rest === "new" || CODE_RE.test(rest) || rest === "streak_freeze" ? rest : null };
  if (tab === "wallets") return { tab, id: isUuid(rest) ? rest.toLowerCase() : null };
  return { tab, id: null };
}

/** #/heroes[/<code>] · #/events[/new | /<event_id>] */
export function parseItemRoute(id: string | null, pattern: RegExp): string | null {
  const v = (id ?? "").split("/")[0] ?? "";
  return v && pattern.test(v) ? v : null;
}
export const HERO_CODE_RE = /^(robot|pet|human)_[0-9]{1,2}$/;
export const EVENT_ROUTE_RE = /^(new|[0-9a-f-]{36})$/;

/* ---------------------------------------------------------------- problems of a form */

export interface Issue {
  path: string;
  code: string;
}

/** «quests.templates.2.reward.til» (pydantic loc) and «quests.templates[2].reward.til» are the same path. */
export function normPath(p: string): string {
  return p.replace(/^(payload|body)\./, "").replace(/\.(\d+)(?=\.|$)/g, "[$1]");
}

/** DOM id of the field of a path (focus on the first problem). */
export const fieldId = (prefix: string, path: string) => `${prefix}-${normPath(path).replace(/[[\].]+/g, "-").replace(/-$/, "")}`;

export const issuesAt = (xs: readonly Issue[], path: string) => xs.filter((x) => normPath(x.path) === path);
/** problems at the path or below it (a section, a template) */
export const issuesUnder = (xs: readonly Issue[], prefix: string) => xs.filter((x) => {
  const p = normPath(x.path);
  return p === prefix || p.startsWith(`${prefix}.`) || p.startsWith(`${prefix}[`);
});

/* ---------------------------------------------------------------- rules: form */

type FormOf<T> = T extends number ? string : T extends string ? T : T extends ReadonlyArray<infer U> ? Array<FormOf<U>> : T extends object ? { -readonly [K in keyof T]: FormOf<T[K]> } : T;
/** GameRules with every number as the typed text */
export type RulesForm = FormOf<GameRules>;

/** keys whose string values are codes, not numbers */
const STRING_KEYS = new Set(["code", "kind"]);

export function rulesForm(r: GameRules): RulesForm {
  const conv = (v: unknown): unknown => (typeof v === "number" ? String(v) : Array.isArray(v) ? v.map(conv) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)])) : v);
  return conv(r) as RulesForm;
}

/** The typed form back to GameRules; every number that is not a whole number ≥ 0 is a problem at its path. */
export function parseRules(f: RulesForm): { rules: GameRules; issues: Issue[] } {
  const issues: Issue[] = [];
  const conv = (v: unknown, path: string, key: string | null, inAud: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => conv(x, `${path}[${i}]`, null, inAud || key === "audiences"));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x, path ? `${path}.${k}` : k, k, false)]));
    if (typeof v !== "string" || inAud || (key && STRING_KEYS.has(key))) return v;
    const s = v.trim();
    if (!s) {
      issues.push({ path, code: "required" });
      return 0;
    }
    if (!/^-?\d+$/.test(s)) {
      issues.push({ path, code: "not_integer" });
      return Number.NaN;
    }
    const n = Number(s);
    if (n < 0) issues.push({ path, code: "negative" });
    return n;
  };
  return { rules: conv(f, "", null, false) as GameRules, issues };
}

const EARN_PAIRS = ["lesson", "lesson_passed_bonus", "lesson_practice", "scenario", "media", "reading", "skill_demonstrated", "skill_retained"] as const;
export const EARN_ROWS: readonly (typeof EARN_PAIRS)[number][] = EARN_PAIRS;

/** the largest single award of the rules in a currency (one operation) — caps must not be below it */
export function maxSingleAward(r: GameRules, cur: "xp" | "til"): number {
  const xs: number[] = EARN_PAIRS.map((k) => r.earn[k]?.[cur] ?? 0);
  xs.push(cur === "xp" ? (r.earn.review?.xp_base ?? 0) + (r.earn.review?.xp_per_correct_cap ?? 0) : (r.earn.review?.til ?? 0));
  for (const q of r.quests?.templates ?? []) xs.push(q.reward?.[cur] ?? 0);
  xs.push(r.quests?.all_done_bonus?.[cur] ?? 0);
  return Math.max(0, ...xs.filter((n) => Number.isFinite(n)));
}

/**
 * The client mirror of the validator (INTERNAL_API §1.3): errors block the activation, warnings do not. The server
 * check (POST …/rules/draft/validate) is required anyway — this one only answers at once while typing.
 */
export function checkRules(f: RulesForm, active: GameRules | null = null): { errors: Issue[]; warnings: Issue[]; rules: GameRules } {
  const { rules: r, issues } = parseRules(f);
  const errors = [...issues];
  const bad = new Set(issues.map((x) => x.path));
  const err = (path: string, code: string) => {
    if (!bad.has(path)) errors.push({ path, code });
  };
  const range = (path: string, v: number, min: number, max: number) => {
    if (Number.isFinite(v) && (v < min || v > max)) err(path, "range");
  };
  // levels: 2..100 thresholds, strictly increasing, the first is 0
  if (r.levels.length < 2 || r.levels.length > 100) err("levels", "length");
  if (r.levels.length && r.levels[0] !== 0) err("levels[0]", "first_zero");
  r.levels.forEach((x, i) => {
    if (i > 0 && Number.isFinite(x) && x <= r.levels[i - 1]!) err(`levels[${i}]`, "not_increasing");
  });
  // stages of the hero: exactly 3, strictly increasing, the first is 0
  const st = r.hero.stage_thresholds;
  if (st.length !== 3) err("hero.stage_thresholds", "length");
  if (st[0] !== 0) err("hero.stage_thresholds[0]", "first_zero");
  st.forEach((x, i) => {
    if (i > 0 && Number.isFinite(x) && x <= st[i - 1]!) err(`hero.stage_thresholds[${i}]`, "not_increasing");
  });
  // caps ≥ the largest single award
  if (Number.isFinite(r.caps.xp_per_day) && r.caps.xp_per_day < maxSingleAward(r, "xp")) err("caps.xp_per_day", "caps_below_reward");
  if (Number.isFinite(r.caps.til_per_day) && r.caps.til_per_day < maxSingleAward(r, "til")) err("caps.til_per_day", "caps_below_reward");
  range("freeze.price_til", r.freeze.price_til, 1, 10_000);
  range("freeze.max_stock", r.freeze.max_stock, 1, 30);
  range("bonuses.registration_freeze", r.bonuses.registration_freeze, 0, 10);
  range("bonuses.referral_freeze", r.bonuses.referral_freeze, 0, 10);
  range("bonuses.referral_monthly_cap", r.bonuses.referral_monthly_cap, 0, 100);
  range("earn.skill_max_per_event", r.earn.skill_max_per_event, 1, 100);
  range("earn.review.min_cards", r.earn.review.min_cards, 1, 1000);
  // quests: templates per audience ≥ per_day, unique codes, known kinds, weight 1..10, target ≥ 1
  range("quests.per_day", r.quests.per_day, 1, 10);
  const codes = new Map<string, number>();
  r.quests.templates.forEach((q, i) => {
    const p = `quests.templates[${i}]`;
    if (!CODE_RE.test(q.code ?? "")) err(`${p}.code`, "code_format");
    else if (codes.has(q.code)) err(`${p}.code`, "duplicate");
    codes.set(q.code, i);
    if (!(QUEST_KINDS as readonly string[]).includes(q.kind)) err(`${p}.kind`, "unknown_kind");
    if (!q.audiences?.length) err(`${p}.audiences`, "audiences_empty");
    range(`${p}.target`, q.target, 1, 100_000);
    range(`${p}.weight`, q.weight, 1, 10);
  });
  if (Number.isFinite(r.quests.per_day)) {
    for (const a of AUDIENCES) {
      const n = r.quests.templates.filter((q) => q.audiences?.includes(a)).length;
      if (n < r.quests.per_day) err(`quests.templates`, `per_audience_${a}`);
    }
  }
  // badges: thresholds ≥ 1, strictly increasing
  for (const k of ["streak", "skills", "reviews_cards", "readings"] as const) {
    const xs = r.badges[k];
    xs.forEach((x, i) => {
      if (Number.isFinite(x) && x < 1) err(`badges.${k}[${i}]`, "range");
      else if (i > 0 && Number.isFinite(x) && x <= xs[i - 1]!) err(`badges.${k}[${i}]`, "not_increasing");
    });
  }
  // warnings: the rewards grow more than ×2 against the active version; the 2nd stage of the hero is above 10
  const warnings: Issue[] = [];
  if (active) {
    const grow = (path: string, now: number, was: number) => {
      if (Number.isFinite(now) && was > 0 && now > was * 2) warnings.push({ path, code: "reward_growth" });
    };
    for (const k of EARN_PAIRS) for (const c of ["xp", "til"] as const) grow(`earn.${k}.${c}`, r.earn[k][c], active.earn[k]?.[c] ?? 0);
    grow("earn.review.xp_base", r.earn.review.xp_base, active.earn.review.xp_base);
    grow("earn.review.til", r.earn.review.til, active.earn.review.til);
  }
  if (Number.isFinite(st[1]) && (st[1] ?? 0) > 10) warnings.push({ path: "hero.stage_thresholds[1]", code: "stage2_high" });
  return { errors, warnings, rules: r };
}

/** Deep diff of two values: changed leaves with their path (arrays by index; a missing side is null). */
export function diffValues(a: unknown, b: unknown, path = ""): Array<{ path: string; from: unknown; to: unknown }> {
  const obj = (v: unknown) => v !== null && typeof v === "object";
  if (Array.isArray(a) && Array.isArray(b)) {
    // an array of plain values that changed as a whole is one row («levels»: added levels) when lengths differ
    if (a.length !== b.length && [...a, ...b].every((x) => !obj(x))) return [{ path, from: a, to: b }];
    const out: Array<{ path: string; from: unknown; to: unknown }> = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...diffValues(a[i] ?? null, b[i] ?? null, `${path}[${i}]`));
    return out;
  }
  if (obj(a) && obj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])];
    return keys.flatMap((k) => diffValues((a as Record<string, unknown>)[k] ?? null, (b as Record<string, unknown>)[k] ?? null, path ? `${path}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, from: a, to: b }];
}

export type RulesGate = null | "no_draft" | "unsaved" | "invalid" | "not_validated";

/**
 * Why the draft cannot be activated yet (gamification answers 409 RULES_NOT_VALIDATED when the draft changed after the
 * check): unsaved edits, problems found by the client, no successful check after the last save.
 */
export function activationGate(draft: Pick<RulesVersion, "status" | "validated_at" | "updated_at"> | null, dirty: boolean, clientErrors: number, lastCheck: { ok: boolean; at: string } | null): RulesGate {
  if (!draft || draft.status !== "draft") return "no_draft";
  if (dirty) return "unsaved";
  if (clientErrors > 0 || (lastCheck && !lastCheck.ok && lastCheck.at === draft.updated_at)) return "invalid";
  if (!draft.validated_at || Date.parse(draft.validated_at) < Date.parse(draft.updated_at)) return "not_validated";
  return null;
}

/** the human value of a rules leaf in the diff */
export function showValue(v: unknown): string {
  if (v == null) return "—";
  if (Array.isArray(v)) return v.every((x) => typeof x !== "object") ? v.join(", ") : JSON.stringify(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function newTemplate(existing: readonly { code: string }[]): RulesForm["quests"]["templates"][number] {
  let n = existing.length + 1;
  while (existing.some((x) => x.code === `quest_${n}`)) n++;
  return { code: `quest_${n}`, kind: "lesson_complete", target: "1", reward: { xp: "10", til: "5" }, audiences: ["kids", "teens", "adults"], weight: "1" };
}

/* ---------------------------------------------------------------- heroes */

export interface HeroForm {
  name: Localized;
  tagline: Localized;
  audiences: GameAudience[];
  stages: Array<{ stage: HeroStage; name: Localized; asset_id: string }>;
}

export const NAME_MAX = 40;
export const TAGLINE_MAX = 80;

const cloneLoc = (l: Localized): Localized => ({ ru: l.ru, uz: l.uz });
const fieldsOf = (x: AdminHeroFields): HeroForm => ({
  name: cloneLoc(x.name),
  tagline: cloneLoc(x.tagline),
  audiences: AUDIENCES.filter((a) => x.audiences.includes(a)),
  stages: HERO_STAGES.map((s) => {
    const st = x.stages.find((y) => y.stage === s);
    return { stage: s, name: cloneLoc(st?.name ?? { ru: "", uz: "" }), asset_id: st?.asset_id ?? "" };
  }),
});

/** The editor starts from the draft when there is one, else from the live version. */
export const heroForm = (h: AdminHero): HeroForm => fieldsOf(h.draft ?? h);
export const liveForm = (h: AdminHero): HeroForm => fieldsOf(h);
export const sameHero = (a: HeroForm, b: HeroForm) => JSON.stringify(a) === JSON.stringify(b);

export function heroBody(f: HeroForm): AdminHeroFields {
  const tr = (l: Localized): Localized => ({ ru: l.ru.trim(), uz: l.uz.trim() });
  return { name: tr(f.name), tagline: tr(f.tagline), audiences: [...f.audiences], stages: f.stages.map((s) => ({ stage: s.stage, name: tr(s.name), asset_id: s.asset_id })) };
}

/** RU/UZ required, limits, UZ in Latin, a picture for every stage. Audiences may be empty: the hero is hidden from the choice. */
export function checkHero(f: HeroForm): Issue[] {
  const out: Issue[] = [];
  const loc = (path: string, l: Localized, max: number) => {
    for (const k of ["ru", "uz"] as const) {
      const v = l[k].trim();
      if (!v) out.push({ path: `${path}.${k}`, code: "required" });
      else if (v.length > max) out.push({ path: `${path}.${k}`, code: "too_long" });
      else if (k === "uz" && CYR.test(v)) out.push({ path: `${path}.${k}`, code: "uz_script" });
    }
  };
  loc("name", f.name, NAME_MAX);
  loc("tagline", f.tagline, TAGLINE_MAX);
  f.stages.forEach((s, i) => {
    loc(`stages[${i}].name`, s.name, NAME_MAX);
    if (!s.asset_id) out.push({ path: `stages[${i}].asset_id`, code: "required" });
  });
  return out;
}

export interface HeroDiffRow {
  key: string;
  from: string;
  to: string;
  changed: boolean;
}

/** Live ↔ draft, field by field (texts, audiences, names of the stages, pictures by asset id). */
export function heroDiff(live: HeroForm, draft: HeroForm): HeroDiffRow[] {
  const rows: HeroDiffRow[] = [];
  const add = (key: string, a: string, b: string) => rows.push({ key, from: a, to: b, changed: a !== b });
  add("name.ru", live.name.ru, draft.name.ru);
  add("name.uz", live.name.uz, draft.name.uz);
  add("tagline.ru", live.tagline.ru, draft.tagline.ru);
  add("tagline.uz", live.tagline.uz, draft.tagline.uz);
  add("audiences", live.audiences.join(","), draft.audiences.join(","));
  HERO_STAGES.forEach((s, i) => {
    add(`stages[${i}].name.ru`, live.stages[i]?.name.ru ?? "", draft.stages[i]?.name.ru ?? "");
    add(`stages[${i}].name.uz`, live.stages[i]?.name.uz ?? "", draft.stages[i]?.name.uz ?? "");
    add(`stages[${i}].asset_id`, live.stages[i]?.asset_id ?? "", draft.stages[i]?.asset_id ?? "");
    void s;
  });
  return rows;
}

export type HeroGate = null | "no_draft" | "unsaved" | "invalid";
export function heroGate(h: AdminHero, dirty: boolean, issues: number): HeroGate {
  if (dirty) return "unsaved";
  if (!h.draft) return "no_draft";
  if (issues > 0) return "invalid";
  return null;
}

/* ---------------------------------------------------------------- pictures */

export const IMAGE_MAX_BYTES = 300 * 1024;
export const IMAGE_MAX_PX = 1024;
export type ImageType = "image/webp" | "image/png";
export type ImageCheck = { ok: true; type: ImageType; width: number; height: number } | { ok: false; reason: "type" | "size" | "empty" | "signature" | "dims" };

const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.slice(o, o + n));

/** Type and size by the bytes, not by the file name: PNG — the IHDR chunk; WebP — VP8 (lossy), VP8L (lossless), VP8X (extended). */
export function sniffImage(b: Uint8Array): { type: ImageType; width: number; height: number } | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a && ascii(b, 12, 4) === "IHDR")
    return { type: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8X") return { type: "image/webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
      return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { type: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return null;
}

/** webp / png ≤ 300 KB, ≤ 1024×1024, whose bytes really are that type (gamification re-checks: 413 ASSET_TOO_LARGE, 422 ASSET_INVALID). */
export function checkImage(file: { name: string; size: number }, head: Uint8Array): ImageCheck {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (ext !== "webp" && ext !== "png") return { ok: false, reason: "type" };
  if (!file.size) return { ok: false, reason: "empty" };
  if (file.size > IMAGE_MAX_BYTES) return { ok: false, reason: "size" };
  const s = sniffImage(head);
  if (!s || s.type !== (ext === "png" ? "image/png" : "image/webp")) return { ok: false, reason: "signature" };
  if (!s.width || !s.height || s.width > IMAGE_MAX_PX || s.height > IMAGE_MAX_PX) return { ok: false, reason: "dims" };
  return { ok: true, ...s };
}

/**
 * Checks a chosen file before it is read: extension and size first (a 50 MB file is never read), then only the first
 * 64 bytes for the signature and the dimensions. The whole file is read only to upload it.
 */
export async function inspectImageFile(file: { name: string; size: number; slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } }): Promise<ImageCheck> {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (ext !== "webp" && ext !== "png") return { ok: false, reason: "type" };
  if (!file.size) return { ok: false, reason: "empty" };
  if (file.size > IMAGE_MAX_BYTES) return { ok: false, reason: "size" };
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  return checkImage(file, head);
}

/* ---------------------------------------------------------------- time: the Tashkent wall clock ↔ ISO UTC */

interface ZoneParts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  /** 0 = Sunday … 6 = Saturday */
  dow: number;
}
const ZONE_FMT = new Map<string, Intl.DateTimeFormat>();
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall clock of a zone at a moment (Intl, no library; DST-safe). */
export function zoneParts(ms: number, tz: string = GAME_TZ): ZoneParts {
  let f = ZONE_FMT.get(tz);
  if (!f) ZONE_FMT.set(tz, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })));
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, min: Number(p.minute), dow: DOW[p.weekday ?? ""] ?? 0 };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const inputOf = (p: Pick<ZoneParts, "y" | "m" | "d" | "h" | "min">) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.min)}`;

/** ISO → «YYYY-MM-DDTHH:mm» on the wall clock of the zone (the value of <input type="datetime-local">). */
export function toZoneInput(iso: string | null | undefined, tz: string = GAME_TZ): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : inputOf(zoneParts(ms, tz));
}

/** «YYYY-MM-DDTHH:mm» on the wall clock of the zone → ISO UTC; empty, invalid or non-existent → null. */
export function fromZoneInput(v: string, tz: string = GAME_TZ): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (Number.isNaN(guess)) return null;
  const offset = (ms: number) => {
    const p = zoneParts(ms, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(ms / 60_000) * 60_000;
  };
  let ms = guess - offset(guess);
  const second = offset(ms);
  if (second !== offset(guess)) ms = guess - second;
  return toZoneInput(new Date(ms).toISOString(), tz) === v.trim() ? new Date(ms).toISOString() : null;
}

/** «23.11.2026 05:00» of a moment on the wall clock of the zone, in the language of the interface. */
export function zoneDateTime(locale: string, iso: string | null | undefined, tz: string = GAME_TZ): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Intl.DateTimeFormat(locale, { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms)).replace(",", "");
}

/* ---------------------------------------------------------------- shop */

export interface ItemForm {
  code: string;
  kind: ShopItemCreate["kind"];
  title: Localized;
  description: Localized;
  asset_id: string | null;
  look: "image" | "theme";
  bg: string;
  accent: string;
  price: string;
  audiences: GameAudience[];
  from: string;
  until: string;
  order: string;
}

export const ITEM_TITLE_MAX = 60;
export const ITEM_DESC_MAX = 200;

export const emptyItemForm = (): ItemForm => ({
  code: "",
  kind: "background",
  title: { ru: "", uz: "" },
  description: { ru: "", uz: "" },
  asset_id: null,
  look: "theme",
  bg: "--paper",
  accent: "--pen",
  price: "100",
  audiences: [...AUDIENCES],
  from: "",
  until: "",
  order: "10",
});

export function itemFormOf(it: AdminShopItem): ItemForm {
  return {
    code: it.code,
    kind: it.kind === "streak_freeze" ? "background" : it.kind,
    title: cloneLoc(it.title),
    description: cloneLoc(it.description),
    asset_id: it.image?.asset_id ?? null,
    look: it.image ? "image" : "theme",
    bg: it.theme?.bg ?? "--paper",
    accent: it.theme?.accent ?? "--pen",
    price: String(it.price_til),
    audiences: AUDIENCES.filter((a) => it.audiences.includes(a)),
    from: toZoneInput(it.available_from),
    until: toZoneInput(it.available_until),
    order: String(it.order),
  };
}

const intIn = (s: string, min: number, max: number) => /^\d+$/.test(s.trim()) && Number(s) >= min && Number(s) <= max;

/** Checks of an item form; `mode` published — only the end of sale and the order are editable. */
export function checkItem(f: ItemForm, mode: "create" | "draft" | "published"): Issue[] {
  const out: Issue[] = [];
  if (mode === "create" && !CODE_RE.test(f.code.trim())) out.push({ path: "code", code: "code_format" });
  if (mode !== "published") {
    for (const k of ["ru", "uz"] as const) {
      const t = f.title[k].trim();
      if (!t) out.push({ path: `title.${k}`, code: "required" });
      else if (t.length > ITEM_TITLE_MAX) out.push({ path: `title.${k}`, code: "too_long" });
      else if (k === "uz" && CYR.test(t)) out.push({ path: `title.${k}`, code: "uz_script" });
      // admin-bff: description RU and UZ are required (1..200)
      const d = f.description[k].trim();
      if (!d) out.push({ path: `description.${k}`, code: "required" });
      else if (d.length > ITEM_DESC_MAX) out.push({ path: `description.${k}`, code: "too_long" });
      else if (k === "uz" && CYR.test(d)) out.push({ path: `description.${k}`, code: "uz_script" });
    }
    if (!intIn(f.price, PRICE_MIN, PRICE_MAX)) out.push({ path: "price_til", code: "price_range" });
    if (!f.audiences.length) out.push({ path: "audiences", code: "audiences_empty" });
    if (f.look === "image" && !f.asset_id) out.push({ path: "asset_id", code: "required" });
    if (f.look === "theme" && !(BG_TOKENS as readonly string[]).includes(f.bg)) out.push({ path: "theme.bg", code: "token_bg" });
    if (f.look === "theme" && !(ACCENT_TOKENS as readonly string[]).includes(f.accent)) out.push({ path: "theme.accent", code: "token_accent" });
    if (f.from && !fromZoneInput(f.from)) out.push({ path: "available_from", code: "date" });
  }
  if (f.until && !fromZoneInput(f.until)) out.push({ path: "available_until", code: "date" });
  const a = fromZoneInput(f.from);
  const b = fromZoneInput(f.until);
  if (a && b && Date.parse(b) <= Date.parse(a)) out.push({ path: "available_until", code: "until_before_from" });
  if (!intIn(f.order, 0, 9999)) out.push({ path: "order", code: "order_range" });
  return out;
}

export function itemBody(f: ItemForm): ShopItemCreate {
  return {
    code: f.code.trim(),
    kind: f.kind,
    title: { ru: f.title.ru.trim(), uz: f.title.uz.trim() },
    description: { ru: f.description.ru.trim(), uz: f.description.uz.trim() },
    asset_id: f.look === "image" ? f.asset_id : null,
    theme: f.look === "theme" ? { bg: f.bg, accent: f.accent } : null,
    price_til: Number(f.price),
    audiences: [...f.audiences],
    available_from: fromZoneInput(f.from),
    available_until: fromZoneInput(f.until),
    order: Number(f.order),
  };
}

/** PATCH of an item: the changed fields; a published item — only available_until and order (admin.ts); retired — nothing. */
export function itemPatch(it: AdminShopItem, f: ItemForm): Partial<ShopItemCreate> | null {
  if (it.status === "retired") return null;
  const now = itemBody(f);
  const was = itemBody(itemFormOf(it));
  const keys: Array<keyof ShopItemCreate> = it.status === "published" ? ["available_until", "order"] : ["kind", "title", "description", "asset_id", "theme", "price_til", "audiences", "available_from", "available_until", "order"];
  const out: Partial<ShopItemCreate> = {};
  for (const k of keys) if (JSON.stringify(now[k]) !== JSON.stringify(was[k])) (out as Record<string, unknown>)[k] = now[k];
  return Object.keys(out).length ? out : null;
}

/** Is the item on sale at this moment (published and inside its window)? */
export function onSale(it: Pick<AdminShopItem, "status" | "available_from" | "available_until">, now = Date.now()): boolean {
  if (it.status !== "published") return false;
  if (it.available_from && Date.parse(it.available_from) > now) return false;
  if (it.available_until && Date.parse(it.available_until) <= now) return false;
  return true;
}

/* ---------------------------------------------------------------- events of the week */

export interface EventForm {
  code: string;
  title: Localized;
  description: Localized;
  starts: string;
  ends: string;
  audiences: GameAudience[];
  multipliers: GameMultiplier[];
}

export const EVENT_TITLE_MAX = 80;
export const EVENT_DESC_MAX = 300;

/** A new event: next Monday 00:00 → Monday + 7 days on the Tashkent clock, all audiences, «reading ×2 XP». */
export function emptyEventForm(now = Date.now()): EventForm {
  const p = zoneParts(now);
  const day = (add: number) => {
    const u = new Date(Date.UTC(p.y, p.m - 1, p.d + add));
    return inputOf({ y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate(), h: 0, min: 0 });
  };
  const toMonday = ((8 - p.dow) % 7) || 7;
  return {
    code: "",
    title: { ru: "", uz: "" },
    description: { ru: "", uz: "" },
    starts: day(toMonday),
    ends: day(toMonday + 7),
    audiences: [...AUDIENCES],
    multipliers: [{ action: "reading", currency: "xp", factor: 2 }],
  };
}

export const eventFormOf = (e: AdminGameEvent): EventForm => ({
  code: e.code,
  title: cloneLoc(e.title),
  description: cloneLoc(e.description),
  starts: toZoneInput(e.starts_at),
  ends: toZoneInput(e.ends_at),
  audiences: AUDIENCES.filter((a) => e.audiences.includes(a)),
  multipliers: e.multipliers.map((m) => ({ ...m })),
});

/** Whole days (rounded up) of a period; NaN for an invalid one. */
export function periodDays(startIso: string | null, endIso: string | null): number {
  if (!startIso || !endIso) return Number.NaN;
  return Math.ceil((Date.parse(endIso) - Date.parse(startIso)) / DAY);
}

/** Checks of an event: code, RU/UZ, period > 0 and ≤ 14 days, audiences, 1..5 multipliers with unique action + currency. */
export function checkEvent(f: EventForm, mode: "create" | "draft", now = Date.now()): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (mode === "create" && !CODE_RE.test(f.code.trim())) errors.push({ path: "code", code: "code_format" });
  for (const k of ["ru", "uz"] as const) {
    const t = f.title[k].trim();
    if (!t) errors.push({ path: `title.${k}`, code: "required" });
    else if (t.length > EVENT_TITLE_MAX) errors.push({ path: `title.${k}`, code: "too_long" });
    else if (k === "uz" && CYR.test(t)) errors.push({ path: `title.${k}`, code: "uz_script" });
    const d = f.description[k].trim();
    if (!d) errors.push({ path: `description.${k}`, code: "required" });
    else if (d.length > EVENT_DESC_MAX) errors.push({ path: `description.${k}`, code: "too_long" });
    else if (k === "uz" && CYR.test(d)) errors.push({ path: `description.${k}`, code: "uz_script" });
  }
  const s = fromZoneInput(f.starts);
  const e = fromZoneInput(f.ends);
  if (!s) errors.push({ path: "starts_at", code: "date" });
  if (!e) errors.push({ path: "ends_at", code: "date" });
  if (s && e) {
    if (Date.parse(e) <= Date.parse(s)) errors.push({ path: "ends_at", code: "ends_before_starts" });
    else if (Date.parse(e) - Date.parse(s) > EVENT_MAX_DAYS * DAY) errors.push({ path: "ends_at", code: "too_long_period" });
  }
  if (s && Date.parse(s) <= now) warnings.push({ path: "starts_at", code: "starts_past" });
  if (!f.audiences.length) errors.push({ path: "audiences", code: "audiences_empty" });
  if (!f.multipliers.length) errors.push({ path: "multipliers", code: "multipliers_empty" });
  if (f.multipliers.length > MULTIPLIERS_MAX) errors.push({ path: "multipliers", code: "multipliers_many" });
  const seen = new Set<string>();
  f.multipliers.forEach((m, i) => {
    const k = `${m.action}:${m.currency}`;
    if (seen.has(k)) errors.push({ path: `multipliers[${i}]`, code: "duplicate" });
    seen.add(k);
    if (!(FACTORS as readonly number[]).includes(m.factor)) errors.push({ path: `multipliers[${i}].factor`, code: "factor" });
  });
  return { errors, warnings };
}

export function eventBody(f: EventForm): GameEventFields {
  return {
    code: f.code.trim(),
    title: { ru: f.title.ru.trim(), uz: f.title.uz.trim() },
    description: { ru: f.description.ru.trim(), uz: f.description.uz.trim() },
    starts_at: fromZoneInput(f.starts) ?? "",
    ends_at: fromZoneInput(f.ends) ?? "",
    audiences: [...f.audiences],
    multipliers: f.multipliers.map((m) => ({ action: m.action, currency: m.currency, factor: m.factor })),
  };
}

/** PATCH of a draft event: the changed fields (the code stays). */
export function eventPatch(e: AdminGameEvent, f: EventForm): Partial<GameEventFields> | null {
  const now = eventBody(f);
  const was = eventBody(eventFormOf(e));
  const out: Partial<GameEventFields> = {};
  for (const k of ["title", "description", "starts_at", "ends_at", "audiences", "multipliers"] as const) if (JSON.stringify(now[k]) !== JSON.stringify(was[k])) (out as Record<string, unknown>)[k] = now[k];
  return Object.keys(out).length ? out : null;
}

/**
 * Published events that would overlap this one (gamification answers 409 EVENT_OVERLAP {event_id}): the periods
 * intersect, an audience is shared and so is an action + currency pair.
 */
export function overlapping(ev: Pick<AdminGameEvent, "event_id" | "starts_at" | "ends_at" | "audiences" | "multipliers">, all: readonly AdminGameEvent[]): AdminGameEvent[] {
  const s = Date.parse(ev.starts_at);
  const e = Date.parse(ev.ends_at);
  const pairs = new Set(ev.multipliers.map((m) => `${m.action}:${m.currency}`));
  return all.filter(
    (o) =>
      o.event_id !== ev.event_id &&
      o.status === "published" &&
      Date.parse(o.starts_at) < e &&
      s < Date.parse(o.ends_at) &&
      o.audiences.some((a) => ev.audiences.includes(a)) &&
      o.multipliers.some((m) => pairs.has(`${m.action}:${m.currency}`)),
  );
}

/** Is a published event running now? */
export const runningNow = (e: Pick<AdminGameEvent, "status" | "starts_at" | "ends_at">, now = Date.now()) => e.status === "published" && Date.parse(e.starts_at) <= now && now < Date.parse(e.ends_at);

/* ---------------------------------------------------------------- wallets */

export interface AdjustForm {
  currency: GameCurrency;
  direction: "credit" | "debit";
  amount: string;
  reason: string;
}

export const emptyAdjust = (): AdjustForm => ({ currency: "til", direction: "credit", amount: "", reason: "" });

export const balanceOf = (w: Pick<AdminWallet, "xp_total" | "til_balance" | "freeze_stock">, c: GameCurrency) => (c === "xp" ? w.xp_total : c === "til" ? w.til_balance : w.freeze_stock);

/**
 * The body of a manual operation or the problems: an amount 1..10000 (XP 1..100000), a debit of tils or freezes not
 * below zero (409 BALANCE_NEGATIVE otherwise), a reason 10..300 characters. The XP total may go down only by the
 * amount the learner has (the level never drops).
 */
export function adjustmentBody(f: AdjustForm, w: Pick<AdminWallet, "xp_total" | "til_balance" | "freeze_stock">): { body: WalletAdjustment | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const s = f.amount.trim();
  const n = /^\d+$/.test(s) ? Number(s) : Number.NaN;
  if (!s) issues.push({ path: "amount", code: "required" });
  else if (!Number.isInteger(n) || n < 1 || n > ADJUST_MAX[f.currency]) issues.push({ path: "amount", code: "amount_range" });
  else if (f.direction === "debit" && n > balanceOf(w, f.currency)) issues.push({ path: "amount", code: "below_zero" });
  const r = f.reason.trim();
  if (r.length < REASON_MIN) issues.push({ path: "reason", code: "reason_short" });
  else if (r.length > REASON_MAX) issues.push({ path: "reason", code: "reason_long" });
  if (issues.length) return { body: null, issues };
  return { body: { currency: f.currency, amount: f.direction === "debit" ? -n : n, reason: r }, issues };
}

/** Purchases are cancelled only by a refund (409 OPERATION_NOT_REVERSIBLE): their operations are never reversed one by one. */
const NOT_REVERSIBLE: ReadonlySet<GameReason> = new Set(["reversal", "shop", "purchase"]);

/** A confirmed operation that is neither a reversal nor a purchase can be reversed (409 ALREADY_REVERSED for a repeat). */
export const canReverse = (op: Pick<AdminLedgerOperation, "status" | "reason" | "reversal_of">) => op.status === "confirmed" && !NOT_REVERSIBLE.has(op.reason) && !op.reversal_of;

/** The purchase an operation belongs to (a shop purchase — cosmetics or a freeze): `source.ref` = purchase_id; null otherwise. */
export function purchaseOf(op: Pick<AdminLedgerOperation, "reason" | "status" | "source">): string | null {
  return (op.reason === "shop" || op.reason === "purchase") && op.status === "confirmed" && op.source.kind === "command" && isUuid(op.source.ref) ? op.source.ref.toLowerCase() : null;
}

/** One «Вернуть покупку» per purchase among the shown operations: the first operation of each purchase. */
export function refundAnchors(ops: readonly Pick<AdminLedgerOperation, "op_id" | "reason" | "status" | "source">[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const op of ops) {
    const p = purchaseOf(op);
    if (p && !seen.has(p)) {
      seen.add(p);
      out.set(op.op_id, p);
    }
  }
  return out;
}

/** A comment / reason of a command: 10..300 characters → null, else the problem code. */
export function commentProblem(s: string): "reason_short" | "reason_long" | null {
  const n = s.trim().length;
  return n < COMMENT_MIN ? "reason_short" : n > COMMENT_MAX ? "reason_long" : null;
}

/** Would the reversal take tils or freezes below zero (409 BALANCE_NEGATIVE)? XP reversals never drop the level. */
export function reversalBelowZero(op: Pick<AdminLedgerOperation, "currency" | "amount">, w: Pick<AdminWallet, "xp_total" | "til_balance" | "freeze_stock">): boolean {
  if (op.currency === "xp" || op.amount <= 0) return false;
  return balanceOf(w, op.currency) - op.amount < 0;
}

/** «system» · «learner» · «staff:<uuid>» */
export function actorOf(a: string): { kind: "system" | "learner" | "staff" | "other"; id: string | null } {
  if (a === "system" || a === "learner") return { kind: a, id: null };
  if (a.startsWith("staff:")) return { kind: "staff", id: a.slice(6) || null };
  return { kind: "other", id: a || null };
}

/** «+20», «−40» with a real minus sign */
export const signed = (n: number, fmt: (x: number) => string) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : fmt(0));

/* ---------------------------------------------------------------- paths of a form */

const pathParts = (p: string): Array<string | number> =>
  normPath(p)
    .split(/\.|\[|\]/)
    .filter(Boolean)
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x));

/** An immutable update of the value at a path («quests.templates[2].reward.til»). */
export function setAt<T>(obj: T, path: string, v: unknown): T {
  const ps = pathParts(path);
  const go = (o: unknown, i: number): unknown => {
    if (i === ps.length) return v;
    const k = ps[i]!;
    if (Array.isArray(o)) return o.map((x, j) => (j === k ? go(x, i + 1) : x));
    return { ...(o as Record<string, unknown>), [k]: go((o as Record<string, unknown> | undefined)?.[k as string], i + 1) };
  };
  return go(obj, 0) as T;
}

export function getAt(obj: unknown, path: string): unknown {
  return pathParts(path).reduce<unknown>((o, k) => (o == null ? o : (o as Record<string | number, unknown>)[k]), obj);
}

/** Problems a domain sent with 422 *_INVALID {errors: [{path, code}]} (paths normalised); anything else — none. */
export function serverIssues(details: Record<string, unknown> | null | undefined): Issue[] {
  const xs = details?.errors;
  if (!Array.isArray(xs)) return [];
  return xs.filter((x): x is Issue => !!x && typeof (x as Issue).path === "string" && typeof (x as Issue).code === "string").map((x) => ({ path: normPath(x.path), code: x.code }));
}
