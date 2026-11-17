import type { TgHomeScreenStatus, TgWebApp } from "./types";
import { getWebApp, isInsideTelegram, supports } from "./webapp";

/**
 * «Добавить на главный экран» (Bot API 8.0+, core.telegram.org/bots/webapps#adding-mini-apps-to-the-home-screen).
 *  - status(): unsupported — добавить нельзя (вне Telegram, клиент < 8.0, desktop/web, нет метода, нет ответа);
 *    unknown — добавить можно, но установлена ли иконка, клиент не знает; added — уже добавлено; missed — не добавлено.
 *  - add(): показывает системный запрос. homeScreenAdded приходит, только если устройство умеет это определить,
 *    поэтому ждём его не дольше таймаута, а при возврате в приложение (activated) перепроверяем статус и сразу
 *    завершаем: added → "added", иначе (диалог отменён, статус неизвестен) → "unknown".
 *    Итог: "added" — иконка точно добавлена; "unknown" — неизвестно (пользователь отказался или устройство молчит).
 * Подписки снимаются всегда (успех, таймаут, исключение). Вне Telegram и на старых клиентах — безопасный no-op.
 */
export type HomeScreenStatus = TgHomeScreenStatus;
export type HomeScreenAddResult = "added" | "unknown" | "unsupported";

export const HOME_SCREEN_MIN_VERSION = "8.0";
export const HOME_SCREEN_STATUS_TIMEOUT_MS = 3000;
export const HOME_SCREEN_ADD_TIMEOUT_MS = 30_000;

const STATUSES: ReadonlySet<string> = new Set(["unsupported", "unknown", "added", "missed"]);

function api(): TgWebApp | null {
  const wa = getWebApp();
  if (!wa || !isInsideTelegram() || !supports(HOME_SCREEN_MIN_VERSION)) return null;
  if (typeof wa.addToHomeScreen !== "function" || typeof wa.checkHomeScreenStatus !== "function") return null;
  return wa;
}

/** Можно ли вообще предлагать добавление (без запроса статуса). */
export function homeScreenSupported(): boolean {
  return api() !== null;
}

function statusOf(payload: unknown): HomeScreenStatus | null {
  const s = typeof payload === "string" ? payload : (payload as { status?: unknown } | null | undefined)?.status;
  return typeof s === "string" && STATUSES.has(s) ? (s as HomeScreenStatus) : null;
}

/** Текущий статус. Нет ответа за timeoutMs — "unsupported" (не предлагаем то, что клиент, возможно, не выполнит). */
export function homeScreenStatus(timeoutMs = HOME_SCREEN_STATUS_TIMEOUT_MS): Promise<HomeScreenStatus> {
  const wa = api();
  if (!wa) return Promise.resolve("unsupported");
  return new Promise((resolve) => {
    let done = false;
    const onChecked = (p?: unknown) => {
      const s = statusOf(p);
      if (s) finish(s);
    };
    const finish = (s: HomeScreenStatus) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        wa.offEvent("homeScreenChecked", onChecked);
      } catch {
        /* ignore */
      }
      resolve(s);
    };
    const timer = setTimeout(() => finish("unsupported"), timeoutMs);
    try {
      wa.onEvent("homeScreenChecked", onChecked);
      wa.checkHomeScreenStatus!((s) => finish(statusOf(s) ?? "unknown"));
    } catch {
      finish("unsupported");
    }
  });
}

/** Системный запрос «Добавить на главный экран». */
export function addToHomeScreen(timeoutMs = HOME_SCREEN_ADD_TIMEOUT_MS): Promise<HomeScreenAddResult> {
  const wa = api();
  if (!wa) return Promise.resolve("unsupported");
  return new Promise((resolve) => {
    let done = false;
    const onAdded = () => finish("added");
    const onChecked = (p?: unknown) => {
      if (statusOf(p) === "added") finish("added");
    };
    // пользователь вернулся из системного диалога: если событие не пришло, спросим статус сами. Не added (отменил
    // диалог, устройство не знает) — завершаем сразу «unknown», а не ждём таймаут: кнопки не висят 30 с (ревью 9.4)
    const onActivated = () => {
      void homeScreenStatus().then((s) => finish(s === "added" ? "added" : "unknown"));
    };
    const finish = (r: HomeScreenAddResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const [ev, fn] of [
        ["homeScreenAdded", onAdded],
        ["homeScreenChecked", onChecked],
        ["activated", onActivated],
      ] as const) {
        try {
          wa.offEvent(ev, fn);
        } catch {
          /* ignore */
        }
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish("unknown"), timeoutMs);
    try {
      wa.onEvent("homeScreenAdded", onAdded);
      wa.onEvent("homeScreenChecked", onChecked);
      wa.onEvent("activated", onActivated);
      wa.addToHomeScreen!();
    } catch {
      finish("unknown");
    }
  });
}
