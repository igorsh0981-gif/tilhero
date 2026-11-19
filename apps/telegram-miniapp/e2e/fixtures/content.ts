import type {
  DiagnosticItem,
  DiagnosticResult,
  DiagnosticSession,
  DiagnosticState,
  MediaDetail,
  MediaRequest,
  MyLanguages,
  ScenarioDetail,
  SkillMap,
  Trajectory,
} from "@tilhero/contracts/bff";
import type { AudienceSegment } from "@tilhero/contracts/content";

/**
 * Sprint 3 part of the mock telegram-bff (bff.ts «Спринт 3»): placement test (adaptive order is the server's job — the
 * mock serves a fixed list), result with not_assessed areas and a follow-up, skill map, trajectory, scenarios, media
 * (audio bytes), song / film requests, languages. Children get only `kids` content; requests → 403 KIDS_NOT_ALLOWED.
 */
export interface ContentScenario {
  /** unfinished_limit — three results without an assessed area in the retest period: 409 DIAGNOSTIC_TOO_SOON */
  diag?: "none" | "in_progress" | "completed" | "unfinished_limit";
  /** completed: when a retake is allowed (default — in 14 days) */
  nextAllowedAt?: string | null;
  /** GET /v1/skills/map → 503 CATALOG_UNAVAILABLE */
  catalogDown?: boolean;
  /** requests already sent by the account */
  requests?: number;
}

const L = (ru: string, uz: string) => ({ ru, uz });
const DAY = 24 * 3600_000;

export const DX_ITEMS: DiagnosticItem[] = [
  { item_id: "v-a1-03", area: "vocabulary", type: "single_choice", instruction: L("Выберите перевод слова", "Soʻz tarjimasini tanlang"), prompt_en: "a ticket", passage_en: null, audio_text_en: null, options: ["билет", "чек", "очередь", "поезд"], position: 1 },
  { item_id: "g-a1-07", area: "grammar", type: "gap_choice", instruction: L("Вставьте пропущенное слово", "Tushib qolgan soʻzni qoʻying"), prompt_en: "She ___ from Tashkent.", passage_en: null, audio_text_en: null, options: ["is", "are", "am"], position: 2 },
  { item_id: "g-a1-12", area: "grammar", type: "order_words", instruction: L("Соберите вопрос «Где вокзал?»", "«Vokzal qayerda?» savolini tuzing"), prompt_en: "Put the words in order", passage_en: null, audio_text_en: null, options: ["the", "is", "Where", "station?"], position: 3 },
  { item_id: "r-a2-02", area: "reading", type: "read_choice", instruction: L("Прочитайте и ответьте на вопрос", "Oʻqing va savolga javob bering"), prompt_en: "Why is Aziz late?", passage_en: "Aziz usually takes the bus to work. Today the bus was full, so he walked. He came to the office twenty minutes late.", audio_text_en: null, options: ["The bus was full.", "He slept too long.", "His car broke."], position: 4 },
  { item_id: "l-a1-05", area: "listening", type: "listen_choice", instruction: L("Послушайте и выберите ответ", "Tinglang va javobni tanlang"), prompt_en: "What does the woman want?", passage_en: null, audio_text_en: "Could I have a cup of green tea, please?", options: ["coffee", "green tea", "water"], position: 5 },
];
const FOLLOWUP_ITEMS: DiagnosticItem[] = [
  { item_id: "g-a2-01", area: "grammar", type: "gap_choice", instruction: L("Вставьте пропущенное слово", "Tushib qolgan soʻzni qoʻying"), prompt_en: "We ___ to the cinema yesterday.", passage_en: null, audio_text_en: null, options: ["go", "went", "gone"], position: 1 },
  { item_id: "g-a2-02", area: "grammar", type: "single_choice", instruction: L("Выберите верный вариант", "Toʻgʻri variantni tanlang"), prompt_en: "Choose the question", passage_en: null, audio_text_en: null, options: ["Do you like tea?", "You like tea do?"], position: 2 },
  { item_id: "g-a2-03", area: "grammar", type: "gap_choice", instruction: L("Вставьте пропущенное слово", "Tushib qolgan soʻzni qoʻying"), prompt_en: "There ___ two books on the table.", passage_en: null, audio_text_en: null, options: ["is", "are"], position: 3 },
];

