import type { DeletionResponse, ExperienceConfig, Profile, SecurityState, SessionResponse } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { ApiClient } from "./api/client";
import { createApi } from "./api/endpoints";
import { ApiError, errorText } from "./api/errors";
import { applyTheme, fetchExperience, FALLBACK_CONFIG, type ConfigSource } from "./config/experience";
import { env } from "./env";
import { resolveLang, useI18n, type Lang, type MessageKey } from "./i18n";
import { Home } from "./screens/home/Home";
import { Lock } from "./screens/lock/Lock";
import { Onboarding } from "./screens/onboarding/Onboarding";
import { Profile as ProfileScreen } from "./screens/profile/Profile";
import { resetCatalogMemory } from "./events/memory";
import { forgetSavedFilters } from "./events/saved";
import { Catalog } from "./screens/events/Catalog";
import { EventDetail } from "./screens/events/EventDetail";
import { News } from "./screens/news/News";
import { Watch } from "./screens/watch/Watch";
import { SupportDone, SupportList, SupportNew, SupportThread } from "./screens/support/Support";
import { Boot, DeletionAccepted, Fatal, OpenInTelegram } from "./screens/system/System";
import { AppContext, type AppCtx } from "./state/app";
import { initialNav, navReducer, rootTab, topRoute, type Route } from "./state/nav";
import {
  bindTelegramEnvironment,
  isInsideTelegram,
  mainButtonStore,
  nativeMainButton,
  parseStartParam,
  resyncNativeButtons,
  syncNativeChrome,
  tgReady,
  useBackButton,
  useNativeButtonsWiring,
  useStoreTop,
  type BootMode,
  type DeepLink,
} from "./tg";
import { Icon } from "./ui/Icon";
import { LAYERS_ID, PopupHost, showToast, ToastHost } from "./ui/overlays";
import { DevChrome, MainBar, NetBanner, TabBar } from "./ui/shell";
import { useCriticalCount, watchStore } from "./watch/store";
import { aiStore } from "./ai/store";
import { rateLimits } from "./api/rateLimit";
import { AiChatHost } from "./screens/ai/AiChat";

type Phase =
  | { k: "boot" }
  | { k: "outside" }
  | { k: "fatal"; title: MessageKey; text: string }
  | { k: "locked" }
  | { k: "onboarding" }
  | { k: "main" }
  | { k: "deleted"; r: DeletionResponse | null };

const FATAL_TITLE: Record<string, MessageKey> = {
  INIT_DATA_EXPIRED: "sys.expired.h",
  // sprint 9 (O-1): initData is single-use — a fresh one comes only with a new launch from the bot chat
  INIT_DATA_REPLAYED: "sys.expired.h",
  REFRESH_INVALID: "sys.expired.h",
  USER_DELETED: "sys.deleted.h",
};

/**
 * Resolve a `ticket_TCK-NNNN` deep link to the ticket UUID. telegram-bff addresses a ticket by UUID or by
 * number; if a backend only knows UUIDs (404), fall back to scanning the paginated list.
 */
async function findTicketId(api: ReturnType<typeof createApi>, number: string): Promise<string | null> {
  try {
    return (await api.support.get(number)).ticket_id;
  } catch (e) {
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 422)) throw e;
  }
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const r = await api.support.list(cursor, 100);
    const hit = r.items.find((x) => x.number.toUpperCase() === number);
    if (hit) return hit.ticket_id;
    if (!r.next_cursor) return null;
    cursor = r.next_cursor;
  }
  return null;
}

