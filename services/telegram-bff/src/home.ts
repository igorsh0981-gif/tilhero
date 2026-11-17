/**
 * GET /v1/home: секции из активного Remote Experience Config + данные доменов.
 *
 *  - best_for_you — кандидаты из каталога по интересам (категории) и странам пользователя (quality, затем ближайшие;
 *    по интересам пусто — общий список по quality), до 100 → recommendations:rank (limit 10, diversity); карточки +=
 *    recommendation {score, reasons}. Ранжирование недоступно/не настроено/ответ битый → прежний порядок (до 10),
 *    recommendation null.
 *  - sales_soon — lifecycle SALES_SOON, ближайшие, до 10.
 *  - карточки обеих рельс += watch {watch_id, status} | null (watches:by-events; сбой — null).
 *  - watch_changes (key watch) — последние изменения активных слежений (до 10), news_carousel (key news) —
 *    news:feed limit 10 по профилю и настройкам новостей. Домен не настроен — секция pending_data.
 *  - summary (AT-23) — «Пока вас не было», см. visit()/summary().
 *
 * Кэш в Redis на пользователя (AT-34 «Home работает без n8n и каталога»):
 *  - свежая копия HOME_CACHE_SECONDS (60 с) — домены не вызываются;
 *  - stale-копия живёт HOME_STALE_SECONDS (24 ч): если домен секции недоступен, секция отдаётся из неё со state "stale";
 *  - нет и stale-копии — state "unavailable", items []. HTTP всегда 200.
 * Ошибка чтения/записи кэша Home в Redis не ломает ответ — кэш пропускается (предупреждение в лог).
 * Деградация (preferences недоступен, ранжирование или by-events не удались) не кэшируется как свежая и не затирает
 * stale-копию. Сброс (invalidate): изменение предпочтений, слежений (создание/изменение/удаление) и реакций.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type { EventCard, ExperienceConfig, HomeResponse, HomeSection, NewsItem, NewsTopic, Preferences } from "@tilhero/contracts/bff";
import type { Config } from "./config.js";
import { detailToCard, toCard, type CatalogQuery, type EventsCatalog } from "./events.js";
import {
  DEFAULT_NEWS_PREFS,
  geographiesOf,
  interestsOf,
  loadPrefs,
  loadUser,
  mapLimit,
  newsItemOf,
  type InternalWatch,
  type LastTripStore,
  type NewsService,
  type NewsQueryBody,
  type RecommendationsService,
  type UserMeta,
  type WatchService,
  type WatchSummary,
} from "./personal.js";
import {
  CATEGORY_CODE,
  HomeWatchChangeSchema,
  RecommendationSchema,
  WatchRefSchema,
  type HomeEventCard,
  type HomeWatchChange,
} from "./schemas.js";
import type { ExperienceCache } from "./experience.js";
import type { DomainClient } from "./upstream.js";
import { validator } from "./personal.js";

export const HOME_RAIL_LIMIT = 10;
export const HOME_CHANGES_LIMIT = 10;
export const HOME_NEWS_LIMIT = 10;
/** Кандидатов ранжирования не больше (INTERNAL_API §1.1). */
export const MAX_CANDIDATES = 100;
/** Коды, которые принимает event-catalog (иначе 422 у каталога сделал бы рельс «unavailable»). */
const CATEGORY_RE = new RegExp(CATEGORY_CODE);
/** Сколько категорий интересов опрашиваем параллельно (fan-out к каталогу ограничен). */
export const MAX_INTEREST_QUERIES = 5;
const FETCH_PER_QUERY = 30;
/** new_events: событий на запрос профиля (sort=newest) не больше. */
export const NEW_EVENTS_PER_QUERY = 50;

/** Вшитая раскладка Home (как сид experience-config 2.0.3), если конфиг ни разу не был получен. */
export const DEFAULT_HOME_SECTIONS: ExperienceConfig["home"]["sections"] = [
  { type: "event_carousel", key: "best_for_you", variant: "large", enabled: true },
  { type: "watch_changes", key: "watch", variant: "compact", enabled: true },
  { type: "event_carousel", key: "sales_soon", variant: "compact", enabled: true },
  { type: "news_carousel", key: "news", variant: "compact", enabled: true },
];

type RailKey = "best_for_you" | "sales_soon";
type Piece = RailKey | "watch" | "news";

