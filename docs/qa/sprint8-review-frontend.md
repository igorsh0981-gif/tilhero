# Спринт 8: независимое ревью фронтенда и BFF (Mini App, сайт оплаты, admin-web, telegram-bff, admin-bff)

Дата: 28.11.2026. Ревьюер: независимый агент, код не писал и не правил. Ветка `sprint/8-money`, HEAD `0a79563` (поток 0) плюс незакоммиченные изменения рабочего дерева (312 путей на начало ревью).

Объём:
- `services/telegram-bff`: `routes/billing.ts`, `contractBilling.ts`, `routes/game.ts` (`purchase_available`), `src/web/**` (OIDC, сессия, CSRF, Origin, Host, лимиты, кодеки), регистрация в `app.ts`, `config.ts`;
- `apps/telegram-miniapp`: `screens/billing/*`, `src/tg/invoice.ts`, `domain/billing.ts`, плашки урока (`Player.tsx`), урок вдвоём (`Pair.tsx`), детский профиль, «Вопрос по оплате» (`Support.tsx`), i18n `*.billing.ts`, анти-стиринг (код, словари, сборка), «Что нового» s8 (тексты миграции `0011_release_8.py` и иллюстрации);
- `apps/web-pay`: страницы, деньги, роутер, API-клиент, i18n, `Caddyfile`, `index.html`, `vite.config.ts`;
- `services/admin-bff`: `routes/billing.ts`, `routes/finance.ts`, `routes/ai.ts` (деградация, стоимость), `routes/dashboard.ts` (`money`), `money.ts`, кодеки, step-up, Idempotency-Key;
- `apps/admin-web`: `screens/money/*`, `screens/ai/Control.tsx`, вкладка «Тариф» и фильтр по тарифу в `Learners.tsx`.
- Для сценариев отказа — серверное поведение `services/billing` (заказы, повтор ключа, окно возврата Click), `services/lessons` (плашка тарифа), `services/support` (категории обращений).

Эталоны: `docs/sprint8/PLAN.md`, `INTERNAL_API.md` (§0, §1.3, §3, §11, §12, §14, §16), `AGENT_BRIEF.md` («Чек-лист ревью»), `packages/contracts/src/{bff,web,admin,ai}.ts`, формат и уроки `docs/qa/sprint7-review-frontend.md`.

Шкала: 🔴 блокирует мерж · 🟡 исправить до релиза · 🟢 можно позже. Уверенность: ✅ — подтверждено пробой или прогоном, ⚠️ — по коду, пробой не воспроизводилось. Предположения помечены словом «вероятно».

```
ИТОГ РЕВЬЮ
═══════════════════════════════════════════
🔴 0 · 🟡 4 · 🟢 6

🟡 F8-1  «Вопрос по оплате» и «Вопрос по заказу» не отправляются: Mini App создаёт обращение с категорией
         SUBSCRIPTION_PAYMENT, а support держит её available=false и отвечает 422 SUPPORT_CATEGORY_INVALID.
         Ученик с проблемой оплаты видит «Выберите тему обращения.» при уже выбранной теме.
🟡 F8-2  openInvoice: исход «busy» оставляет лист в фазе «invoice» навсегда (кнопка оплаты — вечный спиннер), а
         модульный флаг open без колбэка Telegram не сбрасывается — все покупки мертвы до перезапуска Mini App.
🟡 F8-3  Анти-стиринг: тексты-намёки на существование другого канала оплаты — «Здесь — оплаты звёздами Telegram
         Stars.», «Здесь оплата — звёздами…» (в сборке), «В приложении оплата — только Telegram Stars» (ответ BFF),
         «Оформите «Плюс» прямо в TilHero» (заметка s8). Автотесты анти-стиринга такие фразы не ловят.
🟡 F8-4  CI красный: services/telegram-bff/test/sprint8Skeleton.test.ts:129 (тест потока 0) ждёт 404 на
         /web/v1/me при WEB_PAY_ENABLED=true, а маршрут уже реализован (401).

Вердикт: НЕ ПРИНИМАТЬ в текущем виде. 🔴 нет, но F8-4 нарушает DoD («тесты … чисто»), а F8-1 — сломанная функция
         спринта (AGENT_BRIEF, поток E). Обе правки небольшие: после F8-1 и F8-4 — принимать. F8-2 и F8-3 закрыть
         до включения продаж в Mini App (STARS_ENABLED). Все четыре 🟡 прошли зелёный e2e из-за мягких моков
         (раздел «Пробелы e2e-моков»).
         В остальном сделано аккуратно: вход на сайт (OIDC, PKCE, JWKS, одноразовый state/flow, повтор code,
         cookie __Host-, CSRF + Origin + Host, отзыв сессии, ПДн вне URL и логов, CSP), деньги целыми числами
         («49 000 сум» / «49 000 soʻm», «⭐ 250», BigInt в обзоре), идемпотентность команд админки без версий
         в подписи ключа (урок спринта 7 учтён), step-up и «четыре глаза», дети и подростки без согласия.
```

