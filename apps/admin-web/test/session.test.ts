import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApi } from "../src/api/client";
import { singleFlight } from "../src/lib/singleFlight";
import { useEphemeral } from "../src/lib/useEphemeral";
import { __activityTest, activity, confirmIdle, idleState, shareActivity, warnWindowSeconds } from "../src/state/activity";

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
const errBody = (code: string) => ({ code, message: code, trace_id: "t", details: {} });

describe("background polls (X-Background: 1)", () => {
  it("carry the header and never count as activity / server touch", async () => {
    const { api, calls } = fake([{ status: 200, body: {} }, { status: 200, body: {} }]);
    const touch = vi.fn();
    api.hooks = { onServerTouch: touch };
    await api.get("/support/tickets", { background: true });
    expect((calls[0]!.init.headers as Record<string, string>)["X-Background"]).toBe("1");
    expect(touch).not.toHaveBeenCalled();
    await api.get("/support/tickets");
    expect((calls[1]!.init.headers as Record<string, string>)["X-Background"]).toBeUndefined();
    expect(touch).toHaveBeenCalledTimes(1);
  });
});

describe("a lost session inside auth endpoints goes to the sign-in screen", () => {
  it("in-session password change / step-up with 401 SESSION_EXPIRED → onSessionLost (not a form error)", async () => {
    const { api } = fake([
      { status: 401, body: errBody("SESSION_EXPIRED") },
      { status: 401, body: errBody("SESSION_REVOKED") },
      { status: 401, body: errBody("INVALID_CREDENTIALS") },
      { status: 401, body: errBody("MFA_INVALID") },
    ]);
    const lost = vi.fn();
    api.hooks = { onSessionLost: lost };
    await expect(api.post("/auth/password", { current_password: "a", new_password: "b" })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(api.post("/auth/step-up", { code: "123456" })).rejects.toMatchObject({ code: "SESSION_REVOKED" });
    expect(lost).toHaveBeenCalledTimes(2);
    // a wrong current password / code is a form error, the session is fine
    await expect(api.post("/auth/password", { current_password: "x", new_password: "y" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(api.post("/auth/step-up", { code: "000000" })).rejects.toMatchObject({ code: "MFA_INVALID" });
    expect(lost).toHaveBeenCalledTimes(2);
  });
});

describe("step-up: one prompt for concurrent commands", () => {
  it("singleFlight shares the pending promise and starts a new one after it settles", async () => {
    let resolve!: (v: boolean) => void;
    const start = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    const f = singleFlight(start);
    const a = f();
    const b = f();
    expect(a).toBe(b);
    resolve(true);
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
    void f();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("two requests answered 403 STEP_UP_REQUIRED at once: one dialog, both retried, none hangs", async () => {
    const { api, calls } = fake([
      { status: 403, body: errBody("STEP_UP_REQUIRED") },
      { status: 403, body: errBody("STEP_UP_REQUIRED") },
      { status: 200, body: { n: 1 } },
      { status: 200, body: { n: 2 } },
    ]);
    let open = 0;
    let confirm!: (ok: boolean) => void;
    api.hooks = {
      onStepUp: singleFlight(() => {
        open += 1;
        return new Promise<boolean>((r) => (confirm = r));
      }),
    };
    const p1 = api.post("/staff/a/reset-password", { reason: "r1" });
    const p2 = api.post("/staff/b/reset-password", { reason: "r2" });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await vi.waitFor(() => expect(open).toBe(1));
    await new Promise((r) => setTimeout(r, 20)); // both refusals are waiting on the same prompt
    confirm(true);
    await expect(Promise.all([p1, p2])).resolves.toHaveLength(2);
    expect(open).toBe(1);
    expect(calls).toHaveLength(4);
  });
});

describe("shared idle timer across tabs (BroadcastChannel, timestamps only)", () => {
  afterEach(() => __activityTest.reset());

  it("a peer's activity moves this tab's timer; junk and future times are ignored", () => {
    __activityTest.reset(1_000);
    __activityTest.accept({ t: 5_000 }, 10_000);
    expect(activity.user).toBe(5_000);
    __activityTest.accept({ t: 4_000 }, 10_000); // older — ignored
    __activityTest.accept({ t: 99_999 }, 10_000); // far future — ignored
    __activityTest.accept({ t: "x" }, 10_000);
    __activityTest.accept(null, 10_000);
    expect(activity.user).toBe(5_000);
  });

  it("messages from another tab arrive over the channel, and an idle check asks the peers", async () => {
    const leave = shareActivity();
    const peer = new BroadcastChannel("tilhero.admin.activity");
    const seen: unknown[] = [];
    peer.onmessage = (e) => seen.push(e.data);
    try {
      __activityTest.reset(Date.now() - 60 * 60_000);
      const t = Date.now();
      peer.postMessage({ t });
      await vi.waitFor(() => expect(activity.user).toBe(t));
      // the local touch is shared (throttled) — only a number goes out
      activity.touch(t + 2_000);
      await vi.waitFor(() => expect(seen).toContainEqual({ t: t + 2_000 }));
      // before an idle sign-out the tab asks the others; a peer answers with its later time
      peer.onmessage = (e) => {
        if ((e.data as { ask?: boolean }).ask) peer.postMessage({ t: t + 3_000 });
      };
      await expect(confirmIdle(150)).resolves.toBe(t + 3_000);
      expect(seen.every((m) => Object.keys(m as object).every((k) => k === "t" || k === "ask"))).toBe(true);
    } finally {
      peer.close();
      leave();
    }
  });

  it("warning window is 2 minutes (a third of very short test timeouts)", () => {
    expect(warnWindowSeconds(1800)).toBe(120);
    expect(warnWindowSeconds(12)).toBe(4);
    const t0 = 1_000_000;
    expect(idleState(t0 + 9_000, t0, t0, 12).warn).toBe(true);
    expect(idleState(t0 + 7_000, t0, t0, 12).warn).toBe(false);
  });
});

describe("one-time secret on screen", () => {
  afterEach(() => vi.useRealTimers());

  it("is dropped after 60 s", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useEphemeral<string>());
    act(() => result.current[1]("Tmp-1"));
    expect(result.current[0]).toBe("Tmp-1");
    expect(result.current[2]).toBeGreaterThan(59_000);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(result.current[0]).toBe("Tmp-1");
    act(() => void vi.advanceTimersByTime(31_000));
    expect(result.current[0]).toBeNull();
  });

  it("is dropped when the browser tab is hidden or the page is left", () => {
    const { result } = renderHook(() => useEphemeral<string>());
    act(() => result.current[1]("Tmp-2"));
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current[0]).toBeNull();
    vis.mockRestore();
    act(() => result.current[1]("Tmp-3"));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(result.current[0]).toBeNull();
  });
});

describe("409 SESSION_ROTATED (the session id was rotated in another tab)", () => {
  it("re-reads Me (new CSRF) and repeats the request once with the same Idempotency-Key — no sign-out", async () => {
    const { api, calls } = fake([
      { status: 409, body: errBody("SESSION_ROTATED") },
      { status: 200, body: { csrf_token: "csrf-new" } },
      { status: 200, body: { ok: true } },
    ]);
    api.setCsrf("csrf-old");
    const lost = vi.fn();
    const onMe = vi.fn();
    api.hooks = { onSessionLost: lost, onMe };
    await expect(api.post("/support/tickets/x/messages", { text: "hi", visibility: "public" }, { idempotencyKey: "k-1" })).resolves.toEqual({ ok: true });
    const h = (k: number) => calls[k]!.init.headers as Record<string, string>;
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(["POST /admin/v1/support/tickets/x/messages", "GET /admin/v1/me", "POST /admin/v1/support/tickets/x/messages"]);
    expect(h(0)["X-CSRF-Token"]).toBe("csrf-old");
    expect(h(2)["X-CSRF-Token"]).toBe("csrf-new");
    expect(h(2)["Idempotency-Key"]).toBe("k-1");
    expect(onMe).toHaveBeenCalledWith({ csrf_token: "csrf-new" });
    expect(lost).not.toHaveBeenCalled();
  });

  it("only one repeat: a second rotation is an error, not a loop", async () => {
    const { api, calls } = fake([
      { status: 409, body: errBody("SESSION_ROTATED") },
      { status: 200, body: { csrf_token: "c2" } },
      { status: 409, body: errBody("SESSION_ROTATED") },
    ]);
    await expect(api.get("/users")).rejects.toMatchObject({ code: "SESSION_ROTATED" });
    expect(calls).toHaveLength(3);
  });
});
