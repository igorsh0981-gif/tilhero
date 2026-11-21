/**
 * Спринт 7 — «Социальное» через admin-bff: social (друзья и жалобы, модерация, реферальные кампании и очередь проверки),
 * gamification (лиги недели и дуэли), lessons (парные комнаты). Каждый маршрут — happy path (домен, путь, actor,
 * `X-Step-Up: ok` ровно у команд со step-up), 401, 403 без права, step-up (статический и по телу решения по делу), 422 до
 * домена, адрес домена не задан и домен недоступен → 503; права ролей PLAN спринта 7; строгие кодеки (лишнее — реплики,
 * оценки, переписка, ник второй стороны — отбрасывается, чужие значения перечислений → 503); Idempotency-Key, If-Match,
 * коды домена как есть; блок главной `social` (с недоступными social, gamification, lessons); общие типы спринта 7
 * (категория уведомлений game, room_cap_usd, правила игры, SessionKind duel, маршруты «Что нового»).
 * Общие матрицы (все маршруты admin-bff) — routes.test.ts и security.test.ts.
 */
import { Ajv, type ValidateFunction } from "ajv";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AdminCase,
  AdminDuel,
  AdminLeagueGroup,
  AdminLeagueWeek,
  AdminLearnerCard,
  AdminPairRoom,
  AdminReferral,
  AdminSanction,
  AdminSanctionAppeal,
  AdminSocialCard,
  AiBudget,
  Dashboard,
  Page,
  ReferralCampaignVersion,
  RulesVersion,
} from "@tilhero/contracts/admin";
import { strictContractSchema } from "../src/responses.js";
import { resolveNeedsStepUp } from "../src/routes/social.js";
import { maskFriendCode } from "../src/contractSocial.js";
import {
  CASE_ID,
  DUEL_ID,
  GROUP_ID,
  LEARNER_ID,
  LEARNER_USER_ID,
  MEMBER_ID,
  REFERRAL_ID,
  ROOM_ID,
  SANCTION_APPEAL_ID,
  SANCTION_ID,
  SOCIAL_STAFF_ID,
  TARGET_USER_ID,
  WEEK,
  aiBudget,
  browser,
  campaignPayload,
  campaignVersionDomain,
  caseDomain,
  caseRowDomain,
  closeRedis,
  domainError,
  duelDomain,
  gameRulesPayload,
  json,
  learnerCard,
  leagueGroupDomain,
  leagueWeekDomain,
  loginAs,
  makeHarness,
  pairRoomDomain,
  pairRoomRowDomain,
  referralDomain,
  rulesVersionDomain,
  sanctionDomain,
  socialCardDomain,
  stepUp,
  templateInfo,
  type Harness,
  type Service,
  type Session,
} from "./helpers.js";

