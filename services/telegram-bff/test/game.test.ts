/**
 * Спринт 6 через BFF — игра и герои (bff.ts «Спринт 6», INTERNAL_API спринта 6 §1.7–§1.9, §1.12, §9): сводка, герои,
 * задания, значки, магазин, история, награды занятия, настройки, выбор героя, экипировка, покупка за тилы, картинки.
 * Субъект gamification — аккаунт, claims lrn и age_band активного ученика; коды домена — как есть; сбой и ответ не по
 * контракту → 503 GAME_UNAVAILABLE; url картинок собирает BFF; картинки — публично, sha пути = ETag; лимиты tg.game.*.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GAME_SECRET, READY_SESSION, pngBytes } from "./fakeGame.js";
import { bearer, closeRedis, domainError, idem, login, makeHarness, switchTo, testRedis, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
async function setup(env: Record<string, string> = {}): Promise<void> {
  h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "1000", ...env });
  s = await login(h);
  h.fake.setAge(s.userId, "18+");
  h.fake.onboard(s.userId);
}
beforeEach(() => setup());
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

type Method = "GET" | "POST" | "PUT" | "PATCH";
const get = (url: string, token = s.access, headers: Record<string, string> = {}) => h.app.inject({ url, headers: { ...bearer(token), ...headers } });
const send = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}, token = s.access) =>
  h.app.inject({ method, url, headers: { ...bearer(token), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const asset = (url: string, headers: Record<string, string> = {}, ip = "198.51.100.7") => h.app.inject({ url, headers, remoteAddress: ip });
const gameCalls = (method?: string, path?: string) => h.fake.callsTo("gamification", method, path);
const assetOf = (id: string) => h.fake.game.assets.get(id)!;
const urlOf = (id: string) => `/v1/game/assets/${id}/${assetOf(id).sha256}`;

async function kid(band: "6-9" | "10-13" = "6-9"): Promise<{ kid: LoggedIn; child: string }> {
  const child = h.fake.addChild(s.userId, "Мадина", band);
  h.fake.onboard(child);
  return { kid: await switchTo(h, s, child), child };
}

/** Переопределение лимита без деплоя (rl:override:<policy>), перечитывается через 1 с. */
async function limitTo(policy: string, limit: number): Promise<void> {
  await h.close();
  await setup({ RATE_LIMIT_OVERRIDE_REFRESH_SECONDS: "1" });
  await testRedis().set(
    `${h.config.rateLimiting.keyPrefix}rl:override:${policy}`,
    JSON.stringify({ v: 1, limit, window_s: 60, burst: null, by: "staff-1", at: new Date().toISOString(), reason: "тест", expires_at: null }),
  );
  await new Promise((r) => setTimeout(r, 1100));
}

/** Все маршруты игры ученика с корректным запросом. */
const LEARNER_ROUTES: Array<[Method, string, unknown?]> = [
  ["GET", "/v1/game/summary"],
  ["GET", "/v1/game/heroes"],
  ["GET", "/v1/game/quests"],
  ["GET", "/v1/game/badges"],
  ["GET", "/v1/game/shop"],
  ["GET", "/v1/game/history"],
  ["GET", `/v1/game/rewards?source_session_id=${READY_SESSION}`],
  ["GET", "/v1/game/settings"],
  ["PUT", "/v1/game/hero", { hero_code: "robot_0" }],
  ["PUT", "/v1/game/equipment", { background_code: null, frame_code: null }],
  ["PATCH", "/v1/game/settings", { auto_freeze: false }],
  ["POST", "/v1/game/shop/purchases", { item_code: "streak_freeze" }],
];
const callRoute = ([method, url, payload]: [Method, string, unknown?], token = s.access) => send(method, url, payload, method === "POST" ? idem() : {}, token);

