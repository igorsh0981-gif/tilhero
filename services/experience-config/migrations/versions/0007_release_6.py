"""Релиз 6.1: «Что нового» о спринтах 5–6 публикуется при выкладке (system:release)

Ученики не узнали о релизах 5, 5.1 и 6: заметки публиковал вручную сотрудник. С релиза 6.1 каждый релиз несёт такую
миграцию (CONVENTIONS «Что нового в каждом релизе»):
(а) `s6-heroes` — опубликована, audience existing, сегмент age [teens, adults], иллюстрация s6-heroes;
(б) `s6-heroes-kids` — то же для детей (age [kids]): на «ты», без давления, без приглашения друзей, произношение —
    с разрешения родителя;
    кнопка произношения в UZ названа как в Mini App — «Talaffuz qilish» (pn.button), а не «Talaffuz»;
(в) приветствию `welcome-1` проставлена иллюстрация `welcome` (опубликованная заметка неизменна — триггер
    release_notes_guard снимается на время одного UPDATE, это может только владелец схемы);
(г) черновик `2026.11` архивирован: устарел, его содержание покрыто приветствием и s6-heroes.

Публикация — как у сотрудника: статус published, published_by = system:release, published_at = время миграции;
в outbox в той же транзакции — experience.release_note.published.v1 и admin.audit.recorded.v1 (payload строят те же
функции домена `published_payload` и `audit_record`). notifications кладёт заметку в центр уведомлений (категория
product); при следующем входе ученик сегмента видит её в «Что нового» один раз.

Содержимое проверяется той же схемой, что и заметка из админки (`NoteContent`, переводы RU/UZ, лимиты длины, маршруты,
иконки и иллюстрации каталога): ошибка — миграция падает, ничего не публикуется. Метка уже занята действующей
заметкой сотрудника — тоже падает (архивировать её в админке и повторить выкладку).

Обратима: downgrade удаляет обе заметки и их отметки просмотра, ещё не отправленные события их публикации, возвращает
черновик 2026.11 (если метку не заняла новая заметка) и снимает иллюстрацию приветствия.

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-20
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

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

SEED_NS = uuid.UUID("5a0c3e1d-7b2f-4c8e-9d61-711e7e000000")  # пространство id сида experience-config (0004)
ACTOR = rn.RELEASE_ACTOR
RELEASE = "6.1"
ADULT_ID = uuid.uuid5(SEED_NS, "release_note:s6-heroes")
KIDS_ID = uuid.uuid5(SEED_NS, "release_note:s6-heroes-kids")
WELCOME_ID = uuid.uuid5(SEED_NS, "release_note:welcome-1")
DRAFT_ID = uuid.uuid5(SEED_NS, "release_note:2026.11")
DRAFT_SLUG = "2026.11"
PUBLISH_REASON = "Релиз 6.1: публикация при выкладке"
ILLUSTRATE_REASON = "Релиз 6.1: иллюстрация приветствия"
ARCHIVE_REASON = "Релиз 6.1: черновик устарел — его содержание покрыто приветствием и s6-heroes"


def _item(icon: str, link: str, title: tuple[str, str], text: tuple[str, str]) -> dict[str, Any]:
    return {"title": {"ru": title[0], "uz": title[1]}, "text": {"ru": text[0], "uz": text[1]}, "link": link,
            "icon": icon}


TITLE = {"ru": "Новое в TilHero: герои, тилы и повторения",
         "uz": "TilHero’da yangi: qahramonlar, tillar va takrorlash"}

ADULT_ITEMS = [
    _item("hero", "heroes",
          ("Выберите героя", "Qahramon tanlang"),
          ("9 героев растут вместе с вами: новая ступень — за навыки, подтверждённые в уроках. Сменить героя можно "
           "в любой момент.",
           "9 ta qahramon siz bilan birga oʻsadi: yangi bosqich — darslarda tasdiqlangan koʻnikmalar uchun. "
           "Qahramonni istalgan vaqtda almashtirish mumkin.")),
    _item("gift", "home",
          ("Тилы и задания дня", "Tillar va kunlik vazifalar"),
          ("За уроки и повторения начисляются опыт и тилы. Каждый день — три задания, за все три — бонус.",
           "Darslar va takrorlash uchun tajriba va tillar beriladi. Har kuni uchta vazifa, uchalasi uchun — bonus.")),
    _item("flame", "shop",
          ("Серия под защитой", "Seriya himoyada"),
          ("Пропустили день? Заморозка сохранит серию. Две заморозки уже ждут вас, ещё две — за друга, который "
           "начнёт заниматься.",
           "Bir kunni oʻtkazib yubordingizmi? Muzlatish seriyani saqlab qoladi. Ikkita muzlatish sizni kutmoqda, "
           "yana ikkitasi — oʻqishni boshlagan doʻst uchun.")),
    _item("book", "review",
          ("Повторение дня", "Kun takrori"),
          ("Слова и ошибки из уроков попадают в личный словарь и возвращаются в нужный момент, чтобы не забыться.",
           "Darslardagi soʻzlar va xatolar shaxsiy lugʻatga tushadi va unutilmasligi uchun kerakli paytda qaytadi.")),
    _item("mic", "dictionary",
          ("Произношение", "Talaffuz"),
          ("Нажмите «Произнести» в словаре или в тексте — мы оценим каждое слово. Запись сразу удаляется.",
           "Lugʻat yoki matnda «Talaffuz qilish» tugmasini bosing — har bir soʻzni baholaymiz. "
           "Yozuv darhol oʻchiriladi.")),
    _item("book", "reading",
          ("Чтение с переводом", "Tarjimali oʻqish"),
          ("Короткие тексты по уровню: нажмите на слово, чтобы увидеть перевод и добавить его в словарь.",
           "Darajangizga mos qisqa matnlar: tarjimani koʻrish va lugʻatga qoʻshish uchun soʻzni bosing.")),
]

# Детям 6–13: на «ты», мягко, без давления; дети не приглашают друзей (рефералов нет); голос — с разрешения родителя.
KIDS_ITEMS = [
    _item("hero", "heroes",
          ("Выбери героя", "Qahramon tanla"),
          ("9 героев растут вместе с тобой: новая ступень — за навыки, которые получаются у тебя в уроках. Поменять "
           "героя можно когда захочешь.",
           "9 ta qahramon sen bilan birga oʻsadi: yangi bosqich — darslarda oʻrgangan koʻnikmalaring uchun. "
           "Qahramonni xohlagan paytda almashtirsa boʻladi.")),
    _item("gift", "home",
          ("Тилы и задания дня", "Tillar va kunlik vazifalar"),
          ("За уроки и повторения ты получаешь опыт и тилы. Каждый день — три задания, за все три — бонус. "
           "Не успеешь — ничего страшного, завтра будут новые.",
           "Darslar va takrorlash uchun tajriba va tillar olasan. Har kuni uchta vazifa, uchalasi uchun — bonus. "
           "Ulgurmasang ham hechqisi yoʻq — ertaga yangilari boʻladi.")),
    _item("flame", "shop",
          ("Заморозка — твой помощник", "Muzlatish — sening yordamching"),
          ("Заморозка сохранит серию, если пропустишь день. Две заморозки уже ждут тебя.",
           "Kunni oʻtkazib yuborsang, muzlatish seriyangni saqlab qoladi. Ikkita muzlatish seni kutmoqda.")),
    _item("book", "review",
          ("Повторение дня", "Kun takrori"),
          ("Слова и ошибки из уроков попадают в твой словарь и возвращаются в нужный момент — так они лучше "
           "запоминаются.",
           "Darslardagi soʻzlar va xatolar lugʻatingga tushadi va kerakli paytda qaytadi — shunda ular yaxshi "
           "esda qoladi.")),
    _item("mic", "dictionary",
          ("Произношение", "Talaffuz"),
          ("С разрешения родителя нажми «Произнести» в словаре или в тексте — мы оценим каждое слово. Запись сразу "
           "удаляется.",
           "Ota-onang ruxsat bersa, lugʻat yoki matnda «Talaffuz qilish» tugmasini bos — har bir soʻzni baholaymiz. "
           "Yozuv darhol oʻchiriladi.")),
    _item("book", "reading",
          ("Чтение с переводом", "Tarjimali oʻqish"),
          ("Короткие тексты по твоему уровню: нажми на слово, чтобы увидеть перевод и добавить его в словарь.",
           "Darajangga mos qisqa matnlar: tarjimani koʻrish va lugʻatga qoʻshish uchun soʻzni bos.")),
]

NOTES: list[dict[str, Any]] = [
    {"id": ADULT_ID, "slug": "s6-heroes", "title": TITLE, "items": ADULT_ITEMS, "audience": "existing",
     "segments": {"age": ["teens", "adults"]}, "illustration": "s6-heroes"},
    {"id": KIDS_ID, "slug": "s6-heroes-kids", "title": TITLE, "items": KIDS_ITEMS, "audience": "existing",
     "segments": {"age": ["kids"]}, "illustration": "s6-heroes"},
]

notes_table = sa.table(
    "release_notes",
    sa.column("id", pg.UUID(as_uuid=True)), sa.column("slug", sa.String), sa.column("title", pg.JSONB),
    sa.column("items", pg.JSONB), sa.column("audience", sa.String), sa.column("segments", pg.JSONB),
    sa.column("illustration", sa.String), sa.column("status", sa.String), sa.column("version", sa.Integer),
    sa.column("created_by", sa.String), sa.column("created_at", sa.DateTime(timezone=True)),
    sa.column("updated_by", sa.String), sa.column("updated_at", sa.DateTime(timezone=True)),
    sa.column("published_by", sa.String), sa.column("published_at", sa.DateTime(timezone=True)),
    sa.column("archived_by", sa.String), sa.column("archived_at", sa.DateTime(timezone=True)),
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


def _audit(action: str, note_id: uuid.UUID, slug: str, before: dict | None, after: dict | None, reason: str,
           at: datetime) -> None:
    _emit(rn.AUDIT_EVENT, rn.audit_record(
        actor_type="system", actor_id=ACTOR, actor_role=None, action=action, note_id=note_id, slug=slug,
        before=before, after=after, reason=reason, trace_id=None, occurred_at=at), slug)


def _guard(enabled: bool) -> None:
    op.execute(f"ALTER TABLE release_notes {'ENABLE' if enabled else 'DISABLE'} TRIGGER release_notes_guard")


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
        _audit("release_note.publish", note["id"], data["slug"], None,
               {"status": "published", "items": len(data["items"]), "audience": data["audience"],
                "segments": data["segments"], "illustration": data["illustration"], "published_at": rn.iso_z(now)},
               PUBLISH_REASON, now)

    # (в) иллюстрация приветствия: опубликованная заметка неизменна — триггер снимается на один UPDATE
    welcome = bind.execute(sa.select(notes_table.c.slug).where(
        notes_table.c.id == WELCOME_ID, notes_table.c.status == "published", notes_table.c.illustration.is_(None)
    )).first()
    if welcome is not None:
        _guard(False)
        op.execute(notes_table.update().where(notes_table.c.id == WELCOME_ID).values(
            illustration="welcome", version=notes_table.c.version + 1, updated_by=ACTOR, updated_at=now))
        _guard(True)
        _audit("release_note.update", WELCOME_ID, welcome[0], {"illustration": None},
               {"changed": ["illustration"], "illustration": "welcome"}, ILLUSTRATE_REASON, now)

    # (г) черновик 2026.11 — в архив (черновик архивируется и без снятия триггера)
    draft = bind.execute(sa.select(notes_table.c.slug).where(
        notes_table.c.id == DRAFT_ID, notes_table.c.status == "draft")).first()
    if draft is not None:
        op.execute(notes_table.update().where(notes_table.c.id == DRAFT_ID).values(
            status="archived", archived_by=ACTOR, archived_at=now, version=notes_table.c.version + 1,
            updated_by=ACTOR, updated_at=now))
        _audit("release_note.archive", DRAFT_ID, draft[0], {"status": "draft"}, {"status": "archived"},
               ARCHIVE_REASON, now)


def downgrade() -> None:
    ids = [ADULT_ID, KIDS_ID]
    # события публикации, которые ещё не ушли в шину, не отправляются (заметок больше нет)
    op.execute(sa.text(
        "DELETE FROM outbox WHERE published_at IS NULL AND event_type = :t "
        "AND envelope -> 'payload' ->> 'release_note_id' IN (:a, :b)"
    ).bindparams(t=rn.PUBLISHED_EVENT, a=str(ADULT_ID), b=str(KIDS_ID)))
    _guard(False)
    op.execute(sa.text("DELETE FROM release_note_views WHERE release_note_id IN (:a, :b)").bindparams(a=ids[0], b=ids[1]))
    op.execute(sa.text("DELETE FROM release_notes WHERE id IN (:a, :b)").bindparams(a=ids[0], b=ids[1]))
    op.execute(sa.text(
        "UPDATE release_notes SET status = 'draft', archived_by = NULL, archived_at = NULL, version = version + 1, "
        "updated_by = :actor, updated_at = now() "
        "WHERE id = :id AND status = 'archived' AND archived_by = :actor AND NOT EXISTS ("
        "  SELECT 1 FROM release_notes o WHERE o.slug = :slug AND o.status <> 'archived' AND o.id <> :id)"
    ).bindparams(id=DRAFT_ID, actor=ACTOR, slug=DRAFT_SLUG))
    op.execute(sa.text(
        "UPDATE release_notes SET illustration = NULL, version = version + 1, updated_by = :actor, updated_at = now() "
        "WHERE id = :id AND illustration = 'welcome'"
    ).bindparams(id=WELCOME_ID, actor=ACTOR))
    _guard(True)
