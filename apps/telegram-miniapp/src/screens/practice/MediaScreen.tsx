import type { MediaDetail } from "@tilhero/contracts/bff";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useDelayedFlag, useLoad } from "../../state/hooks";
import { playSpeech, playUrl, preloadAudio, prefetchSpeech, SpeechUnavailableError, stopSpeech, type EnVariant, type PreloadedFile } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Pill, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";
import { useStartSession } from "../lessons/startSession";
import { MEDIA_ICON } from "./Practice";

/**
 * A media item (APP-MEDIA-01, AT-29): source and attribution (plain text, never a link), listening — the audio file from
 * the BFF (fetched when the screen shows, played on the shared audio element of tg/tts.ts — iOS plays only from a tap) or,
 * without a file, speech synthesis line by line (marked «синтез речи»: server MP3 per line, the device voice
 * as a fallback), the transcript with the
 * translation on tap (only when the licence allows it), phrases; «Упражнения» (AT-48) — a media session (comprehension,
 * gaps, order of lines, phrase meaning) with a check and a summary; no published exercises — no button.
 */
export function MediaScreen({ id }: { id: string }) {
  const { bff, nav } = useApp();
  const { t } = useI18n();
  const item = useLoad(() => bff.mediaItem(id), [id]);
  const { start, sheet } = useStartSession();
  const d = item.data;
  return (
    <>
      {/* в шапке — раздел, название материала — h1 ниже (без повтора) */}
      <Bar title={t("pr.tab.media")} onBack={nav.back} plainTitle />
      <main className="scroll" data-testid="media-item">
        {item.loading && !d ? (
          <div className="pad"><Skeleton lines={4} /></div>
        ) : item.error && !d ? (
          <div className="pad stack tight">
            <div className="card err"><p className="sub ink">{item.error}</p></div>
            <Btn variant="secondary" onClick={() => void item.reload()}>{t("c.retry")}</Btn>
          </div>
        ) : d ? (
          <MediaBody d={d} />
        ) : null}
      </main>
      {d?.exercises_available ? (
        <div className="foot" data-testid="md-exercises">
          <ErrorLine text={start.error} />
          <Btn busy={start.busy} onClick={() => void start.run({ kind: "media", id: d.asset_id })} data-testid="md-exercises-start">
            <Icon name="lessons" size={18} />
            {t("md.exercisesStart")}
          </Btn>
          <p className="sub small center">{t("md.exercisesNote")}</p>
        </div>
      ) : null}
      {sheet}
    </>
  );
}

