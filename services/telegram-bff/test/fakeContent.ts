/**
 * Подделки доменов спринта 3 для тестов BFF: catalog (пары, снимок курса по ETag, сценарии, медиа, аудио, заявки),
 * diagnostics (сессия, задания, ответы, результат, уточнение, карта навыков) и траектория learning-plan.
 * Субъект — только из sub внутреннего JWT (как настоящие домены). В ответы намеренно подмешаны служебные поля
 * (ключи ответов, полный граф сценария, user_id) — BFF не должен их пропустить.
 */
import { randomUUID } from "node:crypto";
import type {
  CourseSnapshot,
  DiagnosticItem,
  DiagnosticResult,
  DiagnosticSession,
  MediaDetail,
  MediaRequest,
  ScenarioDetail,
  Trajectory,
} from "@tilhero/contracts/bff";
import type { AudienceSegment, LanguagePair } from "@tilhero/contracts/content";

interface Req {
  method: string;
  path: string;
  query: Record<string, string>;
  subject: string | undefined;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string>;
  claims: Record<string, unknown>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const err = (status: number, code: string, details: Record<string, unknown> = {}) =>
  json(status, { code, message: `domain says ${code}`, trace_id: "domain-trace", details });

const L = (ru: string, uz = `${ru} (uz)`) => ({ ru, uz });

// ------------------------------------------------------------------ diagnostics

export const ITEMS: Array<DiagnosticItem & { answer: number | string[] }> = [
  { item_id: "v-a1-01", area: "vocabulary", type: "single_choice", instruction: L("Выберите перевод"), prompt_en: "apple", passage_en: null, audio_text_en: null, options: ["яблоко", "груша"], position: 1, answer: 0 },
  { item_id: "g-a1-01", area: "grammar", type: "gap_choice", instruction: L("Вставьте слово"), prompt_en: "She ___ a teacher.", passage_en: null, audio_text_en: null, options: ["is", "are"], position: 2, answer: 0 },
  { item_id: "g-a1-02", area: "grammar", type: "order_words", instruction: L("Соберите фразу"), prompt_en: "Put the words in order", passage_en: null, audio_text_en: null, options: ["student", "I", "a", "am"], position: 3, answer: ["I", "am", "a", "student"] },
  { item_id: "r-a1-01", area: "reading", type: "read_choice", instruction: L("Прочитайте и ответьте"), prompt_en: "Where is Tom?", passage_en: "Tom is at home.", audio_text_en: null, options: ["at home", "at school"], position: 4, answer: 0 },
  { item_id: "l-a1-01", area: "listening", type: "listen_choice", instruction: L("Послушайте и выберите"), prompt_en: "What does she want?", passage_en: null, audio_text_en: "I would like a cup of tea.", options: ["tea", "coffee"], position: 5, answer: 0 },
];

interface FakeSession {
  s: DiagnosticSession;
  user: string;
  answers: Array<{ item_id: string; answer: unknown; dont_know: boolean }>;
  listening: boolean;
  resultId?: string;
}

export class FakeContent {
  // ---- diagnostics state
  readonly sessions = new Map<string, FakeSession>();
  readonly sessionIdem = new Map<string, string>();
  readonly results = new Map<string, DiagnosticResult & { user: string; user_id: string }>();
  /** user → next_allowed_at (повтор раньше — 409 DIAGNOSTIC_TOO_SOON) */
  readonly tooSoon = new Map<string, string>();
  /** карта навыков: метаданные от diagnostics пустые (null) — BFF берёт из снимка */
  skillsMetaFromDomain = false;

