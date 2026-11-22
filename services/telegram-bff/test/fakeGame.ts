/**
 * Подделка gamification для тестов BFF (INTERNAL_API спринта 6 §1.4, §1.7–§1.9, §1.12): ученик — из claim `lrn` (sub —
 * аккаунт; без `lrn` — 401 USER_CONTEXT_MISSING). Ответы — формы bff.ts «Спринт 6»; картинки — {asset_id, sha256, width,
 * height} (url собирает BFF). В ответах — служебные поля домена (user_id, actor, comment сотрудника с меткой GAME_SECRET),
 * которые BFF обязан отбросить; переключатели для проверки строгости BFF.
 */
import { createHash, randomUUID } from "node:crypto";
import type * as C from "@tilhero/contracts/bff";
import type { Req } from "./helpers.js";

/** Метка служебных данных домена (комментарий сотрудника и т. п.): не должна встретиться ни в одном ответе BFF. */
export const GAME_SECRET = "GAME-STAFF-NOTE-42";
/** Сессия урока, у которой есть награды (GET /internal/v1/game/rewards). */
export const READY_SESSION = "5f0c6a1e-2b3d-4c5e-8f90-a1b2c3d4e5f6";

const L = (ru: string) => ({ ru, uz: `${ru} (uz)` });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const err = (status: number, code: string, details: Record<string, unknown> = {}) =>
  json(status, { code, message: `domain says ${code}`, trace_id: "domain-trace", details });

const KID_BANDS = new Set(["6-9", "10-13"]);
const AT = "2026-11-20T09:00:00Z";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Минимальные байты с верной сигнатурой: webp (RIFF…WEBP VP8L) и png (сигнатура + IHDR). */
export function webpBytes(seed: string): Buffer {
  const payload = Buffer.from(`VP8L${seed}`, "latin1");
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(4 + payload.length, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, payload]);
}
export function pngBytes(seed: string): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(`\x00\x00\x00\x0dIHDR${seed}`, "latin1")]);
}
export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export interface FakeAsset {
  asset_id: string;
  bytes: Buffer;
  mime: "image/webp" | "image/png";
  sha256: string;
  width: number;
  height: number;
  /** используется в опубликованном (иначе домен отвечает 404) */
  published: boolean;
}

interface Learner {
  lrn: string;
  kids: boolean;
}

interface Op extends C.GameOperation {
  actor: string;
  comment: string | null;
}

interface State {
  til: number;
  freeze: number;
  xp: number;
  hero: string | null;
  owned: Set<string>;
  equipment: { background: string | null; frame: string | null };
  settings: C.GameSettings;
  ops: Op[];
  purchases: Map<string, { body: string; result: C.PurchaseResult }>;
}

interface Item {
  code: string;
  kind: C.ShopItemKind;
  price: number;
  asset: string | null;
  available: boolean;
}

export class FakeGame {
  readonly assets = new Map<string, FakeAsset>();
  readonly state = new Map<string, State>();
  /** форма картинок в ответах: sha256 (как AdminGameImage) | готовый url того же пути | url чужого вида */
  imageMode: "sha" | "url" | "bad_url" = "sha";
  /** домен ошибочно говорит, что тилы можно купить за деньги — BFF всё равно отдаёт false */
  purchaseAvailable = true;
  /** сводка не по контракту */
  badSummary = false;
  /** ответ картинки: подмена ETag, тела, типа */
  assetEtag: ((a: FakeAsset) => string | null) | null = null;
  assetBody: Buffer | null = null;
  assetType: string | null = null;

  constructor() {
    const add = (id: string, bytes: Buffer, mime: FakeAsset["mime"], published = true) =>
      this.assets.set(id, { asset_id: id, bytes, mime, sha256: sha256(bytes), width: 300, height: 460, published });
    for (const hero of ["robot_0", "pet_0"]) for (const stage of [1, 2, 3]) add(`a-${hero}-${stage}`, webpBytes(`${hero}_${stage}`), "image/webp");
    add("a-bg-forest", pngBytes("forest"), "image/png");
    add("a-frame-gold", webpBytes("frame_gold"), "image/webp");
    add("a-badge-first", webpBytes("first_lesson"), "image/webp");
    add("a-draft", webpBytes("draft"), "image/webp", false);
  }

