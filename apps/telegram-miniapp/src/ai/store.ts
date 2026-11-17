/**
 * Sprint 7 — whether the concierge is there and how many messages are left (GET /v1/ai/quota, INTERNAL_API §5), and
 * which chat is open. One store for the app: the entry points (detail MainButton, Home, the empty catalogue) read it,
 * the chat updates the quota from `done.quota` and from errors.
 *
 * - 503 FEATURE_UNAVAILABLE (ai-concierge not connected) or 404 (a BFF before sprint 7) → «off»: no entry points.
 * - Any other failure (network, 5xx) → «on»: the button stays, the chat says honestly what is wrong.
 */
import type { AiMode, AiQuickAction, AiQuota } from "@tilhero/contracts/bff";
import { useSyncExternalStore } from "react";
import { ApiError } from "../api/errors";

export type AiAvailability = "unknown" | "on" | "off";

export interface AiChatRequest {
  seq: number;
  mode: AiMode;
  eventId: string | null;
  /** the header line under «AI-консьерж»: the event title, or the catalogue query */
  title: string | null;
  /** home mode from the empty catalogue: the search text (≤ 120) */
  query: string | null;
}

interface State {
  availability: AiAvailability;
  quota: AiQuota | null;
  chat: AiChatRequest | null;
}

let state: State = { availability: "unknown", quota: null, chat: null };
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const setState = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  emit();
};
let loading: Promise<void> | null = null;
let seq = 0;

const isQuota = (q: unknown): q is AiQuota =>
  !!q && typeof q === "object" && typeof (q as AiQuota).limit === "number" && typeof (q as AiQuota).remaining === "number" && typeof (q as AiQuota).resets_at === "string";

export const aiStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  get: (): State => state,

  /** GET /v1/ai/quota once per session (again after `reset`). */
  load(fetchQuota: () => Promise<AiQuota>): Promise<void> {
    if (loading) return loading;
    loading = fetchQuota().then(
      (q) => setState({ availability: "on", quota: isQuota(q) ? q : null }),
      (e: unknown) => {
        const off = e instanceof ApiError && (e.code === "FEATURE_UNAVAILABLE" || e.status === 404);
        setState({ availability: off ? "off" : "on" });
        if (!off) loading = null; // a transient failure: asked again by the next screen
      },
    );
    return loading;
  },

  setQuota(q: AiQuota | null | undefined): void {
    if (isQuota(q)) setState({ quota: q });
  },
  /** 429 AI_QUOTA_EXCEEDED {limit, used, level, resets_at}: nothing left until resets_at. */
  exhausted(details: Record<string, unknown>): void {
    const limit = typeof details.limit === "number" ? details.limit : (state.quota?.limit ?? 0);
    const resets = typeof details.resets_at === "string" ? details.resets_at : (state.quota?.resets_at ?? "");
    const level = typeof details.level === "string" ? details.level : (state.quota?.level ?? "basic");
    setState({ quota: { used: limit, limit, remaining: 0, level, level_name: state.quota?.level_name ?? level, resets_at: resets } });
  },
  /** FEATURE_UNAVAILABLE in the middle of a session: the entry points go away. */
  off(): void {
    setState({ availability: "off" });
  },

  open(req: Omit<AiChatRequest, "seq">): void {
    setState({ chat: { ...req, seq: ++seq } });
  },
  close(): void {
    if (state.chat) setState({ chat: null });
  },
  reset(): void {
    loading = null;
    qaMemo.clear();
    state = { availability: "unknown", quota: null, chat: null };
    emit();
  },
};

export function useAi(): State {
  return useSyncExternalStore(aiStore.subscribe, aiStore.get, aiStore.get);
}

/** The quota line «Осталось N из 10 · обновится в ЧЧ:ММ» — numbers only; the UI words them. */
export function quotaLeft(q: AiQuota | null): { left: number; limit: number } | null {
  if (!q) return null;
  return { left: Math.max(0, Math.min(q.limit, q.remaining)), limit: q.limit };
}

/** Nothing left until `resets_at` (00:00 UTC); once that moment has passed the chat is unblocked and asks again. */
export function quotaExhausted(q: AiQuota | null | undefined, now = Date.now()): boolean {
  if (!q || q.remaining > 0) return false;
  const r = Date.parse(q.resets_at);
  return !(Number.isFinite(r) && now >= r);
}

/**
 * Quick actions by the trip they were built for (conversation × trip parameters). The server sends a set when the
 * conversation opens and after each turn (`done.quick_actions`) — for the trip as it is then. «Отменить» in «Поездка»
 * brings an earlier trip back: its set comes back from here (the server does not know about the undo).
 */
const QA_MAX = 40;
const qaMemo = new Map<string, AiQuickAction[]>();
export const quickMemo = {
  put(conversationId: string, tripKey: string, list: readonly AiQuickAction[]): void {
    if (!tripKey) return;
    const k = `${conversationId}|${tripKey}`;
    qaMemo.delete(k);
    qaMemo.set(k, [...list]);
    while (qaMemo.size > QA_MAX) qaMemo.delete(qaMemo.keys().next().value as string);
  },
  get(conversationId: string, tripKey: string): AiQuickAction[] | null {
    return tripKey ? (qaMemo.get(`${conversationId}|${tripKey}`) ?? null) : null;
  },
  clear(): void {
    qaMemo.clear();
  },
};
