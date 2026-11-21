"""Реестр 17 агентов LinguaFlow (ai.ts `AgentId`, INTERNAL_API §1.1). Источник сида таблицы `agents` (миграция 0001).

`llm` + `active` — агенты спринта через ai-gateway (`teaching_coach`, `conversation_partner`, `independent_evaluator`);
`code` — логика сервисов (`learning_orchestrator` — lessons, `curriculum_planner` — learning-plan,
`diagnostic_assessor` — diagnostics; спринт 5: `spaced_repetition_coach` — memory (FSRS и правила оценки ответа),
`pronunciation_coach` — ai-gateway (акустическая оценка Azure Speech + советы правилами); спринт 6:
`gameplay_director` — gamification (правила игры кодом: награды по подтверждённым действиям, задания дня, значки,
ступени героя; модель не вызывается)); `rules` —
детерминированные правила (`safety_quality_gate` — ai-gateway, `error_analyst` — часть вывода оценщика в assessment);
остальные — `planned` с этапом по docs/SPRINTS.md (`evening_review_coach` — planned: вечернее напоминание спринта 5
делают memory и notifications без агента).
`free_text` — агент принимает свободный текст ученика (детям 6–13 такие вызовы отклоняются, решение владельца
19.11.2026). У `pronunciation_coach` свободного текста нет (аудио эталонной фразы из контента; детям — только с
согласием родителя, проверяют memory и telegram-bff).

Таблица `agents` заполняется миграцией 0001 из `AGENTS`; изменения реестра после неё — миграциями (0004 переводит
`spaced_repetition_coach` и `pronunciation_coach` в `code`/`active`, снимок прежних значений — `AGENTS_SPRINT4`;
0007 — `gameplay_director` в `code`/`active`, снимок — `AGENTS_SPRINT5`; 0008 (спринт 7, INTERNAL_API §4) —
`cooperative_lesson_coach` в `llm`/`active` (версия 1 — черновик сида, публикует владелец после золотых тестов),
`duel_host` в `code`/`active` (lessons: набор дуэли кодом), `referral_integrity_reviewer` в `rules`/`active` (social:
квалификация реферала правилами), снимок — `AGENTS_SPRINT6`).
"""

from __future__ import annotations

from typing import Any, Final

AGENT_IDS: Final[tuple[str, ...]] = (
    "learning_orchestrator",
    "diagnostic_assessor",
    "curriculum_planner",
    "teaching_coach",
    "conversation_partner",
    "independent_evaluator",
    "error_analyst",
    "spaced_repetition_coach",
    "pronunciation_coach",
    "evening_review_coach",
    "safety_quality_gate",
    "cooperative_lesson_coach",
    "gameplay_director",
    "duel_host",
    "referral_integrity_reviewer",
    "media_lesson_designer",
    "language_pathway_advisor",
)
ACTIVE_LLM: Final = ("teaching_coach", "conversation_partner", "independent_evaluator", "cooperative_lesson_coach")


def _a(agent_id: str, title: tuple[str, str], purpose: tuple[str, str], owner_role: str, implementation: str,
       availability: str = "active", planned_sprint: int | None = None, free_text: bool = False,
       implemented_in: str | None = None) -> dict[str, Any]:
    return {"agent_id": agent_id, "title": {"ru": title[0], "uz": title[1]},
            "purpose": {"ru": purpose[0], "uz": purpose[1]}, "owner_role": owner_role,
            "implementation": implementation, "availability": availability, "planned_sprint": planned_sprint,
            "free_text": free_text, "implemented_in": implemented_in}


