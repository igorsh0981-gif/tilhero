import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceCrawlStats } from "@tilhero/contracts/admin";
import { I18nProvider, translate, type Lang } from "../src/i18n";
import type { MessageKey } from "../src/i18n/ru";
import {
  AI_COUNTRIES,
  countryName,
  countryOptions,
  CRAWL_CODES,
  CRAWL_TONE,
  crawlCodeHint,
  crawlCodeLabel,
  crawlNoteLabel,
  crawlState,
  NAMED_COUNTRIES,
  skipReasonLabel,
  sortedSkips,
} from "../src/screens/catalog/common";
import { CrawlBlock, CrawlCell, type CrawlData } from "../src/screens/sources/Sources";

/* Fix 4.1: the last crawl of a source (column + card block) and the explicit CIS country names. */

const tRu = (k: MessageKey) => translate("ru", k);
const tEn = (k: MessageKey) => translate("en", k);

const row = (c: Partial<SourceCrawlStats> = {}): SourceCrawlStats => ({
  slug: "iticket-uz",
  last_crawl_at: "2026-10-10T06:12:00Z",
  outcome: "ok",
  code: null,
  pages: 2,
  events_found: 14,
  skipped: { date_mismatch: 3, link_foreign: 1 },
  notes: {},
  llm_calls: 2,
  cost_usd_last: "0.0231",
  cost_usd_day: "0.0462",
  ...c,
});
const ready = (...rows: SourceCrawlStats[]): CrawlData => ({ state: "ready", bySlug: new Map(rows.map((r) => [r.slug, r])) });
const ui = (node: ReactNode, lang: Lang = "ru") => render(<I18nProvider initial={lang}>{node}</I18nProvider>);

afterEach(cleanup);

describe("country names (fix 4.1: «Кыргызстан», not «Киргизия»)", () => {
  it("KG is «Кыргызстан» / «Kyrgyzstan» although Intl says «Киргизия»", () => {
    expect(countryName("ru", "KG")).toBe("Кыргызстан");
    expect(countryName("en", "KG")).toBe("Kyrgyzstan");
  });

  it("the CIS countries are named explicitly in RU and EN", () => {
    const ru = NAMED_COUNTRIES.map((c) => countryName("ru", c));
    const en = NAMED_COUNTRIES.map((c) => countryName("en", c));
    expect(ru).toEqual(["Узбекистан", "Казахстан", "Кыргызстан", "Азербайджан", "Грузия", "Армения", "Таджикистан", "Туркменистан", "Россия", "Беларусь"]);
    expect(en).toEqual(["Uzbekistan", "Kazakhstan", "Kyrgyzstan", "Azerbaijan", "Georgia", "Armenia", "Tajikistan", "Turkmenistan", "Russia", "Belarus"]);
  });

  it("other countries come from Intl; garbage stays visible as the code", () => {
    expect(countryName("ru", "TR")).toBe("Турция");
    expect(countryName("en", "DE")).toBe("Germany");
    expect(countryName("ru", "XX")).toBe("XX");
    expect(countryName("ru", "<b>")).toBe("<b>");
    expect(countryName("ru", "")).toBe("—");
  });

  it("filters list the AI countries first under their explicit names", () => {
    const opts = countryOptions("ru", ["TR", "KG", "BY"]);
    expect(opts.slice(0, AI_COUNTRIES.length)).toEqual([...AI_COUNTRIES]);
    expect(opts.map((c) => countryName("ru", c))).toContain("Кыргызстан");
    expect(opts.map((c) => countryName("ru", c))).not.toContain("Киргизия");
    // the rest is sorted by the shown name: Беларусь < Турция
    expect(opts.slice(AI_COUNTRIES.length)).toEqual(["BY", "TR"]);
  });
});

