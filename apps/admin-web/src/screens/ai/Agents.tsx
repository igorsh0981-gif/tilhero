/**
 * «Агенты и скиллы» (ai.read; sprint 4, ADM-AGENT-01…05, AT-49). Routes: #/agents — the registry of the 17 LinguaFlow
 * agents (LLM / rules / code, where it lives, the stage; for LLM — the published version, model, canary, the last
 * golden run, calls and the share of unavailable answers for 7 days); #/agents/models — models and prices (edit:
 * ai.publish with step-up) and the provider status («key set / not set» — the key itself is entered only by the owner
 * in Railway, there is no field for it here); #/agents/<agent_id> — the card of an LLM agent (AgentCard).
 */
import { useCallback, useEffect, useState } from "react";
import type { AgentRow, AiModel, AiProviderStatus } from "@tilhero/contracts/admin";
import type { AgentId, AgentImplementation } from "@tilhero/contracts/ai";
import { Ai } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Seg, Spinner, Switch, TabPanel, Tabs, type Tone } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { AgentCard } from "./AgentCard";
import { AGENT_IDS, isOwnServer, isSpeech } from "./model";
import { AiOffBanner, Kv, useUsd } from "./parts";

export const IMPL_TONE: Record<AgentImplementation, Tone> = { llm: "info", rules: "accent", code: "neutral" };
type Filter = "all" | AgentImplementation | "planned";
export const AGENT_TABS = ["registry", "models"] as const;

export function parseAgentsRoute(id: string | null): { tab: "registry" | "models"; agent: AgentId | null } {
  if (id === "models") return { tab: "models", agent: null };
  const a = id && (AGENT_IDS as readonly string[]).includes(id) ? (id as AgentId) : null;
  return { tab: "registry", agent: a };
}

