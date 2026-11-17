import type { AiActionRequest, AiConversation, AiDoneAction, AiError, TilHeroRef, AiGreeting, AiMessageRequest, AiQuickAction, AiSegment, AiSource, AiSseEvent, AiToolArgs, AiToolName, AiTripParams } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { newIdempotencyKey } from "../../api/client";
import { ApiError } from "../../api/errors";
import { rateLimits, rateLimitWait, useRateWait } from "../../api/rateLimit";
import { aiErrorKey, applyEvent, flightSearchUrl, changeNote, contextChips, fromHistory, liveQuickActions, MAX_INPUT, newAnswer, toolLine, type ChatAnswer, type ChatItem, type ChatTool, type ChatUser } from "../../ai/chat";
import { runTurn } from "../../ai/sse";
import { aiStore, quickMemo, quotaExhausted, quotaLeft, useAi, type AiChatRequest } from "../../ai/store";
import { greetingText, hasKey as has, noteText as aiNote, quickActionLabel, tierName as tierOf } from "../../ai/text";
import { tripBridge, tripKey, type TripNote } from "../../ai/tripBridge";
import { formatMoney } from "../../events/format";
import { DICTS, useI18n, type MessageKey, type Vars } from "../../i18n";
import { useApp } from "../../state/app";
import { haptic, openExternal } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Spinner } from "../../ui/kit";
import { Sheet } from "../../ui/overlays";
import { useWatchRef } from "../../watch/store";
import { useWatchAction } from "../watch/WatchSheet";
import { TickingText } from "../../ui/TickingText";

/**
 * Sprint 7 — the AI concierge (AGENT_BRIEF F, prototype v9 65-ai.js): a sheet-chat over the event detail or Home.
 * The tool first, then the explanation: a tool card («Пересчитываю у поставщиков…» → «Проверено у поставщиков» / ✕),
 * the answer in segments marked «факт / оценка / рекомендация» with sources (Telegram openLink). The AI's text is
 * plain text (React escapes it). A trip a tool priced is applied to «Поездка» through its own recalculation.
 * Quick actions come from the server; the quota line says how many messages are left today. Failures are said as
 * they are: no price is guessed, «Повторить» repeats the same tool, «Следить за ценой» puts the event on Watch.
 */

const RETRYABLE = new Set(["AI_PROVIDER_UNAVAILABLE", "AI_TIMEOUT", "AI_BUSY", "AI_TURN_IN_PROGRESS", "RATE_LIMITED", "NETWORK", "SERVICE_UNAVAILABLE", "UPSTREAM_UNAVAILABLE", "UNKNOWN", "TURN_LOST"]);
/** a stop for the whole chat (no composer): the switch, the budget, the feature gone (the limit — from the quota) */
const BLOCKING = new Set(["AI_CONCIERGE_PAUSED", "AI_BUDGET_EXHAUSTED", "FEATURE_UNAVAILABLE"]);
/** pauses between re-reads of a turn still running after a broken stream: ≈ 20 s in all */
const RECOVER_WAITS = [0, 1000, 2000, 3000, 4000, 5000, 5000];
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        resolve();
      },
      { once: true },
    );
  });
const MAX_SAID = 600;
/** telegram-bff's rate-limit policy of concierge turns (INTERNAL_API sprint 9 §2) */
const AI_POLICY = "tg.ai";
/** how long the announced answer stays in the live region (screen readers queue it at once) */
const SAID_MS = 3000;

type Input = { kind: "text"; text: string } | { kind: "action"; tool: AiToolName; args: AiToolArgs; label: string | null };
/** what was sent for an answer: «Повторить» repeats it; `fresh` — the server finished that turn, a new one is needed */
interface SentTurn {
  input: Input;
  body: AiMessageRequest | AiActionRequest;
  tool: AiToolName | null;
  fresh: boolean;
  /** the stream broke and the turn was not found in the conversation (TURN_LOST) */
  lost?: boolean;
}

export function AiChatHost() {
  const { chat } = useAi();
  return chat ? <AiChat key={chat.seq} req={chat} /> : null;
}

