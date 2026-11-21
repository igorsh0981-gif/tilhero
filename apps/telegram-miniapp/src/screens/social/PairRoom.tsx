import type { PairRoomEvent, PairRoomState, PairRoomView, PairTurnRequest } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useRef, useState } from "react";
import { canRecord, RecorderError, startRecording, type RecordedAudio, type Recording } from "../../audio/recorder";
import { isTooShort, MAX_RECORD_MS } from "../../audio/wav";
import { ApiError } from "../../api/errors";
import { prefersReducedMotion } from "../../domain/game";
import {
  canUseVoice,
  closedWhy,
  inputMode,
  isTerminal,
  lineOf,
  lobbyPhase,
  mergeEvents,
  partnerNetwork,
  roomGone,
  RoomLink,
  turnInfo,
  turnMark,
  TURN_TEXT_MAX,
  type ClosedWhy,
} from "../../domain/pairRoom";
import { teenWithoutConsent } from "../../domain/people";
import { memberLabel, socialErrorText } from "../../domain/social";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { keyForDraft, type DraftKey } from "../../state/idempotency";
import { confirmPopup, haptic, onAppVisibility } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { pairLine } from "./Pair";
import { ComplaintSheet, MemberAvatar, SocialError, useSocialAction } from "./parts";

/** How often a lobby that waits for someone else (the answer, the start, the end of the lesson) re-reads the room. */
const LOBBY_REFRESH_MS = 15_000;

/**
 * A pair lesson (APP-SOC-03…06, AT-76): the invitation (accept / decline, or wait and cancel), a lesson scheduled for
 * later (the start time and «Отменить», the entry opens 5 minutes before), the entry, the room — the roles and the team
 * goal from the coach, the coach's prompt with its translation, whose turn it is, my lines and the partner's (only inside
 * this room), an answer by text or by a choice (children — choices only), by voice with the consent (never for children);
 * the partner's network, the pause, reconnection, leaving, a complaint about the room; «away» — I was out more than 3
 * minutes, the partner finishes; the end with my own report. Which of them — by the server's can_join (lobbyPhase).
 */