## Прогоны

| Что | Результат |
|---|---|
| Mini App: `npx tsc -p tsconfig.json --noEmit` | ✅ без ошибок |
| Mini App: `npx vitest run` | ✅ 504/504 (31 файл), включая `test/antiSteering.test.ts` |
| Mini App: `npx playwright test e2e/sprint8.spec.ts` | ✅ 16/16 (3 вьюпорта, UZ, «Что нового» s8) |
| Mini App: `vite build --outDir /tmp/…` + поиск по сборке (Payme/Paycom, Click, Uzum, «сум»/«soʻm», UZS, tiyin, web-pay, /web/v1, «другим способом», «дешевле», «на сайте», `saytda`…) | ✅ ни одного совпадения; совпали только фразы «Здесь — оплаты…» и «Здесь оплата…» (см. F8-3) |
| web-pay: `tsc`, `vitest run` | ✅ 18 пройдено, 8 пропущено: `test/caddy.test.ts` требует бинарник Caddy (`CADDY_BIN`), на стенде его нет — заголовки Caddy проверены чтением `Caddyfile` и e2e под теми же заголовками (`vite preview`) |
| web-pay: `npx playwright test` | ✅ 34/34 (вход, покупка, заказы, адаптивность, CSP без нарушений, URL без ПДн) |
| telegram-bff: `tsc` | ✅ без ошибок |
| telegram-bff: `npx vitest run` | ⚠️ 542/543 (35 файлов). Упал `test/sprint8Skeleton.test.ts:129` — см. F8-4. Все тесты `test/web/*` и `test/billing.test.ts` зелёные |
| admin-bff: `tsc`, `vitest run` | ✅ 362/362 (11 файлов) |
| admin-web: `tsc`, `vitest run` | ✅ 316/316 (15 файлов) |
| admin-web: `npx playwright test` money-adjustments, money-finance, money-payments, money-tariffs, rbac, layout, a11y | ✅ 107/107 |
| support: `uv run pytest tests/test_support_client.py -k category_validation` | ✅ 1/1 — сервер сам подтверждает 422 на `SUBSCRIPTION_PAYMENT` (доказательство F8-1) |
| Пробы ревью | Mini App vitest — 7 сценариев (F8-1, F8-2 ×2, F8-5, потерянный ответ, 503, двойной тап); Mini App Playwright — 1 (дерево доступности Chromium); web-pay vitest — 2 (ключ после сети и 502, двойной клик); web-pay Playwright — 2 (F8-6, «Назад» с провайдера). Результаты — в находках и в разделе «Проверено» |

Код репозитория не менялся. Пробы лежали во временных файлах `apps/telegram-miniapp/test/zz_review8_probe.test.tsx`, `apps/telegram-miniapp/e2e/zz_review8_probe.spec.ts`, `apps/web-pay/test/zz_review8_probe.test.tsx`, `apps/web-pay/e2e/zz_review8_probe.spec.ts` и удалены после прогона; `test-results/.last-run.json` трёх приложений восстановлены в исходное состояние. Побочные артефакты прогонов — только игнорируемые git: `apps/web-pay/dist/` пересобран `webServer` Playwright из того же исходника, `apps/telegram-miniapp/e2e/shots/` перезаписан спеком `sprint8.spec.ts`. Сборка Mini App для проверки анти-стиринга делалась в `/tmp`, `apps/telegram-miniapp/dist/` не тронут.

---

## 🔴 Блокирует мерж

Нет.

## 🟡 До релиза

---
**🟡 F8-1 [Mini App + support] «Вопрос по оплате» и «Вопрос по заказу» не отправляются — 422 SUPPORT_CATEGORY_INVALID**

Уверенность: ✅ (проба S1 + тест самого support).

📍 Где:
- `apps/telegram-miniapp/src/screens/billing/Subscription.tsx:155-160` — строка «Вопрос по оплате» → `nav.push({name: "support", category: "SUBSCRIPTION_PAYMENT", …})`;
- `apps/telegram-miniapp/src/screens/billing/Payments.tsx:138-145` — «Вопрос по заказу» в каждой строке истории;
- `apps/telegram-miniapp/src/screens/support/Support.tsx:109-111` — категория подставляется, «даже если сервер её не отмечает»:
  ```ts
  // the preset category (sprint 8: SUBSCRIPTION_PAYMENT) is offered even when the server list does not mark it
  const options = preset && !listed.some((c) => c.code === preset) ? [{ code: preset, … }, ...listed] : listed;
  ```
- сервер: `services/support/src/tilhero_support/domain/constants.py:20` — `"SUBSCRIPTION_PAYMENT": {…, "available": False}` (комментарий в строках 12-13: «оплата появится в спринте 8»); `domain/tickets.py:227-230` — `if meta is None or not meta["available"]: raise unprocessable("SUPPORT_CATEGORY_INVALID", …)`. `services/support` не изменён ни одним потоком спринта 8 (в AGENT_BRIEF его нет ни у D, ни у E).

