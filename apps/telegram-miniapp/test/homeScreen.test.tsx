/**
 * «На главный экран» (Bot API 8.0): src/tg/homeScreen.ts и строка Профиля. Тесты перенесены из aievent
 * (test/s94.test.tsx: «tg/homeScreen — Bot API 8.0», «Профиль: строка», ревью 9.4 п.2) и адаптированы под тексты
 * TilHero; карточки на Главной в TilHero нет. Добавлен случай homeScreenFailed.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n";
import { ru } from "../src/i18n/ru";
import { uz } from "../src/i18n/uz";
import { HomeScreenRow, resetHomeScreenForTests } from "../src/screens/homescreen/HomeScreen";
import { addToHomeScreen, homeScreenStatus, homeScreenSupported } from "../src/tg";
import { ToastHost } from "../src/ui/overlays";
import { installTg, listenerCount, uninstallTg } from "./tgFake";

beforeEach(() => {
  resetHomeScreenForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  uninstallTg();
});

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

  it("add: homeScreenFailed → unknown сразу, без таймаута (TilHero)", async () => {
    const tg = installTg({ onAdd: "failed" });
    const t0 = Date.now();
    expect(await addToHomeScreen(5000)).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(listenerCount(tg)).toBe(0);
  });

  it("ревью 9.4 п.2: отмена диалога — activated + missed → unknown сразу, без таймаута", async () => {
    const tg = installTg({ onAdd: "silent", status: "missed" });
    const t0 = Date.now();
    const p = addToHomeScreen(1500);
    setTimeout(() => tg.emit("activated"), 5);
    expect(await p).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(listenerCount(tg)).toBe(0);
  });
});

function renderRow(lang: "ru" | "uz" = "ru") {
  return render(
    <I18nProvider initial={lang}>
      <div className="list">
        <HomeScreenRow />
      </div>
      <ToastHost />
    </I18nProvider>,
  );
}
const tick = () => act(async () => new Promise((r) => setTimeout(r, 10)));

describe("Профиль: строка «На главный экран»", () => {
  it("вне Telegram / 7.10 / unsupported / нет addToHomeScreen — строки нет", async () => {
    renderRow();
    await tick();
    expect(screen.queryByTestId("hs-row")).toBeNull();
    for (const o of [{ version: "7.10" }, { status: "unsupported" as const }, { methods: false }]) {
      cleanup();
      resetHomeScreenForTests();
      installTg(o);
      renderRow();
      await tick();
      expect(screen.queryByTestId("hs-row")).toBeNull();
      expect(screen.queryByTestId("hs-row-added")).toBeNull();
    }
  });

  it("при открытии статус запрашивается один раз за запуск", async () => {
    const tg = installTg({ status: "missed" });
    renderRow();
    await screen.findByTestId("hs-row");
    cleanup();
    renderRow();
    await screen.findByTestId("hs-row");
    expect(tg.calls.filter((c) => c[0] === "checkHomeScreenStatus")).toHaveLength(1);
  });

  it("added — значение «добавлено», не кнопка", async () => {
    installTg({ status: "added" });
    renderRow();
    const row = await screen.findByTestId("hs-row-added");
    expect(row.tagName).toBe("DIV");
    expect(row).toHaveTextContent("На главный экран");
    expect(row).toHaveTextContent("добавлено");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("missed → кнопка; homeScreenAdded → тост «Иконка TilHero на главном экране» и «добавлено»", async () => {
    const tg = installTg({ status: "missed" });
    renderRow();
    const btn = await screen.findByRole("button", { name: /На главный экран/ });
    expect(btn).toHaveTextContent("Открывать TilHero одной кнопкой, без поиска бота");
    fireEvent.click(btn);
    expect(await screen.findByTestId("toast")).toHaveTextContent("Иконка TilHero на главном экране");
    await screen.findByTestId("hs-row-added");
    expect(tg.added).toBe(1);
  });

  it("unknown и событие не пришло — строка остаётся действием, без «успеха»", async () => {
    const tg = installTg({ status: "unknown", onAdd: "silent" });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRow();
    const btn = await screen.findByTestId("hs-row");
    fireEvent.click(btn);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(screen.getByTestId("hs-row")).toBeInTheDocument();
    expect(screen.queryByTestId("hs-row-added")).toBeNull();
    const haptics = (tg.wa.HapticFeedback as { notificationOccurred: ReturnType<typeof vi.fn> }).notificationOccurred;
    expect(haptics).not.toHaveBeenCalled();
  });

  it("UZ: «Bosh ekranga qoʻshish»", async () => {
    installTg({ status: "missed" });
    renderRow("uz");
    expect(await screen.findByTestId("hs-row")).toHaveTextContent("Bosh ekranga qoʻshish");
  });

  it("тексты RU/UZ на месте", () => {
    for (const k of ["hs.row", "hs.row.sub", "hs.row.added", "hs.toast"] as const) {
      expect(ru[k]).toBeTruthy();
      expect(uz[k]).toBeTruthy();
    }
    expect(ru["hs.row"]).toBe("На главный экран");
    expect(uz["hs.row"]).toBe("Bosh ekranga qoʻshish");
    expect(ru["hs.toast"]).toBe("Иконка TilHero на главном экране");
  });
});
