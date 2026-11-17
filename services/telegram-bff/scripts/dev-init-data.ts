/**
 * Генератор корректно подписанного Telegram initData — для локальной разработки и e2e Mini App
 * (Playwright подставляет его в window.Telegram.WebApp.initData).
 *
 *   npx tsx scripts/dev-init-data.ts --user-id 900001 --name Игорь
 *   npx tsx scripts/dev-init-data.ts --user-id 900001 --name Игорь --username test_user_1 --lang ru --json
 *   BOT_TOKEN=... npx tsx scripts/dev-init-data.ts --user-id 900002 --name Anna --lang uz --start-param inv_AbCdEfGhIjKlMnOpQrStUvWxYz012345
 *
 * Токен бота: --bot-token, иначе BOT_TOKEN из окружения, иначе dev-значение по умолчанию (совпадает с конфигом BFF
 * вне production). При NODE_ENV=production скрипт не запускается.
 */
import { parseArgs } from "node:util";
import { DEV_DEFAULTS } from "../src/config.js";
import { signInitData } from "../src/telegramAuth.js";

const HELP = `Использование: npx tsx scripts/dev-init-data.ts --user-id <id> --name <имя> [опции]

  --user-id <n>        Telegram user id (обязательно, положительное целое)
  --name <s>           first_name (обязательно)
  --last-name <s>      last_name
  --username <s>       username (без @)
  --lang <code>        language_code (по умолчанию ru)
  --start-param <s>    start_param (deep link startapp)
  --age <sec>          «возраст» initData: auth_date = now - age (по умолчанию 0)
  --bot-token <t>      токен бота (иначе BOT_TOKEN или dev-значение)
  --json               вывести тело запроса {"init_data": "..."} для POST /v1/session/telegram
  -h, --help           эта справка
`;

function fail(msg: string): never {
  process.stderr.write(`${msg}\n\n${HELP}`);
  process.exit(2);
}

function main(): void {
  if (process.env.NODE_ENV === "production") fail("dev-init-data: запрещено при NODE_ENV=production");

  const { values } = parseArgs({
    options: {
      "user-id": { type: "string" },
      name: { type: "string" },
      "last-name": { type: "string" },
      username: { type: "string" },
      lang: { type: "string", default: "ru" },
      "start-param": { type: "string" },
      age: { type: "string", default: "0" },
      "bot-token": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const id = Number(values["user-id"]);
  if (!values["user-id"] || !Number.isSafeInteger(id) || id <= 0) fail("--user-id: нужен положительный целый Telegram id");
  if (!values.name) fail("--name: обязательно");
  const age = Number(values.age);
  if (!Number.isInteger(age) || age < 0) fail("--age: неотрицательное целое число секунд");

  const botToken = values["bot-token"] ?? process.env.BOT_TOKEN ?? DEV_DEFAULTS.BOT_TOKEN;
  if (!values["bot-token"] && !process.env.BOT_TOKEN) {
    process.stderr.write("dev-init-data: BOT_TOKEN не задан — используется dev-значение по умолчанию\n");
  }

  const user: Record<string, unknown> = { id, first_name: values.name };
  if (values["last-name"]) user.last_name = values["last-name"];
  if (values.username) user.username = values.username.replace(/^@/, "");
  if (values.lang) user.language_code = values.lang;
  user.allows_write_to_pm = true;

  const initData = signInitData(botToken, {
    user,
    authDate: Math.floor(Date.now() / 1000) - age,
    queryId: `AAdev${id}`,
    ...(values["start-param"] ? { startParam: values["start-param"] } : {}),
  });
  process.stdout.write(values.json ? `${JSON.stringify({ init_data: initData })}\n` : `${initData}\n`);
}

main();