describe("сводка и вызов gamification от имени ученика", () => {
  it("summary: поля контракта, url картинок собирает BFF, purchase_available = false, служебные поля отброшены; sub = аккаунт, claims lrn и age_band", async () => {
    expect((await send("PUT", "/v1/game/hero", { hero_code: "robot_0" })).statusCode).toBe(200);
    const res = await get("/v1/game/summary");
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({ level: 2, xp_total: 120, xp_level_start: 100, xp_next_level: 250, til_balance: 100, freeze_stock: 1, freeze_max: 5, freeze_price_til: 40 });
    expect(b.hero).toEqual({
      code: "robot_0",
      name: { ru: "Робот Вольт", uz: "Робот Вольт (uz)" },
      stage: 1,
      stage_name: { ru: "Сборка", uz: "Сборка (uz)" },
      image: { asset_id: "a-robot_0-1", url: urlOf("a-robot_0-1"), width: 300, height: 460 },
      confirmed_skills: 2,
      next_stage_at: 3,
    });
    // домен говорит true — тилы за деньги в спринте 6 не продаются
    expect(b.purchase_available).toBe(false);
    expect(b.quests.items).toHaveLength(3);
    expect(b.events[0]).not.toHaveProperty("created_by");
    expect(b.equipment).toEqual({ background: null, frame: null });
    expect(b.settings).toEqual({ auto_freeze: true, quests_hidden: false, celebrations: "full", game_notifications: true, league_opt_in: false });
    for (const k of ["user_id", "rules_version"]) expect(b).not.toHaveProperty(k);
    expect(res.headers["cache-control"]).toBe("no-store");

    const call = gameCalls("GET", "/internal/v1/game/summary")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ iss: "telegram-bff", aud: "gamification", lrn: s.userId, age_band: "18+" });
    expect(call.query).toEqual({});
  });

  it("детский профиль: lrn и age_band ребёнка, sub — аккаунт; дракончики первыми; празднования quiet", async () => {
    const { kid: k, child } = await kid("6-9");
    const res = await get("/v1/game/heroes", k.access);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((x: { code: string }) => x.code)).toEqual(["pet_0", "robot_0"]);
    const call = gameCalls("GET", "/internal/v1/game/heroes").at(-1)!;
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ lrn: child, age_band: "6-9" });
    expect((await get("/v1/game/settings", k.access)).json().celebrations).toBe("quiet");
    // кошелёк — у ученика: у родителя и ребёнка разные
    expect((await send("POST", "/v1/game/shop/purchases", { item_code: "bg_forest" }, idem(), k.access)).json().til_balance).toBe(50);
    expect(h.fake.game.of(s.userId).til).toBe(100);
  });

  it("401 без токена и с мусором на каждом маршруте — gamification не вызывается", async () => {
    for (const r of LEARNER_ROUTES) {
      const none = await h.app.inject({ method: r[0], url: r[1], ...(r[2] !== undefined ? { payload: r[2] as object } : {}) });
      expect([none.statusCode, none.json().code], r[1]).toEqual([401, "UNAUTHORIZED"]);
      const junk = await h.app.inject({ method: r[0], url: r[1], headers: bearer("a.b.c") });
      expect(junk.json().code, r[1]).toBe("TOKEN_INVALID");
    }
    expect(gameCalls()).toHaveLength(0);
  });
});

