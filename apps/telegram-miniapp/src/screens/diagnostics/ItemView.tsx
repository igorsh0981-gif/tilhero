import type { DiagnosticItem } from "@tilhero/contracts/bff";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { errorText } from "../../api/errors";
import { MAX_LISTENS, orderAnswer, orderPick, orderStart, orderUnpick, splitGap, type OrderState } from "../../domain/diagnostics";
import { useI18n } from "../../i18n";
import { useDelayedFlag } from "../../state/hooks";
import { haptic, playSpeech, prefetchSpeech, SpeechUnavailableError, stopSpeech, type EnVariant, type SpeechSpeed } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, Opt } from "../../ui/kit";

export type Answer = number | string[] | null;

/**
 * One item of the placement test. The learner never sees whether the answer was right (no colours, no ticks after
 * answering); «Не знаю» is always available. Types: single_choice, gap_choice, read_choice (passage + question),
 * listen_choice (the phrase comes as MP3 from the server — the device voice only as a fallback —, ≤ 2 plays, its text
 * stays hidden), order_words (tap or drag).
 */
export function ItemView(props: {
  item: DiagnosticItem;
  kid: boolean;
  busy: boolean;
  /** listening is not possible (neither the server speech nor an English device voice): only «Не знаю» */
  listenBlocked: boolean;
  /** a play found that neither the server nor the device can speak — the runner reports listening-unavailable */
  onListenUnavailable: () => void;
  /** the chosen answer (controlled: the actions live in the pinned footer of the runner) */
  draft: Answer;
  onDraft: (a: Answer) => void;
}) {
  const { item, kid, draft } = props;
  const { t, l } = useI18n();
  const setDraft = props.onDraft;
  const qId = `dx-q-${item.item_id}`;

  return (
    <section className="stack" aria-labelledby={qId} data-testid={`dx-item-${item.type}`} data-item={item.item_id}>
      <p className="dx-instr">{l(item.instruction)}</p>
      {item.type === "read_choice" && item.passage_en ? (
        <div className="card passage" lang="en" aria-label={t("dx.read.passage")} data-testid="dx-passage">
          {item.passage_en}
        </div>
      ) : null}
      {item.type === "listen_choice" ? (
        <Listen text={item.audio_text_en ?? ""} kid={kid} blocked={props.listenBlocked} onUnavailable={props.onListenUnavailable} />
      ) : null}
      <Prompt item={item} id={qId} />
      {item.type === "order_words" ? (
        <OrderWords options={item.options} onChange={setDraft} />
      ) : (
        <div className="opts" role="group" aria-labelledby={qId}>
          {item.options.map((o, i) => (
            <Opt key={i} on={draft === i} title={o} onClick={() => setDraft(i)} disabled={props.busy || (item.type === "listen_choice" && props.listenBlocked)} testId={`dx-opt-${i}`} />
          ))}
        </div>
      )}
    </section>
  );
}

/** «Не знаю» and «Ответить» — pinned under the item (always reachable, even under a long passage). */
export function ItemActions(props: { kid: boolean; busy: boolean; draft: Answer; onAnswer: (answer: Answer, dontKnow: boolean) => void }) {
  const { t } = useI18n();
  return (
    <div className="foot">
      <div className="dx-actions">
        <Btn variant="secondary" disabled={props.busy} onClick={() => props.onAnswer(null, true)} data-testid="dx-dont-know">
          {t("dx.dontKnow")}
        </Btn>
        <Btn busy={props.busy} disabled={props.draft === null} onClick={() => props.draft !== null && props.onAnswer(props.draft, false)} data-testid="dx-answer">
          {props.kid ? t("dx.answerKid") : t("dx.answer")}
        </Btn>
      </div>
    </div>
  );
}

function Prompt({ item, id }: { item: DiagnosticItem; id: string }) {
  const { t } = useI18n();
  const gap = item.type === "gap_choice" ? splitGap(item.prompt_en) : null;
  return (
    <h2 className="dx-q" id={id} lang="en" data-testid="dx-prompt">
      {gap ? (
        <>
          {gap[0]}
          <span className="gap" role="img" aria-label={t("dx.gap")}>…</span>
          {gap[1]}
        </>
      ) : (
        item.prompt_en
      )}
    </h2>
  );
}

/* ---------- listening: server speech (MP3), the device voice as a fallback, at most two plays ---------- */
/** The voice of the placement test (the device fallback preferred en-GB as well). */
const LISTEN_VARIANT: EnVariant = "en-GB";