interface Run {
  s: DiagnosticSession;
  items: DiagnosticItem[];
  answers: Array<{ item_id: string; dont_know: boolean; answer: unknown }>;
  listening: boolean;
  resultId?: string;
}

export class MockContent {
  readonly sc: ContentScenario;
  runs = new Map<string, Run>();
  results: DiagnosticResult[] = [];
  nextAllowedAt: string | null = null;
  listeningUnavailableCalls = 0;
  requests: MediaRequest[] = [];
  private seq = 1;

  constructor(sc: ContentScenario = {}) {
    this.sc = sc;
    if (sc.diag === "completed") {
      const r = this.makeResult({ listening: true, revision: 1, createdAt: new Date(Date.now() - 3 * DAY).toISOString() });
      this.results.push(r);
      this.nextAllowedAt = sc.nextAllowedAt === undefined ? new Date(Date.now() + 11 * DAY).toISOString() : sc.nextAllowedAt;
    }
    if (sc.diag === "unfinished_limit") {
      for (let i = 3; i >= 1; i--) this.results.push(this.makeResult({ listening: true, revision: 1, empty: true, createdAt: new Date(Date.now() - i * DAY).toISOString() }));
      this.nextAllowedAt = new Date(Date.now() + 11 * DAY).toISOString();
    }
    if (sc.diag === "in_progress") {
      const run = this.newRun(DX_ITEMS);
      run.answers.push({ item_id: "v-a1-03", dont_know: false, answer: 0 });
      run.s.answered = 1;
    }
    for (let i = 0; i < (sc.requests ?? 0); i++) this.requests.push(this.request({ kind: "song", title: `Song ${i + 1}` }));
    if (!sc.requests) {
      this.requests.push({
        ...this.request({ kind: "movie", title: "The Lion King" }),
        status: "authored_alternative",
        decision_note: "Подобрали авторскую сценку «В саванне» — уже в медиатеке.",
        decided_at: new Date(Date.now() - DAY).toISOString(),
      });
    }
  }

  private id(prefix: string): string {
    return `${prefix}-aaaa-4bbb-8ccc-${String(this.seq++).padStart(12, "0")}`;
  }

  private newRun(items: DiagnosticItem[], followup: DiagnosticSession["followup_area"] = null, resultId?: string): Run {
    for (const r of this.runs.values()) if (r.s.status === "in_progress") r.s.status = "abandoned";
    const now = Date.now();
    const s: DiagnosticSession = {
      session_id: this.id("d1a90000"),
      pair_id: "ru-en",
      test_version: "dx-en-adult@1",
      status: "in_progress",
      answered: 0,
      total_estimate: items.length,
      started_at: new Date(now).toISOString(),
      expires_at: new Date(now + DAY).toISOString(),
      followup_area: followup,
    };
    const run: Run = { s, items, answers: [], listening: true, ...(resultId ? { resultId } : {}) };
    this.runs.set(s.session_id, run);
    return run;
  }

  private current(run: Run): DiagnosticItem | null {
    const left = run.items.filter((i) => !run.answers.some((a) => a.item_id === i.item_id) && (run.listening || i.area !== "listening"));
    const it = left[0];
    return it ? { ...it, position: run.answers.length + 1 } : null;
  }

