import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/* Notebook components (prototype Main.dc.html). Every control has a visible label, a focus ring (ui-tokens) and a
 * tap target ≥ 44 px; a choice is never shown by colour alone (aria-pressed + a check mark). */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; variant?: "primary" | "secondary" | "danger" | "dangerOutline" | "link" };

export function Btn({ busy, variant = "primary", className, children, disabled, type = "button", ...rest }: BtnProps) {
  const cls = variant === "primary" ? "btn" : variant === "danger" ? "btn danger" : variant === "secondary" ? "btn2" : variant === "dangerOutline" ? "btn2 danger" : "lnk";
  return (
    <button type={type} className={cx(cls, className)} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/** Single choice card (opt). */
export function Opt(props: { on: boolean; title: string; note?: string; onClick: () => void; disabled?: boolean; aside?: ReactNode; testId?: string }) {
  return (
    <button type="button" className={cx("opt", props.on && "on")} aria-pressed={props.on} onClick={props.onClick} disabled={props.disabled} data-testid={props.testId}>
      <span className="t">
        <b>{props.title}</b>
        {props.note ? <span>{props.note}</span> : null}
      </span>
      {props.aside}
      <span className="mark" aria-hidden="true">{props.on ? <Icon name="check" size={14} stroke={3} /> : null}</span>
    </button>
  );
}

export function Chip(props: { on: boolean; label: string; onClick: () => void; disabled?: boolean; ariaLabel?: string }) {
  return (
    <button type="button" className={cx("chip", props.on && "on")} aria-pressed={props.on} onClick={props.onClick} disabled={props.disabled} aria-label={props.ariaLabel}>
      {props.on ? <Icon name="check" size={14} stroke={3} /> : null}
      {props.label}
    </button>
  );
}

export interface SegOption<T extends string | number> {
  value: T;
  label: ReactNode;
  aria?: string;
}

/** Segmented control: a group of toggle buttons, exactly one pressed. */
export function Seg<T extends string | number>(props: { label: string; value: T; options: ReadonlyArray<SegOption<T>>; onChange: (v: T) => void; labelledBy?: string; tall?: boolean; testId?: string }) {
  return (
    <div className={cx("seg", props.tall && "tall")} role="group" data-testid={props.testId} aria-label={props.labelledBy ? undefined : props.label} aria-labelledby={props.labelledBy}>
      {props.options.map((o) => (
        <button key={String(o.value)} type="button" className={cx("sg", o.value === props.value && "on")} aria-pressed={o.value === props.value} aria-label={o.aria} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Pill({ tone, children }: { tone?: "ok" | "err" | "warn" | "mute"; children: ReactNode }) {
  return <span className={cx("pill", tone)}>{children}</span>;
}

/** Checkbox with its label (label.chk). */
export function Check(props: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean; note?: ReactNode; testId?: string; id?: string }) {
  return (
    <label className={cx("chk", props.disabled && "dis")}>
      <input id={props.id} type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} data-testid={props.testId} />
      <span>
        {props.children}
        {props.note ? <span className="note">{props.note}</span> : null}
      </span>
    </label>
  );
}

/** List row with a checkbox on the right (settings). */
export function ToggleRow(props: { title: string; note?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; testId?: string }) {
  return (
    <label className="row">
      <span className="t">
        <b>{props.title}</b>
        {props.note ? <span>{props.note}</span> : null}
      </span>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} data-testid={props.testId} />
    </label>
  );
}

/** Navigation row (list): title, optional value, chevron. */
export function NavRow(props: { title: string; note?: string; value?: string; onClick: () => void; icon?: IconName; testId?: string; badge?: ReactNode }) {
  return (
    <button type="button" className="row" onClick={props.onClick} data-testid={props.testId}>
      {props.icon ? <span className="nic"><Icon name={props.icon} size={20} /></span> : null}
      <span className="t">
        <b>{props.title}</b>
        {props.note ? <span>{props.note}</span> : null}
      </span>
      {props.badge}
      {props.value ? <span className="v">{props.value}</span> : null}
      <Icon name="chevron" size={18} stroke={2} />
    </button>
  );
}

export function Field(props: { label: string; error?: string | null; hint?: string; children: (id: string, describedBy: string | undefined) => ReactNode }) {
  const id = useId();
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  const describedBy = [props.error ? errId : null, props.hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label className="lb" htmlFor={id}>{props.label}</label>
      {props.children(id, describedBy)}
      {props.hint ? <p id={hintId} className="sub small field-hint">{props.hint}</p> : null}
      {props.error ? (
        <p id={errId} className="field-err" role="alert">
          <Icon name="alert" size={16} />
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const { invalid, className, ...rest } = props;
  return <input className={cx("inp", className)} aria-invalid={invalid || undefined} {...rest} />;
}

/** Margin of the notebook with an optional handwritten note (Caveat) on the left. */
export function Margin(props: { note?: string; tone?: "b" | "g" | "r"; tilt?: boolean; children: ReactNode; noteLabel?: string }) {
  return (
    <div className="mg">
      {props.note ? (
        <div className={cx("mn", props.tone === "b" && "b", props.tone === "g" && "g", props.tilt && "tilt", props.note.length > 4 && "s")} aria-hidden={props.noteLabel ? undefined : true}>
          {props.note}
        </div>
      ) : null}
      {props.children}
    </div>
  );
}

export function Steps({ n, m, label }: { n: number; m: number; label: string }) {
  return (
    <div className="steps" role="progressbar" aria-label={label} aria-valuemin={1} aria-valuemax={m} aria-valuenow={n}>
      {Array.from({ length: m }, (_, i) => (
        <div key={i} className={cx("stp", i < n - 1 && "done", i === n - 1 && "on")} />
      ))}
    </div>
  );
}

export function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="field-err" role="alert">
      <Icon name="alert" size={16} />
      {text}
    </p>
  );
}

export function Skeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="stack" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}

/** Hero art from /heroes (prototype heroes: robots, dragons, students). */
export const HERO = {
  volt: "/heroes/robot_0_1.webp",
  voltUp: "/heroes/robot_0_2.webp",
  nilu: "/heroes/human_0_2.webp",
  myatik: "/heroes/pet_0_3.webp",
  myatikEgg: "/heroes/pet_0_1.webp",
  iskra: "/heroes/robot_1_2.webp",
} as const;

export function Hero({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return <img className={cx("hero", className)} src={src} alt={alt} draggable={false} decoding="async" />;
}
