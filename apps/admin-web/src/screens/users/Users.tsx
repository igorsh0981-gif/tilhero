import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminUserRow, AppUserStatus } from "@tilhero/contracts/admin";
import { Users as UsersApi, type UserFilters } from "../../api/endpoints";
import { useI18n } from "../../i18n";
import { shortId } from "../../lib/ids";
import { Icon } from "../../ui/Icon";
import { Btn, Callout, Empty, Pill, Select, Spinner, type Tone } from "../../ui/kit";
import { errText } from "../../ui/errors";
import { UserCard } from "./UserCard";

export const USER_TONE: Record<AppUserStatus, Tone> = { ACTIVE: "good", DISABLED: "bad", DELETION_REQUESTED: "warn", DELETED: "neutral" };
const STATUSES: readonly AppUserStatus[] = ["ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED"];

export function UserStatusPill({ s }: { s: AppUserStatus }) {
  const { t } = useI18n();
  return (
    <Pill tone={USER_TONE[s] ?? "neutral"} title={s}>
      {t(`ustatus.${s}`)}
    </Pill>
  );
}

/** `openId` (deep link #/users/<user_id>, e.g. from a support ticket) opens that user's card. */
export function Users({ openId = null }: { openId?: string | null }) {
  const i = useI18n();
  const { t, fmt } = i;
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [locale, setLocale] = useState("");
  const [openOnly, setOpenOnly] = useState(false);
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(openId);
  useEffect(() => setOpen(openId), [openId]);
  const reqId = useRef(0);

  const load = useCallback(
    async (f: UserFilters, append: boolean) => {
      const id = ++reqId.current;
      setLoading(true);
      setErr(null);
      try {
        const page = await UsersApi.list(f);
        if (id !== reqId.current) return;
        setRows((r) => (append ? [...r, ...page.items] : page.items));
        setCursor(page.next_cursor);
      } catch (e) {
        if (id === reqId.current) setErr(errText(i, e));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [i],
  );

  const filters: UserFilters = { q: q.trim() || undefined, status: status || undefined, locale: locale || undefined, has_open_tickets: openOnly || undefined };
  const fKey = JSON.stringify(filters);
  useEffect(() => {
    const tm = setTimeout(() => void load(JSON.parse(fKey) as UserFilters, false), q ? 300 : 0);
    return () => clearTimeout(tm);
    // q is part of fKey; the debounce only applies to typing
  }, [fKey, load, q]);

  const reset = () => {
    setQ("");
    setStatus("");
    setLocale("");
    setOpenOnly(false);
  };

  return (
    <div data-testid="users">
      <div className="page-head">
        <div className="lead">
          <p>{t("users.lead")}</p>
        </div>
      </div>
      <div className="toolbar">
        <div className="input-wrap">
          <Icon name="search" />
          <input className="input" type="search" placeholder={t("users.searchPh")} aria-label={t("users.searchPh")} value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} data-testid="users-q" />
        </div>
        <Select
          id="users-status"
          label={t("col.status")}
          value={status}
          onChange={setStatus}
          options={[{ v: "", label: t("users.allStatuses") }, ...STATUSES.map((s) => ({ v: s, label: t(`ustatus.${s}`) }))]}
        />
        <Select
          id="users-locale"
          label={t("common.language")}
          value={locale}
          onChange={setLocale}
          options={[
            { v: "", label: t("users.allLangs") },
            { v: "ru", label: "RU" },
            { v: "en", label: "EN" },
          ]}
        />
        <label className="check" htmlFor="users-open">
          <input type="checkbox" id="users-open" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          <span>{t("users.hasOpen")}</span>
        </label>
        <span className="grow" />
        <Btn kind="ghost" size="sm" label={t("common.resetFilters")} onClick={reset} />
      </div>
      {err && (
        <div className="mb-12">
          <Callout kind="bad" icon="alertCircle">
            {err}
          </Callout>
        </div>
      )}
      <section className="panel" aria-label={t("page.users")}>
        <div className="table-wrap">
          <table className="tbl" data-testid="users-table">
            <thead>
              <tr>
                <th>User ID</th>
                <th>Telegram</th>
                <th>{t("col.status")}</th>
                <th>{t("users.col.onboarding")}</th>
                <th className="r">{t("users.col.tickets")}</th>
                <th>{t("common.language")}</th>
                <th>{t("users.col.registered")}</th>
                <th>{t("users.col.lastSeen")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr
                  key={u.user_id}
                  className="is-click"
                  tabIndex={0}
                  aria-label={t("common.openRow", { x: u.username ? `@${u.username}` : shortId(u.user_id) })}
                  onClick={() => setOpen(u.user_id)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(u.user_id))}
                >
                  <td>
                    <span className="uid" title={u.user_id}>
                      {shortId(u.user_id, 8, 4)}
                    </span>
                  </td>
                  <td>
                    <div className="cell-main">{u.username ? `@${u.username}` : <span className="muted">{t("users.noUsername")}</span>}</div>
                    <div className="cell-sub">
                      {u.display_name ? `${u.display_name} · ` : ""}
                      <span className="masked" data-testid="tg-masked">
                        {u.telegram_id_masked}
                      </span>
                    </div>
                  </td>
                  <td>
                    <UserStatusPill s={u.status} />
                  </td>
                  <td>{u.onboarding_completed ? <Pill tone="good">{t("users.onbDone")}</Pill> : <Pill>{t("users.onbNot")}</Pill>}</td>
                  <td className="r">
                    {u.open_tickets ? <Pill tone="warn">{u.open_tickets}</Pill> : <span className="muted">0</span>}
                    <span className="xs muted"> / {u.tickets_total}</span>
                  </td>
                  <td className="mono">{u.locale ?? "—"}</td>
                  <td className="nowrap">{fmt.date(u.created_at)}</td>
                  <td className="nowrap">{u.last_seen_at ? fmt.rel(u.last_seen_at) : <span className="muted">{"—"}</span>}</td>
                </tr>
              ))}
              {!loading && !rows.length && !err && (
                <tr>
                  <td colSpan={8} className="empty-cell">
                    <Empty icon="search" title={t("users.empty.t")} text={t("users.empty.m")} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && <Spinner label={t("common.loading")} />}
        <div className="pager">
          <span>{t("users.shown", { n: rows.length })}</span>
          {cursor && !loading && <Btn size="sm" label={t("common.loadMore")} icon="down" onClick={() => void load({ ...filters, cursor }, true)} testId="users-more" />}
        </div>
      </section>
      <p className="xs muted foot-note">
        <Icon name="lock" /> {t("users.piiNote")}
      </p>
      {open && <UserCard id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
