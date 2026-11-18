/**
 * GET /admin/v1/dashboard?period=today|7d|30d (dashboard.read) — спринт 8, DashboardV2 (docs/sprint8/INTERNAL_API.md §7.4).
 *
 * Восемь независимых блоков: users (user-admin), trips и no_flight (offers), watch, news, ai (ai-control), support,
 * system (ops-monitor). Ответ всегда 200 (кроме 401/403): блок без данных — `available: false` с причиной
 * (`unavailable` | `timeout` | `not_configured` | `forbidden`), нули вместо «нет данных» не подставляются.
 *  - Кэш блока — Redis `dash:<block>:<period>`, свежесть DASHBOARD_CACHE_SECONDS (60; users — ×5), stale-копия
 *    `…:last` — DASHBOARD_STALE_MAX_SECONDS (3600).
 *  - Свежий кэш → он. Нет — вызов источника; ждём DASHBOARD_BLOCK_TIMEOUT_MS (1500), сам вызов продолжается до
 *    DASHBOARD_TIMEOUT_MS и пополняет кэш для следующего открытия. Сбой или таймаут → stale-копия (`stale: true`,
 *    `as_of`), её нет → `available: false`. Одновременные запросы одного блока — один вызов (single-flight).
 *  - Фонового прогрева нет (ревью 8): кэш наполняется только запросом сотрудника и его же правами — никаких
 *    вызовов доменов от имени сотрудника вне его запроса. P95 ≤ 2 с держится тёплым кэшем открывающих.
 *  - `refresh=true` («Обновить») — мимо свежего кэша: не чаще раза в DASHBOARD_FORCE_MIN_SECONDS (15) на сотрудника
 *    (Redis NX); чаще — обычный путь через кэш.
 *  - Single-flight — по (блок, период, набор прав): ответ 403 одному сотруднику не раздаётся другим; 403 не кэшируется.
 *  - «Сегодня» — с 00:00 по Ташкенту у всех блоков (users и support считают сами по Asia/Tashkent; offers, news, AI —
 *    from/to отсюда). Суточные бюджеты AI — по UTC (сутки лимитов provider-gateway).
 *  - Права блоков: users — ещё и `users.read` (иначе `forbidden`); ai — только с подключённым ai-control.
 *  - Сбой Redis — дашборд работает без кэша (каждый блок — прямой вызов с тем же таймаутом).
 *  - В лог — `dashboard_ms` и число блоков из кэша (цель P95 ≤ 2 с на тёплом кэше).
 */
import { createHash } from "node:crypto";
import type { Actor } from "@tilhero/ts-common";
import type {
  DashboardAi,
  DashboardBlock,
  DashboardBlockReason,
  DashboardV2,
  Permission,
  WatchStats,
} from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { staffOf, type App } from "../http.js";
import { requirePermission } from "../rbac.js";
import { BOOL_Q, PERIOD, query } from "../schemas.js";
import { ok } from "../responses.js";
import { BadValue, C, parseDomain, type Codec } from "../codec.js";
import { DOMAIN, type DomainKey } from "../upstream.js";
import { AI_KPI, CONTROL_OVERVIEW } from "./aiCodecs.js";
import { normalizeWatchStats } from "./watch.js";
import { WATCH_STATS } from "../responses.js";
import {
  DASHBOARD_AI_AGENT,
  NEWS_STATS,
  NO_FLIGHT_STATS,
  OPS_SUMMARY,
  SUPPORT_STATS,
  TRIPS_STATS,
  USERS_STATS,
} from "./opsCodecs.js";

type Period = DashboardV2["period"];
export type BlockName = "users" | "trips" | "no_flight" | "watch" | "news" | "ai" | "support" | "system";
export const BLOCKS: readonly BlockName[] = ["users", "trips", "no_flight", "watch", "news", "ai", "support", "system"];
const PERIODS: readonly Period[] = ["today", "7d", "30d"];
/** «Обновить» мимо кэша — не чаще раза в N секунд на сотрудника. */
export const DASHBOARD_FORCE_MIN_SECONDS = 15;
const TASHKENT_OFFSET_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;

