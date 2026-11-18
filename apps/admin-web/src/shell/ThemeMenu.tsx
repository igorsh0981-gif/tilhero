import { useI18n } from "../i18n";
import type { ThemeMode } from "../theme/mode";
import { Icon } from "../ui/Icon";
import { cx } from "../ui/kit";
import { MenuButton, MenuItem } from "../ui/overlays";

const ICON = { system: "monitor", light: "sun", dark: "moon" } as const;

export function ThemeMenu({ theme, setTheme, onDark, className }: { theme: ThemeMode; setTheme: (m: ThemeMode) => void; onDark?: boolean; className?: string }) {
  const { t } = useI18n();
  return (
    <MenuButton
      label={t("theme.label")}
      className={cx("icon-btn", onDark && "on-dark", className)}
      testId="theme-btn"
      render={(close) => (
        <>
          <div className="menu-h">{t("theme.label")}</div>
          {(["system", "light", "dark"] as const).map((m) => (
            <MenuItem key={m} icon={ICON[m]} checked={theme === m} onClick={() => { setTheme(m); close(); }} testId={`theme-${m}`}>
              {t(`theme.${m}`)}
            </MenuItem>
          ))}
        </>
      )}
    >
      <Icon name={ICON[theme]} />
    </MenuButton>
  );
}
