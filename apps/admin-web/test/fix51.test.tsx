import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TravelProviderProbe, TravelProviderStatus } from "@tilhero/contracts/admin";
import { TravelApi } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { I18nProvider, translate, type Lang } from "../src/i18n";
import { en } from "../src/i18n/en";
import { ru, type MessageKey } from "../src/i18n/ru";
import { DIAG_KINDS, PROVIDER_META, TRAVEL_PROVIDERS, diagKind, diagTone, lockLeft, providerMsg } from "../src/screens/travel/travel";
import { ProbeBlock, ProviderCard, diagTitle } from "../src/screens/travel/Travel";
import { BULK_MAX, SKIP_CODES, daysLeft, pruneSelection, summarize, toggleAll, toggleOne } from "../src/screens/review/bulk";
import { REVIEW_STATUSES, REVIEW_STATUS_TONE } from "../src/screens/catalog/common";

/* Fix 5.1 (FEEDBACK_5_1 §E, §F): provider diagnosis and «Check now»; bulk review, «Not confirmed», auto-expiry. */

const tRu = (k: MessageKey, v?: Record<string, string | number>) => translate("ru", k, v);
const tEn = (k: MessageKey, v?: Record<string, string | number>) => translate("en", k, v);
const ui = (node: ReactNode, lang: Lang = "ru") => render(<I18nProvider initial={lang}>{node}</I18nProvider>);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const err = (p: Partial<NonNullable<TravelProviderStatus["last_error"]>> = {}) => ({ code: "PROVIDER_BAD_RESPONSE", reason: null, message: null, at: "2026-10-11T09:07:00Z", http_status: null, ...p });
const prov = (p: Partial<TravelProviderStatus> = {}): TravelProviderStatus => ({
  name: "aviasales",
  configured: true,
  enabled: true,
  quota: { day_used: 412, day_limit: 20000 },
  breaker: "closed",
  last_error: null,
  last_success_at: "2026-10-11T08:48:00Z",
  ...p,
});
const probe = (p: Partial<TravelProviderProbe> = {}): TravelProviderProbe => ({
  name: "aviasales",
  ok: true,
  latency_ms: 412,
  code: null,
  reason: null,
  message: null,
  http_status: 200,
  checked_at: "2026-10-11T09:30:00Z",
  ...p,
});

