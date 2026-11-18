import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Permission, Source, SourceJsonApiPreview } from "@tilhero/contracts/admin";
import { SourcesApi } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { I18nProvider, type Lang } from "../src/i18n";
import { ru } from "../src/i18n/ru";
import { en } from "../src/i18n/en";
import { SessionCtx, type Session } from "../src/state/session";
import { ToastProvider } from "../src/ui/toasts";
import { crawlCodeHint, crawlCodeLabel, skipReasonLabel, crawlNoteLabel } from "../src/screens/catalog/common";
import { JsonApiEditor } from "../src/screens/sources/JsonApi";
import { emptyForm, formFromSource, inputFromForm, jsonApiProblem, jsonApiTemplate, parseJsonApi, patchFromForm, validateSource } from "../src/screens/sources/validate";

/* Fix 9.3: «JSON API» listing page — mapping editor, client checks, «Check» preview. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const EXAMPLE = readFileSync(resolve(__dirname, "../../../docs/sprint9/json_api_auezov.json"), "utf8");
const DOMAINS = ["auezov-theatre.kz", "ticketon.kz"];

const session = (perms: Permission[]): Session => {
  const set = new Set(perms);
  return { me: null, can: (p) => set.has(p), canAny: (ps) => ps.some((p) => set.has(p)), refreshMe: async () => null, setMe: () => undefined, signOut: async () => undefined, reloadTheme: async () => undefined, themeVersion: null, adminLayout: null };
};
const ui = (node: ReactNode, perms: Permission[] = ["sources.manage"], lang: Lang = "ru") =>
  render(
    <I18nProvider initial={lang}>
      <SessionCtx.Provider value={session(perms)}>
        <ToastProvider>{node}</ToastProvider>
      </SessionCtx.Provider>
    </I18nProvider>,
  );

function Harness({ initial = "", perms }: { initial?: string; perms?: Permission[] }) {
  const [v, setV] = useState(initial);
  return (
    <JsonApiEditor
      idx={0}
      value={v}
      onChange={setV}
      error={null}
      ctx={{ country: "KZ", eventDomains: DOMAINS, mediaDomains: ["auezov-theatre.kz"], city: "Almaty", category: "culture.theatre" }}
      readOnly={perms ? !perms.includes("sources.manage") : false}
    />
  );
}

const preview = (p: Partial<SourceJsonApiPreview> = {}): SourceJsonApiPreview => ({
  ok: true,
  code: null,
  reason: null,
  request_url: "https://server.auezov-theatre.kz/performances/?is_active=true&page=1",
  items_path: "data.items",
  items_total: 12,
  events: [
    {
      id: "101",
      title: "Абай",
      local_date: "2026-11-05",
      local_time: "18:00",
      timezone: "Asia/Almaty",
      utc: "2026-11-05T13:00:00Z",
      end_local_date: null,
      end_local_time: null,
      venue: "Театр им. М. Ауэзова — Большой зал",
      city: "Almaty",
      url: "https://auezov-theatre.kz/ru/afisha/performance/101",
      image: "https://server.auezov-theatre.kz/media/cover-101.jpg",
      price: null,
      category: "culture.theatre",
      age: "12+",
      status: "active",
      description: "Драма",
    },
  ],
  rejected: [{ index: 2, id: "103", reason: "status_excluded" }],
  keys: [
    { path: "id", sample: "101" },
    { path: "title.ru", sample: "Абай" },
    { path: "media_items.0.url", sample: "/media/cover-101.jpg" },
  ],
  keys_scope: "item",
  skipped: { status_excluded: 1 },
  checked_at: "2026-10-18T10:00:00Z",
  ...p,
});

const page = { url: "https://auezov-theatre.kz/ru/afisha", city: "Almaty", category: "culture.theatre", kind: "json_api" as const, priority: "normal" as const };
const source = (p: Partial<Source> = {}): Source => ({
  source_id: "s-1",
  slug: "auezov-theatre-kz",
  name: "Театр Ауэзова",
  country_code: "KZ",
  tier: "OFFICIAL_ORGANIZER",
  event_domains: DOMAINS,
  media_domains: ["auezov-theatre.kz"],
  listing_pages: [{ ...page, json_api: JSON.parse(EXAMPLE) }],
  enabled: false,
  js_only: true,
  notes: null,
  version: 4,
  created_at: "2026-10-18T00:00:00Z",
  updated_at: "2026-10-18T00:00:00Z",
  updated_by: null,
  updated_by_name: null,
  ...p,
});

describe("mapping checks (same rules as source-registry where the operator needs them)", () => {
  it("the Auezov example from docs passes; the template passes for the first event domain", () => {
    expect(jsonApiProblem(EXAMPLE, DOMAINS, ["auezov-theatre.kz"])).toBeNull();
    expect(jsonApiProblem(jsonApiTemplate("auezov-theatre.kz"), DOMAINS)).toBeNull();
    expect(parseJsonApi(jsonApiTemplate("x.kz"))?.url).toBe("https://x.kz/api/events/");
  });

  it("names the first problem", () => {
    const m = JSON.parse(EXAMPLE);
    const txt = (o: unknown) => JSON.stringify(o);
    expect(jsonApiProblem("", DOMAINS)).toBe("apiEmpty");
    expect(jsonApiProblem("{url:", DOMAINS)).toBe("apiJson");
    expect(jsonApiProblem("[1]", DOMAINS)).toBe("apiJson");
    expect(jsonApiProblem(txt({ ...m, script: "1" }), DOMAINS)).toBe("apiKeys");
    expect(jsonApiProblem(txt({ ...m, fields: { id: "id", title: "title" } }), DOMAINS)).toBe("apiFields");
    expect(jsonApiProblem(txt({ ...m, fields: { ...m.fields, venue: "venue[0]" } }), DOMAINS)).toBe("apiPath");
    expect(jsonApiProblem(txt({ ...m, items_path: [] }), DOMAINS)).toBe("apiItems");
    expect(jsonApiProblem(txt({ ...m, url: "http://server.auezov-theatre.kz/p" }), DOMAINS)).toBe("apiUrl");
    expect(jsonApiProblem(txt({ ...m, url_template: "https://auezov-theatre.kz/p" }), DOMAINS)).toBe("apiUrl");
    expect(jsonApiProblem(txt({ ...m, url: "https://api.evil.example/p" }), DOMAINS)).toBe("apiDomain");
    expect(jsonApiProblem(txt({ ...m, image_base: "https://cdn.evil.example" }), DOMAINS, ["auezov-theatre.kz"])).toBe("apiDomain");
    expect(jsonApiProblem(txt({ ...m, max_pages: 9 }), DOMAINS)).toBe("apiPages");
    // картинки — только медиа-домены (как обход и verification): домен событий при своих медиа-доменах — нет
    expect(jsonApiProblem(txt({ ...m, image_base: "https://auezov-theatre.kz" }), DOMAINS, ["cdn.auezov-media.kz"])).toBe("apiDomain");
    expect(jsonApiProblem(txt({ ...m, image_base: "https://cdn.auezov-media.kz" }), DOMAINS, ["cdn.auezov-media.kz"])).toBeNull();
    expect(jsonApiProblem(txt({ ...m, page_param: null }), DOMAINS)).toBe("apiPages");
  });

  it("form: category is required, mapping errors go under the editor; html pages are unchanged", () => {
    const f = { ...emptyForm(), name: "Театр", country_code: "KZ", event_domains: DOMAINS, reason: "JSON API", listing_pages: [{ ...page, category: "", json: "{" }] };
    const e = validateSource(f, false);
    expect(e["page.0"]).toBe("apiCategory");
    expect(e["api.0"]).toBe("apiJson");
    const ok = validateSource({ ...f, listing_pages: [{ ...page, json: EXAMPLE }] }, false);
    expect(ok).toEqual({});
    const html = inputFromForm({ ...f, listing_pages: [{ ...page, kind: "html", json: EXAMPLE }] }).listing_pages[0]!;
    expect("json_api" in html).toBe(false);
  });

  it("the mapping round-trips: reformatting the JSON text is not a change, a value is", () => {
    const s = source();
    const f = formFromSource(s);
    expect(f.listing_pages[0]!.json).toContain('"url_template"');
    const compact = { ...f, listing_pages: [{ ...f.listing_pages[0]!, json: JSON.stringify(JSON.parse(f.listing_pages[0]!.json!)) }] };
    expect(patchFromForm(s, compact).changed).toEqual([]);
    const edited = { ...f, listing_pages: [{ ...f.listing_pages[0]!, json: JSON.stringify({ ...JSON.parse(EXAMPLE), max_pages: 1 }) }] };
    const patch = patchFromForm(s, edited);
    expect(patch.changed).toEqual(["listing_pages"]);
    expect(patch.stepUp).toBe(false);
    expect((patch.body.listing_pages as Array<{ json_api: { max_pages: number } }>)[0]!.json_api.max_pages).toBe(1);
  });
});

describe("JsonApiEditor", () => {
  it("empty: template button fills the editor; «Check» disabled until it is a JSON object", () => {
    ui(<Harness />);
    expect(screen.getByTestId("sf-api-check-0")).toBeDisabled();
    fireEvent.click(screen.getByTestId("sf-api-tpl-0"));
    const area = screen.getByTestId("sf-api-json-0") as HTMLTextAreaElement;
    expect(JSON.parse(area.value).url).toBe("https://auezov-theatre.kz/api/events/");
    expect(screen.queryByTestId("sf-api-tpl-0")).toBeNull();
    expect(screen.getByTestId("sf-api-check-0")).not.toBeDisabled();
  });

  it("«Check» sends the unsaved form and shows events, reasons and keys", async () => {
    const spy = vi.spyOn(SourcesApi, "previewJsonApi").mockResolvedValue(preview());
    ui(<Harness initial={EXAMPLE} />);
    fireEvent.click(screen.getByTestId("sf-api-check-0"));
    const res = await screen.findByTestId("sf-api-res-0");
    expect(spy).toHaveBeenCalledWith({
      country_code: "KZ",
      event_domains: DOMAINS,
      media_domains: ["auezov-theatre.kz"],
      city: "Almaty",
      category: "culture.theatre",
      json_api: JSON.parse(EXAMPLE),
    });
    expect(res).toHaveAttribute("data-ok", "true");
    // в живой области — только итоговая строка, таблица и ключи — вне её
    const live = screen.getByTestId("sf-api-live-0");
    expect(within(live).getByText(/Найдено 12 элементов/)).toBeInTheDocument();
    expect(live).toHaveAttribute("role", "status");
    expect(live).not.toContainElement(res);
    const table = screen.getByTestId("sf-api-events-0");
    expect(within(table).getByText("Абай")).toBeInTheDocument();
    expect(within(table).getByText("05.11.2026 18:00")).toBeInTheDocument();
    expect(within(table).getByText("Asia/Almaty")).toBeInTheDocument();
    expect(within(table).getByText("Театр им. М. Ауэзова — Большой зал")).toBeInTheDocument();
    const link = within(table).getByRole("link");
    expect(link).toHaveAttribute("href", "https://auezov-theatre.kz/ru/afisha/performance/101");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(within(screen.getByTestId("sf-api-skips-0")).getByText(/Отменено \(статус в API\)/)).toBeInTheDocument();
    expect(within(screen.getByTestId("sf-api-keys-0")).getByText("media_items.0.url")).toBeInTheDocument();
    // не принятые элементы: номер, id, причина; результат — в области role=status
    expect(screen.getByTestId("sf-api-rejected-0")).toHaveTextContent("Элемент №3 id 103: Отменено (статус в API)");
    // карточки для узкого экрана — те же события
    expect(within(screen.getByTestId("sf-api-cards-0")).getByText("Абай")).toBeInTheDocument();
  });

  it("saved source: its id goes with the check (admin-bff takes the saved domains)", async () => {
    const spy = vi.spyOn(SourcesApi, "previewJsonApi").mockResolvedValue(preview());
    function WithId() {
      const [v, setV] = useState(EXAMPLE);
      return <JsonApiEditor idx={0} value={v} onChange={setV} error={null} readOnly={false}
        ctx={{ sourceId: "s-1", country: "KZ", eventDomains: DOMAINS, mediaDomains: [], city: "", category: "" }} />;
    }
    ui(<WithId />);
    fireEvent.click(screen.getByTestId("sf-api-check-0"));
    await screen.findByTestId("sf-api-res-0");
    expect(spy.mock.calls[0]![0]).toMatchObject({ source_id: "s-1", city: null, category: null });
  });

  it("schema mismatch: the code in words, a hint and the response keys", async () => {
    vi.spyOn(SourcesApi, "previewJsonApi").mockResolvedValue(
      preview({ ok: false, code: "SOURCE_SCHEMA_MISMATCH", reason: "items_path", events: [], rejected: [], skipped: {}, keys_scope: "response", keys: [{ path: "results.0.id", sample: "1" }] }),
    );
    ui(<Harness initial={EXAMPLE} />);
    fireEvent.click(screen.getByTestId("sf-api-check-0"));
    const code = await screen.findByTestId("sf-api-code-0");
    expect(screen.getByTestId("sf-api-live-0")).toContainElement(code);
    expect(code).toHaveTextContent("Ответ API не совпал с маппингом");
    expect(code).toHaveTextContent("SOURCE_SCHEMA_MISMATCH · items_path");
    expect(screen.getByText("Ключи ответа: по items_path массив событий не найден")).toBeInTheDocument();
    expect(screen.getByText("results.0.id")).toBeInTheDocument();
  });

  it("errors of the call: 429 with the countdown, 422 of the domain", async () => {
    const spy = vi.spyOn(SourcesApi, "previewJsonApi").mockRejectedValueOnce(new ApiError(429, { code: "PREVIEW_RATE_LIMITED", message: "slow", details: { retry_after: 4 } }));
    ui(<Harness initial={EXAMPLE} />);
    fireEvent.click(screen.getByTestId("sf-api-check-0"));
    expect(await screen.findByTestId("sf-api-err-0")).toHaveTextContent("Проверять можно раз в 5 секунд");
    spy.mockRejectedValueOnce(new ApiError(422, { code: "SOURCE_JSON_API_INVALID", message: "domain", details: { reason: "domain" } }));
    fireEvent.click(screen.getByTestId("sf-api-check-0"));
    await waitFor(() => expect(screen.getByTestId("sf-api-err-0")).toHaveTextContent("Маппинг JSON API не прошёл проверку"));
  });

  it("without sources.manage «Check» is locked and nothing is sent", () => {
    const spy = vi.spyOn(SourcesApi, "previewJsonApi");
    ui(<Harness initial={EXAMPLE} perms={[]} />, []);
    fireEvent.click(screen.getByTestId("sf-api-check-0"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("EN texts", async () => {
    vi.spyOn(SourcesApi, "previewJsonApi").mockResolvedValue(preview());
    ui(<Harness initial={EXAMPLE} />, ["sources.manage"], "en");
    expect(screen.getByText("JSON API field mapping")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Check/ }));
    expect(await screen.findByText(/12 items found/)).toBeInTheDocument();
  });
});

describe("crawl vocabulary of JSON API pages", () => {
  it("codes, reasons and notes have labels in RU and EN", () => {
    const t = (k: keyof typeof ru) => ru[k];
    const te = (k: keyof typeof en) => en[k];
    expect(crawlCodeLabel(t, "SOURCE_SCHEMA_MISMATCH")).toBe("Ответ API не совпал с маппингом");
    expect(crawlCodeHint(te, "SOURCE_NOT_JSON")).toContain("JSON");
    expect(skipReasonLabel(t, "id_missing")).toBe("Нет id в данных API");
    expect(crawlNoteLabel(te, "items_truncated")).toContain("200");
  });
});