export function PairRoomScreen({ id }: { id: string }) {
  const { bff, nav, session } = useApp();
  const { t, l, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const view = useLoad(() => bff.pairRoom(id), [id]);
  const v = view.data;
  const [entered, setEntered] = useState(false);
  const [complain, setComplain] = useState(false);
  const phase = v ? lobbyPhase(v) : null;
  const act = useSocialAction(async (a: "accept" | "decline" | "cancel") => {
    try {
      const n = await bff.pairAction(id, a);
      view.setData(n);
      if (a === "decline") showToast(t("pair.declinedToast"));
      if (a === "cancel") showToast(t("pair.cancelledToast"));
    } catch (e) {
      if (e instanceof ApiError && e.code === "ROOM_STATE") void view.reload();
      throw e;
    }
  });
  const onEnded = useCallback(() => {
    setEntered(false);
    void view.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // waiting for someone else — the answer, the start, the end of the lesson without me: re-read now and then
  const waiting = phase === "outgoing" || phase === "scheduled" || phase === "away";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void view.reload(), LOBBY_REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, id]);
  const inRoom = !!v && (phase === "room" || (phase === "enter" && entered));
  const name = v ? memberLabel(v.partner.nickname, t, kid ? "family" : "friend") : "";

  return (
    <>
      {!inRoom ? <Bar title={t("pair.title")} onBack={nav.back} /> : null}
      {!v ? (
        <main className="scroll">
          {view.loading ? <div className="pad"><Skeleton lines={3} /></div> : <SocialError error={view.error} errorObj={view.errorObj} onRetry={() => void view.reload()} service="lessons" />}
        </main>
      ) : inRoom ? (
        <Room v={v} partner={name} onEnded={onEnded} />
      ) : (
        <main className="scroll" data-testid="pair-lobby" data-phase={phase ?? undefined} data-status={v.status}>
          <div className="pad stack">
            <div className="card stack tight">
              <div className="hrow">
                <MemberAvatar hero={v.partner.hero} />
                <div className="grow">
                  <b data-testid="pair-line">{pairLine(v, t, kid)}</b>
                  <p className="sub small">{t("pair.partner", { name })}</p>
                </div>
              </div>
              <p className="sub ink" data-testid="pair-scenario">{l(v.scenario.title)} · {v.scenario.level}</p>
              <p className="sub small" data-testid="pair-start">{t("pair.startAt", { date: fmt.dateTime(v.start_at) })}</p>
              {v.respond_until ? <p className="sub small">{t("pair.respondUntil", { date: fmt.dateTime(v.respond_until) })}</p> : null}
              {v.mode === "choices" && kid ? <p className="sub small">{t("pair.inv.choicesKid")}</p> : null}
            </div>
            {phase === "incoming" ? (
              <div className="duo">
                <Btn variant="secondary" busy={act.busy} onClick={() => void act.run("decline")} data-testid="pair-decline">{t("pair.decline")}</Btn>
                <Btn busy={act.busy} onClick={() => void act.run("accept")} data-testid="pair-accept">{t("pair.accept")}</Btn>
              </div>
            ) : null}
            {phase === "scheduled" ? (
              <div className="card pen stack tight" role="status" data-testid="pair-scheduled">
                <b className="h3 ic-line">
                  <Icon name="calendar" size={20} />
                  {t("pair.sched.title", { date: fmt.dateTime(v.start_at) })}
                </b>
                <p className="sub ink">{kid ? t("pair.sched.noteKid") : t("pair.sched.note")}</p>
              </div>
            ) : null}
            {phase === "away" ? (
              <div className="card warn stack tight" role="status" data-testid="pair-away">
                <b className="h3">{kid ? t("pair.away.titleKid") : t("pair.away.title")}</b>
                <p className="sub ink">{kid ? t("pair.away.textKid") : t("pair.away.text")}</p>
                <p className="sub small">{t("prep.minutes", { n: v.minutes })}</p>
              </div>
            ) : null}
            {phase === "outgoing" || phase === "scheduled" || phase === "away" ? (
              <Btn variant="secondary" busy={view.loading} onClick={() => void view.reload()} data-testid="pair-refresh">{t("soc.refresh")}</Btn>
            ) : null}
            {phase === "outgoing" || phase === "scheduled" ? (
              <Btn variant="dangerOutline" busy={act.busy} onClick={() => void act.run("cancel")} data-testid="pair-cancel">{t("pair.cancel")}</Btn>
            ) : null}
            {phase === "enter" ? (
              <>
                <Btn onClick={() => setEntered(true)} data-testid="pair-enter">
                  <Icon name="play" size={18} />
                  {t("pair.enter")}
                </Btn>
                <Btn variant="link" busy={act.busy} onClick={() => void act.run("cancel")} data-testid="pair-cancel">{t("pair.cancel")}</Btn>
              </>
            ) : null}
            {phase === "ended" ? (
              <div className="card stack tight" data-testid="pair-ended">
                {v.end_reason ? <p className="sub ink" data-testid="pair-end-reason">{t(`pair.end.${v.end_reason}` as MessageKey)}</p> : null}
                <p className="sub small">{t("prep.minutes", { n: v.minutes })}</p>
                {v.report_available ? (
                  <Btn onClick={() => nav.push({ name: "pairReport", id: v.room_id })} data-testid="pair-to-report">
                    <Icon name="list" size={18} />
                    {t("pair.report")}
                  </Btn>
                ) : null}
              </div>
            ) : null}
            <ErrorLine text={act.error} />
            <p className="sub small">{kid ? t("pair.whatKid") : t("pair.what")}</p>
            {!kid ? (
              <Btn variant="link" onClick={() => setComplain(true)} data-testid="pair-complain">
                <Icon name="flag" size={16} />
                {t("pair.complain")}
              </Btn>
            ) : null}
          </div>
        </main>
      )}
      {complain && v ? (
        <ComplaintSheet
          member={{ member_id: v.partner.member_id, label: name }}
          subject={{ kind: v.status === "invited" ? "invite" : "pair_room", id: v.room_id }}
          onClose={() => setComplain(false)}
        />
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- the room */

const PRESENCE: ReadonlySet<PairRoomEvent["kind"]> = new Set(["joined", "left", "offline", "online"]);

function closedText(why: ClosedWhy, kid: boolean, t: (k: MessageKey, v?: Record<string, string | number>) => string, dateTime: (s: string) => string): string {
  if (why.kind === "away") return kid ? t("pair.away.textKid") : t("pair.away.text");
  if (why.kind === "early") return t("pair.sched.join", { date: dateTime(why.startAt) });
  return t("err.ROOM_NOT_ACTIVE");
}

function Room({ v, partner, onEnded }: { v: PairRoomView; partner: string; onEnded: () => void }) {
  const { bff, nav, session } = useApp();
  const { t, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const [st, setSt] = useState<PairRoomState | null>(null);
  const [events, setEvents] = useState<PairRoomEvent[]>([]);
  const [linkOk, setLinkOk] = useState(true);
  const [joinError, setJoinError] = useState<unknown>(null);
  /** the room is over for me (409 ROOM_NOT_ACTIVE / 404 on join, heartbeat or a turn): why, instead of the room */
  const [closed, setClosed] = useState<ClosedWhy | null>(null);
  const [gloss, setGloss] = useState(false);
  const [complain, setComplain] = useState(false);
  const link = useRef<RoomLink | null>(null);
  const end = useRef<HTMLLIElement>(null);
  /** leaving the room (the request in flight, or it failed): nothing joins again by itself (F7-21) */
  const leaving = useRef(false);
  const [exiting, setExiting] = useState<{ blocked: boolean } | null>(null);
  /** the room is over for me (closed): a return of the app does not join again either */
  const closedRef = useRef(false);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const mounted = useRef(true);
  /** the last seq seen: a return (the app visible again) continues the feed after it */
  const seqRef = useRef(0);

  const accept = useCallback((s: PairRoomState) => {
    seqRef.current = Math.max(seqRef.current, s.seq);
    setSt(s);
    setEvents((p) => mergeEvents(p, s.events));
  }, []);

  /** The room is over for me: stop the link, say why, and let the screen re-read the room (the lobby takes over). */
  const close = useCallback((e: unknown) => {
    closedRef.current = true;
    stopRef.current?.();
    stopRef.current = null;
    setClosed(closedWhy(e));
    ended.current();
  }, []);

  /** the stop of the current connection (the first one, a retry, a return to the app) */
  const stopRef = useRef<(() => void) | null>(null);
  const connect = useCallback(() => {
    stopRef.current?.();
    let alive = true;
    closedRef.current = false;
    setJoinError(null);
    setClosed(null);
    const lk = new RoomLink({
      poll: (after, signal) => bff.pairState(v.room_id, after, signal),
      heartbeat: () => bff.pairHeartbeat(v.room_id),
      onState: (s) => alive && accept(s),
      onLink: (ok) => alive && setLinkOk(ok),
      onEnd: (s, e) => {
        if (!alive) return;
        // a terminal status — the screen shows the end; ROOM_NOT_ACTIVE / 404 — why it is over for me
        if (s) ended.current();
        else close(e);
      },
    });
    link.current = lk;
    // (re)join: within 3 minutes the same room goes on, without a second session
    bff.joinPair(v.room_id).then(
      (s) => {
        if (!alive) return;
        accept(s);
        if (isTerminal(s.status)) ended.current();
        else lk.start(Math.max(s.seq, seqRef.current));
      },
      (e: unknown) => {
        if (!alive) return;
        if (roomGone(e)) close(e);
        else setJoinError(e);
      },
    );
    stopRef.current = () => {
      alive = false;
      lk.stop();
    };
  }, [bff, v.room_id, accept, close]);

  // the long-poll and the heartbeat live while the room is on screen and the app is visible: leaving the screen or
  // hiding the app (another chat, a minimised window, a locked phone) stops them — the server then sees the learner
  // away (30 s → offline, 3 minutes → abandoned); coming back joins again and goes on after the last seq
  useEffect(() => {
    mounted.current = true;
    connect();
    const off = onAppVisibility((visible) => {
      if (!visible) {
        stopRef.current?.();
        stopRef.current = null;
      } else if (!stopRef.current && !leaving.current && !closedRef.current) connect();
    });
    return () => {
      mounted.current = false;
      off();
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [connect]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [events.length]);

  // one Idempotency-Key per turn: the same answer to the same turn goes again with it (a lost answer is not a second
  // turn); a new turn of mine — a new key even for the same choice c1..c3 or the same text
  const turnKey = useRef<DraftKey | null>(null);
  const mark = turnMark(events);
  const turn = useSocialAction(async (body: PairTurnRequest) => {
    turnKey.current = keyForDraft(turnKey.current, { body, turn: mark });
    try {
      const s = await bff.pairTurn(v.room_id, body, turnKey.current.key);
      turnKey.current = null;
      haptic.selection();
      if (link.current) link.current.push(s);
      else accept(s);
      return true;
    } catch (e) {
      if (roomGone(e)) close(e);
      throw e;
    }
  });
  /**
   * Leave the room («Выйти», or a complaint with a block): the link stops and stays stopped while leaving — a return of
   * the app from the background does not join again. A failure never takes the learner back into the lesson by itself:
   * the error and «Выйти ещё раз» (and «Вернуться в урок» when the learner only wanted to go, not after a block).
   */
  const exit = useSocialAction(async (blocked: boolean) => {
    leaving.current = true;
    setExiting({ blocked });
    stopRef.current?.();
    stopRef.current = null;
    try {
      await bff.pairAction(v.room_id, "leave");
    } catch (e) {
      // 409 ROOM_NOT_ACTIVE / 404 — the room is over for me anyway: I am out
      if (!roomGone(e)) throw e;
    }
    if (!blocked) showToast(t("pair.room.left"));
    if (mounted.current) nav.back();
  });
  const leave = async () => {
    const ok = await confirmPopup({ title: t("pair.room.leaveQ"), message: kid ? t("pair.room.leaveTextKid") : t("pair.room.leaveText"), ok: t("pair.room.leave"), cancel: t("c.cancel"), destructive: true });
    if (ok) await exit.run(false);
  };
  /** «Вернуться в урок» after a failed exit — only by the learner's choice */
  const stay = () => {
    leaving.current = false;
    setExiting(null);
    exit.setError(null);
    connect();
  };

  const info = st ? turnInfo(st) : { mine: false, who: "nobody" as const };
  const mode = st ? inputMode(st, kid) : "wait";
  const net = st ? partnerNetwork(st) : null;
  const who = (role: PairRoomEvent["role"]) => (role && st?.my_role && role === st.my_role ? t(kid ? "soc.youKid" : "soc.you") : partner);
  const turnLine =
    st?.status === "paused"
      ? t("pair.st.paused")
      : st?.status === "waiting"
        ? t("pair.room.wait")
        : info.who === "me"
          ? t(kid ? "pair.room.turn.meKid" : "pair.room.turn.me")
          : info.who === "both"
            ? t("pair.room.turn.both")
            : info.who === "partner"
              ? t("pair.room.turn.partner", { name: partner })
              : t("pair.room.turn.nobody");
  const progress = Math.round(Math.max(0, Math.min(1, st?.team_goal_progress ?? 0)) * 100);

  return (
    <>
      {/* «Назад» leaves the screen, not the room: the poll and the heartbeat stop, a return in 3 minutes continues it */}
      <Bar
        title={t("pair.partner", { name: partner })}
        onBack={nav.back}
        right={
          <>
            {!kid && !closed && !exiting ? (
              <button type="button" className="ib" aria-label={t("pair.complain")} onClick={() => setComplain(true)} data-testid="room-complain">
                <Icon name="flag" size={20} />
              </button>
            ) : null}
            {!closed ? (
              <Btn variant="link" className="room-leave" busy={exit.busy} onClick={() => void leave()} data-testid="room-leave">
                <Icon name="logout" size={18} />
                {t("pair.room.leave")}
              </Btn>
            ) : null}
          </>
        }
      />
      <main className="scroll lp-main" data-testid="room" data-status={closed ? "closed" : (st?.status ?? "joining")} aria-busy={!st && !closed && !joinError}>
        <div className="pad stack">
          {closed ? (
            <div className="card warn stack tight" role="status" data-testid="room-closed" data-why={closed.kind}>
              <p className="sub ink">{closedText(closed, kid, t, fmt.dateTime)}</p>
              <Btn variant="secondary" onClick={() => connect()} data-testid="room-closed-retry">{t("soc.refresh")}</Btn>
            </div>
          ) : joinError ? (
            <SocialError error={null} errorObj={joinError} onRetry={() => connect()} service="lessons" />
          ) : !st ? (
            <Skeleton lines={3} />
          ) : (
            <>
              {!linkOk ? (
                <div className="card warn notice" role="status" data-testid="room-reconnect">
                  <span className="spin" aria-hidden="true" />
                  <p className="sub ink">{t("pair.room.reconnect")}</p>
                </div>
              ) : null}
              {st.status === "paused" ? (
                <div className="card warn notice" role="status" data-testid="room-paused">
                  <Icon name="clock" size={20} />
                  <p className="sub ink">{t("pair.room.paused")}</p>
                </div>
              ) : net === "offline" ? (
                <div className="card warn notice" role="status" data-testid="room-partner-off">
                  <Icon name="info" size={20} />
                  <p className="sub ink">{t("pair.room.partnerOff", { name: partner })}</p>
                </div>
              ) : null}
              {st.ai_degraded ? (
                <div className="card notice" role="note" data-testid="room-degraded">
                  <Icon name="info" size={20} />
                  <p className="sub ink">{t("pair.room.degraded")}</p>
                </div>
              ) : null}
              {st.status === "waiting" ? (
                <p className="sub card" role="status" data-testid="room-wait">{t("pair.room.wait")}</p>
              ) : null}
              {st.my_role ? (
                <section className="card stack tight" aria-labelledby="room-role" data-testid="room-role">
                  <h2 className="h3" id="room-role">
                    {t(kid ? "pair.room.roleKid" : "pair.room.role", { role: st.my_role })}
                  </h2>
                  {st.my_role_brief ? <p className="sub ink" lang="en" data-testid="room-brief">{st.my_role_brief}</p> : null}
                  {st.team_goal ? (
                    <>
                      <span className="cap">{t("pair.room.goal")}</span>
                      <p className="sub ink" lang="en" data-testid="room-goal">{st.team_goal}</p>
                    </>
                  ) : null}
                  <div className="prog" role="progressbar" aria-label={t("pair.room.goal")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={t("pair.room.progress", { n: progress })} data-testid="room-progress">
                    <div style={{ width: `${progress}%` }} />
                  </div>
                </section>
              ) : null}
              <section aria-label={t("pair.room.feed")}>
                <ol className="chat room-feed" data-testid="room-feed">
                  {events.map((e) => {
                    const line = lineOf(e, st.my_role);
                    // my own presence (joined, left, offline, online) is not news for me: only the partner's is shown
                    if (line === "system" && PRESENCE.has(e.kind) && e.role && e.role === st.my_role) return null;
                    if (line === "system") {
                      return (
                        <li key={e.seq} className="bub sys" data-testid="room-sys" data-kind={e.kind}>
                          {t(`pair.ev.${e.kind}` as MessageKey, { name: who(e.role) })}
                        </li>
                      );
                    }
                    return (
                      <li key={e.seq} className={cx("bub", line === "me" ? "me" : "ch", line === "coach" && "coach")} data-testid={`room-${line}`}>
                        <span className="who">{line === "coach" ? t("pair.room.coach") : line === "me" ? t(kid ? "soc.youKid" : "soc.you") : partner}</span>
                        <span className="en" lang="en">{e.text}</span>
                        <small>{fmt.dateTime(e.at).split(", ")[1] ?? ""}</small>
                      </li>
                    );
                  })}
                  <li ref={end} aria-hidden="true" className="room-end" />
                </ol>
              </section>
            </>
          )}
        </div>
      </main>
      {exiting ? (
        <div className="foot lp-foot room-foot" data-testid="room-exit">
          {exit.busy ? (
            <p className="room-turn" role="status" data-testid="room-exiting">
              <span className="spin" aria-hidden="true" />
              {t("pair.room.leaving")}
            </p>
          ) : exit.error ? (
            <div className="stack tight" role="alert" data-testid="room-leave-failed">
              <p className="sub ink">{t("pair.room.leaveFailed")} {exit.error}</p>
              <Btn onClick={() => void exit.run(exiting.blocked)} data-testid="room-leave-again">
                <Icon name="logout" size={18} />
                {t("pair.room.leaveAgain")}
              </Btn>
              {!exiting.blocked ? (
                <Btn variant="link" onClick={stay} data-testid="room-stay">{t("pair.room.stay")}</Btn>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : st && !closed && !isTerminal(st.status) ? (
        <div className="foot lp-foot room-foot" data-testid="room-foot">
          <p className={cx("room-turn", info.mine && "mine")} role="status" aria-live="polite" data-testid="room-turn" data-who={info.who}>
            {info.mine ? <Icon name="chat" size={18} /> : <Icon name="clock" size={18} />}
            {turnLine}
          </p>
          {st.prompt && info.mine ? (
            <div className="card pen stack tight room-prompt" data-testid="room-prompt">
              <span className="cap">{t("pair.room.prompt")}</span>
              <p className="sub ink" lang="en">{st.prompt}</p>
              {st.prompt_gloss ? (
                gloss ? (
                  <p className="sub" data-testid="room-gloss">{st.prompt_gloss}</p>
                ) : (
                  <Btn variant="link" className="soc-inline" onClick={() => setGloss(true)} data-testid="room-gloss-btn">{t("pair.room.gloss")}</Btn>
                )
              ) : null}
            </div>
          ) : null}
          {mode === "choices" && st.options ? (
            <div className="stack tight" role="group" aria-label={t(kid ? "pair.room.chooseKid" : "pair.room.choose")} data-testid="room-options">
              <span className="lb">{t(kid ? "pair.room.chooseKid" : "pair.room.choose")}</span>
              {st.options.map((o) => (
                <button key={o.choice_id} type="button" className="opt room-opt" lang="en" disabled={turn.busy} onClick={() => void turn.run({ choice_id: o.choice_id })} data-testid={`room-opt-${o.choice_id}`}>
                  <span className="t"><b>{o.text_en}</b></span>
                </button>
              ))}
            </div>
          ) : mode === "free" ? (
            <FreeInput st={st} kid={kid} roomId={v.room_id} busy={turn.busy} onSend={(b) => turn.run(b)} />
          ) : null}
          <ErrorLine text={turn.error} />
          <p className="sub small" data-testid="room-seconds">{t(kid ? "pair.room.secondsKid" : "pair.room.seconds", { n: st.my_speaking_seconds })}</p>
        </div>
      ) : null}
      {complain ? (
        <ComplaintSheet
          member={{ member_id: v.partner.member_id, label: partner }}
          subject={{ kind: "pair_room", id: v.room_id }}
          onClose={() => setComplain(false)}
          onDone={(blocked) => {
            // blocked: the room with this learner is left at once; a failure — the error and «Выйти ещё раз», never the
            // lesson with the blocked learner again
            if (blocked) void exit.run(true);
          }}
        />
      ) : null}
    </>
  );
}

/** Free text (≤ 300, English) and — with the consent, 14+ — the voice: recorded, recognised, shown for confirmation,
 *  then sent as the turn {audio_id}. The audio is never kept. */
type SendTurn = (b: PairTurnRequest) => Promise<boolean | undefined>;

function FreeInput({ st, kid, roomId, busy, onSend }: { st: PairRoomState; kid: boolean; roomId: string; busy: boolean; onSend: SendTurn }) {
  const { session, nav } = useApp();
  const { t } = useI18n();
  const [text, setText] = useState("");
  const value = text.trim();
  const voice = canUseVoice(st, kid);
  const hasConsent = session.consent.purposes.includes("voice_recording");
  const send = async () => {
    if (!value) return;
    // a lost turn keeps the text (the same text goes again with the same key)
    if (await onSend({ text: value })) setText("");
  };
  return (
    <div className="stack tight">
      <label className="lb" htmlFor="room-text">{t("pair.room.type")}</label>
      <div className="rp-input">
        <textarea
          id="room-text"
          className="inp"
          lang="en"
          rows={1}
          maxLength={TURN_TEXT_MAX}
          placeholder={t("pair.room.typePh")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          data-testid="room-input"
        />
        <button type="button" className="rp-send" aria-label={t("pair.room.send")} aria-busy={busy || undefined} disabled={!value || busy} onClick={() => void send()} data-testid="room-send">
          {busy ? <span className="spin" aria-hidden="true" /> : <Icon name="send" size={20} />}
        </button>
      </div>
      <p className="rp-count" aria-live="polite">{t("pair.room.count", { n: text.length, m: TURN_TEXT_MAX })}</p>
      {voice ? (
        <VoiceTurn roomId={roomId} busy={busy} onSend={onSend} />
      ) : !kid ? (
        <p className="sub small" data-testid="room-voice-off">
          {teenWithoutConsent(session) ? t("pair.room.voiceGuardian") : !hasConsent ? t("pair.room.voiceConsent") : t("pair.room.voiceOff")}
          {!hasConsent && !teenWithoutConsent(session) ? (
            <Btn variant="link" className="soc-inline" onClick={() => nav.push({ name: "voiceConsent" })} data-testid="room-to-voice">
              {t("pair.room.toVoice")}
            </Btn>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

type VoicePhase = { k: "idle" } | { k: "recording" } | { k: "sending" } | { k: "heard"; audio_id: string; text: string } | { k: "error"; text: string };

function VoiceTurn({ roomId, busy, onSend }: { roomId: string; busy: boolean; onSend: SendTurn }) {
  const { bff } = useApp();
  const { t, fmt } = useI18n();
  const [phase, setPhase] = useState<VoicePhase>({ k: "idle" });
  const rec = useRef<Recording | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      rec.current?.cancel();
      rec.current = null;
    };
  }, []);
  const upload = async (audio: RecordedAudio) => {
    rec.current = null;
    if (!alive.current) return;
    if (isTooShort(audio)) {
      setPhase({ k: "error", text: t("pn.tooShort") });
      return;
    }
    setPhase({ k: "sending" });
    try {
      // the WAV goes only into this request; nothing is kept after it
      const r = await bff.pairAudio(roomId, audio.wav);
      if (alive.current) setPhase({ k: "heard", audio_id: r.audio_id, text: r.text });
    } catch (e) {
      if (!alive.current) return;
      setPhase({ k: "error", text: socialErrorText(e, t, fmt) });
    }
  };
  /** synchronous in the tap (iOS opens the microphone only from a gesture) */
  const start = () => {
    if (!canRecord()) {
      setPhase({ k: "error", text: t("pn.mic.unsupported") });
      return;
    }
    setPhase({ k: "recording" });
    startRecording({ maxMs: MAX_RECORD_MS, onAutoStop: (r) => void upload(r) }).then(
      (r) => {
        if (!alive.current) r.cancel();
        else rec.current = r;
      },
      (e: unknown) => alive.current && setPhase({ k: "error", text: t(`pn.mic.${e instanceof RecorderError ? e.reason : "failed"}` as MessageKey) }),
    );
  };
  const stop = async () => {
    const r = rec.current;
    if (r) await upload(await r.stop());
  };
  return (
    <div className="stack tight room-voice" data-testid="room-voice" data-phase={phase.k}>
      {phase.k === "idle" || phase.k === "error" ? (
        <>
          <Btn variant="secondary" disabled={busy} onClick={start} data-testid="room-voice-start">
            <Icon name="mic" size={18} />
            {t("pair.room.voice")}
          </Btn>
          {phase.k === "error" ? <ErrorLine text={phase.text} /> : <p className="sub small">{t("pair.room.voiceNote")}</p>}
        </>
      ) : phase.k === "recording" ? (
        <div className="hrow between">
          <p className="rec-state" role="status" aria-live="polite">
            <span className="rec-dot" aria-hidden="true" />
            {t("pair.room.voiceRec")}
          </p>
          <Btn onClick={() => void stop()} data-testid="room-voice-stop">
            <Icon name="stop" size={18} />
            {t("pair.room.voiceStop")}
          </Btn>
        </div>
      ) : phase.k === "sending" ? (
        <p className="sub" role="status"><span className="spin" aria-hidden="true" /> {t("pair.room.voiceSending")}</p>
      ) : (
        <div className="card stack tight" data-testid="room-heard">
          <span className="cap">{t("pair.room.voiceHeard")}</span>
          <p className="sub ink" lang="en" data-testid="room-heard-text">{phase.text}</p>
          <div className="duo">
            <Btn variant="secondary" onClick={() => setPhase({ k: "idle" })} data-testid="room-voice-again">{t("pair.room.voiceAgain")}</Btn>
            <Btn
              busy={busy}
              onClick={() =>
                void onSend({ audio_id: phase.audio_id }).then((ok) => {
                  if (ok && alive.current) setPhase({ k: "idle" });
                })
              }
              data-testid="room-voice-send"
            >
              {t("pair.room.send")}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
