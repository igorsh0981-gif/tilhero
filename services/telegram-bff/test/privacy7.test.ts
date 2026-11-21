/**
 * Спринт 7 — приватность ответов ученику (APP-SOC-09, AT-81; INTERNAL_API §0): домены-подделки кладут в КАЖДЫЙ ответ
 * чужие и свои user_id, Telegram, имя, возраст, покупки, ошибки, флаги антифрода, исполнителя санкции, чужие реплики.
 * Проверка обходит ВСЕ маршруты спринта 7 (перечень — из OpenAPI по тегам social, leagues, duels, pair-rooms) у взрослого и
 * в детском профиле и требует в каждом ответе:
 *  - ни одной строки с user_id любого ученика (своего аккаунта, ребёнка, другого ученика);
 *  - UUID — только под ключами id сущностей (request_id, duel_id, room_id, …), не под member_id и не в тексте;
 *  - member_id и *_member_id — только формата mb_ + 22 символа;
 *  - ни одного служебного ключа доменов (user_id, *_user_id, telegram_user_id, display_name, age_band, risk_flags, …).
 * Семья спринта 1 (GET /v1/family) — исключение контракта: user_id членов своей семьи остаётся (управление семьёй).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOCKED_USER_ID, OTHER_MEMBER, OTHER_NAME, OTHER_TELEGRAM_ID, OTHER_USER_ID, SOCIAL_SECRET } from "./fakeSocial.js";
import { bearer, closeRedis, idem, login, makeHarness, switchTo, type Harness, type LoggedIn } from "./helpers.js";
import { makeWav } from "./wavFixture.js";

let h: Harness;
let s: LoggedIn;
beforeEach(async () => {
  h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "1000" });
  s = await login(h);
  h.fake.setAge(s.userId, "18+");
  h.fake.onboard(s.userId);
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MEMBER_RE = /^mb_[A-Za-z0-9_-]{22}$/;
/** Ключи, под которыми UUID допустим: id сущностей ученика (не людей). */
const ENTITY_ID_KEYS = new Set(["request_id", "case_id", "sanction_id", "appeal_id", "referral_id", "duel_id", "room_id", "session_id", "evaluation_id"]);
/** Служебные ключи доменов-подделок, которых не должно быть ни в одном ответе. */
const FORBIDDEN_KEY = /(^|_)user_id$|^telegram|^display_name$|^age_band$|^risk_flags$|^decided_by$|^staff_comment$|^purchases$|^errors(_week)?$|^opponent_answers$|^opponent_items$|^partner_lines$|^scores$|^evaluations$|^ai_cost_usd$|^set_id$/;

interface Seen {
  route: string;
  status: number;
  body: string;
}

/** Обход JSON: нарушения приватности (путь и правило). */
function violations(value: unknown, userIds: string[], path = ""): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...violations(v, userIds, `${path}[${i}]`)));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (FORBIDDEN_KEY.test(k)) out.push(`${p}: служебный ключ`);
      if ((k === "member_id" || k.endsWith("_member_id")) && !(typeof v === "string" && MEMBER_RE.test(v))) out.push(`${p}: не member_id`);
      if (typeof v === "string") {
        if (UUID_RE.test(v) && !ENTITY_ID_KEYS.has(k)) out.push(`${p}: UUID вне id сущности`);
        for (const id of userIds) if (v.toLowerCase().includes(id.toLowerCase())) out.push(`${p}: user_id ученика`);
      } else out.push(...violations(v, userIds, p));
    }
  }
  return out;
}

async function sprint7Routes(): Promise<Set<string>> {
  const doc = (await h.app.inject({ url: "/openapi.json" })).json() as { paths: Record<string, Record<string, { tags?: string[] }>> };
  const out = new Set<string>();
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) if ((op.tags ?? []).some((t) => ["social", "leagues", "duels", "pair-rooms"].includes(t))) out.add(`${method.toUpperCase()} ${path}`);
  }
  // league_opt_in — маршрут игры спринта 6 (тег game)
  out.add("PATCH /v1/game/settings");
  return out;
}

