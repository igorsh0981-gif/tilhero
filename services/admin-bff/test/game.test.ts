/**
 * Спринт 6 — «Игра и герои» через admin-bff (gamification `/internal/v1/admin/game/*`): каждый маршрут — happy path,
 * 401, 403 без права, step-up (и `X-Step-Up: ok` в домен), 422 до домена, GAMIFICATION_URL не задана и домен
 * недоступен → 503; строгие кодеки (лишнее отбрасывается, чужие значения перечислений → 503), StaffRef и имена,
 * url картинки собирает BFF, загрузка картинки (тип, сигнатура, размеры, 300 КБ), выдача байтов картинки, правила
 * (черновик как есть, активная строго), Idempotency-Key, If-Match, коды домена как есть, блок обзора `game`.
 * Общие матрицы (все маршруты admin-bff) — routes.test.ts и security.test.ts.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AdminGameEvent,
  AdminGameImage,
  AdminHero,
  AdminLedgerOperation,
  AdminShopItem,
  AdminWallet,
  Dashboard,
  GameOverview,
  Page,
  RulesValidation,
  RulesVersion,
  RulesVersionSummary,
} from "@tilhero/contracts/admin";
import { inspectAsset, readImageHeader } from "../src/gameImage.js";
import {
  ASSET_ID,
  ASSET_ID_2,
  GAME_EVENT_ID,
  GAME_STAFF_ID,
  LEARNER_USER_ID,
  OP_ID,
  PNG_BYTES,
  PURCHASE_ID,
  SEED_ACTOR_ID,
  browser,
  closeRedis,
  domainError,
  gameEventDomain,
  gameOverview,
  gameRulesPayload,
  heroDomain,
  imageMeta,
  json,
  ledgerOpDomain,
  loginAs,
  makeHarness,
  pngBytes,
  rulesVersionDomain,
  shopItemDomain,
  stepUp,
  walletDomain,
  webpBytes,
  type Harness,
  type Session,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  h.fake.addStaff({ role: "operations", staff_id: GAME_STAFF_ID, display_name: "Гульнора Операции" });
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const GM = "/admin/v1/game";
const GI = "/internal/v1/admin/game";
const SEED_NAME = "Сид (начальное наполнение)";
const L = (ru: string, uz: string) => ({ ru, uz });
const IK = (k: string) => ({ "idempotency-key": `game-${k}-0001` });

const HERO_DRAFT = {
  name: L("Дракончик Мятик", "Ajdarcha Yalpiz"),
  tagline: L("Растёт вместе с тобой", "Sen bilan o'sadi"),
  audiences: ["kids", "teens", "adults"],
  stages: [
    { stage: 1, name: L("Яйцо", "Tuxum"), asset_id: ASSET_ID },
    { stage: 2, name: L("Малыш", "Chaqaloq"), asset_id: ASSET_ID_2 },
    { stage: 3, name: L("Крылья", "Qanotlar"), asset_id: ASSET_ID },
  ],
};
const SHOP_ITEM = {
  code: "bg_sunset",
  kind: "background",
  title: L("Закат", "Quyosh botishi"),
  description: L("Тёплый фон главной", "Iliq fon"),
  asset_id: ASSET_ID,
  theme: { bg: "--paper", accent: "--pen" },
  price_til: 120,
  audiences: ["kids", "teens", "adults"],
  available_from: null,
  available_until: null,
  order: 1,
};
const EVENT = {
  code: "reading_week",
  title: L("Неделя чтения", "O'qish haftaligi"),
  description: L("×2 XP за чтение", "O'qish uchun ×2 XP"),
  starts_at: "2026-11-23T00:00:00+05:00",
  ends_at: "2026-11-30T00:00:00+05:00",
  audiences: ["teens", "adults"],
  multipliers: [{ action: "reading", currency: "xp", factor: 2 }],
};
const ADJUST = { currency: "til", amount: 50, reason: "Компенсация за сбой урока" };
const W = `${GM}/wallets/${LEARNER_USER_ID}`;
const WI = `${GI}/wallets/${LEARNER_USER_ID}`;

interface Case {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  status: number;
  /** путь gamification */
  path: string;
  /** недопустимый вход → 422 до домена */
  invalid: { url?: string; payload?: unknown; headers?: Record<string, string> };
}

