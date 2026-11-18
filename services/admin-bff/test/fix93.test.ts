/**
 * Исправление 9.3: страница афиши «JSON API» — маппинг проходит в source-registry и обратно; «Проверить»
 * (POST /admin/v1/sources/json-api/preview → provider-gateway json_api:preview): право sources.manage, CSRF, лимит
 * provider-gateway (429 PREVIEW_RATE_LIMITED), нормализация ответа (ссылки только https, коды, границы).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeJsonApiPreview } from "../src/routes/sources.js";
import {
  browser,
  closeRedis,
  fakeSprint4,
  json,
  jsonApiMapping,
  jsonApiPreviewRow,
  loginAs,
  makeHarness,
  SOURCE_ID,
  sourceRow,
  stepUp,
  type Harness,
  type Session,
} from "./helpers.js";

let h: Harness;
let s: Session;
beforeEach(async () => {
  h = await makeHarness();
  fakeSprint4(h.fake);
  s = (await loginAs(h, "operations")).s;
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const PREVIEW = "/admin/v1/sources/json-api/preview";
const GW_PREVIEW = "/internal/v1/providers/ai_web/json_api:preview";
const send = (method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>, headers: Record<string, string> = {}, who: Session = s) =>
  h.app.inject({ method, url, headers: browser(who, headers), ...(payload !== undefined ? { payload } : {}) });

const PAGE = { url: "https://auezov-theatre.kz/ru/afisha", city: "Almaty", category: "culture.theatre", kind: "json_api", priority: "normal", json_api: jsonApiMapping() };
/** страница сохранённого источника (sourceRow: iticket.uz / cdn.iticket.uz) — домены совпадают с реестром */
const previewBody = (p: Record<string, unknown> = {}) => ({
  source_id: SOURCE_ID,
  country_code: "KZ",
  event_domains: ["iticket.uz"],
  media_domains: ["cdn.iticket.uz"],
  city: "Almaty",
  category: "culture.theatre",
  json_api: jsonApiMapping(),
  ...p,
});

describe("9.3: страница «JSON API» в источнике", () => {
  it("PATCH: маппинг уходит в source-registry как есть и возвращается в ответе", async () => {
    const res = await send("PATCH", `/admin/v1/sources/${SOURCE_ID}`, { expected_version: 3, listing_pages: [PAGE], reason: "театр Ауэзова — JSON API" });
    expect(res.statusCode).toBe(200);
    const call = h.fake.callsTo("sourceRegistry", "PATCH", `/internal/v1/sources/${SOURCE_ID}`)[0]!;
    expect((call.body.listing_pages as unknown[])[0]).toEqual(PAGE);
    expect(res.json().listing_pages[0].json_api.url_template).toBe("https://auezov-theatre.kz/ru/afisha/performance/{id}");
  });

  it("GET: json_api из реестра в ответе; у страниц без маппинга поля нет", async () => {
    h.fake.on("sourceRegistry", "GET", `/internal/v1/sources/${SOURCE_ID}`, () =>
      json(200, { ...sourceRow({ listing_pages: [PAGE, { url: "https://iticket.uz/a", city: null, category: null, kind: "html", priority: "normal" }] }), changes: [] }),
    );
    const res = await send("GET", `/admin/v1/sources/${SOURCE_ID}`);
    expect(res.statusCode).toBe(200);
    const [api, html] = res.json().listing_pages;
    expect(api.kind).toBe("json_api");
    expect(api.json_api.fields.hall).toBe("hall.name");
    expect(html.json_api).toBeUndefined();
  });

  it("форма маппинга проверяется до домена: лишний ключ, не путь, max_pages > 5, http — 422 без вызова реестра", async () => {
    for (const bad of [
      { ...jsonApiMapping(), script: "1" },
      jsonApiMapping({ fields: { id: "id", title: "title()", start: "start_time" } }),
      jsonApiMapping({ max_pages: 6 }),
      jsonApiMapping({ url: "http://server.auezov-theatre.kz/performances/" }),
      jsonApiMapping({ url_template: "https://auezov-theatre.kz/ru/afisha/performance/" }),
      jsonApiMapping({ fields: { id: "id", title: "title" } }),
    ]) {
      const res = await send("PATCH", `/admin/v1/sources/${SOURCE_ID}`, { expected_version: 3, listing_pages: [{ ...PAGE, json_api: bad }], reason: "маппинг" });
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
      expect(res.json().code).toBe("VALIDATION_ERROR");
    }
    expect(h.fake.callsTo("sourceRegistry", "PATCH")).toHaveLength(0);
  });
});

