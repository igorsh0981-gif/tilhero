import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGE_SEGMENTS,
  AUDIENCES,
  checkTexts,
  emptyNote,
  LANGS,
  missingIn,
  nextSlug,
  NOTE_ICONS,
  NOTE_LIMITS,
  NOTE_ROUTES,
  normalizeSegment,
  placeholdersIn,
  serverIssues,
  SLUG,
  substitute,
  validateCampaign,
  validateNote,
  emptyCampaign,
} from "../src/screens/news/catalog";

const CATALOG = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/contracts/release-notes.json"), "utf8")) as {
  locales: string[];
  audiences: string[];
  segments: { age: string[]; ui_lang: string[] };
  routes: string[];
  icons: string[];
  limits: { slug_pattern: string; title_max: number; item_title_max: number; item_text_max: number; items_min: number; items_max: number; client_max_notes: number };
};

describe("«Что нового» catalogue = packages/contracts/release-notes.json", () => {
  it("routes, icons, audiences, segments, languages and limits match", () => {
    expect([...NOTE_ROUTES]).toEqual(CATALOG.routes);
    expect([...NOTE_ICONS]).toEqual(CATALOG.icons);
    expect([...AUDIENCES]).toEqual(CATALOG.audiences);
    expect([...AGE_SEGMENTS]).toEqual(CATALOG.segments.age);
    expect([...LANGS]).toEqual(CATALOG.locales);
    expect(SLUG.source).toBe(CATALOG.limits.slug_pattern);
    expect(NOTE_LIMITS).toMatchObject({ title: CATALOG.limits.title_max, itemTitle: CATALOG.limits.item_title_max, itemText: CATALOG.limits.item_text_max, itemsMin: CATALOG.limits.items_min, itemsMax: CATALOG.limits.items_max, clientMaxNotes: CATALOG.limits.client_max_notes });
  });
});

describe("note validation (server paths)", () => {
  it("reports empty translations per language with the server paths", () => {
    const d = emptyNote("2026.12");
    d.title.ru = "Декабрь";
    d.items[0]!.title.ru = "Голос";
    d.items[0]!.text.ru = "Говорим вслух";
    const issues = validateNote(d);
    expect(missingIn(issues, "uz").sort()).toEqual(["items[0].text.uz", "items[0].title.uz", "title.uz"]);
    expect(missingIn(issues, "ru")).toEqual([]);
  });
  it("lengths, slug, control characters, items 1..6", () => {
    const d = emptyNote("bad slug");
    d.title = { ru: "x".repeat(81), uz: "ok" };
    d.items[0] = { title: { ru: "a", uz: "b‮c" }, text: { ru: "t", uz: "t" }, link: "home", icon: "spark" };
    const i = validateNote(d);
    expect(i.slug?.reason).toBe("invalid_format");
    expect(i["title.ru"]).toEqual({ reason: "too_long", max: 80 });
    expect(i["items[0].title.uz"]?.reason).toBe("control_chars");
    d.items = [];
    expect(validateNote(d).items?.reason).toBe("required");
  });
  it("next free «YYYY.MM» label", () => {
    const now = new Date("2026-11-18T10:00:00Z");
    expect(nextSlug([], now)).toBe("2026.11");
    expect(nextSlug(["2026.11", "2026.11-2"], now)).toBe("2026.11-3");
  });
});

describe("422 details → field issues", () => {
  it("RELEASE_NOTE_TRANSLATION_MISSING {missing}", () => {
    expect(serverIssues({ missing: ["items[1].text.uz", "title.uz"] })).toEqual({ "items[1].text.uz": { reason: "required" }, "title.uz": { reason: "required" } });
  });
  it("TEMPLATE_INVALID / CAMPAIGN_INVALID {fields}", () => {
    expect(serverIssues({ fields: [{ path: "texts.uz.body", reason: "unknown_placeholder" }, { path: "texts.ru.title", reason: "weird" }] })).toEqual({
      "texts.uz.body": { reason: "unknown_placeholder" },
      "texts.ru.title": { reason: "server" },
    });
  });
  it("VALIDATION_ERROR {errors[{loc}]} and {field}", () => {
    expect(serverIssues({ errors: [{ loc: ["body", "items", 2, "link"], type: "literal_error" }], field: "slug" })).toEqual({ "items[2].link": { reason: "server" }, slug: { reason: "server" } });
  });
  it("ignores junk", () => {
    expect(serverIssues({ fields: [{ path: 42 }, null], missing: "x" })).toEqual({});
  });
});

describe("template texts (notifications texts.py rules)", () => {
  it("placeholders with str.format semantics", () => {
    expect(placeholdersIn("Hi {learner_name}, {{literal}} at {slot_time}")).toEqual({ names: ["learner_name", "slot_time"], invalid: [] });
    expect(placeholdersIn("{x.y} {0} {a:>5} {").invalid).toEqual(["{x.y}", "{0}", "{a:>5}", "{"]);
    expect(placeholdersIn("lonely } brace").invalid).toEqual(["}"]);
  });
  it("unknown / invalid placeholders, required languages, lengths, pressure in child templates", () => {
    const texts = { ru: { title: "Пора, {learner_name}", body: "Урок в {slot_time}. {bonus}", button: null }, uz: { title: "", body: "Dars {slot_time} da", button: "x".repeat(33) } };
    const i = checkTexts(texts, ["learner_name", "slot_time"]);
    expect(i["texts.ru.body"]).toEqual({ reason: "unknown_placeholder", names: ["bonus"] });
    expect(i["texts.uz.title"]).toEqual({ reason: "required" });
    expect(i["texts.uz.button"]).toEqual({ reason: "too_long", max: 32 });
    expect(i["texts.ru.button"]).toBeUndefined();
    const kid = checkTexts({ ru: { title: "Урок", body: "Не потеряй серию!", button: null }, uz: { title: "Dars", body: "Seriyani yo'qotma!", button: null } }, [], true);
    expect(kid["texts.ru.body"]?.reason).toBe("pressure_words");
    expect(kid["texts.uz.body"]?.reason).toBe("pressure_words"); // the apostrophe variants are normalised
  });
  it("live preview substitution", () => {
    expect(substitute("{learner_name},  урок в {slot_time} {{x}}", { learner_name: "Мадина", slot_time: "19:30" })).toBe("Мадина, урок в 19:30 {x}");
    expect(substitute("Привет, {learner_name}!", { learner_name: "" })).toBe("Привет, !");
  });
});

describe("campaigns", () => {
  it("only {learner_name}; title required; activity 1..90", () => {
    const c = emptyCampaign();
    c.texts.ru = { title: "{learner_name}", body: "Привет, {first_name}", button: null };
    c.segment.active_days = 120;
    const i = validateCampaign(c);
    expect(i.title?.reason).toBe("required");
    expect(i["texts.ru.body"]).toEqual({ reason: "unknown_placeholder", names: ["first_name"] });
    expect(i["segment.active_days"]?.reason).toBe("invalid_format");
  });
  it("segment normalisation never carries children", () => {
    expect(normalizeSegment({ ui_lang: ["uz", "ru"], age: ["adults", "teens"], onboarded: false, active_days: 0 })).toEqual({ ui_lang: ["ru", "uz"], age: ["teens", "adults"], onboarded: false });
    expect(normalizeSegment({ age: ["kids" as never, "adults"] })).toEqual({ age: ["adults"] });
  });
});
