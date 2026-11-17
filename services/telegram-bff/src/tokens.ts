/**
 * Access JWT сессии Mini App: HS256 (SESSION_JWT_SECRET), TTL ACCESS_TTL_SECONDS (15 мин).
 * Claims: sub = user_id, sid = id сессии (refresh-семейство), pin = true, если PIN не нужен или подтверждён.
 */
import { SignJWT, errors as joseErrors, jwtVerify } from "jose";
import { AppError } from "@tilhero/ts-common";

export const ACCESS_ISSUER = "telegram-bff";
export const ACCESS_AUDIENCE = "telegram-miniapp";

export interface AccessClaims {
  userId: string;
  sid: string;
  pin: boolean;
}

const encoder = new TextEncoder();

export const tokenExpired = () => new AppError(401, "TOKEN_EXPIRED", "Срок действия сессии истёк, обновите токен");
export const tokenInvalid = () => new AppError(401, "TOKEN_INVALID", "Недействительный токен сессии");

export class AccessTokens {
  private readonly key: Uint8Array;

  constructor(secret: string, public readonly ttlSeconds: number) {
    this.key = encoder.encode(secret);
  }

  async issue(claims: AccessClaims): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sid: claims.sid, pin: claims.pin })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ACCESS_ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setSubject(claims.userId)
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
      const { sub, sid, pin } = payload as { sub?: unknown; sid?: unknown; pin?: unknown };
      if (typeof sub !== "string" || !sub || typeof sid !== "string" || !sid || typeof pin !== "boolean") {
        throw tokenInvalid();
      }
      return { userId: sub, sid, pin };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw tokenExpired();
      if (err instanceof AppError) throw err;
      throw tokenInvalid();
    }
  }
}