/** KEYS[1] — поколение, KEYS[2] — копия Home; ARGV: ожидаемое поколение, JSON, TTL. */
const WRITE_IF_SAME_GEN = `
if (redis.call('GET', KEYS[1]) or '0') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1`;

/**
 * Визит (AT-23): KEYS[1] — hash {seen, since, started}, KEYS[2] — сводка визита; ARGV: now (мс), порог (мс), TTL (с),
 * TTL маркера «считается» (с). first — прошлого визита нет; new — прошлый был ≥ порога назад (since = он, started = now,
 * сдвиг атомарен — второй параллельный запрос увидит same) и ставится маркер {started, pending}; same — иначе.
 */
const VISIT = `
local seen = redis.call('HGET', KEYS[1], 'seen')
local now = tonumber(ARGV[1])
local kind = 'same'
if not seen then
  kind = 'first'
elseif now - tonumber(seen) >= tonumber(ARGV[2]) then
  redis.call('HSET', KEYS[1], 'since', seen, 'started', ARGV[1])
  redis.call('SET', KEYS[2], '{"started":' .. ARGV[1] .. ',"pending":true}', 'EX', tonumber(ARGV[4]))
  kind = 'new'
end
redis.call('HSET', KEYS[1], 'seen', ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return {kind, redis.call('HGET', KEYS[1], 'since') or '', redis.call('HGET', KEYS[1], 'started') or ''}`;

const RAILS: ReadonlySet<string> = new Set<RailKey>(["best_for_you", "sales_soon"]);

/** Окно гонки визита: запрос того же визита в пределах окна, пока стоит маркер «считается», ждёт сводку первого
 *  (StrictMode, двойной запуск Mini App) не дольше SUMMARY_WAIT_MS с шагом SUMMARY_POLL_MS; маркера нет (первый не смог
 *  сохранить сводку) или время вышло — считает сам. */
export const SUMMARY_RACE_WINDOW_MS = 15_000;
export const SUMMARY_WAIT_MS = 1_500;
const SUMMARY_POLL_MS = 50;
/** Маркер «считается» живёт не дольше (с): упавший запрос не держит остальных. */
const SUMMARY_PENDING_TTL_S = 10;

interface CacheDoc {
  v: 2;
  /** когда данные получены из доменов, мс epoch */
  at: number;
  rails: Partial<Record<RailKey, HomeEventCard[]>>;
  watch?: HomeWatchChange[];
  news?: NewsItem[];
}

export type HomeSummary = NonNullable<HomeResponse["summary"]>;

export interface HomeDeps {
  config: Config;
  redis: Redis;
  catalog: EventsCatalog;
  preferences: DomainClient;
  identity: DomainClient;
  experience: ExperienceCache;
  recommendations: RecommendationsService;
  watch: WatchService;
  news: NewsService;
  lastTrip: LastTripStore;
  log: FastifyBaseLogger;
}

/** Порядок «значимые, затем ближайшие»: quality ↓, дата начала ↑, id — для стабильности. */
export function byQualityThenSoonest(a: EventCard, b: EventCard): number {
  if (b.quality_score !== a.quality_score) return b.quality_score - a.quality_score;
  const da = a.start.utc ?? a.start.local_date;
  const db = b.start.utc ?? b.start.local_date;
  if (da !== db) return da < db ? -1 : 1;
  return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
}

/** Интересы и страны пользователя → сигналы для best_for_you и new_events. */
export function personalSignals(prefs: Preferences | null): { categories: string[]; countries: string[] } {
  if (!prefs) return { categories: [], countries: [] };
  const categories = [...new Set(prefs.interests.categories.filter((c) => CATEGORY_RE.test(c)))];
  const countries = [
    ...new Set(
      prefs.geographies
        .filter((g) => g.level === "country" && typeof g.code === "string" && /^[A-Za-z]{2}$/.test(g.code))
        .map((g) => g.code!.toUpperCase()),
    ),
  ];
  return { categories, countries };
}

/** Запросы каталога по профилю (категории ≤ 5 с одной страной, иначе страны ≤ 5; без сигналов — []). */
function profileQueries(prefs: Preferences | null): { queries: CatalogQuery[]; categories: string[]; countries: string[] } {
  const { categories, countries } = personalSignals(prefs);
  const single = countries.length === 1 ? countries[0] : undefined;
  let queries: CatalogQuery[] = [];
  if (categories.length) queries = categories.slice(0, MAX_INTEREST_QUERIES).map((category) => ({ category, country: single }));
  else if (countries.length) queries = countries.slice(0, MAX_INTEREST_QUERIES).map((country) => ({ country }));
  return { queries, categories, countries };
}

