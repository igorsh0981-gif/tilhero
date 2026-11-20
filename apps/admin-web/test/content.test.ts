import { describe, expect, it } from "vitest";
import type { LessonPayload, MediaExercisePayload, MediaPayload, RubricPayload, ScenarioPayload } from "@tilhero/contracts/content";
import {
  answerText,
  byPath,
  checkAudio,
  diffPayload,
  emptyPayload,
  issuesUnder,
  KINDS,
  langOfPath,
  localeIssues,
  missingByLang,
  msToSec,
  nodeOfPath,
  pathPrefixes,
  prereqCycle,
  rightsIssues,
  rightsState,
  secToMs,
  sniffAudio,
  stagesSum,
  toBase64,
  todayTashkent,
  transcriptIssues,
  validateExercise,
  validateLesson,
  validateMedia,
  validateRubric,
  validateScenario,
  validateSkill,
  weightsOk,
  weightsSum,
} from "../src/screens/content/model";
import { analyzeScenario, layoutScenario, NODE_W, problemsByNode } from "../src/screens/content/graph";
import { balanceWeights } from "../src/screens/content/RubricEditor";
import { safeLink } from "../src/screens/content/RequestsTab";
import { contentTabs, parseContentRoute } from "../src/screens/content/ContentPage";
import type { Permission } from "@tilhero/contracts/admin";
import { coverageTone } from "../src/screens/content/DiagnosticsTab";

const L = (ru: string, uz: string) => ({ ru, uz });
const codes = (xs: Array<{ path: string; code: string }>) => xs.map((x) => `${x.path}:${x.code}`);

function lesson(): LessonPayload {
  const p = emptyPayload("lesson", "l-01", { module_id: "m1", rubric_id: "r1" }) as unknown as LessonPayload;
  p.title = L("Привет", "Salom");
  p.goal = L("Поздороваться", "Salomlashish");
  p.primary_skill_id = "en.func.greet";
  p.stages = p.stages.map((s) => ({ ...s, instructions: L("Шаг", "Qadam") }));
  p.key_words = ["hello", "hi", "name", "morning"].map((en) => ({ en, gloss: L("слово", "soʻz"), example_en: `${en}!` }));
  p.examples = [1, 2].map((n) => ({ en: `Example ${n}`, gloss: L("пример", "misol") }));
  p.control_items = [
    { item_id: "ci-01", type: "single_choice", skill_id: "en.func.greet", instruction: L("Выберите", "Tanlang"), prompt_en: "8 a.m.:", options: ["Good morning", "Good night"], answer: 0 },
    { item_id: "ci-02", type: "gap_fill", skill_id: "en.func.greet", instruction: L("Вставьте", "Qoʻying"), prompt_en: "My name ___ Anna.", options: [], answer: ["is"] },
    { item_id: "ci-03", type: "order_words", skill_id: "en.func.greet", instruction: L("Соберите", "Tuzing"), prompt_en: "Order", options: ["meet", "Nice", "you", "to"], answer: ["Nice", "to", "meet", "you"] },
  ];
  return p;
}