function Listen({ text, kid, blocked, onUnavailable }: { text: string; kid: boolean; blocked: boolean; onUnavailable: () => void }) {
  const { t, fmt } = useI18n();
  const [plays, setPlays] = useState(0);
  const [phase, setPhase] = useState<"idle" | "waiting" | "playing">("idle");
  const [error, setError] = useState<string | null>(null);
  const loading = useDelayedFlag(phase === "waiting");
  const alive = useRef(true);
  // children 6–13 hear the phrase slower
  const speed: SpeechSpeed = kid ? "slow" : "normal";
  useEffect(() => {
    alive.current = true;
    // the item is on screen: fetch its MP3 now, so the first tap plays at once (a blocked item is never played)
    if (text && !blocked) void prefetchSpeech(text, LISTEN_VARIANT, speed);
    return () => {
      alive.current = false;
      stopSpeech();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, speed]);
  const left = MAX_LISTENS - plays;
  /** Synchronous in the tap handler: iOS lets the shared audio element play only from a user gesture. */
  const play = () => {
    if (phase !== "idle" || left <= 0 || blocked) return;
    haptic.impact("light");
    setError(null);
    setPhase("waiting");
    playSpeech(text, LISTEN_VARIANT, {
      speed,
      // a listening is spent only when the sound actually started (not on a tap that played nothing)
      onStart: () => {
        if (!alive.current) return;
        setPlays((p) => p + 1);
        setPhase("playing");
      },
    })
      .catch((e: unknown) => {
        if (!alive.current) return;
        if (e instanceof SpeechUnavailableError) onUnavailable();
        else setError(errorText(e, t, fmt.mmss));
      })
      .finally(() => {
        if (alive.current) setPhase("idle");
      });
  };
  if (blocked) {
    return (
      <div className="card warn notice" role="status" data-testid="dx-listen-blocked">
        <Icon name="info" size={20} />
        <p className="sub ink">{t("dx.listen.unavailable")}</p>
      </div>
    );
  }
  const status = loading
    ? t("sp.loading")
    : phase === "playing"
      ? t("dx.listen.playing")
      : left > 0
        ? `${plays === 0 ? t("dx.listen.play") : t("dx.listen.again")} · ${t("dx.listen.left", { n: left })}`
        : t("dx.listen.none");
  return (
    <div className="listen" data-testid="dx-listen">
      <button
        type="button"
        className={cx("listen-btn", phase === "playing" && "playing")}
        onClick={play}
        disabled={phase !== "idle" || left <= 0}
        aria-busy={phase === "waiting"}
        aria-label={plays === 0 ? t("dx.listen.play") : t("dx.listen.again")}
        data-testid="dx-listen-play"
      >
        <Icon name={phase === "playing" ? "volume" : "play"} size={34} />
      </button>
      <p className="sub small" aria-live="polite" data-testid="dx-listen-left">
        {status}
      </p>
      <ErrorLine text={error} />
      <p className="sub small center">{t("dx.listen.hint")}</p>
    </div>
  );
}

/* ---------- word order: tap a word to add it, tap it in the answer to return it; drag and drop works too ---------- */
/** Words (or, with `lines`, dialogue lines of a media exercise) in order — taps or drag and drop. Reused by the lesson
 *  player (order_words, order_lines). */
export function OrderWords({ options, onChange, lines, hint }: { options: string[]; onChange: (a: string[] | null) => void; lines?: boolean; hint?: string }) {
  const { t } = useI18n();
  const uid = useId();
  const [st, setSt] = useState<OrderState>(() => orderStart(options.length));
  const [over, setOver] = useState(false);
  const drag = useRef<number | null>(null);
  const update = (next: OrderState) => {
    setSt(next);
    onChange(next.line.length === options.length ? orderAnswer(next, options) : null);
  };
  const tokenOf = (e: DragEvent): number | null => {
    const raw = e.dataTransfer.getData("text/plain");
    const n = raw === "" ? drag.current : Number(raw);
    return n == null || !Number.isInteger(n) ? null : n;
  };
  const onDragStart = (token: number) => (e: DragEvent) => {
    drag.current = token;
    e.dataTransfer.setData("text/plain", String(token));
    e.dataTransfer.effectAllowed = "move";
  };
  const dropOnLine = (at?: number) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    const tk = tokenOf(e);
    if (tk != null) update(orderPick(st, tk, at));
    drag.current = null;
  };
  const dropOnBank = (e: DragEvent) => {
    e.preventDefault();
    const tk = tokenOf(e);
    if (tk != null) update(orderUnpick(st, tk));
    drag.current = null;
  };
  return (
    <div className="stack tight">
      <p className="sub small">{hint ?? t("dx.order.hint")}</p>
      <p className="lb" id={`${uid}-line`}>{t("dx.order.line")}</p>
      <div
        className={cx("ow-line", over && "over", lines && "lines")}
        role="group"
        aria-labelledby={`${uid}-line`}
        lang="en"
        data-testid="ow-line"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={dropOnLine()}
      >
        {st.line.length === 0 ? <span className="ph" lang="ru">{t("dx.order.empty")}</span> : null}
        {st.line.map((tk, i) => (
          <button
            key={tk}
            type="button"
            className="ow-word"
            draggable
            onDragStart={onDragStart(tk)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={dropOnLine(i)}
            onClick={() => update(orderUnpick(st, tk))}
            aria-label={t("dx.order.remove", { w: options[tk] ?? "" })}
            data-testid={`ow-line-${i}`}
          >
            {options[tk]}
          </button>
        ))}
      </div>
      <div className="hrow between">
        <p className="lb" id={`${uid}-bank`}>{t("dx.order.bank")}</p>
        {st.line.length ? (
          <Btn variant="link" onClick={() => update(orderStart(options.length))} data-testid="ow-reset">
            {t("dx.order.reset")}
          </Btn>
        ) : null}
      </div>
      <div className={cx("ow-bank", lines && "lines")} role="group" aria-labelledby={`${uid}-bank`} lang="en" data-testid="ow-bank" onDragOver={(e) => e.preventDefault()} onDrop={dropOnBank}>
        {st.bank.map((tk) => (
          <button
            key={tk}
            type="button"
            className="ow-word"
            draggable
            onDragStart={onDragStart(tk)}
            onClick={() => update(orderPick(st, tk))}
            aria-label={t("dx.order.add", { w: options[tk] ?? "" })}
            data-testid={`ow-word-${tk}`}
          >
            {options[tk]}
          </button>
        ))}
      </div>
    </div>
  );
}
