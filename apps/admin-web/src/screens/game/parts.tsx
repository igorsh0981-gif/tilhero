/**
 * Shared pieces of the «Игра» sections: RU/UZ text fields with counters and problems, the audience checkboxes, a game
 * picture (same-origin URL of admin-bff, CSP img-src 'self'; a broken picture shows a placeholder with a text, never a
 * broken icon), the upload of a picture (type, size and dimensions checked by the bytes before sending), the picker of
 * an already uploaded picture, amounts with their unit, KPI tiles and the texts of form problems.
 */
import { useRef, useState, type ReactNode } from "react";
import type { AdminGameImage, GameAudience, Localized } from "@tilhero/contracts/admin";
import type { GameCurrency } from "@tilhero/contracts/bff";
import { Game, type AssetPurpose } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey, type Vars } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { Btn, cx, FieldErr, Pill } from "../../ui/kit";
import { Modal } from "../../ui/overlays";
import { errText } from "../../ui/errors";
import { useToast } from "../../ui/toasts";
import { AUDIENCES, fieldId, inspectImageFile, issuesAt, normPath, type Issue } from "./model";

/** Text of a form problem: `gi.<code>` of the dictionary, else the raw code (an unknown server code stays readable). */
export function useIssueText() {
  const { t } = useI18n();
  return (x: Issue, vars?: Vars) => {
    const k = `gi.${x.code}` as MessageKey;
    const s = t(k, vars);
    return s === k ? x.code : s;
  };
}