AGENTS: Final[tuple[dict[str, Any], ...]] = (
    _a("learning_orchestrator", ("Оркестратор урока", "Dars orkestratori"),
       ("Ведёт этапы урока, версии и ограничения", "Dars bosqichlari, versiyalar va cheklovlarni boshqaradi"),
       "platform", "code", implemented_in="lessons"),
    _a("diagnostic_assessor", ("Диагностика", "Diagnostika"),
       ("Первичная карта навыков по тестовым заданиям",
        "Test topshiriqlari boʻyicha boshlangʻich koʻnikmalar xaritasi"),
       "methodist", "code", implemented_in="diagnostics"),
    _a("curriculum_planner", ("Планировщик программы", "Dastur rejalashtiruvchisi"),
       ("Выбирает следующий урок по пробелам и результатам",
        "Boʻshliqlar va natijalar boʻyicha keyingi darsni tanlaydi"),
       "methodist", "code", implemented_in="learning-plan"),
    _a("teaching_coach", ("Преподаватель", "Oʻqituvchi"),
       ("Объясняет проще и даёт пример из урока", "Soddaroq tushuntiradi va darsdan misol beradi"),
       "methodist", "llm"),
    _a("conversation_partner", ("Собеседник", "Suhbatdosh"),
       ("Ведёт ролевую ситуацию по графу сценария", "Ssenariy grafi boʻyicha rolli vaziyatni olib boradi"),
       "methodist", "llm", free_text=True),
    _a("independent_evaluator", ("Независимый оценщик", "Mustaqil baholovchi"),
       ("Оценивает по рубрике и доказательствам", "Rubrika va dalillar boʻyicha baholaydi"),
       "methodist", "llm", free_text=True),
    _a("error_analyst", ("Анализ ошибок", "Xatolar tahlili"),
       ("Ошибки с доказательствами — часть вывода оценщика", "Dalilli xatolar — baholovchi natijasining qismi"),
       "methodist", "rules", implemented_in="assessment"),
    _a("spaced_repetition_coach", ("Интервальные повторения", "Oraliqli takrorlash"),
       ("Готовит задания повторения и оценивает ответы правилами; сроки считает FSRS",
        "Takrorlash topshiriqlarini tayyorlaydi va javoblarni qoidalar bilan baholaydi; muddatni FSRS hisoblaydi"),
       "methodist", "code", implemented_in="memory"),
    _a("pronunciation_coach", ("Произношение", "Talaffuz"),
       ("Оценивает произношение по акустике (Azure Speech) и даёт 1–2 совета",
        "Talaffuzni akustika boʻyicha baholaydi (Azure Speech) va 1–2 ta maslahat beradi"),
       "methodist", "code", implemented_in="ai-gateway"),
    _a("evening_review_coach", ("Вечернее повторение", "Kechki takrorlash"),
       ("Повторение знакомого материала", "Tanish materialni takrorlash"),
       "methodist", "llm", "planned", 5),
    _a("safety_quality_gate", ("Контроль качества и безопасности", "Sifat va xavfsizlik nazorati"),
       ("Проверяет схему и правила безопасности ответов агентов",
        "Agentlar javobining sxemasi va xavfsizlik qoidalarini tekshiradi"),
       "platform", "rules", implemented_in="ai-gateway"),
    _a("cooperative_lesson_coach", ("Парный урок", "Juftlik darsi"),
       ("Ведёт парный урок: роли A и B, ходы по очереди, у каждого свой вклад и отчёт",
        "Juftlik darsini olib boradi: A va B rollari, navbatma-navbat javoblar, har kimning oʻz hissasi va hisoboti"),
       "methodist", "llm", free_text=True),
    _a("gameplay_director", ("Игровой режиссёр", "Oʻyin rejissyori"),
       ("Правила игры кодом: XP и тилы за подтверждённые действия, задания дня, значки, ступени героя; на оценку "
        "языка не влияет",
        "Oʻyin qoidalari kodda: tasdiqlangan harakatlar uchun XP va tillar, kunlik topshiriqlar, nishonlar, "
        "qahramon bosqichlari; til bahosiga taʼsir qilmaydi"),
       "methodist", "code", implemented_in="gamification"),
    _a("duel_host", ("Ведущий дуэли", "Duel boshlovchisi"),
       ("Один набор из 10 закрытых заданий для обоих: равная сложность, ключи проверяет сервер; на оценку языка "
        "не влияет",
        "Ikkalasi uchun 10 ta yopiq topshiriqdan iborat bitta toʻplam: teng murakkablik, kalitlarni server tekshiradi; "
        "til bahosiga taʼsir qilmaydi"),
       "methodist", "code", implemented_in="lessons"),
    _a("referral_integrity_reviewer", ("Проверка рефералов", "Referallarni tekshirish"),
       ("Правила кампании и флаги риска: засчитать, удержать на проверку или отклонить; награды не начисляет",
        "Kampaniya qoidalari va xavf belgilari: hisoblash, tekshiruvga qoldirish yoki rad etish; mukofot bermaydi"),
       "operations", "rules", implemented_in="social"),
    _a("media_lesson_designer", ("Дизайнер медиауроков", "Media dars dizayneri"),
       ("Упражнения только по разрешённым материалам", "Faqat ruxsat etilgan materiallar boʻyicha mashqlar"),
       "methodist", "llm", "planned", 5),
    _a("language_pathway_advisor", ("Советник языкового пути", "Til yoʻli maslahatchisi"),
       ("Предлагает следующую языковую пару", "Keyingi til juftligini taklif qiladi"),
       "methodist", "llm", "planned", 9),
)

