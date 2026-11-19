import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RoleCode } from "@tilhero/contracts/admin";
import { Auth, Support, type SupportStats } from "../api/endpoints";
import { useI18n, fmtCountdown } from "../i18n";
import { useUiPrefs } from "../App";
import { prefs } from "../lib/storage";
import { activity, confirmIdle, idleState, shareActivity } from "../state/activity";
import { GROUP_OF, homePage, navItem, pageAllowed, visibleNav, type PageId } from "../state/nav";
import { useHashRoute } from "../state/route";
import { useSession } from "../state/session";
import { Icon } from "../ui/Icon";
import { Btn, cx, IconBtn, Spinner } from "../ui/kit";
import { MenuButton, MenuItem, Modal } from "../ui/overlays";
import { useToast } from "../ui/toasts";
import { errMeta, errText } from "../ui/errors";
import { initials } from "../lib/ids";
import { ThemeMenu } from "./ThemeMenu";
import { AccountDrawer } from "./AccountDrawer";
import { NavCtx } from "./navctx";
import { RateWaitNotice } from "../ui/RateWait";
import { Wordmark } from "../ui/Wordmark";
import { Overview } from "../screens/overview/Overview";
import { LearnersPage } from "../screens/learners/Learners";
import { SupportPage } from "../screens/support/Support";
import { NewsPage } from "../screens/news/News";
import { ConfigPage } from "../screens/config/Config";
import { Roles, ROLE_CODES } from "../screens/roles/Roles";
import { AuditPage } from "../screens/audit/Audit";
import { Soon } from "../screens/soon/Soon";
import { ErrorBoundary } from "../ui/ErrorBoundary";

// sprint 3 sections are separate chunks (review T2-5: one 545 kB bundle) — loaded on first visit, same origin (CSP)
const ContentPage = lazy(() => import("../screens/content/ContentPage").then((m) => ({ default: m.ContentPage })));
const LangsPage = lazy(() => import("../screens/langs/Langs").then((m) => ({ default: m.LangsPage })));
// sprint 4 sections — one chunk each (their shared model/parts form a common chunk)
const AgentsPage = lazy(() => import("../screens/ai/Agents").then((m) => ({ default: m.AgentsPage })));
const QaPage = lazy(() => import("../screens/ai/Qa").then((m) => ({ default: m.QaPage })));
const CostsPage = lazy(() => import("../screens/ai/Costs").then((m) => ({ default: m.CostsPage })));

export const APP_VERSION = "admin-web 0.2.0";

/** Sections whose route id is a tab or an object: «#/news/templates/streak.reminder», «#/support/TCK-1042». */
function crumbOf(page: PageId | "", id: string | null): string | null {
  if (!id) return null;
  if (page === "news") return id.split("/").slice(1).join("/") || null;
  if (page === "content") return id.split("/").slice(1).join("/") || null;
  if (page === "qa") return id.startsWith("sessions/") ? id.slice(9, 17) : id.startsWith("appeals/") ? id.slice(8, 16) : null;
  if (page === "agents") return id === "models" ? null : id;
  return id;
}

