/**
 * Sprint 6 part of the mock admin-bff (`/game/*` → gamification): the rules as versions (draft with If-Match → 409
 * DRAFT_CONFLICT, validate with errors / warnings by path, activate → 409 RULES_NOT_VALIDATED, rollback of an archived
 * version as a new one), heroes (draft, publish → 409 HERO_IN_USE by scenario), pictures (raw bytes, signature and size
 * by the header, 413 ASSET_TOO_LARGE, 422 ASSET_INVALID, the same sha256 → the same asset_id; the content as bytes),
 * the shop (create with Idempotency-Key, PATCH of a published item — only available_until and order), events (publish
 * → 409 EVENT_OVERLAP {event_id}, a start in the past → 422), wallets (ledger by currency with pages, manual operation
 * → 409 BALANCE_NEGATIVE, reversal → 409 ALREADY_REVERSED, refund of a purchase) and the overview. Permissions as
 * admin.ts: game.read / game.manage / game.publish (step-up) / wallet.adjust (step-up); every command is audited.
 */
import { createHash } from "node:crypto";
import type { AdminGameEvent, AdminGameImage, AdminHero, AdminHeroFields, AdminLedgerOperation, AdminShopItem, AdminWallet, GameAudience, GameOverview, GameRules, GameStats, Period, Permission, RulesVersion, ShopItemCreate } from "@tilhero/contracts/admin";
import type { HeroStage } from "@tilhero/contracts/bff";
import type { Ctx } from "./content-bff";
import { DAY, iso } from "./data";
import * as G from "./game-data";

type P = Record<string, unknown>;

export interface GameScenario {
  /** publishing this hero answers 409 HERO_IN_USE {learners} (the hero is chosen and cannot be taken off) */
  heroInUse?: string;
  /** another staff member saves the rules draft right after it is read: the next PUT gets 409 DRAFT_CONFLICT */
  draftConflictOnce?: boolean;
  /** the overview of the game and the dashboard block are down */
  statsDown?: boolean;
  /** the ledger page size (default 10) */
  pageSize?: number;
  /** the first manual operation is made, but its answer is lost (502): the outcome is unknown to the client */
  adjustLostOnce?: boolean;
}

const LEDGER_PAGE = 10;
const MAX_BYTES = 300 * 1024;
const CODE_RE = /^[a-z0-9_]{3,40}$/;
const AUD: GameAudience[] = ["kids", "teens", "adults"];

interface HeroState {
  seed: G.HeroSeed;
  fields: AdminHeroFields;
  draft: (AdminHeroFields & { updated_at: string }) | null;
  version: number;
  published_at: string | null;
  published_by: { staff_id: string; name: string } | null;
  learners: number;
}

export class GameStore {
  assets: G.MockAsset[] = G.seedAssets();
  rules: RulesVersion[] = G.rulesVersions();
  heroes: HeroState[];
  items: AdminShopItem[];
  events: AdminGameEvent[] = G.events();
  wallets: G.MockWallet[] = G.wallets();
  /** audit actions of this part (the shared audit log gets them too) */
  readonly audit: Array<{ action: string; id: string; reason: string | null }> = [];
  private idem = new Map<string, unknown>();
  private seq = 0;
  private conflictArmed: boolean;
  private adjustLost: boolean;

  constructor(private readonly sc: GameScenario = {}) {
    this.conflictArmed = !!sc.draftConflictOnce;
    this.adjustLost = !!sc.adjustLostOnce;
    this.heroes = G.HEROES.map((h, i) => ({
      seed: h,
      fields: {
        name: h.name,
        tagline: h.tagline,
        audiences: [...AUD],
        stages: ([1, 2, 3] as const).map((s) => ({ stage: s, name: h.stageNames[s - 1]!, asset_id: G.assetId(G.heroAssetN(i, s)) })),
      },
      draft: null,
      version: 1,
      published_at: iso(-30 * DAY),
      published_by: G.SEED_STAFF,
      learners: h.learners,
    }));
    this.items = G.shopItems((n) => this.meta(G.assetId(n))!);
  }

  /* ---------------------------------------------------------------- helpers */

