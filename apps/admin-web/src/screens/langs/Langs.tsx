/**
 * «Языки и курсы» (content.read; changes — lang.manage with step-up; ADM-LANG-01/02, AT-31): the reference of languages
 * (Language: names, script, variants, ASR/TTS, limitations, status) and the cards of language pairs (PairCard: status
 * on the path planned → development → review → pilot → published, readiness of the course — skills, lessons,
 * scenarios, rubrics, media, diagnostic test, checked localisations — and learners). A new pair is a record, not code.
 * Publication of a pair that is not ready answers 422 PAIR_NOT_READY {missing}: the missing parts are listed.
 */
import { useCallback, useEffect, useState } from "react";
import type { Language, LanguagePair, PairStatus } from "@tilhero/contracts/content";
import type { ContentRow, PairCard } from "@tilhero/contracts/admin";
import { Content, Languages } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Spinner, type Tone } from "../../ui/kit";
import { Drawer } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";

export const PAIR_STATUSES: readonly PairStatus[] = ["planned", "development", "review", "pilot", "published", "archived"];
const PATH: readonly PairStatus[] = ["planned", "development", "review", "pilot", "published"];
export const PAIR_TONE: Record<PairStatus, Tone> = { planned: "neutral", development: "info", review: "warn", pilot: "accent", published: "good", archived: "neutral" };
export const MISSING_KEYS = ["course", "lessons", "rubrics", "locales", "diagnostic_test", "scenarios", "skills"] as const;
const LANG_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const PAIR_RE = /^[a-z]{2,3}-[a-z]{2,3}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