describe("provider diagnosis: machine reason → human text and what to do", () => {
  it("every reason of provider-gateway maps to a kind; unknown codes stay visible", () => {
    expect(diagKind("upstream_400")).toBe("rejected");
    expect(diagKind("upstream_422")).toBe("rejected");
    expect(diagKind("upstream_401")).toBe("key");
    expect(diagKind("upstream_403")).toBe("key");
    expect(diagKind("upstream_404")).toBe("not_found");
    expect(diagKind("upstream_429")).toBe("rate_limited");
    expect(diagKind("upstream_5xx")).toBe("server");
    expect(diagKind("upstream_502")).toBe("server");
    expect(diagKind("success_false")).toBe("provider_error");
    expect(diagKind("shape")).toBe("format");
    expect(diagKind("invalid_json")).toBe("format");
    expect(diagKind("too_large")).toBe("too_large");
    expect(diagKind("timeout")).toBe("timeout");
    expect(diagKind("network")).toBe("network");
    expect(diagKind("circuit_open")).toBe("circuit");
    expect(diagKind("something_new")).toBe("unknown");
    // an old gateway sends only the code
    expect(diagKind(null, "PROVIDER_QUOTA_EXHAUSTED")).toBe("quota");
    expect(diagKind(null, "PROVIDER_UNAVAILABLE")).toBeNull();
    expect(diagTone("key")).toBe("bad");
    expect(diagTone("server")).toBe("warn");
    // every reason provider-gateway writes has a human kind; an unknown one is neutral, not red
    expect(diagKind("negative_cache")).toBe("negative_cache");
    expect(diagKind("overpass_runtime_error")).toBe("overpass");
    expect(diagKind("internal")).toBe("internal");
    expect(diagKind("local")).toBe("local");
    expect(diagKind("quota_exhausted")).toBe("quota");
    expect(diagKind("disabled")).toBe("not_configured");
    expect(diagKind("upstream_overloaded")).toBe("rate_limited");
    expect(diagTone("unknown")).toBe("neutral");
    expect(diagTone("internal")).toBe("bad");
  });

  it("every kind has a title and «what to do» in RU and EN (same placeholders)", () => {
    for (const k of DIAG_KINDS) {
      for (const key of [`trv.why.${k}`, `trv.fix.${k}`]) {
        expect(key in ru, key).toBe(true);
        expect(key in en, key).toBe(true);
      }
    }
    for (const n of TRAVEL_PROVIDERS) for (const key of [`trv.name.${n}`, `trv.role.${n}`, `trv.uses.${n}`]) expect(key in ru, key).toBe(true);
    for (const n of TRAVEL_PROVIDERS) for (const v of PROVIDER_META[n].vars) expect(`trv.var.${v.name}` in ru, v.name).toBe(true);
  });

  it("titles: the customer's cases — success_false with the provider's message, 401, shape, 5xx, an old gateway", () => {
    expect(diagTitle(tRu, err({ reason: "success_false", message: "No prices for TAS-FRU" }))).toBe("Поставщик вернул ошибку: «No prices for TAS-FRU»");
    expect(diagTitle(tRu, err({ reason: "success_false" }))).toBe("Поставщик вернул ошибку");
    expect(diagTitle(tRu, err({ reason: "upstream_400" }))).toBe("Поставщик отклонил запрос");
    expect(diagTitle(tRu, err({ reason: "upstream_401" }))).toBe("Ключ неверный или отозван");
    expect(diagTitle(tRu, err({ reason: "shape" }))).toBe("Неожиданный формат ответа");
    expect(diagTitle(tRu, err({ reason: "invalid_json" }))).toBe("Неожиданный формат ответа");
    expect(diagTitle(tRu, err({ reason: "upstream_5xx" }))).toBe("Сервер поставщика временно недоступен");
    expect(diagTitle(tRu, err({ reason: "brand_new" }))).toBe("Неизвестная причина: brand_new");
    expect(diagTitle(tRu, err({ code: "PROVIDER_UNAVAILABLE" }))).toBe("Поставщик недоступен или не ответил вовремя");
    expect(diagTitle(tEn, err({ reason: "upstream_403" }))).toBe("The key is wrong or revoked");
    // the provider's own message also for upstream_4xx and LiteAPI provider_error
    expect(diagTitle(tRu, err({ reason: "upstream_400", message: "Invalid origin: TASX" }))).toBe("Поставщик отклонил запрос: «Invalid origin: TASX»");
    expect(diagTitle(tRu, err({ reason: "provider_error", message: "No availability" }))).toBe("Поставщик вернул ошибку: «No availability»");
    expect(diagTitle(tEn, err({ reason: "upstream_401", message: "API key revoked" }))).toBe("The key is wrong or revoked: «API key revoked»");
    expect(diagKind("provider_error")).toBe("provider_error");
    expect(providerMsg("  a\n b  ")).toBe("a b");
    expect(providerMsg("x".repeat(250))!.length).toBe(200);
    expect(providerMsg("")).toBeNull();
  });

  it("card: the latest error is explained with «what to do» naming the key variable; an old error (success after it) is not", () => {
    ui(<ProviderCard p={prov({ last_error: err({ code: "PROVIDER_NOT_CONFIGURED", reason: "upstream_401", http_status: 401, at: "2026-10-11T09:07:00Z" }) })} />);
    expect(screen.getByTestId("trv-why-aviasales")).toHaveTextContent("Ключ неверный или отозван");
    expect(screen.getByTestId("trv-last-error-aviasales")).toHaveTextContent("upstream_401");
    expect(screen.getByTestId("trv-last-error-aviasales")).toHaveTextContent("HTTP 401");
    const fix = screen.getByTestId("trv-fix-aviasales");
    expect(fix).toHaveTextContent("Что делать");
    expect(fix).toHaveTextContent("TRAVELPAYOUTS_TOKEN");
    expect(fix).toHaveAttribute("data-kind", "key");
    cleanup();
    ui(<ProviderCard p={prov({ last_error: err({ reason: "timeout", at: "2026-10-11T08:00:00Z" }) })} />);
    expect(screen.queryByTestId("trv-fix-aviasales")).toBeNull();
    expect(screen.getByTestId("trv-why-aviasales")).toHaveTextContent("Поставщик не ответил вовремя");
  });

  it("an unknown reason: the reason is shown as is, «what to do» in a neutral (not red) box", () => {
    ui(<ProviderCard p={prov({ last_error: err({ reason: "brand_new_reason", at: "2026-10-11T09:07:00Z" }) })} />);
    expect(screen.getByTestId("trv-why-aviasales")).toHaveTextContent("Неизвестная причина: brand_new_reason");
    expect(screen.getByTestId("trv-fix-aviasales").className).toContain("tone-neutral");
  });

  it("CBU card: own name, role, icon; a probe button only for configured and enabled providers", () => {
    ui(<ProviderCard p={prov({ name: "cbu", quota: { day_used: 3, day_limit: 500 } })} />);
    expect(screen.getByTestId("trv-cbu")).toHaveTextContent("Курсы валют ЦБ РУз");
    expect(screen.getByTestId("trv-cbu")).toHaveTextContent("Пересчёт цен билетов в USD");
    expect(screen.getByTestId("trv-probe-btn-cbu")).toHaveTextContent("Проверить сейчас");
    cleanup();
    ui(<ProviderCard p={prov({ configured: false })} />);
    expect(screen.queryByTestId("trv-probe-btn-aviasales")).toBeNull();
    cleanup();
    ui(<ProviderCard p={prov({ enabled: false })} />);
    expect(screen.queryByTestId("trv-probe-aviasales")).toBeNull();
  });
});

