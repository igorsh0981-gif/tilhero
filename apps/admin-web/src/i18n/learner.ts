/**
 * Learner-facing chrome of the previews (the «Что нового» sheet of the Mini App and a Telegram message of the bot) in
 * the LEARNER's language — RU or UZ, not the staff UI language. The texts are copied from the Mini App dictionaries
 * (apps/telegram-miniapp/src/i18n ru.ts / uz.ts, keys wn.*) so the preview looks like the real sheet.
 */
import type { UiLang } from "@tilhero/contracts/admin";

export const LEARNER = {
  ru: {
    "wn.welcome.cap": "Добро пожаловать",
    "wn.welcome.title": "Знакомство с TilHero",
    "wn.updates.cap": "С вашего прошлого входа",
    "wn.updates.title": "Что изменилось",
    "wn.progress": "{n} из {m}",
    "wn.next": "Дальше",
    "wn.gotIt": "Понятно",
    "wn.more": "Подробнее",
    "wn.once": "Показываем один раз. Все изменения — в «Новостях».",
    "tg.bot": "бот",
    "tg.open": "Открыть",
    "tg.test": "[ТЕСТ] ",
    "empty": "пусто",
    "ls.lesson": "Урок",
    "ls.level": "уровень {l}",
    "ls.min": "{n} мин",
    "ls.core": "Урок плана",
    "ls.optional": "Дополнительный",
    "ls.goal": "Вы научитесь",
    "ls.stages": "Как пройдёт урок",
    "ls.st.retrieval": "Вспоминаем",
    "ls.st.explanation": "Новое",
    "ls.st.roleplay": "Диалог с героем",
    "ls.st.assessment": "Проверка",
    "ls.st.summary": "Итоги",
    "ls.words": "Слова урока",
    "ls.examples": "Примеры",
    "ls.start": "Начать урок",
    "rd.reading": "Чтение",
    "rd.words": "{n} слов",
    "rd.translate": "Перевод",
    "rd.hide": "Скрыть перевод",
    "rd.tap": "Нажмите на выделенное слово — появится перевод",
    "rd.addDict": "В словарь",
    "rd.close": "Закрыть",
    "rd.listen": "Слушать",
    "rd.questions": "Вопросов после текста: {n}",
    "rd.start": "К вопросам",
  },
  uz: {
    "wn.welcome.cap": "Xush kelibsiz",
    "wn.welcome.title": "TilHero bilan tanishuv",
    "wn.updates.cap": "Oxirgi kirishingizdan beri",
    "wn.updates.title": "Nima oʻzgardi",
    "wn.progress": "{m} tadan {n}",
    "wn.next": "Keyingisi",
    "wn.gotIt": "Tushunarli",
    "wn.more": "Batafsil",
    "wn.once": "Bir marta koʻrsatamiz. Barcha oʻzgarishlar — «Yangiliklar»da.",
    "tg.bot": "bot",
    "tg.open": "Ochish",
    "tg.test": "[TEST] ",
    "empty": "boʻsh",
    "ls.lesson": "Dars",
    "ls.level": "{l} daraja",
    "ls.min": "{n} daq",
    "ls.core": "Reja darsi",
    "ls.optional": "Qoʻshimcha",
    "ls.goal": "Siz oʻrganasiz",
    "ls.stages": "Dars qanday oʻtadi",
    "ls.st.retrieval": "Eslaymiz",
    "ls.st.explanation": "Yangi mavzu",
    "ls.st.roleplay": "Qahramon bilan dialog",
    "ls.st.assessment": "Tekshiruv",
    "ls.st.summary": "Xulosa",
    "ls.words": "Dars soʻzlari",
    "ls.examples": "Misollar",
    "ls.start": "Darsni boshlash",
    "rd.reading": "Oʻqish",
    "rd.words": "{n} ta soʻz",
    "rd.translate": "Tarjima",
    "rd.hide": "Tarjimani yashirish",
    "rd.tap": "Ajratilgan soʻzni bosing — tarjimasi chiqadi",
    "rd.addDict": "Lugʻatga",
    "rd.close": "Yopish",
    "rd.listen": "Tinglash",
    "rd.questions": "Matndan keyingi savollar: {n}",
    "rd.start": "Savollarga",
  },
} as const satisfies Record<UiLang, Record<string, string>>;

export type LearnerKey = keyof (typeof LEARNER)["ru"];

export function lt(lang: UiLang, key: LearnerKey, vars?: Record<string, string | number>): string {
  const s: string = LEARNER[lang][key] ?? LEARNER.ru[key];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] == null ? m : String(vars[k]))) : s;
}

/**
 * Children and about children — no pressure (CONVENTIONS §8): stems of «потеря серии», «провал», «штраф» in RU and UZ.
 * The same list as the server check of child templates (notifications domain/texts.py PRESSURE_WORDS).
 */
export const PRESSURE_WORDS = /сери|потер|провал|теря|штраф|seriya|yoʻqot|muvaffaqiyatsiz|jarima/i;
