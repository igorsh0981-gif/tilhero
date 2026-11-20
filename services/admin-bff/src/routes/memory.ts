/**
 * Память ученика и аналитика забывания (admin.ts «Память, словарь курса, чтение»; memory `/admin/v1/memory/*`, пути
 * совпадают — docs/sprint5/INTERNAL_API.md §1.11).
 *
 * memory.read — сводка ученика (карточки по статусам, к сроку, просрочено, проверки удержания), карточки ученика,
 * карточка с историей планирования (+ следующие страницы истории); memory.manage + step-up — ручная правка ОДНОЙ
 * карточки (перенос срока, сброс, заморозка, разморозка; причина ≥ 10; строку истории `actor: staff` и аудит
 * `memory.card_adjusted` пишет memory); memory.read | dashboard.read — аналитика забывания (только агрегаты: группы
 * меньше 5 учеников скрыты); dashboard.read — блок обзора `memory/stats`. Права проверяются здесь до вызова домена,
 * memory — повторно по actor. Цитата ошибки ученика в ответы не попадает (contractMemory.ts).
 *
 * Ошибки memory — как есть: 409 CARD_STATE {status}, 422 DUE_AT_RANGE, 404 MEMORY_LEARNER_NOT_FOUND | CARD_NOT_FOUND.
 * Имена: `actor_id` строки истории (memory прошлой версии — `actor: "staff:<uuid>"`) → `actor_name` (staff/lookup).
 *
 * Блок обзора `memory`: статистика memory + очередь переводов ИИ (`ai_glosses_pending`) у catalog — сначала
 * `GET /admin/v1/glossary/stats`, при 404 — поле `ai_glosses_pending` сводки `GET /admin/v1/content/summary`.
 * catalog недоступен или ответил иначе — блок остаётся доступным с `ai_glosses_pending: null`, в лог — предупреждение;
 * memory недоступен — блок недоступен (`service: memory`), обзор открывается.
 */
import type { MemoryStats, Period } from "@tilhero/contracts/admin";
import { AppError, type Actor } from "@tilhero/ts-common";
import { BadValue, parseDomain, type Codec } from "../codec.js";
import {
  ADMIN_CARD_DETAIL,
  ADMIN_CARD_PAGE,
  FORGETTING_ANALYTICS,
  GLOSSES_PENDING,
  LEARNER_MEMORY_SUMMARY,
  MEMORY_STATS,
  REVIEW_LOG_PAGE,
} from "../contractMemory.js";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, passReplayed, staffOf, type App } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import {
  ANALYTICS_PERIOD,
  CARD_ACTION,
  CARD_KIND,
  CARD_STATUS,
  CURSOR_Q,
  LIMIT_Q,
  PAIR_ID,
  PERIOD,
  UUID,
  pageQuery,
  params,
  query,
} from "../schemas.js";
import { DOMAIN } from "../upstream.js";
import { out, shaped } from "./common.js";

const SERVICE = DOMAIN.memory;
const BASE = "/admin/v1/memory";
const LEARNER_PARAMS = params({ userId: UUID });
const CARD_PARAMS = params({ cardId: UUID });

type PageQ = { cursor?: string; limit?: string };

