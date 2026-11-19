import type { LessonSession } from "@tilhero/contracts/bff";
import type { Localized } from "@tilhero/contracts/content";
import { useRef, useState } from "react";
import { newIdempotencyKey } from "../../api/client";
import { ApiError } from "../../api/errors";
import { playerMarker } from "../../domain/lessons";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction } from "../../state/hooks";
import { haptic } from "../../tg";
import { Btn, ErrorLine } from "../../ui/kit";
import { Sheet } from "../../ui/overlays";

export type StartWhat = { kind: "lesson"; id: string } | { kind: "scenario"; id: string } | { kind: "media"; id: string } | { kind: "review"; sessionId: string };

const whatKey = (w: StartWhat) => (w.kind === "review" ? `review:${w.sessionId}` : `${w.kind}:${w.id}`);

/**
 * Start a session (lesson, scenario «Разыграть», media «Упражнения», review of mistakes) → the player. One
 * Idempotency-Key per tap, reused when the answer was lost (the same session, not a second one). 409 SESSION_ACTIVE —
 * a sheet «Продолжить / Отменить и начать новое».
 */
export function useStartSession() {
  const { bff, nav } = useApp();
  const key = useRef<{ what: string; key: string } | null>(null);
  const [conflict, setConflict] = useState<{ sessionId: string; title: Localized | null; what: StartWhat } | null>(null);

  const call = (w: StartWhat, k: string): Promise<LessonSession> => {
    switch (w.kind) {
      case "lesson":
        return bff.startLesson(w.id, k);
      case "scenario":
        return bff.startScenario(w.id, k);
      case "media":
        return bff.startMedia(w.id, k);
      case "review":
        return bff.startReview(w.sessionId, k);
    }
  };

  const open = (sessionId: string, replace = false) => {
    playerMarker.set(sessionId);
    haptic.impact("medium");
    if (replace) nav.replace({ name: "player", sessionId });
    else nav.push({ name: "player", sessionId });
  };

  const start = useAction(async (w: StartWhat, opts: { replace?: boolean } = {}) => {
    const id = whatKey(w);
    if (key.current?.what !== id) key.current = { what: id, key: newIdempotencyKey() };
    try {
      const s = await call(w, key.current.key);
      key.current = null;
      open(s.session_id, opts.replace);
    } catch (e) {
      if (e instanceof ApiError && e.code === "SESSION_ACTIVE" && typeof e.details.session_id === "string") {
        key.current = null;
        const title = e.details.title && typeof e.details.title === "object" ? (e.details.title as Localized) : null;
        setConflict({ sessionId: e.details.session_id, title, what: w });
        return;
      }
      throw e;
    }
  });

  const resolve = useAction(async (choice: "continue" | "cancel") => {
    const c = conflict;
    if (!c) return;
    if (choice === "continue") {
      setConflict(null);
      open(c.sessionId);
      return;
    }
    try {
      await bff.cancelSession(c.sessionId);
    } catch (e) {
      // already finished or cancelled elsewhere — start the new one anyway
      if (!(e instanceof ApiError && (e.code === "SESSION_STATE" || e.code === "SESSION_NOT_FOUND"))) throw e;
    }
    setConflict(null);
    await start.run(c.what);
  });

  const sheet = conflict ? <ActiveSessionSheet title={conflict.title} busy={resolve.busy || start.busy} error={resolve.error} onChoose={(c) => void resolve.run(c)} onClose={() => setConflict(null)} /> : null;
  return { start, sheet, open };
}

function ActiveSessionSheet(props: { title: Localized | null; busy: boolean; error: string | null; onChoose: (c: "continue" | "cancel") => void; onClose: () => void }) {
  const { t, l } = useI18n();
  return (
    <Sheet title={t("as.title")} onClose={props.onClose} testId="active-session-sheet">
      <p className="sub ink">{t("as.text", { title: props.title ? l(props.title) : "—" })}</p>
      <ErrorLine text={props.error} />
      <div className="stack tight">
        <Btn busy={props.busy} onClick={() => props.onChoose("continue")} data-testid="as-continue">
          {t("as.continue")}
        </Btn>
        <Btn variant="dangerOutline" disabled={props.busy} onClick={() => props.onChoose("cancel")} data-testid="as-cancel-new">
          {t("as.cancelNew")}
        </Btn>
      </div>
    </Sheet>
  );
}
