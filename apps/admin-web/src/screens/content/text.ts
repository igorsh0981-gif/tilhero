/**
 * English text of the content as the catalog sees it (services/catalog domain/text.py, INTERNAL_API §1.6, §2.2,
 * §2.3): word tokens, the word count of a reading sentence (a hyphenated word is one: well-known), «the glossary word
 * occurs in the text» (token sequence by word boundaries, case and punctuation ignored, a hyphen splits: «check» and
 * «check-in» both occur in «check-in») and the normalised form of a course dictionary entry. The client uses it for the
 * live counters and the highlighting; the catalog stays the authority (422 CONTENT_INVALID / GLOSSARY_INVALID).
 */
import type { ReadingPayload } from "@tilhero/contracts/content";

const APOSTROPHES = /[’‘`ʼ]/g;
const TOKEN = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;
const HYPHEN_TOKEN = /[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu;
const EDGE_QUOTES = "\"'«»“”„";
const FORM_TRAILING = ".!?…,;:";
const ELLIPSIS = /…|\.{3,}/g;

const base = (text: string): string => text.normalize("NFC").replace(APOSTROPHES, "'").toLowerCase().replace(/\s+/g, " ").trim();

/** Words by boundaries: letters and digits, an inner apostrophe stays (i'm, don't, o'clock); a hyphen splits. */
export function tokens(text: string): string[] {
  return base(text).match(TOKEN) ?? [];
}

/** Words with a hyphen kept as one word (check-in) — the word count of a sentence. */
export function hyphenTokens(text: string): string[] {
  return base(text).match(HYPHEN_TOKEN) ?? [];
}

export const wordCount = (text: string): number => hyphenTokens(text).length;

/** Key of a form: the tokens joined by a space («Excuse me, where…» and «excuse me where» are one form). */
export const formKey = (text: string): string => tokens(text).join(" ");

/** The query occurs in the text as a run of whole words (case and punctuation ignored): «meet you» in «Nice to meet you». */
export function contains(text: string, query: string): boolean {
  const hay = tokens(text);
  const needle = tokens(query);
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, j) => hay[i + j] === w)) return true;
  return false;
}

/**
 * Character ranges of the original `text` where `query` occurs (for the highlighting of the glossary in the text).
 * Offsets are those of `text` itself: the apostrophes are replaced one character for one, nothing else moves.
 */
export function spans(text: string, query: string): Array<[number, number]> {
  const needle = tokens(query);
  if (!needle.length) return [];
  const src = text.replace(APOSTROPHES, "'");
  const words = [...src.matchAll(TOKEN)].map((m) => ({ w: m[0].normalize("NFC").toLowerCase(), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const out: Array<[number, number]> = [];
  for (let i = 0; i + needle.length <= words.length; i++) {
    if (needle.every((w, j) => words[i + j]!.w === w)) {
      out.push([words[i]!.start, words[i + needle.length - 1]!.end]);
      i += needle.length - 1;
    }
  }
  return out;
}

export interface Segment {
  text: string;
  /** index of the glossary item highlighted here; null — plain text */
  item: number | null;
}

/**
 * The text cut into plain and highlighted segments by the glossary items (the first item wins where two overlap;
 * a longer phrase is tried before a shorter one so «very kind» is not hidden by «kind»).
 */
export function highlight(text: string, items: readonly string[]): Segment[] {
  const order = items.map((en, i) => ({ en, i, n: tokens(en).length })).sort((a, b) => b.n - a.n || a.i - b.i);
  const taken: Array<[number, number, number]> = [];
  for (const it of order) {
    for (const [s, e] of spans(text, it.en)) if (!taken.some(([ts, te]) => s < te && ts < e)) taken.push([s, e, it.i]);
  }
  taken.sort((a, b) => a[0] - b[0]);
  const out: Segment[] = [];
  let at = 0;
  for (const [s, e, i] of taken) {
    if (s > at) out.push({ text: text.slice(at, s), item: null });
    out.push({ text: text.slice(s, e), item: i });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), item: null });
  return out;
}

function stripEdges(text: string, trailing: string): string {
  let prev: string | null = null;
  let t = text;
  while (prev !== t) {
    prev = t;
    t = t.trim();
    if (t && trailing.includes(t[t.length - 1]!)) t = t.slice(0, -1);
    if (t && EDGE_QUOTES.includes(t[0]!)) t = t.slice(1);
    if (t && EDGE_QUOTES.includes(t[t.length - 1]!)) t = t.slice(0, -1);
  }
  return t;
}

/** A form of a course dictionary entry as the catalog stores it: §1.6 + no «…» placeholder and no trailing , ; : */
export function normalizeForm(text: string): string {
  return stripEdges(base(text).replace(ELLIPSIS, " ").replace(/\s+/g, " ").trim(), FORM_TRAILING);
}

/** Words of the whole reading text (the sum of its sentences, as the catalog counts READING_WORDS). */
export function readingWords(p: Pick<ReadingPayload, "paragraphs">): number {
  return p.paragraphs.reduce((a, para) => a + para.sentences.reduce((b, s) => b + wordCount(s.text_en), 0), 0);
}

/** The sentences (s_id) of the text where the glossary item occurs. */
export function occurrences(p: Pick<ReadingPayload, "paragraphs">, en: string): string[] {
  const out: string[] = [];
  for (const para of p.paragraphs) for (const s of para.sentences) if (contains(s.text_en, en)) out.push(s.s_id);
  return out;
}
