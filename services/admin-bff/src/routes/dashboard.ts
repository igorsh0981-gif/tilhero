/**
 * GET /admin/v1/dashboard?period=today|7d|30d (dashboard.read) → Dashboard — всегда 200 (кроме 401/403/422).
 *
 * Четыре независимых блока, вызываются параллельно с таймаутом DASHBOARD_TIMEOUT_MS и без повторов:
 *  - learners  — user-admin        GET /admin/v1/learners/stats?period=
 *  - support   — support           GET /admin/v1/support/stats?period=
 *  - whats_new — experience-config GET /admin/v1/release-notes/summary
 *  - campaigns — notifications     GET /admin/v1/notifications/campaigns/summary?period=
 * Источник недоступен, ответил ошибкой (в т. ч. 403 по своему праву) или испорченными данными → блок
 * `{available: false, data: null, service}`; остальные блоки показываются. Нули вместо «нет данных» не подставляются.
 */
import type { Dashboard, DashboardBlock, Period } from "@tilhero/contracts/admin";
import type { Actor, AppError } from "@tilhero/ts-common";
import { BadValue, C, type Codec } from "../codec.js";
import { DASHBOARD_CAMPAIGNS, DASHBOARD_LEARNERS, DASHBOARD_WHATS_NEW, SUPPORT_STATS } from "../contract.js";
import type { BffContext } from "../context.js";
import { staffOf, type App } from "../http.js";
import { requirePermission } from "../rbac.js";
import { PERIOD, query } from "../schemas.js";
import { DOMAIN, type DomainKey } from "../upstream.js";
import { out } from "./common.js";

interface BlockSpec<T> {
  domain: DomainKey;
  codec: Codec<T>;
  path: string;
  /** передавать ли ?period= */
  period: boolean;
}

const SPECS = {
  learners: { domain: "userAdmin", codec: DASHBOARD_LEARNERS, path: "/admin/v1/learners/stats", period: true },
  support: { domain: "support", codec: SUPPORT_STATS, path: "/admin/v1/support/stats", period: true },
  whats_new: { domain: "experience", codec: DASHBOARD_WHATS_NEW, path: "/admin/v1/release-notes/summary", period: false },
  campaigns: { domain: "notifications", codec: DASHBOARD_CAMPAIGNS, path: "/admin/v1/notifications/campaigns/summary", period: true },
} as const satisfies Record<keyof Omit<Dashboard, "period" | "generated_at">, BlockSpec<unknown>>;

type Blocks = typeof SPECS;
type BlockName = keyof Blocks;
export const BLOCKS = Object.keys(SPECS) as BlockName[];

const block = <T>(data: Codec<T>): Codec<DashboardBlock<T>> =>
  C.obj<DashboardBlock<T>>({ available: C.bool, data: C.nullable(data as Codec<Exclude<T, undefined>>), service: C.str(64) }, "service");

export const DASHBOARD: Codec<Dashboard> = C.obj<Dashboard>({
  period: C.oneOf<Period>(["today", "7d", "30d"]),
  generated_at: C.time,
  learners: block(DASHBOARD_LEARNERS),
  support: block(SUPPORT_STATS),
  whats_new: block(DASHBOARD_WHATS_NEW),
  campaigns: block(DASHBOARD_CAMPAIGNS),
});

async function load<T>(ctx: BffContext, actor: Actor, period: Period, spec: BlockSpec<T>): Promise<DashboardBlock<T>> {
  const service = DOMAIN[spec.domain];
  try {
    const body = await ctx.domains[spec.domain].get<unknown>(spec.path, {
      actor,
      ...(spec.period ? { query: { period } } : {}),
      timeoutMs: ctx.config.dashboardTimeoutMs,
      retries: 0,
    });
    return { available: true, data: spec.codec.parse(body, "$") };
  } catch (err) {
    const code = err instanceof BadValue ? "UPSTREAM_BAD_RESPONSE" : ((err as AppError)?.code ?? "UNKNOWN");
    ctx.log.warn({ upstream: service, err_code: code }, "dashboard block unavailable");
    return { available: false, data: null, service };
  }
}

export function dashboardRoutes(app: App, ctx: BffContext): void {
  app.get<{ Querystring: { period?: Period } }>(
    "/admin/v1/dashboard",
    { config: requirePermission("dashboard.read"), schema: { response: out(DASHBOARD), querystring: query({ period: PERIOD }) } },
    async (req): Promise<Dashboard> => {
      const auth = staffOf(req);
      const period: Period = req.query.period ?? "today";
      const started = performance.now();
      const [learners, support, whats_new, campaigns] = await Promise.all([
        load(ctx, auth.actor, period, SPECS.learners),
        load(ctx, auth.actor, period, SPECS.support),
        load(ctx, auth.actor, period, SPECS.whats_new),
        load(ctx, auth.actor, period, SPECS.campaigns),
      ]);
      const unavailable = [learners, support, whats_new, campaigns].filter((b) => !b.available).length;
      ctx.log.info({ dashboard_ms: Math.round(performance.now() - started), unavailable }, "dashboard assembled");
      return { period, generated_at: new Date(ctx.now()).toISOString(), learners, support, whats_new, campaigns };
    },
  );
}
