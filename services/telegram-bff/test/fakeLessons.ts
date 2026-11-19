/**
 * Подделка lessons и assessment (спринт 4) для тестов BFF: ученик — из claim `lrn` (sub — аккаунт), детский профиль —
 * `lrn ≠ sub` или детский `age_band`. Ответы — формы bff.ts + «секретные» поля домена (ключи заданий, служебные
 * заметки), которые BFF обязан отбросить. Сессии: незавершённая одна на ученика (409 SESSION_ACTIVE), чужая — 404,
 * шаги по порядку (409 STEP_NOT_CURRENT), повтор ответа на пройденный шаг — тот же результат.
 */
import { randomUUID } from "node:crypto";
import type { Appeal, EvaluationView, LessonCardDetail, LessonSession, LessonStep, LessonSummary, StepResult } from "@tilhero/contracts/bff";
import type { Req } from "./helpers.js";

const L = (ru: string) => ({ ru, uz: `${ru} (uz)` });
/** Метка ключа ответа домена: не должна встретиться ни в одном ответе BFF. */
export const SECRET = "SECRET-KEY-42";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, details: Record<string, unknown> = {}) =>
  json(status, { code, message: `domain says ${code}`, trace_id: "domain-trace", details });

const KID_BANDS = new Set(["6-9", "10-13"]);

type Step = LessonStep & Record<string, unknown>;

interface Sess {
  view: LessonSession;
  owner: string;
  steps: Step[];
  cursor: number;
  results: Map<string, { body: string; result: StepResult & Record<string, unknown> }>;
  retried: boolean;
  summary: (LessonSummary & Record<string, unknown>) | null;
}

export const STAGES5 = [
  { type: "retrieval" as const, minutes: 3 },
  { type: "explanation" as const, minutes: 4 },
  { type: "roleplay" as const, minutes: 8 },
  { type: "assessment" as const, minutes: 3 },
  { type: "summary" as const, minutes: 2 },
];

export class FakeLessons {
  readonly sessions = new Map<string, Sess>();
  readonly idem = new Map<string, string>();
  readonly evaluations = new Map<string, EvaluationView & { owner: string; internal_note: string }>();
  readonly appeals = new Map<string, Appeal & { owner: string }>();
  readonly appealIdem = new Map<string, string>();
  /** шаг проверки без подсказок с feedback (ошибка домена — BFF обязан его не отдавать) */
  leakFeedback = false;
  /** подмена ответа GET current (тест «не по контракту») */
  currentOverride: ((s: Sess) => unknown) | null = null;
  /** элементы истории не по контракту */
  badHistoryItem = false;

  private learner(r: Req): { lrn: string; kids: boolean } | Response {
    const lrn = typeof r.claims.lrn === "string" ? r.claims.lrn : null;
    if (!lrn) return err(401, "USER_CONTEXT_MISSING");
    const band = typeof r.claims.age_band === "string" ? r.claims.age_band : null;
    return { lrn, kids: lrn !== r.subject || (band !== null && KID_BANDS.has(band)) };
  }

  card(id: string, kids: boolean): LessonCardDetail & Record<string, unknown> {
    return {
      lesson_id: id,
      module_id: "m-a1-01",
      title: L("В кафе: заказ напитков"),
      goal: L("Заказать напиток и попросить счёт"),
      level: "A1",
      kind: "core",
      duration_min: 20,
      primary_skill_id: "en.func.order",
      scenario_id: "sc-cafe-order",
      stages: STAGES5,
      version: 3,
      primary_skill: { skill_id: "en.func.order", title: L("Вежливая просьба") },
      stages_detail: STAGES5.map((s) => ({ ...s, instructions: L(`Этап ${s.type}`) })),
      key_words_count: 6,
      // домен ошибочно предлагает ребёнку свободный текст — BFF исправит
      roleplay_mode: "full",
      available: true,
      unavailable_reason: null,
      active_session_id: this.activeOf(kids ? "kid" : "x")?.view.session_id ?? null,
      control_items: [{ item_id: "c1", answer: SECRET }],
      reward_xp: 40,
    };
  }

  private activeOf(lrn: string): Sess | undefined {
    return [...this.sessions.values()].find((s) => s.owner === lrn && ["ready", "in_progress", "paused"].includes(s.view.status));
  }

