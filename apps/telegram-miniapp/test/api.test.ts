import type { SessionResponse } from "@tilhero/contracts/bff";
import { describe, expect, it, vi } from "vitest";
import { createBff } from "../src/api/bff";
import { ApiClient } from "../src/api/client";
import { ApiError, displayCode, errorText } from "../src/api/errors";
import { makeI18n } from "../src/i18n";

const session = (n: number): SessionResponse =>
  ({ access_token: `acc-${n}`, refresh_token: `ref-${n}`, expires_in: 900, start_param: null }) as unknown as SessionResponse;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function setup(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as unknown as typeof fetch;
  const client = new ApiClient({ baseUrl: "/bff", fetchImpl, storage, lang: () => "uz" });
  return { client, bff: createBff(client), calls, store };
}
const hdr = (init: RequestInit) => init.headers as Record<string, string>;

describe("ApiClient / BFF routes", () => {
  it("signs in with initData, then sends the bearer token and Accept-Language", async () => {
    const { client, bff, calls } = setup((url) => (url.endsWith("/v1/session/telegram") ? json(200, session(1)) : json(200, { items: [] })));
    await client.resumeSession("hash=abc&user=1");
    await bff.goals();
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ init_data: "hash=abc&user=1" });
    expect(hdr(calls[1]!.init).Authorization).toBe("Bearer acc-1");
    expect(hdr(calls[1]!.init)["Accept-Language"]).toBe("uz");
  });
  it("PATCH /v1/plan carries If-Match; creating commands carry Idempotency-Key", async () => {
    const { client, bff, calls } = setup((url) => (url.endsWith("/session/telegram") ? json(200, session(1)) : json(200, {})));
    await client.startSession("hash=a");
    await bff.patchPlan({ schedule: { duration_min: 30 } }, 7);
    // sprint 4: sessions start with an Idempotency-Key; the manual activity is gone from the client
    await bff.startLesson("l-a1-03-cafe", "k-1");
    await bff.createInvite("family", "k-2");
    expect(hdr(calls[1]!.init)["If-Match"]).toBe("7");
    expect(calls[1]!.init.method).toBe("PATCH");
    expect(calls[2]!.url).toBe("/bff/v1/lessons/l-a1-03-cafe/sessions");
    expect(hdr(calls[2]!.init)["Idempotency-Key"]).toBe("k-1");
    expect("recordActivity" in bff).toBe(false);
    expect(hdr(calls[3]!.init)["Idempotency-Key"]).toBe("k-2");
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ kind: "family" });
  });
  it("GET /v1/plan passes the device time zone; GET /v1/family 204 → null", async () => {
    const { client, bff, calls } = setup((url) => (url.endsWith("/session/telegram") ? json(200, session(1)) : url.includes("/v1/family") ? json(204, null) : json(200, {})));
    await client.startSession("hash=a");
    await bff.plan("Asia/Tashkent");
    expect(calls[1]!.url).toBe("/bff/v1/plan?tz=Asia%2FTashkent");
    expect(await bff.family()).toBeNull();
  });
  it("an expired access token is refreshed once and the call repeated", async () => {
    let n = 0;
    const { client, bff, calls } = setup((url) => {
      if (url.endsWith("/session/telegram")) return json(200, session(1));
      if (url.endsWith("/session/refresh")) return json(200, session(2));
      n += 1;
      return n === 1 ? json(401, { code: "TOKEN_EXPIRED", message: "", trace_id: "t", details: {} }) : json(200, { unread: 3 });
    });
    await client.startSession("hash=a");
    await expect(bff.unreadCount()).resolves.toEqual({ unread: 3 });
    expect(calls.map((c) => c.url.replace("/bff", ""))).toEqual(["/v1/session/telegram", "/v1/notifications/unread-count", "/v1/session/refresh", "/v1/notifications/unread-count"]);
    expect(hdr(calls[3]!.init).Authorization).toBe("Bearer acc-2");
  });
  it("business 401 (wrong PIN) is not a reason to refresh", async () => {
    const { client, bff, calls } = setup((url) => (url.endsWith("/session/telegram") ? json(200, session(1)) : json(401, { code: "PIN_INVALID", message: "", trace_id: "t", details: { remaining: 2 } })));
    await client.startSession("hash=a");
    await expect(bff.verifyPin("0000")).rejects.toMatchObject({ code: "PIN_INVALID", remaining: 2 });
    expect(calls).toHaveLength(2);
  });
  it("a failed boot can be retried (no cached rejection)", async () => {
    let fail = true;
    const { client } = setup(() => {
      if (fail) {
        fail = false;
        throw new TypeError("offline");
      }
      return json(200, session(1));
    });
    await expect(client.resumeSession("hash=a")).rejects.toMatchObject({ code: "NETWORK" });
    await expect(client.resumeSession("hash=a")).resolves.toMatchObject({ access_token: "acc-1" });
  });
  it("429: the wait comes from Retry-After when the body has none", async () => {
    const { client, bff } = setup((url) => (url.endsWith("/session/telegram") ? json(200, session(1)) : json(429, { code: "RATE_LIMITED", message: "", trace_id: "t", details: {} }, { "Retry-After": "7" })));
    await client.startSession("hash=a");
    const e = await bff.goals().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).retryAfter).toBe(7);
  });
});

describe("error texts by code", () => {
  const { t, fmt } = makeI18n("ru");
  it("known codes, aliases and server faults", () => {
    expect(errorText(new ApiError(409, "PLAN_VERSION_CONFLICT", "x"), t, fmt.mmss)).toBe("План изменился на другом устройстве — показываем актуальный.");
    expect(errorText(new ApiError(401, "PIN_INVALID", "x", { remaining: 3 }), t, fmt.mmss)).toBe("Неверный код. Осталось попыток: 3.");
    expect(displayCode(new ApiError(503, "UPSTREAM_UNAVAILABLE", "x"))).toBe("SERVICE_UNAVAILABLE");
    expect(displayCode(new ApiError(403, "CALLER_NOT_ALLOWED", "x"))).toBe("SERVICE_UNAVAILABLE");
    expect(displayCode(new ApiError(404, "SOMETHING_NEW", "x"))).toBe("NOT_FOUND");
    expect(errorText(new Error("boom"), t, fmt.mmss)).toBe("Что-то пошло не так. Попробуйте ещё раз.");
    // the server's Russian message is never shown
    expect(errorText(new ApiError(422, "QUIET_HOURS_INVALID", "внутренний текст"), t, fmt.mmss)).not.toContain("внутренний");
  });
});
