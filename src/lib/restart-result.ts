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

/** restart 结果里失败的 agent 名（「完成」消息只能列成功项，失败项要单独报）。 */
export function restartFailedNames(r: RestartRunOutcome): string[] {
  try {
    const parsed = JSON.parse(r.out || "");
    if (!Array.isArray(parsed?.results)) return [];
    return parsed.results
      .filter((x: any) => x && x.ok === false && typeof x.name === "string")
      .map((x: any) => x.name as string);
  } catch {
    return [];
  }
}

export type CanaryPlan =
  | { kind: "canary"; name: string }
  | { kind: "no-candidate" }
  | { kind: "list-failed"; reason: string };

/**
 * 升级重启波的金丝雀决策。「list 成功但没有可选的 agent」和「list 失败」必须分开：
 * 前者是真没 agent，跳过金丝雀无妨；后者是没验证过新版本能起就要进全量重启，
 * 以前两者都表现为 canary=undefined、静默跳过。
 */
export function canaryPlan(list: ListOutcome): CanaryPlan {
  if (!list.ok) return { kind: "list-failed", reason: list.reason };
  const c = list.agents.find((a) => a.status !== "stopped");
  return c ? { kind: "canary", name: c.name } : { kind: "no-candidate" };
}

export type ListOutcome =
  | { ok: true; agents: { name: string; status?: string }[] }
  | { ok: false; reason: string };

/**
 * `manager.ts list` 结果解读。失败必须是失败——launcher 以前 `if (!list.ok) return` 不留
 * 一行日志、`JSON.parse(out || "{}").agents || []` 把坏输出读成「零个 agent」，于是开机
 * 恢复 / 巡检静默不干活，金丝雀因为「找不到 agent」被跳过、直接进全量重启波。
 */
export function parseManagerList(r: RestartRunOutcome): ListOutcome {
  let parsed: any = null;
  try {
    parsed = JSON.parse(r.out || "");
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object") {
    if (parsed.ok === false) {
      return { ok: false, reason: typeof parsed.error === "string" && parsed.error ? parsed.error : "manager list 返回 ok:false" };
    }
    if (!Array.isArray(parsed.agents)) return { ok: false, reason: "manager list 输出缺少 agents 字段" };
    return { ok: true, agents: parsed.agents };
  }
  const tail = (r.err || "").split("\n").filter((l) => l.trim()).slice(-3).join(" ");
  return { ok: false, reason: tail || (r.ok ? "manager list 输出不是 JSON" : "manager list 非 0 退出且无输出") };
}
