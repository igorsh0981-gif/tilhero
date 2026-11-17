/**
 * Тестовая обвязка: реальный Redis (DB 14, уникальный префикс ключей на приложение), домены — in-memory
 * подделка, подключённая через fetchImpl. Подделка проверяет внутренний JWT (aud = домен, iss = telegram-bff)
 * и берёт user_id ТОЛЬКО из sub — как настоящие домены.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { verifyInternalToken } from "@tilhero/ts-common";
import type {
  ConsentState,
  EventDetailView,
  ExperienceConfig,
  NotificationSettings,
  Offer,
  OfferSetView,
  OfferTier,
  Preferences,
  SecurityState,
  Ticket,
  UserSummary,
} from "@tilhero/contracts/bff";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import type { App } from "../src/http.js";
import { signInitData } from "../src/telegramAuth.js";

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/14";
export const BOT_TOKEN = "7000000001:AAtest-bot-token-for-unit-tests-only-xx";
export const INTERNAL_SECRET = "internal-test-secret-" + "z".repeat(32);
export const SESSION_SECRET = "session-test-secret-" + "s".repeat(32);
export const ORIGIN = "https://miniapp.tilhero.test";

const URLS = {
  identity: "http://identity.test",
  preferences: "http://preferences.test",
  support: "http://support.test",
  experience: "http://experience.test",
  events: "http://events.test",
  offers: "http://offers.test",
  recommendations: "http://recommendations.test",
  watch: "http://watch.test",
  news: "http://news.test",
  aiConcierge: "http://ai-concierge.test",
} as const;

/** Спринт 6: домены recommendations/watch/news подключены (по умолчанию в тестах — нет, как без URL в окружении). */
/** Спринт 7: ai-concierge подключён (обработчик — FakeDomains.aiHandler, см. test/aiFake.ts). */
export const SPRINT7_ENV = { AI_CONCIERGE_URL: "http://ai-concierge.test" };
export const SPRINT6_ENV = { RECOMMENDATIONS_URL: URLS.recommendations, WATCH_URL: URLS.watch, NEWS_URL: URLS.news };

export function testConfig(env: Record<string, string> = {}): Config {
  const prefix = `bfftest:${randomUUID().slice(0, 8)}:`;
  return loadConfig({
    NODE_ENV: "test",
    BOT_TOKEN,
    SESSION_JWT_SECRET: SESSION_SECRET,
    INTERNAL_JWT_SECRET: INTERNAL_SECRET,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_KEY_PREFIX: prefix,
    RATE_LIMIT_KEY_PREFIX: prefix, // спринт 9: ключи лимитера — тоже с префиксом приложения
    MINIAPP_ORIGIN: ORIGIN,
    IDENTITY_URL: URLS.identity,
    PREFERENCES_URL: URLS.preferences,
    SUPPORT_URL: URLS.support,
    EXPERIENCE_URL: URLS.experience,
    EVENTS_URL: URLS.events,
    OFFERS_URL: URLS.offers,
    UPSTREAM_RETRIES: "0",
    UPSTREAM_TIMEOUT_MS: "2000",
    LOG_LEVEL: "info",
    ...env,
  });
}

// ---------------------------------------------------------------- log capture

export class LogCapture {
  readonly lines: string[] = [];
  write(msg: string): void {
    this.lines.push(msg);
  }
  get text(): string {
    return this.lines.join("");
  }
  parsed(): Array<Record<string, unknown>> {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

// ---------------------------------------------------------------- fake domains

type Service = keyof typeof URLS;

export interface Call {
  service: Service;
  method: string;
  path: string;
  query: Record<string, string>;
  subject: string | undefined;
  body: unknown;
  headers: Record<string, string>;
  startedAt: number;
}

export interface Req {
  method: string;
  path: string;
  query: Record<string, string>;
  subject: string | undefined;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string>;
  /** сигнал вызывающего (отмена потока) */
  signal?: AbortSignal | undefined;
}

export type Handler = (r: Req) => Response | Promise<Response>;

interface FakeUser {
  summary: UserSummary;
  telegramId: number;
  security: SecurityState;
  pin: string | null;
  biometricToken: string | null;
  consent: ConsentState;
  settings: NotificationSettings;
  failedPins: number;
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const domainError = (status: number, code: string, details: Record<string, unknown> = {}) =>
  json(status, { code, message: `domain says ${code}`, trace_id: "domain-trace", details });

export const DEFAULT_EXPERIENCE: ExperienceConfig = {
  app: "miniapp",
  version: "2.0.3",
  theme: { id: "dark-premium", version: "2.0.3", tokens: { "--color-bg": "#0b0d12" } },
  home: {
    welcome_mode: "first_visit_only",
    sections: [
      { type: "event_carousel", key: "best_for_you", variant: "large", enabled: true },
      { type: "watch_changes", key: "watch", variant: "compact", enabled: true },
      { type: "event_carousel", key: "sales_soon", variant: "compact", enabled: false },
      { type: "news_carousel", key: "news", variant: "compact", enabled: true },
    ],
  },
  flags: { ai_summary: false },
  hotel_rating_min: 8.5,
};

function defaultPrefs(): Preferences {
  return {
    interests: { categories: [], entities: [] },
    geographies: [],
    strong_events_outside_geo: false,
    event_formats: ["offline"],
    budget: { currency: "USD", preset: null, min: null, max: null, custom_amount: null },
    search_horizon_months: 12,
    notification_points_months: [3, 6],
    departures: [],
    flight_prefs: { direct: true, connecting: true, alternative_departure: true },
    hotel_prefs: { rating_min: null, max_distance_km: null, min_stars: null },
    onboarding_completed_at: null,
    updated_at: "2026-10-08T10:00:00Z",
    version: 1,
  };
}

export class FakeDomains {
  readonly calls: Call[] = [];
  readonly usersByTg = new Map<number, FakeUser>();
  readonly usersById = new Map<string, FakeUser>();
  readonly prefs = new Map<string, Preferences>();
  readonly tickets = new Map<string, Ticket & { owner: string }>();
  readonly ticketIdem = new Map<string, string>();
  experience: ExperienceConfig = structuredClone(DEFAULT_EXPERIENCE);
  /** event-catalog: EventDetail с «внутренними» полями каталога (BFF не должен пропускать их наружу). */
  readonly catalog: CatalogEvent[] = [];
  /** Домены, «лежащие» на сетевом уровне (fetch бросает). */
  readonly down = new Set<Service>();
  /** Искусственная задержка ответа домена, мс. */
  readonly delays = new Map<Service, number>();
  private readonly overrides = new Map<string, Handler>();
  private ticketSeq = 3000;

  /** Подмена обработчика: key = "service METHOD /path" (путь без query). */
  override(service: Service, method: string, path: string, h: Handler): void {
    this.overrides.set(`${service} ${method} ${path}`, h);
  }

  user(userId: string): FakeUser {
    const u = this.usersById.get(userId);
    if (!u) throw new Error(`no fake user ${userId}`);
    return u;
  }

  /** Включить PIN пользователю напрямую (как будто задан ранее). */
  enablePin(userId: string, pin: string): void {
    const u = this.user(userId);
    u.pin = pin;
    u.security = { ...u.security, pin_enabled: true, pin_length: pin.length as 4 | 6 };
  }

  callsTo(service: Service, method?: string, path?: string): Call[] {
    return this.calls.filter((c) => c.service === service && (!method || c.method === method) && (!path || c.path === path));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const service = (Object.keys(URLS) as Service[]).find((k) => URLS[k] === url.origin);
    if (!service) throw new TypeError(`unknown upstream ${url.origin}`);
    const delay = this.delays.get(service);
    const startedAt = performance.now();
    // задержка прерывается сигналом вызывающего (таймаут ServiceClient), как у настоящего fetch
    if (delay) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      });
    }
    if (this.down.has(service)) throw new TypeError("fetch failed: ECONNREFUSED");

    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const body = bodyText ? JSON.parse(bodyText) : undefined;

    let subject: string | undefined;
    try {
      const v = await verifyInternalToken(headers["x-internal-token"] ?? "", INTERNAL_SECRET, DOMAIN_AUD[service], new Set(["telegram-bff"]));
      subject = v.subject;
    } catch (err) {
      const e = err as { status?: number; code?: string };
      return domainError(e.status ?? 401, e.code ?? "INTERNAL_TOKEN_INVALID");
    }
    const query = Object.fromEntries(url.searchParams);
    this.calls.push({ service, method, path: url.pathname, query, subject, body, headers, startedAt });
    const req: Req = { method, path: url.pathname, query, subject, body, headers, signal: init?.signal ?? undefined };
    const ov = this.overrides.get(`${service} ${method} ${url.pathname}`);
    const res = ov ? await ov(req) : await this.route(service, req);
    if (!this.decorate || res.status >= 300 || res.status === 204) return res;
    const parsed: unknown = JSON.parse(await res.text());
    return json(res.status, this.decorate(parsed));
  };

