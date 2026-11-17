/**
 * Единый лимитер запросов (спринт 9, INTERNAL_API §2.1–2.3) — та же семантика, что py-common
 * `tilhero_common/ratelimit.py`.
 *
 * - GCRA на одном ключе субъекта `rl:<policy>:<subject>` (Lua, EVALSHA; реплики делят ключ, время — Redis).
 *   Эталон скрипта — `packages/contracts/rate-limit-gcra.lua`, общий тест-вектор — `rate-limit-vectors.json`.
 * - Каталог политик — `packages/contracts/rate-limit-policies.json` (копия — RATE_LIMIT_POLICIES, тест сверяет);
 *   значения по умолчанию BFF передаёт из своей конфигурации (env RATE_LIMIT_*, как раньше).
 * - Переопределение без деплоя — `rl:override:<policy>`, перечитывается раз в `overrideRefreshSeconds`
 *   (повреждённая запись → значения по умолчанию + WARNING). Действующие параметры — `rl:policy:<policy>` (TTL 10 мин).
 * - Метрики — `rlm:<policy>:<minute>` и `rlt:<policy>:<minute>` (TTL 3 ч), пишет сам скрипт; сбои Redis
 *   (`failopen` / `failclosed`) копятся в процессе и дописываются после восстановления.
 * - Сбой Redis: `fail: open` — пропуск (WARNING не чаще раза в минуту на политику), `closed` — 503 RATE_LIMIT_UNAVAILABLE.
 * - `enabled=false` (RATE_LIMITS_ENABLED) — пропускает всё, считает только `allowed`.
 *
 * ts-common не зависит от ioredis: нужен клиент с `call(command, ...args)` (ioredis 5 — `Redis#call`).
 */
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "./errors.js";

export type FailMode = "open" | "closed";

export interface PolicySpec {
  policy: string;
  service: string;
  subject: string;
  limit: number;
  window_s: number;
  burst: number | null;
  fail: FailMode;
  env: string | null;
  description: string;
}

const P = (
  policy: string,
  service: string,
  subject: string,
  limit: number,
  window_s: number,
  fail: FailMode,
  env: string | null,
  description: string,
): PolicySpec => ({ policy, service, subject, limit, window_s, burst: null, fail, env, description });

/** Копия packages/contracts/rate-limit-policies.json (test/rateLimit.test.ts сверяет поле в поле). */
export const RATE_LIMIT_POLICIES: readonly PolicySpec[] = [
  P("tg.user", "telegram-bff", "user", 120, 60, "open", "RATE_LIMIT_USER_PER_MIN", "Все авторизованные запросы Mini App — на пользователя"),
  P("tg.session_ip", "telegram-bff", "ip", 10, 60, "closed", "RATE_LIMIT_SESSION_IP_PER_MIN", "Вход по initData (POST /v1/session/telegram) — с одного IP"),
  P("tg.pin", "telegram-bff", "user", 5, 60, "closed", "RATE_LIMIT_PIN_PER_MIN", "Проверка и сброс PIN / биометрии — на пользователя (сброс — отдельный счётчик reset:<user_id>)"),
  P("tg.public_ip", "telegram-bff", "ip", 120, 60, "open", "RATE_LIMIT_PUBLIC_IP_PER_MIN", "Публичные эндпоинты Mini App (refresh, config, policy) — с одного IP"),
  P("tg.offers", "telegram-bff", "user", 20, 60, "open", "RATE_LIMIT_OFFERS_PER_MIN", "Расчёт предложений поездки — на пользователя"),
  P("tg.reactions", "telegram-bff", "user", 60, 60, "open", "RATE_LIMIT_REACTIONS_PER_MIN", "Реакции «Больше такого» / «Не интересно» — на пользователя"),
  P("tg.watch", "telegram-bff", "user", 30, 60, "open", "RATE_LIMIT_WATCH_PER_MIN", "Команды слежений — на пользователя"),
  P("tg.ai", "telegram-bff", "user", 6, 60, "open", "AI_RATE_PER_MINUTE", "Ходы AI-консьержа — на пользователя (сверх суточной квоты)"),
  P("tg.support_create", "telegram-bff", "user", 10, 3600, "open", null, "Создание обращения в поддержку — на пользователя в час (новая)"),
  P("adm.login_ip", "admin-bff", "ip", 10, 60, "closed", "RATE_LIMIT_LOGIN_IP_PER_MIN", "Вход сотрудника (POST /admin/v1/auth/login) — с одного IP"),
  P("adm.login_email", "admin-bff", "email", 5, 60, "closed", "RATE_LIMIT_LOGIN_EMAIL_PER_MIN", "Вход сотрудника — на один e-mail (в ключе только хеш с суточной солью)"),
  P("adm.auth_step_ip", "admin-bff", "ip", 30, 60, "closed", "RATE_LIMIT_AUTH_STEP_IP_PER_MIN", "Шаги входа по challenge (MFA, enroll, пароль) — с одного IP"),
  P("adm.mfa", "admin-bff", "staff", 5, 60, "closed", "RATE_LIMIT_MFA_PER_MIN", "Ввод TOTP и смена пароля — на challenge входа (хеш) и на сотрудника (step-up, пароль — отдельные счётчики)"),
  P("adm.staff", "admin-bff", "staff", 300, 60, "open", "RATE_LIMIT_STAFF_PER_MIN", "Все запросы сотрудника"),
  P("adm.command", "admin-bff", "staff", 60, 60, "closed", null, "Команды сотрудника (POST / PUT / PATCH / DELETE) (новая)"),
  P("adm.dlq", "admin-bff", "staff", 10, 60, "closed", null, "Команды DLQ и повтор удаления профиля (новая)"),
  P("int.caller", "*", "caller", 10000, 60, "open", null, "Внутренние вызовы Python-сервисов — на пару (вызывающий, сервис): защита от зацикливания (новая)"),
  P("gw.llm.user", "provider-gateway", "user", 40, 60, "open", null, "Потоковый Claude (llm/messages:stream) — на пользователя (новая)"),
];

