"""Релиз 7: «Что нового» о социальном контуре публикуется при выкладке (system:release)

CONVENTIONS «Что нового в каждом релизе», образец — 0007_release_6:
(а) `s7-social` — опубликована, audience existing, сегмент age [teens, adults], иллюстрация s7-social: друзья по нику,
    лиги недели, дуэли, урок вдвоём, приглашение друга, безопасность;
(б) `s7-social-kids` — то же для детей (age [kids]), иллюстрация s7-family (семья учится вместе; без пьедестала —
    призовых мест у детей нет, фронтенд-ревью спринта 7 🟡7): на «ты», без давления, только семья — лига семьи
    («вместе набрали»), дуэль и урок вдвоём с родными (урок — выбор реплик, без голоса), без друзей и приглашений.
Названия экранов и кнопок — как в Mini App (apps/telegram-miniapp/src/i18n/*.social.ts): «Лига недели», «Дуэли»,
«Урок вдвоём», «Код друга», «Ник», «Общая лига», «Пожаловаться»; диагностика для ученика — «проверка уровня».

Публикация — как у сотрудника: status published, published_by = system:release, published_at = время миграции; в outbox
той же транзакции — experience.release_note.published.v1 и admin.audit.recorded.v1 (функции домена
`published_payload`, `audit_record`). Содержимое проверяет та же схема, что и заметку из админки (`NoteContent`,
переводы RU/UZ, лимиты длины, маршруты, иконки и иллюстрации каталога): ошибка — миграция падает, ничего не
публикуется. Метка уже занята действующей заметкой сотрудника — тоже падает (архивировать её и повторить выкладку).

Обратима: downgrade удаляет обе заметки, их отметки просмотра и ещё не отправленные события их публикации.

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-21
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

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

SEED_NS = uuid.UUID("5a0c3e1d-7b2f-4c8e-9d61-711e7e000000")  # пространство id сида experience-config (0004)
ACTOR = rn.RELEASE_ACTOR
RELEASE = "7"
ADULT_ID = uuid.uuid5(SEED_NS, "release_note:s7-social")
KIDS_ID = uuid.uuid5(SEED_NS, "release_note:s7-social-kids")
PUBLISH_REASON = "Релиз 7: публикация при выкладке"


def _item(icon: str, link: str, title: tuple[str, str], text: tuple[str, str]) -> dict[str, Any]:
    return {"title": {"ru": title[0], "uz": title[1]}, "text": {"ru": text[0], "uz": text[1]}, "link": link,
            "icon": icon}


TITLE = {"ru": "Учимся вместе: друзья, лиги и дуэли",
         "uz": "Birga oʻrganamiz: doʻstlar, ligalar va duellar"}

ADULT_ITEMS = [
    _item("users", "friends",
          ("Друзья по нику", "Nik orqali doʻstlar"),
          ("Задайте ник или поделитесь кодом друга. Заявку можно принять или отклонить, а того, кто мешает, — "
           "заблокировать: никто не узнает, кто это сделал.",
           "Nik qoʻying yoki doʻst kodingizni ulashing. Soʻrovni qabul qilish yoki rad etish, xalaqit berganni esa "
           "bloklash mumkin: buni kim qilganini hech kim bilmaydi.")),
    _item("trophy", "leagues",
          ("Лиги недели", "Hafta ligalari"),
          ("Соревнуйтесь в опыте за неделю с друзьями и семьёй. Общая лига — с 14 лет и только по желанию: там "
           "видно лишь ваш ник, а за 1–3 места — призы тилами.",
           "Doʻstlar va oila bilan haftalik tajribada bellashing. Umumiy liga — 14 yoshdan va faqat xohishga koʻra: "
           "unda faqat nikingiz koʻrinadi, 1–3-oʻrinlarga tillar beriladi.")),
    _item("star", "duels",
          ("Дуэли", "Duellar"),
          ("Вызовите друга: 10 одинаковых заданий для обоих и 48 часов на игру. Победителю — XP, ставок нет.",
           "Doʻstingizni chaqiring: ikkalangiz uchun bir xil 10 ta vazifa va oʻynash uchun 48 soat. Gʻolibga — XP, "
           "garov yoʻq.")),
    _item("chat", "friends",
          ("Урок вдвоём", "Juftlikda dars"),
          ("Пройдите сценарий с другом и ИИ-коучем: у каждого своя роль и свой отчёт, оценка — только по вашим "
           "ответам. Голосом — после согласия на запись голоса.",
           "Doʻstingiz va SI-murabbiy bilan ssenariyni oʻting: har kimning oʻz roli va oʻz hisoboti bor, baho — "
           "faqat javoblaringiz boʻyicha. Ovoz bilan — ovoz yozishga rozilikdan keyin.")),
    _item("gift", "referrals",
          ("Пригласите друга", "Doʻstingizni taklif qiling"),
          ("Приглашение засчитается, когда друг пройдёт проверку уровня и 3 урока в 2 разных дня. Ваша награда — "
           "2 заморозки.",
           "Doʻstingiz darajani tekshirishdan va 2 xil kunda 3 ta darsdan oʻtganda taklif hisobga olinadi. "
           "Mukofotingiz — 2 ta muzlatish.")),
    _item("shield", "friends",
          ("Безопасность", "Xavfsizlik"),
          ("Пожаловаться и заблокировать можно в один шаг. Модераторы видят только то, на что пожаловались, — "
           "переписку они не читают.",
           "Shikoyat qilish va bloklash — bir qadamda. Moderatorlar faqat shikoyat qilingan narsani koʻradi — "
           "yozishmalarni oʻqimaydi.")),
]

# Детям 6–13: на «ты», мягко, без давления; только семья (друзей и приглашений у детей нет); урок вдвоём — выбор
# реплик без голоса. «Моя семья» в Mini App открывается тем же переходом friends.
KIDS_TITLE = {"ru": "Учимся вместе с семьёй: лига, дуэли и урок вдвоём",
              "uz": "Oila bilan birga oʻrganamiz: liga, duellar va juftlikda dars"}

KIDS_ITEMS = [
    _item("trophy", "leagues",
          ("Лига семьи", "Oila ligasi"),
          ("Ты и твоя семья вместе копите опыт за неделю — в лиге видно, сколько набрали все вместе. Каждый урок и "
           "каждое повторение добавляют опыт.",
           "Sen va oilang hafta davomida birga tajriba yigʻasizlar — ligada birgalikda qancha toʻplanganini "
           "koʻrasan. Har bir dars va takrorlash tajriba qoʻshadi.")),
    _item("star", "duels",
          ("Дуэль с родными", "Oila bilan duel"),
          ("Позови кого-то из семьи на дуэль: 10 одинаковых заданий для обоих и 48 часов на игру. Ставок нет — "
           "только опыт.",
           "Oilangdan kimnidir duelga chaqir: ikkalangiz uchun bir xil 10 ta vazifa va oʻynash uchun 48 soat. "
           "Garov yoʻq — faqat tajriba.")),
    _item("chat", "friends",
          ("Урок вдвоём", "Juftlikda dars"),
          ("Ты и кто-то из семьи вместе проходите сценарий с коучем. Ты выбираешь реплики — печатать и говорить не "
           "нужно. У каждого свой отчёт.",
           "Sen va oilangdan kimdir murabbiy bilan birga ssenariyni oʻtasiz. Sen replikalarni tanlaysan — yozish "
           "ham, gapirish ham shart emas. Har kimning oʻz hisoboti bor.")),
    _item("shield", "friends",
          ("Только свои", "Faqat yaqinlaring"),
          ("В семье видны только ник, герой и опыт, а свои ответы видишь только ты. Незнакомых людей здесь нет. "
           "Если что-то не так — расскажи родителю.",
           "Oilada faqat nik, qahramon va tajriba koʻrinadi, javoblaringni esa faqat oʻzing koʻrasan. Bu yerda "
           "notanish odamlar yoʻq. Biror narsa yoqmasa — ota-onangga ayt.")),
]

NOTES: list[dict[str, Any]] = [
    {"id": ADULT_ID, "slug": "s7-social", "title": TITLE, "items": ADULT_ITEMS, "audience": "existing",
     "segments": {"age": ["teens", "adults"]}, "illustration": "s7-social"},
    {"id": KIDS_ID, "slug": "s7-social-kids", "title": KIDS_TITLE, "items": KIDS_ITEMS, "audience": "existing",
     "segments": {"age": ["kids"]}, "illustration": "s7-family"},
]

notes_table = sa.table(
    "release_notes",
    sa.column("id", pg.UUID(as_uuid=True)), sa.column("slug", sa.String), sa.column("title", pg.JSONB),
    sa.column("items", pg.JSONB), sa.column("audience", sa.String), sa.column("segments", pg.JSONB),
    sa.column("illustration", sa.String), sa.column("status", sa.String), sa.column("version", sa.Integer),
    sa.column("created_by", sa.String), sa.column("created_at", sa.DateTime(timezone=True)),
    sa.column("updated_by", sa.String), sa.column("updated_at", sa.DateTime(timezone=True)),
    sa.column("published_by", sa.String), sa.column("published_at", sa.DateTime(timezone=True)),
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
            continue  # уже опубликована (повторный подъём)
        taken = bind.execute(sa.select(notes_table.c.id).where(
            notes_table.c.slug == data["slug"], notes_table.c.status != "archived")).first()
        if taken is not None:
            raise RuntimeError(f"release note {data['slug']}: the label is taken by note {taken[0]} — archive it in the "
                               "admin panel and deploy again")
        op.execute(notes_table.insert().values(
            id=note["id"], **data, status="published", version=2, created_by=ACTOR, created_at=now,
            updated_by=ACTOR, updated_at=now, published_by=ACTOR, published_at=now))
        _emit(rn.PUBLISHED_EVENT, rn.published_payload(note["id"], data["slug"], data["audience"], data["segments"],
                                                        now), data["slug"])
        _emit(rn.AUDIT_EVENT, rn.audit_record(
            actor_type="system", actor_id=ACTOR, actor_role=None, action="release_note.publish", note_id=note["id"],
            slug=data["slug"], before=None,
            after={"status": "published", "items": len(data["items"]), "audience": data["audience"],
                   "segments": data["segments"], "illustration": data["illustration"], "published_at": rn.iso_z(now)},
            reason=PUBLISH_REASON, trace_id=None, occurred_at=now), data["slug"])


def downgrade() -> None:
    a, b = ADULT_ID, KIDS_ID
    # события публикации, которые ещё не ушли в шину, не отправляются (заметок больше нет)
    op.execute(sa.text(
        "DELETE FROM outbox WHERE published_at IS NULL AND event_type = :t "
        "AND envelope -> 'payload' ->> 'release_note_id' IN (:a, :b)"
    ).bindparams(t=rn.PUBLISHED_EVENT, a=str(a), b=str(b)))
    op.execute("ALTER TABLE release_notes DISABLE TRIGGER release_notes_guard")
    op.execute(sa.text("DELETE FROM release_note_views WHERE release_note_id IN (:a, :b)").bindparams(a=a, b=b))
    op.execute(sa.text("DELETE FROM release_notes WHERE id IN (:a, :b)").bindparams(a=a, b=b))
    op.execute("ALTER TABLE release_notes ENABLE TRIGGER release_notes_guard")