**Доказательство.**
- Тест самого support `tests/test_support_client.py:121-136` прямо требует 422 для `SUBSCRIPTION_PAYMENT`; прогон на стенде — зелёный.
- Проба S1 на обвязке `test/billingScreens.test.tsx`: `Support category="SUBSCRIPTION_PAYMENT" subject="Вопрос по заказу №1001"`, категории — как у support (`SUBSCRIPTION_PAYMENT available: false`), `POST /v1/support/tickets` → 422 `SUPPORT_CATEGORY_INVALID`. Ушло тело `{"category":"SUBSCRIPTION_PAYMENT","subject":"Вопрос по заказу №1001",…}`, на форме — «Выберите тему обращения.».

e2e этого не видит: мок (`e2e/fixtures/mock-bff.ts:650-656`) не знает `SUBSCRIPTION_PAYMENT` в списке категорий и принимает обращение с любой категорией; unit-тест `billingScreens.test.tsx:417` проверяет только, что форма открылась.

**Сценарий отказа.** Звёзды списались, а подписка не появилась (или продление не прошло). Ученик открывает «Подписка» → «Вопрос по оплате» (или «История платежей» → «Вопрос по заказу №…»), пишет текст, нажимает «Отправить» и получает «Выберите тему обращения.», хотя тема «Оплата» уже выбрана. Повтор даёт то же. Обойти можно, только догадавшись сменить тему на «Другое». Это единственный путь в поддержку по оплате внутри Mini App (`/paysupport` есть только в боте).

**Рекомендация.** В support включить категорию: `available: True`, обновить `test_support_client.py:121-136`, `test_support_domain.py:93` и `test_support_at25_templates.py:235` (решает координатор: поток не назначен). До этого — скрыть оба входа в Mini App. В e2e-мок добавить `SUBSCRIPTION_PAYMENT` с признаком `available` и отказ 422 на недоступную категорию.
---

---
**🟡 F8-2 [Mini App, оплата Stars] `openInvoice` «busy» — вечная фаза «invoice»; флаг `open` без колбэка Telegram не сбрасывается**

Уверенность: ✅ (пробы R1 и R1b).

📍 Где:
- `apps/telegram-miniapp/src/screens/billing/purchase.tsx:65-68`:
  ```ts
  setPhase({ k: "invoice", order: o });
  const outcome = await openInvoice(o.invoice_link);
  if (ac.signal.aborted) return;
  if (outcome === "busy") return;          // фаза остаётся «invoice»
  ```
  Пока фаза `invoice`, `ready` ложно (`purchase.tsx:233`), а кнопка «Оплатить» в состоянии `busy` (`purchase.tsx:358`). Других выходов из этой фазы нет. Та же логика — в строке заказа «Истории платежей» (`Payments.tsx:129`).
- `apps/telegram-miniapp/src/tg/invoice.ts:30-53`: модульный `let open = false`; сбрасывается только в колбэке `openInvoice` и в `resetInvoiceForTests()`. Исключение Telegram с «Opened» в тексте (`WebAppInvoiceOpened`) превращается в `"busy"` (стр. 51).

**Доказательство.**
- Проба R1: Telegram-заглушка бросает `Error("WebAppInvoiceOpened")`. После «Оплатить» кнопка `disabled=true`, `aria-busy=true`, ни одного текста состояния (`pay-checking`, `pay-failed`, `pay-cancelled`, `pay-slow`, `pay-closed` нет).
- Проба R1b: `openInvoice` Telegram не вызывает колбэк (не пришёл `invoiceClosed`). Лист закрыт и открыт заново, снова «Оплатить»: заказ создан (второй `POST /v1/billing/orders`), счёт не открывается (`openInvoice` вызван один раз за оба листа), кнопка навсегда `disabled`.

**Сценарий отказа.** Telegram-клиент не прислал `invoice_closed` (статусы `openInvoice` и `invoiceClosed` не подтверждены документацией, INTERNAL_API §14 S5) или сам считает счёт открытым и бросает `WebAppInvoiceOpened`. Лист оплаты замирает со спиннером на кнопке без пояснений. Новая попытка — в том же или другом листе, на подписке или тилах — тоже: модульный флаг держит «счёт открыт» до перезапуска Mini App. Денег это не теряет (заказ остаётся `pending`), но покупка недоступна, а ученик не понимает почему.

**Рекомендация.**
- На «busy» не оставлять фазу `invoice`: показать «Окно оплаты уже открыто — закройте его и нажмите «Проверить»» и сразу опросить заказ, как после `pending`.
- Флаг `open` сбрасывать по событию `invoiceClosed` (через `src/tg`), по возврату видимости (`activated` / `visibilitychange`) и по таймауту, после которого опрашивать заказ: источник истины — billing.
- Тесты: `openInvoice` бросает `WebAppInvoiceOpened`; колбэк не пришёл → после возврата видимости или таймаута лист выходит в «Проверяем оплату…».
---

---
**🟡 F8-3 [Анти-стиринг] Фразы-намёки на другой канал оплаты в Mini App, ответе BFF и заметке s8; автотесты их не ловят**

