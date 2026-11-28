/**
 * Клиенты доменных сервисов. Внутренний JWT v2 (EdDSA, kid=iss=telegram-bff, aud=<домен>), проброс trace/correlation
 * id, таймаут, retry идемпотентных запросов, circuit breaker — ServiceClient из ts-common.
 *
 * Субъект внутреннего JWT (INTERNAL_API §9, CONVENTIONS §8):
 *  - учебные домены (learning-plan, центр уведомлений, experience-config for-me/seen/feed) — sub = активный ученик (lrn);
 *  - identity-consent /me/*, social, support — sub = аккаунт Telegram.
 * Какой субъект нужен, решает маршрут (subjects.ts); здесь — только транспорт.
 *
 * Ошибки:
 *  - 4xx домена → клиенту как есть (код, статус, details) — UpstreamError;
 *  - недоступность, таймаут, 5xx, открытый circuit breaker → 503 UPSTREAM_UNAVAILABLE {service};
 *  - отказ во внутренней авторизации (INTERNAL_*, USER_CONTEXT_*, CALLER_*, ACTOR_*) — ошибка конфигурации BFF или
 *    домена, клиенту её 401/403 не отдаём → 503;
 *  - любой другой 401 домена, кроме ответов о коде родителя (PIN_INVALID, BIOMETRIC_INVALID, RESET_CODE_INVALID), → 503:
 *    401 для Mini App — «сессия истекла» (refresh и повтор), а сессию BFF домен оценить не может (ревью T-4).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import {
  AppError,
  INTERNAL_ALG,
  INTERNAL_HEADER,
  KeyRing,
  ServiceClient,
  UpstreamError,
  issueInternalToken,
  outgoingHeaders,
  type InternalKey,
  type RequestOptions,
  type ServiceClientOptions,
} from "@tilhero/ts-common";

export const SERVICE_NAME = "telegram-bff";

/** aud внутреннего JWT = service_name домена. */
export const DOMAIN = {
  identity: "identity-consent",
  learningPlan: "learning-plan",
  support: "support",
  notifications: "notifications",
  experience: "experience-config",
  social: "social",
  catalog: "catalog",
  diagnostics: "diagnostics",
  lessons: "lessons",
  assessment: "assessment",
  memory: "memory",
} as const;

/** Отказ внутренней авторизации домена (любой статус). */
const INTERNAL_AUTH_RE = /^(INTERNAL_|USER_CONTEXT_|CALLER_|ACTOR_)/;
/** 401 доменов, которые — ответ пользователю (неверный код), а не состояние сессии. */
export const DOMAIN_BUSINESS_401: ReadonlySet<string> = new Set(["PIN_INVALID", "BIOMETRIC_INVALID", "RESET_CODE_INVALID"]);

/** 503 доменов, которые клиент различает по коду: спринт 3 — learning-plan без снимка курса и кеша (CATALOG_UNAVAILABLE);
 *  спринт 5 — memory: оценка произношения выключена (SPEECH_UNAVAILABLE — Mini App скрывает «Произнести»; спринт 7 —
 *  и распознавание голосового хода парной комнаты: перейти на текст); спринт 7 — gamification: lessons не выдал набор
 *  заданий при принятии дуэли (DUEL_SET_UNAVAILABLE — дуэль остаётся challenged, принятие можно повторить); спринт 8 —
 *  billing: Telegram не выдал ссылку на счёт (STARS_UNAVAILABLE — заказ pending, повторить тем же Idempotency-Key);
 *  lessons: приглашение в урок вдвоём, billing недоступен (BILLING_UNAVAILABLE — учёба работает, позвать позже). */
export const DOMAIN_BUSINESS_503: ReadonlySet<string> = new Set([
  "CATALOG_UNAVAILABLE",
  "SPEECH_UNAVAILABLE",
  "DUEL_SET_UNAVAILABLE",
  "STARS_UNAVAILABLE",
  "BILLING_UNAVAILABLE",
]);

/** Клиент закрыл соединение раньше ответа (long-poll парной комнаты): вызов домена прерван, ответ никому не нужен. */
export const clientClosed = () => new AppError(499, "CLIENT_CLOSED_REQUEST", "Запрос отменён клиентом");