export const GCRA_LUA = `-- TilHero: единый лимитер запросов (спринт 9, INTERNAL_API §2.1) — GCRA на одном ключе субъекта.
-- Эталон; копии — py-common tilhero_common/ratelimit.py (GCRA_LUA) и ts-common src/rateLimit.ts (GCRA_LUA),
-- тесты обеих сторон сверяют копию с этим файлом и прогоняют packages/contracts/rate-limit-vectors.json.
-- KEYS[1] rl:<policy>:<subject>   — TAT (theoretical arrival time), мкс
-- KEYS[2] rlm:<policy>:<minute>   — метрики минуты {allowed, rejected}
-- KEYS[3] rlt:<policy>:<minute>   — ZSET отказов по субъекту (псевдоним), ≤ ARGV[6]
-- ARGV[1] интервал между запросами, мкс (window_s * 1e6 / limit, целое)
-- ARGV[2] burst (≥ 1)
-- ARGV[3] now, мкс ("" — время Redis: реплики делят одни часы)
-- ARGV[4] субъект для топа отказов
-- ARGV[5] TTL метрик, с
-- ARGV[6] размер топа отказов
-- → {allowed 0|1, retry_after_ms, remaining}
local t = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
if not now then
  local tm = redis.call('TIME')
  now = tonumber(tm[1]) * 1000000 + tonumber(tm[2])
end
local tat = tonumber(redis.call('GET', KEYS[1]))
if not tat or tat < now then
  tat = now
end
local new_tat = tat + t
local allow_at = new_tat - burst * t
local ttl = tonumber(ARGV[5])
if now < allow_at then
  redis.call('HINCRBY', KEYS[2], 'rejected', 1)
  redis.call('EXPIRE', KEYS[2], ttl)
  local top = tonumber(ARGV[6])
  redis.call('ZINCRBY', KEYS[3], 1, ARGV[4])
  if redis.call('ZCARD', KEYS[3]) > top then
    redis.call('ZREMRANGEBYRANK', KEYS[3], 0, -(top + 1))
  end
  redis.call('EXPIRE', KEYS[3], ttl)
  return {0, math.ceil((allow_at - now) / 1000), 0}
end
redis.call('SET', KEYS[1], string.format('%d', new_tat), 'PX', math.ceil((new_tat - now) / 1000))
redis.call('HINCRBY', KEYS[2], 'allowed', 1)
redis.call('EXPIRE', KEYS[2], ttl)
return {1, 0, math.floor((now - allow_at) / t)}
`;

export const METRICS_TTL_SECONDS = 3 * 3600;
export const TOP_SUBJECTS = 50;
export const POLICY_TTL_SECONDS = 600;
const SALT_TTL_SECONDS = 48 * 3600;

/** Минимальный клиент Redis (ioredis 5: `Redis#call`). */
export interface RateRedis {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
}

export interface Logger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface RateDecision {
  allowed: boolean;
  /** секунды, ≥ 1 при отказе */
  retryAfter: number;
  remaining: number;
  policy: string;
  /** Redis недоступен, политика fail: open — пропущено без проверки */
  degraded?: boolean;
}