describe("герои, задания, значки, магазин, история, награды, настройки", () => {
  it("герои: ступени с картинками (url по sha256), выбранный и ступень; лишнее домена отброшено", async () => {
    const before = (await get("/v1/game/heroes")).json();
    expect(before).toMatchObject({ selected: null, stage: 1 });
    expect(before.items[0]).toEqual({
      code: "robot_0",
      line: "robot",
      name: { ru: "Робот Вольт", uz: "Робот Вольт (uz)" },
      tagline: { ru: "Робот Вольт — слоган", uz: "Робот Вольт — слоган (uz)" },
      stages: [1, 2, 3].map((st, i) => ({
        stage: st,
        name: expect.any(Object),
        image: { asset_id: `a-robot_0-${st}`, url: urlOf(`a-robot_0-${st}`), width: 300, height: 460 },
        skills_required: [0, 5, 15][i],
      })),
    });
    await send("PUT", "/v1/game/hero", { hero_code: "pet_0" });
    expect((await get("/v1/game/heroes")).json().selected).toBe("pet_0");
  });

  it("задания дня и значки: формы контракта; значок без картинки — null, основание без event_id", async () => {
    const q = await get("/v1/game/quests");
    expect(q.statusCode).toBe(200);
    expect(q.json()).toEqual({
      local_date: "2026-11-20",
      hidden: false,
      items: expect.arrayContaining([{ slot: 1, code: "lesson_1", kind: "lesson_complete", target: 1, progress: 1, status: "completed", reward: { xp: 10, til: 5 } }]),
      all_done_bonus: { xp: 10, til: 10 },
      bonus_received: false,
    });
    const b = (await get("/v1/game/badges")).json().items;
    expect(b[0]).toMatchObject({ code: "first_lesson", earned_at: "2026-11-20T09:00:00Z", image: { asset_id: "a-badge-first", url: urlOf("a-badge-first") } });
    expect(b[0].basis).toEqual({ metric: "lessons", value: 1, threshold: 1 });
    expect(b[1]).toMatchObject({ code: "streak_7", image: null, earned_at: null, basis: { metric: "streak", value: 3, threshold: 7 } });
  });

  it("магазин: картинка png, заморозка без картинки, тема — ключи токенов; аудитории и статус домена отброшены", async () => {
    h.fake.game.of(s.userId).til = 60;
    const res = await get("/v1/game/shop");
    expect(res.statusCode).toBe(200);
    const shop = res.json();
    expect(shop).toMatchObject({ til_balance: 60, freeze_stock: 1, freeze_max: 5 });
    const bg = shop.items.find((i: { code: string }) => i.code === "bg_forest");
    expect(bg).toEqual({
      code: "bg_forest",
      kind: "background",
      title: { ru: "bg_forest", uz: "bg_forest (uz)" },
      image: { asset_id: "a-bg-forest", url: urlOf("a-bg-forest"), width: 300, height: 460 },
      theme: { bg: "game.bg.forest", accent: "game.accent.green" },
      description: { ru: "bg_forest — описание", uz: "bg_forest — описание (uz)" },
      price_til: 50,
      owned: false,
      equipped: false,
      can_buy: true,
      reason_unavailable: null,
      available_until: null,
    });
    expect(shop.items.find((i: { code: string }) => i.code === "streak_freeze").image).toBeNull();
    expect(shop.items.find((i: { code: string }) => i.code === "frame_gold")).toMatchObject({ can_buy: false, reason_unavailable: "not_enough_tils" });
  });

  it("история: currency и cursor — в домен; комментарий сотрудника, actor и user_id не уходят; неверная валюта / лишний параметр — 422 без вызова", async () => {
    const p1 = await get("/v1/game/history");
    expect(p1.statusCode).toBe(200);
    expect(p1.json().next_cursor).toBe("p2");
    const p2 = await get("/v1/game/history?cursor=p2");
    const manual = p2.json().items.find((o: { reason: string }) => o.reason === "manual");
    expect(Object.keys(manual).sort()).toEqual(["amount", "capped", "created_at", "currency", "multiplier", "op_id", "reason", "status"]);
    expect(p2.body).not.toContain(GAME_SECRET);
    expect(p2.body).not.toContain("staff:");
    const til = await get("/v1/game/history?currency=til");
    expect(til.json().items.every((o: { currency: string }) => o.currency === "til")).toBe(true);
    expect(gameCalls("GET", "/internal/v1/game/history").map((c) => c.query)).toEqual([{}, { cursor: "p2" }, { currency: "til" }]);
    const n = gameCalls().length;
    expect((await get("/v1/game/history?currency=money")).statusCode).toBe(422);
    expect((await get("/v1/game/history?limit=50")).statusCode).toBe(422);
    expect((await get("/v1/game/history?user_id=x")).statusCode).toBe(422);
    expect(gameCalls()).toHaveLength(n);
  });

  it("награды занятия: ready — операции, уровень, значки с url, задания; чужая/без наград — none; source_session_id обязателен и UUID", async () => {
    const res = await get(`/v1/game/rewards?source_session_id=${READY_SESSION.toUpperCase()}`);
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ status: "ready", level_up: { from: 1, to: 2 }, hero_stage_up: null });
    expect(r.operations[0]).not.toHaveProperty("source_session_id");
    expect(r.operations[0]).not.toHaveProperty("actor");
    expect(r.badges[0].image.url).toBe(urlOf("a-badge-first"));
    expect(r.quests_completed).toHaveLength(1);
    expect(gameCalls("GET", "/internal/v1/game/rewards")[0]!.query).toEqual({ source_session_id: READY_SESSION });
    const none = await get(`/v1/game/rewards?source_session_id=${randomUUID()}`);
    expect(none.json()).toEqual({ status: "none", operations: [], level_up: null, hero_stage_up: null, badges: [], quests_completed: [] });
    const n = gameCalls().length;
    expect((await get("/v1/game/rewards")).statusCode).toBe(422);
    expect((await get("/v1/game/rewards?source_session_id=abc")).statusCode).toBe(422);
    expect(gameCalls()).toHaveLength(n);
  });

  it("настройки: GET; PATCH — только переданные поля; пусто, чужое значение, лишнее поле, не JSON-тип — 422 без вызова", async () => {
    expect((await get("/v1/game/settings")).json()).toEqual({ auto_freeze: true, quests_hidden: false, celebrations: "full", game_notifications: true, league_opt_in: false });
    const res = await send("PATCH", "/v1/game/settings", { quests_hidden: true, celebrations: "quiet" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ auto_freeze: true, quests_hidden: true, celebrations: "quiet", game_notifications: true, league_opt_in: false });
    expect(gameCalls("PATCH", "/internal/v1/game/settings")[0]!.body).toEqual({ quests_hidden: true, celebrations: "quiet" });
    expect((await get("/v1/game/quests")).json()).toMatchObject({ hidden: true, items: [] });
    const n = gameCalls().length;
    for (const bad of [{}, { celebrations: "loud" }, { auto_freeze: true, user_id: "x" }, { auto_freeze: "true" }]) {
      const r = await send("PATCH", "/v1/game/settings", bad);
      expect([r.statusCode, r.json().code], JSON.stringify(bad)).toEqual([422, "VALIDATION_ERROR"]);
    }
    expect((await send("PATCH", "/v1/game/settings")).statusCode).toBe(422);
    expect(gameCalls()).toHaveLength(n);
  });
});

