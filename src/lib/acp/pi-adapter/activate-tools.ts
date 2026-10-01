/**
 * Pi 扩展：把「注册但默认不激活」的内建工具按能力档打开（0.99 的 codemode / tool_search）。
 *
 * 为什么需要它：`-e builtin:codemode` 只把扩展**注册**进 `getAllTools()`，**不进
 * `getActiveTools()`**（真机实测：加载后 active 仍只有 read/bash/edit/write）⇒ 光加载是空操作。
 * `--tools` 是整体替换（会把通道工具一起顶掉 ✗），写 settings 要动用户的全局配置 ✗，
 * 所以走扩展的 `pi.setActiveTools()`。
 *
 * 要激活的名字由能力档决定、经 `CLAUDESTRA_PI_ACTIVATE` 传进来（runtimes/pi-acp.ts 注入，
 * 适配器把 env 原样交给 pi）。读完立刻从 env 删掉：pi 的 bash 工具按 process.env 起子进程，
 * 留着等于把我们内部的开关给了模型（与 mcp-mount 同款处理）。
 * tests/pi-activate-tools.test.ts。
 */
export const ACTIVATE_ENV = "CLAUDESTRA_PI_ACTIVATE";

interface ActivateApi {
  on(event: "session_start", handler: (e: unknown, ctx: unknown) => unknown): void;
  getActiveTools?(): string[];
  getAllTools?(): unknown[];
  setActiveTools?(names: string[]): void;
}

/** 解析环境变量值（纯函数，便于单测）：去空、去重、排序 */
export function parseActivateList(raw: string | undefined): string[] {
  return [...new Set((raw || "").split(",").map((s) => s.trim()).filter(Boolean))].sort();
}

/** 该加哪些：只保留 pi 真有的工具（避免拿错名字去 setActiveTools），已在 active 里的不重复加 */
export function activationDelta(pi: ActivateApi, want: readonly string[]): string[] {
  const have = new Set(pi.getActiveTools?.() ?? []);
  // 拿不到全量清单（老版本没这个 API / 接口变了）就当"都有"：宁可多试一次，
  // 也不因为清单接口变化而静默不激活 —— 但**不要**把"没有 API"当成"清单为空"（那会把要激活的全滤掉）。
  const known = (() => {
    try {
      const all = pi.getAllTools?.();
      return all ? new Set(all.map((t) => String((t as { name?: unknown })?.name ?? t))) : null;
    } catch {
      return null;
    }
  })();
  return want.filter((n) => !have.has(n) && (!known || known.has(n)));
}

export default function activateTools(
  pi: ActivateApi,
  env: Record<string, string | undefined> = process.env,
): void {
  const want = parseActivateList(env[ACTIVATE_ENV]);
  if (!env[ACTIVATE_ENV]) return;
  delete env[ACTIVATE_ENV];
  if (!want.length || typeof pi.setActiveTools !== "function") return;
  pi.on("session_start", () => {
    try {
      const add = activationDelta(pi, want);
      if (add.length) pi.setActiveTools?.([...(pi.getActiveTools?.() ?? []), ...add]);
    } catch {
      /* 激活失败不影响通道收发（老版本没有 setActiveTools 时静默跳过） */
    }
  });
}
