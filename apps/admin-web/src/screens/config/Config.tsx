import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConfigActivation, ConfigApp, ConfigState, ConfigVersion } from "@tilhero/contracts/admin";
import { Experience } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useSession } from "../../state/session";
import { isColor } from "../../theme/config";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Select, Spinner, Switch, TabPanel, Tabs } from "../../ui/kit";
import { ConfirmCommand, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { WhatsNewConfig } from "./WhatsNew";

/* ---------------------------------------------------------------- payload shapes (experience-config domain/payload.py) */

export interface Section {
  type: string;
  key: string;
  variant: "large" | "compact";
  enabled: boolean;
}
export interface MiniPayload {
  theme: { id: string; version: string; tokens: Record<string, string> };
  home: { welcome_mode: "first_visit_only" | "always" | "never"; sections: Section[] };
  flags: Record<string, boolean>;
  hotel_rating_min: number;
}
export interface AdminPayload {
  theme: { id: "default" | "high_contrast"; version: string; tokens: Record<string, string> };
  layout: {
    density: "compact" | "comfortable";
    table_presets: { users: "support" | "analytics"; audit: "security" | "full" };
    dashboard_widgets: Array<{ id: string; enabled: boolean }>;
  };
  flags: Record<string, boolean>;
}
type Payload = MiniPayload | AdminPayload;

const SEMVER = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

/** Next free patch version after the highest existing one (1.0.3 → 1.0.4). */
export function nextVersion(existing: readonly string[]): string {
  const parsed = existing.filter((v) => SEMVER.test(v)).map((v) => v.split(".").map(Number) as [number, number, number]);
  if (!parsed.length) return "1.0.0";
  parsed.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const [M, m, p] = parsed[parsed.length - 1]!;
  return `${M}.${m}.${p + 1}`;
}

/** Human list of what the draft changes against the base payload (shown before saving a version). */
export function payloadChanges(app: ConfigApp, base: Payload, draft: Payload): string[] {
  const out: string[] = [];
  const flags = (a: Record<string, boolean>, b: Record<string, boolean>) => {
    for (const k of Object.keys(b)) if (a[k] !== b[k]) out.push(`flag ${k}: ${a[k] ?? "∅"} → ${b[k]}`);
  };
  if (app === "miniapp") {
    const a = base as MiniPayload;
    const b = draft as MiniPayload;
    if (a.home.sections.map((s) => s.key).join() !== b.home.sections.map((s) => s.key).join()) out.push("home.sections: order");
    for (const s of b.home.sections) {
      const o = a.home.sections.find((x) => x.key === s.key);
      if (!o) continue;
      if (o.enabled !== s.enabled) out.push(`${s.key}: ${s.enabled ? "on" : "off"}`);
      if (o.variant !== s.variant) out.push(`${s.key}: ${o.variant} → ${s.variant}`);
    }
    if (a.home.welcome_mode !== b.home.welcome_mode) out.push(`welcome_mode: ${a.home.welcome_mode} → ${b.home.welcome_mode}`);
    if (a.hotel_rating_min !== b.hotel_rating_min) out.push(`hotel_rating_min: ${a.hotel_rating_min} → ${b.hotel_rating_min}`);
    flags(a.flags, b.flags);
  } else {
    const a = base as AdminPayload;
    const b = draft as AdminPayload;
    if (a.theme.id !== b.theme.id) out.push(`theme.id: ${a.theme.id} → ${b.theme.id}`);
    if (a.theme.tokens["--accent"] !== b.theme.tokens["--accent"]) out.push(`--accent: ${a.theme.tokens["--accent"] ?? "∅"} → ${b.theme.tokens["--accent"]}`);
    if (a.layout.density !== b.layout.density) out.push(`density: ${a.layout.density} → ${b.layout.density}`);
    if (a.layout.table_presets.users !== b.layout.table_presets.users) out.push(`table_presets.users: ${a.layout.table_presets.users} → ${b.layout.table_presets.users}`);
    if (a.layout.table_presets.audit !== b.layout.table_presets.audit) out.push(`table_presets.audit: ${a.layout.table_presets.audit} → ${b.layout.table_presets.audit}`);
    const w = (x: AdminPayload) => JSON.stringify(x.layout.dashboard_widgets);
    if (w(a) !== w(b)) out.push("dashboard_widgets");
    flags(a.flags, b.flags);
  }
  return out;
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const isMini = (app: ConfigApp, _p: Payload): _p is MiniPayload => app === "miniapp";

/* ---------------------------------------------------------------- page */

type ConfigTab = ConfigApp | "whats_new";

export function ConfigPage() {
  const { t } = useI18n();
  const [app, setApp] = useState<ConfigTab>("miniapp");
  return (
    <div data-testid="config">
      <div className="page-head">
        <div className="lead">
          <p>{t("cfg.lead")}</p>
        </div>
      </div>
      <Tabs<ConfigTab>
        id="cfg"
        label={t("page.config")}
        value={app}
        onChange={setApp}
        className="mb-16"
        items={[
          { v: "miniapp", label: "Mini App", icon: "phone", testId: "cfg-tab-miniapp" },
          { v: "admin", label: "Admin", icon: "monitor", testId: "cfg-tab-admin" },
          // 9.4: заметки о релизах Mini App
          { v: "whats_new", label: t("wn.tab"), icon: "sparkles", testId: "cfg-tab-whats-new" },
        ]}
      />
      <TabPanel id="cfg" value={app}>
        {app === "whats_new" ? <WhatsNewConfig /> : <AppConfig key={app} app={app} />}
      </TabPanel>
    </div>
  );
}

function AppConfig({ app }: { app: ConfigApp }) {
  const i = useI18n();
  const { t } = i;
  const { reloadTheme, can } = useSession();
  const toast = useToast();
  const [state, setState] = useState<ConfigState | null>(null);
  const [versions, setVersions] = useState<ConfigVersion[]>([]);
  const [acts, setActs] = useState<ConfigActivation[]>([]);
  const [base, setBase] = useState<Payload | null>(null);
  const [draft, setDraft] = useState<Payload | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cmd, setCmd] = useState<{ kind: "activate"; version: string } | { kind: "rollback" } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [st, vs, ac] = await Promise.all([Experience.state(app), Experience.versions(app), Experience.activations(app)]);
      setState(st);
      setVersions(vs.items);
      setActs(ac.items);
      const cur = st.current?.version;
      if (cur) {
        const v = await Experience.version(app, cur);
        const p = (v.payload ?? null) as Payload | null;
        setBase(p ? clone(p) : null);
        setDraft(p ? clone(p) : null);
      } else {
        setBase(null);
        setDraft(null);
      }
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [app]);
  useEffect(() => {
    void load();
  }, [load]);

  const changes = useMemo(() => (base && draft ? payloadChanges(app, base, draft) : []), [app, base, draft]);
  const editable = can("config.edit");

  if (error) return <LoadError error={error} onRetry={() => void load()} />;
  if (!state) return <Spinner label={t("common.loading")} />;

  const cur = state.current?.version ?? null;
  const prev = state.previous_version;
  const sorted = [...versions].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const afterSwitch = async (msg: string, meta: string) => {
    toast(msg, "ok", meta);
    await load();
    if (app === "admin") await reloadTheme(); // A46: the admin look follows the active version without a rebuild
  };

  return (
    <div className="cfg-layout">
      <div className="stack">
        <section className="panel" data-testid="cfg-versions">
          <div className="panel-h">
            <h2 className="panel-t">
              <Icon name="layers" />
              {t(app === "miniapp" ? "cfg.versionsMini" : "cfg.versionsAdmin")}
            </h2>
            <span className="panel-sub">experience-config · {app}</span>
          </div>
          <div className="panel-b stack sm">
            {sorted.length ? (
              <div className="ver-pill-row">
                {sorted.map((v) => {
                  const isCur = v.version === cur;
                  return (
                    <div key={v.version_id} className={cx("ver-card", isCur && "is-current")} data-testid={`ver-${v.version}`}>
                      <div className="row between">
                        <span className="mono b">{v.version}</span>
                        {isCur ? <Pill tone="good">{t("cfg.current")}</Pill> : v.version === prev ? <span className="pill outline no-dot">{t("cfg.previous")}</span> : null}
                      </div>
                      <div className="xs muted mt-8">
                        {i.fmt.dateTime(v.created_at)} · {v.created_by}
                      </div>
                      <div className="small mt-8 wrap-any">{v.change_note}</div>
                      <div className="row mt-8">
                        <span className="hash" title={v.checksum}>
                          sha256 {v.checksum.slice(0, 10)}
                        </span>
                        <span className="grow" />
                        {!isCur && <Btn size="xs" icon="zap" label={t("cfg.activate")} perm="config.publish" onClick={() => setCmd({ kind: "activate", version: v.version })} testId={`activate-${v.version}`} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty icon="layers" title={t("cfg.noVersions")} />
            )}
            <div className="row">
              {prev ? (
                <Btn icon="rollback" label={t("cfg.rollback", { v: prev })} perm="config.publish" onClick={() => setCmd({ kind: "rollback" })} testId="cfg-rollback" />
              ) : (
                <Btn icon="rollback" label={t("cfg.rollbackNone")} disabled />
              )}
              <span className="small muted">{t("cfg.noRebuild")}</span>
            </div>
          </div>
        </section>

        {draft && base ? (
          <>
            {!editable && <Callout icon="lock">{t("cfg.ro", { p: "config.edit" })}</Callout>}
            {isMini(app, draft) ? <MiniEditor d={draft} set={(d) => setDraft(d)} ro={!editable} /> : <AdminEditor d={draft as AdminPayload} set={(d) => setDraft(d)} ro={!editable} />}
            <section className={cx("panel", changes.length > 0 && "sev-info")} data-testid="cfg-changes">
              <div className="panel-b row">
                <div className="grow" style={{ minWidth: 200 }}>
                  {changes.length ? (
                    <>
                      <b>{i.tp("cfg.changes", changes.length)}</b>
                      <div className="small muted mono wrap-any">
                        {changes.slice(0, 4).join(" · ")}
                        {changes.length > 4 ? " …" : ""}
                      </div>
                    </>
                  ) : (
                    <span className="muted">{t("cfg.noChanges", { v: cur ?? "—" })}</span>
                  )}
                </div>
                <Btn kind="ghost" label={t("cfg.discard")} disabled={!changes.length} onClick={() => setDraft(clone(base))} />
                <Btn kind="primary" icon="plus" label={t("cfg.saveVersion")} perm="config.edit" disabled={!changes.length} onClick={() => setSaving(true)} testId="cfg-save" />
              </div>
            </section>
          </>
        ) : (
          <Empty icon="sliders" title={t("cfg.noCurrent")} />
        )}

        <section className="panel" data-testid="cfg-activations">
          <div className="panel-h">
            <h2 className="panel-t">
              <Icon name="activity" />
              {t("cfg.history")}
            </h2>
          </div>
          <div className="table-wrap">
            <table className="tbl compact">
              <thead>
                <tr>
                  <th>{t("col.created")}</th>
                  <th>{t("cfg.col.kind")}</th>
                  <th>{t("cfg.col.version")}</th>
                  <th>{t("cmd.reason")}</th>
                  <th>{t("cfg.col.by")}</th>
                </tr>
              </thead>
              <tbody>
                {acts.map((a) => (
                  <tr key={a.activation_id}>
                    <td className="nowrap mono small">{i.fmt.dateTime(a.activated_at)}</td>
                    <td>
                      <Pill tone={a.kind === "rollback" ? "warn" : "info"}>{t(`cfg.kind.${a.kind}`)}</Pill>
                    </td>
                    <td className="mono nowrap">
                      {a.previous_version ? `${a.previous_version} → ` : ""}
                      <b>{a.version}</b>
                    </td>
                    <td className="small">{a.reason}</td>
                    <td className="small nowrap">{a.activated_by}</td>
                  </tr>
                ))}
                {!acts.length && (
                  <tr>
                    <td colSpan={5} className="empty-cell">
                      <Empty icon="activity" title={t("cfg.noHistory")} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <aside className="cfg-preview">{draft && (isMini(app, draft) ? <PhonePreview d={draft} version={cur} /> : <AdminPreview d={draft as AdminPayload} />)}</aside>

      {cmd && (
        <ConfirmCommand
          title={cmd.kind === "rollback" ? t("cfg.rollback", { v: prev ?? "—" }) : t("cfg.activateT", { v: cmd.version })}
          text={cmd.kind === "rollback" ? t("cfg.rollbackM", { a: cur ?? "—", b: prev ?? "—" }) : t("cfg.activateM", { a: cur ?? "—", b: cmd.version })}
          icon={cmd.kind === "rollback" ? "rollback" : "zap"}
          tone="warn"
          ok={cmd.kind === "rollback" ? t("cfg.rollbackOk") : t("cfg.activate")}
          testId="cfg-confirm"
          onClose={() => setCmd(null)}
          onConfirm={async (reason) => {
            try {
              const a = cmd.kind === "rollback" ? await Experience.rollback(app, reason) : await Experience.activate(app, cmd.version, reason);
              await afterSwitch(t("cfg.switched", { v: a.version }), `config.${a.kind}`);
              return null;
            } catch (e) {
              return (e as ApiError).cancelled ? t("stepup.cancelled") : errText(i, e);
            }
          }}
        />
      )}
      {saving && draft && (
        <SaveVersion
          app={app}
          existing={versions.map((v) => v.version)}
          changes={changes}
          draft={draft}
          onClose={() => setSaving(false)}
          onSaved={async (v) => {
            setSaving(false);
            toast(t("cfg.created", { v: v.version }), "ok", t("cfg.createdM"));
            await load();
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- editors */

function Ordered<T extends { enabled: boolean }>({ items, label, sub, set, ro, extra, testId }: { items: T[]; label: (x: T) => string; sub: (x: T) => string; set: (xs: T[]) => void; ro: boolean; extra?: (x: T, idx: number) => React.ReactNode; testId?: string }) {
  const { t } = useI18n();
  const move = (idx: number, d: number) => {
    const j = idx + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[idx], next[j]] = [next[j]!, next[idx]!];
    set(next);
  };
  return (
    <ol className="olist" data-testid={testId}>
      {items.map((x, idx) => (
        <li key={label(x)} className={x.enabled ? undefined : "is-off"}>
          <span className="idx">{idx + 1}</span>
          <span className="grow">
            <span className="mono b">{label(x)}</span>
            <span className="small muted block">{sub(x)}</span>
          </span>
          {extra?.(x, idx)}
          <span className="mv">
            <Btn size="xs" kind="ghost" icon="up" aria={`${t("cfg.up")}: ${label(x)}`} disabled={ro || idx === 0} onClick={() => move(idx, -1)} />
            <Btn size="xs" kind="ghost" icon="down" aria={`${t("cfg.down")}: ${label(x)}`} disabled={ro || idx === items.length - 1} onClick={() => move(idx, 1)} />
          </span>
          <Switch id={`ol-${label(x)}`} checked={x.enabled} disabled={ro} aria={label(x)} onChange={(v) => set(items.map((y, k) => (k === idx ? { ...y, enabled: v } : y)))} />
        </li>
      ))}
    </ol>
  );
}

function Flags({ flags, set, ro }: { flags: Record<string, boolean>; set: (f: Record<string, boolean>) => void; ro: boolean }) {
  const { t } = useI18n();
  const keys = Object.keys(flags);
  if (!keys.length) return <span className="small muted">{t("cfg.noFlags")}</span>;
  return (
    <div className="stack sm">
      {keys.map((k) => (
        <Switch key={k} id={`flag-${k}`} checked={!!flags[k]} disabled={ro} onChange={(v) => set({ ...flags, [k]: v })} label={<span className="mono small">{k}</span>} />
      ))}
    </div>
  );
}

const SEC_KEYS = new Set(["best_for_you", "watch", "sales_soon", "news"]);
const secLabel = (t: (k: MessageKey) => string, key: string) => (SEC_KEYS.has(key) ? t(`cfg.sec.${key as "news"}`) : key);

function MiniEditor({ d, set, ro }: { d: MiniPayload; set: (d: MiniPayload) => void; ro: boolean }) {
  const { t } = useI18n();
  const [hotel, setHotel] = useState(String(d.hotel_rating_min));
  useEffect(() => setHotel(String(d.hotel_rating_min)), [d.hotel_rating_min]);
  const hv = Number(hotel.replace(",", "."));
  const hotelErr = !(hv >= 7 && hv <= 10) ? t("cfg.hotelErr") : null;
  return (
    <>
      <section className="panel">
        <div className="panel-h">
          <h2 className="panel-t">
            <Icon name="layout" />
            {t("cfg.home")}
          </h2>
          <span className="panel-sub">home.sections[]</span>
        </div>
        <div className="panel-b">
          <Ordered<Section>
            items={d.home.sections}
            label={(s) => s.key}
            sub={(s) => `${secLabel(t, s.key)} · ${s.type}`}
            ro={ro}
            testId="cfg-sections"
            set={(sections) => set({ ...d, home: { ...d.home, sections } })}
            extra={(s, idx) => (
              <Select<Section["variant"]>
                id={`var-${s.key}`}
                label={`${s.key} variant`}
                value={s.variant}
                disabled={ro}
                onChange={(v) => set({ ...d, home: { ...d.home, sections: d.home.sections.map((x, k) => (k === idx ? { ...x, variant: v } : x)) } })}
                options={[
                  { v: "large", label: "large" },
                  { v: "compact", label: "compact" },
                ]}
              />
            )}
          />
        </div>
      </section>
      <section className="panel">
        <div className="panel-h">
          <h2 className="panel-t">
            <Icon name="sliders" />
            {t("cfg.params")}
          </h2>
        </div>
        <div className="panel-b">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="cfg-welcome">welcome_mode</label>
              <Select<MiniPayload["home"]["welcome_mode"]>
                id="cfg-welcome"
                label="welcome_mode"
                value={d.home.welcome_mode}
                disabled={ro}
                onChange={(v) => set({ ...d, home: { ...d.home, welcome_mode: v } })}
                options={(["first_visit_only", "always", "never"] as const).map((v) => ({ v, label: v }))}
              />
            </div>
            <div className="field">
              <label htmlFor="cfg-hotel">{t("cfg.hotelMin")}</label>
              <input
                id="cfg-hotel"
                className={cx("input mono", hotelErr && "is-invalid")}
                inputMode="decimal"
                value={hotel}
                disabled={ro}
                onChange={(e) => {
                  setHotel(e.target.value);
                  const v = Number(e.target.value.replace(",", "."));
                  if (v >= 7 && v <= 10) set({ ...d, hotel_rating_min: Math.round(v * 10) / 10 });
                }}
              />
              <FieldErr msg={hotelErr} />
            </div>
            <div className="field span-2">
              <span className="field-label">Feature flags</span>
              <Flags flags={d.flags} ro={ro} set={(flags) => set({ ...d, flags })} />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

const WIDGET_KEYS = new Set(["kpi_users", "kpi_ai", "kpi_support", "kpi_system", "kpi_commerce", "budget", "hourly", "cost_agents", "dau", "agents_table"]);

function AdminEditor({ d, set, ro }: { d: AdminPayload; set: (d: AdminPayload) => void; ro: boolean }) {
  const { t } = useI18n();
  const accent = d.theme.tokens["--accent"] ?? "#DFFF56";
  const [hex, setHex] = useState(accent);
  useEffect(() => setHex(accent), [accent]);
  const hexErr = isColor(hex.trim()) && /^#[0-9a-f]{6}$/i.test(hex.trim()) ? null : t("cfg.accentErr");
  const setAccent = (v: string) => {
    setHex(v);
    if (/^#[0-9a-f]{6}$/i.test(v.trim())) set({ ...d, theme: { ...d.theme, tokens: { ...d.theme.tokens, "--accent": v.trim().toUpperCase() } } });
  };
  return (
    <>
      <section className="panel">
        <div className="panel-h">
          <h2 className="panel-t">
            <Icon name="monitor" />
            {t("cfg.adminT")}
          </h2>
          <span className="panel-sub">theme · layout</span>
        </div>
        <div className="panel-b">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="cfg-a-theme">{t("cfg.adminTheme")}</label>
              <Select<AdminPayload["theme"]["id"]>
                id="cfg-a-theme"
                label={t("cfg.adminTheme")}
                value={d.theme.id}
                disabled={ro}
                onChange={(v) => set({ ...d, theme: { ...d.theme, id: v } })}
                options={[
                  { v: "default", label: "default (navy + lime)" },
                  { v: "high_contrast", label: "high_contrast" },
                ]}
              />
            </div>
            <div className="field">
              <label htmlFor="cfg-accent">{t("cfg.accent")}</label>
              <div className="row">
                <input type="color" className="color-in" value={/^#[0-9a-f]{6}$/i.test(hex) ? hex : "#000000"} disabled={ro} aria-label={t("cfg.accent")} onChange={(e) => setAccent(e.target.value)} />
                <input id="cfg-accent" className={cx("input mono grow", hexErr && "is-invalid")} value={hex} maxLength={7} disabled={ro} onChange={(e) => setAccent(e.target.value)} data-testid="cfg-accent" />
              </div>
              <FieldErr msg={hexErr} />
            </div>
            <div className="field">
              <label htmlFor="cfg-density">{t("cfg.density")}</label>
              <Select<AdminPayload["layout"]["density"]>
                id="cfg-density"
                label={t("cfg.density")}
                value={d.layout.density}
                disabled={ro}
                onChange={(v) => set({ ...d, layout: { ...d.layout, density: v } })}
                options={[
                  { v: "compact", label: "compact" },
                  { v: "comfortable", label: "comfortable" },
                ]}
                testId="cfg-density"
              />
            </div>
            <div className="field">
              <label htmlFor="cfg-p-users">{t("cfg.presetUsers")}</label>
              <Select<AdminPayload["layout"]["table_presets"]["users"]>
                id="cfg-p-users"
                label={t("cfg.presetUsers")}
                value={d.layout.table_presets.users}
                disabled={ro}
                onChange={(v) => set({ ...d, layout: { ...d.layout, table_presets: { ...d.layout.table_presets, users: v } } })}
                options={[
                  { v: "support", label: "support" },
                  { v: "analytics", label: "analytics" },
                ]}
              />
            </div>
            <div className="field">
              <label htmlFor="cfg-p-audit">{t("cfg.presetAudit")}</label>
              <Select<AdminPayload["layout"]["table_presets"]["audit"]>
                id="cfg-p-audit"
                label={t("cfg.presetAudit")}
                value={d.layout.table_presets.audit}
                disabled={ro}
                onChange={(v) => set({ ...d, layout: { ...d.layout, table_presets: { ...d.layout.table_presets, audit: v } } })}
                options={[
                  { v: "security", label: "security" },
                  { v: "full", label: "full" },
                ]}
              />
            </div>
            <div className="field">
              <span className="field-label">Feature flags</span>
              <Flags flags={d.flags} ro={ro} set={(flags) => set({ ...d, flags })} />
            </div>
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-h">
          <h2 className="panel-t">
            <Icon name="layout" />
            {t("cfg.widgets")}
          </h2>
          <span className="panel-sub">layout.dashboard_widgets</span>
        </div>
        <div className="panel-b stack sm">
          <Ordered<{ id: string; enabled: boolean }>
            items={d.layout.dashboard_widgets}
            label={(w) => w.id}
            sub={(w) => (WIDGET_KEYS.has(w.id) ? t(`cfg.wd.${w.id as "dau"}`) : w.id)}
            ro={ro}
            testId="cfg-widgets"
            set={(dashboard_widgets) => set({ ...d, layout: { ...d.layout, dashboard_widgets } })}
          />
          <p className="xs muted">{t("cfg.widgetsNote")}</p>
        </div>
      </section>
      <Callout kind="info" icon="info">
        {t("cfg.adminNote")}
      </Callout>
    </>
  );
}

/* ---------------------------------------------------------------- previews */

function PhonePreview({ d, version }: { d: MiniPayload; version: string | null }) {
  const { t } = useI18n();
  const [dark, setDark] = useState(true);
  const card = (n: number) => (
    <div className="ph-card" key={n}>
      <div className="ph-media" />
      <div className="ct">{t("cfg.ph.event", { n })}</div>
    </div>
  );
  return (
    <div className="stack sm" data-testid="cfg-preview">
      <div className="row between">
        <span className="field-label">{t("cfg.preview")}</span>
        <div className="seg-mini" role="group" aria-label={t("theme.label")}>
          <button type="button" aria-pressed={!dark} onClick={() => setDark(false)}>
            {t("theme.light")}
          </button>
          <button type="button" aria-pressed={dark} onClick={() => setDark(true)}>
            {t("theme.dark")}
          </button>
        </div>
      </div>
      <div className="phone" role="img" aria-label={t("cfg.preview")}>
        <div className={cx("phone-screen", dark && "is-dark")}>
          <div className="ph-top">
            <span className="wm">
              Ai<b>Event</b>
            </span>
            <span>{t("cfg.ph.hi")}</span>
          </div>
          <div className="ph-flags">
            {Object.keys(d.flags)
              .filter((k) => d.flags[k])
              .map((k) => (
                <span key={k}>{k}</span>
              ))}
          </div>
          <div className="ph-body">
            {d.home.sections
              .filter((s) => s.enabled)
              .map((s) => (
                <div className="ph-sec" key={s.key} data-sec={s.key}>
                  <div className="h">
                    <span>{secLabel(t, s.key)}</span>
                    <span>{s.variant}</span>
                  </div>
                  {s.variant === "large" ? (
                    <div className="ph-car">{[1, 2].map(card)}</div>
                  ) : (
                    <div className="ph-list">
                      {[1, 2].map((n) => (
                        <div className="ph-li" key={n}>
                          <i />
                          <span>{t("cfg.ph.item", { n })}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
          </div>
          <div className="ph-tab">
            <span>{t("cfg.ph.home")}</span>
            <span>Watch</span>
            {d.flags.ai_concierge && <span>AI</span>}
            <span>{t("cfg.ph.profile")}</span>
          </div>
        </div>
      </div>
      <p className="xs muted" style={{ textAlign: "center" }}>
        {t("cfg.previewNote", { v: version ?? "—", th: d.theme.version })}
      </p>
    </div>
  );
}

const SWATCHES = ["--nav", "--accent", "--primary", "--info", "--good", "--warn", "--bad", "--bg", "--surface"];

function AdminPreview({ d }: { d: AdminPayload }) {
  const { t } = useI18n();
  return (
    <section className="panel" data-testid="cfg-preview">
      <div className="panel-h">
        <h3 className="panel-t">{t("cfg.preview")}</h3>
      </div>
      <div className="panel-b stack sm">
        <div className="row">
          <span className="tag">theme: {d.theme.id}</span>
          <span className="tag">density: {d.layout.density}</span>
        </div>
        <div className="token-swatches">
          {SWATCHES.filter((k) => d.theme.tokens[k] && isColor(d.theme.tokens[k]!)).map((k) => (
            <span key={k}>
              <i style={{ background: d.theme.tokens[k] }} />
              {k}
            </span>
          ))}
        </div>
        <div className="table-wrap">
          <table className={cx("tbl", d.layout.density === "compact" ? "dense" : undefined)}>
            <thead>
              <tr>
                <th>User ID</th>
                <th>Telegram</th>
                <th>{t("users.col.tickets")}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">3f9a…c21</td>
                <td>@demo_user</td>
                <td>1</td>
              </tr>
              <tr>
                <td className="mono">7b20…e04</td>
                <td>@travel_user</td>
                <td>0</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="xs muted">{t("cfg.adminPrevNote")}</p>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- new version */

function SaveVersion({ app, existing, changes, draft, onClose, onSaved }: { app: ConfigApp; existing: string[]; changes: string[]; draft: Payload; onClose: () => void; onSaved: (v: ConfigVersion) => Promise<void> }) {
  const i = useI18n();
  const { t } = i;
  const [version, setVersion] = useState(() => nextVersion(existing));
  const [note, setNote] = useState("");
  const [err, setErr] = useState<{ v?: string; n?: string; g?: string }>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const e: typeof err = {};
    if (!SEMVER.test(version.trim())) e.v = t("cfg.errVersion");
    else if (existing.includes(version.trim())) e.v = t("err.EXPERIENCE_VERSION_EXISTS");
    if (note.trim().length < 3) e.n = t("cfg.errNote");
    setErr(e);
    if (e.v || e.n) return;
    const v = version.trim();
    const payload = clone(draft) as Payload;
    // a changed admin theme gets the new version as its theme version (the tokens are part of this version)
    if (app === "admin" && changes.some((c) => c.startsWith("--accent") || c.startsWith("theme.id"))) payload.theme.version = v;
    setBusy(true);
    try {
      const res = await Experience.create(app, v, payload as unknown as Record<string, unknown>, note.trim());
      await onSaved(res);
    } catch (ex) {
      setBusy(false);
      if ((ex as ApiError).cancelled) return;
      const path = ex instanceof ApiError ? ex.str("path") : null;
      setErr({ g: path ? `${errText(i, ex)} · ${path}` : errText(i, ex) });
    }
  };
  return (
    <Modal
      title={t("cfg.saveT")}
      text={t("cfg.saveM")}
      icon="layers"
      onClose={() => !busy && onClose()}
      testId="cfg-save-modal"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn kind="primary" label={t("cfg.saveVersion")} busy={busy} onClick={() => void submit()} testId="cfg-save-ok" />
        </>
      }
    >
      <ul className="ent-list mb-12">
        {changes.map((c) => (
          <li key={c}>
            <span className="on">
              <Icon name="right" />
            </span>
            <span className="mono small">{c}</span>
          </li>
        ))}
      </ul>
      <div className="field">
        <label htmlFor="cfg-ver" className="req">
          {t("cfg.version")}
        </label>
        <input id="cfg-ver" className={cx("input mono", err.v && "is-invalid")} value={version} maxLength={14} onChange={(e) => setVersion(e.target.value)} data-autofocus="" />
        <FieldErr msg={err.v} />
      </div>
      <div className="field mt-12">
        <label htmlFor="cfg-note" className="req">
          change_note
        </label>
        <textarea id="cfg-note" className={cx("textarea", err.n && "is-invalid")} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("cfg.notePh")} />
        <FieldErr msg={err.n} />
      </div>
      <FieldErr msg={err.g} />
      <p className="xs muted row mt-8">
        <Icon name="audit" /> {t("cfg.saveFoot")}
      </p>
    </Modal>
  );
}