/** Код ошибки для лога (без значений): код домена, испорченный ответ, недоступность. */
function errCode(err: unknown): string {
  if (err instanceof BadValue) return "UPSTREAM_BAD_RESPONSE";
  const code = (err as AppError)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

/**
 * Очередь переводов ИИ (catalog): `glossary/stats`, при 404 — поле сводки контента. null — неизвестно (catalog
 * недоступен, ошибка, нет поля) → в MemoryStats null.
 */
async function glossesPending(ctx: BffContext, actor: Actor, timeoutMs: number): Promise<number | null> {
  const catalog = ctx.domains.catalog;
  const opts = { actor, timeoutMs, retries: 0 };
  const parse = (c: Codec<{ ai_glosses_pending: number }>, body: unknown) => c.parse(body, "$").ai_glosses_pending;
  try {
    return parse(GLOSSES_PENDING, await catalog.get<unknown>("/admin/v1/glossary/stats", opts));
  } catch (err) {
    if (!(err instanceof AppError && err.status === 404)) {
      ctx.log.warn({ upstream: DOMAIN.catalog, err_code: errCode(err) }, "memory stats: ai glosses pending unavailable");
      return null;
    }
  }
  try {
    return parse(GLOSSES_PENDING, await catalog.get<unknown>("/admin/v1/content/summary", opts));
  } catch (err) {
    ctx.log.warn({ upstream: DOMAIN.catalog, err_code: errCode(err) }, "memory stats: ai glosses pending unavailable (summary)");
    return null;
  }
}

/**
 * MemoryStats за период: memory (ошибка — как есть, вызывающий решает: блок обзора недоступен или 503) + очередь
 * переводов ИИ из catalog параллельно. Период — запрошенный.
 */
export async function loadMemoryStats(ctx: BffContext, actor: Actor, period: Period, timeoutMs: number): Promise<MemoryStats> {
  const [stats, pending] = await Promise.all([
    ctx.domains.memory
      .get<unknown>(`${BASE}/stats`, { actor, query: { period }, timeoutMs, retries: 0 })
      .then((b) => parseDomain(ctx, SERVICE, MEMORY_STATS, b)),
    glossesPending(ctx, actor, timeoutMs),
  ]);
  return { ...stats, period, ai_glosses_pending: pending };
}

export function memoryRoutes(app: App, ctx: BffContext): void {
  const memory = ctx.domains.memory;
  const cardPath = (id: string) => `${BASE}/cards/${id.toLowerCase()}`;

  // ---------------------------------------------------------------- ученик

  app.get<{ Params: { userId: string } }>(
    `${BASE}/learners/:userId`,
    { config: requirePermission("memory.read"), schema: { response: out(LEARNER_MEMORY_SUMMARY), params: LEARNER_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      const body = await memory.get<unknown>(`${BASE}/learners/${req.params.userId.toLowerCase()}`, { actor: auth.actor });
      return shaped(ctx, auth, SERVICE, LEARNER_MEMORY_SUMMARY, body);
    },
  );

  app.get<{ Params: { userId: string }; Querystring: { status?: string; kind?: string } & PageQ }>(
    `${BASE}/learners/:userId/cards`,
    {
      config: requirePermission("memory.read"),
      schema: {
        response: out(ADMIN_CARD_PAGE),
        params: LEARNER_PARAMS,
        querystring: query({ status: CARD_STATUS, kind: CARD_KIND, cursor: CURSOR_Q, limit: LIMIT_Q }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const { status, kind } = req.query;
      const body = await memory.get<unknown>(`${BASE}/learners/${req.params.userId.toLowerCase()}/cards`, {
        actor: auth.actor,
        query: { status, kind, ...pageQuery(req.query) },
      });
      return shaped(ctx, auth, SERVICE, ADMIN_CARD_PAGE, body);
    },
  );

  // ---------------------------------------------------------------- карточка и история планирования

  app.get<{ Params: { cardId: string } }>(
    `${BASE}/cards/:cardId`,
    { config: requirePermission("memory.read"), schema: { response: out(ADMIN_CARD_DETAIL), params: CARD_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, ADMIN_CARD_DETAIL, await memory.get<unknown>(cardPath(req.params.cardId), { actor: auth.actor }), {
        names: true,
      });
    },
  );

  app.get<{ Params: { cardId: string }; Querystring: PageQ }>(
    `${BASE}/cards/:cardId/log`,
    {
      config: requirePermission("memory.read"),
      schema: { response: out(REVIEW_LOG_PAGE), params: CARD_PARAMS, querystring: query({ cursor: CURSOR_Q, limit: LIMIT_Q }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await memory.get<unknown>(`${cardPath(req.params.cardId)}/log`, { actor: auth.actor, query: pageQuery(req.query) });
      return shaped(ctx, auth, SERVICE, REVIEW_LOG_PAGE, body, { names: true });
    },
  );

  /** Ручная правка одной карточки (memory.manage, step-up) → AdminCardDetail; массовых действий нет. */
  app.post<{ Params: { cardId: string }; Body: Record<string, unknown> }>(
    `${BASE}/cards/:cardId/actions`,
    {
      config: { ...requirePermission("memory.manage"), ...requireStepUp() },
      schema: { response: out(ADMIN_CARD_DETAIL), params: CARD_PARAMS, body: CARD_ACTION },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await memory.call("POST", `${cardPath(req.params.cardId)}/actions`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      passReplayed(reply, res);
      return reply.status(res.status).send(await shaped(ctx, auth, SERVICE, ADMIN_CARD_DETAIL, res.body, { names: true }));
    },
  );

  // ---------------------------------------------------------------- аналитика и обзор

  app.get<{ Querystring: { pair_id?: string; period?: string } }>(
    `${BASE}/analytics`,
    {
      config: requirePermission("memory.read", "dashboard.read"),
      schema: { response: out(FORGETTING_ANALYTICS), querystring: query({ pair_id: PAIR_ID, period: ANALYTICS_PERIOD }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await memory.get<unknown>(`${BASE}/analytics`, {
        actor: auth.actor,
        query: { pair_id: req.query.pair_id, period: req.query.period ?? "30d" },
      });
      return shaped(ctx, auth, SERVICE, FORGETTING_ANALYTICS, body);
    },
  );

  /** Блок обзора отдельно (dashboard.read): memory недоступен → 503 {service: memory}; catalog — ai_glosses_pending null. */
  app.get<{ Querystring: { period?: Period } }>(
    `${BASE}/stats`,
    { config: requirePermission("dashboard.read"), schema: { response: out(MEMORY_STATS), querystring: query({ period: PERIOD }) } },
    async (req) => {
      const auth = staffOf(req);
      return loadMemoryStats(ctx, auth.actor, req.query.period ?? "today", ctx.config.upstreamTimeoutMs);
    },
  );
}
