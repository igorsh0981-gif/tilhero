/**
 * Конфигурация интерфейса (experience-config): config.read — состояние, версии, активации; config.edit — новая
 * версия; config.publish — активация и откат (A46). Idempotency-Key команд пробрасывается (повтор двойного клика
 * не создаёт вторую активацию); статус домена сохраняется (201 / 200 no-op).
 */
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, staffOf, type App } from "../http.js";
import { authenticated, requirePermission } from "../rbac.js";
import { CURSOR_Q, LIMIT_Q, REASON, UUID, enumOf, nullable, obj, pageQuery, params, query, str } from "../schemas.js";
import {
  ok,
  CONFIG_ACTIVATION,
  CONFIG_ACTIVATION_PAGE,
  CONFIG_STATE,
  CONFIG_VERSION,
  CONFIG_VERSION_PAGE,
  EXPERIENCE_CURRENT,
  RELEASE_NOTE,
  RELEASE_NOTE_PAGE,
} from "../responses.js";

const APP = enumOf(["miniapp", "admin"]);
const VERSION = str(1, 32, { pattern: "^[0-9A-Za-z.+-]+$" });
const APP_PARAMS = params({ app: APP });

// ---------- 9.4 «Что нового»: форма заметки (первая линия; experience-config проверяет повторно и глубже) ----------
// Маршруты и иконки — packages/contracts/release-notes.json (сверка — test/whatsnew94.test.ts).
export const NOTE_ROUTES = ["home", "catalog", "watch", "news", "profile", "support"] as const;
export const NOTE_ICONS = [
  "spark", "ticket", "globe", "pin", "bell", "radar", "news", "route", "star", "plane", "bed", "search", "shield", "chat", "cal", "phone",
] as const;
const RU_EN = (max: number) => obj({ ru: str(1, max), en: str(1, max) }, ["ru", "en"]);
const NOTE_ITEM = obj(
  { title: RU_EN(80), text: RU_EN(200), link: nullable(enumOf(NOTE_ROUTES)), icon: nullable(enumOf(NOTE_ICONS)) },
  ["title", "text"],
);
const NOTE_PROPS = {
  slug: str(1, 32, { pattern: "^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$" }),
  title: RU_EN(80),
  items: { type: "array", minItems: 1, maxItems: 6, items: NOTE_ITEM },
  audience: enumOf(["all", "existing"]),
};
const NOTE_BODY = obj(NOTE_PROPS, ["slug", "title", "items"]);
const NOTE_UPDATE_BODY = obj({ ...NOTE_PROPS, expected_version: { type: "integer", minimum: 1 } }, ["slug", "title", "items", "expected_version"]);
const NOTE_PARAMS = params({ id: UUID });
const NOTES = "/admin/v1/release-notes";

