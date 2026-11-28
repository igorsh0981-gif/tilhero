# web-pay — сайт оплаты TilHero (спринт 8)

Сайт вне Telegram: подписка «Плюс» и пакеты тилов за сумы через Payme, Click, Uzum (решение владельца В1).
Контракт — `packages/contracts/src/web.ts`, внутренние правила — `docs/sprint8/INTERNAL_API.md` §3.

- **Статика** (React 18 + Vite) за Caddy; **API** — `/api/*` → telegram-bff `/web/v1/*` по приватной сети
  (`services/telegram-bff/src/web/`). Один origin: cookie `__Host-wp_session` first-party, CSRF и Origin проверяет BFF.
- **Без** Telegram SDK, сторонних скриптов, шрифтов, аналитики и встроенных стилей — строгая CSP из `Caddyfile`
  (`default-src 'none'; script-src 'self'; style-src 'self'; …`), `Referrer-Policy: no-referrer`, COOP `same-origin`.
- **Вход** — «Log In with Telegram» (OIDC + PKCE) перенаправлениями: `/api/auth/start` → oauth.telegram.org →
  `/api/auth/callback` → `/`. Только существующий аккаунт TilHero; в адресе — только одноразовые `code`/`state`,
  после входа — `/`. Ошибка — `/?login_error=auth_failed | account_not_found | not_allowed` (сайт убирает из адреса).
- **Страницы:** `/` — подписка и тарифы; `/buy/{код}` — что входит, получатель тилов, «после текущего» / «начать
  сейчас» (с подтверждением), способ оплаты, оферта → переход на провайдера; `/orders/{номер}` — возврат с
  провайдера, опрос статуса, чек; `/orders` — история заказов сайта. RU/UZ (латиница, U+02BB), телефон/планшет/ПК.
- **Деньги** — целые тийины из API, вывод «49 000 сум» / «49 000 soʻm» (`src/money.ts`, без float и Intl).

## Переменные
| Где | Переменная | Значение |
|---|---|---|
| web-pay | `BFF_URL` | `http://${{telegram-bff.RAILWAY_PRIVATE_DOMAIN}}:8001` |
| web-pay | `PORT` | 8080 (Railway) |
| telegram-bff | `WEB_PAY_ENABLED` | `false` до запуска продаж на сайте (тогда `/web/v1/*` → 404) |
| telegram-bff | `WEB_PAY_ORIGIN` | публичный https-адрес сайта, без пути (Railway-домен web-pay или `pay.<домен>`) |
| telegram-bff | `TELEGRAM_LOGIN_CLIENT_ID` | Client ID из BotFather (= ID бота) |
| telegram-bff | `TELEGRAM_LOGIN_CLIENT_SECRET` | Client Secret из BotFather — вводит владелец, только в Railway |
| telegram-bff | `WEB_SESSION_SECRET` | генерирует `infra/railway/setup.py` |
| telegram-bff | `TELEGRAM_OIDC_BASE` | не задавать в stage/prod (`https://oauth.telegram.org`); мок — только dev/test |

## Владельцу: BotFather → Bot Settings → Login Widget
1. **Allowed URLs:** добавить origin сайта `{WEB_PAY_ORIGIN}` (например, `https://pay.example.uz`) и redirect URI
   `{WEB_PAY_ORIGIN}/api/auth/callback` — точно так, без лишнего `/` в конце.
2. **Client ID / Client Secret:** Client ID → `TELEGRAM_LOGIN_CLIENT_ID`; Client Secret → `TELEGRAM_LOGIN_CLIENT_SECRET`
   в переменных telegram-bff в Railway (не в чат, репозиторий, БД, логи). Токен бота сайту не нужен.
3. **Advanced → алгоритм подписи:** оставить **RS256** (по умолчанию) или ES256. EdDSA и ES256K Telegram разрешает
   только со scope `openid`, а сайту нужен `openid profile` — только с ним в `id_token` есть Telegram ID (claim `id`).
4. После смены домена сайта — заменить оба адреса в Allowed URLs и `WEB_PAY_ORIGIN`.
5. Проверка на реальном боте до включения (INTERNAL_API §14 L1): вход проходит, в `id_token` есть `id`.

## Разработка и проверки
```bash
npm run dev -w @tilhero/web-pay           # :5175, /api → telegram-bff :8001 (WEB_PAY_ENABLED=true)
npx tsc -p apps/web-pay/tsconfig.json     # типы (src, test, e2e)
npm test -w @tilhero/web-pay              # vitest: деньги, тексты, api, приложение, Caddy
CADDY_BIN=/path/to/caddy npm test -w @tilhero/web-pay   # + тест заголовков Caddy на живом процессе
npm run e2e -w @tilhero/web-pay           # Playwright: сборка в vite preview с CSP из Caddyfile, mock BFF
```
`test/caddy.test.ts` пропускается без Caddy 2.10 (`CADDY_BIN` или `caddy` в PATH) — в CI его нужно поставить.
