import type { PairRole, PairRoomEvent, PairRoomState, PairRoomStatus, PairRoomView } from "@tilhero/contracts/bff";
import { ApiError } from "../api/errors";

/**
 * Sprint 7 — the pair lesson (APP-SOC-03…06): two learners and the AI coach in one room. The room lives on the server; the
 * client keeps a long-poll of the feed (GET …/state?after_seq=N, ≤ 25 s, the next request right after the answer), a
 * heartbeat every 10 s (without it 30 s → offline, in one's own turn → paused) and stops both when the screen goes away
 * (the poll in flight is aborted). A lost poll is retried with a growing pause; the room itself is never re-created —
 * returning in 3 minutes continues the same room (POST …/join), without a second session.
 */

export const HEARTBEAT_MS = 10_000;
/** pauses between failed polls: 1, 2, 4, 8 s, then 8 s */
export const POLL_RETRY_MS: readonly number[] = [1000, 2000, 4000, 8000];
export const TURN_TEXT_MAX = 300;

const TERMINAL: ReadonlySet<PairRoomStatus> = new Set(["declined", "expired", "cancelled", "finished", "abandoned", "stopped"]);
const ACTIVE: ReadonlySet<PairRoomStatus> = new Set(["invited", "waiting", "in_progress", "paused"]);

export function isTerminal(s: PairRoomStatus): boolean {
  return TERMINAL.has(s);
}
export function isActive(s: PairRoomStatus): boolean {
  return ACTIVE.has(s);
}
/** The room itself (not the invitation): the feed is polled. */
export function isLive(s: PairRoomStatus): boolean {
  return s === "waiting" || s === "in_progress" || s === "paused";
}

/** Events of the feed by seq: no duplicates (a repeated poll, a command answer), in order, the last 200. */
export function mergeEvents(prev: readonly PairRoomEvent[], next: readonly PairRoomEvent[]): PairRoomEvent[] {
  if (!next.length) return prev as PairRoomEvent[];
  const by = new Map<number, PairRoomEvent>();
  for (const e of prev) by.set(e.seq, e);
  for (const e of next) by.set(e.seq, e);
  return [...by.values()].sort((a, b) => a.seq - b.seq).slice(-200);
}

export type Speaker = "me" | "partner" | "both" | "nobody";

export interface TurnInfo {
  /** I may answer now */
  mine: boolean;
  who: Speaker;
}

/** Whose turn it is from my side (next_speaker: A | B | both | null — the coach is thinking or the room waits). */
export function turnInfo(s: Pick<PairRoomState, "status" | "next_speaker" | "my_role">): TurnInfo {
  if (s.status !== "in_progress" || !s.next_speaker || !s.my_role) return { mine: false, who: "nobody" };
  if (s.next_speaker === "both") return { mine: true, who: "both" };
  return s.next_speaker === s.my_role ? { mine: true, who: "me" } : { mine: false, who: "partner" };
}

/**
 * Which turn I answer: the seq of the last line of the feed (anyone's turn, the coach, the roles, the switch to choices).
 * A new turn of mine always follows such a line; presence events (online, offline, paused) do not move it. The
 * Idempotency-Key of a turn is bound to it: the server offers c1..c3 on every turn, so the same choice on the next turn
 * must go with a new key (else the server answers the old turn again and the new one is lost).
 */
const LINES: ReadonlySet<PairRoomEvent["kind"]> = new Set(["turn", "coach", "roles", "mode_changed"]);

export function turnMark(events: readonly Pick<PairRoomEvent, "seq" | "kind">[]): number {
  for (let i = events.length - 1; i >= 0; i--) if (LINES.has(events[i]!.kind)) return events[i]!.seq;
  return 0;
}

export type InputMode = "choices" | "free" | "wait";

/**
 * How I answer: choices (a child, the scenario without the AI, the coach offered options), free text (14+, the AI room),
 * or wait (not my turn). A child never types: without options a child waits for the next prompt.
 */
export function inputMode(s: Pick<PairRoomState, "status" | "next_speaker" | "my_role" | "mode" | "ai_degraded" | "options">, kid: boolean): InputMode {
  if (!turnInfo(s).mine) return "wait";
  const hasOptions = !!s.options && s.options.length > 0;
  if (kid || s.mode === "choices" || s.ai_degraded) return hasOptions ? "choices" : "wait";
  return hasOptions ? "choices" : "free";
}