export function Shell() {
  const i = useI18n();
  const { t, lang, setLang } = i;
  const session = useSession();
  const me = session.me!;
  const toast = useToast();
  const { theme, setTheme } = useUiPrefs();
  const [route, go] = useHashRoute();
  const [collapsed, setCollapsed] = useState(() => prefs.get<boolean>("navCollapsed", false) === true);
  const [navOpen, setNavOpen] = useState(false);
  const [account, setAccount] = useState(false);
  const [stats, setStats] = useState<SupportStats | null>(null);
  const [idle, setIdle] = useState<{ left: number } | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const perms = useMemo(() => new Set(me.permissions), [me.permissions]);
  const menu = session.adminLayout?.menu ?? null;
  const home = homePage(perms, menu);

  // guard: unknown/forbidden/switched-off section → the role's start screen
  useEffect(() => {
    if (!route.page) {
      if (home) go(home, null, true);
      return;
    }
    if (!pageAllowed(route.page, perms, menu)) {
      if (navItem(route.page)) toast(t("nav.denied", { page: t(`page.${route.page as PageId}`) }), "err");
      if (home) go(home, null, true);
    }
  }, [route.page, perms, menu, home, go, toast, t]);

  const navigate = useCallback(
    (page: string, id?: string | null) => {
      setNavOpen(false);
      go(page, id ?? null);
      window.scrollTo(0, 0);
      setTimeout(() => mainRef.current?.focus({ preventScroll: true }), 0);
    },
    [go],
  );

  // open-ticket counter of the sidebar (support stats; background poll — never extends the session)
  const canSupport = perms.has("support.read");
  const loadStats = useCallback(() => {
    if (!canSupport) return;
    Support.stats("today", true)
      .then(setStats)
      .catch(() => setStats(null));
  }, [canSupport]);
  useEffect(() => {
    loadStats();
    const id = setInterval(loadStats, 60_000);
    return () => clearInterval(id);
  }, [loadStats]);

  // inactivity: warning 2 min before the 30-min idle timeout, heartbeat GET /me while the user is active
  const timeout = me.session.idle_timeout_seconds || 1800;
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => shareActivity(), []);
  useEffect(() => activity.touch(), []);
  useEffect(() => {
    const mark = () => {
      if (!idleRef.current) activity.touch();
    };
    const evs = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    evs.forEach((e) => document.addEventListener(e, mark, { passive: true, capture: true }));
    let checking = false;
    const id = setInterval(() => {
      if (checking) return;
      const s = idleState(Date.now(), activity.user, activity.server, timeout);
      if (s.expired) {
        checking = true;
        void confirmIdle().then((last) => {
          if (idleState(Date.now(), last, activity.server, timeout).expired) void sessionRef.current.signOut("idle");
          else checking = false;
        });
        return;
      }
      if (s.heartbeat) {
        activity.serverTouch();
        void sessionRef.current.refreshMe();
      }
      setIdle(s.warn ? { left: s.left } : null);
    }, 1000);
    return () => {
      clearInterval(id);
      evs.forEach((e) => document.removeEventListener(e, mark, { capture: true }));
    };
  }, [timeout]);

  const stayIn = async () => {
    activity.touch();
    setIdle(null);
    const m = await session.refreshMe();
    if (m) toast(t("idle.extended"), "ok");
  };

  const impersonate = async (role: RoleCode | null) => {
    try {
      const m = await Auth.impersonate(role);
      const fresh = m && typeof m === "object" && "staff" in m ? m : await session.refreshMe();
      if (fresh) session.setMe(fresh);
      toast(role ? t("imp.done", { r: t(`role.${role}`) }) : t("imp.off"), "info", t("imp.devOnly"));
      go(homePage(new Set(fresh?.permissions ?? []), menu) ?? "overview", null, true);
    } catch (e) {
      toast(errText(i, e), "err", errMeta(e));
    }
  };

  const page = (pageAllowed(route.page, perms, menu) ? route.page : "") as PageId | "";
  const item = page ? navItem(page) : undefined;
  const crumbId = crumbOf(page, route.id);
  const title = page ? t(`page.${page}`) : "";
  const groups = visibleNav(perms, menu);
  const openCount = stats ? stats.open : null;
  const hot = !!stats && stats.breached > 0;
  const roleName = t(`role.${me.impersonating ?? me.staff.role}`);

  return (
    <NavCtx.Provider value={{ route, navigate }}>
      <div className={cx("shell", collapsed && "is-collapsed", navOpen && "is-nav-open", session.adminLayout?.density === "comfortable" && "density-comfortable")} data-testid="shell">
        <aside className="sidenav" id="sidenav" aria-label={t("nav.label")}>
          <div className="sn-head">
            <Wordmark compact={collapsed} sub={t("nav.brandSub", { env: me.env })} />
          </div>
          <nav className="sn-scroll" data-testid="sidenav">
            {groups.map((g) => (
              <div className="sn-group" key={g.group} data-group={g.group}>
                <div className="sn-group-label">{t(`nav.g.${g.group}`)}</div>
                {g.items.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    className={cx("sn-item", it.soon && "is-soon")}
                    aria-current={page === it.id ? "page" : undefined}
                    title={collapsed ? t(`page.${it.id}`) : undefined}
                    onClick={() => navigate(it.id)}
                    data-nav={it.id}
                  >
                    <Icon name={it.icon} />
                    <span className="sn-label">{t(`page.${it.id}`)}</span>
                    {it.id === "support" && openCount ? (
                      <span className={cx("sn-count", hot && "is-hot")} title={hot ? t("nav.breached", { n: stats!.breached }) : t("nav.openTickets")} data-testid="support-count">
                        {openCount}
                      </span>
                    ) : null}
                    {it.soon && <span className="sn-tag">{t("nav.soonN", { n: it.soon })}</span>}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="sn-foot">
            <span className={cx("env-chip", `env-${me.env}`)} title={t("nav.env")} data-testid="env-chip">
              <span>{me.env}</span>
            </span>
            <span className="sn-ver" title={session.themeVersion ? `${APP_VERSION} · admin ${session.themeVersion}` : APP_VERSION}>
              {session.themeVersion ? `admin ${session.themeVersion}` : APP_VERSION}
            </span>
            <button
              type="button"
              className="sn-collapse"
              aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
              title={collapsed ? t("nav.expand") : t("nav.collapse")}
              onClick={() => {
                prefs.set("navCollapsed", !collapsed);
                setCollapsed(!collapsed);
              }}
            >
              <Icon name="chevsL" />
            </button>
          </div>
        </aside>
        {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
        <div className="main-col">
          <header className="topbar" data-testid="topbar">
            <IconBtn icon="menu" label={t("nav.open")} className="tb-burger" onClick={() => setNavOpen(true)} expanded={navOpen} testId="burger" />
            <div className="tb-title">
              <div className="crumbs" aria-label={t("nav.crumbs")}>
                {page && <span>{t(`nav.g.${GROUP_OF[page]}`)}</span>}
                {page && crumbId && (
                  <>
                    <span className="sep">/</span>
                    <button type="button" onClick={() => navigate(page)}>
                      {title}
                    </button>
                  </>
                )}
              </div>
              <h1 className="page-title" title={crumbId ?? title} data-testid="page-title">
                {crumbId && page === "support" ? crumbId : title}
              </h1>
            </div>
            <div className="tb-spacer" />
            <div className="tb-actions">
              {me.env === "dev" ? (
                <MenuButton
                  label={t("imp.title")}
                  className="role-btn"
                  testId="imp-btn"
                  menuClass="demo-menu"
                  render={(close) => (
                    <>
                      <div className="menu-h">
                        {t("imp.title")} <span className="menu-h-sub">· ENV=dev</span>
                      </div>
                      <div className="menu-note imp-note">
                        <Icon name="alert" />
                        <span>{t("imp.note")}</span>
                      </div>
                      <MenuItem checked={!me.impersonating} onClick={() => { close(); void impersonate(null); }}>
                        {t("imp.own", { r: t(`role.${me.staff.role}`) })}
                      </MenuItem>
                      {ROLE_CODES.filter((r) => r !== me.staff.role).map((r) => (
                        <MenuItem key={r} checked={me.impersonating === r} onClick={() => { close(); void impersonate(r); }} testId={`imp-${r}`}>
                          {t(`role.${r}`)}
                        </MenuItem>
                      ))}
                    </>
                  )}
                >
                  <Icon name="sliders" />
                  <span className="role-k">{t("imp.short")}:</span>
                  <span className="role-name">{roleName}</span>
                  <Icon name="chevD" />
                </MenuButton>
              ) : (
                <span className="pill no-dot tb-role tb-hide-sm" data-testid="role-pill">
                  {t("account.rolePill", { r: roleName })}
                </span>
              )}
              <div className="seg-mini tb-lang" role="group" aria-label={t("common.language")}>
                <button type="button" aria-pressed={lang === "ru"} onClick={() => setLang("ru")} data-testid="lang-ru">
                  RU
                </button>
                <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")} data-testid="lang-en">
                  EN
                </button>
              </div>
              <ThemeMenu theme={theme} setTheme={setTheme} />
              <MenuButton
                label={`${t("account.title")}: ${me.staff.display_name}`}
                className="avatar"
                testId="avatar"
                render={(close) => (
                  <>
                    <div className="menu-id">
                      <span className="avatar lg">{initials(me.staff.display_name)}</span>
                      <span>
                        <b>{me.staff.display_name}</b>
                        <span className="mono block">{me.staff.email}</span>
                      </span>
                    </div>
                    <div className="menu-note">
                      {t("account.role")}: <b>{t(`role.${me.staff.role}`)}</b>
                      {me.impersonating ? ` · ${t("imp.as", { r: t(`role.${me.impersonating}`) })}` : ""} · {me.mfa_enabled ? "TOTP" : t("account.noMfa")}
                      <br />
                      {t("account.sessionUntil", { t: i.fmt.dateTime(me.session.expires_at) })}
                      <br />
                      {t("account.idle", { n: Math.round(timeout / 60) })}
                    </div>
                    <div className="menu-sep" />
                    <div className="menu-h">{t("common.language")}</div>
                    <MenuItem checked={lang === "ru"} onClick={() => setLang("ru")}>
                      {t("lang.ru")}
                    </MenuItem>
                    <MenuItem checked={lang === "en"} onClick={() => setLang("en")}>
                      {t("lang.en")}
                    </MenuItem>
                    <div className="menu-sep" />
                    <MenuItem icon="key" onClick={() => { close(); setAccount(true); }} testId="menu-password">
                      {t("account.changePwd")}
                    </MenuItem>
                    <MenuItem icon="logout" danger onClick={() => { close(); void session.signOut("explicit"); }} testId="menu-logout">
                      {t("account.logout")}
                    </MenuItem>
                  </>
                )}
              >
                {initials(me.staff.display_name)}
              </MenuButton>
            </div>
          </header>
          <main className="main" tabIndex={-1} ref={mainRef} id="main" data-testid={page ? `page-${page}` : undefined}>
            <RateWaitNotice scope={[]} testId="staff-rate-wait" />
            <ErrorBoundary scope="section" resetKey={`${page}/${route.id ?? ""}`}>
              {item?.soon ? (
                <Soon page={item.id} sprint={item.soon} />
              ) : page === "overview" ? (
                <Overview />
              ) : page === "users" ? (
                <LearnersPage openId={route.id} />
              ) : page === "support" ? (
                <SupportPage ticketRef={route.id} onStats={loadStats} />
              ) : page === "news" ? (
                <NewsPage routeId={route.id} />
              ) : page === "config" ? (
                <ConfigPage />
              ) : page === "roles" ? (
                <Roles />
              ) : page === "audit" ? (
                <AuditPage />
              ) : page === "content" ? (
                <Suspense fallback={<Spinner label={t("common.loading")} />}>
                  <ContentPage routeId={route.id} />
                </Suspense>
              ) : page === "langs" ? (
                <Suspense fallback={<Spinner label={t("common.loading")} />}>
                  <LangsPage />
                </Suspense>
              ) : page === "agents" ? (
                <Suspense fallback={<Spinner label={t("common.loading")} />}>
                  <AgentsPage routeId={route.id} />
                </Suspense>
              ) : page === "qa" ? (
                <Suspense fallback={<Spinner label={t("common.loading")} />}>
                  <QaPage routeId={route.id} />
                </Suspense>
              ) : page === "costs" ? (
                <Suspense fallback={<Spinner label={t("common.loading")} />}>
                  <CostsPage />
                </Suspense>
              ) : null}
            </ErrorBoundary>
          </main>
        </div>
      </div>
      {account && <AccountDrawer onClose={() => setAccount(false)} />}
      {idle && (
        <Modal
          title={t("idle.t")}
          text={t("idle.m")}
          icon="clock"
          tone="warn"
          onClose={() => void stayIn()}
          testId="idle-warning"
          footer={
            <>
              <Btn label={t("account.logout")} onClick={() => void session.signOut("explicit")} />
              <Btn label={t("idle.stay")} kind="primary" onClick={() => void stayIn()} testId="idle-stay" />
            </>
          }
        >
          <div className="idle-count">
            <span className="mono" data-testid="idle-countdown">
              {fmtCountdown(idle.left)}
            </span>
            <span className="small muted">{t("idle.left")}</span>
          </div>
        </Modal>
      )}
    </NavCtx.Provider>
  );
}