describe("content model: kinds, paths, localisations", () => {
  it("every kind has an empty payload with its key", () => {
    for (const k of KINDS) expect(Object.values(emptyPayload(k, "x-key"))).toContain("x-key");
  });
  it("path helpers: prefixes, node, language", () => {
    expect(pathPrefixes("payload.nodes.n4.transitions[0].to")).toEqual(["payload.nodes.n4.transitions[0].to", "payload.nodes.n4.transitions[0]", "payload.nodes.n4.transitions", "payload.nodes.n4", "payload.nodes", "payload"]);
    expect(nodeOfPath("payload.nodes.n4.transitions[0].to")).toBe("n4");
    expect(nodeOfPath("payload.nodes.a.b.line_en")).toBe("a.b");
    expect(nodeOfPath("payload.nodes.n_tip")).toBe("n_tip");
    expect(nodeOfPath("payload.title.uz")).toBeNull();
    expect(langOfPath("payload.stages[2].instructions.uz")).toBe("uz");
    expect(langOfPath("payload.key_words[0].en")).toBeNull();
    const m = byPath([{ path: "payload.stages", code: "STAGES_INVALID" }, { path: "payload.stages[1].minutes", code: "STAGES_INVALID" }, { path: "payload.title.uz", code: "LOCALE_MISSING" }]);
    expect(issuesUnder(m, "payload.stages")).toHaveLength(2);
    expect(issuesUnder(m, "payload.stage")).toHaveLength(0);
  });
  it("empty RU/UZ texts are counted per language (the badges of the language tabs)", () => {
    const p = lesson();
    p.title.uz = "";
    p.stages[2]!.instructions.uz = " ";
    p.key_words[1]!.gloss.ru = "";
    const miss = missingByLang(p);
    expect(miss.uz).toEqual(["payload.title.uz", "payload.stages[2].instructions.uz"]);
    expect(miss.ru).toEqual(["payload.key_words[1].gloss.ru"]);
  });
  it("UZ only in Latin with the ʻ letter; control characters are refused", () => {
    expect(codes(localeIssues({ title: L("Привет", "Привет") }))).toEqual(["payload.title.uz:LOCALE_SCRIPT"]);
    expect(codes(localeIssues({ title: L("Да", "o'zbek") }))).toEqual(["payload.title.uz:LOCALE_SCRIPT"]);
    expect(localeIssues({ title: L("Да", "oʻzbek") })).toEqual([]);
    expect(codes(localeIssues({ title: L(`a${String.fromCharCode(0x202e)}b`, "x") }))).toEqual(["payload.title.ru:SCHEMA_INVALID"]);
  });
});

describe("lesson rules (catalog validation.py)", () => {
  it("a complete lesson passes", () => {
    expect(validateLesson(lesson())).toEqual([]);
  });
  it("five stages in order, 1..10 min each, sum = length", () => {
    const p = lesson();
    expect(stagesSum(p.stages)).toBe(20);
    p.stages[0]!.minutes = 1;
    expect(stagesSum(p.stages)).toBe(18);
    expect(codes(validateLesson(p))).toContain("payload.stages:STAGES_INVALID");
    p.duration_min = 15;
    p.stages[4]!.minutes = 0;
    expect(codes(validateLesson(p))).toContain("payload.stages[4].minutes:STAGES_INVALID");
    const q = lesson();
    [q.stages[0], q.stages[1]] = [q.stages[1]!, q.stages[0]!];
    expect(codes(validateLesson(q))).toEqual(["payload.stages:STAGES_INVALID"]);
  });
  it("fewer than 3 control items, broken keys, word counts", () => {
    const p = lesson();
    p.control_items = p.control_items.slice(0, 2);
    p.control_items[0]!.answer = 5;
    p.control_items[1]!.answer = [];
    p.key_words = p.key_words.slice(0, 3);
    const c = codes(validateLesson(p));
    expect(c).toContain("payload.control_items:NO_CONTROL_ITEMS");
    expect(c).toContain("payload.control_items[0].answer:ANSWER_INVALID");
    expect(c).toContain("payload.control_items[1].answer:ANSWER_INVALID");
    expect(c).toContain("payload.key_words:COUNT_OUT_OF_RANGE");
    const q = lesson();
    q.control_items[2]!.answer = ["Nice", "to", "see", "you"];
    expect(codes(validateLesson(q))).toEqual(["payload.control_items[2].answer:ANSWER_INVALID"]);
  });
  it("empty audience, missing translations", () => {
    const p = lesson();
    p.audience = [];
    p.goal.uz = "";
    expect(codes(validateLesson(p))).toEqual(["payload.goal.uz:LOCALE_MISSING", "payload.audience:AUDIENCE_EMPTY"]);
  });
  it("readable answer keys", () => {
    expect(answerText("single_choice", ["A1", "B2"], 1)).toBe("B: B2");
    expect(answerText("gap_fill", [], ["is", "'s"])).toBe("is / 's");
    expect(answerText("order_words", [], ["Nice", "to"])).toBe("Nice to");
    expect(answerText("order_lines", [], [1, 0, 2])).toBe("2 → 1 → 3");
  });
});