export interface EffectivePolicy extends PolicySpec {
  source: "default" | "override";
}

export interface Override {
  limit: number;
  window_s: number;
  burst: number | null;
  by: string;
  at: string;
  reason: string;
  expires_at: string | null;
}

// ---------------------------------------------------------------- ошибки (INTERNAL_API §2.2, §9)

export function rateLimitedError(policy: string, retryAfter: number): AppError {
  return new AppError(429, "RATE_LIMITED", "Слишком много запросов, повторите позже", {
    policy,
    retry_after: Math.max(1, Math.ceil(retryAfter)),
  });
}

export function rateLimitUnavailable(policy: string): AppError {
  return new AppError(503, "RATE_LIMIT_UNAVAILABLE", "Проверка лимита временно недоступна, повторите позже", { policy });
}

// ---------------------------------------------------------------- ключи и псевдонимы

export const epochMinute = (ms: number) => Math.floor(ms / 60_000);

/**
 * Ключ лимита по IP: IPv4 — адрес целиком; IPv6 — префикс /64 (клиент обычно владеет всей /64 и иначе обходит
 * лимит, перебирая адреса — ревью T5); IPv4-mapped IPv6 (::ffff:a.b.c.d) — как IPv4.
 */
export function ipRateKey(ip: string): string {
  const addr = ip.split("%")[0]!.toLowerCase();
  if (!addr.includes(":")) return addr;
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr) ?? /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped?.[1]) return mapped[1];
  const [head = "", tail = ""] = addr.split("::", 2) as [string, string?];
  const headParts = head ? head.split(":") : [];
  const tailParts = addr.includes("::") && tail ? tail.split(":") : [];
  const groups = addr.includes("::")
    ? [...headParts, ...Array<string>(Math.max(0, 8 - headParts.length - tailParts.length)).fill("0"), ...tailParts]
    : headParts;
  const prefix = groups
    .slice(0, 4)
    .map((g) => (g.includes(".") ? "0" : g.padStart(4, "0")))
    .join(":");
  return `${prefix}::/64`;
}

export function parseOverride(raw: string | null, now = Date.now()): Override | null {
  if (raw === null) return null;
  const d = JSON.parse(raw) as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
  if (!d || typeof d !== "object" || d.v !== 1) throw new Error("override version");
  if (!int(d.limit, 1, 100_000)) throw new Error("override limit");
  if (!int(d.window_s, 1, 86_400)) throw new Error("override window_s");
  if (d.burst !== null && d.burst !== undefined && !int(d.burst, 1, 100_000)) throw new Error("override burst");
  const exp = d.expires_at ?? null;
  if (exp !== null) {
    if (typeof exp !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(exp)) throw new Error("override expires_at");
    const t = Date.parse(exp);
    if (Number.isNaN(t)) throw new Error("override expires_at");
    if (t <= now) return null;
  }
  return {
    limit: d.limit as number,
    window_s: d.window_s as number,
    burst: (d.burst as number | null | undefined) ?? null,
    by: String(d.by ?? ""),
    at: String(d.at ?? ""),
    reason: String(d.reason ?? ""),
    expires_at: exp as string | null,
  };
}

/**
 * Политики сервиса со значениями по умолчанию из его конфигурации (env RATE_LIMIT_* → limit). Политика каталога
 * без значения в `limits` — со значением каталога; имя не из каталога — ошибка (опечатка в BFF).
 */
