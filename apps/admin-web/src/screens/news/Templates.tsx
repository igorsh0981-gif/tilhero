/**
 * «Шаблоны уведомлений» (notif.templates.manage): the editable templates of notifications by category; versions over
 * the texts of the code (RU and UZ both required, only the template's placeholders), live preview with sample values,
 * server preview of a saved version, test send to the test chats only, activation and reset to the default text
 * (step-up, reason → audit `template.*`). Child templates (`kid`) are checked for pressure words.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NotificationCategory, TemplateInfo, TemplatePreview, TemplateTexts, TemplateVersion, TestRecipient, UiLang } from "@tilhero/contracts/admin";
import { Templates } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Select, Spinner, TabPanel, Tabs, type Tone } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errMeta, errText } from "../../ui/errors";
import { checkTexts, cloneTexts, issuesIn, LANGS, normalizeTexts, sameJson, samples, serverIssues, substitute, TEXT_LIMITS, type Issues } from "./catalog";
import { PreviewControls, TelegramMessage, TextInput, useInsertAtCaret } from "./parts";

/** sprint 7: + game (leagues, duels; the category switchable by the learner like the others) */
export const TEMPLATE_CATEGORIES: ReadonlyArray<Exclude<NotificationCategory, "service">> = ["reminders", "missed", "social", "game", "support", "product"];
const VER_TONE: Record<TemplateVersion["status"], Tone> = { active: "good", draft: "warn", archived: "neutral" };

type Detail = TemplateInfo & { versions: TemplateVersion[] };
type Cmd = { kind: "activate"; v: TemplateVersion } | { kind: "reset" } | null;