Уверенность: ✅ (поиск по сборке Mini App и исходникам).

📍 Где:
- `apps/telegram-miniapp/src/i18n/ru.billing.ts:125` — `"bill.ord.note": "Здесь — оплаты звёздами Telegram Stars."` (UZ `uz.billing.ts:122` — «Bu yerda — …»), выводится над «Историей платежей» (`Payments.tsx:62`);
- `ru.billing.ts:215` — `"err.PROVIDER_NOT_ALLOWED": "Здесь оплата — звёздами Telegram Stars."` (UZ `uz.billing.ts:212` — «Bu yerda toʻlov — …»);
- `services/telegram-bff/src/contractBilling.ts:457` — `PROVIDER_NOT_ALLOWED: "В приложении оплата — только Telegram Stars"` уходит в `ErrorBody.message` ответа канала `miniapp`;
- `services/experience-config/migrations/versions/0011_release_8.py:70-72` — «Оформите «Плюс» прямо в TilHero и оплатите звёздами…» / «TilHero ichida rasmiylashtiring…».

**Доказательство.** Сборка Mini App (`vite build` во временный каталог) содержит обе фразы «Здесь — оплаты…» и «Здесь оплата…». Шаблоны `test/antiSteering.test.ts:21-28`, `e2e/sprint8.spec.ts:22` и `services/telegram-bff/test/fakeBilling.ts:20-21` ищут названия провайдеров, сумы, адрес сайта и слова «другим способом / дешевле / на сайте», но не «здесь / в приложении / прямо в … оплата».

**Почему важно.** PLAN, решение 3 и AGENT_BRIEF («Анти-стиринг»): Mini App не содержит «намёков на «другой способ оплаты»»; R1 — Mini App могут скрыть на мобильных. «Здесь — оплаты звёздами» над пустой историей у ученика, купившего подписку на сайте, читается как «а другие оплаты — где-то ещё». «Только в приложении — Stars» и «прямо в TilHero» подразумевают, что вне приложения способ другой. Названий и адресов нет, поэтому 🟡, а не 🔴.

**Рекомендация.** Нейтральные формулировки без противопоставления: «История оплат звёздами Telegram Stars» (или без подзаголовка), «Оплата — звёздами Telegram Stars», в BFF — «Оплата — Telegram Stars», в заметке — «Оформите «Плюс» в TilHero…». В три набора шаблонов анти-стиринга добавить `здесь\s*[—-]?\s*оплат|в приложении\s+оплат|прямо в TilHero|bu yerda.*toʻlov|ilova ichida`.
---

---
**🟡 F8-4 [telegram-bff, тесты] Красный тест каркаса потока 0**

Уверенность: ✅ (прогон).

📍 `services/telegram-bff/test/sprint8Skeleton.test.ts:127-131`:
```ts
it("WEB_PAY_ENABLED=true — область /web/v1 регистрируется (маршруты — поток H); BILLING_URL — клиент billing", async () => {
  h = await makeHarness({ WEB_PAY_ENABLED: "true", BILLING_URL: "http://billing.test:8118" });
  expect((await h.app.inject({ url: `${WEB_PREFIX}/me` })).statusCode).toBe(404);
```
Поток H реализовал `GET /web/v1/me`: без cookie он отвечает 401 `SESSION_EXPIRED` (так и должно быть, `test/web/session.test.ts:35`). Прогон: `AssertionError: expected 401 to be 404`, итог 542/543.

**Последствия.** CI telegram-bff красный, DoD («Тесты сервисов… tsc чисто») не выполнен. Повтор находки F7-7 спринта 7: тест соседнего потока не обновлён.

**Рекомендация.** Ожидать 401 `SESSION_EXPIRED` (область зарегистрирована) или проверять регистрацию через `GET /web/v1/auth/start` → 302.
---

## 🟢 Можно позже

---
**🟢 F8-5 [Mini App, оплата Stars] «Заказ закрыт — оформите заново» → «Оплатить» уходит с тем же ключом и получает тот же закрытый заказ**

Уверенность: ✅ (проба R2). 📍 `purchase.tsx:247-253`: `key.current = keyForDraft(key.current, body)` — после успешного `createOrder` ключ не сбрасывается, при фазе `closed` кнопка «Оплатить» активна (`purchase.tsx:233`). Billing на повтор ключа отдаёт прежний заказ (`services/billing/src/tilhero_billing/domain/orders.py:207-215`).

**Доказательство.** Счёт → `failed` → опрос → заказ `expired` → «Заказ закрыт — оформите заново.» → «Оплатить»: второй `POST` с тем же `Idempotency-Key`, ответ — тот же `expired`, снова «закрыт». Выйти можно, только закрыв лист.

**Сценарий.** Ученик оставил счёт Stars открытым дольше `stars_order_ttl_minutes` (60 мин) или заказ закрыли параллельно, и лист предлагает «оформить заново», чего сделать нельзя. **Рекомендация:** при фазе `closed` сбрасывать `key.current` (новый заказ — новый ключ).
---

