import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RoleCode } from "@tilhero/contracts/admin";
import { Auth, ReviewApi, Support, type SupportStats } from "../api/endpoints";
import { useI18n } from "../i18n";
import { useUiPrefs } from "../App";
import { prefs } from "../lib/storage";
import { activity, confirmIdle, idleState, shareActivity } from "../state/activity";
import { GROUP_OF, homePage, navItem, pageAllowed, visibleNav, type PageId } from "../state/nav";
import { useHashRoute } from "../state/route";
import { useSession } from "../state/session";
import { Icon } from "../ui/Icon";
import { Btn, cx, IconBtn } from "../ui/kit";
import { MenuButton, MenuItem, Modal } from "../ui/overlays";
import { useToast } from "../ui/toasts";
import { errMeta, errText } from "../ui/errors";
import { fmtCountdown } from "../i18n";
import { initials, shortId } from "../lib/ids";
import { ThemeMenu } from "./ThemeMenu";
import { AccountDrawer } from "./AccountDrawer";
import { NavCtx } from "./navctx";
import { Dashboard } from "../screens/dashboard/Dashboard";
import { UsersSection } from "../screens/users/UsersSection";
import { SupportPage } from "../screens/support/Support";
import { Roles } from "../screens/roles/Roles";
import { AuditPage } from "../screens/audit/Audit";
import { ConfigPage } from "../screens/config/Config";
import { Soon } from "../screens/soon/Soon";
import { ReviewPage } from "../screens/review/Review";
import { SourcesPage } from "../screens/sources/Sources";
import { DiscoveryPage } from "../screens/discovery/Discovery";
import { TravelPage } from "../screens/travel/Travel";
import { FeedsPage } from "../screens/news/Feeds";
import { NewsPage } from "../screens/news/News";
import { WatchesPage } from "../screens/news/Watches";
import { RequestsPage } from "../screens/ai/Requests";
import { BudgetsPage } from "../screens/ai/Budgets";
import { AgentsPage } from "../screens/ai/Agents";
import { AlertsBell } from "./AlertsBell";
import { MonitoringPage } from "../screens/monitoring/Monitoring";
import { RateWaitNotice } from "../ui/RateWait";

