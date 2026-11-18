/**
 * Last user interaction and last admin-bff answer. The admin-bff session (cookie) is shared by every tab of the
 * browser, so the idle policy must be shared too: an idle tab must not sign out (POST /auth/logout) a session the
 * operator is actively using in another tab. Tabs exchange ONLY the timestamp of the last interaction over a
 * BroadcastChannel — no user data, no ids, nothing from the session.
 */
const CHANNEL = "tilhero.admin.activity";
/** throttle of outgoing «I am active» messages */
const SEND_EVERY_MS = 1000;
/** a peer's timestamp further in the future than this is ignored (clock skew between tabs is zero; junk guard) */
const FUTURE_SKEW_MS = 5000;

type Msg = { t: number } | { ask: true };

let channel: BroadcastChannel | null = null;
let lastSent = 0;
let refs = 0;

function post(msg: Msg): void {
  try {
    channel?.postMessage(msg);
  } catch {
    /* channel closed — the tab works on its own clock */
  }
}

function accept(raw: unknown, now = Date.now()): void {
  const t = (raw as { t?: unknown } | null)?.t;
  if (typeof t === "number" && Number.isFinite(t) && t <= now + FUTURE_SKEW_MS && t > activity.user) activity.user = t;
}

export const activity = {
  user: Date.now(),
  server: Date.now(),
  /** a local interaction (pointer, key, wheel, touch, «stay signed in») — shared with the other tabs */
  touch(now = Date.now()) {
    if (now > this.user) this.user = now;
    if (now - lastSent >= SEND_EVERY_MS) {
      lastSent = now;
      post({ t: now });
    }
  },
  serverTouch(now = Date.now()) {
    this.server = now;
  },
};

/** Joins the cross-tab activity channel; returns the leave function (ref-counted for StrictMode double mounts). */
export function shareActivity(): () => void {
  refs += 1;
  if (!channel && typeof BroadcastChannel === "function") {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e: MessageEvent<Msg>) => {
      const d = e.data as Partial<{ t: number; ask: true }> | null;
      if (d && d.ask === true) post({ t: activity.user }); // a peer is about to sign out by idle: tell it our time
      else accept(d);
    };
  }
  return () => {
    refs -= 1;
    if (refs <= 0 && channel) {
      channel.close();
      channel = null;
      refs = 0;
    }
  };
}

/**
 * Last check before an idle sign-out: asks the other tabs for their last interaction and waits briefly — a tab that
 * was throttled in the background might have missed the peers' messages. Resolves to the shared last-activity time.
 */
export async function confirmIdle(waitMs = 400): Promise<number> {
  if (!channel) return activity.user;
  post({ ask: true });
  await new Promise((r) => setTimeout(r, waitMs));
  return activity.user;
}

/** test hook */
export const __activityTest = { accept, reset: (t = Date.now()) => ((activity.user = t), (activity.server = t), (lastSent = 0)) };

export interface IdleState {
  /** show the warning (≤ warn window left) */
  warn: boolean;
  /** sign out now */
  expired: boolean;
  /** ms left until the idle timeout */
  left: number;
  /** the user is active but the server has not seen a request for a while → GET /me keeps the session alive */
  heartbeat: boolean;
}

/** Warning window: 2 minutes before the timeout (never more than a third of a very short timeout). */
export const warnWindowSeconds = (timeoutSeconds: number) => Math.max(1, Math.min(120, Math.floor(timeoutSeconds / 3)));

/**
 * Idle policy (admin-bff: 30 min of inactivity). `lastUser` is the SHARED last interaction of all tabs. The warning
 * appears `warnSeconds` before the timeout; an active user who only reads (no requests) gets a heartbeat every
 * `heartbeatSeconds` (background polls do not count — admin-bff does not extend the session for them).
 */
export function idleState(now: number, lastUser: number, lastServer: number, timeoutSeconds: number, warnSeconds = warnWindowSeconds(timeoutSeconds), heartbeatSeconds = 300): IdleState {
  const idle = now - lastUser;
  const limit = timeoutSeconds * 1000;
  const left = limit - idle;
  return {
    warn: left <= warnSeconds * 1000 && left > 0,
    expired: left <= 0,
    left: Math.max(0, left),
    heartbeat: left > warnSeconds * 1000 && now - lastServer >= heartbeatSeconds * 1000 && idle < 60_000,
  };
}
