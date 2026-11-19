/**
 * Диагностика (diagnostics `/admin/v1/diagnostics/*`, пути — как admin.ts): content.read — тесты и версия теста
 * с ключами ответов и покрытием; content.publish + step-up — публикация версии теста (прежняя опубликованная той же
 * пары и аудитории → archived); dashboard.read — статистика прохождений. Права проверяются здесь до вызова домена,
 * diagnostics проверяет их повторно. Ошибки домена — как есть: 404 DIAGNOSTIC_TEST_NOT_FOUND, 422 TEST_INVALID
 * {errors}, 409 недопустимый переход статуса версии.
 */
import { DIAGNOSTIC_STATS, DIAGNOSTIC_TEST_ROW, DIAGNOSTIC_TEST_VERSION, DIAGNOSTIC_TESTS } from "../contractContent.js";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, staffOf, type App } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { PERIOD, REASON, TEST_ID, VERSION_NO, obj, params, query } from "../schemas.js";
import { DOMAIN } from "../upstream.js";
import { out, relay, shaped } from "./common.js";

const SERVICE = DOMAIN.diagnostics;
const BASE = "/admin/v1/diagnostics";
const VERSION_PARAMS = params({ id: TEST_ID, v: VERSION_NO });

export function diagnosticsRoutes(app: App, ctx: BffContext): void {
  const diag = ctx.domains.diagnostics;
  const ver = (p: { id: string; v: string }) => `${BASE}/tests/${encodeURIComponent(p.id)}/versions/${Number(p.v)}`;

  app.get(`${BASE}/tests`, { config: requirePermission("content.read"), schema: { response: out(DIAGNOSTIC_TESTS) } }, async (req) => {
    const auth = staffOf(req);
    return shaped(ctx, auth, SERVICE, DIAGNOSTIC_TESTS, await diag.get<unknown>(`${BASE}/tests`, { actor: auth.actor }));
  });

  app.get<{ Params: { id: string; v: string } }>(
    `${BASE}/tests/:id/versions/:v`,
    { config: requirePermission("content.read"), schema: { response: out(DIAGNOSTIC_TEST_VERSION), params: VERSION_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, DIAGNOSTIC_TEST_VERSION, await diag.get<unknown>(ver(req.params), { actor: auth.actor }));
    },
  );

  app.post<{ Params: { id: string; v: string }; Body: { reason: string } }>(
    `${BASE}/tests/:id/versions/:v/publish`,
    {
      config: { ...requirePermission("content.publish"), ...requireStepUp() },
      schema: { response: out(DIAGNOSTIC_TEST_ROW), params: VERSION_PARAMS, body: obj({ reason: REASON }, ["reason"]) },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await diag.call("POST", `${ver(req.params)}/publish`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relay(ctx, auth, reply, SERVICE, DIAGNOSTIC_TEST_ROW, res);
    },
  );

  app.get<{ Querystring: { period?: string } }>(
    `${BASE}/stats`,
    { config: requirePermission("dashboard.read"), schema: { response: out(DIAGNOSTIC_STATS), querystring: query({ period: PERIOD }) } },
    async (req) => {
      const auth = staffOf(req);
      const body = await diag.get<unknown>(`${BASE}/stats`, { actor: auth.actor, query: { period: req.query.period ?? "today" } });
      return shaped(ctx, auth, SERVICE, DIAGNOSTIC_STATS, body);
    },
  );
}
