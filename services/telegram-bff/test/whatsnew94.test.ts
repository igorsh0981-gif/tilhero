/**
 * Доработка 9.4 «Что нового»: GET /v1/whats-new (непросмотренные ≤ 3, последняя, правило нового пользователя, аудитория,
 * ETag/304, кэш ленты и stale) и POST /v1/whats-new/seen (идемпотентно, только опубликованные, IDOR, лимиты).
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { WhatsNewResponseSchema } from "../src/schemas.js";
import type { DomainClient } from "../src/upstream.js";
import { CLIENT_MAX_NOTES, FORCE_MIN_MS, NOTE_ICONS, NOTE_ROUTES, ReleaseNotesFeed, etagMatches, pickWhatsNew, type FeedNote, type SeenState } from "../src/whatsNew.js";
import { TG_USER, bearer, closeRedis, domainError, json, login, makeHarness, type Harness, type LoggedIn, type Req } from "./helpers.js";

const FEED = "/internal/v1/release-notes/published";
const SEEN = "/internal/v1/me/release-notes/seen";
const CATALOG = JSON.parse(readFileSync(new URL("../../../packages/contracts/release-notes.json", import.meta.url), "utf8")) as {
  routes: string[];
  icons: string[];
  limits: { client_max_notes: number };
};

let seq = 0;
function note(publishedAt: string, o: Partial<FeedNote> = {}): FeedNote {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return {
    release_note_id: id,
    slug: `2026.${seq}`,
    title: { ru: `Релиз ${seq}`, en: `Release ${seq}` },
    items: [{ title: { ru: "Пункт", en: "Item" }, text: { ru: "Текст", en: "Text" }, link: "catalog", icon: "spark" }],
    audience: "existing",
    published_at: publishedAt,
    ...o,
  };
}

const D = (day: number) => `2026-11-${String(day).padStart(2, "0")}T06:00:00.000Z`;
const seenOf = (published_at: string | null, onboarded: string | null = D(1)): SeenState => ({
  release_note_id: published_at ? "x" : null,
  published_at,
  onboarding_completed_at: onboarded,
});

describe("pickWhatsNew — правила отбора", () => {
  const n5 = note(D(5));
  const n10 = note(D(10));
  const n15 = note(D(15));
  const n20 = note(D(20));
  const feed = [n20, n15, n10, n5];

  it("отметка есть: только новее отметки, новые первыми, не больше трёх", () => {
    expect(pickWhatsNew(feed, seenOf(D(10))).items).toEqual([n20, n15]);
    expect(pickWhatsNew(feed, seenOf(D(20))).items).toEqual([]);
    expect(pickWhatsNew(feed, seenOf(D(2))).items).toEqual([n20, n15, n10]);
    expect(CLIENT_MAX_NOTES).toBe(CATALOG.limits.client_max_notes);
  });

  it("первое обращение пользователя, бывшего до заметок: изменения с его прихода, без отметки", () => {
    const r = pickWhatsNew(feed, seenOf(null, D(12)));
    expect(r.items).toEqual([n20, n15]);
    expect(r.baseline).toBeNull();
  });

  it("новый пользователь (онбординг после последней заметки): старых не видит, последняя → просмотрена", () => {
    const r = pickWhatsNew(feed, seenOf(null, D(25)));
    expect(r.items).toEqual([]);
    expect(r.baseline).toBe(n20);
  });

  it("новый пользователь и последняя заметка «для всех» — видит только её, отметка — при закрытии", () => {
    const all = note(D(21), { audience: "all" });
    const r = pickWhatsNew([all, ...feed], seenOf(null, D(25)));
    expect(r.items).toEqual([all]);
    expect(r.baseline).toBeNull();
  });

  it("«только существующие»: пользователь, пришедший после публикации, её не видит (даже со старой отметкой)", () => {
    const late = note(D(18));
    const r = pickWhatsNew([late, n5], { release_note_id: "x", published_at: D(5), onboarding_completed_at: D(19) });
    expect(r.items).toEqual([]);
    const everyone = note(D(18), { audience: "all" });
    expect(pickWhatsNew([everyone, n5], { release_note_id: "x", published_at: D(5), onboarding_completed_at: D(19) }).items).toEqual([everyone]);
  });

  it("онбординг не пройден или заметок нет — ничего и без отметки", () => {
    expect(pickWhatsNew(feed, seenOf(null, null))).toEqual({ items: [], baseline: null });
    expect(pickWhatsNew([], seenOf(null))).toEqual({ items: [], baseline: null });
  });

  it("белые списки маршрутов и иконок = packages/contracts/release-notes.json", () => {
    expect([...NOTE_ROUTES]).toEqual(CATALOG.routes);
    expect([...NOTE_ICONS]).toEqual(CATALOG.icons);
  });

  it("If-None-Match: точное, слабое, список, *", () => {
    expect(etagMatches('W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('"x", W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches("*", 'W/"abc"')).toBe(true);
    expect(etagMatches('W/"abd"', 'W/"abc"')).toBe(false);
    expect(etagMatches(undefined, 'W/"abc"')).toBe(false);
  });
});

describe("ReleaseNotesFeed — кэш ленты", () => {
  afterEach(() => vi.restoreAllMocks());

  it("TTL, принудительное перечитывание не чаще раза в 5 с, stale при сбое, сортировка по времени публикации", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const a = note(D(3));
    const b = note(D(9));
    let items: FeedNote[] = [a, b];
    let fail = false;
    let calls = 0;
    const client = {
      get: async () => {
        calls += 1;
        if (fail) throw new Error("down");
        return { items };
      },
    } as unknown as DomainClient;
    let stale = 0;
    const f = new ReleaseNotesFeed(client, 60_000, () => (stale += 1));
    expect((await f.get()).map((n) => n.release_note_id)).toEqual([b.release_note_id, a.release_note_id]);
    items = [note(D(12)), b, a];
    expect(await f.get(true)).toHaveLength(2); // кэш моложе 5 с — без запроса
    expect(calls).toBe(1);
    now += FORCE_MIN_MS;
    expect(await f.get(true)).toHaveLength(3);
    expect(calls).toBe(2);
    expect(await f.get()).toHaveLength(3); // в пределах TTL
    expect(calls).toBe(2);
    now += 61_000;
    fail = true;
    expect(await f.get()).toHaveLength(3); // stale
    expect(stale).toBe(1);
  });
});

describe("GET /v1/whats-new, POST /v1/whats-new/seen", () => {
  let h: Harness;
  let s: LoggedIn;
  let feed: FeedNote[];
  const seen = new Map<string, SeenState>();
  let onboarded: string | null;

  const stateOf = (r: Req): SeenState =>
    seen.get(r.subject!) ?? { release_note_id: null, published_at: null, onboarding_completed_at: onboarded };

  beforeEach(async () => {
    h = await makeHarness({ EXPERIENCE_CACHE_SECONDS: "60" });
    s = await login(h);
    seen.clear();
    onboarded = D(1);
    feed = [note(D(20)), note(D(10))];
    h.fake.override("experience", "GET", FEED, () => json(200, { items: feed }));
    h.fake.override("preferences", "GET", SEEN, (r) => (r.subject ? json(200, stateOf(r)) : domainError(401, "SUBJECT_REQUIRED")));
    h.fake.override("preferences", "PUT", SEEN, (r) => {
      const cur = stateOf(r);
      const body = r.body as { release_note_id: string; published_at: string };
      const next = !cur.published_at || Date.parse(body.published_at) > Date.parse(cur.published_at) ? { ...cur, ...body } : cur;
      seen.set(r.subject!, next);
      return json(200, next);
    });
  });
  afterEach(async () => {
    await h?.close();
  });
  afterAll(closeRedis);

  const get = (headers: Record<string, string> = {}, who = s) => h.app.inject({ url: "/v1/whats-new", headers: { ...bearer(who.access), ...headers } });
  const mark = (payload: object, who = s) => h.app.inject({ method: "POST", url: "/v1/whats-new/seen", headers: bearer(who.access), payload });

  it("непросмотренные + последняя; аудитория в Mini App не уходит; закрытие → пусто", async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Value.Check(WhatsNewResponseSchema, body)).toBe(true);
    expect(body.items.map((n: { release_note_id: string }) => n.release_note_id)).toEqual([feed[0]!.release_note_id, feed[1]!.release_note_id]);
    expect(body.latest.release_note_id).toBe(feed[0]!.release_note_id);
    expect(JSON.stringify(body)).not.toContain("audience");
    expect(r.headers["cache-control"]).toBe("private, no-cache");
    expect(r.headers.etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);

    const m = await mark({ release_note_id: feed[0]!.release_note_id });
    expect(m.statusCode).toBe(200);
    expect(m.json()).toEqual({ last_seen_release_note_id: feed[0]!.release_note_id });
    // время публикации — из ленты, не от клиента
    expect(h.fake.callsTo("preferences", "PUT", SEEN).at(-1)!.body).toEqual({ release_note_id: feed[0]!.release_note_id, published_at: D(20) });
    const after = (await get()).json();
    expect(after.items).toEqual([]);
    expect(after.latest.release_note_id).toBe(feed[0]!.release_note_id); // пункт «Что нового» в профиле
    // повтор и более старая заметка — no-op, отметка остаётся на новой
    expect((await mark({ release_note_id: feed[0]!.release_note_id })).json().last_seen_release_note_id).toBe(feed[0]!.release_note_id);
    expect((await mark({ release_note_id: feed[1]!.release_note_id })).json().last_seen_release_note_id).toBe(feed[0]!.release_note_id);
  });

  it("ETag: тот же ответ → 304 без тела; новое содержимое → 200 с другим ETag", async () => {
    const first = await get();
    const etag = first.headers.etag as string;
    const again = await get({ "if-none-match": etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    await mark({ release_note_id: feed[0]!.release_note_id });
    const changed = await get({ "if-none-match": etag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it("новый пользователь: старые заметки не показываются, последняя отмечается при первом входе", async () => {
    onboarded = D(25);
    const r = await get();
    expect(r.json().items).toEqual([]);
    expect(r.json().latest.release_note_id).toBe(feed[0]!.release_note_id);
    expect(seen.get(s.userId)?.release_note_id).toBe(feed[0]!.release_note_id);
    // сбой записи отметки не ломает ответ
    seen.clear();
    h.fake.override("preferences", "PUT", SEEN, () => domainError(500, "BOOM"));
    expect((await get()).statusCode).toBe(200);
  });

  it("онбординг не пройден — пусто, без отметки", async () => {
    onboarded = null;
    expect((await get()).json().items).toEqual([]);
    expect(h.fake.callsTo("preferences", "PUT", SEEN)).toHaveLength(0);
  });

  it("seen: черновик/архив/неизвестный id → 404 (лента перечитывается мимо кэша не чаще раза в 5 с)", async () => {
    await get(); // кэш ленты прогрет
    const before = h.fake.callsTo("experience", "GET", FEED).length;
    const unknown = await mark({ release_note_id: "11111111-1111-4111-8111-111111111111" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe("WHATS_NEW_NOT_FOUND");
    for (let i = 0; i < 5; i++) await mark({ release_note_id: `11111111-1111-4111-8111-11111111111${i}` });
    expect(h.fake.callsTo("experience", "GET", FEED).length - before).toBeLessThanOrEqual(1);
    expect(h.fake.callsTo("preferences", "PUT", SEEN)).toHaveLength(0);
  });

  it("IDOR: пользователь — только из сессии; лишние поля и чужой user_id → 422; отметка одного не видна другому", async () => {
    const other = await login(h, { ...TG_USER, id: 900777, username: "other_user" });
    const smuggled = await mark({ release_note_id: feed[0]!.release_note_id, user_id: other.userId });
    expect(smuggled.statusCode).toBe(422);
    expect(h.fake.callsTo("preferences", "PUT", SEEN)).toHaveLength(0);
    await mark({ release_note_id: feed[0]!.release_note_id });
    const puts = h.fake.callsTo("preferences", "PUT", SEEN);
    expect(puts.every((c) => c.subject === s.userId)).toBe(true);
    expect((await get({}, other)).json().items).toHaveLength(2);
    for (const bad of [{}, { release_note_id: "not-a-uuid" }, { release_note_id: 1 }]) expect((await mark(bad)).statusCode).toBe(422);
  });

  it("без сессии — 401; домен недоступен без кэша — 503; с кэшем — последняя лента (stale)", async () => {
    expect((await h.app.inject({ url: "/v1/whats-new" })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "POST", url: "/v1/whats-new/seen", payload: { release_note_id: feed[0]!.release_note_id } })).statusCode).toBe(401);
    h.fake.down.add("experience");
    const down = await get();
    expect(down.statusCode).toBe(503);
    expect(down.json().code).toBe("UPSTREAM_UNAVAILABLE");
    h.fake.down.delete("experience");
    expect((await get()).statusCode).toBe(200);
  });

  it("смешанная раскатка: старый experience-config/preferences без маршрутов → 404 (не 503), Mini App шторку не показывает", async () => {
    h.fake.override("experience", "GET", FEED, () => domainError(404, "NOT_FOUND"));
    const r = await get();
    expect(r.statusCode).toBe(404);
    h.fake.override("experience", "GET", FEED, () => json(200, { items: feed }));
    h.fake.override("preferences", "GET", SEEN, () => domainError(404, "NOT_FOUND"));
    const p = await h.app.inject({ url: "/v1/whats-new", headers: bearer(s.access) });
    expect(p.statusCode).toBe(404);
  });

  it("недоверенные данные домена: маршрут/иконка не из списка → null, лишние поля не уходят", async () => {
    feed = [
      note(D(22), {
        items: [{ title: { ru: "<b>x</b>", en: "x" }, text: { ru: "<script>alert(1)</script>", en: "t" }, link: "javascript:alert(1)" as never, icon: "skull" as never }],
        ...({ created_by: "staff-1", internal: true } as object),
      }),
    ];
    const body = (await get()).json();
    const item = body.items[0].items[0];
    expect(item.link).toBeNull();
    expect(item.icon).toBeNull();
    expect(item.text.ru).toBe("<script>alert(1)</script>"); // текст как есть — Mini App выводит его только как текст
    expect(JSON.stringify(body)).not.toContain("staff-1");
  });
});
