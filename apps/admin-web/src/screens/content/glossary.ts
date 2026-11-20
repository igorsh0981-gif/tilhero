/**
 * Course dictionary helpers (catalog glossary, admin.ts «Словарь курса», INTERNAL_API §2.2, §2.5): the methodist's
 * entry form (lemma, forms one per line — a form may contain a comma, part of speech, RU/UZ translation, example),
 * its client checks mirroring the catalog (GlossaryCreateIn + _normalized_forms + _gloss_issues), the 422
 * GLOSSARY_INVALID {errors[{path, code, message}]} mapped onto the form fields, where a content reference opens in
 * «Контент», and the readable diff of a history record. The catalog stays the authority.
 */
import type { GlossaryCreate, GlossaryDetail, GlossaryPatch } from "@tilhero/contracts/admin";
import type { GlossaryEntry, GlossaryRef, Localized, PartOfSpeech } from "@tilhero/contracts/content";
import { formKey, normalizeForm } from "./text";

export const PARTS_OF_SPEECH: readonly PartOfSpeech[] = ["noun", "verb", "adjective", "adverb", "pronoun", "preposition", "conjunction", "interjection", "determiner", "phrase", "other"];
export const GLOSSARY_SOURCES = ["course", "methodist", "ai"] as const;
export const GLOSSARY_STATUSES = ["not_required", "pending", "approved", "rejected"] as const;
export const GLOSSARY_ACTIONS = ["created", "updated", "reviewed", "archived", "overridden"] as const;
export const GLOSSARY_LIMITS = { lemma: 60, forms: 8, form: 120, gloss: 80, example: 200, reason: 500, note: 300 } as const;
/** AI translations below this confidence are not shown to learners (content.ts GlossaryEntry.confidence) */
export const MIN_CONFIDENCE = 0.5;

