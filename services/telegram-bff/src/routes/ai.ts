/**
 * Спринт 7 (INTERNAL_API §5): AI-консьерж — переписки, ход (SSE-прокси или запасной JSON), квота.
 *
 * Без AI_CONCIERGE_URL все /v1/ai/* → 503 FEATURE_UNAVAILABLE {feature: "ai"} (Mini App прячет кнопку по
 * GET /v1/ai/quota). Ходы (messages, actions) — лимит AI_RATE_PER_MINUTE (6) на пользователя сверх суточной квоты.
 * Ограничения профиля (constraints) и язык BFF берёт сам; trip_params — схема тела recalculate + selected_tier.
 */
import { once } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AiSseEvent } from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import {
  AI_EVENTS,
  SseParser,
  aiUnavailable,
  constraintsOf,
  sseEventOf,
  sseFrame,
  syntheticError,
  type Constraints,
} from "../ai.js";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, schemaErrors, type App } from "../http.js";
import { loadPrefs, loadUser } from "../personal.js";
import {
  AI_TOOLS,
  AiActionParamsSchema,
  AiActionRequestSchema,
  AiConversationParamsSchema,
  AiConversationSchema,
  AiCreateConversationSchema,
  AiMessageRequestSchema,
  AiQuotaSchema,
  AiTurnResultSchema,
  UUID_RE,
} from "../schemas.js";

const TAG = ["ai"];
const user = { access: "user" } as const;
const AI_TOOL_SET: ReadonlySet<string> = new Set(AI_TOOLS);

const IdemHeaders = {
  type: "object",
  properties: { "idempotency-key": { type: "string", description: "UUID; повтор с тем же ключом — та же переписка" } },
} as const;

const conversationNotFound = () => new AppError(404, "AI_CONVERSATION_NOT_FOUND", "Диалог не найден");
/** Неверный conversationId (не UUID) — как несуществующая переписка. */
const conversationParams = schemaErrors([{ context: "params", status: 404, code: "AI_CONVERSATION_NOT_FOUND", message: "Диалог не найден" }]);

function validation(field: string, rule: string): AppError {
  return new AppError(422, "VALIDATION_ERROR", "Некорректные данные запроса", {
    in: "body",
    field,
    errors: [{ field, rule, message: rule, params: {} }],
  });
}

const SSE_DESC =
  "Ответ — text/event-stream: события tool_call, tool_result, fact, delta, done | error (AiSseEvent; каждое проверено по " +
  "схеме, не по схеме — отбрасывается), heartbeat «: ping». Поток оборвался без done/error — BFF присылает error " +
  "(AI_PROVIDER_UNAVAILABLE | AI_TIMEOUT, retryable) — перечитайте переписку. «Accept: application/json» — тот же ход " +
  "целиком (AiTurnResult, запасной путь). До стрима — JSON-ошибки: 404 AI_CONVERSATION_NOT_FOUND, 409 AI_TURN_IN_PROGRESS | " +
  "AI_CONCIERGE_PAUSED, 422 VALIDATION_ERROR | AI_TOOL_NOT_ALLOWED, 429 AI_QUOTA_EXCEEDED {limit, used, level, resets_at} | " +
  "AI_BUDGET_EXHAUSTED {limit} | RATE_LIMITED (6 ходов в минуту), 503 AI_BUSY | AI_PROVIDER_UNAVAILABLE | FEATURE_UNAVAILABLE.";