  /** Пост-обработка успешных JSON-ответов доменов (тест «домен вернул лишние поля»). */
  decorate: ((body: unknown) => unknown) | null = null;

  private me(u: FakeUser) {
    return { user: u.summary, security: u.security, consent: u.consent, settings: u.settings };
  }

  private requireUser(r: Req): FakeUser | Response {
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    const u = this.usersById.get(r.subject);
    return u ?? domainError(404, "USER_NOT_FOUND");
  }

  private route(service: Service, r: Req): Response | Promise<Response> {
    switch (service) {
      case "identity":
        return this.identity(r);
      case "preferences":
        return this.preferencesRoute(r);
      case "support":
        return this.support(r);
      case "experience":
        if (r.method === "GET" && r.path === "/internal/v1/experience/miniapp/current") return json(200, this.experience);
        return domainError(404, "NOT_FOUND");
      case "events":
        return this.events(r);
      case "offers":
        return this.offersRoute(r);
      case "recommendations":
        return this.recommendationsRoute(r);
      case "watch":
        return this.watchRoute(r);
      case "news":
        return this.newsRoute(r);
      case "aiConcierge":
        return this.aiHandler ? this.aiHandler(r) : json(404, { detail: "Not Found" });
    }
  }

  /** Спринт 7: обработчик ai-concierge (test/aiFake.ts). */
  aiHandler: Handler | null = null;

  // ---------------------------------------------------------------- спринт 6: recommendations / watch / news

  /** Реакции: `${user}:${event}` → {reaction, categories}. */
  readonly reactions = new Map<string, { reaction: string; categories: string[] }>();
  /** Подмена ответа rank: получает тело запроса и «честный» ответ. */
  rankHook: ((body: any, honest: { items: any[] }) => unknown) | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any

  private recommendationsRoute(r: Req): Response {
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    if (r.method === "POST" && r.path === "/internal/v1/recommendations:rank") {
      const b = r.body as { candidates: Array<{ event_id: string; quality_score: number; categories: string[]; trip_per_person: string | null }>; limit: number };
      const items = b.candidates
        .filter((c) => this.reactions.get(`${r.subject}:${c.event_id}`)?.reaction !== "less")
        .map((c) => {
          // «рекомендация» — обратный quality (чтобы порядок отличался от прежнего)
          const score = Math.max(0, Math.min(100, 100 - c.quality_score + (this.reactions.get(`${r.subject}:${c.event_id}`)?.reaction === "more" ? 5 : 0)));
          return {
            event_id: c.event_id,
            score,
            bucket: (c.categories[0] ?? "other").split(".")[0],
            reasons: [
              { code: "INTEREST_MATCH", params: { category: c.categories[0] ?? "other" }, kind: "fact" },
              c.trip_per_person
                ? { code: "FITS_BUDGET", params: { amount: c.trip_per_person }, kind: "estimate" }
                : { code: "HIGH_SIGNIFICANCE", params: {}, kind: "recommendation" },
            ],
            factors: { interests: 80, geography: 50, budget: null, significance: c.quality_score, freshness: 40, feedback: 0 },
            internal_weight: 0.42, // лишнее поле — BFF не должен его пропустить
          };
        })
        .sort((a, b2) => b2.score - a.score || (a.event_id < b2.event_id ? -1 : 1))
        .slice(0, b.limit);
      const honest = { items };
      return json(200, this.rankHook ? this.rankHook(r.body, honest) : honest);
    }
    const rm = /^\/internal\/v1\/reactions\/([^/]+)$/.exec(r.path);
    if (r.method === "GET" && rm) {
      const cur = this.reactions.get(`${r.subject}:${rm[1]}`);
      return json(200, {
        event_id: rm[1],
        reaction: cur ? (cur.reaction === "less" ? "not_interested" : "more_like_this") : null,
        created_at: cur ? "2026-10-11T07:00:00.000Z" : null,
      });
    }
    if (r.method === "POST" && r.path === "/internal/v1/reactions") {
      const b = r.body as { event_id: string; categories: string[]; reaction: string; undo: boolean };
      const key = `${r.subject}:${b.event_id}`;
      if (b.undo) this.reactions.delete(key);
      else this.reactions.set(key, { reaction: b.reaction, categories: b.categories });
      return new Response(null, { status: 204 });
    }
    return domainError(404, "NOT_FOUND");
  }

  readonly watches = new Map<string, { owner: string; w: Record<string, any>; changes: unknown[] }>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  private readonly watchIdem = new Map<string, string>();
  watchLimit = 20;

  /** Слежение напрямую (как будто создано раньше). */
  addWatch(owner: string, eventId: string, o: Record<string, unknown> = {}, changes: unknown[] = []): string {
    const id = randomUUID();
    const e = this.catalog.find((x) => x.event_id === eventId);
    this.watches.set(id, { owner, w: watchFixture(id, eventId, e?.title ?? "Event", o), changes });
    return id;
  }

