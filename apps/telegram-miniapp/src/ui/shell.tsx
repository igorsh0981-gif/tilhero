import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import type { Tab } from "../state/nav";
import { TABS } from "../state/nav";
import { nativeBackButton, useBackButton } from "../tg";
import { Icon } from "./Icon";

/**
 * Top bar of the notebook (prototype .bar): back, title or logo, the bell of the notification center.
 * Inside Telegram the native BackButton replaces the in-app one.
 */
export function Bar(props: {
  title?: string;
  logo?: boolean;
  onBack?: (() => void) | null;
  bell?: { unread: number; onClick: () => void } | null;
  right?: ReactNode;
  /** the bar title is the page heading (h1) unless the screen has its own (onboarding: «Шаг N из M» is a <p>) */
  plainTitle?: boolean;
}) {
  const TitleTag = props.plainTitle ? "p" : "h1";
  const { t } = useI18n();
  useBackButton(props.onBack ?? null);
  const inAppBack = !!props.onBack && !nativeBackButton();
  return (
    <header className="bar">
      {inAppBack ? (
        <button type="button" className="ib" aria-label={t("c.back")} onClick={() => props.onBack?.()} data-testid="bar-back">
          <Icon name="back" size={24} stroke={2} />
        </button>
      ) : null}
      {props.logo ? (
        <p className="logo">
          Til<span>Hero</span>
        </p>
      ) : (
        <TitleTag className={inAppBack ? "bar-t" : "bar-t nb"}>{props.title}</TitleTag>
      )}
      {props.right}
      {props.bell ? (
        <button
          type="button"
          className="ib"
          aria-label={props.bell.unread > 0 ? t("bar.inboxUnread", { n: props.bell.unread }) : t("bar.inbox")}
          onClick={props.bell.onClick}
          data-testid="bell"
        >
          <Icon name="bell" size={23} stroke={1.8} />
          {props.bell.unread > 0 ? (
            <span className="dot" aria-hidden="true">
              {props.bell.unread > 99 ? "99+" : props.bell.unread}
            </span>
          ) : null}
        </button>
      ) : null}
    </header>
  );
}

const TAB_ICON: Record<Tab, "home" | "lessons" | "review" | "progress" | "profile"> = {
  home: "home",
  lessons: "lessons",
  review: "review",
  progress: "progress",
  profile: "profile",
};

export function Tabs({ current, onTab }: { current: Tab; onTab: (t: Tab) => void }) {
  const { t } = useI18n();
  return (
    <nav className="tabs" aria-label={t("nav.tabs")}>
      {TABS.map((k) => (
        <button key={k} type="button" className="tab" aria-current={current === k ? "page" : undefined} onClick={() => onTab(k)} data-testid={`tab-${k}`}>
          <Icon name={TAB_ICON[k]} size={22} />
          {t(`tab.${k}`)}
        </button>
      ))}
    </nav>
  );
}