---
**🟢 F8-6 [Сайт оплаты] После входа — всегда «/»: покупатель, вернувшийся с провайдера с истёкшей сессией, теряет страницу заказа**

Уверенность: ✅ (проба web-pay Playwright). 📍 `services/telegram-bff/src/web/index.ts:324` — `reply.redirect("/", 302)`; сессия — 30 минут простоя (`session.ts:20`).

**Доказательство.** `/orders/2042` без сессии → «Войти через Telegram» → после входа адрес `/`, карточки заказа нет (`order shown: 0`).

**Сценарий.** Оплата в Payme или Click заняла больше 30 минут (SMS-код, смена карты). Провайдер вернул на `/orders/{no}`, сессия истекла: вход → главная, статус заказа надо искать в «Мои заказы». **Рекомендация:** запомнить путь (только `/orders/\d+` или `/buy/<код>`) в `sessionStorage` перед `startLogin()` и восстановить после входа. Открытого редиректа нет: сервер по-прежнему ведёт на «/», переход делает SPA по белому списку.
---

---
**🟢 F8-7 [Сайт оплаты, вход] Scope `openid profile` расходится с контрактом «scope openid, имя и username не запрашиваются»**

Уверенность: ✅ по коду. 📍 `services/telegram-bff/src/web/oidc.ts:18` — `OIDC_SCOPE = "openid profile"`; контракт `packages/contracts/src/web.ts:19` и INTERNAL_API §3 (стр. 1001-1002) — «scope `openid` (имя, username, телефон не запрашиваются)». В комментарии `oidc.ts:9-12` решение обосновано §14 L1 (`id` приходит только с `profile`), но L1 допускает `profile` как запасной путь «при отсутствии `id`», а код запрашивает его всегда.

**Последствия.** Имя, username и фото Telegram приходят в `id_token` к telegram-bff (не сохраняются и не логируются — проверено тестом `test/web/security.test.ts:59`), а контракт и PLAN обещают минимизацию ПДн. **Рекомендация:** проверить L1 на реальном боте; если без `profile` нельзя — исправить `web.ts` и §3 (минимизация: claims, кроме `id`, не читаются).
---

---
**🟢 F8-8 [Сайт оплаты] Мелочи доступности и текстов**

Уверенность: ✅ по коду и e2e.
- `apps/web-pay/src/pages/Home.tsx:93-105` — на главной нет `<h1>` (у прочих страниц есть): заголовки начинаются с `h2`.
- `apps/web-pay/src/ui.tsx:36` — `<nav aria-label="menu">`: английская подпись в RU и UZ интерфейсе.
- `apps/web-pay/src/i18n.ts:43, 45` — `"{days} дней"`, `"{til} тилов"` без склонения и группировки: «1200 тилов» (e2e `buy.spec.ts` закрепляет именно это), при «49 000 сум» рядом и «1 200 тилов» в Mini App.
- `apps/web-pay/src/pages/Order.tsx:173-175` — «Отменить заказ» стоит рядом с «Перейти к оплате» и срабатывает без подтверждения (в Mini App подтверждение есть).

**Рекомендация:** `h1` (визуально скрытый) на главной, подпись меню из словаря, склонение и NBSP-группы, как в `money.ts`, подтверждение отмены.
---

---
**🟢 F8-9 [telegram-bff, игра] `purchase_available` — запрос каталога billing на каждую сводку игры, без кеша и лимита**

Уверенность: ✅ по коду. 📍 `services/telegram-bff/src/routes/game.ts:220-221` (`Promise.all([work, purchaseAvailable(…)])`) — для `GET /v1/game/summary`, `PUT /v1/game/hero` и `PUT /v1/game/equipment`; `routes/billing.ts:141-156` — вызов без `limiter` и кеша, таймаут 1,5 с.

**Последствия.** Каждая главная, профиль и магазин ходят в billing за полным каталогом. При медленном billing ответ игры (и экипировки) ждёт до 1,5 с. **Рекомендация:** короткий кеш признака на аккаунт (30–60 с) или кеш каталога по версии, как `ExperienceCache`.
---

---
**🟢 F8-10 [admin-bff] Устаревший комментарий блока `money` дашборда**

📍 `services/admin-bff/src/routes/dashboard.ts:31-37`: описаны параллельные `GET …/refunds?limit=100` и `GET …/reconciliation/items?status=open&limit=100`, а `loadMoney` (стр. 114-142) берёт `refunds_count` и `recon_open` из одной сводки. Код верный, вводит в заблуждение только комментарий. **Рекомендация:** привести комментарий к коду.
---

## Пробелы e2e-моков

