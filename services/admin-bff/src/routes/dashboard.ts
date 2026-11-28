/**
 * GET /admin/v1/dashboard?period=today|7d|30d (dashboard.read) → Dashboard — всегда 200 (кроме 401/403/422).
 *
 * Двенадцать независимых блоков, вызываются параллельно с таймаутом DASHBOARD_TIMEOUT_MS и без повторов:
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
 *                  доля unavailable, p95; спринт 5 — `speech`: вызовы и минуты оценки произношения, расход) — спринт 4;
 *                  ответ с признаками ключа провайдера → блок недоступен
 *  - memory      — memory            GET /admin/v1/memory/stats?period= (повторения, ученики, медиана минут, доля d30,
 *                  среднее к сроку) + catalog GET /admin/v1/glossary/stats (при 404 — content/summary) → ai_glosses_pending
 *                  — спринт 5; memory недоступен → блок недоступен; catalog недоступен → ai_glosses_pending null (routes/memory.ts)
 *  - game        — gamification      GET /internal/v1/admin/game/overview?period=7d|30d → GameStats (XP и тилы, заморозки
 *                  использованы, заданий выполнено, активное событие — заканчивается раньше всех) — спринт 6. У
 *                  gamification итогов «за сегодня» нет: при period=today блок — за 7 дней (`GameStats.period` = 7d).
 *                  GAMIFICATION_URL не задана → блок недоступен (`service: gamification`) без вызова
 *  - social      — social            GET /internal/v1/admin/social/stats?period= (заявки в друзья, новые дружбы,
 *                  рефералы на проверке, дела модерации) + параллельно gamification GET /internal/v1/admin/game/duels/stats
 *                  и lessons GET /internal/v1/admin/pair-rooms/stats (?period=) → `duels_finished`, `pair_rooms_finished`
 *                  (спринт 7, INTERNAL_API §9): social недоступен или SOCIAL_URL не задана → блок недоступен (`service:
 *                  social`); gamification или lessons недоступны (или GAMIFICATION_URL не задана) → их поле null, блок
 *                  доступен. `SocialStats.period` — запрошенный период
 *  - money       — billing           GET /internal/v1/admin/billing/reports/summary?period=day (выручка сайта в тийинах и
 *                  Mini App в Stars раздельно, оплаченные заказы, активные подписки, пробные — за сегодня по Ташкенту;
 *                  возвраты — её refunds_count, завершённые за день; открытые пункты сверки — её recon_open; один
 *                  вызов, доступен и с dashboard.read) + доля потолка ИИ из блока ai (недоступен — null) — спринт 8.
 *                  Блок за сегодня при любом периоде главной (`MoneyStats.period` = today). BILLING_URL не задана,
 *                  сводка недоступна или испорчена → блок недоступен (`service: billing`) — нули не подставляются
 * Источник недоступен, ответил ошибкой (в т. ч. 403 по своему праву) или испорченными данными → блок
 * `{available: false, data: null, service}`; остальные блоки показываются. Нули вместо «нет данных» не подставляются.
 */
import type { AiUsageSummary, Dashboard, DashboardBlock, GameStats, LessonStats, MemoryStats, MoneyStats, Period, SocialStats } from "@tilhero/contracts/admin";
import type { Actor, AppError } from "@tilhero/ts-common";
import { BadValue, C, type Codec } from "../codec.js";
import { DASHBOARD_CAMPAIGNS, DASHBOARD_LEARNERS, DASHBOARD_WHATS_NEW, SUPPORT_STATS } from "../contract.js";
import { CONTENT_SUMMARY, DIAGNOSTIC_STATS } from "../contractContent.js";
import { AI_USAGE_SUMMARY, ASSESSMENT_STATS, LESSON_STATS, LESSON_STATS_DOMAIN, findProviderKey } from "../contractAi.js";
import { MEMORY_STATS } from "../contractMemory.js";
import { GAME_OVERVIEW, GAME_STATS, gameStatsOf, overviewPeriodOf } from "../contractGame.js";
import { DUEL_STATS, PAIR_ROOM_STATS, SOCIAL_STATS, SOCIAL_STATS_DOMAIN } from "../contractSocial.js";
import { BILLING_SUMMARY } from "../contractBilling.js";
import type { BffContext } from "../context.js";
import { staffOf, type App } from "../http.js";
import { requirePermission } from "../rbac.js";
import { PERIOD, query } from "../schemas.js";
import { BILLING_SERVICE, DOMAIN, GAME_SERVICE, SOCIAL_SERVICE, upstreamUnavailable, type DomainClient, type DomainKey } from "../upstream.js";
import { out } from "./common.js";
import { loadMemoryStats } from "./memory.js";

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
  // спринт 5: + очередь переводов ИИ из catalog — loadMemory
  memory: { domain: "memory", codec: MEMORY_STATS, path: "/admin/v1/memory/stats", period: true },
} as const satisfies Record<keyof Omit<Dashboard, "period" | "generated_at" | "game" | "social" | "money">, BlockSpec<unknown>>;
/** Вторая половина блока lessons — счётчики assessment. */
const ASSESSMENT_SPEC: BlockSpec<typeof ASSESSMENT_STATS extends Codec<infer T> ? T : never> = {
  domain: "assessment",
  codec: ASSESSMENT_STATS,
  path: "/admin/v1/assessment/stats",
  period: true,
};

