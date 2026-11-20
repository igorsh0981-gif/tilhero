import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ActiveGameEvent,
  BadgeView,
  DailyQuests,
  GameCurrency,
  GameImage,
  GameOperation,
  GameReason,
  GameSettings,
  GameSummary,
  HeroLine,
  HeroStage,
  HeroView,
  PurchaseResult,
  Quest,
  SessionRewards,
  ShopItemKind,
  ShopItemView,
} from "@tilhero/contracts/bff";
import type { Localized } from "@tilhero/contracts/content";
import type { Res } from "./lessons";

/**
 * Sprint 6 part of the mock telegram-bff (bff.ts «Спринт 6», INTERNAL_API §1.4–§1.9): the summary (level by the
 * thresholds of the rules, tils, freezes, the hero, quests, events, equipment, settings), nine heroes with three stages
 * each (the art — the seed of services/gamification, else the bundled public/heroes), the shop with an Idempotency-Key
 * (the same key — the same answer, no second operation; INSUFFICIENT_TILS {price, balance, missing}, ALREADY_OWNED,
 * FREEZE_STOCK_FULL {max}), equipment (NOT_OWNED), the ledger (30 per page, a filter by currency; a staff operation
 * without its comment), badges (earned with the basis, open with the progress), the rewards of a session (pending a
 * few reads → ready, or none), settings. `mode: "down"` — 503 GAME_UNAVAILABLE everywhere: the app must work without
 * the game. Pure TS (Playwright, Node).
 */
export interface GameScenario {
  /** down — 503 GAME_UNAVAILABLE on every /v1/game/* (the art stays public) */
  mode?: "ok" | "down";
  /** the chosen hero; null — not chosen yet (the invitation, the onboarding step) */
  hero?: string | null;
  stage?: HeroStage;
  /** confirmed skills (demonstrated + retained) */
  skills?: number;
  xp?: number;
  til?: number;
  freeze?: number;
  questsHidden?: boolean;
  celebrations?: "full" | "quiet";
  /** an active week event («Неделя чтения ×2 XP») */
  event?: boolean;
  /** the rewards of any session: `pending` this many reads (default 1), then ready (or none / never ready) */
  rewards?: { pendingReads?: number; outcome?: "ready" | "none" | "never"; levelUp?: boolean; heroUp?: boolean; badge?: boolean; quest?: boolean; capped?: boolean; multiplier?: number };
  /** the first purchase is handled, then its answer is lost (network) — the retry with the same key gets the same answer */
  dropPurchaseOnce?: boolean;
}

const L = (ru: string, uz: string): Localized => ({ ru, uz });
const ok = (body: unknown, status = 200): Res => ({ status, body });
const fail = (status: number, code: string, details: Record<string, unknown> = {}): Res => ({ status, code, details });

export const LEVELS = [0, 100, 250, 450, 700, 1000, 1350, 1750, 2200, 2700, 3250, 3850, 4500, 5200, 5950, 6750, 7600, 8500, 9450, 10450];
const STAGE_AT = [0, 5, 15];
const FREEZE_PRICE = 40;
const FREEZE_MAX = 5;

/* ---------------------------------------------------------------- the art */

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, "../../../../services/gamification/migrations/seed/heroes");
const PUBLIC = join(HERE, "../../public/heroes");
const STATIC_BY_LINE: Record<HeroLine, Record<HeroStage, string>> = {
  robot: { 1: "robot_0_1", 2: "robot_0_2", 3: "robot_1_2" },
  pet: { 1: "pet_0_1", 2: "pet_0_3", 3: "pet_0_3" },
  human: { 1: "human_0_2", 2: "human_0_2", 3: "human_0_2" },
};

interface Asset {
  id: string;
  sha: string;
  bytes: Buffer;
  width: number;
  height: number;
}