  private watchRoute(r: Req): Response {
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    const owner = r.subject;
    const mine = [...this.watches.values()].filter((x) => x.owner === owner);
    const withLast = (x: { w: Record<string, unknown>; changes: unknown[] }) => ({ ...x.w, last_change: x.changes[0] ?? x.w.last_change ?? null, user_id: owner });
    if (r.method === "POST" && r.path === "/internal/v1/watches") {
      const guarded = this.watchCreateGuard?.(r.body);
      if (guarded) return guarded;
      const idem = r.headers["idempotency-key"];
      if (!idem) return domainError(422, "IDEMPOTENCY_KEY_REQUIRED");
      const b = r.body as { event_id: string; offer_params: Record<string, unknown>; dimensions?: Record<string, boolean>; threshold_pct?: number };
      const prevId = this.watchIdem.get(`${owner}:${idem}`);
      if (prevId) return json(201, withLast(this.watches.get(prevId)!));
      const existing = mine.find((x) => x.w.event_id === b.event_id && x.w.status !== "ended");
      if (existing) return json(200, withLast(existing));
      const e = this.catalog.find((x) => x.event_id === b.event_id && !x.hidden);
      if (!e) return domainError(404, "EVENT_NOT_FOUND");
      if (e.is_past) return domainError(422, "EVENT_PAST");
      if (mine.filter((x) => x.w.status !== "ended").length >= this.watchLimit) return domainError(409, "WATCH_LIMIT", { limit: this.watchLimit });
      const id = randomUUID();
      const w = watchFixture(id, b.event_id, e.title, {
        offer_params: b.offer_params,
        ...(b.dimensions ? { dimensions: { ...watchFixture(id, b.event_id, "").dimensions, ...b.dimensions } } : {}),
        ...(b.threshold_pct ? { threshold_pct: b.threshold_pct } : {}),
      });
      this.watches.set(id, { owner, w, changes: [] });
      this.watchIdem.set(`${owner}:${idem}`, id);
      return json(201, withLast(this.watches.get(id)!));
    }
    if (r.method === "GET" && r.path === "/internal/v1/watches") {
      const items = mine.filter((x) => !r.query.status || x.w.status === r.query.status).slice(0, Number(r.query.limit ?? 20));
      return json(200, { items: items.map(withLast), next_cursor: null });
    }
    if (r.method === "GET" && r.path === "/internal/v1/watches:summary") {
      const since = Date.parse(r.query.since ?? "");
      const changes = mine.flatMap((x) => x.changes as Array<{ type: string; severity: string; detected_at: string }>).filter((c) => Date.parse(c.detected_at) > since);
      return json(200, {
        active: mine.filter((x) => x.w.status === "active").length,
        critical: changes.filter((c) => c.severity === "critical").length,
        price_drops_since: changes.filter((c) => c.type === "price_drop").length,
        next_check_at: "2026-10-11T18:00:00Z",
      });
    }
    if (r.method === "GET" && r.path === "/internal/v1/watches:by-events") {
      const ids = (r.query.ids ?? "").split(",");
      return json(200, { items: mine.filter((x) => ids.includes(String(x.w.event_id))).map((x) => ({ event_id: x.w.event_id, watch_id: x.w.watch_id, status: x.w.status })) });
    }
    const m = /^\/internal\/v1\/watches\/([^/]+)(\/changes)?$/.exec(r.path);
    if (m) {
      const x = this.watches.get(m[1]!);
      if (!x || x.owner !== owner) return domainError(404, "WATCH_NOT_FOUND");
      if (m[2] && r.method === "GET") return json(200, { items: x.changes, next_cursor: null });
      if (!m[2] && r.method === "GET") return json(200, { ...withLast(x), history: [] });
      if (!m[2] && r.method === "PATCH") {
        const b = r.body as { expected_version: number; status?: string; threshold_pct?: number; dimensions?: Record<string, boolean> };
        if (b.expected_version !== x.w.version) return domainError(409, "VERSION_CONFLICT", { current_version: x.w.version });
        x.w = {
          ...x.w,
          ...(b.status ? { status: b.status } : {}),
          ...(b.threshold_pct ? { threshold_pct: b.threshold_pct } : {}),
          ...(b.dimensions ? { dimensions: { ...x.w.dimensions, ...b.dimensions } } : {}),
          version: x.w.version + 1,
        };
        return json(200, withLast(x));
      }
      if (!m[2] && r.method === "DELETE") {
        this.watches.delete(m[1]!);
        return new Response(null, { status: 204 });
      }
    }
    return domainError(404, "NOT_FOUND");
  }

  /** Лента новостей (сырые элементы — тесты кладут и «плохие»). */
  readonly newsItems: unknown[] = [];
  readonly newsPrefs = new Map<string, Record<string, boolean>>();
  newsCursor: string | null = null;
  /** 6.1: ответ news:topics; null — старый news без маршрута (FastAPI 404 {detail}). */
  newsTopics: unknown = null;

  private newsRoute(r: Req): Response {
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    if (r.method === "POST" && r.path === "/internal/v1/news:topics") {
      return this.newsTopics === null ? json(404, { detail: "Not Found" }) : json(200, this.newsTopics);
    }
    const prefs = () => this.newsPrefs.get(r.subject!) ?? { from_watch: true, by_interests: true, only_significant: false, digest: true };
    if (r.method === "POST" && r.path === "/internal/v1/news:feed") {
      const b = r.body as { limit: number };
      return json(200, { items: this.newsItems.slice(0, b.limit + 5), next_cursor: this.newsCursor });
    }
    if (r.method === "GET" && r.path === "/internal/v1/news/preferences") return json(200, { ...prefs(), user_id: r.subject });
    if (r.method === "PUT" && r.path === "/internal/v1/news/preferences") {
      this.newsPrefs.set(r.subject, r.body as Record<string, boolean>);
      return json(200, prefs());
    }
    return domainError(404, "NOT_FOUND");
  }

  /** offers: снимки {offer_id → владелец, событие, Offer}; сборка ведёт себя как §2.1 (упрощённо). */
  readonly offerSnapshots = new Map<string, { owner: string; event_id: string; offer: Offer; created_at: string }>();
  /** Пост-обработка ответа offers:build (тесты «недоверенный ответ»). */
  offersBuild: ((set: OfferSetView, body: any) => unknown) | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any

  /** Предобработка запроса offers:build: вернула Response — он и уходит (например, 422 старого offers). */
  offersBuildGuard: ((body: any) => Response | null) | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** ревью 6.3: ответ watch на POST /internal/v1/watches до обработки (старый watch отвергает поле) */
  watchCreateGuard: ((body: any) => Response | null) | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any

