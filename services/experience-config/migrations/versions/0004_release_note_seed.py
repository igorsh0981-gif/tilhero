"""seed «Что нового»: опубликованная welcome-1 (знакомство, audience new) и черновик 2026.11 (audience existing)

welcome-1 видит каждый ученик после первой регистрации (решение заказчика 18.11.2026): пять пунктов знакомства —
герой растёт за навыки, урок 20 минут, повторения, график и напоминания, семья. Сегментов нет — всем возрастам и обоим
языкам интерфейса, поэтому тексты подходят и детскому профилю (без давления и без «потерь»).
2026.11 — ЧЕРНОВИК для тех, кто уже занимается: ученики его не видят, пока сотрудник не опубликует заметку в админке.
Тексты RU и UZ (латиница). Данные самодостаточны (не импортируют код сервиса).

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-18
"""
import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

SEED_NS = uuid.UUID("5a0c3e1d-7b2f-4c8e-9d61-711e7e000000")
SEED_ACTOR = "system:seed"
AT = datetime(2026, 11, 17, 6, 0, tzinfo=UTC)
WELCOME_ID = uuid.uuid5(SEED_NS, "release_note:welcome-1")
DRAFT_ID = uuid.uuid5(SEED_NS, "release_note:2026.11")


def _item(icon: str, link: str, title: tuple[str, str], text: tuple[str, str]) -> dict:
    return {"icon": icon, "link": link, "title": {"ru": title[0], "uz": title[1]},
            "text": {"ru": text[0], "uz": text[1]}}


WELCOME_TITLE = {"ru": "Добро пожаловать в TilHero", "uz": "TilHero’ga xush kelibsiz"}
WELCOME_ITEMS = [
    _item("hero", "progress",
          ("Герой растёт вместе с вами", "Qahramon siz bilan birga oʻsadi"),
          ("Новая ступень героя — только за навык, который вы правда освоили. Это проверяет независимый оценщик, "
           "а не счётчик очков.",
           "Qahramon yangi bosqichga faqat haqiqatan oʻzlashtirgan koʻnikmangiz uchun chiqadi. Buni ochkolar "
           "hisoblagichi emas, mustaqil baholovchi tekshiradi.")),
    _item("clock", "lessons",
          ("Урок — 20 минут", "Dars — 20 daqiqa"),
          ("Повторение, объяснение, разговор с ИИ-коучем, проверка без подсказок и итоги. Легко уложить в перерыв "
           "или дорогу.",
           "Takrorlash, tushuntirish, AI-murabbiy bilan suhbat, yordamsiz tekshiruv va xulosa. Tanaffusda yoki "
           "yoʻlda bemalol ulgurasiz.")),
    _item("book", "review",
          ("Повторения в нужный момент", "Takrorlash — aynan kerakli paytda"),
          ("Слова и фразы вернутся, как только начнут забываться. Через 7 и 30 дней проверим, что навык закрепился.",
           "Soʻz va iboralar unutila boshlaganda yana qaytib keladi. 7 va 30 kundan keyin koʻnikma "
           "mustahkamlanganini tekshiramiz.")),
    _item("calendar", "schedule",
          ("Ваш график и напоминания", "Jadvalingiz va eslatmalar"),
          ("Дни, время и длительность занятий выбраны вами. Напомним вовремя, а в тихие часы промолчим. "
           "Поменять можно в профиле.",
           "Mashgʻulot kunlari, vaqti va davomiyligini oʻzingiz tanladingiz. Oʻz vaqtida eslatamiz, tinch "
           "soatlarda bezovta qilmaymiz. Profilda oʻzgartirish mumkin.")),
    _item("users", "family",
          ("Учитесь всей семьёй", "Butun oila bilan oʻrganing"),
          ("Занимайтесь вместе с близкими: взрослый приглашает семью по ссылке, а у детей 6–13 лет свой профиль "
           "в аккаунте родителя.",
           "Yaqinlaringiz bilan birga shugʻullaning: kattalar oilani havola orqali taklif qiladi, 6–13 yoshli "
           "bolalarning esa ota-ona akkauntida oʻz profili bor.")),
]

DRAFT_TITLE = {"ru": "Ноябрь 2026", "uz": "2026-yil noyabr"}
DRAFT_ITEMS = [
    _item("bell", "notifications",
          ("Все сообщения в одном месте", "Barcha xabarlar bir joyda"),
          ("Напоминания, приглашения и ответы поддержки собраны в центре уведомлений. Ничего не потеряется, "
           "даже если бот на паузе.",
           "Eslatmalar, takliflar va qoʻllab-quvvatlash javoblari bildirishnomalar markazida jamlangan. Bot "
           "toʻxtatilgan boʻlsa ham, hech narsa yoʻqolmaydi.")),
    _item("globe", "profile",
          ("Интерфейс на узбекском", "Oʻzbek tilidagi interfeys"),
          ("Переключите язык в профиле: меню и подсказки станут узбекскими, а курс английского останется прежним.",
           "Tilni profilda almashtiring: menyu va maslahatlar oʻzbekcha boʻladi, ingliz tili kursi esa "
           "oʻzgarmaydi.")),
    _item("calendar", "schedule",
          ("Мягкие напоминания о пропусках", "Oʻtkazib yuborilgan dars haqida yumshoq eslatma"),
          ("Пропустили занятие — напомним один раз на следующий день. Если пропусков несколько подряд — "
           "не чаще раза в неделю.",
           "Mashgʻulotni oʻtkazib yuborsangiz, ertasi kuni bir marta eslatamiz. Ketma-ket bir necha marta "
           "oʻtkazilsa — haftasiga bir martadan koʻp emas.")),
]


def upgrade() -> None:
    notes = sa.table(
        "release_notes",
        sa.column("id", pg.UUID(as_uuid=True)), sa.column("slug", sa.String), sa.column("title", pg.JSONB),
        sa.column("items", pg.JSONB), sa.column("audience", sa.String), sa.column("segments", pg.JSONB),
        sa.column("status", sa.String), sa.column("version", sa.Integer), sa.column("created_by", sa.String),
        sa.column("created_at", sa.DateTime(timezone=True)), sa.column("updated_by", sa.String),
        sa.column("updated_at", sa.DateTime(timezone=True)), sa.column("published_by", sa.String),
        sa.column("published_at", sa.DateTime(timezone=True)),
    )
    common = {"segments": {}, "created_by": SEED_ACTOR, "created_at": AT, "updated_by": SEED_ACTOR, "updated_at": AT}
    # ON CONFLICT DO NOTHING (тот же id или занятая метка): после отката 0004 опубликованная welcome-1 остаётся
    # в таблице (триггер не даёт удалить не-черновик), повторный upgrade не должен падать на дубле
    op.execute(pg.insert(notes).values(
        id=WELCOME_ID, slug="welcome-1", title=WELCOME_TITLE, items=WELCOME_ITEMS, audience="new",
        status="published", version=2, published_by=SEED_ACTOR, published_at=AT, **common,
    ).on_conflict_do_nothing())
    op.execute(pg.insert(notes).values(
        id=DRAFT_ID, slug="2026.11", title=DRAFT_TITLE, items=DRAFT_ITEMS, audience="existing",
        status="draft", version=1, **common,
    ).on_conflict_do_nothing())


def downgrade() -> None:
    # Только черновики: опубликованную/архивную заметку триггер удалить не даст, её снимет откат 0003 вместе с таблицей.
    op.execute(sa.text("DELETE FROM release_notes WHERE id IN (:a, :b) AND status = 'draft'")
               .bindparams(a=WELCOME_ID, b=DRAFT_ID))
