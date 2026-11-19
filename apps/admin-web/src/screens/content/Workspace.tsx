/**
 * Life cycle of one content entity (admin.ts «Контент и диагностика», AT-26/27): status and versions (authors,
 * reviewers, publication), «Создать черновик из опубликованной», «Сохранить» (expected_hash → 409 VERSION_CONFLICT →
 * reload), «Проверить» (validate → issues with «→ к полю»), «Отправить на проверку», review by another methodist,
 * «Опубликовать» (step-up), «Снять с публикации», «Откатить к версии N» (step-up). 422 CONTENT_INVALID {errors} is shown
 * at the fields by `path`. The editor of the kind (lesson, scenario, rubric, media, …) renders the form; buttons follow
 * the permissions of the role (the catalog re-checks every command, with step-up in admin-bff).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ContentRow, ContentValidationError, ContentVersion, ContentVersionMeta } from "@tilhero/contracts/admin";
import type { ContentKind, LocaleCheck, VersionStatus } from "@tilhero/contracts/content";
import type { UiLang } from "@tilhero/contracts/admin";
import { Content } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, FieldErr, Pill, Reveal, Spinner, TabPanel, Tabs, type Tone } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { EdCtx, fieldId, useIssueText } from "./fields";
import { byPath, clone, emptyPayload, ID_RE, KEY_FIELD, langOfPath, missingByLang, pathPrefixes, sameJson, validatePayload, type Issue, type NewCtx } from "./model";
import { useRefs } from "./refs";

export const STATUS_TONE: Record<VersionStatus, Tone> = { draft: "warn", in_review: "info", approved: "accent", published: "good", suspended: "bad", archived: "neutral" };
export const LOCALE_TONE: Record<LocaleCheck, Tone> = { missing: "bad", draft: "warn", checked: "good" };
const OPEN: readonly VersionStatus[] = ["draft", "in_review", "approved"];
const STEPS: readonly VersionStatus[] = ["draft", "in_review", "approved", "published"];

export interface FocusReq {
  path: string;
  n: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPayload = any;

export interface EditorProps<P = AnyPayload> {
  payload: P;
  set: (fn: (p: P) => P) => void;
  ver: ContentVersion<P> | null;
  isNew: boolean;
  dirty: boolean;
  focus: FocusReq | null;
  goTo(path: string): void;
  /** a command of the editor (test run, rights approval) returned a fresher view of this version */
  onVersion(v: ContentVersion<P>): void;
  /** a command of the editor answered 422 CONTENT_INVALID: show its errors at the fields */
  onIssues(xs: Issue[]): void;
}

export interface KindSpec {
  kind: ContentKind;
  Editor: (p: EditorProps) => JSX.Element;
  Preview?: (p: { payload: AnyPayload }) => JSX.Element;
  /** why submit / publish of this version is closed beyond the status (scenario: test run; media: rights) */
  gate?: (ver: ContentVersion, dirty: boolean) => { submit?: MessageKey | null; publish?: MessageKey | null };
}

type Cmd = { kind: "publish"; key: string } | { kind: "archive" } | { kind: "rollback"; to: number };

/** The version to open by default: the open one (draft / in review / approved), else the published, else the newest. */
export function defaultVersion(row: ContentRow, versions: readonly ContentVersionMeta[]): number | null {
  return versions.find((v) => OPEN.includes(v.status))?.version ?? row.published_version ?? versions[0]?.version ?? null;
}

/** Focuses the field of a catalog path (or the closest parent block) inside `root`; read-only fields get tabindex=-1. */
export function focusPath(root: HTMLElement | null, path: string): boolean {
  if (!root) return false;
  for (const p of pathPrefixes(path)) {
    const el = root.querySelector<HTMLElement>(`[data-path="${p.replace(/["\\]/g, "\\$&")}"]`);
    if (!el) continue;
    const focusable = "input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),[tabindex]";
    const target = el.matches(focusable) ? el : (el.querySelector<HTMLElement>(focusable) ?? el);
    if (!target.matches(focusable)) target.setAttribute("tabindex", "-1");
    el.scrollIntoView?.({ block: "center" });
    target.focus({ preventScroll: true });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1400);
    return true;
  }
  return false;
}

