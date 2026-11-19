/**
 * Контроль диалогов (admin.ts «ИИ, контроль диалогов, затраты», ADM-QA-01…04): журнал сессий и карточка сессии —
 * lessons `/admin/v1/lesson-sessions*`; оценки, флаги, переоценка и апелляции — assessment `/admin/v1/evaluations*`,
 * `/admin/v1/appeals*`; модели, стоимость и задержка — ai-gateway `GET /admin/v1/ai/usage?session_id=`
 * (docs/sprint4/INTERNAL_API.md §2.5, §3.4, §1.5).
 *
 * qa.read — журнал, карточка, апелляции, флаг спорной оценки (без изменения оценки); qa.transcripts — тексты реплик и
 * ответов ученика (причина ≥ 10, каждое открытие — аудит `qa.transcript_viewed` в lessons); qa.review — «взять»
 * апелляцию, а со step-up — переоценка и решение по апелляции. Права проверяются здесь до вызова домена.
 *
 * Журнал: строка lessons + сводка оценок assessment одним запросом (`GET /admin/v1/evaluations/summary?session_id=…`:
 * зачёт и флаги human_review / appealed / flagged по актуальной оценке; фильтр по флагу — после сводки, до 3 страниц
 * lessons на запрос, страница может быть короче limit) + затраты ИИ одним пакетным вызовом ai-gateway
 * `GET /admin/v1/ai/usage/by-session?session_id=…` (≤ 50, таймаут блока DASHBOARD_TIMEOUT_MS, без повторов) — только для
 * сессий, где ИИ мог работать (ai_mode full или флаги ai_used / ai_unavailable); у сессии выбором реплик вызовов нет —
 * models [], 0, null без запроса. ai-gateway недоступен, ответил ошибкой (404/503) или мусором → у этих строк
 * models [], cost_usd null (стоимость неизвестна — не 0), p95 null; журнал открывается, в лог — предупреждение.
 *
 * Карточка: три независимых блока (lessons, assessment, ai-gateway) параллельно; недоступный блок → null и
 * `errors[service] = код`; сессии нет в lessons → 404 как есть. `user_ref` — только от lessons (HMAC с секретом lessons,
 * необратим без секрета); BFF его не вычисляет, user_id сотруднику не отдаётся никогда (ревью спринта 4, R2-06).
 */
import type { FastifyReply } from "fastify";
import type { AiCall, EvaluationCard, Page, SessionCard, SessionFlag, SessionRow } from "@tilhero/contracts/admin";
import { AppError } from "@tilhero/ts-common";
import { AI_SERVICE, aiGet } from "../aiGateway.js";
import { BadValue, parseDomain, withNames } from "../codec.js";
import {
  ADMIN_APPEAL,
  ADMIN_APPEAL_DOMAIN,
  ADMIN_APPEAL_PAGE,
  ADMIN_APPEAL_PAGE_DOMAIN,
  AI_CALL_PAGE,
  EVALUATION_CARD,
  EVALUATION_CARD_DOMAIN,
  EVALUATION_CHAIN_DOMAIN,
  SESSION_CARD,
  SESSION_CARD_DOMAIN,
  SESSION_ROW_PAGE,
  SESSION_ROW_PAGE_DOMAIN,
  AI_NONE,
  AI_UNKNOWN,
  SESSION_AI_FIGURES,
  SESSION_SUMMARIES,
  TRANSCRIPT,
  aiFigures,
  mergeSummary,
  publicAppeal,
  publicEvaluation,
  type SessionAiFigures,
  type SessionCardDomain,
  type SessionRowDomain,
  type SessionSummary,
} from "../contractAi.js";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, passReplayed, staffOf, type App, type StaffAuth } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import {
  APPEAL_DECISION,
  APPEAL_STATUSES,
  BAND,
  CONTENT_KEY,
  CURSOR_Q,
  FLAG_REQUEST,
  ISO_Q,
  LIMIT_Q,
  QA_LIMIT_Q,
  REEVALUATION,
  SESSION_FLAGS,
  SESSION_KINDS,
  SESSION_OUTCOMES,
  SESSION_STATUSES,
  TRANSCRIPT_REQUEST,
  UUID,
  enumOf,
  obj,
  pageQuery,
  params,
  query,
} from "../schemas.js";
import { DOMAIN, upstreamUnavailable, type DomainResponse } from "../upstream.js";
import { out, shaped } from "./common.js";

