/**
 * 目标串 → 窗口身份。`master:=x`（windowTarget）、手写的 `master:x`、裸 `x` 都归到 `x`：
 * 按窗口记账的表（Esc 防双击节流、save-compact 守卫）用它作键，写法不同也算同一个窗口（tests/tmux-target.test.ts）。
 */
export function windowKey(target: string): string {
  const i = target.indexOf(":");
  const w = i >= 0 ? target.slice(i + 1) : target;
  return w.startsWith("=") ? w.slice(1) : w;
}
