/**
 * Release 4.1 — озвучка английских фраз контента (bff.ts SpeechRequest): аудирование теста на уровень, «Прослушать» в
 * разговоре с персонажем, медиа без аудиофайла. Синтез речи устройства (Web Speech) во встроенном браузере Telegram на
 * Android отсутствует, на iOS тихий — поэтому звук приходит файлом MP3 из tts и играет в Mini App через HTMLAudioElement.
 *
 * POST /v1/speech → tts POST /internal/v1/speech (то же тело, нормализованное; внутренний JWT telegram-bff, sub = аккаунт).
 *  - 422 TEXT_INVALID — текст пуст / длиннее 400 знаков / с управляющими символами / без латиницы, неизвестный голос или
 *    скорость (и 422 самого tts);
 *  - 429 RATE_LIMITED — `tg.speech`, 120 за 10 минут на аккаунт;
 *  - 503 SPEECH_UNAVAILABLE {service: "tts"} — TTS_URL не задан, tts недоступен / таймаут / 5xx / любой другой ответ:
 *    Mini App откатывается на синтез устройства, если на нём есть английский голос.
 * Текст фразы в лог не пишется (redact `req.body.text`, ключ `text` вычищается из любого объекта лога).
 */
import { AppError } from "@tilhero/ts-common";
import type { SpeechRequest } from "@tilhero/contracts/bff";
import { asAccount } from "../account.js";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, schemaErrors, type App } from "../http.js";
import { SpeechBytesSchema, SpeechRequestSchema } from "../schemas.js";
import { readAudio } from "./content.js";

/** Длина фразы после нормализации (в символах Unicode — как len() в tts). */
export const SPEECH_MAX_CHARS = 400;
/** Управляющие символы (Cc), кроме табуляции и переводов строки — те схлопываются в пробел (как в tts). */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const LATIN_RE = /[A-Za-z]/;

export const textInvalid = (field = "text") =>
  new AppError(422, "TEXT_INVALID", "Текст для озвучки пуст, слишком длинный или не английский", { field });
export const speechUnavailable = () => new AppError(503, "SPEECH_UNAVAILABLE", "Озвучка временно недоступна", { service: "tts" });

/** Нормализация текста как в tts: пробелы схлопываются, края обрезаются. null — текст не годится для озвучки. */
export function normalizeSpeechText(raw: string): string | null {
  if (CONTROL_RE.test(raw)) return null;
  const text = raw.replace(/\s+/g, " ").trim();
  const chars = [...text].length;
  if (chars < 1 || chars > SPEECH_MAX_CHARS || !LATIN_RE.test(text)) return null;
  return text;
}

/** Любая ошибка схемы тела (нет поля, лишнее поле, чужой голос или скорость) — 422 TEXT_INVALID {field}. */
const speechSchemaErrors = schemaErrors([{ context: "body", code: "TEXT_INVALID", message: "Текст для озвучки пуст, слишком длинный или не английский", withField: true }]);

export function speechRoutes(app: App, ctx: BffContext): void {
  const log = ctx.log;

  app.post(
    "/v1/speech",
    {
      config: { access: "user" },
      schemaErrorFormatter: speechSchemaErrors,
      schema: {
        tags: ["speech"],
        summary: "Озвучка английской фразы контента: MP3 из tts (аудирование, «Прослушать», медиа без файла)",
        description:
          "Ответ — audio/mpeg (MP3, моно), Cache-Control: private, max-age=86400. 422 TEXT_INVALID {field} — текст пуст, " +
          "длиннее 400 знаков, с управляющими символами или без латиницы; неизвестный variant / speed. 429 RATE_LIMITED " +
          "(tg.speech, 120 за 10 минут на аккаунт). 503 SPEECH_UNAVAILABLE {service: tts} — озвучка недоступна " +
          "(Mini App откатывается на синтез речи устройства).",
        security: BEARER,
        body: SpeechRequestSchema,
        response: { 200: SpeechBytesSchema, ...errorResponses(401, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const text = normalizeSpeechText(req.body.text);
      if (text === null) throw textInvalid();
      const body: Required<SpeechRequest> = { text, variant: req.body.variant, speed: req.body.speed ?? "normal" };

      const tts = ctx.tts;
      if (!tts) throw speechUnavailable();
      const accountId = asAccount(auth);
      await ctx.limiter.enforce("tg.speech", accountId);

      let resp: Response;
      try {
        resp = await tts.request("POST", "/internal/v1/speech", { subject: accountId, body });
      } catch (err) {
        if (err instanceof AppError && err.status === 422) throw textInvalid();
        // 5xx, таймаут и сеть RawClient уже записал («domain unavailable»); прочие 4xx tts — здесь
        if (err instanceof AppError && err.status < 500) {
          log.warn({ upstream: "tts", upstream_status: err.status, upstream_code: err.code }, "speech unavailable");
        }
        throw speechUnavailable();
      }
      let bytes: Buffer;
      try {
        if (resp.status !== 200) throw new Error(`unexpected status ${resp.status}`);
        const a = await readAudio(resp);
        if (a.contentType !== "audio/mpeg") throw new Error("unexpected content type");
        bytes = a.bytes;
      } catch (err) {
        await resp.body?.cancel().catch(() => undefined);
        log.warn(
          { upstream: "tts", upstream_status: resp.status, check: "speech_audio", reason: (err as Error).message, upstream_code: "UPSTREAM_BAD_RESPONSE" },
          "speech audio rejected",
        );
        throw speechUnavailable();
      }
      return reply
        .header("content-type", "audio/mpeg")
        .header("content-length", String(bytes.length))
        .header("cache-control", "private, max-age=86400")
        .send(bytes);
    },
  );
}
