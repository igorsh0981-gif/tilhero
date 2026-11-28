/**
 * Безопасность admin-bff: все сессионные маршруты без cookie → 401, реестр маршрутов = admin.ts, step-up по шапке
 * admin.ts и разделам «Контент и диагностика» и «ИИ, контроль диалогов, затраты», fail-closed регистрация, RBAC до
 * вызова домена (матрица 10 ролей),
 * actor-токен, CSRF и Origin на каждом
 * небезопасном маршруте, лимиты входа и команд, имперсонация (только dev), заголовки ответов, логи без PII и секретов.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PERMISSIONS, PRIVILEGED_ROLES, type LoginStep, type Me, type Permission, type RoleCode } from "@tilhero/contracts/admin";
import { verifyInternalToken } from "@tilhero/ts-common";
import { buildApp } from "../src/app.js";
import { ALL_PERMISSIONS, DEFAULT_ROLE_MATRIX, ROLE_CODES, requirePermission } from "../src/rbac.js";
import { sha256hex } from "../src/sessions.js";
import {
  APPROVAL_ID,
  INTERNAL_SECRET,
  LEARNER_ID,
  ORIGIN,
  PASSWORD_OK,
  TG_FULL,
  TOTP_OK,
  UA,
  avoidWindowEdge,
  browser,
  closeRedis,
  json,
  login,
  loginAs,
  makeHarness,
  redis,
  stepUp,
  testConfig,
  type Harness,
} from "./helpers.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

/** Подставить значения параметров пути (валидные по схеме). */
export function concrete(url: string): string {
  return url
    // спринт 8: двоеточие в пути (`trials::grant-all` — экранированное в find-my-way) — буквально
    .replace("::", "\u0000")
    .replace(":kind", "lesson")
    .replace(":pairId", "ru-en")
    .replace(":app", "admin")
    .replace(":code", "support")
    .replace(":version", "1.0.0")
    .replace(":key", "lesson.reminder")
    .replace(":v", "2")
    .replace(":agentId", "conversation_partner")
    .replace(":modelId", "claude-haiku-5-5")
    .replace(":caseId", "cp-01-correct")
    .replace(/:[A-Za-z]+/g, "5b1f0d0e-1111-4c2b-9a51-0d6c7a1e2f30")
    .replace("\u0000", ":");
}

