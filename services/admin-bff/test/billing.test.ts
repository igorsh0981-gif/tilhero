/**
 * Спринт 8 — «Деньги» через admin-bff (billing `/internal/v1/admin/billing/*`), вкладка «Тариф», финансовый обзор,
 * блок обзора `money`, контроль ИИ (деградация, стоимость занятий, лимит подписчика), фильтр учеников по тарифу:
 * каждый маршрут — happy path, 401, 403 без права, step-up (и `X-Step-Up: ok` в домен), 422 до домена, BILLING_URL не
 * задана и домен недоступен → 503; роли PLAN (support — заявка, finance — решение и возврат); Idempotency-Key обязателен
 * у возврата и заявки; строгие кодеки (две суммы, сумма не в валюте, канал не своего провайдера → 503; лишнее
 * отбрасывается); подсказки «четыре глаза» и «можно вернуть» считает admin-bff; целочисленная арифметика обзора.
 * Общие матрицы (все маршруты admin-bff) — routes.test.ts и security.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminBillingAccount, AdminOrderCard, Adjustment, AiDegradationView, Dashboard, FinanceOverview, Page } from "@tilhero/contracts/admin";
import type { AiUnitCosts } from "@tilhero/contracts/ai";
import { buildOverview, unitPeriodOf, type FinanceSources } from "../src/routes/finance.js";
import { DEFAULT_ROLE_MATRIX } from "../src/rbac.js";
import { divHalfUp, microToTiyin, starsToTiyin, tashkentRange, toSafe, usd6ToMicro, usdToMicro } from "../src/money.js";
import {
  ACCOUNT_ID,
  ADJUSTMENT_ID,
  AI_USAGE_SUMMARY,
  CHILD_ID,
  LEARNER_ID,
  MONEY_APPROVER_ID,
  MONEY_AUTHOR_ID,
  ORDER_ID,
  ORDER_ID_STARS,
  PERIOD_ID,
  RECON_ITEM_ID,
  REFUND_ID,
  adjustmentDomain,
  billingAccountDomain,
  billingPeriodDomain,
  billingSummaryDomain,
  browser,
  catalogPayload,
  catalogVersionDomain,
  childRow,
  closeRedis,
  degradationDomain,
  domainError,
  json,
  ledgerEntryDomain,
  starsOrderCardDomain,
  learnerCard,
  login,
  loginAs,
  makeHarness,
  orderCardDomain,
  orderRowDomain,
  refundDomain,
  stepUp,
  unitCostsDomain,
  type Harness,
  type Session,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  h.fake.addStaff({ role: "support", staff_id: MONEY_AUTHOR_ID, email: "dilnoza.support@tilhero.test", display_name: "Дилноза Поддержка" });
  h.fake.addStaff({ role: "finance", staff_id: MONEY_APPROVER_ID, email: "aziz.finance@tilhero.test", display_name: "Азиз Финансы" });
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const BB = "/admin/v1/billing";
const IB = "/internal/v1/admin/billing";
const IK = (k: string) => ({ "idempotency-key": `money-${k}-0001` });

interface Case {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  status: number;
  /** путь домена (billing, кроме отмеченных) */
  path: string;
  service?: "billing" | "aiGateway";
  /** недопустимый вход → 422 до домена */
  invalid: { url?: string; payload?: unknown; headers?: Record<string, string> };
}

