"""Синхронные вызовы billing (INTERNAL_API спринта 8 §0.3) — имена клиентов Runtime (aud внутреннего JWT).

- identity-consent: `GET /internal/v1/export/profiles` — начальная загрузка проекции learners (в фоне, повтор tick'ом);
- gamification: `GET /internal/v1/game/purchases/by-order/{order_id}` — пред-проверка возврата тилов (5 с);
- telegram-bot-gateway (внутренний порт 8108): `/internal/v1/stars/*` — ссылка на счёт, возврат, автопродление,
  выписка (5 с; недоступен → 503 STARS_UNAVAILABLE). Telegram ID в billing не попадает: bot-gateway сам переводит
  account_id ↔ Telegram ID через identity-consent.

Вне транзакций БД; в логи — только тип ошибки и статус (без тел, подписей и Telegram ID).
"""

from __future__ import annotations

from typing import Final

IDENTITY: Final = "identity-consent"
GAMIFICATION: Final = "gamification"
BOTGW: Final = "telegram-bot-gateway"
