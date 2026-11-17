/**
 * 9.4: «Добавить на главный экран» (src/tg/homeScreen.ts, строка Профиля, карточка Главной) и «Что нового»
 * (шторка, отметка «просмотрено», ссылки только из белого списка, тексты только как текст).
 */
import type { ReleaseNote } from "@tilhero/contracts/bff";
import { RELEASE_NOTE_ICONS, RELEASE_NOTE_ROUTES } from "@tilhero/contracts/bff";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api/endpoints";
import { en } from "../src/i18n/en";
import { I18nProvider } from "../src/i18n";
import { ru } from "../src/i18n/ru";
import { HomeScreenCard, HomeScreenRow, resetHomeScreenForTests, setPromptStoreForTests } from "../src/screens/homescreen/HomeScreen";
import { WhatsNewRow, WhatsNewSheet, useAutoWhatsNew } from "../src/screens/whatsnew/WhatsNew";
import { AppContext, type AppCtx } from "../src/state/app";
import {
  EMPTY,
  MAX_SHOWS,
  MIN_LAUNCHES,
  PROMPT_KEY,
  PromptStore,
  SNOOZE_MS,
  mergePrompt,
  parsePrompt,
  resetPromptLaunchForTests,
  shouldShowPrompt,
  type PromptState,
} from "../src/state/homeScreenPrompt";
import { markWhatsNewSeen, resetWhatsNewForTests, routeAction, unseenAfterLaunchMark, wnLaunch } from "../src/state/whatsNew";
import { ApiClient } from "../src/api/client";
import { createApi } from "../src/api/endpoints";
import { addToHomeScreen, homeScreenStatus, homeScreenSupported, mainButtonStore, type KvStore } from "../src/tg";
import type { TgHomeScreenStatus } from "../src/tg/types";
import { Icon } from "../src/ui/Icon";

/* ---------------------------------------------------------------- fake Telegram */

type Handler = (p?: unknown) => void;
interface FakeTg {
  version: string;
  status: TgHomeScreenStatus | null; // null — клиент не отвечает
  /** что сделает addToHomeScreen: событие homeScreenAdded / ничего / только homeScreenChecked */
  onAdd: "event" | "silent" | "checked" | "throw";
  handlers: Map<string, Set<Handler>>;
  added: number;
  emit(ev: string, p?: unknown): void;
}

function installTg(o: Partial<Pick<FakeTg, "version" | "status" | "onAdd">> & { initData?: string; methods?: boolean } = {}): FakeTg {
  const tg: FakeTg = {
    version: o.version ?? "8.0",
    status: o.status === undefined ? "missed" : o.status,
    onAdd: o.onAdd ?? "event",
    handlers: new Map(),
    added: 0,
    emit(ev, p) {
      for (const h of [...(this.handlers.get(ev) ?? [])]) h(p);
    },
  };
  const cmp = (a: string, b: string) => {
    const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
    for (let i = 0; i < 2; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  const wa: Record<string, unknown> = {
    initData: o.initData ?? "query_id=1&hash=abc",
    initDataUnsafe: {},
    version: tg.version,
    platform: "android",
    isVersionAtLeast: (v: string) => cmp(tg.version, v) >= 0,
    onEvent: (ev: string, h: Handler) => {
      if (!tg.handlers.has(ev)) tg.handlers.set(ev, new Set());
      tg.handlers.get(ev)!.add(h);
    },
    offEvent: (ev: string, h: Handler) => tg.handlers.get(ev)?.delete(h),
    MainButton: { setParams: vi.fn(), onClick: vi.fn(), offClick: vi.fn(), show: vi.fn(), hide: vi.fn(), showProgress: vi.fn(), hideProgress: vi.fn() },
    BackButton: { onClick: vi.fn(), offClick: vi.fn(), show: vi.fn(), hide: vi.fn() },
    HapticFeedback: { impactOccurred: vi.fn(), notificationOccurred: vi.fn(), selectionChanged: vi.fn() },
  };
  if (o.methods !== false) {
    wa.checkHomeScreenStatus = (cb?: (s: TgHomeScreenStatus) => void) => {
      if (tg.status !== null) setTimeout(() => cb?.(tg.status!), 0);
    };
    wa.addToHomeScreen = () => {
      if (tg.onAdd === "throw") throw new Error("WebAppMethodUnsupported");
      if (tg.onAdd === "silent") return;
      tg.added += 1;
      tg.status = "added";
      setTimeout(() => (tg.onAdd === "event" ? tg.emit("homeScreenAdded") : tg.emit("homeScreenChecked", { status: "added" })), 0);
    };
  }
  (window as unknown as { Telegram: unknown }).Telegram = { WebApp: wa };
  return tg;
}

const listenerCount = (tg: FakeTg) => [...tg.handlers.values()].reduce((n, s) => n + s.size, 0);

function memStore(kind: KvStore["kind"], init: Record<string, string> = {}): KvStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    kind,
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
  };
}

