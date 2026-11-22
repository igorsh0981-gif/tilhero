/**
 * Sprint 7 «Лиги и дуэли» (ADM-GAME-02, AT-74, AT-75, AT-80): weeks of Tashkent with their groups; a group — members
 * with XP, places, prizes and anomaly marks, the versions of its results; the release of held prizes (a reason, no
 * step-up); the re-evaluation of a group — exclude a member with a preview of places and prizes, step-up and a reason:
 * version + 1, the previous version kept; the re-evaluation of a finished duel — another result, step-up, a reason:
 * the previous result in the history, the rewards corrected by reversals.
 */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { DUEL, GROUP } from "./fixtures/social-data";

test("weeks: the current one runs; the previous one is closed with a held group; the next week is not offered", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/leagues");
  await expect(page.getByTestId("lg-week-label")).toHaveAttribute("data-week", bff.social.currentWeek);
  await expect(page.getByTestId("lg-rows").locator("tbody tr")).toHaveCount(2);
  await expect(page.getByTestId("lg-participants")).toHaveText("45");
  await expect(page.getByTestId("lg-next")).toBeDisabled();
  await page.getByTestId("lg-prev").click();
  await expect(page.getByTestId("lg-week-label")).toHaveAttribute("data-week", bff.social.prevWeek);
  await expect(page.getByTestId(`lg-${GROUP.heldPrev}`)).toHaveAttribute("data-status", "held");
  await expect(page.getByTestId(`lg-${GROUP.heldPrev}`)).toContainText("призы удержаны");
  await expect(page.getByTestId("lg-anomalies")).toHaveText("1");
  expect(bff.calls("GET", "/game/leagues").at(-1)).toBeTruthy();
  await page.getByTestId("lg-current").click();
  await expect(page.getByTestId("lg-week-label")).toHaveAttribute("data-week", bff.social.currentWeek);
});

test("a held group: the anomaly marked; re-evaluation excludes it with a preview, step-up and a reason — v2, v1 kept", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/leagues/groups/${GROUP.heldPrev}`);
  const d = page.getByTestId("lg-group");
  await expect(d.getByTestId("lg-held")).toContainText("Призы удержаны: аномалий 1");
  const anomaly = d.locator('[data-anomaly="true"]');
  await expect(anomaly).toHaveCount(1);
  await expect(anomaly).toContainText("4 200");
  const uid = (await anomaly.getAttribute("data-testid"))!.slice(4);
  await d.getByTestId("lg-reevaluate").click();
  const dlg = page.getByTestId("lg-reeval-dialog");
  await expect(dlg).toContainText("Будет создана версия 2; версия 1 сохранится");
  await expect(dlg.getByTestId("lg-preview")).toContainText("Никто не выбывает, призы не меняются");
  await dlg.getByTestId(`lg-ex-${uid}`).locator("input").check();
  await expect(dlg.getByTestId(`lgp-${uid}`)).toContainText("1 → исключён");
  await expect(dlg.getByTestId("lg-preview").locator("li")).toHaveCount(4); // the excluded and three who move up to the prizes
  await dlg.getByTestId("lg-reeval-ok").click();
  await expect(dlg).toContainText("Не короче 10 символов");
  await dlg.getByTestId("lg-reason").fill("XP набран за счёт повторов одного урока — исключён");
  await dlg.getByTestId("lg-reeval-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Создана версия итогов v2")).toBeVisible();
  await expect(d.getByTestId("lgr-2")).toContainText("Тимур");
  await expect(d.getByTestId("lgr-2")).toContainText("исключено: 1");
  await expect(d.getByTestId("lgr-1")).toBeVisible();
  await expect(d.getByTestId(`lgm-${uid}`)).toHaveAttribute("data-excluded", "true");
  await expect(d.getByTestId("lg-group-body")).toHaveAttribute("data-status", "closed");
  const calls = bff.calls("POST", `/game/leagues/${GROUP.heldPrev}/reevaluate`);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.body).toEqual({ exclude_user_ids: [uid], reason: "XP набран за счёт повторов одного урока — исключён" });
  // v1 is shown as it was: the anomaly first with its prize
  await d.getByTestId("lgr-toggle-1").click();
  await expect(d.getByTestId("lgr-standings-1").locator("tbody tr").first()).toContainText("4 200");
});

test("release of held prizes: a reason, no step-up; the open week offers no commands", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/leagues/groups/${GROUP.heldPrev}`);
  await page.getByTestId("lg-release").click();
  const dlg = page.getByTestId("lg-release-dialog");
  await dlg.locator("#cmd-reason").fill("Аномалия проверена: ученик занимался каждый день");
  await dlg.getByTestId("confirm-ok").click();
  await expect(page.getByText("Удержание снято, призы начислены")).toBeVisible();
  await expect(page.getByTestId("lg-group-body")).toHaveAttribute("data-status", "closed");
  await expect(page.getByTestId("lg-release")).toHaveCount(0);
  await expect(page.getByTestId("stepup")).toHaveCount(0);
  expect(bff.social.audit.at(-1)).toMatchObject({ action: "league.prizes_released" });
  await page.evaluate((id) => (window.location.hash = `#/leagues/groups/${id}`), GROUP.a2Now);
  await expect(page.getByTestId("lg-open-note")).toBeVisible();
  await expect(page.getByTestId("lg-reevaluate")).toHaveCount(0);
});