/** Нарушения схем контракта (строгий Ajv по каждому 2xx до сериализации — как routes.test.ts). */
const violations: string[] = [];
const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new WeakMap<object, ValidateFunction>();
function probe(req: FastifyRequest, reply: FastifyReply, payload: unknown): void {
  const status = reply.statusCode;
  if (status < 200 || status >= 300) return;
  const resp = (req.routeOptions.schema?.response ?? {}) as Record<string, object>;
  const schema = resp[String(status)] ?? resp[`${String(status)[0]}xx`];
  if (!schema) return void violations.push(`${req.method} ${req.routeOptions.url} ${status}: нет схемы ответа`);
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(strictContractSchema(schema) as object);
    compiled.set(schema, validate);
  }
  if (!validate(payload)) violations.push(`${req.method} ${req.routeOptions.url} ${status}: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
}

let h: Harness;
beforeEach(async () => {
  violations.length = 0;
  h = await makeHarness({}, { responseProbe: probe });
  h.fake.addStaff({ role: "support", staff_id: SOCIAL_STAFF_ID, display_name: "Нигора Модератор" });
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const IA = "/internal/v1/admin";
const MOD = "/admin/v1/moderation";
const REF = "/admin/v1/referrals";
const GM = "/admin/v1/game";
const ROOMS = "/admin/v1/pair-rooms";
const IK = (k: string) => ({ "idempotency-key": `soc-${k}-0001` });
const BAN = { action: "social_ban", days: 3, basis: "Оскорбительный ник в лиге" };

interface Case {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  status: number;
  /** домен и путь, которые обязаны быть вызваны */
  service: Service;
  path: string;
  /** недопустимый вход → 422 до домена */
  invalid: { url?: string; payload?: unknown; headers?: Record<string, string> };
}

/** Все 29 маршрутов раздела: ключ — "<METHOD> <шаблон>" как в app.adminRoutes. */
const CASES: Record<string, Case> = {
  // ---------- social: карточка ученика
  "GET /admin/v1/social/users/:userId": {
    method: "GET",
    url: `/admin/v1/social/users/${LEARNER_USER_ID.toUpperCase()}`,
    status: 200,
    service: "social",
    path: `${IA}/social/users/${LEARNER_USER_ID}`,
    invalid: { url: "/admin/v1/social/users/42" },
  },
  // ---------- social: модерация
  "GET /admin/v1/moderation/cases": {
    method: "GET",
    url: `${MOD}/cases?status=open&cursor=c1&limit=20`,
    status: 200,
    service: "social",
    path: `${IA}/moderation/cases`,
    invalid: { url: `${MOD}/cases?status=closed` },
  },
  "GET /admin/v1/moderation/cases/:caseId": {
    method: "GET",
    url: `${MOD}/cases/${CASE_ID}`,
    status: 200,
    service: "social",
    path: `${IA}/moderation/cases/${CASE_ID}`,
    invalid: { url: `${MOD}/cases/42` },
  },
  "POST /admin/v1/moderation/cases/:caseId/resolve": {
    method: "POST",
    url: `${MOD}/cases/${CASE_ID}/resolve`,
    payload: BAN,
    headers: IK("resolve"),
    status: 200,
    service: "social",
    path: `${IA}/moderation/cases/${CASE_ID}/resolve`,
    invalid: { payload: { ...BAN, action: "warning" } },
  },
  "GET /admin/v1/moderation/sanctions": {
    method: "GET",
    url: `${MOD}/sanctions?user_id=${TARGET_USER_ID}&active=true`,
    status: 200,
    service: "social",
    path: `${IA}/moderation/sanctions`,
    invalid: { url: `${MOD}/sanctions?active=yes` },
  },
  "POST /admin/v1/moderation/sanctions/:sanctionId/revoke": {
    method: "POST",
    url: `${MOD}/sanctions/${SANCTION_ID}/revoke`,
    payload: { reason: "Ошибка модератора, снимаем" },
    status: 200,
    service: "social",
    path: `${IA}/moderation/sanctions/${SANCTION_ID}/revoke`,
    invalid: { payload: { reason: "коротко" } },
  },
  "GET /admin/v1/moderation/appeals": {
    method: "GET",
    url: `${MOD}/appeals?status=open`,
    status: 200,
    service: "social",
    path: `${IA}/moderation/appeals`,
    invalid: { url: `${MOD}/appeals?status=new` },
  },
  "POST /admin/v1/moderation/appeals/:appealId/decide": {
    method: "POST",
    url: `${MOD}/appeals/${SANCTION_APPEAL_ID}/decide`,
    payload: { decision: "overturned", note: "Ник исправлен, санкция снята" },
    status: 200,
    service: "social",
    path: `${IA}/moderation/appeals/${SANCTION_APPEAL_ID}/decide`,
    invalid: { payload: { decision: "corrected", note: "Ник исправлен, санкция снята" } },
  },
  // ---------- social: реферальные кампании и очередь проверки
  "GET /admin/v1/referrals/campaigns": {
    method: "GET",
    url: `${REF}/campaigns`,
    status: 200,
    service: "social",
    path: `${IA}/referrals/campaigns`,
    invalid: { url: `${REF}/campaigns?status=draft` },
  },
  "GET /admin/v1/referrals/campaigns/stats": {
    method: "GET",
    url: `${REF}/campaigns/stats`,
    status: 200,
    service: "social",
    path: `${IA}/referrals/campaigns/stats`,
    invalid: { url: `${REF}/campaigns/stats?version=1` },
  },
  "GET /admin/v1/referrals/campaigns/:version": {
    method: "GET",
    url: `${REF}/campaigns/1`,
    status: 200,
    service: "social",
    path: `${IA}/referrals/campaigns/1`,
    invalid: { url: `${REF}/campaigns/0` },
  },
  "PUT /admin/v1/referrals/campaigns/draft": {
    method: "PUT",
    url: `${REF}/campaigns/draft`,
    payload: { payload: campaignPayload({ monthly_cap: 12 }), comment: "Лимит 12 в месяц", based_on: 1 },
    headers: { "if-match": "2026-11-20T09:00:00.000Z" },
    status: 200,
    service: "social",
    path: `${IA}/referrals/campaigns/draft`,
    invalid: { payload: { payload: [1, 2], comment: null, based_on: null } },
  },
  "DELETE /admin/v1/referrals/campaigns/draft": {
    method: "DELETE",
    url: `${REF}/campaigns/draft`,
    status: 204,
    service: "social",
    path: `${IA}/referrals/campaigns/draft`,
    invalid: { payload: { force: true } },
  },
  "POST /admin/v1/referrals/campaigns/draft/validate": {
    method: "POST",
    url: `${REF}/campaigns/draft/validate`,
    status: 200,
    service: "social",
    path: `${IA}/referrals/campaigns/draft/validate`,
    invalid: { payload: { strict: true } },
  },
  "POST /admin/v1/referrals/campaigns/draft/activate": {
    method: "POST",
    url: `${REF}/campaigns/draft/activate`,
    payload: { comment: "Новый лимит на декабрь" },
    headers: IK("activate"),
    status: 200,
    service: "social",
    path: `${IA}/referrals/campaigns/draft/activate`,
    invalid: { payload: { comment: "коротко" } },
  },
  "GET /admin/v1/referrals": {
    method: "GET",
    url: `${REF}?status=review&limit=50`,
    status: 200,
    service: "social",
    path: `${IA}/referrals`,
    invalid: { url: `${REF}?status=paid` },
  },
  "GET /admin/v1/referrals/:referralId": {
    method: "GET",
    url: `${REF}/${REFERRAL_ID}`,
    status: 200,
    service: "social",
    path: `${IA}/referrals/${REFERRAL_ID}`,
    invalid: { url: `${REF}/not-a-uuid` },
  },
  "POST /admin/v1/referrals/:referralId/approve": {
    method: "POST",
    url: `${REF}/${REFERRAL_ID}/approve`,
    payload: { note: "Уроки реальные, проверено" },
    status: 200,
    service: "social",
    path: `${IA}/referrals/${REFERRAL_ID}/approve`,
    invalid: { payload: { note: "ок" } },
  },
  "POST /admin/v1/referrals/:referralId/reject": {
    method: "POST",
    url: `${REF}/${REFERRAL_ID}/reject`,
    payload: { reject_code: "review_rejected", note: "Уроки по минуте подряд" },
    status: 200,
    service: "social",
    path: `${IA}/referrals/${REFERRAL_ID}/reject`,
    invalid: { payload: { reject_code: "monthly_cap", note: "Уроки по минуте подряд" } },
  },
  // ---------- gamification: лиги и дуэли
  "GET /admin/v1/game/leagues": {
    method: "GET",
    url: `${GM}/leagues?week=${WEEK}`,
    status: 200,
    service: "gamification",
    path: `${IA}/game/leagues`,
    invalid: { url: `${GM}/leagues?week=2026-11-17` },
  },
  "GET /admin/v1/game/leagues/:groupId": {
    method: "GET",
    url: `${GM}/leagues/${GROUP_ID}`,
    status: 200,
    service: "gamification",
    path: `${IA}/game/leagues/${GROUP_ID}`,
    invalid: { url: `${GM}/leagues/1` },
  },
  "POST /admin/v1/game/leagues/:groupId/reevaluate": {
    method: "POST",
    url: `${GM}/leagues/${GROUP_ID}/reevaluate`,
    payload: { exclude_user_ids: [LEARNER_USER_ID], reason: "Накрутка XP, исключаем" },
    headers: IK("league"),
    status: 200,
    service: "gamification",
    path: `${IA}/game/leagues/${GROUP_ID}/reevaluate`,
    invalid: { payload: { exclude_user_ids: ["x"], reason: "Накрутка XP, исключаем" } },
  },
  "POST /admin/v1/game/leagues/:groupId/release-prizes": {
    method: "POST",
    url: `${GM}/leagues/${GROUP_ID}/release-prizes`,
    payload: { reason: "Аномалия проверена: честно" },
    status: 200,
    service: "gamification",
    path: `${IA}/game/leagues/${GROUP_ID}/release-prizes`,
    invalid: { payload: {} },
  },
  "GET /admin/v1/game/duels": {
    method: "GET",
    url: `${GM}/duels?status=finished&limit=20`,
    status: 200,
    service: "gamification",
    path: `${IA}/game/duels`,
    invalid: { url: `${GM}/duels?status=running` },
  },
  "GET /admin/v1/game/duels/:duelId": {
    method: "GET",
    url: `${GM}/duels/${DUEL_ID}`,
    status: 200,
    service: "gamification",
    path: `${IA}/game/duels/${DUEL_ID}`,
    invalid: { url: `${GM}/duels/abc` },
  },
  "POST /admin/v1/game/duels/:duelId/reevaluate": {
    method: "POST",
    url: `${GM}/duels/${DUEL_ID}/reevaluate`,
    payload: { result: "draw", reason: "Сбой проверки ответа 7" },
    status: 200,
    service: "gamification",
    path: `${IA}/game/duels/${DUEL_ID}/reevaluate`,
    invalid: { payload: { result: "none", reason: "Сбой проверки ответа 7" } },
  },
  // ---------- lessons: парные комнаты
  "GET /admin/v1/pair-rooms": {
    method: "GET",
    url: `${ROOMS}?status=in_progress&from=2026-11-01&to=2026-11-30T23:59:59Z&limit=20`,
    status: 200,
    service: "lessons",
    path: `${IA}/pair-rooms`,
    invalid: { url: `${ROOMS}?status=closed` },
  },
  "GET /admin/v1/pair-rooms/:roomId": {
    method: "GET",
    url: `${ROOMS}/${ROOM_ID}`,
    status: 200,
    service: "lessons",
    path: `${IA}/pair-rooms/${ROOM_ID}`,
    invalid: { url: `${ROOMS}/xyz` },
  },
  "POST /admin/v1/pair-rooms/:roomId/stop": {
    method: "POST",
    url: `${ROOMS}/${ROOM_ID}/stop`,
    payload: { reason: "Грубость в комнате, жалоба" },
    status: 200,
    service: "lessons",
    path: `${IA}/pair-rooms/${ROOM_ID}/stop`,
    invalid: { payload: { reason: "стоп" } },
  },
};

const SECTION = [`${GM}/leagues`, `${GM}/duels`, "/admin/v1/social/", `${MOD}/`, REF, ROOMS];
const sectionRoutes = () => h.app.adminRoutes.filter((r) => SECTION.some((pre) => r.url === pre || r.url.startsWith(pre)));
const SERVICES: Service[] = ["social", "gamification", "lessons"];
const sectionCalls = () => h.fake.calls.filter((c) => SERVICES.includes(c.service) && c.path.startsWith(IA));

const inject = (s: Session | null, c: { method: Case["method"]; url: string; payload?: unknown; headers?: Record<string, string> }) =>
  h.app.inject({
    method: c.method,
    url: c.url,
    headers: { ...browser(s), ...c.headers },
    ...(c.method === "GET" ? {} : { payload: (c.payload ?? {}) as object }),
  });
const get = (s: Session, url: string) => h.app.inject({ url, headers: browser(s) });
const send = (s: Session, method: Case["method"], url: string, payload?: unknown, headers: Record<string, string> = {}) => inject(s, { method, url, payload, headers });
const run = (s: Session, key: string, over: Partial<Case> = {}) => inject(s, { ...CASES[key]!, ...over });

function denied(res: { statusCode: number; json(): { code: string; details: { permission?: string } } }, permission: string) {
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission } });
}
function unavailable(res: { statusCode: number; json(): unknown }, service: string) {
  expect(res.statusCode).toBe(503);
  expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service } });
}

// ---------------------------------------------------------------- каждый маршрут

describe("маршруты «Социального»: каждый", () => {
  it("таблица покрывает все 29 маршрутов раздела; step-up статически — ровно 4 команды", () => {
    const have = sectionRoutes().map((r) => `${r.method} ${r.url}`).sort();
    expect(have).toEqual(Object.keys(CASES).sort());
    expect(have).toHaveLength(29);
    expect(sectionRoutes().filter((r) => r.stepUp).map((r) => `${r.method} ${r.url} ${r.guard}`).sort()).toEqual([
      "POST /admin/v1/game/duels/:duelId/reevaluate league.manage",
      "POST /admin/v1/game/leagues/:groupId/reevaluate league.manage",
      "POST /admin/v1/pair-rooms/:roomId/stop room.manage",
      "POST /admin/v1/referrals/campaigns/draft/activate referral.manage",
    ]);
  });

  it("happy path: статус, домен и путь с actor; X-Step-Up: ok — у команд со step-up и у решения по делу при свежем step-up; Idempotency-Key передаётся; ответ строго по контракту", async () => {
    const { staff, s } = await loginAs(h, "super_admin", { display_name: "Супер Админ" });
    await stepUp(h, s);
    const withStepUp = new Set([...sectionRoutes().filter((r) => r.stepUp).map((r) => `${r.method} ${r.url}`), "POST /admin/v1/moderation/cases/:caseId/resolve"]);
    for (const [key, c] of Object.entries(CASES)) {
      const before = h.fake.calls.length;
      const res = await inject(s, c);
      expect(res.statusCode, `${key}: ${res.body.slice(0, 300)}`).toBe(c.status);
      const calls = h.fake.calls.slice(before).filter((x) => x.service === c.service && x.path.startsWith(IA));
      expect(calls, key).toHaveLength(1);
      const call = calls[0]!;
      expect(`${call.method} ${call.path}`, key).toBe(`${c.method} ${c.path}`);
      expect(call.actor, key).toMatchObject({ id: staff.staff_id, role: "super_admin", name: "Супер Админ" });
      expect(call.headers["x-step-up"], key).toBe(withStepUp.has(key) ? "ok" : undefined);
      if (c.headers?.["idempotency-key"]) expect(call.headers["idempotency-key"], key).toBe(c.headers["idempotency-key"]);
    }
    expect(violations).toEqual([]);
  });

  it("401: без сессии и с чужой cookie — на каждом маршруте, домены не вызываются", async () => {
    for (const [key, c] of Object.entries(CASES)) {
      for (const s of [null, { id: "Z".repeat(43), csrf: "x" } as Session]) {
        const res = await inject(s, c);
        expect(res.statusCode, key).toBe(401);
        expect(res.json().code, key).toBe("UNAUTHORIZED");
      }
    }
    expect(sectionCalls()).toHaveLength(0);
  });

  it("403: роли без прав социального (read_only, communications, qa_analyst, methodist) — на каждом маршруте, домены не вызываются", async () => {
    for (const role of ["read_only", "communications", "qa_analyst", "methodist"] as const) {
      const { s } = await loginAs(h, role);
      for (const [key, c] of Object.entries(CASES)) {
        const route = sectionRoutes().find((r) => `${r.method} ${r.url}` === key)!;
        denied(await inject(s, c), route.guard);
      }
    }
    expect(sectionCalls()).toHaveLength(0);
  });

  it("step-up: без свежего TOTP → 403 STEP_UP_REQUIRED {permission} на 4 командах (и до проверки тела), домены не вызываются", async () => {
    const { s } = await loginAs(h, "operations");
    for (const r of sectionRoutes().filter((x) => x.stepUp)) {
      const key = `${r.method} ${r.url}`;
      for (const payload of [CASES[key]!.payload, CASES[key]!.invalid.payload]) {
        const res = await inject(s, { ...CASES[key]!, payload });
        expect(res.statusCode, key).toBe(403);
        expect(res.json(), key).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: r.guard } });
      }
    }
    expect(sectionCalls()).toHaveLength(0);
  });

  it("422: недопустимый вход (путь, параметры, тело) — на каждом маршруте до домена", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    for (const [key, c] of Object.entries(CASES)) {
      const res = await inject(s, { method: c.method, url: c.invalid.url ?? c.url, payload: c.invalid.payload ?? c.payload, headers: c.invalid.headers ?? c.headers });
      expect(res.statusCode, `${key}: ${res.body.slice(0, 200)}`).toBe(422);
      expect(res.json().code, key).toBe("VALIDATION_ERROR");
    }
    expect(sectionCalls()).toHaveLength(0);
  });

  it("домен недоступен (сеть) или 5xx → 503 UPSTREAM_UNAVAILABLE {service} на каждом маршруте; тело 5xx не уходит", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    // 5xx — первым проходом (после 5 сбоев circuit breaker домена открыт, ответ тот же 503), затем сеть
    for (const [key, c] of Object.entries(CASES)) {
      h.fake.on(c.service, c.method, c.path, () => domainError(500, "BOOM", { secret: "s3cr3t" }));
      const res = await inject(s, c);
      unavailable(res, c.service);
      expect(res.body, key).not.toContain("s3cr3t");
    }
    for (const svc of SERVICES) h.fake.down.add(svc);
    for (const c of Object.values(CASES)) unavailable(await inject(s, c), c.service);
  });

  it("SOCIAL_URL не задана → 503 {service: social} на маршрутах social (после права и step-up); лиги, комнаты и остальная админка работают", async () => {
    await h.close();
    h = await makeHarness({ SOCIAL_URL: "" });
    expect(h.config.socialUrl).toBeNull();
    expect(h.logs.text).toContain("SOCIAL_URL is not set");
    const ro = (await loginAs(h, "read_only")).s;
    denied(await get(ro, `${MOD}/cases`), "moderation.manage");
    const { s } = await loginAs(h, "super_admin");
    expect((await run(s, "POST /admin/v1/referrals/campaigns/draft/activate")).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    for (const [key, c] of Object.entries(CASES)) {
      const res = await inject(s, c);
      if (c.service === "social") unavailable(res, "social");
      else expect(res.statusCode, key).toBe(c.status);
    }
    expect(h.fake.callsTo("social")).toHaveLength(0);
    expect((await get(s, "/admin/v1/game/heroes")).statusCode).toBe(200);
  });

  it("GAMIFICATION_URL не задана → 503 {service: gamification} на лигах и дуэлях; social и комнаты работают", async () => {
    await h.close();
    h = await makeHarness({ GAMIFICATION_URL: "" });
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    for (const [key, c] of Object.entries(CASES)) {
      const res = await inject(s, c);
      if (c.service === "gamification") unavailable(res, "gamification");
      else expect(res.statusCode, key).toBe(c.status);
    }
    expect(h.fake.callsTo("gamification")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- права по ролям PLAN спринта 7

describe("права по ролям (PLAN спринта 7 «Права»)", () => {
  it("support: карточка, модерация (без step-up до 7 дней), чтение рефералов и комнат; без решений по рефералам, остановки комнат и лиг", async () => {
    const { s } = await loginAs(h, "support");
    for (const key of ["GET /admin/v1/social/users/:userId", "GET /admin/v1/moderation/cases", "GET /admin/v1/referrals", "GET /admin/v1/referrals/campaigns", "GET /admin/v1/pair-rooms/:roomId"]) {
      expect((await run(s, key)).statusCode, key).toBe(200);
    }
    expect((await run(s, "POST /admin/v1/moderation/cases/:caseId/resolve", { payload: { ...BAN, days: 7 } })).statusCode).toBe(200);
    expect((await run(s, "POST /admin/v1/moderation/sanctions/:sanctionId/revoke")).statusCode).toBe(200);
    denied(await run(s, "POST /admin/v1/referrals/:referralId/approve"), "referral.manage");
    denied(await run(s, "PUT /admin/v1/referrals/campaigns/draft"), "referral.manage");
    denied(await run(s, "POST /admin/v1/pair-rooms/:roomId/stop"), "room.manage");
    denied(await run(s, "GET /admin/v1/game/leagues"), "league.read");
    denied(await run(s, "GET /admin/v1/game/duels"), "league.read");
  });

  it("content_manager: только лиги и дуэли на чтение", async () => {
    const { s } = await loginAs(h, "content_manager");
    expect((await run(s, "GET /admin/v1/game/leagues")).statusCode).toBe(200);
    expect((await run(s, "GET /admin/v1/game/duels/:duelId")).statusCode).toBe(200);
    denied(await run(s, "POST /admin/v1/game/leagues/:groupId/release-prizes"), "league.manage");
    denied(await run(s, "GET /admin/v1/social/users/:userId"), "social.read");
    denied(await run(s, "GET /admin/v1/pair-rooms"), "room.read");
  });

  it("analyst, auditor: всё чтение (*.read), без модерации и команд", async () => {
    for (const role of ["analyst", "auditor"] as const) {
      const { s } = await loginAs(h, role);
      for (const [key, c] of Object.entries(CASES).filter(([k, c]) => c.method === "GET" && !k.includes("/moderation/"))) {
        expect((await inject(s, c)).statusCode, `${role} ${key}`).toBe(200);
      }
      denied(await run(s, "GET /admin/v1/moderation/cases"), "moderation.manage");
      denied(await run(s, "POST /admin/v1/referrals/:referralId/approve"), "referral.manage");
      denied(await run(s, "POST /admin/v1/game/duels/:duelId/reevaluate"), "league.manage");
    }
  });

  it("operations: все права раздела; команды со step-up — после TOTP; actor несёт права социального", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    for (const [key, c] of Object.entries(CASES)) expect((await inject(s, c)).statusCode, key).toBe(c.status);
    const call = h.fake.callsTo("lessons", "POST", `${IA}/pair-rooms/${ROOM_ID}/stop`)[0]!;
    expect(call.actor?.permissions).toEqual(
      expect.arrayContaining(["social.read", "moderation.manage", "referral.read", "referral.manage", "league.read", "league.manage", "room.read", "room.manage"]),
    );
  });
});

// ---------------------------------------------------------------- модерация

describe("модерация: step-up по телу решения", () => {
  it("правило: social_ban дольше 7 дней или бессрочный — step-up; до 7 дней и прочие действия — без", () => {
    expect(resolveNeedsStepUp({ action: "social_ban", days: 7 })).toBe(false);
    expect(resolveNeedsStepUp({ action: "social_ban", days: 8 })).toBe(true);
    expect(resolveNeedsStepUp({ action: "social_ban", days: null })).toBe(true);
    for (const action of ["dismiss", "warning", "nickname_reset"]) expect(resolveNeedsStepUp({ action, days: null })).toBe(false);
  });

  it("без step-up: бан 8 и 30 дней и бессрочный → 403 STEP_UP_REQUIRED {moderation.manage} до домена; 1..7 дней, предупреждение, сброс ника, отклонение — 200 без X-Step-Up", async () => {
    const { s } = await loginAs(h, "support");
    for (const days of [8, 30, null]) {
      const res = await run(s, "POST /admin/v1/moderation/cases/:caseId/resolve", { payload: { ...BAN, days } });
      expect(res.statusCode, String(days)).toBe(403);
      expect(res.json()).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: "moderation.manage" } });
    }
    expect(h.fake.callsTo("social", "POST")).toHaveLength(0);
    for (const payload of [{ ...BAN, days: 1 }, { ...BAN, days: 7 }, { action: "warning", days: null, basis: BAN.basis }, { action: "nickname_reset", days: null, basis: BAN.basis }, { action: "dismiss", days: null, basis: BAN.basis }]) {
      const res = await run(s, "POST /admin/v1/moderation/cases/:caseId/resolve", { payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(200);
    }
    const calls = h.fake.callsTo("social", "POST", `${IA}/moderation/cases/${CASE_ID}/resolve`);
    expect(calls).toHaveLength(5);
    for (const c of calls) expect(c.headers["x-step-up"]).toBeUndefined();
    expect(calls[2]!.body).toEqual({ action: "warning", days: null, basis: BAN.basis });
  });

  it("со step-up: бессрочный бан проходит, X-Step-Up: ok; ответ — решение с исполнителем из lookup", async () => {
    const { s } = await loginAs(h, "support", { display_name: "Дилноза Поддержка" });
    await stepUp(h, s);
    const res = await run(s, "POST /admin/v1/moderation/cases/:caseId/resolve", { payload: { ...BAN, days: null } });
    expect(res.statusCode).toBe(200);
    const c = res.json() as AdminCase;
    expect(c.status).toBe("resolved");
    expect(c.resolution).toMatchObject({ action: "social_ban", sanction_id: SANCTION_ID, basis: BAN.basis, resolved_by: { name: "Дилноза Поддержка" } });
    expect(h.fake.callsTo("social", "POST")[0]!.headers["x-step-up"]).toBe("ok");
    expect(h.fake.callsTo("social", "POST")[0]!.body).toEqual({ ...BAN, days: null });
  });

  it("тело: days у не-бана, days вне 1..30, дробные дни, основание короче 10 или длиннее 500, лишнее поле → 422 до домена", async () => {
    const { s } = await loginAs(h, "support");
    await stepUp(h, s);
    for (const payload of [
      { action: "warning", days: 3, basis: BAN.basis },
      { ...BAN, days: 0 },
      { ...BAN, days: 31 },
      { ...BAN, days: 2.5 },
      { ...BAN, basis: "коротко" },
      { ...BAN, basis: "x".repeat(501) },
      { ...BAN, notify: false },
      { action: "ban", days: 3, basis: BAN.basis },
      { action: "social_ban", basis: BAN.basis },
    ]) {
      const res = await run(s, "POST /admin/v1/moderation/cases/:caseId/resolve", { payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect(h.fake.callsTo("social")).toHaveLength(0);
  });

  it("коды social — как есть: 409 CASE_STATE {status}, 409 SANCTION_STATE, 409 APPEAL_STATE, 404 CASE_NOT_FOUND; Idempotent-Replayed", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("social", "POST", `${IA}/moderation/cases/${CASE_ID}/resolve`, () => domainError(409, "CASE_STATE", { status: "resolved" }));
    expect((await run(s, "POST /admin/v1/moderation/cases/:caseId/resolve")).json()).toMatchObject({ code: "CASE_STATE", details: { status: "resolved" } });
    h.fake.on("social", "POST", `${IA}/moderation/sanctions/${SANCTION_ID}/revoke`, () => domainError(409, "SANCTION_STATE"));
    expect((await run(s, "POST /admin/v1/moderation/sanctions/:sanctionId/revoke")).statusCode).toBe(409);
    h.fake.on("social", "POST", `${IA}/moderation/appeals/${SANCTION_APPEAL_ID}/decide`, () => domainError(409, "APPEAL_STATE", { status: "upheld" }));
    expect((await run(s, "POST /admin/v1/moderation/appeals/:appealId/decide")).json()).toMatchObject({ code: "APPEAL_STATE", details: { status: "upheld" } });
    h.fake.on("social", "GET", `${IA}/moderation/cases/${CASE_ID}`, () => domainError(404, "CASE_NOT_FOUND"));
    expect((await run(s, "GET /admin/v1/moderation/cases/:caseId")).json().code).toBe("CASE_NOT_FOUND");
    h.fake.on("social", "POST", `${IA}/moderation/sanctions/${SANCTION_ID}/revoke`, () =>
      json(200, sanctionDomain({ active: false, revoked_at: "2026-11-21T10:00:00Z", revoked_by: SOCIAL_STAFF_ID, revoke_reason: "Ошибка модератора" }), { "idempotent-replayed": "true" }),
    );
    const again = await run(s, "POST /admin/v1/moderation/sanctions/:sanctionId/revoke", { headers: IK("revoke") });
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect((again.json() as AdminSanction).revoked_by).toEqual({ staff_id: SOCIAL_STAFF_ID, name: "Нигора Модератор" });
    expect(h.fake.callsTo("social", "POST").at(-1)!.headers["idempotency-key"]).toBe("soc-revoke-0001");
    expect((await run(s, "POST /admin/v1/moderation/sanctions/:sanctionId/revoke", { headers: { "idempotency-key": "bad key" } })).json().code).toBe("IDEMPOTENCY_KEY_INVALID");
  });

  it("дело: без переписки (лишние поля отброшены), фильтры списка передаются; чужой вид предмета, причина, статус → 503", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("social", "GET", `${IA}/moderation/cases/${CASE_ID}`, () =>
      json(200, caseDomain({ messages: [{ text: "переписка ученика" }], transcript: "реплики комнаты", reporter_telegram_id: "777000123" })),
    );
    const res = await run(s, "GET /admin/v1/moderation/cases/:caseId");
    expect(res.statusCode).toBe(200);
    const c = res.json() as AdminCase;
    expect(c).toMatchObject({ subject: { nickname_at_report: "Bahodir_07", status: null }, comment: "Ник обидный, прошу проверить", target_sanctions: [{ sanction_id: SANCTION_ID }] });
    for (const leak of ["переписка", "реплики комнаты", "777000123", "messages", "transcript"]) expect(res.body).not.toContain(leak);
    await run(s, "GET /admin/v1/moderation/cases");
    expect(h.fake.callsTo("social", "GET", `${IA}/moderation/cases`).at(-1)!.query).toEqual({ status: "open", cursor: "c1", limit: "20" });
    await run(s, "GET /admin/v1/moderation/sanctions", { url: `${MOD}/sanctions?user_id=${TARGET_USER_ID.toUpperCase()}&active=false` });
    expect(h.fake.callsTo("social", "GET", `${IA}/moderation/sanctions`).at(-1)!.query).toEqual({ user_id: TARGET_USER_ID, active: "false" });
    for (const bad of [caseRowDomain({ subject_kind: "chat" }), caseRowDomain({ reason: "rude" }), caseRowDomain({ status: "pending" }), caseRowDomain({ target_nickname: "<b>x</b>" }), caseRowDomain({ created_at: "2026-11-20 09:00" })]) {
      h.fake.on("social", "GET", `${IA}/moderation/cases`, () => json(200, { items: [bad], next_cursor: null }));
      unavailable(await run(s, "GET /admin/v1/moderation/cases"), "social");
    }
    h.fake.on("social", "GET", `${IA}/moderation/sanctions`, () => json(200, { items: [sanctionDomain({ kind: "mute" })], next_cursor: null }));
    unavailable(await run(s, "GET /admin/v1/moderation/sanctions"), "social");
  });

  it("обжалование: текст ученика без управляющих символов; решение — заметка и исполнитель", async () => {
    const { s } = await loginAs(h, "support");
    const list = (await run(s, "GET /admin/v1/moderation/appeals")).json() as Page<AdminSanctionAppeal>;
    expect(list.items[0]).toMatchObject({ appeal_id: SANCTION_APPEAL_ID, status: "open", sanction: { appeal: { appeal_id: SANCTION_APPEAL_ID, status: "open" } } });
    const res = await run(s, "POST /admin/v1/moderation/appeals/:appealId/decide");
    expect((res.json() as AdminSanctionAppeal)).toMatchObject({ status: "overturned", decision_note: "Ник исправлен, санкция снята", decided_by: { staff_id: expect.any(String) } });
    h.fake.on("social", "GET", `${IA}/moderation/appeals`, () => json(200, { items: [{ ...list.items[0], text: "снимите\u0000\u202eзапрет\nпожалуйста" }], next_cursor: null }));
    const cleaned = (await run(s, "GET /admin/v1/moderation/appeals")).json() as Page<AdminSanctionAppeal>;
    // \u0000 и переключатель направления \u202e → пробелы; перевод строки сохраняется
    expect(cleaned.items[0]!.text).toBe("снимите  запрет\nпожалуйста");
  });
});

// ---------------------------------------------------------------- карточка ученика

describe("карточка ученика (social.read)", () => {
  it("заявки без ника и id второй стороны; лишнее отброшено; профиль без ника — null и нули", async () => {
    const { s } = await loginAs(h, "support");
    const OTHER = "ab0c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4";
    h.fake.on("social", "GET", `${IA}/social/users/${LEARNER_USER_ID}`, () =>
      json(200, socialCardDomain({
        requests: [{ request_id: SANCTION_ID, direction: "in", status: "pending", created_at: "2026-11-20T09:00:00Z", decided_at: null, other_user_id: OTHER, other_nickname: "Чужой_ник" }],
        telegram_id: "777000123",
        blocked_user_ids: [OTHER],
      })),
    );
    const res = await run(s, "GET /admin/v1/social/users/:userId");
    expect(res.statusCode).toBe(200);
    const card = res.json() as AdminSocialCard;
    expect(card.requests).toEqual([{ request_id: SANCTION_ID, direction: "in", status: "pending", created_at: "2026-11-20T09:00:00Z", decided_at: null }]);
    expect(card).toMatchObject({ member_id: MEMBER_ID, friend_code: "TH-7KQ2-M9XA", blocks: { given: 1, received: 0 } });
    for (const leak of [OTHER, "Чужой_ник", "777000123", "other_", "blocked_user_ids"]) expect(res.body).not.toContain(leak);
    h.fake.on("social", "GET", `${IA}/social/users/${LEARNER_USER_ID}`, () => json(200, socialCardDomain({ nickname: null, friend_code: null, nickname_changed_at: null, friends: 0, requests: [] })));
    expect(((await run(s, "GET /admin/v1/social/users/:userId")).json() as AdminSocialCard).nickname).toBeNull();
    h.fake.on("social", "GET", `${IA}/social/users/${LEARNER_USER_ID}`, () => domainError(404, "SOCIAL_PROFILE_NOT_FOUND"));
    expect((await run(s, "GET /admin/v1/social/users/:userId")).json().code).toBe("SOCIAL_PROFILE_NOT_FOUND");
  });

  it("неизвестный ученик: social 404 SOCIAL_PROFILE_NOT_FOUND — клиенту как есть (статус, код, details), без маскирования и без 503", async () => {
    const unknown = "f0e1d2c3-b4a5-4968-8776-655443322110";
    h.fake.on("social", "GET", `${IA}/social/users/${unknown}`, () => domainError(404, "SOCIAL_PROFILE_NOT_FOUND", { user_id: unknown }));
    for (const role of ["support", "analyst"] as const) {
      const { s } = await loginAs(h, role);
      const res = await get(s, `/admin/v1/social/users/${unknown.toUpperCase()}`);
      expect(res.statusCode, role).toBe(404);
      expect(res.json(), role).toMatchObject({ code: "SOCIAL_PROFILE_NOT_FOUND", details: { user_id: unknown } });
    }
    expect(h.fake.callsTo("social", "GET", `${IA}/social/users/${unknown}`)).toHaveLength(2);
  });

  it("испорченное: ник с пробелом или разметкой, member_id не того вида, код друга с 0 / O, статус заявки чужой → 503 (в лог — путь, без значения)", async () => {
    const { s } = await loginAs(h, "support");
    // узбекские буквы-апострофы (ʻ U+02BB, ʼ U+02BC) — буквы ника, как в валидаторе social
    for (const nickname of ["Gʻulom_07", "Oʼrol", "Ўктам"]) {
      h.fake.on("social", "GET", `${IA}/social/users/${LEARNER_USER_ID}`, () => json(200, socialCardDomain({ nickname })));
      expect(((await run(s, "GET /admin/v1/social/users/:userId")).json() as AdminSocialCard).nickname).toBe(nickname);
    }
    for (const bad of [
      socialCardDomain({ nickname: "Лола учит" }),
      socialCardDomain({ nickname: "<script>alert(1)</script>" }),
      socialCardDomain({ member_id: "mb_short" }),
      socialCardDomain({ member_id: LEARNER_USER_ID }),
      socialCardDomain({ friend_code: "TH-0000-OOOO" }),
      socialCardDomain({ requests: [{ request_id: SANCTION_ID, direction: "in", status: "blocked", created_at: "2026-11-20T09:00:00Z", decided_at: null }] }),
      socialCardDomain({ friends: -1 }),
    ]) {
      h.fake.on("social", "GET", `${IA}/social/users/${LEARNER_USER_ID}`, () => json(200, bad));
      unavailable(await run(s, "GET /admin/v1/social/users/:userId"), "social");
    }
    expect(h.logs.text).toContain("$.requests[0].status");
    expect(h.logs.text).not.toContain("<script>");
    expect(h.logs.text).not.toContain("Лола учит");
  });
});

describe("код друга в карточке ученика (F7-20): полностью — только moderation.manage", () => {
  const FULL = "TH-7KQ2-M9XA";
  const MASKED = "TH-••••-M9XA";
  const card = (s: Session) => get(s, `/admin/v1/social/users/${LEARNER_USER_ID}`);

  it("маска: TH-••••- + последние 4 символа; уже маска — как есть", () => {
    expect(maskFriendCode(FULL)).toBe(MASKED);
    expect(maskFriendCode(MASKED)).toBe(MASKED);
  });

  it("support и operations (moderation.manage) — код целиком; analyst и auditor (social.read без moderation.manage) — маска, полный код в ответ не уходит", async () => {
    for (const role of ["support", "operations", "super_admin"] as const) {
      const { s } = await loginAs(h, role);
      const res = await card(s);
      expect(res.statusCode, role).toBe(200);
      expect((res.json() as AdminSocialCard).friend_code, role).toBe(FULL);
    }
    for (const role of ["analyst", "auditor"] as const) {
      const { s } = await loginAs(h, role);
      const res = await card(s);
      expect(res.statusCode, role).toBe(200);
      const c = res.json() as AdminSocialCard;
      expect(c.friend_code, role).toBe(MASKED);
      expect(res.body, role).not.toContain("7KQ2");
      // остальное — без изменений
      expect(c).toMatchObject({ member_id: MEMBER_ID, nickname: "Лола_учит", friends: 4 });
    }
    // домен вызывается одинаково (маскирует BFF), ответ строго по контракту
    expect(h.fake.callsTo("social", "GET", `${IA}/social/users/${LEARNER_USER_ID}`)).toHaveLength(5);
    expect(violations).toEqual([]);
  });

  it("решает право, а не роль: social.read без moderation.manage — маска; с ним — целиком; профиля нет (null) — null", async () => {
    const ro = await loginAs(h, "support", { permissions: ["dashboard.read", "social.read"] });
    expect(((await card(ro.s)).json() as AdminSocialCard).friend_code).toBe(MASKED);
    const mod = await loginAs(h, "analyst", { permissions: ["social.read", "moderation.manage"] });
    expect(((await card(mod.s)).json() as AdminSocialCard).friend_code).toBe(FULL);
    h.fake.on("social", "GET", `${IA}/social/users/${LEARNER_USER_ID}`, () => json(200, socialCardDomain({ friend_code: null })));
    expect(((await card(ro.s)).json() as AdminSocialCard).friend_code).toBeNull();
  });

  it("имперсонация (dev): super_admin, примеривший analyst, видит маску — по эффективным правам сессии", async () => {
    await h.close();
    h = await makeHarness({ ENV: "dev", NODE_ENV: "development" });
    const { s } = await loginAs(h, "super_admin");
    expect(((await card(s)).json() as AdminSocialCard).friend_code).toBe(FULL);
    const imp = await h.app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(s), payload: { role: "analyst" } });
    expect(imp.statusCode).toBe(200);
    expect(((await card(s)).json() as AdminSocialCard).friend_code).toBe(MASKED);
  });
});

// ---------------------------------------------------------------- рефералы

describe("реферальные кампании и очередь проверки", () => {
  it("версия: активная — строго (лишнее отброшено, min_days ≤ min_lessons, награды в границах); черновик — как есть", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("social", "GET", `${IA}/referrals/campaigns/1`, () => json(200, campaignVersionDomain({ payload: { ...campaignPayload(), secret_rule: "ip" }, internal: 1 })));
    const v = (await run(s, "GET /admin/v1/referrals/campaigns/:version")).json() as ReferralCampaignVersion;
    expect(v.payload).toEqual(campaignPayload());
    expect(v.created_by).toBeNull();
    for (const payload of [campaignPayload({ min_days: 4 }), campaignPayload({ inviter_reward: { freeze: 6, til: 0 } }), campaignPayload({ window_days: 3 }), campaignPayload({ review: { velocity_per_day: 5 } })]) {
      h.fake.on("social", "GET", `${IA}/referrals/campaigns/1`, () => json(200, campaignVersionDomain({ payload })));
      unavailable(await run(s, "GET /admin/v1/referrals/campaigns/:version"), "social");
    }
    const raw = { min_lessons: "много", extra: [1] };
    h.fake.on("social", "GET", `${IA}/referrals/campaigns/2`, () => json(200, campaignVersionDomain({ version: 2, status: "draft", payload: raw, activated_at: null })));
    expect(((await get(s, `${REF}/campaigns/2`)).json() as ReferralCampaignVersion).payload).toEqual(raw);
    h.fake.on("social", "GET", `${IA}/referrals/campaigns`, () => json(200, { items: [{ ...campaignVersionDomain(), status: "pending" }] }));
    unavailable(await run(s, "GET /admin/v1/referrals/campaigns"), "social");
  });

  it("черновик: If-Match как есть (неверный — 422), тело как есть; 409 DRAFT_CONFLICT и 422 CAMPAIGN_INVALID {errors} — как есть; удаление → 204", async () => {
    const { staff, s } = await loginAs(h, "operations");
    const c = CASES["PUT /admin/v1/referrals/campaigns/draft"]!;
    const ok = await inject(s, c);
    expect(ok.statusCode).toBe(200);
    const call = h.fake.callsTo("social", "PUT")[0]!;
    expect(call.headers["if-match"]).toBe("2026-11-20T09:00:00.000Z");
    expect(call.body).toEqual(c.payload);
    expect((ok.json() as ReferralCampaignVersion).created_by).toEqual({ staff_id: staff.staff_id, name: staff.display_name });
    expect((await send(s, "PUT", `${REF}/campaigns/draft`, c.payload, { "if-match": "bad value; drop" })).statusCode).toBe(422);
    h.fake.on("social", "PUT", `${IA}/referrals/campaigns/draft`, () => domainError(409, "DRAFT_CONFLICT", { updated_at: "2026-11-20T09:05:00Z" }));
    expect((await inject(s, c)).json()).toMatchObject({ code: "DRAFT_CONFLICT", details: { updated_at: "2026-11-20T09:05:00Z" } });
    const errors = [{ path: "min_days", code: "GT_MIN_LESSONS" }];
    h.fake.on("social", "POST", `${IA}/referrals/campaigns/draft/validate`, () => domainError(422, "CAMPAIGN_INVALID", { errors }));
    const inv = await send(s, "POST", `${REF}/campaigns/draft/validate`);
    expect(inv.statusCode).toBe(422);
    expect(inv.json()).toMatchObject({ code: "CAMPAIGN_INVALID", details: { errors } });
    const del = await send(s, "DELETE", `${REF}/campaigns/draft`);
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");
  });

  it("активация: referral.manage + step-up, комментарий ≥ 10; 409 CAMPAIGN_NOT_VALIDATED — как есть; activated_by — из lookup", async () => {
    const { s } = await loginAs(h, "operations", { display_name: "Олим Операции" });
    expect((await run(s, "POST /admin/v1/referrals/campaigns/draft/activate")).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    const res = await run(s, "POST /admin/v1/referrals/campaigns/draft/activate");
    expect(res.statusCode).toBe(200);
    expect((res.json() as ReferralCampaignVersion).activated_by?.name).toBe("Олим Операции");
    h.fake.on("social", "POST", `${IA}/referrals/campaigns/draft/activate`, () => domainError(409, "CAMPAIGN_NOT_VALIDATED"));
    expect((await run(s, "POST /admin/v1/referrals/campaigns/draft/activate")).json().code).toBe("CAMPAIGN_NOT_VALIDATED");
  });

  it("reward_outcome (исход ack gamification): rewarded | legacy | inviter_capped | null — в строке и карточке; нет поля — null; чужое значение → 503", async () => {
    const { s } = await loginAs(h, "analyst");
    const page = (await run(s, "GET /admin/v1/referrals")).json() as Page<AdminReferral>;
    expect(page.items.map((r) => r.reward_outcome)).toEqual([null, "rewarded"]);
    for (const outcome of ["rewarded", "legacy", "inviter_capped", null]) {
      const status = outcome === "inviter_capped" ? "capped" : outcome ? "rewarded" : "review";
      h.fake.on("social", "GET", `${IA}/referrals/${REFERRAL_ID}`, () =>
        json(200, referralDomain({ status, reward_outcome: outcome, ...(outcome === "inviter_capped" ? { reject_code: "monthly_cap" } : {}) })),
      );
      const r = (await run(s, "GET /admin/v1/referrals/:referralId")).json() as AdminReferral;
      expect(r.reward_outcome, String(outcome)).toBe(outcome);
    }
    // social прежней версии поля не отдаёт — «подтверждения нет»
    h.fake.on("social", "GET", `${IA}/referrals`, () => {
      const { reward_outcome: _drop, ...row } = referralDomain();
      return json(200, { items: [row], next_cursor: null });
    });
    expect(((await run(s, "GET /admin/v1/referrals")).json() as Page<AdminReferral>).items[0]!.reward_outcome).toBeNull();
    for (const bad of ["paid", "capped", 1]) {
      h.fake.on("social", "GET", `${IA}/referrals/${REFERRAL_ID}`, () => json(200, referralDomain({ reward_outcome: bad })));
      unavailable(await run(s, "GET /admin/v1/referrals/:referralId"), "social");
      h.fake.on("social", "GET", `${IA}/referrals`, () => json(200, { items: [referralDomain({ reward_outcome: bad })], next_cursor: null }));
      unavailable(await run(s, "GET /admin/v1/referrals"), "social");
    }
    expect(violations).toEqual([]);
  });

  it("очередь: risk_flags и уроки (дата и минуты) — только админке; чужой признак риска или статус → 503; решения — заметка, история, исполнитель", async () => {
    const { s } = await loginAs(h, "operations");
    h.fake.on("social", "GET", `${IA}/referrals/${REFERRAL_ID}`, () =>
      json(200, referralDomain({ lessons_log: [{ local_date: "2026-11-11", minutes: 2, session_id: SANCTION_ID, answers: ["секретный ответ"] }], invitee_name: "Азиз" })),
    );
    const res = await run(s, "GET /admin/v1/referrals/:referralId");
    const r = res.json() as AdminReferral;
    expect(r).toMatchObject({ risk_flags: ["short_lessons"], lessons_log: [{ local_date: "2026-11-11", minutes: 2 }], inviter_month: { qualified: 4, cap: 10 } });
    for (const leak of ["секретный ответ", "Азиз", SANCTION_ID]) expect(res.body).not.toContain(leak);
    await run(s, "GET /admin/v1/referrals");
    expect(h.fake.callsTo("social", "GET", `${IA}/referrals`).at(-1)!.query).toEqual({ status: "review", limit: "50" });
    for (const bad of [referralDomain({ risk_flags: ["ip_match"] }), referralDomain({ status: "paid" }), referralDomain({ reject_code: "fraud" }), referralDomain({ inviter_month: { qualified: 1, cap: 0 } })]) {
      h.fake.on("social", "GET", `${IA}/referrals/${REFERRAL_ID}`, () => json(200, bad));
      unavailable(await run(s, "GET /admin/v1/referrals/:referralId"), "social");
    }
    const ap = (await run(s, "POST /admin/v1/referrals/:referralId/approve")).json() as AdminReferral;
    expect(ap).toMatchObject({ status: "qualified", decision_history: [{ decision: "approved", note: "Уроки реальные, проверено" }] });
    const rj = (await run(s, "POST /admin/v1/referrals/:referralId/reject")).json() as AdminReferral;
    expect(rj).toMatchObject({ status: "rejected", reject_code: "review_rejected", can_redecide: true });
    h.fake.on("social", "POST", `${IA}/referrals/${REFERRAL_ID}/approve`, () => domainError(409, "REFERRAL_STATE", { status: "rewarded" }));
    expect((await run(s, "POST /admin/v1/referrals/:referralId/approve")).json()).toMatchObject({ code: "REFERRAL_STATE", details: { status: "rewarded" } });
    // отклонение оператором: только not_new_user, family_member, review_rejected
    for (const reject_code of ["window_expired", "monthly_cap", "fraud"]) {
      expect((await run(s, "POST /admin/v1/referrals/:referralId/reject", { payload: { reject_code, note: "Причина отклонения" } })).statusCode, reject_code).toBe(422);
    }
  });
});

// ---------------------------------------------------------------- лиги и дуэли

describe("лиги недели и дуэли (gamification)", () => {
  it("неделя: понедельник передаётся; без недели — текущая (без параметра); вторник, 30 февраля, не дата → 422 до домена", async () => {
    const { s } = await loginAs(h, "analyst");
    const w = (await run(s, "GET /admin/v1/game/leagues")).json() as AdminLeagueWeek;
    expect(w.groups[0]).toMatchObject({ group_id: GROUP_ID, status: "held", anomalies: 1 });
    expect(h.fake.callsTo("gamification", "GET", `${IA}/game/leagues`).at(-1)!.query).toEqual({ week: WEEK });
    await get(s, `${GM}/leagues`);
    expect(h.fake.callsTo("gamification", "GET", `${IA}/game/leagues`).at(-1)!.query).toEqual({});
    for (const week of ["2026-11-17", "2026-02-30", "20261116xx", "2026-11-1"]) {
      const res = await get(s, `${GM}/leagues?week=${week}`);
      expect(res.statusCode, week).toBe(422);
      expect(res.json().code).toBe("VALIDATION_ERROR");
    }
    expect(h.fake.callsTo("gamification")).toHaveLength(2);
  });

  it("группа: участники и версии итогов строго; неделя не понедельник, чужая полоса, место 0 → 503", async () => {
    const { s } = await loginAs(h, "analyst");
    const g = (await run(s, "GET /admin/v1/game/leagues/:groupId")).json() as AdminLeagueGroup;
    expect(g.members.map((m) => [m.member_id, m.nickname, m.anomaly])).toEqual([[MEMBER_ID, "Лола_учит", true], ["mb_ZyXwVuTsRqPoNmLkJiHg-_", null, false]]);
    expect(g.results[0]).toMatchObject({ version: 1, prizes_held: true, closed_by: null });
    for (const bad of [leagueGroupDomain({ week: "2026-11-17" }), leagueGroupDomain({ level_band: "C1" }), leagueGroupDomain({ status: "frozen" }), leagueGroupDomain({ members: [{ ...leagueGroupDomain().members[0], place: 0 }] })]) {
      h.fake.on("gamification", "GET", `${IA}/game/leagues/${GROUP_ID}`, () => json(200, bad));
      unavailable(await run(s, "GET /admin/v1/game/leagues/:groupId"), "gamification");
    }
    h.fake.on("gamification", "GET", `${IA}/game/leagues`, () => json(200, leagueWeekDomain({ groups: [{ ...leagueWeekDomain().groups[0], version: 0 }] })));
    unavailable(await run(s, "GET /admin/v1/game/leagues"), "gamification");
  });

  it("переоценка: exclude_user_ids — в нижнем регистре, повтор (в т. ч. в другом регистре) или больше 30 → 422; версия + 1, прежняя хранится; 409 RESULT_STATE — как есть", async () => {
    const { staff, s } = await loginAs(h, "operations");
    await stepUp(h, s);
    const res = await run(s, "POST /admin/v1/game/leagues/:groupId/reevaluate", { payload: { exclude_user_ids: [LEARNER_USER_ID.toUpperCase()], reason: "Накрутка XP, исключаем" } });
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("gamification", "POST")[0]!.body).toEqual({ exclude_user_ids: [LEARNER_USER_ID], reason: "Накрутка XP, исключаем" });
    const g = res.json() as AdminLeagueGroup;
    expect(g.results.map((r) => r.version)).toEqual([2, 1]);
    expect(g.results[0]!.closed_by).toEqual({ staff_id: staff.staff_id, name: staff.display_name });
    for (const exclude_user_ids of [[LEARNER_USER_ID, LEARNER_USER_ID.toUpperCase()], Array.from({ length: 31 }, (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`)]) {
      expect((await run(s, "POST /admin/v1/game/leagues/:groupId/reevaluate", { payload: { exclude_user_ids, reason: "Накрутка XP, исключаем" } })).statusCode).toBe(422);
    }
    // пустой список — пересчёт без исключений
    expect((await run(s, "POST /admin/v1/game/leagues/:groupId/reevaluate", { payload: { exclude_user_ids: [], reason: "Пересчёт после сбоя" } })).statusCode).toBe(200);
    h.fake.on("gamification", "POST", `${IA}/game/leagues/${GROUP_ID}/reevaluate`, () => domainError(409, "RESULT_STATE", { status: "open" }));
    expect((await run(s, "POST /admin/v1/game/leagues/:groupId/reevaluate")).json()).toMatchObject({ code: "RESULT_STATE", details: { status: "open" } });
    h.fake.on("gamification", "POST", `${IA}/game/leagues/${GROUP_ID}/release-prizes`, () => domainError(404, "GROUP_NOT_FOUND"));
    expect((await run(s, "POST /admin/v1/game/leagues/:groupId/release-prizes")).json().code).toBe("GROUP_NOT_FOUND");
  });

  it("дуэли: счёт и награды строго; верных больше заданий, чужой статус, награда 0 → 503; переоценка — история версий", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    const page = (await run(s, "GET /admin/v1/game/duels")).json() as Page<AdminDuel>;
    expect(page.next_cursor).toBe("d2");
    expect(page.items[1]).toMatchObject({ status: "challenged", scores: { challenger: null, opponent: null }, result: null });
    expect(h.fake.callsTo("gamification", "GET", `${IA}/game/duels`)[0]!.query).toEqual({ status: "finished", limit: "20" });
    for (const bad of [
      duelDomain({ scores: { challenger: { correct: 11, total: 10 }, opponent: null } }),
      duelDomain({ status: "running" }),
      duelDomain({ result: "winner" }),
      duelDomain({ rewards: [{ user_id: LEARNER_USER_ID, op_id: SANCTION_ID, amount: 0, status: "confirmed", result_version: 1 }] }),
    ]) {
      h.fake.on("gamification", "GET", `${IA}/game/duels/${DUEL_ID}`, () => json(200, bad));
      unavailable(await run(s, "GET /admin/v1/game/duels/:duelId"), "gamification");
    }
    const re = (await run(s, "POST /admin/v1/game/duels/:duelId/reevaluate")).json() as AdminDuel;
    expect(re).toMatchObject({ result: "draw", result_version: 2, history: [{ version: 1, result: "challenger", by: null }] });
    expect(h.fake.callsTo("gamification", "POST")[0]!.headers["x-step-up"]).toBe("ok");
  });
});

