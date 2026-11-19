/**
 * Языки и языковые пары (catalog `/admin/v1/languages`, `/admin/v1/language-pairs`): content.read — справочники;
 * lang.manage + step-up — правка (новый язык или пара — PUT по новому коду, без изменения кода).
 *
 * PairCard собирается из двух доменов: карточка и готовность контента — catalog; `readiness.diagnostic_test`
 * (опубликованный тест пары, "dx-en-adult@1"; взрослый приоритетнее детского) — diagnostics `GET
 * /admin/v1/diagnostics/tests`; `learners` (ученики с результатом диагностики по паре) — diagnostics `GET
 * /admin/v1/diagnostics/pairs`. Дополнение необязательное: diagnostics недоступен → значения catalog (null / 0),
 * экран открывается (как блоки дашборда).
 *
 * Публикация пары (status=published, пара ещё не опубликована): catalog проверяет курс, уроки, рубрики и локализации,
 * тест диагностики живёт в diagnostics — его проверяет admin-bff ДО вызова catalog: нет опубликованного теста →
 * 422 PAIR_NOT_READY {missing: [...недостающее по готовности catalog, "diagnostic_test"]} (catalog не вызывается,
 * изменение не применяется). diagnostics недоступен → 503 (fail-closed). Тест есть — PAIR_NOT_READY catalog как есть.
 */
import type { DiagnosticTestRow, PairCard } from "@tilhero/contracts/admin";
import { AppError } from "@tilhero/ts-common";
import { BadValue, parseDomain } from "../codec.js";
import { DIAGNOSTIC_PAIRS, DIAGNOSTIC_TESTS, LANGUAGE, LANGUAGES, PAIR_CARD, PAIR_CARDS } from "../contractContent.js";
import type { BffContext } from "../context.js";
import { passReplayed, staffOf, type App, type StaffAuth } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { LANGUAGE_BODY, LANG_CODE, PAIR_BODY, PAIR_ID, params } from "../schemas.js";
import { DOMAIN } from "../upstream.js";
import { out, relay, shaped } from "./common.js";

const CATALOG = DOMAIN.catalog;
const DIAG = DOMAIN.diagnostics;
const PAIRS = "/admin/v1/language-pairs";

type PairPut = { pair_id: string; status: string; course_id: string | null; reason: string } & Record<string, unknown>;

/** Опубликованный тест диагностики пары: "test_id@version"; взрослый приоритетнее детского; нет — null. */
export function publishedTestOf(tests: readonly DiagnosticTestRow[], pairId: string): string | null {
  const rank = (t: DiagnosticTestRow) => (t.audience === "adults" ? 0 : 1);
  const found = tests
    .filter((t) => t.pair_id === pairId && t.published_version !== null)
    .sort((a, b) => rank(a) - rank(b) || a.test_id.localeCompare(b.test_id))[0];
  return found ? `${found.test_id}@${found.published_version}` : null;
}

/**
 * Недостающее для публикации по готовности catalog (как catalog `missing_for_publish`: курс, уроки, рубрики,
 * локализации) — для объединённого PAIR_NOT_READY, когда до catalog дело не дошло. Курс меняется в этом же запросе
 * или пары ещё нет — готовность неизвестна (полный список даст catalog, когда тест появится).
 */
export function catalogMissing(current: PairCard | undefined, body: Pick<PairPut, "course_id">): string[] {
  if (!body.course_id) return ["course"];
  if (!current || current.course_id !== body.course_id) return [];
  const r = current.readiness;
  return [
    ...(r.lessons_published === 0 ? ["lessons"] : []),
    ...(r.rubrics_published === 0 ? ["rubrics"] : []),
    ...(r.locales_checked_pct < 100 ? ["locales"] : []),
  ];
}

