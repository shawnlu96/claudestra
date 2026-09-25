/**
 * 全局字体偏好的纯逻辑（无 import，tests/ 直测）：清洗用户输入的 font-family、拼覆盖 CSS。
 * 存储与注入在 lib/font-prefs.ts。
 *
 * 落点是 Tailwind 4 的三个主题变量 --font-sans / --font-serif / --font-mono：工具类 font-sans 等
 * 和 html 的默认字体(--default-font-family: var(--font-sans))都从这里取；它们定义在 @layer theme
 * 里，我们的覆盖不进 layer，天然胜出。会话正文衬线体只挂在 #cstra-msgs 上，不动其他区域。
 */
export interface FontPrefs {
  sans: string;
  serif: string;
  mono: string;
  /** 会话历史正文用衬线体（--font-serif） */
  chatSerif: boolean;
}

export const EMPTY_FONT_PREFS: FontPrefs = { sans: "", serif: "", mono: "", chatSerif: false };

export const GENERIC_FAMILIES = ["sans-serif", "serif", "monospace", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "cursive", "fantasy", "math", "emoji"];

/** 去掉能破坏声明块 / 导出 HTML 的字符与换行，压掉多余空白和空项。 */
export function cleanFamily(input: string): string {
  return input
    .replace(/[;{}<>\r\n\t\\]/g, " ")
    .split(",")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(", ");
}

/** 末尾没有通用族就补一个：用户只填「PingFang SC」时机器没装也能落到系统字体。 */
export function withGeneric(family: string, generic: "sans-serif" | "serif" | "monospace"): string {
  if (!family) return "";
  const last = family.split(",").pop()!.trim().toLowerCase().replace(/^["']|["']$/g, "");
  return GENERIC_FAMILIES.includes(last) ? family : `${family}, ${generic}`;
}

export function normalizeFontPrefs(raw: unknown): FontPrefs {
  const j = (raw ?? {}) as Partial<FontPrefs>;
  return {
    sans: typeof j.sans === "string" ? cleanFamily(j.sans) : "",
    serif: typeof j.serif === "string" ? cleanFamily(j.serif) : "",
    mono: typeof j.mono === "string" ? cleanFamily(j.mono) : "",
    chatSerif: j.chatSerif === true,
  };
}

export function isEmptyFontPrefs(p: FontPrefs): boolean {
  return !p.sans && !p.serif && !p.mono && !p.chatSerif;
}

export function buildFontCss(p: FontPrefs): string {
  const decls: string[] = [];
  const sans = withGeneric(cleanFamily(p.sans), "sans-serif");
  const serif = withGeneric(cleanFamily(p.serif), "serif");
  const mono = withGeneric(cleanFamily(p.mono), "monospace");
  if (sans) decls.push(`--font-sans:${sans}`);
  if (serif) decls.push(`--font-serif:${serif}`);
  if (mono) decls.push(`--font-mono:${mono}`);
  const parts: string[] = [];
  if (decls.length) parts.push(`:root{${decls.join(";")}}`);
  if (p.chatSerif) parts.push("#cstra-msgs{font-family:var(--font-serif)}");
  return parts.join("\n");
}