  private stamp(): string {
    return new Date(Date.now() + ++this.seq).toISOString();
  }
  private meta(id: string) {
    const a = this.assets.find((x) => x.asset_id === id);
    return a ? { asset_id: a.asset_id, sha256: a.sha256, width: a.width, height: a.height, size: a.bytes.length } : null;
  }
  image(id: string): AdminGameImage | null {
    const m = this.meta(id);
    return m ? { ...m, url: `/admin/v1/game/assets/${id}/content` } : null;
  }
  private heroView(h: HeroState): AdminHero {
    const imgs = (f: AdminHeroFields) => f.stages.map((s) => ({ stage: s.stage, image: this.image(s.asset_id)! })).filter((x) => x.image);
    return {
      ...h.fields,
      code: h.seed.code,
      line: h.seed.line,
      order: h.seed.order,
      version: h.version,
      published_at: h.published_at,
      published_by: h.published_by,
      images: imgs(h.fields),
      draft: h.draft ? { ...h.draft, images: imgs(h.draft) } : null,
      learners: h.learners,
    };
  }
  private active(): RulesVersion {
    return this.rules.find((r) => r.status === "active")!;
  }
  private draft(): RulesVersion | undefined {
    return this.rules.find((r) => r.status === "draft");
  }
  private summary(r: RulesVersion) {
    const { payload: _p, diff: _d, updated_at: _u, ...s } = r;
    return s;
  }
  private withDiff(r: RulesVersion): RulesVersion {
    return { ...r, diff: diffValues(this.active().payload, r.payload) };
  }
  private walletOf(id: string) {
    return this.wallets.find((w) => w.user_id === id);
  }
  private balance(w: G.MockWallet, c: AdminLedgerOperation["currency"]) {
    return w.ledger.filter((o) => o.currency === c).reduce((a, o) => a + o.amount, 0);
  }
  private walletView(w: G.MockWallet): AdminWallet {
    const xp = this.balance(w, "xp");
    const levels = this.active().payload.levels;
    return {
      user_id: w.user_id,
      audience: w.audience,
      level: levels.filter((x) => x <= xp).length,
      xp_total: xp,
      til_balance: this.balance(w, "til"),
      freeze_stock: this.balance(w, "freeze"),
      hero: w.hero,
      confirmed_skills: w.confirmed_skills,
      owned_items: w.owned.map(({ op_ids: _o, ...x }) => x),
      quests_today: w.quests,
      badges: w.badges,
      referrals: w.referrals,
      settings: w.settings,
    };
  }

  /** INTERNAL_API §10: the block shows 7 days for «today» (gamification keeps no daily totals) */
  stats(asked: Period): GameStats | null {
    if (this.sc.statsDown) return null;
    const period: Period = asked === "today" ? "7d" : asked;
    const m = period === "7d" ? 7 : 30;
    const ev = this.events.find((e) => e.status === "published" && Date.parse(e.starts_at) <= Date.now() && Date.now() < Date.parse(e.ends_at));
    return { period, earned_xp: 1240 * m, earned_til: 310 * m, freezes_used: 4 * m, quests_completed: 57 * m, active_event: ev ? { title: ev.title, ends_at: ev.ends_at } : null };
  }

  private overview(period: "7d" | "30d"): GameOverview {
    const m = period === "7d" ? 1 : 4;
    const now = Date.now();
    return {
      period,
      active_rules_version: this.active().version,
      earned: { xp: 8680 * m, til: 2170 * m },
      spent_til: 1420 * m,
      freezes: { granted: 64 * m, bought: 11 * m, used: 28 * m },
      quests_completed: 399 * m,
      badges_earned: 47 * m,
      purchases: 23 * m,
      by_audience: [
        { audience: "kids", earned_xp: 1910 * m, earned_til: 480 * m, quests_completed: 120 * m },
        { audience: "teens", earned_xp: 2440 * m, earned_til: 610 * m, quests_completed: 104 * m },
        { audience: "adults", earned_xp: 4330 * m, earned_til: 1080 * m, quests_completed: 175 * m },
      ],
      active_events: this.events.filter((e) => e.status === "published" && Date.parse(e.starts_at) <= now && now < Date.parse(e.ends_at)).map((e) => ({ event_id: e.event_id, title: e.title, ends_at: e.ends_at })),
    };
  }

  /* ---------------------------------------------------------------- rules validator (subset of gamification §1.3) */

