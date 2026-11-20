/**
 * Sprint 5 logic: the course dictionary form (forms one per line, normalisation, RU/UZ checks, the PATCH of changed
 * fields, 422 GLOSSARY_INVALID mapped to fields, which actions an entry offers) and «Память» (routes, tabs by
 * permission, actions by card status, the reschedule date 1..365 days, reason ≥ 10, overdue).
 */
import { describe, expect, it } from "vitest";
import type { GlossaryDetail } from "@tilhero/contracts/admin";
import { checkEntry, createBody, emptyForm, entryActions, formOf, historyChanges, parseForms, patchBody, refRoute, serverIssues } from "../src/screens/content/glossary";
import { parseGlossaryRoute } from "../src/screens/content/GlossaryTab";
import { ApiError } from "../src/api/errors";
import { actionBody, allowedActions, cardTitle, CommandKey, commandSig, daysUntil, isOverdue, localDate, memoryTabs, outcomeUnknown, parseMemoryRoute, rateShown, rescheduleDueAt } from "../src/screens/memory/model";

const UID = "a1000000-0000-4000-8000-000000000001";
const CARD = "c1000000-0000-4000-8000-000000000001";
const ENTRY = { lemma: "by the way", forms: ["by the way", "btw"], part_of_speech: "phrase" as const, gloss: { ru: "кстати", uz: "aytgancha" }, example_en: null };

describe("course dictionary form", () => {
  it("forms: one per line (a comma stays inside a form), normalised, unique by key; empty → the lemma", () => {
    expect(parseForms("Excuse me, where…\nexcuse me where\n  BTW  \n", "x")).toEqual(["excuse me, where", "btw"]);
    expect(parseForms("", "  Coffee Shop ")).toEqual(["coffee shop"]);
    expect(parseForms("", "")).toEqual([]);
  });
  it("checks: lemma, forms ≤ 8, RU/UZ required ≤ 80, UZ in Latin with ʻ, example ≤ 200", () => {
    const ok = { ...emptyForm(), lemma: "bakery", ru: "пекарня", uz: "novvoyxona" };
    expect(checkEntry(ok)).toEqual([]);
    const bad = { ...emptyForm(), lemma: "", forms: Array.from({ length: 9 }, (_, i) => `f${i}`).join("\n"), ru: "", uz: "пекарня", example_en: "x".repeat(201) };
    expect(checkEntry(bad).map((x) => `${x.field}:${x.code}`)).toEqual(["lemma:required", "forms:too_many", "ru:required", "uz:uz_script", "example_en:too_long"]);
    expect(checkEntry({ ...ok, uz: "o'qish" }).map((x) => x.code)).toEqual(["uz_okina"]);
    expect(checkEntry({ ...ok, ru: "к".repeat(81) }).map((x) => x.code)).toEqual(["too_long"]);
    expect(checkEntry({ ...ok, forms: "булочная" }).map((x) => `${x.field}:${x.code}`)).toEqual(["forms:en_only"]);
  });
  it("create body: pair, trimmed values, null for the empty example and reason", () => {
    expect(createBody("ru-en", { ...emptyForm(), lemma: " bakery ", ru: " пекарня ", uz: "novvoyxona", part_of_speech: "noun" })).toEqual({
      pair_id: "ru-en",
      lemma: "bakery",
      forms: ["bakery"],
      part_of_speech: "noun",
      gloss: { ru: "пекарня", uz: "novvoyxona" },
      example_en: null,
      reason: null,
    });
  });
  it("patch body: only what changed (+ reason); nothing changed → null", () => {
    const f = formOf(ENTRY);
    expect(patchBody(ENTRY, f)).toBeNull();
    expect(patchBody(ENTRY, { ...f, ru: "между прочим", reason: "точнее" })).toEqual({ gloss: { ru: "между прочим", uz: "aytgancha" }, reason: "точнее" });
    expect(patchBody(ENTRY, { ...f, forms: "by the way" })).toEqual({ forms: ["by the way"], reason: null });
    expect(patchBody(ENTRY, { ...f, example_en: "By the way, hi." })).toEqual({ example_en: "By the way, hi.", reason: null });
  });
  it("422 GLOSSARY_INVALID {errors[{path}]} lands at the fields (override paths too)", () => {
    expect(serverIssues([{ path: "forms[1]", code: "LOCALE_SCRIPT", message: "Формы — на изучаемом языке (EN)" }, { path: "override.gloss.uz", code: "LOCALE_SCRIPT", message: "латиница" }, { path: "pair_id", code: "UNKNOWN_REF", message: "нет пары" }]).map((x) => `${x.field}:${x.message}`)).toEqual([
      "forms:Формы — на изучаемом языке (EN)",
      "uz:латиница",
      "pair_id:нет пары",
    ]);
    expect(serverIssues(null)).toEqual([]);
  });
  it("actions: course — override only; methodist — edit and archive; ai pending — review; nothing without glossary.manage or when archived", () => {
    const e = (p: Partial<GlossaryDetail>) => ({ source: "course", review_status: "not_required", archived_at: null, override: null, ...p }) as GlossaryDetail;
    expect(entryActions(e({}), true)).toEqual({ edit: false, override: true, unoverride: false, review: false, archive: false });
    expect(entryActions(e({ override: { gloss: { ru: "a", uz: "b" }, example_en: null, by: "x", at: "y" } }), true).unoverride).toBe(true);
    expect(entryActions(e({ source: "methodist" }), true)).toEqual({ edit: true, override: false, unoverride: false, review: false, archive: true });
    expect(entryActions(e({ source: "ai", review_status: "pending" }), true)).toMatchObject({ edit: true, review: true, archive: false });
    expect(entryActions(e({ source: "ai", review_status: "rejected" }), true)).toMatchObject({ edit: false, review: false });
    expect(Object.values(entryActions(e({ source: "methodist" }), false)).some(Boolean)).toBe(false);
    expect(Object.values(entryActions(e({ source: "methodist", archived_at: "2026-11-20T00:00:00Z" }), true)).some(Boolean)).toBe(false);
  });
  it("references open in their content tab; history shows changed leaves only", () => {
    expect(refRoute({ kind: "reading", key: "r-a1-coffee-shop" })).toBe("readings/r-a1-coffee-shop");
    expect(refRoute({ kind: "media_asset", key: "m-1" })).toBe("media/m-1");
    expect(refRoute({ kind: "lesson", key: "l-1" })).toBe("lessons/l-1");
    expect(refRoute({ kind: "scenario", key: "sc-1" })).toBe("scenarios/sc-1");
    expect(historyChanges({ gloss: { ru: "а", uz: "b" } }, { gloss: { ru: "в", uz: "b" } })).toEqual([{ field: "gloss.ru", before: "а", after: "в" }]);
    expect(historyChanges(null, { lemma: "x", forms: ["x", "y"] })).toEqual([
      { field: "lemma", before: "—", after: "x" },
      { field: "forms", before: "—", after: "x, y" },
    ]);
  });
  it("routes of the dictionary tab: list, queue, an entry in either", () => {
    expect(parseGlossaryRoute(null)).toEqual({ view: "all", entry: null });
    expect(parseGlossaryRoute("queue")).toEqual({ view: "queue", entry: null });
    expect(parseGlossaryRoute("queue/61000000-0000-4000-8000-000000000005")).toEqual({ view: "queue", entry: "61000000-0000-4000-8000-000000000005" });
    expect(parseGlossaryRoute("61000000-0000-4000-8000-00000000000A")).toEqual({ view: "all", entry: "61000000-0000-4000-8000-00000000000a" });
    expect(parseGlossaryRoute("bogus")).toEqual({ view: "all", entry: null });
  });
});