// ---------------------------------------------------------------- парные комнаты

describe("парные комнаты (lessons)", () => {
  it("без текстов реплик и оценок: лишние поля участников и хода событий отбрасываются кодеком", async () => {
    const { s } = await loginAs(h, "support");
    const base = pairRoomDomain();
    h.fake.on("lessons", "GET", `${IA}/pair-rooms/${ROOM_ID}`, () =>
      json(200, {
        ...base,
        participants: base.participants.map((p) => ({ ...p, report: { tips: ["Совет ученику"] }, evaluation_id: SANCTION_ID, evidence: [{ turn_id: "t1", text: "I want coffee" }], score: 2 })),
        timeline: [
          { seq: 1, kind: "turn", role: "A", at: "2026-11-20T10:01:00Z", text: "I would like a cappuccino", payload: { audio_id: "a1", transcript: "I would like" } },
          { seq: 2, kind: "coach", role: null, at: "2026-11-20T10:01:05Z", prompt: "Now ask about the price", gloss: { ru: "Спроси о цене" } },
        ],
        transcript: [{ speaker: "A", text: "Hello" }],
        team_report: { summary: "Отлично" },
      }),
    );
    const res = await run(s, "GET /admin/v1/pair-rooms/:roomId");
    expect(res.statusCode).toBe(200);
    const r = res.json() as AdminPairRoom;
    expect(r.timeline).toEqual([
      { seq: 1, kind: "turn", role: "A", at: "2026-11-20T10:01:00Z" },
      { seq: 2, kind: "coach", role: null, at: "2026-11-20T10:01:05Z" },
    ]);
    expect(Object.keys(r.participants[0]!).sort()).toEqual(["contributed", "joined_at", "minutes", "network", "role", "side", "speaking_seconds", "turns", "user_id"]);
    for (const leak of ["cappuccino", "I would like", "price", "Спроси", "Совет ученику", "coffee", "Hello", "Отлично", SANCTION_ID, "transcript", "evidence"]) {
      expect(res.body, leak).not.toContain(leak);
    }
    h.fake.on("lessons", "GET", `${IA}/pair-rooms`, () => json(200, { items: [{ ...pairRoomRowDomain(), last_turn_text: "секрет", scores: { A: 3 } }], next_cursor: null }));
    const list = await run(s, "GET /admin/v1/pair-rooms");
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain("секрет");
    expect(list.body).not.toContain("scores");
  });

  it("фильтры: status, from, to, limit передаются; from позже to, неразборчивая дата → 422 до домена", async () => {
    const { s } = await loginAs(h, "analyst");
    await run(s, "GET /admin/v1/pair-rooms");
    expect(h.fake.callsTo("lessons", "GET", `${IA}/pair-rooms`)[0]!.query).toEqual({ status: "in_progress", from: "2026-11-01", to: "2026-11-30T23:59:59Z", limit: "20" });
    for (const q of ["from=2026-12-01&to=2026-11-01", "from=2026-13-45", "to=2026-11-01Tgarbage"]) {
      const res = await get(s, `${ROOMS}?${q}`);
      expect(res.statusCode, q).toBe(422);
      expect(res.json().code).toBe("VALIDATION_ERROR");
    }
    expect(h.fake.callsTo("lessons", "GET", `${IA}/pair-rooms`)).toHaveLength(1);
  });

  it("испорченное: чужой статус, вид события, роль, причина завершения, больше двух участников → 503 {service: lessons}", async () => {
    const { s } = await loginAs(h, "support");
    const p = pairRoomDomain().participants;
    for (const bad of [pairRoomDomain({ status: "closed" }), pairRoomDomain({ timeline: [{ seq: 1, kind: "message", role: "A", at: "2026-11-20T10:01:00Z" }] }), pairRoomDomain({ participants: [{ ...p[0], role: "C" }] }), pairRoomDomain({ end_reason: "timeout" }), pairRoomDomain({ participants: [...p, p[0]] }), pairRoomDomain({ ai_cost_usd: -1 })]) {
      h.fake.on("lessons", "GET", `${IA}/pair-rooms/${ROOM_ID}`, () => json(200, bad));
      unavailable(await run(s, "GET /admin/v1/pair-rooms/:roomId"), "lessons");
    }
  });

  it("остановка: room.manage + step-up, причина ≥ 10; 409 ROOM_NOT_ACTIVE — как есть; stopped_by — из lookup", async () => {
    const { s } = await loginAs(h, "operations", { display_name: "Олим Операции" });
    await stepUp(h, s);
    const res = await run(s, "POST /admin/v1/pair-rooms/:roomId/stop");
    expect(res.statusCode).toBe(200);
    expect(res.json() as AdminPairRoom).toMatchObject({ status: "stopped", end_reason: "stopped", stop_reason: "Грубость в комнате, жалоба", stopped_by: { name: "Олим Операции" } });
    h.fake.on("lessons", "POST", `${IA}/pair-rooms/${ROOM_ID}/stop`, () => domainError(409, "ROOM_NOT_ACTIVE", { status: "finished" }));
    expect((await run(s, "POST /admin/v1/pair-rooms/:roomId/stop")).json()).toMatchObject({ code: "ROOM_NOT_ACTIVE", details: { status: "finished" } });
  });
});