/** Реестр маршрутов admin.ts (все, что должен обслуживать admin-bff), + dev. */
const CONTRACT_ROUTES = [
  "POST /admin/v1/auth/login",
  "POST /admin/v1/auth/mfa",
  "POST /admin/v1/auth/mfa/enroll/start",
  "POST /admin/v1/auth/mfa/enroll/confirm",
  "POST /admin/v1/auth/password",
  "POST /admin/v1/auth/step-up",
  "POST /admin/v1/auth/logout",
  "GET /admin/v1/me",
  "GET /admin/v1/staff",
  "GET /admin/v1/staff/:id",
  "POST /admin/v1/staff",
  "PATCH /admin/v1/staff/:id",
  "POST /admin/v1/staff/:id/reset-password",
  "POST /admin/v1/staff/:id/reset-mfa",
  "GET /admin/v1/roles",
  "PUT /admin/v1/roles/:code",
  "GET /admin/v1/approvals",
  "POST /admin/v1/approvals/:id/approve",
  "POST /admin/v1/approvals/:id/reject",
  "GET /admin/v1/learners",
  "GET /admin/v1/learners/:id",
  "POST /admin/v1/learners/:id/reveal",
  "GET /admin/v1/dashboard",
  "GET /admin/v1/support/tickets",
  "GET /admin/v1/support/tickets/:id",
  "GET /admin/v1/support/tickets/:id/client-view",
  "POST /admin/v1/support/tickets/:id/messages",
  "PATCH /admin/v1/support/tickets/:id",
  "POST /admin/v1/support/tickets/:id/take",
  "POST /admin/v1/support/tickets/:id/escalations",
  "GET /admin/v1/support/stats",
  "GET /admin/v1/support/templates",
  "GET /admin/v1/support/sla-policies",
  "PUT /admin/v1/support/sla-policies",
  "GET /admin/v1/audit/records",
  "GET /admin/v1/audit/records/:id",
  "GET /admin/v1/audit/verify",
  "GET /admin/v1/experience/admin/current",
  "GET /admin/v1/experience/miniapp/current",
  "GET /admin/v1/experience/:app/state",
  "GET /admin/v1/experience/:app/versions",
  "GET /admin/v1/experience/:app/versions/:version",
  "GET /admin/v1/experience/:app/activations",
  "POST /admin/v1/experience/:app/versions",
  "POST /admin/v1/experience/:app/activate",
  "POST /admin/v1/experience/:app/rollback",
  "GET /admin/v1/release-notes",
  "GET /admin/v1/release-notes/:id",
  "GET /admin/v1/release-notes/:id/stats",
  "POST /admin/v1/release-notes",
  "PUT /admin/v1/release-notes/:id",
  "POST /admin/v1/release-notes/:id/publish",
  "POST /admin/v1/release-notes/:id/archive",
  "GET /admin/v1/notifications/templates",
  "GET /admin/v1/notifications/templates/:key",
  "POST /admin/v1/notifications/templates/:key/versions",
  "POST /admin/v1/notifications/templates/:key/versions/:v/preview",
  "POST /admin/v1/notifications/templates/:key/versions/:v/activate",
  "POST /admin/v1/notifications/templates/:key/reset",
  "POST /admin/v1/notifications/templates/:key/versions/:v/test",
  "GET /admin/v1/notifications/test-recipients",
  "GET /admin/v1/notifications/campaigns",
  "GET /admin/v1/notifications/campaigns/:id",
  "POST /admin/v1/notifications/campaigns",
  "PATCH /admin/v1/notifications/campaigns/:id",
  "POST /admin/v1/notifications/campaigns/:id/estimate",
  "POST /admin/v1/notifications/campaigns/:id/preview",
  "POST /admin/v1/notifications/campaigns/:id/test",
  "POST /admin/v1/notifications/campaigns/:id/schedule",
  "POST /admin/v1/notifications/campaigns/:id/unschedule",
  "POST /admin/v1/notifications/campaigns/:id/stop",
  // спринт 3 — контент и диагностика (catalog, diagnostics)
  "GET /admin/v1/content/:kind",
  "GET /admin/v1/content/:kind/:key",
  "GET /admin/v1/content/:kind/:key/versions/:v",
  "POST /admin/v1/content/:kind",
  "POST /admin/v1/content/:kind/:key/versions",
  "PUT /admin/v1/content/:kind/:key/versions/:v",
  "POST /admin/v1/content/:kind/:key/versions/:v/validate",
  "POST /admin/v1/content/:kind/:key/versions/:v/submit",
  "POST /admin/v1/content/:kind/:key/versions/:v/review",
  "POST /admin/v1/content/:kind/:key/versions/:v/publish",
  "POST /admin/v1/content/:kind/:key/archive",
  "POST /admin/v1/content/:kind/:key/rollback",
  "POST /admin/v1/content/scenario/:key/versions/:v/test-run",
  "POST /admin/v1/content/media_asset/:key/versions/:v/rights-approve",
  "POST /admin/v1/content/blobs",
  "GET /admin/v1/content/blobs/:blobId",
  "GET /admin/v1/content/review-queue",
  "GET /admin/v1/content/summary",
  "GET /admin/v1/content/media-requests",
  "POST /admin/v1/content/media-requests/:id/take",
  "POST /admin/v1/content/media-requests/:id/decide",
  "GET /admin/v1/languages",
  "PUT /admin/v1/languages/:code",
  "GET /admin/v1/language-pairs",
  "PUT /admin/v1/language-pairs/:pairId",
  "GET /admin/v1/diagnostics/tests",
  "GET /admin/v1/diagnostics/tests/:id/versions/:v",
  "POST /admin/v1/diagnostics/tests/:id/versions/:v/publish",
  "GET /admin/v1/diagnostics/stats",
  // спринт 4 — агенты и скиллы, модели и затраты (ai-gateway)
  "GET /admin/v1/ai/agents",
  "GET /admin/v1/ai/agents/:agentId",
  "GET /admin/v1/ai/agents/:agentId/versions/:v",
  "POST /admin/v1/ai/agents/:agentId/versions",
  "PATCH /admin/v1/ai/agents/:agentId/versions/:v",
  "DELETE /admin/v1/ai/agents/:agentId/versions/:v",
  "POST /admin/v1/ai/agents/:agentId/versions/:v/test-runs",
  "GET /admin/v1/ai/agents/:agentId/versions/:v/test-runs/:runId",
  "POST /admin/v1/ai/agents/:agentId/versions/:v/publish",
  "PUT /admin/v1/ai/agents/:agentId/canary",
  "DELETE /admin/v1/ai/agents/:agentId/canary",
  "POST /admin/v1/ai/agents/:agentId/rollback",
  "GET /admin/v1/ai/agents/:agentId/golden-cases",
  "POST /admin/v1/ai/agents/:agentId/golden-cases",
  "PATCH /admin/v1/ai/golden-cases/:caseId",
  "DELETE /admin/v1/ai/golden-cases/:caseId",
  "GET /admin/v1/ai/models",
  "PUT /admin/v1/ai/models/:modelId",
  "GET /admin/v1/ai/provider",
  "GET /admin/v1/ai/budget",
  "PUT /admin/v1/ai/budget",
  "POST /admin/v1/ai/emergency-stop",
  "GET /admin/v1/ai/usage/summary",
  "GET /admin/v1/ai/usage",
  // контроль диалогов (lessons, assessment, ai-gateway)
  "GET /admin/v1/qa/sessions",
  "GET /admin/v1/qa/sessions/:id",
  "POST /admin/v1/qa/sessions/:id/transcript",
  "POST /admin/v1/qa/evaluations/:id/flag",
  "POST /admin/v1/qa/evaluations/:id/reevaluate",
  "GET /admin/v1/qa/appeals",
  "POST /admin/v1/qa/appeals/:id/take",
  "POST /admin/v1/qa/appeals/:id/decide",
  // спринт 5 — словарь курса (catalog), память ученика и аналитика забывания (memory)
  "GET /admin/v1/glossary",
  "GET /admin/v1/glossary/stats",
  "GET /admin/v1/glossary/:entryId",
  "POST /admin/v1/glossary",
  "PATCH /admin/v1/glossary/:entryId",
  "POST /admin/v1/glossary/:entryId/review",
  "DELETE /admin/v1/glossary/:entryId",
  "GET /admin/v1/memory/learners/:userId",
  "GET /admin/v1/memory/learners/:userId/cards",
  "GET /admin/v1/memory/cards/:cardId",
  "GET /admin/v1/memory/cards/:cardId/log",
  "POST /admin/v1/memory/cards/:cardId/actions",
  "GET /admin/v1/memory/analytics",
  "GET /admin/v1/memory/stats",
  // спринт 6 — игра и герои (gamification)
  "GET /admin/v1/game/overview",
  "GET /admin/v1/game/rules",
  "GET /admin/v1/game/rules/:version",
  "PUT /admin/v1/game/rules/draft",
  "DELETE /admin/v1/game/rules/draft",
  "POST /admin/v1/game/rules/draft/validate",
  "POST /admin/v1/game/rules/draft/activate",
  "POST /admin/v1/game/rules/:version/rollback",
  "GET /admin/v1/game/heroes",
  "PUT /admin/v1/game/heroes/:code/draft",
  "POST /admin/v1/game/heroes/:code/publish",
  "POST /admin/v1/game/assets",
  "GET /admin/v1/game/assets/:assetId/content",
  "GET /admin/v1/game/shop/items",
  "POST /admin/v1/game/shop/items",
  "PATCH /admin/v1/game/shop/items/:code",
  "POST /admin/v1/game/shop/items/:code/publish",
  "POST /admin/v1/game/shop/items/:code/retire",
  "GET /admin/v1/game/events",
  "POST /admin/v1/game/events",
  "PATCH /admin/v1/game/events/:id",
  "POST /admin/v1/game/events/:id/publish",
  "POST /admin/v1/game/events/:id/cancel",
  "GET /admin/v1/game/wallets/:userId",
  "GET /admin/v1/game/wallets/:userId/ledger",
  "POST /admin/v1/game/wallets/:userId/adjustments",
  "POST /admin/v1/game/wallets/:userId/ledger/:opId/reverse",
  "POST /admin/v1/game/wallets/:userId/purchases/:purchaseId/refund",
  // спринт 7 — социальное: друзья и жалобы, модерация, рефералы (social), лиги и дуэли (gamification), комнаты (lessons)
  "GET /admin/v1/social/users/:userId",
  "GET /admin/v1/moderation/cases",
  "GET /admin/v1/moderation/cases/:caseId",
  "POST /admin/v1/moderation/cases/:caseId/resolve",
  "GET /admin/v1/moderation/sanctions",
  "POST /admin/v1/moderation/sanctions/:sanctionId/revoke",
  "GET /admin/v1/moderation/appeals",
  "POST /admin/v1/moderation/appeals/:appealId/decide",
  "GET /admin/v1/referrals/campaigns",
  "GET /admin/v1/referrals/campaigns/stats",
  "GET /admin/v1/referrals/campaigns/:version",
  "PUT /admin/v1/referrals/campaigns/draft",
  "DELETE /admin/v1/referrals/campaigns/draft",
  "POST /admin/v1/referrals/campaigns/draft/validate",
  "POST /admin/v1/referrals/campaigns/draft/activate",
  "GET /admin/v1/referrals",
  "GET /admin/v1/referrals/:referralId",
  "POST /admin/v1/referrals/:referralId/approve",
  "POST /admin/v1/referrals/:referralId/reject",
  "GET /admin/v1/game/leagues",
  "GET /admin/v1/game/leagues/:groupId",
  "POST /admin/v1/game/leagues/:groupId/reevaluate",
  "POST /admin/v1/game/leagues/:groupId/release-prizes",
  "GET /admin/v1/game/duels",
  "GET /admin/v1/game/duels/:duelId",
  "POST /admin/v1/game/duels/:duelId/reevaluate",
  "GET /admin/v1/pair-rooms",
  "GET /admin/v1/pair-rooms/:roomId",
  "POST /admin/v1/pair-rooms/:roomId/stop",
  // спринт 8: «Деньги» (billing), вкладка «Тариф», финансовый обзор, контроль ИИ
  "GET /admin/v1/billing/catalog",
  "GET /admin/v1/billing/catalog/:version",
  "PUT /admin/v1/billing/catalog/draft",
  "DELETE /admin/v1/billing/catalog/draft",
  "POST /admin/v1/billing/catalog/draft/validate",
  "POST /admin/v1/billing/catalog/draft/activate",
  "POST /admin/v1/billing/catalog/:version/rollback",
  "POST /admin/v1/billing/trials::grant-all",
  "GET /admin/v1/billing/orders",
  "GET /admin/v1/billing/orders/:orderId",
  "POST /admin/v1/billing/orders/:orderId/refunds",
  "GET /admin/v1/billing/refunds",
  "POST /admin/v1/billing/refunds/:refundId/fail",
  "GET /admin/v1/billing/accounts/:accountId",
  "GET /admin/v1/billing/accounts/:accountId/ledger",
  "POST /admin/v1/billing/accounts/:accountId/adjustments",
  "GET /admin/v1/billing/adjustments",
  "POST /admin/v1/billing/adjustments/:adjustmentId/approve",
  "POST /admin/v1/billing/adjustments/:adjustmentId/reject",
  "POST /admin/v1/billing/adjustments/:adjustmentId/cancel",
  "GET /admin/v1/billing/reconciliation/items",
  "POST /admin/v1/billing/reconciliation/runs",
  "POST /admin/v1/billing/reconciliation/items/:itemId/resolve",
  "GET /admin/v1/billing/reports/summary",
  "GET /admin/v1/billing/reports/daily",
  "GET /admin/v1/billing/fx",
  "PUT /admin/v1/billing/fx",
  "GET /admin/v1/billing/star-rate",
  "PUT /admin/v1/billing/star-rate",
  "GET /admin/v1/billing/providers",
  "GET /admin/v1/learners/:id/billing",
  "GET /admin/v1/finance/overview",
  "GET /admin/v1/ai/degradation",
  "PUT /admin/v1/ai/degradation",
  "GET /admin/v1/ai/unit-costs",
];

