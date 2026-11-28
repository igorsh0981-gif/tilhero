/**
 * Зависимости обработчиков admin-bff (собираются в buildApp; в тестах подменяются Redis, fetch и часы).
 */
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type { StaffSummary } from "@tilhero/contracts/admin";
import { AppError, currentContext } from "@tilhero/ts-common";
import type { Config } from "./config.js";
import type { Principal, StaffAuth } from "./http.js";
import type { RateLimiter } from "./rateLimit.js";
import type { SessionStore } from "./sessions.js";
import { upstreamUnavailable, type DomainClient, type Domains } from "./upstream.js";
import { BadValue, C, type Codec } from "./codec.js";
import { STAFF_SUMMARY } from "./contract.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BffContext {
  config: Config;
  redis: Redis;
  sessions: SessionStore;
  limiter: RateLimiter;
  domains: Domains;
  /** Спринт 6: gamification; null — GAMIFICATION_URL не задана (маршруты игры → 503, блок обзора недоступен). */
  gamification: DomainClient | null;
  /** Спринт 7: social; null — SOCIAL_URL не задана (маршруты social → 503, блок обзора `social` недоступен). */
  social: DomainClient | null;
  /** Спринт 8: billing; null — BILLING_URL не задана (маршруты «Деньги» → 503, блок обзора `money` недоступен). */
  billing: DomainClient | null;
  principals: PrincipalCache;
  names: StaffNames;
  log: FastifyBaseLogger;
  now(): number;
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

const PRINCIPAL: Codec<Principal> = C.obj<Principal>({
  staff: STAFF_SUMMARY,
  permissions: C.arr(C.str(64, 1), 200),
  mfa_enabled: C.bool,
  must_change_password: C.bool,
  session_version: C.int(0),
  status: C.oneOf(["ACTIVE", "LOCKED", "DISABLED"] as const),
});

/** principal admin-identity (шаг входа, GET principal) — строго; испорченный → 503 UPSTREAM_UNAVAILABLE. */
export function parsePrincipal(v: unknown): Principal {
  try {
    return PRINCIPAL.parse(v, "$");
  } catch (e) {
    if (e instanceof BadValue) throw upstreamUnavailable("admin-identity");
    throw e;
  }
}

/**
 * principal сотрудника из admin-identity с кэшем в Redis (≤ 30 с, общий для инстансов). Изменения, сделанные
 * через этот BFF (смена пароля, роли, статуса, сбросы), сбрасывают кэш сразу — отзыв без ожидания TTL.
 */
export class PrincipalCache {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly ttlSeconds: number,
    private readonly client: DomainClient,
    private readonly store: <T>(fn: () => Promise<T>) => Promise<T>,
  ) {}

  private key(staffId: string): string {
    return `${this.prefix}principal:${staffId}`;
  }

  async get(staffId: string): Promise<Principal> {
    if (this.ttlSeconds > 0) {
      const cached = await this.store(() => this.redis.get(this.key(staffId)));
      if (cached) {
        try {
          return JSON.parse(cached) as Principal;
        } catch {
          /* битая запись — перечитываем */
        }
      }
    }
    const p = parsePrincipal(await this.client.get<unknown>(`/internal/v1/staff/${encodeURIComponent(staffId)}/principal`));
    await this.put(p);
    return p;
  }

  /** Только кэш (без admin-identity): для резервного аудита logout, когда admin-identity недоступен. */
  async peek(staffId: string): Promise<Principal | null> {
    try {
      const cached = await this.redis.get(this.key(staffId));
      return cached ? parsePrincipal(JSON.parse(cached)) : null;
    } catch {
      return null;
    }
  }

  async put(p: Principal): Promise<void> {
    if (this.ttlSeconds <= 0) return;
    await this.store(() => this.redis.set(this.key(p.staff.staff_id), JSON.stringify(p), "EX", this.ttlSeconds));
  }

  async invalidate(staffId: string): Promise<void> {
    await this.store(() => this.redis.del(this.key(staffId)));
  }
}

/**
 * Служебные авторы с UUID, которых нет среди сотрудников (lookup их не найдёт): автор и проверяющий сида контента
 * catalog (импорт миграцией данных, docs/sprint3/PLAN.md «Решения»).
 */
export const SYSTEM_ACTOR_NAMES: Readonly<Record<string, string>> = {
  "00000000-0000-4000-a000-000000005eed": "Сид (начальное наполнение)",
};

/**
 * Имена сотрудников для полей `*_name` (операторы тикетов, авторы заметок, версий шаблонов и рассылок) —
 * admin-identity `GET /admin/v1/staff/lookup?ids=` (с actor; в INTERNAL_API §1 — /internal/v1/…, admin-identity
 * реализовал по пути staff API), in-memory кэш 60 с, до 100 id за вызов.
 * Сбой lookup не ломает экран: имена остаются null.
 */
export class StaffNames {
  private readonly cache = new Map<string, { name: string; at: number }>();
  constructor(
    private readonly client: DomainClient,
    private readonly log: FastifyBaseLogger,
    private readonly ttlMs = 60_000,
  ) {}

  async resolve(ids: Array<string | null | undefined>, auth: StaffAuth): Promise<Map<string, string>> {
    const now = Date.now();
    const out = new Map<string, string>();
    const missing: string[] = [];
    for (const id of new Set(ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)).map((x) => x.toLowerCase()))) {
      const system = SYSTEM_ACTOR_NAMES[id];
      if (system) {
        out.set(id, system);
        continue;
      }
      const hit = this.cache.get(id);
      if (hit && now - hit.at < this.ttlMs) out.set(id, hit.name);
      else missing.push(id);
    }
    if (missing.length === 0) return out;
    try {
      const res = await this.client.get<{ items?: unknown }>("/admin/v1/staff/lookup", {
        actor: auth.actor,
        query: { ids: missing.slice(0, 100).join(",") },
      });
      for (const s of Array.isArray(res?.items) ? (res.items as Partial<StaffSummary>[]) : []) {
        if (typeof s?.staff_id !== "string" || typeof s.display_name !== "string") continue;
        const name = s.display_name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
        if (!name) continue;
        const id = s.staff_id.toLowerCase();
        this.cache.set(id, { name, at: now });
        out.set(id, name);
      }
      if (this.cache.size > 5000) this.cache.clear();
    } catch (err) {
      this.log.warn({ upstream: "admin-identity", err_code: (err as AppError)?.code }, "staff lookup failed, names omitted");
    }
    return out;
  }
}

export interface AuditEntry {
  action: string;
  object_type?: string | null;
  object_id?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
}

/**
 * Аудит действий самого BFF — синхронно в audit. audit принимает от admin-bff только dev.impersonate и auth.logout
 * и только с actor сотрудника в токене (иначе 403 ACTION_NOT_ALLOWED).
 */
export async function writeAudit(
  ctx: BffContext,
  auth: Pick<StaffAuth, "actor" | "publicSessionId">,
  entry: AuditEntry & { action: "dev.impersonate" | "auth.logout" },
  ip: string | undefined,
): Promise<void> {
  await ctx.domains.audit.post("/internal/v1/records", {
    actor: auth.actor,
    body: {
      record_id: randomUUID(),
      occurred_at: new Date(ctx.now()).toISOString(),
      action: entry.action,
      object_type: entry.object_type ?? null,
      object_id: entry.object_id ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      reason: entry.reason ?? null,
      ip: ip ?? null,
      session_id: auth.publicSessionId,
      trace_id: currentContext().traceId,
    },
  });
}
