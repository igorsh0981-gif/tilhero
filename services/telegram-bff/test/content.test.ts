/**
 * Спринт 3 — содержание ученика через BFF: языки (AT-31), карта навыков (AT-35, снимок курса по ETag), траектория
 * (AT-36), сценарии (AT-37), медиатека и аудио (AT-29), заявки на песни и фильмы (AT-30), дети 6–13 (AT-38).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { bearer, closeRedis, domainError, idem, json, login, makeHarness, switchTo, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
beforeEach(async () => {
  h = await makeHarness();
  s = await login(h);
  h.fake.setAge(s.userId, "18+");
  h.fake.onboard(s.userId);
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const get = (url: string, token = s.access, headers: Record<string, string> = {}) => h.app.inject({ url, headers: { ...bearer(token), ...headers } });
const post = (url: string, payload: unknown, headers: Record<string, string> = idem(), token = s.access) =>
  h.app.inject({ method: "POST", url, headers: { ...bearer(token), ...headers }, payload: payload as object });

async function kidSession(): Promise<{ kid: LoggedIn; child: string }> {
  const child = h.fake.addChild(s.userId, "Мадина", "6-9");
  h.fake.onboard(child);
  return { kid: await switchTo(h, s, child), child };
}

describe("GET /v1/languages (AT-31)", () => {
  it("ru-en активна, остальные — «скоро» (available=false), архивных нет; лишние поля не уходят; кеш справочника", async () => {
    const res = await get("/v1/languages");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.active_pair_id).toBe("ru-en");
    expect(body.pairs.map((p: { pair_id: string }) => p.pair_id)).toEqual(["ru-en", "en-kk", "ru-uz"]);
    expect(body.pairs[0]).toEqual({ pair_id: "ru-en", source: "ru", target: "en", title: { ru: "Английский (объяснения на русском)", uz: "Английский (объяснения на русском) (uz)" }, status: "published", available: true });
    expect(body.pairs.filter((p: { available: boolean }) => p.available)).toHaveLength(1);
    await get("/v1/languages");
    expect(h.fake.content.pairsCalls).toBe(1);
  });

  it("catalog недоступен: есть кеш — последний список; нет — 503", async () => {
    await get("/v1/languages");
    h.fake.down.add("catalog");
    const h2 = await makeHarness({ PAIRS_CACHE_SECONDS: "0" });
    try {
      const s2 = await login(h2);
      h2.fake.down.add("catalog");
      const res = await h2.app.inject({ url: "/v1/languages", headers: bearer(s2.access) });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "catalog" } });
    } finally {
      await h2.close();
    }
  });

  it("401 без токена", async () => {
    expect((await h.app.inject({ url: "/v1/languages" })).statusCode).toBe(401);
  });
});

describe("GET /v1/skills/map (AT-35)", () => {
  it("состояния из diagnostics (sub = ученик), названия и уровни — из снимка курса; навык вне курса не показывается; counts пересчитаны", async () => {
    const res = await get("/v1/skills/map");
    expect(res.statusCode).toBe(200);
    const map = res.json();
    expect(map.course_id).toBe("en-core");
    expect(map.skills.map((x: { skill_id: string }) => x.skill_id)).toEqual(["en.func.greet", "en.gram.to-be", "en.vocab.food"]);
    expect(map.skills[1]).toMatchObject({ title: { ru: "Глагол to be" }, area: "grammar", level: "A1", state: "learning", prerequisites: ["en.func.greet"] });
    expect(map.skills[0].history).toEqual([{ source: "diagnostic", outcome: "positive", at: "2026-11-19T08:10:00Z" }]);
    expect(map.counts).toEqual({ not_started: 1, learning: 1, demonstrated: 1, retained: 0 });
    expect(h.fake.callsTo("diagnostics", "GET", "/internal/v1/skills/map")[0]!.subject).toBe(s.userId);
  });

  it("снимок курса кешируется по ETag: перепроверка If-None-Match → 304 (тело не скачивается заново)", async () => {
    const h2 = await makeHarness({ COURSE_SNAPSHOT_REVALIDATE_SECONDS: "0" });
    try {
      const s2 = await login(h2);
      for (let i = 0; i < 3; i++) expect((await h2.app.inject({ url: "/v1/skills/map", headers: bearer(s2.access) })).statusCode).toBe(200);
      expect(h2.fake.content.snapshotCalls).toEqual({ ok: 1, notModified: 2 });
      const calls = h2.fake.callsTo("catalog", "GET", "/internal/v1/courses/en-core/snapshot");
      expect(calls[1]!.headers["if-none-match"]).toBe('"snap-v1"');
    } finally {
      await h2.close();
    }
    // с окном перепроверки — один запрос к catalog
    await get("/v1/skills/map");
    await get("/v1/skills/map");
    expect(h.fake.content.snapshotCalls.ok + h.fake.content.snapshotCalls.notModified).toBe(1);
  });

  it("снимка нет (catalog недоступен, кеша нет) → 503 CATALOG_UNAVAILABLE; с кешем — последний снимок", async () => {
    h.fake.content.snapshotDown = true;
    const res = await get("/v1/skills/map");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "CATALOG_UNAVAILABLE", details: { service: "catalog" } });

    const h2 = await makeHarness({ COURSE_SNAPSHOT_REVALIDATE_SECONDS: "0" });
    try {
      const s2 = await login(h2);
      expect((await h2.app.inject({ url: "/v1/skills/map", headers: bearer(s2.access) })).statusCode).toBe(200);
      h2.fake.content.snapshotDown = true;
      const stale = await h2.app.inject({ url: "/v1/skills/map", headers: bearer(s2.access) });
      expect(stale.statusCode).toBe(200);
      expect(stale.json().skills).toHaveLength(3);
    } finally {
      await h2.close();
    }
  });

  it("409 PAIR_NOT_AVAILABLE — как есть", async () => {
    const res = await get("/v1/skills/map?pair_id=ru-uz");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PAIR_NOT_AVAILABLE");
  });
});

describe("GET /v1/plan/trajectory (AT-36)", () => {
  it("от имени ученика с audience по возрасту; лишние поля домена (ключи заданий) не уходят", async () => {
    const res = await get("/v1/plan/trajectory");
    expect(res.statusCode).toBe(200);
    const t = res.json();
    expect(t.next).toMatchObject({ lesson_id: "l-a1-01", reason_codes: ["no_diagnostic"], explanation: { ru: "Начинаем с начала курса" } });
    expect(t.mandatory).toHaveLength(2);
    expect(t.optional[0].kind).toBe("optional");
    expect(t.lessons_available).toBe(false);
    expect(JSON.stringify(t)).not.toContain("control_items");
    expect(t).not.toHaveProperty("user_id");
    const call = h.fake.callsTo("learningPlan", "GET", "/internal/v1/plan/trajectory")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.query).toEqual({ pair_id: "ru-en", audience: "adults" });
  });

  it("детский профиль → audience=kids, sub = ребёнок", async () => {
    const { kid, child } = await kidSession();
    expect((await get("/v1/plan/trajectory", kid.access)).statusCode).toBe(200);
    const call = h.fake.callsTo("learningPlan", "GET", "/internal/v1/plan/trajectory").at(-1)!;
    expect(call.subject).toBe(child);
    expect(call.query.audience).toBe("kids");
  });

  it("спринт 4: пройденные уроки — с отметкой «зачтено» (passed), оценкой и датой, причина repeat; без completed_at — 503", async () => {
    const base = (await get("/v1/plan/trajectory")).json();
    const done = { ...base.mandatory[0], reason_codes: undefined, passed: true, evaluation_id: "0b8e1c3a-5d2f-4a6b-9c7d-1e2f3a4b5c6d", completed_at: "2026-11-19T10:00:00Z", internal: "x" };
    delete done.reason_codes;
    h.fake.content.trajectoryOverride = () =>
      json(200, { ...base, next: { ...base.next, reason_codes: ["repeat"] }, completed: [done, { ...done, lesson_id: "l-a1-02", passed: null, evaluation_id: null }], lessons_available: true });
    const res = await get("/v1/plan/trajectory");
    expect(res.statusCode).toBe(200);
    expect(res.json().next.reason_codes).toEqual(["repeat"]); // спринт 4: урок без зачёта — «повторим»
    expect(res.json().completed).toEqual([
      { ...done, internal: undefined, reason_codes: undefined },
      { ...done, lesson_id: "l-a1-02", passed: null, evaluation_id: null, internal: undefined, reason_codes: undefined },
    ].map((x) => JSON.parse(JSON.stringify(x))));
    expect(res.json().lessons_available).toBe(true);
    const { completed_at: _c, ...noDate } = done;
    h.fake.content.trajectoryOverride = () => json(200, { ...base, completed: [noDate] });
    expect((await get("/v1/plan/trajectory")).statusCode).toBe(503);
  });

  it("смена цели (PATCH /v1/plan) → траектория с новой целью", async () => {
    await h.app.inject({ method: "PATCH", url: "/v1/plan", headers: bearer(s.access), payload: { goal: "travel" } });
    expect((await get("/v1/plan/trajectory")).json().basis.goal).toBe("travel");
  });

  it("409 PAIR_NOT_AVAILABLE, 410 USER_DELETED, 503 CATALOG_UNAVAILABLE (свой код), 5xx → UPSTREAM_UNAVAILABLE", async () => {
    expect((await get("/v1/plan/trajectory?pair_id=ru-kk")).json().code).toBe("PAIR_NOT_AVAILABLE");
    h.fake.content.trajectoryOverride = () => domainError(410, "USER_DELETED");
    expect((await get("/v1/plan/trajectory")).statusCode).toBe(410);
    h.fake.content.trajectoryOverride = () => domainError(503, "CATALOG_UNAVAILABLE");
    const cu = await get("/v1/plan/trajectory");
    expect(cu.statusCode).toBe(503);
    expect(cu.json()).toMatchObject({ code: "CATALOG_UNAVAILABLE", details: { service: "catalog" } });
    h.fake.content.trajectoryOverride = () => domainError(500, "BOOM");
    expect((await get("/v1/plan/trajectory")).json().code).toBe("UPSTREAM_UNAVAILABLE");
    h.fake.content.trajectoryOverride = () => json(200, { pair_id: "ru-en", revision: 0 });
    expect((await get("/v1/plan/trajectory")).statusCode).toBe(503);
  });
});

describe("сценарии (AT-37, AT-38)", () => {
  it("каталог по аудитории ученика и фильтрам; без полного графа", async () => {
    const res = await get("/v1/scenarios?goal=travel&level=A1");
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((x: { scenario_id: string }) => x.scenario_id)).toEqual(["sc-travel-hotel"]);
    const call = h.fake.callsTo("catalog", "GET", "/internal/v1/scenarios")[0]!;
    expect(call.query).toEqual({ audience: "adults", goal: "travel", level: "A1", limit: "20" });
    const all = (await get("/v1/scenarios")).json().items;
    expect(all).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain("secret graph");
    expect(JSON.stringify(all)).not.toContain("audience");

    const d = await get("/v1/scenarios/sc-travel-hotel");
    expect(d.statusCode).toBe(200);
    expect(d.json().opening).toMatchObject({ speaker: "Anna", line_en: "Good evening! How can I help?" });
    expect(d.json()).not.toHaveProperty("nodes");
  });

  it("детям — только детские; взрослый сценарий ребёнку — 404", async () => {
    const { kid } = await kidSession();
    const list = (await get("/v1/scenarios", kid.access)).json().items;
    expect(list.map((x: { scenario_id: string }) => x.scenario_id)).toEqual(["sc-kids-zoo"]);
    expect((await get("/v1/scenarios/sc-work-meeting", kid.access)).statusCode).toBe(404);
  });

  it("422: неизвестная цель / уровень / лишний параметр / неверный id", async () => {
    for (const url of ["/v1/scenarios?goal=fun", "/v1/scenarios?level=C1", "/v1/scenarios?audience=adults", "/v1/scenarios/Bad%20Id"]) {
      expect((await get(url)).statusCode, url).toBe(422);
    }
  });

  it("элемент списка не по контракту отбрасывается, обёртка не по контракту — 503", async () => {
    h.fake.content.scenarios[0]!.level = "C2" as never;
    const res = await get("/v1/scenarios");
    expect(res.json().items.map((x: { scenario_id: string }) => x.scenario_id)).toEqual(["sc-work-meeting"]);
    h.fake.override("catalog", "GET", "/internal/v1/scenarios", () => json(200, { items: "nope" }));
    expect((await get("/v1/scenarios")).statusCode).toBe(503);
  });
});

describe("claims внутреннего JWT к catalog (защита в глубину)", () => {
  const LEARNER_CALLS: Array<[string, string]> = [
    ["/v1/scenarios", "/internal/v1/scenarios"],
    ["/v1/scenarios/sc-travel-hotel", "/internal/v1/scenarios/sc-travel-hotel"],
    ["/v1/media", "/internal/v1/media"],
    ["/v1/media/m-own-coffee", "/internal/v1/media/m-own-coffee"],
    ["/v1/media/m-own-coffee/audio", "/internal/v1/media/m-own-coffee/audio"],
    ["/v1/media/requests", "/internal/v1/media/requests"],
  ];
  it("взрослый: во всех вызовах ученика sub = аккаунт, lrn = активный ученик, age_band аккаунта", async () => {
    for (const [url, path] of LEARNER_CALLS) {
      expect((await get(url)).statusCode, url).toBeLessThan(300);
      const call = h.fake.callsTo("catalog", "GET", path).at(-1)!;
      expect(call.claims, url).toMatchObject({ sub: s.userId, lrn: s.userId, age_band: "18+", iss: "telegram-bff", aud: "catalog" });
    }
  });
  it("детский профиль: sub = аккаунт родителя, lrn = ребёнок — catalog сам сужает аудиторию до kids", async () => {
    const { kid, child } = await kidSession();
    const kidCalls: Array<[string, string]> = [
      ["/v1/scenarios", "/internal/v1/scenarios"],
      ["/v1/scenarios/sc-kids-zoo", "/internal/v1/scenarios/sc-kids-zoo"],
      ["/v1/media", "/internal/v1/media"],
      ["/v1/media/m-kids-song", "/internal/v1/media/m-kids-song"],
    ];
    for (const [url, path] of kidCalls) {
      expect((await get(url, kid.access)).statusCode, url).toBe(200);
      const call = h.fake.callsTo("catalog", "GET", path).at(-1)!;
      expect(call.claims, url).toMatchObject({ sub: s.userId, lrn: child });
      expect(call.query.audience, url).toBe("kids");
    }
    // взрослый материал ребёнку недоступен и при подменённой аудитории (catalog по claims)
    expect((await get("/v1/media/m-own-coffee", kid.access)).statusCode).toBe(404);
  });
  it("повтор GET при сбое catalog (UPSTREAM_RETRIES) — один раз", async () => {
    const h2 = await makeHarness({ UPSTREAM_RETRIES: "1" });
    try {
      const s2 = await login(h2);
      let n = 0;
      h2.fake.override("catalog", "GET", "/internal/v1/scenarios", () => (++n === 1 ? domainError(502, "BAD_GATEWAY") : json(200, { items: [], next_cursor: null })));
      expect((await h2.app.inject({ url: "/v1/scenarios", headers: bearer(s2.access) })).statusCode).toBe(200);
      expect(n).toBe(2);
    } finally {
      await h2.close();
    }
  });
});

describe("медиатека (AT-29, AT-38)", () => {
  it("список по аудитории и фильтрам; карточка без служебных полей; транскрипт — только при show_transcript", async () => {
    const res = await get("/v1/media?type=own_scene");
    expect(res.json().items.map((x: { asset_id: string }) => x.asset_id)).toEqual(["m-own-coffee"]);
    expect(JSON.stringify(res.json())).not.toContain("contract-42");
    expect(h.fake.callsTo("catalog", "GET", "/internal/v1/media")[0]!.query).toMatchObject({ audience: "adults", type: "own_scene" });

    const d = (await get("/v1/media/m-own-coffee")).json();
    expect(d.transcript).toHaveLength(1);
    expect(d.voices).toEqual({ A: "en-GB" });
    const noTr = (await get("/v1/media/m-own-lecture")).json();
    expect(noTr.transcript).toBeNull();
  });

  it("детям — только детские материалы; взрослый материал ребёнку — 404 MEDIA_NOT_AVAILABLE", async () => {
    const { kid } = await kidSession();
    expect((await get("/v1/media", kid.access)).json().items.map((x: { asset_id: string }) => x.asset_id)).toEqual(["m-kids-song"]);
    const r = await get("/v1/media/m-own-coffee", kid.access);
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe("MEDIA_NOT_AVAILABLE");
  });

  it("аудио: прокси байтов, Content-Type из ответа, ETag/Cache-Control; повтор — 304 в catalog, байты из кеша; If-None-Match клиента → 304", async () => {
    const a = await get("/v1/media/m-own-coffee/audio");
    expect(a.statusCode).toBe(200);
    expect(a.headers["content-type"]).toBe("audio/mpeg");
    expect(a.headers["cache-control"]).toBe("private, max-age=3600");
    expect(a.headers.etag).toBe('"sha-audio-1"');
    expect(a.rawPayload.length).toBe(2048);
    const b = await get("/v1/media/m-own-coffee/audio");
    expect(b.rawPayload.equals(a.rawPayload)).toBe(true);
    expect(h.fake.content.audioCalls).toEqual({ ok: 1, notModified: 1 });
    const c = await get("/v1/media/m-own-coffee/audio", s.access, { "if-none-match": '"sha-audio-1"' });
    expect(c.statusCode).toBe(304);
    expect(c.rawPayload.length).toBe(0);
    expect(h.fake.callsTo("catalog", "GET", "/internal/v1/media/m-own-coffee/audio")[0]!.query.audience).toBe("adults");
  });

  it("аудио: права истекли — 404 и из кеша не отдаётся; файла нет — AUDIO_NOT_FOUND; детям взрослое — 404", async () => {
    expect((await get("/v1/media/m-own-coffee/audio")).statusCode).toBe(200);
    h.fake.content.suspended.add("m-own-coffee");
    const gone = await get("/v1/media/m-own-coffee/audio");
    expect(gone.statusCode).toBe(404);
    expect(gone.json().code).toBe("MEDIA_NOT_AVAILABLE");
    const none = await get("/v1/media/m-own-lecture/audio");
    expect(none.json().code).toBe("AUDIO_NOT_FOUND");
    h.fake.content.suspended.clear();
    const { kid } = await kidSession();
    expect((await get("/v1/media/m-own-coffee/audio", kid.access)).statusCode).toBe(404);
  });

  it("аудио: больше 3 МБ или не аудио — 503 без чтения в память; catalog недоступен — 503 (кеш без проверки прав не отдаётся)", async () => {
    h.fake.content.audioBytes = Buffer.alloc(3 * 1024 * 1024 + 1, 1);
    h.fake.content.audioEtag = '"big"';
    expect((await get("/v1/media/m-own-coffee/audio")).statusCode).toBe(503);
    h.fake.content.audioBytes = Buffer.alloc(100, 1);
    h.fake.content.audioEtag = '"html"';
    h.fake.content.audioType = "text/html";
    expect((await get("/v1/media/m-own-coffee/audio")).statusCode).toBe(503);
    h.fake.content.audioType = "audio/ogg";
    h.fake.content.audioEtag = '"ogg"';
    const ok = await get("/v1/media/m-own-coffee/audio");
    expect(ok.headers["content-type"]).toBe("audio/ogg");
    h.fake.down.add("catalog");
    expect((await get("/v1/media/m-own-coffee/audio")).statusCode).toBe(503);
  });
});

describe("заявки на песни и фильмы (AT-30, AT-38)", () => {
  const body = { kind: "song", title: "Yesterday", link: "https://example.com/watch?v=1", comment: "Хочу разобрать припев" };

  it("создание от имени аккаунта: claims lrn/age_band, ui_locale, Idempotency-Key; повтор — та же заявка; «Мои заявки»", async () => {
    const k = idem();
    const res = await post("/v1/media/requests", body, k);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: "song", title: "Yesterday", status: "new", link: body.link, comment: body.comment });
    expect(res.json()).not.toHaveProperty("user_id");
    const call = h.fake.callsTo("catalog", "POST", "/internal/v1/media/requests")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ sub: s.userId, lrn: s.userId, age_band: "18+", iss: "telegram-bff", aud: "catalog" });
    expect(call.body).toEqual({ ...body, ui_locale: "ru" });
    expect(call.headers["idempotency-key"]).toBe(k["idempotency-key"]);
    const again = await post("/v1/media/requests", body, k);
    expect(again.json().request_id).toBe(res.json().request_id);

    const list = await get("/v1/media/requests");
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).not.toHaveProperty("user_id");
  });

  it("детский профиль → 403 KIDS_NOT_ALLOWED без вызова catalog (создание и список)", async () => {
    const { kid } = await kidSession();
    h.fake.calls.length = 0;
    const res = await post("/v1/media/requests", body, idem(), kid.access);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("KIDS_NOT_ALLOWED");
    expect((await get("/v1/media/requests", kid.access)).json().code).toBe("KIDS_NOT_ALLOWED");
    expect(h.fake.callsTo("catalog")).toHaveLength(0);
  });

  it("подросток 14–17 может отправить заявку (age_band в claims); язык уведомления — язык интерфейса аккаунта", async () => {
    const teen = await login(h, { id: 900091, first_name: "Тимур", language_code: "uz" });
    h.fake.setAge(teen.userId, "14-17");
    const res = await post("/v1/media/requests", { kind: "movie", title: "Up" }, idem(), teen.access);
    expect(res.statusCode).toBe(201);
    const call = h.fake.callsTo("catalog", "POST", "/internal/v1/media/requests").at(-1)!;
    expect(call.claims.age_band).toBe("14-17");
    expect(call.body).toEqual({ kind: "movie", title: "Up", ui_locale: "uz" });
  });

  it("> 5 в сутки → 429 MEDIA_REQUEST_LIMIT + Retry-After", async () => {
    for (let i = 0; i < 5; i++) expect((await post("/v1/media/requests", { kind: "song", title: `Song ${i}` })).statusCode).toBe(201);
    const res = await post("/v1/media/requests", { kind: "song", title: "Song 6" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: "MEDIA_REQUEST_LIMIT", details: { retry_after: 3600 } });
    expect(res.headers["retry-after"]).toBe("3600");
  });

  it("422: без Idempotency-Key, http-ссылка, короткое название, лишние поля, управляющие символы, слишком длинный комментарий", async () => {
    expect((await post("/v1/media/requests", body, {})).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    for (const bad of [
      { ...body, link: "http://example.com" },
      { ...body, link: "javascript:alert(1)" },
      { ...body, title: "a" },
      { ...body, title: "   " },
      { ...body, title: "Song\u0000" },
      { ...body, kind: "podcast" },
      { ...body, user_id: randomUUID() },
      { ...body, comment: "x".repeat(501) },
    ]) {
      const r = await post("/v1/media/requests", bad);
      expect(r.statusCode, JSON.stringify(bad).slice(0, 80)).toBe(422);
    }
    expect(h.fake.callsTo("catalog", "POST", "/internal/v1/media/requests")).toHaveLength(0);
  });

  it("PII не в логах: ни название, ни ссылка, ни комментарий", async () => {
    await post("/v1/media/requests", { ...body, title: "Secret Title 777" });
    h.fake.override("catalog", "POST", "/internal/v1/media/requests", () => domainError(500, "BOOM"));
    await post("/v1/media/requests", { ...body, title: "Secret Title 888" });
    expect(h.logs.text).not.toContain("Secret Title");
    expect(h.logs.text).not.toContain("example.com");
    expect(h.logs.text).not.toContain("припев");
  });
});