  // ---- catalog state
  snapshotEtag = '"snap-v1"';
  snapshotCalls = { ok: 0, notModified: 0 };
  snapshotDown = false;
  snapshot: CourseSnapshot = {
    course_id: "en-core",
    pair_id: "ru-en",
    snapshot_version: "snap-v1",
    title: L("Английский"),
    level_start: "A0",
    level_end: "A2",
    modules: [],
    skills: [
      { skill_id: "en.func.greet", area: "function", title: L("Приветствие"), level: "A0", prerequisites: [], diagnostic_tags: ["greet"] },
      { skill_id: "en.gram.to-be", area: "grammar", title: L("Глагол to be"), level: "A1", prerequisites: ["en.func.greet"], diagnostic_tags: ["to-be"] },
      { skill_id: "en.vocab.food", area: "vocabulary", title: L("Еда"), level: "A1", prerequisites: [], diagnostic_tags: ["food"] },
    ],
    lessons: [],
  };
  pairs: Array<LanguagePair & Record<string, unknown>> = [
    { pair_id: "en-kk", source: "en", target: "kk", explanation_locales: ["en"], ui_locales: ["ru", "uz"], title: L("Казахский (объяснения на английском)"), status: "planned", release_at: null, course_id: null },
    { pair_id: "ru-en", source: "ru", target: "en", explanation_locales: ["ru"], ui_locales: ["ru", "uz"], title: L("Английский (объяснения на русском)"), status: "published", release_at: null, course_id: "en-core", internal: "x" },
    { pair_id: "ru-uz", source: "ru", target: "uz", explanation_locales: ["ru"], ui_locales: ["ru", "uz"], title: L("Узбекский"), status: "development", release_at: "2027-03-01", course_id: null },
    { pair_id: "ru-xx", source: "ru", target: "xx", explanation_locales: ["ru"], ui_locales: ["ru"], title: L("Архив"), status: "archived", release_at: null, course_id: null },
  ];
  pairsCalls = 0;
  readonly scenarios: Array<ScenarioDetail & { audience: AudienceSegment[]; nodes: unknown }> = [
    scenario("sc-travel-hotel", ["adults", "teens"], "A1", ["travel"], ["travel"]),
    scenario("sc-work-meeting", ["adults"], "A2", ["work", "career"], ["work"]),
    scenario("sc-kids-zoo", ["kids"], "A0", ["daily"], ["hobbies"]),
  ];
  readonly media: Array<MediaDetail & { audience: AudienceSegment[]; rights_internal: string }> = [
    mediaItem("m-own-coffee", ["adults", "teens"], "A1", "own_scene", true, ["listen", "show_transcript", "dictionary", "translation"]),
    mediaItem("m-kids-song", ["kids"], "A0", "song", false, ["listen", "show_transcript", "translation"]),
    mediaItem("m-own-lecture", ["adults"], "A2", "interview", false, ["listen"]),
  ];
  audioBytes = Buffer.alloc(2048, 7);
  audioType = "audio/mpeg";
  audioEtag = '"sha-audio-1"';
  audioCalls = { ok: 0, notModified: 0 };
  /** catalog «снял» материал (права истекли) */
  readonly suspended = new Set<string>();
  readonly requests: Array<MediaRequest & { user: string; ui_locale: string }> = [];
  readonly requestIdem = new Map<string, string>();

  // ---- learning-plan
  trajectoryOverride: ((r: Req) => Response) | null = null;
  trajectoryRevision = 1;

  // =============================================================== diagnostics

