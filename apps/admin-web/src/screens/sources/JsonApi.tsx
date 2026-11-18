import { useRef, useState } from "react";
import type { SourceJsonApiPreview } from "@tilhero/contracts/admin";
import { SourcesApi } from "../../api/endpoints";
import { useI18n, type MessageKey } from "../../i18n";
import { Btn, Callout, FieldErr } from "../../ui/kit";
import { errMeta, errText } from "../../ui/errors";
import { crawlCodeHint, crawlCodeLabel, skipReasonLabel } from "../catalog/common";
import { jsonApiTemplate, parseJsonApi } from "./validate";

/**
 * Fix 9.3: mapping editor of a «JSON API» listing page (SPA sites with an open JSON API, no Claude). The mapping is
 * edited as JSON text — paths are free-form and an operator copies them from «Check»; the registry validates it
 * strictly on save. «Check» sends the unsaved form to admin-bff → provider-gateway: the first API page, nothing stored.
 */
export interface JsonApiContext {
  /** saved source: admin-bff takes its domains from the registry (other domains in the form → fresh step-up) */
  sourceId?: string;
  country: string;
  eventDomains: string[];
  mediaDomains: string[];
  city: string;
  category: string;
}

type Result = { kind: "ok"; data: SourceJsonApiPreview } | { kind: "err"; text: string; meta?: string };

/** "2026-11-05" + "18:00" → local date of the source country as the operator reads it (no time-zone shift). */
function whenLabel(fmtDate: (iso: string) => string, date: string, time: string | null): string {
  const d = fmtDate(`${date}T12:00:00`);
  return time ? `${d} ${time}` : d;
}

const linkHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};
/** path + query of an event link (the host is shown below it) */
const linkPath = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
};

