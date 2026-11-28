/**
 * Деньги и даты: целочисленный вывод тийинов («49 000 сум» / «49 000 soʻm», U+02BB), неразрывные пробелы, граничные
 * суммы (100 тийинов, 10¹¹), даты по Ташкенту; тексты UZ — латиница с U+02BB, ключи RU и UZ совпадают.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGES, translate } from "../src/i18n";
import { CURRENCY, NBSP, formatDate, formatDateTime, formatSum } from "../src/money";
import { parseRoute } from "../src/router";
import { loginErrorFromUrl } from "../src/App";

const sp = (s: string) => s.replaceAll(" ", NBSP);

describe("formatSum", () => {
  it("цены каталога спринта 8 (В2, В5)", () => {
    expect(formatSum(4_900_000, "ru")).toBe(sp("49 000 сум"));
    expect(formatSum(4_900_000, "uz")).toBe(sp("49 000 soʻm"));
    expect(formatSum(12_900_000, "ru")).toBe(sp("129 000 сум"));
    expect(formatSum(500_000, "ru")).toBe(sp("5 000 сум"));
    expect(formatSum(2_500_000, "uz")).toBe(sp("25 000 soʻm"));
  });

  it("границы: 1 сум, 10¹¹ тийинов (1 млрд сумов), тийины — после запятой", () => {
    expect(formatSum(100, "ru")).toBe(sp("1 сум"));
    expect(formatSum(100_000_000_000, "ru")).toBe(sp("1 000 000 000 сум"));
    expect(formatSum(1_500_050, "ru")).toBe(sp("15 000,50 сум"));
    expect(formatSum(1_500_005, "ru")).toBe(sp("15 000,05 сум"));
    expect(formatSum(0, "ru")).toBe(sp("0 сум"));
  });

  it("не целое, отрицательное, NaN, за пределом точности — ошибка, а не неверная сумма", () => {
    for (const bad of [49_000.5, -100, Number.NaN, Infinity, 2 ** 53]) expect(() => formatSum(bad, "ru")).toThrow(RangeError);
  });

  it("валюта UZ — U+02BB, не апостроф", () => {
    expect(CURRENCY.uz).toBe("soʻm");
    expect(CURRENCY.uz).not.toMatch(/['‘’`]/);
  });

  it("код сайта не считает деньги во float: нет toFixed, parseFloat, деления тийинов на 100 без остатка", () => {
    const src = ["money.ts", "pages/Buy.tsx", "pages/Home.tsx", "pages/Order.tsx", "pages/Orders.tsx"]
      .map((f) => readFileSync(resolve(import.meta.dirname, "../src", f), "utf8"))
      .join("\n");
    expect(src).not.toMatch(/toFixed|parseFloat|toLocaleString|Intl\.NumberFormat/);
    expect(src).not.toMatch(/tiyin\s*\/\s*100/);
  });
});

describe("даты (Ташкент, UTC+5)", () => {
  it("RU и UZ", () => {
    expect(formatDate("2026-12-10T00:00:00Z", "ru")).toBe("10 декабря 2026");
    expect(formatDate("2026-12-10T00:00:00Z", "uz")).toBe("10-dekabr 2026");
    // 20:00 UTC 31 декабря — в Ташкенте уже 1 января
    expect(formatDate("2026-12-31T20:00:00Z", "ru")).toBe("1 января 2027");
    expect(formatDateTime("2026-11-21T09:00:00Z", "ru")).toBe("21 ноября 2026, 14:00");
    expect(formatDate(null, "ru")).toBe("—");
    expect(formatDate("not a date", "uz")).toBe("—");
  });
});

describe("тексты", () => {
  it("RU и UZ — одинаковые ключи и подстановки; UZ: oʻ/gʻ только через U+02BB", () => {
    const ru = MESSAGES.ru;
    const uz = MESSAGES.uz;
    expect(Object.keys(uz).sort()).toEqual(Object.keys(ru).sort());
    for (const k of Object.keys(ru) as Array<keyof typeof ru>) {
      const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(vars(uz[k]), k).toEqual(vars(ru[k]));
      expect(uz[k], k).not.toMatch(/[oOgG]['‘’`ʼ]/);
    }
    expect(Object.values(uz).join(" ")).toContain("ʻ");
  });

  it("в текстах нет адресов, ссылок и упоминаний Stars (сайт — только сумы)", () => {
    for (const lang of ["ru", "uz"] as const) {
      const all = Object.values(MESSAGES[lang]).join("\n");
      expect(all).not.toMatch(/https?:\/\/|t\.me\/|www\./i);
      expect(all).not.toMatch(/stars|звёзд|yulduz/i);
    }
  });

  it("подстановка параметров", () => {
    expect(translate("ru", "buy.pay", { amount: "49 000 сум" })).toBe("Оплатить 49 000 сум");
    expect(translate("uz", "sub.minutes", { left: 5, granted: 300 })).toBe("SI daqiqalari: 300 dan 5 qoldi");
  });
});

describe("адреса сайта", () => {
  it("маршруты: только код товара и номер заказа", () => {
    expect(parseRoute("/")).toEqual({ name: "home" });
    expect(parseRoute("/buy/plus_30d")).toEqual({ name: "buy", code: "plus_30d" });
    expect(parseRoute("/orders")).toEqual({ name: "orders" });
    expect(parseRoute("/orders/1001")).toEqual({ name: "order", orderNo: 1001 });
    for (const bad of ["/orders/0", "/orders/abc", "/buy/PLUS", "/buy/../x", "/me", "/orders/1234567890123"]) {
      expect(parseRoute(bad), bad).toEqual({ name: "not_found" });
    }
  });

  it("login_error — только коды WebLoginError", () => {
    expect(loginErrorFromUrl("?login_error=account_not_found")).toBe("account_not_found");
    expect(loginErrorFromUrl("?login_error=auth_failed&x=1")).toBe("auth_failed");
    expect(loginErrorFromUrl("?login_error=%3Cscript%3E")).toBeNull();
    expect(loginErrorFromUrl("")).toBeNull();
  });
});
