import { describe, expect, it } from "vitest";
import { needsOnboarding, parseStartParam } from "../src/tg/deeplink";

describe("parseStartParam (start_param / startapp)", () => {
  it("inv_<token> → invitation by token", () => {
    expect(parseStartParam("inv_FamTok0123456789abcdefghijklmnop")).toEqual({ kind: "invite", token: "FamTok0123456789abcdefghijklmnop" });
  });
  it("invite_<uuid> → preview of an invitation already opened (lower-cased id)", () => {
    expect(parseStartParam("invite_33333333-AAAA-4bbb-8ccc-0000000000aa")).toEqual({ kind: "invitePreview", inviteId: "33333333-aaaa-4bbb-8ccc-0000000000aa" });
    expect(parseStartParam("invite_not-a-uuid")).toBeNull();
  });
  it("gc_<token> → parent consent (32-byte base64url token)", () => {
    const token = "GcTok0123456789abcdefghijklmnopqrstuvwxyzAB";
    expect(parseStartParam(`gc_${token}`)).toEqual({ kind: "guardian", token });
  });
  it("ticket_TCK-NNNN → support ticket, normalised", () => {
    expect(parseStartParam("ticket_tck-3082")).toEqual({ kind: "ticket", number: "TCK-3082" });
    expect(parseStartParam("ticket_3082")).toBeNull();
  });
  it("route_<route> → only routes of the release-notes catalogue", () => {
    expect(parseStartParam("route_schedule")).toEqual({ kind: "route", route: "schedule" });
    expect(parseStartParam("route_family")).toEqual({ kind: "route", route: "family" });
    expect(parseStartParam("route_admin")).toBeNull();
    expect(parseStartParam("route_")).toBeNull();
  });
  it("rejects anything outside Telegram's alphabet or too short / long tokens", () => {
    for (const bad of [null, undefined, "", "   ", "inv_", "inv_short", "inv_<script>", "javascript:alert(1)", "https://evil.example", "gc_" + "a".repeat(61), "x".repeat(65), "home"]) {
      expect(parseStartParam(bad as string | null | undefined)).toBeNull();
    }
  });
  it("tickets and routes wait for the finished onboarding; invitations and consents do not", () => {
    expect(needsOnboarding({ kind: "route", route: "home" })).toBe(true);
    expect(needsOnboarding({ kind: "ticket", number: "TCK-1" })).toBe(true);
    expect(needsOnboarding({ kind: "invite", token: "x".repeat(10) })).toBe(false);
    expect(needsOnboarding({ kind: "guardian", token: "x".repeat(10) })).toBe(false);
  });
});