export function policyDefaults(service: string, limits: Record<string, number> = {}): Record<string, PolicySpec> {
  const out: Record<string, PolicySpec> = {};
  for (const p of RATE_LIMIT_POLICIES) if (p.service === service) out[p.policy] = { ...p };
  for (const [name, limit] of Object.entries(limits)) {
    const p = out[name];
    if (!p) throw new Error(`rate limit policy ${name} is not a ${service} policy`);
    out[name] = { ...p, limit };
  }
  return out;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("rate limit store timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

export interface RateLimiterOptions {
  redis: RateRedis;
  service: string;
  policies: Record<string, PolicySpec>;
  enabled?: boolean;
  overrideRefreshSeconds?: number;
  /** Пусто в prod (платформенный namespace rl*, его читает ops-monitor); префикс — только для изоляции тестов. */
  keyPrefix?: string;
  timeoutMs?: number;
  log?: Logger;
  nowMs?: () => number;
}

export class RateLimiter {
  readonly service: string;
  readonly enabled: boolean;
  private readonly redis: RateRedis;
  private readonly defaults: Record<string, PolicySpec>;
  private readonly refreshMs: number;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly log: Logger | undefined;
  private readonly nowMs: () => number;
  private overrides: Record<string, Override | null> = {};
  private refreshedAt = -Infinity;
  private refreshing: Promise<void> | null = null;
  private sha: string | null = null;
  private pending = new Map<string, number>();
  private flushing: Promise<void> | null = null;
  private warned = new Map<string, number>();
  private salt: { day: string; value: string } | null = null;

  constructor(o: RateLimiterOptions) {
    this.redis = o.redis;
    this.service = o.service;
    this.defaults = { ...o.policies };
    this.enabled = o.enabled ?? true;
    this.refreshMs = (o.overrideRefreshSeconds ?? 30) * 1000;
    this.prefix = o.keyPrefix ?? "";
    this.timeoutMs = o.timeoutMs ?? 500;
    this.log = o.log;
    this.nowMs = o.nowMs ?? Date.now;
  }

  // ---- ключи
  key(kind: "rl" | "rlm" | "rlt", policy: string, part: string | number): string {
    return `${this.prefix}${kind}:${policy}:${part}`;
  }
  overrideKey(policy: string): string {
    return `${this.prefix}rl:override:${policy}`;
  }
  policyKey(policy: string): string {
    return `${this.prefix}rl:policy:${policy}`;
  }

  // ---- параметры
  policies(): string[] {
    return Object.keys(this.defaults);
  }

  effective(policy: string): EffectivePolicy {
    const base = this.defaults[policy];
    if (!base) throw new Error(`unknown rate limit policy ${policy}`);
    const ov = this.overrides[policy];
    if (!ov) return { ...base, source: "default" };
    return { ...base, limit: ov.limit, window_s: ov.window_s, burst: ov.burst, source: "override" };
  }

  /** Перечитать переопределения и опубликовать действующие параметры (`rl:policy:*`). */
  async refresh(): Promise<void> {
    const names = this.policies();
    const raws = (await this.redis.call("MGET", ...names.map((n) => this.overrideKey(n)))) as (string | null)[];
    const fresh: Record<string, Override | null> = {};
    names.forEach((name, i) => {
      try {
        fresh[name] = parseOverride(raws[i] ?? null, this.nowMs());
      } catch {
        this.log?.warn({ event: "rate_limit_override_invalid", policy: name }, "rate limit override invalid, defaults used");
        fresh[name] = null;
      }
    });
    this.overrides = fresh;
    this.refreshedAt = this.nowMs();
    for (const name of names) {
      const p = this.effective(name);
      const body = { limit: p.limit, window_s: p.window_s, burst: p.burst, fail: p.fail, service: p.service, subject: p.subject, source: p.source, enabled: this.enabled };
      await this.redis.call("SET", this.policyKey(name), JSON.stringify(body), "EX", POLICY_TTL_SECONDS);
    }
  }

  private maybeRefresh(): void {
    if (this.nowMs() - this.refreshedAt < this.refreshMs || this.refreshing) return;
    this.refreshing = withTimeout(this.refresh(), Math.max(this.timeoutMs, 1000))
      .catch(() => {
        this.refreshedAt = this.nowMs() - this.refreshMs + 5000; // Redis недоступен — повтор через 5 с
      })
      .finally(() => {
        this.refreshing = null;
      });
  }

  // ---- псевдонимы субъектов
  /** Суточная соль `rl:salt:<день>` (SET NX, TTL 48 ч): общая для реплик, IP в открытом виде не хранится. */
  private async daySalt(): Promise<string> {
    const day = new Date(this.nowMs()).toISOString().slice(0, 10);
    if (this.salt?.day === day) return this.salt.value;
    const key = `${this.prefix}rl:salt:${day}`;
    await this.redis.call("SET", key, randomBytes(16).toString("hex"), "EX", SALT_TTL_SECONDS, "NX");
    const value = (await this.redis.call("GET", key)) as string | null;
    if (!value) throw new Error("rate limit salt unavailable");
    this.salt = { day, value };
    return value;
  }

  /** Псевдоним субъекта: sha256(значение + суточная соль)[:16]. IP нормализуется (IPv6 — /64). */
  async hashedSubject(kind: "ip" | "email" | "challenge", value: string): Promise<string> {
    const salt = await this.daySalt();
    const v = kind === "ip" ? ipRateKey(value) : value;
    return createHash("sha256").update(`${kind}:${v}:${salt}`, "utf8").digest("hex").slice(0, 16);
  }

  // ---- проверка
  private async evalGcra(keys: string[], args: (string | number)[]): Promise<number[]> {
    this.sha ??= (await this.redis.call("SCRIPT", "LOAD", GCRA_LUA)) as string;
    try {
      return ((await this.redis.call("EVALSHA", this.sha, keys.length, ...keys, ...args)) as unknown[]).map(Number);
    } catch (err) {
      if (!String((err as Error)?.message).includes("NOSCRIPT")) throw err;
      this.sha = (await this.redis.call("SCRIPT", "LOAD", GCRA_LUA)) as string;
      return ((await this.redis.call("EVALSHA", this.sha, keys.length, ...keys, ...args)) as unknown[]).map(Number);
    }
  }

  /**
   * Проверка политики для субъекта. `subject` — псевдоним (user_id, staff_id) или функция, которая его вычисляет
   * (хеш IP / e-mail — нужна соль из Redis: сбой здесь — тоже сбой Redis по режиму политики).
   */
  async check(policy: string, subject: string | (() => Promise<string>)): Promise<RateDecision> {
    const p = this.effective(policy);
    const minute = epochMinute(this.nowMs());
    this.maybeRefresh();
    if (!this.enabled) {
      this.fire(this.count(policy, minute, "allowed", 1));
      return { allowed: true, retryAfter: 0, remaining: p.burst ?? p.limit, policy };
    }
    let res: number[];
    try {
      res = await withTimeout(
        (async () => {
          const s = typeof subject === "string" ? subject : await subject();
          const emission = Math.max(1, Math.floor((p.window_s * 1_000_000) / p.limit));
          return this.evalGcra(
            [this.key("rl", policy, s), this.key("rlm", policy, minute), this.key("rlt", policy, minute)],
            [emission, p.burst ?? p.limit, "", s, METRICS_TTL_SECONDS, TOP_SUBJECTS],
          );
        })(),
        this.timeoutMs,
      );
    } catch (err) {
      return this.failed(p, minute, err);
    }
    if (this.pending.size && !this.flushing) {
      this.flushing = this.flushPending().finally(() => {
        this.flushing = null;
      });
      this.fire(this.flushing);
    }
    const [allowed = 0, retryMs = 0, remaining = 0] = res;
    if (allowed === 1) return { allowed: true, retryAfter: 0, remaining, policy };
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(retryMs / 1000)), remaining: 0, policy };
  }

  /** Бросает 429 RATE_LIMITED (Retry-After выставляет общий обработчик ошибок) или 503 RATE_LIMIT_UNAVAILABLE. */
  async enforce(policy: string, subject: string | (() => Promise<string>)): Promise<RateDecision> {
    const d = await this.check(policy, subject);
    if (!d.allowed) throw rateLimitedError(policy, d.retryAfter);
    return d;
  }

  private failed(p: EffectivePolicy, minute: number, err: unknown): RateDecision {
    const field = p.fail === "closed" ? "failclosed" : "failopen";
    const k = `${p.policy}\n${minute}\n${field}`;
    this.pending.set(k, (this.pending.get(k) ?? 0) + 1);
    const now = this.nowMs();
    if (now - (this.warned.get(p.policy) ?? -Infinity) >= 60_000) {
      this.warned.set(p.policy, now);
      this.log?.warn(
        { event: "rate_limit_store_unavailable", policy: p.policy, fail: p.fail, err_name: (err as Error)?.name },
        "rate limit store unavailable",
      );
    }
    if (p.fail === "closed") throw rateLimitUnavailable(p.policy);
    return { allowed: true, retryAfter: 0, remaining: 0, policy: p.policy, degraded: true };
  }

  private async count(policy: string, minute: number, field: string, n: number): Promise<void> {
    const key = this.key("rlm", policy, minute);
    await this.redis.call("HINCRBY", key, field, n);
    await this.redis.call("EXPIRE", key, METRICS_TTL_SECONDS);
  }

  private async flushPending(): Promise<void> {
    const batch = this.pending;
    this.pending = new Map();
    for (const [k, n] of batch) {
      const [policy = "", minute = "0", field = ""] = k.split("\n");
      try {
        await this.count(policy, Number(minute), field, n);
      } catch {
        this.pending.set(k, (this.pending.get(k) ?? 0) + n);
      }
    }
  }

  /** Метрики — fire-and-forget: ответ не ждёт записи, ошибка записи не влияет на запрос. */
  private fire(p: Promise<void>): void {
    p.catch(() => undefined);
  }

  /** Дождаться фоновых операций (тесты, остановка). */
  async settle(): Promise<void> {
    await this.refreshing;
    await this.flushing;
    if (this.pending.size) await this.flushPending().catch(() => undefined);
  }
}