  private steps(kind: LessonSession["kind"], kids: boolean): Step[] {
    const base = (n: number, stage: LessonStep["stage"], position = 1, total = 1) => ({ step_id: `s${n}`, stage, position, stage_total: total });
    if (kind === "media") {
      return [
        { ...base(1, "listen"), type: "listen", asset_id: "m-own-coffee", title: L("Кофе с собой"), has_audio: true, transcript: [{ speaker: "Barista", text_en: "Hi!", gloss: L("Привет!") }], voices: { Barista: "en-GB" }, can_listen: true, license: "secret" },
        { ...base(2, "exercises"), type: "item", item: { item_id: "mx1", item_type: "comprehension", instruction: L("Что заказал Азиз?"), prompt_en: "What did Aziz order?", options: ["tea", "latte"], answer: SECRET }, hint_available: false, hints_used: 0, graded_later: true },
        { ...base(3, "summary"), type: "done" },
      ] as Step[];
    }
    const roleplay: Step = {
      ...base(3, "roleplay"),
      type: "roleplay",
      node_id: "n1",
      character: { id: "tom", name: "Tom", role: L("Официант"), voice: "en-GB" },
      line_en: "Hi! What can I get you?",
      gloss: L("Привет! Что вам принести?"),
      choices: [
        { choice_id: "c-order", text_en: "A latte, please." },
        { choice_id: "c-bill", text_en: "Could I have the bill?" },
      ],
      free_text_allowed: true, // ошибка домена для детей — BFF обязан выключить
      hint_available: true,
      hints_used: 0,
      history: [],
      unclear_attempts: 0,
      graph: { secret: SECRET },
    } as Step;
    if (kind === "scenario") {
      return [roleplay, { ...base(4, "roleplay"), type: "roleplay_end", outcome: "success", summary: L("Заказ сделан"), can_retry: false }, { ...base(5, "summary"), type: "done" }] as Step[];
    }
    const steps: Step[] = [
      { ...base(1, "retrieval", 1, 2), type: "item", item: { item_id: "r1", item_type: "single_choice", instruction: L("Выберите перевод"), prompt_en: "the bill", options: ["счёт", "чек"], answer: 0, correct_index: SECRET }, hint_available: true, hints_used: 0, graded_later: false },
      {
        ...base(2, "explanation"),
        type: "explanation",
        instructions: L("Вежливо — I'd like"),
        examples: [{ en: "I'd like a tea.", gloss: L("Мне чай.") }],
        key_words: [{ en: "the bill", gloss: L("счёт"), example_en: "Could I have the bill?" }],
        can_simplify: true,
      },
      roleplay,
      { ...base(4, "roleplay"), type: "roleplay_end", outcome: "fail", summary: L("Не вышло"), can_retry: true },
      { ...base(5, "assessment", 1, 2), type: "item", item: { item_id: "a1", item_type: "order_words", instruction: L("Соберите фразу"), prompt_en: "Put in order", options: ["like", "I'd", "tea"], answer: ["I'd", "like", "tea"], key: SECRET }, hint_available: true, hints_used: 0, graded_later: true },
    ] as Step[];
    if (!kids) steps.push({ ...base(6, "assessment", 2, 2), type: "open_answer", prompt: L("Напишите, как вы закажете кофе"), max_length: 300 } as Step);
    steps.push({ ...base(steps.length + 1, "summary"), type: "done" } as Step);
    return steps;
  }

  private newSession(owner: string, kind: LessonSession["kind"], kids: boolean, ref: { lesson_id?: string; scenario_id?: string; asset_id?: string }): Sess {
    const id = randomUUID();
    const view: LessonSession & Record<string, unknown> = {
      session_id: id,
      kind,
      title: L(kind === "lesson" ? "В кафе: заказ напитков" : kind === "scenario" ? "Заказ в кафе" : kind === "media" ? "Кофе с собой" : "Повторение"),
      lesson_id: ref.lesson_id ?? null,
      scenario_id: ref.scenario_id ?? null,
      asset_id: ref.asset_id ?? null,
      status: "ready",
      stage: null,
      stages: STAGES5.map((s) => ({ type: s.type, status: "pending" as const })),
      ai_mode: kids ? "full" : "full", // домен «ошибся» для ребёнка — BFF исправит на choices
      ai_degraded: false,
      started_at: null,
      paused_at: null,
      finished_at: null,
      expires_at: null,
      minutes: 0,
      account_id: "leak-account",
      content_versions: { lesson: 3 },
    };
    const s: Sess = { view, owner, steps: this.steps(kind, kids), cursor: 0, results: new Map(), retried: false, summary: null };
    this.sessions.set(id, s);
    return s;
  }

