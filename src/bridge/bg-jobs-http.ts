/**
 * 点火即走的后台任务（/update、/restart-all）的 HTTP 侧：起进程、记账、按轮读日志。
 * 从 api-routes.ts 搬出（加 export；日志目录改用 LOG_DIR，不再手拼），给 api-routes 与 update-routes 共用。
 */
import { join } from "path";
import { REPO_ROOT } from "./config.js";
import { LOG_DIR } from "../lib/log-paths.js";
import { apiJson } from "./api-respond.js";
import { newRunId, loggedRunScript, sliceRunLog, isRunActive, RUN_ID_RE, type RunView } from "../lib/run-log.js";

// ── 点火即走的后台任务（/update、/restart-all）────────────────────────────
// 每次点火一个 runId，日志按轮切（lib/run-log.ts 有来由）。进行中的轮次再点火回 409：
// 两个 `manager restart --include-master` 并发会各建同名窗口、抢同一个 --resume。

export type BgJobKind = "update" | "restart-all";
const BG_JOB_STALE_MS: Record<BgJobKind, number> = {
  "update": 10 * 60_000,
  "restart-all": 20 * 60_000,
};
/** 本进程点着的轮次（外壳退出即清）。bridge 自己被 update 重启后这里是空的，改看日志。 */
const bgJobInflight = new Map<BgJobKind, string>();

export function bgJobLog(kind: BgJobKind): string {
  return join(LOG_DIR, `${kind}.log`);
}

async function readBgJob(kind: BgJobKind, runId?: string | null): Promise<RunView> {
  let txt = "";
  try { txt = await Bun.file(bgJobLog(kind)).text(); } catch { /* 还没跑过 */ }
  return sliceRunLog(txt, runId);
}

/** 正在进行的轮次 id（没有 = null）：先看本进程记账，再看日志（跨 bridge 重启） */
export async function activeBgJob(kind: BgJobKind): Promise<string | null> {
  const mine = bgJobInflight.get(kind);
  if (mine) return mine;
  const last = await readBgJob(kind);
  return isRunActive(last, Date.now(), BG_JOB_STALE_MS[kind]) ? last.runId : null;
}

export function spawnBgJob(kind: BgJobKind, label: string, managerArgs: string): string {
  const repoRoot = REPO_ROOT;
  const runId = newRunId();
  const script = loggedRunScript({
    runId,
    label,
    cmd: `"${process.execPath}" run "${repoRoot}/src/manager.ts" ${managerArgs}`,
    log: bgJobLog(kind),
  });
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // @ts-ignore Bun 支持 detached —— 不 detach 的话 bridge 被 reload / 抖一下会连坐杀掉它
    detached: true,
  });
  bgJobInflight.set(kind, runId);
  void proc.exited.finally(() => {
    if (bgJobInflight.get(kind) === runId) bgJobInflight.delete(kind);
  });
  return runId;
}

/** GET …/log：只回本轮（?run=<runId>；不带 = 最后一轮）+ 明确的完成态 */
export async function bgJobLogResponse(kind: BgJobKind, url: URL): Promise<Response> {
  const n = Math.min(Number(url.searchParams.get("tail") || 40) || 40, 200);
  const run = url.searchParams.get("run");
  if (run && !RUN_ID_RE.test(run)) return apiJson(400, { ok: false, error: "bad run id" });
  const v = await readBgJob(kind, run);
  const running = v.runId !== null && !v.done && (bgJobInflight.get(kind) === v.runId
    || isRunActive(v, Date.now(), BG_JOB_STALE_MS[kind]));
  return apiJson(200, {
    ok: true,
    lines: v.lines.slice(-n),
    runId: v.runId,
    found: v.found,
    running,
    done: v.done,
    exitCode: v.exitCode,
    result: v.result,
  });
}