Все четыре 🟡 прошли зелёный e2e, потому что моки мягче серверов:
- **Категории поддержки** (F8-1). `apps/telegram-miniapp/e2e/fixtures/mock-bff.ts:650-656`: в списке нет `SUBSCRIPTION_PAYMENT`, у всех `available: true`; `POST /v1/support/tickets` принимает любую категорию. Support отвечает 422 `SUPPORT_CATEGORY_INVALID`.
- **Telegram `openInvoice`** (F8-2). Заглушка всегда вызывает колбэк со статусом сценария. Нет `WebAppInvoiceOpened`, нет пропавшего `invoiceClosed`, нет `WebAppInvoiceUrlInvalid` (у Telegram путь счёта — `^/(\$|invoice/)[A-Za-z0-9\-_=]+$`, у нашего `INVOICE_LINK` допустимы ещё `+` и `/`).
- **Заказы Stars** (F8-5). `e2e/fixtures/billing.ts`: заказы не истекают (`expired` не возникает), нет `ORDERS_LIMIT`. На новый ключ мок создаёт новый заказ, а billing возвращает тот же незавершённый (`orders.py:258-264`). Проверка оферты в моке идёт раньше повтора ключа, у billing — наоборот (`orders.py:207-215`): повтор с прежним ключом после смены оферты в моке даёт 409, у billing — прежний заказ.
- **Сайт оплаты.** `apps/web-pay/e2e/fixtures/mock-bff.ts:221-225` изображает весь вход одним 302 на «/». Межсайтовая цепочка `oauth.telegram.org → /api/auth/callback → /`, cookie `__Host-wp_oidc` (Lax) и `__Host-wp_session` (Strict) в браузере, проверка Host и `state` проверяются только unit-тестами telegram-bff (`inject`), но не браузером. Нет истечения сессии при возврате с провайдера (F8-6). `failOnce` срабатывает до проверки сессии и CSRF.
- **Анти-стиринг** (F8-3). Шаблоны в `antiSteering.test.ts`, `sprint8.spec.ts:22` и `fakeBilling.ts:20` не содержат намёков без названий: «здесь / в приложении / прямо в TilHero … оплата».

**Совет.** В Mini App-мок — реальные категории support и 422 на недоступную; режимы `invoice: "throw_opened" | "no_callback"` в `fixtures/telegram.ts`; истечение заказа и выдачу того же незавершённого заказа на новый ключ — в `fixtures/billing.ts`. В web-pay — e2e «возврат с провайдера после 30 минут». Шаблоны анти-стиринга — по F8-3.

## Проверено, замечаний нет

**telegram-bff `/web/v1/*`: вход на сайт (AT-86)**
- OIDC: Authorization Code + PKCE S256 (`verifier` 64 символа base64url, `state` 256 бит), `client_secret` — только в Basic при обмене `code` (`redirect: "error"`, таймаут 5 с, ответ ≤ 64 КиБ). `id_token` проверяется по JWKS (кеш 1 ч, перезагрузка при новом `kid` не чаще раза в 30 с): `iss` = база OIDC, `aud` = ID бота, `exp`, алгоритмы — только асимметричные (`none` и HS256 с секретом клиента отклоняются — тест). Telegram ID — только из claim `id`.
- Подделка `id_token` (чужая подпись при том же `kid`, другой `aud`, просрочен, чужой `iss`, `alg none`/HS256, нет `id`, неизвестный `kid`), повтор `state`/`code` (попытка сжигается `GETDEL` до любых проверок), нет cookie попытки, `state` из другого браузера, подменённый `code` (PKCE), истёкшая попытка, `?error=access_denied` — всё → 302 `/?login_error=auth_failed` без сессии (тесты `test/web/oidc.test.ts`, зелёные). Вход без `state` (§14 L1) держат cookie, одноразовая запись в Redis и PKCE: чужой `code` не обменяется с чужим `verifier` (CSRF входа невозможен).
- Только существующий аккаунт (`account_not_found` без создания), удаляемый — `not_allowed`, возраст 6–13 — `not_allowed`; подросток без согласия входит, но платить не может (`/me` `can_pay=false`, `POST /orders` → 403 `GUARDIAN_CONSENT_REQUIRED` до billing).
- Cookie: `__Host-` (Path=/, Secure, HttpOnly, без Domain), сессия — SameSite=Strict, попытка — Lax (межсайтовый возврат верхнего уровня). Strict-cookie после межсайтовой цепочки на первый документ не уходит, но SPA читает `/api/me` запросом с того же сайта — вход работает (разбор цепочки, в e2e не покрыт — см. «Пробелы»).
- Сессия: JWT HS256 `WEB_SESSION_SECRET` (≥ 32, ≠ секретам Mini App и внутреннего JWT, не dev-значение в stage/prod), `iss`/`aud`/`typ`, 30 мин скользящая, ≤ 2 ч от входа, продление — не чаще раза в минуту, тот же `jti`. Выход и удаление аккаунта (`/me`, `POST /orders` через identity) — `jti` в список отзыва Redis. Redis недоступен — вход и сессия fail-closed (тест). Любой 401 области удаляет cookie.
- CSRF: `X-CSRF-Token` = HMAC(`jti`) на производном ключе, сравнение за постоянное время; `Origin` = `WEB_PAY_ORIGIN` строго; выход — тоже с `Origin` и CSRF. Host (stage/prod) = домен сайта, иначе 404 на всей области. Caddy web-pay передаёт Host без изменений (`reverse_proxy` по http), адрес клиента — глубина 2 справа в `X-Forwarded-For` (`trusted_proxies` + Railway edge), лимит `web.auth_ip` — fail-closed. Остаточный риск, вероятно, нулевой: если Railway edge маршрутизирует по SNI, а не по Host, на публичный домен telegram-bff можно прийти с Host сайта и обойти лимит входа подменой XFF. Проверить на Railway при выкладке (поток I).
- ПДн и логи: в адресах только `code`/`state` на один переход, номер заказа и код ошибки входа; после входа — 302 на «/», SPA удаляет query и hash при загрузке (`router.ts cleanAddress`), в том числе параметры, которые провайдер добавляет к `return_url`. Открытых редиректов нет: все `Location` сервера — константы. Секрет клиента, `code`, `state`, `code_verifier`, `id_token`, cookie, CSRF, Telegram ID и имя в лог не попадают (тест `security.test.ts:59`). `Referrer-Policy: no-referrer` и `<meta name="referrer">`.
- Ответы сайта собираются кодеками поле за полем: только UZS, тийины — целые 100..10¹¹, только Payme/Click/Uzum, заказ Stars в канале `web` — 404, ссылки только https без userinfo. Вызов billing — `sub` = `lrn` = аккаунт, `chn: "web"`; получатель тилов — свой ребёнок, иначе 403 до billing. `WEB_PAY_ENABLED=false` — 404, `TELEGRAM_OIDC_BASE` ≠ `oauth.telegram.org` в stage/prod — сервис не стартует.

