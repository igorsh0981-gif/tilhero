/**
 * Pure rules of the communications section (no React): the «Что нового» catalogue of packages/contracts/
 * release-notes.json (routes, icons, limits — cross-checked by test/catalog.test.ts), draft validation with the field
 * paths the server uses (`title.uz`, `items[1].text.uz`), and the text rules of notifications domain/texts.py for
 * template versions and campaigns (`texts.uz.body`; placeholders `{name}`, `{{`/`}}` literal braces, pressure words for
 * child templates). The server re-checks everything; the client only highlights early.
 */
import type {
  AgeSegment,
  CampaignContent,
  CampaignSegment,
  ReleaseNoteAudience,
  ReleaseNoteContent,
  ReleaseNoteIcon,
  ReleaseNoteRoute,
  TemplatePlaceholder,
  TemplateText,
  TemplateTexts,
  UiLang,
} from "@tilhero/contracts/admin";
import { PRESSURE_WORDS } from "../../i18n/learner";

export const LANGS: readonly UiLang[] = ["ru", "uz"];

/* ---------------------------------------------------------------- «Что нового» catalogue */

export const NOTE_ROUTES: readonly ReleaseNoteRoute[] = [
  "home", "lessons", "review", "progress", "profile", "schedule", "notifications", "family", "support", "news",
  // sprint 3: diagnostics, plan, skill map, scenarios, media library, song/film requests, «Мои языки»
  "diagnostics", "plan", "skills", "scenarios", "media", "media_requests", "languages",
  // release 6.1: the game (heroes, shop, badges, history, settings), the dictionary, reading
  "heroes", "shop", "badges", "game_history", "game_settings", "dictionary", "reading",
  // sprint 7: friends (requests, blocks, sanctions), weekly leagues, duels, referrals — no route of its own for a pair
  // lesson: it starts from «Друзья» and the link room_<room_id>
  "friends", "leagues", "duels", "referrals",
  // sprint 8: «Подписка» and «Купить тилы» (Telegram Stars only)
  "subscription", "til_shop",
];
export const NOTE_ICONS: readonly ReleaseNoteIcon[] = ["spark", "hero", "calendar", "clock", "bell", "book", "chat", "mic", "star", "flame", "users", "gift", "shield", "globe", "trophy", "news"];
export const AUDIENCES: readonly ReleaseNoteAudience[] = ["new", "existing", "all"];
export const AGE_SEGMENTS: readonly AgeSegment[] = ["kids", "teens", "adults"];
export const NOTE_LIMITS = { title: 80, itemTitle: 80, itemText: 200, itemsMin: 1, itemsMax: 6, clientMaxNotes: 5 } as const;

/**
 * Release 6.1: illustrations of the notes — the catalogue keys (`illustrations`, newest last) and the very files of the
 * Mini App build (apps/telegram-miniapp/public/whatsnew/<key>.webp, 16:9, 1200×675), bundled into this build for the
 * picker and the phone preview. A new release adds its key here, in the catalogue and in experience-config.
 */
export const NOTE_ILLUSTRATIONS: readonly string[] = ["welcome", "s6-heroes", "s7-social", "s7-family", "s8-plus", "s8-plus-kids"];
export const ILLUSTRATION_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const ILLUSTRATION_SIZE = { width: 1200, height: 675 } as const;
const ILLUSTRATION_FILES = import.meta.glob<string>("../../../../telegram-miniapp/public/whatsnew/*.webp", { eager: true, query: "?url", import: "default" });
/** key → URL of the bundled file (keys of the files present in the Mini App) */
export const ILLUSTRATION_URLS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ILLUSTRATION_FILES).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".webp".length), url]),
);
export const illustrationUrl = (key: string | null | undefined): string | null => (key && NOTE_ILLUSTRATIONS.includes(key) ? (ILLUSTRATION_URLS[key] ?? null) : null);
export const SLUG = /^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$/;
/** C0/C1 control characters and bidi overrides (server: unicodedata Cc + U+202A..202E, U+2066..2069) */
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const CONTROL_NL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export type NoteDraft = ReleaseNoteContent;
export type FieldReason = "required" | "too_long" | "invalid_format" | "control_chars" | "unknown_placeholder" | "invalid_placeholder" | "pressure_words" | "server";
export interface FieldIssue {
  reason: FieldReason;
  max?: number;
  names?: string[];
}
export type Issues = Record<string, FieldIssue>;