/** Все 28 маршрутов игры: ключ — "<METHOD> <шаблон>" как в app.adminRoutes. */
const CASES: Record<string, Case> = {
  "GET /admin/v1/game/overview": { method: "GET", url: `${GM}/overview?period=30d`, status: 200, path: `${GI}/overview`, invalid: { url: `${GM}/overview?period=today` } },
  "GET /admin/v1/game/rules": { method: "GET", url: `${GM}/rules`, status: 200, path: `${GI}/rules`, invalid: { url: `${GM}/rules?status=draft` } },
  "GET /admin/v1/game/rules/:version": { method: "GET", url: `${GM}/rules/1`, status: 200, path: `${GI}/rules/1`, invalid: { url: `${GM}/rules/draft` } },
  "PUT /admin/v1/game/rules/draft": {
    method: "PUT",
    url: `${GM}/rules/draft`,
    payload: { payload: gameRulesPayload(), comment: "Поднимаем лимит тилов", based_on: 1 },
    headers: { "if-match": "2026-11-20T09:00:00.000Z" },
    status: 200,
    path: `${GI}/rules/draft`,
    invalid: { payload: { payload: [1, 2], comment: null, based_on: null } },
  },
  "DELETE /admin/v1/game/rules/draft": { method: "DELETE", url: `${GM}/rules/draft`, status: 204, path: `${GI}/rules/draft`, invalid: { payload: { force: true } } },
  "POST /admin/v1/game/rules/draft/validate": { method: "POST", url: `${GM}/rules/draft/validate`, status: 200, path: `${GI}/rules/draft/validate`, invalid: { payload: { strict: true } } },
  "POST /admin/v1/game/rules/draft/activate": {
    method: "POST",
    url: `${GM}/rules/draft/activate`,
    payload: { comment: "Лимит тилов 80 в день" },
    status: 200,
    path: `${GI}/rules/draft/activate`,
    invalid: { payload: { comment: "коротко" } },
  },
  "POST /admin/v1/game/rules/:version/rollback": {
    method: "POST",
    url: `${GM}/rules/1/rollback`,
    payload: { comment: "Возврат к версии 1" },
    status: 200,
    path: `${GI}/rules/1/rollback`,
    invalid: { url: `${GM}/rules/0/rollback`, payload: { comment: "Возврат к версии 1" } },
  },
  "GET /admin/v1/game/heroes": { method: "GET", url: `${GM}/heroes`, status: 200, path: `${GI}/heroes`, invalid: { url: `${GM}/heroes?line=pet` } },
  "PUT /admin/v1/game/heroes/:code/draft": {
    method: "PUT",
    url: `${GM}/heroes/pet_0/draft`,
    payload: HERO_DRAFT,
    status: 200,
    path: `${GI}/heroes/pet_0/draft`,
    invalid: { payload: { ...HERO_DRAFT, stages: HERO_DRAFT.stages.slice(0, 2) } },
  },
  "POST /admin/v1/game/heroes/:code/publish": {
    method: "POST",
    url: `${GM}/heroes/pet_0/publish`,
    payload: { comment: "Новая картинка ступени" },
    status: 200,
    path: `${GI}/heroes/pet_0/publish`,
    invalid: { url: `${GM}/heroes/Pet-0/publish`, payload: { comment: "Новая картинка ступени" } },
  },
  "POST /admin/v1/game/assets": {
    method: "POST",
    url: `${GM}/assets?purpose=hero_stage`,
    payload: PNG_BYTES,
    headers: { "content-type": "image/png" },
    status: 201,
    path: `${GI}/assets`,
    invalid: { url: `${GM}/assets?purpose=avatar`, payload: PNG_BYTES, headers: { "content-type": "image/png" } },
  },
  "GET /admin/v1/game/assets/:assetId/content": {
    method: "GET",
    url: `${GM}/assets/${ASSET_ID}/content`,
    status: 200,
    path: `${GI}/assets/${ASSET_ID}/content`,
    invalid: { url: `${GM}/assets/not-a-uuid/content` },
  },
  "GET /admin/v1/game/shop/items": { method: "GET", url: `${GM}/shop/items`, status: 200, path: `${GI}/shop/items`, invalid: { url: `${GM}/shop/items?status=draft` } },
  "POST /admin/v1/game/shop/items": {
    method: "POST",
    url: `${GM}/shop/items`,
    payload: SHOP_ITEM,
    headers: IK("item"),
    status: 201,
    path: `${GI}/shop/items`,
    invalid: { payload: { ...SHOP_ITEM, kind: "streak_freeze" }, headers: IK("item") },
  },
  "PATCH /admin/v1/game/shop/items/:code": {
    method: "PATCH",
    url: `${GM}/shop/items/bg_sunset`,
    payload: { price_til: 150 },
    status: 200,
    path: `${GI}/shop/items/bg_sunset`,
    invalid: { payload: {} },
  },
  "POST /admin/v1/game/shop/items/:code/publish": {
    method: "POST",
    url: `${GM}/shop/items/bg_sunset/publish`,
    payload: { comment: "В продажу" },
    status: 200,
    path: `${GI}/shop/items/bg_sunset/publish`,
    invalid: { payload: {} },
  },
  "POST /admin/v1/game/shop/items/:code/retire": {
    method: "POST",
    url: `${GM}/shop/items/bg_sunset/retire`,
    payload: { comment: "Конец сезона" },
    status: 200,
    path: `${GI}/shop/items/bg_sunset/retire`,
    invalid: { url: `${GM}/shop/items/bg/retire`, payload: { comment: "Конец сезона" } },
  },
  "GET /admin/v1/game/events": { method: "GET", url: `${GM}/events?status=draft`, status: 200, path: `${GI}/events`, invalid: { url: `${GM}/events?status=active` } },
  "POST /admin/v1/game/events": {
    method: "POST",
    url: `${GM}/events`,
    payload: EVENT,
    headers: IK("event"),
    status: 201,
    path: `${GI}/events`,
    invalid: { payload: { ...EVENT, multipliers: [{ action: "reading", currency: "xp", factor: 2.5 }] }, headers: IK("event") },
  },
  "PATCH /admin/v1/game/events/:id": {
    method: "PATCH",
    url: `${GM}/events/${GAME_EVENT_ID}`,
    payload: { audiences: ["kids"] },
    status: 200,
    path: `${GI}/events/${GAME_EVENT_ID}`,
    invalid: { payload: { audiences: [] } },
  },
  "POST /admin/v1/game/events/:id/publish": {
    method: "POST",
    url: `${GM}/events/${GAME_EVENT_ID}/publish`,
    payload: { comment: "Запуск недели чтения" },
    status: 200,
    path: `${GI}/events/${GAME_EVENT_ID}/publish`,
    invalid: { payload: { comment: "Запуск", extra: 1 } },
  },
  "POST /admin/v1/game/events/:id/cancel": {
    method: "POST",
    url: `${GM}/events/${GAME_EVENT_ID}/cancel`,
    payload: { comment: "Перенос на декабрь" },
    status: 200,
    path: `${GI}/events/${GAME_EVENT_ID}/cancel`,
    invalid: { url: `${GM}/events/42/cancel`, payload: { comment: "Перенос на декабрь" } },
  },
  "GET /admin/v1/game/wallets/:userId": { method: "GET", url: W, status: 200, path: WI, invalid: { url: `${GM}/wallets/42` } },
  "GET /admin/v1/game/wallets/:userId/ledger": {
    method: "GET",
    url: `${W}/ledger?currency=freeze&cursor=c1&limit=50`,
    status: 200,
    path: `${WI}/ledger`,
    invalid: { url: `${W}/ledger?currency=gold` },
  },
  "POST /admin/v1/game/wallets/:userId/adjustments": {
    method: "POST",
    url: `${W}/adjustments`,
    payload: ADJUST,
    headers: IK("adjust"),
    status: 201,
    path: `${WI}/adjustments`,
    invalid: { payload: { ...ADJUST, amount: 0 }, headers: IK("adjust") },
  },
  "POST /admin/v1/game/wallets/:userId/ledger/:opId/reverse": {
    method: "POST",
    url: `${W}/ledger/${OP_ID}/reverse`,
    payload: { reason: "Ошибочное начисление" },
    status: 200,
    path: `${WI}/ledger/${OP_ID}/reverse`,
    invalid: { payload: { reason: "ошибка" } },
  },
  "POST /admin/v1/game/wallets/:userId/purchases/:purchaseId/refund": {
    method: "POST",
    url: `${W}/purchases/${PURCHASE_ID}/refund`,
    payload: { reason: "Покупка по ошибке ребёнка" },
    status: 200,
    path: `${WI}/purchases/${PURCHASE_ID}/refund`,
    invalid: { payload: { reason: "Покупка по ошибке ребёнка", amount: 120 } },
  },
};

const inject = (s: Session | null, c: { method: Case["method"]; url: string; payload?: unknown; headers?: Record<string, string> }) =>
  h.app.inject({
    method: c.method,
    url: c.url,
    headers: { ...browser(s), ...c.headers },
    ...(c.method === "GET" ? {} : { payload: (c.payload ?? {}) as object }),
  });
const get = (s: Session, url: string) => h.app.inject({ url, headers: browser(s) });
const send = (s: Session, method: Case["method"], url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  inject(s, { method, url, payload, headers });
const gameRoutes = () => h.app.adminRoutes.filter((r) => r.url.startsWith(`${GM}/`));
const gameCalls = () => h.fake.callsTo("gamification");

function denied(res: { statusCode: number; json(): { code: string; details: { permission?: string } } }, permission: string) {
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission } });
}

// ---------------------------------------------------------------- каждый маршрут

