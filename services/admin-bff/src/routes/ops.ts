/**
 * Спринт 8 — «Мониторинг» (docs/sprint8/INTERNAL_API.md §2.6, §3.3, §7.5): прокси ops-monitor (OPS_MONITOR_URL) с
 * сотрудником (actor) и строгой нормализацией (opsCodecs.ts). Без адреса — 503 FEATURE_UNAVAILABLE {service: "ops-monitor"}.
 *  - чтение (поставщики, история, ленты, оповещения, очереди, outbox, готовность, список DLQ, история команд) —
 *    dashboard.read; ops-monitor отдаёт списки — admin-bff отдаёт {items};
 *  - «Проверить сейчас» — dashboard.read (ограничение «раз в 30 с» — у provider-gateway), отдельный breaker и 20 с;
 *  - сообщение DLQ с маскированным конвертом — ops.queues.manage, Cache-Control: no-store; сырого payload нет;
 *  - повтор и удаление DLQ — ops.queues.manage + step-up TOTP, Idempotency-Key обязателен, причина 3..300, ровно одно
 *    из ids (≤ 100) и filter (с expected_count); 30 с без повторов (повтор после таймаута → тот же результат по ключу);
 *    аудит синхронно в ops-monitor до действия: 503 → AUDIT_UNAVAILABLE, ничего не сделано;
 *  - JetStream недоступен → 503 NATS_UNAVAILABLE как есть (UI: «очереди недоступны», не «сервис упал»).
 */
import { AppError, type UpstreamError } from "@tilhero/ts-common";
import type { DlqCommand } from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, passReplayed, staffOf, validationError, type App } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { CURSOR_Q, LIMIT_Q, enumOf, obj, pageQuery, params, query, str } from "../schemas.js";
import { ok } from "../responses.js";
import { parseDomain } from "../codec.js";
import { auditDown, REASON_IN, reasonOf, respond } from "./aiCommon.js";
import {
  CONSUMER,
  DLQ_ACTION_PAGE,
  DLQ_DETAIL,
  DLQ_PAGE,
  DLQ_RESULT,
  OPS_ALERT_PAGE,
  OUTBOX,
  PROBE_RESULT,
  PROBLEM_FEEDS,
  PROVIDER_HEALTH_LIST,
  PROVIDER_HISTORY,
  SERVICE_READY,
  STREAM,
  listOf,
} from "./opsCodecs.js";

export const OPS = "ops-monitor";
export const DLQ_BATCH_MAX = 100;
export const DLQ_FILTER_MAX = 500;
/** Команды DLQ: публикация пачки до 100 сообщений + аудит — до 30 с; без повторов. */
export const DLQ_COMMAND_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 20_000;

