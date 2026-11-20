/**
 * Подделки спринта 5 для тестов BFF:
 *  - FakeMemory — memory по INTERNAL_API §1.10 (формы bff.ts «Спринт 5»): ученик — из claim `lrn` (sub — аккаунт), детский
 *    профиль — `lrn ≠ sub` или детский `age_band`. В ответах — служебные поля домена (user_id, FSRS, `answers_en` с меткой
 *    MEM_SECRET), которые BFF обязан отбросить; переключатели «утечек» для проверки строгости BFF;
 *  - FakeReading — тексты для чтения catalog (`/internal/v1/readings*`) и практика reading lessons (старт, шаги,
 *    `reading-results`); вопросы домена несут метку MEM_SECRET — в ответах BFF её быть не должно.
 */
import { randomUUID } from "node:crypto";
import type * as C from "@tilhero/contracts/bff";
import type { Req } from "./helpers.js";

const L = (ru: string) => ({ ru, uz: `${ru} (uz)` });
/** Метка ключа ответа / служебных данных домена: не должна встретиться ни в одном ответе BFF. */
export const MEM_SECRET = "MEMORY-KEY-77";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, details: Record<string, unknown> = {}) =>
  json(status, { code, message: `domain says ${code}`, trace_id: "domain-trace", details });

const KID_BANDS = new Set(["6-9", "10-13"]);
const AT = "2026-11-20T09:00:00Z";

interface Learner {
  lrn: string;
  kids: boolean;
  band: string | null;
}

function learnerOf(r: Req): Learner | Response {
  const lrn = typeof r.claims.lrn === "string" ? r.claims.lrn : null;
  if (!lrn) return err(401, "USER_CONTEXT_MISSING");
  const band = typeof r.claims.age_band === "string" ? r.claims.age_band : null;
  return { lrn, kids: lrn !== r.subject || (band !== null && KID_BANDS.has(band)), band };
}

interface CardRec {
  owner: string;
  card: C.DictionaryCard;
  example_en: string | null;
  error: { correction: string; evidence: string | null; error_code: string; explanation: { ru: string; uz: string } } | null;
}

interface TaskRec {
  task: C.ReviewTask;
  key: { correct?: number; answer?: string; check?: boolean };
  done: (C.ReviewTaskResult & Record<string, unknown>) | null;
}

interface ReviewRec {
  owner: string;
  view: C.ReviewSession;
  tasks: TaskRec[];
  cursor: number;
  checkCorrect: number;
}

export class FakeMemory {
  readonly cards = new Map<string, CardRec>();
  readonly seeded = new Set<string>();
  readonly cardIdem = new Map<string, { status: number; card_id: string }>();
  readonly sessions = new Map<string, ReviewRec>();
  readonly sessionIdem = new Map<string, string>();
  /** ученики с согласием на запись голоса (memory проверяет /public identity-consent) */
  readonly voiceConsent = new Set<string>();
  speechAvailable = true;
  /** форма ответа произношения: PronunciationResult (ai.ts) | PronunciationView | insufficient_evidence | unavailable */
  pronunciationMode: "result" | "view" | "insufficient" | "unavailable" = "result";
  /** байты последнего аудио, пришедшего в memory */
  lastAudio: Buffer | null = null;
  nothingToReview = false;
  cardsLimit = false;
  lookupDown = false;
  /** «утечки» домена: лишнее поле задания / ключ в подсказке / английский ответ в подсказке typed / ответ проверки */
  leakTaskField = false;
  leakPromptKey = false;
  revealTypedText = false;
  leakCheckAnswer = false;
  badCardItem = false;

  private ensure(l: Learner): void {
    if (this.seeded.has(l.lrn)) return;
    this.seeded.add(l.lrn);
    this.addCard(l.lrn, { kind: "word", text_en: "coffee", gloss: L("кофе"), status: "review" });
    this.addCard(l.lrn, { kind: "phrase", text_en: "take away", gloss: L("с собой"), status: "new" });
    if (!l.kids) {
      this.addCard(l.lrn, {
        kind: "error",
        text_en: "I agree",
        gloss: L("Лишний глагол be"),
        status: "learning",
        error: { correction: "I agree", evidence: "I am agree with you", error_code: "extra_be", explanation: L("Лишний глагол be") },
      });
    }
  }

