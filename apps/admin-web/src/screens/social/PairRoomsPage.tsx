/**
 * «Парные комнаты» (sprint 7, ADM-SOC-02, AT-76, AT-80; room.read, stop — room.manage + step-up): rooms with filters
 * (status, dates), each — the scenario, the mode, the status, the duration, the participants with their side and role,
 * turns, the speaking seconds of each and the minutes (counted, not charged until sprint 8), the AI cost; a room — the
 * same plus the course of events WITHOUT the texts of the replies and WITHOUT assessments (personal assessments are
 * isolated — ADM-SOC-02 acceptance); a room that has not ended can be stopped with a reason (participants get an event
 * in the room and a notification, the reports keep what was done).
 * Routes: #/pair_rooms · #/pair_rooms/<room_id>.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminPairRoom, AdminPairRoomParticipant, AdminPairRoomRow } from "@tilhero/contracts/admin";
import type { PairRoomStatus } from "@tilhero/contracts/bff";
import { PairRooms } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Select, Spinner } from "../../ui/kit";
import { ConfirmCommand, Drawer } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { usd } from "../ai/model";
import { CommandKey } from "../memory/model";
import { emptyRoomFilters, fmtDuration, parseRoomRoute, REASON_MAX, REASON_MIN, ROOM_STATUSES, ROOM_TONE, roomActive, roomFiltersProblem, speakShare, type RoomFilters } from "./model";
import { PrivacyNote, StepUpNote, staffName, useCmdFail, UserRef } from "./parts";

export function PairRoomsPage({ routeId }: { routeId: string | null }) {
  const { t, fmt } = useI18n();
  const { navigate } = useNav();
  const openId = parseRoomRoute(routeId);
  const [f, setF] = useState<RoomFilters>(emptyRoomFilters);
  const [rows, setRows] = useState<AdminPairRoomRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const req = useRef(0);
  const problem = roomFiltersProblem(f);
  const load = useCallback(
    async (more?: string | null) => {
      if (problem) return;
      const id = ++req.current;
      try {
        const r = await PairRooms.list({ status: f.status, from: f.from || undefined, to: f.to || undefined, cursor: more ?? null });
        if (id !== req.current) return;
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError(null);
      } catch (e) {
        if (id === req.current) setError(e);
      }
    },
    [f, problem],
  );
  useEffect(() => {
    void load();
  }, [load, tick]);
  const set = <K extends keyof RoomFilters>(k: K, v: RoomFilters[K]) => setF((x) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify(f) !== JSON.stringify(emptyRoomFilters());
  const money = (n: number) => usd(n, fmt.locale);
  return (
    <div className="stack" data-testid="pair-rooms">
      <section className="panel" aria-labelledby="pr-h" data-testid="pr-list">
        <div className="panel-h">
          <h2 className="panel-t grow" id="pr-h">
            <Icon name="mic" /> {t("pr.title")}
          </h2>
          <Btn size="sm" icon="refresh" label={t("common.refresh")} onClick={() => void load()} testId="pr-refresh" />
        </div>
        <div className="panel-b qa-filters" role="group" aria-label={t("soc.filters")} data-testid="pr-filters">
          <div className="field">
            <label htmlFor="pr-status">{t("col.status")}</label>
            <Select<PairRoomStatus | ""> id="pr-status" label={t("col.status")} value={f.status} onChange={(v) => set("status", v)} options={[{ v: "", label: t("common.all") }, ...ROOM_STATUSES.map((v) => ({ v, label: t(`rst7.${v}` as MessageKey) }))]} testId="pr-status" />
          </div>
          <div className="field">
            <label htmlFor="pr-from">{t("qa.f.from")}</label>
            <input id="pr-from" type="date" className="input" value={f.from} max={f.to || undefined} onChange={(e) => set("from", e.target.value)} data-testid="pr-from" />
          </div>
          <div className="field">
            <label htmlFor="pr-to">{t("qa.f.to")}</label>
            <input id="pr-to" type="date" className={cx("input", !!problem && "is-invalid")} value={f.to} min={f.from || undefined} aria-invalid={!!problem || undefined} aria-describedby={problem ? "pr-to-e" : undefined} onChange={(e) => set("to", e.target.value)} data-testid="pr-to" />
            <FieldErr msg={problem ? t("pr.toBeforeFrom") : null} id="pr-to-e" />
          </div>
          {dirty && (
            <div className="field qf-reset">
              <span className="field-label" aria-hidden="true">
                &nbsp;
              </span>
              <Btn size="sm" kind="ghost" icon="x" label={t("common.resetFilters")} onClick={() => setF(emptyRoomFilters())} testId="pr-reset" />
            </div>
          )}
        </div>
        {error && !rows ? (
          <div className="panel-b">
            <LoadError error={error} onRetry={() => void load()} />
          </div>
        ) : !rows ? (
          <Spinner label={t("common.loading")} />
        ) : rows.length ? (
          <div className="table-wrap">
            <table className="tbl compact soc-tbl" data-testid="pr-rows">
              <caption className="sr-only">{t("pr.title")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("pr.col.start")}</th>
                  <th scope="col">{t("pr.col.scenario")}</th>
                  <th scope="col">{t("col.status")}</th>
                  <th scope="col">{t("pr.col.participants")}</th>
                  <th scope="col" className="r">
                    {t("pr.col.duration")}
                  </th>
                  <th scope="col" className="r">
                    {t("pr.col.cost")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.room_id} className={cx(openId === r.room_id && "is-selected")} data-testid={`pr-${r.room_id}`} data-status={r.status}>
                    <td className="small nowrap">
                      <button type="button" className="tr" onClick={() => navigate("pair_rooms", r.room_id)} data-testid={`pr-open-${r.room_id}`}>
                        {fmt.dateTime(r.started_at ?? r.start_at)}
                      </button>
                      <span className="xs muted block">{t(`prm.${r.mode}` as MessageKey)}</span>
                    </td>
                    <td className="small">
                      <span lang="ru">{r.scenario_title.ru}</span>
                      <span className="mono xs muted block">
                        {r.pair_id} · {r.scenario_id}
                      </span>
                    </td>
                    <td>
                      <Pill tone={ROOM_TONE[r.status]}>{t(`rst7.${r.status}` as MessageKey)}</Pill>
                      {r.end_reason && <span className="xs muted block">{t(`per.${r.end_reason}` as MessageKey)}</span>}
                    </td>
                    <td className="small">
                      {r.participants.map((p) => (
                        <span className="block nowrap" key={p.side}>
                          {p.role ?? "—"} · {t("pr.speakS", { n: fmt.num(p.speaking_seconds) })} · {t("pr.turnsN", { n: p.turns })}
                        </span>
                      ))}
                    </td>
                    <td className="r num">{fmtDuration(r.duration_s)}</td>
                    <td className="r num">{money(r.ai_cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="mic" title={t("pr.none")} text={dirty ? t("common.changeFilters") : undefined} testId="pr-empty" />
        )}
        {cursor && (
          <div className="more-row">
            <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} testId="pr-more" />
          </div>
        )}
        <div className="panel-f xs">
          <Icon name="info" /> {t("pr.minutesNote")}
        </div>
      </section>
      <PrivacyNote text={t("pr.privacy")} testId="pr-privacy" />
      {openId && <RoomDrawer key={openId} id={openId} onClose={() => navigate("pair_rooms")} onChanged={() => setTick((n) => n + 1)} />}
    </div>
  );
}

function RoomDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const fail = useCmdFail();
  const [r, setR] = useState<AdminPairRoom | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [stop, setStop] = useState(false);
  const [key] = useState(() => new CommandKey(uuid));
  const manage = can("room.manage");
  const load = useCallback(() => {
    PairRooms.get(id)
      .then((x) => (setR(x), setError(null)))
      .catch(setError);
  }, [id]);
  useEffect(load, [load]);
  const money = (n: number) => usd(n, fmt.locale);
  return (
    <Drawer
      wide
      testId="pr-room"
      onClose={onClose}
      title={r ? <span lang="ru">{r.scenario_title.ru}</span> : t("pr.roomT", { id: shortId(id, 8, 4) })}
      sub={
        r && (
          <>
            <Pill tone={ROOM_TONE[r.status]}>{t(`rst7.${r.status}` as MessageKey)}</Pill>
            <span className="mono">{shortId(r.room_id, 8, 4)}</span>
            <span>{t(`prm.${r.mode}` as MessageKey)}</span>
          </>
        )
      }
      footer={
        r && roomActive(r.status) ? (
          manage ? (
            <Btn kind="danger" icon="stop" label={t("pr.stop")} onClick={() => setStop(true)} testId="pr-stop" />
          ) : (
            <span className="xs muted row" data-testid="pr-ro">
              <Icon name="lock" /> {t("perm.need", { p: "room.manage" })}
            </span>
          )
        ) : undefined
      }
    >
      {error && !r ? (
        <LoadError error={error} onRetry={load} />
      ) : !r ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="stack" data-testid="pr-room-body" data-status={r.status}>
          <Callout icon="shield" testId="pr-isolated">
            {t("pr.isolated")}
          </Callout>
          {r.status === "stopped" && (
            <Callout kind="bad" icon="stop" testId="pr-stopped">
              <b>{t("pr.stoppedBy", { n: staffName(r.stopped_by, t("soc.system")) })}</b> <span lang="ru">{r.stop_reason ?? ""}</span>
            </Callout>
          )}
          <div className="kpis mem-kpis" data-testid="pr-kpis">
            <div className="card kpi">
              <div className="kpi-l">{t("pr.col.duration")}</div>
              <div className="kpi-v" data-testid="pr-duration">{fmtDuration(r.duration_s)}</div>
              <div className="kpi-n">{r.started_at ? t("pr.startedAt", { t: fmt.dateTime(r.started_at) }) : t("pr.notStarted", { t: fmt.dateTime(r.start_at) })}</div>
            </div>
            <div className="card kpi">
              <div className="kpi-l">{t("pr.col.cost")}</div>
              <div className="kpi-v" data-testid="pr-cost">{money(r.ai_cost_usd)}</div>
              <div className="kpi-n">{r.mode === "choices" ? t("pr.costChoices") : t("pr.costNote")}</div>
            </div>
            <div className="card kpi">
              <div className="kpi-l">{t("pr.end")}</div>
              <div className="kpi-v small">{r.end_reason ? t(`per.${r.end_reason}` as MessageKey) : "—"}</div>
              <div className="kpi-n">{r.ended_at ? fmt.dateTime(r.ended_at) : t("pr.notEnded")}</div>
            </div>
          </div>
          <section className="stack sm" aria-labelledby="pr-p-h">
            <h3 className="h3" id="pr-p-h">
              {t("pr.col.participants")}
            </h3>
            <Participants items={r.participants} />
          </section>
          <section className="stack sm" aria-labelledby="pr-t-h" data-testid="pr-timeline">
            <h3 className="h3" id="pr-t-h">
              {t("pr.timeline", { n: r.timeline.length })}
            </h3>
            {r.timeline.length ? (
              <div className="table-wrap soc-scroll">
                <table className="tbl dense">
                  <caption className="sr-only">{t("pr.timeline", { n: r.timeline.length })}</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="r">
                        #
                      </th>
                      <th scope="col">{t("pr.col.at")}</th>
                      <th scope="col">{t("pr.col.event")}</th>
                      <th scope="col">{t("pr.col.role")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.timeline.map((e) => (
                      <tr key={e.seq} data-kind={e.kind}>
                        <td className="r num">{e.seq}</td>
                        <td className="small nowrap">{fmt.dateTimeS(e.at)}</td>
                        <td className="small">{t(`rek.${e.kind}` as MessageKey)}</td>
                        <td className="small">{e.role ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="small muted">{t("pr.noEvents")}</p>
            )}
            <p className="xs muted row">
              <Icon name="lock" /> {t("pr.noTexts")}
            </p>
          </section>
          <PrivacyNote text={t("pr.privacy")} />
        </div>
      )}
      {stop && r && (
        <ConfirmCommand
          title={t("pr.stopT")}
          text={t("pr.stopM")}
          icon="stop"
          tone="bad"
          ok={t("pr.stop")}
          okKind="danger"
          minReason={REASON_MIN}
          maxReason={REASON_MAX}
          reasonPlaceholder={t("pr.stopPh")}
          testId="pr-stop-dialog"
          extra={
            <>
              <dl className="dl">
                <dt>{t("pr.col.scenario")}</dt>
                <dd lang="ru">{r.scenario_title.ru}</dd>
                <dt>{t("col.status")}</dt>
                <dd>{t(`rst7.${r.status}` as MessageKey)}</dd>
              </dl>
              <StepUpNote />
            </>
          }
          onClose={() => setStop(false)}
          onConfirm={async (reason) => {
            const k = key.for(JSON.stringify(["stop", r.room_id, reason]));
            try {
              const x = await PairRooms.stop(r.room_id, reason, k);
              key.settle();
              setR(x);
              onChanged();
              toast(t("pr.stopped"), "ok", "pair_room.stopped");
              return null;
            } catch (e) {
              key.settle(e);
              if (e instanceof ApiError && e.code === "ROOM_NOT_ACTIVE") load();
              return fail(e, load);
            }
          }}
        />
      )}
    </Drawer>
  );
}

function Participants({ items }: { items: AdminPairRoomParticipant[] }) {
  const { t, fmt } = useI18n();
  const all = items.map((p) => p.speaking_seconds);
  return (
    <div className="table-wrap">
      <table className="tbl compact" data-testid="pr-participants">
        <caption className="sr-only">{t("pr.col.participants")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("pr.col.side")}</th>
            <th scope="col">{t("soc.col.learner")}</th>
            <th scope="col">{t("pr.col.role")}</th>
            <th scope="col" className="r">
              {t("pr.col.turns")}
            </th>
            <th scope="col" className="r">
              {t("pr.col.speak")}
            </th>
            <th scope="col" className="r">
              {t("pr.col.minutes")}
            </th>
            <th scope="col">{t("pr.col.contrib")}</th>
            <th scope="col">{t("pr.col.network")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => {
            const share = speakShare(p.speaking_seconds, all);
            return (
              <tr key={p.side} data-testid={`prp-${p.side}`}>
                <td className="small">{t(`prs.${p.side}` as MessageKey)}</td>
                <td>
                  <UserRef id={p.user_id} />
                  {p.joined_at && <span className="xs muted block">{t("pr.joined", { t: fmt.time(p.joined_at) })}</span>}
                </td>
                <td className="small">{p.role ?? "—"}</td>
                <td className="r num">{fmt.num(p.turns)}</td>
                <td className="r num" data-testid={`prp-${p.side}-speak`}>
                  {t("pr.speakS", { n: fmt.num(p.speaking_seconds) })}
                  {share != null && <span className="xs muted block">{share} %</span>}
                </td>
                <td className="r num">{fmt.num(p.minutes)}</td>
                <td>{p.contributed ? <Pill tone="good">{t("pr.contributed")}</Pill> : <Pill tone="neutral">{t("pr.silent")}</Pill>}</td>
                <td className="small">{p.network ? t(`prn.${p.network}` as MessageKey) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
