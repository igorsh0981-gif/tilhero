import type { Profile } from "@tilhero/contracts/bff";
import { useCallback, useState } from "react";
import forumArt from "../../assets/art/forum.svg";
import f1Art from "../../assets/art/f1.svg";
import musicArt from "../../assets/art/music.svg";
import { useI18n, type Lang } from "../../i18n";
import { useApp } from "../../state/app";
import { interestChips, useGeographies, useInterests } from "../../state/directory";
import { draftFromPreferences, stepValid, type PrefDraft } from "../../state/prefs";
import { haptic, requestWriteAccess, useBackButton, useMainButton } from "../../tg";
import { Icon, type IconName } from "../../ui/Icon";
import { CheckRow, ToggleRow, Wordmark } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import {
  BudgetControl,
  DeparturesControl,
  EntitiesControl,
  FlightsControl,
  FormatControl,
  GeoControl,
  HorizonControl,
  InterestsControl,
  RemindControl,
} from "../../ui/prefControls";
import { GeoMoreSheet, InterestsMoreSheet, PolicySheet } from "../shared";
import { FirstPick, type OnboardingResult } from "./FirstPick";

/**
 * Onboarding: 6 steps without vertical scroll (ТЗ §5, UI/CSS §6, AT-19) + «Собираем подборку».
 * The draft starts from the server defaults: departures are always empty (AT-20).
 */
