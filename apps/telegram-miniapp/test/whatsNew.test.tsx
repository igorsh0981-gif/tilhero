import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WhatsNew } from "@tilhero/contracts/bff";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import catalogue from "../../../packages/contracts/release-notes.json";
import { artOf, cardsOf, hasWhatsNew, ILLUSTRATION_RE, ILLUSTRATION_SIZE, seenNoteIds } from "../src/domain/whatsNew";
import { I18nProvider } from "../src/i18n";
import { WhatsNewSheet } from "../src/screens/whatsnew/WhatsNewSheet";

const note = (id: string, items: number, link: string | null = null, illustration: string | null = null) => ({
  release_note_id: id,
  slug: id,
  title: `Note ${id}`,
  audience: "existing" as const,
  illustration,
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
  it("release 6.1: the illustration goes to the first card of its note only; a key of another shape is dropped", () => {
    const cards = cardsOf({ mode: "updates", notes: [note("s6", 3, "heroes", "s6-heroes"), note("plain", 1), note("odd", 1, null, "../x")] });
    expect(cards.map((c) => c.art?.src ?? null)).toEqual(["/whatsnew/s6-heroes.webp", null, null, null, null]);
    expect(cards[0]!.art).toEqual({ src: "/whatsnew/s6-heroes.webp", width: 1200, height: 675 });
    expect(cards[0]!.item.link).toBe("heroes");
    for (const bad of ["S6", "a/b", "x.webp", "", 5, null, undefined, "a".repeat(33)]) expect(artOf(bad), String(bad)).toBeNull();
  });
  it("release 6.1: every illustration of the catalogue is a 16:9 file of this build, the key shape is the catalogue's", () => {
    const cat = catalogue as { illustrations: Array<{ key: string; width: number; height: number }>; limits: { illustration_pattern: string } };
    expect(ILLUSTRATION_RE.source).toBe(cat.limits.illustration_pattern);
    expect(cat.illustrations.map((i) => i.key)).toEqual(["welcome", "s6-heroes"]);
    for (const i of cat.illustrations) {
      expect({ width: i.width, height: i.height }).toEqual(ILLUSTRATION_SIZE);
      const file = resolve(__dirname, `../public/whatsnew/${i.key}.webp`);
      expect(existsSync(file), i.key).toBe(true);
      const head = readFileSync(file).subarray(0, 30);
      expect(head.subarray(0, 4).toString("latin1") + head.subarray(8, 12).toString("latin1")).toBe("RIFFWEBP");
      expect([head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff], i.key).toEqual([i.width, i.height]);
    }
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
  it("release 6.1: the illustration on top of the note's first card — full width, 16:9 box reserved, alt = note title", async () => {
    renderSheet({ mode: "updates", notes: [note("s6", 2, "heroes", "s6-heroes"), note("w", 1, null, "welcome")] });
    let img = screen.getByRole("img", { name: "Note s6" });
    expect(img).toHaveAttribute("src", "/whatsnew/s6-heroes.webp");
    expect(img).toHaveAttribute("width", "1200");
    expect(img).toHaveAttribute("height", "675");
    expect(screen.getByTestId("wn-art")).toHaveClass("wn-art");
    // the second card of the same note — no picture
    await userEvent.click(screen.getByRole("button", { name: "Дальше" }));
    expect(screen.queryByTestId("wn-art")).toBeNull();
    // the next note — its own picture
    await userEvent.click(screen.getByRole("button", { name: "Дальше" }));
    img = screen.getByRole("img", { name: "Note w" });
    expect(img).toHaveAttribute("src", "/whatsnew/welcome.webp");
  });
  it("release 6.1: a picture that fails to load is dropped — the card looks as before; no illustration — no picture", async () => {
    renderSheet({ mode: "updates", notes: [note("s6", 1, null, "s6-heroes"), note("plain", 1)] });
    fireEvent.error(screen.getByRole("img", { name: "Note s6" }));
    expect(screen.queryByTestId("wn-art")).toBeNull();
    expect(screen.getByTestId("wn-card")).toHaveTextContent("s6 item 1");
    await userEvent.click(screen.getByRole("button", { name: "Дальше" }));
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("Uzbek texts of the sheet", () => {
    renderSheet({ mode: "welcome", notes: [note("w", 2)] }, "uz");
    expect(screen.getByRole("dialog", { name: "TilHero bilan tanishuv" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keyingisi" })).toBeInTheDocument();
  });
});
