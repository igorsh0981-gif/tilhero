/**
 * Доработка 9.4 «Что нового»: заметки о релизах приложения (не «Пока вас не было» — то изменения событий).
 * user_id — только из сессии; отметка «просмотрено» хранится в preferences (одна на все устройства).
 * Лимит — общая политика пользователя tg.user (auth.ts), отдельной политики нет.
 */
import type { FastifyReply } from "fastify";
import { AppError } from "@tilhero/ts-common";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, type App } from "../http.js";
import { WhatsNewResponseSchema, WhatsNewSeenRequestSchema, WhatsNewSeenResponseSchema } from "../schemas.js";
import { etagMatches, etagOf, noteView, pickWhatsNew, type SeenState } from "../whatsNew.js";

const SEEN = "/internal/v1/me/release-notes/seen";

export const whatsNewNotFound = () => new AppError(404, "WHATS_NEW_NOT_FOUND", "Заметка о релизе не найдена");

export function whatsNewRoutes(app: App, ctx: BffContext): void {
  const preferences = ctx.domains.preferences;

  app.get(
    "/v1/whats-new",
    {
      config: { access: "user" },
      schema: {
        tags: ["whats-new"],
        summary: "«Что нового»: непросмотренные заметки о релизах (≤ 3) и последняя заметка",
        description:
          "Новый пользователь старых заметок не видит (последняя отмечается просмотренной при первом обращении). " +
          "ETag: If-None-Match с тем же значением → 304. 503 UPSTREAM_UNAVAILABLE — шторка просто не показывается.",
        security: BEARER,
        response: { 200: WhatsNewResponseSchema, ...errorResponses(401, 423) },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      const [notes, seen] = await Promise.all([ctx.whatsNew.get(), preferences.get<SeenState>(SEEN, { subject: userId })]);
      const pick = pickWhatsNew(notes, seen);
      if (pick.baseline) {
        const b = pick.baseline;
        // отметка нового пользователя — не критична для ответа: при сбое повторится при следующем входе
        await preferences
          .put(SEEN, { subject: userId, body: { release_note_id: b.release_note_id, published_at: b.published_at } })
          .catch((err: unknown) => req.log.warn({ err_name: (err as Error)?.name, upstream: "preferences" }, "whats-new baseline not saved"));
      }
      const body = { items: pick.items.map(noteView), latest: notes[0] ? noteView(notes[0]) : null };
      const etag = etagOf(body);
      void reply.header("etag", etag).header("cache-control", "private, no-cache").header("vary", "authorization");
      // 304 — без тела (схема ответа описывает только 200)
      if (etagMatches(req.headers["if-none-match"], etag)) return (reply as unknown as FastifyReply).code(304).send();
      return body;
    },
  );

  app.post(
    "/v1/whats-new/seen",
    {
      config: { access: "user" },
      schema: {
        tags: ["whats-new"],
        summary: "Отметить заметку просмотренной (закрытие шторки «Что нового»)",
        description:
          "Идемпотентно; отметка только движется вперёд. Время публикации берётся из ленты experience-config, а не из " +
          "запроса. 404 WHATS_NEW_NOT_FOUND — заметка не опубликована (черновик, архив, неизвестный id).",
        security: BEARER,
        body: WhatsNewSeenRequestSchema,
        response: { 200: WhatsNewSeenResponseSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const id = req.body.release_note_id.toLowerCase();
      let note = (await ctx.whatsNew.get()).find((n) => n.release_note_id === id);
      // опубликована позже, чем обновился кэш ленты — перечитать мимо кэша (один раз)
      note ??= (await ctx.whatsNew.get(true)).find((n) => n.release_note_id === id);
      if (!note) throw whatsNewNotFound();
      const seen = await preferences.put<SeenState>(SEEN, {
        subject: userId,
        body: { release_note_id: note.release_note_id, published_at: note.published_at },
      });
      return { last_seen_release_note_id: seen.release_note_id };
    },
  );
}
