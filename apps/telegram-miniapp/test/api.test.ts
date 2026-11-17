import type { SessionResponse } from "@tilhero/contracts/bff";
import { describe, expect, it, vi } from "vitest";
import { ApiClient, newIdempotencyKey, type ClientHooks } from "../src/api/client";
import { createApi } from "../src/api/endpoints";
import { ApiError, errorText } from "../src/api/errors";
import { translate } from "../src/i18n";

const session = (n: number, o: Partial<SessionResponse> = {}): SessionResponse => ({
  access_token: `acc-${n}`,
  expires_in: 900,
  refresh_token: `ref-${n}`,
  user: { user_id: "u", display_name: "Igor", username: null, locale: "ru", status: "ACTIVE", is_new: false },
  security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null },
  consent: { accepted: true, policy_version: "1.0", current_policy_version: "1.0", accepted_at: null, evidence_hash: null, age_confirmed_18_plus: true },
  onboarding_completed: true,
  ...o,
});

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const errBody = (code: string, details: Record<string, unknown> = {}) => ({ code, message: code, trace_id: "t", details });

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function setup(handler: Handler, hooks: ClientHooks = {}, storage: MemStorage | null = new MemStorage()) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as unknown as typeof fetch;
  const client = new ApiClient({ baseUrl: "https://bff.test", fetchImpl, storage, hooks, lang: () => "ru" });
  return { client, api: createApi(client), calls, storage };
}
const auth = (c: { init: RequestInit }) => (c.init.headers as Record<string, string>).Authorization;

