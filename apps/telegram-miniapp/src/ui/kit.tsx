import { useEffect, useRef, type ReactNode } from "react";
import { haptic } from "../tg";
import { Icon, type IconName } from "./Icon";

export function Wordmark({ large }: { large?: boolean }) {
  return (
    <span className={large ? "wordmark lg" : "wordmark"} aria-label="TilHero">
      Ai<b>Event</b>
    </span>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={small ? "spin sm" : "spin"} aria-hidden="true" />;
}

export function Chip(props: {
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
  role?: "radio";
  id?: string;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const { pressed, onToggle, children, disabled, title, role, id, className, testId, ariaLabel } = props;
  return (
    <button
      id={id}
      aria-label={ariaLabel}
      className={className ? `chip ${className}` : "chip"}
      data-testid={testId}
      type="button"
      aria-pressed={role ? undefined : pressed}
      aria-checked={role ? pressed : undefined}
      role={role}
      disabled={disabled}
      title={title}
      onClick={() => {
        haptic.selection();
        onToggle();
      }}
    >
      {children}
    </button>
  );
}

export function Seg<T extends string | number>(props: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div className={props.className ? `seg ${props.className}` : "seg"} role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={props.value === o.value}
          onClick={() => {
            if (props.value === o.value) return;
            haptic.selection();
            props.onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch(props: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; busy?: boolean; id?: string }) {
  return (
    <button
      id={props.id}
      className="sw"
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      aria-busy={props.busy || undefined}
      disabled={props.disabled}
      onClick={() => {
        if (props.busy) return;
        haptic.selection();
        props.onChange(!props.on);
      }}
    />
  );
}

export function ToggleRow(props: {
  title: string;
  sub?: string | null;
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
  id?: string;
}) {
  return (
    <div className="trow">
      {props.icon && (
        <span className="lrow-i">
          <Icon name={props.icon} size={18} />
        </span>
      )}
      <div className="trow-t">
        <b>{props.title}</b>
        {props.sub && <small>{props.sub}</small>}
      </div>
      <Switch id={props.id} on={props.on} onChange={props.onChange} label={props.title} disabled={props.disabled} busy={props.busy} />
    </div>
  );
}

export function Note(props: { tone?: "lime" | "warn" | "bad"; icon: IconName; children: ReactNode; action?: { label: string; onClick: () => void; disabled?: boolean }; className?: string }) {
  const cls = ["note", props.tone, props.className].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <Icon name={props.icon} size={16} />
      <span>{props.children}</span>
      {props.action && (
        <button className="lnk" type="button" onClick={props.action.onClick} disabled={props.action.disabled}>
          {props.action.label}
        </button>
      )}
    </div>
  );
}

export function Badge({ tone, children, live }: { tone?: "good" | "info" | "warn" | "bad" | "lime"; children: ReactNode; live?: boolean }) {
  return <span className={["badge", tone ? `b-${tone}` : "", live ? "live" : ""].filter(Boolean).join(" ")}>{children}</span>;
}

export function Flap({ tone, children, className }: { tone?: "good" | "bad" | "warn" | "lime" | "info"; children: ReactNode; className?: string }) {
  return <span className={["flap", tone, className].filter(Boolean).join(" ")}>{children}</span>;
}

export function GroupH({ children }: { children: ReactNode }) {
  return <h2 className="lbl group-h">{children}</h2>;
}

export function LRow(props: { icon: IconName; title: string; sub?: string | null; value?: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; testId?: string; wrap?: boolean }) {
  return (
    <button className={["lrow", props.danger && "danger", props.wrap && "wrap"].filter(Boolean).join(" ")} type="button" onClick={props.onClick} disabled={props.disabled} data-testid={props.testId}>
      <span className="lrow-i">
        <Icon name={props.icon} size={18} />
      </span>
      <span className="lrow-t">
        <b>{props.title}</b>
        {props.sub && <small>{props.sub}</small>}
      </span>
      <span className="lrow-v">
        {props.value}
        <Icon name="chevR" size={16} />
      </span>
    </button>
  );
}

export function Empty(props: { icon: IconName; title: string; text: string; children?: ReactNode; soon?: string }) {
  return (
    <div className="empty">
      <div className="empty-art">
        <Icon name={props.icon} size={46} />
      </div>
      <h3>{props.title}</h3>
      <p>{props.text}</p>
      {props.children && <div className="btns">{props.children}</div>}
      {props.soon && (
        <p className="empty-soon">
          <Icon name="clock" size={16} />
          <span>{props.soon}</span>
        </p>
      )}
    </div>
  );
}

export function PinDots({ filled, total, error }: { filled: number; total: number; error?: boolean }) {
  return (
    <div className={["pdots", total > 4 ? "six" : "", error ? "shake err" : ""].filter(Boolean).join(" ")} aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < filled ? "on" : undefined} />
      ))}
    </div>
  );
}

export function Keypad(props: {
  onDigit: (d: string) => void;
  onErase: () => void;
  disabled?: boolean;
  bio?: { label: string; onClick: () => void } | null;
  eraseLabel: string;
}) {
  const press = (d: string) => {
    haptic.impact("light");
    props.onDigit(d);
  };
  return (
    <div className="kp" role="group">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
        <button key={d} type="button" disabled={props.disabled} onClick={() => press(d)} aria-label={d}>
          {d}
        </button>
      ))}
      {props.bio ? (
        <button type="button" className="fn" disabled={props.disabled} onClick={props.bio.onClick} aria-label={props.bio.label}>
          <Icon name="face" size={28} />
        </button>
      ) : (
        <span />
      )}
      <button type="button" disabled={props.disabled} onClick={() => press("0")} aria-label="0">
        0
      </button>
      <button type="button" className="fn" disabled={props.disabled} onClick={props.onErase} aria-label={props.eraseLabel}>
        <Icon name="bksp" size={26} />
      </button>
    </div>
  );
}

export function CheckRow(props: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; id?: string }) {
  return (
    <button
      id={props.id}
      className="chk"
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      onClick={() => {
        haptic.selection();
        props.onChange(!props.checked);
      }}
    >
      <span className="chk-box">
        <Icon name="check" size={15} />
      </span>
      <span className="chk-t">{props.children}</span>
    </button>
  );
}

/** Physical keyboard support for the PIN keypad (desktop Telegram, accessibility). */
export function useKeypadKeys(onDigit: (d: string) => void, onErase: () => void, enabled = true): void {
  const ref = useRef({ onDigit, onErase });
  ref.current = { onDigit, onErase };
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        ref.current.onDigit(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        ref.current.onErase();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
