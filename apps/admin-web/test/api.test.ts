import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApi } from "../src/api/client";
import { Ai } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { translate } from "../src/i18n";
import { errText } from "../src/ui/errors";

type Call = { url: string; init: RequestInit };
function fake(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  });
  return { api: new AdminApi(impl as unknown as typeof fetch), calls };
}
const h = (c: Call) => c.init.headers as Record<string, string>;
const errBody = (code: string, details: Record<string, unknown> = {}) => ({ code, message: code, trace_id: "trace-1234567890abc", details });

describe("admin-bff client", () => {
  it("same-origin relative /admin/v1 URLs with the cookie session; CSRF only on non-GET", async () => {
    const { api, calls } = fake([{ status: 200, body: { ok: 1 } }, { status: 200, body: {} }]);
    api.setCsrf("csrf-1");
    await api.get("/users", { query: { q: "@igor", status: "", cursor: null } });
    await api.post("/support/tickets/x/take");
    expect(calls[0]!.url).toBe("/admin/v1/users?q=%40igor");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(h(calls[0]!)["X-CSRF-Token"]).toBeUndefined();
    expect(h(calls[1]!)["X-CSRF-Token"]).toBe("csrf-1");
  });

  it("403 STEP_UP_REQUIRED → asks for TOTP and repeats once with the same Idempotency-Key", async () => {
    const { api, calls } = fake([{ status: 403, body: errBody("STEP_UP_REQUIRED") }, { status: 201, body: { staff: {} } }]);
    api.setCsrf("c");
    const onStepUp = vi.fn(async () => true);
    api.hooks = { onStepUp };
    await api.post("/staff", { email: "a@b.c" }, { idempotencyKey: true });
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(h(calls[0]!)["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h(calls[1]!)["Idempotency-Key"]).toBe(h(calls[0]!)["Idempotency-Key"]);
  });

  it("a dismissed step-up rejects with cancelled=true and no retry", async () => {
    const { api, calls } = fake([{ status: 403, body: errBody("STEP_UP_REQUIRED") }]);
    api.hooks = { onStepUp: async () => false };
    const e = await api.post("/roles/support", {}).catch((x: ApiError) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).cancelled).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("401 SESSION_REVOKED outside the sign-in flow drops the CSRF token and returns to the login screen", async () => {
    const { api } = fake([{ status: 401, body: errBody("SESSION_REVOKED") }, { status: 401, body: errBody("INVALID_CREDENTIALS", { remaining: 3 }) }]);
    api.setCsrf("c");
    const lost = vi.fn();
    api.hooks = { onSessionLost: lost };
    await expect(api.get("/me")).rejects.toMatchObject({ code: "SESSION_REVOKED" });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(api.hasCsrf).toBe(false);
    // a wrong password is not a lost session
    await expect(api.post("/auth/login", { email: "a", password: "b" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("network failure becomes a NETWORK ApiError", async () => {
    const api = new AdminApi((async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    await expect(api.get("/me")).rejects.toMatchObject({ code: "NETWORK", status: 0 });
  });
});

describe("AI budget (review R2-07)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("PUT /ai/budget carries the updated_at of the budget that was read; 409 BUDGET_CONFLICT keeps its code and details", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const answers = [
      { status: 200, body: { ai_enabled: true, monthly_cap_usd: 20, learner_daily_cap_usd: 0.05, lesson_cap_usd: 0.03, alert_percent: 90, updated_at: "2026-11-19T10:00:01Z" } },
      { status: 409, body: errBody("BUDGET_CONFLICT", { updated_at: "2026-11-19T10:05:00Z" }) },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = answers.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    }));
    const b = { monthly_cap_usd: 20, learner_daily_cap_usd: 0.05, lesson_cap_usd: 0.03, speech_monthly_cap_usd: 5, room_cap_usd: 0.1, alert_percent: 90 };
    await Ai.putBudget(b, "2026-11-19T10:00:00Z", "Порог 90 %");
    expect(calls[0]!.url).toBe("/admin/v1/ai/budget");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ...b, updated_at: "2026-11-19T10:00:00Z", reason: "Порог 90 %" });
    const e = await Ai.putBudget(b, "2026-11-19T10:00:01Z", "Ещё раз").catch((x: ApiError) => x);
    expect(e).toMatchObject({ status: 409, code: "BUDGET_CONFLICT" });
    expect((e as ApiError).details.updated_at).toBe("2026-11-19T10:05:00Z");
  });
  it("the conflict text: another staff member changed the limits — check and save again (RU / EN)", () => {
    expect(translate("ru", "csf.conflict")).toBe("Лимиты изменил другой сотрудник — проверьте и сохраните ещё раз");
    expect(translate("en", "csf.conflict")).toBe("Another staff member changed the limits — check them and save again");
    const ru = { t: (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate("ru", k, v) };
    expect(errText(ru, new ApiError(409, errBody("BUDGET_CONFLICT", { updated_at: "x" })))).toBe("Лимиты изменил другой сотрудник — проверьте и сохраните ещё раз");
  });
});

describe("error texts", () => {
  const i = { t: (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate("ru", k, v) };
  it("403 PERMISSION_DENIED names the permission; without details it is still clear", () => {
    expect(errText(i, new ApiError(403, errBody("PERMISSION_DENIED", { permission: "whatsnew.publish" })))).toBe("Недостаточно прав: нужно право whatsnew.publish");
    expect(errText(i, new ApiError(403, errBody("PERMISSION_DENIED")))).toContain("нет права");
    expect(errText(i, new ApiError(403, errBody("SOMETHING_NEW")))).toContain("нет права");
  });
  it("domain codes and status fallbacks", () => {
    expect(errText(i, new ApiError(409, errBody("LAST_SUPER_ADMIN")))).toContain("последнего");
    expect(errText(i, new ApiError(409, errBody("UNKNOWN_CONFLICT")))).toContain("Состояние изменилось");
    expect(errText(i, new ApiError(503, errBody("WHATEVER")))).toContain("временно недоступен");
    expect(errText(i, new ApiError(0, null))).toContain("Нет связи");
    expect(errText(i, new Error("x"))).toContain("Что-то пошло не так");
  });
});
