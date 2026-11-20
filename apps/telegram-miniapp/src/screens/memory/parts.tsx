import type { CardKind, CardStatus, CardStrength } from "@tilhero/contracts/bff";
import type { GlossarySource } from "@tilhero/contracts/content";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../../api/errors";
import { STRENGTH_BARS } from "../../domain/memory";
import { useI18n, type MessageKey } from "../../i18n";
import { useDelayedFlag } from "../../state/hooks";
import { haptic, playSpeech, prefetchSpeech, SpeechUnavailableError, stopSpeech, type EnVariant, type SpeechSpeed } from "../../tg";
import { Icon } from "../../ui/Icon";
import { cx, Pill } from "../../ui/kit";
import { showToast } from "../../ui/overlays";

/** Strength of a card: bars AND a word (never colour alone); the full phrase for screen readers. */
export function Strength({ value, compact }: { value: CardStrength; compact?: boolean }) {
  const { t } = useI18n();
  const n = STRENGTH_BARS[value];
  const word = t(`mem.strength.${value}` as MessageKey);
  return (
    <span className={cx("strength", `s-${value}`, compact && "compact")} role="img" aria-label={t("mem.strength.aria", { s: word })} data-testid="strength" data-strength={value}>
      <span className="bars" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <i key={i} className={cx(i <= n && "on")} />
        ))}
      </span>
      <span className="w" aria-hidden="true">{word}</span>
    </span>
  );
}

export function KindPill({ kind }: { kind: CardKind }) {
  const { t } = useI18n();
  return <Pill tone="mute">{t(`mem.kind.${kind}` as MessageKey)}</Pill>;
}

const STATUS_TONE: Record<CardStatus, "ok" | "warn" | "mute" | undefined> = { new: "mute", learning: undefined, review: undefined, known: "ok", frozen: "warn" };
export function StatusPill({ status }: { status: CardStatus }) {
  const { t } = useI18n();
  return (
    <Pill tone={STATUS_TONE[status]}>
      {status === "known" ? <Icon name="check" size={14} stroke={3} /> : null}
      {t(`mem.status.${status}` as MessageKey)}
    </Pill>
  );
}

/** Where the translation comes from: the course dictionary, a methodologist, the AI (marked, checked later). */
export function GlossSourceNote({ source, unreviewed }: { source: GlossarySource | null; unreviewed?: boolean }) {
  const { t } = useI18n();
  if (!source) return null;
  return (
    <p className={cx("sub small gl-src", source === "ai" && "ai")} data-testid="gloss-source" data-source={source}>
      {source === "ai" ? <Icon name="spark" size={14} /> : <Icon name="book" size={14} />}
      {source === "ai" ? (unreviewed === false ? t("mem.src.aiChecked") : t("mem.src.ai")) : t(`mem.src.${source}` as MessageKey)}
    </p>
  );
}

/**
 * «Озвучить»: server speech (tg/tts.ts — MP3 of the BFF, iOS unlock in the tap, the device voice as a fallback). The
 * phrase is fetched when the button shows, so the first tap plays at once. Children hear it slower.
 */
export function SpeakButton(props: { text: string; voice?: EnVariant; label?: string; kid?: boolean; testId?: string; big?: boolean; className?: string }) {
  const { t, fmt } = useI18n();
  const [phase, setPhase] = useState<"idle" | "waiting" | "playing">("idle");
  const loading = useDelayedFlag(phase === "waiting");
  const alive = useRef(true);
  const voice = props.voice ?? "en-GB";
  const speed: SpeechSpeed = props.kid ? "slow" : "normal";
  useEffect(() => {
    alive.current = true;
    if (props.text) void prefetchSpeech(props.text, voice, speed);
    return () => {
      alive.current = false;
    };
  }, [props.text, voice, speed]);
  useEffect(() => () => stopSpeech(), []);
  /** Synchronous in the tap handler (iOS). */
  const play = () => {
    if (phase !== "idle" || !props.text) return;
    haptic.impact("light");
    setPhase("waiting");
    playSpeech(props.text, voice, {
      speed,
      onStart: () => {
        if (alive.current) setPhase("playing");
      },
    })
      .catch((e: unknown) => showToast(e instanceof SpeechUnavailableError ? t("mem.noVoice") : errorText(e, t, fmt.mmss)))
      .finally(() => {
        if (alive.current) setPhase("idle");
      });
  };
  const label = props.label ?? t("mem.listen");
  if (props.big) {
    return (
      <button
        type="button"
        className={cx("listen-btn", phase === "playing" && "playing", props.className)}
        onClick={play}
        disabled={phase !== "idle"}
        aria-busy={phase === "waiting"}
        aria-label={label}
        data-testid={props.testId ?? "speak"}
      >
        <Icon name={phase === "playing" ? "volume" : "play"} size={34} />
      </button>
    );
  }
  return (
    <button type="button" className={cx("lnk speak", props.className)} onClick={play} disabled={phase !== "idle"} aria-busy={phase === "waiting"} data-testid={props.testId ?? "speak"}>
      <Icon name="volume" size={18} />
      {loading ? t("sp.loading") : label}
    </button>
  );
}
