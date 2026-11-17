/**
 * 9.4 «Что нового»: заметки о релизах приложения (не «Пока вас не было» — то изменения событий).
 * Шторка открывается сама не чаще раза за запуск — на Главной после загрузки (не поверх онбординга, PIN и deep link
 * на событие: Главная тогда не открыта, шторка покажется при возврате на неё). Закрытие = просмотрено (на сервере).
 */
import type { ReleaseNote, ReleaseNoteRoute, WhatsNewResponse } from "@tilhero/contracts/bff";
import type { createApi } from "../api/endpoints";
import type { NavAction } from "./nav";

type Api = ReturnType<typeof createApi>;

let data: Promise<WhatsNewResponse | null> | null = null;
/** состояние запуска: шторка уже открывалась сама / отметка уже отправлена */
export const wnLaunch = { autoShown: false, seenId: null as string | null, seenAt: null as string | null };

/** Заметки новее отмеченной в этом запуске (шторку, закрытую в Профиле, Главная не повторяет — ревью 9.4). */
export function unseenAfterLaunchMark(notes: ReleaseNote[]): ReleaseNote[] {
  const at = wnLaunch.seenAt ? Date.parse(wnLaunch.seenAt) : NaN;
  return Number.isFinite(at) ? notes.filter((n) => Date.parse(n.published_at) > at) : notes;
}

/** Один запрос за запуск; сбой — null (шторки нет, приложение работает как обычно). force — для пункта в Профиле. */
export function loadWhatsNew(api: Api, force = false): Promise<WhatsNewResponse | null> {
  if (force || !data) data = Promise.resolve().then(() => api.whatsNew.get()).catch(() => null);
  return data;
}

/** Закрытие шторки: отметить самую новую из показанных (сервер двигает отметку только вперёд). */
export function markWhatsNewSeen(api: Api, notes: ReleaseNote[]): void {
  const newest = notes[0];
  if (!newest || wnLaunch.seenId === newest.release_note_id) return;
  const prev = { id: wnLaunch.seenId, at: wnLaunch.seenAt };
  wnLaunch.seenId = newest.release_note_id;
  if (!wnLaunch.seenAt || Date.parse(newest.published_at) > Date.parse(wnLaunch.seenAt)) wnLaunch.seenAt = newest.published_at;
  data = null; // следующий запрос — уже с отметкой сервера
  void api.whatsNew.seen(newest.release_note_id).catch(() => {
    // не сохранилось на сервере — в этом запуске всё равно не повторяем, покажем при следующем
    wnLaunch.seenId = prev.id;
  });
}

/** «Посмотреть»: маршрут из белого списка → переход. Неизвестный маршрут — null (кнопки нет). */
export function routeAction(route: ReleaseNoteRoute | string | null): NavAction | null {
  switch (route) {
    case "home":
    case "catalog":
    case "watch":
    case "news":
    case "profile":
      return { type: "tab", tab: route };
    case "support":
      return { type: "reset", stack: [{ name: "profile" }, { name: "supportList" }] };
    default:
      return null;
  }
}

export function resetWhatsNewForTests(): void {
  data = null;
  wnLaunch.autoShown = false;
  wnLaunch.seenId = null;
  wnLaunch.seenAt = null;
}
