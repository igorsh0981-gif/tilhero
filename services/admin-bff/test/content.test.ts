/**
 * Спринт 3 — контент и диагностика через admin-bff (catalog, diagnostics): права и step-up по ролям PLAN спринта 3,
 * имена сотрудников (`*_name`, сид), строгая проверка ответов доменов, проксирование кодов домена, лимиты тела
 * (загрузка аудио 4,5 МБ — только на своём маршруте), выдача аудио, дашборд (блоки content и diagnostics),
 * карточка языковой пары из двух доменов и проверка теста диагностики при публикации пары.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentRow, ContentVersion, Dashboard, PairCard } from "@tilhero/contracts/admin";
import {
  AUTHOR_ID,
  BLOB_ID,
  MP3_BYTES,
  PAYLOAD_HASH,
  REQUEST_ID,
  REVIEWER_ID,
  SEED_ACTOR_ID,
  browser,
  closeRedis,
  contentRowDomain,
  contentVersion,
  diagnosticTestRow,
  domainError,
  json,
  loginAs,
  makeHarness,
  mediaRequest,
  pairCard,
  stepUp,
  versionMeta,
  type Harness,
  type Session,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  h.fake.addStaff({ role: "methodist", staff_id: AUTHOR_ID, display_name: "Мадина Методист" });
  h.fake.addStaff({ role: "methodist", staff_id: REVIEWER_ID, display_name: "Рустам Проверяющий" });
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const get = (s: Session, url: string) => h.app.inject({ url, headers: browser(s) });
const send = (s: Session, method: "POST" | "PUT", url: string, payload: unknown, extra: Record<string, string> = {}) =>
  h.app.inject({ method, url, headers: browser(s, extra), payload: payload as object });

/** Пара без вычисляемых полей — тело PUT language-pairs. */
function pairBody(p: Record<string, unknown> = {}) {
  const { readiness: _r, learners: _l, updated_by: _u, ...pair } = pairCard(p);
  return { ...pair, reason: "запуск пары" };
}