// ---------------------------------------------------------------- блок главной

describe("главная: блок social", () => {
  const SOCIAL_BLOCK = {
    available: true,
    data: { period: "7d", friend_requests: 25, friendships_added: 18, duels_finished: 12, pair_rooms_finished: 4, referrals_in_review: 3, cases_opened: 4, cases_open: 2 },
  };

  it("social + дуэли (gamification) + комнаты (lessons): period передаётся всем трём; лишнее отброшено", async () => {
    const { s } = await loginAs(h, "read_only");
    const d = (await get(s, "/admin/v1/dashboard?period=7d")).json() as Dashboard;
    expect(d.social).toEqual(SOCIAL_BLOCK);
    for (const [svc, path] of [["social", `${IA}/social/stats`], ["gamification", `${IA}/game/duels/stats`], ["lessons", `${IA}/pair-rooms/stats`]] as const) {
      expect(h.fake.callsTo(svc, "GET", path)[0]!.query, svc).toEqual({ period: "7d" });
    }
    expect(violations).toEqual([]);
  });

  it("gamification или lessons недоступны / мусор / GAMIFICATION_URL не задана → их поле null, блок доступен", async () => {
    const { s } = await loginAs(h, "read_only");
    h.fake.down.add("gamification");
    h.fake.on("lessons", "GET", `${IA}/pair-rooms/stats`, () => json(200, { pair_rooms_finished: -3 }));
    const d = (await get(s, "/admin/v1/dashboard?period=7d")).json() as Dashboard;
    expect(d.social).toEqual({ available: true, data: { ...SOCIAL_BLOCK.data, duels_finished: null, pair_rooms_finished: null } });
    expect(d.game.available).toBe(false);
    await h.close();
    h = await makeHarness({ GAMIFICATION_URL: "" });
    const ro = (await loginAs(h, "read_only")).s;
    const d2 = (await get(ro, "/admin/v1/dashboard?period=7d")).json() as Dashboard;
    expect(d2.social.data).toMatchObject({ duels_finished: null, pair_rooms_finished: 4 });
  });

  it("social недоступен, ответил 403, мусором или медленно → блок недоступен {service: social}, нули не подставляются; остальные блоки на месте", async () => {
    const { s } = await loginAs(h, "read_only");
    const handlers = [
      () => domainError(403, "PERMISSION_DENIED", { permission: "social.read" }),
      () => domainError(500, "BOOM"),
      () => json(200, { ...{ friend_requests: 1, friendships_added: 1, referrals_in_review: 0, cases_opened: 0 } }),
      () => new Promise<Response>((r) => setTimeout(() => r(json(200, { friend_requests: 1 })), 1500)),
    ];
    for (const handler of handlers) {
      h.fake.on("social", "GET", `${IA}/social/stats`, handler);
      const res = await get(s, "/admin/v1/dashboard");
      expect(res.statusCode).toBe(200);
      const d = res.json() as Dashboard;
      expect(d.social).toEqual({ available: false, data: null, service: "social" });
      expect(d.learners.available).toBe(true);
      expect(d.game.available).toBe(true);
    }
  });

  it("без SOCIAL_URL: блок недоступен без вызова social; дуэли и комнаты не спасают блок", async () => {
    await h.close();
    h = await makeHarness({ SOCIAL_URL: "" });
    const { s } = await loginAs(h, "super_admin");
    const d = (await get(s, "/admin/v1/dashboard?period=30d")).json() as Dashboard;
    expect(d.social).toEqual({ available: false, data: null, service: "social" });
    for (const b of [d.learners, d.lessons, d.memory, d.game]) expect(b.available).toBe(true);
    expect(h.fake.callsTo("social")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- общие типы спринта 7

describe("общие типы спринта 7 (admin.ts, ai.ts, правила игры)", () => {
  it("карточка ученика: категория уведомлений game — значение домена; проекция без game → true (по умолчанию включена)", async () => {
    const { s } = await loginAs(h, "support");
    const card = (await get(s, `/admin/v1/learners/${LEARNER_ID}`)).json() as AdminLearnerCard;
    expect(card.notifications?.categories).toEqual({ reminders: true, missed: true, social: false, support: true, product: true, game: true });
    h.fake.on("userAdmin", "GET", `/admin/v1/learners/${LEARNER_ID}`, () =>
      json(200, learnerCard(LEARNER_ID, { notifications: { enabled: true, categories: { reminders: true, missed: true, social: false, support: true, product: true, game: false } } })),
    );
    const off = (await get(s, `/admin/v1/learners/${LEARNER_ID}`)).json() as AdminLearnerCard;
    expect(off.notifications?.categories.game).toBe(false);
    h.fake.on("userAdmin", "GET", `/admin/v1/learners/${LEARNER_ID}`, () =>
      json(200, learnerCard(LEARNER_ID, { notifications: { enabled: true, categories: { reminders: true, missed: true, social: false, support: true, product: true, game: "yes" } } })),
    );
    expect((await get(s, `/admin/v1/learners/${LEARNER_ID}`)).statusCode).toBe(503);
  });

  it("шаблоны уведомлений: категория game принимается", async () => {
    const { s } = await loginAs(h, "communications");
    h.fake.on("notifications", "GET", "/admin/v1/notifications/templates", () => json(200, { items: [templateInfo({ key: "duel_finished", category: "game" })] }));
    const res = await get(s, "/admin/v1/notifications/templates");
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].category).toBe("game");
  });

  it("бюджет ИИ: room_cap_usd в ответе; на входе необязателен, больше месячного потолка → 422 до домена", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    expect(((await get(s, "/admin/v1/ai/budget")).json() as AiBudget).room_cap_usd).toBe(0.1);
    const body = { monthly_cap_usd: 20, learner_daily_cap_usd: 0.05, lesson_cap_usd: 0.03, speech_monthly_cap_usd: 5, alert_percent: 80, reason: "Потолок комнаты" };
    expect((await send(s, "PUT", "/admin/v1/ai/budget", { ...body, room_cap_usd: 0.2 })).statusCode).toBe(200);
    expect(h.fake.callsTo("aiGateway", "PUT").at(-1)!.body.room_cap_usd).toBe(0.2);
    expect((await send(s, "PUT", "/admin/v1/ai/budget", body)).statusCode).toBe(200);
    const big = await send(s, "PUT", "/admin/v1/ai/budget", { ...body, room_cap_usd: 21 });
    expect(big.statusCode).toBe(422);
    expect(big.json().details.field).toBe("room_cap_usd");
    expect((await send(s, "PUT", "/admin/v1/ai/budget", { ...body, room_cap_usd: -0.1 })).statusCode).toBe(422);
    expect(h.fake.callsTo("aiGateway", "PUT")).toHaveLength(2);
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/budget", () => json(200, aiBudget({ room_cap_usd: undefined })));
    expect((await get(s, "/admin/v1/ai/budget")).statusCode).toBe(503);
  });

  it("правила игры версии 3: league, duel, pair_lesson строго; в версиях 1–2 их нет — нет и в ответе", async () => {
    const { s } = await loginAs(h, "methodist");
    const v3 = { ...gameRulesPayload(), league: { prizes: [50, 30, 20], group_size: [20, 30], anomaly: { median_factor: 5, min_xp: 1500 } }, duel: { win: 30, draw: 15, participation: 10, daily_cap: 3 }, pair_lesson: { xp: 25, min_turns: 1, daily_cap: 3 } };
    h.fake.on("gamification", "GET", "/internal/v1/admin/game/rules/3", () => json(200, rulesVersionDomain({ version: 3, payload: v3 })));
    expect(((await get(s, `${GM}/rules/3`)).json() as RulesVersion).payload).toEqual(v3);
    const v1 = ((await get(s, `${GM}/rules/1`)).json() as RulesVersion).payload;
    expect(v1).not.toHaveProperty("league");
    expect(v1).not.toHaveProperty("duel");
    for (const bad of [{ ...v3, league: { ...v3.league, group_size: [30, 20] } }, { ...v3, duel: { win: -1, draw: 15, participation: 10, daily_cap: 3 } }, { ...v3, pair_lesson: {} }, { ...v3, pair_lesson: { xp: 25 } }]) {
      h.fake.on("gamification", "GET", "/internal/v1/admin/game/rules/3", () => json(200, rulesVersionDomain({ version: 3, payload: bad })));
      expect((await get(s, `${GM}/rules/3`)).statusCode).toBe(503);
    }
  });

  it("реестр кошелька: причины спринта 7 (duel, pair_lesson, league_prize, referral_welcome) принимаются", async () => {
    const { s } = await loginAs(h, "support");
    for (const reason of ["duel", "pair_lesson", "league_prize", "referral_welcome"]) {
      h.fake.on("gamification", "GET", `/internal/v1/admin/game/wallets/${LEARNER_USER_ID}/ledger`, (c) =>
        json(200, { items: [{ op_id: SANCTION_ID, currency: "xp", amount: 30, reason, source: { kind: "event", ref: `duel:${DUEL_ID}` }, rules_version: 3, multiplier: 1, capped: false, local_date: "2026-11-20", status: "confirmed", reversed_by: null, reversal_of: null, actor: "system", comment: null, created_at: "2026-11-20T10:00:00Z", _: c.path }], next_cursor: null }),
      );
      const res = await get(s, `${GM}/wallets/${LEARNER_USER_ID}/ledger`);
      expect(res.statusCode, reason).toBe(200);
      expect(res.json().items[0].reason).toBe(reason);
    }
  });

  it("журнал «Контроля диалогов»: kind=duel в фильтре и в строке", async () => {
    const { s } = await loginAs(h, "methodist");
    expect((await get(s, "/admin/v1/qa/sessions?kind=duel")).statusCode).toBe(200);
    expect(h.fake.callsTo("lessons", "GET", "/admin/v1/lesson-sessions").at(-1)!.query.kind).toBe("duel");
  });
});

// ---------------------------------------------------------------- CSRF и логи

describe("CSRF и логи", () => {
  it("каждая команда раздела без CSRF-токена или с чужим Origin → 403 CSRF_INVALID, домены не вызываются", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const { "x-csrf-token": _drop, ...noToken } = browser(s);
    for (const [key, c] of Object.entries(CASES).filter(([, c]) => c.method !== "GET")) {
      for (const headers of [noToken, browser(s, { origin: "https://evil.example" })]) {
        const res = await h.app.inject({ method: c.method, url: c.url, headers: { ...headers, ...c.headers }, payload: (c.payload ?? {}) as object });
        expect(res.statusCode, key).toBe(403);
        expect(res.json().code, key).toBe("CSRF_INVALID");
      }
    }
    expect(sectionCalls()).toHaveLength(0);
  });

  it("основания, причины, заметки и тексты учеников не попадают в логи", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    await run(s, "POST /admin/v1/moderation/cases/:caseId/resolve", { payload: { ...BAN, basis: "Секретное основание бана" } });
    await run(s, "POST /admin/v1/pair-rooms/:roomId/stop", { payload: { reason: "Секретная причина остановки" } });
    await run(s, "POST /admin/v1/referrals/:referralId/approve", { payload: { note: "Секретная заметка оператора" } });
    h.fake.on("social", "GET", `${IA}/moderation/cases/${CASE_ID}`, () => json(200, caseDomain({ comment: "Секретная жалоба ученика", status: "weird" })));
    await run(s, "GET /admin/v1/moderation/cases/:caseId");
    expect(h.logs.text).toContain("request completed");
    for (const leak of ["Секретное основание", "Секретная причина", "Секретная заметка", "Секретная жалоба", "weird"]) expect(h.logs.text).not.toContain(leak);
  });
});
