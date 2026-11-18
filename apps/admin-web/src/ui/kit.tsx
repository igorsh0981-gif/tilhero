import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Permission } from "@tilhero/contracts/admin";
import { useI18n } from "../i18n";
import { useSession } from "../state/session";
import { useToast } from "./toasts";
import { Icon, type IconName } from "./Icon";
import { useRateScope, useRateWait } from "../lib/rateLimit";

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

export interface BtnProps {
  label?: ReactNode;
  icon?: IconName;
  kind?: "primary" | "accent" | "danger" | "danger-ghost" | "ghost" | "";
  size?: "sm" | "xs" | "lg" | "";
  block?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** UX only: without the permission the button is shown locked (backend re-checks every command) */
  perm?: Permission | Permission[];
  title?: string;
  aria?: string;
  type?: "button" | "submit";
  /** id of the form a submit button outside it belongs to (drawer footer) */
  form?: string;
  id?: string;
  className?: string;
  testId?: string;
}

export function Btn(p: BtnProps) {
  const { can } = useSession();
  const { t } = useI18n();
  const toast = useToast();
  const perms = p.perm ? (Array.isArray(p.perm) ? p.perm : [p.perm]) : [];
  // sprint 9 review: inside a rate scope (command dialog, sign-in) the primary action waits out a 429
  const scope = useRateScope();
  const waitLeft = useRateWait(scope && (p.kind === "primary" || p.kind === "danger") ? scope : null);
  const locked = perms.length > 0 && !perms.some((x) => can(x));
  const cls = cx("btn", p.kind, p.size, p.block && "block", p.busy && "is-busy", locked && "is-locked", p.className);
  if (locked) {
    const need = t("perm.need", { p: perms.join(" / ") });
    return (
      <button type="button" className={cls} aria-disabled="true" title={need} data-testid={p.testId} id={p.id} onClick={() => toast(need, "err", "403 PERMISSION_DENIED")}>
        <Icon name="lock" />
        {p.label != null && <span>{p.label}</span>}
      </button>
    );
  }
  return (
    <button
      type={p.type ?? "button"}
      form={p.form}
      className={cls}
      onClick={p.onClick}
      disabled={p.disabled || p.busy || waitLeft > 0}
      title={waitLeft > 0 ? t("err.RATE_LIMITED.wait", { n: waitLeft }) : p.title}
      aria-label={p.aria}
      id={p.id}
      data-testid={p.testId}
    >
      {p.busy ? <span className="spinner" aria-hidden="true" /> : p.icon && <Icon name={p.icon} />}
      {p.label != null && <span>{p.label}</span>}
    </button>
  );
}

export function IconBtn({ icon, label, onClick, className, badge, expanded, testId }: { icon: IconName; label: string; onClick?: () => void; className?: string; badge?: number | null; expanded?: boolean; testId?: string }) {
  return (
    <button type="button" className={cx("icon-btn", className)} aria-label={label} title={label} onClick={onClick} aria-expanded={expanded} data-testid={testId}>
      <Icon name={icon} />
      {badge ? <span className="badge-dot">{badge}</span> : null}
    </button>
  );
}

export type Tone = "good" | "warn" | "bad" | "info" | "neutral" | "accent" | "outline";
export function Pill({ tone = "neutral", children, dot = true, mono, title, testId }: { tone?: Tone; children: ReactNode; dot?: boolean; mono?: boolean; title?: string; testId?: string }) {
  return (
    <span className={cx("pill", tone !== "neutral" && tone, !dot && "no-dot", mono && "mono")} title={title} data-testid={testId}>
      {children}
    </span>
  );
}

export function Seg<T extends string>({ label, value, items, onChange, testId }: { label: string; value: T; items: Array<{ v: T; label: ReactNode; cnt?: number | null }>; onChange: (v: T) => void; testId?: string }) {
  return (
    <div className="seg" role="group" aria-label={label} data-testid={testId}>
      {items.map((it) => (
        <button key={it.v} type="button" aria-pressed={value === it.v} onClick={() => onChange(it.v)}>
          {it.label}
          {it.cnt != null && <span className="cnt">{it.cnt}</span>}
        </button>
      ))}
    </div>
  );
}

