import { useEffect, useRef, useState } from "react";
import { canTypeFreeText, chatBubbles, learnerLine, TEXT_MAX, type Bubble, type RoleplayStep } from "../../domain/lessons";
import { useI18n } from "../../i18n";
import { haptic, loadVoices, pickEnglishVoice, speak, type EnVariant } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, cx } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { StepFrame, type StepProps } from "./steps";

export interface Character {
  name: string;
  role: { ru: string; uz: string } | null;
  voice: EnVariant;
}

/** Characters met in this scene (history turns carry only the id). */
export type Cast = Map<string, Character>;

/**
 * The roleplay as a chat (AT-43): bubbles of the character (name, role, «Прослушать» by the device voice, translation
 * on tap), the learner's lines, the clarifying question after an unclear answer; the replies as buttons (always), a text
 * field only when free text is allowed (adults and teens, AI available, fewer than two unclear answers on the node; never
 * a child), «Подсказка» marked as counted.
 */
export function RoleplayView({ api, step, kid, top, error, cast }: StepProps<RoleplayStep> & { cast: Cast }) {
  const { t, l } = useI18n();
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const sending = api.st.phase === "sending";
  const pending = sending && api.st.pending?.stepId === step.step_id ? api.st.pending : null;
  const bubbles: Bubble[] = chatBubbles(step, api.st.chat, api.st.reply);
  if (pending) bubbles.push({ id: "pending", who: "learner", text: learnerLine(step, pending.body), gloss: null, characterId: null, pending: true });
  const typing = canTypeFreeText(step, kid);
  const choicesOnly = !kid && step.free_text_allowed && step.unclear_attempts >= 2;
  const value = text.trim();

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [bubbles.length, step.step_id]);
  // a successful send clears the field; a lost one keeps it (the same text is re-sent)
  const prevPhase = useRef(api.st.phase);
  useEffect(() => {
    if (prevPhase.current === "sending" && api.st.phase === "ready" && !api.st.error) setText("");
    prevPhase.current = api.st.phase;
  }, [api.st.phase, api.st.error]);

  const send = (body: { choice_id: string } | { text: string }) => {
    haptic.selection();
    void api.answer(body);
  };
  const hint = async () => {
    setAsking(true);
    try {
      await api.hint();
    } finally {
      setAsking(false);
    }
  };

  const foot = typing ? (
    <div className="stack tight">
      <label className="lb" htmlFor="rp-in">
        {t("pl.rp.orType")}
      </label>
      <div className="rp-input">
        <textarea
          id="rp-in"
          className="inp"
          lang="en"
          rows={1}
          maxLength={TEXT_MAX}
          placeholder={t("pl.rp.placeholder")}
          aria-label={t("pl.rp.inputLabel")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={sending}
          data-testid="rp-input"
        />
        <button type="button" className="rp-send" aria-label={t("pl.rp.send")} disabled={!value || sending} onClick={() => send({ text: value })} data-testid="rp-send">
          {sending ? <span className="spin" aria-hidden="true" /> : <Icon name="send" size={20} />}
        </button>
      </div>
      {text.length > TEXT_MAX - 100 ? <p className="rp-count" aria-live="polite">{t("pl.rp.count", { n: text.length, m: TEXT_MAX })}</p> : null}
    </div>
  ) : null;

  return (
    <StepFrame top={top} error={error} foot={foot} testId="pl-roleplay">
      <ChatList bubbles={bubbles} cast={cast} />
      {choicesOnly ? (
        <p className="sub" role="status" data-testid="rp-choices-only">{t("pl.rp.choicesOnly")}</p>
      ) : null}
      <section className="stack tight" aria-labelledby="rp-choose">
        <h2 className="sec" id="rp-choose">{kid ? t("pl.rp.chooseKid") : t("pl.rp.choose")}</h2>
        <div className="choices" data-testid="rp-choices">
          {step.choices.map((c) => (
            <button type="button" key={c.choice_id} className="choice" lang="en" disabled={sending} onClick={() => send({ choice_id: c.choice_id })} data-testid={`rp-choice-${c.choice_id}`}>
              <Icon name="chat" size={18} />
              <span>{c.text_en}</span>
            </button>
          ))}
        </div>
      </section>
      {step.hint_available ? (
        api.st.hint ? (
          <div className="card warn stack tight" data-testid="rp-hint">
            <p className="sub ink">{l(api.st.hint)}</p>
            <p className="sub small">{t("pl.rp.hintNote")}</p>
          </div>
        ) : (
          <Btn variant="link" busy={asking} disabled={sending} onClick={() => void hint()} data-testid="rp-hint-btn">
            <Icon name="spark" size={18} />
            {t("pl.rp.hint")} · <span className="sub small">{t("pl.rp.hintCounted")}</span>
          </Btn>
        )
      ) : null}
      <div ref={end} />
    </StepFrame>
  );
}

/** The chat bubbles (also shown above the outcome of the scene). */
export function ChatList({ bubbles, cast }: { bubbles: readonly Bubble[]; cast: Cast }) {
  return (
    <div className="chat" data-testid="rp-chat" aria-live="polite">
      {bubbles.map((b) => (b.who === "learner" ? <LearnerBubble key={b.id} b={b} /> : <CharacterBubble key={b.id} b={b} who={b.characterId ? cast.get(b.characterId) : undefined} />))}
    </div>
  );
}

function LearnerBubble({ b }: { b: Bubble }) {
  const { t } = useI18n();
  return (
    <div className={cx("bub me", b.pending && "pending")} data-testid="rp-me">
      <span className="sr">{t("pl.rp.you")}: </span>
      <span lang="en">{b.text}</span>
    </div>
  );
}

function CharacterBubble({ b, who }: { b: Bubble; who: Character | undefined }) {
  const { t, l } = useI18n();
  const [gloss, setGloss] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const listen = async () => {
    if (speaking) return;
    setSpeaking(true);
    try {
      const voice = pickEnglishVoice(await loadVoices(1500), who?.voice);
      if (!voice) {
        showToast(t("pl.rp.noVoice"));
        return;
      }
      await speak(b.text, { voice, variant: who?.voice ?? "en-GB" });
    } catch {
      showToast(t("pl.rp.noVoice"));
    } finally {
      setSpeaking(false);
    }
  };
  return (
    <div className={cx("bub ch", b.clarification && "clar")} data-testid={b.clarification ? "rp-clarify" : "rp-ch"}>
      {who ? (
        <span className="who">
          <span lang="en" className="nm">{who.name}</span>
          {b.clarification ? <span> · {t("pl.rp.clarifies")}</span> : who.role ? <span> · {l(who.role)}</span> : null}
        </span>
      ) : null}
      <span className="en" lang="en">{b.text}</span>
      {gloss && b.gloss ? <span className="gl" data-testid="rp-gloss">{l(b.gloss)}</span> : null}
      <span className="bub-acts">
        <button type="button" className="lnk" onClick={() => void listen()} disabled={speaking} data-testid="rp-listen">
          <Icon name="volume" size={16} />
          {t("pl.rp.listen")}
        </button>
        {b.gloss ? (
          <button type="button" className="lnk" aria-expanded={gloss} onClick={() => setGloss(!gloss)} data-testid="rp-translate">
            {gloss ? t("pl.rp.hideTranslate") : t("pl.rp.translate")}
          </button>
        ) : null}
      </span>
    </div>
  );
}
