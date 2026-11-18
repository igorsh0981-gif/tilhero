/**
 * Спринт 9, пакет Q4 (docs/sprint9/INTERNAL_API.md §1.4, §2.4, §6, §10, §12): «Удаления» (identity-consent), «Лимиты»
 * (ops-monitor), новые оповещения и runbook_url, Idempotent-Replayed, заголовки безопасности API.
 * Матрица прав / step-up / happy path всех маршрутов — routes.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AlertFeed, DeletionDetail, DeletionPage, OpsAlert, RateLimitPolicy } from "@tilhero/contracts/admin";
import {
  DELETION_ID,
  OPERATOR_ID,
  OPS_ALERT_ID,
  USER_ID,
  browser,
  closeRedis,
  deletionDetail,
  domainError,
  fakeLimits,
  fakeSprint7,
  fakeSprint8,
  fakeSprint9,
  json,
  loginAs,
  makeHarness,
  opsAlertRow,
  opsSummaryRow,
  redis,
  stepUp,
  type Harness,
  type Session,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness({}, {});
  fakeLimits(h.fake);
  fakeSprint7(h.fake);
  fakeSprint8(h.fake);
  fakeSprint9(h.fake);
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

type M = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const call = (method: M, url: string, s: Session | null, payload?: unknown, headers?: Record<string, string>) =>
  h.app.inject({ method, url, headers: browser(s, headers), ...(payload !== undefined ? { payload: payload as object } : {}) });
const idem = (k: string) => ({ "idempotency-key": `test-${k}-0001` });
const replayed = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "idempotent-replayed": "true" } });
const RETRY = `/admin/v1/deletions/${DELETION_ID}:retry`;

describe("удаления профиля", () => {
  it("список и деталь — users.read; статус и курсор передаются; имя сотрудника в истории; PII нет", async () => {
    h.fake.addStaff({ role: "operations", staff_id: OPERATOR_ID, display_name: "Тимур" });
    const viewer = await loginAs(h, "support");
    const list = await call("GET", "/admin/v1/deletions?status=stuck&limit=20", viewer.s);
    expect(list.statusCode).toBe(200);
    const page = list.json() as DeletionPage;
    expect(page.items[0]).toMatchObject({ request_id: DELETION_ID, user_id: USER_ID, status: "STUCK", pending_domains: ["watch"], acked: 8, expected: 9 });
    expect(h.fake.callsTo("identity", "GET", "/admin/v1/deletions").at(-1)!.query).toMatchObject({ status: "stuck", limit: "20" });
    expect((await call("GET", "/admin/v1/deletions?status=gone", viewer.s)).statusCode).toBe(422);

    const d = (await call("GET", `/admin/v1/deletions/${DELETION_ID}`, viewer.s)).json() as DeletionDetail;
    expect(d.domains.map((x) => [x.domain, x.acked])).toEqual([["preferences", true], ["support", true], ["watch", false]]);
    expect(d.history.map((x) => x.by)).toEqual(["user", "system", OPERATOR_ID]);
    expect(d.history[0]!.by_name).toBeNull();
    expect(d.history[2]!.by_name).toBe("Тимур");
    expect(JSON.stringify(d)).not.toMatch(/telegram|username|display_name/i);
    expect((await call("GET", "/admin/v1/deletions/not-a-uuid", viewer.s)).statusCode).toBe(422);

    h.fake.on("identity", "GET", `/admin/v1/deletions/${DELETION_ID}`, () => domainError(404, "DELETION_NOT_FOUND"));
    expect((await call("GET", `/admin/v1/deletions/${DELETION_ID}`, viewer.s)).json()).toMatchObject({ code: "DELETION_NOT_FOUND" });
    // испорченный ответ (by — не user/system/UUID) → 503, а не «как есть»
    h.fake.on("identity", "GET", `/admin/v1/deletions/${DELETION_ID}`, () => json(200, deletionDetail({ history: [{ attempt: 1, sent_at: "2026-10-14T08:00:00Z", by: "<script>" }] })));
    expect((await call("GET", `/admin/v1/deletions/${DELETION_ID}`, viewer.s)).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "identity-consent" } });
  });

  it("повтор: ops.queues.manage, step-up, Idempotency-Key, причина; 409 / 503 как есть; повтор ключа → Idempotent-Replayed", async () => {
    const support = await loginAs(h, "support");
    expect((await call("POST", RETRY, support.s, { reason: "Поднят watch" }, idem("a"))).json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "ops.queues.manage" } });
    const { s } = await loginAs(h, "operations");
    expect((await call("POST", RETRY, s, { reason: "Поднят watch" }, idem("b"))).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    expect((await call("POST", RETRY, s, { reason: "Поднят watch" })).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await call("POST", RETRY, s, { reason: " a " }, idem("c"))).statusCode).toBe(422);
    // принудительного «закрыть» нет: другой суффикс — не маршрут повтора
    expect([404, 422]).toContain((await call("POST", `/admin/v1/deletions/${DELETION_ID}:close`, s, { reason: "Закрыть" }, idem("d"))).statusCode);
    expect(h.fake.callsTo("identity", "POST", `/admin/v1/deletions/${DELETION_ID}:retry`)).toHaveLength(0);

    const ok = await call("POST", RETRY, s, { reason: "  Поднят watch " }, idem("e"));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ attempts: 7 });
    expect(ok.headers["idempotent-replayed"]).toBeUndefined();
    const sent = h.fake.callsTo("identity", "POST", `/admin/v1/deletions/${DELETION_ID}:retry`).at(-1)!;
    expect(sent.body).toEqual({ reason: "Поднят watch" });
    expect(sent.headers["idempotency-key"]).toBe("test-e-0001");
    expect(sent.actor?.permissions).toContain("ops.queues.manage");

    h.fake.on("identity", "POST", `/admin/v1/deletions/${DELETION_ID}:retry`, () => replayed(200, deletionDetail({ attempts: 7 })));
    const again = await call("POST", RETRY, s, { reason: "Поднят watch" }, idem("e"));
    expect(again.headers["idempotent-replayed"]).toBe("true");

    h.fake.on("identity", "POST", `/admin/v1/deletions/${DELETION_ID}:retry`, () => domainError(409, "DELETION_RETRY_TOO_SOON", { retry_after: 240 }));
    expect((await call("POST", RETRY, s, { reason: "Ещё раз" }, idem("f"))).json()).toMatchObject({ code: "DELETION_RETRY_TOO_SOON", details: { retry_after: 240 } });
    h.fake.on("identity", "POST", `/admin/v1/deletions/${DELETION_ID}:retry`, () => domainError(409, "DELETION_NOT_OPEN", { status: "COMPLETED" }));
    expect((await call("POST", RETRY, s, { reason: "Ещё раз" }, idem("g"))).json()).toMatchObject({ code: "DELETION_NOT_OPEN" });
    h.fake.on("identity", "POST", `/admin/v1/deletions/${DELETION_ID}:retry`, () => domainError(503, "AUDIT_UNAVAILABLE", { service: "audit" }));
    const audit = await call("POST", RETRY, s, { reason: "Ещё раз" }, idem("h"));
    expect(audit.statusCode).toBe(503);
    expect(audit.json()).toMatchObject({ code: "AUDIT_UNAVAILABLE" });
  });
});

describe("лимиты запросов", () => {
  it("политики {items} с переопределением и именем сотрудника; история с диапазоном и топом субъектов", async () => {
    h.fake.addStaff({ role: "operations", staff_id: OPERATOR_ID, display_name: "Тимур" });
    const viewer = await loginAs(h, "read_only");
    const r = await call("GET", "/admin/v1/ops/ratelimits", viewer.s);
    expect(r.statusCode).toBe(200);
    const items = r.json().items as RateLimitPolicy[];
    expect(items.map((p) => p.policy)).toEqual(["tg.user", "adm.login_ip"]);
    expect(items[1]).toMatchObject({ source: "override", fail: "closed", default: { limit: 10 }, override: { limit: 20, by: OPERATOR_ID, reason: "Офис за одним NAT" } });
    expect(items[1]!.override!.by_name).toBe("Тимур");
    const hist = await call("GET", "/admin/v1/ops/ratelimits/tg.user/history?range=7d", viewer.s);
    expect(hist.json()).toMatchObject({ policy: "tg.user", range: "7d", step: "1h", top_subjects_15m: [{ subject: USER_ID, rejected: 9 }] });
    expect(h.fake.callsTo("opsMonitor", "GET", "/internal/v1/ratelimits/tg.user/history").at(-1)!.query).toMatchObject({ range: "7d" });
    expect((await call("GET", "/admin/v1/ops/ratelimits/TG USER/history", viewer.s)).statusCode).toBe(422);
    h.fake.on("opsMonitor", "GET", "/internal/v1/ratelimits/nope.x/history", () => domainError(404, "RATE_LIMIT_POLICY_NOT_FOUND"));
    expect((await call("GET", "/admin/v1/ops/ratelimits/nope.x/history", viewer.s)).json()).toMatchObject({ code: "RATE_LIMIT_POLICY_NOT_FOUND" });
  });

  it("переопределение и сброс: ops.kill_switch, step-up, ключ, причина; 422 TOO_STRICT и 503 Redis — как есть; срок в прошлом — без вызова", async () => {
    const viewer = await loginAs(h, "read_only");
    const body = { limit: 240, window_s: 60, reason: "Акция в Mini App" };
    expect((await call("PUT", "/admin/v1/ops/ratelimits/tg.user/override", viewer.s, body, idem("a"))).json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "ops.kill_switch" } });
    const { s } = await loginAs(h, "operations");
    expect((await call("PUT", "/admin/v1/ops/ratelimits/tg.user/override", s, body, idem("b"))).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    expect((await call("PUT", "/admin/v1/ops/ratelimits/tg.user/override", s, body)).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await call("PUT", "/admin/v1/ops/ratelimits/tg.user/override", s, { ...body, limit: 0 }, idem("c"))).statusCode).toBe(422);
    expect((await call("PUT", "/admin/v1/ops/ratelimits/tg.user/override", s, { ...body, extra: 1 }, idem("d"))).statusCode).toBe(422);
    expect((await call("PUT", "/admin/v1/ops/ratelimits/tg.user/override", s, { ...body, expires_at: "2020-01-01T00:00:00Z" }, idem("e"))).json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.fake.callsTo("opsMonitor", "PUT", "/internal/v1/ratelimits/tg.user/override")).toHaveLength(0);

    const ok = await call("PUT", "/admin/v1/ops/ratelimits/tg.user/override", s, { ...body, burst: 300, expires_at: "2099-01-01T00:00:00Z", reason: "  Акция в Mini App " }, idem("f"));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ policy: "tg.user", source: "override", limit: 240 });
    const sent = h.fake.callsTo("opsMonitor", "PUT", "/internal/v1/ratelimits/tg.user/override").at(-1)!;
    expect(sent.body).toEqual({ limit: 240, window_s: 60, burst: 300, expires_at: "2099-01-01T00:00:00Z", reason: "Акция в Mini App" });
    expect(sent.headers["idempotency-key"]).toBe("test-f-0001");

    h.fake.on("opsMonitor", "PUT", "/internal/v1/ratelimits/tg.user/override", () => domainError(422, "RATE_LIMIT_TOO_STRICT", { policy: "tg.user", min_per_minute: 1 }));
    expect((await call("PUT", "/admin/v1/ops/ratelimits/tg.user/override", s, body, idem("g"))).json()).toMatchObject({ code: "RATE_LIMIT_TOO_STRICT", details: { min_per_minute: 1 } });
    // ревью спринта 9: ослабление политики fail: closed больше ×10 или без срока ≤ 24 ч — 422 как есть
    h.fake.on("opsMonitor", "PUT", "/internal/v1/ratelimits/tg.user/override", () => domainError(422, "RATE_LIMIT_TOO_LOOSE", { policy: "adm.login_ip", reason: "expires_required", max_hours: 24 }));
    const loose = await call("PUT", "/admin/v1/ops/ratelimits/tg.user/override", s, body, idem("gl"));
    expect(loose.statusCode).toBe(422);
    expect(loose.json()).toMatchObject({ code: "RATE_LIMIT_TOO_LOOSE", details: { reason: "expires_required", max_hours: 24 } });
    h.fake.on("opsMonitor", "PUT", "/internal/v1/ratelimits/tg.user/override", () => domainError(503, "RATE_LIMIT_UNAVAILABLE", { service: "redis" }));
    expect((await call("PUT", "/admin/v1/ops/ratelimits/tg.user/override", s, body, idem("h"))).json()).toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE", details: { service: "redis" } });
    h.fake.on("opsMonitor", "PUT", "/internal/v1/ratelimits/tg.user/override", () => domainError(503, "AUDIT_UNAVAILABLE", { service: "audit" }));
    expect((await call("PUT", "/admin/v1/ops/ratelimits/tg.user/override", s, body, idem("i"))).json()).toMatchObject({ code: "AUDIT_UNAVAILABLE" });

    // сброс: причина в теле, тот же ключ → Idempotent-Replayed
    expect((await call("DELETE", "/admin/v1/ops/ratelimits/tg.user/override", s, {}, idem("j"))).statusCode).toBe(422);
    h.fake.on("opsMonitor", "DELETE", "/internal/v1/ratelimits/tg.user/override", () => replayed(200, { policy: "tg.user", service: "telegram-bff", subject: "user", limit: 120, window_s: 60, burst: 120, fail: "open", env: null, default: { limit: 120, window_s: 60, burst: 120 }, source: "default", override: null, last_15m: { allowed: 1, rejected: 0, failopen: 0, failclosed: 0 } }));
    const reset = await call("DELETE", "/admin/v1/ops/ratelimits/tg.user/override", s, { reason: "Акция закончилась" }, idem("k"));
    expect(reset.statusCode).toBe(200);
    expect(reset.headers["idempotent-replayed"]).toBe("true");
    expect(h.fake.callsTo("opsMonitor", "DELETE", "/internal/v1/ratelimits/tg.user/override").at(-1)!.body).toEqual({ reason: "Акция закончилась" });
  });
});

describe("оповещения спринта 9 и runbook", () => {
  it("новые виды и субъекты проходят; runbook_url — только https ≤ 300; в колокольчике тоже", async () => {
    h.fake.on("opsMonitor", "GET", "/internal/v1/alerts", () =>
      json(200, {
        items: [
          opsAlertRow({ kind: "service_down", subject_type: "service", subject: "news", severity: "critical", params: { down_s: 240 }, runbook_url: "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/news.md#service-down" }),
          opsAlertRow({ alert_id: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a61", kind: "deletion_stuck", subject_type: "deletion", subject: "all", params: { stuck: 2, open: 3, oldest_open_at: "2026-10-14T08:00:00Z", pending_by_domain: { watch: 2, "Bad Domain": 1 } }, runbook_url: "javascript:alert(1)" }),
          opsAlertRow({ alert_id: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a62", kind: "rate_limit_spike", subject_type: "ratelimit", subject: "tg.user", params: { policy: "tg.user", rejected: 120, share: 0.2, subjects: 7 }, runbook_url: "http://example.com/x" }),
          opsAlertRow({ alert_id: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a63", kind: "rate_limit_unavailable", subject_type: "ratelimit", subject: "redis", severity: "critical", params: { policies: 6 } }),
        ],
        next_cursor: null,
      }),
    );
    const viewer = await loginAs(h, "read_only");
    const list = (await call("GET", "/admin/v1/ops/alerts?state=open", viewer.s)).json().items as OpsAlert[];
    expect(list.map((a) => a.kind)).toEqual(["service_down", "deletion_stuck", "rate_limit_spike", "rate_limit_unavailable"]);
    expect(list[0]!.runbook_url).toBe("https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/news.md#service-down");
    expect(list[1]!.runbook_url).toBeNull();
    expect(list[1]!.params).toMatchObject({ stuck: 2, pending_by_domain: { watch: 2 } });
    expect(list[1]!.params.pending_by_domain).not.toHaveProperty("Bad Domain");
    expect(list[2]!.runbook_url).toBeNull();
    expect(list[2]!.params).toMatchObject({ policy: "tg.user", rejected: 120, share: 0.2, subjects: 7 });
    expect(list[3]!.runbook_url).toBeNull(); // старый ops-monitor без поля
    const feed = (await call("GET", "/admin/v1/alerts?state=open", viewer.s)).json() as AlertFeed;
    const down = feed.items.find((x) => x.kind === "service_down")!;
    expect(down).toMatchObject({ source: "ops", severity: "critical", runbook_url: list[0]!.runbook_url });
    expect(feed.items.filter((x) => x.source === "ai").every((x) => x.runbook_url === null)).toBe(true);
  });

  it("ревью спринта 9: неизвестный kind / subject_type — отбрасывается поштучно (не 503 списка); Runbook — только внутри раздела", async () => {
    const base = "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/";
    h.fake.on("opsMonitor", "GET", "/internal/v1/alerts", () =>
      json(200, {
        items: [
          opsAlertRow({ kind: "service_down", subject_type: "service", subject: "nats", severity: "critical", runbook_url: `${base}nats.md#nats-down` }),
          opsAlertRow({ alert_id: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a71", kind: "future_kind", subject_type: "service", subject: "news" }),
          opsAlertRow({ alert_id: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a72", kind: "service_down", subject_type: "future_subject", subject: "x" }),
          opsAlertRow({ alert_id: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a73", kind: "service_down", subject_type: "service", subject: "news", runbook_url: `${base}../../../../evil/phish.md` }),
          opsAlertRow({ alert_id: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a74", kind: "service_down", subject_type: "service", subject: "audit", runbook_url: "https://github.com/someone/else/blob/main/docs/runbooks/audit.md" }),
          opsAlertRow({ alert_id: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a75", kind: "service_down", subject_type: "service", subject: "watch", runbook_url: `${base}%2e%2e/x.md` }),
        ],
        next_cursor: null,
      }),
    );
    const viewer = await loginAs(h, "read_only");
    const r = await call("GET", "/admin/v1/ops/alerts?state=open", viewer.s);
    expect(r.statusCode).toBe(200);
    const list = r.json().items as OpsAlert[];
    expect(list.map((a) => a.subject)).toEqual(["nats", "news", "audit", "watch"]);
    expect(list.map((a) => a.runbook_url)).toEqual([`${base}nats.md#nats-down`, null, null, null]);
    const me = (await call("GET", "/admin/v1/me", viewer.s)).json();
    expect(me.runbook_base_url).toBe(base);
  });

  it("фильтр subject_type принимает субъекты спринта 9 (service, deletion, ratelimit) и передаёт их ops-monitor", async () => {
    const seen: (string | undefined)[] = [];
    h.fake.on("opsMonitor", "GET", "/internal/v1/alerts", (c) => {
      seen.push(c.query.subject_type);
      return json(200, { items: [], next_cursor: null });
    });
    const viewer = await loginAs(h, "read_only");
    for (const t of ["service", "deletion", "ratelimit", "provider"]) {
      expect((await call("GET", `/admin/v1/ops/alerts?state=open&subject_type=${t}`, viewer.s)).statusCode, t).toBe(200);
    }
    expect(seen).toEqual(["service", "deletion", "ratelimit", "provider"]);
    expect((await call("GET", "/admin/v1/ops/alerts?subject_type=agent", viewer.s)).statusCode).toBe(422);
  });

  it("ack оповещения и команда DLQ передают Idempotent-Replayed", async () => {
    const { s } = await loginAs(h, "operations");
    h.fake.on("opsMonitor", "POST", `/internal/v1/alerts/${OPS_ALERT_ID}:ack`, () => replayed(200, opsAlertRow({ acked_by: OPERATOR_ID, acked_at: "2026-10-15T09:01:00Z" })));
    const ack = await call("POST", `/admin/v1/alerts/ops/${OPS_ALERT_ID}/ack`, s, {});
    expect(ack.statusCode).toBe(200);
    expect(ack.headers["idempotent-replayed"]).toBe("true");
    await stepUp(h, s);
    h.fake.on("opsMonitor", "POST", "/internal/v1/dlq:replay", () => replayed(200, { action_id: "1d8b2f3a-4c5e-4f6a-9b0c-2d3e4f5a6b71", requested: 1, done: 1, skipped: [] }));
    const r = await call("POST", "/admin/v1/ops/dlq/replay", s, { ids: ["dlq:42"], reason: "Повтор" }, idem("dlq"));
    expect(r.statusCode).toBe(200);
    expect(r.headers["idempotent-replayed"]).toBe("true");
    h.fake.on("opsMonitor", "POST", "/internal/v1/dlq:replay", () => json(200, { action_id: "1d8b2f3a-4c5e-4f6a-9b0c-2d3e4f5a6b71", requested: 1, done: 1, skipped: [] }));
    expect((await call("POST", "/admin/v1/ops/dlq/replay", s, { ids: ["dlq:42"], reason: "Повтор" }, idem("dlq2"))).headers["idempotent-replayed"]).toBeUndefined();
  });

  it("сводка дашборда передаёт снимок удалений; ops-monitor до спринта 9 — null", async () => {
    h.fake.on("opsMonitor", "GET", "/internal/v1/ops/summary", () =>
      json(200, opsSummaryRow({ deletions: { open: 3, stuck: 1, available: true, checked_at: "2026-10-15T08:58:00Z" } })),
    );
    const op = await loginAs(h, "operations");
    const d = (await call("GET", "/admin/v1/dashboard", op.s)).json();
    expect(d.system.data.deletions).toEqual({ open: 3, stuck: 1, available: true, checked_at: "2026-10-15T08:58:00Z" });
    const keys = await redis().keys(`${h.config.redisKeyPrefix}dash:*`);
    if (keys.length) await redis().del(...keys);
    h.fake.on("opsMonitor", "GET", "/internal/v1/ops/summary", () => json(200, opsSummaryRow()));
    expect((await call("GET", "/admin/v1/dashboard", op.s)).json().system.data.deletions).toBeNull();
  });
});

describe("заголовки безопасности API (SEC-12)", () => {
  it("nosniff, no-store, DENY, no-referrer, CSP API; CORS нет (предварительный запрос не разрешён)", async () => {
    const { s } = await loginAs(h, "read_only");
    const r = await call("GET", "/admin/v1/ops/ratelimits", s);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
    const pre = await h.app.inject({ method: "OPTIONS", url: "/admin/v1/ops/ratelimits", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    // ошибки — те же заголовки
    const e = await h.app.inject({ method: "GET", url: "/admin/v1/deletions" });
    expect(e.statusCode).toBe(401);
    expect(e.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});
