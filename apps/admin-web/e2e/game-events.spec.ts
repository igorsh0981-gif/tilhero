/**
 * Sprint 6 «События и сезоны» (ADM-GAME-05 TilHero, AT-71): the list by status, «running now»; a new event as a draft
 * (period ≤ 14 days, audiences, unique multipliers, Idempotency-Key), editing a draft; publication with step-up — 409
 * EVENT_OVERLAP shows the event it overlaps with and opens it; cancellation; read-only roles.
 */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { EVENT_ID } from "./fixtures/game-data";

test("list by status; the running event is marked", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/events");
  await expect(page.getByTestId("ev-rows").locator("tbody tr")).toHaveCount(5);
  await expect(page.getByTestId("ev-live-reading_week")).toBeVisible();
  await expect(page.getByTestId("ev-row-reading_week")).toContainText("Чтение ×2 XP");
  await page.getByTestId("ev-status").getByRole("button", { name: /черновик/ }).click();
  await expect(page.getByTestId("ev-rows").locator("tbody tr")).toHaveCount(2);
});

test("a new event: the period ≤ 14 days and unique multipliers are checked; the draft is created and edited", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/events");
  await page.getByTestId("ev-new").click();
  await page.getByTestId("ev-code").fill("listening_week");
  await page.getByTestId("ev-title-ru").fill("Неделя повторений");
  await page.getByTestId("ev-title-uz").fill("Takrorlash haftaligi");
  await page.getByTestId("ev-desc-ru").fill("Повторения дают больше опыта и тилов");
  await page.getByTestId("ev-desc-uz").fill("Takrorlash koʻproq tajriba va til beradi");
  // the wall clock of Tashkent (no DST): the input value is plain date arithmetic, saved in UTC (−5 h)
  const starts = await page.getByTestId("ev-starts").inputValue();
  expect(starts).toMatch(/T00:00$/);
  const plus = (days: number) => new Date(Date.parse(`${starts}:00Z`) + days * 86_400_000).toISOString().slice(0, 16);
  const utc = (local: string) => new Date(Date.parse(`${local}:00Z`) - 5 * 3_600_000).toISOString();
  await page.getByTestId("ev-ends").fill(plus(15));
  await expect(page.getByTestId("ev-form")).toContainText("Событие длится не больше 14 дней");
  await page.getByTestId("ev-ends").fill(plus(7));
  await expect(page.getByTestId("ev-days")).toContainText("7 дн. из 14 возможных");
  await page.getByTestId("ev-mult-0-action").selectOption("review");
  await page.getByTestId("ev-mult-add").click();
  await page.getByTestId("ev-mult-1-action").selectOption("review");
  await page.getByTestId("ev-mult-1-cur").selectOption("xp");
  await expect(page.getByTestId("ev-mult-1")).toContainText("Повтор: такое значение уже есть");
  await page.getByTestId("ev-mult-1-cur").selectOption("til");
  await page.getByTestId("ev-mult-1-factor").selectOption("1.5");
  await page.getByTestId("ev-audiences-kids").uncheck();
  await page.getByTestId("ev-save").click();
  await expect(page.getByText("Создан черновик listening_week")).toBeVisible();
  const post = bff.calls("POST", "/game/events")[0]!;
  expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(post.body).toMatchObject({ code: "listening_week", starts_at: utc(starts), ends_at: utc(plus(7)), description: { ru: "Повторения дают больше опыта и тилов", uz: "Takrorlash koʻproq tajriba va til beradi" }, audiences: ["teens", "adults"], multipliers: [{ action: "review", currency: "xp", factor: 2 }, { action: "review", currency: "til", factor: 1.5 }] });
  await expect(page.getByTestId("ev-card-status")).toHaveText("черновик");
  // edit the draft: only what changed goes to PATCH
  await page.getByTestId("ev-mult-1-remove").click();
  await page.getByTestId("ev-save").click();
  await expect(page.getByText("Событие listening_week сохранено")).toBeVisible();
  const id = (bff.game.events.find((e) => e.code === "listening_week")!).event_id;
  expect(bff.calls("PATCH", `/game/events/${id}`)[0]!.body).toEqual({ multipliers: [{ action: "review", currency: "xp", factor: 2 }] });
});

