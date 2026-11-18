import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors";
import { I18nProvider, pluralForm } from "../src/i18n";
import { ru } from "../src/i18n/ru";
import { en } from "../src/i18n/en";
import { errText } from "../src/ui/errors";
import { RunbookLink, alertTarget, alertText, subjectText } from "../src/screens/monitoring/Alerts";
import {
  OVERRIDE_TTL_HOURS,
  ackShare,
  expiresAt,
  limitTone,
  parseDelRoute,
  parseMonRoute,
  perMinute,
  rejectShare,
  tooStrict,
  windowUnit,
  loosens,
  tooLoose,
} from "../src/screens/monitoring/ops";
import { COMMAND_SCOPE, fallbackPolicy, LOGIN_SCOPE, rateLimits } from "../src/lib/rateLimit";
import { runbookHref } from "../src/lib/url";

/* Sprint 9 (Q4): limits and deletions helpers, new alert kinds, «Runbook», one 429 text, SEC-12 headers of the static. */

afterEach(cleanup);

const i18n = (lang: "ru" | "en" = "ru") => {
  const d = (lang === "ru" ? ru : en) as Record<string, string>;
  return {
    t: (k: string, v?: Record<string, string | number>) => (d[k] ?? k).replace(/\{(\w+)\}/g, (_, n: string) => String(v?.[n] ?? `{${n}}`)),
    tp: (k: string, n: number) => pluralForm(lang, n, d[k] ?? k),
    fmt: { pct: (x: number) => `${x.toFixed(1)} %` },
  } as unknown as Parameters<typeof alertText>[0];
};
const UUID = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("routes", () => {
  it("#/monitoring/limits[/policy] — the policy drawer has a readable hash, garbage is dropped", () => {
    expect(parseMonRoute("limits")).toEqual({ tab: "limits", provider: null, policy: null });
    expect(parseMonRoute("limits/tg.user")).toEqual({ tab: "limits", provider: null, policy: "tg.user" });
    expect(parseMonRoute("limits/<script>").policy).toBeNull();
    expect(parseMonRoute(`limits/${"a".repeat(80)}`).policy).toBeNull();
    // the policy belongs to the limits tab only
    expect(parseMonRoute("providers/tg.user").policy).toBeNull();
  });

  it("#/users/deletions[/filter|/request_id]", () => {
    expect(parseDelRoute(null)).toEqual({ deletions: false, filter: "open", open: null });
    expect(parseDelRoute(UUID)).toEqual({ deletions: false, filter: "open", open: null }); // a user card, not a deletion
    expect(parseDelRoute("deletions")).toEqual({ deletions: true, filter: "open", open: null });
    expect(parseDelRoute("deletions/stuck")).toEqual({ deletions: true, filter: "stuck", open: null });
    expect(parseDelRoute("deletions/all").filter).toBe("all");
    expect(parseDelRoute(`deletions/${UUID.toUpperCase()}`)).toEqual({ deletions: true, filter: "open", open: UUID });
    expect(parseDelRoute("deletions/nonsense")).toEqual({ deletions: true, filter: "open", open: null });
  });
});