test("a duel: score, result, rewards; re-evaluation to a draw with step-up — the previous result kept, rewards reversed", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/leagues/duels");
  await expect(page.getByTestId("dl-rows").locator("tbody tr")).toHaveCount(2); // finished by default
  await expect(page.getByTestId(`dl-${DUEL.technical}`)).toContainText("техническая");
  await page.getByTestId("dl-status").selectOption("");
  await expect(page.getByTestId("dl-rows").locator("tbody tr")).toHaveCount(6);
  await page.getByTestId(`dl-open-${DUEL.won}`).click();
  const d = page.getByTestId("dl-duel");
  await expect(d.getByTestId("dl-result")).toContainText("победил вызвавший");
  await expect(d.getByTestId("dl-rewards").locator("tbody tr")).toHaveCount(2);
  await d.getByTestId("dl-reevaluate").click();
  const dlg = page.getByTestId("dl-reeval-dialog");
  await dlg.getByTestId("dl-r-challenger").check();
  await dlg.getByTestId("dl-reason").fill("Сбой проверки ключа в задании 7");
  await dlg.getByTestId("dl-reeval-ok").click();
  await expect(dlg).toContainText("Это текущий результат — выберите другой");
  await dlg.getByTestId("dl-r-draw").check();
  await dlg.getByTestId("dl-reeval-ok").click();
  await typeOtp(page, "stepup");
  await expect(page.getByText("Результат пересмотрен: версия 2")).toBeVisible();
  await expect(d.getByTestId("dl-duel-body")).toHaveAttribute("data-version", "2");
  await expect(d.getByTestId("dl-result")).toContainText("ничья");
  await expect(d.getByTestId("dlh-1")).toContainText("победил вызвавший");
  await expect(d.getByTestId("dlh-2")).toContainText("Сбой проверки ключа в задании 7");
  // the two original operations reversed, two reversals and two draw rewards
  await expect(d.getByTestId("dl-rewards").locator('tbody tr[data-status="reversed"]')).toHaveCount(2);
  await expect(d.getByTestId("dl-rewards").locator("tbody tr")).toHaveCount(6);
  expect(bff.calls("POST", `/game/duels/${DUEL.won}/reevaluate`).at(-1)!.body).toEqual({ result: "draw", reason: "Сбой проверки ключа в задании 7" });
  // a running duel cannot be re-evaluated
  await page.evaluate((id) => (window.location.hash = `#/leagues/duels/${id}`), DUEL.running);
  await expect(page.getByTestId("dl-duel-body")).toHaveAttribute("data-status", "accepted");
  await expect(page.getByTestId("dl-reevaluate")).toHaveCount(0);
});

test("F7-9: the answer of a re-evaluation is lost — the group is re-read, the repeat goes with the same key: one new version, not two", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", `#/leagues/groups/${GROUP.heldPrev}`, { social: { reevalLostOnce: true } });
  const d = page.getByTestId("lg-group");
  const uid = (await d.locator('[data-anomaly="true"]').getAttribute("data-testid"))!.slice(4);
  await d.getByTestId("lg-reevaluate").click();
  const dlg = page.getByTestId("lg-reeval-dialog");
  await dlg.getByTestId(`lg-ex-${uid}`).locator("input").check();
  await dlg.getByTestId("lg-reason").fill("XP набран за счёт повторов одного урока — исключён");
  await dlg.getByTestId("lg-reeval-ok").click();
  await typeOtp(page, "stepup");
  // the server wrote v2, the answer was lost: the dialog says so and the group is re-read under it
  await expect(dlg).toContainText("Ответ не получен — команда могла выполниться");
  await expect(d.getByTestId("lgr-2")).toBeVisible();
  await dlg.getByTestId("lg-reeval-ok").click();
  await expect(page.getByText("Создана версия итогов v2")).toBeVisible();
  await expect(d.getByTestId("lgr-3")).toHaveCount(0);
  expect(bff.social.groups.find((g) => g.group_id === GROUP.heldPrev)!.results.map((r) => r.version)).toEqual([2, 1]);
  const calls = bff.calls("POST", `/game/leagues/${GROUP.heldPrev}/reevaluate`);
  expect(calls).toHaveLength(3); // step-up, the lost one, the repeat
  expect(new Set(calls.map((c) => c.headers["idempotency-key"])).size).toBe(1);
  expect(bff.social.audit.filter((a) => a.action === "league.group_reevaluated")).toHaveLength(1);
});
