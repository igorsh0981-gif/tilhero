/**
 * «Контент → Словарь курса» (sprint 5, AT-60, admin.ts «Словарь курса»; catalog via admin-bff). Routes:
 * #/content/glossary[/<entry_id>] — all entries with filters (source, review status, search); #/content/glossary/queue
 * [/<entry_id>] — the queue of AI translations (pending, sorted by the places in the content) with quick «Подтвердить»
 * / «Исправить» (RU/UZ) / «Отклонить» (+ a note). The entry card: forms, translation, example, source, the places in
 * the content with titles, translation conflicts of course entries, the history with authors. Reading — content.read;
 * every action — glossary.manage (the buttons are not shown without it): a methodist entry (409 FORM_TAKEN → link to the
 * entry holding the form), edit with If-Match (409 VERSION_CONFLICT → plain message + «Перечитать»), override of a
 * course entry, archive of a methodist entry with a reason. No step-up (PLAN sprint 5): every change is in the history
 * of the entry and in the audit `glossary.*`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GlossaryDetail, GlossaryRow, GlossaryStats } from "@tilhero/contracts/admin";
import type { GlossaryReviewStatus, GlossarySource, PartOfSpeech } from "@tilhero/contracts/content";
import { Glossary, Languages } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Reveal, Seg, Select, Spinner, type Tone } from "../../ui/kit";
import { ConfirmCommand, Drawer } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import {
  checkEntry,
  createBody,
  emptyForm,
  entryActions,
  formOf,
  GLOSSARY_LIMITS,
  GLOSSARY_SOURCES,
  GLOSSARY_STATUSES,
  glossIssues,
  historyChanges,
  MIN_CONFIDENCE,
  PARTS_OF_SPEECH,
  parseForms,
  patchBody,
  refRoute,
  serverIssues,
  type EntryForm,
  type FormField,
  type FormIssue,
} from "./glossary";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SOURCE_TONE: Record<GlossarySource, Tone> = { course: "info", methodist: "accent", ai: "warn" };
export const GST_TONE: Record<GlossaryReviewStatus, Tone> = { not_required: "neutral", pending: "warn", approved: "good", rejected: "bad" };

export function parseGlossaryRoute(rest: string | null): { view: "all" | "queue"; entry: string | null } {
  const parts = (rest ?? "").split("/").filter(Boolean);
  const view = parts[0] === "queue" ? "queue" : "all";
  const last = parts[parts.length - 1] ?? "";
  return { view, entry: UUID_RE.test(last) ? last.toLowerCase() : null };
}

export function GlossaryTab({ route }: { route: string | null }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const r = parseGlossaryRoute(route);
  const [pairs, setPairs] = useState<string[]>(["ru-en"]);
  const [pair, setPair] = useState("ru-en");
  const [stats, setStats] = useState<GlossaryStats | null>(null);
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const manage = can("glossary.manage");

  useEffect(() => {
    Languages.pairs()
      .then((x) => {
        const ids = x.items.map((p) => p.pair_id);
        if (ids.length) setPairs(ids);
      })
      .catch(() => undefined);
  }, []);
  const loadStats = useCallback(() => {
    Glossary.stats(pair)
      .then(setStats)
      .catch(() => setStats(null));
  }, [pair]);
  useEffect(loadStats, [loadStats, tick]);

  const base = r.view === "queue" ? "glossary/queue" : "glossary";
  const changed = () => setTick((n) => n + 1);
  return (
    <div className="stack" data-testid="glossary">
      <div className="toolbar">
        <Seg<"all" | "queue">
          label={t("gl.views")}
          value={r.view}
          onChange={(v) => navigate("content", v === "queue" ? "glossary/queue" : "glossary")}
          testId="gl-view"
          items={[
            { v: "all", label: t("gl.view.all") },
            { v: "queue", label: t("gl.view.queue"), cnt: stats?.ai_glosses_pending ?? null },
          ]}
        />
        {pairs.length > 1 && <Select id="gl-pair" label={t("gl.pair")} value={pair} onChange={setPair} options={pairs.map((p) => ({ v: p, label: p }))} testId="gl-pair" />}
        <span className="grow" />
        {manage && <Btn size="sm" kind="primary" icon="plus" label={t("gl.new")} onClick={() => setCreating(true)} testId="gl-new" />}
      </div>
      {stats && (
        <p className="small muted row gl-stats" data-testid="gl-stats">
          {t("gl.stats", { c: fmt.num(stats.entries.course), m: fmt.num(stats.entries.methodist), a: fmt.num(stats.entries.ai), o: fmt.num(stats.overridden) })}
          <span>· {t("gl.statsAi", { p: fmt.num(stats.ai_glosses_pending), ok: fmt.num(stats.ai_approved), no: fmt.num(stats.ai_rejected) })}</span>
        </p>
      )}
      {r.view === "queue" ? (
        <AiQueue pair={pair} tick={tick} onOpen={(id) => navigate("content", `${base}/${id}`)} onChanged={changed} />
      ) : (
        <EntryList pair={pair} tick={tick} selected={r.entry} onOpen={(id) => navigate("content", `${base}/${id}`)} />
      )}
      {r.entry && <EntryDrawer key={r.entry} id={r.entry} onClose={() => navigate("content", base)} onChanged={changed} onOpen={(id) => navigate("content", `glossary/${id}`)} />}
      {creating && (
        <NewEntryDrawer
          pair={pair}
          onClose={() => setCreating(false)}
          onCreated={(e) => {
            setCreating(false);
            changed();
            navigate("content", `glossary/${e.entry_id}`);
          }}
          onOpen={(id) => {
            setCreating(false);
            navigate("content", `glossary/${id}`);
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- shared bits */

