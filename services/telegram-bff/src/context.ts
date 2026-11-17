/**
 * Зависимости обработчиков BFF (собираются в buildApp, в тестах подменяются Redis/fetch).
 */
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type { Preferences } from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import type { ConciergeService } from "./ai.js";
import type { Config } from "./config.js";
import type { EventsCatalog } from "./events.js";
import type { ExperienceCache } from "./experience.js";
import type { FacetsService } from "./facets.js";
import type { HomeService } from "./home.js";
import type { OffersService } from "./offers.js";
import type { LastTripStore, NewsService, RecommendationsService, WatchService } from "./personal.js";
import type { RateLimiter } from "./rateLimit.js";
import type { SessionStore } from "./sessions.js";
import type { AccessTokens } from "./tokens.js";
import type { ReleaseNotesFeed } from "./whatsNew.js";
import { upstreamUnavailable, type Domains } from "./upstream.js";
import type { IdentityMe } from "./views.js";

export interface BffContext {
  config: Config;
  redis: Redis;
  sessions: SessionStore;
  limiter: RateLimiter;
  tokens: AccessTokens;
  domains: Domains;
  experience: ExperienceCache;
  /** 9.4: лента опубликованных заметок «Что нового» (кэш как у experience config, stale при сбое). */
  whatsNew: ReleaseNotesFeed;
  /** event-catalog: поиск и деталь (503 EVENTS_UNAVAILABLE при недоступности). */
  catalog: EventsCatalog;
  /** Счётчики быстрых фильтров каталога (кэш в Redis по набору фильтров). */
  facets: FacetsService;
  /** Home: рельсы событий + stale-кэш в Redis. */
  home: HomeService;
  /** offers (спринт 5): сборка предложений и проверка снимков; без OFFERS_URL — configured=false. */
  offers: OffersService;
  /** Спринт 6: ранжирование и реакции (без RECOMMENDATIONS_URL — configured=false). */
  recommendations: RecommendationsService;
  /** Спринт 6: слежения (без WATCH_URL — configured=false, /v1/watches → 503 FEATURE_UNAVAILABLE). */
  watch: WatchService;
  /** Спринт 6: новости (без NEWS_URL — configured=false, /v1/news → 503 FEATURE_UNAVAILABLE). */
  news: NewsService;
  /** Последний расчёт «Поездки» пользователя по событию (offer_params слежения, trip_per_person). */
  lastTrip: LastTripStore;
  /** Спринт 7: AI-консьерж (без AI_CONCIERGE_URL — configured=false, /v1/ai/* → 503 FEATURE_UNAVAILABLE). */
  concierge: ConciergeService;
  log: FastifyBaseLogger;
  /** Вызов хранилища сессий/лимитов: сбой Redis → 503 (fail-closed), без деталей наружу. */
  store<T>(fn: () => Promise<T>): Promise<T>;
}

export function makeStoreGuard(log: FastifyBaseLogger) {
  return async function store<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      log.error({ err_name: (err as Error)?.name, err_message: (err as Error)?.message }, "session store failure");
      throw upstreamUnavailable("session-store");
    }
  };
}

/** Профиль identity + предпочтения — параллельно (оба нужны для SessionResponse и Profile). */
export async function loadAccount(ctx: BffContext, userId: string): Promise<{ me: IdentityMe; prefs: Preferences }> {
  const [me, prefs] = await Promise.all([
    ctx.domains.identity.get<IdentityMe>("/internal/v1/me", { subject: userId }),
    ctx.domains.preferences.get<Preferences>("/internal/v1/me/preferences", { subject: userId }),
  ]);
  return { me, prefs };
}