describe("«Check now»", () => {
  it("success: latency and time; the card is re-read; the button is locked for 30 s with a countdown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.spyOn(TravelApi, "probe").mockResolvedValue(probe());
    const onProbed = vi.fn();
    ui(<ProbeBlock name="aviasales" onProbed={onProbed} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("trv-probe-btn-aviasales"));
    });
    expect(spy).toHaveBeenCalledWith("aviasales");
    expect(onProbed).toHaveBeenCalledTimes(1);
    const res = screen.getByTestId("trv-probe-res-aviasales");
    expect(res).toHaveTextContent("Поставщик отвечает");
    expect(res).toHaveTextContent("412 мс");
    const btn = screen.getByTestId("trv-probe-btn-aviasales");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/Повторить через (30|29) с/);
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    expect(screen.getByTestId("trv-probe-btn-aviasales")).not.toBeDisabled();
    expect(screen.getByTestId("trv-probe-btn-aviasales")).toHaveTextContent("Проверить сейчас");
  });

  it("failure: the reason explained with «what to do» and the codes", async () => {
    vi.spyOn(TravelApi, "probe").mockResolvedValue(probe({ ok: false, code: "PROVIDER_BAD_RESPONSE", reason: "success_false", message: "Invalid token", http_status: 200 }));
    const onResult = vi.fn();
    ui(<ProbeBlock name="aviasales" onResult={onResult} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("trv-probe-btn-aviasales"));
    });
    expect(screen.getByTestId("trv-probe-res-aviasales")).toHaveTextContent("Проверка не прошла");
    const fix = screen.getByTestId("trv-probe-fix-aviasales");
    expect(fix).toHaveTextContent("Поставщик вернул ошибку: «Invalid token»");
    expect(fix).toHaveTextContent("Что делать");
    expect(screen.getByTestId("trv-probe-aviasales")).toHaveTextContent("success_false");
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it("429: locked for retry_after with a live countdown; 503 PROBE_UNAVAILABLE — a clear text", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(TravelApi, "probe").mockRejectedValueOnce(new ApiError(429, { code: "PROBE_RATE_LIMITED", message: "", trace_id: "t", details: { retry_after: 17 } }));
    ui(<ProbeBlock name="liteapi" />, "en");
    await act(async () => {
      fireEvent.click(screen.getByTestId("trv-probe-btn-liteapi"));
    });
    expect(screen.getByTestId("trv-probe-res-liteapi")).toHaveTextContent(/retry in 1[67] s/);
    expect(screen.getByTestId("trv-probe-btn-liteapi")).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(18_000);
    });
    expect(screen.getByTestId("trv-probe-btn-liteapi")).not.toBeDisabled();
    vi.spyOn(TravelApi, "probe").mockRejectedValueOnce(new ApiError(503, { code: "PROBE_UNAVAILABLE", message: "", trace_id: "t", details: { service: "provider-gateway" } }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("trv-probe-btn-liteapi"));
    });
    expect(screen.getByTestId("trv-probe-err-liteapi")).toHaveTextContent("provider-gateway needs the version with fix 5.1");
  });

  it("lockLeft: seconds left, rounded up; 0 when unlocked", () => {
    expect(lockLeft(null, 0)).toBe(0);
    expect(lockLeft(10_500, 0)).toBe(11);
    expect(lockLeft(1_000, 2_000)).toBe(0);
  });
});

