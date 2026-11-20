/**
 * «События и сезоны» (ADM-GAME-05 TilHero, AT-71): events of the week — a period of at most 14 days, audiences
 * (adults / teens / kids), RU/UZ texts and 1..5 multipliers of XP or tils per kind of action («Неделя чтения ×2 XP»).
 * List by status; a new event is a draft (game.manage, Idempotency-Key), a draft changes freely; publication and
 * cancellation — game.publish with step-up and a comment ≥ 10. Only a published event acts, only in its period.
 * Two published events must not overlap on the same action and currency for a shared audience: gamification answers
 * 409 EVENT_OVERLAP {event_id} — the card shows that event with a link. Awards already made with a cancelled
 * event's multiplier are not recalculated.
 */
import { useCallback, useEffect, useState } from "react";
import type { AdminGameEvent, GameEventStatus, GameMultiplier } from "@tilhero/contracts/admin";
import type { GameAction } from "@tilhero/contracts/bff";
import { Game } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, Pill, Reveal, Seg, Select, Spinner } from "../../ui/kit";
import { ConfirmCommand, Drawer } from "../../ui/overlays";
import { errText } from "../../ui/errors";
import { useToast } from "../../ui/toasts";
import { CommandKey } from "../memory/model";
import { AudiencePicker, AudiencePills, IssueMsg, LocFields } from "./parts";
import {
  checkEvent,
  COMMENT_MAX,
  COMMENT_MIN,
  emptyEventForm,
  EVENT_DESC_MAX,
  EVENT_MAX_DAYS,
  EVENT_ROUTE_RE,
  EVENT_STATUSES,
  EVENT_TITLE_MAX,
  EVENT_TONE,
  eventBody,
  eventFormOf,
  eventPatch,
  FACTORS,
  fieldId,
  fromZoneInput,
  GAME_ACTIONS,
  issuesAt,
  MULTIPLIER_CURRENCIES,
  MULTIPLIERS_MAX,
  overlapping,
  parseItemRoute,
  periodDays,
  runningNow,
  serverIssues,
  zoneDateTime,
  type EventForm,
  type Issue,
} from "./model";

