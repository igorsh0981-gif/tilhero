import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Me, Permission } from "@tilhero/contracts/admin";
import { api } from "./api/client";
import { Auth, Experience } from "./api/endpoints";
import type { ApiError } from "./api/errors";
import { useI18n } from "./i18n";
import { activity } from "./state/activity";
import { SessionCtx, type AdminLayout, type Session, type SignOutReason } from "./state/session";
import { applyConfigTokens, clearConfigTokens, layoutFromPayload, tokensFromPayload } from "./theme/config";
import { applyThemeMode, isDark, type ThemeMode } from "./theme/mode";
import { prefs } from "./lib/storage";
import { singleFlight } from "./lib/singleFlight";
import { Login, type LoginNotice } from "./screens/auth/Login";
import { Shell } from "./shell/Shell";
import { StepUpDialog } from "./shell/StepUp";

interface UiPrefs {
  theme: ThemeMode;
  setTheme(m: ThemeMode): void;
}
const PrefsCtx = createContext<UiPrefs>({ theme: "system", setTheme: () => undefined });
export const useUiPrefs = () => useContext(PrefsCtx);

const NOTICE: Record<string, LoginNotice> = {
  idle: { kind: "info", key: "login.notice.idle" },
  expired: { kind: "info", key: "login.notice.expired" },
  SESSION_EXPIRED: { kind: "info", key: "login.notice.expired" },
  SESSION_REVOKED: { kind: "warn", key: "login.notice.revoked" },
  UNAUTHORIZED: { kind: "warn", key: "login.notice.unauthorized" },
  // sign-out the server did not confirm (review T2-10): the cookie is cleared, the session may live until the idle timeout
  SESSION_NOT_REVOKED: { kind: "warn", key: "login.notice.notRevoked" },
};

export function App() {
  const { t } = useI18n();
  const [phase, setPhase] = useState<"boot" | "login" | "app">("boot");
  const [me, setMeState] = useState<Me | null>(null);
  const [notice, setNotice] = useState<LoginNotice | null>(null);
  const [themeVersion, setThemeVersion] = useState<string | null>(null);
  const [adminLayout, setAdminLayout] = useState<AdminLayout | null>(null);
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const v = prefs.get<string>("theme", "system");
    return v === "light" || v === "dark" ? v : "system";
  });
  const [stepUp, setStepUp] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const meRef = useRef<Me | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const setMe = useCallback((m: Me) => {
    meRef.current = m;
    api.setCsrf(m.csrf_token);
    setMeState(m);
  }, []);

  const toLogin = useCallback((n: LoginNotice | null) => {
    meRef.current = null;
    api.setCsrf(null);
    clearConfigTokens();
    setThemeVersion(null);
    setAdminLayout(null);
    setStepUp((s) => {
      s?.resolve(false);
      return null;
    });
    setMeState(null);
    setNotice(n);
    setPhase("login");
  }, []);

  const reloadTheme = useCallback(async () => {
    // GET /experience/admin/current is open to every signed-in staff member (A46 for all roles): theme tokens and
    // layout of the active admin version; on failure the built-in default theme (= admin 1.0.0 seed) stays.
    if (!meRef.current) return;
    try {
      const cfg = await Experience.adminCurrent();
      applyConfigTokens(tokensFromPayload(cfg), isDark(themeRef.current));
      setThemeVersion(cfg.version);
      setAdminLayout(layoutFromPayload(cfg));
    } catch {
      /* the default theme stays; nothing to tell the user */
    }
  }, []);

  useEffect(() => {
    api.hooks = {
      onSessionLost: (err: ApiError) => {
        if (!meRef.current) return;
        toLogin(NOTICE[err.code] ?? NOTICE.UNAUTHORIZED!);
      },
      // one TOTP prompt for every command that needs step-up at the same time (no orphaned promises)
      onStepUp: singleFlight(() => new Promise<boolean>((resolve) => setStepUp({ resolve }))),
      onServerTouch: () => activity.serverTouch(),
      onMe: (m) => {
        if (meRef.current) setMe(m as Me);
      },
    };
  }, [toLogin, setMe]);

  // boot: an existing cookie session → shell, otherwise the sign-in screen (A30)
  useEffect(() => {
    let alive = true;
    Auth.me()
      .then((m) => {
        if (!alive) return;
        setMe(m);
        setPhase("app");
      })
      .catch(() => alive && setPhase("login"));
    return () => {
      alive = false;
    };
  }, [setMe]);

  useEffect(() => {
    if (phase === "app") void reloadTheme();
  }, [phase, reloadTheme]);

  // theme mode: data-theme + OS changes while in «system»
  useEffect(() => {
    applyThemeMode(theme);
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyThemeMode("system");
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [theme]);

  const setTheme = useCallback((m: ThemeMode) => {
    prefs.set("theme", m);
    setThemeState(m);
  }, []);

  const signOut = useCallback(
    async (reason: SignOutReason = "explicit") => {
      let confirmed = true;
      try {
        await Auth.logout();
      } catch (e) {
        // 401 — the session was already gone: an ordinary sign-out. Anything else (503 SESSION_NOT_REVOKED when the
        // session store is down, another 5xx, 403, the network) — the server did not confirm it (review T2-10): the UI
        // still leaves the session, but warns instead of showing the ordinary sign-in screen.
        confirmed = (e as ApiError | null)?.status === 401;
      }
      toLogin(!confirmed ? NOTICE.SESSION_NOT_REVOKED! : reason === "explicit" ? null : (NOTICE[reason] ?? null));
    },
    [toLogin],
  );

  const refreshMe = useCallback(async () => {
    try {
      const m = await Auth.me();
      setMe(m);
      return m;
    } catch {
      return null;
    }
  }, [setMe]);

  const session = useMemo<Session>(() => {
    const set = new Set<Permission>(me?.permissions ?? []);
    return {
      me,
      can: (p) => set.has(p),
      canAny: (ps) => ps.some((p) => set.has(p)),
      refreshMe,
      setMe,
      signOut,
      reloadTheme,
      themeVersion,
      adminLayout,
    };
  }, [me, refreshMe, setMe, signOut, reloadTheme, themeVersion, adminLayout]);

  const uiPrefs = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

  return (
    <PrefsCtx.Provider value={uiPrefs}>
      <SessionCtx.Provider value={session}>
        {phase === "boot" && (
          <div className="boot" role="status" aria-label={t("common.loading")}>
            <span className="spinner" aria-hidden="true" />
          </div>
        )}
        {phase === "login" && (
          <Login
            notice={notice}
            onDone={(m) => {
              setMe(m);
              setNotice(null);
              setPhase("app");
            }}
          />
        )}
        {phase === "app" && me && <Shell />}
        {stepUp && (
          <StepUpDialog
            onDone={(ok) => {
              stepUp.resolve(ok);
              setStepUp(null);
              if (ok) void refreshMe();
            }}
          />
        )}
      </SessionCtx.Provider>
    </PrefsCtx.Provider>
  );
}
