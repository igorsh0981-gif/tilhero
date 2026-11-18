/**
 * «Ученики» (users.read): registry of learners from user-admin (accounts 14+ / guardians and child profiles 6–13) with
 * filters, and the learner card (#/users/<user_id>): account and children or guardian, consents, plan and schedule,
 * notification settings, tickets. PII is masked everywhere; the full Telegram ID is shown only after a reveal with a
 * reason (users.sensitive.read, step-up, audit `sensitive.view`) and only for 60 seconds.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { AdminLearnerCard, AdminLearnerRow, AgeBand, LearnerKind, LearnerStatus, UiLang } from "@tilhero/contracts/admin";
import { Learners, type LearnerFilters } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, fmtCountdown } from "../../i18n";
import { shortId } from "../../lib/ids";
import { tgHandle } from "../../lib/tg";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Select, Spinner, TabPanel, Tabs, type Tone } from "../../ui/kit";
import { Drawer } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errMeta, errText } from "../../ui/errors";

export const LEARNER_STATUSES: readonly LearnerStatus[] = ["ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED"];
export const AGE_BANDS: readonly AgeBand[] = ["6-9", "10-13", "14-17", "18+"];
const STATUS_TONE: Record<LearnerStatus, Tone> = { ACTIVE: "good", DISABLED: "bad", DELETION_REQUESTED: "warn", DELETED: "neutral" };
const CONSENT_TONE = { not_required: "neutral", pending: "warn", granted: "good", declined: "bad" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function LearnerStatusPill({ s }: { s: LearnerStatus }) {
  const { t } = useI18n();
  return (
    <Pill tone={STATUS_TONE[s] ?? "neutral"} title={s}>
      {t(`lstatus.${s}`)}
    </Pill>
  );
}

function KindTag({ r }: { r: Pick<AdminLearnerRow, "kind" | "age_band"> }) {
  const { t } = useI18n();
  return (
    <span className={cx("tag plain", r.kind === "child" && "kid")}>
      {r.kind === "child" ? t("lk.child") : t("lk.account")}
      {r.age_band ? ` · ${r.age_band}` : ""}
    </span>
  );
}

const nameOf = (r: Pick<AdminLearnerRow, "display_name" | "username">, fallback: string) => r.display_name || (r.username ? tgHandle(r.username) : fallback);

/* ---------------------------------------------------------------- page: list + card */

