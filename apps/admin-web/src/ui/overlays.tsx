import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { Icon, type IconName } from "./Icon";
import { Btn, cx, FieldErr, IconBtn } from "./kit";
import { COMMAND_SCOPE, RateScope } from "../lib/rateLimit";
import { RateWaitNotice } from "./RateWait";

const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Keeps Tab inside `ref`, closes on Escape, restores focus to the opener on unmount. */
function useDialogFocus(ref: React.RefObject<HTMLElement | null>, onEscape: () => void, active = true) {
  const esc = useRef(onEscape);
  esc.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = ref.current;
      if (!el || el.contains(document.activeElement)) return;
      (el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    }, 20);
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      // only the top-most dialog reacts
      const all = document.querySelectorAll("[data-dialog]");
      if (all[all.length - 1] !== el) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        esc.current();
        return;
      }
      if (e.key !== "Tab") return;
      const f = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [ref, active]);
}

export interface DrawerProps {
  title: ReactNode;
  sub?: ReactNode;
  tabs?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}

/** Right-side panel 520px (720 wide), full screen on phones. */
export function Drawer({ title, sub, tabs, footer, wide, onClose, children, testId }: DrawerProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, onClose);
  return createPortal(
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside ref={ref} className={cx("drawer", wide && "wide")} role="dialog" aria-modal="true" aria-labelledby="drawer-title" data-dialog="" data-testid={testId}>
        <div className="drawer-h">
          <div className="grow">
            <h2 className="drawer-title" id="drawer-title">
              {title}
            </h2>
            {sub && <div className="drawer-sub">{sub}</div>}
          </div>
          <IconBtn icon="x" label={t("common.close")} onClick={onClose} testId="drawer-close" />
        </div>
        {tabs}
        <div className="drawer-b">{children}</div>
        {footer && <div className="drawer-f">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}

export interface ModalProps {
  title: ReactNode;
  text?: ReactNode;
  icon?: IconName;
  tone?: "" | "warn" | "bad";
  children?: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  testId?: string;
}

/** In-page confirmation dialog — the app never uses window.confirm()/prompt(). */
export function Modal({ title, text, icon = "alert", tone = "", children, footer, onClose, testId }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby={text ? "modal-text" : undefined} data-dialog="" data-testid={testId}>
        <div className="modal-h">
          <div className={cx("modal-ico", tone)}>
            <Icon name={icon} />
          </div>
          <div>
            <h2 className="modal-title" id="modal-title">
              {title}
            </h2>
            {text && (
              <p className="modal-text" id="modal-text">
                {text}
              </p>
            )}
          </div>
        </div>
        <RateScope.Provider value={COMMAND_SCOPE}>
          {children && <div className="modal-b">{children}</div>}
          <div className="modal-f">
            <RateWaitNotice scope={COMMAND_SCOPE} testId="modal-rate-wait" />
            {footer}
          </div>
        </RateScope.Provider>
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmProps {
  title: ReactNode;
  text?: ReactNode;
  icon?: IconName;
  tone?: "" | "warn" | "bad";
  ok: string;
  okKind?: "primary" | "danger";
  /** reason (≥ 5 chars) is required by every privileged command; label/placeholder can be customised */
  reasonLabel?: string;
  reasonPlaceholder?: string;
  minReason?: number;
  /** upper bound of the reason (the textarea shows a counter and refuses longer text with an error) */
  maxReason?: number;
  extra?: ReactNode;
  /** the confirm button is inactive while `extra` holds an invalid choice (its own error is shown at the field) */
  okDisabled?: boolean;
  onConfirm: (reason: string) => Promise<void | string | null>;
  onClose: () => void;
  testId?: string;
}

/**
 * Standard command confirmation: a reason field + inline error. `onConfirm` returns an error text to keep the
 * dialog open (e.g. the backend refused), or nothing to close it.
 */
export function ConfirmCommand(p: ConfirmProps) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const min = p.minReason ?? 5;
  const max = p.maxReason;
  const over = max != null && reason.trim().length > max;
  const submit = async () => {
    if (busy || p.okDisabled) return;
    if (reason.trim().length < min) {
      setErr(t("cmd.errReason", { n: min }));
      return;
    }
    if (max != null && reason.trim().length > max) {
      setErr(t("cmd.errReasonMax", { n: max }));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await p.onConfirm(reason.trim());
      if (typeof res === "string" && res) {
        setErr(res);
        setBusy(false);
        return;
      }
      p.onClose();
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : t("err.generic"));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={p.title}
      text={p.text}
      icon={p.icon ?? "alert"}
      tone={p.tone ?? "warn"}
      onClose={() => !busy && p.onClose()}
      testId={p.testId ?? "confirm"}
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={p.onClose} disabled={busy} />
          <Btn label={p.ok} kind={p.okKind ?? "primary"} onClick={submit} busy={busy} disabled={p.okDisabled} testId="confirm-ok" />
        </>
      }
    >
      {p.extra}
      <div className="field">
        <div className="field-top">
          <label htmlFor="cmd-reason" className="req">
            {p.reasonLabel ?? t("cmd.reason")}
          </label>
          {max != null && (
            <span className={cx("counter", over && "is-over")} data-testid="cmd-reason-count">
              {reason.trim().length}/{max}
            </span>
          )}
        </div>
        <textarea
          id="cmd-reason"
          className={cx("textarea", ((err && reason.trim().length < min) || over) && "is-invalid")}
          rows={3}
          data-autofocus=""
          placeholder={p.reasonPlaceholder ?? t("cmd.reasonPh")}
          value={reason}
          maxLength={max != null ? max * 2 : 500}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <FieldErr msg={err} />
      <p className="xs muted row">
        <Icon name="audit" /> {t("cmd.auditNote")}
      </p>
    </Modal>
  );
}

