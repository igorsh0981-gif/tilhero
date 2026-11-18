/**
 * Шаблоны ответов поддержки (RU/EN) — статичны в BFF до появления редактора шаблонов. Плейсхолдеры {deeplink},
 * {fetched_at}, {number} заполняются из контекста обращения в AI-черновике-заглушке.
 */
import type { AiDraft, ReplyTemplate, StaffTicket } from "@tilhero/contracts/admin";

export const REPLY_TEMPLATES: readonly ReplyTemplate[] = [
  {
    id: "tpl_link",
    title: { ru: "Ссылка провайдера не работает", en: "Provider link is broken" },
    text: {
      ru: "Здравствуйте! Спасибо, что написали. Мы проверили ссылку: проблема на стороне продавца билетов. Пока откройте официальную страницу напрямую — {deeplink}. Мы сообщим, когда ссылка в приложении снова заработает.",
      en: "Hi! Thanks for reaching out. We checked the link: the issue is on the ticket seller’s side. For now, open the official page directly — {deeplink}. We’ll let you know once the link in the app works again.",
    },
    categories: ["TICKET_SOURCE", "EVENT_RECOMMENDATION"],
  },
  {
    id: "tpl_price",
    title: { ru: "Цена изменилась у источника", en: "Price changed at the source" },
    text: {
      ru: "Здравствуйте! Цены в приложении — снимок у источника на момент проверки ({fetched_at}). Продавец мог изменить цену после этого. Мы обновили данные и проверим источник ещё раз.",
      en: "Hi! Prices in the app are a snapshot from the source at check time ({fetched_at}). The seller may have changed the price since then. We refreshed the data and will re-check the source.",
    },
    categories: ["PRICE", "FLIGHT", "HOTEL"],
  },
  {
    id: "tpl_more",
    title: { ru: "Нужны подробности", en: "Need more details" },
    text: {
      ru: "Здравствуйте! Чтобы разобраться, пришлите, пожалуйста, скриншот ошибки и примерное время, когда она появилась.",
      en: "Hi! To look into this, please send a screenshot of the error and roughly when it happened.",
    },
    categories: ["BUG", "OTHER"],
  },
  {
    id: "tpl_account",
    title: { ru: "Вопрос по аккаунту", en: "Account question" },
    text: {
      ru: "Здравствуйте! Мы проверили ваш аккаунт по обращению {number}. Из соображений безопасности мы никогда не просим PIN-код или коды подтверждения — не сообщайте их никому. Расскажите, пожалуйста, что именно не получается.",
      en: "Hi! We checked your account regarding request {number}. For your security we never ask for your PIN or confirmation codes — please don’t share them with anyone. Could you tell us what exactly isn’t working?",
    },
    categories: ["ACCOUNT"],
  },
  {
    id: "tpl_privacy",
    title: { ru: "Персональные данные", en: "Personal data" },
    text: {
      ru: "Здравствуйте! Запрос по персональным данным ({number}) передан ответственному специалисту. Удалить аккаунт и данные можно в приложении: Профиль → Удалить аккаунт. Мы ответим в установленный срок.",
      en: "Hi! Your personal data request ({number}) has been passed to the responsible specialist. You can delete your account and data in the app: Profile → Delete account. We’ll reply within the required time.",
    },
    categories: ["PERSONAL_DATA"],
  },
];

const FALLBACK_ID = "tpl_more";

function fill(text: string, t: Pick<StaffTicket, "number" | "context">): string {
  const ctx = t.context;
  return text
    .replaceAll("{number}", t.number)
    .replaceAll("{deeplink}", ctx?.deeplink ?? "—")
    .replaceAll("{fetched_at}", ctx?.fetched_at ?? ctx?.price_snapshot?.amount ?? "—");
}

/** AI-черновик-заглушка (до спринта 6): шаблон по категории обращения, язык — по locale пользователя. */
export function stubDraft(t: Pick<StaffTicket, "number" | "category" | "context">, locale: string | null | undefined): AiDraft {
  const lang = locale?.toLowerCase().startsWith("en") ? "en" : "ru";
  const tpl =
    REPLY_TEMPLATES.find((x) => x.categories.includes(t.category)) ?? REPLY_TEMPLATES.find((x) => x.id === FALLBACK_ID)!;
  return { text: fill(tpl.text[lang], t), stub: true, source: "template" };
}
