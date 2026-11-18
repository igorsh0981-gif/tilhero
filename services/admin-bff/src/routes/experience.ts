/**
 * Конфигурация интерфейса (experience-config): config.read — состояние, версии, активации; config.edit — новая
 * версия; config.publish + step-up — активация и откат (admin.ts). Idempotency-Key команд пробрасывается
 * (повтор двойного клика не создаёт вторую активацию); статус домена сохраняется (201 / 200 no-op).
 * Откат применяется без сборки: Mini App и админка перечитывают конфигурацию при следующем открытии.
 */
import type { ConfigApp } from "@tilhero/contracts/admin";
import {
  CONFIG_ACTIVATION,
  CONFIG_ACTIVATION_PAGE,
  CONFIG_STATE,
  CONFIG_VERSION,
  CONFIG_VERSION_PAGE,
  experienceCurrent,
} from "../contract.js";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, staffOf, type App } from "../http.js";
import { authenticated, requirePermission, requireStepUp } from "../rbac.js";
import { CURSOR_Q, LIMIT_Q, REASON, enumOf, obj, pageQuery, params, query, str } from "../schemas.js";
import { DOMAIN } from "../upstream.js";
import { out, relay, shaped } from "./common.js";

const SERVICE = DOMAIN.experience;
const APP = enumOf(["miniapp", "admin"]);
const VERSION = str(1, 32, { pattern: "^[0-9A-Za-z.+-]+$" });
const APP_PARAMS = params({ app: APP });

export function experienceRoutes(app: App, ctx: BffContext): void {
  const exp = ctx.domains.experience;
  const base = (a: string) => `/admin/v1/experience/${a}`;

  /**
   * Действующая конфигурация (experience-config GET /internal/v1/experience/{app}/current).
   * app=admin — тема и раскладка админки нужны КАЖДОМУ вошедшему сотруднику (откат темы без пересборки web),
   * поэтому доступна любой сессии; app=miniapp — config.read.
   */
  const current = (a: ConfigApp) => experienceCurrent(a);
  app.get(
    "/admin/v1/experience/admin/current",
    { config: authenticated(), schema: { response: out(current("admin")) } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, current("admin"), await exp.get<unknown>("/internal/v1/experience/admin/current"));
    },
  );
  app.get(
    "/admin/v1/experience/miniapp/current",
    { config: requirePermission("config.read"), schema: { response: out(current("miniapp")) } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, current("miniapp"), await exp.get<unknown>("/internal/v1/experience/miniapp/current"));
    },
  );

  app.get<{ Params: { app: string } }>(
    "/admin/v1/experience/:app/state",
    { config: requirePermission("config.read"), schema: { response: out(CONFIG_STATE), params: APP_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, CONFIG_STATE, await exp.get<unknown>(`${base(req.params.app)}/state`, { actor: auth.actor }));
    },
  );

  app.get<{ Params: { app: string }; Querystring: { cursor?: string; limit?: string } }>(
    "/admin/v1/experience/:app/versions",
    {
      config: requirePermission("config.read"),
      schema: { response: out(CONFIG_VERSION_PAGE), params: APP_PARAMS, querystring: query({ cursor: CURSOR_Q, limit: LIMIT_Q }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await exp.get<unknown>(`${base(req.params.app)}/versions`, { actor: auth.actor, query: pageQuery(req.query) });
      return shaped(ctx, auth, SERVICE, CONFIG_VERSION_PAGE, body);
    },
  );

  app.get<{ Params: { app: string }; Querystring: { cursor?: string; limit?: string } }>(
    "/admin/v1/experience/:app/activations",
    {
      config: requirePermission("config.read"),
      schema: { response: out(CONFIG_ACTIVATION_PAGE), params: APP_PARAMS, querystring: query({ cursor: CURSOR_Q, limit: LIMIT_Q }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await exp.get<unknown>(`${base(req.params.app)}/activations`, { actor: auth.actor, query: pageQuery(req.query) });
      return shaped(ctx, auth, SERVICE, CONFIG_ACTIVATION_PAGE, body);
    },
  );

  app.get<{ Params: { app: string; version: string } }>(
    "/admin/v1/experience/:app/versions/:version",
    { config: requirePermission("config.read"), schema: { response: out(CONFIG_VERSION), params: params({ app: APP, version: VERSION }) } },
    async (req) => {
      const auth = staffOf(req);
      const body = await exp.get<unknown>(`${base(req.params.app)}/versions/${encodeURIComponent(req.params.version)}`, { actor: auth.actor });
      return shaped(ctx, auth, SERVICE, CONFIG_VERSION, body);
    },
  );

  app.post<{ Params: { app: string }; Body: { version: string; payload: Record<string, unknown>; change_note: string } }>(
    "/admin/v1/experience/:app/versions",
    {
      config: requirePermission("config.edit"),
      schema: {
        response: out(CONFIG_VERSION),
        params: APP_PARAMS,
        body: obj({ version: VERSION, payload: { type: "object" }, change_note: str(3, 500) }, ["version", "payload", "change_note"]),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await exp.call("POST", `${base(req.params.app)}/versions`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relay(ctx, auth, reply, SERVICE, CONFIG_VERSION, res);
    },
  );

  app.post<{ Params: { app: string }; Body: { version: string; reason: string } }>(
    "/admin/v1/experience/:app/activate",
    {
      config: { ...requirePermission("config.publish"), ...requireStepUp() },
      schema: { response: out(CONFIG_ACTIVATION), params: APP_PARAMS, body: obj({ version: VERSION, reason: REASON }, ["version", "reason"]) },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await exp.call("POST", `${base(req.params.app)}/activate`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relay(ctx, auth, reply, SERVICE, CONFIG_ACTIVATION, res);
    },
  );

  app.post<{ Params: { app: string }; Body: { reason: string } }>(
    "/admin/v1/experience/:app/rollback",
    {
      config: { ...requirePermission("config.publish"), ...requireStepUp() },
      schema: { response: out(CONFIG_ACTIVATION), params: APP_PARAMS, body: obj({ reason: REASON }, ["reason"]) },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await exp.call("POST", `${base(req.params.app)}/rollback`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relay(ctx, auth, reply, SERVICE, CONFIG_ACTIVATION, res);
    },
  );
}
