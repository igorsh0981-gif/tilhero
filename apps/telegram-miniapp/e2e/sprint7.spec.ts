import { expect, test, type Page } from "@playwright/test";
import * as F from "./fixtures/data";
import { installMic } from "./fixtures/mic";
import type { Scenario } from "./fixtures/mock-bff";
import { P, type SocialScenario } from "./fixtures/social";
import { installSpeech } from "./fixtures/speech";
import { CYRILLIC, open, settle, SHOTS } from "./helpers";

/**
 * Sprint 7 on the mock BFF: «Друзья» (my nickname with its errors, the friend code — copy, share, rotate; the search by
 * an exact code or nickname, requests both ways, remove, block, complain with «и заблокировать», the hidden game profile,
 * sanctions and the appeal, the consent «Семья и друзья»), leagues of the week (friends, the general league — the
 * explanation, the nickname first, the group, leaving, the history; a child — only the family, no places), duels (a
 * challenge → the tasks in the player without hints → waiting → the result → the review; an incoming challenge with
 * DUEL_SET_UNAVAILABLE; a child with the family), the pair lesson (the invitation → the room: roles, turns in order with
 * the mock partner, the pause and the partner's return, a lost poll, leaving the screen and coming back without a second
 * session, the voice, the private report; a child — choices only), referrals (the link, the terms, the progress, plain
 * reasons), routes of «Что нового» and links duel_ / room_, the category «Игра», the social domain down, accessibility,
 * UZ, privacy (no names, Telegram or ages of others anywhere).
 */
const ALL_SEEN = [F.WELCOME.id, F.UPDATE_1.id, F.UPDATE_2.id];
const WITH_SOCIAL = ["terms", "privacy", "learning", "product_news", "social"];

async function start(page: Page, social: SocialScenario = {}, sc: Scenario = {}) {
  await installSpeech(page);
  return open(page, { onboarded: true, seen: ALL_SEEN, content: { diag: "completed" }, game: {}, purposes: WITH_SOCIAL, social, ...sc });
}

/** A screenshot with the element scrolled into view (the app scrolls inside .scroll). */
async function shotOf(page: Page, testId: string, name: string) {
  await page.getByTestId(testId).first().scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The in-app confirmation (outside Telegram the popup is drawn by the app). */
async function confirm(page: Page, ok: string) {
  const dlg = page.getByRole("alertdialog");
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: ok, exact: true }).click();
  await expect(dlg).toBeHidden();
}

async function toFriends(page: Page) {
  await expect(page.getByTestId("social-card")).toBeVisible();
  await page.getByTestId("soc-friends").click();
  await expect(page.getByTestId("friends")).toBeVisible();
}

/** No names, usernames or ages of other learners anywhere on screen (the learner's own name is not shown here either). */
async function expectPrivate(page: Page) {
  const text = await page.locator(".app").innerText();
  expect(text).not.toMatch(/Азиз|Мадина|Сардор|aziz_demo|918273645|лет\b|years/);
}

/** No Cyrillic in the UZ interface. */
async function expectLatin(page: Page) {
  const text = await page.locator(".app").innerText();
  expect(text.match(/.{0,24}[Ѐ-ӿ]+.{0,24}/g)).toBeNull();
  expect(CYRILLIC.test(text)).toBe(false);
}

test.describe("друзья: ник и код", () => {
  test("ник — ошибки (длина, занят, запрещён) и сохранение, смена раз в 7 дней; код — скопировать, поделиться, сменить", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const bff = await start(page, { nickname: null });
    await toFriends(page);
    await expect(page.getByTestId("fr-nick")).toHaveText("не задан");
    await page.getByTestId("fr-nick-edit").click();
    const sheet = page.getByTestId("nick-sheet");
    await expect(sheet).toBeVisible();
    const input = page.getByTestId("nick-input");
    await input.fill("ab");
    await input.blur();
    await expect(sheet.getByRole("alert")).toHaveText("Ник — от 3 до 20 символов.");
    await expect(page.getByTestId("nick-save")).toBeDisabled();
    await input.fill("Aziz tj");
    await expect(sheet.getByRole("alert")).toHaveText("Только буквы, цифры и «_» — без пробелов и знаков.");
    // the server: taken (case-insensitive), forbidden words
    await input.fill("malika_23");
    await page.getByTestId("nick-save").click();
    await expect(sheet.getByRole("alert")).toHaveText("Этот ник уже занят — выберите другой.");
    await input.fill("durak_1");
    await page.getByTestId("nick-save").click();
    await expect(sheet.getByRole("alert")).toHaveText("Такой ник нельзя — выберите другой.");
    await input.fill("Aziz_TH7");
    await page.getByTestId("nick-save").click();
    await expect(page.getByTestId("toast")).toHaveText("Ник сохранён: Aziz_TH7");
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("fr-nick")).toHaveText("Aziz_TH7");
    expect(bff.last("PUT", "/v1/community/nickname")?.body).toEqual({ nickname: "Aziz_TH7" });
    // the next change — in 7 days
    await expect(page.getByTestId("fr-nick-edit")).toBeDisabled();
    await expect(page.getByTestId("fr-nick-when")).toContainText("Сменить ник можно");

    // the friend code: only mine, copy, share in Telegram, rotate (the old one stops working)
    await expect(page.getByTestId("fr-code")).toHaveText("TH-7QKD-M3PX");
    await page.getByTestId("fr-code-copy").click();
    await expect(page.getByTestId("toast")).toHaveText("Код скопирован");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("TH-7QKD-M3PX");
    const popup = page.waitForEvent("popup");
    await page.getByTestId("fr-code-share").click();
    const share = await popup;
    await share.waitForURL(/t\.me/);
    expect(share.url()).toContain("https://t.me/share/url?url=https%3A%2F%2Ft.me%2FTilHeroBot%3Fstartapp%3Droute_friends");
    expect(decodeURIComponent(share.url())).toContain("TH-7QKD-M3PX");
    await share.close();
    await page.getByTestId("fr-code-rotate").click();
    await confirm(page, "Сменить код");
    await expect(page.getByTestId("toast")).toHaveText("Новый код: TH-NEWC-ODE2");
    await expect(page.getByTestId("fr-code")).toHaveText("TH-NEWC-ODE2");
    await expectPrivate(page);
    await shotOf(page, "fr-me", "50_friends");
  });
});

