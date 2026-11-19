import type { MediaDetail } from "@tilhero/contracts/bff";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { loadVoices, pickEnglishVoice, speakLines, stopSpeaking, type EnVariant } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Pill, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";
import { MEDIA_ICON } from "./Practice";

/**
 * A media item (APP-MEDIA-01, AT-29): source and attribution (plain text, never a link), listening — the audio file from
 * the BFF or, without a file, device speech synthesis line by line (marked «синтез речи»), the transcript with the
 * translation on tap (only when the licence allows it), phrases; exercises arrive with the lessons.
 */
export function MediaScreen({ id }: { id: string }) {
  const { bff, nav } = useApp();
  const { t, l } = useI18n();
  const item = useLoad(() => bff.mediaItem(id), [id]);
  const d = item.data;
  return (
    <>
      <Bar title={d ? l(d.title) : t("pr.tab.media")} onBack={nav.back} />
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

      <div className="card pen hrow" data-testid="md-exercises">
        <Icon name="lessons" size={20} />
        <span className="sub ink grow">{t("md.exercises")}</span>
      </div>
    </div>
  );
}

function Player({ d }: { d: MediaDetail }) {
  const { bff } = useApp();
  const { t, fmt } = useI18n();
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noVoice, setNoVoice] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const signal = useRef({ stopped: false });
  // licence first: without `listen` there is neither the file nor speech synthesis of the transcript (review of sprint 3)
  const canListen = d.allowed_uses.includes("listen");
  const file = canListen && d.has_audio;
  const tts = canListen && !d.has_audio && !!d.transcript?.length;

  const stop = () => {
    signal.current.stopped = true;
    audio.current?.pause();
    stopSpeaking();
    setPlaying(false);
  };
  useEffect(
    () => () => {
      signal.current.stopped = true;
      audio.current?.pause();
      stopSpeaking();
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );

  const play = async () => {
    if (!file && !tts) return;
    setError(null);
    setBusy(true);
    try {
      if (file) {
        if (!url.current) url.current = URL.createObjectURL(await bff.mediaAudio(d.asset_id));
        const a = audio.current ?? new Audio(url.current);
        audio.current = a;
        a.onended = () => setPlaying(false);
        a.currentTime = 0;
        await a.play();
        setPlaying(true);
      } else if (tts && d.transcript) {
        const voices = await loadVoices(1500);
        if (!pickEnglishVoice(voices)) {
          setNoVoice(true);
          return;
        }
        signal.current = { stopped: false };
        setPlaying(true);
        const lines = d.transcript.map((x) => ({ text: x.text_en, variant: (d.voices[x.speaker] ?? "en-GB") as EnVariant }));
        void speakLines(lines, voices, signal.current).finally(() => setPlaying(false));
      }
    } catch (e) {
      setError(e instanceof Error && e.name === "ApiError" ? errorText(e, t, fmt.mmss) : t("md.audioError"));
    } finally {
      setBusy(false);
    }
  };

  if (!canListen) return <p className="sub" data-testid="md-no-listen">{t("md.noListen")}</p>;
  if (!file && !tts) return null;
  return (
    <div className="card stack tight" data-testid="md-player">
      <div className="hrow between">
        <Btn variant={playing ? "secondary" : "primary"} busy={busy} onClick={() => (playing ? stop() : void play())} data-testid="md-play">
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
      {noVoice ? <p className="sub small" role="status">{t("md.noVoice")}</p> : null}
      <ErrorLine text={error} />
    </div>
  );
}