  makeResult(o: { listening: boolean; revision: number; createdAt?: string; resultId?: string; empty?: boolean }): DiagnosticResult {
    const followDone = o.revision > 1;
    const na = (area: DiagnosticResult["areas"][number]["area"], reason: "too_few_items" | "no_speech_voice" | "not_in_test_yet") =>
      ({ area, status: "not_assessed" as const, band: null, confidence: null, reason, evidence: [], needs_followup: false });
    if (o.empty) {
      // finished in form, unfinished in substance: no assessed area
      return {
        result_id: o.resultId ?? this.id("4e5a0000"), revision: 1, pair_id: "ru-en", test_version: "dx-en-adult@1", provisional_level: null,
        areas: [na("vocabulary", "too_few_items"), na("grammar", "too_few_items"), na("reading", "too_few_items"), na("listening", "too_few_items"), na("speaking", "not_in_test_yet"), na("writing", "not_in_test_yet")],
        weak_areas: ["vocabulary", "grammar", "reading", "listening"], recommended_start: null, cefr_certificate: false, created_at: o.createdAt ?? new Date().toISOString(),
      };
    }
    return {
      result_id: o.resultId ?? this.id("4e5a0000"),
      revision: o.revision,
      pair_id: "ru-en",
      test_version: "dx-en-adult@1",
      provisional_level: "A1",
      areas: [
        { area: "vocabulary", status: "assessed", band: "A2", confidence: 0.82, reason: null, evidence: [{ band: "A1", answered: 3, correct: 3 }, { band: "A2", answered: 3, correct: 2 }, { band: "B1", answered: 2, correct: 0 }], needs_followup: false },
        {
          area: "grammar", status: "assessed", band: followDone ? "A2" : "A1", confidence: followDone ? 0.66 : 0.42, reason: null,
          evidence: followDone ? [{ band: "A1", answered: 3, correct: 2 }, { band: "A2", answered: 3, correct: 2 }] : [{ band: "A1", answered: 3, correct: 2 }, { band: "A2", answered: 1, correct: 0 }],
          needs_followup: !followDone,
        },
        { area: "reading", status: "assessed", band: "A1", confidence: 0.55, reason: null, evidence: [{ band: "A1", answered: 2, correct: 2 }, { band: "A2", answered: 2, correct: 1 }], needs_followup: false },
        na("listening", o.listening ? "too_few_items" : "no_speech_voice"),
        na("speaking", "not_in_test_yet"),
        na("writing", "not_in_test_yet"),
      ],
      weak_areas: ["reading", "listening"],
      recommended_start: { lesson_id: "l-a1-03-cafe", title: L("В кафе: заказ напитков", "Kafeda: ichimlik buyurtma qilish"), level: "A1" },
      cefr_certificate: false,
      created_at: o.createdAt ?? new Date().toISOString(),
    };
  }

  state(): DiagnosticState {
    const open = [...this.runs.values()].find((r) => r.s.status === "in_progress" && !r.s.followup_area);
    const last = this.results[this.results.length - 1] ?? null;
    return {
      pair_id: "ru-en",
      status: open ? "in_progress" : last ? "completed" : "none",
      session: open ? { ...open.s } : null,
      last_result: last,
      next_allowed_at: this.nextAllowedAt,
      audience: "adults",
    };
  }

  private request(o: { kind: MediaRequest["kind"]; title: string; link?: string | null; comment?: string | null }): MediaRequest {
    return {
      request_id: this.id("7e900000"),
      kind: o.kind,
      title: o.title,
      link: o.link ?? null,
      comment: o.comment ?? null,
      status: "new",
      decision_note: null,
      linked_asset_id: null,
      created_at: new Date().toISOString(),
      decided_at: null,
    };
  }