/** Все маршруты раздела «Деньги» (billing) + вкладка «Тариф»: ключ — "<METHOD> <шаблон>" как в app.adminRoutes. */
const CASES: Record<string, Case> = {
  "GET /admin/v1/billing/catalog": { method: "GET", url: `${BB}/catalog`, status: 200, path: `${IB}/catalog`, invalid: { url: `${BB}/catalog?status=draft` } },
  "GET /admin/v1/billing/catalog/:version": { method: "GET", url: `${BB}/catalog/2`, status: 200, path: `${IB}/catalog/2`, invalid: { url: `${BB}/catalog/draft` } },
  "PUT /admin/v1/billing/catalog/draft": {
    method: "PUT",
    url: `${BB}/catalog/draft`,
    payload: { payload: catalogPayload(), comment: null },
    headers: { "if-match": "2026-11-20T10:00:00.000Z" },
    status: 200,
    path: `${IB}/catalog/draft`,
    invalid: { payload: { payload: [1], comment: null } },
  },
  "DELETE /admin/v1/billing/catalog/draft": { method: "DELETE", url: `${BB}/catalog/draft`, status: 204, path: `${IB}/catalog/draft`, invalid: { payload: { force: true } } },
  "POST /admin/v1/billing/catalog/draft/validate": { method: "POST", url: `${BB}/catalog/draft/validate`, status: 200, path: `${IB}/catalog/draft/validate`, invalid: { payload: { strict: true } } },
  "POST /admin/v1/billing/catalog/draft/activate": {
    method: "POST",
    url: `${BB}/catalog/draft/activate`,
    payload: { comment: "Цены в Stars с 01.12" },
    headers: IK("activate"),
    status: 200,
    path: `${IB}/catalog/draft/activate`,
    invalid: { payload: { comment: "коротко" } },
  },
  "POST /admin/v1/billing/catalog/:version/rollback": {
    method: "POST",
    url: `${BB}/catalog/1/rollback`,
    payload: { comment: "Возврат к ценам версии 1" },
    status: 200,
    path: `${IB}/catalog/1/rollback`,
    invalid: { url: `${BB}/catalog/0/rollback` },
  },
  "POST /admin/v1/billing/trials::grant-all": {
    method: "POST",
    url: `${BB}/trials:grant-all`,
    payload: { reason: "Включение пэйвола, решение В4" },
    status: 200,
    path: `${IB}/trials:grant-all`,
    invalid: { payload: { reason: "пэйвол" } },
  },
  "GET /admin/v1/billing/orders": {
    method: "GET",
    url: `${BB}/orders?channel=web&provider=payme&status=fulfilled&account_id=${ACCOUNT_ID.toUpperCase()}&from=2026-11-01&to=2026-11-30&limit=20`,
    status: 200,
    path: `${IB}/orders`,
    invalid: { url: `${BB}/orders?channel=bank` },
  },
  "GET /admin/v1/billing/orders/:orderId": { method: "GET", url: `${BB}/orders/${ORDER_ID}`, status: 200, path: `${IB}/orders/${ORDER_ID}`, invalid: { url: `${BB}/orders/1042` } },
  "POST /admin/v1/billing/orders/:orderId/refunds": {
    method: "POST",
    url: `${BB}/orders/${ORDER_ID}/refunds`,
    payload: { reason: "Оплатил дважды по ошибке" },
    headers: IK("refund"),
    status: 201,
    path: `${IB}/orders/${ORDER_ID}/refunds`,
    invalid: { payload: { reason: "Оплатил дважды по ошибке", amount_tiyin: 100 }, headers: IK("refund") },
  },
  "GET /admin/v1/billing/refunds": { method: "GET", url: `${BB}/refunds?status=awaiting_provider`, status: 200, path: `${IB}/refunds`, invalid: { url: `${BB}/refunds?status=done` } },
  "POST /admin/v1/billing/refunds/:refundId/fail": {
    method: "POST",
    url: `${BB}/refunds/${REFUND_ID}/fail`,
    payload: { note: "Payme отказал в отмене, закрываем" },
    status: 200,
    path: `${IB}/refunds/${REFUND_ID}/fail`,
    invalid: { payload: {} },
  },
  "GET /admin/v1/billing/accounts/:accountId": { method: "GET", url: `${BB}/accounts/${ACCOUNT_ID}`, status: 200, path: `${IB}/accounts/${ACCOUNT_ID}`, invalid: { url: `${BB}/accounts/me` } },
  "GET /admin/v1/billing/accounts/:accountId/ledger": {
    method: "GET",
    url: `${BB}/accounts/${ACCOUNT_ID}/ledger?limit=50`,
    status: 200,
    path: `${IB}/accounts/${ACCOUNT_ID}/ledger`,
    invalid: { url: `${BB}/accounts/${ACCOUNT_ID}/ledger?limit=500` },
  },
  "POST /admin/v1/billing/accounts/:accountId/adjustments": {
    method: "POST",
    url: `${BB}/accounts/${ACCOUNT_ID}/adjustments`,
    payload: { kind: "minutes", minutes: 30, period_id: PERIOD_ID, reason: "Сбой урока 21.11, компенсация" },
    headers: IK("adjust"),
    status: 202,
    path: `${IB}/accounts/${ACCOUNT_ID}/adjustments`,
    invalid: { payload: { kind: "minutes", minutes: 30, reason: "Сбой урока 21.11, компенсация" }, headers: IK("adjust") },
  },
  "GET /admin/v1/billing/adjustments": { method: "GET", url: `${BB}/adjustments?status=pending`, status: 200, path: `${IB}/adjustments`, invalid: { url: `${BB}/adjustments?status=new` } },
  "POST /admin/v1/billing/adjustments/:adjustmentId/approve": {
    method: "POST",
    url: `${BB}/adjustments/${ADJUSTMENT_ID}/approve`,
    payload: { note: "Сбой подтверждён" },
    status: 200,
    path: `${IB}/adjustments/${ADJUSTMENT_ID}/approve`,
    invalid: { payload: { note: "" } },
  },
  "POST /admin/v1/billing/adjustments/:adjustmentId/reject": {
    method: "POST",
    url: `${BB}/adjustments/${ADJUSTMENT_ID}/reject`,
    payload: { note: "Сбой не подтверждён логами" },
    status: 200,
    path: `${IB}/adjustments/${ADJUSTMENT_ID}/reject`,
    invalid: { payload: { note: "нет" } },
  },
  "POST /admin/v1/billing/adjustments/:adjustmentId/cancel": {
    method: "POST",
    url: `${BB}/adjustments/${ADJUSTMENT_ID}/cancel`,
    status: 200,
    path: `${IB}/adjustments/${ADJUSTMENT_ID}/cancel`,
    invalid: { payload: { reason: "передумал" } },
  },
  "GET /admin/v1/billing/reconciliation/items": {
    method: "GET",
    url: `${BB}/reconciliation/items?status=open&kind=stars_unmatched`,
    status: 200,
    path: `${IB}/reconciliation/items`,
    invalid: { url: `${BB}/reconciliation/items?kind=lost` },
  },
  "POST /admin/v1/billing/reconciliation/runs": { method: "POST", url: `${BB}/reconciliation/runs`, status: 202, path: `${IB}/reconciliation/runs`, invalid: { payload: { kind: "daily" } } },
  "POST /admin/v1/billing/reconciliation/items/:itemId/resolve": {
    method: "POST",
    url: `${BB}/reconciliation/items/${RECON_ITEM_ID}/resolve`,
    payload: { status: "resolved", note: "Click провёл позже, сверено" },
    status: 200,
    path: `${IB}/reconciliation/items/${RECON_ITEM_ID}/resolve`,
    invalid: { payload: { status: "open", note: "Click провёл позже, сверено" } },
  },
  "GET /admin/v1/billing/reports/summary": { method: "GET", url: `${BB}/reports/summary?period=month`, status: 200, path: `${IB}/reports/summary`, invalid: { url: `${BB}/reports/summary?period=year` } },
  "GET /admin/v1/billing/reports/daily": {
    method: "GET",
    url: `${BB}/reports/daily?from=2026-11-01&to=2026-11-21`,
    status: 200,
    path: `${IB}/reports/daily`,
    invalid: { url: `${BB}/reports/daily?from=2026-01-01&to=2026-11-21` },
  },
  "GET /admin/v1/billing/fx": { method: "GET", url: `${BB}/fx`, status: 200, path: `${IB}/fx`, invalid: { url: `${BB}/fx?all=1` } },
  "PUT /admin/v1/billing/fx": {
    method: "PUT",
    url: `${BB}/fx`,
    payload: { usd_in_tiyin: 1_290_000, valid_from: "2026-12-01", reason: "Курс ЦБ на 01.12" },
    status: 200,
    path: `${IB}/fx`,
    invalid: { payload: { usd_in_tiyin: 12_900.5, valid_from: "2026-12-01", reason: "Курс ЦБ на 01.12" } },
  },
  "GET /admin/v1/billing/star-rate": { method: "GET", url: `${BB}/star-rate`, status: 200, path: `${IB}/star-rate`, invalid: { url: `${BB}/star-rate?x=1` } },
  "PUT /admin/v1/billing/star-rate": {
    method: "PUT",
    url: `${BB}/star-rate`,
    payload: { star_in_tiyin: 17_500, valid_from: "2026-12-01", reason: "Оценка по выплате за ноябрь" },
    status: 200,
    path: `${IB}/star-rate`,
    invalid: { payload: { star_in_tiyin: 17_500, valid_from: "2026-02-30", reason: "Оценка по выплате за ноябрь" } },
  },
  "GET /admin/v1/billing/providers": { method: "GET", url: `${BB}/providers`, status: 200, path: `${IB}/providers`, invalid: { url: `${BB}/providers?secret=1` } },
  "GET /admin/v1/learners/:id/billing": {
    method: "GET",
    url: `/admin/v1/learners/${LEARNER_ID}/billing`,
    status: 200,
    path: `${IB}/accounts/${LEARNER_ID}`,
    invalid: { url: "/admin/v1/learners/not-a-uuid/billing" },
  },
};
const STEP_UP_KEYS = [
  "POST /admin/v1/billing/catalog/draft/activate",
  "POST /admin/v1/billing/catalog/:version/rollback",
  "POST /admin/v1/billing/trials::grant-all",
  "POST /admin/v1/billing/orders/:orderId/refunds",
  "POST /admin/v1/billing/refunds/:refundId/fail",
  "POST /admin/v1/billing/accounts/:accountId/adjustments",
  "POST /admin/v1/billing/adjustments/:adjustmentId/approve",
  "POST /admin/v1/billing/adjustments/:adjustmentId/reject",
];

const inject = (s: Session | null, c: { method: Case["method"]; url: string; payload?: unknown; headers?: Record<string, string> }) =>
  h.app.inject({ method: c.method, url: c.url, headers: { ...browser(s), ...c.headers }, ...(c.method === "GET" ? {} : { payload: (c.payload ?? {}) as object }) });
const get = (s: Session, url: string) => h.app.inject({ url, headers: browser(s) });
const send = (s: Session, method: Case["method"], url: string, payload?: unknown, headers: Record<string, string> = {}) => inject(s, { method, url, payload, headers });
const sectionRoutes = () => h.app.adminRoutes.filter((r) => r.url.startsWith(`${BB}/`) || r.url === "/admin/v1/learners/:id/billing");
const billingCalls = () => h.fake.callsTo("billing");

function denied(res: { statusCode: number; json(): { code: string; details: { permission?: string } } }, permission: string) {
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission } });
}
async function as(role: Parameters<typeof loginAs>[1], fresh = true, p: Parameters<typeof loginAs>[2] = {}) {
  const r = await loginAs(h, role, p);
  if (fresh) await stepUp(h, r.s);
  return r;
}

// ---------------------------------------------------------------- каждый маршрут

