import type { ReleaseNoteItem, WhatsNew, WhatsNewNote } from "@tilhero/contracts/bff";
import { isRoute } from "../tg/deeplink";

/**
 * «Что нового» (AT-11): the sheet pages through the items of the notes, one item per card. A note counts as seen once
 * one of its cards has been on screen; seen ids go to the server when the sheet closes (POST /v1/whats-new/seen), so
 * every note is shown once. Notes the user never reached stay unseen and come back at the next login.
 */
export interface WnCard {
  key: string;
  noteId: string;
  noteTitle: string;
  item: ReleaseNoteItem;
}

/** client limits (packages/contracts/release-notes.json): ≤ 5 notes, ≤ 6 items each; the sheet shows ≤ 12 cards */
export const MAX_NOTES = 5;
export const MAX_ITEMS = 6;
export const MAX_CARDS = 12;

export function cardsOf(w: WhatsNew | null | undefined): WnCard[] {
  if (!w || w.mode === "none" || !Array.isArray(w.notes)) return [];
  const out: WnCard[] = [];
  for (const note of w.notes.slice(0, MAX_NOTES)) {
    if (!note || typeof note.release_note_id !== "string") continue;
    const items = Array.isArray(note.items) ? note.items.slice(0, MAX_ITEMS) : [];
    items.forEach((item, i) => {
      if (!item || typeof item.title !== "string") return;
      out.push({
        key: `${note.release_note_id}:${i}`,
        noteId: note.release_note_id,
        noteTitle: typeof note.title === "string" ? note.title : "",
        item: { ...item, link: isRoute(item.link) ? item.link : null },
      });
    });
  }
  return out.slice(0, MAX_CARDS);
}

/** Ids of the notes whose cards 0..upTo were shown, in order, without repeats. */
export function seenNoteIds(cards: readonly WnCard[], upTo: number): string[] {
  const out: string[] = [];
  for (const c of cards.slice(0, Math.max(0, upTo + 1))) if (!out.includes(c.noteId)) out.push(c.noteId);
  return out;
}

export function hasWhatsNew(w: WhatsNew | null | undefined): w is WhatsNew & { mode: "welcome" | "updates" } {
  return !!w && (w.mode === "welcome" || w.mode === "updates") && cardsOf(w).length > 0;
}

/** Notes newest first (published_at desc) — the feed order. */
export function newestFirst(notes: readonly WhatsNewNote[]): WhatsNewNote[] {
  return [...notes].sort((a, b) => (a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : 0));
}
