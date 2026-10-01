/**
 * Pi 能力档的**预设与内建扩展**（从 pi-env.ts 抽出：那个文件已顶到 400 行上限）。
 *
 * 这里回答两个问题：`builtin:<name>` 是什么、以及它要不要在会话里**激活**。
 * 0.99 的 `codemode` / `tool_search` 是「注册但不激活」：`-e builtin:codemode` 只让它出现在
 * `getAllTools()`，**不进 `getActiveTools()`**（真机实测：加载后 active 仍只有 read/bash/edit/write）。
 * 激活由 acp/pi-adapter/activate-tools.ts 扩展在 session_start 里做，名单经 CLAUDESTRA_PI_ACTIVATE 传。
 */
import type { PiEnvProfile } from "./pi-env.js";

/**
 * Pi 0.99 起的内建扩展。**`--no-extensions` 会把它们一起关掉**（0.99 之前只关"发现"，
 * 现在是连内建一起关）——所以 minimal 档想用其中任何一个，必须显式 `-e builtin:<name>`。
 * 参考 0.99 CHANGELOG：「--no-extensions also disables the built-in extensions… load one
 * explicitly with -e builtin:<name>」。
 */
const PI_BUILTIN_EXTENSIONS = ["mcp", "llama.cpp", "codemode", "tool-search"] as const;

/** `builtin:<name>` 形式的扩展源（Pi 自己的内建扩展，既不是包也不是路径） */
export function isBuiltinExtension(source: string): boolean {
  return /^builtin:[a-z0-9][a-z0-9.-]*$/i.test(source.trim());
}

/**
 * `builtin:<name>` → 需要在会话内**激活**的工具名。
 *
 * 0.99 的 `codemode` / `tool_search` 是「注册但默认不激活」：`-e builtin:codemode` 只让它
 * 出现在 `getAllTools()` 里，**不进 `getActiveTools()`**（真机实测：加载后 active 仍只有
 * read/bash/edit/write）⇒ 光加载 = 空操作。唯一安全途径是扩展里 `pi.setActiveTools()`：
 * `--tools` 是**整体替换**（会把通道工具一起顶掉 ✗），写 settings 又要动用户的全局配置 ✗。
 * 所以启动器把清单经环境变量交给 ACP 的 activate-tools 扩展去激活。
 *
 * `mcp` / `llama.cpp` 不在表内：MCP 的工具按服务器声明即激活（且 ACP 路径有 mcp-mount 自带连接器），
 * llama.cpp 是 provider。
 */
export function piActivateTools(env: PiEnvProfile | undefined): string[] {
  const out = new Set<string>();
  for (const src of env?.extensions ?? []) {
    const name = src.trim().toLowerCase().replace(/^builtin:/, "");
    if (name === "codemode") out.add("codemode");
    else if (name === "tool-search") out.add("tool_search");
  }
  return [...out].sort(); // 排序让环境变量值稳定（同一档案永远同一个字符串）
}

/**
 * 能力档案预设：把「base + 若干扩展」的常见组合起个名字，调用方不用手拼。
 * 只放**已验证有用**的组合（YAGNI）。
 */
const PI_ENV_PRESETS: Record<string, PiEnvProfile> = {
  // 0.99 的 codemode：模型写一段 JS 在沙箱里调其它工具，只有脚本输出进上下文。
  // base=minimal + 显式 builtin:codemode（--no-extensions 会把它一起关掉，必须显式给）。
  codemode: { base: "minimal", extensions: ["builtin:codemode"] },
};

export function piEnvPresetNames(): string[] {
  return Object.keys(PI_ENV_PRESETS);
}

/**
 * 取预设（大小写不敏感；未知名字返回 undefined，调用方负责报错）。
 * 必须查**自有属性**：普通对象取下标会把 `__proto__` / `constructor` / `toString` 这类
 * 原型链上的键当成真值 ⇒ 「未知预设」的检查被绕过，create 会把它展开成空档（= 继承全局），
 * pi-env-set 会接受却什么都不应用（PR349-r1-preset-prototype）。
 */
export function piEnvPreset(name: string): PiEnvProfile | undefined {
  const key = name.trim().toLowerCase();
  return Object.hasOwn(PI_ENV_PRESETS, key) ? PI_ENV_PRESETS[key] : undefined;
}