test.describe("друзья: поиск, заявки, удаление", () => {
  test("код → заявка с Idempotency-Key; ник → входящая принята; исходящая отозвана; не найдено; это вы; удалить друга", async ({ page }) => {
    const bff = await start(page);
    await toFriends(page);
    // the requests on screen: incoming Jasur, outgoing Kamol; friends Malika_23 and «Друг»
    await expect(page.getByTestId("req-in-list")).toContainText("Jasur");
    await expect(page.getByTestId("req-out-list")).toContainText("Kamol");
    await expect(page.getByTestId("fr-list").getByTestId("fr-row")).toHaveText([/Malika_23/, /Друг/]);

    // a code in any case, without dashes
    const search = page.getByTestId("fr-search-input");
    await search.fill("th dlnz 4567");
    await page.getByTestId("fr-search-go").click();
    const found = page.getByTestId("fr-found");
    await expect(found).toHaveAttribute("data-relation", "none");
    await expect(page.getByTestId("fr-found-name")).toHaveText("Dilnoza");
    expect(bff.last("GET", "/v1/friends/search")?.query.get("q")).toBe("TH-DLNZ-4567");
    await page.getByTestId("fr-add").click();
    await expect(page.getByTestId("toast")).toHaveText("Заявка отправлена");
    await expect(found).toHaveAttribute("data-relation", "request_out");
    const sent = bff.last("POST", "/v1/friends/requests")!;
    expect(sent.body).toEqual({ member_id: P.dilnoza.member_id });
    expect(sent.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByTestId("req-out-list")).toContainText("Dilnoza");

    // by the nickname: a request to me — accept right from the card
    await search.fill("jasur");
    await search.press("Enter");
    await expect(found).toHaveAttribute("data-relation", "request_in");
    await page.getByTestId("fr-found-accept").click();
    await expect(page.getByTestId("toast")).toHaveText("Теперь вы друзья");
    await expect(page.getByTestId("fr-list")).toContainText("Jasur");
    await expect(page.getByTestId("req-in-list")).toHaveCount(0);

    // my outgoing request — take it back
    await page.getByTestId("req-out-list").getByRole("button", { name: "Отозвать: Kamol" }).click();
    await expect(page.getByTestId("toast")).toHaveText("Заявка отозвана");
    await expect(page.getByTestId("req-out-list")).not.toContainText("Kamol");

    // nothing / myself / not a query
    await search.fill("Nobody_here");
    await page.getByTestId("fr-search-go").click();
    await expect(page.getByTestId("fr-not-found")).toHaveText("Никого не нашли. Проверьте код или ник.");
    await search.fill("TH-7QKD-M3PX");
    await page.getByTestId("fr-search-go").click();
    await expect(found).toHaveAttribute("data-relation", "self");
    await expect(found).toContainText("Это вы");
    await expect(page.getByTestId("fr-add")).toHaveCount(0);
    await search.fill("x");
    await expect(page.getByTestId("fr-search-go")).toBeDisabled();

    // remove a friend: a confirmation, no notification to them
    await page.getByTestId("fr-list").getByTestId("fr-row").filter({ hasText: "Malika_23" }).click();
    await expect(page.getByTestId("friend-sheet")).toBeVisible();
    await page.getByTestId("friend-remove").click();
    await confirm(page, "Удалить из друзей");
    await expect(page.getByTestId("toast")).toHaveText("Удалено из друзей");
    await expect(page.getByTestId("fr-list")).not.toContainText("Malika_23");
    expect(bff.calls("DELETE", `/v1/friends/${P.malika.member_id}`)).toHaveLength(1);
    await expectPrivate(page);
  });
});

test.describe("друзья: из карточки друга", () => {
  test("«Вызвать на дуэль» открывает дуэль; повторный вызов того же друга — та же дуэль; «Позвать на урок вдвоём» — партнёр уже выбран", async ({ page }) => {
    const bff = await start(page);
    await toFriends(page);
    await page.getByTestId("fr-list").getByTestId("fr-row").filter({ hasText: "Malika_23" }).click();
    await page.getByTestId("friend-duel").click();
    await expect(page.getByTestId("duel")).toHaveAttribute("data-phase", "awaiting");
    await expect(page.getByTestId("duel-awaiting")).toContainText("Ждём ответа до");
    const first = [...bff.social.duels.keys()].pop()!;
    await page.getByTestId("bar-back").click();
    // the sheet closed when the duel opened; a second challenge of the same friend opens the same duel (409 DUEL_EXISTS)
    await expect(page.getByTestId("friend-sheet")).toHaveCount(0);
    await page.getByTestId("fr-list").getByTestId("fr-row").filter({ hasText: "Malika_23" }).click();
    await page.getByTestId("friend-duel").click();
    await expect(page.getByTestId("duel")).toBeVisible();
    expect(bff.social.duels.size).toBe(1);
    expect([...bff.social.duels.keys()].pop()).toBe(first);
    await page.getByTestId("bar-back").click();
    await page.getByTestId("fr-list").getByTestId("fr-row").filter({ hasText: "Друг" }).click();
    await page.getByTestId("friend-pair").click();
    await expect(page.getByTestId("pi-partner")).toHaveText("Друг");
  });
});