/** Период дашборда → [from, to) в ISO UTC: today — с полуночи по Ташкенту (как active_today у user-admin), 7d/30d — скользящие. */
export function periodRange(now: number, period: Period): { from: string; to: string } {
  const start =
    period === "today" ? Math.floor((now + TASHKENT_OFFSET_MS) / DAY_MS) * DAY_MS - TASHKENT_OFFSET_MS : now - (period === "7d" ? 7 : 30) * DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { from: iso(start), to: iso(now) };
}

interface Fetch {
  ctx: BffContext;
  actor: Actor;
  period: Period;
  timeoutMs: number;
}
interface BlockSpec<T> {
  domain: DomainKey;
  codec: Codec<T>;
  /** доп. право блока сверх dashboard.read */
  permission?: Permission;
  /** свежесть кэша: множитель DASHBOARD_CACHE_SECONDS */
  ttlFactor?: number;
  fetch(f: Fetch): Promise<T>;
}

const ro = (f: Fetch, q?: Record<string, string | number | boolean | undefined>) => ({ actor: f.actor, timeoutMs: f.timeoutMs, retries: 0, ...(q ? { query: q } : {}) });

const WATCH_C = C.custom<WatchStats>(WATCH_STATS as never, (v, p) => {
  const n = normalizeWatchStats(v);
  if (!n) throw new BadValue(p);
  return n;
});

const AI_BLOCK: Codec<DashboardAi> = C.obj<DashboardAi>({
  kpi: AI_KPI,
  budgets: C.nullable(C.obj<NonNullable<DashboardAi["budgets"]>>({ agents: C.arr(DASHBOARD_AI_AGENT, 50), provider_paused: C.bool })),
});

export const SPECS: { [K in BlockName]: BlockSpec<unknown> } = {
  users: {
    domain: "userAdmin",
    codec: USERS_STATS,
    permission: "users.read",
    ttlFactor: 5,
    fetch: (f) => f.ctx.domains.userAdmin.get<unknown>("/admin/v1/users/stats", ro(f, { period: f.period })),
  },
  trips: {
    domain: "offers",
    codec: TRIPS_STATS,
    fetch: (f) => f.ctx.domains.offers.get<unknown>("/internal/v1/offers/stats", ro(f, periodRange(f.ctx.now(), f.period))),
  },
  no_flight: {
    domain: "offers",
    codec: NO_FLIGHT_STATS,
    fetch: (f) => f.ctx.domains.offers.get<unknown>("/internal/v1/offers/stats/no-flight", ro(f, { ...periodRange(f.ctx.now(), f.period), limit: 20 })),
  },
  watch: {
    domain: "watch",
    codec: WATCH_C,
    fetch: (f) => f.ctx.domains.watch.get<unknown>("/internal/v1/watches:stats", ro(f)),
  },
  news: {
    domain: "news",
    codec: NEWS_STATS,
    fetch: (f) => f.ctx.domains.news.get<unknown>("/internal/v1/news/stats", ro(f, periodRange(f.ctx.now(), f.period))),
  },
  ai: {
    domain: "aiControl",
    codec: AI_BLOCK,
    fetch: async (f) => {
      const control = f.ctx.domains.aiControl;
      const [kpi, overview] = await Promise.all([
        // та же граница «сегодня» (00:00 Ташкента), что у остальных блоков
        control.get<unknown>("/internal/v1/usage/kpi", ro(f, periodRange(f.ctx.now(), f.period))),
        // бюджеты — дополнение: их сбой не прячет расходы
        control.get<unknown>("/internal/v1/budgets/overview", ro(f)).then(
          (v) => v,
          () => null,
        ),
      ]);
      let budgets: DashboardAi["budgets"] = null;
      if (overview !== null) {
        try {
          const o = CONTROL_OVERVIEW.parse(overview, "$.budgets");
          budgets = {
            provider_paused: o.provider.anthropic.paused !== null,
            agents: o.agents.map((a) => ({
              agent_id: a.agent_id,
              name: a.name,
              state: a.state,
              day: a.day,
              month_cost_usd: a.month?.cost_usd ?? null,
              paused: a.paused !== null,
            })),
          };
        } catch {
          f.ctx.log.warn({ upstream: DOMAIN.aiControl, upstream_code: "UPSTREAM_BAD_RESPONSE" }, "dashboard ai budgets rejected");
        }
      }
      return { kpi, budgets };
    },
  },
  support: {
    domain: "support",
    codec: SUPPORT_STATS,
    fetch: (f) => f.ctx.domains.support.get<unknown>("/admin/v1/support/stats", ro(f, { period: f.period })),
  },
  system: {
    domain: "opsMonitor",
    codec: OPS_SUMMARY,
    fetch: (f) => f.ctx.domains.opsMonitor.get<unknown>("/internal/v1/ops/summary", ro(f)),
  },
};

