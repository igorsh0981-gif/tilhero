/**
 * Учебный план и график активного ученика (learning-plan, sub = lrn): цель, уровень, темы, языки, график занятий
 * (дни, время, длительность, напоминания, часовой пояс), онбординг, план на сегодня, учёт занятий; справочники.
 */
import type { DirectoryItem, LearningPlan, TodayPlan } from "@tilhero/contracts/bff";
import { asLearner, loadPlan } from "../account.js";
import type { BffContext } from "../context.js";
import { BEARER, authOf, clientTimezone, errorResponses, idempotencyKey, schemaErrors, type App } from "../http.js";
import {
  ActivityRequestSchema,
  DirectoryItemSchema,
  IdempotencyHeadersSchema,
  LearningPlanSchema,
  PlanHeadersSchema,
  PlanPatchSchema,
  PlanQuerySchema,
  TodayPlanSchema,
  itemsOf,
} from "../schemas.js";

const user = { access: "user" } as const;
const TAG = ["plan"];

/** Структурные ошибки тела PATCH /v1/plan → 422 PLAN_INVALID {field, reason} (контракт); If-Match — VALIDATION_ERROR. */
const PLAN_ERRORS = schemaErrors([
  { context: "body", code: "PLAN_INVALID", message: "Некорректные параметры плана", withField: true, withReason: true },
]);

/** План — всегда активного ученика (learner_id из сессии, не из ответа домена). */
export function planView(p: LearningPlan, learnerId: string): LearningPlan {
  return { ...p, learner_id: learnerId };
}

/** План на сегодня: `week[].frozen` (спринт 6) — learning-plan до спринта 6 поля не присылает → false. */
export function todayView(t: TodayPlan): TodayPlan {
  return Array.isArray(t.week) ? { ...t, week: t.week.map((d) => ({ ...d, frozen: d.frozen === true })) } : t;
}

/** If-Match: 3 | "3" | W/"3" → "3". */
const ifMatchVersion = (v: string | undefined): string | undefined => (v === undefined ? undefined : v.replace(/^W\//, "").replace(/"/g, ""));

export function planRoutes(app: App, ctx: BffContext): void {
  const lp = ctx.domains.learningPlan;

  app.get(
    "/v1/plan",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "План активного ученика (при первом обращении — по умолчанию: daily, 19:00, 20 мин, напоминания выключены)",
        description:
          "?tz=<IANA> (или заголовок X-Timezone) передаётся в learning-plan: план по умолчанию создаётся в зоне клиента " +
          "(неизвестная зона → Asia/Tashkent). У существующего плана зона не меняется (её меняет PATCH schedule.timezone).",
        security: BEARER,
        querystring: PlanQuerySchema,
        response: { 200: LearningPlanSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      return planView(await loadPlan(ctx, asLearner(auth), req.query.tz ?? clientTimezone(req)), auth.learnerId);
    },
  );

  app.patch(
    "/v1/plan",
    {
      config: user,
      schemaErrorFormatter: PLAN_ERRORS,
      schema: {
        tags: TAG,
        summary: "Изменить план и график (онбординг и профиль)",
        description:
          "If-Match: <version> необязателен; при расхождении 409 PLAN_VERSION_CONFLICT {current_version}. 422 PLAN_INVALID " +
          "{field, reason}: days пусто/вне 1..7/повторы, время не HH:MM, длительность не 10/15/20/30, >5 тем (BFF); " +
          "неизвестная зона, тема не из справочника (learning-plan).",
        security: BEARER,
        headers: PlanHeadersSchema,
        body: PlanPatchSchema,
        response: { 200: LearningPlanSchema, ...errorResponses(401, 409, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const version = ifMatchVersion(req.headers["if-match"]);
      const plan = await lp.patch<LearningPlan>("/internal/v1/me/plan", {
        subject: asLearner(auth),
        body: req.body,
        ...(version !== undefined ? { headers: { "if-match": version } } : {}),
      });
      return planView(plan, auth.learnerId);
    },
  );

  app.post(
    "/v1/plan/onboarding/complete",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Завершить онбординг (нужны цель, уровень и график)",
        description: "409 PLAN_INCOMPLETE {missing}. Повтор — 200 без изменений.",
        security: BEARER,
        response: { 200: LearningPlanSchema, ...errorResponses(401, 409, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      return planView(await lp.post<LearningPlan>("/internal/v1/me/plan/onboarding/complete", { subject: asLearner(auth) }), auth.learnerId);
    },
  );

  app.get(
    "/v1/plan/today",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "План на сегодня: слот, минуты, серия, неделя (по часовому поясу плана)",
        description: "week[].frozen (спринт 6) — пропущенный день графика, закрытый заморозкой серии (missed остаётся true).",
        security: BEARER,
        response: { 200: TodayPlanSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      return todayView(await lp.get<TodayPlan>("/internal/v1/me/plan/today", { subject: asLearner(auth) }));
    },
  );

  app.post(
    "/v1/plan/activity",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Отметить занятие («практика» из Mini App) → план на сегодня",
        description: "Idempotency-Key (UUID) обязателен (422 IDEMPOTENCY_KEY_REQUIRED): повтор не учитывает занятие дважды.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: ActivityRequestSchema,
        response: { 200: TodayPlanSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const key = idempotencyKey(req, true)!;
      return todayView(
        await lp.post<TodayPlan>("/internal/v1/me/activities", {
          subject: asLearner(auth),
          body: { kind: req.body.kind, minutes: req.body.minutes },
          idempotencyKey: key,
        }),
      );
    },
  );

  for (const dir of ["goals", "topics"] as const) {
    app.get(
      `/v1/directory/${dir}`,
      {
        config: user,
        schema: {
          tags: ["directory"],
          summary: dir === "goals" ? "Цели обучения (RU/UZ)" : "Темы (RU/UZ)",
          security: BEARER,
          response: { 200: itemsOf(DirectoryItemSchema), ...errorResponses(401, 423) },
        },
      },
      async (req, reply) => {
        const auth = authOf(req);
        const res = await lp.get<{ items: DirectoryItem[] }>(`/internal/v1/directory/${dir}`, { subject: asLearner(auth) });
        void reply.header("cache-control", "private, max-age=300");
        return res;
      },
    );
  }
}
