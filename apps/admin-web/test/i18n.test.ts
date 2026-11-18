import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Permission, RoleCode } from "@tilhero/contracts/admin";
import { DICTS, fmtCountdown, interpolate, makeFormatters, normLang, pluralForm, translate } from "../src/i18n";
import { en } from "../src/i18n/en";
import { ru, type MessageKey } from "../src/i18n/ru";
import { ALL_ITEMS, NAV } from "../src/state/nav";
import { CATEGORIES, PRIORITIES, TICKET_STATUSES } from "../src/screens/support/sla";
import { PERM_GROUPS, ROLE_CODES } from "../src/screens/roles/Roles";
import { WIDGETS } from "../src/screens/dashboard/Dashboard";
import { DROP_REASONS, FEED_CODES, NEWS_LANGS, NOTIFY_KINDS, WATCH_CHANGE_TYPES } from "../src/screens/news/news";
import { CRAWL_CODES, CRAWL_NOTES, CRAWL_SKIP_REASONS, NAMED_COUNTRIES, REJECT_REASONS, REVIEW_REASONS, REVIEW_STATUSES, RUN_ERROR_CODES, TAXONOMY, TIERS } from "../src/screens/catalog/common";

const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
const CYR = /[Ѐ-ӿ]/;
/** Language self-names stay in their own language in every UI language. */
const EN_CYRILLIC_ALLOWED = new Set<MessageKey>(["lang.ru"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}
const SRC = join(__dirname, "..", "src");
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const has = (k: string) => k in ru;

const ALL_PERMS: Permission[] = [
  "dashboard.read", "users.read", "users.sensitive.read", "ai.content.read", "export.csv", "support.read", "support.reply",
  "support.manage", "subscriptions.override", "billing.refund", "skills.edit", "skills.publish", "audit.read", "config.read",
  "config.edit", "config.publish", "ops.kill_switch", "staff.manage", "roles.manage", "events.review", "sources.manage", "discovery.manage", "news.manage",
];

describe("i18n dictionaries", () => {
  it("EN defines exactly the RU keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });

  it("has no empty strings and the same placeholders in both languages", () => {
    for (const k of Object.keys(ru) as MessageKey[]) {
      expect(ru[k].trim(), `ru ${k}`).not.toBe("");
      expect(en[k].trim(), `en ${k}`).not.toBe("");
      expect(placeholders(en[k]), `placeholders ${k}`).toEqual(placeholders(ru[k]));
    }
  });

  it("EN has no Cyrillic (switching to EN leaves no Russian in the UI)", () => {
    const bad = (Object.keys(en) as MessageKey[]).filter((k) => !EN_CYRILLIC_ALLOWED.has(k) && CYR.test(en[k]));
    expect(bad).toEqual([]);
  });

  it("plural entries have 3 RU forms and 2 EN forms", () => {
    for (const k of Object.keys(ru) as MessageKey[]) {
      if (!ru[k].includes("|")) continue;
      expect(ru[k].split("|"), k).toHaveLength(3);
      expect(en[k].split("|"), k).toHaveLength(2);
    }
  });

  it("every literal t('…') / tp('…') key used in the code exists", () => {
    const missing: string[] = [];
    for (const f of files(SRC)) {
      const code = stripComments(readFileSync(f, "utf8"));
      for (const m of code.matchAll(/\bt[p]?\(\s*"([a-zA-Z0-9_.]+)"/g)) if (!has(m[1]!)) missing.push(`${f}: ${m[1]}`);
      // keys chosen by a ternary: t(cond ? "a.b" : "c.d")
      for (const m of code.matchAll(/\bt\([^()]*?\?\s*"([a-z][a-zA-Z0-9_.]+)"\s*:\s*"([a-z][a-zA-Z0-9_.]+)"/g)) {
        for (const k of [m[1]!, m[2]!]) if (!has(k)) missing.push(`${f}: ${k}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every key family built at runtime is complete", () => {
    const want: string[] = [
      ...ALL_ITEMS.map((i) => `page.${i.id}`),
      ...NAV.map((g) => `nav.g.${g.group}`),
      ...ALL_ITEMS.filter((i) => i.soon).flatMap((i) => [`soon.${i.id}.1`, `soon.${i.id}.2`]),
      ...ROLE_CODES.flatMap((r: RoleCode) => [`role.${r}`, `role.desc.${r}`]),
      ...ALL_PERMS.map((p) => `perm.${p}`),
      ...PERM_GROUPS.map((g) => `perm.g.${g.id}`),
      "perm.g.other",
      ...TICKET_STATUSES.map((s) => `tstatus.${s}`),
      ...PRIORITIES.map((p) => `prio.${p}`),
      ...CATEGORIES.map((c) => `cat.${c}`),
      ...["ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED"].map((s) => `ustatus.${s}`),
      ...["ACTIVE", "LOCKED", "DISABLED"].map((s) => `staff.st.${s}`),
      ...["PENDING", "APPROVED", "APPLIED", "REJECTED", "EXPIRED"].map((s) => `apr.st.${s}`),
      ...["staff.create_privileged", "staff.role_grant", "role.permissions_change"].map((k) => `apr.kind.${k}`),
      ...["billing_review", "provider_issue", "content_review", "security_privacy"].flatMap((k) => [`esc.${k}`, `esc.team.${k}`]),
      ...["today", "7d", "30d"].map((p) => `dash.period.${p}`),
      ...["ok", "degraded", "down"].map((s) => `dash.svc.${s}`),
      ...["system", "light", "dark"].map((m) => `theme.${m}`),
      ...[0, 1, 2, 3, 4].map((n) => `pwd.score.${n}`),
      ...["len", "mix", "email", "prev"].map((r) => `pwd.rule.${r}`),
      ...["ticket", "incident", "regulator"].map((r) => `reveal.kind.${r}`),
      ...["activate", "rollback"].map((k) => `cfg.kind.${k}`),
      ...["best_for_you", "watch", "sales_soon", "news"].map((k) => `cfg.sec.${k}`),
      ...WIDGETS.map((w) => `cfg.wd.${w}`),
      ...["idle", "expired", "revoked", "unauthorized"].map((n) => `login.notice.${n}`),
      // sprint 4: event catalog
      ...TIERS.flatMap((x) => [`tier.${x}`, `tier.${x}.h`]),
      ...Object.keys(REVIEW_REASONS).map((r) => `reason.${r}`),
      ...REVIEW_STATUSES.map((x) => `rv.st.${x}`),
      ...REJECT_REASONS.map((x) => `rv.rej.${x}`),
      ...["title", "titleLong", "date", "time", "venue", "city", "price", "priceOrder", "currency", "basis", "basisHttps", "note", "noChanges", "rejectCode"].map((x) => `rv.err.${x}`),
      ...["slug", "slugTaken", "name", "nameLong", "country", "domainsEmpty", "domainsMany", "domainBad", "pagesMany", "pageUrl", "pageHttps", "pagePort", "pageDomain", "pageCategory", "pageCity", "notesLong", "reason", "reasonLong"].map((x) => `src.err.${x}`),
      ...["format", "ip", "suffix", "wildcard"].map((x) => `src.dom.${x}`),
      ...["slug", "name", "country_code", "tier", "event_domains", "media_domains", "listing_pages", "enabled", "js_only", "notes"].map((x) => `src.field.${x}`),
      ...TAXONOMY.map((c) => `tax.${c}`),
      ...["RUNNING", "COMPLETED", "PARTIAL", "FAILED"].map((x) => `dsc.st.${x}`),
      ...["scheduler", "manual"].map((x) => `dsc.tr.${x}`),
      ...RUN_ERROR_CODES.map((c) => `run.err.${c}`),
      // fix 4.1: last crawl, explicit country names
      ...CRAWL_CODES.flatMap((c) => [`crawl.code.${c}`, `crawl.code.${c}.h`]),
      ...CRAWL_SKIP_REASONS.map((r) => `crawl.skip.${r}`),
      ...CRAWL_NOTES.map((n) => `crawl.note.${n}`),
      ...["ok", "skipped", "error"].map((o) => `crawl.outcome.${o}`),
      ...NAMED_COUNTRIES.map((c) => `country.${c}`),
      // sprint 6: news feeds, news, watches
      ...["official", "media"].flatMap((k) => [`feed.kind.${k}`, `feed.kind.${k}.h`]),
      ...["rss", "html"].flatMap((m) => [`feed.mode.${m}`, `feed.mode.${m}.h`]),
      ...["summary", "title_only"].flatMap((d) => [`feed.display.${d}`, `feed.display.${d}.h`]),
      ...NEWS_LANGS.map((l) => `feed.lang.${l}`),
      ...["name", "kind", "mode", "feed_url", "page_url", "site_domain", "extra_domains", "interests", "entities", "country_code", "lang", "display", "category_filter", "enabled"].map((f) => `feed.field.${f}`),
      ...["slug", "slugTaken", "name", "nameLong", "domain", "feedUrl", "pageUrl", "https", "urlDomain", "interests", "category", "reason", "server"].map((x) => `feed.err.${x}`),
      ...FEED_CODES.map((c) => `feed.code.${c}`),
      ...DROP_REASONS.map((r) => `feed.drop.${r}`),
      ...["high", "mid", "low"].map((x) => `news.sig.${x}`),
      ...["event_update", "article"].map((x) => `news.kind.${x}`),
      ...WATCH_CHANGE_TYPES.flatMap((k) => [`wch.ch.${k}`, `wch.ch.${k}.h`]),
      ...NOTIFY_KINDS.flatMap((k) => [`wch.nt.${k}`, `wch.nt.${k}.h`]),
      ...["news", "watch"].map((s) => `err.FEATURE_UNAVAILABLE.${s}`),
      // fix 6.1: AI limits, feed auto-check
      ...["ai", "news", "pages"].flatMap((k) => [`lim.f.${k}`, `lim.h.${k}`, `lim.short.${k}`]),
      ...["money", "aiMax", "newsMax", "pages"].map((k) => `lim.err.${k}`),
      ...["legal", "terms", "stale", "unverified", "manual"].map((r) => `feed.reason.${r}`),
      ...["EMPTY", "FOREIGN_LINKS", "STALE", "NO_DATES", "ROBOTS_DISALLOWED", "FEED_UNAVAILABLE"].map((c) => `probe.code.${c}`),
    ];
    expect(want.filter((k) => !has(k))).toEqual([]);
  });

  it("the error codes of admin.ts and the sprint-2 domains have a human text", () => {
    const codes = [
      "UNAUTHORIZED", "SESSION_EXPIRED", "SESSION_REVOKED", "PERMISSION_DENIED", "STEP_UP_REQUIRED", "CSRF_INVALID", "VALIDATION_ERROR",
      "NOT_FOUND", "RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "INTERNAL_ERROR", "INVALID_CREDENTIALS", "ACCOUNT_LOCKED", "ACCOUNT_DISABLED",
      "AUTH_MODE_UNAVAILABLE", "MFA_INVALID", "CHALLENGE_INVALID", "PASSWORD_WEAK", "LAST_SUPER_ADMIN", "SELF_ACTION", "FOUR_EYES_SAME_PERSON",
      "APPROVAL_EXPIRED", "STAFF_EMAIL_EXISTS", "SUPPORT_INVALID_TRANSITION", "SUPPORT_TICKET_CLOSED", "EXPERIENCE_CONFIG_INVALID",
      "EXPERIENCE_VERSION_EXISTS", "EXPERIENCE_NO_PREVIOUS", "BILLING_NOT_AVAILABLE",
      // sprint 4 (docs/sprint4/INTERNAL_API.md §2.2, §6, §7, admin.ts)
      "REVIEW_ALREADY_DECIDED", "REVIEW_BASIS_URL_NOT_ALLOWED", "REVIEW_NOT_FOUND", "SOURCE_NOT_FOUND", "SOURCE_SLUG_TAKEN",
      "SOURCE_VERSION_CONFLICT", "SOURCE_DOMAIN_INVALID", "SOURCE_LISTING_URL_NOT_ALLOWED", "SOURCE_CATEGORY_UNKNOWN",
      "DISCOVERY_RUN_IN_PROGRESS", "DISCOVERY_RUN_NOT_FOUND", "ACTOR_NOT_ALLOWED",
      // sprint 6 (admin.ts Sprint6ErrorCode)
      "NEWS_SOURCE_VERSION_CONFLICT", "NEWS_SOURCE_SLUG_TAKEN", "NEWS_SOURCE_NOT_FOUND", "NEWS_ITEM_NOT_FOUND", "CHECK_UNAVAILABLE", "FEATURE_UNAVAILABLE",
    ];
    expect(codes.filter((c) => !has(`err.${c}`))).toEqual([]);
  });

  it("no interface text is hard-coded outside the dictionaries (Cyrillic only in src/i18n)", () => {
    const hits: string[] = [];
    for (const f of files(SRC)) {
      if (f.includes(join("src", "i18n"))) continue;
      stripComments(readFileSync(f, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          if (CYR.test(line)) hits.push(`${f}:${i + 1} ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

describe("formatting", () => {
  it("interpolates and keeps unknown variables visible", () => {
    expect(translate("ru", "login.attempts", { n: 3 })).toBe("Осталось попыток: 3");
    expect(translate("en", "perm.need", { p: "audit.read" })).toBe("Requires the audit.read permission");
    expect(interpolate("{a} and {b}", { a: 1 })).toBe("1 and {b}");
    expect(normLang("en-US")).toBe("en");
    expect(normLang("uz")).toBeNull();
  });

  it("chooses Russian and English plural forms", () => {
    const f = DICTS.ru["cfg.changes"];
    expect([1, 2, 5, 11, 21, 22].map((n) => pluralForm("ru", n, f))).toEqual([
      "1 несохранённое изменение",
      "2 несохранённых изменения",
      "5 несохранённых изменений",
      "11 несохранённых изменений",
      "21 несохранённое изменение",
      "22 несохранённых изменения",
    ]);
    expect(pluralForm("en", 1, DICTS.en["cfg.changes"])).toBe("1 unsaved change");
    expect(pluralForm("en", 3, DICTS.en["cfg.changes"])).toBe("3 unsaved changes");
  });

  it("formats countdowns, minutes and numbers", () => {
    expect(fmtCountdown(5 * 60_000 + 41_000)).toBe("05:41");
    expect(fmtCountdown(3_918_000)).toBe("1:05:18");
    expect(fmtCountdown(-281_000)).toBe("−04:41");
    const ru = makeFormatters("ru");
    expect(ru.minutes(220)).toBe("3 ч 40 мин");
    expect(ru.minutes(null)).toBe("—");
    expect(makeFormatters("en").minutes(11)).toBe("11 min");
    expect(ru.num(12846).replace(/\s/g, " ")).toBe("12 846");
  });
});
