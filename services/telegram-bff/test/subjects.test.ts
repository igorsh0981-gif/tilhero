/**
 * Субъект внутреннего JWT (INTERNAL_API §9, CONVENTIONS §8): к учебным доменам (learning-plan, центр уведомлений,
 * experience-config for-me / seen / feed) — sub = активный ученик (lrn); к identity-consent /me/*, social и support —
 * sub = аккаунт. Матрица по всем маршрутам — в профиле аккаунта и в детском профиле.
 */
import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { bearer, closeRedis, login, makeHarness, switchTo, type Call, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let parent: LoggedIn;
let childId: string;
beforeEach(async () => {
  h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "1000" });
  parent = await login(h);
  h.fake.setAge(parent.userId, "18+");
  childId = h.fake.addChild(parent.userId, "Мадина", "6-9");
  h.fake.onboard(parent.userId);
  h.fake.onboard(childId);
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

type Probe = { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; url: string; payload?: object; idem?: boolean; listsLearners?: boolean };

/** Маршруты, доступные и в детском профиле. listsLearners — learning-plan опрашивается по каждому ученику аккаунта. */
const COMMON: Probe[] = [
  { method: "GET", url: "/v1/profile", listsLearners: true },
  { method: "PATCH", url: "/v1/profile/settings", payload: { notifications: { categories: { reminders: true } } }, listsLearners: true },
  { method: "GET", url: "/v1/learners", listsLearners: true },
  { method: "POST", url: "/v1/profile/guardian-consent" },
  { method: "GET", url: "/v1/plan" },
  { method: "PATCH", url: "/v1/plan", payload: { schedule: { days: [1, 3, 5], preset: "three_per_week" } } },
  { method: "POST", url: "/v1/plan/onboarding/complete" },
  { method: "GET", url: "/v1/plan/today" },
  { method: "POST", url: "/v1/plan/activity", payload: { kind: "practice", minutes: 10 }, idem: true },
  { method: "GET", url: "/v1/directory/goals" },
  { method: "GET", url: "/v1/directory/topics" },
  { method: "GET", url: "/v1/notifications" },
  { method: "GET", url: "/v1/notifications/unread-count" },
  { method: "POST", url: "/v1/notifications/read", payload: { all: true } },
  { method: "GET", url: "/v1/whats-new" },
  { method: "POST", url: "/v1/whats-new/seen", payload: { release_note_ids: [randomUUID()] } },
  { method: "GET", url: "/v1/news" },
  { method: "GET", url: "/v1/family" },
  { method: "GET", url: "/v1/support/categories" },
];

/** Только в профиле аккаунта (в детском — 403). */
const ACCOUNT_ONLY: Probe[] = [
  { method: "POST", url: "/v1/learners", payload: { display_name: "Тимур", age_band: "10-13" } },
  { method: "POST", url: "/v1/invites", payload: { kind: "family" }, idem: true },
  { method: "GET", url: "/v1/invites" },
  { method: "POST", url: "/v1/invites/open", payload: { token: "Q".repeat(32) } },
  { method: "POST", url: "/v1/support/tickets", payload: { category: "OTHER", subject: "Вопрос", message: "Текст" }, idem: true },
  { method: "GET", url: "/v1/support/tickets" },
  { method: "POST", url: `/v1/guardian-consents/${"Q".repeat(43)}/accept` },
  { method: "PUT", url: "/v1/profile/security/pin", payload: { pin: "4826" } },
  // ревью T-5: возраст и согласия — свойства аккаунта родителя
  { method: "PUT", url: "/v1/profile/age", payload: { age_band: "18+" } },
  { method: "POST", url: "/v1/profile/consent", payload: { policy_version: "2026-11-18", purposes: ["terms", "privacy", "learning"] } },
  { method: "DELETE", url: "/v1/profile/consent" },
  // §11: решения родителя по подросткам
  { method: "GET", url: "/v1/family/guardian-consents" },
  { method: "POST", url: `/v1/family/guardian-consents/${randomUUID()}/revoke` },
];

const ACCOUNT_DOMAINS = new Set(["identity", "social", "support"]);

function checkSubjects(calls: Call[], probe: Probe, accountId: string, learnerId: string, learners: string[]): void {
  expect(calls.length, `${probe.method} ${probe.url}: домен не вызван`).toBeGreaterThan(0);
  for (const c of calls) {
    const where = `${probe.method} ${probe.url} → ${c.service} ${c.method} ${c.path}`;
    // sub в токене совпадает с тем, что увидел домен
    expect(decodeJwt(c.headers["x-internal-token"]!).sub, where).toBe(c.subject);
    if (c.service === "experience" && c.path === "/internal/v1/experience/miniapp/current") {
      expect(c.subject, where).toBeUndefined();
    } else if (ACCOUNT_DOMAINS.has(c.service)) {
      expect(c.subject, where).toBe(accountId);
    } else if (c.service === "learningPlan" && probe.listsLearners) {
      expect(learners, where).toContain(c.subject);
    } else {
      expect(c.subject, where).toBe(learnerId);
    }
  }
}

async function run(token: string, p: Probe) {
  return h.app.inject({
    method: p.method,
    url: p.url,
    headers: { ...bearer(token), ...(p.idem ? { "idempotency-key": randomUUID() } : {}) },
    ...(p.payload ? { payload: p.payload } : {}),
  });
}

describe("матрица sub внутреннего JWT", () => {
  it("профиль аккаунта: lrn = аккаунт — все домены получают аккаунт", async () => {
    for (const p of [...COMMON, ...ACCOUNT_ONLY]) {
      h.fake.calls.length = 0;
      const res = await run(parent.access, p);
      expect(res.statusCode, `${p.method} ${p.url}: ${res.body}`).toBeLessThan(500);
      checkSubjects(h.fake.calls, p, parent.userId, parent.userId, [parent.userId, childId]);
    }
  });

  it("детский профиль: учебные домены — ребёнок, identity/social/support — аккаунт родителя", async () => {
    const child = await switchTo(h, parent, childId);
    for (const p of COMMON) {
      h.fake.calls.length = 0;
      const res = await run(child.access, p);
      expect(res.statusCode, `${p.method} ${p.url}: ${res.body}`).toBeLessThan(500);
      checkSubjects(h.fake.calls, p, parent.userId, childId, [parent.userId, childId]);
      // учебный домен хотя бы раз получил ребёнка там, где он вызывается
      const learning = h.fake.calls.filter((c) => c.service === "notifications" || (c.service === "experience" && c.path.startsWith("/internal/v1/release-notes")));
      for (const c of learning) expect(c.subject).toBe(childId);
    }
  });

  it("детский профиль: команды взрослого и приглашения → 403, домены не вызываются", async () => {
    const child = await switchTo(h, parent, childId);
    for (const p of ACCOUNT_ONLY) {
      h.fake.calls.length = 0;
      const res = await run(child.access, p);
      expect(res.statusCode, `${p.method} ${p.url}`).toBe(403);
      expect(["ADULT_REQUIRED", "INVITES_NOT_ALLOWED"]).toContain(res.json().code);
      expect(h.fake.calls, p.url).toHaveLength(0);
    }
  });
});