describe("команды: герой и экипировка", () => {
  it("выбор героя → GameSummary; HERO_NOT_AVAILABLE 409 и HERO_NOT_FOUND 404 — как есть; неверный код / лишнее поле — 422 без вызова", async () => {
    const res = await send("PUT", "/v1/game/hero", { hero_code: "pet_0" });
    expect(res.statusCode).toBe(200);
    expect(res.json().hero).toMatchObject({ code: "pet_0", image: { url: urlOf("a-pet_0-1") } });
    expect(res.json().purchase_available).toBe(false);
    expect(gameCalls("PUT", "/internal/v1/game/hero")[0]!.body).toEqual({ hero_code: "pet_0" });
    const na = await send("PUT", "/v1/game/hero", { hero_code: "robot_9" });
    expect([na.statusCode, na.json().code]).toEqual([409, "HERO_NOT_AVAILABLE"]);
    const nf = await send("PUT", "/v1/game/hero", { hero_code: "dino_0" });
    expect([nf.statusCode, nf.json().code]).toEqual([404, "HERO_NOT_FOUND"]);
    const n = gameCalls().length;
    for (const bad of [{ hero_code: "Robot_0" }, { hero_code: "r" }, { hero_code: "robot_0", stage: 3 }, { hero_code: null }, {}]) {
      expect((await send("PUT", "/v1/game/hero", bad)).statusCode, JSON.stringify(bad)).toBe(422);
    }
    expect(gameCalls()).toHaveLength(n);
  });

  it("экипировка: купленный фон — надеть, null — снять; NOT_OWNED 409 {item_code}; без поля — 422", async () => {
    const notOwned = await send("PUT", "/v1/game/equipment", { background_code: "bg_forest", frame_code: null });
    expect([notOwned.statusCode, notOwned.json().code, notOwned.json().details]).toEqual([409, "NOT_OWNED", { item_code: "bg_forest" }]);
    expect((await send("POST", "/v1/game/shop/purchases", { item_code: "bg_forest" }, idem())).statusCode).toBe(200);
    const on = await send("PUT", "/v1/game/equipment", { background_code: "bg_forest", frame_code: null });
    expect(on.statusCode).toBe(200);
    expect(on.json().equipment).toEqual({
      background: { code: "bg_forest", kind: "background", title: { ru: "bg_forest", uz: "bg_forest (uz)" }, image: { asset_id: "a-bg-forest", url: urlOf("a-bg-forest"), width: 300, height: 460 }, theme: { bg: "game.bg.forest", accent: "game.accent.green" } },
      frame: null,
    });
    const off = await send("PUT", "/v1/game/equipment", { background_code: null, frame_code: null });
    expect(off.json().equipment).toEqual({ background: null, frame: null });
    const n = gameCalls().length;
    expect((await send("PUT", "/v1/game/equipment", { background_code: "bg_forest" })).statusCode).toBe(422);
    expect((await send("PUT", "/v1/game/equipment", { background_code: "BG", frame_code: null })).statusCode).toBe(422);
    expect(gameCalls()).toHaveLength(n);
  });
});

