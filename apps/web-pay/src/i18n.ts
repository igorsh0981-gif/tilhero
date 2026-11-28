/**
 * Тексты сайта оплаты: RU и UZ (латиница; oʻ, gʻ — U+02BB, тутук белгиси — U+02BC). Направление «сайт → Telegram»
 * разрешено (решение В1): «откройте TilHero в Telegram». Тексты не содержат ПДн и адресов.
 */
import { createContext, useContext } from "react";

export type Lang = "ru" | "uz";
export const LANGS: Lang[] = ["ru", "uz"];

const ru = {
  "brand.sub": "Оплата",
  "lang.switch": "Oʻzbekcha",
  "lang.code": "UZ",
  "common.loading": "Загрузка…",
  "common.retry": "Повторить",
  "common.back": "Назад",
  "common.refresh": "Обновить",
  "nav.plans": "Тарифы",
  "nav.orders": "Мои заказы",
  "nav.logout": "Выйти",

  "login.title": "Подписка TilHero и тилы",
  "login.lead": "Оплата картой через Payme, Click или Uzum. Войдите тем же аккаунтом Telegram, что и в TilHero.",
  "login.button": "Войти через Telegram",
  "login.note": "Вход — только для тех, у кого уже есть аккаунт TilHero. Мы не получаем ваш номер телефона.",
  "login.error.auth_failed": "Не удалось войти через Telegram. Попробуйте ещё раз.",
  "login.error.account_not_found": "Аккаунт TilHero не найден. Сначала откройте TilHero в Telegram, затем вернитесь сюда.",
  "login.error.not_allowed": "Вход недоступен: профиль удаляется.",
  "login.error.session": "Сессия истекла — войдите снова.",

  "sub.title": "Ваша подписка",
  "sub.none": "Подписки пока нет",
  "sub.trial": "Пробный период до {date}",
  "sub.active": "«{plan}» — активна до {date}",
  "sub.active_noplan": "Подписка активна до {date}",
  "sub.expired": "Подписка закончилась",
  "sub.minutes": "ИИ-минуты: осталось {left} из {granted}",
  "sub.next": "Следующий период уже оплачен: {days} дн., {minutes} мин",
  "sub.expiring": "Скоро закончится",

  "cat.subscriptions": "Подписка",
  "cat.tils": "Пакеты тилов",
  "cat.days": "{days} дней",
  "cat.minutes": "{minutes} ИИ-минут",
  "cat.til": "{til} тилов",
  "cat.choose": "Выбрать",
  "cat.unavailable": "Оплата временно недоступна. Попробуйте позже.",
  "cat.empty": "Сейчас нечего купить.",
  "feature.ai_lessons": "Уроки с ИИ",
  "feature.pair_lessons": "Уроки вдвоём",

  "payer.consent": "Для оплаты нужно согласие родителя. Попросите родителя подтвердить его в TilHero в Telegram.",
  "payer.age": "Укажите возраст в TilHero в Telegram — оплата доступна с 14 лет.",

  "buy.title": "Оформление",
  "buy.includes": "Что входит",
  "buy.recipient": "Кому тилы",
  "buy.recipient.self": "Мне",
  "buy.start": "Когда начать",
  "buy.start.after": "После текущего периода (с {date})",
  "buy.start.now": "Начать сейчас",
  "buy.start.forfeit": "Остаток текущего периода сгорит: {minutes} мин, {days} дн.",
  "buy.start.forfeit_short": "Остаток текущего периода сгорит.",
  "buy.start.confirm": "Понимаю, остаток сгорит",
  "buy.provider": "Способ оплаты",
  "buy.offer": "Принимаю условия оферты",
  "buy.offer.read": "Читать оферту",
  "buy.pay": "Оплатить {amount}",
  "buy.redirecting": "Переходим к оплате…",
  "buy.secure": "Оплата проходит на странице платёжной системы. Данные карты TilHero не получает.",
  "buy.not_found": "Товар не найден.",

  "err.PAYMENTS_DISABLED": "Оплата временно недоступна. Попробуйте позже.",
  "err.PROVIDER_NOT_AVAILABLE": "Этот способ оплаты сейчас недоступен — выберите другой.",
  "err.PROVIDER_NOT_ALLOWED": "Этот способ оплаты недоступен — выберите другой.",
  "err.PRODUCT_NOT_AVAILABLE": "Товар сейчас недоступен.",
  "err.PRODUCT_NOT_FOUND": "Товар не найден.",
  "err.OFFER_VERSION_MISMATCH": "Условия оферты обновились — прочитайте и подтвердите их снова.",
  "err.FORFEIT_CONFIRMATION_REQUIRED": "Подтвердите, что остаток текущего периода сгорит.",
  "err.ORDERS_LIMIT": "Много неоплаченных заказов — оплатите или отмените их в «Мои заказы».",
  "err.RATE_LIMITED": "Слишком много попыток — подождите минуту.",
  "err.GUARDIAN_CONSENT_REQUIRED": "Для оплаты нужно согласие родителя. Попросите родителя подтвердить его в TilHero в Telegram.",
  "err.PAYER_REQUIRED": "Оплата доступна владельцу аккаунта 18+ или 14–17 с согласием родителя.",
  "err.BENEFICIARY_NOT_ALLOWED": "Этот получатель недоступен.",
  "err.ORDER_STATE": "Заказ уже нельзя изменить.",
  "err.ORDER_NOT_FOUND": "Заказ не найден.",
  "err.CSRF_INVALID": "Страница устарела — обновите её.",
  "err.BILLING_UNAVAILABLE": "Сервис оплаты временно недоступен — попробуйте позже.",
  "err.NETWORK": "Нет связи с сервером — проверьте интернет и повторите.",
  "err.generic": "Что-то пошло не так. Попробуйте ещё раз.",

  "status.pending": "Ожидает оплаты",
  "status.paid": "Оплачен — зачисляем",
  "status.fulfilled": "Выполнен",
  "status.expired": "Срок оплаты истёк",
  "status.cancelled": "Отменён",
  "status.refunded": "Возвращён",

  "order.title": "Заказ № {no}",
  "order.amount": "Сумма",
  "order.provider": "Способ оплаты",
  "order.created": "Создан",
  "order.paid": "Оплачен",
  "order.expires": "Оплатить до",
  "order.receipt": "Фискальный чек",
  "order.receipt.open": "Открыть чек",
  "order.pay": "Перейти к оплате",
  "order.cancel": "Отменить заказ",
  "order.checking": "Проверяем оплату…",
  "order.check_later": "Оплата ещё не подтверждена. Если вы уже оплатили — обновите страницу через пару минут.",
  "order.done.subscription": "Готово! Подписка активна — откройте TilHero в Telegram.",
  "order.done.til_pack": "Готово! Тилы зачислены — откройте TilHero в Telegram.",
  "order.refund": "Возврат",
  "order.refund.awaiting_provider": "ожидает платёжную систему",
  "order.refund.completed": "выполнен",
  "order.refund.failed": "не удался — напишите в поддержку TilHero",
  "order.not_found": "Заказ не найден.",
  "orders.title": "Мои заказы",
  "orders.empty": "Заказов на сайте пока нет.",
  "orders.more": "Показать ещё",
} as const;