test("publication: 409 EVENT_OVERLAP shows and opens the overlapping event; a free one publishes; cancellation", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/events/${EVENT_ID.kidsReading}`);
  // the client sees the overlap with the published «Неделя чтения» before asking the server
  await expect(page.getByTestId("ev-clash")).toContainText("Неделя чтения");
  await page.getByTestId("ev-publish").click();
  const dlg = page.getByTestId("ev-cmd-dialog");
  await dlg.locator("#cmd-reason").fill("Сказки для дракончиков на неделю");
  await dlg.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByTestId("ev-overlap")).toContainText("«Неделя чтения»");
  await expect(dlg).toHaveCount(0);
  expect(bff.calls("POST", `/game/events/${EVENT_ID.kidsReading}/publish`).length).toBe(2);
  await page.getByTestId("ev-overlap-open").click();
  await expect(page.getByTestId("ev-card")).toContainText("reading_week");
  await expect(page.getByTestId("ev-ro-status")).toContainText("изменить его нельзя, только отменить");

  // a free draft publishes (the step-up window is still open)
  await page.evaluate((id) => (window.location.hash = `#/events/${id}`), EVENT_ID.reviewBoost);
  await page.getByTestId("ev-publish").click();
  await page.getByTestId("ev-cmd-dialog").locator("#cmd-reason").fill("Марафон повторений в декабре");
  await page.getByTestId("ev-cmd-dialog").getByTestId("confirm-ok").click();
  await expect(page.getByText("Событие review_boost опубликовано")).toBeVisible();
  await expect(page.getByTestId("ev-card-status")).toHaveText("опубликовано");

  // cancel the running event: awards made are not recalculated
  await page.evaluate((id) => (window.location.hash = `#/events/${id}`), EVENT_ID.readingWeek);
  await page.getByTestId("ev-cancel").click();
  const c = page.getByTestId("ev-cmd-dialog");
  await expect(c).toContainText("Начисления, уже сделанные с множителем, не пересчитываются");
  await c.locator("#cmd-reason").fill("Ошиблись с аудиторией события");
  await c.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("ev-card-status")).toHaveText("отменено");
  expect(bff.game.audit.map((a) => a.action)).toEqual(["game.event_published", "game.event_cancelled"]);
});

test("roles without game.manage / game.publish read the events only", async ({ page }) => {
  await openAs(page, "analyst@tilhero.local", `#/events/${EVENT_ID.kidsReading}`);
  await expect(page.getByTestId("ev-card-ro")).toBeVisible();
  await expect(page.getByTestId("ev-save")).toHaveCount(0);
  await expect(page.getByTestId("ev-publish")).toHaveCount(0);
  await expect(page.getByTestId("ev-title-ru")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("ev-new")).toHaveCount(0);
  await expect(page.getByTestId("ev-ro")).toContainText("game.manage");
});

test.describe("a browser in another zone (Europe/Berlin)", () => {
  test.use({ timezoneId: "Europe/Berlin" });
  test("event dates are shown and entered on the Tashkent clock (the zone is named) and saved in UTC", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/events");
    const tash = (iso: string) => new Date(Date.parse(iso) + 5 * 3_600_000).toISOString().slice(0, 16);
    const ev = bff.game.events.find((e) => e.event_id === EVENT_ID.kidsReading)!;
    await expect(page.getByTestId("ev-rows").locator("thead")).toContainText("Период, Ташкент");
    const [d, t] = tash(ev.starts_at).split("T");
    await expect(page.getByTestId("ev-row-kids_reading")).toContainText(`${d!.split("-").reverse().join(".")} ${t}`);
    await page.getByTestId("ev-open-kids_reading").click();
    await expect(page.getByTestId("ev-tz")).toContainText("Ташкенту (UTC+5)");
    await expect(page.getByTestId("ev-starts")).toHaveValue(tash(ev.starts_at));
    await expect(page.getByTestId("ev-starts")).toHaveAttribute("aria-describedby", /ev-tz/);
    const next = `${tash(ev.starts_at).slice(0, 10)}T10:00`;
    await page.getByTestId("ev-starts").fill(next);
    await page.getByTestId("ev-save").click();
    await expect(page.getByText("Событие kids_reading сохранено")).toBeVisible();
    expect(bff.calls("PATCH", `/game/events/${EVENT_ID.kidsReading}`)[0]!.body).toEqual({ starts_at: new Date(Date.parse(`${next}:00Z`) - 5 * 3_600_000).toISOString() });
  });
});
