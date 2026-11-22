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
import * as AI from "../src/screens/ai/model";
import { READING_QUESTION_TYPES, VOICES } from "../src/screens/content/model";
import { GLOSSARY_ACTIONS, GLOSSARY_SOURCES, GLOSSARY_STATUSES, PARTS_OF_SPEECH } from "../src/screens/content/glossary";
import * as MEM from "../src/screens/memory/model";
import * as GM from "../src/screens/game/model";
import * as SOC from "../src/screens/social/model";

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
      // sprint 4: agents, dialogue QA, costs, overview blocks
      ...["lessons", "ai"].flatMap((b) => [`dash.b.${b}`, `dash.empty.${b}`, `dash.svc.${b}`]),
      ...AI.IMPLEMENTATIONS.map((x) => `aimpl.${x}`),
      ...["active", "planned"].map((x) => `avail.${x}`),
      ...AI.VERSION_STATUSES.flatMap((x) => [`avs.${x}`]),
      ...["published", "archived"].map((x) => `ag.ro.${x}`),
      ...["all", "llm", "rules", "code", "planned"].map((x) => `ag.f.${x}`),
      ...["not_draft", "unsaved", "no_run", "running", "stale", "failed"].map((x) => `ag.gate.${x}`),
      ...AI.RUN_STATUSES.map((x) => `trs.${x}`),
      ...AI.CHECK_KINDS.flatMap((x) => [`gck.${x}`, `gck.h.${x}`]),
      ...["string", "number", "boolean", "null"].map((x) => `gcf.vt.${x}`),
      ...["path.required", "path.format", "value.format", "values.required", "n.range", "title.required", "title.too_long", "ctx.required", "ctx.json_parse", "ctx.not_object"].map((x) => `gcf.${x}`),
      ...["required", "too_long", "range", "format", "same_model", "json_parse", "not_object", "type_not_object", "properties_not_object", "required_not_array", "required_unknown"].map((x) => `agf.${x}`),
      ...["instructions", "rules", "schemaText", "schema_version", "model_id", "fallback_model_id", "temperature", "max_output_tokens", "timeout_ms", "max_cost_usd", "notes"].map((x) => `agf.l.${x}`),
      ...AI.SESSION_KINDS.map((x) => `sk.${x}`),
      ...AI.SESSION_STATUSES.map((x) => `sst.${x}`),
      ...AI.SESSION_FLAGS.map((x) => `sflag.${x}`),
      ...AI.EVAL_STATUSES.map((x) => `evs.${x}`),
      ...AI.SKILL_OUTCOMES.map((x) => `skout.${x}`),
      ...AI.APPEAL_STATUSES.map((x) => `aps.${x}`),
      ...AI.SEVERITIES.map((x) => `sev.${x}`),
      ...AI.CALL_STATUSES.map((x) => `callst.${x}`),
      ...AI.CALL_REASONS.map((x) => `aireason.${x}`),
      ...AI.HISTORY_REASONS.map((x) => `shr.${x}`),
      ...AI.AI_MODES.map((x) => `aimode.${x}`),
      ...AI.USAGE_PERIODS.map((x) => `usp.${x}`),
      ...AI.CRITERIA.map((x) => `rc.${x}`),
      ...["correct", "incorrect", "skipped"].map((x) => `stres.${x}`),
      ...["learner", "character"].map((x) => `spk.${x}`),
      ...["choice", "text"].map((x) => `tmode.${x}`),
      ...["0", "1", "2", "3"].map((x) => `rv2.band.${x}`),
      ...["upheld", "corrected"].flatMap((x) => [`ap.d.${x}`, `ap.d.${x}.h`]),
      ...["bug", "method"].map((x) => `qt.kind.${x}`),
      ...["range", "range0", "gt_daily", "gt_monthly"].map((x) => `csf.${x}`),
      ...["monthly_cap_usd", "learner_daily_cap_usd", "lesson_cap_usd", "speech_monthly_cap_usd", "alert_percent"].flatMap((x) => [`csf.l.${x}`, `csf.h.${x}`]),
      // sprint 5: reading, course dictionary, memory, forgetting analytics, overview block
      ...["memory"].flatMap((b) => [`dash.b.${b}`, `dash.empty.${b}`, `dash.svc.${b}`]),
      ...["READING_WORDS", "SENTENCE_TOO_LONG", "GLOSSARY_NOT_IN_TEXT", "TEXT_TOO_LONG"].map((c) => `ci.${c}`),
      ...READING_QUESTION_TYPES.map((x) => `rdq.${x}`),
      ...VOICES.map((x) => `rd.voice.${x}`),
      ...GLOSSARY_SOURCES.flatMap((x) => [`gls.${x}`, `gls.${x}.long`]),
      ...GLOSSARY_STATUSES.map((x) => `glst.${x}`),
      ...GLOSSARY_ACTIONS.map((x) => `gla.${x}`),
      ...PARTS_OF_SPEECH.map((x) => `pos.${x}`),
      ...["approve", "correct", "reject"].map((x) => `gl.done.${x}`),
      ...["required", "too_long", "too_many", "uz_script", "uz_okina", "en_only"].map((x) => `glf.${x}`),
      ...MEM.MEMORY_TABS.map((x) => `mem.tab.${x}`),
      ...MEM.CARD_STATUSES.map((x) => `cst.${x}`),
      ...MEM.CARD_KINDS.map((x) => `ckind.${x}`),
      ...MEM.CHECK_STATUSES.map((x) => `chst.${x}`),
      ...["d7", "d30"].flatMap((x) => [`chstage.${x}`, `fa.${x}`, `fa.${x}.hint`]),
      ...MEM.CARD_ACTIONS.flatMap((x) => [`mact.${x}`, `mact.${x}.t`, `mact.${x}.m`, `mact.${x}.done`]),
      ...MEM.FSRS_STATES.map((x) => `fsrs.${x}`),
      ...MEM.LOG_ACTORS.map((x) => `actor.${x}`),
      ...MEM.ANSWER_MODES.map((x) => `amode.${x}`),
      ...MEM.GRADES.map((x) => `grade.${x}`),
      ...["lesson", "media", "reading", "scenario", "evaluation", "manual"].map((x) => `msrc.${x}`),
      ...["30d", "90d"].map((x) => `fa.p.${x}`),
      // sprint 6: the game — heroes, rules, shop, wallets, events, the overview block
      ...["game"].flatMap((b) => [`dash.b.${b}`, `dash.empty.${b}`, `dash.svc.${b}`]),
      ...GM.GAME_TABS.map((x) => `gtab.${x}`),
      ...GM.AUDIENCES.flatMap((x) => [`gm.aud.${x}`, `ageseg.${x}`]),
      ...GM.CURRENCIES.map((x) => `gm.cur.${x}`),
      ...GM.QUEST_KINDS.map((x) => `gq.${x}`),
      ...GM.GAME_ACTIONS.map((x) => `gact.${x}`),
      ...GM.REASONS.map((x) => `grsn.${x}`),
      ...GM.SHOP_KINDS.map((x) => `shk.${x}`),
      ...GM.SHOP_STATUSES.map((x) => `shs.${x}`),
      ...GM.EVENT_STATUSES.map((x) => `evs.${x}`),
      ...GM.RULES_STATUSES.map((x) => `gst.${x}`),
      ...GM.HERO_LINES.flatMap((x) => [`hr.line.${x}`, `hr.stages.${x}`]),
      ...GM.EARN_ROWS.flatMap((x) => [`grp.${x}`, `gr.h.${x}`]),
      ...["no_draft", "unsaved", "invalid", "not_validated"].map((x) => `gr.gate.${x}`),
      ...["no_draft", "unsaved", "invalid"].map((x) => `hr.gate.${x}`),
      ...["published", "finished", "cancelled"].map((x) => `ev.ro.${x}`),
      ...["confirmed", "reversed"].map((x) => `wlst.${x}`),
      ...["event", "command", "staff"].map((x) => `wlsrc.${x}`),
      ...["system", "learner", "staff", "other"].map((x) => `wlact.${x}`),
      ...["active", "completed", "expired"].map((x) => `wlq.${x}`),
      ...["type", "size", "empty", "signature", "dims"].map((x) => `gm.imgErr.${x}`),
      ...["first_lesson", "streak", "skills", "skill_retained", "reviews", "readings", "first_freeze"].map((x) => `gb.${x}`),
      ...[
        "required", "too_long", "uz_script", "code_format", "price_range", "audiences_empty", "token", "date", "until_before_from", "order_range",
        "ends_before_starts", "too_long_period", "starts_past", "multipliers_empty", "multipliers_many", "duplicate", "factor", "amount_range",
        "below_zero", "reason_short", "reason_long", "not_integer", "negative", "range", "length", "first_zero", "not_increasing",
        "caps_below_reward", "per_audience_kids", "per_audience_teens", "per_audience_adults", "unknown_kind", "reward_growth", "stage2_high",
        "token_bg", "token_accent",
      ].map((x) => `gi.${x}`),
      ...["earn", "caps", "levels", "hero", "stage_thresholds", "freeze", "bonuses", "quests", "templates", "badges", "streak", "skills", "reviews_cards", "readings", "index"].map((x) => `grp.${x}`),
      // sprint 7: «Сообщество» — friends, moderation, referrals, leagues and duels, pair rooms, the overview block
      ...["social"].flatMap((b) => [`dash.b.${b}`, `dash.empty.${b}`, `dash.svc.${b}`]),
      ...["room_cap_usd"].flatMap((x) => [`csf.l.${x}`, `csf.h.${x}`]),
      ...SOC.MOD_TABS.map((x) => `mod.tab.${x}`),
      ...SOC.REF_TABS.map((x) => `ref.tab.${x}`),
      ...SOC.LEAGUE_TABS.map((x) => `lgu.tab.${x}`),
      ...SOC.CASE_STATUSES.map((x) => `cst7.${x}`),
      ...SOC.MOD_ACTIONS.flatMap((x) => [`mact7.${x}`, `mact7.${x}.h`]),
      ...SOC.MOD_ACTIONS.filter((x) => x !== "social_ban").map((x) => `mod.do.${x}`),
      ...SOC.SANCTION_KINDS.map((x) => `sk7.${x}`),
      ...["active", "revoked", "expired", "done"].map((x) => `ssst.${x}`),
      ...SOC.APPEAL_STATUSES.map((x) => `aps7.${x}`),
      ...["upheld", "overturned"].flatMap((x) => [`map.d.${x}`, `map.d.${x}.h`]),
      ...SOC.SUBJECT_KINDS.map((x) => `subj.${x}`),
      ...SOC.COMPLAINT_REASONS.map((x) => `crsn.${x}`),
      ...SOC.FRIEND_REQUEST_STATUSES.map((x) => `frs.${x}`),
      ...["in", "out"].map((x) => `fr.dir.${x}`),
      ...["reporter", "target"].map((x) => `fr.role.${x}`),
      ...SOC.REFERRAL_STATUSES.map((x) => `rfs.${x}`),
      ...SOC.REJECT_CODES.flatMap((x) => [`rjc.${x}`, `rjc.${x}.learner`]),
      ...SOC.RISK_FLAGS.flatMap((x) => [`rflag.${x}`, `rflag.${x}.h`]),
      ...["approved", "rejected"].map((x) => `rr.d.${x}`),
      ...["qualify", "rewards", "limits", "review"].map((x) => `rcs.${x}`),
      ...["require_diagnostic", "inviter_reward", ...SOC.CAMPAIGN_NUMBERS].map((x) => `rcf.${x}`),
      ...["required", "not_integer", "range", "days_gt_lessons", "no_reward", "window_short"].map((x) => `rci.${x}`),
      ...["invited", "in_progress", "in_review", "qualified", "rejected", "expired", "capped"].map((x) => `rst.${x}`),
      ...SOC.GROUP_STATUSES.map((x) => `lgus.${x}`),
      ...["open", "closed"].map((x) => `lgw.${x}`),
      ...SOC.DUEL_STATUSES.map((x) => `dst.${x}`),
      ...SOC.DUEL_RESULTS.map((x) => `drs.${x}`),
      ...SOC.ROOM_STATUSES.map((x) => `rst7.${x}`),
      ...SOC.END_REASONS.map((x) => `per.${x}`),
      ...SOC.ROOM_MODES.map((x) => `prm.${x}`),
      ...SOC.ROOM_EVENT_KINDS.map((x) => `rek.${x}`),
      ...["inviter", "invitee"].map((x) => `prs.${x}`),
      ...["online", "offline"].map((x) => `prn.${x}`),
      ...["required", "days_range", "reason_short", "reason_long", "too_many", "same_result"].map((x) => `sci.${x}`),
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
      // sprint 4 (ai-gateway, lessons, assessment via admin-bff)
      "TESTS_REQUIRED", "TESTS_FAILED", "NO_PREVIOUS_VERSION", "EVALUATION_SUPERSEDED", "SELF_REEVALUATION", "VERSION_IN_CANARY", "NO_PUBLISHED_VERSION",
      "NO_CANARY", "MODEL_INACTIVE", "MODEL_IN_USE", "TEST_RUN_IN_PROGRESS", "NO_GOLDEN_CASES", "VERSION_INVALID", "BUDGET_CONFLICT", "IF_MATCH_REQUIRED",
      // sprint 5 (catalog glossary, memory, ai-gateway speech price)
      "FORM_TAKEN", "NOT_PENDING", "ENTRY_ARCHIVED", "COURSE_ENTRY_LOCKED", "OVERRIDE_COURSE_ONLY", "ARCHIVE_NOT_ALLOWED", "GLOSSARY_ENTRY_NOT_FOUND",
      "GLOSSARY_INVALID", "CARD_STATE", "DUE_AT_RANGE", "MEMORY_LEARNER_NOT_FOUND", "CARD_NOT_FOUND", "PRICE_NOT_APPLICABLE",
      // sprint 6 (gamification via admin-bff; admin.ts «Игра и герои», INTERNAL_API §12)
      "INSUFFICIENT_TILS", "ALREADY_OWNED", "FREEZE_STOCK_FULL", "ITEM_NOT_AVAILABLE", "NOT_OWNED", "HERO_NOT_AVAILABLE", "HERO_IN_USE", "RULES_INVALID",
      "RULES_NOT_VALIDATED", "DRAFT_CONFLICT", "EVENT_OVERLAP", "BALANCE_NEGATIVE", "ALREADY_REVERSED", "ASSET_TOO_LARGE", "ASSET_INVALID", "GAME_UNAVAILABLE",
      "RULES_VERSION_NOT_FOUND", "HERO_NOT_FOUND", "ITEM_NOT_FOUND", "EVENT_NOT_FOUND", "WALLET_NOT_FOUND", "ASSET_NOT_FOUND",
      // sprint 7 (admin.ts «Социальное», INTERNAL_API §8 «Админка»)
      "CASE_NOT_FOUND", "CASE_STATE", "APPEAL_NOT_FOUND", "APPEAL_STATE", "SANCTION_NOT_FOUND", "SANCTION_STATE", "SOCIAL_PROFILE_NOT_FOUND",
      "CAMPAIGN_NOT_VALIDATED", "CAMPAIGN_VERSION_NOT_FOUND", "REFERRAL_NOT_FOUND", "REFERRAL_STATE", "GROUP_NOT_FOUND", "RESULT_STATE",
      "DUEL_NOT_FOUND", "ROOM_NOT_FOUND", "ROOM_NOT_ACTIVE",
    ];
    expect(codes.filter((c) => !has(`err.${c}`))).toEqual([]);
  });

  it("every error code of INTERNAL_API §12 (sprint 6) has a text in RU and EN", () => {
    const doc = readFileSync(join(__dirname, "..", "..", "..", "docs", "sprint6", "INTERNAL_API.md"), "utf8");
    const from = doc.search(/^## 12\./m);
    expect(from).toBeGreaterThan(0);
    const rest = doc.slice(from + 6);
    const next = rest.search(/^## /m);
    const sec = next < 0 ? rest : rest.slice(0, next);
    const codes = [...new Set([...sec.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]!))];
    expect(codes.length).toBeGreaterThan(25);
    for (const c of ["ITEM_CODE_TAKEN", "EVENT_CODE_TAKEN", "OPERATION_NOT_REVERSIBLE", "RULES_STATE", "EVENT_STARTS_IN_PAST", "HERO_DRAFT_MISSING"]) expect(codes).toContain(c);
    expect(codes.filter((c) => !has(`err.${c}`))).toEqual([]);
    expect(codes.filter((c) => !(`err.${c}` in en))).toEqual([]);
    // the hints the review asked for
    expect(translate("ru", "err.OPERATION_NOT_REVERSIBLE")).toMatch(/покупку отменяют возвратом/);
    expect(translate("ru", "err.RULES_STATE")).toMatch(/сначала удалите черновик/);
  });

  it("every admin error code of INTERNAL_API §8 (sprint 7) has a text in RU and EN", () => {
    const doc = readFileSync(join(__dirname, "..", "..", "..", "docs", "sprint7", "INTERNAL_API.md"), "utf8");
    const line = doc.split("\n").find((l) => l.includes("**Админка:**")) ?? "";
    const codes = [...new Set([...line.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]!))];
    expect(codes.length).toBeGreaterThan(12);
    expect(codes.filter((c) => !has(`err.${c}`))).toEqual([]);
    expect(codes.filter((c) => !(`err.${c}` in en))).toEqual([]);
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
