/**
 * Sprint 5 in the Mini App, pure parts: the WAV of «Произнести» (header, 16 kHz, mono, 16 bit, duration, the 15 s cap),
 * the tiles of «Собери» and the typed answer, the review player reducer (feedback, the check block without feedback,
 * a lost answer kept), the «Повторение дня» card, who may record, the targets, the tappable words of a reading text.
 */
import type { MemoryOverview, ReviewSession, ReviewTask, ReviewTaskResult } from "@tilhero/contracts/bff";
import { describe, expect, it } from "vitest";
import { failureOf } from "../src/audio/recorder";
import { concatChunks, encodeWav, level, MAX_RECORD_MS, MAX_WAV_BYTES, mixToMono, resample, toWav, WAV_HEADER_BYTES, wavInfo } from "../src/audio/wav";
import { ApiError } from "../src/api/errors";
import {
  cardTarget,
  daysUntil,
  initialReview,
  isLetterTiles,
  isRetryableReview,
  pronunciationAccess,
  readingRef,
  reviewCardState,
  reviewMinutes,
  reviewProgress,
  reviewReducer,
  sentencePieces,
  sentenceTarget,
  splitBlank,
  tilesAnswer,
  tilesFree,
  tilesPick,
  tilesStart,
  tilesText,
  tilesUndo,
  tilesUnpick,
  typedAnswer,
  wordMark,
  type ReviewState,
} from "../src/domain/memory";
import { routeTarget } from "../src/state/nav";

/* ================================================================ WAV */

/** jsdom's Blob has no arrayBuffer(): read it the old way */
const blobBytes = (b: Blob) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(b);
  });
const ascii = (u: Uint8Array, at: number, n: number) => String.fromCharCode(...u.slice(at, at + n));
const sine = (rate: number, seconds: number, hz = 440, amp = 0.5) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

