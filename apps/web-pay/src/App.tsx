/**
 * Корень сайта оплаты: язык, сессия (GET /api/me → CSRF-токен; 401 → вход), маршруты. Параметры адреса
 * (login_error после входа, параметры провайдера после оплаты) читаются один раз и убираются из адреса.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WebLoginError, WebMe } from "@tilhero/contracts/web";
import { ApiError, api, setCsrf, setSessionExpiredHandler } from "./api";
import { I18nContext, initialLang, translate, type I18n, type Lang } from "./i18n";
import { BuyPage } from "./pages/Buy";
import { HomePage } from "./pages/Home";
import { LoginPage, type LoginReason } from "./pages/Login";
import { OrderPage } from "./pages/Order";
import { OrdersPage } from "./pages/Orders";
import { cleanAddress, navigate, useRoute } from "./router";
import { ErrorBox, Header, Link, Loading, Notice } from "./ui";

const LOGIN_ERRORS: readonly WebLoginError[] = ["auth_failed", "account_not_found", "not_allowed"];

/** Код ошибки входа из адреса (только известные значения). */
export function loginErrorFromUrl(search: string): WebLoginError | null {
  const v = new URLSearchParams(search).get("login_error");
  return v !== null && (LOGIN_ERRORS as readonly string[]).includes(v) ? (v as WebLoginError) : null;
}

type SessionState =
  | { kind: "loading" }
  | { kind: "anon"; reason: LoginReason | null }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; me: WebMe };

export function App() {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const i18n = useMemo<I18n>(
    () => ({
      lang,
      t: (key, params) => translate(lang, key, params),
      setLang: (l) => {
        try {
          localStorage.setItem("wp_lang", l);
        } catch {
          /* приватный режим */
        }
        setLangState(l);
      },
    }),
    [lang],
  );
  useEffect(() => {
    document.documentElement.lang = lang === "uz" ? "uz-Latn" : "ru";
    document.title = `TilHero — ${translate(lang, "brand.sub")}`;
  }, [lang]);

  // ошибка входа из адреса — один раз; адрес очищается сразу (в адресе не остаётся параметров)
  const [initialError] = useState<WebLoginError | null>(() => loginErrorFromUrl(window.location.search));
  useEffect(() => cleanAddress(), []);

  const [session, setSession] = useState<SessionState>({ kind: "loading" });
  const loadMe = useCallback(async () => {
    setSession({ kind: "loading" });
    try {
      const me = await api.me();
      setCsrf(me.csrf_token);
      setSession({ kind: "ready", me });
    } catch (e) {
      setCsrf(null);
      if (e instanceof ApiError && e.status === 401) setSession({ kind: "anon", reason: initialError });
      else setSession({ kind: "error", error: e });
    }
  }, [initialError]);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      setCsrf(null);
      setSession((s) => (s.kind === "ready" ? { kind: "anon", reason: "session" } : s));
    });
    void loadMe();
    return () => setSessionExpiredHandler(null);
  }, [loadMe]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* сессия уже недействительна — всё равно на вход */
    }
    setCsrf(null);
    setSession({ kind: "anon", reason: null });
    navigate("/");
  }, []);

  const route = useRoute();

  let body: JSX.Element;
  if (session.kind === "loading") {
    body = (
      <main className="page page--narrow" id="main">
        <Loading />
      </main>
    );
  } else if (session.kind === "anon") {
    body = <LoginPage reason={session.reason} />;
  } else if (session.kind === "error") {
    body = (
      <main className="page page--narrow" id="main">
        <ErrorBox error={session.error} onRetry={() => void loadMe()} />
      </main>
    );
  } else {
    const me = session.me;
    switch (route.name) {
      case "home":
        body = <HomePage me={me} />;
        break;
      case "buy":
        body = <BuyPage key={route.code} me={me} code={route.code} />;
        break;
      case "orders":
        body = <OrdersPage />;
        break;
      case "order":
        body = <OrderPage key={route.orderNo} orderNo={route.orderNo} />;
        break;
      default:
        body = (
          <main className="page page--narrow" id="main">
            <Notice>
              <Link to="/">{translate(lang, "nav.plans")}</Link>
            </Notice>
          </main>
        );
    }
  }

  const current = route.name === "orders" || route.name === "order" ? "orders" : "plans";
  return (
    <I18nContext.Provider value={i18n}>
      <Header current={current} {...(session.kind === "ready" ? { onLogout: () => void logout() } : {})} />
      {body}
      <footer className="footer">
        <span>© TilHero</span>
      </footer>
    </I18nContext.Provider>
  );
}
