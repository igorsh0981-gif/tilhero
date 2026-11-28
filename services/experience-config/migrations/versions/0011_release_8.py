"""Релиз 8: «Что нового» о подписке за Telegram Stars — ЧЕРНОВИКОМ, без публикации

PLAN спринта 8, решение координатора 20 (и DoD): заметка спринта 8 готовится в спринте (тексты, иллюстрации, миграция,
тесты), а **публикуется вместе с включением продаж в Mini App** (флаги STARS_ENABLED / BILLING_ENFORCED; релиз 8.1,
если к мержу продажи не включаются). Поэтому, в отличие от образца CONVENTIONS §10 (0007_release_6, 0009_release_7),
миграция создаёт две заметки в статусе draft от имени выкладки (`created_by = updated_by = "system:release"`,
`published_*` пусты): ученик их не видит, пока сотрудник не опубликует заметку в «Новости и „Что нового“»
(`whatsnew.publish` + TOTP) в день включения продаж — или релиз 8.1 не опубликует их своей миграцией. Черновик можно
поправить (цены и сроки пробного — стартовые значения В3–В4, их могут изменить в каталоге до включения).

(а) `s8-plus` — audience existing, сегмент age [teens, adults], на «вы», иллюстрация s8-plus: подписка «Плюс» за
    Telegram Stars в Mini App, уроки с ИИ и ИИ-минуты, уроки вдвоём, пробный период, тилы за Stars, бесплатное остаётся
    бесплатным;
(б) `s8-plus-kids` — age [kids], на «ты», мягко, иллюстрация s8-plus-kids: учёба как прежде, урок вдвоём с семьёй,
    статус подписки семьи, оценки — только за знания. Без цен, без призывов купить и без «попроси родителя».
Анти-стиринг (решение владельца В1): только подписка за Stars — ни сайта оплаты, ни Payme / Click / Uzum, ни цен в
сумах, ни «другого способа оплаты». Названия экранов — как в Mini App (apps/telegram-miniapp/src/i18n/*.billing.ts):
«Подписка» / «Obuna», «ИИ-минуты» / «SI daqiqalari», «Уроки с ИИ» / «SI bilan darslar». Переходы subscription и
til_shop, иллюстрации s8-plus и s8-plus-kids — из блока planned каталога packages/contracts/release-notes.json (перенос
в основные списки и файлы иллюстраций — потоки I и E до публикации).

Содержимое проверяет та же схема, что и заметку из админки (`NoteContent`, переводы RU/UZ, лимиты, каталог): ошибка —
миграция падает, ничего не создаётся. Метка занята действующей заметкой сотрудника — тоже падает (архивировать её и
повторить выкладку). В outbox той же транзакции — аудит `release_note.create` (actor_type system), как у создания
черновика сотрудником; события публикации нет.

Обратима: downgrade удаляет обе заметки (в каком бы статусе они ни были), их отметки просмотра и ещё не отправленные
события их публикации.

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-22
"""
import uuid
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

from tilhero_common.errors import ApiError
from tilhero_common.messaging import make_envelope
from tilhero_experience.domain import release_notes as rn

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

SEED_NS = uuid.UUID("5a0c3e1d-7b2f-4c8e-9d61-711e7e000000")  # пространство id сида experience-config (0004)
ACTOR = rn.RELEASE_ACTOR
RELEASE = "8"
ADULT_ID = uuid.uuid5(SEED_NS, "release_note:s8-plus")
KIDS_ID = uuid.uuid5(SEED_NS, "release_note:s8-plus-kids")
STATUS = "draft"  # решение 20: публикация — вместе с включением продаж в Mini App


def _item(icon: str, link: str, title: tuple[str, str], text: tuple[str, str]) -> dict[str, Any]:
    return {"title": {"ru": title[0], "uz": title[1]}, "text": {"ru": text[0], "uz": text[1]}, "link": link,
            "icon": icon}


TITLE = {"ru": "Подписка «Плюс»: уроки с ИИ и уроки вдвоём",
         "uz": "«Plus» obunasi: SI bilan darslar va juftlikda darslar"}