describe("маршруты игры: каждый", () => {
  it("таблица покрывает все 28 маршрутов /admin/v1/game/*", () => {
    const have = gameRoutes().map((r) => `${r.method} ${r.url}`).sort();
    expect(have).toEqual(Object.keys(CASES).sort());
    expect(have).toHaveLength(28);
  });

  it("happy path: статус, путь gamification с actor; X-Step-Up: ok — ровно у команд со step-up; Idempotency-Key передаётся", async () => {
    const { staff, s } = await loginAs(h, "super_admin", { display_name: "Супер Админ" });
    await stepUp(h, s);
    const stepUpRoutes = new Set(gameRoutes().filter((r) => r.stepUp).map((r) => `${r.method} ${r.url}`));
    expect(stepUpRoutes.size).toBe(10);
    for (const [key, c] of Object.entries(CASES)) {
      const before = gameCalls().length;
      const res = await inject(s, c);
      expect(res.statusCode, `${key}: ${res.body.slice(0, 300)}`).toBe(c.status);
      const calls = gameCalls().slice(before);
      expect(calls, key).toHaveLength(1);
      const call = calls[0]!;
      expect(`${call.method} ${call.path}`, key).toBe(`${c.method} ${c.path}`);
      expect(call.actor, key).toMatchObject({ id: staff.staff_id, role: "super_admin", name: "Супер Админ" });
      expect(call.headers["x-step-up"], key).toBe(stepUpRoutes.has(key) ? "ok" : undefined);
      if (c.headers?.["idempotency-key"]) expect(call.headers["idempotency-key"], key).toBe(c.headers["idempotency-key"]);
    }
  });

  it("401: без сессии и с чужой cookie — на каждом маршруте, домен не вызывается", async () => {
    for (const [key, c] of Object.entries(CASES)) {
      for (const s of [null, { id: "Z".repeat(43), csrf: "x" } as Session]) {
        const res = await inject(s, c);
        expect(res.statusCode, key).toBe(401);
        expect(res.json().code, key).toBe("UNAUTHORIZED");
      }
    }
    expect(gameCalls()).toHaveLength(0);
  });

  it("403: роль без права (read_only, communications, qa_analyst) — на каждом маршруте, тело картинки не читается, домен не вызывается", async () => {
    for (const role of ["read_only", "communications", "qa_analyst"] as const) {
      const { s } = await loginAs(h, role);
      for (const [key, c] of Object.entries(CASES)) {
        const route = gameRoutes().find((r) => `${r.method} ${r.url}` === key)!;
        denied(await inject(s, c), route.guard);
      }
    }
    // загрузка больше лимита — всё равно 403 (тело не читается до проверки права)
    const { s } = await loginAs(h, "support");
    denied(await send(s, "POST", `${GM}/assets?purpose=badge`, Buffer.alloc(400 * 1024, 1), { "content-type": "image/png" }), "game.manage");
    expect(gameCalls()).toHaveLength(0);
  });

  it("step-up: game.publish и wallet.adjust без свежего TOTP → 403 STEP_UP_REQUIRED {permission}, домен не вызывается", async () => {
    const { s } = await loginAs(h, "operations");
    const su = gameRoutes().filter((r) => r.stepUp);
    for (const r of su) {
      const key = `${r.method} ${r.url}`;
      const res = await inject(s, CASES[key]!);
      expect(res.statusCode, key).toBe(403);
      expect(res.json(), key).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: r.guard } });
    }
    expect(su.map((r) => r.guard).sort()).toEqual([...Array(7).fill("game.publish"), ...Array(3).fill("wallet.adjust")]);
    expect(gameCalls()).toHaveLength(0);
  });

  it("422: недопустимый вход (путь, параметры, тело) — на каждом маршруте до домена", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    for (const [key, c] of Object.entries(CASES)) {
      const res = await inject(s, { method: c.method, url: c.invalid.url ?? c.url, payload: c.invalid.payload ?? c.payload, headers: c.invalid.headers ?? c.headers });
      expect(res.statusCode, `${key}: ${res.body.slice(0, 200)}`).toBe(422);
      expect(res.json().code, key).toBe("VALIDATION_ERROR");
    }
    expect(gameCalls()).toHaveLength(0);
  });

  it("GAMIFICATION_URL не задана → 503 UPSTREAM_UNAVAILABLE {service: gamification} на каждом маршруте (после права и step-up)", async () => {
    await h.close();
    h = await makeHarness({ GAMIFICATION_URL: "" });
    expect(h.config.gamificationUrl).toBeNull();
    expect(h.logs.text).toContain("GAMIFICATION_URL is not set");
    const ro = (await loginAs(h, "read_only")).s;
    denied(await get(ro, `${GM}/heroes`), "game.read"); // право — раньше недоступности
    const { s } = await loginAs(h, "super_admin");
    expect((await inject(s, CASES["POST /admin/v1/game/rules/draft/activate"]!)).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    for (const [key, c] of Object.entries(CASES)) {
      const res = await inject(s, c);
      expect(res.statusCode, key).toBe(503);
      expect(res.json(), key).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "gamification" } });
    }
    expect(gameCalls()).toHaveLength(0);
    // остальная админка работает
    expect((await get(s, "/admin/v1/memory/stats")).statusCode).toBe(200);
  });

  it("gamification недоступен (сеть) или 5xx → 503 {service: gamification} на каждом маршруте; тело 5xx не уходит", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    h.fake.down.add("gamification");
    for (const [key, c] of Object.entries(CASES)) {
      const res = await inject(s, c);
      expect(res.statusCode, key).toBe(503);
      expect(res.json(), key).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "gamification" } });
    }
  });
});

// ---------------------------------------------------------------- права по ролям PLAN спринта 6

describe("права по ролям (PLAN спринта 6 «Права и роли»)", () => {
  it("content_manager: чтение и черновики (game.manage), без публикации и кошельковых команд", async () => {
    const { s } = await loginAs(h, "content_manager");
    expect((await get(s, `${GM}/heroes`)).statusCode).toBe(200);
    expect((await send(s, "PUT", `${GM}/heroes/pet_0/draft`, HERO_DRAFT)).statusCode).toBe(200);
    expect((await send(s, "POST", `${GM}/assets?purpose=hero_stage`, PNG_BYTES, { "content-type": "image/png" })).statusCode).toBe(201);
    expect((await send(s, "POST", `${GM}/shop/items`, SHOP_ITEM, IK("cm"))).statusCode).toBe(201);
    expect((await send(s, "POST", `${GM}/rules/draft/validate`)).statusCode).toBe(200);
    denied(await send(s, "POST", `${GM}/heroes/pet_0/publish`, { comment: "Публикую" }), "game.publish");
    denied(await send(s, "POST", `${W}/adjustments`, ADJUST, IK("cm")), "wallet.adjust");
  });

  it("methodist, support, analyst, auditor: только чтение (support — кошелёк ученика из обращения)", async () => {
    for (const role of ["methodist", "support", "analyst", "auditor"] as const) {
      const { s } = await loginAs(h, role);
      expect((await get(s, W)).statusCode, role).toBe(200);
      expect((await get(s, `${W}/ledger`)).statusCode, role).toBe(200);
      expect((await get(s, `${GM}/rules`)).statusCode, role).toBe(200);
      expect((await get(s, `${GM}/assets/${ASSET_ID}/content`)).statusCode, role).toBe(200);
      denied(await send(s, "PUT", `${GM}/heroes/pet_0/draft`, HERO_DRAFT), "game.manage");
      denied(await send(s, "POST", `${W}/adjustments`, ADJUST, IK(role)), "wallet.adjust");
    }
  });

  it("operations: публикация и кошелёк — со step-up; actor несёт game.publish и wallet.adjust", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    expect((await send(s, "POST", `${GM}/events/${GAME_EVENT_ID}/publish`, { comment: "Запуск недели" })).statusCode).toBe(200);
    const res = await send(s, "POST", `${W}/adjustments`, ADJUST, IK("ops"));
    expect(res.statusCode).toBe(201);
    const call = h.fake.callsTo("gamification", "POST", `${WI}/adjustments`)[0]!;
    expect(call.body).toEqual(ADJUST);
    expect(call.actor?.permissions).toEqual(expect.arrayContaining(["game.read", "game.manage", "game.publish", "wallet.adjust"]));
    expect(call.headers["x-step-up"]).toBe("ok");
  });
});

// ---------------------------------------------------------------- правила

