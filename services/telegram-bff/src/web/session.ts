/**
 * Cookie-сессия сайта оплаты (INTERNAL_API §3): `__Host-wp_session` — JWT HS256 на WEB_SESSION_SECRET
 * (iss telegram-bff, aud web-pay, sub = аккаунт TilHero, jti — id сессии, ath — время входа). Срок — 30 мин скользящий,
 * не дольше 2 ч от входа; выход — jti в список отзыва Redis до конца абсолютного срока. CSRF-токен — HMAC от jti
 * (выдаёт GET /me; одинаков на всю сессию, в т. ч. после продления cookie).
 *
 * Cookie: HttpOnly, Secure, Path=/, без Domain (префикс `__Host-`); сессия — SameSite=Strict, попытка входа
 * `__Host-wp_oidc` — SameSite=Lax (возврат с oauth.telegram.org — межсайтовая навигация верхнего уровня).
 * Telegram ID и id_token в сессии нет.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { SignJWT, errors as joseErrors, jwtVerify } from "jose";
import { AppError } from "@tilhero/ts-common";
import { safeEqual } from "./oidc.js";

export const SESSION_COOKIE = "__Host-wp_session";
export const OIDC_COOKIE = "__Host-wp_oidc";
/** Скользящий срок сессии, с. */
export const SESSION_IDLE_SECONDS = 30 * 60;
/** Абсолютный срок сессии от входа, с. */
export const SESSION_MAX_SECONDS = 2 * 60 * 60;
/** Cookie продлевается, если с выпуска прошло не меньше, с (не на каждый запрос). */
export const SESSION_RENEW_AFTER_SECONDS = 60;
/** Попытка входа (state, code_verifier в Redis и cookie `__Host-wp_oidc`), с. */
export const OIDC_FLOW_SECONDS = 10 * 60;

export const SESSION_ISSUER = "telegram-bff";
export const SESSION_AUDIENCE = "web-pay";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JTI_RE = /^[0-9a-f]{32}$/;

export const sessionExpired = () => new AppError(401, "SESSION_EXPIRED", "Сессия истекла — войдите снова");
export const csrfInvalid = () => new AppError(403, "CSRF_INVALID", "Запрос отклонён: обновите страницу и повторите");

export interface WebSession {
  accountId: string;
  jti: string;
  /** выпуск этой cookie, Unix-секунды */
  iat: number;
  exp: number;
  /** время входа, Unix-секунды */
  ath: number;
}

// ---------------------------------------------------------------- cookies

/** Значения cookie запроса (первое вхождение имени; без декодирования — наши значения base64url/JWT). */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!out.has(name)) out.set(name, part.slice(i + 1).trim());
  }
  return out;
}

/** Set-Cookie с префиксом `__Host-`: Path=/, Secure, HttpOnly, без Domain. maxAge 0 — удалить. */
export function serializeCookie(name: string, value: string, o: { maxAge: number; sameSite: "Strict" | "Lax" }): string {
  return `${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(o.maxAge))}; HttpOnly; Secure; SameSite=${o.sameSite}`;
}

export const clearSessionCookie = () => serializeCookie(SESSION_COOKIE, "", { maxAge: 0, sameSite: "Strict" });
export const clearOidcCookie = () => serializeCookie(OIDC_COOKIE, "", { maxAge: 0, sameSite: "Lax" });

// ---------------------------------------------------------------- sessions

export class WebSessions {
  private readonly key: Uint8Array;
  private readonly csrfKey: Buffer;

  constructor(
    secret: string,
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {
    this.key = new TextEncoder().encode(secret);
    // отдельный ключ CSRF (производный): подпись cookie и CSRF-токен не взаимозаменяемы
    this.csrfKey = createHmac("sha256", secret).update("tilhero:web-pay:csrf:v1").digest();
  }

  private revokedKey(jti: string): string {
    return `${this.prefix}web:revoked:${jti}`;
  }

  /** Новая сессия после входа. */
  issue(accountId: string): Promise<{ token: string; session: WebSession }> {
    const now = Math.floor(Date.now() / 1000);
    return this.sign({ accountId, jti: randomUUID().replaceAll("-", ""), ath: now, iat: now, exp: now + SESSION_IDLE_SECONDS });
  }

  /** Продление cookie (тот же jti и время входа): exp = min(сейчас + 30 мин, вход + 2 ч). */
  renew(s: WebSession): Promise<{ token: string; session: WebSession }> {
    const now = Math.floor(Date.now() / 1000);
    return this.sign({ ...s, iat: now, exp: Math.min(now + SESSION_IDLE_SECONDS, s.ath + SESSION_MAX_SECONDS) });
  }

  /** Нужно ли продлить cookie этим ответом. */
  shouldRenew(s: WebSession): boolean {
    const now = Math.floor(Date.now() / 1000);
    return now - s.iat >= SESSION_RENEW_AFTER_SECONDS && s.exp < s.ath + SESSION_MAX_SECONDS;
  }

  private async sign(s: WebSession): Promise<{ token: string; session: WebSession }> {
    const token = await new SignJWT({ ath: s.ath })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(SESSION_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setSubject(s.accountId)
      .setJti(s.jti)
      .setIssuedAt(s.iat)
      .setExpirationTime(s.exp)
      .sign(this.key);
    return { token, session: s };
  }

  /** Подпись, срок, абсолютный срок и форма claims; иначе 401 SESSION_EXPIRED. Отзыв проверяет вызывающий. */
  async verify(token: string | undefined): Promise<WebSession> {
    if (!token || token.length > 2048) throw sessionExpired();
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: SESSION_ISSUER,
        audience: SESSION_AUDIENCE,
        typ: "JWT",
        requiredClaims: ["sub", "jti", "iat", "exp"],
        clockTolerance: 5,
      });
      const { sub, jti, iat, exp, ath } = payload as Record<string, unknown>;
      const now = Math.floor(Date.now() / 1000);
      if (
        typeof sub !== "string" ||
        !UUID_RE.test(sub) ||
        typeof jti !== "string" ||
        !JTI_RE.test(jti) ||
        typeof iat !== "number" ||
        typeof exp !== "number" ||
        typeof ath !== "number" ||
        !Number.isInteger(ath) ||
        ath > iat ||
        exp > ath + SESSION_MAX_SECONDS ||
        now >= ath + SESSION_MAX_SECONDS
      ) {
        throw sessionExpired();
      }
      return { accountId: sub, jti, iat, exp, ath };
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof joseErrors.JOSEError) throw sessionExpired();
      throw sessionExpired();
    }
  }

  async isRevoked(jti: string): Promise<boolean> {
    return (await this.redis.exists(this.revokedKey(jti))) === 1;
  }

  /** Отзыв сессии (выход, удаление аккаунта): jti — до конца абсолютного срока. */
  async revoke(s: WebSession): Promise<void> {
    const ttl = Math.max(1, s.ath + SESSION_MAX_SECONDS - Math.floor(Date.now() / 1000) + 60);
    await this.redis.set(this.revokedKey(s.jti), "1", "EX", ttl);
  }

  /** CSRF-токен сессии (GET /me → WebMe.csrf_token). */
  csrf(jti: string): string {
    return createHmac("sha256", this.csrfKey).update(jti, "utf8").digest("base64url");
  }

  csrfOk(jti: string, header: string | string[] | undefined): boolean {
    if (typeof header !== "string" || header.length !== 43) return false;
    return safeEqual(header, this.csrf(jti));
  }
}
