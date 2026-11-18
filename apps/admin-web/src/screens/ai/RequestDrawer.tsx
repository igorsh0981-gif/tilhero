import { useEffect, useRef, useState } from "react";
import type { AiRequestContent, AiRequestDetail, CostBreakdown } from "@tilhero/contracts/admin";
import { UsageApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type Lang, type MessageKey } from "../../i18n";
import { shortId } from "../../lib/ids";
import { fmtUsd } from "../../lib/money";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, CopyBtn, cx, Empty, Locked, Pill, Spinner } from "../../ui/kit";
import { ConfirmCommand, Drawer } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { REQ_TONE } from "./ai";
import { Ms, QuotaMark } from "./parts";
import { webHref } from "../../lib/url";

const COST_ROWS: ReadonlyArray<{ k: keyof CostBreakdown; label: MessageKey }> = [
  { k: "llm_input_usd", label: "rq.cost.in" },
  { k: "llm_output_usd", label: "rq.cost.out" },
  { k: "cache_write_usd", label: "rq.cost.cw" },
  { k: "cache_read_usd", label: "rq.cost.cr" },
  { k: "request_fee_usd", label: "rq.cost.fee" },
  { k: "external_api_usd", label: "rq.cost.ext" },
];

/** sum of decimal strings without floats (µ$); null when any part is missing */
function sumUsd(values: Array<string | null>): string | null {
  let total = 0n;
  for (const v of values) {
    if (v == null) return null;
    const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v);
    if (!m) return null;
    total += BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  }
  return `${total / 1_000_000n}.${(total % 1_000_000n).toString().padStart(6, "0")}`;
}

/**
 * Drill-down of one AI request (ТЗ Admin §7): metadata, cost breakdown by the price catalogue version of each call,
 * timeline of the LLM calls and tools. The conversation itself is hidden: shown only with ai.content.read, a reason
 * (3–300) and TOTP; ai-concierge writes ai.content.view to the audit first. The content lives in this component's
 * state only — closing the drawer drops it.
 */