export function experienceRoutes(app: App, ctx: BffContext): void {
  const exp = ctx.domains.experience;
  const base = (a: string) => `/admin/v1/experience/${a}`;

  app.get<{ Params: { app: string } }>(
    "/admin/v1/experience/:app/state",
    { config: requirePermission("config.read"), schema: { response: ok(CONFIG_STATE), params: APP_PARAMS } },
    async (req) => exp.get(`${base(req.params.app)}/state`, { actor: staffOf(req).actor }),
  );

  /**
   * Действующая конфигурация (experience-config GET /internal/v1/experience/{app}/current, без actor).
   * app=admin — тема админки нужна КАЖДОМУ вошедшему сотруднику (A46: откат темы без пересборки web), поэтому
   * доступна любой сессии; app=miniapp — config.read. В admin.ts маршрута нет — см. «Запросы к общему коду».
   */
  app.get(
    "/admin/v1/experience/admin/current",
    { config: authenticated(), schema: { response: ok(EXPERIENCE_CURRENT) } },
    async () => exp.get("/internal/v1/experience/admin/current"),
  );
  app.get(
    "/admin/v1/experience/miniapp/current",
    { config: requirePermission("config.read"), schema: { response: ok(EXPERIENCE_CURRENT) } },
    async () => exp.get("/internal/v1/experience/miniapp/current"),
  );

  for (const list of ["versions", "activations"] as const) {
    app.get<{ Params: { app: string }; Querystring: { cursor?: string; limit?: string } }>(
      `/admin/v1/experience/:app/${list}`,
      {
        config: requirePermission("config.read"),
        schema: { response: ok(list === "versions" ? CONFIG_VERSION_PAGE : CONFIG_ACTIVATION_PAGE), params: APP_PARAMS, querystring: query({ cursor: CURSOR_Q, limit: LIMIT_Q }) },
      },
      async (req) => exp.get(`${base(req.params.app)}/${list}`, { actor: staffOf(req).actor, query: pageQuery(req.query) }),
    );
  }

  app.get<{ Params: { app: string; version: string } }>(
    "/admin/v1/experience/:app/versions/:version",
    { config: requirePermission("config.read"), schema: { response: ok(CONFIG_VERSION), params: params({ app: APP, version: VERSION }) } },
    async (req) =>
      exp.get(`${base(req.params.app)}/versions/${encodeURIComponent(req.params.version)}`, { actor: staffOf(req).actor }),
  );

  app.post<{ Params: { app: string }; Body: { version: string; payload: Record<string, unknown>; change_note: string } }>(
    "/admin/v1/experience/:app/versions",
    {
      config: requirePermission("config.edit"),
      schema: {
        response: ok(CONFIG_VERSION),
        params: APP_PARAMS,
        body: obj({ version: VERSION, payload: { type: "object" }, change_note: str(3, 500) }, ["version", "payload", "change_note"]),
      },
    },
    async (req, reply) => {
      const res = await exp.call("POST", `${base(req.params.app)}/versions`, {
        actor: staffOf(req).actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return reply.status(res.status).send(res.body);
    },
  );

  app.post<{ Params: { app: string }; Body: { version: string; reason: string } }>(
    "/admin/v1/experience/:app/activate",
    {
      config: requirePermission("config.publish"),
      schema: { response: ok(CONFIG_ACTIVATION), params: APP_PARAMS, body: obj({ version: VERSION, reason: REASON }, ["version", "reason"]) },
    },
    async (req, reply) => {
      const res = await exp.call("POST", `${base(req.params.app)}/activate`, {
        actor: staffOf(req).actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return reply.status(res.status).send(res.body);
    },
  );

  app.post<{ Params: { app: string }; Body: { reason: string } }>(
    "/admin/v1/experience/:app/rollback",
    {
      config: requirePermission("config.publish"),
      schema: { response: ok(CONFIG_ACTIVATION), params: APP_PARAMS, body: obj({ reason: REASON }, ["reason"]) },
    },
    async (req, reply) => {
      const res = await exp.call("POST", `${base(req.params.app)}/rollback`, {
        actor: staffOf(req).actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return reply.status(res.status).send(res.body);
    },
  );

  // ---------- 9.4 «Что нового»: заметки о релизах (те же права и CSRF, что у правок конфигурации) ----------
  app.get<{ Querystring: { status?: string; cursor?: string; limit?: string } }>(
    NOTES,
    {
      config: requirePermission("config.read"),
      schema: { response: ok(RELEASE_NOTE_PAGE), querystring: query({ status: enumOf(["draft", "published", "archived"]), cursor: CURSOR_Q, limit: LIMIT_Q }) },
    },
    async (req) =>
      exp.get(NOTES, { actor: staffOf(req).actor, query: { ...pageQuery(req.query), ...(req.query.status ? { status: req.query.status } : {}) } }),
  );

  app.get<{ Params: { id: string } }>(
    `${NOTES}/:id`,
    { config: requirePermission("config.read"), schema: { response: ok(RELEASE_NOTE), params: NOTE_PARAMS } },
    async (req) => exp.get(`${NOTES}/${encodeURIComponent(req.params.id)}`, { actor: staffOf(req).actor }),
  );

  app.post<{ Body: Record<string, unknown> }>(
    NOTES,
    { config: requirePermission("config.edit"), schema: { response: ok(RELEASE_NOTE), body: NOTE_BODY } },
    async (req, reply) => {
      const res = await exp.call("POST", NOTES, { actor: staffOf(req).actor, body: req.body, idempotencyKey: idempotencyKeyOf(req, false) });
      return reply.status(res.status).send(res.body);
    },
  );

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    `${NOTES}/:id`,
    { config: requirePermission("config.edit"), schema: { response: ok(RELEASE_NOTE), params: NOTE_PARAMS, body: NOTE_UPDATE_BODY } },
    async (req, reply) => {
      const res = await exp.call("PUT", `${NOTES}/${encodeURIComponent(req.params.id)}`, { actor: staffOf(req).actor, body: req.body });
      return reply.status(res.status).send(res.body);
    },
  );

  app.post<{ Params: { id: string }; Body: { expected_version: number; reason: string } }>(
    `${NOTES}/:id/publish`,
    {
      config: requirePermission("config.publish"),
      schema: {
        response: ok(RELEASE_NOTE),
        params: NOTE_PARAMS,
        body: obj({ expected_version: { type: "integer", minimum: 1 }, reason: REASON }, ["expected_version", "reason"]),
      },
    },
    async (req, reply) => {
      const res = await exp.call("POST", `${NOTES}/${encodeURIComponent(req.params.id)}/publish`, {
        actor: staffOf(req).actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return reply.status(res.status).send(res.body);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    `${NOTES}/:id/archive`,
    { config: requirePermission("config.publish"), schema: { response: ok(RELEASE_NOTE), params: NOTE_PARAMS, body: obj({ reason: REASON }, ["reason"]) } },
    async (req, reply) => {
      const res = await exp.call("POST", `${NOTES}/${encodeURIComponent(req.params.id)}/archive`, {
        actor: staffOf(req).actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return reply.status(res.status).send(res.body);
    },
  );
}