export function TemplatesTab({ openKey }: { openKey: string | null }) {
  const i = useI18n();
  const { t } = i;
  const [items, setItems] = useState<TemplateInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [key, setKey] = useState<string | null>(openKey);

  const load = useCallback(async () => {
    try {
      const r = await Templates.list();
      setItems(r.items);
      setError(null);
      setKey((k) => k ?? r.items[0]?.key ?? null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !items) return <LoadError error={error} onRetry={() => void load()} />;
  if (!items) return <Spinner label={t("common.loading")} />;
  if (!items.length) return <Empty icon="template" title={t("tpl.none")} />;

  return (
    <div className="tpl-layout" data-testid="templates">
      <nav className="panel tpl-list" aria-label={t("tpl.list")}>
        {TEMPLATE_CATEGORIES.map((c) => {
          const xs = items.filter((x) => x.category === c);
          if (!xs.length) return null;
          return (
            <div key={c} className="tpl-grp">
              <div className="tpl-grp-h">{t(`ncat.${c}`)}</div>
              <ul>
                {xs.map((x) => (
                  <li key={x.key}>
                    <button type="button" className={cx("tpl-li", key === x.key && "is-active")} aria-current={key === x.key ? "true" : undefined} onClick={() => setKey(x.key)} data-testid={`tpl-${x.key}`}>
                      <span className="tpl-li-t">{i.l(x.description)}</span>
                      <span className="tpl-li-m">
                        <span className="mono xs muted">{x.key}</span>
                        {x.kid && <span className="tag plain kid">{t("tpl.kid")}</span>}
                        {x.active_version != null ? <Pill tone="good">v{x.active_version}</Pill> : <Pill tone="neutral">{t("tpl.default")}</Pill>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      {key ? <TemplateDetail key={key} tkey={key} onChanged={() => void load()} /> : <Empty icon="template" title={t("tpl.pick")} />}
    </div>
  );
}

function TemplateDetail({ tkey, onChanged }: { tkey: string; onChanged: () => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const toast = useToast();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [texts, setTexts] = useState<TemplateTexts | null>(null);
  const [base, setBase] = useState<TemplateTexts | null>(null);
  const [baseFrom, setBaseFrom] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [lang, setLang] = useState<UiLang>("ru");
  const [pvLang, setPvLang] = useState<UiLang>("ru");
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Issues>({});
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cmd, setCmd] = useState<Cmd>(null);
  const [spv, setSpv] = useState<{ v: number; p: TemplatePreview } | null>(null);
  const key = useRef<string | null>(null);
  const ins = useInsertAtCaret();

  const load = useCallback(async (keepEditor = false) => {
    try {
      const x = await Templates.get(tkey);
      setD(x);
      setError(null);
      if (!keepEditor) {
        const active = x.versions.find((v) => v.status === "active");
        const src = active ? active.texts : x.default_texts;
        setTexts(cloneTexts(src));
        setBase(cloneTexts(src));
        setBaseFrom(active?.version ?? null);
      }
      return x;
    } catch (e) {
      setError(e);
      return null;
    }
  }, [tkey]);
  useEffect(() => {
    void load();
  }, [load]);

  const allowed = useMemo(() => (d ? d.placeholders.map((p) => p.name) : []), [d]);
  const live = useMemo(() => (texts && d ? checkTexts(texts, allowed, d.kid) : {}), [texts, d, allowed]);
  // precise issues (unknown placeholder, length, pressure) are shown at once; «required» — after a save attempt or
  // when the other language already has text
  const shown: Issues = useMemo(() => {
    if (!texts) return {};
    const out: Issues = { ...server };
    for (const [p, x] of Object.entries(live)) {
      if (x.reason !== "required" || tried) out[p] = x;
      else {
        const [, l, f] = p.split(".") as [string, UiLang, "title" | "body"];
        const other = texts[l === "ru" ? "uz" : "ru"][f];
        if (other?.trim()) out[p] = x;
      }
    }
    return out;
  }, [live, server, tried, texts]);

  if (error && !d) return <LoadError error={error} onRetry={() => void load()} />;
  if (!d || !texts || !base) return <Spinner label={t("common.loading")} />;

  const editable = can("notif.templates.manage");
  const dirty = !sameJson(normalizeTexts(texts), normalizeTexts(base));
  const setField = (l: UiLang, f: "title" | "body" | "button", v: string) => {
    setTexts((x) => (x ? { ...x, [l]: { ...x[l], [f]: f === "button" ? (v === "" ? null : v) : v } } : x));
    setServer({});
    setFormErr(null);
    key.current = null;
  };
  const vals = samples(d.placeholders, pvLang);
  const cur = texts[pvLang];

  const save = async () => {
    if (saving) return;
    setTried(true);
    const e = checkTexts(texts, allowed, d.kid);
    const noteBad = note.trim().length < 3 || note.trim().length > 300;
    if (Object.keys(e).length || noteBad) {
      setFormErr(Object.keys(e).length ? t("tpl.errForm") : t("tpl.errNote"));
      const l = LANGS.find((x) => issuesIn(e, x));
      if (l) setLang(l);
      return;
    }
    setSaving(true);
    setFormErr(null);
    try {
      const v = await Templates.createVersion(tkey, normalizeTexts(texts), note.trim(), key.current ?? (key.current = uuid()));
      toast(t("tpl.saved", { v: v.version }), "ok", "template.version_created");
      key.current = null;
      setNote("");
      setTried(false);
      await load();
      setBaseFrom(null);
      onChanged();
    } catch (ex) {
      if ((ex as ApiError).cancelled) return;
      if (ex instanceof ApiError && ex.status === 422) {
        const si = serverIssues(ex.details);
        setServer(si);
        const l = LANGS.find((x) => issuesIn(si, x));
        if (l) setLang(l);
      }
      setFormErr(errText(i, ex));
    } finally {
      setSaving(false);
    }
  };

  const serverPreview = async (v: TemplateVersion) => {
    try {
      const p = await Templates.preview(tkey, v.version, pvLang);
      setSpv({ v: v.version, p });
    } catch (e) {
      if (!(e as ApiError).cancelled) toast(errText(i, e), "err", errMeta(e));
    }
  };

  const active = d.versions.find((v) => v.status === "active") ?? null;
  return (
    <div className="stack tpl-detail" data-testid="tpl-detail">
      <section className="card stack sm">
        <div className="row between">
          <div>
            <div className="crumb">
              {t(`ncat.${d.category}`)} · <span className="mono">{d.key}</span>
            </div>
            <h2 className="h2" data-testid="tpl-title">
              {i.l(d.description)}
            </h2>
          </div>
          <span className="row">
            {d.kid && <span className="tag plain kid">{t("tpl.kid")}</span>}
            {active ? <Pill tone="good">{t("tpl.activeV", { v: active.version })}</Pill> : <Pill>{t("tpl.defaultText")}</Pill>}
            {d.active_version != null && <Btn size="sm" icon="rollback" label={t("tpl.reset")} perm="notif.templates.manage" onClick={() => setCmd({ kind: "reset" })} testId="tpl-reset" />}
          </span>
        </div>
        {d.kid && (
          <Callout kind="info" icon="shield">
            {t("tpl.kidNote")}
          </Callout>
        )}
      </section>

      <section className="panel" data-testid="tpl-versions">
        <div className="panel-h">
          <h3 className="panel-t">
            <Icon name="layers" />
            {t("tpl.versions")}
          </h3>
          <span className="panel-sub">{t("tpl.versionsSub")}</span>
        </div>
        {d.versions.length ? (
          <div className="table-wrap">
            <table className="tbl compact">
              <thead>
                <tr>
                  <th scope="col">{t("tpl.col.v")}</th>
                  <th scope="col">{t("col.status")}</th>
                  <th scope="col">{t("tpl.col.note")}</th>
                  <th scope="col">{t("tpl.col.by")}</th>
                  <th scope="col">
                    <span className="sr-only">{t("tpl.col.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.versions.map((v) => (
                  <tr key={v.version} className={v.status === "active" ? "is-sel" : undefined} data-testid={`tpl-v-${v.version}`}>
                    <td className="mono b">v{v.version}</td>
                    <td>
                      <Pill tone={VER_TONE[v.status]}>{t(`tpl.st.${v.status}`)}</Pill>
                    </td>
                    <td className="small wrap-any">{v.note}</td>
                    <td className="small nowrap">
                      {v.created_by_name ?? v.created_by}
                      <div className="cell-sub">{v.activated_at ? t("tpl.activatedAt", { t: fmt.dateTime(v.activated_at) }) : fmt.dateTime(v.created_at)}</div>
                    </td>
                    <td className="actions-cell">
                      <Btn
                        size="xs"
                        kind="ghost"
                        icon="edit"
                        aria={t("tpl.toEditorV", { v: v.version })}
                        title={t("tpl.toEditor")}
                        onClick={() => {
                          setTexts(cloneTexts(v.texts));
                          setBase(cloneTexts(v.texts));
                          setBaseFrom(v.version);
                          setServer({});
                          setTried(false);
                        }}
                      />
                      <Btn size="xs" kind="ghost" icon="eye" aria={t("tpl.serverPvV", { v: v.version })} title={t("tpl.serverPv")} onClick={() => void serverPreview(v)} testId={`tpl-spv-${v.version}`} />
                      {v.status !== "active" && <Btn size="xs" icon="zap" label={t("tpl.activate")} perm="notif.templates.manage" onClick={() => setCmd({ kind: "activate", v })} testId={`tpl-activate-${v.version}`} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="panel-b">
            <p className="sub">{t("tpl.noVersions")}</p>
          </div>
        )}
      </section>

      <section className="card tpl-editor" aria-labelledby="tpl-ed-h" data-testid="tpl-editor">
        <div className="tpl-ed-col stack sm">
          <div className="row between">
            <h3 className="h2" id="tpl-ed-h">
              {t("tpl.editor")}
            </h3>
            <span className="xs muted">{baseFrom != null ? t("tpl.basedOn", { v: baseFrom }) : t("tpl.basedDefault")}</span>
          </div>
          <Tabs<UiLang>
            id="tpl-lang"
            label={t("wn.langTabs")}
            value={lang}
            onChange={setLang}
            items={LANGS.map((l) => ({ v: l, label: t(`ulang.${l}`), cnt: issuesIn(shown, l) || null, bad: true, testId: `tpl-lang-${l}` }))}
          />
          <TabPanel id="tpl-lang" value={lang}>
            <div className="stack sm">
              <TextInput id={`tpl-title-${lang}`} label={t("tpl.f.title")} value={texts[lang].title} max={TEXT_LIMITS.title} lang={lang} disabled={!editable} issue={shown[`texts.${lang}.title`]} missing={shown[`texts.${lang}.title`]?.reason === "required"} onChange={(v) => setField(lang, "title", v)} onFocusEl={ins.track((v) => setField(lang, "title", v))} testId={`tpl-title-${lang}`} />
              <TextInput id={`tpl-body-${lang}`} label={t("tpl.f.body")} value={texts[lang].body} max={TEXT_LIMITS.body} lang={lang} multiline rows={5} disabled={!editable} issue={shown[`texts.${lang}.body`]} missing={shown[`texts.${lang}.body`]?.reason === "required"} onChange={(v) => setField(lang, "body", v)} onFocusEl={ins.track((v) => setField(lang, "body", v))} testId={`tpl-body-${lang}`} />
              <TextInput id={`tpl-button-${lang}`} label={t("tpl.f.button")} value={texts[lang].button ?? ""} max={TEXT_LIMITS.button} lang={lang} required={false} placeholder={t("tpl.f.buttonPh")} disabled={!editable} issue={shown[`texts.${lang}.button`]} onChange={(v) => setField(lang, "button", v)} onFocusEl={ins.track((v) => setField(lang, "button", v))} testId={`tpl-button-${lang}`} />
            </div>
          </TabPanel>
          <div className="ph-chips" role="group" aria-label={t("tpl.placeholders")}>
            <span className="field-label">{t("tpl.placeholders")}</span>
            {d.placeholders.length ? (
              d.placeholders.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="chip"
                  disabled={!editable}
                  title={`${i.l(p.description)} · ${p.sample[lang]}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (!ins.insert(`{${p.name}}`)) setField(lang, "body", `${texts[lang].body}${texts[lang].body && !texts[lang].body.endsWith(" ") ? " " : ""}{${p.name}}`);
                  }}
                  data-testid={`ph-${p.name}`}
                >
                  <Icon name="braces" />
                  {p.name}
                </button>
              ))
            ) : (
              <span className="xs muted">{t("tpl.noPlaceholders")}</span>
            )}
          </div>
          <p className="xs muted">{t("tpl.braces")}</p>
          <div className="field">
            <label htmlFor="tpl-note" className="req">
              {t("tpl.note")}
            </label>
            <input id="tpl-note" className={cx("input", tried && (note.trim().length < 3 || note.trim().length > 300) && "is-invalid")} value={note} maxLength={300} disabled={!editable} placeholder={t("tpl.notePh")} onChange={(e) => setNote(e.target.value)} data-testid="tpl-note" />
          </div>
          <FieldErr msg={formErr} />
          <div className="acts">
            <Btn kind="primary" icon="plus" label={t("tpl.saveVersion")} perm="notif.templates.manage" busy={saving} disabled={!dirty} title={!dirty ? t("tpl.noChanges") : undefined} onClick={() => void save()} testId="tpl-save" />
            <Btn
              kind="ghost"
              label={t("tpl.discard")}
              disabled={!dirty}
              onClick={() => {
                setTexts(cloneTexts(base));
                setServer({});
                setTried(false);
              }}
            />
            <Btn kind="ghost" icon="rollback" label={t("tpl.fromDefault")} disabled={!editable} onClick={() => setTexts(cloneTexts(d.default_texts))} testId="tpl-from-default" />
          </div>
        </div>
        <div className="tpl-pv-col stack sm">
          <div className="row between">
            <span className="field-label">{t("tpl.preview")}</span>
            <PreviewControls lang={pvLang} setLang={setPvLang} />
          </div>
          <TelegramMessage lang={pvLang} title={substitute(cur.title, vals)} body={substitute(cur.body, vals)} button={cur.button ?? d.default_texts[pvLang].button ?? ""} label={t("tpl.previewLabel", { l: pvLang.toUpperCase() })} />
          <p className="xs muted center">{t("tpl.sampleNote")}</p>
          {spv && (
            <div className="spv" data-testid="tpl-server-preview">
              <div className="row between">
                <b className="small">{t("tpl.serverPvT", { v: spv.v, l: spv.p.lang.toUpperCase() })}</b>
                <Btn size="xs" kind="ghost" icon="x" aria={t("common.close")} onClick={() => setSpv(null)} />
              </div>
              <pre className="code">{spv.p.telegram_text}</pre>
            </div>
          )}
          <TestSend versions={d.versions} send={(v, l, r) => Templates.test(tkey, v, l, r)} />
        </div>
      </section>

      {cmd && (
        <ConfirmCommand
          title={cmd.kind === "activate" ? t("tpl.activateT", { v: cmd.v.version }) : t("tpl.resetT")}
          text={cmd.kind === "activate" ? t("tpl.activateM", { key: d.key }) : t("tpl.resetM")}
          icon={cmd.kind === "activate" ? "zap" : "rollback"}
          tone="warn"
          ok={cmd.kind === "activate" ? t("tpl.activate") : t("tpl.reset")}
          extra={
            <Callout kind="info" icon="smartphoneKey">
              {t("wn.stepUpNote")}
            </Callout>
          }
          testId="tpl-confirm"
          onClose={() => setCmd(null)}
          onConfirm={async (reason) => {
            try {
              if (cmd.kind === "activate") {
                const v = await Templates.activate(tkey, cmd.v.version, reason);
                toast(t("tpl.activated", { v: v.version }), "ok", "template.activated");
              } else {
                await Templates.reset(tkey, reason);
                toast(t("tpl.resetDone"), "ok", "template.reset");
              }
              await load();
              onChanged();
              return null;
            } catch (e) {
              return (e as ApiError).cancelled ? t("stepup.cancelled") : errText(i, e);
            }
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- test send (test chats only) */

export function TestSend({ versions, send, single }: { versions?: TemplateVersion[]; send: (v: number, lang: UiLang, recipient: number) => Promise<{ sent: boolean; delivery_id: string | null; error: string | null }>; single?: boolean }) {
  const i = useI18n();
  const { t } = i;
  const { can } = useSession();
  const [recips, setRecips] = useState<TestRecipient[] | null>(null);
  const [rec, setRec] = useState<string>("");
  const [ver, setVer] = useState<string>(() => String(versions?.[0]?.version ?? ""));
  const [lang, setLang] = useState<UiLang>("ru");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    let alive = true;
    Templates.testRecipients()
      .then((r) => {
        if (!alive) return;
        setRecips(r.items);
        setRec(r.items[0] ? String(r.items[0].index) : "");
      })
      .catch(() => alive && setRecips([]));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (versions?.length && !versions.some((v) => String(v.version) === ver)) setVer(String(versions[0]!.version));
  }, [versions, ver]);
  const canManage = can("notif.templates.manage") || can("notif.campaigns.manage");
  if (!recips) return null;
  if (!recips.length)
    return (
      <p className="xs muted row" data-testid="test-none">
        <Icon name="info" /> {t("test.none")}
      </p>
    );
  const go = async () => {
    setBusy(true);
    setRes(null);
    try {
      const r = await send(single ? 0 : Number(ver), lang, Number(rec));
      setRes(r.sent ? { ok: true, text: t("test.sent", { id: r.delivery_id ?? "—" }) } : { ok: false, text: t("test.failed", { e: r.error ?? "—" }) });
    } catch (e) {
      if (!(e as ApiError).cancelled) setRes({ ok: false, text: errText(i, e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="test-send" data-testid="test-send">
      <legend className="field-label">{t("test.title")}</legend>
      <div className="row">
        {!single && versions && (
          <Select<string> id="ts-ver" label={t("test.version")} value={ver} onChange={setVer} options={versions.length ? versions.map((v) => ({ v: String(v.version), label: `v${v.version}` })) : [{ v: "", label: t("test.saveFirst"), disabled: true }]} testId="ts-ver" />
        )}
        <Select<string> id="ts-rec" label={t("test.recipient")} value={rec} onChange={setRec} options={recips.map((r) => ({ v: String(r.index), label: r.label }))} testId="ts-rec" />
        <Select<UiLang> id="ts-lang" label={t("pv.lang")} value={lang} onChange={setLang} options={LANGS.map((l) => ({ v: l, label: l.toUpperCase() }))} />
        <Btn size="sm" icon="send" label={t("test.send")} busy={busy} disabled={!canManage || (!single && !ver)} onClick={() => void go()} testId="ts-send" />
      </div>
      {res && (
        <p className={cx("xs", res.ok ? "good-ink" : "bad-ink")} role="status" data-testid="ts-result">
          {res.text}
        </p>
      )}
      <p className="xs muted">{t("test.note")}</p>
    </fieldset>
  );
}
