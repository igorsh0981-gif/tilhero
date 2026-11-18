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

export interface BffContext {
  config: Config;
  redis: Redis;
  sessions: SessionStore;
  limiter: RateLimiter;
  domains: Domains;
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
    const p = await this.client.get<Principal>(`/internal/v1/staff/${encodeURIComponent(staffId)}/principal`);
    await this.put(p);
    return p;
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
 * Имена операторов для тикетов (admin-identity GET /admin/v1/staff/lookup) — in-memory кэш 60 с.
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
    for (const id of new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))) {
      const hit = this.cache.get(id);
      if (hit && now - hit.at < this.ttlMs) out.set(id, hit.name);
      else missing.push(id);
    }
    if (missing.length === 0) return out;
    try {
      const res = await this.client.get<{ items: StaffSummary[] }>("/admin/v1/staff/lookup", {
        actor: auth.actor,
        query: { ids: missing.slice(0, 100).join(",") },
      });
      for (const s of res.items ?? []) {
        this.cache.set(s.staff_id, { name: s.display_name, at: now });
        out.set(s.staff_id, s.display_name);
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

/** Аудит действий самого BFF (impersonate, резервная запись logout) — синхронно в audit. */
export async function writeAudit(
  ctx: BffContext,
  auth: StaffAuth,
  entry: AuditEntry,
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
