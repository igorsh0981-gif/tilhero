import { useI18n, type MessageKey } from "../i18n";
import { backButtonStore, haptic, mainButtonStore, secondaryButtonStore, tgClose, useStoreTop } from "../tg";
import type { Tab } from "../state/nav";
import { Icon, type IconName } from "./Icon";
import { Spinner } from "./kit";

/** MainButton / SecondaryButton twin, rendered only outside Telegram (dev, e2e). */
export function MainBar() {
  const main = useStoreTop(mainButtonStore);
  const sec = useStoreTop(secondaryButtonStore);
  if (!main && !sec) return null;
  const inactive = !main || !!main.disabled || !!main.progress;
  return (
    <div className="mainbar" data-testid="mainbar">
      {sec && (
        <button className="mb mb-sec" type="button" onClick={() => sec.onClick()}>
          <span>{sec.text}</span>
        </button>
      )}
      {main && (
        <button
          className={main.variant === "danger" ? "mb mb-main danger" : "mb mb-main"}
          type="button"
          data-testid="main-button"
          aria-disabled={inactive}
          onClick={() => {
            if (inactive) return;
            haptic.impact("medium");
            main.onClick();
          }}
        >
          {main.progress && <Spinner />}
          <span>{main.text}</span>
        </button>
      )}
    </div>
  );
}

/** Emulates the native Telegram header (Back / Close) outside Telegram. */
export function DevChrome() {
  const { t } = useI18n();
  const back = useStoreTop(backButtonStore);
  return (
    <header className="chrome">
      {back ? (
        <button className="chrome-l" type="button" onClick={() => back.onBack()}>
          <Icon name="chevL" size={22} />
          <span>{t("tg.back")}</span>
        </button>
      ) : (
        <button className="chrome-l" type="button" onClick={() => tgClose()}>
          <Icon name="x" size={18} />
          <span>{t("tg.close")}</span>
        </button>
      )}
      <div className="chrome-c">
        <b>TilHero</b>
        <small>{t("tg.miniapp")}</small>
      </div>
      <span className="chrome-dev" aria-hidden="true">
        DEV
      </span>
    </header>
  );
}

const TAB_ITEMS: ReadonlyArray<[Tab, IconName, MessageKey]> = [
  ["home", "spark", "tab.home"],
  ["catalog", "ticket", "tab.catalog"],
  ["watch", "radar", "tab.watch"],
  ["news", "news", "tab.news"],
  ["profile", "user", "tab.profile"],
];

export function TabBar(props: { current: Tab; atRoot: boolean; onTab: (t: Tab) => void; critical: number }) {
  const { t } = useI18n();
  return (
    <nav className="tabbar" aria-label={t("tab.aria")}>
      {TAB_ITEMS.map(([id, icon, key]) => {
        const active = props.current === id;
        return (
          <button
            key={id}
            className="tab"
            type="button"
            aria-current={active ? (props.atRoot ? "page" : "true") : undefined}
            onClick={() => {
              haptic.selection();
              props.onTab(id);
            }}
          >
            <span className="tab-i">
              <Icon name={icon} size={22} />
            </span>
            {t(key)}
            {id === "watch" && props.critical > 0 && (
              <span className="tab-badge" aria-label={t("tab.critBadge", { n: props.critical })}>
                {props.critical}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

export function NetBanner({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="net" role="status" data-testid="net-banner">
      <Icon name="wifiOff" size={18} />
      <span>{t("net.off")}</span>
      <button type="button" onClick={onRetry}>
        {t("net.retry")}
      </button>
    </div>
  );
}