  private summaryOf(s: Sess): LessonSummary & Record<string, unknown> {
    const evaluationId = randomUUID();
    const ev: EvaluationView & { owner: string; internal_note: string } = {
      evaluation_id: evaluationId,
      status: "ok",
      passed: false,
      task_completed: false,
      scores: [
        { code: "task", title: L("Задача"), score: 1 },
        { code: "grammar", title: L("Грамматика"), score: null },
      ],
      key_errors: [
        { turn_id: "T1", evidence: "low one", correction: "x", error_code: "vocabulary", severity: "low" },
        { turn_id: "T2", evidence: "I want tea", correction: "I'd like tea", error_code: "politeness", severity: "high" },
        { turn_id: "T3", evidence: "medium one", correction: "y", error_code: "article", severity: "medium" },
        { turn_id: "a1", evidence: "like I'd tea", correction: "I'd like tea", error_code: "word_order", severity: "high" },
        { turn_id: "T4", evidence: "another low", correction: "z", error_code: "vocabulary", severity: "low" },
      ],
      items: [
        // верный: домен прислал ключ — BFF обязан убрать
        { item_id: "r1", prompt_en: "the bill", your_answer: "счёт", correct: true, hinted: false, correct_answer: SECRET },
        { item_id: "a1", prompt_en: "Put in order", your_answer: "like I'd tea", correct: false, hinted: false, correct_answer: "I'd like tea" },
      ],
      practice_only: false,
      rubric_version: "r-a1@2",
      evaluator: { model_id: "fake", prompt_version: "independent_evaluator@1" },
      superseded_by: null,
      appeal: null,
      created_at: "2026-11-19T10:00:00Z",
      owner: s.owner,
      internal_note: "методист: проверить",
    };
    this.evaluations.set(evaluationId, ev);
    const { owner: _o, internal_note: _n, ...evaluation } = ev;
    return {
      session_id: s.view.session_id,
      kind: s.view.kind,
      title: s.view.title,
      status: "completed",
      outcome: "fail",
      minutes: 18,
      evaluation,
      skills: [{ skill_id: "en.func.order", title: L("Вежливая просьба"), from: "not_started", to: "learning" }],
      key_words: [{ en: "the bill", gloss: L("счёт") }],
      next_lesson: { lesson_id: "l-a1-02", module_id: "m-a1-01", title: L("Урок 2"), goal: L("Цель"), level: "A1", kind: "core", duration_min: 20, primary_skill_id: "en.func.greet", scenario_id: null, stages: STAGES5 },
      can_review: true,
      rubric_internal: { secret: SECRET },
    };
  }

  // ---------------------------------------------------------------- lessons