/** Human label of a path of the rules («quests.templates[2].reward.til» → «Задания · Шаблон 3 · Награда · Тилы»). */
export function usePathLabel() {
  const { t } = useI18n();
  return (path: string) =>
    normPath(path)
      .split(/\.|(?=\[)/)
      .filter(Boolean)
      .map((seg) => {
        const m = /^\[(\d+)\]$/.exec(seg);
        if (m) return t("grp.index", { n: Number(m[1]) + 1 });
        const k = `grp.${seg}` as MessageKey;
        const s = t(k);
        return s === k ? seg : s;
      })
      .join(" · ");
}

export function IssueMsg({ issues, id, vars }: { issues: readonly Issue[]; id?: string; vars?: Vars }) {
  const text = useIssueText();
  if (!issues.length) return null;
  return <FieldErr msg={[...new Set(issues.map((x) => text(x, vars)))].join(" · ")} id={id} />;
}

/** RU and UZ of one localized text: label, counter, inline problem (paths `${path}.ru` / `${path}.uz`). */
export function LocFields({ prefix, path, label, value, onChange, max, issues, disabled, area, required = true, testId }: { prefix: string; path: string; label: string; value: Localized; onChange: (v: Localized) => void; max: number; issues: readonly Issue[]; disabled?: boolean; area?: boolean; required?: boolean; testId?: string }) {
  const { t, fmt } = useI18n();
  return (
    <div className="form-grid" data-testid={testId}>
      {(["ru", "uz"] as const).map((l) => {
        const id = fieldId(prefix, `${path}.${l}`);
        const xs = issuesAt(issues, `${path}.${l}`);
        const n = value[l].length;
        const props = {
          id,
          className: cx(area ? "textarea" : "input", xs.length > 0 && "is-invalid"),
          value: value[l],
          disabled,
          lang: l === "uz" ? "uz-Latn" : "ru",
          "aria-invalid": xs.length > 0 || undefined,
          "aria-describedby": xs.length ? `${id}-e` : undefined,
          onChange: (e: { target: { value: string } }) => onChange({ ...value, [l]: e.target.value }),
          "data-testid": testId ? `${testId}-${l}` : undefined,
        };
        return (
          <div className="field" key={l}>
            <div className="field-top">
              <label htmlFor={id} className={cx(required && "req")}>
                {label} · {l.toUpperCase()}
              </label>
              <span className={cx("counter", n > max && "is-over")} aria-hidden="true">
                {fmt.num(n)}/{fmt.num(max)}
              </span>
            </div>
            {area ? <textarea rows={2} maxLength={max * 2} {...props} /> : <input maxLength={max * 2} {...props} />}
            <IssueMsg issues={xs} id={`${id}-e`} vars={{ n: max }} />
            {l === "uz" && !xs.length && !disabled && <span className="hint">{t("gm.uzHint")}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** The audiences of a hero / item / event: three checkboxes in a fieldset. */
export function AudiencePicker({ id, value, onChange, disabled, issues, legend, hint }: { id: string; value: GameAudience[]; onChange: (v: GameAudience[]) => void; disabled?: boolean; issues?: readonly Issue[]; legend?: string; hint?: ReactNode }) {
  const { t } = useI18n();
  const xs = issues ?? [];
  return (
    <fieldset className="fs" id={id} aria-describedby={xs.length ? `${id}-e` : undefined}>
      <legend className="field-label">{legend ?? t("gm.audiences")}</legend>
      <div className="row">
        {AUDIENCES.map((a) => (
          <label className="check" key={a}>
            <input type="checkbox" checked={value.includes(a)} disabled={disabled} onChange={(e) => onChange(AUDIENCES.filter((x) => (x === a ? e.target.checked : value.includes(x))))} data-testid={`${id}-${a}`} />
            {t(`ageseg.${a}`)}
          </label>
        ))}
      </div>
      {hint && <span className="hint small muted">{hint}</span>}
      <IssueMsg issues={xs} id={`${id}-e`} />
    </fieldset>
  );
}

export function AudiencePills({ value }: { value: readonly GameAudience[] }) {
  const { t } = useI18n();
  if (!value.length)
    return (
      <Pill tone="warn" testId="aud-hidden">
        {t("gm.audNone")}
      </Pill>
    );
  return (
    <span className="row xs-gap">
      {AUDIENCES.filter((a) => value.includes(a)).map((a) => (
        <span className="tag plain" key={a}>
          {t(`gm.aud.${a}`)}
        </span>
      ))}
    </span>
  );
}

/** A game picture by its same-origin URL; a failed load shows a framed placeholder with a text. */
export function GameImg({ img, alt, size = 96, testId }: { img: AdminGameImage | null | undefined; alt: string; size?: number; testId?: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState<string | null>(null);
  if (!img || failed === img.asset_id)
    return (
      <span className="g-img is-empty" style={{ width: size, height: size }} role="img" aria-label={img ? t("gm.imgFailed") : t("gm.imgNone")} data-testid={testId}>
        <Icon name="image" />
      </span>
    );
  return (
    <span className="g-img" style={{ width: size, height: size }}>
      <img src={img.url} alt={alt} width={img.width} height={img.height} loading="lazy" decoding="async" onError={() => setFailed(img.asset_id)} data-testid={testId} data-asset={img.asset_id} />
    </span>
  );
}

/**
 * «Загрузить новую»: a webp / png ≤ 300 KB, ≤ 1024×1024 checked by its bytes, then POST /game/assets (game.manage) —
 * the same picture comes back with the same asset_id. A rejected file never leaves the browser.
 */
export function ImageUpload({ purpose, onDone, disabled, label, aria, testId }: { purpose: AssetPurpose; onDone: (img: AdminGameImage) => void; disabled?: boolean; label?: string; /** the accessible name of the file field (three stages — three different names) */ aria?: string; testId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    // the size before anything is read, then only the first 64 bytes; the whole file only for the upload
    const chk = await inspectImageFile(file);
    if (!chk.ok) {
      setErr(t(`gm.imgErr.${chk.reason}` as MessageKey));
      if (input.current) input.current.value = "";
      return;
    }
    setBusy(true);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const img = await Game.upload(buf, chk.type, purpose);
      onDone(img);
      toast(t("gm.uploaded", { w: img.width, h: img.height, kb: Math.max(1, Math.round(img.size / 1024)) }), "ok", "game.asset_uploaded");
    } catch (e) {
      setErr(e instanceof ApiError && (e.code === "ASSET_INVALID" || e.code === "ASSET_TOO_LARGE") ? t(`err.${e.code}` as MessageKey) : errText(i18n, e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const id = `${testId}-file`;
  return (
    <span className="g-upload">
      <label className={cx("btn sm", (busy || disabled) && "is-busy")} htmlFor={id} aria-disabled={disabled || undefined}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="download" />}
        <span>{label ?? t("gm.upload")}</span>
      </label>
      <input ref={input} id={id} type="file" className="sr-only" accept=".webp,.png,image/webp,image/png" aria-label={aria} aria-describedby={err ? `${id}-e` : undefined} disabled={busy || disabled} onChange={(e) => void onFile(e.target.files?.[0])} data-testid={testId} />
      <FieldErr msg={err} id={`${id}-e`} />
    </span>
  );
}

/** «Выбрать из загруженных»: the pictures the section already knows (live and draft of every hero / item), one click. */
export function ImagePicker({ title, images, current, onPick, onClose, labelOf, testId }: { title: string; images: AdminGameImage[]; current: string | null; onPick: (img: AdminGameImage) => void; onClose: () => void; labelOf: (img: AdminGameImage) => string; testId: string }) {
  const { t } = useI18n();
  const [sel, setSel] = useState<string | null>(current);
  const chosen = images.find((x) => x.asset_id === sel) ?? null;
  return (
    <Modal
      title={title}
      icon="image"
      onClose={onClose}
      testId={testId}
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} />
          <Btn label={t("gm.pickThis")} kind="primary" disabled={!chosen || chosen.asset_id === current} onClick={() => chosen && onPick(chosen)} testId={`${testId}-ok`} />
        </>
      }
    >
      {images.length ? (
        <div className="img-pick" role="group" aria-label={title}>
          {images.map((img) => (
            <button key={img.asset_id} type="button" className="img-pick-i" aria-pressed={sel === img.asset_id} onClick={() => setSel(img.asset_id)} data-testid={`${testId}-${img.asset_id}`}>
              <GameImg img={img} alt="" size={84} />
              <span className="xs">{labelOf(img)}</span>
              <span className="xs muted mono">
                {img.width}×{img.height} · {Math.max(1, Math.round(img.size / 1024))} KB
              </span>
              {img.asset_id === current && <span className="xs b">{t("gm.current")}</span>}
            </button>
          ))}
        </div>
      ) : (
        <p className="small muted">{t("gm.noImages")}</p>
      )}
    </Modal>
  );
}

/** «+20 XP», «−40 тилов», «2 заморозки» */
export function useAmount() {
  const { fmt, tp } = useI18n();
  return (c: GameCurrency, n: number, withSign = false) => {
    const abs = Math.abs(n);
    const unit = c === "xp" ? `${fmt.num(abs)} XP` : tp(c === "til" ? "gm.n.til" : "gm.n.freeze", abs).replace(String(abs), fmt.num(abs));
    return `${n < 0 ? "−" : withSign && n > 0 ? "+" : ""}${unit}`;
  };
}

export function Kpi({ label, value, note, testId }: { label: string; value: ReactNode; note?: ReactNode; testId?: string }) {
  return (
    <div className="card kpi" data-testid={testId}>
      <div className="kpi-l">{label}</div>
      <div className="kpi-v">{value}</div>
      {note != null && <div className="kpi-n">{note}</div>}
    </div>
  );
}

/** Problems of a whole form as a list with links to their fields (focus on click). */
export function IssuesPanel({ title, issues, prefix, tone, testId }: { title: string; issues: readonly Issue[]; prefix: string; tone: "bad" | "warn"; testId: string }) {
  const text = useIssueText();
  const label = usePathLabel();
  if (!issues.length) return null;
  return (
    <section className={cx("issues-panel", `is-${tone}`)} aria-label={title} data-testid={testId}>
      <h3 className="h3">
        <Icon name={tone === "bad" ? "alertCircle" : "alert"} /> {title}
      </h3>
      <ul className="issue-list">
        {issues.map((x, i) => (
          <li key={`${x.path}:${x.code}:${i}`} data-path={normPath(x.path)} data-code={x.code}>
            <button type="button" className="tr" onClick={() => focusField(prefix, x.path)}>
              {label(x.path)}
            </button>
            <span className="grow">{text(x)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Focus the field of a path — or the nearest field of its parent path (an error of a whole list). */
export function focusField(prefix: string, path: string) {
  let p = normPath(path);
  for (;;) {
    const el = document.getElementById(fieldId(prefix, p)) as HTMLElement | null;
    if (el) {
      el.scrollIntoView?.({ block: "center" });
      (el.matches("input,select,textarea,button") ? el : el.querySelector<HTMLElement>("input,select,textarea,button"))?.focus();
      return;
    }
    const cut = Math.max(p.lastIndexOf("."), p.lastIndexOf("["));
    if (cut <= 0) return;
    p = p.slice(0, cut);
  }
}