describe("маршруты «Деньги»: каждый", () => {
  it("таблица покрывает все 31 маршрут раздела; step-up — ровно список INTERNAL_API §12", () => {
    const have = sectionRoutes().map((r) => `${r.method} ${r.url}`).sort();
    expect(have).toEqual(Object.keys(CASES).sort());
    expect(have).toHaveLength(31);
    expect(sectionRoutes().filter((r) => r.stepUp).map((r) => `${r.method} ${r.url}`).sort()).toEqual([...STEP_UP_KEYS].sort());
  });

  it("happy path: статус, путь billing с actor; X-Step-Up: ok — ровно у команд со step-up; Idempotency-Key передаётся", async () => {
    const { staff, s } = await as("super_admin", true, { display_name: "Супер Админ" });
    for (const [key, c] of Object.entries(CASES)) {
      const before = billingCalls().length;
      const res = await inject(s, c);
      expect(res.statusCode, `${key}: ${res.body.slice(0, 300)}`).toBe(c.status);
      const calls = billingCalls().slice(before);
      expect(calls, key).toHaveLength(1);
      const call = calls[0]!;
      expect(`${call.method} ${call.path}`, key).toBe(`${c.method} ${c.path}`);
      expect(call.actor, key).toMatchObject({ id: staff.staff_id, role: "super_admin", name: "Супер Админ" });
      expect(call.headers["x-step-up"], key).toBe(STEP_UP_KEYS.includes(key) ? "ok" : undefined);
      if (c.headers?.["idempotency-key"]) expect(call.headers["idempotency-key"], key).toBe(c.headers["idempotency-key"]);
    }
    // фильтры заказов: account_id в нижнем регистре; даты — дни Ташкента, «по» включительно (billing: created_at < to)
    expect(h.fake.callsTo("billing", "GET", `${IB}/orders`)[0]!.query).toEqual({
      channel: "web", provider: "payme", status: "fulfilled", account_id: ACCOUNT_ID, from: "2026-11-01T00:00:00+05:00", to: "2026-12-01T00:00:00+05:00", limit: "20",
    });
  });

  it("401: без сессии и с чужой cookie — на каждом маршруте, домен не вызывается", async () => {
    for (const [key, c] of Object.entries(CASES)) {
      for (const s of [null, { id: "Z".repeat(43), csrf: "x" } as Session]) {
        const res = await inject(s, c);
        expect(res.statusCode, key).toBe(401);
      }
    }
    expect(billingCalls()).toHaveLength(0);
  });

  it("403: роли без прав billing (communications, qa_analyst, content_manager, methodist) — на каждом маршруте, кроме отчётов (dashboard.read)", async () => {
    let checked = 0;
    for (const role of ["communications", "qa_analyst", "content_manager", "methodist"] as const) {
      const { s } = await as(role);
      const own = new Set<string>(DEFAULT_ROLE_MATRIX[role]);
      for (const [key, c] of Object.entries(CASES)) {
        const route = sectionRoutes().find((r) => `${r.method} ${r.url}` === key)!;
        if (route.guard.split("|").some((x) => own.has(x))) {
          expect(route.guard, `${role} ${key}`).toBe("billing.read|dashboard.read");
          continue;
        }
        denied(await inject(s, c), route.guard);
        checked++;
      }
    }
    expect(checked).toBe(4 * 29);
    expect(billingCalls().filter((c) => !c.path.startsWith(`${IB}/reports/`))).toHaveLength(0);
  });

  it("step-up: без свежего TOTP → 403 STEP_UP_REQUIRED {permission}, домен не вызывается", async () => {
    const { s } = await as("super_admin", false);
    for (const key of STEP_UP_KEYS) {
      const res = await inject(s, CASES[key]!);
      expect(res.statusCode, key).toBe(403);
      expect(res.json().code, key).toBe("STEP_UP_REQUIRED");
    }
    expect(billingCalls()).toHaveLength(0);
  });

  it("422: недопустимый вход — на каждом маршруте до домена", async () => {
    const { s } = await as("super_admin");
    for (const [key, c] of Object.entries(CASES)) {
      const res = await inject(s, { method: c.method, url: c.invalid.url ?? c.url, payload: c.invalid.payload ?? c.payload, headers: c.invalid.headers ?? c.headers });
      expect(res.statusCode, `${key}: ${res.body.slice(0, 200)}`).toBe(422);
      expect(res.json().code, key).toBe("VALIDATION_ERROR");
    }
    expect(billingCalls()).toHaveLength(0);
  });

  it("BILLING_URL не задана → 503 {service: billing} на каждом маршруте (после права и step-up); вкладка «Тариф» не зовёт user-admin; остальное работает", async () => {
    await h.close();
    h = await makeHarness({ BILLING_URL: "" });
    expect(h.config.billingUrl).toBeNull();
    expect(h.logs.text).toContain("BILLING_URL is not set");
    const ro = (await loginAs(h, "content_manager")).s;
    denied(await get(ro, `${BB}/orders`), "billing.read");
    const { s } = await loginAs(h, "super_admin");
    expect((await inject(s, CASES["POST /admin/v1/billing/orders/:orderId/refunds"]!)).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    for (const [key, c] of Object.entries(CASES)) {
      const res = await inject(s, c);
      expect(res.statusCode, key).toBe(503);
      expect(res.json(), key).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "billing" } });
    }
    expect(h.fake.callsTo("userAdmin", "GET", `/admin/v1/learners/${LEARNER_ID}`)).toHaveLength(0);
    expect((await get(s, `/admin/v1/learners/${LEARNER_ID}`)).statusCode).toBe(200);
    // обзор: блок выручки null, остальное собирается; дашборд: money недоступен
    const fo = (await get(s, "/admin/v1/finance/overview?period=day")).json() as FinanceOverview;
    expect(fo.revenue).toBeNull();
    expect(fo.margin).toBeNull();
    expect(fo.ai).not.toBeNull();
    const d = (await get(s, "/admin/v1/dashboard")).json() as Dashboard;
    expect(d.money).toEqual({ available: false, data: null, service: "billing" });
  });

  it("billing недоступен (сеть) или 5xx → 503 {service: billing}; тело 5xx не уходит; 4xx billing — как есть", async () => {
    const { s } = await as("super_admin");
    h.fake.on("billing", "POST", `${IB}/orders/${ORDER_ID}/refunds`, () => domainError(409, "REFUND_NOT_ALLOWED", { reason: "tils_spent", til: 100, til_balance: 20 }));
    const r = await inject(s, CASES["POST /admin/v1/billing/orders/:orderId/refunds"]!);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: "REFUND_NOT_ALLOWED", details: { reason: "tils_spent", til: 100, til_balance: 20 } });
    h.fake.on("billing", "POST", `${IB}/adjustments/${ADJUSTMENT_ID}/approve`, () => domainError(409, "SELF_APPROVAL"));
    expect((await inject(s, CASES["POST /admin/v1/billing/adjustments/:adjustmentId/approve"]!)).json().code).toBe("SELF_APPROVAL");
    h.fake.on("billing", "GET", `${IB}/catalog`, () => domainError(500, "BOOM", { secret_key: "x" }));
    const boom = await get(s, `${BB}/catalog`);
    expect(boom.statusCode).toBe(503);
    expect(boom.body).not.toContain("BOOM");
    expect(boom.body).not.toContain("secret_key");
    h.fake.down.add("billing");
    for (const [key, c] of Object.entries(CASES)) {
      const res = await inject(s, c);
      expect(res.statusCode, key).toBe(503);
      expect(res.json(), key).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "billing" } });
    }
  });
});

// ---------------------------------------------------------------- права по ролям PLAN спринта 8

