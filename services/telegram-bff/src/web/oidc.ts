/**
 * «Log In with Telegram» — OpenID Connect, Authorization Code + PKCE S256 (https://core.telegram.org/widgets/login,
 * INTERNAL_API §3): адрес авторизации, обмен `code` на `id_token` (Basic `client_id:client_secret`), проверка `id_token`
 * по JWKS (подпись, `iss`, `aud`, `exp`; кеш ключей 1 ч, обновление при неизвестном `kid` не чаще раза в 30 с).
 *
 * Секрет клиента, `code`, `code_verifier`, `id_token` и Telegram ID наружу не выходят: ошибки — только короткий код
 * причины (OidcFailure.reason) для лога, без значений. Токен бота здесь не используется.
 *
 * Scope: документация Telegram отдаёт Telegram ID (claim `id`) только со scope `profile`; `openid` даёт лишь `sub` —
 * непрозрачный идентификатор, по которому аккаунт TilHero не найти (INTERNAL_API §14 L1, решение «при отсутствии `id` —
 * `openid profile`, профиль не сохраняется»). Имя, username и фото из `id_token` не читаются и нигде не сохраняются;
 * телефон (`phone`) не запрашивается.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, customFetch, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";

/** Запрашиваемые scope (см. заголовок файла). */
export const OIDC_SCOPE = "openid profile";
/** Допустимые алгоритмы подписи `id_token` (BotFather → Login Widget → Advanced: RS256 по умолчанию, ES256, EdDSA).
 *  Симметричные (HS*) и `none` не принимаются никогда. */
export const ID_TOKEN_ALGORITHMS = ["RS256", "ES256", "EdDSA", "Ed25519"];
/** Путь callback на сайте (Caddy web-pay: /api/* → telegram-bff /web/v1/*). */
export const CALLBACK_PATH = "/api/auth/callback";

const b64url = (b: Buffer): string => b.toString("base64url");
const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** Идентификатор попытки входа: base64url(sha256(state)) — ключ в Redis и значение cookie `__Host-wp_oidc`. */
export const flowIdOf = (state: string): string => b64url(sha256(state));
export const FLOW_ID_RE = /^[A-Za-z0-9_-]{43}$/;
export const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
/** `code` Telegram — непрозрачная строка: печатные ASCII без пробела, разумная длина. */
export const CODE_RE = /^[\x21-\x7e]{1,1024}$/;

export interface PkceStart {
  state: string;
  verifier: string;
  challenge: string;
  flowId: string;
}

/** Новая попытка входа: state (256 бит), code_verifier (RFC 7636: 64 символа из [A-Za-z0-9-_]), challenge S256. */
export function newPkce(): PkceStart {
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  return { state, verifier, challenge: b64url(sha256(verifier)), flowId: flowIdOf(state) };
}

/** Сравнение за постоянное время (строки одинаковой длины; разная длина — false без раннего выхода по содержимому). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Неудачный вход: reason — короткий код для лога (без значений токенов и идентификаторов). */
export class OidcFailure extends Error {
  constructor(public readonly reason: string) {
    super(`oidc: ${reason}`);
    this.name = "OidcFailure";
  }
}

export interface OidcOptions {
  /** TELEGRAM_OIDC_BASE (https://oauth.telegram.org; мок — только dev/test). Он же ожидаемый `iss`. */
  base: string;
  clientId: string;
  clientSecret: string;
  /** WEB_PAY_ORIGIN + CALLBACK_PATH */
  redirectUri: string;
  /** таймаут обмена кода и загрузки JWKS, мс (INTERNAL_API §0.3 — 5 с) */
  timeoutMs?: number;
  /** кеш JWKS, мс (1 ч) */
  jwksCacheMs?: number;
  /** не чаще одной перезагрузки JWKS за этот срок при неизвестном `kid`, мс (30 с) */
  jwksCooldownMs?: number;
  fetchImpl?: typeof fetch;
}

const MAX_TOKEN_RESPONSE = 64 * 1024;

