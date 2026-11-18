/**
 * «Что нового», лента новостей и Remote Experience Config (experience-config).
 *
 * GET /v1/whats-new: BFF берёт из плана активного ученика (learning-plan, sub = lrn) onboarded_at = onboarding_completed_at,
 * из identity-consent (sub = аккаунт) — lang = locale аккаунта (язык интерфейса Mini App и сообщений notifications; один
 * источник языка для родителя и детских профилей — ревью T-6) и возраст активного ученика → age: kids (6-9, 10-13),
 * teens (14-17), adults (18+ и возраст не выбран). Режим (welcome / updates / none) выбирает experience-config (for-me,
 * sub = lrn). Онбординг не завершён — {mode: none} без вызова experience-config.
 * Отметки просмотра (seen) и лента (feed) — тоже от имени ученика.
 */
import { Type } from "@fastify/type-provider-typebox";
import type { Page, WhatsNew, WhatsNewNote } from "@tilhero/contracts/bff";
import { ageSegment, asAccount, asLearner, learnerAgeBand, loadMe, loadPlan } from "../account.js";
import type { BffContext } from "../context.js";
import type { AccessClaims } from "../tokens.js";
import { BEARER, authOf, clientTimezone, errorResponses, type App } from "../http.js";
import { ExperienceConfigSchema, NewsPageSchema, PageQuerySchema, WhatsNewSchema, WhatsNewSeenRequestSchema } from "../schemas.js";
import { noteView } from "../views.js";

const user = { access: "user" } as const;
const TAG = ["whats-new"];
/** Не больше 5 заметок в шторке (контракт WhatsNew). */
export const WHATS_NEW_MAX = 5;
const MODES = new Set(["welcome", "updates", "none"]);

/** Сегмент активного ученика: язык интерфейса (locale аккаунта), возраст, время завершения онбординга. */
async function segmentOf(ctx: BffContext, auth: AccessClaims, tz: string | undefined) {
  const [me, plan] = await Promise.all([loadMe(ctx, asAccount(auth)), loadPlan(ctx, asLearner(auth), tz)]);
  return {
    onboardedAt: plan.onboarding_completed_at ?? null,
    lang: me.user.locale === "uz" ? "uz" : "ru",
    age: ageSegment(learnerAgeBand(me, auth.learnerId)),
  };
}

const validNote = (n: unknown): n is WhatsNewNote =>
  typeof n === "object" && n !== null && typeof (n as WhatsNewNote).release_note_id === "string" && typeof (n as WhatsNewNote).published_at === "string";

export function whatsNewRoutes(app: App, ctx: BffContext): void {
  const experience = ctx.domains.experience;

  app.get(
    "/v1/whats-new",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "«Что нового»: welcome (после онбординга), updates (непросмотренные), none",
        description:
          "Сегмент — onboarded_at из плана активного ученика, язык интерфейса аккаунта (locale) и возраст ученика; ≤ 5 заметок. " +
          "Онбординг не завершён → mode none. 503 UPSTREAM_UNAVAILABLE — шторка просто не показывается.",
        security: BEARER,
        response: { 200: WhatsNewSchema, ...errorResponses(401, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const seg = await segmentOf(ctx, auth, clientTimezone(req));
      void reply.header("cache-control", "no-store");
      if (!seg.onboardedAt) return { mode: "none", notes: [] } satisfies WhatsNew;
      const res = await experience.get<WhatsNew>("/internal/v1/release-notes/for-me", {
        subject: asLearner(auth),
        query: { onboarded_at: seg.onboardedAt, lang: seg.lang, age: seg.age },
      });
      const notes = (Array.isArray(res?.notes) ? res.notes : []).filter(validNote).slice(0, WHATS_NEW_MAX).map(noteView);
      const mode = MODES.has(res?.mode) && notes.length > 0 ? res.mode : "none";
      return { mode, notes: mode === "none" ? [] : notes } satisfies WhatsNew;
    },
  );

  app.post(
    "/v1/whats-new/seen",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Отметить заметки просмотренными (закрытие шторки) — заметка показывается ученику один раз",
        description: "Идемпотентно; неизвестные id игнорируются доменом. Отметки хранятся на сервере (переживают переустановку).",
        security: BEARER,
        body: WhatsNewSeenRequestSchema,
        response: { 204: Type.Null({ description: "Отмечено" }), ...errorResponses(401, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      await experience.post("/internal/v1/release-notes/seen", {
        subject: asLearner(auth),
        body: { release_note_ids: req.body.release_note_ids.map((id) => id.toLowerCase()) },
      });
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/v1/news",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Лента опубликованных новостей, видимых ученику (язык интерфейса аккаунта и возраст)",
        security: BEARER,
        querystring: PageQuerySchema,
        response: { 200: NewsPageSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const seg = await segmentOf(ctx, auth, clientTimezone(req));
      const page = await experience.get<Page<WhatsNewNote>>("/internal/v1/release-notes/feed", {
        subject: asLearner(auth),
        query: { lang: seg.lang, age: seg.age, limit: req.query.limit ?? 20, cursor: req.query.cursor },
      });
      return { items: (Array.isArray(page?.items) ? page.items : []).filter(validNote).map(noteView), next_cursor: page?.next_cursor ?? null };
    },
  );

  app.get(
    "/v1/experience/config",
    {
      config: { access: "public", ipLimit: "public" },
      schema: {
        tags: ["experience"],
        summary: "Remote Experience Config Mini App (тема «Тетрадь», секции главной, флаги)",
        description: "Публично, кэш 60 с; при недоступности experience-config — последняя полученная версия.",
        response: { 200: ExperienceConfigSchema, ...errorResponses() },
      },
    },
    async (_req, reply) => {
      const cfg = await ctx.experience.get();
      void reply.header("cache-control", "public, max-age=60");
      return cfg;
    },
  );
}