/** Схема ответа: блок → {available, reason, stale, as_of, data: схема данных | null}. */
const blockSchema = (data: Record<string, unknown>) => ({
  type: "object",
  properties: {
    available: { type: "boolean" },
    reason: { type: ["string", "null"] },
    stale: { type: "boolean" },
    as_of: { type: ["string", "null"] },
    data: { ...data, type: [data.type as string, "null"] },
  },
  "x-contract-required": ["available", "reason", "stale", "as_of", "data"],
});
export const DASHBOARD_V2_SCHEMA = {
  type: "object",
  properties: {
    period: { type: "string" },
    generated_at: { type: "string" },
    ...Object.fromEntries(BLOCKS.map((b) => [b, blockSchema(SPECS[b].codec.schema as Record<string, unknown>)])),
    commercial: { type: "object", properties: { available: { type: "boolean" }, reason: { type: "string" } }, "x-contract-required": ["available", "reason"] },
  },
  "x-contract-required": ["period", "generated_at", ...BLOCKS, "commercial"],
};

interface Cached {
  as_of: string;
  data: unknown;
}

const off = <T>(reason: DashboardBlockReason): DashboardBlock<T> => ({ available: false, reason, stale: false, as_of: null, data: null });
const isTimeout = (e: unknown) => e instanceof Error && e.message === "dashboard-block-timeout";

export class DashboardCache {
  private readonly inflight = new Map<string, Promise<Cached>>();

  constructor(private readonly ctx: BffContext) {}

  /** `<REDIS_KEY_PREFIX>dash:<block>:<period>` */
  key(b: BlockName, p: Period): string {
    return `${this.ctx.config.redisKeyPrefix}dash:${b}:${p}`;
  }

  private ttl(b: BlockName): number {
    return this.ctx.config.dashboardCacheSeconds * (SPECS[b].ttlFactor ?? 1);
  }

  private async read(k: string): Promise<Cached | null> {
    try {
      const raw = await this.ctx.redis.get(k);
      if (!raw) return null;
      const v = JSON.parse(raw) as Cached;
      return v && typeof v.as_of === "string" ? v : null;
    } catch {
      return null;
    }
  }

  private async write(b: BlockName, p: Period, v: Cached): Promise<void> {
    const ttl = this.ttl(b);
    const stale = this.ctx.config.dashboardStaleMaxSeconds;
    try {
      const raw = JSON.stringify(v);
      const m = this.ctx.redis.multi();
      if (ttl > 0) m.set(this.key(b, p), raw, "EX", ttl);
      if (stale > 0) m.set(`${this.key(b, p)}:last`, raw, "EX", stale);
      await m.exec();
    } catch {
      this.ctx.log.warn({ block: b }, "dashboard cache write failed");
    }
  }

  /** Один вызов источника на (блок, период, набор прав) за раз; успешный результат — в кэш (ошибки, в т. ч. 403, — нет). */
  refresh(b: BlockName, p: Period, actor: Actor): Promise<Cached> {
    const k = this.key(b, p);
    const flight = `${k}#${permsKey(actor.permissions)}`;
    const running = this.inflight.get(flight);
    if (running) return running;
    const spec = SPECS[b];
    const task = (async () => {
      const raw = await spec.fetch({ ctx: this.ctx, actor, period: p, timeoutMs: Math.max(this.ctx.config.dashboardTimeoutMs, this.ctx.config.dashboardBlockTimeoutMs) });
      const data = parseDomain(this.ctx, DOMAIN[spec.domain], spec.codec, raw);
      const v: Cached = { as_of: new Date(this.ctx.now()).toISOString().replace(/\.\d{3}Z$/, "Z"), data };
      await this.write(b, p, v);
      return v;
    })().finally(() => this.inflight.delete(flight));
    this.inflight.set(flight, task);
    return task;
  }