export const emptyItem = (): NoteDraft["items"][number] => ({ title: { ru: "", uz: "" }, text: { ru: "", uz: "" }, link: null, icon: "spark" });

/** Next free «YYYY.MM» label (2026.11 → 2026.11-2 when taken). */
export function nextSlug(taken: readonly string[], now = new Date()): string {
  const base = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
  return base;
}

export function emptyNote(slug: string): NoteDraft {
  return { slug, title: { ru: "", uz: "" }, items: [emptyItem()], audience: "existing", segments: {}, illustration: null };
}

export function noteContent(n: NoteDraft): NoteDraft {
  return {
    slug: n.slug,
    title: { ru: n.title.ru ?? "", uz: n.title.uz ?? "" },
    items: n.items.map((i) => ({ title: { ru: i.title.ru ?? "", uz: i.title.uz ?? "" }, text: { ru: i.text.ru ?? "", uz: i.text.uz ?? "" }, link: i.link ?? null, icon: i.icon ?? null })),
    audience: n.audience,
    segments: { ...(n.segments?.age?.length ? { age: [...n.segments.age] } : {}), ...(n.segments?.ui_lang?.length ? { ui_lang: [...n.segments.ui_lang] } : {}) },
    illustration: n.illustration ?? null,
  };
}

/** Plain-text cleanup as on the server: whitespace collapsed, trimmed. */
export const clean = (s: string) => s.replace(/[ \t\r\n]+/g, " ").trim();

export function normalizeNote(d: NoteDraft): NoteDraft {
  const c = noteContent(d);
  return {
    ...c,
    slug: c.slug.trim(),
    title: { ru: clean(c.title.ru), uz: clean(c.title.uz) },
    items: c.items.map((i) => ({ ...i, title: { ru: clean(i.title.ru), uz: clean(i.title.uz) }, text: { ru: clean(i.text.ru), uz: clean(i.text.uz) } })),
  };
}

/** Field issues by server path: `slug`, `title.ru`, `items[0].text.uz`, `items`. */
export function validateNote(raw: NoteDraft): Issues {
  const d = normalizeNote(raw);
  const out: Issues = {};
  if (!SLUG.test(d.slug)) out.slug = { reason: "invalid_format" };
  const text = (path: string, v: string, max: number) => {
    if (!v) out[path] = { reason: "required" };
    else if (v.length > max) out[path] = { reason: "too_long", max };
    else if (CONTROL.test(v)) out[path] = { reason: "control_chars" };
  };
  for (const l of LANGS) text(`title.${l}`, d.title[l], NOTE_LIMITS.title);
  if (d.items.length < NOTE_LIMITS.itemsMin || d.items.length > NOTE_LIMITS.itemsMax) out.items = { reason: d.items.length ? "too_long" : "required", max: NOTE_LIMITS.itemsMax };
  d.items.forEach((it, k) => {
    for (const l of LANGS) {
      text(`items[${k}].title.${l}`, it.title[l], NOTE_LIMITS.itemTitle);
      text(`items[${k}].text.${l}`, it.text[l], NOTE_LIMITS.itemText);
    }
    if (it.link && !NOTE_ROUTES.includes(it.link)) out[`items[${k}].link`] = { reason: "invalid_format" };
    if (it.icon && !NOTE_ICONS.includes(it.icon)) out[`items[${k}].icon`] = { reason: "invalid_format" };
  });
  if (d.illustration && !NOTE_ILLUSTRATIONS.includes(d.illustration)) out.illustration = { reason: "invalid_format" };
  return out;
}

/** Empty translations of a language (for the tab badge): paths ending in `.ru` / `.uz` with reason required. */
export function missingIn(issues: Issues, lang: UiLang): string[] {
  return Object.keys(issues).filter((p) => p.endsWith(`.${lang}`) && issues[p]!.reason === "required");
}

/** Paths of a 422 RELEASE_NOTE_TRANSLATION_MISSING {missing} → issues. */
export function missingToIssues(missing: unknown): Issues {
  const out: Issues = {};
  if (Array.isArray(missing)) for (const p of missing) if (typeof p === "string" && p.length < 64) out[p] = { reason: "required" };
  return out;
}

