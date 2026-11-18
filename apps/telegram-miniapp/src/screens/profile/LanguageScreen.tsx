import type { UiLang } from "@tilhero/contracts/bff";
import { flag } from "../../config/experience";
import { translate, useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction } from "../../state/hooks";
import { ErrorLine, Opt } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";

/** Profile → «Язык интерфейса» (APP-ONB-02, AT-05): RU / UZ; the course pair stays ru → en. */
export function LanguageScreen() {
  const { bff, nav, setPlan, syncProfile, plan, config } = useApp();
  const { t, lang, setLang } = useI18n();
  const save = useAction(async (l: UiLang) => {
    const before = lang;
    setLang(l);
    try {
      syncProfile(await bff.patchSettings({ locale: l }));
      setPlan(await bff.patchPlan({ ui_lang: l }));
    } catch (e) {
      setLang(before);
      throw e;
    }
    showToast(translate(l, "lang.changed"));
  });
  return (
    <>
      <Bar title={t("lang.title")} onBack={nav.back} />
      <main className="scroll" data-testid="language">
        <div className="pad stack">
          <div className="opts" role="group" aria-label={t("lang.title")}>
            <Opt on={lang === "ru"} title="Русский" onClick={() => void save.run("ru")} disabled={save.busy} testId="lang-ru" />
            {flag(config, "uz_ui") || lang === "uz" ? (
              <Opt on={lang === "uz"} title="Oʻzbekcha" note={t("lang.uzNote")} onClick={() => void save.run("uz")} disabled={save.busy} testId="lang-uz" />
            ) : null}
          </div>
          <ErrorLine text={save.error} />
          <div className="card">
            <p className="sub">{t("lang.note")}</p>
            <div className="kv mt8" data-testid="course-pair">
              <span>{t("lang.course")}</span>
              <span>{plan?.course_pair === "ru-en" ? t("profile.pair") : plan?.course_pair}</span>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