  private offersRoute(r: Req): Response {
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    if (r.method === "POST" && r.path === "/internal/v1/offers:build") {
      const guarded = this.offersBuildGuard?.(r.body);
      if (guarded) return guarded;
      const b = r.body as { event_id: string; travellers: number; departures: Array<{ airport_iata: string }>; overrides?: { departure_iata: string | null } };
      const e = this.catalog.find((x) => x.event_id === b.event_id && !x.hidden);
      if (!e) return domainError(404, "EVENT_NOT_FOUND");
      const dep = b.overrides?.departure_iata ?? null;
      if (dep && !b.departures.some((d) => d.airport_iata === dep) && !["TAS", "ALA"].includes(dep)) {
        return domainError(422, "OFFER_DEPARTURE_INVALID", { departure_iata: dep });
      }
      const set = offerSetFixture(e.event_id, { travellers: b.travellers, departure: dep ?? b.departures[0]?.airport_iata ?? null });
      // 5.1: offers считает по присланному бюджету и выбранному отелю
      const bb = r.body as { budget?: OfferSetView["budget"]; overrides?: { hotel_id?: string | null } };
      set.budget = bb.budget ?? null;
      set.hotel_chosen_by = bb.overrides?.hotel_id ? "user" : "rules";
      for (const tier of Object.values(set.tiers ?? {})) {
        this.offerSnapshots.set(tier.offer_id, { owner: r.subject, event_id: e.event_id, offer: tier, created_at: set.generated_at });
      }
      return json(200, this.offersBuild ? this.offersBuild(set, b) : set);
    }
    const m = /^\/internal\/v1\/offers\/([^/]+)$/.exec(r.path);
    if (r.method === "GET" && m) {
      const snap = this.offerSnapshots.get(m[1]!);
      if (!snap || snap.owner !== r.subject) return domainError(404, "OFFER_NOT_FOUND");
      return json(200, {
        offer_id: m[1],
        event_id: snap.event_id,
        tier: snap.offer.tier,
        travellers: 2,
        created_at: snap.created_at,
        expires_at: snap.offer.expires_at,
        offer: snap.offer,
        trip: null,
        departure: null,
        notes: [],
        user_id: snap.owner, // внутреннее поле — BFF не должен его использовать/пропускать
      });
    }
    return domainError(404, "NOT_FOUND");
  }

