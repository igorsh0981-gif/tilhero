import { afterEach, describe, expect, it } from "vitest";
import type { Approval, StaffTicketSummary } from "@tilhero/contracts/admin";
import { idleState } from "../src/state/activity";
import { translate } from "../src/i18n";
import { initials, shortId, uuid } from "../src/lib/ids";
import { REDACTED, redactSecrets } from "../src/lib/redact";
import { liveSla, sortQueue, STAFF_TRANSITIONS } from "../src/screens/support/sla";
import { passwordRules, passwordScore } from "../src/screens/auth/PasswordFields";
import { appliedTokenNames, applyConfigTokens, clearConfigTokens, layoutFromPayload, sanitizeTokens, tokensFromPayload, validToken } from "../src/theme/config";
import { nextVersion, payloadChanges, type AdminPayload, type MiniPayload } from "../src/screens/config/Config";
import { approvalLabel } from "../src/screens/roles/Roles";
import { actionSeverity, compact, dayBound } from "../src/screens/audit/Audit";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const tk = (over: Partial<StaffTicketSummary>): StaffTicketSummary => ({
  ticket_id: "t",
  number: "TCK-1",
  user_id: null,
  channel: "telegram",
  category: "OTHER",
  subject: "s",
  status: "NEW",
  priority: "normal",
  assignee_id: null,
  assignee_name: null,
  has_context: false,
  anonymized: false,
  created_at: "2026-10-09T10:00:00Z",
  updated_at: "2026-10-09T10:00:00Z",
  last_message_at: "2026-10-09T10:00:00Z",
  first_response_at: null,
  sla_first_response_at: "2026-10-09T13:00:00Z",
  sla_resolution_at: "2026-10-09T20:00:00Z",
  sla_target: "first_response",
  sla_due_at: "2026-10-09T13:00:00Z",
  sla_state: "ok",
  sla_paused: false,
  ...over,
});

describe("live SLA", () => {
  it("counts down locally and flips to soon / over", () => {
    expect(liveSla(tk({}), NOW)).toEqual({ state: "ok", left: 3_600_000 });
    expect(liveSla(tk({ sla_due_at: "2026-10-09T12:20:00Z" }), NOW).state).toBe("soon");
    expect(liveSla(tk({ sla_due_at: "2026-10-09T11:55:00Z" }), NOW)).toEqual({ state: "over", left: -300_000 });
    expect(liveSla(tk({ sla_state: "soon" }), NOW).state).toBe("soon"); // the server threshold is kept
  });
  it("pauses while waiting for the customer and is met when resolved", () => {
    expect(liveSla(tk({ status: "WAITING_CUSTOMER", sla_paused: true }), NOW)).toEqual({ state: "paused", left: null });
    expect(liveSla(tk({ status: "RESOLVED", sla_target: null, sla_due_at: null }), NOW).state).toBe("met");
    expect(liveSla(tk({ sla_due_at: "garbage" }), NOW).state).toBe("met");
  });
  it("sorts the queue: breached → nearest deadline → paused → met", () => {
    const items = [
      tk({ number: "met", status: "CLOSED", sla_target: null }),
      tk({ number: "ok", sla_due_at: "2026-10-09T15:00:00Z" }),
      tk({ number: "paused", status: "WAITING_CUSTOMER", sla_paused: true }),
      tk({ number: "over2", sla_due_at: "2026-10-09T11:59:00Z" }),
      tk({ number: "over1", sla_due_at: "2026-10-09T10:00:00Z" }),
      tk({ number: "soon", sla_due_at: "2026-10-09T12:10:00Z" }),
    ];
    expect(sortQueue(items, NOW).map((x) => x.number)).toEqual(["over1", "over2", "soon", "ok", "paused", "met"]);
  });
  it("operator transitions mirror support STAFF_TRANSITIONS", () => {
    expect(STAFF_TRANSITIONS.NEW).toEqual(["IN_PROGRESS"]);
    expect(STAFF_TRANSITIONS.CLOSED).toEqual([]);
  });
});