  addCard(owner: string, o: { kind: C.CardKind; text_en: string; gloss: { ru: string; uz: string }; status: C.CardStatus; error?: CardRec["error"] }): string {
    const id = randomUUID();
    this.cards.set(id, {
      owner,
      card: {
        card_id: id,
        kind: o.kind,
        text_en: o.text_en,
        gloss: o.gloss,
        gloss_source: "course",
        status: o.status,
        strength: o.status === "new" ? "new" : "ok",
        due_at: o.status === "known" ? null : "2026-11-21T09:00:00Z",
        last_reviewed_at: o.status === "new" ? null : AT,
        created_at: AT,
      },
      example_en: o.kind === "error" ? null : `I'd like a ${o.text_en}.`,
      error: o.error ?? null,
    });
    return id;
  }

  ownCards(lrn: string): CardRec[] {
    return [...this.cards.values()].filter((c) => c.owner === lrn);
  }

  private cardOut(c: CardRec): Record<string, unknown> {
    return { ...c.card, user_id: c.owner, answers_en: [MEM_SECRET], stability: 3.17, difficulty: 5.28 };
  }

  private buildTasks(owner: string): TaskRec[] {
    const [a, b] = this.ownCards(owner);
    const total = 5;
    const base = (i: number, type: C.ReviewTaskType, card: string | null): C.ReviewTask => ({
      task_id: randomUUID(),
      index: i,
      total,
      type,
      card_id: card,
      check: null,
      prompt: { text_en: null, gloss: null, example_en: null, example_gap: null, speech_text: null, explanation: null, evidence: null, instruction: null, prompt_en: null },
      options: [],
      tiles: [],
      answer_kind: "none",
      hints: [],
      hints_used: [],
      voice: "en-GB",
    });
    const intro = base(1, "intro", a!.card.card_id);
    intro.prompt = { ...intro.prompt, text_en: "coffee", gloss: L("кофе"), example_en: "I'd like a coffee." };
    const choice = base(2, "meaning_choice", a!.card.card_id);
    choice.prompt = { ...choice.prompt, text_en: "coffee" };
    choice.options = ["кофе", "чай", "сок", "вода"];
    choice.answer_kind = "choice";
    choice.hints = ["reveal"];
    const typed = base(3, "typed", b!.card.card_id);
    typed.prompt = { ...typed.prompt, gloss: L("с собой"), example_gap: "Is it for here or to ___?" };
    typed.answer_kind = "text";
    typed.hints = ["first_letter", "reveal"];
    const check = (i: number, position: number): C.ReviewTask => {
      const t = base(i, "check_item", null);
      t.check = { check_id: "chk-1", skill_title: L("Вежливая просьба"), position, of: 2 };
      t.prompt = { ...t.prompt, instruction: L("Выберите вариант"), prompt_en: `Can I ___ a coffee? (${position})` };
      t.options = ["have", "has", "having"];
      t.answer_kind = "choice";
      return t;
    };
    return [
      { task: intro, key: {}, done: null },
      { task: choice, key: { correct: 0 }, done: null },
      { task: typed, key: { answer: "take away" }, done: null },
      { task: check(4, 1), key: { correct: 0, check: true }, done: null },
      { task: check(5, 2), key: { correct: 0, check: true }, done: null },
    ];
  }

  private taskOut(t: TaskRec): Record<string, unknown> {
    const out: Record<string, unknown> = { ...t.task, prompt: { ...t.task.prompt } };
    if (this.leakTaskField) out.answers_en = [MEM_SECRET];
    if (this.leakPromptKey) (out.prompt as Record<string, unknown>).key = MEM_SECRET;
    if (this.revealTypedText && t.task.type === "typed") (out.prompt as Record<string, unknown>).text_en = MEM_SECRET;
    return out;
  }