describe("покупка за тилы", () => {
  it("Idempotency-Key обязателен (422 без вызова); ключ — в домен в нижнем регистре; повтор — тот же ответ без второго списания; тот же ключ с другим телом — 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const none = await send("POST", "/v1/game/shop/purchases", { item_code: "bg_forest" });
    expect([none.statusCode, none.json().code]).toEqual([422, "IDEMPOTENCY_KEY_REQUIRED"]);
    const junk = await send("POST", "/v1/game/shop/purchases", { item_code: "bg_forest" }, { "idempotency-key": "not-a-uuid" });
    expect([junk.statusCode, junk.json().code]).toEqual([422, "IDEMPOTENCY_KEY_REQUIRED"]);
    expect(gameCalls()).toHaveLength(0);

    const key = randomUUID().toUpperCase();
    const a = await send("POST", "/v1/game/shop/purchases", { item_code: "bg_forest" }, { "idempotency-key": key });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual({ purchase_id: expect.any(String), item_code: "bg_forest", price_til: 50, til_balance: 50, freeze_stock: 1, purchased_at: "2026-11-20T09:00:00Z" });
    const b = await send("POST", "/v1/game/shop/purchases", { item_code: "bg_forest" }, { "idempotency-key": key });
    expect([b.statusCode, b.json()]).toEqual([200, a.json()]);
    expect((await get("/v1/game/summary")).json().til_balance).toBe(50);
    const calls = gameCalls("POST", "/internal/v1/game/purchases");
    expect(calls.map((c) => c.headers["idempotency-key"])).toEqual([key.toLowerCase(), key.toLowerCase()]);
    expect(calls[0]!.body).toEqual({ item_code: "bg_forest" });
    const reused = await send("POST", "/v1/game/shop/purchases", { item_code: "streak_freeze" }, { "idempotency-key": key });
    expect([reused.statusCode, reused.json().code]).toEqual([422, "IDEMPOTENCY_KEY_REUSED"]);
  });

  it("коды домена как есть: ALREADY_OWNED, FREEZE_STOCK_FULL {max}, ITEM_NOT_AVAILABLE 410, ITEM_NOT_FOUND 404; INSUFFICIENT_TILS — purchase_available всегда false", async () => {
    const buy = (item_code: string) => send("POST", "/v1/game/shop/purchases", { item_code }, idem());
    expect((await buy("bg_forest")).statusCode).toBe(200);
    expect(await buy("bg_forest").then((r) => [r.statusCode, r.json().code])).toEqual([409, "ALREADY_OWNED"]);
    const poor = await buy("frame_gold");
    expect([poor.statusCode, poor.json().code]).toEqual([409, "INSUFFICIENT_TILS"]);
    expect(poor.json().details).toEqual({ price: 80, balance: 50, missing: 30, purchase_available: false });
    expect(await buy("bg_retired").then((r) => [r.statusCode, r.json().code])).toEqual([410, "ITEM_NOT_AVAILABLE"]);
    expect(await buy("bg_nothing").then((r) => [r.statusCode, r.json().code])).toEqual([404, "ITEM_NOT_FOUND"]);
    h.fake.game.of(s.userId).freeze = 5;
    const full = await buy("streak_freeze");
    expect([full.statusCode, full.json().code, full.json().details]).toEqual([409, "FREEZE_STOCK_FULL", { max: 5 }]);
    const n = gameCalls().length;
    for (const bad of [{}, { item_code: "bg_forest", price_til: 1 }, { item_code: "BG FOREST" }, { item_code: "bg_forest", user_id: s.userId }]) {
      expect((await send("POST", "/v1/game/shop/purchases", bad, idem())).statusCode, JSON.stringify(bad)).toBe(422);
    }
    expect(gameCalls()).toHaveLength(n);
  });

  it("ребёнок покупает за тилы (claims ребёнка); заморозка увеличивает запас", async () => {
    const { kid: k, child } = await kid("10-13");
    const res = await send("POST", "/v1/game/shop/purchases", { item_code: "streak_freeze" }, idem(), k.access);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ item_code: "streak_freeze", price_til: 40, til_balance: 60, freeze_stock: 2 });
    expect(gameCalls("POST", "/internal/v1/game/purchases").at(-1)!.claims).toMatchObject({ lrn: child, age_band: "10-13" });
  });
});

