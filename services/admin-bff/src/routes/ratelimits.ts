/**
 * Спринт 9 — «Мониторинг → Лимиты» (docs/sprint9/INTERNAL_API.md §2.4, §12 Q2/Q3): прокси ops-monitor.
 *  - GET /admin/v1/ops/ratelimits — политики с действующими значениями и отказами за 15 мин (dashboard.read);
 *  - GET /admin/v1/ops/ratelimits/{policy}/history?range=24h|7d — точки 5 мин / 1 ч и топ субъектов-псевдонимов;
 *  - PUT /admin/v1/ops/ratelimits/{policy}/override {limit, window_s, burst?, reason, expires_at?} — ops.kill_switch +
 *    step-up TOTP, Idempotency-Key; 422 RATE_LIMIT_TOO_STRICT (fail: closed ниже 1 запроса в минуту) — как есть;
 *  - DELETE …/override {reason} — сброс к значению по умолчанию (то же право, step-up, ключ).
 * Аудит `ratelimit.override.set|reset` пишет ops-monitor синхронно до действия (audit недоступен → 503
 * AUDIT_UNAVAILABLE); Redis недоступен → 503 RATE_LIMIT_UNAVAILABLE. Повтор с тем же ключом → Idempotent-Replayed.
 */
import { AppError, type UpstreamError } from "@tilhero/ts-common";
import type { RateLimitOverrideInput, RateLimitResetInput } from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, passReplayed, staffOf, validationError, type App } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { enumOf, obj, params, query, str } from "../schemas.js";
import { ok } from "../responses.js";
import { command, REASON_IN, reasonOf, respond } from "./aiCommon.js";
import { OPS, opsServerError } from "./ops.js";
import { POLICY_RE, RATE_LIMIT_HISTORY, RATE_LIMIT_POLICIES, RATE_LIMIT_POLICY } from "./s9Codecs.js";

const POLICY_P = params({ policy: str(3, 64, { pattern: POLICY_RE.source }) });
const TIME_IN = str(20, 40, { pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,6})?)?(Z|[+-]\\d{2}:\\d{2})$" });
const OVERRIDE_IN = obj(
  {
    limit: { type: "integer", minimum: 1, maximum: 100_000 },
    window_s: { type: "integer", minimum: 1, maximum: 86_400 },
    burst: { type: "integer", minimum: 1, maximum: 100_000 },
    reason: REASON_IN,
    expires_at: TIME_IN,
  },
  ["limit", "window_s", "reason"],
);

/** ops-monitor: Redis лимитов недоступен — 503 RATE_LIMIT_UNAVAILABLE как есть (не «ops-monitor упал»). */
function rlServerError(err: UpstreamError): AppError | undefined {
  const mapped = opsServerError(err);
  if (mapped) return mapped;
  if (err.status === 503 && err.code === "RATE_LIMIT_UNAVAILABLE") {
    return new AppError(503, "RATE_LIMIT_UNAVAILABLE", "Хранилище лимитов (Redis) недоступно — изменение не выполнено", { service: "redis" });
  }
  return undefined;
}

export function rateLimitRoutes(app: App, ctx: BffContext): void {
  const ops = ctx.domains.opsMonitor;

  app.get("/admin/v1/ops/ratelimits", { config: requirePermission("dashboard.read"), schema: { response: ok(RATE_LIMIT_POLICIES.schema) } }, async (req) => {
    const auth = staffOf(req);
    const body = await ops.get<unknown>("/internal/v1/ratelimits/policies", { actor: auth.actor, mapServerError: opsServerError });
    return respond(ctx, auth, OPS, RATE_LIMIT_POLICIES, body);
  });

  app.get<{ Params: { policy: string }; Querystring: { range?: "24h" | "7d" } }>(
    "/admin/v1/ops/ratelimits/:policy/history",
    {
      config: requirePermission("dashboard.read"),
      schema: { response: ok(RATE_LIMIT_HISTORY.schema), params: POLICY_P, querystring: query({ range: enumOf(["24h", "7d"]) }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await ops.get<unknown>(`/internal/v1/ratelimits/${req.params.policy}/history`, {
        actor: auth.actor,
        query: { range: req.query.range ?? "24h" },
        mapServerError: opsServerError,
      });
      return respond(ctx, auth, OPS, RATE_LIMIT_HISTORY, body);
    },
  );

  app.put<{ Params: { policy: string }; Body: RateLimitOverrideInput }>(
    "/admin/v1/ops/ratelimits/:policy/override",
    {
      config: { ...requirePermission("ops.kill_switch"), ...requireStepUp() },
      schema: { response: ok(RATE_LIMIT_POLICY.schema), params: POLICY_P, body: OVERRIDE_IN },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const key = idempotencyKeyOf(req, true)!;
      const b = req.body;
      if (b.burst !== undefined && b.burst < 1) throw validationError("burst", "burst ≥ 1");
      if (b.expires_at !== undefined && Date.parse(b.expires_at) <= ctx.now()) throw validationError("expires_at", "Срок переопределения должен быть в будущем");
      const body: RateLimitOverrideInput = {
        limit: b.limit,
        window_s: b.window_s,
        reason: reasonOf(b.reason),
        ...(b.burst !== undefined ? { burst: b.burst } : {}),
        ...(b.expires_at !== undefined ? { expires_at: b.expires_at } : {}),
      };
      const res = await ops.call<unknown>("PUT", `/internal/v1/ratelimits/${req.params.policy}/override`, {
        actor: auth.actor,
        body,
        ...command(key),
        mapServerError: rlServerError,
      });
      passReplayed(reply, res);
      return respond(ctx, auth, OPS, RATE_LIMIT_POLICY, res.body);
    },
  );

  app.delete<{ Params: { policy: string }; Body: RateLimitResetInput }>(
    "/admin/v1/ops/ratelimits/:policy/override",
    {
      config: { ...requirePermission("ops.kill_switch"), ...requireStepUp() },
      schema: { response: ok(RATE_LIMIT_POLICY.schema), params: POLICY_P, body: obj({ reason: REASON_IN }, ["reason"]) },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const key = idempotencyKeyOf(req, true)!;
      const res = await ops.call<unknown>("DELETE", `/internal/v1/ratelimits/${req.params.policy}/override`, {
        actor: auth.actor,
        body: { reason: reasonOf(req.body.reason) },
        ...command(key),
        mapServerError: rlServerError,
      });
      passReplayed(reply, res);
      return respond(ctx, auth, OPS, RATE_LIMIT_POLICY, res.body);
    },
  );
}