type Blocks = typeof SPECS;
type BlockName = keyof Blocks;
export const BLOCKS = [...(Object.keys(SPECS) as BlockName[]), "game", "social", "money"] as const;

const block = <T>(data: Codec<T>): Codec<DashboardBlock<T>> =>
  C.obj<DashboardBlock<T>>({ available: C.bool, data: C.nullable(data as Codec<Exclude<T, undefined>>), service: C.str(64) }, "service");

/** Спринт 8 — блок «Деньги»: billing reports/summary?period=day + доля потолка ИИ (admin.ts MoneyStats). */
export const MONEY_STATS: Codec<MoneyStats> = C.obj<MoneyStats>({
  period: C.oneOf<Period>(["today", "7d", "30d"]),
  web_revenue_tiyin: C.int(),
  stars_revenue_stars: C.int(),
  orders_paid: C.int(),
  refunds: C.int(),
  active_subscriptions: C.int(),
  trials_started: C.int(),
  recon_open: C.int(),
  ai_cap_used_pct: C.nullable(C.num(0, 1000)),
});

/** Доля потолка ИИ для блока «Деньги»: перерасход больше 1000 % показывается как 1000 (граница MoneyStats). */
const capPct = (ai: DashboardBlock<AiUsageSummary>): number | null => (ai.available && ai.data ? Math.min(ai.data.cap_used_pct, 1000) : null);

/**
 * Спринт 8 — блок «Деньги»: одна сводка billing за сегодня (refunds_count — возвраты, завершённые за день; recon_open —
 * открытые пункты сверки) + доля потолка ИИ (из уже загружаемого блока ai). Сводка недоступна или испорчена → блок
 * недоступен (нули не подставляются).
 */
async function loadMoney(ctx: BffContext, actor: Actor, aiBlock: Promise<DashboardBlock<AiUsageSummary>>): Promise<DashboardBlock<MoneyStats>> {
  try {
    if (!ctx.billing) throw upstreamUnavailable(BILLING_SERVICE);
    const o = { actor, timeoutMs: ctx.config.dashboardTimeoutMs, retries: 0 };
    const base = "/internal/v1/admin/billing";
    // одна сводка billing за день (reports/summary доступна и с dashboard.read): возвраты за день и открытая сверка —
    // её поля refunds_count и recon_open (billing, поток A)
    const [summaryBody, ai] = await Promise.all([ctx.billing.get<unknown>(`${base}/reports/summary`, { ...o, query: { period: "day" } }), aiBlock]);
    const s = BILLING_SUMMARY.parse(summaryBody, "$");
    return {
      available: true,
      data: {
        period: "today",
        web_revenue_tiyin: s.web.revenue_tiyin,
        stars_revenue_stars: s.stars.revenue_stars,
        orders_paid: s.web.orders_paid + s.stars.orders_paid,
        refunds: s.refunds_count,
        active_subscriptions: s.active_subscriptions,
        trials_started: s.trials_started,
        recon_open: s.recon_open,
        ai_cap_used_pct: capPct(ai),
      },
    };
  } catch (err) {
    const code = err instanceof BadValue ? "UPSTREAM_BAD_RESPONSE" : ((err as AppError)?.code ?? "UNKNOWN");
    ctx.log.warn({ upstream: BILLING_SERVICE, err_code: code }, "dashboard block unavailable");
    return { available: false, data: null, service: BILLING_SERVICE };
  }
}

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
  memory: block(MEMORY_STATS),
  game: block(GAME_STATS),
  social: block(SOCIAL_STATS),
  money: block(MONEY_STATS),
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

/** Блок memory: статистика memory + очередь переводов ИИ catalog (routes/memory.ts loadMemoryStats). */
async function loadMemory(ctx: BffContext, actor: Actor, period: Period): Promise<DashboardBlock<MemoryStats>> {
  const service = DOMAIN[SPECS.memory.domain];
  try {
    return { available: true, data: await loadMemoryStats(ctx, actor, period, ctx.config.dashboardTimeoutMs) };
  } catch (err) {
    const code = err instanceof BadValue ? "UPSTREAM_BAD_RESPONSE" : ((err as AppError)?.code ?? "UNKNOWN");
    ctx.log.warn({ upstream: service, err_code: code }, "dashboard block unavailable");
    return { available: false, data: null, service };
  }
}

/** Блок game (спринт 6): обзор gamification → GameStats; GAMIFICATION_URL не задана → блок недоступен без вызова. */
async function loadGame(ctx: BffContext, actor: Actor, period: Period): Promise<DashboardBlock<GameStats>> {
  try {
    if (!ctx.gamification) throw upstreamUnavailable(GAME_SERVICE);
    const body = await ctx.gamification.get<unknown>("/internal/v1/admin/game/overview", {
      actor,
      query: { period: overviewPeriodOf(period) },
      timeoutMs: ctx.config.dashboardTimeoutMs,
      retries: 0,
    });
    return { available: true, data: gameStatsOf(GAME_OVERVIEW.parse(body, "$")) };
  } catch (err) {
    const code = err instanceof BadValue ? "UPSTREAM_BAD_RESPONSE" : ((err as AppError)?.code ?? "UNKNOWN");
    ctx.log.warn({ upstream: GAME_SERVICE, err_code: code }, "dashboard block unavailable");
    return { available: false, data: null, service: GAME_SERVICE };
  }
}

