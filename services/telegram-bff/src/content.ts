/**
 * Спринт 3: сегмент ученика для контента и кеши catalog в памяти BFF.
 *
 * Сегмент (kids / teens / adults) — по возрасту АКТИВНОГО ученика (lrn), как для «Что нового» (account.ts ageSegment):
 * детский профиль (lrn ≠ sub) — всегда kids («липкий» детский, без запроса к identity); возраст аккаунта не выбран —
 * kids (самый строгий набор, INTERNAL_API §3). Передаётся в catalog (`audience` сценариев и медиа), diagnostics (тест
 * детский/взрослый) и learning-plan (траектория). Кеш — AUDIENCE_CACHE_SECONDS, сбрасывается при выборе возраста.
 *
 * Кеши catalog:
 *  - языковые пары — PAIRS_CACHE_SECONDS; catalog недоступен — последний полученный список;
 *  - снимок курса (только навыки: названия для карты навыков) — по ETag: If-None-Match не чаще раза в
 *    COURSE_SNAPSHOT_REVALIDATE_SECONDS, 304 → тот же снимок; catalog недоступен — последний снимок;
 *  - аудио медиатеки — байты по asset_id (LRU, AUDIO_CACHE_MB); КАЖДЫЙ запрос ученика перепроверяется в catalog
 *    (If-None-Match): права, срок и аудитория проверяются всегда, байты не гоняются повторно.
 */
import type { AgeBand } from "@tilhero/contracts/bff";
import type { AudienceSegment } from "@tilhero/contracts/content";
import type { Static } from "@fastify/type-provider-typebox";
import type { FastifyBaseLogger } from "fastify";
import { AppError } from "@tilhero/ts-common";
import { ageSegment, learnerAgeBand, loadMe } from "./account.js";
import { expectShape, matches } from "./check.js";
import type { BffContext } from "./context.js";
import { CourseSnapshotSkillsSchema, LanguagePairDomainSchema } from "./schemas.js";
import type { AccessClaims } from "./tokens.js";
import { upstreamUnavailable, type DomainClient, type RawClient } from "./upstream.js";

const enc = encodeURIComponent;

/** Сегмент контента по возрасту ученика: возраст не выбран → kids (строже всего). */
export function contentAudience(band: AgeBand | null): AudienceSegment {
  return band === null ? "kids" : ageSegment(band);
}

export interface LearnerSegment {
  audience: AudienceSegment;
  /** возраст аккаунта (claim `age_band` для catalog); детский профиль — null (детский режим catalog и так включает lrn ≠ sub) */
  accountAgeBand: AgeBand | null;
}

export class AudienceResolver {
  private readonly cache = new Map<string, { seg: LearnerSegment; at: number }>();
  private readonly bands = new Map<string, { band: AgeBand | null; at: number }>();
  constructor(private readonly ttlMs: number) {}

  /** Сегмент активного ученика сессии. */
  async of(ctx: BffContext, auth: AccessClaims): Promise<AudienceSegment> {
    return (await this.segment(ctx, auth)).audience;
  }

