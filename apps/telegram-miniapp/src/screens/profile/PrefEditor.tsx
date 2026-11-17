import type { Preferences } from "@tilhero/contracts/bff";
import { useState } from "react";
import { ApiError } from "../../api/errors";
import { translate, useI18n, type Lang, type MessageKey } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { interestChips, useGeographies, useInterests } from "../../state/directory";
import { budgetState, draftFromPreferences, preferencesPatch, type PrefDraft, type PrefSection } from "../../state/prefs";
import { haptic, useMainButton } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Seg } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import {
  BudgetControl,
  DeparturesControl,
  EntitiesControl,
  FlightsControl,
  FormatControl,
  GeoControl,
  HorizonControl,
  HotelControl,
  InterestsControl,
  RemindControl,
} from "../../ui/prefControls";

export type PrefKind = "interests" | "geo" | "budget" | "horizon" | "deps" | "flights" | "hotel" | "lang";

const TITLES: Record<PrefKind, MessageKey> = {
  interests: "p.edit.h.interests",
  geo: "p.edit.h.geo",
  budget: "p.edit.h.budget",
  horizon: "p.edit.h.horizon",
  deps: "p.edit.h.deps",
  flights: "p.edit.h.flights",
  hotel: "p.edit.h.hotel",
  lang: "p.edit.h.lang",
};
const SECTION: Partial<Record<PrefKind, PrefSection>> = { interests: "interests", geo: "geo", budget: "budget", horizon: "horizon", flights: "flights", hotel: "hotel" };

/** 422 на само поле hotel_prefs (неизвестное поле у BFF или preferences до 6.3), а не на его значение. */
export function hotelPrefsUnsupported(e: unknown): boolean {
  return e instanceof ApiError && e.status === 422 && (e.code === "PREFERENCES_INVALID" || e.code === "VALIDATION_ERROR") && e.details.field === "hotel_prefs";
}

function valid(kind: PrefKind, d: PrefDraft): boolean {
  if (kind === "interests") return d.interests.length > 0 || d.entities.length > 0;
  if (kind === "geo") return d.geo.length > 0;
  if (kind === "budget") return budgetState(d) === "ok";
  if (kind === "deps") return d.deps.length > 0;
  return true;
}

/**
 * Profile editors reuse the onboarding controls (TG-FR-018). Save is the Telegram MainButton.
 * PATCH carries `version` (optimistic lock): on 409 the profile is reloaded and the user re-checks.
 */
export function PrefEditor({ kind, onClose }: { kind: PrefKind; onClose: () => void }) {
  const { api, profile, setProfile, reloadProfile, config } = useApp();
  const { t, lang, setLang } = useI18n();
  const errText = useErrorText();
  const [draft, setDraftState] = useState<PrefDraft>(() => draftFromPreferences(profile?.preferences));
  const [uiLang, setUiLang] = useState<Lang>(lang);
  const [busy, setBusy] = useState(false);
  const interests = useInterests(api);
  const geo = useGeographies(api);
  const setDraft = (fn: (d: PrefDraft) => PrefDraft) => setDraftState((d) => fn(d));
  const ok = valid(kind, draft);

  const save = async () => {
    if (!profile || !ok || busy) return;
    setBusy(true);
    try {
      if (kind === "lang") {
        const p = await api.profile.settings({ locale: uiLang });
        setProfile(p);
        setLang(uiLang);
      } else {
        let prefs: Preferences;
        if (kind === "deps") prefs = await api.profile.departures(draft.deps.map((x) => x.airport_iata));
        else prefs = await api.profile.preferences(preferencesPatch(draft, [SECTION[kind]!], profile.preferences.version));
        setProfile({ ...profile, preferences: prefs });
      }
      haptic.notify("success");
      // the toast speaks the language that was just chosen
      showToast(kind === "lang" ? translate(uiLang, "toast.prefSaved") : t("toast.prefSaved"));
      onClose();
    } catch (e) {
      // ревью 6.3: telegram-bff / preferences ещё без настроек отеля (выкладка) — не ошибка, а «чуть позже»
      if (kind === "hotel" && hotelPrefsUnsupported(e)) {
        showToast(t("pref.ht.soon"), "info");
        onClose();
        return;
      }
      haptic.notify("error");
      if (e instanceof ApiError && e.code === "PREFERENCES_VERSION_CONFLICT") {
        const fresh = await reloadProfile();
        if (fresh) setDraftState(draftFromPreferences(fresh.preferences));
      }
      showToast(errText(e), "alert");
    } finally {
      setBusy(false);
    }
  };

  useMainButton({ text: t("common.save"), onClick: () => void save(), disabled: !ok, progress: busy });

  const ctl = { d: draft, set: setDraft };
  let body;
  switch (kind) {
    case "interests":
      body = (
        <>
          <InterestsControl {...ctl} items={interests.items ? interestChips(interests.items) : null} />
          <div className="mt16" />
          <EntitiesControl {...ctl} />
        </>
      );
      break;
    case "geo":
      body = (
        <>
          <GeoControl {...ctl} items={geo.items} />
          <div className="mt16" />
          <FormatControl {...ctl} />
        </>
      );
      break;
    case "budget":
      body = <BudgetControl {...ctl} />;
      break;
    case "horizon":
      body = (
        <>
          <HorizonControl {...ctl} />
          <div className="mt16" />
          <RemindControl {...ctl} />
          <div className="note mt12">
            <Icon name="bell" size={16} />
            <span>{t("pref.instant")}</span>
          </div>
        </>
      );
      break;
    case "deps":
      body = (
        <div className="ob-body edit-dep">
          <DeparturesControl {...ctl} api={api} sheet />
        </div>
      );
      break;
    case "flights":
      body = <FlightsControl {...ctl} />;
      break;
    case "hotel":
      body = <HotelControl {...ctl} defaultRating={config.hotel_rating_min} />;
      break;
    default:
      body = (
        <>
          <Seg
            value={uiLang}
            options={[
              { value: "ru", label: t("p.lang.ru") },
              { value: "en", label: t("p.lang.en") },
            ]}
            onChange={setUiLang}
            label={t("p.r.lang")}
          />
          <p className="hint mt12">{t("p.edit.lang.hint")}</p>
        </>
      );
  }

  const needKey: MessageKey = kind === "deps" ? "p.edit.deps.need" : kind === "budget" ? "pref.budget.need" : "p.edit.need";
  return (
    <Sheet
      title={t(TITLES[kind])}
      onClose={onClose}
      // departures: a fixed-height sheet — chosen cities and the search stay on top, the airport list takes the rest
      className={kind === "deps" ? "sheet-fill" : undefined}
      foot={
        ok ? undefined : (
          <span className="hint bad grow edit-need" role="status">
            {t(needKey)}
          </span>
        )
      }
    >
      <div className="pref-ed" data-testid={`editor-${kind}`}>
        {body}
      </div>
    </Sheet>
  );
}