  private identity(r: Req): Response {
    const key = `${r.method} ${r.path}`;
    if (key === "POST /internal/v1/users/telegram-login") {
      const b = r.body as { telegram_user_id: number; first_name: string; username?: string; language_code?: string };
      let u = this.usersByTg.get(b.telegram_user_id);
      const isNew = !u || u.summary.status === ("DELETED" as never);
      if (!u) {
        const userId = randomUUID();
        u = {
          telegramId: b.telegram_user_id,
          summary: {
            user_id: userId,
            display_name: b.first_name,
            username: b.username ?? null,
            locale: b.language_code?.startsWith("en") ? "en" : "ru",
            status: "ACTIVE",
            is_new: true,
          },
          security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null },
          pin: null,
          biometricToken: null,
          consent: {
            accepted: false,
            policy_version: null,
            current_policy_version: "2026-10-01",
            accepted_at: null,
            evidence_hash: null,
            age_confirmed_18_plus: false,
          },
          settings: { enabled: true, quiet_hours: null, digest_time: "09:00", timezone: "Asia/Tashkent" },
          failedPins: 0,
        };
        this.usersByTg.set(b.telegram_user_id, u);
        this.usersById.set(userId, u);
      }
      // домен «по ошибке» отдаёт внутреннее поле — BFF не должен его пропустить наружу
      return json(200, {
        ...this.me(u),
        user: { ...u.summary, is_new: isNew, telegram_user_id: u.telegramId },
        onboarding_completed: null,
      });
    }
    if (key === "GET /internal/v1/legal/policy") {
      return json(200, { version: "2026-10-01", purposes: [{ code: "core", required: true, title: "Сервис", description: "…" }], text: `# Policy ${r.query.lang}` });
    }
    const u = this.requireUser(r);
    if (u instanceof Response) return u;
    switch (key) {
      case "GET /internal/v1/me":
        return json(200, { ...this.me(u), user: { ...u.summary, is_new: false, telegram_user_id: u.telegramId } });
      case "PATCH /internal/v1/me/settings": {
        const b = r.body as { locale?: "ru" | "en"; notifications?: Partial<NotificationSettings> };
        if (b.locale) u.summary = { ...u.summary, locale: b.locale };
        if (b.notifications) u.settings = { ...u.settings, ...b.notifications };
        return json(200, this.me(u));
      }
      case "PUT /internal/v1/me/pin": {
        const b = r.body as { pin: string; current_pin?: string };
        if (u.pin && b.current_pin !== u.pin) return domainError(401, "PIN_INVALID", { remaining: 4 });
        if (!/^(\d{4}|\d{6})$/.test(b.pin) || b.pin === "1234") return domainError(422, "PIN_FORMAT");
        u.pin = b.pin;
        u.security = { ...u.security, pin_enabled: true, pin_length: b.pin.length as 4 | 6 };
        return json(200, u.security);
      }
      case "DELETE /internal/v1/me/pin": {
        const b = r.body as { current_pin: string };
        if (b.current_pin !== u.pin) return domainError(401, "PIN_INVALID", { remaining: 4 });
        u.pin = null;
        u.security = { ...u.security, pin_enabled: false, pin_length: null, biometric_enabled: false };
        return json(200, u.security);
      }
      case "POST /internal/v1/me/pin/verify": {
        const b = r.body as { pin: string };
        if (b.pin !== u.pin) {
          u.failedPins += 1;
          if (u.failedPins >= 5) return domainError(423, "PIN_LOCKED", { retry_after: 300 });
          return domainError(401, "PIN_INVALID", { remaining: 5 - u.failedPins });
        }
        u.failedPins = 0;
        return json(200, { ok: true });
      }
      case "POST /internal/v1/me/pin/reset-request":
        return json(200, { expires_in: 600 });
      case "POST /internal/v1/me/pin/reset-confirm": {
        const b = r.body as { code: string; new_pin: string };
        if (b.code !== "246810") return domainError(401, "RESET_CODE_INVALID", { remaining: 4 });
        u.pin = b.new_pin;
        u.security = { ...u.security, pin_enabled: true, pin_length: b.new_pin.length as 4 | 6 };
        return json(200, u.security);
      }
      case "PUT /internal/v1/me/biometric":
        if (!u.pin) return domainError(409, "PIN_REQUIRED");
        u.biometricToken = "bio_" + randomUUID().replaceAll("-", "");
        u.security = { ...u.security, biometric_enabled: true };
        return json(200, { biometric_token: u.biometricToken, security: u.security });
      case "DELETE /internal/v1/me/biometric":
        u.biometricToken = null;
        u.security = { ...u.security, biometric_enabled: false };
        return json(200, u.security);
      case "POST /internal/v1/me/biometric/verify": {
        const b = r.body as { biometric_token: string };
        if (!u.biometricToken || b.biometric_token !== u.biometricToken) return domainError(401, "BIOMETRIC_INVALID");
        return json(200, { ok: true });
      }
      case "POST /internal/v1/me/consent": {
        const b = r.body as { policy_version: string };
        if (b.policy_version !== u.consent.current_policy_version) return domainError(409, "POLICY_VERSION_OUTDATED");
        u.consent = { ...u.consent, accepted: true, policy_version: b.policy_version, accepted_at: "2026-10-08T10:00:00Z", evidence_hash: "sha256:abc", age_confirmed_18_plus: true };
        return json(200, u.consent);
      }
      case "DELETE /internal/v1/me/consent":
        u.consent = { ...u.consent, accepted: false };
        return json(200, u.consent);
      case "POST /internal/v1/me/disable":
        u.summary = { ...u.summary, status: "DISABLED" };
        u.settings = { ...u.settings, enabled: false };
        return json(200, this.me(u));
      case "POST /internal/v1/me/enable":
        u.summary = { ...u.summary, status: "ACTIVE" };
        return json(200, this.me(u));
      case "POST /internal/v1/me/deletion-request": {
        const b = r.body as { pin?: string; confirm_word?: string };
        if (u.pin ? b.pin !== u.pin : !["УДАЛИТЬ", "DELETE"].includes(b.confirm_word ?? "")) {
          return u.pin ? domainError(401, "PIN_INVALID", { remaining: 4 }) : domainError(422, "CONFIRM_WORD_REQUIRED");
        }
        u.summary = { ...u.summary, status: "DELETION_REQUESTED" };
        return json(202, { request_id: randomUUID(), status: "REQUESTED", domains: ["identity", "preferences", "support", "notifications"] });
      }
    }
    return domainError(404, "NOT_FOUND");
  }

  private preferencesRoute(r: Req): Response {
    if (r.method === "GET" && r.path === "/internal/v1/directory/airports") {
      return json(200, { items: [{ iata: "TAS", city: "Tashkent", country: "Uzbekistan", country_code: "UZ", name: "Islam Karimov Tashkent International" }].filter((a) => !r.query.q || a.city.toLowerCase().includes(r.query.q.toLowerCase())) });
    }
    if (r.method === "GET" && r.path === "/internal/v1/directory/interests") {
      return json(200, { items: [{ code: "sport.motorsport", parent: "sport", label: { ru: "Автоспорт", en: "Motorsport" }, icon: "flag" }] });
    }
    if (r.method === "GET" && r.path === "/internal/v1/directory/geographies") {
      return json(200, { items: [{ level: "world", code: null, label: { ru: "Весь мир", en: "World" } }] });
    }
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    let p = this.prefs.get(r.subject);
    if (!p) {
      p = defaultPrefs();
      this.prefs.set(r.subject, p);
    }
    const key = `${r.method} ${r.path}`;
    switch (key) {
      case "GET /internal/v1/me/preferences":
        return json(200, p);
      case "PATCH /internal/v1/me/preferences": {
        const { version, ...patch } = r.body as Partial<Preferences>;
        if (version !== undefined && version !== p.version) return domainError(409, "PREFERENCES_VERSION_CONFLICT", { current_version: p.version });
        p = { ...p, ...patch, version: p.version + 1 };
        this.prefs.set(r.subject, p);
        return json(200, p);
      }
      case "PUT /internal/v1/me/departures": {
        const airports = (r.body as { airports: string[] }).airports;
        const unknown = airports.find((a) => a !== "TAS" && a !== "SKD");
        if (unknown) return domainError(422, "AIRPORT_UNKNOWN", { iata: unknown });
        p = { ...p, departures: airports.map((a) => ({ airport_iata: a, city: a === "TAS" ? "Tashkent" : "Samarkand", country_code: "UZ" })) };
        this.prefs.set(r.subject, p);
        return json(200, p);
      }
      case "POST /internal/v1/me/onboarding/complete":
        p = { ...p, onboarding_completed_at: "2026-10-08T10:05:00Z" };
        this.prefs.set(r.subject, p);
        return json(200, p);
    }
    return domainError(404, "NOT_FOUND");
  }

  private support(r: Req): Response {
    if (r.method === "GET" && r.path === "/internal/v1/support/categories") {
      return json(200, { items: [{ code: "BUG", label: { ru: "Ошибка", en: "Bug" }, available: true }] });
    }
    if (!r.subject) return domainError(401, "SUBJECT_REQUIRED");
    const owner = r.subject;
    if (r.method === "POST" && r.path === "/internal/v1/me/tickets") {
      const idem = r.headers["idempotency-key"];
      if (!idem) return domainError(422, "IDEMPOTENCY_KEY_REQUIRED");
      const prev = this.ticketIdem.get(`${owner}:${idem}`);
      if (prev) return json(200, this.publicTicket(this.tickets.get(prev)!));
      const b = r.body as { category: Ticket["category"]; subject: string; message: string; context?: Ticket["context"] };
      const id = randomUUID();
      const now = "2026-10-08T10:00:00Z";
      const t: Ticket & { owner: string } = {
        owner,
        ticket_id: id,
        number: `TCK-${this.ticketSeq++}`,
        category: b.category,
        subject: b.subject,
        status: "NEW",
        created_at: now,
        updated_at: now,
        last_message_at: now,
        unread_operator_replies: 0,
        context: b.context ?? null,
        sla_first_response_at: "2026-10-08T12:00:00Z",
        messages: [{ message_id: randomUUID(), sender_type: "user", author_name: null, text: b.message, created_at: now }],
        status_history: [{ status: "NEW", at: now }],
      };
      this.tickets.set(id, t);
      this.ticketIdem.set(`${owner}:${idem}`, id);
      return json(201, this.publicTicket(t));
    }
    if (r.method === "GET" && r.path === "/internal/v1/me/tickets") {
      const items = [...this.tickets.values()].filter((t) => t.owner === owner).map((t) => {
        const { context: _c, messages: _m, status_history: _s, sla_first_response_at: _f, owner: _o, ...summary } = t;
        return summary;
      });
      return json(200, { items: items.slice(0, Number(r.query.limit ?? 20)), next_cursor: null });
    }
    const m = /^\/internal\/v1\/me\/tickets\/([^/]+)(?:\/(messages|close))?$/.exec(r.path);
    if (m) {
      const ref = m[1]!;
      const t = /^TCK-\d+$/.test(ref) ? [...this.tickets.values()].find((x) => x.number === ref) : this.tickets.get(ref);
      if (!t || t.owner !== owner) return domainError(404, "SUPPORT_TICKET_NOT_FOUND");
      if (!m[2] && r.method === "GET") return json(200, this.publicTicket(t));
      if (m[2] === "messages" && r.method === "POST") {
        if (t.status === "CLOSED") return domainError(409, "SUPPORT_TICKET_CLOSED");
        t.messages.push({ message_id: randomUUID(), sender_type: "user", author_name: null, text: (r.body as { text: string }).text, created_at: "2026-10-08T10:01:00Z" });
        return json(200, this.publicTicket(t));
      }
      if (m[2] === "close" && r.method === "POST") {
        t.status = "CLOSED";
        t.status_history.push({ status: "CLOSED", at: "2026-10-08T10:02:00Z" });
        return json(200, this.publicTicket(t));
      }
    }
    return domainError(404, "NOT_FOUND");
  }

  /** Фильтр каталога; skip — измерение, которое не применяется (счётчики facets). */
  private matches(e: CatalogEvent, q: Record<string, string>, skip: "date" | "has_tickets" | "online" | "category" | "country" | null = null): boolean {
    if (e.hidden) return false;
    const st = e.lifecycle.status;
    const life = q.lifecycle ? q.lifecycle.split(",") : null;
    if (life ? !life.includes(st) : ["COMPLETED", "CANCELLED"].includes(st)) return false;
    if (q.q && !`${e.title} ${e.venue?.name ?? ""} ${e.venue?.city ?? ""}`.toLowerCase().includes(q.q.toLowerCase())) return false;
    if (skip !== "category" && q.category) {
      if (q.category === "other" ? e.categories.length > 0 : !e.categories.some((c) => c === q.category || c.startsWith(`${q.category}.`))) return false;
    }
    if (skip !== "country" && q.country && !q.country.split(",").includes(e.venue?.country_code ?? "")) return false;
    if (q.city && e.venue?.city !== q.city) return false;
    if (skip !== "date" && q.date_from && e.start.local_date < q.date_from) return false;
    if (skip !== "date" && q.date_to && e.start.local_date > q.date_to) return false;
    if (skip !== "has_tickets" && q.has_tickets === "true" && !["ON_SALE", "LOW_INVENTORY", "RESALE"].includes(st)) return false;
    if (skip !== "online" && q.online && String(e.online) !== q.online) return false;
    return true;
  }

  /** Поиск event-catalog: q, category (с потомками, other — без категории), country (список через запятую), city,
   *  даты, lifecycle, has_tickets, online, sort, cursor; :facets — счётчики (каждый без своего измерения). */
  private events(r: Req): Response {
    if (r.method !== "GET") return domainError(404, "NOT_FOUND");
    const q = r.query;
    if (r.path === "/internal/v1/events:facets") {
      const month = new Date().toISOString().slice(0, 7);
      const count = (skip: Parameters<FakeDomains["matches"]>[2], extra: (e: CatalogEvent) => boolean = () => true) =>
        this.catalog.filter((e) => this.matches(e, q, skip) && extra(e)).length;
      const categories: Record<string, number> = {};
      const countries: Record<string, number> = {};
      for (const e of this.catalog) {
        if (this.matches(e, q, "category")) {
          const roots = e.categories.length ? [...new Set(e.categories.map((c) => c.split(".")[0]!))] : ["other"];
          for (const c of roots) categories[c] = (categories[c] ?? 0) + 1;
        }
        if (this.matches(e, q, "country") && e.venue) countries[e.venue.country_code] = (countries[e.venue.country_code] ?? 0) + 1;
      }
      return json(200, {
        total: count(null),
        // окно чипа от вызывающего (month_from/month_to) или текущий месяц по UTC
        this_month: count("date", (e) =>
          q.month_from && q.month_to ? e.start.local_date >= q.month_from && e.start.local_date <= q.month_to : e.start.local_date.startsWith(month),
        ),
        has_tickets: count("has_tickets", (e) => ["ON_SALE", "LOW_INVENTORY", "RESALE"].includes(e.lifecycle.status)),
        online: count("online", (e) => e.online),
        categories,
        countries,
      });
    }
    const m = /^\/internal\/v1\/events\/([^/]+)$/.exec(r.path);
    if (m) {
      const e = this.catalog.find((x) => x.event_id === m[1] && !x.hidden);
      return e ? json(200, e) : domainError(404, "EVENT_NOT_FOUND");
    }
    if (r.path !== "/internal/v1/events") return domainError(404, "NOT_FOUND");
    let items = this.catalog.filter((e) => this.matches(e, q));
    const sort = q.sort ?? "soonest";
    items = items.sort((a, b) =>
      sort === "quality" ? b.quality_score - a.quality_score : sort === "newest" ? (a.first_seen_at < b.first_seen_at ? 1 : -1) : a.start.local_date < b.start.local_date ? -1 : 1,
    );
    const offset = q.cursor ? Number(Buffer.from(q.cursor, "base64url").toString()) : 0;
    const limit = Number(q.limit ?? 20);
    const page = items.slice(offset, offset + limit);
    const next = offset + limit < items.length ? Buffer.from(String(offset + limit)).toString("base64url") : null;
    return json(200, { items: page.map(toSummary), next_cursor: next });
  }

  private publicTicket(t: Ticket & { owner: string }): Ticket {
    const { owner: _o, ...rest } = t;
    return structuredClone(rest);
  }
}

