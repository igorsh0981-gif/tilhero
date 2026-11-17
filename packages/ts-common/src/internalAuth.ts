/**
 * Внутренний JWT сервис → сервис, v2 (совместим с tilhero_common.internal_auth, ревью спринта 1 / T4).
 *
 * Подпись EdDSA (Ed25519) ЛИЧНЫМ ключом вызывающего сервиса: header.kid = iss = вызывающий сервис,
 * aud — целевой сервис, sub — user_id (только из проверенной сессии), TTL 60 с. Проверка: exp − iat ≤ 120 с,
 * iat не из будущего дальше 30 с (SEC9-01).
 * actor — сотрудник {id, role, name?, permissions[]} — принимается ТОЛЬКО от admin-bff (иначе 403 ACTOR_NOT_ALLOWED).
 * Получатель проверяет подпись открытым ключом конкретного издателя → сервис не может подписаться чужим именем.
 *
 * Ключи:
 *  - stage/prod: INTERNAL_JWT_PRIVATE_KEY (base64url 32-байтного seed) + INTERNAL_JWT_PUBLIC_KEYS
 *    (JSON {issuer: base64url raw 32 байта}); генератор — infra/scripts/gen_internal_keys.py;
 *  - dev/test: seed = HMAC-SHA256(INTERNAL_JWT_SECRET, "tilhero-internal-jwt:" + issuer) — без раздачи ключей.
 *    В stage/prod вывод запрещён (KeyRing.fromConfig с secure=true).
 */
import { createHmac, createPrivateKey, createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { SignJWT, decodeJwt, decodeProtectedHeader, errors as joseErrors, jwtVerify } from "jose";
import { AppError, forbidden, unauthorized } from "./errors.js";

export const INTERNAL_HEADER = "x-internal-token";
export const INTERNAL_ALG = "EdDSA";
/** Издатели, от которых принимается контекст сотрудника (actor). */
export const STAFF_ISSUERS: ReadonlySet<string> = new Set(["admin-bff"]);

export interface Actor {
  id: string;
  role: string;
  permissions: string[];
  name?: string;
}

// ---------------------------------------------------------------- ключи

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function b64urlEncode(raw: Uint8Array): string {
  return Buffer.from(raw).toString("base64url");
}

export function deriveSeed(secret: string, issuer: string): Buffer {
  return createHmac("sha256", secret).update(`tilhero-internal-jwt:${issuer}`).digest();
}

export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

/** Открытый ключ в виде raw 32 байт base64url (формат INTERNAL_JWT_PUBLIC_KEYS). */
export function publicRawB64(key: KeyObject): string {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return b64urlEncode(der.subarray(der.length - 32));
}

export interface KeyRingConfig {
  issuer: string;
  /** base64url seed 32 байта (INTERNAL_JWT_PRIVATE_KEY). */
  privateKey?: string | undefined;
  /** {issuer: base64url raw pub} (INTERNAL_JWT_PUBLIC_KEYS), строка JSON или объект. */
  publicKeys?: string | Record<string, string> | undefined;
  /** INTERNAL_JWT_SECRET — только для dev/test-деривации. */
  secret?: string | undefined;
  /** stage/prod: деривация запрещена, нужен privateKey. */
  secure: boolean;
}

/** Ключи сервиса: свой закрытый (подпись) и открытые ключи издателей (проверка). */
export class KeyRing {
  private readonly derivedCache = new Map<string, KeyObject>();

  constructor(
    readonly issuer: string,
    readonly privateKey: KeyObject,
    private readonly publicKeys: ReadonlyMap<string, KeyObject> = new Map(),
    private readonly derivedSecret: string | null = null,
  ) {}

  static derived(secret: string, issuer: string): KeyRing {
    return new KeyRing(issuer, privateKeyFromSeed(deriveSeed(secret, issuer)), new Map(), secret);
  }

  static fromConfig(c: KeyRingConfig): KeyRing {
    const raw =
      typeof c.publicKeys === "string" ? (c.publicKeys.trim() ? JSON.parse(c.publicKeys) : {}) : (c.publicKeys ?? {});
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("INTERNAL_JWT_PUBLIC_KEYS: ожидается JSON-объект {issuer: key}");
    }
    const publics = new Map<string, KeyObject>();
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== "string") throw new Error(`INTERNAL_JWT_PUBLIC_KEYS.${name}: ожидается строка base64url`);
      publics.set(name, publicKeyFromRaw(b64urlDecode(value)));
    }
    if (c.privateKey) return new KeyRing(c.issuer, privateKeyFromSeed(b64urlDecode(c.privateKey)), publics);
    if (c.secure) throw new Error("INTERNAL_JWT_PRIVATE_KEY is required in stage/prod");
    if (!c.secret) throw new Error("INTERNAL_JWT_SECRET is required for dev key derivation");
    return new KeyRing(c.issuer, privateKeyFromSeed(deriveSeed(c.secret, c.issuer)), publics, c.secret);
  }

  publicKeyFor(issuer: string): KeyObject | undefined {
    const explicit = this.publicKeys.get(issuer);
    if (explicit || this.derivedSecret === null) return explicit;
    let key = this.derivedCache.get(issuer);
    if (!key) {
      key = createPublicKey(privateKeyFromSeed(deriveSeed(this.derivedSecret, issuer)));
      this.derivedCache.set(issuer, key);
    }
    return key;
  }
}

