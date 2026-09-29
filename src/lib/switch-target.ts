/**
 * 切模型确认框「Yes, switch to X」的 X 和我们注入的 `/model <id>` 是不是同一个模型（纯函数）。单测 tests/switch-target.test.ts。
 * 只按家族比会把「请求 Sonnet 5」和「CC 提议 Sonnet 4.6」当成一回事代按（T41a r4 P1）——所以比到版本号，
 * 1M 上下文变体也算在内。认不出的写法（自定义 id、default 之类）返回 null，调用方据此不代按，只通知 owner。
 */

/**
 * 模型 id 或框里的显示名 → 规范键：`claude-sonnet-5` / `Sonnet 5` → `sonnet 5`，`claude-haiku-4-5-20251001` / `Haiku 4.5` → `haiku 4.5`，
 * `claude-opus-4-6[1m]` / `Opus 4.6 (1M context)` → `opus 4.6 1m`。别的后缀一律认不出（null），宁可让 owner 自己按。
 */
export function modelTargetKey(text: string): string | null {
  let s = text.trim().toLowerCase();
  let long = false;
  const suffix = s.match(/\s*(?:\[([^\]]+)\]|\(([^)]+)\))$/);
  if (suffix) {
    if (!/^1m(?: context)?$/.test((suffix[1] ?? suffix[2])!.trim())) return null;
    long = true;
    s = s.slice(0, suffix.index).trim();
  }
  s = s.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const m = s.match(/^(fable|opus|sonnet|haiku)[- ](\d{1,2})(?:[-.](\d{1,2}))?$/);
  if (!m) return null;
  return `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ""}${long ? " 1m" : ""}`;
}

/** 请求的模型和框里的目标是同一个：两边都认得出、规范键全等 */
export function sameModelTarget(requested: string, dialogTarget: string): boolean {
  const want = modelTargetKey(requested);
  return want !== null && want === modelTargetKey(dialogTarget);
}
