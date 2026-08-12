/**
 * v2.19.0 `manager.ts restart` 结果解读（纯逻辑，可单测）。
 *
 * 由来（peer 2026-08-13 P0）：launcher 的开机恢复波对每个 dead agent 调
 * `manager.ts restart <name>`，**返回值完全不检查**，失败也照打「restart 调用
 * 完成」。那次开机 9 个 restart 挂了 3 个——窗口建了、claude 从没启动、registry
 * 仍写 active，日志里一个字都没有，直到用户发消息没反应才发现。
 *
 * restart 一直都返回结构化结果，只是没人读：
 *   `{ ok: boolean, results: [{ name, ok, error? }], message }`
 * 这里把「怎么算失败、失败原因是什么」收敛成一个函数，让调用方无从忽略。
 */

export interface RestartRunOutcome {
  /** 进程退出码是否为 0 */
  ok: boolean;
  /** stdout（期望是 restart 的 JSON） */
  out: string;
  /** stderr（JSON 解析不出时的兜底信息来源） */
  err?: string;
}

/**
 * 返回失败原因；成功返回 null。
 *
 * 判据优先级：
 * 1. stdout 是合法 JSON 且 `ok === false` → 汇总 results 里所有失败项的 error；
 * 2. stdout 不是 JSON（进程被超时杀掉 / 崩在输出之前）→ 退出码说了算，取
 *    stderr 末几行当原因（空 stderr 也要给出可读文本，不能返回空串——空串会被
 *    调用方当成成功）。
 */
export function restartFailureReason(r: RestartRunOutcome): string | null {
  let parsed: any = null;
  try {
    parsed = JSON.parse(r.out || "");
  } catch {
    parsed = null;
  }

  if (parsed && typeof parsed === "object") {
    if (parsed.ok !== false) return null;
    const perItem = Array.isArray(parsed.results)
      ? parsed.results
          .filter((x: any) => x && x.ok === false)
          .map((x: any) => (typeof x.error === "string" && x.error ? x.error : "未知错误"))
      : [];
    if (perItem.length) return perItem.join("; ");
    return typeof parsed.error === "string" && parsed.error ? parsed.error : "未知错误";
  }

  if (r.ok) return null; // 退出码 0 且没给 JSON —— 按成功处理，别造假失败
  const tail = (r.err || "").split("\n").filter((l) => l.trim()).slice(-3).join(" ");
  return tail || "restart 进程非 0 退出且无输出";
}
