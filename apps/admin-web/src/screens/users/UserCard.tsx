import { useEffect, useState } from "react";
import type { AdminUserCard } from "@tilhero/contracts/admin";
import { Users as UsersApi } from "../../api/endpoints";
import { useI18n, fmtCountdown } from "../../i18n";
import { shortId } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { Btn, Callout, CopyBtn, cx, Empty, FieldErr, Pill, Select, Spinner, TabPanel, Tabs } from "../../ui/kit";
import { Drawer } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errMeta, errText } from "../../ui/errors";
import { UserStatusPill } from "./Users";
import { UserAiTab } from "./UserAi";

type Tab = "overview" | "ai" | "consents" | "security" | "tickets";
type RevealReason = "ticket" | "incident" | "regulator";

/** Telegram ID reveal: users.sensitive.read + reason → value for `expires_in` seconds (default 60), then hidden. */
function Reveal({ card }: { card: AdminUserCard }) {
  const i = useI18n();
  const { t } = i;
  const { can } = useSession();
  const toast = useToast();
  const [form, setForm] = useState(false);
  const [kind, setKind] = useState<RevealReason>("ticket");
  const [ref, setRef] = useState(card.tickets[0]?.number ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ value: string; until: number } | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!shown) return;
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= shown.until) setShown(null); // the value is dropped from memory, not just hidden
    }, 250);
    return () => clearInterval(id);
  }, [shown]);

  const submit = async () => {
    const r = ref.trim();
    if (r.length < 3) {
      setErr(t("reveal.errRef"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await UsersApi.reveal(card.user_id, `${kind}: ${r}`.slice(0, 200));
      setShown({ value: res.value, until: Date.now() + Math.max(1, res.expires_in || 60) * 1000 });
      setNow(Date.now());
      setForm(false);
      toast(t("reveal.logged"), "info", "sensitive.view");
    } catch (e) {
      setErr(errText(i, e));
      if (!(e as { cancelled?: boolean }).cancelled) toast(errText(i, e), "err", errMeta(e));
    } finally {
      setBusy(false);
    }
  };

  if (shown)
    return (
      <div className="reveal-box" data-testid="reveal-box">
        <Icon name="eye" />
        <span className="mono" data-testid="reveal-value">
          {shown.value}
        </span>
        <span className="xs cd">
          {t("reveal.hidesIn")}{" "}
          <b className="mono" data-testid="reveal-countdown">
            {fmtCountdown(Math.max(0, shown.until - now))}
          </b>
        </span>
        <Btn size="xs" label={t("reveal.hide")} onClick={() => setShown(null)} />
      </div>
    );

  return (
    <div>
      <div className="row">
        <span className="masked" data-testid="card-tg-masked">
          {card.telegram_id_masked}
        </span>
        {!form && <Btn size="xs" icon="eye" label={t("reveal.btn")} perm="users.sensitive.read" onClick={() => setForm(true)} testId="reveal-start" />}
      </div>
      {form && can("users.sensitive.read") && (
        <div className="panel mt-8" data-testid="reveal-form">
          <div className="panel-b stack sm">
            <div className="field">
              <label htmlFor="rv-kind" className="req">
                {t("reveal.reason")}
              </label>
              <Select<RevealReason>
                id="rv-kind"
                label={t("reveal.reason")}
                value={kind}
                onChange={setKind}
                options={(["ticket", "incident", "regulator"] as const).map((v) => ({ v, label: t(`reveal.kind.${v}`) }))}
              />
            </div>
            <div className="field">
              <label htmlFor="rv-ref" className="req">
                {t("reveal.ref")}
              </label>
              <input id="rv-ref" className={cx("input mono", err && "is-invalid")} value={ref} maxLength={64} placeholder="TCK-3081" onChange={(e) => setRef(e.target.value)} autoFocus />
              <span className="hint">{t("reveal.refHint")}</span>
            </div>
            <FieldErr msg={err} />
            <div className="row">
              <Btn kind="primary" size="sm" label={t("reveal.go")} busy={busy} onClick={() => void submit()} testId="reveal-confirm" />
              <Btn kind="ghost" size="sm" label={t("common.cancel")} onClick={() => setForm(false)} />
            </div>
            <p className="xs muted">{t("reveal.auditNote")}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function UserCard({ id, onClose }: { id: string; onClose: () => void }) {
  const i = useI18n();
  const { t, fmt, lang } = i;
  const { can } = useSession();
  const { navigate } = useNav();
  const [card, setCard] = useState<AdminUserCard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    let alive = true;
    UsersApi.card(id)
      .then((c) => alive && setCard(c))
      .catch((e) => alive && setErr(errText(i, e)));
    return () => {
      alive = false;
    };
  }, [id, i]);

  const yes = (v: boolean) => (v ? <Pill tone="good">{t("common.yes")}</Pill> : <Pill>{t("common.no")}</Pill>);

  return (
    <Drawer
      wide
      testId="user-card"
      onClose={onClose}
      title={
        card ? (
          <>
            <span className="mono">{shortId(card.user_id, 8, 4)}</span> · {card.username ? `@${card.username}` : card.display_name ?? t("users.noUsername")}
          </>
        ) : (
          t("users.card")
        )
      }
      sub={
        card && (
          <>
            <UserStatusPill s={card.status} />
            <span>{t("users.planFree")}</span>
            <span>
              · {t("users.col.registered")} {fmt.date(card.created_at)}
            </span>
          </>
        )
      }
      tabs={
        card && (
          <Tabs<Tab>
            id="user"
            label={t("users.card")}
            className="drawer-tabs"
            value={tab}
            onChange={setTab}
            items={[
              { v: "overview", label: t("users.tab.overview") },
              { v: "ai", label: t("users.tab.ai"), testId: "user-tab-ai" },
              { v: "consents", label: t("users.tab.consents") },
              { v: "security", label: t("users.tab.security") },
              { v: "tickets", label: t("users.tab.tickets"), cnt: card.tickets.length },
            ]}
          />
        )
      }
    >
      {err && (
        <Callout kind="bad" icon="alertCircle">
          {err}
        </Callout>
      )}
      {!card && !err && <Spinner label={t("common.loading")} />}
      {card && (
        <TabPanel id="user" value={tab}>
          {tab === "overview" && (
            <div className="stack">
              <dl className="dl">
                <dt>TilHero user ID</dt>
                <dd>
                  <span className="uid">{card.user_id}</span> <CopyBtn value={card.user_id} label="user ID" />
                </dd>
                <dt>{t("users.f.name")}</dt>
                <dd>
                  {card.display_name ?? "—"} · {card.username ? `@${card.username}` : <span className="muted">{t("users.noUsername")}</span>}
                </dd>
                <dt>Telegram ID</dt>
                <dd>
                  <Reveal card={card} />
                </dd>
                <dt>{t("common.language")}</dt>
                <dd className="mono">{card.locale ?? "—"}</dd>
                <dt>{t("col.status")}</dt>
                <dd>
                  <UserStatusPill s={card.status} />
                </dd>
                <dt>{t("users.col.registered")}</dt>
                <dd>{fmt.dateTime(card.created_at)}</dd>
                <dt>{t("users.col.lastSeen")}</dt>
                <dd>{card.last_seen_at ? `${fmt.dateTime(card.last_seen_at)} · ${fmt.rel(card.last_seen_at)}` : "—"}</dd>
                <dt>{t("users.f.plan")}</dt>
                <dd>
                  {t("users.planFree")} <span className="xs muted">· {t("users.planNote")}</span>
                </dd>
              </dl>
              {card.access_level && (
                <p className="small row" data-testid="card-access-brief">
                  <Icon name="layers" /> {t("users.ai.level", { l: lang === "ru" ? card.access_level.level_name : card.access_level.level_name_en, n: card.access_level.limits.concierge_messages_per_day })}
                  <button type="button" className="link-btn" onClick={() => setTab("ai")}>
                    {t("users.ai.more")}
                  </button>
                </p>
              )}
              <p className="xs muted">{t("users.refreshed", { t: fmt.dateTime(card.refreshed_at) })}</p>
            </div>
          )}
          {tab === "ai" && <UserAiTab card={card} onAccess={(a) => setCard({ ...card, access_level: a })} />}
          {tab === "consents" && (
            <div className="stack">
              <dl className="dl">
                <dt>{t("users.c.policy")}</dt>
                <dd>{card.consent.policy_version ? <span className="code-chip">{card.consent.policy_version}</span> : "—"}</dd>
                <dt>accepted_at</dt>
                <dd className="mono">{card.consent.accepted_at ? fmt.dateTime(card.consent.accepted_at) : "—"}</dd>
                <dt>{t("users.c.age")}</dt>
                <dd>{yes(card.consent.age_confirmed_18_plus)}</dd>
                <dt>purposes</dt>
                <dd>
                  {card.consent.purposes.length ? (
                    <ul className="ent-list">
                      {card.consent.purposes.map((p) => (
                        <li key={p}>
                          <span className="on">
                            <Icon name="checkCircle" />
                          </span>
                          <span className="mono">{p}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "—"
                  )}
                </dd>
                <dt>revoked_at</dt>
                <dd className="mono">{card.consent.revoked_at ? fmt.dateTime(card.consent.revoked_at) : "—"}</dd>
              </dl>
              <Callout icon="info">{t("users.c.note")}</Callout>
            </div>
          )}
          {tab === "security" && (
            <div className="stack">
              <dl className="dl">
                <dt>{t("users.s.pin")}</dt>
                <dd>{yes(card.security.pin_enabled)}</dd>
                <dt>{t("users.s.bio")}</dt>
                <dd>{yes(card.security.biometric_enabled)}</dd>
                <dt>{t("users.s.onboarding")}</dt>
                <dd>{yes(card.preferences.onboarding_completed)}</dd>
                <dt>{t("users.s.prefsUpdated")}</dt>
                <dd>{card.preferences.updated_at ? fmt.dateTime(card.preferences.updated_at) : "—"}</dd>
                <dt>{t("users.s.changed")}</dt>
                <dd>
                  {card.preferences.changed_fields.length ? (
                    <span className="row">
                      {card.preferences.changed_fields.map((f) => (
                        <span key={f} className="tag">
                          {f}
                        </span>
                      ))}
                    </span>
                  ) : (
                    "—"
                  )}
                </dd>
              </dl>
              <Callout icon="shield">{t("users.s.note")}</Callout>
            </div>
          )}
          {tab === "tickets" &&
            (card.tickets.length ? (
              <div className="table-wrap">
                <table className="tbl compact" data-testid="user-tickets">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>{t("col.subject")}</th>
                      <th>{t("col.status")}</th>
                      <th>{t("col.created")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {card.tickets.map((tk) => (
                      <tr
                        key={tk.ticket_id}
                        className={can("support.read") ? "is-click" : undefined}
                        tabIndex={can("support.read") ? 0 : undefined}
                        onClick={() => can("support.read") && (onClose(), navigate("support", tk.number))}
                      >
                        <td className="mono">{tk.number}</td>
                        <td>{tk.subject}</td>
                        <td>
                          <Pill>{t(`tstatus.${tk.status as "NEW"}`)}</Pill>
                        </td>
                        <td className="nowrap">{fmt.dateTime(tk.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="support" title={t("users.noTickets")} />
            ))}
        </TabPanel>
      )}
    </Drawer>
  );
}