function AiChat({ req }: { req: AiChatRequest }) {
  const { api, navigate } = useApp();
  const { t, tp, fmt, lang } = useI18n();
  const { quota } = useAi();
  const [conv, setConv] = useState<AiConversation | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [blocked, setBlocked] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const createKey = useRef(newIdempotencyKey());
  const opened = useRef(false);
  const busyRef = useRef(false);
  // sprint 9: a 429 of the concierge (or of the user) in force — «Отправить», quick actions and «Повторить» wait
  const rl = useRateWait([AI_POLICY]);
  const limited = rl.left > 0;
  const reqs = useRef(new Map<string, SentTurn>());
  const alive = useRef(true);
  const [applyFailed, setApplyFailed] = useState<Record<string, true>>({});
  const [, setTick] = useState(0);
  const stopRef = useRef<HTMLDivElement>(null);
  const ac = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const autoSent = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const close = useCallback(() => aiStore.close(), []);

  // the limit holds until resets_at (00:00 UTC); after that the chat is open again and the quota is asked anew
  const exhausted = quotaExhausted(quota);
  const stale = !!quota && !exhausted && quota.remaining <= 0;
  const left = stale ? null : quotaLeft(quota);
  const stop = exhausted ? "AI_QUOTA_EXCEEDED" : blocked;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!quota || quota.remaining > 0) return;
    const at = Date.parse(quota.resets_at);
    const ms = Number.isFinite(at) ? Math.min(Math.max(at - Date.now() + 1000, 0), 2_147_000_000) : 60_000;
    const id = setTimeout(() => {
      setTick((x) => x + 1);
      api.ai.quota().then(
        (q) => aiStore.setQuota(q),
        () => undefined,
      );
    }, ms);
    return () => clearTimeout(id);
  }, [api, quota]);

  /* ---------- the conversation: POST /v1/ai/conversations (an open one of the same event comes back with history) */
  const start = useCallback(() => {
    setStarting(true);
    setStartErr(null);
    const trip = req.mode === "event" ? tripBridge.get(req.eventId) : null;
    const body =
      req.mode === "event"
        ? { mode: req.mode, event_id: req.eventId ?? undefined, ...(trip ? { trip_params: trip } : {}) }
        : { mode: req.mode, ...(req.query ? { query: req.query.slice(0, 120) } : {}) };
    api.ai.create(body, createKey.current).then(
      (c) => {
        aiStore.setQuota(c.quota);
        // the same Idempotency-Key answers twice (a retry, dev StrictMode): the first answer opens the chat, a later
        // one must not wipe the turns that started meanwhile
        if (opened.current) return;
        opened.current = true;
        setStartErr(null);
        // a new conversation: its quick actions are for the trip sent with it (kept for «Отменить» in «Поездка»)
        if (!c.messages?.length && trip) quickMemo.put(c.conversation_id, tripKey(trip), c.quick_actions);
        setConv(c);
        setItems(fromHistory(c.messages));
        setStarting(false);
      },
      (e: unknown) => {
        if (opened.current) return;
        const code = e instanceof ApiError ? e.code : "UNKNOWN";
        if (code === "AI_QUOTA_EXCEEDED" && e instanceof ApiError) aiStore.exhausted(e.details);
        if (code === "FEATURE_UNAVAILABLE") aiStore.off();
        if (BLOCKING.has(code)) setBlocked(code);
        else if (code !== "AI_QUOTA_EXCEEDED") setStartErr(code);
        setStarting(false);
      },
    );
  }, [api, req]);
  useEffect(() => {
    start();
    return () => ac.current?.abort();
  }, [start]);

  /* ---------- the trip block takes what a tool priced; the chat says when «Поездка» could not take it */
  const applyTrip = useCallback(
    (aid: string, tool: AiToolName, args: AiToolArgs | undefined, tp: AiTripParams) => {
      if (req.mode !== "event") return;
      const note: TripNote = changeNote(tool, args, tp);
      const settled = tripBridge.apply(req.eventId, tp, note);
      if (!settled) return;
      haptic.notify("success");
      void settled.then((ok) => {
        if (!ok && alive.current) setApplyFailed((m) => ({ ...m, [aid]: true }));
      });
    },
    [req],
  );

  /**
   * M1: the saved turn after a broken stream / BFF's own error — by the turn_id of this turn only. A turn still running
   * is asked again with pauses (≈ 20 s). Without a turn_id: waits while the conversation has a running turn, then null.
   */
  const recover = useCallback(
    async (c: AiConversation, turnId: string | null, signal: AbortSignal): Promise<ChatAnswer | null> => {
      for (const wait of RECOVER_WAITS) {
        if (wait) await sleep(wait, signal);
        if (signal.aborted) return null;
        const saved = await api.ai.get(c.conversation_id, signal).catch(() => null);
        if (signal.aborted) return null;
        if (!saved) continue;
        aiStore.setQuota(saved.quota);
        if (Array.isArray(saved.quick_actions)) setConv((x) => (x ? { ...x, quick_actions: saved.quick_actions } : x));
        const answers = fromHistory(saved.messages).filter((x): x is ChatAnswer => x.kind === "answer");
        if (turnId) {
          // every turn has its assistant record from the start: running → wait; finished (also an error or an empty
          // completed turn) → shown at once; no record and nothing running → the turn was never saved
          const mine = answers.find((x) => x.turn_id === turnId);
          if (mine && mine.status !== "streaming") return mine;
          if (!mine && !answers.some((x) => x.status === "streaming")) return null;
        } else if (answers[answers.length - 1]?.status !== "streaming") return null; // waits for the last running turn
      }
      return null;
    },
    [api],
  );

  /* ---------- a turn: SSE first, JSON fallback; a broken stream → the saved answer of this turn (GET) */
  const run = useCallback(
    async (input: Input, retryOf?: string) => {
      if (!conv || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setSaid("");
      stick.current = true;
      const aid = `a${++seq.current}`;
      const tool = input.kind === "action" ? input.tool : null;
      // M2: «Повторить» sends the same request (the same client_msg_id: the server answers with the saved turn and
      // charges nothing twice) — unless the server finished that turn with a refusal (then it is a new turn)
      const prev = retryOf ? reqs.current.get(retryOf) : undefined;
      let body: AiMessageRequest | AiActionRequest;
      if (prev && !prev.fresh && !prev.lost) body = prev.body;
      else if (prev && prev.lost) {
        // the lost turn was never found on the server: the same client_msg_id, the trip as it is now on screen
        const trip = req.mode === "event" ? tripBridge.get(req.eventId) : null;
        const { trip_params: _old, ...rest } = prev.body;
        body = { ...rest, ...(trip ? { trip_params: trip } : {}) } as AiMessageRequest | AiActionRequest;
      } else {
        const trip = req.mode === "event" ? tripBridge.get(req.eventId) : null;
        const base = { client_msg_id: newIdempotencyKey(), ...(trip ? { trip_params: trip } : {}) };
        body = input.kind === "text" ? { ...base, text: input.text } : { ...base, args: input.args };
      }
      const sentTrip = body.trip_params ?? null;
      reqs.current.set(aid, { input, body, tool, fresh: false });
      if (retryOf) reqs.current.delete(retryOf);
      setItems((list) => {
        let next = retryOf ? list.filter((x) => x.id !== retryOf) : list;
        if (!retryOf) {
          const text = input.kind === "text" ? input.text : input.label;
          if (text) next = [...next, { kind: "user", id: `u${seq.current}`, text }];
        }
        return [...next, newAnswer(aid)];
      });
      const upd = (e: AiSseEvent) => setItems((list) => list.map((x) => (x.id === aid && x.kind === "answer" ? applyEvent(x, e) : x)));
      const fail = (code: string, retryable: boolean, wait?: number | null) =>
        upd({ event: "error", data: { turn_id: null, code, message: "", retryable, quota_refunded: true, ...(wait != null ? { retry_after: wait } : {}) } as AiError });
      const markFresh = () => {
        const r = reqs.current.get(aid);
        if (r) r.fresh = true;
      };
      const ctl = new AbortController();
      ac.current = ctl;
      const calls = new Map<string, AiToolArgs>();
      let turnId: string | null = null;
      let applied = false;
      let appliedTrip: AiTripParams | null = null;
      let endErr: AiError | null = null;
      const remember = (qa: AiQuickAction[] | undefined) => {
        if (qa) quickMemo.put(conv.conversation_id, tripKey(appliedTrip ?? sentTrip), qa);
      };
      const attempt = async (again: boolean): Promise<void> => {
        try {
          const out = await runTurn(
            (accept) => api.ai.turn(conv.conversation_id, body, tool, accept, ctl.signal),
            (e) => {
              if (!turnId && typeof e.data.turn_id === "string" && e.data.turn_id) turnId = e.data.turn_id;
              upd(e);
              if (e.event === "tool_call") calls.set(e.data.call_id, e.data.args ?? {});
              else if (e.event === "tool_result" && e.data.status === "ok" && e.data.changed && e.data.trip_params) {
                applied = true;
                appliedTrip = e.data.trip_params;
                applyTrip(aid, e.data.tool, calls.get(e.data.call_id) ?? (input.kind === "action" ? input.args : undefined), e.data.trip_params);
              } else if (e.event === "tool_result" && e.data.status === "no_change" && e.data.trip_params && req.mode === "event") {
                // 7.1: nothing found, but the condition stays for the next calculations — taken quietly (no plaque)
                tripBridge.sync(req.eventId, e.data.trip_params);
              } else if (e.event === "done") {
                aiStore.setQuota(e.data.quota);
                if (!applied && e.data.applied_change) {
                  applied = true;
                  appliedTrip = e.data.applied_change.trip_params;
                  applyTrip(aid, e.data.applied_change.tool, undefined, e.data.applied_change.trip_params);
                }
                // the quick actions for the trip after this turn (no field — the previous set)
                const qa = e.data.quick_actions;
                if (qa) setConv((c) => (c ? { ...c, quick_actions: qa } : c));
                remember(qa);
              } else if (e.event === "error") {
                endErr = e.data;
                if (e.data.code === "AI_QUOTA_EXCEEDED") aiStore.exhausted({});
                if (BLOCKING.has(e.data.code)) setBlocked(e.data.code);
              }
            },
          );
          if (ctl.signal.aborted) return;
          const err = endErr as AiError | null;
          // BFF's own error (the stream broke / timed out upstream) leaves the quota as is: the turn may be saved
          const suspect = !!err && !err.quota_refunded && (err.code === "AI_PROVIDER_UNAVAILABLE" || err.code === "AI_TIMEOUT");
          if (!out.terminal || suspect) {
            const mine = await recover(conv, turnId, ctl.signal);
            if (ctl.signal.aborted) return;
            if (mine) {
              setItems((list) => list.map((x) => (x.id === aid ? { ...mine, id: aid, error: mine.status === "failed" ? (mine.error ?? { code: err?.code ?? "AI_PROVIDER_UNAVAILABLE", retryable: true }) : null } : x)));
              if (mine.status === "failed") markFresh();
              if (!applied && mine.applied) {
                applied = true;
                appliedTrip = mine.applied.trip_params;
                applyTrip(aid, mine.applied.tool, undefined, mine.applied.trip_params);
              }
            } else if (!out.terminal) {
              fail("TURN_LOST", true);
              const r = reqs.current.get(aid);
              if (r) r.lost = true;
            }
          } else if (err?.quota_refunded) markFresh();
          haptic.notify(endErr || !out.terminal ? "warning" : "success");
        } catch (e) {
          if (ctl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
          // refused before the stream (JSON ErrorBody): nothing was saved under this client_msg_id but a turn in progress
          const code = e instanceof ApiError ? e.code : "UNKNOWN";
          if (code === "AI_TURN_IN_PROGRESS" && !again) {
            // another turn of this conversation (or this very one) is still running: wait for it, then ask once more
            await recover(conv, null, ctl.signal);
            if (ctl.signal.aborted) return;
            return attempt(true);
          }
          if (code === "AI_QUOTA_EXCEEDED" && e instanceof ApiError) aiStore.exhausted(e.details);
          if (code === "FEATURE_UNAVAILABLE") aiStore.off();
          if (BLOCKING.has(code)) setBlocked(code);
          // sprint 9: a 429 — «повторите через N с», «Отправить» waits that long (no automatic repeat)
          if (code === "RATE_LIMITED") rateLimits.note(e, AI_POLICY);
          fail(code, RETRYABLE.has(code), rateLimitWait(e));
          haptic.notify("error");
        }
      };
      try {
        await attempt(false);
      } finally {
        if (ac.current === ctl) ac.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    },
    [api, applyTrip, conv, recover, req],
  );

  // «Попросить AI найти похожее» (empty catalogue): the search runs at once with the user's query
  useEffect(() => {
    if (!conv || autoSent.current || req.mode !== "home" || !req.query || items.length || stop) return;
    autoSent.current = true;
    const qa = conv.quick_actions.find((q) => q.tool === "find_similar_event" && q.args.reason === "query");
    const label = t("ai.q.query", { q: req.query.slice(0, 60) });
    if (qa) void run({ kind: "action", tool: qa.tool, args: qa.args, label });
    else if (req.query.trim().length >= 2) void run({ kind: "text", text: req.query.slice(0, MAX_INPUT) });
  }, [conv, items.length, req, run, stop, t]);

  /* ---------- the list follows new text while the user is at the bottom */
  useLayoutEffect(() => {
    const b = endRef.current?.closest<HTMLElement>(".sheet-b");
    if (b && stick.current) b.scrollTop = b.scrollHeight;
  }, [items, busy, starting]);
  useEffect(() => {
    const b = endRef.current?.closest<HTMLElement>(".sheet-b");
    if (!b) return;
    const on = () => {
      stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 60;
    };
    b.addEventListener("scroll", on, { passive: true });
    return () => b.removeEventListener("scroll", on);
  }, []);

  const send = () => {
    const text = draft.trim().slice(0, MAX_INPUT);
    if (!text || busy || stop || !conv || limited) return;
    setDraft("");
    haptic.selection();
    void run({ kind: "text", text });
  };
  const quick = (q: AiQuickAction) => {
    if (busy || stop || limited) return;
    haptic.selection();
    void run({ kind: "action", tool: q.tool, args: q.args, label: quickLabel(q) });
  };
  const openEvent = (id: string) => {
    haptic.selection();
    aiStore.close();
    navigate({ type: "push", route: { name: "event", id } });
  };

  /* ---------- texts */
  const tk = (key: string, vars?: Vars, fallback?: MessageKey): string => (has(key) ? t(key, vars) : fallback ? t(fallback, vars) : "");
  const tierName = (v: unknown) => tierOf(t, v);
  const quickLabel = (q: AiQuickAction): string => quickActionLabel(t, q);
  const greeting = (g: AiGreeting | undefined): string =>
    greetingText(t, g, (amount, currency) => (currency === "USD" ? fmt.usdDecimal(amount) : formatMoney(amount, currency, lang)));
  const errLine = (code: string, _wait?: number): string => {
    // the bubble stays in the history: no frozen «через N с» there — the live countdown is the line above the input
    if (code === "RATE_LIMITED") return t("err.RATE_LIMITED");
    if (code === "RATE_LIMIT_UNAVAILABLE") return t("err.RATE_LIMIT_UNAVAILABLE");
    const reset = quota?.resets_at ? fmt.time(quota.resets_at) : "";
    let key = aiErrorKey(code);
    if ((code === "AI_QUOTA_EXCEEDED" || code === "AI_BUDGET_EXHAUSTED") && reset) key += ".at";
    // on the detail the trip block is right there; on Home — the event pages
    if (req.mode === "home" && has(`${key}.home`)) key += ".home";
    return tk(key, { time: reset }, "ai.err.AI_PROVIDER_UNAVAILABLE");
  };
  const noteText = (n: TripNote) => aiNote(t, n);

  // the set for the trip on screen: after «Отменить» in «Поездка» the earlier trip gets its earlier set back
  const tripNow = req.mode === "event" ? tripBridge.get(req.eventId) : null;
  const quickList = conv ? liveQuickActions((tripNow && quickMemo.get(conv.conversation_id, tripKey(tripNow))) || conv.quick_actions, tripNow) : [];
  /** a quick action of the saved history (no text): its label key without parameters, else the tool's label */
  const userText = (u: ChatUser): string => {
    if (u.text.trim()) return u.text;
    if (u.label?.action && has(u.label.action.label_key)) return quickLabel(u.label.action);
    const k = u.label?.key;
    if (k && has(k) && !DICTS.ru[k].includes("{")) return t(k);
    const byTool = u.label?.tool ? `ai.q.tool.${u.label.tool}` : "";
    return byTool && has(byTool) ? t(byTool) : "";
  };
  // the concierge refused before any conversation (switched off, no budget, limit): the reason fills the sheet
  const startBlocked = !conv && !starting && !!stop;
  const stopTitle = t(stop === "AI_QUOTA_EXCEEDED" ? "ai.stop.limit" : stop === "AI_CONCIERGE_PAUSED" ? "ai.stop.paused" : "ai.stop.off");
  const stopIcon = stop === "AI_QUOTA_EXCEEDED" ? "clock" : stop === "AI_CONCIERGE_PAUSED" ? "pause" : "power";
  const chips = conv ? contextChips(conv.context.chips ?? [], conv.context, conv.mode, !!req.query) : [];
  // a11y: the finished answer is read out (its text, or what went wrong) — not the tokens as they stream
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    const a = [...items].reverse().find((x): x is ChatAnswer => x.kind === "answer");
    if (!a) return;
    const text = a.segments.map((x) => x.text.trim()).filter(Boolean).join(" ");
    setSaid((text || (a.error ? errLine(a.error.code) : t("ai.sr.done"))).slice(0, MAX_SAID));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  // fix 7.2: the screen-reader copy leaves the DOM once announced — a copy of the chat never has the answer twice
  useEffect(() => {
    if (!said) return;
    const id = setTimeout(() => setSaid(""), SAID_MS);
    return () => clearTimeout(id);
  }, [said]);
  // a11y: the stop (limit, switch, budget) takes the focus when it appears
  const hadStop = useRef(false);
  useEffect(() => {
    if (stop && !hadStop.current) stopRef.current?.focus({ preventScroll: true });
    hadStop.current = !!stop;
  }, [stop]);
  const typing = busy && (() => {
    const a = items[items.length - 1];
    return a?.kind === "answer" && a.status === "streaming" && !a.segments.length && !a.tools.some((x) => x.status === "run");
  })();

  const foot = (
    <div className="ai-foot">
      {startBlocked ? null : stop ? (
        <div className={`ai-stop ${stop === "AI_QUOTA_EXCEEDED" ? "limit" : ""}`} role="status" data-testid="ai-stop" data-code={stop} tabIndex={-1} ref={stopRef}>
          <Icon name={stopIcon} size={18} />
          <div>
            <b>{stopTitle}</b>
            <span>{errLine(stop)}</span>
          </div>
        </div>
      ) : (
        <>
          {quickList.length > 0 && (
            <QuickRow label={t("ai.qa.h")} more={t("ai.qa.more")}>
              {quickList.slice(0, 8).map((q) => (
                <button key={q.id} type="button" data-id={q.id} disabled={busy || limited} onClick={() => quick(q)}>
                  {quickLabel(q)}
                </button>
              ))}
            </QuickRow>
          )}
          {limited && (
            <p className="ai-rl" role="status" data-testid="ai-rate-limit">
              <Icon name="clock" size={14} />
              <TickingText ticking text={t("err.RATE_LIMITED.wait", { n: rl.left })} />
            </p>
          )}
          <div className="ai-cmp">
            <div className="field">
              <textarea
                rows={1}
                maxLength={MAX_INPUT}
                placeholder={t(req.mode === "home" ? "ai.ph.home" : "ai.ph")}
                aria-label={t(req.mode === "home" ? "ai.ph.home" : "ai.ph")}
                value={draft}
                disabled={!conv}
                data-testid="ai-input"
                onChange={(e) => {
                  setDraft(e.target.value.slice(0, MAX_INPUT));
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(110, e.target.scrollHeight)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
            </div>
            <button className="send-btn" type="button" aria-label={t("ai.send")} data-testid="ai-send" disabled={!draft.trim() || busy || !conv || limited} onClick={send}>
              {busy ? <Spinner small /> : <Icon name="up" size={20} />}
            </button>
          </div>
          {draft.length > MAX_INPUT - 100 && (
            <p className="ai-count" aria-live="polite">
              {t("ai.count", { n: draft.length, max: MAX_INPUT })}
            </p>
          )}
        </>
      )}
      <p className="ai-note" data-testid="ai-quota">
        {left && !stop ? (
          <>
            <b>{t("ai.quota", { n: left.left, max: left.limit })}</b>
            {quota?.resets_at && fmt.time(quota.resets_at) ? ` · ${t("ai.quota.reset", { time: fmt.time(quota.resets_at) })}` : ""}
            {" · "}
          </>
        ) : null}
        {t("ai.foot")}
      </p>
    </div>
  );

  return (
    <Sheet
      title={t("ai.title")}
      sub={req.title ?? t(req.query ? "ai.sub.query" : "ai.sub.home")}
      onClose={close}
      full
      className="ai"
      lead={
        <span className="ai-av" aria-hidden="true">
          <Icon name="spark" size={20} />
        </span>
      }
      foot={foot}
    >
      {chips.length > 0 && (
        <ul className="ai-ctx" aria-label={t("ai.sees")} data-testid="ai-ctx">
          <li className="k" aria-hidden="true">
            {t("ai.sees")}
          </li>
          {chips.map((c) => (
            <li key={c.key}>
              <Icon name="check" size={12} />
              {c.key === "ai.ctx.src" ? `${c.plural ?? 0} ${tp("ai.ctx.src", c.plural ?? 0)}` : c.key === "ai.ctx.pkg" ? t("ai.ctx.pkg", { t: tierName(c.vars?.t) }) : tk(c.key)}
            </li>
          ))}
        </ul>
      )}
      <div className="ai-msgs" aria-busy={busy || starting} data-testid="ai-msgs">
        {starting && (
          <div className="msg a ai-wait" data-testid="ai-starting">
            <Spinner small />
            <span>{t("ai.starting")}</span>
          </div>
        )}
        {startBlocked && (
          <div className="ai-blocked" role="status" data-testid="ai-stop" data-code={stop} tabIndex={-1} ref={stopRef}>
            <span className={`ai-blocked-ic ${stop === "AI_QUOTA_EXCEEDED" ? "limit" : ""}`} aria-hidden="true">
              <Icon name={stopIcon} size={28} />
            </span>
            <h3>{stopTitle}</h3>
            <p>{errLine(stop!)}</p>
            <button className="btn btn-soft" type="button" onClick={close}>
              {t(req.mode === "event" ? "ai.back.event" : "a11y.close")}
            </button>
          </div>
        )}
        {startErr && (
          <div className="msg a err" role="alert" data-testid="ai-start-error">
            <span className="who">{t("ai.who")}</span>
            <p>{errLine(startErr)}</p>
            <div className="act">
              <button className="btn btn-xs btn-soft" type="button" onClick={start}>
                <Icon name="refresh" size={14} />
                {t("common.retry")}
              </button>
            </div>
          </div>
        )}
        {conv && (
          <div className="msg a" data-testid="ai-greeting">
            <span className="who">{t("ai.who")}</span>
            <p>{greeting(conv.greeting)}</p>
          </div>
        )}
        {items.map((x) =>
          x.kind === "user" ? (
            userText(x) ? (
              <div key={x.id} className="msg u" data-testid="ai-user">
                {userText(x)}
              </div>
            ) : null
          ) : (
            <Answer
              key={x.id}
              a={x}
              errLine={errLine}
              noteText={noteText}
              busy={busy}
              applyFailed={!!applyFailed[x.id]}
              stopped={!!stop}
              limited={limited}
              onRetry={() => {
                const r = reqs.current.get(x.id);
                if (r) void run(r.input, x.id);
              }}
              onAction={(act) => {
                if (act.type === "retry") void run({ kind: "action", tool: act.tool, args: act.args, label: t("common.retry") });
                else if (act.type === "open_event") openEvent(act.event_id);
              }}
              onOpenEvent={openEvent}
              canRetry={reqs.current.has(x.id) && !stop}
            />
          ),
        )}
        {typing && (
          <div className="typing" role="img" aria-label={t("ai.typing")} data-testid="ai-typing">
            <i />
            <i />
            <i />
          </div>
        )}
        <div ref={endRef} />
      </div>
      <p className="sr" aria-live="polite">
        {said}
      </p>
    </Sheet>
  );
}

/**
 * The quick actions row scrolls sideways: while more of it is hidden on the right, the edge fades and a chevron
 * shows there is more (a tap on it scrolls on) — on 360–412 px three or four chips fit, the rest are off screen.
 */
function QuickRow({ label, more, children }: { label: string; more: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hasMore, setHasMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => setHasMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 8);
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro?.disconnect();
    };
  }, [children]);
  return (
    <div className={hasMore ? "ai-qa-w more" : "ai-qa-w"}>
      <div className="ai-qa" role="group" aria-label={label} data-testid="ai-quick" ref={ref}>
        {children}
      </div>
      {hasMore && (
        <button className="ai-qa-more" type="button" tabIndex={-1} aria-hidden="true" title={more} data-testid="ai-quick-more" onClick={() => ref.current?.scrollBy({ left: 160, behavior: "smooth" })}>
          <Icon name="chevR" size={16} />
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- one answer */

const KIND_CLS: Record<string, string> = { fact: "k-fact", estimate: "k-est", recommendation: "k-rec" };

function Answer(props: {
  a: ChatAnswer;
  busy: boolean;
  canRetry: boolean;
  /** «Поездка» could not price what the tool returned (its recalculation failed, the block rolled back) */
  applyFailed: boolean;
  /** the limit / the switch: no new turns from this answer either */
  stopped: boolean;
  /** sprint 9: a 429 is still in force — «Повторить» waits */
  limited: boolean;
  errLine: (code: string, wait?: number) => string;
  noteText: (n: { key: string; vars: Vars }) => string;
  onRetry: () => void;
  onAction: (a: AiDoneAction) => void;
  onOpenEvent: (id: string) => void;
}) {
  const { t } = useI18n();
  const { a } = props;
  const watch = a.actions.find((x): x is Extract<AiDoneAction, { type: "watch_price" }> => x.type === "watch_price");
  const others = a.actions.filter((x) => x.type !== "watch_price" && !(x.type === "retry" && props.stopped));
  const events = a.tools.flatMap((x) => x.events ?? []).slice(0, 3);
  const text = a.segments.some((s) => s.text.trim());
  const err = a.status === "failed" && a.error;
  return (
    <>
      {a.tools.map((x) => (
        <ToolCard key={x.call_id} x={x} />
      ))}
      {(text || err || a.status === "partial" || others.length > 0 || watch || events.length > 0 || a.quotaNote) && (
        <div className={err ? "msg a err" : "msg a"} data-testid="ai-answer" data-status={a.status} role={err ? "alert" : undefined}>
          <span className="who">{t("ai.who")}</span>
          {a.segments
            .filter((s) => s.text.trim())
            .map((s, i) => (
              <Segment key={i} s={s} />
            ))}
          {err && <p data-testid="ai-error" data-code={err.code}>{props.errLine(err.code, err.wait)}</p>}
          {a.status === "partial" && !text && <p>{t("ai.partial")}</p>}
          {a.applied &&
            (props.applyFailed ? (
              <p className="ai-applied fail" data-testid="ai-applied" data-ok="false">
                <Icon name="alert" size={14} />
                {t("ai.applyFailed", { w: props.noteText(changeNote(a.applied.tool, undefined, a.applied.trip_params)) })}
              </p>
            ) : (
              <p className="ai-applied" data-testid="ai-applied" data-ok="true">
                <Icon name="check" size={14} />
                {t("ai.applied", { w: props.noteText(changeNote(a.applied.tool, undefined, a.applied.trip_params)) })}
              </p>
            ))}
          {a.quotaNote && (
            // sprint 8 (rule NC): the turn changed nothing — today's quota was not spent on it
            <p className="ai-quota-note" data-testid="ai-quota-note">
              <Icon name="info" size={13} />
              {t(a.quotaNote)}
            </p>
          )}
          {events.length > 0 && <EventRefs list={events} onOpen={props.onOpenEvent} />}
          {(others.length > 0 || watch || (err && err.retryable && props.canRetry)) && (
            <div className="act">
              {err && err.retryable && props.canRetry && (
                <button className="btn btn-xs btn-soft" type="button" disabled={props.busy || props.limited} onClick={props.onRetry} data-testid="ai-retry">
                  <Icon name="refresh" size={14} />
                  {t("common.retry")}
                </button>
              )}
              {others.map((x, i) =>
                x.type === "retry" ? (
                  <button key={i} className="btn btn-xs btn-soft" type="button" disabled={props.busy || props.limited} onClick={() => props.onAction(x)} data-testid="ai-act-retry">
                    <Icon name="refresh" size={14} />
                    {t("common.retry")}
                  </button>
                ) : x.type === "flight_search" && flightSearchUrl(x) ? (
                  // 7.1: the route Aviasales cannot price for us — the user checks flights on its site
                  <button key={i} className="btn btn-xs btn-soft" type="button" onClick={() => openExternal(flightSearchUrl(x)!)} data-testid="ai-act-flights">
                    <Icon name="plane" size={14} />
                    {t("ai.act.flights")}
                    <Icon name="ext" size={12} />
                  </button>
                ) : x.type === "open_event" ? (
                  <button key={i} className="btn btn-xs btn-soft" type="button" onClick={() => props.onAction(x)} data-testid="ai-act-open">
                    <Icon name="chevR" size={14} />
                    {t("ai.act.open")}
                  </button>
                ) : null,
              )}
              {watch && <WatchPrice eventId={watch.event_id} />}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function WatchPrice({ eventId }: { eventId: string }) {
  const { t } = useI18n();
  const ref = useWatchRef(eventId, null);
  const wa = useWatchAction();
  if (ref)
    return (
      <span className="ai-watching" data-testid="ai-act-watching">
        <Icon name="radar" size={14} />
        {t("ai.act.watching")}
      </span>
    );
  return (
    <button className="btn btn-xs btn-soft" type="button" disabled={wa.busy === eventId} onClick={() => void wa.act(eventId, null)} data-testid="ai-act-watch">
      {wa.busy === eventId ? <Spinner small /> : <Icon name="radar" size={14} />}
      {t("ai.act.watch")}
    </button>
  );
}

function ToolCard({ x }: { x: ChatTool }) {
  const { t } = useI18n();
  const l = toolLine(x);
  return (
    <div className={`ai-tool ${l.tone}`} data-testid="ai-tool" data-tool={x.tool} data-status={x.status}>
      <span className="ai-tool-ic" aria-hidden="true">
        {l.tone === "run" ? <Spinner small /> : <Icon name={l.tone === "fail" ? "x" : l.tone === "idle" ? "minus" : "check"} size={14} />}
      </span>
      <span>{t(l.key as MessageKey, l.vars)}</span>
    </div>
  );
}

function Segment({ s }: { s: AiSegment }) {
  const { t } = useI18n();
  const seen = new Set<string>();
  const sources = s.sources.filter((x: AiSource) => {
    const k = x.url ?? x.domain;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return (
    <div className="ai-seg" data-kind={s.kind}>
      <p>
        {s.text.trim()}{" "}
        <span className={`kind ${KIND_CLS[s.kind] ?? "k-rec"}`} data-testid="ai-kind">
          {t(`ai.kind.${s.kind}` as MessageKey)}
        </span>
      </p>
      {sources.length > 0 && (
        <div className="ai-src">
          {sources.slice(0, 4).map((x) =>
            x.url ? (
              <button key={x.ref + x.url} className="srcl" type="button" onClick={() => openExternal(x.url!)} data-testid="ai-source">
                {t("ai.src", { d: x.domain || x.title })}
                <Icon name="ext" size={12} />
              </button>
            ) : (
              <span key={x.ref + x.domain} className="srcl plain">
                {t("ai.src", { d: x.domain || x.title })}
              </span>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function EventRefs({ list, onOpen }: { list: TilHeroRef[]; onOpen: (id: string) => void }) {
  const { t, fmt, lang } = useI18n();
  return (
    <ul className="ai-evs" data-testid="ai-events">
      {list.map((e) => {
        const price = e.ticket_from ? (e.ticket_from.currency === "USD" ? fmt.usdDecimal(e.ticket_from.amount) : formatMoney(e.ticket_from.amount, e.ticket_from.currency, lang)) : "";
        const meta = [e.start_date ? fmt.date(`${e.start_date}T12:00:00Z`) : "", e.city ?? ""].filter(Boolean).join(" · ");
        return (
          <li key={e.event_id}>
            <button type="button" onClick={() => onOpen(e.event_id)} data-testid="ai-event">
              <span className="grow">
                <b>{e.title}</b>
                <small>
                  {meta}
                  {price ? ` · ${t("ai.ev.from", { p: price })}` : ""}
                </small>
              </span>
              <Icon name="chevR" size={16} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