  trajectory(goal: string | null, audience: AudienceSegment): Trajectory {
    const done = this.results.length > 0;
    const card = (id: string, ru: string, uz: string, level: "A0" | "A1" | "A2", kind: "core" | "optional") => ({
      lesson_id: id,
      module_id: "m-a1-02",
      title: L(ru, uz),
      goal: L(`Цель урока «${ru}»`, `«${uz}» darsi maqsadi`),
      level,
      kind,
      duration_min: 20,
      primary_skill_id: "en.func.order",
      scenario_id: null,
      stages: [
        { type: "retrieval" as const, minutes: 3 },
        { type: "explanation" as const, minutes: 4 },
        { type: "roleplay" as const, minutes: 8 },
        { type: "assessment" as const, minutes: 3 },
        { type: "summary" as const, minutes: 2 },
      ],
    });
    const kids = audience === "kids";
    const next = kids ? card("l-k-01-animals", "Животные в зоопарке", "Hayvonot bogʻidagi hayvonlar", "A0", "core") : card("l-a1-03-cafe", "В кафе: заказ напитков", "Kafeda: ichimlik buyurtma qilish", "A1", "core");
    const optional =
      goal === "travel"
        ? [{ ...card("l-opt-airport", "В аэропорту: регистрация", "Aeroportda: roʻyxatdan oʻtish", "A1", "optional"), reason_codes: ["goal_match" as const] }]
        : [{ ...card("l-opt-small-talk", "Разговор о погоде", "Ob-havo haqida suhbat", "A1", "optional"), reason_codes: ["topic_match" as const] }];
    return {
      pair_id: "ru-en",
      course_id: "en-core",
      revision: 1 + this.results.length,
      basis: { diagnostic_result_id: done ? this.results[this.results.length - 1]!.result_id : null, goal: goal as Trajectory["basis"]["goal"], computed_at: new Date().toISOString() },
      next: {
        ...next,
        reason_codes: done ? ["start_after_diagnostic", "weak_area"] : ["no_diagnostic"],
        explanation: done
          ? L("Словарь у вас уверенный, а вежливые просьбы пока даются трудно — с них и начнём.", "Lugʻatingiz yaxshi, lekin xushmuomala iltimoslar hali qiyin — shulardan boshlaymiz.")
          : L("Проверки уровня ещё не было — начинаем с начала курса.", "Daraja tekshiruvi hali boʻlmadi — kurs boshidan boshlaymiz."),
      },
      mandatory: [
        { ...next, reason_codes: done ? ["start_after_diagnostic"] : ["no_diagnostic"] },
        { ...card("l-a1-04-shop", "В магазине: цены и размеры", "Doʻkonda: narx va oʻlchamlar", "A1", "core"), reason_codes: ["next_in_course"] },
        { ...card("l-a1-05-way", "Как пройти к вокзалу", "Vokzalga qanday borish mumkin", "A1", "core"), reason_codes: ["prerequisite_missing"] },
      ],
      optional,
      completed: [],
      lessons_available: false,
    };
  }

  skillMap(): SkillMap {
    const done = this.results.length > 0;
    const sk = (id: string, area: SkillMap["skills"][number]["area"], ru: string, uz: string, level: "A0" | "A1" | "A2", state: SkillMap["skills"][number]["state"], pre: string[] = []) => ({
      skill_id: id,
      area,
      title: L(ru, uz),
      level,
      state: done ? state : "not_started",
      confidence: done && state !== "not_started" ? 0.7 : null,
      prerequisites: pre,
      updated_at: done && state !== "not_started" ? this.results[0]!.created_at : null,
      history: done && state !== "not_started" ? [{ source: "diagnostic" as const, outcome: state === "learning" ? ("negative" as const) : ("positive" as const), at: this.results[0]!.created_at }] : [],
    });
    const skills = [
      sk("en.func.greet", "function", "Приветствие и знакомство", "Salomlashish va tanishish", "A0", "demonstrated"),
      sk("en.func.order", "function", "Вежливая просьба в кафе", "Kafeda xushmuomala iltimos", "A1", "learning", ["en.func.greet"]),
      sk("en.vocab.food", "vocabulary", "Еда и напитки", "Ovqat va ichimliklar", "A1", "demonstrated"),
      sk("en.vocab.travel", "vocabulary", "Транспорт и билеты", "Transport va chiptalar", "A1", "not_started"),
      sk("en.gram.to-be", "grammar", "Глагол to be", "to be feʼli", "A0", "demonstrated"),
      sk("en.gram.questions", "grammar", "Порядок слов в вопросе", "Savolda soʻz tartibi", "A1", "learning", ["en.gram.to-be"]),
      sk("en.read.short", "reading", "Короткие тексты", "Qisqa matnlar", "A1", "not_started"),
    ];
    const counts = { not_started: 0, learning: 0, demonstrated: 0, retained: 0 };
    for (const s of skills) counts[s.state] += 1;
    return { pair_id: "ru-en", course_id: "en-core", counts, skills };
  }