export function SourcePill({ source, overridden }: { source: GlossarySource; overridden?: boolean }) {
  const { t } = useI18n();
  return (
    <span className="row nowrap-row">
      <Pill tone={SOURCE_TONE[source]} dot={false}>
        {t(`gls.${source}` as MessageKey)}
      </Pill>
      {overridden && (
        <Pill tone="outline" dot={false}>
          {t("gl.overridden")}
        </Pill>
      )}
    </span>
  );
}

function Confidence({ v }: { v: number | null }) {
  const { t, fmt } = useI18n();
  if (v == null) return null;
  const low = v < MIN_CONFIDENCE;
  return (
    <span className={cx("xs block", low ? "bad-ink b" : "muted")} title={low ? t("gl.lowConfM") : undefined}>
      {low && <Icon name="alert" />} {t("gl.confidence", { p: fmt.pct(v * 100, 0) })}
      {low ? ` · ${t("gl.lowConf")}` : ""}
    </span>
  );
}

function useIssueText() {
  const { t } = useI18n();
  return (x: FormIssue) => (x.code === "server" ? x.message || t("err.GLOSSARY_INVALID") : t(`glf.${x.code}` as MessageKey, { max: x.field === "forms" ? GLOSSARY_LIMITS.form : x.field === "lemma" ? GLOSSARY_LIMITS.lemma : x.field === "example_en" ? GLOSSARY_LIMITS.example : x.field === "reason" ? GLOSSARY_LIMITS.reason : GLOSSARY_LIMITS.gloss, n: GLOSSARY_LIMITS.forms }));
}

/* ---------------------------------------------------------------- all entries */