describe("реестр маршрутов", () => {
  beforeEach(async () => {
    h = await makeHarness({ ENV: "dev", NODE_ENV: "development" });
  });

  it("ровно маршруты admin.ts (+ dev/impersonate в dev): ничего туристического и лишнего", () => {
    const have = h.app.adminRoutes.map((r) => `${r.method} ${r.url}`).sort();
    expect(have).toEqual([...CONTRACT_ROUTES, "POST /admin/v1/dev/impersonate"].sort());
  });

  it("каждый сессионный маршрут без cookie / с чужой / с мусорной cookie → 401 UNAUTHORIZED, домены не вызываются", async () => {
    const routes = h.app.adminRoutes.filter((r) => r.access === "session");
    expect(routes.length).toBe(CONTRACT_ROUTES.length - 5 + 1);
    for (const r of routes) {
      for (const headers of [browser(), browser({ id: "Z".repeat(43), csrf: "x" }), browser(null, { cookie: "__Host-tilhero_admin=garbage" })]) {
        const res = await h.app.inject({ method: r.method as "GET", url: concrete(r.url), headers, payload: r.method === "GET" ? undefined : {} });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
        expect(res.json().code).toBe("UNAUTHORIZED");
      }
    }
    expect(h.fake.calls).toHaveLength(0);
  });

  it("публичные маршруты — только шаги входа", () => {
    const pub = h.app.adminRoutes.filter((r) => r.access === "public").map((r) => r.url).sort();
    expect(pub).toEqual(["/admin/v1/auth/login", "/admin/v1/auth/mfa", "/admin/v1/auth/mfa/enroll/confirm", "/admin/v1/auth/mfa/enroll/start", "/admin/v1/auth/password"]);
  });

  it("step-up — ровно список шапки admin.ts", () => {
    const su = h.app.adminRoutes.filter((r) => r.stepUp).map((r) => `${r.method} ${r.url}`).sort();
    expect(su).toEqual(
      [
        // «Что нового»: публикация и снятие
        "POST /admin/v1/release-notes/:id/publish",
        "POST /admin/v1/release-notes/:id/archive",
        // шаблон уведомления: активация и сброс
        "POST /admin/v1/notifications/templates/:key/versions/:v/activate",
        "POST /admin/v1/notifications/templates/:key/reset",
        // рассылка: расписание и остановка
        "POST /admin/v1/notifications/campaigns/:id/schedule",
        "POST /admin/v1/notifications/campaigns/:id/stop",
        // конфигурация: активация и откат
        "POST /admin/v1/experience/:app/activate",
        "POST /admin/v1/experience/:app/rollback",
        // раскрытие Telegram ID
        "POST /admin/v1/learners/:id/reveal",
        // спринт 3: публикация, снятие и откат контента (content.publish)
        "POST /admin/v1/content/:kind/:key/versions/:v/publish",
        "POST /admin/v1/content/:kind/:key/archive",
        "POST /admin/v1/content/:kind/:key/rollback",
        // права медиа и решения по заявкам учеников (media.rights)
        "POST /admin/v1/content/media_asset/:key/versions/:v/rights-approve",
        "POST /admin/v1/content/media-requests/:id/decide",
        // языки и пары (lang.manage)
        "PUT /admin/v1/languages/:code",
        "PUT /admin/v1/language-pairs/:pairId",
        // публикация версии теста диагностики (content.publish)
        "POST /admin/v1/diagnostics/tests/:id/versions/:v/publish",
        // спринт 4: публикация, канарейка (установка и снятие) и откат версии агента; модели и цены (ai.publish)
        "POST /admin/v1/ai/agents/:agentId/versions/:v/publish",
        "PUT /admin/v1/ai/agents/:agentId/canary",
        "DELETE /admin/v1/ai/agents/:agentId/canary",
        "POST /admin/v1/ai/agents/:agentId/rollback",
        "PUT /admin/v1/ai/models/:modelId",
        // бюджет и аварийная остановка ИИ (costs.manage)
        "PUT /admin/v1/ai/budget",
        "POST /admin/v1/ai/emergency-stop",
        // переоценка и решение по апелляции (qa.review)
        "POST /admin/v1/qa/evaluations/:id/reevaluate",
        "POST /admin/v1/qa/appeals/:id/decide",
        // спринт 5: ручная правка карточки памяти ученика (memory.manage); словарь курса — без step-up
        "POST /admin/v1/memory/cards/:cardId/actions",
        // спринт 6: активация и откат правил, публикация героев, предметов и событий (game.publish)
        "POST /admin/v1/game/rules/draft/activate",
        "POST /admin/v1/game/rules/:version/rollback",
        "POST /admin/v1/game/heroes/:code/publish",
        "POST /admin/v1/game/shop/items/:code/publish",
        "POST /admin/v1/game/shop/items/:code/retire",
        "POST /admin/v1/game/events/:id/publish",
        "POST /admin/v1/game/events/:id/cancel",
        // ручная операция, обратная запись, возврат покупки (wallet.adjust)
        "POST /admin/v1/game/wallets/:userId/adjustments",
        "POST /admin/v1/game/wallets/:userId/ledger/:opId/reverse",
        "POST /admin/v1/game/wallets/:userId/purchases/:purchaseId/refund",
        // спринт 7: активация реферальной кампании (referral.manage), переоценка лиги и дуэли (league.manage), остановка
        // парной комнаты (room.manage); решение по делу social_ban > 7 дней и бессрочное — step-up по телу команды
        // (маршрут без статического step-up, social.test.ts)
        "POST /admin/v1/referrals/campaigns/draft/activate",
        "POST /admin/v1/game/leagues/:groupId/reevaluate",
        "POST /admin/v1/game/duels/:duelId/reevaluate",
        "POST /admin/v1/pair-rooms/:roomId/stop",
        // спринт 8 (INTERNAL_API §12): активация и откат каталога, массовый пробный (billing.publish); заявка на
        // корректировку (subscriptions.override) и решение по ней (billing.approve); возврат и его закрытие
        // (billing.refund); уровень деградации ИИ (costs.manage; бюджет ИИ — выше)
        "POST /admin/v1/billing/catalog/draft/activate",
        "POST /admin/v1/billing/catalog/:version/rollback",
        "POST /admin/v1/billing/trials::grant-all",
        "POST /admin/v1/billing/accounts/:accountId/adjustments",
        "POST /admin/v1/billing/adjustments/:adjustmentId/approve",
        "POST /admin/v1/billing/adjustments/:adjustmentId/reject",
        "POST /admin/v1/billing/orders/:orderId/refunds",
        "POST /admin/v1/billing/refunds/:refundId/fail",
        "PUT /admin/v1/ai/degradation",
        // все команды по сотрудникам, ролям, заявкам
        "POST /admin/v1/staff",
        "PATCH /admin/v1/staff/:id",
        "POST /admin/v1/staff/:id/reset-password",
        "POST /admin/v1/staff/:id/reset-mfa",
        "PUT /admin/v1/roles/:code",
        "POST /admin/v1/approvals/:id/approve",
        "POST /admin/v1/approvals/:id/reject",
      ].sort(),
    );
  });

  it("права и роли admin-bff = каталог admin.ts; матрица по умолчанию — PLAN.md", () => {
    expect([...ALL_PERMISSIONS].sort()).toEqual([...PERMISSIONS].sort());
    expect([...ROLE_CODES]).toEqual([
      "super_admin", "operations", "communications", "support", "methodist", "content_manager", "qa_analyst", "finance", "analyst",
      "auditor", "read_only",
    ]);
    expect(PRIVILEGED_ROLES).toEqual(["super_admin", "operations", "communications"]);
    expect([...DEFAULT_ROLE_MATRIX.operations].sort()).toEqual(
      [
        "dashboard.read", "users.read", "support.read", "config.read", "config.edit", "config.publish", "audit.read", "content.read",
        // спринт 4
        "ai.read", "qa.read", "costs.read", "costs.manage",
        // спринт 5
        "memory.read", "memory.manage",
        // спринт 6
        "game.read", "game.manage", "game.publish", "wallet.adjust",
        // спринт 7
        "social.read", "moderation.manage", "referral.read", "referral.manage", "league.read", "league.manage", "room.read", "room.manage",
        // спринт 8
        "billing.read", "billing.manage", "billing.publish", "billing.approve", "billing.refund", "subscriptions.override",
      ].sort(),
    );
    // спринт 8 (PLAN спринта 8 «Права и роли»): finance — billing.* кроме subscriptions.override, costs.read, dashboard.read,
    // users.read; заявка «четыре глаза» — support и operations, подтверждение — finance и operations (не тот же сотрудник)
    expect([...DEFAULT_ROLE_MATRIX.finance].sort()).toEqual(
      ["dashboard.read", "users.read", "costs.read", "billing.read", "billing.manage", "billing.publish", "billing.approve", "billing.refund"].sort(),
    );
    // спринт 3 (docs/sprint3/PLAN.md «Права и роли») + спринт 4 (docs/sprint4/PLAN.md «Права и роли»)
    expect([...DEFAULT_ROLE_MATRIX.methodist].sort()).toEqual(
      [
        "dashboard.read", "users.read", "content.read", "content.edit", "content.review", "content.publish",
        "ai.read", "ai.manage", "ai.publish", "qa.read", "qa.transcripts", "qa.review",
        // спринт 5
        "memory.read", "glossary.manage",
        // спринт 6
        "game.read",
      ].sort(),
    );
    expect([...DEFAULT_ROLE_MATRIX.content_manager].sort()).toEqual(
      ["content.read", "content.edit", "media.rights", "dashboard.read", "glossary.manage", "game.read", "game.manage", "league.read"].sort(),
    );
    expect([...DEFAULT_ROLE_MATRIX.qa_analyst].sort()).toEqual(["dashboard.read", "content.read", "ai.read", "qa.read", "qa.transcripts", "memory.read"].sort());
    for (const r of ["analyst", "auditor"] as const) {
      expect(DEFAULT_ROLE_MATRIX[r]).toContain("content.read");
      for (const p of ["ai.read", "qa.read", "costs.read", "memory.read"] as const) expect(DEFAULT_ROLE_MATRIX[r], `${r} ${p}`).toContain(p);
    }
    // права со step-up спринта 4: публикация агентов и решения QA — методист; лимиты ИИ — операции; реплики — методист и QA
    const holders = (p: Permission) => ROLE_CODES.filter((r) => DEFAULT_ROLE_MATRIX[r].includes(p)).sort();
    expect(holders("ai.publish")).toEqual(["methodist", "super_admin"]);
    expect(holders("ai.manage")).toEqual(["methodist", "super_admin"]);
    expect(holders("qa.review")).toEqual(["methodist", "super_admin"]);
    expect(holders("costs.manage")).toEqual(["operations", "super_admin"]);
    expect(holders("qa.transcripts")).toEqual(["methodist", "qa_analyst", "super_admin"]);
    // спринт 5 (docs/sprint5/PLAN.md «Права и роли»): ручная правка памяти — операции; словарь — методист и контент-менеджер
    expect(holders("memory.manage")).toEqual(["operations", "super_admin"]);
    expect(holders("glossary.manage")).toEqual(["content_manager", "methodist", "super_admin"]);
    expect(holders("memory.read")).toEqual(["analyst", "auditor", "methodist", "operations", "qa_analyst", "super_admin"]);
    // спринт 6 (docs/sprint6/PLAN.md «Права и роли»): wallet.adjust — только super_admin и operations
    expect(holders("game.read")).toEqual(["analyst", "auditor", "content_manager", "methodist", "operations", "super_admin", "support"]);
    expect(holders("game.manage")).toEqual(["content_manager", "operations", "super_admin"]);
    expect(holders("game.publish")).toEqual(["operations", "super_admin"]);
    expect(holders("wallet.adjust")).toEqual(["operations", "super_admin"]);
    // спринт 7 (docs/sprint7/PLAN.md «Права»): support — social.read, moderation.manage, referral.read, room.read;
    // operations — все; content_manager — league.read; analyst, auditor — *.read
    expect(holders("social.read")).toEqual(["analyst", "auditor", "operations", "super_admin", "support"]);
    expect(holders("moderation.manage")).toEqual(["operations", "super_admin", "support"]);
    expect(holders("referral.read")).toEqual(["analyst", "auditor", "operations", "super_admin", "support"]);
    expect(holders("referral.manage")).toEqual(["operations", "super_admin"]);
    expect(holders("league.read")).toEqual(["analyst", "auditor", "content_manager", "operations", "super_admin"]);
    expect(holders("league.manage")).toEqual(["operations", "super_admin"]);
    expect(holders("room.read")).toEqual(["analyst", "auditor", "operations", "super_admin", "support"]);
    expect(holders("room.manage")).toEqual(["operations", "super_admin"]);
    // спринт 8: деньги
    expect(holders("billing.read")).toEqual(["analyst", "auditor", "finance", "operations", "super_admin", "support"]);
    for (const p of ["billing.manage", "billing.publish", "billing.approve", "billing.refund"] as const) {
      expect(holders(p), p).toEqual(["finance", "operations", "super_admin"]);
    }
    expect(holders("subscriptions.override")).toEqual(["operations", "super_admin", "support"]);
    expect(DEFAULT_ROLE_MATRIX.super_admin).toEqual(ALL_PERMISSIONS);
    for (const r of ROLE_CODES) expect(DEFAULT_ROLE_MATRIX[r].includes("lang.manage"), r).toBe(r === "super_admin");
    for (const r of ROLE_CODES) expect(DEFAULT_ROLE_MATRIX[r].includes("content.review"), r).toBe(r === "super_admin" || r === "methodist");
    expect([...DEFAULT_ROLE_MATRIX.communications].sort()).toEqual(
      ["dashboard.read", "whatsnew.manage", "whatsnew.publish", "notif.templates.manage", "notif.campaigns.manage", "notif.campaigns.send"].sort(),
    );
    // раскрытие Telegram ID — только super_admin
    for (const r of ROLE_CODES) expect(DEFAULT_ROLE_MATRIX[r].includes("users.sensitive.read"), r).toBe(r === "super_admin");
  });
});