/** 422 VALIDATION_ERROR {field | errors[{loc}]} / TEMPLATE_INVALID / CAMPAIGN_INVALID {fields[{path, reason}]} → issues. */
export function serverIssues(details: Record<string, unknown>): Issues {
  const out: Issues = {};
  const reasons: readonly string[] = ["required", "too_long", "invalid_format", "control_chars", "unknown_placeholder", "invalid_placeholder", "pressure_words"];
  const add = (path: unknown, reason: unknown) => {
    if (typeof path !== "string" || !path || path.length > 64) return;
    out[path] = { reason: typeof reason === "string" && reasons.includes(reason) ? (reason as FieldReason) : "server" };
  };
  if (Array.isArray(details.fields)) for (const f of details.fields as Array<{ path?: unknown; reason?: unknown }>) add(f?.path, f?.reason);
  if (Array.isArray(details.missing)) Object.assign(out, missingToIssues(details.missing));
  if (Array.isArray(details.errors))
    for (const e of details.errors as Array<{ loc?: unknown[]; type?: unknown }>) {
      if (!Array.isArray(e?.loc)) continue;
      const path = e.loc
        .filter((x) => x !== "body")
        .reduce<string>((acc, x) => (typeof x === "number" ? `${acc}[${x}]` : acc ? `${acc}.${String(x)}` : String(x)), "");
      add(path, "server");
    }
  if (typeof details.field === "string") add(details.field, "server");
  return out;
}

/* ---------------------------------------------------------------- template / campaign texts (notifications texts.py) */

export const TEXT_LIMITS = { title: 80, body: 1000, button: 32 } as const;
export const CAMPAIGN_TITLE_MAX = 120;
export const TEXT_FIELDS = ["title", "body", "button"] as const;
export type TextField = (typeof TEXT_FIELDS)[number];
const IDENT = /^[a-z][a-z0-9_]{0,39}$/;
const APOSTROPHES = /['‘’`ʼ]/g;

export { PRESSURE_WORDS };
export const hasPressure = (text: string) => PRESSURE_WORDS.test(text.replace(APOSTROPHES, "ʻ"));

/**
 * Placeholder names of a text with Python str.format semantics: `{{`/`}}` are literal braces; `{name}` — an identifier
 * only (no format spec, conversion, attribute or index). `invalid` — unpaired brace or a field that is not a name.
 */
export function placeholdersIn(text: string): { names: string[]; invalid: string[] } {
  const names: string[] = [];
  const invalid: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "{") {
      if (text[i + 1] === "{") {
        i += 2;
        continue;
      }
      const end = text.indexOf("}", i + 1);
      if (end < 0) {
        invalid.push(text.slice(i, i + 12));
        break;
      }
      const field = text.slice(i + 1, end);
      if (IDENT.test(field)) names.push(field);
      else invalid.push(`{${field}}`);
      i = end + 1;
      continue;
    }
    if (c === "}") {
      if (text[i + 1] === "}") {
        i += 2;
        continue;
      }
      invalid.push("}");
    }
    i += 1;
  }
  return { names, invalid };
}