  private sessionOut(s: ReviewRec): Record<string, unknown> {
    return { ...s.view, done_tasks: s.cursor, user_id: s.owner, plan: s.tasks.map((t) => t.task.task_id) };
  }

  memory(r: Req): Response {
    const l = learnerOf(r);
    if (l instanceof Response) return l;
    this.ensure(l);
    const key = `${r.method} ${r.path}`;
    switch (key) {
      case "GET /internal/v1/overview":
        return json(200, {
          due_count: 2,
          new_available: l.kids ? 1 : 1,
          retention_due: 1,
          done_today: false,
          active_session_id: [...this.sessions.entries()].find(([, s]) => s.owner === l.lrn && s.view.status === "active")?.[0] ?? null,
          next_due_at: null,
          total_cards: this.ownCards(l.lrn).length,
          pronunciation: !this.speechAvailable ? "unavailable" : this.voiceConsent.has(l.lrn) ? "available" : l.kids ? "consent_guardian" : "consent_self",
          user_id: l.lrn,
        });
      case "GET /internal/v1/cards": {
        const q = (r.query.q ?? "").toLowerCase();
        const items: unknown[] = this.ownCards(l.lrn)
          .filter((c) => (!r.query.kind || c.card.kind === r.query.kind) && (!r.query.status || c.card.status === r.query.status))
          .filter((c) => !q || c.card.text_en.toLowerCase().includes(q) || c.card.gloss.ru.toLowerCase().includes(q))
          .map((c) => this.cardOut(c));
        if (this.badCardItem) items.push({ card_id: randomUUID(), kind: "sentence", text_en: "bad" });
        return json(200, { items, next_cursor: null });
      }
      case "POST /internal/v1/cards": {
        const idem = r.headers["idempotency-key"];
        if (!idem) return err(422, "IDEMPOTENCY_KEY_REQUIRED");
        const prev = this.cardIdem.get(`${l.lrn}:${idem}`);
        if (prev) return json(prev.status, this.cardOut(this.cards.get(prev.card_id)!));
        const b = r.body as { text_en?: string; source?: { kind?: string; key?: string; version?: number } };
        if (!b?.text_en || !b.source?.kind || Object.keys(b).sort().join() !== "source,text_en") return err(422, "VALIDATION_ERROR");
        if (b.text_en === "my own sentence") return err(422, "WORD_NOT_IN_CONTENT");
        if (this.cardsLimit) return err(422, "CARDS_LIMIT", { limit: 2000 });
        const existing = this.ownCards(l.lrn).find((c) => c.card.text_en.toLowerCase() === b.text_en!.toLowerCase());
        const id = existing?.card.card_id ?? this.addCard(l.lrn, { kind: b.text_en.includes(" ") ? "phrase" : "word", text_en: b.text_en, gloss: L(`[ru] ${b.text_en}`), status: "new" });
        const status = existing ? 200 : 201;
        this.cardIdem.set(`${l.lrn}:${idem}`, { status, card_id: id });
        return json(status, this.cardOut(this.cards.get(id)!));
      }
      case "POST /internal/v1/cards/lookup": {
        if (this.lookupDown) return err(503, "UPSTREAM_DOWN");
        const texts = (r.body as { texts?: string[] })?.texts ?? [];
        if (texts.length > 50) return err(422, "VALIDATION_ERROR");
        const own = this.ownCards(l.lrn);
        return json(200, { items: texts.map((t) => ({ text: t, card_id: own.find((c) => c.card.text_en.toLowerCase() === t.toLowerCase())?.card.card_id ?? null })) });
      }
      case "GET /internal/v1/errors":
        return json(200, {
          items: l.kids
            ? []
            : this.ownCards(l.lrn)
                .filter((c) => c.card.kind === "error")
                .map((c) => ({
                  card_id: c.card.card_id,
                  correction: c.error!.correction,
                  error_code: c.error!.error_code,
                  explanation: c.error!.explanation,
                  severity: "medium",
                  strength: "weak",
                  lesson_title: L("В кафе"),
                  created_at: AT,
                  evidence: c.error!.evidence, // вне контракта списка — BFF отбрасывает
                })),
          next_cursor: null,
        });
      case "POST /internal/v1/review-sessions": {
        const idem = r.headers["idempotency-key"];
        if (!idem) return err(422, "IDEMPOTENCY_KEY_REQUIRED");
        const prev = this.sessionIdem.get(`${l.lrn}:${idem}`);
        if (prev) return json(201, this.sessionOut(this.sessions.get(prev)!));
        const active = [...this.sessions.values()].find((s) => s.owner === l.lrn && s.view.status === "active");
        if (active) return json(200, this.sessionOut(active));
        if (this.nothingToReview) return err(409, "NOTHING_TO_REVIEW", { next_due_at: "2026-11-22T09:00:00Z" });
        const id = randomUUID();
        const tasks = this.buildTasks(l.lrn);
        this.sessions.set(id, {
          owner: l.lrn,
          tasks,
          cursor: 0,
          checkCorrect: 0,
          view: { session_id: id, status: "active", total_tasks: tasks.length, done_tasks: 0, cards: 2, new_cards: 1, checks: 1, started_at: AT, finished_at: null, minutes: 0 },
        });
        this.sessionIdem.set(`${l.lrn}:${idem}`, id);
        return json(201, this.sessionOut(this.sessions.get(id)!));
      }
      case "GET /internal/v1/review-sessions/active": {
        const active = [...this.sessions.values()].find((s) => s.owner === l.lrn && s.view.status === "active");
        return json(200, { session: active ? this.sessionOut(active) : null });
      }
      case "POST /internal/v1/translate": {
        const b = r.body as { content_ref?: { kind: string; key: string; version: number; locator?: string }; text?: string };
        if (!b?.content_ref || typeof b.text !== "string" || Object.keys(b).sort().join() !== "content_ref,text") return err(422, "VALIDATION_ERROR");
        if (b.content_ref.version === 99) return err(404, "CONTENT_NOT_FOUND");
        if (b.text === "notincontent") return err(422, "WORD_NOT_IN_CONTENT");
        const own = this.ownCards(l.lrn).find((c) => c.card.text_en === b.text);
        return json(200, {
          text: b.text,
          lemma: b.text,
          part_of_speech: "noun",
          gloss: L(`[ru] ${b.text}`),
          source: b.text === "latte" ? "ai" : "course",
          ai_unreviewed: b.text === "latte",
          note: null,
          in_dictionary: own?.card.card_id ?? null,
          reason: null,
          cache: "miss", // служебное — BFF отбрасывает
          user_id: l.lrn,
        });
      }
      case "POST /internal/v1/pronunciation":
        return this.pronunciation(r, l);
    }

    const cm = /^\/internal\/v1\/cards\/([^/]+)(\/known)?$/.exec(r.path);
    if (cm) {
      const c = this.cards.get(cm[1]!);
      if (!c || c.owner !== l.lrn) return err(404, "CARD_NOT_FOUND");
      if (cm[2]) {
        if (r.method === "POST") c.card = { ...c.card, status: "known", due_at: null };
        else if (r.method === "DELETE") c.card = { ...c.card, status: "learning", due_at: AT };
        else return err(405, "METHOD_NOT_ALLOWED");
        return json(200, this.cardOut(c));
      }
      if (r.method === "DELETE") {
        this.cards.delete(cm[1]!);
        return new Response(null, { status: 204 });
      }
      if (r.method === "GET") {
        return json(200, {
          ...this.cardOut(c),
          example_en: c.example_en,
          error: c.error,
          sources: [{ kind: "lesson", title: L("В кафе"), at: AT, key: "l-a1-03-cafe", version: 3 }],
          history: [{ at: AT, grade: "good", mode: "typed", before: { stability: 1 }, after: { stability: 3 } }],
          next_review_in_days: 1,
          last_pronunciation: null,
        });
      }
    }

    const sm = /^\/internal\/v1\/review-sessions\/([^/]+)(?:\/(current|finish|cancel|tasks\/([^/]+)(\/hint)?))?$/.exec(r.path);
    if (sm) {
      const s = this.sessions.get(sm[1]!);
      if (!s || s.owner !== l.lrn) return err(404, "REVIEW_SESSION_NOT_FOUND");
      const action = sm[2];
      const current = s.tasks[s.cursor] ?? null;
      if (!action && r.method === "GET") return json(200, this.sessionOut(s));
      if (action === "current" && r.method === "GET") {
        if (s.view.status !== "active") return err(409, "REVIEW_SESSION_STATE", { status: s.view.status });
        if (!current) return err(409, "TASK_NOT_CURRENT", { current_task_id: null });
        return json(200, this.taskOut(current));
      }
      if (action === "cancel" && r.method === "POST") {
        if (s.view.status !== "active") return err(409, "REVIEW_SESSION_STATE", { status: s.view.status });
        s.view = { ...s.view, status: "cancelled", finished_at: AT };
        return json(200, this.sessionOut(s));
      }
      if (action === "finish" && r.method === "POST") {
        if (current) return err(409, "TASK_NOT_CURRENT", { current_task_id: current.task.task_id });
        s.view = { ...s.view, status: "completed", finished_at: AT, minutes: 3 };
        return json(200, {
          session_id: s.view.session_id,
          status: "completed",
          minutes: 3,
          reviewed: 2,
          correct: 2,
          again: 0,
          new_learned: 1,
          checks: [{ skill_title: L("Вежливая просьба"), stage: "d7", passed: true, skill_retained: false, check_id: "chk-1" }],
          next_due_at: "2026-11-23T09:00:00Z",
          due_tomorrow: 1,
          user_id: s.owner,
        });
      }
      const taskId = sm[3];
      if (taskId && r.method === "POST") {
        const t = s.tasks.find((x) => x.task.task_id === taskId);
        if (!t) return err(404, "TASK_NOT_FOUND");
        if (sm[4]) {
          if (t.key.check) return err(409, "HINTS_NOT_ALLOWED");
          if (t !== current) return err(409, "TASK_NOT_CURRENT", { current_task_id: current?.task.task_id ?? null });
          const kind = (r.body as { kind: "first_letter" | "reveal" }).kind;
          t.task.hints_used.push(kind);
          return json(200, { kind, text: kind === "first_letter" ? "t…" : (t.key.answer ?? "кофе") });
        }
        if (t.done) return json(200, t.done);
        if (t !== current) return err(409, "TASK_NOT_CURRENT", { current_task_id: current?.task.task_id ?? null });
        const b = (r.body ?? {}) as C.ReviewAnswer;
        let result: C.ReviewTaskResult["result"] = null;
        let correctAnswer: string | null = null;
        let checkResult: C.ReviewTaskResult["check_result"] = null;
        if (t.task.type === "meaning_choice") {
          result = b.choice === t.key.correct ? "correct" : "incorrect";
          correctAnswer = t.task.options[t.key.correct!]!;
        } else if (t.task.type === "typed") {
          const given = (b.text ?? "").trim().toLowerCase();
          result = given === t.key.answer ? "correct" : given === "take awey" ? "almost" : "incorrect";
          correctAnswer = t.key.answer!;
        } else if (t.key.check) {
          if (b.choice === t.key.correct) s.checkCorrect += 1;
          if (this.leakCheckAnswer) {
            result = "correct";
            correctAnswer = "have";
          }
          if (t.task.check?.position === t.task.check?.of) {
            const checks = s.tasks.filter((x) => x.key.check);
            checkResult = {
              passed: s.checkCorrect >= 1,
              correct: s.checkCorrect,
              total: checks.length,
              items: checks.map((x) => ({ prompt_en: x.task.prompt.prompt_en!, your_answer: "have", correct_answer: "have", correct: true })),
            };
            result = "correct";
          }
        }
        s.cursor += 1;
        const next = s.tasks[s.cursor] ?? null;
        t.done = {
          result,
          correct_answer: correctAnswer,
          next_review_in_days: t.task.type === "intro" || t.key.check ? null : 3,
          requeued: result === "incorrect",
          check_result: checkResult,
          next: next ? (this.taskOut(next) as unknown as C.ReviewTask) : null,
          grade: result === "correct" ? "good" : "again", // служебное — BFF отбрасывает
        };
        return json(200, t.done);
      }
    }
    return err(404, "NOT_FOUND");
  }