describe("ApiClient.resumeSession (sprint 9: one-time initData, reload of the same launch)", () => {
  /** initData of one launch: its own auth_date / query_id → its own hash */
  const INIT = (launch: string, id = 42) =>
    `query_id=${launch}&user=${encodeURIComponent(JSON.stringify({ id, first_name: "I" }))}&auth_date=1&hash=${launch.padEnd(64, "a")}`;
  const stored = (launch: string) => {
    const st = new MemStorage();
    st.setItem("tilhero.rt", "ref-1");
    st.setItem("tilhero.rt.launch", launch.padEnd(64, "a"));
    return st;
  };

  it("first boot: a new session from initData, the refresh token remembered for this launch", async () => {
    const { client, calls, storage } = setup(() => json(200, session(1)));
    await client.resumeSession(INIT("b1"));
    expect(calls.map((c) => c.url)).toEqual(["https://bff.test/v1/session/telegram"]);
    expect(storage!.getItem("tilhero.rt")).toBe("ref-1");
    expect(storage!.getItem("tilhero.rt.launch")).toBe("b1".padEnd(64, "a"));
  });

  it("reload of the same launch (same initData): continues by refresh, initData is not presented again", async () => {
    const storage = stored("b1");
    const { client, calls } = setup(() => json(200, session(2)), {}, storage);
    const s = await client.resumeSession(INIT("b1"));
    expect(s.access_token).toBe("acc-2");
    expect(calls.map((c) => c.url)).toEqual(["https://bff.test/v1/session/refresh"]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ refresh_token: "ref-1" });
    expect(storage.getItem("tilhero.rt")).toBe("ref-2");
    expect(client.authenticated).toBe(true);
  });

  it("the same launch, hash in another case: still the same launch", async () => {
    const storage = stored("b1");
    const { client, calls } = setup(() => json(200, session(2)), {}, storage);
    await client.resumeSession(INIT("b1").replace(/hash=([0-9a-z]+)/, (_m, h: string) => `hash=${h.toUpperCase()}`));
    expect(calls.map((c) => c.url)).toEqual(["https://bff.test/v1/session/refresh"]);
  });

  it("new launch in a tab that kept sessionStorage (Telegram Web / Desktop): sign-in by its initData, the old session is not continued (PIN)", async () => {
    const storage = stored("b1");
    const { client, calls } = setup(() => json(200, session(4, { security: { pin_enabled: true, pin_length: 4, biometric_enabled: false, pin_required: true, locked_until: null } })), {}, storage);
    const s = await client.resumeSession(INIT("c2"));
    expect(calls.map((c) => c.url)).toEqual(["https://bff.test/v1/session/telegram"]);
    expect(s.security.pin_required).toBe(true);
    expect(storage.getItem("tilhero.rt")).toBe("ref-4");
    expect(storage.getItem("tilhero.rt.launch")).toBe("c2".padEnd(64, "a"));
  });

  it("stored token without a launch mark (older build): not continued", async () => {
    const storage = new MemStorage();
    storage.setItem("tilhero.rt", "ref-1");
    const { client, calls } = setup(() => json(200, session(5)), {}, storage);
    await client.resumeSession(INIT("b1"));
    expect(calls.map((c) => c.url)).toEqual(["https://bff.test/v1/session/telegram"]);
  });

  it("refresh no longer valid (401) → a new session from initData", async () => {
    const storage = stored("b1");
    const { client, calls } = setup((url) => (url.endsWith("/refresh") ? json(401, errBody("REFRESH_INVALID")) : json(200, session(3))), {}, storage);
    const s = await client.resumeSession(INIT("b1"));
    expect(s.access_token).toBe("acc-3");
    expect(calls.map((c) => c.url.split("/v1")[1])).toEqual(["/session/refresh", "/session/telegram"]);
  });

  it("boot twice with the same initData (StrictMode in dev): one request, the same session", async () => {
    const { client, calls } = setup(() => json(200, session(5)));
    const [a, b] = await Promise.all([client.resumeSession(INIT("b1")), client.resumeSession(INIT("b1"))]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it("network error on refresh is not swallowed into a replayed initData", async () => {
    const storage = stored("b1");
    const { client, calls } = setup(() => json(503, errBody("SERVICE_UNAVAILABLE")), {}, storage);
    await expect(client.resumeSession(INIT("b1"))).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
    expect(storage.getItem("tilhero.rt")).toBe("ref-1");
  });

  it("the rotated refresh token is in storage before the session is applied", async () => {
    const storage = stored("b1");
    let seenAtApply: string | null = null;
    const { client } = setup(() => json(200, session(9)), {}, storage);
    const orig = storage.setItem.bind(storage);
    storage.setItem = (k: string, v: string) => {
      orig(k, v);
      if (k === "tilhero.rt") seenAtApply = client.authenticated ? "after" : "before";
    };
    await client.resumeSession(INIT("b1"));
    expect(seenAtApply).toBe("before");
    expect(storage.getItem("tilhero.rt")).toBe("ref-9");
  });
});

describe("ApiClient session", () => {
  it("exchanges initData once; access in memory, refresh in sessionStorage", async () => {
    const { client, calls, storage } = setup(() => json(200, session(1)));
    await client.startSession("query_id=1&hash=x");
    expect(calls[0]!.url).toBe("https://bff.test/v1/session/telegram");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ init_data: "query_id=1&hash=x" });
    expect(auth(calls[0]!)).toBeUndefined();
    expect(storage!.getItem("tilhero.rt")).toBe("ref-1");
    expect(JSON.stringify([...storage!.m.values()])).not.toContain("acc-1");
  });

  it("works when sessionStorage throws (private mode)", async () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    } as unknown as MemStorage;
    let n = 0;
    const { client, api } = setup((url) => (url.endsWith("/v1/session/telegram") ? json(200, session(++n)) : json(200, { items: [], next_cursor: null })), {}, broken);
    await client.startSession("init");
    await expect(api.support.list()).resolves.toEqual({ items: [], next_cursor: null });
  });
});