describe("правила игры", () => {
  it("версия: активная — строго GameRules (лишнее в payload отброшено), имена StaffRef — seed «Сид», diff как есть", async () => {
    const { s } = await loginAs(h, "methodist");
    const payload = { ...gameRulesPayload(), secret: "x", caps: { xp_per_day: 300, til_per_day: 60, hidden: 1 } };
    h.fake.on("gamification", "GET", `${GI}/rules/1`, () =>
      json(200, rulesVersionDomain({ payload, diff: [{ path: "caps.til_per_day", from: 60, to: 80 }, { path: "levels[20]", to: 11500 }], internal_hash: "abc" })),
    );
    const res = await get(s, `${GM}/rules/1`);
    expect(res.statusCode).toBe(200);
    const v = res.json() as RulesVersion;
    expect(v.payload).toEqual(gameRulesPayload());
    expect(v.diff).toEqual([{ path: "caps.til_per_day", from: 60, to: 80 }, { path: "levels[20]", from: null, to: 11500 }]);
    expect(v.created_by).toEqual({ staff_id: SEED_ACTOR_ID, name: SEED_NAME });
    expect(v.activated_by).toEqual({ staff_id: SEED_ACTOR_ID, name: SEED_NAME });
    expect(v).not.toHaveProperty("internal_hash");
  });

  it("версия: черновик — payload как есть (ещё не проверен: ошибки показывает validate); активная с испорченным payload → 503", async () => {
    const { s } = await loginAs(h, "methodist");
    const raw = { earn: "nope", extra_key: [1, 2, 3] };
    h.fake.on("gamification", "GET", `${GI}/rules/2`, () => json(200, rulesVersionDomain({ version: 2, status: "draft", payload: raw, activated_by: null, activated_at: null })));
    const draft = await get(s, `${GM}/rules/2`);
    expect(draft.statusCode).toBe(200);
    expect((draft.json() as RulesVersion).payload).toEqual(raw);

    for (const bad of [{ ...gameRulesPayload(), levels: "0,100" }, { ...gameRulesPayload(), hero: { stage_thresholds: [0, 5] } }]) {
      h.fake.on("gamification", "GET", `${GI}/rules/1`, () => json(200, rulesVersionDomain({ payload: bad })));
      const res = await get(s, `${GM}/rules/1`);
      expect(res.statusCode).toBe(503);
      expect(res.json().details.service).toBe("gamification");
    }
    const tpl = gameRulesPayload() as { quests: { templates: Array<Record<string, unknown>> } };
    tpl.quests.templates[0]!.kind = "duel_win";
    h.fake.on("gamification", "GET", `${GI}/rules/1`, () => json(200, rulesVersionDomain({ payload: tpl })));
    expect((await get(s, `${GM}/rules/1`)).statusCode).toBe(503);
    expect(h.logs.text).toContain("$.payload.quests.templates[0].kind");
    expect(h.logs.text).not.toContain("duel_win");
  });

  it("список версий: без payload; неизвестный статус версии → 503", async () => {
    const { s } = await loginAs(h, "auditor");
    const list = (await get(s, `${GM}/rules`)).json() as { items: RulesVersionSummary[] };
    expect(list.items.map((v) => [v.version, v.status])).toEqual([[2, "draft"], [1, "active"]]);
    expect(list.items[0]).not.toHaveProperty("payload");
    h.fake.on("gamification", "GET", `${GI}/rules`, () => json(200, { items: [{ ...rulesVersionDomain(), status: "pending" }] }));
    expect((await get(s, `${GM}/rules`)).statusCode).toBe(503);
  });

  it("черновик: If-Match передаётся как есть; неверный формат → 422; 409 DRAFT_CONFLICT и 422 RULES_INVALID {errors} — как есть", async () => {
    const { staff, s } = await loginAs(h, "content_manager");
    const body = { payload: gameRulesPayload(), comment: null, based_on: 1 };
    const ok = await send(s, "PUT", `${GM}/rules/draft`, body, { "if-match": "2026-11-20T09:00:00.000Z" });
    expect(ok.statusCode).toBe(200);
    expect(h.fake.callsTo("gamification", "PUT")[0]!.headers["if-match"]).toBe("2026-11-20T09:00:00.000Z");
    expect(h.fake.callsTo("gamification", "PUT")[0]!.body).toEqual(body);
    expect((ok.json() as RulesVersion).created_by).toEqual({ staff_id: staff.staff_id, name: staff.display_name });
    expect((await send(s, "PUT", `${GM}/rules/draft`, body, { "if-match": "bad value; drop" })).statusCode).toBe(422);
    // без If-Match — решает домен (новый черновик)
    await send(s, "PUT", `${GM}/rules/draft`, body);
    expect(h.fake.callsTo("gamification", "PUT")[1]!.headers["if-match"]).toBeUndefined();

    h.fake.on("gamification", "PUT", `${GI}/rules/draft`, () => domainError(409, "DRAFT_CONFLICT", { updated_at: "2026-11-20T09:05:00Z" }));
    expect((await send(s, "PUT", `${GM}/rules/draft`, body, { "if-match": "2026-11-20T09:00:00.000Z" })).json()).toMatchObject({
      code: "DRAFT_CONFLICT",
      details: { updated_at: "2026-11-20T09:05:00Z" },
    });
    const errors = [{ path: "levels[3]", code: "NOT_INCREASING" }];
    h.fake.on("gamification", "POST", `${GI}/rules/draft/validate`, () => domainError(422, "RULES_INVALID", { errors }));
    const inv = await send(s, "POST", `${GM}/rules/draft/validate`);
    expect(inv.statusCode).toBe(422);
    expect(inv.json()).toMatchObject({ code: "RULES_INVALID", details: { errors } });
  });

  it("проверка: {ok, errors, warnings} строго; удаление черновика → 204", async () => {
    const { s } = await loginAs(h, "content_manager");
    const v = (await send(s, "POST", `${GM}/rules/draft/validate`)).json() as RulesValidation;
    expect(v).toEqual({ ok: true, errors: [], warnings: [{ path: "hero.stage_thresholds[1]", code: "STAGE2_HIGH" }] });
    const del = await send(s, "DELETE", `${GM}/rules/draft`);
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");
  });

  it("активация и откат: комментарий ≥ 10 до домена; 409 RULES_NOT_VALIDATED — как есть; activated_by — сотрудник из lookup", async () => {
    const { s } = await loginAs(h, "operations", { display_name: "Олим Операции" });
    await stepUp(h, s);
    expect((await send(s, "POST", `${GM}/rules/draft/activate`, { comment: "коротко" })).statusCode).toBe(422);
    expect((await send(s, "POST", `${GM}/rules/draft/activate`, {})).statusCode).toBe(422);
    const res = await send(s, "POST", `${GM}/rules/draft/activate`, { comment: "Лимит тилов 80 в день" }, IK("act"));
    expect(res.statusCode).toBe(200);
    const v = res.json() as RulesVersion;
    expect(v.status).toBe("active");
    expect(v.activated_by?.name).toBe("Олим Операции");
    expect(h.fake.callsTo("gamification", "POST", `${GI}/rules/draft/activate`)[0]!.headers["idempotency-key"]).toBe("game-act-0001");
    const rb = (await send(s, "POST", `${GM}/rules/1/rollback`, { comment: "Возврат к версии 1" })).json() as RulesVersion;
    expect([rb.version, rb.based_on]).toEqual([3, 1]);
    h.fake.on("gamification", "POST", `${GI}/rules/draft/activate`, () => domainError(409, "RULES_NOT_VALIDATED"));
    const nv = await send(s, "POST", `${GM}/rules/draft/activate`, { comment: "Лимит тилов 80 в день" });
    expect(nv.statusCode).toBe(409);
    expect(nv.json().code).toBe("RULES_NOT_VALIDATED");
  });
});

// ---------------------------------------------------------------- герои и картинки

describe("герои", () => {
  it("список: url картинки собирает BFF (значение домена не берётся), имена StaffRef, лишнее отброшено", async () => {
    const { s } = await loginAs(h, "methodist");
    h.fake.on("gamification", "GET", `${GI}/heroes`, () =>
      json(200, {
        items: [
          heroDomain({
            images: [1, 2, 3].map((stage) => ({ stage, image: imageMeta({ url: "javascript:alert(1)", storage_key: "s3://x" }) })),
            published_by: { staff_id: GAME_STAFF_ID, name: "Имя из токена" },
            selected_by: [LEARNER_USER_ID],
          }),
        ],
      }),
    );
    const res = await get(s, `${GM}/heroes`);
    expect(res.statusCode).toBe(200);
    const hero = (res.json() as { items: AdminHero[] }).items[0]!;
    expect(hero.images[0]!.image).toEqual({ asset_id: ASSET_ID, sha256: "ab".repeat(32), url: `${GM}/assets/${ASSET_ID}/content`, width: 380, height: 460, size: 32_000 });
    expect(hero.published_by).toEqual({ staff_id: GAME_STAFF_ID, name: "Гульнора Операции" });
    expect(hero).not.toHaveProperty("selected_by");
    expect(res.body).not.toContain("javascript");
    expect(res.body).not.toContain("s3://");
  });

  it("черновик: тело AdminHeroFields строго (3 ступени, стадии 1..3, аудитории, uuid картинок); ответ с draft.images", async () => {
    const { s } = await loginAs(h, "content_manager");
    for (const bad of [
      { ...HERO_DRAFT, stages: [...HERO_DRAFT.stages.slice(0, 2), { ...HERO_DRAFT.stages[2]!, stage: 4 }] },
      { ...HERO_DRAFT, audiences: ["babies"] },
      { ...HERO_DRAFT, stages: HERO_DRAFT.stages.map((st) => ({ ...st, asset_id: "x" })) },
      { ...HERO_DRAFT, name: L("", "Ajdarcha") },
      { ...HERO_DRAFT, published: true },
    ]) {
      expect((await send(s, "PUT", `${GM}/heroes/pet_0/draft`, bad)).statusCode).toBe(422);
    }
    // скрыть из выбора — пустые аудитории допустимы
    const res = await send(s, "PUT", `${GM}/heroes/pet_0/draft`, { ...HERO_DRAFT, audiences: [] });
    expect(res.statusCode).toBe(200);
    const hero = res.json() as AdminHero;
    expect(hero.draft?.audiences).toEqual([]);
    expect(hero.draft?.images.map((i) => i.image.url)).toEqual([ASSET_ID, ASSET_ID_2, ASSET_ID].map((id) => `${GM}/assets/${id}/content`));
    expect(h.fake.callsTo("gamification", "PUT")).toHaveLength(1);
  });

  it("публикация: 409 HERO_IN_USE {learners} — как есть; чужая линия, ступень 4, картинка больше 1024 → 503", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    h.fake.on("gamification", "POST", `${GI}/heroes/pet_0/publish`, () => domainError(409, "HERO_IN_USE", { learners: 12 }));
    expect((await send(s, "POST", `${GM}/heroes/pet_0/publish`, { comment: "Снять с публикации" })).json()).toMatchObject({ code: "HERO_IN_USE", details: { learners: 12 } });
    for (const bad of [
      heroDomain({ line: "dragon" }),
      heroDomain({ stages: [{ stage: 4, name: L("x", "x"), asset_id: ASSET_ID }] }),
      heroDomain({ images: [{ stage: 1, image: imageMeta({ width: 2048 }) }] }),
      heroDomain({ audiences: ["everyone"] }),
      heroDomain({ published_by: { staff_id: "robot", name: "x" } }),
    ]) {
      h.fake.on("gamification", "GET", `${GI}/heroes`, () => json(200, { items: [bad] }));
      const res = await get(s, `${GM}/heroes`);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "gamification" } });
    }
  });
});