  private readonly items: Item[] = [
    { code: "bg_forest", kind: "background", price: 50, asset: "a-bg-forest", available: true },
    { code: "frame_gold", kind: "hero_frame", price: 80, asset: "a-frame-gold", available: true },
    { code: "streak_freeze", kind: "streak_freeze", price: 40, asset: null, available: true },
    { code: "bg_retired", kind: "background", price: 10, asset: null, available: false },
  ];

  private readonly heroes: Record<string, { line: C.HeroLine; name: string; stages: [string, string, string] }> = {
    robot_0: { line: "robot", name: "Робот Вольт", stages: ["Сборка", "Запуск", "Полёт"] },
    pet_0: { line: "pet", name: "Дракончик Мятик", stages: ["Яйцо", "Малыш", "Крылья"] },
  };

  of(lrn: string, kids = false): State {
    let st = this.state.get(lrn);
    if (!st) {
      st = {
        til: 100,
        freeze: 1,
        xp: 120,
        hero: null,
        owned: new Set(),
        equipment: { background: null, frame: null },
        settings: { auto_freeze: true, quests_hidden: false, celebrations: kids ? "quiet" : "full", game_notifications: true, league_opt_in: false },
        ops: [
          { op_id: randomUUID(), currency: "xp", amount: 20, reason: "lesson", capped: false, multiplier: 1, status: "confirmed", created_at: "2026-11-20T09:00:00Z", actor: "system", comment: null },
          { op_id: randomUUID(), currency: "til", amount: 5, reason: "lesson", capped: true, multiplier: 2, status: "confirmed", created_at: "2026-11-20T08:00:00Z", actor: "system", comment: null },
          { op_id: randomUUID(), currency: "til", amount: 30, reason: "manual", capped: false, multiplier: 1, status: "confirmed", created_at: "2026-11-19T08:00:00Z", actor: "staff:s-1", comment: GAME_SECRET },
          { op_id: randomUUID(), currency: "freeze", amount: 2, reason: "registration_bonus", capped: false, multiplier: 1, status: "confirmed", created_at: "2026-11-18T08:00:00Z", actor: "system", comment: null },
        ],
        purchases: new Map(),
      };
      this.state.set(lrn, st);
    }
    return st;
  }

  image(id: string | null): Record<string, unknown> | null {
    if (!id) return null;
    const a = this.assets.get(id)!;
    const base = { asset_id: a.asset_id, width: a.width, height: a.height, size: a.bytes.length };
    if (this.imageMode === "url") return { ...base, url: `/v1/game/assets/${a.asset_id}/${a.sha256.toUpperCase()}` };
    if (this.imageMode === "bad_url") return { ...base, url: `http://gamification.railway.internal:8117/internal/v1/game/assets/${a.asset_id}` };
    return { ...base, sha256: a.sha256 };
  }

  private itemRef(i: Item) {
    return { code: i.code, kind: i.kind, title: L(i.code), image: this.image(i.asset), theme: i.kind === "background" ? { bg: "game.bg.forest", accent: "game.accent.green" } : null, status: "published" };
  }

  private quests(st: State): C.DailyQuests {
    return {
      local_date: "2026-11-20",
      hidden: st.settings.quests_hidden,
      items: st.settings.quests_hidden
        ? []
        : [
            { slot: 1, code: "lesson_1", kind: "lesson_complete", target: 1, progress: 1, status: "completed", reward: { xp: 10, til: 5 } },
            { slot: 2, code: "review_10", kind: "review_cards", target: 10, progress: 4, status: "active", reward: { xp: 10, til: 5 } },
            { slot: 3, code: "reading_1", kind: "reading_complete", target: 1, progress: 0, status: "active", reward: { xp: 10, til: 5 } },
          ],
      all_done_bonus: { xp: 10, til: 10 },
      bonus_received: false,
    };
  }

  private heroView(code: string) {
    const h = this.heroes[code]!;
    return {
      code,
      line: h.line,
      name: L(h.name),
      tagline: L(`${h.name} — слоган`),
      stages: h.stages.map((name, i) => ({ stage: i + 1, name: L(name), image: this.image(`a-${code}-${i + 1}`), skills_required: [0, 5, 15][i] })),
      audiences: ["kids", "teens", "adults"],
    };
  }

