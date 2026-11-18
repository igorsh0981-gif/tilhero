/**
 * «Рассылки» (notif.campaigns.manage; schedule and emergency stop — notif.campaigns.send with step-up): product news
 * to learners with the «Новости TilHero» consent. Draft (internal title, RU/UZ texts with {learner_name}, button route),
 * segment (language, 14+/18+, onboarding, activity), reach estimate, preview, test to the test chats, schedule, stop and
 * statistics. Child profiles are never in the audience; at most one campaign per learner in 7 days (server).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Campaign, CampaignContent, CampaignEstimate, CampaignSegment, CampaignStatus, ReleaseNoteRoute, UiLang } from "@tilhero/contracts/admin";
import { Campaigns } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Reveal, Select, Spinner, TabPanel, Tabs, type Tone } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { CAMPAIGN_PLACEHOLDERS, CAMPAIGN_TITLE_MAX, campaignContent, emptyCampaign, issuesIn, LANGS, normalizeSegment, normalizeTexts, NOTE_ROUTES, sameJson, serverIssues, substitute, TEXT_LIMITS, validateCampaign, type Issues } from "./catalog";
import { PreviewControls, TelegramMessage, TextInput, useInsertAtCaret } from "./parts";
import { TestSend } from "./Templates";

export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ["draft", "scheduled", "sending", "done", "stopped"];
const ST_TONE: Record<CampaignStatus, Tone> = { draft: "neutral", scheduled: "info", sending: "warn", done: "good", stopped: "bad" };

type Sel = { kind: "new" } | { kind: "c"; id: string } | null;
type Cmd = { kind: "schedule" | "unschedule" | "stop"; c: Campaign; key: string } | null;

export function CampaignStatusPill({ s }: { s: CampaignStatus }) {
  const { t } = useI18n();
  return <Pill tone={ST_TONE[s]}>{t(`cmp.st.${s}`)}</Pill>;
}

/** Segment in words: «RU, UZ · 18+ · прошли онбординг · занимались за 14 дней». */
export function useSegmentText() {
  const { t } = useI18n();
  return (s: CampaignSegment) => {
    const parts: string[] = [];
    parts.push(s.ui_lang?.length ? s.ui_lang.map((l) => l.toUpperCase()).join(", ") : t("cmp.allLangs"));
    parts.push((s.age?.length ? s.age : (["adults"] as const)).map((a) => t(`ageseg.${a}`)).join(", "));
    if (s.onboarded === true) parts.push(t("cmp.onb.yes"));
    if (s.onboarded === false) parts.push(t("cmp.onb.no"));
    if (s.active_days && s.active_days > 0) parts.push(t("cmp.act.in", { n: s.active_days }));
    if (s.active_days && s.active_days < 0) parts.push(t("cmp.act.out", { n: -s.active_days }));
    return parts.join(" · ");
  };
}