describe("роли PLAN спринта 8 и Idempotency-Key", () => {
  const adjust = CASES["POST /admin/v1/billing/accounts/:accountId/adjustments"]!;
  const approve = CASES["POST /admin/v1/billing/adjustments/:adjustmentId/approve"]!;
  const refund = CASES["POST /admin/v1/billing/orders/:orderId/refunds"]!;
  const activate = CASES["POST /admin/v1/billing/catalog/draft/activate"]!;

  it("support: подаёт заявку (subscriptions.override), но не подтверждает, не возвращает, не активирует каталог", async () => {
    const { s } = await as("support");
    expect((await inject(s, adjust)).statusCode).toBe(202);
    denied(await inject(s, approve), "billing.approve");
    denied(await inject(s, refund), "billing.refund");
    denied(await inject(s, activate), "billing.publish");
    expect((await get(s, `${BB}/orders`)).statusCode).toBe(200);
  });

  it("finance: подтверждает, возвращает, активирует каталог; заявку подать не может (нет subscriptions.override)", async () => {
    const { s } = await as("finance");
    expect((await inject(s, approve)).statusCode).toBe(200);
    expect((await inject(s, refund)).statusCode).toBe(201);
    expect((await inject(s, activate)).statusCode).toBe(200);
    denied(await inject(s, adjust), "subscriptions.override");
  });

  it("analyst и auditor — только чтение; read_only — только отчёты и финансовый обзор (dashboard.read)", async () => {
    for (const role of ["analyst", "auditor"] as const) {
      const { s } = await as(role);
      expect((await get(s, `${BB}/orders`)).statusCode, role).toBe(200);
      denied(await inject(s, refund), "billing.refund");
      denied(await send(s, "PUT", `${BB}/fx`, CASES["PUT /admin/v1/billing/fx"]!.payload), "billing.manage");
    }
    const { s } = await as("read_only");
    expect((await get(s, `${BB}/reports/summary`)).statusCode).toBe(200);
    expect((await get(s, `${BB}/reports/daily?from=2026-11-01&to=2026-11-02`)).statusCode).toBe(200);
    expect((await get(s, "/admin/v1/finance/overview")).statusCode).toBe(200);
    denied(await get(s, `${BB}/orders`), "billing.read");
  });

  it("Idempotency-Key обязателен у возврата и заявки (422 до домена), формат проверяется у всех команд", async () => {
    const { s } = await as("super_admin");
    for (const c of [refund, adjust]) {
      const res = await inject(s, { ...c, headers: {} });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
    const bad = await inject(s, { ...activate, headers: { "idempotency-key": "x y" } });
    expect(bad.json().code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(billingCalls()).toHaveLength(0);
    // активация без ключа — можно (передаётся, если прислан)
    expect((await inject(s, { ...activate, headers: {} })).statusCode).toBe(200);
    expect(billingCalls().at(-1)!.headers["idempotency-key"]).toBeUndefined();
  });

  it("повтор того же возврата — тот же ключ уходит в billing; Idempotent-Replayed передаётся клиенту", async () => {
    const { s } = await as("finance");
    h.fake.on("billing", "POST", `${IB}/orders/${ORDER_ID}/refunds`, () => json(201, refundDomain(), { "idempotent-replayed": "true" }));
    const a = await inject(s, refund);
    const b = await inject(s, refund);
    expect(a.headers["idempotent-replayed"]).toBe("true");
    const keys = h.fake.callsTo("billing", "POST", `${IB}/orders/${ORDER_ID}/refunds`).map((c) => c.headers["idempotency-key"]);
    expect(keys).toEqual(["money-refund-0001", "money-refund-0001"]);
    expect(b.statusCode).toBe(201);
  });

  it("заявка по виду: minutes без периода, grant_period с периодом, revoke_period с минутами, 0 минут, короткая причина → 422", async () => {
    const { s } = await as("support");
    const u = adjust.url;
    for (const body of [
      { kind: "minutes", minutes: 30, reason: "Сбой урока 21.11, компенсация" },
      { kind: "minutes", minutes: 0, period_id: PERIOD_ID, reason: "Сбой урока 21.11, компенсация" },
      { kind: "minutes", minutes: 30, days: 3, period_id: PERIOD_ID, reason: "Сбой урока 21.11, компенсация" },
      { kind: "grant_period", days: 30, minutes: 300, period_id: PERIOD_ID, reason: "Выдача по договорённости с партнёром" },
      { kind: "grant_period", days: 30, minutes: -5, reason: "Выдача по договорённости с партнёром" },
      { kind: "grant_period", days: 91, minutes: 300, reason: "Выдача по договорённости с партнёром" },
      { kind: "revoke_period", period_id: PERIOD_ID, minutes: 10, reason: "Отзыв по решению руководителя" },
      { kind: "minutes", minutes: 30, period_id: PERIOD_ID, reason: "мало" },
    ]) {
      const res = await send(s, "POST", u, body, IK(`a${Math.random().toString(36).slice(2, 8)}`));
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
    }
    expect(billingCalls()).toHaveLength(0);
    // допустимые формы
    for (const body of [
      { kind: "minutes", minutes: -20, period_id: PERIOD_ID.toUpperCase(), reason: "Ошибочное начисление, снимаем" },
      { kind: "grant_period", days: 30, minutes: 300, reason: "Выдача по договорённости с партнёром" },
      { kind: "revoke_period", period_id: PERIOD_ID, reason: "Отзыв по решению руководителя" },
    ]) {
      expect((await send(s, "POST", u, body, IK(`b${Math.random().toString(36).slice(2, 8)}`))).statusCode, JSON.stringify(body)).toBe(202);
    }
    expect(h.fake.callsTo("billing", "POST", `${IB}/accounts/${ACCOUNT_ID}/adjustments`)[0]!.body.period_id).toBe(PERIOD_ID);
  });
});

// ---------------------------------------------------------------- кодеки и подсказки

describe("строгие кодеки и подсказки admin-bff", () => {
  it("заказ со смешанными деньгами → 503: две суммы, сумма не в валюте, канал не своего провайдера, транзакция другого провайдера", async () => {
    const { s } = await as("finance");
    const bad = [
      orderCardDomain({ amount_stars: 250 }),
      orderCardDomain({ amount_tiyin: null }),
      orderCardDomain({ currency: "XTR" }),
      orderCardDomain({ channel: "miniapp" }),
      orderCardDomain({ amount_tiyin: 4_900_000.5 }),
      orderCardDomain({ transactions: [{ ...orderCardDomain().transactions[0], provider: "click" }] }),
      orderCardDomain({ transactions: [{ ...orderCardDomain().transactions[0], amount_stars: 1 }] }),
    ];
    for (const body of bad) {
      h.fake.on("billing", "GET", `${IB}/orders/${ORDER_ID}`, () => json(200, body));
      const res = await get(s, `${BB}/orders/${ORDER_ID}`);
      expect(res.statusCode, JSON.stringify(body).slice(0, 120)).toBe(503);
      expect(res.json().details.service).toBe("billing");
    }
    h.fake.on("billing", "GET", `${IB}/orders`, () => json(200, { items: [orderRowDomain({ provider: "telegram_stars" })], next_cursor: null }));
    expect((await get(s, `${BB}/orders`)).statusCode).toBe(503);
    expect(h.logs.text).toContain("domain response rejected by normalization");
  });

  it("карточка заказа: can_refund считает admin-bff по состоянию (домен прислал false); живой возврат — нельзя; лишние поля отброшены", async () => {
    const { s } = await as("finance");
    const ok = (await get(s, `${BB}/orders/${ORDER_ID}`)).json() as AdminOrderCard;
    expect(ok.can_refund).toBe(true);
    expect(ok.receipts[0]!.qr_code_url).toBe("https://ofd.soliq.uz/check?t=EP000000000001&r=1234");
    h.fake.on("billing", "GET", `${IB}/orders/${ORDER_ID}`, () =>
      json(200, { ...orderCardDomain({ refunds: [refundDomain()], can_refund: true }), payme_key: "k", internal_note: "x" }),
    );
    const live = await get(s, `${BB}/orders/${ORDER_ID}`);
    expect((live.json() as AdminOrderCard).can_refund).toBe(false);
    expect(live.body).not.toContain("payme_key");
    expect(live.body).not.toContain("internal_note");
    h.fake.on("billing", "GET", `${IB}/orders/${ORDER_ID}`, () => json(200, orderCardDomain({ status: "pending", paid_at: null, fulfilled_at: null, transactions: [] })));
    expect(((await get(s, `${BB}/orders/${ORDER_ID}`)).json() as AdminOrderCard).can_refund).toBe(false);
    // ссылка на чек не https — ссылки нет, ответ не ломается
    h.fake.on("billing", "GET", `${IB}/orders/${ORDER_ID}`, () => json(200, orderCardDomain({ receipts: [{ ...orderCardDomain().receipts[0], qr_code_url: "http://ofd.soliq.uz/x" }] })));
    expect(((await get(s, `${BB}/orders/${ORDER_ID}`)).json() as AdminOrderCard).receipts[0]!.qr_code_url).toBeNull();
    // Stars: подписка Stars и сумма в Stars
    const st = (await get(s, `${BB}/orders/${ORDER_ID_STARS}`)).json() as AdminOrderCard;
    expect(st).toMatchObject({ channel: "miniapp", provider: "telegram_stars", currency: "XTR", amount_tiyin: null, amount_stars: 250 });
    expect(st.stars_subscription?.status).toBe("active");
  });

  it("«четыре глаза»: автор не видит «Подтвердить» (can_decide=false, can_cancel=true), другой с billing.approve — видит; домен не решает подсказку", async () => {
    const supS = await login(h, h.fake.staff.get(MONEY_AUTHOR_ID)!, "198.51.100.71");
    const list = (await get(supS, `${BB}/adjustments`)).json() as Page<Adjustment>;
    // своя заявка: отозвать можно, подтвердить — нет (у support и права нет); чужая — ни то ни другое
    expect(list.items.map((a) => [a.requested_by.staff_id, a.can_decide, a.can_cancel])).toEqual([
      [MONEY_AUTHOR_ID, false, true],
      [MONEY_APPROVER_ID, false, false],
    ]);
    // имя автора — как сохранил billing (actor.name команды); пустое имя — из admin-identity
    expect(list.items[0]!.requested_by.name).toBe("Поддержка");
    h.fake.on("billing", "GET", `${IB}/adjustments`, () => json(200, { items: [adjustmentDomain({ requested_by: { staff_id: MONEY_AUTHOR_ID, name: "" } })], next_cursor: null }));
    expect(((await get(supS, `${BB}/adjustments`)).json() as Page<Adjustment>).items[0]!.requested_by.name).toBe("Дилноза Поддержка");
    h.fake.on("billing", "GET", `${IB}/adjustments`, () => json(200, { items: [adjustmentDomain({ requested_by: { staff_id: "system", name: "" } })], next_cursor: null }));
    expect(((await get(supS, `${BB}/adjustments`)).json() as Page<Adjustment>).items[0]!.requested_by.name).toBe("Система");
    h.fake.off("billing", "GET", `${IB}/adjustments`);
    const finS = await login(h, h.fake.staff.get(MONEY_APPROVER_ID)!, "198.51.100.72");
    const fl = (await get(finS, `${BB}/adjustments`)).json() as Page<Adjustment>;
    expect(fl.items.map((a) => [a.can_decide, a.can_cancel])).toEqual([
      [true, false],
      [false, true],
    ]);
    // после решения подсказок нет; автор = решающий в применённой заявке — испорченный ответ
    await stepUp(h, finS);
    const done = (await send(finS, "POST", `${BB}/adjustments/${ADJUSTMENT_ID}/approve`, {})).json() as Adjustment;
    expect(done).toMatchObject({ status: "applied", can_decide: false, can_cancel: false, decided_by: { staff_id: MONEY_APPROVER_ID, name: "Азиз Финансы" } });
    h.fake.on("billing", "POST", `${IB}/adjustments/${ADJUSTMENT_ID}/approve`, () => json(200, adjustmentDomain({ status: "applied", decided_by: MONEY_AUTHOR_ID, decided_at: "2026-11-22T09:00:00Z" })));
    expect((await send(finS, "POST", `${BB}/adjustments/${ADJUSTMENT_ID}/approve`, {})).statusCode).toBe(503);
  });

  it("реестр минут: имя billing остаётся, staff:<id> без имени — staff/lookup; каталог: активная строго, черновик как есть", async () => {
    const { s } = await as("finance");
    const page = (await get(s, `${BB}/accounts/${ACCOUNT_ID}/ledger`)).json() as Page<{ actor: string; actor_name: string | null; minutes: number }>;
    expect(page.items.map((e) => [e.actor, e.actor_name, e.minutes])).toEqual([
      [`staff:${MONEY_APPROVER_ID}`, "Азиз Финансы", 30],
      ["system", "Система", -3],
    ]);
    h.fake.on("billing", "GET", `${IB}/accounts/${ACCOUNT_ID}/ledger`, () => json(200, { items: [ledgerEntryDomain({ actor_name: "Азиз Ф." })], next_cursor: null }));
    const lookups = h.fake.callsTo("adminIdentity").length;
    expect(((await get(s, `${BB}/accounts/${ACCOUNT_ID}/ledger`)).json() as Page<{ actor_name: string }>).items[0]!.actor_name).toBe("Азиз Ф.");
    expect(h.fake.callsTo("adminIdentity").length).toBe(lookups);
    h.fake.off("billing", "GET", `${IB}/accounts/${ACCOUNT_ID}/ledger`);
    // активная версия с испорченным payload (дробная цена) → 503; черновик с тем же — как есть
    h.fake.on("billing", "GET", `${IB}/catalog/2`, () => json(200, catalogVersionDomain({ payload: catalogPayload({ products: [{ ...catalogPayload().products[0], price_tiyin: 49_000.5 }] }) })));
    expect((await get(s, `${BB}/catalog/2`)).statusCode).toBe(503);
    h.fake.on("billing", "GET", `${IB}/catalog/3`, () => json(200, catalogVersionDomain({ version: 3, status: "draft", payload: { products: "черновик ещё не проверен" } })));
    const draft = await get(s, `${BB}/catalog/3`);
    expect(draft.statusCode).toBe(200);
    expect(draft.json().payload).toEqual({ products: "черновик ещё не проверен" });
    // оферта не https в активной — испорченный ответ
    h.fake.on("billing", "GET", `${IB}/catalog/2`, () => json(200, catalogVersionDomain({ payload: catalogPayload({ offer: { version: "1.0", url: "http://x.example/offer" } }) })));
    expect((await get(s, `${BB}/catalog/2`)).statusCode).toBe(503);
  });

  it("провайдеры: только «включён / задан ключ»; ключи и тела из ответа billing не уходят", async () => {
    const { s } = await as("finance");
    h.fake.on("billing", "GET", `${IB}/providers`, () =>
      json(200, { items: [{ provider: "payme", enabled: true, configured: true, last_callback_at: null, last_error_code: null, key: "TEST-PAYME-KEY-123", secret_key: "s" }] }),
    );
    const res = await get(s, `${BB}/providers`);
    expect(res.json()).toEqual({ items: [{ provider: "payme", enabled: true, configured: true, last_callback_at: null, last_error_code: null }] });
    expect(res.body).not.toContain("TEST-PAYME-KEY");
  });

  it("отчёт по дням: from позже to, больше 92 дней, несуществующая дата → 422 до домена; заказы: from позже to → 422", async () => {
    const { s } = await as("finance");
    for (const q of ["from=2026-11-21&to=2026-11-01", "from=2026-01-01&to=2026-11-21", "from=2026-02-30&to=2026-03-01", "from=2026-11-01"]) {
      expect((await get(s, `${BB}/reports/daily?${q}`)).statusCode, q).toBe(422);
    }
    expect((await get(s, `${BB}/reports/daily?from=2026-08-22&to=2026-11-21`)).statusCode).toBe(200); // ровно 92 дня
    expect((await get(s, `${BB}/orders?from=2026-11-30&to=2026-11-01`)).statusCode).toBe(422);
    expect((await get(s, `${BB}/orders?from=2026-13-45`)).statusCode).toBe(422);
    expect(h.fake.callsTo("billing", "GET", `${IB}/orders`)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- вкладка «Тариф»

describe("формы ответов billing (services/billing api/admin.py, domain/admin_views.py)", () => {
  it("коды провайдеров отрицательные, снимок без названия, первый заказ подписки Stars не найден, пустой статус тилов — не испорченный ответ", async () => {
    const { s } = await as("finance");
    h.fake.on("billing", "GET", `${IB}/orders/${ORDER_ID}`, () =>
      json(200, orderCardDomain({
        product_title: {},
        provider_calls: [{ call_id: 7, provider: "payme", direction: "in", method: "PerformTransaction", result_code: "-31050", latency_ms: 12, created_at: "2026-11-21T08:00:00Z" }],
        refunds: [refundDomain({ status: "failed", failure_code: "-5017", tils_check: { til: 100, til_balance: 0, status: "" }, instruction: null })],
      })),
    );
    const card = (await get(s, `${BB}/orders/${ORDER_ID}`)).json() as AdminOrderCard;
    expect(card.product_title).toEqual({ ru: "", uz: "" });
    expect(card.provider_calls[0]!.result_code).toBe("-31050");
    expect(card.refunds[0]).toMatchObject({ failure_code: "-5017", tils_check: { status: "" } });
    h.fake.on("billing", "GET", `${IB}/orders/${ORDER_ID_STARS}`, () =>
      json(200, starsOrderCardDomain({ stars_subscription: { ...(starsOrderCardDomain().stars_subscription as unknown as Record<string, unknown>), first_order_no: 0 } })),
    );
    expect(((await get(s, `${BB}/orders/${ORDER_ID_STARS}`)).json() as AdminOrderCard).stars_subscription?.first_order_no).toBe(0);
    // название с одним языком — по-прежнему испорченный ответ
    h.fake.on("billing", "GET", `${IB}/orders/${ORDER_ID}`, () => json(200, orderCardDomain({ product_title: { ru: "Плюс" } })));
    expect((await get(s, `${BB}/orders/${ORDER_ID}`)).statusCode).toBe(503);
  });

  it("заявки: фильтр account_id (в нижнем регистре) — в billing; неизвестный аккаунт — status none, не 404", async () => {
    const { s } = await as("finance");
    expect((await get(s, `${BB}/adjustments?status=pending&account_id=${ACCOUNT_ID.toUpperCase()}`)).statusCode).toBe(200);
    expect(h.fake.callsTo("billing", "GET", `${IB}/adjustments`).at(-1)!.query).toMatchObject({ status: "pending", account_id: ACCOUNT_ID });
    expect((await get(s, `${BB}/adjustments?account_id=nope`)).statusCode).toBe(422);
    h.fake.on("billing", "GET", `${IB}/accounts/${ACCOUNT_ID}`, () =>
      json(200, billingAccountDomain({ status: "none", tier: "free", features: [], current_period: null, periods: [], holds: [], stars_subscription: null, pending_adjustments: 0 })),
    );
    expect(((await get(s, `${BB}/accounts/${ACCOUNT_ID}`)).json() as AdminBillingAccount).status).toBe("none");
  });
});

describe("карточка ученика → «Тариф»", () => {
  it("аккаунт — сам ученик; детский профиль — тариф опекуна; без опекуна — 404 ACCOUNT_NOT_FOUND; ученик не найден — 404 user-admin", async () => {
    const { s } = await as("support");
    const a = (await get(s, `/admin/v1/learners/${LEARNER_ID}/billing`)).json() as AdminBillingAccount;
    expect(a.account_id).toBe(LEARNER_ID);
    expect(h.fake.callsTo("billing", "GET", `${IB}/accounts/${LEARNER_ID}`)).toHaveLength(1);
    h.fake.on("userAdmin", "GET", `/admin/v1/learners/${CHILD_ID}`, () => json(200, { ...learnerCard(CHILD_ID), ...childRow() }));
    const child = (await get(s, `/admin/v1/learners/${CHILD_ID}/billing`)).json() as AdminBillingAccount;
    expect(child.account_id).toBe(childRow().guardian_user_id);
    h.fake.on("userAdmin", "GET", `/admin/v1/learners/${CHILD_ID}`, () => json(200, { ...learnerCard(CHILD_ID), ...childRow(), guardian_user_id: null }));
    const orphan = await get(s, `/admin/v1/learners/${CHILD_ID}/billing`);
    expect(orphan.statusCode).toBe(404);
    expect(orphan.json().code).toBe("ACCOUNT_NOT_FOUND");
    h.fake.on("userAdmin", "GET", `/admin/v1/learners/${CHILD_ID}`, () => domainError(404, "LEARNER_NOT_FOUND"));
    expect((await get(s, `/admin/v1/learners/${CHILD_ID}/billing`)).json().code).toBe("LEARNER_NOT_FOUND");
    // карточка ученика не зависит от billing
    h.fake.down.add("billing");
    expect((await get(s, `/admin/v1/learners/${LEARNER_ID}`)).statusCode).toBe(200);
    expect((await get(s, `/admin/v1/learners/${LEARNER_ID}/billing`)).json().details.service).toBe("billing");
  });

  it("баланс не бывает отрицательным: minutes_left < 0 → 503", async () => {
    const { s } = await as("support");
    h.fake.on("billing", "GET", `${IB}/accounts/${LEARNER_ID}`, () =>
      json(200, billingAccountDomain({ current_period: billingPeriodDomain({ balance: { granted: 300, spent: 310, removed: 0, held: 0, overage: 10, minutes_left: -10 } }) })),
    );
    expect((await get(s, `/admin/v1/learners/${LEARNER_ID}/billing`)).statusCode).toBe(503);
  });

  it("фильтр учеников по тарифу ?tier=free|paid уходит в user-admin; другое значение — 422", async () => {
    const { s } = await as("support");
    expect((await get(s, "/admin/v1/learners?tier=paid")).statusCode).toBe(200);
    expect(h.fake.callsTo("userAdmin", "GET", "/admin/v1/learners").at(-1)!.query).toEqual({ tier: "paid" });
    expect((await get(s, "/admin/v1/learners?tier=vip")).statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------- финансовый обзор: целочисленная арифметика

const SUMMARY = billingSummaryDomain() as unknown as FinanceSources["summary"] & object;
const USAGE = AI_USAGE_SUMMARY as unknown as NonNullable<FinanceSources["usage"]>;
const UNIT = unitCostsDomain() as unknown as AiUnitCosts;
/** 16.11.2026 00:00 UTC: прошло 15 дней ноября из 30. */
const MID_NOV = Date.UTC(2026, 10, 16);
const SOURCES: FinanceSources = { period: "month", now: MID_NOV, summary: SUMMARY, monthSummary: SUMMARY, usage: USAGE, monthUsage: USAGE, unit: UNIT, monthUnit: UNIT, level: "economy" };

describe("финансовый обзор: целые суммы (BigInt, half-up)", () => {
  it("money.ts: half-up от нуля, USD → микродоллары без float-ошибок, пересчёт курсами, безопасные целые", () => {
    expect([divHalfUp(5n, 2n), divHalfUp(7n, 2n), divHalfUp(1n, 3n), divHalfUp(2n, 3n), divHalfUp(-5n, 2n), divHalfUp(-1n, 3n)]).toEqual([3n, 4n, 0n, 1n, -3n, 0n]);
    expect(() => divHalfUp(1n, 0n)).toThrow(RangeError);
    expect(usdToMicro(0.1 + 0.2)).toBe(300_000n);
    expect(usdToMicro(3.25)).toBe(3_250_000n);
    expect(usdToMicro(0)).toBe(0n);
    expect(() => usdToMicro(-1)).toThrow(RangeError);
    expect(usd6ToMicro("0.012345")).toBe(12_345n);
    expect(usd6ToMicro("12")).toBe(12_000_000n);
    expect(() => usd6ToMicro("1e-3")).toThrow(RangeError);
    // $0.000001 при курсе 12 850 сум: 1 285 000 тийинов × 1 / 10⁶ = 1,285 → 1 тийин; $0.000002 → 2,57 → 3
    expect(microToTiyin(1n, 1_285_000)).toBe(1n);
    expect(microToTiyin(2n, 1_285_000)).toBe(3n);
    expect(starsToTiyin(750, 18_000)).toBe(13_500_000n);
    expect(() => toSafe(2n ** 60n)).toThrow(RangeError);
    // запасные границы периода — Ташкент (UTC+5)
    // as billing reports.bounds: [from, to), the week from Monday (22.11.2026 — Sunday, 23.11 — Monday)
    expect(tashkentRange("day", Date.UTC(2026, 10, 22, 20, 0))).toEqual({ from: "2026-11-22T19:00:00.000Z", to: "2026-11-23T19:00:00.000Z" });
    expect(tashkentRange("month", Date.UTC(2026, 10, 22, 10, 0))).toEqual({ from: "2026-10-31T19:00:00.000Z", to: "2026-11-30T19:00:00.000Z" });
    expect(tashkentRange("week", Date.UTC(2026, 10, 22, 10, 0))).toEqual({ from: "2026-11-15T19:00:00.000Z", to: "2026-11-22T19:00:00.000Z" });
    expect(tashkentRange("week", Date.UTC(2026, 10, 22, 20, 0)).from).toBe("2026-11-22T19:00:00.000Z");
    expect([unitPeriodOf("day"), unitPeriodOf("week"), unitPeriodOf("month")]).toEqual(["week", "week", "month"]);
  });

  it("каждое число обзора: выручка, оценка Stars, затраты ИИ в тийинах, стоимость минуты, прогноз, «нужный потолок», маржа", () => {
    const o = buildOverview(SOURCES);
    expect(o.revenue!.web.net_tiyin).toBe(9_800_000);
    // 750 Stars × 18 000 тийинов — оценка (billing прислал null, считает admin-bff)
    expect(o.revenue!.stars).toMatchObject({ net_stars: 750, est_net_tiyin: 13_500_000 });
    expect(o.ai).toEqual({
      spent_micro_usd: 3_250_000,
      // 3,25 USD × 12 850 сум = 41 762,50 сум
      spent_tiyin: 4_176_250,
      monthly_cap_micro_usd: 20_000_000,
      cap_used_pct: 16.3,
      // (1,5 + 0,6) USD / 1300 минут = 1615,38… → 1615 мкUSD; в тийинах: 2 100 000 × 1 285 000 / (1300 × 10⁶) = 2075,77 → 2076
      cost_per_minute_micro_usd: 1615,
      cost_per_minute_tiyin: 2076,
      // 3,25 USD за 15 из 30 дней → 6,5 USD
      forecast_month_micro_usd: 6_500_000,
      // 9000 минут × (0,03 × 100 + 0,04 × 30) / 1300 × 1,2 = 34 892 307,69 → 34 892 308 мкUSD
      needed_cap_micro_usd: 34_892_308,
      level: "economy",
    });
    // 9 800 000 + 13 500 000 − 4 176 250
    expect(o.margin).toEqual({ net_tiyin: 19_123_750, estimated: true });
    expect(o.fx).toEqual({ usd_in_tiyin: 1_285_000, valid_from: "2026-11-01" });
    expect(o.star_rate).toEqual({ star_in_tiyin: 18_000, valid_from: "2026-11-01" });
    expect([o.from, o.to, o.generated_at]).toEqual([SUMMARY.from, SUMMARY.to, new Date(MID_NOV).toISOString()]);
    for (const v of [o.ai!.spent_tiyin, o.ai!.cost_per_minute_tiyin, o.margin!.net_tiyin, o.revenue!.stars.est_net_tiyin]) expect(Number.isSafeInteger(v)).toBe(true);
  });

  it("без курса USD — затраты в тийинах и маржа null; Stars без курса Star — маржа null; Stars = 0 — маржа без пометки «оценка»", () => {
    const noFx = buildOverview({ ...SOURCES, summary: { ...SUMMARY, fx: null }, monthSummary: { ...SUMMARY, fx: null } });
    expect([noFx.ai!.spent_tiyin, noFx.ai!.cost_per_minute_tiyin, noFx.margin, noFx.ai!.spent_micro_usd]).toEqual([null, null, null, 3_250_000]);
    const noStarRate = buildOverview({ ...SOURCES, summary: { ...SUMMARY, star_rate: null }, monthSummary: { ...SUMMARY, star_rate: null } });
    expect(noStarRate.revenue!.stars.est_net_tiyin).toBeNull();
    expect(noStarRate.margin).toBeNull();
    const noStars = buildOverview({ ...SOURCES, summary: { ...SUMMARY, star_rate: null, stars: { ...SUMMARY.stars, revenue_stars: 0, net_stars: 0 } } });
    expect(noStars.margin).toEqual({ net_tiyin: 9_800_000 - 4_176_250, estimated: false });
    // нетто сайта отрицательное (возвраты больше выручки) — маржа отрицательная, целая
    const neg = buildOverview({ ...SOURCES, summary: { ...SUMMARY, web: { ...SUMMARY.web, net_tiyin: -4_900_000 } } });
    expect(neg.margin!.net_tiyin).toBe(-4_900_000 + 13_500_000 - 4_176_250);
  });

  it("первый час месяца — прогноза нет; минут нет — стоимости минуты и потолка нет; уровень неизвестен — по ai_enabled; переполнение — блок null", () => {
    const early = buildOverview({ ...SOURCES, now: Date.UTC(2026, 10, 1, 0, 30) });
    expect(early.ai!.forecast_month_micro_usd).toBeNull();
    const zero = (u: AiUnitCosts): AiUnitCosts => ({ ...u, by_kind: { lesson: { ...u.by_kind.lesson, billable_minutes: 0 }, scenario: { ...u.by_kind.scenario, billable_minutes: 0 }, pair: u.by_kind.pair } });
    const noMin = buildOverview({ ...SOURCES, unit: zero(UNIT), monthUnit: zero(UNIT) });
    expect([noMin.ai!.cost_per_minute_micro_usd, noMin.ai!.cost_per_minute_tiyin, noMin.ai!.needed_cap_micro_usd]).toEqual([null, null, null]);
    expect(buildOverview({ ...SOURCES, level: null }).ai!.level).toBe("normal");
    expect(buildOverview({ ...SOURCES, level: null, usage: { ...USAGE, ai_enabled: false } }).ai!.level).toBe("off");
    const huge = buildOverview({ ...SOURCES, summary: { ...SUMMARY, stars: { ...SUMMARY.stars, net_stars: 9_000_000_000_000 } } });
    expect(huge.revenue).toBeNull();
    expect(huge.margin).toBeNull();
    expect(huge.ai).not.toBeNull();
    // billing недоступен — границы периода считает admin-bff (Ташкент)
    const down = buildOverview({ ...SOURCES, period: "day", summary: null, monthSummary: null });
    expect([down.revenue, down.fx, down.margin]).toEqual([null, null, null]);
    expect(down.from).toBe(tashkentRange("day", MID_NOV).from);
  });

  it("маршрут: period=month — по одному вызову сводки, расхода и стоимости; day — ещё месяц для прогноза и потолка; источники недоступны — блоки null", async () => {
    const { s } = await as("finance");
    const m = (await get(s, "/admin/v1/finance/overview?period=month")).json() as FinanceOverview;
    expect(m.period).toBe("month");
    expect(m.margin?.estimated).toBe(true);
    expect(h.fake.callsTo("billing", "GET", `${IB}/reports/summary`).map((c) => c.query.period)).toEqual(["month"]);
    expect(h.fake.callsTo("aiGateway", "GET", "/admin/v1/ai/usage/summary").map((c) => c.query.period)).toEqual(["month"]);
    expect(h.fake.callsTo("aiGateway", "GET", "/admin/v1/ai/unit-costs").map((c) => c.query.period)).toEqual(["month"]);
    await get(s, "/admin/v1/finance/overview?period=day");
    expect(h.fake.callsTo("billing", "GET", `${IB}/reports/summary`).map((c) => c.query.period).slice(1).sort()).toEqual(["day", "month"]);
    expect(h.fake.callsTo("aiGateway", "GET", "/admin/v1/ai/unit-costs").map((c) => c.query.period).slice(1).sort()).toEqual(["month", "week"]);
    // ai-gateway без деградации (до миграции 0009): уровень — по ai_enabled; ai-gateway недоступен — ai и маржа null
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/degradation", () => domainError(404, "NOT_FOUND"));
    expect(((await get(s, "/admin/v1/finance/overview")).json() as FinanceOverview).ai!.level).toBe("normal");
    h.fake.down.add("aiGateway");
    const noAi = (await get(s, "/admin/v1/finance/overview")).json() as FinanceOverview;
    expect([noAi.ai, noAi.margin]).toEqual([null, null]);
    expect(noAi.revenue).not.toBeNull();
    // испорченная сводка billing — выручка null, ответ 200
    h.fake.down.delete("aiGateway");
    h.fake.on("billing", "GET", `${IB}/reports/summary`, () => json(200, billingSummaryDomain({ web: { ...billingSummaryDomain().web, revenue_tiyin: 1.5 } })));
    const badRev = await get(s, "/admin/v1/finance/overview");
    expect(badRev.statusCode).toBe(200);
    expect((badRev.json() as FinanceOverview).revenue).toBeNull();
    expect((await get(s, "/admin/v1/finance/overview?period=year")).statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------- блок обзора «Деньги»

describe("блок обзора «Деньги» (dashboard.money)", () => {
  it("сводка за сегодня: возвраты за день и открытая сверка — поля сводки billing (refunds_count, recon_open) + доля потолка ИИ", async () => {
    const { s } = await as("read_only", false);
    const d = (await get(s, "/admin/v1/dashboard?period=7d")).json() as Dashboard;
    expect(d.money).toEqual({
      available: true,
      data: { period: "today", web_revenue_tiyin: 14_700_000, stars_revenue_stars: 750, orders_paid: 6, refunds: 1, active_subscriptions: 41, trials_started: 7, recon_open: 2, ai_cap_used_pct: 16.3 },
    });
    expect(h.fake.callsTo("billing", "GET", `${IB}/reports/summary`)[0]!.query).toEqual({ period: "day" });
    // только сводка (доступна с dashboard.read): списки возвратов и сверки требуют billing.read — не вызываются
    expect(h.fake.callsTo("billing", "GET", `${IB}/refunds`)).toHaveLength(0);
    expect(h.fake.callsTo("billing", "GET", `${IB}/reconciliation/items`)).toHaveLength(0);
    // ai-gateway вызван один раз — на блок ai и долю потолка
    expect(h.fake.callsTo("aiGateway", "GET", "/admin/v1/ai/usage/summary")).toHaveLength(1);
  });

  it("ai-gateway недоступен — доля потолка null, блок доступен; сводка billing недоступна или испорчена — блок недоступен без нулей", async () => {
    const { s } = await as("finance", false);
    h.fake.down.add("aiGateway");
    const a = (await get(s, "/admin/v1/dashboard")).json() as Dashboard;
    expect(a.money.available).toBe(true);
    expect(a.money.data!.ai_cap_used_pct).toBeNull();
    h.fake.down.delete("aiGateway");
    h.fake.on("billing", "GET", `${IB}/reports/summary`, () => domainError(403, "PERMISSION_DENIED", { permission: "billing.read" }));
    expect(((await get(s, "/admin/v1/dashboard")).json() as Dashboard).money).toEqual({ available: false, data: null, service: "billing" });
    h.fake.on("billing", "GET", `${IB}/reports/summary`, () => json(200, billingSummaryDomain({ stars: { ...billingSummaryDomain().stars, net_stars: 0.5 } })));
    expect(((await get(s, "/admin/v1/dashboard")).json() as Dashboard).money.available).toBe(false);
    // старая сводка без recon_open — испорченный ответ, не ноль
    const { recon_open: _r, ...old } = billingSummaryDomain();
    h.fake.on("billing", "GET", `${IB}/reports/summary`, () => json(200, old));
    expect(((await get(s, "/admin/v1/dashboard")).json() as Dashboard).money.available).toBe(false);
    // остальные блоки на месте
    expect(((await get(s, "/admin/v1/dashboard")).json() as Dashboard).learners.available).toBe(true);
  });
});

// ---------------------------------------------------------------- контроль ИИ

describe("контроль ИИ: деградация, стоимость занятий, лимит подписчика", () => {
  const PUT = (body: Record<string, unknown>) => ({ method: "PUT" as const, url: "/admin/v1/ai/degradation", payload: body });
  const BODY = { mode: "manual", manual_level: "paid_only", economy_at_percent: 80, paid_only_at_percent: 90, reason: "Расход месяца 88 %, бережём ИИ" };

  it("GET: уровень, пороги и смены уровня с именем сотрудника; costs.read — иначе 403", async () => {
    const { s } = await as("finance", false);
    const d = (await get(s, "/admin/v1/ai/degradation")).json() as AiDegradationView;
    expect(d).toMatchObject({ mode: "auto", manual_level: null, level: "economy", month: "2026-11" });
    expect(d.events.map((e) => e.actor_name)).toEqual([null, "Азиз Финансы"]);
    denied(await get((await as("support", false)).s, "/admin/v1/ai/degradation"), "costs.read");
    // ручной режим без уровня от домена — испорченный ответ
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/degradation", () => json(200, degradationDomain({ mode: "manual", manual_level: null })));
    expect((await get(s, "/admin/v1/ai/degradation")).statusCode).toBe(503);
  });

  it("PUT: costs.manage + step-up, X-Step-Up в ai-gateway; ручной без уровня, авто с уровнем, экономия выше «только подписчики», короткая причина → 422", async () => {
    const fin = await as("finance");
    denied(await inject(fin.s, PUT(BODY)), "costs.manage");
    const { s } = await as("operations", false);
    expect((await inject(s, PUT(BODY))).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    for (const bad of [
      { ...BODY, manual_level: null },
      { ...BODY, mode: "auto" },
      { ...BODY, mode: "auto", manual_level: null, economy_at_percent: 95 },
      { ...BODY, reason: "мало" },
      { ...BODY, manual_level: "turbo" },
      { ...BODY, paid_only_at_percent: 101 },
    ]) {
      expect((await inject(s, PUT(bad))).statusCode, JSON.stringify(bad)).toBe(422);
    }
    expect(h.fake.callsTo("aiGateway", "PUT", "/admin/v1/ai/degradation")).toHaveLength(0);
    const ok = await inject(s, PUT(BODY));
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as AiDegradationView).level).toBe("paid_only");
    const call = h.fake.callsTo("aiGateway", "PUT", "/admin/v1/ai/degradation")[0]!;
    expect(call.headers["x-step-up"]).toBe("ok");
    expect(call.body).toEqual(BODY);
    expect((await inject(s, PUT({ ...BODY, mode: "auto", manual_level: null }))).statusCode).toBe(200);
  });

  it("стоимость занятий: costs.read | dashboard.read; строки USD с 6 знаками строго; ИИ-занятий больше занятий → 503", async () => {
    const { s } = await as("read_only", false);
    const u = (await get(s, "/admin/v1/ai/unit-costs?period=week")).json() as AiUnitCosts;
    expect(u.period).toBe("week");
    expect(u.by_kind.lesson.cost_per_billable_minute_usd).toBe("0.001500");
    expect((await get(s, "/admin/v1/ai/unit-costs?period=day")).statusCode).toBe(422);
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/unit-costs", () => json(200, unitCostsDomain({ by_kind: { ...unitCostsDomain().by_kind, pair: { ...unitCostsDomain().by_kind.lesson, cost_usd: 0.5 } } })));
    expect((await get(s, "/admin/v1/ai/unit-costs")).statusCode).toBe(503);
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/unit-costs", () => json(200, unitCostsDomain({ by_kind: { ...unitCostsDomain().by_kind, lesson: { ...unitCostsDomain().by_kind.lesson, ai_sessions: 500 } } })));
    expect((await get(s, "/admin/v1/ai/unit-costs")).statusCode).toBe(503);
  });

  it("бюджет: дневной лимит подписчика — от лимита ученика до потолка месяца (422 до домена); нет у ai-gateway — 0,30", async () => {
    const { s } = await as("operations");
    const base = { monthly_cap_usd: 20, learner_daily_cap_usd: 0.05, lesson_cap_usd: 0.03, speech_monthly_cap_usd: 5, room_cap_usd: 0.1, alert_percent: 80, reason: "Растёт число подписчиков" };
    for (const paid of [0.04, 25]) {
      const res = await send(s, "PUT", "/admin/v1/ai/budget", { ...base, paid_learner_daily_cap_usd: paid });
      expect(res.statusCode, String(paid)).toBe(422);
      expect(res.json().details.field).toBe("paid_learner_daily_cap_usd");
    }
    const ok = await send(s, "PUT", "/admin/v1/ai/budget", { ...base, paid_learner_daily_cap_usd: 0.5 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().paid_learner_daily_cap_usd).toBe(0.5);
    const call = h.fake.callsTo("aiGateway", "PUT", "/admin/v1/ai/budget")[0]!;
    expect(call.body.paid_learner_daily_cap_usd).toBe(0.5);
    expect(call.headers["x-step-up"]).toBe("ok");
    // без поля (admin-web до спринта 8) — ai-gateway оставляет прежний
    expect((await send(s, "PUT", "/admin/v1/ai/budget", base)).statusCode).toBe(200);
    expect((await get(s, "/admin/v1/ai/budget")).json().paid_learner_daily_cap_usd).toBe(0.3);
  });
});

describe("логи без денег учеников и текстов сотрудников", () => {
  it("причина возврата, идентификатор транзакции провайдера и заметки не попадают в лог", async () => {
    const { s } = await as("finance");
    await inject(s, CASES["POST /admin/v1/billing/orders/:orderId/refunds"]!);
    await get(s, `${BB}/orders/${ORDER_ID}`);
    await send(s, "POST", `${BB}/reconciliation/items/${RECON_ITEM_ID}/resolve`, { status: "ignored", note: "Дубль от провайдера, игнорируем" });
    expect(h.logs.text).not.toContain("Оплатил дважды");
    expect(h.logs.text).not.toContain("5d7f3a1b2c3d4e5f6a7b8c9d");
    expect(h.logs.text).not.toContain("Дубль от провайдера");
  });
});
