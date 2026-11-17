/**
 * 9.4: мягкое предложение «Добавить на главный экран» на Главной — когда и сколько раз показывать.
 *
 * Триггер — 3-й запуск Mini App (а не первое сохранённое событие / первый Watch): иконка нужна тому, кто возвращается
 * в TilHero сам; у следящих за событием есть вход из уведомлений бота, а сохранение/Watch бывают не у всех. Запуск
 * не зависит от разделов приложения и одинаково считается на любом устройстве (CloudStorage).
 * Правила: статус missed/unknown; не больше 2 показов всего; «Не сейчас» — пауза 30 дней; added/unsupported — никогда;
 * после добавления — никогда.
 * Хранение: Telegram CloudStorage (ключ [A-Za-z0-9_-]) + копия в localStorage (try/catch внутри kvStore). Читаются обе,
 * берётся «дальшая» (больше запусков и показов, done, поздняя пауза): сбой одной копии не возвращает карточку.
 */
import { kvStore, localKvStore, type HomeScreenStatus, type KvStore } from "../tg";

export const PROMPT_KEY = "hs_prompt_v1";
export const MIN_LAUNCHES = 3;
export const MAX_SHOWS = 2;
export const SNOOZE_MS = 30 * 24 * 3600 * 1000;

export interface PromptState {
  launches: number;
  shown: number;
  snoozed_until: number | null;
  done: boolean;
}

export const EMPTY: PromptState = { launches: 0, shown: 0, snoozed_until: null, done: false };

const nat = (v: unknown, max: number): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0);

export function parsePrompt(raw: string | null): PromptState {
  if (!raw) return { ...EMPTY };
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const until = typeof o.snoozed_until === "number" && Number.isFinite(o.snoozed_until) && o.snoozed_until > 0 ? o.snoozed_until : null;
    return { launches: nat(o.launches, 1000), shown: nat(o.shown, 100), snoozed_until: until, done: o.done === true };
  } catch {
    return { ...EMPTY };
  }
}

export function mergePrompt(a: PromptState, b: PromptState): PromptState {
  return {
    launches: Math.max(a.launches, b.launches),
    shown: Math.max(a.shown, b.shown),
    snoozed_until: Math.max(a.snoozed_until ?? 0, b.snoozed_until ?? 0) || null,
    done: a.done || b.done,
  };
}

export function shouldShowPrompt(s: PromptState, status: HomeScreenStatus, now = Date.now()): boolean {
  if (status !== "missed" && status !== "unknown") return false;
  if (s.done || s.shown >= MAX_SHOWS || s.launches < MIN_LAUNCHES) return false;
  return !s.snoozed_until || now >= s.snoozed_until;
}

export class PromptStore {
  constructor(
    private readonly primary: KvStore = kvStore(),
    private readonly fallback: KvStore = localKvStore(),
  ) {}

  async load(): Promise<PromptState> {
    const stores = this.primary.kind === this.fallback.kind ? [this.primary] : [this.primary, this.fallback];
    const raws = await Promise.all(stores.map((st) => st.get(PROMPT_KEY).catch(() => null)));
    return raws.map(parsePrompt).reduce(mergePrompt, { ...EMPTY });
  }

  async save(s: PromptState): Promise<void> {
    const v = JSON.stringify(s);
    const stores = this.primary.kind === this.fallback.kind ? [this.primary] : [this.primary, this.fallback];
    await Promise.all(stores.map((st) => st.set(PROMPT_KEY, v).catch(() => undefined)));
  }

  async update(fn: (s: PromptState) => PromptState): Promise<PromptState> {
    const next = fn(await this.load());
    await this.save(next);
    return next;
  }
}

/** Один счёт на запуск (Home монтируется много раз за запуск). */
let launch: Promise<PromptState> | null = null;
export function countLaunch(store: PromptStore): Promise<PromptState> {
  launch ??= store.update((s) => ({ ...s, launches: Math.min(s.launches + 1, 1000) }));
  return launch;
}
/** Показ за этот запуск уже засчитан / карточка закрыта в этом запуске. */
export const promptLaunch = { counted: false, dismissed: false };

export function resetPromptLaunchForTests(): void {
  launch = null;
  promptLaunch.counted = false;
  promptLaunch.dismissed = false;
}
