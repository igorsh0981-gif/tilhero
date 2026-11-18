import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Permission, StaffReleaseNote } from "@tilhero/contracts/admin";
import { ReleaseNotes } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { I18nProvider, type Lang } from "../src/i18n";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";
import { SessionCtx, type Session } from "../src/state/session";
import { ToastProvider } from "../src/ui/toasts";
import { LIMITS, NOTE_ICONS, NOTE_ROUTES, WhatsNewConfig, contentOf, emptyDraft, nextSlug, normalizeDraft, validateDraft } from "../src/screens/config/WhatsNew";
import { MINI_ICON_PATHS } from "../src/screens/config/miniIcons";

/* 9.4 «Конфигурация интерфейса» → «Что нового»: список, редактор RU/EN, превью, публикация и архив с подтверждением. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ALL: Permission[] = ["config.read", "config.edit", "config.publish"];
const session = (perms: Permission[]): Session => {
  const set = new Set(perms);
  return { me: null, can: (p) => set.has(p), canAny: (ps) => ps.some((p) => set.has(p)), refreshMe: async () => null, setMe: () => undefined, signOut: async () => undefined, reloadTheme: async () => undefined, themeVersion: null, adminLayout: null };
};
const ui = (node: ReactNode, perms: Permission[] = ALL, lang: Lang = "ru") =>
  render(
    <I18nProvider initial={lang}>
      <SessionCtx.Provider value={session(perms)}>
        <ToastProvider>{node}</ToastProvider>
      </SessionCtx.Provider>
    </I18nProvider>,
  );

const row = (p: Partial<StaffReleaseNote> = {}): StaffReleaseNote => ({
  release_note_id: "7a1c2e3f-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
  slug: "2026.11",
  title: { ru: "Ноябрь 2026", en: "November 2026" },
  items: [
    { title: { ru: "Больше событий в Алматы", en: "More events in Almaty" }, text: { ru: "Собираем афишу.", en: "Listings." }, link: "catalog", icon: "pin" },
    { title: { ru: "TilHero на главном экране", en: "TilHero on your Home Screen" }, text: { ru: "Кнопка — в Профиле.", en: "In Profile." }, link: "profile", icon: "phone" },
  ],
  audience: "existing",
  status: "draft",
  version: 1,
  created_by: "system:seed",
  created_at: "2026-11-08T06:00:00.000Z",
  updated_by: "system:seed",
  updated_at: "2026-11-08T06:00:00.000Z",
  published_by: null,
  published_at: null,
  archived_by: null,
  archived_at: null,
  ...p,
});

const CATALOG = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/contracts/release-notes.json"), "utf8")) as {
  routes: string[];
  icons: string[];
  limits: { title_max: number; item_title_max: number; item_text_max: number; items_max: number };
};

describe("логика редактора", () => {
  it("белые списки, лимиты и иконки = общий каталог и Mini App", () => {
    expect([...NOTE_ROUTES]).toEqual(CATALOG.routes);
    expect([...NOTE_ICONS]).toEqual(CATALOG.icons);
    expect([LIMITS.title, LIMITS.itemTitle, LIMITS.text, LIMITS.itemsMax]).toEqual([CATALOG.limits.title_max, CATALOG.limits.item_title_max, CATALOG.limits.item_text_max, CATALOG.limits.items_max]);
    const mini = readFileSync(resolve(__dirname, "../../telegram-miniapp/src/ui/Icon.tsx"), "utf8");
    for (const name of CATALOG.icons) {
      const m = new RegExp(`^  ${name}: (\\[.*\\]),$`, "m").exec(mini);
      expect(m, name).not.toBeNull();
      expect(JSON.parse(m![1]!)).toEqual(MINI_ICON_PATHS[name]);
    }
    for (const r of CATALOG.routes) expect(ru[`wn.route.${r}` as keyof typeof ru]).toBeTruthy();
  });

  it("метка следующего релиза; проверка полей; нормализация пробелов", () => {
    const nov = new Date(2026, 10, 8);
    expect(nextSlug([], nov)).toBe("2026.11");
    expect(nextSlug(["2026.11"], nov)).toBe("2026.11-2");
    const d = emptyDraft("2026.12");
    expect(Object.keys(validateDraft(d)).sort()).toEqual(["items.0.text.en", "items.0.text.ru", "items.0.title.en", "items.0.title.ru", "title.en", "title.ru"]);
    const ok = contentOf(row());
    expect(validateDraft(ok)).toEqual({});
    expect(validateDraft({ ...ok, slug: "../x" }).slug?.key).toBe("wn.errSlug");
    const long = contentOf(row());
    long.items[0]!.text.ru = "а".repeat(201);
    expect(validateDraft(long)["items.0.text.ru"]).toEqual({ key: "wn.errLen", n: 200 });
    expect(normalizeDraft({ ...ok, title: { ru: "  Ноябрь   2026 ", en: "x" } }).title.ru).toBe("Ноябрь 2026");
  });
});

describe("экран «Что нового»", () => {
  it("загрузка → список со статусами, редактор черновика, превью", async () => {
    vi.spyOn(ReleaseNotes, "list").mockResolvedValue({ items: [row(), row({ release_note_id: "b", slug: "2026.10", status: "archived", title: { ru: "Октябрь", en: "October" } })], next_cursor: null });
    ui(<WhatsNewConfig />);
    expect(screen.getByText("Загрузка…")).toBeInTheDocument();
    const list = await screen.findByTestId("wn-list");
    expect(within(list).getByText("черновик")).toBeInTheDocument();
    expect(within(list).getByText("в архиве")).toBeInTheDocument();
    const ed = screen.getByTestId("wn-editor");
    expect(within(ed).getByRole("heading", { name: /Черновик 2026.11/ })).toBeInTheDocument();
    expect(screen.getByTestId("wn-preview")).toHaveTextContent("Что нового в TilHero");
    expect(screen.getByTestId("wn-preview")).toHaveTextContent("Больше событий в Алматы");
    fireEvent.click(within(screen.getByTestId("wn-preview")).getByRole("button", { name: "EN" }));
    expect(screen.getByTestId("wn-preview")).toHaveTextContent("What's new in TilHero");
  });

  it("пусто и ошибка загрузки", async () => {
    vi.spyOn(ReleaseNotes, "list").mockResolvedValueOnce({ items: [], next_cursor: null });
    ui(<WhatsNewConfig />);
    expect(await screen.findByTestId("wn-empty")).toHaveTextContent("Заметок пока нет");
    cleanup();
    vi.spyOn(ReleaseNotes, "list").mockRejectedValueOnce(new ApiError(503, { code: "UPSTREAM_UNAVAILABLE", message: "x" }));
    ui(<WhatsNewConfig />);
    expect(await screen.findByRole("button", { name: /Повторить|Retry/ })).toBeInTheDocument();
  });

  it("новая заметка: пункты добавить/удалить/порядок, проверка до отправки, создание", async () => {
    vi.spyOn(ReleaseNotes, "list").mockResolvedValue({ items: [], next_cursor: null });
    const create = vi.spyOn(ReleaseNotes, "create").mockImplementation(async (b) => row({ ...b, release_note_id: "new-1" }));
    ui(<WhatsNewConfig />);
    fireEvent.click(await screen.findByTestId("wn-new"));
    fireEvent.click(screen.getByTestId("wn-save"));
    expect(await screen.findByText("Проверьте отмеченные поля")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("wn-title-ru"), { target: { value: "Декабрь 2026" } });
    fireEvent.change(screen.getByTestId("wn-title-en"), { target: { value: "December 2026" } });
    const fill = (k: number, s: string) => {
      for (const l of ["ru", "en"]) {
        fireEvent.change(screen.getByTestId(`wn-item-${k}-title-${l}`), { target: { value: `${s} ${l}` } });
        fireEvent.change(screen.getByTestId(`wn-item-${k}-text-${l}`), { target: { value: `Текст ${s} ${l}` } });
      }
    };
    fill(0, "Первый");
    fireEvent.click(screen.getByTestId("wn-add-item"));
    fill(1, "Второй");
    fireEvent.change(screen.getByTestId("wn-item-1-link"), { target: { value: "watch" } });
    fireEvent.change(screen.getByTestId("wn-item-1-icon"), { target: { value: "radar" } });
    // порядок: второй — вверх
    fireEvent.click(screen.getByRole("button", { name: "Выше: Пункт 2" }));
    expect((screen.getByTestId("wn-item-0-title-ru") as HTMLInputElement).value).toBe("Второй ru");
    for (let k = 2; k < 6; k++) fireEvent.click(screen.getByTestId("wn-add-item"));
    expect(screen.getByTestId("wn-add-item")).toBeDisabled(); // 6 из 6
    for (let k = 5; k >= 2; k--) fireEvent.click(screen.getByTestId(`wn-remove-${k}`));
    fireEvent.click(screen.getByTestId("wn-save"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const body = create.mock.calls[0]![0];
    expect(body.title).toEqual({ ru: "Декабрь 2026", en: "December 2026" });
    expect(body.items.map((i) => [i.title.ru, i.link, i.icon])).toEqual([
      ["Второй ru", "watch", "radar"],
      ["Первый ru", null, null],
    ]);
    expect(body.slug).toMatch(/^\d{4}\.\d{2}/);
  });

  it("публикация — с подтверждением и причиной; без сохранения правок — нельзя", async () => {
    const list = vi.spyOn(ReleaseNotes, "list").mockResolvedValue({ items: [row()], next_cursor: null });
    const publish = vi.spyOn(ReleaseNotes, "publish").mockResolvedValue(row({ status: "published", version: 2, published_at: "2026-11-10T06:00:00.000Z" }));
    ui(<WhatsNewConfig />);
    await screen.findByTestId("wn-editor");
    fireEvent.change(screen.getByTestId("wn-title-ru"), { target: { value: "Ноябрь" } });
    expect(screen.getByTestId("wn-publish")).toBeDisabled();
    fireEvent.change(screen.getByTestId("wn-title-ru"), { target: { value: "Ноябрь 2026" } });
    expect(screen.getByTestId("wn-publish")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("wn-publish"));
    const dlg = await screen.findByTestId("wn-confirm");
    expect(dlg).toHaveTextContent("Опубликовать «Ноябрь 2026»?");
    expect(dlg).toHaveTextContent("Изменить её потом нельзя");
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Релиз ноября" } });
    list.mockResolvedValue({ items: [row({ status: "published", version: 2, published_at: "2026-11-10T06:00:00.000Z" })], next_cursor: null });
    fireEvent.click(within(dlg).getByRole("button", { name: "Опубликовать" }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith(row().release_note_id, 1, "Релиз ноября"));
    await waitFor(() => expect(screen.queryByTestId("wn-confirm")).toBeNull());
    // опубликованная — только просмотр, архив и «Новая на основе»
    expect(await screen.findByText(/Опубликованную или архивную заметку изменить нельзя/)).toBeInTheDocument();
    expect(screen.queryByTestId("wn-save")).toBeNull();
    expect(screen.getByTestId("wn-archive")).toBeInTheDocument();
    expect(screen.getByTestId("wn-copy")).toBeInTheDocument();
    expect(screen.getByTestId("wn-title-ru")).toBeDisabled();
  });

  it("ошибка домена в подтверждении — текст по коду, диалог открыт", async () => {
    vi.spyOn(ReleaseNotes, "list").mockResolvedValue({ items: [row()], next_cursor: null });
    vi.spyOn(ReleaseNotes, "publish").mockRejectedValue(new ApiError(409, { code: "RELEASE_NOTE_VERSION_CONFLICT", message: "x", details: { current_version: 2 } }));
    ui(<WhatsNewConfig />);
    fireEvent.click(await screen.findByTestId("wn-publish"));
    const dlg = await screen.findByTestId("wn-confirm");
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Релиз ноября" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Опубликовать" }));
    expect(await within(dlg).findByText("Заметку уже изменили — обновите список и проверьте её ещё раз")).toBeInTheDocument();
  });

  it("права: без config.edit — только чтение; без config.publish — кнопки публикации и архива заблокированы", async () => {
    vi.spyOn(ReleaseNotes, "list").mockResolvedValue({ items: [row()], next_cursor: null });
    const publish = vi.spyOn(ReleaseNotes, "publish");
    ui(<WhatsNewConfig />, ["config.read"]);
    await screen.findByTestId("wn-editor");
    expect(screen.getByTestId("wn-title-ru")).toBeDisabled();
    expect(screen.queryByTestId("wn-save")).toBeNull();
    expect(screen.getByTestId("wn-publish")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByTestId("wn-publish"));
    expect(screen.queryByTestId("wn-confirm")).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    expect(screen.getByTestId("wn-new")).toHaveAttribute("aria-disabled", "true");
  });

  it("XSS: разметка в заметке — текст в списке, редакторе и превью", async () => {
    const xss = '<img src=x onerror="window.__xss=1">';
    vi.spyOn(ReleaseNotes, "list").mockResolvedValue({ items: [row({ title: { ru: xss, en: xss }, items: [{ title: { ru: xss, en: xss }, text: { ru: xss, en: xss }, link: null, icon: null }] })], next_cursor: null });
    const { container } = ui(<WhatsNewConfig />);
    await screen.findByTestId("wn-editor");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("wn-preview")).toHaveTextContent(xss);
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it("тексты RU/EN — одинаковые ключи", () => {
    const keys = Object.keys(ru).filter((k) => k.startsWith("wn.") || k.startsWith("err.RELEASE_NOTE"));
    expect(keys.length).toBeGreaterThan(40);
    for (const k of keys) expect(en[k as keyof typeof en], k).toBeTruthy();
  });
});
