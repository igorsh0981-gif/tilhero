/**
 * «Проверка» (content.review, AT-26): the queue of versions under review that are not mine (GET review-queue) and the
 * review screen — field diff against the published version, RU / UZ localisation marks, «Одобрить» (both languages
 * checked) or «Вернуть с заметкой». The author (or an editor) of a version never reviews it: 409 SELF_REVIEW is shown as
 * a plain explanation, and the author sees it before trying.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ContentRow, ContentVersion, ContentVersionMeta } from "@tilhero/contracts/admin";
import type { ContentKind, LocaleCheck } from "@tilhero/contracts/content";
import { Content } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Seg, Spinner } from "../../ui/kit";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { useIssueText } from "./fields";
import { diffPayload, KINDS, type Issue } from "./model";
import { STATUS_TONE } from "./Workspace";

const TAB_OF: Record<ContentKind, string> = { course: "course", module: "course", skill: "course", lesson: "lessons", scenario: "scenarios", rubric: "rubrics", media_asset: "media", media_exercise: "exercises" };

export function ReviewTab({ route }: { route: string | null }) {
  const [kind, key] = (route ?? "").split("/");
  if (kind && key && (KINDS as readonly string[]).includes(kind)) return <ReviewScreen key={`${kind}/${key}`} kind={kind as ContentKind} entityKey={key} />;
  return <ReviewQueue />;
}

function ReviewQueue() {
  const { t, fmt } = useI18n();
  const { navigate } = useNav();
  const [kind, setKind] = useState<ContentKind | "">("");
  const [rows, setRows] = useState<ContentRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(
    async (more?: string | null) => {
      try {
        const r = await Content.reviewQueue(kind, more ?? null);
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [kind],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="panel" aria-labelledby="rq-h" data-testid="review-queue">
      <div className="panel-h">
        <h2 className="panel-t grow" id="rq-h">
          <Icon name="userCheck" /> {t("cr.queue")}
        </h2>
        <Btn size="sm" icon="refresh" label={t("common.refresh")} onClick={() => void load()} />
      </div>
      <div className="panel-b">
        <Seg<ContentKind | ""> label={t("cr.kind")} value={kind} onChange={setKind} items={[{ v: "", label: t("cr.allKinds") }, ...KINDS.map((k) => ({ v: k, label: t(`kind.${k}` as MessageKey) }))]} />
        <p className="xs muted mt-8">{t("cr.queueHint")}</p>
      </div>
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("cr.col.what")}</th>
                <th scope="col">{t("cr.col.kind")}</th>
                <th scope="col">{t("ct.col.version")}</th>
                <th scope="col">{t("cr.col.by")}</th>
                <th scope="col">
                  <span className="sr-only">{t("ct.col.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.kind}/${r.key}`} data-testid={`rv-row-${r.key}`}>
                  <td>
                    <b>{r.title.ru || r.key}</b>
                    <div className="cell-sub mono">{r.key}</div>
                  </td>
                  <td className="small">{t(`kind.${r.kind}` as MessageKey)}</td>
                  <td className="mono">v{r.latest_version}</td>
                  <td className="small">
                    {r.updated_by_name ?? "—"}
                    <div className="cell-sub">{fmt.dateTime(r.updated_at)}</div>
                  </td>
                  <td className="actions-cell">
                    <Btn size="sm" kind="primary" icon="clipboardCheck" label={t("cr.open")} onClick={() => navigate("content", `review/${r.kind}/${r.key}`)} testId={`rv-open-${r.key}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="checkCircle" title={t("cr.empty")} text={t("cr.emptyM")} testId="rv-empty" />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} />
        </div>
      )}
    </section>
  );
}

type DiffFilter = "all" | "ru" | "uz" | "other";

function ReviewScreen({ kind, entityKey }: { kind: ContentKind; entityKey: string }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { me } = useSession();
  const { navigate } = useNav();
  const toast = useToast();
  const issueText = useIssueText();
  const [meta, setMeta] = useState<{ row: ContentRow; versions: ContentVersionMeta[] } | null>(null);
  const [ver, setVer] = useState<ContentVersion | null>(null);
  const [pub, setPub] = useState<ContentVersion | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState<DiffFilter>("all");
  const [checks, setChecks] = useState<{ ru: boolean; uz: boolean }>({ ru: false, uz: false });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [self, setSelf] = useState(false);
  const [issues, setIssues] = useState<Issue[] | null>(null);

  const load = useCallback(async () => {
    try {
      const m = await Content.entity(kind, entityKey);
      setMeta(m);
      const v = m.versions.find((x) => x.status === "in_review");
      setVer(v ? await Content.version(kind, entityKey, v.version) : null);
      setPub(m.row.published_version != null ? await Content.version(kind, entityKey, m.row.published_version) : null);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [kind, entityKey]);
  useEffect(() => {
    void load();
  }, [load]);

  const diff = useMemo(() => (ver ? diffPayload(pub?.payload ?? null, ver.payload) : []), [ver, pub]);
  const shown = diff.filter((d) => filter === "all" || (filter === "other" ? !d.lang : d.lang === filter));
  const mine = !!ver && !!me && ver.author_id === me.staff.staff_id;

  if (error && !meta) return <LoadError error={error} onRetry={() => void load()} />;
  if (!meta) return <Spinner label={t("common.loading")} />;

  const back = () => navigate("content", "review");
  const decide = async (decision: "approve" | "return") => {
    if (!ver) return;
    if (note.trim().length < 3) {
      setErr(t("cr.noteErr"));
      return;
    }
    if (decision === "approve" && !(checks.ru && checks.uz)) {
      setErr(t("cr.checksErr"));
      return;
    }
    setBusy(decision);
    setErr(null);
    const lc = (b: boolean): LocaleCheck => (b ? "checked" : "draft");
    try {
      const v = await Content.review(kind, entityKey, ver.version, { decision, note: note.trim(), locale_checks: { ru: lc(checks.ru), uz: lc(checks.uz) } });
      toast(t(decision === "approve" ? "cr.approved" : "cr.returned", { key: v.key, v: v.version }), "ok", decision === "approve" ? "content.reviewed" : "content.returned");
      back();
    } catch (e) {
      if (e instanceof ApiError && e.code === "SELF_REVIEW") setSelf(true);
      else setErr(errText(i18n, e));
    } finally {
      setBusy(null);
    }
  };
  const check = async () => {
    if (!ver) return;
    setBusy("validate");
    try {
      const r = await Content.validate(kind, entityKey, ver.version);
      // the dry run is in publication mode: the localisation marks are what this review sets
      setIssues(r.errors.filter((x) => x.code !== "LOCALE_NOT_CHECKED").map((x) => ({ path: x.path, code: x.code, message: x.message })));
    } catch (e) {
      setErr(errText(i18n, e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack" data-testid="review-screen">
      <div className="row">
        <Btn size="sm" kind="ghost" icon="chevL" label={t("cr.back")} onClick={back} testId="rv-back" />
        <span className="grow" />
        <Btn size="sm" icon="edit" label={t("cr.toEditor")} onClick={() => navigate("content", `${TAB_OF[kind]}/${entityKey}`)} />
      </div>
      <section className="card stack sm" aria-labelledby="rv-h">
        <div className="crumb">
          {t(`kind.${kind}` as MessageKey)} · <span className="mono">{entityKey}</span>
        </div>
        <h2 className="h2" id="rv-h">
          {meta.row.title.ru || entityKey}
        </h2>
        {!ver ? (
          <Callout icon="info" testId="rv-none">
            {t("cr.noneInReview")}
          </Callout>
        ) : (
          <>
            <p className="small">
              <Pill tone={STATUS_TONE[ver.status]}>
                v{ver.version} · {t(`vst.${ver.status}` as MessageKey)}
              </Pill>{" "}
              {t("cr.by", { n: ver.author_name ?? "—", t: fmt.dateTime(ver.submitted_at ?? ver.created_at) })}
              {pub ? ` · ${t("cr.vsPub", { v: pub.version })}` : ` · ${t("cr.firstVersion")}`}
            </p>
            {(mine || self) && (
              <Callout kind="bad" icon="ban" testId="rv-self">
                <b>{t("err.SELF_REVIEW")}</b> {t("cr.selfM")}
              </Callout>
            )}
          </>
        )}
      </section>

      {ver && (
        <>
          <section className="panel" aria-labelledby="diff-h" data-testid="rv-diff">
            <div className="panel-h">
              <h3 className="panel-t grow" id="diff-h">
                <Icon name="diff" /> {pub ? t("cr.diff", { n: diff.length }) : t("cr.allFields", { n: diff.length })}
              </h3>
              <Seg<DiffFilter>
                label={t("cr.filter")}
                value={filter}
                onChange={setFilter}
                testId="rv-filter"
                items={[
                  { v: "all", label: t("cr.f.all"), cnt: diff.length },
                  { v: "ru", label: "RU", cnt: diff.filter((d) => d.lang === "ru").length },
                  { v: "uz", label: "UZ", cnt: diff.filter((d) => d.lang === "uz").length },
                  { v: "other", label: t("cr.f.other"), cnt: diff.filter((d) => !d.lang).length },
                ]}
              />
            </div>
            {shown.length ? (
              <div className="table-wrap diff-wrap">
                <table className="tbl dense diff">
                  <thead>
                    <tr>
                      <th scope="col">{t("cr.col.field")}</th>
                      <th scope="col">{pub ? t("cr.col.before", { v: pub.version }) : t("cr.col.beforeNone")}</th>
                      <th scope="col">{t("cr.col.after", { v: ver.version })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((d) => (
                      <tr key={d.path} data-testid={`diff-${d.path}`}>
                        <td className="mono xs">{d.path.replace(/^payload\./, "")}</td>
                        <td className={cx("diff-old", d.before == null && "is-none")} lang={d.lang === "uz" ? "uz-Latn" : d.lang === "ru" ? "ru" : "en"}>
                          {d.before ?? "—"}
                        </td>
                        <td className={cx("diff-new", d.after == null && "is-none", d.after === "" && "is-empty")} lang={d.lang === "uz" ? "uz-Latn" : d.lang === "ru" ? "ru" : "en"}>
                          {d.after == null ? "—" : d.after === "" ? t("cr.emptyValue") : d.after}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="panel-b small muted">{t("cr.noDiff")}</p>
            )}
          </section>

          <section className="card stack sm" aria-labelledby="dec-h" data-testid="rv-form">
            <div className="row between">
              <h3 className="h3" id="dec-h">
                {t("cr.decision")}
              </h3>
              <Btn size="sm" icon="clipboardCheck" label={t("cr.check")} busy={busy === "validate"} onClick={() => void check()} testId="rv-validate" />
            </div>
            {issues && (
              <Callout kind={issues.length ? "warn" : "good"} icon={issues.length ? "alert" : "checkCircle"} testId="rv-issues">
                {issues.length ? (
                  <>
                    <b>{t("ct.issues", { n: issues.length })}</b>
                    <ul className="plain-list">
                      {issues.slice(0, 12).map((x, n) => (
                        <li key={n}>
                          {issueText(x)} <span className="mono xs muted">{x.path}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <b>{t("cr.rulesOk")}</b>
                )}
              </Callout>
            )}
            <fieldset className="fs field">
              <legend className="field-label">{t("cr.locales")}</legend>
              <div className="row">
                {(["ru", "uz"] as const).map((l) => (
                  <label key={l} className="check">
                    <input type="checkbox" checked={checks[l]} onChange={(e) => setChecks((c) => ({ ...c, [l]: e.target.checked }))} data-testid={`rv-check-${l}`} />
                    <span>{t("cr.localeChecked", { l: l.toUpperCase() })}</span>
                  </label>
                ))}
              </div>
              <span className="hint">{t("cr.localesHint")}</span>
            </fieldset>
            <div className="field">
              <label htmlFor="rv-note" className="req">
                {t("cr.note")}
              </label>
              <textarea id="rv-note" className="textarea" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("cr.notePh")} data-testid="rv-note" />
            </div>
            <FieldErr msg={err} />
            <div className="acts">
              <Btn kind="primary" icon="check" label={t("cr.approve")} busy={busy === "approve"} disabled={mine || self} onClick={() => void decide("approve")} testId="rv-approve" />
              <Btn icon="rollback" label={t("cr.return")} busy={busy === "return"} disabled={mine || self} onClick={() => void decide("return")} testId="rv-return" />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
