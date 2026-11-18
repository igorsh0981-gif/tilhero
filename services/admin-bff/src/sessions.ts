/**
 * Сессии сотрудников в Redis.
 *
 * Идентификатор — непрозрачные 32 случайных байта (base64url, 43 символа) в cookie `__Host-tilhero_admin`.
 * В Redis ключ — sha256(id): дамп Redis не даёт готовых cookie. Данные — HASH (поля пишутся по отдельности,
 * параллельные запросы не затирают друг другу step_up_until/last_seen_at):
 *   <p>sess:<sha256(id)> → {staff_id, session_version, created_at, last_seen_at, step_up_until, csrf_token,
 *                           ip_hash, ua_hash, impersonating}
 * Ротация id (вход, смена пароля, step-up) — атомарный Lua: старая сессия должна существовать (параллельный logout
 * побеждает — новая не создаётся). При step-up прежний id живёт ещё ROTATION_GRACE_MS как «замещённый»
 * (superseded_until, successor): без step-up, без продления; logout по любому из двух id удаляет оба. Так запросы,
 * ушедшие до ответа step-up со старой cookie, не выбрасывают сотрудника на экран входа.
 * Время — миллисекунды epoch. TTL ключа = min(осталось до бездействия, осталось до абсолютного срока) + запас:
 * истёкшую сессию код распознаёт по времени (401 SESSION_EXPIRED), а через запас Redis удаляет её сам.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import type { RoleCode } from "@tilhero/contracts/admin";

export interface SessionData {
  staff_id: string;
  session_version: number;
  created_at: number;
  last_seen_at: number;
  step_up_until: number;
  csrf_token: string;
  ip_hash: string;
  ua_hash: string;
  impersonating: RoleCode | null;
  /** 0 — действующая; иначе id заменён (ротация) и действует до этого момента без step-up и продления. */
  superseded_until: number;
}

const ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** Запас TTL после истечения: в это время запрос получает SESSION_EXPIRED, а не UNAUTHORIZED. */
const GRACE_MS = 10 * 60 * 1000;

/** Обновить поля только существующей и не замещённой сессии (удалённая параллельно сессия не «оживает»). */
const UPDATE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local sup = redis.call('HGET', KEYS[1], 'superseded_until')
if sup and sup ~= '' and sup ~= '0' then return 0 end
for i = 2, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return 1
`;

/**
 * Ротация: KEYS[1] — старый ключ, KEYS[2] — новый; ARGV[1] — TTL новой, ARGV[2] — grace старой (0 → удалить),
 * ARGV[3] — superseded_until старой, далее пары поле/значение новой. Нет старой → 0; уже замещена → 2.
 */
const ROTATE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local sup = redis.call('HGET', KEYS[1], 'superseded_until')
if sup and sup ~= '' and sup ~= '0' then return 2 end
if tonumber(ARGV[2]) > 0 then
  redis.call('HSET', KEYS[1], 'superseded_until', ARGV[3], 'step_up_until', '0', 'successor', KEYS[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  redis.call('DEL', KEYS[1])
end
for i = 4, #ARGV, 2 do redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1]) end
if tonumber(ARGV[2]) > 0 then redis.call('HSET', KEYS[2], 'predecessor', KEYS[1]) end
redis.call('PEXPIRE', KEYS[2], ARGV[1])
return 1
`;

/** Удалить сессию вместе со связанным ротацией id (преемником или ещё живым предшественником). */
const DELETE_LUA = `
local links = redis.call('HMGET', KEYS[1], 'successor', 'predecessor')
redis.call('DEL', KEYS[1])
for _, k in ipairs(links) do if k and k ~= '' then redis.call('DEL', k) end end
return 1
`;

