/**
 * Спринт 6 — статистика слежений (docs/sprint6/INTERNAL_API.md §8): GET /admin/v1/watches/stats (dashboard.read) →
 * watch `GET /internal/v1/watches:stats` с actor. Без WATCH_URL — 503 FEATURE_UNAVAILABLE {service: "watch"}.
 * Ответ домена нормализуется: счётчики — неотрицательные целые (иначе 0), типы изменений — шесть известных
 * (прочие отбрасываются), время — ISO; ответ не-объект → 503 UPSTREAM_UNAVAILABLE {service: "watch"}.
 */
import type { WatchChangeType, WatchStats } from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { staffOf, type App } from "../http.js";
import { requirePermission } from "../rbac.js";
import { ok, WATCH_STATS } from "../responses.js";
import { upstreamUnavailable } from "../upstream.js";
import { isoTime } from "./travel.js";

export const WATCH_CHANGE_TYPES: readonly WatchChangeType[] = ["price_drop", "price_rise", "lifecycle", "tickets", "flight", "hotel"];

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1e9 ? v : 0);

export function normalizeWatchStats(v: unknown): WatchStats | null {
  if (!isRec(v)) return null;
  const ch = isRec(v.changes_24h) ? v.changes_24h : {};
  const nt = isRec(v.notifications_24h) ? v.notifications_24h : {};
  return {
    active: count(v.active),
    paused: count(v.paused),
    ended_24h: count(v.ended_24h),
    rechecks_24h: count(v.rechecks_24h),
    changes_24h: Object.fromEntries(WATCH_CHANGE_TYPES.map((k) => [k, count(ch[k])])) as WatchStats["changes_24h"],
    notifications_24h: { immediate: count(nt.immediate), digest: count(nt.digest), suppressed: count(nt.suppressed) },
    errors_24h: count(v.errors_24h),
    next_batch_at: isoTime(v.next_batch_at),
  };
}

export function watchRoutes(app: App, ctx: BffContext): void {
  app.get("/admin/v1/watches/stats", { config: requirePermission("dashboard.read"), schema: { response: ok(WATCH_STATS) } }, async (req) => {
    const auth = staffOf(req);
    const out = normalizeWatchStats(await ctx.domains.watch.get<unknown>("/internal/v1/watches:stats", { actor: auth.actor }));
    if (!out) {
      ctx.log.warn({ upstream: "watch", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "watch stats rejected by normalization");
      throw upstreamUnavailable("watch");
    }
    return out;
  });
}