describe("memory", () => {
  it("routes: analytics, learner lookup, a learner, a card of the learner; bad ids are dropped", () => {
    expect(parseMemoryRoute(null)).toEqual({ tab: null, user: null, card: null });
    expect(parseMemoryRoute("analytics")).toEqual({ tab: "analytics", user: null, card: null });
    expect(parseMemoryRoute("learners")).toEqual({ tab: "learners", user: null, card: null });
    expect(parseMemoryRoute(`learners/${UID}/${CARD}`)).toEqual({ tab: "learners", user: UID, card: CARD });
    expect(parseMemoryRoute(`learners/not-a-uuid/${CARD}`)).toEqual({ tab: "learners", user: null, card: null });
  });
  it("tabs: analytics for memory.read or dashboard.read; a learner's memory for memory.read only", () => {
    const can = (ps: string[]) => (p: string) => ps.includes(p);
    expect(memoryTabs(can(["dashboard.read"]))).toEqual(["analytics"]);
    expect(memoryTabs(can(["memory.read"]))).toEqual(["analytics", "learners"]);
    expect(memoryTabs(can([]))).toEqual([]);
  });
  it("actions by status: unfreeze only frozen; nothing for archived; reset not for new", () => {
    expect(allowedActions("review")).toEqual({ reschedule: true, reset: true, freeze: true, unfreeze: false });
    expect(allowedActions("frozen")).toEqual({ reschedule: false, reset: true, freeze: false, unfreeze: true });
    expect(allowedActions("new")).toMatchObject({ reset: false, freeze: true });
    expect(Object.values(allowedActions("archived")).some(Boolean)).toBe(false);
  });
  it("reschedule: a date 1..365 days ahead → noon of that local day; today, the past and day 366 are refused", () => {
    const now = new Date(2026, 10, 20, 15, 30).getTime();
    expect(daysUntil(localDate(now), now)).toBe(0);
    expect(daysUntil("2026-11-21", now)).toBe(1);
    expect(daysUntil("2026-02-30", now)).toBeNaN();
    expect(rescheduleDueAt("2026-11-21", now)).toBe(new Date(2026, 10, 21, 12, 0, 0, 0).toISOString());
    // the value depends on the chosen day only, not on the moment of the render: a retry sends the same body
    const later = new Date(2026, 10, 20, 23, 59).getTime();
    expect(rescheduleDueAt("2026-12-01", later)).toBe(rescheduleDueAt("2026-12-01", now));
    expect(new Date(rescheduleDueAt("2026-12-01", now)!).getHours()).toBe(12);
    expect(rescheduleDueAt(localDate(now), now)).toBeNull();
    expect(rescheduleDueAt("2026-11-19", now)).toBeNull();
    const d365 = localDate(now + 365 * 86_400_000);
    const d366 = localDate(now + 366 * 86_400_000);
    expect(rescheduleDueAt(d365, now)).not.toBeNull();
    expect(rescheduleDueAt(d366, now)).toBeNull();
  });
  it("action body: reason 10..300 trimmed; reschedule needs the due moment", () => {
    expect(actionBody("freeze", "короткая", null)).toBeNull();
    expect(actionBody("freeze", "  Ученик в отпуске две недели  ", null)).toEqual({ action: "freeze", reason: "Ученик в отпуске две недели" });
    expect(actionBody("reschedule", "Ученик попросил перенести", null)).toBeNull();
    expect(actionBody("reschedule", "Ученик попросил перенести", "2026-11-25T10:00:00.000Z")).toEqual({ action: "reschedule", due_at: "2026-11-25T10:00:00.000Z", reason: "Ученик попросил перенести" });
    expect(actionBody("reset", "x".repeat(301), null)).toBeNull();
  });
  it("an error card shows the label of its code, never a text (its correction came from the learner's answer)", () => {
    const L = (ru: string, uz: string) => ({ ru, uz });
    expect(cardTitle({ kind: "word", text_en: "queue", gloss: L("очередь", "navbat"), error_code: null })).toEqual({ text: "queue", lang: "en", label: false });
    expect(cardTitle({ kind: "error", text_en: null, gloss: L("Порядок слов", "So'z tartibi"), error_code: "word_order" })).toEqual({ text: "Порядок слов", lang: "ru", label: true });
    // even a text that slipped through for an error card is not shown
    expect(cardTitle({ kind: "error", text_en: "I would like a large coffee", gloss: L("", ""), error_code: "word_order" })).toEqual({ text: "word_order", lang: undefined, label: true });
    expect(cardTitle({ kind: "error", text_en: null, gloss: L("", ""), error_code: null }).text).toBe("—");
  });
  it("Idempotency-Key of a manual action: kept after a network failure / 5xx, new after a 4xx or a success or another command", () => {
    let n = 0;
    const keys = new CommandKey(() => `k${++n}`);
    const freeze = commandSig("c1", { action: "freeze", reason: "Ученик в отпуске две недели" });
    const k1 = keys.for(freeze);
    keys.settle(new ApiError(0, null, "network"));
    expect(keys.for(freeze)).toBe(k1);
    keys.settle(new ApiError(502, { code: "UPSTREAM_UNAVAILABLE" }));
    expect(keys.for(freeze)).toBe(k1);
    // the staff member changed the reason — another command, another key
    const other = commandSig("c1", { action: "freeze", reason: "Ученик в отпуске три недели" });
    const k2 = keys.for(other);
    expect(k2).not.toBe(k1);
    keys.settle(new ApiError(409, { code: "CARD_STATE" }));
    expect(keys.current).toBeNull();
    expect(keys.for(other)).not.toBe(k2);
    keys.settle();
    expect(keys.current).toBeNull();
    expect(outcomeUnknown(new ApiError(403, { code: "STEP_UP_REQUIRED" }))).toBe(false);
    expect(outcomeUnknown(new ApiError(500, null))).toBe(true);
    expect(outcomeUnknown(new TypeError("x"))).toBe(true);
  });
  it("overdue: learning / review with a past due date only", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(isOverdue({ status: "review", due_at: "2026-11-20T11:00:00Z" }, now)).toBe(true);
    expect(isOverdue({ status: "frozen", due_at: "2026-11-01T11:00:00Z" }, now)).toBe(false);
    expect(isOverdue({ status: "learning", due_at: "2026-11-21T11:00:00Z" }, now)).toBe(false);
    expect(isOverdue({ status: "new", due_at: "2026-11-01T11:00:00Z" }, now)).toBe(false);
  });
  it("analytics: a hidden group (< 5 learners) is never shown as a value", () => {
    expect(rateShown({ scheduled: 0, passed: 0, failed: 0, pass_pct: null, hidden: true })).toBe(false);
    expect(rateShown({ scheduled: 4, passed: 0, failed: 4, pass_pct: 0, hidden: false })).toBe(true);
    expect(rateShown({ scheduled: 0, passed: 0, failed: 0, pass_pct: null, hidden: false })).toBe(false);
  });
});