/**
 * Часть блока social из другого домена (дуэли — gamification, комнаты — lessons): недоступен, ответил ошибкой или
 * мусором, адрес не задан → null (поле блока null, блок доступен). Без повторов, таймаут блока.
 */
async function loadPart<T>(ctx: BffContext, actor: Actor, period: Period, client: DomainClient | null, service: string, path: string, c: Codec<T>): Promise<T | null> {
  try {
    if (!client) throw upstreamUnavailable(service);
    const body = await client.get<unknown>(path, { actor, query: { period }, timeoutMs: ctx.config.dashboardTimeoutMs, retries: 0 });
    return c.parse(body, "$");
  } catch (err) {
    const code = err instanceof BadValue ? "UPSTREAM_BAD_RESPONSE" : ((err as AppError)?.code ?? "UNKNOWN");
    ctx.log.warn({ upstream: service, err_code: code }, "dashboard block part unavailable");
    return null;
  }
}

/**
 * Блок social (спринт 7): счётчики social + завершённые дуэли (gamification) и парные уроки (lessons) параллельно.
 * social недоступен или SOCIAL_URL не задана → блок недоступен без нулей; дуэли или комнаты недоступны → их поле null.
 */
async function loadSocial(ctx: BffContext, actor: Actor, period: Period): Promise<DashboardBlock<SocialStats>> {
  const base = (async () => {
    try {
      if (!ctx.social) throw upstreamUnavailable(SOCIAL_SERVICE);
      const body = await ctx.social.get<unknown>("/internal/v1/admin/social/stats", {
        actor,
        query: { period },
        timeoutMs: ctx.config.dashboardTimeoutMs,
        retries: 0,
      });
      return SOCIAL_STATS_DOMAIN.parse(body, "$");
    } catch (err) {
      const code = err instanceof BadValue ? "UPSTREAM_BAD_RESPONSE" : ((err as AppError)?.code ?? "UNKNOWN");
      ctx.log.warn({ upstream: SOCIAL_SERVICE, err_code: code }, "dashboard block unavailable");
      return null;
    }
  })();
  const [stats, duels, rooms] = await Promise.all([
    base,
    loadPart(ctx, actor, period, ctx.gamification, GAME_SERVICE, "/internal/v1/admin/game/duels/stats", DUEL_STATS),
    loadPart(ctx, actor, period, ctx.domains.lessons, DOMAIN.lessons, "/internal/v1/admin/pair-rooms/stats", PAIR_ROOM_STATS),
  ]);
  if (!stats) return { available: false, data: null, service: SOCIAL_SERVICE };
  return {
    available: true,
    data: {
      period,
      friend_requests: stats.friend_requests,
      friendships_added: stats.friendships_added,
      duels_finished: duels?.duels_finished ?? null,
      pair_rooms_finished: rooms?.pair_rooms_finished ?? null,
      referrals_in_review: stats.referrals_in_review,
      cases_opened: stats.cases_opened,
      cases_open: stats.cases_open,
    },
  };
}

export function dashboardRoutes(app: App, ctx: BffContext): void {
  app.get<{ Querystring: { period?: Period } }>(
    "/admin/v1/dashboard",
    { config: requirePermission("dashboard.read"), schema: { response: out(DASHBOARD), querystring: query({ period: PERIOD }) } },
    async (req): Promise<Dashboard> => {
      const auth = staffOf(req);
      const period: Period = req.query.period ?? "today";
      const started = performance.now();
      // блок ai нужен и блоку «Деньги» (доля потолка) — один вызов ai-gateway
      const aiBlock = load(ctx, auth.actor, period, SPECS.ai);
      const [learners, support, whats_new, campaigns, content, diagnostics, lessons, ai, memory, game, social, money] = await Promise.all([
        load(ctx, auth.actor, period, SPECS.learners),
        load(ctx, auth.actor, period, SPECS.support),
        load(ctx, auth.actor, period, SPECS.whats_new),
        load(ctx, auth.actor, period, SPECS.campaigns),
        load(ctx, auth.actor, period, SPECS.content),
        load(ctx, auth.actor, period, SPECS.diagnostics),
        loadLessons(ctx, auth.actor, period),
        aiBlock,
        loadMemory(ctx, auth.actor, period),
        loadGame(ctx, auth.actor, period),
        loadSocial(ctx, auth.actor, period),
        loadMoney(ctx, auth.actor, aiBlock),
      ]);
      const blocks = [learners, support, whats_new, campaigns, content, diagnostics, lessons, ai, memory, game, social, money];
      const unavailable = blocks.filter((b) => !b.available).length;
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
        memory,
        game,
        social,
        money,
      };
    },
  );
}