describe("WAV encoder", () => {
  it("writes the canonical 44-byte header: RIFF/WAVE, PCM, mono, 16 000 Hz, 16 bit", () => {
    const buf = encodeWav(new Float32Array(16_000), 16_000);
    const u = new Uint8Array(buf);
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(WAV_HEADER_BYTES + 32_000);
    expect(ascii(u, 0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 32_000);
    expect(ascii(u, 8, 4)).toBe("WAVE");
    expect(ascii(u, 12, 4)).toBe("fmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(28, true)).toBe(32_000); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(u, 36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(32_000);
  });

  it("samples are little-endian int16, clamped to −1..1", () => {
    const buf = encodeWav(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    const v = new DataView(buf);
    const s = (i: number) => v.getInt16(WAV_HEADER_BYTES + i * 2, true);
    expect([s(0), s(1), s(2), s(3), s(4)]).toEqual([0, 32767, -32768, 32767, -32768]);
    expect(s(5)).toBe(16384);
  });

  it("wavInfo reads the header back (duration from the data size); not a WAV → null", () => {
    const info = wavInfo(encodeWav(new Float32Array(8_000)));
    expect(info).toEqual({ format: 1, channels: 1, sampleRate: 16_000, bitsPerSample: 16, dataBytes: 16_000, durationMs: 500 });
    expect(wavInfo(new ArrayBuffer(10))).toBeNull();
    expect(wavInfo(new TextEncoder().encode("ID3".padEnd(64, "x")).buffer)).toBeNull();
  });

  it("toWav: a 48 kHz recording becomes 16 kHz mono of the same duration", async () => {
    const r = toWav(sine(48_000, 1), 48_000);
    expect(r.wav.type).toBe("audio/wav");
    expect(r.durationMs).toBe(1000);
    expect(r.bytes).toBe(WAV_HEADER_BYTES + 32_000);
    const bytes = await blobBytes(r.wav);
    expect(bytes.byteLength).toBe(r.bytes);
    const info = wavInfo(bytes.buffer as ArrayBuffer)!;
    expect(info.sampleRate).toBe(16_000);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.durationMs).toBe(1000);
  });

  it("44.1 kHz is resampled too; the length is round(n · 16000 / from)", () => {
    expect(resample(new Float32Array(44_100), 44_100).length).toBe(16_000);
    expect(resample(new Float32Array(22_050), 44_100).length).toBe(8_000);
    // up-sampling interpolates
    const up = resample(Float32Array.from([0, 1]), 8_000, 16_000);
    expect(up.length).toBe(4);
    expect(up[1]).toBeCloseTo(0.5);
    // the same rate is passed through
    const same = new Float32Array(10);
    expect(resample(same, 16_000)).toBe(same);
    expect(() => resample(same, 0)).toThrow(RangeError);
  });

  it("down-sampling keeps a constant signal (box filter) and damps a tone above the new Nyquist", () => {
    const dc = resample(new Float32Array(4_800).fill(0.25), 48_000);
    expect(Math.max(...dc.map((x) => Math.abs(x - 0.25)))).toBeLessThan(1e-6);
    const high = resample(sine(48_000, 0.1, 12_000), 48_000);
    expect(level(high)).toBeLessThan(level(sine(48_000, 0.1, 12_000)));
  });

  it("the recording is cut at 15 s: at most 480 044 bytes — under the 600 000 of the BFF", () => {
    const r = toWav(new Float32Array(48_000 * 20), 48_000);
    expect(r.durationMs).toBe(MAX_RECORD_MS);
    expect(r.bytes).toBe(WAV_HEADER_BYTES + 15 * 32_000);
    expect(r.bytes).toBeLessThanOrEqual(MAX_WAV_BYTES);
  });

  it("stereo is mixed to mono; chunks are joined in order; the level is 0..1", () => {
    expect(Array.from(mixToMono([Float32Array.from([1, 0.5]), Float32Array.from([0, 0.5])]))).toEqual([0.5, 0.5]);
    expect(mixToMono([])).toHaveLength(0);
    expect(Array.from(concatChunks([Float32Array.from([1, 2]), Float32Array.from([3])]))).toEqual([1, 2, 3]);
    expect(level(new Float32Array(100))).toBe(0);
    expect(level(new Float32Array(100).fill(1))).toBe(1);
    expect(level(new Float32Array(0))).toBe(0);
  });

  it("a getUserMedia refusal says why (no loop of prompts: the reason is shown)", () => {
    expect(failureOf(new DOMException("x", "NotAllowedError"))).toBe("denied");
    expect(failureOf(new DOMException("x", "SecurityError"))).toBe("denied");
    expect(failureOf(new DOMException("x", "NotFoundError"))).toBe("no_device");
    expect(failureOf(new DOMException("x", "NotReadableError"))).toBe("no_device");
    expect(failureOf(new Error("x"))).toBe("failed");
  });
});

/* ================================================================ tiles and typing */

describe("«Собери»: tiles", () => {
  const letters = ["b", "t", "e", "a", "l"];
  it("pick adds to the end, a tile is used once, out of range is ignored", () => {
    let s = tilesStart();
    s = tilesPick(s, 1, 5);
    s = tilesPick(s, 3, 5);
    expect(tilesPick(s, 1, 5)).toBe(s);
    expect(tilesPick(s, 7, 5)).toBe(s);
    expect(tilesPick(s, -1, 5)).toBe(s);
    expect(s.picked).toEqual([1, 3]);
    expect(tilesFree(s, 5)).toEqual([0, 2, 4]);
  });
  it("undo returns the last tile; tapping a tile of the answer returns it from anywhere", () => {
    let s = { picked: [1, 3, 0] };
    s = tilesUndo(s);
    expect(s.picked).toEqual([1, 3]);
    expect(tilesUnpick({ picked: [1, 3, 0] }, 3).picked).toEqual([1, 0]);
    expect(tilesUnpick(s, 4)).toBe(s);
    expect(tilesUndo(tilesStart()).picked).toEqual([]);
  });
  it("the answer is the order of all tiles; letters join without spaces, words with spaces", () => {
    const s = { picked: [1, 3, 0, 4, 2] };
    expect(tilesText(s, letters)).toBe("table");
    expect(tilesAnswer(s, 5)).toEqual({ order: [1, 3, 0, 4, 2] });
    expect(tilesAnswer({ picked: [1, 3] }, 5)).toBeNull();
    expect(tilesAnswer(tilesStart(), 0)).toBeNull();
    expect(isLetterTiles(letters)).toBe(true);
    expect(isLetterTiles(["red", "apple"])).toBe(false);
    expect(tilesText({ picked: [1, 0] }, ["apple", "red"])).toBe("red apple");
  });
  it("the same letter twice stays two different tiles", () => {
    const yellow = ["l", "e", "w", "y", "l", "o"];
    let s = tilesStart();
    for (const i of [3, 1, 0, 4, 5, 2]) s = tilesPick(s, i, 6);
    expect(tilesText(s, yellow)).toBe("yellow");
    expect(tilesAnswer(s, 6)).toEqual({ order: [3, 1, 0, 4, 5, 2] });
  });
});

describe("typed answer", () => {
  it("is trimmed, whitespace collapsed, NFC, ≤ 200; empty is no answer", () => {
    expect(typedAnswer("  to   go ")).toEqual({ text: "to go" });
    expect(typedAnswer("   ")).toBeNull();
    expect(typedAnswer("")).toBeNull();
    expect(typedAnswer("café")).toEqual({ text: "café" });
    expect(typedAnswer("a".repeat(250))!.text).toHaveLength(200);
  });
  it("the gap of a prompt is split for highlighting", () => {
    expect(splitBlank("A latte ___, please.")).toEqual(["A latte ", ", please."]);
    expect(splitBlank("no gap")).toBeNull();
    expect(splitBlank(null)).toBeNull();
  });
});

/* ================================================================ Home card */

const ov = (o: Partial<MemoryOverview> = {}): MemoryOverview => ({
  due_count: 5, new_available: 1, retention_due: 1, done_today: false, active_session_id: null, next_due_at: null, total_cards: 24, pronunciation: "available", ...o,
});

describe("«Повторение дня» card", () => {
  it("continue / start / done / empty", () => {
    expect(reviewCardState(ov({ active_session_id: "s1" }))).toEqual({ kind: "continue", sessionId: "s1", due: 5, fresh: 1, checks: 1 });
    expect(reviewCardState(ov())).toEqual({ kind: "start", due: 5, fresh: 1, checks: 1, doneToday: false });
    expect(reviewCardState(ov({ due_count: 0, new_available: 0, retention_due: 0, done_today: true, next_due_at: "2026-11-21T14:00:00Z" }))).toEqual({ kind: "done", nextDueAt: "2026-11-21T14:00:00Z" });
    expect(reviewCardState(ov({ due_count: 0, new_available: 0, retention_due: 0, total_cards: 0 }))).toEqual({ kind: "empty", nextDueAt: null, total: 0 });
    // more cards came after today's review (a new lesson): start again
    expect(reviewCardState(ov({ done_today: true, due_count: 2, new_available: 0, retention_due: 0 })).kind).toBe("start");
  });
  it("minutes: 0.4 per card, 2..15", () => {
    expect(reviewMinutes(0)).toBe(0);
    expect(reviewMinutes(1)).toBe(2);
    expect(reviewMinutes(10)).toBe(4);
    expect(reviewMinutes(100)).toBe(15);
  });
  it("days until a date", () => {
    const now = Date.parse("2026-11-20T10:00:00Z");
    expect(daysUntil("2026-11-23T09:00:00Z", now)).toBe(3);
    expect(daysUntil("2026-11-19T09:00:00Z", now)).toBe(0);
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil("bad", now)).toBeNull();
  });
  it("route_review opens «Повторение дня» above the «Словарь» tab", () => {
    const home = { tab: "home" as const, stack: [] };
    expect(routeTarget("review", home)).toEqual({ tab: "review", stack: [{ name: "review" }] });
    const there = routeTarget("review", home);
    expect(routeTarget("review", there)).toBe(there);
  });
});

/* ================================================================ pronunciation */

describe("«Произнести»", () => {
  it("who may record: available — record; consent_self; guardian — a teen or a child; unavailable — hidden", () => {
    const self = { kind: "self" as const };
    const child = { kind: "child" as const };
    expect(pronunciationAccess("available", self)).toBe("record");
    expect(pronunciationAccess("available", child)).toBe("record");
    expect(pronunciationAccess("consent_self", self)).toBe("consent_self");
    expect(pronunciationAccess("consent_guardian", self)).toBe("consent_teen");
    expect(pronunciationAccess("consent_guardian", child)).toBe("consent_child");
    expect(pronunciationAccess("unavailable", self)).toBe("hidden");
    expect(pronunciationAccess(null, self)).toBe("hidden");
  });
  it("targets: a card or a sentence of published content", () => {
    expect(cardTarget("c1")).toBe("card:c1");
    expect(sentenceTarget(readingRef({ reading_id: "rd-cafe", version: 2 }, "s3"))).toBe("sentence:reading:rd-cafe:2:s3");
  });
  it("words of the result: accent is not an error — only low accuracy, omission, insertion", () => {
    expect(wordMark({ word: "a", accuracy: 95, error_type: "none" })).toBe("ok");
    expect(wordMark({ word: "a", accuracy: 70, error_type: "none" })).toBe("ok");
    expect(wordMark({ word: "a", accuracy: 40, error_type: "none" })).toBe("practice");
    expect(wordMark({ word: "a", accuracy: 40, error_type: "mispronunciation" })).toBe("practice");
    expect(wordMark({ word: "a", accuracy: null, error_type: "omission" })).toBe("missed");
    expect(wordMark({ word: "a", accuracy: null, error_type: "insertion" })).toBe("extra");
  });
});

/* ================================================================ reading */

describe("reading: tappable words", () => {
  const glossary = [{ en: "latte" }, { en: "to go" }, { en: "the bill" }, { en: "I’d like" }];
  const words = (s: string) => sentencePieces(s, glossary).filter((p) => p.kind === "word");
  it("every word is a piece; glossary terms (one or several words) are one highlighted piece", () => {
    const p = sentencePieces("He orders a latte to go.", glossary);
    expect(p.map((x) => x.text).join("")).toBe("He orders a latte to go.");
    expect(words("He orders a latte to go.").map((w) => [w.text, w.kind === "word" ? w.term : null])).toEqual([
      ["He", null], ["orders", null], ["a", null], ["latte", 0], ["to go", 1],
    ]);
  });
  it("case and apostrophes do not matter; punctuation stays plain text", () => {
    const w = words("I'd like The Bill, please!");
    expect(w.map((x) => x.text)).toEqual(["I'd like", "The Bill", "please"]);
    expect(w.map((x) => (x.kind === "word" ? x.term : null))).toEqual([3, 2, null]);
    expect(sentencePieces("Hi, Tom!", []).filter((x) => x.kind === "text").map((x) => x.text)).toEqual([", ", "!"]);
  });
  it("a multi-word term never jumps over punctuation", () => {
    const w = words("Where to. Go home.");
    expect(w.map((x) => x.text)).toEqual(["Where", "to", "Go", "home"]);
    expect(w.every((x) => x.kind === "word" && x.term === null)).toBe(true);
  });
  it("numbers and quotes are not words; contractions and hyphens are", () => {
    expect(words("At 9 “Have a nice day!” — well-known").map((x) => x.text)).toEqual(["At", "Have", "a", "nice", "day", "well-known"]);
  });
});

/* ================================================================ the review player */

const SESSION: ReviewSession = { session_id: "s1", status: "active", total_tasks: 3, done_tasks: 0, cards: 2, new_cards: 0, checks: 1, started_at: "2026-11-20T10:00:00Z", finished_at: null, minutes: 0 };
const task = (o: Partial<ReviewTask> = {}): ReviewTask => ({
  task_id: "t1", index: 1, total: 3, type: "typed", card_id: "c1", check: null,
  prompt: { text_en: null, gloss: { ru: "с собой", uz: "olib ketish uchun" }, example_en: null, example_gap: "A latte ___.", speech_text: null, explanation: null, evidence: null, instruction: null, prompt_en: null },
  options: [], tiles: [], answer_kind: "text", hints: ["first_letter", "reveal"], hints_used: [], voice: "en-GB", ...o,
});
const result = (o: Partial<ReviewTaskResult> = {}): ReviewTaskResult => ({ result: "correct", correct_answer: null, next_review_in_days: 4, requeued: false, check_result: null, next: null, ...o });
const loaded = (t: ReviewTask | null = task()): ReviewState => reviewReducer(initialReview, { type: "loaded", session: SESSION, task: t });

describe("review player reducer", () => {
  it("answer → feedback until «Дальше» → the next task", () => {
    let s = loaded();
    expect(s.phase).toBe("ready");
    s = reviewReducer(s, { type: "send", taskId: "t1", body: { text: "to go" } });
    expect(s.phase).toBe("sending");
    const next = task({ task_id: "t2", index: 2 });
    s = reviewReducer(s, { type: "result", result: result({ next }) });
    expect(s.phase).toBe("feedback");
    expect(s.task?.task_id).toBe("t1");
    expect(s.pending).toBeNull();
    s = reviewReducer(s, { type: "advance" });
    expect(s.phase).toBe("ready");
    expect(s.task?.task_id).toBe("t2");
    expect(s.result).toBeNull();
  });
  it("the last task → done (finish)", () => {
    let s = reviewReducer(loaded(), { type: "result", result: result({ result: "incorrect", correct_answer: "to go", requeued: true, next: null }) });
    s = reviewReducer(s, { type: "advance" });
    expect(s.phase).toBe("done");
    expect(reviewReducer(loaded(null), { type: "advance" }).phase).toBe("done");
  });
  it("intro and an answer inside a check block: no feedback, the next task at once; the check counts «принят»", () => {
    const intro = loaded(task({ type: "intro", answer_kind: "none" }));
    const s1 = reviewReducer(intro, { type: "result", result: result({ result: null, next_review_in_days: null, next: task({ task_id: "t2" }) }) });
    expect(s1.phase).toBe("ready");
    expect(s1.task?.task_id).toBe("t2");
    expect(s1.accepted).toBe(0);
    const chk = loaded(task({ type: "check_item", hints: [], check: { check_id: "k", skill_title: { ru: "x", uz: "x" }, position: 1, of: 3 } }));
    const s2 = reviewReducer(chk, { type: "result", result: result({ result: null, correct_answer: null, next_review_in_days: null, next: task({ task_id: "t2" }) }) });
    expect(s2.phase).toBe("ready");
    expect(s2.accepted).toBe(1);
  });
  it("the end of a check block shows its result (checkDone) before the next task", () => {
    const chk = loaded(task({ type: "check_item", hints: [], check: { check_id: "k", skill_title: { ru: "x", uz: "x" }, position: 3, of: 3 } }));
    const cr = { passed: true, correct: 2, total: 3, items: [] };
    let s = reviewReducer(chk, { type: "result", result: result({ result: null, check_result: cr, next: task({ task_id: "t4" }) }) });
    expect(s.phase).toBe("checkDone");
    expect(s.result?.check_result).toEqual(cr);
    s = reviewReducer(s, { type: "advance" });
    expect(s.task?.task_id).toBe("t4");
  });
  it("a lost answer stays pending for «Отправить ещё раз»; another error drops it", () => {
    let s = reviewReducer(loaded(), { type: "send", taskId: "t1", body: { text: "to go" } });
    s = reviewReducer(s, { type: "sendFailed", error: new ApiError(0, "NETWORK", "x") });
    expect(s.phase).toBe("ready");
    expect(s.pending).toEqual({ taskId: "t1", body: { text: "to go" } });
    expect(s.error?.kind).toBe("send");
    s = reviewReducer(s, { type: "failed", error: { kind: "action", error: new ApiError(422, "ANSWER_INVALID", "x") } });
    expect(s.pending).toBeNull();
  });
  it("hints: the first letter and the revealed answer stay on the task; a new task starts clean", () => {
    let s = reviewReducer(loaded(), { type: "hint", hint: { kind: "first_letter", text: "t…" } });
    s = reviewReducer(s, { type: "hint", hint: { kind: "reveal", text: "to go" } });
    expect([s.firstLetter, s.revealed]).toEqual(["t…", "to go"]);
    s = reviewReducer(s, { type: "task", task: task({ task_id: "t2" }) });
    expect([s.firstLetter, s.revealed]).toEqual([null, null]);
  });
  it("advance only from feedback / checkDone; closed; finishFailed returns to done", () => {
    const s = loaded();
    expect(reviewReducer(s, { type: "advance" })).toBe(s);
    expect(reviewReducer(s, { type: "closed" }).phase).toBe("closed");
    expect(reviewReducer(reviewReducer(s, { type: "finishing" }), { type: "finishFailed", error: new Error("x") }).phase).toBe("done");
  });
  it("retry: network, 5xx, 429 — yes; business codes — no", () => {
    expect(isRetryableReview(new ApiError(0, "NETWORK", ""))).toBe(true);
    expect(isRetryableReview(new ApiError(503, "UPSTREAM_UNAVAILABLE", ""))).toBe(true);
    expect(isRetryableReview(new ApiError(429, "RATE_LIMITED", ""))).toBe(true);
    expect(isRetryableReview(new ApiError(409, "TASK_NOT_CURRENT", ""))).toBe(false);
  });
  it("progress counts answered tasks of the growing total", () => {
    expect(reviewProgress(task({ index: 4, total: 11 }), SESSION)).toEqual({ done: 3, total: 11 });
    expect(reviewProgress(null, { ...SESSION, done_tasks: 2, total_tasks: 3 })).toEqual({ done: 2, total: 3 });
    expect(reviewProgress(null, null)).toEqual({ done: 0, total: 0 });
  });
});
