import type { Preferences } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { useI18n, type I18n } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { geoKey } from "../../state/prefs";
import { useGeographies, useInterests } from "../../state/directory";
import {
  biometricInit,
  biometricOpenSettings,
  biometricRequestAccess,
  biometricUpdateToken,
  confirmPopup,
  haptic,
  requestWriteAccess,
  showPopup,
} from "../../tg";
import { Icon, type IconName } from "../../ui/Icon";
import { GroupH, LRow, Note, Spinner, ToggleRow } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { PinSheet, type PinSheetMode } from "./PinSheet";
import { PrefEditor, type PrefKind } from "./PrefEditor";
import { DEFAULT_HOTEL_DISTANCE_KM } from "../../state/prefs";
import { hotelRatingLabel } from "../../ui/prefControls";
import { ConfigSheet, ConsentSheet, DataInfoSheet, DeleteSheet, NotifTimeSheet } from "./sheets";
import { HomeScreenRow } from "../homescreen/HomeScreen";
import { WhatsNewRow } from "../whatsnew/WhatsNew";

type SheetState =
  | { k: "pref"; kind: PrefKind }
  | { k: "pin"; mode: PinSheetMode }
  | { k: "notif"; kind: "quiet" | "digest" }
  | { k: "data" }
  | { k: "consent" }
  | { k: "delete" }
  | { k: "cfg" }
  | null;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase() || "AI";
}

function bioLabel(t: I18n["t"], type: "face" | "finger" | "unknown" | null): string {
  return type === "face" ? t("bio.face") : type === "finger" ? t("bio.finger") : t("bio.unknown");
}