describe("event review: «Not confirmed», selection, bulk outcome", () => {
  const NOW = Date.parse("2026-10-11T12:00:00Z");
  const row = (id: string, hash = "h".repeat(64)) => ({ review_id: id, content_hash: hash });

  it("EXPIRED is a filter option right after OPEN with its own label", () => {
    expect(REVIEW_STATUSES.slice(0, 2)).toEqual(["OPEN", "EXPIRED"]);
    expect(REVIEW_STATUS_TONE.EXPIRED).toBe("outline");
    expect(tRu("rv.st.EXPIRED")).toBe("Не подтверждено");
    expect(tEn("rv.st.EXPIRED")).toBe("Not confirmed");
  });

  it("days before auto-removal: nearest whole day, at least 1; < 1 day → 0; no or broken expires_at → null", () => {
    expect(daysLeft("2026-10-14T12:00:00Z", NOW)).toBe(3);
    expect(daysLeft("2026-10-14T09:00:00Z", NOW)).toBe(3); // 2.875 days → «in 3 days»
    expect(daysLeft("2026-10-17T14:00:00Z", NOW)).toBe(6); // 6 d 2 h → «in 6 days», not 7
    expect(daysLeft("2026-10-12T13:00:00Z", NOW)).toBe(1);
    expect(daysLeft("2026-10-12T11:00:00Z", NOW)).toBe(0);
    expect(daysLeft("2026-10-10T00:00:00Z", NOW)).toBe(0); // overdue: the hourly job has not run yet
    expect(daysLeft(null, NOW)).toBeNull();
    expect(daysLeft("soon", NOW)).toBeNull();
  });

  it("row texts in RU and EN (plurals)", () => {
    const tp = (lang: Lang, k: MessageKey, n: number) => {
      const forms = translate(lang, k).split("|");
      const i = lang === "en" ? (n === 1 ? 0 : 1) : n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2;
      return forms[i]!.replace("{n}", String(n));
    };
    expect(tp("ru", "rv.expiredRow", 7)).toBe("Не подтверждено автоматически: 7 дней без решения");
    expect(tp("ru", "rv.expiresIn", 3)).toBe("Снимется через 3 дн.");
    expect(tp("en", "rv.expiresIn", 1)).toBe("Auto-removal in 1 day");
    expect(tRu("rv.res.rejectSum", { done: 3, skipped: 1 })).toBe("Отклонено 3, пропущено 1");
  });

  it("select all on the page / one row / prune after a reload", () => {
    const rows = [row("a"), row("b")];
    let sel = toggleAll(new Map(), rows);
    expect([...sel.keys()]).toEqual(["a", "b"]);
    expect(toggleAll(sel, rows).size).toBe(0);
    sel = toggleOne(sel, row("a"));
    expect([...sel.keys()]).toEqual(["b"]);
    expect(toggleAll(sel, rows).size).toBe(2); // partly selected → all
    expect([...pruneSelection(new Map([["a", "x"], ["gone", "y"]]), rows).keys()]).toEqual(["a"]);
    expect(toggleAll(new Map(), []).size).toBe(0);
    expect(BULK_MAX).toBe(100);
  });

  it("outcome: done / skipped grouped by reason, most frequent first; every skip code has a text", () => {
    const s = summarize({
      results: [
        { review_id: "a", status: "REJECTED", code: null },
        { review_id: "b", status: "SKIPPED", code: "REVIEW_ALREADY_DECIDED" },
        { review_id: "c", status: "SKIPPED", code: "REVIEW_CHANGED" },
        { review_id: "d", status: "SKIPPED", code: "REVIEW_CHANGED" },
      ],
    });
    expect(s).toEqual({ done: 1, skipped: 3, byCode: [{ code: "REVIEW_CHANGED", ids: ["c", "d"] }, { code: "REVIEW_ALREADY_DECIDED", ids: ["b"] }] });
    for (const c of SKIP_CODES) expect(`rv.skip.${c}` in ru && `rv.skip.${c}` in en, c).toBe(true);
  });
});