function EntryList({ pair, tick, selected, onOpen }: { pair: string; tick: number; selected: string | null; onOpen: (id: string) => void }) {
  const { t, fmt } = useI18n();
  const [q, setQ] = useState("");
  const [source, setSource] = useState<GlossarySource | "">("");
  const [status, setStatus] = useState<GlossaryReviewStatus | "">("");
  const [rows, setRows] = useState<GlossaryRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const req = useRef(0);
  const load = useCallback(
    async (more?: string | null) => {
      const id = ++req.current;
      try {
        const r = await Glossary.list({ pair_id: pair, q: q.trim() || undefined, source, review_status: status, cursor: more ?? null });
        if (id !== req.current) return;
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError(null);
      } catch (e) {
        if (id === req.current) setError(e);
      }
    },
    [pair, q, source, status],
  );
  useEffect(() => {
    const tm = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(tm);
  }, [load, q, tick]);
  const filtered = !!(q || source || status);
  return (
    <section className="panel" aria-labelledby="gl-list-h" data-testid="gl-list">
      <div className="panel-h">
        <h2 className="panel-t grow" id="gl-list-h">
          <Icon name="layers" /> {t("gl.title")}
        </h2>
      </div>
      <div className="panel-b toolbar" role="search">
        <div className="input-wrap grow-2">
          <Icon name="search" />
          <input className="input" type="search" value={q} maxLength={100} placeholder={t("gl.searchPh")} aria-label={t("gl.search")} onChange={(e) => setQ(e.target.value)} data-testid="gl-q" />
        </div>
        <Select<GlossarySource | ""> id="gl-source" label={t("gl.source")} value={source} onChange={setSource} testId="gl-source" options={[{ v: "", label: t("gl.allSources") }, ...GLOSSARY_SOURCES.map((s) => ({ v: s, label: t(`gls.${s}` as MessageKey) }))]} />
        <Select<GlossaryReviewStatus | ""> id="gl-status" label={t("gl.status")} value={status} onChange={setStatus} testId="gl-status" options={[{ v: "", label: t("gl.allStatuses") }, ...GLOSSARY_STATUSES.map((s) => ({ v: s, label: t(`glst.${s}` as MessageKey) }))]} />
      </div>
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="tbl gl-tbl" data-testid="gl-rows">
            <caption className="sr-only">{t("gl.title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("gl.col.lemma")}</th>
                <th scope="col">{t("gl.col.gloss")}</th>
                <th scope="col">{t("gl.source")}</th>
                <th scope="col">{t("gl.status")}</th>
                <th scope="col" className="r">
                  {t("gl.col.refs")}
                </th>
                <th scope="col">{t("gl.col.updated")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.entry_id} className={cx(selected === x.entry_id && "is-sel")} data-testid={`gl-row-${x.lemma}`}>
                  <td>
                    <button type="button" className="tr" lang="en" onClick={() => onOpen(x.entry_id)} data-testid={`gl-open-${x.lemma}`}>
                      {x.lemma}
                    </button>
                    <span className="xs muted block mono wrap-any" lang="en">
                      {x.forms.join(" · ")}
                    </span>
                    {x.part_of_speech && <span className="xs muted">{t(`pos.${x.part_of_speech}` as MessageKey)}</span>}
                  </td>
                  <td className="small">
                    <span lang="ru">{x.gloss.ru}</span>
                    <span className="block muted" lang="uz-Latn">
                      {x.gloss.uz}
                    </span>
                  </td>
                  <td>
                    <SourcePill source={x.source} overridden={x.overridden} />
                  </td>
                  <td>
                    <Pill tone={GST_TONE[x.review_status]}>{t(`glst.${x.review_status}` as MessageKey)}</Pill>
                    {x.source === "ai" && <Confidence v={x.confidence} />}
                  </td>
                  <td className="r num">{fmt.num(x.refs_count)}</td>
                  <td className="small nowrap">
                    {fmt.dateTime(x.updated_at)}
                    <span className="cell-sub block">{x.updated_by_name ?? (x.updated_by ? "—" : t("gl.system"))}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="inbox" title={t("gl.empty")} text={filtered ? t("common.changeFilters") : t("gl.emptyM")} testId="gl-empty" />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} />
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- the queue of AI translations */

function AiQueue({ pair, tick, onOpen, onChanged }: { pair: string; tick: number; onOpen: (id: string) => void; onChanged: () => void }) {
  const { t } = useI18n();
  const { can } = useSession();
  const [rows, setRows] = useState<GlossaryRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(
    async (more?: string | null) => {
      try {
        const r = await Glossary.list({ pair_id: pair, review_status: "pending", cursor: more ?? null });
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [pair],
  );
  useEffect(() => {
    void load();
  }, [load, tick]);
  const manage = can("glossary.manage");
  return (
    <section className="panel" aria-labelledby="gl-q-h" data-testid="gl-queue">
      <div className="panel-h">
        <h2 className="panel-t grow" id="gl-q-h">
          <Icon name="sparkles" /> {t("gl.queue")}
        </h2>
        <Btn size="sm" icon="refresh" label={t("common.refresh")} onClick={() => void load()} />
      </div>
      <p className="panel-b xs muted">{manage ? t("gl.queueHint") : t("gl.queueRo", { p: "glossary.manage" })}</p>
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <ul className="gl-queue">
          {rows.map((x) => (
            <QueueRow
              key={x.entry_id}
              row={x}
              manage={manage}
              onOpen={() => onOpen(x.entry_id)}
              onDone={() => {
                setRows((xs) => xs?.filter((y) => y.entry_id !== x.entry_id) ?? xs);
                onChanged();
              }}
            />
          ))}
        </ul>
      ) : (
        <Empty icon="checkCircle" title={t("gl.queueEmpty")} text={t("gl.queueEmptyM")} testId="gl-queue-empty" />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} />
        </div>
      )}
    </section>
  );
}

function QueueRow({ row, manage, onOpen, onDone }: { row: GlossaryRow; manage: boolean; onOpen: () => void; onDone: () => void }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const toast = useToast();
  const [mode, setMode] = useState<"correct" | "reject" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(uuid());
  const decide = async (decision: "approve" | "correct" | "reject", gloss?: { ru: string; uz: string }, note?: string) => {
    setBusy(decision);
    setErr(null);
    try {
      await Glossary.review(row.entry_id, { decision, ...(gloss ? { gloss } : {}), note: note?.trim() || null }, key.current);
      toast(t(`gl.done.${decision}` as MessageKey, { w: row.lemma }), "ok", "glossary.entry_reviewed");
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "NOT_PENDING") {
        toast(t("err.NOT_PENDING"), "info", "409 NOT_PENDING");
        onDone();
        return;
      }
      setErr(errText(i18n, e));
      key.current = uuid();
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="gl-q-row" data-testid={`glq-${row.lemma}`}>
      <div className="gl-q-main">
        <div className="grow">
          <span className="gl-q-head">
            <button type="button" className="tr b" lang="en" onClick={onOpen} data-testid={`glq-open-${row.lemma}`}>
              {row.lemma}
            </button>
            <span className="xs muted mono wrap-any" lang="en">
              {row.forms.join(" · ")}
            </span>
            {row.part_of_speech && <span className="xs muted">{t(`pos.${row.part_of_speech}` as MessageKey)}</span>}
          </span>
          <div className="small gl-q-gloss">
            <span>
              <b className="mono xs">RU</b> <span lang="ru">{row.gloss.ru}</span>
            </span>
            <span>
              <b className="mono xs">UZ</b> <span lang="uz-Latn">{row.gloss.uz}</span>
            </span>
          </div>
          <span className="xs muted">
            {t("gl.refsN", { n: fmt.num(row.refs_count) })} · {fmt.dateTime(row.updated_at)}
          </span>
          <Confidence v={row.confidence} />
        </div>
        {manage && !mode && (
          <div className="acts gl-q-acts">
            <Btn size="sm" kind="primary" icon="check" label={t("gl.approve")} busy={busy === "approve"} onClick={() => void decide("approve")} testId={`glq-approve-${row.lemma}`} />
            <Btn size="sm" icon="edit" label={t("gl.correct")} onClick={() => setMode("correct")} testId={`glq-correct-${row.lemma}`} />
            <Btn size="sm" kind="danger-ghost" icon="ban" label={t("gl.reject")} onClick={() => setMode("reject")} testId={`glq-reject-${row.lemma}`} />
          </div>
        )}
      </div>
      {mode && <DecisionForm mode={mode} row={row} busy={!!busy} onCancel={() => (setMode(null), setErr(null))} onSubmit={(gloss, note) => void decide(mode, gloss, note)} />}
      <FieldErr msg={err} />
    </li>
  );
}

/** «Исправить» (new RU/UZ + note) and «Отклонить» (note) of an AI translation. */
function DecisionForm({ mode, row, busy, onCancel, onSubmit }: { mode: "correct" | "reject"; row: Pick<GlossaryRow, "entry_id" | "gloss" | "lemma">; busy: boolean; onCancel: () => void; onSubmit: (gloss: { ru: string; uz: string } | undefined, note: string) => void }) {
  const { t } = useI18n();
  const text = useIssueText();
  const [ru, setRu] = useState(row.gloss.ru);
  const [uz, setUz] = useState(row.gloss.uz);
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const id = `gld-${row.entry_id.slice(0, 8)}`;
  const issues = mode === "correct" ? glossIssues(ru, uz) : [];
  const noteBad = note.length > GLOSSARY_LIMITS.note;
  const at = (f: FormField) => (tried ? (issues.find((x) => x.field === f) ?? null) : null);
  const submit = () => {
    setTried(true);
    if (issues.length || noteBad) return;
    onSubmit(mode === "correct" ? { ru: ru.trim(), uz: uz.trim() } : undefined, note);
  };
  return (
    <div className="gl-decide" data-testid={`gld-${mode}`}>
      {mode === "correct" && (
        <div className="grid2 tight">
          <div className="field">
            <label htmlFor={`${id}-ru`} className="req">
              {t("gl.glossRu")}
            </label>
            <input id={`${id}-ru`} className={cx("input", at("ru") && "is-invalid")} lang="ru" value={ru} maxLength={GLOSSARY_LIMITS.gloss + 40} aria-invalid={!!at("ru") || undefined} aria-describedby={at("ru") ? `${id}-ru-e` : undefined} onChange={(e) => setRu(e.target.value)} data-autofocus="" data-testid="gld-ru" />
            <FieldErr msg={at("ru") && text(at("ru")!)} id={`${id}-ru-e`} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-uz`} className="req">
              {t("gl.glossUz")}
            </label>
            <input id={`${id}-uz`} className={cx("input", at("uz") && "is-invalid")} lang="uz-Latn" value={uz} maxLength={GLOSSARY_LIMITS.gloss + 40} aria-invalid={!!at("uz") || undefined} aria-describedby={at("uz") ? `${id}-uz-e` : undefined} onChange={(e) => setUz(e.target.value)} data-testid="gld-uz" />
            <FieldErr msg={at("uz") && text(at("uz")!)} id={`${id}-uz-e`} />
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor={`${id}-note`}>{mode === "reject" ? t("gl.rejectNote") : t("gl.note")}</label>
        <textarea id={`${id}-note`} className={cx("textarea", noteBad && "is-invalid")} rows={2} value={note} maxLength={GLOSSARY_LIMITS.note + 50} placeholder={mode === "reject" ? t("gl.rejectNotePh") : t("gl.notePh")} onChange={(e) => setNote(e.target.value)} data-autofocus={mode === "reject" ? "" : undefined} data-testid="gld-note" />
        <span className="hint">{t("gl.noteHint", { n: GLOSSARY_LIMITS.note })}</span>
        <FieldErr msg={noteBad ? t("glf.too_long", { max: GLOSSARY_LIMITS.note }) : null} />
      </div>
      <div className="acts">
        <Btn size="sm" kind={mode === "reject" ? "danger" : "primary"} icon={mode === "reject" ? "ban" : "check"} label={mode === "reject" ? t("gl.rejectOk") : t("gl.correctOk")} busy={busy} onClick={submit} testId="gld-ok" />
        <Btn size="sm" kind="ghost" label={t("common.cancel")} onClick={onCancel} />
      </div>
      <p className="xs muted row">
        <Icon name="audit" /> {t("gl.auditNote")}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- entry form (create and edit) */

function EntryFields({ form, set, issues, pair }: { form: EntryForm; set: (f: EntryForm) => void; issues: FormIssue[]; pair?: ReactNode }) {
  const { t } = useI18n();
  const text = useIssueText();
  const at = (f: FormField) => issues.filter((x) => x.field === f);
  const field = (f: FormField, label: string, input: (common: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string; className: string }) => ReactNode, opts: { req?: boolean; hint?: ReactNode; wide?: boolean } = {}) => {
    const xs = at(f);
    const id = `glf-${f}`;
    return (
      <div className={cx("field", opts.wide && "span-2")} data-field={f}>
        <label htmlFor={id} className={opts.req ? "req" : undefined}>
          {label}
        </label>
        {input({ id, "aria-invalid": xs.length ? true : undefined, "aria-describedby": [xs.length ? `${id}-e` : null, opts.hint ? `${id}-h` : null].filter(Boolean).join(" ") || undefined, className: xs.length ? "is-invalid" : "" })}
        {opts.hint && (
          <span className="hint" id={`${id}-h`}>
            {opts.hint}
          </span>
        )}
        <FieldErr msg={xs.length ? xs.map(text).join("; ") : null} id={`${id}-e`} />
      </div>
    );
  };
  const forms = parseForms(form.forms, form.lemma);
  return (
    <div className="form-grid">
      {pair}
      {field("lemma", t("gl.lemma"), (c) => <input {...c} className={cx("input", c.className)} lang="en" value={form.lemma} maxLength={GLOSSARY_LIMITS.lemma + 20} onChange={(e) => set({ ...form, lemma: e.target.value })} data-autofocus="" data-testid="glf-lemma" />, { req: true })}
      {field(
        "part_of_speech",
        t("gl.pos"),
        (c) => (
          <select {...c} className={cx("select wide", c.className)} value={form.part_of_speech} onChange={(e) => set({ ...form, part_of_speech: e.target.value as PartOfSpeech | "" })} data-testid="glf-pos">
            <option value="">{t("gl.posNone")}</option>
            {PARTS_OF_SPEECH.map((p) => (
              <option key={p} value={p}>
                {t(`pos.${p}` as MessageKey)}
              </option>
            ))}
          </select>
        ),
      )}
      {field(
        "forms",
        t("gl.forms"),
        (c) => <textarea {...c} className={cx("textarea mono", c.className)} lang="en" rows={3} value={form.forms} placeholder={form.lemma || undefined} onChange={(e) => set({ ...form, forms: e.target.value })} data-testid="glf-forms" />,
        { wide: true, hint: <>{t("gl.formsHint", { n: GLOSSARY_LIMITS.forms })} {forms.length > 0 && <span data-testid="glf-forms-norm">{t("gl.formsNorm", { f: forms.join(" · ") })}</span>}</> },
      )}
      {field("ru", t("gl.glossRu"), (c) => <input {...c} className={cx("input", c.className)} lang="ru" value={form.ru} maxLength={GLOSSARY_LIMITS.gloss + 40} onChange={(e) => set({ ...form, ru: e.target.value })} data-testid="glf-ru" />, { req: true, hint: `${form.ru.length}/${GLOSSARY_LIMITS.gloss}` })}
      {field("uz", t("gl.glossUz"), (c) => <input {...c} className={cx("input", c.className)} lang="uz-Latn" value={form.uz} maxLength={GLOSSARY_LIMITS.gloss + 40} onChange={(e) => set({ ...form, uz: e.target.value })} data-testid="glf-uz" />, { req: true, hint: `${form.uz.length}/${GLOSSARY_LIMITS.gloss} · ${t("gl.uzHint")}` })}
      {field("example_en", t("gl.example"), (c) => <input {...c} className={cx("input", c.className)} lang="en" value={form.example_en} maxLength={GLOSSARY_LIMITS.example + 40} onChange={(e) => set({ ...form, example_en: e.target.value })} data-testid="glf-example" />, { wide: true })}
      {field("reason", t("gl.reason"), (c) => <textarea {...c} className={cx("textarea", c.className)} rows={2} value={form.reason} maxLength={GLOSSARY_LIMITS.reason + 50} placeholder={t("gl.reasonPh")} onChange={(e) => set({ ...form, reason: e.target.value })} data-testid="glf-reason" />, { wide: true })}
      {at("pair_id").length > 0 && <FieldErr msg={at("pair_id").map(text).join("; ")} />}
    </div>
  );
}

/** 409 FORM_TAKEN {entry_id, form}: the form is held by another entry — a link to it. */
function FormTaken({ entryId, form, onOpen }: { entryId: string | null; form: string | null; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <Callout kind="warn" icon="alert" testId="gl-form-taken">
      <b>{t("err.FORM_TAKEN")}</b> {form && <span className="mono">«{form}»</span>}{" "}
      {entryId && <Btn size="xs" icon="right" label={t("gl.openHolder")} onClick={() => onOpen(entryId)} testId="gl-open-holder" />}
    </Callout>
  );
}

function NewEntryDrawer({ pair, onClose, onCreated, onOpen }: { pair: string; onClose: () => void; onCreated: (e: GlossaryDetail) => void; onOpen: (id: string) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const [form, setForm] = useState<EntryForm>(emptyForm);
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<FormIssue[]>([]);
  const [taken, setTaken] = useState<{ id: string | null; form: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(uuid());
  const local = checkEntry(form);
  const issues = [...(tried ? local : []), ...server];
  const save = async () => {
    setTried(true);
    setServer([]);
    setTaken(null);
    setErr(null);
    if (local.length) return;
    setBusy(true);
    try {
      const e = await Glossary.create(createBody(pair, form), key.current);
      toast(t("gl.created", { w: e.lemma }), "ok", "glossary.entry_created");
      onCreated(e);
    } catch (e) {
      key.current = uuid();
      if (e instanceof ApiError && e.code === "FORM_TAKEN") setTaken({ id: e.str("entry_id"), form: e.str("form") });
      else if (e instanceof ApiError && e.code === "GLOSSARY_INVALID") setServer(serverIssues(e.details.errors));
      else setErr(errText(i18n, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      wide
      title={t("gl.newT")}
      sub={<span className="mono">{pair}</span>}
      onClose={onClose}
      testId="gl-new-drawer"
      footer={
        <>
          <Btn kind="ghost" label={t("common.cancel")} onClick={onClose} />
          <Btn kind="primary" icon="check" label={t("gl.create")} busy={busy} onClick={() => void save()} testId="gl-create" />
        </>
      }
    >
      <div className="stack">
        <p className="small muted">{t("gl.newM")}</p>
        <EntryFields form={form} set={setForm} issues={issues} />
        {taken && <FormTaken entryId={taken.id} form={taken.form} onOpen={onOpen} />}
        <FieldErr msg={err} />
        <p className="xs muted row">
          <Icon name="audit" /> {t("gl.auditNote")}
        </p>
      </div>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- entry card */

type Mode = "view" | "edit" | "override" | "correct" | "reject";

function EntryDrawer({ id, onClose, onChanged, onOpen }: { id: string; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { can } = useSession();
  const { navigate } = useNav();
  const toast = useToast();
  const [e, setE] = useState<GlossaryDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [ask, setAsk] = useState<"archive" | "unoverride" | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const reviewKey = useRef(uuid());
  const load = useCallback(async () => {
    try {
      setE(await Glossary.get(id));
      setError(null);
    } catch (x) {
      setError(x);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const acts = e ? entryActions(e, can("glossary.manage")) : null;
  const done = (x: GlossaryDetail, msg: MessageKey, audit: string) => {
    setE(x);
    setMode("view");
    setConflict(false);
    toast(t(msg, { w: x.lemma }), "ok", audit);
    onChanged();
  };
  /** 409 VERSION_CONFLICT / 428 IF_MATCH_REQUIRED: someone saved the entry in between — read it again */
  const onSaveError = (x: unknown): string | null => {
    if (x instanceof ApiError && (x.code === "VERSION_CONFLICT" || x.code === "IF_MATCH_REQUIRED")) {
      setConflict(true);
      return null;
    }
    return errText(i18n, x);
  };
  const reread = async () => {
    await load();
    setConflict(false);
  };
  const review = async (decision: "approve" | "correct" | "reject", gloss?: { ru: string; uz: string }, note?: string) => {
    if (!e) return;
    setBusy(true);
    try {
      const x = await Glossary.review(e.entry_id, { decision, ...(gloss ? { gloss } : {}), note: note?.trim() || null }, reviewKey.current);
      reviewKey.current = uuid();
      done(x, `gl.done.${decision}` as MessageKey, "glossary.entry_reviewed");
    } catch (x) {
      reviewKey.current = uuid();
      toast(errText(i18n, x), "err", x instanceof ApiError ? `${x.status} ${x.code}` : undefined);
      if (x instanceof ApiError && x.code === "NOT_PENDING") await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      wide
      testId="gl-entry"
      onClose={onClose}
      title={e ? <span lang="en">{e.lemma}</span> : t("gl.entry")}
      sub={
        e && (
          <>
            <SourcePill source={e.source} overridden={!!e.override} />
            <Pill tone={GST_TONE[e.review_status]}>{t(`glst.${e.review_status}` as MessageKey)}</Pill>
            {e.corrected && <Pill tone="accent" dot={false}>{t("gl.corrected")}</Pill>}
            {e.archived_at && <Pill tone="neutral">{t("gl.archivedAt", { t: fmt.dateTime(e.archived_at) })}</Pill>}
            <span className="mono">{e.pair_id}</span>
          </>
        )
      }
    >
      {error && !e ? (
        error instanceof ApiError && error.status === 404 ? (
          <Empty icon="layers" title={t("err.GLOSSARY_ENTRY_NOT_FOUND")} />
        ) : (
          <LoadError error={error} onRetry={() => void load()} />
        )
      ) : !e ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="stack" data-testid="gl-entry-body" data-updated={e.updated_at}>
          {conflict && (
            <Reveal dep={conflict}>
              <Callout kind="warn" icon="alert" testId="gl-conflict">
                <b>{t("gl.conflict")}</b> <Btn size="xs" icon="refresh" label={t("gl.reread")} onClick={() => void reread()} testId="gl-reread" />
              </Callout>
            </Reveal>
          )}
          {mode === "view" && acts && Object.values(acts).some(Boolean) && (
            <div className="acts" data-testid="gl-actions">
              {acts.review && (
                <>
                  <Btn kind="primary" icon="check" label={t("gl.approve")} busy={busy} onClick={() => void review("approve")} testId="gl-approve" />
                  <Btn icon="edit" label={t("gl.correct")} onClick={() => setMode("correct")} testId="gl-correct" />
                  <Btn kind="danger-ghost" icon="ban" label={t("gl.reject")} onClick={() => setMode("reject")} testId="gl-reject" />
                </>
              )}
              {acts.edit && <Btn icon="edit" label={t("common.edit")} onClick={() => setMode("edit")} testId="gl-edit" />}
              {acts.override && <Btn icon="edit" label={e.override ? t("gl.overrideEdit") : t("gl.override")} onClick={() => setMode("override")} testId="gl-override" />}
              {acts.unoverride && <Btn kind="ghost" icon="rollback" label={t("gl.unoverride")} onClick={() => setAsk("unoverride")} testId="gl-unoverride" />}
              {acts.archive && <Btn kind="danger-ghost" icon="power" label={t("gl.archive")} onClick={() => setAsk("archive")} testId="gl-archive" />}
            </div>
          )}
          {mode === "view" && !can("glossary.manage") && (
            <p className="xs muted row" data-testid="gl-ro">
              <Icon name="lock" /> {t("perm.need", { p: "glossary.manage" })}
            </p>
          )}
          {(mode === "correct" || mode === "reject") && <DecisionForm mode={mode} row={e} busy={busy} onCancel={() => setMode("view")} onSubmit={(g, n) => void review(mode, g, n)} />}
          {mode === "edit" && <EditForm key={e.updated_at} e={e} onCancel={() => setMode("view")} onSaved={(x) => done(x, "gl.saved", "glossary.entry_updated")} onError={onSaveError} onOpen={onOpen} />}
          {mode === "override" && <OverrideForm key={e.updated_at} e={e} onCancel={() => setMode("view")} onSaved={(x) => done(x, "gl.overrideSaved", "glossary.entry_updated")} onError={onSaveError} />}

          <section aria-labelledby="gl-e-h" data-testid="gl-entry-main">
            <h3 className="h3" id="gl-e-h">
              {t("gl.entry")}
            </h3>
            <dl className="dl">
              <dt>{t("gl.forms")}</dt>
              <dd>
                <span className="row">
                  {e.forms.map((f) => (
                    <span key={f} className="chip-ref" lang="en">
                      {f}
                    </span>
                  ))}
                </span>
              </dd>
              <dt>{t("gl.pos")}</dt>
              <dd>{e.part_of_speech ? t(`pos.${e.part_of_speech}` as MessageKey) : "—"}</dd>
              <dt>{t("gl.glossRu")}</dt>
              <dd lang="ru" data-testid="gl-e-ru">
                {e.gloss.ru}
              </dd>
              <dt>{t("gl.glossUz")}</dt>
              <dd lang="uz-Latn" data-testid="gl-e-uz">
                {e.gloss.uz}
              </dd>
              <dt>{t("gl.example")}</dt>
              <dd lang="en">{e.example_en ?? "—"}</dd>
              <dt>{t("gl.source")}</dt>
              <dd>
                {t(`gls.${e.source}.long` as MessageKey)}
                {e.source === "ai" && (
                  <>
                    <Confidence v={e.confidence} />
                    {e.agent_version && <span className="xs muted mono block">{e.agent_version}</span>}
                  </>
                )}
              </dd>
              {e.override && (
                <>
                  <dt>{t("gl.overrideBy")}</dt>
                  <dd data-testid="gl-e-override">{t("gl.overrideAt", { t: fmt.dateTime(e.override.at) })}</dd>
                </>
              )}
              <dt>{t("common.updated")}</dt>
              <dd>
                {fmt.dateTime(e.updated_at)} · {e.updated_by_name ?? (e.updated_by ? "—" : t("gl.system"))}
              </dd>
            </dl>
          </section>

          <section aria-labelledby="gl-refs-h" data-testid="gl-refs">
            <h3 className="h3" id="gl-refs-h">
              {t("gl.refs", { n: e.refs_titles.length })}
            </h3>
            {e.refs_titles.length ? (
              <ul className="rel-list">
                {e.refs_titles.map((r) => (
                  <li key={`${r.kind}/${r.key}/${r.version}`}>
                    <span className="tag plain">{t(`kind.${r.kind}` as MessageKey)}</span>
                    <button type="button" className="tr" onClick={() => navigate("content", refRoute(r))} data-testid={`gl-ref-${r.key}`}>
                      {r.title?.ru ?? r.key}
                    </button>
                    <span className="mono xs muted">
                      {r.key} · v{r.version}
                    </span>
                    {!r.title && <Pill tone="neutral">{t("gl.refOff")}</Pill>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">{e.source === "methodist" ? t("gl.noRefsMethodist") : t("gl.noRefs")}</p>
            )}
          </section>

          {e.conflicts.length > 0 && (
            <section aria-labelledby="gl-cf-h" data-testid="gl-conflicts">
              <h3 className="h3" id="gl-cf-h">
                <Icon name="alert" /> {t("gl.conflicts", { n: e.conflicts.length })}
              </h3>
              <p className="xs muted">{t("gl.conflictsHint")}</p>
              <ul className="rel-list">
                {e.conflicts.map((c) => (
                  <li key={`${c.ref.kind}/${c.ref.key}/${c.ref.version}`}>
                    <span className="tag plain">{t(`kind.${c.ref.kind}` as MessageKey)}</span>
                    <span className="mono xs">
                      {c.ref.key} · v{c.ref.version}
                    </span>
                    <span lang="ru">{c.gloss.ru}</span>
                    <span className="muted" lang="uz-Latn">
                      {c.gloss.uz}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="gl-h-h" data-testid="gl-history">
            <h3 className="h3" id="gl-h-h">
              {t("gl.history", { n: e.history.length })}
            </h3>
            {e.history.length ? (
              <div className="table-wrap">
                <table className="tbl compact">
                  <caption className="sr-only">{t("gl.history", { n: e.history.length })}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("gl.col.when")}</th>
                      <th scope="col">{t("gl.col.who")}</th>
                      <th scope="col">{t("gl.col.action")}</th>
                      <th scope="col">{t("gl.col.change")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.history.map((h, n) => (
                      <tr key={n} data-testid={`gl-h-${n}`}>
                        <td className="small nowrap">{fmt.dateTime(h.at)}</td>
                        <td className="small">{h.by_name ?? (h.by ? "—" : t("gl.system"))}</td>
                        <td className="small">{t(`gla.${h.action}` as MessageKey)}</td>
                        <td className="small">
                          <ul className="plain-list gl-h-ch">
                            {historyChanges(h.before, h.after)
                              .slice(0, 8)
                              .map((c) => (
                                <li key={c.field}>
                                  <span className="mono xs">{c.field}</span>: <span className="muted">{c.before}</span> → <b>{c.after}</b>
                                </li>
                              ))}
                          </ul>
                          {h.reason && <span className="xs muted block wrap-any">{t("gl.reasonX", { r: h.reason })}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="small muted">—</p>
            )}
          </section>
        </div>
      )}
      {ask && e && (
        <ConfirmCommand
          title={ask === "archive" ? t("gl.archiveT", { w: e.lemma }) : t("gl.unoverrideT", { w: e.lemma })}
          text={ask === "archive" ? t("gl.archiveM") : t("gl.unoverrideM")}
          icon={ask === "archive" ? "power" : "rollback"}
          tone={ask === "archive" ? "bad" : "warn"}
          ok={ask === "archive" ? t("gl.archive") : t("gl.unoverride")}
          okKind={ask === "archive" ? "danger" : "primary"}
          minReason={3}
          testId="gl-confirm"
          onClose={() => setAsk(null)}
          onConfirm={async (reason) => {
            try {
              if (ask === "archive") {
                await Glossary.archive(e.entry_id, reason);
                toast(t("gl.archived", { w: e.lemma }), "ok", "glossary.entry_archived");
                onChanged();
                onClose();
              } else {
                const x = await Glossary.patch(e.entry_id, { override: null, reason }, e.updated_at);
                done(x, "gl.unoverridden", "glossary.entry_updated");
              }
              return null;
            } catch (x) {
              const m = onSaveError(x);
              return m ?? t("gl.conflict");
            }
          }}
        />
      )}
    </Drawer>
  );
}

function EditForm({ e, onCancel, onSaved, onError, onOpen }: { e: GlossaryDetail; onCancel: () => void; onSaved: (x: GlossaryDetail) => void; onError: (x: unknown) => string | null; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<EntryForm>(() => formOf(e));
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<FormIssue[]>([]);
  const [taken, setTaken] = useState<{ id: string | null; form: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const local = checkEntry(form);
  const body = useMemo(() => patchBody(e, form), [e, form]);
  const save = async () => {
    setTried(true);
    setServer([]);
    setTaken(null);
    setErr(null);
    if (local.length || !body) return;
    setBusy(true);
    try {
      onSaved(await Glossary.patch(e.entry_id, body, e.updated_at));
    } catch (x) {
      if (x instanceof ApiError && x.code === "FORM_TAKEN") setTaken({ id: x.str("entry_id"), form: x.str("form") });
      else if (x instanceof ApiError && x.code === "GLOSSARY_INVALID") setServer(serverIssues(x.details.errors));
      else setErr(onError(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="gl-form" aria-labelledby="gl-edit-h" data-testid="gl-edit-form">
      <h3 className="h3" id="gl-edit-h">
        {t("gl.editT")}
      </h3>
      <EntryFields form={form} set={setForm} issues={[...(tried ? local : []), ...server]} />
      {taken && <FormTaken entryId={taken.id} form={taken.form} onOpen={onOpen} />}
      <FieldErr msg={err} />
      <div className="acts">
        <Btn kind="primary" icon="check" label={t("common.save")} busy={busy} disabled={!body} onClick={() => void save()} testId="gl-save" />
        <Btn kind="ghost" label={t("common.cancel")} onClick={onCancel} />
        {!body && <span className="xs muted">{t("gl.noChanges")}</span>}
      </div>
    </section>
  );
}

/** Override of a course entry: translation and example over the content (the content itself changes by a version). */
function OverrideForm({ e, onCancel, onSaved, onError }: { e: GlossaryDetail; onCancel: () => void; onSaved: (x: GlossaryDetail) => void; onError: (x: unknown) => string | null }) {
  const { t } = useI18n();
  const text = useIssueText();
  const [ru, setRu] = useState(e.override?.gloss.ru ?? e.gloss.ru);
  const [uz, setUz] = useState(e.override?.gloss.uz ?? e.gloss.uz);
  const [ex, setEx] = useState(e.override ? (e.override.example_en ?? "") : (e.example_en ?? ""));
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<FormIssue[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const local = [...glossIssues(ru, uz), ...(ex.length > GLOSSARY_LIMITS.example ? [{ field: "example_en" as const, code: "too_long" as const }] : [])];
  const issues = [...(tried ? local : []), ...server];
  const at = (f: FormField) => issues.filter((x) => x.field === f);
  const save = async () => {
    setTried(true);
    setServer([]);
    setErr(null);
    if (local.length) return;
    setBusy(true);
    try {
      onSaved(await Glossary.patch(e.entry_id, { override: { gloss: { ru: ru.trim(), uz: uz.trim() }, example_en: ex.trim() || null }, reason: reason.trim() || null }, e.updated_at));
    } catch (x) {
      if (x instanceof ApiError && x.code === "GLOSSARY_INVALID") setServer(serverIssues(x.details.errors));
      else setErr(onError(x));
    } finally {
      setBusy(false);
    }
  };
  const row = (f: FormField, id: string, label: string, el: ReactNode, req = false) => (
    <div className="field">
      <label htmlFor={id} className={req ? "req" : undefined}>
        {label}
      </label>
      {el}
      <FieldErr msg={at(f).length ? at(f).map(text).join("; ") : null} id={`${id}-e`} />
    </div>
  );
  return (
    <section className="gl-form" aria-labelledby="gl-ov-h" data-testid="gl-override-form">
      <h3 className="h3" id="gl-ov-h">
        {t("gl.overrideT")}
      </h3>
      <p className="xs muted">{t("gl.overrideHint")}</p>
      <div className="grid2 tight">
        {row("ru", "glo-ru", t("gl.glossRu"), <input id="glo-ru" className={cx("input", at("ru").length > 0 && "is-invalid")} lang="ru" value={ru} aria-invalid={at("ru").length ? true : undefined} aria-describedby={at("ru").length ? "glo-ru-e" : undefined} onChange={(x) => setRu(x.target.value)} data-autofocus="" data-testid="glo-ru" />, true)}
        {row("uz", "glo-uz", t("gl.glossUz"), <input id="glo-uz" className={cx("input", at("uz").length > 0 && "is-invalid")} lang="uz-Latn" value={uz} aria-invalid={at("uz").length ? true : undefined} aria-describedby={at("uz").length ? "glo-uz-e" : undefined} onChange={(x) => setUz(x.target.value)} data-testid="glo-uz" />, true)}
      </div>
      {row("example_en", "glo-ex", t("gl.example"), <input id="glo-ex" className={cx("input", at("example_en").length > 0 && "is-invalid")} lang="en" value={ex} onChange={(x) => setEx(x.target.value)} data-testid="glo-ex" />)}
      {row("reason", "glo-reason", t("gl.reason"), <textarea id="glo-reason" className="textarea" rows={2} value={reason} maxLength={GLOSSARY_LIMITS.reason} placeholder={t("gl.reasonPh")} onChange={(x) => setReason(x.target.value)} data-testid="glo-reason" />)}
      <FieldErr msg={err} />
      <div className="acts">
        <Btn kind="primary" icon="check" label={t("gl.overrideSave")} busy={busy} onClick={() => void save()} testId="glo-save" />
        <Btn kind="ghost" label={t("common.cancel")} onClick={onCancel} />
      </div>
    </section>
  );
}