  private badge(earned: boolean) {
    return earned
      ? { code: "first_lesson", title: L("Первый урок"), description: L("Пройди первый урок"), image: this.image("a-badge-first"), earned_at: AT, basis: { metric: "lessons", value: 1, threshold: 1, event_id: randomUUID() } }
      : { code: "streak_7", title: L("Неделя подряд"), description: L("7 дней подряд"), image: null, earned_at: null, basis: { metric: "streak", value: 3, threshold: 7 } };
  }

  summary(l: Learner): unknown {
    const st = this.of(l.lrn, l.kids);
    if (this.badSummary) return { level: "two", user_id: l.lrn };
    const h = st.hero ? this.heroes[st.hero]! : null;
    const ref = (code: string | null) => (code ? this.itemRef(this.items.find((i) => i.code === code)!) : null);
    return {
      level: 2,
      xp_total: st.xp,
      xp_level_start: 100,
      xp_next_level: 250,
      til_balance: st.til,
      freeze_stock: st.freeze,
      freeze_max: 5,
      freeze_price_til: 40,
      hero: h
        ? { code: st.hero, name: L(h.name), stage: 1, stage_name: L(h.stages[0]), image: this.image(`a-${st.hero}-1`), confirmed_skills: 2, next_stage_at: 3 }
        : null,
      quests: this.quests(st),
      events: [{ event_id: randomUUID(), title: L("Неделя чтения"), description: L("×2 XP за чтение"), ends_at: "2026-11-27T00:00:00Z", multipliers: [{ action: "reading", currency: "xp", factor: 2 }], created_by: "staff:s-1" }],
      equipment: { background: ref(st.equipment.background), frame: ref(st.equipment.frame) },
      settings: st.settings,
      purchase_available: this.purchaseAvailable,
      user_id: l.lrn,
      rules_version: 1,
    };
  }

  route(r: Req): Response {
    // картинки: без ученика (публичное содержимое), только используемые в опубликованном
    const asset = /^\/internal\/v1\/game\/assets\/([^/]+)$/.exec(r.path);
    if (asset && r.method === "GET") return this.assetRoute(decodeURIComponent(asset[1]!));

    const lrn = typeof r.claims.lrn === "string" ? r.claims.lrn : null;
    if (!lrn) return err(401, "USER_CONTEXT_MISSING");
    const band = typeof r.claims.age_band === "string" ? r.claims.age_band : null;
    const l: Learner = { lrn, kids: lrn !== r.subject || (band !== null && KID_BANDS.has(band)) };
    const st = this.of(l.lrn, l.kids);
    switch (`${r.method} ${r.path}`) {
      case "GET /internal/v1/game/summary":
        return json(200, this.summary(l));
      case "GET /internal/v1/game/heroes": {
        const order = l.kids ? ["pet_0", "robot_0"] : ["robot_0", "pet_0"];
        return json(200, { items: order.map((c) => this.heroView(c)), selected: st.hero, stage: 1 });
      }
      case "PUT /internal/v1/game/hero": {
        const code = (r.body as { hero_code?: string }).hero_code ?? "";
        if (code === "robot_9") return err(409, "HERO_NOT_AVAILABLE");
        if (!this.heroes[code]) return err(404, "HERO_NOT_FOUND");
        st.hero = code;
        return json(200, this.summary(l));
      }
      case "GET /internal/v1/game/quests":
        return json(200, { ...this.quests(st), user_id: l.lrn, rules_version: 1 });
      case "GET /internal/v1/game/badges":
        return json(200, { items: [this.badge(true), this.badge(false)] });
      case "GET /internal/v1/game/shop":
        return json(200, {
          items: this.items
            .filter((i) => i.available)
            .map((i) => {
              const owned = st.owned.has(i.code);
              const full = i.kind === "streak_freeze" && st.freeze >= 5;
              const reason = owned ? "owned" : full ? "freeze_full" : st.til < i.price ? "not_enough_tils" : null;
              return {
                ...this.itemRef(i),
                description: L(`${i.code} — описание`),
                price_til: i.price,
                owned,
                equipped: st.equipment.background === i.code || st.equipment.frame === i.code,
                can_buy: reason === null,
                reason_unavailable: reason,
                available_until: null,
                audiences: ["kids", "teens", "adults"],
              };
            }),
          til_balance: st.til,
          freeze_stock: st.freeze,
          freeze_max: 5,
        });
      case "POST /internal/v1/game/purchases":
        return this.purchase(r, l, st);
      case "PUT /internal/v1/game/equipment": {
        const b = r.body as { background_code: string | null; frame_code: string | null };
        for (const [code, kind] of [[b.background_code, "background"], [b.frame_code, "hero_frame"]] as const) {
          if (code !== null && (!st.owned.has(code) || this.items.find((i) => i.code === code)?.kind !== kind)) return err(409, "NOT_OWNED", { item_code: code });
        }
        st.equipment = { background: b.background_code, frame: b.frame_code };
        return json(200, this.summary(l));
      }
      case "GET /internal/v1/game/history": {
        const all = st.ops.filter((o) => !r.query.currency || o.currency === r.query.currency);
        const page = r.query.cursor === "p2" ? all.slice(2) : all.slice(0, 2);
        return json(200, { items: page.map((o) => ({ ...o, user_id: l.lrn, source_label: o.reason })), next_cursor: r.query.cursor === "p2" || all.length <= 2 ? null : "p2" });
      }
      case "GET /internal/v1/game/rewards": {
        if (r.query.source_session_id !== READY_SESSION) return json(200, { status: "none", operations: [], level_up: null, hero_stage_up: null, badges: [], quests_completed: [] });
        return json(200, {
          status: "ready",
          operations: st.ops.slice(0, 2).map((o) => ({ ...o, source_session_id: READY_SESSION })),
          level_up: { from: 1, to: 2 },
          hero_stage_up: null,
          badges: [this.badge(true)],
          quests_completed: [this.quests(st).items[0]],
        });
      }
      case "GET /internal/v1/game/settings":
        return json(200, { ...st.settings, user_id: l.lrn });
      case "PATCH /internal/v1/game/settings":
        st.settings = { ...st.settings, ...(r.body as Partial<C.GameSettings>) };
        return json(200, st.settings);
    }
    return err(404, "NOT_FOUND");
  }