describe("лимиты tg.game.*", () => {
  it("tg.game.read: сверх лимита — 429 {policy}, gamification не вызывается", async () => {
    await limitTo("tg.game.read", 2);
    const codes = [];
    for (const url of ["/v1/game/summary", "/v1/game/shop", "/v1/game/badges"]) codes.push((await get(url)).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    const r = await get("/v1/game/settings");
    expect(r.json()).toMatchObject({ code: "RATE_LIMITED", details: { policy: "tg.game.read" } });
    expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(gameCalls()).toHaveLength(2);
    // команды — другой счётчик
    expect((await send("PATCH", "/v1/game/settings", { auto_freeze: false })).statusCode).toBe(200);
  });

  it("tg.game.write: герой, экипировка и настройки — общий счётчик", async () => {
    await limitTo("tg.game.write", 2);
    expect((await send("PUT", "/v1/game/hero", { hero_code: "robot_0" })).statusCode).toBe(200);
    expect((await send("PATCH", "/v1/game/settings", { auto_freeze: false })).statusCode).toBe(200);
    const r = await send("PUT", "/v1/game/equipment", { background_code: null, frame_code: null });
    expect([r.statusCode, r.json().details.policy]).toEqual([429, "tg.game.write"]);
    expect(gameCalls("PUT", "/internal/v1/game/equipment")).toHaveLength(0);
  });

  it("tg.game.purchase: 429 без вызова домена; лимит — на ученика (у ребёнка свой)", async () => {
    await limitTo("tg.game.purchase", 1);
    expect((await send("POST", "/v1/game/shop/purchases", { item_code: "streak_freeze" }, idem())).statusCode).toBe(200);
    const r = await send("POST", "/v1/game/shop/purchases", { item_code: "streak_freeze" }, idem());
    expect([r.statusCode, r.json().details.policy]).toEqual([429, "tg.game.purchase"]);
    expect(gameCalls("POST", "/internal/v1/game/purchases")).toHaveLength(1);
    const { kid: k } = await kid();
    expect((await send("POST", "/v1/game/shop/purchases", { item_code: "streak_freeze" }, idem(), k.access)).statusCode).toBe(200);
  });

  it("tg.game.assets: по IP (хешем), без авторизации", async () => {
    await limitTo("tg.game.assets", 2);
    const url = urlOf("a-robot_0-1");
    expect([(await asset(url)).statusCode, (await asset(url)).statusCode]).toEqual([200, 200]);
    const r = await asset(url);
    expect([r.statusCode, r.json().details.policy]).toEqual([429, "tg.game.assets"]);
    expect((await asset(url, {}, "198.51.100.8")).statusCode).toBe(200);
    const keys = await testRedis().keys(`${h.config.rateLimiting.keyPrefix}rl:tg.game.assets:*`);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(" ")).not.toContain("198.51.100");
  });
});