const LESSONS = DOMAIN.lessons;
const ASSESSMENT = DOMAIN.assessment;
const SESSIONS = "/admin/v1/lesson-sessions";
const EVALUATIONS = "/admin/v1/evaluations";
const APPEALS = "/admin/v1/appeals";
const USAGE = "/admin/v1/ai/usage";
/** Страница журнала — не больше 50 строк (пакетная сводка затрат ai-gateway — до 50 сессий). */
export const QA_PAGE_MAX = 50;
/** Флаги, которые ведёт assessment (lessons по ним не фильтрует). */
const ASSESSMENT_FLAGS = new Set<string>(["appealed", "flagged"]);
/** Фильтр по флагу — после сводки assessment: страниц lessons за запрос не больше (короткая страница + курсор). */
const FILTER_SCAN_PAGES = 3;
/** Вызовов ИИ одной сессии (урок — единицы-десятки вызовов; лимит урока по деньгам; страница ai-gateway ≤ 100). */
const CALLS_PER_SESSION = 100;
const ID_PARAMS = params({ id: UUID });

/** Код ошибки блока карточки: код домена, 503 / испорченный ответ — UPSTREAM_UNAVAILABLE / UPSTREAM_BAD_RESPONSE. */
function blockCode(err: unknown): string {
  if (err instanceof BadValue) return "UPSTREAM_BAD_RESPONSE";
  const code = (err as AppError)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "UPSTREAM_UNAVAILABLE";
}

/** У сессии могли быть вызовы ИИ: полный режим или флаги ИИ. Выбор реплик (дети, ИИ выключен) — вызовов нет. */
const mayUseAi = (r: SessionRowDomain): boolean => r.ai_mode === "full" || r.flags.includes("ai_used") || r.flags.includes("ai_unavailable");

