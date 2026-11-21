/**
 * Sprint 4 part of the mock admin-bff: ai-gateway (agents, versions with If-Match, golden cases, test runs answered by
 * a deterministic «fake provider», publication gated by a fresh green run → 422 TESTS_REQUIRED / TESTS_FAILED, canary
 * 1…50 %, rollback, models and prices, provider status without the key, budget and the emergency stop, usage), lessons
 * + assessment for «Контроль диалогов» (journal, card with independent blocks, transcript with a reason and an audit
 * record, flag, re-evaluation that keeps the original, appeals: take → decide). Permissions and step-up as
 * packages/contracts/src/admin.ts: ai.read / ai.manage / ai.publish (step-up); qa.read / qa.transcripts / qa.review
 * (step-up); costs.read / costs.manage (step-up).
 */
import type { AdminAppeal, AgentRow, AgentVersionRow, AiBudget, AiProviderStatus, AiUsageSummary, EvaluationCard, LessonStats, Permission, SessionCard, TestRun } from "@tilhero/contracts/admin";
import type { AgentId } from "@tilhero/contracts/ai";
import type { Ctx } from "./content-bff";
import { DAY, HOUR, iso, MIN } from "./data";
import * as D from "./ai-data";

type P = Record<string, unknown>;

export interface AiScenario {
  /** month spend in USD (default 12.4 of the $20 cap = 62 %) */
  spentUsd?: number;
  /** the AI is switched off by the emergency stop from the start */
  aiOff?: boolean;
  /** the provider key is not set in ai-gateway */
  noKey?: boolean;
  /** blocks of the session card whose domain is down */
  qaDown?: Array<"lessons" | "assessment" | "ai-gateway">;
  /** prod/stage ai-gateway: a run on fake does not open publication (422 TESTS_REQUIRED {reason: real_provider_required}) */
  realProviderRequired?: boolean;
  /** sprint 5: the speech provider is not connected — Azure: key / region not set; whisper: the recognition service
   *  address is not set (pronunciation hidden from learners) */
  noSpeechKey?: boolean;
  /** release 5.1: the provider of pronunciation (default whisper — own server, $0) */
  speechProvider?: "whisper" | "azure_speech";
}

interface Run extends TestRun {
  polls: number;
}

const ERR_CODE = { lessons: "UPSTREAM_UNAVAILABLE", assessment: "UPSTREAM_UNAVAILABLE", "ai-gateway": "UPSTREAM_UNAVAILABLE" } as const;

export class AiStore {
  agents = D.AGENTS.map((a) => ({ ...a }));
  vers = D.versions();
  cases = D.cases();
  models = D.MODELS();
  rollout: Record<string, { published_version: number | null; canary_version: number | null; canary_percent: number; previous_version: number | null }> = {
    conversation_partner: { published_version: 2, canary_version: null, canary_percent: 0, previous_version: 1 },
    teaching_coach: { published_version: 1, canary_version: null, canary_percent: 0, previous_version: null },
    independent_evaluator: { published_version: 1, canary_version: 2, canary_percent: 10, previous_version: null },
  };
  runs: Run[] = [];
  budget: AiBudget;
  provider: Omit<AiProviderStatus, "ai_enabled">;
  sessions = D.sessions();
  evals = D.evaluations();
  calls = D.calls();
  appeals: AdminAppeal[] = D.appeals();
  /** audit actions written by this part (the shared audit log gets them too) */
  readonly audit: Array<{ action: string; id: string; reason: string | null }> = [];
  private seq = 0;
  private spent: number;

  constructor(private readonly sc: AiScenario = {}) {
    this.spent = sc.spentUsd ?? 12.4;
    this.budget = { ai_enabled: !sc.aiOff, monthly_cap_usd: 20, learner_daily_cap_usd: 0.05, lesson_cap_usd: 0.03, speech_monthly_cap_usd: 5, room_cap_usd: 0.1, alert_percent: 80, updated_at: iso(-6 * DAY) };
    const whisper = (sc.speechProvider ?? "whisper") === "whisper";
    const speech: AiProviderStatus["speech"] = whisper
      ? sc.noSpeechKey
        ? { provider: "whisper", key_configured: false, region: null, last_error: { code: "not_configured", at: iso(-3 * HOUR) } }
        : { provider: "whisper", key_configured: true, region: null, last_error: null }
      : sc.noSpeechKey
        ? { provider: "azure_speech", key_configured: false, region: null, last_error: { code: "not_configured", at: iso(-3 * HOUR) } }
        : { provider: "azure_speech", key_configured: true, region: "westeurope", last_error: null };
    this.provider = sc.noKey ? { provider: "anthropic", key_configured: false, last_error: { code: "ai_disabled", at: iso(-10 * MIN) }, speech } : { provider: "anthropic", key_configured: true, last_error: { code: "timeout", at: iso(-26 * HOUR) }, speech };
    // the green run of the independent_evaluator draft (it is the canary)
    const v2 = this.vers.independent_evaluator!.find((v) => v.version === 2)!;
    const r = this.makeRun("independent_evaluator", 2, null, true);
    v2.last_test_run = summary(r);
    const v1cp = this.vers.conversation_partner!.find((v) => v.version === 2)!;
    v1cp.last_test_run = summary(this.makeRun("conversation_partner", 2, null, true, -11 * DAY));
  }

