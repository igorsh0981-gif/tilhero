# payments-edge — публичный приём колбэков Payme, Click, Uzum

**Спринт 8, INTERNAL_API §4.** Caddy без кода, БД и шины: единственная публичная точка, через которую фиатные
провайдеры сайта оплаты вызывают billing. У billing публичного домена нет: колбэки идут сюда, отсюда — по приватной сети
Railway в `billing:8118` с заголовком `X-Edge-Token`.

## Маршруты
| Снаружи | Метод | В billing |
|---|---|---|
| `/pay/payme` | любой (на не-POST billing отвечает Payme `-32300`, HTTP 200) | `/provider/v1/payme` |
| `/pay/click/prepare`, `/pay/click/complete` | POST | `/provider/v1/click/prepare`, `…/complete` |
| `/pay/uzum/{check,create,confirm,reverse,status}` | POST | `/provider/v1/uzum/{op}` (за флагом `UZUM_ENABLED` в billing) |
| `/healthz` | любой | `200 ok` (healthcheck Railway и Docker) |
| всё остальное (включая `/provider/v1/*` напрямую) | — | `404`, до billing не доходит |

Страниц для браузера нет: покупатель после оплаты возвращается на страницу заказа сайта оплаты
(`{WEB_PAY_ORIGIN}/orders/{order_no}`), а не сюда.

## Безопасность
- **`X-Edge-Token`** — свой, из переменной `PAYMENTS_EDGE_TOKEN` (плейсхолдер `{env.…}` читается на каждый запрос и не
  попадает в конфигурацию Caddy); заголовок клиента с тем же именем заменяется. billing без верного токена отвечает
  `404`, неотличимый от несуществующего маршрута.
- **Вырезаются** служебные заголовки клиента: `X-Internal-Token`, `X-Trace-Id`, `X-Correlation-Id`, `X-Causation-Id`,
  `Idempotency-Key`, `Cookie`. `Authorization` (Basic Payme и Uzum) проходит — его проверяет адаптер billing за
  постоянное время.
- **Адрес клиента.** Снаружи сюда попадают только через Railway edge; Caddy доверяет входящему `X-Forwarded-For` и
  дописывает адрес соседа (edge). billing берёт адрес **второй справа** (`providers/common.py`, `CLIENT_IP_DEPTH = 2`),
  а не крайний левый (его подделывает клиент), — для списков `PAYME_ALLOWED_CIDRS`, `CLICK_ALLOWED_CIDRS`,
  `UZUM_ALLOWED_CIDRS` (пусто — проверка выключена до получения IP провайдеров, В16/О8) и лимита `pay.callback_ip`
  (600 запросов в минуту с адреса; в ключе Redis — только псевдоним с суточной солью).
- **Тело ≤ 64 КиБ** (`max_size 64KiB`; `64KB` у Caddy — 64 000 байт): больше — `413`, в billing не отправляется
  (billing проверяет тот же предел ещё раз). Таймауты: заголовки ответа billing — 10 с, соединение — 5 с; сервер —
  `read_header 10s`, `read_body 15s`. Повторов к billing нет — повторяет сам провайдер.
- **Логи.** Access-лог не включён: тела колбэков, подписи Click и учётные данные никуда не пишутся. Метаданные вызова
  (метод, код результата, время, IP) billing пишет в `provider_calls`.
- Без `Server` в ответах, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`; admin API Caddy выключен,
  конфигурация не сохраняется.

## Переменные
| Переменная | Пример | Назначение |
|---|---|---|
| `PORT` | `8080` | порт контейнера (Railway задаёт сам) |
| `BILLING_URL` | `http://${{billing.RAILWAY_PRIVATE_DOMAIN}}:8118` | приватный адрес billing без пути |
| `PAYMENTS_EDGE_TOKEN` | генерирует `infra/railway/setup.py` | тот же, что у billing (≥ 32 символов в stage/prod) |

## URL колбэков для кабинетов провайдеров (В13)
Домен — Railway-домен сервиса `payments-edge` (https). В кабинетах указываются:
- Payme Business (касса → «Параметры подключения» → endpoint): `https://<домен>/pay/payme`; поле Account — `order_id`;
- Click (SHOP API): Prepare URL — `https://<домен>/pay/click/prepare`, Complete URL — `https://<домен>/pay/click/complete`;
- Uzum (после сверки спецификации): `https://<домен>/pay/uzum/{check|create|confirm|reverse|status}`.

IP-адреса провайдеров запросить при договоре и задать в `*_ALLOWED_CIDRS` billing (О8).

## Сборка и проверка
```bash
docker build -f apps/payments-edge/Dockerfile -t tilhero/payments-edge .   # контекст — корень репозитория
```
Dockerfile запускает `caddy validate`; образ — `caddy:2.10.2-alpine`, не-root. Тест
`services/billing/tests/providers/test_payments_edge.py` проверяет Caddyfile статически, а при наличии бинаря `caddy`
(PATH или `CADDY_BIN`) — `caddy validate`/`adapt`/`fmt` и живой прогон перед заглушкой billing: маршруты, 404,
подмену токена, вырезание заголовков, `X-Forwarded-For`, предел тела 64 КиБ.
