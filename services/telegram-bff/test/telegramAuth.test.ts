import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InitDataError, signInitData, validateInitData } from "../src/telegramAuth.js";
import { BOT_TOKEN, TG_USER } from "./helpers.js";

const NOW = 1_780_000_000;
const OPTS = { maxAgeSeconds: 3600, nowSeconds: NOW };

function reason(fn: () => unknown): { reason: string; code: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof InitDataError) return { reason: err.reason, code: err.code };
    throw err;
  }
  throw new Error("expected InitDataError");
}

/** Переподписать набор полей «как Telegram» — для проверок, где подпись верна, а содержимое плохое. */
function signRaw(fields: Array<[string, string]>, token = BOT_TOKEN): string {
  const dcs = [...fields].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", key).update(dcs).digest("hex");
  const p = new URLSearchParams(fields);
  p.append("hash", hash);
  return p.toString();
}

describe("validateInitData", () => {
  const good = signInitData(BOT_TOKEN, { user: { ...TG_USER }, authDate: NOW - 10, queryId: "q1", startParam: "ticket_TCK-3001" });

  it("accepts genuine initData and returns the user", () => {
    const v = validateInitData(good, BOT_TOKEN, OPTS);
    expect(v.user).toEqual({ id: 900001, first_name: "Игорь", username: "test_user_1", language_code: "ru" });
    expect(v.authDate).toBe(NOW - 10);
    expect(v.startParam).toBe("ticket_TCK-3001");
  });

  it("includes extra signed fields (e.g. signature) into the data-check-string", () => {
    const withSig = signInitData(BOT_TOKEN, { user: TG_USER, authDate: NOW, extra: { signature: "abc", chat_type: "private" } });
    expect(validateInitData(withSig, BOT_TOKEN, OPTS).user.id).toBe(900001);
  });

  it("rejects a tampered hash (AT-18)", () => {
    const p = new URLSearchParams(good);
    const h = p.get("hash")!;
    p.set("hash", (h[0] === "a" ? "b" : "a") + h.slice(1));
    expect(reason(() => validateInitData(p.toString(), BOT_TOKEN, OPTS))).toEqual({ reason: "hash_mismatch", code: "INIT_DATA_INVALID" });
  });

  it("rejects a modified field with the original hash (AT-18)", () => {
    const p = new URLSearchParams(good);
    p.set("user", JSON.stringify({ ...TG_USER, id: 900002 }));
    expect(reason(() => validateInitData(p.toString(), BOT_TOKEN, OPTS)).reason).toBe("hash_mismatch");
    const q = new URLSearchParams(good);
    q.set("auth_date", String(NOW));
    expect(reason(() => validateInitData(q.toString(), BOT_TOKEN, OPTS)).reason).toBe("hash_mismatch");
  });

  it("rejects initData signed with another bot token", () => {
    const foreign = signInitData("1:other-bot-token-xxxxxxxxxxxxxxxxxxxxxxxxxx", { user: TG_USER, authDate: NOW });
    expect(reason(() => validateInitData(foreign, BOT_TOKEN, OPTS)).reason).toBe("hash_mismatch");
  });

  it("rejects non-hex / short / missing hash in constant time path", () => {
    const p = new URLSearchParams(good);
    p.set("hash", "zz");
    expect(reason(() => validateInitData(p.toString(), BOT_TOKEN, OPTS)).reason).toBe("hash_mismatch");
    p.set("hash", "g".repeat(64));
    expect(reason(() => validateInitData(p.toString(), BOT_TOKEN, OPTS)).reason).toBe("hash_mismatch");
    p.delete("hash");
    expect(reason(() => validateInitData(p.toString(), BOT_TOKEN, OPTS)).reason).toBe("hash_missing");
  });

  it("rejects expired auth_date with INIT_DATA_EXPIRED", () => {
    const old = signInitData(BOT_TOKEN, { user: TG_USER, authDate: NOW - 3601 });
    expect(reason(() => validateInitData(old, BOT_TOKEN, OPTS))).toEqual({ reason: "expired", code: "INIT_DATA_EXPIRED" });
    const edge = signInitData(BOT_TOKEN, { user: TG_USER, authDate: NOW - 3600 });
    expect(validateInitData(edge, BOT_TOKEN, OPTS).user.id).toBe(900001);
  });

  it("rejects auth_date from the future (> 60 s) but tolerates small skew", () => {
    const future = signInitData(BOT_TOKEN, { user: TG_USER, authDate: NOW + 61 });
    expect(reason(() => validateInitData(future, BOT_TOKEN, OPTS))).toEqual({ reason: "auth_date_in_future", code: "INIT_DATA_INVALID" });
    const skew = signInitData(BOT_TOKEN, { user: TG_USER, authDate: NOW + 30 });
    expect(validateInitData(skew, BOT_TOKEN, OPTS).user.id).toBe(900001);
  });

  it("requires auth_date (signed but absent) and a numeric value", () => {
    const noDate = signRaw([["user", JSON.stringify(TG_USER)]]);
    expect(reason(() => validateInitData(noDate, BOT_TOKEN, OPTS)).reason).toBe("auth_date_missing");
    const zero = signRaw([["auth_date", "abc"], ["user", JSON.stringify(TG_USER)]]);
    expect(reason(() => validateInitData(zero, BOT_TOKEN, OPTS)).reason).toBe("auth_date_invalid");
    // auth_date=0 (дефект GymBot) — проходит подпись, но просрочен
    const epoch = signRaw([["auth_date", "0"], ["user", JSON.stringify(TG_USER)]]);
    expect(reason(() => validateInitData(epoch, BOT_TOKEN, OPTS)).code).toBe("INIT_DATA_EXPIRED");
  });

  it("requires a valid user (signed initData without user → INIT_DATA_INVALID)", () => {
    const noUser = signInitData(BOT_TOKEN, { user: null, authDate: NOW });
    expect(reason(() => validateInitData(noUser, BOT_TOKEN, OPTS))).toEqual({ reason: "user_missing", code: "INIT_DATA_INVALID" });
    for (const bad of ["{", "[]", JSON.stringify({ id: "1", first_name: "A" }), JSON.stringify({ id: 1 }), JSON.stringify({ id: -5, first_name: "A" })]) {
      const raw = signRaw([["auth_date", String(NOW)], ["user", bad]]);
      expect(reason(() => validateInitData(raw, BOT_TOKEN, OPTS)).reason).toBe("user_invalid");
    }
  });

  it("rejects duplicate keys, empty and oversized input", () => {
    expect(reason(() => validateInitData(`${good}&user=${encodeURIComponent("{}")}`, BOT_TOKEN, OPTS)).reason).toBe("duplicate_key");
    expect(reason(() => validateInitData("", BOT_TOKEN, OPTS)).reason).toBe("empty");
    expect(reason(() => validateInitData("a=".padEnd(5000, "x"), BOT_TOKEN, OPTS)).reason).toBe("too_long");
    expect(reason(() => validateInitData("hash=" + "a".repeat(64), BOT_TOKEN, OPTS)).reason).toBe("malformed");
  });

  it("drops unknown user fields and keeps only the whitelisted ones", () => {
    const raw = signInitData(BOT_TOKEN, { user: { ...TG_USER, is_premium: true, photo_url: "https://t.me/x.jpg" }, authDate: NOW });
    expect(Object.keys(validateInitData(raw, BOT_TOKEN, OPTS).user).sort()).toEqual(["first_name", "id", "language_code", "username"]);
  });
});

describe("scripts/dev-init-data.ts", () => {
  it("produces initData accepted by the validator (custom token, start_param, --json)", () => {
    const out = execFileSync(
      "npx",
      ["tsx", "scripts/dev-init-data.ts", "--user-id", "900001", "--name", "Игорь", "--username", "test_user_1", "--start-param", "ticket_TCK-3001", "--json"],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", env: { ...process.env, BOT_TOKEN, NODE_ENV: "development" } },
    );
    const { init_data } = JSON.parse(out) as { init_data: string };
    const v = validateInitData(init_data, BOT_TOKEN, { maxAgeSeconds: 60 });
    expect(v.user).toMatchObject({ id: 900001, first_name: "Игорь", username: "test_user_1", language_code: "ru" });
    expect(v.startParam).toBe("ticket_TCK-3001");
  }, 20_000);
});
