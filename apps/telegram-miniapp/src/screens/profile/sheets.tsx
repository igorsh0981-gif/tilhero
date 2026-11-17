import type { NotificationSettings } from "@tilhero/contracts/bff";
import { useEffect, useReducer, useState } from "react";
import { ApiError } from "../../api/errors";
import { PIN_POLICY, rateLimits, useRateWait } from "../../api/rateLimit";
import { translate, useI18n } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { consentPurposes } from "../../state/consent";
import { initialPinFlow, pinFull, pinNeed, pinReducer, type PinLength } from "../../state/pin";
import { confirmPopup, haptic, useMainButton } from "../../tg";
import { Icon } from "../../ui/Icon";
import { CheckRow, Keypad, PinDots, Switch, useKeypadKeys } from "../../ui/kit";
import { Sheet, showToast, useCountdown } from "../../ui/overlays";
import { PolicySheet } from "../shared";
import { TickingText } from "../../ui/TickingText";

/* ---------- «Какие данные используем» ---------- */
export function DataInfoSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Sheet title={t("p.data.t")} onClose={onClose}>
      <p className="lead">{t("p.data.p")}</p>
      <ul className="del-list ok mt16">
        {([1, 2, 3, 4, 5, 6] as const).map((n) => (
          <li key={n}>
            <Icon name="check" size={16} />
            <span>{t(`p.data.l${n}`)}</span>
          </li>
        ))}
      </ul>
      <div className="note mt16">
        <Icon name="shield" size={16} />
        <span>
          {t("ob.c.bank")} {t("p.data.ai")}
        </span>
      </div>
    </Sheet>
  );
}

/* ---------- consent: evidence, revoke, give again ---------- */
export function ConsentSheet({ onClose }: { onClose: () => void }) {
  const { api, profile, setProfile, session, applySession } = useApp();
  const { t, lang, fmt } = useI18n();
  const errText = useErrorText();
  const consent = profile?.consent ?? session.consent;
  const [busy, setBusy] = useState(false);
  const [age, setAge] = useState(consent.age_confirmed_18_plus);
  const [policy, setPolicy] = useState(false);
  const outdated = consent.accepted && consent.policy_version !== consent.current_policy_version;

  const update = (c: typeof consent) => {
    if (profile) setProfile({ ...profile, consent: c });
    applySession({ ...session, consent: c });
  };
  const revoke = async () => {
    const ok = await confirmPopup({ title: t("p.cons.rv.t"), message: t("p.cons.rv.m"), ok: t("p.cons.revoke"), cancel: t("common.cancel"), destructive: true });
    if (!ok) return;
    setBusy(true);
    try {
      update(await api.profile.revokeConsent());
      showToast(t("p.cons.rv.done"), "doc");
      onClose();
    } catch (e) {
      showToast(errText(e), "alert");
    } finally {
      setBusy(false);
    }
  };
  const grant = async () => {
    setBusy(true);
    try {
      const doc = await api.legal.policy(lang);
      const st = await api.profile.acceptConsent({
        policy_version: doc.version,
        purposes: consentPurposes(doc, { notifications: !!profile?.notifications.enabled }),
        age_confirmed_18_plus: true,
      });
      update(st);
      haptic.notify("success");
      showToast(t("p.cons.granted"), "doc");
      onClose();
    } catch (e) {
      showToast(errText(e), "alert");
    } finally {
      setBusy(false);
    }
  };

  const canGrant = !consent.accepted || outdated;
  return (
    <>
      <Sheet
        title={t("p.cons.t")}
        onClose={onClose}
        foot={
          canGrant ? (
            <button className="btn btn-lime grow" type="button" disabled={busy || !age} onClick={() => void grant()}>
              {t("p.cons.grant")}
            </button>
          ) : (
            <button className="btn btn-danger grow" type="button" disabled={busy} onClick={() => void revoke()}>
              {t("p.cons.revoke")}
            </button>
          )
        }
      >
        <dl className="kv">
          <dt>{t("p.cons.status")}</dt>
          <dd>{consent.accepted ? t("p.cons.active") : t("p.cons.off")}</dd>
          <dt>{t("p.cons.ver")}</dt>
          <dd>policy v{consent.policy_version ?? consent.current_policy_version}</dd>
          {consent.accepted_at && (
            <>
              <dt>{t("p.cons.at")}</dt>
              <dd>{fmt.dateTime(consent.accepted_at)}</dd>
            </>
          )}
          <dt>{t("p.cons.ch")}</dt>
          <dd>{t("p.cons.chV")}</dd>
          <dt>{t("p.cons.age")}</dt>
          <dd>{consent.age_confirmed_18_plus ? t("p.cons.ageV") : t("common.dash")}</dd>
          {consent.evidence_hash && (
            <>
              <dt>{t("p.cons.ev")}</dt>
              <dd className="mono">{consent.evidence_hash}</dd>
            </>
          )}
        </dl>
        {canGrant && !consent.age_confirmed_18_plus && (
          <div className="mt16">
            <CheckRow checked={age} onChange={setAge}>
              {t("ob.c.age")}
            </CheckRow>
          </div>
        )}
        <button className="lnk mt16" type="button" onClick={() => setPolicy(true)}>
          {t("p.cons.policy", { v: consent.current_policy_version })}
          <Icon name="chevR" size={14} />
        </button>
      </Sheet>
      {policy && <PolicySheet version={consent.current_policy_version} onClose={() => setPolicy(false)} />}
    </>
  );
}