export function LearnersPage({ openId = null }: { openId?: string | null }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { navigate } = useNav();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<LearnerKind | "">("");
  const [age, setAge] = useState<AgeBand | "">("");
  const [status, setStatus] = useState<LearnerStatus | "">("");
  const [locale, setLocale] = useState<UiLang | "">("");
  const [openOnly, setOpenOnly] = useState(false);
  const [rows, setRows] = useState<AdminLearnerRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const reqId = useRef(0);

  const load = useCallback(async (f: LearnerFilters, append: boolean) => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const page = await Learners.list(f);
      if (id !== reqId.current) return;
      setRows((r) => (append ? [...r, ...page.items] : page.items));
      setCursor(page.next_cursor);
      setError(null);
    } catch (e) {
      if (id === reqId.current) setError(e);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  const filters: LearnerFilters = { q: q.trim() || undefined, kind, age_band: age, status, locale, has_open_tickets: openOnly || null };
  const fKey = JSON.stringify(filters);
  useEffect(() => {
    const tm = setTimeout(() => void load(JSON.parse(fKey) as LearnerFilters, false), q ? 300 : 0);
    return () => clearTimeout(tm);
  }, [fKey, load, q]);

  const reset = () => {
    setQ("");
    setKind("");
    setAge("");
    setStatus("");
    setLocale("");
    setOpenOnly(false);
  };
  const open = (id: string) => navigate("users", id);
  const cardId = openId && UUID.test(openId) ? openId : null;

  return (
    <div className="stack" data-testid="learners">
      <p className="sub page-lead">{t("lr.lead")}</p>
      <div className="toolbar" role="search">
        <div className="input-wrap grow-2">
          <Icon name="search" />
          <input className="input" type="search" placeholder={t("lr.searchPh")} aria-label={t("lr.search")} value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} data-testid="lr-q" />
        </div>
        <Select<LearnerKind | ""> id="lr-kind" label={t("lr.kind")} value={kind} onChange={setKind} testId="lr-kind" options={[{ v: "", label: t("lr.allKinds") }, { v: "account", label: t("lk.account") }, { v: "child", label: t("lk.child") }]} />
        <Select<AgeBand | ""> id="lr-age" label={t("lr.age")} value={age} onChange={setAge} options={[{ v: "", label: t("lr.allAges") }, ...AGE_BANDS.map((a) => ({ v: a, label: a }))]} />
        <Select<UiLang | ""> id="lr-lang" label={t("lr.lang")} value={locale} onChange={setLocale} options={[{ v: "", label: t("lr.allLangs") }, { v: "ru", label: t("ulang.ru") }, { v: "uz", label: t("ulang.uz") }]} />
        <Select<LearnerStatus | ""> id="lr-status" label={t("col.status")} value={status} onChange={setStatus} options={[{ v: "", label: t("lr.allStatuses") }, ...LEARNER_STATUSES.map((s) => ({ v: s, label: t(`lstatus.${s}`) }))]} />
        <label className="check" htmlFor="lr-open">
          <input type="checkbox" id="lr-open" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          <span>{t("lr.hasOpen")}</span>
        </label>
        <Btn kind="ghost" size="sm" label={t("common.resetFilters")} onClick={reset} />
      </div>
      {error ? <LoadError error={error} onRetry={() => void load(filters, false)} /> : null}
      <section className="panel" aria-label={t("page.users")}>
        <div className="table-wrap">
          <table className="tbl" data-testid="learners-table">
            <caption className="sr-only">{t("page.users")}</caption>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">{t("lr.col.profile")}</th>
                <th scope="col">{t("lr.col.lang")}</th>
                <th scope="col">{t("lr.col.consent")}</th>
                <th scope="col">{t("lr.col.activity")}</th>
                <th scope="col" className="r">
                  {t("lr.col.tickets")}
                </th>
                <th scope="col">{t("col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.user_id} data-learner={r.user_id}>
                  <td className="nowrap">
                    <button type="button" className="tr mono" onClick={() => open(r.user_id)} aria-label={t("lr.openCard", { x: nameOf(r, shortId(r.user_id, 8, 4)) })} data-testid={`lr-open-${r.user_id}`}>
                      {shortId(r.user_id, 8, 4)}
                    </button>
                  </td>
                  <td>
                    <div className="cell-main">{nameOf(r, t("lr.noName"))}</div>
                    <div className="cell-sub">
                      <KindTag r={r} />
                      {r.kind === "account" && r.children_count > 0 && <span> · {t("lr.childrenN", { n: r.children_count })}</span>}
                      {r.telegram_id_masked && <span className="masked"> · {r.telegram_id_masked}</span>}
                    </div>
                  </td>
                  <td className="nowrap">{r.locale ? t(`ulang.${r.locale}`) : "—"}</td>
                  <td>
                    <Pill tone={CONSENT_TONE[r.guardian_consent]}>{t(`gc.${r.guardian_consent}`)}</Pill>
                  </td>
                  <td className="nowrap">
                    <div>{r.last_activity_at ? fmt.rel(r.last_activity_at) : t("lr.never")}</div>
                    <div className="cell-sub">{r.onboarding_completed ? t("lr.onboarded") : t("lr.notOnboarded")}</div>
                  </td>
                  <td className="r nowrap">
                    {r.open_tickets ? <Pill tone="warn">{t("lr.openN", { n: r.open_tickets })}</Pill> : <span className="muted">{r.tickets_total || "—"}</span>}
                  </td>
                  <td>
                    <LearnerStatusPill s={r.status} />
                  </td>
                </tr>
              ))}
              {!loading && !rows.length && !error && (
                <tr>
                  <td colSpan={7} className="empty-cell">
                    <Empty icon="users" title={t("common.nothingFound")} text={t("common.changeFilters")} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && <Spinner label={t("common.loading")} />}
        <div className="pager">
          <span>{t("lr.foot", { n: rows.length })}</span>
          {cursor && !loading && <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load({ ...filters, cursor }, true)} />}
        </div>
      </section>
      {cardId && <LearnerCard key={cardId} id={cardId} onClose={() => navigate("users")} onOpen={open} />}
    </div>
  );
}

