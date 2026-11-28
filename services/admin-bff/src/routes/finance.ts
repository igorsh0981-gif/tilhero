/**
 * Финансовый обзор (admin.ts FinanceOverview, ADM-DASH-04, AT-99; INTERNAL_API §1.15, §12):
 * `GET /admin/v1/finance/overview?period=day|week|month` (billing.read | dashboard.read) — собирает admin-bff:
 *  - billing `reports/summary?period=` (+ `?period=month` для «нужного потолка», если период не месяц) — выручка сайта
 *    (сумы, тийины) и Mini App (Stars) раздельно, возвраты, подписки, пробные, конверсия, минуты, курсы;
 *  - ai-gateway `usage/summary?period=` (+ месяц — прогноз), `unit-costs?period=week|month` (+ месяц — p95),
 *    `degradation` (уровень) — затраты ИИ, стоимость ИИ-минуты, прогноз, «нужный потолок».
 * Все суммы — целые (money.ts, BigInt, half-up): тийины, Stars, микродоллары. Пересчёты:
 *  - затраты ИИ в тийинах = микродоллары × «тийинов за 1 USD» / 10⁶ (нет курса — null);
 *  - оценка выручки Stars в тийинах = Stars нетто × «тийинов за 1 Star» — пометка «оценка» (нет курса — null);
 *  - стоимость ИИ-минуты = затраты на занятия с ИИ / списанные минуты (unit-costs: день и неделя — по неделе, месяц —
 *    по месяцу);
 *  - прогноз затрат ИИ до конца месяца (UTC) = расход месяца × длина месяца / прошедшее время (первый час — null);
 *  - «нужный потолок» = минуты месяца × p95 стоимости минуты × 1,2, где минуты месяца — начисленные за месяц
 *    (billing minutes.granted), p95 стоимости минуты = Σ(p95 стоимости ИИ-занятия × ИИ-занятий) / Σ списанных минут по
 *    видам занятий;
 *  - маржа = выручка сайта нетто + оценка Stars нетто − затраты ИИ (тийины); без комиссий провайдеров и магазинов
 *    приложений (данных нет); estimated — в марже есть оценка Stars; Stars есть, а курса Star нет — маржа null (иначе
 *    она занизила бы выручку); нет курса USD — маржа null.
 * Источник недоступен (адрес не задан, сеть, 5xx, 4xx по праву, испорченный ответ, переполнение) → его блок null,
 * остальное показывается (как блоки дашборда); ответ всегда 200 (кроме 401/403/422).
 */
import type { AiUsageSummary, BillingSummary, DegradationLevel, FinanceOverview } from "@tilhero/contracts/admin";
import type { AiUnitCosts } from "@tilhero/contracts/ai";
import type { Actor, AppError } from "@tilhero/ts-common";
import { aiGet, AI_SERVICE } from "../aiGateway.js";
import { BadValue, C, type Codec } from "../codec.js";
import { AI_DEGRADATION, AI_UNIT_COSTS, AI_USAGE_SUMMARY } from "../contractAi.js";
import { BILLING_SUMMARY, BY_PRODUCT, FX_REF, MINUTES_TOTALS, STAR_REF, SUMMARY_STARS, SUMMARY_WEB } from "../contractBilling.js";
import type { BffContext } from "../context.js";
import { staffOf, type App } from "../http.js";
import { MICRO, divHalfUp, microToTiyin, starsToTiyin, tashkentRange, toSafe, usd6ToMicro, usdToMicro, utcMonth } from "../money.js";
import { requirePermission } from "../rbac.js";
import { DEGRADATION_LEVELS, REPORT_PERIODS, enumOf, query } from "../schemas.js";
import { BILLING_SERVICE, upstreamUnavailable } from "../upstream.js";
import { out } from "./common.js";

type Period = FinanceOverview["period"];
type Revenue = NonNullable<FinanceOverview["revenue"]>;
type AiBlock = NonNullable<FinanceOverview["ai"]>;

const SIGNED = C.int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
const N_SAFE = C.nullable(C.int(0));
/** Ответ маршрута (схема и строгая проверка в тестах) — admin.ts FinanceOverview. */
export const FINANCE_OVERVIEW: Codec<FinanceOverview> = C.obj<FinanceOverview>({
  period: C.oneOf(REPORT_PERIODS),
  from: C.time,
  to: C.time,
  generated_at: C.time,
  revenue: C.nullable(
    C.obj<Revenue>({
      web: SUMMARY_WEB,
      stars: SUMMARY_STARS,
      by_product: BY_PRODUCT,
      refunds_count: C.int(0),
      recon_open: C.int(0),
      active_subscriptions: C.int(0),
      stars_subscriptions_live: C.int(0),
      trials_started: C.int(0),
      trials_converted: C.int(0),
      conversion_pct: C.nullable(C.num(0, 100)),
      minutes: MINUTES_TOTALS,
    }),
  ),
  ai: C.nullable(
    C.obj<AiBlock>({
      spent_micro_usd: C.int(0),
      spent_tiyin: N_SAFE,
      monthly_cap_micro_usd: C.int(0),
      cap_used_pct: C.num(0, 1e9),
      cost_per_minute_micro_usd: N_SAFE,
      cost_per_minute_tiyin: N_SAFE,
      forecast_month_micro_usd: N_SAFE,
      needed_cap_micro_usd: N_SAFE,
      level: C.oneOf(DEGRADATION_LEVELS),
    }),
  ),
  margin: C.nullable(C.obj<NonNullable<FinanceOverview["margin"]>>({ net_tiyin: SIGNED, estimated: C.bool })),
  fx: C.nullable(FX_REF),
  star_rate: C.nullable(STAR_REF),
});