function MediaBody({ d }: { d: MediaDetail }) {
  const { t, l } = useI18n();
  const translation = d.allowed_uses.includes("translation");
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const toggle = (i: number) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    return n;
  });
  return (
    <div className="pad stack loose">
      <div className="stack tight">
        <div className="cap hrow">
          <Icon name={MEDIA_ICON[d.type]} size={16} />
          {t(`md.type.${d.type}` as MessageKey)} · {d.level} · {t("md.duration", { n: Math.round(d.duration_s) })}
        </div>
        <h1 className="h1">{l(d.title)}</h1>
        <p className="sub" data-testid="md-source">{t("md.source", { src: d.source_label })}</p>
        {d.attribution ? <p className="sub small" data-testid="md-attribution">{t("md.attribution", { text: d.attribution })}</p> : null}
      </div>

      <Player d={d} />

      <section className="stack tight" aria-labelledby="md-tr">
        <h2 className="sec" id="md-tr">{t("md.transcript")}</h2>
        {d.transcript ? (
          <>
            {translation ? <p className="sub small">{t("md.transcriptHint")}</p> : null}
            <div className="card" data-testid="md-transcript">
              {d.transcript.map((line, i) =>
                translation ? (
                  <button type="button" className="tr" key={i} onClick={() => toggle(i)} aria-expanded={open.has(i)} data-testid={`md-line-${i}`}>
                    <span className="sp" lang="en">{line.speaker}</span>
                    <span className="line-en" lang="en">{line.text_en}</span>
                    {open.has(i) && line.gloss ? <span className="gloss" data-testid={`md-gloss-${i}`}>{l(line.gloss)}</span> : null}
                  </button>
                ) : (
                  <div className="tr" key={i}>
                    <span className="sp" lang="en">{line.speaker}</span>
                    <span className="line-en" lang="en">{line.text_en}</span>
                  </div>
                ),
              )}
            </div>
          </>
        ) : (
          <p className="sub" data-testid="md-no-transcript">{t("md.noTranscript")}</p>
        )}
      </section>

      {d.phrases.length ? (
        <section className="stack tight" aria-labelledby="md-ph">
          <h2 className="sec" id="md-ph">{t("md.phrases")}</h2>
          <ul className="list">
            {d.phrases.map((p, i) => (
              <li className="row" key={i}>
                <span className="t">
                  <b lang="en">{p.en}</b>
                  <span>{l(p.gloss)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

    </div>
  );
}

function Player({ d }: { d: MediaDetail }) {
  const { bff } = useApp();
  const { t, fmt } = useI18n();
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const loading = useDelayedFlag(waiting);
  const [error, setError] = useState<string | null>(null);
  const [noVoice, setNoVoice] = useState(false);
  const audioFile = useRef<PreloadedFile | null>(null);
  const signal = useRef({ stopped: false });
  // licence first: without `listen` there is neither the file nor speech synthesis of the transcript (review of sprint 3)
  const canListen = d.allowed_uses.includes("listen");
  const file = canListen && d.has_audio;
  const tts = canListen && !d.has_audio && !!d.transcript?.length;
  /** the lines to speak, each in its speaker's voice */
  const lines = useMemo(
    () => (tts && d.transcript ? d.transcript.map((x) => ({ text: x.text_en, variant: (d.voices[x.speaker] ?? "en-GB") as EnVariant })) : []),
    [tts, d],
  );

  const stop = () => {
    signal.current.stopped = true;
    stopSpeech();
    setWaiting(false);
    setBusy(false);
    setPlaying(false);
  };
  useEffect(() => {
    // ready before the tap — it then plays right in the tap handler: the file, or the first line without a file
    if (file) audioFile.current = preloadAudio(() => bff.mediaAudio(d.asset_id), d.asset_id);
    if (lines[0]) void prefetchSpeech(lines[0].text, lines[0].variant);
    return () => {
      signal.current.stopped = true;
      stopSpeech();
      audioFile.current?.dispose();
      audioFile.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The file on the shared element: loaded — it plays right in the tap; still loading (or the preload failed — loaded
   *  again) — the element is unlocked in the tap and plays the file once it arrives. */
  const playFile = () => {
    const f = (audioFile.current ??= preloadAudio(() => bff.mediaAudio(d.asset_id), d.asset_id));
    const sig = { stopped: false };
    signal.current = sig;
    setBusy(true);
    playUrl(f.src(), {
      onStart: () => {
        if (sig.stopped) return;
        setBusy(false);
        setPlaying(true);
      },
    })
      .catch((e: unknown) => {
        if (!sig.stopped) setError(e instanceof Error && e.name === "ApiError" ? errorText(e, t, fmt.mmss) : t("md.audioError"));
      })
      .finally(() => {
        if (signal.current !== sig) return;
        setBusy(false);
        setPlaying(false);
      });
  };

  /** The lines one after another through the shared audio element. The first playSpeech() runs synchronously in the tap
   *  handler (iOS unlocks the element only in a gesture); the next line is fetched while the current one sounds. */
  const playLines = () => {
    const sig = { stopped: false };
    signal.current = sig;
    setNoVoice(false);
    setPlaying(true);
    const run = async () => {
      for (let i = 0; i < lines.length && !sig.stopped; i++) {
        const line = lines[i]!;
        const next = lines[i + 1];
        setWaiting(true);
        await playSpeech(line.text, line.variant, {
          onStart: () => {
            if (sig.stopped) return;
            setWaiting(false);
            if (next) void prefetchSpeech(next.text, next.variant);
          },
        });
      }
    };
    run()
      .catch((e: unknown) => {
        if (sig.stopped) return;
        if (e instanceof SpeechUnavailableError) setNoVoice(true);
        else setError(errorText(e, t, fmt.mmss));
      })
      .finally(() => {
        if (signal.current !== sig) return;
        setWaiting(false);
        setPlaying(false);
      });
  };

  /** Synchronous in the tap handler (iOS). */
  const play = () => {
    if (!file && !tts) return;
    setError(null);
    if (file) playFile();
    else playLines();
  };

  if (!canListen) return <p className="sub" data-testid="md-no-listen">{t("md.noListen")}</p>;
  if (!file && !tts) return null;
  return (
    <div className="card stack tight" data-testid="md-player">
      <div className="hrow between">
        <Btn variant={playing ? "secondary" : "primary"} busy={busy} onClick={() => (playing ? stop() : play())} data-testid="md-play">
          <Icon name={playing ? "stop" : "play"} size={18} />
          {playing ? t("md.stop") : t("md.listen")}
        </Btn>
      </div>
      {tts ? (
        <p className="sub small tts" data-testid="md-tts">
          <Pill tone="warn">{t("md.tts")}</Pill>
          {t("md.ttsNote")}
        </p>
      ) : null}
      {loading && playing ? <p className="sub small" role="status" data-testid="md-loading">{t("sp.loading")}</p> : null}
      {noVoice ? <p className="sub small" role="status" data-testid="md-no-voice">{t("md.noVoice")}</p> : null}
      <ErrorLine text={error} />
    </div>
  );
}
