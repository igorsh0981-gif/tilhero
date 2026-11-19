import type { Localized } from "@tilhero/contracts/content";
import { useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction } from "../../state/hooks";
import { keyForDraft, type DraftKey } from "../../state/idempotency";
import { haptic } from "../../tg";
import { Btn, ErrorLine } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";

export const APPEAL_MAX = 500;

/**
 * «Оспорить оценку» (AT-47): the reason (≤ 500) goes to the methodologist; the original evaluation stays, a decision
 * creates a new version; the learner sees the state in the summary and gets a Telegram message. One Idempotency-Key per
 * text: a retry after a lost answer is the same appeal, an edited text — a new key.
 */
export function AppealScreen({ evaluationId, title }: { evaluationId: string; title: Localized }) {
  const { bff, nav, session } = useApp();
  const { t, l } = useI18n();
  const kid = session.learner.kind === "child";
  const [text, setText] = useState("");
  const key = useRef<DraftKey | null>(null);
  const value = text.trim();
  const send = useAction(async () => {
    key.current = keyForDraft(key.current, value);
    await bff.appeal(evaluationId, value, key.current.key);
    haptic.notify("success");
    showToast(t("ap.sent"));
    nav.back();
  });
  return (
    <>
      <Bar title={t("ap.title")} onBack={nav.back} />
      <main className="scroll" data-testid="appeal">
        <div className="pad stack">
          <p className="sub ink">{t("ap.text", { title: l(title) })}</p>
          {kid ? <p className="sub">{t("ap.kid")}</p> : null}
          <div>
            <label className="lb" htmlFor="ap-reason">{t("ap.label")}</label>
            <textarea
              id="ap-reason"
              className="inp"
              rows={5}
              maxLength={APPEAL_MAX}
              placeholder={t("ap.placeholder")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              data-testid="ap-reason"
            />
            <p className="rp-count" aria-live="polite">{t("ap.count", { n: text.length, m: APPEAL_MAX })}</p>
          </div>
          <p className="sub small">{t("ap.window")}</p>
        </div>
      </main>
      <div className="foot">
        <ErrorLine text={send.error} />
        <Btn busy={send.busy} disabled={!value} onClick={() => void send.run()} data-testid="ap-send">
          {t("ap.send")}
        </Btn>
      </div>
    </>
  );
}