/* ---------------------------------------------------------------- reveal (users.sensitive.read, step-up, 60 s) */

type RevealKind = "ticket" | "incident" | "request";

export function RevealTelegramId({ card }: { card: Pick<AdminLearnerCard, "user_id" | "kind" | "telegram_id_masked" | "tickets"> }) {
  const i = useI18n();
  const { t } = i;
  const { can } = useSession();
  const toast = useToast();
  const [form, setForm] = useState(false);
  const [kind, setKind] = useState<RevealKind>("ticket");
  const [reason, setReason] = useState(() => (card.tickets?.[0] ? `${card.tickets[0].number}: ` : ""));
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
    const drop = () => document.visibilityState === "hidden" && setShown(null);
    document.addEventListener("visibilitychange", drop);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", drop);
    };
  }, [shown]);

  if (card.kind === "child") return <span className="muted small">{t("rv.child")}</span>;

  const submit = async () => {
    const text = `${t(`rv.kind.${kind}`)} — ${reason.trim()}`;
    if (reason.trim().length < 5) {
      setErr(t("rv.errReason", { n: 5 }));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await Learners.reveal(card.user_id, text.slice(0, 300));
      setShown({ value: res.value, until: Date.now() + Math.max(1, Math.min(res.expires_in || 60, 60)) * 1000 });
      setNow(Date.now());
      setForm(false);
      setReason("");
      toast(t("rv.logged"), "info", "sensitive.view");
    } catch (e) {
      if ((e as ApiError).cancelled) return setBusy(false);
      setErr(errText(i, e));
      toast(errText(i, e), "err", errMeta(e));
    } finally {
      setBusy(false);
    }
  };

  if (shown)
    return (
      <div className="reveal-box" role="status" data-testid="reveal-box">
        <Icon name="eye" />
        <span className="mono" data-testid="reveal-value">
          {shown.value}
        </span>
        <span className="xs cd">
          {t("rv.hidesIn")}{" "}
          <b className="mono" data-testid="reveal-countdown">
            {fmtCountdown(Math.max(0, shown.until - now))}
          </b>
        </span>
        <Btn size="xs" label={t("rv.hide")} onClick={() => setShown(null)} testId="reveal-hide" />
      </div>
    );

  return (
    <div>
      <div className="row">
        <span className="masked" data-testid="card-tg-masked">
          {card.telegram_id_masked ?? "—"}
        </span>
        {!form && card.telegram_id_masked && can("users.sensitive.read") && <Btn size="xs" icon="eye" label={t("rv.btn")} onClick={() => setForm(true)} testId="reveal-start" />}
      </div>
      {form && can("users.sensitive.read") && (
        <div className="reveal-form" data-testid="reveal-form">
          <div className="field">
            <label htmlFor="rv-kind">{t("rv.kind")}</label>
            <Select<RevealKind> id="rv-kind" label={t("rv.kind")} value={kind} onChange={setKind} options={(["ticket", "incident", "request"] as const).map((v) => ({ v, label: t(`rv.kind.${v}`) }))} />
          </div>
          <div className="field">
            <label htmlFor="rv-reason" className="req">
              {t("rv.reason")}
            </label>
            <textarea
              id="rv-reason"
              className={cx("textarea", err && "is-invalid")}
              rows={2}
              value={reason}
              maxLength={260}
              placeholder={t("rv.reasonPh")}
              aria-invalid={!!err || undefined}
              aria-describedby={err ? "rv-err" : "rv-hint"}
              onChange={(e) => {
                setReason(e.target.value);
                setErr(null);
              }}
              data-autofocus=""
              data-testid="reveal-reason"
            />
            <span className="hint" id="rv-hint">
              {t("rv.hint")}
            </span>
            <FieldErr msg={err} id="rv-err" />
          </div>
          <div className="row">
            <Btn kind="primary" size="sm" icon="eye" label={t("rv.go")} busy={busy} onClick={() => void submit()} testId="reveal-confirm" />
            <Btn kind="ghost" size="sm" label={t("common.cancel")} onClick={() => setForm(false)} />
          </div>
          <p className="xs muted row">
            <Icon name="smartphoneKey" /> {t("rv.auditNote")}
          </p>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- card */

type Tab = "account" | "consent" | "plan" | "notif" | "tickets";

export function LearnerCard({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const { navigate } = useNav();
  const [card, setCard] = useState<AdminLearnerCard | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>("account");

  const load = useCallback(() => {
    setError(null);
    Learners.card(id)
      .then(setCard)
      .catch(setError);
  }, [id]);
  useEffect(load, [load]);

  const yes = (v: boolean) => (v ? <Pill tone="good">{t("common.yes")}</Pill> : <Pill>{t("common.no")}</Pill>);
  const title = card ? nameOf(card, t("lr.noName")) : t("lr.card");

  return (
    <Drawer
      wide
      testId="learner-card"
      onClose={onClose}
      title={title}
      sub={
        card && (
          <>
            <span className="mono">{shortId(card.user_id, 8, 4)}</span>
            <KindTag r={card} />
            <LearnerStatusPill s={card.status} />
            <span>· {t("lr.refreshed", { t: fmt.dateTime(card.refreshed_at) })}</span>
          </>
        )
      }
      tabs={
        card && (
          <Tabs<Tab>
            id="learner"
            label={t("lr.card")}
            className="drawer-tabs"
            value={tab}
            onChange={setTab}
            items={[
              { v: "account", label: card.kind === "child" ? t("lr.tab.child") : t("lr.tab.account"), testId: "lc-tab-account" },
              { v: "consent", label: t("lr.tab.consent"), testId: "lc-tab-consent" },
              { v: "plan", label: t("lr.tab.plan"), testId: "lc-tab-plan" },
              { v: "notif", label: t("lr.tab.notif"), testId: "lc-tab-notif" },
              { v: "tickets", label: t("lr.tab.tickets"), cnt: card.tickets ? card.tickets.length : null, testId: "lc-tab-tickets" },
            ]}
          />
        )
      }
    >
      {error ? (
        error instanceof ApiError && error.status === 404 ? (
          <Empty icon="users" title={t("lr.notFound")} text={t("lr.notFoundM")} />
        ) : (
          <LoadError error={error} onRetry={load} />
        )
      ) : null}
      {!card && !error && <Spinner label={t("common.loading")} />}
      {card && (
        <TabPanel id="learner" value={tab}>
          {tab === "account" && (
            <div className="stack">
              <dl className="dl" data-testid="lc-account">
                <dt>{t("lr.f.name")}</dt>
                <dd>{card.display_name ?? <span className="muted">{t("lr.noName")}</span>}</dd>
                {card.kind === "account" && (
                  <>
                    <dt>Telegram</dt>
                    <dd data-testid="lc-username">{card.username ? tgHandle(card.username) : <span className="muted">—</span>}</dd>
                    <dt>Telegram ID</dt>
                    <dd>
                      <RevealTelegramId card={card} />
                    </dd>
                  </>
                )}
                <dt>{t("lr.f.age")}</dt>
                <dd>{card.age_band ?? <span className="muted">{t("lr.ageUnknown")}</span>}</dd>
                <dt>{t("lr.f.guardianConsent")}</dt>
                <dd>
                  <Pill tone={CONSENT_TONE[card.guardian_consent]}>{t(`gc.${card.guardian_consent}`)}</Pill>
                </dd>
                <dt>{t("lr.f.lang")}</dt>
                <dd>{card.locale ? t(`ulang.${card.locale}`) : "—"}</dd>
                <dt>{t("lr.f.pin")}</dt>
                <dd>
                  {card.security.pin_enabled ? t("lr.pinOn") : t("lr.pinOff")}
                  {card.security.pin_reset_pending && (
                    <>
                      {" "}
                      <Pill tone="warn">{t("lr.pinReset")}</Pill>
                    </>
                  )}
                </dd>
                <dt>{t("lr.f.created")}</dt>
                <dd>{fmt.dateTime(card.created_at)}</dd>
                <dt>{t("lr.f.activity")}</dt>
                <dd>{card.last_activity_at ? fmt.dateTime(card.last_activity_at) : t("lr.never")}</dd>
              </dl>
              {card.kind === "account" ? (
                <section aria-labelledby="lc-children-h">
                  <h3 className="h3" id="lc-children-h">
                    {t("lr.children")}
                  </h3>
                  {card.children.length ? (
                    <ul className="rel-list" data-testid="lc-children">
                      {card.children.map((c) => (
                        <li key={c.user_id}>
                          <button type="button" className="tr" onClick={() => onOpen(c.user_id)}>
                            {nameOf(c, t("lr.noName"))}
                          </button>
                          <span className="tag plain kid">{c.age_band ?? "—"}</span>
                          <LearnerStatusPill s={c.status} />
                          <span className="xs muted">{c.last_activity_at ? fmt.rel(c.last_activity_at) : t("lr.never")}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="sub">{t("lr.noChildren")}</p>
                  )}
                </section>
              ) : (
                <section aria-labelledby="lc-guardian-h">
                  <h3 className="h3" id="lc-guardian-h">
                    {t("lr.guardian")}
                  </h3>
                  {card.guardian ? (
                    <ul className="rel-list" data-testid="lc-guardian">
                      <li>
                        <button type="button" className="tr" onClick={() => onOpen(card.guardian!.user_id)}>
                          {nameOf(card.guardian, t("lr.noName"))}
                        </button>
                        {card.guardian.username && <span className="small muted">{tgHandle(card.guardian.username)}</span>}
                        <span className="masked">{card.guardian.telegram_id_masked}</span>
                        <LearnerStatusPill s={card.guardian.status} />
                      </li>
                    </ul>
                  ) : (
                    <p className="sub">—</p>
                  )}
                  <p className="xs muted mt-8">{t("lr.childNote")}</p>
                </section>
              )}
            </div>
          )}
          {tab === "consent" && (
            <dl className="dl" data-testid="lc-consent">
              <dt>{t("lr.c.policy")}</dt>
              <dd className="mono">{card.consent.policy_version ?? "—"}</dd>
              <dt>{t("lr.c.accepted")}</dt>
              <dd>{card.consent.accepted_at ? fmt.dateTime(card.consent.accepted_at) : "—"}</dd>
              <dt>{t("lr.c.basis")}</dt>
              <dd>{card.consent.basis ? t(`lr.basis.${card.consent.basis}`) : "—"}</dd>
              <dt>{t("lr.c.purposes")}</dt>
              <dd>
                {card.consent.purposes.length ? (
                  <span className="row">
                    {card.consent.purposes.map((p) => (
                      <span key={p} className="tag">
                        {p}
                      </span>
                    ))}
                  </span>
                ) : (
                  "—"
                )}
              </dd>
              <dt>{t("lr.c.revoked")}</dt>
              <dd>{card.consent.revoked_at ? <Pill tone="bad">{fmt.dateTime(card.consent.revoked_at)}</Pill> : t("common.no")}</dd>
              <dt>{t("lr.f.guardianConsent")}</dt>
              <dd>
                <Pill tone={CONSENT_TONE[card.guardian_consent]}>{t(`gc.${card.guardian_consent}`)}</Pill>
              </dd>
            </dl>
          )}
          {tab === "plan" &&
            (card.plan ? (
              <dl className="dl" data-testid="lc-plan">
                <dt>{t("lr.p.goal")}</dt>
                <dd>{card.plan.goal ? t(`goal.${card.plan.goal}`) : "—"}</dd>
                <dt>{t("lr.p.level")}</dt>
                <dd>{card.plan.level_self ? t(`lvl.${card.plan.level_self}`) : "—"}</dd>
                <dt>{t("lr.p.uiLang")}</dt>
                <dd>{card.plan.ui_lang ? t(`ulang.${card.plan.ui_lang}`) : "—"}</dd>
                <dt>{t("lr.p.schedule")}</dt>
                <dd>
                  {card.plan.schedule ? (
                    <>
                      {t(`preset.${card.plan.schedule.preset}`)} · {card.plan.schedule.days.map((d) => t(`dow.${d}` as "dow.1")).join(", ")}
                      <span className="block small muted">
                        {t("lr.p.time", { t: card.plan.schedule.preferred_time, m: card.plan.schedule.duration_min, tz: card.plan.schedule.timezone })}
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </dd>
                <dt>{t("lr.p.reminders")}</dt>
                <dd>{card.plan.schedule ? yes(card.plan.schedule.reminders_enabled) : "—"}</dd>
                <dt>{t("lr.p.onboarded")}</dt>
                <dd>{card.plan.onboarding_completed_at ? fmt.dateTime(card.plan.onboarding_completed_at) : <Pill tone="warn">{t("lr.notOnboarded")}</Pill>}</dd>
                <dt>{t("common.updated")}</dt>
                <dd>{card.plan.updated_at ? fmt.dateTime(card.plan.updated_at) : "—"}</dd>
              </dl>
            ) : (
              <Empty icon="calendar" title={t("lr.noPlan")} text={t("lr.noPlanM")} />
            ))}
          {tab === "notif" &&
            (card.notifications ? (
              <dl className="dl" data-testid="lc-notif">
                <dt>{t("lr.n.enabled")}</dt>
                <dd>{yes(card.notifications.enabled)}</dd>
                {(Object.keys(card.notifications.categories) as Array<keyof typeof card.notifications.categories>).map((c) => (
                  <Fragment key={c}>
                    <dt>{t(`ncat.${c}`)}</dt>
                    <dd>{yes(card.notifications!.categories[c])}</dd>
                  </Fragment>
                ))}
              </dl>
            ) : (
              <Empty icon="bell" title={t("lr.noNotif")} />
            ))}
          {tab === "tickets" &&
            (card.tickets == null ? (
              <Callout kind="info" icon="lock">
                {can("support.read") ? t("lr.ticketsDown") : t("perm.need", { p: "support.read" })}
              </Callout>
            ) : card.tickets.length ? (
              <div className="table-wrap">
                <table className="tbl compact" data-testid="lc-tickets">
                  <thead>
                    <tr>
                      <th scope="col">{t("col.ticket")}</th>
                      <th scope="col">{t("col.subject")}</th>
                      <th scope="col">{t("col.status")}</th>
                      <th scope="col">{t("col.created")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {card.tickets.map((x) => (
                      <tr key={x.ticket_id}>
                        <td className="nowrap">
                          {can("support.read") ? (
                            <button type="button" className="tr mono" onClick={() => navigate("support", x.number)}>
                              {x.number}
                            </button>
                          ) : (
                            <span className="mono">{x.number}</span>
                          )}
                        </td>
                        <td>{x.subject}</td>
                        <td>
                          <span className="tag plain">{t(`tstatus.${x.status}`)}</span>
                        </td>
                        <td className="nowrap small">{fmt.dateTime(x.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="support" title={t("lr.noTickets")} />
            ))}
          <p className="xs muted mt-16 row">
            <Icon name="shield" /> {t("lr.piiNote")}
          </p>
        </TabPanel>
      )}
    </Drawer>
  );
}
