import { describe, expect, test } from "bun:test";
import { buildFontCss, cleanFamily, normalizeFontPrefs, withGeneric } from "../web/lib/font-prefs-parse";

describe("cleanFamily", () => {
  test("strips structural characters and tidies the list", () => {
    expect(cleanFamily('  "PingFang SC" ,  Georgia;{} <b>, , serif\n')).toBe('"PingFang SC", Georgia b, serif');
  });
  test("empty in, empty out", () => {
    expect(cleanFamily("   ")).toBe("");
  });
});

describe("withGeneric", () => {
  test("appends a generic family when the list has none", () => {
    expect(withGeneric("PingFang SC", "sans-serif")).toBe("PingFang SC, sans-serif");
    expect(withGeneric("JetBrains Mono, Menlo", "monospace")).toBe("JetBrains Mono, Menlo, monospace");
  });
  test("leaves lists that already end with a generic family alone", () => {
    expect(withGeneric("Songti SC, serif", "serif")).toBe("Songti SC, serif");
    expect(withGeneric('Inter, "system-ui"', "sans-serif")).toBe('Inter, "system-ui"');
    expect(withGeneric("", "serif")).toBe("");
  });
});

describe("buildFontCss", () => {
  test("emits only the variables that are set, plus the chat serif rule", () => {
    const css = buildFontCss({ sans: "PingFang SC", serif: "", mono: "JetBrains Mono", chatSerif: true });
    expect(css).toBe(":root{--font-sans:PingFang SC, sans-serif;--font-mono:JetBrains Mono, monospace}\n#cstra-msgs{font-family:var(--font-serif)}");
  });
  test("chat serif alone still produces a rule; nothing set produces nothing", () => {
    expect(buildFontCss({ sans: "", serif: "", mono: "", chatSerif: true })).toBe("#cstra-msgs{font-family:var(--font-serif)}");
    expect(buildFontCss({ sans: "", serif: "", mono: "", chatSerif: false })).toBe("");
  });
});

describe("normalizeFontPrefs", () => {
  test("fills defaults and cleans stored strings", () => {
    expect(normalizeFontPrefs({ sans: "A;B", chatSerif: "yes" })).toEqual({ sans: "A B", serif: "", mono: "", chatSerif: false });
    expect(normalizeFontPrefs(null)).toEqual({ sans: "", serif: "", mono: "", chatSerif: false });
  });
});