export type MsgKey = keyof typeof ru;
type Dict = Record<MsgKey, string>;

const uz: Dict = {
  "brand.sub": "Toʻlov",
  "lang.switch": "Русский",
  "lang.code": "RU",
  "common.loading": "Yuklanmoqda…",
  "common.retry": "Qayta urinish",
  "common.back": "Orqaga",
  "common.refresh": "Yangilash",
  "nav.plans": "Tariflar",
  "nav.orders": "Buyurtmalarim",
  "nav.logout": "Chiqish",

  "login.title": "TilHero obunasi va tillar",
  "login.lead": "Payme, Click yoki Uzum orqali karta bilan toʻlov. TilHeroda foydalanadigan Telegram hisobingiz bilan kiring.",
  "login.button": "Telegram orqali kirish",
  "login.note": "Kirish faqat TilHero hisobi borlar uchun. Telefon raqamingizni olmaymiz.",
  "login.error.auth_failed": "Telegram orqali kirib boʻlmadi. Qaytadan urinib koʻring.",
  "login.error.account_not_found": "TilHero hisobi topilmadi. Avval Telegramda TilHeroni oching, soʻng bu yerga qayting.",
  "login.error.not_allowed": "Kirish mumkin emas: profil oʻchirilmoqda.",
  "login.error.session": "Seans tugadi — qaytadan kiring.",

  "sub.title": "Obunangiz",
  "sub.none": "Hozircha obuna yoʻq",
  "sub.trial": "Sinov davri {date} gacha",
  "sub.active": "«{plan}» — {date} gacha faol",
  "sub.active_noplan": "Obuna {date} gacha faol",
  "sub.expired": "Obuna tugagan",
  "sub.minutes": "SI daqiqalari: {granted} dan {left} qoldi",
  "sub.next": "Keyingi davr toʻlangan: {days} kun, {minutes} daqiqa",
  "sub.expiring": "Tez orada tugaydi",

  "cat.subscriptions": "Obuna",
  "cat.tils": "Til paketlari",
  "cat.days": "{days} kun",
  "cat.minutes": "{minutes} SI daqiqasi",
  "cat.til": "{til} til",
  "cat.choose": "Tanlash",
  "cat.unavailable": "Toʻlov vaqtincha mavjud emas. Keyinroq urinib koʻring.",
  "cat.empty": "Hozir sotib olish uchun hech narsa yoʻq.",
  "feature.ai_lessons": "SI bilan darslar",
  "feature.pair_lessons": "Juftlikda darslar",

  "payer.consent": "Toʻlov uchun ota-onaning roziligi kerak. Ota-onangizdan Telegramdagi TilHeroda tasdiqlashni soʻrang.",
  "payer.age": "Telegramdagi TilHeroda yoshingizni koʻrsating — toʻlov 14 yoshdan mumkin.",

  "buy.title": "Rasmiylashtirish",
  "buy.includes": "Nimalar kiradi",
  "buy.recipient": "Tillar kimga",
  "buy.recipient.self": "Menga",
  "buy.start": "Qachon boshlash",
  "buy.start.after": "Joriy davrdan keyin ({date} dan)",
  "buy.start.now": "Hozir boshlash",
  "buy.start.forfeit": "Joriy davr qoldigʻi yonib ketadi: {minutes} daqiqa, {days} kun.",
  "buy.start.forfeit_short": "Joriy davr qoldigʻi yonib ketadi.",
  "buy.start.confirm": "Tushunaman, qoldiq yonib ketadi",
  "buy.provider": "Toʻlov usuli",
  "buy.offer": "Oferta shartlarini qabul qilaman",
  "buy.offer.read": "Ofertani oʻqish",
  "buy.pay": "{amount} toʻlash",
  "buy.redirecting": "Toʻlovga oʻtilmoqda…",
  "buy.secure": "Toʻlov toʻlov tizimi sahifasida amalga oshiriladi. Karta maʼlumotlari TilHeroga berilmaydi.",
  "buy.not_found": "Mahsulot topilmadi.",

  "err.PAYMENTS_DISABLED": "Toʻlov vaqtincha mavjud emas. Keyinroq urinib koʻring.",
  "err.PROVIDER_NOT_AVAILABLE": "Bu toʻlov usuli hozir mavjud emas — boshqasini tanlang.",
  "err.PROVIDER_NOT_ALLOWED": "Bu toʻlov usuli mavjud emas — boshqasini tanlang.",
  "err.PRODUCT_NOT_AVAILABLE": "Mahsulot hozir mavjud emas.",
  "err.PRODUCT_NOT_FOUND": "Mahsulot topilmadi.",
  "err.OFFER_VERSION_MISMATCH": "Oferta shartlari yangilandi — qayta oʻqib, tasdiqlang.",
  "err.FORFEIT_CONFIRMATION_REQUIRED": "Joriy davr qoldigʻi yonib ketishini tasdiqlang.",
  "err.ORDERS_LIMIT": "Toʻlanmagan buyurtmalar koʻp — ularni «Buyurtmalarim»da toʻlang yoki bekor qiling.",
  "err.RATE_LIMITED": "Urinishlar juda koʻp — bir daqiqa kuting.",
  "err.GUARDIAN_CONSENT_REQUIRED": "Toʻlov uchun ota-onaning roziligi kerak. Ota-onangizdan Telegramdagi TilHeroda tasdiqlashni soʻrang.",
  "err.PAYER_REQUIRED": "Toʻlov 18 yoshdan katta hisob egasiga yoki ota-ona roziligi bilan 14–17 yoshdagilarga mumkin.",
  "err.BENEFICIARY_NOT_ALLOWED": "Bu qabul qiluvchi mavjud emas.",
  "err.ORDER_STATE": "Buyurtmani endi oʻzgartirib boʻlmaydi.",
  "err.ORDER_NOT_FOUND": "Buyurtma topilmadi.",
  "err.CSRF_INVALID": "Sahifa eskirgan — uni yangilang.",
  "err.BILLING_UNAVAILABLE": "Toʻlov xizmati vaqtincha ishlamayapti — keyinroq urinib koʻring.",
  "err.NETWORK": "Server bilan aloqa yoʻq — internetni tekshirib, qayta urinib koʻring.",
  "err.generic": "Nimadir xato ketdi. Qaytadan urinib koʻring.",

  "status.pending": "Toʻlov kutilmoqda",
  "status.paid": "Toʻlangan — hisobga olinmoqda",
  "status.fulfilled": "Bajarildi",
  "status.expired": "Toʻlov muddati oʻtgan",
  "status.cancelled": "Bekor qilingan",
  "status.refunded": "Qaytarilgan",

  "order.title": "Buyurtma № {no}",
  "order.amount": "Summa",
  "order.provider": "Toʻlov usuli",
  "order.created": "Yaratilgan",
  "order.paid": "Toʻlangan",
  "order.expires": "Toʻlov muddati",
  "order.receipt": "Fiskal chek",
  "order.receipt.open": "Chekni ochish",
  "order.pay": "Toʻlovga oʻtish",
  "order.cancel": "Buyurtmani bekor qilish",
  "order.checking": "Toʻlov tekshirilmoqda…",
  "order.check_later": "Toʻlov hali tasdiqlanmadi. Agar toʻlagan boʻlsangiz, bir necha daqiqadan soʻng sahifani yangilang.",
  "order.done.subscription": "Tayyor! Obuna faol — Telegramda TilHeroni oching.",
  "order.done.til_pack": "Tayyor! Tillar hisobga oʻtkazildi — Telegramda TilHeroni oching.",
  "order.refund": "Qaytarish",
  "order.refund.awaiting_provider": "toʻlov tizimi kutilmoqda",
  "order.refund.completed": "bajarildi",
  "order.refund.failed": "amalga oshmadi — TilHero yordam xizmatiga yozing",
  "order.not_found": "Buyurtma topilmadi.",
  "orders.title": "Buyurtmalarim",
  "orders.empty": "Saytda hozircha buyurtmalar yoʻq.",
  "orders.more": "Yana koʻrsatish",
};

export const MESSAGES: Record<Lang, Dict> = { ru, uz };

export type Params = Record<string, string | number>;

export function translate(lang: Lang, key: MsgKey, params: Params = {}): string {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (_, name: string) => (name in params ? String(params[name]) : `{${name}}`));
}

/** Язык по умолчанию: сохранённый выбор → язык браузера (uz) → ru. */
export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem("wp_lang");
    if (saved === "ru" || saved === "uz") return saved;
  } catch {
    /* localStorage недоступен */
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("uz") ? "uz" : "ru";
}

export interface I18n {
  lang: Lang;
  t: (key: MsgKey, params?: Params) => string;
  setLang: (l: Lang) => void;
}

export const I18nContext = createContext<I18n>({
  lang: "ru",
  t: (key, params) => translate("ru", key, params),
  setLang: () => undefined,
});

export const useI18n = (): I18n => useContext(I18nContext);

/** Сообщение об ошибке API по коду (неизвестный код — общее сообщение). */
export function errorText(t: I18n["t"], code: string): string {
  const key = `err.${code}` as MsgKey;
  return key in ru ? t(key) : t("err.generic");
}