  private pronunciation(r: Req, l: Learner): Response {
    if (!(r.headers["content-type"] ?? "").startsWith("audio/wav") || !r.rawBody?.length) return err(422, "AUDIO_INVALID", { reason: "format" });
    if (!["card", "sentence"].includes(r.query.target_kind ?? "") || !r.query.target) return err(422, "VALIDATION_ERROR");
    this.lastAudio = r.rawBody;
    if (!this.voiceConsent.has(l.lrn)) return err(403, "VOICE_CONSENT_REQUIRED", { who: l.kids || l.band === "14-17" ? "guardian" : "self" });
    if (!this.speechAvailable) return err(503, "SPEECH_UNAVAILABLE");
    let reference = "Can I have a coffee, please?";
    if (r.query.target_kind === "card") {
      const c = this.cards.get(r.query.target);
      if (!c || c.owner !== l.lrn) return err(404, "CARD_NOT_FOUND");
      reference = c.card.text_en;
    }
    const words = reference.split(" ").map((w, i) => ({ word: w, accuracy: i === 0 ? 55 : 92, error_type: i === 0 ? "mispronunciation" : "none" }));
    switch (this.pronunciationMode) {
      case "insufficient":
        return json(200, { attempt_id: randomUUID(), status: "insufficient_evidence", reason: "low_confidence", reference_text: reference, scores: null, words: [], intelligibility: null, tips: [], confidence: 0.2, audio_ms: 1000, provider: "fake_speech", cost_usd: 0, latency_ms: 3 });
      case "unavailable":
        return json(200, { attempt_id: randomUUID(), status: "unavailable", reason: "budget_exceeded", reference_text: reference, scores: null, words: [], intelligibility: null, tips: [], confidence: null, audio_ms: 1000, provider: null, cost_usd: 0, latency_ms: 1 });
      case "view":
        return json(200, { attempt_id: randomUUID(), status: "ok", reference_text: reference, intelligibility: "mostly_clear", score: 71, words, tips: [{ word: words[0]!.word, text: "Послушайте образец" }], message: null });
      default:
        return json(200, {
          attempt_id: randomUUID(),
          status: "ok",
          reason: null,
          reference_text: reference,
          scores: { accuracy: 86, fluency: 90, completeness: 100, pron: 88 },
          words,
          intelligibility: null,
          tips: [{ word: words[0]!.word, text: "Слово прозвучало неразборчиво" }, { word: "x", text: "второй" }, { word: "y", text: "третий — лишний" }],
          confidence: 0.93,
          audio_ms: 1000,
          provider: "fake_speech",
          cost_usd: 0,
          latency_ms: 4,
          user_id: l.lrn,
        });
    }
  }
}