const CYRILLIC = /[\u0400-\u04ff]/;
const BAD_OKINA = /[oOgG]['‘’`]/;

export interface EntryForm {
  lemma: string;
  /** one form per line (forms may contain a comma: «excuse me, where») */
  forms: string;
  part_of_speech: PartOfSpeech | "";
  ru: string;
  uz: string;
  example_en: string;
  reason: string;
}

export type FormField = "lemma" | "forms" | "ru" | "uz" | "example_en" | "reason" | "pair_id" | "part_of_speech";
export interface FormIssue {
  field: FormField;
  code: "required" | "too_long" | "too_many" | "uz_script" | "uz_okina" | "en_only" | "server";
  message?: string;
}

export const emptyForm = (): EntryForm => ({ lemma: "", forms: "", part_of_speech: "", ru: "", uz: "", example_en: "", reason: "" });

export function formOf(e: Pick<GlossaryEntry, "lemma" | "forms" | "part_of_speech" | "gloss" | "example_en">): EntryForm {
  return { lemma: e.lemma, forms: e.forms.join("\n"), part_of_speech: e.part_of_speech ?? "", ru: e.gloss.ru, uz: e.gloss.uz, example_en: e.example_en ?? "", reason: "" };
}

/** Normalised forms of the textarea (unique by key, empty lines dropped); none → the lemma itself. */
export function parseForms(text: string, lemma: string): string[] {
  const raw = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const src = raw.length ? raw : lemma.trim() ? [lemma] : [];
  const out: string[] = [];
  const keys = new Set<string>();
  for (const f of src) {
    const n = normalizeForm(f);
    const k = formKey(n);
    if (!k || keys.has(k)) continue;
    keys.add(k);
    out.push(n);
  }
  return out;
}

export function glossIssues(ru: string, uz: string): FormIssue[] {
  const out: FormIssue[] = [];
  if (!ru.trim()) out.push({ field: "ru", code: "required" });
  else if (ru.length > GLOSSARY_LIMITS.gloss) out.push({ field: "ru", code: "too_long" });
  if (!uz.trim()) out.push({ field: "uz", code: "required" });
  else if (uz.length > GLOSSARY_LIMITS.gloss) out.push({ field: "uz", code: "too_long" });
  else if (CYRILLIC.test(uz)) out.push({ field: "uz", code: "uz_script" });
  else if (BAD_OKINA.test(uz)) out.push({ field: "uz", code: "uz_okina" });
  return out;
}

/** Client checks of the methodist's entry (create / edit of a methodist or AI entry). */
export function checkEntry(f: EntryForm): FormIssue[] {
  const out: FormIssue[] = [];
  if (!f.lemma.trim()) out.push({ field: "lemma", code: "required" });
  else if (f.lemma.length > GLOSSARY_LIMITS.lemma) out.push({ field: "lemma", code: "too_long" });
  else if (CYRILLIC.test(f.lemma)) out.push({ field: "lemma", code: "en_only" });
  const lines = f.forms.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (lines.length > GLOSSARY_LIMITS.forms) out.push({ field: "forms", code: "too_many" });
  else if (lines.some((x) => x.length > GLOSSARY_LIMITS.form)) out.push({ field: "forms", code: "too_long" });
  else if (lines.some((x) => CYRILLIC.test(x))) out.push({ field: "forms", code: "en_only" });
  else if (!parseForms(f.forms, f.lemma).length) out.push({ field: "forms", code: "required" });
  out.push(...glossIssues(f.ru, f.uz));
  if (f.example_en.length > GLOSSARY_LIMITS.example) out.push({ field: "example_en", code: "too_long" });
  if (f.reason.length > GLOSSARY_LIMITS.reason) out.push({ field: "reason", code: "too_long" });
  return out;
}

export function createBody(pairId: string, f: EntryForm): GlossaryCreate {
  return {
    pair_id: pairId,
    lemma: f.lemma.trim(),
    forms: parseForms(f.forms, f.lemma),
    part_of_speech: f.part_of_speech || null,
    gloss: { ru: f.ru.trim(), uz: f.uz.trim() },
    example_en: f.example_en.trim() || null,
    reason: f.reason.trim() || null,
  };
}

/** PATCH of a methodist / AI entry: only what changed (+ the reason); null — nothing to save. */
export function patchBody(e: Pick<GlossaryEntry, "lemma" | "forms" | "part_of_speech" | "gloss" | "example_en">, f: EntryForm): GlossaryPatch | null {
  const out: GlossaryPatch = {};
  const lemma = f.lemma.trim();
  if (lemma !== e.lemma) out.lemma = lemma;
  const forms = parseForms(f.forms, f.lemma);
  if (forms.join("\n") !== e.forms.join("\n")) out.forms = forms;
  const pos = f.part_of_speech || null;
  if (pos !== e.part_of_speech) out.part_of_speech = pos;
  const gloss: Localized = { ru: f.ru.trim(), uz: f.uz.trim() };
  if (gloss.ru !== e.gloss.ru || gloss.uz !== e.gloss.uz) out.gloss = gloss;
  const ex = f.example_en.trim() || null;
  if (ex !== e.example_en) out.example_en = ex;
  if (!Object.keys(out).length) return null;
  return { ...out, reason: f.reason.trim() || null };
}

/** 422 GLOSSARY_INVALID {errors[{path: "forms[0]" | "gloss.uz" | "override.gloss.ru" | …}]} → issues of the form fields. */
export function serverIssues(errors: unknown): FormIssue[] {
  if (!Array.isArray(errors)) return [];
  const out: FormIssue[] = [];
  for (const e of errors) {
    if (!e || typeof e !== "object") continue;
    const path = String((e as { path?: unknown }).path ?? "").replace(/^(body\.|override\.)/, "");
    const message = String((e as { message?: unknown }).message ?? (e as { code?: unknown }).code ?? "");
    const field: FormField = path.startsWith("forms") ? "forms" : path.startsWith("gloss.uz") ? "uz" : path.startsWith("gloss.ru") ? "ru" : path.startsWith("gloss") ? "ru" : path.startsWith("example") ? "example_en" : path.startsWith("lemma") ? "lemma" : path.startsWith("pair") ? "pair_id" : path.startsWith("part") ? "part_of_speech" : "reason";
    out.push({ field, code: "server", message });
  }
  return out;
}

/** Content tab of «Контент» where a reference of the dictionary opens. */
export function refRoute(ref: Pick<GlossaryRef, "kind" | "key">): string {
  const tab = ref.kind === "lesson" ? "lessons" : ref.kind === "media_asset" ? "media" : ref.kind === "reading" ? "readings" : "scenarios";
  return `${tab}/${ref.key}`;
}

/** Changed fields of a history record (before → after), readable: «gloss.ru: старое → новое». */
export function historyChanges(before: Partial<GlossaryEntry> | null, after: Partial<GlossaryEntry> | null): Array<{ field: string; before: string; after: string }> {
  const flat = (v: unknown, base: string, out: Record<string, string>) => {
    if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) flat(x, base ? `${base}.${k}` : k, out);
    else out[base] = v == null ? "—" : Array.isArray(v) ? v.join(", ") : String(v);
  };
  const a: Record<string, string> = {};
  const b: Record<string, string> = {};
  flat(before ?? {}, "", a);
  flat(after ?? {}, "", b);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => k && !["by", "at"].some((x) => k.endsWith(`.${x}`)));
  return keys.filter((k) => a[k] !== b[k]).map((k) => ({ field: k, before: a[k] ?? "—", after: b[k] ?? "—" }));
}

/** What a staff member may do with an entry (UX; the catalog re-checks with glossary.manage). */
export function entryActions(e: Pick<GlossaryDetail, "source" | "review_status" | "archived_at" | "override">, canManage: boolean) {
  const live = canManage && !e.archived_at;
  return {
    edit: live && (e.source === "methodist" || e.source === "ai") && e.review_status !== "rejected",
    override: live && e.source === "course",
    unoverride: live && e.source === "course" && !!e.override,
    review: live && e.source === "ai" && e.review_status === "pending",
    archive: live && e.source === "methodist",
  };
}
