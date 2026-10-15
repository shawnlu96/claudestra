/**
 * PMR-2 推送的定时器：每 5 分钟经 runManager 跑一次 `ledger pm-rails-tick`。判断、去重、落盘全在 CLI（manager/pm-rails-cmds.ts），
 * bridge 只负责按时叫；pmRails 没切 on 的项目 CLI 什么都不发，所以缺省（observe）下这里只是空转一条只读查询。
 */
const INTERVAL_MS = 5 * 60_000;
/** 启动后先等 bridge 自己的 notify 通道就绪 */
const FIRST_DELAY_MS = 120_000;

let started = false;

export function startPmRails(d: { runManager: (...args: string[]) => Promise<{ ok?: boolean; error?: string }> }): void {
  if (started) return;
  started = true;
  const tick = async () => {
    const r = await d.runManager("ledger", "pm-rails-tick").catch((e: Error) => ({ ok: false, error: e.message }));
    if (r?.ok === false) console.error(`⚠️ 人工干预推送这轮没跑成：${r.error ?? "未知错误"}`); // 下一轮重跑，状态没前进不会漏推
  };
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), INTERVAL_MS).unref?.();
  }, FIRST_DELAY_MS).unref?.();
}