// =====================================================================================================================
// Чтение: catalog (тексты) и lessons (сессия kind reading, результаты)
// =====================================================================================================================

interface ReadingFixture {
  reading_id: string;
  version: number;
  title: { ru: string; uz: string };
  level: "A0" | "A1" | "A2" | "B1" | "B2";
  audience: Array<"kids" | "teens" | "adults">;
  topics: string[];
  est_minutes: number;
  glossary: Array<{ en: string; gloss: { ru: string; uz: string }; note: { ru: string; uz: string } | null }>;
}

export const READINGS: ReadingFixture[] = [
  {
    reading_id: "r-a1-coffee-shop",
    version: 2,
    title: L("В кофейне"),
    level: "A1",
    audience: ["teens", "adults"],
    topics: ["food"],
    est_minutes: 5,
    glossary: [
      { en: "coffee", gloss: L("кофе"), note: null },
      { en: "take away", gloss: L("с собой"), note: L("фразовый глагол") },
      { en: "receipt", gloss: L("чек"), note: null },
    ],
  },
  {
    reading_id: "r-a0-zoo",
    version: 1,
    title: L("В зоопарке"),
    level: "A0",
    audience: ["kids"],
    topics: ["hobbies"],
    est_minutes: 3,
    glossary: [{ en: "lion", gloss: L("лев"), note: null }],
  },
  {
    reading_id: "r-a2-office",
    version: 1,
    title: L("В офисе"),
    level: "A2",
    audience: ["adults"],
    topics: ["work"],
    est_minutes: 7,
    glossary: [{ en: "meeting", gloss: L("встреча"), note: null }],
  },
];

