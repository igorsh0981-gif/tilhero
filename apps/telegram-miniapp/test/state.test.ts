import { describe, expect, it } from "vitest";
import { consentPurposes } from "../src/state/consent";
import { keyForDraft } from "../src/state/idempotency";
import { interestChips, PROTOTYPE_INTEREST_CODES } from "../src/state/directory";
import { interests as taxonomy } from "../e2e/fixtures/data";
import { initialNav, navReducer, rootTab, topRoute } from "../src/state/nav";
import { initialPinFlow, isWeakPin, pinFormatError, pinFull, pinNeed, pinReducer } from "../src/state/pin";
import {
  addDeparture,
  addEntity,
  budgetFromContract,
  budgetState,
  budgetToContract,
  draftFromPreferences,
  MAX_DEPARTURES,
  preferencesPatch,
  removeDeparture,
  sanitizeAmountInput,
  setHorizon,
  stepValid,
  toggleBudget,
  toggleGeo,
  toggleRemind,
  type PrefDraft,
} from "../src/state/prefs";

const draft = (o: Partial<PrefDraft> = {}): PrefDraft => ({ ...draftFromPreferences(null), ...o });

describe("budget: «Свой» — $ is fixed, the field accepts digits only (BR-TG-003, AT-22)", () => {
  it("keeps digits only, without leading zeros, max 6", () => {
    expect(sanitizeAmountInput("1a5$0,0")).toBe("1500");
    expect(sanitizeAmountInput("$ 2 500.99")).toBe("250099");
    expect(sanitizeAmountInput("000120")).toBe("120");
    expect(sanitizeAmountInput("-300")).toBe("300");
    expect(sanitizeAmountInput("12345678")).toBe("123456");
    expect(sanitizeAmountInput("abc")).toBe("");
  });

  it("validates the state of the budget", () => {
    expect(budgetState({ budget: [], custom: "" })).toBe("none");
    expect(budgetState({ budget: ["500_1000"], custom: "" })).toBe("ok");
    expect(budgetState({ budget: ["custom"], custom: "" })).toBe("need");
    expect(budgetState({ budget: ["custom"], custom: "0" })).toBe("need");
    expect(budgetState({ budget: ["custom"], custom: "1500" })).toBe("ok");
    expect(budgetState({ budget: ["custom"], custom: "49" })).toBe("min");
    expect(budgetState({ budget: ["custom"], custom: "50" })).toBe("ok");
    expect(budgetState({ budget: ["custom"], custom: "100000" })).toBe("ok");
    expect(budgetState({ budget: ["custom"], custom: "250000" })).toBe("max");
  });

  it("custom is exclusive with ranges; ranges keep their order", () => {
    let d = toggleBudget(draft(), "1000_2000");
    d = toggleBudget(d, "under_500");
    expect(d.budget).toEqual(["under_500", "1000_2000"]);
    d = toggleBudget(d, "custom");
    expect(d.budget).toEqual(["custom"]);
    d = toggleBudget(d, "500_1000");
    expect(d.budget).toEqual(["500_1000"]);
  });

  it("maps to the contract (one preset or a span) and back", () => {
    expect(budgetToContract({ budget: ["500_1000"], custom: "" })).toEqual({ currency: "USD", preset: "500_1000", min: 500, max: 1000, custom_amount: null });
    expect(budgetToContract({ budget: ["500_1000", "1000_2000"], custom: "" })).toEqual({ currency: "USD", preset: null, min: 500, max: 2000, custom_amount: null });
    expect(budgetToContract({ budget: ["custom"], custom: "1500" })).toEqual({ currency: "USD", preset: "custom", min: null, max: null, custom_amount: 1500 });
    expect(budgetFromContract({ currency: "USD", preset: null, min: 500, max: 2000, custom_amount: null }).budget).toEqual(["500_1000", "1000_2000"]);
    expect(budgetFromContract({ currency: "USD", preset: "custom", min: null, max: null, custom_amount: 2500 })).toEqual({ budget: ["custom"], custom: "2500" });
  });
});

