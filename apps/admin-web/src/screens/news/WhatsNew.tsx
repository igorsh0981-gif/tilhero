/**
 * «Что нового» (whatsnew.manage; publication and withdrawal — whatsnew.publish with step-up): release notes of the
 * Mini App (experience-config). List with status, audience and views; editor with RU/UZ tabs, length counters and
 * highlighted empty translations; 1..6 items with a Mini App route and an icon; audience new/existing/all and age /
 * language segments; preview in a phone frame (RU/UZ, light/dark) exactly as the Mini App sheet; statistics of views.
 * Learner texts are rendered only as text (React escapes; no markup).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgeSegment, ReleaseNoteAudience, ReleaseNoteIcon, ReleaseNoteRoute, ReleaseNoteStats, StaffReleaseNote, UiLang } from "@tilhero/contracts/admin";
import { ReleaseNotes } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n } from "../../i18n";
import { lt } from "../../i18n/learner";
import { uuid } from "../../lib/ids";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Reveal, Seg, Select, Spinner, TabPanel, Tabs, type Tone } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import {
  AGE_SEGMENTS,
  AUDIENCES,
  emptyItem,
  emptyNote,
  LANGS,
  missingIn,
  nextSlug,
  normalizeNote,
  NOTE_ICONS,
  NOTE_LIMITS,
  NOTE_ROUTES,
  noteContent,
  sameJson,
  serverIssues,
  validateNote,
  type Issues,
  type NoteDraft,
} from "./catalog";
import { MiniIcon } from "./MiniIcon";
import { Maybe, Phone, PreviewControls, TextInput } from "./parts";

type Sel = { kind: "new" } | { kind: "note"; id: string } | null;
type Cmd = { kind: "publish" | "archive"; note: StaffReleaseNote; key: string } | null;

export const NOTE_TONE: Record<StaffReleaseNote["status"], Tone> = { draft: "warn", published: "good", archived: "neutral" };

export function WhatsNewTab({ openId }: { openId: string | null }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const toast = useToast();
  const [notes, setNotes] = useState<StaffReleaseNote[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [base, setBase] = useState<NoteDraft | null>(null);
  const [issues, setIssues] = useState<Issues>({});
  const [tried, setTried] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cmd, setCmd] = useState<Cmd>(null);
  const [lang, setLang] = useState<UiLang>("ru");
  const createKey = useRef<string | null>(null);

  const load = useCallback(async (more?: string | null) => {
    try {
      const r = await ReleaseNotes.list(null, more ?? null);
      setNotes((xs) => (more && xs ? [...xs, ...r.items] : r.items));
      setCursor(r.next_cursor);
      setError(null);
      return r.items;
    } catch (e) {
      setError(e);
      return null;
    }
  }, []);

  const open = useCallback((n: StaffReleaseNote) => {
    setSel({ kind: "note", id: n.release_note_id });
    const c = noteContent(n);
    setDraft(c);
    setBase(c);
    setIssues({});
    setTried(false);
    setFormErr(null);
    setConflict(false);
  }, []);

  useEffect(() => {
    void load().then((items) => {
      const want = openId ? items?.find((n) => n.release_note_id === openId || n.slug === openId) : null;
      const first = want ?? items?.find((n) => n.status === "draft") ?? items?.[0];
      if (first) open(first);
    });
  }, [load, open, openId]);

  const current = sel?.kind === "note" ? (notes?.find((n) => n.release_note_id === sel.id) ?? null) : null;
  const isDraft = sel?.kind === "new" || current?.status === "draft";
  const editable = can("whatsnew.manage") && isDraft;
  const dirty = !!draft && !sameJson(normalizeNote(draft), base ? normalizeNote(base) : null);
  const live = useMemo(() => (draft ? validateNote(draft) : {}), [draft]);
  // shown: after a save attempt — every issue; before — only empty translations next to a filled other language
  const shown: Issues = tried ? { ...live, ...issues } : issues;

  const startNew = (from?: NoteDraft) => {
    const taken = (notes ?? []).map((n) => n.slug);
    setSel({ kind: "new" });
    setDraft(from ? { ...noteContent(from), slug: nextSlug(taken) } : emptyNote(nextSlug(taken)));
    setBase(null);
    setIssues({});
    setTried(false);
    setFormErr(null);
    setConflict(false);
    setLang("ru");
    createKey.current = uuid();
  };

  const update = (fn: (d: NoteDraft) => NoteDraft) => {
    setDraft((d) => (d ? fn(d) : d));
    setIssues({});
    setFormErr(null);
  };

  const firstBadLang = (x: Issues): UiLang | null => LANGS.find((l) => Object.keys(x).some((p) => p.endsWith(`.${l}`))) ?? null;

  const save = async () => {
    if (!draft || saving) return;
    setTried(true);
    const e = validateNote(draft);
    if (Object.keys(e).length) {
      setFormErr(missingIn(e, "ru").length + missingIn(e, "uz").length ? t("wn.errMissing") : t("wn.errForm"));
      const l = firstBadLang(e);
      if (l) setLang(l);
      return;
    }
    setSaving(true);
    setFormErr(null);
    try {
      const body = normalizeNote(draft);
      const n = sel?.kind === "note" && current ? await ReleaseNotes.update(current.release_note_id, current.version, body) : await ReleaseNotes.create(body, createKey.current ?? (createKey.current = uuid()));
      toast(t(sel?.kind === "new" ? "wn.created" : "wn.saved", { slug: n.slug }), "ok", sel?.kind === "new" ? "release_note.create" : "release_note.update");
      createKey.current = null;
      const items = await load();
      open(items?.find((x) => x.release_note_id === n.release_note_id) ?? n);
    } catch (ex) {
      if ((ex as ApiError).cancelled) return;
      if (ex instanceof ApiError && ex.code === "RELEASE_NOTE_VERSION_CONFLICT") setConflict(true);
      if (ex instanceof ApiError && ex.status === 422) {
        const si = serverIssues(ex.details);
        setIssues(si);
        const l = firstBadLang(si);
        if (l) setLang(l);
      }
      if (ex instanceof ApiError && ex.code === "RELEASE_NOTE_SLUG_EXISTS") setIssues({ slug: { reason: "server" } });
      setFormErr(errText(i, ex));
    } finally {
      setSaving(false);
    }
  };

  if (error && !notes) return <LoadError error={error} onRetry={() => void load()} />;
  if (!notes) return <Spinner label={t("common.loading")} />;

  const missRu = draft ? missingIn(validateNote(draft), "ru").length : 0;
  const missUz = draft ? missingIn(validateNote(draft), "uz").length : 0;

  return (
    <div className="stack" data-testid="wn">
      <section className="panel" data-testid="wn-list">
        <div className="panel-h">
          <h2 className="panel-t grow">
            <Icon name="sparkles" />
            {t("wn.list")}
          </h2>
          <Btn size="sm" kind="primary" icon="plus" label={t("wn.new")} perm="whatsnew.manage" onClick={() => startNew()} testId="wn-new" />
        </div>
        {notes.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t("wn.col.title")}</th>
                  <th scope="col">{t("wn.col.audience")}</th>
                  <th scope="col">{t("wn.col.items")}</th>
                  <th scope="col" className="r">
                    {t("wn.col.views")}
                  </th>
                  <th scope="col">{t("col.status")}</th>
                  <th scope="col">{t("common.updated")}</th>
                </tr>
              </thead>
              <tbody>
                {notes.map((n) => {
                  const active = sel?.kind === "note" && sel.id === n.release_note_id;
                  return (
                    <tr key={n.release_note_id} className={active ? "is-sel" : undefined} data-testid={`wn-row-${n.slug}`}>
                      <td>
                        <button type="button" className="tr" aria-current={active ? "true" : undefined} onClick={() => open(n)} data-testid={`wn-open-${n.slug}`}>
                          {n.title.ru || n.slug}
                        </button>
                        <div className="cell-sub mono">{n.slug}</div>
                      </td>
                      <td className="small">
                        {t(`aud.${n.audience}`)}
                        <SegmentsLine s={n.segments} />
                      </td>
                      <td className="num">{n.items.length}</td>
                      <td className="r num" data-testid={`wn-views-${n.slug}`}>
                        {n.status === "draft" ? "—" : fmt.num(n.views_total)}
                      </td>
                      <td>
                        <Pill tone={NOTE_TONE[n.status]}>{t(`wn.st.${n.status}`)}</Pill>
                      </td>
                      <td className="nowrap small">
                        {fmt.dateTime(n.published_at ?? n.updated_at)}
                        <div className="cell-sub">{n.published_by_name ?? n.created_by_name ?? ""}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="sparkles" title={t("wn.empty")} text={t("wn.emptyM")} />
        )}
        {cursor && (
          <div className="more-row">
            <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} />
          </div>
        )}
      </section>

      {draft && sel && (
        <section className="card wn-editor" aria-labelledby="wn-ed-h" data-testid="wn-editor">
          <div className="wn-ed-col">
            <div className="row between">
              <h2 className="h2" id="wn-ed-h">
                {sel.kind === "new" ? t("wn.newT") : t("wn.editT", { slug: current?.slug ?? "" })}
              </h2>
              <span className="row">
                {current && <Pill tone={NOTE_TONE[current.status]}>{t(`wn.st.${current.status}`)}</Pill>}
                {current && <span className="xs muted mono">v{current.version}</span>}
                {dirty && <Pill tone="info">{t("wn.unsaved")}</Pill>}
              </span>
            </div>
            {conflict && (
              <Reveal dep={conflict}>
                <Callout kind="warn" icon="alert" testId="wn-conflict">
                  <b>{t("wn.conflict")}</b>{" "}
                  <Btn
                    size="xs"
                    icon="refresh"
                    label={t("wn.reload")}
                    onClick={() =>
                      void load().then((items) => {
                        const n = items?.find((x) => x.release_note_id === current?.release_note_id);
                        if (n) open(n);
                      })
                    }
                  />
                </Callout>
              </Reveal>
            )}
            {!isDraft && current && (
              <Callout icon="lock" testId="wn-readonly">
                {t(current.status === "published" ? "wn.roPublished" : "wn.roArchived")}
              </Callout>
            )}
            <Tabs<UiLang>
              id="wn-lang"
              label={t("wn.langTabs")}
              value={lang}
              onChange={setLang}
              items={[
                { v: "ru", label: t("ulang.ru"), cnt: missRu || null, bad: true, testId: "wn-lang-ru" },
                { v: "uz", label: t("ulang.uz"), cnt: missUz || null, bad: true, testId: "wn-lang-uz" },
              ]}
            />
            <TabPanel id="wn-lang" value={lang}>
              <NoteFields d={draft} lang={lang} issues={shown} live={live} editable={editable} update={update} />
            </TabPanel>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="wn-slug" className="req">
                  {t("wn.slug")}
                </label>
                <input
                  id="wn-slug"
                  className={cx("input mono", shown.slug && "is-invalid")}
                  value={draft.slug}
                  maxLength={32}
                  disabled={!editable}
                  aria-invalid={!!shown.slug || undefined}
                  aria-describedby="wn-slug-hint"
                  onChange={(e) => update((d) => ({ ...d, slug: e.target.value }))}
                  data-testid="wn-slug"
                />
                <span className="hint" id="wn-slug-hint">
                  {shown.slug ? (shown.slug.reason === "server" ? t("err.RELEASE_NOTE_SLUG_EXISTS") : t("wn.slugErr")) : t("wn.slugHint")}
                </span>
              </div>
              <div className="field">
                <span className="field-label" id="wn-aud-l">
                  {t("wn.audience")}
                </span>
                <Seg<ReleaseNoteAudience> label={t("wn.audience")} value={draft.audience} onChange={(v) => editable && update((d) => ({ ...d, audience: v }))} testId="wn-audience" items={AUDIENCES.map((a) => ({ v: a, label: t(`aud.${a}`) }))} />
                <span className="hint">{t(`aud.${draft.audience}.hint`)}</span>
              </div>
              <fieldset className="field span-2 fs">
                <legend className="field-label">{t("wn.segments")}</legend>
                <div className="row">
                  {AGE_SEGMENTS.map((a) => (
                    <label key={a} className="check">
                      <input
                        type="checkbox"
                        disabled={!editable}
                        checked={!!draft.segments.age?.includes(a)}
                        onChange={(e) => update((d) => ({ ...d, segments: toggleSeg(d.segments, "age", a, e.target.checked) }))}
                        data-testid={`wn-age-${a}`}
                      />
                      <span>{t(`ageseg.${a}`)}</span>
                    </label>
                  ))}
                  <span className="seg-sep" aria-hidden="true" />
                  {LANGS.map((l) => (
                    <label key={l} className="check">
                      <input type="checkbox" disabled={!editable} checked={!!draft.segments.ui_lang?.includes(l)} onChange={(e) => update((d) => ({ ...d, segments: toggleSeg(d.segments, "ui_lang", l, e.target.checked) }))} data-testid={`wn-ui-${l}`} />
                      <span>{t("wn.uiLang", { l: l.toUpperCase() })}</span>
                    </label>
                  ))}
                </div>
                <span className="hint">{t("wn.segmentsHint")}</span>
              </fieldset>
            </div>
            <FieldErr msg={formErr} />
            <div className="acts">
              {editable && <Btn kind={dirty || sel.kind === "new" ? "primary" : ""} icon="check" label={sel.kind === "new" ? t("wn.saveNew") : t("wn.save")} busy={saving} disabled={!dirty && sel.kind !== "new"} onClick={() => void save()} testId="wn-save" />}
              {current?.status === "draft" && can("whatsnew.publish") && (
                <Btn
                  kind="primary"
                  icon="send"
                  label={t("wn.publish")}
                  perm="whatsnew.publish"
                  disabled={dirty}
                  title={dirty ? t("wn.saveFirst") : undefined}
                  onClick={() => setCmd({ kind: "publish", note: current, key: uuid() })}
                  testId="wn-publish"
                />
              )}
              {current?.status === "published" && can("whatsnew.publish") && <Btn kind="danger-ghost" icon="power" label={t("wn.archive")} perm="whatsnew.publish" onClick={() => setCmd({ kind: "archive", note: current, key: uuid() })} testId="wn-archive" />}
              {current && current.status !== "draft" && <Btn icon="copy" label={t("wn.copy")} perm="whatsnew.manage" onClick={() => startNew(current)} testId="wn-copy" />}
              {sel.kind === "new" && <Btn kind="ghost" label={t("common.cancel")} onClick={() => (notes[0] ? open(notes[0]) : (setSel(null), setDraft(null)))} />}
            </div>
            <p className="sub">{t("wn.rules")}</p>
            {current && current.status !== "archived" && !can("whatsnew.publish") && (
              <p className="xs muted row" data-testid="wn-no-publish">
                <Icon name="lock" /> {t("wn.noPublish", { p: "whatsnew.publish" })}
              </p>
            )}
            {current?.status === "draft" && dirty && (
              <p className="xs muted row">
                <Icon name="info" /> {t("wn.saveFirst")}
              </p>
            )}
          </div>
          <div className="wn-pv-col">
            <WhatsNewPreview d={draft} initialLang={lang} />
          </div>
        </section>
      )}

      {current && current.status !== "draft" && <NoteStats key={current.release_note_id} note={current} />}

      {cmd && (
        <ConfirmCommand
          title={cmd.kind === "publish" ? t("wn.publishT", { slug: cmd.note.slug }) : t("wn.archiveT", { slug: cmd.note.slug })}
          text={cmd.kind === "publish" ? t("wn.publishM", { aud: t(`aud.${cmd.note.audience}`) }) : t("wn.archiveM")}
          icon={cmd.kind === "publish" ? "send" : "power"}
          tone={cmd.kind === "publish" ? "warn" : "bad"}
          ok={cmd.kind === "publish" ? t("wn.publish") : t("wn.archive")}
          okKind={cmd.kind === "publish" ? "primary" : "danger"}
          extra={
            <Callout kind="info" icon="smartphoneKey">
              {t("wn.stepUpNote")}
            </Callout>
          }
          testId="wn-confirm"
          onClose={() => setCmd(null)}
          onConfirm={async (reason) => {
            try {
              const n = cmd.kind === "publish" ? await ReleaseNotes.publish(cmd.note.release_note_id, cmd.note.version, reason, cmd.key) : await ReleaseNotes.archive(cmd.note.release_note_id, reason, cmd.key);
              toast(t(cmd.kind === "publish" ? "wn.published" : "wn.archived", { slug: n.slug }), "ok", `release_note.${cmd.kind}`);
              const items = await load();
              open(items?.find((x) => x.release_note_id === n.release_note_id) ?? n);
              return null;
            } catch (e) {
              if ((e as ApiError).cancelled) return t("stepup.cancelled");
              if (e instanceof ApiError && e.code === "RELEASE_NOTE_TRANSLATION_MISSING") {
                const si = serverIssues(e.details);
                setIssues(si);
                setTried(true);
                const l = firstBadLang(si);
                if (l) setLang(l);
              }
              if (e instanceof ApiError && e.code === "RELEASE_NOTE_VERSION_CONFLICT") setConflict(true);
              return errText(i, e);
            }
          }}
        />
      )}
    </div>
  );
}

function toggleSeg<K extends "age" | "ui_lang">(s: NoteDraft["segments"], k: K, v: K extends "age" ? AgeSegment : UiLang, on: boolean): NoteDraft["segments"] {
  const cur = (s[k] ?? []) as string[];
  const next = on ? [...new Set([...cur, v])] : cur.filter((x) => x !== v);
  const out = { ...s } as Record<string, string[] | undefined>;
  if (next.length) out[k] = next;
  else delete out[k];
  return out as NoteDraft["segments"];
}

export function SegmentsLine({ s }: { s: NoteDraft["segments"] | null | undefined }) {
  const { t } = useI18n();
  const parts = [...(s?.age ?? []).map((a) => t(`ageseg.${a}`)), ...(s?.ui_lang ?? []).map((l) => l.toUpperCase())];
  return <div className="cell-sub">{parts.length ? parts.join(" · ") : t("wn.segAll")}</div>;
}

/* ---------------------------------------------------------------- fields of one language */

