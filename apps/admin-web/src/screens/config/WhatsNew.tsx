/**
 * 9.4 «Конфигурация интерфейса» → «Что нового»: заметки о релизах Mini App.
 * Список со статусами, редактор RU/EN с пунктами (добавить, удалить, порядок), превью шторки в рамке телефона
 * (тёмная/светлая, RU/EN), «Опубликовать» и «Архивировать» с подтверждением и причиной (аудит). Права — как у версий
 * конфигурации: config.read / config.edit / config.publish (бэкенд перепроверяет каждую команду).
 * Тексты заметки — только как текст (React экранирует; никакой разметки).
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ReleaseNoteAudience, ReleaseNoteContent, StaffReleaseNote } from "@tilhero/contracts/admin";
import { ReleaseNotes } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { translate, useI18n, type Lang, type MessageKey } from "../../i18n";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Select, Spinner } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { MiniIcon } from "./miniIcons";

/* ---------------------------------------------------------------- shared catalogue (packages/contracts/release-notes.json) */

export const NOTE_ROUTES = ["home", "catalog", "watch", "news", "profile", "support"] as const;
export const NOTE_ICONS = ["spark", "ticket", "globe", "pin", "bell", "radar", "news", "route", "star", "plane", "bed", "search", "shield", "chat", "cal", "phone"] as const;
export const LIMITS = { title: 80, itemTitle: 80, text: 200, itemsMax: 6 } as const;
const SLUG = /^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$/;

type Route = (typeof NOTE_ROUTES)[number];
type Item = ReleaseNoteContent["items"][number];
export type Draft = ReleaseNoteContent;

const emptyItem = (): Item => ({ title: { ru: "", en: "" }, text: { ru: "", en: "" }, link: null, icon: null });

/** Next free «YYYY.MM» label (2026.11 → 2026.11-2 when taken). */
export function nextSlug(taken: readonly string[], now = new Date()): string {
  const base = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
  return base;
}

export function emptyDraft(slug: string): Draft {
  return { slug, title: { ru: "", en: "" }, items: [emptyItem()], audience: "existing" };
}

export function contentOf(n: Pick<StaffReleaseNote, "slug" | "title" | "items" | "audience">): Draft {
  return {
    slug: n.slug,
    title: { ...n.title },
    items: n.items.map((i) => ({ title: { ...i.title }, text: { ...i.text }, link: i.link ?? null, icon: i.icon ?? null })),
    audience: n.audience,
  };
}

/** Plain-text cleanup as on the server: whitespace collapsed, trimmed. */
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function normalizeDraft(d: Draft): Draft {
  return {
    slug: d.slug.trim(),
    title: { ru: clean(d.title.ru), en: clean(d.title.en) },
    items: d.items.map((i) => ({ title: { ru: clean(i.title.ru), en: clean(i.title.en) }, text: { ru: clean(i.text.ru), en: clean(i.text.en) }, link: i.link, icon: i.icon })),
    audience: d.audience,
  };
}

/** Field errors by path: "slug", "title.ru", "items.0.text.en". */
export function validateDraft(raw: Draft): Record<string, { key: MessageKey; n?: number }> {
  const d = normalizeDraft(raw);
  const errs: Record<string, { key: MessageKey; n?: number }> = {};
  if (!SLUG.test(d.slug)) errs.slug = { key: "wn.errSlug" };
  const text = (path: string, v: string, max: number) => {
    if (!v) errs[path] = { key: "wn.errReq" };
    else if (v.length > max) errs[path] = { key: "wn.errLen", n: max };
  };
  for (const l of ["ru", "en"] as const) text(`title.${l}`, d.title[l], LIMITS.title);
  d.items.forEach((it, k) => {
    for (const l of ["ru", "en"] as const) {
      text(`items.${k}.title.${l}`, it.title[l], LIMITS.itemTitle);
      text(`items.${k}.text.${l}`, it.text[l], LIMITS.text);
    }
  });
  return errs;
}

const same = (a: Draft | null, b: Draft | null) => JSON.stringify(a) === JSON.stringify(b);

/* ---------------------------------------------------------------- page */

type Sel = { kind: "new" } | { kind: "note"; id: string } | null;
type Cmd = { kind: "publish" | "archive"; note: StaffReleaseNote } | null;

const STATUS_TONE = { draft: "warn", published: "good", archived: "neutral" } as const;

