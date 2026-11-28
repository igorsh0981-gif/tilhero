/**
 * Общие элементы сайта: шапка, уведомления, загрузка данных, ссылки внутри сайта.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { BillingOrderStatus } from "@tilhero/contracts/bff";
import { ApiError } from "./api";
import { errorText, useI18n } from "./i18n";
import { navigate } from "./router";

/** Ссылка внутри сайта (history API); с модификаторами — как обычная ссылка. */
export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={onClick}>
      {children}
    </a>
  );
}

export function Header({ onLogout, current }: { onLogout?: () => void; current?: "plans" | "orders" }) {
  const { t, lang, setLang } = useI18n();
  return (
    <header className="topbar">
      <div className="topbar__inner">
        <Link to="/" className="brand">
          <span className="brand__mark" aria-hidden="true">
            T
          </span>
          <span className="brand__name">TilHero</span>
          <span className="brand__sub">{t("brand.sub")}</span>
        </Link>
        <nav className="topbar__nav" aria-label="menu">
          {onLogout && (
            <>
              <Link to="/" className={`navlink${current === "plans" ? " navlink--on" : ""}`}>
                {t("nav.plans")}
              </Link>
              <Link to="/orders" className={`navlink${current === "orders" ? " navlink--on" : ""}`}>
                {t("nav.orders")}
              </Link>
            </>
          )}
          <button
            type="button"
            className="chip"
            lang={lang === "ru" ? "uz-Latn" : "ru"}
            aria-label={t("lang.switch")}
            onClick={() => setLang(lang === "ru" ? "uz" : "ru")}
          >
            <span className="chip__short">{t("lang.code")}</span>
            <span className="chip__long">{t("lang.switch")}</span>
          </button>
          {onLogout && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onLogout}>
              {t("nav.logout")}
            </button>
          )}
        </nav>
      </div>
    </header>
  );
}

export function Notice({ tone = "info", children, role }: { tone?: "info" | "warn" | "error" | "ok"; children: ReactNode; role?: "alert" | "status" }) {
  return (
    <div className={`notice notice--${tone}`} role={role ?? (tone === "error" ? "alert" : "status")}>
      {children}
    </div>
  );
}

export function Loading() {
  const { t } = useI18n();
  return (
    <p className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {t("common.loading")}
    </p>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const code = error instanceof ApiError ? error.code : "generic";
  return (
    <Notice tone="error">
      <span>{errorText(t, code)}</span>
      {onRetry && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
          {t("common.retry")}
        </button>
      )}
    </Notice>
  );
}

export function StatusChip({ status }: { status: BillingOrderStatus }) {
  const { t } = useI18n();
  return <span className={`status status--${status}`}>{t(`status.${status}`)}</span>;
}

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  set: (v: T) => void;
}

/** Загрузка данных страницы; 401 обрабатывает api (экран входа). */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    run().then(
      (v) => {
        if (n !== seq.current) return;
        setData(v);
        setLoading(false);
      },
      (e: unknown) => {
        if (n !== seq.current) return;
        setError(e);
        setLoading(false);
      },
    );
  }, [run]);
  useEffect(() => {
    reload();
    return () => {
      seq.current++;
    };
  }, [reload]);
  return { data, error, loading, reload, set: setData };
}