describe("права и step-up (PLAN спринта 3)", () => {
  it("methodist: правит, проверяет и публикует (step-up); прав медиа и решений по заявкам нет", async () => {
    const { s } = await loginAs(h, "methodist");
    expect((await get(s, "/admin/v1/content/lesson")).statusCode).toBe(200);
    expect((await send(s, "POST", "/admin/v1/content/lesson", { payload: { lesson_id: "l-new" } })).statusCode).toBe(201);
    const review = await send(s, "POST", "/admin/v1/content/lesson/l-a1-01-greetings/versions/2/review", {
      decision: "approve",
      note: "Проверено",
      locale_checks: { ru: "checked", uz: "checked" },
    });
    expect(review.statusCode).toBe(200);
    const publish = () => send(s, "POST", "/admin/v1/content/lesson/l-a1-01-greetings/versions/2/publish", { reason: "готово" });
    expect((await publish()).json()).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: "content.publish" } });
    await stepUp(h, s);
    expect((await publish()).statusCode).toBe(200);
    for (const [method, url, body] of [
      ["POST", "/admin/v1/content/media_asset/m-own/versions/1/rights-approve", { note: "Своя запись" }],
      ["POST", `/admin/v1/content/media-requests/${REQUEST_ID}/decide`, { status: "rejected", note: "Нет прав" }],
      ["POST", `/admin/v1/content/media-requests/${REQUEST_ID}/take`, {}],
      ["PUT", "/admin/v1/language-pairs/ru-uz", pairBody({ pair_id: "ru-uz" })],
    ] as const) {
      const res = await send(s, method, url, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code, url).toBe("PERMISSION_DENIED");
    }
    // реестр заявок (ссылка и комментарий ученика) методисту не виден; число новых — в сводке обзора
    expect((await get(s, "/admin/v1/content/media-requests")).json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "media.rights" } });
    expect((await get(s, "/admin/v1/content/summary")).json()).toMatchObject({ new_media_requests: 3 });
    expect(h.fake.callsTo("catalog", "GET", "/admin/v1/content/media-requests")).toHaveLength(0);
  });

  it("content_manager: черновики, права медиа (step-up) и заявки; публикация и проверка — нет", async () => {
    const { staff, s } = await loginAs(h, "content_manager");
    expect((await send(s, "POST", "/admin/v1/content/media_asset", { payload: { asset_id: "m-new" } })).statusCode).toBe(201);
    expect((await send(s, "POST", `/admin/v1/content/media-requests/${REQUEST_ID}/take`, {})).statusCode).toBe(200);
    const decide = () =>
      send(s, "POST", `/admin/v1/content/media-requests/${REQUEST_ID}/decide`, { status: "licensed", note: "Лицензия", linked_asset_id: "m-own" });
    expect((await decide()).json()).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: "media.rights" } });
    const rights = () => send(s, "POST", "/admin/v1/content/media_asset/m-own/versions/1/rights-approve", { note: "Своя запись" });
    expect((await rights()).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    const decided = await decide();
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ status: "licensed", decided_by: staff.staff_id, decided_by_name: staff.display_name });
    expect((await rights()).json()).toMatchObject({ rights_approved_by: staff.staff_id, rights_approved_by_name: staff.display_name });
    for (const [url, perm] of [
      ["/admin/v1/content/lesson/l-1/versions/1/publish", "content.publish"],
      ["/admin/v1/content/lesson/l-1/archive", "content.publish"],
      ["/admin/v1/content/lesson/l-1/versions/1/review", "content.review"],
    ] as const) {
      const res = await send(s, "POST", url, url.endsWith("review") ? { decision: "approve", note: "ok!", locale_checks: { ru: "checked", uz: "checked" } } : { reason: "причина" });
      expect(res.json(), url).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: perm } });
    }
    expect((await get(s, "/admin/v1/content/review-queue")).statusCode).toBe(403);
    expect((await get(s, "/admin/v1/diagnostics/stats")).statusCode).toBe(200); // dashboard.read
  });

  it("analyst / auditor / operations — только чтение контента; read_only — сводки обзора, но не списки", async () => {
    for (const role of ["analyst", "auditor", "operations"] as const) {
      const { s } = await loginAs(h, role);
      expect((await get(s, "/admin/v1/content/scenario")).statusCode, role).toBe(200);
      // реестр заявок учеников — только media.rights (персональные данные: ссылка и комментарий)
      expect((await get(s, "/admin/v1/content/media-requests")).json(), role).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "media.rights" } });
      expect((await get(s, "/admin/v1/language-pairs")).statusCode, role).toBe(200);
      expect((await send(s, "POST", "/admin/v1/content/lesson/l-1/versions/1/submit", {})).json().details.permission, role).toBe("content.edit");
    }
    const ro = await loginAs(h, "read_only");
    expect((await get(ro.s, "/admin/v1/content/summary")).statusCode).toBe(200);
    expect((await get(ro.s, "/admin/v1/content/lesson")).statusCode).toBe(403);
    expect(h.fake.callsTo("catalog", "GET", "/admin/v1/content/scenario")).toHaveLength(3);
    expect(h.fake.callsTo("catalog", "GET", "/admin/v1/content/media-requests")).toHaveLength(0);
    expect(h.fake.callsTo("catalog", "GET", "/admin/v1/content/lesson")).toHaveLength(0);
  });

  it("super_admin: языки и пары — lang.manage + step-up; actor несёт эффективные права", async () => {
    const { staff, s } = await loginAs(h, "super_admin");
    const lang = () => send(s, "PUT", "/admin/v1/languages/kk", { code: "kk", name: { ru: "Казахский", uz: "Qozoq tili", en: "Kazakh" }, script: "Cyrl", variants: [], asr: null, tts: null, limitations: null, status: "planned" });
    expect((await lang()).json()).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: "lang.manage" } });
    await stepUp(h, s);
    const ok = await lang();
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).not.toHaveProperty("updated_by");
    const call = h.fake.callsTo("catalog", "PUT", "/admin/v1/languages/kk")[0]!;
    expect(call.actor).toMatchObject({ id: staff.staff_id, role: "super_admin" });
    expect(call.actor!.permissions).toEqual(expect.arrayContaining(["lang.manage", "content.publish", "media.rights"]));
  });

  it("имперсонация (dev): super_admin, примеривший content_manager, не публикует контент, но подтверждает права медиа", async () => {
    await h.close();
    h = await makeHarness({ ENV: "dev", NODE_ENV: "development" });
    const { s } = await loginAs(h, "super_admin");
    const imp = await h.app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(s), payload: { role: "content_manager" } });
    // спринт 5: + glossary.manage (словарь курса)
    expect(imp.json().permissions).toEqual(["content.edit", "content.read", "dashboard.read", "glossary.manage", "media.rights"]);
    await stepUp(h, s);
    expect((await send(s, "POST", "/admin/v1/content/lesson/l-1/versions/1/publish", { reason: "релиз" })).statusCode).toBe(403);
    expect((await send(s, "POST", "/admin/v1/content/media_asset/m-own/versions/1/rights-approve", { note: "Своя запись" })).statusCode).toBe(200);
    // methodist не может «примерить» content_manager: media.rights у него нет
    const m = await loginAs(h, "methodist");
    const up = await h.app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(m.s), payload: { role: "content_manager" } });
    expect(up.json()).toMatchObject({ code: "IMPERSONATION_NOT_ALLOWED" });
  });
});

