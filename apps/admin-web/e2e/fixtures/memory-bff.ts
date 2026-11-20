/**
 * Sprint 5 part of the mock admin-bff: the course dictionary (catalog `/glossary*`: list with filters, the AI queue
 * sorted by places in the content, card with history, methodist entry → 409 FORM_TAKEN {entry_id, form}, PATCH with
 * If-Match → 428 IF_MATCH_REQUIRED / 409 VERSION_CONFLICT {updated_at}, course entries — override only (409
 * COURSE_ENTRY_LOCKED / OVERRIDE_COURSE_ONLY), review approve / correct / reject → 409 NOT_PENDING, archive of a
 * methodist entry only → 409 ARCHIVE_NOT_ALLOWED) and memory (`/memory/*`: a learner's summary and cards, the card
 * with the scheduling history and its next pages, manual actions with step-up → 409 CARD_STATE / 422 DUE_AT_RANGE, the
 * forgetting analytics, the overview stats). Permissions as admin.ts: content.read / glossary.manage (no step-up);
 * memory.read / memory.manage (step-up); analytics memory.read | dashboard.read; stats dashboard.read.
 */
import type { AdminCardRow, CardAction, GlossaryDetail, GlossaryRow, GlossaryStats, LearnerMemorySummary, MemoryStats, Period, Permission, ReviewLogRow } from "@tilhero/contracts/admin";
import type { Ctx } from "./content-bff";
import { DAY, iso, LEARNER } from "./data";
import * as M from "./memory-data";

type P = Record<string, unknown>;

export interface MemoryScenario {
  /** memory/stats fails: the overview block is unavailable, the rest of the overview works */
  statsDown?: boolean;
  /** catalog did not answer the AI queue: MemoryStats.ai_glosses_pending = null */
  glossesUnknown?: boolean;
  /** the analytics of memory answers 503 */
  analyticsDown?: boolean;
}

const CYR = /[Ѐ-ӿ]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const norm = (s: string) => s.trim().toLowerCase().replace(/[.!?…,;:]+$/g, "").replace(/\s+/g, " ");
const LOG_PAGE = 3;

export class MemoryStore {
  entries: M.MockEntry[] = M.glossary();
  cards: M.MockCard[] = M.cards();
  /** audit actions of this part (the shared audit log gets them too) */
  readonly audit: Array<{ action: string; id: string; reason: string | null }> = [];
  private seq = 0;

  constructor(private readonly sc: MemoryScenario = {}) {}

  /** e2e helper: another methodist saved the entry in between (updated_at moves on) */
  touchEntry(id: string): void {
    const e = this.entries.find((x) => x.entry_id === id);
    if (e) {
      e.gloss = { ...e.gloss, ru: `${e.gloss.ru} (правка коллеги)` };
      e.updated_at = this.stamp();
    }
  }

  entry(id: string): M.MockEntry | undefined {
    return this.entries.find((x) => x.entry_id === id);
  }

  card(id: string): M.MockCard | undefined {
    return this.cards.find((x) => x.card_id === id);
  }

  pendingCount(): number {
    return this.entries.filter((e) => !e.archived_at && e.source === "ai" && e.review_status === "pending").length;
  }

  stats(period: Period): MemoryStats {
    const m = period === "today" ? 1 : period === "7d" ? 7 : 30;
    return {
      period,
      review_sessions: 84 * m,
      learners_reviewing: 61 * m,
      median_minutes: 6,
      d30_pass_pct: 78.9,
      avg_due_per_learner: 11.4,
      ai_glosses_pending: this.sc.glossesUnknown ? null : this.pendingCount(),
    };
  }

  /** a fresh updated_at — strictly after the previous one even within one millisecond */
  private stamp(): string {
    return new Date(Date.now() + ++this.seq).toISOString();
  }

  private nameOf: (id: string | null | undefined) => string | null = () => null;

  private detail(e: M.MockEntry): GlossaryDetail {
    const name = (id: string | null) => (id === M.SEED_ID ? "Сид (начальное наполнение)" : this.nameOf(id));
    return { ...e, updated_by_name: name(e.updated_by), history: e.history.map((h) => ({ ...h, by_name: h.by_name ?? name(h.by) })) };
  }