const paragraphsOf = (r: ReadingFixture) => [
  { p_id: "p1", sentences: [{ s_id: "s1", text_en: `Welcome to the ${r.reading_id}.`, gloss: L("Добро пожаловать") }, { s_id: "s2", text_en: `I'd like a ${r.glossary[0]!.en}.`, gloss: L("Я бы хотел") }] },
];

interface ReadingSess {
  owner: string;
  view: C.LessonSession;
  reading: ReadingFixture;
  cursor: number;
}

export class FakeReading {
  readonly sessions = new Map<string, ReadingSess>();
  readonly idem = new Map<string, string>();
  /** последние результаты: `${lrn}:${reading_id}` → результат */
  readonly results = new Map<string, { correct: number; total: number; finished_at: string }>();
  resultsDown = false;

  private audienceOf(r: Req): "kids" | "teens" | "adults" | undefined {
    const child = (typeof r.claims.lrn === "string" && r.claims.lrn !== r.subject) || KID_BANDS.has(String(r.claims.age_band));
    return (child ? "kids" : r.query.audience) as "kids" | "teens" | "adults" | undefined;
  }

  private card(x: ReadingFixture) {
    return { reading_id: x.reading_id, version: x.version, title: x.title, level: x.level, topics: x.topics, est_minutes: x.est_minutes, word_count: 80, internal_note: MEM_SECRET };
  }