  readonly scenarios: Array<ScenarioDetail & { audience: AudienceSegment[] }> = [
    scenario("sc-travel-hotel", ["adults", "teens"], "A1", ["travel"], L("Заселение в гостиницу", "Mehmonxonaga joylashish"), L("Заселиться и узнать, когда завтрак", "Joylashish va nonushta vaqtini bilish"), "Anna", L("Администратор", "Administrator"), "Good evening! Do you have a reservation?", L("Добрый вечер! У вас есть бронь?", "Xayrli kech! Bron qilganmisiz?")),
    scenario("sc-cafe-order", ["adults", "teens"], "A1", ["daily", "travel"], L("Заказ в кафе", "Kafeda buyurtma"), L("Заказать напиток и попросить счёт", "Ichimlik buyurtma qilish va hisobni soʻrash"), "Tom", L("Официант", "Ofitsiant"), "Hi! What can I get you?", L("Привет! Что вам принести?", "Salom! Sizga nima olib kelay?")),
    scenario("sc-work-standup", ["adults"], "A2", ["work", "career"], L("Утренняя планёрка", "Ertalabki yigʻilish"), L("Рассказать, что сделали вчера", "Kecha nima qilganingizni aytib berish"), "Lisa", L("Руководитель", "Rahbar"), "Morning, team! What did you do yesterday?", L("Доброе утро! Что вы сделали вчера?", "Xayrli tong! Kecha nima qildingiz?")),
    scenario("sc-kids-zoo", ["kids"], "A0", ["daily"], L("В зоопарке", "Hayvonot bogʻida"), L("Назвать животных и цвета", "Hayvonlar va ranglarni aytish"), "Max", L("Смотритель зоопарка", "Hayvonot bogʻi xodimi"), "Look! What is this animal?", L("Смотри! Что это за животное?", "Qara! Bu qanday hayvon?")),
  ];

  readonly media: Array<MediaDetail & { audience: AudienceSegment[] }> = [
    {
      ...mediaCard("m-own-coffee", "own_scene", L("Кофе с собой", "Olib ketish uchun qahva"), "A1", true, ["listen", "show_transcript", "dictionary", "translation"]),
      attribution: null,
      transcript: [
        { t_start_ms: 0, t_end_ms: 2500, speaker: "Barista", text_en: "Hi! What would you like?", gloss: L("Привет! Что будете?", "Salom! Nima olasiz?") },
        { t_start_ms: 2600, t_end_ms: 5200, speaker: "Aziz", text_en: "A latte to go, please.", gloss: L("Латте с собой, пожалуйста.", "Olib ketish uchun latte, iltimos.") },
      ],
      phrases: [{ en: "to go", gloss: L("с собой", "olib ketish uchun") }],
      voices: { Barista: "en-GB", Aziz: "en-US" },
      exercises_available: true,
      audience: ["adults", "teens"],
    },
    {
      ...mediaCard("m-own-train", "dialogue", L("Билет на поезд", "Poyezd chiptasi"), "A2", false, ["listen", "show_transcript", "translation"]),
      attribution: null,
      transcript: [
        { t_start_ms: 0, t_end_ms: 3000, speaker: "Clerk", text_en: "Where are you travelling to?", gloss: L("Куда вы едете?", "Qayerga ketyapsiz?") },
        { t_start_ms: 3100, t_end_ms: 6000, speaker: "Nilu", text_en: "Samarkand, one way, please.", gloss: L("В Самарканд, в одну сторону.", "Samarqandga, bir tomonga.") },
      ],
      phrases: [],
      voices: { Clerk: "en-GB", Nilu: "en-US" },
      exercises_available: false,
      audience: ["adults", "teens"],
    },
    {
      ...mediaCard("m-pd-poem", "song", L("Старинная песня (общественное достояние)", "Qadimiy qoʻshiq (jamoat mulki)"), "A2", false, ["listen"]),
      source_label: "Общественное достояние",
      attribution: "Traditional, public domain",
      transcript: null,
      phrases: [],
      voices: {},
      exercises_available: false,
      audience: ["adults"],
    },
    {
      // the licence allows the transcript but not listening: no file, no speech synthesis
      ...mediaCard("m-own-quotes", "dialogue", L("Фразы из интервью", "Intervyudan iboralar"), "A2", false, ["show_transcript", "translation"]),
      attribution: null,
      transcript: [{ t_start_ms: 0, t_end_ms: 3000, speaker: "Host", text_en: "Tell us about your first job.", gloss: L("Расскажите о первой работе.", "Birinchi ishingiz haqida aytib bering.") }],
      phrases: [],
      voices: { Host: "en-GB" },
      exercises_available: false,
      audience: ["adults", "teens"],
    },
    {
      ...mediaCard("m-kids-colours", "song", L("Песенка про цвета", "Ranglar haqida qoʻshiq"), "A0", false, ["listen", "show_transcript", "translation"]),
      attribution: null,
      transcript: [{ t_start_ms: 0, t_end_ms: 3000, speaker: "Max", text_en: "Red and blue and yellow too!", gloss: L("Красный, синий и жёлтый!", "Qizil, koʻk va sariq ham!") }],
      phrases: [],
      voices: { Max: "en-GB" },
      exercises_available: false,
      audience: ["kids"],
    },
  ];

