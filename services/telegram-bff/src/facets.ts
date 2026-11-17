/**
 * GET /v1/events/facets (исправление 4.1): счётчики быстрых фильтров каталога из event-catalog
 * `GET /internal/v1/events:facets`, общий для всех пользователей кэш в Redis на FACETS_CACHE_SECONDS (60 с).
 *
 *  - Ключ — sha256 нормализованного набора фильтров (страны отсортированы и без дублей, пустые параметры отброшены)
 *    вместе с окном this_month (month_from/month_to): одинаковые фильтры в разном порядке попадают в одну запись;
 *    текст поиска в ключе Redis не виден.
 *  - Счётчики не персональные (как и поиск каталога): user_id в ключ и в запрос каталога не попадает.
 *  - Одинаковые одновременные запросы в одном процессе склеиваются (single-flight) — каталог вызывается один раз.
 *  - Ошибка чтения/записи кэша не ломает ответ — кэш пропускается (предупреждение в лог).
 *  - Недоступность каталога → 503 EVENTS_UNAVAILABLE (stale-копии нет: Mini App покажет чипы без счётчиков).
 *  - Копия из Redis при чтении снова проходит маппинг контракта (toFacets).
 */
import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type { EventFacets } from "@tilhero/contracts/bff";
import { toFacets, type EventsCatalog, type FacetsQuery } from "./events.js";

export interface FacetsDeps {
  redis: Redis;
  catalog: EventsCatalog;
  keyPrefix: string;
  ttlSeconds: number;
  log: FastifyBaseLogger;
}

/** Канонический вид фильтров: только заданные параметры, в фиксированном порядке; страны — по алфавиту, без дублей. */
export function canonicalFacetsQuery(q: FacetsQuery): FacetsQuery {
  const out: FacetsQuery = {};
  if (q.q) out.q = q.q;
  if (q.category) out.category = q.category;
  if (q.country?.length) out.country = [...new Set(q.country)].sort();
  if (q.city) out.city = q.city;
  if (q.date_from) out.date_from = q.date_from;
  if (q.date_to) out.date_to = q.date_to;
  if (q.has_tickets !== undefined) out.has_tickets = q.has_tickets;
  if (q.online !== undefined) out.online = q.online;
  // окно this_month — часть ключа: у пользователей в разных часовых поясах (и до/после полуночи) разные счётчики
  if (q.month_from && q.month_to) {
    out.month_from = q.month_from;
    out.month_to = q.month_to;
  }
  return out;
}

export class FacetsService {
  private readonly inflight = new Map<string, Promise<EventFacets>>();

  constructor(private readonly d: FacetsDeps) {}

  key(q: FacetsQuery): string {
    const digest = createHash("sha256").update(JSON.stringify(canonicalFacetsQuery(q))).digest("hex");
    return `${this.d.keyPrefix}facets:v1:${digest}`;
  }

  async get(query: FacetsQuery): Promise<EventFacets> {
    const q = canonicalFacetsQuery(query);
    const key = this.key(q);
    const cached = await this.read(key);
    if (cached) return cached;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.d.catalog
      .facets(q)
      .then(async (f) => {
        await this.write(key, f);
        return f;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async read(key: string): Promise<EventFacets | null> {
    if (this.d.ttlSeconds <= 0) return null;
    try {
      const raw = await this.d.redis.get(key);
      return raw ? toFacets(JSON.parse(raw)) : null;
    } catch (err) {
      this.d.log.warn({ err_name: (err as Error)?.name }, "facets cache read failed");
      return null;
    }
  }

  private async write(key: string, f: EventFacets): Promise<void> {
    if (this.d.ttlSeconds <= 0) return;
    try {
      await this.d.redis.set(key, JSON.stringify(f), "EX", this.d.ttlSeconds);
    } catch (err) {
      this.d.log.warn({ err_name: (err as Error)?.name }, "facets cache write failed");
    }
  }
}