// ---------------------------------------------------------------- offers fixtures

const MAP = (lat: string, lon: string) => ({
  yandex: `https://yandex.ru/maps/?pt=${lon},${lat}&z=16&l=map`,
  google: `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`,
  osm: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`,
  dgis: `https://2gis.ru/geo/${lon},${lat}`,
});

/** OfferSetView по контракту (§2.1): полный trip, три тарифа, отели и места рядом. */
export function offerSetFixture(eventId: string, o: { travellers?: number; departure?: string | null } = {}): OfferSetView {
  const travellers = o.travellers ?? 2;
  const fetched = "2026-10-11T07:00:00Z";
  const expires = "2026-10-11T08:00:00Z";
  const tier = (t: OfferTier, flightPP: number, hotelTotal: number): Offer => {
    const flightTotal = flightPP * travellers;
    const total = (85 + flightPP) * travellers + hotelTotal;
    return {
      offer_id: randomUUID(),
      tier: t,
      status: o.departure === null ? "partial" : "complete",
      ticket: { status: "ok", price_per_person: "85.00", currency: "USD", in_total: true, provider: "ticketmaster", deeplink: "https://www.ticketmaster.com/event/abc", fetched_at: fetched, fx: null },
      flight:
        o.departure === null
          ? { status: "unavailable", reason: "NO_DEPARTURE" }
          : {
              status: "ok",
              provider: "aviasales",
              origin: o.departure ?? "TAS",
              destination: "AUH",
              depart_at: "2026-12-03T07:40:00+05:00",
              return_at: "2026-12-07T19:05:00+04:00",
              airline: "HY",
              flight_number: "763",
              transfers: 0,
              return_transfers: 0,
              duration_minutes: 215,
              duration_back_minutes: 200,
              price_per_person: `${flightPP}.00`,
              total: `${flightTotal}.00`,
              deeplink: "https://www.aviasales.com/search/TAS0312AUH07121?t=abc&marker=12345",
              fetched_at: fetched,
              dates_shifted: false,
            },
      hotel: {
        status: "ok",
        provider: "liteapi",
        hotel_id: "lp1beec",
        name: "Yas Hotel",
        stars: 5,
        rating: "9.1",
        review_count: 1840,
        distance_m: 1200,
        lat: "24.4670",
        lon: "54.6040",
        photo_url: "https://static.cupid.travel/hotels/1.jpg",
        nights: 4,
        rooms: Math.ceil(travellers / 2),
        total: `${hotelTotal}.00`,
        refundable: true,
        board: "Breakfast included",
        deeplink: "https://book.tilhero.test/hotels/lp1beec?checkin=2026-12-03&checkout=2026-12-07",
        map: MAP("24.4670", "54.6040"),
        fetched_at: fetched,
      },
      totals: { total: `${total}.00`, per_person: (total / travellers).toFixed(2), currency: "USD", missing: o.departure === null ? ["flight"] : [] },
      expires_at: expires,
      budget_fit: "unknown",
      over_by: null,
      budget_excludes: [],
    };
  };
  return {
    event_id: eventId,
    generated_at: fetched,
    expires_at: expires,
    trip: {
      kind: "trip",
      reason: null,
      destination: {
        city: "Abu Dhabi",
        country_code: "AE",
        iata: "AUH",
        venue: { name: "Yas Marina Circuit", lat: "24.4672", lon: "54.6031", precision: "venue", map: MAP("24.4672", "54.6031") },
      },
      out_date: "2026-12-03",
      back_date: "2026-12-07",
      nights: 4,
    },
    travellers,
    rooms: Math.ceil(travellers / 2),
    departure: o.departure === null ? null : { iata: o.departure ?? "TAS", city: "Ташкент", chosen_by: o.departure ? "user" : "cheapest" },
    tiers: { economy: tier("economy", 142, 390), comfort: tier("comfort", 180, 520), premium: tier("premium", 260, 900) },
    alternative: null,
    hotels_nearby: [
      {
        provider: "liteapi",
        hotel_id: "lp2",
        name: "W Abu Dhabi",
        stars: 5,
        rating: "9.0",
        review_count: 900,
        distance_m: 300,
        lat: "24.4680",
        lon: "54.6030",
        photo_url: null,
        refundable: null,
        board: null,
        deeplink: "https://book.tilhero.test/hotels/lp2?checkin=2026-12-03&checkout=2026-12-07",
        map: MAP("24.4680", "54.6030"),
        fetched_at: fetched,
        price_total: "1200.00",
        per_person_share: (1200 / travellers).toFixed(2),
        budget_fit: "unknown",
        over_by: null,
        budget_excludes: [],
      },
    ],
    poi: [
      {
        provider: "osm",
        osm_type: "node",
        osm_id: 123456,
        name: "Ferrari World",
        kind: "attraction",
        lat: "24.4838",
        lon: "54.6074",
        distance_m: 1800,
        url: "https://www.openstreetmap.org/node/123456",
        website: "https://www.ferrariworldabudhabi.com",
        map: MAP("24.4838", "54.6074"),
      },
    ],
    rating_min: "8.5",
    notes: [],
    budget: null,
    recommended_tier: "comfort",
    hotel_chosen_by: "rules",
    hotel_search: { radius_m: 5000, rating_min: "8.5", base_radius_m: 5000, base_rating_min: "8.5", widened: false, found: 3, min_stars: null, base_min_stars: null, from_prefs: false },
  };
}

