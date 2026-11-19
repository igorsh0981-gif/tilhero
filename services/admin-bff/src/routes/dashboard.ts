/**
 * GET /admin/v1/dashboard?period=today|7d|30d (dashboard.read) → Dashboard — всегда 200 (кроме 401/403/422).
 *
 * Восемь независимых блоков, вызываются параллельно с таймаутом DASHBOARD_TIMEOUT_MS и без повторов:
 *  - learners    — user-admin        GET /admin/v1/learners/stats?period=
 *  - support     — support           GET /admin/v1/support/stats?period=
 *  - whats_new   — experience-config GET /admin/v1/release-notes/summary
 *  - campaigns   — notifications     GET /admin/v1/notifications/campaigns/summary?period=
 *  - content     — catalog           GET /admin/v1/content/summary (спринт 3: версии, истекающие права, заявки)
 *  - diagnostics — diagnostics       GET /admin/v1/diagnostics/stats?period= (спринт 3)
 *  - lessons     — lessons           GET /admin/v1/lesson-sessions/stats?period= (начато, завершено, медиана минут,
 *                  доля упрощённого режима) + assessment GET /admin/v1/assessment/stats?period= (открытые апелляции и
 *                  оценки на ручной проверке) — спринт 4; блок доступен, только если ответили оба (иначе service — первый
 *                  недоступный: нули за assessment не подставляются)
 *  - ai          — ai-gateway        GET /admin/v1/ai/usage/summary?period=month (расход месяца против потолка, вызовы,
 *                  доля unavailable, p95) — спринт 4; ответ с признаками ключа провайдера → блок недоступен
 * Источник недоступен, ответил ошибкой (в т. ч. 403 по своему праву) или испорченными данными → блок
 * `{available: false, data: null, service}`; остальные блоки показываются. Нули вместо «нет данных» не подставляются.
 */
import type { Dashboard, DashboardBlock, LessonStats, Period } from "@tilhero/contracts/admin";
import type { Actor, AppError } from "@tilhero/ts-common";
import { BadValue, C, type Codec } from "../codec.js";
import { DASHBOARD_CAMPAIGNS, DASHBOARD_LEARNERS, DASHBOARD_WHATS_NEW, SUPPORT_STATS } from "../contract.js";
import { CONTENT_SUMMARY, DIAGNOSTIC_STATS } from "../contractContent.js";
import { AI_USAGE_SUMMARY, ASSESSMENT_STATS, LESSON_STATS, LESSON_STATS_DOMAIN, findProviderKey } from "../contractAi.js";
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
  /** передавать ли ?period= (строка — фиксированный период источника: usage/summary — month) */
  period: boolean | string;
}

const SPECS = {
  learners: { domain: "userAdmin", codec: DASHBOARD_LEARNERS, path: "/admin/v1/learners/stats", period: true },
  support: { domain: "support", codec: SUPPORT_STATS, path: "/admin/v1/support/stats", period: true },
  whats_new: { domain: "experience", codec: DASHBOARD_WHATS_NEW, path: "/admin/v1/release-notes/summary", period: false },
  campaigns: { domain: "notifications", codec: DASHBOARD_CAMPAIGNS, path: "/admin/v1/notifications/campaigns/summary", period: true },
  content: { domain: "catalog", codec: CONTENT_SUMMARY, path: "/admin/v1/content/summary", period: false },
  diagnostics: { domain: "diagnostics", codec: DIAGNOSTIC_STATS, path: "/admin/v1/diagnostics/stats", period: true },
  lessons: { domain: "lessons", codec: LESSON_STATS_DOMAIN, path: "/admin/v1/lesson-sessions/stats", period: true },
  ai: { domain: "aiGateway", codec: AI_USAGE_SUMMARY, path: "/admin/v1/ai/usage/summary", period: "month" },
} as const satisfies Record<keyof Omit<Dashboard, "period" | "generated_at">, BlockSpec<unknown>>;
/** Вторая половина блока lessons — счётчики assessment. */
const ASSESSMENT_SPEC: BlockSpec<typeof ASSESSMENT_STATS extends Codec<infer T> ? T : never> = {
  domain: "assessment",
  codec: ASSESSMENT_STATS,
  path: "/admin/v1/assessment/stats",
  period: true,
};

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
  content: block(CONTENT_SUMMARY),
  diagnostics: block(DIAGNOSTIC_STATS),
  lessons: block(LESSON_STATS),
  ai: block(AI_USAGE_SUMMARY),
});

