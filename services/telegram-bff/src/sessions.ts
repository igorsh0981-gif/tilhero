/**
 * Refresh-сессии в Redis.
 *
 * Refresh-токен — непрозрачные 32 случайных байта (base64url). В Redis хранится только sha256 токена:
 *   <p>rt:<sha256>   → {sid, uid, lrn, pin, used?}            TTL = REFRESH_TTL_SECONDS
 *   <p>sid:<sid>     → {uid, lrn, pin, rt: <sha256 текущего>, created_at}
 *   <p>usid:<uid>    → SET sid аккаунта (для отзыва всех сессий)
 * uid — аккаунт Telegram (sub), lrn — активный ученик (по умолчанию сам аккаунт).
 *
 * Ротация при каждом refresh: старый токен помечается used (запись живёт до конца TTL), выдаётся новый.
 * Повторное предъявление использованного токена = утечка/кража → отзывается вся сессия (sid).
 * Access-токен отозванной сессии отклоняется сразу (проверка существования sid при каждом запросе).
 * Смена активного ученика (POST /v1/session/learner) и подтверждение кода родителя — перевыпуск refresh в той же сессии.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

interface RefreshRecord {
  sid: string;
  uid: string;
  lrn?: string;
  pin: boolean;
  used?: boolean;
}

interface SessionRecord {
  uid: string;
  lrn?: string;
  pin: boolean;
  rt: string;
  created_at: number;
}

export type RefreshLookup =
  | { status: "active"; sid: string; userId: string; learnerId: string; pin: boolean }
  | { status: "reused"; sid: string; userId: string }
  | { status: "missing" };

export type RotateResult = { status: "ok"; refreshToken: string } | { status: "reused" | "missing" | "stale" | "revoked" };

export interface NewSession {
  sid: string;
  refreshToken: string;
}

/**
 * Атомарная ротация. KEYS: 1 старый rt, 2 sid, 3 новый rt, 4 usid. ARGV: 1 ttl, 2 хеш нового, 3 pin(1/0), 4 хеш старого,
 * 5 lrn.
 */