  private purchase(r: Req, l: Learner, st: State): Response {
    const key = r.headers["idempotency-key"];
    if (!key) return err(422, "IDEMPOTENCY_KEY_REQUIRED");
    const body = JSON.stringify(r.body);
    const prev = st.purchases.get(key);
    if (prev) return prev.body === body ? json(200, prev.result) : err(422, "IDEMPOTENCY_KEY_REUSED");
    const code = (r.body as { item_code?: string }).item_code ?? "";
    const item = this.items.find((i) => i.code === code);
    if (!item) return err(404, "ITEM_NOT_FOUND");
    if (!item.available) return err(410, "ITEM_NOT_AVAILABLE");
    if (item.kind !== "streak_freeze" && st.owned.has(code)) return err(409, "ALREADY_OWNED");
    if (item.kind === "streak_freeze" && st.freeze >= 5) return err(409, "FREEZE_STOCK_FULL", { max: 5 });
    // домен ошибочно признаёт покупку за деньги — BFF обязан отдать false
    if (st.til < item.price) return err(409, "INSUFFICIENT_TILS", { price: item.price, balance: st.til, missing: item.price - st.til, purchase_available: true });
    st.til -= item.price;
    if (item.kind === "streak_freeze") st.freeze += 1;
    else st.owned.add(code);
    const result = { purchase_id: randomUUID(), item_code: code, price_til: item.price, til_balance: st.til, freeze_stock: st.freeze, purchased_at: AT };
    st.purchases.set(key, { body, result });
    return json(200, { ...result, user_id: l.lrn, op_ids: [randomUUID()] });
  }

  private assetRoute(id: string): Response {
    const a = this.assets.get(id);
    if (!a || !a.published) return err(404, "ASSET_NOT_FOUND");
    const etag = this.assetEtag ? this.assetEtag(a) : `"${a.sha256}"`;
    return new Response(new Uint8Array(this.assetBody ?? a.bytes), {
      status: 200,
      headers: {
        "content-type": this.assetType ?? a.mime,
        "cache-control": "public, max-age=31536000, immutable",
        ...(etag !== null ? { etag } : {}),
      },
    });
  }
}
