import type { WebLoginError } from "@tilhero/contracts/web";
import { startLogin } from "../api";
import { useI18n } from "../i18n";
import { Notice } from "../ui";

export type LoginReason = WebLoginError | "session";

/** Вход: «Войти через Telegram» — навигация на /api/auth/start (OIDC перенаправлениями, без скриптов Telegram). */
export function LoginPage({ reason }: { reason: LoginReason | null }) {
  const { t } = useI18n();
  return (
    <main className="page page--narrow" id="main">
      <section className="card hero">
        <h1 className="hero__title">{t("login.title")}</h1>
        <p className="hero__lead">{t("login.lead")}</p>
        {reason && (
          <Notice tone={reason === "session" ? "info" : "error"} role="alert">
            {t(reason === "session" ? "login.error.session" : `login.error.${reason}`)}
          </Notice>
        )}
        <button type="button" className="btn btn--primary btn--wide btn--tg" onClick={startLogin}>
          <svg className="tg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M21.4 4.1 2.9 11.2c-1.3.5-1.2 1.3-.2 1.6l4.7 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.4l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8l3.1-14.6c.3-1.3-.5-1.9-1.4-1.6Zm-3.2 3.3-8.8 8-.3 3.6-1.6-5 10.2-6.4c.5-.3.9 0 .5.4Z" />
          </svg>
          {t("login.button")}
        </button>
        <p className="muted small">{t("login.note")}</p>
      </section>
    </main>
  );
}