LLM_AGENT_IDS: Final[frozenset[str]] = frozenset(a["agent_id"] for a in AGENTS if a["implementation"] == "llm")
FREE_TEXT_AGENT_IDS: Final[frozenset[str]] = frozenset(a["agent_id"] for a in AGENTS if a["free_text"])

# Снимок строк реестра до миграции 0004 (откат 0004 возвращает их и маршрутизацию версий этих агентов)
AGENTS_SPRINT4: Final[tuple[dict[str, Any], ...]] = (
    _a("spaced_repetition_coach", ("Интервальные повторения", "Oraliqli takrorlash"),
       ("Готовит задания повторения; сроки считает алгоритм",
        "Takrorlash topshiriqlarini tayyorlaydi; muddatni algoritm hisoblaydi"),
       "methodist", "llm", "planned", 5),
    _a("pronunciation_coach", ("Произношение", "Talaffuz"),
       ("Работает с акустическими данными речи", "Nutqning akustik maʼlumotlari bilan ishlaydi"),
       "methodist", "llm", "planned", 5, free_text=True),
)
SPRINT5_CODE_AGENTS: Final = ("spaced_repetition_coach", "pronunciation_coach")

# Снимок строки реестра до миграции 0007 (спринт 6: gameplay_director — code/gamification; откат возвращает её)
AGENTS_SPRINT5: Final[tuple[dict[str, Any], ...]] = (
    _a("gameplay_director", ("Игровой режиссёр", "Oʻyin rejissyori"),
       ("Предлагает миссии героя, не начисляет награды", "Qahramon missiyalarini taklif qiladi, mukofot bermaydi"),
       "methodist", "llm", "planned", 6),
)
SPRINT6_CODE_AGENTS: Final = ("gameplay_director",)