export const catalogUnavailable = () =>
  new AppError(503, "CATALOG_UNAVAILABLE", "Курс временно недоступен, повторите позже", { service: "catalog" });

/** Ошибка домена, которую клиент не должен видеть как есть: сбой домена или конфигурации → 503. */
export function isDomainFault(status: number, code: string): boolean {
  if (status === 503 && DOMAIN_BUSINESS_503.has(code)) return false;
  if (status >= 500) return true;
  if (INTERNAL_AUTH_RE.test(code)) return true;
  return status === 401 && !DOMAIN_BUSINESS_401.has(code);
}

export type UpstreamLogger = (info: { service: string; status: number; code: string }) => void;

export function upstreamUnavailable(service: string): AppError {
  return new AppError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен, повторите позже", { service });
}

/** Дополнительные заголовки запроса к домену (If-Match): RequestOptions ts-common их не поддерживает. */
export interface DomainRequestOptions extends RequestOptions {
  headers?: Record<string, string>;
}

const extraHeaders = new AsyncLocalStorage<Record<string, string>>();

/** fetch, добавляющий заголовки текущего вызова (см. DomainClient.request). Служебные заголовки не перезаписываются. */
function withExtraHeaders(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const extra = extraHeaders.getStore();
    if (!extra) return inner(input, init);
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(extra)) if (!headers.has(k)) headers.set(k, v);
    return inner(input, { ...init, headers });
  };
}

export class DomainClient extends ServiceClient {
  constructor(
    opts: ServiceClientOptions,
    private readonly onFailure?: UpstreamLogger,
  ) {
    super({ ...opts, fetchImpl: withExtraHeaders(opts.fetchImpl ?? fetch) });
  }

  override async request<T = unknown>(method: string, path: string, ro: DomainRequestOptions = {}): Promise<T> {
    const { headers, ...rest } = ro;
    try {
      return headers ? await extraHeaders.run(headers, () => super.request<T>(method, path, rest)) : await super.request<T>(method, path, rest);
    } catch (err) {
      throw this.map(err);
    }
  }

  override get<T = unknown>(path: string, ro?: DomainRequestOptions) {
    return this.request<T>("GET", path, ro);
  }
  override post<T = unknown>(path: string, ro?: DomainRequestOptions) {
    return this.request<T>("POST", path, ro);
  }
  override put<T = unknown>(path: string, ro?: DomainRequestOptions) {
    return this.request<T>("PUT", path, ro);
  }
  override patch<T = unknown>(path: string, ro?: DomainRequestOptions) {
    return this.request<T>("PATCH", path, ro);
  }
  override delete<T = unknown>(path: string, ro?: DomainRequestOptions) {
    return this.request<T>("DELETE", path, ro);
  }

  private map(err: unknown): Error {
    if (err instanceof UpstreamError || (err instanceof AppError && "service" in err)) {
      const e = err as UpstreamError;
      if (isDomainFault(e.status, e.code)) {
        this.onFailure?.({ service: this.target, status: e.status, code: e.code });
        return upstreamUnavailable(this.target);
      }
      if (e.status === 503 && e.code === "CATALOG_UNAVAILABLE") return catalogUnavailable();
      return e;
    }
    if (err instanceof AppError) return err;
    // JSON.parse ответа и прочие неожиданные сбои — тоже «домен недоступен», без деталей наружу
    this.onFailure?.({ service: this.target, status: 0, code: "UPSTREAM_BAD_RESPONSE" });
    return upstreamUnavailable(this.target);
  }
}

export interface Domains {
  identity: DomainClient;
  learningPlan: DomainClient;
  support: DomainClient;
  notifications: DomainClient;
  experience: DomainClient;
  social: DomainClient;
  catalog: DomainClient;
  diagnostics: DomainClient;
  /** catalog без разбора JSON: снимок курса по ETag (304), байты аудио медиатеки. */
  catalogRaw: RawClient;
  /** Спринт 4: lessons и assessment — всегда с claims `lrn`, `age_band` (sub = аккаунт), поэтому RawClient. */
  lessons: RawClient;
  assessment: RawClient;
  /** Спринт 5: memory — sub = аккаунт, claims `lrn`, `age_band` (как lessons); байты аудио произношения. */
  memory: RawClient;
  /** Спринт 7: social от имени активного ученика — sub = аккаунт, claims `lrn`, `age_band` (профиль сообщества, друзья,
   *  блокировки, жалобы, санкции, рефералы). Приглашения и семья спринта 1 — по-прежнему `social` (sub = аккаунт). */
  socialRaw: RawClient;
}