/** WAI-ARIA tabs with roving tabindex and ←/→/Home/End. */
export function Tabs<T extends string>({ id, label, value, items, onChange, className }: { id: string; label: string; value: T; items: Array<{ v: T; label: ReactNode; icon?: IconName; cnt?: number | null; bad?: boolean; testId?: string }>; onChange: (v: T) => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    const i = items.findIndex((x) => x.v === value);
    let j = -1;
    if (e.key === "ArrowRight") j = (i + 1) % items.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = items.length - 1;
    if (j < 0) return;
    e.preventDefault();
    onChange(items[j]!.v);
    setTimeout(() => ref.current?.querySelector<HTMLButtonElement>(`#tab-${id}-${items[j]!.v}`)?.focus(), 0);
  };
  // narrow screens: the tab row scrolls — the hidden side fades out (data-more), the selected tab is scrolled into view
  const [more, setMore] = useState<"" | "left" | "right" | "both">("");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const l = el.scrollLeft > 2;
      const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setMore(l && r ? "both" : l ? "left" : r ? "right" : "");
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [items.length]);
  useEffect(() => {
    const el = ref.current;
    const tab = el?.querySelector<HTMLElement>(`#tab-${id}-${value}`);
    if (!el || !tab || el.scrollWidth <= el.clientWidth) return;
    const left = tab.offsetLeft - el.offsetLeft;
    if (left < el.scrollLeft || left + tab.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollTo({ left: Math.max(0, left - 24) });
  }, [id, value]);
  return (
    <div className={cx("tabs", className)} role="tablist" aria-label={label} ref={ref} onKeyDown={onKey} data-more={more || undefined}>
      {items.map((it) => {
        const sel = it.v === value;
        return (
          <button key={it.v} type="button" role="tab" className="tab" id={`tab-${id}-${it.v}`} aria-selected={sel} aria-controls={`tp-${id}`} tabIndex={sel ? 0 : -1} onClick={() => onChange(it.v)} data-testid={it.testId}>
            {it.icon && <Icon name={it.icon} />}
            {it.label}
            {it.cnt != null && <span className={cx("cnt", it.bad && "is-bad")}>{it.cnt}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, value, children }: { id: string; value: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`tp-${id}`} aria-labelledby={`tab-${id}-${value}`}>
      {children}
    </div>
  );
}

export function Select<T extends string>({ id, label, value, options, onChange, disabled, className, testId }: { id: string; label: string; value: T; options: Array<{ v: T; label: string; disabled?: boolean }>; onChange: (v: T) => void; disabled?: boolean; className?: string; testId?: string }) {
  return (
    <select id={id} className={cx("select", className)} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} data-testid={testId}>
      {options.map((o) => (
        <option key={o.v} value={o.v} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Switch({ id, checked, onChange, label, aria, disabled }: { id: string; checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; aria?: string; disabled?: boolean }) {
  return (
    <label className="switch" htmlFor={id}>
      <input type="checkbox" id={id} checked={checked} disabled={disabled} aria-label={aria} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden="true" />
      {label != null && <span>{label}</span>}
    </label>
  );
}

export function Callout({ kind = "", icon = "info", children, testId }: { kind?: "" | "info" | "warn" | "bad" | "good"; icon?: IconName; children: ReactNode; testId?: string }) {
  return (
    <div className={cx("callout", kind)} data-testid={testId}>
      <Icon name={icon} />
      <div className="grow">{children}</div>
    </div>
  );
}

export function Empty({ icon = "inbox", title, text, children, className, testId }: { icon?: IconName; title: ReactNode; text?: ReactNode; children?: ReactNode; className?: string; testId?: string }) {
  return (
    <div className={cx("empty", className)} data-testid={testId}>
      <div className="e-ico">
        <Icon name={icon} />
      </div>
      <div className="e-t">{title}</div>
      {text && <div className="e-m">{text}</div>}
      {children}
    </div>
  );
}

export function Locked({ title, text, children, testId }: { title: ReactNode; text: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="locked-block" data-testid={testId}>
      <Icon name="lock" />
      <div className="grow">
        <div className="t">{title}</div>
        <div className="m">{text}</div>
        {children}
      </div>
    </div>
  );
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function CopyBtn({ value, label, text, testId }: { value: string; label: string; text?: string; testId?: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(id);
  }, [done]);
  const onClick = async () => {
    const ok = await copyText(value);
    setDone(ok);
    toast(ok ? t("common.copied") : t("common.copyFailed"), ok ? "ok" : "err", label);
  };
  if (text)
    return (
      <button type="button" className="btn sm" onClick={onClick} aria-label={`${t("common.copy")} ${label}`} data-testid={testId}>
        <Icon name={done ? "check" : "copy"} />
        <span>{text}</span>
      </button>
    );
  return (
    <button type="button" className="btn ghost xs" onClick={onClick} aria-label={`${t("common.copy")} ${label}`} title={t("common.copy")} data-testid={testId}>
      <Icon name={done ? "check" : "copy"} />
    </button>
  );
}

export function FieldErr({ msg, id }: { msg?: string | null; id?: string }) {
  if (!msg) return null;
  return (
    <span className="err" role="alert" id={id}>
      <Icon name="alertCircle" />
      {msg}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row muted small" role="status" style={{ padding: 16 }}>
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

/** Pretty JSON with syntax colouring; secrets are redacted by the caller. Built from React nodes (no HTML strings). */
export function JsonView({ value, className, testId }: { value: unknown; className?: string; testId?: string }) {
  const text = JSON.stringify(value, null, 2) ?? "null";
  const parts: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) {
      if (m[2]) {
        parts.push(<span key={k++} className="k">{m[1]}</span>);
        parts.push(<span key={k++} className="p">{m[2]}</span>);
      } else parts.push(<span key={k++} className="s">{m[1]}</span>);
    } else if (m[3]) parts.push(<span key={k++} className="bl">{m[3]}</span>);
    else if (m[4]) parts.push(<span key={k++} className="n">{m[4]}</span>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <pre className={cx("code", className)} data-testid={testId}>
      {parts}
    </pre>
  );
}

/**
 * Brings a notice into view when it appears (or when `dep` changes): a conflict banner at the top of a drawer the
 * operator has scrolled down must not stay unseen. Announced to screen readers as a status.
 */
export function Reveal({ children, dep }: { children: ReactNode; dep?: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "start" });
  }, [dep]);
  return (
    <div ref={ref} role="status" className="reveal">
      {children}
    </div>
  );
}