describe("preference draft", () => {
  it("departures start empty and are never pre-filled (BR-TG-004, AT-20)", () => {
    expect(draftFromPreferences(null).deps).toEqual([]);
  });

  it("adds and removes airports, no duplicates, at most 10 (AT-21)", () => {
    let d = draft();
    d = addDeparture(d, { airport_iata: "TAS", city: "Tashkent", country_code: "UZ" });
    d = addDeparture(d, { airport_iata: "TAS", city: "Tashkent", country_code: "UZ" });
    expect(d.deps).toHaveLength(1);
    for (let i = 0; i < 15; i++) d = addDeparture(d, { airport_iata: `X${i}`, city: `C${i}`, country_code: "UZ" });
    expect(d.deps).toHaveLength(MAX_DEPARTURES);
    d = removeDeparture(d, "TAS");
    expect(d.deps.some((x) => x.airport_iata === "TAS")).toBe(false);
  });

  it("«Весь мир» is exclusive with countries and regions", () => {
    let d = toggleGeo(draft(), "country:AE");
    d = toggleGeo(d, "region:europe");
    d = toggleGeo(d, "world");
    expect(d.geo).toEqual(["world"]);
    d = toggleGeo(d, "country:TR");
    expect(d.geo).toEqual(["country:TR"]);
    for (let i = 0; i < 40; i++) d = toggleGeo(d, `country:Z${i}`);
    expect(d.geo).toHaveLength(30); // preferences domain: MAX_GEOGRAPHIES
  });

  it("reminders never exceed the horizon (TG-FR-015)", () => {
    let d = draft({ horizon: 12, remind: [3, 6, 12] });
    d = setHorizon(d, 6);
    expect(d.remind).toEqual([3, 6]);
    expect(toggleRemind(d, 12).remind).toEqual([3, 6]);
    expect(toggleRemind(d, 1).remind).toEqual([1, 3, 6]);
  });

  it("entities are trimmed, case-insensitively unique", () => {
    let d = addEntity(draft(), "  Formula   1 ");
    d = addEntity(d, "formula 1");
    expect(d.entities).toEqual(["Formula 1"]);
  });

  it("validates onboarding steps (18+ and consent both required)", () => {
    expect(stepValid(draft(), 2)).toBe(false);
    expect(stepValid(draft({ entities: ["Coldplay"] }), 2)).toBe(true);
    expect(stepValid(draft(), 3)).toBe(false);
    expect(stepValid(draft({ budget: ["custom"], custom: "" }), 4)).toBe(false);
    expect(stepValid(draft(), 5)).toBe(false);
    expect(stepValid(draft(), 6, { age: true, ok: false })).toBe(false);
    expect(stepValid(draft(), 6, { age: false, ok: true })).toBe(false);
    expect(stepValid(draft(), 6, { age: true, ok: true })).toBe(true);
  });

  it("builds a PATCH with only the requested sections and the version", () => {
    const d = draft({ geo: ["world", "country:AE"], format: "both", direct: false });
    expect(preferencesPatch(d, ["geo", "flights"], 7)).toEqual({
      geographies: [{ level: "world" }, { level: "country", code: "AE" }],
      strong_events_outside_geo: true,
      event_formats: ["offline", "online"],
      flight_prefs: { direct: false, connecting: true, alternative_departure: true },
      version: 7,
    });
    expect(preferencesPatch(draft({ budget: ["custom"], custom: "" }), ["budget"])).toEqual({});
  });
});

describe("PIN rules and keypad flow", () => {
  it("rejects weak PINs", () => {
    for (const p of ["0000", "1111", "1234", "4321", "123456", "987654", "7890", "1212", "121212"]) expect(isWeakPin(p), p).toBe(true);
    for (const p of ["2580", "4826", "905172", "1357"]) expect(isWeakPin(p), p).toBe(false);
    expect(pinFormatError("12a4", 4)).toBe("digits");
    expect(pinFormatError("123", 4)).toBe("length");
    expect(pinFormatError("2580", 4)).toBeNull();
  });

  it("accepts digits up to the needed length; length switch only when creating", () => {
    let s = initialPinFlow("set", null);
    expect(s.stage).toBe("new");
    s = pinReducer(s, { type: "len", len: 6 });
    expect(pinNeed(s)).toBe(6);
    for (const d of "9051721") s = pinReducer(s, { type: "digit", d });
    expect(s.entry).toBe("905172");
    expect(pinFull(s)).toBe(true);
    s = pinReducer(s, { type: "digit", d: "x" });
    expect(s.entry).toBe("905172");
    s = pinReducer(s, { type: "erase" });
    expect(s.entry).toBe("90517");

    let c = initialPinFlow("change", 6);
    expect(c.stage).toBe("cur");
    expect(pinNeed(c)).toBe(6);
    c = pinReducer(c, { type: "len", len: 4 });
    expect(c.len).toBe(4);
    expect(pinNeed(c)).toBe(6);
  });

  it("ignores input while busy or shaking, clears after settle", () => {
    let s = initialPinFlow("unlock", 4);
    for (const d of "1111") s = pinReducer(s, { type: "digit", d });
    s = pinReducer(s, { type: "fail", err: "wrong" });
    expect(s.shake).toBe(true);
    expect(pinReducer(s, { type: "digit", d: "1" }).entry).toBe("1111");
    s = pinReducer(s, { type: "settle" });
    expect(s.entry).toBe("");
    expect(s.err).toBe("wrong");
    s = pinReducer(s, { type: "digit", d: "2" });
    expect(s.err).toBeNull();
  });

  it("reset flow: code (6) → new → rep", () => {
    let s = initialPinFlow("reset", 4);
    expect(s.stage).toBe("code");
    expect(pinNeed(s)).toBe(6);
    s = pinReducer(s, { type: "advance", stage: "new", patch: { code: "314159" } });
    expect(s.code).toBe("314159");
    expect(s.entry).toBe("");
    s = pinReducer(s, { type: "advance", stage: "rep", patch: { first: "2580" } });
    expect(s.first).toBe("2580");
  });
});