export interface DomainsOptions {
  /** KeyRing telegram-bff (EdDSA) или dev/test-секрет. */
  key: InternalKey;
  urls: Record<keyof typeof DOMAIN, string>;
  timeoutMs: number;
  /** таймаут lessons / assessment (ИИ в ролевой ситуации и «проще») */
  lessonsTimeoutMs?: number;
  /** таймаут memory (перевод и произношение — свои, в вызове) */
  memoryTimeoutMs?: number;
  retries: number;
  fetchImpl?: typeof fetch;
  onFailure?: UpstreamLogger;
}

export function createDomains(o: DomainsOptions): Domains {
  const make = (key: keyof typeof DOMAIN) =>
    new DomainClient(
      {
        issuer: SERVICE_NAME,
        target: DOMAIN[key],
        baseUrl: o.urls[key],
        key: o.key,
        timeoutMs: o.timeoutMs,
        retries: o.retries,
        ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      },
      o.onFailure,
    );
  return {
    identity: make("identity"),
    learningPlan: make("learningPlan"),
    support: make("support"),
    notifications: make("notifications"),
    experience: make("experience"),
    social: make("social"),
    catalog: make("catalog"),
    diagnostics: make("diagnostics"),
    catalogRaw: new RawClient({
      target: DOMAIN.catalog,
      baseUrl: o.urls.catalog,
      key: o.key,
      timeoutMs: o.timeoutMs,
      retries: o.retries,
      fetchImpl: o.fetchImpl ?? ((...a) => fetch(...a)),
      ...(o.onFailure ? { onFailure: o.onFailure } : {}),
    }),
    lessons: raw("lessons", o.lessonsTimeoutMs),
    assessment: raw("assessment", o.lessonsTimeoutMs),
    memory: raw("memory", o.memoryTimeoutMs),
    socialRaw: raw("social", undefined),
  };

  function raw(key: "lessons" | "assessment" | "memory" | "social", timeoutMs: number | undefined): RawClient {
    return new RawClient({
      target: DOMAIN[key],
      baseUrl: o.urls[key],
      key: o.key,
      timeoutMs: timeoutMs ?? o.timeoutMs,
      retries: o.retries,
      fetchImpl: o.fetchImpl ?? ((...a) => fetch(...a)),
      ...(o.onFailure ? { onFailure: o.onFailure } : {}),
    });
  }
}

/** aud внутреннего JWT к tts (release 4.1, озвучка фраз). Не в DOMAIN: адрес tts необязателен (config.ttsUrl). */
export const TTS_SERVICE = "tts";

/** Клиент tts: байты MP3 (RawClient), свой таймаут, без повторов; нет адреса — null (озвучка недоступна). */
export function createTts(o: {
  url: string | undefined;
  key: InternalKey;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  onFailure?: UpstreamLogger;
}): RawClient | null {
  if (!o.url) return null;
  return new RawClient({
    target: TTS_SERVICE,
    baseUrl: o.url,
    key: o.key,
    timeoutMs: o.timeoutMs,
    retries: 0,
    fetchImpl: o.fetchImpl ?? ((...a) => fetch(...a)),
    ...(o.onFailure ? { onFailure: o.onFailure } : {}),
  });
}

/** aud внутреннего JWT к gamification (спринт 6). Не в DOMAIN: адрес необязателен (config.gamificationUrl). */
export const GAME_SERVICE = "gamification";

/** Клиент gamification (RawClient: claims `lrn`/`age_band`, байты картинок); нет адреса — null (игра недоступна). */
export function createGame(o: {
  url: string | undefined;
  key: InternalKey;
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
  onFailure?: UpstreamLogger;
}): RawClient | null {
  if (!o.url) return null;
  return new RawClient({
    target: GAME_SERVICE,
    baseUrl: o.url,
    key: o.key,
    timeoutMs: o.timeoutMs,
    retries: o.retries,
    fetchImpl: o.fetchImpl ?? ((...a) => fetch(...a)),
    ...(o.onFailure ? { onFailure: o.onFailure } : {}),
  });
}

