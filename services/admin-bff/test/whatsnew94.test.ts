/**
 * Доработка 9.4 «Что нового»: заметки о релизах в «Конфигурации интерфейса». Права config.read / config.edit /
 * config.publish (как у версий конфигурации), CSRF на командах, Idempotency-Key пробрасывается, форма заметки проверяется
 * до домена (белые списки маршрутов и иконок = packages/contracts/release-notes.json), тексты — как есть (без разметки).
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOTE_ICONS, NOTE_ROUTES } from "../src/routes/experience.js";
import { NOTE_ID, browser, closeRedis, domainError, fakeReleaseNotes, json, loginAs, makeHarness, releaseNoteBody, releaseNoteRow, type Harness } from "./helpers.js";

const BASE = "/admin/v1/release-notes";
const CATALOG = JSON.parse(readFileSync(new URL("../../../packages/contracts/release-notes.json", import.meta.url), "utf8")) as {
  routes: string[];
  icons: string[];
};

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  fakeReleaseNotes(h.fake);
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

describe("9.4: «Что нового» в admin-bff", () => {
  it("белые списки = общий каталог", () => {
    expect([...NOTE_ROUTES]).toEqual(CATALOG.routes);
    expect([...NOTE_ICONS]).toEqual(CATALOG.icons);
  });

  it("права: config.edit — черновик, без config.publish — ни публикации, ни архива", async () => {
    const { s } = await loginAs(h, "operations", { permissions: ["config.read", "config.edit"] });
    expect((await h.app.inject({ url: BASE, headers: browser(s) })).statusCode).toBe(200);
    const created = await h.app.inject({ method: "POST", url: BASE, headers: browser(s), payload: releaseNoteBody() });
    expect(created.statusCode).toBe(201);
    for (const action of ["publish", "archive"]) {
      const r = await h.app.inject({ method: "POST", url: `${BASE}/${NOTE_ID}/${action}`, headers: browser(s), payload: { expected_version: 1, reason: "релиз" } });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "config.publish" } });
    }
    expect(h.fake.callsTo("experience", "POST", `${BASE}/${NOTE_ID}/publish`)).toHaveLength(0);
    const reader = await loginAs(h, "auditor", { permissions: ["config.read"] });
    expect((await h.app.inject({ method: "POST", url: BASE, headers: browser(reader.s), payload: releaseNoteBody() })).statusCode).toBe(403);
  });

  it("CSRF: команда без X-CSRF-Token или с чужим Origin — 403 CSRF_INVALID, домен не вызывается", async () => {
    const { s } = await loginAs(h, "super_admin");
    const noToken = { ...browser(s) };
    delete (noToken as Record<string, string>)["x-csrf-token"];
    const r1 = await h.app.inject({ method: "POST", url: `${BASE}/${NOTE_ID}/publish`, headers: noToken, payload: { expected_version: 1, reason: "релиз" } });
    expect(r1.statusCode).toBe(403);
    expect(r1.json().code).toBe("CSRF_INVALID");
    const r2 = await h.app.inject({ method: "POST", url: BASE, headers: { ...browser(s), origin: "https://evil.example" }, payload: releaseNoteBody() });
    expect(r2.statusCode).toBe(403);
    expect(h.fake.callsTo("experience")).toHaveLength(0);
  });

  it("публикация: Idempotency-Key и actor сотрудника уходят в experience-config, статус домена сохраняется", async () => {
    const { s, staff } = await loginAs(h, "super_admin");
    const r = await h.app.inject({
      method: "POST",
      url: `${BASE}/${NOTE_ID}/publish`,
      headers: browser(s, { "idempotency-key": "pub-note-000001" }),
      payload: { expected_version: 1, reason: "Релиз ноября" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: "published", published_by: staff.staff_id });
    const call = h.fake.callsTo("experience", "POST", `${BASE}/${NOTE_ID}/publish`)[0]!;
    expect(call.headers["idempotency-key"]).toBe("pub-note-000001");
    expect(call.actor?.id).toBe(staff.staff_id);
    expect(call.body).toEqual({ expected_version: 1, reason: "Релиз ноября" });
    // уже опубликована → 200 от домена проходит как есть
    h.fake.on("experience", "POST", `${BASE}/${NOTE_ID}/publish`, () => json(200, releaseNoteRow({ status: "published", version: 2, published_at: "2026-11-08T07:00:00.000Z", published_by: "x" })));
    expect((await h.app.inject({ method: "POST", url: `${BASE}/${NOTE_ID}/publish`, headers: browser(s), payload: { expected_version: 1, reason: "Релиз ноября" } })).statusCode).toBe(200);
    // ошибки домена — как есть
    h.fake.on("experience", "PUT", `${BASE}/${NOTE_ID}`, () => domainError(409, "RELEASE_NOTE_NOT_DRAFT", { status: "published" }));
    const put = await h.app.inject({ method: "PUT", url: `${BASE}/${NOTE_ID}`, headers: browser(s), payload: { ...releaseNoteBody(), expected_version: 2 } });
    expect(put.statusCode).toBe(409);
    expect(put.json().code).toBe("RELEASE_NOTE_NOT_DRAFT");
  });

  const bad = (mut: (b: ReturnType<typeof releaseNoteBody>) => void) => {
    const b = structuredClone(releaseNoteBody());
    mut(b);
    return b;
  };
  it.each([
    ["7 пунктов", bad((b) => b.items.push(...Array.from({ length: 5 }, () => b.items[0]!)))],
    ["нет пунктов", bad((b) => (b.items = []))],
    ["javascript-ссылка", bad((b) => ((b.items[0] as Record<string, unknown>).link = "javascript:alert(1)"))],
    ["внешняя ссылка", bad((b) => ((b.items[0] as Record<string, unknown>).link = "https://evil.example"))],
    ["иконка не из набора", bad((b) => ((b.items[0] as Record<string, unknown>).icon = "skull"))],
    ["текст > 200", bad((b) => (b.items[0]!.text.ru = "а".repeat(201)))],
    ["лишнее поле пункта", bad((b) => ((b.items[0] as Record<string, unknown>).html = "<b>"))],
    ["лишнее поле заметки", bad((b) => ((b as Record<string, unknown>).css = "body{}"))],
    ["метка с путём", bad((b) => (b.slug = "../x"))],
    ["аудитория", bad((b) => ((b as Record<string, unknown>).audience = "vip"))],
  ])("%s → 422 до вызова домена", async (_, payload) => {
    const { s } = await loginAs(h, "super_admin");
    const r = await h.app.inject({ method: "POST", url: BASE, headers: browser(s), payload });
    expect(r.statusCode).toBe(422);
    expect(h.fake.callsTo("experience", "POST", BASE)).toHaveLength(0);
  });

  it("XSS: разметка в текстах уходит и возвращается как обычный текст; лишние поля домена отбрасываются", async () => {
    const { s } = await loginAs(h, "super_admin");
    const xss = '<img src=x onerror="alert(1)">';
    const body = releaseNoteBody();
    body.items[0]!.text.ru = xss;
    h.fake.on("experience", "POST", BASE, (c) => json(201, { ...releaseNoteRow({ ...c.body }), internal_note: "staff only" }));
    const r = await h.app.inject({ method: "POST", url: BASE, headers: browser(s), payload: body });
    expect(r.statusCode).toBe(201);
    expect(r.json().items[0].text.ru).toBe(xss);
    expect(r.json()).not.toHaveProperty("internal_note");
    expect(r.headers["content-type"]).toMatch(/^application\/json/);
  });

  it("список: статус-фильтр и пагинация уходят в домен; неизвестный статус → 422", async () => {
    const { s } = await loginAs(h, "super_admin");
    expect((await h.app.inject({ url: `${BASE}?status=published&limit=5&cursor=abc`, headers: browser(s) })).statusCode).toBe(200);
    expect(h.fake.callsTo("experience", "GET", BASE).at(-1)!.query).toEqual({ status: "published", limit: "5", cursor: "abc" });
    expect((await h.app.inject({ url: `${BASE}?status=deleted`, headers: browser(s) })).statusCode).toBe(422);
    expect((await h.app.inject({ url: `${BASE}/not-a-uuid`, headers: browser(s) })).statusCode).toBe(422);
  });
});
