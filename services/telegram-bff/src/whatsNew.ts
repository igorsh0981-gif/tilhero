/**
 * Доработка 9.4 «Что нового»: лента опубликованных заметок о релизах (experience-config) и отбор непросмотренных
 * для пользователя по отметке в preferences.
 *
 * Лента кэшируется в памяти инстанса как Remote Experience Config (ExperienceCache): TTL (EXPERIENCE_CACHE_SECONDS,
 * 60 с) + stale-cache — при недоступности experience-config отдаётся последняя полученная лента. Публикация видна
 * пользователям не позже чем через TTL.
 */
import { createHash } from "node:crypto";
import type { ReleaseNote, ReleaseNoteIcon, ReleaseNoteRoute } from "@tilhero/contracts/bff";
import type { DomainClient } from "./upstream.js";

export const FEED_LIMIT = 10;
/** Белые списки (packages/contracts/release-notes.json): пункт с другим маршрутом/иконкой Mini App не получит. */
export const NOTE_ROUTES: readonly ReleaseNoteRoute[] = ["home", "catalog", "watch", "news", "profile", "support"];
export const NOTE_ICONS: readonly ReleaseNoteIcon[] = [
  "spark", "ticket", "globe", "pin", "bell", "radar", "news", "route", "star", "plane", "bed", "search", "shield", "chat",
  "cal", "phone",
];
export const CLIENT_MAX_NOTES = 3;
export const FORCE_MIN_MS = 5000;

/** Заметка из ленты experience-config (с аудиторией — она в Mini App не уходит). */
export interface FeedNote extends ReleaseNote {
  audience: "all" | "existing";
}

/** preferences GET /internal/v1/me/release-notes/seen */
export interface SeenState {
  release_note_id: string | null;
  published_at: string | null;
  onboarding_completed_at: string | null;
}

export class ReleaseNotesFeed {
  private value: FeedNote[] | null = null;
  private fetchedAt = 0;
  private inflight: Promise<FeedNote[]> | null = null;

  constructor(
    private readonly client: DomainClient,
    private readonly ttlMs: number,
    private readonly onStale?: (err: unknown) => void,
  ) {}

  /** force — мимо кэша (Mini App прислал id заметки, которой в кэше ещё нет: публикация моложе TTL), но не чаще
   *  раза в FORCE_MIN_MS: поток запросов с выдуманными id не превращается в поток запросов к experience-config. */
  async get(force = false): Promise<FeedNote[]> {
    const age = Date.now() - this.fetchedAt;
    if (this.value && (force ? age < FORCE_MIN_MS : age < this.ttlMs)) return this.value;
    this.inflight ??= this.client
      .get<{ items: FeedNote[] }>("/internal/v1/release-notes/published", { query: { limit: FEED_LIMIT } })
      .then((r) => sortNewestFirst(r.items))
      .finally(() => {
        this.inflight = null;
      });
    try {
      const notes = await this.inflight;
      this.value = notes;
      this.fetchedAt = Date.now();
      return notes;
    } catch (err) {
      if (this.value) {
        this.onStale?.(err);
        return this.value;
      }
      throw err;
    }
  }
}

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

export function sortNewestFirst(notes: FeedNote[]): FeedNote[] {
  return notes.filter((n) => Number.isFinite(ms(n.published_at))).sort((a, b) => ms(b.published_at) - ms(a.published_at));
}

export interface WhatsNewPick {
  /** непросмотренные, новые первыми, ≤ 3 */
  items: FeedNote[];
  /** новый пользователь: отметить эту заметку просмотренной (старые заметки ему не показываются) */
  baseline: FeedNote | null;
}

/**
 * Какие заметки показать (notes — новые первыми).
 *  - Отметка есть: заметки новее неё. Аудитория «existing» — только если пользователь прошёл онбординг до публикации.
 *  - Отметки нет (первое обращение): заметки, опубликованные после онбординга пользователя (кто пользовался TilHero
 *    до появления «Что нового», увидит изменения со своего прихода). Если таких нет — пользователь новый: старые
 *    заметки не показываются, последняя отмечается просмотренной; исключение — последняя с аудиторией «all»
 *    (её новый пользователь увидит один раз, отметка — при закрытии шторки).
 *  - Онбординг не пройден — ничего (шторка не показывается поверх онбординга).
 */
export function pickWhatsNew(notes: FeedNote[], seen: SeenState): WhatsNewPick {
  const onboarded = ms(seen.onboarding_completed_at);
  if (!notes.length || !Number.isFinite(onboarded)) return { items: [], baseline: null };
  const lastSeen = ms(seen.published_at);
  if (Number.isFinite(lastSeen)) {
    const items = notes.filter((n) => ms(n.published_at) > lastSeen && (n.audience === "all" || onboarded < ms(n.published_at)));
    return { items: items.slice(0, CLIENT_MAX_NOTES), baseline: null };
  }
  const sinceJoined = notes.filter((n) => ms(n.published_at) > onboarded);
  if (sinceJoined.length) return { items: sinceJoined.slice(0, CLIENT_MAX_NOTES), baseline: null };
  const latest = notes[0]!;
  return latest.audience === "all" ? { items: [latest], baseline: null } : { items: [], baseline: latest };
}

/** Заметка для Mini App: без аудитории (сериализатор по схеме отбросил бы её и так). */
export function noteView(n: FeedNote): ReleaseNote {
  return {
    release_note_id: n.release_note_id,
    slug: n.slug,
    title: n.title,
    // недоверенные данные домена: маршрут/иконка не из белого списка → null (пункт без ссылки/иконки)
    items: n.items.map((i) => ({
      title: i.title,
      text: i.text,
      link: i.link && NOTE_ROUTES.includes(i.link) ? i.link : null,
      icon: i.icon && NOTE_ICONS.includes(i.icon) ? i.icon : null,
    })),
    published_at: n.published_at,
  };
}

/** Слабый ETag по содержимому ответа: тот же набор заметок и та же последняя → 304 на If-None-Match. */
export function etagOf(body: unknown): string {
  return `W/"${createHash("sha256").update(JSON.stringify(body)).digest("base64url").slice(0, 27)}"`;
}

export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return header === "*" || header.split(",").some((t) => strip(t) === strip(etag));
}