export function CampaignsTab({ openId }: { openId: string | null }) {
  const i = useI18n();
  const { t, fmt } = i;
  const segText = useSegmentText();
  const [items, setItems] = useState<Campaign[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<CampaignStatus | "">("");
  const [sel, setSel] = useState<Sel>(openId ? { kind: "c", id: openId } : null);

  const load = useCallback(async (more?: string | null, background = false) => {
    try {
      const r = await Campaigns.list(status || null, more ?? null, background);
      setItems((xs) => (more && xs ? [...xs, ...r.items] : r.items));
      setCursor(r.next_cursor);
      setError(null);
      return r.items;
    } catch (e) {
      if (!background) setError(e);
      return null;
    }
  }, [status]);
  useEffect(() => {
    void load().then((xs) => setSel((s) => s ?? (xs?.[0] ? { kind: "c", id: xs[0].campaign_id } : null)));
  }, [load]);
  // live progress of running campaigns: quiet poll (X-Background — does not extend the session)
  const running = !!items?.some((c) => c.status === "sending" || c.status === "scheduled");
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void load(null, true), 15_000);
    return () => clearInterval(id);
  }, [running, load]);

  if (error && !items) return <LoadError error={error} onRetry={() => void load()} />;
  if (!items) return <Spinner label={t("common.loading")} />;

  return (
    <div className="stack" data-testid="campaigns">
      <section className="panel" data-testid="cmp-list">
        <div className="panel-h">
          <h2 className="panel-t grow">
            <Icon name="megaphone" />
            {t("cmp.list")}
          </h2>
          <Select<CampaignStatus | ""> id="cmp-f-st" label={t("col.status")} value={status} onChange={setStatus} options={[{ v: "", label: t("cmp.allStatuses") }, ...CAMPAIGN_STATUSES.map((s) => ({ v: s, label: t(`cmp.st.${s}`) }))]} />
          <Btn size="sm" kind="primary" icon="plus" label={t("cmp.new")} perm="notif.campaigns.manage" onClick={() => setSel({ kind: "new" })} testId="cmp-new" />
        </div>
        {items.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t("cmp.col.title")}</th>
                  <th scope="col">{t("cmp.col.segment")}</th>
                  <th scope="col">{t("cmp.col.when")}</th>
                  <th scope="col" className="r">
                    {t("cmp.col.sent")}
                  </th>
                  <th scope="col">{t("col.status")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => {
                  const active = sel?.kind === "c" && sel.id === c.campaign_id;
                  return (
                    <tr key={c.campaign_id} className={active ? "is-sel" : undefined} data-testid={`cmp-row-${c.campaign_id}`}>
                      <td>
                        <button type="button" className="tr" aria-current={active ? "true" : undefined} onClick={() => setSel({ kind: "c", id: c.campaign_id })} data-testid={`cmp-open-${c.campaign_id}`}>
                          {c.title}
                        </button>
                        <div className="cell-sub">{c.created_by_name ?? ""}</div>
                      </td>
                      <td className="small">{segText(c.segment)}</td>
                      <td className="small nowrap">{c.send_at ? fmt.dateTime(c.send_at) : c.status === "draft" ? "—" : t("cmp.asap")}</td>
                      <td className="r num">{c.status === "draft" ? "—" : `${fmt.num(c.stats.sent)} / ${fmt.num(c.stats.audience)}`}</td>
                      <td>
                        <CampaignStatusPill s={c.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="megaphone" title={t("cmp.empty")} text={t("cmp.emptyM")} />
        )}
        {cursor && (
          <div className="more-row">
            <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} />
          </div>
        )}
      </section>
      {sel && (
        <CampaignDetail
          key={sel.kind === "new" ? "new" : sel.id}
          id={sel.kind === "c" ? sel.id : null}
          onSaved={async (c) => {
            await load();
            setSel({ kind: "c", id: c.campaign_id });
          }}
          onChanged={() => void load(null, true)}
        />
      )}
    </div>
  );
}