beforeEach(() => {
  resetHomeScreenForTests();
  resetPromptLaunchForTests();
  resetWhatsNewForTests();
  setPromptStoreForTests(null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { Telegram?: unknown }).Telegram;
});

/* ---------------------------------------------------------------- tg/homeScreen */

describe("tg/homeScreen — Bot API 8.0", () => {
  it("вне Telegram и на клиенте 7.10 — unsupported без вызовов", async () => {
    expect(homeScreenSupported()).toBe(false);
    expect(await homeScreenStatus()).toBe("unsupported");
    expect(await addToHomeScreen()).toBe("unsupported");
    const old = installTg({ version: "7.10" });
    expect(homeScreenSupported()).toBe(false);
    expect(await homeScreenStatus()).toBe("unsupported");
    expect(await addToHomeScreen()).toBe("unsupported");
    expect(old.added).toBe(0);
    // telegram-web-app.js вне Telegram: WebApp есть, initData пустая
    installTg({ initData: "" });
    expect(await homeScreenStatus()).toBe("unsupported");
    // 8.0, но клиент без методов
    installTg({ methods: false });
    expect(await homeScreenStatus()).toBe("unsupported");
  });

  it.each(["unsupported", "unknown", "added", "missed"] as const)("8.0: статус %s", async (status) => {
    const tg = installTg({ status });
    expect(homeScreenSupported()).toBe(true);
    expect(await homeScreenStatus()).toBe(status);
    expect(listenerCount(tg)).toBe(0); // подписка на homeScreenChecked снята
  });

  it("статус через событие homeScreenChecked; нет ответа — unsupported по таймауту, подписки сняты", async () => {
    const tg = installTg({ status: null });
    const p = homeScreenStatus(50);
    tg.emit("homeScreenChecked", { status: "unknown" });
    expect(await p).toBe("unknown");
    expect(await homeScreenStatus(30)).toBe("unsupported");
    expect(listenerCount(tg)).toBe(0);
  });

  it("add: событие homeScreenAdded пришло → added, подписки сняты", async () => {
    const tg = installTg({ onAdd: "event" });
    expect(await addToHomeScreen(1000)).toBe("added");
    expect(tg.added).toBe(1);
    expect(listenerCount(tg)).toBe(0);
  });

  it("add: только homeScreenChecked {added} → added", async () => {
    installTg({ onAdd: "checked" });
    expect(await addToHomeScreen(1000)).toBe("added");
  });

  it("add: событие не пришло → unknown по таймауту; при возврате (activated) статус перепроверяется", async () => {
    const tg = installTg({ onAdd: "silent", status: "unknown" });
    expect(await addToHomeScreen(40)).toBe("unknown");
    expect(listenerCount(tg)).toBe(0);
    const p = addToHomeScreen(2000);
    tg.status = "added";
    tg.emit("activated");
    expect(await p).toBe("added");
    expect(listenerCount(tg)).toBe(0);
  });

  it("add: исключение клиента → unknown, без утечки подписок", async () => {
    const tg = installTg({ onAdd: "throw" });
    expect(await addToHomeScreen(1000)).toBe("unknown");
    expect(listenerCount(tg)).toBe(0);
  });
});

/* ---------------------------------------------------------------- правила карточки */

