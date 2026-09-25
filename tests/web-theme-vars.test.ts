import { describe, expect, test } from "bun:test";
import { buildThemeCss, parseThemeVars } from "../web/lib/theme-vars-parse";

const GENERATOR_OUTPUT = `@plugin "daisyui/theme" {
  name: "mytheme";
  default: true;
  prefersdark: false;
  color-scheme: "light";
  --color-base-100: oklch(98% 0.01 250);
  --color-primary: oklch(60% 0.2 250);
  --color-primary-content: "#ffffff";
  --radius-field: 0.5rem;
  --depth: 1;
}`;

describe("parseThemeVars", () => {
  test("keeps only custom-property declarations from generator output", () => {
    const { vars, ignored } = parseThemeVars(GENERATOR_OUTPUT);
    expect(vars).toEqual([
      ["--color-base-100", "oklch(98% 0.01 250)"],
      ["--color-primary", "oklch(60% 0.2 250)"],
      ["--color-primary-content", "#ffffff"],
      ["--radius-field", "0.5rem"],
      ["--depth", "1"],
    ]);
    expect(ignored).toBe(0);
  });

  test("counts stray lines as ignored and rejects structural characters in values", () => {
    const { vars, ignored } = parseThemeVars(`
      .foo { color: red }
      --color-primary: red; }
      --color-accent: url(x) </style>
      --ok: blue
    `);
    expect(vars).toEqual([["--ok", "blue"]]);
    expect(ignored).toBe(3);
  });

  test("last duplicate wins, keeping first position", () => {
    const { vars } = parseThemeVars("--a: 1;\n--b: 2;\n--a: 3;");
    expect(vars).toEqual([
      ["--a", "3"],
      ["--b", "2"],
    ]);
  });
});

describe("buildThemeCss", () => {
  test("scopes light and dark blocks so one never leaks into the other", () => {
    const css = buildThemeCss({ light: "--color-primary: red", dark: "--color-primary: blue" });
    expect(css).toContain(':root[data-theme="light"]{--color-primary:red}');
    expect(css).toContain('@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--color-primary:red}}');
    expect(css).toContain(':root[data-theme="dark"]{--color-primary:blue}');
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--color-primary:blue}}');
    expect(css).not.toMatch(/^:root\{/m);
  });

  test("empty input yields empty css", () => {
    expect(buildThemeCss({ light: "", dark: "  \n" })).toBe("");
  });
});