  /** e2e helper: another staff member saved the draft in between (its updated_at moves on) */
  touchDraft(agent: AgentId): void {
    const d = this.vers[agent]?.find((v) => v.status === "draft");
    if (d) d.updated_at = iso(1000);
  }

  /** states of the versions of an agent, oldest first */
  states(agent: AgentId): string[] {
    return (this.vers[agent] ?? []).map((v) => `v${v.version}:${v.status}`);
  }

  /* ---------------------------------------------------------------- derived views */

  private row(a: (typeof this.agents)[number]): AgentRow {
    const vs = this.vers[a.agent_id] ?? [];
    const ro = this.rollout[a.agent_id] ?? null;
    const pub = vs.find((v) => v.status === "published");
    const llm = a.implementation === "llm" && a.availability === "active";
    const lastRun = [...this.runs].reverse().find((r) => r.agent_id === a.agent_id) ?? null;
    return {
      ...a,
      rollout: llm && ro ? { agent_id: a.agent_id, ...ro } : null,
      published: pub ? { version: pub.version, model_id: pub.model_id, published_at: pub.published_at!, published_by_name: this.nameOf(pub.published_by) } : null,
      draft_version: vs.find((v) => v.status === "draft")?.version ?? null,
      last_test_run: lastRun ? summary(lastRun) : null,
      calls_7d: llm ? ({ conversation_partner: 2140, teaching_coach: 412, independent_evaluator: 655 } as Record<string, number>)[a.agent_id] ?? 0 : 0,
      unavailable_pct_7d: llm ? ({ conversation_partner: 3.2, teaching_coach: 1.1, independent_evaluator: 12.4 } as Record<string, number>)[a.agent_id] ?? null : null,
    };
  }

  private versionRows(agent: string): AgentVersionRow[] {
    const ro = this.rollout[agent];
    return [...(this.vers[agent] ?? [])]
      .sort((a, b) => b.version - a.version)
      .map((v) => ({
        version: v.version,
        status: v.status,
        model_id: v.model_id,
        author_name: this.nameOf(v.author_id),
        created_at: v.created_at,
        published_at: v.published_at,
        published_by_name: this.nameOf(v.published_by),
        last_test_run: v.last_test_run,
        canary: ro?.canary_version === v.version,
      }));
  }

  private versionView(v: D.MockVersion) {
    const canary = this.rollout[v.agent_id]?.canary_version === v.version;
    return { ...v, canary, author_name: this.nameOf(v.author_id), published_by_name: this.nameOf(v.published_by) };
  }

  private inCanary(agent: string, version: number): boolean {
    return this.rollout[agent]?.canary_version === version;
  }

