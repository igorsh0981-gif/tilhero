import type { DeletionResponse, ExperienceConfig, LearningPlan, Profile, SessionResponse, WhatsNew } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createBff } from "./api/bff";
import { ApiClient, type ClientOptions } from "./api/client";
import { ApiError, displayCode } from "./api/errors";
import { applyTheme, fetchExperience, FALLBACK_CONFIG, flag } from "./config/experience";
import { deviceTimeZone } from "./domain/schedule";
import { consentIsCurrent } from "./domain/onboarding";
import { hasWhatsNew } from "./domain/whatsNew";
import { env } from "./env";
import { resolveLang, useI18n } from "./i18n";
import { AppProvider, useApp, type AppCtx } from "./state/app";
import { useNav, type Pushed, type Tab } from "./state/nav";
import { bindTelegramEnvironment, needsOnboarding, parseStartParam, syncNativeChrome, tgReady, type BootMode, type DeepLink } from "./tg";
import { cx } from "./ui/kit";
import { PopupHost, ToastHost } from "./ui/overlays";
import { Bar, Tabs } from "./ui/shell";
import { BootError, Loading, Outside, type BootErrorKind } from "./screens/boot/BootScreens";
import { GuardianSheet } from "./screens/deeplink/GuardianSheet";
import { InviteSheet, type InviteTarget } from "./screens/deeplink/InviteSheet";
import { Home } from "./screens/home/Home";
import { Inbox } from "./screens/inbox/Inbox";
import { LockScreen } from "./screens/lock/LockScreen";
import { News } from "./screens/news/News";
import { Onboarding } from "./screens/onboarding/Onboarding";
import { DeleteScreen, DeletionDone } from "./screens/profile/DeleteScreen";
import { Family } from "./screens/profile/Family";
import { GoalScreen } from "./screens/profile/GoalScreen";
import { Guardian } from "./screens/profile/Guardian";
import { LanguageScreen } from "./screens/profile/LanguageScreen";
import { NotifSettings } from "./screens/profile/NotifSettings";
import { ParentCode } from "./screens/profile/ParentCode";
import { Privacy } from "./screens/profile/Privacy";
import { Profile as ProfileScreen } from "./screens/profile/Profile";
import { ScheduleScreen } from "./screens/profile/ScheduleScreen";
import { ThemeScreen } from "./screens/profile/ThemeScreen";
import { Soon } from "./screens/soon/Soon";
import { Diagnostics } from "./screens/diagnostics/Diagnostics";
import { DiagResultScreen } from "./screens/diagnostics/Result";
import { PlanScreen } from "./screens/plan/PlanScreen";
import { MediaRequests } from "./screens/practice/MediaRequests";
import { MediaScreen } from "./screens/practice/MediaScreen";
import { Practice } from "./screens/practice/Practice";
import { ScenarioScreen } from "./screens/practice/ScenarioScreen";
import { MyLanguages } from "./screens/profile/MyLanguages";
import { SkillMap } from "./screens/skills/SkillMap";
import { AppealScreen } from "./screens/lessons/AppealScreen";
import { LessonCardScreen } from "./screens/lessons/LessonCardScreen";
import { LessonsTab } from "./screens/lessons/LessonsTab";
import { LessonPlayer } from "./screens/lessons/Player";
import { LessonSummaryScreen } from "./screens/lessons/Summary";
import { isOpen, playerMarker } from "./domain/lessons";
import { Support, TicketScreen } from "./screens/support/Support";
import { WhatsNewSheet } from "./screens/whatsnew/WhatsNewSheet";

type Phase =
  | { kind: "boot" }
  | { kind: "outside" }
  | { kind: "error"; err: BootErrorKind; code: string }
  | { kind: "locked" }
  | { kind: "ready" }
  | { kind: "deleted"; res: DeletionResponse };

type Overlay = { kind: "invite"; target: InviteTarget } | { kind: "guardian"; token: string } | { kind: "wn"; data: WhatsNew };