  diagnostics(r: Req): Response {
    if (!r.subject) return err(401, "SUBJECT_REQUIRED");
    const user = r.subject;
    const key = `${r.method} ${r.path}`;
    if (key === "GET /internal/v1/diagnostics/state") {
      if (r.query.pair_id !== "ru-en") return err(409, "PAIR_NOT_AVAILABLE", { pair_id: r.query.pair_id });
      const open = [...this.sessions.values()].find((x) => x.user === user && x.s.status === "in_progress");
      const last = [...this.results.values()].filter((x) => x.user === user).pop() ?? null;
      return json(200, {
        pair_id: "ru-en",
        status: open ? "in_progress" : last ? "completed" : "none",
        session: open ? open.s : null,
        last_result: last,
        next_allowed_at: this.tooSoon.get(user) ?? null,
        audience: r.query.audience === "kids" ? "kids" : "adults",
        user_id: user,
      });
    }
    if (key === "POST /internal/v1/diagnostics/sessions") {
      const idem = r.headers["idempotency-key"];
      if (!idem) return err(400, "IDEMPOTENCY_KEY_REQUIRED");
      const prev = this.sessionIdem.get(`${user}:${idem}`);
      if (prev) return json(200, this.sessions.get(prev)!.s);
      if (this.tooSoon.has(user)) return err(409, "DIAGNOSTIC_TOO_SOON", { next_allowed_at: this.tooSoon.get(user) });
      if ((r.body?.pair_id ?? "ru-en") !== "ru-en") return err(409, "PAIR_NOT_AVAILABLE", { pair_id: r.body?.pair_id });
      for (const x of this.sessions.values()) if (x.user === user && x.s.status === "in_progress") x.s.status = "abandoned";
      const id = randomUUID();
      const s: DiagnosticSession = {
        session_id: id,
        pair_id: "ru-en",
        test_version: r.query.audience === "kids" ? "dx-en-kids@1" : "dx-en-adult@1",
        status: "in_progress",
        answered: 0,
        total_estimate: ITEMS.length,
        started_at: "2026-11-19T08:00:00Z",
        expires_at: "2026-11-20T08:00:00Z",
        followup_area: null,
      };
      this.sessions.set(id, { s, user, answers: [], listening: true });
      this.sessionIdem.set(`${user}:${idem}`, id);
      return json(201, { ...s, seed: "secret-seed", user_id: user });
    }
    const sm = /^\/internal\/v1\/diagnostics\/sessions\/([^/]+)\/(next|answers|listening-unavailable|finish)$/.exec(r.path);
    if (sm) {
      const fs = this.sessions.get(sm[1]!);
      if (!fs || fs.user !== user) return err(404, "DIAGNOSTIC_SESSION_NOT_FOUND");
      if (fs.s.status !== "in_progress") return err(409, "DIAGNOSTIC_SESSION_CLOSED", { status: fs.s.status });
      const current = this.currentItem(fs);
      switch (`${r.method} ${sm[2]}`) {
        case "GET next":
          return json(200, current ?? { done: true });
        case "POST answers": {
          const b = r.body as { item_id: string; answer: unknown; dont_know: boolean };
          if (fs.answers.some((a) => a.item_id === b.item_id)) return json(200, { accepted: true, next: current, done: !current });
          if (!current || current.item_id !== b.item_id) return err(409, "ITEM_NOT_CURRENT");
          fs.answers.push({ item_id: b.item_id, answer: b.answer, dont_know: b.dont_know });
          fs.s.answered = fs.answers.length;
          const next = this.currentItem(fs);
          return json(200, { accepted: true, next, done: !next, correct: true });
        }
        case "POST listening-unavailable":
          fs.listening = false;
          return new Response(null, { status: 204 });
        case "POST finish": {
          if (!fs.answers.length) return err(422, "DIAGNOSTIC_EMPTY");
          fs.s.status = "finished";
          const res = this.result(user, fs);
          return json(200, res);
        }
      }
    }
    const fm = /^\/internal\/v1\/diagnostics\/results\/([^/]+)\/followup$/.exec(r.path);
    if (fm && r.method === "POST") {
      const res = this.results.get(fm[1]!);
      if (!res || res.user !== user) return err(404, "DIAGNOSTIC_RESULT_NOT_FOUND");
      const area = (r.body as { area: string }).area;
      const ar = res.areas.find((a) => a.area === area);
      if (!ar?.needs_followup) return err(409, "FOLLOWUP_NOT_AVAILABLE", { area, reason: "not_needed" });
      const id = randomUUID();
      const s: DiagnosticSession = { ...this.sessions.values().next().value!.s, session_id: id, status: "in_progress", answered: 0, total_estimate: 3, followup_area: area as DiagnosticSession["followup_area"] };
      this.sessions.set(id, { s, user, answers: [], listening: true, resultId: res.result_id });
      return json(201, s);
    }
    if (key === "GET /internal/v1/diagnostics/results") {
      return json(200, { items: [...this.results.values()].filter((x) => x.user === user).reverse() });
    }
    if (key === "GET /internal/v1/skills/map") {
      if (r.query.pair_id !== "ru-en") return err(409, "PAIR_NOT_AVAILABLE", { pair_id: r.query.pair_id });
      const meta = (id: string) => {
        const m = this.snapshot.skills.find((x) => x.skill_id === id);
        return this.skillsMetaFromDomain && m ? { area: m.area, title: m.title, level: m.level } : { area: null, title: null, level: null };
      };
      return json(200, {
        pair_id: "ru-en",
        course_id: "en-core",
        counts: { not_started: 2, learning: 1, demonstrated: 1, retained: 0 },
        skills: [
          { skill_id: "en.func.greet", ...meta("en.func.greet"), state: "demonstrated", confidence: 0.8, prerequisites: [], updated_at: "2026-11-19T08:10:00Z", history: [{ source: "diagnostic", outcome: "positive", at: "2026-11-19T08:10:00Z", ref_id: "secret" }] },
          { skill_id: "en.gram.to-be", ...meta("en.gram.to-be"), state: "learning", confidence: 0.4, prerequisites: [], updated_at: "2026-11-19T08:10:00Z", history: [{ source: "diagnostic", outcome: "negative", at: "2026-11-19T08:10:00Z" }] },
          { skill_id: "en.vocab.food", ...meta("en.vocab.food"), state: "not_started", confidence: null, prerequisites: [], updated_at: null, history: [] },
          // навык с состоянием вне опубликованного курса (архив) — метаданных нет нигде
          { skill_id: "en.old.archived", area: null, title: null, level: null, state: "not_started", confidence: null, prerequisites: [], updated_at: null, history: [] },
        ],
        user_id: user,
      });
    }
    return err(404, "NOT_FOUND");
  }