/** Все маршруты спринта 7 по очереди (с созданием сущностей); ответы — в seen. */
async function walk(token: string, kids: boolean): Promise<Seen[]> {
  const seen: Seen[] = [];
  async function hit(method: string, template: string, params: Record<string, string> = {}, payload?: unknown, key = false, raw?: Buffer) {
    const url = template.replace(/\{(\w+)\}/g, (_, n: string) => params[n] ?? "");
    const res = await h.app.inject({
      method: method as "GET",
      url,
      headers: { ...bearer(token), ...(key ? idem() : {}), ...(raw ? { "content-type": "audio/wav" } : {}) },
      ...(raw ? { payload: raw } : payload !== undefined ? { payload: payload as object } : {}),
    });
    seen.push({ route: `${method} ${template.split("?")[0]}`, status: res.statusCode, body: res.body });
    return res;
  }
  const js = (r: { json(): unknown }) => r.json() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  await hit("GET", "/v1/community");
  await hit("PATCH", "/v1/community", {}, { game_profile_hidden: true });
  await hit("PUT", "/v1/community/nickname", {}, { nickname: "Igor_2026" });
  await hit("POST", "/v1/community/friend-code/rotate");
  await hit("GET", "/v1/friends/search?q=Anvar_77");
  await hit("GET", "/v1/friends/requests?direction=in");
  for (const a of ["accept", "decline", "cancel"]) {
    // своя заявка на каждое действие (переход из pending)
    const req = await hit("POST", "/v1/friends/requests", {}, { member_id: OTHER_MEMBER }, true);
    await hit("POST", `/v1/friends/requests/{request_id}/${a}`, { request_id: kids ? OTHER_USER_ID : js(req).request_id });
  }
  await hit("GET", "/v1/friends");
  await hit("DELETE", "/v1/friends/{member_id}", { member_id: OTHER_MEMBER });
  await hit("POST", "/v1/blocks", {}, { member_id: OTHER_MEMBER });
  await hit("GET", "/v1/blocks");
  await hit("DELETE", "/v1/blocks/{member_id}", { member_id: OTHER_MEMBER });
  await hit("POST", "/v1/complaints", {}, { member_id: OTHER_MEMBER, subject_kind: "user", subject_id: null, reason: "spam", block: true }, true);
  const sanctions = await hit("GET", "/v1/sanctions");
  await hit("POST", "/v1/sanctions/{sanction_id}/appeal", { sanction_id: js(sanctions).items[0].sanction_id }, { text: "Прошу пересмотреть решение" }, true);
  await hit("GET", "/v1/referrals");

  await hit("GET", "/v1/game/leagues");
  await hit("GET", "/v1/game/leagues/history");
  await hit("PATCH", "/v1/game/settings", {}, { league_opt_in: !kids });
  const duel = js(await hit("POST", "/v1/game/duels", {}, { opponent_member_id: OTHER_MEMBER }, true));
  await hit("GET", "/v1/game/duels?status=active");
  await hit("GET", "/v1/game/duels/{duel_id}", { duel_id: duel.duel_id });
  await hit("POST", "/v1/game/duels/{duel_id}/accept", { duel_id: duel.duel_id });
  h.fake.social7.duels.get(duel.duel_id)!.status = "finished";
  await hit("GET", "/v1/game/duels/{duel_id}", { duel_id: duel.duel_id });
  await hit("POST", "/v1/game/duels/{duel_id}/decline", { duel_id: duel.duel_id });
  const sess = js(await hit("POST", "/v1/duel-sessions", {}, { duel_id: duel.duel_id }, true));
  await hit("GET", "/v1/duel-sessions/{session_id}/review", { session_id: sess.session_id });

  const room = js(await hit("POST", "/v1/pair-rooms", {}, { partner_member_id: OTHER_MEMBER, pair_id: "ru-en", scenario_id: "sc-cafe-order", start: "now" }, true));
  const id = { room_id: room.room_id };
  await hit("GET", "/v1/pair-rooms?status=active");
  await hit("GET", "/v1/pair-rooms/{room_id}", id);
  for (const a of ["cancel", "accept", "decline"]) await hit("POST", `/v1/pair-rooms/{room_id}/${a}`, id);
  await hit("POST", "/v1/pair-rooms/{room_id}/join", id);
  await hit("POST", "/v1/pair-rooms/{room_id}/heartbeat", id);
  await hit("GET", "/v1/pair-rooms/{room_id}/state?after_seq=0", id);
  await hit("POST", "/v1/pair-rooms/{room_id}/turns", id, { choice_id: "c1" }, true);
  await hit("POST", "/v1/pair-rooms/{room_id}/audio", id, undefined, false, makeWav());
  await hit("POST", "/v1/pair-rooms/{room_id}/leave", id);
  await hit("GET", "/v1/pair-rooms/{room_id}/report", id);
  return seen;
}