describe("9.3: «Проверить» страницу JSON API", () => {
  it("прокси в provider-gateway с actor сотрудника; тело — как в форме", async () => {
    const res = await send("POST", PREVIEW, previewBody());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.events[0]).toMatchObject({ id: "101", title: "Абай", local_time: "18:00", venue: "Театр им. М. Ауэзова — Большой зал" });
    expect(body.keys).toEqual([
      { path: "id", sample: "101" },
      { path: "title.ru", sample: "Абай" },
    ]);
    const call = h.fake.callsTo("providerGateway", "POST", GW_PREVIEW)[0]!;
    const { source_id: _id, ...sent } = previewBody();
    expect(call.body).toEqual(sent);
    expect(call.actor?.permissions).toContain("sources.manage");
    // аудит: кто, источник, хост API, итог
    const audit = h.fake.callsTo("audit", "POST", "/internal/v1/records").map((c) => c.body).find((b) => b.action === "source.json_api.preview")!;
    expect(audit).toMatchObject({ object_type: "source", object_id: SOURCE_ID, after: { host: "server.auezov-theatre.kz", ok: true, code: null, items_total: 2, events: 1 } });
    expect(h.fake.callsTo("audit", "POST", "/internal/v1/records").find((c) => c.body.action === "source.json_api.preview")!.actor?.id).toBeTruthy();
  });

  it("домены: сохранённые — из реестра; другие или новый источник — свежий step-up", async () => {
    const same = await send("POST", PREVIEW, previewBody());
    expect(same.statusCode).toBe(200);
    expect(h.fake.callsTo("providerGateway", "POST", GW_PREVIEW).at(-1)!.body.event_domains).toEqual(["iticket.uz"]);
    for (const body of [previewBody({ event_domains: ["iticket.uz", "evil.example"] }), previewBody({ source_id: undefined })]) {
      const res = await send("POST", PREVIEW, JSON.parse(JSON.stringify(body)));
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("STEP_UP_REQUIRED");
    }
    expect(h.fake.callsTo("providerGateway", "POST", GW_PREVIEW)).toHaveLength(1);
    await stepUp(h, s);
    const fresh = await send("POST", PREVIEW, JSON.parse(JSON.stringify(previewBody({ source_id: undefined, event_domains: ["auezov-theatre.kz"] }))));
    expect(fresh.statusCode).toBe(200);
    expect(h.fake.callsTo("providerGateway", "POST", GW_PREVIEW).at(-1)!.body.event_domains).toEqual(["auezov-theatre.kz"]);
  });

  it("сбой журнала аудита не отнимает результат проверки", async () => {
    h.fake.on("audit", "POST", "/internal/v1/records", () => json(503, { code: "UNAVAILABLE", message: "down", details: {} }));
    const res = await send("POST", PREVIEW, previewBody());
    expect(res.statusCode).toBe(200);
  });

  it("причина blocked_address не раскрывается", async () => {
    h.fake.on("providerGateway", "POST", GW_PREVIEW, () => json(200, jsonApiPreviewRow({ ok: false, code: "SOURCE_FETCH_FAILED", reason: "blocked_address", events: [] })));
    expect((await send("POST", PREVIEW, previewBody())).json().reason).toBe("address_unavailable");
  });

  it("без sources.manage — 403 до вызова provider-gateway", async () => {
    const { s: support } = await loginAs(h, "support");
    const res = await send("POST", PREVIEW, previewBody(), {}, support);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("PERMISSION_DENIED");
    expect(h.fake.callsTo("providerGateway", "POST", GW_PREVIEW)).toHaveLength(0);
  });

  it("без CSRF-токена — 403, provider-gateway не вызывается", async () => {
    const headers = browser(s);
    delete (headers as Record<string, string>)["x-csrf-token"];
    const res = await h.app.inject({ method: "POST", url: PREVIEW, headers, payload: previewBody() });
    expect(res.statusCode).toBe(403);
    expect(h.fake.callsTo("providerGateway", "POST", GW_PREVIEW)).toHaveLength(0);
  });

  it("429 provider-gateway → 429 PREVIEW_RATE_LIMITED {retry_after}; 404 старого gateway → 503 PREVIEW_UNAVAILABLE", async () => {
    h.fake.on("providerGateway", "POST", GW_PREVIEW, () => json(429, { code: "PREVIEW_RATE_LIMITED", message: "slow down", details: { retry_after: 3 } }));
    const limited = await send("POST", PREVIEW, previewBody());
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "PREVIEW_RATE_LIMITED", details: { retry_after: 3 } });
    h.fake.on("providerGateway", "POST", GW_PREVIEW, () => json(404, { code: "NOT_FOUND", message: "no route", details: {} }));
    const old = await send("POST", PREVIEW, previewBody());
    expect(old.statusCode).toBe(503);
    expect(old.json().code).toBe("PREVIEW_UNAVAILABLE");
  });

  it("422 домена (хост вне доменов источника) — как есть", async () => {
    h.fake.on("providerGateway", "POST", GW_PREVIEW, () =>
      json(422, { code: "SOURCE_JSON_API_INVALID", message: "domain", details: { reason: "domain", json_api_field: "url" } }),
    );
    const res = await send("POST", PREVIEW, previewBody({ json_api: jsonApiMapping({ url: "https://api.evil.example/x" }) }));
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("SOURCE_JSON_API_INVALID");
  });

  it("тело проверяется: домен-маска в event_domains, нет маппинга — 422 без вызова", async () => {
    for (const bad of [previewBody({ event_domains: ["*.auezov-theatre.kz"] }), previewBody({ json_api: undefined }), previewBody({ extra: 1 })]) {
      const res = await send("POST", PREVIEW, JSON.parse(JSON.stringify(bad)));
      expect(res.statusCode).toBe(422);
    }
    expect(h.fake.callsTo("providerGateway", "POST", GW_PREVIEW)).toHaveLength(0);
  });

  it("ответ ошибки схемы: ok=false, код и ключи ответа", async () => {
    h.fake.on("providerGateway", "POST", GW_PREVIEW, () =>
      json(200, jsonApiPreviewRow({ ok: false, code: "SOURCE_SCHEMA_MISMATCH", reason: "items_path", events: [], rejected: [], keys_scope: "response", keys: [{ path: "results.0.id", sample: "1" }], skipped: {} })),
    );
    const body = (await send("POST", PREVIEW, previewBody())).json();
    expect(body).toMatchObject({ ok: false, code: "SOURCE_SCHEMA_MISMATCH", reason: "items_path", keys_scope: "response" });
  });

  it("испорченный ответ provider-gateway → 503 UPSTREAM_UNAVAILABLE", async () => {
    h.fake.on("providerGateway", "POST", GW_PREVIEW, () => json(200, { ok: "yes" }));
    const res = await send("POST", PREVIEW, previewBody());
    expect(res.statusCode).toBe(503);
  });
});