/** The voice in the room: 14+ only, with the consent to record the voice and recognition available, when typing. */
export function canUseVoice(s: Pick<PairRoomState, "voice_available" | "status" | "next_speaker" | "my_role" | "mode" | "ai_degraded" | "options">, kid: boolean): boolean {
  return !kid && s.voice_available && inputMode(s, kid) === "free";
}

/** The partner's network: online / offline (null — not in the room yet). */
export function partnerNetwork(s: Pick<PairRoomState, "participants">): "online" | "offline" | null {
  const p = s.participants.find((x) => !x.me && x.role !== null);
  return p ? p.network : null;
}

export type LineWho = "me" | "partner" | "coach" | "system";

/** One line of the feed: my lines, the partner's lines (only inside this room), the coach, the system notes. */
export function lineOf(e: Pick<PairRoomEvent, "kind" | "role">, myRole: PairRole | null): LineWho {
  if (e.kind === "turn") return e.role && myRole && e.role === myRole ? "me" : "partner";
  if (e.kind === "coach") return "coach";
  return "system";
}

/**
 * What the room view allows from my side (the server decides by can_join):
 *  - incoming / outgoing — the invitation (answer it, or wait for the answer and cancel);
 *  - scheduled — accepted, the start is more than 5 minutes away: the time and «Отменить», no entry yet;
 *  - enter — the room can be entered (waiting, ≤ 5 minutes to the start);
 *  - room — the lesson goes on and I may (re)join: the room itself;
 *  - away — the lesson goes on without me (I was away more than 3 minutes: abandoned) — the report comes at the end;
 *  - ended — finished, cancelled, declined, expired, stopped.
 */
export type LobbyPhase = "incoming" | "outgoing" | "scheduled" | "enter" | "room" | "away" | "ended";

export function lobbyPhase(v: Pick<PairRoomView, "status" | "side" | "can_accept" | "can_join">): LobbyPhase {
  if (isTerminal(v.status)) return "ended";
  if (v.status === "invited") return v.side === "invitee" ? (v.can_accept ? "incoming" : "ended") : "outgoing";
  if (v.status === "waiting") return v.can_join ? "enter" : "scheduled";
  return v.can_join ? "room" : "away";
}

/** 409 ROOM_NOT_ACTIVE (the room ended for me: abandoned, too early, closed) or 404 ROOM_NOT_FOUND. */
export function roomGone(e: unknown): boolean {
  return e instanceof ApiError && (e.code === "ROOM_NOT_ACTIVE" || e.code === "ROOM_NOT_FOUND" || e.status === 404);
}

/** Why the room is closed for me, from 409 ROOM_NOT_ACTIVE {status, start_at?}. */
export type ClosedWhy = { kind: "away" } | { kind: "early"; startAt: string } | { kind: "closed" };

export function closedWhy(e: unknown): ClosedWhy {
  if (e instanceof ApiError && e.code === "ROOM_NOT_ACTIVE") {
    if (e.details.status === "abandoned") return { kind: "away" };
    if (e.details.status === "waiting" && typeof e.details.start_at === "string") return { kind: "early", startAt: e.details.start_at };
  }
  return { kind: "closed" };
}

/** start of a scheduled lesson: "now" or a local time (datetime-local) → ISO within 7 days; null — out of range. */
export function startValue(choice: "now" | "later", local: string, now: number = Date.now()): string | null {
  if (choice === "now") return "now";
  const d = new Date(local);
  const at = d.getTime();
  if (!local || Number.isNaN(at)) return null;
  if (at <= now + 60_000 || at > now + 7 * 24 * 3600_000) return null;
  return d.toISOString();
}

/* ---------------------------------------------------------------- the link: long-poll + heartbeat */

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