/** Источники обзора (null — недоступен). */
export interface FinanceSources {
  period: Period;
  now: number;
  summary: BillingSummary | null;
  /** сводка месяца (минуты месяца для «нужного потолка»); при period=month — та же */
  monthSummary: BillingSummary | null;
  usage: AiUsageSummary | null;
  /** расход месяца (прогноз); при period=month — тот же */
  monthUsage: AiUsageSummary | null;
  /** стоимость занятий для стоимости минуты: day и week — неделя, month — месяц */
  unit: AiUnitCosts | null;
  /** стоимость занятий месяца (p95 для «нужного потолка») */
  monthUnit: AiUnitCosts | null;
  /** действующий уровень деградации; null — неизвестен (ai-gateway до миграции 0009): по ai_enabled */
  level: DegradationLevel | null;
}

/** Период unit-costs для периода обзора: у ai-gateway только неделя и месяц. */
export const unitPeriodOf = (p: Period): AiUnitCosts["period"] => (p === "month" ? "month" : "week");

const KINDS = ["lesson", "scenario", "pair"] as const;

/** Стоимость ИИ-минуты: Σ затрат / Σ списанных минут (микродоллары; тийины — по курсу). */
function perMinute(u: AiUnitCosts | null, usdInTiyin: number | null): { micro: number | null; tiyin: number | null } {
  if (!u) return { micro: null, tiyin: null };
  let cost = 0n;
  let minutes = 0n;
  for (const k of KINDS) {
    cost += usd6ToMicro(u.by_kind[k].cost_usd);
    minutes += BigInt(u.by_kind[k].billable_minutes);
  }
  if (minutes === 0n) return { micro: null, tiyin: null };
  return {
    micro: toSafe(divHalfUp(cost, minutes)),
    tiyin: usdInTiyin === null ? null : toSafe(divHalfUp(cost * BigInt(usdInTiyin), minutes * MICRO)),
  };
}

/** «Нужный потолок» = минуты месяца × p95 стоимости минуты × 1,2 (микродоллары). */
function neededCap(monthUnit: AiUnitCosts | null, monthSummary: BillingSummary | null): number | null {
  if (!monthUnit || !monthSummary) return null;
  let p95Total = 0n;
  let minutes = 0n;
  for (const k of KINDS) {
    const x = monthUnit.by_kind[k];
    if (x.cost_per_ai_session_p95_usd === null || x.billable_minutes === 0) continue;
    p95Total += usd6ToMicro(x.cost_per_ai_session_p95_usd) * BigInt(x.ai_sessions);
    minutes += BigInt(x.billable_minutes);
  }
  if (minutes === 0n) return null;
  return toSafe(divHalfUp(BigInt(monthSummary.minutes.granted) * p95Total * 12n, minutes * 10n));
}

/** Прогноз расхода ИИ до конца месяца UTC по расходу месяца на сейчас; первый час месяца — null. */
function forecast(monthUsage: AiUsageSummary | null, now: number): number | null {
  if (!monthUsage) return null;
  const { start, end } = utcMonth(now);
  const elapsed = now - start;
  if (elapsed < 3_600_000) return null;
  return toSafe(divHalfUp(usdToMicro(monthUsage.spent_usd) * BigInt(end - start), BigInt(elapsed)));
}

/** Блок, который не удалось посчитать (переполнение безопасных целых, испорченная строка USD), — null. */
function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}

