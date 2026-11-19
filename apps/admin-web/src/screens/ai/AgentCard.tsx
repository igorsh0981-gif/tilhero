/**
 * Card of an LLM agent (ADM-AGENT-02…04, UC-ADM-02, AT-49): the rollout (published version, canary, previous version),
 * the versions with authors and publication, the draft editor (ai.manage: instructions and rules with character
 * counters, the output JSON Schema with a JSON check, model and fallback from the models list, temperature, max
 * tokens, timeout, price of a call; If-Match → 409 VERSION_CONFLICT → «reload»), the line diff against the published
 * version, the golden cases, «Запустить тесты» → progress by polling → results per case, «Опубликовать» (ai.publish,
 * step-up; closed without a fresh green run of this version — the reason and a link to the results; 422
 * TESTS_REQUIRED / TESTS_FAILED are explained), the canary (version + 1…50 %) and its removal, the rollback with a
 * reason. A published or archived version is immutable — shown read-only. The ai-gateway re-checks every command.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AiModel, GoldenCase, TestRun } from "@tilhero/contracts/admin";
import type { AgentId } from "@tilhero/contracts/ai";
import { Ai, type AgentCardView, type AgentVersionView } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, FieldErr, Pill, Reveal, Select, Spinner, TabPanel, Tabs, type Tone } from "../../ui/kit";
import { ConfirmCommand, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { GoldenTab } from "./Golden";
import { checkForm, formOf, LIMITS, patchOf, prettyJson, publishGate, RUN_FRESH_DAYS, sameForm, type FormField, type FormIssue, type VersionForm } from "./model";
import { CharCount, DiffView, Progress, useUsd } from "./parts";

export const VST_TONE: Record<AgentVersionView["status"], Tone> = { draft: "warn", published: "good", archived: "neutral" };
type CardTab = "version" | "diff" | "history" | "cases";
type Cmd = { kind: "publish"; key: string } | { kind: "canary" } | { kind: "clearCanary" } | { kind: "rollback" } | { kind: "delete" };

export function AgentCard({ id }: { id: AgentId }) {
  const i = useI18n();
  const { t, fmt, lang } = i;
  const { can } = useSession();
  const { navigate } = useNav();
  const toast = useToast();
  const money = useUsd();
  const [card, setCard] = useState<AgentCardView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [models, setModels] = useState<AiModel[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [ver, setVer] = useState<AgentVersionView | null>(null);
  const [verErr, setVerErr] = useState<unknown>(null);
  const [pub, setPub] = useState<AgentVersionView | null>(null);
  const [form, setForm] = useState<VersionForm | null>(null);
  const [base, setBase] = useState<VersionForm | null>(null);
  const [tried, setTried] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [run, setRun] = useState<TestRun | null>(null);
  const [cases, setCases] = useState<GoldenCase[] | null>(null);
  const [tab, setTab] = useState<CardTab>("version");
  const [cmd, setCmd] = useState<Cmd | null>(null);
  const [openCase, setOpenCase] = useState<string | null>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const draftKey = useRef(uuid());
  const runKey = useRef(uuid());
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  // StrictMode mounts twice: the flag is raised again on every mount
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (poll.current) clearTimeout(poll.current);
    };
  }, []);

  const loadCard = useCallback(async () => {
    try {
      const c = await Ai.agent(id);
      if (!alive.current) return null;
      setCard(c);
      setError(null);
      return c;
    } catch (e) {
      if (alive.current) setError(e);
      return null;
    }
  }, [id]);

  const loadCases = useCallback(() => {
    Ai.cases(id)
      .then((r) => alive.current && setCases(r.items))
      .catch(() => alive.current && setCases((x) => x ?? []));
  }, [id]);

  useEffect(() => {
    void loadCard().then((c) => {
      if (!c) return;
      setSel(c.draft_version ?? c.published?.version ?? c.versions[0]?.version ?? null);
    });
    Ai.models()
      .then((r) => alive.current && setModels(r.items))
      .catch(() => undefined);
    loadCases();
  }, [loadCard, loadCases]);

  /* ------------------------------------------------------------ test run polling */
  const follow = useCallback(
    (v: number, runId: string) => {
      if (poll.current) clearTimeout(poll.current);
      const tick = async () => {
        try {
          const r = await Ai.testRun(id, v, runId);
          if (!alive.current) return;
          setRun(r);
          setVer((x) => (x && x.version === v ? { ...x, last_test_run: summaryOf(r) } : x));
          if (r.status === "running") poll.current = setTimeout(() => void tick(), 1000);
          else {
            void loadCard();
            toast(r.passed_mandatory ? t("tr.doneOk", { p: r.passed, n: r.passed + r.failed }) : t("tr.doneBad", { f: r.failed }), r.passed_mandatory ? "ok" : "info", "ai.test_run");
          }
        } catch {
          if (alive.current) poll.current = setTimeout(() => void tick(), 3000);
        }
      };
      poll.current = setTimeout(() => void tick(), 700);
    },
    [id, loadCard, t, toast],
  );

  /* ------------------------------------------------------------ version */
  const openVersion = useCallback(
    async (v: number) => {
      if (poll.current) clearTimeout(poll.current);
      setVerErr(null);
      setRun(null);
      setConflict(false);
      setTried(false);
      setFormErr(null);
      try {
        const x = await Ai.version(id, v);
        if (!alive.current) return;
        setVer(x);
        const f = formOf(x);
        setForm(f);
        setBase(f);
        const r = x.last_test_run;
        if (r && r.version === x.version) {
          Ai.testRun(id, x.version, r.run_id)
            .then((full) => {
              if (!alive.current) return;
              setRun(full);
              if (full.status === "running") follow(x.version, full.run_id);
            })
            .catch(() => undefined);
        }
      } catch (e) {
        if (alive.current) setVerErr(e);
      }
    },
    [id, follow],
  );
  // only a new choice of version reloads it: a language switch (new t) must not drop unsaved edits
  const openRef = useRef(openVersion);
  openRef.current = openVersion;
  useEffect(() => {
    if (sel != null) void openRef.current(sel);
  }, [sel, id]);

  // the published version for the diff
  const pubV = card?.published?.version ?? null;
  useEffect(() => {
    if (pubV == null) {
      setPub(null);
      return;
    }
    if (ver && ver.version === pubV) {
      setPub(ver);
      return;
    }
    Ai.version(id, pubV)
      .then((x) => alive.current && setPub(x))
      .catch(() => undefined);
  }, [id, pubV, ver]);

  // a version on the canary is frozen (409 VERSION_IN_CANARY): stop the canary to edit or delete it
  const editable = !!ver && ver.status === "draft" && !ver.canary && can("ai.manage");
  const dirty = !!form && !!base && !sameForm(form, base);
  const activeModels = useMemo(() => models.filter((m) => m.active).map((m) => m.model_id), [models]);
  const checked = useMemo(() => (form ? checkForm(form, activeModels) : { issues: [], schema: null }), [form, activeModels]);
  // before the first «Save» only over-long texts and a changed schema are flagged (no red form on opening a draft)
  const issuesOf = (f: FormField) => checked.issues.filter((x) => x.field === f && (tried || x.code === "too_long" || (f === "schemaText" && form?.schemaText !== base?.schemaText)));
  const activeCases = (cases ?? []).filter((c) => !c.archived_at);

  const set = (k: FormField, v: string) => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    setFormErr(null);
  };

  const failed = (e: unknown): string => {
    if ((e as ApiError)?.cancelled) return t("stepup.cancelled");
    if (e instanceof ApiError) {
      if (e.code === "VERSION_CONFLICT") setConflict(true);
      // prod/stage publish only by a run on the real provider (anthropic), not on fake
      if (e.code === "TESTS_REQUIRED" && e.str("reason") === "real_provider_required") return t("err.TESTS_REQUIRED.real_provider_required");
      if (e.code === "TESTS_FAILED") {
        const ids = Array.isArray(e.details.case_ids) ? (e.details.case_ids as string[]) : [];
        const names = ids.map((cid) => activeCases.find((c) => c.case_id === cid)?.title ?? cid);
        return t("err.TESTS_FAILED.list", { n: names.length, list: names.join(", ") });
      }
    }
    return errText(i, e);
  };

  const save = async () => {
    if (!ver || !form || busy) return;
    setTried(true);
    if (checked.issues.length || !checked.schema) {
      setFormErr(t("ag.fixErrors", { n: checked.issues.length }));
      const first = checked.issues[0];
      if (first) setTimeout(() => document.getElementById(fieldDom(first.field))?.focus(), 30);
      return;
    }
    const patch = patchOf(form, ver, checked.schema);
    if (!Object.keys(patch).length) {
      setBase(form);
      return;
    }
    setBusy("save");
    setFormErr(null);
    try {
      const x = await Ai.saveDraft(id, ver.version, patch, ver.updated_at);
      setVer(x);
      const f = formOf(x);
      setForm(f);
      setBase(f);
      setTried(false);
      setRun(null);
      toast(t("ag.saved", { v: x.version }), "ok", "ai.version_updated");
      void loadCard();
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_NOT_DRAFT") {
        toast(errText(i, e), "err", "409 VERSION_NOT_DRAFT");
        void openVersion(ver.version);
        void loadCard();
      } else setFormErr(failed(e));
    } finally {
      setBusy(null);
    }
  };

  const newDraft = async () => {
    if (!card || busy) return;
    setBusy("draft");
    try {
      const x = await Ai.newDraft(id, card.published?.version ?? null, draftKey.current);
      draftKey.current = uuid();
      toast(t("ag.draftCreated", { v: x.version }), "ok", "ai.version_created");
      await loadCard();
      setTab("version");
      setSel(x.version);
      if (sel === x.version) void openVersion(x.version);
    } catch (e) {
      if (e instanceof ApiError && e.code === "DRAFT_EXISTS") {
        const v = e.num("version") ?? card.draft_version;
        toast(t("ag.draftExists", { v: v ?? "?" }), "info", "409 DRAFT_EXISTS");
        if (v != null) setSel(v);
      } else toast(errText(i, e), "err");
    } finally {
      setBusy(null);
    }
  };

  const runTests = async () => {
    if (!ver || busy) return;
    if (dirty) {
      setFormErr(t("ag.gate.unsaved"));
      return;
    }
    setBusy("run");
    try {
      const s = await Ai.runTests(id, ver.version, runKey.current);
      runKey.current = uuid();
      setVer((x) => (x ? { ...x, last_test_run: s } : x));
      setRun({ ...s, results: [] });
      follow(ver.version, s.run_id);
      setTimeout(() => resultsRef.current?.scrollIntoView?.({ block: "nearest" }), 50);
    } catch (e) {
      setFormErr(failed(e));
    } finally {
      setBusy(null);
    }
  };

  if (error && !card) return <LoadError error={error} onRetry={() => void loadCard()} />;
  if (!card) return <Spinner label={t("common.loading")} />;

  const ro = card.rollout;
  const gate = ver ? publishGate(ver, dirty) : "no_run";
  const candidates = card.versions.filter((v) => v.status === "draft" && v.last_test_run?.status === "finished" && v.last_test_run.passed_mandatory && v.version !== ro?.published_version);

  return (
    <div className="stack" data-testid="ag-card" data-agent={id}>
      <div className="row">
        <Btn size="sm" kind="ghost" icon="chevL" label={t("ag.back")} onClick={() => navigate("agents")} testId="ag-back" />
      </div>
      <section className="card ag-head" aria-labelledby="ag-h">
        <div className="ws-h">
          <div className="grow">
            <div className="crumb">
              {t("aimpl.llm")} · <span className="mono">{card.agent_id}</span>
            </div>
            <h2 className={cx("h2", lang === "en" && "mono")} id="ag-h">
              {lang === "en" ? card.agent_id : card.title.ru || card.agent_id}
            </h2>
            {lang === "en" && (
              <p className="small" lang="ru">
                {card.title.ru}
              </p>
            )}
            <p className="small muted" lang="ru">
              {card.purpose.ru}
            </p>
          </div>
          <div className="ws-pills">
            {card.free_text ? <Pill tone="warn">{t("ag.freeTextKids")}</Pill> : <Pill tone="neutral">{t("ag.noFreeText")}</Pill>}
            <Pill tone="neutral" dot={false}>
              {t("ag.owner", { r: card.owner_role })}
            </Pill>
          </div>
        </div>
        <div className="ag-roll" data-testid="ag-rollout">
          <div className="ag-roll-c">
            <span className="xs muted">{t("ag.r.published")}</span>
            {card.published ? (
              <b data-testid="ag-pub">
                v{card.published.version} · <span className="mono">{card.published.model_id}</span>
              </b>
            ) : (
              <b>{t("ag.noPublished")}</b>
            )}
            {card.published && (
              <span className="xs muted">
                {fmt.dateTime(card.published.published_at)}
                {card.published.published_by_name ? ` · ${card.published.published_by_name}` : ""}
              </span>
            )}
          </div>
          <div className="ag-roll-c">
            <span className="xs muted">{t("ag.r.canary")}</span>
            {ro?.canary_version != null ? (
              <b data-testid="ag-canary">{t("ag.canaryOn", { v: ro.canary_version, p: ro.canary_percent })}</b>
            ) : (
              <b data-testid="ag-canary-none">{t("ag.canaryOff")}</b>
            )}
          </div>
          <div className="ag-roll-c">
            <span className="xs muted">{t("ag.r.previous")}</span>
            <b>{ro?.previous_version != null ? `v${ro.previous_version}` : "—"}</b>
          </div>
          <div className="ag-roll-c">
            <span className="xs muted">{t("ag.r.calls")}</span>
            <b>
              {fmt.num(card.calls_7d)}
              {card.unavailable_pct_7d != null && <span className="muted"> · {t("ag.unavailPct", { p: fmt.pct(card.unavailable_pct_7d) })}</span>}
            </b>
          </div>
        </div>
        <div className="acts ws-acts" data-testid="ag-actions">
          {can("ai.manage") && card.draft_version == null && <Btn icon="copy" label={t("ag.newDraft", { v: card.published?.version ?? "—" })} busy={busy === "draft"} onClick={() => void newDraft()} testId="ag-new-draft" />}
          {can("ai.publish") && (
            <>
              <Btn icon="flask" label={t("ag.canary")} disabled={!candidates.length} title={!candidates.length ? t("ag.canaryNoCand") : undefined} onClick={() => setCmd({ kind: "canary" })} testId="ag-canary-btn" />
              {ro?.canary_version != null && <Btn kind="danger-ghost" icon="x" label={t("ag.canaryClear")} onClick={() => setCmd({ kind: "clearCanary" })} testId="ag-canary-clear" />}
              <Btn kind="danger-ghost" icon="rollback" label={ro?.previous_version != null ? t("ag.rollbackTo", { v: ro.previous_version }) : t("ag.rollback")} disabled={ro?.previous_version == null} title={ro?.previous_version == null ? t("err.NO_PREVIOUS_VERSION") : undefined} onClick={() => setCmd({ kind: "rollback" })} testId="ag-rollback" />
            </>
          )}
        </div>
        {(!can("ai.manage") || !can("ai.publish")) && (
          <p className="xs muted row ws-notes" data-testid="ag-ro-note">
            <Icon name="lock" /> {!can("ai.manage") && <span>{t("ag.noManage")}</span>}
            {!can("ai.publish") && <span>{t("ag.noPublish")}</span>}
          </p>
        )}
      </section>

      <Tabs<CardTab>
        id="agc"
        label={t("ag.cardTabs")}
        value={tab}
        onChange={setTab}
        items={[
          { v: "version", label: ver ? t("ag.tab.versionN", { v: ver.version }) : t("ag.tab.version"), icon: "edit", testId: "agc-tab-version" },
          { v: "diff", label: t("ag.tab.diff"), icon: "diff", testId: "agc-tab-diff" },
          { v: "history", label: t("ag.tab.history"), icon: "clock", cnt: card.versions.length, testId: "agc-tab-history" },
          { v: "cases", label: t("ag.tab.cases"), icon: "clipboardCheck", cnt: cases ? activeCases.length : null, testId: "agc-tab-cases" },
        ]}
      />
      <TabPanel id="agc" value={tab}>
        {tab === "version" &&
          (verErr && !ver ? (
            <LoadError error={verErr} onRetry={() => sel != null && void openVersion(sel)} />
          ) : !ver || !form ? (
            <Spinner label={t("common.loading")} />
          ) : (
            <section className="card ws" aria-labelledby="agv-h" data-testid="ag-version" data-status={ver.status} data-version={ver.version}>
              <div className="ws-h">
                <div className="grow">
                  <h3 className="h3" id="agv-h">
                    {t("ag.versionT", { v: ver.version })}
                  </h3>
                  <span className="small muted">
                    {t("ag.authorX", { n: ver.author_name ?? "—", t: fmt.dateTime(ver.created_at) })}
                    {ver.published_at && ` · ${t("ag.publishedX", { n: ver.published_by_name ?? "—", t: fmt.dateTime(ver.published_at) })}`}
                  </span>
                </div>
                <div className="ws-pills">
                  <Select<string>
                    id="agv-sel"
                    label={t("ag.pickVersion")}
                    value={String(ver.version)}
                    onChange={(v) => setSel(Number(v))}
                    options={card.versions.map((v) => ({ v: String(v.version), label: `v${v.version} · ${t(`avs.${v.status}`)}${v.canary ? ` · ${t("ag.canaryShort")}` : ""}` }))}
                    testId="agv-select"
                  />
                  <Pill tone={VST_TONE[ver.status]} testId="agv-status">
                    v{ver.version} · {t(`avs.${ver.status}`)}
                  </Pill>
                  {dirty && <Pill tone="info">{t("ct.unsaved")}</Pill>}
                </div>
              </div>
              {conflict && (
                <Reveal dep={conflict}>
                  <Callout kind="warn" icon="alert" testId="agv-conflict">
                    <b>{t("ag.conflict")}</b> {t("ag.conflictM")}{" "}
                    <Btn size="xs" icon="refresh" label={t("ct.reload")} onClick={() => void openVersion(ver.version)} testId="agv-reload" />
                  </Callout>
                </Reveal>
              )}
              {!editable && (
                <Callout icon="lock" testId="agv-readonly">
                  {ver.status === "draft" ? (ver.canary ? t("ag.roCanary") : t("ag.roNoManage")) : t(`ag.ro.${ver.status}` as MessageKey)}
                </Callout>
              )}
              {versionActions()}
              <FieldErr msg={formErr} />
              <VersionFields form={form} set={set} editable={editable} issuesOf={issuesOf} models={models} />
              {runPanel()}
            </section>
          ))}
        {tab === "diff" && <DiffTab card={card} ver={ver} form={form} dirty={dirty} pub={pub} />}
        {tab === "history" && (
          <HistoryTab
            card={card}
            current={ver?.version ?? null}
            onOpen={(v) => {
              setSel(v);
              setTab("version");
            }}
          />
        )}
        {tab === "cases" && <GoldenTab agentId={id} cases={cases} reload={loadCases} openId={openCase} onOpened={() => setOpenCase(null)} />}
      </TabPanel>

      {cmd && commandDialog()}
    </div>
  );

  /* ------------------------------------------------------------ render helpers (not components: no remount) */

  function versionActions() {
    if (!ver) return null;
    const btns: ReactNode[] = [];
    const notes: ReactNode[] = [];
    if (ver.status === "draft" && ver.canary && can("ai.manage"))
      btns.push(<Btn key="run" icon="play" label={t("ag.runTests")} busy={busy === "run"} disabled={run?.status === "running"} onClick={() => void runTests()} testId="agv-run" />);
    if (editable) {
      btns.push(<Btn key="save" kind={dirty ? "primary" : ""} icon="check" label={t("common.save")} busy={busy === "save"} disabled={!dirty} onClick={() => void save()} testId="agv-save" />);
      btns.push(<Btn key="run" icon="play" label={t("ag.runTests")} busy={busy === "run"} disabled={dirty || run?.status === "running"} title={dirty ? t("ag.gate.unsaved") : undefined} onClick={() => void runTests()} testId="agv-run" />);
      btns.push(<Btn key="del" kind="danger-ghost" icon="x" label={t("ag.deleteDraft")} onClick={() => setCmd({ kind: "delete" })} testId="agv-delete" />);
    }
    if (ver.status === "draft" && can("ai.publish")) {
      btns.push(<Btn key="pub" kind={gate ? "" : "primary"} icon="send" label={t("ag.publish")} disabled={!!gate} title={gate ? t(`ag.gate.${gate}` as MessageKey) : undefined} onClick={() => setCmd({ kind: "publish", key: uuid() })} testId="agv-publish" />);
      if (gate)
        notes.push(
          <span key="gate" data-testid="agv-gate" data-gate={gate}>
            {t(`ag.gate.${gate}` as MessageKey, { d: RUN_FRESH_DAYS })}
            {(gate === "failed" || gate === "stale" || gate === "running") && run && (
              <>
                {" "}
                <button type="button" className="tr" onClick={() => resultsRef.current?.scrollIntoView?.({ block: "start" })} data-testid="agv-to-results">
                  {t("ag.toResults")}
                </button>
              </>
            )}
          </span>,
        );
    } else if (ver.status === "draft" && !can("ai.publish")) notes.push(<span key="np">{t("ag.noPublish")}</span>);
    if (!btns.length && !notes.length) return null;
    return (
      <>
        {btns.length > 0 && (
          <div className="acts ws-acts" data-testid="agv-actions">
            {btns}
          </div>
        )}
        {notes.length > 0 && (
          <p className="xs muted row ws-notes">
            <Icon name="lock" /> {notes}
          </p>
        )}
      </>
    );
  }

  function runPanel() {
    if (!ver) return null;
    const r = run && run.version === ver.version ? run : null;
    const total = activeCases.length || null;
    return (
      <section className="ag-run" ref={resultsRef} aria-labelledby="agr-h" data-testid="agv-run-panel" tabIndex={-1}>
        <div className="row between">
          <h3 className="h3" id="agr-h">
            <Icon name="flask" /> {t("tr.title")}
          </h3>
          {r && (
            <span className="small muted">
              {t("tr.meta", { p: r.provider, t: fmt.dateTime(r.started_at) })}
              {r.cost_usd ? ` · ${money(r.cost_usd)}` : ""}
            </span>
          )}
        </div>
        {!r ? (
          <p className="small muted" data-testid="agv-no-run">
            {ver.last_test_run && ver.last_test_run.version === ver.version ? t("common.loading") : t("tr.none")}
          </p>
        ) : r.status === "running" ? (
          <Progress value={r.passed + r.failed} max={total ?? 0} label={total ? t("tr.progress", { d: r.passed + r.failed, n: total }) : t("trs.running")} testId="agv-progress" />
        ) : (
          <>
            <div className="row" data-testid="agv-run-summary" data-ok={String(r.passed_mandatory)}>
              <Pill tone={r.passed_mandatory ? "good" : "bad"}>
                <Icon name={r.passed_mandatory ? "checkCircle" : "alertCircle"} /> {r.passed_mandatory ? t("tr.okMandatory") : t("tr.badMandatory")}
              </Pill>
              <span className="small">{t("tr.counts", { p: r.passed, f: r.failed })}</span>
              {r.status === "failed" && <Pill tone="bad">{t("trs.failed")}</Pill>}
              {skippedTotal(r) > 0 && <span className="small muted">· {t("tr.skippedN", { n: skippedTotal(r) })}</span>}
            </div>
            {r.provider === "fake" && (
              <Callout icon="info" testId="agv-fake-note">
                {t("tr.fakeNote")}
              </Callout>
            )}
            <div className="table-wrap">
              <table className="tbl dense" data-testid="agv-results">
                <caption className="sr-only">{t("tr.title")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("tr.col.case")}</th>
                    <th scope="col">{t("tr.col.result")}</th>
                    <th scope="col">{t("tr.col.failures")}</th>
                    <th scope="col" className="r">
                      {t("tr.col.latency")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...r.results]
                    .sort((a, b) => Number(a.passed) - Number(b.passed) || Number(b.mandatory) - Number(a.mandatory))
                    .map((x) => (
                      <tr key={x.case_id} data-testid={`res-${x.case_id}`} data-passed={String(x.passed)}>
                        <td>
                          <button
                            type="button"
                            className="tr"
                            onClick={() => {
                              setOpenCase(x.case_id);
                              setTab("cases");
                            }}
                          >
                            {x.title}
                          </button>
                          {x.mandatory && (
                            <span className="block">
                              <Pill tone="info" dot={false}>
                                {t("gc.mandatory")}
                              </Pill>
                            </span>
                          )}
                        </td>
                        <td>
                          {x.passed ? (
                            <Pill tone="good">
                              <Icon name="check" /> {t("tr.passed")}
                            </Pill>
                          ) : (
                            <Pill tone="bad">
                              <Icon name="x" /> {t("tr.failed")}
                            </Pill>
                          )}
                        </td>
                        <td className="small wrap-any">
                          {x.failures.length ? (
                            <ul className="plain-list">
                              {x.failures.map((f, n) => (
                                <li key={n} className="mono xs">
                                  {f}
                                </li>
                              ))}
                            </ul>
                          ) : !x.skipped?.length ? (
                            <span className="muted">—</span>
                          ) : null}
                          {x.skipped?.length > 0 && (
                            <span className="xs muted block" data-testid={`res-${x.case_id}-skipped`}>
                              {t("tr.skipped", { p: r.provider, list: x.skipped.join(", ") })}
                            </span>
                          )}
                        </td>
                        <td className="r num small">{fmt.num(x.latency_ms)} ms</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    );
  }

  function commandDialog() {
    if (!cmd || !card) return null;
    const close = () => setCmd(null);
    const done = async (msg: string, audit: string, v?: number | null) => {
      toast(msg, "ok", audit);
      const c = await loadCard();
      let next = v ?? sel;
      if (c && (next == null || !c.versions.some((x) => x.version === next))) next = c.draft_version ?? c.published?.version ?? null;
      if (next != null && next === sel) void openVersion(next);
      else setSel(next);
    };
    if (cmd.kind === "delete" && ver)
      return (
        <Modal
          title={t("ag.deleteT", { v: ver.version })}
          text={t("ag.deleteM")}
          icon="x"
          tone="bad"
          onClose={close}
          testId="agv-delete-dialog"
          footer={
            <>
              <Btn label={t("common.cancel")} onClick={close} />
              <Btn
                label={t("ag.deleteDraft")}
                kind="danger"
                testId="agv-delete-ok"
                onClick={async () => {
                  try {
                    await Ai.deleteDraft(id, ver.version);
                    close();
                    setVer(null);
                    await done(t("ag.deleted", { v: ver.version }), "ai.version_deleted", card.published?.version);
                  } catch (e) {
                    close();
                    toast(errText(i, e), "err");
                  }
                }}
              />
            </>
          }
        />
      );
    if (cmd.kind === "publish" && ver)
      return (
        <ConfirmCommand
          title={t("ag.publishT", { v: ver.version, a: card.agent_id })}
          text={t("ag.publishM", { cur: card.published?.version ?? "—" })}
          icon="send"
          ok={t("ag.publish")}
          testId="agv-publish-dialog"
          extra={
            <Callout kind="info" icon="smartphoneKey">
              {t("ct.stepUpNote")}
            </Callout>
          }
          onClose={close}
          onConfirm={async (reason) => {
            try {
              await Ai.publish(id, ver.version, reason, cmd.key);
              await done(t("ag.published", { v: ver.version }), "ai.version_published", ver.version);
              return null;
            } catch (e) {
              return failed(e);
            }
          }}
        />
      );
    if (cmd.kind === "canary") return <CanaryDialog card={card} candidates={candidates.map((v) => v.version)} onClose={close} onDone={(v, p) => void done(t("ag.canarySet", { v, p }), "ai.canary_set")} failed={failed} />;
    if (cmd.kind === "clearCanary")
      return (
        <ConfirmCommand
          title={t("ag.canaryClearT", { v: ro?.canary_version ?? "—" })}
          text={t("ag.canaryClearM")}
          icon="x"
          ok={t("ag.canaryClear")}
          okKind="danger"
          testId="ag-canary-clear-dialog"
          extra={
            <Callout kind="info" icon="smartphoneKey">
              {t("ct.stepUpNote")}
            </Callout>
          }
          onClose={close}
          onConfirm={async (reason) => {
            try {
              await Ai.clearCanary(id, reason);
              await done(t("ag.canaryCleared"), "ai.canary_cleared");
              return null;
            } catch (e) {
              return failed(e);
            }
          }}
        />
      );
    if (cmd.kind === "rollback")
      return (
        <ConfirmCommand
          title={t("ag.rollbackT", { v: ro?.previous_version ?? "—" })}
          text={t("ag.rollbackM", { cur: ro?.published_version ?? "—", prev: ro?.previous_version ?? "—" })}
          icon="rollback"
          tone="bad"
          ok={t("ag.rollback")}
          okKind="danger"
          minReason={10}
          testId="ag-rollback-dialog"
          extra={
            <Callout kind="info" icon="smartphoneKey">
              {t("ct.stepUpNote")}
            </Callout>
          }
          onClose={close}
          onConfirm={async (reason) => {
            try {
              const row = await Ai.rollback(id, reason);
              await done(t("ag.rolledBack", { v: row.published?.version ?? ro?.previous_version ?? "—" }), "ai.rolled_back", row.published?.version);
              return null;
            } catch (e) {
              return failed(e);
            }
          }}
        />
      );
    return null;
  }

}

const skippedTotal = (r: TestRun) => r.results.reduce((a, x) => a + (x.skipped?.length ?? 0), 0);

const summaryOf = (r: TestRun) => {
  const { results: _r, ...s } = r;
  void _r;
  return s;
};

/** DOM id of a form field (focus on the first error) */
const fieldDom = (f: FormField) => `agv-${f}`;

function VersionFields({ form, set, editable, issuesOf, models }: { form: VersionForm; set: (k: FormField, v: string) => void; editable: boolean; issuesOf: (f: FormField) => FormIssue[]; models: AiModel[] }) {
  const { t } = useI18n();
  const msg = (x: FormIssue) => t(`agf.${x.code}` as MessageKey, x.vars);
  const err = (f: FormField) => {
    const xs = issuesOf(f);
    return xs.length ? xs.map(msg).join(" · ") : null;
  };
  const modelOpts = models.filter((m) => m.active || m.model_id === form.model_id || m.model_id === form.fallback_model_id);
  const big = (f: "instructions" | "rules", rows: number, max: number) => {
    const e = err(f);
    return (
      <div className="field">
        <div className="field-top">
          <label htmlFor={fieldDom(f)} className={f === "instructions" ? "req" : undefined}>
            {t(`agf.l.${f}`)}
          </label>
          <CharCount id={`${fieldDom(f)}-count`} n={form[f].length} max={max} />
        </div>
        <textarea
          id={fieldDom(f)}
          className={cx("textarea mono-text", e && "is-invalid")}
          rows={rows}
          value={form[f]}
          readOnly={!editable}
          spellCheck={false}
          aria-invalid={!!e}
          aria-describedby={`${fieldDom(f)}-count ${fieldDom(f)}-hint`}
          onChange={(ev) => set(f, ev.target.value)}
          data-testid={fieldDom(f)}
        />
        <span className="hint" id={`${fieldDom(f)}-hint`}>
          {t(`agf.h.${f}`)}
        </span>
        <FieldErr msg={e} />
      </div>
    );
  };
  const numF = (f: "temperature" | "max_output_tokens" | "timeout_ms" | "max_cost_usd", step: string) => {
    const e = err(f);
    return (
      <div className="field num-field">
        <label htmlFor={fieldDom(f)} className="req">
          {t(`agf.l.${f}`)}
        </label>
        <input id={fieldDom(f)} className={cx("input num", e && "is-invalid")} inputMode="decimal" step={step} value={form[f]} readOnly={!editable} aria-invalid={!!e} onChange={(ev) => set(f, ev.target.value)} data-testid={fieldDom(f)} />
        <span className="hint">{t(`agf.h.${f}`)}</span>
        <FieldErr msg={e} />
      </div>
    );
  };
  const schemaErr = err("schemaText");
  const schemaOk = !schemaErr && form.schemaText.trim() !== "";
  return (
    <div className="ed">
      <section className="ed-sec" aria-labelledby="agf-text-h">
        <h4 className="h3" id="agf-text-h">
          {t("agf.sec.text")}
        </h4>
        {big("instructions", 14, LIMITS.instructions)}
        {big("rules", 8, LIMITS.rules)}
      </section>
      <section className="ed-sec" aria-labelledby="agf-schema-h">
        <div className="ed-sec-h">
          <h4 className="h3" id="agf-schema-h">
            {t("agf.sec.schema")}
          </h4>
          {schemaOk ? (
            <Pill tone="good" testId="agf-schema-ok">
              <Icon name="check" /> {t("agf.schemaOk")}
            </Pill>
          ) : null}
        </div>
        <div className="field">
          <div className="field-top">
            <label htmlFor={fieldDom("schemaText")} className="req">
              {t("agf.l.schemaText")}
            </label>
            <CharCount id={`${fieldDom("schemaText")}-count`} n={form.schemaText.length} max={LIMITS.schema} />
          </div>
          <textarea
            id={fieldDom("schemaText")}
            className={cx("textarea mono-text", schemaErr && "is-invalid")}
            rows={12}
            value={form.schemaText}
            readOnly={!editable}
            spellCheck={false}
            aria-invalid={!!schemaErr}
            aria-describedby={`${fieldDom("schemaText")}-count`}
            onChange={(ev) => set("schemaText", ev.target.value)}
            data-testid="agv-schema"
          />
          <FieldErr msg={schemaErr} />
          {editable && (
            <span className="row">
              <Btn
                size="xs"
                icon="braces"
                label={t("agf.prettify")}
                onClick={() => {
                  try {
                    set("schemaText", prettyJson(JSON.parse(form.schemaText)));
                  } catch {
                    /* the error is already shown at the field */
                  }
                }}
                testId="agv-schema-format"
              />
            </span>
          )}
        </div>
        <div className="field" style={{ maxWidth: 360 }}>
          <label htmlFor={fieldDom("schema_version")} className="req">
            {t("agf.l.schema_version")}
          </label>
          <input id={fieldDom("schema_version")} className={cx("input mono", err("schema_version") && "is-invalid")} value={form.schema_version} readOnly={!editable} onChange={(ev) => set("schema_version", ev.target.value)} data-testid="agv-schema-version" />
          <span className="hint">{t("agf.h.schema_version")}</span>
          <FieldErr msg={err("schema_version")} />
        </div>
      </section>
      <section className="ed-sec" aria-labelledby="agf-model-h">
        <h4 className="h3" id="agf-model-h">
          {t("agf.sec.model")}
        </h4>
        <div className="agf-grid">
          <div className="field">
            <label htmlFor={fieldDom("model_id")} className="req">
              {t("agf.l.model_id")}
            </label>
            <Select<string> id={fieldDom("model_id")} label={t("agf.l.model_id")} value={form.model_id} disabled={!editable} onChange={(v) => set("model_id", v)} options={modelOpts.length ? modelOpts.map((m) => ({ v: m.model_id, label: m.model_id })) : [{ v: form.model_id, label: form.model_id }]} testId="agv-model" />
            <FieldErr msg={err("model_id")} />
          </div>
          <div className="field">
            <label htmlFor={fieldDom("fallback_model_id")}>{t("agf.l.fallback_model_id")}</label>
            <Select<string>
              id={fieldDom("fallback_model_id")}
              label={t("agf.l.fallback_model_id")}
              value={form.fallback_model_id}
              disabled={!editable}
              onChange={(v) => set("fallback_model_id", v)}
              options={[{ v: "", label: t("agf.noFallback") }, ...modelOpts.map((m) => ({ v: m.model_id, label: m.model_id }))]}
              testId="agv-fallback"
            />
            <FieldErr msg={err("fallback_model_id")} />
          </div>
          {numF("temperature", "0.05")}
          {numF("max_output_tokens", "1")}
          {numF("timeout_ms", "500")}
          {numF("max_cost_usd", "0.001")}
        </div>
        <div className="field">
          <div className="field-top">
            <label htmlFor={fieldDom("notes")}>{t("agf.l.notes")}</label>
            <CharCount id={`${fieldDom("notes")}-count`} n={form.notes.length} max={LIMITS.notes} />
          </div>
          <textarea id={fieldDom("notes")} className={cx("textarea", err("notes") && "is-invalid")} rows={2} value={form.notes} readOnly={!editable} onChange={(ev) => set("notes", ev.target.value)} data-testid="agv-notes" />
          <FieldErr msg={err("notes")} />
        </div>
      </section>
    </div>
  );
}

function CanaryDialog({ card, candidates, onClose, onDone, failed }: { card: AgentCardView; candidates: number[]; onClose: () => void; onDone: (v: number, p: number) => void; failed: (e: unknown) => string }) {
  const { t } = useI18n();
  const [v, setV] = useState(String(candidates[0] ?? ""));
  const [p, setP] = useState(String(card.rollout?.canary_percent || 10));
  const pn = Number(p);
  const okP = /^\d+$/.test(p.trim()) && pn >= 1 && pn <= 50;
  return (
    <ConfirmCommand
      title={t("ag.canaryT", { a: card.agent_id })}
      text={t("ag.canaryM")}
      icon="flask"
      ok={t("ag.canaryOk")}
      okDisabled={!okP || !v}
      testId="ag-canary-dialog"
      onClose={onClose}
      extra={
        <div className="stack sm">
          <div className="grid2 tight">
            <div className="field">
              <label htmlFor="cn-v" className="req">
                {t("ag.canaryVersion")}
              </label>
              <Select<string> id="cn-v" label={t("ag.canaryVersion")} value={v} onChange={setV} options={candidates.map((x) => ({ v: String(x), label: `v${x}` }))} testId="cn-version" />
            </div>
            <div className="field">
              <label htmlFor="cn-p" className="req">
                {t("ag.canaryPercent")}
              </label>
              <input id="cn-p" className={cx("input num", !okP && "is-invalid")} inputMode="numeric" value={p} onChange={(e) => setP(e.target.value)} aria-invalid={!okP} aria-describedby="cn-p-h" data-testid="cn-percent" />
              <span className="hint" id="cn-p-h">
                {t("ag.canaryPercentH")}
              </span>
            </div>
          </div>
          {!okP && <FieldErr msg={t("ag.canaryPercentErr")} />}
          <Callout kind="info" icon="smartphoneKey">
            {t("ct.stepUpNote")}
          </Callout>
        </div>
      }
      onConfirm={async (reason) => {
        try {
          await Ai.setCanary(card.agent_id, Number(v), pn, reason);
          onDone(Number(v), pn);
          return null;
        } catch (e) {
          return failed(e);
        }
      }}
    />
  );
}

/* ---------------------------------------------------------------- diff */

function DiffTab({ card, ver, form, dirty, pub }: { card: AgentCardView; ver: AgentVersionView | null; form: VersionForm | null; dirty: boolean; pub: AgentVersionView | null }) {
  const { t } = useI18n();
  const money = useUsd();
  if (!card.published) return <Callout icon="info">{t("ag.diff.noPub")}</Callout>;
  if (!ver || !form) return <Spinner label={t("common.loading")} />;
  if (ver.version === card.published.version)
    return (
      <Callout icon="info" testId="ag-diff-same-version">
        {t("ag.diff.isPub", { v: ver.version })}
      </Callout>
    );
  if (!pub) return <Spinner label={t("common.loading")} />;
  const pf = formOf(pub);
  const rows: Array<[string, string, string]> = [
    [t("agf.l.model_id"), pf.model_id, form.model_id],
    [t("agf.l.fallback_model_id"), pf.fallback_model_id || "—", form.fallback_model_id || "—"],
    [t("agf.l.temperature"), pf.temperature, form.temperature],
    [t("agf.l.max_output_tokens"), pf.max_output_tokens, form.max_output_tokens],
    [t("agf.l.timeout_ms"), pf.timeout_ms, form.timeout_ms],
    [t("agf.l.max_cost_usd"), money(Number(pf.max_cost_usd)), money(Number(form.max_cost_usd))],
    [t("agf.l.schema_version"), pf.schema_version, form.schema_version],
  ];
  return (
    <div className="stack" data-testid="ag-diff">
      <Callout icon="diff">
        {t("ag.diff.head", { v: ver.version, p: pub.version })}
        {dirty && <b> {t("ag.diff.unsaved")}</b>}
      </Callout>
      <section className="card stack sm" aria-labelledby="dif-p">
        <h3 className="h3" id="dif-p">
          {t("ag.diff.params")}
        </h3>
        <div className="table-wrap">
          <table className="tbl dense" data-testid="ag-diff-params">
            <thead>
              <tr>
                <th scope="col">{t("ag.diff.param")}</th>
                <th scope="col">v{pub.version}</th>
                <th scope="col">v{ver.version}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([k, a, b]) => (
                <tr key={k} className={cx(a !== b && "is-changed")}>
                  <th scope="row">{k}</th>
                  <td className="mono small">{a}</td>
                  <td className="mono small">
                    {b}
                    {a !== b && (
                      <span className="pill info ml-6">
                        <Icon name="edit" /> {t("ag.diff.changed")}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {(["instructions", "rules", "schemaText"] as const).map((f) => (
        <section key={f} className="card stack sm" aria-labelledby={`dif-${f}`}>
          <h3 className="h3" id={`dif-${f}`}>
            {t(`agf.l.${f}`)}
          </h3>
          <DiffView before={pf[f]} after={form[f]} testId={`ag-diff-${f}`} />
        </section>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- history */

function HistoryTab({ card, current, onOpen }: { card: AgentCardView; current: number | null; onOpen: (v: number) => void }) {
  const { t, fmt } = useI18n();
  return (
    <section className="panel" data-testid="ag-history">
      <div className="table-wrap">
        <table className="tbl compact">
          <caption className="sr-only">{t("ag.tab.history")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("ct.col.version")}</th>
              <th scope="col">{t("col.status")}</th>
              <th scope="col">{t("agf.l.model_id")}</th>
              <th scope="col">{t("ct.col.author")}</th>
              <th scope="col">{t("ct.col.published")}</th>
              <th scope="col">{t("ag.col.tests")}</th>
            </tr>
          </thead>
          <tbody>
            {card.versions.map((v) => (
              <tr key={v.version} className={cx(current === v.version && "is-sel")} data-testid={`agh-${v.version}`}>
                <td>
                  <button type="button" className="tr" onClick={() => onOpen(v.version)} aria-current={current === v.version ? "true" : undefined}>
                    v{v.version}
                  </button>
                </td>
                <td>
                  <span className="row nowrap-row">
                    <Pill tone={VST_TONE[v.status]}>{t(`avs.${v.status}`)}</Pill>
                    {v.canary && <Pill tone="accent">{t("ag.canaryShort")}</Pill>}
                    {card.rollout?.previous_version === v.version && <Pill tone="outline" dot={false}>{t("ag.prevShort")}</Pill>}
                  </span>
                </td>
                <td className="mono small">{v.model_id}</td>
                <td className="small">
                  {v.author_name ?? "—"}
                  <span className="xs muted block">{fmt.dateTime(v.created_at)}</span>
                </td>
                <td className="small">
                  {v.published_at ? (
                    <>
                      {fmt.dateTime(v.published_at)}
                      <span className="xs muted block">{v.published_by_name ?? "—"}</span>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="small">
                  {v.last_test_run ? (
                    <Pill tone={v.last_test_run.status === "running" ? "info" : v.last_test_run.passed_mandatory ? "good" : "bad"}>
                      {v.last_test_run.status === "running" ? t("trs.running") : `${v.last_test_run.passed}/${v.last_test_run.passed + v.last_test_run.failed}`}
                    </Pill>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel-f">
        <Icon name="lock" /> {t("ag.histNote")}
      </div>
    </section>
  );
}