// ---------------------------------------------------------------- спринт 6 fixtures

/** Watch сервиса watch (INTERNAL_API §2.1). */
export function watchFixture(watchId: string, eventId: string, title: string, o: Record<string, unknown> = {}): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    watch_id: watchId,
    event_id: eventId,
    event_title: title,
    status: "active",
    ended_reason: null,
    dimensions: { tickets: true, price: true, flight: true, hotel: true, status: true, news: true },
    threshold_pct: 10,
    offer_params: { tier: "comfort", travellers: 1, departure_iata: null, direct_only: false, near_venue: false, extra_nights: 0, hotel_id: null, budget: null, departures: [], flight_prefs: { direct: true, connecting: true, alternative_departure: true } },
    last_snapshot: {
      taken_at: "2026-10-11T06:00:00Z",
      lifecycle_status: "ON_SALE",
      per_person_usd: "844.00",
      total_usd: "844.00",
      flight_usd: "180.00",
      hotel_usd: "520.00",
      ticket_status: "on_sale",
      offer_id: null,
    },
    last_change: null,
    next_check_at: "2026-10-11T12:00:00Z",
    created_at: "2026-10-10T06:00:00Z",
    version: 1,
    ...o,
  };
}

let changeSeq = 0;
/** WatchChange (§2.1). */
export function changeFixture(o: Record<string, unknown> = {}): Record<string, unknown> {
  changeSeq += 1;
  return {
    change_id: randomUUID(),
    type: "price_drop",
    severity: "normal",
    before: "900.00",
    after: "844.00",
    delta_usd: "-56.00",
    delta_pct: "-6.2",
    source: { provider: "offers", url: null, observed_at: "2026-10-11T06:00:00Z" },
    detected_at: `2026-10-11T06:${String(changeSeq % 60).padStart(2, "0")}:00Z`,
    notified: "digest",
    ...o,
  };
}

/** NewsItem (§3.3). */
export function newsFixture(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    news_id: randomUUID(),
    kind: "article",
    title: "Formula 1: Abu Dhabi schedule announced",
    summary: "Расписание этапа опубликовано",
    source: { name: "Formula 1", domain: "formula1.com", url: "https://www.formula1.com/en/latest/article/abu-dhabi.html" },
    published_at: "2026-10-11T05:00:00Z",
    significance: "high",
    interests: ["sport.motorsport"],
    event_ids: [],
    link: { type: "interest", label: "Автоспорт" },
    ...o,
  };
}

// ---------------------------------------------------------------- event-catalog fixtures

/** EventDetail каталога + служебные поля, которых нет в контракте bff.ts (не должны уйти в Mini App). */
export type CatalogEvent = Omit<EventDetailView, "recommendation" | "watch" | "reaction"> & {
  hidden?: boolean;
  dedup_keys: string[];
  external_ids: string[];
  verdict: { status: string; confidence: number };
  internal_note: string;
};

