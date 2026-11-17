import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { SignJWT, decodeProtectedHeader } from "jose";
import {
  AppError,
  buildBase,
  CircuitBreaker,
  currentContext,
  issueInternalToken,
  KeyRing,
  notFound,
  pseudonymize,
  publicRawB64,
  ServiceClient,
  UpstreamError,
  verifyInternalToken,
} from "../src/index.js";

const SECRET = "test-secret-" + "x".repeat(32);
const ROOT = resolve(import.meta.dirname, "../../..");
const PY = resolve(ROOT, ".venv/bin/python");

/** Python-сторона (tilhero_common.internal_auth): код получает sys.argv[1:], печатает результат. */
function py(code: string, ...args: string[]): string {
  const prelude =
    "import sys,json,os\n" +
    "from tilhero_common.internal_auth import *\n" +
    "from tilhero_common.internal_auth import _b64d\n" +
    "from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey\n" +
    "def attempt(fn):\n" +
    "    try:\n        return fn()\n" +
    "    except Exception as e:\n        return 'ERR:' + getattr(e, 'code', type(e).__name__)\n";
  return execFileSync(PY, ["-c", prelude + code, ...args], { encoding: "utf8", cwd: ROOT }).trim();
}

function b64(raw: Uint8Array): string {
  return Buffer.from(raw).toString("base64url");
}

