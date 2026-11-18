/**
 * «Конфигурация интерфейса» (config.read / config.edit / config.publish): Remote Experience Config of the Mini App
 * (theme «Тетрадь», Home sections, flags) and of the admin (theme tokens, density, order and switches of the menu).
 * Versions are immutable; activation and rollback are new activations (step-up, reason → audit) and apply without a
 * build: the Mini App and the admin re-read the configuration on the next open (the admin — immediately here).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConfigActivation, ConfigApp, ConfigState, ConfigVersion } from "@tilhero/contracts/admin";
import { Experience } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n } from "../../i18n";
import { redactSecrets } from "../../lib/redact";
import { navItem, PAGE_IDS, type PageId } from "../../state/nav";
import { useSession } from "../../state/session";
import { isColor } from "../../theme/config";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, JsonView, Pill, Select, Seg, Spinner, Switch } from "../../ui/kit";
import { ConfirmCommand, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";

/* ---------------------------------------------------------------- payload shapes (experience-config domain/payload.py) */

export const SECTION_TYPES = ["today_plan", "lesson_of_day", "review", "whats_new", "family", "news"] as const;
export interface Section {
  type: (typeof SECTION_TYPES)[number];
  key: string;
  variant: "large" | "compact";
  enabled: boolean;
}
export interface MiniPayload {
  theme: { id: "notebook" | "notebook_dark"; version: string; tokens: Record<string, string> };
  home: { sections: Section[] };
  flags: Record<string, boolean>;
}
export interface AdminPayload {
  theme: { id: "admin_light"; version: string; tokens: Record<string, string> };
  layout: { density: "compact" | "comfortable"; menu: Array<{ id: string; enabled: boolean }> };
  flags: Record<string, boolean>;
}
type Payload = MiniPayload | AdminPayload;

const SEMVER = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
const HEX6 = /^#[0-9a-f]{6}$/i;

/** Next free patch version after the highest existing one (1.0.3 → 1.0.4). */
export function nextVersion(existing: readonly string[]): string {
  const parsed = existing.filter((v) => SEMVER.test(v)).map((v) => v.split(".").map(Number) as [number, number, number]);
  if (!parsed.length) return "1.0.0";
  parsed.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const [M, m, p] = parsed[parsed.length - 1]!;
  return `${M}.${m}.${p + 1}`;
}

/** Colour tokens the editor offers (the rest of the whitelist stays as in the base version). */
export const MINI_COLORS = ["--pen", "--mark", "--margin", "--paper"] as const;
export const ADMIN_COLORS = ["--pen", "--side", "--bg"] as const;