export function newOpaqueId(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Публичный идентификатор сессии для аудита/логов (по нему нельзя восстановить cookie). */
export function publicSessionId(id: string): string {
  return sha256hex(`tilhero-admin-session:${id}`).slice(0, 32);
}

export function isSessionId(value: string | undefined): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

export interface SessionTimes {
  idleMs: number;
  absoluteMs: number;
}

export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly times: SessionTimes,
  ) {}

  private key(id: string): string {
    return `${this.prefix}sess:${sha256hex(id)}`;
  }

  ttlMs(s: Pick<SessionData, "created_at" | "last_seen_at">, now: number): number {
    const left = Math.min(s.last_seen_at + this.times.idleMs, s.created_at + this.times.absoluteMs) - now;
    return Math.max(1000, left + GRACE_MS);
  }

  /** Момент истечения: min(бездействие, абсолютный срок). */
  expiresAt(s: Pick<SessionData, "created_at" | "last_seen_at">): number {
    return Math.min(s.last_seen_at + this.times.idleMs, s.created_at + this.times.absoluteMs);
  }

  async create(data: SessionData): Promise<string> {
    const id = newOpaqueId();
    const k = this.key(id);
    await this.redis.multi().hset(k, encode(data)).pexpire(k, this.ttlMs(data, data.last_seen_at)).exec();
    return id;
  }

  async get(id: string): Promise<SessionData | null> {
    if (!isSessionId(id)) return null;
    const raw = await this.redis.hgetall(this.key(id));
    return decode(raw);
  }

  async update(id: string, patch: Partial<SessionData>, ttlMs: number): Promise<boolean> {
    const args: string[] = [String(Math.max(1000, Math.round(ttlMs)))];
    for (const [k, v] of Object.entries(encode(patch))) args.push(k, v);
    const res = await this.redis.eval(UPDATE_LUA, 1, this.key(id), ...args);
    return res === 1;
  }

  async delete(id: string): Promise<void> {
    if (!isSessionId(id)) return;
    await this.redis.eval(DELETE_LUA, 1, this.key(id));
  }

  /**
   * Новый id с теми же данными (+ patch) — атомарно и только если старая сессия жива и не замещена.
   * "missing" — сессию параллельно завершили (logout/отзыв); "superseded" — id уже заменён ротацией в другой
   * вкладке (новая cookie у браузера есть — запрос надо повторить с ней). graceMs > 0 — старый id ещё graceMs
   * действует без step-up и продления.
   * Защита от фиксации сессии и привязка повышенного доступа (step-up) к новому id.
   */
  async rotate(
    oldId: string,
    data: SessionData,
    patch: Partial<SessionData>,
    now: number,
    graceMs = 0,
  ): Promise<{ id: string; data: SessionData } | "missing" | "superseded"> {
    if (!isSessionId(oldId)) return "missing";
    const next: SessionData = { ...data, ...patch, superseded_until: 0 };
    const id = newOpaqueId();
    const args: string[] = [String(this.ttlMs(next, now)), String(Math.max(0, Math.round(graceMs))), String(now + graceMs)];
    for (const [k, v] of Object.entries(encode(next))) args.push(k, v);
    const res = await this.redis.eval(ROTATE_LUA, 2, this.key(oldId), this.key(id), ...args);
    if (res === 1) return { id, data: next };
    return res === 2 ? "superseded" : "missing";
  }
}

function encode(d: Partial<SessionData>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined) continue;
    out[k] = v === null ? "" : String(v);
  }
  return out;
}

function decode(raw: Record<string, string>): SessionData | null {
  const num = (k: string): number | null => {
    const v = raw[k];
    if (v === undefined || !/^\d+$/.test(v)) return null;
    return Number(v);
  };
  const staff = raw.staff_id;
  const version = num("session_version");
  const created = num("created_at");
  const seen = num("last_seen_at");
  if (!staff || version === null || created === null || seen === null || !raw.csrf_token) return null; // неполная запись
  return {
    staff_id: staff,
    session_version: version,
    created_at: created,
    last_seen_at: seen,
    step_up_until: num("step_up_until") ?? 0,
    csrf_token: raw.csrf_token,
    ip_hash: raw.ip_hash ?? "",
    ua_hash: raw.ua_hash ?? "",
    impersonating: (raw.impersonating || null) as RoleCode | null,
    superseded_until: num("superseded_until") ?? 0,
  };
}
