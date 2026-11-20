import type { LessonStep } from "@tilhero/contracts/bff";
import { pronunciationAccess } from "../../domain/memory";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Btn } from "../../ui/kit";
import { StepFrame, type StepProps } from "../lessons/steps";
import { ReadingText } from "./ReadingText";

/** The «reading» step of a reading session (bff.ts LessonStep type "reading"): the text with the translation by tap and
 *  the sound, «К вопросам» → the questions (items graded later), then the summary (practice only). */
export function ReadingStepView({ api, step, top, error }: StepProps<Extract<LessonStep, { type: "reading" }>>) {
  const { bff, session } = useApp();
  const { t, l } = useI18n();
  const ov = useLoad(() => bff.memoryOverview(true).catch(() => null), [session.learner.learner_id]);
  const busy = api.st.phase === "sending" || api.st.phase === "loading" || api.st.phase === "finishing";
  return (
    <StepFrame
      top={top}
      error={error}
      testId="pl-reading"
      foot={
        <Btn busy={busy} onClick={() => void api.answer({})} data-testid="pl-next">
          {t("rd.toQuestions")}
        </Btn>
      }
    >
      <h2 className="h2">{l(step.reading.title)}</h2>
      <p className="sub small">{t("rd.tapHint")}</p>
      <ReadingText reading={step.reading} access={pronunciationAccess(ov.data?.pronunciation, session.learner)} />
    </StepFrame>
  );
}
