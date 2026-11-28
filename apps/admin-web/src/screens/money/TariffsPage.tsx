/**
 * «Тарифы и товары» (ADM-MONEY-03, AT-83; billing.read — view, billing.manage — the draft and its check,
 * billing.publish + step-up — activation, rollback and the one-off trial for everyone): the catalog as versions — the
 * active one (immutable; paid orders live by their snapshot), one draft, the archived ones.
 *
 * A product has two prices that never mix: the site — whole sums (Payme, Click, Uzum; fiscal requisites for the
 * receipt), the Mini App — whole Telegram Stars (the invoice title ≤ 32, the mode: a Telegram subscription — only 30
 * days and ≤ 10 000 Stars — or a one-time invoice). No price in Stars — not sold in the Mini App; no price in sums —
 * not sold on the site. The form mirrors the validator of billing; «Проверить» runs billing's (errors and warnings by
 * path); activation — only of the checked saved draft (409 CATALOG_NOT_VALIDATED otherwise). Rollback = a new version
 * from an archived one. Routes: #/tariffs · #/tariffs/v/<version>.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BillingAudience, CatalogValidation, CatalogVersion, CatalogVersionSummary } from "@tilhero/contracts/admin";
import type { BillingFeature } from "@tilhero/contracts/bff";
import type { WebProvider } from "@tilhero/contracts/web";
import { Billing } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, FieldErr, Pill, Reveal, Select, Spinner, TabPanel, Tabs } from "../../ui/kit";
import { ConfirmCommand, Drawer, Modal } from "../../ui/overlays";
import { errText } from "../../ui/errors";
import { useToast } from "../../ui/toasts";
import { CommandKey } from "../memory/model";
import { StepUpNote } from "../social/parts";
import {
  activationGate,
  AUDIENCES,
  CATALOG_TONE,
  catalogForm,
  checkCatalog,
  FEATURES,
  issuesAt,
  issuesUnder,
  LIMIT_KEYS,
  newProduct,
  NOTE_MAX,
  NOTE_MIN,
  salesOf,
  STARS_TITLE_MAX,
  WEB_PROVIDERS,
  type CatalogForm,
  type Issue,
  type ProductForm,
  type TariffTab,
} from "./model";
import { staffName, useMoney, useMoneyIssue } from "./parts";

type Cmd = { kind: "activate" } | { kind: "rollback"; version: number } | { kind: "delete" } | { kind: "trials" };
const fid = (path: string) => `tf-${path.replace(/[[\].]+/g, "-").replace(/-$/, "")}`;
const merge = (a: readonly Issue[], b: readonly Issue[]) => {
  const seen = new Set<string>();
  return [...a, ...b].filter((x) => (seen.has(`${x.path}:${x.code}`) ? false : (seen.add(`${x.path}:${x.code}`), true)));
};

/** #/tariffs/v/<n> → the version n (a positive whole number); anything else — no version drawer */
export function parseTariffRoute(id: string | null): number | null {
  const m = /^v\/([1-9]\d{0,8})$/.exec(id ?? "");
  return m ? Number(m[1]) : null;
}

