/** Sprint 9 (INTERNAL_API §2.2): one 429 everywhere — «повторите через ⌈N⌉ с», no automatic repeat; 503
 *  RATE_LIMIT_UNAVAILABLE — «Сервис временно перегружен». */
import type { SessionResponse } from "@tilhero/contracts/bff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEvent, newAnswer } from "../src/ai/chat";
import { ApiClient } from "../src/api/client";
import { createApi } from "../src/api/endpoints";
import { ApiError, errorText } from "../src/api/errors";
import { parseRetryAfter, rateLimits, rateLimitWait } from "../src/api/rateLimit";
import { translate, type Lang, type MessageKey, type Vars } from "../src/i18n";

const tr = (lang: Lang) => (k: MessageKey, v?: Vars) => translate(lang, k, v);
const mmss = (s: number) => `${s}`;

afterEach(() => rateLimits.reset());

describe("429 texts", () => {
  it("«повторите через ⌈N⌉ с» with retry_after, «чуть позже» without; RU and EN", () => {
    expect(errorText(new ApiError(429, "RATE_LIMITED", "x", { policy: "tg.offers", retry_after: 12.2 }), tr("ru"), mmss)).toBe("Слишком много запросов — повторите через 13 с");
    expect(errorText(new ApiError(429, "RATE_LIMITED", "x", {}), tr("ru"), mmss)).toBe("Слишком много запросов — повторите чуть позже");
    expect(errorText(new ApiError(429, "RATE_LIMITED", "x", { retry_after: 1 }), tr("en"), mmss)).toBe("Too many requests — try again in 1 s");
    expect(errorText(new ApiError(429, "RATE_LIMITED", "x", {}), tr("en"), mmss)).toBe("Too many requests — try again a little later");
  });
  it("503 RATE_LIMIT_UNAVAILABLE — «Сервис временно перегружен»", () => {
    expect(errorText(new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "x"), tr("ru"), mmss)).toBe("Сервис временно перегружен. Повторите через минуту");
    expect(errorText(new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "x"), tr("en"), mmss)).toBe("The service is temporarily overloaded. Try again in a minute");
  });
});

describe("Retry-After and the waits by policy", () => {
  it("parses delta-seconds and an HTTP date; garbage / zero → null", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("1.5")).toBe(1.5);
    const now = Date.parse("2026-10-17T10:00:00Z");
    expect(parseRetryAfter("Sat, 17 Oct 2026 10:00:20 GMT", now)).toBe(20);
    for (const bad of [null, "", "0", "-3", "soon", "Sat, 17 Oct 2026 09:59:00 GMT"]) expect(parseRetryAfter(bad as string | null, now)).toBeNull();
  });
  it("a wait counts for its policy and for tg.user (every action); a 429 without a policy — for the screen's own scope", () => {
    const now = 1_000_000;
    rateLimits.note(new ApiError(429, "RATE_LIMITED", "x", { policy: "tg.offers", retry_after: 4.2 }), undefined, now);
    expect(rateLimits.left(["tg.offers"], now)).toBe(5);
    expect(rateLimits.left(["tg.ai"], now)).toBe(0);
    expect(rateLimits.left(["tg.offers"], now + 5000)).toBe(0);
    rateLimits.note(new ApiError(429, "RATE_LIMITED", "x", { retry_after: 3 }), "tg.pin", now);
    expect(rateLimits.left(["tg.pin"], now)).toBe(3);
    rateLimits.note(new ApiError(429, "RATE_LIMITED", "x", { policy: "tg.user", retry_after: 9 }), undefined, now);
    expect(rateLimits.left(["tg.ai"], now)).toBe(9);
    // not a 429 / no wait — nothing to wait for
    expect(rateLimits.note(new ApiError(503, "SERVICE_UNAVAILABLE", "x"), "tg.ai", now)).toBe(false);
    expect(rateLimitWait(new ApiError(429, "RATE_LIMITED", "x"))).toBeNull();
  });
});

describe("ApiClient: 429 / 503 from telegram-bff", () => {
  const session: SessionResponse = {
    access_token: "acc-1",
    expires_in: 900,
    refresh_token: "ref-1",
    user: { user_id: "u", display_name: "Igor", username: null, locale: "ru", status: "ACTIVE", is_new: false },
    security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null },
    consent: { accepted: true, policy_version: "1.0", current_policy_version: "1.0", accepted_at: null, evidence_hash: null, age_confirmed_18_plus: true },
    onboarding_completed: true,
  };
  function setup(res: () => Response) {
    const conn: boolean[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/v1/session/telegram") ? new Response(JSON.stringify(session), { status: 200, headers: { "Content-Type": "application/json" } }) : res(),
    ) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "https://bff.test", fetchImpl, storage: null, lang: () => "ru", hooks: { onConnectivity: (ok) => conn.push(ok) } });
    return { client, api: createApi(client), conn, fetchImpl };
  }

  it("the wait comes from Retry-After when the body has none; the policy wait is remembered; no automatic repeat", async () => {
    const { client, api, fetchImpl } = setup(
      () => new Response(JSON.stringify({ code: "RATE_LIMITED", message: "m", trace_id: "t", details: { policy: "tg.offers" } }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "7" } }),
    );
    await client.startSession("init");
    const e = await api.offers.get("e1", 1).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).retryAfter).toBe(7);
    expect(rateLimits.left(["tg.offers"])).toBe(7);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // the session + one request: nothing repeated
  });

  it("503 RATE_LIMIT_UNAVAILABLE is the BFF answering — not «Нет связи»", async () => {
    const { client, api, conn } = setup(() => new Response(JSON.stringify({ code: "RATE_LIMIT_UNAVAILABLE", message: "m", trace_id: "t", details: {} }), { status: 503, headers: { "Content-Type": "application/json" } }));
    await client.startSession("init");
    await expect(api.offers.get("e1", 1)).rejects.toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE" });
    expect(conn.at(-1)).toBe(true);
  });
});

describe("the concierge's own 429 error keeps its wait", () => {
  it("retry_after of the error event → error.wait", () => {
    const a = applyEvent(newAnswer("a"), { event: "error", data: { turn_id: null, code: "RATE_LIMITED", message: "", retryable: true, quota_refunded: true, retry_after: 21 } as never });
    expect(a.error).toEqual({ code: "RATE_LIMITED", retryable: true, wait: 21 });
  });
});
