import { useCallback, useEffect, useMemo, useState } from "react";
import type { AiBudget, AiLimits } from "@tilhero/contracts/admin";
import { AiApi, DiscoveryApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId } from "../../lib/ids";
import { fmtUsd } from "../../lib/money";
import { usdShort } from "../ai/ai";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, FieldErr, Pill, Spinner } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import {
  AI_MAX_USD,
  BASE_FIELDS,
  PAGES_MAX,
  belowUsed,
  availableLimits,
  changedLimits,
  formFromLimits,
  formMoney,
  isDefault,
  missingLimits,
  validateLimits,
  valuesFromForm,
  agentLimitWarnings,
  type AgentCaps,
  type LimitField,
  type LimitsForm,
} from "./limits";

const unitOf = (k: LimitField): "usd" | "pages" => (k === "pages" ? "pages" : "usd");

/**
 * «Limits» block of the AI budget (fix 6.1): the daily AI budget, the news share, pages per day — changed from the
 * admin without Railway (ops.kill_switch + step-up, reason required, audited by provider-gateway). Everyone with access
 * to the screen sees the values and where they come from; the form is for ops.kill_switch only.
 */
export function LimitsPanel({
  budget,
  onChanged,
  fields = BASE_FIELDS,
  via = "discovery",
  agentsSpent = {},
  agentsCaps = {},
}: {
  budget: AiBudget | null;
  onChanged: () => void;
  /** sprint 7 «Budgets and limits»: + the concierge and Test Console budgets */
  fields?: readonly LimitField[];
  /** admin-bff path: /discovery/limits (6.1 screen) or /ai/limits (sprint 7) — the same provider-gateway record */
  via?: "discovery" | "ai";
  /** spent today by the concierge / Test Console (the «below what is spent» warning) */
  agentsSpent?: Partial<Record<"concierge" | "evaluation", string>>;
  /** per-request and monthly limits of these agents (the «day below a request / above the month» warnings) */
  agentsCaps?: AgentCaps;
}) {
  const API = via === "ai" ? AiApi : DiscoveryApi;
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const toast = useToast();
  const canEdit = can("ops.kill_switch");
  const [limits, setLimits] = useState<AiLimits | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [f, setF] = useState<LimitsForm | null>(null);
  const [confirm, setConfirm] = useState<null | "save" | "reset">(null);
  const [tried, setTried] = useState(false);

  const apply = useCallback((l: AiLimits) => {
    setLimits(l);
    setF(formFromLimits(l));
    setTried(false);
  }, []);
  const load = useCallback(async () => {
    try {
      apply(await API.limits());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [apply, API]);
  useEffect(() => {
    void load();
  }, [load]);

  // sprint 7 fields the provider-gateway does not report yet (6.1) are hidden: «unavailable until the update»
  const avail = useMemo(() => (limits ? availableLimits(limits, fields) : fields), [limits, fields]);
  const missing = limits ? missingLimits(limits, fields) : [];
  const FIELDS = avail.map((k) => ({ k, unit: unitOf(k) }));
  const errors = useMemo(() => (f ? validateLimits(f) : {}), [f]);
  const changed = useMemo(() => (limits && f ? changedLimits(limits, f, avail) : []), [limits, f, avail]);
  const below = useMemo(
    () => (f && !Object.keys(errors).length ? belowUsed(f, budget, agentsSpent).filter((k) => changed.includes(k)) : []),
    [f, errors, budget, changed, agentsSpent],
  );
  const valid = !avail.some((k) => errors[k]);
  const agentWarn = useMemo(() => (f && valid ? agentLimitWarnings(f, agentsCaps, changed) : []), [f, valid, agentsCaps, changed]);

  const head = (
    <div className="panel-h">
      <h2 className="panel-t" id="dsc-limits-h">
        <Icon name="sliders" />
        {t("lim.title")}
      </h2>
      <span className="grow" />
      {limits && <SourceTag l={limits} />}
    </div>
  );
  if (error)
    return (
      <section className="panel mt-16" aria-labelledby="dsc-limits-h" data-testid="dsc-limits">
        {head}
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} testId="dsc-limits-error" />
        </div>
      </section>
    );
  if (!limits || !f)
    return (
      <section className="panel mt-16" aria-labelledby="dsc-limits-h" data-testid="dsc-limits">
        {head}
        <Spinner label={t("common.loading")} />
      </section>
    );

  const used: Record<LimitField, string | null> = {
    ai: budget ? fmtUsd(budget.spent_usd, 4) : null,
    news: budget?.news ? fmtUsd(budget.news.spent_usd, 4) : null,
    pages: budget ? fmt.num(budget.pages_used) : null,
    concierge: agentsSpent.concierge != null ? fmtUsd(agentsSpent.concierge, 4) : null,
    evaluation: agentsSpent.evaluation != null ? fmtUsd(agentsSpent.evaluation, 4) : null,
  };
  const dflt: Record<LimitField, string> = {
    ai: fmtUsd(limits.defaults.ai_daily_usd, 2),
    news: fmtUsd(limits.defaults.news_daily_usd, 2),
    pages: fmt.num(limits.defaults.pages_daily),
    concierge: fmtUsd(limits.defaults.concierge_daily_usd ?? null, 2),
    evaluation: fmtUsd(limits.defaults.evaluation_daily_usd ?? null, 2),
  };
  const cur: Record<LimitField, string> = {
    ai: fmtUsd(limits.ai_daily_usd, 2),
    news: fmtUsd(limits.news_daily_usd, 2),
    pages: fmt.num(limits.pages_daily),
    concierge: fmtUsd(limits.concierge_daily_usd ?? null, 2),
    evaluation: fmtUsd(limits.evaluation_daily_usd ?? null, 2),
  };
  const shown = (k: LimitField) => (k === "pages" ? fmt.num(Number(f.pages)) : fmtUsd(formMoney(f, k), 2));

  return (
    <section className={cx("panel mt-16 dsc-limits", limits.source === "admin" && "is-admin")} aria-labelledby="dsc-limits-h" data-testid="dsc-limits" data-source={limits.source}>
      {head}
      <form
        className="panel-b lim-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (valid && changed.length) setConfirm("save");
        }}
      >
        <p className="small muted lim-lead">{t(fields.includes("concierge") ? "lim.lead7" : "lim.lead")}</p>
        <div className={cx("lim-grid", avail.length > 3 && "is-wide")}>
          {FIELDS.map(({ k, unit }) => {
            const err = errors[k] && (tried || changed.includes(k)) ? t(`lim.err.${errors[k]}` as MessageKey, { max: k === "pages" ? PAGES_MAX : AI_MAX_USD }) : null;
            return (
              <div key={k} className={cx("field lim-field", changed.includes(k) && "is-edited")} data-limit={k}>
                <label htmlFor={`lim-${k}`}>{t(`lim.f.${k}` as MessageKey)}</label>
                <div className={cx("input-affix", err && "is-invalid")}>
                  {unit === "usd" && <span className="affix">$</span>}
                  <input
                    id={`lim-${k}`}
                    className="input mono"
                    inputMode={unit === "usd" ? "decimal" : "numeric"}
                    value={f[k]}
                    maxLength={unit === "usd" ? 6 : 4}
                    disabled={!canEdit}
                    onChange={(e) => setF({ ...f, [k]: e.target.value })}
                    aria-invalid={err ? true : undefined}
                    aria-describedby={`lim-${k}-hint`}
                    data-testid={`lim-${k}`}
                  />
                  <span className="affix">{t(unit === "usd" ? "lim.perDay" : "lim.pagesPerDay")}</span>
                </div>
                <span className="hint" id={`lim-${k}-hint`}>
                  {t(`lim.h.${k}` as MessageKey, { max: k === "pages" ? fmt.num(PAGES_MAX) : AI_MAX_USD })}
                  {" · "}
                  {t("lim.default", { v: dflt[k] })}
                  {used[k] && (
                    <>
                      {" · "}
                      {t("lim.used", { v: used[k]! })}
                    </>
                  )}
                </span>
                <FieldErr msg={err} />
              </div>
            );
          })}
        </div>
        {missing.length > 0 && (
          <p className="xs muted row lim-missing" data-testid="lim-missing">
            <Icon name="info" /> {t("lim.missing", { f: missing.map((k) => `«${t(`lim.f.${k}` as MessageKey)}»`).join(", ") })}
          </p>
        )}
        {below.length > 0 && (
          <Callout kind="warn" icon="alert" testId="lim-below">
            <b>{t("lim.belowT")}</b> {t("lim.belowM", { f: below.map((k) => t(`lim.short.${k}` as MessageKey)).join(", ") })}
          </Callout>
        )}
        {agentWarn.length > 0 && (
          <Callout kind="warn" icon="alert" testId="lim-agent-warn">
            <ul className="ai-warn-list">
              {agentWarn.map((w) => (
                <li key={`${w.k}-${w.f}`}>{t(`lim.warn.${w.k}`, { f: t(`lim.short.${w.f}`), v: w.k === "dayBelowPerRequest" ? usdShort(w.v) : fmtUsd(w.v, 2) })}</li>
              ))}
            </ul>
          </Callout>
        )}
        {canEdit ? (
          <div className="lim-acts">
            {changed.length > 0 && (
              <Btn label={t("lim.undo")} kind="ghost" size="sm" onClick={() => (setF(formFromLimits(limits)), setTried(false))} testId="lim-undo" />
            )}
            <span className="grow" />
            {limits.source === "admin" && (
              <Btn label={t("lim.reset")} icon="rollback" onClick={() => setConfirm("reset")} testId="lim-reset" />
            )}
            <Btn type="submit" kind="primary" icon="check" label={t("lim.save")} disabled={!changed.length} perm="ops.kill_switch" testId="lim-save" />
          </div>
        ) : (
          <p className="xs muted row" data-testid="lim-ro">
            <Icon name="lock" /> {t("lim.ro")}
          </p>
        )}
      </form>

      {confirm && (
        <ConfirmCommand
          title={confirm === "save" ? t("lim.saveT") : t("lim.resetT")}
          text={confirm === "save" ? t("lim.saveM") : t("lim.resetM")}
          icon="sliders"
          tone={below.length || agentWarn.length ? "bad" : "warn"}
          ok={confirm === "save" ? t("lim.saveOk") : t("lim.resetOk")}
          minReason={3}
          reasonPlaceholder={t("lim.reasonPh")}
          testId="lim-confirm"
          extra={
            <>
              <ul className="lim-diff" data-testid="lim-diff">
                {(confirm === "save" ? changed : FIELDS.map((x) => x.k).filter((k) => cur[k] !== dflt[k])).map((k) => (
                  <li key={k}>
                    <span>{t(`lim.short.${k}` as MessageKey)}</span>
                    <span className="mono">
                      {cur[k]} <Icon name="right" /> <b>{confirm === "save" ? shown(k) : dflt[k]}</b>
                    </span>
                  </li>
                ))}
              </ul>
              {confirm === "save" && below.length > 0 && <p className="small lim-diff-warn">{t("lim.belowM", { f: below.map((k) => t(`lim.short.${k}` as MessageKey)).join(", ") })}</p>}
              {confirm === "save" &&
                agentWarn.map((w) => (
                  <p key={`${w.k}-${w.f}`} className="small lim-diff-warn" data-testid="lim-confirm-agent-warn">
                    {t(`lim.warn.${w.k}`, { f: t(`lim.short.${w.f}`), v: w.k === "dayBelowPerRequest" ? usdShort(w.v) : fmtUsd(w.v, 2) })}
                  </p>
                ))}
              <p className="xs muted row">
                <Icon name="smartphoneKey" /> {t("dsc.stepUpNote")}
              </p>
            </>
          }
          onClose={() => setConfirm(null)}
          onConfirm={async (reason) => {
            if (reason.length > 300) return t("dsc.reasonLong");
            try {
              const l = confirm === "save" ? await API.setLimits(valuesFromForm(f, avail), reason) : await API.resetLimits(reason);
              apply(l);
              toast(confirm === "save" ? t("lim.saved") : t("lim.resetDone"), "ok", confirm === "save" ? "ai.limits.update" : "ai.limits.reset");
              onChanged();
              return null;
            } catch (e) {
              if (e instanceof ApiError && e.cancelled) return t("stepup.cancelled");
              if (e instanceof ApiError && e.code === "AUDIT_UNAVAILABLE") return t("lim.auditDown");
              void load();
              return errText(i, e);
            }
          }}
        />
      )}
    </section>
  );
}

/** «from the admin · who · when» / «defaults from the settings» */
function SourceTag({ l }: { l: AiLimits }) {
  const { t, fmt } = useI18n();
  if (l.source === "env")
    return (
      <span className="lim-src" data-testid="lim-source">
        <Pill tone="neutral" dot={false}>
          {t("lim.src.env")}
        </Pill>
      </span>
    );
  const who = l.updated_by_name ?? (l.updated_by ? shortId(l.updated_by, 8, 4) : t("lim.src.someone"));
  return (
    <span className="lim-src" data-testid="lim-source" title={l.reason ?? undefined}>
      <Pill tone="info" dot={false}>
        {t("lim.src.admin")}
      </Pill>
      <span className="xs muted">
        {who}
        {l.updated_at && <> · <span title={fmt.dateTime(l.updated_at)}>{fmt.rel(l.updated_at)}</span></>}
        {!isDefault(l) && l.reason && <> · «{l.reason}»</>}
      </span>
    </span>
  );
}
