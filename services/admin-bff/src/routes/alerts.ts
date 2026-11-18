/**
 * Спринт 8 — колокольчик (docs/sprint8/INTERNAL_API.md §7.5): оповещения ops-monitor и бюджетные алерты ai-control
 * одной лентой.
 *  - GET /admin/v1/alerts?state=open (dashboard.read) → AlertFeed. Открытые оповещения ops (в т. ч. просмотренные —
 *    с отметкой acked) и неподтверждённые алерты AI; `counts` — по неподтверждённым. Источник не подключён или не
 *    ответил → его часть пропущена, `partial: true`, `sources.<источник>` — причина; ответ 200.
 *  - POST /admin/v1/alerts/{source}/{id}/ack {comment?} (ops.kill_switch) → AlertFeedItem. Idempotency-Key — от клиента
 *    или `ack-<id>` (ack идемпотентен по смыслу); аудит пишет домен синхронно (503 → AUDIT_UNAVAILABLE).
 * Важность алерта AI: 100 % или автопауза — critical, 90 % и «модель без цены» — warning, 70 % — info.
 */
import type { AiAlert, AlertFeed, AlertFeedItem, AlertSeverity, OpsAlert } from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, passReplayed, staffOf, validationError, type App } from "../http.js";
import { requirePermission } from "../rbac.js";
import { UUID, enumOf, params, query } from "../schemas.js";
import { ok } from "../responses.js";
import { C, parseDomain } from "../codec.js";
import { AI_ALERT, AI_ALERT_PAGE } from "./aiCodecs.js";
import { command } from "./aiCommon.js";
import { OPS_ALERT, OPS_ALERT_PAGE, RUNBOOK_URL, SEVERITIES } from "./opsCodecs.js";
import { OPS, opsServerError } from "./ops.js";

const FEED_LIMIT = 100;
const RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

export const ALERT_FEED_ITEM = C.obj<AlertFeedItem>({
  source: C.oneOf(["ops", "ai"]),
  id: C.uuid,
  severity: C.oneOf(SEVERITIES),
  kind: C.text(40),
  subject_type: C.text(40),
  subject: C.text(120),
  params: C.json(4096),
  opened_at: C.time,
  acked: C.bool,
  runbook_url: RUNBOOK_URL,
});
const ALERT_FEED_SCHEMA = {
  type: "object",
  properties: {
    items: { type: "array", items: ALERT_FEED_ITEM.schema },
    counts: { type: "object", properties: { critical: { type: "integer" }, warning: { type: "integer" }, info: { type: "integer" } }, "x-contract-required": ["critical", "warning", "info"] },
    partial: { type: "boolean" },
    sources: {
      type: "object",
      properties: { ops: { type: "string" }, ai: { type: "string" } },
      "x-contract-required": ["ops", "ai"],
    },
  },
  "x-contract-required": ["items", "counts", "partial", "sources"],
};

export function aiSeverity(a: AiAlert): AlertSeverity {
  if (a.kind === "unpriced") return "warning";
  if (a.auto_paused || a.threshold >= 100) return "critical";
  return a.threshold >= 90 ? "warning" : "info";
}

export function fromOps(a: OpsAlert): AlertFeedItem {
  return {
    source: "ops",
    id: a.alert_id,
    severity: a.severity,
    kind: a.kind,
    subject_type: a.subject_type,
    subject: a.subject,
    params: { ...a.params },
    opened_at: a.opened_at,
    acked: a.acked_at !== null,
    runbook_url: a.runbook_url,
  };
}

export function fromAi(a: AiAlert): AlertFeedItem {
  return {
    source: "ai",
    id: a.alert_id,
    severity: aiSeverity(a),
    kind: a.kind,
    subject_type: "agent",
    subject: a.agent_id,
    params: { period: a.period, threshold: a.threshold, spent_usd: a.spent_usd, limit_usd: a.limit_usd, auto_paused: a.auto_paused, detail: a.detail },
    opened_at: a.created_at,
    acked: a.acked_at !== null,
    runbook_url: null,
  };
}