  languages(): MyLanguages {
    return {
      active_pair_id: "ru-en",
      pairs: [
        { pair_id: "ru-en", source: "ru", target: "en", title: L("Английский (объяснения на русском)", "Ingliz tili (rus tilida tushuntirish)"), status: "published", available: true },
        { pair_id: "ru-uz", source: "ru", target: "uz", title: L("Узбекский (объяснения на русском)", "Oʻzbek tili (rus tilida tushuntirish)"), status: "development", available: false },
        { pair_id: "ru-kk", source: "ru", target: "kk", title: L("Казахский (объяснения на русском)", "Qozoq tili (rus tilida tushuntirish)"), status: "planned", available: false },
        { pair_id: "en-uz", source: "en", target: "uz", title: L("Узбекский (объяснения на английском)", "Oʻzbek tili (ingliz tilida tushuntirish)"), status: "planned", available: false },
      ],
    };
  }

  /**
   * Route a sprint 3 call. `res(status, body)` answers; returns false when the path is not a sprint 3 route.
   */
  handle(
    method: string,
    path: string,
    q: URLSearchParams,
    b: Record<string, unknown>,
    headers: Record<string, string>,
    ctx: { kid: boolean; goal: string | null; idem: Map<string, unknown> },
    res: (status: number, body?: unknown, code?: string, details?: Record<string, unknown>, raw?: { contentType: string; body: Buffer }) => Promise<void>,
  ): Promise<void> | false {
    const key = `${method} ${path}`;
    const audience: AudienceSegment = ctx.kid ? "kids" : "adults";
    if (key === "GET /v1/languages") return res(200, this.languages());
    if (key === "GET /v1/diagnostics/state") return res(200, { ...this.state(), audience: ctx.kid ? "kids" : "adults" });
    if (key === "POST /v1/diagnostics/sessions") {
      const k = `dx:${headers["idempotency-key"]}`;
      if (!headers["idempotency-key"]) return res(422, undefined, "IDEMPOTENCY_KEY_REQUIRED");
      if (ctx.idem.has(k)) return res(201, ctx.idem.get(k));
      if (this.nextAllowedAt && Date.parse(this.nextAllowedAt) > Date.now()) return res(409, undefined, "DIAGNOSTIC_TOO_SOON", { next_allowed_at: this.nextAllowedAt });
      const run = this.newRun(DX_ITEMS);
      ctx.idem.set(k, run.s);
      return res(201, run.s);
    }
    let m = /^\/v1\/diagnostics\/sessions\/([^/]+)\/(next|answers|listening-unavailable|finish)$/.exec(path);
    if (m) {
      const run = this.runs.get(m[1]!);
      if (!run) return res(404, undefined, "DIAGNOSTIC_SESSION_NOT_FOUND");
      if (run.s.status !== "in_progress") return res(409, undefined, "DIAGNOSTIC_SESSION_CLOSED", { status: run.s.status });
      const cur = this.current(run);
      if (m[2] === "next") return res(200, cur ?? { done: true });
      if (m[2] === "listening-unavailable") {
        run.listening = false;
        this.listeningUnavailableCalls += 1;
        return res(204);
      }
      if (m[2] === "answers") {
        if (!cur || cur.item_id !== b.item_id) return res(409, undefined, "ITEM_NOT_CURRENT");
        run.answers.push({ item_id: String(b.item_id), dont_know: !!b.dont_know, answer: b.answer ?? null });
        run.s.answered = run.answers.length;
        const next = this.current(run);
        return res(200, { accepted: true, next, done: !next });
      }
      if (m[2] === "finish") {
        if (!run.answers.length) return res(422, undefined, "DIAGNOSTIC_EMPTY");
        run.s.status = "finished";
        const prev = run.resultId ? this.results.find((r) => r.result_id === run.resultId) : undefined;
        const r = this.makeResult({ listening: run.listening, revision: (prev?.revision ?? 0) + 1, ...(prev ? { resultId: prev.result_id } : {}) });
        this.results = [...this.results.filter((x) => x.result_id !== r.result_id), r];
        if (!prev) this.nextAllowedAt = new Date(Date.now() + 14 * DAY).toISOString();
        return res(200, r);
      }
    }
    m = /^\/v1\/diagnostics\/results\/([^/]+)\/followup$/.exec(path);
    if (m && method === "POST") {
      const r = this.results.find((x) => x.result_id === m![1]);
      if (!r) return res(404, undefined, "DIAGNOSTIC_RESULT_NOT_FOUND");
      const area = r.areas.find((a) => a.area === b.area);
      if (!area?.needs_followup) return res(409, undefined, "FOLLOWUP_NOT_AVAILABLE", { area: b.area, reason: "not_needed" });
      return res(201, this.newRun(FOLLOWUP_ITEMS, area.area, r.result_id).s);
    }
    if (key === "GET /v1/diagnostics/results") return res(200, { items: [...this.results].reverse() });
    if (key === "GET /v1/skills/map") {
      if (this.sc.catalogDown) return res(503, undefined, "CATALOG_UNAVAILABLE", { service: "catalog" });
      return res(200, this.skillMap());
    }
    if (key === "GET /v1/plan/trajectory") return res(200, this.trajectory(ctx.goal, audience));
    if (key === "GET /v1/scenarios") {
      const items = this.scenarios
        .filter((s) => s.audience.includes(audience))
        .filter((s) => (!q.get("goal") || s.goals.includes(q.get("goal") as never)) && (!q.get("level") || s.level === q.get("level")))
        .map(({ audience: _a, completion: _c, opening: _o, outcomes: _x, ...card }) => card);
      return res(200, { items, next_cursor: null });
    }
    m = /^\/v1\/scenarios\/([a-z0-9._-]+)$/.exec(path);
    if (m) {
      const s = this.scenarios.find((x) => x.scenario_id === m![1] && x.audience.includes(audience));
      if (!s) return res(404, undefined, "SCENARIO_NOT_FOUND");
      const { audience: _a, ...detail } = s;
      return res(200, detail);
    }
    if (key === "GET /v1/media/requests") {
      if (ctx.kid) return res(403, undefined, "KIDS_NOT_ALLOWED");
      return res(200, { items: [...this.requests].reverse() });
    }
    if (key === "POST /v1/media/requests") {
      if (ctx.kid) return res(403, undefined, "KIDS_NOT_ALLOWED");
      const k = `mr:${headers["idempotency-key"]}`;
      if (!headers["idempotency-key"]) return res(422, undefined, "IDEMPOTENCY_KEY_REQUIRED");
      if (ctx.idem.has(k)) return res(201, ctx.idem.get(k));
      if (this.requests.length >= 5) return res(429, undefined, "MEDIA_REQUEST_LIMIT", { retry_after: 3600 });
      const r = this.request({ kind: b.kind as MediaRequest["kind"], title: String(b.title), link: (b.link as string) ?? null, comment: (b.comment as string) ?? null });
      this.requests.push(r);
      ctx.idem.set(k, r);
      return res(201, r);
    }
    if (key === "GET /v1/media") {
      const items = this.media
        .filter((x) => x.audience.includes(audience))
        .filter((x) => (!q.get("type") || x.type === q.get("type")) && (!q.get("level") || x.level === q.get("level")))
        .map((x) => ({ asset_id: x.asset_id, type: x.type, title: x.title, level: x.level, topics: x.topics, duration_s: x.duration_s, source_label: x.source_label, allowed_uses: x.allowed_uses, has_audio: x.has_audio }));
      return res(200, { items, next_cursor: null });
    }
    m = /^\/v1\/media\/([a-z0-9._-]+)\/audio$/.exec(path);
    if (m) {
      const x = this.media.find((y) => y.asset_id === m![1] && y.audience.includes(audience));
      if (!x) return res(404, undefined, "MEDIA_NOT_AVAILABLE");
      if (!x.has_audio) return res(404, undefined, "AUDIO_NOT_FOUND");
      return res(200, undefined, undefined, undefined, { contentType: "audio/wav", body: silentWav() });
    }
    m = /^\/v1\/media\/([a-z0-9._-]+)$/.exec(path);
    if (m) {
      const x = this.media.find((y) => y.asset_id === m![1] && y.audience.includes(audience));
      if (!x) return res(404, undefined, "MEDIA_NOT_AVAILABLE");
      const { audience: _a, ...detail } = x;
      return res(200, detail);
    }
    return false;
  }
}

