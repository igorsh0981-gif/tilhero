/**
 * Спринт 5 — оценка произношения (bff.ts PronunciationView, APP-ADV-01; INTERNAL_API §1.9, §8).
 *
 * POST /v1/memory/pronunciation?target=card:<card_id> | sentence:<kind>:<key>:<version>:<locator>, тело — audio/wav:
 *  1. авторизация (onRequest, до чтения тела);
 *  2. тело: только `audio/wav` (`audio/x-wav`, `audio/wave`) и не больше 600 000 байт — `bodyLimit` и парсер есть
 *     ТОЛЬКО у этого маршрута (своя область Fastify); другой Content-Type → 422 AUDIO_INVALID {reason: format},
 *     больше лимита → 422 AUDIO_INVALID {reason: too_large};
 *  3. target — по схеме (422 VALIDATION_ERROR {field: target});
 *  4. заголовок WAV (wav.ts): RIFF/WAVE, PCM 16 бит, моно, 16 000 Гц, 0,5..15 с → иначе 422 AUDIO_INVALID {reason};
 *  5. лимит `tg.memory.pronunciation` — 20 за 10 минут на ученика;
 *  6. memory `POST /internal/v1/pronunciation?target_kind=card|sentence&target=…` — сырое тело как есть, claims ученика
 *     (memoryApi.ts), таймаут MEMORY_PRONUNCIATION_TIMEOUT_MS (20 с), без повторов. Эталонный текст подставляет memory,
 *     согласие на запись голоса (403 VOICE_CONSENT_REQUIRED {who}) и доступность речи (503 SPEECH_UNAVAILABLE) проверяет
 *     memory — коды передаются как есть;
 *  7. ответ memory (PronunciationView или PronunciationResult ai.ts + attempt_id) → PronunciationView по контракту:
 *     score = scores.pron, разборчивость по баллу, ≤ 40 слов, ≤ 2 советов, message — по статусу.
 *
 * Аудио живёт только в памяти процесса на время запроса: не пишется на диск, в Redis, логи и метрики. В логе — только
 * длительность записи и статус (ни байтов, ни эталонного текста, ни target).
 */
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type * as C from "@tilhero/contracts/bff";
import type { Localized } from "@tilhero/contracts/content";
import { AppError } from "@tilhero/ts-common";
import type { FastifyError } from "fastify";
import type { Static } from "@fastify/type-provider-typebox";
import { expectShape } from "../check.js";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, type App } from "../http.js";
import { MEMORY, memoryCall } from "../memoryApi.js";
import { PronunciationDomainSchema, PronunciationQuerySchema, PronunciationViewSchema } from "../schemas.js";
import { WAV_MAX_BYTES, audioInvalid, checkWav } from "../wav.js";

/** Content-Type записи: audio/wav и его распространённые синонимы (параметры допустимы). */
export const WAV_CONTENT_TYPE = /^audio\/(wav|x-wav|wave)\s*(;.*)?$/i;

const MESSAGES: Record<"insufficient_evidence" | "unavailable", Localized> = {
  insufficient_evidence: {
    ru: "Не удалось оценить — говорите ближе к микрофону",
    uz: "Baholab boʻlmadi — mikrofonga yaqinroq gapiring",
  },
  unavailable: {
    ru: "Оценка произношения сейчас недоступна",
    uz: "Talaffuzni baholash hozir mavjud emas",
  },
};

/** target публичного API → параметры memory: card:<id> → (card, id); sentence:<kind>:<key>:<version>:<locator> → (sentence, остаток). */
export function parseTarget(raw: string): { targetKind: "card" | "sentence"; target: string } {
  if (raw.startsWith("card:")) return { targetKind: "card", target: raw.slice("card:".length).toLowerCase() };
  return { targetKind: "sentence", target: raw.slice("sentence:".length) };
}

const intelligibilityOf = (score: number): NonNullable<C.PronunciationView["intelligibility"]> =>
  score >= 80 ? "clear" : score >= 60 ? "mostly_clear" : "needs_practice";