**telegram-bff `/v1/billing/*` (канал Mini App)**
- `provider` на входе — только `telegram_stars` (иное → 422 без вызова billing), строгие тела. Кодеки отбрасывают товары без цены в Stars, заказы не Stars (по провайдеру, валюте, `amount_tiyin`, каналу), ссылки на счёт не `https://t.me/…`, оферту на домене сайта (503). `details` ошибок — только поля контракта, текст — BFF (кроме F8-3). Детский профиль — 403 `PAYER_REQUIRED` до billing на командах и истории, каталог без цен и пробного, подписка без цены Stars. 503 `BILLING_UNAVAILABLE` / `STARS_UNAVAILABLE` различаются. Лимиты `tg.billing.*`. Контрактный тест анти-стиринга на все ответы — зелёный.

**Mini App: оплата Stars**
- Единственный путь оплаты — `Telegram.WebApp.openInvoice` через `src/tg/invoice.ts`, только ссылки `https://t.me/…`; вне Telegram или до Bot API 6.1 — «Обновите Telegram». Статус счёта — подсказка: `paid`/`pending` → опрос до 60 с (0, 1, 1,5, 2, 2, 2,5, 3 с…), `cancelled`/`failed` → одна проверка (платёж мог пройти), долго — «Проверить ещё раз»; тилы `paid` → короткий доопрос до `fulfilled`. Уход с экрана отменяет опрос.
- Потерянный ответ на создание заказа — повтор с тем же ключом (проба R3), `STARS_UNAVAILABLE` — тот же ключ, ссылка дочитывается до трёх раз. После 503 `BILLING_UNAVAILABLE` ключ новый (проба R4), но дубля нет: billing на новый ключ отдаёт тот же незавершённый заказ того же товара, получателя, режима и канала (`orders.py:258-264`). Двойной тап в одном кадре — один `POST` (проба R5, синхронный `lock`). 409 `FORFEIT_CONFIRMATION_REQUIRED` — подтверждение с минутами и днями, `OFFER_VERSION_MISMATCH` — перечитка каталога и согласие заново.
- Сумма не уходит с клиента: в заказе — код товара, `offer_version`, `start_mode`, `confirm_forfeit`, `beneficiary_id`. Цена — только «⭐ N» целыми, NBSP-группы (`starsText`). Подписка Stars при живой подписке или оплаченном периоде заблокирована словами, пробный заменяется только с подтверждением. «Плюс 90» — «после текущего» по умолчанию, «сейчас» — с подтверждением.
- Автопродление: выключение — с подтверждением и датой, `failed` — без переключателя, с объяснением.

**Mini App: дети, подростки, плашки**
- Детский профиль: «Подписка семьи активна до …» в профиле и на экране, без цен, кнопок и призывов. «Купить тилы» — «Тилы можно заработать…», в магазине кнопки нет, плашки урока нет, лист урока вдвоём — «с семьёй — бесплатно» без кнопки. Заметка `s8-plus-kids` — без цен, покупок и «попроси родителя»; иллюстрация `s8-plus-kids.webp` (1200×675, VP8) — девочка с книгами и дракончики, без звезды, цен и символов оплаты (просмотрено).
- Подросток без согласия: «Покупки — с согласия родителя» и переход к согласию, без планов и пробного, `purchase_available=false`.
- Плашка тарифа: причина словами, «О подписке» — кроме `billing_unavailable`; при плашке тарифа lessons ставит `ai_degraded=false` (`services/lessons/src/tilhero_lessons/domain/sessions.py:527-532`, `_billing_pending`), двух плашек нет. «ИИ: осталось N мин» — только на первом этапе, в дуэли — нет. Урок вдвоём: 403 `SUBSCRIPTION_REQUIRED {reason}` → лист «Уроки вдвоём — в подписке», ключ приглашения сбрасывается.

