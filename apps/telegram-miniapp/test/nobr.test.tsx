import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoBreakHyphens } from "../src/ui/kit";

describe("NoBreakHyphens", () => {
  it("wraps hyphenated words so a heading never breaks after the hyphen", () => {
    const { container } = render(<h1><NoBreakHyphens text="Говорите по-английски с ИИ-коучем" /></h1>);
    const spans = [...container.querySelectorAll("span.nobr")].map((s) => s.textContent);
    expect(spans).toEqual(["по-английски", "ИИ-коучем"]);
    // «с» приклеен к следующему слову неразрывным пробелом — не висит в конце строки
    expect(container.textContent).toBe("Говорите по-английски с\u00A0ИИ-коучем");
  });

  it("keeps plain text and Uzbek apostrophes intact", () => {
    const { container } = render(<p><NoBreakHyphens text="AI-murabbiy bilan oʻqing — 10 daqiqa" /></p>);
    expect([...container.querySelectorAll("span.nobr")].map((s) => s.textContent)).toEqual(["AI-murabbiy"]);
    expect(container.textContent).toBe("AI-murabbiy bilan oʻqing — 10 daqiqa");
  });
});