  private currentItem(fs: FakeSession) {
    const pending = ITEMS.filter((i) => !fs.answers.some((a) => a.item_id === i.item_id) && (fs.listening || i.area !== "listening"));
    const it = pending[0];
    return it ? { ...it, position: fs.answers.length + 1 } : null; // `answer` (ключ) остаётся — BFF обязан его убрать
  }

  private result(user: string, fs: FakeSession): DiagnosticResult {
    const prev = fs.resultId ? this.results.get(fs.resultId) : undefined;
    const res: DiagnosticResult & { user: string; user_id: string } = {
      result_id: prev?.result_id ?? randomUUID(),
      revision: (prev?.revision ?? 0) + 1,
      pair_id: "ru-en",
      test_version: fs.s.test_version,
      provisional_level: "A1",
      areas: [
        { area: "vocabulary", status: "assessed", band: "A1", confidence: 0.7, reason: null, evidence: [{ band: "A1", answered: 1, correct: 1 }], needs_followup: false },
        { area: "grammar", status: "assessed", band: "A1", confidence: 0.45, reason: null, evidence: [{ band: "A1", answered: 2, correct: 1 }], needs_followup: !prev },
        // домен ошибочно прислал основания у неоценённой области — BFF их не отдаёт
        { area: "reading", status: "not_assessed", band: null, confidence: null, reason: "too_few_items", evidence: [{ band: "A1", answered: 1, correct: 0 }], needs_followup: false },
        { area: "listening", status: "not_assessed", band: null, confidence: null, reason: fs.listening ? "too_few_items" : "no_speech_voice", evidence: [], needs_followup: false },
        { area: "speaking", status: "not_assessed", band: null, confidence: null, reason: "not_in_test_yet", evidence: [], needs_followup: false },
        { area: "writing", status: "not_assessed", band: null, confidence: null, reason: "not_in_test_yet", evidence: [], needs_followup: false },
      ],
      weak_areas: ["reading", "listening"],
      recommended_start: { lesson_id: "l-a1-01-greetings", title: L("Знакомство"), level: "A1" },
      cefr_certificate: false,
      created_at: "2026-11-19T08:20:00Z",
      user,
      user_id: user,
    };
    this.results.set(res.result_id, res);
    return res;
  }

  // =============================================================== catalog

