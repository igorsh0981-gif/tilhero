/**
 * «На главный экран» (Bot API 8.0): строка в Профиле. Перенесено из aievent (src/screens/homescreen/HomeScreen.tsx,
 * спринт 9.4): общий статус на запуск, системный запрос, перепроверка статуса, тост после добавления. Изменено под
 * TilHero: тексты RU/UZ, строка в стиле тетради (row), без карточки-предложения на Главной.
 * Статус запрашивается при первом открытии Профиля и общий на весь запуск; после добавления — "added".
 * unsupported / вне Telegram / клиент < 8.0 / нет addToHomeScreen — строки нет.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useI18n } from "../../i18n";
import { addToHomeScreen, haptic, homeScreenStatus, type HomeScreenStatus } from "../../tg";
import { Icon } from "../../ui/Icon";
import { showToast } from "../../ui/overlays";

/* ---------- shared status (null — ещё не известен) ---------- */
let status: HomeScreenStatus | null = null;
let loading: Promise<HomeScreenStatus> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function setStatus(s: HomeScreenStatus): void {
  status = s;
  emit();
}
function loadStatus(): Promise<HomeScreenStatus> {
  loading ??= homeScreenStatus().then((s) => {
    setStatus(s);
    return s;
  });
  return loading;
}
export function resetHomeScreenForTests(): void {
  status = null;
  loading = null;
  emit();
}

export function useHomeScreenStatus(): HomeScreenStatus | null {
  const s = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => status,
    () => null,
  );
  useEffect(() => {
    void loadStatus();
  }, []);
  return s;
}

/** Системный запрос; «added» — тост. Возвращает true, если иконка точно добавлена. */
export async function requestAddToHomeScreen(toast: string): Promise<boolean> {
  haptic.impact("light");
  let result = await addToHomeScreen();
  if (result === "unknown") {
    // homeScreenAdded приходит не на всех устройствах — уточняем статус
    const s = await homeScreenStatus();
    if (s === "added") result = "added";
    else setStatus(s);
  }
  if (result !== "added") return false;
  setStatus("added");
  haptic.notify("success");
  showToast(toast);
  return true;
}

/* ---------- Профиль: строка ---------- */
export function HomeScreenRow() {
  const { t } = useI18n();
  const s = useHomeScreenStatus();
  const [busy, setBusy] = useState(false);
  if (s === null || s === "unsupported") return null;
  if (s === "added") {
    return (
      <div className="row" data-testid="hs-row-added">
        <span className="t">
          <b>{t("hs.row")}</b>
        </span>
        <span className="v ok">
          <Icon name="check" size={16} stroke={2.4} />
          {t("hs.row.added")}
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="row"
      disabled={busy}
      aria-busy={busy || undefined}
      data-testid="hs-row"
      onClick={() => {
        setBusy(true);
        void requestAddToHomeScreen(t("hs.toast")).finally(() => setBusy(false));
      }}
    >
      <span className="t">
        <b>{t("hs.row")}</b>
        <span>{t("hs.row.sub")}</span>
      </span>
      <Icon name="plus" size={18} stroke={2} />
    </button>
  );
}
