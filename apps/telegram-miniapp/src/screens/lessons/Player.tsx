import type { SessionStage } from "@tilhero/contracts/bff";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorText } from "../../api/errors";
import { isOpen, playerMarker, sendFailure, showsDegraded, stageStrip, type PlayerError } from "../../domain/lessons";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { haptic, useBackButton } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, HERO, Hero, Skeleton } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import { ChatList, RoleplayView, type Cast } from "./Roleplay";
import { DoneView, ExplanationView, ItemView, ListenView, NoticeView, OpenAnswerView, RoleplayEndView, StepFrame } from "./steps";
import { usePlayer } from "./usePlayer";
import { ReadingStepView } from "../reading/ReadingStep";

/**
 * The lesson player (APP-LESS-02…06, AT-40…43): a header with the stages (strip and the current stage in words), the
 * pause menu («Пауза / Выйти»), the step on screen; re-entry continues from the same step (GET current), a lost answer
 * is re-sent unchanged, the simplified mode is a neutral plaque. The same player runs scenario and media sessions and
 * the review of mistakes.
 */
export function LessonPlayer({ sessionId }: { sessionId: string }) {
  const { bff, nav, session: app } = useApp();
  const { t, l, fmt, lang } = useI18n();
  const kid = app.learner.kind === "child";
  const api = usePlayer(bff, sessionId, lang);
  const { st } = api;
  const [menu, setMenu] = useState(false);
  const cast = useRef<Cast>(new Map());

  useEffect(() => {
    playerMarker.set(sessionId);
    void api.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  useBackButton(() => setMenu(true));

  // graded answers: «Ответ принят», no correctness until the summary
  const accepted = useRef(st.accepted);
  useEffect(() => {
    if (st.accepted > accepted.current) {
      showToast(t("pl.item.accepted"));
      haptic.impact("light");
    }
    accepted.current = st.accepted;
  }, [st.accepted, t]);

  const step = st.step;
  if (step?.type === "roleplay") cast.current.set(step.character.id, { name: step.character.name, role: step.character.role, voice: step.character.voice });
  const strip = st.session ? stageStrip(st.session, step) : null;
  const stageName = (s: SessionStage | null) => (s ? t(`st.${s}` as MessageKey) : "");
  const isLesson = !st.session || st.session.kind === "lesson";

  const exit = async () => {
    setMenu(false);
    if (st.session && isOpen(st.session) && st.phase !== "paused" && st.phase !== "closed") await api.pause();
    playerMarker.clear();
    nav.back();
    if (strip?.current && st.phase !== "closed") showToast(t(isLesson ? "pl.exited" : "pl.exitedOther", { stage: stageName(strip.current) }));
  };
  const pause = async () => {
    setMenu(false);
    await api.pause();
  };
  const finish = async () => {
    const summary = await api.finish();
    if (!summary) return;
    playerMarker.clear();
    haptic.notify("success");
    nav.replace({ name: "lessonSummary", sessionId, summary, fresh: true });
  };

  const top = (
    <>
      {/* AI off at the start (emergency stop, budget) — from the first step; gone in the roleplay — after the re-read */}
      {showsDegraded(st.session, step) ? (
        <div className="card notice" role="note" data-testid="pl-degraded">
          <Icon name="info" size={20} />
          <p className="sub ink">{t("pl.degraded")}</p>
        </div>
      ) : null}
    </>
  );
  const error = st.busy ? (
    // 409 AI_BUSY: the same answer goes again in 2 s
    <p className="sub small" role="status" aria-live="polite" data-testid="pl-busy">
      {t("pl.busy")}
    </p>
  ) : st.error ? (
    <PlayerErrorLine error={st.error} onResend={() => void api.resend()} onReload={() => void api.load()} sending={st.phase === "sending"} />
  ) : null;

  let body: ReactNode;
  if (st.phase === "closed") {
    body = (
      <main className="scroll lp-main">
        <div className="pad stack">
          <div className="card warn" data-testid="pl-closed">
            <p className="sub ink">{t("pl.closed")}</p>
          </div>
          <Btn
            onClick={() => {
              playerMarker.clear();
              nav.goTab("lessons");
            }}
            data-testid="pl-to-lessons"
          >
            {t("pl.toLessons")}
          </Btn>
        </div>
      </main>
    );
  } else if (st.phase === "paused" && st.session) {
    body = (
      <StepFrame top={null} error={error} foot={<Btn onClick={() => void api.resume()} data-testid="pl-resume">{t("pl.resume")}</Btn>} testId="pl-paused">
        <div className="stack lp-paused">
          <Hero src={kid ? HERO.myatik : HERO.nilu} alt="" />
          <h2 className="h2">{t(isLesson ? "pl.paused.title" : "pl.paused.titleOther")}</h2>
          <p className="sub">{t("pl.paused.text", { date: st.session.expires_at ? fmt.dateTime(st.session.expires_at).replace(" ", "\u00A0") : "—" })}</p>
        </div>
      </StepFrame>
    );
  } else if (!step) {
    body = (
      <main className="scroll lp-main" aria-busy={st.phase === "loading"}>
        <div className="pad stack">
          {st.error ? (
            <>
              <ErrorLine text={errorText(st.error.error, t, fmt.mmss)} />
              <Btn variant="secondary" onClick={() => void api.load()} data-testid="pl-reload">{t("c.retry")}</Btn>
            </>
          ) : (
            <>
              <p className="sub" role="status">{t("pl.loading")}</p>
              <Skeleton lines={3} />
            </>
          )}
        </div>
      </main>
    );
  } else {
    const p = { api, kid, top, error };
    switch (step.type) {
      case "notice":
        body = <NoticeView key={step.step_id} {...p} step={step} />;
        break;
      case "explanation":
        body = <ExplanationView key={step.step_id} {...p} step={step} />;
        break;
      case "item":
        body = <ItemView key={step.step_id} {...p} step={step} />;
        break;
      case "roleplay":
        body = <RoleplayView key={step.step_id} {...p} step={step} cast={cast.current} />;
        break;
      case "roleplay_end": {
        const last = st.chat.length || st.reply ? [...st.chat, ...(st.reply ? [{ id: "reply-end", who: "character" as const, text: st.reply.text_en, gloss: st.reply.gloss, characterId: st.reply.character_id, clarification: false }] : [])] : [];
        body = <RoleplayEndView key={step.step_id} {...p} step={step} chat={last.length ? <ChatList bubbles={last} cast={cast.current} /> : null} />;
        break;
      }
      case "listen":
        body = <ListenView key={step.step_id} {...p} step={step} />;
        break;
      case "open_answer":
        body = <OpenAnswerView key={step.step_id} {...p} step={step} />;
        break;
      case "reading":
        body = <ReadingStepView key={step.step_id} {...p} step={step} />;
        break;
      case "done":
        body = <DoneView key={step.step_id} {...p} step={step} onFinish={() => void finish()} />;
        break;
    }
  }

  return (
    <>
      <header className="bar lp-bar" data-testid="pl-header">
        <button type="button" className="ib" aria-label={t("pl.menu")} onClick={() => setMenu(true)} data-testid="pl-menu">
          <Icon name="close" size={24} stroke={2} />
        </button>
        <div className="lp-head">
          <h1 className="sr">{st.session ? l(st.session.title) : t("pl.menuTitle")}</h1>
          <p className="h3" data-testid="pl-stage">{strip ? stageName(strip.current) : t("pl.loading")}</p>
          {strip ? (
            <p className="sub" data-testid="pl-stage-of">
              {t("pl.stageOf", { n: strip.index, m: strip.total })}
              {step && step.stage_total > 1 && step.type !== "done" ? ` · ${t("pl.stepOf", { n: step.position, m: step.stage_total })}` : ""}
            </p>
          ) : null}
        </div>
      </header>
      {strip ? (
        <div
          className="lp-strip"
          role="progressbar"
          aria-label={t("pl.stagesAria", { done: strip.done, m: strip.total, stage: stageName(strip.current) })}
          aria-valuemin={0}
          aria-valuemax={strip.total}
          aria-valuenow={strip.done}
          data-testid="pl-strip"
        >
          {strip.stages.map((s, i) => (
            <span key={i} className={cx("lp-seg", s.status)} data-status={s.status} />
          ))}
        </div>
      ) : null}
      {body}
      {menu ? (
        <Sheet title={t("pl.menuTitle")} cap={st.session ? l(st.session.title) : undefined} onClose={() => setMenu(false)} testId="pl-menu-sheet">
          <p className="sub">{t("pl.menuText")}</p>
          <div className="stack tight">
            {st.phase !== "paused" && st.phase !== "closed" && st.session && isOpen(st.session) ? (
              <Btn variant="secondary" onClick={() => void pause()} data-testid="pl-pause">
                <Icon name="clock" size={18} />
                {t("pl.pause")}
              </Btn>
            ) : null}
            <Btn variant="secondary" onClick={() => void exit()} data-testid="pl-exit">
              <Icon name="back" size={18} />
              {t("pl.exit")}
            </Btn>
            <Btn onClick={() => setMenu(false)} data-testid="pl-stay">
              {t("pl.stay")}
            </Btn>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}

/**
 * The error under the step: a lost answer → «Отправить ещё раз» (the same answer), with the reason — no network, or the
 * service answers slowly / is down for a while (the answer may already be saved: a repeat is safe), or too many
 * requests; a step not loaded → «Повторить».
 */
function PlayerErrorLine({ error, onResend, onReload, sending }: { error: PlayerError | null; onResend: () => void; onReload: () => void; sending: boolean }) {
  const { t, fmt } = useI18n();
  if (!error) return null;
  if (error.kind === "note") return <p className="sub small" role="status" data-testid="pl-note">{t("pl.refreshed")}</p>;
  if (error.kind === "send") {
    const why = sendFailure(error.error);
    const text = why === "network" ? t("pl.sendFailed") : why === "service" ? t("pl.sendSlow") : why === "busy" ? t("pl.sendBusy") : errorText(error.error, t, fmt.mmss);
    return (
      <div className="stack tight" data-testid="pl-send-failed" data-reason={why}>
        <ErrorLine text={text} />
        <Btn variant="secondary" busy={sending} onClick={onResend} data-testid="pl-resend">
          {t("pl.resend")}
        </Btn>
      </div>
    );
  }
  return (
    <div className="stack tight" data-testid="pl-error">
      <ErrorLine text={errorText(error.error, t, fmt.mmss)} />
      {error.kind === "load" ? (
        <Btn variant="secondary" onClick={onReload}>
          {t("c.retry")}
        </Btn>
      ) : null}
    </div>
  );
}