export function App({ boot }: { boot: BootMode }) {
  const i18n = useI18n();
  const { t, setLang, fmt } = i18n;
  const inTelegram = isInsideTelegram();
  const [phase, setPhase] = useState<Phase>(boot.kind === "outside" ? { k: "outside" } : { k: "boot" });
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [config, setConfig] = useState<ExperienceConfig>(FALLBACK_CONFIG);
  const [configSource, setConfigSource] = useState<ConfigSource>("local");
  const [online, setOnline] = useState(true);
  const [nav, navigate] = useReducer(navReducer, undefined, () => initialNav("home"));
  const [refreshKey, setRefreshKey] = useState(0);
  const [firstVisit, setFirstVisit] = useState(false);
  const deepLink = useRef<DeepLink | null>(boot.kind === "outside" ? null : parseStartParam(boot.startParam));
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const client = useMemo(() => new ApiClient({ baseUrl: env.bffUrl, lang: () => document.documentElement.lang || "ru" }), []);
  const api = useMemo(() => createApi(client), [client]);

  /* ---------- client hooks: 423 → lock, lost session → fatal, connectivity → banner ---------- */
  useEffect(() => {
    client.hooks = {
      onPinRequired: () => {
        const k = phaseRef.current.k;
        if (k === "main" || k === "onboarding") setPhase({ k: "locked" });
      },
      onSessionLost: (e) => {
        resetCatalogMemory();
        setPhase({ k: "fatal", title: FATAL_TITLE[e.code] ?? "sys.expired.h", text: errorText(e, t, fmt.mmss) });
      },
      onConnectivity: (ok) => setOnline(ok),
      onSession: (s) => setSession(s),
    };
  }, [client, t, fmt]);

  /* ---------- Telegram environment ---------- */
  useNativeButtonsWiring();
  useEffect(() => {
    tgReady();
    return bindTelegramEnvironment(() => resyncNativeButtons());
  }, []);

  /* ---------- Remote Experience Config (public, with bundled fallback) ---------- */
  const loadConfig = useCallback(() => {
    void fetchExperience((signal) => api.experience.config(signal)).then(({ config: c, source }) => {
      applyTheme(c);
      setConfig(c);
      setConfigSource(source);
      syncNativeChrome();
      resyncNativeButtons();
    });
  }, [api]);
  useEffect(() => {
    applyTheme(FALLBACK_CONFIG);
    loadConfig();
  }, [loadConfig]);

  /* ---------- session ---------- */
  const reloadProfile = useCallback(async (): Promise<Profile | null> => {
    try {
      const p = await api.profile.get();
      setProfileState(p);
      setSession((s) => (s ? { ...s, user: p.user, security: p.security, consent: p.consent } : s));
      return p;
    } catch {
      return null;
    }
  }, [api]);

  const enter = useCallback(
    async (s: SessionResponse) => {
      if (s.user.status === "DELETION_REQUESTED") return setPhase({ k: "deleted", r: null });
      if (s.security.pin_required) return setPhase({ k: "locked" });
      if (!s.onboarding_completed) {
        const p = await reloadProfile();
        if (!p) return setPhase({ k: "fatal", title: "sys.err.h", text: t("err.SERVICE_UNAVAILABLE") });
        resetCatalogMemory(); // (re)onboarding: results of an earlier profile state must not survive
        return setPhase({ k: "onboarding" });
      }
      setPhase({ k: "main" });
    },
    [reloadProfile, t],
  );

  const start = useCallback(async () => {
    if (boot.kind === "outside") return;
    setPhase({ k: "boot" });
    try {
      const s = await client.resumeSession(boot.initData);
      setSession(s);
      setFirstVisit(s.user.is_new || !s.onboarding_completed);
      setLang(resolveLang(s.user.locale, boot.languageCode));
      await enter(s);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, "UNKNOWN", "");
      setPhase({ k: "fatal", title: FATAL_TITLE[err.code] ?? "sys.err.h", text: errorText(err, t, fmt.mmss) });
    }
    // boot exactly once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void start();
  }, [start]);

  /* ---------- deep link (start_param) once the main app is reachable ---------- */
  useEffect(() => {
    if (phase.k !== "main" || !deepLink.current) return;
    const dl = deepLink.current;
    deepLink.current = null;
    if (dl.kind === "tab") navigate({ type: "tab", tab: dl.tab });
    // startapp=event_<uuid> (shared from the Mini App, bot notifications): the detail over the catalogue
    else if (dl.kind === "event") navigate({ type: "reset", stack: [{ name: "catalog" }, { name: "event", id: dl.id }] });
    else if (dl.kind === "supportList") navigate({ type: "reset", stack: [{ name: "profile" }, { name: "supportList" }] });
    else {
      void findTicketId(api, dl.number).then(
        (id) => {
          const stack: Route[] = [{ name: "profile" }, { name: "supportList" }];
          if (id) stack.push({ name: "supportThread", id });
          else showToast(t("tk.notfound", { n: dl.number }), "info");
          navigate({ type: "reset", stack });
        },
        () => navigate({ type: "reset", stack: [{ name: "profile" }, { name: "supportList" }] }),
      );
    }
  }, [phase.k, api, t]);

  /* ---------- sprint 7: is the AI concierge there (GET /v1/ai/quota once the main app is reachable) ---------- */
  useEffect(() => {
    if (phase.k === "main") void aiStore.load(() => api.ai.quota());
    else aiStore.close();
  }, [phase.k, api]);
  // a chat belongs to the screen it was opened on: another tab or screen closes it
  useEffect(() => {
    aiStore.close();
  }, [nav.seq]);

  /* ---------- --ph / data-h: the measured app viewport drives no-scroll sizing ---------- */
  const appRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const app = appRef.current;
    const vp = vpRef.current;
    if (!app || !vp) return;
    const sync = () => {
      const h = vp.clientHeight;
      if (h) {
        app.style.setProperty("--ph", `${h}px`);
        app.dataset.h = h < 500 ? "xs" : h < 600 ? "s" : h < 700 ? "m" : "l";
      }
      const w = app.clientWidth;
      if (w) app.dataset.w = w < 390 ? "s" : "l";
    };
    sync();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null;
    ro?.observe(vp);
    window.addEventListener("resize", sync);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [phase.k]);

  // scroll to top on navigation
  useLayoutEffect(() => {
    vpRef.current?.scrollTo({ top: 0 });
  }, [nav.seq, phase.k]);

  /* ---------- BackButton ↔ navigation stack ---------- */
  useBackButton(phase.k === "main" && nav.stack.length > 1 ? () => navigate({ type: "pop" }) : null);

  const mainTop = useStoreTop(mainButtonStore);
  const critical = useCriticalCount();
  const showMainBar = !nativeMainButton();

  const ctx: AppCtx | null = useMemo(() => {
    if (!session) return null;
    return {
      api,
      client,
      inTelegram,
      session,
      profile,
      setProfile: (p: Profile) => {
        setProfileState(p);
        setSession((s) => (s ? { ...s, user: p.user, security: p.security, consent: p.consent } : s));
      },
      reloadProfile,
      setSecurity: (sec: SecurityState) => {
        setSession((s) => (s ? { ...s, security: sec } : s));
        setProfileState((p) => (p ? { ...p, security: sec } : p));
      },
      applySession: (s: SessionResponse) => {
        setSession(s);
        setProfileState((p) => (p ? { ...p, user: s.user, security: s.security, consent: s.consent } : p));
      },
      config,
      configSource,
      online,
      firstVisit,
      nav,
      navigate,
      lock: () => setPhase({ k: "locked" }),
      onboardingDone: () => {
        setSession((s) => (s ? { ...s, onboarding_completed: true } : s));
        deepLink.current = null;
        navigate({ type: "reset", stack: [{ name: "home" }] });
        setPhase({ k: "main" });
      },
      deletionAccepted: (r: DeletionResponse) => {
        resetCatalogMemory();
        watchStore.reset();
        aiStore.reset();
        rateLimits.reset();
        forgetSavedFilters(); // a deleted profile leaves no saved catalogue filters behind
        client.clear();
        client.forgetInitData();
        setPhase({ k: "deleted", r });
      },
    };
  }, [api, client, inTelegram, session, profile, reloadProfile, config, configSource, online, firstVisit, nav]);

  const onUnlocked = useCallback(
    (s: SessionResponse, message?: string) => {
      setSession(s);
      showToast(message ?? t("unlock"), message ? "key" : "lock");
      void enter({ ...s, security: { ...s.security, pin_required: false } });
    },
    [enter, t],
  );

  const changeLang = useCallback(
    (l: Lang) => {
      setLang(l);
      void api.profile.settings({ locale: l }).catch(() => undefined);
    },
    [api, setLang],
  );

  /* ---------- screen ---------- */
  let screen: React.ReactNode;
  let noScroll = false;
  let tabbar = false;
  switch (phase.k) {
    case "boot":
      screen = <Boot />;
      break;
    case "outside":
      screen = <OpenInTelegram dev={env.isDev} />;
      break;
    case "fatal":
      screen = <Fatal title={phase.title} text={phase.text} />;
      break;
    case "locked":
      noScroll = true;
      screen = <Lock onUnlocked={onUnlocked} />;
      break;
    case "onboarding":
      noScroll = true;
      screen = profile ? <Onboarding profile={profile} onLang={changeLang} /> : <Boot />;
      break;
    case "deleted":
      screen = <DeletionAccepted r={phase.r} />;
      break;
    default:
      screen = renderRoute(topRoute(nav));
      tabbar = !mainTop;
  }

  const body = (
    <div className="app" ref={appRef}>
      {!inTelegram && phase.k !== "outside" && <DevChrome />}
      <div className={tabbar ? "webview has-tabbar" : "webview"}>
        {!online && phase.k !== "outside" && (
          <NetBanner
            onRetry={() => {
              setOnline(true);
              loadConfig();
              if (phase.k === "fatal" || phase.k === "boot") void start();
              else setRefreshKey((n) => n + 1);
            }}
          />
        )}
        <main className={noScroll ? "vp locked" : "vp"} ref={vpRef} id="main">
          <div className={`scr enter-${nav.anim ?? "fade"}`} key={`${phase.k}-${nav.seq}-${refreshKey}`}>
            {screen}
          </div>
        </main>
        {tabbar && (
          <TabBar
            current={rootTab(nav)}
            atRoot={nav.stack.length === 1}
            critical={critical}
            onTab={(tab) => {
              if (nav.stack.length === 1 && nav.stack[0]!.name === tab) vpRef.current?.scrollTo({ top: 0, behavior: "smooth" });
              else navigate({ type: "tab", tab });
            }}
          />
        )}
        <div id={LAYERS_ID} />
        {phase.k === "main" && ctx && <AiChatHost />}
        <PopupHost />
        <ToastHost />
      </div>
      {showMainBar && <MainBar />}
    </div>
  );

  return ctx ? <AppContext.Provider value={ctx}>{body}</AppContext.Provider> : body;
}

function renderRoute(r: Route): React.ReactNode {
  switch (r.name) {
    case "home":
      return <Home />;
    case "catalog":
      return <Catalog />;
    case "watch":
      return <Watch />;
    case "news":
      return <News />;
    case "profile":
      return <ProfileScreen />;
    case "event":
      return <EventDetail id={r.id} />;
    case "supportNew":
      return <SupportNew ctx={r.ctx} />;
    case "supportList":
      return <SupportList />;
    case "supportThread":
      return <SupportThread id={r.id} />;
    case "supportDone":
      return <SupportDone id={r.id} number={r.number} />;
    default:
      return <Icon name="alert" />;
  }
}