export function qaRoutes(app: App, ctx: BffContext): void {
  const lessons = ctx.domains.lessons;
  const assessment = ctx.domains.assessment;

  /** Вызовы ИИ сессии (строго по AiCall; ключ провайдера — 503 в aiGet). */
  async function sessionCalls(auth: StaffAuth, sessionId: string, timeoutMs: number): Promise<AiCall[]> {
    const body = await aiGet(ctx, USAGE, {
      actor: auth.actor,
      query: { session_id: sessionId, limit: CALLS_PER_SESSION },
      timeoutMs,
      retries: 0,
    });
    return AI_CALL_PAGE.parse(body, "$").items;
  }

  /** Затраты строк журнала одним вызовом ai-gateway (by-session); сбой → стоимость неизвестна (null), не 0. */
  async function withAiFigures(auth: StaffAuth, items: readonly SessionRowDomain[]): Promise<SessionRow[]> {
    const ids = items.filter(mayUseAi).map((r) => r.session_id);
    let figures: Map<string, SessionAiFigures> | null = new Map();
    if (ids.length) {
      try {
        const body = await aiGet(ctx, `${USAGE}/by-session`, {
          actor: auth.actor,
          query: { session_id: ids },
          timeoutMs: ctx.config.dashboardTimeoutMs,
          retries: 0,
        });
        figures = new Map(SESSION_AI_FIGURES.parse(body, "$").items.map((f) => [f.session_id, f]));
      } catch (err) {
        figures = null;
        ctx.log.warn({ upstream: AI_SERVICE, err_code: blockCode(err), rows: ids.length }, "qa sessions: ai usage unavailable, cost unknown");
      }
    }
    return items.map((row): SessionRow => {
      if (!mayUseAi(row)) return { ...row, ...AI_NONE };
      if (!figures) return { ...row, ...AI_UNKNOWN };
      const f = figures.get(row.session_id);
      return { ...row, ...(f ? { models: f.models, cost_usd: f.cost_usd, p95_latency_ms: f.p95_latency_ms } : AI_NONE) };
    });
  }

  /**
   * Сводка оценок страницы журнала одним запросом assessment. Недоступна: при фильтре по флагу — 503 {service:
   * assessment} (без сводки фильтр неверен), иначе строки остаются со значениями lessons (в лог — предупреждение).
   */
  async function sessionSummaries(auth: StaffAuth, rows: readonly SessionRowDomain[], required: boolean): Promise<Map<string, SessionSummary> | null> {
    if (rows.length === 0) return new Map();
    try {
      const body = await assessment.get<unknown>(`${EVALUATIONS}/summary`, {
        actor: auth.actor,
        query: { session_id: rows.map((r) => r.session_id) },
        timeoutMs: ctx.config.dashboardTimeoutMs,
        retries: 0,
      });
      const parsed = parseDomain(ctx, ASSESSMENT, SESSION_SUMMARIES, body);
      return new Map(parsed.items.map((x) => [x.session_id, x]));
    } catch (err) {
      if (required) throw err instanceof AppError && err.status >= 500 ? err : upstreamUnavailable(ASSESSMENT);
      ctx.log.warn({ upstream: ASSESSMENT, err_code: blockCode(err) }, "qa sessions: assessment summary unavailable, lessons values shown");
      return null;
    }
  }

  async function evaluationReply(auth: StaffAuth, reply: FastifyReply, res: DomainResponse<unknown>): Promise<FastifyReply> {
    passReplayed(reply, res);
    const e = await shaped(ctx, auth, ASSESSMENT, EVALUATION_CARD_DOMAIN, res.body, { names: true });
    return reply.status(res.status).send(publicEvaluation(e));
  }
  async function appealReply(auth: StaffAuth, reply: FastifyReply, res: DomainResponse<unknown>): Promise<FastifyReply> {
    passReplayed(reply, res);
    const a = await shaped(ctx, auth, ASSESSMENT, ADMIN_APPEAL_DOMAIN, res.body, { names: true });
    return reply.status(res.status).send(publicAppeal(a));
  }

  // ---------------------------------------------------------------- журнал сессий

  type SessionsQ = {
    from?: string;
    to?: string;
    kind?: string;
    status?: string;
    outcome?: string;
    flag?: string;
    lesson_id?: string;
    level?: string;
    cursor?: string;
    limit?: string;
  };
  app.get<{ Querystring: SessionsQ }>(
    "/admin/v1/qa/sessions",
    {
      config: requirePermission("qa.read"),
      schema: {
        response: out(SESSION_ROW_PAGE),
        querystring: query({
          from: ISO_Q,
          to: ISO_Q,
          kind: enumOf(SESSION_KINDS),
          status: enumOf(SESSION_STATUSES),
          outcome: enumOf(SESSION_OUTCOMES),
          flag: enumOf(SESSION_FLAGS),
          lesson_id: CONTENT_KEY,
          level: BAND,
          cursor: CURSOR_Q,
          limit: QA_LIMIT_Q,
        }),
      },
    },
    async (req): Promise<Page<SessionRow>> => {
      const auth = staffOf(req);
      const { from, to, kind, status, outcome, flag, lesson_id, level } = req.query;
      const limit = Number(req.query.limit ?? QA_PAGE_MAX);
      // флаги appealed / flagged ведёт assessment: lessons их не фильтрует (422 FLAG_NOT_SUPPORTED) — фильтр здесь
      const lessonsFlag = flag && !ASSESSMENT_FLAGS.has(flag) ? flag : undefined;
      const items: SessionRowDomain[] = [];
      let cursor = req.query.cursor;
      let pages = 0;
      do {
        const body = await lessons.get<unknown>(SESSIONS, {
          actor: auth.actor,
          query: { from, to, kind, status, outcome, flag: lessonsFlag, lesson_id, level, cursor, limit: limit - items.length },
        });
        const page = parseDomain(ctx, LESSONS, SESSION_ROW_PAGE_DOMAIN, body);
        const summaries = await sessionSummaries(auth, page.items, flag !== undefined && ASSESSMENT_FLAGS.has(flag));
        const merged = page.items.map((r) => mergeSummary(r, summaries?.get(r.session_id)));
        // фильтр по флагу — после сводки (актуальная оценка с учётом переоценки); страница может быть короче limit
        items.push(...(flag ? merged.filter((r) => r.flags.includes(flag as SessionFlag)) : merged));
        cursor = page.next_cursor ?? undefined;
        pages++;
      } while (flag && items.length < limit && cursor && pages < FILTER_SCAN_PAGES);

      const rows = await withAiFigures(auth, items);
      return { items: rows, next_cursor: cursor ?? null };
    },
  );

  // ---------------------------------------------------------------- карточка сессии (три независимых блока)

  app.get<{ Params: { id: string } }>(
    "/admin/v1/qa/sessions/:id",
    { config: requirePermission("qa.read"), schema: { response: out(SESSION_CARD), params: ID_PARAMS } },
    async (req): Promise<SessionCard> => {
      const auth = staffOf(req);
      const id = req.params.id.toLowerCase();
      const block = { timeoutMs: ctx.config.upstreamTimeoutMs, retries: 0 };
      const [ls, ev, ai] = await Promise.allSettled([
        lessons.get<unknown>(`${SESSIONS}/${id}`, { actor: auth.actor, ...block }).then((b) => SESSION_CARD_DOMAIN.parse(b, "$")),
        assessment
          .get<unknown>(EVALUATIONS, { actor: auth.actor, query: { session_id: id }, ...block })
          .then((b) => EVALUATION_CHAIN_DOMAIN.parse(b, "$").items),
        sessionCalls(auth, id, ctx.config.upstreamTimeoutMs),
      ]);
      // сессии нет — карточки нет (404 домена как есть); прочие сбои lessons — блок недоступен
      if (ls.status === "rejected" && (ls.reason as AppError)?.status === 404) throw ls.reason;
      const errors: SessionCard["errors"] = {};
      const fail = (service: keyof SessionCard["errors"], err: unknown) => {
        errors[service] = blockCode(err);
        const field = err instanceof BadValue ? err.path.replace(/[^\w.$[\]-]/g, "?").slice(0, 200) : undefined;
        ctx.log.warn({ upstream: service, err_code: errors[service], ...(field ? { field } : {}) }, "qa session card: block unavailable");
      };
      if (ls.status === "rejected") fail("lessons", ls.reason);
      if (ev.status === "rejected") fail("assessment", ev.reason);
      if (ai.status === "rejected") fail("ai-gateway", ai.reason);
      const calls = ai.status === "fulfilled" ? ai.value : null;

      let session: SessionCard["session"] = null;
      if (ls.status === "fulfilled") {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { user_id, user_ref, ...rest } = ls.value as SessionCardDomain;
        if (user_ref) session = { ...rest, ...(calls ? aiFigures(calls) : AI_UNKNOWN), user_ref };
        else fail("lessons", new BadValue("$.user_ref"));
      }
      let evaluations: EvaluationCard[] | null = null;
      if (ev.status === "fulfilled") {
        const named = await withNames(ctx, auth, ev.value);
        evaluations = named.map(publicEvaluation).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      }
      return { session, evaluations, ai_calls: calls, errors };
    },
  );

  /** Тексты реплик и ответов (qa.transcripts, причина ≥ 10): аудит qa.transcript_viewed пишет lessons по actor. */
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/admin/v1/qa/sessions/:id/transcript",
    { config: requirePermission("qa.transcripts"), schema: { response: out(TRANSCRIPT), params: ID_PARAMS, body: TRANSCRIPT_REQUEST } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await lessons.call("POST", `${SESSIONS}/${req.params.id.toLowerCase()}/transcript`, { actor: auth.actor, body: req.body });
      return reply.status(res.status).send(await shaped(ctx, auth, LESSONS, TRANSCRIPT, res.body));
    },
  );

  // ---------------------------------------------------------------- оценки: флаг, переоценка

  /** Флаг спорной оценки (qa.read) — оценка не меняется → EvaluationCard. */
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/admin/v1/qa/evaluations/:id/flag",
    { config: requirePermission("qa.read"), schema: { response: out(EVALUATION_CARD), params: ID_PARAMS, body: FLAG_REQUEST } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await assessment.call("POST", `${EVALUATIONS}/${req.params.id.toLowerCase()}/flag`, { actor: auth.actor, body: req.body });
      return evaluationReply(auth, reply, res);
    },
  );

  /** Переоценка (qa.review, step-up) → новая запись цепочки; 409 EVALUATION_SUPERSEDED | SELF_REEVALUATION — как есть. */
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/admin/v1/qa/evaluations/:id/reevaluate",
    {
      config: { ...requirePermission("qa.review"), ...requireStepUp() },
      schema: { response: out(EVALUATION_CARD), params: ID_PARAMS, body: REEVALUATION },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await assessment.call("POST", `${EVALUATIONS}/${req.params.id.toLowerCase()}/reevaluate`, {
        actor: auth.actor,
        body: { appeal_id: null, ...req.body },
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return evaluationReply(auth, reply, res);
    },
  );

  // ---------------------------------------------------------------- апелляции

  app.get<{ Querystring: { status?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/qa/appeals",
    {
      config: requirePermission("qa.read"),
      schema: { response: out(ADMIN_APPEAL_PAGE), querystring: query({ status: enumOf(APPEAL_STATUSES), cursor: CURSOR_Q, limit: LIMIT_Q }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await assessment.get<unknown>(APPEALS, { actor: auth.actor, query: { status: req.query.status, ...pageQuery(req.query) } });
      const page = await shaped(ctx, auth, ASSESSMENT, ADMIN_APPEAL_PAGE_DOMAIN, body, { names: true });
      return { items: page.items.map(publicAppeal), next_cursor: page.next_cursor };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/v1/qa/appeals/:id/take",
    { config: requirePermission("qa.review"), schema: { response: out(ADMIN_APPEAL), params: ID_PARAMS, body: obj({}) } },
    async (req, reply) => {
      const auth = staffOf(req);
      return appealReply(auth, reply, await assessment.call("POST", `${APPEALS}/${req.params.id.toLowerCase()}/take`, { actor: auth.actor, body: {} }));
    },
  );

  /** Решение (qa.review, step-up): upheld | corrected (+ new_evaluation_id переоценки) → уведомление ученику. */
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/admin/v1/qa/appeals/:id/decide",
    {
      config: { ...requirePermission("qa.review"), ...requireStepUp() },
      schema: { response: out(ADMIN_APPEAL), params: ID_PARAMS, body: APPEAL_DECISION },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await assessment.call("POST", `${APPEALS}/${req.params.id.toLowerCase()}/decide`, {
        actor: auth.actor,
        body: { new_evaluation_id: null, ...req.body },
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return appealReply(auth, reply, res);
    },
  );
}