  catalog(r: Req): Response {
    const key = `${r.method} ${r.path}`;
    if (key === "GET /internal/v1/pairs") {
      this.pairsCalls += 1;
      return json(200, { items: this.pairs.filter((p) => p.status !== "archived") });
    }
    const snap = /^\/internal\/v1\/courses\/([^/]+)\/snapshot$/.exec(r.path);
    if (snap && r.method === "GET") {
      if (this.snapshotDown) return err(503, "UPSTREAM_DOWN");
      if (snap[1] !== this.snapshot.course_id) return err(404, "COURSE_NOT_FOUND");
      if (r.headers["if-none-match"] === this.snapshotEtag) {
        this.snapshotCalls.notModified += 1;
        return new Response(null, { status: 304, headers: { etag: this.snapshotEtag } });
      }
      this.snapshotCalls.ok += 1;
      return json(200, this.snapshot, { etag: this.snapshotEtag });
    }
    const child = (typeof r.claims.lrn === "string" && r.claims.lrn !== r.subject) || ["6-9", "10-13"].includes(String(r.claims.age_band));
    const audience = (child ? "kids" : r.query.audience) as AudienceSegment | undefined;
    if (key === "GET /internal/v1/scenarios") {
      if (!audience) return err(422, "VALIDATION_ERROR", { field: "audience" });
      const items = this.scenarios
        .filter((s) => s.audience.includes(audience))
        .filter((s) => (!r.query.goal || s.goals.includes(r.query.goal as never)) && (!r.query.level || s.level === r.query.level) && (!r.query.topic || s.topics.includes(r.query.topic as never)));
      return json(200, { items, next_cursor: null });
    }
    const sc = /^\/internal\/v1\/scenarios\/([^/]+)$/.exec(r.path);
    if (sc && r.method === "GET") {
      const s = this.scenarios.find((x) => x.scenario_id === sc[1]);
      if (!s || !audience || !s.audience.includes(audience)) return err(404, "SCENARIO_NOT_FOUND");
      return json(200, s);
    }
    if (key === "GET /internal/v1/media") {
      if (!audience) return err(422, "VALIDATION_ERROR", { field: "audience" });
      const items = this.media
        .filter((m) => m.audience.includes(audience) && !this.suspended.has(m.asset_id))
        .filter((m) => (!r.query.type || m.type === r.query.type) && (!r.query.level || m.level === r.query.level))
        .map((m) => ({ asset_id: m.asset_id, type: m.type, title: m.title, level: m.level, topics: m.topics, duration_s: m.duration_s, source_label: m.source_label, allowed_uses: m.allowed_uses, has_audio: m.has_audio, rights_internal: "contract-42" }));
      return json(200, { items, next_cursor: null });
    }
    if (r.path === "/internal/v1/media/requests") {
      if (!r.subject) return err(401, "SUBJECT_REQUIRED");
      // как catalog is_child_profile: lrn ≠ sub или детский возраст в claims
      const lrn = r.claims.lrn;
      if ((typeof lrn === "string" && lrn !== r.subject) || ["6-9", "10-13"].includes(String(r.claims.age_band))) return err(403, "KIDS_NOT_ALLOWED");
      if (r.method === "GET") {
        return json(200, { items: this.requests.filter((x) => x.user === r.subject).map((x) => ({ ...x, user_id: x.user })) });
      }
      if (r.method === "POST") {
        const idem = r.headers["idempotency-key"];
        const prev = idem ? this.requestIdem.get(`${r.subject}:${idem}`) : undefined;
        if (prev) return json(201, this.requests.find((x) => x.request_id === prev));
        if (this.requests.filter((x) => x.user === r.subject).length >= 5) return err(429, "MEDIA_REQUEST_LIMIT", { retry_after: 3600 });
        const b = r.body as { kind: MediaRequest["kind"]; title: string; link?: string; comment?: string; ui_locale: string };
        const req: MediaRequest & { user: string; ui_locale: string } = {
          request_id: randomUUID(),
          kind: b.kind,
          title: b.title,
          link: b.link ?? null,
          comment: b.comment ?? null,
          status: "new",
          decision_note: null,
          linked_asset_id: null,
          created_at: "2026-11-19T09:00:00Z",
          decided_at: null,
          user: r.subject,
          ui_locale: b.ui_locale,
        };
        this.requests.push(req);
        if (idem) this.requestIdem.set(`${r.subject}:${idem}`, req.request_id);
        return json(201, req);
      }
    }
    const ma = /^\/internal\/v1\/media\/([^/]+)\/audio$/.exec(r.path);
    if (ma && r.method === "GET") {
      const m = this.media.find((x) => x.asset_id === ma[1]);
      if (!m || this.suspended.has(m.asset_id) || (audience && !m.audience.includes(audience))) return err(404, "MEDIA_NOT_AVAILABLE");
      if (!m.has_audio) return err(404, "AUDIO_NOT_FOUND");
      if (r.headers["if-none-match"] === this.audioEtag) {
        this.audioCalls.notModified += 1;
        return new Response(null, { status: 304, headers: { etag: this.audioEtag } });
      }
      this.audioCalls.ok += 1;
      return new Response(this.audioBytes, { status: 200, headers: { "content-type": this.audioType, etag: this.audioEtag, "content-length": String(this.audioBytes.length) } });
    }
    const md = /^\/internal\/v1\/media\/([^/]+)$/.exec(r.path);
    if (md && r.method === "GET") {
      const m = this.media.find((x) => x.asset_id === md[1]);
      if (!m || this.suspended.has(m.asset_id) || !audience || !m.audience.includes(audience)) return err(404, "MEDIA_NOT_AVAILABLE");
      return json(200, m);
    }
    return err(404, "NOT_FOUND");
  }

