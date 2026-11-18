import { describe, expect, it } from "vitest";
import type { Source } from "@tilhero/contracts/admin";
import { translate } from "../src/i18n";
import type { MessageKey } from "../src/i18n/ru";
import { fmtAmount, fmtPriceRange, fmtUsd, normalizePrice, priceCents, ratio, roundDecimal } from "../src/lib/money";
import { countryName, domainOf, fmtLocalDate, httpsUrl, msToUtcMidnight, reasonHint, reasonLabel, reasonTone, runErrorLabel } from "../src/screens/catalog/common";
import { budgetLevel, groupErrors } from "../src/screens/discovery/Discovery";
import { buildCorrection, changeField, formFromFacts, readFacts, rebaseForm } from "../src/screens/review/facts";
import { fmtConfidence, rightsLabel, rowSeverity } from "../src/screens/review/Review";
import { CITY_MAX, cleanDomain, domainProblem, emptyForm, emptyPage, formFromSource, hostMatches, inputFromForm, pageProblem, patchFromForm, rebaseSourceForm, validateSource } from "../src/screens/sources/validate";
import { fieldLabel } from "../src/screens/sources/Sources";

const tRu = (k: MessageKey) => translate("ru", k);
const tEn = (k: MessageKey) => translate("en", k);

describe("money formatting (AI cost $0.4213, budget $1.00)", () => {
  it("rounds decimal strings half-up without floats", () => {
    expect(roundDecimal("0.4213", 4)).toBe("0.4213");
    expect(roundDecimal("0.42135", 4)).toBe("0.4214");
    expect(roundDecimal("0.99995", 4)).toBe("1.0000");
    expect(roundDecimal("1", 2)).toBe("1.00");
    expect(roundDecimal("12.345", 2)).toBe("12.35");
    expect(roundDecimal("0.1", 4)).toBe("0.1000");
    expect(roundDecimal("abc", 2)).toBeNull();
    expect(roundDecimal("1e3", 2)).toBeNull();
    expect(roundDecimal(null, 2)).toBeNull();
  });
  it("formats USD with 4 digits for AI cost and 2 for the budget", () => {
    expect(fmtUsd("0.4213", 4)).toBe("$0.4213");
    expect(fmtUsd("0.0000", 4)).toBe("$0.0000");
    expect(fmtUsd("1.00", 2)).toBe("$1.00");
    expect(fmtUsd("1", 2)).toBe("$1.00");
    expect(fmtUsd("-0.5", 2)).toBe("−$0.50");
    expect(fmtUsd("", 2)).toBe("—");
    expect(fmtUsd(undefined, 4)).toBe("—");
  });
  it("meter ratio is clamped and safe", () => {
    expect(ratio("0.4213", "1.00")).toBeCloseTo(0.4213);
    expect(ratio("2", "1")).toBe(1);
    expect(ratio("1", "0")).toBe(0);
    expect(ratio("x", "1")).toBe(0);
  });
  it("normalizes typed prices to the catalogue money format", () => {
    expect(normalizePrice("150 000")).toBe("150000.00");
    expect(normalizePrice("99,5")).toBe("99.50");
    expect(normalizePrice("0012.3")).toBe("12.30");
    expect(normalizePrice("0")).toBe("0.00");
    expect(normalizePrice("1.234")).toBeNull();
    expect(normalizePrice("-5")).toBeNull();
    expect(normalizePrice("12$")).toBeNull();
    expect(priceCents("10.00") > priceCents("9.50")).toBe(true);
  });
});

