/**
 * Content part of the mock admin-bff (sprint 3): catalog versions and their life cycle (admin.ts «Контент и
 * диагностика»), the scenario test run (port of services/catalog domain/scenario_test.py), rights approval, audio
 * blobs, learners' requests, languages and pairs (PAIR_NOT_READY), diagnostic tests. Permissions and step-up as
 * admin-bff + catalog: content.read / edit / review (not own: 409 SELF_REVIEW) / publish (step-up), media.rights
 * (step-up for rights and decisions; also the only right that reads the requests register), lang.manage (step-up).
 */
import type { AdminMediaRequest, ContentRow, ContentSummary, ContentVersion, ContentVersionMeta, DiagnosticTestRow, PairCard, Permission, Staff } from "@tilhero/contracts/admin";
import type { ContentKind, Language, LocaleCheck, ScenarioPayload, ScenarioTestRun, VersionStatus } from "@tilhero/contracts/content";
import { DAY, HOUR, ID, iso } from "./data";
import * as C from "./content-data";

type P = Record<string, unknown>;
interface Ver extends ContentVersion<P> {
  editors: string[];
  run: (ScenarioTestRun & { hash: string }) | null;
}

const KEY_FIELD: Record<ContentKind, string> = { course: "course_id", skill: "skill_id", module: "module_id", lesson: "lesson_id", rubric: "rubric_id", scenario: "scenario_id", media_asset: "asset_id", media_exercise: "exercise_id" };
const KINDS = Object.keys(KEY_FIELD) as ContentKind[];
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export function hash(v: unknown): string {
  const s = JSON.stringify(v);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i), 2654435761) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(4);
}

export interface Ctx {
  me: Staff;
  perms: Set<Permission>;
  stepUpOk: () => boolean;
  nameOf: (id: string | null | undefined) => string | null;
  record: (action: string, type: string, id: string, after: Record<string, unknown> | null, reason?: string | null) => void;
  json: (status: number, data?: unknown, headers?: Record<string, string>) => Promise<void>;
  err: (status: number, code: string, details?: Record<string, unknown>) => Promise<void>;
  binary: (status: number, body: Buffer, contentType: string) => Promise<void>;
}

/* ---------------------------------------------------------------- validation (subset of catalog validation.py) */

interface Iss {
  path: string;
  code: string;
  message: string;
}

