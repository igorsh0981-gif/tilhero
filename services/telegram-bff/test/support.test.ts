/**
 * Поддержка из профиля (AT-15): support от имени аккаунта, Idempotency-Key, категории TilHero, детский профиль.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { TicketSchema } from "../src/schemas.js";
import { bearer, closeRedis, login, makeHarness, switchTo, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
beforeEach(async () => {
  h = await makeHarness();
  s = await login(h);
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const BODY = { category: "SCHEDULE_REMINDERS", subject: "Не пришло напоминание", message: "Вчера в 19:00", context: { client_version: "telegram-miniapp-1.0" } };
const create = (headers: Record<string, string>, payload: object = BODY, token = s.access) =>
  h.app.inject({ method: "POST", url: "/v1/support/tickets", headers: { ...bearer(token), ...headers }, payload });

describe("POST /v1/support/tickets", () => {
  it("201 Ticket; Idempotency-Key обязателен (UUID) и пробрасывается; повтор — то же обращение; служебные поля не уходят", async () => {
    expect((await create({})).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await create({ "idempotency-key": "123" })).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const key = randomUUID();
    const a = await create({ "idempotency-key": key });
    expect(a.statusCode).toBe(201);
    expect(Value.Check(TicketSchema, a.json())).toBe(true);
    expect(a.json()).toMatchObject({ number: "TCK-3000", category: "SCHEDULE_REMINDERS", status: "NEW", context: { client_version: "telegram-miniapp-1.0" } });
    expect(a.body).not.toMatch(/owner|assignee_id/);
    const b = await create({ "idempotency-key": key });
    expect(b.json().ticket_id).toBe(a.json().ticket_id);
    const calls = h.fake.callsTo("support", "POST", "/internal/v1/me/tickets");
    expect(calls.map((c) => [c.subject, c.headers["idempotency-key"]])).toEqual([
      [s.userId, key],
      [s.userId, key],
    ]);
    expect(calls[0]!.body).toEqual(BODY);
  });

  it("422: категория вне TilHero → SUPPORT_CATEGORY_INVALID, длины, лишние поля, user_id в теле", async () => {
    const bad = await create({ "idempotency-key": randomUUID() }, { ...BODY, category: "FLIGHT" });
    expect(bad.json().code).toBe("SUPPORT_CATEGORY_INVALID");
    for (const p of [{ ...BODY, subject: "ab" }, { ...BODY, message: "" }, { ...BODY, message: "x".repeat(4001) }, { ...BODY, user_id: randomUUID() }]) {
      expect((await create({ "idempotency-key": randomUUID() }, p)).statusCode).toBe(422);
    }
    expect(h.fake.callsTo("support", "POST")).toHaveLength(0);
  });
});

describe("чтение, сообщения, закрытие, категории", () => {
  it("список, по UUID и TCK-номеру, сообщение (409 после закрытия), категории RU/UZ", async () => {
    const t = (await create({ "idempotency-key": randomUUID() })).json();
    const list = await h.app.inject({ url: "/v1/support/tickets?limit=5", headers: bearer(s.access) });
    expect(list.json().items.map((x: { ticket_id: string }) => x.ticket_id)).toEqual([t.ticket_id]);
    expect((await h.app.inject({ url: `/v1/support/tickets/${t.number}`, headers: bearer(s.access) })).json().ticket_id).toBe(t.ticket_id);
    const msg = await h.app.inject({ method: "POST", url: `/v1/support/tickets/${t.ticket_id}/messages`, headers: { ...bearer(s.access), "idempotency-key": randomUUID() }, payload: { text: "Ещё" } });
    expect(msg.json().messages).toHaveLength(2);
    expect((await h.app.inject({ method: "POST", url: `/v1/support/tickets/${t.ticket_id}/close`, headers: bearer(s.access) })).json().status).toBe("CLOSED");
    const closed = await h.app.inject({ method: "POST", url: `/v1/support/tickets/${t.ticket_id}/messages`, headers: bearer(s.access), payload: { text: "Ещё" } });
    expect(closed.json().code).toBe("SUPPORT_TICKET_CLOSED");
    for (const ref of ["abc", "TCK-", randomUUID()]) {
      expect((await h.app.inject({ url: `/v1/support/tickets/${ref}`, headers: bearer(s.access) })).json().code, ref).toBe("SUPPORT_TICKET_NOT_FOUND");
    }
    const cats = await h.app.inject({ url: "/v1/support/categories", headers: bearer(s.access) });
    expect(cats.json().items[0]).toEqual({ code: "SCHEDULE_REMINDERS", label: { ru: "График и напоминания", uz: "Jadval va eslatmalar" }, available: true });
  });

  it("детский профиль: переписка недоступна (403 ADULT_REQUIRED), категории — можно; support не вызывается", async () => {
    h.fake.setAge(s.userId, "18+");
    const t = (await create({ "idempotency-key": randomUUID() })).json();
    const c = await switchTo(h, s, h.fake.addChild(s.userId));
    h.fake.calls.length = 0;
    const probes: Array<["GET" | "POST", string, object?]> = [
      ["POST", "/v1/support/tickets", BODY],
      ["GET", "/v1/support/tickets"],
      ["GET", `/v1/support/tickets/${t.ticket_id}`],
      ["POST", `/v1/support/tickets/${t.ticket_id}/messages`, { text: "привет" }],
      ["POST", `/v1/support/tickets/${t.ticket_id}/close`],
    ];
    for (const [method, url, payload] of probes) {
      const res = await h.app.inject({ method, url, headers: { ...bearer(c.access), "idempotency-key": randomUUID() }, ...(payload ? { payload } : {}) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe("ADULT_REQUIRED");
    }
    expect(h.fake.callsTo("support")).toHaveLength(0);
    const cats = await h.app.inject({ url: "/v1/support/categories", headers: bearer(c.access) });
    expect(cats.statusCode).toBe(200);
    expect(h.fake.callsTo("support")[0]!.subject).toBe(s.userId);
  });
});