  /** Сегмент и возраст аккаунта (для claims внутреннего JWT к catalog). */
  async segment(ctx: BffContext, auth: AccessClaims): Promise<LearnerSegment> {
    if (auth.learnerId !== auth.accountId) return { audience: "kids", accountAgeBand: null };
    const hit = this.cache.get(auth.accountId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.seg;
    const me = await loadMe(ctx, auth.accountId);
    const seg = { audience: contentAudience(learnerAgeBand(me, auth.learnerId)), accountAgeBand: me.user.age_band ?? null };
    if (this.ttlMs > 0) {
      if (this.cache.size > 10_000) this.cache.clear();
      this.cache.set(auth.accountId, { seg, at: Date.now() });
    }
    return seg;
  }

  /** Возрастная полоса АКТИВНОГО ученика (спринт 5, claim `age_band` для memory: 6–9 — сборка вместо ввода, 10–13 —
   *  ввод): аккаунт — его возраст; детский профиль — полоса ребёнка из identity-consent (кеш AUDIENCE_CACHE_SECONDS);
   *  ребёнок не найден — null (memory ведёт себя как с 6–9: строже). */
  async learnerBand(ctx: BffContext, auth: AccessClaims): Promise<AgeBand | null> {
    const seg = await this.segment(ctx, auth);
    if (auth.learnerId === auth.accountId) return seg.accountAgeBand;
    const hit = this.bands.get(auth.learnerId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.band;
    const band = learnerAgeBand(await loadMe(ctx, auth.accountId), auth.learnerId);
    if (this.ttlMs > 0) {
      if (this.bands.size > 10_000) this.bands.clear();
      this.bands.set(auth.learnerId, { band, at: Date.now() });
    }
    return band;
  }

  /** Возраст аккаунта изменился (PUT /v1/profile/age). */
  forget(accountId: string): void {
    this.cache.delete(accountId);
  }
}

export type PairRow = Static<typeof LanguagePairDomainSchema>;

export class PairsCache {
  private value: { items: PairRow[]; at: number } | null = null;
  private inflight: Promise<PairRow[]> | null = null;
  constructor(
    private readonly catalog: DomainClient,
    private readonly ttlMs: number,
    private readonly log: FastifyBaseLogger,
  ) {}

  async get(): Promise<PairRow[]> {
    if (this.value && Date.now() - this.value.at < this.ttlMs) return this.value.items;
    this.inflight ??= this.load().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async load(): Promise<PairRow[]> {
    try {
      const res = await this.catalog.get<{ items?: unknown }>("/internal/v1/pairs");
      if (!res || !Array.isArray(res.items)) {
        this.log.warn({ upstream: "catalog", check: "pairs", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "domain response does not match the contract");
        throw upstreamUnavailable("catalog");
      }
      const items = res.items.filter((p): p is PairRow => matches(LanguagePairDomainSchema, p));
      if (items.length < res.items.length) this.log.warn({ upstream: "catalog", check: "pairs", dropped: res.items.length - items.length }, "language pairs dropped");
      this.value = { items, at: Date.now() };
      return items;
    } catch (err) {
      // справочник меняется редко: при сбое catalog — последний полученный список
      if (this.value && err instanceof AppError && err.status >= 500) return this.value.items;
      throw err;
    }
  }
}

export type SnapshotSkills = Static<typeof CourseSnapshotSkillsSchema>;
type SkillMeta = SnapshotSkills["skills"][number];

/** Верхняя граница размера снимка курса (JSON): защита памяти BFF. */
const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

export class SnapshotCache {
  private readonly entries = new Map<string, { etag: string | null; skills: Map<string, SkillMeta>; at: number }>();
  private readonly inflight = new Map<string, Promise<Map<string, SkillMeta> | null>>();
  constructor(
    private readonly raw: RawClient,
    private readonly revalidateMs: number,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Навыки опубликованного курса по skill_id; null — снимка нет (catalog недоступен и кеша нет). */
  async skills(courseId: string): Promise<Map<string, SkillMeta> | null> {
    const e = this.entries.get(courseId);
    if (e && Date.now() - e.at < this.revalidateMs) return e.skills;
    let p = this.inflight.get(courseId);
    if (!p) {
      p = this.load(courseId).finally(() => this.inflight.delete(courseId));
      this.inflight.set(courseId, p);
    }
    return p;
  }

  private async load(courseId: string): Promise<Map<string, SkillMeta> | null> {
    const e = this.entries.get(courseId);
    try {
      const resp = await this.raw.get(`/internal/v1/courses/${enc(courseId)}/snapshot`, { headers: e?.etag ? { "if-none-match": e.etag } : {} });
      if (resp.status === 304 && e) {
        e.at = Date.now();
        return e.skills;
      }
      if (resp.status !== 200) throw new Error(`status ${resp.status}`);
      const text = await resp.text();
      if (text.length > SNAPSHOT_MAX_BYTES) throw new Error("snapshot too large");
      const body = expectShape(this.log, "catalog", "course_snapshot", CourseSnapshotSkillsSchema, JSON.parse(text));
      const skills = new Map(body.skills.map((s) => [s.skill_id, s]));
      this.entries.set(courseId, { etag: resp.headers.get("etag"), skills, at: Date.now() });
      return skills;
    } catch (err) {
      if (!(err instanceof AppError)) {
        this.log.warn({ upstream: "catalog", check: "course_snapshot", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "course snapshot unavailable");
      }
      // 404 COURSE_NOT_FOUND — курса нет: прежний снимок не отдаём
      if (err instanceof AppError && err.status === 404) {
        this.entries.delete(courseId);
        return null;
      }
      return e?.skills ?? null;
    }
  }
}

export interface AudioEntry {
  etag: string;
  contentType: string;
  bytes: Buffer;
}

/** LRU байтов аудио по asset_id; ёмкость — сумма размеров. */
export class AudioCache {
  private readonly map = new Map<string, AudioEntry>();
  private size = 0;
  constructor(private readonly capacity: number) {}

  get(id: string): AudioEntry | undefined {
    const e = this.map.get(id);
    if (e) {
      this.map.delete(id);
      this.map.set(id, e);
    }
    return e;
  }

  set(id: string, e: AudioEntry): void {
    this.delete(id);
    if (e.bytes.length > this.capacity) return;
    this.map.set(id, e);
    this.size += e.bytes.length;
    while (this.size > this.capacity) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(id: string): void {
    const e = this.map.get(id);
    if (!e) return;
    this.map.delete(id);
    this.size -= e.bytes.length;
  }

  get bytes(): number {
    return this.size;
  }
}
