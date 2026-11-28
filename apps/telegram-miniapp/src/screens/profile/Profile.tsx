import type { GameSummary, SubscriptionView } from "@tilhero/contracts/bff";
import { hasAccess } from "../../domain/billing";
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
  const { t, tp, l, lang, fmt } = useI18n();
  const profile = useLoad(() => bff.profile(), [session.learner.learner_id]);
  const dx = useLoad(() => bff.diagnosticsState(true), [session.learner.learner_id]);
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
  // sprint 6: the game section is shown once the game answers (GAME_UNAVAILABLE — no section, learning settings stay)
  const gameOn = flag(config, "game");
  const game = useLoad<GameSummary | null>(() => (gameOn ? bff.gameSummary(true).catch(() => null) : Promise.resolve(null)), [session.learner.learner_id, gameOn]);
  const g = game.data;
  // sprint 8: the subscription row (a child profile — only «Подписка семьи активна до …», no prices, no buttons)
  const billing = useLoad<SubscriptionView | null>(() => bff.billingSubscription(true).catch(() => null), [session.learner.learner_id]);
  const sub = billing.data;
  const subValue = !sub
    ? ""
    : sub.status === "trial" && sub.period
      ? t("bill.row.trial", { date: fmt.date(sub.period.ends_at) })
      : sub.status === "active" && sub.period
        ? t("bill.row.active", { date: fmt.date(sub.period.ends_at) })
        : sub.status === "expired"
          ? t("bill.row.expired")
          : t("bill.row.none");
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
            <NavRow
              title={t("profile.diagnostics")}
              value={dx.data ? (dx.data.status === "completed" ? (dx.data.last_result?.provisional_level ? t("profile.dxDone", { band: dx.data.last_result.provisional_level }) : t("profile.dxDoneNone")) : t("profile.dxNone")) : ""}
              icon="target"
              onClick={() => nav.push({ name: "diagnostics" })}
              testId="row-diagnostics"
            />
            <NavRow title={t("profile.languages")} icon="globe" onClick={() => nav.push({ name: "languages" })} testId="row-languages" />
            {!kid ? (
              <NavRow title={t("bill.row")} value={subValue} icon="star" onClick={() => nav.push({ name: "subscription" })} testId="row-subscription" />
            ) : sub && hasAccess(sub) && sub.period ? (
              <div className="row" data-testid="row-family-sub">
                <span className="nic"><Icon name="star" size={20} /></span>
                <span className="t"><b>{t("bill.kid.active", { date: fmt.date(sub.period.ends_at) })}</b></span>
              </div>
            ) : null}
          </div>
        </div>

        {g ? (
          <div className="pad" data-testid="profile-game">
            <p className="sec mb8">{t("profile.game")}</p>
            <div className="list">
              <NavRow title={t("game.myHero")} value={g.hero ? l(g.hero.name) : t("game.noHero")} icon="hero" onClick={() => nav.push({ name: "heroes" })} testId="row-hero" />
              <NavRow title={t("game.shop")} value={t("game.tilsN", { n: g.til_balance, w: tp("game.tilsWord", g.til_balance) })} icon="bag" onClick={() => nav.push({ name: "shop" })} testId="row-shop" />
              {g.purchase_available && !kid ? <NavRow title={t("game.buyTils")} icon="coin" onClick={() => nav.push({ name: "tilShop" })} testId="row-buy-tils" /> : null}
              <NavRow title={t("game.badges")} icon="medal" onClick={() => nav.push({ name: "badges" })} testId="row-badges" />
              <NavRow title={t("game.historyLong")} icon="list" onClick={() => nav.push({ name: "gameHistory" })} testId="row-game-history" />
              <NavRow title={t("game.settings")} icon="sliders" onClick={() => nav.push({ name: "gameSettings" })} testId="row-game-settings" />
            </div>
          </div>
        ) : null}

        {flag(config, "social") ? (
          <div className="pad" data-testid="profile-social">
            {/* sprint 7: friends (a child — «Моя семья»), the league of the week, duels, the pair lesson, referrals */}
            <p className="sec mb8">{t("profile.social")}</p>
            <div className="list">
              <NavRow title={kid ? t("profile.myFamily") : t("soc.link.friends")} icon="users" onClick={() => nav.push({ name: "friends" })} testId="row-friends" />
              {gameOn ? <NavRow title={t("soc.link.leagues")} icon="trophy" onClick={() => nav.push({ name: "leagues" })} testId="row-leagues" /> : null}
              {gameOn ? <NavRow title={t("soc.link.duels")} icon="target" onClick={() => nav.push({ name: "duels" })} testId="row-duels" /> : null}
              <NavRow title={t("soc.link.pair")} icon="chat" onClick={() => nav.push({ name: "pairRooms" })} testId="row-pair" />
              {!kid ? <NavRow title={t("soc.link.referrals")} icon="gift" onClick={() => nav.push({ name: "referrals" })} testId="row-referrals" /> : null}
            </div>
          </div>
        ) : null}

        <div className="pad">
          <div className="list">
            <NavRow title={t("profile.schedule")} value={`${daysText(plan.schedule, t)} · ${plan.schedule.preferred_time}`} onClick={() => nav.push({ name: "schedule" })} testId="row-schedule" />
            <NavRow title={t("profile.notif")} value={notifValue} onClick={() => nav.push({ name: "notifSettings" })} testId="row-notif" />
            <NavRow title={t("profile.lang")} value={lang === "uz" ? "Oʻzbekcha" : "Русский"} onClick={() => nav.push({ name: "language" })} testId="row-lang" />
            <NavRow title={t("profile.theme")} value={t(`theme.${themePref}` as MessageKey)} onClick={() => nav.push({ name: "theme" })} testId="row-theme" />
            <HomeScreenRow />
            {!kid ? <NavRow title={t("profile.family")} onClick={() => nav.push({ name: "family" })} testId="row-family" /> : null}
            {!kid ? (
              <NavRow
                title={t("vc.title")}
                value={session.consent.purposes.includes("voice_recording") ? t("c.on") : t("c.off")}
                icon="mic"
                onClick={() => nav.push({ name: "voiceConsent" })}
                testId="row-voice"
              />
            ) : null}
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