  private makeRun(agent: string, version: number, by: string | null, instant = false, ago = -1 * HOUR): Run {
    const v = this.vers[agent]!.find((x) => x.version === version)!;
    const cs = this.cases.filter((c) => c.agent_id === agent && !c.archived_at);
    const agentFree = this.agents.find((a) => a.agent_id === agent)?.free_text ?? false;
    const out = D.FAKE_OUTPUT[agent] ?? {};
    const schema = v.output_schema as { required?: string[]; properties?: Record<string, { maxLength?: number }> };
    const results = cs.map((c) => {
      const failures: string[] = [];
      const skipped: string[] = [];
      const refused = agentFree && c.input.audience === "kids";
      const root: Record<string, unknown> = refused ? { status: "refused", reason: "kids_not_allowed" } : { status: "ok", reason: null, output: out };
      for (const ch of c.checks) {
        if (ch.kind === "schema_valid") {
          if (refused) continue;
          for (const f of schema.required ?? []) if (!(f in out)) failures.push(`schema_valid: output.${f} is required but missing`);
          for (const [f, p] of Object.entries(schema.properties ?? {})) {
            const val = out[f];
            if (typeof p.maxLength === "number" && typeof val === "string" && val.length > p.maxLength) failures.push(`schema_valid: output.${f} is longer than maxLength ${p.maxLength} (${val.length})`);
          }
          continue;
        }
        if (ch.path === "output" || ch.path.startsWith("output.")) {
          if (ch.kind === "field_absent" && ch.path === "output") {
            if ("output" in root) failures.push("field_absent: output is present");
          } else skipped.push(`${ch.kind} ${ch.path}`);
          continue;
        }
        const got = root[ch.path];
        if (ch.kind === "field_equals" && got !== ch.value) failures.push(`field_equals ${ch.path}: got ${JSON.stringify(got)}, expected ${JSON.stringify(ch.value)}`);
        if (ch.kind === "field_in" && !ch.values.includes(got as never)) failures.push(`field_in ${ch.path}: got ${JSON.stringify(got)}`);
        if (ch.kind === "field_absent" && got !== undefined && got !== null) failures.push(`field_absent ${ch.path}: present`);
      }
      return { case_id: c.case_id, title: c.title, mandatory: c.mandatory, passed: !failures.length, failures, skipped, latency_ms: 400 + ((c.title.length * 13) % 900), cost_usd: 0 };
    });
    const passed = results.filter((r) => r.passed).length;
    const run: Run = {
      run_id: `ru000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
      agent_id: agent as AgentId,
      version,
      status: instant ? "finished" : "running",
      provider: "fake",
      passed: instant ? passed : 0,
      failed: instant ? results.length - passed : 0,
      passed_mandatory: instant ? results.every((r) => r.passed || !r.mandatory) : false,
      cost_usd: 0,
      started_at: instant ? iso(ago) : iso(0),
      finished_at: instant ? iso(ago + 2 * MIN) : null,
      results: instant ? results : [],
      polls: 0,
    };
    (run as Run & { all: typeof results }).all = results;
    this.runs.push(run);
    if (by) this.audit.push({ action: "ai.test_run", id: `${agent}@${version}`, reason: null });
    return run;
  }

  /** a poll moves the run on: 4 cases per poll, then finished */
  private advance(r: Run): Run {
    if (r.status !== "running") return r;
    const all = (r as Run & { all: Run["results"] }).all;
    r.polls++;
    const done = Math.min(all.length, r.polls * 4);
    r.results = all.slice(0, done);
    r.passed = r.results.filter((x) => x.passed).length;
    r.failed = r.results.length - r.passed;
    if (done >= all.length) {
      r.status = "finished";
      r.finished_at = iso(0);
      r.passed_mandatory = all.every((x) => x.passed || !x.mandatory);
    }
    const v = this.vers[r.agent_id]?.find((x) => x.version === r.version);
    if (v) v.last_test_run = summary(r);
    return r;
  }

  summary(period: AiUsageSummary["period"]): AiUsageSummary {
    const all = D.byDay(19);
    const total = all.reduce((a, d) => a + d.spent_usd, 0);
    const k = this.spent / total;
    const days = all.map((d) => ({ ...d, spent_usd: Math.round(d.spent_usd * k * 10_000) / 10_000 }));
    const sub = period === "day" ? days.slice(-1) : period === "week" ? days.slice(-7) : days;
    const spent = Math.round(sub.reduce((a, d) => a + d.spent_usd, 0) * 100) / 100;
    const calls = sub.reduce((a, d) => a + d.calls, 0);
    const unavailable = Math.round(calls * 0.046);
    const share = (x: number) => Math.round(x * 10_000) / 10_000;
    return {
      period,
      spent_usd: spent,
      monthly_cap_usd: this.budget.monthly_cap_usd,
      cap_used_pct: Math.round((this.spent / this.budget.monthly_cap_usd) * 1000) / 10,
      calls,
      unavailable,
      unavailable_pct: calls ? Math.round((unavailable / calls) * 1000) / 10 : null,
      p95_latency_ms: 2380,
      by_agent: [
        { agent_id: "conversation_partner", calls: Math.round(calls * 0.66), spent_usd: share(spent * 0.31), unavailable: Math.round(unavailable * 0.5) },
        { agent_id: "independent_evaluator", calls: Math.round(calls * 0.2), spent_usd: share(spent * 0.61), unavailable: Math.round(unavailable * 0.4) },
        { agent_id: "teaching_coach", calls: Math.round(calls * 0.14), spent_usd: share(spent * 0.08), unavailable: Math.round(unavailable * 0.1) },
      ],
      by_model: [
        { model_id: "claude-haiku-5-5", calls: Math.round(calls * 0.8), input_tokens: calls * 690, output_tokens: calls * 70, spent_usd: share(spent * 0.39) },
        { model_id: "claude-sonnet-5-5", calls: Math.round(calls * 0.2), input_tokens: calls * 480, output_tokens: calls * 104, spent_usd: share(spent * 0.61) },
      ],
      by_day: sub,
      avg_cost_per_lesson_usd: 0.0118,
      ai_enabled: this.budget.ai_enabled,
      alert_percent: this.budget.alert_percent,
      // sprint 5: pronunciation (pronunciation_coach) — part of spent_usd; release 5.1: whisper (own server) costs $0
      speech: (() => {
        const minutes = period === "day" ? 14.5 : period === "week" ? 96 : 136.5;
        const price = this.provider.speech.provider === "whisper" ? 0 : (this.models.find((m) => m.model_id === "azure-speech-pa")?.audio_usd_per_hour ?? 1.32);
        const spentUsd = Math.round((minutes / 60) * price * 10_000) / 10_000;
        const monthUsd = Math.round((136.5 / 60) * price * 10_000) / 10_000;
        // the sub-cap of pronunciation (AiBudget.speech_monthly_cap_usd): reached → the feature is hidden from learners
        const cap = this.budget.speech_monthly_cap_usd;
        return { calls: Math.round(minutes * 6), audio_minutes: minutes, spent_usd: spentUsd, speech_available: this.budget.ai_enabled && !this.sc.noSpeechKey && monthUsd < cap, cap_usd: cap };
      })(),
    };
  }

  lessonStats(period: LessonStats["period"]): LessonStats {
    const m = period === "today" ? 1 : period === "7d" ? 7 : 30;
    return {
      period,
      started: 64 * m,
      completed: 51 * m,
      completion_pct: 79.7,
      median_minutes: 18,
      by_kind: { lesson: 40 * m, scenario: 14 * m, media: 8 * m, review: 2 * m, reading: 5 * m, duel: 0 },
      ai_degraded_pct: this.budget.ai_enabled ? 6.3 : 100,
      appeals_open: this.appeals.filter((a) => a.status === "new" || a.status === "in_review").length,
      human_review_open: Object.values(this.evals).filter((ch) => ch.length && ch[ch.length - 1]!.requires_human_review).length,
    };
  }

  private card(id: string): SessionCard | null {
    const s = this.sessions.find((x) => x.row.session_id === id);
    if (!s) return null;
    const down = new Set(this.sc.qaDown ?? []);
    const errors: SessionCard["errors"] = {};
    for (const b of down) errors[b] = ERR_CODE[b];
    return {
      session: down.has("lessons") ? null : { ...s.card, ...s.row },
      evaluations: down.has("assessment") ? null : (this.evals[id] ?? []),
      ai_calls: down.has("ai-gateway") ? null : (this.calls[id] ?? []),
      errors,
    };
  }

  private evalById(id: string): { chain: EvaluationCard[]; e: EvaluationCard; sid: string } | null {
    for (const [sid, chain] of Object.entries(this.evals)) {
      const e = chain.find((x) => x.evaluation_id === id);
      if (e) return { chain, e, sid };
    }
    return null;
  }

  private nameOf: (id: string | null | undefined) => string | null = () => null;

  /* ---------------------------------------------------------------- routes */

  async handle(method: string, path: string, body: P, q: URLSearchParams, idem: string | undefined, headers: Record<string, string>, x: Ctx): Promise<boolean> {
    if (!/^\/(ai|qa)\//.test(path)) return false;
    this.nameOf = x.nameOf;
    const has = (p: Permission) => x.perms.has(p);
    const need = async (p: Permission | Permission[], stepUp = false): Promise<boolean> => {
      const ps = Array.isArray(p) ? p : [p];
      if (!ps.some(has)) {
        await x.err(403, "PERMISSION_DENIED", { permission: ps[0] });
        return false;
      }
      if (stepUp && !x.stepUpOk()) {
        await x.err(403, "STEP_UP_REQUIRED", { permission: ps[0] });
        return false;
      }
      return true;
    };
    const bad = (field: string) => x.err(422, "VALIDATION_ERROR", { in: "body", field, errors: [] });
    const reasonOf = (min = 5) => {
      const r = String(body.reason ?? "").trim();
      return r.length >= min && r.length <= 500 ? r : null;
    };
    const audit = (action: string, id: string, reason: string | null = null) => {
      this.audit.push({ action, id, reason });
      x.record(action, path.startsWith("/qa") ? "session" : "agent", id, null, reason);
    };
    const done = async (st: number, data?: unknown) => {
      await x.json(st, data);
      return true;
    };
    const fail = async (st: number, code: string, details: Record<string, unknown> = {}) => {
      await x.err(st, code, details);
      return true;
    };
    const key = `${method} ${path}`;
    let m: RegExpMatchArray | null;

    /* ---------- agents ---------- */
    if (key === "GET /ai/agents") return (await need("ai.read")) ? done(200, { items: this.agents.map((a) => this.row(a)) }) : true;
    if ((m = path.match(/^\/ai\/agents\/([a-z_]+)$/)) && method === "GET") {
      if (!(await need("ai.read"))) return true;
      const a = this.agents.find((y) => y.agent_id === m![1]);
      if (!a) return fail(404, "NOT_FOUND");
      return done(200, { ...this.row(a), versions: this.versionRows(a.agent_id) });
    }
    if ((m = path.match(/^\/ai\/agents\/([a-z_]+)\/versions$/)) && method === "POST") {
      if (!(await need("ai.manage"))) return true;
      const vs = this.vers[m[1]!];
      if (!vs) return fail(404, "NOT_FOUND");
      const draft = vs.find((v) => v.status === "draft");
      if (draft) return fail(409, "DRAFT_EXISTS", { version: draft.version });
      const from = vs.find((v) => v.version === (typeof body.from_version === "number" ? body.from_version : this.rollout[m![1]!]?.published_version)) ?? vs[vs.length - 1]!;
      const nv: D.MockVersion = { ...JSON.parse(JSON.stringify(from)), version: Math.max(...vs.map((v) => v.version)) + 1, status: "draft", author_id: x.me.staff_id, created_at: iso(0), updated_at: iso(0), published_at: null, published_by: null, last_test_run: null, notes: null };
      vs.push(nv);
      audit("ai.version_created", `${m[1]}@${nv.version}`);
      return done(201, this.versionView(nv));
    }
    if ((m = path.match(/^\/ai\/agents\/([a-z_]+)\/versions\/(\d+)$/))) {
      const vs = this.vers[m[1]!];
      const v = vs?.find((y) => y.version === Number(m![2]));
      if (method === "GET") return (await need("ai.read")) ? (v ? done(200, this.versionView(v)) : fail(404, "NOT_FOUND")) : true;
      if (!(await need("ai.manage"))) return true;
      if (!v) return fail(404, "NOT_FOUND");
      if (v.status !== "draft") return fail(409, "VERSION_NOT_DRAFT");
      if (this.inCanary(m[1]!, v.version)) return fail(409, "VERSION_IN_CANARY");
      if (method === "DELETE") {
        vs!.splice(vs!.indexOf(v), 1);
        if (this.rollout[m[1]!]?.canary_version === v.version) Object.assign(this.rollout[m[1]!]!, { canary_version: null, canary_percent: 0 });
        audit("ai.version_deleted", `${m[1]}@${v.version}`);
        return done(204);
      }
      if (method === "PATCH") {
        if (!headers["if-match"]) return fail(428, "IF_MATCH_REQUIRED");
        if (headers["if-match"] !== v.updated_at) return fail(409, "VERSION_CONFLICT");
        const allowed = ["instructions", "rules", "output_schema", "schema_version", "model_id", "fallback_model_id", "temperature", "max_output_tokens", "timeout_ms", "max_cost_usd", "notes"];
        for (const k of Object.keys(body)) if (!allowed.includes(k)) return bad(k).then(() => true);
        if (typeof body.instructions === "string" && (body.instructions.length > 20_000 || !body.instructions.trim())) return bad("instructions").then(() => true);
        if (typeof body.rules === "string" && body.rules.length > 10_000) return bad("rules").then(() => true);
        if (body.output_schema !== undefined && (typeof body.output_schema !== "object" || body.output_schema === null || Array.isArray(body.output_schema))) return bad("output_schema").then(() => true);
        if (typeof body.temperature === "number" && (body.temperature < 0 || body.temperature > 1)) return bad("temperature").then(() => true);
        if (typeof body.model_id === "string" && !this.models.some((y) => y.model_id === body.model_id && y.active)) return bad("model_id").then(() => true);
        Object.assign(v, body, { updated_at: new Date(Date.now() + ++this.seq).toISOString(), last_test_run: null });
        audit("ai.version_updated", `${m[1]}@${v.version}`);
        return done(200, this.versionView(v));
      }
    }
    if ((m = path.match(/^\/ai\/agents\/([a-z_]+)\/versions\/(\d+)\/test-runs$/)) && method === "POST") {
      if (!(await need("ai.manage"))) return true;
      const v = this.vers[m[1]!]?.find((y) => y.version === Number(m![2]));
      if (!v) return fail(404, "NOT_FOUND");
      const r = this.makeRun(m[1]!, v.version, x.me.staff_id);
      v.last_test_run = summary(r);
      return done(202, summary(r));
    }
    if ((m = path.match(/^\/ai\/agents\/([a-z_]+)\/versions\/(\d+)\/test-runs\/([^/]+)$/)) && method === "GET") {
      if (!(await need("ai.read"))) return true;
      const r = this.runs.find((y) => y.run_id === m![3]);
      if (!r) return fail(404, "NOT_FOUND");
      const { polls: _p, ...out } = this.advance(r);
      void _p;
      const { all: _a, ...clean } = out as typeof out & { all?: unknown };
      void _a;
      return done(200, clean);
    }
    if ((m = path.match(/^\/ai\/agents\/([a-z_]+)\/versions\/(\d+)\/publish$/)) && method === "POST") {
      if (!(await need("ai.publish", true))) return true;
      const agent = m[1]!;
      const vs = this.vers[agent]!;
      const v = vs.find((y) => y.version === Number(m![2]));
      if (!v) return fail(404, "NOT_FOUND");
      const reason = reasonOf();
      if (!reason) return bad("reason").then(() => true);
      if (v.status !== "draft") return fail(409, "VERSION_NOT_DRAFT");
      const gate = this.gate(agent, v.version);
      if (gate) return fail(422, gate.code, gate.details);
      const ro = this.rollout[agent]!;
      const old = vs.find((y) => y.status === "published");
      if (old) old.status = "archived";
      Object.assign(v, { status: "published", published_at: iso(0), published_by: x.me.staff_id });
      Object.assign(ro, { previous_version: old?.version ?? null, published_version: v.version, canary_version: null, canary_percent: 0 });
      audit("ai.version_published", `${agent}@${v.version}`, reason);
      return done(200, this.row(this.agents.find((a) => a.agent_id === agent)!));
    }
    if ((m = path.match(/^\/ai\/agents\/([a-z_]+)\/canary$/)) && (method === "PUT" || method === "DELETE")) {
      if (!(await need("ai.publish", true))) return true;
      const agent = m[1]!;
      const ro = this.rollout[agent];
      if (!ro) return fail(404, "NOT_FOUND");
      const reason = reasonOf();
      if (!reason) return bad("reason").then(() => true);
      if (method === "DELETE") {
        Object.assign(ro, { canary_version: null, canary_percent: 0 });
        audit("ai.canary_cleared", agent, reason);
      } else {
        const pct = Number(body.percent);
        if (!Number.isInteger(pct) || pct < 1 || pct > 50) return bad("percent").then(() => true);
        const v = this.vers[agent]!.find((y) => y.version === Number(body.version));
        if (!v || v.status !== "draft") return fail(409, "VERSION_NOT_DRAFT");
        const gate = this.gate(agent, v.version);
        if (gate) return fail(422, gate.code, gate.details);
        Object.assign(ro, { canary_version: v.version, canary_percent: pct });
        audit("ai.canary_set", `${agent}@${v.version}`, reason);
      }
      return done(200, this.row(this.agents.find((a) => a.agent_id === agent)!));
    }
    if ((m = path.match(/^\/ai\/agents\/([a-z_]+)\/rollback$/)) && method === "POST") {
      if (!(await need("ai.publish", true))) return true;
      const agent = m[1]!;
      const ro = this.rollout[agent];
      if (!ro) return fail(404, "NOT_FOUND");
      const reason = reasonOf();
      if (!reason) return bad("reason").then(() => true);
      if (ro.previous_version == null) return fail(409, "NO_PREVIOUS_VERSION");
      const vs = this.vers[agent]!;
      const cur = vs.find((y) => y.status === "published");
      const prev = vs.find((y) => y.version === ro.previous_version)!;
      if (cur) cur.status = "archived";
      Object.assign(prev, { status: "published" });
      Object.assign(ro, { published_version: prev.version, previous_version: null, canary_version: null, canary_percent: 0 });
      audit("ai.rolled_back", `${agent}@${prev.version}`, reason);
      return done(200, this.row(this.agents.find((a) => a.agent_id === agent)!));
    }
    if ((m = path.match(/^\/ai\/agents\/([a-z_]+)\/golden-cases$/))) {
      if (method === "GET") return (await need("ai.read")) ? done(200, { items: this.cases.filter((c) => c.agent_id === m![1]).map(stripCase) }) : true;
      if (method === "POST") {
        if (!(await need("ai.manage"))) return true;
        const err = checkCase(body);
        if (err) return bad(err).then(() => true);
        const c: D.MockCase = { case_id: `gc000000-0000-4000-8000-9${String(++this.seq).padStart(11, "0")}`, agent_id: m[1] as AgentId, title: String(body.title), input: body.input as D.MockCase["input"], checks: body.checks as D.MockCase["checks"], mandatory: !!body.mandatory, created_by: x.me.staff_id, created_at: iso(0), archived_at: null };
        this.cases.push(c);
        audit("ai.golden_case_created", c.case_id);
        return done(201, stripCase(c));
      }
    }
    if ((m = path.match(/^\/ai\/golden-cases\/([^/]+)$/)) && (method === "PATCH" || method === "DELETE")) {
      if (!(await need("ai.manage"))) return true;
      const c = this.cases.find((y) => y.case_id === m![1]);
      if (!c) return fail(404, "NOT_FOUND");
      if (method === "DELETE") {
        c.archived_at = iso(0);
        audit("ai.golden_case_archived", c.case_id);
        return done(204);
      }
      const err = checkCase(body);
      if (err) return bad(err).then(() => true);
      Object.assign(c, { title: body.title, input: body.input, checks: body.checks, mandatory: !!body.mandatory });
      audit("ai.golden_case_updated", c.case_id);
      return done(200, stripCase(c));
    }

    /* ---------- models, provider, budget, usage ---------- */
    if (key === "GET /ai/models") return (await need("ai.read")) ? done(200, { items: this.models }) : true;
    if ((m = path.match(/^\/ai\/models\/([^/]+)$/)) && method === "PUT") {
      if (!(await need("ai.publish", true))) return true;
      const md = this.models.find((y) => y.model_id === m![1]);
      if (!md) return fail(404, "NOT_FOUND");
      const reason = reasonOf();
      if (!reason) return bad("reason").then(() => true);
      const pi = Number(body.input_usd_per_mtok);
      const po = Number(body.output_usd_per_mtok);
      if (!(pi >= 0 && pi <= 1000) || !(po >= 0 && po <= 1000) || typeof body.active !== "boolean") return bad("input_usd_per_mtok").then(() => true);
      // sprint 5: the audio hour price belongs to speech models only (ai-gateway 422 PRICE_NOT_APPLICABLE)
      const speech = md.provider === "azure_speech" || md.provider === "fake_speech";
      const pa = body.audio_usd_per_hour;
      // release 5.1: whisper (own server) has no price of an hour (always 0) — like an LLM, 422 for an audio price
      if (pa !== undefined && pa !== null && !speech) return fail(422, "PRICE_NOT_APPLICABLE", { field: "audio_usd_per_hour" });
      if (pa !== undefined && pa !== null && !(typeof pa === "number" && pa >= 0 && pa <= 1000)) return bad("audio_usd_per_hour").then(() => true);
      // lowering a price needs costs.manage as well (ai-gateway)
      if (speech && typeof pa === "number" && md.audio_usd_per_hour != null && pa < md.audio_usd_per_hour && !has("costs.manage")) return fail(403, "PERMISSION_DENIED", { permission: "costs.manage" });
      Object.assign(md, { input_usd_per_mtok: pi, output_usd_per_mtok: po, active: body.active, updated_at: iso(0), ...(speech && typeof pa === "number" ? { audio_usd_per_hour: pa } : {}) });
      audit("ai.model_updated", md.model_id, reason);
      return done(200, md);
    }
    if (key === "GET /ai/provider") return (await need("ai.read")) ? done(200, { ...this.provider, ai_enabled: this.budget.ai_enabled }) : true;
    if (key === "GET /ai/budget") return (await need("costs.read")) ? done(200, this.budget) : true;
    if (key === "PUT /ai/budget") {
      if (!(await need("costs.manage", true))) return true;
      const reason = reasonOf();
      if (!reason) return bad("reason").then(() => true);
      const n = (k: string) => (typeof body[k] === "number" ? (body[k] as number) : NaN);
      const [mo, dl, ls, al] = [n("monthly_cap_usd"), n("learner_daily_cap_usd"), n("lesson_cap_usd"), n("alert_percent")];
      // sprint 5: the sub-cap of pronunciation 0..monthly_cap_usd (absent — kept as it is)
      const sp = body.speech_monthly_cap_usd === undefined ? this.budget.speech_monthly_cap_usd : n("speech_monthly_cap_usd");
      if (!(mo > 0) || !(dl > 0 && dl <= mo) || !(ls > 0 && ls <= dl) || !(Number.isInteger(al) && al >= 1 && al <= 100)) return bad("monthly_cap_usd").then(() => true);
      if (!(sp >= 0 && sp <= mo)) return bad("speech_monthly_cap_usd").then(() => true);
      // sprint 7: the coach of one pair room 0..monthly_cap_usd (absent — kept as it is)
      const rc = body.room_cap_usd === undefined ? this.budget.room_cap_usd : n("room_cap_usd");
      if (!(rc >= 0 && rc <= mo)) return bad("room_cap_usd").then(() => true);
      // ai-gateway: the updated_at that was read — someone saved in between → 409 BUDGET_CONFLICT {updated_at}
      if (body.updated_at !== undefined && body.updated_at !== this.budget.updated_at) return fail(409, "BUDGET_CONFLICT", { updated_at: this.budget.updated_at });
      Object.assign(this.budget, { monthly_cap_usd: mo, learner_daily_cap_usd: dl, lesson_cap_usd: ls, speech_monthly_cap_usd: sp, room_cap_usd: rc, alert_percent: al, updated_at: iso(0) });
      audit("ai.budget_updated", "budget", reason);
      return done(200, this.budget);
    }
    if (key === "POST /ai/emergency-stop") {
      if (!(await need("costs.manage", true))) return true;
      const reason = reasonOf();
      if (!reason || typeof body.enabled !== "boolean") return bad("reason").then(() => true);
      // enabled — the emergency stop is engaged (AI off)
      Object.assign(this.budget, { ai_enabled: !body.enabled, updated_at: iso(0) });
      audit("ai.emergency_stop", body.enabled ? "on" : "off", reason);
      return done(200, this.budget);
    }
    if (key === "GET /ai/usage/summary") {
      if (!(await need("costs.read"))) return true;
      const p = q.get("period");
      return p === "day" || p === "week" || p === "month" ? done(200, this.summary(p)) : bad("period").then(() => true);
    }
    if (key === "GET /ai/usage") {
      const sid = q.get("session_id");
      if (!(await need(sid ? ["costs.read", "qa.read"] : ["costs.read"]))) return true;
      const items = sid ? (this.calls[sid] ?? []) : Object.values(this.calls).flat();
      return done(200, { items, next_cursor: null });
    }

    /* ---------- dialogue QA ---------- */
    if (key === "GET /qa/sessions") {
      if (!(await need("qa.read"))) return true;
      const from = q.get("from");
      const to = q.get("to");
      const f = (k: string) => q.get(k) || null;
      const items = this.sessions
        .map((s) => s.row)
        .filter(
          (r) =>
            (!f("kind") || r.kind === f("kind")) &&
            (!f("status") || r.status === f("status")) &&
            (!f("outcome") || r.outcome === f("outcome")) &&
            (!f("flag") || r.flags.includes(f("flag") as never)) &&
            (!f("lesson_id") || r.lesson_id === f("lesson_id")) &&
            (!f("level") || r.level === f("level")) &&
            (!from || (r.started_at ?? "") >= from) &&
            (!to || (r.started_at ?? "") <= to),
        )
        .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
      return done(200, { items, next_cursor: null });
    }
    if ((m = path.match(/^\/qa\/sessions\/([0-9a-f-]{36})$/)) && method === "GET") {
      if (!(await need("qa.read"))) return true;
      const c = this.card(m[1]!);
      return c ? done(200, c) : fail(404, "NOT_FOUND");
    }
    if ((m = path.match(/^\/qa\/sessions\/([0-9a-f-]{36})\/transcript$/)) && method === "POST") {
      if (!(await need("qa.transcripts"))) return true;
      const s = this.sessions.find((y) => y.row.session_id === m![1]);
      if (!s) return fail(404, "NOT_FOUND");
      const reason = reasonOf(10);
      if (!reason) return bad("reason").then(() => true);
      audit("qa.transcript_viewed", s.row.session_id, reason);
      return done(200, s.transcript);
    }
    if ((m = path.match(/^\/qa\/evaluations\/([0-9a-f-]{36})\/flag$/)) && method === "POST") {
      if (!(await need("qa.read"))) return true;
      const found = this.evalById(m[1]!);
      if (!found) return fail(404, "NOT_FOUND");
      const reason = reasonOf(5);
      if (!reason) return bad("reason").then(() => true);
      found.e.flags.push({ reason, by_name: x.me.display_name, at: iso(0) });
      const s = this.sessions.find((y) => y.row.session_id === found.sid);
      if (s && !s.row.flags.includes("flagged")) s.row.flags.push("flagged");
      audit("qa.flagged", found.e.evaluation_id, reason);
      return done(200, found.e);
    }
    if ((m = path.match(/^\/qa\/evaluations\/([0-9a-f-]{36})\/reevaluate$/)) && method === "POST") {
      if (!(await need("qa.review", true))) return true;
      const found = this.evalById(m[1]!);
      if (!found) return fail(404, "NOT_FOUND");
      if (found.chain[found.chain.length - 1] !== found.e) return fail(409, "EVALUATION_SUPERSEDED");
      const reason = reasonOf(10);
      if (!reason) return bad("reason").then(() => true);
      const scores = (body.scores ?? {}) as Record<string, number | null>;
      const errs = Array.isArray(body.confirmed_errors) ? (body.confirmed_errors as EvaluationCard["confirmed_errors"]) : [];
      if (errs.length > 5 || errs.some((e) => !e.evidence || e.evidence.length > 120 || !e.turn_id)) return bad("confirmed_errors").then(() => true);
      const ns = found.e.scores.map((s) => ({ code: s.code, score: (s.code in scores ? scores[s.code] : s.score) as 0 | 1 | 2 | 3 | null }));
      const scored = ns.filter((s) => s.score != null);
      const weighted = scored.length ? Math.round((scored.reduce((a, s) => a + (s.score ?? 0), 0) / scored.length) * 100) / 100 : null;
      const ev: EvaluationCard = {
        ...found.e,
        evaluation_id: `e7000000-0000-4000-8000-9${String(++this.seq).padStart(11, "0")}`,
        status: "ok",
        scores: ns,
        weighted,
        passed: weighted == null ? null : weighted >= 1.8,
        confirmed_errors: errs,
        skill_outcomes: Array.isArray(body.skill_outcomes) ? (body.skill_outcomes as EvaluationCard["skill_outcomes"]) : found.e.skill_outcomes,
        requires_human_review: false,
        supersedes: found.e.evaluation_id,
        created_by_name: x.me.display_name,
        reason,
        flags: [],
        evaluator: null,
        created_at: iso(0),
      };
      found.chain.push(ev);
      const s = this.sessions.find((y) => y.row.session_id === found.sid);
      if (s) {
        s.row.flags = s.row.flags.filter((f) => f !== "human_review");
        s.row.passed = ev.passed;
      }
      audit("qa.reevaluated", ev.evaluation_id, reason);
      return done(201, ev);
    }
    if (key === "GET /qa/appeals") {
      if (!(await need("qa.read"))) return true;
      const st = q.get("status");
      return done(200, { items: this.appeals.filter((a) => !st || a.status === st), next_cursor: null });
    }
    if ((m = path.match(/^\/qa\/appeals\/([0-9a-f-]{36})\/(take|decide)$/)) && method === "POST") {
      const decide = m[2] === "decide";
      if (!(await need("qa.review", decide))) return true;
      const a = this.appeals.find((y) => y.appeal_id === m![1]);
      if (!a) return fail(404, "NOT_FOUND");
      if (!decide) {
        if (a.status !== "new") return fail(409, "APPEAL_INVALID_TRANSITION");
        Object.assign(a, { status: "in_review", taken_by_name: x.me.display_name });
        audit("qa.appeal_taken", a.appeal_id);
        return done(200, a);
      }
      if (a.status !== "in_review") return fail(409, "APPEAL_INVALID_TRANSITION");
      const note = String(body.note ?? "").trim();
      if (note.length < 10 || note.length > 500) return bad("note").then(() => true);
      const dec = body.decision;
      if (dec !== "upheld" && dec !== "corrected") return bad("decision").then(() => true);
      if (dec === "corrected") {
        const chain = Object.values(this.evals).find((ch) => ch.some((e) => e.evaluation_id === a.evaluation_id)) ?? [];
        const idx = chain.findIndex((e) => e.evaluation_id === a.evaluation_id);
        if (!chain.slice(idx + 1).some((e) => e.evaluation_id === body.new_evaluation_id)) return bad("new_evaluation_id").then(() => true);
      }
      Object.assign(a, { status: dec, decision_note: note, decided_by_name: x.me.display_name, decided_at: iso(0), new_evaluation_id: dec === "corrected" ? body.new_evaluation_id : null });
      const s = this.sessions.find((y) => y.row.session_id === a.session_id);
      if (s) s.row.flags = s.row.flags.filter((f) => f !== "appealed");
      audit("qa.appeal_decided", a.appeal_id, note);
      return done(200, a);
    }
    void idem;
    return false;
  }

  /** the publication / canary gate of the ai-gateway: the last run of this version, finished, mandatory green, ≤ 14 days */
  private gate(agent: string, version: number): { code: string; details: Record<string, unknown> } | null {
    const r = [...this.runs].reverse().find((y) => y.agent_id === agent && y.version === version);
    if (!r || r.status !== "finished" || Date.now() - Date.parse(r.started_at) > 14 * DAY) return { code: "TESTS_REQUIRED", details: {} };
    if (!r.passed_mandatory) return { code: "TESTS_FAILED", details: { case_ids: r.results.filter((y) => !y.passed && y.mandatory).map((y) => y.case_id) } };
    if (this.sc.realProviderRequired && r.provider === "fake") return { code: "TESTS_REQUIRED", details: { reason: "real_provider_required" } };
    return null;
  }
}

function summary(r: Run) {
  const { results: _r, polls: _p, ...s } = r as Run & { all?: unknown };
  void _r;
  void _p;
  delete (s as { all?: unknown }).all;
  return s;
}

function stripCase(c: D.MockCase) {
  return { ...c };
}

function checkCase(b: P): string | null {
  if (typeof b.title !== "string" || !b.title.trim() || b.title.length > 120) return "title";
  const input = b.input as { audience?: string; context?: unknown } | undefined;
  if (!input || !["kids", "teens", "adults"].includes(String(input.audience)) || !input.context || typeof input.context !== "object") return "input";
  if (!Array.isArray(b.checks) || !b.checks.length) return "checks";
  return null;
}