describe("rubric weights", () => {
  const rubric = (w: number[]): RubricPayload => ({
    rubric_id: "r",
    title: L("Рубрика", "Rubrika"),
    applies_to: ["lesson"],
    criteria: w.map((weight, i) => ({ code: (["task", "vocabulary", "grammar", "fluency"] as const)[i]!, title: L("К", "M"), weight, bands: ([0, 1, 2, 3] as const).map((score) => ({ score, descriptor: L("д", "t") })) })),
    pass_rule: { min_weighted: 1.5, min_per_criterion: 1 },
  });
  it("sum = 1 without float noise", () => {
    expect(weightsSum([{ weight: 0.1 }, { weight: 0.2 }, { weight: 0.7 }])).toBe(1);
    expect(weightsOk([{ weight: 0.1 }, { weight: 0.2 }, { weight: 0.7 }])).toBe(true);
    expect(weightsSum([{ weight: 0.3 }, { weight: 0.3 }, { weight: 0.3 }])).toBe(0.9);
    expect(validateRubric(rubric([0.4, 0.3, 0.3]))).toEqual([]);
    expect(codes(validateRubric(rubric([0.4, 0.3, 0.2])))).toEqual(["payload.criteria:RUBRIC_WEIGHTS"]);
    expect(codes(validateRubric(rubric([1])))).toEqual(["payload.criteria:COUNT_OUT_OF_RANGE"]);
  });
  it("«Выровнять» spreads the weights to exactly 1", () => {
    const r = rubric([0.5, 0.5, 0.5]);
    const b = balanceWeights(r.criteria);
    expect(b.map((c) => c.weight)).toEqual([0.33, 0.33, 0.34]);
    expect(weightsOk(b)).toBe(true);
  });
  it("bands 0..3 in order", () => {
    const r = rubric([0.5, 0.5]);
    r.criteria[1]!.bands = r.criteria[1]!.bands.slice(0, 3);
    expect(codes(validateRubric(r))).toEqual(["payload.criteria[1].bands:RUBRIC_BANDS"]);
  });
});

/* ---------------------------------------------------------------- scenario graph */

const node = (to: string[], extra: Partial<ScenarioPayload["nodes"][string]> = {}): ScenarioPayload["nodes"][string] => ({
  speaker: "host",
  line_en: "Line",
  gloss: L("р", "t"),
  hint: null,
  recovery_point: false,
  event: null,
  transitions: to.map((x) => ({ intent: "other", description: L("д", "t"), examples_en: ["ok"], to: x })),
  end: null,
  ...extra,
});
const end = (outcome: "success" | "alt_success" | "fail") => node([], { end: { outcome, summary: L("итог", "xulosa") } });

function scenario(nodes: ScenarioPayload["nodes"], start = "start"): ScenarioPayload {
  return {
    ...(emptyPayload("scenario", "sc") as unknown as ScenarioPayload),
    title: L("Кафе", "Kafe"),
    task: L("Заказать", "Buyurtma"),
    completion: { criteria: L("Заказ", "Buyurtma") },
    rubric_id: "r",
    characters: [{ id: "host", name: "Sam", role: L("Бариста", "Barista"), voice: "en-GB" }],
    start_node: start,
    nodes,
  };
}

const good = () =>
  scenario({
    start: node(["menu"], { recovery_point: true }),
    menu: node(["pay", "start"]),
    pay: node(["thanks", "angry"], { recovery_point: true }),
    thanks: end("success"),
    angry: end("fail"),
    extra: node(["thanks"]),
    lost: node(["pay"]),
  });