  lessons(r: Req): Response {
    const who = this.learner(r);
    if (who instanceof Response) return who;
    const { lrn, kids } = who;
    let m = /^\/internal\/v1\/lessons\/([^/]+)\/card$/.exec(r.path);
    if (m && r.method === "GET") {
      if (m[1] === "l-hidden") return err(404, "LESSON_NOT_AVAILABLE");
      const c = this.card(m[1]!, kids);
      return json(200, { ...c, active_session_id: this.activeOf(lrn)?.view.session_id ?? null });
    }
    m = /^\/internal\/v1\/(lessons|scenarios|media)\/([^/]+)\/sessions$/.exec(r.path);
    if (m && r.method === "POST") {
      const key = r.headers["idempotency-key"];
      if (!key) return err(422, "IDEMPOTENCY_KEY_REQUIRED");
      const prev = this.idem.get(`${lrn}:${key}`);
      if (prev) return json(200, this.sessions.get(prev)!.view);
      if (m[1] === "lessons" && m[2] === "l-hidden") return err(404, "LESSON_NOT_AVAILABLE");
      if (m[1] === "media" && m[2] === "m-no-ex") return err(404, "NO_EXERCISES");
      const active = this.activeOf(lrn);
      if (active) return err(409, "SESSION_ACTIVE", { session_id: active.view.session_id, kind: active.view.kind, title: active.view.title });
      const kind = m[1] === "lessons" ? "lesson" : m[1] === "scenarios" ? "scenario" : "media";
      const s = this.newSession(lrn, kind, kids, m[1] === "lessons" ? { lesson_id: m[2]! } : m[1] === "scenarios" ? { scenario_id: m[2]! } : { asset_id: m[2]! });
      this.idem.set(`${lrn}:${key}`, s.view.session_id);
      return json(201, s.view);
    }
    if (r.path === "/internal/v1/sessions/active" && r.method === "GET") {
      const a = this.activeOf(lrn);
      return json(200, { session: a ? a.view : null });
    }
    if (r.path === "/internal/v1/sessions" && r.method === "GET") {
      const items: unknown[] = [...this.sessions.values()]
        .filter((s) => s.owner === lrn && (!r.query.kind || s.view.kind === r.query.kind))
        .map((s) => ({
          session_id: s.view.session_id,
          kind: s.view.kind,
          title: s.view.title,
          status: s.view.status,
          outcome: s.summary?.outcome ?? null,
          passed: s.summary?.evaluation?.passed ?? null,
          minutes: s.view.minutes,
          evaluation_id: s.summary?.evaluation?.evaluation_id ?? null,
          finished_at: s.view.finished_at,
          started_at: s.view.started_at,
          user_id: lrn,
        }));
      if (this.badHistoryItem) items.push({ session_id: "nope", kind: "lesson" });
      return json(200, { items, next_cursor: null });
    }
    m = /^\/internal\/v1\/sessions\/([0-9a-f-]{36})(?:\/(.+))?$/.exec(r.path);
    if (!m) return err(404, "NOT_FOUND");
    const s = this.sessions.get(m[1]!);
    if (!s || s.owner !== lrn) return err(404, "SESSION_NOT_FOUND");
    const action = m[2] ?? "";
    const st = s.view.status;
    const open = ["ready", "in_progress", "paused"].includes(st);
    const current = () => s.steps[Math.min(s.cursor, s.steps.length - 1)]!;
    const touch = () => {
      if (s.view.status === "ready" || s.view.status === "paused") {
        s.view.status = "in_progress";
        s.view.paused_at = null;
        s.view.started_at ??= "2026-11-19T09:00:00Z";
      }
    };
    if (action === "" && r.method === "GET") return json(200, s.view);
    if (action === "current" && r.method === "GET") {
      if (!open) return err(409, "SESSION_STATE", { status: st });
      touch();
      return json(200, this.currentOverride ? this.currentOverride(s) : current());
    }
    if (action === "pause" && r.method === "POST") {
      if (st !== "in_progress") return err(409, "SESSION_STATE", { status: st });
      s.view.status = "paused";
      s.view.paused_at = "2026-11-19T09:05:00Z";
      s.view.expires_at = "2026-11-22T09:05:00Z";
      return json(200, s.view);
    }
    if (action === "resume" && r.method === "POST") {
      if (st !== "paused") return err(409, "SESSION_STATE", { status: st });
      touch();
      return json(200, s.view);
    }
    if (action === "cancel" && r.method === "POST") {
      if (!open) return err(409, "SESSION_STATE", { status: st });
      s.view.status = "cancelled";
      return json(200, s.view);
    }
    m = /^steps\/(s\d+)(\/hint)?$/.exec(action);
    if (m && r.method === "POST") {
      const stepId = m[1]!;
      if (m[2]) {
        const step = current();
        if (step.step_id !== stepId) return err(409, "STEP_NOT_CURRENT", { current_step_id: step.step_id });
        if (step.type === "item" && step.graded_later) return err(409, "HINTS_NOT_ALLOWED");
        return json(200, { hint: L("Начните с I'd like"), answer_key: SECRET });
      }
      const body = JSON.stringify(r.body ?? {});
      const done = s.results.get(stepId);
      if (done) return json(200, done.result);
      if (!open) return err(409, "SESSION_STATE", { status: st });
      const step = current();
      if (step.step_id !== stepId) return err(409, "STEP_NOT_CURRENT", { current_step_id: step.step_id });
      touch();
      const b = (r.body ?? {}) as { answer?: unknown; choice_id?: string; text?: string };
      let feedback: StepResult["feedback"] = null;
      let reply: StepResult["reply"] = null;
      if (step.type === "item") {
        if (!step.graded_later) feedback = { correct: b.answer === 0, correct_answer: b.answer === 0 ? null : "счёт" };
        else if (this.leakFeedback) feedback = { correct: false, correct_answer: SECRET };
      }
      if (step.type === "roleplay") reply = { character_id: "tom", text_en: b.text ? "Sure! Anything else?" : "Here you are.", gloss: L("Пожалуйста"), clarification: false };
      s.cursor += 1;
      const result = { accepted: true, feedback, reply, next: current(), session_internal: SECRET };
      s.results.set(stepId, { body, result });
      return json(200, result);
    }
    if (action === "simpler" && r.method === "POST") {
      return json(200, { explanation: L("Проще: I'd like = мне, пожалуйста"), example_en: "I'd like a coffee.", example_gloss: L("Мне кофе."), source: "ai", agent_version: 3 });
    }
    if (action === "roleplay/retry" && r.method === "POST") {
      const step = current();
      if (step.type !== "roleplay_end" || !step.can_retry || s.retried) return err(409, "RETRY_NOT_AVAILABLE");
      s.retried = true;
      s.cursor = s.steps.findIndex((x) => x.type === "roleplay");
      return json(200, current());
    }
    if (action === "finish" && r.method === "POST") {
      if (s.summary) return json(200, s.summary);
      if (!open) return err(409, "SESSION_STATE", { status: st });
      if (current().type !== "done") return err(409, "STEP_NOT_CURRENT", { current_step_id: current().step_id });
      s.view.status = "completed";
      s.view.finished_at = "2026-11-19T09:20:00Z";
      s.view.minutes = 18;
      s.summary = this.summaryOf(s);
      return json(200, s.summary);
    }
    if (action === "summary" && r.method === "GET") {
      if (!s.summary) return err(409, "SESSION_STATE", { status: st });
      return json(200, s.summary);
    }
    if (action === "review" && r.method === "POST") {
      const key = r.headers["idempotency-key"];
      if (!key) return err(422, "IDEMPOTENCY_KEY_REQUIRED");
      const prev = this.idem.get(`${lrn}:${key}`);
      if (prev) return json(200, this.sessions.get(prev)!.view);
      if (!s.summary?.can_review) return err(409, "NOTHING_TO_REVIEW");
      const rv = this.newSession(lrn, "review", kids, { lesson_id: s.view.lesson_id ?? undefined });
      this.idem.set(`${lrn}:${key}`, rv.view.session_id);
      return json(201, rv.view);
    }
    return err(404, "NOT_FOUND");
  }