describe("игра недоступна — учёба работает", () => {
  it("GAMIFICATION_URL не задан: все маршруты игры (и картинки) — 503 GAME_UNAVAILABLE без вызова; предупреждение при старте; план работает", async () => {
    await h.close();
    await setup({ GAMIFICATION_URL: "" });
    expect(h.config.gamificationUrl).toBeUndefined();
    expect(h.logs.parsed().filter((l) => l.msg === "GAMIFICATION_URL is not set: /v1/game/* answer 503 GAME_UNAVAILABLE")).toHaveLength(1);
    for (const r of LEARNER_ROUTES) {
      const res = await callRoute(r);
      expect([res.statusCode, res.json().code, res.json().details], r[1]).toEqual([503, "GAME_UNAVAILABLE", { service: "gamification" }]);
    }
    const img = await asset(`/v1/game/assets/a-robot_0-1/${"a".repeat(64)}`);
    expect([img.statusCode, img.json().code]).toEqual([503, "GAME_UNAVAILABLE"]);
    expect(gameCalls()).toHaveLength(0);
    expect((await get("/v1/plan/today")).statusCode).toBe(200);
  });

  it("gamification лежит / 5xx / отказ внутренней авторизации → 503 GAME_UNAVAILABLE на каждом маршруте; план работает", async () => {
    h.fake.down.add("gamification");
    for (const r of LEARNER_ROUTES) {
      const res = await callRoute(r);
      expect([res.statusCode, res.json().code, res.json().details], r[1]).toEqual([503, "GAME_UNAVAILABLE", { service: "gamification" }]);
    }
    expect((await asset(urlOf("a-robot_0-1"))).json().code).toBe("GAME_UNAVAILABLE");
    expect(h.logs.text).toContain("domain unavailable");
    expect((await get("/v1/plan/today")).statusCode).toBe(200);
    h.fake.down.delete("gamification");

    for (const [status, code] of [[500, "BOOM"], [502, "BAD_GATEWAY"], [503, "GAME_UNAVAILABLE"], [401, "INTERNAL_TOKEN_INVALID"], [403, "CALLER_NOT_ALLOWED"], [401, "SOMETHING"]] as const) {
      h.fake.override("gamification", "GET", "/internal/v1/game/summary", () => domainError(status, code));
      const res = await get("/v1/game/summary");
      expect([res.statusCode, res.json().code], `${status} ${code}`).toEqual([503, "GAME_UNAVAILABLE"]);
      expect(res.body).not.toContain("domain says");
    }
  });

  it("ответ не по контракту → 503 GAME_UNAVAILABLE и строка лога без значений", async () => {
    h.fake.game.badSummary = true;
    const res = await get("/v1/game/summary");
    expect([res.statusCode, res.json().code]).toEqual([503, "GAME_UNAVAILABLE"]);
    const line = h.logs.parsed().find((l) => l.msg === "domain response does not match the contract")!;
    expect(line).toMatchObject({ upstream: "gamification", check: "summary", upstream_code: "UPSTREAM_BAD_RESPONSE" });
    expect(h.logs.text).not.toContain("two");
    // история: обёртка не по контракту → 503; элемент не по контракту → отброшен с предупреждением
    h.fake.override("gamification", "GET", "/internal/v1/game/history", () => new Response(JSON.stringify({ items: "x" }), { status: 200, headers: { "content-type": "application/json" } }));
    expect((await get("/v1/game/history")).json().code).toBe("GAME_UNAVAILABLE");
    h.fake.override("gamification", "GET", "/internal/v1/game/history", () =>
      new Response(JSON.stringify({ items: [{ op_id: "x", currency: "gold" }], next_cursor: null }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    expect((await get("/v1/game/history")).json()).toEqual({ items: [], next_cursor: null });
    expect(h.logs.text).toContain("list items dropped");
    // не JSON
    h.fake.override("gamification", "GET", "/internal/v1/game/quests", () => new Response("<html>", { status: 200 }));
    expect((await get("/v1/game/quests")).json().code).toBe("GAME_UNAVAILABLE");
  });

  it("картинки в ответе: готовый url того же пути — принят (sha в нижнем регистре); url чужого вида — 503, внутренний адрес не уходит", async () => {
    await send("PUT", "/v1/game/hero", { hero_code: "robot_0" });
    h.fake.game.imageMode = "url";
    const ok = await get("/v1/game/summary");
    expect(ok.json().hero.image).toEqual({ asset_id: "a-robot_0-1", url: urlOf("a-robot_0-1"), width: 300, height: 460 });
    h.fake.game.imageMode = "bad_url";
    for (const url of ["/v1/game/summary", "/v1/game/heroes", "/v1/game/badges", "/v1/game/shop"]) {
      const res = await get(url);
      expect([res.statusCode, res.json().code], url).toEqual([503, "GAME_UNAVAILABLE"]);
      expect(res.body).not.toContain("railway.internal");
    }
    expect(h.logs.parsed().some((l) => l.rule === "image_url" && l.upstream === "gamification")).toBe(true);
  });
});

describe("картинки: GET /v1/game/assets/{asset_id}/{sha256}", () => {
  it("без авторизации: байты, тип, ETag, Cache-Control как у домена, nosniff; в домен — без sub и без ученика", async () => {
    const a = assetOf("a-robot_0-1");
    const res = await asset(urlOf("a-robot_0-1"));
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(a.bytes)).toBe(true);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["content-length"]).toBe(String(a.bytes.length));
    expect(res.headers.etag).toBe(`"${a.sha256}"`);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const call = gameCalls("GET", "/internal/v1/game/assets/a-robot_0-1")[0]!;
    expect(call.subject).toBeUndefined();
    expect(call.claims).not.toHaveProperty("lrn");
    expect(call.claims).toMatchObject({ iss: "telegram-bff", aud: "gamification" });
    const png = await asset(urlOf("a-bg-forest"));
    expect([png.statusCode, png.headers["content-type"]]).toEqual([200, "image/png"]);
    // тот же путь с Bearer — тоже работает (токен не нужен и не проверяется)
    expect((await asset(urlOf("a-bg-forest"), bearer("a.b.c"))).statusCode).toBe(200);
    const head = await h.app.inject({ method: "HEAD", url: urlOf("a-robot_0-1"), remoteAddress: "198.51.100.7" });
    expect([head.statusCode, head.headers.etag, head.body]).toEqual([200, `"${a.sha256}"`, ""]);
  });

  it("url из сводки открывается: путь от адреса BFF; sha в пути — в любом регистре", async () => {
    await send("PUT", "/v1/game/hero", { hero_code: "pet_0" });
    const url = (await get("/v1/game/summary")).json().hero.image.url as string;
    const res = await asset(url);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(assetOf("a-pet_0-1").bytes)).toBe(true);
    expect((await asset(url.replace(/[0-9a-f]{64}$/, (m) => m.toUpperCase()))).statusCode).toBe(200);
  });

  it("неверный sha → 404 ASSET_NOT_FOUND; нет картинки / не опубликована → 404; путь неверного формата → 404 без вызова домена", async () => {
    const wrong = await asset(`/v1/game/assets/a-robot_0-1/${assetOf("a-robot_0-2").sha256}`);
    expect([wrong.statusCode, wrong.json().code]).toEqual([404, "ASSET_NOT_FOUND"]);
    expect(wrong.headers["cache-control"]).toBe("no-store");
    expect(wrong.headers.etag).toBeUndefined();
    expect((await asset(`/v1/game/assets/a-nothing/${"b".repeat(64)}`)).json().code).toBe("ASSET_NOT_FOUND");
    expect((await asset(urlOf("a-draft"))).json().code).toBe("ASSET_NOT_FOUND");
    const n = gameCalls().length;
    for (const bad of [`a-robot_0-1/${"z".repeat(64)}`, `a-robot_0-1/${"a".repeat(63)}`, `a..b/${"a".repeat(64)}`, `-x/${"a".repeat(64)}`]) {
      const r = await asset(`/v1/game/assets/${bad}`);
      expect([r.statusCode, r.json().code], bad).toEqual([404, "ASSET_NOT_FOUND"]);
    }
    expect(gameCalls()).toHaveLength(n);
  });

  it("If-None-Match с тем же sha → 304 без тела", async () => {
    const a = assetOf("a-robot_0-1");
    const res = await asset(urlOf("a-robot_0-1"), { "if-none-match": `"${a.sha256}"` });
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe("");
    expect(res.headers.etag).toBe(`"${a.sha256}"`);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await asset(urlOf("a-robot_0-1"), { "if-none-match": `"${"c".repeat(64)}"` })).statusCode).toBe(200);
  });

  it("ответ домена не годится → 503 GAME_UNAVAILABLE: байты не совпадают с ETag, не картинка, подмена сигнатуры, нет ETag; ETag без кавычек — принят", async () => {
    const url = urlOf("a-robot_0-1");
    const expect503 = async (what: string) => {
      const r = await asset(url);
      expect([r.statusCode, r.json().code], what).toEqual([503, "GAME_UNAVAILABLE"]);
    };
    h.fake.game.assetBody = Buffer.concat([assetOf("a-robot_0-1").bytes, Buffer.from("x")]);
    await expect503("sha mismatch");
    h.fake.game.assetBody = null;
    h.fake.game.assetType = "text/html";
    await expect503("type");
    h.fake.game.assetType = "image/png"; // байты webp
    await expect503("signature");
    h.fake.game.assetType = null;
    h.fake.game.assetEtag = () => null;
    await expect503("no etag");
    const reasons = h.logs.parsed().filter((l) => l.msg === "game asset rejected").map((l) => l.reason);
    expect(reasons).toEqual(["sha256 mismatch", "unexpected content type", "signature mismatch", "no etag"]);
    h.fake.game.assetEtag = (a) => `W/"${a.sha256.toUpperCase()}"`;
    expect((await asset(url)).statusCode).toBe(200);
    h.fake.game.assetEtag = (a) => a.sha256;
    expect((await asset(url)).statusCode).toBe(200);
  });

  it("слишком большая картинка → 503 (BFF не держит в памяти больше 1 МБ)", async () => {
    h.fake.game.assetBody = Buffer.concat([pngBytes("big"), Buffer.alloc(1024 * 1024)]);
    h.fake.game.assetType = "image/png";
    const r = await asset(urlOf("a-robot_0-1"));
    expect([r.statusCode, r.json().code]).toEqual([503, "GAME_UNAVAILABLE"]);
    expect(h.logs.parsed().find((l) => l.msg === "game asset rejected")!.reason).toBe("image too large");
  });
});
