/**
 * Мок «Log In with Telegram» (OIDC) для тестов /web/v1: настоящий HTTP-сервер на 127.0.0.1 (TELEGRAM_OIDC_BASE в
 * dev/test) — /.well-known/jwks.json и POST /token, как https://core.telegram.org/widgets/login. Страницу /auth
 * изображает approve(): «пользователь подтвердил вход» → адрес возврата на callback с code и state.
 * Все ключи и секреты — заведомо тестовые, генерируются на каждый запуск.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";

export const CLIENT_ID = "7000000001";
// заведомо тестовое значение (не секрет)
export const CLIENT_SECRET = "test-oidc-client-secret-0001";

interface Key {
  kid: string;
  alg: "RS256" | "ES256";
  privateKey: CryptoKey;
  jwk: JWK;
}

interface IssuedCode {
  telegramId: number;
  challenge: string;
  redirectUri: string;
  used: boolean;
}

export interface TokenCall {
  authorization: string | undefined;
  contentType: string | undefined;
  form: Record<string, string>;
}

export type TokenMode = "ok" | "http_400" | "http_500" | "no_id_token" | "not_json" | "hang";

export class MockOidc {
  base = "";
  private server: Server | null = null;
  private keys: Key[] = [];
  readonly codes = new Map<string, IssuedCode>();
  readonly tokenCalls: TokenCall[] = [];
  jwksCalls = 0;
  tokenMode: TokenMode = "ok";
  /** подмена id_token (подделки): получает обычные claims, возвращает строку токена */
  forge: ((claims: Record<string, unknown>) => Promise<string>) | null = null;
  /** отдавать state в redirect (документация этого не обещает — §14 L1) */
  returnState = true;

  async start(): Promise<this> {
    await this.rotate();
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections?.();
  }

  /** Новый ключ подписи (ротация): прежние остаются в JWKS. */
  async rotate(alg: "RS256" | "ES256" = "RS256"): Promise<string> {
    const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
    const kid = `k${this.keys.length + 1}-${randomBytes(3).toString("hex")}`;
    const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
    this.keys.push({ kid, alg, privateKey, jwk });
    return kid;
  }

  get signingKey(): Key {
    return this.keys[this.keys.length - 1]!;
  }

  /** Отдельная пара ключей не из JWKS (подпись «чужим» ключом с тем же kid). */
  async foreignKey(): Promise<CryptoKey> {
    return (await generateKeyPair("RS256")).privateKey;
  }

  /** Обычные claims id_token: iss = base, aud = ID бота, id = Telegram ID (+ профиль — тестовые ПДн). */
  claimsFor(telegramId: number): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: this.base,
      aud: CLIENT_ID,
      sub: "1234123412341234123",
      iat: now,
      exp: now + 3600,
      id: telegramId,
      name: "Test Person Name",
      preferred_username: "secret_tg_username",
      picture: "https://cdn.example.invalid/p.jpg",
    };
  }

  async sign(claims: Record<string, unknown>, o: { key?: CryptoKey; kid?: string; alg?: string } = {}): Promise<string> {
    const k = this.signingKey;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: o.alg ?? k.alg, kid: o.kid ?? k.kid, typ: "JWT" })
      .sign(o.key ?? k.privateKey);
  }

  /**
   * Страница авторизации Telegram: проверяет адрес /auth (параметры BFF) и «подтверждает» вход пользователя
   * telegramId → путь callback сайта (/api/auth/callback?code&state).
   */
  approve(authorizeUrl: string, telegramId: number): { callbackPath: string; code: string; state: string; url: URL } {
    const url = new URL(authorizeUrl);
    if (`${url.origin}${url.pathname}` !== `${this.base}/auth`) throw new Error(`unexpected authorize url ${url.origin}${url.pathname}`);
    const q = url.searchParams;
    if (q.get("client_id") !== CLIENT_ID || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256") {
      throw new Error("bad authorize params");
    }
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, { telegramId, challenge: q.get("code_challenge") ?? "", redirectUri: q.get("redirect_uri") ?? "", used: false });
    const redirect = new URL(q.get("redirect_uri") ?? "");
    redirect.searchParams.set("code", code);
    if (this.returnState) redirect.searchParams.set("state", q.get("state") ?? "");
    return { callbackPath: `${redirect.pathname}${redirect.search}`, code, state: q.get("state") ?? "", url };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/.well-known/jwks.json") {
      this.jwksCalls += 1;
      return send(200, { keys: this.keys.map((k) => k.jwk) });
    }
    if (req.method === "POST" && req.url === "/token") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
      this.tokenCalls.push({ authorization: req.headers.authorization, contentType: req.headers["content-type"], form });
      if (this.tokenMode === "hang") return; // таймаут BFF
      if (this.tokenMode === "http_500") return send(500, { error: "server_error" });
      if (this.tokenMode === "http_400") return send(400, { error: "invalid_grant" });
      if (this.tokenMode === "not_json") return send(200, "<html>oops</html>", "text/html");
      const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
      if (req.headers.authorization !== basic) return send(401, { error: "invalid_client" });
      const issued = this.codes.get(form.code ?? "");
      const verifierOk =
        issued && createHash("sha256").update(form.code_verifier ?? "").digest("base64url") === issued.challenge;
      if (
        form.grant_type !== "authorization_code" ||
        form.client_id !== CLIENT_ID ||
        !issued ||
        issued.used ||
        issued.redirectUri !== form.redirect_uri ||
        !verifierOk
      ) {
        return send(400, { error: "invalid_grant" });
      }
      issued.used = true;
      if (this.tokenMode === "no_id_token") return send(200, { access_token: "at", token_type: "Bearer", expires_in: 3600 });
      const claims = this.claimsFor(issued.telegramId);
      const idToken = this.forge ? await this.forge(claims) : await this.sign(claims);
      return send(200, { access_token: "test-access-token", token_type: "Bearer", expires_in: 3600, id_token: idToken });
    }
    send(404, { error: "not_found" });
  }
}