ADULT_ITEMS = [
    _item("star", "subscription",
          ("Подписка за Telegram Stars", "Telegram Stars evaziga obuna"),
          ("Оформите «Плюс» прямо в TilHero и оплатите звёздами Telegram (в 14–17 лет — с согласия родителя). "
           "Подписка на 30 дней продлевается сама, отключить можно в любой момент.",
           "«Plus»ni TilHero ichida rasmiylashtiring va Telegram yulduzlari bilan toʻlang (14–17 yoshda — ota-ona "
           "roziligi bilan). 30 kunlik obuna oʻzi uzaytiriladi, istalgan payt oʻchirish mumkin.")),
    _item("chat", "subscription",
          ("Уроки с ИИ", "SI bilan darslar"),
          ("С подпиской уроки и сценарии идут со свободным разговором и разбором ответов — в пределах ИИ-минут "
           "месяца. Счётчик минут — в разделе «Подписка».",
           "Obuna bilan darslar va ssenariylar erkin suhbat va javoblar tahlili bilan oʻtadi — oylik SI daqiqalari "
           "doirasida. Daqiqalar hisobi — «Obuna» boʻlimida.")),
    _item("users", "friends",
          ("Уроки вдвоём", "Juftlikda darslar"),
          ("Позвать друга на урок вдвоём с ИИ-коучем можно с подпиской: минуты спишутся у вас, один раз за урок. "
           "Принять приглашение можно и без подписки.",
           "Doʻstingizni SI-murabbiy bilan juftlikda darsga obuna bilan chaqirish mumkin: daqiqalar sizdan, bir dars "
           "uchun bir marta yechiladi. Taklifni obunasiz ham qabul qilish mumkin.")),
    _item("gift", "subscription",
          ("Пробный период", "Sinov davri"),
          ("Попробуйте подписку бесплатно: 7 дней и 60 ИИ-минут — один раз на аккаунт, без оплаты.",
           "Obunani bepul sinab koʻring: 7 kun va 60 SI daqiqasi — bir akkauntga bir marta, toʻlovsiz.")),
    _item("hero", "til_shop",
          ("Тилы за Stars", "Stars evaziga tillar"),
          ("Не хватает тилов в магазине героя? Купите пакет за звёзды — себе или в детский профиль.",
           "Qahramon doʻkonida tillar yetmayaptimi? Yulduzlar evaziga paket oling — oʻzingizga yoki bola profiliga.")),
    _item("book", "lessons",
          ("Бесплатное остаётся бесплатным", "Bepul narsalar bepulligicha qoladi"),
          ("Базовый курс, повторения, чтение, произношение, дуэли и игра работают без подписки. Подписка не меняет "
           "оценки и уровень.",
           "Asosiy kurs, takrorlash, oʻqish, talaffuz, duellar va oʻyin obunasiz ishlaydi. Obuna baholar va darajani "
           "oʻzgartirmaydi.")),
]

# Детям 6–13: на «ты», мягко, без цен, без покупок и без «попроси родителя» (CONVENTIONS §8, решение 9: детский
# профиль цен и кнопок оплаты не видит). ИИ в уроках у детей не включается (спринт 4) — подписка для них ничего не
# меняет; комната с ребёнком — сценарий без ИИ (В9).
KIDS_TITLE = {"ru": "Учёба продолжается, как и раньше",
              "uz": "Oʻqish avvalgidek davom etadi"}

KIDS_ITEMS = [
    _item("book", "lessons",
          ("Учёба как прежде", "Oʻqish avvalgidek"),
          ("Уроки, повторения, чтение и игра работают как обычно. Ничего делать не нужно — просто занимайся.",
           "Darslar, takrorlash, oʻqish va oʻyin odatdagidek ishlaydi. Hech narsa qilish shart emas — shunchaki "
           "shugʻullan.")),
    _item("users", "friends",
          ("Урок вдвоём с семьёй", "Oila bilan juftlikda dars"),
          ("Урок вдвоём с родными — как и раньше: ты и кто-то из семьи проходите сценарий вместе, а реплики ты "
           "выбираешь сам.",
           "Yaqinlaring bilan juftlikda dars — avvalgidek: sen va oilangdan kimdir ssenariyni birga oʻtasiz, "
           "replikalarni esa oʻzing tanlaysan.")),
    _item("star", "subscription",
          ("Подписка семьи", "Oila obunasi"),
          ("Если у родителя есть подписка, в разделе «Подписка» видно, до какого дня она действует.",
           "Ota-onangda obuna boʻlsa, «Obuna» boʻlimida u qaysi kungacha amal qilishini koʻrasan.")),
    _item("shield", "progress",
          ("Оценки — за знания", "Baholar — bilim uchun"),
          ("Твой уровень и оценки зависят только от уроков и твоих ответов.",
           "Darajang va baholaring faqat darslar va javoblaringga bogʻliq.")),
]