  // ---------------------------------------------------------------- assessment

  assessment(r: Req): Response {
    // assessment: ученик — sub токена (README assessment); claim lrn, если есть, обязан совпадать
    const lrn = r.subject;
    if (!lrn) return err(401, "USER_CONTEXT_MISSING");
    if (typeof r.claims.lrn === "string" && r.claims.lrn !== lrn) return err(403, "USER_CONTEXT_MISMATCH");
    if (r.path === "/internal/v1/appeals" && r.method === "GET") {
      const items: unknown[] = [...this.appeals.values()].filter((a) => a.owner === lrn).map(({ owner: _o, ...a }) => ({ ...a, staff_id: "s-1" }));
      return json(200, { items: [...items, { appeal_id: "broken" }] });
    }
    const m = /^\/internal\/v1\/evaluations\/([0-9a-f-]{36})(\/appeal)?$/.exec(r.path);
    if (!m) return err(404, "NOT_FOUND");
    const ev = this.evaluations.get(m[1]!);
    if (!ev || ev.owner !== lrn) return err(404, "EVALUATION_NOT_FOUND");
    if (!m[2] && r.method === "GET") {
      const { owner: _o, ...view } = ev;
      return json(200, view);
    }
    if (m[2] && r.method === "POST") {
      const key = r.headers["idempotency-key"];
      if (!key) return err(422, "IDEMPOTENCY_KEY_REQUIRED");
      const prev = this.appealIdem.get(`${lrn}:${key}`);
      if (prev) {
        const { owner: _o, ...a } = this.appeals.get(prev)!;
        return json(200, a);
      }
      if ([...this.appeals.values()].some((a) => a.evaluation_id === ev.evaluation_id)) return err(409, "APPEAL_EXISTS");
      const a: Appeal & { owner: string } = {
        appeal_id: randomUUID(),
        evaluation_id: ev.evaluation_id,
        status: "new",
        reason: String((r.body as { reason: string }).reason),
        decision_note: null,
        new_evaluation_id: null,
        created_at: "2026-11-19T10:05:00Z",
        decided_at: null,
        owner: lrn,
      };
      this.appeals.set(a.appeal_id, a);
      this.appealIdem.set(`${lrn}:${key}`, a.appeal_id);
      ev.appeal = { ...a };
      const { owner: _o, ...out } = a;
      return json(201, { ...out, decided_by: null });
    }
    return err(404, "NOT_FOUND");
  }
}