let evSeq = 0;
export function catalogEvent(o: Partial<CatalogEvent> = {}): CatalogEvent {
  evSeq += 1;
  const id = o.event_id ?? `0b7c3a52-1d2e-4f60-8a9b-${String(evSeq).padStart(12, "0")}`;
  return {
    event_id: id,
    title: `Event ${evSeq}`,
    categories: ["sport.motorsport", "sport"],
    start: { local_date: "2026-12-04", local_time: "17:00:00", utc: "2026-12-04T13:00:00Z", timezone: "Asia/Dubai" },
    end: { local_date: "2026-12-06", local_time: null, utc: null, timezone: "Asia/Dubai" },
    venue: {
      name: "Yas Marina Circuit",
      city: "Abu Dhabi",
      country_code: "AE",
      address: "Yas Island",
      lat: "24.4672",
      lon: "54.6031",
      map_url: "https://www.google.com/maps/search/?api=1&query=24.4672,54.6031",
    },
    online: false,
    lifecycle: {
      status: "ON_SALE",
      changed_at: "2026-10-09T08:00:00Z",
      basis: { fact: "provider_status_onsale", source_url: "https://www.ticketmaster.com/event/abc", provider: "ticketmaster", observed_at: "2026-10-09T08:00:00Z" },
    },
    lifecycle_track: [
      { status: "ANNOUNCED", reached: true, current: false },
      { status: "SALES_SOON", reached: true, current: false },
      { status: "ON_SALE", reached: true, current: true },
      { status: "LOW_INVENTORY", reached: false, current: false },
    ],
    quality_score: 80,
    price_range: { min: "120.00", max: "950.00", currency: "USD", fetched_at: "2026-10-10T08:00:00Z", source: { provider: "ticketmaster", url: "https://www.ticketmaster.com/event/abc" } },
    media: {
      url: "https://s1.ticketm.net/dam/a/1d1/f1_RETINA_LANDSCAPE_16_9.jpg",
      width: 2048,
      height: 1152,
      ratio: "16_9",
      provenance: { provider: "ticketmaster", source_url: "https://www.ticketmaster.com/event/abc", fetched_at: "2026-10-10T08:00:00Z", rights: "provider_api" },
    },
    media_all: [],
    official_url: "https://www.ticketmaster.com/event/abc",
    sources: [{ provider: "ticketmaster", name: "Ticketmaster", tier: "OFFICIAL_TICKET_PROVIDER", url: "https://www.ticketmaster.com/event/abc", fetched_at: "2026-10-10T08:00:00Z" }],
    first_seen_at: "2026-10-01T08:00:00Z",
    updated_at: "2026-10-10T08:00:00Z",
    is_past: false,
    dedup_keys: [`src:ticketmaster:${evSeq}`],
    external_ids: [`tm-${evSeq}`],
    verdict: { status: "VERIFIED", confidence: 0.93 },
    internal_note: "reviewer: ok",
    ...o,
  };
}

/** Событие AI-источника (спринт 4): provider `aiweb.<slug>`, имя источника из реестра, медиа с rights `official_site`. */
export const AIWEB_URL = "https://www.iticket.uz/events/concerts/yulduz-usmonova-2026";
export function aiwebEvent(o: Partial<CatalogEvent> = {}): CatalogEvent {
  const fetched = "2026-10-10T06:00:00Z";
  return catalogEvent({
    title: "Yulduz Usmonova. Concert",
    categories: ["music.concerts", "music"],
    start: { local_date: "2026-11-21", local_time: "19:00:00", utc: "2026-11-21T14:00:00Z", timezone: "Asia/Tashkent" },
    end: null,
    venue: {
      name: "Istiqlol Palace",
      city: "Tashkent",
      country_code: "UZ",
      address: null,
      lat: null,
      lon: null,
      map_url: "https://www.google.com/maps/search/?api=1&query=Istiqlol%20Palace%2C%20Tashkent",
    },
    lifecycle: {
      status: "ANNOUNCED",
      changed_at: fetched,
      basis: { fact: "listed_on_official_site", source_url: AIWEB_URL, provider: "aiweb.iticket-uz", observed_at: fetched },
    },
    lifecycle_track: [
      { status: "ANNOUNCED", reached: true, current: true },
      { status: "SALES_SOON", reached: false, current: false },
      { status: "ON_SALE", reached: false, current: false },
    ],
    quality_score: 64,
    price_range: { min: "250000.00", max: "900000.00", currency: "UZS", fetched_at: fetched, source: { provider: "aiweb.iticket-uz", url: AIWEB_URL } },
    media: {
      url: "https://cdn.iticket.az/event/poster/yulduz-usmonova.jpg",
      width: null,
      height: null,
      ratio: null,
      provenance: { provider: "aiweb.iticket-uz", source_url: AIWEB_URL, fetched_at: fetched, rights: "official_site" },
    },
    official_url: AIWEB_URL,
    sources: [{ provider: "aiweb.iticket-uz", name: "iTicket.uz", tier: "OFFICIAL_TICKET_PROVIDER", url: AIWEB_URL, fetched_at: fetched }],
    ...o,
  });
}

/** EventSummary — как отдаёт список каталога (+ служебные поля, BFF их отбрасывает). */
export function toSummary(e: CatalogEvent): Record<string, unknown> {
  const { official_url: _o, sources: _s, lifecycle_track: _t, media_all: _m, first_seen_at: _f, venue, lifecycle, ...rest } = e;
  return {
    ...rest,
    venue: venue ? { name: venue.name, city: venue.city, country_code: venue.country_code } : null,
    lifecycle: { status: lifecycle.status, changed_at: lifecycle.changed_at },
  };
}

const DOMAIN_AUD: Record<Service, string> = {
  identity: "identity-consent",
  preferences: "preferences",
  support: "support",
  experience: "experience-config",
  events: "events",
  offers: "offers",
  recommendations: "recommendations",
  watch: "watch",
  news: "news",
  aiConcierge: "ai-concierge",
};

// ---------------------------------------------------------------- app harness

let sharedRedis: Redis | null = null;
export function testRedis(): Redis {
  sharedRedis ??= new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
  return sharedRedis;
}

export async function closeRedis(): Promise<void> {
  if (sharedRedis) {
    await sharedRedis.quit();
    sharedRedis = null;
  }
}

export interface Harness {
  app: App;
  fake: FakeDomains;
  logs: LogCapture;
  config: Config;
  close(): Promise<void>;
}

export async function makeHarness(env: Record<string, string> = {}): Promise<Harness> {
  const config = testConfig(env);
  const fake = new FakeDomains();
  const logs = new LogCapture();
  const redis = testRedis();
  const app = await buildApp(config, { redis, fetchImpl: fake.fetch, logStream: logs });
  await app.ready();
  return {
    app,
    fake,
    logs,
    config,
    async close() {
      await app.close();
      // чистим ключи этого приложения
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, "MATCH", `${config.redisKeyPrefix}*`, "COUNT", 500);
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== "0");
    },
  };
}

export interface TgUser {
  id: number;
  first_name: string;
  username?: string;
  language_code?: string;
  last_name?: string;
}

export const TG_USER: TgUser = { id: 900001, first_name: "Игорь", username: "test_user_1", language_code: "ru" };

export function initDataFor(user: TgUser | null = TG_USER, opts: { authDate?: number; token?: string } = {}): string {
  return signInitData(opts.token ?? BOT_TOKEN, {
    user,
    // каждый запуск Mini App — свой initData (query_id): initData одноразовый (О-1, спринт 9)
    queryId: `AAH${randomBytes(12).toString("hex")}`,
    ...(opts.authDate !== undefined ? { authDate: opts.authDate } : {}),
  });
}

export interface LoggedIn {
  access: string;
  refresh: string;
  userId: string;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function login(h: Harness, user: TgUser = TG_USER, ip = "203.0.113.10"): Promise<LoggedIn> {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/session/telegram",
    payload: { init_data: initDataFor(user) },
    remoteAddress: ip,
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { access: body.access_token, refresh: body.refresh_token, userId: body.user.user_id, body };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