test.describe("друзья: блокировка и жалоба", () => {
  test("заблокировать друга → в «Заблокированных» → разблокировать; жалоба с причиной, комментарием и «и заблокировать»; жалоба на заявку", async ({ page }) => {
    const bff = await start(page);
    await toFriends(page);
    // block «Друг» (no nickname)
    await page.getByTestId("fr-list").getByTestId("fr-row").filter({ hasText: "Друг" }).click();
    await page.getByTestId("friend-block").click();
    await confirm(page, "Заблокировать");
    await expect(page.getByTestId("toast")).toHaveText("Заблокировано");
    await expect(page.getByTestId("fr-list").getByTestId("fr-row")).toHaveCount(1);
    expect(bff.last("POST", "/v1/blocks")?.body).toEqual({ member_id: P.noNick.member_id });

    // a complaint: the reason first, a comment, «и заблокировать»
    await page.getByTestId("fr-list").getByTestId("fr-row").filter({ hasText: "Malika_23" }).click();
    await page.getByTestId("friend-complain").click();
    const sheet = page.getByTestId("complaint-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("На кого: Malika_23");
    await expect(page.getByTestId("cmp-send")).toBeDisabled();
    await page.getByTestId("cmp-abuse").click();
    await expect(page.getByTestId("cmp-abuse")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("cmp-comment").fill("Пишет грубости в дуэлях");
    await page.getByTestId("cmp-block").check();
    await shotOf(page, "complaint-sheet", "51_complaint");
    await page.getByTestId("cmp-send").click();
    await expect(page.getByTestId("toast")).toHaveText("Жалоба отправлена, ученик заблокирован");
    const c = bff.last("POST", "/v1/complaints")!;
    expect(c.body).toEqual({ member_id: P.malika.member_id, subject_kind: "user", subject_id: null, reason: "abuse", comment: "Пишет грубости в дуэлях", block: true });
    expect(c.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByTestId("fr-empty")).toBeVisible();

    // a complaint on an incoming request: its id is the subject
    await page.getByTestId("req-complain").click();
    await page.getByTestId("cmp-spam").click();
    await page.getByTestId("cmp-send").click();
    await expect(page.getByTestId("toast")).toHaveText("Жалоба отправлена");
    const onRequest = bff.last("POST", "/v1/complaints")!.body as Record<string, unknown>;
    expect(onRequest.subject_kind).toBe("friend_request");
    expect(onRequest.subject_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(onRequest.block).toBeUndefined();

    // the blocked list: both; unblock does not bring the friendship back
    await page.getByTestId("fr-to-blocked").click();
    await expect(page.getByTestId("blocked-row")).toHaveCount(2);
    await expect(page.getByTestId("blocked-list")).toContainText("Malika_23");
    await page.getByRole("button", { name: "Разблокировать: Malika_23" }).click();
    await expect(page.getByTestId("toast")).toContainText("Разблокировано");
    await expect(page.getByTestId("blocked-row")).toHaveCount(1);
    await page.getByTestId("bar-back").click();
    await expect(page.getByTestId("fr-list")).toHaveCount(0);
    await expectPrivate(page);
  });
});

test.describe("друзья: скрытый профиль, ограничения, согласие", () => {
  test("скрыть игровой профиль; санкция — баннер, заявки запрещены, обжалование один раз; прошлое предупреждение с ответом", async ({ page }) => {
    const bff = await start(page, { sanctions: true });
    await toFriends(page);
    await expect(page.getByTestId("soc-restricted")).toContainText("Социальные действия ограничены до");
    await page.getByTestId("fr-hide").check();
    await expect(page.getByTestId("toast")).toHaveText("Игровой профиль скрыт");
    expect(bff.last("PATCH", "/v1/community")?.body).toEqual({ game_profile_hidden: true });
    await expect(page.getByTestId("fr-hide")).toBeChecked();
    // a request under the ban — the date of its end
    await page.getByTestId("fr-search-input").fill("Dilnoza");
    await page.getByTestId("fr-search-go").click();
    await page.getByTestId("fr-add").click();
    await expect(page.getByTestId("fr-found").getByRole("alert")).toContainText("Социальные действия ограничены до");

    await page.getByTestId("soc-to-sanctions").click();
    const ban = page.locator('[data-testid="sanction"][data-kind="social_ban"]');
    await expect(ban).toHaveAttribute("data-active", "true");
    await expect(ban.getByTestId("sanction-basis")).toHaveText("Грубые сообщения в нике: жалобы трёх учеников подтвердились.");
    await ban.getByTestId("appeal-open").click();
    await page.getByTestId("appeal-text").fill("Коротко");
    await expect(page.getByTestId("appeal-send")).toBeDisabled();
    await page.getByTestId("appeal-text").fill("Ник придумал брат, я его уже сменил. Прошу снять запрет.");
    await page.getByTestId("appeal-send").click();
    await expect(page.getByTestId("toast")).toHaveText("Обжалование отправлено — ответ придёт уведомлением");
    await expect(ban.getByTestId("sanction-appeal")).toHaveAttribute("data-status", "open");
    await expect(ban.getByTestId("appeal-open")).toHaveCount(0);
    expect(bff.last("POST", /\/v1\/sanctions\/[0-9a-f-]+\/appeal$/)?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    const warn = page.locator('[data-testid="sanction"][data-kind="warning"]');
    await expect(warn.getByTestId("sanction-appeal")).toHaveAttribute("data-status", "upheld");
    await expect(warn.getByTestId("sanction-answer")).toContainText("предупреждение остаётся");
    // who decided is never shown
    expect(await page.getByTestId("sanctions").innerText()).not.toMatch(/staff|модератор [А-Я]/);
    await shotOf(page, "sanctions", "52_sanctions");
  });

  test("без цели «Семья и друзья» — объяснение и «Разрешить»; после согласия — поиск", async ({ page }) => {
    const bff = await start(page, {}, { purposes: ["terms", "privacy", "learning"] });
    await toFriends(page);
    await expect(page.getByTestId("friends-gate")).toHaveAttribute("data-reason", "consent");
    await expect(page.getByTestId("fr-search-input")).toHaveCount(0);
    await page.getByTestId("friends-allow").click();
    await page.getByTestId("social-allow").click();
    await expect(page.getByTestId("friends-gate")).toHaveCount(0);
    await expect(page.getByTestId("fr-search-input")).toBeVisible();
    expect((bff.last("POST", "/v1/profile/consent")?.body as { purposes: string[] }).purposes).toContain("social");
  });
});

test.describe("лиги недели", () => {
  test("друзья: места, «вы», ник или «Друг»; общая — объяснение, сначала ник, включение, группа назначится; история", async ({ page }) => {
    const bff = await start(page, { nickname: null, league: { history: true } });
    await page.getByTestId("soc-leagues").click();
    await expect(page.getByTestId("leagues")).toHaveAttribute("data-tab", "friends");
    await expect(page.getByTestId("lg-ends")).toContainText("Неделя до 23 ноября");
    const table = page.getByTestId("lg-table-friend");
    // XP of the week: Malika_23 260, me 140, «Друг» 90 — places in numbers and in words
    await expect(table.locator("li")).toHaveCount(3);
    await expect(table.locator("li").nth(0)).toHaveAttribute("aria-label", "1 место: Malika_23, 260 XP, значки: Неделя подряд, Первый урок");
    // badges by name, never codes
    await expect(table.locator("li").nth(0).getByTestId("lg-badges")).toHaveAttribute("title", "Неделя подряд, Первый урок");
    await expect(page.getByTestId("lg-me")).toHaveAttribute("aria-label", "2 место: Вы, 140 XP, значки: Первый урок");
    await expect(page.getByTestId("lg-me")).not.toContainText("· вы");
    await expect(table.locator("li").nth(2)).toHaveAttribute("aria-label", "3 место: Друг, 90 XP");
    await expect(page.getByTestId("lg-total")).toHaveText("Вместе набрали 490 XP за неделю");
    await expect(page.getByTestId("leagues")).toContainText("В лиге друзей и семьи призов нет");
    await expectPrivate(page);
    await shotOf(page, "lg-table-friend", "53_league_friends");

    // the general league: what others see before joining; the nickname first
    await page.getByTestId("lg-tabs").getByRole("button", { name: "Общая" }).click();
    const gen = page.getByTestId("lg-general");
    await expect(gen).toHaveAttribute("data-opt-in", "false");
    await expect(page.getByTestId("lg-explain")).toContainText("Только по желанию и только с 14 лет.");
    await expect(page.getByTestId("lg-explain")).toContainText("Видно другим: ник, герой, XP недели, место и значки.");
    await expect(page.getByTestId("lg-explain")).toContainText("Не видно никому: имя, Telegram, возраст, ответы, ошибки и покупки.");
    await expect(page.getByTestId("lg-why")).toHaveAttribute("data-reason", "nickname_required");
    await expect(page.getByTestId("lg-join")).toBeDisabled();
    await expect(page.getByTestId("lg-prizes")).toContainText("1 место — 50 тилов");
    await page.getByTestId("lg-set-nick").click();
    await page.getByTestId("nick-input").fill("Aziz_TH7");
    await page.getByTestId("nick-save").click();
    await expect(page.getByTestId("lg-join")).toBeEnabled();
    await page.getByTestId("lg-join").click();
    await expect(page.getByTestId("toast")).toHaveText("Вы в общей лиге");
    expect(bff.last("PATCH", "/v1/game/settings")?.body).toEqual({ league_opt_in: true });
    await expect(gen).toHaveAttribute("data-opt-in", "true");
    await expect(page.getByTestId("lg-pending")).toHaveText("Группу назначим в начале недели — загляните в понедельник.");
    await expect(page.getByTestId("lg-group")).toHaveText("Ваша группа · RU-EN · A2");

    // the history of past weeks
    await page.getByTestId("lg-history").click();
    const rows = page.getByTestId("lg-hist-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("2 место из 24");
    await expect(rows.first()).toContainText("Приз: 30 тилов");
    await expect(rows.nth(1)).toContainText("итоги пересчитаны");
  });

  test("общая лига: группа 24 ученика, места и призы 1–3, моя строка; выйти — с подтверждением", async ({ page }) => {
    const bff = await start(page, { nickname: "Aziz_TH", league: { optIn: true } }, { game: { leagueOptIn: true } });
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-leagues").click();
    await page.getByTestId("lg-tabs").getByRole("button", { name: "Общая" }).click();
    const table = page.getByTestId("lg-table-general");
    await expect(table.locator("li")).toHaveCount(24);
    await expect(table.locator("li").first()).toContainText("приз 50 тилов");
    await expect(table.locator("li").nth(2)).toContainText("приз 20 тилов");
    await expect(table.locator("li").nth(3)).not.toContainText("приз");
    await expect(page.getByTestId("lg-me")).toHaveAttribute("aria-label", "22 место: Aziz_TH, 140 XP, значки: Первый урок");
    await expect(page.getByTestId("lg-me")).toHaveAttribute("data-place", "22");
    // only nicknames: every row of the general league has one
    for (const name of await table.locator("li .t b").allInnerTexts()) expect(name).toMatch(/^(Learner_\d+|Aziz_TH · вы)$/);
    await shotOf(page, "lg-general", "54_league_general");
    await page.getByTestId("lg-leave").click();
    await confirm(page, "Выйти из общей лиги");
    await expect(page.getByTestId("toast")).toHaveText("Участие выключено");
    expect(bff.last("PATCH", "/v1/game/settings")?.body).toEqual({ league_opt_in: false });
  });

  test("ребёнок: только семья, без мест и «последнего», «вместе набрали», без имён", async ({ page }) => {
    await start(page, {}, { child: true });
    await expect(page.getByTestId("social-card")).toContainText("Моя семья");
    await page.getByTestId("soc-friends").click();
    const fam = page.getByTestId("kid-family");
    await expect(fam).toBeVisible();
    await expect(page.getByTestId("kid-member")).toHaveText([/Aziz_TH/, /Участник семьи/]);
    await expect(page.getByTestId("kid-league")).toContainText("Вместе вы набрали 380 XP — так держать!");
    await expect(fam).not.toContainText("Друзья");
    await expectPrivate(page);
    await shotOf(page, "kid-members", "55_kid_family");
    await page.getByTestId("kid-league").click();
    await expect(page.getByTestId("leagues")).toHaveAttribute("data-tab", "family");
    await expect(page.getByTestId("lg-tabs")).toHaveCount(0);
    await expect(page.getByTestId("lg-kid-note")).toHaveText("Это лига твоей семьи: вместе копите опыт за неделю.");
    const table = page.getByTestId("lg-table-family");
    await expect(table.locator("li")).toHaveCount(3);
    await expect(table.locator(".lg-place")).toHaveCount(0);
    await expect(table.locator("li[data-place]")).toHaveCount(0);
    await expect(page.getByTestId("lg-me")).toHaveAttribute("aria-label", "Ты: 140 XP, значки: Первый урок");
    const text = await page.getByTestId("leagues").innerText();
    expect(text).not.toMatch(/место|последн|рейтинг|Общая/i);
    await expectPrivate(page);
    await shotOf(page, "lg-table-family", "56_kid_league");
  });
});

test.describe("дуэли", () => {
  test("вызов другу → прохождение без подсказок → ожидание соперника → результат → разбор только моих ответов", async ({ page }) => {
    test.setTimeout(90_000);
    const bff = await start(page, { duels: { autoAccept: true } });
    await page.getByTestId("soc-duels").click();
    await page.getByTestId("duel-new").click();
    const pick = page.getByTestId("duel-pick");
    await expect(pick.getByRole("button")).toContainText(["Malika_23", "Друг"]);
    await pick.getByRole("button", { name: "Malika_23" }).click();
    await expect(page.getByTestId("toast")).toHaveText("Вызов отправлен");
    const created = bff.last("POST", "/v1/game/duels")!;
    expect(created.body).toEqual({ opponent_member_id: P.malika.member_id });
    expect(created.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    // the opponent accepted: play within 48 h
    await expect(page.getByTestId("duel")).toHaveAttribute("data-phase", "play");
    await expect(page.getByTestId("duel-opponent")).toContainText("Соперник: Malika_23");
    await shotOf(page, "duel-play", "57_duel_play");
    await page.getByTestId("duel-start").click();

    // the lesson player in the duel mode: no hints, no AI, «Ответ принят»
    await expect(page.getByTestId("pl-duel")).toHaveText("Дуэль: без подсказок и ИИ. Время на результат не влияет.");
    for (let i = 0; i < 10; i++) {
      await expect(page.getByTestId("pl-prompt")).toBeVisible();
      await expect(page.getByTestId("pl-hint-btn")).toHaveCount(0);
      await page.getByTestId("pl-opt-0").click();
      await page.getByTestId("pl-answer").click();
      if (i < 9) await expect(page.getByTestId("pl-stage-of")).toContainText(`${i + 2} из 10`);
    }
    await expect(page.getByTestId("pl-done")).toContainText("Задания дуэли выполнены");
    await page.getByTestId("pl-finish").click();
    // back to the duel: waiting for the opponent; the duel session is not an active lesson
    await expect(page.getByTestId("duel")).toHaveAttribute("data-phase", "waiting");
    await expect(page.getByTestId("duel-waiting")).toContainText("Соперник ещё не сыграл");
    const active = await page.evaluate(async () => (await fetch("/__bff/v1/sessions/active", { headers: { Authorization: "Bearer acc-1" } })).json());
    expect(active.session).toBeNull();

    // the opponent plays: the result by the server's key
    const duelId = created.body ? [...bff.social.duels.keys()].pop()! : "";
    bff.social.opponentPlays(duelId, 6);
    await page.getByTestId("duel-refresh").click();
    await expect(page.getByTestId("duel")).toHaveAttribute("data-phase", "result");
    await expect(page.getByTestId("duel-outcome")).toHaveText("Победа!");
    await expect(page.getByTestId("duel-my-score")).toContainText("8 из 10");
    await expect(page.getByTestId("duel-their-score")).toContainText("Malika_23");
    await expect(page.getByTestId("duel-their-score")).toContainText("6 из 10");
    await expect(page.getByTestId("duel-xp")).toHaveText("+30 XP");
    await shotOf(page, "duel-result", "58_duel_result");
    await page.getByTestId("duel-review").click();
    await expect(page.getByTestId("duel-review-score")).toHaveText("Верно 8 из 10");
    await expect(page.getByTestId("duel-item")).toHaveCount(10);
    await expect(page.locator('[data-testid="duel-item"][data-correct="false"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="duel-item"][data-correct="false"]').first().getByTestId("duel-item-right")).toHaveText("Правильно: кофе");
    await expect(page.getByTestId("duel-review-screen")).toContainText("ответы соперника не показываются");
  });

  test("входящий вызов: задания не подготовились (503) — «Принять» ещё раз; без баннера «Нет связи»", async ({ page }) => {
    await start(page, { duels: { incoming: true, setUnavailableOnce: true } });
    await page.getByTestId("soc-duels").click();
    const row = page.getByTestId("duel-row");
    await expect(row).toHaveAttribute("data-phase", "incoming");
    await expect(row).toContainText("Malika_23");
    await expect(row).toContainText("новое");
    await row.click();
    await expect(page.getByTestId("duel-incoming")).toContainText("Malika_23 вызывает вас на дуэль");
    await page.getByTestId("duel-accept").click();
    await expect(page.getByTestId("duel-incoming").getByRole("alert")).toHaveText("Не удалось подготовить задания — попробуйте принять ещё раз.");
    await expect(page.getByTestId("offline")).toHaveCount(0);
    await page.getByTestId("duel-accept").click();
    await expect(page.getByTestId("toast")).toHaveText("Вызов принят — можно играть");
    await expect(page.getByTestId("duel")).toHaveAttribute("data-phase", "play");
  });

  test("ребёнок: вызов от члена семьи — отказаться; вызвать можно только семью", async ({ page }) => {
    const bff = await start(page, { duels: { incoming: true } }, { child: true });
    await page.getByTestId("soc-duels").click();
    await expect(page.getByTestId("duels")).toContainText("Без подсказок. Спешить не нужно!");
    await page.getByTestId("duel-row").click();
    await expect(page.getByTestId("duel-incoming")).toContainText("Aziz_TH зовёт тебя на дуэль");
    await page.getByTestId("duel-decline").click();
    await expect(page.getByTestId("duel-line")).toHaveText("Вызов отклонён");
    await page.getByTestId("bar-back").click();
    await page.getByTestId("duel-new").click();
    const pick = page.getByTestId("duel-pick");
    await expect(pick).toContainText("С кем сыграть?");
    await expect(pick.getByRole("heading", { name: "Друзья" })).toHaveCount(0);
    await expect(pick.getByRole("heading", { name: "Семья" })).toBeVisible();
    await pick.getByRole("button", { name: "Участник семьи" }).click();
    await expect(page.getByTestId("duel")).toBeVisible();
    expect(bff.last("POST", "/v1/game/duels")?.body).toEqual({ opponent_member_id: P.sibling.member_id });
    await expectPrivate(page);
  });
});

test.describe("урок вдвоём", () => {
  test("приглашение → комната: роли, ходы по очереди, пауза и возврат партнёра, обрыв опроса, уход с экрана и возврат без второй сессии, голос, отчёт только мой", async ({ page }) => {
    test.setTimeout(120_000);
    await installMic(page, "ok");
    const bff = await start(page, { pair: { autoAccept: true, pauseAfter: 2 } }, { purposes: [...WITH_SOCIAL, "voice_recording"] });
    await page.getByTestId("soc-pair").click();
    await expect(page.getByTestId("pair-rooms")).toContainText("Минуты ИИ-коуча считаются у того, кто позвал, — один раз за урок.");
    await page.getByTestId("pair-new").click();
    await expect(page.getByTestId("pi-send")).toBeDisabled();
    await page.getByTestId("pi-pick").click();
    await page.getByTestId("pi-pick-sheet").getByRole("button", { name: "Malika_23" }).click();
    await expect(page.getByTestId("pi-partner")).toHaveText("Malika_23");
    await page.getByTestId("pi-sc-sc-cafe-order").click();
    // a time further than 7 days is refused before sending
    await page.getByTestId("pi-when").getByRole("button", { name: "Назначить время" }).click();
    await page.getByTestId("pi-at").fill("2030-01-01T10:00");
    await expect(page.getByTestId("pair-invite").getByRole("alert")).toHaveText("Выберите время в ближайшие 7 дней.");
    await expect(page.getByTestId("pi-send")).toBeDisabled();
    await page.getByTestId("pi-when").getByRole("button", { name: "Сейчас" }).click();
    await page.getByTestId("pi-send").click();
    await expect(page.getByTestId("toast")).toHaveText("Приглашение отправлено");
    const inv = bff.last("POST", "/v1/pair-rooms")!;
    expect(inv.body).toEqual({ partner_member_id: P.malika.member_id, pair_id: "ru-en", scenario_id: "sc-cafe-order", start: "now" });
    expect(inv.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);

    // the partner accepted: enter the room; the coach gives the roles and the goal
    await expect(page.getByTestId("pair-lobby")).toHaveAttribute("data-phase", "enter");
    await page.getByTestId("pair-enter").click();
    await expect(page.getByTestId("room")).toHaveAttribute("data-status", "in_progress");
    await expect(page.getByTestId("room-role")).toContainText("Ваша роль A");
    await expect(page.getByTestId("room-goal")).toHaveText("Order two drinks and ask for the bill.");
    await expect(page.getByTestId("room-turn")).toHaveText("Ваш ход");
    await expect(page.getByTestId("room-prompt")).toContainText("Greet the waiter and ask for a table for two.");
    await page.getByTestId("room-gloss-btn").click();
    await expect(page.getByTestId("room-gloss")).toHaveText("Поздоровайтесь с официантом и попросите столик на двоих.");

    // my line → the partner's turn → the partner answers (only inside this room) → the coach → my turn
    await page.getByTestId("room-input").fill("Hello! We need a table for two, please.");
    await page.getByTestId("room-send").click();
    await expect(page.getByTestId("room-me")).toHaveCount(1);
    const turn1 = bff.last("POST", /\/v1\/pair-rooms\/[0-9a-f-]+\/turns$/)!;
    expect(turn1.body).toEqual({ text: "Hello! We need a table for two, please." });
    expect(turn1.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByTestId("room-partner")).toContainText("Of course! Here is your table.");
    await expect(page.getByTestId("room-turn")).toHaveText("Ваш ход");
    await expect(page.getByTestId("room-prompt")).toContainText("Order two drinks politely.");
    await expect(page.getByTestId("room-seconds")).toHaveText("Ваше время речи: 8 с");
    await expect(page.getByTestId("room-progress")).toHaveAttribute("aria-valuenow", "33");
    await shotOf(page, "room-feed", "59_pair_room");

    // the second line: the partner goes offline in his turn — the room is paused
    await page.getByTestId("room-input").fill("I'd like a latte and a tea, please.");
    await page.getByTestId("room-send").click();
    await expect(page.getByTestId("room-turn")).toHaveText(/^(Ход партнёра: Malika_23|Пауза)$/);
    await expect(page.getByTestId("room-turn")).toHaveText("Пауза");
    await expect(page.getByTestId("room-paused")).toHaveText("Пауза: партнёр не в сети. Ждём его до 3 минут.");
    await expect(page.getByTestId("room")).toHaveAttribute("data-status", "paused");
    await expect(page.locator('[data-testid="room-sys"][data-kind="offline"]')).toHaveText("Malika_23 не в сети");
    await shotOf(page, "room-paused", "60_pair_paused");
    bff.social.partnerBack();
    await expect(page.getByTestId("room-paused")).toHaveCount(0);
    await expect(page.getByTestId("room-partner")).toHaveCount(2);
    await expect(page.getByTestId("room-prompt")).toContainText("Ask for the bill.");

    // a lost poll: «переподключаемся», then the feed goes on by itself
    bff.social.failPolls = 1;
    await expect(page.getByTestId("room-reconnect")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("room-reconnect")).toHaveCount(0, { timeout: 10_000 });
    expect(await page.getByTestId("offline").count()).toBe(0);

    // leave the screen (not the room) and come back: the same room, the same feed, no second session
    const joins = bff.social.room()!.joins;
    await page.getByTestId("bar-back").click();
    await expect(page.getByTestId("pair-rooms")).toBeVisible();
    await page.getByTestId("pair-row").first().click();
    await expect(page.getByTestId("room-prompt")).toContainText("Ask for the bill.");
    await expect(page.getByTestId("room-me")).toHaveCount(2);
    expect(bff.social.room()!.joins).toBeGreaterThan(joins);
    expect(bff.social.room()!.sessions.size).toBe(1);

    // the third line by voice: recorded, recognised, confirmed, sent as the turn {audio_id}
    await page.getByTestId("room-voice-start").click();
    await expect(page.getByTestId("room-voice")).toHaveAttribute("data-phase", "recording");
    await page.waitForTimeout(800);
    await page.getByTestId("room-voice-stop").click();
    await expect(page.getByTestId("room-heard-text")).toHaveText("Hello! A table for two, please.");
    const audio = bff.last("POST", /\/v1\/pair-rooms\/[0-9a-f-]+\/audio$/)!;
    expect(audio.headers["content-type"]).toBe("audio/wav");
    await page.getByTestId("room-voice-send").click();
    await expect.poll(() => (bff.last("POST", /\/v1\/pair-rooms\/[0-9a-f-]+\/turns$/)?.body as Record<string, unknown>)?.audio_id).toMatch(/^ad/);

    // the end: my own report — my lines, seconds, minutes counted and not charged; never the partner's lines
    await expect(page.getByTestId("pair-ended")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("pair-end-reason")).toHaveText("Сценарий завершён.");
    await page.getByTestId("pair-to-report").click();
    const report = page.getByTestId("pair-report");
    await expect(page.getByTestId("prep-private")).toContainText("Отчёт видите только вы");
    await expect(page.getByTestId("prep-team")).toHaveAttribute("data-goal", "true");
    await expect(page.getByTestId("prep-together")).toContainText("Значок «Вместе» получают оба");
    await expect(page.getByTestId("prep-turns")).toHaveText("Реплик: 3");
    await expect(page.getByTestId("prep-seconds")).toHaveText("Время речи: 18 секунд");
    await expect(page.getByTestId("prep-minutes")).toHaveText("Минут: 4 — учтены, не списаны");
    await expect(page.getByTestId("prep-lines").locator("li")).toHaveCount(3);
    await expect(report).not.toContainText("Of course");
    await expect(report).not.toContainText("Here you are");
    await expectPrivate(page);
    await shotOf(page, "prep-team", "61_pair_report");
  });

  test("ребёнок: входящее приглашение от семьи — принять, войти; только выбор реплик, без текста и голоса", async ({ page }) => {
    const bff = await start(page, { pair: { incoming: true } }, { child: true });
    await page.getByTestId("soc-pair").click();
    await expect(page.getByTestId("pair-rooms")).toContainText("Ты выбираешь реплики — печатать не нужно.");
    const row = page.getByTestId("pair-row");
    await expect(row).toContainText("Aziz_TH зовёт тебя на урок вдвоём");
    await row.click();
    await expect(page.getByTestId("pair-lobby")).toHaveAttribute("data-phase", "incoming");
    await expect(page.getByTestId("pair-lobby")).toContainText("В детском профиле — только выбор реплик и без голоса.");
    await page.getByTestId("pair-accept").click();
    await expect(page.getByTestId("pair-lobby")).toHaveAttribute("data-phase", "enter");
    await page.getByTestId("pair-enter").click();
    await expect(page.getByTestId("room-turn")).toHaveText("Твой ход");
    await expect(page.getByTestId("room-role")).toContainText("Твоя роль B");
    await expect(page.getByTestId("room-options")).toContainText("Выбери реплику");
    await expect(page.getByTestId("room-input")).toHaveCount(0);
    await expect(page.getByTestId("room-voice")).toHaveCount(0);
    await expect(page.getByTestId("room-voice-off")).toHaveCount(0);
    await shotOf(page, "room-foot", "62_pair_kid");
    await page.getByTestId("room-opt-c1").click();
    await expect(page.getByTestId("room-me")).toHaveText(/Hello! A table for two, please\./);
    expect(bff.last("POST", /\/v1\/pair-rooms\/[0-9a-f-]+\/turns$/)?.body).toEqual({ choice_id: "c1" });
    await expect(page.getByTestId("room-partner")).toContainText("Of course!");
    await expectPrivate(page);
  });

  test("выйти из комнаты — с подтверждением; отказаться от приглашения", async ({ page }) => {
    const bff = await start(page, { pair: { incoming: true, autoAccept: true } });
    await page.getByTestId("soc-pair").click();
    await page.getByTestId("pair-row").click();
    await page.getByTestId("pair-decline").click();
    await expect(page.getByTestId("toast")).toHaveText("Вы отказались");
    await expect(page.getByTestId("pair-line")).toHaveText("Приглашение отклонено");
    await page.getByTestId("bar-back").click();
    await page.getByTestId("pair-new").click();
    await page.getByTestId("pi-pick").click();
    await page.getByTestId("pi-pick-sheet").getByRole("button", { name: "Друг" }).click();
    await page.getByTestId("pi-sc-sc-cafe-order").click();
    await page.getByTestId("pi-send").click();
    await page.getByTestId("pair-enter").click();
    await expect(page.getByTestId("room-turn")).toHaveText("Ваш ход");
    await page.getByTestId("room-leave").click();
    await confirm(page, "Выйти");
    await expect(page.getByTestId("toast")).toHaveText("Вы вышли из урока");
    expect(bff.calls("POST", /\/v1\/pair-rooms\/[0-9a-f-]+\/leave$/)).toHaveLength(1);
  });
});

test.describe("рефералы", () => {
  test("ссылка, условия, лимит месяца; приглашённые с прогрессом «диагностика, уроки N/3, дни N/2», награда, причина отказа без антифрода", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-referrals").click();
    await page.getByTestId("ref-create").click();
    await expect(page.getByTestId("ref-url")).toContainText("t.me/TilHeroBot/app?startapp=inv_");
    const created = bff.last("POST", "/v1/invites")!;
    expect(created.body).toEqual({ kind: "referral" });
    expect(created.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    const popup = page.waitForEvent("popup");
    await page.getByTestId("ref-share").click();
    const share = await popup;
    await share.waitForURL(/t\.me/);
    expect(share.url()).toContain("https://t.me/share/url?url=https%3A%2F%2Ft.me%2FTilHeroBot%2Fapp%3Fstartapp%3Dinv_");
    await share.close();

    const terms = page.getByTestId("ref-terms");
    await expect(terms).toContainText("пройти проверку уровня;");
    await expect(terms).toContainText("пройти 3 урока;");
    await expect(terms).toContainText("заниматься в разные дни — не меньше 2;");
    await expect(terms).toContainText("всё — за 30 дней после приглашения.");
    await expect(page.getByTestId("ref-reward")).toHaveText("Ваша награда: 2 заморозки");
    await expect(page.getByTestId("ref-month")).toHaveText("Наград в этом месяце: 1 из 10");

    const rows = page.getByTestId("ref-row");
    await expect(rows).toHaveCount(6);
    const learning = page.locator('[data-testid="ref-row"][data-status="learning"]');
    await expect(learning).toContainText("Nodira");
    await expect(learning).toContainText("Учится");
    await expect(learning.getByTestId("ref-step-diagnostic")).toHaveAttribute("data-done", "true");
    await expect(learning.getByTestId("ref-step-lessons")).toContainText("Уроки 2/3");
    await expect(learning.getByTestId("ref-step-days")).toContainText("Дни 1/2");
    await expect(learning.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "72");
    await expect(learning.getByTestId("ref-until")).toContainText("Выполнить до");
    const review = page.locator('[data-testid="ref-row"][data-status="review"]');
    await expect(review).toContainText("Друг");
    await expect(review.getByTestId("ref-review")).toHaveText("Проверяем, что всё честно, — обычно это недолго.");
    await expect(page.locator('[data-testid="ref-row"][data-status="rewarded"]').getByTestId("ref-row-reward")).toHaveText("Ваша награда: 2 заморозки");
    await expect(page.locator('[data-testid="ref-row"][data-status="rejected"]').getByTestId("ref-reason")).toHaveText("Причина: Приглашение не прошло проверку.");
    await expect(page.locator('[data-testid="ref-row"][data-status="expired"]:not([data-legacy])').getByTestId("ref-reason")).toHaveText("Причина: Условия не выполнены вовремя.");
    // the former programme, expired: its own line instead of a refusal reason
    const legacy = page.locator('[data-testid="ref-row"][data-legacy="true"]');
    await expect(legacy.getByTestId("ref-legacy")).toHaveText("Приглашение по прежней программе");
    await expect(legacy.getByTestId("ref-reason")).toHaveCount(0);
    // never the rules of the anti-fraud check
    expect(await page.getByTestId("referrals").innerText()).not.toMatch(/антифрод|скорост|подозр|минут на урок|velocity/i);
    await expectPrivate(page);
    await shotOf(page, "ref-list", "63_referrals");
  });

  test("ребёнок: приглашать могут взрослые (маршрут route_referrals)", async ({ page }) => {
    await start(page, {}, { child: true, startParam: "route_referrals" });
    await expect(page.getByTestId("ref-locked")).toHaveText("Приглашать новых учеников могут взрослые.");
  });
});

test.describe("«Что нового», ссылки и уведомления", () => {
  for (const [route, testId] of [["friends", "friends"], ["leagues", "leagues"], ["duels", "duels"], ["referrals", "referrals"]] as const) {
    test(`route_${route} открывает экран`, async ({ page }) => {
      await start(page, {}, { startParam: `route_${route}` });
      await expect(page.getByTestId(testId)).toBeVisible();
    });
  }

  test("duel_<id> — карточка вызова; room_<id> — приглашение в урок вдвоём", async ({ page }) => {
    const bff = await start(page, { duels: { incoming: true }, pair: { incoming: true } });
    await expect(page.getByTestId("home")).toBeVisible();
    const duelId = [...bff.social.duels.keys()][0]!;
    const roomId = bff.social.room()!.view.room_id;
    (bff.sc as { startParam?: string }).startParam = `duel_${duelId}`;
    await page.reload();
    await expect(page.getByTestId("duel-incoming")).toContainText("Malika_23 вызывает вас на дуэль");
    (bff.sc as { startParam?: string }).startParam = `room_${roomId}`;
    await page.reload();
    await expect(page.getByTestId("pair-lobby")).toHaveAttribute("data-phase", "incoming");
    await expect(page.getByTestId("pair-line")).toHaveText("Malika_23 зовёт вас на урок вдвоём");
  });

  test("без игры (флаг game выключен) duel_ ведёт на главную, а «Друзья» работают", async ({ page }) => {
    const bff = await start(page, { duels: { incoming: true } }, { config: { ...F.CONFIG, flags: { ...F.CONFIG.flags, game: false } } });
    const duelId = [...bff.social.duels.keys()][0]!;
    (bff.sc as { startParam?: string }).startParam = `duel_${duelId}`;
    await page.reload();
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(page.getByTestId("duel")).toHaveCount(0);
    await expect(page.getByTestId("soc-leagues")).toHaveCount(0);
    await page.getByTestId("soc-friends").click();
    await expect(page.getByTestId("friends")).toBeVisible();
    await expect(page.getByTestId("fr-to-leagues")).toHaveCount(0);
  });

  test("категория «Игра и лиги» в настройках уведомлений; общая лига — из настроек мотивации", async ({ page }) => {
    const bff = await start(page);
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-notif").click();
    await expect(page.getByTestId("notif-settings")).toContainText("Игра и лиги");
    await expect(page.getByTestId("ns-game")).toBeChecked();
    await page.getByTestId("ns-game").uncheck();
    await expect.poll(() => bff.last("PATCH", "/v1/profile/settings")?.body).toEqual({ notifications: { categories: { game: false } } });
    await expect(page.getByTestId("ns-game")).not.toBeChecked();
    await page.getByTestId("bar-back").click();
    await page.getByTestId("row-game-settings").click();
    await expect(page.getByTestId("gs-league")).toContainText("выкл.");
    await page.getByTestId("gs-league").click();
    await expect(page.getByTestId("leagues")).toHaveAttribute("data-tab", "general");
  });

  test("социальное недоступно (503) — понятный текст, учёба и главная работают, без «Нет связи»", async ({ page }) => {
    await start(page, { mode: "down" });
    await expect(page.getByTestId("today-card")).toBeVisible();
    await page.getByTestId("soc-friends").click();
    await expect(page.getByTestId("social-error")).toContainText("Друзья, лиги и дуэли сейчас недоступны — учёба работает как обычно.");
    await expect(page.getByTestId("offline")).toHaveCount(0);
    await page.getByTestId("bar-back").click();
    await page.getByTestId("soc-leagues").click();
    await expect(page.getByTestId("social-error")).toBeVisible();
    await page.getByTestId("bar-back").click();
    await expect(page.getByTestId("today-card")).toBeVisible();
  });
});

test.describe("доступность и язык", () => {
  test("клавиатура: поиск по Enter, жалоба — фокус в листе и Escape; подписи у кнопок, строк лиги и полос", async ({ page }) => {
    await start(page);
    await toFriends(page);
    await page.getByTestId("fr-search-input").focus();
    await page.keyboard.type("Dilnoza");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("fr-found")).toBeVisible();
    await page.getByTestId("fr-found-complain").focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByTestId("complaint-sheet");
    await expect(sheet).toBeVisible();
    // the focus is inside the sheet and stays there
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    // every button of the screen has a name
    for (const b of await page.getByTestId("friends").getByRole("button").all()) {
      const name = ((await b.getAttribute("aria-label")) ?? (await b.innerText())).trim();
      expect(name.length, await b.evaluate((el) => el.outerHTML.slice(0, 120))).toBeGreaterThan(1);
    }
    await page.getByTestId("bar-back").click();
    await page.getByTestId("soc-leagues").click();
    for (const li of await page.getByTestId("lg-table-friend").locator("li").all()) expect(await li.getAttribute("aria-label")).toMatch(/^\d+ место: .+, \d+ XP(, значки: [^_]+)?$/);
    // my row: a word and a frame, not colour only
    await expect(page.getByTestId("lg-me")).toHaveClass(/me/);
  });

  test("UZ: друзья, лиги, дуэли, рефералы — латиница, без кириллицы", async ({ page }) => {
    await start(page, { nickname: "Aziz_TH", duels: { finished: true } }, { locale: "uz" });
    await expect(page.getByTestId("social-card")).toContainText("Birgalikda oʻrganish");
    await page.getByTestId("soc-friends").click();
    await expect(page.getByTestId("friends")).toContainText("Doʻst kodi");
    await expectLatin(page);
    await page.getByTestId("fr-to-leagues").click();
    await expect(page.getByTestId("lg-me")).toHaveAttribute("aria-label", "2-oʻrin: Aziz_TH, 140 XP, nishonlar: Birinchi dars");
    await expectLatin(page);
    await page.getByTestId("bar-back").click();
    await page.getByTestId("fr-to-duels").click();
    await page.getByTestId("duel-tabs").getByRole("button", { name: "Tugagan" }).click();
    await page.getByTestId("duel-row").click();
    await expect(page.getByTestId("duel-outcome")).toHaveText("Gʻalaba!");
    await expect(page.getByTestId("duel-my-score")).toContainText("10 tadan 9");
    await expectLatin(page);
    await page.getByTestId("bar-back").click();
    await page.getByTestId("bar-back").click();
    await page.getByTestId("fr-to-referrals").click();
    await expect(page.getByTestId("ref-terms")).toContainText("3 ta dars oʻtish;");
    await expectLatin(page);
    await shotOf(page, "ref-terms", "64_referrals_uz");
  });
});

/** datetime-local in Asia/Tashkent (the zone of the browser in these tests) `ms` from now */
function localIn(ms: number): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(Date.now() + ms))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

async function invite(page: Page, partner: string, later?: string) {
  await page.getByTestId("soc-pair").click();
  await page.getByTestId("pair-new").click();
  await page.getByTestId("pi-pick").click();
  await page.getByTestId("pi-pick-sheet").getByRole("button", { name: partner }).click();
  await page.getByTestId("pi-sc-sc-cafe-order").click();
  if (later) {
    await page.getByTestId("pi-when").getByRole("button", { name: "Назначить время" }).click();
    await page.getByTestId("pi-at").fill(later);
  }
  await page.getByTestId("pi-send").click();
  await expect(page.getByTestId("toast")).toHaveText("Приглашение отправлено");
}

test.describe("урок вдвоём: время старта, возврат, потерянный ход, жалоба (ревью F7-1, F7-2, F7-5, F7-6)", () => {
  test("назначенный урок: после принятия — лобби со временем и «Отменить», без входа; вход открывается за 5 минут до начала", async ({ page }) => {
    const bff = await start(page, { pair: { autoAccept: true } });
    await invite(page, "Malika_23", localIn(26 * 3600_000));
    const lobby = page.getByTestId("pair-lobby");
    await expect(lobby).toHaveAttribute("data-phase", "scheduled");
    await expect(page.getByTestId("pair-line")).toHaveText("Урок назначен");
    await expect(page.getByTestId("pair-scheduled")).toContainText("Урок начнётся");
    await expect(page.getByTestId("pair-scheduled")).toContainText("Войти можно за 5 минут до начала.");
    await shotOf(page, "pair-scheduled", "65_pair_scheduled");
    await expect(page.getByTestId("pair-enter")).toHaveCount(0);
    await expect(page.getByTestId("room")).toHaveCount(0);
    expect(bff.calls("POST", /\/v1\/pair-rooms\/[0-9a-f-]+\/join$/)).toHaveLength(0);
    // cancel before the start
    await page.getByTestId("pair-cancel").click();
    await expect(page.getByTestId("toast")).toHaveText("Приглашение отменено");
    await expect(lobby).toHaveAttribute("data-phase", "ended");
    await expect(page.getByTestId("pair-line")).toHaveText("Приглашение отменено");

    // a new one: the start comes — «Войти» appears, the room opens
    await page.getByTestId("bar-back").click();
    await page.getByTestId("bar-back").click();
    await invite(page, "Malika_23", localIn(26 * 3600_000));
    await expect(lobby).toHaveAttribute("data-phase", "scheduled");
    bff.social.startSoon([...bff.social.rooms.keys()].pop());
    await page.getByTestId("pair-refresh").click();
    await expect(lobby).toHaveAttribute("data-phase", "enter");
    await page.getByTestId("pair-enter").click();
    await expect(page.getByTestId("room")).toHaveAttribute("data-status", "in_progress");
    await expect(page.getByTestId("room-turn")).toHaveText("Ваш ход");
  });

  test("вернулся позже 3 минут: heartbeat 409 — связь закончена, «Вы вышли из урока» без вечной загрузки; потом — завершение и отчёт", async ({ page }) => {
    test.setTimeout(90_000);
    const bff = await start(page, { pair: { autoAccept: true } });
    await invite(page, "Malika_23");
    await page.getByTestId("pair-enter").click();
    await expect(page.getByTestId("room-turn")).toHaveText("Ваш ход");
    await page.getByTestId("room-input").fill("Hello! A table for two, please.");
    await page.getByTestId("room-send").click();
    await expect(page.getByTestId("room-partner")).toHaveCount(1);
    // the learner was away more than 3 minutes: the next heartbeat (≤ 10 s) answers 409 ROOM_NOT_ACTIVE {abandoned}
    bff.social.abandon();
    await expect(page.getByTestId("pair-away")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("pair-away")).toContainText("Вас не было больше 3 минут");
    await expect(page.getByTestId("pair-lobby")).toHaveAttribute("data-phase", "away");
    await expect(page.getByTestId("room-reconnect")).toHaveCount(0);
    await shotOf(page, "pair-away", "66_pair_away");
    // opened again from the list: the lobby, never the endless loading of the room
    const joins = bff.social.room()!.joins;
    await page.getByTestId("bar-back").click();
    await page.getByTestId("pair-row").first().click();
    await expect(page.getByTestId("pair-lobby")).toHaveAttribute("data-phase", "away");
    await expect(page.locator('[data-testid="room"][aria-busy="true"]')).toHaveCount(0);
    expect(bff.social.room()!.joins).toBe(joins);
    // the partner finishes alone: the end and my own report
    bff.social.finishSolo();
    await page.getByTestId("pair-refresh").click();
    await expect(page.getByTestId("pair-lobby")).toHaveAttribute("data-phase", "ended");
    await expect(page.getByTestId("pair-end-reason")).toHaveText("Урок завершён: один из участников вышел и не вернулся за 3 минуты.");
    await page.getByTestId("pair-to-report").click();
    await expect(page.getByTestId("prep-turns")).toHaveText("Реплик: 1");
  });

  test("потерянный ответ хода (ход засчитан) → следующий ход с тем же вариантом c1 уходит с НОВЫМ ключом и засчитывается", async ({ page }) => {
    const bff = await start(page, { pair: { incoming: true } }, { child: true });
    await page.getByTestId("soc-pair").click();
    await page.getByTestId("pair-row").click();
    await page.getByTestId("pair-accept").click();
    await page.getByTestId("pair-enter").click();
    await expect(page.getByTestId("room-turn")).toHaveText("Твой ход");
    // a child never gets «Пожаловаться» inside the room (the parent does it in the family)
    await expect(page.getByTestId("room-complain")).toHaveCount(0);
    bff.social.dropTurnOnce = true;
    await page.getByTestId("room-opt-c1").click();
    await expect(page.getByTestId("room-foot").getByRole("alert")).toBeVisible();
    await shotOf(page, "room-foot", "67_pair_turn_lost");
    // the turn was taken on the server: the feed brings it, the partner's answer and my next turn — again c1..c3
    await expect(page.getByTestId("room-partner")).toHaveCount(1);
    await expect(page.getByTestId("room-turn")).toHaveText("Твой ход");
    await expect(page.getByTestId("room-opt-c1")).toHaveText("Two teas, please.");
    await page.getByTestId("room-opt-c1").click();
    await expect(page.getByTestId("room-me")).toHaveCount(2);
    await expect(page.getByTestId("room-partner")).toHaveCount(2);
    const turns = bff.calls("POST", /\/v1\/pair-rooms\/[0-9a-f-]+\/turns$/);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.body).toEqual({ choice_id: "c1" });
    expect(turns[1]!.body).toEqual({ choice_id: "c1" });
    expect(turns[1]!.headers["idempotency-key"]).not.toBe(turns[0]!.headers["idempotency-key"]);
    expect(bff.social.room()!.myTurns).toBe(2);
    await expect(page.getByTestId("room-seconds")).toHaveText("Твоё время речи: 10 с");
  });

  test("жалоба прямо из комнаты: предмет — комната, «и заблокировать» — выход из урока; детям кнопки нет", async ({ page }) => {
    const bff = await start(page, { pair: { autoAccept: true } });
    await invite(page, "Malika_23");
    await page.getByTestId("pair-enter").click();
    await expect(page.getByTestId("room-turn")).toHaveText("Ваш ход");
    await page.getByTestId("room-complain").click();
    const sheet = page.getByTestId("complaint-sheet");
    await expect(sheet).toContainText("На кого: Malika_23");
    await page.getByTestId("cmp-abuse").click();
    await page.getByTestId("cmp-block").check();
    await shotOf(page, "complaint-sheet", "68_pair_room_complaint");
    await page.getByTestId("cmp-send").click();
    await expect(page.getByTestId("toast")).toHaveText("Жалоба отправлена, ученик заблокирован");
    const roomId = bff.social.room()!.view.room_id;
    expect(bff.last("POST", "/v1/complaints")?.body).toEqual({ member_id: P.malika.member_id, subject_kind: "pair_room", subject_id: roomId, reason: "abuse", block: true });
    await expect(page.getByTestId("pair-rooms")).toBeVisible();
    await expect.poll(() => bff.calls("POST", `/v1/pair-rooms/${roomId}/leave`).length).toBe(1);
  });
});

test.describe("ник сброшен модератором", () => {
  test("санкция — пояснение строкой и ссылка на дату в «Друзьях»; до срока ник не задать ни из «Друзей», ни из общей лиги; потом прежний ник запрещён", async ({ page }) => {
    const bff = await start(page, { nicknameReset: true });
    await toFriends(page);
    await expect(page.getByTestId("fr-nick")).toHaveText("не задан");
    await expect(page.getByTestId("fr-nick-edit")).toBeDisabled();
    await expect(page.getByTestId("fr-nick-when")).toContainText("Задать новый ник можно");

    // the sanction: what the reset means — a plain line, not a button; the link leads to the date
    await page.getByTestId("fr-to-sanctions").click();
    const reset = page.locator('[data-testid="sanction"][data-kind="nickname_reset"]');
    await expect(reset).toHaveAttribute("data-active", "true");
    await expect(reset.getByTestId("sanction-nick-note")).toHaveText("Новый ник можно задать через 7 дней после сброса. Прежний ник больше недоступен.");
    expect(await reset.getByTestId("sanction-nick-note").evaluate((n) => n.tagName)).toBe("P");
    await expect(reset.getByRole("button", { name: /Новый ник можно задать/ })).toHaveCount(0);
    await shotOf(page, "sanction-nick", "69_nickname_reset");
    await reset.getByTestId("sanction-nick-when").click();
    await expect(page.getByTestId("fr-nick-when")).toContainText("Задать новый ник можно");

    // the general league asks for a nickname — the sheet shows the date and does not save
    await page.getByTestId("fr-to-leagues").click();
    await page.getByTestId("lg-tabs").getByRole("button", { name: "Общая" }).click();
    await expect(page.getByTestId("lg-why")).toHaveAttribute("data-reason", "nickname_required");
    await page.getByTestId("lg-set-nick").click();
    await expect(page.getByTestId("nick-when")).toContainText("Задать новый ник можно");
    await expect(page.getByTestId("nick-input")).toBeDisabled();
    await expect(page.getByTestId("nick-save")).toBeDisabled();
    await shotOf(page, "nick-sheet", "70_nickname_wait");
    expect(bff.calls("PUT", "/v1/community/nickname")).toHaveLength(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("nick-sheet")).toBeHidden();

    // 7 days later: the reset nickname is closed to everybody — a plain reason; another one is saved
    bff.social.nicknameCooldownOver();
    await page.getByTestId("bar-back").click();
    await expect(page.getByTestId("friends")).toBeVisible();
    await expect(page.getByTestId("fr-nick-edit")).toBeEnabled();
    await page.getByTestId("fr-nick-edit").click();
    await page.getByTestId("nick-input").fill("Bad_Boy_TH");
    await page.getByTestId("nick-save").click();
    await expect(page.getByTestId("nick-sheet").getByRole("alert")).toHaveText("Такой ник нельзя — выберите другой.");
    await page.getByTestId("nick-input").fill("Aziz_New");
    await page.getByTestId("nick-save").click();
    await expect(page.getByTestId("toast")).toHaveText("Ник сохранён: Aziz_New");
    await expect(page.getByTestId("fr-nick")).toHaveText("Aziz_New");
  });
});