describe("normalizeJsonApiPreview", () => {
  it("ссылки только https, коды и границы; лишнее отбрасывается", () => {
    const out = normalizeJsonApiPreview(
      jsonApiPreviewRow({
        code: "bad code",
        events: [
          { ...jsonApiPreviewRow().events[0], url: "javascript:alert(1)" }, // без https-ссылки — не событие
          { ...jsonApiPreviewRow().events[0], image: "http://x/y.jpg", price: { min: "1", max: "2", currency: "KZT" }, title: "x".repeat(301) },
          { ...jsonApiPreviewRow().events[0], image: "data:image/png;base64,AA", local_time: "18:00:00" },
          ...Array.from({ length: 10 }, () => jsonApiPreviewRow().events[0]),
        ],
        keys: [{ path: "a", sample: "x\u0000y".padEnd(100, "z") }, { path: 5, sample: "n" }, ...Array.from({ length: 100 }, (_, i) => ({ path: `k${i}`, sample: "" }))],
        rejected: [{ index: -1, id: "<b>", reason: "Bad Reason!" }],
        skipped: { status_excluded: 2, "bad key": 3, title_missing: -1 },
        extra: "drop me",
      }),
    )!;
    expect(out.code).toBeNull();
    expect(out.events).toHaveLength(5);
    // первое (javascript:) и второе (title > 300) отброшены; у третьего data:-картинка и время не HH:MM — null
    expect(out.events[0]!).toMatchObject({ title: "Абай", image: null, local_time: null });
    expect(out.events[1]!.image).toBe("https://server.auezov-theatre.kz/media/cover-101.jpg");
    expect(out.keys).toHaveLength(80);
    expect(out.keys[0]).toEqual({ path: "a", sample: "x y".padEnd(60, "z").slice(0, 60) });
    expect(out.rejected).toEqual([{ index: 0, id: "<b>", reason: "unknown" }]);
    expect(out.skipped).toEqual({ status_excluded: 2 });
    expect("extra" in out).toBe(false);
    expect(normalizeJsonApiPreview({ ...jsonApiPreviewRow(), request_url: "http://x" })).toBeNull();
    expect(normalizeJsonApiPreview({ ...jsonApiPreviewRow(), checked_at: 5 })).toBeNull();
    expect(normalizeJsonApiPreview(null)).toBeNull();
  });
});