describe("review reasons and severity", () => {
  it("maps reason codes to human labels in RU and EN; unknown codes stay visible", () => {
    expect(reasonLabel(tRu, "LOW_CONFIDENCE")).toBe("Низкая уверенность");
    expect(reasonLabel(tEn, "SOURCE_CONFLICT")).toBe("Sources disagree");
    expect(reasonLabel(tRu, "CATALOG_REJECTED")).toBe("Каталог не принял");
    expect(reasonLabel(tEn, "SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(reasonHint(tRu, "SOURCE_CONFLICT")).toMatch(/того же ранга/);
    expect(reasonHint(tRu, "SOMETHING_NEW")).toBeUndefined();
  });
  it("tone and row severity: rejected by the catalog > conflict > weak evidence", () => {
    expect(reasonTone("CATALOG_REJECTED")).toBe("bad");
    expect(reasonTone("SOURCE_CONFLICT")).toBe("warn");
    expect(reasonTone("LOW_CONFIDENCE")).toBe("info");
    expect(reasonTone("UNKNOWN")).toBe("neutral");
    expect(rowSeverity(["LOW_CONFIDENCE", "CATALOG_REJECTED"])).toBe("sev-bad");
    expect(rowSeverity(["LOW_CONFIDENCE", "SOURCE_CONFLICT"])).toBe("sev-warn");
    expect(rowSeverity(["LOW_CONFIDENCE"])).toBe("sev-info");
    expect(rowSeverity([])).toBe("sev-info");
  });
  it("confidence is shown with 2 digits and clamped", () => {
    expect(fmtConfidence(0.537)).toBe("0.54");
    expect(fmtConfidence(1.4)).toBe("1.00");
    expect(fmtConfidence(Number.NaN)).toBe("—");
  });
  it("discovery error codes have labels", () => {
    expect(runErrorLabel(tRu, "AI_BUDGET_EXHAUSTED")).toBe("Бюджет AI на сутки исчерпан");
    expect(runErrorLabel(tEn, "PROVIDER_PAUSED")).toBe("AI search stopped by the kill switch");
    expect(runErrorLabel(tEn, "NEW_CODE")).toBe("NEW_CODE");
  });
});

describe("URLs, domains and dates", () => {
  it("renders only https URLs as links/images", () => {
    expect(httpsUrl("https://iticket.uz/e/1")?.hostname).toBe("iticket.uz");
    expect(httpsUrl("http://iticket.uz/e/1")).toBeNull();
    expect(httpsUrl("javascript:alert(1)")).toBeNull();
    expect(httpsUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(httpsUrl("//evil.example/x")).toBeNull();
    expect(httpsUrl(`https://a.uz/${"x".repeat(3000)}`)).toBeNull();
  });
  it("shows the domain of a page without www", () => {
    expect(domainOf("https://www.afisha.uz/ru/concerts")).toBe("afisha.uz");
    expect(domainOf("not a url")).toBe("—");
  });
  it("the event's local date is never shifted by the browser time zone", () => {
    expect(fmtLocalDate("ru", "2026-10-24")).toBe("24.10.2026");
    expect(fmtLocalDate("en", "2026-01-01")).toBe("01/01/2026");
    expect(fmtLocalDate("ru", "garbage")).toBe("garbage");
  });
  it("the AI budget day ends at 00:00 UTC", () => {
    expect(msToUtcMidnight(Date.parse("2026-10-10T23:30:00Z"))).toBe(30 * 60_000);
    expect(msToUtcMidnight(Date.parse("2026-10-10T00:00:00Z"))).toBe(24 * 3_600_000);
  });
  it("country names come from Intl in the UI language", () => {
    expect(countryName("ru", "UZ")).toBe("Узбекистан");
    expect(countryName("en", "GE")).toBe("Georgia");
    expect(countryName("en", null)).toBe("—");
    expect(countryName("en", "<b>")).toBe("<b>");
  });
});

describe("source form validation (same rules as source-registry)", () => {
  it("domains: no IP, no public suffix, wildcard only for media", () => {
    expect(domainProblem("iticket.uz", false)).toBeNull();
    expect(domainProblem("cdn.iticket.az", false)).toBeNull();
    expect(domainProblem("*.cdn.iticket.az", true)).toBeNull();
    expect(domainProblem("*.cdn.iticket.az", false)).toBe("wildcard");
    expect(domainProblem("uz", false)).toBe("format");
    expect(domainProblem("co.uk", false)).toBe("suffix");
    expect(domainProblem("com.kz", true)).toBe("suffix");
    expect(domainProblem("10.0.0.1", false)).toBe("ip");
    expect(domainProblem("localhost", false)).toBe("format");
    expect(domainProblem("Iticket.UZ", false)).toBe("format");
    expect(domainProblem("iticket.uz.", false)).toBe("format");
    expect(domainProblem("-bad.uz", false)).toBe("format");
    expect(cleanDomain(" HTTPS://WWW.Iticket.UZ/ru/events?x=1 ")).toBe("www.iticket.uz");
  });
  it("hosts match a source domain or its sub-domains; *.x only sub-domains", () => {
    expect(hostMatches("iticket.uz", "iticket.uz")).toBe(true);
    expect(hostMatches("www.iticket.uz", "iticket.uz")).toBe(true);
    expect(hostMatches("eviliticket.uz", "iticket.uz")).toBe(false);
    expect(hostMatches("iticket.uz.evil.com", "iticket.uz")).toBe(false);
    expect(hostMatches("a.cdn.x.kz", "*.cdn.x.kz")).toBe(true);
    expect(hostMatches("cdn.x.kz", "*.cdn.x.kz")).toBe(false);
  });
  it("listing pages: https, port 443, host within the event domains", () => {
    const d = ["afisha.uz"];
    expect(pageProblem({ url: "https://www.afisha.uz/ru/concerts" }, d)).toBeNull();
    expect(pageProblem({ url: "http://afisha.uz/x" }, d)).toBe("pageHttps");
    expect(pageProblem({ url: "https://afisha.uz:8443/x" }, d)).toBe("pagePort");
    expect(pageProblem({ url: "https://other.uz/x" }, d)).toBe("pageDomain");
    expect(pageProblem({ url: "afisha.uz/x" }, d)).toBe("pageUrl");
    expect(pageProblem({ url: "" }, d)).toBe("pageUrl");
  });
  it("fix 9.1: Telegram channel pages — t.me/s/<channel>, t.me among the event domains, t.me only as a channel", () => {
    const d = ["t.me", "ticketon.kz"];
    expect(pageProblem({ url: "https://t.me/s/freedom_ticketon", kind: "telegram" }, d)).toBeNull();
    expect(pageProblem({ url: "https://t.me/s/freedom_ticketon/", kind: "telegram" }, d)).toBeNull();
    expect(pageProblem({ url: "https://t.me/freedom_ticketon", kind: "telegram" }, d)).toBe("pageTelegram");
    expect(pageProblem({ url: "https://t.me/s/abc", kind: "telegram" }, d)).toBe("pageTelegram");
    expect(pageProblem({ url: "https://ticketon.kz/almaty", kind: "telegram" }, d)).toBe("pageTelegram");
    expect(pageProblem({ url: "https://t.me/s/freedom_ticketon", kind: "html" }, d)).toBe("pageTelegramKind");
    expect(pageProblem({ url: "https://t.me/s/freedom_ticketon", kind: "telegram" }, ["ticketon.kz"])).toBe("pageDomain");
    expect(pageProblem({ url: "https://www.t.me/s/freedom_ticketon", kind: "telegram" }, d)).toBe("pageTelegram");
    const f = { ...emptyForm(), slug: "tg-x", name: "TG", country_code: "KZ", event_domains: ["t.me"], reason: "new",
      listing_pages: [{ ...emptyPage(), url: "https://t.me/s/sxodim", city: "Almaty", kind: "telegram" as const, priority: "low" as const }] };
    expect(validateSource(f, true)).toEqual({});
    expect(inputFromForm(f).listing_pages).toEqual([{ url: "https://t.me/s/sxodim", city: "Almaty", category: null, kind: "telegram", priority: "low" }]);
    expect(emptyPage()).toEqual({ url: "", city: "", category: "", kind: "html", priority: "normal" });
  });
  it("fix 9.1: pages of a pre-9.1 source (no kind/priority) are not a change; priority edits are", () => {
    const s: Source = {
      source_id: "s1", slug: "afisha-uz", name: "Afisha.uz", country_code: "UZ", tier: "TRUSTED_MEDIA", event_domains: ["afisha.uz"], media_domains: [],
      listing_pages: [{ url: "https://afisha.uz/c", city: null, category: null }], enabled: true, js_only: false, notes: null, version: 7, created_at: "", updated_at: "", updated_by: null, updated_by_name: null,
    };
    const f = formFromSource(s);
    expect(f.listing_pages[0]).toMatchObject({ kind: "html", priority: "normal" });
    expect(patchFromForm(s, { ...f, reason: "x" }).changed).toEqual([]);
    const low = patchFromForm(s, { ...f, listing_pages: [{ ...f.listing_pages[0]!, priority: "low" }], reason: "r" });
    expect(low.changed).toEqual(["listing_pages"]);
    expect(low.stepUp).toBe(false);
  });
  it("collects field errors; the reason is mandatory", () => {
    const f = { ...emptyForm(), slug: "Bad Slug", event_domains: [], listing_pages: [{ kind: "html" as const, priority: "normal" as const, url: "https://x.uz/a", city: "", category: "nope" }] };
    expect(validateSource(f, true)).toEqual({ slug: "slug", name: "name", event_domains: "domainsEmpty", "page.0": "pageDomain", reason: "reason" });
    const ok = { ...emptyForm(), slug: "kassir-kg", name: "Kassir", event_domains: ["kassir.kg"], listing_pages: [{ kind: "html" as const, priority: "normal" as const, url: "https://kassir.kg/a", city: "Bishkek", category: "music.concerts" }], reason: "new" };
    expect(validateSource(ok, true)).toEqual({});
    expect(validateSource({ ...ok, listing_pages: [{ kind: "html" as const, priority: "normal" as const, url: "https://kassir.kg/a", city: "", category: "nope" }] }, true)).toEqual({ "page.0": "pageCategory" });
    // город страницы — как source-registry CITY_MAX = 80 (пробелы по краям не считаются)
    expect(CITY_MAX).toBe(80);
    expect(validateSource({ ...ok, listing_pages: [{ kind: "html" as const, priority: "normal" as const, url: "https://kassir.kg/a", city: `  ${"Г".repeat(80)}  `, category: "" }] }, true)).toEqual({});
    expect(validateSource({ ...ok, listing_pages: [{ kind: "html" as const, priority: "normal" as const, url: "https://kassir.kg/a", city: "Г".repeat(81), category: "" }] }, true)).toEqual({ "page.0": "pageCity" });
    // slug is not validated on edit (it cannot change)
    expect(validateSource({ ...ok, slug: "" }, false)).toEqual({});
    expect(inputFromForm({ ...ok, js_only: "", notes: "  " })).toMatchObject({ js_only: null, notes: null, listing_pages: [{ url: "https://kassir.kg/a", city: "Bishkek", category: "music.concerts" }] });
  });
  it("PATCH carries only changed fields; step-up only for domains / enabled / tier", () => {
    const s: Source = {
      source_id: "s1", slug: "afisha-uz", name: "Afisha.uz", country_code: "UZ", tier: "TRUSTED_MEDIA", event_domains: ["afisha.uz"], media_domains: [],
      listing_pages: [{ url: "https://afisha.uz/c", city: null, category: null }], enabled: true, js_only: false, notes: null, version: 7, created_at: "", updated_at: "", updated_by: null, updated_by_name: null,
    };
    const f = formFromSource(s);
    expect(patchFromForm(s, { ...f, reason: "x" }).changed).toEqual([]);
    const a = patchFromForm(s, { ...f, name: "Afisha", notes: "n", reason: " rename " });
    expect(a.body).toEqual({ expected_version: 7, name: "Afisha", notes: "n", reason: "rename" });
    expect(a.stepUp).toBe(false);
    expect(patchFromForm(s, { ...f, enabled: false, reason: "off" }).stepUp).toBe(true);
    expect(patchFromForm(s, { ...f, tier: "OFFICIAL_ORGANIZER", reason: "r" }).stepUp).toBe(true);
    expect(patchFromForm(s, { ...f, media_domains: ["cdn.afisha.uz"], reason: "r" }).stepUp).toBe(true);
    expect(patchFromForm(s, { ...f, listing_pages: [], reason: "r" }).stepUp).toBe(false);
    expect("slug" in patchFromForm(s, { ...f, slug: "other", reason: "r" }).body).toBe(false);
  });
  it("field names are human in the step-up note and the change log", () => {
    expect(fieldLabel(tRu, "event_domains")).toBe("домены событий");
    expect(fieldLabel(tEn, "enabled")).toBe("on/off");
    expect(fieldLabel(tEn, "other_field")).toBe("other_field");
  });
});

describe("review correction", () => {
  const raw = {
    title: "Концерт",
    start: { local_date: "2026-10-24", local_time: "19:00:00" },
    venue: { name: "Дворец", city: "Tashkent", country_code: "UZ", address: null },
    online: false,
    categories: ["music.concerts", 5],
    price_range: { min: "100.00", max: "200.00", currency: "UZS" },
  };
  it("reads untrusted facts defensively", () => {
    const f = readFacts(raw);
    expect(f.start).toEqual({ local_date: "2026-10-24", local_time: "19:00" });
    expect(f.categories).toEqual(["music.concerts"]);
    expect(f.price).toEqual({ min: "100.00", max: "200.00", currency: "UZS" });
    const junk = readFacts({ title: { x: 1 }, start: "tomorrow", venue: [1], online: "yes", price_range: { min: 1 } } as unknown as Record<string, unknown>);
    expect(junk).toEqual({ title: "", start: null, end: null, venue: null, online: false, price: null, categories: [], official_url: null });
    expect(readFacts(null).title).toBe("");
  });
  it("sends only the facts that changed, with normalized prices", () => {
    const facts = readFacts(raw);
    const base = { ...formFromFacts(facts), basisUrl: "https://iticket.uz/e/1", note: "ok!" };
    expect(buildCorrection(facts, base)).toEqual({ changes: null, errors: { changes: "noChanges" } });
    expect(buildCorrection(facts, { ...base, time: "20:00" }).changes).toEqual({ start: { local_date: "2026-10-24", local_time: "20:00" } });
    expect(buildCorrection(facts, { ...base, time: "" }).changes).toEqual({ start: { local_date: "2026-10-24", local_time: null } });
    expect(buildCorrection(facts, { ...base, priceMax: "250 000" }).changes).toEqual({ price_range: { min: "100.00", max: "250000.00", currency: "UZS" } });
    expect(buildCorrection(facts, { ...base, noPrice: true }).changes).toEqual({ price_range: null });
    expect(buildCorrection(facts, { ...base, address: "ул. Навои, 1" }).changes).toEqual({ venue: { name: "Дворец", city: "Tashkent", address: "ул. Навои, 1" } });
    expect(buildCorrection(facts, { ...base, online: true, title: " Новый концерт " }).changes).toEqual({ title: "Новый концерт", online: true });
  });
  it("validates the form: basis https, price order, venue + city, comment", () => {
    const facts = readFacts(raw);
    const base = { ...formFromFacts(facts), basisUrl: "https://iticket.uz/e/1", note: "ok!", time: "20:00" };
    expect(buildCorrection(facts, { ...base, basisUrl: "" }).errors).toEqual({ basisUrl: "basis" });
    expect(buildCorrection(facts, { ...base, basisUrl: "http://iticket.uz/e/1" }).errors).toEqual({ basisUrl: "basisHttps" });
    expect(buildCorrection(facts, { ...base, basisUrl: "javascript:alert(1)" }).errors).toEqual({ basisUrl: "basisHttps" });
    expect(buildCorrection(facts, { ...base, priceMin: "300" }).errors).toEqual({ price: "priceOrder" });
    expect(buildCorrection(facts, { ...base, priceMin: "1.999" }).errors).toEqual({ price: "price" });
    expect(buildCorrection(facts, { ...base, city: "" }).errors).toEqual({ city: "city" });
    expect(buildCorrection(facts, { ...base, time: "25:00" }).errors).toEqual({ time: "time" });
    expect(buildCorrection(facts, { ...base, date: "" }).errors).toEqual({ date: "date" });
    expect(buildCorrection(facts, { ...base, title: "  " }).errors).toEqual({ title: "title" });
    expect(buildCorrection(facts, { ...base, note: "ok" }).errors).toEqual({ note: "note" });
    // a price added to a candidate that had none: max defaults to min
    const noPrice = readFacts({ ...raw, price_range: null });
    expect(buildCorrection(noPrice, { ...formFromFacts(noPrice), noPrice: false, priceMin: "50000", priceMax: "", currency: "UZS", basisUrl: "https://iticket.uz/e", note: "цена" }).changes).toEqual({
      price_range: { min: "50000.00", max: "50000.00", currency: "UZS" },
    });
  });
});

describe("discovery", () => {
  it("groups run errors by code, most frequent first", () => {
    expect(
      groupErrors([
        { scope: "ai_web:KG", code: "AI_BUDGET_EXHAUSTED" },
        { scope: "ticketmaster:DE", code: "PROVIDER_RATE_LIMITED" },
        { scope: "ai_web:AZ", code: "AI_BUDGET_EXHAUSTED" },
      ]),
    ).toEqual([
      { code: "AI_BUDGET_EXHAUSTED", scopes: ["ai_web:KG", "ai_web:AZ"] },
      { code: "PROVIDER_RATE_LIMITED", scopes: ["ticketmaster:DE"] },
    ]);
    expect(groupErrors([])).toEqual([]);
  });
  it("budget level: ok < 80 % ≤ warn < 100 % ≤ bad", () => {
    expect(budgetLevel({ spent_usd: "0.4213", budget_usd: "1.00" })).toBe("ok");
    expect(budgetLevel({ spent_usd: "0.8000", budget_usd: "1.00" })).toBe("warn");
    expect(budgetLevel({ spent_usd: "1.0000", budget_usd: "1.00" })).toBe("bad");
  });
});

describe("sprint 4 review fixes", () => {
  const nb = (x: string) => x.replace(/[\u00a0\u202f]/g, " ");
  it("prices are grouped by the locale without floats", () => {
    expect(nb(fmtAmount("150000.00", "ru"))).toBe("150 000");
    expect(fmtAmount("150000.00", "en")).toBe("150,000");
    expect(fmtAmount("99.50", "ru")).toBe("99,50");
    expect(fmtAmount("9999999999.99", "en")).toBe("9,999,999,999.99");
    expect(fmtAmount("abc", "en")).toBe("abc");
    expect(nb(fmtPriceRange({ min: "150000.00", max: "450000.00", currency: "UZS" }, "ru"))).toBe("150 000 – 450 000 UZS");
    expect(fmtPriceRange({ min: "50.00", max: "50.00", currency: "USD" }, "en")).toBe("50 USD");
  });

  it("media rights codes are labelled; unknown codes stay as they are", () => {
    expect(rightsLabel(tRu, "official_site")).toBe("официальный сайт");
    expect(rightsLabel(tEn, "official_site")).toBe("official site");
    expect(rightsLabel(tEn, "something_new")).toBe("something_new");
  });

  it("the correct form prefills an https basis URL only", () => {
    const facts = readFacts({ title: "A", start: { local_date: "2026-10-24", local_time: "19:00" } });
    expect(formFromFacts(facts, "https://iticket.uz/e/1").basisUrl).toBe("https://iticket.uz/e/1");
    expect(formFromFacts(facts, "http://iticket.uz/e/1").basisUrl).toBe("");
    expect(formFromFacts(facts).basisUrl).toBe("");
  });

  it("newer facts keep the operator's edits and take the new values elsewhere", () => {
    const oldF = formFromFacts(readFacts({ title: "Old", start: { local_date: "2026-10-24", local_time: "19:00" }, venue: { name: "Hall", city: "Tashkent" } }));
    const newF = formFromFacts(readFacts({ title: "New", start: { local_date: "2026-10-25", local_time: "19:00" }, venue: { name: "Hall 2", city: "Tashkent" } }));
    const edited = { ...oldF, time: "20:00", basisUrl: "https://x.uz/1", note: "заметка" };
    const out = rebaseForm(edited, oldF, newF);
    expect(out).toMatchObject({ title: "New", date: "2026-10-25", time: "20:00", venue: "Hall 2", basisUrl: "https://x.uz/1", note: "заметка" });
  });

  it("REVIEW_CHANGES_INVALID {field} → the form field", () => {
    expect(changeField("title")).toBe("title");
    expect(changeField("start")).toBe("date");
    expect(changeField("end")).toBe("date");
    expect(changeField("venue")).toBe("venue");
    expect(changeField("price_range")).toBe("price");
    expect(changeField("changes")).toBe("changes");
    expect(changeField(null)).toBe("changes");
  });

  it("a source draft is carried over to the newer version: my fields win, the rest is new, the reason stays", () => {
    const base: Source = {
      source_id: "s1", slug: "afisha-uz", name: "Afisha.uz", country_code: "UZ", tier: "TRUSTED_MEDIA", event_domains: ["afisha.uz"], media_domains: [],
      listing_pages: [], enabled: true, js_only: false, notes: null, version: 1, created_at: "", updated_at: "", updated_by: null, updated_by_name: null,
    };
    const next: Source = { ...base, version: 2, notes: "их заметка", name: "Afisha" };
    const draft = { ...formFromSource(base), name: "Afisha UZ", enabled: false, reason: "Короткое имя" };
    const r = rebaseSourceForm(draft, base, next);
    expect(r.mine.sort()).toEqual(["enabled", "name"]);
    expect(r.both).toEqual(["name"]);
    expect(r.form).toMatchObject({ name: "Afisha UZ", enabled: false, notes: "их заметка", reason: "Короткое имя" });
    expect(patchFromForm(next, r.form).body).toEqual({ expected_version: 2, name: "Afisha UZ", enabled: false, reason: "Короткое имя" });
  });
});
