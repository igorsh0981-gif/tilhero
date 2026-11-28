/**
 * Клиент API и корень приложения (jsdom): CSRF только у изменяющих запросов, same-origin cookie, Idempotency-Key у
 * заказа, переход к провайдеру — только https; ошибка входа из адреса показывается и убирается из адреса.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, goToCheckout, safeHttps, setCsrf } from "../src/api";
import { App } from "../src/App";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function mockFetch(handler: (url: string, init: RequestInit) => Response): void {
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  });
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  calls = [];
  setCsrf(null);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("api", () => {
  it("GET — без CSRF; POST — X-CSRF-Token и Idempotency-Key; только относительный /api, same-origin", async () => {
    mockFetch(() => json(201, { order_no: 1 }));
    setCsrf("csrf-1");
    await api.catalog();
    await api.createOrder({ product_code: "plus_30d", provider: "payme", offer_version: "v", start_mode: "now" }, "6f1c1c3e-1111-4111-8111-111111111111");
    const [get, post] = calls;
    expect(get!.url).toBe("/api/catalog");
    expect((get!.init.headers as Record<string, string>)["x-csrf-token"]).toBeUndefined();
    expect(get!.init.credentials).toBe("same-origin");
    expect(post!.url).toBe("/api/orders");
    expect(post!.init.method).toBe("POST");
    expect(post!.init.headers).toMatchObject({ "x-csrf-token": "csrf-1", "idempotency-key": "6f1c1c3e-1111-4111-8111-111111111111", "content-type": "application/json" });
    expect(JSON.parse(String(post!.init.body))).toEqual({ product_code: "plus_30d", provider: "payme", offer_version: "v", start_mode: "now" });
  });

  it("ошибка — ApiError с кодом и details; сеть недоступна — NETWORK; 5xx без тела — BILLING_UNAVAILABLE", async () => {
    mockFetch(() => json(409, { code: "FORFEIT_CONFIRMATION_REQUIRED", message: "x", trace_id: "t", details: { minutes_left: 5, days_left: 1 } }));
    await expect(api.createOrder({ product_code: "a1", provider: "click", offer_version: "v" }, "k")).rejects.toMatchObject({
      status: 409,
      code: "FORFEIT_CONFIRMATION_REQUIRED",
      details: { minutes_left: 5, days_left: 1 },
    });
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    await expect(api.me()).rejects.toMatchObject({ code: "NETWORK" });
    mockFetch(() => new Response("bad gateway", { status: 502 }));
    const e = (await api.subscription().catch((x: unknown) => x)) as ApiError;
    expect(e.code).toBe("BILLING_UNAVAILABLE");
  });

  it("переход к провайдеру и ссылки — только https", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    expect(goToCheckout("javascript:alert(1)")).toBe(false);
    expect(goToCheckout("http://checkout.paycom.uz/x")).toBe(false);
    expect(goToCheckout(null)).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(goToCheckout("https://checkout.paycom.uz/abc")).toBe(true);
    expect(assign).toHaveBeenCalledWith("https://checkout.paycom.uz/abc");
    expect(safeHttps("data:text/html,x")).toBeNull();
    expect(safeHttps("https://ofd.soliq.uz/check?t=1")).toBe("https://ofd.soliq.uz/check?t=1");
  });
});

describe("App", () => {
  it("без сессии: экран входа; ?login_error=account_not_found — сообщение, адрес очищен", async () => {
    window.history.replaceState(null, "", "/?login_error=account_not_found");
    mockFetch(() => json(401, { code: "SESSION_EXPIRED", message: "x", trace_id: "t", details: {} }));
    await act(async () => {
      render(<App />);
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Аккаунт TilHero не найден"));
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("button", { name: "Войти через Telegram" })).toBeTruthy();
    expect(calls.map((c) => c.url)).toEqual(["/api/me"]);
  });

  it("сессия есть: CSRF из /me используется в изменяющих запросах", async () => {
    mockFetch((url) => {
      if (url === "/api/me") return json(200, { account: { age_band: "18+", can_pay: true, consent_required: false }, learners: [], csrf_token: "from-me" });
      if (url === "/api/auth/logout") return new Response(null, { status: 204 });
      return json(503, { code: "BILLING_UNAVAILABLE", message: "x", trace_id: "t", details: {} });
    });
    await act(async () => {
      render(<App />);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Выйти" })).toBeTruthy());
    await act(async () => {
      screen.getByRole("button", { name: "Выйти" }).click();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Войти через Telegram" })).toBeTruthy());
    const logout = calls.find((c) => c.url === "/api/auth/logout")!;
    expect((logout.init.headers as Record<string, string>)["x-csrf-token"]).toBe("from-me");
  });
});