export class TelegramOidc {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly o: OidcOptions) {
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.timeoutMs = o.timeoutMs ?? 5000;
    this.jwks = createRemoteJWKSet(new URL(`${o.base}/.well-known/jwks.json`), {
      timeoutDuration: this.timeoutMs,
      cacheMaxAge: o.jwksCacheMs ?? 3_600_000,
      cooldownDuration: o.jwksCooldownMs ?? 30_000,
      [customFetch]: (url, init) => this.fetchImpl(url, init),
    });
  }

  /** Адрес авторизации Telegram: в query только client_id, redirect_uri, response_type, scope, state и PKCE (без ПДн). */
  authorizeUrl(state: string, challenge: string): string {
    const u = new URL(`${this.o.base}/auth`);
    u.search = new URLSearchParams({
      client_id: this.o.clientId,
      redirect_uri: this.o.redirectUri,
      response_type: "code",
      scope: OIDC_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return u.toString();
  }

  /** code → id_token → Telegram ID (claim `id`). Любая неудача — OidcFailure. */
  async login(code: string, verifier: string): Promise<number> {
    const idToken = await this.exchange(code, verifier);
    return this.verify(idToken);
  }

  /** POST {base}/token (x-www-form-urlencoded, Basic client_id:client_secret) → id_token. */
  async exchange(code: string, verifier: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.o.redirectUri,
      client_id: this.o.clientId,
      code_verifier: verifier,
    });
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.o.base}/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`, "utf8").toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: body.toString(),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new OidcFailure("token_unreachable");
    }
    if (resp.status !== 200) {
      await resp.body?.cancel().catch(() => undefined);
      throw new OidcFailure(`token_http_${resp.status}`);
    }
    let parsed: unknown;
    try {
      const text = await resp.text();
      if (text.length > MAX_TOKEN_RESPONSE) throw new Error("too large");
      parsed = JSON.parse(text);
    } catch {
      throw new OidcFailure("token_bad_response");
    }
    const idToken = (parsed as { id_token?: unknown } | null)?.id_token;
    if (typeof idToken !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken)) {
      throw new OidcFailure("token_no_id_token");
    }
    return idToken;
  }

  /** Проверка id_token: подпись по JWKS, iss = base, aud = client_id (ID бота), exp; → Telegram ID. */
  async verify(idToken: string): Promise<number> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.jwks, {
        issuer: this.o.base,
        audience: this.o.clientId,
        algorithms: ID_TOKEN_ALGORITHMS,
        requiredClaims: ["exp"],
        clockTolerance: 5,
      }));
    } catch (err) {
      throw new OidcFailure(verifyReason(err));
    }
    return telegramIdOf(payload);
  }
}

function verifyReason(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return "id_token_expired";
  if (err instanceof joseErrors.JWTClaimValidationFailed) return `id_token_claim_${err.claim}`;
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return "id_token_signature";
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return "id_token_alg";
  if (err instanceof joseErrors.JWKSNoMatchingKey) return "id_token_unknown_kid";
  if (err instanceof joseErrors.JWKSTimeout) return "jwks_timeout";
  if (err instanceof joseErrors.JWKSInvalid || err instanceof joseErrors.JWKSMultipleMatchingKeys) return "jwks_invalid";
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) return "id_token_malformed";
  // ERR_JOSE_GENERIC — JWKS ответил не 200 / не JSON; сетевые сбои загрузки JWKS — не JOSEError
  if (err instanceof joseErrors.JOSEError && err.code !== "ERR_JOSE_GENERIC") {
    return `id_token_${err.code.toLowerCase().replace(/^err_/, "")}`;
  }
  return "jwks_unavailable";
}

/** Telegram ID из claim `id` (число или строка цифр). Нет — вход невозможен (аккаунт TilHero ищется по Telegram ID). */
export function telegramIdOf(payload: JWTPayload): number {
  const raw = (payload as { id?: unknown }).id;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^[1-9][0-9]{0,15}$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new OidcFailure("id_token_no_telegram_id");
}