describe("версии контента: имена, строгая проверка, коды домена", () => {
  it("список: фильтры передаются, updated_by_name — из lookup, updated_by и имя домена клиенту не уходят", async () => {
    const { s } = await loginAs(h, "methodist");
    const res = await get(s, "/admin/v1/content/lesson?q=greet&status=in_review&level=A1&limit=5&cursor=abc");
    expect(res.statusCode).toBe(200);
    const row = (res.json() as { items: ContentRow[] }).items[0]!;
    expect(row.updated_by_name).toBe("Мадина Методист");
    expect(row).not.toHaveProperty("updated_by");
    expect(h.fake.callsTo("catalog", "GET", "/admin/v1/content/lesson")[0]!.query).toEqual({ q: "greet", status: "in_review", level: "A1", limit: "5", cursor: "abc" });
    // неизвестный вид, статус, полоса — 422 до домена
    for (const url of ["/admin/v1/content/textbook", "/admin/v1/content/lesson?status=deleted", "/admin/v1/content/lesson?level=C1"]) {
      expect((await get(s, url)).statusCode, url).toBe(422);
    }
    expect(h.fake.callsTo("catalog")).toHaveLength(1);
  });

  it("карточка ключа: имена автора, проверяющего, публикатора; автор сида — «Сид (начальное наполнение)»", async () => {
    const { s } = await loginAs(h, "methodist");
    h.fake.on("catalog", "GET", "/admin/v1/content/lesson/l-a1-01-greetings", () =>
      json(200, {
        row: contentRowDomain({ updated_by: SEED_ACTOR_ID }),
        versions: [
          versionMeta({ reviewer_id: REVIEWER_ID, published_by: REVIEWER_ID, author_name: "подделка" }),
          versionMeta({ version: 1, status: "archived", author_id: SEED_ACTOR_ID, reviewer_id: SEED_ACTOR_ID }),
        ],
      }),
    );
    const res = await get(s, "/admin/v1/content/lesson/l-a1-01-greetings");
    expect(res.statusCode).toBe(200);
    const d = res.json() as { row: ContentRow; versions: ContentVersion[] };
    expect(d.row.updated_by_name).toBe("Сид (начальное наполнение)");
    expect(d.versions[0]).toMatchObject({ author_name: "Мадина Методист", reviewer_name: "Рустам Проверяющий", published_by_name: "Рустам Проверяющий" });
    expect(d.versions[1]).toMatchObject({ author_name: "Сид (начальное наполнение)", reviewer_name: "Сид (начальное наполнение)" });
    // сид не ищется в admin-identity
    const lookups = h.fake.callsTo("adminIdentity", "GET", "/admin/v1/staff/lookup");
    expect(lookups.every((c) => !c.query.ids!.includes(SEED_ACTOR_ID))).toBe(true);
  });

  it("версия: payload — объект как есть; служебные поля домена отбрасываются; испорченное → 503", async () => {
    const { s } = await loginAs(h, "methodist");
    const res = await get(s, "/admin/v1/content/scenario/sc-hotel/versions/2");
    expect(res.statusCode).toBe(200);
    const v = res.json() as ContentVersion;
    expect(v.payload).toEqual(contentVersion().payload);
    expect(v).not.toHaveProperty("editors");
    for (const bad of [{ kind: "textbook" }, { payload: [1, 2] }, { payload_hash: "short" }, { status: "deleted" }, { locale_checks: { ru: "ok", uz: "draft" } }, { created_at: "2026-11-18 10:00" }]) {
      h.fake.on("catalog", "GET", "/admin/v1/content/scenario/sc-hotel/versions/2", () => json(200, contentVersion({ kind: "scenario", key: "sc-hotel", ...bad })));
      const r = await get(s, "/admin/v1/content/scenario/sc-hotel/versions/2");
      expect(r.statusCode, JSON.stringify(bad)).toBe(503);
      expect(r.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "catalog" } });
    }
    // тестовый прогон с неизвестным кодом проблемы — тоже испорченный ответ
    h.fake.on("catalog", "GET", "/admin/v1/content/scenario/sc-hotel/versions/2", () =>
      json(200, contentVersion({ kind: "scenario", test_run: { ok: false, checked_at: "2026-11-18T10:00:00Z", issues: [{ code: "WHO_KNOWS", node_id: null, detail: "" }], stats: { nodes: 1, ends: { success: 0, alt_success: 0, fail: 0 }, max_depth: 0, paths_to_success: 0 } } })),
    );
    expect((await get(s, "/admin/v1/content/scenario/sc-hotel/versions/2")).statusCode).toBe(503);
  });

  it("коды домена — как есть: CONTENT_INVALID {errors}, SELF_REVIEW, DRAFT_EXISTS, VERSION_CONFLICT, CONTENT_IN_USE, ROLLBACK_TARGET_INVALID", async () => {
    const { s } = await loginAs(h, "methodist");
    await stepUp(h, s);
    const errors = [{ path: "payload.title.uz", code: "LOCALE_MISSING", message: "Пустой перевод" }, { path: "payload.control_items", code: "NO_CONTROL_ITEMS", message: "< 3" }];
    const cases: Array<[string, "POST" | "PUT", string, unknown, Response, number, string, Record<string, unknown>]> = [
      ["submit", "POST", "/admin/v1/content/lesson/l-1/versions/2/submit", {}, domainError(422, "CONTENT_INVALID", { errors }), 422, "CONTENT_INVALID", { errors }],
      [
        "review",
        "POST",
        "/admin/v1/content/lesson/l-1/versions/2/review",
        { decision: "approve", note: "Свою?", locale_checks: { ru: "checked", uz: "checked" } },
        domainError(409, "SELF_REVIEW"),
        409,
        "SELF_REVIEW",
        {},
      ],
      ["new", "POST", "/admin/v1/content/lesson/l-1/versions", { from_version: 1 }, domainError(409, "DRAFT_EXISTS", { version: 3 }), 409, "DRAFT_EXISTS", { version: 3 }],
      [
        "put",
        "PUT",
        "/admin/v1/content/lesson/l-1/versions/3",
        { payload: { lesson_id: "l-1" }, expected_hash: PAYLOAD_HASH },
        domainError(409, "VERSION_CONFLICT", { payload_hash: "c".repeat(64) }),
        409,
        "VERSION_CONFLICT",
        { payload_hash: "c".repeat(64) },
      ],
      ["archive", "POST", "/admin/v1/content/skill/en.func.greet/archive", { reason: "устарел" }, domainError(409, "CONTENT_IN_USE", { refs: [{ kind: "lesson", key: "l-1" }] }), 409, "CONTENT_IN_USE", { refs: [{ kind: "lesson", key: "l-1" }] }],
      ["rollback", "POST", "/admin/v1/content/lesson/l-1/rollback", { to_version: 9, reason: "откат" }, domainError(409, "ROLLBACK_TARGET_INVALID"), 409, "ROLLBACK_TARGET_INVALID", {}],
      ["publish", "POST", "/admin/v1/content/scenario/sc-1/versions/2/publish", { reason: "релиз" }, domainError(422, "CONTENT_INVALID", { errors: [{ path: "test_run", code: "SCENARIO_TEST_FAILED", message: "нет зелёного прогона" }] }), 422, "CONTENT_INVALID", {}],
    ];
    for (const [name, method, url, body, resp, status, code, details] of cases) {
      h.fake.on("catalog", method, url, () => resp.clone());
      const r = await send(s, method, url, body);
      expect(r.statusCode, name).toBe(status);
      expect(r.json(), name).toMatchObject({ code, details });
    }
  });

  it("вход проверяется до домена: ключ, версия, отметки, хеш, лишнее поле, payload не объект → 422", async () => {
    const { s } = await loginAs(h, "methodist");
    const bad: Array<["POST" | "PUT", string, unknown]> = [
      ["POST", "/admin/v1/content/lesson/L-UPPER/versions/2/submit", {}],
      ["POST", "/admin/v1/content/lesson/l-1/versions/0/submit", {}],
      ["POST", "/admin/v1/content/lesson/l-1/versions/2/submit", { extra: 1 }],
      ["POST", "/admin/v1/content/lesson/l-1/versions/2/review", { decision: "approve", note: "ок", locale_checks: { ru: "checked", uz: "checked" } }],
      ["POST", "/admin/v1/content/lesson/l-1/versions/2/review", { decision: "approve", note: "Проверено", locale_checks: { ru: "yes", uz: "checked" } }],
      ["PUT", "/admin/v1/content/lesson/l-1/versions/2", { payload: { a: 1 }, expected_hash: "XYZ" }],
      ["POST", "/admin/v1/content/lesson", { payload: [1, 2] }],
      ["POST", "/admin/v1/content/lesson", { payload: {}, author_id: AUTHOR_ID }],
      ["POST", "/admin/v1/content/lesson/l-1/versions", { from_version: "1" }],
    ];
    for (const [method, url, body] of bad) {
      const r = await send(s, method, url, body);
      expect(r.statusCode, `${url} ${JSON.stringify(body)}`).toBe(422);
    }
    expect(h.fake.callsTo("catalog")).toHaveLength(0);
  });

  it("review-queue (content.review) и тестовый прогон сценария; test-run для другого вида — 404 маршрута", async () => {
    const { s } = await loginAs(h, "methodist");
    const q = await get(s, "/admin/v1/content/review-queue?kind=scenario");
    expect(q.statusCode).toBe(200);
    expect((q.json() as { items: ContentRow[] }).items[0]).toMatchObject({ latest_status: "in_review", updated_by_name: "Мадина Методист" });
    expect(h.fake.callsTo("catalog", "GET", "/admin/v1/content/review-queue")[0]!.query).toEqual({ kind: "scenario" });
    const run = await send(s, "POST", "/admin/v1/content/scenario/sc-hotel/versions/2/test-run", {});
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ ok: false, issues: [{ code: "DEAD_END", node_id: "n4" }] });
    expect((await send(s, "POST", "/admin/v1/content/lesson/l-1/versions/2/test-run", {})).statusCode).toBe(404);
    expect((await send(s, "POST", "/admin/v1/content/lesson/l-1/versions/2/rights-approve", { note: "права" })).statusCode).toBe(404);
  });

  it("сухая проверка → {ok, errors}; Idempotency-Key публикации пробрасывается, повтор домена — Idempotent-Replayed", async () => {
    const { s } = await loginAs(h, "methodist");
    const v = await send(s, "POST", "/admin/v1/content/lesson/l-1/versions/2/validate", {});
    expect(v.json()).toEqual({ ok: false, errors: [{ path: "payload.title.uz", code: "LOCALE_MISSING", message: "Пустой перевод" }] });
    await stepUp(h, s);
    h.fake.on("catalog", "POST", "/admin/v1/content/lesson/l-1/versions/2/publish", () =>
      json(200, contentVersion({ key: "l-1", status: "published", published_by: AUTHOR_ID }), { "idempotent-replayed": "true" }),
    );
    const r = await send(s, "POST", "/admin/v1/content/lesson/l-1/versions/2/publish", { reason: "релиз" }, { "idempotency-key": "publish-l1-v2-0001" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["idempotent-replayed"]).toBe("true");
    expect(r.json()).toMatchObject({ status: "published", published_by_name: "Мадина Методист" });
    expect(h.fake.callsTo("catalog", "POST", "/admin/v1/content/lesson/l-1/versions/2/publish")[0]!.headers["idempotency-key"]).toBe("publish-l1-v2-0001");
  });
});