/* ---------- quiet hours / digest time ---------- */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function NotifTimeSheet({ kind, onClose }: { kind: "quiet" | "digest"; onClose: () => void }) {
  const { api, profile, setProfile } = useApp();
  const { t } = useI18n();
  const errText = useErrorText();
  const n = profile?.notifications;
  const [quietOn, setQuietOn] = useState(!!n?.quiet_hours);
  const [from, setFrom] = useState(n?.quiet_hours?.start ?? "23:00");
  const [to, setTo] = useState(n?.quiet_hours?.end ?? "08:00");
  const [digest, setDigest] = useState(n?.digest_time ?? "09:00");
  const [busy, setBusy] = useState(false);
  const ok = kind === "quiet" ? !quietOn || (TIME.test(from) && TIME.test(to) && from !== to) : TIME.test(digest);

  const save = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      const patch: Partial<NotificationSettings> = kind === "quiet" ? { quiet_hours: quietOn ? { start: from, end: to } : null } : { digest_time: digest };
      setProfile(await api.profile.settings({ notifications: patch }));
      showToast(t("toast.prefSaved"));
      onClose();
    } catch (e) {
      showToast(errText(e), "alert");
    } finally {
      setBusy(false);
    }
  };
  useMainButton({ text: t("common.save"), onClick: () => void save(), disabled: !ok, progress: busy });

  return (
    <Sheet title={kind === "quiet" ? t("p.edit.h.quiet") : t("p.edit.h.digest")} sub={t("p.edit.tz", { tz: n?.timezone ?? "Asia/Tashkent" })} onClose={onClose}>
      {kind === "quiet" ? (
        <>
          <div className="trow">
            <div className="trow-t">
              <b>{t("p.edit.quiet.on")}</b>
              <small>{t("p.n.quietSub")}</small>
            </div>
            <Switch on={quietOn} onChange={setQuietOn} label={t("p.edit.quiet.on")} />
          </div>
          {quietOn && (
            <div className="ob-grid c2 mt12">
              <div>
                <label className="field-l" htmlFor="qFrom">
                  {t("p.edit.quiet.from")}
                </label>
                <div className="field">
                  <input id="qFrom" type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="field-l" htmlFor="qTo">
                  {t("p.edit.quiet.to")}
                </label>
                <div className="field">
                  <input id="qTo" type="time" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <label className="field-l" htmlFor="dAt">
            {t("p.edit.digest.at")}
          </label>
          <div className="field">
            <input id="dAt" type="time" value={digest} onChange={(e) => setDigest(e.target.value)} />
          </div>
          <p className="hint mt8">{t("p.n.digestSub")}</p>
        </>
      )}
    </Sheet>
  );
}

/* ---------- delete profile: PIN or the confirm word → «Запрос принят» ---------- */
export function DeleteSheet({ onClose, onForgot }: { onClose: () => void; onForgot: () => void }) {
  const { api, session, deletionAccepted } = useApp();
  const { t, fmt } = useI18n();
  const errText = useErrorText();
  const sec = session.security;
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [s, dispatch] = useReducer(pinReducer, initialPinFlow("unlock", (sec.pin_length ?? 4) as PinLength));
  const [lockedUntil, setLockedUntil] = useState<number | null>(() => (sec.locked_until ? Date.parse(sec.locked_until) : null));
  const wait = useCountdown(lockedUntil);
  // sprint 9: 429 of the PIN policy — the keypad waits with a countdown
  const rl = useRateWait([PIN_POLICY]);
  const target = t("del.word");
  // contract: confirm_word = "УДАЛИТЬ" | "DELETE" (both accepted whatever the UI language)
  const wordOk = [target, translate("ru", "del.word"), translate("en", "del.word")].includes(word.trim().toUpperCase());

  const submit = async (req: { pin?: string; confirm_word?: string }) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.profile.requestDeletion(req);
      haptic.notify("success");
      deletionAccepted(r);
    } catch (e) {
      if (rateLimits.note(e, PIN_POLICY)) {
        // 429: not a wrong PIN — dots back to neutral, the countdown is the message
        setMsg(null);
        if (req.pin) dispatch({ type: "neutral" });
        return;
      }
      haptic.notify("error");
      if (e instanceof ApiError && e.code === "PIN_LOCKED") setLockedUntil(Date.now() + (e.retryAfter ?? 300) * 1000);
      setMsg(errText(e));
      if (req.pin) {
        dispatch({ type: "fail", err: errText(e) });
        setTimeout(() => dispatch({ type: "settle" }), 600);
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (sec.pin_enabled && pinFull(s) && !s.busy && !s.shake && !busy) void submit({ pin: s.entry });
    // submit once per full entry
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.entry]);
  useKeypadKeys((d) => dispatch({ type: "digit", d }), () => dispatch({ type: "erase" }), sec.pin_enabled && wait === 0 && rl.left === 0);

  return (
    <Sheet
      title={t("del.t")}
      onClose={onClose}
      foot={
        sec.pin_enabled ? undefined : (
          <button className="btn btn-danger grow" type="button" disabled={!wordOk || busy} onClick={() => void submit({ confirm_word: word.trim().toUpperCase() })}>
            <Icon name="trash" size={16} />
            {t("del.go")}
          </button>
        )
      }
    >
      <div className="del-sec" data-testid="delete-sheet">
        <h3>{t("del.rm")}</h3>
        <ul className="del-list rm">
          {([1, 2, 3, 4] as const).map((n) => (
            <li key={n}>
              <Icon name="x" size={16} />
              <span>{t(`del.rm${n}`)}</span>
            </li>
          ))}
        </ul>
        <h3>{t("del.keep")}</h3>
        <ul className="del-list keep">
          {([1, 2] as const).map((n) => (
            <li key={n}>
              <Icon name="shield" size={16} />
              <span>{t(`del.keep${n}`)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt16">
        {sec.pin_enabled ? (
          <>
            <p className="field-l">{t("del.confirmPin")}</p>
            <div className="pin-sheet">
              <p className={msg || wait || rl.left ? "hint bad" : "hint"} aria-live="polite">
                <TickingText ticking={wait > 0 || rl.left > 0} text={wait ? t("pin.lock.wait", { time: fmt.mmss(wait) }) : rl.left ? t("err.RATE_LIMITED.wait", { n: rl.left }) : (msg ?? " ")} />
              </p>
              <PinDots filled={s.entry.length} total={pinNeed(s)} error={s.shake} />
              <Keypad onDigit={(d) => dispatch({ type: "digit", d })} onErase={() => dispatch({ type: "erase" })} disabled={wait > 0 || rl.left > 0 || busy} eraseLabel={t("kp.del")} />
              <button className="pin-forgot sm" type="button" onClick={onForgot}>
                {t("del.forgot")}
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="field-l" htmlFor="delWord">
              {t("del.confirmWord", { w: target })}
            </label>
            <div className="field">
              <input id="delWord" className="typed" autoComplete="off" maxLength={10} value={word} onChange={(e) => setWord(e.target.value.slice(0, 10))} />
            </div>
            {msg && <p className="hint bad mt8">{msg}</p>}
          </>
        )}
      </div>
    </Sheet>
  );
}

/* ---------- Remote Experience Config (read-only; rollback lives in Admin) ---------- */
export function ConfigSheet({ onClose }: { onClose: () => void }) {
  const { config, configSource } = useApp();
  const { t } = useI18n();
  const view = {
    version: config.version,
    source: configSource,
    theme: { id: config.theme.id, version: config.theme.version, tokens: Object.keys(config.theme.tokens).length },
    home: {
      welcome_mode: config.home.welcome_mode,
      sections: config.home.sections.map((s) => ({ type: s.type, key: s.key, variant: s.variant, enabled: s.enabled })),
    },
  };
  return (
    <Sheet title={t("p.cfg.t")} sub={t("p.cfg.p")} onClose={onClose}>
      <div className="cfg">
        <pre>{JSON.stringify(view, null, 2)}</pre>
      </div>
    </Sheet>
  );
}