/** Несколько стран: фильтр по стране площадки (online-события от географии не зависят). */
const inCountries = (e: EventCard, categories: string[], countries: string[]): boolean =>
  !(categories.length && countries.length > 1 && !e.online && !(e.venue && countries.includes(e.venue.country_code.toUpperCase())));

const checkRec = validator(RecommendationSchema);
const checkRef = validator(WatchRefSchema);
const checkChange = validator(HomeWatchChangeSchema);

/** Карточка из Redis: поля EventCard через маппинг контракта, recommendation/watch — по схеме (битое → null). */
function cachedCard(x: unknown, log: FastifyBaseLogger): HomeEventCard | null {
  const card = toCard(x, log);
  if (!card) return null;
  const o = x as { recommendation?: unknown; watch?: unknown };
  const out: HomeEventCard = { ...card };
  if ("recommendation" in o) out.recommendation = o.recommendation !== null && checkRec(o.recommendation) ? (o.recommendation as HomeEventCard["recommendation"]) : null;
  if ("watch" in o) out.watch = o.watch !== null && checkRef(o.watch) ? (o.watch as HomeEventCard["watch"]) : null;
  return out;
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

export class HomeService {
  constructor(private readonly d: HomeDeps) {}

  private key(userId: string): string {
    return `${this.d.config.redisKeyPrefix}home:${userId}`;
  }

  /** Поколение данных пользователя: INCR при каждом сбросе; сборка пишет кэш, только если оно не менялось. */
  private genKey(userId: string): string {
    return `${this.d.config.redisKeyPrefix}home:gen:${userId}`;
  }

  private visitKey(userId: string): string {
    return `${this.d.config.redisKeyPrefix}visit:${userId}`;
  }

  private summaryKey(userId: string): string {
    return `${this.d.config.redisKeyPrefix}home:summary:${userId}`;
  }

  /** Текущее поколение ("0", если сбросов не было); null — Redis недоступен (тогда кэш не пишем). */
  private async generation(userId: string): Promise<string | null> {
    try {
      return (await this.d.redis.get(this.genKey(userId))) ?? "0";
    } catch (err) {
      this.d.log.warn({ err_name: (err as Error)?.name }, "home cache generation read failed");
      return null;
    }
  }

  private async readCache(userId: string): Promise<CacheDoc | null> {
    try {
      const raw = await this.d.redis.get(this.key(userId));
      if (!raw) return null;
      const doc = JSON.parse(raw) as Omit<Partial<CacheDoc>, "v"> & { v?: number };
      // v1 (до спринта 6) — только рельсы без recommendation/watch: годится как stale-копия
      if (!doc || (doc.v !== 1 && doc.v !== 2) || typeof doc.at !== "number" || typeof doc.rails !== "object" || doc.rails === null) return null;
      // копия из Redis — тоже через маппинг контракта (только поля схем, известные статусы)
      const rails: CacheDoc["rails"] = {};
      for (const k of ["best_for_you", "sales_soon"] as const) {
        const items = doc.rails[k];
        if (Array.isArray(items)) rails[k] = items.map((x) => cachedCard(x, this.d.log)).filter((e): e is HomeEventCard => e !== null);
      }
      const out: CacheDoc = { v: 2, at: doc.at, rails };
      if (Array.isArray(doc.watch)) out.watch = doc.watch.filter((x) => checkChange(x)) as HomeWatchChange[];
      if (Array.isArray(doc.news)) out.news = doc.news.map(newsItemOf).filter((n): n is NewsItem => n !== null);
      return out;
    } catch (err) {
      this.d.log.warn({ err_name: (err as Error)?.name }, "home cache read failed");
      return null;
    }
  }

  /** Предпочтения, слежения или реакции изменились — персональная подборка (свежая и stale) больше не верна. */
  async invalidate(userId: string): Promise<void> {
    try {
      // новое поколение + сброс копии одной транзакцией: сборка, начатая до сброса, свою подборку уже не запишет
      await this.d.redis
        .multi()
        .incr(this.genKey(userId))
        .expire(this.genKey(userId), this.d.config.homeStaleSeconds)
        .del(this.key(userId))
        .exec();
    } catch (err) {
      this.d.log.warn({ err_name: (err as Error)?.name }, "home cache invalidate failed");
    }
  }

  /** Запись копии, только если поколение не изменилось с начала сборки (атомарно, Lua). */
  private async writeCache(userId: string, doc: CacheDoc, gen: string | null): Promise<boolean> {
    if (gen === null) return false;
    try {
      const ok = await this.d.redis.eval(WRITE_IF_SAME_GEN, 2, this.genKey(userId), this.key(userId), gen, JSON.stringify(doc), String(this.d.config.homeStaleSeconds));
      return ok === 1;
    } catch (err) {
      this.d.log.warn({ err_name: (err as Error)?.name }, "home cache write failed");
      return false;
    }
  }

  private async sections(): Promise<ExperienceConfig["home"]["sections"]> {
    try {
      return (await this.d.experience.get()).home.sections;
    } catch {
      // experience-config недоступен и последней версии нет — вшитая раскладка (Home отвечает 200 всегда)
      this.d.log.warn({ upstream: "experience-config" }, "experience-config unavailable, using bundled home layout");
      return DEFAULT_HOME_SECTIONS;
    }
  }

  /** Кандидаты best_for_you «как раньше»: по интересам/странам, иначе общий список по quality (до 100, quality ↓). */
  async candidates(prefs: Preferences | null): Promise<EventCard[]> {
    const { catalog } = this.d;
    const { queries, categories, countries } = profileQueries(prefs);
    const settled = await Promise.allSettled(queries.map((q) => catalog.search({ ...q, sort: "quality", limit: FETCH_PER_QUERY })));
    const pages = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (queries.length && !pages.length) throw (settled[0] as PromiseRejectedResult).reason;
    const seen = new Set<string>();
    const merged: EventCard[] = [];
    for (const page of pages) {
      for (const e of page.items) {
        if (seen.has(e.event_id) || !inCountries(e, categories, countries)) continue;
        seen.add(e.event_id);
        merged.push(e);
      }
    }
    if (merged.length) return merged.sort(byQualityThenSoonest).slice(0, MAX_CANDIDATES);
    // по интересам пусто — общий список по значимости
    return (await catalog.search({ sort: "quality", limit: 50 })).items.sort(byQualityThenSoonest);
  }

  /**
   * personal=false — предпочтения недоступны (общая подборка); ranked=false — ранжирование не удалось/не настроено
   * (прежний порядок, recommendation null). Обе ситуации — деградация (в кэш не пишется).
   */
  async bestForYou(
    userId: string,
    prefs?: Preferences | null,
    lang?: () => Promise<"ru" | "en">,
  ): Promise<{ items: HomeEventCard[]; personal: boolean; ranked: boolean }> {
    const p = prefs === undefined ? await loadPrefs(this.d.preferences, userId) : prefs;
    const cands = await this.candidates(p);
    const fallback = (): HomeEventCard[] => cands.slice(0, HOME_RAIL_LIMIT).map((c) => ({ ...c, recommendation: null }));
    const rec = this.d.recommendations;
    if (!p || !rec.configured || !cands.length) return { items: fallback(), personal: p !== null, ranked: !rec.configured || !cands.length };
    try {
      const [l, trips] = await Promise.all([lang ? lang() : loadUser(this.d.identity, userId).then((u) => u.lang), this.d.lastTrip.perPerson(userId, cands.map((c) => c.event_id))]);
      const ranked = await rec.rank(userId, p, cands, { limit: HOME_RAIL_LIMIT, diversity: true, withFactors: false, lang: l, tripPerPerson: trips });
      const byId = new Map(cands.map((c) => [c.event_id.toLowerCase(), c]));
      const items = ranked.slice(0, HOME_RAIL_LIMIT).map((r) => ({ ...byId.get(r.event_id)!, recommendation: r.recommendation }));
      return { items, personal: true, ranked: true };
    } catch (err) {
      rec.logFailure(err, "home");
      return { items: fallback(), personal: true, ranked: false };
    }
  }

  async salesSoon(): Promise<EventCard[]> {
    return (await this.d.catalog.search({ lifecycle: ["SALES_SOON"], sort: "soonest", limit: HOME_RAIL_LIMIT })).items;
  }

  /** Табло «Что изменилось»: последние изменения активных слежений, новые сверху. */
  static changesOf(watches: readonly InternalWatch[]): HomeWatchChange[] {
    return watches
      .filter((w) => w.last_change !== null)
      .map((w) => ({ watch_id: w.watch_id, event_id: w.event_id, event_title: w.event_title, status: w.status, change: w.last_change! }))
      .sort((a, b) => ms(b.change.detected_at) - ms(a.change.detected_at) || (a.watch_id < b.watch_id ? -1 : 1))
      .slice(0, HOME_CHANGES_LIMIT);
  }

  async build(userId: string): Promise<HomeResponse> {
    const { watch, news } = this.d;
    const layout = (await this.sections()).filter((s) => s.enabled);
    const rails = [...new Set(layout.filter((s) => s.type === "event_carousel" && RAILS.has(s.key)).map((s) => s.key as RailKey))];
    const wantWatch = watch.configured && layout.some((s) => s.type === "watch_changes");
    const wantNews = news.configured && layout.some((s) => s.type === "news_carousel");
    const wanted: Piece[] = [...rails, ...(wantWatch ? (["watch"] as const) : []), ...(wantNews ? (["news"] as const) : [])];
    // поколение — ДО чтения предпочтений и доменов (см. writeCache)
    const gen = wanted.length ? await this.generation(userId) : null;
    const cached = wanted.length ? await this.readCache(userId) : null;
    const now = Date.now();
    const freshMs = this.d.config.homeFreshSeconds * 1000;

    // общие данные сборки — по требованию, один раз
    let prefsP: Promise<Preferences | null> | null = null;
    const prefs = () => (prefsP ??= loadPrefs(this.d.preferences, userId));
    let userP: Promise<UserMeta> | null = null;
    const user = () => (userP ??= loadUser(this.d.identity, userId));
    const lang = () => user().then((u) => u.lang);
    let watchesP: Promise<InternalWatch[]> | null = null;
    const watches = () => (watchesP ??= watch.list(userId, { status: "active", limit: 20 }).then((p) => p.items));

    const summaryP = this.summary(userId, now, prefs, watches);

    const isFresh = (c: CacheDoc): boolean =>
      freshMs > 0 &&
      now - c.at < freshMs &&
      wanted.every((k) => (k === "watch" ? Array.isArray(c.watch) : k === "news" ? Array.isArray(c.news) : Array.isArray(c.rails[k])));

    let data: CacheDoc = { v: 2, at: now, rails: {} };
    const failed = new Set<Piece>();
    if (cached && isFresh(cached)) {
      data = cached;
    } else if (wanted.length) {
      let degraded = false;
      const loaders: Record<Piece, () => Promise<void>> = {
        best_for_you: async () => {
          const r = await this.bestForYou(userId, await prefs(), lang);
          degraded ||= !r.personal || !r.ranked;
          data.rails.best_for_you = r.items;
        },
        sales_soon: async () => {
          data.rails.sales_soon = await this.salesSoon();
        },
        watch: async () => {
          data.watch = HomeService.changesOf(await watches());
        },
        news: async () => {
          data.news = (await this.newsFeed(userId, prefs, user, watches)).items;
        },
      };
      const results = await Promise.allSettled(wanted.map((k) => loaders[k]()));
      results.forEach((r, i) => {
        const k = wanted[i]!;
        if (r.status === "rejected") {
          failed.add(k);
          const upstream = k === "watch" ? "watch" : k === "news" ? "news" : "events";
          this.d.log.warn({ upstream, section: k, err_code: (r.reason as { code?: string })?.code }, "home section unavailable");
        }
      });
      // кнопка Watch на карточках рельс: одним запросом by-events
      degraded = !(await this.decorateWatch(userId, data.rails)) || degraded;
      if (degraded) {
        // общая/неранжированная подборка: не кэшируем и не затираем ею stale-копию
      } else if (failed.size === 0) await this.writeCache(userId, data, gen);
      else if (failed.size < wanted.length && cached) {
        // частичный успех: обновляем stale-копию свежими секциями, «свежесть» не продлеваем
        const merged: CacheDoc = { ...cached, rails: { ...cached.rails, ...data.rails }, at: cached.at };
        if (data.watch) merged.watch = data.watch;
        if (data.news) merged.news = data.news;
        await this.writeCache(userId, merged, gen);
      }
    }

    const sections: HomeSection[] = layout.map((s) => {
      const base = { type: s.type, key: s.key, variant: s.variant };
      const piece: Piece | null =
        s.type === "event_carousel" && RAILS.has(s.key) ? (s.key as RailKey) : s.type === "watch_changes" ? "watch" : s.type === "news_carousel" ? "news" : null;
      if (piece === null) return { ...base, state: s.type === "catalog_link" ? "ready" : "pending_data", items: [] };
      if (!wanted.includes(piece)) return { ...base, state: "pending_data", items: [] }; // домен не настроен
      const pick = (c: CacheDoc | null) => (c === null ? undefined : piece === "watch" ? c.watch : piece === "news" ? c.news : c.rails[piece]);
      if (!failed.has(piece)) return { ...base, state: "ready", items: pick(data) ?? [] };
      const stale = pick(cached);
      return stale ? { ...base, state: "stale", items: stale } : { ...base, state: "unavailable", items: [] };
    });
    return { summary: await summaryP, sections, generated_at: new Date(data.at).toISOString() };
  }

  /** watch {watch_id, status} | null на карточках рельс. false — by-events не удался (карточки с watch null). */
  private async decorateWatch(userId: string, rails: CacheDoc["rails"]): Promise<boolean> {
    const cards = [...(rails.best_for_you ?? []), ...(rails.sales_soon ?? [])];
    if (!this.d.watch.configured || !cards.length) return true;
    let refs = new Map<string, { watch_id: string; status: "active" | "paused" | "ended" }>();
    let ok = true;
    try {
      refs = await this.d.watch.byEvents(userId, cards.map((c) => c.event_id));
    } catch (err) {
      ok = false;
      this.d.log.warn({ upstream: "watch", where: "by-events", err_code: (err as { code?: string })?.code ?? (err as Error)?.name }, "watch by-events unavailable");
    }
    for (const c of cards) c.watch = refs.get(c.event_id.toLowerCase()) ?? null;
    return ok;
  }

  /** Лента новостей пользователя: интересы и сущности профиля, события на слежении, настройки новостей. */
  async newsFeed(
    userId: string,
    prefs: () => Promise<Preferences | null>,
    user: () => Promise<UserMeta>,
    watches: () => Promise<InternalWatch[]>,
    q: { filter?: "all" | "watch" | "interests"; topic?: NewsTopic; cursor?: string; limit?: number } = {},
  ) {
    const base = await this.newsQuery(userId, prefs, user, watches, q.filter ?? "all");
    return this.d.news.feed(userId, {
      ...base,
      cursor: q.cursor ?? null,
      limit: q.limit ?? HOME_NEWS_LIMIT,
      ...(q.topic ? { topic: q.topic } : {}),
    });
  }

  /** Темы новостей (6.1): то же тело, что у ленты, без cursor/limit/topic. */
  async newsTopics(
    userId: string,
    prefs: () => Promise<Preferences | null>,
    user: () => Promise<UserMeta>,
    watches: () => Promise<InternalWatch[]>,
    filter: "all" | "watch" | "interests" = "all",
  ) {
    return this.d.news.topics(userId, await this.newsQuery(userId, prefs, user, watches, filter));
  }

  /** Общее тело запроса новостей: профиль (интересы, сущности, география), слежения, настройки новостей, язык, доставка. */
  private async newsQuery(
    userId: string,
    prefs: () => Promise<Preferences | null>,
    user: () => Promise<UserMeta>,
    watches: () => Promise<InternalWatch[]>,
    filter: "all" | "watch" | "interests",
  ): Promise<NewsQueryBody> {
    const { news, watch } = this.d;
    const [p, u, settings, watched] = await Promise.all([
      prefs(),
      user(),
      news.preferences(userId).catch(() => DEFAULT_NEWS_PREFS),
      watch.configured ? watches().then((ws) => ws.map((w) => w.event_id)).catch(() => [] as string[]) : Promise.resolve([] as string[]),
    ]);
    const { interests, entities } = settings.by_interests ? interestsOf(p) : { interests: [], entities: [] };
    return {
      interests,
      entities,
      watched_event_ids: settings.from_watch ? [...new Set(watched)].slice(0, 100) : [],
      only_significant: settings.only_significant,
      filter,
      // география профиля — как в recommendations:rank; preferences недоступен — поле не передаётся (news берёт сохранённую)
      ...(p ? { geographies: geographiesOf(p) } : {}),
      lang: u.lang,
      // дайджест новостей (news) уходит до digest_time пользователя; нет данных identity — поля не передаются
      ...(u.digest_time ? { digest_time: u.digest_time } : {}),
      ...(u.timezone ? { timezone: u.timezone } : {}),
    };
  }

  // ---------------------------------------------------------------- сводка AT-23

  /**
   * Визит: время прошлого визита в Redis (VISIT_TTL_DAYS). Первый визит или прошло < HOME_SUMMARY_GAP_MINUTES —
   * null; иначе сводка с since = прошлый визит. Сводка считается один раз в начале визита и в течение
   * HOME_SUMMARY_HOLD_SECONDS отдаётся повторно (перерисовка, pull-to-refresh), затем — null. Сбой Redis — null.
   */
  async summary(
    userId: string,
    now: number,
    prefs: () => Promise<Preferences | null>,
    watches: () => Promise<InternalWatch[]>,
  ): Promise<HomeSummary | null> {
    const cfg = this.d.config;
    let kind: string;
    let since: number;
    let started: number;
    const key = this.summaryKey(userId);
    try {
      const r = (await this.d.redis.eval(
        VISIT,
        2,
        this.visitKey(userId),
        key,
        String(now),
        String(cfg.summaryGapMinutes * 60_000),
        String(cfg.visitTtlDays * 86_400),
        String(SUMMARY_PENDING_TTL_S),
      )) as string[];
      [kind, since, started] = [r[0] ?? "first", Number(r[1]), Number(r[2])];
    } catch (err) {
      this.d.log.warn({ err_name: (err as Error)?.name }, "home visit tracking failed");
      return null;
    }
    if (kind === "first" || !Number.isFinite(since) || !Number.isFinite(started)) return null;
    const sinceIso = new Date(since).toISOString();
    if (kind === "same") {
      // визит уже начат (в т. ч. параллельным запросом): since/started не сдвигаются; сводка — сохранённая первым
      const age = now - started;
      if (age >= Math.max(cfg.summaryHoldSeconds * 1000, SUMMARY_RACE_WINDOW_MS)) return null;
      const deadline = Date.now() + SUMMARY_WAIT_MS;
      for (;;) {
        let doc: { started?: number; pending?: boolean; summary?: HomeSummary | null } | null;
        try {
          const raw = await this.d.redis.get(key);
          doc = raw ? (JSON.parse(raw) as typeof doc) : null;
        } catch {
          doc = null;
        }
        if (doc?.started === started && !doc.pending) return doc.summary ?? null;
        const pending = doc?.started === started && doc.pending === true;
        // вне окна гонки сводки нет — не досчитываем; в окне: маркера нет (первый не сохранил) или ждали ≤ 1,5 с — сами
        if (age >= SUMMARY_RACE_WINDOW_MS) return null;
        if (!pending || Date.now() >= deadline) return this.computeAndSave(userId, key, started, sinceIso, prefs, watches, false);
        await new Promise((r) => setTimeout(r, SUMMARY_POLL_MS));
      }
    }
    return this.computeAndSave(userId, key, started, sinceIso, prefs, watches, true);
  }

  /** Считает сводку визита и сохраняет её (не меньше окна гонки). Первый запрос визита при ошибке записи снимает свой
   *  маркер «считается», чтобы параллельный запрос не ждал, а посчитал сам. */
  private async computeAndSave(
    userId: string,
    key: string,
    started: number,
    sinceIso: string,
    prefs: () => Promise<Preferences | null>,
    watches: () => Promise<InternalWatch[]>,
    owner: boolean,
  ): Promise<HomeSummary | null> {
    const summary = await this.computeSummary(userId, sinceIso, prefs, watches);
    try {
      const ttl = Math.max(this.d.config.summaryHoldSeconds, Math.ceil(SUMMARY_RACE_WINDOW_MS / 1000));
      await this.d.redis.set(key, JSON.stringify({ started, summary }), "EX", ttl);
    } catch (err) {
      this.d.log.warn({ err_name: (err as Error)?.name }, "home summary save failed");
      if (owner) await this.d.redis.del(key).catch(() => undefined);
    }
    return summary;
  }

  /** Каждая часть сводки независима: сбой или домен не подключён — null (не «0», предупреждение в лог); все части
   *  недоступны — сводки нет (null). */
  async computeSummary(
    userId: string,
    sinceIso: string,
    prefs: () => Promise<Preferences | null>,
    watches: () => Promise<InternalWatch[]>,
  ): Promise<HomeSummary | null> {
    const soft = async <T>(what: string, upstream: string, fn: () => Promise<T>, dflt: T): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        this.d.log.warn({ upstream, part: what, err_code: (err as { code?: string })?.code ?? (err as Error)?.name }, "home summary part unavailable");
        return dflt;
      }
    };
    const w = this.d.watch;
    const [newEvents, ws, opened] = await Promise.all([
      soft<number | null>("new_events", "events", async () => this.newEvents(await prefs(), sinceIso), null),
      w.configured ? soft<WatchSummary | null>("watch_summary", "watch", () => w.summary(userId, sinceIso), null) : Promise.resolve(null),
      w.configured ? soft<number | null>("sales_opened", "watch", async () => this.salesOpened(await watches(), sinceIso), null) : Promise.resolve(null),
    ]);
    const out: HomeSummary = {
      since: sinceIso,
      new_events: newEvents,
      price_drops: ws ? ws.price_drops_since : null,
      sales_opened: opened,
      critical: ws ? ws.critical : null,
    };
    return [out.new_events, out.price_drops, out.sales_opened, out.critical].every((v) => v === null) ? null : out;
  }

  /**
   * Новые события каталога по профилю с first_seen_at > since. Запрос events — sort=newest + first_seen_from (каталог
   * без параметра его игнорирует). Если в списке нет first_seen_at, граница «новых» в отсортированном по first_seen_at ↓
   * списке ищется двоичным поиском по детали события (≤ ~7 запросов на список). До 50 на запрос профиля, без дублей.
   */
  async newEvents(prefs: Preferences | null, sinceIso: string): Promise<number> {
    const since = ms(sinceIso);
    const { queries, categories, countries } = profileQueries(prefs);
    const qs: CatalogQuery[] = queries.length ? queries : [{}];
    const fresh = new Set<string>();
    let failures = 0;
    const details = new Map<string, Promise<number>>();
    const firstSeen = (id: string) => {
      let p = details.get(id);
      if (!p) {
        p = this.d.catalog.get(id).then((d) => ms(d.first_seen_at));
        details.set(id, p);
      }
      return p;
    };
    await Promise.all(
      qs.map(async (q) => {
        let list: Array<{ card: EventCard; first_seen_at: string | null }>;
        try {
          list = await this.d.catalog.newest({ ...q, limit: NEW_EVENTS_PER_QUERY, first_seen_from: sinceIso });
        } catch {
          failures += 1;
          return;
        }
        let prefix: number;
        if (list.every((x) => x.first_seen_at !== null)) {
          for (const x of list) if (ms(x.first_seen_at) > since && inCountries(x.card, categories, countries)) fresh.add(x.card.event_id);
          return;
        }
        try {
          prefix = await boundary(list.length, async (i) => (await firstSeen(list[i]!.card.event_id)) > since);
        } catch {
          failures += 1;
          return;
        }
        for (const x of list.slice(0, prefix)) if (inCountries(x.card, categories, countries)) fresh.add(x.card.event_id);
      }),
    );
    if (failures === qs.length) throw new Error("events unavailable");
    return fresh.size;
  }

  /** Открылись продажи по слежениям после since: изменение lifecycle → ON_SALE (watch) или статус ON_SALE в каталоге
   *  с changed_at > since (событие, по которому watch ещё не перепроверил, — только из «до продаж» состояний). */
  async salesOpened(watches: readonly InternalWatch[], sinceIso: string): Promise<number> {
    const since = ms(sinceIso);
    const opened = new Set<string>();
    const check: string[] = [];
    for (const w of watches) {
      const c = w.last_change;
      if (c && c.type === "lifecycle" && c.after === "ON_SALE" && ms(c.detected_at) > since) opened.add(w.event_id);
      else if (!w.last_snapshot || ["DISCOVERED", "VERIFIED", "ANNOUNCED", "SALES_SOON"].includes(w.last_snapshot.lifecycle_status)) check.push(w.event_id);
    }
    const cards = await mapLimit([...new Set(check)].slice(0, 20), 5, async (id) => {
      try {
        return detailToCard(await this.d.catalog.get(id));
      } catch {
        return null;
      }
    });
    for (const c of cards) if (c && c.lifecycle.status === "ON_SALE" && ms(c.lifecycle.changed_at) > since) opened.add(c.event_id);
    return opened.size;
  }
}

/** Длина префикса, где pred истинен (pred монотонен: true…true false…false), за O(log n) вызовов. */
export async function boundary(n: number, pred: (i: number) => Promise<boolean>): Promise<number> {
  if (n === 0 || !(await pred(0))) return 0;
  if (await pred(n - 1)) return n;
  let lo = 0; // pred(lo) = true
  let hi = n - 1; // pred(hi) = false
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (await pred(mid)) lo = mid;
    else hi = mid;
  }
  return hi;
}
