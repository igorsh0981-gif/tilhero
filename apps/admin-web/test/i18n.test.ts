import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, type RoleCode } from "@tilhero/contracts/admin";
import { DICTS, fmtCountdown, interpolate, makeFormatters, normLang, pluralForm, translate } from "../src/i18n";
import { en } from "../src/i18n/en";
import { LEARNER } from "../src/i18n/learner";
import { ru, type MessageKey } from "../src/i18n/ru";
import { GROUPS, NAV_ITEMS } from "../src/state/nav";
import { CATEGORIES, PRIORITIES, TICKET_STATUSES } from "../src/screens/support/sla";
import { ESCALATIONS } from "../src/screens/support/Support";
import { PERM_GROUPS, ROLE_CODES } from "../src/screens/roles/Roles";
import { NEWS_TABS } from "../src/screens/news/News";
import { AGE_SEGMENTS, AUDIENCES, NOTE_ICONS, NOTE_ROUTES } from "../src/screens/news/catalog";
import { TEMPLATE_CATEGORIES } from "../src/screens/news/Templates";
import { CAMPAIGN_STATUSES } from "../src/screens/news/Campaigns";
import { LEARNER_STATUSES } from "../src/screens/learners/Learners";
import { OBJECT_TYPES } from "../src/screens/audit/Audit";
import { SECTION_TYPES } from "../src/screens/config/Config";
import { AUDIENCES as CT_AUDIENCES, CONTROL_TYPES, EXERCISE_TYPES, KINDS, LICENSES, MEDIA_ORIGINS, MEDIA_TYPES, MEDIA_USES, RUBRIC_CODES, RUBRIC_TARGETS, SKILL_AREAS, STAGE_ORDER, STATUSES, TOPICS } from "../src/screens/content/model";
import { CONTENT_TABS } from "../src/screens/content/ContentPage";
import { DECISIONS, REQUEST_STATUSES } from "../src/screens/content/RequestsTab";
import { MISSING_KEYS, PAIR_STATUSES } from "../src/screens/langs/Langs";