function NoteFields({ d, lang, issues, live, editable, update }: { d: NoteDraft; lang: UiLang; issues: Issues; live: Issues; editable: boolean; update: (fn: (d: NoteDraft) => NoteDraft) => void }) {
  const { t } = useI18n();
  const other: UiLang = lang === "ru" ? "uz" : "ru";
  // an empty translation is highlighted as soon as the other language has text (or after a save attempt)
  const miss = (path: string, otherText: string) => (live[path]?.reason === "required" && !!otherText.trim()) || issues[path]?.reason === "required";
  const move = (k: number, dir: number) =>
    update((x) => {
      const j = k + dir;
      if (j < 0 || j >= x.items.length) return x;
      const items = [...x.items];
      [items[k], items[j]] = [items[j]!, items[k]!];
      return { ...x, items };
    });
  const setItem = (k: number, fn: (it: NoteDraft["items"][number]) => NoteDraft["items"][number]) => update((x) => ({ ...x, items: x.items.map((it, n) => (n === k ? fn(it) : it)) }));
  return (
    <div className="stack sm">
      <TextInput
        id={`wn-title-${lang}`}
        label={t("wn.title", { l: lang.toUpperCase() })}
        value={d.title[lang]}
        max={NOTE_LIMITS.title}
        lang={lang}
        disabled={!editable}
        issue={issues[`title.${lang}`]}
        missing={miss(`title.${lang}`, d.title[other])}
        onChange={(v) => update((x) => ({ ...x, title: { ...x.title, [lang]: v } }))}
        testId={`wn-title-${lang}`}
      />
      <ol className="wn-items" aria-label={t("wn.items")}>
        {d.items.map((it, k) => (
          <li key={k} className="wn-item" data-testid={`wn-item-${k}`}>
            <div className="wn-item-h">
              <span className="idx">{k + 1}</span>
              <b className="grow">{t("wn.item", { n: k + 1 })}</b>
              <Btn size="xs" kind="ghost" icon="up" aria={t("wn.up", { n: k + 1 })} disabled={!editable || k === 0} onClick={() => move(k, -1)} />
              <Btn size="xs" kind="ghost" icon="down" aria={t("wn.down", { n: k + 1 })} disabled={!editable || k === d.items.length - 1} onClick={() => move(k, 1)} />
              <Btn size="xs" kind="ghost" icon="x" aria={t("wn.remove", { n: k + 1 })} disabled={!editable || d.items.length <= NOTE_LIMITS.itemsMin} onClick={() => update((x) => ({ ...x, items: x.items.filter((_, n) => n !== k) }))} testId={`wn-remove-${k}`} />
            </div>
            <TextInput
              id={`wn-it-title-${k}-${lang}`}
              label={t("wn.itemTitle")}
              value={it.title[lang]}
              max={NOTE_LIMITS.itemTitle}
              lang={lang}
              disabled={!editable}
              issue={issues[`items[${k}].title.${lang}`]}
              missing={miss(`items[${k}].title.${lang}`, it.title[other])}
              onChange={(v) => setItem(k, (x) => ({ ...x, title: { ...x.title, [lang]: v } }))}
              testId={`wn-it-title-${k}-${lang}`}
            />
            <TextInput
              id={`wn-it-text-${k}-${lang}`}
              label={t("wn.itemText")}
              value={it.text[lang]}
              max={NOTE_LIMITS.itemText}
              lang={lang}
              multiline
              rows={2}
              disabled={!editable}
              issue={issues[`items[${k}].text.${lang}`]}
              missing={miss(`items[${k}].text.${lang}`, it.text[other])}
              onChange={(v) => setItem(k, (x) => ({ ...x, text: { ...x.text, [lang]: v } }))}
              testId={`wn-it-text-${k}-${lang}`}
            />
            <div className="form-grid">
              <div className="field">
                <label htmlFor={`wn-link-${k}`}>{t("wn.link")}</label>
                <Select<ReleaseNoteRoute | "">
                  id={`wn-link-${k}`}
                  label={t("wn.link")}
                  value={it.link ?? ""}
                  disabled={!editable}
                  onChange={(v) => setItem(k, (x) => ({ ...x, link: v || null }))}
                  options={[{ v: "", label: t("wn.noLink") }, ...NOTE_ROUTES.map((r) => ({ v: r, label: t(`route.${r}`) }))]}
                  testId={`wn-link-${k}`}
                />
              </div>
              <div className="field">
                <span className="field-label" id={`wn-icon-l-${k}`}>
                  {t("wn.icon")}
                </span>
                <IconPicker labelledBy={`wn-icon-l-${k}`} value={it.icon} disabled={!editable} onChange={(icon) => setItem(k, (x) => ({ ...x, icon }))} idPrefix={`wn-ic-${k}`} />
              </div>
            </div>
          </li>
        ))}
      </ol>
      {editable && (
        <Btn
          size="sm"
          icon="plus"
          label={t("wn.addItem", { n: d.items.length, m: NOTE_LIMITS.itemsMax })}
          disabled={d.items.length >= NOTE_LIMITS.itemsMax}
          onClick={() => update((x) => ({ ...x, items: [...x.items, emptyItem()] }))}
          testId="wn-add-item"
        />
      )}
    </div>
  );
}