export function AgentsPage({ routeId }: { routeId: string | null }) {
  const { t } = useI18n();
  const { navigate } = useNav();
  const r = parseAgentsRoute(routeId);
  return (
    <div className="stack" data-testid="agents">
      <AiOffBanner />
      {r.agent ? (
        <AgentCard key={r.agent} id={r.agent} />
      ) : (
        <>
          <Tabs<"registry" | "models">
            id="ag"
            label={t("ag.tabs")}
            value={r.tab}
            onChange={(v) => navigate("agents", v === "registry" ? null : v)}
            items={[
              { v: "registry", label: t("ag.tab.registry"), icon: "cpu", testId: "ag-tab-registry" },
              { v: "models", label: t("ag.tab.models"), icon: "coins", testId: "ag-tab-models" },
            ]}
          />
          <TabPanel id="ag" value={r.tab}>
            {r.tab === "registry" ? <Registry /> : <ModelsTab />}
          </TabPanel>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- registry */

function Registry() {
  const { t, fmt, lang } = useI18n();
  const { navigate } = useNav();
  const [rows, setRows] = useState<AgentRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const load = useCallback(() => {
    Ai.agents()
      .then((r) => {
        setRows(r.items);
        setError(null);
      })
      .catch(setError);
  }, []);
  useEffect(load, [load]);
  if (error && !rows) return <LoadError error={error} onRetry={load} />;
  if (!rows) return <Spinner label={t("common.loading")} />;
  const count = (f: Filter) => rows.filter((a) => match(a, f)).length;
  const shown = rows.filter((a) => match(a, filter));
  return (
    <section className="panel" aria-labelledby="ag-reg-h" data-testid="ag-registry">
      <div className="panel-h">
        <h2 className="panel-t grow" id="ag-reg-h">
          <Icon name="cpu" /> {t("ag.registry", { n: rows.length })}
        </h2>
        <Seg<Filter>
          label={t("ag.filter")}
          value={filter}
          onChange={setFilter}
          testId="ag-filter"
          items={(["all", "llm", "rules", "code", "planned"] as const).map((v) => ({ v, label: t(`ag.f.${v}`), cnt: count(v) }))}
        />
      </div>
      <div className="table-wrap">
        <table className="tbl ag-tbl">
          <caption className="sr-only">{t("ag.registry", { n: rows.length })}</caption>
          <thead>
            <tr>
              <th scope="col">{t("ag.col.agent")}</th>
              <th scope="col">{t("ag.col.impl")}</th>
              <th scope="col">{t("ag.col.where")}</th>
              <th scope="col">{t("ag.col.stage")}</th>
              <th scope="col">{t("ag.col.published")}</th>
              <th scope="col">{t("ag.col.canary")}</th>
              <th scope="col">{t("ag.col.tests")}</th>
              <th scope="col" className="r">
                {t("ag.col.calls")}
              </th>
              <th scope="col" className="r">
                {t("ag.col.unavail")}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => {
              const llm = a.implementation === "llm";
              // a planned LLM agent has no versions yet: nothing to open
              const openable = llm && a.availability === "active";
              const run = a.last_test_run;
              return (
                <tr key={a.agent_id} data-testid={`ag-row-${a.agent_id}`} className={cx(a.availability === "planned" && "is-dim")}>
                  <td>
                    {/* agent titles are seed data in RU/UZ: in the EN interface the agent_id leads, the RU title follows */}
                    {openable ? (
                      <button type="button" className={cx("tr", lang === "en" && "mono")} onClick={() => navigate("agents", a.agent_id)} data-testid={`ag-open-${a.agent_id}`}>
                        {lang === "en" ? a.agent_id : a.title.ru || a.agent_id}
                      </button>
                    ) : (
                      <b className={cx("ag-name", lang === "en" && "mono")}>{lang === "en" ? a.agent_id : a.title.ru || a.agent_id}</b>
                    )}
                    {lang === "en" ? (
                      <span className="xs muted block" lang="ru">
                        {a.title.ru}
                      </span>
                    ) : (
                      <span className="mono xs muted block">{a.agent_id}</span>
                    )}
                    <span className="xs muted block ag-purpose" lang="ru">
                      {a.purpose.ru}
                    </span>
                  </td>
                  <td>
                    <Pill tone={IMPL_TONE[a.implementation]} dot={false}>
                      {t(`aimpl.${a.implementation}`)}
                    </Pill>
                    {a.free_text && (
                      <span className="xs muted block" title={t("ag.freeTextHint")}>
                        {t("ag.freeText")}
                      </span>
                    )}
                  </td>
                  <td className="small">{a.implemented_in ?? (llm ? "ai-gateway" : "—")}</td>
                  <td>
                    {a.availability === "active" ? (
                      <Pill tone="good">{t("avail.active")}</Pill>
                    ) : (
                      <Pill tone="neutral">{a.planned_sprint ? t("ag.plannedN", { n: a.planned_sprint }) : t("avail.planned")}</Pill>
                    )}
                  </td>
                  <td className="small">
                    {a.published ? (
                      <>
                        <span className="nowrap">
                          <b>v{a.published.version}</b> · <span className="mono">{a.published.model_id}</span>
                        </span>
                        <span className="xs muted block">{fmt.date(a.published.published_at)}</span>
                      </>
                    ) : llm ? (
                      <span className="muted">{t("ag.noPublished")}</span>
                    ) : (
                      <span className="muted">{t("ag.releaseOnly")}</span>
                    )}
                    {a.draft_version != null && (
                      <span className="block">
                        <Pill tone="warn">{t("ag.draftV", { v: a.draft_version })}</Pill>
                      </span>
                    )}
                  </td>
                  <td className="small">
                    {a.rollout?.canary_version != null ? (
                      <Pill tone="accent" testId={`ag-canary-${a.agent_id}`}>
                        v{a.rollout.canary_version} · {a.rollout.canary_percent}%
                      </Pill>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="small">
                    {run ? (
                      <>
                        <Pill tone={run.status === "running" ? "info" : run.passed_mandatory ? "good" : "bad"}>
                          {run.status === "running" ? t("trs.running") : `${run.passed}/${run.passed + run.failed}`}
                        </Pill>
                        <span className="xs muted block">
                          v{run.version} · {fmt.date(run.started_at)}
                        </span>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="r num">{openable ? fmt.num(a.calls_7d) : "—"}</td>
                  <td className="r num">{a.unavailable_pct_7d != null ? <span className={cx(a.unavailable_pct_7d >= 10 && "bad-ink b")}>{fmt.pct(a.unavailable_pct_7d)}</span> : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!shown.length && <Empty icon="inbox" title={t("common.nothingFound")} />}
      <div className="panel-f">
        <Icon name="info" /> {t("ag.regNote")}
      </div>
    </section>
  );
}

function match(a: AgentRow, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "planned") return a.availability === "planned";
  return a.implementation === f;
}

/* ---------------------------------------------------------------- models and provider */

function ModelsTab() {
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const toast = useToast();
  const money = useUsd();
  const [models, setModels] = useState<AiModel[] | null>(null);
  const [prov, setProv] = useState<AiProviderStatus | null>(null);
  const [provErr, setProvErr] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [edit, setEdit] = useState<AiModel | null>(null);
  const load = useCallback(() => {
    Ai.models()
      .then((r) => {
        setModels(r.items);
        setError(null);
      })
      .catch(setError);
    Ai.provider()
      .then((p) => {
        setProv(p);
        setProvErr(null);
      })
      .catch(setProvErr);
  }, []);
  useEffect(load, [load]);
  const canEdit = can("ai.publish");
  return (
    <div className="stack">
      <section className="card prov-card" aria-labelledby="prov-h" data-testid="ag-provider">
        <h2 className="h2" id="prov-h">
          {t("prov.title")}
        </h2>
        {provErr && !prov ? (
          <LoadError error={provErr} onRetry={load} />
        ) : !prov ? (
          <Spinner label={t("common.loading")} />
        ) : (
          <>
            <Kv k={t("prov.provider")} v={<span className="mono">{prov.provider}</span>} />
            <Kv
              k={t("prov.key")}
              testId="prov-key"
              v={
                prov.key_configured ? (
                  <Pill tone="good" testId="prov-key-set">
                    <Icon name="checkCircle" /> {t("prov.keySet")}
                  </Pill>
                ) : (
                  <Pill tone="warn" testId="prov-key-unset">
                    <Icon name="alert" /> {t("prov.keyUnset")}
                  </Pill>
                )
              }
            />
            <Kv k={t("prov.lastError")} v={prov.last_error ? `${prov.last_error.code} · ${fmt.dateTime(prov.last_error.at)}` : t("prov.noErrors")} />
            <Callout kind={prov.key_configured ? "info" : "warn"} icon="key" testId="prov-note">
              {prov.key_configured ? t("prov.noteSet") : t("prov.noteUnset")}
            </Callout>
            {prov.speech && <SpeechProvider s={prov.speech} />}
          </>
        )}
      </section>
      <section className="panel" aria-labelledby="models-h" data-testid="ag-models">
        <div className="panel-h">
          <h2 className="panel-t grow" id="models-h">
            <Icon name="coins" /> {t("mdl.title")}
          </h2>
          {!canEdit && <span className="xs muted">{t("perm.need", { p: "ai.publish" })}</span>}
        </div>
        {error && !models ? (
          <div className="panel-b">
            <LoadError error={error} onRetry={load} />
          </div>
        ) : !models ? (
          <Spinner label={t("common.loading")} />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <caption className="sr-only">{t("mdl.title")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("mdl.col.model")}</th>
                  <th scope="col">{t("mdl.col.provider")}</th>
                  <th scope="col" className="r">
                    {t("mdl.col.in")}
                  </th>
                  <th scope="col" className="r">
                    {t("mdl.col.out")}
                  </th>
                  <th scope="col" className="r">
                    {t("mdl.col.audio")}
                  </th>
                  <th scope="col">{t("col.status")}</th>
                  <th scope="col">{t("mdl.col.updated")}</th>
                  <th scope="col">
                    <span className="sr-only">{t("common.edit")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.model_id} data-testid={`mdl-row-${m.model_id}`}>
                    <td className="mono">{m.model_id}</td>
                    <td className="mono small">{m.provider}</td>
                    <td className="r num" data-testid={`mdl-in-${m.model_id}`}>
                      {isSpeech(m) ? "—" : money(m.input_usd_per_mtok)}
                    </td>
                    <td className="r num" data-testid={`mdl-out-${m.model_id}`}>
                      {isSpeech(m) ? "—" : money(m.output_usd_per_mtok)}
                    </td>
                    <td className="r num" data-testid={`mdl-audio-${m.model_id}`}>
                      {isSpeech(m) ? money(isOwnServer(m) ? 0 : m.audio_usd_per_hour) : "—"}
                      {isOwnServer(m) && <span className="xs muted block">{t("mdl.ownServer")}</span>}
                    </td>
                    <td>{m.active ? <Pill tone="good">{t("mdl.active")}</Pill> : <Pill>{t("mdl.inactive")}</Pill>}</td>
                    <td className="small muted">{fmt.dateTime(m.updated_at)}</td>
                    <td className="r">{canEdit && <Btn size="xs" icon="edit" label={t("common.edit")} onClick={() => setEdit(m)} testId={`mdl-edit-${m.model_id}`} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="panel-f">
          <Icon name="info" /> {t("mdl.note")}
        </div>
      </section>
      {edit && (
        <ModelDialog
          model={edit}
          onClose={() => setEdit(null)}
          onSaved={(m) => {
            setModels((xs) => xs?.map((x) => (x.model_id === m.model_id ? m : x)) ?? xs);
            toast(t("mdl.saved", { m: m.model_id }), "ok", "ai.model_updated");
          }}
          errText={(e) => errText(i, e)}
        />
      )}
    </div>
  );
}

/**
 * Status of the pronunciation provider. Azure: «key set / not set», region, last error — the key itself is never shown
 * or entered. release 5.1 — the own server (whisper): «Свой сервер (Whisper) · подключён / не подключён», no region and
 * no key (key_configured means the recognition service is connected).
 */
function SpeechProvider({ s }: { s: AiProviderStatus["speech"] }) {
  const { t, fmt } = useI18n();
  if (isOwnServer(s))
    return (
      <div className="stack sm prov-speech" data-testid="prov-speech" data-provider={s.provider}>
        <h3 className="h3">{t("prov.speech")}</h3>
        <Kv
          k={t("prov.provider")}
          testId="prov-speech-own"
          v={
            <span className="row wrap">
              <span>{t("prov.ownServer")}</span>
              {s.key_configured ? (
                <Pill tone="good" testId="prov-speech-on">
                  <Icon name="checkCircle" /> {t("prov.connected")}
                </Pill>
              ) : (
                <Pill tone="warn" testId="prov-speech-off">
                  <Icon name="alert" /> {t("prov.disconnected")}
                </Pill>
              )}
            </span>
          }
        />
        <Kv k={t("prov.lastError")} v={s.last_error ? `${s.last_error.code} · ${fmt.dateTime(s.last_error.at)}` : t("prov.noErrors")} testId="prov-speech-error" />
        <Callout kind={s.key_configured ? "info" : "warn"} icon={s.key_configured ? "info" : "alert"} testId="prov-speech-note">
          {s.key_configured ? t("prov.ownNoteOn") : t("prov.ownNoteOff")}
        </Callout>
      </div>
    );
  return (
    <div className="stack sm prov-speech" data-testid="prov-speech" data-provider={s.provider}>
      <h3 className="h3">{t("prov.speech")}</h3>
      <Kv k={t("prov.provider")} v={<span className="mono">{s.provider}</span>} />
      <Kv
        k={t("prov.speechKey")}
        testId="prov-speech-key"
        v={
          s.key_configured ? (
            <Pill tone="good" testId="prov-speech-set">
              <Icon name="checkCircle" /> {t("prov.keySet")}
            </Pill>
          ) : (
            <Pill tone="warn" testId="prov-speech-unset">
              <Icon name="alert" /> {t("prov.keyUnset")}
            </Pill>
          )
        }
      />
      <Kv k={t("prov.region")} v={s.region ? <span className="mono">{s.region}</span> : t("prov.noRegion")} testId="prov-speech-region" />
      <Kv k={t("prov.lastError")} v={s.last_error ? `${s.last_error.code} · ${fmt.dateTime(s.last_error.at)}` : t("prov.noErrors")} testId="prov-speech-error" />
      <Callout kind={s.key_configured ? "info" : "warn"} icon="key" testId="prov-speech-note">
        {s.key_configured ? t("prov.speechNoteSet") : t("prov.speechNoteUnset")}
      </Callout>
    </div>
  );
}

function ModelDialog({ model, onClose, onSaved, errText: et }: { model: AiModel; onClose: () => void; onSaved: (m: AiModel) => void; errText: (e: unknown) => string }) {
  const { t } = useI18n();
  const speech = isSpeech(model);
  // release 5.1: the own server (whisper) — the price of an hour is fixed at 0, only the activity is edited
  const own = isOwnServer(model);
  const [inp, setInp] = useState(String(model.input_usd_per_mtok));
  const [out, setOut] = useState(String(model.output_usd_per_mtok));
  const [audio, setAudio] = useState(String(model.audio_usd_per_hour ?? ""));
  const [active, setActive] = useState(model.active);
  const price = (s: string) => {
    const n = Number(s.replace(",", "."));
    return s.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 1000 ? n : null;
  };
  const pi = speech ? model.input_usd_per_mtok : price(inp);
  const po = speech ? model.output_usd_per_mtok : price(out);
  const pa = speech && !own ? price(audio) : null;
  const bad = pi == null || po == null || (speech && !own && pa == null);
  const same = pi === model.input_usd_per_mtok && po === model.output_usd_per_mtok && active === model.active && (!speech || own || pa === model.audio_usd_per_hour);
  return (
    <ConfirmCommand
      title={t("mdl.editT", { m: model.model_id })}
      text={own ? t("mdl.editOwnM") : speech ? t("mdl.editSpeechM") : t("mdl.editM")}
      icon="coins"
      ok={t("common.save")}
      okDisabled={bad || same}
      minReason={5}
      testId="mdl-dialog"
      onClose={onClose}
      extra={
        <div className="stack sm">
          {own ? (
            <p className="small" data-testid="mdl-own">
              <Icon name="info" /> {t("mdl.ownPrice")}
            </p>
          ) : speech ? (
            <div className="field">
              <label htmlFor="mdl-audio" className="req">
                {t("mdl.col.audio")}
              </label>
              <div className="unit-input">
                <span className="unit" aria-hidden="true">
                  $
                </span>
                <input id="mdl-audio" className={cx("input num", pa == null && "is-invalid")} inputMode="decimal" value={audio} onChange={(e) => setAudio(e.target.value)} aria-invalid={pa == null} aria-describedby="mdl-audio-h" data-testid="mdl-audio" />
              </div>
              <span className="hint" id="mdl-audio-h">
                {t("mdl.audioHint")}
              </span>
            </div>
          ) : (
            <div className="grid2 tight">
              <div className="field">
                <label htmlFor="mdl-in" className="req">
                  {t("mdl.col.in")}
                </label>
                <input id="mdl-in" className={cx("input num", pi == null && "is-invalid")} inputMode="decimal" value={inp} onChange={(e) => setInp(e.target.value)} aria-invalid={pi == null} data-testid="mdl-in" />
              </div>
              <div className="field">
                <label htmlFor="mdl-out" className="req">
                  {t("mdl.col.out")}
                </label>
                <input id="mdl-out" className={cx("input num", po == null && "is-invalid")} inputMode="decimal" value={out} onChange={(e) => setOut(e.target.value)} aria-invalid={po == null} data-testid="mdl-out" />
              </div>
            </div>
          )}
          {bad && <FieldErr msg={t("mdl.priceErr")} />}
          <Switch id="mdl-active" checked={active} onChange={setActive} label={t("mdl.activeL")} />
          <Callout kind="info" icon="smartphoneKey">
            {t("ct.stepUpNote")}
          </Callout>
        </div>
      }
      onConfirm={async (reason) => {
        try {
          // the own server never sends a price of an hour (ai-gateway: 422 PRICE_NOT_APPLICABLE)
          const m = await Ai.putModel({ model_id: model.model_id, input_usd_per_mtok: pi!, output_usd_per_mtok: po!, active, ...(speech && !own ? { audio_usd_per_hour: pa } : {}) }, reason);
          onSaved(m);
          return null;
        } catch (e) {
          if ((e as ApiError)?.cancelled) return t("stepup.cancelled");
          return et(e);
        }
      }}
    />
  );
}