  private view(x: ReadingFixture, glossaryInDict: boolean): Record<string, unknown> {
    return {
      reading_id: x.reading_id,
      version: x.version,
      title: x.title,
      level: x.level,
      voice: "en-GB",
      paragraphs: paragraphsOf(x),
      glossary: x.glossary.map((g) => ({ ...g, ...(glossaryInDict ? { in_dictionary: null } : {}) })),
      questions_count: 2,
      question_types: ["true_false", "gap_fill"],
      est_minutes: x.est_minutes,
    };
  }

  /** catalog: тексты для чтения; не наш путь — null (дальше FakeContent). */
  catalog(r: Req): Response | null {
    if (r.method !== "GET" || !r.path.startsWith("/internal/v1/readings")) return null;
    const audience = this.audienceOf(r);
    if (!audience) return err(422, "VALIDATION_ERROR", { field: "audience" });
    const fits = (x: ReadingFixture) => (audience === "kids" ? x.audience.join() === "kids" : x.audience.includes(audience));
    if (r.path === "/internal/v1/readings") {
      const items = READINGS.filter(fits).filter((x) => !r.query.level || x.level === r.query.level).map((x) => this.card(x));
      return json(200, { items, next_cursor: null });
    }
    const m = /^\/internal\/v1\/readings\/([^/]+)$/.exec(r.path);
    const x = m ? READINGS.find((y) => y.reading_id === m[1]) : undefined;
    if (!x || !fits(x)) return err(404, "READING_NOT_AVAILABLE");
    return json(200, {
      ...this.view(x, false),
      skill_ids: ["en.read.a1"],
      // вопросы домена (без answer у настоящего catalog) — BFF их не отдаёт вовсе
      questions: [{ question_id: "q1", type: "true_false", instruction: L("Верно?"), prompt_en: `${MEM_SECRET} question`, options: ["True", "False"] }],
    });
  }