  async block<T>(b: BlockName, p: Period, actor: Actor, perms: ReadonlySet<string>, force = false): Promise<DashboardBlock<T>> {
    const spec = SPECS[b];
    if (spec.permission && !perms.has(spec.permission)) return off("forbidden");
    if (!this.ctx.domains[spec.domain].configured) return off("not_configured");
    const fresh = force ? null : await this.read(this.key(b, p));
    if (fresh) return { available: true, reason: null, stale: false, as_of: fresh.as_of, data: fresh.data as T };
    const task = this.refresh(b, p, actor);
    let timer: NodeJS.Timeout | undefined;
    try {
      const v = await Promise.race([
        task,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("dashboard-block-timeout")), this.ctx.config.dashboardBlockTimeoutMs);
          timer.unref();
        }),
      ]);
      return { available: true, reason: null, stale: false, as_of: v.as_of, data: v.data as T };
    } catch (e) {
      task.catch(() => undefined); // вызов продолжается и пополнит кэш; его сбой здесь уже не нужен
      const forbidden = e instanceof Error && "status" in e && (e as { status: number }).status === 403;
      if (!isTimeout(e)) this.ctx.log.warn({ block: b, upstream: DOMAIN[spec.domain], upstream_code: (e as { code?: string })?.code }, "dashboard block unavailable");
      const last = await this.read(`${this.key(b, p)}:last`);
      if (last && !forbidden) return { available: true, reason: null, stale: true, as_of: last.as_of, data: last.data as T };
      return off(forbidden ? "forbidden" : isTimeout(e) ? "timeout" : "unavailable");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** «Обновить»: разрешено ли сотруднику пойти мимо кэша (раз в DASHBOARD_FORCE_MIN_SECONDS; Redis недоступен — да, кэша и так нет). */
  async allowForce(staffId: string): Promise<boolean> {
    try {
      const got = await this.ctx.redis.set(`${this.ctx.config.redisKeyPrefix}dash:force:${staffId}`, "1", "EX", DASHBOARD_FORCE_MIN_SECONDS, "NX");
      return got === "OK";
    } catch {
      return true;
    }
  }
}

/** Отпечаток набора прав для ключа single-flight (порядок прав не важен). */
export function permsKey(perms: readonly string[]): string {
  return createHash("sha256").update([...perms].sort().join(",")).digest("hex").slice(0, 16);
}

export function dashboardRoutes(app: App, ctx: BffContext): DashboardCache {
  const cache = new DashboardCache(ctx);

  app.get<{ Querystring: { period?: Period; refresh?: "true" | "false" } }>(
    "/admin/v1/dashboard",
    { config: requirePermission("dashboard.read"), schema: { response: ok(DASHBOARD_V2_SCHEMA), querystring: query({ period: PERIOD, refresh: BOOL_Q }) } },
    async (req) => {
      const started = performance.now();
      const auth = staffOf(req);
      const period: Period = PERIODS.includes(req.query.period as Period) ? (req.query.period as Period) : "today";
      const perms = new Set<string>(auth.actor.permissions);
      const force = req.query.refresh === "true" && (await cache.allowForce(auth.actor.id));
      const blocks = await Promise.all(BLOCKS.map((b) => cache.block(b, period, auth.actor, perms, force)));
      const body = {
        period,
        generated_at: new Date(ctx.now()).toISOString(),
        ...Object.fromEntries(BLOCKS.map((b, i) => [b, blocks[i]])),
        commercial: { available: false, reason: "postponed" },
      } as unknown as DashboardV2;
      ctx.log.info(
        {
          dashboard_ms: Math.round(performance.now() - started),
          period,
          force,
          blocks_off: BLOCKS.filter((_, i) => !blocks[i]!.available).length,
          blocks_stale: BLOCKS.filter((_, i) => blocks[i]!.stale).length,
        },
        "dashboard served",
      );
      return body;
    },
  );
  return cache;
}