/** Substitution for the live preview: known names from `values`, literal braces unfolded, double spaces collapsed. */
export function substitute(text: string, values: Record<string, string>): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if ((c === "{" && text[i + 1] === "{") || (c === "}" && text[i + 1] === "}")) {
      out += c;
      i += 2;
      continue;
    }
    if (c === "{") {
      const end = text.indexOf("}", i + 1);
      const field = end > 0 ? text.slice(i + 1, end) : "";
      if (end > 0 && IDENT.test(field)) {
        out += values[field] ?? `{${field}}`;
        i = end + 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out
    .split("\n")
    .map((l) => l.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .trim();
}

export const emptyText = (): TemplateText => ({ title: "", body: "", button: null });
export const emptyTexts = (): TemplateTexts => ({ ru: emptyText(), uz: emptyText() });
export const cloneTexts = (x: TemplateTexts): TemplateTexts => ({ ru: { ...x.ru }, uz: { ...x.uz } });

/** Field issues of template / campaign texts by server path (`texts.uz.body`). */
export function checkTexts(texts: TemplateTexts, allowed: readonly string[], kid = false, prefix = "texts"): Issues {
  const out: Issues = {};
  const set = new Set(allowed);
  for (const lang of LANGS) {
    for (const f of TEXT_FIELDS) {
      const path = `${prefix}.${lang}.${f}`;
      const raw = texts[lang][f];
      const v = (raw ?? "").trim();
      if (!v) {
        if (f !== "button") out[path] = { reason: "required" };
        continue;
      }
      if (v.length > TEXT_LIMITS[f]) out[path] = { reason: "too_long", max: TEXT_LIMITS[f] };
      else if ((f === "body" ? CONTROL_NL : CONTROL).test(v)) out[path] = { reason: "control_chars" };
      else {
        const p = placeholdersIn(v);
        const unknown = [...new Set(p.names.filter((n) => !set.has(n)))];
        if (p.invalid.length) out[path] = { reason: "invalid_placeholder", names: p.invalid };
        else if (unknown.length) out[path] = { reason: "unknown_placeholder", names: unknown };
        else if (kid && hasPressure(v)) out[path] = { reason: "pressure_words" };
      }
    }
  }
  return out;
}

export function normalizeTexts(x: TemplateTexts): TemplateTexts {
  const one = (t: TemplateText): TemplateText => ({ title: t.title.trim(), body: t.body.trim(), button: t.button && t.button.trim() ? t.button.trim() : null });
  return { ru: one(x.ru), uz: one(x.uz) };
}

export function samples(placeholders: readonly TemplatePlaceholder[], lang: UiLang): Record<string, string> {
  return Object.fromEntries(placeholders.map((p) => [p.name, p.sample[lang] ?? p.sample.ru]));
}

/* ---------------------------------------------------------------- campaigns */

/** Only {learner_name} in campaigns (INTERNAL_API notifications). */
export const CAMPAIGN_PLACEHOLDERS = ["learner_name"] as const;

export function emptyCampaign(): CampaignContent {
  return { title: "", texts: emptyTexts(), route: "home", segment: { ui_lang: ["ru", "uz"], age: ["adults"] } };
}

export function campaignContent(c: CampaignContent): CampaignContent {
  return { title: c.title, texts: cloneTexts(c.texts), route: c.route ?? null, segment: normalizeSegment(c.segment) };
}

export function normalizeSegment(s: CampaignSegment | null | undefined): CampaignSegment {
  const out: CampaignSegment = {};
  if (s?.ui_lang?.length) out.ui_lang = LANGS.filter((l) => s.ui_lang!.includes(l));
  if (s?.age?.length) out.age = (["teens", "adults"] as const).filter((a) => s.age!.includes(a));
  if (typeof s?.onboarded === "boolean") out.onboarded = s.onboarded;
  if (typeof s?.active_days === "number" && s.active_days !== 0) out.active_days = s.active_days;
  return out;
}

export function validateCampaign(c: CampaignContent): Issues {
  const out: Issues = checkTexts(c.texts, CAMPAIGN_PLACEHOLDERS);
  const title = c.title.trim();
  if (!title) out.title = { reason: "required" };
  else if (title.length > CAMPAIGN_TITLE_MAX) out.title = { reason: "too_long", max: CAMPAIGN_TITLE_MAX };
  const d = c.segment.active_days;
  if (d != null && (!Number.isInteger(d) || d === 0 || Math.abs(d) > 90)) out["segment.active_days"] = { reason: "invalid_format" };
  return out;
}

/**
 * Scheduling «at a chosen time» (review T2-2). notifications treats send_at closer than 1 min (and up to 5 min in the
 * past) as «as soon as possible» and refuses anything older (422 CAMPAIGN_INVALID {send_at: in_past}). A chosen time
 * therefore has to be at least SEND_AT_MIN_LEAD_MS ahead, otherwise a forgotten date (today 09:00 typed at 17:00) would
 * silently go out now. «Send now» is a separate, explicit choice.
 */
export const SEND_AT_MIN_LEAD_MS = 2 * 60_000;
export const SEND_AT_MAX_AHEAD_MS = 30 * 86_400_000;
export type SendAtProblem = "invalid_format" | "in_past" | "too_far";

/** `local` — the value of <input type="datetime-local"> in the viewer's time zone. */
export function checkSendAt(local: string, now: number): SendAtProblem | null {
  const ms = local ? new Date(local).getTime() : NaN;
  if (Number.isNaN(ms)) return "invalid_format";
  if (ms < now + SEND_AT_MIN_LEAD_MS) return "in_past";
  if (ms > now + SEND_AT_MAX_AHEAD_MS) return "too_far";
  return null;
}

export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Issues of one language (badge on the RU/UZ tab). */
export function issuesIn(issues: Issues, lang: UiLang): number {
  return Object.keys(issues).filter((p) => p.split(".").includes(lang)).length;
}