describe("crawl vocabulary", () => {
  it("state: events found / nothing found / skipped / error / never crawled", () => {
    expect(crawlState(row())).toBe("ok");
    expect(crawlState(row({ events_found: 0 }))).toBe("empty");
    expect(crawlState(row({ outcome: "skipped", code: "SOURCE_ROBOTS_DISALLOWED" }))).toBe("skipped");
    expect(crawlState(row({ outcome: "error" }))).toBe("error");
    expect(crawlState(row({ last_crawl_at: null, outcome: null }))).toBe("never");
    expect(crawlState(row({ outcome: null }))).toBe("never");
    expect(crawlState(undefined)).toBe("never");
    expect([CRAWL_TONE.ok, CRAWL_TONE.skipped, CRAWL_TONE.error]).toEqual(["good", "warn", "bad"]);
  });

  it("codes the customer named have the agreed labels in RU and EN", () => {
    expect(crawlCodeLabel(tRu, "SOURCE_ROBOTS_DISALLOWED")).toBe("Запрещено robots.txt");
    expect(crawlCodeLabel(tRu, "SOURCE_NO_CONTENT")).toBe("Афиша не в HTML (JS)");
    expect(crawlCodeLabel(tRu, "SOURCE_FETCH_FAILED")).toBe("Сайт недоступен");
    expect(crawlCodeLabel(tEn, "SOURCE_ROBOTS_DISALLOWED")).toBe("Blocked by robots.txt");
    for (const c of CRAWL_CODES) {
      expect(crawlCodeLabel(tRu, c), c).not.toBe(c);
      expect(crawlCodeHint(tEn, c), c).toBeTruthy();
    }
  });

  it("other codes fall back to the discovery error label, then to the code", () => {
    expect(crawlCodeLabel(tRu, "AI_BUDGET_EXHAUSTED")).toBe(translate("ru", "run.err.AI_BUDGET_EXHAUSTED"));
    expect(crawlCodeLabel(tEn, "SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(crawlCodeHint(tRu, "AI_BUDGET_EXHAUSTED")).toBeUndefined();
    expect(crawlCodeHint(tRu, null)).toBeUndefined();
  });

  it("discard reasons: labels, a crawl code as a reason, unknown reasons as is", () => {
    expect(skipReasonLabel(tRu, "date_mismatch")).toBe("Дата не совпадает со страницей");
    expect(skipReasonLabel(tEn, "link_foreign")).toBe("Link to another domain");
    expect(skipReasonLabel(tRu, "SOURCE_TOO_LARGE")).toBe("Страница слишком большая");
    expect(skipReasonLabel(tRu, "new_reason")).toBe("new_reason");
    expect(skipReasonLabel(tRu, "category")).toBe("Не событие каталога (экскурсия, парк, музей)");
    expect(skipReasonLabel(tEn, "category")).toBe("Not a catalog event (tour, park, museum)");
    // an older provider-gateway reported page notes as discards: they keep a human label
    expect(skipReasonLabel(tRu, "deadline")).toBe("Не хватило времени — страница обработана не целиком");
  });

  it("page notes: labels; unknown codes go through the discard-reason fallback", () => {
    expect(crawlNoteLabel(tRu, "deadline")).toBe("Не хватило времени — страница обработана не целиком");
    expect(crawlNoteLabel(tRu, "part_truncated")).toBe("Ответ модели обрезан — часть событий могла не попасть");
    expect(crawlNoteLabel(tRu, "part_saturated")).toBe("Слишком много событий на странице — часть могла не попасть");
    expect(crawlNoteLabel(tEn, "part_saturated")).toBe("Too many events on the page — some may be missing");
    expect(crawlNoteLabel(tRu, "SOURCE_TOO_LARGE")).toBe("Страница слишком большая");
    expect(crawlNoteLabel(tRu, "new_note")).toBe("new_note");
  });

  it("discard reasons are sorted by count, zeros dropped, total counted", () => {
    expect(sortedSkips({ a: 1, date_far: 3, b: 0, c: 3 })).toEqual({
      total: 7,
      items: [
        { reason: "c", n: 3 },
        { reason: "date_far", n: 3 },
        { reason: "a", n: 1 },
      ],
    });
    expect(sortedSkips(null)).toEqual({ total: 0, items: [] });
  });
});

describe("«Last crawl» column", () => {
  it("ok: «Найдено N событий» (plural) + when; the outcome is in the tooltip", () => {
    const { container } = ui(<CrawlCell crawl={ready(row())} slug="iticket-uz" />);
    expect(screen.getByText("Найдено 14 событий")).toBeInTheDocument();
    expect(container.querySelector("[data-crawl]")).toHaveAttribute("data-crawl", "ok");
    expect(container.querySelector(".pill")).toHaveClass("good");
    expect(container.querySelector(".pill")).toHaveAttribute("title", "Обход завершён");
    cleanup();
    ui(<CrawlCell crawl={ready(row({ events_found: 1 }))} slug="iticket-uz" />);
    expect(screen.getByText("Найдено 1 событие")).toBeInTheDocument();
    cleanup();
    ui(<CrawlCell crawl={ready(row({ events_found: 3 }))} slug="iticket-uz" />, "en");
    expect(screen.getByText("3 events found")).toBeInTheDocument();
  });

  it("skipped: the human label, the code in the tooltip; error — red", () => {
    const { container } = ui(<CrawlCell crawl={ready(row({ outcome: "skipped", code: "SOURCE_ROBOTS_DISALLOWED", events_found: 0 }))} slug="iticket-uz" />);
    const pill = container.querySelector(".pill")!;
    expect(pill).toHaveTextContent("Запрещено robots.txt");
    expect(pill).toHaveClass("warn");
    expect(pill).toHaveAttribute("title", "Страница пропущена: SOURCE_ROBOTS_DISALLOWED");
    cleanup();
    const err = ui(<CrawlCell crawl={ready(row({ outcome: "error", code: "PROVIDER_BAD_RESPONSE" }))} slug="iticket-uz" />);
    expect(err.container.querySelector(".pill")).toHaveClass("bad");
    expect(err.container.querySelector(".pill")).toHaveTextContent("Некорректный ответ Claude");
  });

  it("stats failed → «—»; not loaded yet → «…»; no row for the source → «Не обходился»", () => {
    ui(<CrawlCell crawl={{ state: "error" }} slug="iticket-uz" />);
    expect(screen.getByText("—")).toHaveAttribute("title", "Статистика обхода недоступна");
    cleanup();
    ui(<CrawlCell crawl={{ state: "loading" }} slug="iticket-uz" />);
    expect(screen.getByLabelText("Загружаем статистику обхода")).toBeInTheDocument();
    cleanup();
    ui(<CrawlCell crawl={ready(row())} slug="kassir-kg" />);
    expect(screen.getByText("Не обходился")).toBeInTheDocument();
  });

  it("untrusted codes and reasons are rendered as text, never as markup", () => {
    const { container } = ui(<CrawlCell crawl={ready(row({ outcome: "error", code: "<img src=x onerror=alert(1)>" }))} slug="iticket-uz" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".pill")).toHaveTextContent("<img src=x onerror=alert(1)>");
  });
});

describe("«Last crawl» block of the source card", () => {
  it("counters, cost of the crawl and of the day, discard reasons with labels and shares", () => {
    ui(<CrawlBlock crawl={ready(row({ skipped: { date_mismatch: 3, link_foreign: 1 } }))} slug="iticket-uz" onRetry={() => undefined} />);
    const b = screen.getByTestId("src-crawl");
    expect(b).toHaveAttribute("data-crawl", "ok");
    expect(within(b).getByTestId("crawl-pages")).toHaveTextContent("2");
    expect(within(b).getByTestId("crawl-events")).toHaveTextContent("14");
    expect(within(b).getByTestId("crawl-dropped")).toHaveTextContent("4");
    expect(within(b).getByTestId("crawl-llm")).toHaveTextContent("2");
    expect(within(b).getByTestId("crawl-cost")).toHaveTextContent("$0.0231");
    expect(within(b).getByTestId("crawl-cost-day")).toHaveTextContent("$0.0462");
    const items = within(b).getByTestId("crawl-skips").querySelectorAll("li");
    expect([...items].map((li) => li.getAttribute("data-reason"))).toEqual(["date_mismatch", "link_foreign"]);
    expect(items[0]).toHaveTextContent("Дата не совпадает со страницей");
    expect(items[0]).toHaveTextContent("3 из 18"); // 14 accepted + 4 discarded
    expect(within(b).getByText("Вызовы Claude")).toBeInTheDocument();
  });

  it("page notes: warnings apart from «Discarded» (not counted there), sorted, with a count; none — no section", () => {
    ui(<CrawlBlock crawl={ready(row({ skipped: { category: 2 }, notes: { part_truncated: 1, deadline: 2, "<b>new</b>": 1 } }))} slug="iticket-uz" onRetry={() => undefined} />);
    const b = screen.getByTestId("src-crawl");
    expect(within(b).getByTestId("crawl-dropped")).toHaveTextContent("2");
    const notes = within(b).getByTestId("crawl-notes").querySelectorAll("li");
    expect([...notes].map((li) => li.getAttribute("data-note"))).toEqual(["deadline", "<b>new</b>", "part_truncated"]);
    expect(notes[0]).toHaveTextContent("Не хватило времени — страница обработана не целиком");
    expect(notes[0]).toHaveTextContent("2 раза");
    expect(notes[1]).toHaveTextContent("<b>new</b>");
    expect(b.querySelector("b")).toBeNull();
    expect(notes[2]).toHaveTextContent("Ответ модели обрезан — часть событий могла не попасть");
    expect(notes[2]).toHaveTextContent("1 раз");
    expect(within(b).getByText("Предупреждения обхода")).toBeInTheDocument();
    expect(within(b).getByTestId("crawl-skips")).toHaveTextContent("Не событие каталога (экскурсия, парк, музей)");
    cleanup();
    // an older admin-bff without notes
    const { notes: _n, ...old } = row();
    ui(<CrawlBlock crawl={ready(old as SourceCrawlStats)} slug="iticket-uz" onRetry={() => undefined} />, "en");
    expect(screen.queryByTestId("crawl-notes")).toBeNull();
    cleanup();
    ui(<CrawlBlock crawl={ready(row({ notes: { part_saturated: 1 } }))} slug="iticket-uz" onRetry={() => undefined} />, "en");
    expect(screen.getByTestId("crawl-notes")).toHaveTextContent("Too many events on the page — some may be missing");
    expect(screen.getByTestId("crawl-notes")).toHaveTextContent("once");
  });

  it("skipped: the code, its label and what to do", () => {
    ui(<CrawlBlock crawl={ready(row({ outcome: "skipped", code: "SOURCE_NO_CONTENT", events_found: 0, skipped: {}, llm_calls: 0 }))} slug="iticket-uz" onRetry={() => undefined} />, "en");
    const b = screen.getByTestId("src-crawl");
    expect(b).toHaveAttribute("data-crawl", "skipped");
    expect(within(b).getByTestId("src-crawl-badge")).toHaveTextContent("Listing not in HTML (JS)");
    expect(within(b).getByText("SOURCE_NO_CONTENT")).toBeInTheDocument();
    expect(within(b).getByText(/JavaScript renders it/)).toBeInTheDocument();
    expect(within(b).queryByTestId("crawl-skips")).toBeNull();
  });

  it("stats unavailable: a calm note and «Retry»; never crawled: when data appears", () => {
    const retry = vi.fn();
    ui(<CrawlBlock crawl={{ state: "error" }} slug="iticket-uz" onRetry={retry} />);
    expect(screen.getByText("Статистика обхода недоступна")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("src-crawl-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
    cleanup();
    ui(<CrawlBlock crawl={ready()} slug="iticket-uz" onRetry={retry} />);
    expect(screen.getByTestId("src-crawl")).toHaveAttribute("data-crawl", "never");
    expect(screen.getByText(/ещё не обходился/)).toBeInTheDocument();
  });
});
