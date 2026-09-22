/**
 * 「点火即走 + 轮询日志」类后台任务（POST /restart-all、POST /update）的日志分轮。
 *
 * 为什么要分轮（2026-09-23）：两个日志文件都是**追加写**，历次运行混在一起。
 * 旧 GET /…/log 直接取整文件末 40 行、前端用「有没有 `"ok"`」判完成，于是第二次
 * 全体重启 3 秒就读到**上一轮**的汇总行、误报完成、按钮复位，还能再点出一个并发的
 * `manager restart`。升级那边则是「已是最新」时 commit 不变，前端空转 10 分钟。
 *
 * 所以每次点火都带一个 runId，外壳脚本写「开始行 + 结束行」把这一轮框起来；
 * 读的时候只切本轮，完成与否看结束行 / manager 的结果 JSON，不再猜。
 */

/** 开始行：`=== run:<runId> <date> <label> ===`（日期由 shell 填，runId 是毫秒时间戳） */
const START_RE = /^=== run:(\d{1,16}) /;
/** 旧格式的开始行（无 runId）也要认，否则老日志里「最后一轮」会切错 */
const ANY_START_RE = /^=== (?!end )/;
/** 结束行：`=== end run:<runId> exit=<code> ===`——外壳在 manager 退出后写 */
const END_RE = /^=== end run:(\d{1,16}) exit=(-?\d+) ===$/;

export const RUN_ID_RE = /^\d{1,16}$/;

export function newRunId(now = Date.now()): string {
  return String(now);
}

/**
 * 外壳脚本：开始行 → manager → 结束行（带退出码）。不用 `exec`，否则结束行写不出来。
 * `cmd` 由调用方拼好（路径已加引号）；runId / label 只含安全字符，无需转义。
 */
export function loggedRunScript(opts: { runId: string; label: string; cmd: string; log: string }): string {
  if (!RUN_ID_RE.test(opts.runId)) throw new Error(`bad runId: ${opts.runId}`);
  if (!/^[\w .:-]+$/.test(opts.label)) throw new Error(`bad label: ${opts.label}`);
  return (
    `mkdir -p "$(dirname "${opts.log}")"; ` +
    `{ echo "=== run:${opts.runId} $(date '+%F %T') ${opts.label} ==="; ${opts.cmd}; ` +
    `echo "=== end run:${opts.runId} exit=$? ==="; } >> "${opts.log}" 2>&1`
  );
}

export interface RunView {
  /** 本轮的 runId；日志里没有新格式开始行（老日志）时为 null */
  runId: string | null;
  /** 找到了请求的那一轮（不带 runId 查询时 = 日志非空） */
  found: boolean;
  /** 本轮的输出行（不含开始/结束行） */
  lines: string[];
  /** 本轮已结束：见到结束行，或见到 manager 的结果 JSON（`{"ok":…}`） */
  done: boolean;
  exitCode: number | null;
  /** manager 打出的最后一个结果 JSON（带 ok 字段），供前端显示 error / message */
  result: { ok?: boolean; error?: string; message?: string; [k: string]: unknown } | null;
  /** 从 runId 反推的开始时间（毫秒）；老格式为 null */
  startedAt: number | null;
}

/**
 * 从整份日志里切出一轮。给了 runId 就找那一轮；没给就取最后一轮（刷新页面后
 * 用它回答「现在是不是正在跑」）。
 */
export function sliceRunLog(text: string, runId?: string | null): RunView {
  const all = text.split("\n").filter((l) => l.trim());
  let start = -1;
  if (runId) {
    for (let i = all.length - 1; i >= 0; i--) {
      const m = START_RE.exec(all[i]);
      if (m && m[1] === runId) { start = i; break; }
    }
    if (start < 0) {
      return { runId, found: false, lines: [], done: false, exitCode: null, result: null, startedAt: Number(runId) || null };
    }
  } else {
    for (let i = all.length - 1; i >= 0; i--) {
      if (ANY_START_RE.test(all[i])) { start = i; break; }
    }
  }
  const header = start >= 0 ? all[start] : "";
  const id = runId ?? START_RE.exec(header)?.[1] ?? null;

  // 本轮到下一轮开始行为止（给定 runId 时后面可能还有更新的轮次）
  let end = all.length;
  for (let i = start + 1; i < all.length; i++) {
    if (ANY_START_RE.test(all[i])) { end = i; break; }
  }
  const body = all.slice(start + 1, end);

  let exitCode: number | null = null;
  let sawEnd = false;
  let result: RunView["result"] = null;
  const lines: string[] = [];
  for (const l of body) {
    const m = END_RE.exec(l);
    if (m) {
      // 结束行只认本轮的；别的 runId 的结束行说明日志被并发写乱了，照原样显示
      if (!id || m[1] === id) { sawEnd = true; exitCode = Number(m[2]); continue; }
    }
    if (l.startsWith("{")) {
      try {
        const j = JSON.parse(l);
        if (j && typeof j === "object" && "ok" in j) result = j;
      } catch { /* 不是 JSON，当普通行 */ }
    }
    lines.push(l);
  }
  return {
    runId: id,
    found: runId ? true : all.length > 0,
    lines,
    done: sawEnd || result !== null,
    exitCode,
    result,
    startedAt: id ? Number(id) : null,
  };
}

/**
 * 这一轮是否还算「正在进行」：没结束、且没超过 staleMs（外壳被杀、结束行永远写不出来
 * 时靠它兜底，否则会永远拒绝下一次点火）。老格式（无 runId）一律不算进行中。
 */
export function isRunActive(v: RunView, now: number, staleMs: number): boolean {
  if (!v.found || v.done || v.startedAt === null) return false;
  return now - v.startedAt < staleMs;
}
