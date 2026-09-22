/**
 * cwd → 会话 id 列举（按 runtime 适配器解析文件名）。
 *
 * 原先定义在 api-routes.ts，bridge.ts 为了 clear 轮转 / master watcher / 会话轮转自愈
 * 反向 import api-routes 拿这个非 API helper（D5-12）。挪到这里后两边都从这儿取，
 * 目录与「文件名 → id」规则仍然全部问 lib/runtimes 的适配器（sourceFor），本文件不另写正则。
 * import 时零副作用。
 */
import { statSync } from "fs";
import { sourceFor } from "../lib/runtimes/index.js";

/**
 * master 的最新 session id：master 不在 registry，从其 cwd 的
 * ~/.claude/projects/<slug>/ 目录里 probe mtime 最新的 jsonl。
 * bridge.ts 的 scheduleClearRotation 也用它（clear 轮转判重用）。
 */
export function latestSessionIdForCwd(cwd: string, runtime?: string): string | undefined {
  return listSessionIdsForCwd(cwd, runtime)[0];
}

/**
 * 列出 cwd 的 projects slug 目录里所有 session id（无序）。
 * clear 轮转用它做"clear 前快照 vs 之后新增"的集合 diff（M2）——同 cwd 多 agent
 * 共享一个 slug 目录，光取"最新 jsonl"会误认别人正在写的既有 session；只认领
 * 快照里没有的**新 sid**才不会串台。
 */
export function listSessionIdsForCwd(cwd: string, runtime?: string): string[] {
  // 目录与「文件名 → id」规则都问适配器（Pi 是 `<时间戳>_<id>.jsonl`，在 ~/.pi 下）——
  // 认错了 Pi 会话一旦 /new 轮转，watcher / 历史 / 归档会同时冻在旧文件上（与 CC 侧
  // maybeHealRotatedSession 注释里那个 7 天隐性故障同型）。
  const src = sourceFor(runtime);
  return src
    .listSessionsForCwd(cwd)
    .map((p) => {
      try {
        return { sid: src.sessionIdFromPath(p), mtime: statSync(p).mtimeMs };
      } catch {
        return null; // 列目录与 stat 之间被删
      }
    })
    .filter((e): e is { sid: string; mtime: number } => !!e?.sid)
    .sort((a, b) => b.mtime - a.mtime) // mtime 降序：调用方取 [0] 即最新
    .map((e) => e.sid);
}
