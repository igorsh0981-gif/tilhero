/**
 * «Что нового» и лента новостей (AT-11): сегмент — onboarded_at из плана активного ученика, язык интерфейса аккаунта
 * (locale, ревью T-6) и возраст,
 * режим выбирает experience-config; отметки просмотра — на сервере; каталог маршрутов/иконок — release-notes.json.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { ageSegment } from "../src/account.js";
import { ILLUSTRATION_PATTERN, NOTE_ICONS, NOTE_ROUTES, NewsPageSchema, WhatsNewSchema } from "../src/schemas.js";
import { bearer, closeRedis, domainError, login, makeHarness, noteFixture, switchTo, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
beforeEach(async () => {
  h = await makeHarness();
  s = await login(h);
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const get = (url: string, token = s.access) => h.app.inject({ url, headers: bearer(token) });
const seen = (ids: unknown, token = s.access) =>
  h.app.inject({ method: "POST", url: "/v1/whats-new/seen", headers: bearer(token), payload: { release_note_ids: ids } });
const forMeCalls = () => h.fake.callsTo("experience", "GET", "/internal/v1/release-notes/for-me");

describe("каталог release-notes.json", () => {
  it("маршруты и иконки BFF = packages/contracts/release-notes.json", () => {
    const cat = JSON.parse(readFileSync(new URL("../../../packages/contracts/release-notes.json", import.meta.url), "utf8")) as {
      routes: string[];
      icons: string[];
      segments: { age: string[]; ui_lang: string[] };
      illustrations: Array<{ key: string; width: number; height: number }>;
      limits: { illustration_pattern: string };
    };
    expect([...NOTE_ROUTES].sort()).toEqual([...cat.routes].sort());
    expect([...NOTE_ICONS].sort()).toEqual([...cat.icons].sort());
    expect(cat.segments.age.sort()).toEqual(["adults", "kids", "teens"]);
    // релиз 6.1: иллюстрации — формат ключа тот же, что пропускает BFF; каждый ключ каталога ему соответствует
    expect(ILLUSTRATION_PATTERN).toBe(cat.limits.illustration_pattern);
    expect(cat.illustrations.map((i) => i.key)).toEqual(["welcome", "s6-heroes"]);
    for (const i of cat.illustrations) expect(new RegExp(ILLUSTRATION_PATTERN).test(i.key), i.key).toBe(true);
    expect(NOTE_ROUTES).toEqual(expect.arrayContaining(["heroes", "shop", "badges", "game_history", "game_settings", "dictionary", "reading"]));
  });

  it("возраст → сегмент: 6-9, 10-13 → kids; 14-17 → teens; 18+ и не выбран → adults", () => {
    expect([ageSegment("6-9"), ageSegment("10-13"), ageSegment("14-17"), ageSegment("18+"), ageSegment(null)]).toEqual(["kids", "kids", "teens", "adults", "adults"]);
  });
});

describe("GET /v1/whats-new", () => {
  it("онбординг не завершён → mode none, experience-config не вызывается", async () => {
    const res = await get("/v1/whats-new");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: "none", notes: [] });
    expect(forMeCalls()).toHaveLength(0);
  });

  it("onboarded_at — из плана ученика, lang — locale аккаунта (не ui_lang плана), age — из возраста; sub = ученик", async () => {
    h.fake.setAge(s.userId, "14-17");
    h.fake.account(s.userId).summary.locale = "uz";
    h.fake.onboard(s.userId, { ui_lang: "ru", onboarding_completed_at: "2026-11-12T07:30:00Z" });
    const note = noteFixture({ audience: "new", slug: "welcome-1" });
    h.fake.forMe = { mode: "welcome", notes: [{ ...note, internal: "x", segments: { age: ["teens"] } } as never] };
    const res = await get("/v1/whats-new");
    expect(res.statusCode).toBe(200);
    expect(Value.Check(WhatsNewSchema, res.json())).toBe(true);
    expect(res.json()).toEqual({ mode: "welcome", notes: [note] });
    const call = forMeCalls()[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.query).toEqual({ onboarded_at: "2026-11-12T07:30:00Z", lang: "uz", age: "teens" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("детский профиль: сегмент ребёнка (kids, его план), sub = ребёнок", async () => {
    h.fake.setAge(s.userId, "18+");
    const child = h.fake.addChild(s.userId, "Мадина", "10-13");
    h.fake.onboard(child, { ui_lang: "ru" });
    const c = await switchTo(h, s, child);
    await get("/v1/whats-new", c.access);
    const call = forMeCalls()[0]!;
    expect(call.subject).toBe(child);
    expect(call.query).toMatchObject({ lang: "ru", age: "kids" });
    // взрослый без выбранного возраста — adults
    h.fake.onboard(s.userId);
    h.fake.account(s.userId).summary.age_band = null;
    const back = await switchTo(h, c, s.userId);
    await get("/v1/whats-new", back.access);
    expect(forMeCalls()[1]!.query.age).toBe("adults");
  });

  it("не больше 5 заметок; маршрут/иконка вне каталога → null; режим вне контракта или пусто → none", async () => {
    h.fake.onboard(s.userId);
    const notes = Array.from({ length: 7 }, (_, i) =>
      noteFixture({ slug: `n${i}`, items: [{ title: "t", text: "x", link: (i === 0 ? "events" : "family") as never, icon: (i === 0 ? "plane" : "users") as never }] }),
    );
    h.fake.forMe = { mode: "updates", notes };
    const res = (await get("/v1/whats-new")).json();
    expect(res.notes).toHaveLength(5);
    expect(res.notes[0].items[0]).toEqual({ title: "t", text: "x", link: null, icon: null });
    expect(res.notes[1].items[0]).toMatchObject({ link: "family", icon: "users" });
    h.fake.forMe = { mode: "surprise" as never, notes };
    expect((await get("/v1/whats-new")).json()).toEqual({ mode: "none", notes: [] });
    h.fake.forMe = { mode: "updates", notes: [] };
    expect((await get("/v1/whats-new")).json()).toEqual({ mode: "none", notes: [] });
  });

  it("релиз 6.1: иллюстрация (ключ каталога) и маршруты игры, словаря и чтения проходят; ключ не того формата → null", async () => {
    h.fake.onboard(s.userId);
    const routes = ["heroes", "shop", "badges", "game_history", "game_settings", "dictionary", "reading"] as const;
    const items = routes.map((link) => ({ title: link, text: "x", link, icon: "hero" as const }));
    const good = noteFixture({ slug: "s6-heroes", illustration: "s6-heroes", items });
    const bad = ["../x", "S6", "a".repeat(33), "welcome.webp", "", 7, undefined].map((illustration, i) =>
      noteFixture({ slug: `bad-${i}`, illustration: illustration as never }),
    );
    h.fake.forMe = { mode: "updates", notes: [good, ...bad.slice(0, 4)] };
    const res = await get("/v1/whats-new");
    expect(res.statusCode).toBe(200);
    expect(Value.Check(WhatsNewSchema, res.json())).toBe(true);
    const notes = res.json().notes as Array<{ illustration: string | null; items: Array<{ link: string | null }> }>;
    expect(notes[0]!.illustration).toBe("s6-heroes");
    expect(notes[0]!.items.map((i) => i.link)).toEqual([...routes]);
    expect(notes.slice(1).map((n) => n.illustration)).toEqual([null, null, null, null]);
    // лента — те же правила; домен до 6.1 (поля нет) → null
    const old = noteFixture({ slug: "old" }) as Partial<ReturnType<typeof noteFixture>>;
    delete old.illustration;
    h.fake.feed = [noteFixture({ slug: "welcome-1", audience: "new", illustration: "welcome" }), ...bad.slice(4), old as never];
    const page = (await get("/v1/news")).json();
    expect(Value.Check(NewsPageSchema, page)).toBe(true);
    expect(page.items.map((n: { illustration: string | null }) => n.illustration)).toEqual(["welcome", null, null, null, null]);
  });

  it("сбой experience-config или learning-plan → 503 (шторка не показывается); 401 без токена", async () => {
    h.fake.onboard(s.userId);
    h.fake.down.add("experience");
    expect((await get("/v1/whats-new")).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "experience-config" } });
    h.fake.down.delete("experience");
    h.fake.down.add("learningPlan");
    expect((await get("/v1/whats-new")).statusCode).toBe(503);
    expect((await h.app.inject({ url: "/v1/whats-new" })).statusCode).toBe(401);
  });
});

describe("POST /v1/whats-new/seen", () => {
  it("204, отметки от имени ученика; повтор идемпотентен; id в нижнем регистре", async () => {
    const id = randomUUID();
    const res = await seen([id.toUpperCase()]);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect((await seen([id])).statusCode).toBe(204);
    const calls = h.fake.callsTo("experience", "POST", "/internal/v1/release-notes/seen");
    expect(calls.map((c) => [c.subject, c.body])).toEqual([
      [s.userId, { release_note_ids: [id] }],
      [s.userId, { release_note_ids: [id] }],
    ]);
    expect(h.fake.seen.get(s.userId)).toEqual(new Set([id]));
  });

  it("сегмент для статистики показов: lang — locale аккаунта, age — возраст ученика; identity недоступен — без сегмента", async () => {
    h.fake.setAge(s.userId, "14-17");
    h.fake.account(s.userId).summary.locale = "uz";
    expect((await seen([randomUUID()])).statusCode).toBe(204);
    expect(h.fake.callsTo("experience", "POST", "/internal/v1/release-notes/seen")[0]!.query).toEqual({ lang: "uz", age: "teens" });
    h.fake.override("identity", "GET", "/internal/v1/me", () => domainError(503, "UPSTREAM_UNAVAILABLE"));
    expect((await seen([randomUUID()])).statusCode).toBe(204);
    expect(h.fake.callsTo("experience", "POST", "/internal/v1/release-notes/seen")[1]!.query).toEqual({});
  });

  it("422: пусто, > 20, не UUID, дубли; ошибка домена — как есть", async () => {
    for (const ids of [[], Array.from({ length: 21 }, () => randomUUID()), ["welcome-1"], (() => { const x = randomUUID(); return [x, x]; })(), "x"]) {
      expect((await seen(ids)).statusCode, JSON.stringify(ids).slice(0, 30)).toBe(422);
    }
    h.fake.override("experience", "POST", "/internal/v1/release-notes/seen", () => domainError(409, "SOMETHING"));
    expect((await seen([randomUUID()])).json().code).toBe("SOMETHING");
  });
});

describe("GET /v1/news", () => {
  it("лента для сегмента ученика (lang, age, limit, cursor), sub = ученик", async () => {
    h.fake.setAge(s.userId, "18+");
    h.fake.account(s.userId).summary.locale = "uz";
    h.fake.onboard(s.userId, { ui_lang: "ru" });
    const res = await get("/v1/news?limit=10&cursor=c1");
    expect(res.statusCode).toBe(200);
    expect(Value.Check(NewsPageSchema, res.json())).toBe(true);
    expect(res.json().items[0].slug).toBe("welcome-1");
    const call = h.fake.callsTo("experience", "GET", "/internal/v1/release-notes/feed")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.query).toEqual({ lang: "uz", age: "adults", limit: "10", cursor: "c1" });
    expect((await get("/v1/news?limit=500")).statusCode).toBe(422);
  });
});