function CampaignDetail({ id, onSaved, onChanged }: { id: string | null; onSaved: (c: Campaign) => Promise<void>; onChanged: () => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const toast = useToast();
  const segText = useSegmentText();
  const [c, setC] = useState<Campaign | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState<CampaignContent | null>(id ? null : emptyCampaign());
  const [base, setBase] = useState<CampaignContent | null>(null);
  const [lang, setLang] = useState<UiLang>("ru");
  const [pvLang, setPvLang] = useState<UiLang>("ru");
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Issues>({});
  const [formErr, setFormErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [est, setEst] = useState<CampaignEstimate | null>(null);
  const [estBusy, setEstBusy] = useState(false);
  const [cmd, setCmd] = useState<Cmd>(null);
  const createKey = useRef<string>(uuid());
  const ins = useInsertAtCaret();

  const apply = useCallback((x: Campaign) => {
    setC(x);
    const content = campaignContent(x);
    setDraft(content);
    setBase(content);
    setServer({});
    setTried(false);
    setConflict(false);
  }, []);

  const load = useCallback(async (background = false) => {
    if (!id) return;
    try {
      const x = await Campaigns.get(id, background);
      if (background) {
        setC(x); // live stats only; the editor keeps what the staff member is typing
        return;
      }
      apply(x);
      setError(null);
    } catch (e) {
      if (!background) setError(e);
    }
  }, [id, apply]);
  useEffect(() => {
    void load();
  }, [load]);
  const live = c?.status === "sending" || c?.status === "scheduled";
  useEffect(() => {
    if (!live) return;
    const tm = setInterval(() => void load(true), 10_000);
    return () => clearInterval(tm);
  }, [live, load]);

  const issues = useMemo(() => (draft ? validateCampaign(draft) : {}), [draft]);
  const shown: Issues = useMemo(() => {
    const out: Issues = { ...server };
    for (const [p, x] of Object.entries(issues)) if (x.reason !== "required" || tried) out[p] = x;
    return out;
  }, [issues, server, tried]);

  if (error && !c) return <LoadError error={error} onRetry={() => void load()} />;
  if (!draft) return <Spinner label={t("common.loading")} />;

  const isDraft = !c || c.status === "draft";
  const editable = can("notif.campaigns.manage") && isDraft;
  const dirty = !base || !sameJson(normalize(draft), normalize(base));
  const update = (fn: (d: CampaignContent) => CampaignContent) => {
    setDraft((d) => (d ? fn(d) : d));
    setServer({});
    setFormErr(null);
    setEst(null);
  };
  const setText = (l: UiLang, f: "title" | "body" | "button", v: string) => update((d) => ({ ...d, texts: { ...d.texts, [l]: { ...d.texts[l], [f]: f === "button" ? (v === "" ? null : v) : v } } }));
  const setSeg = (fn: (s: CampaignSegment) => CampaignSegment) => update((d) => ({ ...d, segment: normalizeSegment(fn(d.segment)) }));

  const save = async (): Promise<Campaign | null> => {
    if (saving) return null;
    setTried(true);
    const e = validateCampaign(draft);
    if (Object.keys(e).length) {
      setFormErr(t("cmp.errForm"));
      const l = LANGS.find((x) => issuesIn(e, x));
      if (l) setLang(l);
      return null;
    }
    setSaving(true);
    setFormErr(null);
    try {
      const body = normalize(draft);
      const x = c ? await Campaigns.patch(c.campaign_id, c.version, body) : await Campaigns.create(body, createKey.current);
      toast(t(c ? "cmp.saved" : "cmp.created", { x: x.title }), "ok", c ? "campaign.updated" : "campaign.created");
      if (!c) await onSaved(x);
      else {
        apply(x);
        onChanged();
      }
      return x;
    } catch (ex) {
      if ((ex as ApiError).cancelled) return null;
      if (ex instanceof ApiError && ex.code === "CAMPAIGN_VERSION_CONFLICT") setConflict(true);
      if (ex instanceof ApiError && ex.status === 422) {
        const si = serverIssues(ex.details);
        setServer(si);
        const l = LANGS.find((x) => issuesIn(si, x));
        if (l) setLang(l);
      }
      setFormErr(errText(i, ex));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const estimate = async () => {
    if (!c) return;
    setEstBusy(true);
    try {
      setEst(await Campaigns.estimate(c.campaign_id));
    } catch (e) {
      if (!(e as ApiError).cancelled) setFormErr(errText(i, e));
    } finally {
      setEstBusy(false);
    }
  };

  const tx = draft.texts[pvLang];
  const vals = { learner_name: t("cmp.sampleName") };
  const s = c?.stats;

  return (
    <section className="card stack" aria-labelledby="cmp-h" data-testid="cmp-detail">
      <div className="row between">
        <div>
          <div className="crumb">{c ? t("cmp.crumb", { by: c.created_by_name ?? c.created_by, at: fmt.dateTime(c.created_at) }) : t("cmp.newCrumb")}</div>
          <h2 className="h2" id="cmp-h">
            {c ? c.title : t("cmp.newT")}
          </h2>
        </div>
        <span className="row">
          {c && <CampaignStatusPill s={c.status} />}
          {c?.send_at && <span className="small muted">{t("cmp.sendAt", { t: fmt.dateTime(c.send_at) })}</span>}
          {c && <span className="xs muted mono">v{c.version}</span>}
        </span>
      </div>

      {c && c.status !== "draft" && <CampaignProgress c={c} />}
      {conflict && (
        <Reveal dep={conflict}>
          <Callout kind="warn" icon="alert" testId="cmp-conflict">
            <b>{t("cmp.conflict")}</b> <Btn size="xs" icon="refresh" label={t("wn.reload")} onClick={() => void load()} />
          </Callout>
        </Reveal>
      )}
      {!isDraft && (
        <Callout icon="lock" testId="cmp-readonly">
          {t("cmp.ro")}
        </Callout>
      )}

      <div className="cmp-grid">
        <div className="stack sm">
          <TextInput id="cmp-title" label={t("cmp.f.title")} value={draft.title} max={CAMPAIGN_TITLE_MAX} disabled={!editable} issue={shown.title} onChange={(v) => update((d) => ({ ...d, title: v }))} testId="cmp-title" />
          <Tabs<UiLang> id="cmp-lang" label={t("wn.langTabs")} value={lang} onChange={setLang} items={LANGS.map((l) => ({ v: l, label: t(`ulang.${l}`), cnt: issuesIn(shown, l) || null, bad: true, testId: `cmp-lang-${l}` }))} />
          <TabPanel id="cmp-lang" value={lang}>
            <div className="stack sm">
              <TextInput id={`cmp-t-${lang}`} label={t("tpl.f.title")} value={draft.texts[lang].title} max={TEXT_LIMITS.title} lang={lang} disabled={!editable} issue={shown[`texts.${lang}.title`]} missing={shown[`texts.${lang}.title`]?.reason === "required"} onChange={(v) => setText(lang, "title", v)} onFocusEl={ins.track((v) => setText(lang, "title", v))} testId={`cmp-t-${lang}`} />
              <TextInput id={`cmp-b-${lang}`} label={t("tpl.f.body")} value={draft.texts[lang].body} max={TEXT_LIMITS.body} lang={lang} multiline rows={5} disabled={!editable} issue={shown[`texts.${lang}.body`]} missing={shown[`texts.${lang}.body`]?.reason === "required"} onChange={(v) => setText(lang, "body", v)} onFocusEl={ins.track((v) => setText(lang, "body", v))} testId={`cmp-b-${lang}`} />
              <TextInput id={`cmp-btn-${lang}`} label={t("tpl.f.button")} value={draft.texts[lang].button ?? ""} max={TEXT_LIMITS.button} lang={lang} required={false} placeholder={t("tpl.f.buttonPh")} disabled={!editable} issue={shown[`texts.${lang}.button`]} onChange={(v) => setText(lang, "button", v)} onFocusEl={ins.track((v) => setText(lang, "button", v))} testId={`cmp-btn-${lang}`} />
            </div>
          </TabPanel>
          <div className="ph-chips" role="group" aria-label={t("tpl.placeholders")}>
            <span className="field-label">{t("tpl.placeholders")}</span>
            {CAMPAIGN_PLACEHOLDERS.map((p) => (
              <button
                key={p}
                type="button"
                className="chip"
                disabled={!editable}
                title={t("cmp.phName")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (!ins.insert(`{${p}}`)) setText(lang, "body", `${draft.texts[lang].body} {${p}}`.trim());
                }}
                data-testid={`cmp-ph-${p}`}
              >
                <Icon name="braces" />
                {p}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="cmp-route">{t("cmp.f.route")}</label>
            <Select<ReleaseNoteRoute | ""> id="cmp-route" label={t("cmp.f.route")} value={draft.route ?? ""} disabled={!editable} onChange={(v) => update((d) => ({ ...d, route: v || null }))} options={[{ v: "", label: t("cmp.noButton") }, ...NOTE_ROUTES.map((r) => ({ v: r, label: t(`route.${r}`) }))]} />
          </div>
        </div>

        <div className="stack sm">
          <fieldset className="fs cmp-seg" data-testid="cmp-segment">
            <legend className="h3">{t("cmp.segment")}</legend>
            <div className="field">
              <span className="field-label">{t("cmp.seg.lang")}</span>
              <div className="row">
                {LANGS.map((l) => (
                  <label key={l} className="check">
                    <input type="checkbox" disabled={!editable} checked={!!draft.segment.ui_lang?.includes(l)} onChange={(e) => setSeg((sg) => ({ ...sg, ui_lang: e.target.checked ? [...(sg.ui_lang ?? []), l] : (sg.ui_lang ?? []).filter((x) => x !== l) }))} data-testid={`cmp-lang-${l}-on`} />
                    <span>{t(`ulang.${l}`)}</span>
                  </label>
                ))}
              </div>
              <span className="hint">{t("cmp.seg.langHint")}</span>
            </div>
            <div className="field">
              <span className="field-label">{t("cmp.seg.age")}</span>
              <div className="row">
                {(["teens", "adults"] as const).map((a) => (
                  <label key={a} className="check">
                    <input type="checkbox" disabled={!editable} checked={(draft.segment.age ?? ["adults"]).includes(a)} onChange={(e) => setSeg((sg) => ({ ...sg, age: e.target.checked ? [...(sg.age ?? ["adults"]), a] : (sg.age ?? ["adults"]).filter((x) => x !== a) }))} data-testid={`cmp-age-${a}`} />
                    <span>{t(`ageseg.${a}`)}</span>
                  </label>
                ))}
                <span className="tag plain kid" title={t("cmp.kidsNever")}>
                  <Icon name="shield" /> {t("cmp.kidsNo")}
                </span>
              </div>
              <span className="hint">{t("cmp.seg.ageHint")}</span>
            </div>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="cmp-onb">{t("cmp.seg.onb")}</label>
                <Select<"" | "yes" | "no">
                  id="cmp-onb"
                  label={t("cmp.seg.onb")}
                  value={draft.segment.onboarded === true ? "yes" : draft.segment.onboarded === false ? "no" : ""}
                  disabled={!editable}
                  onChange={(v) => setSeg((sg) => ({ ...sg, onboarded: v === "" ? undefined : v === "yes" }))}
                  options={[
                    { v: "", label: t("cmp.onb.any") },
                    { v: "yes", label: t("cmp.onb.yes") },
                    { v: "no", label: t("cmp.onb.no") },
                  ]}
                />
              </div>
              <div className="span-2">
                <ActivityField value={draft.segment.active_days} disabled={!editable} issue={!!shown["segment.active_days"]} onChange={(n) => setSeg((sg) => ({ ...sg, active_days: n }))} />
              </div>
            </div>
            <p className="xs muted">{t("cmp.seg.always")}</p>
          </fieldset>

          <div className="est" data-testid="cmp-estimate">
            <div className="row between">
              <b>{t("cmp.reach")}</b>
              <Btn size="sm" icon="users" label={t("cmp.estimate")} perm="notif.campaigns.manage" busy={estBusy} disabled={!c || dirty} title={!c || dirty ? t("cmp.saveToEstimate") : undefined} onClick={() => void estimate()} testId="cmp-estimate-btn" />
            </div>
            {est ? (
              <div className="est-b" role="status">
                <div className="kpi-v" data-testid="cmp-est-audience">
                  {fmt.num(est.audience)}
                </div>
                <div className="small">
                  RU {fmt.num(est.by_lang.ru ?? 0)} · UZ {fmt.num(est.by_lang.uz ?? 0)} · {t("cmp.capped", { n: fmt.num(est.frequency_capped) })}
                </div>
                <div className="xs muted">{t("cmp.estAt", { t: fmt.time(est.computed_at) })}</div>
              </div>
            ) : (
              <p className="xs muted">{c ? segText(draft.segment) : t("cmp.saveToEstimate")}</p>
            )}
          </div>
        </div>

        <div className="stack sm cmp-pv">
          <div className="row between">
            <span className="field-label">{t("tpl.preview")}</span>
            <PreviewControls lang={pvLang} setLang={setPvLang} />
          </div>
          <TelegramMessage lang={pvLang} title={substitute(tx.title, vals)} body={substitute(tx.body, vals)} button={draft.route ? tx.button ?? "" : null} label={t("tpl.previewLabel", { l: pvLang.toUpperCase() })} />
          <p className="xs muted center">{t("cmp.pvNote")}</p>
          {c && <TestSend single send={(_v, l, r) => Campaigns.test(c.campaign_id, l, r)} />}
        </div>
      </div>

      <FieldErr msg={formErr} />
      <div className="acts">
        {editable && <Btn kind={dirty ? "primary" : ""} icon="check" label={c ? t("cmp.save") : t("cmp.create")} busy={saving} disabled={!dirty} onClick={() => void save()} testId="cmp-save" />}
        {c?.status === "draft" && can("notif.campaigns.send") && (
          <Btn kind="primary" icon="calendar" label={t("cmp.schedule")} perm="notif.campaigns.send" disabled={dirty} title={dirty ? t("wn.saveFirst") : undefined} onClick={() => setCmd({ kind: "schedule", c, key: uuid() })} testId="cmp-schedule" />
        )}
        {c?.status === "scheduled" && can("notif.campaigns.send") && <Btn icon="rollback" label={t("cmp.unschedule")} perm="notif.campaigns.send" onClick={() => setCmd({ kind: "unschedule", c, key: uuid() })} testId="cmp-unschedule" />}
        {(c?.status === "scheduled" || c?.status === "sending") && can("notif.campaigns.send") && <Btn kind="danger" icon="stop" label={t("cmp.stop")} perm="notif.campaigns.send" onClick={() => setCmd({ kind: "stop", c, key: uuid() })} testId="cmp-stop" />}
      </div>
      {c && c.status !== "done" && c.status !== "stopped" && !can("notif.campaigns.send") && (
        <p className="xs muted row" data-testid="cmp-no-send">
          <Icon name="lock" /> {t("cmp.noSend", { p: "notif.campaigns.send" })}
        </p>
      )}
      {s && c?.status !== "draft" && c?.stop_reason && (
        <p className="small bad-ink">
          {t("cmp.stoppedBy", { by: c.stopped_by ?? "—", at: fmt.dateTime(c.stopped_at), r: c.stop_reason })}
        </p>
      )}

      {cmd && <CampaignCommand cmd={cmd} est={est} onClose={() => setCmd(null)} onDone={(x) => { apply(x); onChanged(); }} />}
    </section>
  );
}

const normalize = (d: CampaignContent): CampaignContent => ({ title: d.title.trim(), texts: normalizeTexts(d.texts), route: d.route ?? null, segment: normalizeSegment(d.segment) });

function ActivityField({ value, onChange, disabled, issue }: { value: number | undefined; onChange: (n: number | undefined) => void; disabled: boolean; issue: boolean }) {
  const { t } = useI18n();
  const mode = value == null ? "" : value > 0 ? "in" : "out";
  const n = value == null ? 14 : Math.abs(value);
  return (
    <div className="field">
      <label htmlFor="cmp-act">{t("cmp.seg.act")}</label>
      <div className="row nowrap-row">
        <Select<"" | "in" | "out">
          id="cmp-act"
          label={t("cmp.seg.act")}
          value={mode}
          disabled={disabled}
          onChange={(m) => onChange(m === "" ? undefined : m === "in" ? n : -n)}
          options={[
            { v: "", label: t("cmp.act.any") },
            { v: "in", label: t("cmp.act.inShort") },
            { v: "out", label: t("cmp.act.outShort") },
          ]}
        />
        {mode && (
          <input
            className={cx("input mono num-in", issue && "is-invalid")}
            type="number"
            min={1}
            max={90}
            value={n}
            disabled={disabled}
            aria-label={t("cmp.act.days")}
            onChange={(e) => {
              const v = Math.max(1, Math.min(90, Number(e.target.value) || 1));
              onChange(mode === "in" ? v : -v);
            }}
          />
        )}
        {mode && <span className="small muted">{t("cmp.act.daysShort")}</span>}
      </div>
    </div>
  );
}

/** Progress of a scheduled / running / finished campaign (CampaignStats). */
function CampaignProgress({ c }: { c: Campaign }) {
  const { t, fmt } = useI18n();
  const s = c.stats;
  const total = Math.max(1, s.audience);
  const rows: Array<[string, number, string]> = [
    ["created", s.created, "sw-1"],
    ["sent", s.sent, "sw-2"],
    ["in_app_only", s.in_app_only, "sw-3"],
    ["deferred", s.deferred, "sw-4"],
    ["skipped_frequency", s.skipped_frequency, "sw-5"],
    ["failed", s.failed, "sw-6"],
  ];
  return (
    <div className="cmp-stats" data-testid="cmp-stats">
      <div className="row between">
        <b>{t("cmp.stats")}</b>
        <span className="small muted">
          {c.started_at ? t("cmp.started", { t: fmt.dateTime(c.started_at) }) : ""}
          {c.finished_at ? ` · ${t("cmp.finished", { t: fmt.dateTime(c.finished_at) })}` : ""}
        </span>
      </div>
      <div className="kv">
        <span>{t("cmp.s.audience")}</span>
        <span className="num b" data-testid="cmp-s-audience">
          {fmt.num(s.audience)}
        </span>
      </div>
      {rows.map(([k, n, cls]) => (
        <div className="kv" key={k}>
          <span>{t(`cmp.s.${k}` as "cmp.s.sent")}</span>
          <span className="row nowrap-row">
            <span className="barbg" aria-hidden="true">
              <span className={cx("barfg", cls)} style={{ width: `${Math.round((n / total) * 100)}%` }} />
            </span>
            <span className="num" data-testid={`cmp-s-${k}`}>
              {fmt.num(n)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** schedule (step-up, Idempotency-Key, send_at) / unschedule / emergency stop (step-up). */
function CampaignCommand({ cmd, est, onClose, onDone }: { cmd: NonNullable<Cmd>; est: CampaignEstimate | null; onClose: () => void; onDone: (c: Campaign) => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const toast = useToast();
  const [when, setWhen] = useState<"asap" | "at">("asap");
  const [at, setAt] = useState(() => localInput(new Date(Date.now() + 60 * 60_000)));
  const [atErr, setAtErr] = useState<string | null>(null);
  const k = cmd.kind;
  return (
    <ConfirmCommand
      title={k === "schedule" ? t("cmp.scheduleT", { x: cmd.c.title }) : k === "stop" ? t("cmp.stopT", { x: cmd.c.title }) : t("cmp.unscheduleT", { x: cmd.c.title })}
      text={k === "schedule" ? t("cmp.scheduleM") : k === "stop" ? t("cmp.stopM") : t("cmp.unscheduleM")}
      icon={k === "schedule" ? "calendar" : k === "stop" ? "stop" : "rollback"}
      tone={k === "stop" ? "bad" : "warn"}
      ok={k === "schedule" ? t("cmp.schedule") : k === "stop" ? t("cmp.stop") : t("cmp.unschedule")}
      okKind={k === "stop" ? "danger" : "primary"}
      testId="cmp-confirm"
      extra={
        <>
          {k === "schedule" && (
            <fieldset className="fs stack sm" data-testid="cmp-when">
              <legend className="field-label">{t("cmp.when")}</legend>
              <label className="check">
                <input type="radio" name="cmp-when" checked={when === "asap"} onChange={() => setWhen("asap")} data-testid="cmp-when-asap" />
                <span>{t("cmp.asapLong")}</span>
              </label>
              <label className="check">
                <input type="radio" name="cmp-when" checked={when === "at"} onChange={() => setWhen("at")} data-testid="cmp-when-at" />
                <span>{t("cmp.atLong")}</span>
              </label>
              {when === "at" && (
                <div className="field">
                  <label htmlFor="cmp-at">{t("cmp.at")}</label>
                  <input id="cmp-at" type="datetime-local" className={cx("input", atErr && "is-invalid")} value={at} onChange={(e) => setAt(e.target.value)} data-testid="cmp-at" />
                  <FieldErr msg={atErr} />
                </div>
              )}
              {est && <p className="small">{t("cmp.estLine", { n: fmt.num(est.audience), c: fmt.num(est.frequency_capped) })}</p>}
              <p className="xs muted">{t("cmp.quiet")}</p>
            </fieldset>
          )}
          {k !== "unschedule" && (
            <Callout kind="info" icon="smartphoneKey">
              {t("wn.stepUpNote")}
            </Callout>
          )}
        </>
      }
      onClose={onClose}
      onConfirm={async (reason) => {
        let sendAt = new Date().toISOString();
        if (k === "schedule" && when === "at") {
          const d = new Date(at);
          if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 30 * 86_400_000) {
            setAtErr(t("cmp.errAt"));
            return t("cmp.errAt");
          }
          setAtErr(null);
          sendAt = d.toISOString();
        }
        try {
          const x =
            k === "schedule"
              ? await Campaigns.schedule(cmd.c.campaign_id, cmd.c.version, sendAt, reason, cmd.key)
              : k === "stop"
                ? await Campaigns.stop(cmd.c.campaign_id, reason)
                : await Campaigns.unschedule(cmd.c.campaign_id, reason);
          toast(t(`cmp.done.${k}`, { x: x.title }), k === "stop" ? "info" : "ok", `campaign.${k === "schedule" ? "scheduled" : k === "stop" ? "stopped" : "unscheduled"}`);
          onDone(x);
          return null;
        } catch (e) {
          return (e as ApiError).cancelled ? t("stepup.cancelled") : errText(i, e);
        }
      }}
    />
  );
}

/** «YYYY-MM-DDTHH:mm» in the browser's local time for <input type="datetime-local">. */
export function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