NOTES: list[dict[str, Any]] = [
    {"id": ADULT_ID, "slug": "s8-plus", "title": TITLE, "items": ADULT_ITEMS, "audience": "existing",
     "segments": {"age": ["teens", "adults"]}, "illustration": "s8-plus"},
    {"id": KIDS_ID, "slug": "s8-plus-kids", "title": KIDS_TITLE, "items": KIDS_ITEMS, "audience": "existing",
     "segments": {"age": ["kids"]}, "illustration": "s8-plus-kids"},
]

notes_table = sa.table(
    "release_notes",
    sa.column("id", pg.UUID(as_uuid=True)), sa.column("slug", sa.String), sa.column("title", pg.JSONB),
    sa.column("items", pg.JSONB), sa.column("audience", sa.String), sa.column("segments", pg.JSONB),
    sa.column("illustration", sa.String), sa.column("status", sa.String), sa.column("version", sa.Integer),
    sa.column("created_by", sa.String), sa.column("created_at", sa.DateTime(timezone=True)),
    sa.column("updated_by", sa.String), sa.column("updated_at", sa.DateTime(timezone=True)),
)
outbox_table = sa.table(
    "outbox",
    sa.column("id", pg.UUID(as_uuid=False)), sa.column("event_type", sa.String), sa.column("envelope", pg.JSONB),
    sa.column("published_at", sa.DateTime(timezone=True)),
)


def checked(note: dict[str, Any]) -> dict[str, Any]:
    """Содержимое заметки релиза через ту же проверку, что и заметка из админки → поля строки release_notes."""
    content = {k: note[k] for k in ("slug", "title", "items", "audience", "segments", "illustration")}
    try:
        data = rn.dump_content(rn.NoteContent.model_validate(content))
        rn.ensure_translations(data["title"], data["items"])
    except ApiError as exc:
        raise RuntimeError(f"release note {note['slug']}: {exc.code} {exc.details}") from None
    except ValueError as exc:  # pydantic.ValidationError
        raise RuntimeError(f"release note {note['slug']}: invalid content: {exc}") from None
    if data != content:
        raise RuntimeError(f"release note {note['slug']}: content is not normalized (spaces, order of segments)")
    return data


def _emit(event_type: str, payload: dict[str, Any], slug: str) -> None:
    env = make_envelope(event_type, payload, producer=rn.PRODUCER, correlation_id=f"release-{RELEASE}:{slug}")
    op.bulk_insert(outbox_table, [{"id": env.event_id, "event_type": env.event_type,
                                   "envelope": env.model_dump(mode="json")}])


def upgrade() -> None:
    bind = op.get_bind()
    now = datetime.now(UTC)
    rows = [(note, checked(note)) for note in NOTES]  # всё проверено до первой записи

    for note, data in rows:
        if bind.execute(sa.select(notes_table.c.id).where(notes_table.c.id == note["id"])).first() is not None:
            continue  # уже создана (повторный подъём)
        taken = bind.execute(sa.select(notes_table.c.id).where(
            notes_table.c.slug == data["slug"], notes_table.c.status != "archived")).first()
        if taken is not None:
            raise RuntimeError(f"release note {data['slug']}: the label is taken by note {taken[0]} — archive it in the "
                               "admin panel and deploy again")
        op.execute(notes_table.insert().values(
            id=note["id"], **data, status=STATUS, version=1, created_by=ACTOR, created_at=now, updated_by=ACTOR,
            updated_at=now))
        _emit(rn.AUDIT_EVENT, rn.audit_record(
            actor_type="system", actor_id=ACTOR, actor_role=None, action="release_note.create", note_id=note["id"],
            slug=data["slug"], before=None,
            after={"status": STATUS, "items": len(data["items"]), "audience": data["audience"],
                   "segments": data["segments"], "illustration": data["illustration"]},
            reason=None, trace_id=None, occurred_at=now), data["slug"])


def downgrade() -> None:
    a, b = ADULT_ID, KIDS_ID
    # события публикации (если сотрудник успел опубликовать), которые ещё не ушли в шину, не отправляются
    op.execute(sa.text(
        "DELETE FROM outbox WHERE published_at IS NULL AND event_type = :t "
        "AND envelope -> 'payload' ->> 'release_note_id' IN (:a, :b)"
    ).bindparams(t=rn.PUBLISHED_EVENT, a=str(a), b=str(b)))
    op.execute("ALTER TABLE release_notes DISABLE TRIGGER release_notes_guard")
    op.execute(sa.text("DELETE FROM release_note_views WHERE release_note_id IN (:a, :b)").bindparams(a=a, b=b))
    op.execute(sa.text("DELETE FROM release_notes WHERE id IN (:a, :b)").bindparams(a=a, b=b))
    op.execute("ALTER TABLE release_notes ENABLE TRIGGER release_notes_guard")