/** Popover menu anchored to a trigger; closes on outside click, Escape (focus back to the trigger) and resize. */
export function MenuPopover({ anchor, onClose, children, label, alignLeft, className, testId }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; label: string; alignLeft?: boolean; className?: string; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const b = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    let left = alignLeft ? b.left : b.right - r.width;
    left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
    let top = b.bottom + 6;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, b.top - r.height - 6);
    setPos({ left, top });
  }, [anchor, alignLeft]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const tg = e.target as Node;
      if (ref.current?.contains(tg) || anchor?.contains(tg)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchor?.focus();
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || !ref.current?.contains(document.activeElement)) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
      if (!items.length) return;
      let i = items.indexOf(document.activeElement as HTMLElement);
      i = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      e.preventDefault();
      items[i]!.focus();
    };
    const onResize = () => onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    const f = setTimeout(() => ref.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus(), 0);
    return () => {
      clearTimeout(f);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className={cx("menu", className)} role="menu" aria-label={label} style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }} data-testid={testId}>
      {children}
    </div>,
    document.body,
  );
}

/** Trigger + popover pair. `render(close)` builds the menu content. */
export function MenuButton({ label, render, className, children, alignLeft, testId, menuClass, title }: { label: string; render: (close: () => void) => ReactNode; className?: string; children: ReactNode; alignLeft?: boolean; testId?: string; menuClass?: string; title?: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => setAnchor(null);
  return (
    <>
      <button ref={btn} type="button" className={className} aria-haspopup="menu" aria-expanded={!!anchor} aria-label={label} title={title ?? label} onClick={() => setAnchor(anchor ? null : btn.current)} data-testid={testId}>
        {children}
      </button>
      {anchor && (
        <MenuPopover anchor={anchor} onClose={close} label={label} alignLeft={alignLeft} className={menuClass} testId={testId ? `${testId}-menu` : undefined}>
          {render(close)}
        </MenuPopover>
      )}
    </>
  );
}

export function MenuItem({ icon, children, onClick, danger, checked, disabled, sub, testId }: { icon?: IconName; children: ReactNode; onClick: () => void; danger?: boolean; checked?: boolean; disabled?: boolean; sub?: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      className={cx("menu-item", danger && "danger")}
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      {icon && <Icon name={icon} />}
      <span className="grow">
        {children}
        {sub && <span className="xs muted block">{sub}</span>}
      </span>
      {checked !== undefined && <Icon name="check" className="check-ico" />}
    </button>
  );
}