export function Workspace({ spec, entityKey, newCtx, onOpen, onChanged, onCancelNew, testId }: { spec: KindSpec; entityKey: string | null; newCtx?: NewCtx; onOpen: (key: string) => void; onChanged?: () => void; onCancelNew?: () => void; testId?: string }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const toast = useToast();
  const { navigate } = useNav();
  const refs = useRefs();
  const kind = spec.kind;
  const isNew = entityKey == null;
  const [meta, setMeta] = useState<{ row: ContentRow; versions: ContentVersionMeta[] } | null>(null);
  const [ver, setVer] = useState<ContentVersion<AnyPayload> | null>(null);
  const [draft, setDraft] = useState<AnyPayload>(() => (isNew ? emptyPayload(kind, "", newCtx) : null));
  const [base, setBase] = useState<AnyPayload>(null);
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [issuesFrom, setIssuesFrom] = useState<"server" | "local" | "validate" | null>(null);
  const [validated, setValidated] = useState<"ok" | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [lang, setLang] = useState<UiLang>("ru");
  const [tab, setTab] = useState<"content" | "preview" | "versions">("content");
  const [focus, setFocus] = useState<FocusReq | null>(null);
  const [cmd, setCmd] = useState<Cmd | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const createKey = useRef(uuid());
  const draftKey = useRef(uuid());
  const focusN = useRef(0);

  const resetIssues = () => {
    setIssues([]);
    setIssuesFrom(null);
    setValidated(null);
    setTried(false);
    setFormErr(null);
  };

  const openVersion = useCallback(
    async (key: string, v: number | null, m?: { row: ContentRow; versions: ContentVersionMeta[] }) => {
      const mm = m ?? (await Content.entity(kind, key));
      setMeta(mm);
      const pick = v ?? defaultVersion(mm.row, mm.versions);
      if (pick == null) return;
      const full = await Content.version(kind, key, pick);
      setVer(full);
      setDraft(clone(full.payload));
      setBase(clone(full.payload));
      setConflict(false);
    },
    [kind],
  );

  const load = useCallback(
    async (v: number | null = null) => {
      if (!entityKey) return;
      try {
        await openVersion(entityKey, v);
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [entityKey, openVersion],
  );

  useEffect(() => {
    resetIssues();
    setTab("content");
    setLang("ru");
    if (entityKey) {
      setMeta(null);
      setVer(null);
      setDraft(null);
      void load();
    } else {
      setMeta(null);
      setVer(null);
      setDraft(emptyPayload(kind, "", newCtx));
      setBase(null);
      setNewKey("");
      createKey.current = uuid();
    }
    // newCtx is read once per new entity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityKey, kind, load]);

  // field focus after the editor switched its own state (language tab, scenario node, …)
  useEffect(() => {
    if (!focus) return;
    const tm = setTimeout(() => focusPath(rootRef.current, focus.path), 90);
    return () => clearTimeout(tm);
  }, [focus]);

  const goTo = useCallback((path: string) => {
    setTab("content");
    const l = langOfPath(path);
    if (l) setLang(l);
    setFocus({ path, n: ++focusN.current });
  }, []);

  const status = ver?.status ?? "draft";
  const editable = can("content.edit") && (isNew || status === "draft");
  const dirty = isNew ? true : draft != null && base != null && !sameJson(draft, base);
  const row = meta?.row ?? null;
  const hasOpen = !!meta?.versions.some((v) => v.status === "draft" || v.status === "in_review");
  const live = useMemo(() => (draft ? validatePayload(kind, draft) : []), [draft, kind]);
  const shown = useMemo(() => {
    const m = byPath(issues);
    if (tried) for (const x of live) if (!(m[x.path] ?? []).some((y) => y.code === x.code)) (m[x.path] ??= []).push(x);
    return m;
  }, [issues, live, tried]);
  const miss = draft ? missingByLang(draft) : { ru: [], uz: [] };
  const gate = ver && spec.gate ? spec.gate(ver, dirty) : {};

  const set = useCallback((fn: (p: AnyPayload) => AnyPayload) => {
    setDraft((d: AnyPayload) => (d == null ? d : fn(d)));
    setValidated(null);
    setFormErr(null);
  }, []);

  const failed = (e: unknown, action: string): string | null => {
    if ((e as ApiError)?.cancelled) return t("stepup.cancelled");
    if (e instanceof ApiError) {
      if (e.code === "CONTENT_INVALID") {
        const errs = (Array.isArray(e.details.errors) ? e.details.errors : []) as ContentValidationError[];
        setIssues(errs.filter((x) => x && typeof x.path === "string").map((x) => ({ path: x.path, code: String(x.code), message: x.message })));
        setIssuesFrom("server");
        setTried(true);
        const first = errs[0]?.path;
        const l = first ? langOfPath(first) : null;
        if (l) setLang(l);
        return t("ct.invalidN", { n: errs.length, a: t(`ct.act.${action}` as MessageKey) });
      }
      if (e.code === "VERSION_CONFLICT") setConflict(true);
      if (e.code === "DRAFT_EXISTS") {
        const v = e.num("version");
        if (v != null && entityKey) void load(v);
      }
    }
    return errText(i, e);
  };

  const after = async (v: ContentVersion<AnyPayload>, msg: MessageKey, audit: string) => {
    toast(t(msg, { v: v.version, key: v.key }), "ok", audit);
    await openVersion(v.key, v.version);
    onChanged?.();
    void refs.reload(kind);
  };

  const save = async () => {
    if (!draft || busy) return;
    setTried(true);
    setFormErr(null);
    if (isNew) {
      const key = newKey.trim();
      if (!ID_RE.test(key)) {
        setFormErr(t("ct.keyErr"));
        goTo(`payload.${KEY_FIELD[kind]}`);
        return;
      }
      setBusy("save");
      try {
        const body = { ...draft, [KEY_FIELD[kind]]: key };
        const v = await Content.create(kind, body, createKey.current);
        toast(t("ct.created", { key }), "ok", "content.version_created");
        onChanged?.();
        void refs.reload(kind);
        onOpen(v.key);
      } catch (e) {
        if (e instanceof ApiError && e.code === "CONTENT_KEY_EXISTS") setFormErr(t("err.CONTENT_KEY_EXISTS"));
        else setFormErr(failed(e, "save"));
      } finally {
        setBusy(null);
      }
      return;
    }
    if (!ver) return;
    setBusy("save");
    try {
      const v = await Content.save(kind, ver.key, ver.version, draft, ver.payload_hash);
      setIssues([]);
      setIssuesFrom(null);
      setTried(false);
      await after(v, "ct.saved", "content.version_updated");
    } catch (e) {
      setFormErr(failed(e, "save"));
    } finally {
      setBusy(null);
    }
  };

  const validate = async () => {
    if (!draft || busy) return;
    setTried(true);
    if (dirty || !ver) {
      // not saved yet: the client checks only (the catalog checks the saved version)
      setIssues(live);
      setIssuesFrom("local");
      setValidated(live.length ? null : "ok");
      return;
    }
    setBusy("validate");
    try {
      const r = await Content.validate(kind, ver.key, ver.version);
      setIssues(r.errors.map((x) => ({ path: x.path, code: x.code, message: x.message })));
      setIssuesFrom("validate");
      setValidated(r.ok ? "ok" : null);
      const l = r.errors[0] ? langOfPath(r.errors[0].path) : null;
      if (l) setLang(l);
    } catch (e) {
      setFormErr(failed(e, "validate"));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!ver || busy) return;
    setBusy("submit");
    setFormErr(null);
    try {
      const v = await Content.submit(kind, ver.key, ver.version);
      resetIssues();
      await after(v, "ct.submitted", "content.submitted");
    } catch (e) {
      setFormErr(failed(e, "submit"));
    } finally {
      setBusy(null);
    }
  };

  const newDraft = async () => {
    if (!entityKey || !meta || busy) return;
    const from = meta.row.published_version ?? ver?.version ?? meta.versions[0]?.version;
    if (from == null) return;
    setBusy("draft");
    try {
      const v = await Content.newDraft(kind, entityKey, from, draftKey.current);
      draftKey.current = uuid();
      resetIssues();
      await after(v, "ct.draftCreated", "content.version_created");
    } catch (e) {
      if (e instanceof ApiError && e.code === "DRAFT_EXISTS") toast(t("ct.draftExists", { v: e.num("version") ?? "?" }), "info", "409 DRAFT_EXISTS");
      else setFormErr(failed(e, "draft"));
    } finally {
      setBusy(null);
    }
  };

  if (error && !meta) return <LoadError error={error} onRetry={() => void load()} />;
  if (!isNew && (!meta || !ver || draft == null)) return <Spinner label={t("common.loading")} />;

  const key = isNew ? newKey : (ver?.key ?? "");
  const titleText = (draft?.title?.ru as string | undefined) || key || t("ct.untitled");
  const stepIdx = STEPS.indexOf(status);
  const Editor = spec.Editor;
  const Preview = spec.Preview;
  const canRollback = (m: ContentVersionMeta) => m.status === "archived" && !!m.published_at && can("content.publish");
  const issueList = issues.length ? issues : [];

  return (
    <section className="card ws" ref={rootRef} aria-labelledby={`ws-h-${kind}`} data-testid={testId ?? `ws-${kind}`} data-status={isNew ? "new" : status} data-version={ver?.version ?? 0}>
      <div className="ws-h">
        <div className="grow">
          <div className="crumb">
            {t(`kind.${kind}` as MessageKey)}
            {key && (
              <>
                {" · "}
                <span className="mono">{key}</span>
              </>
            )}
          </div>
          <h2 className="h2 wrap-any" id={`ws-h-${kind}`}>
            {isNew ? t("ct.newT", { k: t(`kind.${kind}` as MessageKey) }) : titleText}
          </h2>
        </div>
        <div className="ws-pills">
          {!isNew && ver && (
            <Pill tone={STATUS_TONE[status]} testId="ws-status">
              v{ver.version} · {t(`vst.${status}` as MessageKey)}
            </Pill>
          )}
          {row?.published_version != null && row.published_version !== ver?.version && (
            <Pill tone="good" dot={false} testId="ws-published">
              {t("ct.pubV", { v: row.published_version })}
            </Pill>
          )}
          {dirty && !isNew && <Pill tone="info">{t("ct.unsaved")}</Pill>}
        </div>
      </div>

      {!isNew && (
        <ol className="stepper" aria-label={t("ct.lifecycle")} data-testid="ws-stepper">
          {STEPS.map((s, n) => (
            <li key={s} className={cx("sp", n < stepIdx && "done", n === stepIdx && "on")} aria-current={n === stepIdx ? "step" : undefined}>
              {t(`vst.${s}` as MessageKey)}
            </li>
          ))}
          {(status === "archived" || status === "suspended") && <li className={cx("sp", "on", status === "suspended" && "bad")} aria-current="step">{t(`vst.${status}` as MessageKey)}</li>}
        </ol>
      )}

      {ver && (
        <div className="ws-checks" data-path="locale_checks">
          {(["ru", "uz"] as const).map((l) => (
            <span key={l} className="row nowrap-row small" data-testid={`ws-locale-${l}`}>
              <span className="muted">{t("ct.locale", { l: l.toUpperCase() })}</span>
              <Pill tone={LOCALE_TONE[ver.locale_checks[l]]}>{t(`lc.${ver.locale_checks[l]}` as MessageKey)}</Pill>
            </span>
          ))}
          {ver.author_name && <span className="small muted">{t("ct.authorX", { n: ver.author_name, t: fmt.dateTime(ver.created_at) })}</span>}
          {ver.reviewer_name && <span className="small muted">{t("ct.reviewerX", { n: ver.reviewer_name, t: fmt.dateTime(ver.reviewed_at) })}</span>}
        </div>
      )}

      {conflict && (
        <Reveal dep={conflict}>
          <Callout kind="warn" icon="alert" testId="ws-conflict">
            <b>{t("ct.conflict")}</b> <Btn size="xs" icon="refresh" label={t("ct.reload")} onClick={() => void load(ver?.version ?? null)} testId="ws-reload" />
          </Callout>
        </Reveal>
      )}
      {ver?.review_note && status === "draft" && (
        <Callout kind="warn" icon="note" testId="ws-returned">
          <b>{t("ct.returned", { n: ver.reviewer_name ?? "—" })}</b> <span className="wrap-any">{ver.review_note}</span>
        </Callout>
      )}
      {status === "suspended" && ver && (
        <Callout kind="bad" icon="ban" testId="ws-suspended">
          <b>{t("ct.suspendedT")}</b> {t(ver.suspend_reason === "rights_revoked" ? "ct.suspendedRevoked" : "ct.suspendedExpired", { t: fmt.dateTime(ver.suspended_at) })}
        </Callout>
      )}
      {!isNew && !editable && ver && (
        <Callout icon="lock" testId="ws-readonly">
          {status === "draft" ? t("ct.roNoEdit") : t(`ct.ro.${status}` as MessageKey)}
        </Callout>
      )}

      {actions()}
      <FieldErr msg={formErr} />

      {(issuesFrom || validated) && (
        <IssuesPanel issues={issueList} from={issuesFrom} ok={validated === "ok"} onGo={goTo} onClose={() => (setIssues([]), setIssuesFrom(null), setValidated(null))} />
      )}

      <Tabs
        id={`ws-${kind}`}
        label={t("ct.wsTabs")}
        value={tab}
        onChange={setTab}
        items={[
          { v: "content", label: t("ct.tab.content"), testId: "ws-tab-content" },
          ...(Preview ? [{ v: "preview" as const, label: t("ct.tab.preview"), testId: "ws-tab-preview" }] : []),
          ...(!isNew ? [{ v: "versions" as const, label: t("ct.tab.versions"), cnt: meta?.versions.length ?? null, testId: "ws-tab-versions" }] : []),
        ]}
      />
      <TabPanel id={`ws-${kind}`} value={tab}>
        {tab === "content" && draft != null && (
          <EdCtx.Provider value={{ lang, editable, issues: shown, tried }}>
            <div className="ws-langbar">
              <Tabs<UiLang>
                id={`ws-lang-${kind}`}
                label={t("ct.langTabs")}
                value={lang}
                onChange={setLang}
                className="lang-tabs"
                items={[
                  { v: "ru", label: t("ulang.ru"), cnt: miss.ru.length || null, bad: true, testId: "ws-lang-ru" },
                  { v: "uz", label: t("ulang.uz"), cnt: miss.uz.length || null, bad: true, testId: "ws-lang-uz" },
                ]}
              />
              <span className="xs muted">{t("ct.langHint")}</span>
            </div>
            {isNew && (
              <div className="field key-field" data-path={`payload.${KEY_FIELD[kind]}`}>
                <label htmlFor={fieldId(`payload.${KEY_FIELD[kind]}`)} className="req">
                  {t("ct.key")}
                </label>
                <input
                  id={fieldId(`payload.${KEY_FIELD[kind]}`)}
                  className={cx("input mono", tried && !ID_RE.test(newKey.trim()) && "is-invalid")}
                  value={newKey}
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="ws-key-hint"
                  onChange={(e) => setNewKey(e.target.value.toLowerCase())}
                  data-testid="ws-key"
                />
                <span className="hint" id="ws-key-hint">
                  {t("ct.keyHint")}
                </span>
              </div>
            )}
            <Editor
              payload={draft}
              set={set}
              ver={ver}
              isNew={isNew}
              dirty={dirty}
              focus={focus}
              goTo={goTo}
              onVersion={(v) => {
                setVer(v);
                void Content.entity(kind, v.key).then(setMeta, () => undefined);
              }}
              onIssues={(xs) => {
                setIssues(xs);
                setIssuesFrom("server");
                setTried(true);
                const l = xs[0] ? langOfPath(xs[0].path) : null;
                if (l) setLang(l);
              }}
            />
          </EdCtx.Provider>
        )}
        {tab === "preview" && Preview && draft != null && <Preview payload={draft} />}
        {tab === "versions" && meta && (
          <VersionsTable versions={meta.versions} current={ver?.version ?? null} published={meta.row.published_version} onOpen={(v) => void load(v)} onRollback={canRollback} rollback={(v) => setCmd({ kind: "rollback", to: v })} />
        )}
      </TabPanel>

      {cmd && ver && (
        <ConfirmCommand
          title={cmd.kind === "publish" ? t("ct.publishT", { key: ver.key, v: ver.version }) : cmd.kind === "archive" ? t("ct.archiveT", { key: ver.key }) : t("ct.rollbackT", { key: ver.key, v: cmd.to })}
          text={cmd.kind === "publish" ? t("ct.publishM") : cmd.kind === "archive" ? t("ct.archiveM") : t("ct.rollbackM", { cur: row?.published_version ?? "—" })}
          icon={cmd.kind === "archive" ? "power" : cmd.kind === "rollback" ? "rollback" : "send"}
          tone={cmd.kind === "archive" ? "bad" : "warn"}
          ok={cmd.kind === "publish" ? t("ct.publish") : cmd.kind === "archive" ? t("ct.archive") : t("ct.rollbackOk", { v: cmd.kind === "rollback" ? cmd.to : 0 })}
          okKind={cmd.kind === "archive" ? "danger" : "primary"}
          extra={
            <Callout kind="info" icon="smartphoneKey">
              {t("ct.stepUpNote")}
            </Callout>
          }
          testId="ws-confirm"
          onClose={() => setCmd(null)}
          onConfirm={async (reason) => {
            try {
              if (cmd.kind === "publish") {
                const v = await Content.publish(kind, ver.key, ver.version, reason, cmd.key);
                resetIssues();
                await after(v, "ct.published", "content.published");
              } else if (cmd.kind === "archive") {
                await Content.archive(kind, ver.key, reason);
                toast(t("ct.archived", { key: ver.key }), "ok", "content.archived");
                await openVersion(ver.key, null);
                onChanged?.();
                void refs.reload(kind);
              } else {
                const v = await Content.rollback(kind, ver.key, cmd.to, reason);
                resetIssues();
                await after(v, "ct.rolledBack", "content.rolled_back");
                setTab("versions");
              }
              return null;
            } catch (e) {
              if (e instanceof ApiError && e.code === "CONTENT_IN_USE") {
                const refsIn = (Array.isArray(e.details.refs) ? e.details.refs : []) as Array<{ kind: string; key: string }>;
                return `${t("err.CONTENT_IN_USE")} ${refsIn.map((r) => `${r.kind}:${r.key}`).join(", ")}`;
              }
              return failed(e, cmd.kind);
            }
          }}
        />
      )}
    </section>
  );

  /* ------------------------------------------------------------ action bar (a render helper, not a component: no remount) */
  function actions() {
    const notes: ReactNode[] = [];
    const buttons: ReactNode[] = [];
    if (isNew) {
      buttons.push(<Btn key="save" kind="primary" icon="check" label={t("ct.create")} busy={busy === "save"} onClick={() => void save()} perm="content.edit" testId="ws-save" />);
      buttons.push(<Btn key="check" icon="clipboardCheck" label={t("ct.validate")} onClick={() => void validate()} testId="ws-validate" />);
      if (onCancelNew) buttons.push(<Btn key="cancel" kind="ghost" label={t("common.cancel")} onClick={onCancelNew} />);
      return <div className="acts ws-acts" data-testid="ws-actions">{buttons}</div>;
    }
    if (!ver || !meta) return null;
    if (status === "draft") {
      if (can("content.edit")) buttons.push(<Btn key="save" kind={dirty ? "primary" : ""} icon="check" label={t("ct.save")} busy={busy === "save"} disabled={!dirty} onClick={() => void save()} testId="ws-save" />);
      buttons.push(<Btn key="check" icon="clipboardCheck" label={t("ct.validate")} busy={busy === "validate"} onClick={() => void validate()} testId="ws-validate" />);
      if (can("content.edit")) {
        const why = dirty ? "ct.gate.saveFirst" : (gate.submit ?? null);
        buttons.push(<Btn key="submit" kind={!dirty && !why ? "primary" : ""} icon="send" label={t("ct.submit")} busy={busy === "submit"} disabled={!!why} title={why ? t(why) : undefined} onClick={() => void submit()} testId="ws-submit" />);
        if (why) notes.push(<span key="n-sub" data-testid="ws-gate-submit">{t(why)}</span>);
      }
    }
    if (status === "in_review") {
      if (can("content.review")) buttons.push(<Btn key="review" kind="primary" icon="clipboardCheck" label={t("ct.goReview")} onClick={() => navigate("content", `review/${kind}/${ver.key}`)} testId="ws-go-review" />);
      else notes.push(<span key="n-rev">{t("ct.waitReview")}</span>);
    }
    if (status === "approved") {
      if (can("content.publish")) {
        const why = gate.publish ?? null;
        buttons.push(<Btn key="pub" kind="primary" icon="send" label={t("ct.publish")} disabled={!!why} title={why ? t(why) : undefined} onClick={() => setCmd({ kind: "publish", key: uuid() })} testId="ws-publish" />);
        if (why) notes.push(<span key="n-pub" data-testid="ws-gate-publish">{t(why)}</span>);
      } else
        notes.push(
          <span key="n-nopub" data-testid="ws-no-publish">
            {t("ct.noPublish", { p: "content.publish" })}
          </span>,
        );
    }
    if (!hasOpen && can("content.edit") && (row?.published_version != null || OPEN.includes(status) === false))
      buttons.push(<Btn key="draft" icon="copy" label={row?.published_version != null ? t("ct.newDraft") : t("ct.newDraftFrom", { v: ver.version })} busy={busy === "draft"} onClick={() => void newDraft()} testId="ws-new-draft" />);
    if (row?.published_version != null && can("content.publish"))
      buttons.push(<Btn key="arch" kind="danger-ghost" icon="power" label={t("ct.archive")} onClick={() => setCmd({ kind: "archive" })} testId="ws-archive" />);
    return (
      <>
        <div className="acts ws-acts" data-testid="ws-actions">
          {buttons}
        </div>
        {notes.length > 0 && (
          <p className="xs muted row ws-notes">
            <Icon name="lock" /> {notes}
          </p>
        )}
      </>
    );
  }
}

/* ---------------------------------------------------------------- issues */

export function IssuesPanel({ issues, from, ok, onGo, onClose }: { issues: Issue[]; from: "server" | "local" | "validate" | null; ok: boolean; onGo: (path: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const text = useIssueText();
  if (ok && !issues.length)
    return (
      <Callout kind="good" icon="checkCircle" testId="ws-valid">
        <b>{t(from === "local" ? "ct.validLocal" : "ct.valid")}</b>
      </Callout>
    );
  if (!issues.length) return null;
  return (
    <section className="issues-panel" aria-labelledby="iss-h" data-testid="ws-issues">
      <div className="row between">
        <h3 className="h3" id="iss-h">
          <Icon name="alertCircle" /> {t(from === "local" ? "ct.issuesLocal" : "ct.issues", { n: issues.length })}
        </h3>
        <Btn size="xs" kind="ghost" icon="x" aria={t("common.close")} onClick={onClose} />
      </div>
      <ul className="issue-list">
        {issues.slice(0, 60).map((x, n) => (
          <li key={`${x.path}-${x.code}-${n}`} data-testid={`issue-${x.code}`}>
            <span className="grow">
              <span className="b">{text(x)}</span>
              <span className="mono xs muted block">{x.path}</span>
            </span>
            <Btn size="xs" icon="right" label={t("ct.toField")} onClick={() => onGo(x.path)} testId={`go-${x.path}`} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------------------------------------------------------- versions */

function VersionsTable({ versions, current, published, onOpen, onRollback, rollback }: { versions: ContentVersionMeta[]; current: number | null; published: number | null; onOpen: (v: number) => void; onRollback: (m: ContentVersionMeta) => boolean; rollback: (v: number) => void }) {
  const { t, fmt } = useI18n();
  return (
    <div className="table-wrap" data-testid="ws-versions">
      <table className="tbl compact">
        <caption className="sr-only">{t("ct.tab.versions")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("ct.col.version")}</th>
            <th scope="col">{t("col.status")}</th>
            <th scope="col">{t("ct.col.author")}</th>
            <th scope="col">{t("ct.col.review")}</th>
            <th scope="col">{t("ct.col.published")}</th>
            <th scope="col" className="r">
              <span className="sr-only">{t("ct.col.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {versions.map((m) => (
            <tr key={m.version} className={m.version === current ? "is-sel" : undefined} data-testid={`ver-row-${m.version}`}>
              <td className="mono">
                v{m.version}
                {m.version === published && <span className="xs muted block">{t("ct.live")}</span>}
              </td>
              <td>
                <Pill tone={STATUS_TONE[m.status]}>{t(`vst.${m.status}` as MessageKey)}</Pill>
              </td>
              <td className="small">
                {m.author_name ?? "—"}
                <div className="cell-sub">{fmt.dateTime(m.created_at)}</div>
              </td>
              <td className="small">
                {m.reviewer_name ? (
                  <>
                    {m.reviewer_name}
                    <div className="cell-sub wrap-any">{m.review_note ?? ""}</div>
                  </>
                ) : (
                  "—"
                )}
                {m.rights_approved_by_name && <div className="cell-sub">{t("ct.rightsBy", { n: m.rights_approved_by_name })}</div>}
              </td>
              <td className="small">
                {m.published_at ? (
                  <>
                    {m.published_by_name ?? "—"}
                    <div className="cell-sub">{fmt.dateTime(m.published_at)}</div>
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className="actions-cell">
                {m.version !== current && <Btn size="xs" label={t("ct.open")} onClick={() => onOpen(m.version)} testId={`ver-open-${m.version}`} />}
                {onRollback(m) && <Btn size="xs" icon="rollback" label={t("ct.rollbackTo", { v: m.version })} onClick={() => rollback(m.version)} testId={`ver-rollback-${m.version}`} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="xs muted mt-8">{t("ct.versionsNote")}</p>
    </div>
  );
}
