/**
 * «Лиги и дуэли» (sprint 7, ADM-GAME-02, AT-74, AT-75, AT-80; league.read, commands — league.manage):
 * - «Лиги недели» — the general league 14+ by weeks of Tashkent (Monday): groups by pair and level band, sizes, the
 *   closing status, versions of the results and anomalies; a group — members with XP, place, prize and the anomaly
 *   mark, every version of its results (immutable: a re-evaluation creates version + 1 and keeps the previous one);
 *   the release of prizes held by an anomaly (a reason) and the re-evaluation — exclude members or recalculate
 *   (step-up, a reason; the prize difference goes by reversals and new operations);
 * - «Дуэли» — the list by status; a duel — the score of each side after the end, the result, a technical win, the
 *   deadlines, the XP operations (reversals included) and the history of results; the re-evaluation of a finished duel
 *   (step-up, a reason; the previous result is kept).
 * Leagues and duels give game rewards only: the learning state never changes here.
 * Routes: #/leagues[/groups[/<group_id>]] · #/leagues/duels[/<duel_id>].
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AdminDuel, AdminDuelRow, AdminLeagueGroup, AdminLeagueWeek, DuelReevaluateRequest, DuelResult } from "@tilhero/contracts/admin";
import type { DuelStatus } from "@tilhero/contracts/bff";
import { Leagues } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Select, Spinner, TabPanel, Tabs } from "../../ui/kit";
import { ConfirmCommand, Drawer, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { CommandKey } from "../memory/model";
import { Kpi } from "../game/parts";
import {
  canReevaluateDuel,
  canReevaluateGroup,
  canReleasePrizes,
  changedPlaces,
  DUEL_STATUSES,
  DUEL_TONE,
  duelReevalBody,
  EXCLUDE_MAX,
  excludable,
  GROUP_TONE,
  groupReevalBody,
  LEAGUE_TABS,
  parseLeagueRoute,
  previewPlaces,
  REASON_MAX,
  reevalSig,
  REASON_MIN,
  REEVAL_RESULTS,
  shiftWeek,
  weekLabel,
  weekOf,
  type Issue,
  type LeagueTab,
} from "./model";
import { NoteField, PrivacyNote, StepUpNote, staffName, useCmdFail, useSocIssue, UserRef } from "./parts";

export function LeaguesPage({ routeId }: { routeId: string | null }) {
  const { t } = useI18n();
  const { navigate } = useNav();
  const r = parseLeagueRoute(routeId);
  return (
    <div className="stack" data-testid="leagues">
      <Tabs<LeagueTab> id="lg" label={t("lgu.tabs")} value={r.tab} onChange={(v) => navigate("leagues", v)} items={LEAGUE_TABS.map((v) => ({ v, label: t(`lgu.tab.${v}` as MessageKey), icon: v === "groups" ? "podium" : "zap", testId: `lg-tab-${v}` }))} />
      <TabPanel id="lg" value={r.tab}>
        {r.tab === "groups" ? <GroupsTab openId={r.id} /> : <DuelsTab openId={r.id} />}
      </TabPanel>
      <Callout icon="info" testId="lg-separate">
        {t("lgu.separate")}
      </Callout>
    </div>
  );
}

/* ---------------------------------------------------------------- weeks and groups */

