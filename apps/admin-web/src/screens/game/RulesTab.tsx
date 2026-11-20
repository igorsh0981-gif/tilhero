/**
 * «Геймификация → Правила» (ADM-GAME-01, AT-71): the rules of the game as versions — the active one (immutable), one
 * draft, the archived ones. The draft: a form by GameRules (awards per activity, daily caps, level thresholds, the
 * thresholds of the hero stages, the streak freeze, bonuses, the quest templates, badge thresholds) with the client
 * mirror of the validator; «Проверить» runs the gamification validator (errors and warnings by path, shown at the
 * fields); activation — game.publish, step-up and a comment ≥ 10, only after a successful check of the saved draft
 * (409 RULES_NOT_VALIDATED otherwise). History of versions with the diff to the active one; rollback = a new version
 * from an archived one, the same step-up and comment. Operations already made are never recalculated.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GameRules, RulesValidation, RulesVersion, RulesVersionSummary } from "@tilhero/contracts/admin";
import { Game } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, FieldErr, JsonView, Pill, Reveal, Select, Spinner, TabPanel, Tabs } from "../../ui/kit";
import { ConfirmCommand, Drawer, Modal } from "../../ui/overlays";
import { errText } from "../../ui/errors";
import { useToast } from "../../ui/toasts";
import { CommandKey } from "../memory/model";
import { focusField, IssueMsg, IssuesPanel, useIssueText, usePathLabel } from "./parts";
import {
  activationGate,
  AUDIENCES,
  checkRules,
  commentProblem,
  COMMENT_MAX,
  COMMENT_MIN,
  diffValues,
  EARN_ROWS,
  fieldId,
  getAt,
  issuesAt,
  issuesUnder,
  newTemplate,
  normPath,
  parseRules,
  QUEST_KINDS,
  RULES_TONE,
  rulesForm,
  setAt,
  showValue,
  type Issue,
  type RulesForm,
} from "./model";

type RTab = "editor" | "diff" | "history";
type Cmd = { kind: "activate" } | { kind: "rollback"; version: number } | { kind: "delete" };

const mergeIssues = (a: readonly Issue[], b: readonly Issue[]) => {
  const seen = new Set<string>();
  return [...a, ...b].filter((x) => {
    const k = `${normPath(x.path)}:${x.code}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export function RulesTab({ openVersion }: { openVersion: number | null }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { can } = useSession();
  const { navigate } = useNav();
  const toast = useToast();
  const manage = can("game.manage");
  const publish = can("game.publish");
  const [versions, setVersions] = useState<RulesVersionSummary[] | null>(null);
  const [active, setActive] = useState<RulesVersion | null>(null);
  const [draft, setDraft] = useState<RulesVersion | null>(null);
  const [form, setForm] = useState<RulesForm | null>(null);
  const [base, setBase] = useState<RulesForm | null>(null);
  const [comment, setComment] = useState("");
  const [baseComment, setBaseComment] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [server, setServer] = useState<(RulesValidation & { at: string }) | null>(null);
  const [tab, setTab] = useState<RTab>("editor");
  const [cmd, setCmd] = useState<Cmd | null>(null);
  const [actKey] = useState(() => new CommandKey(uuid));
  const [deleting, setDeleting] = useState(false);
  /** synchronous guard: a double click on «Удалить черновик» sends one DELETE */
  const deletingRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const applyDraft = useCallback((d: RulesVersion | null) => {
    setDraft(d);
    const f = d ? rulesForm(d.payload) : null;
    setForm(f);
    setBase(f);
    setComment(d?.comment ?? "");
    setBaseComment(d?.comment ?? "");
    setConflict(false);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await Game.rules();
      if (!alive.current) return;
      setVersions(r.items);
      const a = r.items.find((v) => v.status === "active");
      const d = r.items.find((v) => v.status === "draft");
      const [av, dv] = await Promise.all([a ? Game.rulesVersion(a.version) : Promise.resolve(null), d ? Game.rulesVersion(d.version) : Promise.resolve(null)]);
      if (!alive.current) return;
      setActive(av);
      applyDraft(dv);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e);
    }
  }, [applyDraft]);
  useEffect(() => {
    void load();
  }, [load]);

  const editable = !!draft && manage;
  const shownForm = form ?? (active ? rulesForm(active.payload) : null);
  const checked = useMemo(() => (shownForm ? checkRules(shownForm, active?.payload ?? null) : null), [shownForm, active]);
  const dirty = !!form && !!base && (JSON.stringify(form) !== JSON.stringify(base) || comment !== baseComment);
  // the server's problems belong to the saved draft: they are shown until it changes again
  const serverFresh = server && draft && server.at === draft.updated_at && !dirty ? server : null;
  const errors = useMemo(() => mergeIssues(checked?.errors ?? [], serverFresh?.errors ?? []), [checked, serverFresh]);
  const warnings = useMemo(() => mergeIssues(checked?.warnings ?? [], serverFresh?.warnings ?? []), [checked, serverFresh]);
  const gate = activationGate(draft, dirty, checked?.errors.length ?? 0, serverFresh ? { ok: serverFresh.ok, at: serverFresh.at } : null);
  const parseBlocked = form ? parseRules(form).issues.length : 0;

  const failed = (e: unknown): string => {
    if ((e as ApiError)?.cancelled) return t("stepup.cancelled");
    if (e instanceof ApiError) {
      if (e.code === "DRAFT_CONFLICT") setConflict(true);
      if (e.code === "RULES_INVALID" && Array.isArray(e.details.errors) && draft) {
        setServer({ ok: false, errors: e.details.errors as Issue[], warnings: [], at: draft.updated_at });
        return t("gr.invalidN", { n: (e.details.errors as unknown[]).length });
      }
    }
    return errText(i18n, e);
  };

  const createDraft = async () => {
    if (!active || busy) return;
    setBusy("create");
    try {
      const d = await Game.saveDraft({ payload: active.payload, comment: null, based_on: active.version }, null);
      applyDraft(d);
      setServer(null);
      toast(t("gr.draftCreated", { v: d.version, b: active.version }), "ok", "game.rules_draft_saved");
      void refreshList();
    } catch (e) {
      toast(failed(e), "err");
    } finally {
      setBusy(null);
    }
  };

  const refreshList = async () => {
    try {
      const r = await Game.rules();
      if (alive.current) setVersions(r.items);
    } catch {
      /* the list stays */
    }
  };

  const save = async (): Promise<RulesVersion | null> => {
    if (!draft || !form || busy) return null;
    const { rules, issues } = parseRules(form);
    if (issues.length) {
      setFormErr(t("gr.fixNumbers", { n: issues.length }));
      setTimeout(() => focusField("gr", issues[0]!.path), 30);
      return null;
    }
    // the comment of a draft is optional; when given — 10..300 characters, like every comment of the section
    if (comment.trim() && commentProblem(comment)) {
      setFormErr(t("gm.commentRange", { a: COMMENT_MIN, b: COMMENT_MAX }));
      setTimeout(() => document.getElementById("gr-comment")?.focus(), 30);
      return null;
    }
    setBusy("save");
    setFormErr(null);
    try {
      const d = await Game.saveDraft({ payload: rules, comment: comment.trim() || null, based_on: draft.based_on }, draft.updated_at);
      applyDraft(d);
      toast(t("gr.saved", { v: d.version }), "ok", "game.rules_draft_saved");
      return d;
    } catch (e) {
      setFormErr(failed(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const validate = async () => {
    if (!draft || busy) return;
    if (dirty) {
      setFormErr(t("gr.gate.unsaved"));
      return;
    }
    setBusy("validate");
    setFormErr(null);
    try {
      const v = await Game.validate();
      // validated_at moves on the server — re-read the draft (its updated_at stays)
      const d = await Game.rulesVersion(draft.version).catch(() => draft);
      setDraft(d);
      setServer({ ...v, at: d.updated_at });
      toast(v.ok ? t("gr.checkOk", { w: v.warnings.length }) : t("gr.checkBad", { n: v.errors.length }), v.ok ? "ok" : "err", "game.rules_validated");
      if (!v.ok && v.errors[0]) setTimeout(() => focusField("gr", v.errors[0]!.path), 50);
    } catch (e) {
      setFormErr(failed(e));
    } finally {
      setBusy(null);
    }
  };

  const set = (path: string, v: unknown) => {
    setForm((f) => (f ? setAt(f, path, v) : f));
    setFormErr(null);
  };

  if (error && !versions) return <LoadError error={error} onRetry={() => void load()} />;
  if (!versions || !shownForm) return <Spinner label={t("common.loading")} />;

  const activeRow = versions.find((v) => v.status === "active") ?? null;
  const opened = openVersion != null ? versions.find((v) => v.version === openVersion) ?? null : null;

  return (
    <div className="stack" data-testid="gr">
      <section className="card ws" aria-labelledby="gr-h" data-testid="gr-head">
        <div className="ws-h">
          <div className="grow">
            <h2 className="h2" id="gr-h">
              {t("gr.title")}
            </h2>
            <p className="small muted">{t("gr.lead")}</p>
          </div>
          <div className="ws-pills">
            {activeRow && (
              <Pill tone="good" testId="gr-active">
                {t("gr.activeV", { v: activeRow.version })}
              </Pill>
            )}
            {draft && (
              <Pill tone="info" testId="gr-draft">
                {t("gr.draftV", { v: draft.version })}
              </Pill>
            )}
            {dirty && <Pill tone="warn">{t("ct.unsaved")}</Pill>}
          </div>
        </div>
        <div className="ag-roll" data-testid="gr-roll">
          <div className="ag-roll-c">
            <span className="xs muted">{t("gr.r.active")}</span>
            <b>{activeRow ? `v${activeRow.version}` : "—"}</b>
            {activeRow?.activated_at && <span className="xs muted">{t("gr.byAt", { n: activeRow.activated_by?.name ?? "—", t: fmt.dateTime(activeRow.activated_at) })}</span>}
          </div>
          <div className="ag-roll-c">
            <span className="xs muted">{t("gr.r.draft")}</span>
            <b>{draft ? `v${draft.version}${draft.based_on != null ? ` · ${t("gr.basedOn", { v: draft.based_on })}` : ""}` : t("gr.noDraft")}</b>
            {draft && <span className="xs muted">{t("gr.byAt", { n: draft.created_by.name, t: fmt.dateTime(draft.updated_at) })}</span>}
          </div>
          <div className="ag-roll-c">
            <span className="xs muted">{t("gr.r.check")}</span>
            <b data-testid="gr-check-state" data-state={!draft ? "none" : gate === "not_validated" ? "stale" : gate === "invalid" ? "bad" : gate === null ? "ok" : "unsaved"}>
              {!draft ? "—" : gate === null ? t("gr.checkedAt", { t: fmt.dateTime(draft.validated_at) }) : gate === "invalid" ? t("gr.checkFailed") : gate === "unsaved" ? t("gr.gate.unsaved") : t("gr.notChecked")}
            </b>
          </div>
        </div>
        <div className="acts ws-acts" data-testid="gr-actions">
          {manage && !draft && <Btn icon="copy" kind="primary" label={t("gr.newDraft", { v: activeRow?.version ?? "—" })} busy={busy === "create"} disabled={!active} onClick={() => void createDraft()} testId="gr-new-draft" />}
          {editable && (
            <>
              <Btn icon="check" kind={dirty ? "primary" : ""} label={t("common.save")} busy={busy === "save"} disabled={!dirty} onClick={() => void save()} testId="gr-save" />
              <Btn icon="clipboardCheck" label={t("gr.validate")} busy={busy === "validate"} disabled={dirty} title={dirty ? t("gr.gate.unsaved") : undefined} onClick={() => void validate()} testId="gr-validate" />
              <Btn icon="x" kind="danger-ghost" label={t("gr.deleteDraft")} onClick={() => setCmd({ kind: "delete" })} testId="gr-delete" />
            </>
          )}
          {publish && draft && <Btn icon="send" kind={gate ? "" : "primary"} label={t("gr.activate")} disabled={!!gate} title={gate ? t(`gr.gate.${gate}` as MessageKey) : undefined} onClick={() => setCmd({ kind: "activate" })} testId="gr-activate" />}
        </div>
        {(gate && publish && draft) || !manage || !publish ? (
          <p className="xs muted row ws-notes" data-testid="gr-notes" data-gate={gate ?? "ok"}>
            <Icon name={gate && publish && draft ? "info" : "lock"} />
            {gate && publish && draft && <span>{t(`gr.gate.${gate}` as MessageKey)}</span>}
            {!manage && <span>{t("gm.noManage")}</span>}
            {!publish && <span>{t("gm.noPublish")}</span>}
          </p>
        ) : null}
      </section>

      <Callout icon="lock" testId="gr-immutable">
        {t("gr.immutable")}
      </Callout>
      {conflict && (
        <Reveal dep={conflict}>
          <Callout kind="warn" icon="alert" testId="gr-conflict">
            <b>{t("gr.conflict")}</b> {t("gr.conflictM")} <Btn size="xs" icon="refresh" label={t("ct.reload")} onClick={() => void load()} testId="gr-reload" />
          </Callout>
        </Reveal>
      )}
      <FieldErr msg={formErr} />
      {serverFresh?.ok && (
        <Callout kind="good" icon="checkCircle" testId="gr-check-ok">
          {t("gr.checkOkM", { w: serverFresh.warnings.length })}
        </Callout>
      )}
      <IssuesPanel title={t("gr.errorsN", { n: errors.length })} issues={errors} prefix="gr" tone="bad" testId="gr-errors" />
      <IssuesPanel title={t("gr.warningsN", { n: warnings.length })} issues={warnings} prefix="gr" tone="warn" testId="gr-warnings" />

      <Tabs<RTab>
        id="grt"
        label={t("gr.tabs")}
        value={tab}
        onChange={setTab}
        items={[
          { v: "editor", label: draft ? t("gr.tab.draft", { v: draft.version }) : t("gr.tab.active"), icon: "edit", testId: "grt-editor" },
          { v: "diff", label: t("gr.tab.diff"), icon: "diff", testId: "grt-diff" },
          { v: "history", label: t("gr.tab.history"), icon: "clock", cnt: versions.length, testId: "grt-history" },
        ]}
      />
      <TabPanel id="grt" value={tab}>
        {tab === "editor" && (
          <div className="stack" data-testid="gr-editor" data-editable={String(editable)}>
            {!draft && (
              <Callout icon="info" testId="gr-readonly">
                {manage ? t("gr.roNoDraft") : t("gr.roNoManage")}
              </Callout>
            )}
            {editable && (
              <div className="field">
                <label htmlFor="gr-comment">{t("gr.draftComment")}</label>
                <input id="gr-comment" className={cx("input", comment.trim().length > COMMENT_MAX && "is-invalid")} value={comment} maxLength={COMMENT_MAX * 2} onChange={(e) => setComment(e.target.value)} placeholder={t("gr.draftCommentPh")} aria-describedby="gr-comment-n" data-testid="gr-comment" />
                <span id="gr-comment-n" className={cx("counter", comment.trim().length > COMMENT_MAX && "is-over")}>
                  {comment.trim().length}/{COMMENT_MAX}
                </span>
              </div>
            )}
            <RulesEditor f={shownForm} set={set} editable={editable} errors={errors} warnings={warnings} />
            {editable && parseBlocked > 0 && <p className="xs bad-ink">{t("gr.fixNumbers", { n: parseBlocked })}</p>}
          </div>
        )}
        {tab === "diff" && <DiffTab active={active} form={shownForm} base={base} draftV={draft?.version ?? null} />}
        {tab === "history" && <HistoryTab versions={versions} draftV={draft?.version ?? null} onOpen={(v) => navigate("game", `rules/${v}`)} onRollback={publish ? (v) => setCmd({ kind: "rollback", version: v }) : null} />}
      </TabPanel>

      {openVersion != null && (
        <VersionDrawer key={openVersion} version={openVersion} row={opened} active={active} draftV={draft?.version ?? null} onClose={() => navigate("game", "rules")} onRollback={publish && opened?.status === "archived" ? () => setCmd({ kind: "rollback", version: openVersion }) : null} />
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
          title={t("gr.deleteT", { v: draft.version })}
          text={t("gr.deleteM")}
          icon="x"
          tone="bad"
          onClose={close}
          testId="gr-delete-dialog"
          footer={
            <>
              <Btn label={t("common.cancel")} onClick={close} />
              <Btn
                label={t("gr.deleteDraft")}
                kind="danger"
                busy={deleting}
                testId="gr-delete-ok"
                onClick={async () => {
                  if (deletingRef.current) return;
                  deletingRef.current = true;
                  setDeleting(true);
                  try {
                    await Game.deleteDraft();
                    close();
                    applyDraft(null);
                    setServer(null);
                    toast(t("gr.deleted", { v: draft.version }), "ok", "game.rules_draft_deleted");
                    void refreshList();
                  } catch (e) {
                    close();
                    toast(failed(e), "err");
                  } finally {
                    deletingRef.current = false;
                    setDeleting(false);
                  }
                }}
              />
            </>
          }
        />
      );
    if (cmd.kind === "activate" && draft) {
      const changes = active && form ? diffValues(active.payload, parseRules(form).rules).length : 0;
      return (
        <ConfirmCommand
          title={t("gr.activateT", { v: draft.version })}
          text={t("gr.activateM", { cur: activeRow?.version ?? "—" })}
          icon="send"
          ok={t("gr.activate")}
          minReason={COMMENT_MIN}
          maxReason={COMMENT_MAX}
          reasonLabel={t("gm.comment")}
          reasonPlaceholder={t("gr.commentPh")}
          testId="gr-activate-dialog"
          extra={
            <>
              <p className="small" data-testid="gr-activate-changes">
                {t("gr.changesN", { n: changes })}
              </p>
              {warnings.length > 0 && (
                <Callout kind="warn" icon="alert" testId="gr-activate-warnings">
                  {t("gr.activateWarn", { n: warnings.length })}
                </Callout>
              )}
              <Callout kind="info" icon="smartphoneKey">
                {t("ct.stepUpNote")}
              </Callout>
            </>
          }
          onClose={close}
          onConfirm={async (c) => {
            const key = actKey.for(JSON.stringify(["activate", draft.version, draft.updated_at, c]));
            try {
              const v = await Game.activate(c, key);
              actKey.settle();
              setServer(null);
              toast(t("gr.activated", { v: v.version }), "ok", "game.rules_activated");
              await load();
              return null;
            } catch (e) {
              actKey.settle(e);
              if (e instanceof ApiError && e.code === "RULES_NOT_VALIDATED") void load();
              return failed(e);
            }
          }}
        />
      );
    }
    if (cmd.kind === "rollback") {
      const next = Math.max(0, ...versions!.map((v) => v.version)) + 1;
      return (
        <ConfirmCommand
          title={t("gr.rollbackT", { v: cmd.version })}
          text={t("gr.rollbackM", { v: cmd.version, n: next, cur: activeRow?.version ?? "—" })}
          icon="rollback"
          tone="bad"
          ok={t("gr.rollback")}
          okKind="danger"
          minReason={COMMENT_MIN}
          maxReason={COMMENT_MAX}
          reasonLabel={t("gm.comment")}
          reasonPlaceholder={t("gr.commentPh")}
          testId="gr-rollback-dialog"
          extra={
            <Callout kind="info" icon="smartphoneKey">
              {t("ct.stepUpNote")}
            </Callout>
          }
          onClose={close}
          onConfirm={async (c) => {
            const key = actKey.for(JSON.stringify(["rollback", cmd.version, c]));
            try {
              const v = await Game.rollback(cmd.version, c, key);
              actKey.settle();
              toast(t("gr.rolledBack", { v: v.version, b: cmd.version }), "ok", "game.rules_rolled_back");
              navigate("game", "rules");
              await load();
              return null;
            } catch (e) {
              actKey.settle(e);
              // a draft appeared in between (another tab): rollback waits until the draft is deleted
              if (e instanceof ApiError && e.code === "RULES_STATE") {
                void load();
                const dv = e.num("draft") ?? draft?.version ?? null;
                return dv != null ? t("gr.rollbackDraft", { v: dv }) : t("err.RULES_STATE");
              }
              return failed(e);
            }
          }}
        />
      );
    }
    return null;
  }
}

/* ---------------------------------------------------------------- the form */

function NumIn({ path, f, set, editable, issues, label, hideLabel, w, errId }: { path: string; f: RulesForm; set: (p: string, v: unknown) => void; editable: boolean; issues: readonly Issue[]; label: string; hideLabel?: boolean; w?: "s" | "m"; errId?: string }) {
  const id = fieldId("gr", path);
  const xs = issuesAt(issues, path);
  // inside a list the problems are written once under the list (errId), the field keeps its red border and the link
  const described = xs.length ? (errId ?? `${id}-e`) : undefined;
  const v = String(getAt(f, path) ?? "");
  return (
    <div className={cx("field gr-num", w === "s" && "is-s")}>
      <label htmlFor={id} className={cx(hideLabel && "sr-only")}>
        {label}
      </label>
      <input
        id={id}
        className={cx("input num-in", xs.length > 0 && "is-invalid")}
        inputMode="numeric"
        value={v}
        disabled={!editable}
        aria-invalid={xs.length > 0 || undefined}
        aria-describedby={described}
        onChange={(e) => set(path, e.target.value)}
        data-testid={id}
      />
      {!errId && <IssueMsg issues={xs} id={`${id}-e`} />}
    </div>
  );
}

function Sec({ id, title, note, children, issues }: { id: string; title: string; note?: ReactNode; children: ReactNode; issues: readonly Issue[] }) {
  const { t } = useI18n();
  const n = issues.length;
  return (
    <section className={cx("card stack sm gr-sec", n > 0 && "is-bad")} aria-labelledby={`grs-${id}`} data-testid={`grs-${id}`}>
      <div className="row between">
        <h3 className="h3" id={`grs-${id}`}>
          {title}
        </h3>
        {n > 0 && <Pill tone="bad">{t("gr.secIssues", { n })}</Pill>}
      </div>
      {note && <p className="xs muted">{note}</p>}
      {children}
    </section>
  );
}

function NumList({ path, f, set, editable, issues, label, item, min = 1, max = 100, testId }: { path: string; f: RulesForm; set: (p: string, v: unknown) => void; editable: boolean; issues: readonly Issue[]; label: string; item: (i: number) => string; min?: number; max?: number; testId: string }) {
  const { t } = useI18n();
  const text = useIssueText();
  const xs = (getAt(f, path) as string[]) ?? [];
  const own = issuesAt(issues, path);
  const errId = `${fieldId("gr", path)}-items-e`;
  const itemErrs = xs.flatMap((_, i) => issuesAt(issues, `${path}[${i}]`).map((x) => `${item(i)}: ${text(x)}`));
  return (
    <div className="stack sm" data-testid={testId}>
      <span className="field-label" id={`${fieldId("gr", path)}-l`}>
        {label}
      </span>
      <div className="gr-list" role="group" aria-labelledby={`${fieldId("gr", path)}-l`} id={fieldId("gr", path)}>
        {xs.map((_, i) => (
          <NumIn key={i} path={`${path}[${i}]`} f={f} set={set} editable={editable} issues={issues} label={item(i)} w="s" errId={errId} />
        ))}
        {editable && (
          <span className="gr-list-acts">
            <Btn size="xs" icon="plus" label={t("gr.add")} disabled={xs.length >= max} onClick={() => set(path, [...xs, String((Number(xs[xs.length - 1]) || 0) + 1)])} testId={`${testId}-add`} />
            <Btn size="xs" kind="ghost" icon="x" label={t("gr.removeLast")} disabled={xs.length <= min} onClick={() => set(path, xs.slice(0, -1))} testId={`${testId}-remove`} />
          </span>
        )}
      </div>
      <FieldErr msg={itemErrs.length ? itemErrs.join(" · ") : null} id={errId} />
      <IssueMsg issues={own} />
    </div>
  );
}

export function RulesEditor({ f, set, editable, errors, warnings }: { f: RulesForm; set: (p: string, v: unknown) => void; editable: boolean; errors: readonly Issue[]; warnings: readonly Issue[] }) {
  const { t } = useI18n();
  const all = [...errors, ...warnings];
  const p = { f, set, editable, issues: all };
  const templates = f.quests.templates;
  const perDay = Number(f.quests.per_day) || 0;
  return (
    <div className="gr-form" data-testid="gr-form">
      <Sec id="earn" title={t("gr.s.earn")} note={t("gr.s.earnNote")} issues={issuesUnder(errors, "earn")}>
        <div className="table-wrap">
          <table className="tbl dense gr-tbl gr-earn">
            <caption className="sr-only">{t("gr.s.earn")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("gr.col.activity")}</th>
                <th scope="col">XP</th>
                <th scope="col">{t("gm.cur.til")}</th>
              </tr>
            </thead>
            <tbody>
              {EARN_ROWS.map((k) => (
                <tr key={k}>
                  <th scope="row">
                    {t(`grp.${k}` as MessageKey)}
                    <span className="xs muted block">{t(`gr.h.${k}` as MessageKey)}</span>
                  </th>
                  <td>
                    <NumIn {...p} path={`earn.${k}.xp`} label={`${t(`grp.${k}` as MessageKey)} · XP`} hideLabel w="s" />
                  </td>
                  <td>
                    <NumIn {...p} path={`earn.${k}.til`} label={`${t(`grp.${k}` as MessageKey)} · ${t("gm.cur.til")}`} hideLabel w="s" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="gr-row">
          <NumIn {...p} path="earn.review.min_cards" label={t("grp.min_cards")} w="m" />
          <NumIn {...p} path="earn.review.xp_base" label={t("gr.f.reviewXpBase")} w="m" />
          <NumIn {...p} path="earn.review.xp_per_correct_cap" label={t("grp.xp_per_correct_cap")} w="m" />
          <NumIn {...p} path="earn.review.til" label={t("gr.f.reviewTil")} w="m" />
          <NumIn {...p} path="earn.skill_max_per_event" label={t("grp.skill_max_per_event")} w="m" />
        </div>
        <p className="xs muted">{t("gr.reviewNote")}</p>
      </Sec>
      <Sec id="caps" title={t("gr.s.caps")} note={t("gr.s.capsNote")} issues={issuesUnder(errors, "caps")}>
        <div className="gr-row">
          <NumIn {...p} path="caps.xp_per_day" label={t("grp.xp_per_day")} w="m" />
          <NumIn {...p} path="caps.til_per_day" label={t("grp.til_per_day")} w="m" />
        </div>
      </Sec>
      <Sec id="levels" title={t("gr.s.levels")} note={t("gr.s.levelsNote")} issues={issuesUnder(errors, "levels")}>
        <NumList {...p} path="levels" label={t("gr.f.levels")} item={(i) => t("gr.levelN", { n: i + 1 })} min={2} max={100} testId="gr-levels" />
      </Sec>
      <Sec id="hero" title={t("gr.s.hero")} note={t("gr.s.heroNote")} issues={issuesUnder(errors, "hero")}>
        <div className="gr-row">
          {[0, 1, 2].map((i) => (
            <NumIn key={i} {...p} path={`hero.stage_thresholds[${i}]`} label={t("gr.stageFrom", { n: i + 1 })} w="m" />
          ))}
        </div>
      </Sec>
      <Sec id="freeze" title={t("gr.s.freeze")} note={t("gr.s.freezeNote")} issues={[...issuesUnder(errors, "freeze"), ...issuesUnder(errors, "bonuses")]}>
        <div className="gr-row">
          <NumIn {...p} path="freeze.price_til" label={t("grp.price_til")} w="m" />
          <NumIn {...p} path="freeze.max_stock" label={t("grp.max_stock")} w="m" />
          <NumIn {...p} path="bonuses.registration_freeze" label={t("grp.registration_freeze")} w="m" />
          <NumIn {...p} path="bonuses.referral_freeze" label={t("grp.referral_freeze")} w="m" />
          <NumIn {...p} path="bonuses.referral_monthly_cap" label={t("grp.referral_monthly_cap")} w="m" />
        </div>
      </Sec>
      <Sec id="quests" title={t("gr.s.quests")} note={t("gr.s.questsNote")} issues={issuesUnder(errors, "quests")}>
        <div className="gr-row">
          <NumIn {...p} path="quests.per_day" label={t("grp.per_day")} w="m" />
          <NumIn {...p} path="quests.all_done_bonus.xp" label={t("gr.f.bonusXp")} w="m" />
          <NumIn {...p} path="quests.all_done_bonus.til" label={t("gr.f.bonusTil")} w="m" />
        </div>
        <p className="xs muted row" data-testid="gr-per-aud">
          {AUDIENCES.map((a) => {
            const n = templates.filter((q) => q.audiences.includes(a)).length;
            return (
              <span key={a} className={cx(n < perDay && "bad-ink b")}>
                {t("gr.perAud", { a: t(`gm.aud.${a}` as MessageKey), n })}
              </span>
            );
          })}
        </p>
        <IssueMsg issues={issuesAt(errors, "quests.templates")} />
        <div className="table-wrap" id={fieldId("gr", "quests.templates")}>
          <table className="tbl dense gr-tbl gr-tpl" data-testid="gr-templates">
            <caption className="sr-only">{t("gr.templates")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("gr.col.code")}</th>
                <th scope="col">{t("gr.col.kind")}</th>
                <th scope="col">{t("gr.col.target")}</th>
                <th scope="col">XP</th>
                <th scope="col">{t("gm.cur.til")}</th>
                <th scope="col">{t("gm.audiences")}</th>
                <th scope="col">{t("gr.col.weight")}</th>
                {editable && <th scope="col" className="sr-only">{t("ct.col.actions")}</th>}
              </tr>
            </thead>
            <tbody>
              {templates.map((q, i) => {
                const pth = `quests.templates[${i}]`;
                const name = q.code || t("grp.index", { n: i + 1 });
                const kindId = fieldId("gr", `${pth}.kind`);
                const codeId = fieldId("gr", `${pth}.code`);
                const audId = fieldId("gr", `${pth}.audiences`);
                return (
                  <tr key={i} data-testid={`gr-tpl-${i}`}>
                    <td>
                      <label htmlFor={codeId} className="sr-only">
                        {t("gr.col.code")} {i + 1}
                      </label>
                      <input id={codeId} className={cx("input mono gr-code", issuesAt(all, `${pth}.code`).length > 0 && "is-invalid")} value={q.code} disabled={!editable} onChange={(e) => set(`${pth}.code`, e.target.value)} data-testid={codeId} />
                      <IssueMsg issues={issuesAt(all, `${pth}.code`)} />
                    </td>
                    <td>
                      <Select<string> id={kindId} label={`${t("gr.col.kind")} · ${name}`} value={q.kind} disabled={!editable} onChange={(v) => set(`${pth}.kind`, v)} options={QUEST_KINDS.map((k) => ({ v: k, label: t(`gq.${k}` as MessageKey) }))} testId={kindId} />
                      <IssueMsg issues={issuesAt(all, `${pth}.kind`)} />
                    </td>
                    <td>
                      <NumIn {...p} path={`${pth}.target`} label={`${t("gr.col.target")} · ${name}`} hideLabel w="s" />
                    </td>
                    <td>
                      <NumIn {...p} path={`${pth}.reward.xp`} label={`XP · ${name}`} hideLabel w="s" />
                    </td>
                    <td>
                      <NumIn {...p} path={`${pth}.reward.til`} label={`${t("gm.cur.til")} · ${name}`} hideLabel w="s" />
                    </td>
                    <td>
                      <fieldset className="fs" id={audId}>
                        <legend className="sr-only">
                          {t("gm.audiences")} · {name}
                        </legend>
                        <span className="row xs-gap nowrap-row">
                          {AUDIENCES.map((a) => (
                            <label className="check" key={a} title={t(`ageseg.${a}` as MessageKey)}>
                              <input type="checkbox" checked={q.audiences.includes(a)} disabled={!editable} onChange={(e) => set(`${pth}.audiences`, AUDIENCES.filter((x) => (x === a ? e.target.checked : q.audiences.includes(x))))} />
                              {t(`gm.aud.${a}` as MessageKey)}
                            </label>
                          ))}
                        </span>
                      </fieldset>
                      <IssueMsg issues={issuesAt(all, `${pth}.audiences`)} />
                    </td>
                    <td>
                      <NumIn {...p} path={`${pth}.weight`} label={`${t("gr.col.weight")} · ${name}`} hideLabel w="s" />
                    </td>
                    {editable && (
                      <td className="actions-cell">
                        <Btn size="xs" kind="ghost" icon="x" aria={t("gr.removeTpl", { c: name })} onClick={() => set("quests.templates", templates.filter((_, j) => j !== i))} testId={`gr-tpl-${i}-remove`} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {editable && <Btn size="sm" icon="plus" label={t("gr.addTpl")} onClick={() => set("quests.templates", [...templates, newTemplate(templates)])} testId="gr-tpl-add" />}
      </Sec>
      <Sec id="badges" title={t("gr.s.badges")} note={t("gr.s.badgesNote")} issues={issuesUnder(errors, "badges")}>
        {(["streak", "skills", "reviews_cards", "readings"] as const).map((k) => (
          <NumList key={k} {...p} path={`badges.${k}`} label={t(`grp.${k}` as MessageKey)} item={(i) => `${t(`grp.${k}` as MessageKey)} ${i + 1}`} min={0} max={10} testId={`gr-badges-${k}`} />
        ))}
      </Sec>
    </div>
  );
}

/* ---------------------------------------------------------------- diff and history */

function DiffTable({ rows, unsaved, testId }: { rows: Array<{ path: string; from: unknown; to: unknown }>; unsaved?: Set<string>; testId: string }) {
  const { t } = useI18n();
  const label = usePathLabel();
  if (!rows.length)
    return (
      <p className="small muted" data-testid={`${testId}-same`}>
        {t("gr.diffSame")}
      </p>
    );
  return (
    <div className="table-wrap">
      <table className="tbl dense" data-testid={testId}>
        <caption className="sr-only">{t("gr.tab.diff")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("gr.col.param")}</th>
            <th scope="col">{t("gr.col.was")}</th>
            <th scope="col">{t("gr.col.now")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.path} data-path={r.path}>
              <th scope="row">
                {label(r.path)}
                <span className="mono xs muted block">{r.path}</span>
              </th>
              <td className="mono small">{showValue(r.from)}</td>
              <td className="mono small">
                {showValue(r.to)}
                {unsaved?.has(r.path) && <Pill tone="warn">{t("ct.unsaved")}</Pill>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiffTab({ active, form, base, draftV }: { active: RulesVersion | null; form: RulesForm; base: RulesForm | null; draftV: number | null }) {
  const { t } = useI18n();
  if (!active) return <Callout icon="info">{t("gr.noActive")}</Callout>;
  if (draftV == null)
    return (
      <Callout icon="info" testId="gr-diff-none">
        {t("gr.diffNoDraft")}
      </Callout>
    );
  const now = parseRules(form).rules;
  const rows = diffValues(active.payload, now);
  const unsaved = new Set(base ? diffValues(parseRules(base).rules, now).map((r) => r.path) : []);
  return (
    <section className="card stack sm" data-testid="gr-diff">
      <Callout icon="diff">{t("gr.diffHead", { v: draftV, a: active.version, n: rows.length })}</Callout>
      <DiffTable rows={rows} unsaved={unsaved} testId="gr-diff-table" />
    </section>
  );
}

function HistoryTab({ versions, draftV, onOpen, onRollback }: { versions: RulesVersionSummary[]; draftV: number | null; onOpen: (v: number) => void; onRollback: ((v: number) => void) | null }) {
  const { t, fmt } = useI18n();
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  return (
    <section className="panel" data-testid="gr-history">
      <div className="table-wrap">
        <table className="tbl compact">
          <caption className="sr-only">{t("gr.tab.history")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("ct.col.version")}</th>
              <th scope="col">{t("col.status")}</th>
              <th scope="col">{t("gm.comment")}</th>
              <th scope="col">{t("ct.col.author")}</th>
              <th scope="col">{t("gr.col.activated")}</th>
              <th scope="col" className="r">
                {t("ct.col.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((v) => (
              <tr key={v.version} data-testid={`grh-${v.version}`} data-status={v.status}>
                <td>
                  <button type="button" className="tr" onClick={() => onOpen(v.version)} data-testid={`grh-open-${v.version}`}>
                    v{v.version}
                  </button>
                  {v.based_on != null && <span className="xs muted block">{t("gr.basedOn", { v: v.based_on })}</span>}
                </td>
                <td>
                  <Pill tone={RULES_TONE[v.status]}>{t(`gst.${v.status}` as MessageKey)}</Pill>
                </td>
                <td className="small wrap-any" lang="ru">
                  {v.comment ?? <span className="muted">—</span>}
                </td>
                <td className="small">
                  {v.created_by.name}
                  <span className="xs muted block">{fmt.dateTime(v.created_at)}</span>
                </td>
                <td className="small">
                  {v.activated_at ? (
                    <>
                      {fmt.dateTime(v.activated_at)}
                      <span className="xs muted block">{v.activated_by?.name ?? "—"}</span>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="actions-cell">
                  {onRollback && v.status === "archived" && (
                    <Btn size="xs" kind="danger-ghost" icon="rollback" label={t("gr.rollbackTo", { v: v.version })} disabled={draftV != null} title={draftV != null ? t("gr.rollbackDraft", { v: draftV }) : undefined} onClick={() => onRollback(v.version)} testId={`grh-rollback-${v.version}`} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {onRollback && draftV != null && (
        <div className="panel-f" data-testid="gr-rollback-blocked">
          <Icon name="info" /> {t("gr.rollbackDraft", { v: draftV })}
        </div>
      )}
      <div className="panel-f">
        <Icon name="lock" /> {t("gr.histNote")}
      </div>
    </section>
  );
}

function VersionDrawer({ version, row, active, draftV, onClose, onRollback }: { version: number; row: RulesVersionSummary | null; active: RulesVersion | null; draftV: number | null; onClose: () => void; onRollback: (() => void) | null }) {
  const { t, fmt } = useI18n();
  const [v, setV] = useState<RulesVersion | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [json, setJson] = useState(false);
  const load = useCallback(() => {
    Game.rulesVersion(version)
      .then((x) => (setV(x), setError(null)))
      .catch(setError);
  }, [version]);
  useEffect(load, [load]);
  const rows = v && active ? (v.version === active.version ? [] : diffValues(active.payload, v.payload)) : (v?.diff ?? []);
  return (
    <Drawer
      wide
      testId="gr-version"
      onClose={onClose}
      title={t("gr.versionT", { v: version })}
      sub={
        v && (
          <>
            <Pill tone={RULES_TONE[v.status]}>{t(`gst.${v.status}` as MessageKey)}</Pill>
            <span>{t("gr.byAt", { n: v.created_by.name, t: fmt.dateTime(v.created_at) })}</span>
            {v.based_on != null && <span>{t("gr.basedOn", { v: v.based_on })}</span>}
          </>
        )
      }
      footer={
        onRollback ? (
          <>
            {draftV != null && <span className="xs muted grow">{t("gr.rollbackDraft", { v: draftV })}</span>}
            <Btn kind="danger" icon="rollback" label={t("gr.rollbackTo", { v: version })} disabled={draftV != null} onClick={onRollback} testId="gr-version-rollback" />
          </>
        ) : row?.status === "archived" ? (
          <span className="xs muted row">
            <Icon name="lock" /> {t("gm.noPublish")}
          </span>
        ) : undefined
      }
    >
      {error && !v ? (
        <LoadError error={error} onRetry={load} />
      ) : !v ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="stack" data-testid="gr-version-body" data-status={v.status}>
          <dl className="dl">
            <dt>{t("gm.comment")}</dt>
            <dd>{v.comment ?? "—"}</dd>
            <dt>{t("gr.col.activated")}</dt>
            <dd>{v.activated_at ? t("gr.byAt", { n: v.activated_by?.name ?? "—", t: fmt.dateTime(v.activated_at) }) : "—"}</dd>
            <dt>{t("gr.validatedL")}</dt>
            <dd>{v.validated_at ? fmt.dateTime(v.validated_at) : "—"}</dd>
          </dl>
          <section className="stack sm" aria-labelledby="grv-d">
            <h3 className="h3" id="grv-d">
              {active && v.version !== active.version ? t("gr.diffVs", { a: active.version }) : t("gr.isActive")}
            </h3>
            <DiffTable rows={rows} testId="gr-version-diff" />
          </section>
          <div>
            <Btn size="xs" kind="ghost" icon={json ? "eyeOff" : "braces"} label={json ? t("gr.hideJson") : t("gr.showJson")} onClick={() => setJson(!json)} testId="gr-version-json-btn" />
            {json && <JsonView value={v.payload as GameRules} testId="gr-version-json" />}
          </div>
        </div>
      )}
    </Drawer>
  );
}