  private row(e: M.MockEntry): GlossaryRow {
    return {
      entry_id: e.entry_id,
      pair_id: e.pair_id,
      lemma: e.lemma,
      forms: e.forms,
      part_of_speech: e.part_of_speech,
      gloss: e.gloss,
      source: e.source,
      review_status: e.review_status,
      confidence: e.confidence,
      refs_count: e.refs.length,
      overridden: !!e.override,
      updated_at: e.updated_at,
      updated_by: e.updated_by,
      updated_by_name: e.updated_by === M.SEED_ID ? "Сид (начальное наполнение)" : this.nameOf(e.updated_by),
    };
  }

  private glossaryStats(pair: string | null): GlossaryStats {
    const live = this.entries.filter((e) => !e.archived_at && (!pair || e.pair_id === pair));
    return {
      pair_id: pair,
      ai_glosses_pending: live.filter((e) => e.source === "ai" && e.review_status === "pending").length,
      ai_approved: live.filter((e) => e.source === "ai" && e.review_status === "approved").length,
      ai_rejected: live.filter((e) => e.source === "ai" && e.review_status === "rejected").length,
      entries: { course: live.filter((e) => e.source === "course").length, methodist: live.filter((e) => e.source === "methodist").length, ai: live.filter((e) => e.source === "ai").length },
      overridden: live.filter((e) => !!e.override).length,
    };
  }

  private summary(user: string): LearnerMemorySummary | null {
    const cs = this.cards.filter((c) => c.user_id === user);
    if (!cs.length) return null;
    const by = { new: 0, learning: 0, review: 0, known: 0, frozen: 0, archived: 0 };
    for (const c of cs) by[c.status] += 1;
    const now = Date.now();
    const due = cs.filter((c) => (c.status === "learning" || c.status === "review" || c.status === "new") && c.due_at && Date.parse(c.due_at) <= now);
    return {
      user_id: user,
      pair_id: "ru-en",
      cards_by_status: by,
      due_now: due.length,
      overdue_7d: cs.filter((c) => (c.status === "learning" || c.status === "review") && c.due_at && Date.parse(c.due_at) < now - 7 * DAY).length,
      reviews_30d: user === LEARNER.madina ? 46 : 9,
      last_review_at: user === LEARNER.madina ? iso(-1 * DAY) : iso(-3 * DAY),
      checks: M.checks(user),
    };
  }

  private cardRow(c: M.MockCard): AdminCardRow {
    const { user_id: _u, example_en: _e, sources: _s, log: _l, ...row } = c;
    void [_u, _e, _s, _l];
    return row;
  }

  private cardDetail(c: M.MockCard) {
    const page = c.log.slice(0, LOG_PAGE);
    return { ...c, log: { items: page, next_cursor: c.log.length > LOG_PAGE ? `log:${LOG_PAGE}` : null } };
  }