describe("limits", () => {
  it("rate in requests per minute, the protective minimum of fail: closed (422 RATE_LIMIT_TOO_STRICT)", () => {
    expect(perMinute(120, 60)).toBe(120);
    expect(perMinute(10, 3600)).toBeCloseTo(0.1667, 3);
    expect(tooStrict("closed", 10, 3600)).toBe(true);
    expect(tooStrict("closed", 1, 60)).toBe(false);
    expect(tooStrict("open", 1, 86_400)).toBe(false); // fail: open — no lockout, the server allows it
  });

  it("fail: closed: loosening ≤ ×10 of the default (rate and burst, integers like ops-monitor); fail: open — no ceiling", () => {
    const d = { limit: 10, window_s: 60, burst: 10 };
    expect(loosens(d, 10, 60, null)).toBe(false);
    expect(loosens(d, 11, 60, null)).toBe(true);
    expect(loosens(d, 10, 60, 11)).toBe(true);
    expect(loosens(d, 5, 60, null)).toBe(false);
    expect(tooLoose("closed", d, 100, 60, null)).toBe(false);
    expect(tooLoose("closed", d, 101, 60, null)).toBe(true);
    expect(tooLoose("closed", d, 10, 6, null)).toBe(false); // 100 / min — exactly ×10
    expect(tooLoose("closed", d, 6000, 3600, null)).toBe(true); // an hour with burst = limit lets 6000 at once
    expect(tooLoose("closed", d, 6000, 3600, 100)).toBe(false);
    expect(tooLoose("open", d, 1_000_000, 60, null)).toBe(false);
  });

  it("row tone: failclosed → bad, ≥ 10 % rejected → warn, no traffic → neutral", () => {
    expect(rejectShare({ allowed: 0, rejected: 0 })).toBeNull();
    expect(rejectShare({ allowed: 90, rejected: 10 })).toBeCloseTo(0.1);
    expect(limitTone({ allowed: 0, rejected: 0, failclosed: 0 })).toBe("neutral");
    expect(limitTone({ allowed: 100, rejected: 3, failclosed: 0 })).toBe("neutral");
    expect(limitTone({ allowed: 90, rejected: 10, failclosed: 0 })).toBe("warn");
    expect(limitTone({ allowed: 100, rejected: 0, failclosed: 2 })).toBe("bad");
  });

  it("window in words and the override term", () => {
    expect(windowUnit(60)).toEqual({ unit: "min", n: 1 });
    expect(windowUnit(3600)).toEqual({ unit: "h", n: 1 });
    expect(windowUnit(86_400)).toEqual({ unit: "d", n: 1 });
    expect(windowUnit(45)).toEqual({ unit: "s", n: 45 });
    expect(OVERRIDE_TTL_HOURS).toContain(null);
    const now = Date.parse("2026-10-17T10:00:00Z");
    expect(expiresAt(now, 24)).toBe("2026-10-18T10:00:00Z");
    expect(expiresAt(now, null)).toBeUndefined();
  });
});

describe("deletions", () => {
  it("progress of domain acknowledgements", () => {
    expect(ackShare({ acked: 8, expected: 9 })).toBeCloseTo(8 / 9);
    expect(ackShare({ acked: 0, expected: 0 })).toBe(1);
    expect(ackShare({ acked: 10, expected: 9 })).toBe(1);
  });
});

describe("alerts of sprint 9", () => {
  const a = (kind: string, params: Record<string, unknown>, subject_type = "service", subject = "news") =>
    ({ kind, params, subject_type, subject }) as unknown as Parameters<typeof alertText>[1];

  it("words for the new kinds, codes and numbers only", () => {
    const i = i18n();
    expect(alertText(i, a("service_down", { down_s: 420 }))).toContain("7");
    expect(alertText(i, a("service_down", {}))).not.toContain("{");
    const stuck = alertText(i, a("deletion_stuck", { stuck: 1, open: 3, pending_by_domain: { watch: 1, news: 2 } }, "deletion", "identity-consent"));
    expect(stuck).toContain("news ×2, watch ×1");
    expect(alertText(i, a("rate_limit_spike", { rejected: 184, share: 0.14, subjects: 9 }, "ratelimit", "tg.user"))).toContain("184");
    expect(alertText(i, a("rate_limit_unavailable", { failclosed: 5, policies: 2 }, "ratelimit", "redis"))).toContain("5");
    expect(alertText(i, a("rate_limit_unavailable", { policies: 2 }, "ratelimit", "redis"))).not.toContain("{");
    for (const lang of ["ru", "en"] as const)
      for (const k of ["service_down", "deletion_stuck", "rate_limit_spike", "rate_limit_unavailable"]) expect(alertText(i18n(lang), a(k, {}))).not.toMatch(/\{\w+\}|mon\.at\./);
    expect(subjectText(i, "ratelimit", "tg.user")).toContain("tg.user");
    expect(subjectText(i, "ratelimit", "redis")).not.toBe("redis");
    expect(subjectText(i, "deletion", "identity-consent")).not.toBe("identity-consent");
  });

  it("«Open» leads to the place: a policy, the limits tab, stuck deletions", () => {
    expect(alertTarget("ratelimit", "tg.user")).toEqual({ page: "monitoring", id: "limits/tg.user" });
    expect(alertTarget("ratelimit", "redis")).toEqual({ page: "monitoring", id: "limits" });
    expect(alertTarget("deletion", "identity-consent")).toEqual({ page: "users", id: "deletions/stuck" });
    expect(alertTarget("provider", "aviasales")).toEqual({ page: "monitoring", id: "providers/aviasales" });
    expect(alertTarget("service", "news")).toEqual({ page: "monitoring", id: "queues" });
  });

  it("«Runbook»: https only, a new tab without opener and referrer", () => {
    const { container } = render(
      <I18nProvider initial="ru">
        <RunbookLink url="https://docs.example/runbooks/RUNBOOK.md#news" testId="rb" />
        <RunbookLink url="http://docs.example/x" testId="rb-http" />
        <RunbookLink url="javascript:alert(1)" testId="rb-js" />
        <RunbookLink url={null} testId="rb-null" />
      </I18nProvider>,
    );
    const link = screen.getByTestId("rb");
    expect(link.getAttribute("href")).toBe("https://docs.example/runbooks/RUNBOOK.md#news");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("Runbook");
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });
});

