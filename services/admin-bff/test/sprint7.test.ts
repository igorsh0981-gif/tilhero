/**
 * Спринт 7 (docs/sprint7/INTERNAL_API.md §6): учёт и стоимость, раскрытие содержимого, бюджеты и kill switch агентов,
 * лимиты v2, конфиг агента, алерты, каталог цен, skills и Test Console, уровни доступа, карточка пользователя.
 * Матрица прав/step-up/happy path всех маршрутов — routes.test.ts; здесь — поведение.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminUserCard, AiBudgetOverview, AiRequestDetail, EvalRun } from "@tilhero/contracts/admin";
import { mergeOverview } from "../src/routes/ai.js";
import { periodQuery } from "../src/routes/aiCommon.js";
import { C, BadValue } from "../src/codec.js";
import {
  ALERT_ID,
  REQUEST_ID,
  RUN_ID7,
  USER_ID,
  accessLevelRow,
  aiAgentRow,
  aiRequestDetailRow,
  browser,
  closeRedis,
  domainError,
  fakeLimits,
  fakeSprint7,
  gwAgentsRow,
  json,
  limitsRow,
  loginAs,
  makeHarness,
  overviewRow,
  stepUp,
  type Harness,
  type Session,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  fakeLimits(h.fake);
  fakeSprint7(h.fake);
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

type M = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const call = (method: M, url: string, s: Session | null, payload?: unknown, headers?: Record<string, string>) =>
  h.app.inject({ method, url, headers: browser(s, headers), ...(payload !== undefined ? { payload: payload as object } : {}) });
const idem = (k: string) => ({ "idempotency-key": `test-${k}-0001` });

describe("бюджеты и лимиты", () => {
  it("обзор: ai-control + свежая пауза provider-gateway + лимиты v2 (5 значений); имя того, кто остановил", async () => {
    const { staff, s } = await loginAs(h, "operations");
    h.fake.on("providerGateway", "GET", "/internal/v1/providers/ai/agents", () =>
      json(200, gwAgentsRow({ paused: { concierge: { reason: "Расход вне плана", by: staff.staff_id, at: "2026-10-12T15:00:00Z" } } })),
    );
    const res = await call("GET", "/admin/v1/ai/budgets", s);
    expect(res.statusCode).toBe(200);
    const o = res.json() as AiBudgetOverview;
    expect(o.control).toBe("ok");
    expect(o.gateway).toBe("ok");
    const c = o.agents.find((a) => a.agent_id === "concierge")!;
    expect(c).toMatchObject({ state: "paused", paused: { reason: "Расход вне плана", by_name: staff.display_name }, month: { cost_usd: "12.400000" } });
    // сутки — из gateway: потрачено + зарезервировано (без float)
    expect(c.day).toEqual({ spent_usd: "0.910000", limit_usd: "1.00", pct: 91, source: "env" });
    expect(o.limits).toMatchObject({ concierge_daily_usd: "1.00", evaluation_daily_usd: "0.30", defaults: { concierge_daily_usd: "1.00" } });
    expect(c.alerts[0]).toMatchObject({ alert_id: ALERT_ID, threshold: 90 });
  });

  it("ai-control недоступен → обзор из provider-gateway (kill switch доступен); недоступны оба → 503", async () => {
    const { s } = await loginAs(h, "operations");
    h.fake.down.add("aiControl");
    const res = await call("GET", "/admin/v1/ai/budgets", s);
    expect(res.statusCode).toBe(200);
    const o = res.json() as AiBudgetOverview;
    expect(o.control).toBe("unavailable");
    expect(o.agents.map((a) => a.agent_id)).toEqual(["concierge", "evaluation", "discovery", "news"]);
    expect(o.agents[0]).toMatchObject({ month: null, degraded_mode: null, kind: "interactive", state: "normal" });
    h.fake.down.add("providerGateway");
    const both = await call("GET", "/admin/v1/ai/budgets", s);
    expect(both.statusCode).toBe(503);
    expect(both.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "ai-control" } });
  });

  it("mergeOverview: пауза провайдера останавливает всех; снятая пауза → состояние по суткам", () => {
    const ctl = { ...overviewRow(), agents: overviewRow().agents.map((a) => ({ ...a, state: "paused" as const })) } as never;
    const free = mergeOverview(ctl, gwAgentsRow() as never, null, "2026-10-12T15:00:00Z");
    expect(free.agents.map((a) => a.state)).toEqual(["normal", "normal", "normal", "normal"]);
    const stop = mergeOverview(ctl, gwAgentsRow({ provider: { reason: "Инцидент", by: "x", at: "2026-10-12T15:00:00Z" } }) as never, null, "t");
    expect(stop.agents.every((a) => a.state === "paused")).toBe(true);
  });

  it("kill switch агента: причина trim, 15 с без повторов, ответ — состояние gateway; аудит недоступен → AUDIT_UNAVAILABLE", async () => {
    const { staff, s } = await loginAs(h, "operations");
    await stepUp(h, s);
    const res = await call("PUT", "/admin/v1/ai/agents/concierge/pause", s, { paused: true, reason: "  Расход вне плана " });
    expect(res.statusCode).toBe(200);
    const sent = h.fake.callsTo("providerGateway", "PUT", "/internal/v1/providers/ai/agents/concierge/pause")[0]!;
    expect(sent.body).toEqual({ paused: true, reason: "Расход вне плана" });
    expect(sent.actor?.id).toBe(staff.staff_id);
    expect(res.json().agents[0].paused).toMatchObject({ by: staff.staff_id, by_name: staff.display_name });

    expect((await call("PUT", "/admin/v1/ai/agents/concierge/pause", s, { paused: true, reason: "  a " })).statusCode).toBe(422);
    expect((await call("PUT", "/admin/v1/ai/agents/Bad Agent/pause", s, { paused: true, reason: "abc" })).statusCode).toBe(422);

    let n = 0;
    h.fake.on("providerGateway", "PUT", "/internal/v1/providers/ai/provider/anthropic/pause", () => {
      n++;
      return domainError(503, "AUDIT_UNAVAILABLE");
    });
    const down = await call("PUT", "/admin/v1/ai/providers/anthropic/pause", s, { paused: true, reason: "Инцидент" });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: "AUDIT_UNAVAILABLE", details: { service: "audit" } });
    expect(n).toBe(1);
  });

  it("лимиты v2: /admin/v1/ai/limits = /discovery/limits; бюджеты агентов 0–50 до 2 знаков, необязательны", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    const base = { ai_daily_usd: "2", news_daily_usd: "0.4", pages_daily: 300, reason: "Сезон" };
    const old = await call("PUT", "/admin/v1/ai/limits", s, base);
    expect(old.statusCode).toBe(200);
    expect(h.fake.callsTo("providerGateway", "PUT")[0]!.body).not.toHaveProperty("concierge_daily_usd");
    const ok = await call("PUT", "/admin/v1/ai/limits", s, { ...base, concierge_daily_usd: "1.5", evaluation_daily_usd: "0" });
    expect(ok.json()).toMatchObject({ concierge_daily_usd: "1.50", evaluation_daily_usd: "0.00" });
    for (const bad of [{ concierge_daily_usd: "51" }, { evaluation_daily_usd: "0.301" }, { concierge_daily_usd: 1 }, { evaluation_daily_usd: "1e1" }]) {
      const r = await call("PUT", "/admin/v1/ai/limits", s, { ...base, ...bad });
      expect(r.statusCode, JSON.stringify(bad)).toBe(422);
    }
  });

  it("ревью 7 M4: gateway 6.1 без бюджетов агентов → 200, поля null (экран лимитов работает); испорченное поле → 503", async () => {
    const { s } = await loginAs(h, "operations");
    const L = "/internal/v1/providers/ai_web/limits";
    const old = (p: Record<string, unknown> = {}) => {
      const { concierge_daily_usd: _c, evaluation_daily_usd: _e, defaults: _d, ...rest } = limitsRow();
      return { ...rest, defaults: { ai_daily_usd: "1.00", news_daily_usd: "0.20", pages_daily: 300 }, ...p };
    };
    h.fake.on("providerGateway", "GET", L, () => json(200, old()));
    for (const url of ["/admin/v1/ai/limits", "/admin/v1/discovery/limits"]) {
      const r = await call("GET", url, s);
      expect(r.statusCode, url).toBe(200);
      expect(r.json()).toMatchObject({ ai_daily_usd: "1.00", concierge_daily_usd: null, evaluation_daily_usd: null, defaults: { concierge_daily_usd: null } });
    }
    const o = await call("GET", "/admin/v1/ai/budgets", s);
    expect(o.statusCode).toBe(200);
    expect((o.json() as AiBudgetOverview).limits).toMatchObject({ ai_daily_usd: "1.00", concierge_daily_usd: null });
    h.fake.on("providerGateway", "GET", L, () => json(200, old({ concierge_daily_usd: 1 })));
    const bad = await call("GET", "/admin/v1/ai/limits", s);
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("ревью 7 M3: warnings[] команд ai-control — как есть (только скаляры, испорченные отброшены); 409/422 — с details", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    h.fake.on("aiControl", "PATCH", "/internal/v1/agents/concierge", () =>
      json(200, {
        ...aiAgentRow({ monthly_cap_usd: "10.00" }),
        warnings: [
          { code: "MONTHLY_CAP_BELOW_SPENT", message: "Месячный лимит не выше уже потраченного", details: { spent_usd: "12.400000", monthly_cap_usd: "10.00", nested: { x: 1 } } },
          { code: "bad code", message: "x", details: {} },
          "junk",
        ],
      }),
    );
    const body = { monthly_cap_usd: "10", reason: "Экономим", expected_version: 4 };
    const res = await call("PATCH", "/admin/v1/ai/agents/concierge", s, body, idem("w1"));
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual([
      { code: "MONTHLY_CAP_BELOW_SPENT", message: "Месячный лимит не выше уже потраченного", details: { spent_usd: "12.400000", monthly_cap_usd: "10.00" } },
    ]);
    const skills = [{ skill_id: "concierge.answer", version: 3, status: "PUBLISHED", max_cost_usd: "0.050000" }];
    h.fake.on("aiControl", "PATCH", "/internal/v1/agents/concierge", () =>
      domainError(409, "AGENT_PER_REQUEST_BELOW_SKILL", { per_request_max_usd: "0.01", skills }),
    );
    const below = await call("PATCH", "/admin/v1/ai/agents/concierge", s, { per_request_max_usd: "0.01", reason: "Экономим", expected_version: 4 }, idem("w2"));
    expect(below.statusCode).toBe(409);
    expect(below.json()).toMatchObject({ code: "AGENT_PER_REQUEST_BELOW_SKILL", details: { skills } });
    h.fake.on("aiControl", "PATCH", "/internal/v1/agents/concierge", () =>
      domainError(422, "AGENT_MONTHLY_BELOW_DAILY", { monthly_cap_usd: "0.50", daily_limit_usd: "1.00" }),
    );
    const month = await call("PATCH", "/admin/v1/ai/agents/concierge", s, { monthly_cap_usd: "0.5", reason: "Экономим", expected_version: 4 }, idem("w3"));
    expect(month.json()).toMatchObject({ code: "AGENT_MONTHLY_BELOW_DAILY", details: { daily_limit_usd: "1.00" } });

    h.fake.on("aiControl", "PUT", "/internal/v1/access/levels/plus", () =>
      json(200, {
        ...accessLevelRow({ code: "plus", concierge_messages_per_day: 5, is_default: false }),
        warnings: [{ code: "LEVEL_BELOW_DEFAULT", message: "Меньше, чем у уровня по умолчанию", details: { level: "plus", concierge_messages_per_day: 5, default_level: "basic", default_messages_per_day: 10 } }],
      }),
    );
    const lv = await call("PUT", "/admin/v1/ai/access-levels/plus", s, { name_ru: "Расширенный", name_en: "Plus", concierge_messages_per_day: 5, reason: "Тест" }, idem("w4"));
    expect(lv.statusCode).toBe(200);
    expect(lv.json().warnings[0]).toMatchObject({ code: "LEVEL_BELOW_DEFAULT", details: { default_messages_per_day: 10 } });
  });

  it("конфиг агента: Idempotency-Key обязателен, деньги строкой; алерт: подтверждение с именем, неверная ссылка → 422", async () => {
    const { staff, s } = await loginAs(h, "operations");
    await stepUp(h, s);
    const body = { per_request_max_usd: "0.04", monthly_cap_usd: null, reason: "Дешевле", expected_version: 4 };
    expect((await call("PATCH", "/admin/v1/ai/agents/concierge", s, body)).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await call("PATCH", "/admin/v1/ai/agents/concierge", s, { ...body, per_request_max_usd: 0.04 }, idem("a"))).statusCode).toBe(422);
    expect((await call("PATCH", "/admin/v1/ai/agents/concierge", s, { reason: "Дешевле", expected_version: 4 }, idem("b"))).statusCode).toBe(422);
    const res = await call("PATCH", "/admin/v1/ai/agents/concierge", s, body, idem("c"));
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("aiControl", "PATCH")[0]!.headers["idempotency-key"]).toBe("test-c-0001");
    expect(res.json()).toMatchObject({ per_request_max_usd: "0.04", monthly_cap_usd: null, config_version: 5, updated_by_name: staff.display_name });

    const ack = await call("POST", `/admin/v1/ai/alerts/${ALERT_ID}:ack`, s);
    expect(ack.json()).toMatchObject({ acked_by: staff.staff_id, acked_by_name: staff.display_name });
    expect((await call("POST", `/admin/v1/ai/alerts/${ALERT_ID}:nope`, s)).statusCode).toBe(422);
    const viewer = await loginAs(h, "read_only");
    expect((await call("GET", "/admin/v1/ai/alerts", viewer.s)).statusCode).toBe(200);
    expect((await call("POST", `/admin/v1/ai/alerts/${ALERT_ID}:ack`, viewer.s)).json().code).toBe("PERMISSION_DENIED");
  });

  it("ai-control не подключён → 503 FEATURE_UNAVAILABLE с понятным текстом", async () => {
    const bare = await makeHarness({}, {}, (c) => {
      c.urls.aiControl = null;
      c.urls.aiConcierge = null;
    });
    try {
      const { s } = await loginAs(bare, "super_admin");
      for (const url of ["/admin/v1/ai/agents", "/admin/v1/usage/kpi", "/admin/v1/skills"]) {
        const res = await bare.app.inject({ url, headers: browser(s) });
        expect(res.statusCode, url).toBe(503);
        expect(res.json()).toMatchObject({ code: "FEATURE_UNAVAILABLE", details: { service: "ai-control" } });
        expect(res.json().message).toMatch(/ai-control/);
      }
    } finally {
      await bare.close();
    }
  });
});

describe("запросы и стоимость", () => {
  it("период: today/7d/30d → даты UTC; from/to — обе; журнал по умолчанию — 30 дней", async () => {
    const t = Date.parse("2026-10-12T15:00:00Z");
    expect(periodQuery(t, { period: "today" })).toEqual({ from: "2026-10-12", to: "2026-10-12" });
    expect(periodQuery(t, {})).toEqual({ from: "2026-10-06", to: "2026-10-12" });
    expect(periodQuery(t, { period: "30d" })).toEqual({ from: "2026-09-13", to: "2026-10-12" });
    expect(() => periodQuery(t, { from: "2026-10-01" })).toThrow();
    const { s } = await loginAs(h, "read_only");
    expect((await call("GET", "/admin/v1/usage/kpi?from=2026-10-10&to=2026-10-01", s)).statusCode).toBe(422);
    expect((await call("GET", "/admin/v1/usage/requests?status=SUCCESS&model=claude-haiku-4-5", s)).statusCode).toBe(200);
    const q = h.fake.callsTo("aiControl", "GET", "/internal/v1/usage/requests")[0]!.query;
    expect(q).toMatchObject({ status: "SUCCESS", model: "claude-haiku-4-5" });
    expect(Date.parse(q.to!) - Date.parse(q.from!)).toBe(29 * 86_400_000);
  });

  it("дашборд: блок AI из usage/kpi за период; ai-control не подключён — not_configured, дашборд открывается", async () => {
    const { s } = await loginAs(h, "read_only");
    const d = (await call("GET", "/admin/v1/dashboard?period=30d", s)).json();
    expect(d.ai).toMatchObject({ available: true, data: { kpi: { requests: 120, total_cost_usd: "1.244567", success_rate: 0.975, p95_ms: 9100 } } });
    const q = h.fake.callsTo("aiControl", "GET", "/internal/v1/usage/kpi").at(-1)!.query;
    // ревью 8: те же from/to, что у остальных блоков (скользящие 30 суток; «сегодня» — с 00:00 Ташкента)
    expect(Date.parse(q.to!) - Date.parse(q.from!)).toBe(30 * 86_400_000);
    const bare = await makeHarness({}, {}, (c) => (c.urls.aiControl = null));
    try {
      const x = await loginAs(bare, "read_only");
      const r = await bare.app.inject({ url: "/admin/v1/dashboard", headers: browser(x.s) });
      expect(r.statusCode).toBe(200);
      expect(r.json().ai).toMatchObject({ available: false, reason: "not_configured" });
    } finally {
      await bare.close();
    }
  });

  it("drill-down: версия каталога строкой → список; разбивка стоимости — строки; испорченные деньги → 503 {service}", async () => {
    const { s } = await loginAs(h, "read_only");
    const res = await call("GET", `/admin/v1/usage/requests/${REQUEST_ID}`, s);
    expect(res.statusCode).toBe(200);
    const d = res.json() as AiRequestDetail;
    expect(d.price_catalog_versions).toEqual(["2026-10-12"]);
    expect(d.calls[0]!.cost).toMatchObject({ llm_input_usd: "0.003200", cache_write_usd: "0.002625", status: "priced" });
    expect(d.content).toEqual({ available: true, requires: "ai.content.read" });
    expect(d.timeline[1]).toMatchObject({ type: "tool", name: "set_direct_only", started_ms: null });

    h.fake.on("aiControl", "GET", `/internal/v1/usage/requests/${REQUEST_ID}`, () => json(200, { ...aiRequestDetailRow(), cost_usd: 0.0092 }));
    const bad = await call("GET", `/admin/v1/usage/requests/${REQUEST_ID}`, s);
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "ai-control" } });
    expect(h.logs.text).toMatch(/"field":"\$\.cost_usd"/);
  });

  it("раскрытие: ai.content.read + step-up + причина; no-store; текст не попадает в логи; 503 аудита и 404 срока", async () => {
    const url = `/admin/v1/usage/requests/${REQUEST_ID}/content:reveal`;
    const support = await loginAs(h, "support");
    expect((await call("POST", url, support.s, { reason: "Жалоба" })).json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "ai.content.read" } });
    const { staff, s } = await loginAs(h, "super_admin");
    expect((await call("POST", url, s, { reason: "Жалоба" })).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    expect((await call("POST", url, s, { reason: " a " })).statusCode).toBe(422);
    const res = await call("POST", url, s, { reason: "  Жалоба TCK-3081 " });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const sent = h.fake.callsTo("aiConcierge", "POST")[0]!;
    expect(sent.body).toEqual({ reason: "Жалоба TCK-3081" });
    expect(sent.actor?.id).toBe(staff.staff_id);
    expect(res.json()).toMatchObject({ user_text: "Хочу только прямой рейс", tool_calls: [{ tool: "set_direct_only", args: '{"direct_only":true}' }] });
    expect(res.json().segments[0].sources[0]).toEqual({ ref: "O0", title: "Поставщик перелётов", domain: "flights.example", url: "https://flights.example/x" });
    expect(h.logs.text).not.toContain("Хочу только прямой рейс");

    h.fake.on("aiConcierge", "POST", `/internal/v1/admin/requests/${REQUEST_ID}/content:reveal`, () => domainError(503, "AUDIT_UNAVAILABLE"));
    expect((await call("POST", url, s, { reason: "Жалоба" })).json().code).toBe("AUDIT_UNAVAILABLE");
    h.fake.on("aiConcierge", "POST", `/internal/v1/admin/requests/${REQUEST_ID}/content:reveal`, () => domainError(404, "AI_CONTENT_EXPIRED"));
    const gone = await call("POST", url, s, { reason: "Жалоба" });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().code).toBe("AI_CONTENT_EXPIRED");
  });
});

describe("skills и Test Console", () => {
  it("ревью: запрос — skills.edit; одобрение — только skills.publish; отклонение — с комментарием", async () => {
    const url = "/admin/v1/skills/concierge.event/versions/2/review";
    const am = await loginAs(h, "agent_manager");
    expect((await call("POST", url, am.s, { action: "request" }, idem("r1"))).statusCode).toBe(200);
    const denied = await call("POST", url, am.s, { action: "approve" }, idem("r2"));
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "skills.publish" } });
    const sa = await loginAs(h, "super_admin");
    expect((await call("POST", url, sa.s, { action: "reject" }, idem("r3"))).statusCode).toBe(422);
    expect((await call("POST", url, sa.s, { action: "reject", comment: "Слишком длинно" }, idem("r4"))).json()).toMatchObject({ status: "DRAFT", review: { decision: "rejected" } });
    h.fake.on("aiControl", "POST", "/internal/v1/skills/concierge.event/versions/2/review", () => domainError(409, "SKILL_REVIEWER_IS_AUTHOR"));
    const four = await call("POST", url, sa.s, { action: "approve" }, idem("r5"));
    expect(four.statusCode).toBe(409);
    expect(four.json().code).toBe("SKILL_REVIEWER_IS_AUTHOR");
  });

  it("публикация и откат: step-up, причина; откат — новая активация; сравнение одной версии — 422", async () => {
    const { staff, s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const pub = await call("POST", "/admin/v1/skills/concierge.event/versions/2/publish", s, { reason: "Ревью пройдено" }, idem("p1"));
    expect(pub.json()).toMatchObject({ status: "PUBLISHED", activation: { kind: "publish", by: staff.staff_id, by_name: staff.display_name, previous_version: 1 } });
    expect((await call("POST", "/admin/v1/skills/concierge.event/versions/2/publish", s, { reason: "x", effective_from: "2020-01-01T00:00:00Z" }, idem("p2"))).statusCode).toBe(422);
    const rb = await call("POST", "/admin/v1/skills/concierge.event/rollback", s, { to_version: 1, reason: "Жалобы" }, idem("p3"));
    expect(rb.json()).toMatchObject({ to_version: 1, activation: { kind: "rollback", previous_version: 2, cancelled: false } });
    // домен до ревью 7 (без полей) → значения по умолчанию
    expect(rb.json()).toMatchObject({ cancelled_activations: [], message: null });
    // ревью 7: откат отменяет отложенную публикацию — BFF передаёт список и сообщение; editors версии — как есть
    const later = { activation_id: "b0b0b0b0-1111-4222-8333-000000000009", skill_id: "concierge.event", version: 3, kind: "publish", effective_from: "2099-01-01T00:00:00Z", by: staff.staff_id, reason: "Позже", previous_version: 2, created_at: "2026-10-12T00:00:00Z", cancelled: true };
    h.fake.on("aiControl", "POST", "/internal/v1/skills/concierge.event/rollback", (c) =>
      json(200, { skill_id: "concierge.event", from_version: 2, to_version: c.body.to_version, activation: { ...later, activation_id: "b0b0b0b0-1111-4222-8333-00000000000a", version: 1, kind: "rollback", effective_from: "2026-10-12T00:00:00Z", cancelled: false }, cancelled_activations: [later], message: "Отменены отложенные публикации: v3 с 2099-01-01 00:00 UTC" }),
    );
    const rb2 = await call("POST", "/admin/v1/skills/concierge.event/rollback", s, { to_version: 1, reason: "Жалобы" }, idem("p4"));
    expect(rb2.statusCode).toBe(200);
    expect(rb2.json()).toMatchObject({ cancelled_activations: [{ version: 3, cancelled: true, by_name: staff.display_name }], message: expect.stringContaining("v3") });
    expect((await call("GET", "/admin/v1/skills/concierge.event/compare?a=2&b=2", s)).statusCode).toBe(422);
    const cmp = await call("GET", "/admin/v1/skills/concierge.event/compare?a=1&b=2", s);
    expect(cmp.json().fields).toEqual([
      { field: "change_note", a: "Сид", b: "Короче ответы" },
      { field: "limits", a: '{"max_tokens":1500}', b: '{"max_tokens":1200}' },
    ]);
    expect(cmp.json().instruction_diff[1]).toEqual({ op: "delete", a: 2, b: null, text: "Отвечай подробно." });
  });

  it("опубликованная версия неизменяема (409 домена как есть); правка — Idempotency-Key обязателен", async () => {
    const { s } = await loginAs(h, "agent_manager");
    const url = "/admin/v1/skills/concierge.event/versions/2";
    expect((await call("PATCH", url, s, { change_note: "x", expected_version: 1 })).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await call("PATCH", url, s, { confidence: { min: 0.123 }, expected_version: 1 }, idem("e1"))).statusCode).toBe(422);
    h.fake.on("aiControl", "PATCH", "/internal/v1/skills/concierge.event/versions/2", () => domainError(409, "SKILL_VERSION_IMMUTABLE"));
    const res = await call("PATCH", url, s, { change_note: "x", expected_version: 1 }, idem("e2"));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("SKILL_VERSION_IMMUTABLE");
  });

  it("прогон Test Console: 202; результаты — сводка без текста ответа модели", async () => {
    const { staff, s } = await loginAs(h, "agent_manager");
    const run = await call("POST", "/admin/v1/skills/concierge.event/versions/2/test", s, { compare_version: 1 }, idem("t1"));
    expect(run.statusCode).toBe(202);
    expect(run.json()).toEqual({ run_id: RUN_ID7, status: "queued", cases: 9 });
    expect((await call("POST", "/admin/v1/skills/concierge.event/versions/2/test", s, { compare_version: 2 }, idem("t2"))).statusCode).toBe(422);
    h.fake.addStaff({ role: "agent_manager", staff_id: "11111111-2222-4333-8444-555555555555", display_name: "Рустам" });
    const res = await call("GET", `/admin/v1/evaluation/runs/${RUN_ID7}`, s);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("секрет-ответа-модели");
    const r = res.json() as EvalRun;
    expect(r.started_by_name).toBe("Рустам");
    expect(r.results[0]).toMatchObject({ side: "candidate", passed: true, tools: ["set_direct_only"], kinds: ["fact"], cost_usd: "0.0031", schema_valid: true, violations: [] });
    expect(r.comparison[0]).toMatchObject({ changed: ["tools"], cost_delta_usd: "-0.0009" });
    void staff;
  });
});

describe("уровни доступа и карточка пользователя", () => {
  it("карточка: уровень, использование за 30 дней, переписки — только метаданные (текст домена не проходит)", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("aiConcierge", "GET", "/internal/v1/admin/conversations", () =>
      json(200, { items: [{ conversation_id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a", mode: "home", event_id: null, turns_count: 2, created_at: "2026-10-12T13:00:00Z", last_activity_at: null, text: "секретный-текст", status: "open" }], next_cursor: null }),
    );
    const res = await call("GET", `/admin/v1/users/${USER_ID}`, s);
    expect(res.statusCode).toBe(200);
    const card = res.json() as AdminUserCard;
    expect(res.body).not.toContain("секретный-текст");
    expect(card.ai_conversations).toEqual([{ conversation_id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a", mode: "home", event_id: null, turns_count: 2, created_at: "2026-10-12T13:00:00Z", last_activity_at: null }]);
    expect(card.access_level).toMatchObject({ level: "basic", source: "default", limits: { concierge_messages_per_day: 10 } });
    expect(card.ai_usage_30d).toMatchObject({ requests: 7, cost_usd: "0.064000" });
    expect(h.fake.callsTo("aiControl", "GET", `/internal/v1/usage/users/${USER_ID}/summary`)[0]!.query).toEqual({ period: "30d" });
  });

  it("назначение уровня: users.access.manage (без step-up), причина, срок в будущем, Idempotency-Key; имя назначившего", async () => {
    const url = `/admin/v1/users/${USER_ID}/access-level`;
    const support = await loginAs(h, "support");
    expect((await call("GET", url, support.s)).statusCode).toBe(200);
    expect((await call("PUT", url, support.s, { level: "plus", reason: "Партнёр" }, idem("u0"))).json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "users.access.manage" } });
    const { staff, s } = await loginAs(h, "operations");
    expect((await call("PUT", url, s, { level: "plus", reason: "Партнёр" })).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await call("PUT", url, s, { level: "plus", reason: "Партнёр", expires_at: "2020-01-01T00:00:00Z" }, idem("u1"))).statusCode).toBe(422);
    expect((await call("PUT", url, s, { level: "Plus!", reason: "Партнёр" }, idem("u2"))).statusCode).toBe(422);
    const res = await call("PUT", url, s, { level: "plus", reason: " Партнёр ", expires_at: "2099-01-01T00:00:00Z" }, idem("u3"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ level: "plus", source: "manual", limits: { concierge_messages_per_day: 20 }, assigned_by_name: staff.display_name, reason: "Партнёр" });
    // причина — в теле, не в URL (ревью 7); в ai-control — query внутреннего вызова
    expect((await call("DELETE", `${url}?reason=${encodeURIComponent("Срок истёк")}`, s, undefined, idem("u4q"))).statusCode).toBe(422);
    const reset = await call("DELETE", url, s, { reason: " Срок истёк ", expected_version: 1 }, idem("u4"));
    expect(reset.json()).toMatchObject({ source: "default", version: 2 });
    expect(h.fake.callsTo("aiControl", "DELETE", `/internal/v1/access/users/${USER_ID}`).at(-1)!.body).toEqual({ reason: "Срок истёк", expected_version: 1 });
    h.fake.on("aiControl", "PUT", `/internal/v1/access/users/${USER_ID}`, () => domainError(410, "USER_DELETED"));
    expect((await call("PUT", url, s, { level: "plus", reason: "Партнёр" }, idem("u5"))).statusCode).toBe(410);
  });

  it("уровни: правка лимита — ops.kill_switch + step-up; 0..1000; удаление назначенного — 409 домена", async () => {
    const { s } = await loginAs(h, "operations");
    const body = { name_ru: "Расширенный", name_en: "Plus", concierge_messages_per_day: 25, reason: "Больше сообщений" };
    expect((await call("PUT", "/admin/v1/ai/access-levels/plus", s, body, idem("l0"))).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    expect((await call("PUT", "/admin/v1/ai/access-levels/plus", s, { ...body, concierge_messages_per_day: 1001 }, idem("l1"))).statusCode).toBe(422);
    expect((await call("PUT", "/admin/v1/ai/access-levels/plus", s, body, idem("l2"))).json()).toMatchObject({ code: "plus", concierge_messages_per_day: 25 });
    h.fake.on("aiControl", "DELETE", "/internal/v1/access/levels/plus", () => domainError(409, "ACCESS_LEVEL_IN_USE"));
    expect((await call("DELETE", "/admin/v1/ai/access-levels/plus?reason=abc", s, undefined, idem("l3q"))).statusCode).toBe(422);
    expect((await call("DELETE", "/admin/v1/ai/access-levels/plus", s, { reason: "abc" }, idem("l3"))).json().code).toBe("ACCESS_LEVEL_IN_USE");
    // причина уходит в ai-control телом DELETE, не в URL (ревью 7)
    const del = h.fake.callsTo("aiControl", "DELETE", "/internal/v1/access/levels/plus").at(-1)!;
    expect([del.body, del.query]).toEqual([{ reason: "abc" }, {}]);
  });

  it("каталог цен: активация env — 422; ссылка без :activate — 422", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    expect((await call("POST", "/admin/v1/ai/pricing/versions/env:activate", s, { reason: "abc" }, idem("c1"))).statusCode).toBe(422);
    expect((await call("POST", "/admin/v1/ai/pricing/versions/2026-10-12:go", s, { reason: "abc" }, idem("c2"))).statusCode).toBe(422);
    const res = await call("POST", "/admin/v1/ai/pricing/versions/2026-10-12:activate", s, { reason: "Сверено" }, idem("c3"));
    expect(res.json()).toMatchObject({ status: "active", items: [{ key: "claude-haiku-4-5", input_usd_per_mtok: "1.000000" }] });
  });
});

describe("codec", () => {
  it("деньги только строкой, время с зоной, ссылки https, пустой текст — ошибка; путь поля в ошибке", () => {
    expect(() => C.usd.parse(0.5, "$.x")).toThrow(BadValue);
    expect(C.usd.parse("0.500000", "$")).toBe("0.500000");
    expect(() => C.time.parse("2026-10-12 10:00", "$.t")).toThrow(/\$\.t/);
    expect(C.https.parse("http://x.example/a", "$")).toBeNull();
    expect(() => C.text(10).parse("   ", "$")).toThrow(BadValue);
    expect(C.multiline(50).parse("a\r\nb\u0007", "$")).toBe("a\nb ");
    const o = C.obj<{ a: string; b?: number }>({ a: C.text(5), b: C.int() }, "b");
    expect(o.parse({ a: "toolong!", extra: 1 }, "$")).toEqual({ a: "tool…" });
    expect(() => o.parse({ a: "x", b: "1" }, "$")).toThrow(/\$\.b/);
  });
});
