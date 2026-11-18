import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Source } from "@tilhero/contracts/admin";
import { expectNoHScroll, openAs, setTheme, shot } from "./helpers";

/* Исправление 9.3: страница афиши «JSON API» (театр Ауэзова) — тип страницы, редактор маппинга, «Проверить» с таблицей
 * предпросмотра и ключами, сохранение маппинга. Скриншоты — e2e/shots/fix93-*. */

const ID = "5c000000-0000-4000-8000-000000000093";
const EXAMPLE = readFileSync(new URL("../../../docs/sprint9/json_api_auezov.json", import.meta.url), "utf8");

function auezov(base: Source): Source {
  return {
    ...base,
    source_id: ID,
    slug: "auezov-theatre-kz",
    name: "Казахский национальный театр драмы им. М. Ауэзова",
    country_code: "KZ",
    tier: "OFFICIAL_ORGANIZER",
    event_domains: ["auezov-theatre.kz"],
    media_domains: ["auezov-theatre.kz"],
    listing_pages: [{ url: "https://auezov-theatre.kz/ru/afisha/2025-11", city: "Almaty", category: "culture.theatre", kind: "html", priority: "normal" }],
    enabled: false,
    disabled_reason: null,
    js_only: true,
    notes: "SPA: события — через JSON API",
    version: 1,
  };
}

test("JSON API page: paste the mapping, check it, save", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/sources");
  bff.sources.push(auezov(bff.sources[0]!));
  await page.reload();
  await page.locator('[data-source="auezov-theatre-kz"]').click();
  await page.getByTestId("sf-page-kind-0").selectOption("json_api");
  await page.getByTestId("sf-page-url-0").fill("https://auezov-theatre.kz/ru/afisha");
  await expect(page.getByTestId("sf-api-0")).toBeVisible();
  await expect(page.getByTestId("sf-page-hint-0")).toHaveText("Страница афиши на сайте — для справки; события загружаются по адресу API из маппинга");

  // пустой маппинг — ошибка у редактора, PATCH не уходит
  await page.getByTestId("sf-reason").fill("Театр Ауэзова: JSON API вместо SPA");
  await page.getByTestId("sf-submit").click();
  await expect(page.getByTestId("sf-api-0")).toContainText("Вставьте маппинг полей");
  expect(bff.calls("PATCH", `/sources/${ID}`)).toHaveLength(0);

  // неверный путь к массиву — «Проверить» показывает ключи ответа
  await page.getByTestId("sf-api-json-0").fill(JSON.stringify({ ...JSON.parse(EXAMPLE), items_path: ["results"] }, null, 2));
  await page.getByTestId("sf-api-check-0").click();
  await expect(page.getByTestId("sf-api-code-0")).toContainText("Ответ API не совпал с маппингом");
  await expect(page.getByTestId("sf-api-keys-0")).toContainText("data.items.0.id");

  // пример из документации — таблица предпросмотра
  await page.getByTestId("sf-api-json-0").fill(EXAMPLE);
  await page.getByTestId("sf-api-check-0").click();
  const table = page.getByTestId("sf-api-events-0");
  await expect(table).toContainText("Абай");
  await expect(table).toContainText("05.11.2026 18:00");
  await expect(table).toContainText("Театр им. М. Ауэзова — Большой зал");
  await expect(page.getByTestId("sf-api-live-0")).toContainText("Найдено 12 элементов");
  await expect(page.getByTestId("sf-api-rejected-0")).toContainText("Элемент №3 id 103");
  await expect(page.getByTestId("sf-api-cards-0")).toBeHidden(); // широкий экран — таблица
  const call = bff.calls("POST", "/sources/json-api/preview").at(-1)!.body as { json_api: unknown; event_domains: string[]; category: string; source_id: string };
  expect(call.source_id).toBe(ID);
  expect(call.json_api).toEqual(JSON.parse(EXAMPLE));
  expect(call.event_domains).toEqual(["auezov-theatre.kz"]);
  expect(call.category).toBe("culture.theatre");
  await page.getByTestId("sf-api-res-0").scrollIntoViewIfNeeded();
  await expectNoHScroll(page);
  await shot(page, "fix93-source-json-api-light");

  await page.getByTestId("sf-submit").click();
  await expect(page.getByTestId("toasts")).toContainText("версия 2");
  const patch = bff.calls("PATCH", `/sources/${ID}`).at(-1)!.body as { listing_pages: Array<Record<string, unknown>>; reason: string };
  expect(patch.listing_pages).toEqual([{ url: "https://auezov-theatre.kz/ru/afisha", city: "Almaty", category: "culture.theatre", kind: "json_api", priority: "normal", json_api: JSON.parse(EXAMPLE) }]);
  await expect(page.locator('[data-source="auezov-theatre-kz"]').getByTestId("src-api-tag")).toHaveText("JSON API");

  // тёмная тема: сохранённый маппинг в карточке, «Проверить» ещё раз
  await page.getByTestId("drawer-close").click();
  await setTheme(page, "dark");
  await page.locator('[data-source="auezov-theatre-kz"]').click();
  await expect(page.getByTestId("sf-page-kind-0")).toHaveValue("json_api");
  await page.getByTestId("sf-api-check-0").click();
  await expect(page.getByTestId("sf-api-events-0")).toContainText("Абай");
  await page.getByTestId("sf-api-res-0").scrollIntoViewIfNeeded();
  await shot(page, "fix93-source-json-api-dark");
});

test.describe("width 400", () => {
  test.use({ viewport: { width: 400, height: 860 } });

  test("JSON API editor and preview fit a narrow screen", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/sources");
    const src = auezov(bff.sources[0]!);
    src.listing_pages = [{ url: "https://auezov-theatre.kz/ru/afisha", city: "Almaty", category: "culture.theatre", kind: "json_api", priority: "normal", json_api: JSON.parse(EXAMPLE) }];
    bff.sources.push(src);
    await page.reload();
    await page.locator('[data-source="auezov-theatre-kz"]').click();
    await page.getByTestId("sf-api-check-0").click();
    // узкий экран: события карточками, таблица скрыта
    await expect(page.getByTestId("sf-api-cards-0")).toContainText("Абай");
    await expect(page.getByTestId("sf-api-events-0")).toBeHidden();
    await page.getByTestId("sf-api-cards-0").scrollIntoViewIfNeeded();
    await expectNoHScroll(page);
    await shot(page, "fix93-w400-source-json-api-light");
  });
});