/** Radio group of the 16 catalogue icons (arrow keys move inside, as native radios). */
function IconPicker({ value, onChange, disabled, labelledBy, idPrefix }: { value: ReleaseNoteIcon | null; onChange: (v: ReleaseNoteIcon | null) => void; disabled?: boolean; labelledBy: string; idPrefix: string }) {
  const { t } = useI18n();
  return (
    <div className="icon-pick" role="radiogroup" aria-labelledby={labelledBy}>
      <label className={cx("ip", value === null && "on")} title={t("wn.noIcon")}>
        <input type="radio" name={idPrefix} className="sr-only" checked={value === null} disabled={disabled} onChange={() => onChange(null)} aria-label={t("wn.noIcon")} />
        <Icon name="x" />
      </label>
      {NOTE_ICONS.map((ic) => (
        <label key={ic} className={cx("ip", value === ic && "on")} title={t(`icon.${ic}`)}>
          <input type="radio" name={idPrefix} className="sr-only" checked={value === ic} disabled={disabled} onChange={() => onChange(ic)} aria-label={t(`icon.${ic}`)} data-testid={`${idPrefix}-${ic}`} />
          <MiniIcon name={ic} size={18} />
        </label>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- preview: the Mini App sheet in a phone frame */

export function WhatsNewPreview({ d, initialLang = "ru" }: { d: NoteDraft; initialLang?: UiLang }) {
  const { t } = useI18n();
  const [lang, setLang] = useState<UiLang>(initialLang);
  const [dark, setDark] = useState(false);
  const [idx, setIdx] = useState(0);
  useEffect(() => setLang(initialLang), [initialLang]);
  const n = d.items.length;
  const k = Math.min(idx, Math.max(0, n - 1));
  const it = d.items[k];
  const welcome = d.audience === "new";
  const last = k >= n - 1;
  return (
    <div className="stack sm wn-preview" data-testid="wn-preview">
      <div className="row between">
        <span className="field-label">{t("wn.preview")}</span>
        <PreviewControls lang={lang} setLang={setLang} dark={dark} setDark={setDark} />
      </div>
      <Phone dark={dark} label={t("wn.previewLabel", { l: lang.toUpperCase() })} testId="wn-phone">
        <div className="mx-sheet" lang={lang === "uz" ? "uz-Latn" : lang}>
          <span className="mx-grab" aria-hidden="true" />
          <div className="mx-cap">{lt(lang, welcome ? "wn.welcome.cap" : "wn.updates.cap")}</div>
          <div className="mx-h">{lt(lang, welcome ? "wn.welcome.title" : "wn.updates.title")}</div>
          {it ? (
            <div className="mx-card" data-testid="wn-pv-card">
              <div className="mx-row">
                <span className="mx-pill">
                  <Maybe text={d.title[lang]} lang={lang} />
                </span>
                <span className="mx-sub">{lt(lang, "wn.progress", { n: k + 1, m: n })}</span>
              </div>
              <div className="mx-row start">
                {it.icon && (
                  <span className="mx-ic">
                    <MiniIcon name={it.icon} />
                  </span>
                )}
                <Maybe text={it.title[lang]} lang={lang} className="mx-t" />
              </div>
              <Maybe text={it.text[lang]} lang={lang} className="mx-text" />
            </div>
          ) : null}
          <div className="mx-dots" aria-hidden="true">
            {d.items.map((_, j) => (
              <i key={j} className={j === k ? "on" : undefined} />
            ))}
          </div>
          <div className="mx-duo">
            {it?.link ? <span className="mx-btn sec">{lt(lang, "wn.more")}</span> : <span />}
            <span className="mx-btn">{last ? lt(lang, "wn.gotIt") : lt(lang, "wn.next")}</span>
          </div>
          <p className="mx-once">{lt(lang, "wn.once")}</p>
        </div>
      </Phone>
      <div className="row center-row">
        <Btn size="xs" kind="ghost" icon="chevL" aria={t("wn.pvPrev")} disabled={k === 0} onClick={() => setIdx(k - 1)} testId="wn-pv-prev" />
        <span className="xs muted" aria-live="polite">
          {t("wn.pvItem", { n: k + 1, m: n })}
          {it?.link ? ` · → ${t(`route.${it.link}`)}` : ""}
        </span>
        <Btn size="xs" kind="ghost" icon="chevR" aria={t("wn.pvNext")} disabled={last} onClick={() => setIdx(k + 1)} testId="wn-pv-next" />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- statistics */

function NoteStats({ note }: { note: StaffReleaseNote }) {
  const i = useI18n();
  const { t, fmt } = i;
  const [s, setS] = useState<ReleaseNoteStats | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    setError(null);
    ReleaseNotes.stats(note.release_note_id)
      .then(setS)
      .catch(setError);
  }, [note.release_note_id]);
  useEffect(load, [load]);
  const bar = (n: number, total: number) => <span className="barbg" aria-hidden="true"><span className="barfg" style={{ width: `${total ? Math.round((n / total) * 100) : 0}%` }} /></span>;
  return (
    <section className="card stack sm" aria-labelledby="wn-st-h" data-testid="wn-stats">
      <div className="row between">
        <h2 className="h2" id="wn-st-h">
          {t("wn.stats", { slug: note.slug })}
        </h2>
        <Btn size="xs" icon="refresh" label={t("common.refresh")} onClick={load} />
      </div>
      {error ? (
        <LoadError error={error} onRetry={load} />
      ) : !s ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="grid2 tight">
          <div>
            <div className="kpi-l">{t("wn.viewsTotal")}</div>
            <div className="kpi-v" data-testid="wn-stats-total">
              {fmt.num(s.views_total)}
            </div>
            <div className="kpi-n">
              {s.first_view_at ? t("wn.viewsRange", { a: fmt.dateTime(s.first_view_at), b: fmt.dateTime(s.last_view_at) }) : t("wn.noViews")}
            </div>
          </div>
          <div>
            {LANGS.map((l) => (
              <div className="kv" key={l}>
                <span>{t(`ulang.${l}`)}</span>
                <span className="row nowrap-row">
                  {bar(s.views_by_lang[l] ?? 0, s.views_total)}
                  <span className="num">{fmt.num(s.views_by_lang[l] ?? 0)}</span>
                </span>
              </div>
            ))}
            {AGE_SEGMENTS.map((a) => (
              <div className="kv" key={a}>
                <span>{t(`ageseg.${a}`)}</span>
                <span className="row nowrap-row">
                  {bar(s.views_by_age[a] ?? 0, s.views_total)}
                  <span className="num">{fmt.num(s.views_by_age[a] ?? 0)}</span>
                </span>
              </div>
            ))}
            <p className="xs muted mt-8">{t("wn.statsNote")}</p>
          </div>
        </div>
      )}
    </section>
  );
}