describe("fail-closed регистрация маршрутов", () => {
  it("маршрут /admin/v1 без объявленного права или схемы ответа не регистрируется", async () => {
    const app = await buildApp(testConfig(), { redis: redis(), fetchImpl: async () => json(200, {}), logStream: { write() {} } });
    try {
      expect(() => app.get("/admin/v1/secret", async () => ({ ok: true }))).toThrow(/без объявленного доступа/);
      expect(() => app.get("/admin/v1/secret2", { config: { access: "session" } }, async () => ({}))).toThrow(/без объявленного права/);
      expect(() => app.get("/internal/v1/x", { config: requirePermission("users.read") }, async () => ({}))).toThrow(/вне \/admin\/v1/);
      expect(() => app.get("/admin/v1/raw", { config: requirePermission("users.read") }, async () => ({}))).toThrow(/без схемы ответа/);
      expect(() =>
        app.get("/admin/v1/ok", { config: requirePermission("users.read"), schema: { response: { "2xx": { type: "object" } } } }, async () => ({})),
      ).not.toThrow();
    } finally {
      await app.close();
    }
  });
});

describe("RBAC до вызова домена: матрица 10 ролей × все маршруты", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("маршрут с правом вне набора роли → 403 PERMISSION_DENIED {permission}, домен не вызывается", async () => {
    const routes = h.app.adminRoutes.filter((r) => r.access === "session" && r.guard !== "authenticated");
    let denied = 0;
    let logins = 0;
    // вход — 10/мин с IP: каждый сотрудник матрицы входит со своего адреса
    const fresh = async (role: RoleCode) => (await login(h, h.fake.addStaff({ role }), `198.51.100.${++logins}`));
    for (const role of ROLE_CODES) {
      let s = await fresh(role);
      let commands = 0;
      const own = new Set<string>(DEFAULT_ROLE_MATRIX[role]);
      for (const r of routes) {
        const allowed = r.guard.startsWith("role:") ? r.guard === `role:${role}` : r.guard.split("|").some((p) => own.has(p));
        if (allowed) continue;
        // лимит команд — 60/мин на сотрудника: новый сотрудник той же роли на каждые 40 команд
        if (r.method !== "GET" && ++commands % 40 === 0) s = await fresh(role);
        const before = h.fake.calls.length;
        const res = await h.app.inject({ method: r.method as "GET", url: concrete(r.url), headers: browser(s), payload: r.method === "GET" ? undefined : {} });
        expect(res.statusCode, `${role} ${r.method} ${r.url}`).toBe(403);
        expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: r.guard } });
        expect(h.fake.calls.length, `${role} ${r.method} ${r.url}`).toBe(before);
        denied++;
      }
    }
    expect(denied).toBeGreaterThan(400);
  });

  it("у каждой роли есть разрешённый маршрут кроме /me и dashboard (роль не «пустая», кроме read_only)", () => {
    const routes = h.app.adminRoutes.filter((r) => r.guard !== "authenticated" && r.guard !== "public" && r.url !== "/admin/v1/dashboard");
    for (const role of ROLE_CODES) {
      const own = new Set<string>(DEFAULT_ROLE_MATRIX[role]);
      const n = routes.filter((r) => r.guard.split("|").some((p) => own.has(p as Permission)) || r.guard === `role:${role}`).length;
      // support/stats, content/summary, diagnostics/stats, memory/analytics, memory/stats, glossary/stats (dashboard.read);
      // спринт 8: billing/reports/summary, billing/reports/daily, finance/overview, ai/unit-costs
      if (role === "read_only") expect(n, role).toBe(10);
      else expect(n, role).toBeGreaterThan(1);
    }
  });

  it("approve/reject — только роль super_admin (staff.manage недостаточно)", async () => {
    const { s } = await loginAs(h, "operations", { permissions: ["dashboard.read", "staff.manage", "roles.manage"] });
    await stepUp(h, s);
    const res = await h.app.inject({ method: "POST", url: `/admin/v1/approvals/${APPROVAL_ID}/approve`, headers: browser(s), payload: { note: "ok" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().details.permission).toBe("role:super_admin");
  });

  it("communications: публикует «Что нового» (со step-up), но не видит учеников; support не публикует (AT-17)", async () => {
    const com = await loginAs(h, "communications");
    expect((await h.app.inject({ url: "/admin/v1/learners", headers: browser(com.s) })).statusCode).toBe(403);
    const pub = () =>
      h.app.inject({ method: "POST", url: `/admin/v1/release-notes/${LEARNER_ID}/publish`, headers: browser(com.s), payload: { expected_version: 1, reason: "релиз" } });
    expect((await pub()).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, com.s);
    expect((await pub()).statusCode).toBe(201);
    const sup = await loginAs(h, "support");
    await stepUp(h, sup.s);
    const denied = await h.app.inject({
      method: "POST",
      url: `/admin/v1/release-notes/${LEARNER_ID}/publish`,
      headers: browser(sup.s),
      payload: { expected_version: 1, reason: "релиз" },
    });
    expect(denied.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "whatsnew.publish" } });
  });
});