/** Ответ memory → PronunciationView (только поля контракта; баллы — только при ok). */
export function pronunciationView(r: Static<typeof PronunciationDomainSchema>): C.PronunciationView {
  const ok = r.status === "ok";
  const score = ok ? (r.scores?.pron ?? r.score ?? null) : null;
  return {
    attempt_id: r.status === "unavailable" ? null : (r.attempt_id?.toLowerCase() ?? null),
    status: r.status,
    reference_text: r.reference_text,
    intelligibility: ok ? (r.intelligibility ?? (score === null ? null : intelligibilityOf(score))) : null,
    score,
    words: ok ? (r.words ?? []).slice(0, 40).map((w) => ({ word: w.word, accuracy: w.accuracy, error_type: w.error_type })) : [],
    tips: ok ? (r.tips ?? []).slice(0, 2).map((t) => ({ word: t.word, text: t.text })) : [],
    message: r.status === "ok" ? null : r.message ? { ru: r.message.ru, uz: r.message.uz } : MESSAGES[r.status],
  };
}

/** Ошибки разбора тела этого маршрута → контрактные: больше лимита — too_large, не WAV-тип — format. */
function mapBodyError(err: FastifyError): Error {
  if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE" || err.statusCode === 413) return audioInvalid("too_large");
  if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || err.statusCode === 415) return audioInvalid("format");
  return err;
}

export async function pronunciationRoutes(app: App, ctx: BffContext): Promise<void> {
  const memory = ctx.domains.memory;
  const log = ctx.log;

  // своя область: парсер audio/wav и обработка ошибок тела — только для этого маршрута
  await app.register(async (scope) => {
    const typed = scope.withTypeProvider<TypeBoxTypeProvider>();
    typed.removeAllContentTypeParsers();
    typed.addContentTypeParser(WAV_CONTENT_TYPE, { parseAs: "buffer", bodyLimit: WAV_MAX_BYTES }, (_req, body, done) => done(null, body));
    const parent = typed.errorHandler;
    typed.setErrorHandler(function (err, req, reply) {
      return parent.call(this, mapBodyError(err as FastifyError) as FastifyError, req, reply);
    });

    typed.post(
      "/v1/memory/pronunciation",
      {
        config: { access: "user" },
        bodyLimit: WAV_MAX_BYTES,
        schema: {
          tags: ["memory"],
          summary: "«Произнести»: оценка произношения по записи (баллы по словам, 1–2 совета; аудио не сохраняется)",
          description:
            "Тело — audio/wav: PCM 16 бит, моно, 16 000 Гц, 0,5..15 с, ≤ 600 000 байт. ?target=card:<card_id> | " +
            "sentence:<kind>:<key>:<version>:<locator> — эталонный текст подставляет сервер. 422 AUDIO_INVALID {reason: format | " +
            "too_short | too_long | too_large}; 403 VOICE_CONSENT_REQUIRED {who: self | guardian}; 404 CARD_NOT_FOUND | " +
            "CONTENT_NOT_FOUND; 503 SPEECH_UNAVAILABLE — оценка выключена (кнопку скрыть); 429 RATE_LIMITED " +
            "(tg.memory.pronunciation, 20 за 10 минут на ученика). Аудио и текст в лог не пишутся.",
          consumes: ["audio/wav"],
          security: BEARER,
          querystring: PronunciationQuerySchema,
          response: { 200: PronunciationViewSchema, ...errorResponses(401, 403, 404, 410, 423) },
        },
      },
      async (req) => {
        const auth = authOf(req);
        const bytes = req.body;
        if (!Buffer.isBuffer(bytes)) throw audioInvalid("format");
        const wav = checkWav(bytes);
        const { targetKind, target } = parseTarget(req.query.target);
        await ctx.limiter.enforce("tg.memory.pronunciation", auth.learnerId);
        const { ro } = await memoryCall(ctx, auth, req);
        let raw: unknown;
        try {
          raw = await memory.json("POST", "/internal/v1/pronunciation", {
            ...ro,
            query: { ...ro.query, target_kind: targetKind, target },
            rawBody: { bytes, contentType: "audio/wav" },
            timeoutMs: ctx.config.memoryPronunciationTimeoutMs,
          });
        } catch (err) {
          const e = err instanceof AppError ? err : null;
          log.info({ audio_ms: wav.durationMs, upstream: MEMORY, upstream_status: e?.status ?? 0, upstream_code: e?.code ?? "UNKNOWN" }, "pronunciation not assessed");
          throw err;
        }
        const view = pronunciationView(expectShape(log, MEMORY, "pronunciation", PronunciationDomainSchema, raw));
        log.info({ audio_ms: wav.durationMs, outcome: view.status }, "pronunciation assessed");
        return view;
      },
    );
  });
}
