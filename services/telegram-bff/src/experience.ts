/**
 * Remote Experience Config для Mini App: кэш в памяти инстанса (по умолчанию 60 с) + stale-cache:
 * если experience-config недоступен, отдаём последнюю успешно полученную версию (ARCHITECTURE: «stale-cache для Home»).
 */
import type { ExperienceConfig } from "@tilhero/contracts/bff";
import type { DomainClient } from "./upstream.js";

export const MINIAPP_APP = "miniapp";

export class ExperienceCache {
  private value: ExperienceConfig | null = null;
  private fetchedAt = 0;
  private inflight: Promise<ExperienceConfig> | null = null;

  constructor(
    private readonly client: DomainClient,
    private readonly ttlMs: number,
    private readonly onStale?: (err: unknown) => void,
  ) {}

  async get(): Promise<ExperienceConfig> {
    if (this.value && Date.now() - this.fetchedAt < this.ttlMs) return this.value;
    this.inflight ??= this.client
      .get<ExperienceConfig>(`/internal/v1/experience/${MINIAPP_APP}/current`)
      .finally(() => {
        this.inflight = null;
      });
    try {
      const cfg = await this.inflight;
      this.value = cfg;
      this.fetchedAt = Date.now();
      return cfg;
    } catch (err) {
      if (this.value) {
        this.onStale?.(err);
        return this.value;
      }
      throw err;
    }
  }
}