describe("internal JWT v2 (EdDSA, ключ издателя)", { timeout: 30_000 }, () => {
  it("roundtrips, header kid = iss, enforces audience/issuer", async () => {
    const token = await issueInternalToken(SECRET, { issuer: "telegram-bff", audience: "support", subject: "user-1" });
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "EdDSA", kid: "telegram-bff", typ: "JWT" });
    const v = await verifyInternalToken(token, SECRET, "support", new Set(["telegram-bff"]));
    expect(v).toEqual({ issuer: "telegram-bff", subject: "user-1" });
    await expect(verifyInternalToken(token, SECRET, "identity-consent")).rejects.toMatchObject({ status: 401 });
    await expect(verifyInternalToken(token, SECRET, "support", new Set(["admin-bff"]))).rejects.toMatchObject({
      status: 403,
      code: "CALLER_NOT_ALLOWED",
    });
    // другой секрет стенда → другой ключ издателя
    await expect(verifyInternalToken(token, SECRET + "x", "support")).rejects.toMatchObject({ code: "INTERNAL_TOKEN_INVALID" });
  });

  it("actor (with name) only from admin-bff → else 403 ACTOR_NOT_ALLOWED", async () => {
    const actor = { id: "s1", role: "support", name: "Алина", permissions: ["support.reply", "audit.read"] };
    const staff = await issueInternalToken(SECRET, { issuer: "admin-bff", audience: "support", actor });
    expect((await verifyInternalToken(staff, SECRET, "support")).actor).toEqual({ ...actor, permissions: ["audit.read", "support.reply"] });
    const forged = await issueInternalToken(SECRET, { issuer: "telegram-bff", audience: "support", actor });
    await expect(verifyInternalToken(forged, SECRET, "support")).rejects.toMatchObject({ status: 403, code: "ACTOR_NOT_ALLOWED" });
  });

  it("rejects forged kid/iss, HS256 tokens and unknown issuers", async () => {
    const bffKey = KeyRing.derived(SECRET, "telegram-bff").privateKey;
    const now = Math.floor(Date.now() / 1000);
    // подпись ключом telegram-bff от имени admin-bff
    const impersonation = await new SignJWT({ actor: { id: "x", role: "super_admin", permissions: ["*"] } })
      .setProtectedHeader({ alg: "EdDSA", kid: "admin-bff" })
      .setIssuer("admin-bff").setAudience("support").setIssuedAt(now).setExpirationTime(now + 60)
      .sign(bffKey);
    await expect(verifyInternalToken(impersonation, SECRET, "support")).rejects.toMatchObject({ code: "INTERNAL_TOKEN_INVALID" });
    // kid ≠ iss
    const kidMismatch = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: "telegram-bff" })
      .setIssuer("admin-bff").setAudience("support").setIssuedAt(now).setExpirationTime(now + 60)
      .sign(bffKey);
    await expect(verifyInternalToken(kidMismatch, SECRET, "support")).rejects.toMatchObject({ code: "INTERNAL_TOKEN_INVALID" });
    // старый формат v1 (HS256 общим секретом)
    const hs = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: "telegram-bff" })
      .setIssuer("telegram-bff").setAudience("support").setIssuedAt(now).setExpirationTime(now + 60)
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifyInternalToken(hs, SECRET, "support")).rejects.toMatchObject({ code: "INTERNAL_TOKEN_INVALID" });
    // явные ключи без деривации: неизвестный издатель
    const ring = KeyRing.fromConfig({ issuer: "support", privateKey: b64(randomBytes(32)), publicKeys: "{}", secure: true });
    const tok = await issueInternalToken(SECRET, { issuer: "telegram-bff", audience: "support" });
    await expect(verifyInternalToken(tok, ring, "support")).rejects.toMatchObject({ code: "INTERNAL_TOKEN_UNKNOWN_ISSUER" });
    expect(() => KeyRing.fromConfig({ issuer: "telegram-bff", secret: SECRET, secure: true })).toThrow(/PRIVATE_KEY/);
  });

  it("SEC9-01: exp − iat ≤ 120 с, iat обязателен и не из будущего дальше 30 с", async () => {
    const key = KeyRing.derived(SECRET, "telegram-bff").privateKey;
    const now = Math.floor(Date.now() / 1000);
    const sign = (iat: number | undefined, exp: number) => {
      const j = new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "telegram-bff" })
        .setIssuer("telegram-bff").setAudience("support").setExpirationTime(exp);
      return (iat === undefined ? j : j.setIssuedAt(iat)).sign(key);
    };
    // долгоживущий (час, сутки) — даже с верной подписью
    for (const ttl of [121, 3600, 86_400]) {
      await expect(verifyInternalToken(await sign(now, now + ttl), SECRET, "support"))
        .rejects.toMatchObject({ status: 401, code: "INTERNAL_TOKEN_INVALID" });
    }
    expect((await verifyInternalToken(await sign(now, now + 120), SECRET, "support")).issuer).toBe("telegram-bff");
    expect((await verifyInternalToken(await sign(now + 20, now + 80), SECRET, "support")).issuer).toBe("telegram-bff");
    // часы фиксированы (options.now): смена секунды между выпуском и проверкой не даёт ложного успеха
    await expect(verifyInternalToken(await sign(now + 31, now + 90), SECRET, "support", undefined, { now: () => now }))
      .rejects.toMatchObject({ code: "INTERNAL_TOKEN_INVALID" });
    expect((await verifyInternalToken(await sign(now + 30, now + 90), SECRET, "support", undefined, { now: () => now }))
      .issuer).toBe("telegram-bff");
    await expect(verifyInternalToken(await sign(undefined, now + 60), SECRET, "support"))
      .rejects.toMatchObject({ code: "INTERNAL_TOKEN_INVALID" });
    await expect(verifyInternalToken(await sign(now - 100, now - 40), SECRET, "support"))
      .rejects.toMatchObject({ code: "INTERNAL_TOKEN_EXPIRED" });
    // выпуск ts-common — 60 с, проходит; настройка предела
    const issued = await issueInternalToken(SECRET, { issuer: "telegram-bff", audience: "support" });
    expect((await verifyInternalToken(issued, SECRET, "support")).issuer).toBe("telegram-bff");
    await expect(verifyInternalToken(issued, SECRET, "support", undefined, { maxTtlSeconds: 30 }))
      .rejects.toMatchObject({ code: "INTERNAL_TOKEN_INVALID" });
  });

  it("cross-language, dev derivation: Node → Python and Python → Node", async () => {
    const token = await issueInternalToken(SECRET, { issuer: "telegram-bff", audience: "audit", subject: "u-42" });
    expect(
      py("print(verify_token(sys.argv[1], sys.argv[2], audience='audit', allowed_issuers={'telegram-bff'}).subject)", token, SECRET),
    ).toBe("u-42");
    const pyToken = py(
      "print(issue_token(sys.argv[1], issuer='admin-bff', audience='telegram-bff', subject='u-7', " +
        "actor=Actor(id='s1', role='support', permissions=frozenset({'support.reply'}), name='Алина')))",
      SECRET,
    );
    const v = await verifyInternalToken(pyToken, SECRET, "telegram-bff", new Set(["admin-bff"]));
    expect(v).toEqual({ issuer: "admin-bff", subject: "u-7", actor: { id: "s1", role: "support", permissions: ["support.reply"], name: "Алина" } });
    // одинаковая деривация ключей
    expect(py("print(b64e(public_raw(private_from_seed(derive_seed(sys.argv[1], 'telegram-bff')))))", SECRET)).toBe(
      publicRawB64(KeyRing.derived(SECRET, "telegram-bff").privateKey),
    );
  });

  it("cross-language, explicit stage/prod keys (INTERNAL_JWT_PRIVATE_KEY / PUBLIC_KEYS)", async () => {
    const bffSeed = randomBytes(32);
    const bff = KeyRing.fromConfig({ issuer: "telegram-bff", privateKey: b64(bffSeed), secure: true });
    const bffPub = publicRawB64(bff.privateKey);
    const token = await issueInternalToken(bff, { issuer: "telegram-bff", audience: "support", subject: "u-1" });
    const verifyPy =
      "ring = KeyRing('support', private_from_seed(os.urandom(32)), {'telegram-bff': Ed25519PublicKey.from_public_bytes(_b64d(sys.argv[2]))})\n" +
      "print(attempt(lambda: verify_token(sys.argv[1], ring, audience='support').subject))";
    expect(py(verifyPy, token, bffPub)).toBe("u-1");
    // Python не принимает тот же токен, если в его наборе другой ключ telegram-bff
    expect(py(verifyPy, token, b64(randomBytes(32)).slice(0, 43))).toMatch(/^ERR:/);

    // Python (identity-consent со своим ключом) → Node (проверка по INTERNAL_JWT_PUBLIC_KEYS)
    const out = py(
      "seed = os.urandom(32); ring = KeyRing('identity-consent', private_from_seed(seed), {})\n" +
        "print(b64e(public_raw(ring.private_key)) + ' ' + issue_token(ring, issuer='identity-consent', audience='notifications', subject='u-9'))",
    );
    const [pub, pyToken] = out.split(" ") as [string, string];
    const notifications = KeyRing.fromConfig({
      issuer: "notifications",
      privateKey: b64(randomBytes(32)),
      publicKeys: JSON.stringify({ "identity-consent": pub }),
      secure: true,
    });
    expect((await verifyInternalToken(pyToken, notifications, "notifications")).subject).toBe("u-9");

    // подделка kid: Python подписывает ключом identity-consent от имени admin-bff → Node отклоняет
    const forged = py(
      "import jwt,time\nring = KeyRing.derived(sys.argv[1], 'identity-consent'); now = int(time.time())\n" +
        "print(jwt.encode({'iss':'admin-bff','aud':'support','iat':now,'exp':now+60,'actor':{'id':'x','role':'r','permissions':[]}}, ring.private_key, algorithm='EdDSA', headers={'kid':'admin-bff'}))",
      SECRET,
    );
    await expect(verifyInternalToken(forged, SECRET, "support")).rejects.toMatchObject({ code: "INTERNAL_TOKEN_INVALID" });
    // и наоборот: Node-подделка отклоняется Python
    const nodeForged = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: "admin-bff" })
      .setIssuer("admin-bff").setAudience("support").setIssuedAt().setExpirationTime("1m")
      .sign(KeyRing.derived(SECRET, "telegram-bff").privateKey);
    expect(py("print(attempt(lambda: verify_token(sys.argv[1], sys.argv[2], audience='support').issuer))", nodeForged, SECRET)).toBe(
      "ERR:INTERNAL_TOKEN_INVALID",
    );
    // actor от telegram-bff Python тоже отклоняет
    const bffActor = await issueInternalToken(SECRET, { issuer: "telegram-bff", audience: "support", actor: { id: "x", role: "r", permissions: [] } });
    expect(py("print(attempt(lambda: verify_token(sys.argv[1], sys.argv[2], audience='support')))", bffActor, SECRET)).toBe(
      "ERR:ACTOR_NOT_ALLOWED",
    );
  });

  it("pseudonymizes like Python", () => {
    const py2 = execFileSync(PY, ["-c", "from tilhero_common.context import pseudonymize;print(pseudonymize('user-1'))"], {
      encoding: "utf8",
    }).trim();
    expect(pseudonymize("user-1")).toBe(py2);
  });
});