describe("secret redaction (nothing secret is ever rendered from JSON)", () => {
  it("redacts passwords, codes, secrets, challenges, cookies — deeply", () => {
    const out = redactSecrets({
      temporary_password: "Tmp-1",
      new_password: "x",
      nested: [{ challenge: "abc", code: "123456", csrf_token: "t", otp: { secret: "S" } }],
      uri: "otpauth://totp/x",
      cookie: "__Host-tilhero_admin=abc",
      code: "PERMISSION_DENIED",
      must_change_password: true,
      password_changed_at: null,
      count: 3,
    });
    expect(out).toEqual({
      temporary_password: REDACTED,
      new_password: REDACTED,
      nested: [{ challenge: REDACTED, code: REDACTED, csrf_token: REDACTED, otp: { secret: REDACTED } }],
      uri: REDACTED,
      cookie: REDACTED,
      code: "PERMISSION_DENIED",
      must_change_password: true,
      password_changed_at: null,
      count: 3,
    });
  });
});

describe("ids, idle policy, password rules", () => {
  it("uuid v4, short ids and initials", () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(shortId("0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a01", 8, 4)).toBe("0b6c3e1a…5a01");
    expect(initials("Admin Operator")).toBe("AO");
    expect(initials("Сергей (подрядчик)")).toBe("СП");
    expect(initials("  ")).toBe("?");
  });
  it("warns 2 minutes before the idle timeout, expires at 0, heartbeats an active reader", () => {
    const t0 = 1_000_000;
    expect(idleState(t0 + 27 * 60_000, t0, t0, 1800).warn).toBe(false);
    const w = idleState(t0 + 28.5 * 60_000, t0, t0, 1800);
    expect(w.warn).toBe(true);
    expect(w.left).toBe(90_000);
    expect(idleState(t0 + 30 * 60_000, t0, t0, 1800).expired).toBe(true);
    expect(idleState(t0 + 6 * 60_000, t0 + 6 * 60_000 - 1000, t0, 1800).heartbeat).toBe(true);
  });
  it("password rules and score", () => {
    expect(passwordRules("Blue-Sky-Over-7x", "igor@tilhero.local").every((r) => r.ok)).toBe(true);
    expect(passwordRules("onlyletterslong", "a@b.c").find((r) => r.id === "mix")!.ok).toBe(false);
    expect(passwordRules("igor-is-here-12", "igor@tilhero.local").find((r) => r.id === "email")!.ok).toBe(false);
    expect(passwordScore("")).toBe(0);
    expect(passwordScore("Blue-Sky-Over-Tashkent-7")).toBe(4);
  });
});

describe("admin theme tokens from experience-config (TilHero whitelist)", () => {
  afterEach(() => clearConfigTokens());
  it("accepts only whitelisted tokens with safe values", () => {
    expect(validToken("--pen", "#2F4BE0")).toBe(true);
    expect(validToken("--side", "rgba(28,35,64,.9)")).toBe(true);
    expect(validToken("--pen", "url(javascript:alert(1))")).toBe(false);
    expect(validToken("--pen", "red;}body{display:none")).toBe(false);
    expect(validToken("--pen", "rgb(300,0,0)")).toBe(false);
    expect(validToken("--nav-w", "999px")).toBe(false);
    expect(validToken("--nav-w", "15rem")).toBe(false); // px only
    expect(validToken("--nav-w", "236px")).toBe(true);
    expect(validToken("--r-card", "2rem")).toBe(true);
    expect(validToken("--r-card", "40px")).toBe(false);
    expect(validToken("--font-ui", "Onest,system-ui,sans-serif")).toBe(true);
    expect(validToken("--font-ui", '"Comic Sans MS",sans-serif')).toBe(false); // not an allowed family
    expect(validToken("--accent", "#fff")).toBe(false); // aievent token — not in the TilHero whitelist
    expect(sanitizeTokens({ "--pen": "#3B5BDB", "--evil": "#000", "--r-btn": "var(--x)" })).toEqual({ "--pen": "#3B5BDB" });
  });
  it("applies colours only in the light scheme; geometry in both", () => {
    const root = document.createElement("div");
    applyConfigTokens(tokensFromPayload({ theme: { tokens: { "--pen": "#3B5BDB", "--r-btn": "12px" } } }), false, root);
    expect(root.style.getPropertyValue("--pen")).toBe("#3B5BDB");
    applyConfigTokens(null, true, root);
    expect(root.style.getPropertyValue("--pen")).toBe("");
    expect(root.style.getPropertyValue("--r-btn")).toBe("12px");
    expect(appliedTokenNames()).toEqual(["--r-btn"]);
  });
  it("reads the admin layout: density and the menu", () => {
    const lay = layoutFromPayload({ layout: { density: "comfortable", menu: [{ id: "support", enabled: true }, { id: "content", enabled: false }, { bogus: 1 }] } });
    expect(lay).toEqual({ density: "comfortable", menu: [{ id: "support", enabled: true }, { id: "content", enabled: false }] });
    expect(layoutFromPayload({ layout: { density: "weird" } })).toEqual({ density: "compact", menu: [] });
    expect(layoutFromPayload(null)).toBeNull();
  });
});