describe("аудио: загрузка (тело ≤ 4,5 МБ только здесь) и предпросмотр", () => {
  const upload = (s: Session, data: string, extra: Record<string, unknown> = {}) =>
    send(s, "POST", "/admin/v1/content/blobs", { filename: "scene.mp3", content_type: "audio/mpeg", data_base64: data, ...extra });

  it("файл 3 МБ (base64 ≈ 4,2 МБ) проходит в catalog; тело > 4,5 МБ → 413 без вызова домена", async () => {
    const { s } = await loginAs(h, "content_manager");
    const three = Buffer.alloc(3 * 1024 * 1024, 7);
    three.write("ID3");
    const ok = await upload(s, three.toString("base64"));
    expect(ok.statusCode, ok.body.slice(0, 200)).toBe(201);
    expect(ok.json()).toMatchObject({ blob_id: BLOB_ID, content_type: "audio/mpeg" });
    const call = h.fake.callsTo("catalog", "POST", "/admin/v1/content/blobs")[0]!;
    expect(call.body.data_base64.length).toBe(4_194_304);
    const huge = await upload(s, Buffer.alloc(3_400_000, 7).toString("base64"));
    expect(huge.statusCode).toBe(413);
    expect(huge.json().code).toBe("PAYLOAD_TOO_LARGE");
    expect(h.fake.callsTo("catalog", "POST", "/admin/v1/content/blobs")).toHaveLength(1);
    // повтор того же файла — 200 домена (sha256) сохраняется
    h.fake.on("catalog", "POST", "/admin/v1/content/blobs", () => json(200, { blob_id: BLOB_ID, content_type: "audio/mpeg", size: 64, sha256: "b".repeat(64), created_at: "2026-11-18T10:00:00Z" }));
    expect((await upload(s, MP3_BYTES.toString("base64"))).statusCode).toBe(200);
  });

  it("большие тела — только на загрузке: другие команды > 64 КБ → 413; черновик версии — до 256 КБ", async () => {
    const { s } = await loginAs(h, "methodist");
    const note = "я".repeat(40_000); // ~80 КБ в UTF-8
    const r = await send(s, "POST", "/admin/v1/content/lesson/l-1/versions/2/review", { decision: "return", note, locale_checks: { ru: "draft", uz: "draft" } });
    expect(r.statusCode).toBe(413);
    const big = { lesson_id: "l-1", key_words: Array.from({ length: 400 }, (_, i) => ({ en: `word ${i}`, gloss: { ru: "слово ".repeat(20), uz: "soʻz ".repeat(20) } })) };
    const size = Buffer.byteLength(JSON.stringify({ payload: big, expected_hash: PAYLOAD_HASH }));
    expect(size).toBeGreaterThan(100_000);
    expect(size).toBeLessThan(256 * 1024);
    expect((await send(s, "PUT", "/admin/v1/content/lesson/l-1/versions/2", { payload: big, expected_hash: PAYLOAD_HASH })).statusCode).toBe(200);
    const huge = { ...big, key_words: [...big.key_words, ...big.key_words, ...big.key_words] };
    expect((await send(s, "POST", "/admin/v1/content/lesson", { payload: huge })).statusCode).toBe(413);
  });

  it("тип, кодировка и лишние поля — 422 до домена; AUDIO_INVALID {reason} домена — как есть", async () => {
    const { s } = await loginAs(h, "content_manager");
    for (const extra of [{ content_type: "audio/wav" }, { content_type: "text/html" }, { data_base64: "not base64!" }, { filename: "" }, { path: "/etc/passwd" }]) {
      expect((await upload(s, MP3_BYTES.toString("base64"), extra)).statusCode, JSON.stringify(extra)).toBe(422);
    }
    expect(h.fake.callsTo("catalog")).toHaveLength(0);
    h.fake.on("catalog", "POST", "/admin/v1/content/blobs", () => domainError(422, "AUDIO_INVALID", { reason: "signature" }));
    const r = await upload(s, Buffer.from("OggS but not really").toString("base64"));
    expect(r.json()).toMatchObject({ code: "AUDIO_INVALID", details: { reason: "signature" } });
  });

  it("предпросмотр: байты с типом аудио, no-store и nosniff; не аудио, пусто или > 3 МБ от домена → 503; 404 — как есть", async () => {
    const { s } = await loginAs(h, "analyst");
    const res = await get(s, `/admin/v1/content/blobs/${BLOB_ID}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mpeg");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.rawPayload.equals(MP3_BYTES)).toBe(true);
    const path = `/admin/v1/content/blobs/${BLOB_ID}`;
    for (const resp of [
      () => new Response("<script>alert(1)</script>", { status: 200, headers: { "content-type": "text/html" } }),
      () => new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "audio/ogg" } }),
      () => new Response(new Uint8Array(3 * 1024 * 1024 + 1), { status: 200, headers: { "content-type": "audio/mp4" } }),
    ]) {
      h.fake.on("catalog", "GET", path, resp);
      const r = await get(s, `/admin/v1/content/blobs/${BLOB_ID}`);
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "catalog" } });
      expect(r.body).not.toContain("script");
    }
    h.fake.on("catalog", "GET", path, () => new Response(new Uint8Array(MP3_BYTES), { status: 200, headers: { "content-type": "audio/ogg; codecs=opus" } }));
    expect((await get(s, path)).headers["content-type"]).toBe("audio/ogg");
    h.fake.on("catalog", "GET", path, () => domainError(404, "BLOB_NOT_FOUND"));
    expect((await get(s, path)).json().code).toBe("BLOB_NOT_FOUND");
    expect((await get(s, "/admin/v1/content/blobs/not-a-uuid")).statusCode).toBe(422);
  });
});

describe("заявки учеников на песни и фильмы", () => {
  it("список: текст ученика очищен, ссылка — только текстом, decided_by_name из lookup, обезличенная заявка (user_id null)", async () => {
    const { s } = await loginAs(h, "content_manager");
    h.fake.on("catalog", "GET", "/admin/v1/content/media-requests", () =>
      json(200, {
        items: [
          mediaRequest({ title: "Imagine‮\u0000 (live)", status: "licensed", decided_by: REVIEWER_ID, decided_at: "2026-11-18T11:00:00Z", decided_by_name: "подделка" }),
          mediaRequest({ request_id: "6f0d5a7b-8c9e-4f1a-8b2c-4d5e6f7a8b92", user_id: null, link: null, comment: null }),
        ],
        next_cursor: "c2",
      }),
    );
    const res = await get(s, "/admin/v1/content/media-requests?status=licensed&q=imagine&limit=2");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items[0]).toMatchObject({ title: "Imagine (live)", decided_by_name: "Рустам Проверяющий", link: "https://example.com/song", comment: "Хочу разобрать\nприпев" });
    expect(body.items[1]).toMatchObject({ user_id: null, link: null, comment: null });
    expect(body.next_cursor).toBe("c2");
    expect(h.fake.callsTo("catalog", "GET", "/admin/v1/content/media-requests")[0]!.query).toEqual({ status: "licensed", q: "imagine", limit: "2" });
    expect((await get(s, "/admin/v1/content/media-requests?status=done")).statusCode).toBe(422);
  });

  it("решение: статус из перечня, заметка 3..500, повторное решение — 409 домена как есть", async () => {
    const { s } = await loginAs(h, "content_manager");
    await stepUp(h, s);
    const url = `/admin/v1/content/media-requests/${REQUEST_ID}/decide`;
    for (const body of [{ status: "new", note: "Нельзя" }, { status: "rejected", note: "no" }, { status: "rejected", note: "x".repeat(501) }, { status: "licensed", note: "Да", linked_asset_id: "../etc" }]) {
      expect((await send(s, "POST", url, body)).statusCode, JSON.stringify(body)).toBe(422);
    }
    h.fake.on("catalog", "POST", url, () => domainError(409, "MEDIA_REQUEST_DECIDED", { status: "rejected" }));
    expect((await send(s, "POST", url, { status: "rejected", note: "Нет прав" })).json()).toMatchObject({ code: "MEDIA_REQUEST_DECIDED", details: { status: "rejected" } });
    h.fake.on("catalog", "POST", url, () => domainError(422, "LINKED_ASSET_REQUIRED"));
    expect((await send(s, "POST", url, { status: "licensed", note: "Есть лицензия" })).json().code).toBe("LINKED_ASSET_REQUIRED");
  });
});

describe("дашборд: блоки content и diagnostics", () => {
  it("6 независимых блоков: content — сводка catalog без period, diagnostics — статистика с period", async () => {
    const { s } = await loginAs(h, "read_only");
    const res = await get(s, "/admin/v1/dashboard?period=7d");
    expect(res.statusCode).toBe(200);
    const d = res.json() as Dashboard;
    expect(d.content).toMatchObject({ available: true, data: { in_review: 8, suspended_media: 1, new_media_requests: 3 } });
    expect(d.content.data?.by_kind.media_exercise).toEqual({ published: 1, drafts: 2, in_review: 1 });
    expect(d.content.data?.rights_expiring[0]).toMatchObject({ asset_id: "m-own-coffee-order", valid_to: "2026-11-30" });
    expect(d.diagnostics).toMatchObject({ available: true, data: { period: "7d", finished: 7, not_assessed_pct: { listening: 28.6 } } });
    expect(h.fake.callsTo("catalog", "GET", "/admin/v1/content/summary")[0]!.query).toEqual({});
    expect(h.fake.callsTo("diagnostics", "GET", "/admin/v1/diagnostics/stats")[0]!.query).toEqual({ period: "7d" });
  });

  it("catalog недоступен, diagnostics отдал мусор (процент > 100) → available=false; остальные блоки на месте", async () => {
    const { s } = await loginAs(h, "read_only");
    h.fake.down.add("catalog");
    h.fake.on("diagnostics", "GET", "/admin/v1/diagnostics/stats", () =>
      json(200, { period: "today", started: 1, finished: 1, median_minutes: null, by_level: { A0: 0, A1: 1, A2: 0, B1: 0, B2: 0, none: 0 }, not_assessed_pct: { vocabulary: 150, grammar: 0, reading: 0, listening: 0 }, followups: 0 }),
    );
    const d = (await get(s, "/admin/v1/dashboard")).json() as Dashboard;
    expect(d.content).toEqual({ available: false, data: null, service: "catalog" });
    expect(d.diagnostics).toEqual({ available: false, data: null, service: "diagnostics" });
    for (const b of [d.learners, d.support, d.whats_new, d.campaigns]) expect(b.available).toBe(true);
    // сводка как отдельный маршрут — по тем же правилам (dashboard.read | content.read)
    h.fake.down.delete("catalog");
    h.fake.on("catalog", "GET", "/admin/v1/content/summary", () => json(200, { by_kind: {}, in_review: 0, rights_expiring: [], suspended_media: 0, new_media_requests: 0 }));
    expect((await get(s, "/admin/v1/content/summary")).statusCode).toBe(503);
  });
});

describe("языковые пары: карточка из catalog и diagnostics, публикация пары", () => {
  it("diagnostic_test и learners — из diagnostics (взрослый тест приоритетнее детского); у пары без теста — null и 0", async () => {
    const { s } = await loginAs(h, "methodist");
    const res = await get(s, "/admin/v1/language-pairs");
    expect(res.statusCode).toBe(200);
    const [ruEn, ruUz] = (res.json() as { items: PairCard[] }).items;
    expect(ruEn!.readiness.diagnostic_test).toBe("dx-en-adult@1");
    expect(ruEn!.learners).toBe(12);
    expect(ruEn).not.toHaveProperty("updated_by");
    expect(ruUz!.readiness.diagnostic_test).toBeNull();
    expect(ruUz!.learners).toBe(0);
    // только детский тест опубликован
    h.fake.on("diagnostics", "GET", "/admin/v1/diagnostics/tests", () =>
      json(200, { items: [diagnosticTestRow({ published_version: null }), diagnosticTestRow({ test_id: "dx-en-kids", audience: "kids", published_version: 2 })] }),
    );
    expect(((await get(s, "/admin/v1/language-pairs")).json() as { items: PairCard[] }).items[0]!.readiness.diagnostic_test).toBe("dx-en-kids@2");
  });

  it("diagnostics недоступен или ответил мусором → значения catalog, экран открывается; catalog недоступен → 503", async () => {
    const { s } = await loginAs(h, "methodist");
    h.fake.down.add("diagnostics");
    const res = await get(s, "/admin/v1/language-pairs");
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: PairCard[] }).items[0]).toMatchObject({ learners: 0, readiness: { diagnostic_test: null } });
    h.fake.down.delete("diagnostics");
    h.fake.on("diagnostics", "GET", "/admin/v1/diagnostics/pairs", () => domainError(404, "NOT_FOUND"));
    h.fake.on("diagnostics", "GET", "/admin/v1/diagnostics/tests", () => json(200, { items: [{ test_id: "dx" }] }));
    expect((await get(s, "/admin/v1/language-pairs")).statusCode).toBe(200);
    h.fake.down.add("catalog");
    expect((await get(s, "/admin/v1/language-pairs")).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "catalog" } });
  });

  it("публикация пары без опубликованного теста → 422 PAIR_NOT_READY {missing: [... , diagnostic_test]}, catalog не меняется", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const put = (body: Record<string, unknown>) => send(s, "PUT", `/admin/v1/language-pairs/${body.pair_id}`, body);
    // ru-uz: курс в теле другой, чем в карточке (готовность неизвестна) — только тест
    let r = await put(pairBody({ pair_id: "ru-uz", target: "uz", status: "published", course_id: "uz-core" }));
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ code: "PAIR_NOT_READY", details: { missing: ["diagnostic_test"] } });
    // без курса
    r = await put(pairBody({ pair_id: "ru-uz", target: "uz", status: "published", course_id: null }));
    expect(r.json().details.missing).toEqual(["course", "diagnostic_test"]);
    // курс тот же, контент не готов — объединённый список
    h.fake.on("catalog", "GET", "/admin/v1/language-pairs", () =>
      json(200, { items: [pairCard({ pair_id: "ru-kk", target: "kk", status: "review", course_id: "kk-core", readiness: { ...pairCard().readiness, lessons_published: 0, rubrics_published: 2, locales_checked_pct: 80 } })] }),
    );
    r = await put(pairBody({ pair_id: "ru-kk", target: "kk", status: "published", course_id: "kk-core" }));
    expect(r.json().details.missing).toEqual(["lessons", "locales", "diagnostic_test"]);
    expect(h.fake.callsTo("catalog", "PUT")).toHaveLength(0);
  });

  it("тест есть → catalog решает (его PAIR_NOT_READY — как есть); уже опубликованная пара не перепроверяется; diagnostics недоступен → 503", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const body = pairBody({ status: "published" });
    const ok = await send(s, "PUT", "/admin/v1/language-pairs/ru-en", body);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ pair_id: "ru-en", learners: 12, readiness: { diagnostic_test: "dx-en-adult@1" } });
    expect(h.fake.callsTo("catalog", "PUT", "/admin/v1/language-pairs/ru-en")[0]!.body).toEqual(body);
    h.fake.on("catalog", "PUT", "/admin/v1/language-pairs/ru-en", () => domainError(422, "PAIR_NOT_READY", { missing: ["locales"] }));
    expect((await send(s, "PUT", "/admin/v1/language-pairs/ru-en", body)).json()).toMatchObject({ code: "PAIR_NOT_READY", details: { missing: ["locales"] } });
    // ru-en уже опубликована: тест не проверяется (как catalog — только при переходе в published)
    h.fake.on("diagnostics", "GET", "/admin/v1/diagnostics/tests", () => json(200, { items: [] }));
    h.fake.on("catalog", "PUT", "/admin/v1/language-pairs/ru-en", () => json(200, pairCard()));
    expect((await send(s, "PUT", "/admin/v1/language-pairs/ru-en", body)).statusCode).toBe(200);
    h.fake.down.add("diagnostics");
    const down = await send(s, "PUT", "/admin/v1/language-pairs/ru-uz", pairBody({ pair_id: "ru-uz", target: "uz", status: "published" }));
    expect(down.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "diagnostics" } });
    expect(h.fake.callsTo("catalog", "PUT", "/admin/v1/language-pairs/ru-uz")).toHaveLength(0);
    // не-published статус — без diagnostics; лишнее поле или чужой статус → 422
    expect((await send(s, "PUT", "/admin/v1/language-pairs/ru-uz", pairBody({ pair_id: "ru-uz", target: "uz", status: "development" }))).statusCode).toBe(200);
    expect((await send(s, "PUT", "/admin/v1/language-pairs/ru-uz", { ...pairBody({ pair_id: "ru-uz" }), learners: 5 })).statusCode).toBe(422);
    expect((await send(s, "PUT", "/admin/v1/language-pairs/ru-uz", pairBody({ pair_id: "ru-uz", status: "live" }))).statusCode).toBe(422);
  });
});

describe("диагностика: тесты, публикация версии, статистика", () => {
  it("версия теста с ключами (content.read); публикация — content.publish + step-up; коды домена как есть", async () => {
    const { s } = await loginAs(h, "methodist");
    const v = await get(s, "/admin/v1/diagnostics/tests/dx-en-adult/versions/1");
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ test_id: "dx-en-adult", items: [{ item_id: "v-a1-01", answer: 1 }], coverage: { vocabulary: { A1: 6 } } });
    const pub = () => send(s, "POST", "/admin/v1/diagnostics/tests/dx-en-adult/versions/2/publish", { reason: "новая версия" });
    expect((await pub()).json()).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: "content.publish" } });
    await stepUp(h, s);
    expect((await pub()).json()).toMatchObject({ test_id: "dx-en-adult", published_version: 2 });
    h.fake.on("diagnostics", "POST", "/admin/v1/diagnostics/tests/dx-en-adult/versions/2/publish", () => domainError(422, "TEST_INVALID", { errors: [{ path: "items[3]", code: "NO_ANSWER", message: "" }] }));
    expect((await pub()).json()).toMatchObject({ code: "TEST_INVALID", details: { errors: [{ code: "NO_ANSWER" }] } });
    h.fake.on("diagnostics", "GET", "/admin/v1/diagnostics/tests/dx-en-adult/versions/9", () => domainError(404, "DIAGNOSTIC_TEST_NOT_FOUND"));
    expect((await get(s, "/admin/v1/diagnostics/tests/dx-en-adult/versions/9")).json().code).toBe("DIAGNOSTIC_TEST_NOT_FOUND");
    expect((await get(s, "/admin/v1/diagnostics/tests/DX/versions/1")).statusCode).toBe(422);
  });

  it("статистика (dashboard.read): period по умолчанию today; content_manager видит, неизвестный период → 422", async () => {
    const { s } = await loginAs(h, "content_manager");
    expect((await get(s, "/admin/v1/diagnostics/stats")).json()).toMatchObject({ period: "today", by_level: { A1: 3 } });
    expect(h.fake.callsTo("diagnostics", "GET", "/admin/v1/diagnostics/stats")[0]!.query).toEqual({ period: "today" });
    expect((await get(s, "/admin/v1/diagnostics/stats?period=1y")).statusCode).toBe(422);
    expect((await get(s, "/admin/v1/diagnostics/tests")).statusCode).toBe(200);
  });
});

describe("логи без текстов учеников, контента и файлов", () => {
  it("название, ссылка и комментарий заявки, тело версии, base64 аудио, причины и заметки — не попадают в лог", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const marks = {
      title: "SecretSongTitle-71",
      link: "https://secret-link.example/x71",
      comment: "секретный-комментарий-71",
      payload: "секретный-текст-урока-71",
      reason: "секретная-причина-71",
      note: "секретная-заметка-71",
    };
    h.fake.on("catalog", "GET", "/admin/v1/content/media-requests", () =>
      json(200, { items: [mediaRequest({ title: marks.title, link: marks.link, comment: marks.comment })], next_cursor: null }),
    );
    await get(s, "/admin/v1/content/media-requests");
    await send(s, "POST", `/admin/v1/content/media-requests/${REQUEST_ID}/decide`, { status: "rejected", note: marks.note });
    await send(s, "POST", "/admin/v1/content/lesson", { payload: { goal: { ru: marks.payload, uz: marks.payload } } });
    await send(s, "POST", "/admin/v1/content/lesson/l-1/versions/2/publish", { reason: marks.reason });
    const audio = Buffer.concat([Buffer.from("ID3"), Buffer.from("уникальные-байты-аудио-71")]).toString("base64");
    await send(s, "POST", "/admin/v1/content/blobs", { filename: "scene-71.mp3", content_type: "audio/mpeg", data_base64: audio });
    // ошибки: испорченный ответ и 4xx домена с текстом
    h.fake.on("catalog", "GET", "/admin/v1/content/media-requests", () => json(200, { items: [mediaRequest({ title: marks.title, kind: "podcast" })], next_cursor: null }));
    expect((await get(s, "/admin/v1/content/media-requests")).statusCode).toBe(503);
    h.fake.on("catalog", "POST", "/admin/v1/content/lesson", () => domainError(422, "CONTENT_INVALID", { errors: [{ path: "payload.goal.ru", code: "LOCALE_SCRIPT", message: marks.payload }] }));
    await send(s, "POST", "/admin/v1/content/lesson", { payload: { goal: { ru: marks.payload, uz: "" } } });
    await send(s, "POST", "/admin/v1/content/blobs", { filename: "scene-71.mp3", content_type: "audio/wav", data_base64: audio });
    const text = h.logs.text;
    expect(text).toContain("request completed");
    expect(text).toContain("domain response rejected by normalization");
    for (const leak of [...Object.values(marks), audio.slice(8, 40), "scene-71"]) expect(text, leak).not.toContain(leak);
  });
});