describe("загрузка картинки", () => {
  const upload = (s: Session, body: Buffer, type: string, purpose = "hero_stage", extra: Record<string, string> = {}) =>
    send(s, "POST", `${GM}/assets?purpose=${purpose}`, body, { "content-type": type, ...extra });

  it("заголовки форматов: PNG IHDR, WebP VP8 / VP8L / VP8X — размеры читаются верно", () => {
    expect(readImageHeader(pngBytes(512, 300))).toEqual({ type: "image/png", width: 512, height: 300 });
    for (const chunk of ["VP8 ", "VP8L", "VP8X"] as const) {
      expect(readImageHeader(webpBytes(chunk, 1024, 7)), chunk).toEqual({ type: "image/webp", width: 1024, height: 7 });
    }
    expect(readImageHeader(Buffer.from("GIF89a....................................."))).toBeNull();
    expect(readImageHeader(pngBytes().subarray(0, 20))).toBeNull();
  });

  /** Настоящие картинки героев (сид gamification, Figma AI → webp VP8X, высота 460): заголовок читается, проверка проходит. */
  const SEED_DIR = new URL("../../gamification/migrations/seed/heroes/", import.meta.url);
  it.skipIf(!existsSync(SEED_DIR))("27 картинок сида героев: VP8X, высота 460, ≤ 1024 px и ≤ 300 КБ; загрузка через admin-bff проходит", async () => {
    const files = readdirSync(SEED_DIR).filter((f) => f.endsWith(".webp")).sort();
    expect(files).toHaveLength(27);
    for (const f of files) {
      const bytes = readFileSync(new URL(f, SEED_DIR));
      const head = inspectAsset(bytes, "image/webp");
      expect(head.height, f).toBe(460);
      expect(head.width, f).toBeGreaterThan(100);
    }
    const { s } = await loginAs(h, "content_manager");
    const pet = readFileSync(new URL("pet_1_3.webp", SEED_DIR));
    const res = await upload(s, pet, "image/webp");
    expect(res.statusCode).toBe(201);
    expect((gameCalls()[0]!.body as Buffer).equals(pet)).toBe(true);
  });

  it("png и webp → байты как есть в gamification (тип, ?purpose, actor); ответ AdminGameImage с url BFF; повтор (200) — как есть", async () => {
    const { s } = await loginAs(h, "content_manager");
    for (const [body, type, purpose] of [
      [PNG_BYTES, "image/png", "hero_stage"],
      [webpBytes("VP8 "), "image/webp", "shop_item"],
      [webpBytes("VP8X", 1024, 1024), "image/webp; charset=binary", "badge"],
    ] as const) {
      const before = gameCalls().length;
      const res = await upload(s, body, type, purpose, IK(`up${purpose}`));
      expect(res.statusCode, type).toBe(201);
      const img = res.json() as AdminGameImage;
      expect(img).toEqual({
        asset_id: ASSET_ID_2,
        sha256: createHash("sha256").update(body).digest("hex"),
        url: `${GM}/assets/${ASSET_ID_2}/content`,
        width: 380,
        height: 460,
        size: body.length,
      });
      const call = gameCalls()[before]!;
      expect(Buffer.isBuffer(call.body) && call.body.equals(body)).toBe(true);
      expect(call.headers["content-type"]).toBe(type.split(";")[0]);
      expect(call.query).toEqual({ purpose });
      expect(call.headers["idempotency-key"]).toBe(`game-up${purpose}-0001`);
    }
    h.fake.on("gamification", "POST", `${GI}/assets`, () => json(200, imageMeta(), { "idempotent-replayed": "true" }));
    const again = await upload(s, PNG_BYTES, "image/png");
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
  });

  it("размер: ровно 300 КБ — проходит; больше (по Content-Length или по потоку) → 413 ASSET_TOO_LARGE без вызова домена", async () => {
    const { s } = await loginAs(h, "content_manager");
    const max = Buffer.concat([PNG_BYTES, Buffer.alloc(300 * 1024 - PNG_BYTES.length, 1)]);
    expect((await upload(s, max, "image/png")).statusCode).toBe(201);
    const before = gameCalls().length;
    const big = await upload(s, Buffer.concat([max, Buffer.alloc(1)]), "image/png");
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ code: "ASSET_TOO_LARGE", details: { max_bytes: 300 * 1024 } });
    // поток без Content-Length (chunked): лимит — по прочитанному
    const { Readable } = await import("node:stream");
    const stream = await h.app.inject({
      method: "POST",
      url: `${GM}/assets?purpose=badge`,
      headers: { ...browser(s), "content-type": "image/webp" },
      payload: Readable.from([webpBytes(), Buffer.alloc(200 * 1024), Buffer.alloc(200 * 1024)]),
    });
    expect(stream.statusCode).toBe(413);
    expect(stream.json().code).toBe("ASSET_TOO_LARGE");
    expect(gameCalls()).toHaveLength(before);
  });

  it("тип и байты: jpeg / json / пусто / мусор / тип ≠ байтам / больше 1024 px → 422 ASSET_INVALID {reason} (jpeg тип — тоже 422); без purpose → 422", async () => {
    const { s } = await loginAs(h, "content_manager");
    const cases: Array<[Buffer | object, string, string]> = [
      [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), "image/jpeg", "content_type"],
      [Buffer.from("<svg onload=alert(1)>"), "image/svg+xml", "content_type"],
      [{ data: "iVBORw0KGgo=" }, "application/json", "content_type"],
      [Buffer.alloc(0), "image/png", "empty"],
      [Buffer.from("<html><script>alert(1)</script></html>"), "image/png", "signature"],
      [webpBytes(), "image/png", "type_mismatch"],
      [PNG_BYTES, "image/webp", "type_mismatch"],
      [pngBytes(1025, 10), "image/png", "dimensions"],
      [webpBytes("VP8L", 10, 2000), "image/webp", "dimensions"],
      [pngBytes(0, 10), "image/png", "dimensions"],
    ];
    for (const [body, type, reason] of cases) {
      const res = await upload(s, body as Buffer, type);
      expect(res.statusCode, `${type} ${reason}`).toBe(422);
      expect(res.json(), `${type} ${reason}`).toMatchObject({ code: "ASSET_INVALID", details: { reason } });
    }
    expect((await send(s, "POST", `${GM}/assets`, PNG_BYTES, { "content-type": "image/png" })).statusCode).toBe(422);
    expect((await upload(s, PNG_BYTES, "image/png", "avatar")).statusCode).toBe(422);
    // octet-stream не разбирается вовсе — 415
    expect((await upload(s, PNG_BYTES, "application/octet-stream")).statusCode).toBe(415);
    expect(gameCalls()).toHaveLength(0);
  });

  it("картинка в теле другого маршрута → 415; 422 ASSET_INVALID и 413 домена — как есть; испорченный ответ (size > 300 КБ) → 503", async () => {
    const { s } = await loginAs(h, "content_manager");
    const other = await send(s, "PUT", `${GM}/heroes/pet_0/draft`, PNG_BYTES, { "content-type": "image/png" });
    expect(other.statusCode).toBe(415);
    h.fake.on("gamification", "POST", `${GI}/assets`, () => domainError(422, "ASSET_INVALID", { reason: "decode" }));
    expect((await upload(s, PNG_BYTES, "image/png")).json()).toMatchObject({ code: "ASSET_INVALID", details: { reason: "decode" } });
    h.fake.on("gamification", "POST", `${GI}/assets`, () => json(201, imageMeta({ size: 400 * 1024 })));
    expect((await upload(s, PNG_BYTES, "image/png")).statusCode).toBe(503);
  });
});