describe("scenario test run (catalog scenario_test.py)", () => {
  it("unreachable nodes, dead ends, traps, missing success, recovery points", () => {
    const g = good();
    let r = analyzeScenario(g);
    expect(r.issues).toEqual([
      { code: "UNREACHABLE_NODE", node_id: "extra" },
      { code: "UNREACHABLE_NODE", node_id: "lost" },
    ]);
    delete g.nodes.extra;
    delete g.nodes.lost;
    r = analyzeScenario(g);
    expect(r.ok).toBe(true);
    expect(r.stats).toEqual({ nodes: 5, ends: { success: 1, alt_success: 0, fail: 1 }, max_depth: 3, paths_to_success: 1 });
    g.nodes.menu = node([]);
    r = analyzeScenario(g);
    expect(r.issues.map((x) => `${x.code}:${x.node_id}`)).toEqual(["DEAD_END:menu", "UNREACHABLE_NODE:angry", "UNREACHABLE_NODE:pay", "UNREACHABLE_NODE:thanks", "TRAP:start", "NO_SUCCESS_END:null", "RECOVERY_CANNOT_FINISH:start"]);
  });
  it("a loop without exit is a trap; > 6 nodes need a recovery point; unknown targets and speakers", () => {
    const s = scenario({
      start: node(["a", "b"]),
      a: node(["a2"]),
      a2: node(["a"]),
      b: node(["ok", "ghost"], { speaker: "nobody" }),
      ok: end("success"),
      c: node(["ok"]),
      d: node(["ok"]),
    });
    s.nodes.c = node(["ok"]);
    const r = analyzeScenario(s);
    const c = r.issues.map((x) => `${x.code}:${x.node_id ?? ""}`);
    expect(c).toContain("TRAP:a");
    expect(c).toContain("TRAP:a2");
    expect(c).toContain("UNKNOWN_NODE:b");
    expect(c).toContain("UNKNOWN_SPEAKER:b");
    expect(c).toContain("NO_RECOVERY_POINT:");
    expect(analyzeScenario(scenario({ x: end("success") }, "nope")).issues).toEqual([{ code: "START_MISSING", node_id: null }]);
  });
  it("graph issues map onto catalog paths of the scenario rules", () => {
    const g = good();
    const c = codes(validateScenario(g));
    expect(c).toContain("payload.nodes.extra:UNREACHABLE_NODE");
    g.nodes.thanks = { ...g.nodes.thanks!, transitions: [{ intent: "x", description: L("а", "b"), examples_en: ["a"], to: "start" }] };
    expect(codes(validateScenario(g))).toContain("payload.nodes.thanks.transitions:END_HAS_TRANSITIONS");
  });
  it("problems by node for the highlight; global ones under the empty key", () => {
    const m = problemsByNode([
      { code: "UNREACHABLE_NODE", node_id: "n7" },
      { code: "DEAD_END", node_id: "n7" },
      { code: "NO_SUCCESS_END", node_id: null },
      { code: "DEAD_END", node_id: "n7" },
    ]);
    expect(m.get("n7")).toEqual(["UNREACHABLE_NODE", "DEAD_END"]);
    expect(m.get("")).toEqual(["NO_SUCCESS_END"]);
  });
});

describe("scenario graph layout", () => {
  it("columns by BFS depth, unreachable nodes in an extra column, deterministic", () => {
    const g = good();
    const a = layoutScenario(g);
    const b = layoutScenario(g);
    expect(a).toEqual(b);
    const col = (id: string) => a.nodes.find((n) => n.id === id)!.x;
    expect(col("start")).toBeLessThan(col("menu"));
    expect(col("menu")).toBeLessThan(col("pay"));
    expect(col("thanks")).toBe(col("angry"));
    expect(col("extra")).toBe(col("lost"));
    expect(col("extra")).toBeGreaterThan(col("thanks"));
    expect(a.nodes.find((n) => n.id === "extra")!.depth).toBeNull();
    expect(a.nodes.find((n) => n.id === "start")!.start).toBe(true);
    expect(a.nodes.find((n) => n.id === "angry")!.end).toBe("fail");
    expect(a.width).toBeGreaterThanOrEqual(col("extra") + NODE_W);
  });
  it("forward edges, a back edge below, a stub for a missing target; nodes do not overlap", () => {
    const g = good();
    g.nodes.menu = node(["pay", "start", "ghost"]);
    const lay = layoutScenario(g);
    const kinds = Object.fromEntries(lay.edges.map((e) => [`${e.from}>${e.to}`, e.kind]));
    expect(kinds["start>menu"]).toBe("forward");
    expect(kinds["menu>start"]).toBe("back");
    expect(lay.dangling).toEqual([expect.objectContaining({ from: "menu", to: "ghost" })]);
    const boxes = lay.nodes.map((n) => [n.x, n.y] as const);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(boxes[i]!.join() === boxes[j]!.join()).toBe(false);
    expect(lay.height).toBeGreaterThan(Math.max(...lay.nodes.map((n) => n.y)));
  });
  it("a self loop goes above the node (everything shifted down)", () => {
    const g = good();
    g.nodes.menu = node(["pay", "menu"]);
    const lay = layoutScenario(g);
    const self = lay.edges.find((e) => e.kind === "self")!;
    expect(self.from).toBe("menu");
    expect(Math.min(...lay.nodes.map((n) => n.y))).toBeGreaterThan(18);
  });
});

