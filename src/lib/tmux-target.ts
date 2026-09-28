/**
 * 目标串 → 窗口身份。`master:=x`（windowTarget）、手写的 `master:x`、裸 `x` 都归到 `x`；大总管窗口的名字（`master`，
 * 同 tmux-helper 的 MASTER_WINDOW_NAME）和它的 index `0` 归到同一个键——打断、抓取写 master:0，取消 AUQ 写 windowTarget("master")。
 * 按窗口记账的表（Esc 防双击节流的兜底、save-compact 守卫）用它作键，写法不同也算同一个窗口（tests/resumable-ops.test.ts、tests/esc-guard.test.ts）。
 */
export function windowKey(target: string): string {
  const i = target.indexOf(":");
  const w = i >= 0 ? target.slice(i + 1) : target;
  const name = w.startsWith("=") ? w.slice(1) : w;
  return name === "master" ? "0" : name;
}