export function languageRoutes(app: App, ctx: BffContext): void {
  const catalog = ctx.domains.catalog;
  const diagnostics = ctx.domains.diagnostics;

  /** Тесты диагностики: required — ошибка наружу (проверка публикации), иначе null с записью в лог. */
  async function tests(auth: StaffAuth, required: boolean): Promise<DiagnosticTestRow[] | null> {
    if (required) {
      return parseDomain(ctx, DIAG, DIAGNOSTIC_TESTS, await diagnostics.get<unknown>("/admin/v1/diagnostics/tests", { actor: auth.actor })).items;
    }
    return optional("/admin/v1/diagnostics/tests", auth, (body) => DIAGNOSTIC_TESTS.parse(body, "$").items);
  }

  async function learners(auth: StaffAuth): Promise<Map<string, number> | null> {
    return optional("/admin/v1/diagnostics/pairs", auth, (body) => new Map(DIAGNOSTIC_PAIRS.parse(body, "$").items.map((i) => [i.pair_id, i.learners])));
  }

  async function optional<T>(path: string, auth: StaffAuth, parse: (body: unknown) => T): Promise<T | null> {
    try {
      const body = await diagnostics.get<unknown>(path, { actor: auth.actor, timeoutMs: ctx.config.dashboardTimeoutMs, retries: 0 });
      return parse(body);
    } catch (err) {
      const code = err instanceof BadValue ? "UPSTREAM_BAD_RESPONSE" : ((err as AppError)?.code ?? "UNKNOWN");
      ctx.log.warn({ upstream: DIAG, err_code: code }, "pair card enrichment unavailable");
      return null;
    }
  }

  /** Дополнить карточки catalog данными diagnostics (null — источник недоступен: значение catalog остаётся). */
  function enrich(cards: PairCard[], testRows: DiagnosticTestRow[] | null, counts: Map<string, number> | null): PairCard[] {
    return cards.map((c) => ({
      ...c,
      readiness: { ...c.readiness, ...(testRows ? { diagnostic_test: publishedTestOf(testRows, c.pair_id) } : {}) },
      ...(counts ? { learners: counts.get(c.pair_id) ?? 0 } : {}),
    }));
  }

  // ---------------------------------------------------------------- языки

  app.get("/admin/v1/languages", { config: requirePermission("content.read"), schema: { response: out(LANGUAGES) } }, async (req) => {
    const auth = staffOf(req);
    return shaped(ctx, auth, CATALOG, LANGUAGES, await catalog.get<unknown>("/admin/v1/languages", { actor: auth.actor }));
  });

  app.put<{ Params: { code: string }; Body: Record<string, unknown> }>(
    "/admin/v1/languages/:code",
    {
      config: { ...requirePermission("lang.manage"), ...requireStepUp() },
      schema: { response: out(LANGUAGE), params: params({ code: LANG_CODE }), body: LANGUAGE_BODY },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("PUT", `/admin/v1/languages/${encodeURIComponent(req.params.code)}`, { actor: auth.actor, body: req.body });
      return relay(ctx, auth, reply, CATALOG, LANGUAGE, res);
    },
  );

  // ---------------------------------------------------------------- языковые пары

  app.get(PAIRS, { config: requirePermission("content.read"), schema: { response: out(PAIR_CARDS) } }, async (req) => {
    const auth = staffOf(req);
    const [cards, testRows, counts] = await Promise.all([
      catalog.get<unknown>(PAIRS, { actor: auth.actor }).then((b) => parseDomain(ctx, CATALOG, PAIR_CARDS, b).items),
      tests(auth, false),
      learners(auth),
    ]);
    return { items: enrich(cards, testRows, counts) };
  });

  app.put<{ Params: { pairId: string }; Body: PairPut }>(
    `${PAIRS}/:pairId`,
    {
      config: { ...requirePermission("lang.manage"), ...requireStepUp() },
      schema: { response: out(PAIR_CARD), params: params({ pairId: PAIR_ID }), body: PAIR_BODY },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const pairId = req.params.pairId;
      let testRows: DiagnosticTestRow[] | null = null;
      if (req.body.status === "published") {
        const [cards, rows] = await Promise.all([
          catalog.get<unknown>(PAIRS, { actor: auth.actor }).then((b) => parseDomain(ctx, CATALOG, PAIR_CARDS, b).items),
          tests(auth, true),
        ]);
        testRows = rows;
        const current = cards.find((c) => c.pair_id === pairId);
        if (current?.status !== "published" && publishedTestOf(rows ?? [], pairId) === null) {
          throw new AppError(422, "PAIR_NOT_READY", "Пара не готова к публикации: нет опубликованного теста диагностики", {
            missing: [...catalogMissing(current, req.body), "diagnostic_test"],
          });
        }
      }
      const res = await catalog.call("PUT", `${PAIRS}/${pairId}`, { actor: auth.actor, body: req.body });
      passReplayed(reply, res);
      const card = parseDomain(ctx, CATALOG, PAIR_CARD, res.body);
      const [rows, counts] = await Promise.all([testRows ?? tests(auth, false), learners(auth)]);
      return reply.status(res.status).send(enrich([card], rows, counts)[0]);
    },
  );
}