/* ---------------------------------------------------------------- media */

function media(): MediaPayload {
  const p = emptyPayload("media_asset", "m-own") as unknown as MediaPayload;
  p.title = L("Кофе", "Qahva");
  p.duration_s = 20;
  p.transcript = [
    { t_start_ms: 0, t_end_ms: 3000, speaker: "A", text_en: "Hi!", gloss: L("Привет", "Salom") },
    { t_start_ms: 3000, t_end_ms: 6500, speaker: "B", text_en: "A latte, please.", gloss: L("Латте", "Latte") },
  ];
  p.rights.valid_from = "2026-01-01";
  return p;
}

describe("media rules", () => {
  const today = "2026-11-19";
  it("transcript: order, overlap, duration", () => {
    const p = media();
    expect(transcriptIssues(p.transcript, p.duration_s)).toEqual([]);
    p.transcript[1]!.t_start_ms = 2500;
    expect(codes(transcriptIssues(p.transcript, 20))).toEqual(["payload.transcript[1].t_start_ms:TRANSCRIPT_INVALID"]);
    p.transcript[1]!.t_start_ms = 3000;
    p.transcript[1]!.t_end_ms = 25_000;
    expect(codes(transcriptIssues(p.transcript, 20))).toEqual(["payload.transcript[1].t_end_ms:TRANSCRIPT_INVALID"]);
    expect(codes(transcriptIssues([], 20))).toEqual(["payload.transcript:TRANSCRIPT_INVALID"]);
  });
  it("rights: UZ territory, licence by origin, attribution for CC BY, term", () => {
    const p = media();
    expect(rightsIssues(p, today)).toEqual([]);
    p.rights.territories = ["KZ"];
    expect(codes(rightsIssues(p, today))).toEqual(["payload.rights.territories:RIGHTS_REQUIRED"]);
    p.rights.territories = ["UZ"];
    p.origin = "open_license";
    p.rights.license_type = "cc_by";
    expect(codes(rightsIssues(p, today))).toEqual(["payload.rights.attribution:RIGHTS_REQUIRED"]);
    p.rights.attribution = "© Author, CC BY 4.0";
    p.rights.valid_to = "2026-11-18";
    expect(codes(rightsIssues(p, today))).toEqual(["payload.rights.valid_to:RIGHTS_REQUIRED"]);
    p.origin = "own_recording";
    p.rights.valid_to = null;
    expect(codes(rightsIssues(p, today))).toEqual(["payload.rights.license_type:RIGHTS_REQUIRED"]);
  });
  it("external sources are closed; length 5..90 s", () => {
    const p = media();
    p.origin = "platform_embed";
    p.rights.license_type = "contract";
    p.rights.license_ref = "No. 1";
    p.duration_s = 120;
    const c = codes(validateMedia(p, today));
    expect(c).toContain("payload.origin:EXTERNAL_SOURCE_DISABLED");
    expect(c).toContain("payload.duration_s:MEDIA_TOO_LONG");
  });
  it("rights warning: expired / ≤ 14 days / open", () => {
    expect(rightsState("2026-11-18", today)).toBe("expired");
    expect(rightsState("2026-11-19", today)).toBe("expiring");
    expect(rightsState("2026-12-03", today)).toBe("expiring");
    expect(rightsState("2026-12-04", today)).toBe("ok");
    expect(rightsState(null, today)).toBe("open");
    expect(todayTashkent(Date.parse("2026-11-18T20:30:00Z"))).toBe("2026-11-19");
  });
  it("time codes in seconds", () => {
    expect(msToSec(3500)).toBe("3.5");
    expect(msToSec(0)).toBe("0.0");
    expect(msToSec(1234)).toBe("1.234");
    expect(secToMs("3,5")).toBe(3500);
    expect(secToMs("1:02.5")).toBe(62_500);
    expect(secToMs("abc")).toBeNull();
  });
  it("exercises: keys per type", () => {
    const x = emptyPayload("media_exercise", "mx", { asset_id: "m-own" }) as unknown as MediaExercisePayload;
    x.skill_id = "en.func.order";
    x.instruction = L("Ответьте", "Javob bering");
    x.prompt_en = "What does B order?";
    x.options = ["Tea", "Latte"];
    x.answer = 1;
    expect(validateExercise(x)).toEqual([]);
    expect(codes(validateExercise({ ...x, type: "order_lines", answer: [1, 1] }))).toEqual(["payload.answer:ANSWER_INVALID"]);
    expect(codes(validateExercise({ ...x, type: "gap_fill", prompt_en: "A latte", answer: ["latte"] }))).toEqual(["payload.prompt_en:ANSWER_INVALID"]);
    expect(codes(validateExercise({ ...x, type: "shadowing", line_index: null, answer: null }))).toEqual(["payload.line_index:ANSWER_INVALID"]);
  });
});