describe("fastify base", () => {
  it("propagates trace id, formats errors, exposes health", async () => {
    const app = await buildBase({ serviceName: "t", version: "0", logLevel: "silent", readiness: async () => ({ redis: "ok" }) });
    app.get("/boom", async () => {
      throw notFound("THING_NOT_FOUND", "Не найдено");
    });
    app.get("/ctx", async () => ({ trace: currentContext().traceId }));
    const r = await app.inject({ url: "/boom", headers: { "x-trace-id": "abc" } });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ code: "THING_NOT_FOUND", message: "Не найдено", trace_id: "abc", details: {} });
    expect(r.headers["x-trace-id"]).toBe("abc");
    const ctx = await app.inject({ url: "/ctx", headers: { "x-trace-id": "zzz" } });
    expect(ctx.json()).toEqual({ trace: "zzz" });
    expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/nope" })).json().code).toBe("NOT_FOUND");
    await app.close();
  });
});

describe("service client", () => {
  it("retries idempotent 5xx, maps errors, opens breaker", async () => {
    let n = 0;
    const fetchImpl = (async (url: URL) => {
      n++;
      if (url.pathname === "/flaky" && n < 3) return new Response("", { status: 503 });
      if (url.pathname === "/missing") return Response.json({ code: "X_NOT_FOUND", message: "nope", details: {} }, { status: 404 });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const c = new ServiceClient({ issuer: "telegram-bff", target: "support", baseUrl: "http://s", secret: SECRET, fetchImpl });
    expect(await c.get("/flaky")).toEqual({ ok: true });
    await expect(c.get("/missing")).rejects.toMatchObject({ status: 404, code: "X_NOT_FOUND" });

    const down = new ServiceClient({
      issuer: "telegram-bff",
      target: "support",
      baseUrl: "http://s",
      secret: SECRET,
      retries: 0,
      breaker: new CircuitBreaker(2, 60_000),
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(down.post("/x", { body: {} })).rejects.toBeInstanceOf(UpstreamError);
    await expect(down.post("/x", { body: {} })).rejects.toBeInstanceOf(AppError);
    await expect(down.post("/x", { body: {} })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
});

describe("fastify base: безопасные умолчания (ревью T4)", () => {
  it("x-trace-id принимается только ^[A-Za-z0-9_-]{1,64}$, иначе генерируется новый", async () => {
    const app = await buildBase({ serviceName: "t", version: "0", logLevel: "silent" });
    app.get("/ctx", async () => ({ trace: currentContext().traceId, corr: currentContext().correlationId }));
    for (const bad of ["a".repeat(65), "evil\nline", "id with space", "<script>"]) {
      const r = await app.inject({ url: "/ctx", headers: { "x-trace-id": bad, "x-correlation-id": bad } });
      expect(r.json().trace).not.toBe(bad);
      expect(r.json().trace).toMatch(/^[0-9a-f]{32}$/);
      expect(r.json().corr).toBe(r.json().trace);
      expect(r.headers["x-trace-id"]).toBe(r.json().trace);
    }
    expect((await app.inject({ url: "/ctx", headers: { "x-trace-id": "Abc_123-x" } })).json().trace).toBe("Abc_123-x");
    await app.close();
  });

  it("trustProxy по умолчанию выключен; число хопов — явно", async () => {
    const plain = await buildBase({ serviceName: "t", version: "0", logLevel: "silent" });
    plain.get("/ip", async (req) => ({ ip: req.ip }));
    const r = await plain.inject({ url: "/ip", remoteAddress: "10.0.0.2", headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(r.json().ip).toBe("10.0.0.2");
    await plain.close();
    const proxied = await buildBase({ serviceName: "t", version: "0", logLevel: "silent", trustProxy: 1 });
    proxied.get("/ip", async (req) => ({ ip: req.ip }));
    const p = await proxied.inject({ url: "/ip", remoteAddress: "10.0.0.2", headers: { "x-forwarded-for": "6.6.6.6, 1.2.3.4" } });
    expect(p.json().ip).toBe("1.2.3.4");
    await proxied.close();
  });

  it("свои redact-пути, formatter и поток логов; Retry-After для 423", async () => {
    const lines: string[] = [];
    const app = await buildBase({
      serviceName: "t",
      version: "0",
      redactPaths: ["secret_field", "nested.token"],
      logFormatter: (o) => ({ ...o, formatted: true }),
      logStream: { write: (m) => lines.push(m) },
    });
    app.get("/log", async (req) => {
      req.log.info({ secret_field: "S3CR3T", nested: { token: "T0K3N", ok: 1 } }, "probe");
      throw new AppError(423, "PIN_LOCKED", "locked", { retry_after: 300 });
    });
    const r = await app.inject({ url: "/log" });
    expect(r.statusCode).toBe(423);
    expect(r.headers["retry-after"]).toBe("300");
    const probe = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "probe");
    expect(probe).toMatchObject({ secret_field: "[redacted]", nested: { token: "[redacted]", ok: 1 }, formatted: true, service: "t" });
    expect(lines.join("")).not.toMatch(/S3CR3T|T0K3N/);
    await app.close();
  });
});

describe("service client: повтор только идемпотентных запросов (ревью T4)", () => {
  it("PUT/DELETE/POST без Idempotency-Key не повторяются; GET и запросы с ключом — повторяются", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      calls.push(`${init.method} ${url.pathname}`);
      return new Response("", { status: 503 });
    }) as unknown as typeof fetch;
    const c = new ServiceClient({ issuer: "telegram-bff", target: "identity-consent", baseUrl: "http://i", key: SECRET, retries: 2, fetchImpl, breaker: new CircuitBreaker(100) });
    for (const m of ["PUT", "DELETE", "POST", "PATCH"]) {
      calls.length = 0;
      await expect(c.request(m, "/internal/v1/me/pin", { body: {} })).rejects.toMatchObject({ status: 503 });
      expect(calls, m).toHaveLength(1);
    }
    calls.length = 0;
    await expect(c.get("/x")).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(3);
    calls.length = 0;
    await expect(c.post("/t", { body: {}, idempotencyKey: "k-123456789" })).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(3);
  });

  it("подписывает EdDSA-токеном издателя (KeyRing)", async () => {
    let token = "";
    const ring = KeyRing.derived(SECRET, "telegram-bff");
    const c = new ServiceClient({
      issuer: "telegram-bff",
      target: "support",
      baseUrl: "http://s",
      key: ring,
      fetchImpl: (async (_u: URL, init: RequestInit) => {
        token = new Headers(init.headers).get("x-internal-token") ?? "";
        return Response.json({ ok: true });
      }) as unknown as typeof fetch,
    });
    await c.get("/x", { subject: "u-1" });
    expect(await verifyInternalToken(token, SECRET, "support", new Set(["telegram-bff"]))).toEqual({ issuer: "telegram-bff", subject: "u-1" });
  });
});
