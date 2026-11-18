/**
 * Очередь проверки событий (NEEDS_REVIEW) — прокси в events (docs/sprint4/INTERNAL_API.md §6, §7), право events.review.
 * Решения (accept / reject / correct) — POST с CSRF; Idempotency-Key клиента пробрасывается в events (повтор того же
 * решения с тем же ключом → тот же ответ), как у POST staff и эскалаций. Каждое решение несёт expected_content_hash —
 * content_hash карточки, которую видел оператор: новый кандидат того же источника перезаписал факты → 409 REVIEW_CHANGED
 * {content_hash} (admin-web перечитывает карточку). Несовпадение expected_status → 409 REVIEW_ALREADY_DECIDED, basis_url
 * не с домена источника → 422 REVIEW_BASIS_URL_NOT_ALLOWED — коды домена как есть. decided_by_name — имя сотрудника
 * (admin-identity staff/lookup).
 *
 * Исправление 5.1 (FEEDBACK_5_1 §F): статус EXPIRED («Не подтверждено») в фильтре; массовое отклонение
 * `POST /admin/v1/review/bulk-reject` → events `POST /internal/v1/review:bulk-reject`, возврат в очередь
 * `POST /admin/v1/review/:id/reopen` → `…/{id}:reopen` и `POST /admin/v1/review/bulk-reopen` → `…/review:bulk-reopen`.
 * Право — events.review; step-up не нужен (как у одиночных решений: requireStepUp у них нет). У массовых команд
 * Idempotency-Key обязателен (admin-web создаёт ключ на действие). Повтор review_id в items → 422 VALIDATION_ERROR.
 * Ответ домена {results} проверяется: review_id — UUID из запроса, статус — REJECTED/OPEN/SKIPPED, код — UPPER_SNAKE;
 * иначе 503 UPSTREAM_UNAVAILABLE {service: "events"} (решения уже приняты — admin-web перечитает список).
 */
import type { Page, ReviewBulkItemStatus, ReviewBulkResult, ReviewDetail, ReviewItem } from "@tilhero/contracts/admin";
import { upstreamUnavailable } from "../upstream.js";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, staffOf, validationError, type App } from "../http.js";
import { requirePermission } from "../rbac.js";
import {
  COUNTRY,
  CONTENT_HASH,
  CURSOR_Q,
  DECISION_NOTE,
  EXPECTED_OPEN,
  HTTPS_URL,
  LIMIT_Q,
  PROVIDER_Q,
  REVIEW_BULK_REJECT,
  REVIEW_BULK_REOPEN,
  REVIEW_CORRECTION,
  REVIEW_REJECT_REASON,
  REVIEW_REOPEN,
  REVIEW_STATUS,
  UUID,
  obj,
  pageQuery,
  params,
  query,
} from "../schemas.js";
import { ok, REVIEW_BULK_RESULT, REVIEW_DECIDED, REVIEW_DETAIL, REVIEW_PAGE, REVIEW_REJECTED } from "../responses.js";
import { namedReview } from "./staffNames.js";

const ID_PARAMS = params({ id: UUID });

type Decision = "accept" | "reject" | "correct";
const BASE = { expected_status: EXPECTED_OPEN, expected_content_hash: CONTENT_HASH, note: DECISION_NOTE };
const BASE_REQUIRED = ["expected_status", "expected_content_hash", "note"];
const BODIES: Record<Decision, Record<string, unknown>> = {
  accept: obj(BASE, BASE_REQUIRED),
  reject: obj({ ...BASE, reason_code: REVIEW_REJECT_REASON }, [...BASE_REQUIRED, "reason_code"]),
  correct: obj({ ...BASE, changes: REVIEW_CORRECTION, basis_url: HTTPS_URL }, [...BASE_REQUIRED, "changes", "basis_url"]),
};

/**
 * Ответ решения в форме admin.ts: {review, event_id?}. Если events вернул сам ReviewDetail (без обёртки), он
 * заворачивается, event_id берётся из него.
 */
export function decisionBody(decision: Decision, body: unknown): { review: ReviewDetail; event_id?: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const review = (b.review && typeof b.review === "object" ? b.review : b) as ReviewDetail;
  if (decision === "reject") return { review };
  const eventId = typeof b.event_id === "string" ? b.event_id : review.event_id;
  return { review, event_id: eventId };
}

/** Таймаут массовой команды events (до 100 строк, каждая — как одиночное решение). */
export const BULK_TIMEOUT_MS = 30_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Повтор review_id в items массовой команды → 422 (одна карточка — одно решение). */
export function assertUniqueItems(items: Array<{ review_id: string }>): void {
  const seen = new Set<string>();
  items.forEach((x, n) => {
    const id = x.review_id.toLowerCase();
    if (seen.has(id)) throw validationError(`items.${n}.review_id`, "review_id повторяется");
    seen.add(id);
  });
}

/**
 * Ответ events на массовую команду → ReviewBulkResult: ровно review_id из запроса (по одной строке на каждый), статус
 * `done` (REJECTED / OPEN) или SKIPPED, код UPPER_SNAKE или null. Что-то не так — null (маршрут отвечает 503).
 */