export function JsonApiEditor({
  idx,
  value,
  onChange,
  error,
  ctx,
  readOnly,
}: {
  idx: number;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  ctx: JsonApiContext;
  readOnly: boolean;
}) {
  const i = useI18n();
  const { t, tp, fmt } = i;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const req = useRef(0);
  const id = `sf-api-${idx}`;
  const parsed = parseJsonApi(value);

  const check = async () => {
    if (!parsed || busy) return;
    const n = ++req.current;
    setBusy(true);
    try {
      const data = await SourcesApi.previewJsonApi({
        ...(ctx.sourceId ? { source_id: ctx.sourceId } : {}),
        country_code: ctx.country,
        event_domains: ctx.eventDomains,
        media_domains: ctx.mediaDomains,
        city: ctx.city.trim() || null,
        category: ctx.category || null,
        json_api: parsed,
      });
      if (n === req.current) setResult({ kind: "ok", data });
    } catch (x) {
      if (n === req.current) setResult({ kind: "err", text: errText(i, x), meta: errMeta(x) });
    } finally {
      if (n === req.current) setBusy(false);
    }
  };

  return (
    <div className="src-api" data-testid={`sf-api-${idx}`}>
      <div className="field">
        <label htmlFor={id} className="req">
          {t("src.api.label")}
        </label>
        <textarea
          id={id}
          className="textarea mono src-api-json"
          rows={value ? 14 : 4}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          maxLength={20000}
          placeholder={t("src.api.ph")}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setResult(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint${error ? ` ${id}-err` : ""}`}
          data-testid={`sf-api-json-${idx}`}
        />
        <span className="hint" id={`${id}-hint`}>
          {t("src.api.hint")}
        </span>
        <FieldErr msg={error} id={`${id}-err`} />
      </div>
      <div className="src-api-acts">
        {!value.trim() && !readOnly && <Btn size="sm" kind="ghost" icon="json" label={t("src.api.template")} onClick={() => onChange(jsonApiTemplate(ctx.eventDomains[0] ?? ""))} testId={`sf-api-tpl-${idx}`} />}
        <Btn size="sm" icon="scan" label={t("src.api.check")} busy={busy} disabled={!parsed || !ctx.eventDomains.length} perm="sources.manage" onClick={() => void check()} testId={`sf-api-check-${idx}`} />
        <span className="xs muted">{t("src.api.checkHint")}</span>
      </div>
      {/* only the outcome line is announced when «Check» finishes; the table and keys stay outside the live region */}
      <div role="status" aria-live="polite" className="src-api-live" data-testid={`sf-api-live-${idx}`}>
        {result?.kind === "err" && (
          <Callout kind="bad" icon="alertCircle" testId={`sf-api-err-${idx}`}>
            <b>{result.text}</b>
            {result.meta && <span className="xs muted block mono">{result.meta}</span>}
          </Callout>
        )}
        {result?.kind === "ok" && <PreviewSummary data={result.data} idx={idx} t={t} tp={tp} />}
      </div>
      {result?.kind === "ok" && <PreviewView data={result.data} idx={idx} when={(d, tm) => whenLabel(fmt.date, d, tm)} t={t} />}
    </div>
  );
}

type T = (k: MessageKey, v?: Record<string, string | number>) => string;

/** The outcome line of «Check» (inside the live region): how many items were found, or what went wrong. */
function PreviewSummary({ data, idx, t, tp }: { data: SourceJsonApiPreview; idx: number; t: T; tp: (k: MessageKey, n: number) => string }) {
  const hint = data.ok ? undefined : crawlCodeHint(t, data.code);
  return data.ok ? (
    <Callout kind={data.events.length ? "good" : "warn"} icon={data.events.length ? "checkCircle" : "alert"}>
      <b>{data.events.length ? `${tp("src.api.found", data.items_total)} ${t("src.api.shown", { k: data.events.length })}` : t("src.api.none")}</b>
      {data.items_path && <span className="xs muted block">{t("src.api.itemsAt", { p: data.items_path })}</span>}
    </Callout>
  ) : (
    <Callout kind="bad" icon="alertCircle" testId={`sf-api-code-${idx}`}>
      <b>{data.code ? crawlCodeLabel(t, data.code) : t("src.api.failed")}</b>
      {hint && <span className="block small mt-8">{hint}</span>}
      <span className="xs muted block mono">
        {[data.code, data.reason].filter(Boolean).join(" · ")}
      </span>
    </Callout>
  );
}

function PreviewView({ data, idx, when, t }: { data: SourceJsonApiPreview; idx: number; when: (date: string, time: string | null) => string; t: T }) {
  const skipped = Object.entries(data.skipped);
  return (
    <div className="src-api-res" data-testid={`sf-api-res-${idx}`} data-ok={data.ok}>
      {data.events.length > 0 && (
        <div className="table-wrap">
          <table className="tbl src-api-tbl" data-testid={`sf-api-events-${idx}`}>
            <thead>
              <tr>
                <th>{t("src.api.col.title")}</th>
                <th>{t("src.api.col.when")}</th>
                <th>{t("src.api.col.venue")}</th>
                <th>{t("src.api.col.link")}</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={`${e.id}:${e.local_date}:${e.local_time ?? ""}`}>
                  <td>
                    <div className="cell-main">{e.title}</div>
                    <div className="cell-sub nowrap">
                      <span className="mono">id {e.id}</span>
                      {e.age ? `, ${e.age}` : ""}
                    </div>
                  </td>
                  <td className="nowrap">
                    <div className="cell-main">{when(e.local_date, e.local_time)}</div>
                    {e.timezone && <div className="cell-sub">{e.timezone}</div>}
                  </td>
                  <td>
                    <div className="cell-main">{e.venue ?? "—"}</div>
                    <div className="cell-sub">{e.city ?? t("src.api.noCity")}</div>
                  </td>
                  <td className="src-api-link">
                    <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="mono xs" title={e.url}>
                      {linkPath(e.url)}
                    </a>
                    <div className="cell-sub">{[linkHost(e.url), e.image ? t("src.api.hasImage") : ""].filter(Boolean).join(", ")}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.events.length > 0 && (
        // narrow screens (≤ 480 px): the same events as cards instead of the table
        <ul className="src-api-cards" data-testid={`sf-api-cards-${idx}`}>
          {data.events.map((e) => (
            <li key={`${e.id}:${e.local_date}:${e.local_time ?? ""}`}>
              <b className="small">{e.title}</b>
              <span className="xs">
                {when(e.local_date, e.local_time)}
                {e.timezone && <span className="muted"> {e.timezone}</span>}
              </span>
              <span className="xs">{[e.venue, e.city ?? t("src.api.noCity")].filter(Boolean).join(", ")}</span>
              <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="mono xs" title={e.url}>
                {linkHost(e.url)}
                {linkPath(e.url)}
              </a>
            </li>
          ))}
        </ul>
      )}
      {(skipped.length > 0 || data.rejected.length > 0) && (
        <div className="src-api-skips">
          <h4 className="small">{t("src.api.rejectedT")}</h4>
          <ul className="xs" data-testid={`sf-api-skips-${idx}`}>
            {skipped.map(([reason, n]) => (
              <li key={reason}>
                {skipReasonLabel(t, reason)} <span className="muted">× {n}</span>
              </li>
            ))}
          </ul>
          {data.rejected.length > 0 && (
            <>
              <h4 className="xs muted mt-8">{t("src.api.rejectedExamples")}</h4>
              <ul className="xs src-api-rejected" data-testid={`sf-api-rejected-${idx}`}>
                {data.rejected.map((r) => (
                  <li key={r.index}>
                    {t("src.api.item", { n: r.index + 1 })}
                    {r.id ? <span className="mono"> id {r.id}</span> : <span className="muted"> {t("src.api.noId")}</span>}: {skipReasonLabel(t, r.reason)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {data.keys.length > 0 && (
        <div className="src-api-keys">
          <h4 className="small">{data.keys_scope === "response" ? t("src.api.keysResponse") : t("src.api.keysItem")}</h4>
          <dl data-testid={`sf-api-keys-${idx}`}>
            {data.keys.map((k) => (
              <div key={k.path}>
                <dt className="mono">{k.path}</dt>
                <dd className="muted">{k.sample || "—"}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <p className="xs muted wrap-any">
        {t("src.api.request")} <span className="mono">{data.request_url}</span>
      </p>
    </div>
  );
}