function localized(v: unknown, p: string, out: Iss[]) {
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 2 && "ru" in v && "uz" in v) {
    for (const l of ["ru", "uz"] as const) if (!String((v as P)[l] ?? "").trim()) out.push({ path: `${p}.${l}`, code: "LOCALE_MISSING", message: `Пустой текст на ${l.toUpperCase()}` });
    if (/[Ѐ-ӿ]/.test(String((v as P).uz))) out.push({ path: `${p}.uz`, code: "LOCALE_SCRIPT", message: "Узбекский текст — только латиницей" });
    return;
  }
  if (Array.isArray(v)) v.forEach((x, i) => localized(x, `${p}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) localized(x, `${p}.${k}`, out);
}

export function testRun(p: ScenarioPayload, checked_at: string): ScenarioTestRun {
  const nodes = p.nodes ?? {};
  const ids = Object.keys(nodes).sort();
  const issues: ScenarioTestRun["issues"] = [];
  const add = (code: ScenarioTestRun["issues"][number]["code"], node_id: string | null, detail: string) => issues.push({ code, node_id, detail });
  const speakers = new Set(p.characters.map((c) => c.id));
  if (ids.length > 30) add("TOO_MANY_NODES", null, `Узлов ${ids.length}`);
  for (const id of ids) {
    const n = nodes[id]!;
    if (!speakers.has(n.speaker)) add("UNKNOWN_SPEAKER", id, "Неизвестный персонаж");
    if (!n.end) {
      n.transitions.forEach((t, i) => !(t.to in nodes) && add("UNKNOWN_NODE", id, `Переход ${i} ведёт в несуществующий узел`));
      if (!n.transitions.length) add("DEAD_END", id, "У узла нет переходов, но он не конечный");
    }
  }
  const edges: Record<string, string[]> = Object.fromEntries(ids.map((id) => [id, nodes[id]!.end ? [] : nodes[id]!.transitions.map((t) => t.to).filter((x) => x in nodes)]));
  const ends = ids.filter((id) => nodes[id]!.end);
  const success = new Set(ends.filter((id) => nodes[id]!.end!.outcome === "success"));
  const endStats = { success: 0, alt_success: 0, fail: 0 };
  for (const id of ends) endStats[nodes[id]!.end!.outcome] += 1;
  if (!(p.start_node in nodes)) {
    add("START_MISSING", null, "Стартовый узел не найден");
    return { ok: false, checked_at, issues, stats: { nodes: ids.length, ends: endStats, max_depth: 0, paths_to_success: 0 } };
  }
  const depth = new Map([[p.start_node, 0]]);
  const q = [p.start_node];
  while (q.length) {
    const c = q.shift()!;
    for (const n of edges[c]!) if (!depth.has(n)) (depth.set(n, depth.get(c)! + 1), q.push(n));
  }
  for (const id of ids) if (!depth.has(id)) add("UNREACHABLE_NODE", id, "Узел недостижим из стартового");
  const back = (targets: Set<string>) => {
    const seen = new Set(targets);
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of ids) if (!seen.has(id) && edges[id]!.some((x) => seen.has(x))) (seen.add(id), (grew = true));
    }
    return seen;
  };
  const anyEnd = back(new Set(ends));
  for (const id of [...depth.keys()].sort()) if (!nodes[id]!.end && nodes[id]!.transitions.length && !anyEnd.has(id)) add("TRAP", id, "Из узла не дойти до конца");
  const toSuccess = back(success);
  if (!success.size || !toSuccess.has(p.start_node)) add("NO_SUCCESS_END", null, "Не достичь успешного завершения");
  const rec = ids.filter((id) => nodes[id]!.recovery_point && id !== p.start_node);
  if (ids.length > 6 && !rec.length) add("NO_RECOVERY_POINT", null, "Нужна точка восстановления");
  for (const id of [...(nodes[p.start_node]!.recovery_point ? [p.start_node] : []), ...rec]) if (depth.has(id) && !toSuccess.has(id)) add("RECOVERY_CANNOT_FINISH", id, "С точки восстановления не дойти до успеха");
  return { ok: !issues.length, checked_at, issues, stats: { nodes: ids.length, ends: endStats, max_depth: Math.max(...depth.values()), paths_to_success: success.size ? 1 : 0 } };
}

/* ---------------------------------------------------------------- store */

export class ContentStore {
  vers: Record<ContentKind, Record<string, Ver[]>> = Object.fromEntries(KINDS.map((k) => [k, {}])) as never;
  blobs = new Map<string, { content_type: string; size: number; sha256: string }>([["b0000000-0000-4000-8000-00000000c0ff", { content_type: "audio/mpeg", size: 48_213, sha256: "c0ff".repeat(16) }]]);
  requests: AdminMediaRequest[] = C.mediaRequests();
  languages: Language[] = C.languages();
  pairs: PairCard[] = C.pairs();
  tests: DiagnosticTestRow[] = [
    { test_id: "dx-en-adult", pair_id: "ru-en", audience: "adults", published_version: 1, versions: [{ version: 2, status: "draft", items: C.dxItems(2).length, published_at: null }, { version: 1, status: "published", items: C.dxItems(1).length, published_at: iso(-9 * DAY) }] },
    { test_id: "dx-en-kids", pair_id: "ru-en", audience: "kids", published_version: 1, versions: [{ version: 1, status: "published", items: 36, published_at: iso(-9 * DAY) }] },
  ];
  private seq = 0;

  constructor() {
    const pub = (kind: ContentKind, payload: object, extra: Partial<Ver> = {}) => this.put(kind, payload as P, { status: "published", author_id: C.SEED, published_by: C.SEED, published_at: iso(-10 * DAY), locale_checks: { ru: "checked", uz: "checked" }, ...extra });
    pub("course", C.course);
    C.modules.forEach((m) => pub("module", m));
    C.skills.forEach((s) => pub("skill", s));
    C.rubrics.forEach((r) => pub("rubric", r));
    this.put("rubric", C.rubricDraft as unknown as P, { status: "draft", author_id: ID.methodist, locale_checks: { ru: "draft", uz: "draft" } });
    // lesson 1: published v1 (archived later by publication), draft v2 with empty UZ texts
    pub("lesson", C.lessonGreetings());
    this.put("lesson", C.lessonGreetingsDraft() as unknown as P, { status: "draft", author_id: ID.methodist, created_at: iso(-3 * HOUR), locale_checks: { ru: "draft", uz: "missing" } });
    this.put("lesson", C.lessonNumbers() as unknown as P, { status: "in_review", author_id: ID.methodist2, submitted_at: iso(-HOUR), locale_checks: { ru: "draft", uz: "draft" } });
    this.put("lesson", C.lessonCafe() as unknown as P, { status: "approved", author_id: ID.methodist, submitted_at: iso(-DAY), reviewer_id: ID.methodist2, reviewed_at: iso(-20 * HOUR), review_note: "Проверила RU и UZ", locale_checks: { ru: "checked", uz: "checked" } });
    const sc = pub("scenario", C.scenarioCafe());
    sc.run = { ...testRun(C.scenarioCafe(), iso(-10 * DAY)), hash: sc.payload_hash };
    this.put("scenario", C.scenarioCafeDraft() as unknown as P, { status: "draft", author_id: ID.methodist, locale_checks: { ru: "draft", uz: "draft" } });
    this.put("scenario", C.scenarioHotel() as unknown as P, { status: "in_review", author_id: ID.methodist2, submitted_at: iso(-2 * HOUR), locale_checks: { ru: "draft", uz: "draft" } });
    const rights = { rights_approved_by: ID.content, rights_approved_at: iso(-12 * DAY) };
    pub("media_asset", C.mediaCoffee(), rights);
    pub("media_asset", C.mediaBus(), rights);
    pub("media_asset", C.mediaMarket(), { ...rights, status: "suspended", suspended_at: iso(-2 * DAY), suspend_reason: "rights_expired" });
    this.put("media_asset", C.mediaTrain() as unknown as P, { status: "draft", author_id: ID.content, locale_checks: { ru: "draft", uz: "draft" } });
    pub("media_exercise", C.exerciseCoffee());
  }

  private put(kind: ContentKind, payload: P, extra: Partial<Ver>): Ver {
    const key = String(payload[KEY_FIELD[kind]]);
    const list = (this.vers[kind][key] ??= []);
    const v: Ver = {
      kind,
      key,
      version: list.length + 1,
      status: "draft",
      payload: JSON.parse(JSON.stringify(payload)) as P,
      payload_hash: hash(payload),
      author_id: ID.methodist,
      author_name: null,
      created_at: iso(-(5 - list.length) * DAY),
      submitted_at: null,
      reviewer_id: null,
      reviewer_name: null,
      reviewed_at: null,
      review_note: null,
      locale_checks: { ru: "draft", uz: "draft" },
      rights_approved_by: null,
      rights_approved_by_name: null,
      rights_approved_at: null,
      published_by: null,
      published_by_name: null,
      published_at: null,
      archived_at: null,
      suspended_at: null,
      suspend_reason: null,
      test_run: null,
      editors: [],
      run: null,
      ...extra,
    };
    if (!v.editors.includes(v.author_id)) v.editors.push(v.author_id);
    list.push(v);
    return v;
  }

  private nameOf: (id: string | null | undefined) => string | null = () => null;
  private view(v: Ver): ContentVersion<P> {
    const name = (id: string | null) => (id === C.SEED ? "Сид (начальное наполнение)" : this.nameOf(id));
    const { editors: _e, run, ...rest } = v;
    void _e;
    return {
      ...rest,
      author_name: name(v.author_id),
      reviewer_name: name(v.reviewer_id),
      rights_approved_by_name: name(v.rights_approved_by),
      published_by_name: name(v.published_by),
      test_run: run && run.hash === v.payload_hash ? { ok: run.ok, checked_at: run.checked_at, issues: run.issues, stats: run.stats } : null,
    };
  }
  private meta(v: Ver): ContentVersionMeta {
    const { kind: _k, key: _y, payload: _p, payload_hash: _h, test_run: _t, ...m } = this.view(v);
    void [_k, _y, _p, _h, _t];
    return m;
  }
  private published(kind: ContentKind, key: string): Ver | undefined {
    return this.vers[kind][key]?.find((v) => v.status === "published");
  }
  row(kind: ContentKind, key: string): ContentRow {
    const list = this.vers[kind][key]!;
    const latest = list[list.length - 1]!;
    const pub = this.published(kind, key);
    const shown = (pub ?? latest).payload as { title?: { ru: string; uz: string }; level?: string; rights?: { valid_to: string | null } };
    let rw: ContentRow["rights_warning"] = null;
    if (kind === "media_asset") {
      if (list.some((v) => v.status === "suspended")) rw = "expired";
      else {
        const to = (pub ?? latest).payload as { rights?: { valid_to: string | null } };
        const vt = to.rights?.valid_to;
        if (vt && vt < C.today()) rw = "expired";
        else if (vt && vt <= C.today(14)) rw = "expiring";
      }
    }
    return {
      kind,
      key,
      title: (latest.payload as { title?: { ru: string; uz: string } }).title ?? shown.title ?? { ru: key, uz: key },
      published_version: pub?.version ?? null,
      latest_version: latest.version,
      latest_status: latest.status,
      level: ((latest.payload as { level?: string }).level ?? null) as ContentRow["level"],
      updated_at: latest.reviewed_at ?? latest.submitted_at ?? latest.created_at,
      updated_by_name: latest.author_id === C.SEED ? "Сид (начальное наполнение)" : this.nameOf(latest.author_id),
      rights_warning: rw,
    };
  }

  private validate(kind: ContentKind, v: Ver, mode: "submit" | "publish"): Iss[] {
    const p = v.payload;
    const out: Iss[] = [];
    localized(p, "payload", out);
    const add = (path: string, code: string, message: string) => out.push({ path, code, message });
    if (kind === "lesson") {
      const stages = (p.stages as Array<{ minutes: number }>) ?? [];
      const sum = stages.reduce((a, s) => a + s.minutes, 0);
      if (sum !== p.duration_min) add("payload.stages", "STAGES_INVALID", `Сумма минут этапов ${sum} ≠ длительности урока ${String(p.duration_min)}`);
      if (((p.control_items as unknown[]) ?? []).length < 3) add("payload.control_items", "NO_CONTROL_ITEMS", "Контрольных заданий меньше 3");
      const kw = ((p.key_words as unknown[]) ?? []).length;
      if (kw < 4 || kw > 12) add("payload.key_words", "COUNT_OUT_OF_RANGE", `Опорных слов: ${kw}, нужно 4..12`);
      if (mode === "publish" && p.scenario_id && !this.published("scenario", String(p.scenario_id))) add("payload.scenario_id", "UNKNOWN_REF", `scenario «${String(p.scenario_id)}» не опубликован`);
    }
    if (kind === "rubric") {
      const cr = (p.criteria as Array<{ weight: number }>) ?? [];
      const s = Math.round(cr.reduce((a, c) => a + c.weight, 0) * 10_000) / 10_000;
      if (Math.abs(s - 1) > 1e-6) add("payload.criteria", "RUBRIC_WEIGHTS", `Сумма весов ${s} ≠ 1`);
    }
    if (kind === "scenario") {
      for (const i of testRun(p as unknown as ScenarioPayload, "").issues) add(i.node_id ? `payload.nodes.${i.node_id}` : "payload.nodes", i.code, i.detail);
      if (mode === "publish" && !(v.run && v.run.ok && v.run.hash === v.payload_hash)) add("test_run", "SCENARIO_TEST_FAILED", "Нужен успешный тестовый прогон этой версии");
    }
    if (kind === "media_asset") out.push(...this.rights(v, mode));
    if (mode === "publish") for (const l of ["ru", "uz"] as const) if (v.locale_checks[l] !== "checked") add(`locale_checks.${l}`, "LOCALE_NOT_CHECKED", `Локализация ${l.toUpperCase()} не проверена`);
    return out;
  }

  private rights(v: Ver, mode: "submit" | "publish"): Iss[] {
    const p = v.payload as { origin: string; rights: { owner: string; territories: string[]; allowed_uses: string[]; valid_to: string | null; license_type: string; attribution: string | null } };
    const out: Iss[] = [];
    const need = (f: string, m: string) => out.push({ path: `payload.rights.${f}`, code: "RIGHTS_REQUIRED", message: m });
    if (!p.rights.owner.trim()) need("owner", "Укажите правообладателя");
    if (!p.rights.territories.includes("UZ")) need("territories", "Права должны действовать в Узбекистане (UZ)");
    if (!p.rights.allowed_uses.length) need("allowed_uses", "Укажите разрешённые действия");
    if (p.rights.valid_to && p.rights.valid_to < C.today()) need("valid_to", "Срок прав истёк");
    if (p.rights.license_type.startsWith("cc_by") && !p.rights.attribution) need("attribution", "Для CC BY нужна атрибуция");
    if (p.origin === "licensed" || p.origin === "platform_embed") out.push({ path: "payload.origin", code: "EXTERNAL_SOURCE_DISABLED", message: "Закрыто флагом" });
    if (mode === "publish" && !v.rights_approved_at) out.push({ path: "rights_approved", code: "RIGHTS_REQUIRED", message: "Права не подтверждены (media.rights)" });
    return out;
  }

  summary(): ContentSummary {
    const by_kind = Object.fromEntries(
      KINDS.map((k) => {
        const all = Object.values(this.vers[k]);
        return [k, { published: all.filter((l) => l.some((v) => v.status === "published")).length, drafts: all.filter((l) => l.some((v) => v.status === "draft")).length, in_review: all.filter((l) => l.some((v) => v.status === "in_review")).length }];
      }),
    ) as ContentSummary["by_kind"];
    const expiring = Object.values(this.vers.media_asset)
      .map((l) => l.find((v) => v.status === "published"))
      .filter((v): v is Ver => !!v)
      .map((v) => ({ v, to: (v.payload as { rights: { valid_to: string | null } }).rights.valid_to }))
      .filter((x) => x.to && x.to >= C.today() && x.to <= C.today(14))
      .map((x) => ({ asset_id: x.v.key, title: (x.v.payload as { title: { ru: string; uz: string } }).title, valid_to: x.to! }));
    return {
      by_kind,
      in_review: KINDS.reduce((a, k) => a + by_kind[k].in_review, 0),
      rights_expiring: expiring,
      suspended_media: Object.values(this.vers.media_asset).filter((l) => l.some((v) => v.status === "suspended")).length,
      new_media_requests: this.requests.filter((r) => r.status === "new").length,
    };
  }

  /** answers a /content, /languages, /language-pairs or /diagnostics route; false — not ours */
  async handle(method: string, path: string, body: P, q: URLSearchParams, _idem: string | undefined, x: Ctx): Promise<boolean> {
    this.nameOf = x.nameOf;
    const has = (p: Permission) => x.perms.has(p);
    const deny = (p: Permission) => x.err(403, "PERMISSION_DENIED", { permission: p });
    const need = async (p: Permission | Permission[], stepUp = false): Promise<boolean> => {
      const ps = Array.isArray(p) ? p : [p];
      if (!ps.some(has)) {
        await deny(ps[0]!);
        return false;
      }
      if (stepUp && !x.stepUpOk()) {
        await x.err(403, "STEP_UP_REQUIRED", { permission: ps[0] });
        return false;
      }
      return true;
    };
    let m: RegExpMatchArray | null;
    const key = `${method} ${path}`;

    /* ---------- summary, queue, blobs, requests ---------- */
    if (key === "GET /content/summary") return (await need(["dashboard.read", "content.read"])) && (await x.json(200, this.summary()), true);
    if (key === "GET /content/review-queue") {
      if (!(await need("content.review"))) return true;
      const kind = q.get("kind");
      const items: ContentRow[] = [];
      for (const k of KINDS) {
        if (kind && k !== kind) continue;
        for (const [k2, list] of Object.entries(this.vers[k])) {
          const v = list.find((y) => y.status === "in_review");
          if (v && !v.editors.includes(x.me.staff_id)) items.push(this.row(k, k2));
        }
      }
      await x.json(200, { items, next_cursor: null });
      return true;
    }
    if (key === "POST /content/blobs") {
      if (!(await need("content.edit"))) return true;
      const data = String(body.data_base64 ?? "");
      const buf = Buffer.from(data, "base64");
      const ct = String(body.content_type);
      const okSig = (ct === "audio/mpeg" && (buf.subarray(0, 3).toString() === "ID3" || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0))) || (ct === "audio/ogg" && buf.subarray(0, 4).toString() === "OggS") || (ct === "audio/mp4" && buf.subarray(4, 8).toString() === "ftyp");
      if (!buf.length || buf.length > 3 * 1024 * 1024 || !okSig) return x.err(422, "AUDIO_INVALID", { reason: !okSig ? "signature" : "size" }).then(() => true);
      const sha = hash(data);
      const existing = [...this.blobs.entries()].find(([, b]) => b.sha256 === sha);
      const id = existing?.[0] ?? `b0000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;
      if (!existing) this.blobs.set(id, { content_type: ct, size: buf.length, sha256: sha });
      x.record("content.blob_uploaded", "media_blob", id, { size: buf.length });
      await x.json(existing ? 200 : 201, { blob_id: id, content_type: ct, size: buf.length, sha256: sha, created_at: iso(0) });
      return true;
    }
    if ((m = path.match(/^\/content\/blobs\/([^/]+)$/)) && method === "GET") {
      if (!(await need("content.read"))) return true;
      const b = this.blobs.get(m[1]!);
      if (!b) return x.err(404, "NOT_FOUND").then(() => true);
      // a tiny silent MPEG frame — enough for the <audio> element to load
      await x.binary(200, Buffer.from([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, ...new Array(410).fill(0)]), b.content_type);
      return true;
    }
    if (key === "GET /content/media-requests") {
      // review of sprint 3: the register is media.rights only (not content.read)
      if (!(await need("media.rights"))) return true;
      const st = q.get("status");
      const qs = (q.get("q") ?? "").toLowerCase();
      await x.json(200, { items: this.requests.filter((r) => (!st || r.status === st) && (!qs || r.title.toLowerCase().includes(qs))), next_cursor: null });
      return true;
    }
    if ((m = path.match(/^\/content\/media-requests\/([^/]+)\/(take|decide)$/)) && method === "POST") {
      const r = this.requests.find((y) => y.request_id === m![1]);
      if (!(await need("media.rights", m[2] === "decide"))) return true;
      if (!r) return x.err(404, "MEDIA_REQUEST_NOT_FOUND").then(() => true);
      if (!["new", "in_review"].includes(r.status)) return x.err(409, "MEDIA_REQUEST_DECIDED", { status: r.status }).then(() => true);
      if (m[2] === "take") {
        r.status = "in_review";
        x.record("media_request.taken", "media_request", r.request_id, null);
        return x.json(200, r).then(() => true);
      }
      const status = String(body.status);
      const note = String(body.note ?? "").trim();
      const asset = body.linked_asset_id as string | undefined;
      if (note.length < 3) return x.err(422, "VALIDATION_ERROR", { in: "body", field: "note", errors: [] }).then(() => true);
      if ((status === "authored_alternative" || status === "licensed") && !asset) return x.err(422, "LINKED_ASSET_REQUIRED").then(() => true);
      if (asset && !this.published("media_asset", asset)) return x.err(422, "LINKED_ASSET_NOT_PUBLISHED").then(() => true);
      Object.assign(r, { status, decision_note: note, linked_asset_id: asset ?? null, decided_by: x.me.staff_id, decided_by_name: x.me.display_name, decided_at: iso(0) });
      x.record("media_request.decided", "media_request", r.request_id, { status });
      return x.json(200, r).then(() => true);
    }

    /* ---------- languages and pairs ---------- */
    if (key === "GET /languages") return (await need("content.read")) && (await x.json(200, { items: this.languages }), true);
    if (key === "GET /language-pairs") return (await need("content.read")) && (await x.json(200, { items: this.pairs }), true);
    if ((m = path.match(/^\/languages\/([^/]+)$/)) && method === "PUT") {
      if (!(await need("lang.manage", true))) return true;
      if (body.code !== m[1]) return x.err(422, "LANGUAGE_CODE_MISMATCH").then(() => true);
      const i = this.languages.findIndex((l) => l.code === m![1]);
      if (i >= 0) this.languages[i] = body as unknown as Language;
      else this.languages.push(body as unknown as Language);
      x.record("lang.language_updated", "language", m[1]!, null);
      return x.json(200, body).then(() => true);
    }
    if ((m = path.match(/^\/language-pairs\/([^/]+)$/)) && method === "PUT") {
      if (!(await need("lang.manage", true))) return true;
      const { reason, ...pair } = body as P & { reason?: string };
      if (pair.pair_id !== m[1]) return x.err(422, "PAIR_ID_MISMATCH").then(() => true);
      if (pair.source === pair.target) return x.err(422, "PAIR_INVALID").then(() => true);
      const cur = this.pairs.find((p) => p.pair_id === m![1]);
      if (pair.status === "published" && cur?.status !== "published") {
        const missing: string[] = [];
        if (!pair.course_id || pair.course_id !== "en-core" || pair.pair_id !== "ru-en") missing.push("course");
        if (!cur || cur.readiness.lessons_published === 0) missing.push("lessons");
        if (!cur || cur.readiness.rubrics_published === 0) missing.push("rubrics");
        if (!cur || cur.readiness.locales_checked_pct < 100) missing.push("locales");
        if (!cur?.readiness.diagnostic_test) missing.push("diagnostic_test");
        if (missing.length) return x.err(422, "PAIR_NOT_READY", { missing }).then(() => true);
      }
      const card: PairCard = { ...(cur ?? { readiness: { skills: 0, lessons_published: 0, scenarios_published: 0, rubrics_published: 0, media_published: 0, diagnostic_test: null, locales_checked_pct: 0 }, learners: 0 }), ...(pair as unknown as PairCard) };
      if (cur) Object.assign(cur, card);
      else this.pairs.push(card);
      x.record("lang.pair_updated", "language_pair", m[1]!, { status: pair.status }, String(reason ?? ""));
      return x.json(200, card).then(() => true);
    }

    /* ---------- diagnostics ---------- */
    if (key === "GET /diagnostics/tests") return (await need("content.read")) && (await x.json(200, { items: this.tests }), true);
    if (key === "GET /diagnostics/stats") return (await need("dashboard.read")) && (await x.json(200, C.dxStats(q.get("period") ?? "today")), true);
    if ((m = path.match(/^\/diagnostics\/tests\/([^/]+)\/versions\/(\d+)(\/publish)?$/))) {
      const t = this.tests.find((y) => y.test_id === m![1]);
      const v = Number(m[2]);
      const meta = t?.versions.find((y) => y.version === v);
      if (method === "GET") {
        if (!(await need("content.read"))) return true;
        if (!t || !meta) return x.err(404, "TEST_NOT_FOUND").then(() => true);
        const items = C.dxItems(v);
        const coverage: Record<string, Record<string, number>> = {};
        for (const it of items) ((coverage[String(it.area)] ??= {})[String(it.band)] = (coverage[String(it.area)]?.[String(it.band)] ?? 0) + 1);
        for (const a of ["vocabulary", "grammar", "reading", "listening"]) for (const b of ["A0", "A1", "A2", "B1", "B2"]) (coverage[a] ??= {})[b] ??= 0;
        return x.json(200, { test_id: t.test_id, version: v, status: meta.status, config: { items_per_area: 6 }, items, coverage }).then(() => true);
      }
      if (method === "POST" && m[3]) {
        if (!(await need("content.publish", true))) return true;
        if (!t || !meta) return x.err(404, "TEST_NOT_FOUND").then(() => true);
        if (meta.status !== "draft") return x.err(409, "TEST_VERSION_NOT_DRAFT").then(() => true);
        for (const y of t.versions) if (y.status === "published") y.status = "archived";
        Object.assign(meta, { status: "published", published_at: iso(0) });
        t.published_version = v;
        x.record("diagnostics.test_published", "diagnostic_test", t.test_id, { version: v }, String(body.reason ?? ""));
        return x.json(200, t).then(() => true);
      }
    }

    /* ---------- content entities ---------- */
    if (!path.startsWith("/content/")) return false;
    const [, , kindRaw, k2, sub, vRaw, action] = path.split("/");
    const kind = kindRaw as ContentKind;
    if (!KINDS.includes(kind)) return x.err(404, "CONTENT_KIND_UNKNOWN").then(() => true);
    const list = k2 ? this.vers[kind][k2] : undefined;

    if (!k2 && method === "GET") {
      if (!(await need("content.read"))) return true;
      const st = q.get("status");
      const lv = q.get("level");
      const qs = (q.get("q") ?? "").toLowerCase();
      const items = Object.keys(this.vers[kind])
        .sort()
        .map((k) => this.row(kind, k))
        .filter((r) => (!st || (st === "published" ? r.published_version != null : r.latest_status === st)) && (!lv || r.level === lv) && (!qs || r.key.includes(qs) || r.title.ru.toLowerCase().includes(qs) || r.title.uz.toLowerCase().includes(qs)));
      return x.json(200, { items, next_cursor: null }).then(() => true);
    }
    if (!k2 && method === "POST") {
      if (!(await need("content.edit"))) return true;
      const payload = (body.payload ?? {}) as P;
      const kk = String(payload[KEY_FIELD[kind]] ?? "");
      if (!ID_RE.test(kk)) return x.err(422, "CONTENT_INVALID", { errors: [{ path: `payload.${KEY_FIELD[kind]}`, code: "SCHEMA_INVALID", message: "id" }] }).then(() => true);
      if (this.vers[kind][kk]) return x.err(409, "CONTENT_KEY_EXISTS").then(() => true);
      const v = this.put(kind, payload, { status: "draft", author_id: x.me.staff_id, created_at: iso(0) });
      x.record("content.version_created", kind, kk, { version: 1 });
      return x.json(201, this.view(v)).then(() => true);
    }
    if (!list) return x.err(404, "CONTENT_NOT_FOUND").then(() => true);

    if (!sub && method === "GET") {
      if (!(await need("content.read"))) return true;
      return x.json(200, { row: this.row(kind, k2!), versions: [...list].reverse().map((v) => this.meta(v)) }).then(() => true);
    }
    if (sub === "versions" && !vRaw && method === "POST") {
      if (!(await need("content.edit"))) return true;
      const open = list.find((v) => v.status === "draft" || v.status === "in_review");
      if (open) return x.err(409, "DRAFT_EXISTS", { version: open.version }).then(() => true);
      const from = list.find((v) => v.version === Number(body.from_version));
      if (!from) return x.err(404, "VERSION_NOT_FOUND").then(() => true);
      const v = this.put(kind, from.payload, { status: "draft", author_id: x.me.staff_id, created_at: iso(0), locale_checks: { ru: "draft", uz: "draft" } });
      x.record("content.version_created", kind, k2!, { version: v.version, from: from.version });
      return x.json(201, this.view(v)).then(() => true);
    }
    if (sub === "archive" && method === "POST") {
      if (!(await need("content.publish", true))) return true;
      const pub = this.published(kind, k2!);
      if (!pub) return x.err(409, "CONTENT_NOT_PUBLISHED").then(() => true);
      if (kind === "scenario" && Object.values(this.vers.lesson).some((l) => l.some((v) => v.status === "published" && v.payload.scenario_id === k2)))
        return x.err(409, "CONTENT_IN_USE", { refs: [{ kind: "lesson", key: "l-03-cafe" }] }).then(() => true);
      Object.assign(pub, { status: "archived", archived_at: iso(0) });
      x.record("content.archived", kind, k2!, { version: pub.version }, String(body.reason ?? ""));
      return x.json(200, { row: this.row(kind, k2!) }).then(() => true);
    }
    if (sub === "rollback" && method === "POST") {
      if (!(await need("content.publish", true))) return true;
      const target = list.find((v) => v.version === Number(body.to_version));
      if (!target || target.status !== "archived" || !target.published_at) return x.err(409, "ROLLBACK_TARGET_INVALID", { status: target?.status ?? null }).then(() => true);
      const cur = this.published(kind, k2!);
      if (cur) Object.assign(cur, { status: "archived", archived_at: iso(0) });
      Object.assign(target, { status: "published", published_by: x.me.staff_id, published_at: iso(0), archived_at: null });
      x.record("content.rolled_back", kind, k2!, { published_version: target.version }, String(body.reason ?? ""));
      return x.json(200, this.view(target)).then(() => true);
    }
    if (sub !== "versions" || !vRaw) return x.err(404, "NOT_FOUND", { path }).then(() => true);
    const v = list.find((y) => y.version === Number(vRaw));
    if (!v) return x.err(404, "VERSION_NOT_FOUND").then(() => true);

    if (!action && method === "GET") return (await need("content.read")) && (await x.json(200, this.view(v)), true);
    if (!action && method === "PUT") {
      if (!(await need("content.edit"))) return true;
      if (v.status !== "draft") return x.err(409, "VERSION_NOT_DRAFT", { status: v.status }).then(() => true);
      if (body.expected_hash !== v.payload_hash) return x.err(409, "VERSION_CONFLICT", { payload_hash: v.payload_hash }).then(() => true);
      const payload = body.payload as P;
      if (payload[KEY_FIELD[kind]] !== k2) return x.err(422, "CONTENT_INVALID", { errors: [{ path: `payload.${KEY_FIELD[kind]}`, code: "KEY_CHANGED", message: "Идентификатор менять нельзя" }] }).then(() => true);
      const before = v.payload_hash;
      v.payload = payload;
      v.payload_hash = hash(payload);
      const rightsReset = kind === "media_asset" && !!v.rights_approved_at && before !== v.payload_hash;
      if (rightsReset) Object.assign(v, { rights_approved_by: null, rights_approved_at: null });
      const miss: Iss[] = [];
      localized(payload, "payload", miss);
      v.locale_checks = { ru: miss.some((i) => i.path.endsWith(".ru")) ? "missing" : "draft", uz: miss.some((i) => i.path.endsWith(".uz")) ? "missing" : "draft" };
      if (!v.editors.includes(x.me.staff_id)) v.editors.push(x.me.staff_id);
      x.record("content.version_updated", kind, k2!, { rights_reset: rightsReset });
      return x.json(200, this.view(v)).then(() => true);
    }
    if (action === "validate" && method === "POST") {
      if (!(await need("content.read"))) return true;
      const errors = this.validate(kind, v, "publish");
      return x.json(200, { ok: !errors.length, errors }).then(() => true);
    }
    if (action === "submit" && method === "POST") {
      if (!(await need("content.edit"))) return true;
      if (v.status !== "draft") return x.err(409, "VERSION_NOT_DRAFT", { status: v.status }).then(() => true);
      const errors = this.validate(kind, v, "submit");
      if (errors.length) return x.err(422, "CONTENT_INVALID", { errors }).then(() => true);
      Object.assign(v, { status: "in_review", submitted_at: iso(0) });
      x.record("content.submitted", kind, k2!, { version: v.version });
      return x.json(200, this.view(v)).then(() => true);
    }
    if (action === "review" && method === "POST") {
      if (!(await need("content.review"))) return true;
      if (v.status !== "in_review") return x.err(409, "VERSION_NOT_IN_REVIEW", { status: v.status }).then(() => true);
      if (v.editors.includes(x.me.staff_id) || v.author_id === x.me.staff_id) return x.err(409, "SELF_REVIEW").then(() => true);
      const lc = body.locale_checks as { ru: LocaleCheck; uz: LocaleCheck };
      if (body.decision === "approve") {
        const miss = (["ru", "uz"] as const).filter((l) => lc?.[l] !== "checked").map((l) => ({ path: `locale_checks.${l}`, code: "LOCALE_NOT_CHECKED", message: `Отметьте проверку ${l.toUpperCase()}` }));
        if (miss.length) return x.err(422, "CONTENT_INVALID", { errors: miss }).then(() => true);
        Object.assign(v, { status: "approved", locale_checks: { ru: "checked", uz: "checked" } });
      } else Object.assign(v, { status: "draft", locale_checks: lc });
      Object.assign(v, { reviewer_id: x.me.staff_id, reviewed_at: iso(0), review_note: String(body.note ?? "") });
      x.record(body.decision === "approve" ? "content.reviewed" : "content.returned", kind, k2!, { version: v.version });
      return x.json(200, this.view(v)).then(() => true);
    }
    if (action === "publish" && method === "POST") {
      if (!(await need("content.publish", true))) return true;
      if (v.status === "published") return x.json(200, this.view(v)).then(() => true);
      if (v.status !== "approved") return x.err(409, "VERSION_NOT_APPROVED", { status: v.status }).then(() => true);
      const errors = this.validate(kind, v, "publish");
      if (errors.length) return x.err(422, "CONTENT_INVALID", { errors }).then(() => true);
      for (const y of list) if (y.status === "published" || (y.status === "approved" && y.version < v.version)) Object.assign(y, { status: "archived", archived_at: iso(0) });
      Object.assign(v, { status: "published", published_by: x.me.staff_id, published_at: iso(0) });
      x.record("content.published", kind, k2!, { published_version: v.version }, String(body.reason ?? ""));
      return x.json(200, this.view(v)).then(() => true);
    }
    if (action === "test-run" && method === "POST" && kind === "scenario") {
      if (!(await need("content.edit"))) return true;
      const r = testRun(v.payload as unknown as ScenarioPayload, iso(0));
      v.run = { ...r, hash: v.payload_hash };
      x.record("content.test_run", kind, k2!, { ok: r.ok, issues: r.issues.length });
      return x.json(200, r).then(() => true);
    }
    if (action === "rights-approve" && method === "POST" && kind === "media_asset") {
      if (!(await need("media.rights", true))) return true;
      if (!["draft", "in_review", "approved"].includes(v.status)) return x.err(409, "VERSION_IMMUTABLE", { status: v.status }).then(() => true);
      const errors = this.rights(v, "submit");
      if (errors.length) return x.err(422, "CONTENT_INVALID", { errors }).then(() => true);
      Object.assign(v, { rights_approved_by: x.me.staff_id, rights_approved_at: iso(0) });
      x.record("content.rights_approved", kind, k2!, null, String(body.note ?? ""));
      return x.json(200, this.view(v)).then(() => true);
    }
    await x.err(404, "NOT_FOUND", { path });
    return true;
  }

  /** e2e helper: the statuses of the versions of a key, oldest first */
  states(kind: ContentKind, key: string): VersionStatus[] {
    return (this.vers[kind][key] ?? []).map((v) => v.status);
  }
}
