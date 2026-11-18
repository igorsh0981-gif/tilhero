/**
 * Исправление 6.1 — лимиты AI из админки (docs/sprint6/INTERNAL_API.md §4; admin.ts AiLimits): прокси provider-gateway
 * `GET|PUT|DELETE /internal/v1/providers/ai_web/limits` с actor сотрудника.
 *  - GET — discovery.manage или ops.kill_switch;
 *  - PUT {ai_daily_usd, news_daily_usd, pages_daily, concierge_daily_usd?, evaluation_daily_usd?, reason} и
 *    DELETE {reason?} («вернуть по умолчанию») — ops.kill_switch + step-up (как kill switch: меняют расход AI сразу,
 *    в т. ч. на текущие сутки).
 * Спринт 7 (docs/sprint7/INTERNAL_API.md §3.2, §6): тот же прокси и по пути /admin/v1/ai/limits; AiLimits += бюджеты
 * консьержа и Test Console (свои, не входят в ai_daily); в PUT они необязательны (нет поля — действующее значение).
 * Аудит ai.limits.update / ai.limits.reset пишет provider-gateway синхронно до изменения — свой таймаут 15 с, без
 * повторов (повтор после таймаута дал бы двойной аудит), 503 «аудит недоступен» → 503 AUDIT_UNAVAILABLE (лимиты не
 * изменены, можно повторить).
 * Первая линия проверки — та же, что у provider-gateway: деньги — строка до 2 знаков, ai 0–50, news 0–ai, страницы —
 * целое 0–5000 (иначе 422 VALIDATION_ERROR {field}). Ответ домена нормализуется строго (normalizeLimits): испорченный →
 * 503 UPSTREAM_UNAVAILABLE {service: "provider-gateway"}; updated_by_name — admin-identity staff/lookup.
 */
import { AppError, type UpstreamError } from "@tilhero/ts-common";
import type { AiLimits, AiLimitsInput, AiLimitValues } from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { staffOf, validationError, type App, type StaffAuth } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { obj, str } from "../schemas.js";
import { AI_LIMITS, ok } from "../responses.js";
import { upstreamUnavailable } from "../upstream.js";
import { cleanText, isoTime } from "./travel.js";

const LIMITS = "/internal/v1/providers/ai_web/limits";
/** Синхронный аудит provider-gateway (5 с + повтор) + запись — как у kill switch (PAUSE_TIMEOUT_MS). */
export const LIMITS_TIMEOUT_MS = 15_000;
export const AI_DAILY_MAX_USD = 50;
export const PAGES_DAILY_MAX = 5000;
/** Ввод: "2", "2.5", "2.50" (как provider-gateway: до 2 знаков, без экспоненты и запятой). */
const USD_IN_RE = /^\d{1,2}(\.\d{1,2})?$/;
/** Ответ provider-gateway: "2.50". */
const USD_OUT_RE = /^\d{1,10}\.\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Деньги в центах (целые): сравнение без плавающей точки. */
export const cents = (v: string): number => {
  const [i, f = ""] = v.split(".");
  return Number(i) * 100 + Number(f.padEnd(2, "0"));
};

/** Проверка тела PUT поверх схемы: границы и news ≤ ai. */
export function checkLimits(b: Omit<AiLimitsInput, "reason">): void {
  if (!USD_IN_RE.test(b.ai_daily_usd) || cents(b.ai_daily_usd) > AI_DAILY_MAX_USD * 100) {
    throw validationError("ai_daily_usd", `Общий бюджет AI — от 0 до ${AI_DAILY_MAX_USD} USD, не больше 2 знаков после точки`);
  }
  if (!USD_IN_RE.test(b.news_daily_usd)) throw validationError("news_daily_usd", "Бюджет новостей — сумма в USD, не больше 2 знаков после точки");
  if (cents(b.news_daily_usd) > cents(b.ai_daily_usd)) throw validationError("news_daily_usd", "Бюджет новостей не может быть больше общего бюджета AI");
  // спринт 7: свои бюджеты агентов — 0–50 каждое, независимо от ai_daily_usd
  for (const f of ["concierge_daily_usd", "evaluation_daily_usd"] as const) {
    const v = b[f];
    if (v !== undefined && (!USD_IN_RE.test(v) || cents(v) > AI_DAILY_MAX_USD * 100)) {
      throw validationError(f, `Бюджет агента — от 0 до ${AI_DAILY_MAX_USD} USD, не больше 2 знаков после точки`);
    }
  }
}

function values(v: unknown): AiLimitValues | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const ai = typeof x.ai_daily_usd === "string" && USD_OUT_RE.test(x.ai_daily_usd) ? x.ai_daily_usd : null;
  const news = typeof x.news_daily_usd === "string" && USD_OUT_RE.test(x.news_daily_usd) ? x.news_daily_usd : null;
  const pages = typeof x.pages_daily === "number" && Number.isSafeInteger(x.pages_daily) && x.pages_daily >= 0 ? x.pages_daily : null;
  if (ai === null || news === null || pages === null) return null;
  // спринт 7: бюджеты агентов необязательны — gateway 6.1 их не отдаёт (поле → null, админка его скрывает);
  // поле есть, но испорчено → ответ испорчен целиком, как и у остальных значений
  const agent = (k: string): string | null | undefined => {
    const raw = x[k];
    if (raw === undefined || raw === null) return null;
    return typeof raw === "string" && USD_OUT_RE.test(raw) ? raw : undefined;
  };
  const concierge = agent("concierge_daily_usd");
  const evaluation = agent("evaluation_daily_usd");
  if (concierge === undefined || evaluation === undefined) return null;
  return { ai_daily_usd: ai, news_daily_usd: news, pages_daily: pages, concierge_daily_usd: concierge, evaluation_daily_usd: evaluation };
}