function scenario(
  id: string,
  audience: AudienceSegment[],
  level: "A0" | "A1" | "A2",
  goals: ScenarioDetail["goals"],
  title: { ru: string; uz: string },
  task: { ru: string; uz: string },
  who: string,
  role: { ru: string; uz: string },
  line: string,
  gloss: { ru: string; uz: string },
): ScenarioDetail & { audience: AudienceSegment[] } {
  return {
    scenario_id: id,
    title,
    task,
    level,
    difficulty: level === "A0" ? 1 : level === "A1" ? 2 : 3,
    goals,
    topics: ["travel"],
    characters: [{ name: who, role }],
    access: "free",
    completion: L("Задача решена вежливо и без подсказок", "Vazifa xushmuomalalik bilan, yordamsiz bajarildi"),
    opening: {
      speaker: who,
      line_en: line,
      gloss,
      replies: [
        { description: L("Поздороваться и назвать имя", "Salomlashib, ismni aytish"), example_en: "Hello! My name is Aziz." },
        { description: L("Переспросить", "Qayta soʻrash"), example_en: "Sorry, could you repeat that?" },
      ],
    },
    outcomes: [
      { outcome: "success", summary: L("Всё получилось", "Hammasi chiqdi") },
      { outcome: "alt_success", summary: L("Договорились о другом варианте", "Boshqa variantga kelishildi") },
      { outcome: "fail", summary: L("Разговор не сложился — попробуем ещё раз", "Suhbat chiqmadi — yana urinib koʻramiz") },
    ],
    audience,
  };
}

function mediaCard(id: string, type: MediaDetail["type"], title: { ru: string; uz: string }, level: "A0" | "A1" | "A2", hasAudio: boolean, uses: MediaDetail["allowed_uses"]) {
  return { asset_id: id, type, title, level, topics: ["food" as const], duration_s: 42, source_label: "TilHero", allowed_uses: uses, has_audio: hasAudio };
}

/** 0.2 s of silence, 8 kHz mono WAV. */
function silentWav(): Buffer {
  const samples = 1600;
  const buf = Buffer.alloc(44 + samples);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(8000, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples, 40);
  buf.fill(128, 44);
  return buf;
}
