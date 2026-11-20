import type { GameSettings } from "@tilhero/contracts/bff";
import { useState } from "react";
import { errorText } from "../../api/errors";
import { prefersReducedMotion } from "../../domain/game";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { ErrorLine, Skeleton, ToggleRow } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { GameError } from "./parts";

/**
 * The motivation settings (APP-GAME-07): the automatic freeze of a missed day, hidden quests of the day, quiet
 * celebrations (children have them by default), notifications about badges and the hero (a saved streak is always told).
 * Each switch is saved at once (PATCH /v1/game/settings); a failure puts it back. None of them touches learning.
 */
export function GameSettingsScreen() {
  const { bff, nav, session } = useApp();
  const { t, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const res = useLoad<GameSettings>(() => bff.gameSettings(), [session.learner.learner_id]);
  const [saving, setSaving] = useState<keyof GameSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = res.data;
  const reduced = prefersReducedMotion();

  const save = async (patch: Partial<GameSettings>, field: keyof GameSettings) => {
    if (!s) return;
    const before = s;
    res.setData({ ...s, ...patch });
    setSaving(field);
    setError(null);
    try {
      res.setData(await bff.patchGameSettings(patch));
      showToast(t("game.set.saved"));
    } catch (e) {
      res.setData(before);
      setError(errorText(e, t, fmt.mmss));
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <Bar title={t("game.set.title")} onBack={nav.back} />
      <main className="scroll" data-testid="game-settings">
        {!s ? (
          res.loading ? (
            <div className="pad"><Skeleton lines={4} /></div>
          ) : (
            <GameError error={res.error} errorObj={res.errorObj} onRetry={() => void res.reload()} />
          )
        ) : (
          <div className="stack">
            <div className="pad">
              <div className="list">
                <ToggleRow
                  title={t("game.set.autoFreeze")}
                  note={kid ? t("game.set.autoFreezeNoteKid") : t("game.set.autoFreezeNote")}
                  checked={s.auto_freeze}
                  disabled={saving !== null}
                  onChange={(v) => void save({ auto_freeze: v }, "auto_freeze")}
                  testId="gs-auto-freeze"
                />
                <ToggleRow
                  title={t("game.set.hideQuests")}
                  note={t("game.set.hideQuestsNote")}
                  checked={s.quests_hidden}
                  disabled={saving !== null}
                  onChange={(v) => void save({ quests_hidden: v }, "quests_hidden")}
                  testId="gs-hide-quests"
                />
                <ToggleRow
                  title={t("game.set.quiet")}
                  note={reduced ? `${t("game.set.quietNote")} ${t("game.set.reduced")}` : t("game.set.quietNote")}
                  checked={s.celebrations === "quiet"}
                  disabled={saving !== null}
                  onChange={(v) => void save({ celebrations: v ? "quiet" : "full" }, "celebrations")}
                  testId="gs-quiet"
                />
                <ToggleRow
                  title={t("game.set.notif")}
                  note={kid ? t("game.set.notifNoteKid") : t("game.set.notifNote")}
                  checked={s.game_notifications}
                  disabled={saving !== null}
                  onChange={(v) => void save({ game_notifications: v }, "game_notifications")}
                  testId="gs-notif"
                />
              </div>
            </div>
            <div className="pad">
              <ErrorLine text={error} />
            </div>
            <div className="pad">
              <div className="card notice" role="note" data-testid="gs-learning">
                <Icon name="shield" size={20} />
                <p className="sub ink">{t("game.set.learning")}</p>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