export function WhatsNewConfig() {
  const i = useI18n();
  const { t } = i;
  const { can } = useSession();
  const toast = useToast();
  const [notes, setNotes] = useState<StaffReleaseNote[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState<Draft | null>(null);
  const [errs, setErrs] = useState<ReturnType<typeof validateDraft>>({});
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cmd, setCmd] = useState<Cmd>(null);

  const load = useCallback(async () => {
    try {
      const r = await ReleaseNotes.list();
      setNotes(r.items);
      setError(null);
      return r.items;
    } catch (e) {
      setError(e);
      return null;
    }
  }, []);
  useEffect(() => {
    void load().then((items) => {
      const first = items?.find((n) => n.status === "draft") ?? items?.[0];
      if (first) open(first);
    });
    // first load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = sel?.kind === "note" ? (notes?.find((n) => n.release_note_id === sel.id) ?? null) : null;
  const editable = can("config.edit") && (sel?.kind === "new" || current?.status === "draft");
  const dirty = !!draft && !same(normalizeDraft(draft), base ? normalizeDraft(base) : null);

  function open(n: StaffReleaseNote) {
    setSel({ kind: "note", id: n.release_note_id });
    const c = contentOf(n);
    setDraft(c);
    setBase(c);
    setErrs({});
    setFormErr(null);
  }
  const startNew = (from?: Draft) => {
    const taken = (notes ?? []).filter((n) => n.status !== "archived").map((n) => n.slug);
    setSel({ kind: "new" });
    setDraft(from ? { ...contentOf(from), slug: nextSlug(taken) } : emptyDraft(nextSlug(taken)));
    setBase(null);
    setErrs({});
    setFormErr(null);
  };

  const save = async () => {
    if (!draft) return;
    const e = validateDraft(draft);
    setErrs(e);
    if (Object.keys(e).length) return setFormErr(t("wn.errForm"));
    setSaving(true);
    setFormErr(null);
    try {
      const body = normalizeDraft(draft);
      const n = sel?.kind === "note" && current ? await ReleaseNotes.update(current.release_note_id, current.version, body) : await ReleaseNotes.create(body);
      toast(t(sel?.kind === "new" ? "wn.created" : "wn.saved", { slug: n.slug }), "ok", sel?.kind === "new" ? "release_note.create" : "release_note.update");
      const items = await load();
      open(items?.find((x) => x.release_note_id === n.release_note_id) ?? n);
    } catch (ex) {
      if ((ex as ApiError).cancelled) return;
      const loc = ex instanceof ApiError && Array.isArray(ex.details.errors) ? (ex.details.errors as Array<{ loc?: unknown[] }>)[0]?.loc?.slice(1).join(".") : null;
      setFormErr(loc ? `${errText(i, ex)} · ${loc}` : errText(i, ex));
    } finally {
      setSaving(false);
    }
  };

  if (error && !notes) return <LoadError error={error} onRetry={() => void load()} />;
  if (!notes) return <Spinner label={t("common.loading")} />;

  return (
    <div className="cfg-layout wn-cfg" data-testid="wn-config">
      <div className="stack">
        <p className="small muted wn-lead">{t("wn.lead")}</p>
        <section className="panel" data-testid="wn-list">
          <div className="panel-h">
            <h2 className="panel-t grow">
              <Icon name="sparkles" />
              {t("wn.list")}
            </h2>
            <Btn size="sm" kind="primary" icon="plus" label={t("wn.new")} perm="config.edit" onClick={() => startNew()} testId="wn-new" />
          </div>
          {notes.length ? (
            <ul className="wn-rows">
              {notes.map((n) => {
                const active = sel?.kind === "note" && sel.id === n.release_note_id;
                return (
                  <li key={n.release_note_id}>
                    <button type="button" className={cx("wn-row", active && "is-active")} aria-current={active ? "true" : undefined} aria-label={t("wn.open", { slug: n.slug })} onClick={() => open(n)} data-testid={`wn-row-${n.slug}`}>
                      <span className="mono b">{n.slug}</span>
                      <span className="grow wn-row-t">{n.title.ru}</span>
                      <Pill tone={STATUS_TONE[n.status]}>{t(`wn.st.${n.status}`)}</Pill>
                      <span className="xs muted nowrap">{i.fmt.dateTime(n.published_at ?? n.updated_at)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="panel-b">
              <Empty icon="sparkles" title={t("wn.empty")} text={t("wn.emptyText")} testId="wn-empty" />
            </div>
          )}
        </section>

        {draft && (
          <section className="panel" data-testid="wn-editor">
            <div className="panel-h">
              <h2 className="panel-t grow">
                <Icon name="edit" />
                {sel?.kind === "new" ? t("wn.ed.new") : current?.status === "draft" ? t("wn.ed.draft", { slug: current.slug }) : t("wn.ed.view", { slug: current?.slug ?? "" })}
              </h2>
              {current && <Pill tone={STATUS_TONE[current.status]}>{t(`wn.st.${current.status}`)}</Pill>}
            </div>
            <div className="panel-b stack sm">
              {!editable && current && current.status !== "draft" && <Callout icon="lock">{t("wn.ed.ro")}</Callout>}
              {!editable && (sel?.kind === "new" || current?.status === "draft") && <Callout icon="lock">{t("cfg.ro", { p: "config.edit" })}</Callout>}
              <Editor d={draft} set={setDraft} ro={!editable} errs={errs} />
              <FieldErr msg={formErr} />
              <div className="row wn-actions">
                {editable && <Btn kind="primary" icon="check" label={t("wn.save")} perm="config.edit" busy={saving} disabled={!dirty && sel?.kind !== "new"} onClick={() => void save()} testId="wn-save" />}
                {current?.status === "draft" && (
                  <Btn
                    kind="accent"
                    icon="send"
                    label={t("wn.publish")}
                    perm="config.publish"
                    disabled={dirty}
                    title={dirty ? t("wn.pubNeedSave") : undefined}
                    onClick={() => setCmd({ kind: "publish", note: current })}
                    testId="wn-publish"
                  />
                )}
                {current && current.status !== "archived" && <Btn kind="ghost" icon="inbox" label={t("wn.archive")} perm="config.publish" onClick={() => setCmd({ kind: "archive", note: current })} testId="wn-archive" />}
                {current && current.status !== "draft" && <Btn kind="ghost" icon="copy" label={t("wn.copy")} perm="config.edit" onClick={() => startNew(draft)} testId="wn-copy" />}
                {dirty && editable && <span className="small muted">{t("wn.unsaved")}</span>}
              </div>
              <p className="xs muted row">
                <Icon name="audit" /> {t("wn.audit")}
              </p>
            </div>
          </section>
        )}
      </div>
      <aside className="cfg-preview">{draft && <SheetPreview d={draft} publishedAt={current?.published_at ?? null} />}</aside>

      {cmd && (
        <ConfirmCommand
          title={t(cmd.kind === "publish" ? "wn.pubT" : "wn.arcT", { title: cmd.note.title.ru })}
          text={t(cmd.kind === "publish" ? "wn.pubM" : "wn.arcM")}
          icon={cmd.kind === "publish" ? "send" : "inbox"}
          tone="warn"
          ok={t(cmd.kind === "publish" ? "wn.publish" : "wn.archive")}
          testId="wn-confirm"
          onClose={() => setCmd(null)}
          onConfirm={async (reason) => {
            try {
              const n = cmd.kind === "publish" ? await ReleaseNotes.publish(cmd.note.release_note_id, cmd.note.version, reason) : await ReleaseNotes.archive(cmd.note.release_note_id, reason);
              toast(t(cmd.kind === "publish" ? "wn.published" : "wn.archived", { slug: n.slug }), "ok", `release_note.${cmd.kind}`);
              const items = await load();
              open(items?.find((x) => x.release_note_id === n.release_note_id) ?? n);
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

/* ---------------------------------------------------------------- editor */

function TextField(p: { id: string; label: string; value: string; max: number; ro: boolean; err?: { key: MessageKey; n?: number }; area?: boolean; onChange: (v: string) => void; testId?: string }) {
  const { t } = useI18n();
  const errId = `${p.id}-err`;
  const common = {
    id: p.id,
    value: p.value,
    disabled: p.ro,
    maxLength: p.max + 40,
    "aria-invalid": p.err ? true : undefined,
    "aria-describedby": p.err ? errId : undefined,
    "data-testid": p.testId,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => p.onChange(e.target.value),
  };
  const len = clean(p.value).length;
  return (
    <div className="field">
      <label htmlFor={p.id} className="row between">
        <span>{p.label}</span>
        <span className={cx("xs", len > p.max ? "bad" : "muted")}>
          {len}/{p.max}
        </span>
      </label>
      {p.area ? <textarea className={cx("textarea", p.err && "is-invalid")} rows={2} {...common} /> : <input className={cx("input", p.err && "is-invalid")} {...common} />}
      <FieldErr id={errId} msg={p.err ? t(p.err.key, p.err.n != null ? { n: p.err.n } : undefined) : null} />
    </div>
  );
}

function Editor({ d, set, ro, errs }: { d: Draft; set: (d: Draft) => void; ro: boolean; errs: ReturnType<typeof validateDraft> }) {
  const { t } = useI18n();
  const uid = useId();
  const setItem = (k: number, it: Item) => set({ ...d, items: d.items.map((x, j) => (j === k ? it : x)) });
  const move = (k: number, dir: number) => {
    const j = k + dir;
    if (j < 0 || j >= d.items.length) return;
    const items = [...d.items];
    [items[k], items[j]] = [items[j]!, items[k]!];
    set({ ...d, items });
  };
  const routeOptions = [{ v: "", label: t("wn.link.none") }, ...NOTE_ROUTES.map((r) => ({ v: r, label: t(`wn.route.${r}`) }))];
  const iconOptions = [{ v: "", label: t("wn.icon.none") }, ...NOTE_ICONS.map((ic) => ({ v: ic, label: ic }))];
  return (
    <div className="stack sm">
      <div className="wn-pair">
        <div className="field">
          <label htmlFor={`${uid}-slug`}>{t("wn.f.slug")}</label>
          <input
            id={`${uid}-slug`}
            className={cx("input mono", errs.slug && "is-invalid")}
            value={d.slug}
            maxLength={32}
            disabled={ro}
            aria-invalid={errs.slug ? true : undefined}
            onChange={(e) => set({ ...d, slug: e.target.value })}
            data-testid="wn-slug"
          />
          {errs.slug ? <FieldErr msg={t(errs.slug.key)} /> : <span className="hint">{t("wn.f.slugHint")}</span>}
        </div>
        <div className="field">
          <label htmlFor={`${uid}-aud`}>{t("wn.f.audience")}</label>
          <Select<ReleaseNoteAudience>
            id={`${uid}-aud`}
            label={t("wn.f.audience")}
            value={d.audience}
            disabled={ro}
            onChange={(v) => set({ ...d, audience: v })}
            options={[
              { v: "existing", label: t("wn.aud.existing") },
              { v: "all", label: t("wn.aud.all") },
            ]}
            testId="wn-audience"
          />
        </div>
      </div>
      <div className="wn-pair">
        {(["ru", "en"] as const).map((l) => (
          <TextField
            key={l}
            id={`${uid}-title-${l}`}
            label={`${t("wn.f.title")} · ${l.toUpperCase()}`}
            value={d.title[l]}
            max={LIMITS.title}
            ro={ro}
            err={errs[`title.${l}`]}
            onChange={(v) => set({ ...d, title: { ...d.title, [l]: v } })}
            testId={`wn-title-${l}`}
          />
        ))}
      </div>

      <div className="row between">
        <span className="field-label">{t("wn.items", { n: d.items.length })}</span>
        <Btn size="xs" kind="ghost" icon="plus" label={t("wn.addItem")} disabled={ro || d.items.length >= LIMITS.itemsMax} onClick={() => set({ ...d, items: [...d.items, emptyItem()] })} testId="wn-add-item" />
      </div>
      <ol className="wn-items">
        {d.items.map((it, k) => (
          <li key={k}>
            <fieldset className="wn-item" data-testid={`wn-item-${k}`}>
              <legend className="row between">
                <span className="row">
                  <span className="wn-item-ic" aria-hidden="true">
                    <MiniIcon name={it.icon ?? "spark"} size={16} />
                  </span>
                  <b className="small">{t("wn.item", { n: k + 1 })}</b>
                </span>
                <span className="row wn-item-mv">
                  <Btn size="xs" kind="ghost" icon="up" aria={`${t("cfg.up")}: ${t("wn.item", { n: k + 1 })}`} disabled={ro || k === 0} onClick={() => move(k, -1)} />
                  <Btn size="xs" kind="ghost" icon="down" aria={`${t("cfg.down")}: ${t("wn.item", { n: k + 1 })}`} disabled={ro || k === d.items.length - 1} onClick={() => move(k, 1)} />
                  <Btn size="xs" kind="danger-ghost" icon="x" aria={t("wn.removeItem", { n: k + 1 })} disabled={ro || d.items.length <= 1} onClick={() => set({ ...d, items: d.items.filter((_, j) => j !== k) })} testId={`wn-remove-${k}`} />
                </span>
              </legend>
              <div className="wn-pair">
                {(["ru", "en"] as const).map((l) => (
                  <TextField
                    key={`t-${l}`}
                    id={`${uid}-i${k}-t-${l}`}
                    label={`${t("wn.f.itemTitle")} · ${l.toUpperCase()}`}
                    value={it.title[l]}
                    max={LIMITS.itemTitle}
                    ro={ro}
                    err={errs[`items.${k}.title.${l}`]}
                    onChange={(v) => setItem(k, { ...it, title: { ...it.title, [l]: v } })}
                    testId={`wn-item-${k}-title-${l}`}
                  />
                ))}
                {(["ru", "en"] as const).map((l) => (
                  <TextField
                    key={`x-${l}`}
                    id={`${uid}-i${k}-x-${l}`}
                    label={`${t("wn.f.text")} · ${l.toUpperCase()}`}
                    value={it.text[l]}
                    max={LIMITS.text}
                    area
                    ro={ro}
                    err={errs[`items.${k}.text.${l}`]}
                    onChange={(v) => setItem(k, { ...it, text: { ...it.text, [l]: v } })}
                    testId={`wn-item-${k}-text-${l}`}
                  />
                ))}
                <div className="field">
                  <label htmlFor={`${uid}-i${k}-link`}>{t("wn.f.link")}</label>
                  <Select<string> id={`${uid}-i${k}-link`} label={t("wn.f.link")} value={it.link ?? ""} disabled={ro} options={routeOptions} onChange={(v) => setItem(k, { ...it, link: (v || null) as Route | null })} testId={`wn-item-${k}-link`} />
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-i${k}-icon`}>{t("wn.f.icon")}</label>
                  <Select<string> id={`${uid}-i${k}-icon`} label={t("wn.f.icon")} value={it.icon ?? ""} disabled={ro} options={iconOptions} onChange={(v) => setItem(k, { ...it, icon: v || null })} testId={`wn-item-${k}-icon`} />
                </div>
              </div>
            </fieldset>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------------------------------------------------------------- preview: the Mini App sheet in a phone frame */

/** Mini App strings of the sheet in the preview language (the same as apps/telegram-miniapp i18n wn.*). */
const mini = (lang: Lang) => ({
  h: translate(lang, "wn.ph.h"),
  view: translate(lang, "wn.ph.view"),
  ok: translate(lang, "wn.ph.ok"),
  untitled: translate(lang, "wn.ph.untitled"),
});

function SheetPreview({ d, publishedAt }: { d: Draft; publishedAt: string | null }) {
  const { t } = useI18n();
  const [dark, setDark] = useState(true);
  const [lang, setLang] = useState<Lang>("ru");
  const m = mini(lang);
  const date = useMemo(() => new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).format(publishedAt ? new Date(publishedAt) : new Date()), [lang, publishedAt]);
  const title = clean(d.title[lang]) || m.untitled;
  return (
    <div className="stack sm" data-testid="wn-preview">
      <div className="row between">
        <span className="field-label">{t("wn.preview")}</span>
        <span className="row">
          <div className="seg-mini" role="group" aria-label={t("theme.label")}>
            <button type="button" aria-pressed={!dark} onClick={() => setDark(false)}>
              {t("theme.light")}
            </button>
            <button type="button" aria-pressed={dark} onClick={() => setDark(true)}>
              {t("theme.dark")}
            </button>
          </div>
          <div className="seg-mini" role="group" aria-label="RU / EN">
            {(["ru", "en"] as const).map((l) => (
              <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </span>
      </div>
      <div className="phone" role="img" aria-label={`${t("wn.preview")}: ${title}`}>
        <div className={cx("phone-screen wn-ph", dark && "is-dark")}>
          <div className="ph-top">
            <span className="wm">
              Ai<b>Event</b>
            </span>
          </div>
          <div className="wn-ph-scrim" />
          <div className="wn-ph-sheet">
            <i className="wn-ph-grab" />
            <div className="wn-ph-h">
              <b>{m.h}</b>
              <small>
                {title} · {date}
              </small>
            </div>
            <ul className="wn-ph-list">
              {d.items.map((it, k) => (
                <li key={k}>
                  <span className="wn-ph-ic">
                    <MiniIcon name={it.icon ?? "spark"} size={13} />
                  </span>
                  <span className="wn-ph-t">
                    <b>{clean(it.title[lang]) || "…"}</b>
                    <span>{clean(it.text[lang]) || "…"}</span>
                    {it.link && <em>{m.view} ›</em>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="wn-ph-main">{m.ok}</div>
        </div>
      </div>
      <p className="xs muted" style={{ textAlign: "center" }}>
        {t("wn.prevNote")}
      </p>
    </div>
  );
}
