"""Шаблоны ответов оператора (admin.ts ReplyTemplate): заголовок для сотрудника (RU/EN, язык админки) и текст ученику
на его языке (RU/UZ, латиница), категории обращений TilHero, к которым шаблон подходит.

Статичны в коде (как у aievent в admin-bff), пока нет редактора шаблонов. Оператор вставляет текст в поле ответа и
правит его перед отправкой — шаблон сам ничего не отправляет. Правила текстов (проверяются тестами):
- вежливо и коротко, простым текстом без плейсхолдеров и разметки;
- без обещаний сроков и сумм (никаких «в течение 24 часов», «вернём N сум»): support не управляет оплатой и сроками
  других команд — только эскалации;
- без давления и формулировок о «потере» и «провале» (детские профили, CONVENTIONS §8);
- никогда не просить PIN, код родителя и коды подтверждения;
- названия разделов Mini App в «…» — ровно как в i18n Mini App (сверка — тест).
"""

from __future__ import annotations

from typing import Final

from tilhero_support.domain.constants import CATEGORIES

ReplyTemplate = dict[str, object]

REPLY_TEMPLATES: Final[tuple[ReplyTemplate, ...]] = (
    {
        "id": "tpl_lesson_check",
        "title": {"ru": "Урок: проверяем", "en": "Lesson: looking into it"},
        "text": {
            "ru": "Здравствуйте! Спасибо, что написали. Мы проверяем, что случилось с уроком. Пока попробуйте, "
                  "пожалуйста, открыть урок заново с главного экрана. Результат проверки напишем в этом обращении.",
            "uz": "Assalomu alaykum! Yozganingiz uchun rahmat. Dars bilan nima boʻlganini tekshiryapmiz. Hozircha "
                  "darsni bosh sahifadan qaytadan ochib koʻring. Tekshiruv natijasini shu murojaatda yozamiz.",
        },
        "categories": ["LESSON"],
    },
    {
        "id": "tpl_assessment_review",
        "title": {"ru": "Оценка урока: передали методистам", "en": "Lesson score: sent to methodologists"},
        "text": {
            "ru": "Здравствуйте! Спасибо, что обратили внимание на оценку. Мы передали вопрос методистам — они "
                  "проверят задание и ваш ответ. Что они решат, напишем в этом обращении.",
            "uz": "Assalomu alaykum! Bahoga eʼtibor berganingiz uchun rahmat. Savolingizni metodistlarga topshirdik — "
                  "ular topshiriq va javobingizni tekshiradi. Natijani shu murojaatda yozamiz.",
        },
        "categories": ["ASSESSMENT"],
    },
    {
        "id": "tpl_reminders_settings",
        "title": {"ru": "Напоминания: проверить настройки", "en": "Reminders: check the settings"},
        "text": {
            "ru": "Здравствуйте! Проверьте, пожалуйста, в профиле: в «График занятий» — дни, время и часовой пояс, "
                  "в «Уведомления» — что напоминания о занятии включены. Если чат с ботом TilHero был остановлен, "
                  "откройте его и запустите снова. Если не поможет — ответьте здесь, разберёмся вместе.",
            "uz": "Assalomu alaykum! Profilda tekshirib koʻring: «Mashgʻulotlar jadvali»da — kunlar, vaqt va vaqt "
                  "mintaqasi, «Bildirishnomalar»da — mashgʻulot eslatmalari yoqilganmi. Agar TilHero boti bilan chat "
                  "toʻxtatilgan boʻlsa, uni oching va qayta ishga tushiring. Yordam bermasa — shu yerda javob yozing, "
                  "birga hal qilamiz.",
        },
        "categories": ["SCHEDULE_REMINDERS"],
    },
    {
        "id": "tpl_child_profile",
        "title": {"ru": "Детский профиль: управляет родитель", "en": "Child profile: managed by the parent"},
        "text": {
            "ru": "Здравствуйте! Детским профилем управляет родитель: изменить или удалить его можно в аккаунте "
                  "родителя, в разделе «Семья и приглашения». Ради безопасности ребёнка мы обсуждаем детский профиль "
                  "только с родителем.",
            "uz": "Assalomu alaykum! Bola profilini ota-ona boshqaradi: uni ota-ona akkauntida, «Oila va takliflar» "
                  "boʻlimida oʻzgartirish yoki oʻchirish mumkin. Bola xavfsizligi uchun bola profilini faqat ota-ona "
                  "bilan muhokama qilamiz.",
        },
        "categories": ["CHILD_PROFILE"],
    },
    {
        "id": "tpl_account_security",
        "title": {"ru": "Аккаунт: безопасность", "en": "Account: security"},
        "text": {
            "ru": "Здравствуйте! Мы проверяем ваш аккаунт. Пожалуйста, никому не сообщайте код родителя и коды "
                  "подтверждения — сотрудники TilHero их никогда не спрашивают. Расскажите, что именно не "
                  "получается, и мы поможем.",
            "uz": "Assalomu alaykum! Akkauntingizni tekshiryapmiz. Iltimos, ota-ona kodini va tasdiqlash kodlarini "
                  "hech kimga aytmang — TilHero xodimlari ularni hech qachon soʻramaydi. Nima ishlamayotganini "
                  "yozing, yordam beramiz.",
        },
        "categories": ["ACCOUNT", "CHILD_PROFILE"],
    },
    {
        "id": "tpl_personal_data",
        "title": {"ru": "Персональные данные: запрос принят", "en": "Personal data: request received"},
        "text": {
            "ru": "Здравствуйте! Ваш запрос о персональных данных принят и передан ответственному специалисту. "
                  "Ответ придёт в этом обращении. Удалить аккаунт и данные можно и самостоятельно: Профиль → "
                  "«Данные и согласия» → «Удалить аккаунт и данные».",
            "uz": "Assalomu alaykum! Shaxsiy maʼlumotlar boʻyicha soʻrovingiz qabul qilindi va masʼul mutaxassisga "
                  "topshirildi. Javob shu murojaatda keladi. Akkaunt va maʼlumotlarni oʻzingiz ham oʻchirishingiz "
                  "mumkin: Profil → «Maʼlumotlar va roziliklar» → «Akkaunt va maʼlumotlarni oʻchirish».",
        },
        "categories": ["PERSONAL_DATA"],
    },
    {
        "id": "tpl_more_details",
        "title": {"ru": "Нужны подробности", "en": "Need more details"},
        "text": {
            "ru": "Здравствуйте! Чтобы разобраться, опишите, пожалуйста, что вы делали перед ошибкой, что увидели на "
                  "экране и примерно когда это было. Спасибо!",
            "uz": "Assalomu alaykum! Vaziyatni tushunishimiz uchun xatolikdan oldin nima qilganingizni, ekranda nima "
                  "koʻrganingizni va bu taxminan qachon boʻlganini yozib bering. Rahmat!",
        },
        "categories": ["BUG", "LESSON", "OTHER"],
    },
    {
        "id": "tpl_fixed_check",
        "title": {"ru": "Исправили — проверьте", "en": "Fixed — please check"},
        "text": {
            "ru": "Здравствуйте! Мы исправили проблему. Проверьте, пожалуйста: закройте и снова откройте TilHero. "
                  "Если что-то осталось, ответьте в этом обращении.",
            "uz": "Assalomu alaykum! Muammoni tuzatdik. Iltimos, tekshirib koʻring: TilHeroʼni yoping va qayta "
                  "oching. Agar biror narsa qolgan boʻlsa, shu murojaatda javob yozing.",
        },
        "categories": ["BUG", "LESSON", "SCHEDULE_REMINDERS"],
    },
    {
        "id": "tpl_forwarded",
        "title": {"ru": "Передали команде", "en": "Forwarded to the team"},
        "text": {
            "ru": "Здравствуйте! Спасибо за обращение. Мы передали ваш вопрос профильной команде. Как только будет "
                  "ответ, напишем в этом обращении.",
            "uz": "Assalomu alaykum! Murojaatingiz uchun rahmat. Savolingizni masʼul jamoaga topshirdik. Javob "
                  "boʻlishi bilan shu murojaatda yozamiz.",
        },
        "categories": ["LESSON", "ASSESSMENT", "BUG", "OTHER"],
    },
    {
        "id": "tpl_resolved",
        "title": {"ru": "Вопрос решён", "en": "Resolved"},
        "text": {
            "ru": "Рады, что всё получилось! Если появятся вопросы, напишите нам — мы на связи. Хороших занятий!",
            "uz": "Hammasi joyida boʻlganidan xursandmiz! Savollar boʻlsa, bizga yozing — biz doim aloqadamiz. "
                  "Mashgʻulotlaringiz samarali boʻlsin!",
        },
        "categories": [code for code, meta in CATEGORIES.items() if meta["available"]],
    },
)


def reply_templates() -> list[ReplyTemplate]:
    return [dict(t) for t in REPLY_TEMPLATES]