export function RequestDrawer({ id, nameOf, onClose }: { id: string; nameOf: (agentId: string) => string; onClose: () => void; lang: Lang }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const { navigate } = useNav();
  const [d, setD] = useState<AiRequestDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [content, setContent] = useState<AiRequestContent | null>(null);
  const [asking, setAsking] = useState(false);
  const [expired, setExpired] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    setD(null);
    setContent(null);
    setExpired(false);
    UsageApi.request(id)
      .then((x) => alive && (setD(x), setError(null)))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [id]);

  const calls = d?.calls ?? [];
  const totalCalls = sumUsd(calls.map((c) => c.cost?.total_cost_usd ?? null));
  const unpriced = calls.filter((c) => c.cost?.status === "unpriced" || c.cost == null).length;
  const maxEnd = Math.max(1, ...(d?.timeline ?? []).map((s) => (s.started_ms ?? 0) + (s.duration_ms ?? 0)));

  return (
    <Drawer
      wide
      testId="req-drawer"
      onClose={onClose}
      title={
        <>
          <span className="mono">{shortId(id, 8, 4)}</span>
          {d && <> · {nameOf(d.agent_id)}</>}
        </>
      }
      sub={
        d && (
          <>
            <Pill tone={REQ_TONE[d.status]}>{t(`req.st.${d.status}`)}</Pill>
            <QuotaMark row={d} />
            <span className="mono">{fmt.dateTimeS(d.occurred_at)}</span>
            {d.trace_id && <span className="mono xs">· trace {shortId(d.trace_id, 6, 4)}</span>}
          </>
        )
      }
    >
      {error ? <LoadError error={error} testId="rq-error" /> : null}
      {!d && !error && <Spinner label={t("common.loading")} />}
      {d && (
        <div className="stack">
          <dl className="dl" data-testid="rq-meta">
            <dt>request_id</dt>
            <dd>
              <span className="mono">{d.request_id}</span> <CopyBtn value={d.request_id} label="request_id" />
            </dd>
            {d.trace_id && (
              <>
                <dt>trace_id</dt>
                <dd>
                  <span className="mono">{d.trace_id}</span> <CopyBtn value={d.trace_id} label="trace_id" />
                </dd>
              </>
            )}
            <dt>{t("req.col.agent")}</dt>
            <dd>
              {nameOf(d.agent_id)}
              {d.skill_id && (
                <span className="mono xs muted">
                  {" "}
                  · {d.skill_id}
                  {d.skill_version ? ` v${d.skill_version}` : ""}
                </span>
              )}
            </dd>
            <dt>{t("req.col.user")}</dt>
            <dd>
              {d.user_id ? (
                can("users.read") ? (
                  <button type="button" className="link-btn mono" onClick={() => navigate("users", d.user_id)}>
                    {d.user_id}
                  </button>
                ) : (
                  <span className="mono">{d.user_id}</span>
                )
              ) : (
                <span className="muted">{t("rq.noUser")}</span>
              )}
            </dd>
            <dt>{t("req.col.model")}</dt>
            <dd className="mono">
              {d.model_used ?? "—"}
              {d.fallback_used && (
                <>
                  {" "}
                  <Pill tone="warn" dot={false}>
                    {t("req.fallback")}
                  </Pill>
                </>
              )}
            </dd>
            {d.mode && (
              <>
                <dt>{t("rq.mode")}</dt>
                <dd>
                  {t(d.mode === "home" ? "rq.mode.home" : "rq.mode.event")}
                  {d.kind && <span className="muted"> · {t(d.kind === "action" ? "rq.kind.action" : "rq.kind.text")}</span>}
                </dd>
              </>
            )}
            <dt>{t("req.col.duration")}</dt>
            <dd>
              <Ms ms={d.latency_ms} />
              {d.first_event_ms != null && (
                <span className="muted xs">
                  {" "}
                  · {t("rq.firstEvent")} <Ms ms={d.first_event_ms} />
                </span>
              )}
            </dd>
            <dt>{t("rq.tokens")}</dt>
            <dd className="mono xs">
              in {fmt.num(d.tokens_in)} (cache read {fmt.num(calls.reduce((a, c) => a + c.cache_read_tokens, 0))} · write{" "}
              {fmt.num(calls.reduce((a, c) => a + c.cache_write_tokens, 0))}) · out {fmt.num(d.tokens_out)}
            </dd>
            <dt>{t("rq.sources")}</dt>
            <dd>{d.source_count ?? "—"}</dd>
            <dt>{t("rq.safety")}</dt>
            <dd>
              {d.safety_violations == null ? (
                "—"
              ) : d.safety_violations > 0 ? (
                <Pill tone="bad">{t("rq.violations", { n: d.safety_violations })}</Pill>
              ) : (
                <Pill tone="good">{t("rq.noViolations")}</Pill>
              )}
            </dd>
            {d.error_code && (
              <>
                <dt>{t("rq.error")}</dt>
                <dd className="mono">{d.error_code}</dd>
              </>
            )}
          </dl>

          <section className="panel" data-testid="rq-cost">
            <div className="panel-h">
              <h3 className="panel-t">
                <Icon name="coins" />
                {t("rq.cost.t")}
              </h3>
              <span className="grow" />
              {d.price_catalog_versions.map((v) => (
                <span key={v} className="code-chip" data-testid="rq-catalog">
                  price_catalog_version: {v}
                </span>
              ))}
            </div>
            {calls.length === 0 && <div className="panel-b xs muted">{t("rq.cost.none")}</div>}
            {calls.map((c, idx) => (
              <div key={c.usage_id} className="panel-b rq-call" data-testid="rq-call">
                {calls.length > 1 && (
                  <div className="xs muted mb-8">
                    {t("rq.call", { n: idx + 1 })} · <span className="mono">{c.model}</span> · <Ms ms={c.latency_ms} />
                  </div>
                )}
                {c.cost && c.cost.status === "priced" ? (
                  <table className="tbl compact rq-cost-tbl">
                    <tbody>
                      {COST_ROWS.map((r) => (
                        <tr key={r.k}>
                          <td>
                            {t(r.label)}
                            {r.k === "llm_input_usd" && <span className="muted xs"> · {t("rq.tok", { n: fmt.num(c.tokens_in) })}</span>}
                            {r.k === "llm_output_usd" && <span className="muted xs"> · {t("rq.tok", { n: fmt.num(c.tokens_out) })}</span>}
                            {r.k === "cache_write_usd" && <span className="muted xs"> · {t("rq.tok", { n: fmt.num(c.cache_write_tokens) })}</span>}
                            {r.k === "cache_read_usd" && <span className="muted xs"> · {t("rq.tok", { n: fmt.num(c.cache_read_tokens) })}</span>}
                            {r.k === "external_api_usd" && c.external_api_calls.length > 0 && (
                              <span className="muted xs mono"> · {c.external_api_calls.map((x) => `${x.key}×${x.count}`).join(", ")}</span>
                            )}
                          </td>
                          <td className="num mono">{fmtUsd(c.cost![r.k] as string | null, 6)}</td>
                        </tr>
                      ))}
                      <tr className="rq-total">
                        <td>{t("rq.cost.total")}</td>
                        <td className="num mono">{fmtUsd(c.cost.total_cost_usd, 6)}</td>
                      </tr>
                    </tbody>
                  </table>
                ) : (
                  <Callout kind="warn" icon="alert" testId="rq-unpriced">
                    {t("rq.cost.unpriced", { m: c.model, v: c.price_catalog_version })}
                  </Callout>
                )}
              </div>
            ))}
            {calls.length > 1 && totalCalls && (
              <div className="panel-b rq-sum">
                <span>{t("rq.cost.all")}</span>
                <b className="mono">{fmtUsd(totalCalls, 6)}</b>
              </div>
            )}
            <div className="panel-f ai-foot">
              <Icon name="info" /> {unpriced ? t("rq.cost.footUnpriced") : t("rq.cost.foot")}
            </div>
          </section>

          {d.timeline.length > 0 && (
            <section className="panel" data-testid="rq-timeline">
              <div className="panel-h">
                <h3 className="panel-t">
                  <Icon name="clock" />
                  {t("rq.timeline")}
                </h3>
              </div>
              <ol className="rq-tl">
                {d.timeline.map((s, idx) => (
                  <li key={idx} className={cx("rq-tl-row", `is-${s.type}`, s.status && /error|fail|reject|timeout/i.test(s.status) && "is-bad")}>
                    <span className="rq-tl-name">
                      <Icon name={s.type === "llm" ? "sparkles" : "wrench"} />
                      <span className="mono">{s.name}</span>
                      {s.status && <span className="xs muted"> · {s.status}</span>}
                      {s.code && <span className="xs mono bad-ink"> · {s.code}</span>}
                    </span>
                    <span className="rq-tl-track" aria-hidden="true">
                      <i
                        style={{
                          left: `${((s.started_ms ?? 0) / maxEnd) * 100}%`,
                          width: `${Math.max(1.5, ((s.duration_ms ?? 0) / maxEnd) * 100)}%`,
                        }}
                      />
                    </span>
                    <span className="rq-tl-ms num xs">
                      <Ms ms={s.duration_ms} />
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <ContentBlock d={d} content={content} expired={expired} onAsk={() => setAsking(true)} onHide={() => setContent(null)} />
        </div>
      )}
      {asking && d && (
        <ConfirmCommand
          title={t("rq.reveal.t")}
          text={t("rq.reveal.m")}
          icon="eye"
          tone="warn"
          ok={t("rq.reveal.ok")}
          minReason={3}
          reasonLabel={t("rq.reveal.reason")}
          reasonPlaceholder={t("rq.reveal.ph")}
          extra={
            <p className="xs muted row mb-12">
              <Icon name="smartphoneKey" /> {t("rq.reveal.totp")}
            </p>
          }
          testId="rq-reveal-confirm"
          onClose={() => setAsking(false)}
          onConfirm={async (reason) => {
            if (reason.length > 300) return t("dsc.reasonLong");
            try {
              const c = await UsageApi.reveal(d.request_id, reason);
              setContent(c);
              toast(t("rq.reveal.logged"), "info", "ai.content.view");
              return null;
            } catch (e) {
              if (e instanceof ApiError && e.cancelled) return t("stepup.cancelled");
              if (e instanceof ApiError && e.code === "AI_CONTENT_EXPIRED") {
                setExpired(true);
                return null;
              }
              if (e instanceof ApiError && e.code === "AUDIT_UNAVAILABLE") return t("rq.reveal.auditDown");
              return errText(i, e);
            }
          }}
        />
      )}
    </Drawer>
  );
}

function ContentBlock({ d, content, expired, onAsk, onHide }: { d: AiRequestDetail; content: AiRequestContent | null; expired: boolean; onAsk: () => void; onHide: () => void }) {
  const { t } = useI18n();
  const { can } = useSession();
  const ref = useRef<HTMLElement>(null);
  // the revealed text is shown where the operator looks: scroll the block into view once it appears
  useEffect(() => {
    if (content) ref.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [content]);
  if (!d.conversation_id && !d.content.available)
    return <Empty icon="cpu" title={t("rq.content.noneT")} text={t("rq.content.noneM")} testId="rq-content-none" />;
  if (expired || !d.content.available)
    return <Empty icon="clock" title={t("rq.content.expiredT")} text={t("rq.content.expiredM")} testId="rq-content-expired" />;
  if (!can("ai.content.read"))
    return <Locked title={t("rq.content.lockedT")} text={t("rq.content.lockedM")} testId="rq-content-locked" />;
  if (!content)
    return (
      <div className="locked-block rq-content-ask" data-testid="rq-content-hidden">
        <Icon name="eyeOff" />
        <div className="grow">
          <div className="t">{t("rq.content.hiddenT")}</div>
          <div className="m">{t("rq.content.hiddenM")}</div>
          <Btn size="sm" icon="eye" label={t("rq.content.show")} onClick={onAsk} perm="ai.content.read" testId="rq-reveal" />
        </div>
      </div>
    );
  return (
    <section className="panel rq-content" data-testid="rq-content" ref={ref}>
      <div className="panel-h">
        <h3 className="panel-t">
          <Icon name="eye" />
          {t("rq.content.t")}
        </h3>
        <span className="grow" />
        <Btn size="xs" icon="eyeOff" label={t("rq.content.hide")} onClick={onHide} testId="rq-content-hide" />
      </div>
      <div className="panel-b stack sm">
        <div className="msg">
          <div className="bub" data-testid="rq-user-text">
            {content.user_text ?? <span className="muted">{t("rq.content.action")}</span>}
          </div>
        </div>
        {content.segments.map((s, idx) => (
          <div key={idx} className="msg op">
            <div className="bub">
              <span className="tag plain rq-seg-kind">{t(`rq.seg.${s.kind === "fact" || s.kind === "estimate" || s.kind === "recommendation" ? s.kind : "other"}`)}</span>
              <span className="wrap-any pre-line">{s.text}</span>
              {s.sources.length > 0 && (
                <span className="block xs muted">
                  {s.sources.map((src) =>
                    webHref(src.url) ? (
                      <a key={src.ref} href={webHref(src.url)!} target="_blank" rel="noopener noreferrer nofollow" className="mr-8">
                        [{src.ref}] {src.title}
                      </a>
                    ) : (
                      <span key={src.ref} className="mr-8">
                        [{src.ref}] {src.title}
                      </span>
                    ),
                  )}
                </span>
              )}
            </div>
          </div>
        ))}
        {content.tool_calls.length > 0 && (
          <ul className="rq-tools xs" data-testid="rq-tools">
            {content.tool_calls.map((c, idx) => (
              <li key={idx}>
                <Icon name="wrench" /> <span className="mono">{c.tool}</span> · {c.status}
                {c.code && <span className="mono"> · {c.code}</span>}
                {c.args && <code className="block mono wrap-any">{c.args}</code>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="panel-f ai-foot">
        <Icon name="audit" /> {t("rq.content.audit")}
      </div>
    </section>
  );
}
