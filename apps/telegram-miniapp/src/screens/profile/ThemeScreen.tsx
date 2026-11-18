import { useState } from "react";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { haptic, setThemePref, THEME_PREFS, themeStorageKind, useThemePref, type ThemePref } from "../../tg";
import { Opt } from "../../ui/kit";
import { Bar } from "../../ui/shell";

const NOTE: Record<ThemePref, MessageKey> = { system: "theme.systemNote", light: "theme.lightNote", dark: "theme.darkNote" };

/**
 * Profile → «Тема»: «Как в Telegram» (default), «Светлая», «Тёмная». Applied at once (the native header and background
 * of Telegram are repainted), kept in Telegram CloudStorage (6.9+) with a localStorage copy (src/tg/theme.ts).
 */
export function ThemeScreen() {
  const { nav } = useApp();
  const { t } = useI18n();
  const pref = useThemePref();
  const [where] = useState(themeStorageKind);
  const choose = (p: ThemePref) => {
    if (p === pref) return;
    haptic.selection();
    void setThemePref(p);
  };
  return (
    <>
      <Bar title={t("theme.title")} onBack={nav.back} />
      <main className="scroll" data-testid="theme-screen">
        <div className="pad stack">
          <div className="opts" role="group" aria-label={t("theme.title")}>
            {THEME_PREFS.map((p) => (
              <Opt key={p} on={pref === p} title={t(`theme.${p}` as MessageKey)} note={t(NOTE[p])} onClick={() => choose(p)} testId={`theme-${p}`} />
            ))}
          </div>
          {where !== "none" ? <p className="sub small">{where === "cloud" ? t("theme.cloud") : t("theme.local")}</p> : null}
        </div>
      </main>
    </>
  );
}