const ROTATE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'missing' end
local rec = cjson.decode(raw)
if rec.used then return 'reused' end
local sraw = redis.call('GET', KEYS[2])
if not sraw then return 'revoked' end
local sess = cjson.decode(sraw)
if sess.rt ~= ARGV[4] then return 'stale' end
rec.used = true
redis.call('SET', KEYS[1], cjson.encode(rec), 'KEEPTTL')
local pin = ARGV[3] == '1'
sess.rt = ARGV[2]
sess.pin = pin
sess.lrn = ARGV[5]
redis.call('SET', KEYS[2], cjson.encode(sess), 'EX', ARGV[1])
redis.call('SET', KEYS[3], cjson.encode({sid = rec.sid, uid = rec.uid, lrn = ARGV[5], pin = pin}), 'EX', ARGV[1])
redis.call('EXPIRE', KEYS[4], ARGV[1])
return 'ok'
`;

/**
 * Перевыпуск refresh в сессии. KEYS: 1 sid, 2 новый rt. ARGV: 1 ttl, 2 хеш нового, 3 pin(1/0), 4 префикс rt:,
 * 5 префикс usid:, 6 sid, 7 lrn ("" — оставить прежнего ученика). Ключи старого rt и набора аккаунта вычисляются
 * из записи сессии (один узел Redis). Возвращает активного ученика или false, если сессия отозвана.
 */
const REISSUE_LUA = `
local sraw = redis.call('GET', KEYS[1])
if not sraw then return false end
local sess = cjson.decode(sraw)
local pin = ARGV[3] == '1'
local lrn = ARGV[7]
if lrn == '' then lrn = sess.lrn or sess.uid end
redis.call('DEL', ARGV[4] .. sess.rt)
redis.call('SET', KEYS[2], cjson.encode({sid = ARGV[6], uid = sess.uid, lrn = lrn, pin = pin}), 'EX', ARGV[1])
sess.rt = ARGV[2]
sess.pin = pin
sess.lrn = lrn
redis.call('SET', KEYS[1], cjson.encode(sess), 'EX', ARGV[1])
redis.call('EXPIRE', ARGV[5] .. sess.uid, ARGV[1])
return lrn
`;

/** Отзыв сессии. KEYS: 1 sid. ARGV: 1 префикс rt:, 2 префикс usid:, 3 sid. */
const REVOKE_LUA = `
local sraw = redis.call('GET', KEYS[1])
if not sraw then return 0 end
local sess = cjson.decode(sraw)
redis.call('DEL', KEYS[1])
redis.call('DEL', ARGV[1] .. sess.rt)
redis.call('SREM', ARGV[2] .. sess.uid, ARGV[3])
return 1
`;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Формат refresh-токена: 32 байта в base64url без паддинга. */
const REFRESH_RE = /^[A-Za-z0-9_-]{43}$/;

export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly ttlSeconds: number,
  ) {}

  private rtKey(hash: string) {
    return `${this.prefix}rt:${hash}`;
  }
  private sidKey(sid: string) {
    return `${this.prefix}sid:${sid}`;
  }
  private userKey(uid: string) {
    return `${this.prefix}usid:${uid}`;
  }

  /** Новая сессия аккаунта; активный ученик — сам аккаунт. */
  async create(userId: string, pin: boolean): Promise<NewSession> {
    const sid = randomUUID();
    const refreshToken = newRefreshToken();
    const h = hashToken(refreshToken);
    const rec: RefreshRecord = { sid, uid: userId, lrn: userId, pin };
    const sess: SessionRecord = { uid: userId, lrn: userId, pin, rt: h, created_at: Math.floor(Date.now() / 1000) };
    await this.redis
      .multi()
      .set(this.rtKey(h), JSON.stringify(rec), "EX", this.ttlSeconds)
      .set(this.sidKey(sid), JSON.stringify(sess), "EX", this.ttlSeconds)
      .sadd(this.userKey(userId), sid)
      .expire(this.userKey(userId), this.ttlSeconds)
      .exec();
    return { sid, refreshToken };
  }

  /** Чтение без изменения: позволяет сходить в домены до ротации (сбой домена не «сжигает» токен). */
  async lookup(refreshToken: string): Promise<RefreshLookup> {
    if (!REFRESH_RE.test(refreshToken)) return { status: "missing" };
    const raw = await this.redis.get(this.rtKey(hashToken(refreshToken)));
    if (!raw) return { status: "missing" };
    const rec = JSON.parse(raw) as RefreshRecord;
    if (rec.used) return { status: "reused", sid: rec.sid, userId: rec.uid };
    if (!(await this.isAlive(rec.sid))) return { status: "missing" };
    return { status: "active", sid: rec.sid, userId: rec.uid, learnerId: rec.lrn ?? rec.uid, pin: rec.pin };
  }

  /** Ротация refresh; learnerId — активный ученик после проверки (детский профиль мог исчезнуть → сам аккаунт). */
  async rotate(refreshToken: string, sid: string, userId: string, pin: boolean, learnerId: string): Promise<RotateResult> {
    const oldHash = hashToken(refreshToken);
    const next = newRefreshToken();
    const nextHash = hashToken(next);
    const res = (await this.redis.eval(
      ROTATE_LUA,
      4,
      this.rtKey(oldHash),
      this.sidKey(sid),
      this.rtKey(nextHash),
      this.userKey(userId),
      String(this.ttlSeconds),
      nextHash,
      pin ? "1" : "0",
      oldHash,
      learnerId,
    )) as string;
    if (res === "ok") return { status: "ok", refreshToken: next };
    return { status: res as "reused" | "missing" | "stale" | "revoked" };
  }

  /**
   * Новый refresh-токен в той же сессии: подтверждение кода родителя (pin=true) или смена активного ученика (learnerId).
   * Прежний токен удаляется (не помечается used: его предъявление даёт REFRESH_INVALID без отзыва сессии).
   * Атомарно (Lua): если сессию успели отозвать — null; отозванная параллельно сессия не «оживает».
   */
  async reissue(sid: string, pin: boolean, learnerId?: string): Promise<{ refreshToken: string; learnerId: string } | null> {
    const refreshToken = newRefreshToken();
    const h = hashToken(refreshToken);
    const res = await this.redis.eval(
      REISSUE_LUA,
      2,
      this.sidKey(sid),
      this.rtKey(h),
      String(this.ttlSeconds),
      h,
      pin ? "1" : "0",
      `${this.prefix}rt:`,
      `${this.prefix}usid:`,
      sid,
      learnerId ?? "",
    );
    return typeof res === "string" && res ? { refreshToken, learnerId: res } : null;
  }

  async isAlive(sid: string): Promise<boolean> {
    return (await this.redis.exists(this.sidKey(sid))) === 1;
  }

  /** Активный ученик живой сессии (null — сессия отозвана/истекла). Access-токен с другим lrn устарел: ученика сменили. */
  async activeLearner(sid: string): Promise<string | null> {
    const raw = await this.redis.get(this.sidKey(sid));
    if (!raw) return null;
    const sess = JSON.parse(raw) as SessionRecord;
    return sess.lrn ?? sess.uid;
  }

  /** Атомарный отзыв сессии: sid, её текущий refresh и запись в наборе аккаунта. */
  async revoke(sid: string): Promise<void> {
    await this.redis.eval(REVOKE_LUA, 1, this.sidKey(sid), `${this.prefix}rt:`, `${this.prefix}usid:`, sid);
  }

  /** Отзыв всех сессий аккаунта (смена/сброс кода родителя, запрос удаления). Возвращает число отозванных. */
  async revokeAllForUser(userId: string, exceptSid?: string): Promise<number> {
    const sids = await this.redis.smembers(this.userKey(userId));
    let n = 0;
    for (const sid of sids) {
      if (sid === exceptSid) continue;
      await this.revoke(sid);
      await this.redis.srem(this.userKey(userId), sid); // sid мог истечь по TTL раньше — чистим набор
      n += 1;
    }
    return n;
  }
}