/** Лента: важные выше, внутри — новые выше; counts — по неподтверждённым. */
export function mergeFeed(opsItems: AlertFeedItem[] | null, aiItems: AlertFeedItem[] | null, sources: AlertFeed["sources"]): AlertFeed {
  const items = [...(opsItems ?? []), ...(aiItems ?? [])]
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || Date.parse(b.opened_at) - Date.parse(a.opened_at))
    .slice(0, FEED_LIMIT);
  const counts: Record<AlertSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const x of items) if (!x.acked) counts[x.severity] += 1;
  return { items, counts, partial: sources.ops !== "ok" || sources.ai !== "ok", sources };
}

export function alertRoutes(app: App, ctx: BffContext): void {
  const ops = ctx.domains.opsMonitor;
  const control = ctx.domains.aiControl;

  app.get<{ Querystring: { state?: "open" } }>(
    "/admin/v1/alerts",
    { config: requirePermission("dashboard.read"), schema: { response: ok(ALERT_FEED_SCHEMA), querystring: query({ state: enumOf(["open"]) }) } },
    async (req) => {
      const auth = staffOf(req);
      const sources: AlertFeed["sources"] = { ops: ops.configured ? "ok" : "not_configured", ai: control.configured ? "ok" : "not_configured" };
      const opsPart = async (): Promise<AlertFeedItem[] | null> => {
        if (!ops.configured) return null;
        try {
          const body = await ops.get<unknown>("/internal/v1/alerts", { actor: auth.actor, query: { state: "open", limit: FEED_LIMIT } });
          return parseDomain(ctx, OPS, OPS_ALERT_PAGE, body).items.map(fromOps);
        } catch (e) {
          ctx.log.warn({ upstream: OPS, upstream_code: (e as { code?: string })?.code }, "alert feed: ops-monitor unavailable");
          sources.ops = "unavailable";
          return null;
        }
      };
      const aiPart = async (): Promise<AlertFeedItem[] | null> => {
        if (!control.configured) return null;
        try {
          const body = await control.get<unknown>("/internal/v1/budgets/alerts", { actor: auth.actor, query: { unacked: true, limit: FEED_LIMIT } });
          return parseDomain(ctx, "ai-control", AI_ALERT_PAGE, body).items.map(fromAi);
        } catch (e) {
          ctx.log.warn({ upstream: "ai-control", upstream_code: (e as { code?: string })?.code }, "alert feed: ai-control unavailable");
          sources.ai = "unavailable";
          return null;
        }
      };
      const [o, a] = await Promise.all([opsPart(), aiPart()]);
      return mergeFeed(o, a, sources);
    },
  );

  app.post<{ Params: { source: "ops" | "ai"; id: string }; Body: unknown }>(
    "/admin/v1/alerts/:source/:id/ack",
    {
      config: requirePermission("ops.kill_switch"),
      schema: {
        response: ok(ALERT_FEED_ITEM.schema),
        params: params({ source: enumOf(["ops", "ai"]), id: UUID }),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const id = req.params.id.toLowerCase();
      const key = idempotencyKeyOf(req, false) ?? `ack-${id}`;
      const raw = req.body && typeof req.body === "object" ? (req.body as { comment?: unknown }).comment : undefined;
      if (raw !== undefined && raw !== null && (typeof raw !== "string" || raw.length > 300)) throw validationError("comment", "Комментарий — строка до 300 символов");
      if (req.params.source === "ops") {
        const comment = typeof raw === "string" ? raw.trim() || undefined : undefined;
        const res = await ops.call<unknown>("POST", `/internal/v1/alerts/${id}:ack`, {
          actor: auth.actor,
          body: comment ? { comment } : {},
          ...command(key),
          mapServerError: opsServerError,
        });
        passReplayed(reply, res);
        return fromOps(parseDomain(ctx, OPS, OPS_ALERT, res.body));
      }
      const res = await control.call<unknown>("POST", `/internal/v1/budgets/alerts/${id}:ack`, { actor: auth.actor, ...command(key) });
      passReplayed(reply, res);
      return fromAi(parseDomain(ctx, "ai-control", AI_ALERT, res.body));
    },
  );
}