/** Сборка обзора из источников (чистая функция: тесты считают каждое число). */
export function buildOverview(s: FinanceSources): FinanceOverview {
  const fx = s.summary?.fx ?? s.monthSummary?.fx ?? null;
  const starRate = s.summary?.star_rate ?? s.monthSummary?.star_rate ?? null;
  const range = s.summary ? { from: s.summary.from, to: s.summary.to } : tashkentRange(s.period, s.now);

  const revenue: Revenue | null = safe(() => {
    if (!s.summary) return null;
    const { period: _p, from: _f, to: _t, fx: _fx, star_rate: _sr, ...rest } = s.summary;
    const est = starRate ? toSafe(starsToTiyin(rest.stars.net_stars, starRate.star_in_tiyin)) : null;
    return { ...rest, stars: { ...rest.stars, est_net_tiyin: est } };
  });

  const ai: AiBlock | null = safe(() => {
    if (!s.usage) return null;
    const spent = usdToMicro(s.usage.spent_usd);
    const pm = safe(() => perMinute(s.unit, fx?.usd_in_tiyin ?? null)) ?? { micro: null, tiyin: null };
    return {
      spent_micro_usd: toSafe(spent),
      spent_tiyin: fx ? toSafe(microToTiyin(spent, fx.usd_in_tiyin)) : null,
      monthly_cap_micro_usd: toSafe(usdToMicro(s.usage.monthly_cap_usd)),
      cap_used_pct: s.usage.cap_used_pct,
      cost_per_minute_micro_usd: pm.micro,
      cost_per_minute_tiyin: pm.tiyin,
      forecast_month_micro_usd: safe(() => forecast(s.monthUsage, s.now)),
      needed_cap_micro_usd: safe(() => neededCap(s.monthUnit, s.monthSummary)),
      level: s.level ?? (s.usage.ai_enabled ? "normal" : "off"),
    };
  });

  const margin: FinanceOverview["margin"] = safe(() => {
    if (!revenue || !ai || ai.spent_tiyin === null) return null;
    const starsNet = revenue.stars.net_stars;
    const est = revenue.stars.est_net_tiyin;
    // Stars есть, а оценки нет (курс Star не задан) — маржа без выручки Stars ввела бы в заблуждение
    if (starsNet !== 0 && est === null) return null;
    const net = BigInt(revenue.web.net_tiyin) + BigInt(starsNet === 0 ? 0 : est!) - BigInt(ai.spent_tiyin);
    return { net_tiyin: toSafe(net), estimated: starsNet !== 0 };
  });

  return { period: s.period, from: range.from, to: range.to, generated_at: new Date(s.now).toISOString(), revenue, ai, margin, fx, star_rate: starRate };
}

export function financeRoutes(app: App, ctx: BffContext): void {
  /** Один источник обзора: ошибка, мусор или адрес не задан → null и строка в логе (без значений). */
  async function part<T>(service: string, fn: () => Promise<unknown>, c: Codec<T>): Promise<T | null> {
    try {
      return c.parse(await fn(), "$");
    } catch (err) {
      const code = err instanceof BadValue ? "UPSTREAM_BAD_RESPONSE" : ((err as AppError)?.code ?? "UNKNOWN");
      ctx.log.warn({ upstream: service, err_code: code }, "finance overview source unavailable");
      return null;
    }
  }
  const opts = (actor: Actor, query?: Record<string, string>) => ({ actor, ...(query ? { query } : {}), timeoutMs: ctx.config.dashboardTimeoutMs, retries: 0 });
  const summaryOf = (actor: Actor, period: Period) =>
    part(BILLING_SERVICE, async () => {
      if (!ctx.billing) throw upstreamUnavailable(BILLING_SERVICE);
      return ctx.billing.get<unknown>("/internal/v1/admin/billing/reports/summary", opts(actor, { period }));
    }, BILLING_SUMMARY);
  const usageOf = (actor: Actor, period: Period) => part(AI_SERVICE, () => aiGet(ctx, "/admin/v1/ai/usage/summary", opts(actor, { period })), AI_USAGE_SUMMARY);
  const unitOf = (actor: Actor, period: AiUnitCosts["period"]) => part(AI_SERVICE, () => aiGet(ctx, "/admin/v1/ai/unit-costs", opts(actor, { period })), AI_UNIT_COSTS);

  app.get<{ Querystring: { period?: Period } }>(
    "/admin/v1/finance/overview",
    {
      config: requirePermission("billing.read", "dashboard.read"),
      schema: { response: out(FINANCE_OVERVIEW), querystring: query({ period: enumOf(REPORT_PERIODS) }) },
    },
    async (req): Promise<FinanceOverview> => {
      const { actor } = staffOf(req);
      const period: Period = req.query.period ?? "month";
      const unitPeriod = unitPeriodOf(period);
      const started = performance.now();
      const [summary, monthSummary, usage, monthUsage, unit, monthUnit, degradation] = await Promise.all([
        summaryOf(actor, period),
        period === "month" ? Promise.resolve(null) : summaryOf(actor, "month"),
        usageOf(actor, period),
        period === "month" ? Promise.resolve(null) : usageOf(actor, "month"),
        unitOf(actor, unitPeriod),
        unitPeriod === "month" ? Promise.resolve(null) : unitOf(actor, "month"),
        part(AI_SERVICE, () => aiGet(ctx, "/admin/v1/ai/degradation", opts(actor)), AI_DEGRADATION),
      ]);
      const sources: FinanceSources = {
        period,
        now: ctx.now(),
        summary,
        monthSummary: period === "month" ? summary : monthSummary,
        usage,
        monthUsage: period === "month" ? usage : monthUsage,
        unit,
        monthUnit: unitPeriod === "month" ? unit : monthUnit,
        level: degradation?.level ?? null,
      };
      const body = buildOverview(sources);
      ctx.log.info({ finance_ms: Math.round(performance.now() - started), revenue: !!body.revenue, ai: !!body.ai }, "finance overview assembled");
      return body;
    },
  );
}