describe("actor-токен в домены", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("{id, role, name, permissions} — эффективные права сессии, подпись admin-bff, aud = домен", async () => {
    const { staff, s } = await loginAs(h, "support", { display_name: "Мария Оператор" });
    let token = "";
    h.fake.on("userAdmin", "GET", "/admin/v1/learners", (c) => {
      token = c.headers["x-internal-token"]!;
      return json(200, { items: [], next_cursor: null });
    });
    expect((await h.app.inject({ url: "/admin/v1/learners?q=%40someone&limit=5", headers: browser(s) })).statusCode).toBe(200);
    const v = await verifyInternalToken(token, INTERNAL_SECRET, "user-admin", new Set(["admin-bff"]));
    expect(v.issuer).toBe("admin-bff");
    expect(v.subject).toBeUndefined();
    expect(v.actor).toEqual({
      id: staff.staff_id,
      role: "support",
      name: "Мария Оператор",
      permissions: ["billing.read", "dashboard.read", "game.read", "moderation.manage", "referral.read", "room.read", "social.read", "subscriptions.override", "support.read", "support.reply", "users.read"],
    });
    // токен для другого домена не принимается этим доменом
    await expect(verifyInternalToken(token, INTERNAL_SECRET, "support")).rejects.toMatchObject({ code: "INTERNAL_TOKEN_INVALID" });
    expect(h.fake.callsTo("userAdmin", "GET", "/admin/v1/learners")[0]!.query).toEqual({ q: "@someone", limit: "5" });
  });

  it("каждый вызов домена из сессионного маршрута несёт actor (кроме чтения действующей конфигурации)", async () => {
    const { s } = await loginAs(h, "super_admin");
    await h.app.inject({ url: "/admin/v1/dashboard", headers: browser(s) });
    await h.app.inject({ url: `/admin/v1/learners/${LEARNER_ID}`, headers: browser(s) });
    await h.app.inject({ url: "/admin/v1/experience/admin/current", headers: browser(s) });
    const domainCalls = h.fake.calls.filter((c) => !c.path.startsWith("/internal/v1/auth/") && !c.path.includes("/principal"));
    expect(domainCalls.length).toBeGreaterThan(5);
    for (const c of domainCalls) {
      if (c.path === "/internal/v1/experience/admin/current") expect(c.actor).toBeUndefined();
      else expect(c.actor?.role, `${c.service} ${c.path}`).toBe("super_admin");
    }
  });
});