export function bootErrorPhase(e: unknown): Phase {
  if (e instanceof ApiError) {
    if (e.status === 410 || e.code === "USER_DELETED") return { kind: "error", err: "deleted", code: "USER_DELETED" };
    if (e.status === 401 || e.status === 403) return { kind: "error", err: "reopen", code: e.code.startsWith("INIT_DATA_") ? e.code : "SESSION_REVOKED" };
    if (e.code === "RATE_LIMITED") return { kind: "error", err: "network", code: "RATE_LIMITED" };
    return { kind: "error", err: "network", code: e.status === 0 ? "NETWORK" : "SERVICE_UNAVAILABLE" };
  }
  return { kind: "error", err: "network", code: "UNKNOWN" };
}

/**
 * The shell: session by initData (AT-01) → parent code if required → onboarding or the main screens; deep links
 * (inv_ / invite_ / gc_ / ticket_ / route_), «Что нового» after onboarding and at every next login (AT-11), the
 * unread counter of the notification center (AT-12).
 */
export function App({ boot, client: injected }: { boot: BootMode; client?: Partial<ClientOptions> }) {
  const i18n = useI18n();
  const deviceTz = useMemo(deviceTimeZone, []);
  const [phase, setPhase] = useState<Phase>(boot.kind === "outside" ? { kind: "outside" } : { kind: "boot" });
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [plan, setPlan] = useState<LearningPlan | null>(null);
  const [config, setConfig] = useState<ExperienceConfig>(FALLBACK_CONFIG);
  const [online, setOnline] = useState(true);
  const [unread, setUnread] = useState(0);
  const [overlay, setOverlayState] = useState<Overlay | null>(null);
  const overlayRef = useRef<Overlay | null>(null);
  const queue = useRef<Overlay[]>([]);
  const pending = useRef<DeepLink | null>(null);
  const wnChecked = useRef(new Set<string>());
  const firstDone = useRef(false);
  const started = useRef(false);
  const nav = useNav();
  const configRef = useRef<ExperienceConfig>(FALLBACK_CONFIG);
  configRef.current = config;
  const langRef = useRef(i18n.lang);
  langRef.current = i18n.lang;

  // one client for the life of the app (tests may inject fetch / storage)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const client = useMemo(() => new ApiClient({ baseUrl: env.bffUrl, lang: () => langRef.current, timezone: () => deviceTz, ...injected }), []);
  const bff = useMemo(() => createBff(client), [client]);
  // the session flag (set at login from the plan, and by «Открыть главную» after the done step) — not the plan itself:
  // completing the plan must still show the done step of onboarding
  const onboarded = !!session?.onboarding_completed;
  const onboardedRef = useRef(onboarded);
  onboardedRef.current = onboarded;

  /* ---------- overlays: one at a time, the rest wait ---------- */
  const showOverlay = useCallback((o: Overlay) => {
    if (overlayRef.current) {
      queue.current.push(o);
      return;
    }
    overlayRef.current = o;
    setOverlayState(o);
  }, []);
  const closeOverlay = useCallback(() => {
    const next = queue.current.shift() ?? null;
    overlayRef.current = next;
    setOverlayState(next);
  }, []);

  /* ---------- deep links ---------- */
  const handleLink = useCallback(
    (link: DeepLink) => {
      switch (link.kind) {
        case "invite":
          return showOverlay({ kind: "invite", target: { token: link.token } });
        case "invitePreview":
          return showOverlay({ kind: "invite", target: { inviteId: link.inviteId } });
        case "guardian":
          return showOverlay({ kind: "guardian", token: link.token });
        case "ticket":
        case "route":
          if (needsOnboarding(link) && !onboardedRef.current) {
            pending.current = link;
            return;
          }
          if (link.kind === "route") return nav.route(link.route);
          nav.goTab("profile");
          return nav.push({ name: "support", number: link.number });
      }
    },
    [nav, showOverlay],
  );
  const openLink = useCallback((raw: string | null) => {
    const link = parseStartParam(raw);
    if (link) handleLink(link);
  }, [handleLink]);

  /* ---------- session ---------- */
  const loadAfterSession = useCallback(
    async (s: SessionResponse) => {
      setSession(s);
      i18n.setLang(resolveLang(s.account.locale, boot.kind === "outside" ? null : boot.languageCode));
      if (s.security.pin_required) {
        setPhase({ kind: "locked" });
        return;
      }
      const p = await bff.plan(deviceTz);
      setPlan(p);
      setSession({ ...s, onboarding_completed: s.onboarding_completed || !!p.onboarding_completed_at });
      setPhase({ kind: "ready" });
      if (!firstDone.current) {
        firstDone.current = true;
        const link = parseStartParam(s.start_param ?? (boot.kind === "outside" ? null : boot.startParam));
        if (link) {
          onboardedRef.current = !!p.onboarding_completed_at || s.onboarding_completed;
          handleLink(link);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bff, boot, deviceTz, handleLink],
  );

  const start = useCallback(async () => {
    if (boot.kind === "outside") return;
    setPhase({ kind: "boot" });
    try {
      await loadAfterSession(await client.resumeSession(boot.initData));
    } catch (e) {
      setPhase(bootErrorPhase(e));
    }
  }, [boot, client, loadAfterSession]);

  useEffect(() => {
    client.hooks = {
      onPinRequired: () => setPhase({ kind: "locked" }),
      onSessionLost: (e) => setPhase(e.status === 410 ? { kind: "error", err: "deleted", code: "USER_DELETED" } : { kind: "error", err: "reopen", code: displayCode(e) }),
      onConnectivity: setOnline,
      onSession: (s) => setSession((prev) => (prev ? { ...s, start_param: prev.start_param } : s)),
    };
  }, [client]);

  useEffect(() => {
    const off = bindTelegramEnvironment(() => syncNativeChrome());
    tgReady();
    if (started.current) return off;
    started.current = true;
    void fetchExperience((signal) => bff.experience(signal)).then(({ config: c }) => {
      setConfig(c);
      applyTheme(c);
      syncNativeChrome();
    });
    void start();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- after onboarding (and the consents): deferred deep link, then «Что нового» ---------- */
  const consentOk = !!session && consentIsCurrent(session.consent);
  useEffect(() => {
    const link = pending.current;
    if (phase.kind !== "ready" || !onboarded || !link) return;
    // the server opens invitations only after the policy is accepted (INTERNAL_API §11)
    if ((link.kind === "invite" || link.kind === "invitePreview") && !consentOk) return;
    pending.current = null;
    handleLink(link);
  }, [phase.kind, onboarded, consentOk, handleLink]);

  const learnerId = session?.learner.learner_id ?? null;
  useEffect(() => {
    if (phase.kind !== "ready" || !onboarded || !learnerId || wnChecked.current.has(learnerId)) return;
    wnChecked.current.add(learnerId);
    bff.whatsNew().then(
      (w) => {
        // the operator may switch the sheet at login off (flag whats_new_on_login); the welcome tour stays
        if (hasWhatsNew(w) && (w.mode === "welcome" || flag(configRef.current, "whats_new_on_login"))) showOverlay({ kind: "wn", data: w });
      },
      () => undefined,
    );
  }, [phase.kind, onboarded, learnerId, bff, showOverlay]);

  const refreshUnread = useCallback(() => {
    bff.unreadCount().then(
      (r) => setUnread(r.unread),
      () => undefined,
    );
  }, [bff]);
  useEffect(() => {
    if (phase.kind !== "ready" || !onboarded) return;
    refreshUnread();
    const id = setInterval(refreshUnread, 60_000);
    return () => clearInterval(id);
  }, [phase.kind, onboarded, learnerId, refreshUnread]);

  /* ---------- context ---------- */
  const applySession = useCallback(
    async (s: SessionResponse) => {
      setSession((prev) => ({ ...s, start_param: prev?.start_param ?? s.start_param }));
      if (s.security.pin_required) {
        setPhase({ kind: "locked" });
        return;
      }
      const p = await bff.plan(deviceTz);
      setPlan(p);
      if (p.onboarding_completed_at && !s.onboarding_completed) setSession((prev) => (prev ? { ...prev, onboarding_completed: true } : prev));
    },
    [bff, deviceTz],
  );
  const syncProfile = useCallback((p: Profile) => {
    setSession((prev) => (prev ? { ...prev, account: p.account, learner: p.learner, learners: p.learners, security: p.security, consent: p.consent } : prev));
  }, []);
  const patchSession = useCallback((patch: Partial<SessionResponse>) => setSession((prev) => (prev ? { ...prev, ...patch } : prev)), []);
  const reloadPlan = useCallback(async () => {
    try {
      const p = await bff.plan(deviceTz);
      setPlan(p);
      return p;
    } catch {
      return null;
    }
  }, [bff, deviceTz]);
  const finishOnboarding = useCallback(
    (p: LearningPlan) => {
      setPlan(p);
      setSession((prev) => {
        if (!prev) return prev;
        const me = prev.learner.learner_id;
        return {
          ...prev,
          onboarding_completed: true,
          learner: { ...prev.learner, onboarding_completed: true },
          learners: prev.learners.map((l) => (l.learner_id === me ? { ...l, onboarding_completed: true } : l)),
        };
      });
      nav.reset();
    },
    [nav],
  );

  const ctx: AppCtx | null = useMemo(
    () =>
      session
        ? {
            bff,
            session,
            applySession,
            syncProfile,
            patchSession,
            plan,
            setPlan,
            reloadPlan,
            config,
            nav,
            unread,
            setUnread,
            refreshUnread,
            openLink,
            endSession: (_kind, res) => {
              client.clear();
              client.forgetInitData();
              setPhase({ kind: "deleted", res });
            },
            deviceTz,
            online,
          }
        : null,
    [session, bff, applySession, syncProfile, patchSession, plan, reloadPlan, config, nav, unread, refreshUnread, openLink, client, deviceTz, online],
  );

  /* ---------- render ---------- */
  if (phase.kind === "outside") return <Frame><Outside /></Frame>;
  if (phase.kind === "error") return <Frame><BootError kind={phase.err} code={phase.code} onRetry={() => void start()} /></Frame>;
  if (phase.kind === "deleted") return <Frame><DeletionDone res={phase.res} /></Frame>;
  if (phase.kind === "locked" && session) {
    return (
      <Frame>
        <LockScreen
          length={session.security.pin_length ?? 4}
          pendingAt={session.security.pin_reset_effective_at}
          verify={async (pin) => {
            const s = await bff.verifyPin(pin);
            await loadAfterSession(s);
            return s;
          }}
          reset={{
            request: () => bff.pinResetRequest(),
            // review T-8: the reset waits 24 h — the session stays locked, the lock screen shows the pending reset
            confirm: async (code, pin) => {
              const security = await bff.pinResetConfirm(code, pin);
              setSession((prev) => (prev ? { ...prev, security } : prev));
              return security;
            },
          }}
        />
      </Frame>
    );
  }
  if (phase.kind !== "ready" || !ctx || !plan) return <Frame><Loading /></Frame>;

  const tabsVisible = onboarded && !nav.top;
  return (
    <AppProvider value={ctx}>
      <div className={cx("app", tabsVisible && "has-tabs")} data-learner={session?.learner.kind}>
        {!online ? (
          <div className="offline" role="status" data-testid="offline">
            {i18n.t("c.offline")}
          </div>
        ) : null}
        {onboarded ? <MainShell /> : <Onboarding onFinished={finishOnboarding} />}
        {overlay?.kind === "invite" ? (
          <InviteSheet
            target={overlay.target}
            onClose={closeOverlay}
            onAccepted={(r) => {
              closeOverlay();
              if (onboardedRef.current && r.family) nav.route("family");
            }}
            onDefer={(target) => {
              pending.current = "token" in target ? { kind: "invite", token: target.token } : { kind: "invitePreview", inviteId: target.inviteId };
              closeOverlay();
            }}
          />
        ) : null}
        {overlay?.kind === "guardian" ? <GuardianSheet token={overlay.token} onClose={closeOverlay} /> : null}
        {overlay?.kind === "wn" ? (
          <WhatsNewSheet
            data={overlay.data}
            onClose={(ids, route) => {
              if (ids.length) void bff.whatsNewSeen(ids).catch(() => undefined);
              closeOverlay();
              if (route) nav.route(route);
            }}
          />
        ) : null}
        <PopupHost />
        <ToastHost />
      </div>
    </AppProvider>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      {children}
      <PopupHost />
      <ToastHost />
    </div>
  );
}

function MainShell() {
  const { nav, unread, bff, session } = useApp();
  const { t } = useI18n();
  const top = nav.top;
  // the page went away with the lesson player open (reload of the Mini App, the webview restored it): continue the
  // same session from the same step (AT-42) — once per learner, only if it is still unfinished on the server
  const resumed = useRef<string | null>(null);
  useEffect(() => {
    const id = playerMarker.get();
    const me = session.learner.learner_id;
    if (!id || resumed.current === me) return;
    resumed.current = me;
    bff.activeSession(true).then(
      (r) => {
        if (r.session && r.session.session_id === id && isOpen(r.session)) nav.push({ name: "player", sessionId: id });
        else playerMarker.clear();
      },
      () => undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.learner.learner_id]);
  if (top) return <PushedScreen p={top} />;
  const bell = { unread, onClick: () => nav.push({ name: "inbox" }) };
  return (
    <>
      {nav.tab === "home" ? <Bar logo bell={bell} /> : <Bar title={t(`tab.${nav.tab}`)} bell={bell} />}
      <TabScreen tab={nav.tab} />
      <Tabs current={nav.tab} onTab={nav.goTab} />
    </>
  );
}

function TabScreen({ tab }: { tab: Tab }) {
  switch (tab) {
    case "home":
      return <Home />;
    case "profile":
      return <ProfileScreen />;
    case "progress":
      return <SkillMap />;
    case "lessons":
      return <LessonsTab />;
    default:
      return <Soon what={tab} />;
  }
}

function PushedScreen({ p }: { p: Pushed }) {
  const { nav } = useApp();
  const { t } = useI18n();
  switch (p.name) {
    case "inbox":
      return <Inbox />;
    case "news":
      return <News />;
    case "schedule":
      return <ScheduleScreen />;
    case "notifSettings":
      return <NotifSettings />;
    case "language":
      return <LanguageScreen />;
    case "theme":
      return <ThemeScreen />;
    case "goal":
      return <GoalScreen />;
    case "family":
      return <Family />;
    case "guardian":
      return <Guardian />;
    case "privacy":
      return <Privacy />;
    case "parentCode":
      return <ParentCode cancel={p.cancel} />;
    case "delete":
      return <DeleteScreen />;
    case "support":
      return <Support number={p.number} />;
    case "ticket":
      return <TicketScreen id={p.id} />;
    case "diagnostics":
      return <Diagnostics />;
    case "diagResult":
      return <DiagResultScreen result={p.result} />;
    case "skills":
      return (
        <>
          <Bar title={t("sk.title")} onBack={nav.back} />
          <SkillMap />
        </>
      );
    case "plan":
      return <PlanScreen />;
    case "practice":
      return <Practice tab={p.tab} />;
    case "scenario":
      return <ScenarioScreen id={p.id} />;
    case "mediaItem":
      return <MediaScreen id={p.id} />;
    case "mediaRequests":
      return <MediaRequests />;
    case "languages":
      return <MyLanguages />;
    case "lessonCard":
      return <LessonCardScreen key={p.id} id={p.id} />;
    case "player":
      return <LessonPlayer key={p.sessionId} sessionId={p.sessionId} />;
    case "lessonSummary":
      return <LessonSummaryScreen key={p.sessionId} sessionId={p.sessionId} initial={p.summary} />;
    case "appeal":
      return <AppealScreen evaluationId={p.evaluationId} title={p.title} />;
  }
}
