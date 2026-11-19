/**
 * Form parts of the content editors. Every field carries `data-path` = the catalog path of its value
 * («payload.stages[1].minutes», «payload.title.uz»): issues of the catalog (422 CONTENT_INVALID {errors[{path}]}) and of
 * the client checks are shown at that field, and «→ к полю» of the issue list focuses it. Learner texts are Localized
 * {ru, uz}: the editor shows the active language tab, highlights an empty translation once the other language has text
 * (or after a save attempt) and shows the other language as a reference under the field.
 */
import { createContext, useContext, useId, useState, type ReactNode } from "react";
import type { Localized } from "@tilhero/contracts/content";
import type { UiLang } from "@tilhero/contracts/admin";
import { useI18n, type MessageKey } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { Btn, cx } from "../../ui/kit";
import type { Issue, IssueMap } from "./model";
import { CONTROL_RE } from "./model";

export interface EdState {
  lang: UiLang;
  editable: boolean;
  /** shown issues by exact path (server + client after an attempt) */
  issues: IssueMap;
  /** a save / validate attempt was made: every empty translation is highlighted */
  tried: boolean;
}
export const EdCtx = createContext<EdState>({ lang: "ru", editable: false, issues: {}, tried: false });
export const useEd = () => useContext(EdCtx);