**Анти-стиринг (кроме F8-3)**
- Сборка, исходники, `public/`, словари RU/UZ: нет Payme/Paycom, Click, Uzum, «сум»/«soʻm», UZS, тийинов, адреса или маршрутов сайта, «другим способом», «дешевле», «на сайте». Ссылки на экране — только `t.me`, оферта — через `Telegram.openLink`. «История платежей» — только заказы Stars, покупка на сайте видна как статус и минуты («Начислено · оплата»). Иллюстрация `s8-plus.webp` — звезда Telegram, девочка и робот, без цен и надписей (просмотрено).

**Сайт оплаты (web-pay)**
- CSP и заголовки `Caddyfile` совпадают с §3 (плюс `X-Frame-Options: DENY`, `X-Robots-Tag`, `-Server`). e2e идёт под теми же заголовками (`vite preview`): нарушений CSP нет, запросов к чужим доменам нет, в разметке нет `style=""`. Нет Telegram SDK, сторонних скриптов, шрифтов, аналитики, `localStorage` — только язык. `/api/*` — `no-store`, бандлы — `immutable`, SPA — `no-cache`. Вход и переход к провайдеру — навигацией (`location.assign`), только https.
- Деньги: `formatSum` — целые тийины, без float и Intl, NBSP-группы, «сум» / «soʻm» (U+02BB проверен побайтно), неположительное или нецелое значение — ошибка. Цена заказа — с сервера, тело заказа без суммы.
- Идемпотентность: ключ — на содержимое формы, после сети и 502 без тела — тот же (проба web-pay), меняется только при смене товара, провайдера, получателя, режима, подтверждения или версии оферты. Двойной клик — один `POST` (проба). «Назад» со страницы провайдера в Chromium — форма в исходном состоянии (проба; Safari и iOS bfcache не проверялись).
- Подросток без согласия и неизвестный возраст — объяснение и неактивные кнопки. 401 в любом запросе — экран входа «Сессия истекла». 403 `CSRF_INVALID` — «обновите страницу». RU/UZ: одинаковые ключи, UZ — латиница с U+02BB. Адаптивность — `responsive.spec.ts`, `prefers-reduced-motion` гасит спиннер.

**admin-bff и admin-web: деньги и ИИ**
- Права — до домена, step-up и `X-Step-Up: ok` — ровно по INTERNAL_API §12 (активация, откат, массовый пробный, заявка, решение, возврат, закрытие возврата, `PUT /ai/degradation`, `PUT /ai/budget`). Ключи провайдеров не показываются и не принимаются (`/providers` — только «включён / задан»). Ответы — строгие кодеки («смешанные» деньги, не своя валюта или канал → 503). Даты фильтров — день Ташкента, «по» включительно. `daily` ≤ 92 дней.
- Финансовый обзор: только целые — тийины, Stars, микродоллары, BigInt и half-up. Оценка Stars в сумах — с пометкой. При Stars без курса маржа `null`, а не заниженная. Сайт и Stars не складываются. Источник недоступен — его блок `null`. Граница float — только ответ ai-gateway в USD (`usdToMicro` через `toFixed(6)`), задокументирована.
- Idempotency-Key (урок спринта 7 учтён): подпись — сама команда, без `updated_at` и версий, которые меняются после потерянного ответа. Возврат — заказ, причина и `force`; заявка — аккаунт и тело; решение — заявка и заметка; активация — номер черновика (не меняется до активации) и комментарий; откат — версия-источник и комментарий; деградация — тело. `CommandKey` хранит ключ при `status 0`/5xx и сбрасывает при успехе и 4xx. Потерянный ответ на возврат и на подтверждение — повтор с тем же ключом (unit и e2e `money-payments`, `money-adjustments`).
- «Четыре глаза»: `can_decide` / `can_cancel` считает admin-bff по сессии; автор видит только «Отозвать» и «ждёт решения другого сотрудника». Billing всё равно отвечает 409 `SELF_APPROVAL`, текст переведён. Возврат: предупреждение о тилах и второе подтверждение после `tils_spent`, окно Click — как у billing (текущий месяц, 1-го — и прошлый: `refunds.py:71-74`).
- Доступность и меню: a11y-спек зелёный, статусы — словами в плашках, таблицы с `caption`. Меню из 26 разделов на 1440×900 видно целиком, на 1280×720 прокручивается панель (`layout.spec.ts`). Фильтр и колонка «Тариф» у учеников (`null` → «бесплатный»).

**Повтор находок спринта 7.** Ключ, привязанный к версии (F7-9), не повторён ни в одной команде «Денег» и «Контроля ИИ». Двойной тап закрыт и в Mini App, и на сайте. Красный тест соседнего потока повторился (F8-4).