describe("ApiClient refresh on 401", () => {
  it("refreshes once and retries with the new token", async () => {
    let refreshed = 0;
    const { client, api, calls } = setup((url, init) => {
      if (url.endsWith("/v1/session/telegram")) return json(200, session(1));
      if (url.endsWith("/v1/session/refresh")) {
        refreshed++;
        expect(JSON.parse(String(init.body))).toEqual({ refresh_token: "ref-1" });
        return json(200, session(2));
      }
      return (init.headers as Record<string, string>).Authorization === "Bearer acc-2" ? json(200, { summary: null, sections: [] }) : json(401, errBody("ACCESS_TOKEN_EXPIRED"));
    });
    await client.startSession("init");
    await expect(api.home.get()).resolves.toEqual({ summary: null, sections: [] });
    expect(refreshed).toBe(1);
    expect(auth(calls.at(-1)!)).toBe("Bearer acc-2");
  });

  it("concurrent 401s share a single refresh (single-flight)", async () => {
    let refreshed = 0;
    const { client, api } = setup(async (url, init) => {
      if (url.endsWith("/v1/session/telegram")) return json(200, session(1));
      if (url.endsWith("/v1/session/refresh")) {
        refreshed++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, session(2));
      }
      return (init.headers as Record<string, string>).Authorization === "Bearer acc-2" ? json(200, { items: [] }) : json(401, errBody("UNAUTHORIZED"));
    });
    await client.startSession("init");
    await Promise.all([api.directory.interests(), api.directory.geographies(), api.home.get()]);
    expect(refreshed).toBe(1);
  });

  it("business 401 (wrong PIN) is not a token problem: no refresh", async () => {
    const { client, api, calls } = setup((url) => (url.endsWith("/v1/session/telegram") ? json(200, session(1)) : json(401, errBody("PIN_INVALID", { remaining: 3 }))));
    await client.startSession("init");
    const e = await api.session.verifyPin("1111").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).remaining).toBe(3);
    expect(calls.some((c) => c.url.endsWith("/v1/session/refresh"))).toBe(false);
  });

  it("falls back to re-login with initData when the refresh token is rejected", async () => {
    let logins = 0;
    const { client, api } = setup((url, init) => {
      if (url.endsWith("/v1/session/telegram")) return json(200, session(++logins === 1 ? 1 : 5));
      if (url.endsWith("/v1/session/refresh")) return json(401, errBody("REFRESH_INVALID"));
      return (init.headers as Record<string, string>).Authorization === "Bearer acc-5" ? json(200, { items: [] }) : json(401, errBody("UNAUTHORIZED"));
    });
    await client.startSession("init");
    await expect(api.directory.interests()).resolves.toEqual({ items: [] });
    expect(logins).toBe(2);
  });

  it("401 SESSION_REVOKED skips the (revoked) refresh token and logs in again with initData", async () => {
    let logins = 0;
    const { client, api, calls } = setup((url, init) => {
      if (url.endsWith("/v1/session/telegram")) return json(200, session(++logins === 1 ? 1 : 7));
      return (init.headers as Record<string, string>).Authorization === "Bearer acc-7" ? json(200, { items: [] }) : json(401, errBody("SESSION_REVOKED"));
    });
    await client.startSession("init");
    await expect(api.directory.interests()).resolves.toEqual({ items: [] });
    expect(calls.some((c) => c.url.endsWith("/v1/session/refresh"))).toBe(false);
    expect(logins).toBe(2);
  });

  it("a network failure during refresh is not a lost session: the error reaches the caller, the token is kept", async () => {
    const onSessionLost = vi.fn();
    let down = true;
    const { client, api, storage } = setup(
      (url, init) => {
        if (url.endsWith("/v1/session/telegram")) return json(200, session(1));
        if (url.endsWith("/v1/session/refresh")) {
          if (down) throw new TypeError("Failed to fetch");
          return json(200, session(2));
        }
        return (init.headers as Record<string, string>).Authorization === "Bearer acc-2" ? json(200, { items: [] }) : json(401, errBody("TOKEN_EXPIRED"));
      },
      { onSessionLost },
    );
    await client.startSession("init");
    await expect(api.directory.interests()).rejects.toMatchObject({ code: "NETWORK" });
    expect(onSessionLost).not.toHaveBeenCalled();
    expect(storage!.getItem("tilhero.rt")).toBe("ref-1");
    down = false;
    await expect(api.directory.interests()).resolves.toEqual({ items: [] });
  });

  it("410 USER_DELETED on re-login ends the session with that code", async () => {
    const onSessionLost = vi.fn();
    let logins = 0;
    const { client, api } = setup(
      (url) => {
        if (url.endsWith("/v1/session/telegram")) return ++logins === 1 ? json(200, session(1)) : json(410, errBody("USER_DELETED"));
        if (url.endsWith("/v1/session/refresh")) return json(401, errBody("REFRESH_INVALID"));
        return json(401, errBody("SESSION_REVOKED"));
      },
      { onSessionLost },
    );
    await client.startSession("init");
    await expect(api.profile.get()).rejects.toMatchObject({ code: "USER_DELETED", status: 410 });
    expect(onSessionLost).toHaveBeenCalledWith(expect.objectContaining({ code: "USER_DELETED" }));
  });

  it("sprint 9 (O-1): re-login with the same initData → 401 INIT_DATA_REPLAYED ends the session once (no loop), text asks to reopen", async () => {
    const onSessionLost = vi.fn();
    let logins = 0;
    const { client, api } = setup(
      (url) => {
        if (url.endsWith("/v1/session/telegram")) return ++logins === 1 ? json(200, session(1)) : json(401, errBody("INIT_DATA_REPLAYED"));
        if (url.endsWith("/v1/session/refresh")) return json(401, errBody("REFRESH_INVALID"));
        return json(401, errBody("TOKEN_EXPIRED"));
      },
      { onSessionLost },
    );
    await client.startSession("init");
    await expect(api.profile.get()).rejects.toMatchObject({ code: "INIT_DATA_REPLAYED", status: 401 });
    expect(logins).toBe(2);
    expect(onSessionLost).toHaveBeenCalledOnce();
    expect(onSessionLost).toHaveBeenCalledWith(expect.objectContaining({ code: "INIT_DATA_REPLAYED" }));
  });

  it("reports a lost session when refresh and re-login both fail", async () => {
    const onSessionLost = vi.fn();
    let logins = 0;
    const { client, api } = setup(
      (url) => {
        if (url.endsWith("/v1/session/telegram")) return ++logins === 1 ? json(200, session(1)) : json(401, errBody("INIT_DATA_EXPIRED"));
        if (url.endsWith("/v1/session/refresh")) return json(401, errBody("REFRESH_INVALID"));
        return json(401, errBody("UNAUTHORIZED"));
      },
      { onSessionLost },
    );
    await client.startSession("init");
    await expect(api.profile.get()).rejects.toBeInstanceOf(ApiError);
    expect(onSessionLost).toHaveBeenCalledOnce();
  });
});

