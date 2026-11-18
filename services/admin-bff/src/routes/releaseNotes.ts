/**
 * «Что нового» (experience-config): whatsnew.manage — список, карточка, статистика, черновик и его правка;
 * whatsnew.publish + step-up — публикация и снятие (архив). Пустой перевод отклоняет домен (422
 * RELEASE_NOTE_TRANSLATION_MISSING {missing}) — admin-bff его передаёт как есть. Статус домена сохраняется
 * (201 / 200 no-op «уже опубликована / в архиве»); `created_by_name`, `published_by_name` — через staff/lookup.
 */
import { RELEASE_NOTE, RELEASE_NOTE_PAGE, RELEASE_NOTE_STATS } from "../contract.js";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, staffOf, type App } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { CURSOR_Q, EXPECTED_VERSION, LIMIT_Q, NOTE_BODY, NOTE_UPDATE_BODY, REASON, UUID, enumOf, obj, pageQuery, params, query } from "../schemas.js";
import { DOMAIN } from "../upstream.js";
import { out, relay, shaped } from "./common.js";

const SERVICE = DOMAIN.experience;
const NOTES = "/admin/v1/release-notes";
const NOTE_PARAMS = params({ id: UUID });

export function releaseNoteRoutes(app: App, ctx: BffContext): void {
  const exp = ctx.domains.experience;
  const one = (id: string) => `${NOTES}/${id.toLowerCase()}`;

  app.get<{ Querystring: { status?: string; cursor?: string; limit?: string } }>(
    NOTES,
    {
      config: requirePermission("whatsnew.manage"),
      schema: {
        response: out(RELEASE_NOTE_PAGE),
        querystring: query({ status: enumOf(["draft", "published", "archived"]), cursor: CURSOR_Q, limit: LIMIT_Q }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await exp.get<unknown>(NOTES, { actor: auth.actor, query: { status: req.query.status, ...pageQuery(req.query) } });
      return shaped(ctx, auth, SERVICE, RELEASE_NOTE_PAGE, body, { names: true });
    },
  );

  app.get<{ Params: { id: string } }>(
    `${NOTES}/:id`,
    { config: requirePermission("whatsnew.manage"), schema: { response: out(RELEASE_NOTE), params: NOTE_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, RELEASE_NOTE, await exp.get<unknown>(one(req.params.id), { actor: auth.actor }), { names: true });
    },
  );

  app.get<{ Params: { id: string } }>(
    `${NOTES}/:id/stats`,
    { config: requirePermission("whatsnew.manage"), schema: { response: out(RELEASE_NOTE_STATS), params: NOTE_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, RELEASE_NOTE_STATS, await exp.get<unknown>(`${one(req.params.id)}/stats`, { actor: auth.actor }));
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    NOTES,
    { config: requirePermission("whatsnew.manage"), schema: { response: out(RELEASE_NOTE), body: NOTE_BODY } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await exp.call("POST", NOTES, { actor: auth.actor, body: req.body, idempotencyKey: idempotencyKeyOf(req, false) });
      return relay(ctx, auth, reply, SERVICE, RELEASE_NOTE, res, { names: true });
    },
  );

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    `${NOTES}/:id`,
    { config: requirePermission("whatsnew.manage"), schema: { response: out(RELEASE_NOTE), params: NOTE_PARAMS, body: NOTE_UPDATE_BODY } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await exp.call("PUT", one(req.params.id), { actor: auth.actor, body: req.body });
      return relay(ctx, auth, reply, SERVICE, RELEASE_NOTE, res, { names: true });
    },
  );

  app.post<{ Params: { id: string }; Body: { expected_version: number; reason: string } }>(
    `${NOTES}/:id/publish`,
    {
      config: { ...requirePermission("whatsnew.publish"), ...requireStepUp() },
      schema: {
        response: out(RELEASE_NOTE),
        params: NOTE_PARAMS,
        body: obj({ expected_version: EXPECTED_VERSION, reason: REASON }, ["expected_version", "reason"]),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await exp.call("POST", `${one(req.params.id)}/publish`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relay(ctx, auth, reply, SERVICE, RELEASE_NOTE, res, { names: true });
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    `${NOTES}/:id/archive`,
    {
      config: { ...requirePermission("whatsnew.publish"), ...requireStepUp() },
      schema: { response: out(RELEASE_NOTE), params: NOTE_PARAMS, body: obj({ reason: REASON }, ["reason"]) },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await exp.call("POST", `${one(req.params.id)}/archive`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relay(ctx, auth, reply, SERVICE, RELEASE_NOTE, res, { names: true });
    },
  );
}