export function EventsPage({ routeId }: { routeId: string | null }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const [events, setEvents] = useState<AdminGameEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<GameEventStatus | "">("");
  const open = parseItemRoute(routeId, EVENT_ROUTE_RE);
  const load = useCallback(async () => {
    try {
      const r = await Game.events();
      setEvents(r.items);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const now = Date.now();
  const rows = (events ?? []).filter((e) => !status || e.status === status).sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at));
  const ev = open && open !== "new" ? (events?.find((e) => e.event_id === open) ?? null) : null;
  const upsert = (x: AdminGameEvent) => setEvents((xs) => [...(xs ?? []).filter((y) => y.event_id !== x.event_id), x]);
  return (
    <div className="stack" data-testid="events">
      <div className="toolbar">
        <Seg<GameEventStatus | ""> label={t("col.status")} value={status} onChange={setStatus} testId="ev-status" items={[{ v: "", label: t("common.all"), cnt: events?.length ?? null }, ...EVENT_STATUSES.map((s) => ({ v: s, label: t(`evs.${s}` as MessageKey), cnt: events ? events.filter((e) => e.status === s).length : null }))]} />
        <span className="grow" />
        {can("game.manage") ? (
          <Btn kind="primary" icon="plus" label={t("ev.new")} onClick={() => navigate("events", "new")} testId="ev-new" />
        ) : (
          <span className="xs muted row" data-testid="ev-ro">
            <Icon name="lock" /> {t("gm.noManage")}
          </span>
        )}
      </div>
      <Callout icon="info" testId="ev-note">
        {t("ev.note", { n: EVENT_MAX_DAYS })}
      </Callout>
      {error && !events ? (
        <LoadError error={error} onRetry={() => void load()} />
      ) : !events ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <section className="panel">
          <div className="table-wrap">
            <table className="tbl" data-testid="ev-rows">
              <caption className="sr-only">{t("page.events")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("ev.col.event")}</th>
                  <th scope="col">{t("ev.col.period")}</th>
                  <th scope="col">{t("gm.audiences")}</th>
                  <th scope="col">{t("ev.col.mult")}</th>
                  <th scope="col">{t("col.status")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.event_id} className={cx(open === e.event_id && "is-sel")} data-testid={`ev-row-${e.code}`} data-status={e.status}>
                    <td>
                      <button type="button" className="tr" lang="ru" onClick={() => navigate("events", e.event_id)} data-testid={`ev-open-${e.code}`}>
                        {e.title.ru}
                      </button>
                      <span className="mono xs muted block">{e.code}</span>
                    </td>
                    <td className="small nowrap">
                      {zoneDateTime(fmt.locale, e.starts_at)} → {zoneDateTime(fmt.locale, e.ends_at)}
                      <span className="xs muted block">{t("ev.days", { n: periodDays(e.starts_at, e.ends_at) })}</span>
                    </td>
                    <td>
                      <AudiencePills value={e.audiences} />
                    </td>
                    <td>
                      <Multipliers ms={e.multipliers} />
                    </td>
                    <td>
                      <Pill tone={EVENT_TONE[e.status]}>{t(`evs.${e.status}` as MessageKey)}</Pill>
                      {runningNow(e, now) && (
                        <Pill tone="accent" testId={`ev-live-${e.code}`}>
                          {t("ev.liveNow")}
                        </Pill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <Empty icon="calendar" title={t("ev.none")} text={status ? t("common.changeFilters") : t("ev.noneM")} />
      )}
      {open === "new" && can("game.manage") && <EventDrawer key="new" ev={null} all={events ?? []} onClose={() => navigate("events")} onSaved={(x) => (upsert(x), navigate("events", x.event_id))} onOpen={(id) => navigate("events", id)} />}
      {ev && <EventDrawer key={ev.event_id} ev={ev} all={events ?? []} onClose={() => navigate("events")} onSaved={upsert} onOpen={(id) => navigate("events", id)} />}
      {open && open !== "new" && events && !ev && <Callout kind="warn" icon="alert">{t("err.EVENT_NOT_FOUND")}</Callout>}
    </div>
  );
}

/** ×1,5 / ×2 in the language of the interface */
const factorText = (fmt: { num(n: number, d?: number): string }, f: number) => fmt.num(f, f % 1 ? 1 : 0);

function Multipliers({ ms }: { ms: readonly GameMultiplier[] }) {
  const { t, fmt } = useI18n();
  return (
    <span className="row xs-gap">
      {ms.map((m) => (
        <span key={`${m.action}:${m.currency}`} className="tag plain" data-testid={`mult-${m.action}-${m.currency}`}>
          {t("ev.mult", { a: t(`gact.${m.action}` as MessageKey), f: factorText(fmt, m.factor), c: m.currency === "xp" ? "XP" : t("gm.cur.til") })}
        </span>
      ))}
    </span>
  );
}

function EventDrawer({ ev, all, onClose, onSaved, onOpen }: { ev: AdminGameEvent | null; all: AdminGameEvent[]; onClose: () => void; onSaved: (x: AdminGameEvent) => void; onOpen: (id: string) => void }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { can } = useSession();
  const toast = useToast();
  const [x, setX] = useState<AdminGameEvent | null>(ev);
  const [form, setForm] = useState<EventForm>(() => (ev ? eventFormOf(ev) : emptyEventForm()));
  const [base, setBase] = useState<EventForm>(() => (ev ? eventFormOf(ev) : emptyEventForm()));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ask, setAsk] = useState<"publish" | "cancel" | null>(null);
  const [overlap, setOverlap] = useState<{ id: string | null } | null>(null);
  const [createKey] = useState(() => new CommandKey(uuid));
  const [cmdKey] = useState(() => new CommandKey(uuid));
  const [srv, setSrv] = useState<Issue[]>([]);
  const editable = can("game.manage") && (!x || x.status === "draft");
  const { errors, warnings } = checkEvent(form, x ? "draft" : "create");
  // problems of 422 EVENT_INVALID {errors} stay at their fields until the form changes
  const shown = [...(tried ? errors : errors.filter((i) => i.code !== "required" && i.code !== "code_format")), ...srv];
  const edit = (f: EventForm) => {
    setForm(f);
    setSrv([]);
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  const s = fromZoneInput(form.starts);
  const e = fromZoneInput(form.ends);
  const days = periodDays(s, e);
  const clash = x && x.status === "draft" ? overlapping(x, all) : [];
  const other = overlap?.id ? (all.find((y) => y.event_id === overlap.id) ?? null) : null;

  const save = async () => {
    if (busy) return;
    setTried(true);
    if (errors.length) {
      setErr(t("gm.fixErrors", { n: errors.length }));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      let y: AdminGameEvent;
      if (!x) {
        const body = eventBody(form);
        y = await Game.createEvent(body, createKey.for(JSON.stringify(body)));
        createKey.settle();
        toast(t("ev.created", { c: y.code }), "ok", "game.event_created");
      } else {
        const patch = eventPatch(x, form);
        if (!patch) {
          setBase(form);
          return;
        }
        y = await Game.patchEvent(x.event_id, patch);
        toast(t("ev.saved", { c: y.code }), "ok", "game.event_updated");
      }
      setX(y);
      const f = eventFormOf(y);
      setForm(f);
      setBase(f);
      setTried(false);
      onSaved(y);
    } catch (er) {
      if (!x) createKey.settle(er);
      if (er instanceof ApiError) setSrv(serverIssues(er.details));
      setErr(er instanceof ApiError && er.code === "EVENT_STARTS_IN_PAST" ? t("gi.starts_past") : errText(i18n, er));
    } finally {
      setBusy(false);
    }
  };

  const setMult = (i: number, m: Partial<GameMultiplier>) => {
    setSrv([]);
    setForm((f) => ({ ...f, multipliers: f.multipliers.map((y, j) => (j === i ? { ...y, ...m } : y)) }));
  };
  const nextFree = (): GameMultiplier => {
    for (const a of GAME_ACTIONS) for (const c of MULTIPLIER_CURRENCIES) if (!form.multipliers.some((m) => m.action === a && m.currency === c)) return { action: a, currency: c, factor: 2 };
    return { action: "lesson", currency: "xp", factor: 2 };
  };

  return (
    <Drawer
      wide
      testId="ev-card"
      onClose={onClose}
      title={x ? <span lang="ru">{x.title.ru}</span> : t("ev.new")}
      sub={
        x && (
          <>
            <span className="mono">{x.code}</span>
            <Pill tone={EVENT_TONE[x.status]} testId="ev-card-status">
              {t(`evs.${x.status}` as MessageKey)}
            </Pill>
            {runningNow(x) && <Pill tone="accent">{t("ev.liveNow")}</Pill>}
            <span>{t("ev.author", { n: x.created_by.name })}</span>
            {x.published_by && <span>{t("ev.publishedBy", { n: x.published_by.name })}</span>}
            {dirty && <Pill tone="warn">{t("ct.unsaved")}</Pill>}
          </>
        )
      }
      footer={
        <>
          <span className="grow" />
          {editable && <Btn icon="check" kind={dirty || !x ? "primary" : ""} label={x ? t("common.save") : t("ev.createDraft")} disabled={!!x && !dirty} busy={busy} onClick={() => void save()} testId="ev-save" />}
          {x && can("game.publish") && x.status === "draft" && <Btn icon="send" label={t("ev.publish")} disabled={dirty || errors.length > 0} title={dirty ? t("gr.gate.unsaved") : undefined} onClick={() => (setOverlap(null), setAsk("publish"))} testId="ev-publish" />}
          {x && can("game.publish") && x.status === "published" && <Btn icon="stop" kind="danger-ghost" label={t("ev.cancel")} onClick={() => setAsk("cancel")} testId="ev-cancel" />}
        </>
      }
    >
      <div className="stack" data-testid="ev-form" data-mode={x ? x.status : "create"}>
        {x && x.status !== "draft" && (
          <Callout icon="lock" testId="ev-ro-status">
            {t(`ev.ro.${x.status}` as MessageKey)}
          </Callout>
        )}
        {!can("game.manage") && (
          <Callout icon="lock" testId="ev-card-ro">
            {t("gm.roManage")}
          </Callout>
        )}
        {overlap && (
          <Reveal dep={overlap}>
            <Callout kind="bad" icon="alertCircle" testId="ev-overlap">
              <b>{t("ev.overlapT")}</b> {other ? t("ev.overlapM", { n: other.title.ru, a: zoneDateTime(fmt.locale, other.starts_at), b: zoneDateTime(fmt.locale, other.ends_at) }) : t("err.EVENT_OVERLAP")}{" "}
              {overlap.id && <Btn size="xs" icon="ext" label={t("ev.openOther")} onClick={() => onOpen(overlap.id!)} testId="ev-overlap-open" />}
            </Callout>
          </Reveal>
        )}
        {clash.length > 0 && !overlap && (
          <Callout kind="warn" icon="alert" testId="ev-clash">
            {t("ev.clash", { n: clash.length })}{" "}
            {clash.map((c) => (
              <button key={c.event_id} type="button" className="tr" lang="ru" onClick={() => onOpen(c.event_id)}>
                {c.title.ru}
              </button>
            ))}
          </Callout>
        )}
        {err && (
          <Callout kind="bad" icon="alertCircle" testId="ev-err">
            {err}
          </Callout>
        )}
        <div className="field">
          <label htmlFor={fieldId("ev", "code")} className="req">
            {t("ev.f.code")}
          </label>
          <input id={fieldId("ev", "code")} className={cx("input mono", issuesAt(shown, "code").length > 0 && "is-invalid")} value={form.code} disabled={!!x || !editable} spellCheck={false} onChange={(ev2) => edit({ ...form, code: ev2.target.value.toLowerCase() })} data-testid="ev-code" />
          <span className="hint">{t("gm.codeHint")}</span>
          <IssueMsg issues={issuesAt(shown, "code")} />
        </div>
        <LocFields prefix="ev" path="title" label={t("ev.f.title")} value={form.title} onChange={(v) => edit({ ...form, title: v })} max={EVENT_TITLE_MAX} issues={shown} disabled={!editable} testId="ev-title" />
        <LocFields prefix="ev" path="description" label={t("ev.f.description")} value={form.description} onChange={(v) => edit({ ...form, description: v })} max={EVENT_DESC_MAX} issues={shown} disabled={!editable} area testId="ev-desc" />
        <p className="xs muted row" id="ev-tz" data-testid="ev-tz">
          <Icon name="clock" /> {t("gm.tzNote")}
        </p>
        <div className="form-grid">
          <div className="field">
            <label htmlFor={fieldId("ev", "starts_at")} className="req">
              {t("ev.f.starts")}
            </label>
            <input id={fieldId("ev", "starts_at")} type="datetime-local" className={cx("input", issuesAt(shown, "starts_at").length > 0 && "is-invalid")} value={form.starts} disabled={!editable} onChange={(ev2) => edit({ ...form, starts: ev2.target.value })} aria-describedby="ev-tz" data-testid="ev-starts" />
            <IssueMsg issues={issuesAt(shown, "starts_at")} />
            {issuesAt(warnings, "starts_at").length > 0 && editable && <span className="hint warn-ink">{t("gi.starts_past")}</span>}
          </div>
          <div className="field">
            <label htmlFor={fieldId("ev", "ends_at")} className="req">
              {t("ev.f.ends")}
            </label>
            <input id={fieldId("ev", "ends_at")} type="datetime-local" className={cx("input", issuesAt(shown, "ends_at").length > 0 && "is-invalid")} value={form.ends} disabled={!editable} onChange={(ev2) => edit({ ...form, ends: ev2.target.value })} aria-describedby="ev-days ev-tz" data-testid="ev-ends" />
            <span className="hint" id="ev-days" data-testid="ev-days">
              {Number.isFinite(days) ? t("ev.daysOf", { n: days, max: EVENT_MAX_DAYS }) : t("ev.periodHint", { max: EVENT_MAX_DAYS })}
            </span>
            <IssueMsg issues={issuesAt(shown, "ends_at")} vars={{ n: EVENT_MAX_DAYS }} />
          </div>
        </div>
        <AudiencePicker id={fieldId("ev", "audiences")} value={form.audiences} onChange={(a) => edit({ ...form, audiences: a })} disabled={!editable} issues={issuesAt(shown, "audiences")} hint={t("ev.audHint")} />
        <section className="stack sm" aria-labelledby="ev-m-h" data-testid="ev-mults" id={fieldId("ev", "multipliers")}>
          <h3 className="h3" id="ev-m-h">
            {t("ev.f.multipliers")}
          </h3>
          <p className="xs muted">{t("ev.multNote")}</p>
          {form.multipliers.map((m, i) => {
            const xs = [...issuesAt(shown, `multipliers[${i}]`), ...issuesAt(shown, `multipliers[${i}].factor`)];
            return (
              <div key={i} className={cx("ev-mult", xs.length > 0 && "is-bad")} data-testid={`ev-mult-${i}`}>
                <Select<GameAction> id={`ev-m-${i}-a`} label={t("ev.m.action", { n: i + 1 })} value={m.action} disabled={!editable} onChange={(v) => setMult(i, { action: v })} options={GAME_ACTIONS.map((a) => ({ v: a, label: t(`gact.${a}` as MessageKey) }))} testId={`ev-mult-${i}-action`} />
                <Select<GameMultiplier["currency"]> id={`ev-m-${i}-c`} label={t("ev.m.currency", { n: i + 1 })} value={m.currency} disabled={!editable} onChange={(v) => setMult(i, { currency: v })} options={MULTIPLIER_CURRENCIES.map((c) => ({ v: c, label: c === "xp" ? "XP" : t("gm.cur.til") }))} testId={`ev-mult-${i}-cur`} />
                <Select<string> id={`ev-m-${i}-f`} label={t("ev.m.factor", { n: i + 1 })} value={String(m.factor)} disabled={!editable} onChange={(v) => setMult(i, { factor: Number(v) as GameMultiplier["factor"] })} options={FACTORS.map((f) => ({ v: String(f), label: `×${factorText(fmt, f)}` }))} testId={`ev-mult-${i}-factor`} />
                {editable && <Btn size="xs" kind="ghost" icon="x" aria={t("ev.m.remove", { n: i + 1 })} onClick={() => edit({ ...form, multipliers: form.multipliers.filter((_, j) => j !== i) })} testId={`ev-mult-${i}-remove`} />}
                <IssueMsg issues={xs} />
              </div>
            );
          })}
          <IssueMsg issues={issuesAt(shown, "multipliers")} vars={{ n: MULTIPLIERS_MAX }} />
          {editable && <Btn size="sm" icon="plus" label={t("ev.m.add")} disabled={form.multipliers.length >= MULTIPLIERS_MAX} onClick={() => edit({ ...form, multipliers: [...form.multipliers, nextFree()] })} testId="ev-mult-add" />}
        </section>
      </div>
      {ask && x && (
        <ConfirmCommand
          title={t(ask === "publish" ? "ev.publishT" : "ev.cancelT", { n: x.title.ru })}
          text={ask === "publish" ? t("ev.publishM", { a: zoneDateTime(fmt.locale, x.starts_at), b: zoneDateTime(fmt.locale, x.ends_at) }) : t("ev.cancelM")}
          icon={ask === "publish" ? "send" : "stop"}
          tone={ask === "cancel" ? "bad" : "warn"}
          ok={t(ask === "publish" ? "ev.publish" : "ev.cancel")}
          okKind={ask === "cancel" ? "danger" : "primary"}
          minReason={COMMENT_MIN}
          maxReason={COMMENT_MAX}
          reasonLabel={t("gm.comment")}
          reasonPlaceholder={t("gm.commentPh")}
          testId="ev-cmd-dialog"
          extra={
            <>
              {ask === "publish" && issuesAt(warnings, "starts_at").length > 0 && (
                <Callout kind="warn" icon="alert" testId="ev-starts-past">
                  {t("gi.starts_past")}
                </Callout>
              )}
              <Callout kind="info" icon="smartphoneKey">
                {t("ct.stepUpNote")}
              </Callout>
            </>
          }
          onClose={() => setAsk(null)}
          onConfirm={async (c) => {
            const key = cmdKey.for(JSON.stringify([ask, x.event_id, c]));
            try {
              const y = ask === "publish" ? await Game.publishEvent(x.event_id, c, key) : await Game.cancelEvent(x.event_id, c, key);
              cmdKey.settle();
              setX(y);
              const f = eventFormOf(y);
              setForm(f);
              setBase(f);
              onSaved(y);
              toast(t(ask === "publish" ? "ev.published" : "ev.cancelled", { c: y.code }), "ok", ask === "publish" ? "game.event_published" : "game.event_cancelled");
              return null;
            } catch (er) {
              cmdKey.settle(er);
              if ((er as ApiError)?.cancelled) return t("stepup.cancelled");
              if (er instanceof ApiError && er.code === "EVENT_OVERLAP") {
                // the dialog closes; the card shows the event it overlaps with and a link to it
                setOverlap({ id: er.str("event_id") });
                return null;
              }
              // INTERNAL_API §12: a start in the past → 422 EVENT_STARTS_IN_PAST
              if (er instanceof ApiError && er.code === "EVENT_STARTS_IN_PAST") return t("gi.starts_past");
              return errText(i18n, er);
            }
          }}
        />
      )}
    </Drawer>
  );
}