describe("audio upload: type, size, signature, base64", () => {
  const bytes = (...xs: number[]) => new Uint8Array(xs);
  const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  it("sniffs mp3 / ogg / m4a by their bytes", () => {
    expect(sniffAudio(ascii("ID3\u0004"))).toBe("audio/mpeg");
    expect(sniffAudio(bytes(0xff, 0xfb, 0x90))).toBe("audio/mpeg");
    expect(sniffAudio(ascii("OggS\u0000"))).toBe("audio/ogg");
    expect(sniffAudio(ascii("\u0000\u0000\u0000\u0018ftypM4A "))).toBe("audio/mp4");
    expect(sniffAudio(ascii("<html>"))).toBeNull();
  });
  it("accepts ≤ 3 MB of the declared type only", () => {
    expect(checkAudio({ name: "scene.mp3", size: 1000 }, ascii("ID3"))).toEqual({ ok: true, content_type: "audio/mpeg" });
    expect(checkAudio({ name: "scene.wav", size: 1000 }, ascii("RIFF"))).toEqual({ ok: false, reason: "type" });
    expect(checkAudio({ name: "scene.mp3", size: 3 * 1024 * 1024 + 1 }, ascii("ID3"))).toEqual({ ok: false, reason: "size" });
    expect(checkAudio({ name: "scene.ogg", size: 10 }, ascii("ID3"))).toEqual({ ok: false, reason: "signature" });
    expect(checkAudio({ name: "scene.m4a", size: 0 }, ascii(""))).toEqual({ ok: false, reason: "empty" });
  });
  it("base64 equals the standard encoding, also for big files", () => {
    const b = ascii("ID3 TilHero");
    expect(toBase64(b)).toBe(Buffer.from(b).toString("base64"));
    const big = new Uint8Array(200_000).map((_, i) => i % 251);
    expect(toBase64(big)).toBe(Buffer.from(big).toString("base64"));
  });
});

