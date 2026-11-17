"""Маршрутизация Telegram update → действие (чистые функции, без сети).

Ответ на команду возвращается прямо в ответе на webhook (метод Bot API в теле ответа): так ack ≤ 1 с
не зависит от исходящего запроса в Telegram, а токен бота вообще не участвует.
Сетевые побочные эффекты (статус бота в identity-consent) выполняются фоном после ответа.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from tilhero_botgw.texts import COMMAND_SECTIONS, START_PARAM_RE, lang_of, t, webapp_url

COMMAND_TEXT: dict[str, tuple[str, str]] = {  # команда → (ключ текста, ключ кнопки)
    "events": ("events", "events_btn"),
    "watch": ("watch", "watch_btn"),
    "support": ("support", "support_btn"),
    "help": ("help", "open"),
}


@dataclass(frozen=True)
class UpdateAction:
    reply: dict[str, Any] | None = None  # метод Bot API для ответа в теле webhook
    chat_id: int | None = None  # для анти-спам лимита ответов
    bot_status: tuple[int, bool] | None = None  # (telegram_user_id, blocked) → identity-consent
    ops_chat_candidate: int | None = None  # бота добавили в группу: id чата для OPS_ALERT_CHAT_ID (только лог)
    ops_chat_title: str = ""  # название группы (≤ 64, без управляющих символов) — чтобы узнать нужную группу


def parse_command(text: str) -> tuple[str, str] | None:
    """«/start@TilHeroBot evt_1» → ("start", "evt_1")."""
    if not text.startswith("/"):
        return None
    head, _, rest = text.partition(" ")
    name = head[1:].split("@", 1)[0].lower()
    if not name:
        return None
    return name, rest.strip()


def _open_message(chat_id: int, text: str, button: str, url: str) -> dict[str, Any]:
    return {
        "method": "sendMessage",
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "link_preview_options": {"is_disabled": True},
        "reply_markup": {"inline_keyboard": [[{"text": button, "web_app": {"url": url}}]]},
    }


def route_update(update: dict[str, Any], miniapp_url: str) -> UpdateAction:
    if isinstance(update.get("message"), dict):
        return _on_message(update["message"], miniapp_url)
    if isinstance(update.get("callback_query"), dict):
        cq = update["callback_query"]
        sender = _dict(cq.get("from"))
        if not isinstance(cq.get("id"), str):
            return UpdateAction()
        lang = lang_of(sender.get("language_code"))
        return UpdateAction(
            reply={"method": "answerCallbackQuery", "callback_query_id": cq["id"], "text": t(lang, "soon")}
        )
    if isinstance(update.get("my_chat_member"), dict):
        return _on_member(update["my_chat_member"])
    return UpdateAction()


def _on_message(msg: dict[str, Any], miniapp_url: str) -> UpdateAction:
    chat = _dict(msg.get("chat"))
    sender = _dict(msg.get("from"))
    chat_id = chat.get("id")
    if chat.get("type") != "private" or not isinstance(chat_id, int) or sender.get("is_bot"):
        return UpdateAction()  # группы и боты игнорируются: бот работает только в личном чате
    lang = lang_of(sender.get("language_code"))
    text = _str(msg.get("text"))
    command = parse_command(text)
    name, arg = command if command else ("start", "")

    if name in COMMAND_TEXT:
        text_key, button_key = COMMAND_TEXT[name]
        return UpdateAction(
            reply=_open_message(
                chat_id,
                t(lang, text_key),
                t(lang, button_key),
                webapp_url(miniapp_url, COMMAND_SECTIONS[name]),
            ),
            chat_id=chat_id,
        )
    # /start [param], неизвестные команды и обычный текст: приветствие + кнопка «Открыть TilHero»
    section = arg if name == "start" and START_PARAM_RE.match(arg) else COMMAND_SECTIONS["start"]
    first_name = _str(sender.get("first_name"))
    first_name = first_name.strip()[:64]
    greeting = t(lang, "hello", name=first_name) if first_name else t(lang, "hello_anon")
    return UpdateAction(
        reply=_open_message(chat_id, greeting, t(lang, "open"), webapp_url(miniapp_url, section)),
        chat_id=chat_id,
    )


def _on_member(update: dict[str, Any]) -> UpdateAction:
    """my_chat_member в личном чате: kicked — пользователь заблокировал бота, member — разблокировал.
    В группе/супергруппе: бота добавили (member/administrator) — кандидат в чат операторов (спринт 8, §6)."""
    chat = _dict(update.get("chat"))
    new = _dict(update.get("new_chat_member"))
    if chat.get("type") in ("group", "supergroup"):
        chat_id = chat.get("id")
        if isinstance(chat_id, int) and chat_id < 0 and new.get("status") in ("member", "administrator"):
            raw = _str(chat.get("title"))
            title = "".join(ch for ch in raw if ch.isprintable())[:64]
            return UpdateAction(ops_chat_candidate=chat_id, ops_chat_title=title)
        return UpdateAction()
    sender = _dict(update.get("from"))
    user_id = sender.get("id")
    if chat.get("type") != "private" or not isinstance(user_id, int) or user_id <= 0:
        return UpdateAction()
    status = new.get("status")
    if status == "kicked":
        return UpdateAction(bot_status=(user_id, True))
    if status == "member":
        return UpdateAction(bot_status=(user_id, False))
    return UpdateAction()


def _dict(value: Any) -> dict[str, Any]:
    """JSON-объект Telegram или пустой словарь (сужение типа для проверки mypy; поведение прежнее)."""
    return value if isinstance(value, dict) else {}


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ""