export interface RoomLinkDeps {
  /** GET …/state?after_seq=N (long-poll ≤ 25 s), aborted by the signal */
  poll(afterSeq: number, signal: AbortSignal): Promise<PairRoomState>;
  /** POST …/heartbeat */
  heartbeat(): Promise<void>;
  /** a fresh state (never older than the last one) */
  onState(s: PairRoomState): void;
  /** the link works (an answer came) or not (a poll / heartbeat failed — «Переподключаемся…») */
  onLink(ok: boolean): void;
  /** the room ended (a terminal status), is gone (404 ROOM_NOT_FOUND) or is not active for me any more (409
   *  ROOM_NOT_ACTIVE on the heartbeat: abandoned); the link is already stopped */
  onEnd(s: PairRoomState | null, e?: unknown): void;
  timers?: Timers;
  heartbeatMs?: number;
  retryMs?: readonly number[];
}

const isAbort = (e: unknown) => (e instanceof DOMException || e instanceof Error) && (e as Error).name === "AbortError";

/**
 * The long-poll loop of one room: one request at a time, after_seq = the last seq seen; stop() aborts the request in
 * flight, clears the heartbeat and the pause of a retry (the screen left — no request goes on in the background).
 */
export class RoomLink {
  private seq = 0;
  private alive = false;
  private ctrl: AbortController | null = null;
  private hb: unknown = null;
  private wait: { id: unknown; done: () => void } | null = null;
  private readonly timers: Timers;
  /** polls sent (tests, diagnostics) */
  polls = 0;

  constructor(private readonly deps: RoomLinkDeps) {
    this.timers = deps.timers ?? realTimers;
  }

  get running(): boolean {
    return this.alive;
  }

  get lastSeq(): number {
    return this.seq;
  }

  start(afterSeq = 0): void {
    if (this.alive) return;
    this.alive = true;
    this.seq = Math.max(this.seq, afterSeq);
    this.hb = this.timers.setInterval(() => this.beat(), this.deps.heartbeatMs ?? HEARTBEAT_MS);
    void this.loop();
  }

  stop(): void {
    if (!this.alive) return;
    this.alive = false;
    this.ctrl?.abort();
    this.ctrl = null;
    if (this.hb !== null) this.timers.clearInterval(this.hb);
    this.hb = null;
    if (this.wait) {
      this.timers.clearTimeout(this.wait.id);
      this.wait.done();
      this.wait = null;
    }
  }

  /** A state from a command (join, a turn): shown at once; the poll goes on after its seq (no repeated events). */
  push(s: PairRoomState): void {
    if (s.seq < this.seq) return;
    this.seq = s.seq;
    this.deps.onState(s);
    if (isTerminal(s.status)) this.end(s);
  }

  private end(s: PairRoomState | null, e?: unknown): void {
    this.stop();
    this.deps.onEnd(s, e);
  }

  private beat(): void {
    if (!this.alive) return;
    this.deps.heartbeat().then(
      () => this.alive && this.deps.onLink(true),
      (e: unknown) => {
        if (!this.alive) return;
        // the room is over for me (abandoned, closed) or gone: the feed may still answer, the link ends here
        if (roomGone(e)) this.end(null, e);
        else this.deps.onLink(false);
      },
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => resolve();
      const id = this.timers.setTimeout(() => {
        this.wait = null;
        done();
      }, ms);
      this.wait = { id, done };
    });
  }

  private async loop(): Promise<void> {
    let fails = 0;
    const retry = this.deps.retryMs ?? POLL_RETRY_MS;
    while (this.alive) {
      const ctrl = new AbortController();
      this.ctrl = ctrl;
      this.polls += 1;
      try {
        const s = await this.deps.poll(this.seq, ctrl.signal);
        if (!this.alive || ctrl.signal.aborted) return;
        fails = 0;
        this.deps.onLink(true);
        if (s.seq >= this.seq) {
          this.seq = s.seq;
          this.deps.onState(s);
        }
        if (isTerminal(s.status)) {
          this.end(s);
          return;
        }
      } catch (e) {
        if (!this.alive || isAbort(e)) return;
        if (roomGone(e)) {
          this.end(null, e);
          return;
        }
        fails += 1;
        this.deps.onLink(false);
        const ra = e instanceof ApiError ? e.retryAfter : null;
        await this.sleep(ra != null ? ra * 1000 : retry[Math.min(fails - 1, retry.length - 1)] ?? 8000);
      }
    }
  }
}
