/**
 * Словарь курса (admin.ts «Память, словарь курса, чтение»; catalog `/admin/v1/glossary*`, пути совпадают —
 * docs/sprint5/INTERNAL_API.md §2.5).
 *
 * content.read — список (очередь переводов ИИ — `review_status=pending`, сортирует catalog по числу мест в контенте)
 * и карточка статьи с историей; dashboard.read | content.read — счётчики `stats?pair_id=`; glossary.manage — статья методиста, правка (If-Match: updated_at — передаётся в catalog
 * как есть: без него 428 IF_MATCH_REQUIRED, устаревший — 409 VERSION_CONFLICT решает домен), решение по переводу ИИ
 * (approve | correct | reject) и архив статьи методиста. Без step-up (PLAN спринта 5: правка действует сразу, каждая —
 * в истории статьи и в аудите `glossary.*` catalog). Права проверяются здесь до вызова домена, catalog — повторно.
 *
 * Ошибки catalog — как есть: 409 FORM_TAKEN {entry_id, form}, NOT_PENDING, VERSION_CONFLICT, ENTRY_ARCHIVED,
 * COURSE_ENTRY_LOCKED, OVERRIDE_COURSE_ONLY, ARCHIVE_NOT_ALLOWED {source}; 422 GLOSSARY_INVALID {errors};
 * 428 IF_MATCH_REQUIRED; 404 GLOSSARY_ENTRY_NOT_FOUND.
 * Имена: `updated_by` → `updated_by_name`, `history[].by` → `by_name` (staff/lookup; сид — «Сид (начальное наполнение)»).
 */
import type { FastifyReply } from "fastify";
import { GLOSSARY_DETAIL, GLOSSARY_ROW_PAGE, GLOSSARY_STATS } from "../contractMemory.js";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, ifMatchOf, passReplayed, staffOf, type App, type StaffAuth } from "../http.js";
import { requirePermission } from "../rbac.js";
import { NO_CONTENT } from "../responses.js";
import {
  CURSOR_Q,
  GLOSSARY_CREATE,
  GLOSSARY_PATCH,
  GLOSSARY_REVIEW,
  GLOSSARY_REVIEW_STATUS,
  GLOSSARY_SOURCE,
  LIMIT_Q,
  PAIR_ID,
  REASON_ONLY,
  UUID,
  pageQuery,
  params,
  query,
  str,
} from "../schemas.js";
import { DOMAIN, type DomainResponse } from "../upstream.js";
import { out, shaped } from "./common.js";

const SERVICE = DOMAIN.catalog;
const BASE = "/admin/v1/glossary";
const ENTRY_PARAMS = params({ entryId: UUID });

type EntryP = { entryId: string };
type ListQ = { pair_id?: string; q?: string; source?: string; review_status?: string; cursor?: string; limit?: string };

export function glossaryRoutes(app: App, ctx: BffContext): void {
  const catalog = ctx.domains.catalog;
  const entryPath = (p: EntryP) => `${BASE}/${p.entryId.toLowerCase()}`;

  /** Ответ команды catalog → GlossaryDetail с именами, статус домена и Idempotent-Replayed. */
  async function detailReply(auth: StaffAuth, reply: FastifyReply, res: DomainResponse<unknown>): Promise<FastifyReply> {
    passReplayed(reply, res);
    return reply.status(res.status).send(await shaped(ctx, auth, SERVICE, GLOSSARY_DETAIL, res.body, { names: true }));
  }

  app.get<{ Querystring: ListQ }>(
    BASE,
    {
      config: requirePermission("content.read"),
      schema: {
        response: out(GLOSSARY_ROW_PAGE),
        querystring: query({
          pair_id: PAIR_ID,
          q: str(1, 100),
          source: GLOSSARY_SOURCE,
          review_status: GLOSSARY_REVIEW_STATUS,
          cursor: CURSOR_Q,
          limit: LIMIT_Q,
        }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const { pair_id, q, source, review_status } = req.query;
      const body = await catalog.get<unknown>(BASE, { actor: auth.actor, query: { pair_id, q, source, review_status, ...pageQuery(req.query) } });
      return shaped(ctx, auth, SERVICE, GLOSSARY_ROW_PAGE, body, { names: true });
    },
  );

  /** Счётчики словаря (очередь переводов ИИ, решения, статьи по источникам) — экран словаря и обзор. До /:entryId. */
  app.get<{ Querystring: { pair_id?: string } }>(
    `${BASE}/stats`,
    {
      config: requirePermission("dashboard.read", "content.read"),
      schema: { response: out(GLOSSARY_STATS), querystring: query({ pair_id: PAIR_ID }) },
    },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, GLOSSARY_STATS, await catalog.get<unknown>(`${BASE}/stats`, { actor: auth.actor, query: { pair_id: req.query.pair_id } }));
    },
  );

  app.get<{ Params: EntryP }>(
    `${BASE}/:entryId`,
    { config: requirePermission("content.read"), schema: { response: out(GLOSSARY_DETAIL), params: ENTRY_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, GLOSSARY_DETAIL, await catalog.get<unknown>(entryPath(req.params), { actor: auth.actor }), { names: true });
    },
  );

  /** Статья методиста → 201 GlossaryDetail; занятая форма → 409 FORM_TAKEN {entry_id} catalog. */
  app.post<{ Body: Record<string, unknown> }>(
    BASE,
    { config: requirePermission("glossary.manage"), schema: { response: out(GLOSSARY_DETAIL), body: GLOSSARY_CREATE } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("POST", BASE, { actor: auth.actor, body: req.body, idempotencyKey: idempotencyKeyOf(req, false) });
      return detailReply(auth, reply, res);
    },
  );

  /** Правка: methodist и ai — поля, course — только override (null — снять); If-Match: updated_at статьи. */
  app.patch<{ Params: EntryP; Body: Record<string, unknown> }>(
    `${BASE}/:entryId`,
    { config: requirePermission("glossary.manage"), schema: { response: out(GLOSSARY_DETAIL), params: ENTRY_PARAMS, body: GLOSSARY_PATCH } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("PATCH", entryPath(req.params), {
        actor: auth.actor,
        body: req.body,
        headers: ifMatchOf(req.headers["if-match"]),
      });
      return detailReply(auth, reply, res);
    },
  );

  /** Решение по переводу ИИ; не ai или уже решённая → 409 NOT_PENDING catalog. */
  app.post<{ Params: EntryP; Body: Record<string, unknown> }>(
    `${BASE}/:entryId/review`,
    { config: requirePermission("glossary.manage"), schema: { response: out(GLOSSARY_DETAIL), params: ENTRY_PARAMS, body: GLOSSARY_REVIEW } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("POST", `${entryPath(req.params)}/review`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return detailReply(auth, reply, res);
    },
  );

  /** Архив статьи методиста (формы освобождаются) → 204; course и ai → 409 ARCHIVE_NOT_ALLOWED {source} catalog. */
  app.delete<{ Params: EntryP; Body: { reason: string } }>(
    `${BASE}/:entryId`,
    { config: requirePermission("glossary.manage"), schema: { response: NO_CONTENT, params: ENTRY_PARAMS, body: REASON_ONLY } },
    async (req, reply) => {
      const auth = staffOf(req);
      await catalog.call("DELETE", entryPath(req.params), { actor: auth.actor, body: req.body });
      return reply.status(204).send();
    },
  );
}