describe("429 RATE_LIMITED", () => {
  it("a stored error text has no frozen seconds — the live countdown is <RateWaitNotice> (review of sprint 9)", () => {
    const i = i18n();
    const e = new ApiError(429, { code: "RATE_LIMITED", message: "x", details: { retry_after: 11.2 } } as never);
    expect(errText(i, e)).toBe("Слишком много запросов — подождите немного и повторите");
    const en9 = errText(i18n("en"), e);
    expect(en9).not.toMatch(/[а-яё]/i);
    expect(errText(i, new ApiError(429, { code: "RATE_LIMITED", message: "x", details: {} } as never))).not.toContain("{");
  });

  it("the wait is noted under the policy (fallback by request), held by adm.staff for every scope, ends by itself", () => {
    rateLimits.reset();
    const now = Date.now();
    const cmd = new ApiError(429, { code: "RATE_LIMITED", message: "x", details: { retry_after: 12, policy: "adm.command" } } as never);
    expect(rateLimits.note(cmd, "adm.staff", now)).toBe(true);
    expect(rateLimits.left(COMMAND_SCOPE, now)).toBe(12);
    expect(rateLimits.left(LOGIN_SCOPE, now)).toBe(0);
    expect(rateLimits.note(new ApiError(409, { code: "X", message: "x" } as never), "adm.staff", now)).toBe(false);
    rateLimits.note(new ApiError(429, { code: "RATE_LIMITED", message: "x", details: { retry_after: 5 } } as never), fallbackPolicy("GET", "/users"), now);
    expect(rateLimits.left(LOGIN_SCOPE, now)).toBe(5); // adm.staff — everywhere
    expect(rateLimits.left(COMMAND_SCOPE, now + 13_000)).toBe(0);
    expect(fallbackPolicy("POST", "/auth/login")).toBe("adm.login_ip");
    expect(fallbackPolicy("POST", "/ops/dlq/replay")).toBe("adm.command");
    rateLimits.reset();
  });
});

describe("SEC-12: headers of the admin static (Caddy)", () => {
  const caddy = readFileSync(resolve(__dirname, "../Caddyfile"), "utf8");
  const header = (name: string) => new RegExp(`^\\s*${name}\\s+"([^"]+)"`, "m").exec(caddy)?.[1] ?? null;

  it("CSP without inline/eval, no framing; HSTS, nosniff, Referrer-Policy, COOP/CORP", () => {
    const csp = header("Content-Security-Policy");
    expect(csp).toBeTruthy();
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(header("Strict-Transport-Security")).toMatch(/max-age=\d{7,}/);
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("Referrer-Policy")).toMatch(/^(no-referrer|same-origin|strict-origin-when-cross-origin)$/);
    expect(header("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(header("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(caddy).toMatch(/^\s*-Server\s*$/m);
  });

  it("API answers are not cached", () => {
    expect(caddy).toMatch(/handle \/admin\/v1\/\* \{\s*header Cache-Control "no-store"/);
  });
});


describe("Runbook link only inside the runbook section (review of sprint 9)", () => {
  const base = "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/";
  it("host, normalised path under the section, no query or encoded dots", () => {
    expect(runbookHref(`${base}nats.md#nats-down`, base)).toBe(`${base}nats.md#nats-down`);
    expect(runbookHref(`${base}../../../../evil/phish.md`, base)).toBeNull();
    expect(runbookHref(`${base}%2e%2e/x.md`, base)).toBeNull();
    expect(runbookHref("https://github.com/someone/else/blob/main/docs/runbooks/a.md", base)).toBeNull();
    expect(runbookHref("https://evil.example/igorsh0981-gif/tilhero/blob/main/docs/runbooks/a.md", base)).toBeNull();
    expect(runbookHref(`${base}a.md?x=1`, base)).toBeNull();
    expect(runbookHref("javascript:alert(1)", base)).toBeNull();
    expect(runbookHref(base, base)).toBeNull();
    expect(runbookHref(`${base}a.md`, undefined)).toBe(`${base}a.md`); // older admin-bff: https only
  });
});
