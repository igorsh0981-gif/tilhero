/**
 * Sprint 6 fixture data of the mock admin-bff: the 9 heroes with the 27 seed pictures of gamification
 * (services/gamification/migrations/seed/heroes/*.webp — read from disk; a generated PNG stands in when a file is
 * missing), the versions of the rules (v1 archived = INTERNAL_API §1.3, v2 active), the shop, the events of the week
 * and two learners' wallets with their ledgers. Shapes — packages/contracts/src/admin.ts «Игра и герои».
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import type { AdminGameEvent, AdminLedgerOperation, AdminShopItem, GameAudience, GameRules, Localized, RulesVersion, StaffRef } from "@tilhero/contracts/admin";
import type { HeroLine, HeroStage } from "@tilhero/contracts/bff";
import { DAY, HOUR, ID, iso, LEARNER, MIN } from "./data";

/* ---------------------------------------------------------------- pictures */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A real (decodable) RGBA PNG: a soft disc of the colour on a transparent background. */
export function makePng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const rows: Buffer[] = [];
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.42;
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const a = d < r ? 255 : d < r + 2 ? 120 : 0;
      const shade = 1 - (y / h) * 0.35;
      row.writeUInt8(Math.round(rgb[0] * shade), 1 + x * 4);
      row.writeUInt8(Math.round(rgb[1] * shade), 2 + x * 4);
      row.writeUInt8(Math.round(rgb[2] * shade), 3 + x * 4);
      row.writeUInt8(a, 4 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

/** Size of a picture by its header (PNG IHDR, WebP VP8X / VP8L / VP8) — what gamification checks; null — not a picture. */
export function sniff(b: Buffer): { mime: "image/png" | "image/webp"; width: number; height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("ascii", 12, 16) === "IHDR") return { mime: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const c = b.toString("ascii", 12, 16);
    if (c === "VP8X") return { mime: "image/webp", width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    if (c === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (c === "VP8 ") return { mime: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

export interface MockAsset {
  asset_id: string;
  bytes: Buffer;
  mime: "image/png" | "image/webp";
  width: number;
  height: number;
  sha256: string;
  purpose: "hero_stage" | "shop_item" | "badge";
}

export const assetId = (n: number) => `ab000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function asset(n: number, bytes: Buffer, purpose: MockAsset["purpose"]): MockAsset {
  const s = sniff(bytes)!;
  return { asset_id: assetId(n), bytes, mime: s.mime, width: s.width, height: s.height, sha256: createHash("sha256").update(bytes).digest("hex"), purpose };
}

const SEED_DIR = new URL("../../../../services/gamification/migrations/seed/heroes/", import.meta.url);
const LINE_RGB: Record<HeroLine, [number, number, number]> = { robot: [90, 120, 220], pet: [70, 170, 110], human: [220, 140, 70] };

function seedPicture(code: string, stage: HeroStage, line: HeroLine): Buffer {
  const f = new URL(`${code}_${stage}.webp`, SEED_DIR);
  try {
    if (existsSync(f)) return readFileSync(f);
  } catch {
    /* fall through */
  }
  return makePng(120 + stage * 30, 160 + stage * 30, LINE_RGB[line]);
}

/* ---------------------------------------------------------------- heroes */

export interface HeroSeed {
  code: string;
  line: HeroLine;
  order: number;
  name: Localized;
  tagline: Localized;
  stageNames: [Localized, Localized, Localized];
  learners: number;
}

const ROBOT: HeroSeed["stageNames"] = [{ ru: "Сборка", uz: "Yigʻilish" }, { ru: "Запуск", uz: "Ishga tushish" }, { ru: "Полёт", uz: "Parvoz" }];
const PET: HeroSeed["stageNames"] = [{ ru: "Яйцо", uz: "Tuxum" }, { ru: "Малыш", uz: "Chaqaloq" }, { ru: "Крылья", uz: "Qanotlar" }];
const HUMAN: HeroSeed["stageNames"] = [{ ru: "Новичок", uz: "Yangi boshlovchi" }, { ru: "Путешественник", uz: "Sayohatchi" }, { ru: "Знаток", uz: "Bilimdon" }];

export const HEROES: HeroSeed[] = [
  { code: "robot_0", line: "robot", order: 1, name: { ru: "Робот Вольт", uz: "Robot Volt" }, tagline: { ru: "Заряжается от каждого урока", uz: "Har bir darsdan quvvat oladi" }, stageNames: ROBOT, learners: 214 },
  { code: "robot_1", line: "robot", order: 2, name: { ru: "Робот Искра", uz: "Robot Uchqun" }, tagline: { ru: "Зажигает новые слова", uz: "Yangi soʻzlarni yoqadi" }, stageNames: ROBOT, learners: 96 },
  { code: "robot_2", line: "robot", order: 3, name: { ru: "Робот Бриз", uz: "Robot Shabada" }, tagline: { ru: "Лёгкий, как ветер", uz: "Shamoldek yengil" }, stageNames: ROBOT, learners: 41 },
  { code: "pet_0", line: "pet", order: 4, name: { ru: "Дракончик Мятик", uz: "Ajdarcha Yalpiz" }, tagline: { ru: "Растёт вместе с тобой", uz: "Sen bilan birga oʻsadi" }, stageNames: PET, learners: 182 },
  { code: "pet_1", line: "pet", order: 5, name: { ru: "Дракончик Персик", uz: "Ajdarcha Shaftoli" }, tagline: { ru: "Любит повторять слова", uz: "Soʻzlarni takrorlashni yaxshi koʻradi" }, stageNames: PET, learners: 133 },
  { code: "pet_2", line: "pet", order: 6, name: { ru: "Дракончик Сирень", uz: "Ajdarcha Nastarin" }, tagline: { ru: "Читает сказки по слогам", uz: "Ertaklarni boʻgʻinlab oʻqiydi" }, stageNames: PET, learners: 0 },
  { code: "human_0", line: "human", order: 7, name: { ru: "Ученица Нилу", uz: "Oʻquvchi Nilu" }, tagline: { ru: "Собирается в путешествие", uz: "Sayohatga tayyorlanmoqda" }, stageNames: HUMAN, learners: 77 },
  { code: "human_1", line: "human", order: 8, name: { ru: "Ученик Тимур", uz: "Oʻquvchi Temur" }, tagline: { ru: "Не боится ошибок", uz: "Xatolardan qoʻrqmaydi" }, stageNames: HUMAN, learners: 58 },
  { code: "human_2", line: "human", order: 9, name: { ru: "Ученица Ая", uz: "Oʻquvchi Oya" }, tagline: { ru: "Говорит смело", uz: "Dadil gapiradi" }, stageNames: HUMAN, learners: 12 },
];

/** asset number of a hero stage picture: 1..27 */
export const heroAssetN = (i: number, stage: HeroStage) => i * 3 + stage;

export function seedAssets(): MockAsset[] {
  const out: MockAsset[] = [];
  HEROES.forEach((h, i) => {
    for (const s of [1, 2, 3] as const) out.push(asset(heroAssetN(i, s), seedPicture(h.code, s, h.line), "hero_stage"));
  });
  // shop pictures: a golden frame and a starry background
  out.push(asset(101, makePng(256, 256, [212, 170, 60]), "shop_item"));
  out.push(asset(102, makePng(320, 200, [40, 50, 110]), "shop_item"));
  return out;
}

/** A new picture for the upload test (a decodable PNG 300×380). */
export const NEW_STAGE_PNG = () => makePng(300, 380, [190, 90, 200]);

/* ---------------------------------------------------------------- rules */

export const RULES_V1 = (): GameRules => ({
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
  levels: [0, 100, 250, 450, 700, 1000, 1350, 1750, 2200, 2700, 3250, 3850, 4500, 5200, 5950, 6750, 7600, 8500, 9450, 10450],
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
      { code: "scenario_1", kind: "scenario_complete", target: 1, reward: { xp: 10, til: 5 }, audiences: ["teens", "adults"], weight: 1 },
      { code: "media_1", kind: "media_complete", target: 1, reward: { xp: 10, til: 5 }, audiences: ["teens", "adults"], weight: 1 },
      { code: "skill_1", kind: "skill_confirmed", target: 1, reward: { xp: 15, til: 5 }, audiences: ["kids", "teens", "adults"], weight: 1 },
    ],
  },
  badges: { streak: [7, 30, 100], skills: [10, 50], reviews_cards: [100, 1000], readings: [10] },
});

export const RULES_V2 = (): GameRules => {
  const r = RULES_V1();
  r.earn.reading = { xp: 15, til: 5 };
  r.caps.til_per_day = 70;
  return r;
};

const staffRef = (staff_id: string, name: string): StaffRef => ({ staff_id, name });
export const SEED_STAFF: StaffRef = { staff_id: "00000000-0000-4000-8000-000000000000", name: "Сид (миграция)" };

export function rulesVersions(): RulesVersion[] {
  const v1: RulesVersion = {
    version: 1,
    status: "archived",
    comment: "Начальные правила игры (миграция)",
    based_on: null,
    created_by: SEED_STAFF,
    created_at: iso(-30 * DAY),
    validated_at: iso(-30 * DAY),
    activated_by: SEED_STAFF,
    activated_at: iso(-30 * DAY),
    payload: RULES_V1(),
    diff: [],
    updated_at: iso(-30 * DAY),
  };
  const v2: RulesVersion = {
    version: 2,
    status: "active",
    comment: "Чтение даёт больше: 15 XP и 5 тилов",
    based_on: 1,
    created_by: staffRef(ID.ops, "Тимур"),
    created_at: iso(-9 * DAY),
    validated_at: iso(-8 * DAY - 2 * HOUR),
    activated_by: staffRef(ID.ops, "Тимур"),
    activated_at: iso(-8 * DAY),
    payload: RULES_V2(),
    diff: [],
    updated_at: iso(-8 * DAY - 3 * HOUR),
  };
  return [v1, v2];
}

/* ---------------------------------------------------------------- shop */

export function shopItems(img: (n: number) => { asset_id: string; sha256: string; width: number; height: number; size: number }): AdminShopItem[] {
  const im = (n: number) => ({ ...img(n), url: `/admin/v1/game/assets/${img(n).asset_id}/content` });
  const base = { available_from: null, available_until: null, updated_at: iso(-5 * DAY) };
  return [
    { ...base, code: "streak_freeze", kind: "streak_freeze", title: { ru: "Заморозка серии", uz: "Seriya muzlatgichi" }, description: { ru: "Спасает серию в день без занятия", uz: "Darssiz kunda seriyani saqlaydi" }, image: null, theme: null, price_til: 40, audiences: ["kids", "teens", "adults"], status: "published", order: 0, owners: 0 },
    { ...base, code: "bg_night_notebook", kind: "background", title: { ru: "Ночная тетрадь", uz: "Tungi daftar" }, description: { ru: "Фон главной в синюю клетку", uz: "Bosh sahifa uchun koʻk katakli fon" }, image: null, theme: { bg: "--pen-soft", accent: "--ink" }, price_til: 120, audiences: ["kids", "teens", "adults"], status: "published", order: 10, owners: 12 },
    { ...base, code: "frame_gold", kind: "hero_frame", title: { ru: "Золотая рамка", uz: "Oltin ramka" }, description: { ru: "Рамка героя для тех, кто держит серию", uz: "Seriyani ushlab turganlar uchun ramka" }, image: im(101), theme: null, price_til: 300, audiences: ["teens", "adults"], status: "draft", order: 20, owners: 0 },
    { ...base, code: "bg_space", kind: "background", title: { ru: "Космос", uz: "Koinot" }, description: { ru: "Звёздный фон", uz: "Yulduzli fon" }, image: im(102), theme: null, price_til: 200, audiences: ["kids", "teens", "adults"], status: "retired", order: 30, owners: 3, available_until: iso(-3 * DAY) },
  ];
}

/* ---------------------------------------------------------------- events */

export const EVENT_ID = {
  readingWeek: "e6000000-0000-4000-8000-000000000001",
  kidsReading: "e6000000-0000-4000-8000-000000000002",
  reviewBoost: "e6000000-0000-4000-8000-000000000003",
  autumn: "e6000000-0000-4000-8000-000000000004",
  cancelled: "e6000000-0000-4000-8000-000000000005",
};

const day0 = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function events(): AdminGameEvent[] {
  const t0 = day0();
  const at = (days: number) => new Date(t0 + days * DAY).toISOString();
  const ops = staffRef(ID.ops, "Тимур");
  const content = staffRef(ID.content, "Ольга");
  return [
    { event_id: EVENT_ID.readingWeek, code: "reading_week", title: { ru: "Неделя чтения", uz: "Oʻqish haftaligi" }, description: { ru: "Чтение даёт вдвое больше опыта", uz: "Oʻqish ikki baravar koʻp tajriba beradi" }, starts_at: at(-2), ends_at: at(5), audiences: ["kids", "teens", "adults"], multipliers: [{ action: "reading", currency: "xp", factor: 2 }], status: "published", created_by: content, published_by: ops, updated_at: at(-3) },
    { event_id: EVENT_ID.kidsReading, code: "kids_reading", title: { ru: "Сказки для дракончиков", uz: "Ajdarchalar uchun ertaklar" }, description: { ru: "Читай сказки — дракончик растёт быстрее", uz: "Ertak oʻqi — ajdarcha tezroq oʻsadi" }, starts_at: at(1), ends_at: at(4), audiences: ["kids"], multipliers: [{ action: "reading", currency: "xp", factor: 1.5 }, { action: "reading", currency: "til", factor: 2 }], status: "draft", created_by: content, published_by: null, updated_at: at(-1) },
    { event_id: EVENT_ID.reviewBoost, code: "review_boost", title: { ru: "Марафон повторений", uz: "Takrorlash marafoni" }, description: { ru: "Повторения дают больше тилов", uz: "Takrorlash koʻproq til beradi" }, starts_at: at(8), ends_at: at(15), audiences: ["teens", "adults"], multipliers: [{ action: "review", currency: "til", factor: 2 }], status: "draft", created_by: ops, published_by: null, updated_at: at(-1) },
    { event_id: EVENT_ID.autumn, code: "autumn_start", title: { ru: "Осенний старт", uz: "Kuzgi start" }, description: { ru: "Уроки дают больше опыта в начале сезона", uz: "Mavsum boshida darslar koʻproq tajriba beradi" }, starts_at: at(-20), ends_at: at(-13), audiences: ["teens", "adults"], multipliers: [{ action: "lesson", currency: "xp", factor: 1.5 }], status: "finished", created_by: ops, published_by: ops, updated_at: at(-13) },
    { event_id: EVENT_ID.cancelled, code: "quest_fest", title: { ru: "Фестиваль заданий", uz: "Topshiriqlar festivali" }, description: { ru: "Задания дают втрое больше тилов", uz: "Topshiriqlar uch baravar koʻp til beradi" }, starts_at: at(-6), ends_at: at(-1), audiences: ["adults"], multipliers: [{ action: "quest", currency: "til", factor: 3 }], status: "cancelled", created_by: ops, published_by: ops, updated_at: at(-5) },
  ];
}

/* ---------------------------------------------------------------- wallets */

export const OP = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const PURCHASE = { madinaBg: "0f000000-0000-4000-8000-000000000001", madinaFreeze: "0f000000-0000-4000-8000-000000000002" };

export interface MockWallet {
  user_id: string;
  audience: GameAudience;
  hero: { code: string; stage: HeroStage } | null;
  confirmed_skills: number;
  owned: Array<{ code: string; kind: "background" | "hero_frame"; purchased_at: string; purchase_id: string; op_ids: string[] }>;
  quests: Array<{ code: string; kind: "lesson_complete" | "review_cards" | "reading_complete" | "xp_earned" | "skill_confirmed"; target: number; progress: number; status: string }>;
  badges: Array<{ code: string; earned_at: string }>;
  referrals: { pending: number; rewarded: number; capped: number };
  settings: { auto_freeze: boolean; quests_hidden: boolean };
  ledger: AdminLedgerOperation[];
}

const localDate = (ms: number) => {
  const d = new Date(Date.now() + ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function op(n: number, ago: number, currency: AdminLedgerOperation["currency"], amount: number, reason: AdminLedgerOperation["reason"], extra: Partial<AdminLedgerOperation> = {}): AdminLedgerOperation {
  return {
    op_id: OP(n),
    currency,
    amount,
    reason,
    source: { kind: "event", ref: `ev000000-0000-4000-8000-${String(n).padStart(12, "0")}` },
    rules_version: 2,
    multiplier: 1,
    capped: false,
    local_date: localDate(-ago),
    status: "confirmed",
    reversed_by: null,
    reversal_of: null,
    actor: "system",
    comment: null,
    created_at: iso(-ago),
    ...extra,
  };
}

export function wallets(): MockWallet[] {
  const madina: MockWallet = {
    user_id: LEARNER.madina,
    audience: "adults",
    hero: { code: "robot_0", stage: 2 },
    confirmed_skills: 7,
    owned: [{ code: "bg_night_notebook", kind: "background", purchased_at: iso(-3 * DAY), purchase_id: PURCHASE.madinaBg, op_ids: [OP(8)] }],
    quests: [
      { code: "lesson_1", kind: "lesson_complete", target: 1, progress: 1, status: "completed" },
      { code: "review_10", kind: "review_cards", target: 10, progress: 6, status: "active" },
      { code: "xp_50", kind: "xp_earned", target: 50, progress: 35, status: "active" },
    ],
    badges: [
      { code: "first_lesson", earned_at: iso(-20 * DAY) },
      { code: "streak_7", earned_at: iso(-6 * DAY) },
    ],
    referrals: { pending: 1, rewarded: 2, capped: 0 },
    settings: { auto_freeze: true, quests_hidden: false },
    ledger: [
      op(1, 21 * DAY, "freeze", 2, "registration_bonus", { rules_version: 1 }),
      op(2, 20 * DAY, "xp", 30, "lesson", { rules_version: 1 }),
      op(3, 20 * DAY, "til", 5, "lesson", { rules_version: 1 }),
      op(4, 9 * DAY, "xp", 250, "lesson", { rules_version: 1 }),
      op(5, 9 * DAY, "til", 220, "lesson", { rules_version: 1 }),
      op(6, 7 * DAY, "freeze", 1, "referral_bonus"),
      op(7, 5 * DAY, "freeze", -1, "streak_freeze"),
      // a freeze bought in the shop: two operations of one purchase (source.ref = purchase_id), no inventory item
      op(18, 4 * DAY, "til", -40, "shop", { source: { kind: "command", ref: PURCHASE.madinaFreeze }, actor: "learner" }),
      op(19, 4 * DAY, "freeze", 1, "shop", { source: { kind: "command", ref: PURCHASE.madinaFreeze }, actor: "learner" }),
      op(8, 3 * DAY, "til", -120, "shop", { source: { kind: "command", ref: PURCHASE.madinaBg }, actor: "learner" }),
      op(9, 2 * DAY, "xp", 30, "reading", { multiplier: 2 }),
      op(10, 2 * DAY, "til", 5, "reading"),
      op(11, 1 * DAY, "xp", 15, "skill_demonstrated"),
      op(12, 1 * DAY, "til", 5, "skill_demonstrated"),
      op(13, 5 * HOUR, "xp", 20, "lesson"),
      op(14, 5 * HOUR, "til", 2, "lesson", { capped: true }),
      op(15, 4 * HOUR, "xp", 10, "quest"),
      op(16, 2 * HOUR, "til", 25, "manual", { source: { kind: "staff", ref: "ad100000-0000-4000-8000-000000000001" }, actor: `staff:${ID.support}`, comment: "Компенсация за сбой урока, обращение TCK-1042", rules_version: null }),
      op(17, 30 * MIN, "til", 3, "review"),
    ],
  };
  const lola: MockWallet = {
    user_id: LEARNER.lola,
    audience: "kids",
    hero: { code: "pet_0", stage: 1 },
    confirmed_skills: 2,
    owned: [],
    quests: [{ code: "lesson_1", kind: "lesson_complete", target: 1, progress: 0, status: "active" }],
    badges: [{ code: "first_lesson", earned_at: iso(-4 * DAY) }],
    referrals: { pending: 0, rewarded: 0, capped: 0 },
    settings: { auto_freeze: true, quests_hidden: false },
    ledger: [op(101, 6 * DAY, "freeze", 2, "registration_bonus"), op(102, 4 * DAY, "xp", 20, "lesson"), op(103, 4 * DAY, "til", 5, "lesson")],
  };
  return [madina, lola];
}
