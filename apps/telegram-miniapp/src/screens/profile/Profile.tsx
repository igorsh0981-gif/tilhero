import { useEffect } from "react";
import { children, initialOf, teenWithoutConsent } from "../../domain/people";
import { flag } from "../../config/experience";
import { env } from "../../env";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp, usePlan } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, NavRow, Pill } from "../../ui/kit";
import { useThemePref } from "../../tg";
import { HomeScreenRow } from "../homescreen/HomeScreen";
import { PinResetPending } from "../lock/PinFlows";
import { daysText } from "../schedule/parts";
import { useSwitchToParent } from "./switching";

/** Profile (prototype «Профиль»): course with the goal and level, schedule, notifications, language, theme, the home
 *  screen icon (Bot API 8.0), family, parent consent, news, support, data and deletion. A child profile shows only its
 *  learning settings and the way back to the parent. */
export function Profile() {
  const { bff, session, syncProfile, nav, config } = useApp();
  const plan = usePlan();
  const { t, lang } = useI18n();
  const profile = useLoad(() => bff.profile(), [session.learner.learner_id]);
  useEffect(() => {
    if (profile.data) syncProfile(profile.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.data]);
  const kid = session.learner.kind === "child";
  const toParent = useSwitchToParent();
  const acc = session.account;
  const kind = kid
    ? t("profile.kind.child", { age: session.learner.age_band ? t(`age.${session.learner.age_band}` as MessageKey) : "" })
    : acc.age_band === "14-17"
      ? t("profile.kind.teen", { status: t(`gc.${acc.guardian_consent}` as MessageKey) })
      : t("profile.kind.adult");
  const themePref = useThemePref();
  const direction = [plan.goal ? t(`goal.${plan.goal}` as MessageKey) : null, plan.level_self ? t(`level.${plan.level_self}` as MessageKey) : null]
    .filter(Boolean)
    .join(" · ");
  const notif = profile.data?.notifications;
  const notifValue = notif ? (notif.enabled ? t("c.on") : t("c.off")) : "";

  return (
    <main className="scroll" data-testid="profile">
      <div className="stack">
        <div className="pad">
          <div className="card hrow">
            <div className="av" aria-hidden="true">{initialOf(session.learner.display_name)}</div>
            <div className="grow">
              <h2 className="h3">{session.learner.display_name}</h2>
              <div className="mt4">
                <Pill tone={kid ? "warn" : undefined}>{kind}</Pill>
              </div>
            </div>
          </div>
        </div>

        {!kid && session.security.pin_enabled && session.security.pin_reset_effective_at ? (
          <div className="pad">
            {/* review T-8: a reset requested through the bot waits 24 h — the parent sees it and can cancel it */}
            <PinResetPending at={session.security.pin_reset_effective_at} onCancel={() => nav.push({ name: "parentCode", cancel: true })} />
          </div>
        ) : null}

        <div className="pad">
          <p className="sec mb8">{t("profile.course")}</p>
          <div className="list">
            <div className="row">
              <span className="t">
                <b>{t("profile.pair")}</b>
                <span>{t("profile.pairNote")}</span>
              </span>
              <Pill tone="ok">{t("profile.active")}</Pill>
            </div>
            <NavRow title={t("profile.goal")} note={direction} onClick={() => nav.push({ name: "goal" })} testId="row-goal" />
          </div>
        </div>

        <div className="pad">
          <div className="list">
            <NavRow title={t("profile.schedule")} value={`${daysText(plan.schedule, t)} · ${plan.schedule.preferred_time}`} onClick={() => nav.push({ name: "schedule" })} testId="row-schedule" />
            <NavRow title={t("profile.notif")} value={notifValue} onClick={() => nav.push({ name: "notifSettings" })} testId="row-notif" />
            <NavRow title={t("profile.lang")} value={lang === "uz" ? "Oʻzbekcha" : "Русский"} onClick={() => nav.push({ name: "language" })} testId="row-lang" />
            <NavRow title={t("profile.theme")} value={t(`theme.${themePref}` as MessageKey)} onClick={() => nav.push({ name: "theme" })} testId="row-theme" />
            <HomeScreenRow />
            {!kid ? <NavRow title={t("profile.family")} onClick={() => nav.push({ name: "family" })} testId="row-family" /> : null}
            {!kid && acc.age_band === "18+" ? (
              <NavRow
                title={t("profile.pin")}
                value={session.security.pin_enabled ? t("profile.pinOn") : t("profile.pinOff")}
                onClick={() => nav.push({ name: "parentCode" })}
                testId="row-pin"
                badge={!session.security.pin_enabled && children(session).length ? <span className="unread-dot" aria-hidden="true" /> : undefined}
              />
            ) : null}
            {!kid && acc.age_band === "14-17" ? (
              <NavRow
                title={t("profile.guardian")}
                value={t(`gc.${acc.guardian_consent}` as MessageKey)}
                onClick={() => nav.push({ name: "guardian" })}
                testId="row-guardian"
                badge={teenWithoutConsent(session) ? <span className="unread-dot" aria-hidden="true" /> : undefined}
              />
            ) : null}
            {flag(config, "news") ? <NavRow title={t("profile.news")} onClick={() => nav.push({ name: "news" })} testId="row-news" /> : null}
            {!kid ? <NavRow title={t("profile.support")} onClick={() => nav.push({ name: "support" })} testId="row-support" /> : null}
            {!kid ? <NavRow title={t("profile.privacy")} onClick={() => nav.push({ name: "privacy" })} testId="row-privacy" /> : null}
          </div>
        </div>

        {kid ? (
          <div className="pad stack tight">
            <div className="card warn">
              <p className="sub ink">{t("profile.kidNote")}</p>
            </div>
            <Btn variant="secondary" busy={toParent.busy} onClick={() => void toParent.run()} data-testid="to-parent">
              <Icon name="logout" size={18} />
              {t("profile.toParent")}
            </Btn>
            {toParent.error ? <p className="field-err" role="alert">{toParent.error}</p> : null}
          </div>
        ) : null}

        <div className="pad">
          <p className="sub small">{t("profile.version", { v: env.clientVersion, c: config.version })}</p>
        </div>
      </div>
      {toParent.sheet}
    </main>
  );
}