export function TariffsPage({ routeId }: { routeId: string | null }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { can } = useSession();
  const { navigate } = useNav();
  const toast = useToast();
  const issueText = useMoneyIssue();
  const manage = can("billing.manage");
  const publish = can("billing.publish");
  const openVersion = parseTariffRoute(routeId);
  const [versions, setVersions] = useState<CatalogVersionSummary[] | null>(null);
  const [active, setActive] = useState<CatalogVersion | null>(null);
  const [draft, setDraft] = useState<CatalogVersion | null>(null);
  const [form, setForm] = useState<CatalogForm | null>(null);
  const [base, setBase] = useState<string>("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [server, setServer] = useState<(CatalogValidation & { at: string }) | null>(null);
  const [tab, setTab] = useState<TariffTab>("editor");
  const [cmd, setCmd] = useState<Cmd | null>(null);
  const [key] = useState(() => new CommandKey(uuid));
  const deleting = useRef(false);

  const applyDraft = useCallback((d: CatalogVersion | null) => {
    setDraft(d);
    const f = d ? catalogForm(d.payload) : null;
    setForm(f);
    setBase(f ? JSON.stringify([f, d?.comment ?? ""]) : "");
    setComment(d?.comment ?? "");
    setConflict(false);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await Billing.catalog();
      setVersions(r.items);
      const a = r.items.find((v) => v.status === "active");
      const d = r.items.find((v) => v.status === "draft");
      const [av, dv] = await Promise.all([a ? Billing.catalogVersion(a.version) : Promise.resolve(null), d ? Billing.catalogVersion(d.version) : Promise.resolve(null)]);
      setActive(av);
      applyDraft(dv);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [applyDraft]);
  useEffect(() => {
    void load();
  }, [load]);

  const shown = form ?? (active ? catalogForm(active.payload) : null);
  const checked = useMemo(() => (shown ? checkCatalog(shown) : null), [shown]);
  const dirty = !!form && JSON.stringify([form, comment]) !== base;
  const serverFresh = server && draft && server.at === draft.updated_at && !dirty ? server : null;
  const errors = merge(checked?.errors ?? [], serverFresh?.errors ?? []);
  const warnings = merge(checked?.warnings ?? [], serverFresh?.warnings ?? []);
  const gate = activationGate(draft, dirty, checked?.errors.length ?? 0);
  const editable = !!draft && manage;

  const failed = (e: unknown): string => {
    if ((e as ApiError)?.cancelled) return t("stepup.cancelled");
    if (e instanceof ApiError) {
      if (e.code === "DRAFT_CONFLICT") setConflict(true);
      if (e.code === "CATALOG_INVALID" && Array.isArray(e.details.errors) && draft) {
        setServer({ ok: false, errors: e.details.errors as Issue[], warnings: [], at: draft.updated_at });
        return t("tf.invalidN", { n: (e.details.errors as unknown[]).length });
      }
    }
    return errText(i18n, e);
  };

  const createDraft = async () => {
    if (!active || busy) return;
    setBusy("create");
    try {
      const d = await Billing.saveDraft({ payload: active.payload, comment: null }, null);
      applyDraft(d);
      setServer(null);
      toast(t("tf.draftCreated", { v: d.version, b: active.version }), "ok", "billing.catalog_draft_saved");
      setVersions((await Billing.catalog()).items);
    } catch (e) {
      toast(failed(e), "err");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!draft || !form || busy) return;
    const c = checkCatalog(form);
    if (!c.payload) {
      setFormErr(t("tf.fixNumbers", { n: c.errors.filter((x) => x.code === "not_integer" || x.code === "sums_format").length }));
      setTimeout(() => document.getElementById(fid(c.errors[0]!.path))?.focus(), 30);
      return;
    }
    if (comment.trim().length > NOTE_MAX) {
      setFormErr(t("mi.reason_long", { max: NOTE_MAX }));
      return;
    }
    setBusy("save");
    setFormErr(null);
    try {
      const d = await Billing.saveDraft({ payload: c.payload, comment: comment.trim() || null }, draft.updated_at);
      applyDraft(d);
      toast(t("tf.saved", { v: d.version }), "ok", "billing.catalog_draft_saved");
    } catch (e) {
      setFormErr(failed(e));
    } finally {
      setBusy(null);
    }
  };

  const validate = async () => {
    if (!draft || busy) return;
    if (dirty) return setFormErr(t("tf.gate.unsaved"));
    setBusy("validate");
    setFormErr(null);
    try {
      const v = await Billing.validate();
      const d = await Billing.catalogVersion(draft.version).catch(() => draft);
      setDraft(d);
      setServer({ ...v, at: d.updated_at });
      toast(v.ok ? t("tf.checkOk", { w: v.warnings.length }) : t("tf.checkBad", { n: v.errors.length }), v.ok ? "ok" : "err", "billing.catalog_validated");
      if (!v.ok && v.errors[0]) setTimeout(() => document.getElementById(fid(v.errors[0]!.path))?.focus(), 50);
    } catch (e) {
      setFormErr(failed(e));
    } finally {
      setBusy(null);
    }
  };

  const update = (fn: (f: CatalogForm) => CatalogForm) => {
    setForm((f) => (f ? fn(f) : f));
    setFormErr(null);
  };

  if (error && !versions) return <LoadError error={error} onRetry={() => void load()} />;
  if (!versions || !shown) return <Spinner label={t("common.loading")} />;
  const activeRow = versions.find((v) => v.status === "active") ?? null;
  const opened = openVersion != null ? (versions.find((v) => v.version === openVersion) ?? null) : null;

  return (
    <div className="stack" data-testid="tariffs">
      <section className="card ws" aria-labelledby="tf-h" data-testid="tf-head">
        <div className="ws-h">
          <div className="grow">
            <h2 className="h2" id="tf-h">
              {t("tf.title")}
            </h2>
            <p className="small muted">{t("tf.lead")}</p>
          </div>
          <div className="ws-pills">
            {activeRow && (
              <Pill tone="good" testId="tf-active">
                {t("tf.activeV", { v: activeRow.version })}
              </Pill>
            )}
            {draft && (
              <Pill tone="info" testId="tf-draft">
                {t("tf.draftV", { v: draft.version })}
              </Pill>
            )}
            {dirty && <Pill tone="warn">{t("ct.unsaved")}</Pill>}
          </div>
        </div>
        <div className="ag-roll" data-testid="tf-roll">
          <div className="ag-roll-c">
            <span className="xs muted">{t("tf.r.active")}</span>
            <b>{activeRow ? `v${activeRow.version}` : "—"}</b>
            {activeRow?.activated_at && <span className="xs muted">{t("tf.byAt", { n: staffName(activeRow.activated_by, t("mny.system")), t: fmt.dateTime(activeRow.activated_at) })}</span>}
          </div>
          <div className="ag-roll-c">
            <span className="xs muted">{t("tf.r.draft")}</span>
            <b>{draft ? `v${draft.version}` : t("tf.noDraft")}</b>
            {draft && <span className="xs muted">{t("tf.byAt", { n: staffName(draft.created_by, t("mny.system")), t: fmt.dateTime(draft.updated_at) })}</span>}
          </div>
          <div className="ag-roll-c">
            <span className="xs muted">{t("tf.r.check")}</span>
            <b data-testid="tf-check-state" data-state={!draft ? "none" : (gate ?? "ok")}>
              {!draft ? "—" : gate === null ? t("tf.checked") : t(`tf.gate.${gate}` as MessageKey)}
            </b>
          </div>
        </div>
        <div className="acts ws-acts" data-testid="tf-actions">
          {manage && !draft && <Btn icon="copy" kind="primary" label={t("tf.newDraft", { v: activeRow?.version ?? "—" })} busy={busy === "create"} disabled={!active} onClick={() => void createDraft()} testId="tf-new-draft" />}
          {editable && (
            <>
              <Btn icon="check" kind={dirty ? "primary" : ""} label={t("common.save")} busy={busy === "save"} disabled={!dirty} onClick={() => void save()} testId="tf-save" />
              <Btn icon="clipboardCheck" label={t("tf.validate")} busy={busy === "validate"} disabled={dirty} title={dirty ? t("tf.gate.unsaved") : undefined} onClick={() => void validate()} testId="tf-validate" />
              <Btn icon="x" kind="danger-ghost" label={t("tf.deleteDraft")} onClick={() => setCmd({ kind: "delete" })} testId="tf-delete" />
            </>
          )}
          {publish && draft && (
            <Btn icon="send" kind={gate ? "" : "primary"} label={t("tf.activate")} disabled={!!gate} title={gate ? t(`tf.gate.${gate}` as MessageKey) : undefined} onClick={() => setCmd({ kind: "activate" })} testId="tf-activate" />
          )}
          {publish && <Btn icon="gift" kind="ghost" label={t("tf.trials")} onClick={() => setCmd({ kind: "trials" })} testId="tf-trials" />}
        </div>
        {!manage || !publish ? (
          <p className="xs muted row ws-notes" data-testid="tf-notes">
            <Icon name="lock" />
            {!manage && <span>{t("perm.need", { p: "billing.manage" })}</span>}
            {!publish && <span>{t("perm.need", { p: "billing.publish" })}</span>}
          </p>
        ) : null}
      </section>

      <Callout icon="lock" testId="tf-immutable">
        {t("tf.immutable")}
      </Callout>
      {conflict && (
        <Reveal dep={conflict}>
          <Callout kind="warn" icon="alert" testId="tf-conflict">
            <b>{t("tf.conflict")}</b> {t("tf.conflictM")} <Btn size="xs" icon="refresh" label={t("ct.reload")} onClick={() => void load()} testId="tf-reload" />
          </Callout>
        </Reveal>
      )}
      <FieldErr msg={formErr} />
      {serverFresh?.ok && (
        <Callout kind="good" icon="checkCircle" testId="tf-check-ok">
          {t("tf.checkOkM", { w: serverFresh.warnings.length })}
        </Callout>
      )}
      <Issues title={t("tf.errorsN", { n: errors.length })} issues={errors} tone="bad" testId="tf-errors" text={issueText} />
      <Issues title={t("tf.warningsN", { n: warnings.length })} issues={warnings} tone="warn" testId="tf-warnings" text={issueText} />

      <Tabs<TariffTab>
        id="tft"
        label={t("tf.tabs")}
        value={tab}
        onChange={setTab}
        items={[
          { v: "editor", label: draft ? t("tf.tab.draft", { v: draft.version }) : t("tf.tab.active"), icon: "edit", testId: "tft-editor" },
          { v: "diff", label: t("tf.tab.diff"), icon: "diff", testId: "tft-diff" },
          { v: "history", label: t("tf.tab.history"), icon: "clock", cnt: versions.length, testId: "tft-history" },
        ]}
      />
      <TabPanel id="tft" value={tab}>
        {tab === "editor" && (
          <div className="stack" data-testid="tf-editor" data-editable={String(editable)}>
            {!draft && (
              <Callout icon="info" testId="tf-readonly">
                {manage ? t("tf.roNoDraft") : t("tf.roNoManage")}
              </Callout>
            )}
            {editable && (
              <div className="field">
                <label htmlFor="tf-comment">{t("tf.draftComment")}</label>
                <input id="tf-comment" className="input" value={comment} maxLength={NOTE_MAX * 2} onChange={(e) => setComment(e.target.value)} placeholder={t("tf.draftCommentPh")} data-testid="tf-comment" />
              </div>
            )}
            <Editor f={shown} editable={editable} errors={errors} warnings={warnings} update={update} />
          </div>
        )}
        {tab === "diff" && <DiffView version={draft} dirty={dirty} />}
        {tab === "history" && <History versions={versions} onOpen={(v) => navigate("tariffs", `v/${v}`)} onRollback={publish ? (v) => setCmd({ kind: "rollback", version: v }) : null} />}
      </TabPanel>

      {openVersion != null && (
        <VersionDrawer key={openVersion} version={openVersion} row={opened} onClose={() => navigate("tariffs")} onRollback={publish && opened?.status === "archived" ? () => setCmd({ kind: "rollback", version: openVersion }) : null} />
      )}
      {cmd && dialog()}
    </div>
  );

  function dialog(): ReactNode {
    if (!cmd) return null;
    const close = () => setCmd(null);
    if (cmd.kind === "delete" && draft)
      return (
        <Modal
          title={t("tf.deleteT", { v: draft.version })}
          text={t("tf.deleteM")}
          icon="x"
          tone="bad"
          onClose={close}
          testId="tf-delete-dialog"
          footer={
            <>
              <Btn label={t("common.cancel")} onClick={close} />
              <Btn
                label={t("tf.deleteDraft")}
                kind="danger"
                testId="tf-delete-ok"
                onClick={async () => {
                  if (deleting.current) return;
                  deleting.current = true;
                  try {
                    await Billing.deleteDraft();
                    close();
                    applyDraft(null);
                    setServer(null);
                    toast(t("tf.deleted", { v: draft.version }), "ok", "billing.catalog_draft_deleted");
                    setVersions((await Billing.catalog()).items);
                  } catch (e) {
                    close();
                    toast(failed(e), "err");
                  } finally {
                    deleting.current = false;
                  }
                }}
              />
            </>
          }
        />
      );
    if (cmd.kind === "activate" && draft)
      return (
        <ConfirmCommand
          title={t("tf.activateT", { v: draft.version })}
          text={t("tf.activateM", { cur: activeRow?.version ?? "—" })}
          icon="send"
          ok={t("tf.activate")}
          minReason={NOTE_MIN}
          maxReason={NOTE_MAX}
          reasonLabel={t("mny.comment")}
          reasonPlaceholder={t("tf.commentPh")}
          testId="tf-activate-dialog"
          extra={
            <>
              <p className="small" data-testid="tf-activate-changes">
                {t("tf.changesN", { n: draft.diff.length })}
              </p>
              {warnings.length > 0 && (
                <Callout kind="warn" icon="alert" testId="tf-activate-warnings">
                  {t("tf.activateWarn", { n: warnings.length })}
                </Callout>
              )}
              <StepUpNote />
            </>
          }
          onClose={close}
          onConfirm={async (c) => {
            // the command, never the draft's updated_at: a lost answer re-reads the catalog, the repeat keeps the key
            const k = key.for(JSON.stringify(["activate", draft.version, c]));
            try {
              const v = await Billing.activate(c, k);
              key.settle();
              setServer(null);
              toast(t("tf.activated", { v: v.version }), "ok", "billing.catalog_activated");
              await load();
              return null;
            } catch (e) {
              key.settle(e);
              if (e instanceof ApiError && e.code === "CATALOG_NOT_VALIDATED") void load();
              return failed(e);
            }
          }}
        />
      );
    if (cmd.kind === "rollback") {
      const next = Math.max(0, ...versions!.map((v) => v.version)) + 1;
      return (
        <ConfirmCommand
          title={t("tf.rollbackT", { v: cmd.version })}
          text={t("tf.rollbackM", { v: cmd.version, n: next, cur: activeRow?.version ?? "—" })}
          icon="rollback"
          tone="bad"
          ok={t("tf.rollback")}
          okKind="danger"
          minReason={NOTE_MIN}
          maxReason={NOTE_MAX}
          reasonLabel={t("mny.comment")}
          reasonPlaceholder={t("tf.commentPh")}
          testId="tf-rollback-dialog"
          extra={<StepUpNote />}
          onClose={close}
          onConfirm={async (c) => {
            const k = key.for(JSON.stringify(["rollback", cmd.version, c]));
            try {
              const v = await Billing.rollback(cmd.version, c, k);
              key.settle();
              toast(t("tf.rolledBack", { v: v.version, b: cmd.version }), "ok", "billing.catalog_rolled_back");
              navigate("tariffs");
              await load();
              return null;
            } catch (e) {
              key.settle(e);
              return failed(e);
            }
          }}
        />
      );
    }
    if (cmd.kind === "trials")
      return (
        <ConfirmCommand
          title={t("tf.trialsT")}
          text={t("tf.trialsM")}
          icon="gift"
          ok={t("tf.trialsGo")}
          minReason={NOTE_MIN}
          maxReason={NOTE_MAX}
          reasonPlaceholder={t("tf.trialsPh")}
          testId="tf-trials-dialog"
          extra={<StepUpNote />}
          onClose={close}
          onConfirm={async (reason) => {
            const k = key.for(JSON.stringify(["trials", reason]));
            try {
              const r = await Billing.grantTrials(reason, k);
              key.settle();
              toast(t("tf.trialsDone", { g: fmt.num(r.granted), s: fmt.num(r.skipped) }), "ok", "billing.trials_granted");
              return null;
            } catch (e) {
              key.settle(e);
              return failed(e);
            }
          }}
        />
      );
    return null;
  }
}

/* ---------------------------------------------------------------- problems */

function Issues({ title, issues, tone, testId, text }: { title: string; issues: readonly Issue[]; tone: "bad" | "warn"; testId: string; text: (x: Issue) => string | null }) {
  if (!issues.length) return null;
  return (
    <Callout kind={tone} icon={tone === "bad" ? "alertCircle" : "alert"} testId={testId}>
      <b>{title}</b>
      <ul className="tf-issues">
        {issues.slice(0, 30).map((x) => (
          <li key={`${x.path}:${x.code}`}>
            <button type="button" className="tr mono xs" onClick={() => document.getElementById(fid(x.path))?.focus()}>
              {x.path}
            </button>{" "}
            {text(x)}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/* ---------------------------------------------------------------- the form */

function Editor({ f, editable, errors, warnings, update }: { f: CatalogForm; editable: boolean; errors: readonly Issue[]; warnings: readonly Issue[]; update: (fn: (f: CatalogForm) => CatalogForm) => void }) {
  const { t } = useI18n();
  const issueText = useMoneyIssue();
  const err = (path: string) => issueText(issuesAt(errors, path)[0]) ?? null;
  const In = ({ path, label, value, onChange, w, inputMode, hint, max }: { path: string; label: string; value: string; onChange: (v: string) => void; w?: "s"; inputMode?: "numeric"; hint?: string; max?: number }) => (
    <div className={cx("field", w === "s" && "tf-num")}>
      <label htmlFor={fid(path)}>{label}</label>
      <input id={fid(path)} className={cx("input", inputMode && "num", err(path) && "is-invalid")} value={value} readOnly={!editable} inputMode={inputMode} maxLength={max ? max * 2 : 400} aria-invalid={!!err(path) || undefined} aria-describedby={err(path) ? `${fid(path)}-e` : hint ? `${fid(path)}-h` : undefined} onChange={(e) => onChange(e.target.value)} data-testid={fid(path)} />
      {max != null && (
        <span className={cx("counter", value.trim().length > max && "is-over")} data-testid={`${fid(path)}-count`}>
          {value.trim().length}/{max}
        </span>
      )}
      {hint && !err(path) && (
        <span className="hint" id={`${fid(path)}-h`}>
          {hint}
        </span>
      )}
      <FieldErr msg={err(path)} id={`${fid(path)}-e`} />
    </div>
  );
  return (
    <div className="stack" data-testid="tf-form">
      <section className="card stack sm" aria-labelledby="tf-gen-h">
        <h3 className="h3" id="tf-gen-h">
          {t("tf.general")}
        </h3>
        <div className="tf-grid">
          <In path="offer.version" label={t("tf.offerVersion")} value={f.offer_version} onChange={(v) => update((x) => ({ ...x, offer_version: v }))} w="s" />
          <In path="offer.url" label={t("tf.offerUrl")} value={f.offer_url} onChange={(v) => update((x) => ({ ...x, offer_url: v }))} hint={t("tf.offerUrlH")} />
          <In path="merchant.tin" label={t("tf.tin")} value={f.merchant_tin} onChange={(v) => update((x) => ({ ...x, merchant_tin: v }))} inputMode="numeric" hint={t("tf.tinH")} />
        </div>
        <h4 className="h4">{t("tf.trial")}</h4>
        <div className="tf-grid">
          <label className="check" htmlFor="tf-trial-enabled">
            <input type="checkbox" id="tf-trial-enabled" checked={f.trial.enabled} disabled={!editable} onChange={(e) => update((x) => ({ ...x, trial: { ...x.trial, enabled: e.target.checked } }))} data-testid="tf-trial-enabled" />
            <span>{t("tf.trialOn")}</span>
          </label>
          <In path="trial.days" label={t("tf.days")} value={f.trial.days} onChange={(v) => update((x) => ({ ...x, trial: { ...x.trial, days: v } }))} w="s" inputMode="numeric" />
          <In path="trial.minutes" label={t("tf.minutes")} value={f.trial.minutes} onChange={(v) => update((x) => ({ ...x, trial: { ...x.trial, minutes: v } }))} w="s" inputMode="numeric" />
          <Checks<BillingFeature> legend={t("tf.features")} all={FEATURES} value={f.trial.features} disabled={!editable} label={(v) => t(`feat.${v}` as MessageKey)} onChange={(v) => update((x) => ({ ...x, trial: { ...x.trial, features: v } }))} idp="tf-trial-feat" />
        </div>
        <h4 className="h4">{t("tf.limits")}</h4>
        <div className="tf-grid">
          {LIMIT_KEYS.map((k) => (
            <In key={k} path={`limits.${k}`} label={t(`tf.lim.${k}` as MessageKey)} value={f.limits[k]} onChange={(v) => update((x) => ({ ...x, limits: { ...x.limits, [k]: v } }))} w="s" inputMode="numeric" />
          ))}
        </div>
      </section>
      {f.products.map((p, i) => (
        <ProductCard
          key={i}
          i={i}
          p={p}
          editable={editable}
          errors={issuesUnder(errors, `products[${i}]`)}
          warnings={issuesUnder(warnings, `products[${i}]`)}
          In={In}
          set={(fn) => update((x) => ({ ...x, products: x.products.map((y, j) => (j === i ? fn(y) : y)) }))}
          remove={() => update((x) => ({ ...x, products: x.products.filter((_, j) => j !== i) }))}
        />
      ))}
      {editable && (
        <div className="acts">
          <Btn icon="plus" size="sm" label={t("tf.addSub")} onClick={() => update((x) => ({ ...x, products: [...x.products, newProduct("subscription")] }))} testId="tf-add-sub" />
          <Btn icon="plus" size="sm" label={t("tf.addPack")} onClick={() => update((x) => ({ ...x, products: [...x.products, newProduct("til_pack")] }))} testId="tf-add-pack" />
        </div>
      )}
    </div>
  );
}

type InProps = { path: string; label: string; value: string; onChange: (v: string) => void; w?: "s"; inputMode?: "numeric"; hint?: string; max?: number };

function ProductCard({ i, p, editable, errors, warnings, In, set, remove }: { i: number; p: ProductForm; editable: boolean; errors: readonly Issue[]; warnings: readonly Issue[]; In: (x: InProps) => ReactNode; set: (fn: (p: ProductForm) => ProductForm) => void; remove: () => void }) {
  const { t } = useI18n();
  const money = useMoney();
  const issueText = useMoneyIssue();
  const at = (k: string) => `products[${i}].${k}`;
  const parsed = checkCatalog({ ...catalogForm(null), offer_version: "1", offer_url: "https://x.y", products: [p] }).payload?.products[0] ?? null;
  const sales = parsed ? salesOf(parsed) : { web: false, miniapp: false };
  const fiscalWarn = warnings.find((w) => w.code === "fiscal_missing");
  return (
    <section className={cx("card stack sm tf-product", errors.length > 0 && "has-errors")} aria-labelledby={`tf-p${i}-h`} data-testid={`tf-product-${i}`} data-code={p.code}>
      <div className="row between">
        <h3 className="h3" id={`tf-p${i}-h`}>
          <span lang="ru">{p.title.ru || t("tf.untitled")}</span> <span className="mono xs muted">{p.code}</span>
        </h3>
        <div className="row">
          <Pill tone={p.kind === "subscription" ? "info" : "accent"}>{t(`pk.${p.kind}` as MessageKey)}</Pill>
          <Pill tone={sales.web ? "good" : "neutral"} testId={`tf-product-${i}-web`}>
            {sales.web && parsed ? t("tf.onSite", { p: money.sum(parsed.price_tiyin) }) : t("tf.notOnSite")}
          </Pill>
          <Pill tone={sales.miniapp ? "good" : "neutral"} testId={`tf-product-${i}-miniapp`}>
            {sales.miniapp && parsed ? t("tf.inMiniApp", { p: money.stars(parsed.price_stars) }) : t("tf.notInMiniApp")}
          </Pill>
          {editable && <Btn size="xs" kind="danger-ghost" icon="x" label={t("tf.removeProduct")} onClick={remove} testId={`tf-product-${i}-remove`} />}
        </div>
      </div>
      <div className="tf-grid">
        <In path={at("code")} label={t("tf.code")} value={p.code} onChange={(v) => set((x) => ({ ...x, code: v }))} />
        <div className="field">
          <label htmlFor={`tf-p${i}-status`}>{t("col.status")}</label>
          <Select<"on_sale" | "hidden"> id={`tf-p${i}-status`} label={t("col.status")} value={p.status} disabled={!editable} onChange={(v) => set((x) => ({ ...x, status: v }))} options={(["on_sale", "hidden"] as const).map((v) => ({ v, label: t(`tf.st.${v}` as MessageKey) }))} testId={`tf-p${i}-status`} />
        </div>
        <In path={at("sort")} label={t("tf.sort")} value={p.sort} onChange={(v) => set((x) => ({ ...x, sort: v }))} w="s" inputMode="numeric" />
      </div>
      <div className="tf-grid">
        {(["ru", "uz"] as const).map((l) => (
          <In key={l} path={`${at("title")}.${l}`} label={t(`tf.title.${l}` as MessageKey)} value={p.title[l]} max={60} onChange={(v) => set((x) => ({ ...x, title: { ...x.title, [l]: v } }))} />
        ))}
        {(["ru", "uz"] as const).map((l) => (
          <In key={`d${l}`} path={`${at("description")}.${l}`} label={t(`tf.descr.${l}` as MessageKey)} value={p.description[l]} max={300} onChange={(v) => set((x) => ({ ...x, description: { ...x.description, [l]: v } }))} />
        ))}
      </div>
      <div className="tf-grid">
        {p.kind === "subscription" ? (
          <>
            <In path={at("days")} label={t("tf.days")} value={p.days} onChange={(v) => set((x) => ({ ...x, days: v }))} w="s" inputMode="numeric" />
            <In path={at("minutes")} label={t("tf.aiMinutes")} value={p.minutes} onChange={(v) => set((x) => ({ ...x, minutes: v }))} w="s" inputMode="numeric" />
            <Checks<BillingFeature> legend={t("tf.features")} all={FEATURES} value={p.features} disabled={!editable} label={(v) => t(`feat.${v}` as MessageKey)} onChange={(v) => set((x) => ({ ...x, features: v }))} idp={`tf-p${i}-feat`} error={issueText(issuesAt(errors, at("features"))[0])} />
          </>
        ) : (
          <In path={at("til")} label={t("tf.til")} value={p.til} onChange={(v) => set((x) => ({ ...x, til: v }))} w="s" inputMode="numeric" />
        )}
        <Checks<BillingAudience> legend={t("tf.audiences")} all={AUDIENCES} value={p.audiences} disabled={!editable} label={(v) => t(`ageseg.${v}` as MessageKey)} onChange={(v) => set((x) => ({ ...x, audiences: v }))} idp={`tf-p${i}-aud`} error={issueText(issuesAt(errors, at("audiences"))[0])} />
      </div>
      <div className="grid2 tf-channels">
        <fieldset className="tf-channel" data-testid={`tf-p${i}-site`}>
          <legend>
            <Icon name="globe" /> {t("tf.site")}
          </legend>
          <In path={at("price_tiyin")} label={t("tf.priceSums")} value={p.price_sums} onChange={(v) => set((x) => ({ ...x, price_sums: v }))} inputMode="numeric" hint={t("tf.priceSumsH")} />
          <Checks<WebProvider> legend={t("tf.providers")} all={WEB_PROVIDERS} value={p.providers} disabled={!editable} label={(v) => t(`bprv.${v}` as MessageKey)} onChange={(v) => set((x) => ({ ...x, providers: v }))} idp={`tf-p${i}-prov`} />
          <details className="tf-fiscal" open={!!fiscalWarn || errors.some((e) => e.path.includes(".fiscal"))}>
            <summary>
              {t("tf.fiscal")} {fiscalWarn && <Pill tone="warn">{t("tf.fiscalMissing")}</Pill>}
            </summary>
            <p className="xs muted">{t("tf.fiscalH")}</p>
            <div className="tf-grid">
              <In path={at("fiscal.ikpu")} label={t("tf.ikpu")} value={p.fiscal.ikpu} onChange={(v) => set((x) => ({ ...x, fiscal: { ...x.fiscal, ikpu: v } }))} inputMode="numeric" />
              <In path={at("fiscal.package_code")} label={t("tf.package")} value={p.fiscal.package_code} onChange={(v) => set((x) => ({ ...x, fiscal: { ...x.fiscal, package_code: v } }))} inputMode="numeric" />
              <In path={at("fiscal.vat_percent")} label={t("tf.vat")} value={p.fiscal.vat_percent} onChange={(v) => set((x) => ({ ...x, fiscal: { ...x.fiscal, vat_percent: v } }))} w="s" inputMode="numeric" />
              <In path={at("fiscal.units")} label={t("tf.units")} value={p.fiscal.units} onChange={(v) => set((x) => ({ ...x, fiscal: { ...x.fiscal, units: v } }))} w="s" inputMode="numeric" />
              <In path={at("fiscal.receipt_title")} label={t("tf.receiptTitle")} value={p.fiscal.receipt_title} max={63} onChange={(v) => set((x) => ({ ...x, fiscal: { ...x.fiscal, receipt_title: v } }))} />
            </div>
          </details>
        </fieldset>
        <fieldset className="tf-channel" data-testid={`tf-p${i}-stars`}>
          <legend>
            <Icon name="star" /> {t("tf.miniapp")}
          </legend>
          <In path={at("price_stars")} label={t("tf.priceStars")} value={p.price_stars} onChange={(v) => set((x) => ({ ...x, price_stars: v }))} inputMode="numeric" hint={t("tf.priceStarsH")} />
          <div className="field">
            <label htmlFor={fid(at("stars_mode"))}>{t("tf.starsMode")}</label>
            <Select<"subscription" | "one_time">
              id={fid(at("stars_mode"))}
              label={t("tf.starsMode")}
              value={p.stars_mode}
              disabled={!editable}
              onChange={(v) => set((x) => ({ ...x, stars_mode: v }))}
              options={(["subscription", "one_time"] as const).map((v) => ({ v, label: t(`stm.${v}` as MessageKey), disabled: v === "subscription" && p.kind !== "subscription" }))}
              testId={fid(at("stars_mode"))}
            />
            <span className="hint">{t("tf.starsModeH")}</span>
            <FieldErr msg={issueText(issuesAt(errors, at("stars_mode"))[0])} />
          </div>
          {(["ru", "uz"] as const).map((l) => (
            <In key={l} path={`${at("stars_title")}.${l}`} label={t(`tf.starsTitle.${l}` as MessageKey)} value={p.stars_title[l]} max={STARS_TITLE_MAX} onChange={(v) => set((x) => ({ ...x, stars_title: { ...x.stars_title, [l]: v } }))} />
          ))}
        </fieldset>
      </div>
    </section>
  );
}

function Checks<T extends string>({ legend, all, value, disabled, label, onChange, idp, error }: { legend: string; all: readonly T[]; value: readonly T[]; disabled: boolean; label: (v: T) => string; onChange: (v: T[]) => void; idp: string; error?: string | null }) {
  return (
    <fieldset className="field tf-checks" id={idp} data-testid={idp}>
      <legend className="field-label">{legend}</legend>
      <div className="row wrap">
        {all.map((v) => (
          <label key={v} className="check" htmlFor={`${idp}-${v}`}>
            <input type="checkbox" id={`${idp}-${v}`} checked={value.includes(v)} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...value, v] : value.filter((x) => x !== v))} data-testid={`${idp}-${v}`} />
            <span>{label(v)}</span>
          </label>
        ))}
      </div>
      <FieldErr msg={error ?? null} />
    </fieldset>
  );
}

/* ---------------------------------------------------------------- diff, history, a version */

function DiffView({ version, dirty }: { version: CatalogVersion | null; dirty: boolean }) {
  const { t } = useI18n();
  if (!version) return <Callout icon="info">{t("tf.diffNoDraft")}</Callout>;
  return (
    <div className="stack sm" data-testid="tf-diff">
      {dirty && (
        <Callout kind="warn" icon="alert" testId="tf-diff-unsaved">
          {t("tf.diffUnsaved")}
        </Callout>
      )}
      <DiffTable diff={version.diff} />
    </div>
  );
}

function DiffTable({ diff }: { diff: CatalogVersion["diff"] }) {
  const { t } = useI18n();
  if (!diff.length) return <p className="small muted">{t("tf.diffNone")}</p>;
  const show = (v: unknown) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <div className="table-wrap">
      <table className="tbl compact" data-testid="tf-diff-rows">
        <caption className="sr-only">{t("tf.tab.diff")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("tf.diffPath")}</th>
            <th scope="col">{t("tf.diffFrom")}</th>
            <th scope="col">{t("tf.diffTo")}</th>
          </tr>
        </thead>
        <tbody>
          {diff.map((d) => (
            <tr key={d.path}>
              <td className="mono xs">{d.path}</td>
              <td className="small wrap-any muted">{show(d.from)}</td>
              <td className="small wrap-any">
                <b>{show(d.to)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function History({ versions, onOpen, onRollback }: { versions: CatalogVersionSummary[]; onOpen: (v: number) => void; onRollback: ((v: number) => void) | null }) {
  const { t, fmt } = useI18n();
  return (
    <div className="table-wrap">
      <table className="tbl compact" data-testid="tf-history">
        <caption className="sr-only">{t("tf.tab.history")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("tf.col.version")}</th>
            <th scope="col">{t("col.status")}</th>
            <th scope="col">{t("mny.comment")}</th>
            <th scope="col">{t("tf.col.author")}</th>
            <th scope="col">{t("tf.col.activated")}</th>
            <th scope="col" className="r">
              {t("ct.col.actions")}
            </th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.version} data-testid={`tf-v-${v.version}`} data-status={v.status}>
              <td>
                <button type="button" className="tr mono" onClick={() => onOpen(v.version)} data-testid={`tf-open-${v.version}`}>
                  v{v.version}
                </button>
              </td>
              <td>
                <Pill tone={CATALOG_TONE[v.status]}>{t(`cvst.${v.status}` as MessageKey)}</Pill>
              </td>
              <td className="small wrap-any">{v.comment ?? <span className="muted">—</span>}</td>
              <td className="small">
                {v.created_by.name}
                <span className="xs muted block">{fmt.dateTime(v.created_at)}</span>
              </td>
              <td className="small">{v.activated_at ? `${staffName(v.activated_by, t("mny.system"))} · ${fmt.dateTime(v.activated_at)}` : "—"}</td>
              <td className="actions-cell">{onRollback && v.status === "archived" && <Btn size="xs" kind="danger-ghost" icon="rollback" label={t("tf.rollback")} onClick={() => onRollback(v.version)} testId={`tf-rollback-${v.version}`} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VersionDrawer({ version, row, onClose, onRollback }: { version: number; row: CatalogVersionSummary | null; onClose: () => void; onRollback: (() => void) | null }) {
  const { t } = useI18n();
  const money = useMoney();
  const [v, setV] = useState<CatalogVersion | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    Billing.catalogVersion(version)
      .then((x) => (setV(x), setError(null)))
      .catch(setError);
  }, [version]);
  useEffect(load, [load]);
  const products = Array.isArray(v?.payload?.products) ? v!.payload.products : [];
  return (
    <Drawer
      wide
      testId="tf-version"
      onClose={onClose}
      title={t("tf.versionT", { v: version })}
      sub={row && <Pill tone={CATALOG_TONE[row.status]}>{t(`cvst.${row.status}` as MessageKey)}</Pill>}
      footer={onRollback ? <Btn kind="danger" icon="rollback" label={t("tf.rollback")} onClick={onRollback} testId="tf-version-rollback" /> : undefined}
    >
      {error && !v ? (
        <LoadError error={error} onRetry={load} />
      ) : !v ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="stack">
          <div className="table-wrap">
            <table className="tbl compact" data-testid="tf-version-products">
              <caption className="sr-only">{t("tf.products")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("tf.code")}</th>
                  <th scope="col">{t("tf.titleCol")}</th>
                  <th scope="col" className="r">
                    {t("tf.site")}
                  </th>
                  <th scope="col" className="r">
                    {t("tf.miniapp")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.code}>
                    <td className="mono small">{p.code}</td>
                    <td className="small" lang="ru">
                      {p.title?.ru}
                    </td>
                    <td className="r num">{p.price_tiyin != null ? money.sum(p.price_tiyin) : "—"}</td>
                    <td className="r num">{p.price_stars != null ? `${money.stars(p.price_stars)} · ${t(`stm.${p.stars_mode}` as MessageKey)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="h3">{t("tf.tab.diff")}</h3>
          <DiffTable diff={v.diff} />
        </div>
      )}
    </Drawer>
  );
}