  private validate(r: GameRules): { errors: Array<{ path: string; code: string }>; warnings: Array<{ path: string; code: string }> } {
    const errors: Array<{ path: string; code: string }> = [];
    const warnings: Array<{ path: string; code: string }> = [];
    const known = new Set(["earn", "caps", "levels", "hero", "freeze", "bonuses", "quests", "badges"]);
    for (const k of Object.keys(r)) if (!known.has(k)) errors.push({ path: k, code: "extra_forbidden" });
    const walk = (v: unknown, path: string) => {
      if (typeof v === "number" && (!Number.isInteger(v) || v < 0)) errors.push({ path, code: "not_integer" });
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${i}`));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    };
    walk(r, "");
    if (r.levels[0] !== 0) errors.push({ path: "levels.0", code: "first_zero" });
    r.levels.forEach((x, i) => i > 0 && x <= r.levels[i - 1]! && errors.push({ path: `levels.${i}`, code: "not_increasing" }));
    const st = r.hero.stage_thresholds;
    if (st.length !== 3 || st[0] !== 0) errors.push({ path: "hero.stage_thresholds", code: "first_zero" });
    st.forEach((x, i) => i > 0 && x <= st[i - 1]! && errors.push({ path: `hero.stage_thresholds.${i}`, code: "not_increasing" }));
    const maxXp = Math.max(...Object.values(r.earn).flatMap((v) => (v && typeof v === "object" && "xp" in v ? [(v as { xp: number }).xp] : [])), r.earn.review.xp_base + r.earn.review.xp_per_correct_cap);
    if (r.caps.xp_per_day < maxXp) errors.push({ path: "caps.xp_per_day", code: "caps_below_reward" });
    for (const a of AUD) if (r.quests.templates.filter((q) => q.audiences.includes(a)).length < r.quests.per_day) errors.push({ path: "quests.templates", code: `per_audience_${a}` });
    if (r.freeze.price_til < 1 || r.freeze.price_til > 10000) errors.push({ path: "freeze.price_til", code: "range" });
    if (st[1]! > 10) warnings.push({ path: "hero.stage_thresholds.1", code: "stage2_high" });
    const act = this.active().payload;
    for (const k of ["lesson", "scenario", "media", "reading"] as const) for (const c of ["xp", "til"] as const) if (act.earn[k][c] > 0 && r.earn[k][c] > act.earn[k][c] * 2) warnings.push({ path: `earn.${k}.${c}`, code: "reward_growth" });
    return { errors, warnings };
  }

  /* ---------------------------------------------------------------- routes */

  async handle(method: string, path: string, body: P, q: URLSearchParams, idemKey: string | undefined, raw: Buffer | null, headers: Record<string, string>, x: Ctx): Promise<boolean> {
    if (!path.startsWith("/game/")) return false;
    const guard = (p: Permission, stepUp = false): Promise<void> | null => {
      if (!x.perms.has(p)) return x.err(403, "PERMISSION_DENIED", { permission: p });
      if (stepUp && !x.stepUpOk()) return x.err(403, "STEP_UP_REQUIRED", { permission: p });
      return null;
    };
    const rec = (action: string, type: string, id: string, after: P | null, reason: string | null = null) => {
      this.audit.push({ action, id, reason });
      x.record(action, type, id, after, reason);
    };
    const replay = (k: string | undefined) => (k ? this.idem.get(`${path}:${k}`) : undefined);
    const remember = (k: string | undefined, v: unknown) => k && this.idem.set(`${path}:${k}`, v);
    const comment = String(body.comment ?? "").trim();
    const reasonOk = (s: string) => s.length >= 10 && s.length <= 300;
    const me = { staff_id: x.me.staff_id, name: x.me.display_name };
    let m: RegExpMatchArray | null;
    const key = `${method} ${path}`;

    /* ---------- overview ---------- */
    if (key === "GET /game/overview") {
      const g = guard("game.read");
      if (g) return g.then(() => true);
      if (this.sc.statsDown) return x.err(503, "UPSTREAM_UNAVAILABLE", { service: "gamification" }).then(() => true);
      const p = q.get("period") === "30d" ? "30d" : "7d";
      return x.json(200, this.overview(p)).then(() => true);
    }

    /* ---------- rules ---------- */
    if (key === "GET /game/rules") {
      const g = guard("game.read");
      if (g) return g.then(() => true);
      return x.json(200, { items: [...this.rules].sort((a, b) => b.version - a.version).map((r) => this.summary(r)) }).then(() => true);
    }
    if ((m = path.match(/^\/game\/rules\/(\d+)$/)) && method === "GET") {
      const g = guard("game.read");
      if (g) return g.then(() => true);
      const r = this.rules.find((v) => v.version === Number(m![1]));
      return (r ? x.json(200, this.withDiff(r)) : x.err(404, "RULES_VERSION_NOT_FOUND")).then(() => true);
    }
    if (key === "PUT /game/rules/draft") {
      const g = guard("game.manage");
      if (g) return g.then(() => true);
      const d = this.draft();
      if (d && this.conflictArmed) {
        this.conflictArmed = false;
        d.updated_at = this.stamp();
        d.comment = "Правка коллеги";
      }
      if (d && headers["if-match"] !== d.updated_at) return x.err(409, "DRAFT_CONFLICT", { updated_at: d.updated_at }).then(() => true);
      const payload = body.payload as GameRules;
      if (!payload || typeof payload !== "object") return x.err(422, "VALIDATION_ERROR", { in: "body", field: "payload", errors: [] }).then(() => true);
      const now = this.stamp();
      if (d) Object.assign(d, { payload, comment: (body.comment as string | null) ?? null, updated_at: now, validated_at: null });
      else this.rules.push({ version: Math.max(...this.rules.map((r) => r.version)) + 1, status: "draft", comment: (body.comment as string | null) ?? null, based_on: (body.based_on as number | null) ?? this.active().version, created_by: me, created_at: now, validated_at: null, activated_by: null, activated_at: null, payload, diff: [], updated_at: now });
      const out = this.draft()!;
      rec("game.rules_draft_saved", "game_rules", String(out.version), null);
      return x.json(200, this.withDiff(out)).then(() => true);
    }
    if (key === "DELETE /game/rules/draft") {
      const g = guard("game.manage");
      if (g) return g.then(() => true);
      const d = this.draft();
      if (!d) return x.err(404, "RULES_DRAFT_NOT_FOUND").then(() => true);
      this.rules = this.rules.filter((r) => r !== d);
      rec("game.rules_draft_deleted", "game_rules", String(d.version), null);
      return x.json(204).then(() => true);
    }
    if (key === "POST /game/rules/draft/validate") {
      const g = guard("game.manage");
      if (g) return g.then(() => true);
      const d = this.draft();
      if (!d) return x.err(404, "RULES_DRAFT_NOT_FOUND").then(() => true);
      const v = this.validate(d.payload);
      const ok = v.errors.length === 0;
      if (ok) d.validated_at = new Date(Math.max(Date.now(), Date.parse(d.updated_at) + 1)).toISOString();
      return x.json(200, { ok, ...v }).then(() => true);
    }
    if (key === "POST /game/rules/draft/activate") {
      const g = guard("game.publish", true);
      if (g) return g.then(() => true);
      const seen = replay(idemKey);
      if (seen) return x.json(200, seen).then(() => true);
      if (!reasonOk(comment)) return x.err(422, "VALIDATION_ERROR", { in: "body", field: "comment", errors: ["min_length"] }).then(() => true);
      const d = this.draft();
      if (!d) return x.err(404, "RULES_DRAFT_NOT_FOUND").then(() => true);
      if (!d.validated_at || Date.parse(d.validated_at) < Date.parse(d.updated_at)) return x.err(409, "RULES_NOT_VALIDATED").then(() => true);
      const v = this.validate(d.payload);
      if (v.errors.length) return x.err(422, "RULES_INVALID", { errors: v.errors }).then(() => true);
      this.active().status = "archived";
      Object.assign(d, { status: "active", comment, activated_by: me, activated_at: iso(0) });
      rec("game.rules_activated", "game_rules", String(d.version), { version: d.version }, comment);
      const out = this.withDiff(d);
      remember(idemKey, out);
      return x.json(200, out).then(() => true);
    }
    if ((m = path.match(/^\/game\/rules\/(\d+)\/rollback$/)) && method === "POST") {
      const g = guard("game.publish", true);
      if (g) return g.then(() => true);
      const seen = replay(idemKey);
      if (seen) return x.json(200, seen).then(() => true);
      if (!reasonOk(comment)) return x.err(422, "VALIDATION_ERROR", { in: "body", field: "comment", errors: ["min_length"] }).then(() => true);
      const from = this.rules.find((r) => r.version === Number(m![1]));
      if (!from) return x.err(404, "RULES_VERSION_NOT_FOUND").then(() => true);
      // a rollback with a draft present, or of a version that is not archived — 409 RULES_STATE (§12)
      if (from.status !== "archived" || this.draft()) return x.err(409, "RULES_STATE", { draft: this.draft()?.version ?? null }).then(() => true);
      this.active().status = "archived";
      const now = iso(0);
      const nv: RulesVersion = { version: Math.max(...this.rules.map((r) => r.version)) + 1, status: "active", comment, based_on: from.version, created_by: me, created_at: now, validated_at: now, activated_by: me, activated_at: now, payload: JSON.parse(JSON.stringify(from.payload)), diff: [], updated_at: now };
      this.rules.push(nv);
      rec("game.rules_rolled_back", "game_rules", String(nv.version), { based_on: from.version }, comment);
      remember(idemKey, nv);
      return x.json(200, nv).then(() => true);
    }

    /* ---------- heroes and pictures ---------- */
    if (key === "GET /game/heroes") {
      const g = guard("game.read");
      if (g) return g.then(() => true);
      return x.json(200, { items: this.heroes.map((h) => this.heroView(h)) }).then(() => true);
    }
    if ((m = path.match(/^\/game\/heroes\/([a-z0-9_]+)\/draft$/)) && method === "PUT") {
      const g = guard("game.manage");
      if (g) return g.then(() => true);
      const h = this.heroes.find((y) => y.seed.code === m![1]);
      if (!h) return x.err(404, "HERO_NOT_FOUND").then(() => true);
      const f = body as unknown as AdminHeroFields;
      if (!f.stages || f.stages.length !== 3 || f.stages.some((s) => !this.assets.some((a) => a.asset_id === s.asset_id && a.purpose === "hero_stage"))) return x.err(422, "ASSET_NOT_FOUND").then(() => true);
      h.draft = { name: f.name, tagline: f.tagline, audiences: f.audiences, stages: f.stages.map((s) => ({ stage: s.stage as HeroStage, name: s.name, asset_id: s.asset_id })), updated_at: this.stamp() };
      rec("game.hero_draft_saved", "hero", h.seed.code, null);
      return x.json(200, this.heroView(h)).then(() => true);
    }
    if ((m = path.match(/^\/game\/heroes\/([a-z0-9_]+)\/publish$/)) && method === "POST") {
      const g = guard("game.publish", true);
      if (g) return g.then(() => true);
      const seen = replay(idemKey);
      if (seen) return x.json(200, seen).then(() => true);
      const h = this.heroes.find((y) => y.seed.code === m![1]);
      if (!h) return x.err(404, "HERO_NOT_FOUND").then(() => true);
      if (!h.draft) return x.err(409, "HERO_DRAFT_MISSING").then(() => true);
      if (this.sc.heroInUse === h.seed.code) return x.err(409, "HERO_IN_USE", { learners: h.learners }).then(() => true);
      const { updated_at: _u, ...fields } = h.draft;
      h.fields = fields;
      h.draft = null;
      h.version += 1;
      h.published_at = iso(0);
      h.published_by = me;
      rec("game.hero_published", "hero", h.seed.code, { version: h.version }, comment);
      const out = this.heroView(h);
      remember(idemKey, out);
      return x.json(200, out).then(() => true);
    }
    if (key === "POST /game/assets") {
      const g = guard("game.manage");
      if (g) return g.then(() => true);
      const purpose = q.get("purpose") as G.MockAsset["purpose"] | null;
      if (!purpose || !["hero_stage", "shop_item", "badge"].includes(purpose)) return x.err(422, "VALIDATION_ERROR", { in: "query", field: "purpose", errors: [] }).then(() => true);
      const bytes = raw ?? Buffer.alloc(0);
      if (bytes.length > MAX_BYTES) return x.err(413, "ASSET_TOO_LARGE", { max: MAX_BYTES }).then(() => true);
      const s = G.sniff(bytes);
      const ct = headers["content-type"] ?? "";
      if (!s || s.mime !== ct) return x.err(422, "ASSET_INVALID", { reason: "signature" }).then(() => true);
      if (s.width > 1024 || s.height > 1024) return x.err(422, "ASSET_INVALID", { reason: "dimensions" }).then(() => true);
      const sha = createHash("sha256").update(bytes).digest("hex");
      let a = this.assets.find((y) => y.sha256 === sha);
      if (!a) {
        a = G.asset(500 + this.assets.length, bytes, purpose);
        this.assets.push(a);
        rec("game.asset_uploaded", "game_asset", a.asset_id, { purpose, size: bytes.length });
      }
      return x.json(201, this.image(a.asset_id)).then(() => true);
    }
    if ((m = path.match(/^\/game\/assets\/([0-9a-f-]{36})\/content$/)) && method === "GET") {
      const g = guard("game.read");
      if (g) return g.then(() => true);
      const a = this.assets.find((y) => y.asset_id === m![1]);
      return (a ? x.binary(200, a.bytes, a.mime) : x.err(404, "ASSET_NOT_FOUND")).then(() => true);
    }

    /* ---------- shop ---------- */
    if (key === "GET /game/shop/items") {
      const g = guard("game.read");
      if (g) return g.then(() => true);
      const price = this.active().payload.freeze.price_til;
      return x.json(200, { items: this.items.map((i) => (i.kind === "streak_freeze" ? { ...i, price_til: price } : i)) }).then(() => true);
    }
    if (key === "POST /game/shop/items") {
      const g = guard("game.manage");
      if (g) return g.then(() => true);
      if (!idemKey) return x.err(422, "IDEMPOTENCY_KEY_REQUIRED").then(() => true);
      const seen = replay(idemKey);
      if (seen) return x.json(201, seen).then(() => true);
      const b = body as unknown as ShopItemCreate;
      if (!CODE_RE.test(String(b.code ?? "")) || !["background", "hero_frame"].includes(String(b.kind)) || !(b.price_til >= 1 && b.price_til <= 10000)) return x.err(422, "VALIDATION_ERROR", { in: "body", field: "code", errors: [] }).then(() => true);
      if (this.items.some((i) => i.code === b.code)) return x.err(409, "ITEM_CODE_TAKEN", { code: b.code }).then(() => true);
      const it: AdminShopItem = { ...b, image: b.asset_id ? this.image(b.asset_id) : null, status: "draft", owners: 0, updated_at: this.stamp() };
      delete (it as unknown as P).asset_id;
      this.items.push(it);
      rec("game.shop_item_created", "shop_item", it.code, null);
      remember(idemKey, it);
      return x.json(201, it).then(() => true);
    }
    if ((m = path.match(/^\/game\/shop\/items\/([a-z0-9_]+)$/)) && method === "PATCH") {
      const g = guard("game.manage");
      if (g) return g.then(() => true);
      const it = this.items.find((i) => i.code === m![1]);
      if (!it) return x.err(404, "ITEM_NOT_FOUND").then(() => true);
      if (it.status === "retired" || it.kind === "streak_freeze") return x.err(409, "ITEM_NOT_EDITABLE").then(() => true);
      const keys = Object.keys(body);
      if (it.status === "published" && keys.some((k) => k !== "available_until" && k !== "order")) return x.err(422, "VALIDATION_ERROR", { in: "body", field: keys.find((k) => k !== "available_until" && k !== "order"), errors: ["published"] }).then(() => true);
      const { asset_id, ...rest } = body as Partial<ShopItemCreate>;
      Object.assign(it, rest, asset_id !== undefined ? { image: asset_id ? this.image(asset_id) : null } : {}, { updated_at: this.stamp() });
      rec("game.shop_item_updated", "shop_item", it.code, null);
      return x.json(200, it).then(() => true);
    }
    if ((m = path.match(/^\/game\/shop\/items\/([a-z0-9_]+)\/(publish|retire)$/)) && method === "POST") {
      const g = guard("game.publish", true);
      if (g) return g.then(() => true);
      const it = this.items.find((i) => i.code === m![1]);
      if (!it) return x.err(404, "ITEM_NOT_FOUND").then(() => true);
      if (m![2] === "publish" && it.status !== "draft") return x.err(409, "ITEM_STATE", { status: it.status }).then(() => true);
      if (m![2] === "retire" && it.status !== "published") return x.err(409, "ITEM_STATE", { status: it.status }).then(() => true);
      it.status = m![2] === "publish" ? "published" : "retired";
      it.updated_at = this.stamp();
      rec(`game.shop_item_${m![2] === "publish" ? "published" : "retired"}`, "shop_item", it.code, { owners: it.owners }, comment);
      return x.json(200, it).then(() => true);
    }

    /* ---------- events ---------- */
    if (key === "GET /game/events") {
      const g = guard("game.read");
      if (g) return g.then(() => true);
      const st = q.get("status");
      return x.json(200, { items: this.events.filter((e) => !st || e.status === st) }).then(() => true);
    }
    if (key === "POST /game/events") {
      const g = guard("game.manage");
      if (g) return g.then(() => true);
      if (!idemKey) return x.err(422, "IDEMPOTENCY_KEY_REQUIRED").then(() => true);
      const seen = replay(idemKey);
      if (seen) return x.json(201, seen).then(() => true);
      const b = body as unknown as AdminGameEvent;
      if (!CODE_RE.test(String(b.code ?? ""))) return x.err(422, "VALIDATION_ERROR", { in: "body", field: "code", errors: [] }).then(() => true);
      if (this.events.some((e) => e.code === b.code)) return x.err(409, "EVENT_CODE_TAKEN", { code: b.code }).then(() => true);
      const ev: AdminGameEvent = { ...b, event_id: `e6000000-0000-4000-8000-${String(900 + ++this.seq).padStart(12, "0")}`, status: "draft", created_by: me, published_by: null, updated_at: this.stamp() };
      this.events.push(ev);
      rec("game.event_created", "game_event", ev.event_id, { code: ev.code });
      remember(idemKey, ev);
      return x.json(201, ev).then(() => true);
    }
    if ((m = path.match(/^\/game\/events\/([0-9a-f-]{36})$/)) && method === "PATCH") {
      const g = guard("game.manage");
      if (g) return g.then(() => true);
      const ev = this.events.find((e) => e.event_id === m![1]);
      if (!ev) return x.err(404, "EVENT_NOT_FOUND").then(() => true);
      if (ev.status !== "draft") return x.err(409, "EVENT_STATE", { status: ev.status }).then(() => true);
      Object.assign(ev, body, { updated_at: this.stamp() });
      rec("game.event_updated", "game_event", ev.event_id, null);
      return x.json(200, ev).then(() => true);
    }
    if ((m = path.match(/^\/game\/events\/([0-9a-f-]{36})\/(publish|cancel)$/)) && method === "POST") {
      const g = guard("game.publish", true);
      if (g) return g.then(() => true);
      const ev = this.events.find((e) => e.event_id === m![1]);
      if (!ev) return x.err(404, "EVENT_NOT_FOUND").then(() => true);
      if (m![2] === "publish") {
        if (ev.status !== "draft") return x.err(409, "EVENT_STATE", { status: ev.status }).then(() => true);
        if (Date.parse(ev.starts_at) < Date.now()) return x.err(422, "EVENT_STARTS_IN_PAST", { starts_at: ev.starts_at }).then(() => true);
        const pairs = new Set(ev.multipliers.map((y) => `${y.action}:${y.currency}`));
        const clash = this.events.find(
          (o) => o.event_id !== ev.event_id && o.status === "published" && Date.parse(o.starts_at) < Date.parse(ev.ends_at) && Date.parse(ev.starts_at) < Date.parse(o.ends_at) && o.audiences.some((a) => ev.audiences.includes(a)) && o.multipliers.some((y) => pairs.has(`${y.action}:${y.currency}`)),
        );
        if (clash) return x.err(409, "EVENT_OVERLAP", { event_id: clash.event_id }).then(() => true);
        Object.assign(ev, { status: "published", published_by: me, updated_at: this.stamp() });
      } else {
        if (ev.status !== "published") return x.err(409, "EVENT_STATE", { status: ev.status }).then(() => true);
        Object.assign(ev, { status: "cancelled", updated_at: this.stamp() });
      }
      rec(`game.event_${m![2] === "publish" ? "published" : "cancelled"}`, "game_event", ev.event_id, null, comment);
      return x.json(200, ev).then(() => true);
    }

    /* ---------- wallets ---------- */
    if ((m = path.match(/^\/game\/wallets\/([0-9a-f-]{36})$/)) && method === "GET") {
      const g = guard("game.read");
      if (g) return g.then(() => true);
      const w = this.walletOf(m![1]!);
      return (w ? x.json(200, this.walletView(w)) : x.err(404, "WALLET_NOT_FOUND")).then(() => true);
    }
    if ((m = path.match(/^\/game\/wallets\/([0-9a-f-]{36})\/ledger$/)) && method === "GET") {
      const g = guard("game.read");
      if (g) return g.then(() => true);
      const w = this.walletOf(m![1]!);
      if (!w) return x.err(404, "WALLET_NOT_FOUND").then(() => true);
      const cur = q.get("currency");
      const all = [...w.ledger].reverse().filter((o) => !cur || o.currency === cur);
      const from = Number(q.get("cursor") ?? 0) || 0;
      const size = this.sc.pageSize ?? LEDGER_PAGE;
      const items = all.slice(from, from + size);
      return x.json(200, { items, next_cursor: from + size < all.length ? String(from + size) : null }).then(() => true);
    }
    if ((m = path.match(/^\/game\/wallets\/([0-9a-f-]{36})\/adjustments$/)) && method === "POST") {
      const g = guard("wallet.adjust", true);
      if (g) return g.then(() => true);
      if (!idemKey) return x.err(422, "IDEMPOTENCY_KEY_REQUIRED").then(() => true);
      const seen = replay(idemKey);
      if (seen) return x.json(201, seen).then(() => true);
      const w = this.walletOf(m![1]!);
      if (!w) return x.err(404, "WALLET_NOT_FOUND").then(() => true);
      const cur = body.currency as AdminLedgerOperation["currency"];
      const amount = Number(body.amount);
      const reason = String(body.reason ?? "").trim();
      const max = cur === "xp" ? 100000 : 10000;
      if (!["xp", "til", "freeze"].includes(cur) || !Number.isInteger(amount) || amount === 0 || Math.abs(amount) > max || !reasonOk(reason)) return x.err(422, "VALIDATION_ERROR", { in: "body", field: "amount", errors: [] }).then(() => true);
      if (cur !== "xp" && this.balance(w, cur) + amount < 0) return x.err(409, "BALANCE_NEGATIVE", { balance: this.balance(w, cur) }).then(() => true);
      if (cur === "xp" && this.balance(w, cur) + amount < 0) return x.err(409, "BALANCE_NEGATIVE", { balance: this.balance(w, cur) }).then(() => true);
      const op = this.newOp(w, cur, amount, "manual", { source: { kind: "staff", ref: `ad100000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}` }, actor: `staff:${x.me.staff_id}`, comment: reason, rules_version: null });
      rec("game.wallet_adjusted", "wallet", w.user_id, { currency: cur, amount, op_id: op.op_id }, reason);
      remember(idemKey, op);
      if (this.adjustLost) {
        // the operation is made, but its answer never reaches the client
        this.adjustLost = false;
        return x.err(502, "UPSTREAM_UNAVAILABLE", { service: "gamification" }).then(() => true);
      }
      return x.json(201, op).then(() => true);
    }
    if ((m = path.match(/^\/game\/wallets\/([0-9a-f-]{36})\/ledger\/([0-9a-f-]{36})\/reverse$/)) && method === "POST") {
      const g = guard("wallet.adjust", true);
      if (g) return g.then(() => true);
      const seen = replay(idemKey);
      if (seen) return x.json(200, seen).then(() => true);
      const w = this.walletOf(m![1]!);
      if (!w) return x.err(404, "WALLET_NOT_FOUND").then(() => true);
      const reason = String(body.reason ?? "").trim();
      if (!reasonOk(reason)) return x.err(422, "VALIDATION_ERROR", { in: "body", field: "reason", errors: [] }).then(() => true);
      const orig = w.ledger.find((o) => o.op_id === m![2]);
      if (!orig) return x.err(404, "OPERATION_NOT_FOUND").then(() => true);
      if (orig.status === "reversed") return x.err(409, "ALREADY_REVERSED").then(() => true);
      // a purchase is cancelled only by a refund (gamification: NOT_REVERSIBLE = reversal, shop, purchase)
      if (["reversal", "shop", "purchase"].includes(orig.reason)) return x.err(409, "OPERATION_NOT_REVERSIBLE", { reason: orig.reason }).then(() => true);
      if (orig.currency !== "xp" && this.balance(w, orig.currency) - orig.amount < 0) return x.err(409, "BALANCE_NEGATIVE", { balance: this.balance(w, orig.currency) }).then(() => true);
      const op = this.reverseOp(w, orig, x.me.staff_id, reason);
      rec("game.wallet_reversed", "wallet", w.user_id, { op_id: orig.op_id, reversal: op.op_id }, reason);
      remember(idemKey, op);
      return x.json(200, op).then(() => true);
    }
    if ((m = path.match(/^\/game\/wallets\/([0-9a-f-]{36})\/purchases\/([0-9a-f-]{36})\/refund$/)) && method === "POST") {
      const g = guard("wallet.adjust", true);
      if (g) return g.then(() => true);
      const w = this.walletOf(m![1]!);
      if (!w) return x.err(404, "WALLET_NOT_FOUND").then(() => true);
      const reason = String(body.reason ?? "").trim();
      if (!reasonOk(reason)) return x.err(422, "VALIDATION_ERROR", { in: "body", field: "reason", errors: [] }).then(() => true);
      const seen = replay(idemKey);
      if (seen) return x.json(200, seen).then(() => true);
      // the purchase by its id: the shop operations with source.ref = purchase_id (cosmetics or a freeze)
      const pid = m![2]!;
      const own = w.owned.find((o) => o.purchase_id === pid);
      const mine = w.ledger.filter((o) => o.reason === "shop" && o.source.kind === "command" && o.source.ref === pid && o.status === "confirmed");
      if (!mine.length) return x.err(404, "PURCHASE_NOT_FOUND").then(() => true);
      for (const o of mine) if (o.currency !== "xp" && this.balance(w, o.currency) - o.amount < 0) return x.err(409, "BALANCE_NEGATIVE", { balance: this.balance(w, o.currency) }).then(() => true);
      const ops = mine.map((o) => this.reverseOp(w, o, x.me.staff_id, reason));
      if (own) {
        w.owned = w.owned.filter((o) => o !== own);
        const it = this.items.find((i) => i.code === own.code);
        if (it) it.owners = Math.max(0, it.owners - 1);
      }
      rec("game.purchase_refunded", "wallet", w.user_id, { purchase_id: pid }, reason);
      const out = { operations: ops };
      remember(idemKey, out);
      return x.json(200, out).then(() => true);
    }
    return false;
  }

  private newOp(w: G.MockWallet, currency: AdminLedgerOperation["currency"], amount: number, reason: AdminLedgerOperation["reason"], extra: Partial<AdminLedgerOperation>): AdminLedgerOperation {
    const n = ++this.seq;
    const d = new Date();
    const p = (k: number) => String(k).padStart(2, "0");
    const op: AdminLedgerOperation = {
      op_id: G.OP(1000 + n),
      currency,
      amount,
      reason,
      source: { kind: "command", ref: G.OP(1000 + n) },
      rules_version: this.active().version,
      multiplier: 1,
      capped: false,
      local_date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      status: "confirmed",
      reversed_by: null,
      reversal_of: null,
      actor: "system",
      comment: null,
      created_at: new Date(Date.now() + n).toISOString(),
      ...extra,
    };
    w.ledger.push(op);
    return op;
  }

  private reverseOp(w: G.MockWallet, orig: AdminLedgerOperation, staffId: string, reason: string): AdminLedgerOperation {
    const op = this.newOp(w, orig.currency, -orig.amount, "reversal", { reversal_of: orig.op_id, source: { kind: "staff", ref: orig.op_id }, actor: `staff:${staffId}`, comment: reason, rules_version: null });
    orig.status = "reversed";
    orig.reversed_by = op.op_id;
    return op;
  }
}

/** Changed leaves of two values (gamification sends this as RulesVersion.diff). */
function diffValues(a: unknown, b: unknown, path = ""): Array<{ path: string; from: unknown; to: unknown }> {
  const obj = (v: unknown) => v !== null && typeof v === "object";
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: Array<{ path: string; from: unknown; to: unknown }> = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...diffValues(a[i] ?? null, b[i] ?? null, `${path}.${i}`));
    return out;
  }
  if (obj(a) && obj(b)) {
    const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])];
    return keys.flatMap((k) => diffValues((a as P)[k] ?? null, (b as P)[k] ?? null, path ? `${path}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, from: a, to: b }];
}