const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
const CYR = /[Ѐ-ӿ]/;
/** Language self-names stay in their own language; a sample learner name in the RU preview. */
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
      for (const m of code.matchAll(/\bt\([^()]*?\?\s*"([a-z][a-zA-Z0-9_.]+)"\s*:\s*"([a-z][a-zA-Z0-9_.]+)"/g)) {
        for (const k of [m[1]!, m[2]!]) if (!has(k)) missing.push(`${f}: ${k}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every key family built at runtime is complete", () => {
    const want: string[] = [
      ...NAV_ITEMS.map((i) => `page.${i.id}`),
      ...GROUPS.map((g) => `nav.g.${g}`),
      ...NAV_ITEMS.filter((i) => i.soon).flatMap((i) => [`soon.${i.id}.1`, `soon.${i.id}.2`]),
      ...ROLE_CODES.flatMap((r: RoleCode) => [`role.${r}`, `role.desc.${r}`]),
      ...PERMISSIONS.map((p) => `perm.${p}`),
      ...PERM_GROUPS.map((g) => `perm.g.${g.id}`),
      ...TICKET_STATUSES.map((s) => `tstatus.${s}`),
      ...PRIORITIES.map((p) => `prio.${p}`),
      ...CATEGORIES.map((c) => `cat.${c}`),
      ...ESCALATIONS.flatMap((k) => [`esc.${k}`, `esc.team.${k}`]),
      ...LEARNER_STATUSES.map((s) => `lstatus.${s}`),
      ...["not_required", "pending", "granted", "declined"].map((s) => `gc.${s}`),
      ...["ACTIVE", "LOCKED", "DISABLED"].map((s) => `staff.st.${s}`),
      ...["PENDING", "APPROVED", "APPLIED", "REJECTED", "EXPIRED"].map((s) => `apr.st.${s}`),
      ...["staff.create_privileged", "staff.role_grant", "role.permissions_change", "staff.privileged_revoke", "staff.privileged_reset"].map((k) => `apr.kind.${k}`),
      ...["today", "7d", "30d"].map((p) => `dash.period.${p}`),
      ...["learners", "support", "whats_new", "campaigns"].flatMap((b) => [`dash.b.${b}`, `dash.empty.${b}`, `dash.svc.${b}`]),
      ...["system", "light", "dark"].map((m) => `theme.${m}`),
      ...[0, 1, 2, 3, 4].map((n) => `pwd.score.${n}`),
      ...["len", "mix", "email", "prev"].map((r) => `pwd.rule.${r}`),
      ...["ticket", "incident", "request"].map((r) => `rv.kind.${r}`),
      ...["activate", "rollback"].map((k) => `cfg.kind.${k}`),
      ...SECTION_TYPES.map((k) => `cfg.sec.${k}`),
      ...["idle", "expired", "revoked", "unauthorized"].map((n) => `login.notice.${n}`),
      ...NEWS_TABS.map((x) => `news.tab.${x.v}`),
      ...NOTE_ROUTES.map((r) => `route.${r}`),
      ...NOTE_ICONS.map((i) => `icon.${i}`),
      ...AUDIENCES.flatMap((a) => [`aud.${a}`, `aud.${a}.hint`]),
      ...AGE_SEGMENTS.map((a) => `ageseg.${a}`),
      ...["draft", "published", "archived"].map((s) => `wn.st.${s}`),
      ...TEMPLATE_CATEGORIES.map((c) => `ncat.${c}`),
      ...["draft", "active", "archived"].map((s) => `tpl.st.${s}`),
      ...CAMPAIGN_STATUSES.map((s) => `cmp.st.${s}`),
      ...["created", "sent", "in_app_only", "deferred", "skipped_frequency", "failed"].map((s) => `cmp.s.${s}`),
      ...["schedule", "unschedule", "stop"].map((s) => `cmp.done.${s}`),
      ...["ru", "uz"].map((l) => `ulang.${l}`),
      ...["work", "career", "travel", "daily", "study", "exam"].map((g) => `goal.${g}`),
      ...["zero", "beginner", "some", "confident"].map((g) => `lvl.${g}`),
      ...["daily", "weekdays", "three_per_week", "custom"].map((g) => `preset.${g}`),
      ...[1, 2, 3, 4, 5, 6, 7].map((d) => `dow.${d}`),
      ...["required", "tooLong", "format", "control", "unknownPh", "invalidPh", "pressure", "server", "empty"].map((x) => `fx.${x}`),
      // sprint 3: content, media, requests, review, diagnostics, languages
      ...["content", "diagnostics"].flatMap((b) => [`dash.b.${b}`, `dash.empty.${b}`, `dash.svc.${b}`]),
      ...KINDS.flatMap((k) => [`kind.${k}`, `kinds.${k}`, `ct.pick.${k}`]),
      ...STATUSES.flatMap((s) => [`vst.${s}`]),
      ...["in_review", "approved", "published", "archived", "suspended"].map((s) => `ct.ro.${s}`),
      ...["missing", "draft", "checked"].map((s) => `lc.${s}`),
      ...["save", "validate", "submit", "draft", "publish", "archive", "rollback"].map((s) => `ct.act.${s}`),
      ...CONTENT_TABS.map((x) => `ct.tab.${x.v}`),
      ...["expiring", "expired"].map((x) => `ct.rw.${x}`),
      ...TOPICS.map((x) => `topic.${x}`),
      ...STAGE_ORDER.map((x) => `stage.${x}`),
      ...CONTROL_TYPES.map((x) => `cit.${x}`),
      ...["success", "alt_success", "fail"].map((x) => `out.${x}`),
      ...RUBRIC_CODES.map((x) => `rc.${x}`),
      ...RUBRIC_TARGETS.map((x) => `ru.to.${x}`),
      ...MEDIA_TYPES.map((x) => `mt.${x}`),
      ...MEDIA_ORIGINS.map((x) => `morg.${x}`),
      ...LICENSES.map((x) => `lic.${x}`),
      ...MEDIA_USES.map((x) => `mu.${x}`),
      ...EXERCISE_TYPES.map((x) => `xt.${x}`),
      ...SKILL_AREAS.map((x) => `area.${x}`),
      ...CT_AUDIENCES.map((x) => `ageseg.${x}`),
      ...["type", "size", "empty", "signature"].map((x) => `ma.audioErr.${x}`),
      ...REQUEST_STATUSES.map((x) => `rqs.${x}`),
      ...["song", "movie", "series", "other"].map((x) => `rqk.${x}`),
      ...DECISIONS.map((x) => `rqh.${x}`),
      ...["draft", "published", "archived"].map((x) => `dxs.${x}`),
      ...PAIR_STATUSES.map((x) => `ps.${x}`),
      ...MISSING_KEYS.map((x) => `lg.m.${x}`),
      ...["active", "planned"].map((x) => `lgs.${x}`),
      ...["core", "optional"].map((x) => `le.kind.${x}`),
      ...[
        "LOCALE_MISSING", "LOCALE_SCRIPT", "LOCALE_NOT_CHECKED", "UNKNOWN_REF", "REF_MISMATCH", "PREREQ_CYCLE", "NO_CONTROL_ITEMS", "STAGES_INVALID",
        "RUBRIC_WEIGHTS", "RUBRIC_BANDS", "RUBRIC_MISMATCH", "SCENARIO_TEST_FAILED", "START_MISSING", "UNKNOWN_NODE", "UNREACHABLE_NODE", "DEAD_END",
        "NO_SUCCESS_END", "TRAP", "UNKNOWN_SPEAKER", "NO_RECOVERY_POINT", "RECOVERY_CANNOT_FINISH", "TOO_MANY_NODES", "END_HAS_TRANSITIONS",
        "RIGHTS_REQUIRED", "EXTERNAL_SOURCE_DISABLED", "TRANSCRIPT_INVALID", "MEDIA_TOO_LONG", "MEDIA_TOO_SHORT", "EMBED_INVALID", "AUDIENCE_EMPTY",
        "KIDS_CONTENT", "COUNT_OUT_OF_RANGE", "DUPLICATE_ID", "VALUE_REQUIRED", "ANSWER_INVALID", "LEVEL_RANGE", "SCHEMA_INVALID", "KEY_CHANGED",
      ].map((c) => `ci.${c}`),
    ];
    expect(want.filter((k) => !has(k))).toEqual([]);
    void OBJECT_TYPES;
  });

  it("the error codes of admin.ts have a human text", () => {
    const codes = [
      "UNAUTHORIZED", "SESSION_EXPIRED", "SESSION_REVOKED", "PERMISSION_DENIED", "STEP_UP_REQUIRED", "CSRF_INVALID", "VALIDATION_ERROR",
      "NOT_FOUND", "RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "INTERNAL_ERROR", "INVALID_CREDENTIALS", "ACCOUNT_LOCKED", "ACCOUNT_DISABLED",
      "MFA_INVALID", "CHALLENGE_INVALID", "PASSWORD_WEAK", "LAST_SUPER_ADMIN", "SELF_ACTION", "FOUR_EYES_SAME_PERSON", "SESSION_ROTATED",
      "APPROVAL_EXPIRED", "STAFF_EMAIL_EXISTS", "SUPPORT_INVALID_TRANSITION", "SUPPORT_TICKET_CLOSED", "EXPERIENCE_CONFIG_INVALID",
      "EXPERIENCE_VERSION_EXISTS", "EXPERIENCE_NO_PREVIOUS", "IDEMPOTENCY_KEY_REQUIRED", "AUDIT_UNAVAILABLE", "LEARNER_NOT_FOUND", "FIELD_NOT_AVAILABLE",
      "RELEASE_NOTE_NOT_FOUND", "RELEASE_NOTE_SLUG_EXISTS", "RELEASE_NOTE_NOT_DRAFT", "RELEASE_NOTE_VERSION_CONFLICT", "RELEASE_NOTE_TRANSLATION_MISSING",
      "TEMPLATE_NOT_FOUND", "TEMPLATE_INVALID", "TEMPLATE_VERSION_NOT_FOUND", "TEST_RECIPIENT_NOT_ALLOWED",
      "CAMPAIGN_NOT_FOUND", "CAMPAIGN_INVALID", "CAMPAIGN_NOT_DRAFT", "CAMPAIGN_VERSION_CONFLICT", "CAMPAIGN_EMPTY_AUDIENCE", "CAMPAIGN_ALREADY_SENDING",
      "SESSION_NOT_REVOKED", // logout while the session store is down (review T2-10)
      // sprint 3 (catalog, diagnostics via admin-bff)
      "CONTENT_INVALID", "CONTENT_KEY_EXISTS", "CONTENT_NOT_FOUND", "VERSION_CONFLICT", "VERSION_NOT_DRAFT", "VERSION_NOT_IN_REVIEW", "VERSION_NOT_APPROVED",
      "VERSION_IMMUTABLE", "DRAFT_EXISTS", "SELF_REVIEW", "CONTENT_IN_USE", "CONTENT_NOT_PUBLISHED", "ROLLBACK_TARGET_INVALID", "AUDIO_INVALID",
      "PAYLOAD_TOO_LARGE", "MEDIA_REQUEST_DECIDED", "LINKED_ASSET_REQUIRED", "LINKED_ASSET_NOT_PUBLISHED", "LINKED_ASSET_NOT_ALLOWED", "PAIR_NOT_READY",
      "PAIR_INVALID", "UNKNOWN_LANGUAGE",
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

  it("learner preview texts exist in RU and UZ with the same placeholders, UZ in Latin", () => {
    expect(Object.keys(LEARNER.uz).sort()).toEqual(Object.keys(LEARNER.ru).sort());
    for (const k of Object.keys(LEARNER.ru) as Array<keyof (typeof LEARNER)["ru"]>) {
      expect(placeholders(LEARNER.uz[k]), k).toEqual(placeholders(LEARNER.ru[k]));
      expect(CYR.test(LEARNER.uz[k]), `uz ${k}`).toBe(false);
    }
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
    const r = makeFormatters("ru");
    expect(r.minutes(220)).toBe("3 ч 40 мин");
    expect(r.minutes(null)).toBe("—");
    expect(makeFormatters("en").minutes(11)).toBe("11 min");
    expect(r.num(12846).replace(/\s/g, " ")).toBe("12 846");
  });
});
