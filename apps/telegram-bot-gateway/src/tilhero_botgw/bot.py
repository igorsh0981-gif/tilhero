"""Маршрутизация Telegram update → действие (чистые функции, без сети).

Ответ возвращается прямо в ответе на webhook (метод Bot API в теле ответа): так ack ≤ 1 с не зависит от исходящего
запроса в Telegram, а токен бота вообще не участвует. Сетевые побочные эффекты (статус бота в identity-consent)
выполняются фоном после ответа.

Только транспорт (INTERNAL_API §8): `/start [payload]` → приветствие с кнопкой «Открыть TilHero» (payload из белого
списка — в startapp); прочие команды и текст → одна подсказка с той же кнопкой; язык — RU/UZ по language_code.
Только личные чаты; группы, каналы и боты игнорируются.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from tilhero_botgw.texts import lang_of, open_button, start_payload, t


@dataclass(frozen=True)
class UpdateAction:
    reply: dict[str, Any] | None = None  # метод Bot API для ответа в теле webhook
    chat_id: int | None = None  # для анти-спам лимита ответов
    bot_status: tuple[int, bool] | None = None  # (telegram_user_id, blocked) → identity-consent


def parse_command(text: str) -> tuple[str, str] | None:
    """«/start@TilHeroBot inv_x» → ("start", "inv_x")."""
    if not text.startswith("/"):
        return None
    head, _, rest = text.partition(" ")
    name = head[1:].split("@", 1)[0].lower()
    if not name:
        return None
    return name, rest.strip()


def route_update(update: dict[str, Any], miniapp_url: str, app_link: str | None = None) -> UpdateAction:
    if isinstance(update.get("message"), dict):
        return _on_message(update["message"], miniapp_url, app_link)
    if isinstance(update.get("callback_query"), dict):
        # Inline-кнопок с callback у бота нет: только снять «часики» у клиента
        cq = update["callback_query"]
        if not isinstance(cq.get("id"), str):
            return UpdateAction()
        return UpdateAction(reply={"method": "answerCallbackQuery", "callback_query_id": cq["id"]})
    if isinstance(update.get("my_chat_member"), dict):
        return _on_member(update["my_chat_member"])
    return UpdateAction()


def _on_message(msg: dict[str, Any], miniapp_url: str, app_link: str | None) -> UpdateAction:
    chat = _dict(msg.get("chat"))
    sender = _dict(msg.get("from"))
    chat_id = chat.get("id")
    if chat.get("type") != "private" or not isinstance(chat_id, int) or sender.get("is_bot"):
        return UpdateAction()  # бот работает только в личном чате
    lang = lang_of(_str(sender.get("language_code")) or None)
    command = parse_command(_str(msg.get("text")))
    if command is not None and command[0] == "start":
        payload = start_payload(command[1])
        first_name = _str(sender.get("first_name")).strip()[:64]
        text = t(lang, "hello", name=first_name) if first_name else t(lang, "hello_anon")
    else:
        payload, text = None, t(lang, "hint")
    return UpdateAction(
        reply={
            "method": "sendMessage",
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": True},
            "reply_markup": {"inline_keyboard": [[open_button(lang, miniapp_url, app_link, payload)]]},
        },
        chat_id=chat_id,
    )


def _on_member(update: dict[str, Any]) -> UpdateAction:
    """my_chat_member в личном чате: kicked — пользователь заблокировал бота, member — разблокировал."""
    chat = _dict(update.get("chat"))
    new = _dict(update.get("new_chat_member"))
    sender = _dict(update.get("from"))
    user_id = sender.get("id")
    if chat.get("type") != "private" or not isinstance(user_id, int) or isinstance(user_id, bool) or user_id <= 0:
        return UpdateAction()
    status = new.get("status")
    if status == "kicked":
        return UpdateAction(bot_status=(user_id, True))
    if status == "member":
        return UpdateAction(bot_status=(user_id, False))
    return UpdateAction()


def _dict(value: Any) -> dict[str, Any]:
    """JSON-объект Telegram или пустой словарь (сужение типа для mypy)."""
    return value if isinstance(value, dict) else {}


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ""
