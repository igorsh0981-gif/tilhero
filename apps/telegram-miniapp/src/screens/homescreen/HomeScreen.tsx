/**
 * 9.4 «Добавить на главный экран»: строка в Профиле и мягкая карточка на Главной.
 * Статус (Bot API 8.0+) запрашивается один раз за запуск и общий для Профиля и Главной; после добавления — "added".
 * unsupported / вне Telegram / клиент < 8.0 — ни строки, ни карточки.
 */
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { useI18n } from "../../i18n";
import { PromptStore, countLaunch, promptLaunch, shouldShowPrompt, SNOOZE_MS } from "../../state/homeScreenPrompt";
import { addToHomeScreen, haptic, homeScreenStatus, type HomeScreenStatus } from "../../tg";
import { Icon } from "../../ui/Icon";
import { LRow } from "../../ui/kit";
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

let promptStore: PromptStore | null = null;
const prompts = () => (promptStore ??= new PromptStore());
export function setPromptStoreForTests(s: PromptStore | null): void {
  promptStore = s;
}

/** Системный запрос; «added» — тост и больше никаких предложений. Возвращает true, если иконка точно добавлена. */
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
  showToast(toast, "phone");
  void prompts().update((p) => ({ ...p, done: true }));
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
      <div className="lrow static wrap" data-testid="hs-row-added">
        <span className="lrow-i">
          <Icon name="phone" size={18} />
        </span>
        <span className="lrow-t">
          <b>{t("hs.row.added")}</b>
          <small>{t("hs.row.addedSub")}</small>
        </span>
        <span className="lrow-v hs-ok" aria-hidden="true">
          <Icon name="check" size={16} />
        </span>
      </div>
    );
  }
  return (
    <LRow
      icon="phone"
      title={t("hs.row")}
      sub={t("hs.row.sub")}
      disabled={busy}
      testId="hs-row"
      wrap
      onClick={() => {
        setBusy(true);
        void requestAddToHomeScreen(t("hs.toast")).finally(() => setBusy(false));
      }}
    />
  );
}

/* ---------- Главная: мягкая карточка ---------- */
export function HomeScreenCard() {
  const { t } = useI18n();
  const s = useHomeScreenStatus();
  const titleId = useId();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (s === null || promptLaunch.dismissed) return;
    let alive = true;
    void countLaunch(prompts()).then(async (st) => {
      if (!alive || promptLaunch.dismissed) return;
      // уже показана в этом запуске (вернулись на Главную) — показываем, не засчитывая второй показ
      if (promptLaunch.counted) return setVisible(s === "missed" || s === "unknown");
      if (!shouldShowPrompt(st, s)) return;
      promptLaunch.counted = true;
      setVisible(true);
      await prompts().update((p) => ({ ...p, shown: p.shown + 1 }));
    });
    return () => {
      alive = false;
    };
  }, [s]);

  if (!visible || (s !== "missed" && s !== "unknown")) return null;
  const hide = () => {
    promptLaunch.dismissed = true;
    setVisible(false);
  };
  return (
    <section className="hs-card" aria-labelledby={titleId} data-testid="hs-card">
      <span className="hs-ic" aria-hidden="true">
        <Icon name="phone" size={20} />
      </span>
      <div className="hs-b">
        <h2 id={titleId}>{t("hs.card.t")}</h2>
        <p>{t("hs.card.p")}</p>
        <div className="hs-a">
          <button
            className="btn btn-sm btn-soft"
            type="button"
            disabled={busy}
            data-testid="hs-card-add"
            onClick={() => {
              setBusy(true);
              void requestAddToHomeScreen(t("hs.toast")).then((ok) => {
                setBusy(false);
                if (ok) hide();
              });
              // «Не сейчас» остаётся доступной всегда — даже пока Telegram показывает свой диалог
            }}
          >
            {t("hs.card.add")}
          </button>
          <button
            className="btn btn-sm btn-ghost"
            type="button"
            data-testid="hs-card-later"
            onClick={() => {
              hide();
              void prompts().update((p) => ({ ...p, snoozed_until: Date.now() + SNOOZE_MS }));
            }}
          >
            {t("hs.card.later")}
          </button>
        </div>
      </div>
    </section>
  );
}
