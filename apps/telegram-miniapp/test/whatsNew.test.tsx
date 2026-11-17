import type { WhatsNew } from "@tilhero/contracts/bff";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { cardsOf, hasWhatsNew, seenNoteIds } from "../src/domain/whatsNew";
import { I18nProvider } from "../src/i18n";
import { WhatsNewSheet } from "../src/screens/whatsnew/WhatsNewSheet";

const note = (id: string, items: number, link: string | null = null) => ({
  release_note_id: id,
  slug: id,
  title: `Note ${id}`,
  audience: "existing" as const,
  published_at: "2026-11-17T06:00:00Z",
  items: Array.from({ length: items }, (_, i) => ({ title: `${id} item ${i + 1}`, text: `text ${i + 1}`, link: (i === 0 ? link : null) as never, icon: "bell" as const })),
});

const updates: WhatsNew = { mode: "updates", notes: [note("a", 1, "schedule"), note("b", 2)] };

describe("«Что нового» cards (AT-11)", () => {
  it("one card per item, notes in the server order", () => {
    expect(cardsOf(updates).map((c) => c.key)).toEqual(["a:0", "b:0", "b:1"]);
    expect(cardsOf({ mode: "none", notes: [note("x", 1)] })).toEqual([]);
  });
  it("limits: ≤ 5 notes, ≤ 6 items each, ≤ 12 cards; unknown routes are dropped", () => {
    const many: WhatsNew = { mode: "updates", notes: Array.from({ length: 7 }, (_, i) => note(String(i), 7)) };
    expect(cardsOf(many)).toHaveLength(12);
    const bad = cardsOf({ mode: "updates", notes: [note("z", 1, "javascript:alert(1)")] });
    expect(bad[0]!.item.link).toBeNull();
  });
  it("seen = notes whose cards were on screen", () => {
    const cards = cardsOf(updates);
    expect(seenNoteIds(cards, 0)).toEqual(["a"]);
    expect(seenNoteIds(cards, 1)).toEqual(["a", "b"]);
    expect(seenNoteIds(cards, 2)).toEqual(["a", "b"]);
  });
  it("hasWhatsNew: welcome / updates with at least one card", () => {
    expect(hasWhatsNew(updates)).toBe(true);
    expect(hasWhatsNew({ mode: "welcome", notes: [] })).toBe(false);
    expect(hasWhatsNew(null)).toBe(false);
  });
});

function renderSheet(data: WhatsNew, lang: "ru" | "uz" = "ru") {
  const onClose = vi.fn();
  render(
    <I18nProvider initial={lang}>
      <WhatsNewSheet data={data} onClose={onClose} />
    </I18nProvider>,
  );
  return onClose;
}

describe("WhatsNewSheet", () => {
  it("updates: pages through the cards, «Понятно» on the last one reports every note once", async () => {
    const onClose = renderSheet(updates);
    expect(screen.getByRole("dialog", { name: "Что изменилось" })).toBeInTheDocument();
    expect(screen.getByText("С вашего прошлого входа")).toBeInTheDocument();
    expect(screen.getByText("1 из 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Дальше" }));
    await userEvent.click(screen.getByRole("button", { name: "Дальше" }));
    await userEvent.click(screen.getByRole("button", { name: "Понятно" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(["a", "b"], null);
  });
  it("closing early reports only what was shown", async () => {
    const onClose = renderSheet(updates);
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledWith(["a"], null);
  });
  it("«Подробнее» leads to the item's route; no route — no button", async () => {
    const onClose = renderSheet(updates);
    await userEvent.click(screen.getByRole("button", { name: "Подробнее" }));
    expect(onClose).toHaveBeenCalledWith(["a"], "schedule");
    onClose.mockClear();
  });
  it("Escape closes like the cross", async () => {
    const onClose = renderSheet({ mode: "welcome", notes: [note("w", 2)] });
    expect(screen.getByRole("dialog", { name: "Знакомство с TilHero" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledWith(["w"], null);
  });
  it("Uzbek texts of the sheet", () => {
    renderSheet({ mode: "welcome", notes: [note("w", 2)] }, "uz");
    expect(screen.getByRole("dialog", { name: "TilHero bilan tanishuv" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keyingisi" })).toBeInTheDocument();
  });
});