export function Profile() {
  const { api, session, profile, setProfile, reloadProfile, setSecurity, navigate, config, configSource } = useApp();
  const i18n = useI18n();
  const { t, l, fmt } = i18n;
  const errText = useErrorText();
  const [sheet, setSheet] = useState<SheetState>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [bioType, setBioType] = useState<"face" | "finger" | "unknown" | null>(null);
  const [bioAvailable, setBioAvailable] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const interests = useInterests(api);
  const geo = useGeographies(api);

  const load = () => {
    setLoadFailed(false);
    void reloadProfile().then((p) => setLoadFailed(!p));
  };
  useEffect(() => {
    load();
    void biometricInit().then((b) => {
      setBioAvailable(b ? b.available : false);
      setBioType(b?.type ?? null);
    });
    // load once per visit of the tab
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const user = profile?.user ?? session.user;
  const sec = session.security;
  const prefs = profile?.preferences;
  const notif = profile?.notifications;
  const disabled = user.status === "DISABLED";

  /* ---------- summaries for the preference rows ---------- */
  const none = t("p.v.none");
  const sumInterests = (p: Preferences) => {
    const names = p.interests.categories.map((c) => l(interests.items?.find((x) => x.code === c)?.label) || c);
    return [...p.interests.entities, ...names].join(", ") || none;
  };
  const sumGeo = (p: Preferences) => {
    const names = p.geographies.map((g) => l(geo.items?.find((o) => geoKey({ level: o.level, code: o.code }) === geoKey(g))?.label) || g.code || g.level);
    return names.length ? names.join(", ") + (p.strong_events_outside_geo ? t("p.v.strong") : "") : none;
  };
  const sumFormat = (p: Preferences) => {
    const f = p.event_formats;
    return f.includes("offline") && f.includes("online") ? t("p.v.fmt.both") : f.includes("online") ? t("p.v.fmt.online") : t("p.v.fmt.offline");
  };
  const sumBudget = (p: Preferences) => {
    const b = p.budget;
    if (b.preset === "custom" && b.custom_amount) return t("p.v.upTo", { p: fmt.usd(b.custom_amount) });
    if (b.min != null && b.max != null) return b.min === 0 ? t("p.v.upTo", { p: fmt.usd(b.max) }) : `${fmt.usd(b.min)}–${fmt.num(b.max)}`;
    return none;
  };
  const sumRemind = (p: Preferences) =>
    p.notification_points_months.length ? t("p.v.remind", { list: p.notification_points_months.join(t("p.v.and")) }) : none;
  const sumDeps = (p: Preferences) => (p.departures.length ? p.departures.map((d) => `${d.city} (${d.airport_iata})`).join(", ") : none);
  // fix 6.3: «оценка 8,5+ · до 5 км [· 4★+]» — the effective values (null = the default); any stars are not named
  const sumHotel = (p: Preferences) => {
    const h = p.hotel_prefs;
    const r = h?.rating_min ?? config?.hotel_rating_min ?? 8.5;
    return [
      r ? t("p.v.ht.rating", { r: hotelRatingLabel(r, i18n.lang, "") }) : t("p.v.ht.anyRating"),
      t("p.v.ht.dist", { km: t("tr.dist.km", { n: h?.max_distance_km ?? DEFAULT_HOTEL_DISTANCE_KM }) }),
      h?.min_stars ? t("pref.ht.starsN", { n: h.min_stars }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const sumFlights = (p: Preferences) =>
    [p.flight_prefs.direct && t("p.v.fl.direct"), p.flight_prefs.connecting && t("p.v.fl.conn"), p.flight_prefs.alternative_departure && t("p.v.fl.alt")]
      .filter(Boolean)
      .join(" + ") || none;

  const rows: Array<[PrefKind, IconName, string, (p: Preferences) => string]> = [
    ["interests", "flag", t("p.r.interests"), sumInterests],
    ["geo", "globe", t("p.r.geo"), sumGeo],
    ["geo", "monitor", t("p.r.format"), sumFormat],
    ["horizon", "cal", t("p.r.horizon"), (p) => t("p.v.months", { n: p.search_horizon_months })],
    ["horizon", "bell", t("p.r.remind"), sumRemind],
    ["lang", "globe", t("p.r.lang"), () => (i18n.lang === "ru" ? t("p.lang.ru") : t("p.lang.en"))],
  ];
  // fix 6.3: «Поездки» — what the trip calculation takes from the profile: budget, departures, flights, hotel
  const tripRows: Array<[PrefKind, IconName, string, (p: Preferences) => string]> = [
    ["budget", "wallet", t("p.r.budget"), sumBudget],
    ["deps", "plane", t("p.r.deps"), sumDeps],
    ["flights", "route", t("p.r.flights"), sumFlights],
    ["hotel", "bed", t("p.r.hotel"), sumHotel],
  ];

  /* ---------- notifications ---------- */
  const toggleNotifications = async (on: boolean) => {
    if (!profile) return;
    if (on) {
      const granted = await requestWriteAccess({ title: t("ob.wa.t"), message: t("ob.wa.m"), allow: t("common.allow"), deny: t("common.deny") });
      if (!granted) return showToast(t("p.n.denied"), "info");
    }
    setBusy("notif");
    try {
      setProfile(await api.profile.settings({ notifications: { enabled: on } }));
    } catch (e) {
      showToast(errText(e), "alert");
    } finally {
      setBusy(null);
    }
  };

  /* ---------- security ---------- */
  const onPinRow = async () => {
    if (!sec.pin_enabled) return setSheet({ k: "pin", mode: "set" });
    const id = await showPopup({
      title: t("pin.m.t"),
      message: t("pin.m.m"),
      buttons: [
        { id: "change", text: t("pin.m.change"), primary: true },
        { id: "reset", text: t("pin.m.reset") },
        { id: "off", text: t("pin.m.off"), type: "destructive" },
        { id: "cancel", text: t("common.cancel"), type: "cancel" },
      ],
    });
    if (id === "change" || id === "reset" || id === "off") setSheet({ k: "pin", mode: id });
  };

  const enableBiometric = async () => {
    const info = await biometricInit();
    if (!info || !info.available) {
      await showPopup({ title: t("pin.bio.naT"), message: t("pin.bio.naM"), buttons: [{ id: "ok", text: t("common.ok"), primary: true }] });
      return;
    }
    const granted = await biometricRequestAccess(t("pin.bio.reason"));
    if (!granted) {
      const id = await showPopup({
        title: t("pin.bio.naT"),
        message: t("pin.bio.denied"),
        buttons: [
          { id: "cancel", text: t("common.cancel"), type: "cancel" },
          { id: "settings", text: t("pin.bio.settings"), primary: true },
        ],
      });
      if (id === "settings") biometricOpenSettings();
      return;
    }
    setBusy("bio");
    try {
      const r = await api.security.enableBiometric();
      const stored = await biometricUpdateToken(r.biometric_token);
      if (!stored) {
        setSecurity(await api.security.disableBiometric());
        showToast(t("err.UNKNOWN"), "alert");
        return;
      }
      setSecurity(r.security);
      haptic.notify("success");
      showToast(t("pin.bio.on"), "face");
    } catch (e) {
      showToast(errText(e), "alert");
    } finally {
      setBusy(null);
    }
  };

  const toggleBiometric = async (on: boolean) => {
    if (!sec.pin_enabled) {
      await showPopup({ title: t("pin.bio.offT"), message: t("pin.bio.offM"), buttons: [{ id: "ok", text: t("common.ok"), primary: true }] });
      return;
    }
    if (on) return enableBiometric();
    setBusy("bio");
    try {
      setSecurity(await api.security.disableBiometric());
      await biometricUpdateToken("");
      showToast(t("pin.bio.offDone"), "face");
    } catch (e) {
      showToast(errText(e), "alert");
    } finally {
      setBusy(null);
    }
  };

  const onPinDone = (mode: PinSheetMode) => {
    if (mode !== "set") return;
    // offer biometrics right after the first PIN (prototype flow), only on explicit consent
    setTimeout(() => {
      void (async () => {
        const info = await biometricInit();
        if (!info?.available) return;
        const id = await showPopup({
          title: t("pin.bio.t"),
          message: t("pin.bio.m"),
          buttons: [
            { id: "no", text: t("pin.bio.no") },
            { id: "yes", text: t("pin.bio.yes"), primary: true },
          ],
        });
        if (id === "yes") await enableBiometric();
      })();
    }, 350);
  };

  /* ---------- account ---------- */
  const toggleApp = async () => {
    if (!profile) return;
    if (!disabled) {
      const ok = await confirmPopup({ title: t("p.off.t"), message: t("p.off.m"), ok: t("p.off.ok"), cancel: t("common.cancel"), destructive: true });
      if (!ok) return;
    }
    setBusy("app");
    try {
      const p = disabled ? await api.profile.enable() : await api.profile.disable();
      setProfile(p);
      showToast(disabled ? t("p.on.done") : t("p.off.done"), "power");
    } catch (e) {
      showToast(errText(e), "alert");
    } finally {
      setBusy(null);
    }
  };

  const consent = profile?.consent ?? session.consent;
  const bioSub = !sec.pin_enabled ? t("p.bio.sub") : sec.biometric_enabled ? t("p.bio.subOn", { type: bioLabel(t, bioType) }) : bioAvailable === false ? t("p.bio.na") : bioLabel(t, bioType);

  return (
    <>
      <header className="pg-h">
        <h1>{t("p.h")}</h1>
      </header>
      <div className="pf-card">
        <span className="ava lg">{initials(user.display_name)}</span>
        <div>
          <h2>{user.display_name}</h2>
          <p>{user.username ? `@${user.username} · ${t("p.tgdata")}` : t("p.tgdata")}</p>
          <p className="mono">ID {user.user_id.slice(0, 8)}</p>
        </div>
      </div>

      {!profile || !prefs || !notif ? (
        loadFailed ? (
          <div className="pd mt16">
            <Note tone="bad" icon="alert" action={{ label: t("common.retry"), onClick: load }}>
              {t("err.SERVICE_UNAVAILABLE")}
            </Note>
          </div>
        ) : (
          <div className="empty">
            <Spinner />
          </div>
        )
      ) : (
        <div className="pf-sec">
          <GroupH>{t("p.prefs")}</GroupH>
          <div className="group">
            {rows.map(([kind, icon, title, sum]) => (
              <LRow key={title} icon={icon} title={title} sub={sum(prefs)} onClick={() => setSheet({ k: "pref", kind })} />
            ))}
          </div>

          <GroupH>{t("p.trips")}</GroupH>
          <div className="group" data-testid="profile-trips">
            {tripRows.map(([kind, icon, title, sum]) => (
              <LRow key={title} icon={icon} title={title} sub={sum(prefs)} onClick={() => setSheet({ k: "pref", kind })} testId={`pref-row-${kind}`} />
            ))}
          </div>

          <GroupH>{t("p.notif")}</GroupH>
          <div className="group">
            <ToggleRow
              id="notifTg"
              title={t("p.n.tg")}
              sub={t("p.n.tgSub")}
              on={notif.enabled && !disabled}
              disabled={disabled}
              busy={busy === "notif"}
              onChange={(v) => void toggleNotifications(v)}
            />
            <LRow
              icon="moon"
              title={notif.quiet_hours ? t("p.n.quiet", { from: notif.quiet_hours.start, to: notif.quiet_hours.end }) : t("p.n.quietOff")}
              sub={notif.quiet_hours ? t("p.n.quietSub") : t("p.n.quietOffSub")}
              disabled={disabled || !notif.enabled}
              onClick={() => setSheet({ k: "notif", kind: "quiet" })}
            />
            <LRow
              icon="clock"
              title={t("p.n.digest", { time: notif.digest_time })}
              sub={t("p.n.digestSub")}
              disabled={disabled || !notif.enabled}
              onClick={() => setSheet({ k: "notif", kind: "digest" })}
            />
          </div>

          <GroupH>{t("p.sec")}</GroupH>
          <div className="group">
            <LRow
              icon="key"
              title={t("p.pin")}
              sub={sec.pin_enabled ? (sec.pin_length === 6 ? t("p.pin.on6") : t("p.pin.on4")) : t("p.pin.off")}
              value={sec.pin_enabled ? t("p.pin.change") : t("p.pin.set")}
              onClick={() => void onPinRow()}
            />
            <ToggleRow
              id="bioToggle"
              icon="face"
              title={t("p.bio")}
              sub={bioSub}
              on={sec.biometric_enabled}
              disabled={!sec.pin_enabled}
              busy={busy === "bio"}
              onChange={(v) => void toggleBiometric(v)}
            />
          </div>

          <GroupH>{t("p.app")}</GroupH>
          <div className="group" data-testid="profile-app">
            <HomeScreenRow />
            <WhatsNewRow />
          </div>

          <GroupH>{t("p.sup")}</GroupH>
          <div className="group">
            <LRow icon="chat" title={t("p.sup.new")} sub={t("p.sup.newSub")} onClick={() => navigate({ type: "push", route: { name: "supportNew" } })} />
            <LRow icon="help" title={t("p.sup.list")} sub={t("p.sup.listSub")} onClick={() => navigate({ type: "push", route: { name: "supportList" } })} />
          </div>

          <GroupH>{t("p.priv")}</GroupH>
          <div className="group">
            <LRow icon="db" title={t("p.priv.data")} onClick={() => setSheet({ k: "data" })} />
            <LRow
              icon="doc"
              title={t("p.priv.consent")}
              sub={
                consent.accepted
                  ? t("p.priv.consentSub", { v: consent.policy_version ?? consent.current_policy_version, d: consent.accepted_at ? fmt.date(consent.accepted_at) : "" })
                  : t("p.priv.consentOff")
              }
              onClick={() => setSheet({ k: "consent" })}
            />
            <LRow icon="power" title={disabled ? t("p.priv.offOn") : t("p.priv.off")} sub={t("p.priv.offSub")} disabled={busy === "app"} onClick={() => void toggleApp()} />
            <LRow icon="trash" title={t("p.priv.del")} sub={t("p.priv.delSub")} danger onClick={() => setSheet({ k: "delete" })} />
          </div>
        </div>
      )}

      <div className="premium">
        <Icon name="star" size={20} />
        <div>
          <b>{t("p.prem")}</b>
          <p>{t("p.prem.p")}</p>
        </div>
      </div>
      <p className="pf-foot">
        <button type="button" onClick={() => setSheet({ k: "cfg" })}>
          {t("p.foot", { id: config.theme.id, v: config.theme.version, src: configSource === "remote" ? t("p.foot.remote") : t("p.foot.local") })}
        </button>
      </p>

      {sheet?.k === "pref" && <PrefEditor kind={sheet.kind} onClose={() => setSheet(null)} />}
      {sheet?.k === "pin" && <PinSheet mode={sheet.mode} onClose={() => setSheet(null)} onDone={(_, mode) => onPinDone(mode)} />}
      {sheet?.k === "notif" && <NotifTimeSheet kind={sheet.kind} onClose={() => setSheet(null)} />}
      {sheet?.k === "data" && <DataInfoSheet onClose={() => setSheet(null)} />}
      {sheet?.k === "consent" && <ConsentSheet onClose={() => setSheet(null)} />}
      {sheet?.k === "delete" && <DeleteSheet onClose={() => setSheet(null)} onForgot={() => setSheet({ k: "pin", mode: "reset" })} />}
      {sheet?.k === "cfg" && <ConfigSheet onClose={() => setSheet(null)} />}
    </>
  );
}