export const fieldId = (path: string) => `f-${path.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

/** Human text of an issue: the code from the dictionary; the catalog's own message (RU) as detail in the RU UI. */
export function useIssueText() {
  const { t, lang } = useI18n();
  return (i: Issue): string => {
    const key = `ci.${i.code}` as MessageKey;
    const head = t(key) === key ? t("ci.unknown", { code: i.code }) : t(key);
    return i.message && lang === "ru" && i.message !== head ? `${head} — ${i.message}` : head;
  };
}

/** Issues at exactly `path` (role=alert, referenced by aria-describedby of the field). */
export function PathIssues({ path, id }: { path: string; id?: string }) {
  const { issues } = useEd();
  const text = useIssueText();
  const xs = issues[path] ?? [];
  if (!xs.length) return null;
  const uniq = [...new Map(xs.map((x) => [`${x.code}|${x.message ?? ""}`, x])).values()];
  return (
    <span className="err" role="alert" id={id ?? `${fieldId(path)}-err`} data-testid={`err-${path}`}>
      <Icon name="alertCircle" />
      <span>{uniq.map(text).join("; ")}</span>
    </span>
  );
}

const hasIssue = (m: IssueMap, path: string) => (m[path]?.length ?? 0) > 0;

/** RU/UZ text of the learner: the active language of the editor, the other one as a reference. */
export function LocField({
  path,
  label,
  value,
  onChange,
  multiline,
  rows = 2,
  max = 1000,
  required = true,
  hint,
  testId,
}: {
  path: string;
  label: string;
  value: Localized;
  onChange: (v: Localized) => void;
  multiline?: boolean;
  rows?: number;
  max?: number;
  required?: boolean;
  hint?: ReactNode;
  testId?: string;
}) {
  const { t } = useI18n();
  const { lang, editable, issues, tried } = useEd();
  const other: UiLang = lang === "ru" ? "uz" : "ru";
  const p = `${path}.${lang}`;
  const id = fieldId(p);
  const v = value?.[lang] ?? "";
  const ov = value?.[other] ?? "";
  const bad = hasIssue(issues, p);
  const missing = required && !v.trim() && (tried || !!ov.trim() || bad);
  const over = v.length > max;
  const tid = testId ? `${testId}-${lang}` : undefined;
  const common = {
    id,
    value: v,
    disabled: !editable,
    lang: lang === "uz" ? "uz-Latn" : "ru",
    "aria-invalid": bad || missing || over || undefined,
    "aria-required": required || undefined,
    "aria-describedby": [bad ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined,
    "data-path": p,
    "data-missing": missing ? "true" : undefined,
    "data-testid": tid,
    maxLength: max + 200,
  };
  return (
    <div className={cx("field", missing && "is-missing")} data-path={path}>
      <div className="field-top">
        <label htmlFor={id} className={required ? "req" : undefined}>
          {label} <span className="lang-tag">{lang.toUpperCase()}</span>
          {missing && !bad && (
            <span className="miss-badge" data-testid={tid ? `${tid}-missing` : undefined}>
              {t("fx.empty")}
            </span>
          )}
        </label>
        <span className={cx("counter", over && "is-over")} aria-hidden="true">
          {v.length}/{max}
        </span>
      </div>
      {multiline ? (
        <textarea {...common} className={cx("textarea", (bad || missing || over) && "is-invalid")} rows={rows} onChange={(e) => onChange({ ...value, [lang]: e.target.value })} />
      ) : (
        <input {...common} className={cx("input", (bad || missing || over) && "is-invalid")} onChange={(e) => onChange({ ...value, [lang]: e.target.value })} />
      )}
      {ov.trim() ? (
        <span className="loc-ref" lang={other === "uz" ? "uz-Latn" : "ru"}>
          <b>{other.toUpperCase()}</b> {ov}
        </span>
      ) : null}
      {hint && (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      <PathIssues path={p} />
    </div>
  );
}

/** Plain text (EN of the course, ids, names): control characters are flagged at once. */
export function TextField({
  path,
  label,
  value,
  onChange,
  max = 240,
  mono,
  lang = "en",
  required,
  placeholder,
  multiline,
  rows = 2,
  hint,
  disabled,
  testId,
  className,
}: {
  path: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  max?: number;
  mono?: boolean;
  lang?: string;
  required?: boolean;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  hint?: ReactNode;
  disabled?: boolean;
  testId?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const { editable, issues } = useEd();
  const id = fieldId(path);
  const bad = hasIssue(issues, path);
  const ctrl = CONTROL_RE.test(value);
  const over = value.length > max;
  const common = {
    id,
    value,
    lang,
    placeholder,
    disabled: disabled || !editable,
    maxLength: max + 200,
    "aria-invalid": bad || ctrl || over || undefined,
    "aria-required": required || undefined,
    "aria-describedby": [bad ? `${id}-err` : null, hint || ctrl ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined,
    "data-path": path,
    "data-testid": testId,
  };
  return (
    <div className={cx("field", className)} data-path={path}>
      <div className="field-top">
        <label htmlFor={id} className={required ? "req" : undefined}>
          {label}
        </label>
        {max < 1000 && (
          <span className={cx("counter", over && "is-over")} aria-hidden="true">
            {value.length}/{max}
          </span>
        )}
      </div>
      {multiline ? (
        <textarea {...common} className={cx("textarea", mono && "mono", (bad || ctrl || over) && "is-invalid")} rows={rows} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} className={cx("input", mono && "mono", (bad || ctrl || over) && "is-invalid")} onChange={(e) => onChange(e.target.value)} />
      )}
      {(hint || ctrl) && (
        <span className="hint" id={`${id}-hint`}>
          {ctrl ? t("fx.control") : hint}
        </span>
      )}
      <PathIssues path={path} />
    </div>
  );
}

export function NumField({ path, label, value, onChange, min, max, step = 1, suffix, testId, className }: { path: string; label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; testId?: string; className?: string }) {
  const { editable, issues } = useEd();
  const id = fieldId(path);
  const bad = hasIssue(issues, path) || (min != null && value < min) || (max != null && value > max) || !Number.isFinite(value);
  return (
    <div className={cx("field num-field", className)} data-path={path}>
      <label htmlFor={id}>{label}</label>
      <span className="row nowrap-row">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          className={cx("input", bad && "is-invalid")}
          value={Number.isFinite(value) ? value : ""}
          min={min}
          max={max}
          step={step}
          disabled={!editable}
          aria-invalid={bad || undefined}
          aria-describedby={hasIssue(issues, path) ? `${id}-err` : undefined}
          data-path={path}
          data-testid={testId}
          onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
        />
        {suffix && <span className="small muted">{suffix}</span>}
      </span>
      <PathIssues path={path} />
    </div>
  );
}

export function SelectField<T extends string>({ path, label, value, options, onChange, required, testId, className, hint }: { path: string; label: string; value: T; options: Array<{ v: T; label: string; disabled?: boolean }>; onChange: (v: T) => void; required?: boolean; testId?: string; className?: string; hint?: ReactNode }) {
  const { editable, issues } = useEd();
  const id = fieldId(path);
  const bad = hasIssue(issues, path);
  return (
    <div className={cx("field", className)} data-path={path}>
      <label htmlFor={id} className={required ? "req" : undefined}>
        {label}
      </label>
      <select
        id={id}
        className={cx("select", "wide", bad && "is-invalid")}
        value={value}
        disabled={!editable}
        aria-invalid={bad || undefined}
        aria-describedby={[bad ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined}
        data-path={path}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.v} value={o.v} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      <PathIssues path={path} />
    </div>
  );
}

/** Multi-choice of a fixed list (audience, goals, topics, allowed uses). */
export function CheckGroup<T extends string>({ path, label, values, options, onChange, required, testId, className }: { path: string; label: string; values: readonly T[]; options: Array<{ v: T; label: string; disabled?: boolean; note?: string }>; onChange: (v: T[]) => void; required?: boolean; testId?: string; className?: string }) {
  const { editable, issues } = useEd();
  const lid = useId();
  const bad = hasIssue(issues, path) || (required && !values.length);
  return (
    <fieldset className={cx("field fs", className)} data-path={path} aria-describedby={hasIssue(issues, path) ? `${fieldId(path)}-err` : undefined} data-testid={testId}>
      <legend className={cx("field-label", required && "req")} id={lid}>
        {label}
      </legend>
      <div className={cx("check-row", bad && "is-invalid")}>
        {options.map((o) => (
          <label key={o.v} className={cx("check", o.disabled && "is-disabled")} title={o.note}>
            <input
              type="checkbox"
              checked={values.includes(o.v)}
              disabled={!editable || o.disabled}
              data-path={path}
              onChange={(e) => onChange(e.target.checked ? [...values.filter((x) => x !== o.v), o.v].sort((a, b) => options.findIndex((x) => x.v === a) - options.findIndex((x) => x.v === b)) : values.filter((x) => x !== o.v))}
              data-testid={testId ? `${testId}-${o.v}` : undefined}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      <PathIssues path={path} />
    </fieldset>
  );
}

/**
 * Ordered list of references (skills of a lesson, prerequisites, lessons of a module): chips with remove / move, and a
 * select to add one of the remaining options. Unknown ids stay visible (flagged) — they come from the payload.
 */
export function RefList({ path, label, values, options, onChange, max, ordered, required, testId, hint }: { path: string; label: string; values: readonly string[]; options: Array<{ v: string; label: string }>; onChange: (v: string[]) => void; max?: number; ordered?: boolean; required?: boolean; testId?: string; hint?: ReactNode }) {
  const { t } = useI18n();
  const { editable, issues } = useEd();
  const [pick, setPick] = useState("");
  const id = fieldId(path);
  const known = new Map(options.map((o) => [o.v, o.label]));
  const rest = options.filter((o) => !values.includes(o.v));
  const full = max != null && values.length >= max;
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= values.length) return;
    const xs = [...values];
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    onChange(xs);
  };
  return (
    <div className="field" data-path={path} data-testid={testId}>
      <span className={cx("field-label", required && "req")} id={`${id}-l`}>
        {label}
        {max != null && <span className="counter"> {values.length}/{max}</span>}
      </span>
      {values.length ? (
        <ul className="ref-chips" aria-labelledby={`${id}-l`}>
          {values.map((v, i) => (
            <li key={`${v}-${i}`} className={cx("ref-chip", !known.has(v) && "is-unknown", hasIssue(issues, `${path}[${i}]`) && "is-bad")} data-path={`${path}[${i}]`}>
              {ordered && <span className="idx">{i + 1}</span>}
              <span className="grow" title={known.get(v) ?? v}>
                <span className="mono">{v}</span>
                {known.get(v) && <span className="xs muted block">{known.get(v)}</span>}
              </span>
              {editable && ordered && (
                <>
                  <button type="button" className="icon-btn sm" aria-label={t("ct.moveUp", { x: v })} disabled={i === 0} onClick={() => move(i, -1)}>
                    <Icon name="up" />
                  </button>
                  <button type="button" className="icon-btn sm" aria-label={t("ct.moveDown", { x: v })} disabled={i === values.length - 1} onClick={() => move(i, 1)}>
                    <Icon name="down" />
                  </button>
                </>
              )}
              {editable && (
                <button type="button" className="icon-btn sm" aria-label={t("ct.removeX", { x: v })} onClick={() => onChange(values.filter((_, j) => j !== i))} data-testid={testId ? `${testId}-rm-${v}` : undefined}>
                  <Icon name="x" />
                </button>
              )}
              <PathIssues path={`${path}[${i}]`} />
            </li>
          ))}
        </ul>
      ) : (
        <span className="small muted">{t("ct.noneYet")}</span>
      )}
      {editable && !full && rest.length > 0 && (
        <span className="row nowrap-row">
          <select id={id} className="select wide" value={pick} aria-label={t("ct.addTo", { x: label })} onChange={(e) => setPick(e.target.value)} data-testid={testId ? `${testId}-pick` : undefined}>
            <option value="">{t("ct.choose")}</option>
            {rest.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
          <Btn
            size="sm"
            icon="plus"
            label={t("ct.add")}
            disabled={!pick}
            onClick={() => {
              if (!pick) return;
              onChange([...values, pick]);
              setPick("");
            }}
            testId={testId ? `${testId}-add` : undefined}
          />
        </span>
      )}
      {hint && <span className="hint">{hint}</span>}
      <PathIssues path={path} />
    </div>
  );
}

/** Free list of short strings (diagnostic tags, territories, accepted answers): comma separated input. */
export function TagsField({ path, label, values, onChange, upper, pattern, hint, testId, placeholder }: { path: string; label: string; values: readonly string[]; onChange: (v: string[]) => void; upper?: boolean; pattern?: RegExp; hint?: ReactNode; testId?: string; placeholder?: string }) {
  const { editable, issues } = useEd();
  const [text, setText] = useState(values.join(", "));
  const [focused, setFocused] = useState(false);
  const id = fieldId(path);
  const shown = focused ? text : values.join(", ");
  const bad = hasIssue(issues, path) || (pattern ? values.some((v) => !pattern.test(v)) : false);
  return (
    <div className="field" data-path={path}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className={cx("input mono", bad && "is-invalid")}
        value={shown}
        disabled={!editable}
        placeholder={placeholder}
        aria-invalid={bad || undefined}
        aria-describedby={[hasIssue(issues, path) ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined}
        data-path={path}
        data-testid={testId}
        onFocus={() => {
          setText(values.join(", "));
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value);
          const xs = e.target.value
            .split(/[,;\s]+/)
            .map((x) => (upper ? x.trim().toUpperCase() : x.trim()))
            .filter(Boolean);
          onChange([...new Set(xs)]);
        }}
      />
      {hint && (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      <PathIssues path={path} />
    </div>
  );
}

/** A titled block of the editor; issues at the block path itself (e.g. STAGES_INVALID on payload.stages) show under the title. */
export function Sec({ path, title, children, aside, testId, sub }: { path: string; title: ReactNode; children: ReactNode; aside?: ReactNode; testId?: string; sub?: ReactNode }) {
  const hid = useId();
  return (
    <section className="ed-sec" data-path={path} aria-labelledby={hid} data-testid={testId}>
      <div className="ed-sec-h">
        <h3 className="h3" id={hid}>
          {title}
        </h3>
        {aside}
      </div>
      {sub && <p className="xs muted">{sub}</p>}
      <PathIssues path={path} />
      {children}
    </section>
  );
}

/** Row header of a repeated item (control item, key word, node transition): number, title, move / remove. */
export function ItemHead({ n, title, onUp, onDown, onRemove, removeLabel, testId }: { n: number; title: ReactNode; onUp?: () => void; onDown?: () => void; onRemove?: () => void; removeLabel: string; testId?: string }) {
  const { t } = useI18n();
  const { editable } = useEd();
  return (
    <div className="item-h">
      <span className="idx">{n}</span>
      <b className="grow">{title}</b>
      {editable && onUp && <Btn size="xs" kind="ghost" icon="up" aria={t("ct.itemUp", { n })} onClick={onUp} />}
      {editable && onDown && <Btn size="xs" kind="ghost" icon="down" aria={t("ct.itemDown", { n })} onClick={onDown} />}
      {editable && onRemove && <Btn size="xs" kind="ghost" icon="x" aria={removeLabel} onClick={onRemove} testId={testId} />}
    </div>
  );
}

/** list helpers */
export const moveIn = <T,>(xs: readonly T[], i: number, d: number): T[] => {
  const j = i + d;
  if (j < 0 || j >= xs.length) return [...xs];
  const out = [...xs];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
};
export const setAt = <T,>(xs: readonly T[], i: number, v: T): T[] => xs.map((x, j) => (j === i ? v : x));
export const removeAt = <T,>(xs: readonly T[], i: number): T[] => xs.filter((_, j) => j !== i);