export function LangsPage() {
  const { t } = useI18n();
  const [langs, setLangs] = useState<Language[] | null>(null);
  const [pairs, setPairs] = useState<PairCard[] | null>(null);
  const [courses, setCourses] = useState<ContentRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [pairErr, setPairErr] = useState<unknown>(null);
  const [editLang, setEditLang] = useState<Language | "new" | null>(null);
  const [editPair, setEditPair] = useState<LanguagePair | "new" | null>(null);
  const { can } = useSession();
  const load = useCallback(async () => {
    Languages.list()
      .then((r) => (setLangs(r.items), setError(null)))
      .catch(setError);
    Languages.pairs()
      .then((r) => (setPairs(r.items), setPairErr(null)))
      .catch(setPairErr);
    Content.list("course", { limit: 100 })
      .then((r) => setCourses(r.items))
      .catch(() => setCourses([]));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="stack" data-testid="langs">
      <section className="panel" aria-labelledby="pairs-h">
        <div className="panel-h">
          <h2 className="panel-t grow" id="pairs-h">
            <Icon name="globe" /> {t("lg.pairs")}
          </h2>
          {can("lang.manage") && <Btn size="sm" kind="primary" icon="plus" label={t("lg.addPair")} onClick={() => setEditPair("new")} testId="lg-add-pair" />}
        </div>
        <div className="panel-b">
          <p className="small muted">{t("lg.pairsHint")}</p>
          {pairErr && !pairs ? (
            <LoadError error={pairErr} onRetry={() => void load()} />
          ) : !pairs ? (
            <Spinner label={t("common.loading")} />
          ) : pairs.length ? (
            <div className="pair-grid">
              {pairs.map((p) => (
                <PairCardView key={p.pair_id} p={p} onEdit={can("lang.manage") ? () => setEditPair(p) : undefined} />
              ))}
            </div>
          ) : (
            <Empty icon="globe" title={t("lg.noPairs")} />
          )}
        </div>
      </section>

      <section className="panel" aria-labelledby="langs-h" data-testid="lg-langs">
        <div className="panel-h">
          <h2 className="panel-t grow" id="langs-h">
            <Icon name="book" /> {t("lg.langs")}
          </h2>
          {can("lang.manage") && <Btn size="sm" icon="plus" label={t("lg.addLang")} onClick={() => setEditLang("new")} testId="lg-add-lang" />}
        </div>
        {error && !langs ? (
          <div className="panel-b">
            <LoadError error={error} onRetry={() => void load()} />
          </div>
        ) : !langs ? (
          <Spinner label={t("common.loading")} />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t("lg.col.code")}</th>
                  <th scope="col">{t("lg.col.name")}</th>
                  <th scope="col">{t("lg.col.script")}</th>
                  <th scope="col">{t("lg.col.voice")}</th>
                  <th scope="col">{t("lg.col.limits")}</th>
                  <th scope="col">{t("col.status")}</th>
                  <th scope="col">
                    <span className="sr-only">{t("ct.col.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {langs.map((l) => (
                  <tr key={l.code} data-testid={`lg-row-${l.code}`}>
                    <td className="mono">{l.code}</td>
                    <td>
                      <b>{l.name.ru}</b>
                      <div className="cell-sub">
                        {l.name.uz} · {l.name.en}
                      </div>
                    </td>
                    <td className="small">
                      {l.script}
                      {l.variants.length > 0 && <div className="cell-sub mono">{l.variants.join(", ")}</div>}
                    </td>
                    <td className="small">
                      <div>ASR: {l.asr ? `${l.asr.provider} · ${l.asr.model}` : t("lg.none")}</div>
                      <div className="cell-sub">TTS: {l.tts ? `${l.tts.provider} · ${l.tts.voices.join(", ")}` : t("lg.none")}</div>
                    </td>
                    <td className="small wrap-any">{l.limitations ?? "—"}</td>
                    <td>
                      <Pill tone={l.status === "active" ? "good" : "neutral"}>{t(`lgs.${l.status}` as MessageKey)}</Pill>
                    </td>
                    <td className="actions-cell">{can("lang.manage") && <Btn size="xs" icon="edit" label={t("lg.edit")} onClick={() => setEditLang(l)} testId={`lg-edit-${l.code}`} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {!can("lang.manage") && (
        <p className="xs muted row" data-testid="lg-readonly">
          <Icon name="lock" /> {t("lg.readonly", { p: "lang.manage" })}
        </p>
      )}
      {editLang && <LangDrawer lang={editLang === "new" ? null : editLang} onClose={() => setEditLang(null)} onSaved={() => (setEditLang(null), void load())} />}
      {editPair && <PairDrawer pair={editPair === "new" ? null : editPair} langs={langs ?? []} courses={courses} onClose={() => setEditPair(null)} onSaved={() => (setEditPair(null), void load())} />}
    </div>
  );
}

function PairCardView({ p, onEdit }: { p: PairCard; onEdit?: () => void }) {
  const { t, l } = useI18n();
  const idx = PATH.indexOf(p.status);
  const r = p.readiness;
  const Item = ({ k, v, ok }: { k: string; v: string | number; ok: boolean }) => (
    <li className={cx(ok ? "on" : "off")}>
      <Icon name={ok ? "checkCircle" : "alertCircle"} />
      <span className="grow">{k}</span>
      <b className="num">{v}</b>
    </li>
  );
  return (
    <article className={cx("card pair-card", p.status === "published" && "is-live")} aria-labelledby={`pc-${p.pair_id}`} data-testid={`pair-${p.pair_id}`}>
      <div className="row between">
        <div>
          <h3 className="h3" id={`pc-${p.pair_id}`}>
            {p.title.ru || p.pair_id}
          </h3>
          <div className="xs muted">
            <span className="mono">{p.pair_id}</span> · {p.source.toUpperCase()} → {p.target.toUpperCase()} · {t("lg.expl", { l: p.explanation_locales.join(", ").toUpperCase() })}
          </div>
        </div>
        <Pill tone={PAIR_TONE[p.status]} testId={`pair-status-${p.pair_id}`}>
          {t(`ps.${p.status}` as MessageKey)}
        </Pill>
      </div>
      <ol className="stepper sm" aria-label={t("lg.path")}>
        {PATH.map((s, n) => (
          <li key={s} className={cx("sp", n < idx && "done", n === idx && "on")} aria-current={n === idx ? "step" : undefined}>
            {t(`ps.${s}` as MessageKey)}
          </li>
        ))}
      </ol>
      <ul className="ent-list ready-list" aria-label={t("lg.readiness")}>
        <Item k={t("lg.r.skills")} v={r.skills} ok={r.skills > 0} />
        <Item k={t("lg.r.lessons")} v={r.lessons_published} ok={r.lessons_published > 0} />
        <Item k={t("lg.r.scenarios")} v={r.scenarios_published} ok={r.scenarios_published > 0} />
        <Item k={t("lg.r.rubrics")} v={r.rubrics_published} ok={r.rubrics_published > 0} />
        <Item k={t("lg.r.media")} v={r.media_published} ok={r.media_published > 0} />
        <Item k={t("lg.r.test")} v={r.diagnostic_test ?? t("lg.none")} ok={!!r.diagnostic_test} />
        <Item k={t("lg.r.locales")} v={`${Math.round(r.locales_checked_pct)}%`} ok={r.locales_checked_pct >= 100} />
      </ul>
      <div className="row between small">
        <span className="muted">
          {t("lg.learners")} <b className="num">{p.learners}</b>
          {p.course_id && (
            <>
              {" · "}
              {t("lg.course")} <span className="mono">{p.course_id}</span>
            </>
          )}
          {p.release_at && ` · ${t("lg.release", { d: p.release_at })}`}
        </span>
        {onEdit && <Btn size="xs" icon="edit" label={t("lg.editPair")} onClick={onEdit} testId={`pair-edit-${p.pair_id}`} />}
      </div>
      {p.status !== "published" && <p className="xs muted">{t("lg.soonForLearners", { t: l({ ru: p.title.ru, en: p.pair_id }) })}</p>}
    </article>
  );
}

/* ---------------------------------------------------------------- pair form */

function PairDrawer({ pair, langs, courses, onClose, onSaved }: { pair: LanguagePair | null; langs: Language[]; courses: ContentRow[]; onClose: () => void; onSaved: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const [d, setD] = useState<LanguagePair>(
    () =>
      pair ?? {
        pair_id: "",
        source: "ru",
        target: "en",
        explanation_locales: ["ru"],
        ui_locales: ["ru", "uz"],
        title: { ru: "", uz: "" },
        status: "planned",
        release_at: null,
        course_id: null,
      },
  );
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const up = <K extends keyof LanguagePair>(k: K, v: LanguagePair[K]) => (setD((x) => ({ ...x, [k]: v })), setMissing(null), setErr(null));
  const isNew = !pair;
  const save = async () => {
    const problems: string[] = [];
    if (!PAIR_RE.test(d.pair_id)) problems.push(t("lg.e.pairId"));
    if (d.source === d.target) problems.push(t("lg.e.same"));
    if (!d.title.ru.trim() || !d.title.uz.trim() || CONTROL.test(d.title.ru + d.title.uz)) problems.push(t("lg.e.title"));
    if (!d.ui_locales.length) problems.push(t("lg.e.ui"));
    if (reason.trim().length < 5) problems.push(t("cmd.errReason", { n: 5 }));
    if (problems.length) {
      setErr(problems.join(" · "));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await Languages.putPair(d, reason.trim());
      toast(t("lg.pairSaved", { id: d.pair_id }), "ok", "lang.pair_updated");
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === "PAIR_NOT_READY") {
        const m = Array.isArray(e.details.missing) ? (e.details.missing as unknown[]).map(String) : [];
        setMissing(m);
        setErr(t("err.PAIR_NOT_READY"));
      } else setErr((e as ApiError)?.cancelled ? t("stepup.cancelled") : errText(i18n, e));
    } finally {
      setBusy(false);
    }
  };
  const langOpts = langs.map((l) => ({ v: l.code, label: `${l.code} · ${l.name.ru}` }));
  return (
    <Drawer
      title={isNew ? t("lg.newPair") : t("lg.editPairT", { id: d.pair_id })}
      onClose={onClose}
      testId="pair-drawer"
      footer={
        <>
          <span className="grow xs muted row">
            <Icon name="smartphoneKey" /> {t("ct.stepUpNote")}
          </span>
          <Btn label={t("common.cancel")} onClick={onClose} />
          <Btn kind="primary" icon="check" label={t("lg.save")} busy={busy} onClick={() => void save()} testId="pair-save" />
        </>
      }
    >
      <div className="stack sm">
        <div className="form-grid">
          <div className="field">
            <label htmlFor="pf-id" className="req">
              {t("lg.pairId")}
            </label>
            <input id="pf-id" className="input mono" value={d.pair_id} disabled={!isNew} maxLength={7} onChange={(e) => up("pair_id", e.target.value.toLowerCase())} data-testid="pf-id" />
          </div>
          <div className="field">
            <label htmlFor="pf-status">{t("col.status")}</label>
            <select id="pf-status" className="select wide" value={d.status} onChange={(e) => up("status", e.target.value as PairStatus)} data-testid="pf-status">
              {PAIR_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`ps.${s}` as MessageKey)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pf-src">{t("lg.source")}</label>
            <select id="pf-src" className="select wide" value={d.source} onChange={(e) => up("source", e.target.value)}>
              {langOpts.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pf-tgt">{t("lg.target")}</label>
            <select id="pf-tgt" className="select wide" value={d.target} onChange={(e) => up("target", e.target.value)}>
              {langOpts.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pf-t-ru" className="req">
              {t("lg.titleRu")}
            </label>
            <input id="pf-t-ru" className="input" lang="ru" value={d.title.ru} maxLength={120} onChange={(e) => up("title", { ...d.title, ru: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pf-t-uz" className="req">
              {t("lg.titleUz")}
            </label>
            <input id="pf-t-uz" className={cx("input", !d.title.uz.trim() && !!d.title.ru.trim() && "is-invalid")} lang="uz-Latn" value={d.title.uz} maxLength={120} onChange={(e) => up("title", { ...d.title, uz: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pf-expl">{t("lg.explLocales")}</label>
            <input
              id="pf-expl"
              className="input mono"
              value={d.explanation_locales.join(", ")}
              onChange={(e) =>
                up(
                  "explanation_locales",
                  e.target.value
                    .split(/[,\s]+/)
                    .map((x) => x.trim())
                    .filter((x) => LANG_RE.test(x)),
                )
              }
            />
          </div>
          <fieldset className="field fs">
            <legend className="field-label">{t("lg.uiLocales")}</legend>
            <div className="row">
              {(["ru", "uz"] as const).map((x) => (
                <label key={x} className="check">
                  <input type="checkbox" checked={d.ui_locales.includes(x)} onChange={(e) => up("ui_locales", e.target.checked ? [...new Set([...d.ui_locales, x])] : d.ui_locales.filter((y) => y !== x))} />
                  <span>{x.toUpperCase()}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="field">
            <label htmlFor="pf-course">{t("lg.course")}</label>
            <select id="pf-course" className="select wide" value={d.course_id ?? ""} onChange={(e) => up("course_id", e.target.value || null)} data-testid="pf-course">
              <option value="">{t("lg.noCourse")}</option>
              {d.course_id && !courses.some((c) => c.key === d.course_id) && <option value={d.course_id}>{d.course_id}</option>}
              {courses.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.title.ru} · {c.key}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pf-rel">{t("lg.releaseAt")}</label>
            <input id="pf-rel" className="input" value={d.release_at ?? ""} maxLength={40} placeholder="2027-03" onChange={(e) => up("release_at", e.target.value.trim() ? e.target.value : null)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="pf-reason" className="req">
            {t("cmd.reason")}
          </label>
          <textarea id="pf-reason" className="textarea" rows={2} maxLength={500} value={reason} placeholder={t("cmd.reasonPh")} onChange={(e) => setReason(e.target.value)} data-testid="pf-reason" />
        </div>
        {d.status === "published" && pair?.status !== "published" && (
          <Callout kind="info" icon="info">
            {t("lg.publishRule")}
          </Callout>
        )}
        <FieldErr msg={err} />
        {missing && (
          <Callout kind="bad" icon="alertCircle" testId="pair-missing">
            <b>{t("lg.missingT")}</b>
            <ul className="plain-list">
              {missing.map((m) => (
                <li key={m} data-testid={`missing-${m}`}>
                  {(MISSING_KEYS as readonly string[]).includes(m) ? t(`lg.m.${m}` as MessageKey) : m}
                </li>
              ))}
            </ul>
          </Callout>
        )}
      </div>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- language form */

function LangDrawer({ lang, onClose, onSaved }: { lang: Language | null; onClose: () => void; onSaved: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const [d, setD] = useState<Language>(() => lang ?? { code: "", name: { ru: "", uz: "", en: "" }, script: "Latn", variants: [], asr: null, tts: null, limitations: null, status: "planned" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const up = <K extends keyof Language>(k: K, v: Language[K]) => (setD((x) => ({ ...x, [k]: v })), setErr(null));
  const save = async () => {
    if (!LANG_RE.test(d.code) || !d.name.ru.trim() || !d.name.uz.trim() || !d.name.en.trim()) {
      setErr(t("lg.e.lang"));
      return;
    }
    setBusy(true);
    try {
      await Languages.put(d);
      toast(t("lg.langSaved", { code: d.code }), "ok", "lang.language_updated");
      onSaved();
    } catch (e) {
      setErr((e as ApiError)?.cancelled ? t("stepup.cancelled") : errText(i18n, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title={lang ? t("lg.editLangT", { code: d.code }) : t("lg.newLang")}
      onClose={onClose}
      testId="lang-drawer"
      footer={
        <>
          <span className="grow xs muted row">
            <Icon name="smartphoneKey" /> {t("ct.stepUpNote")}
          </span>
          <Btn label={t("common.cancel")} onClick={onClose} />
          <Btn kind="primary" icon="check" label={t("lg.save")} busy={busy} onClick={() => void save()} testId="lang-save" />
        </>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label htmlFor="lf-code" className="req">
            {t("lg.col.code")}
          </label>
          <input id="lf-code" className="input mono" value={d.code} disabled={!!lang} maxLength={6} onChange={(e) => up("code", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="lf-status">{t("col.status")}</label>
          <select id="lf-status" className="select wide" value={d.status} onChange={(e) => up("status", e.target.value as Language["status"])}>
            {(["active", "planned"] as const).map((s) => (
              <option key={s} value={s}>
                {t(`lgs.${s}` as MessageKey)}
              </option>
            ))}
          </select>
        </div>
        {(["ru", "uz", "en"] as const).map((k) => (
          <div className="field" key={k}>
            <label htmlFor={`lf-n-${k}`} className="req">
              {t("lg.nameIn", { l: k.toUpperCase() })}
            </label>
            <input id={`lf-n-${k}`} className="input" lang={k === "uz" ? "uz-Latn" : k} value={d.name[k]} maxLength={80} onChange={(e) => up("name", { ...d.name, [k]: e.target.value })} />
          </div>
        ))}
        <div className="field">
          <label htmlFor="lf-script">{t("lg.col.script")}</label>
          <select id="lf-script" className="select wide" value={d.script} onChange={(e) => up("script", e.target.value as Language["script"])}>
            <option value="Latn">Latn</option>
            <option value="Cyrl">Cyrl</option>
          </select>
        </div>
        <div className="field span-2">
          <label htmlFor="lf-var">{t("lg.variants")}</label>
          <input
            id="lf-var"
            className="input mono"
            value={d.variants.join(", ")}
            onChange={(e) =>
              up(
                "variants",
                e.target.value
                  .split(/[,\s]+/)
                  .map((x) => x.trim())
                  .filter((x) => LANG_RE.test(x)),
              )
            }
          />
        </div>
        <fieldset className="field fs span-2">
          <legend className="field-label">ASR</legend>
          <label className="check">
            <input type="checkbox" checked={!!d.asr} onChange={(e) => up("asr", e.target.checked ? { provider: "", model: "" } : null)} />
            <span>{t("lg.hasAsr")}</span>
          </label>
          {d.asr && (
            <div className="form-grid">
              <input className="input" aria-label={t("lg.provider")} placeholder={t("lg.provider")} value={d.asr.provider} onChange={(e) => up("asr", { ...d.asr!, provider: e.target.value })} />
              <input className="input" aria-label={t("lg.model")} placeholder={t("lg.model")} value={d.asr.model} onChange={(e) => up("asr", { ...d.asr!, model: e.target.value })} />
            </div>
          )}
        </fieldset>
        <fieldset className="field fs span-2">
          <legend className="field-label">TTS</legend>
          <label className="check">
            <input type="checkbox" checked={!!d.tts} onChange={(e) => up("tts", e.target.checked ? { provider: "", voices: [] } : null)} />
            <span>{t("lg.hasTts")}</span>
          </label>
          {d.tts && (
            <div className="form-grid">
              <input className="input" aria-label={t("lg.provider")} placeholder={t("lg.provider")} value={d.tts.provider} onChange={(e) => up("tts", { ...d.tts!, provider: e.target.value })} />
              <input
                className="input mono"
                aria-label={t("lg.voices")}
                placeholder={t("lg.voices")}
                value={d.tts.voices.join(", ")}
                onChange={(e) =>
                  up("tts", {
                    ...d.tts!,
                    voices: e.target.value
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
          )}
        </fieldset>
        <div className="field span-2">
          <label htmlFor="lf-lim">{t("lg.col.limits")}</label>
          <textarea id="lf-lim" className="textarea" rows={2} maxLength={1000} value={d.limitations ?? ""} onChange={(e) => up("limitations", e.target.value.trim() ? e.target.value : null)} />
        </div>
      </div>
      <FieldErr msg={err} />
    </Drawer>
  );
}