/** Width / height of a webp (VP8X / VP8 / VP8L) — the header, like the server checks it. */
function webpSize(b: Buffer): { width: number; height: number } {
  const fmt = b.subarray(12, 16).toString("ascii");
  if (fmt === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (fmt === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (fmt === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { width: 0, height: 0 };
}

const assets = new Map<string, Asset>();
function heroAsset(code: string, line: HeroLine, stage: HeroStage): Asset {
  const id = `as-${code}-${stage}`;
  const hit = assets.get(id);
  if (hit) return hit;
  const seed = join(SEED, `${code}_${stage}.webp`);
  const file = existsSync(seed) ? seed : join(PUBLIC, `${STATIC_BY_LINE[line][stage]}.webp`);
  const bytes = readFileSync(file);
  const a: Asset = { id, sha: createHash("sha256").update(bytes).digest("hex"), bytes, ...webpSize(bytes) };
  assets.set(id, a);
  return a;
}
const image = (a: Asset): GameImage => ({ asset_id: a.id, url: `/v1/game/assets/${a.id}/${a.sha}`, width: a.width, height: a.height });

/* ---------------------------------------------------------------- the catalogue */

const STAGE_NAMES: Record<HeroLine, Localized[]> = {
  robot: [L("Сборка", "Yigʻilish"), L("Запуск", "Ishga tushish"), L("Полёт", "Parvoz")],
  pet: [L("Яйцо", "Tuxum"), L("Малыш", "Kichkintoy"), L("Крылья", "Qanotlar")],
  human: [L("Новичок", "Yangi boshlovchi"), L("Путешественник", "Sayohatchi"), L("Знаток", "Bilimdon")],
};
const CATALOGUE: Array<{ code: string; line: HeroLine; name: Localized; tagline: Localized }> = [
  { code: "robot_0", line: "robot", name: L("Робот Вольт", "Robot Volt"), tagline: L("Собирает слова, как детали", "Soʻzlarni detallardek yigʻadi") },
  { code: "robot_1", line: "robot", name: L("Робот Искра", "Robot Iskra"), tagline: L("Загорается от новых фраз", "Yangi iboralardan yonadi") },
  { code: "robot_2", line: "robot", name: L("Робот Бриз", "Robot Briz"), tagline: L("Спокойно и по шагам", "Xotirjam va qadam-baqadam") },
  { code: "pet_0", line: "pet", name: L("Дракончик Мятик", "Ajdarcha Myatik"), tagline: L("Любит повторять слова", "Soʻzlarni takrorlashni yaxshi koʻradi") },
  { code: "pet_1", line: "pet", name: L("Дракончик Персик", "Ajdarcha Persik"), tagline: L("Смелый в разговорах", "Suhbatlarda dadil") },
  { code: "pet_2", line: "pet", name: L("Дракончик Сирень", "Ajdarcha Siren"), tagline: L("Читает всё подряд", "Hamma narsani oʻqiydi") },
  { code: "human_0", line: "human", name: L("Ученица Нилу", "Oʻquvchi Nilu"), tagline: L("Мечтает о путешествиях", "Sayohatlarni orzu qiladi") },
  { code: "human_1", line: "human", name: L("Ученик Тимур", "Oʻquvchi Timur"), tagline: L("Готовится к собеседованию", "Suhbatga tayyorlanmoqda") },
  { code: "human_2", line: "human", name: L("Ученица Ая", "Oʻquvchi Aya"), tagline: L("Смотрит фильмы без субтитров", "Filmlarni subtitrsiz koʻradi") },
];
function heroView(h: (typeof CATALOGUE)[number]): HeroView {
  return {
    code: h.code,
    line: h.line,
    name: h.name,
    tagline: h.tagline,
    stages: ([1, 2, 3] as const).map((s) => ({ stage: s, name: STAGE_NAMES[h.line][s - 1]!, image: image(heroAsset(h.code, h.line, s)), skills_required: STAGE_AT[s - 1]! })),
  };
}

interface ItemDef {
  code: string;
  kind: ShopItemKind;
  title: Localized;
  description: Localized;
  price: number;
  theme: { bg: string; accent: string } | null;
  until?: string | null;
}
const ITEMS: ItemDef[] = [
  { code: "streak_freeze", kind: "streak_freeze", title: L("Заморозка серии", "Seriyani muzlatish"), description: L("Сохранит серию за пропущенный день", "Oʻtkazib yuborilgan kun uchun seriyani saqlaydi"), price: FREEZE_PRICE, theme: null },
  { code: "bg_mint", kind: "background", title: L("Мятный фон", "Yalpiz foni"), description: L("Спокойный зелёный фон главной", "Bosh sahifa uchun sokin yashil fon"), price: 60, theme: { bg: "ok-soft", accent: "ok" } },
  { code: "bg_space", kind: "background", title: L("Космический фон", "Koinot foni"), description: L("Синий фон с отблеском", "Yaltiroq koʻk fon"), price: 120, theme: { bg: "pen-soft", accent: "pen" } },
  { code: "frame_gold", kind: "hero_frame", title: L("Золотая рамка", "Oltin ramka"), description: L("Тёплая рамка вокруг героя", "Qahramon atrofida iliq ramka"), price: 50, theme: { bg: "warn-soft", accent: "warn" }, until: "2026-12-31T18:59:59Z" },
];

const BADGES: Array<{ code: string; metric: BadgeView["basis"]["metric"]; threshold: number; title: Localized; description: Localized }> = [
  { code: "first_lesson", metric: "lessons", threshold: 1, title: L("Первый урок", "Birinchi dars"), description: L("Пройден первый урок курса", "Kursning birinchi darsi oʻtildi") },
  { code: "streak_7", metric: "streak", threshold: 7, title: L("Неделя подряд", "Ketma-ket bir hafta"), description: L("7 дней по графику без пропусков", "Jadval boʻyicha 7 kun uzilishsiz") },
  { code: "streak_30", metric: "streak", threshold: 30, title: L("Месяц подряд", "Ketma-ket bir oy"), description: L("30 дней по графику", "Jadval boʻyicha 30 kun") },
  { code: "skills_10", metric: "skills", threshold: 10, title: L("10 навыков", "10 ta koʻnikma"), description: L("10 подтверждённых навыков", "10 ta tasdiqlangan koʻnikma") },
  { code: "skill_retained", metric: "skill_retained", threshold: 1, title: L("Закреплено", "Mustahkamlandi"), description: L("Первый навык закреплён в повторении", "Birinchi koʻnikma takrorlashda mustahkamlandi") },
  { code: "reviews_100", metric: "reviews_cards", threshold: 100, title: L("100 карточек", "100 ta karta"), description: L("Повторено 100 карточек", "100 ta karta takrorlandi") },
  { code: "readings_10", metric: "readings", threshold: 10, title: L("10 текстов", "10 ta matn"), description: L("Прочитано 10 текстов", "10 ta matn oʻqildi") },
  { code: "first_freeze", metric: "freeze", threshold: 1, title: L("Серия спасена", "Seriya saqlandi"), description: L("Заморозка впервые сохранила серию", "Muzlatish birinchi marta seriyani saqladi") },
];

interface State {
  xp: number;
  til: number;
  freeze: number;
  hero: string | null;
  stage: HeroStage;
  skills: number;
  settings: GameSettings;
  equipment: { background: string | null; frame: string | null };
  owned: Set<string>;
  ops: GameOperation[];
  quests: Quest[];
  bonusReceived: boolean;
  counters: Record<BadgeView["basis"]["metric"], number>;
  earned: Map<string, string>;
  purchases: Map<string, { body: string; result: PurchaseResult }>;
  rewardReads: Map<string, number>;
  rewarded: Map<string, SessionRewards>;
}

export class MockGame {
  readonly sc: GameScenario;
  readonly states = new Map<string, State>();
  /** every handled purchase (not repeats of a key) */
  purchasesMade = 0;
  private seq = 1;
  private dropOnce: boolean;

  constructor(sc: GameScenario, private readonly kids: (owner: string) => boolean) {
    this.sc = sc;
    this.dropOnce = !!sc.dropPurchaseOnce;
  }

  get down(): boolean {
    return this.sc.mode === "down";
  }

  /** whether the answer of this purchase must be lost (once) */
  takeDrop(): boolean {
    if (!this.dropOnce) return false;
    this.dropOnce = false;
    return true;
  }

  state(owner: string): State {
    let s = this.states.get(owner);
    if (s) return s;
    const sc = this.sc;
    const kid = this.kids(owner);
    s = {
      xp: sc.xp ?? 120,
      til: sc.til ?? 85,
      freeze: sc.freeze ?? 2,
      hero: sc.hero === undefined ? (kid ? "pet_0" : "robot_0") : sc.hero,
      stage: sc.stage ?? 1,
      skills: sc.skills ?? 3,
      settings: { auto_freeze: true, quests_hidden: !!sc.questsHidden, celebrations: sc.celebrations ?? (kid ? "quiet" : "full"), game_notifications: true },
      equipment: { background: null, frame: null },
      owned: new Set(),
      ops: [],
      quests: [
        { slot: 1, code: "lesson_1", kind: "lesson_complete", target: 1, progress: 0, status: "active", reward: { xp: 10, til: 5 } },
        { slot: 2, code: "review_10", kind: "review_cards", target: 10, progress: 4, status: "active", reward: { xp: 10, til: 5 } },
        { slot: 3, code: "reading_1", kind: "reading_complete", target: 1, progress: 1, status: "completed", reward: { xp: 10, til: 5 } },
      ],
      bonusReceived: false,
      counters: { lessons: 3, streak: 4, skills: sc.skills ?? 3, skill_retained: 0, reviews_cards: 42, readings: 2, freeze: 0 },
      earned: new Map([["first_lesson", "2026-11-12T15:20:00Z"]]),
      purchases: new Map(),
      rewardReads: new Map(),
      rewarded: new Map(),
    };
    this.seedLedger(s);
    this.states.set(owner, s);
    return s;
  }

  private op(s: State, currency: GameCurrency, amount: number, reason: GameReason, at: number, extra: Partial<GameOperation> = {}): GameOperation {
    const o: GameOperation = {
      op_id: `0b000000-aaaa-4bbb-8ccc-${String(this.seq++).padStart(12, "0")}`,
      currency,
      amount,
      reason,
      capped: false,
      multiplier: 1,
      status: "confirmed",
      created_at: new Date(at).toISOString(),
      ...extra,
    };
    s.ops.unshift(o);
    return o;
  }

  /** The history: a registration gift, lessons, reviews, quests, a capped one, an event ×2, a staff correction and its
   *  reversal — 34 operations (two pages of 30). */
  private seedLedger(s: State): void {
    const base = Date.parse("2026-11-10T09:00:00Z");
    const H = 3600_000;
    this.op(s, "freeze", 2, "registration_bonus", base);
    for (let i = 0; i < 12; i++) {
      const at = base + (i + 1) * 9 * H;
      this.op(s, "xp", 20, i % 3 === 2 ? "review" : "lesson", at);
      this.op(s, "til", 5, i % 3 === 2 ? "review" : "lesson", at + 1000);
    }
    this.op(s, "xp", 10, "quest", base + 120 * H);
    this.op(s, "til", 5, "quest", base + 120 * H + 1000);
    this.op(s, "xp", 20, "reading", base + 140 * H, { multiplier: 2 });
    this.op(s, "til", 3, "reading", base + 140 * H + 1000, { capped: true });
    const wrong = this.op(s, "til", 10, "manual", base + 150 * H);
    const rev = this.op(s, "til", -10, "reversal", base + 151 * H);
    wrong.status = "reversed";
    void rev;
    this.op(s, "til", 15, "manual", base + 152 * H);
    this.op(s, "freeze", 1, "shop", base + 160 * H);
    this.op(s, "til", -40, "shop", base + 160 * H + 1000);
  }

  private level(xp: number): { level: number; start: number; next: number | null } {
    const level = LEVELS.filter((t) => t <= xp).length;
    return { level, start: LEVELS[level - 1] ?? 0, next: LEVELS[level] ?? null };
  }

  private ref(code: string | null) {
    const d = ITEMS.find((i) => i.code === code);
    return d ? { code: d.code, kind: d.kind, title: d.title, image: null, theme: d.theme } : null;
  }

  private quests(s: State): DailyQuests {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" }).format(new Date());
    return { local_date: today, hidden: s.settings.quests_hidden, items: s.settings.quests_hidden ? [] : s.quests.map((q) => ({ ...q })), all_done_bonus: { xp: 10, til: 10 }, bonus_received: s.bonusReceived };
  }

  private events(): ActiveGameEvent[] {
    if (!this.sc.event) return [];
    return [
      {
        event_id: "e7000000-aaaa-4bbb-8ccc-000000000001",
        title: L("Неделя чтения ×2 XP", "Oʻqish haftaligi ×2 XP"),
        description: L("За чтение — вдвое больше опыта.", "Oʻqish uchun ikki baravar koʻp tajriba."),
        ends_at: new Date(Date.now() + 3 * 86400_000).toISOString(),
        multipliers: [{ action: "reading", currency: "xp", factor: 2 }],
      },
    ];
  }

  summary(owner: string): GameSummary {
    const s = this.state(owner);
    const lv = this.level(s.xp);
    const h = s.hero ? CATALOGUE.find((x) => x.code === s.hero) : null;
    const view = h ? heroView(h) : null;
    const st = view?.stages.find((x) => x.stage === s.stage);
    return {
      level: lv.level,
      xp_total: s.xp,
      xp_level_start: lv.start,
      xp_next_level: lv.next,
      til_balance: s.til,
      freeze_stock: s.freeze,
      freeze_max: FREEZE_MAX,
      freeze_price_til: FREEZE_PRICE,
      hero: view && st ? { code: view.code, name: view.name, stage: s.stage, stage_name: st.name, image: st.image, confirmed_skills: s.skills, next_stage_at: s.stage >= 3 ? null : Math.max(0, STAGE_AT[s.stage]! - s.skills) } : null,
      quests: this.quests(s),
      events: this.events(),
      equipment: { background: this.ref(s.equipment.background), frame: this.ref(s.equipment.frame) },
      settings: { ...s.settings },
      purchase_available: false,
    };
  }

  private shop(owner: string) {
    const s = this.state(owner);
    const items: ShopItemView[] = ITEMS.map((d) => {
      const owned = d.kind !== "streak_freeze" && s.owned.has(d.code);
      const full = d.kind === "streak_freeze" && s.freeze >= FREEZE_MAX;
      const reason = owned ? "owned" : full ? "freeze_full" : s.til < d.price ? "not_enough_tils" : null;
      return {
        code: d.code,
        kind: d.kind,
        title: d.title,
        image: null,
        theme: d.theme,
        description: d.description,
        price_til: d.price,
        owned,
        equipped: s.equipment.background === d.code || s.equipment.frame === d.code,
        can_buy: reason === null,
        reason_unavailable: reason,
        available_until: d.until ?? null,
      };
    });
    return { items, til_balance: s.til, freeze_stock: s.freeze, freeze_max: FREEZE_MAX };
  }

  private badges(owner: string): BadgeView[] {
    const s = this.state(owner);
    const out = BADGES.map((b): BadgeView => {
      const at = s.earned.get(b.code) ?? null;
      return { code: b.code, title: b.title, description: b.description, image: null, earned_at: at, basis: { metric: b.metric, value: at ? Math.max(b.threshold, s.counters[b.metric]) : s.counters[b.metric], threshold: b.threshold } };
    });
    return out.sort((a, b) => (!!a.earned_at === !!b.earned_at ? 0 : a.earned_at ? -1 : 1));
  }

  /** The rewards of a session (any id): pending for `pendingReads` reads, then the operations are credited once. */
  private rewards(owner: string, sessionId: string): SessionRewards {
    const s = this.state(owner);
    const r = this.sc.rewards ?? {};
    const reads = (s.rewardReads.get(sessionId) ?? 0) + 1;
    s.rewardReads.set(sessionId, reads);
    const empty: SessionRewards = { status: "pending", operations: [], level_up: null, hero_stage_up: null, badges: [], quests_completed: [] };
    if (r.outcome === "never" || reads <= (r.pendingReads ?? 1)) return empty;
    if (r.outcome === "none") return { ...empty, status: "none" };
    const done = s.rewarded.get(sessionId);
    if (done) return done;
    const at = Date.now();
    const mult = r.multiplier ?? 1;
    const fromLevel = this.level(s.xp).level;
    const ops: GameOperation[] = [];
    const xp = r.levelUp ? Math.max(30, (LEVELS[fromLevel] ?? 0) - s.xp + 5) : 30;
    ops.push(this.op(s, "xp", xp * mult, "lesson", at, { multiplier: mult }));
    ops.push(this.op(s, "til", r.capped ? 2 : 5, "lesson", at + 1, { capped: !!r.capped }));
    s.xp += xp * mult;
    s.til += r.capped ? 2 : 5;
    const quests: Quest[] = [];
    if (r.quest !== false) {
      const q = s.quests.find((x) => x.code === "lesson_1")!;
      q.progress = 1;
      q.status = "completed";
      quests.push({ ...q });
      ops.push(this.op(s, "xp", 10, "quest", at + 2));
      ops.push(this.op(s, "til", 5, "quest", at + 3));
      s.xp += 10;
      s.til += 5;
    }
    const toLevel = this.level(s.xp).level;
    let heroUp: SessionRewards["hero_stage_up"] = null;
    if (r.heroUp && s.stage < 3) {
      heroUp = { from: s.stage, to: (s.stage + 1) as HeroStage };
      s.stage = heroUp.to;
      s.skills = Math.max(s.skills, STAGE_AT[s.stage - 1]!);
      s.counters.skills = s.skills;
    }
    const badges: BadgeView[] = [];
    if (r.badge) {
      s.earned.set("skill_retained", new Date(at).toISOString());
      s.counters.skill_retained = 1;
      badges.push(this.badges(owner).find((b) => b.code === "skill_retained")!);
    }
    const out: SessionRewards = { status: "ready", operations: ops.map((o) => ({ ...o })), level_up: toLevel > fromLevel ? { from: fromLevel, to: toLevel } : null, hero_stage_up: heroUp, badges, quests_completed: quests };
    s.rewarded.set(sessionId, out);
    return out;
  }

  rewardReads(owner: string, sessionId?: string): number {
    const m = this.state(owner).rewardReads;
    if (sessionId) return m.get(sessionId) ?? 0;
    return [...m.values()].reduce((a, b) => a + b, 0);
  }

  /** GET /v1/game/assets/{id}/{sha} — public bytes, or null */
  asset(path: string): { body: Buffer; sha: string } | null {
    const m = /^\/v1\/game\/assets\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9]+)$/.exec(path);
    if (!m) return null;
    const a = assets.get(m[1]!);
    if (!a || a.sha !== m[2]) return null;
    return { body: a.bytes, sha: a.sha };
  }

  handle(method: string, path: string, q: URLSearchParams, b: Record<string, unknown>, headers: Record<string, string>, owner: string): Res | null {
    if (!path.startsWith("/v1/game/")) return null;
    if (this.down) return fail(503, "GAME_UNAVAILABLE", { service: "gamification" });
    const key = `${method} ${path}`;
    const s = this.state(owner);
    const kid = this.kids(owner);

    if (key === "GET /v1/game/summary") return ok(this.summary(owner));
    if (key === "GET /v1/game/heroes") {
      const items = CATALOGUE.map(heroView);
      const ordered = kid ? [...items.filter((h) => h.line === "pet"), ...items.filter((h) => h.line !== "pet")] : items;
      return ok({ items: ordered, selected: s.hero, stage: s.stage });
    }
    if (key === "PUT /v1/game/hero") {
      const code = String(b.hero_code ?? "");
      if (!CATALOGUE.some((h) => h.code === code)) return fail(404, "HERO_NOT_FOUND");
      // free, XP / the level / the stage stay (AT-65)
      s.hero = code;
      return ok(this.summary(owner));
    }
    if (key === "GET /v1/game/quests") return ok(this.quests(s));
    if (key === "GET /v1/game/badges") return ok({ items: this.badges(owner) });
    if (key === "GET /v1/game/shop") return ok(this.shop(owner));
    if (key === "POST /v1/game/shop/purchases") {
      const idem = headers["idempotency-key"];
      if (!idem) return fail(422, "IDEMPOTENCY_KEY_REQUIRED");
      const code = String(b.item_code ?? "");
      const body = JSON.stringify({ item_code: code });
      const prev = s.purchases.get(idem);
      if (prev) return prev.body === body ? ok(prev.result) : fail(422, "IDEMPOTENCY_KEY_REUSED");
      const d = ITEMS.find((i) => i.code === code);
      if (!d) return fail(404, "ITEM_NOT_FOUND");
      if (d.kind !== "streak_freeze" && s.owned.has(code)) return fail(409, "ALREADY_OWNED");
      if (d.kind === "streak_freeze" && s.freeze >= FREEZE_MAX) return fail(409, "FREEZE_STOCK_FULL", { max: FREEZE_MAX });
      if (s.til < d.price) return fail(409, "INSUFFICIENT_TILS", { price: d.price, balance: s.til, missing: d.price - s.til, purchase_available: false });
      const at = Date.now();
      this.op(s, "til", -d.price, "shop", at);
      s.til -= d.price;
      if (d.kind === "streak_freeze") {
        this.op(s, "freeze", 1, "shop", at + 1);
        s.freeze += 1;
      } else s.owned.add(code);
      this.purchasesMade += 1;
      const result: PurchaseResult = { purchase_id: `0c000000-aaaa-4bbb-8ccc-${String(this.seq++).padStart(12, "0")}`, item_code: code, price_til: d.price, til_balance: s.til, freeze_stock: s.freeze, purchased_at: new Date(at).toISOString() };
      s.purchases.set(idem, { body, result });
      return ok(result);
    }
    if (key === "PUT /v1/game/equipment") {
      const bg = (b.background_code ?? null) as string | null;
      const fr = (b.frame_code ?? null) as string | null;
      const okKind = (c: string | null, kind: ShopItemKind) => c === null || (s.owned.has(c) && ITEMS.some((i) => i.code === c && i.kind === kind));
      if (!okKind(bg, "background") || !okKind(fr, "hero_frame")) return fail(409, "NOT_OWNED");
      s.equipment = { background: bg, frame: fr };
      return ok(this.summary(owner));
    }
    if (key === "GET /v1/game/history") {
      const cur = q.get("currency");
      const all = s.ops.filter((o) => !cur || o.currency === cur);
      const at = Number(q.get("cursor") ?? 0) || 0;
      const page = all.slice(at, at + 30);
      return ok({ items: page.map((o) => ({ ...o })), next_cursor: at + 30 < all.length ? String(at + 30) : null });
    }
    if (key === "GET /v1/game/rewards") {
      const id = q.get("source_session_id") ?? "";
      if (!id) return fail(422, "VALIDATION_ERROR", { in: "query", field: "source_session_id" });
      return ok(this.rewards(owner, id));
    }
    if (key === "GET /v1/game/settings") return ok({ ...s.settings });
    if (key === "PATCH /v1/game/settings") {
      const allowed = ["auto_freeze", "quests_hidden", "celebrations", "game_notifications"];
      if (Object.keys(b).some((k) => !allowed.includes(k))) return fail(422, "VALIDATION_ERROR");
      if (b.celebrations !== undefined && b.celebrations !== "full" && b.celebrations !== "quiet") return fail(422, "VALIDATION_ERROR");
      s.settings = { ...s.settings, ...(b as Partial<GameSettings>) };
      return ok({ ...s.settings });
    }
    return fail(404, "NOT_FOUND");
  }
}