/** Human list of what the draft changes against the base payload (shown before saving a version). */
export function payloadChanges(app: ConfigApp, base: Payload, draft: Payload): string[] {
  const out: string[] = [];
  const flags = (a: Record<string, boolean>, b: Record<string, boolean>) => {
    for (const k of Object.keys(b)) if (a[k] !== b[k]) out.push(`flag ${k}: ${a[k] ?? "∅"} → ${b[k]}`);
  };
  const tokens = (a: Record<string, string>, b: Record<string, string>) => {
    for (const k of Object.keys(b)) if (a[k] !== b[k]) out.push(`${k}: ${a[k] ?? "∅"} → ${b[k]}`);
  };
  if (app === "miniapp") {
    const a = base as MiniPayload;
    const b = draft as MiniPayload;
    if (a.theme.id !== b.theme.id) out.push(`theme.id: ${a.theme.id} → ${b.theme.id}`);
    tokens(a.theme.tokens, b.theme.tokens);
    if (a.home.sections.map((s) => s.key).join() !== b.home.sections.map((s) => s.key).join()) out.push("home.sections: order");
    for (const s of b.home.sections) {
      const o = a.home.sections.find((x) => x.key === s.key);
      if (!o) continue;
      if (o.enabled !== s.enabled) out.push(`${s.key}: ${s.enabled ? "on" : "off"}`);
      if (o.variant !== s.variant) out.push(`${s.key}: ${o.variant} → ${s.variant}`);
    }
    flags(a.flags, b.flags);
  } else {
    const a = base as AdminPayload;
    const b = draft as AdminPayload;
    tokens(a.theme.tokens, b.theme.tokens);
    if (a.layout.density !== b.layout.density) out.push(`density: ${a.layout.density} → ${b.layout.density}`);
    if (a.layout.menu.map((m) => m.id).join() !== b.layout.menu.map((m) => m.id).join()) out.push("layout.menu: order");
    for (const m of b.layout.menu) {
      const o = a.layout.menu.find((x) => x.id === m.id);
      if (o && o.enabled !== m.enabled) out.push(`menu ${m.id}: ${m.enabled ? "on" : "off"}`);
    }
    flags(a.flags, b.flags);
  }
  return out;
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const isMini = (app: ConfigApp, _p: Payload): _p is MiniPayload => app === "miniapp";

/* ---------------------------------------------------------------- page */

export function ConfigPage() {
  const { t } = useI18n();
  const [app, setApp] = useState<ConfigApp>("miniapp");
  return (
    <div className="stack" data-testid="config">
      <p className="sub page-lead">{t("cfg.lead")}</p>
      <Seg<ConfigApp>
        label={t("page.config")}
        value={app}
        onChange={setApp}
        testId="cfg-app"
        items={[
          { v: "miniapp", label: t("cfg.app.miniapp") },
          { v: "admin", label: t("cfg.app.admin") },
        ]}
      />
      <AppConfig key={app} app={app} />
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
  const [editing, setEditing] = useState(false);
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
    if (app === "admin") await reloadTheme(); // the admin look follows the active version without a rebuild
  };

  return (
    <>
      <div className="grid2">
        <section className="panel" data-testid="cfg-versions">
          <div className="panel-h">
            <h2 className="panel-t">
              <Icon name="layers" />
              {t(app === "miniapp" ? "cfg.versionsMini" : "cfg.versionsAdmin")}
            </h2>
          </div>
          <div className="table-wrap">
            <table className="tbl compact">
              <thead>
                <tr>
                  <th scope="col">{t("cfg.col.version")}</th>
                  <th scope="col">{t("cfg.col.note")}</th>
                  <th scope="col">{t("cfg.col.by")}</th>
                  <th scope="col">{t("cfg.col.state")}</th>
                  <th scope="col">
                    <span className="sr-only">{t("cfg.activate")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((v) => {
                  const isCur = v.version === cur;
                  return (
                    <tr key={v.version_id} className={isCur ? "is-sel" : undefined} data-testid={`ver-${v.version}`}>
                      <td className="mono b nowrap">{v.version}</td>
                      <td className="small wrap-any">{v.change_note}</td>
                      <td className="small nowrap">
                        {v.created_by}
                        <div className="cell-sub">{i.fmt.date(v.created_at)}</div>
                      </td>
                      <td>{isCur ? <Pill tone="good">{t("cfg.current")}</Pill> : v.version === prev ? <Pill tone="neutral">{t("cfg.previous")}</Pill> : <span className="muted small">—</span>}</td>
                      <td className="actions-cell">{!isCur && <Btn size="xs" icon="zap" label={t("cfg.activate")} perm="config.publish" onClick={() => setCmd({ kind: "activate", version: v.version })} testId={`activate-${v.version}`} />}</td>
                    </tr>
                  );
                })}
                {!sorted.length && (
                  <tr>
                    <td colSpan={5} className="empty-cell">
                      <Empty icon="layers" title={t("cfg.noVersions")} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card stack sm" data-testid="cfg-current">
          <h2 className="h2">{t("cfg.currentT", { v: cur ?? "—" })}</h2>
          {base ? <JsonView value={redactSecrets(base)} className="cfg-json" testId="cfg-payload" /> : <Empty icon="sliders" title={t("cfg.noCurrent")} />}
          <div className="acts">
            {prev ? (
              <Btn icon="rollback" label={t("cfg.rollback", { v: prev })} perm="config.publish" onClick={() => setCmd({ kind: "rollback" })} testId="cfg-rollback" />
            ) : (
              <Btn icon="rollback" label={t("cfg.rollbackNone")} disabled />
            )}
            {base && !editing && <Btn icon="edit" label={t("cfg.newVersion")} perm="config.edit" onClick={() => setEditing(true)} testId="cfg-edit" />}
          </div>
          <p className="sub">{t("cfg.noRebuild")}</p>
        </section>
      </div>

      {editing && draft && base && (
        <div className="cfg-layout" data-testid="cfg-editor">
          <div className="stack">
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
                <Btn
                  kind="ghost"
                  label={t("common.cancel")}
                  onClick={() => {
                    setDraft(clone(base));
                    setEditing(false);
                  }}
                />
                <Btn kind="primary" icon="plus" label={t("cfg.saveVersion")} perm="config.edit" disabled={!changes.length} onClick={() => setSaving(true)} testId="cfg-save" />
              </div>
            </section>
          </div>
          <aside className="cfg-preview">{isMini(app, draft) ? <MiniPreview d={draft} /> : <AdminPreview d={draft as AdminPayload} />}</aside>
        </div>
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
                <th scope="col">{t("cfg.col.when")}</th>
                <th scope="col">{t("cfg.col.kind")}</th>
                <th scope="col">{t("cfg.col.version")}</th>
                <th scope="col">{t("cmd.reason")}</th>
                <th scope="col">{t("cfg.col.by")}</th>
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
            setEditing(false);
            toast(t("cfg.created", { v: v.version }), "ok", t("cfg.createdM"));
            await load();
          }}
        />
      )}
    </>
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
            <span className="b">{sub(x)}</span>
            <span className="small muted block mono">{label(x)}</span>
          </span>
          {extra?.(x, idx)}
          <span className="mv">
            <Btn size="xs" kind="ghost" icon="up" aria={`${t("cfg.up")}: ${sub(x)}`} disabled={ro || idx === 0} onClick={() => move(idx, -1)} />
            <Btn size="xs" kind="ghost" icon="down" aria={`${t("cfg.down")}: ${sub(x)}`} disabled={ro || idx === items.length - 1} onClick={() => move(idx, 1)} />
          </span>
          <Switch id={`ol-${label(x)}`} checked={x.enabled} disabled={ro} aria={sub(x)} onChange={(v) => set(items.map((y, k) => (k === idx ? { ...y, enabled: v } : y)))} />
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

function ColorField({ id, label, value, ro, onChange }: { id: string; label: string; value: string; ro: boolean; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const [hex, setHex] = useState(value);
  useEffect(() => setHex(value), [value]);
  const err = HEX6.test(hex.trim()) && isColor(hex.trim()) ? null : t("cfg.colorErr");
  const set = (v: string) => {
    setHex(v);
    if (HEX6.test(v.trim())) onChange(v.trim().toUpperCase());
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="row nowrap-row">
        <input type="color" className="color-in" value={HEX6.test(hex) ? hex : "#000000"} disabled={ro} aria-label={label} onChange={(e) => set(e.target.value)} />
        <input id={id} className={cx("input mono grow", err && "is-invalid")} value={hex} maxLength={7} disabled={ro} aria-invalid={!!err || undefined} onChange={(e) => set(e.target.value)} data-testid={id} />
      </div>
      <FieldErr msg={err} />
    </div>
  );
}

function MiniEditor({ d, set, ro }: { d: MiniPayload; set: (d: MiniPayload) => void; ro: boolean }) {
  const { t } = useI18n();
  return (
    <>
      <section className="panel">
        <div className="panel-h">
          <h2 className="panel-t">
            <Icon name="sliders" />
            {t("cfg.theme")}
          </h2>
          <span className="panel-sub">theme</span>
        </div>
        <div className="panel-b form-grid">
          <div className="field">
            <label htmlFor="cfg-m-theme">{t("cfg.themeId")}</label>
            <Select<MiniPayload["theme"]["id"]>
              id="cfg-m-theme"
              label={t("cfg.themeId")}
              value={d.theme.id}
              disabled={ro}
              onChange={(v) => set({ ...d, theme: { ...d.theme, id: v } })}
              options={[
                { v: "notebook", label: t("cfg.th.notebook") },
                { v: "notebook_dark", label: t("cfg.th.notebook_dark") },
              ]}
            />
          </div>
          {MINI_COLORS.filter((k) => d.theme.tokens[k] != null).map((k) => (
            <ColorField key={k} id={`cfg-m${k}`} label={`${t(`cfg.tok.${k}`)} (${k})`} value={d.theme.tokens[k]!} ro={ro} onChange={(v) => set({ ...d, theme: { ...d.theme, tokens: { ...d.theme.tokens, [k]: v } } })} />
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-h">
          <h2 className="panel-t">
            <Icon name="layout" />
            {t("cfg.home")}
          </h2>
          <span className="panel-sub">home.sections</span>
        </div>
        <div className="panel-b">
          <Ordered<Section>
            items={d.home.sections}
            label={(s) => s.key}
            sub={(s) => ((SECTION_TYPES as readonly string[]).includes(s.type) ? t(`cfg.sec.${s.type}`) : s.type)}
            ro={ro}
            testId="cfg-sections"
            set={(sections) => set({ ...d, home: { sections } })}
            extra={(s, idx) => (
              <Select<Section["variant"]>
                id={`var-${s.key}`}
                label={t("cfg.variant", { s: s.key })}
                value={s.variant}
                disabled={ro}
                onChange={(v) => set({ ...d, home: { sections: d.home.sections.map((x, k) => (k === idx ? { ...x, variant: v } : x)) } })}
                options={[
                  { v: "large", label: t("cfg.v.large") },
                  { v: "compact", label: t("cfg.v.compact") },
                ]}
              />
            )}
          />
        </div>
      </section>
      <section className="panel">
        <div className="panel-h">
          <h2 className="panel-t">
            <Icon name="zap" />
            {t("cfg.flags")}
          </h2>
        </div>
        <div className="panel-b">
          <Flags flags={d.flags} ro={ro} set={(flags) => set({ ...d, flags })} />
        </div>
      </section>
    </>
  );
}

function AdminEditor({ d, set, ro }: { d: AdminPayload; set: (d: AdminPayload) => void; ro: boolean }) {
  const { t } = useI18n();
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
        <div className="panel-b form-grid">
          {ADMIN_COLORS.filter((k) => d.theme.tokens[k] != null).map((k) => (
            <ColorField key={k} id={`cfg-a${k}`} label={`${t(`cfg.tok.${k}`)} (${k})`} value={d.theme.tokens[k]!} ro={ro} onChange={(v) => set({ ...d, theme: { ...d.theme, tokens: { ...d.theme.tokens, [k]: v } } })} />
          ))}
          <div className="field">
            <label htmlFor="cfg-density">{t("cfg.density")}</label>
            <Select<AdminPayload["layout"]["density"]>
              id="cfg-density"
              label={t("cfg.density")}
              value={d.layout.density}
              disabled={ro}
              onChange={(v) => set({ ...d, layout: { ...d.layout, density: v } })}
              options={[
                { v: "compact", label: t("cfg.d.compact") },
                { v: "comfortable", label: t("cfg.d.comfortable") },
              ]}
              testId="cfg-density"
            />
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-h">
          <h2 className="panel-t">
            <Icon name="layout" />
            {t("cfg.menu")}
          </h2>
          <span className="panel-sub">layout.menu</span>
        </div>
        <div className="panel-b stack sm">
          <Ordered<{ id: string; enabled: boolean }>
            items={d.layout.menu}
            label={(m) => m.id}
            sub={(m) => ((PAGE_IDS as readonly string[]).includes(m.id) ? t(`page.${m.id as PageId}`) : m.id)}
            ro={ro}
            testId="cfg-menu"
            set={(menu) => set({ ...d, layout: { ...d.layout, menu } })}
            extra={(m) => (navItem(m.id)?.soon ? <span className="soon-tag">{t("nav.soonN", { n: navItem(m.id)!.soon! })}</span> : null)}
          />
          <p className="xs muted">{t("cfg.menuNote")}</p>
        </div>
      </section>
    </>
  );
}

/* ---------------------------------------------------------------- previews */

function MiniPreview({ d }: { d: MiniPayload }) {
  const { t } = useI18n();
  const tk = d.theme.tokens;
  const style = {
    "--ph-paper": tk["--paper"] ?? "#FBFCFE",
    "--ph-pen": tk["--pen"] ?? "#2F4BE0",
    "--ph-mark": tk["--mark"] ?? "#FFE45C",
    "--ph-margin": tk["--margin"] ?? "#F2A7B0",
  } as React.CSSProperties;
  return (
    <div className="stack sm" data-testid="cfg-preview">
      <span className="field-label">{t("cfg.preview")}</span>
      <div className={cx("phone cfg-phone", d.theme.id === "notebook_dark" && "is-dark")} style={style} role="img" aria-label={t("cfg.preview")}>
        <div className="cp-paper">
          <div className="cp-hi">TilHero</div>
          {d.home.sections
            .filter((s) => s.enabled)
            .map((s) => (
              <div key={s.key} className={cx("cp-sec", s.variant === "large" && "is-large")} data-sec={s.key}>
                <span>{t(`cfg.sec.${s.type}`)}</span>
              </div>
            ))}
        </div>
      </div>
      <p className="xs muted center">{t("cfg.previewNote")}</p>
    </div>
  );
}

const ADMIN_SWATCHES = ["--side", "--pen", "--pen-soft", "--bg", "--card", "--ink", "--ok", "--warn", "--err"];

function AdminPreview({ d }: { d: AdminPayload }) {
  const { t } = useI18n();
  const on = d.layout.menu.filter((m) => m.enabled);
  return (
    <section className="panel" data-testid="cfg-preview">
      <div className="panel-h">
        <h3 className="panel-t">{t("cfg.preview")}</h3>
      </div>
      <div className="panel-b stack sm">
        <div className="row">
          <span className="tag">density: {d.layout.density}</span>
          <span className="tag">{t("cfg.menuOn", { n: on.length, m: d.layout.menu.length })}</span>
        </div>
        <div className="token-swatches">
          {ADMIN_SWATCHES.filter((k) => d.theme.tokens[k] && isColor(d.theme.tokens[k]!)).map((k) => (
            <span key={k}>
              <i style={{ background: d.theme.tokens[k] }} />
              {k}
            </span>
          ))}
        </div>
        <div className="mini-side" style={{ background: d.theme.tokens["--side"] }} aria-hidden="true">
          {on.slice(0, 6).map((m, k) => (
            <span key={m.id} className={k === 0 ? "on" : undefined} style={k === 0 ? { background: d.theme.tokens["--pen"] } : undefined}>
              {(PAGE_IDS as readonly string[]).includes(m.id) ? t(`page.${m.id as PageId}`) : m.id}
            </span>
          ))}
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
    // changed tokens are part of this version: the theme gets the new version number
    if (changes.some((c) => c.startsWith("--") || c.startsWith("theme.id"))) payload.theme.version = v;
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
        <input id="cfg-ver" className={cx("input mono", err.v && "is-invalid")} value={version} maxLength={14} onChange={(e) => setVersion(e.target.value)} aria-invalid={!!err.v || undefined} data-autofocus="" />
        <FieldErr msg={err.v} />
      </div>
      <div className="field mt-12">
        <label htmlFor="cfg-note" className="req">
          {t("cfg.note")}
        </label>
        <textarea id="cfg-note" className={cx("textarea", err.n && "is-invalid")} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("cfg.notePh")} aria-invalid={!!err.n || undefined} />
        <FieldErr msg={err.n} />
      </div>
      <FieldErr msg={err.g} />
      <p className="xs muted row mt-8">
        <Icon name="audit" /> {t("cfg.saveFoot")}
      </p>
    </Modal>
  );
}