export function normalizeBulkResult(body: unknown, requested: readonly string[], done: "REJECTED" | "OPEN"): ReviewBulkResult | null {
  const rows = body && typeof body === "object" && Array.isArray((body as { results?: unknown }).results) ? (body as { results: unknown[] }).results : null;
  if (!rows) return null;
  const want = new Set(requested.map((x) => x.toLowerCase()));
  const seen = new Set<string>();
  const out: ReviewBulkResult["results"] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") return null;
    const x = r as Record<string, unknown>;
    const id = typeof x.review_id === "string" && UUID_RE.test(x.review_id) ? x.review_id.toLowerCase() : null;
    if (!id || !want.has(id) || seen.has(id)) return null;
    const status: ReviewBulkItemStatus | null = x.status === done ? done : x.status === "SKIPPED" ? "SKIPPED" : null;
    if (!status) return null;
    const code = typeof x.code === "string" && CODE_RE.test(x.code) ? x.code : null;
    seen.add(id);
    out.push({ review_id: id, status, code: status === "SKIPPED" ? (code ?? "SKIPPED") : null });
  }
  // по строке на каждый запрошенный review_id: молча потерянная строка — не «итог», а сбой домена
  if (seen.size !== want.size) return null;
  return { results: out };
}

export function reviewRoutes(app: App, ctx: BffContext): void {
  const events = ctx.domains.events;
  const path = (id: string) => `/internal/v1/review/${id.toLowerCase()}`;

  app.get<{ Querystring: { status?: string; provider?: string; country?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/review",
    {
      config: requirePermission("events.review"),
      schema: {
        response: ok(REVIEW_PAGE),
        querystring: query({ status: REVIEW_STATUS, provider: PROVIDER_Q, country: COUNTRY, cursor: CURSOR_Q, limit: LIMIT_Q }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const { status, provider, country } = req.query;
      return events.get<Page<ReviewItem>>("/internal/v1/review", {
        actor: auth.actor,
        query: { status, provider, country, ...pageQuery(req.query) },
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/v1/review/:id",
    { config: requirePermission("events.review"), schema: { response: ok(REVIEW_DETAIL), params: ID_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return namedReview(ctx, auth, await events.get<ReviewDetail>(path(req.params.id), { actor: auth.actor }));
    },
  );

  // массовые команды — до маршрутов с :id (разные сегменты, но так нагляднее)
  for (const bulk of ["bulk-reject", "bulk-reopen"] as const) {
    app.post<{ Body: { items: Array<{ review_id: string }> } & Record<string, unknown> }>(
      `/admin/v1/review/${bulk}`,
      {
        config: requirePermission("events.review"),
        schema: { response: ok(REVIEW_BULK_RESULT), body: bulk === "bulk-reject" ? REVIEW_BULK_REJECT : REVIEW_BULK_REOPEN },
      },
      async (req, reply) => {
        const auth = staffOf(req);
        const idempotencyKey = idempotencyKeyOf(req, true);
        assertUniqueItems(req.body.items);
        const items = req.body.items.map((x) => ({ ...x, review_id: x.review_id.toLowerCase() }));
        // до 100 строк со своими блокировками — долго; без автоповторов: повтор с тем же ключом — только по явному
        // действию сотрудника (admin-web держит ключ, пока диалог открыт)
        const res = await events.call("POST", `/internal/v1/review:${bulk}`, {
          actor: auth.actor,
          body: { ...req.body, items },
          idempotencyKey,
          timeoutMs: BULK_TIMEOUT_MS,
          retries: 0,
        });
        const out = normalizeBulkResult(res.body, items.map((x) => x.review_id), bulk === "bulk-reject" ? "REJECTED" : "OPEN");
        if (!out) {
          ctx.log.warn({ upstream: "events", upstream_code: "UPSTREAM_BAD_RESPONSE", route: bulk }, "bulk review result rejected by normalization");
          throw upstreamUnavailable("events");
        }
        return reply.status(200).send(out);
      },
    );
  }

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/admin/v1/review/:id/reopen",
    { config: requirePermission("events.review"), schema: { response: ok(REVIEW_REJECTED), params: ID_PARAMS, body: REVIEW_REOPEN } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await events.call("POST", `${path(req.params.id)}:reopen`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      const out = decisionBody("reject", res.body);
      return reply.status(res.status).send({ review: await namedReview(ctx, auth, out.review) });
    },
  );

  for (const decision of ["accept", "reject", "correct"] as const) {
    app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
      `/admin/v1/review/:id/${decision}`,
      {
        config: requirePermission("events.review"),
        schema: {
          response: ok(decision === "reject" ? REVIEW_REJECTED : REVIEW_DECIDED),
          params: ID_PARAMS,
          body: BODIES[decision],
        },
      },
      async (req, reply) => {
        const auth = staffOf(req);
        const res = await events.call(`POST`, `${path(req.params.id)}:${decision}`, {
          actor: auth.actor,
          body: req.body,
          idempotencyKey: idempotencyKeyOf(req, false),
        });
        const out = decisionBody(decision, res.body);
        return reply.status(res.status).send({ ...out, review: await namedReview(ctx, auth, out.review) });
      },
    );
  }
}