  /** answers a /glossary or /memory route; false — not ours */
  async handle(method: string, path: string, body: P, q: URLSearchParams, headers: Record<string, string>, x: Ctx): Promise<boolean> {
    if (!/^\/(glossary|memory)(\/|$)/.test(path)) return false;
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
    const done = (st: number, data?: unknown) => x.json(st, data).then(() => true);
    const fail = (st: number, code: string, details: Record<string, unknown> = {}) => x.err(st, code, details).then(() => true);
    const audit = (action: string, type: string, id: string, reason: string | null = null, after: Record<string, unknown> | null = null) => {
      this.audit.push({ action, id, reason });
      x.record(action, type, id, after, reason);
    };
    const key = `${method} ${path}`;
    let m: RegExpMatchArray | null;

    /* ---------- course dictionary (catalog) ---------- */
    if (key === "GET /glossary") {
      if (!(await need("content.read"))) return true;
      const pair = q.get("pair_id");
      const qs = (q.get("q") ?? "").toLowerCase();
      const src = q.get("source");
      const st = q.get("review_status");
      let items = this.entries.filter(
        (e) =>
          !e.archived_at &&
          (!pair || e.pair_id === pair) &&
          (!src || e.source === src) &&
          (!st || e.review_status === st) &&
          (!qs || e.lemma.toLowerCase().includes(qs) || e.forms.some((f) => f.includes(qs)) || e.gloss.ru.toLowerCase().includes(qs) || e.gloss.uz.toLowerCase().includes(qs)),
      );
      items = st === "pending" ? items.sort((a, b) => b.refs.length - a.refs.length || a.lemma.localeCompare(b.lemma)) : items.sort((a, b) => a.lemma.localeCompare(b.lemma));
      return done(200, { items: items.map((e) => this.row(e)), next_cursor: null });
    }
    if (key === "GET /glossary/stats") return (await need(["dashboard.read", "content.read"])) ? done(200, this.glossaryStats(q.get("pair_id"))) : true;
    if (key === "POST /glossary") {
      if (!(await need("glossary.manage"))) return true;
      const forms = (Array.isArray(body.forms) ? body.forms : []).map((f) => norm(String(f))).filter(Boolean);
      const gloss = body.gloss as { ru?: string; uz?: string } | undefined;
      const errors: Array<{ path: string; code: string; message: string }> = [];
      if (!String(body.lemma ?? "").trim()) errors.push({ path: "lemma", code: "VALUE_REQUIRED", message: "Укажите слово" });
      if (!forms.length) errors.push({ path: "forms[0]", code: "VALUE_REQUIRED", message: "Форма — слово или выражение (EN)" });
      if (CYR.test(String(gloss?.uz ?? ""))) errors.push({ path: "gloss.uz", code: "LOCALE_SCRIPT", message: "Узбекский текст — только латиницей" });
      if (errors.length) return fail(422, "GLOSSARY_INVALID", { errors });
      for (const f of forms) {
        const holder = this.entries.find((e) => !e.archived_at && e.pair_id === body.pair_id && e.forms.includes(f) && !(e.source === "ai" && e.review_status === "rejected"));
        if (holder) return fail(409, "FORM_TAKEN", { entry_id: holder.entry_id, form: f });
      }
      const at = this.stamp();
      const e: M.MockEntry = {
        entry_id: `62000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
        pair_id: String(body.pair_id),
        lemma: String(body.lemma).trim(),
        forms,
        part_of_speech: (body.part_of_speech ?? null) as M.MockEntry["part_of_speech"],
        gloss: { ru: String(gloss?.ru ?? ""), uz: String(gloss?.uz ?? "") },
        example_en: (body.example_en ?? null) as string | null,
        source: "methodist",
        review_status: "not_required",
        confidence: null,
        agent_version: null,
        refs: [],
        override: null,
        corrected: false,
        archived_at: null,
        updated_by: x.me.staff_id,
        updated_at: at,
        refs_titles: [],
        conflicts: [],
        history: [{ at, by: x.me.staff_id, by_name: null, action: "created", before: null, after: { lemma: String(body.lemma), forms, gloss: { ru: String(gloss?.ru), uz: String(gloss?.uz) }, source: "methodist" }, reason: (body.reason ?? null) as string | null }],
      };
      this.entries.push(e);
      audit("glossary.entry_created", "glossary_entry", e.entry_id, (body.reason ?? null) as string | null, { forms });
      return done(201, this.detail(e));
    }
    if ((m = path.match(/^\/glossary\/([^/]+)(\/review)?$/))) {
      const id = m[1]!;
      const e = this.entry(id);
      if (method === "GET" && !m[2]) {
        if (!(await need("content.read"))) return true;
        return e ? done(200, this.detail(e)) : fail(404, "GLOSSARY_ENTRY_NOT_FOUND");
      }
      if (!(await need("glossary.manage"))) return true;
      if (!e) return fail(404, "GLOSSARY_ENTRY_NOT_FOUND");
      if (method === "PATCH" && !m[2]) {
        const ifm = headers["if-match"];
        if (!ifm) return fail(428, "IF_MATCH_REQUIRED");
        if (e.archived_at) return fail(409, "ENTRY_ARCHIVED");
        if (ifm.replace(/^W\//, "").replace(/"/g, "") !== e.updated_at) return fail(409, "VERSION_CONFLICT", { updated_at: e.updated_at });
        const fields = Object.keys(body).filter((k) => k !== "reason");
        if (e.source === "course" && fields.some((k) => k !== "override")) return fail(409, "COURSE_ENTRY_LOCKED");
        if (e.source !== "course" && fields.includes("override")) return fail(409, "OVERRIDE_COURSE_ONLY");
        const g = (body.gloss ?? (body.override as { gloss?: { uz?: string } } | null)?.gloss) as { uz?: string } | undefined;
        if (g && CYR.test(String(g.uz ?? ""))) return fail(422, "GLOSSARY_INVALID", { errors: [{ path: body.gloss ? "gloss.uz" : "override.gloss.uz", code: "LOCALE_SCRIPT", message: "Узбекский текст — только латиницей" }] });
        const at = this.stamp();
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        if ("override" in body) {
          const ov = body.override as { gloss: { ru: string; uz: string }; example_en: string | null } | null;
          before.gloss = e.gloss;
          if (ov) {
            e.override = { gloss: ov.gloss, example_en: ov.example_en, by: x.me.staff_id, at };
            e.gloss = ov.gloss;
            e.example_en = ov.example_en;
          } else {
            e.override = null;
          }
          after.gloss = e.gloss;
        }
        if (Array.isArray(body.forms)) {
          const forms = (body.forms as string[]).map(norm).filter(Boolean);
          for (const f of forms) {
            const holder = this.entries.find((y) => y !== e && !y.archived_at && y.pair_id === e.pair_id && y.forms.includes(f));
            if (holder) return fail(409, "FORM_TAKEN", { entry_id: holder.entry_id, form: f });
          }
          before.forms = e.forms;
          e.forms = forms;
          after.forms = forms;
        }
        for (const k of ["lemma", "part_of_speech", "gloss", "example_en"] as const) {
          if (k in body) {
            before[k] = e[k];
            (e as Record<string, unknown>)[k] = body[k];
            after[k] = body[k];
          }
        }
        e.updated_at = at;
        e.updated_by = x.me.staff_id;
        e.history.unshift({ at, by: x.me.staff_id, by_name: null, action: "override" in body ? "overridden" : "updated", before, after, reason: (body.reason ?? null) as string | null });
        audit("glossary.entry_updated", "glossary_entry", e.entry_id, (body.reason ?? null) as string | null);
        return done(200, this.detail(e));
      }
      if (method === "POST" && m[2]) {
        if (e.source !== "ai" || e.review_status !== "pending" || e.archived_at) return fail(409, "NOT_PENDING");
        const decision = String(body.decision);
        const at = this.stamp();
        const before = { gloss: e.gloss, review_status: e.review_status };
        if (decision === "correct") {
          const g = body.gloss as { ru?: string; uz?: string } | undefined;
          if (!g?.ru?.trim() || !g?.uz?.trim()) return fail(422, "VALIDATION_ERROR", { in: "body", field: "gloss", errors: [] });
          if (CYR.test(g.uz)) return fail(422, "GLOSSARY_INVALID", { errors: [{ path: "gloss.uz", code: "LOCALE_SCRIPT", message: "Узбекский текст — только латиницей" }] });
          e.gloss = { ru: g.ru, uz: g.uz };
          e.corrected = true;
          e.review_status = "approved";
        } else if (decision === "approve") e.review_status = "approved";
        else if (decision === "reject") e.review_status = "rejected";
        else return fail(422, "VALIDATION_ERROR", { in: "body", field: "decision", errors: [] });
        e.updated_at = at;
        e.updated_by = x.me.staff_id;
        e.history.unshift({ at, by: x.me.staff_id, by_name: null, action: "reviewed", before, after: { gloss: e.gloss, review_status: e.review_status }, reason: (body.note ?? null) as string | null });
        audit("glossary.entry_reviewed", "glossary_entry", e.entry_id, (body.note ?? null) as string | null, { decision });
        return done(200, this.detail(e));
      }
      if (method === "DELETE" && !m[2]) {
        if (e.source !== "methodist") return fail(409, "ARCHIVE_NOT_ALLOWED", { source: e.source });
        if (e.archived_at) return fail(409, "ENTRY_ARCHIVED");
        const reason = String(body.reason ?? "").trim();
        if (reason.length < 3) return fail(422, "VALIDATION_ERROR", { in: "body", field: "reason", errors: [] });
        e.archived_at = this.stamp();
        e.history.unshift({ at: e.archived_at, by: x.me.staff_id, by_name: null, action: "archived", before: null, after: null, reason });
        audit("glossary.entry_archived", "glossary_entry", e.entry_id, reason);
        return x.json(204).then(() => true);
      }
      return fail(404, "NOT_FOUND", { path });
    }

    /* ---------- memory ---------- */
    if (key === "GET /memory/analytics") {
      if (!(await need(["memory.read", "dashboard.read"]))) return true;
      if (this.sc.analyticsDown) return fail(503, "UPSTREAM_UNAVAILABLE", { service: "memory" });
      const p = q.get("period") ?? "30d";
      return p === "30d" || p === "90d" ? done(200, M.analytics(p)) : fail(422, "VALIDATION_ERROR", { in: "query", field: "period", errors: [] });
    }
    if (key === "GET /memory/stats") {
      if (!(await need("dashboard.read"))) return true;
      if (this.sc.statsDown) return fail(503, "UPSTREAM_UNAVAILABLE", { service: "memory" });
      return done(200, this.stats((q.get("period") as Period) ?? "today"));
    }
    if ((m = path.match(/^\/memory\/learners\/([^/]+)(\/cards)?$/)) && method === "GET") {
      if (!(await need("memory.read"))) return true;
      const user = m[1]!.toLowerCase();
      if (!UUID.test(user)) return fail(422, "VALIDATION_ERROR", { in: "params", field: "userId", errors: [] });
      const s = this.summary(user);
      if (!s) return fail(404, "MEMORY_LEARNER_NOT_FOUND");
      if (!m[2]) return done(200, s);
      const st = q.get("status");
      const kd = q.get("kind");
      const items = this.cards.filter((c) => c.user_id === user && (!st || c.status === st) && (!kd || c.kind === kd)).map((c) => this.cardRow(c));
      return done(200, { items, next_cursor: null });
    }
    if ((m = path.match(/^\/memory\/cards\/([^/]+)(\/log|\/actions)?$/))) {
      const c = this.card(m[1]!.toLowerCase());
      if (method === "GET" && !m[2]) {
        if (!(await need("memory.read"))) return true;
        return c ? done(200, this.cardDetail(c)) : fail(404, "CARD_NOT_FOUND");
      }
      if (method === "GET" && m[2] === "/log") {
        if (!(await need("memory.read"))) return true;
        if (!c) return fail(404, "CARD_NOT_FOUND");
        const from = Number(String(q.get("cursor") ?? "log:0").slice(4)) || 0;
        const items = c.log.slice(from, from + LOG_PAGE);
        return done(200, { items, next_cursor: from + LOG_PAGE < c.log.length ? `log:${from + LOG_PAGE}` : null });
      }
      if (method === "POST" && m[2] === "/actions") {
        if (!(await need("memory.manage", true))) return true;
        if (!c) return fail(404, "CARD_NOT_FOUND");
        const a = body as unknown as CardAction & { due_at?: string };
        const reason = String(a.reason ?? "").trim();
        if (reason.length < 10 || reason.length > 300) return fail(422, "VALIDATION_ERROR", { in: "body", field: "reason", errors: [] });
        if (c.status === "archived") return fail(409, "CARD_STATE", { status: c.status });
        if (a.action === "unfreeze" && c.status !== "frozen") return fail(409, "CARD_STATE", { status: c.status });
        if (a.action === "freeze" && c.status === "frozen") return fail(409, "CARD_STATE", { status: c.status });
        const before = { state: (c.status === "new" ? "new" : c.status === "review" ? "review" : "learning") as ReviewLogRow["before"]["state"], stability: c.stability, difficulty: c.difficulty, due_at: c.due_at, status: c.status };
        if (a.action === "reschedule") {
          const due = Date.parse(String(a.due_at ?? ""));
          const days = (due - Date.now()) / DAY;
          if (!Number.isFinite(due) || days < 1 - 1 / 1440 || days > 365 + 1 / 1440) return fail(422, "DUE_AT_RANGE");
          c.due_at = new Date(due).toISOString();
        } else if (a.action === "reset") Object.assign(c, { status: "new", stability: null, difficulty: null, retrievability: null, reps: 0, lapses: 0, due_at: iso(0) });
        else if (a.action === "freeze") c.status = "frozen";
        else if (a.action === "unfreeze") c.status = (c.stability ?? 0) >= 1 ? "review" : "learning";
        else return fail(422, "VALIDATION_ERROR", { in: "body", field: "action", errors: [] });
        const after = { state: (c.status === "new" ? "new" : c.status === "review" ? "review" : "learning") as ReviewLogRow["after"]["state"], stability: c.stability, difficulty: c.difficulty, due_at: c.due_at, status: c.status };
        c.log.unshift({ log_id: `1a000000-0000-4000-8000-${String(900 + ++this.seq).padStart(12, "0")}`, at: iso(0), task_type: "manual", answer_mode: "manual", grade: null, hinted: false, revealed: false, elapsed_days: null, before, after, algorithm: "fsrs-5", params_version: "fsrs5-default-1", actor: "staff", actor_id: x.me.staff_id, actor_name: x.me.display_name, reason });
        audit("memory.card_adjusted", "memory_card", c.card_id, reason, { action: a.action, user_id: c.user_id });
        return done(200, this.cardDetail(c));
      }
      return fail(404, "NOT_FOUND", { path });
    }
    await x.err(404, "NOT_FOUND", { path });
    return true;
  }
}
