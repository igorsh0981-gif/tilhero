/**
 * Golden cases of an agent (ADM-AGENT-03): the list (title, mandatory, audience, checks) and the case editor
 * (ai.manage): title, mandatory, audience, the input context as JSON and the check builder of ai.ts GoldenCheck —
 * schema_valid · field_equals {path, typed value} · field_in {path, values} · field_absent {path} · text_not_contains
 * {path, values} · max_length {path, n}. Removing a case archives it (the ai-gateway keeps it for old runs).
 */
import { useEffect, useRef, useState } from "react";
import type { GoldenCase, GoldenCaseInput } from "@tilhero/contracts/admin";
import type { AgentId, AgentContext, GoldenCheck } from "@tilhero/contracts/ai";
import type { AudienceSegment } from "@tilhero/contracts/content";
import { Ai } from "../../api/endpoints";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { Btn, Callout, cx, Empty, FieldErr, IconBtn, Pill, Select, Spinner, Switch } from "../../ui/kit";
import { Drawer, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { buildCheck, CHECK_KINDS, checkContextJson, checkLine, draftOf, emptyCheck, needsPath, prettyJson, type CheckDraft, type CheckIssue, type ValueType } from "./model";

const AUDS: readonly AudienceSegment[] = ["adults", "teens", "kids"];
const VALUE_TYPES: readonly ValueType[] = ["string", "number", "boolean", "null"];

export function GoldenTab({ agentId, cases, reload, openId, onOpened }: { agentId: AgentId; cases: GoldenCase[] | null; reload: () => void; openId: string | null; onOpened: () => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const toast = useToast();
  const [edit, setEdit] = useState<GoldenCase | "new" | null>(null);
  const [archive, setArchive] = useState<GoldenCase | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    if (!openId || !cases) return;
    const c = cases.find((x) => x.case_id === openId);
    if (c) setEdit(c);
    onOpened();
  }, [openId, cases, onOpened]);
  if (!cases) return <Spinner label={t("common.loading")} />;
  const active = cases.filter((c) => !c.archived_at);
  const archived = cases.filter((c) => c.archived_at);
  const shown = showArchived ? cases : active;
  const manage = can("ai.manage");
  return (
    <section className="panel" aria-labelledby="gc-h" data-testid="gc-list">
      <div className="panel-h">
        <h3 className="panel-t grow" id="gc-h">
          <Icon name="clipboardCheck" /> {t("gc.title", { n: active.length, m: active.filter((c) => c.mandatory).length })}
        </h3>
        {archived.length > 0 && <Switch id="gc-arch" checked={showArchived} onChange={setShowArchived} label={t("gc.showArchived", { n: archived.length })} />}
        {manage && <Btn size="sm" kind="primary" icon="plus" label={t("gc.add")} onClick={() => setEdit("new")} testId="gc-add" />}
      </div>
      {shown.length ? (
        <ul className="gc-rows">
          {shown.map((c) => (
            <li key={c.case_id} className={cx("gc-row", c.archived_at && "is-dim")} data-testid={`gc-${c.case_id}`}>
              <div className="grow">
                <button type="button" className="tr" onClick={() => setEdit(c)} data-testid={`gc-open-${c.case_id}`}>
                  {c.title}
                </button>
                <span className="row gc-meta">
                  {c.mandatory ? <Pill tone="info" dot={false}>{t("gc.mandatory")}</Pill> : <Pill dot={false}>{t("gc.optional")}</Pill>}
                  <span className="tag plain">{t(`ageseg.${c.input.audience}`)}</span>
                  {c.archived_at && <Pill tone="neutral">{t("gc.archivedAt", { t: fmt.date(c.archived_at) })}</Pill>}
                </span>
                <span className="gc-checks">
                  {c.checks.map((x, n) => (
                    <code key={n} className="code-chip">
                      {checkLine(x)}
                    </code>
                  ))}
                </span>
              </div>
              {manage && !c.archived_at && <IconBtn icon="x" label={t("gc.archiveA", { x: c.title })} className="sm" onClick={() => setArchive(c)} testId={`gc-archive-${c.case_id}`} />}
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon="clipboardCheck" title={t("gc.empty")} text={t("gc.emptyM")} />
      )}
      <div className="panel-f">
        <Icon name="info" /> {t("gc.note")}
      </div>
      {edit && (
        <CaseEditor
          agentId={agentId}
          value={edit === "new" ? null : edit}
          readOnly={!manage || (edit !== "new" && !!edit.archived_at)}
          onClose={() => setEdit(null)}
          onSaved={(c, created) => {
            toast(t(created ? "gc.created" : "gc.saved", { x: c.title }), "ok", created ? "ai.golden_case_created" : "ai.golden_case_updated");
            setEdit(null);
            reload();
          }}
        />
      )}
      {archive && (
        <Modal
          title={t("gc.archiveT", { x: archive.title })}
          text={t("gc.archiveM")}
          icon="x"
          tone="warn"
          onClose={() => setArchive(null)}
          testId="gc-archive-dialog"
          footer={
            <>
              <Btn label={t("common.cancel")} onClick={() => setArchive(null)} />
              <Btn
                kind="danger"
                label={t("gc.archive")}
                testId="gc-archive-ok"
                onClick={async () => {
                  try {
                    await Ai.archiveCase(archive.case_id);
                    toast(t("gc.archived", { x: archive.title }), "ok", "ai.golden_case_archived");
                    reload();
                  } catch (e) {
                    toast(errText(i, e), "err");
                  }
                  setArchive(null);
                }}
              />
            </>
          }
        />
      )}
    </section>
  );
}

function CaseEditor({ agentId, value, readOnly, onClose, onSaved }: { agentId: AgentId; value: GoldenCase | null; readOnly: boolean; onClose: () => void; onSaved: (c: GoldenCase, created: boolean) => void }) {
  const i = useI18n();
  const { t } = i;
  const [title, setTitle] = useState(value?.title ?? "");
  const [mandatory, setMandatory] = useState(value?.mandatory ?? true);
  const [aud, setAud] = useState<AudienceSegment>(value?.input.audience ?? "adults");
  const [ctx, setCtx] = useState(value ? prettyJson(value.input.context) : "{\n  \n}");
  const [checks, setChecks] = useState<CheckDraft[]>(value ? value.checks.map(draftOf) : [emptyCheck("schema_valid")]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(uuid());
  const ctxCheck = checkContextJson(ctx);
  const built = checks.map(buildCheck);
  const titleErr = !title.trim() ? "required" : title.length > 120 ? "too_long" : null;
  const ctxErr = ctxCheck.error ? t(`gcf.ctx.${ctxCheck.error.code}` as MessageKey, { line: ctxCheck.error.line ?? 0, col: ctxCheck.error.col ?? 0 }) : null;
  const bad = !!titleErr || !!ctxErr || !checks.length || built.some((b) => b.issues.length);
  const setCheck = (n: number, fn: (d: CheckDraft) => CheckDraft) => setChecks((xs) => xs.map((x, k) => (k === n ? fn(x) : x)));
  const save = async () => {
    setTried(true);
    if (bad || busy || readOnly) {
      if (bad) setErr(t("gcf.fix"));
      return;
    }
    setBusy(true);
    setErr(null);
    const body: GoldenCaseInput = {
      title: title.trim(),
      mandatory,
      input: { audience: aud, context: ctxCheck.value as unknown as AgentContext },
      checks: built.map((b) => b.check!) as GoldenCheck[],
    };
    try {
      const c = value ? await Ai.updateCase(value.case_id, body) : await Ai.createCase(agentId, body, key.current);
      onSaved(c, !value);
    } catch (e) {
      setErr(errText(i, e));
      setBusy(false);
    }
  };
  const issueText = (x: CheckIssue) => t(`gcf.${x.field}.${x.code}` as MessageKey);
  return (
    <Drawer
      wide
      title={value ? value.title : t("gc.newT")}
      sub={<span className="mono">{agentId}</span>}
      onClose={onClose}
      testId="gc-editor"
      footer={
        readOnly ? (
          <Btn label={t("common.close")} onClick={onClose} />
        ) : (
          <>
            <Btn label={t("common.cancel")} onClick={onClose} />
            <span className="grow" />
            <Btn kind="primary" icon="check" label={value ? t("common.save") : t("gc.create")} busy={busy} onClick={() => void save()} testId="gc-save" />
          </>
        )
      }
    >
      <div className="stack sm">
        {readOnly && (
          <Callout icon="lock" testId="gc-readonly">
            {value?.archived_at ? t("gc.roArchived") : t("ag.noManage")}
          </Callout>
        )}
        <div className="field">
          <label htmlFor="gc-title" className="req">
            {t("gcf.title")}
          </label>
          <input id="gc-title" className={cx("input", tried && titleErr && "is-invalid")} value={title} maxLength={140} readOnly={readOnly} onChange={(e) => setTitle(e.target.value)} data-testid="gc-title" />
          <FieldErr msg={tried && titleErr ? t(`gcf.title.${titleErr}` as MessageKey) : null} />
        </div>
        <div className="row">
          <Switch id="gc-mand" checked={mandatory} disabled={readOnly} onChange={setMandatory} label={t("gcf.mandatory")} />
          <span className="xs muted">{t("gcf.mandatoryH")}</span>
        </div>
        <div className="field" style={{ maxWidth: 280 }}>
          <label htmlFor="gc-aud">{t("gcf.audience")}</label>
          <Select<AudienceSegment> id="gc-aud" label={t("gcf.audience")} value={aud} disabled={readOnly} onChange={setAud} options={AUDS.map((a) => ({ v: a, label: t(`ageseg.${a}`) }))} testId="gc-aud" />
          {aud === "kids" && <span className="hint">{t("gcf.kidsH")}</span>}
        </div>
        <div className="field">
          <label htmlFor="gc-ctx" className="req">
            {t("gcf.context")}
          </label>
          <textarea id="gc-ctx" className={cx("textarea mono-text", ctxErr && "is-invalid")} rows={10} value={ctx} readOnly={readOnly} spellCheck={false} onChange={(e) => setCtx(e.target.value)} aria-invalid={!!ctxErr} aria-describedby="gc-ctx-h" data-testid="gc-ctx" />
          <span className="hint" id="gc-ctx-h">
            {t("gcf.contextH")}
          </span>
          <FieldErr msg={ctxErr} />
        </div>
        <fieldset className="gc-builder" data-testid="gc-builder">
          <legend className="field-label">{t("gcf.checks", { n: checks.length })}</legend>
          {checks.map((d, n) => {
            const iss = tried || d.path || d.values || d.value ? built[n]!.issues : [];
            const f = (field: CheckIssue["field"]) => iss.filter((x) => x.field === field).map(issueText).join(" · ") || null;
            const idp = `gck-${n}`;
            return (
              <div key={n} className="gc-check" data-testid={`gck-${n}`} data-kind={d.kind}>
                <div className="gc-check-row">
                  <span className="idx">{n + 1}</span>
                  <div className="field gc-kind">
                    <label htmlFor={`${idp}-kind`} className="sr-only">
                      {t("gcf.kind")}
                    </label>
                    <Select<GoldenCheck["kind"]>
                      id={`${idp}-kind`}
                      label={t("gcf.kind")}
                      value={d.kind}
                      disabled={readOnly}
                      onChange={(k) => setCheck(n, (x) => ({ ...emptyCheck(k), path: needsPath(k) ? x.path : "" }))}
                      options={CHECK_KINDS.map((k) => ({ v: k, label: t(`gck.${k}`) }))}
                      testId={`${idp}-kind`}
                    />
                  </div>
                  {needsPath(d.kind) && (
                    <div className="field gc-path">
                      <label htmlFor={`${idp}-path`} className="sr-only">
                        {t("gcf.path")}
                      </label>
                      <input id={`${idp}-path`} className={cx("input mono", f("path") && "is-invalid")} placeholder={t("gcf.pathPh")} value={d.path} readOnly={readOnly} spellCheck={false} aria-label={t("gcf.path")} onChange={(e) => setCheck(n, (x) => ({ ...x, path: e.target.value }))} data-testid={`${idp}-path`} />
                    </div>
                  )}
                  {!readOnly && <IconBtn icon="x" className="sm" label={t("gcf.remove", { n: n + 1 })} onClick={() => setChecks((xs) => xs.filter((_, k) => k !== n))} testId={`${idp}-remove`} />}
                </div>
                <span className="xs muted">{t(`gck.h.${d.kind}`)}</span>
                {d.kind === "field_equals" && (
                  <div className="gc-check-row">
                    <Select<ValueType> id={`${idp}-vt`} label={t("gcf.valueType")} value={d.valueType} disabled={readOnly} onChange={(vt) => setCheck(n, (x) => ({ ...x, valueType: vt, value: vt === "boolean" ? "true" : vt === "null" ? "" : x.value }))} options={VALUE_TYPES.map((v) => ({ v, label: t(`gcf.vt.${v}`) }))} testId={`${idp}-vt`} />
                    {d.valueType === "boolean" ? (
                      <Select<string> id={`${idp}-value`} label={t("gcf.value")} value={d.value} disabled={readOnly} onChange={(v) => setCheck(n, (x) => ({ ...x, value: v }))} options={[{ v: "true", label: "true" }, { v: "false", label: "false" }]} testId={`${idp}-value`} />
                    ) : d.valueType !== "null" ? (
                      <input id={`${idp}-value`} className={cx("input mono", f("value") && "is-invalid")} aria-label={t("gcf.value")} value={d.value} readOnly={readOnly} inputMode={d.valueType === "number" ? "decimal" : undefined} onChange={(e) => setCheck(n, (x) => ({ ...x, value: e.target.value }))} data-testid={`${idp}-value`} />
                    ) : (
                      <span className="mono small">null</span>
                    )}
                  </div>
                )}
                {(d.kind === "field_in" || d.kind === "text_not_contains") && (
                  <div className="field">
                    <label htmlFor={`${idp}-values`} className="xs">
                      {t(d.kind === "field_in" ? "gcf.valuesIn" : "gcf.valuesNot")}
                    </label>
                    <textarea id={`${idp}-values`} className={cx("textarea mono-text", f("values") && "is-invalid")} rows={3} value={d.values} readOnly={readOnly} onChange={(e) => setCheck(n, (x) => ({ ...x, values: e.target.value }))} data-testid={`${idp}-values`} />
                  </div>
                )}
                {d.kind === "max_length" && (
                  <div className="field num-field">
                    <label htmlFor={`${idp}-n`} className="xs">
                      {t("gcf.n")}
                    </label>
                    <input id={`${idp}-n`} className={cx("input num", f("n") && "is-invalid")} inputMode="numeric" value={d.n} readOnly={readOnly} onChange={(e) => setCheck(n, (x) => ({ ...x, n: e.target.value }))} data-testid={`${idp}-n`} />
                  </div>
                )}
                <FieldErr msg={[f("path"), f("value"), f("values"), f("n")].filter(Boolean).join(" · ") || null} />
                {built[n]!.check && <code className="code-chip gc-preview">{checkLine(built[n]!.check!)}</code>}
              </div>
            );
          })}
          {!checks.length && <FieldErr msg={t("gcf.noChecks")} />}
          {!readOnly && <Btn size="sm" icon="plus" label={t("gcf.addCheck")} onClick={() => setChecks((xs) => [...xs, emptyCheck("field_in")])} testId="gc-add-check" />}
        </fieldset>
        <FieldErr msg={err} />
      </div>
    </Drawer>
  );
}