const PROVIDER = str(2, 32, { pattern: "^[a-z][a-z0-9_]{1,31}$" });
const DURABLE_Q = str(1, 120, { pattern: "^[A-Za-z0-9_\\-]{1,120}$" });
const EVENT_TYPE_Q = str(3, 120, { pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+\\.v[0-9]+$" });
const TIME_Q = str(20, 40, { pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,6})?)?(Z|[+-]\\d{2}:\\d{2})$" });
const DLQ_ID = str(5, 30, { pattern: "^(dlq|legacy):[0-9]{1,19}$" });

/** 503 ops-monitor: аудит недоступен → AUDIT_UNAVAILABLE; JetStream недоступен → NATS_UNAVAILABLE; прочее — UPSTREAM. */
export function opsServerError(err: UpstreamError): AppError | undefined {
  const audit = auditDown(err);
  if (audit) return audit;
  if (err.status === 503 && err.code === "NATS_UNAVAILABLE") {
    return new AppError(503, "NATS_UNAVAILABLE", "Шина NATS недоступна: очереди и DLQ временно не читаются", { service: "nats" });
  }
  return undefined;
}

// перепроверка 8: фильтр команды = параметры списка (source, state — как в GET ops/dlq), иначе «удалить все» задело
// бы невидимые оператору сообщения
const DLQ_FILTER = obj(
  {
    consumer: DURABLE_Q,
    event_type: EVENT_TYPE_Q,
    source: enumOf(["dlq", "legacy"]),
    state: enumOf(["present", "replayed", "all"]),
    dead_from: TIME_Q,
    dead_to: TIME_Q,
  },
  ["consumer"],
);
const DLQ_COMMAND = obj(
  {
    ids: { type: "array", minItems: 1, maxItems: DLQ_BATCH_MAX, uniqueItems: true, items: DLQ_ID },
    filter: DLQ_FILTER,
    expected_count: { type: "integer", minimum: 0, maximum: DLQ_FILTER_MAX },
    reason: REASON_IN,
    // ревью 8: повтор уже повторённого (сообщение остаётся в DLQ с пометкой replayed) — только явно
    include_replayed: { type: "boolean" },
  },
  ["reason"],
);

/** Ровно одно из ids и filter; с filter — expected_count (оператор подтверждает число затронутых). */
export function checkDlqCommand(b: DlqCommand): void {
  if ((b.ids === undefined) === (b.filter === undefined)) {
    throw new AppError(422, "DLQ_COMMAND_INVALID", "Нужно ровно одно: список сообщений (ids) или фильтр (filter)");
  }
  if (b.filter && b.expected_count === undefined) {
    throw new AppError(422, "DLQ_COMMAND_INVALID", "С фильтром нужно подтвердить число сообщений (expected_count)");
  }
  if (b.filter?.dead_from && b.filter.dead_to && Date.parse(b.filter.dead_from) > Date.parse(b.filter.dead_to)) {
    throw validationError("filter.dead_from", "Начало периода позже конца");
  }
}

export function opsRoutes(app: App, ctx: BffContext): void {
  const ops = ctx.domains.opsMonitor;
  const read = { mapServerError: opsServerError };

  // ------------------------------------------------------------ поставщики (§2.6)

  app.get("/admin/v1/ops/providers", { config: requirePermission("dashboard.read"), schema: { response: ok(PROVIDER_HEALTH_LIST.schema) } }, async (req) => {
    const auth = staffOf(req);
    return parseDomain(ctx, OPS, PROVIDER_HEALTH_LIST, await ops.get<unknown>("/internal/v1/health/providers", { actor: auth.actor, ...read }));
  });

  app.get<{ Params: { provider: string }; Querystring: { range?: "24h" | "7d" } }>(
    "/admin/v1/ops/providers/:provider/history",
    {
      config: requirePermission("dashboard.read"),
      schema: { response: ok(PROVIDER_HISTORY.schema), params: params({ provider: PROVIDER }), querystring: query({ range: enumOf(["24h", "7d"]) }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await ops.get<unknown>(`/internal/v1/health/providers/${req.params.provider}/history`, {
        actor: auth.actor,
        query: { range: req.query.range ?? "24h" },
        ...read,
      });
      return parseDomain(ctx, OPS, PROVIDER_HISTORY, body);
    },
  );

  app.post<{ Params: { provider: string } }>(
    "/admin/v1/ops/providers/:provider/probe",
    { config: requirePermission("dashboard.read"), schema: { response: ok(PROBE_RESULT.schema), params: params({ provider: PROVIDER }) } },
    async (req) => {
      const auth = staffOf(req);
      const res = await ops.call<unknown>("POST", `/internal/v1/health/providers/${req.params.provider}:probe`, {
        actor: auth.actor,
        timeoutMs: PROBE_TIMEOUT_MS,
        retries: 0,
        breakerKey: "ops-probe",
        ...read,
      });
      return parseDomain(ctx, OPS, PROBE_RESULT, res.body);
    },
  );

  app.get("/admin/v1/ops/feeds", { config: requirePermission("dashboard.read"), schema: { response: ok(PROBLEM_FEEDS.schema) } }, async (req) => {
    const auth = staffOf(req);
    return parseDomain(ctx, OPS, PROBLEM_FEEDS, await ops.get<unknown>("/internal/v1/health/feeds", { actor: auth.actor, ...read }));
  });

  // ------------------------------------------------------------ оповещения ops (вкладка «Оповещения»)

  app.get<{ Querystring: { state?: "open" | "resolved"; subject_type?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/ops/alerts",
    {
      config: requirePermission("dashboard.read"),
      schema: {
        response: ok(OPS_ALERT_PAGE.schema),
        querystring: query({
          state: enumOf(["open", "resolved"]),
          // спринт 9: + service, deletion, ratelimit (OpsAlertSubject контракта = Literal ops-monitor)
          subject_type: enumOf(["provider", "consumer", "outbox", "dlq", "feeds", "service", "deletion", "ratelimit"]),
          cursor: CURSOR_Q,
          limit: LIMIT_Q,
        }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await ops.get<unknown>("/internal/v1/alerts", {
        actor: auth.actor,
        query: { state: req.query.state, subject_type: req.query.subject_type, ...pageQuery(req.query) },
        ...read,
      });
      return respond(ctx, auth, OPS, OPS_ALERT_PAGE, body);
    },
  );

  // ------------------------------------------------------------ очереди, outbox, готовность (§3.3)

  const lists = [
    ["streams", STREAM],
    ["consumers", CONSUMER],
    ["outbox", OUTBOX],
    ["services", SERVICE_READY],
  ] as const;
  for (const [name, item] of lists) {
    const c = listOf(item as never, 500);
    app.get(`/admin/v1/ops/queues/${name}`, { config: requirePermission("dashboard.read"), schema: { response: ok(c.schema) } }, async (req) => {
      const auth = staffOf(req);
      return parseDomain(ctx, OPS, c, await ops.get<unknown>(`/internal/v1/queues/${name}`, { actor: auth.actor, ...read }));
    });
  }

  // ------------------------------------------------------------ DLQ (§3.3)

  app.get<{ Querystring: { consumer?: string; event_type?: string; source?: string; state?: string; dead_from?: string; dead_to?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/ops/dlq",
    {
      config: requirePermission("dashboard.read"),
      schema: {
        response: ok(DLQ_PAGE.schema),
        querystring: query({
          consumer: DURABLE_Q,
          event_type: EVENT_TYPE_Q,
          source: enumOf(["dlq", "legacy"]),
          // ревью 8: present — ждут решения (по умолчанию), replayed — уже повторены (остаются в DLQ), all
          state: enumOf(["present", "replayed", "all"]),
          dead_from: TIME_Q,
          dead_to: TIME_Q,
          cursor: CURSOR_Q,
          limit: LIMIT_Q,
        }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const q = req.query;
      if (q.dead_from && q.dead_to && Date.parse(q.dead_from) > Date.parse(q.dead_to)) throw validationError("dead_from", "Начало периода позже конца", "querystring");
      const body = await ops.get<unknown>("/internal/v1/dlq/messages", {
        actor: auth.actor,
        query: { consumer: q.consumer, event_type: q.event_type, source: q.source, state: q.state, dead_from: q.dead_from, dead_to: q.dead_to, ...pageQuery(q) },
        ...read,
      });
      return parseDomain(ctx, OPS, DLQ_PAGE, body);
    },
  );

  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    "/admin/v1/ops/dlq/actions",
    { config: requirePermission("dashboard.read"), schema: { response: ok(DLQ_ACTION_PAGE.schema), querystring: query({ cursor: CURSOR_Q, limit: LIMIT_Q }) } },
    async (req) => {
      const auth = staffOf(req);
      const body = await ops.get<unknown>("/internal/v1/dlq/actions", { actor: auth.actor, query: pageQuery(req.query), ...read });
      return respond(ctx, auth, OPS, DLQ_ACTION_PAGE, body);
    },
  );

  app.get<{ Params: { dlqId: string } }>(
    "/admin/v1/ops/dlq/:dlqId",
    { config: requirePermission("ops.queues.manage"), schema: { response: ok(DLQ_DETAIL.schema), params: params({ dlqId: DLQ_ID }) } },
    async (req, reply) => {
      const auth = staffOf(req);
      const body = await ops.get<unknown>(`/internal/v1/dlq/messages/${req.params.dlqId}`, { actor: auth.actor, ...read });
      // маскированный конверт — не кэшировать в браузере и прокси
      reply.header("cache-control", "no-store");
      return parseDomain(ctx, OPS, DLQ_DETAIL, body);
    },
  );

  for (const kind of ["replay", "delete"] as const) {
    app.post<{ Body: DlqCommand }>(
      `/admin/v1/ops/dlq/${kind}`,
      {
        config: { ...requirePermission("ops.queues.manage"), ...requireStepUp() },
        schema: { response: ok(DLQ_RESULT.schema), body: DLQ_COMMAND },
      },
      async (req, reply) => {
        const auth = staffOf(req);
        const key = idempotencyKeyOf(req, true)!;
        checkDlqCommand(req.body);
        const body: DlqCommand = {
          ...req.body,
          // состояние вида — явно (умолчание списка — present), чтобы команда и total считались одним отбором
          ...(req.body.filter ? { filter: { ...req.body.filter, state: req.body.filter.state ?? "present" } } : {}),
          reason: reasonOf(req.body.reason),
        };
        const res = await ops.call<unknown>("POST", `/internal/v1/dlq:${kind}`, {
          actor: auth.actor,
          body,
          idempotencyKey: key,
          timeoutMs: DLQ_COMMAND_TIMEOUT_MS,
          retries: 0,
          mapServerError: opsServerError,
        });
        passReplayed(reply, res);
        return parseDomain(ctx, OPS, DLQ_RESULT, res.body);
      },
    );
  }
}