describe("ApiClient gates and connectivity", () => {
  it("423 PIN_REQUIRED calls onPinRequired (lock screen) and rejects", async () => {
    const onPinRequired = vi.fn();
    const { client, api } = setup((url) => (url.endsWith("/v1/session/telegram") ? json(200, session(1)) : json(423, errBody("PIN_REQUIRED"))), { onPinRequired });
    await client.startSession("init");
    const e = (await api.home.get().catch((x: unknown) => x)) as ApiError;
    expect(e.code).toBe("PIN_REQUIRED");
    expect(e.status).toBe(423);
    expect(onPinRequired).toHaveBeenCalledOnce();
  });

  it("503 and network failures switch the «Нет связи» banner on; the next success off", async () => {
    const onConnectivity = vi.fn();
    let mode: "503" | "net" | "ok" = "503";
    const { client, api } = setup(
      (url) => {
        if (url.endsWith("/v1/session/telegram")) return json(200, session(1));
        if (mode === "net") throw new TypeError("Failed to fetch");
        return mode === "503" ? json(503, errBody("SERVICE_UNAVAILABLE")) : json(200, { items: [] });
      },
      { onConnectivity },
    );
    await client.startSession("init");
    onConnectivity.mockClear();
    await expect(api.directory.interests()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(onConnectivity).toHaveBeenLastCalledWith(false);
    mode = "net";
    await expect(api.directory.interests()).rejects.toMatchObject({ code: "NETWORK", status: 0 });
    expect(onConnectivity).toHaveBeenLastCalledWith(false);
    mode = "ok";
    await api.directory.interests();
    expect(onConnectivity).toHaveBeenLastCalledWith(true);
  });

  it("sends Idempotency-Key on ticket creation and the same key on retry", async () => {
    let attempt = 0;
    const keys: string[] = [];
    const { client, api } = setup((url, init) => {
      if (url.endsWith("/v1/session/telegram")) return json(200, session(1));
      keys.push((init.headers as Record<string, string>)["Idempotency-Key"]!);
      return ++attempt === 1 ? json(503, errBody("SERVICE_UNAVAILABLE")) : json(201, { ticket_id: "t1", number: "TCK-3082" });
    });
    await client.startSession("init");
    const key = newIdempotencyKey();
    const req = { category: "BUG" as const, subject: "Crash", message: "On start", context: { client_version: "telegram-miniapp-2.0" } };
    await expect(api.support.create(req, key)).rejects.toBeInstanceOf(ApiError);
    await api.support.create(req, key);
    expect(keys).toEqual([key, key]);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("encodes path ids and query parameters", async () => {
    const { client, api, calls } = setup((url) => (url.endsWith("/v1/session/telegram") ? json(200, session(1)) : json(200, { items: [] })));
    await client.startSession("init");
    await api.support.get("../admin");
    await api.directory.airports("tash kent");
    expect(calls[1]!.url).toBe("https://bff.test/v1/support/tickets/..%2Fadmin");
    expect(calls[2]!.url).toBe("https://bff.test/v1/directory/airports?q=tash+kent&limit=20");
  });
});

describe("errorText", () => {
  const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate("ru", k, v);
  const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  it("translates by code, never shows the server message", () => {
    expect(errorText(new ApiError(401, "PIN_INVALID", "server text", { remaining: 2 }), t, mmss)).toBe("Неверный PIN. Осталось попыток: 2");
    expect(errorText(new ApiError(423, "PIN_LOCKED", "x", { retry_after: 290 }), t, mmss)).toBe("Слишком много попыток. Попробуйте через 04:50");
    expect(errorText(new ApiError(409, "PIN_REQUIRED", "x"), t, mmss)).toContain("Сначала задайте PIN-код");
    expect(errorText(new ApiError(500, "WHATEVER_INTERNAL", "stack trace"), t, mmss)).toBe("Сервис временно недоступен. Повторите через минуту");
    expect(errorText(new Error("boom"), t, mmss)).toBe("Не получилось. Повторите действие");
  });
  it("BFF codes: server faults read as «temporarily unavailable», session codes and limits have their own text", () => {
    const unavailable = "Сервис временно недоступен. Повторите через минуту";
    for (const [st, code] of [[503, "UPSTREAM_UNAVAILABLE"], [500, "INTERNAL_ERROR"], [503, "INTERNAL_TOKEN_INVALID"], [403, "ACTOR_NOT_ALLOWED"], [403, "CALLER_NOT_ALLOWED"]] as const)
      expect(errorText(new ApiError(st, code, "x"), t, mmss), code).toBe(unavailable);
    expect(errorText(new ApiError(401, "SESSION_REVOKED", "x"), t, mmss)).toContain("Сессия завершена");
    expect(errorText(new ApiError(401, "TOKEN_INVALID", "x"), t, mmss)).toContain("Сессия завершена");
    expect(errorText(new ApiError(401, "TOKEN_EXPIRED", "x"), t, mmss)).toContain("Сессия устарела");
    expect(errorText(new ApiError(410, "USER_DELETED", "x"), t, mmss)).toContain("Профиль удаляется");
    expect(errorText(new ApiError(422, "PIN_FORMAT", "x", { field: "pin" }), t, mmss)).toContain("4 или 6 цифр");
    expect(errorText(new ApiError(413, "PAYLOAD_TOO_LARGE", "x"), t, mmss)).toContain("Слишком большой текст");
    expect(errorText(ApiError.fromBody(413, null), t, mmss)).toContain("Слишком большой текст");
    expect(errorText(new ApiError(422, "VALIDATION_ERROR", "x"), t, mmss)).toBe("Проверьте введённые данные и повторите");
    expect(errorText(new ApiError(400, "INVALID_JSON", "x"), t, mmss)).toBe("Проверьте введённые данные и повторите");
  });

  it("rejects malformed codes from the wire", () => {
    expect(ApiError.fromBody(503, { code: "<script>" } as never).code).toBe("SERVICE_UNAVAILABLE");
  });
});

/**
 * Review 🟡-8: PIN verify reissues the session and deletes the old refresh token on the server. A refresh with
 * the old token racing it must not drop the new session and log in again by initData (pin_required → lock).
 * The handler below models telegram-bff: one valid refresh token, verify/reset rotate it.
 */
describe("ApiClient: PIN verify ↔ background refresh", () => {
  function bff() {
    let n = 1;
    let rt = "ref-1";
    let access = "acc-1";
    let logins = 0;
    let refreshes = 0;
    const gates: Record<string, Promise<void>> = {};
    /** delay the RESPONSE (the server has already acted) */
    const after: Record<string, Promise<void>> = {};
    const issue = (pinRequired: boolean) => {
      n += 1;
      rt = `ref-${n}`;
      access = `acc-${n}`;
      return session(n, { security: { pin_enabled: true, pin_length: 4, biometric_enabled: false, pin_required: pinRequired, locked_until: null } });
    };
    const handler: Handler = async (url, init) => {
      const path = new URL(url).pathname;
      const gate = gates[path];
      if (gate) await gate;
      if (path === "/v1/session/telegram") {
        logins++;
        return json(200, logins === 1 ? session(1, { security: { pin_enabled: true, pin_length: 4, biometric_enabled: false, pin_required: true, locked_until: null } }) : issue(true));
      }
      if (path === "/v1/session/refresh") {
        refreshes++;
        return JSON.parse(String(init.body)).refresh_token === rt ? json(200, issue(false)) : json(401, errBody("REFRESH_INVALID"));
      }
      if (path === "/v1/session/pin/verify") {
        const s = issue(false);
        if (after[path]) await after[path];
        return json(200, s);
      }
      return (init.headers as Record<string, string>).Authorization === `Bearer ${access}` ? json(200, { items: [] }) : json(401, errBody("TOKEN_EXPIRED"));
    };
    return { handler, gates, after, stats: () => ({ logins, refreshes, rt, access }) };
  }
  const deferred = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };

  it("proactive refresh in flight: verify waits for it, no re-login, the verified session wins", async () => {
    const server = bff();
    let t = 0;
    const onSession = vi.fn();
    const calls: string[] = [];
    const storage = new MemStorage();
    const client = new ApiClient({
      baseUrl: "https://bff.test",
      storage,
      now: () => t,
      hooks: { onSession },
      fetchImpl: (async (u: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new URL(String(u)).pathname);
        return server.handler(String(u), init ?? {});
      }) as typeof fetch,
    });
    const api = createApi(client);
    await client.startSession("init");
    t = 899_000; // 1 s before expiry → the next call refreshes proactively
    const gate = deferred();
    server.gates["/v1/session/refresh"] = gate.p;
    const bg = api.directory.interests();
    await new Promise((r) => setTimeout(r, 0));
    const verify = api.session.verifyPin("2580");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c === "/v1/session/pin/verify")).toHaveLength(0); // serialised behind the refresh
    gate.open();
    const s = await verify;
    await bg;
    expect(s.security.pin_required).toBe(false);
    expect(server.stats().logins).toBe(1);
    expect(storage.getItem("tilhero.rt")).toBe(server.stats().rt);
    expect(onSession.mock.calls.every(([x]) => !(x as SessionResponse).security.pin_required)).toBe(true);
  });

  it("verify in flight: a 401 elsewhere waits for it and retries with the new token instead of refreshing", async () => {
    const server = bff();
    const storage = new MemStorage();
    const client = new ApiClient({ baseUrl: "https://bff.test", storage, fetchImpl: ((u: RequestInfo | URL, i?: RequestInit) => server.handler(String(u), i ?? {})) as typeof fetch });
    const api = createApi(client);
    await client.startSession("init");
    const gate = deferred();
    server.after["/v1/session/pin/verify"] = gate.p; // the server rotates the tokens, the answer is slow
    const verify = api.session.verifyPin("2580");
    await new Promise((r) => setTimeout(r, 0));
    expect(server.stats().access).toBe("acc-2");
    const other = api.directory.interests(); // still sends acc-1 → 401 TOKEN_EXPIRED while verify is in flight
    await new Promise((r) => setTimeout(r, 5));
    gate.open();
    await verify;
    await expect(other).resolves.toEqual({ items: [] });
    expect(server.stats().refreshes).toBe(0);
    expect(server.stats().logins).toBe(1);
    expect(storage.getItem("tilhero.rt")).toBe(server.stats().rt);
  });

  it("a refresh answered after a newer session was accepted is ignored (no token removal, no re-login)", async () => {
    const server = bff();
    const storage = new MemStorage();
    const client = new ApiClient({ baseUrl: "https://bff.test", storage, fetchImpl: ((u: RequestInfo | URL, i?: RequestInit) => server.handler(String(u), i ?? {})) as typeof fetch });
    await client.startSession("init");
    const gate = deferred();
    server.gates["/v1/session/refresh"] = gate.p;
    const refresh = client.refreshOnce();
    // a session issued by another path (e.g. reset-confirm answered first) lands while the refresh waits
    client.acceptSession(session(9));
    gate.open();
    await expect(refresh).resolves.toBeNull();
    expect(storage.getItem("tilhero.rt")).toBe("ref-9");
    expect(server.stats().logins).toBe(1);
  });
});
