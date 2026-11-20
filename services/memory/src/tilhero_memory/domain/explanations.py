"""Справочник объяснений кодов ошибок (error_code оценщика) RU/UZ — для заданий error_fix, журнала ошибок и
аналитики забывания. `label` — коротко («Порядок слов»), `explanation` — правило для задания «исправьте фразу».
UZ — латиница (oʻ, gʻ — U+02BB; тутуқ белгиси — U+02BC). Без оценочных слов и давления (дети — без «провала»)."""

from __future__ import annotations

from typing import Final

Localized = dict[str, str]

ERROR_CODES: Final[dict[str, dict[str, Localized]]] = {
    "missing_be": {
        "label": {"ru": "Пропущен глагол be", "uz": "be feʼli tushib qolgan"},
        "explanation": {
            "ru": "В английском предложении нужен глагол: am, is или are («I am a student», «She is at home»).",
            "uz": "Ingliz tilidagi gapda feʼl kerak: am, is yoki are («I am a student», «She is at home»).",
        },
    },
    "wrong_tense": {
        "label": {"ru": "Время глагола", "uz": "Feʼl zamoni"},
        "explanation": {
            "ru": "Проверьте время глагола: когда происходит действие — сейчас, обычно, в прошлом или в будущем?",
            "uz": "Feʼl zamonini tekshiring: harakat qachon boʻladi — hozir, odatda, oʻtmishda yoki kelajakda?",
        },
    },
    "article": {
        "label": {"ru": "Артикль a / an / the", "uz": "a / an / the artikli"},
        "explanation": {
            "ru": "Перед существительным в единственном числе обычно нужен артикль: a / an — «какой-то»,"
                  " the — «тот самый».",
            "uz": "Birlikdagi otdan oldin odatda artikl kerak: a / an — «qandaydir», the — «aynan oʻsha».",
        },
    },
    "word_order": {
        "label": {"ru": "Порядок слов", "uz": "Soʻzlar tartibi"},
        "explanation": {
            "ru": "В английском порядок слов строгий: кто — действие — что / где / когда.",
            "uz": "Ingliz tilida soʻz tartibi qatʼiy: kim — harakat — nima / qayerda / qachon.",
        },
    },
    "vocabulary": {
        "label": {"ru": "Выбор слова", "uz": "Soʻz tanlash"},
        "explanation": {
            "ru": "Здесь по-английски говорят другим словом. Вспомните слово из урока.",
            "uz": "Bu yerda inglizcha boshqa soʻz ishlatiladi. Darsdagi soʻzni eslang.",
        },
    },
    "preposition": {
        "label": {"ru": "Предлог", "uz": "Predlog"},
        "explanation": {
            "ru": "Проверьте предлог: in, on, at, to, for, from — у каждого своё значение.",
            "uz": "Predlogni tekshiring: in, on, at, to, for, from — har birining oʻz maʼnosi bor.",
        },
    },
    "plural": {
        "label": {"ru": "Множественное число", "uz": "Koʻplik shakli"},
        "explanation": {
            "ru": "Если предметов больше одного, у существительного обычно окончание -s / -es.",
            "uz": "Narsa bittadan koʻp boʻlsa, ot odatda -s / -es qoʻshimchasini oladi.",
        },
    },
    "spelling": {
        "label": {"ru": "Написание слова", "uz": "Soʻz imlosi"},
        "explanation": {
            "ru": "Проверьте, как пишется слово: буквы и их порядок.",
            "uz": "Soʻz qanday yozilishini tekshiring: harflar va ularning tartibi.",
        },
    },
    # коды закрытого списка independent_evaluator (rules v1/v2: missing_be, third_person_s, wrong_tense, verb_form,
    # article, preposition, plural, word_order, question_form, pronoun, vocabulary, other) — у каждого своё объяснение
    "third_person_s": {
        "label": {"ru": "Окончание -s у глагола", "uz": "Feʼldagi -s qoʻshimchasi"},
        "explanation": {
            "ru": "После he / she / it глагол в настоящем времени получает окончание -s: he works, she has.",
            "uz": "Hozirgi zamonda he / she / it dan keyin feʼlga -s qoʻshiladi: he works, she has.",
        },
    },
    "verb_form": {
        "label": {"ru": "Форма глагола", "uz": "Feʼl shakli"},
        "explanation": {
            "ru": "Проверьте форму глагола: после want, can, like и других слов нужна определённая форма (want to go,"
                  " can swim).",
            "uz": "Feʼl shaklini tekshiring: want, can, like va boshqa soʻzlardan keyin maʼlum shakl kerak (want to go,"
                  " can swim).",
        },
    },
    "question_form": {
        "label": {"ru": "Построение вопроса", "uz": "Savol tuzilishi"},
        "explanation": {
            "ru": "В вопросе вспомогательный глагол стоит перед подлежащим: «Do you like tea?», «Where is he?».",
            "uz": "Savolda yordamchi feʼl egadan oldin keladi: «Do you like tea?», «Where is he?».",
        },
    },
    "pronoun": {
        "label": {"ru": "Местоимение", "uz": "Olmosh"},
        "explanation": {
            "ru": "Проверьте местоимение: кто действует и чьё это — I / me / my, he / him / his, she / her.",
            "uz": "Olmoshni tekshiring: kim harakat qiladi va bu kimniki — I / me / my, he / him / his, she / her.",
        },
    },
    "agreement": {
        "label": {"ru": "Согласование глагола", "uz": "Feʼl moslashuvi"},
        "explanation": {
            "ru": "Глагол должен согласоваться с подлежащим: he / she / it — с окончанием -s (he works).",
            "uz": "Feʼl ega bilan moslashishi kerak: he / she / it bilan -s qoʻshiladi (he works).",
        },
    },
    "other": {
        "label": {"ru": "Другая ошибка", "uz": "Boshqa xato"},
        "explanation": {
            "ru": "Сравните свою фразу с правильным вариантом и запишите его.",
            "uz": "Oʻz gapingizni toʻgʻri variant bilan solishtiring va uni yozing.",
        },
    },
}


def known_code(code: str | None) -> str:
    return code if code in ERROR_CODES else "other"


def label(code: str | None) -> Localized:
    return dict(ERROR_CODES[known_code(code)]["label"])


def explanation(code: str | None) -> Localized:
    return dict(ERROR_CODES[known_code(code)]["explanation"])
