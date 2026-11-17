/**
 * Центр уведомлений (notifications, sub = активный ученик): inbox, unread-count, read (AT-12).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { InboxPageSchema } from "../src/schemas.js";
import { bearer, closeRedis, domainError, login, makeHarness, switchTo, type Harness, type LoggedIn } from "./helpers.js";

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

const get = (url: string, token = s.access) => h.app.inject({ url, headers: bearer(token) });
const read = (payload: unknown, token = s.access) =>
  h.app.inject({ method: "POST", url: "/v1/notifications/read", headers: bearer(token), payload: payload as object });

describe("GET /v1/notifications", () => {
  it("все сообщения, в т. ч. не доставленные в Telegram; служебные поля и статусы вне контракта приводятся", async () => {
    h.fake.addInbox(s.userId, { telegram: "in_app_only", category: "missed" });
    h.fake.addInbox(s.userId, { telegram: "skipped" as never, startapp: "javascript:alert(1)" });
    h.fake.addInbox(s.userId, { category: "marketing" as never, telegram: "sent", startapp: "invite_8b0e1c3a-5d2f-4a6b-9c7d-1e2f3a4b5c6d" });
    const res = await get("/v1/notifications?limit=10");
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(Value.Check(InboxPageSchema, page)).toBe(true);
    expect(page.next_cursor).toBeNull();
    expect(page.items.map((i: { category: string; telegram: string; startapp: string | null }) => [i.category, i.telegram, i.startapp])).toEqual([
      ["service", "sent", "invite_8b0e1c3a-5d2f-4a6b-9c7d-1e2f3a4b5c6d"],
      ["reminders", "in_app_only", null],
      ["missed", "in_app_only", "route_home"],
    ]);
    expect(res.body).not.toContain("user_id");
    const call = h.fake.callsTo("notifications", "GET", "/internal/v1/me/inbox")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.query).toEqual({ limit: "10" });
  });

  it("limit/cursor проверяются (≤ 100); 401 без токена; ошибки домена — как есть", async () => {
    expect((await get("/v1/notifications?limit=101")).statusCode).toBe(422);
    expect((await get("/v1/notifications?limit=0")).statusCode).toBe(422);
    await get("/v1/notifications?cursor=abc");
    expect(h.fake.callsTo("notifications").at(-1)!.query).toEqual({ limit: "20", cursor: "abc" });
    expect((await h.app.inject({ url: "/v1/notifications" })).statusCode).toBe(401);
    h.fake.override("notifications", "GET", "/internal/v1/me/inbox", () => domainError(422, "CURSOR_INVALID"));
    expect((await get("/v1/notifications?cursor=zzz")).json().code).toBe("CURSOR_INVALID");
  });

  it("детский профиль видит свои сообщения, не родителя", async () => {
    h.fake.setAge(s.userId, "18+");
    const child = h.fake.addChild(s.userId);
    h.fake.addInbox(s.userId, { title: "Родителю" });
    h.fake.addInbox(child, { title: "Мадине" });
    const c = await switchTo(h, s, child);
    const items = (await get("/v1/notifications", c.access)).json().items;
    expect(items.map((i: { title: string }) => i.title)).toEqual(["Мадине"]);
    expect(h.fake.callsTo("notifications", "GET", "/internal/v1/me/inbox").at(-1)!.subject).toBe(child);
  });
});

describe("unread-count и read", () => {
  it("непрочитанные; read по ids и all; 422 без ids и all", async () => {
    const a = h.fake.addInbox(s.userId);
    h.fake.addInbox(s.userId);
    h.fake.addInbox(s.userId);
    expect((await get("/v1/notifications/unread-count")).json()).toEqual({ unread: 3 });
    expect((await read({ ids: [a.notification_id.toUpperCase()] })).json()).toEqual({ unread: 2 });
    expect(h.fake.callsTo("notifications", "POST", "/internal/v1/me/inbox:read")[0]!.body).toEqual({ ids: [a.notification_id] });
    expect((await read({ all: true })).json()).toEqual({ unread: 0 });
    expect(h.fake.callsTo("notifications", "POST", "/internal/v1/me/inbox:read")[1]!.body).toEqual({ all: true });
    for (const bad of [{}, { ids: [] }, { all: false }, { ids: ["x"] }, { ids: Array.from({ length: 101 }, () => randomUUID()) }]) {
      const res = await read(bad);
      expect(res.statusCode, JSON.stringify(bad).slice(0, 40)).toBe(422);
    }
    expect(h.fake.callsTo("notifications", "POST")).toHaveLength(2);
  });

  it("непрочитанные — неотрицательное целое даже при мусоре от домена", async () => {
    h.fake.override("notifications", "GET", "/internal/v1/me/inbox/unread-count", () => new Response(JSON.stringify({ unread: -3 }), { status: 200 }));
    expect((await get("/v1/notifications/unread-count")).json()).toEqual({ unread: 0 });
  });
});
