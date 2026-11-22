/**
 * Спринт 8 (INTERNAL_API §0.8): общий фильтр секретов в логах — ключи authorization, sign_string, secret_key, password,
 * key, client_secret, code, code_verifier, id_token. Точные имена полей: составные (`idempotency_key`, `upstream_code`)
 * не трогаются; бизнес-код ошибки в `code` виден.
 */
import { describe, expect, it } from "vitest";
import { AppError, SECRET_LOG_KEYS, buildBase, isSecretLogField, normLogKey, scrubSecrets } from "../src/index.js";

const SECRET = "s3cr3t-value-CANARY";

describe("спринт 8: фильтр секретов в логах", () => {
  it("каталог ключей — как INTERNAL_API §0.8 и py-common", () => {
    expect([...SECRET_LOG_KEYS].sort()).toEqual(
      ["authorization", "sign_string", "secret_key", "password", "key", "client_secret", "code", "code_verifier", "id_token"].sort(),
    );
    expect(normLogKey("clientSecret")).toBe("client_secret");
    expect(normLogKey("X-Code-Verifier")).toBe("x_code_verifier");
    expect(normLogKey("idToken")).toBe("id_token");
    expect(normLogKey("SIGN_STRING")).toBe("sign_string");
  });

  it.each(["authorization", "Authorization", "sign_string", "signString", "secret_key", "secretKey", "password", "key", "KEY", "client_secret", "clientSecret", "code", "code_verifier", "codeVerifier", "id_token", "idToken"])(
    "%s → [redacted] на любой глубине",
    (key) => {
      expect(isSecretLogField(key, SECRET)).toBe(true);
      const out = scrubSecrets({ [key]: SECRET, nested: { list: [{ [key]: SECRET, ok: 1 }] } });
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(out).toMatchObject({ [key]: "[redacted]", nested: { list: [{ [key]: "[redacted]", ok: 1 }] } });
    },
  );

  it.each(["idempotency_key", "dedup_key", "cache_key", "upstream_code", "err_code", "error_code", "keys", "order_no", "state", "provider_txn_id"])(
    "%s — не секрет (точное имя поля)",
    (key) => {
      expect(isSecretLogField(key, "value-1")).toBe(false);
      expect(scrubSecrets({ [key]: "value-1" })).toEqual({ [key]: "value-1" });
    },
  );

  it("code: бизнес-код ошибки виден, одноразовый код OIDC и TOTP — нет; null и boolean не скрываются", () => {
    expect(scrubSecrets({ code: "PAYMENTS_DISABLED", status: 409 })).toEqual({ code: "PAYMENTS_DISABLED", status: 409 });
    for (const c of ["a1b2c3d4-oidc-code", "123456", "Ab_CDEF", "9ZZZ_ZZZ"]) expect(scrubSecrets({ code: c })).toEqual({ code: "[redacted]" });
    expect(scrubSecrets({ key: "PAYMENTS_DISABLED" })).toEqual({ key: "[redacted]" }); // исключение — только для code
    expect(scrubSecrets({ password: null, client_secret: true, key: undefined })).toEqual({ password: null, client_secret: true, key: undefined });
    const err = new Error("boom");
    expect((scrubSecrets({ err }) as { err: Error }).err).toBe(err);
  });

  it("buildBase применяет фильтр ко всем логам, затем formatter сервиса; бизнес-код ошибки в логе обработчика виден", async () => {
    const lines: string[] = [];
    const app = await buildBase({
      serviceName: "t",
      version: "0",
      logFormatter: (o) => ({ ...o, formatted: true }),
      logStream: { write: (m) => lines.push(m) },
    });
    app.post("/cb", async (req) => {
      req.log.info({ body: req.body, idempotency_key: "idem-1", upstream_code: "TIMEOUT" }, "callback");
      throw new AppError(503, "BILLING_UNAVAILABLE", "billing недоступен");
    });
    const r = await app.inject({
      method: "POST",
      url: "/cb",
      payload: { code: "oidc-0ne-t1me", code_verifier: SECRET, client_secret: SECRET, sign_string: SECRET, password: SECRET, id_token: "eyJh.x.y" },
    });
    expect(r.statusCode).toBe(503);
    const raw = lines.join("");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("oidc-0ne-t1me");
    const probe = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "callback");
    expect(probe).toMatchObject({ formatted: true, idempotency_key: "idem-1", upstream_code: "TIMEOUT", body: { code: "[redacted]", id_token: "[redacted]" } });
    const upstream = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "upstream error");
    expect(upstream).toMatchObject({ code: "BILLING_UNAVAILABLE", status: 503 });
    await app.close();
  });
});
