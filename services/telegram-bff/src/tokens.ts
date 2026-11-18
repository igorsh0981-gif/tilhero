/**
 * Access JWT сессии Mini App: HS256 (SESSION_JWT_SECRET), TTL ACCESS_TTL_SECONDS (15 мин).
 * Claims: sub = аккаунт Telegram (user_id аккаунта), lrn = активный ученик (сам аккаунт или его детский профиль),
 * sid = id сессии (refresh-семейство), pin = true, если код родителя не задан или подтверждён в этой сессии.
 */
import { SignJWT, errors as joseErrors, jwtVerify } from "jose";
import { AppError } from "@tilhero/ts-common";

export const ACCESS_ISSUER = "telegram-bff";
export const ACCESS_AUDIENCE = "telegram-miniapp";

export interface AccessClaims {
  /** sub — аккаунт Telegram: identity-consent /me/*, social, support. */
  accountId: string;
  /** lrn — активный ученик: learning-plan, центр уведомлений, «Что нового». */
  learnerId: string;
  sid: string;
  pin: boolean;
}

const encoder = new TextEncoder();
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const tokenExpired = () => new AppError(401, "TOKEN_EXPIRED", "Срок действия сессии истёк, обновите токен");
export const tokenInvalid = () => new AppError(401, "TOKEN_INVALID", "Недействительный токен сессии");

export class AccessTokens {
  private readonly key: Uint8Array;

  constructor(secret: string, public readonly ttlSeconds: number) {
    this.key = encoder.encode(secret);
  }

  async issue(claims: AccessClaims): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ lrn: claims.learnerId, sid: claims.sid, pin: claims.pin })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ACCESS_ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setSubject(claims.accountId)
      .setIssuedAt(now)
      .setExpirationTime(now + this.ttlSeconds)
      .sign(this.key);
  }

  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: ACCESS_ISSUER,
        audience: ACCESS_AUDIENCE,
        typ: "JWT",
        requiredClaims: ["sub", "exp", "iat"],
        clockTolerance: 5,
      });
      const { sub, lrn, sid, pin } = payload as { sub?: unknown; lrn?: unknown; sid?: unknown; pin?: unknown };
      if (
        typeof sub !== "string" ||
        !ID_RE.test(sub) ||
        typeof lrn !== "string" ||
        !ID_RE.test(lrn) ||
        typeof sid !== "string" ||
        !sid ||
        typeof pin !== "boolean"
      ) {
        throw tokenInvalid();
      }
      return { accountId: sub.toLowerCase(), learnerId: lrn.toLowerCase(), sid, pin };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw tokenExpired();
      if (err instanceof AppError) throw err;
      throw tokenInvalid();
    }
  }
}