describe("карточка на Главной — правила показа", () => {
  const st = (p: Partial<PromptState> = {}): PromptState => ({ ...EMPTY, launches: MIN_LAUNCHES, ...p });
  const now = 1_800_000_000_000;

  it("3-й запуск, missed/unknown; не added/unsupported; максимум 2 показа; пауза 30 дней; после добавления — никогда", () => {
    expect(shouldShowPrompt(st({ launches: 2 }), "missed", now)).toBe(false);
    expect(shouldShowPrompt(st(), "missed", now)).toBe(true);
    expect(shouldShowPrompt(st(), "unknown", now)).toBe(true);
    expect(shouldShowPrompt(st(), "added", now)).toBe(false);
    expect(shouldShowPrompt(st(), "unsupported", now)).toBe(false);
    expect(shouldShowPrompt(st({ shown: MAX_SHOWS }), "missed", now)).toBe(false);
    expect(shouldShowPrompt(st({ shown: 1, snoozed_until: now + 1 }), "missed", now)).toBe(false);
    expect(shouldShowPrompt(st({ shown: 1, snoozed_until: now - SNOOZE_MS }), "missed", now)).toBe(true);
    expect(shouldShowPrompt(st({ done: true }), "missed", now)).toBe(false);
  });

  it("разбор и слияние копий CloudStorage/localStorage устойчивы к мусору", () => {
    expect(parsePrompt("not json")).toEqual(EMPTY);
    expect(parsePrompt('{"launches":-1,"shown":"2","snoozed_until":"x","done":"yes"}')).toEqual(EMPTY);
    expect(mergePrompt({ launches: 5, shown: 0, snoozed_until: null, done: false }, { launches: 2, shown: 2, snoozed_until: 10, done: true })).toEqual({
      launches: 5,
      shown: 2,
      snoozed_until: 10,
      done: true,
    });
  });

  it("PromptStore: пишет в обе копии, читает «дальшую»; ключ — допустимый для CloudStorage", async () => {
    expect(PROMPT_KEY).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    const cloud = memStore("cloud");
    const local = memStore("local", { [PROMPT_KEY]: JSON.stringify({ launches: 4, shown: 1, snoozed_until: null, done: false }) });
    const s = new PromptStore(cloud, local);
    expect(await s.load()).toMatchObject({ launches: 4, shown: 1 });
    await s.update((p) => ({ ...p, done: true }));
    expect(JSON.parse(cloud.data.get(PROMPT_KEY)!)).toMatchObject({ launches: 4, done: true });
    expect(JSON.parse(local.data.get(PROMPT_KEY)!)).toMatchObject({ done: true });
    // одна копия «сломана» (бросает) — работает по другой
    const broken: KvStore = { kind: "cloud", get: () => Promise.reject(new Error("x")), set: () => Promise.reject(new Error("x")), remove: async () => undefined };
    const s2 = new PromptStore(broken, local);
    expect(await s2.load()).toMatchObject({ done: true });
    await expect(s2.save({ ...EMPTY })).resolves.toBeUndefined();
  });
});

/* ---------------------------------------------------------------- UI: строка и карточка */

function withApp(ui: React.ReactNode, api: Partial<Api> = {}, navigate = vi.fn(), lang: "ru" | "en" = "ru") {
  const ctx = { api: { whatsNew: { get: vi.fn(async () => ({ items: [], latest: null })), seen: vi.fn(async () => ({ last_seen_release_note_id: null })) }, ...api }, navigate } as unknown as AppCtx;
  return render(
    <I18nProvider initial={lang}>
      <AppContext.Provider value={ctx}>{ui}</AppContext.Provider>
    </I18nProvider>,
  );
}