describe("CSRF и Origin", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });
  const take = (headers: Record<string, string>) => h.app.inject({ method: "POST", url: "/admin/v1/support/tickets/TCK-3001/take", headers });

  it("на КАЖДОМ небезопасном сессионном маршруте: без X-CSRF-Token, с токеном другой сессии, с чужим Origin → 403 CSRF_INVALID", async () => {
    const { s } = await loginAs(h, "super_admin");
    const other = await loginAs(h, "super_admin");
    const { "x-csrf-token": _drop, ...noToken } = browser(s);
    const unsafe = h.app.adminRoutes.filter((r) => r.access === "session" && r.method !== "GET");
    expect(unsafe.length).toBeGreaterThan(30);
    const before = h.fake.calls.length;
    for (const r of unsafe) {
      for (const headers of [noToken, browser(s, { "x-csrf-token": other.s.csrf }), browser(s, { origin: "https://evil.example" })]) {
        const res = await h.app.inject({ method: r.method as "POST", url: concrete(r.url), headers, payload: {} });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
        expect(res.json().code).toBe("CSRF_INVALID");
      }
    }
    expect(h.fake.calls.length).toBe(before);
  });

  it("чужой Origin / Origin: null / без Origin и без Sec-Fetch-Site → 403; Sec-Fetch-Site: same-origin — ок", async () => {
    const { s } = await loginAs(h, "support");
    for (const origin of ["https://evil.example", "null", "https://admin.tilhero.test.evil.example", "http://admin.tilhero.test"]) {
      expect((await take(browser(s, { origin }))).json().code, origin).toBe("CSRF_INVALID");
    }
    const { origin: _o, ...noOrigin } = browser(s);
    expect((await take(noOrigin)).statusCode).toBe(403);
    expect((await take({ ...noOrigin, "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    expect((await take({ ...noOrigin, "sec-fetch-site": "same-origin" })).statusCode).toBe(200);
  });

  it("GET не требует CSRF-токена", async () => {
    const { s } = await loginAs(h, "support");
    const { "x-csrf-token": _drop, origin: _o, ...plain } = browser(s);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: plain })).statusCode).toBe(200);
  });

  it("вход до сессии: без Origin или с чужим Origin → 403, admin-identity не вызывается", async () => {
    const staff = h.fake.addStaff({ role: "support" });
    for (const headers of [{ "user-agent": UA }, { "user-agent": UA, origin: "https://evil.example" }]) {
      for (const url of ["/admin/v1/auth/login", "/admin/v1/auth/mfa", "/admin/v1/auth/mfa/enroll/start", "/admin/v1/auth/mfa/enroll/confirm", "/admin/v1/auth/password"]) {
        const res = await h.app.inject({ method: "POST", url, headers, payload: { email: staff.email, password: PASSWORD_OK } });
        expect(res.statusCode, url).toBe(403);
        expect(res.json().code).toBe("CSRF_INVALID");
      }
    }
    expect(h.fake.calls).toHaveLength(0);
  });
});