  // =============================================================== learning-plan

  trajectory(r: Req, goal: string | null): Response {
    if (this.trajectoryOverride) return this.trajectoryOverride(r);
    if (!["kids", "teens", "adults"].includes(r.query.audience ?? "")) return err(422, "VALIDATION_ERROR", { field: "audience" });
    if ((r.query.pair_id ?? "ru-en") !== "ru-en") return err(409, "PAIR_NOT_AVAILABLE", { pair_id: r.query.pair_id });
    const card = (id: string, kind: "core" | "optional") => ({
      lesson_id: id,
      module_id: "m-a1-01",
      title: L(`Урок ${id}`),
      goal: L("Представиться"),
      level: "A1" as const,
      kind,
      duration_min: 20,
      primary_skill_id: "en.func.greet",
      scenario_id: null,
      stages: [
        { type: "retrieval" as const, minutes: 3 },
        { type: "explanation" as const, minutes: 4 },
        { type: "roleplay" as const, minutes: 8 },
        { type: "assessment" as const, minutes: 3 },
        { type: "summary" as const, minutes: 2 },
      ],
      control_items: [{ answer: 0 }],
    });
    const t: Trajectory & { user_id: string } = {
      pair_id: "ru-en",
      course_id: "en-core",
      revision: this.trajectoryRevision,
      basis: { diagnostic_result_id: null, goal: goal as Trajectory["basis"]["goal"], computed_at: "2026-11-19T08:30:00Z" },
      next: { ...card("l-a1-01", "core"), reason_codes: ["no_diagnostic"], explanation: L("Начинаем с начала курса") },
      mandatory: [{ ...card("l-a1-01", "core"), reason_codes: ["no_diagnostic"] }, { ...card("l-a1-02", "core"), reason_codes: ["next_in_course"] }],
      optional: [{ ...card("l-opt-01", "optional"), reason_codes: ["goal_match"] }],
      completed: [],
      lessons_available: false,
      user_id: r.subject!,
    };
    return json(200, t);
  }
}

function scenario(id: string, audience: AudienceSegment[], level: "A0" | "A1" | "A2", goals: ScenarioDetail["goals"], topics: ScenarioDetail["topics"]) {
  return {
    scenario_id: id,
    title: L(`Сценарий ${id}`),
    task: L("Заселиться в гостиницу"),
    level,
    difficulty: 2,
    goals,
    topics,
    characters: [{ name: "Anna", role: L("Администратор") }],
    access: "free" as const,
    completion: L("Получить ключ"),
    opening: { speaker: "Anna", line_en: "Good evening! How can I help?", gloss: L("Добрый вечер! Чем помочь?"), replies: [{ description: L("Поздороваться"), example_en: "Hello!" }] },
    outcomes: [{ outcome: "success" as const, summary: L("Ключ получен") }],
    audience,
    nodes: { start: { line_en: "secret graph" } },
  };
}

function mediaItem(id: string, audience: AudienceSegment[], level: "A0" | "A1" | "A2", type: MediaDetail["type"], hasAudio: boolean, uses: MediaDetail["allowed_uses"]) {
  return {
    asset_id: id,
    type,
    title: L(`Материал ${id}`),
    level,
    topics: ["food" as const],
    duration_s: 45,
    source_label: "TilHero",
    allowed_uses: uses,
    has_audio: hasAudio,
    attribution: null,
    // catalog присылает транскрипт и без show_transcript — BFF обязан его убрать (защита в глубину)
    transcript: [{ t_start_ms: 0, t_end_ms: 3000, speaker: "A", text_en: "Hi!", gloss: L("Привет!") }],
    phrases: [{ en: "a cup of tea", gloss: L("чашка чая") }],
    voices: { A: "en-GB" as const },
    exercises_available: false,
    audience,
    rights_internal: "contract-42",
  };
}