describe("config versions", () => {
  const mini = (): MiniPayload => ({
    theme: { id: "notebook", version: "1.0.0", tokens: { "--pen": "#2F4BE0" } },
    home: { sections: [{ type: "today_plan", key: "today_plan", variant: "large", enabled: true }, { type: "news", key: "news", variant: "compact", enabled: true }] },
    flags: { voice_lesson: false },
  });
  it("suggests the next free patch version", () => {
    expect(nextVersion(["1.0.2", "1.0.10", "1.0.3"])).toBe("1.0.11");
    expect(nextVersion([])).toBe("1.0.0");
  });
  it("lists draft changes", () => {
    const a = mini();
    const b = mini();
    b.home.sections.reverse();
    b.home.sections[0]!.enabled = false;
    b.flags.voice_lesson = true;
    b.theme.tokens["--pen"] = "#3B5BDB";
    expect(payloadChanges("miniapp", a, b)).toEqual(["--pen: #2F4BE0 → #3B5BDB", "home.sections: order", "news: off", "flag voice_lesson: false → true"]);
    const ad: AdminPayload = { theme: { id: "admin_light", version: "1.0.0", tokens: { "--pen": "#2F4BE0" } }, layout: { density: "compact", menu: [{ id: "overview", enabled: true }, { id: "content", enabled: true }] }, flags: {} };
    const ad2: AdminPayload = JSON.parse(JSON.stringify(ad));
    ad2.layout.density = "comfortable";
    ad2.layout.menu[1]!.enabled = false;
    expect(payloadChanges("admin", ad, ad2)).toEqual(["density: compact → comfortable", "menu content: off"]);
  });
});

describe("roles and audit helpers", () => {
  const base = { approval_id: "a", status: "PENDING", reason: "r", requested_by: { staff_id: "s", email: "e", display_name: "N", role: "super_admin" }, requested_at: "", decided_by: null, decided_at: null, decision_note: null, waived: null, expires_at: "" } as const;
  it("summarises four-eyes requests", () => {
    const rn = (r: string) => r.toUpperCase();
    const tr = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate("ru", k, v);
    expect(approvalLabel({ ...base, kind: "role.permissions_change", summary: { role: "support", added: ["support.manage"], removed: ["support.reply"] } } as Approval, rn, tr)).toBe("SUPPORT: +support.manage, −support.reply");
    expect(approvalLabel({ ...base, kind: "staff.role_grant", summary: { staff: { display_name: "Oleg" }, from_role: "support", to_role: "operations" } } as Approval, rn, tr)).toBe("Oleg: SUPPORT → OPERATIONS");
    expect(approvalLabel({ ...base, kind: "staff.privileged_reset", summary: { staff: { display_name: "Нодира" }, action: "password" } } as Approval, rn, tr)).toBe("Нодира: сброс пароля");
    expect(approvalLabel({ ...base, kind: "staff.privileged_reset", summary: { staff: { email: "n@x" }, action: "mfa" } } as Approval, rn, tr)).toBe("n@x: сброс MFA");
    expect(approvalLabel({ ...base, kind: "staff.privileged_revoke", summary: { staff: { display_name: "N" }, from_role: "super_admin", to_role: null, status: "DISABLED" } } as Approval, rn, tr)).toBe("N: Доступ отозван");
    expect(approvalLabel({ ...base, kind: "staff.privileged_revoke", summary: { staff: { display_name: "N" }, from_role: "super_admin", to_role: "read_only", status: null } } as Approval, rn, tr)).toBe("N: SUPER_ADMIN → READ_ONLY");
  });
  it("audit severity, compact before/after, day bounds", () => {
    expect(actionSeverity("sensitive.view")).toBe("crit");
    expect(actionSeverity("auth.login")).toBe("sec");
    expect(actionSeverity("ticket.reply")).toBe("");
    expect(compact({ temporary_password: "x", role: "support" })).toBe('{"temporary_password":"••• redacted","role":"support"}');
    expect(compact(null)).toBe("∅");
    expect(dayBound("2026-10-09", false)).toMatch(/^2026-10-0[89]T/);
    expect(dayBound("bad", true)).toBeUndefined();
  });
});
