import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { popupStore, useBackButton, useStoreTop } from "../tg";
import { Icon } from "./Icon";

/* ---------- focus trap ---------- */
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
}

function trap(e: KeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== "Tab" || !root) return;
  const f = focusables(root);
  if (!f.length) return;
  const first = f[0]!;
  const last = f[f.length - 1]!;
  if (!root.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Bottom sheet (prototype .sheet): modal dialog with a title, focus moved inside and returned to the opener, Escape
 * and the Telegram BackButton close it. `dismissable=false` — only the sheet's own buttons close it.
 */
export function Sheet(props: { title: string; cap?: string; onClose: () => void; children: ReactNode; dismissable?: boolean; testId?: string; hideTitle?: boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const opener = useRef<Element | null>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  const dismissable = props.dismissable !== false;
  useBackButton(dismissable ? () => onClose.current() : null);

  useEffect(() => {
    opener.current = document.activeElement;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) onClose.current();
      trap(e, ref.current);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const o = opener.current as HTMLElement | null;
      if (o && typeof o.focus === "function" && document.contains(o)) o.focus();
    };
  }, [dismissable]);

  return (
    <div className="sheet-wrap" onClick={(e) => dismissable && e.target === e.currentTarget && onClose.current()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref} data-testid={props.testId}>
        <div className="grab" aria-hidden="true" />
        <div className="sheet-head">
          {props.cap ? <div className="cap">{props.cap}</div> : null}
          <h2 className={props.hideTitle ? "sr" : "h2"} id={titleId}>{props.title}</h2>
          {dismissable ? (
            <button type="button" className="ib sheet-x" aria-label={t("c.close")} onClick={() => onClose.current()}>
              <Icon name="close" size={20} />
            </button>
          ) : null}
        </div>
        {props.children}
      </div>
    </div>
  );
}

/* ---------- toast ---------- */
type Listener = () => void;
let toastMsg: { id: number; text: string } | null = null;
const toastListeners = new Set<Listener>();
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 0;

export function showToast(text: string, ms = 2600): void {
  toastMsg = { id: ++toastSeq, text };
  toastListeners.forEach((l) => l());
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastMsg = null;
    toastListeners.forEach((l) => l());
  }, ms);
}

export function ToastHost() {
  const msg = useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => toastListeners.delete(l);
    },
    () => toastMsg,
    () => null,
  );
  return (
    <div aria-live="polite" role="status">
      {msg ? (
        <div className="toast" key={msg.id} data-testid="toast">
          {msg.text}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- in-app popup (outside Telegram / more than 3 buttons) ---------- */
export function PopupHost() {
  const req = useStoreTop(popupStore);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!req) return;
    const first = ref.current?.querySelector<HTMLElement>("button");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") req.resolve(null);
      trap(e, ref.current);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [req]);
  if (!req) return null;
  return (
    <div className="pop-layer">
      <div className="pop" role="alertdialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <h2 className="h3" id={titleId}>{req.title}</h2>
        <p className="sub">{req.message}</p>
        <div className="duo">
          {req.buttons.map((b) => (
            <button key={b.id} type="button" className={b.type === "destructive" ? "btn danger" : b.primary ? "btn" : "btn2"} onClick={() => req.resolve(b.id)}>
              {b.text}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
