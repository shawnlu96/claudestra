/**
 * 给 daemon 的 console.log / error / warn 加 ISO timestamp 前缀。
 *
 * 只在 pm2 管的守护进程里调（bridge / launcher / cron）。
 * 不要在 manager.ts 里调 —— manager 通过 console.log 输出 JSON 供 master 解析，
 * 加 timestamp 会污染 JSON。
 *
 * 关键：**用函数调用，不要用 side-effect import**。因为 manager.ts 会从 cron.ts
 * 里 import 工具函数（loadJobs 等），如果 cron.ts 的 top-level 有 side-effect
 * import 这个模块，manager 进程的 console 也会被 wrap，JSON 输出被污染。
 *
 * 用法：daemon 入口 main() 或顶层（不是共享模块）里调一次 `enableTimestampLogs()`。
 */

let installed = false;

export function enableTimestampLogs(): void {
  if (installed) return;
  installed = true;

  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  const ts = () => `[${new Date().toISOString()}]`;

  console.log = (...a: unknown[]) => origLog(ts(), ...a);
  console.error = (...a: unknown[]) => origErr(ts(), ...a);
  console.warn = (...a: unknown[]) => origWarn(ts(), ...a);
}