describe("navigation reducer (BackButton ↔ stack)", () => {
  it("push / pop / replace / tab / reset", () => {
    let s = initialNav("home");
    s = navReducer(s, { type: "tab", tab: "profile" });
    expect(rootTab(s)).toBe("profile");
    s = navReducer(s, { type: "push", route: { name: "supportList" } });
    s = navReducer(s, { type: "push", route: { name: "supportThread", id: "a" } });
    expect(s.stack).toHaveLength(3);
    expect(s.anim).toBe("push");
    s = navReducer(s, { type: "pop" });
    expect(topRoute(s)).toEqual({ name: "supportList" });
    expect(s.anim).toBe("pop");
    s = navReducer(s, { type: "replace", route: { name: "supportNew" } });
    expect(s.stack.map((r) => r.name)).toEqual(["profile", "supportNew"]);
    s = navReducer(s, { type: "reset", stack: [{ name: "profile" }, { name: "supportList" }, { name: "supportThread", id: "b" }] });
    expect(s.stack).toHaveLength(3);
    s = navReducer(s, { type: "tab", tab: "home" });
    expect(s.stack).toEqual([{ name: "home" }]);
  });

  it("ignores no-ops: pop at root, same tab, double push", () => {
    const s0 = initialNav("home");
    expect(navReducer(s0, { type: "pop" })).toBe(s0);
    expect(navReducer(s0, { type: "tab", tab: "home" })).toBe(s0);
    const s1 = navReducer(s0, { type: "push", route: { name: "supportThread", id: "x" } });
    expect(navReducer(s1, { type: "push", route: { name: "supportThread", id: "x" } })).toBe(s1);
    expect(navReducer(s1, { type: "push", route: { name: "supportThread", id: "y" } }).stack).toHaveLength(3);
    expect(navReducer(s0, { type: "reset", stack: [] })).toBe(s0);
  });

  it("every transition bumps seq (screen key / scroll reset)", () => {
    let s = initialNav();
    const seqs = [s.seq];
    s = navReducer(s, { type: "tab", tab: "watch" });
    seqs.push(s.seq);
    s = navReducer(s, { type: "push", route: { name: "supportNew" } });
    seqs.push(s.seq);
    expect(seqs).toEqual([0, 1, 2]);
  });
});

describe("consent purposes", () => {
  const policy = {
    purposes: [
      { code: "personalization", required: true, title: "", description: "" },
      { code: "notifications", required: false, title: "", description: "" },
      { code: "research", required: false, title: "", description: "" },
    ],
  };
  it("required ones always, notifications only when the user opted in, other optional never implicitly", () => {
    expect(consentPurposes(policy, { notifications: false })).toEqual(["personalization"]);
    expect(consentPurposes(policy, { notifications: true })).toEqual(["personalization", "notifications"]);
    expect(consentPurposes(null, { notifications: true })).toEqual([]);
  });
});

describe("interest chips", () => {
  it("prototype chips first (in prototype order), then the remaining leaves; parents only when they are a chip", () => {
    const chips = interestChips(taxonomy).map((c) => c.code);
    expect(chips.slice(0, 12)).toEqual([...PROTOTYPE_INTEREST_CODES]);
    expect(chips).toContain("music.jazz");
    expect(chips).not.toContain("music");
    expect(new Set(chips).size).toBe(chips.length);
  });
  it("skips codes the directory does not know", () => {
    const chips = interestChips([{ code: "sport.tennis", parent: "sport", label: { ru: "Теннис", en: "Tennis" }, icon: "flag" }]);
    expect(chips.map((c) => c.code)).toEqual(["sport.tennis"]);
  });
});

describe("Idempotency-Key per draft content (review 🟡-10)", () => {
  it("same content keeps the key, any edit makes a new one, reverting to old content gets yet another", () => {
    let n = 0;
    const make = () => `k${++n}`;
    const draft = { category: "FLIGHT", subject: "Не вижу рейсов", message: "Текст" };
    const a = keyForDraft(null, draft, make);
    expect(keyForDraft(a, { ...draft }, make)).toBe(a);
    const b = keyForDraft(a, { ...draft, message: "Текст!" }, make);
    expect(b.key).toBe("k2");
    expect(keyForDraft(b, { ...draft, category: "BUG" }, make).key).toBe("k3");
    expect(keyForDraft(b, "reply text", make).key).toBe("k4");
  });
  it("uses UUID v4 keys by default", () => {
    expect(keyForDraft(null, "x").key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