/** aud внутреннего JWT к billing (спринт 8). Не в DOMAIN: адрес необязателен (config.billingUrl). */
export const BILLING_SERVICE = "billing";

/** Клиент billing (спринт 8, RawClient): один на Mini App и сайт оплаты. Канал — claim `chn` каждого вызова:
 *  `/v1/billing/*` (поток E) — `{lrn, age_band, chn: "miniapp"}`, `/web/v1/*` (поток H) — `{lrn: <аккаунт>, chn: "web"}`;
 *  sub — аккаунт. Нет адреса — null (503 BILLING_UNAVAILABLE). */
export function createBilling(o: {
  url: string | undefined;
  key: InternalKey;
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
  onFailure?: UpstreamLogger;
}): RawClient | null {
  if (!o.url) return null;
  return new RawClient({
    target: BILLING_SERVICE,
    baseUrl: o.url,
    key: o.key,
    timeoutMs: o.timeoutMs,
    retries: o.retries,
    fetchImpl: o.fetchImpl ?? ((...a) => fetch(...a)),
    ...(o.onFailure ? { onFailure: o.onFailure } : {}),
  });
}

export type RawMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RawRequest {
  subject?: string | undefined;
  query?: Record<string, string | number | undefined | null>;
  headers?: Record<string, string>;
  /** Дополнительные claims внутреннего JWT (catalog, заявки: lrn — активный ученик, age_band — возраст аккаунта). */
  claims?: Record<string, string>;
  body?: unknown;
  /** Тело как есть (байты аудио произношения) — вместо JSON `body`; в лог не пишется нигде. */
  rawBody?: { bytes: Uint8Array; contentType: string };
  idempotencyKey?: string;
  /** таймаут этого вызова (завершение урока ждёт оценку дольше обычного) */
  timeoutMs?: number;
  /** повторы GET этого вызова вместо общих (long-poll не повторяется: повтор удвоил бы ожидание) */
  retries?: number;
  /** отмена вызова снаружи (клиент закрыл соединение long-poll) → 499 CLIENT_CLOSED_REQUEST без записи о сбое домена */
  signal?: AbortSignal;
}

/** Внутренний JWT v2 в формате ts-common issueInternalToken (EdDSA, kid = iss, aud, iat, exp 60 с, jti) + свои claims.
 *  ts-common не умеет дополнительные claims (запрос к общему коду, README). Служебные claims перезаписать нельзя. */