describe("лимиты", () => {
  beforeEach(async () => {
    h = await makeHarness();
    await avoidWindowEdge();
  });
  const attempt = (email: string, ip: string, extra: Record<string, string> = {}) =>
    h.app.inject({ method: "POST", url: "/admin/v1/auth/login", headers: browser(null, extra), remoteAddress: ip, payload: { email, password: "bad" } });

  it("вход: 10/мин с IP → 429 RATE_LIMITED + Retry-After; другой IP не затронут", async () => {
    for (let i = 0; i < 10; i++) expect((await attempt(`u${i}@x.test`, "198.51.100.7")).statusCode).toBe(401);
    const limited = await attempt("u99@x.test", "198.51.100.7");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "RATE_LIMITED", details: { retry_after: expect.any(Number) } });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect((await attempt("u99@x.test", "198.51.100.8")).statusCode).toBe(401);
  });

  it("вход: 5/мин на email (без учёта регистра) с разных IP; в ключах Redis нет e-mail и IP", async () => {
    for (let i = 0; i < 5; i++) expect((await attempt(i % 2 ? "Victim@X.test" : "victim@x.test", `203.0.113.${i + 1}`)).statusCode).toBe(401);
    const r = await attempt("victim@x.test", "203.0.113.77");
    expect(r.statusCode).toBe(429);
    expect(r.json().details.policy).toBe("adm.login_email");
    expect(h.fake.callsTo("adminIdentity", "POST", "/internal/v1/auth/login")).toHaveLength(5);
    const keys = (await redis().keys(`${h.config.redisKeyPrefix}*`)).join();
    expect(keys).not.toContain("victim");
    expect(keys).not.toContain("203.0.113");
  });

  it("IPv6 — лимит на /64 (перебор адресов в своей подсети не помогает)", async () => {
    for (let i = 0; i < 10; i++) expect((await attempt(`a${i}@x.test`, `2001:db8:1:2::${(i + 1).toString(16)}`)).statusCode).toBe(401);
    expect((await attempt("z@x.test", "2001:db8:1:2:ffff::1")).statusCode).toBe(429);
    expect((await attempt("z@x.test", "2001:db8:1:3::1")).statusCode).toBe(401);
  });

  it("TRUST_PROXY_HOPS=2: XFF \"fake, real, edge\" от Caddy → req.ip = реальный клиент (в admin-identity и лимит)", async () => {
    const xff = "203.0.113.66, 198.51.100.7, 100.64.0.9";
    const staff = h.fake.addStaff({ role: "support" });
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/v1/auth/login",
      headers: browser(null, { "x-forwarded-for": xff }),
      remoteAddress: "fd12::ca:1",
      payload: { email: staff.email, password: PASSWORD_OK },
    });
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("adminIdentity", "POST", "/internal/v1/auth/login")[0]!.body.ip).toBe("198.51.100.7");
    for (let i = 1; i < 11; i++) {
      const r = await attempt(`r${i}@x.test`, "fd12::ca:1", { "x-forwarded-for": `203.0.113.${i}, 198.51.100.7, 100.64.0.9` });
      expect(r.statusCode, String(i)).toBe(i < 10 ? 401 : 429);
    }
    expect((await attempt("other@x.test", "fd12::ca:1", { "x-forwarded-for": "198.51.100.8, 100.64.0.9" })).statusCode).toBe(401);
  });

  it("коды по challenge: 5/мин на challenge", async () => {
    const staff = h.fake.addStaff({ role: "operations", mfa_enabled: true });
    const r = await h.app.inject({ method: "POST", url: "/admin/v1/auth/login", headers: browser(), payload: { email: staff.email, password: PASSWORD_OK } });
    const challenge = (r.json() as LoginStep).challenge!;
    for (let i = 0; i < 5; i++) {
      const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/mfa", headers: browser(), payload: { challenge, code: "000000" } });
      expect(res.statusCode).toBe(401);
    }
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/mfa", headers: browser(), payload: { challenge, code: TOTP_OK } });
    expect(res.statusCode).toBe(429);
  });

  it("adm.staff: RATE_LIMIT_STAFF_PER_MIN на сотрудника; другой сотрудник не затронут", async () => {
    await h.close();
    h = await makeHarness({ RATE_LIMIT_STAFF_PER_MIN: "5" });
    const { s } = await loginAs(h, "support");
    const other = await loginAs(h, "support");
    for (let i = 0; i < 5; i++) expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(429);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(other.s) })).statusCode).toBe(200);
  });

  it("adm.command: 60 команд в минуту на сотрудника, 61-я → 429 {policy: adm.command}; чтения не затронуты", async () => {
    const { s } = await loginAs(h, "support");
    for (let i = 0; i < 60; i++) {
      expect((await h.app.inject({ method: "POST", url: "/admin/v1/support/tickets/TCK-3001/take", headers: browser(s) })).statusCode, String(i)).toBe(200);
    }
    const r = await h.app.inject({ method: "POST", url: "/admin/v1/support/tickets/TCK-3001/take", headers: browser(s) });
    expect(r.statusCode).toBe(429);
    expect(r.json().details.policy).toBe("adm.command");
    expect((await h.app.inject({ url: "/admin/v1/support/tickets", headers: browser(s) })).statusCode).toBe(200);
  });
});