function GroupsTab({ openId }: { openId: string | null }) {
  const { t, fmt } = useI18n();
  const { navigate } = useNav();
  const current = useMemo(() => weekOf(), []);
  const [week, setWeek] = useState(current);
  const [w, setW] = useState<AdminLeagueWeek | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const req = useRef(0);
  const load = useCallback(() => {
    const id = ++req.current;
    Leagues.week(week)
      .then((x) => id === req.current && (setW(x), setError(null)))
      .catch((e) => id === req.current && setError(e));
  }, [week]);
  useEffect(load, [load, tick]);
  const shown = w && w.week === week ? w : null;
  return (
    <div className="stack" data-testid="lg-week">
      <div className="dash-head">
        <div className="row soc-weeknav" role="group" aria-label={t("lgu.weekNav")}>
          <Btn size="sm" icon="chevL" label={t("lgu.prev")} onClick={() => setWeek(shiftWeek(week, -1))} testId="lg-prev" />
          <b className="soc-week" data-testid="lg-week-label" data-week={week}>
            {t("lgu.weekOf", { w: weekLabel(week) })}
          </b>
          <Btn size="sm" icon="chevR" label={t("lgu.next")} disabled={week >= current} onClick={() => setWeek(shiftWeek(week, 1))} testId="lg-next" />
          {week !== current && <Btn size="sm" kind="ghost" label={t("lgu.current")} onClick={() => setWeek(current)} testId="lg-current" />}
        </div>
        <span className="grow" />
        <Btn size="sm" icon="refresh" label={t("common.refresh")} onClick={load} testId="lg-refresh" />
      </div>
      {error && !shown ? (
        <LoadError error={error} onRetry={load} />
      ) : !shown ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <>
          <div className="kpis" data-testid="lg-kpis">
            <Kpi label={t("lgu.status")} value={<Pill tone={shown.status === "open" ? "info" : "good"}>{t(`lgw.${shown.status}` as MessageKey)}</Pill>} note={t("lgu.ends", { t: fmt.dateTime(shown.ends_at) })} />
            <Kpi label={t("lgu.participants")} value={<span data-testid="lg-participants">{fmt.num(shown.participants)}</span>} note={t("lgu.groupsN", { n: shown.groups.length })} />
            <Kpi label={t("lgu.prizes")} value={<span data-testid="lg-prizes">{fmt.num(shown.prizes_til)}</span>} note={t("lgu.prizesNote")} />
            <Kpi label={t("lgu.anomalies")} value={<span data-testid="lg-anomalies">{fmt.num(shown.groups.reduce((a, g) => a + g.anomalies, 0))}</span>} note={t("lgu.heldN", { n: shown.groups.filter((g) => g.status === "held").length })} />
          </div>
          <section className="panel" aria-labelledby="lg-g-h" data-testid="lg-groups">
            <div className="panel-h">
              <h2 className="panel-t grow" id="lg-g-h">
                <Icon name="podium" /> {t("lgu.groups")}
              </h2>
            </div>
            {shown.groups.length ? (
              <div className="table-wrap">
                <table className="tbl compact soc-tbl" data-testid="lg-rows">
                  <caption className="sr-only">{t("lgu.groups")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("lgu.col.group")}</th>
                      <th scope="col">{t("lgu.col.pair")}</th>
                      <th scope="col" className="r">
                        {t("lgu.col.size")}
                      </th>
                      <th scope="col">{t("col.status")}</th>
                      <th scope="col">{t("lgu.col.version")}</th>
                      <th scope="col" className="r">
                        {t("lgu.anomalies")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.groups.map((g) => (
                      <tr key={g.group_id} className={cx(openId === g.group_id && "is-selected")} data-testid={`lg-${g.group_id}`} data-status={g.status}>
                        <td>
                          <button type="button" className="tr" onClick={() => navigate("leagues", `groups/${g.group_id}`)} data-testid={`lg-open-${g.group_id}`}>
                            {t("lgu.groupN", { n: g.group_no })}
                          </button>
                        </td>
                        <td className="small">
                          <span className="mono">{g.pair_id}</span> · {g.level_band}
                        </td>
                        <td className="r num">{fmt.num(g.size)}</td>
                        <td>
                          <Pill tone={GROUP_TONE[g.status]}>{t(`lgus.${g.status}` as MessageKey)}</Pill>
                          {g.closed_at && <span className="xs muted block">{fmt.dateTime(g.closed_at)}</span>}
                        </td>
                        <td className="small">{g.version != null ? `v${g.version}` : <span className="muted">—</span>}</td>
                        <td className="r num">{g.anomalies ? <Pill tone="warn">{fmt.num(g.anomalies)}</Pill> : "0"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="podium" title={t("lgu.noGroups")} text={t("lgu.noGroupsM")} testId="lg-empty" />
            )}
            <div className="panel-f xs">
              <Icon name="lock" /> {t("lgu.immutable")}
            </div>
          </section>
        </>
      )}
      {openId && <GroupDrawer key={openId} id={openId} onClose={() => navigate("leagues", "groups")} onChanged={() => setTick((n) => n + 1)} />}
    </div>
  );
}

type GCmd = { kind: "reevaluate" } | { kind: "release" };

function GroupDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const fail = useCmdFail();
  const [g, setG] = useState<AdminLeagueGroup | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cmd, setCmd] = useState<GCmd | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [key] = useState(() => new CommandKey(uuid));
  const manage = can("league.manage");
  const load = useCallback(() => {
    Leagues.group(id)
      .then((x) => (setG(x), setError(null)))
      .catch(setError);
  }, [id]);
  useEffect(load, [load]);
  const done = (x: AdminLeagueGroup, msg: string) => {
    setG(x);
    onChanged();
    toast(msg, "ok", "league.group_changed");
  };
  return (
    <Drawer
      wide
      testId="lg-group"
      onClose={onClose}
      title={g ? t("lgu.groupT", { n: g.group_no, p: g.pair_id, b: g.level_band }) : t("lgu.groups")}
      sub={
        g && (
          <>
            <Pill tone={GROUP_TONE[g.status]}>{t(`lgus.${g.status}` as MessageKey)}</Pill>
            <span>{t("lgu.weekOf", { w: weekLabel(g.week) })}</span>
            {g.version != null && <span>v{g.version}</span>}
          </>
        )
      }
      footer={
        g && manage && (canReleasePrizes(g) || canReevaluateGroup(g)) ? (
          <>
            {canReleasePrizes(g) && <Btn kind="primary" icon="unlock" label={t("lgu.release")} onClick={() => setCmd({ kind: "release" })} testId="lg-release" />}
            {canReevaluateGroup(g) && <Btn icon="rollback" label={t("lgu.reevaluate")} onClick={() => setCmd({ kind: "reevaluate" })} testId="lg-reevaluate" />}
          </>
        ) : g && !manage ? (
          <span className="xs muted row" data-testid="lg-ro">
            <Icon name="lock" /> {t("perm.need", { p: "league.manage" })}
          </span>
        ) : g?.status === "open" ? (
          <span className="xs muted row" data-testid="lg-open-note">
            <Icon name="clock" /> {t("lgu.openNote")}
          </span>
        ) : undefined
      }
    >
      {error && !g ? (
        <LoadError error={error} onRetry={load} />
      ) : !g ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="stack" data-testid="lg-group-body" data-status={g.status}>
          {g.status === "held" && (
            <Callout kind="warn" icon="alert" testId="lg-held">
              {t("lgu.heldM", { n: g.anomalies })}
            </Callout>
          )}
          <section className="stack sm" aria-labelledby="lg-m-h">
            <h3 className="h3" id="lg-m-h">
              {t("lgu.members", { n: g.members.length })}
            </h3>
            <div className="table-wrap">
              <table className="tbl compact soc-tbl" data-testid="lg-members">
                <caption className="sr-only">{t("lgu.members", { n: g.members.length })}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="r">
                      {t("lgu.col.place")}
                    </th>
                    <th scope="col">{t("lgu.col.member")}</th>
                    <th scope="col" className="r">
                      XP
                    </th>
                    <th scope="col" className="r">
                      {t("lgu.col.prize")}
                    </th>
                    <th scope="col">{t("lgu.col.marks")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...g.members]
                    .sort((a, b) => (a.place ?? 9999) - (b.place ?? 9999) || b.xp - a.xp)
                    .map((m) => (
                      <tr key={m.user_id} className={cx(m.excluded && "is-reversed", m.anomaly && "is-flagged")} data-testid={`lgm-${m.user_id}`} data-anomaly={String(m.anomaly)} data-excluded={String(m.excluded)}>
                        <td className="r num b">{m.place ?? "—"}</td>
                        <td className="small">
                          {m.nickname ? <b lang="ru">{m.nickname}</b> : <span className="muted">{t("fr.noNick")}</span>}
                          <span className="block">
                            <UserRef id={m.user_id} />
                          </span>
                        </td>
                        <td className="r num">{fmt.num(m.xp)}</td>
                        <td className="r num">{m.prize_til ? t("lgu.til", { n: fmt.num(m.prize_til) }) : "—"}</td>
                        <td className="small">
                          {m.anomaly && <Pill tone="warn">{t("lgu.anomaly")}</Pill>}
                          {m.excluded && <Pill tone="neutral">{t("lgu.excluded")}</Pill>}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <p className="xs muted">{t("lgu.anomalyRule")}</p>
          </section>
          <section className="stack sm" aria-labelledby="lg-r-h" data-testid="lg-results">
            <h3 className="h3" id="lg-r-h">
              {t("lgu.results", { n: g.results.length })}
            </h3>
            {g.results.length ? (
              <ol className="soc-timeline">
                {g.results.map((r) => (
                  <li key={r.version} data-testid={`lgr-${r.version}`}>
                    <span className="row xs-gap">
                      <b>v{r.version}</b>
                      {r.version === g.version && <Pill tone="good">{t("lgu.current")}</Pill>}
                      {r.prizes_held && <Pill tone="warn">{t("lgu.prizesHeld")}</Pill>}
                      <span className="xs muted">
                        {staffName(r.closed_by, t("soc.system"))} · {fmt.dateTime(r.closed_at)}
                      </span>
                    </span>
                    {r.reason && (
                      <span className="small block wrap-any" lang="ru">
                        {r.reason}
                      </span>
                    )}
                    {r.excluded_user_ids.length > 0 && <span className="xs block">{t("lgu.excludedN", { n: r.excluded_user_ids.length })}</span>}
                    <Btn size="xs" kind="ghost" icon={open === r.version ? "eyeOff" : "eye"} label={open === r.version ? t("lgu.hideStandings") : t("lgu.showStandings")} onClick={() => setOpen(open === r.version ? null : r.version)} testId={`lgr-toggle-${r.version}`} />
                    {open === r.version && (
                      <table className="tbl dense mini-tbl" data-testid={`lgr-standings-${r.version}`}>
                        <caption className="sr-only">{t("lgu.standingsV", { v: r.version })}</caption>
                        <thead>
                          <tr>
                            <th scope="col" className="r">
                              {t("lgu.col.place")}
                            </th>
                            <th scope="col">{t("lgu.col.member")}</th>
                            <th scope="col" className="r">
                              XP
                            </th>
                            <th scope="col" className="r">
                              {t("lgu.col.prize")}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.standings.map((s) => (
                            <tr key={`${r.version}-${s.place}-${s.user_id ?? "anon"}`}>
                              <td className="r num">{s.place}</td>
                              <td>
                                <UserRef id={s.user_id} card={false} />
                              </td>
                              <td className="r num">{fmt.num(s.xp)}</td>
                              <td className="r num">{s.prize_til ? fmt.num(s.prize_til) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="small muted">{t("lgu.notClosed")}</p>
            )}
          </section>
          <PrivacyNote text={t("lgu.privacy")} />
        </div>
      )}
      {cmd?.kind === "release" && g && (
        <ConfirmCommand
          title={t("lgu.releaseT", { n: g.group_no })}
          text={t("lgu.releaseM")}
          icon="unlock"
          ok={t("lgu.release")}
          minReason={REASON_MIN}
          maxReason={REASON_MAX}
          reasonPlaceholder={t("lgu.releasePh")}
          testId="lg-release-dialog"
          onClose={() => setCmd(null)}
          onConfirm={async (reason) => {
            const k = key.for(JSON.stringify(["release", g.group_id, reason]));
            try {
              const x = await Leagues.release(g.group_id, reason, k);
              key.settle();
              done(x, t("lgu.released"));
              return null;
            } catch (e) {
              key.settle(e);
              if (e instanceof ApiError && e.code === "RESULT_STATE") load();
              return fail(e, load);
            }
          }}
        />
      )}
      {cmd?.kind === "reevaluate" && g && <ReevaluateGroup g={g} onClose={() => setCmd(null)} onDone={(x) => done(x, t("lgu.reevaluated", { v: x.version ?? "—" }))} onUnknown={load} />}
    </Drawer>
  );
}

function ReevaluateGroup({ g, onClose, onDone, onUnknown }: { g: AdminLeagueGroup; onClose: () => void; onDone: (x: AdminLeagueGroup) => void; onUnknown: () => void }) {
  const { t, fmt } = useI18n();
  const fail = useCmdFail();
  const issueText = useSocIssue();
  const [exclude, setExclude] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(() => new CommandKey(uuid));
  const ids = [...exclude];
  const chk = groupReevalBody(ids, reason);
  const at = (p: string): Issue | null => (tried ? (chk.issues.find((x) => x.path === p) ?? null) : null);
  const list = excludable(g.members);
  const preview = changedPlaces(previewPlaces(g, exclude));
  const nick = (uid: string) => g.members.find((m) => m.user_id === uid)?.nickname ?? shortId(uid, 8, 4);
  const submit = async () => {
    if (busy) return;
    setTried(true);
    if (!chk.body) return;
    setBusy(true);
    setErr(null);
    // F7-9: the key is the group and the body only — after a lost answer the group is re-read (its version moves on),
    // and the repeat of the same command must keep its key, or the server would create one more version
    const k = key.for(reevalSig(g.group_id, chk.body));
    try {
      const x = await Leagues.reevaluate(g.group_id, chk.body, k);
      key.settle();
      onDone(x);
      onClose();
    } catch (e) {
      key.settle(e);
      if (e instanceof ApiError && e.code === "RESULT_STATE") onUnknown();
      setErr(fail(e, onUnknown));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("lgu.reevalT", { n: g.group_no })}
      text={t("lgu.reevalM", { v: g.version ?? "—", n: (g.version ?? 0) + 1 })}
      icon="rollback"
      tone="warn"
      onClose={() => !busy && onClose()}
      testId="lg-reeval-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn label={t("lgu.reevaluate")} kind="primary" busy={busy} onClick={() => void submit()} testId="lg-reeval-ok" />
        </>
      }
    >
      <fieldset className="fs soc-pick" aria-describedby="lg-ex-h">
        <legend className="field-label">{t("lgu.exclude", { n: exclude.size, m: EXCLUDE_MAX })}</legend>
        <span className="hint" id="lg-ex-h">
          {t("lgu.excludeHint")}
        </span>
        <div className="soc-pick-list">
          {list.map((m) => (
            <label key={m.user_id} className="check" data-testid={`lg-ex-${m.user_id}`}>
              <input
                type="checkbox"
                checked={exclude.has(m.user_id)}
                onChange={(e) =>
                  setExclude((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(m.user_id);
                    else n.delete(m.user_id);
                    return n;
                  })
                }
              />
              <span>
                {t("lgu.placeN", { n: m.place ?? "—" })} · <span lang="ru">{m.nickname ?? t("fr.noNick")}</span> · {fmt.num(m.xp)} XP
                {m.anomaly && (
                  <>
                    {" "}
                    <Pill tone="warn">{t("lgu.anomaly")}</Pill>
                  </>
                )}
              </span>
            </label>
          ))}
        </div>
        <FieldErr msg={at("exclude_user_ids") ? t("sci.too_many", { max: EXCLUDE_MAX }) : null} />
      </fieldset>
      <section className="stack sm" data-testid="lg-preview">
        <span className="field-label">{t("lgu.preview")}</span>
        {preview.length ? (
          <ul className="plain-list">
            {preview.map((r) => (
              <li key={r.user_id} className="small" data-testid={`lgp-${r.user_id}`}>
                <span lang="ru">{nick(r.user_id)}</span>: {r.was ?? "—"} → {r.now ?? t("lgu.excluded")}
                {r.prize_was !== r.prize_now && ` · ${t("lgu.til", { n: fmt.num(r.prize_was) })} → ${t("lgu.til", { n: fmt.num(r.prize_now) })}`}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">{t("lgu.previewNone")}</p>
        )}
        <p className="xs muted">{t("lgu.previewNote")}</p>
      </section>
      <NoteField id="lg-reason" label={t("cmd.reason")} value={reason} onChange={(v) => (setReason(v), setErr(null))} error={issueText(at("reason"))} placeholder={t("lgu.reevalPh")} testId="lg-reason" />
      <StepUpNote />
      <FieldErr msg={err} />
    </Modal>
  );
}

/* ---------------------------------------------------------------- duels */

function DuelsTab({ openId }: { openId: string | null }) {
  const { t, fmt } = useI18n();
  const { navigate } = useNav();
  const [status, setStatus] = useState<DuelStatus | "">("finished");
  const [rows, setRows] = useState<AdminDuelRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const req = useRef(0);
  const load = useCallback(
    async (more?: string | null) => {
      const id = ++req.current;
      try {
        const r = await Leagues.duels(status, more ?? null);
        if (id !== req.current) return;
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError(null);
      } catch (e) {
        if (id === req.current) setError(e);
      }
    },
    [status],
  );
  useEffect(() => {
    void load();
  }, [load, tick]);
  return (
    <section className="panel" aria-labelledby="dl-h" data-testid="lg-duels">
      <div className="panel-h">
        <h2 className="panel-t grow" id="dl-h">
          <Icon name="zap" /> {t("duel.title")}
        </h2>
        <div className="field soc-inline">
          <label htmlFor="dl-status" className="sr-only">
            {t("col.status")}
          </label>
          <Select<DuelStatus | ""> id="dl-status" label={t("col.status")} value={status} onChange={(v) => (setRows(null), setStatus(v))} options={[{ v: "", label: t("common.all") }, ...DUEL_STATUSES.map((v) => ({ v, label: t(`dst.${v}` as MessageKey) }))]} testId="dl-status" />
        </div>
      </div>
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="tbl compact soc-tbl" data-testid="dl-rows">
            <caption className="sr-only">{t("duel.title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("col.created")}</th>
                <th scope="col">{t("duel.col.sides")}</th>
                <th scope="col">{t("lgu.col.pair")}</th>
                <th scope="col">{t("duel.col.score")}</th>
                <th scope="col">{t("duel.col.result")}</th>
                <th scope="col">{t("col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.duel_id} className={cx(openId === d.duel_id && "is-selected")} data-testid={`dl-${d.duel_id}`} data-status={d.status}>
                  <td className="small nowrap">
                    <button type="button" className="tr" onClick={() => navigate("leagues", `duels/${d.duel_id}`)} data-testid={`dl-open-${d.duel_id}`}>
                      {fmt.dateTime(d.created_at)}
                    </button>
                  </td>
                  <td className="small">
                    <UserRef id={d.challenger_user_id} /> <span className="muted">{t("duel.vs")}</span> <UserRef id={d.opponent_user_id} />
                  </td>
                  <td className="small">
                    <span className="mono">{d.pair_id}</span> · {d.level_band}
                  </td>
                  <td className="small num">
                    <Score d={d} />
                  </td>
                  <td className="small">
                    <ResultText d={d} />
                  </td>
                  <td>
                    <Pill tone={DUEL_TONE[d.status]}>{t(`dst.${d.status}` as MessageKey)}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="zap" title={t("duel.none")} testId="dl-empty" />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} testId="dl-more" />
        </div>
      )}
      <div className="panel-f xs">
        <Icon name="info" /> {t("duel.note")}
      </div>
      {openId && <DuelDrawer key={openId} id={openId} onClose={() => navigate("leagues", "duels")} onChanged={() => setTick((n) => n + 1)} />}
    </section>
  );
}

function Score({ d }: { d: Pick<AdminDuelRow, "scores"> }) {
  const s = (x: { correct: number; total: number } | null) => (x ? `${x.correct}/${x.total}` : "—");
  return (
    <span className="nowrap">
      {s(d.scores.challenger)} : {s(d.scores.opponent)}
    </span>
  );
}

function ResultText({ d }: { d: Pick<AdminDuelRow, "result" | "technical" | "result_version"> }) {
  const { t } = useI18n();
  if (!d.result) return <span className="muted">—</span>;
  return (
    <>
      {t(`drs.${d.result}` as MessageKey)}
      {d.technical && (
        <>
          {" "}
          <Pill tone="info">{t("duel.technical")}</Pill>
        </>
      )}
      {d.result_version > 1 && <span className="xs muted block">{t("duel.versionN", { v: d.result_version })}</span>}
    </>
  );
}

function DuelDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const [d, setD] = useState<AdminDuel | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reeval, setReeval] = useState(false);
  const manage = can("league.manage");
  const load = useCallback(() => {
    Leagues.duel(id)
      .then((x) => (setD(x), setError(null)))
      .catch(setError);
  }, [id]);
  useEffect(load, [load]);
  return (
    <Drawer
      wide
      testId="dl-duel"
      onClose={onClose}
      title={t("duel.duelT", { id: shortId(id, 8, 4) })}
      sub={
        d && (
          <>
            <Pill tone={DUEL_TONE[d.status]}>{t(`dst.${d.status}` as MessageKey)}</Pill>
            <span>
              <span className="mono">{d.pair_id}</span> · {d.level_band}
            </span>
          </>
        )
      }
      footer={
        d && canReevaluateDuel(d) ? (
          manage ? (
            <Btn icon="rollback" label={t("duel.reevaluate")} onClick={() => setReeval(true)} testId="dl-reevaluate" />
          ) : (
            <span className="xs muted row" data-testid="dl-ro">
              <Icon name="lock" /> {t("perm.need", { p: "league.manage" })}
            </span>
          )
        ) : undefined
      }
    >
      {error && !d ? (
        <LoadError error={error} onRetry={load} />
      ) : !d ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="stack" data-testid="dl-duel-body" data-status={d.status} data-version={d.result_version}>
          <section className="card stack sm" aria-labelledby="dl-s-h">
            <h3 className="h3" id="dl-s-h">
              {t("duel.summary")}
            </h3>
            <dl className="dl">
              <dt>{t("duel.challenger")}</dt>
              <dd>
                <UserRef id={d.challenger_user_id} testId="dl-challenger" /> · {d.scores.challenger ? t("duel.scoreV", { c: d.scores.challenger.correct, n: d.scores.challenger.total }) : t("duel.noScore")}
              </dd>
              <dt>{t("duel.opponent")}</dt>
              <dd>
                <UserRef id={d.opponent_user_id} testId="dl-opponent" /> · {d.scores.opponent ? t("duel.scoreV", { c: d.scores.opponent.correct, n: d.scores.opponent.total }) : t("duel.noScore")}
              </dd>
              <dt>{t("duel.col.result")}</dt>
              <dd data-testid="dl-result">
                <ResultText d={d} />
              </dd>
              <dt>{t("duel.acceptBy")}</dt>
              <dd>{fmt.dateTime(d.accept_deadline)}</dd>
              <dt>{t("duel.playBy")}</dt>
              <dd>{d.play_deadline ? fmt.dateTime(d.play_deadline) : "—"}</dd>
              <dt>{t("duel.finished")}</dt>
              <dd>{d.finished_at ? fmt.dateTime(d.finished_at) : "—"}</dd>
              <dt>{t("duel.set")}</dt>
              <dd className="mono xs">{d.set_id ?? "—"}</dd>
            </dl>
            <p className="xs muted">{t("duel.timeNote")}</p>
          </section>
          <section className="stack sm" aria-labelledby="dl-r-h" data-testid="dl-rewards">
            <h3 className="h3" id="dl-r-h">
              {t("duel.rewards", { n: d.rewards.length })}
            </h3>
            {d.rewards.length ? (
              <table className="tbl dense">
                <caption className="sr-only">{t("duel.rewards", { n: d.rewards.length })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("soc.col.learner")}</th>
                    <th scope="col" className="r">
                      XP
                    </th>
                    <th scope="col">{t("col.status")}</th>
                    <th scope="col">{t("lgu.col.version")}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rewards.map((r) => (
                    <tr key={r.op_id} className={cx(r.status === "reversed" && "is-reversed")} data-testid={`dlr-${r.op_id}`} data-status={r.status}>
                      <td>
                        <UserRef id={r.user_id} />
                      </td>
                      <td className={cx("r num b", r.amount > 0 ? "good-ink" : "bad-ink")}>{r.amount > 0 ? `+${fmt.num(r.amount)}` : `−${fmt.num(-r.amount)}`}</td>
                      <td>
                        <Pill tone={r.status === "reversed" ? "neutral" : "good"}>{t(`wlst.${r.status}` as MessageKey)}</Pill>
                      </td>
                      <td className="small">v{r.result_version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="small muted">{t("duel.noRewards")}</p>
            )}
          </section>
          <section className="stack sm" aria-labelledby="dl-h-h" data-testid="dl-history">
            <h3 className="h3" id="dl-h-h">
              {t("duel.history", { n: d.history.length })}
            </h3>
            {d.history.length ? (
              <ol className="soc-timeline">
                {d.history.map((h) => (
                  <li key={h.version} data-testid={`dlh-${h.version}`}>
                    <span className="row xs-gap">
                      <b>v{h.version}</b> {t(`drs.${h.result}` as MessageKey)}
                      <span className="xs muted">
                        {staffName(h.by, t("soc.system"))} · {fmt.dateTime(h.at)}
                      </span>
                    </span>
                    {h.reason && (
                      <span className="small block wrap-any" lang="ru">
                        {h.reason}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="small muted">{t("duel.noHistory")}</p>
            )}
          </section>
          <PrivacyNote text={t("duel.privacy")} />
        </div>
      )}
      {reeval && d && (
        <ReevaluateDuel
          d={d}
          onClose={() => setReeval(false)}
          onDone={(x) => {
            setD(x);
            onChanged();
            toast(t("duel.reevaluated", { v: x.result_version }), "ok", "duel.reevaluated");
          }}
          onUnknown={load}
        />
      )}
    </Drawer>
  );
}

function ReevaluateDuel({ d, onClose, onDone, onUnknown }: { d: AdminDuel; onClose: () => void; onDone: (x: AdminDuel) => void; onUnknown: () => void }) {
  const { t } = useI18n();
  const fail = useCmdFail();
  const issueText = useSocIssue();
  const [result, setResult] = useState<DuelReevaluateRequest["result"] | null>(null);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(() => new CommandKey(uuid));
  const chk = duelReevalBody(d.result as DuelResult | null, result, reason);
  const at = (p: string): Issue | null => (tried ? (chk.issues.find((x) => x.path === p) ?? null) : null);
  const submit = async () => {
    if (busy) return;
    setTried(true);
    if (!chk.body) return;
    setBusy(true);
    setErr(null);
    const k = key.for(JSON.stringify(["duel", d.duel_id, d.result_version, chk.body]));
    try {
      const x = await Leagues.reevaluateDuel(d.duel_id, chk.body, k);
      key.settle();
      onDone(x);
      onClose();
    } catch (e) {
      key.settle(e);
      if (e instanceof ApiError && e.code === "RESULT_STATE") onUnknown();
      setErr(fail(e, onUnknown));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("duel.reevalT")}
      text={t("duel.reevalM", { v: d.result_version, n: d.result_version + 1 })}
      icon="rollback"
      tone="warn"
      onClose={() => !busy && onClose()}
      testId="dl-reeval-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn label={t("duel.reevaluate")} kind="primary" busy={busy} onClick={() => void submit()} testId="dl-reeval-ok" />
        </>
      }
    >
      <fieldset className="fs soc-choices">
        <legend className="field-label">{t("duel.newResult")}</legend>
        {REEVAL_RESULTS.map((r) => (
          <label key={r} className={cx("soc-choice", result === r && "is-on")}>
            <input type="radio" name="dl-result" checked={result === r} onChange={() => (setResult(r), setErr(null))} data-testid={`dl-r-${r}`} />
            <span>
              <b>{t(`drs.${r}` as MessageKey)}</b>
              {r === d.result && <span className="xs muted block">{t("duel.currentResult")}</span>}
            </span>
          </label>
        ))}
        <FieldErr msg={at("result") ? (at("result")!.code === "same_result" ? t("sci.same_result") : t("duel.pick")) : null} />
      </fieldset>
      <NoteField id="dl-reason" label={t("cmd.reason")} value={reason} onChange={(v) => (setReason(v), setErr(null))} error={issueText(at("reason"))} placeholder={t("duel.reevalPh")} testId="dl-reason" />
      <Callout icon="info">{t("duel.reevalRewards")}</Callout>
      <StepUpNote />
      <FieldErr msg={err} />
    </Modal>
  );
}
