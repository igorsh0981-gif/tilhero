// @vitest-environment node
/**
 * Caddy web-pay на живом процессе (INTERNAL_API §3): заголовки безопасности и CSP на статике и API, SPA-маршруты,
 * кеширование, /api/* → telegram-bff /web/v1/* (query сохраняется, Host сайта и X-Forwarded-For передаются — telegram-bff
 * берёт адрес клиента на глубине 2 и в stage/prod сверяет Host), Server скрыт, Set-Cookie и Location проходят как есть,
 * выйти из /web/v1 обходом пути нельзя.
 *
 * Нужен бинарник Caddy 2.10: CADDY_BIN или `caddy` в PATH (образ CI — как Dockerfile, caddy:2.10.2-alpine); без него
 * тест пропускается с предупреждением.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const CADDY = process.env.CADDY_BIN ?? (spawnSync("caddy", ["version"]).status === 0 ? "caddy" : "");
if (!CADDY) console.warn("web-pay caddy.test: Caddy не найден (CADDY_BIN) — тест заголовков пропущен");

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function get(port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: o.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", fail);
    if (o.body) req.write(o.body);
    req.end();
  });
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe.skipIf(!CADDY)("Caddy web-pay: заголовки и прокси", () => {
  const seen: Seen[] = [];
  let upstream: Server;
  let caddy: ChildProcess;
  let port = 0;
  let dir = "";

  beforeAll(async () => {
    // «telegram-bff»: эхо запроса; ответ — с Server, Set-Cookie и (для /web/v1/auth/start) перенаправлением
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        if (req.url?.startsWith("/web/v1/auth/start")) {
          res.writeHead(302, { location: "https://oauth.telegram.org/auth?client_id=1&state=s", "cache-control": "no-store", server: "fastify" });
          return res.end();
        }
        res.writeHead(200, {
          "content-type": "application/json",
          server: "fastify",
          "set-cookie": "__Host-wp_session=x; Path=/; Max-Age=1800; HttpOnly; Secure; SameSite=Strict",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));

    dir = mkdtempSync(join(tmpdir(), "webpay-caddy-"));
    mkdirSync(join(dir, "srv", "assets"), { recursive: true });
    writeFileSync(join(dir, "srv", "index.html"), "<!doctype html><title>TilHero</title><div id=root></div>");
    writeFileSync(join(dir, "srv", "assets", "index-abc123.js"), "console.log(1)");
    port = await freePort();
    caddy = spawn(CADDY, ["run", "--config", join(root, "Caddyfile"), "--adapter", "caddyfile"], {
      env: {
        ...process.env,
        PORT: String(port),
        BFF_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        WEB_ROOT: join(dir, "srv"),
        XDG_CONFIG_HOME: join(dir, "config"),
        XDG_DATA_HOME: join(dir, "data"),
        HOME: dir,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    caddy.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    for (let i = 0; i < 100; i++) {
      try {
        if ((await get(port, "/healthz")).status === 200) return;
      } catch {
        /* ещё стартует */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`caddy did not start:\n${stderr}`);
  }, 20_000);

  afterAll(async () => {
    caddy?.kill("SIGTERM");
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const expectSecurity = (h: IncomingHttpHeaders) => {
    expect(h["content-security-policy"]).toBe(CSP);
    expect(h["strict-transport-security"]).toBe("max-age=31536000");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["cross-origin-opener-policy"]).toBe("same-origin");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["permissions-policy"]).toMatch(/camera=\(\).*geolocation=\(\).*payment=\(\)/);
    expect(h["server"]).toBeUndefined();
  };

  it("/ и маршруты SPA (/orders/{n}, /buy/{код}) → index.html, все заголовки, Cache-Control no-cache", async () => {
    for (const path of ["/", "/orders/1001", "/buy/plus_30d", "/orders"]) {
      const r = await get(port, path);
      expect(r.status, path).toBe(200);
      expect(r.body).toContain('<div id=root>');
      expect(r.headers["cache-control"]).toBe("no-cache");
      expectSecurity(r.headers);
    }
  });

  it("/assets/*: хэшированный бандл — immutable; нет файла — 404, а не index.html", async () => {
    const js = await get(port, "/assets/index-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expectSecurity(js.headers);
    const missing = await get(port, "/assets/nope.js");
    expect(missing.status).toBe(404);
    expect(missing.body).not.toContain("id=root");
  });

  it("/healthz → ok, no-store", async () => {
    const r = await get(port, "/healthz");
    expect(r.body).toBe("ok");
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("/api/<путь>?q → /web/v1/<путь>?q: Host сайта как есть, X-Forwarded-For дополнен; Server скрыт, Set-Cookie проходит", async () => {
    seen.length = 0;
    const r = await get(port, "/api/orders?cursor=abc%3D", { headers: { host: "pay.tilhero.test", "x-forwarded-for": "198.51.100.7" } });
    expect(r.status).toBe(200);
    expect(r.headers["set-cookie"]).toEqual(["__Host-wp_session=x; Path=/; Max-Age=1800; HttpOnly; Secure; SameSite=Strict"]);
    expect(r.headers["cache-control"]).toContain("no-store");
    expectSecurity(r.headers);
    const s = seen.at(-1)!;
    expect(s.url).toBe("/web/v1/orders?cursor=abc%3D");
    expect(s.headers.host).toBe("pay.tilhero.test");
    // клиент (как его добавил Railway edge), затем адрес того, кто пришёл к Caddy — глубина 2 справа = клиент
    expect(String(s.headers["x-forwarded-for"]).split(",").map((x) => x.trim())).toEqual(["198.51.100.7", "127.0.0.1"]);
  });

  it("POST /api/orders: тело, Origin, X-CSRF-Token, Idempotency-Key, Cookie доходят до telegram-bff", async () => {
    seen.length = 0;
    const body = JSON.stringify({ product_code: "plus_30d", provider: "payme", offer_version: "v1", start_mode: "now" });
    await get(port, "/api/orders", {
      method: "POST",
      body,
      headers: {
        host: "pay.tilhero.test",
        origin: "https://pay.tilhero.test",
        "x-csrf-token": "t".repeat(43),
        "idempotency-key": "6f1c1c3e-1111-4111-8111-111111111111",
        cookie: "__Host-wp_session=abc",
        "content-type": "application/json",
      },
    });
    const s = seen.at(-1)!;
    expect(s.method).toBe("POST");
    expect(s.url).toBe("/web/v1/orders");
    expect(s.body).toBe(body);
    expect(s.headers.origin).toBe("https://pay.tilhero.test");
    expect(s.headers["x-csrf-token"]).toBe("t".repeat(43));
    expect(s.headers["idempotency-key"]).toBe("6f1c1c3e-1111-4111-8111-111111111111");
    expect(s.headers.cookie).toBe("__Host-wp_session=abc");
  });

  it("вход: перенаправление telegram-bff (302 на oauth.telegram.org) проходит без изменений", async () => {
    const r = await get(port, "/api/auth/start");
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("https://oauth.telegram.org/auth?client_id=1&state=s");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("обход пути (../, %2e%2e, %2f) не выводит за /web/v1 — API Mini App через сайт недоступен", async () => {
    seen.length = 0;
    for (const path of ["/api/../v1/session/telegram", "/api/%2e%2e/%2e%2e/v1/me", "/api/..%2f..%2fv1/me", "/v1/me", "/web/v1/me"]) {
      const r = await get(port, path);
      expect([200, 400, 404], path).toContain(r.status);
    }
    for (const s of seen) {
      expect(s.url.startsWith("/web/v1/"), s.url).toBe(true);
      expect(s.url, s.url).not.toMatch(/(^|\/)(\.\.|%2e%2e)(\/|$)/i);
    }
  });

  it("Caddyfile — тот же, что копирует Dockerfile (заголовки — единственный источник для vite preview)", () => {
    expect(readFileSync(join(root, "Dockerfile"), "utf8")).toContain("COPY apps/web-pay/Caddyfile /etc/caddy/Caddyfile");
  });
});