export function Onboarding({ profile, onLang }: { profile: Profile; onLang: (l: Lang) => void }) {
  const { api } = useApp();
  const { t, lang } = useI18n();
  const [step, setStep] = useState(1);
  const [skipFrom, setSkipFrom] = useState<number | null>(null);
  const [draft, setDraftState] = useState<PrefDraft>(() => draftFromPreferences(profile.preferences));
  const [age, setAge] = useState(profile.consent.age_confirmed_18_plus);
  const [consentOk, setConsentOk] = useState(false);
  const [notify, setNotify] = useState(false);
  const [sheet, setSheet] = useState<"policy" | "interests" | "geo" | null>(null);
  const [result, setResult] = useState<OnboardingResult | null>(null);
  const [anim, setAnim] = useState<"push" | "pop" | "fade">("fade");
  const interests = useInterests(api);
  const geo = useGeographies(api);
  const leaves = interests.items ? interestChips(interests.items) : null;

  const setDraft = useCallback((fn: (d: PrefDraft) => PrefDraft) => setDraftState((d) => fn(d)), []);
  const valid = stepValid(draft, step, { age, ok: consentOk });

  const go = (n: number, a: "push" | "pop") => {
    setSheet(null); // открытое окно не должно «переезжать» на другой шаг
    setAnim(a);
    setStep(n);
  };
  const next = () => {
    if (!valid) return;
    haptic.impact("medium");
    if (step < 6) return go(step + 1, "push");
    setResult({ draft, notify, lang });
  };
  const back = () => {
    if (step === 6 && skipFrom) {
      setSkipFrom(null);
      return go(skipFrom, "pop");
    }
    go(step - 1, "pop");
  };

  useBackButton(!result && step > 1 ? back : null);
  const finishLabel = step === 1 ? t("ob.start") : step === 6 ? t("ob.finish") : t("ob.next");
  // Пока открыто окно (интересы, политика), MainButton закрывает его («Готово»), а не листает шаги.
  useMainButton(
    result
      ? null
      : sheet
        ? { text: t("common.done"), onClick: () => setSheet(null) }
        : { text: finishLabel, short: step === 6 ? t("ob.finishShort") : undefined, onClick: next, disabled: !valid },
  );

  if (result) return <FirstPick input={result} />;

  const toggleNotify = async (on: boolean) => {
    if (!on) return setNotify(false);
    const granted = await requestWriteAccess({ title: t("ob.wa.t"), message: t("ob.wa.m"), allow: t("common.allow"), deny: t("common.deny") });
    setNotify(granted);
    showToast(granted ? t("ob.wa.ok") : t("ob.wa.no"), granted ? "bell" : "info");
  };

  const head = (
    <>
      <div className="ob-top">
        <Wordmark />
        <span className="ob-n mono">{t("ob.step", { n: step })}</span>
        {step === 1 && (
          <div className="ob-lang" role="group" aria-label={t("a11y.lang")}>
            {(["ru", "en"] as const).map((l) => (
              <button key={l} type="button" aria-pressed={lang === l} onClick={() => onLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        )}
        {step >= 2 && step <= 5 && (
          <button
            className="ob-skip"
            type="button"
            onClick={() => {
              setSkipFrom(step);
              go(6, "push");
              showToast(t("ob.skipToast"), "info");
            }}
          >
            {t("ob.skip")}
          </button>
        )}
      </div>
      <div className="ob-prog" aria-hidden="true">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <i key={i} className={i < step ? "done" : i === step ? "cur" : undefined} />
        ))}
      </div>
    </>
  );

  const ctl = { d: draft, set: setDraft };
  let body;
  switch (step) {
    case 1:
      body = (
        <>
          <h1 className="ob-h">{t("ob.s1.h")}</h1>
          <p className="ob-sub">{t("ob.s1.sub")}</p>
          <div className="ob-body">
            <div className="wl-art" aria-hidden="true">
              <div className="wl-tile t1">
                <img src={musicArt} alt="" />
              </div>
              <div className="wl-tile t2">
                <img src={f1Art} alt="" />
              </div>
              <div className="wl-tile t3">
                <img src={forumArt} alt="" />
              </div>
              <div className="wl-route">
                <b>TAS</b>
                <i />
                <Icon name="plane" size={16} />
                <i />
                <b>AUH</b>
                <span>{t("ob.s1.route")}</span>
              </div>
            </div>
            <div className="val">
              {(
                [
                  ["search", 1],
                  ["route", 2],
                  ["radar", 3],
                  ["spark", 4],
                ] as Array<[IconName, 1 | 2 | 3 | 4]>
              ).map(([icon, n]) => (
                <div key={n}>
                  <Icon name={icon} size={18} />
                  <span>
                    <b>{t(`ob.v${n}`)}</b>
                    <small>{t(`ob.v${n}s`)}</small>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      );
      break;
    case 2:
      body = (
        <>
          <h1 className="ob-h">{t("ob.s2.h")}</h1>
          <p className="ob-sub">{t("ob.s2.sub")}</p>
          <div className="ob-body">
            <InterestsControl {...ctl} items={leaves} max={12} onMore={() => setSheet("interests")} />
            {interests.error ? (
              <button className="lnk" type="button" onClick={interests.retry}>
                {t("ob.dirErr")} · {t("common.retry")}
              </button>
            ) : null}
            <EntitiesControl {...ctl} />
          </div>
        </>
      );
      break;
    case 3:
      body = (
        <>
          <h1 className="ob-h">{t("ob.s3.h")}</h1>
          <p className="ob-sub">{t("ob.s3.sub")}</p>
          <div className="ob-body">
            <GeoControl {...ctl} items={geo.items} max={12} onMore={() => setSheet("geo")} />
            {geo.error ? (
              <button className="lnk" type="button" onClick={geo.retry}>
                {t("ob.dirErr")} · {t("common.retry")}
              </button>
            ) : null}
            <FormatControl {...ctl} />
          </div>
        </>
      );
      break;
    case 4:
      body = (
        <>
          <h1 className="ob-h">{t("ob.s4.h")}</h1>
          <p className="ob-sub">{t("ob.s4.sub")}</p>
          <div className="ob-body">
            <BudgetControl {...ctl} />
            <HorizonControl {...ctl} />
            <RemindControl {...ctl} />
            <div className="note">
              <Icon name="bell" size={16} />
              <span>{t("pref.instant")}</span>
            </div>
          </div>
        </>
      );
      break;
    case 5:
      body = (
        <>
          <h1 className="ob-h">{t("ob.s5.h")}</h1>
          <p className="ob-sub">{t("ob.s5.sub")}</p>
          <div className="ob-body ob-dep">
            <DeparturesControl {...ctl} api={api} />
            <FlightsControl {...ctl} />
          </div>
        </>
      );
      break;
    default:
      body = (
        <>
          <h1 className="ob-h">{t("ob.s6.h")}</h1>
          <p className="ob-sub">{t("ob.s6.sub")}</p>
          <div className="ob-body">
            <div className="cs-data">
              <h3>{t("ob.c.title")}</h3>
              <ul>
                {([1, 2, 3, 4, 5] as const).map((n) => (
                  <li key={n}>{t(`ob.c.d${n}`)}</li>
                ))}
              </ul>
            </div>
            <div className="note">
              <Icon name="shield" size={16} />
              <span>{t("ob.c.bank")}</span>
            </div>
            <CheckRow id="obAge" checked={age} onChange={setAge}>
              {t("ob.c.age")}
            </CheckRow>
            <div className="chk chk-wrap" role="group">
              <button
                id="obConsent"
                className="chk-inner"
                type="button"
                role="checkbox"
                aria-checked={consentOk}
                onClick={() => {
                  haptic.selection();
                  setConsentOk((v) => !v);
                }}
              >
                <span className="chk-box">
                  <Icon name="check" size={15} />
                </span>
                <span className="chk-t">{t("ob.c.ok")}</span>
              </button>
              <button className="cs-pol" type="button" onClick={() => setSheet("policy")}>
                {t("ob.c.policy", { v: profile.consent.current_policy_version })}
              </button>
            </div>
            <div className="ob-tg">
              <ToggleRow id="obNotify" title={t("ob.c.notify")} sub={t("ob.c.notifySub")} on={notify} onChange={(v) => void toggleNotify(v)} />
            </div>
            {!(age && consentOk) && (
              <p className="ob-need" id="obNeed">
                <Icon name="info" size={14} />
                {t("ob.need6")}
              </p>
            )}
          </div>
        </>
      );
  }

  return (
    <>
      <div className={`ob enter-${anim}`} data-step={step} data-testid={`ob-step-${step}`} key={step}>
        {head}
        {body}
      </div>
      {sheet === "policy" && <PolicySheet version={profile.consent.current_policy_version} onClose={() => setSheet(null)} />}
      {sheet === "interests" && leaves && <InterestsMoreSheet items={leaves} draft={draft} setDraft={setDraft} onClose={() => setSheet(null)} />}
      {sheet === "geo" && geo.items && <GeoMoreSheet items={geo.items} draft={draft} setDraft={setDraft} onClose={() => setSheet(null)} />}
    </>
  );
}