  /** lessons: старт чтения, шаги своих сессий, результаты; иначе null (дальше FakeLessons). */
  lessons(r: Req): Response | null {
    const isOurs = r.path === "/internal/v1/reading-results" || /^\/internal\/v1\/readings\/[^/]+\/sessions$/.test(r.path);
    const sm = /^\/internal\/v1\/sessions\/([^/]+)\/(current|steps\/(s\d+))$/.exec(r.path);
    if (!isOurs && !(sm && this.sessions.has(sm[1]!))) return null;
    const l = learnerOf(r);
    if (l instanceof Response) return l;
    if (r.path === "/internal/v1/reading-results" && r.method === "GET") {
      if (this.resultsDown) return err(503, "UPSTREAM_DOWN");
      const ids = (r.query.ids ?? "").split(",").filter(Boolean);
      if (ids.length > 50) return err(422, "VALIDATION_ERROR");
      return json(200, {
        items: ids.flatMap((id) => {
          const res = this.results.get(`${l.lrn}:${id}`);
          return res ? [{ reading_id: id, ...res, session_id: randomUUID() }] : [];
        }),
      });
    }
    const start = /^\/internal\/v1\/readings\/([^/]+)\/sessions$/.exec(r.path);
    if (start && r.method === "POST") {
      const idem = r.headers["idempotency-key"];
      if (!idem) return err(422, "IDEMPOTENCY_KEY_REQUIRED");
      const prev = this.idem.get(`${l.lrn}:${idem}`);
      if (prev) return json(201, { ...this.sessions.get(prev)!.view, account_id: r.subject });
      const x = READINGS.find((y) => y.reading_id === start[1]);
      const audience = l.kids ? "kids" : (r.query.audience as string);
      if (!x || (audience === "kids" ? x.audience.join() !== "kids" : !x.audience.includes(audience as "adults"))) return err(404, "READING_NOT_AVAILABLE");
      const active = [...this.sessions.values()].find((s) => s.owner === l.lrn && s.view.status !== "completed");
      if (active) return err(409, "SESSION_ACTIVE", { session_id: active.view.session_id, kind: "reading", title: active.view.title });
      const id = randomUUID();
      const view: C.LessonSession = {
        session_id: id,
        kind: "reading",
        title: x.title,
        lesson_id: null,
        scenario_id: null,
        asset_id: null,
        status: "ready",
        stage: null,
        stages: [
          { type: "reading", status: "pending" },
          { type: "questions", status: "pending" },
          { type: "summary", status: "pending" },
        ],
        ai_mode: "full",
        ai_degraded: false,
        started_at: null,
        paused_at: null,
        finished_at: null,
        expires_at: null,
        minutes: 0,
      };
      this.sessions.set(id, { owner: l.lrn, view, reading: x, cursor: 0 });
      this.idem.set(`${l.lrn}:${idem}`, id);
      return json(201, { ...view, account_id: r.subject, content_versions: { reading: x.version } });
    }
    const s = this.sessions.get(sm![1]!)!;
    if (s.owner !== l.lrn) return err(404, "SESSION_NOT_FOUND");
    const steps = [
      { step_id: "s1", stage: "reading", position: 1, stage_total: 1, type: "reading", reading: this.view(s.reading, true) },
      {
        step_id: "s2",
        stage: "questions",
        position: 1,
        stage_total: 1,
        type: "item",
        item: { item_id: "q1", item_type: "single_choice", instruction: L("Верно ли?"), prompt_en: "The cafe is open.", options: ["True", "False"], answer: 0, secret: MEM_SECRET },
        hint_available: false,
        hints_used: 0,
        graded_later: true,
      },
      { step_id: "s3", stage: "questions", position: 1, stage_total: 1, type: "done" },
    ];
    if (sm![2] === "current") return json(200, steps[s.cursor]);
    const stepId = sm![3]!;
    if (stepId !== steps[s.cursor]!.step_id) return err(409, "STEP_NOT_CURRENT", { current_step_id: steps[s.cursor]!.step_id });
    s.cursor = Math.min(s.cursor + 1, steps.length - 1);
    return json(200, { accepted: true, feedback: null, reply: null, next: steps[s.cursor] });
  }
}