const ROLES: readonly RoleCode[] = ["super_admin", "operations", "support", "billing", "agent_manager", "analyst", "auditor", "read_only"];
export const APP_VERSION = "admin-web 0.1.0";

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
  const home = homePage(perms);

  // guard: unknown/forbidden section → the role's start screen
  useEffect(() => {
    if (!route.page) {
      if (home) go(home, null, true);
      return;
    }
    if (!pageAllowed(route.page, perms)) {
      if (navItem(route.page)) toast(t("nav.denied", { page: t(`page.${route.page as PageId}`) }), "err");
      if (home) go(home, null, true);
    }
  }, [route.page, perms, home, go, toast, t]);

  const navigate = useCallback(
    (page: string, id?: string | null) => {
      setNavOpen(false);
      go(page, id ?? null);
      window.scrollTo(0, 0);
      setTimeout(() => mainRef.current?.focus({ preventScroll: true }), 0);
    },
    [go],
  );

  // open-ticket counter for the sidebar (support.stats, real numbers only)
  const canSupport = perms.has("support.read");
  const loadStats = useCallback(() => {
    if (!canSupport) return;
    Support.stats("today", true) // sidebar counter: background poll, never extends the session
      .then(setStats)
      .catch(() => setStats(null));
  }, [canSupport]);
  useEffect(() => {
    loadStats();
    const id = setInterval(loadStats, 60_000);
    return () => clearInterval(id);
  }, [loadStats]);

  // OPEN review counter for the sidebar (events.review): first page of the queue, «99+» when there are more
  const canReview = perms.has("events.review");
  const [reviewOpen, setReviewOpen] = useState<{ n: number; more: boolean } | null>(null);
  const loadReviewCount = useCallback(() => {
    if (!canReview) return;
    ReviewApi.list({ status: "OPEN", limit: 100 }, true)
      .then((p) => setReviewOpen({ n: p.items.length, more: !!p.next_cursor }))
      .catch(() => setReviewOpen(null));
  }, [canReview]);
  useEffect(() => {
    loadReviewCount();
    const id = setInterval(loadReviewCount, 60_000);
    return () => clearInterval(id);
  }, [loadReviewCount]);

  // inactivity: warning 2 min before the 30-min idle timeout, heartbeat GET /me while the user is active
  const timeout = me.session.idle_timeout_seconds || 1800;
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // the session cookie is shared by all tabs → so is the idle timer (BroadcastChannel, timestamps only)
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
        // before POST /auth/logout ask the other tabs: the operator may be typing a reply in one of them
        checking = true;
        void confirmIdle().then((last) => {
          if (idleState(Date.now(), last, activity.server, timeout).expired) void sessionRef.current.signOut("idle");
          else checking = false; // another tab is in use — the shared timer moved on
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
      go(homePage(new Set(fresh?.permissions ?? [])) ?? "dashboard", null, true);
    } catch (e) {
      toast(errText(i, e), "err", errMeta(e));
    }
  };

  const page = (pageAllowed(route.page, perms) ? route.page : "") as PageId | "";
  const item = page ? navItem(page) : undefined;
  // sprint 7: #/requests/user:<uuid> is a filter of the request log, not an object — no crumb for it
  // sprint 8: #/monitoring/<tab>[/<provider>] — a tab, not an object; no crumb for it
  // sprint 9: #/users/deletions[/<filter>|/<request_id>] — the «Deletions» tab; a request id is the crumb
  const deletions = page === "users" && (route.id ?? "").split("/")[0] === "deletions";
  const delId = deletions ? (route.id ?? "").split("/")[1] ?? "" : "";
  const crumbId = deletions
    ? /^[0-9a-f-]{36}$/i.test(delId)
      ? delId
      : null
    : route.id && !(page === "requests" && route.id.startsWith("user:")) && page !== "monitoring"
      ? route.id
      : null;
  const title = (page === "support" || page === "agents") && crumbId ? crumbId : deletions ? t("page.deletions") : page ? t(`page.${page}`) : "";
  const idLabel = crumbId && crumbId.length > 20 ? shortId(crumbId, 8, 4) : crumbId;
  const crumbs: Array<{ label: string; page?: string; id?: string }> = page
    ? deletions
      ? [{ label: t(`nav.g.${GROUP_OF[page]}`) }, { label: t("page.users"), page }, ...(crumbId ? [{ label: t("page.deletions"), page: "users", id: "deletions" }, { label: idLabel ?? "" }] : [{ label: t("page.deletions") }])]
      : [{ label: t(`nav.g.${GROUP_OF[page]}`) }, ...(crumbId ? [{ label: t(`page.${page}`), page }, { label: idLabel ?? "" }] : [{ label: t(`page.${page}`) }])]
    : [];

  const groups = visibleNav(perms);
  const openCount = stats ? stats.open : null;
  const hot = !!stats && stats.breached > 0;

  return (
    <NavCtx.Provider value={{ route, navigate }}>
      <div className={cx("shell", collapsed && "is-collapsed", navOpen && "is-nav-open", session.adminLayout?.density === "comfortable" && "density-comfortable")} data-testid="shell">
        <aside className="sidenav" id="sidenav" aria-label={t("nav.label")}>
          <div className="sn-head">
            <span className="wordmark" aria-label="TilHero Admin">
              {collapsed ? (
                <span className="wm-event">Ai</span>
              ) : (
                <>
                  Ai<span className="wm-event">Event</span>
                  <span className="wm-suffix">Admin</span>
                </>
              )}
            </span>
          </div>
          <nav className="sn-scroll" data-testid="sidenav">
            {groups.map((g) => (
              <div className="sn-group" key={g.group}>
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
                      <>
                        <span className={cx("sn-count", hot && "is-hot")} title={t("nav.openTickets")}>
                          {openCount}
                        </span>
                        {hot && <span className="sn-dot" aria-hidden="true" />}
                      </>
                    ) : null}
                    {it.id === "review" && reviewOpen && reviewOpen.n > 0 ? (
                      <span className="sn-count" title={t("nav.openReview")} data-testid="review-count">
                        {reviewOpen.more || reviewOpen.n > 99 ? "99+" : reviewOpen.n}
                      </span>
                    ) : null}
                    {it.soon && <span className="sn-tag">{t("nav.soon")}</span>}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="sn-foot">
            <span className={cx("env-chip", `env-${me.env}`)} title={t("nav.env")} data-testid="env-chip">
              <span>{me.env}</span>
            </span>
            <span className="sn-ver" title={session.themeVersion ? `${APP_VERSION} · theme ${session.themeVersion}` : APP_VERSION}>
              {APP_VERSION}
              {session.themeVersion ? ` · theme ${session.themeVersion}` : ""}
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
                {crumbs.map((c, idx) => (
                  <span key={idx} className="row" style={{ gap: 6 }}>
                    {idx > 0 && <span className="sep">/</span>}
                    {c.page ? (
                      <button type="button" onClick={() => navigate(c.page!, c.id ?? null)}>
                        {c.label}
                      </button>
                    ) : (
                      <span>{c.label}</span>
                    )}
                  </span>
                ))}
              </div>
              <h1 className="page-title" title={title} data-testid="page-title">
                {title}
              </h1>
            </div>
            <div className="tb-spacer" />
            <div className="tb-actions">
              {me.env === "dev" && (
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
                      {ROLES.filter((r) => r !== me.staff.role).map((r) => (
                        <MenuItem key={r} checked={me.impersonating === r} onClick={() => { close(); void impersonate(r); }} testId={`imp-${r}`}>
                          {t(`role.${r}`)}
                        </MenuItem>
                      ))}
                    </>
                  )}
                >
                  <Icon name="sliders" />
                  <span className="role-k">{t("imp.short")}:</span>
                  <span className="role-name">{t(`role.${me.impersonating ?? me.staff.role}`)}</span>
                  <Icon name="chevD" />
                </MenuButton>
              )}
              <div className="seg-mini tb-lang" role="group" aria-label={t("common.language")}>
                <button type="button" aria-pressed={lang === "ru"} onClick={() => setLang("ru")} data-testid="lang-ru">
                  RU
                </button>
                <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")} data-testid="lang-en">
                  EN
                </button>
              </div>
              {(pageAllowed("budgets", perms) || pageAllowed("monitoring", perms)) && <AlertsBell onOpen={(pg, id) => navigate(pg, id)} allowed={(pg) => pageAllowed(pg, perms)} />}
              <ThemeMenu theme={theme} setTheme={setTheme} className="tb-hide-sm" />
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
            {/* sprint 9 review: the staff member's own limit (adm.staff) — live countdown over every screen */}
            <RateWaitNotice scope={[]} testId="staff-rate-wait" />
            {item?.soon ? (
              <Soon page={item.id} sprint={item.soon} />
            ) : page === "dashboard" ? (
              <Dashboard />
            ) : page === "users" ? (
              <UsersSection openId={route.id} />
            ) : page === "support" ? (
              <SupportPage ticketRef={route.id} onStats={loadStats} />
            ) : page === "roles" ? (
              <Roles />
            ) : page === "audit" ? (
              <AuditPage />
            ) : page === "config" ? (
              <ConfigPage />
            ) : page === "review" ? (
              <ReviewPage openId={route.id} onChanged={loadReviewCount} />
            ) : page === "sources" ? (
              <SourcesPage openId={route.id} />
            ) : page === "discovery" ? (
              <DiscoveryPage openId={route.id} />
            ) : page === "travel" ? (
              <TravelPage />
            ) : page === "feeds" ? (
              <FeedsPage openId={route.id} />
            ) : page === "news" ? (
              <NewsPage />
            ) : page === "watches" ? (
              <WatchesPage />
            ) : page === "requests" ? (
              <RequestsPage openId={route.id} />
            ) : page === "budgets" ? (
              <BudgetsPage />
            ) : page === "agents" ? (
              <AgentsPage openId={route.id} />
            ) : page === "monitoring" ? (
              <MonitoringPage openId={route.id} />
            ) : null}
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
