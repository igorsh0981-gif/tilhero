/**
 * Спринт 9 — «Пользователи → Удаления» (docs/sprint9/INTERNAL_API.md §1.4, §12 Q1): прокси саги удаления
 * identity-consent (IDENTITY_URL) с сотрудником (actor).
 *  - GET /admin/v1/deletions?status=open|stuck|completed&cursor=&limit= и GET /admin/v1/deletions/{id} — users.read;
 *  - POST /admin/v1/deletions/{id}:retry {reason} — ops.queues.manage + step-up TOTP, Idempotency-Key обязателен;
 *    аудит `user.deletion.retry` identity пишет синхронно до повтора (audit недоступен → 503 AUDIT_UNAVAILABLE,
 *    ничего не отправлено); 409 DELETION_NOT_OPEN, 409 DELETION_RETRY_TOO_SOON {retry_after} — как есть;
 *    повтор с тем же ключом → `Idempotent-Replayed: true`. Лимит `adm.dlq` — хук лимитера (rateLimit.ts, пакет Q2).
 * Принудительного завершения удаления нет ни здесь, ни в домене. PII нет: user_id — псевдоним.
 */
import type { DeletionRetryInput } from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, passReplayed, staffOf, type App } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { CURSOR_Q, LIMIT_Q, UUID, enumOf, obj, pageQuery, params, query } from "../schemas.js";
import { ok } from "../responses.js";
import { command, REASON_IN, reasonOf, respond } from "./aiCommon.js";
import { DELETION_DETAIL, DELETION_PAGE } from "./s9Codecs.js";

export const IDENTITY = "identity-consent";
const UUID_RE = (UUID.pattern as string).slice(1, -1);

export function deletionRoutes(app: App, ctx: BffContext): void {
  const identity = ctx.domains.identity;

  app.get<{ Querystring: { status?: "open" | "stuck" | "completed"; cursor?: string; limit?: string } }>(
    "/admin/v1/deletions",
    {
      config: requirePermission("users.read"),
      schema: {
        response: ok(DELETION_PAGE.schema),
        querystring: query({ status: enumOf(["open", "stuck", "completed"]), cursor: CURSOR_Q, limit: LIMIT_Q }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await identity.get<unknown>("/admin/v1/deletions", {
        actor: auth.actor,
        query: { status: req.query.status, ...pageQuery(req.query) },
      });
      return respond(ctx, auth, IDENTITY, DELETION_PAGE, body);
    },
  );

  app.get<{ Params: { request_id: string } }>(
    "/admin/v1/deletions/:request_id",
    { config: requirePermission("users.read"), schema: { response: ok(DELETION_DETAIL.schema), params: params({ request_id: UUID }) } },
    async (req) => {
      const auth = staffOf(req);
      const body = await identity.get<unknown>(`/admin/v1/deletions/${req.params.request_id.toLowerCase()}`, { actor: auth.actor });
      return respond(ctx, auth, IDENTITY, DELETION_DETAIL, body);
    },
  );

  // `{id}:retry` — литеральное двоеточие (Fastify «::»); имя параметра включает суффикс, значение — `<uuid>:retry`
  app.post<{ Params: { "request_id::retry": string }; Body: DeletionRetryInput }>(
    "/admin/v1/deletions/:request_id::retry",
    {
      config: { ...requirePermission("ops.queues.manage"), ...requireStepUp() },
      schema: {
        response: ok(DELETION_DETAIL.schema),
        params: params({ "request_id::retry": { type: "string", pattern: `^${UUID_RE}:retry$` } }),
        body: obj({ reason: REASON_IN }, ["reason"]),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const key = idempotencyKeyOf(req, true)!;
      const id = req.params["request_id::retry"].slice(0, 36).toLowerCase();
      const res = await identity.call<unknown>("POST", `/admin/v1/deletions/${id}:retry`, {
        actor: auth.actor,
        body: { reason: reasonOf(req.body.reason) },
        ...command(key),
      });
      passReplayed(reply, res);
      return respond(ctx, auth, IDENTITY, DELETION_DETAIL, res.body);
    },
  );
}