describe("имперсонация", () => {
  it("ENV=dev: сужает права до роли (не расширяет), actor-токен с ролью и пересечением прав, аудит", async () => {
    h = await makeHarness({ ENV: "dev", NODE_ENV: "development" });
    const { staff, s } = await loginAs(h, "super_admin");
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(s), payload: { role: "support" } });
    expect(res.statusCode).toBe(200);
    const me = res.json() as Me;
    expect(me.impersonating).toBe("support");
    expect(me.staff.role).toBe("super_admin");
    expect(me.permissions).toEqual(["billing.read", "dashboard.read", "game.read", "moderation.manage", "referral.read", "room.read", "social.read", "subscriptions.override", "support.read", "support.reply", "users.read"]);
    const audit = h.fake.callsTo("audit", "POST", "/internal/v1/records")[0]!;
    expect(audit.body).toMatchObject({ action: "dev.impersonate", after: { impersonating: "support" } });

    // права сужены на backend
    expect((await h.app.inject({ url: "/admin/v1/staff", headers: browser(s) })).statusCode).toBe(403);
    await h.app.inject({ url: "/admin/v1/learners", headers: browser(s) });
    const actor = h.fake.callsTo("userAdmin", "GET", "/admin/v1/learners").at(-1)!.actor!;
    expect(actor).toEqual({ id: staff.staff_id, role: "super_admin", name: staff.display_name, permissions: ["billing.read", "dashboard.read", "game.read", "moderation.manage", "referral.read", "room.read", "social.read", "subscriptions.override", "support.read", "support.reply", "users.read"] });

    // проверка по роли при имперсонации тоже сужается: super_admin, примеривший support, не утверждает заявки
    await stepUp(h, s);
    const approve = await h.app.inject({ method: "POST", url: `/admin/v1/approvals/${APPROVAL_ID}/approve`, headers: browser(s), payload: {} });
    expect(approve.statusCode).toBe(403);
    expect(approve.json().details.permission).toBe("role:super_admin");

    // communications не может «примерить» operations (права шире своих) — 403, аудита и режима нет
    const com = await loginAs(h, "communications");
    const auditBefore = h.fake.callsTo("audit", "POST", "/internal/v1/records").length;
    const up = await h.app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(com.s), payload: { role: "super_admin" } });
    expect(up.statusCode).toBe(403);
    expect(up.json()).toMatchObject({ code: "IMPERSONATION_NOT_ALLOWED", details: { role: "super_admin" } });
    expect(h.fake.callsTo("audit", "POST", "/internal/v1/records")).toHaveLength(auditBefore);
    expect(((await h.app.inject({ url: "/admin/v1/me", headers: browser(com.s) })).json() as Me).impersonating).toBeNull();

    const back = (await h.app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(s), payload: { role: null } })).json() as Me;
    expect(back.impersonating).toBeNull();
    expect(back.permissions).toContain("staff.manage");
  });

  it("подложенная в сессию роль шире своих игнорируется: approve у support не проходит, actor — настоящая роль", async () => {
    h = await makeHarness({ ENV: "dev", NODE_ENV: "development" });
    const { staff, s } = await loginAs(h, "support");
    await redis().hset(`${h.config.redisKeyPrefix}sess:${sha256hex(s.id)}`, "impersonating", "super_admin");
    expect((await stepUp(h, s)).statusCode).toBe(200);
    const res = await h.app.inject({ method: "POST", url: `/admin/v1/approvals/${APPROVAL_ID}/approve`, headers: browser(s), payload: {} });
    expect(res.statusCode).toBe(403);
    expect(h.fake.callsTo("adminIdentity", "POST", "/admin/v1/approvals/")).toHaveLength(0);
    const me = (await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).json() as Me;
    expect(me.impersonating).toBeNull();
    await h.app.inject({ url: "/admin/v1/learners", headers: browser(s) });
    expect(h.fake.callsTo("userAdmin", "GET", "/admin/v1/learners").at(-1)!.actor).toMatchObject({ id: staff.staff_id, role: "support" });
  });

  it("вне ENV=dev запись impersonating в сессии не действует", async () => {
    h = await makeHarness();
    const { s } = await loginAs(h, "super_admin");
    await redis().hset(`${h.config.redisKeyPrefix}sess:${sha256hex(s.id)}`, "impersonating", "read_only");
    const me = (await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).json() as Me;
    expect(me.impersonating).toBeNull();
    expect(me.permissions).toContain("staff.manage");
    expect((await h.app.inject({ url: "/admin/v1/staff", headers: browser(s) })).statusCode).toBe(200);
  });

  it("аудит недоступен → режим не включается (503)", async () => {
    h = await makeHarness({ ENV: "dev", NODE_ENV: "development" });
    const { s } = await loginAs(h, "super_admin");
    h.fake.down.add("audit");
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(s), payload: { role: "support" } });
    expect(res.statusCode).toBe(503);
    expect(((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).json() as Me).impersonating).toBeNull();
  });

  it.each(["test", "stage", "prod"])("ENV=%s → 404, маршрута нет", async (env) => {
    if (env !== "test") {
      const cfg = testConfig({ ENV: env, INTERNAL_JWT_PRIVATE_KEY: "A".repeat(43), INTERNAL_JWT_PUBLIC_KEYS: "{}", ADMIN_ORIGIN: ORIGIN });
      expect(cfg.devTools).toBe(false);
      const app = await buildApp(cfg, { redis: redis(), fetchImpl: async () => json(200, {}), logStream: { write() {} } });
      await app.ready();
      expect(app.adminRoutes.some((r) => r.url.startsWith("/admin/v1/dev/"))).toBe(false);
      const res = await app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(), payload: { role: "support" } });
      expect(res.statusCode).toBe(404);
      await app.close();
      return;
    }
    h = await makeHarness();
    const { s } = await loginAs(h, "super_admin");
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(s), payload: { role: "support" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("заголовки ответов и cookie", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("данные сотрудника — Cache-Control: no-store, nosniff, DENY, CSP; CORS нет ни для чужого, ни для своего Origin", async () => {
    const { s } = await loginAs(h, "support");
    for (const origin of [ORIGIN, "https://evil.example"]) {
      const res = await h.app.inject({ url: "/admin/v1/me", headers: browser(s, { origin }) });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
    const pre = await h.app.inject({ method: "OPTIONS", url: "/admin/v1/me", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("cookie: __Host-tilhero_admin, Secure, HttpOnly, SameSite=Strict, Path=/, без Domain; фиксация не проходит", async () => {
    const staff = h.fake.addStaff({ role: "support" });
    const planted = "P".repeat(43);
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/v1/auth/login",
      headers: browser(null, { cookie: `__Host-tilhero_admin=${planted}` }),
      payload: { email: staff.email, password: PASSWORD_OK },
    });
    const sc = String(res.headers["set-cookie"]);
    expect(sc).toMatch(/^__Host-tilhero_admin=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=28800; Secure; HttpOnly; SameSite=Strict$/);
    expect(sc).not.toContain(planted);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser({ id: planted, csrf: "x" }) })).statusCode).toBe(401);
  });
});

describe("логи без секретов и PII", () => {
  it("cookie, CSRF, пароли, коды, challenge, секрет MFA, временный пароль, email, Telegram ID, причины, поиск — не попадают в лог", async () => {
    h = await makeHarness();
    const staff = h.fake.addStaff({ role: "super_admin", email: "secret.person@tilhero.test", must_change_password: true, mfa_required: true });
    const r1 = await h.app.inject({ method: "POST", url: "/admin/v1/auth/login", headers: browser(), payload: { email: staff.email, password: PASSWORD_OK } });
    const c1 = (r1.json() as LoginStep).challenge!;
    const r2 = await h.app.inject({ method: "POST", url: "/admin/v1/auth/password", headers: browser(), payload: { challenge: c1, new_password: "Brand-New-Secret-77" } });
    const c2 = (r2.json() as LoginStep).challenge!;
    const r3 = await h.app.inject({ method: "POST", url: "/admin/v1/auth/mfa/enroll/start", headers: browser(), payload: { challenge: c2 } });
    const secret = r3.json().secret as string;
    const r4 = await h.app.inject({ method: "POST", url: "/admin/v1/auth/mfa/enroll/confirm", headers: browser(), payload: { challenge: c2, code: TOTP_OK } });
    const me = (r4.json() as LoginStep).me!;
    const id = String(r4.headers["set-cookie"]).split(";")[0]!.split("=")[1]!;
    const s = { id, csrf: me.csrf_token };
    const su = await h.app.inject({ method: "POST", url: "/admin/v1/auth/step-up", headers: browser(s), payload: { code: TOTP_OK } });
    const id2 = String(su.headers["set-cookie"]).split(";")[0]!.split("=")[1]!;
    s.id = id2;
    const created = await h.app.inject({
      method: "POST",
      url: "/admin/v1/staff",
      headers: { ...browser(s), "idempotency-key": "logs-create-0001" },
      payload: { email: "new.hire@tilhero.test", display_name: "Новый Сотрудник", role: "support" },
    });
    const tmp = created.json().temporary_password as string;
    const rev = await h.app.inject({
      method: "POST",
      url: `/admin/v1/learners/${LEARNER_ID}/reveal`,
      headers: browser(s),
      payload: { field: "telegram_user_id", reason: "проверка мошенничества" },
    });
    expect(rev.json().value).toBe(TG_FULL);
    await h.app.inject({ url: "/admin/v1/learners?q=secret.person", headers: browser(s) });
    await h.app.inject({ url: `/admin/v1/learners/${LEARNER_ID}`, headers: browser(s) });
    // ошибка домена и сбой — тоже без секретов
    h.fake.down.add("support");
    await h.app.inject({ method: "POST", url: "/admin/v1/support/tickets/TCK-1/take", headers: browser(s) });
    await h.app.inject({ url: "/admin/v1/dashboard", headers: browser(s) });

    const text = h.logs.text;
    expect(text).toContain("request completed");
    for (const leak of [id, id2, me.csrf_token, PASSWORD_OK, "Brand-New-Secret-77", c1, c2, secret, TOTP_OK, tmp, TG_FULL, "secret.person", "new.hire", "проверка мошенничества", "Азиз", "aziz_learner"]) {
      expect(text, `leak: ${leak.slice(0, 6)}…`).not.toContain(leak);
    }
  });
});

// типы ролей используются в матрице выше
export type _Roles = RoleCode;
