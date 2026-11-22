/**
 * Спринт 4 — ИИ, контроль диалогов, затраты через admin-bff (ai-gateway, lessons, assessment): права и step-up по
 * ролям PLAN спринта 4 (methodist, operations, qa_analyst, analyst, auditor), имена сотрудников (`*_name`, сид),
 * строгая проверка ответов доменов, коды доменов как есть, ключ провайдера ИИ — никогда наружу, лимиты тела (версии
 * агента — 128 КБ), журнал сессий без N+1 (≤ 50 параллельных вызовов затрат с таймаутом), карточка сессии из трёх
 * независимых блоков с обезличенным `user_ref`, реплики — только с qa.transcripts и причиной, дашборд (блоки lessons
 * и ai), логи без текстов учеников, причин и ключей.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminAppeal, AgentRow, AiCall, Dashboard, EvaluationCard, Page, SessionCard, SessionRow, Transcript } from "@tilhero/contracts/admin";
import type { AgentVersion, GoldenCase, TestRunSummary } from "@tilhero/contracts/ai";
import {
  APPEAL_ID,
  AUTHOR_ID,
  EVALUATION_ID,
  EVALUATION_ID_2,
  GOLDEN_INPUT,
  LEARNER_USER_ID,
  LESSON_STATS_DOMAIN,
  QA_STAFF_ID,
  REEVALUATION_BODY,
  REVIEWER_ID,
  RUN_ID,
  SEED_ACTOR_ID,
  SESSION_ID,
  SESSION_ID_2,
  agentRowDomain,
  agentVersion,
  aiCall,
  appealDomain,
  browser,
  closeRedis,
  domainError,
  evaluationDomain,
  goldenCase,
  json,
  loginAs,
  makeHarness,
  sessionCardDomain,
  sessionRowDomain,
  sessionSummary,
  stepUp,
  transcript,
  type Harness,
  type Session,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  h.fake.addStaff({ role: "methodist", staff_id: AUTHOR_ID, display_name: "Мадина Методист" });
  h.fake.addStaff({ role: "methodist", staff_id: REVIEWER_ID, display_name: "Рустам Проверяющий" });
  h.fake.addStaff({ role: "qa_analyst", staff_id: QA_STAFF_ID, display_name: "Олим QA" });
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const AG = "/admin/v1/ai/agents/conversation_partner";
const SEED_NAME = "Сид (начальное наполнение)";
const KEY = "sk-ant-api03-" + "Q".repeat(40);

const get = (s: Session, url: string, extra: Record<string, string> = {}) => h.app.inject({ url, headers: browser(s, extra) });
const send = (s: Session, method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  h.app.inject({ method, url, headers: browser(s, extra), ...(payload === undefined ? {} : { payload: payload as object }) });

function denied(res: { statusCode: number; json(): { code: string; details: { permission?: string } } }, permission: string) {
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission } });
}

// ---------------------------------------------------------------- права и step-up

describe("права и step-up (PLAN спринта 4)", () => {
  it("methodist: агенты — черновик, тесты, публикация/канарейка/откат (step-up); контроль диалогов — реплики и решения (step-up); затрат нет", async () => {
    const { s } = await loginAs(h, "methodist");
    expect((await get(s, "/admin/v1/ai/agents")).statusCode).toBe(200);
    expect((await send(s, "POST", `${AG}/versions`, {})).statusCode).toBe(201);
    expect((await send(s, "POST", `${AG}/versions/2/test-runs`, {})).statusCode).toBe(202);
    expect((await send(s, "POST", `${AG}/golden-cases`, GOLDEN_INPUT)).statusCode).toBe(201);
    const stepUps: Array<[string, "POST" | "PUT" | "DELETE", string, unknown]> = [
      ["ai.publish", "POST", `${AG}/versions/2/publish`, { reason: "тесты зелёные" }],
      ["ai.publish", "PUT", `${AG}/canary`, { version: 2, percent: 10, reason: "канарейка" }],
      ["ai.publish", "DELETE", `${AG}/canary`, { reason: "снять" }],
      ["ai.publish", "POST", `${AG}/rollback`, { reason: "откат" }],
      ["ai.publish", "PUT", "/admin/v1/ai/models/claude-haiku-5-5", { input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.5, active: true, reason: "прайс" }],
      ["qa.review", "POST", `/admin/v1/qa/evaluations/${EVALUATION_ID}/reevaluate`, REEVALUATION_BODY],
      ["qa.review", "POST", `/admin/v1/qa/appeals/${APPEAL_ID}/decide`, { decision: "upheld", note: "Оценка верна, ошибка подтверждена" }],
    ];
    for (const [perm, method, url, body] of stepUps) {
      const res = await send(s, method, url, body);
      expect(res.json(), url).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: perm } });
    }
    expect(h.fake.callsTo("aiGateway", "POST", `${AG}/versions/2/publish`)).toHaveLength(0);
    await stepUp(h, s);
    for (const [, method, url, body] of stepUps) expect((await send(s, method, url, body)).statusCode, url).toBeLessThan(300);
    expect((await send(s, "POST", `/admin/v1/qa/sessions/${SESSION_ID}/transcript`, { reason: "разбор апелляции" })).statusCode).toBe(200);
    expect((await send(s, "POST", `/admin/v1/qa/appeals/${APPEAL_ID}/take`, {})).statusCode).toBe(200);
    // затраты и лимиты — не методиста
    denied(await get(s, "/admin/v1/ai/budget"), "costs.read");
    denied(await get(s, "/admin/v1/ai/usage/summary"), "costs.read");
    denied(await send(s, "POST", "/admin/v1/ai/emergency-stop", { enabled: true, reason: "стоп" }), "costs.manage");
  });

  it("operations: бюджет и аварийная остановка (costs.manage, step-up), чтение агентов и журнала; без реплик, черновиков и решений", async () => {
    const { s } = await loginAs(h, "operations");
    expect((await get(s, "/admin/v1/ai/budget")).statusCode).toBe(200);
    expect((await get(s, "/admin/v1/ai/usage/summary")).statusCode).toBe(200);
    expect((await get(s, "/admin/v1/ai/usage?agent_id=teaching_coach")).statusCode).toBe(200);
    expect((await get(s, "/admin/v1/ai/agents")).statusCode).toBe(200);
    expect((await get(s, "/admin/v1/qa/sessions")).statusCode).toBe(200);
    const budget = { monthly_cap_usd: 20, learner_daily_cap_usd: 0.05, lesson_cap_usd: 0.03, speech_monthly_cap_usd: 5, alert_percent: 80, reason: "решение владельца" };
    expect((await send(s, "PUT", "/admin/v1/ai/budget", budget)).json()).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: "costs.manage" } });
    expect((await send(s, "POST", "/admin/v1/ai/emergency-stop", { enabled: true, reason: "аномальный расход" })).json().code).toBe("STEP_UP_REQUIRED");
    await stepUp(h, s);
    expect((await send(s, "PUT", "/admin/v1/ai/budget", budget)).json()).toMatchObject({ monthly_cap_usd: 20, ai_enabled: true });
    const stop = await send(s, "POST", "/admin/v1/ai/emergency-stop", { enabled: true, reason: "аномальный расход" });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ ai_enabled: false });
    expect(h.fake.callsTo("aiGateway", "POST", "/admin/v1/ai/emergency-stop")[0]!.body).toEqual({ enabled: true, reason: "аномальный расход" });
    denied(await send(s, "POST", `/admin/v1/qa/sessions/${SESSION_ID}/transcript`, { reason: "просто посмотреть" }), "qa.transcripts");
    denied(await send(s, "POST", `${AG}/versions`, {}), "ai.manage");
    denied(await send(s, "POST", `${AG}/versions/2/publish`, { reason: "публикую" }), "ai.publish");
    denied(await send(s, "POST", `/admin/v1/qa/appeals/${APPEAL_ID}/take`, {}), "qa.review");
  });

  it("qa_analyst: журнал, карточка, реплики с причиной, вызовы своей сессии; без затрат, черновиков, публикации и решений; вход без MFA", async () => {
    const { s } = await loginAs(h, "qa_analyst");
    expect((await get(s, "/admin/v1/qa/sessions")).statusCode).toBe(200);
    expect((await get(s, `/admin/v1/qa/sessions/${SESSION_ID}`)).statusCode).toBe(200);
    expect((await send(s, "POST", `/admin/v1/qa/sessions/${SESSION_ID}/transcript`, { reason: "разбор жалобы ученика" })).statusCode).toBe(200);
    expect((await send(s, "POST", `/admin/v1/qa/evaluations/${EVALUATION_ID}/flag`, { reason: "спорная оценка" })).statusCode).toBe(200);
    expect((await get(s, "/admin/v1/qa/appeals")).statusCode).toBe(200);
    expect((await get(s, "/admin/v1/ai/agents")).statusCode).toBe(200);
    expect((await get(s, "/admin/v1/content/lesson")).statusCode).toBe(200);
    // вызовы ИИ: только одной сессии (qa.read); общий реестр затрат — costs.read
    expect((await get(s, `/admin/v1/ai/usage?session_id=${SESSION_ID}`)).statusCode).toBe(200);
    const before = h.fake.callsTo("aiGateway").length;
    denied(await get(s, "/admin/v1/ai/usage"), "costs.read");
    denied(await get(s, "/admin/v1/ai/usage?agent_id=teaching_coach"), "costs.read");
    expect(h.fake.callsTo("aiGateway")).toHaveLength(before);
    denied(await get(s, "/admin/v1/ai/budget"), "costs.read");
    denied(await get(s, "/admin/v1/ai/usage/summary"), "costs.read");
    denied(await send(s, "POST", `${AG}/versions`, {}), "ai.manage");
    denied(await send(s, "POST", `/admin/v1/qa/appeals/${APPEAL_ID}/take`, {}), "qa.review");
    denied(await send(s, "POST", `/admin/v1/qa/evaluations/${EVALUATION_ID}/reevaluate`, REEVALUATION_BODY), "qa.review");
    denied(await get(s, "/admin/v1/learners"), "users.read");
  });

  it("analyst / auditor — чтение агентов, журнала и затрат; read_only и support — ничего из спринта 4", async () => {
    for (const role of ["analyst", "auditor"] as const) {
      const { s } = await loginAs(h, role);
      for (const url of ["/admin/v1/ai/agents", "/admin/v1/ai/models", "/admin/v1/ai/budget", "/admin/v1/ai/usage/summary", "/admin/v1/qa/sessions", "/admin/v1/qa/appeals"]) {
        expect((await get(s, url)).statusCode, `${role} ${url}`).toBe(200);
      }
      denied(await send(s, "POST", `/admin/v1/qa/sessions/${SESSION_ID}/transcript`, { reason: "просто посмотреть" }), "qa.transcripts");
      denied(await send(s, "PUT", "/admin/v1/ai/budget", { monthly_cap_usd: 1, learner_daily_cap_usd: 0, lesson_cap_usd: 0, speech_monthly_cap_usd: 0, alert_percent: 80, reason: "ой" }), "costs.manage");
    }
    for (const role of ["read_only", "support"] as const) {
      const { s } = await loginAs(h, role);
      denied(await get(s, "/admin/v1/qa/sessions"), "qa.read");
      denied(await get(s, "/admin/v1/ai/agents"), "ai.read");
      denied(await get(s, "/admin/v1/ai/usage"), "costs.read|qa.read");
    }
  });

  it("имперсонация (dev): super_admin, примеривший qa_analyst, читает реплики, но не переоценивает и не видит затрат", async () => {
    await h.close();
    h = await makeHarness({ ENV: "dev", NODE_ENV: "development" });
    const { s } = await loginAs(h, "super_admin");
    expect((await send(s, "POST", "/admin/v1/dev/impersonate", { role: "qa_analyst" })).statusCode).toBe(200);
    await stepUp(h, s);
    expect((await send(s, "POST", `/admin/v1/qa/sessions/${SESSION_ID}/transcript`, { reason: "проверка роли QA" })).statusCode).toBe(200);
    denied(await send(s, "POST", `/admin/v1/qa/evaluations/${EVALUATION_ID}/reevaluate`, REEVALUATION_BODY), "qa.review");
    denied(await get(s, "/admin/v1/ai/budget"), "costs.read");
    const actor = h.fake.callsTo("lessons", "POST").at(-1)!.actor!;
    // спринт 5: + memory.read
    expect(actor.permissions).toEqual(["ai.read", "content.read", "dashboard.read", "memory.read", "qa.read", "qa.transcripts"]);
  });
});

// ---------------------------------------------------------------- агенты и версии

describe("агенты: имена, строгая проверка, коды домена", () => {
  it("реестр: published_by_name из lookup (сид — «Сид (начальное наполнение)»), published_by и служебные поля не уходят", async () => {
    const { s } = await loginAs(h, "methodist");
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/agents", () =>
      json(200, {
        items: [
          agentRowDomain(),
          agentRowDomain({ agent_id: "teaching_coach", free_text: false, published: { version: 3, model_id: "claude-haiku-5-5", published_at: "2026-11-19T00:00:00Z", published_by: REVIEWER_ID } }),
          agentRowDomain({ agent_id: "duel_host", implementation: "llm", availability: "planned", planned_sprint: 7, rollout: null, published: null, draft_version: null, last_test_run: null, calls_7d: 0, unavailable_pct_7d: null }),
        ],
      }),
    );
    const res = await get(s, "/admin/v1/ai/agents");
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: AgentRow[] }).items;
    expect(items.map((a) => a.published?.published_by_name ?? null)).toEqual([SEED_NAME, "Рустам Проверяющий", null]);
    expect(items[0]!.rollout).toEqual({ agent_id: "conversation_partner", published_version: 1, canary_version: 2, canary_percent: 10, previous_version: null });
    expect(res.body).not.toContain("published_by\"");
    expect(res.body).not.toContain("seed_hash");
    expect(res.body).not.toContain("от домена не берётся");
    // сид без lookup, один запрос имён на весь реестр
    expect(h.fake.callsTo("adminIdentity", "GET", "/admin/v1/staff/lookup")).toHaveLength(1);
    expect(h.fake.callsTo("adminIdentity", "GET", "/admin/v1/staff/lookup")[0]!.query.ids).toBe(REVIEWER_ID);
  });

  it("карточка агента: версии с author_name / published_by_name; версия — инструкции, правила и JSON Schema как есть, лишнее отброшено", async () => {
    const { s } = await loginAs(h, "qa_analyst");
    const card = await get(s, AG);
    expect(card.statusCode).toBe(200);
    const versions = (card.json() as AgentRow & { versions: Array<Record<string, unknown>> }).versions;
    expect(versions[0]).toMatchObject({ version: 2, author_name: "Мадина Методист", published_by_name: null, canary: true });
    expect(versions[1]).toMatchObject({ version: 1, author_name: SEED_NAME, published_by_name: SEED_NAME });
    expect(Object.keys(versions[0]!)).not.toContain("author_id");
    const v = await get(s, `${AG}/versions/1`);
    const body = v.json() as AgentVersion & { author_name: string | null; published_by_name: string | null };
    expect(body.instructions).toContain("sk-."); // упоминание формата ключа в правилах — не ключ
    expect(body.output_schema).toEqual(agentVersion().output_schema);
    expect(body).toMatchObject({ author_id: SEED_ACTOR_ID, author_name: SEED_NAME, published_by_name: SEED_NAME, schema_version: "conversation_partner.v1" });
    expect(v.body).not.toContain("prompt_hash");
    // испорченное значение (температура > 1, неизвестный агент) → 503
    h.fake.on("aiGateway", "GET", `${AG}/versions/1`, () => json(200, agentVersion({ temperature: 1.5 })));
    expect((await get(s, `${AG}/versions/1`)).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "ai-gateway" } });
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/agents", () => json(200, { items: [agentRowDomain({ agent_id: "travel_agent" })] }));
    expect((await get(s, "/admin/v1/ai/agents")).statusCode).toBe(503);
    expect(h.logs.text).toContain("domain response rejected by normalization");
  });

  it("коды домена — как есть: TESTS_REQUIRED, TESTS_FAILED {case_ids}, DRAFT_EXISTS {version}, VERSION_NOT_DRAFT, VERSION_CONFLICT, NO_PREVIOUS_VERSION", async () => {
    const { s } = await loginAs(h, "methodist");
    await stepUp(h, s);
    const cases: Array<[string, "POST" | "PATCH", string, unknown, number, string, Record<string, unknown>]> = [
      ["POST", "POST", `${AG}/versions/2/publish`, { reason: "публикую" }, 422, "TESTS_REQUIRED", {}],
      ["POST", "POST", `${AG}/versions/2/publish`, { reason: "публикую" }, 422, "TESTS_FAILED", { case_ids: ["cp-05-injection"] }],
      ["POST", "POST", `${AG}/versions`, {}, 409, "DRAFT_EXISTS", { version: 2 }],
      ["PATCH", "PATCH", `${AG}/versions/1`, { notes: "правка" }, 409, "VERSION_NOT_DRAFT", {}],
      ["PATCH", "PATCH", `${AG}/versions/2`, { notes: "правка" }, 409, "VERSION_CONFLICT", {}],
      ["POST", "POST", `${AG}/rollback`, { reason: "откат" }, 409, "NO_PREVIOUS_VERSION", {}],
    ];
    for (const [domainMethod, method, url, body, status, code, details] of cases) {
      h.fake.on("aiGateway", domainMethod, url, () => domainError(status, code, details));
      const res = await send(s, method, url, body);
      expect(res.statusCode, code).toBe(status);
      expect(res.json(), code).toMatchObject({ code, details });
    }
  });

  it("черновик: If-Match передаётся в ai-gateway, неверный — 422 до домена; DELETE черновика → 204; прогон: 202 и опрос результата", async () => {
    const { s } = await loginAs(h, "methodist");
    const ok = await send(s, "PATCH", `${AG}/versions/2`, { instructions: "Новая инструкция", max_output_tokens: 300 }, { "if-match": "2026-11-19T08:00:00Z" });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as AgentVersion).instructions).toBe("Новая инструкция");
    const call = h.fake.callsTo("aiGateway", "PATCH")[0]!;
    expect(call.headers["if-match"]).toBe("2026-11-19T08:00:00Z");
    expect(call.body).toEqual({ instructions: "Новая инструкция", max_output_tokens: 300 });
    for (const bad of ["<script>", "a b"]) {
      expect((await send(s, "PATCH", `${AG}/versions/2`, { notes: "x" }, { "if-match": bad })).statusCode, bad).toBe(422);
    }
    expect(h.fake.callsTo("aiGateway", "PATCH")).toHaveLength(1);
    // без If-Match — тоже передаётся домену (решает ai-gateway)
    expect((await send(s, "PATCH", `${AG}/versions/2`, { notes: "без блокировки" })).statusCode).toBe(200);
    expect(h.fake.callsTo("aiGateway", "PATCH").at(-1)!.headers["if-match"]).toBeUndefined();
    const del = await send(s, "DELETE", `${AG}/versions/2`);
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");
    const run = await send(s, "POST", `${AG}/versions/2/test-runs`, {});
    expect(run.statusCode).toBe(202);
    expect(run.json() as TestRunSummary).toMatchObject({ run_id: RUN_ID, status: "running", finished_at: null });
    const poll = await get(s, `${AG}/versions/2/test-runs/${RUN_ID}`);
    expect(poll.json()).toMatchObject({
      status: "finished",
      passed_mandatory: false,
      results: [
        { case_id: "cp-01-correct", passed: true, skipped: ["output.intent"] },
        { case_id: "cp-05-injection", passed: false, skipped: [] },
        { case_id: "cp-07-kids", passed: true, skipped: [] },
      ],
    });
    expect(poll.body).not.toContain("started_by");
  });

  it("вход проверяется до домена: агент вне реестра, процент канарейки 0/51, пустая правка, лишнее поле, неизвестная проверка золотого теста → 422", async () => {
    const { s } = await loginAs(h, "methodist");
    await stepUp(h, s);
    const bad: Array<["POST" | "PUT" | "PATCH", string, unknown]> = [
      ["POST", "/admin/v1/ai/agents/travel_agent/versions", {}],
      ["PUT", `${AG}/canary`, { version: 2, percent: 0, reason: "ноль" }],
      ["PUT", `${AG}/canary`, { version: 2, percent: 51, reason: "много" }],
      ["PATCH", `${AG}/versions/2`, {}],
      ["PATCH", `${AG}/versions/2`, { temperature: 1.5 }],
      ["PATCH", `${AG}/versions/2`, { max_output_tokens: 2001 }],
      ["PATCH", `${AG}/versions/2`, { timeout_ms: 1000 }],
      ["PATCH", `${AG}/versions/2`, { status: "published" }],
      ["PATCH", `${AG}/versions/2`, { author_id: AUTHOR_ID }],
      ["PATCH", `${AG}/versions/2`, { output_schema: "not an object" }],
      ["POST", `${AG}/golden-cases`, { ...GOLDEN_INPUT, checks: [{ kind: "eval", path: "x" }] }],
      ["POST", `${AG}/golden-cases`, { ...GOLDEN_INPUT, checks: [{ kind: "field_equals", path: "intent" }] }],
      ["POST", `${AG}/golden-cases`, { ...GOLDEN_INPUT, input: { audience: "toddlers", context: {} } }],
      ["PUT", "/admin/v1/ai/models/claude-haiku-5-5", { input_usd_per_mtok: -1, output_usd_per_mtok: 0.5, active: true, reason: "прайс" }],
    ];
    for (const [method, url, body] of bad) {
      const res = await send(s, method, url, body);
      expect(res.statusCode, `${method} ${url} ${JSON.stringify(body)}`).toBe(422);
    }
    expect(h.fake.callsTo("aiGateway")).toHaveLength(0);
  });

  it("золотые тесты: создание (контекст — объект как есть), правка, удаление-архив (204 или 200 с archived_at); проверки — строго по виду", async () => {
    const { s } = await loginAs(h, "methodist");
    const created = await send(s, "POST", `${AG}/golden-cases`, GOLDEN_INPUT, { "idempotency-key": "golden-create-0001" });
    expect(created.statusCode).toBe(201);
    expect((created.json() as GoldenCase).input).toEqual(GOLDEN_INPUT.input);
    expect((created.json() as GoldenCase).checks).toEqual(GOLDEN_INPUT.checks);
    expect(((await get(s, `${AG}/golden-cases`)).json() as { items: GoldenCase[] }).items[0]!.checks).toEqual(goldenCase().checks);
    expect(h.fake.callsTo("aiGateway", "POST", `${AG}/golden-cases`)[0]!.headers["idempotency-key"]).toBe("golden-create-0001");
    expect((await send(s, "PATCH", "/admin/v1/ai/golden-cases/cp-01-correct", { mandatory: false })).json()).toMatchObject({ case_id: "cp-01-correct", mandatory: false });
    expect((await send(s, "DELETE", "/admin/v1/ai/golden-cases/cp-01-correct")).statusCode).toBe(204);
    h.fake.on("aiGateway", "DELETE", "/admin/v1/ai/golden-cases/cp-01-correct", () => json(200, goldenCase({ archived_at: "2026-11-19T12:00:00Z" })));
    const archived = await send(s, "DELETE", "/admin/v1/ai/golden-cases/cp-01-correct");
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ archived_at: "2026-11-19T12:00:00Z" });
    // домен прислал проверку неизвестного вида → 503
    h.fake.on("aiGateway", "GET", `${AG}/golden-cases`, () => json(200, { items: [goldenCase({ checks: [{ kind: "regex", path: "x", value: ".*" }] })] }));
    expect((await get(s, `${AG}/golden-cases`)).statusCode).toBe(503);
  });

  it("лимит тела: версия агента — 128 КБ (инструкции 20 000 + правила 10 000 символов кириллицы проходят); остальное — 64 КБ", async () => {
    const { s } = await loginAs(h, "methodist");
    const instructions = "Я".repeat(20_000);
    const rules = "П".repeat(10_000);
    const big = { instructions, rules, output_schema: { type: "object", description: "ж".repeat(5000) } };
    const size = Buffer.byteLength(JSON.stringify(big));
    expect(size).toBeGreaterThan(64 * 1024);
    expect(size).toBeLessThan(128 * 1024);
    const ok = await send(s, "PATCH", `${AG}/versions/2`, big);
    expect(ok.statusCode, ok.body.slice(0, 200)).toBe(200);
    expect(h.fake.callsTo("aiGateway", "PATCH")[0]!.body.instructions).toHaveLength(20_000);
    // длиннее контракта — 422; тело больше 128 КБ — 413 без вызова домена
    expect((await send(s, "PATCH", `${AG}/versions/2`, { instructions: "Я".repeat(20_001) })).statusCode).toBe(422);
    expect((await send(s, "PATCH", `${AG}/versions/2`, { rules: "П".repeat(10_001) })).statusCode).toBe(422);
    const huge = await send(s, "PATCH", `${AG}/versions/2`, { ...big, output_schema: { type: "object", description: "ж".repeat(40_000) } });
    expect(huge.statusCode).toBe(413);
    expect(huge.json().code).toBe("PAYLOAD_TOO_LARGE");
    // золотой тест и прочие команды — 64 КБ
    const golden = await send(s, "POST", `${AG}/golden-cases`, { ...GOLDEN_INPUT, input: { audience: "adults", context: { history: "ш".repeat(40_000) } } });
    expect(golden.statusCode).toBe(413);
    expect(h.fake.callsTo("aiGateway", "PATCH")).toHaveLength(1);
    expect(h.fake.callsTo("aiGateway", "POST")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- ключ провайдера

describe("ключ провайдера ИИ никогда не уходит из admin-bff", () => {
  it("поле с именем ключа или строка вида ключа в любом ответе ai-gateway (тело, ErrorBody) → 503, в лог — путь без значения", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const provider = await get(s, "/admin/v1/ai/provider");
    expect(provider.json()).toEqual({
      provider: "fake",
      key_configured: false,
      last_error: null,
      ai_enabled: true,
      speech: { provider: "fake_speech", key_configured: false, region: null, last_error: null },
    });

    const leaks: Array<[string, string, () => Response, () => Promise<{ statusCode: number; body: string; json(): any }>]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      ["GET", "/admin/v1/ai/provider", () => json(200, { provider: "anthropic", key_configured: true, ai_enabled: true, last_error: null, api_key: KEY }), () => get(s, "/admin/v1/ai/provider")],
      ["GET", "/admin/v1/ai/provider", () => json(200, { provider: "anthropic", key_configured: true, ai_enabled: true, last_error: null, ANTHROPIC_API_KEY: "x" }), () => get(s, "/admin/v1/ai/provider")],
      ["GET", "/admin/v1/ai/provider", () => json(200, { provider: "anthropic", key_configured: true, ai_enabled: true, last_error: { code: "auth", at: "2026-11-19T00:00:00Z", detail: `invalid x-api-key ${KEY}` } }), () => get(s, "/admin/v1/ai/provider")],
      ["GET", `${AG}/versions/1`, () => json(200, agentVersion({ notes: `ключ для теста: ${KEY}` })), () => get(s, `${AG}/versions/1`)],
      ["GET", "/admin/v1/ai/models", () => json(200, { items: [{ model_id: "claude-haiku-5-5", provider: "anthropic", input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.5, active: true, updated_at: "2026-11-19T00:00:00Z", provider_config: { secret: "s" } }] }), () => get(s, "/admin/v1/ai/models")],
      ["POST", `${AG}/versions/2/publish`, () => domainError(422, "TESTS_FAILED", { case_ids: ["c1"], debug: { authorization: `Bearer ${KEY}` } }), () => send(s, "POST", `${AG}/versions/2/publish`, { reason: "публикую" })],
      ["PUT", "/admin/v1/ai/budget", () => json(400, { code: "PROVIDER_ERROR", message: `upstream said ${KEY}`, trace_id: "t", details: {} }), () => send(s, "PUT", "/admin/v1/ai/budget", { monthly_cap_usd: 20, learner_daily_cap_usd: 0.05, lesson_cap_usd: 0.03, speech_monthly_cap_usd: 5, alert_percent: 80, reason: "лимиты" })],
    ];
    for (const [method, path, handler, call] of leaks) {
      h.fake.on("aiGateway", method, path, handler);
      const res = await call();
      expect(res.statusCode, path).toBe(503);
      expect(res.json(), path).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "ai-gateway" } });
      expect(res.body).not.toContain("sk-ant");
    }
    // похожее, но не ключ: «task-…», «ask-for-…» в тексте и идентификаторах, «sk-» в правилах — проходит
    h.fake.on("aiGateway", "GET", `${AG}/versions/1`, () =>
      json(200, agentVersion({ notes: "task-oriented-conversation-practice-for-adults; never print sk- strings", rules: "scene sc-ask-for-directions-in-the-city-centre" })),
    );
    expect((await get(s, `${AG}/versions/1`)).statusCode).toBe(200);
    const text = h.logs.text;
    expect(text).toContain("PROVIDER_KEY_IN_RESPONSE");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("Q".repeat(40));
  });

  it("дашборд и карточка сессии: ответ ai-gateway с ключом → блок недоступен, остальное показывается", async () => {
    const { s } = await loginAs(h, "super_admin");
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/usage/summary", () => json(200, { period: "month", key: KEY }));
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/usage", () => json(200, { items: [aiCall({ reason: null, model_id: "claude-haiku-5-5", provider_key: KEY })], next_cursor: null }));
    const d = (await get(s, "/admin/v1/dashboard")).json() as Dashboard;
    expect(d.ai).toEqual({ available: false, data: null, service: "ai-gateway" });
    expect(d.lessons.available).toBe(true);
    const card = (await get(s, `/admin/v1/qa/sessions/${SESSION_ID}`)).json() as SessionCard;
    expect(card.errors).toEqual({ "ai-gateway": "UPSTREAM_UNAVAILABLE" });
    expect(card.ai_calls).toBeNull();
    expect(card.session).not.toBeNull();
    expect(JSON.stringify(card)).not.toContain("sk-ant");
    expect(h.logs.text).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------- журнал сессий

describe("контроль диалогов: журнал сессий", () => {
  it("строка lessons + сводка assessment (одним запросом) + модели, стоимость и p95 из ai-gateway; сессия выбором реплик — без запроса затрат; ученик не уходит", async () => {
    const { s } = await loginAs(h, "qa_analyst");
    const res = await get(s, "/admin/v1/qa/sessions?from=2026-11-01&kind=lesson&level=A1&limit=20");
    expect(res.statusCode).toBe(200);
    const page = res.json() as Page<SessionRow>;
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ session_id: SESSION_ID, models: ["claude-haiku-5-5", "claude-sonnet-5-5"], cost_usd: 0.00411, p95_latency_ms: 2100, flags: ["ai_used", "appealed"] });
    expect(page.items[1]).toMatchObject({ session_id: SESSION_ID_2, ai_mode: "choices", models: [], cost_usd: 0, p95_latency_ms: null, flags: ["hints"] });
    expect(h.fake.callsTo("lessons", "GET", "/admin/v1/lesson-sessions")[0]!.query).toEqual({ from: "2026-11-01", kind: "lesson", level: "A1", limit: "20" });
    const summary = h.fake.callsTo("assessment", "GET", "/admin/v1/evaluations/summary");
    expect(summary).toHaveLength(1);
    expect(summary[0]!.params.getAll("session_id")).toEqual([SESSION_ID, SESSION_ID_2]);
    // затраты — одним пакетным вызовом и только для сессий с ИИ
    const usage = h.fake.calls.filter((c) => c.service === "aiGateway");
    expect(usage.map((c) => c.path)).toEqual(["/admin/v1/ai/usage/by-session"]);
    expect(usage[0]!.params.getAll("session_id")).toEqual([SESSION_ID]);
    expect(usage[0]!.actor?.permissions).toContain("qa.read");
    expect(res.body).not.toContain(LEARNER_USER_ID);
    expect(res.body).not.toContain("account_id");
    // по умолчанию — 50 строк; больше 50 нельзя
    await get(s, "/admin/v1/qa/sessions");
    expect(h.fake.callsTo("lessons", "GET", "/admin/v1/lesson-sessions").at(-1)!.query).toEqual({ limit: "50" });
    expect((await get(s, "/admin/v1/qa/sessions?limit=51")).statusCode).toBe(422);
    expect((await get(s, "/admin/v1/qa/sessions?flag=secret")).statusCode).toBe(422);
  });

  it("без N+1: 50 сессий → один вызов by-session; ai-gateway 404/503/мусор/таймаут/ключ → cost_usd null (не 0), журнал открывается", async () => {
    const { s } = await loginAs(h, "qa_analyst");
    const ids = Array.from({ length: 50 }, () => randomUUID());
    h.fake.on("lessons", "GET", "/admin/v1/lesson-sessions", () =>
      json(200, { items: ids.map((id, i) => sessionRowDomain({ session_id: id, ...(i === 49 ? { ai_mode: "choices", flags: [] } : {}) })), next_cursor: "c2" }),
    );
    const res = await get(s, "/admin/v1/qa/sessions");
    expect(res.statusCode).toBe(200);
    const page = res.json() as Page<SessionRow>;
    expect(page.next_cursor).toBe("c2");
    expect(page.items.map((r) => r.session_id)).toEqual(ids);
    expect(page.items.slice(0, 49).every((r) => r.cost_usd === 0.001 && r.models[0] === "claude-haiku-5-5" && r.p95_latency_ms === 900)).toBe(true);
    expect(page.items[49]).toMatchObject({ models: [], cost_usd: 0, p95_latency_ms: null }); // выбор реплик — вызовов не было
    const batch = h.fake.calls.filter((c) => c.service === "aiGateway");
    expect(batch).toHaveLength(1);
    expect(batch[0]!.path).toBe("/admin/v1/ai/usage/by-session");
    expect(batch[0]!.params.getAll("session_id")).toEqual(ids.slice(0, 49));
    // сессия с ИИ, которой нет в ответе, — вызовов не было: 0
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/usage/by-session", () => json(200, { items: [] }));
    expect(((await get(s, "/admin/v1/qa/sessions")).json() as Page<SessionRow>).items[0]).toMatchObject({ models: [], cost_usd: 0, p95_latency_ms: null });

    const unknown = { models: [], cost_usd: null, p95_latency_ms: null };
    for (const broken of [
      () => domainError(404, "NOT_FOUND"),
      () => domainError(503, "UNAVAILABLE"),
      () => json(200, { items: [{ session_id: ids[0], models: [], cost_usd: -1, p95_latency_ms: null }] }),
      () => json(200, { items: [{ session_id: ids[0], models: [], cost_usd: 0, p95_latency_ms: null, api_key: KEY }] }),
      () => new Promise<Response>((r) => setTimeout(() => r(json(200, { items: [] })), 1500)),
    ]) {
      h.fake.on("aiGateway", "GET", "/admin/v1/ai/usage/by-session", broken);
      const started = Date.now();
      const r = await get(s, "/admin/v1/qa/sessions");
      expect(Date.now() - started).toBeLessThan(1400); // DASHBOARD_TIMEOUT_MS=500
      expect(r.statusCode).toBe(200);
      const rows = (r.json() as Page<SessionRow>).items;
      expect(rows[0]).toMatchObject(unknown);
      expect(rows[49]).toMatchObject({ cost_usd: 0 });
    }
    h.fake.down.add("aiGateway");
    expect(((await get(s, "/admin/v1/qa/sessions")).json() as Page<SessionRow>).items[0]).toMatchObject(unknown);
    expect(h.logs.text).toContain("qa sessions: ai usage unavailable, cost unknown");
    expect(h.logs.text).not.toContain(KEY);
  });

  it("сводка assessment: зачёт и ручная проверка — по актуальной оценке (переоценка), флаг QA; assessment недоступен — значения lessons", async () => {
    const { s } = await loginAs(h, "qa_analyst");
    h.fake.on("lessons", "GET", "/admin/v1/lesson-sessions", () =>
      json(200, { items: [sessionRowDomain({ passed: false, flags: ["ai_used", "human_review"] }), sessionRowDomain({ session_id: SESSION_ID_2, passed: null, ai_mode: "choices", flags: [] })], next_cursor: null }),
    );
    h.fake.on("assessment", "GET", "/admin/v1/evaluations/summary", () =>
      json(200, { items: [sessionSummary({ passed: true, requires_human_review: false, flagged: true }), sessionSummary({ session_id: SESSION_ID_2, passed: false, requires_human_review: true, appeal_status: "corrected" })] }),
    );
    const rows = ((await get(s, "/admin/v1/qa/sessions")).json() as Page<SessionRow>).items;
    expect(rows[0]).toMatchObject({ passed: true, flags: ["ai_used", "flagged"] });
    expect(rows[1]).toMatchObject({ passed: false, flags: ["human_review", "appealed"] });
    // assessment недоступен или ответил мусором — журнал открывается со значениями lessons
    for (const broken of [() => domainError(500, "BOOM"), () => json(200, { items: [{ session_id: SESSION_ID, passed: "yes" }] })]) {
      h.fake.on("assessment", "GET", "/admin/v1/evaluations/summary", broken);
      const res = await get(s, "/admin/v1/qa/sessions");
      expect(res.statusCode).toBe(200);
      expect((res.json() as Page<SessionRow>).items[0]).toMatchObject({ passed: false, flags: ["ai_used", "human_review"] });
    }
    expect(h.logs.text).toContain("qa sessions: assessment summary unavailable");
  });

  it("фильтр по флагу: lessons-флаги — в lessons; appealed / flagged — после сводки assessment (до 3 страниц lessons, курсор lessons); без сводки — 503", async () => {
    const { s } = await loginAs(h, "qa_analyst");
    await get(s, "/admin/v1/qa/sessions?flag=ai_used");
    expect(h.fake.callsTo("lessons", "GET", "/admin/v1/lesson-sessions").at(-1)!.query).toEqual({ flag: "ai_used", limit: "50" });
    const appealed = (await get(s, "/admin/v1/qa/sessions?flag=appealed")).json() as Page<SessionRow>;
    expect(appealed.items.map((r) => r.session_id)).toEqual([SESSION_ID]);
    expect(h.fake.callsTo("lessons", "GET", "/admin/v1/lesson-sessions").at(-1)!.query).toEqual({ limit: "50" });

    // страницы lessons по 2 строки, отмеченные QA — по одной на странице: limit 3 → 3 страницы, курсор последней
    const ids: string[] = Array.from({ length: 8 }, () => randomUUID());
    h.fake.on("lessons", "GET", "/admin/v1/lesson-sessions", (c) => {
      const at = Number(c.query.cursor ?? "0");
      const n = Math.min(Number(c.query.limit), 2);
      return json(200, { items: ids.slice(at, at + n).map((id) => sessionRowDomain({ session_id: id, ai_mode: "choices", flags: [] })), next_cursor: String(at + n) });
    });
    h.fake.on("assessment", "GET", "/admin/v1/evaluations/summary", (c) =>
      json(200, { items: c.params.getAll("session_id").map((id) => sessionSummary({ session_id: id, flagged: ids.indexOf(id) % 2 === 0 })) }),
    );
    const before = h.fake.callsTo("lessons", "GET", "/admin/v1/lesson-sessions").length;
    const flagged = (await get(s, "/admin/v1/qa/sessions?flag=flagged&limit=3")).json() as Page<SessionRow>;
    expect(flagged.items.map((r) => r.session_id)).toEqual([ids[0], ids[2], ids[4]]);
    expect(flagged.items.every((r) => r.flags.includes("flagged"))).toBe(true);
    const scans = h.fake.callsTo("lessons", "GET", "/admin/v1/lesson-sessions").slice(before);
    expect(scans.map((c) => [c.query.cursor ?? null, c.query.limit])).toEqual([[null, "3"], ["2", "2"], ["4", "1"]]);
    expect(flagged.next_cursor).toBe("5");
    // фильтр по флагу assessment без сводки — неверен: 503 {service: assessment}
    h.fake.down.add("assessment");
    expect((await get(s, "/admin/v1/qa/sessions?flag=appealed")).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "assessment" } });
    expect((await get(s, "/admin/v1/qa/sessions?flag=hints")).statusCode).toBe(200);
  });

  it("lessons недоступен → 503 {service: lessons}; испорченная строка → 503; 4xx lessons — как есть", async () => {
    const { s } = await loginAs(h, "qa_analyst");
    h.fake.on("lessons", "GET", "/admin/v1/lesson-sessions", () => json(200, { items: [sessionRowDomain({ status: "lost" })], next_cursor: null }));
    expect((await get(s, "/admin/v1/qa/sessions")).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "lessons" } });
    h.fake.on("lessons", "GET", "/admin/v1/lesson-sessions", () => domainError(422, "FILTER_INVALID", { field: "from" }));
    expect((await get(s, "/admin/v1/qa/sessions?from=2026-13-01")).json()).toMatchObject({ code: "FILTER_INVALID", details: { field: "from" } });
    h.fake.down.add("lessons");
    expect((await get(s, "/admin/v1/qa/sessions")).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "lessons" } });
  });
});

// ---------------------------------------------------------------- карточка сессии

describe("контроль диалогов: карточка сессии из трёх независимых блоков", () => {
  it("lessons + assessment + ai-gateway: user_ref вместо user_id, метаданные реплик без текста, цепочка оценок с именами, вызовы ИИ", async () => {
    const { s } = await loginAs(h, "qa_analyst");
    h.fake.on("assessment", "GET", "/admin/v1/evaluations", () =>
      json(200, {
        items: [
          evaluationDomain({ evaluation_id: EVALUATION_ID_2, supersedes: EVALUATION_ID, created_by: REVIEWER_ID, reason: "Ответ верный", created_at: "2026-11-19T12:00:00Z" }),
          evaluationDomain({ flags: [{ reason: "спорно", by: QA_STAFF_ID, at: "2026-11-19T11:00:00Z" }] }),
        ],
      }),
    );
    const res = await get(s, `/admin/v1/qa/sessions/${SESSION_ID}`);
    expect(res.statusCode).toBe(200);
    const card = res.json() as SessionCard;
    expect(card.errors).toEqual({});
    expect(card.session!.user_ref).toBe("5e3f9a0c"); // от lessons (HMAC); BFF не считает sha256 от user_id
    expect(JSON.stringify(card)).not.toContain(LEARNER_USER_ID);
    expect(card.session).toMatchObject({ content_versions: { lesson: 2, scenario: 1, rubric: 1, "retrieval:l-01-greetings": 3, "media_exercise:m-own-coffee-order.ex1": 1 }, models: ["claude-haiku-5-5", "claude-sonnet-5-5"], p95_latency_ms: 2100 });
    expect(card.session!.status_history.map((x) => x.to)).toEqual(["ready", "in_progress", "completed"]);
    expect(card.session!.turns_meta[1]).toEqual({ turn_id: "T2", speaker: "learner", mode: "text", intent: "order", ai_call_id: expect.any(String), redacted: false });
    // новая оценка — последней; имена: система → null, сотрудник → имя, флаг → имя QA
    const evals = card.evaluations as EvaluationCard[];
    expect(evals.map((e) => e.evaluation_id)).toEqual([EVALUATION_ID, EVALUATION_ID_2]);
    expect(evals[0]).toMatchObject({ created_by_name: null, flags: [{ reason: "спорно", by_name: "Олим QA", at: "2026-11-19T11:00:00Z" }] });
    expect(evals[1]).toMatchObject({ created_by_name: "Рустам Проверяющий", supersedes: EVALUATION_ID, reason: "Ответ верный" });
    expect((card.ai_calls as AiCall[]).map((c) => c.agent_id)).toEqual(["conversation_partner", "independent_evaluator"]);
    // ученик и тексты реплик в карточку не попадают
    for (const leak of [LEARNER_USER_ID, "learner-turn-text-in-card", "Hi! What can I get you", "created_by\"", "\"by\"", "request_id"]) {
      expect(res.body, leak).not.toContain(leak);
    }
    expect(h.fake.callsTo("assessment", "GET", "/admin/v1/evaluations")[0]!.query).toEqual({ session_id: SESSION_ID });
    expect(h.fake.callsTo("aiGateway", "GET", "/admin/v1/ai/usage")[0]!.query).toEqual({ session_id: SESSION_ID, limit: "100" });
  });

  it("недоступный блок → null и errors[service]; остальные блоки на месте; сессии нет в lessons → 404", async () => {
    const { s } = await loginAs(h, "qa_analyst");
    h.fake.on("assessment", "GET", "/admin/v1/evaluations", () => domainError(500, "BOOM"));
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/usage", () => json(200, { items: [aiCall({ status: "exploded" })], next_cursor: null }));
    const a = (await get(s, `/admin/v1/qa/sessions/${SESSION_ID}`)).json() as SessionCard;
    expect(a.errors).toEqual({ assessment: "UPSTREAM_UNAVAILABLE", "ai-gateway": "UPSTREAM_BAD_RESPONSE" });
    expect(a.evaluations).toBeNull();
    expect(a.ai_calls).toBeNull();
    expect(a.session).toMatchObject({ session_id: SESSION_ID, models: [], cost_usd: null, p95_latency_ms: null });

    h.fake.down.add("lessons");
    h.fake.on("assessment", "GET", "/admin/v1/evaluations", () => json(200, { items: [evaluationDomain()] }));
    const b = (await get(s, `/admin/v1/qa/sessions/${SESSION_ID}`)).json() as SessionCard;
    expect(b.session).toBeNull();
    expect(b.errors).toEqual({ lessons: "UPSTREAM_UNAVAILABLE", "ai-gateway": "UPSTREAM_BAD_RESPONSE" });
    expect(b.evaluations).toHaveLength(1);
    h.fake.down.delete("lessons");

    // lessons: карточка без user_ref (даже с user_id) — блок недоступен, BFF псевдоним не вычисляет; 403 домена — код блока
    h.fake.on("lessons", "GET", `/admin/v1/lesson-sessions/${SESSION_ID}`, () => json(200, sessionCardDomain({ user_ref: undefined })));
    expect(((await get(s, `/admin/v1/qa/sessions/${SESSION_ID}`)).json() as SessionCard).errors.lessons).toBe("UPSTREAM_BAD_RESPONSE");
    h.fake.on("lessons", "GET", `/admin/v1/lesson-sessions/${SESSION_ID}`, () => json(200, sessionCardDomain({ user_id: undefined, user_ref: "0a1b2c3d" })));
    expect(((await get(s, `/admin/v1/qa/sessions/${SESSION_ID}`)).json() as SessionCard).session!.user_ref).toBe("0a1b2c3d");
    h.fake.on("lessons", "GET", `/admin/v1/lesson-sessions/${SESSION_ID}`, () => domainError(403, "PERMISSION_DENIED", { permission: "qa.read" }));
    expect(((await get(s, `/admin/v1/qa/sessions/${SESSION_ID}`)).json() as SessionCard).errors.lessons).toBe("PERMISSION_DENIED");
    h.fake.on("lessons", "GET", `/admin/v1/lesson-sessions/${SESSION_ID}`, () => domainError(404, "SESSION_NOT_FOUND"));
    const missing = await get(s, `/admin/v1/qa/sessions/${SESSION_ID}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("SESSION_NOT_FOUND");
    expect((await get(s, "/admin/v1/qa/sessions/not-a-uuid")).statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------- реплики, оценки, апелляции

describe("контроль диалогов: реплики, переоценка, апелляции", () => {
  it("реплики: только qa.transcripts и причина ≥ 10 (до домена); причина — в lessons (аудит там); тексты — только в ответе", async () => {
    const { s } = await loginAs(h, "qa_analyst");
    for (const body of [{}, { reason: "коротко" }, { reason: "достаточно длинная", extra: 1 }]) {
      expect((await send(s, "POST", `/admin/v1/qa/sessions/${SESSION_ID}/transcript`, body)).statusCode, JSON.stringify(body)).toBe(422);
    }
    expect(h.fake.callsTo("lessons", "POST")).toHaveLength(0);
    const reason = "разбор апелляции ученика 77";
    h.fake.on("lessons", "POST", `/admin/v1/lesson-sessions/${SESSION_ID}/transcript`, (c) =>
      json(200, transcript({ open_answer: "I would like a coffee\u0000 please", user_id: LEARNER_USER_ID, reason: c.body.reason })),
    );
    const res = await send(s, "POST", `/admin/v1/qa/sessions/${SESSION_ID}/transcript`, { reason });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const t = res.json() as Transcript;
    expect(t.turns.map((x) => x.text)).toEqual(["Hi! What can I get you?", "I want latte", null]);
    expect(t.turns[2]).toMatchObject({ redacted: true, text: null });
    expect(t.open_answer).toBe("I would like a coffee  please");
    expect(res.body).not.toContain(LEARNER_USER_ID);
    expect(res.body).not.toContain(reason);
    expect(h.fake.callsTo("lessons", "POST")[0]!.body).toEqual({ reason });
    expect(h.fake.callsTo("lessons", "POST")[0]!.actor?.permissions).toContain("qa.transcripts");
  });

  it("переоценка: step-up, appeal_id по умолчанию null, created_by_name — проверяющий; EVALUATION_SUPERSEDED и SELF_REEVALUATION — как есть", async () => {
    const { staff, s } = await loginAs(h, "methodist", { display_name: "Нигора Методист" });
    await stepUp(h, s);
    const { appeal_id: _a, ...noAppeal } = REEVALUATION_BODY;
    const res = await send(s, "POST", `/admin/v1/qa/evaluations/${EVALUATION_ID}/reevaluate`, noAppeal, { "idempotency-key": "reeval-key-0001" });
    expect(res.statusCode).toBe(201);
    expect(res.json() as EvaluationCard).toMatchObject({ evaluation_id: EVALUATION_ID_2, supersedes: EVALUATION_ID, created_by_name: "Нигора Методист", flags: [] });
    const call = h.fake.callsTo("assessment", "POST", `/admin/v1/evaluations/${EVALUATION_ID}/reevaluate`)[0]!;
    expect(call.body).toEqual({ ...noAppeal, appeal_id: null });
    expect(call.headers["idempotency-key"]).toBe("reeval-key-0001");
    expect(call.actor?.id).toBe(staff.staff_id);
    expect(res.body).not.toContain("created_by\"");
    for (const code of ["EVALUATION_SUPERSEDED", "SELF_REEVALUATION"]) {
      h.fake.on("assessment", "POST", `/admin/v1/evaluations/${EVALUATION_ID}/reevaluate`, () => domainError(409, code, { current: EVALUATION_ID_2 }));
      const r = await send(s, "POST", `/admin/v1/qa/evaluations/${EVALUATION_ID}/reevaluate`, REEVALUATION_BODY);
      expect(r.statusCode, code).toBe(409);
      expect(r.json(), code).toMatchObject({ code, details: { current: EVALUATION_ID_2 } });
    }
    // вход до домена: балл 4, критерий вне рубрики, причина < 10, 6 ошибок, длинная цитата → 422
    for (const bad of [
      { ...REEVALUATION_BODY, scores: { task: 4 } },
      { ...REEVALUATION_BODY, scores: { charisma: 1 } },
      { ...REEVALUATION_BODY, reason: "коротко" },
      { ...REEVALUATION_BODY, confirmed_errors: Array.from({ length: 6 }, (_, i) => ({ turn_id: `T${i}`, evidence: "x", correction: "y", error_code: "article", severity: "low" })) },
      { ...REEVALUATION_BODY, confirmed_errors: [{ turn_id: "T2", evidence: "x".repeat(121), correction: "y", error_code: "article", severity: "low" }] },
    ]) {
      expect((await send(s, "POST", `/admin/v1/qa/evaluations/${EVALUATION_ID}/reevaluate`, bad)).statusCode).toBe(422);
    }
  });

  it("флаг (qa.read): оценка не меняется, by_name — сотрудник; апелляции: список с именами, «взять», решение со step-up; APPEAL_EXISTS — как есть", async () => {
    const qa = await loginAs(h, "qa_analyst", { display_name: "Камола QA" });
    const flag = await send(qa.s, "POST", `/admin/v1/qa/evaluations/${EVALUATION_ID}/flag`, { reason: "спорная оценка" });
    expect(flag.json() as EvaluationCard).toMatchObject({ evaluation_id: EVALUATION_ID, flags: [{ reason: "спорная оценка", by_name: "Камола QA" }] });

    h.fake.on("assessment", "GET", "/admin/v1/appeals", () =>
      json(200, { items: [appealDomain(), appealDomain({ appeal_id: randomUUID(), status: "corrected", taken_by: REVIEWER_ID, decided_by: REVIEWER_ID, decision_note: "Исправлено", new_evaluation_id: EVALUATION_ID_2, decided_at: "2026-11-19T12:00:00Z", reason: null, reason_redacted: true })], next_cursor: null }),
    );
    const list = await get(qa.s, "/admin/v1/qa/appeals?status=new");
    const items = (list.json() as Page<AdminAppeal>).items;
    expect(items[0]).toMatchObject({ status: "new", reason: "Я ответил правильно,\nпроверьте вторую реплику", taken_by_name: null });
    expect(items[1]).toMatchObject({ taken_by_name: "Рустам Проверяющий", decided_by_name: "Рустам Проверяющий", reason: null, reason_redacted: true });
    expect(list.body).not.toContain(LEARNER_USER_ID);
    expect(list.body).not.toContain("taken_by\"");
    expect(h.fake.callsTo("assessment", "GET", "/admin/v1/appeals")[0]!.query).toEqual({ status: "new" });

    const m = await loginAs(h, "methodist", { display_name: "Нигора Методист" });
    const take = await send(m.s, "POST", `/admin/v1/qa/appeals/${APPEAL_ID}/take`, {});
    expect(take.json()).toMatchObject({ status: "in_review", taken_by_name: "Нигора Методист" });
    const decide = () => send(m.s, "POST", `/admin/v1/qa/appeals/${APPEAL_ID}/decide`, { decision: "corrected", note: "Оценка исправлена по апелляции", new_evaluation_id: EVALUATION_ID_2 });
    expect((await decide()).json()).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: "qa.review" } });
    await stepUp(h, m.s);
    expect((await decide()).json()).toMatchObject({ status: "corrected", decided_by_name: "Нигора Методист", new_evaluation_id: EVALUATION_ID_2 });
    // upheld без new_evaluation_id → null в домен; заметка < 10 → 422
    await send(m.s, "POST", `/admin/v1/qa/appeals/${APPEAL_ID}/decide`, { decision: "upheld", note: "Оценка верна, ошибка есть" });
    expect(h.fake.callsTo("assessment", "POST", `/admin/v1/appeals/${APPEAL_ID}/decide`).at(-1)!.body).toEqual({ decision: "upheld", note: "Оценка верна, ошибка есть", new_evaluation_id: null });
    expect((await send(m.s, "POST", `/admin/v1/qa/appeals/${APPEAL_ID}/decide`, { decision: "upheld", note: "ок" })).statusCode).toBe(422);
    for (const code of ["APPEAL_EXISTS", "APPEAL_ALREADY_DECIDED"]) {
      h.fake.on("assessment", "POST", `/admin/v1/appeals/${APPEAL_ID}/decide`, () => domainError(409, code));
      expect((await decide()).json().code, code).toBe(code);
    }
  });
});

// ---------------------------------------------------------------- затраты, модели, дашборд

describe("затраты, модели и обзор", () => {
  it("модели и цены, бюджет, сводка затрат (period по умолчанию month), вызовы — без user_id ученика", async () => {
    const { s } = await loginAs(h, "super_admin");
    expect((await get(s, "/admin/v1/ai/models")).json().items.map((m: { model_id: string }) => m.model_id)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "fake",
      "azure-speech-pa",
      "fake-speech",
    ]);
    const sum = await get(s, "/admin/v1/ai/usage/summary");
    expect(sum.json()).toMatchObject({ period: "month", spent_usd: 3.25, monthly_cap_usd: 20, ai_enabled: true });
    expect(h.fake.callsTo("aiGateway", "GET", "/admin/v1/ai/usage/summary")[0]!.query).toEqual({ period: "month" });
    await get(s, "/admin/v1/ai/usage/summary?period=day");
    expect(h.fake.callsTo("aiGateway", "GET", "/admin/v1/ai/usage/summary").at(-1)!.query).toEqual({ period: "day" });
    expect((await get(s, "/admin/v1/ai/usage/summary?period=year")).statusCode).toBe(422);
    const calls = await get(s, `/admin/v1/ai/usage?session_id=${SESSION_ID.toUpperCase()}`);
    expect(calls.statusCode).toBe(200);
    expect(h.fake.calls.find((c) => c.service === "aiGateway" && c.path === "/admin/v1/ai/usage")!.query).toEqual({ session_id: SESSION_ID });
    expect(calls.body).not.toContain(LEARNER_USER_ID);
    expect(calls.body).not.toContain("request_id");
    expect((await get(s, "/admin/v1/ai/budget")).json()).toEqual({ ai_enabled: true, monthly_cap_usd: 20, learner_daily_cap_usd: 0.05, lesson_cap_usd: 0.03, speech_monthly_cap_usd: 5, room_cap_usd: 0.1, alert_percent: 80, updated_at: "2026-11-19T00:00:00Z" });
  });

  it("дашборд: lessons = статистика lessons (period) + счётчики assessment; ai = сводка месяца; assessment недоступен → блок lessons недоступен", async () => {
    const { s } = await loginAs(h, "read_only");
    const d = (await get(s, "/admin/v1/dashboard?period=7d")).json() as Dashboard;
    expect(d.lessons).toEqual({
      available: true,
      data: { period: "7d", started: 40, completed: 31, completion_pct: 77.5, median_minutes: 19, by_kind: { lesson: 30, scenario: 6, media: 3, review: 1, reading: 2, duel: 5 }, ai_degraded_pct: 4.2, appeals_open: 2, human_review_open: 1 },
    });
    expect(d.ai.data).toMatchObject({ period: "month", spent_usd: 3.25, cap_used_pct: 16.3, unavailable_pct: 1.5, p95_latency_ms: 2300 });
    expect(h.fake.callsTo("lessons", "GET", "/admin/v1/lesson-sessions/stats")[0]!.query).toEqual({ period: "7d" });
    expect(h.fake.callsTo("assessment", "GET", "/admin/v1/assessment/stats")[0]!.query).toEqual({ period: "7d" });
    expect(h.fake.callsTo("aiGateway", "GET", "/admin/v1/ai/usage/summary")[0]!.query).toEqual({ period: "month" });

    // lessons ответил периодом в своей форме (week) — в обзоре период запроса
    h.fake.on("lessons", "GET", "/admin/v1/lesson-sessions/stats", () => json(200, { ...LESSON_STATS_DOMAIN, period: "week" }));
    expect(((await get(s, "/admin/v1/dashboard?period=7d")).json() as Dashboard).lessons.data?.period).toBe("7d");

    h.fake.down.add("assessment");
    h.fake.on("aiGateway", "GET", "/admin/v1/ai/usage/summary", () => json(200, { period: "month", spent_usd: -1 }));
    const d2 = (await get(s, "/admin/v1/dashboard")).json() as Dashboard;
    expect(d2.lessons).toEqual({ available: false, data: null, service: "assessment" });
    expect(d2.ai).toEqual({ available: false, data: null, service: "ai-gateway" });
    expect(d2.learners.available).toBe(true);
    expect(d2.content.available).toBe(true);
    h.fake.down.add("lessons");
    expect(((await get(s, "/admin/v1/dashboard")).json() as Dashboard).lessons).toEqual({ available: false, data: null, service: "lessons" });
  });
});

// ---------------------------------------------------------------- логи

describe("логи без текстов учеников, причин и инструкций", () => {
  it("реплики, ответы, причины просмотра и переоценки, текст апелляции, инструкции агента — не попадают в лог", async () => {
    const { s } = await loginAs(h, "super_admin");
    await stepUp(h, s);
    const marks = {
      turn: "секретная-реплика-ученика-91",
      reason: "секретная-причина-просмотра-91",
      reeval: "секретная-причина-переоценки-91",
      appeal: "секретный-текст-апелляции-91",
      instructions: "секретная-инструкция-агента-91",
      note: "секретная-заметка-решения-91",
    };
    h.fake.on("lessons", "POST", `/admin/v1/lesson-sessions/${SESSION_ID}/transcript`, () =>
      json(200, transcript({ turns: [{ turn_id: "T2", speaker: "learner", text: marks.turn, mode: "text", redacted: false }] })),
    );
    h.fake.on("assessment", "GET", "/admin/v1/appeals", () => json(200, { items: [appealDomain({ reason: marks.appeal })], next_cursor: null }));
    await send(s, "POST", `/admin/v1/qa/sessions/${SESSION_ID}/transcript`, { reason: marks.reason });
    await send(s, "POST", `/admin/v1/qa/evaluations/${EVALUATION_ID}/reevaluate`, { ...REEVALUATION_BODY, reason: marks.reeval });
    await get(s, "/admin/v1/qa/appeals");
    await send(s, "PATCH", `${AG}/versions/2`, { instructions: marks.instructions });
    await send(s, "POST", `/admin/v1/qa/appeals/${APPEAL_ID}/decide`, { decision: "upheld", note: marks.note });
    // ошибки: испорченный ответ с текстом ученика и 4xx домена с текстом
    h.fake.on("assessment", "GET", "/admin/v1/appeals", () => json(200, { items: [appealDomain({ reason: marks.appeal, status: "lost" })], next_cursor: null }));
    expect((await get(s, "/admin/v1/qa/appeals")).statusCode).toBe(503);
    h.fake.on("lessons", "POST", `/admin/v1/lesson-sessions/${SESSION_ID}/transcript`, () => domainError(409, "TRANSCRIPT_REDACTED", { text: marks.turn }));
    await send(s, "POST", `/admin/v1/qa/sessions/${SESSION_ID}/transcript`, { reason: marks.reason });
    const text = h.logs.text;
    expect(text).toContain("request completed");
    for (const leak of Object.values(marks)) expect(text, leak).not.toContain(leak);
  });
});
