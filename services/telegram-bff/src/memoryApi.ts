/**
 * Спринт 5 — вызовы memory от имени ученика (INTERNAL_API §0, §1.10, §8).
 *
 * Субъект внутреннего JWT — как у lessons: `sub` = аккаунт, claims `lrn` (активный ученик) и `age_band`. Для memory
 * `age_band` — полоса АКТИВНОГО ученика (у детского профиля — полоса ребёнка): по ней memory выбирает задание
 * воспроизведения (6–9 — сборка вместо ввода, 10–13 — ввод) и дневные лимиты. Детский профиль memory распознаёт и сама
 * (`lrn ≠ sub`) — защита в глубину. Query: `audience` (подсказка BFF; детский профиль memory не понижает) и `locale`.
 *
 * Словарь ученика для глоссария текста (`ReadingView.glossary[].in_dictionary`) — memory `POST /internal/v1/cards/lookup`
 * пакетом (≤ 50). Это украшение: сбой, таймаут или ответ не по контракту → `in_dictionary: null`, текст показывается.
 */
import type * as C from "@tilhero/contracts/bff";
import type { AudienceSegment } from "@tilhero/contracts/content";
import { AppError } from "@tilhero/ts-common";
import { asAccount } from "./account.js";
import { expectShape } from "./check.js";
import type { BffContext } from "./context.js";
import { localeOf, type LocaleSource } from "./http.js";
import { CARDS_LOOKUP_MAX, CardsLookupDomainSchema } from "./schemas.js";
import type { AccessClaims } from "./tokens.js";
import type { RawRequest } from "./upstream.js";

export const MEMORY = "memory";

export interface MemoryCall {
  kids: boolean;
  audience: AudienceSegment;
  ro: RawRequest;
}

/** Параметры вызова memory от имени активного ученика (req — для `locale`). */
export async function memoryCall(ctx: BffContext, auth: AccessClaims, req?: LocaleSource): Promise<MemoryCall> {
  const seg = await ctx.audience.segment(ctx, auth);
  const band = await ctx.audience.learnerBand(ctx, auth);
  return {
    kids: seg.audience === "kids",
    audience: seg.audience,
    ro: {
      subject: asAccount(auth),
      claims: { lrn: auth.learnerId, ...(band ? { age_band: band } : {}) },
      query: { audience: seg.audience, ...(req ? { locale: localeOf(req) } : {}) },
    },
  };
}

/** Есть ли слова в словаре ученика: текст → card_id | null. Сбой memory — пустая карта (все null), без исключения. */
export async function lookupCards(ctx: BffContext, auth: AccessClaims, texts: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const unique = [...new Set(texts.filter((t) => t.trim() !== ""))].slice(0, CARDS_LOOKUP_MAX);
  if (unique.length === 0) return out;
  try {
    const { ro } = await memoryCall(ctx, auth);
    const res = await ctx.domains.memory.json("POST", "/internal/v1/cards/lookup", { ...ro, body: { texts: unique } });
    const r = expectShape(ctx.log, MEMORY, "cards_lookup", CardsLookupDomainSchema, res);
    const asked = new Set(unique);
    for (const i of r.items) if (asked.has(i.text)) out.set(i.text, i.card_id ? i.card_id.toLowerCase() : null);
  } catch (err) {
    // 503 и ответ не по контракту уже записаны (RawClient / expectShape); 4xx memory — здесь, без текстов
    if (err instanceof AppError && err.status < 500) {
      ctx.log.warn({ upstream: MEMORY, check: "cards_lookup", upstream_status: err.status, upstream_code: err.code }, "in_dictionary unavailable");
    }
  }
  return out;
}

/** ReadingView с in_dictionary глоссария из словаря ученика (сбой memory — null). */
export async function withInDictionary(ctx: BffContext, auth: AccessClaims, view: C.ReadingView): Promise<C.ReadingView> {
  const found = await lookupCards(ctx, auth, view.glossary.map((g) => g.en));
  return { ...view, glossary: view.glossary.map((g) => ({ ...g, in_dictionary: found.get(g.en) ?? null })) };
}