describe("байты картинки для админки", () => {
  it("image/png по сигнатуре → байты, nosniff, no-store, inline; 404 домена — как есть", async () => {
    const { s } = await loginAs(h, "support");
    const res = await get(s, `${GM}/assets/${ASSET_ID.toUpperCase()}/content`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(res.rawPayload.equals(PNG_BYTES)).toBe(true);
    expect(gameCalls()[0]!.path).toBe(`${GI}/assets/${ASSET_ID}/content`);
    h.fake.on("gamification", "GET", `${GI}/assets/${ASSET_ID}/content`, () => domainError(404, "ASSET_NOT_FOUND"));
    expect((await get(s, `${GM}/assets/${ASSET_ID}/content`)).json().code).toBe("ASSET_NOT_FOUND");
  });

  it("домен отдал html, svg, тип ≠ байтам или больше 300 КБ → 503, в браузер ничего не уходит", async () => {
    const { s } = await loginAs(h, "support");
    const bodies: Array<[Uint8Array, string]> = [
      [Buffer.from("<html><script>alert(1)</script></html>"), "text/html"],
      [Buffer.from("<svg onload=alert(1)/>"), "image/svg+xml"],
      [Buffer.from("<script>alert(1)</script>"), "image/png"],
      [webpBytes(), "image/png"],
      [Buffer.concat([PNG_BYTES, Buffer.alloc(300 * 1024)]), "image/png"],
    ];
    for (const [bytes, type] of bodies) {
      h.fake.on("gamification", "GET", `${GI}/assets/${ASSET_ID}/content`, () => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } }));
      const res = await get(s, `${GM}/assets/${ASSET_ID}/content`);
      expect(res.statusCode, type).toBe(503);
      expect(res.body).not.toContain("alert");
    }
  });
});

// ---------------------------------------------------------------- магазин

describe("магазин", () => {
  it("список: предметы и заморозка; тема — ключи токенов; лишнее отброшено; CSS в теме, чужой вид или статус → 503", async () => {
    const { s } = await loginAs(h, "methodist");
    const list = (await get(s, `${GM}/shop/items`)).json() as { items: AdminShopItem[] };
    expect(list.items.map((i) => [i.code, i.kind, i.status])).toEqual([["bg_sunset", "background", "draft"], ["streak_freeze", "streak_freeze", "published"]]);
    expect(list.items[0]!.image?.url).toBe(`${GM}/assets/${ASSET_ID}/content`);
    expect(list.items[0]!.theme).toEqual({ bg: "--paper", accent: "--pen" });
    for (const bad of [
      shopItemDomain({ theme: { bg: "#fff", accent: "--pen" } }),
      shopItemDomain({ theme: { bg: "url(https://evil.example/x)", accent: "--pen" } }),
      shopItemDomain({ kind: "avatar" }),
      shopItemDomain({ status: "archived" }),
      shopItemDomain({ price_til: 0 }),
      shopItemDomain({ updated_at: "2026-11-20 09:00" }),
    ]) {
      h.fake.on("gamification", "GET", `${GI}/shop/items`, () => json(200, { items: [bad] }));
      expect((await get(s, `${GM}/shop/items`)).statusCode).toBe(503);
    }
    h.fake.on("gamification", "GET", `${GI}/shop/items`, () => json(200, { items: [shopItemDomain({ internal_cost: 3, buyers: [LEARNER_USER_ID] })], cursor: "x" }));
    const res = await get(s, `${GM}/shop/items`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("internal_cost");
    expect(res.body).not.toContain(LEARNER_USER_ID);
  });

  it("создание: Idempotency-Key обязателен (422 до домена) и передаётся; вход ShopItemCreate строго", async () => {
    const { s } = await loginAs(h, "content_manager");
    const nokey = await send(s, "POST", `${GM}/shop/items`, SHOP_ITEM);
    expect(nokey.statusCode).toBe(422);
    expect(nokey.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await send(s, "POST", `${GM}/shop/items`, SHOP_ITEM, { "idempotency-key": "bad key" })).json().code).toBe("IDEMPOTENCY_KEY_INVALID");
    for (const bad of [
      { ...SHOP_ITEM, kind: "streak_freeze" },
      { ...SHOP_ITEM, theme: { bg: "#ffffff", accent: "--pen" } },
      { ...SHOP_ITEM, theme: { bg: "--paper;color:red", accent: "--pen" } },
      { ...SHOP_ITEM, price_til: 0 },
      { ...SHOP_ITEM, price_til: 10_001 },
      { ...SHOP_ITEM, code: "BG" },
      { ...SHOP_ITEM, description: L("x".repeat(201), "x") },
      { ...SHOP_ITEM, available_until: "2026-12-31" },
      (({ order: _o, ...rest }) => rest)(SHOP_ITEM),
    ]) {
      expect((await send(s, "POST", `${GM}/shop/items`, bad, IK("bad"))).statusCode).toBe(422);
    }
    expect(gameCalls()).toHaveLength(0);
    const res = await send(s, "POST", `${GM}/shop/items`, SHOP_ITEM, IK("ok"));
    expect(res.statusCode).toBe(201);
    expect(gameCalls()[0]!.headers["idempotency-key"]).toBe("game-ok-0001");
    expect(gameCalls()[0]!.headers["x-step-up"]).toBeUndefined();
    expect((res.json() as AdminShopItem).status).toBe("draft");
  });

  it("правка, публикация, снятие: 409 домена и 410 — как есть", async () => {
    const { s } = await loginAs(h, "operations");
    const patched = await send(s, "PATCH", `${GM}/shop/items/bg_sunset`, { available_until: "2026-12-31T23:59:59+05:00", order: 3 });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as AdminShopItem).available_until).toBe("2026-12-31T23:59:59+05:00");
    await stepUp(h, s);
    h.fake.on("gamification", "PATCH", `${GI}/shop/items/bg_sunset`, () => domainError(409, "ITEM_PUBLISHED", { allowed: ["available_until", "order"] }));
    expect((await send(s, "PATCH", `${GM}/shop/items/bg_sunset`, { price_til: 1 })).json()).toMatchObject({ code: "ITEM_PUBLISHED", details: { allowed: ["available_until", "order"] } });
    expect(((await send(s, "POST", `${GM}/shop/items/bg_sunset/retire`, { comment: "Конец сезона" })).json() as AdminShopItem).status).toBe("retired");
  });
});

// ---------------------------------------------------------------- события недели