function check(seen: Seen[], userIds: string[]): void {
  for (const r of seen) {
    for (const leak of [OTHER_USER_ID, BLOCKED_USER_ID, OTHER_NAME, String(OTHER_TELEGRAM_ID), SOCIAL_SECRET, "PARTNER-SECRET-LINE", "she go", "short_lessons"]) {
      expect(r.body, `${r.route}: ${leak}`).not.toContain(leak);
    }
    if (!r.body) continue;
    if (r.route.endsWith("/report")) expect(JSON.parse(r.body), r.route).not.toHaveProperty("partner");
    const v = violations(JSON.parse(r.body), userIds);
    expect(v, `${r.route} (${r.status})`).toEqual([]);
  }
}

describe("приватность ответов спринта 7", () => {
  it("детектор ловит утечки: служебный ключ, UUID в member_id и в тексте, user_id в строке", () => {
    const v = violations(
      { user_id: "x", opponent: { member_id: OTHER_USER_ID, nickname: `id ${BLOCKED_USER_ID}` }, rows: [{ opponent_user_id: "y" }], room_id: OTHER_USER_ID },
      [OTHER_USER_ID, BLOCKED_USER_ID],
    );
    expect(v).toEqual([
      "user_id: служебный ключ",
      "opponent.member_id: не member_id",
      "opponent.member_id: UUID вне id сущности",
      "opponent.member_id: user_id ученика",
      "opponent.nickname: UUID вне id сущности",
      "opponent.nickname: user_id ученика",
      "rows[0].opponent_user_id: служебный ключ",
      "room_id: user_id ученика",
    ]);
  });

  it("взрослый: каждый маршрут спринта 7 отвечает 2xx и без user_id, Telegram, имени, возраста и служебного доменов", async () => {
    const seen = await walk(s.access, false);
    const routes = await sprint7Routes();
    expect([...routes].filter((r) => !seen.some((x) => x.route === r)), "не обойдены").toEqual([]);
    expect(seen.filter((x) => x.status >= 300).map((x) => `${x.route} ${x.status} ${x.body}`)).toEqual([]);
    check(seen, [s.userId, OTHER_USER_ID, BLOCKED_USER_ID]);
  }, 60_000);

  it("детский профиль: те же требования к каждому ответу (отказы — ErrorBody без чужих данных)", async () => {
    const child = h.fake.addChild(s.userId, "Мадина", "6-9");
    h.fake.onboard(child);
    const k = await switchTo(h, s, child);
    const seen = await walk(k.access, true);
    // друзья, блокировки, жалобы, рефералы — отказ BFF; лиги, дуэли, парный урок — в доменах
    expect(seen.filter((x) => x.route.startsWith("GET /v1/friends") || x.route.startsWith("POST /v1/blocks")).every((x) => x.status === 403)).toBe(true);
    expect(seen.find((x) => x.route === "GET /v1/game/leagues")!.status).toBe(200);
    check(seen, [s.userId, child, OTHER_USER_ID, BLOCKED_USER_ID]);
  }, 60_000);

  it("семья — исключение контракта: user_id членов своей семьи и member_id", async () => {
    h.fake.families.set(s.userId, { family_id: "f-1", members: [{ user_id: s.userId, member_id: OTHER_MEMBER, display_name: "Игорь", role: "owner", is_me: false }] });
    const f = (await h.app.inject({ url: "/v1/family", headers: bearer(s.access) })).json();
    expect(f.members[0]).toEqual({ user_id: s.userId, member_id: OTHER_MEMBER, display_name: "Игорь", role: "owner", is_me: true });
  });
});