async function load<T>(ctx: BffContext, actor: Actor, period: Period, spec: BlockSpec<T>): Promise<DashboardBlock<T>> {
  const service = DOMAIN[spec.domain];
  try {
    const body = await ctx.domains[spec.domain].get<unknown>(spec.path, {
      actor,
      ...(spec.period ? { query: { period: typeof spec.period === "string" ? spec.period : period } } : {}),
      timeoutMs: ctx.config.dashboardTimeoutMs,
      retries: 0,
    });
    // ключ провайдера ИИ не уходит клиенту ни при каких условиях (ai-gateway)
    if (spec.domain === "aiGateway") {
      const hit = findProviderKey(body);
      if (hit) {
        ctx.log.error({ upstream: service, upstream_code: "PROVIDER_KEY_IN_RESPONSE", field: hit.slice(0, 200) }, "dashboard block rejected");
        return { available: false, data: null, service };
      }
    }
    return { available: true, data: spec.codec.parse(body, "$") };
  } catch (err) {
    const code = err instanceof BadValue ? "UPSTREAM_BAD_RESPONSE" : ((err as AppError)?.code ?? "UNKNOWN");
    ctx.log.warn({ upstream: service, err_code: code }, "dashboard block unavailable");
    return { available: false, data: null, service };
  }
}

/** Блок lessons: статистика сессий (lessons) + апелляции и ручная проверка (assessment); оба обязательны. */
async function loadLessons(ctx: BffContext, actor: Actor, period: Period): Promise<DashboardBlock<LessonStats>> {
  const [ls, as] = await Promise.all([load(ctx, actor, period, SPECS.lessons), load(ctx, actor, period, ASSESSMENT_SPEC)]);
  if (!ls.available || !ls.data) return { available: false, data: null, service: ls.service ?? DOMAIN.lessons };
  if (!as.available || !as.data) return { available: false, data: null, service: as.service ?? DOMAIN.assessment };
  return { available: true, data: { ...ls.data, ...as.data, period } };
}

export function dashboardRoutes(app: App, ctx: BffContext): void {
  app.get<{ Querystring: { period?: Period } }>(
    "/admin/v1/dashboard",
    { config: requirePermission("dashboard.read"), schema: { response: out(DASHBOARD), querystring: query({ period: PERIOD }) } },
    async (req): Promise<Dashboard> => {
      const auth = staffOf(req);
      const period: Period = req.query.period ?? "today";
      const started = performance.now();
      const [learners, support, whats_new, campaigns, content, diagnostics, lessons, ai] = await Promise.all([
        load(ctx, auth.actor, period, SPECS.learners),
        load(ctx, auth.actor, period, SPECS.support),
        load(ctx, auth.actor, period, SPECS.whats_new),
        load(ctx, auth.actor, period, SPECS.campaigns),
        load(ctx, auth.actor, period, SPECS.content),
        load(ctx, auth.actor, period, SPECS.diagnostics),
        loadLessons(ctx, auth.actor, period),
        load(ctx, auth.actor, period, SPECS.ai),
      ]);
      const unavailable = [learners, support, whats_new, campaigns, content, diagnostics, lessons, ai].filter((b) => !b.available).length;
      ctx.log.info({ dashboard_ms: Math.round(performance.now() - started), unavailable }, "dashboard assembled");
      return {
        period,
        generated_at: new Date(ctx.now()).toISOString(),
        learners,
        support,
        whats_new,
        campaigns,
        content,
        diagnostics,
        lessons,
        ai,
      };
    },
  );
}
