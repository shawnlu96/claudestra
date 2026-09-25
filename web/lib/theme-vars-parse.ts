/**
 * 自定义主题变量的纯逻辑：解析粘贴文本、拼覆盖 CSS。无任何 import，tests/ 直接测；
 * 存储与注入在 lib/theme-vars.ts。
 *
 * 只认 `--xxx: value` 行：daisyUI 5 的主题就是一组自定义属性，Tailwind 工具类全部解析成
 * var(--color-*)，覆盖变量即换肤；放行任意选择器等于让用户往页面注入 CSS。
 */
export interface ThemeVarsText {
  light: string;
  dark: string;
}

export type VarEntry = [name: string, value: string];

const DECL = /^\s*(--[A-Za-z0-9_-]+)\s*:\s*(.+?)\s*;?\s*$/;
// 值里不许出现能改写 CSS 结构或 HTML 的字符：`;{}` 会截断声明块，`<` 会在导出的 HTML 里提前关掉 <style>
const BAD_VALUE = /[;{}<]/;
// 生成器输出里的包装行，不算「忽略」
const WRAPPER = /^\s*(@plugin\b.*|\{|\}|\)|\/\*.*\*\/|name\s*:.*|default\s*:.*|prefersdark\s*:.*|color-scheme\s*:.*)\s*$/;

/** 从粘贴文本里提取 `--name: value` 声明；返回按出现顺序的变量和被忽略的非空行数。 */
export function parseThemeVars(text: string): { vars: VarEntry[]; ignored: number } {
  const vars: VarEntry[] = [];
  const seen = new Map<string, number>();
  let ignored = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = DECL.exec(line);
    if (!m) {
      if (!WRAPPER.test(line)) ignored++;
      continue;
    }
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    if (!value || BAD_VALUE.test(value)) {
      ignored++;
      continue;
    }
    const prev = seen.get(m[1]);
    if (prev !== undefined) vars[prev] = [m[1], value]; // 同名后写的赢，跟 CSS 一致
    else {
      seen.set(m[1], vars.length);
      vars.push([m[1], value]);
    }
  }
  return { vars, ignored };
}

function block(selector: string, vars: VarEntry[]): string {
  return `${selector}{${vars.map(([k, v]) => `${k}:${v}`).join(";")}}`;
}

/**
 * 生成覆盖样式。两套各自只在对应明暗下生效——浅色的不能落到 `:root` 上，否则深色里没另写的
 * 变量会漏用浅色值。选择器特异性 (0,2,0) 压过 daisyUI 自己的 `:root` / `[data-theme=x]` (0,1,0)。
 */
export function buildThemeCss(text: ThemeVarsText): string {
  const light = parseThemeVars(text.light).vars;
  const dark = parseThemeVars(text.dark).vars;
  const parts: string[] = [];
  if (light.length) {
    parts.push(block(':root[data-theme="light"]', light));
    parts.push(`@media (prefers-color-scheme: light){${block(':root:not([data-theme="dark"])', light)}}`);
  }
  if (dark.length) {
    parts.push(block(':root[data-theme="dark"]', dark));
    parts.push(`@media (prefers-color-scheme: dark){${block(':root:not([data-theme="light"])', dark)}}`);
  }
  return parts.join("\n");
}