# Снимок строк реестра до миграции 0008 (спринт 7: cooperative_lesson_coach — llm/active, duel_host — code/lessons,
# referral_integrity_reviewer — rules/social; откат возвращает строки спринта 6 и пустую маршрутизацию версий)
AGENTS_SPRINT6: Final[tuple[dict[str, Any], ...]] = (
    _a("cooperative_lesson_coach", ("Парный урок", "Juftlik darsi"),
       ("Два независимых вклада и отчёта в паре", "Juftlikda ikki mustaqil hissa va hisobot"),
       "methodist", "llm", "planned", 7, free_text=True),
    _a("duel_host", ("Ведущий дуэли", "Duel boshlovchisi"),
       ("Равные по сложности игровые вопросы", "Murakkabligi teng oʻyin savollari"),
       "methodist", "llm", "planned", 7),
    _a("referral_integrity_reviewer", ("Проверка рефералов", "Referallarni tekshirish"),
       ("Сигналы мошенничества; награды не списывает", "Firibgarlik signallari; mukofotlarni yechmaydi"),
       "operations", "llm", "planned", 7),
)
SPRINT7_AGENTS: Final = ("cooperative_lesson_coach", "duel_host", "referral_integrity_reviewer")
# агенты спринта 7, переставшие быть LLM: их пустая маршрутизация версий удаляется (0008), откат её возвращает
SPRINT7_NOT_LLM: Final = ("duel_host", "referral_integrity_reviewer")

# Модели и цены по умолчанию (PLAN «Модели по умолчанию», прайс Anthropic на 19.11.2026), $ за 1 млн токенов
MODELS: Final[tuple[dict[str, Any], ...]] = (
    {"model_id": "claude-haiku-5-5", "provider": "anthropic", "input_usd_per_mtok": "0.10",
     "output_usd_per_mtok": "0.50", "active": True},
    {"model_id": "claude-sonnet-5-5", "provider": "anthropic", "input_usd_per_mtok": "2.00",
     "output_usd_per_mtok": "10.00", "active": True},
    {"model_id": "fake", "provider": "fake", "input_usd_per_mtok": "0", "output_usd_per_mtok": "0", "active": True},
)

# Оценка произношения (спринт 5, решение владельца 20.11.2026): цена часа аудио — Azure AI Speech, Pronunciation
# Assessment в реальном времени ($1,32 за час, ноябрь 2026); fake — стенд и тесты. Сид — миграция 0004 (в 0001 —
# только LLM-модели: столбца audio_usd_per_hour и провайдеров речи там ещё нет).
SPEECH_MODELS: Final[tuple[dict[str, Any], ...]] = (
    {"model_id": "azure-speech-pa", "provider": "azure_speech", "input_usd_per_mtok": "0", "output_usd_per_mtok": "0",
     "audio_usd_per_hour": "1.32", "active": True},
    {"model_id": "fake-speech", "provider": "fake_speech", "input_usd_per_mtok": "0", "output_usd_per_mtok": "0",
     "audio_usd_per_hour": "0", "active": True},
)
# Релиз 5.1 (решение владельца 20.11.2026): свой сервер — распознавание faster-whisper в сервисе tts, сравнение с
# эталоном здесь; денег не стоит (0), бюджеты ИИ не тратит. Сид — миграция 0006.
WHISPER_MODEL: Final[dict[str, Any]] = {
    "model_id": "whisper-base-en", "provider": "whisper", "input_usd_per_mtok": "0", "output_usd_per_mtok": "0",
    "audio_usd_per_hour": "0", "active": True}
SPEECH_MODEL_BY_PROVIDER: Final[dict[str, str]] = {"azure_speech": "azure-speech-pa", "fake_speech": "fake-speech",
                                                   "whisper": "whisper-base-en"}
SPEECH_PROVIDERS: Final = ("whisper", "azure_speech", "fake_speech")
LLM_PROVIDERS: Final = ("anthropic", "fake")

# Бюджет по умолчанию (решение владельца 19.11.2026): $20 в месяц, $0,05 на ученика в день, $0,03 на урок
BUDGET_DEFAULTS: Final[dict[str, Any]] = {
    "ai_enabled": True, "monthly_cap_usd": "20.00", "learner_daily_cap_usd": "0.0500", "lesson_cap_usd": "0.0300",
    "alert_percent": 80,
}
# Спринт 7 (INTERNAL_API §4): потолок вызовов коуча на одну парную комнату, $ (миграция 0008; 0..monthly_cap_usd)
ROOM_CAP_DEFAULT: Final = "0.1000"