describe("Профиль: строка «Добавить на главный экран»", () => {
  it("вне Telegram / 7.10 / unsupported — строки нет", async () => {
    withApp(<HomeScreenRow />);
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(screen.queryByTestId("hs-row")).toBeNull();
    cleanup();
    resetHomeScreenForTests();
    installTg({ version: "7.10" });
    withApp(<HomeScreenRow />);
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(screen.queryByTestId("hs-row")).toBeNull();
    cleanup();
    resetHomeScreenForTests();
    installTg({ status: "unsupported" });
    withApp(<HomeScreenRow />);
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(screen.queryByTestId("hs-row")).toBeNull();
  });

  it("added — «Уже на главном экране», не кнопка", async () => {
    installTg({ status: "added" });
    withApp(<HomeScreenRow />);
    const row = await screen.findByTestId("hs-row-added");
    expect(row.tagName).toBe("DIV");
    expect(row).toHaveTextContent("Уже на главном экране");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("missed → кнопка; homeScreenAdded → тост и статус «Уже на главном экране»", async () => {
    const store = new PromptStore(memStore("cloud"), memStore("local"));
    setPromptStoreForTests(store);
    const tg = installTg({ status: "missed" });
    render(
      <I18nProvider initial="ru">
        <AppContext.Provider value={{ api: {}, navigate: vi.fn() } as unknown as AppCtx}>
          <HomeScreenRow />
        </AppContext.Provider>
      </I18nProvider>,
    );
    const btn = await screen.findByRole("button", { name: /Добавить на главный экран/ });
    expect(btn).toHaveTextContent("открывать TilHero одной кнопкой, без поиска бота");
    fireEvent.click(btn);
    await screen.findByTestId("hs-row-added");
    expect(tg.added).toBe(1);
    await waitFor(async () => expect((await store.load()).done).toBe(true));
  });

  it("unknown и событие не пришло — строка остаётся действием, без тоста", async () => {
    installTg({ status: "unknown", onAdd: "silent" });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    withApp(<HomeScreenRow />);
    const btn = await screen.findByTestId("hs-row");
    fireEvent.click(btn);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(screen.getByTestId("hs-row")).toBeInTheDocument();
    expect(screen.queryByTestId("hs-row-added")).toBeNull();
  });
});

describe("Главная: карточка-предложение", () => {
  const seeded = (p: Partial<PromptState>) => {
    const cloud = memStore("cloud", { [PROMPT_KEY]: JSON.stringify({ ...EMPTY, ...p }) });
    const local = memStore("local");
    const store = new PromptStore(cloud, local);
    setPromptStoreForTests(store);
    return { store, cloud };
  };

  it("2-й запуск — нет; 3-й — да, показ засчитан; «Не сейчас» — пауза 30 дней", async () => {
    installTg({ status: "missed" });
    const { store } = seeded({ launches: 1 });
    withApp(<HomeScreenCard />);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByTestId("hs-card")).toBeNull();
    expect((await store.load()).launches).toBe(2);

    cleanup();
    resetPromptLaunchForTests();
    resetHomeScreenForTests();
    withApp(<HomeScreenCard />);
    const card = await screen.findByTestId("hs-card");
    expect(card.tagName).toBe("SECTION");
    expect(card).toHaveAccessibleName("TilHero — на главный экран");
    await waitFor(async () => expect((await store.load()).shown).toBe(1));
    const before = Date.now();
    fireEvent.click(screen.getByRole("button", { name: "Не сейчас" }));
    expect(screen.queryByTestId("hs-card")).toBeNull();
    await waitFor(async () => expect((await store.load()).snoozed_until).toBeGreaterThanOrEqual(before + SNOOZE_MS));
  });

  it("повторный заход на Главную в том же запуске не засчитывает второй показ", async () => {
    installTg({ status: "unknown" });
    const { store } = seeded({ launches: 5 });
    withApp(<HomeScreenCard />);
    await screen.findByTestId("hs-card");
    cleanup();
    withApp(<HomeScreenCard />);
    await screen.findByTestId("hs-card");
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect((await store.load()).shown).toBe(1);
  });

  it("added / unsupported / 2 показа уже были — никогда", async () => {
    for (const [status, p] of [
      ["added", {}],
      ["unsupported", {}],
      ["missed", { shown: 2 }],
    ] as const) {
      cleanup();
      resetPromptLaunchForTests();
      resetHomeScreenForTests();
      installTg({ status });
      seeded({ launches: 9, ...p });
      withApp(<HomeScreenCard />);
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      expect(screen.queryByTestId("hs-card")).toBeNull();
    }
  });

  it("«Добавить» → homeScreenAdded → карточка скрыта, больше не предлагается", async () => {
    installTg({ status: "missed" });
    const { store } = seeded({ launches: 3 });
    withApp(<HomeScreenCard />);
    fireEvent.click(await screen.findByTestId("hs-card-add"));
    await waitFor(() => expect(screen.queryByTestId("hs-card")).toBeNull());
    await waitFor(async () => expect((await store.load()).done).toBe(true));
  });
});

/* ---------------------------------------------------------------- «Что нового» */

const NOTE = (o: Partial<ReleaseNote> = {}): ReleaseNote => ({
  release_note_id: "00000000-0000-4000-8000-000000000001",
  slug: "2026.11",
  title: { ru: "Ноябрь 2026", en: "November 2026" },
  items: [
    { title: { ru: "Больше событий в Алматы", en: "More events in Almaty" }, text: { ru: "Собираем афишу.", en: "Listings." }, link: "catalog", icon: "pin" },
    { title: { ru: "TilHero на главном экране", en: "TilHero on your Home Screen" }, text: { ru: "Кнопка — в Профиле.", en: "In Profile." }, link: "profile", icon: "phone" },
    { title: { ru: "Без ссылки", en: "No link" }, text: { ru: "Просто текст.", en: "Just text." }, link: null, icon: null },
  ],
  published_at: "2026-11-10T06:00:00.000Z",
  ...o,
});

describe("«Что нового»", () => {
  it("белые списки и иконки Mini App = packages/contracts/release-notes.json", () => {
    const cat = JSON.parse(readFileSync(join(__dirname, "../../../packages/contracts/release-notes.json"), "utf8")) as { routes: string[]; icons: string[] };
    expect([...RELEASE_NOTE_ROUTES]).toEqual(cat.routes);
    expect([...RELEASE_NOTE_ICONS]).toEqual(cat.icons);
    for (const r of cat.routes) expect(routeAction(r)).not.toBeNull();
    for (const bad of ["javascript:alert(1)", "https://evil.example", "event", null]) expect(routeAction(bad)).toBeNull();
    for (const i of cat.icons) expect(() => render(<Icon name={i as never} />)).not.toThrow();
  });

  it("шторка: заголовок, пункты с иконками, «Посмотреть» только у пунктов со ссылкой, MainButton «Понятно»", async () => {
    const seen = vi.fn(async () => ({ last_seen_release_note_id: NOTE().release_note_id }));
    const onClose = vi.fn();
    withApp(<WhatsNewSheet notes={[NOTE()]} onClose={onClose} />, { whatsNew: { get: vi.fn(), seen } } as unknown as Partial<Api>);
    const dialog = await screen.findByRole("dialog", { name: /Что нового в TilHero/ });
    expect(dialog).toHaveTextContent("Ноябрь 2026");
    expect(dialog).toHaveTextContent("Больше событий в Алматы");
    expect(screen.getAllByTestId("wn-view")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Посмотреть: Больше событий в Алматы" })).toBeInTheDocument();
    expect(mainButtonStore.top()?.text).toBe("Понятно");
    act(() => mainButtonStore.top()!.onClick());
    expect(onClose).toHaveBeenCalled();
    expect(seen).toHaveBeenCalledWith(NOTE().release_note_id);
  });

  it("«Посмотреть» → закрыть (просмотрено) и перейти по маршруту", async () => {
    const navigate = vi.fn();
    const seen = vi.fn(async () => ({ last_seen_release_note_id: "x" }));
    withApp(<WhatsNewSheet notes={[NOTE()]} onClose={vi.fn()} />, { whatsNew: { get: vi.fn(), seen } } as unknown as Partial<Api>, navigate);
    fireEvent.click(screen.getByRole("button", { name: "Посмотреть: TilHero на главном экране" }));
    expect(navigate).toHaveBeenCalledWith({ type: "tab", tab: "profile" });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("несколько заметок — одна шторка, отметка по самой новой; EN", async () => {
    const seen = vi.fn(async () => ({ last_seen_release_note_id: "x" }));
    const newer = NOTE({ release_note_id: "00000000-0000-4000-8000-000000000002", title: { ru: "Декабрь 2026", en: "December 2026" }, published_at: "2026-12-01T06:00:00.000Z" });
    withApp(<WhatsNewSheet notes={[newer, NOTE()]} onClose={vi.fn()} />, { whatsNew: { get: vi.fn(), seen } } as unknown as Partial<Api>, vi.fn(), "en");
    const dialog = await screen.findByRole("dialog", { name: /What's new in TilHero/ });
    expect(dialog).toHaveTextContent("Changes from 2 releases");
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([expect.stringContaining("December 2026"), expect.stringContaining("November 2026")]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(seen).toHaveBeenCalledWith(newer.release_note_id);
  });

  it("XSS: разметка в заметке выводится как текст", async () => {
    const xss = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    const n = NOTE({ title: { ru: xss, en: xss }, items: [{ title: { ru: xss, en: xss }, text: { ru: xss, en: xss }, link: null, icon: "skull" as never }] });
    withApp(<WhatsNewSheet notes={[n]} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("img, script")).toBeNull();
    expect(dialog).toHaveTextContent('<img src=x onerror="window.__xss=1">');
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  function Auto({ ready }: { ready: boolean }) {
    return <>{useAutoWhatsNew(ready)}</>;
  }

  it("сама — после загрузки Главной и не чаще раза за запуск; пусто/ошибка — ничего", async () => {
    const get = vi.fn(async () => ({ items: [NOTE()], latest: NOTE() }));
    const api = { whatsNew: { get, seen: vi.fn(async () => ({ last_seen_release_note_id: null })) } } as unknown as Partial<Api>;
    const r = withApp(<Auto ready={false} />, api);
    await act(async () => new Promise((res) => setTimeout(res, 10)));
    expect(get).not.toHaveBeenCalled();
    r.rerender(
      <I18nProvider initial="ru">
        <AppContext.Provider value={{ api, navigate: vi.fn() } as unknown as AppCtx}>
          <Auto ready />
        </AppContext.Provider>
      </I18nProvider>,
    );
    await screen.findByTestId("whats-new");
    expect(wnLaunch.autoShown).toBe(true);
    cleanup();
    withApp(<Auto ready />, api);
    await act(async () => new Promise((res) => setTimeout(res, 10)));
    expect(screen.queryByTestId("whats-new")).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);

    cleanup();
    resetWhatsNewForTests();
    withApp(<Auto ready />, { whatsNew: { get: vi.fn(async () => Promise.reject(new Error("503"))), seen: vi.fn() } } as unknown as Partial<Api>);
    await act(async () => new Promise((res) => setTimeout(res, 10)));
    expect(screen.queryByTestId("whats-new")).toBeNull();
  });

  it("Профиль: «Что нового» открывает последнюю заметку; заметок нет — тост, без шторки", async () => {
    const get = vi.fn(async () => ({ items: [], latest: NOTE() }));
    withApp(<WhatsNewRow />, { whatsNew: { get, seen: vi.fn(async () => ({ last_seen_release_note_id: null })) } } as unknown as Partial<Api>);
    const row = await screen.findByTestId("wn-row");
    await waitFor(() => expect(row).toHaveTextContent("Ноябрь 2026"));
    fireEvent.click(row);
    await screen.findByTestId("whats-new");
    cleanup();
    resetWhatsNewForTests();
    withApp(<WhatsNewRow />, { whatsNew: { get: vi.fn(async () => ({ items: [], latest: null })), seen: vi.fn() } } as unknown as Partial<Api>);
    const empty = await screen.findByTestId("wn-row");
    expect(empty).toHaveTextContent("последние изменения в приложении");
    fireEvent.click(empty);
    await act(async () => new Promise((res) => setTimeout(res, 10)));
    expect(screen.queryByTestId("whats-new")).toBeNull();
  });

  it("тексты RU/EN на месте", () => {
    for (const k of ["hs.row", "hs.row.sub", "hs.row.added", "hs.toast", "hs.card.t", "hs.card.add", "hs.card.later", "wn.h", "wn.ok", "wn.view", "p.wn"] as const) {
      expect(ru[k]).toBeTruthy();
      expect(en[k]).toBeTruthy();
    }
    expect(ru["hs.row"]).toBe("Добавить на главный экран");
    expect(ru["hs.toast"]).toBe("Иконка TilHero добавлена на главный экран");
    expect(ru["hs.row.added"]).toBe("Уже на главном экране");
  });
});


/* ---------------------------------------------------------------- ревью 9.4 */

describe("ревью 9.4", () => {
  it("п.2 (scratchpad/rev94repro/unit/hs_cancel.test.ts): отмена диалога — activated + missed → unknown сразу, без таймаута", async () => {
    const tg = installTg({ onAdd: "silent", status: "missed" });
    const t0 = Date.now();
    const p = addToHomeScreen(1500);
    setTimeout(() => tg.emit("activated"), 5);
    expect(await p).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(listenerCount(tg)).toBe(0);
  });

  it("п.2/п.7: карточка — «Добавить» вторичная (не лаймовая), «Не сейчас» доступна, пока открыт системный диалог", async () => {
    installTg({ status: "missed", onAdd: "silent" });
    const store = new PromptStore(memStore("cloud", { [PROMPT_KEY]: JSON.stringify({ ...EMPTY, launches: 3 }) }), memStore("local"));
    setPromptStoreForTests(store);
    withApp(<HomeScreenCard />);
    const add = await screen.findByTestId("hs-card-add");
    expect(add).toHaveClass("btn-soft");
    expect(add).not.toHaveClass("btn-lime");
    fireEvent.click(add);
    expect(add).toBeDisabled();
    const later = screen.getByTestId("hs-card-later");
    expect(later).not.toBeDisabled();
    fireEvent.click(later);
    expect(screen.queryByTestId("hs-card")).toBeNull();
    await waitFor(async () => expect((await store.load()).snoozed_until).not.toBeNull());
  });

  it("п.1: запросы «Что нового» тихие — 503 и обрыв сети не включают баннер «Нет связи»", async () => {
    const onConnectivity = vi.fn();
    let mode: "503" | "net" | "ok" = "503";
    const fetchImpl = vi.fn(async () => {
      if (mode === "net") throw new TypeError("Failed to fetch");
      if (mode === "503")
        return new Response(JSON.stringify({ code: "UPSTREAM_UNAVAILABLE", message: "x", trace_id: "t", details: { service: "experience-config" } }), { status: 503 });
      return new Response(JSON.stringify({ items: [], latest: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "https://bff.test", fetchImpl, storage: null, hooks: { onConnectivity } });
    const api = createApi(client);
    await expect(api.whatsNew.get()).rejects.toMatchObject({ status: 503 });
    await expect(api.whatsNew.seen("x")).rejects.toMatchObject({ status: 503 });
    mode = "net";
    await expect(api.whatsNew.get()).rejects.toMatchObject({ code: "NETWORK" });
    mode = "ok";
    await api.whatsNew.get();
    expect(onConnectivity).not.toHaveBeenCalled();
    // обычные запросы — как раньше
    mode = "503";
    await expect(client.request("GET", "/v1/home")).rejects.toBeTruthy();
    expect(onConnectivity).toHaveBeenCalledWith(false);
  });

  it("п.3: заметка, закрытая в Профиле, не всплывает на Главной в том же запуске (и данные перечитываются)", async () => {
    const get = vi.fn(async () => ({ items: [NOTE()], latest: NOTE() }));
    const seen = vi.fn(async () => ({ last_seen_release_note_id: NOTE().release_note_id }));
    const api = { whatsNew: { get, seen } } as unknown as Api;
    markWhatsNewSeen(api as never, [NOTE()]);
    expect(seen).toHaveBeenCalledWith(NOTE().release_note_id);
    expect(unseenAfterLaunchMark([NOTE()])).toEqual([]);
    const newer = NOTE({ release_note_id: "00000000-0000-4000-8000-000000000009", published_at: "2026-12-01T06:00:00.000Z" });
    expect(unseenAfterLaunchMark([newer, NOTE()])).toEqual([newer]);
    function Auto() {
      return <>{useAutoWhatsNew(true)}</>;
    }
    withApp(<Auto />, { whatsNew: { get, seen } } as unknown as Partial<Api>);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(get).toHaveBeenCalledTimes(1); // данные сброшены после отметки — запрос свежий
    expect(screen.queryByTestId("whats-new")).toBeNull();
    // отметка не сохранилась на сервере — в этом запуске всё равно не повторяем
    resetWhatsNewForTests();
    const failing = { whatsNew: { get, seen: vi.fn(async () => Promise.reject(new Error("503"))) } } as unknown as Api;
    markWhatsNewSeen(failing as never, [NOTE()]);
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(unseenAfterLaunchMark([NOTE()])).toEqual([]);
  });
});
