import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { PriceCatalogItem, PriceCatalogVersion } from "@tilhero/contracts/admin";
import { AiApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n } from "../../i18n";
import { fmtUsd } from "../../lib/money";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Spinner } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { incompleteModels, RATE_FIELDS, rateIn, trimZeros, type RateField } from "./ai";
import { Who } from "./parts";

type Draft = Record<string, Record<RateField, string>>;
const STATUS_TONE = { draft: "neutral", active: "good", retired: "outline" } as const;
const itemKey = (i: PriceCatalogItem) => `${i.kind}:${i.key}`;
const toDraft = (items: PriceCatalogItem[]): Draft =>
  Object.fromEntries(
    items.map((i) => [
      itemKey(i),
      Object.fromEntries([...RATE_FIELDS, "per_call_usd"].map((f) => [f, i[f as RateField] == null ? "" : trimZeros(i[f as RateField]!)])) as Record<RateField, string>,
    ]),
  );

/**
 * Price catalogue (cost-accounting, A36): versions «YYYY-MM-DD[-n]», a draft is edited, activation needs
 * ops.kill_switch + TOTP and a reason; an active or retired version is immutable. Every usage keeps the catalogue
 * version it was charged by — historical costs are never recalculated.
 */
export function PriceCatalog() {
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const toast = useToast();
  const canEdit = can("ops.kill_switch");
  const [list, setList] = useState<PriceCatalogVersion[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [cur, setCur] = useState<PriceCatalogVersion | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);

  const loadList = useCallback(async (select?: string) => {
    try {
      const l = await AiApi.priceVersions();
      setList(l.items);
      setError(null);
      setSel((s) => select ?? s ?? l.items.find((v) => v.status === "draft")?.version ?? l.items.find((v) => v.status === "active")?.version ?? l.items[0]?.version ?? null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadVersion = useCallback(async (v: string) => {
    try {
      const x = await AiApi.priceVersion(v);
      setCur(x);
      setDraft(toDraft(x.items ?? []));
      setNote(x.note ?? "");
      setFormErr(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    if (sel) void loadVersion(sel);
  }, [sel, loadVersion]);

  const editing = !!cur && cur.status === "draft" && canEdit;
  const items = cur?.items ?? [];
  const models = items.filter((x) => x.kind === "model");
  const others = items.filter((x) => x.kind !== "model");
  const bad = useMemo(() => {
    const out = new Set<string>();
    for (const [k, row] of Object.entries(draft)) for (const [f, v] of Object.entries(row)) if (rateIn(v) === false) out.add(`${k}:${f}`);
    return out;
  }, [draft]);
  const nextItems = (): PriceCatalogItem[] =>
    items.map((it) => {
      const row = draft[itemKey(it)]!;
      const val = (f: RateField) => {
        const r = rateIn(row[f]);
        return r === false ? null : r;
      };
      return it.kind === "model"
        ? { ...it, input_usd_per_mtok: val("input_usd_per_mtok"), output_usd_per_mtok: val("output_usd_per_mtok"), cache_read_usd_per_mtok: val("cache_read_usd_per_mtok"), cache_write_usd_per_mtok: val("cache_write_usd_per_mtok"), per_call_usd: null }
        : { ...it, per_call_usd: val("per_call_usd"), input_usd_per_mtok: null, output_usd_per_mtok: null, cache_read_usd_per_mtok: null, cache_write_usd_per_mtok: null };
    });
  const dirty = useMemo(() => {
    if (!cur) return false;
    return JSON.stringify(toDraft(cur.items ?? [])) !== JSON.stringify(draft) || (cur.note ?? "") !== note;
  }, [cur, draft, note]);
  const missing = cur ? (cur.incomplete_models ?? incompleteModels(items)) : [];

  const saveDraft = async () => {
    if (!cur) return;
    if (bad.size) {
      setFormErr(t("pc.err.rate"));
      return;
    }
    setBusy(true);
    setFormErr(null);
    try {
      const x = await AiApi.patchPriceDraft(cur.version, nextItems(), note.trim(), cur.row_version);
      setCur(x);
      setDraft(toDraft(x.items ?? []));
      setNote(x.note ?? "");
      toast(t("pc.saved"), "ok", "ai.pricing.update");
      void loadList(x.version);
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") void loadVersion(cur.version);
      setFormErr(errText(i, e));
    } finally {
      setBusy(false);
    }
  };
  const newDraft = async () => {
    setBusy(true);
    try {
      const active = list?.find((v) => v.status === "active")?.version ?? list?.[0]?.version ?? null;
      const x = await AiApi.createPriceDraft(active, t("pc.newNote", { v: active ?? "env" }));
      toast(t("pc.created", { v: x.version }), "ok", "ai.pricing.create");
      await loadList(x.version);
    } catch (e) {
      toast(errText(i, e), "err");
    } finally {
      setBusy(false);
    }
  };

  if (error && !list) return <LoadError error={error} onRetry={() => void loadList()} testId="pc-error" />;
  if (!list) return <Spinner label={t("common.loading")} />;
  if (!list.length) return <Empty icon="coins" title={t("pc.emptyT")} text={t("pc.emptyM")} testId="pc-empty" />;
  const hasDraft = list.some((v) => v.status === "draft");

  const rateCell = (it: PriceCatalogItem, f: RateField, digits: 2 | 4) => {
    const k = itemKey(it);
    if (!editing) return <td className="num mono">{fmtUsd(it[f], digits)}</td>;
    const v = draft[k]?.[f] ?? "";
    return (
      <td className="num">
        <input
          className={cx("input mono pc-rate", bad.has(`${k}:${f}`) && "is-invalid")}
          inputMode="decimal"
          value={v}
          placeholder="—"
          maxLength={12}
          aria-label={`${it.key} ${t(`pc.f.${f}`)}`}
          onChange={(e) => setDraft({ ...draft, [k]: { ...draft[k]!, [f]: e.target.value } })}
          data-testid={`pc-rate-${it.key}-${f}`}
        />
      </td>
    );
  };

  return (
    <div data-testid="pc">
      <div className="toolbar pc-bar">
        <div className="seg" role="group" aria-label={t("pc.versions")} data-testid="pc-versions">
          {list.map((v) => (
            <button key={v.version} type="button" aria-pressed={sel === v.version} onClick={() => setSel(v.version)} data-version={v.version}>
              <span className="mono">{v.version}</span>
              {v.status !== "retired" && (
                <Pill tone={STATUS_TONE[v.status]} dot={v.status === "active"}>
                  {t(`pc.st.${v.status}`)}
                </Pill>
              )}
            </button>
          ))}
        </div>
        {cur && (
          <span className="xs muted" data-testid="pc-meta">
            {cur.status === "active" && cur.activated_at ? (
              <>
                {t("pc.activeSince", { t: fmt.dateTime(cur.activated_at) })} · <Who id={cur.activated_by} name={cur.activated_by_name} />
              </>
            ) : cur.status === "retired" ? (
              t("pc.retired", { t: fmt.dateTime(cur.retired_at) })
            ) : (
              <>
                {t("pc.draftBy")} <Who id={cur.created_by} name={cur.created_by_name} /> · {fmt.dateTime(cur.created_at)}
              </>
            )}
          </span>
        )}
        <span className="grow" />
        {!hasDraft && <Btn kind="primary" icon="plus" label={t("pc.new")} perm="ops.kill_switch" busy={busy} onClick={() => void newDraft()} testId="pc-new" />}
      </div>
      <Callout kind="info" icon="info" testId="pc-note">
        {t("pc.lead")}
      </Callout>
      {cur && cur.status !== "draft" && (
        <p className="xs muted row mt-8" data-testid="pc-immutable">
          <Icon name="lock" /> {t("pc.immutable")}
        </p>
      )}
      {cur && missing.length > 0 && (
        <Callout kind="warn" icon="alert" testId="pc-incomplete">
          <b>{t("pc.incompleteT")}</b> {t("pc.incompleteM", { m: missing.join(", ") })}
        </Callout>
      )}
      {!cur && <Spinner label={t("common.loading")} />}
      {cur && (
        <div className="pc-grid mt-12">
          <section className="panel" data-testid="pc-models">
            <div className="panel-h">
              <h3 className="panel-t">
                <Icon name="cpu" />
                {t("pc.models")}
              </h3>
              <span className="panel-sub">{t("pc.perMtok")}</span>
            </div>
            <div className="table-wrap">
              <table className="tbl compact">
                <thead>
                  <tr>
                    <th>{t("pc.model")}</th>
                    {RATE_FIELDS.map((f) => (
                      <th key={f} className="num">
                        {t(`pc.f.${f}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.key} data-model={m.key}>
                      <td className="mono">{m.key}</td>
                      {RATE_FIELDS.map((f) => (
                        <FragmentCell key={f}>{rateCell(m, f, 2)}</FragmentCell>
                      ))}
                    </tr>
                  ))}
                  {!models.length && (
                    <tr>
                      <td colSpan={5} className="muted xs">
                        {t("pc.noModels")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel" data-testid="pc-external">
            <div className="panel-h">
              <h3 className="panel-t">
                <Icon name="link" />
                {t("pc.external")}
              </h3>
              <span className="panel-sub">{t("pc.perCall")}</span>
            </div>
            <div className="table-wrap">
              <table className="tbl compact">
                <thead>
                  <tr>
                    <th>{t("pc.key")}</th>
                    <th className="num">{t("pc.f.per_call_usd")}</th>
                  </tr>
                </thead>
                <tbody>
                  {others.map((x) => (
                    <tr key={itemKey(x)}>
                      <td className="mono">{x.kind === "request_fee" ? t("pc.fee") : x.key}</td>
                      {rateCell(x, "per_call_usd", 4)}
                    </tr>
                  ))}
                  {!others.length && (
                    <tr>
                      <td colSpan={2} className="muted xs">
                        {t("pc.noExternal")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
      {cur && editing && (
        <section className="panel mt-12" data-testid="pc-draft">
          <div className="panel-b stack sm">
            <div className="field">
              <label htmlFor="pc-note-in">{t("pc.noteLabel")}</label>
              <input id="pc-note-in" className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} data-testid="pc-note-in" />
              <span className="hint">{t("pc.noteHint")}</span>
            </div>
            <FieldErr msg={formErr} />
            <div className="row">
              <span className="grow" />
              <Btn label={t("pc.save")} icon="check" disabled={!dirty} busy={busy} onClick={() => void saveDraft()} testId="pc-save" />
              <Btn
                kind="primary"
                icon="power"
                label={t("pc.activate")}
                perm="ops.kill_switch"
                disabled={dirty || missing.length > 0}
                title={dirty ? t("pc.saveFirst") : missing.length ? t("pc.incompleteT") : undefined}
                onClick={() => setActivating(true)}
                testId="pc-activate"
              />
            </div>
          </div>
        </section>
      )}
      {activating && cur && (
        <ConfirmCommand
          title={t("pc.activateT", { v: cur.version })}
          text={t("pc.activateM")}
          icon="power"
          ok={t("pc.activateOk")}
          minReason={3}
          reasonPlaceholder={t("pc.activatePh")}
          extra={
            <p className="xs muted row mb-12">
              <Icon name="smartphoneKey" /> {t("dsc.stepUpNote")}
            </p>
          }
          testId="pc-activate-confirm"
          onClose={() => setActivating(false)}
          onConfirm={async (reason) => {
            if (reason.length > 300) return t("dsc.reasonLong");
            try {
              const x = await AiApi.activatePrice(cur.version, reason, cur.row_version);
              setCur(x);
              toast(t("pc.activated", { v: x.version }), "ok", "ai.pricing.activate");
              void loadList(x.version);
              return null;
            } catch (e) {
              if (e instanceof ApiError && e.cancelled) return t("stepup.cancelled");
              if (e instanceof ApiError && e.code === "AUDIT_UNAVAILABLE") return t("ai.auditDown");
              return errText(i, e);
            }
          }}
        />
      )}
    </div>
  );
}

/** a table cell rendered by a helper (keeps the key on the element of the map) */
function FragmentCell({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