/** Ответ provider-gateway → AiLimits (без updated_by_name); испорченные значения, источник или defaults → null. */
export function normalizeLimits(v: unknown): AiLimits | null {
  const cur = values(v);
  if (!cur) return null;
  const x = v as Record<string, unknown>;
  const defaults = values(x.defaults);
  const source = x.source === "admin" || x.source === "env" ? x.source : null;
  if (!defaults || !source) return null;
  const by = typeof x.updated_by === "string" && x.updated_by.length <= 64 ? x.updated_by : null;
  return {
    ...cur,
    source,
    updated_by: by,
    updated_by_name: null,
    updated_at: isoTime(x.updated_at),
    reason: cleanText(x.reason, 300),
    defaults,
  };
}

/** Имя того, кто задал лимиты (только UUID сотрудника; "system" и прочее — без lookup). */
export async function namedLimits(ctx: BffContext, auth: StaffAuth, l: AiLimits): Promise<AiLimits> {
  if (!l.updated_by || !UUID_RE.test(l.updated_by)) return l;
  const names = await ctx.names.resolve([l.updated_by], auth);
  return { ...l, updated_by_name: names.get(l.updated_by) ?? null };
}

/** 503 provider-gateway «аудит недоступен» → AUDIT_UNAVAILABLE с текстом про лимиты. */
export function limitsAuditUnavailable(err: UpstreamError): AppError | undefined {
  if (err.status !== 503) return undefined;
  if (err.code !== "AUDIT_UNAVAILABLE" && err.details?.service !== "audit") return undefined;
  return new AppError(503, "AUDIT_UNAVAILABLE", "Журнал аудита недоступен: лимиты AI не изменены. Повторите позже", { service: "audit" });
}

const MONEY_IN = str(1, 5, { pattern: "^\\d{1,2}(\\.\\d{1,2})?$" });

export function limitsRoutes(app: App, ctx: BffContext): void {
  const gateway = ctx.domains.providerGateway;
  const out = async (auth: StaffAuth, body: unknown): Promise<AiLimits> => {
    const l = normalizeLimits(body);
    if (!l) {
      ctx.log.warn({ upstream: "provider-gateway", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "ai limits rejected by normalization");
      throw upstreamUnavailable("provider-gateway");
    }
    return namedLimits(ctx, auth, l);
  };
  const write = { timeoutMs: LIMITS_TIMEOUT_MS, retries: 0, mapServerError: limitsAuditUnavailable };

  for (const path of LIMITS_PATHS) registerLimits(app, path, out, gateway, write);
}

/** 6.1: /admin/v1/discovery/limits (admin-web «Поиск событий»); спринт 7: /admin/v1/ai/limits («Бюджеты и лимиты»). */
export const LIMITS_PATHS = ["/admin/v1/discovery/limits", "/admin/v1/ai/limits"] as const;

function registerLimits(
  app: App,
  path: string,
  out: (auth: StaffAuth, body: unknown) => Promise<AiLimits>,
  gateway: BffContext["domains"]["providerGateway"],
  write: { timeoutMs: number; retries: number; mapServerError: typeof limitsAuditUnavailable },
): void {
  app.get(
    path,
    { config: requirePermission("discovery.manage", "ops.kill_switch"), schema: { response: ok(AI_LIMITS) } },
    async (req) => {
      const auth = staffOf(req);
      return out(auth, await gateway.get<unknown>(LIMITS, { actor: auth.actor }));
    },
  );

  app.put<{ Body: AiLimitsInput }>(
    path,
    {
      config: { ...requirePermission("ops.kill_switch"), ...requireStepUp() },
      schema: {
        response: ok(AI_LIMITS),
        body: obj(
          {
            ai_daily_usd: MONEY_IN,
            news_daily_usd: MONEY_IN,
            pages_daily: { type: "integer", minimum: 0, maximum: PAGES_DAILY_MAX },
            concierge_daily_usd: MONEY_IN,
            evaluation_daily_usd: MONEY_IN,
            reason: str(3, 300),
          },
          ["ai_daily_usd", "news_daily_usd", "pages_daily", "reason"],
        ),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      checkLimits(req.body);
      const reason = req.body.reason.trim();
      if (reason.length < 3) throw validationError("reason", "Причина — от 3 символов");
      const res = await gateway.call("PUT", LIMITS, { actor: auth.actor, body: { ...req.body, reason }, ...write });
      return out(auth, res.body);
    },
  );

  app.delete<{ Body: { reason?: string } }>(
    path,
    {
      config: { ...requirePermission("ops.kill_switch"), ...requireStepUp() },
      schema: { response: ok(AI_LIMITS), body: obj({ reason: str(3, 300) }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const reason = req.body?.reason?.trim();
      if (reason !== undefined && reason.length < 3) throw validationError("reason", "Причина — от 3 символов");
      const res = await gateway.call("DELETE", LIMITS, { actor: auth.actor, query: { reason }, ...write });
      return out(auth, res.body);
    },
  );
}