describe("события недели", () => {
  it("список: фильтр status передаётся; StaffRef: сотрудник — lookup, сид — «Сид», только staff_id — тоже имя", async () => {
    const { s } = await loginAs(h, "analyst");
    const res = await get(s, `${GM}/events?status=published`);
    expect(gameCalls()[0]!.query).toEqual({ status: "published" });
    const items = (res.json() as { items: AdminGameEvent[] }).items;
    expect(items[0]!.created_by).toEqual({ staff_id: GAME_STAFF_ID, name: "Гульнора Операции" });
    expect(items[1]!.published_by).toEqual({ staff_id: SEED_ACTOR_ID, name: SEED_NAME });
    // домен отдал только идентификаторы; «system»; неизвестный без имени
    const unknown = "d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a";
    h.fake.on("gamification", "GET", `${GI}/events`, () =>
      json(200, { items: [gameEventDomain({ created_by: GAME_STAFF_ID.toUpperCase(), published_by: "system" }), gameEventDomain({ created_by: { staff_id: unknown } })] }),
    );
    const again = (await get(s, `${GM}/events`)).json() as { items: AdminGameEvent[] };
    expect(again.items[0]!.created_by).toEqual({ staff_id: GAME_STAFF_ID, name: "Гульнора Операции" });
    expect(again.items[0]!.published_by).toEqual({ staff_id: "system", name: "Система" });
    expect(again.items[1]!.created_by).toEqual({ staff_id: unknown, name: "Сотрудник" });
  });

  it("lookup имён недоступен → имя из домена (actor-токен на момент действия); экран открывается", async () => {
    const { s } = await loginAs(h, "analyst");
    h.fake.on("adminIdentity", "GET", "/admin/v1/staff/lookup", () => domainError(404, "NOT_FOUND"));
    const items = ((await get(s, `${GM}/events`)).json() as { items: AdminGameEvent[] }).items;
    expect(items[0]!.created_by).toEqual({ staff_id: GAME_STAFF_ID, name: "Имя из токена" });
  });

  it("создание: Idempotency-Key обязателен; множители 1.5 | 2 | 3, 1..5 штук; аудитории не пустые; ответ — draft", async () => {
    const { s } = await loginAs(h, "content_manager", { display_name: "Камола Контент" });
    expect((await send(s, "POST", `${GM}/events`, EVENT)).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const many = Array.from({ length: 6 }, () => ({ action: "lesson", currency: "xp", factor: 2 }));
    for (const bad of [
      { ...EVENT, multipliers: [] },
      { ...EVENT, multipliers: many },
      { ...EVENT, multipliers: [{ action: "duel", currency: "xp", factor: 2 }] },
      { ...EVENT, multipliers: [{ action: "reading", currency: "freeze", factor: 2 }] },
      { ...EVENT, multipliers: [{ action: "reading", currency: "xp", factor: 10 }] },
      { ...EVENT, audiences: [] },
      { ...EVENT, starts_at: "завтра" },
      { ...EVENT, status: "published" },
    ]) {
      expect((await send(s, "POST", `${GM}/events`, bad, IK("ev"))).statusCode).toBe(422);
    }
    const res = await send(s, "POST", `${GM}/events`, { ...EVENT, multipliers: [{ action: "reading", currency: "til", factor: 1.5 }] }, IK("ev"));
    expect(res.statusCode).toBe(201);
    const ev = res.json() as AdminGameEvent;
    expect(ev.multipliers).toEqual([{ action: "reading", currency: "til", factor: 1.5 }]);
    expect(ev.created_by.name).toBe("Камола Контент");
  });

  it("публикация: 409 EVENT_OVERLAP {event_id}, 422 starts_at в прошлом — как есть; множитель 2.5 или чужой статус от домена → 503", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    h.fake.on("gamification", "POST", `${GI}/events/${GAME_EVENT_ID}/publish`, () => domainError(409, "EVENT_OVERLAP", { event_id: OP_ID }));
    expect((await send(s, "POST", `${GM}/events/${GAME_EVENT_ID}/publish`, { comment: "Запуск" })).json()).toMatchObject({ code: "EVENT_OVERLAP", details: { event_id: OP_ID } });
    h.fake.on("gamification", "POST", `${GI}/events/${GAME_EVENT_ID}/publish`, () => domainError(422, "EVENT_STARTS_IN_PAST"));
    expect((await send(s, "POST", `${GM}/events/${GAME_EVENT_ID}/publish`, { comment: "Запуск" })).statusCode).toBe(422);
    for (const bad of [gameEventDomain({ multipliers: [{ action: "reading", currency: "xp", factor: 2.5 }] }), gameEventDomain({ status: "running" })]) {
      h.fake.on("gamification", "GET", `${GI}/events`, () => json(200, { items: [bad] }));
      expect((await get(s, `${GM}/events`)).statusCode).toBe(503);
    }
    const cancelled = (await send(s, "POST", `${GM}/events/${GAME_EVENT_ID}/cancel`, { comment: "Перенос" })).json() as AdminGameEvent;
    expect(cancelled.status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------- кошельки

describe("кошельки учеников", () => {
  it("кошелёк: строго AdminWallet; лишнее (PII, служебное) отброшено; чужая аудитория, отрицательный баланс → 503", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("gamification", "GET", WI, () => json(200, walletDomain({ telegram_id: "777000123", account_id: OP_ID, settings: { auto_freeze: true, quests_hidden: false, celebrations: "quiet" } })));
    const res = await get(s, W);
    expect(res.statusCode).toBe(200);
    const w = res.json() as AdminWallet;
    expect(w).toMatchObject({ user_id: LEARNER_USER_ID, audience: "kids", til_balance: 45, hero: { code: "pet_0", stage: 2 } });
    expect(w.settings).toEqual({ auto_freeze: true, quests_hidden: false });
    expect(res.body).not.toContain("777000123");
    expect(res.body).not.toContain("account_id");
    for (const bad of [walletDomain({ audience: "toddlers" }), walletDomain({ til_balance: -5 }), walletDomain({ hero: { code: "pet_0", stage: 4 } }), walletDomain({ quests_today: [{ code: "duel_1", kind: "duel_win", target: 1, progress: 0, status: "active" }] })]) {
      h.fake.on("gamification", "GET", WI, () => json(200, bad));
      expect((await get(s, W)).statusCode).toBe(503);
    }
    h.fake.on("gamification", "GET", WI, () => domainError(404, "WALLET_NOT_FOUND"));
    expect((await get(s, W)).json().code).toBe("WALLET_NOT_FOUND");
  });

  it("реестр: currency, cursor и limit передаются (limit 1..100); все поля, включая actor и comment; неизвестная причина, сумма 0 → 503", async () => {
    const { s } = await loginAs(h, "auditor");
    const res = await get(s, `${W}/ledger?currency=til&cursor=c1&limit=50`);
    expect(gameCalls()[0]!.query).toEqual({ currency: "til", cursor: "c1", limit: "50" });
    expect((await get(s, `${W}/ledger?limit=101`)).statusCode).toBe(422);
    const page = res.json() as Page<AdminLedgerOperation>;
    expect(page.next_cursor).toBe("c2");
    expect(page.items[1]).toMatchObject({ reason: "manual", actor: `staff:${GAME_STAFF_ID}`, comment: "Компенсация за сбой урока", source: { kind: "staff" } });
    for (const bad of [ledgerOpDomain({ reason: "gift" }), ledgerOpDomain({ amount: 0 }), ledgerOpDomain({ currency: "gems" }), ledgerOpDomain({ actor: "admin" }), ledgerOpDomain({ local_date: "20.11.2026" })]) {
      h.fake.on("gamification", "GET", `${WI}/ledger`, () => json(200, { items: [bad], next_cursor: null }));
      expect((await get(s, `${W}/ledger`)).statusCode).toBe(503);
    }
  });

  it("ручная операция: wallet.adjust + step-up; Idempotency-Key обязателен; суммы по валюте до домена; 409 BALANCE_NEGATIVE — как есть; повтор — Idempotent-Replayed", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    expect((await send(s, "POST", `${W}/adjustments`, ADJUST)).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    for (const bad of [
      { ...ADJUST, amount: 0 },
      { ...ADJUST, amount: 10_001 },
      { ...ADJUST, currency: "freeze", amount: -10_001 },
      { ...ADJUST, currency: "xp", amount: 100_001 },
      { ...ADJUST, amount: 1.5 },
      { ...ADJUST, reason: "сбой" },
      { ...ADJUST, currency: "gems" },
      { ...ADJUST, reason_code: "manual" },
    ]) {
      expect((await send(s, "POST", `${W}/adjustments`, bad, IK("bad"))).statusCode, JSON.stringify(bad)).toBe(422);
    }
    expect(gameCalls()).toHaveLength(0);
    const xp = await send(s, "POST", `${W}/adjustments`, { ...ADJUST, currency: "xp", amount: -100_000 }, IK("xp"));
    expect(xp.statusCode).toBe(201);
    const op = xp.json() as AdminLedgerOperation;
    expect(op).toMatchObject({ currency: "xp", amount: -100_000, reason: "manual", rules_version: null, comment: ADJUST.reason });
    h.fake.on("gamification", "POST", `${WI}/adjustments`, () => domainError(409, "BALANCE_NEGATIVE", { balance: 10, amount: -50 }));
    expect((await send(s, "POST", `${W}/adjustments`, { ...ADJUST, amount: -50 }, IK("neg"))).json()).toMatchObject({ code: "BALANCE_NEGATIVE", details: { balance: 10 } });
    h.fake.on("gamification", "POST", `${WI}/adjustments`, () => json(201, ledgerOpDomain({ reason: "manual" }), { "idempotent-replayed": "true" }));
    const replay = await send(s, "POST", `${W}/adjustments`, ADJUST, IK("xp"));
    expect(replay.headers["idempotent-replayed"]).toBe("true");
  });

  it("обратная запись и возврат: причина ≥ 10; 409 ALREADY_REVERSED — как есть; возврат → {operations}", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const rev = await send(s, "POST", `${W}/ledger/${OP_ID}/reverse`, { reason: "Ошибочное начисление" });
    expect(rev.statusCode).toBe(200);
    expect(rev.json()).toMatchObject({ reason: "reversal", reversal_of: OP_ID, amount: -5 });
    h.fake.on("gamification", "POST", `${WI}/ledger/${OP_ID}/reverse`, () => domainError(409, "ALREADY_REVERSED", { reversed_by: OP_ID }));
    expect((await send(s, "POST", `${W}/ledger/${OP_ID}/reverse`, { reason: "Ошибочное начисление" })).json().code).toBe("ALREADY_REVERSED");
    const refund = await send(s, "POST", `${W}/purchases/${PURCHASE_ID}/refund`, { reason: "Покупка по ошибке ребёнка" });
    expect(refund.statusCode).toBe(200);
    const ops = (refund.json() as { operations: AdminLedgerOperation[] }).operations;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ reason: "reversal", currency: "til" });
    expect(h.fake.callsTo("gamification", "POST", `${WI}/purchases/${PURCHASE_ID}/refund`)[0]!.headers["x-step-up"]).toBe("ok");
  });
});

// ---------------------------------------------------------------- обзор

describe("обзор игры и блок главной", () => {
  it("GET game/overview (game.read): period по умолчанию 7d; строго GameOverview; чужая аудитория → 503", async () => {
    const { s } = await loginAs(h, "methodist");
    const res = await get(s, `${GM}/overview`);
    expect(res.statusCode).toBe(200);
    expect(gameCalls()[0]!.query).toEqual({ period: "7d" });
    const o = res.json() as GameOverview;
    expect(o).toMatchObject({ period: "7d", active_rules_version: 1, earned: { xp: 12_000, til: 3_000 }, freezes: { used: 12 } });
    expect(o.active_events).toHaveLength(2);
    h.fake.on("gamification", "GET", `${GI}/overview`, () => json(200, gameOverview({ by_audience: [{ audience: "seniors", earned_xp: 1, earned_til: 1, quests_completed: 1 }] })));
    expect((await get(s, `${GM}/overview`)).statusCode).toBe(503);
  });

  it("главная: блок game из overview → GameStats; today → 7d, 30d → 30d; активное событие — заканчивается раньше всех", async () => {
    const { s } = await loginAs(h, "read_only");
    const d = (await get(s, "/admin/v1/dashboard")).json() as Dashboard;
    expect(d.game).toEqual({
      available: true,
      data: {
        period: "7d",
        earned_xp: 12_000,
        earned_til: 3_000,
        freezes_used: 12,
        quests_completed: 210,
        active_event: { title: L("Неделя чтения", "O'qish haftaligi"), ends_at: "2026-11-25T00:00:00+05:00" },
      },
    });
    expect(h.fake.callsTo("gamification", "GET", `${GI}/overview`).at(-1)!.query).toEqual({ period: "7d" });
    const month = (await get(s, "/admin/v1/dashboard?period=30d")).json() as Dashboard;
    expect(month.game.data?.period).toBe("30d");
    expect(h.fake.callsTo("gamification", "GET", `${GI}/overview`).at(-1)!.query).toEqual({ period: "30d" });
    h.fake.on("gamification", "GET", `${GI}/overview`, () => json(200, gameOverview({ active_events: [] })));
    expect(((await get(s, "/admin/v1/dashboard?period=7d")).json() as Dashboard).game.data?.active_event).toBeNull();
  });

  it("главная: gamification ответил 403 (нет game.read), упал, медленный или прислал мусор → блок недоступен, остальные на месте, 200", async () => {
    const { s } = await loginAs(h, "read_only");
    const handlers = [
      () => domainError(403, "PERMISSION_DENIED", { permission: "game.read" }),
      () => domainError(500, "BOOM"),
      () => json(200, gameOverview({ earned: { xp: -1, til: 0 } })),
      () => new Promise<Response>((r) => setTimeout(() => r(json(200, gameOverview())), 1500)),
    ];
    for (const handler of handlers) {
      h.fake.on("gamification", "GET", `${GI}/overview`, handler);
      const res = await get(s, "/admin/v1/dashboard");
      expect(res.statusCode).toBe(200);
      const d = res.json() as Dashboard;
      expect(d.game).toEqual({ available: false, data: null, service: "gamification" });
      expect(d.memory.available).toBe(true);
      expect(d.learners.available).toBe(true);
    }
  });

  it("главная без GAMIFICATION_URL: блок game недоступен без вызова, остальные блоки на месте", async () => {
    await h.close();
    h = await makeHarness({ GAMIFICATION_URL: "" });
    const { s } = await loginAs(h, "super_admin");
    const res = await get(s, "/admin/v1/dashboard?period=30d");
    expect(res.statusCode).toBe(200);
    const d = res.json() as Dashboard;
    expect(d.game).toEqual({ available: false, data: null, service: "gamification" });
    for (const b of [d.learners, d.support, d.content, d.lessons, d.ai, d.memory]) expect(b.available).toBe(true);
    expect(gameCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- CSRF и логи

describe("CSRF и логи", () => {
  it("каждая команда игры без CSRF-токена или с чужим Origin → 403 CSRF_INVALID, gamification не вызывается", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const { "x-csrf-token": _drop, ...noToken } = browser(s);
    for (const [key, c] of Object.entries(CASES).filter(([, c]) => c.method !== "GET")) {
      for (const headers of [noToken, browser(s, { origin: "https://evil.example" })]) {
        const res = await h.app.inject({ method: c.method, url: c.url, headers: { ...headers, ...c.headers }, payload: (c.payload ?? {}) as object });
        expect(res.statusCode, key).toBe(403);
        expect(res.json().code, key).toBe("CSRF_INVALID");
      }
    }
    expect(gameCalls()).toHaveLength(0);
  });

  it("причины, комментарии и тексты ученика не попадают в логи", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    await send(s, "POST", `${W}/adjustments`, { ...ADJUST, reason: "Секретная причина ручного начисления" }, IK("log"));
    await send(s, "POST", `${GM}/rules/draft/activate`, { comment: "Секретный комментарий активации" });
    h.fake.on("gamification", "GET", WI, () => json(200, walletDomain({ audience: "dragons", note: "Секретная заметка" })));
    await get(s, W);
    expect(h.logs.text).toContain("request completed");
    for (const leak of ["Секретная причина", "Секретный комментарий", "Секретная заметка", "dragons"]) expect(h.logs.text).not.toContain(leak);
  });
});