export async function issueWithClaims(
  key: InternalKey,
  o: { audience: string; subject?: string | undefined; claims?: Record<string, string> | undefined },
): Promise<string> {
  const ring = typeof key === "string" ? KeyRing.derived(key, SERVICE_NAME) : key;
  const now = Math.floor(Date.now() / 1000);
  const extra = Object.fromEntries(Object.entries(o.claims ?? {}).filter(([k]) => !["iss", "aud", "sub", "iat", "exp", "jti", "nbf", "actor"].includes(k)));
  let jwt = new SignJWT(extra)
    .setProtectedHeader({ alg: INTERNAL_ALG, typ: "JWT", kid: SERVICE_NAME })
    .setIssuer(SERVICE_NAME)
    .setAudience(o.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(randomUUID().replaceAll("-", ""));
  if (o.subject) jwt = jwt.setSubject(o.subject);
  return jwt.sign(ring.privateKey);
}

/**
 * Вызов домена с доступом к самому ответу (заголовки ETag / Content-Type, 304, байты) — ServiceClient всегда разбирает
 * JSON. Тот же внутренний JWT (iss = telegram-bff, aud = домен), trace/correlation id и таймаут; ошибки — как у
 * DomainClient: 4xx домена → клиенту с кодом, сбой → 503 UPSTREAM_UNAVAILABLE. Без повторов: вызывающий сам решает,
 * отдать ли кеш.
 */
export class RawClient {
  constructor(
    private readonly o: {
      target: string;
      baseUrl: string;
      key: InternalKey;
      timeoutMs: number;
      /** повторы GET при сетевом сбое и 5xx (как ServiceClient); команды не повторяются */
      retries?: number;
      fetchImpl: typeof fetch;
      onFailure?: UpstreamLogger;
    },
  ) {}

  get target(): string {
    return this.o.target;
  }

  get(path: string, ro: RawRequest = {}): Promise<Response> {
    return this.request("GET", path, ro);
  }

  /** JSON-команда с дополнительными claims: ответ разобран, ошибки — как у DomainClient. */
  async json<T>(method: RawMethod, path: string, ro: RawRequest = {}): Promise<T> {
    return (await this.jsonWithStatus<T>(method, path, ro)).body;
  }

  /** То же, что json, и статус ответа домена (201 — создано, 200 — уже было). */
  async jsonWithStatus<T>(method: RawMethod, path: string, ro: RawRequest = {}): Promise<{ status: number; body: T }> {
    const resp = await this.request(method, path, ro);
    if (resp.status === 204) return { status: 204, body: undefined as T };
    try {
      return { status: resp.status, body: (await resp.json()) as T };
    } catch {
      if (ro.signal?.aborted) throw clientClosed();
      this.o.onFailure?.({ service: this.o.target, status: resp.status, code: "UPSTREAM_BAD_RESPONSE" });
      throw upstreamUnavailable(this.o.target);
    }
  }

  async request(method: RawMethod, path: string, ro: RawRequest = {}): Promise<Response> {
    const url = new URL(this.o.baseUrl.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(ro.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      ...(ro.headers ?? {}),
      ...outgoingHeaders(),
      [INTERNAL_HEADER]: ro.claims
        ? await issueWithClaims(this.o.key, { audience: this.o.target, subject: ro.subject, claims: ro.claims })
        : await issueInternalToken(this.o.key, {
            issuer: SERVICE_NAME,
            audience: this.o.target,
            ...(ro.subject ? { subject: ro.subject } : {}),
          }),
    };
    if (ro.rawBody) headers["content-type"] = ro.rawBody.contentType;
    else if (ro.body !== undefined) headers["content-type"] = "application/json";
    if (ro.idempotencyKey) headers["idempotency-key"] = ro.idempotencyKey;
    const attempts = method === "GET" ? (ro.retries ?? this.o.retries ?? 0) + 1 : 1;
    let resp: Response | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (ro.signal?.aborted) throw clientClosed();
      const timeout = AbortSignal.timeout(ro.timeoutMs ?? this.o.timeoutMs);
      try {
        resp = await this.o.fetchImpl(url, {
          method,
          headers,
          body: ro.rawBody ? ro.rawBody.bytes : ro.body !== undefined ? JSON.stringify(ro.body) : null,
          signal: ro.signal ? AbortSignal.any([timeout, ro.signal]) : timeout,
        });
      } catch {
        // отменил клиент — не сбой домена: без повтора и без записи «domain unavailable»
        if (ro.signal?.aborted) throw clientClosed();
        if (attempt < attempts) continue;
        this.o.onFailure?.({ service: this.o.target, status: 0, code: "UPSTREAM_UNREACHABLE" });
        throw upstreamUnavailable(this.o.target);
      }
      if (resp.status >= 500 && attempt < attempts) {
        await resp.body?.cancel().catch(() => undefined);
        continue;
      }
      break;
    }
    if (!resp) throw upstreamUnavailable(this.o.target);
    if (resp.status < 400) return resp;
    let body: { code?: unknown; message?: unknown; details?: unknown } = {};
    try {
      body = (await resp.json()) as typeof body;
    } catch {
      /* не JSON — ниже как сбой */
    }
    const code = typeof body.code === "string" ? body.code : "UPSTREAM_ERROR";
    if (isDomainFault(resp.status, code) || typeof body.code !== "string") {
      this.o.onFailure?.({ service: this.o.target, status: resp.status, code });
      throw upstreamUnavailable(this.o.target);
    }
    const details = body.details && typeof body.details === "object" ? (body.details as Record<string, unknown>) : {};
    throw new AppError(resp.status, code, typeof body.message === "string" ? body.message : code, details);
  }
}

/** 404 домена → null (например, семьи нет); прочие ошибки — как есть. */
export async function orNull<T>(p: Promise<T>, code: string): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof AppError && err.status === 404 && err.code === code) return null;
    throw err;
  }
}