export function aiRoutes(app: App, ctx: BffContext): void {
  const ai = ctx.concierge;

  const need = () => {
    if (!ai.configured) throw aiUnavailable();
  };

  /** Ограничения профиля и язык: без preferences ход был бы неверным (нет городов вылета, бюджета) — честнее 503. */
  const profile = async (userId: string): Promise<{ constraints: Constraints; lang: "ru" | "en" }> => {
    const [prefs, u] = await Promise.all([loadPrefs(ctx.domains.preferences, userId), loadUser(ctx.domains.identity, userId)]);
    if (!prefs) throw new AppError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен, повторите позже", { service: "preferences" });
    return { constraints: constraintsOf(prefs, u.lang), lang: u.lang };
  };

  const idemKey = (req: FastifyRequest): string => {
    const raw = req.headers["idempotency-key"];
    const key = Array.isArray(raw) ? undefined : raw?.trim();
    if (key && UUID_RE.test(key)) return key.toLowerCase();
    throw new AppError(422, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key (UUID)");
  };

  /** Ход: лимит, профиль, затем поток или запасной JSON. */
  const turn = async (req: FastifyRequest, reply: FastifyReply, conversationId: string, payload: Record<string, unknown>) => {
    const { userId } = authOf(req);
    need();
    await ctx.limiter.enforce("tg.ai", userId);
    const { constraints, lang } = await profile(userId);
    const body = { ...payload, constraints, lang };
    const accept = String(req.headers.accept ?? "").toLowerCase();
    if (accept.includes("application/json") && !accept.includes("text/event-stream")) {
      return ai.turnJson(userId, conversationId, body);
    }
    await proxyStream(ctx, req, reply, userId, conversationId, body);
    return reply;
  };

  app.post(
    "/v1/ai/conversations",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Открыть переписку с AI-консьержем (деталь события или Home)",
        description:
          "Idempotency-Key (UUID) обязателен. Тело AiCreateConversationRequest {mode: event|home, event_id? (event — обязателен), " +
          "query? ≤ 120 (только home), trip_params? (только event: тело recalculate + selected_tier)}. Ограничения профиля и язык " +
          "BFF берёт из preferences/identity. → 201 AiConversation | 200 (открытая переписка того же события за 24 ч, с историей). " +
          "404 EVENT_NOT_FOUND; 422 VALIDATION_ERROR | IDEMPOTENCY_KEY_REQUIRED; 503 FEATURE_UNAVAILABLE.",
        security: BEARER,
        headers: IdemHeaders,
        body: AiCreateConversationSchema,
        response: { 200: AiConversationSchema, 201: AiConversationSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      need();
      const key = idemKey(req);
      const b = req.body;
      if (b.mode === "event" && !b.event_id) throw validation("event_id", "required");
      if (b.mode === "event" && b.query !== undefined) throw validation("query", "mode");
      if (b.mode === "home" && b.event_id !== undefined) throw validation("event_id", "mode");
      if (b.mode === "home" && b.trip_params !== undefined) throw validation("trip_params", "mode");
      const query = b.query?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
      if (b.query !== undefined && !query) throw validation("query", "minLength");
      const { constraints, lang } = await profile(userId);
      const { created, conversation } = await ai.create(
        userId,
        {
          mode: b.mode,
          ...(b.event_id ? { event_id: b.event_id.toLowerCase() } : {}),
          ...(query ? { query } : {}),
          ...(b.trip_params ? { trip_params: b.trip_params } : {}),
          constraints,
          lang,
        },
        key,
      );
      return reply.code(created ? 201 : 200).send(conversation);
    },
  );

  app.get(
    "/v1/ai/conversations/:conversationId",
    {
      config: user,
      schemaErrorFormatter: conversationParams,
      schema: {
        tags: TAG,
        summary: "Переписка с историей (последние ≤ 50 сообщений)",
        description: "→ AiConversation с messages. Чужая/удалённая/не-UUID → 404 AI_CONVERSATION_NOT_FOUND; 503 FEATURE_UNAVAILABLE.",
        security: BEARER,
        params: AiConversationParamsSchema,
        response: { 200: AiConversationSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      need();
      return ai.get(userId, req.params.conversationId.toLowerCase());
    },
  );

  app.delete(
    "/v1/ai/conversations/:conversationId",
    {
      config: user,
      schemaErrorFormatter: conversationParams,
      schema: {
        tags: TAG,
        summary: "Удалить переписку",
        description: "→ 204. Чужая/не-UUID → 404 AI_CONVERSATION_NOT_FOUND; 503 FEATURE_UNAVAILABLE.",
        security: BEARER,
        params: AiConversationParamsSchema,
        response: { 204: { type: "null", description: "Переписка удалена" }, ...errorResponses(401, 404, 423) },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      need();
      await ai.remove(userId, req.params.conversationId.toLowerCase());
      return reply.code(204).send(null);
    },
  );

  app.post(
    "/v1/ai/conversations/:conversationId/messages",
    {
      config: user,
      schemaErrorFormatter: conversationParams,
      schema: {
        tags: TAG,
        summary: "Сообщение консьержу (свободный текст) — ход со стримом SSE",
        description: "Тело AiMessageRequest {client_msg_id (UUID, идемпотентность хода), text 1..500, trip_params?}. " + SSE_DESC,
        security: BEARER,
        params: AiConversationParamsSchema,
        body: AiMessageRequestSchema,
        response: { 200: AiTurnResultSchema, ...errorResponses(401, 404, 409, 423) },
      },
    },
    async (req, reply) => {
      const b = req.body;
      if (!b.text.trim()) throw validation("text", "minLength");
      return turn(req, reply, req.params.conversationId.toLowerCase(), {
        client_msg_id: b.client_msg_id.toLowerCase(),
        text: b.text,
        ...(b.trip_params ? { trip_params: b.trip_params } : {}),
      });
    },
  );

  app.post(
    "/v1/ai/conversations/:conversationId/actions/:tool",
    {
      config: user,
      schemaErrorFormatter: conversationParams,
      schema: {
        tags: TAG,
        summary: "Быстрое действие (инструмент без раунда модели) — ход со стримом SSE",
        description:
          "tool — reprice_offer | set_direct_only | change_departure | set_hotel_distance | extend_trip_days | find_similar_event " +
          "(иначе 404 AI_TOOL_NOT_FOUND; путь ТЗ …/actions/reprice = reprice_offer). Тело AiActionRequest {client_msg_id, args, " +
          "trip_params?}; args проверяет консьерж по схеме инструмента. " + SSE_DESC,
        security: BEARER,
        params: AiActionParamsSchema,
        body: AiActionRequestSchema,
        response: { 200: AiTurnResultSchema, ...errorResponses(401, 404, 409, 423) },
      },
    },
    async (req, reply) => {
      const tool = req.params.tool === "reprice" ? "reprice_offer" : req.params.tool;
      if (!AI_TOOL_SET.has(tool)) throw new AppError(404, "AI_TOOL_NOT_FOUND", "Действие не найдено");
      const b = req.body;
      return turn(req, reply, req.params.conversationId.toLowerCase(), {
        client_msg_id: b.client_msg_id.toLowerCase(),
        action: { tool, args: b.args },
        ...(b.trip_params ? { trip_params: b.trip_params } : {}),
      });
    },
  );

  app.get(
    "/v1/ai/quota",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Квота сообщений консьержу на сегодня",
        description:
          "→ AiQuota {used, limit, remaining, level, level_name, resets_at} (basic — 10 в сутки, plus — 20; сутки UTC). " +
          "503 FEATURE_UNAVAILABLE — консьерж не подключён (кнопка «Спросить AI» скрыта).",
        security: BEARER,
        response: { 200: AiQuotaSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      need();
      return ai.quota(userId);
    },
  );
}

/**
 * SSE-прокси хода: без буферизации (каждое проверенное событие пишется сразу), heartbeat «: ping» как есть,
 * закрытие клиента → abort upstream, таймаут CONCIERGE_TIMEOUT_MS. Ошибки до стрима — JSON (reply ещё не захвачен).
 */
async function proxyStream(
  ctx: BffContext,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  conversationId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const started = Date.now();
  const clientGone = new AbortController();
  const timeout = AbortSignal.timeout(ctx.config.conciergeTimeoutMs);
  const signal = AbortSignal.any([clientGone.signal, timeout]);
  const raw = reply.raw;
  const onClose = () => {
    if (!raw.writableFinished) clientGone.abort();
  };
  raw.on("close", onClose);

  let resp: Response;
  try {
    resp = await ctx.concierge.openStream(userId, conversationId, body, signal, clientGone.signal);
  } catch (err) {
    raw.off("close", onClose);
    if (timeout.aborted && !(err instanceof AppError && err.status < 500)) {
      throw new AppError(503, "AI_PROVIDER_UNAVAILABLE", "AI сейчас недоступен. Цены и детали — в блоке «Поездка»", {});
    }
    throw err;
  }

  reply.hijack();
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(reply.getHeaders())) {
    if (v !== undefined && k !== "content-length" && k !== "content-type") headers[k] = Array.isArray(v) ? v.map(String) : String(v);
  }
  raw.writeHead(200, {
    ...headers,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
    connection: "keep-alive",
  });
  raw.flushHeaders?.();

  const write = async (chunk: string): Promise<void> => {
    if (raw.destroyed || raw.writableEnded) return;
    if (!raw.write(chunk)) {
      await Promise.race([once(raw, "drain"), once(raw, "close")]).catch(() => undefined);
    }
  };

  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = resp.body!.getReader();
  let turnId: string | null = null;
  let seq = 0;
  let terminal = false;
  let dropped = 0;
  const counts: Record<string, number> = {};
  const emit = async (e: AiSseEvent) => {
    await write(sseFrame(e, seq++));
    counts[e.event] = (counts[e.event] ?? 0) + 1;
    if (e.event === "done" || e.event === "error") terminal = true;
  };
  let failure: "AI_PROVIDER_UNAVAILABLE" | "AI_TIMEOUT" | null = null;
  try {
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let blocks;
      try {
        blocks = parser.push(decoder.decode(value, { stream: true }));
      } catch {
        ctx.log.warn({ upstream: "ai-concierge", reason: "frame_too_large" }, "ai sse event dropped");
        failure = "AI_PROVIDER_UNAVAILABLE";
        break;
      }
      for (const b of blocks) {
        if (b.comment) {
          await write(": ping\n\n");
          continue;
        }
        const r = sseEventOf(b.event, b.data);
        const name = (AI_EVENTS as readonly string[]).includes(b.event) ? b.event : "unknown";
        if (!r.ok) {
          dropped += 1;
          ctx.log.warn({ upstream: "ai-concierge", event: name, reason: r.reason }, "ai sse event dropped");
          continue;
        }
        const tid = r.value.data.turn_id?.toLowerCase() ?? null;
        if (tid && turnId && tid !== turnId) {
          dropped += 1;
          ctx.log.warn({ upstream: "ai-concierge", event: name, reason: "turn_id_mismatch" }, "ai sse event dropped");
          continue;
        }
        turnId ??= tid;
        if (r.pruned) ctx.log.warn({ upstream: "ai-concierge", event: name, dropped_items: r.pruned }, "ai sse items dropped");
        await emit(r.value);
        if (terminal) break outer;
      }
    }
  } catch {
    if (!clientGone.signal.aborted) failure = timeout.aborted ? "AI_TIMEOUT" : "AI_PROVIDER_UNAVAILABLE";
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!terminal && !clientGone.signal.aborted) {
    const code = failure ?? (timeout.aborted ? "AI_TIMEOUT" : "AI_PROVIDER_UNAVAILABLE");
    ctx.log.warn({ upstream: "ai-concierge", reason: failure ? "stream_failed" : "stream_ended_without_terminal", code }, "ai sse stream incomplete");
    await emit(syntheticError(turnId, code));
  }
  raw.off("close", onClose);
  if (!raw.writableEnded) raw.end();
  req.log.info(
    {
      method: req.method,
      route: req.routeOptions.url ?? "unmatched",
      status_code: 200,
      duration_ms: Date.now() - started,
      outcome: clientGone.signal.aborted ? "client_closed" : "success",
      sse_events: counts,
      sse_dropped: dropped,
    },
    "request completed",
  );
}