describe("skills, review diff, requests, routes", () => {
  it("prerequisite cycles", () => {
    const graph = { "s.b": ["s.c"], "s.c": ["s.a"] };
    expect(prereqCycle(graph, "s.a", ["s.b"])).toEqual(["s.a", "s.b", "s.c", "s.a"]);
    expect(prereqCycle(graph, "s.a", [])).toBeNull();
    const skill = { ...(emptyPayload("skill", "s.a") as never as Parameters<typeof validateSkill>[0]), title: L("Навык", "Koʻnikma"), description: L("Описание", "Tavsif"), prerequisites: ["s.b", "s.a"] };
    expect(codes(validateSkill(skill, graph))).toEqual(["payload.prerequisites[1]:PREREQ_CYCLE", "payload.prerequisites:PREREQ_CYCLE"]);
  });
  it("diff of the version under review against the published one", () => {
    const a = lesson();
    const b = lesson();
    b.title.uz = "Salom!";
    b.key_words.push({ en: "bye", gloss: L("пока", ""), example_en: "Bye!" });
    const d = diffPayload(a, b);
    expect(d.map((x) => x.path)).toEqual(["payload.title.uz", "payload.key_words[4].en", "payload.key_words[4].gloss.ru", "payload.key_words[4].gloss.uz", "payload.key_words[4].example_en"]);
    expect(d[0]).toEqual({ path: "payload.title.uz", before: "Salom", after: "Salom!", lang: "uz" });
    expect(d[3]).toMatchObject({ before: null, after: "", lang: "uz" });
    expect(diffPayload(null, { a: 1 })).toEqual([{ path: "payload.a", before: null, after: "1", lang: null }]);
  });
  it("only https links of learners can be opened by hand", () => {
    expect(safeLink("https://example.com/song?x=1")).toBe("https://example.com/song?x=1");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("http://example.com")).toBeNull();
    expect(safeLink("not a url")).toBeNull();
    expect(safeLink(null)).toBeNull();
  });
  it("content routes", () => {
    expect(parseContentRoute(null)).toEqual({ tab: null, sub: "assets", rest: null });
    expect(parseContentRoute("lessons/l-01")).toEqual({ tab: "lessons", sub: "assets", rest: "l-01" });
    expect(parseContentRoute("review/scenario/sc-cafe")).toEqual({ tab: "review", sub: "assets", rest: "scenario/sc-cafe" });
    expect(parseContentRoute("exercises/mx-1")).toEqual({ tab: "media", sub: "exercises", rest: "mx-1" });
    expect(parseContentRoute("bogus/x")).toEqual({ tab: null, sub: "assets", rest: null });
    expect(parseContentRoute("readings/r-a1-market")).toEqual({ tab: "readings", sub: "assets", rest: "r-a1-market" });
    expect(parseContentRoute("glossary/queue")).toEqual({ tab: "glossary", sub: "assets", rest: "queue" });
  });
  it("content tabs by role: the requests register needs media.rights, review needs content.review", () => {
    const tabs = (ps: Permission[]) => contentTabs((p) => ps.includes(p));
    // sprint 5: «Чтение» and «Словарь курса» are content.read tabs
    const READ = ["course", "lessons", "scenarios", "rubrics", "media", "readings", "glossary", "diagnostics"];
    for (const role of [["dashboard.read", "users.read", "content.read"], ["dashboard.read", "audit.read", "content.read"], ["dashboard.read", "users.read", "support.read", "config.read", "audit.read", "content.read"]] as Permission[][])
      expect(tabs(role)).toEqual(READ); // analyst, auditor, operations
    expect(tabs(["dashboard.read", "users.read", "content.read", "content.edit", "content.review", "content.publish"])).toEqual([...READ.slice(0, 7), "review", "diagnostics"]); // methodist
    expect(tabs(["dashboard.read", "content.read", "content.edit", "media.rights"])).toEqual([...READ.slice(0, 7), "requests", "diagnostics"]); // content_manager
    expect(tabs(["media.rights"])).toEqual([]); // no content.read — no section
  });
  it("coverage cells: none / one / enough", () => {
    expect([0, 1, 2, 6].map(coverageTone)).toEqual(["bad", "warn", "good", "good"]);
  });
});