/** key — KeyRing сервиса или dev/test-секрет (ключ издателя выводится из него). */
export type InternalKey = KeyRing | string;

function ringFor(key: InternalKey, issuer: string): KeyRing {
  return typeof key === "string" ? KeyRing.derived(key, issuer) : key;
}

// ---------------------------------------------------------------- токены

export interface InternalTokenOptions {
  issuer: string;
  audience: string;
  subject?: string;
  actor?: Actor;
  ttlSeconds?: number;
}

export async function issueInternalToken(key: InternalKey, opts: InternalTokenOptions): Promise<string> {
  const ring = ringFor(key, opts.issuer);
  if (ring.issuer !== opts.issuer) throw new Error(`key ring of ${ring.issuer} cannot sign as ${opts.issuer}`);
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {};
  if (opts.actor) {
    payload.actor = {
      id: opts.actor.id,
      role: opts.actor.role,
      permissions: [...opts.actor.permissions].sort(),
      ...(opts.actor.name ? { name: opts.actor.name } : {}),
    };
  }
  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: INTERNAL_ALG, typ: "JWT", kid: opts.issuer })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.ttlSeconds ?? 60))
    .setJti(randomUUID().replaceAll("-", ""));
  if (opts.subject) jwt = jwt.setSubject(opts.subject);
  return jwt.sign(ring.privateKey);
}

export interface VerifiedInternal {
  issuer: string;
  subject?: string;
  actor?: Actor;
}

const invalid = () => unauthorized("INTERNAL_TOKEN_INVALID", "Неверный внутренний токен");

/** SEC9-01: срок жизни входящего токена (exp − iat) — не больше; выпуск — 60 с. Как INTERNAL_JWT_MAX_TTL_SECONDS py-common. */
export const INTERNAL_JWT_MAX_TTL_SECONDS = 120;
/** Допуск часов: iat из будущего не дальше (INTERNAL_JWT_CLOCK_SKEW_SECONDS py-common). */
export const INTERNAL_JWT_CLOCK_SKEW_SECONDS = 30;

export interface VerifyInternalOptions {
  maxTtlSeconds?: number;
  clockSkewSeconds?: number;
  /** для тестов */
  now?: () => number;
}

export async function verifyInternalToken(
  token: string,
  key: InternalKey,
  audience: string,
  allowedIssuers?: Set<string>,
  options: VerifyInternalOptions = {},
): Promise<VerifiedInternal> {
  let issuer: string;
  try {
    const header = decodeProtectedHeader(token);
    issuer = String(decodeJwt(token).iss ?? "");
    if (header.alg !== INTERNAL_ALG || !issuer || header.kid !== issuer) throw invalid();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw invalid();
  }
  const ring = typeof key === "string" ? KeyRing.derived(key, issuer) : key;
  const pub = ring.publicKeyFor(issuer);
  if (!pub) throw unauthorized("INTERNAL_TOKEN_UNKNOWN_ISSUER", "Издатель внутреннего токена неизвестен");

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, pub, {
      algorithms: [INTERNAL_ALG],
      audience,
      issuer,
      requiredClaims: ["exp", "iat", "iss", "aud"],
    }));
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw unauthorized("INTERNAL_TOKEN_EXPIRED", "Внутренний токен истёк");
    throw invalid();
  }
  // долгоживущий токен (даже подписанный допустимым вызывающим) и iat из будущего — отклоняются
  const iat = payload.iat;
  const exp = payload.exp;
  const nowS = (options.now ?? (() => Date.now() / 1000))();
  const maxTtl = options.maxTtlSeconds ?? INTERNAL_JWT_MAX_TTL_SECONDS;
  const skew = options.clockSkewSeconds ?? INTERNAL_JWT_CLOCK_SKEW_SECONDS;
  if (
    typeof iat !== "number" || typeof exp !== "number" || !Number.isFinite(iat) || !Number.isFinite(exp) ||
    iat > nowS + skew || exp - iat > maxTtl || exp <= iat
  ) {
    throw invalid();
  }
  if (allowedIssuers && !allowedIssuers.has(issuer)) {
    throw forbidden("CALLER_NOT_ALLOWED", "Сервис не имеет доступа к этому API", { caller: issuer });
  }
  let actor: Actor | undefined;
  const a = payload.actor;
  if (a && typeof a === "object") {
    if (!STAFF_ISSUERS.has(issuer)) {
      throw forbidden("ACTOR_NOT_ALLOWED", "Контекст сотрудника принимается только от admin-bff");
    }
    const o = a as Record<string, unknown>;
    actor = {
      id: String(o.id),
      role: String(o.role),
      permissions: Array.isArray(o.permissions) ? o.permissions.map(String) : [],
      ...(typeof o.name === "string" ? { name: o.name } : {}),
    };
  }
  return { issuer, ...(typeof payload.sub === "string" ? { subject: payload.sub } : {}), ...(actor ? { actor } : {}) };
}
