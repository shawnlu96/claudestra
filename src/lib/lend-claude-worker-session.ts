/**
 * 出借 Claude 会话接回原有 watcher / 归档 / 用量读取。worker 用出借方默认配置目录，会话落在 <配置目录>/projects/<clone 的 slug>；
 * 启动时把这个目录记进代次目录（RUN_RECORD_FILE），这里只读记录、不再推 slug（推 slug 的模块在 runtimes 环上）。
 * 旧版独立配置目录（<run>/config/projects）照样认，升级前起的 worker 收尾不丢会话。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { statePath } from "./paths.js";

export const CLAUDE_LEND_ROOT = statePath("lend", "claude-config");
export const RUN_RECORD_FILE = "run.json";
export interface ClaudeRunRecord { cwd: string; sessions: string }

const subdirs = (dir: string) => readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name));

/** 一个启动代次的会话所在目录：新布局 = 记录里的 projects/<slug> 目录，旧布局 = 独立配置目录下的各 slug 目录 */
export function claudeRunSessionDirs(run: string): string[] {
  const legacy = join(run, "config", "projects");
  const out = existsSync(legacy) ? subdirs(legacy) : [];
  const record = join(run, RUN_RECORD_FILE);
  if (existsSync(record)) {
    try {
      const sessions = (JSON.parse(readFileSync(record, "utf8")) as Partial<ClaudeRunRecord>).sessions;
      if (typeof sessions === "string" && sessions) out.push(sessions);
    } catch (e) {
      // 普通 agent 查会话也经这里（claude-code adapter），坏记录只丢这一代出借会话的定位，不能让所有查询抛错。
      console.error(`[lend] Claude 出借代次记录读不了（${run}）：${(e as Error).message}`);
    }
  }
  return out.filter((d) => existsSync(d));
}

export function claudeWorkerSessionPath(session: string, agent?: string): string | null {
  if (!/^[\w-]+$/.test(session) || !existsSync(CLAUDE_LEND_ROOT)) return null;
  const agents = agent ? [agent] : readdirSync(CLAUDE_LEND_ROOT);
  for (const name of agents.filter((n) => /^agent-lend-[\w-]+$/.test(n))) {
    const parent = join(CLAUDE_LEND_ROOT, name);
    if (!existsSync(parent)) continue;
    for (const run of subdirs(parent)) {
      for (const dir of claudeRunSessionDirs(run)) {
        const file = join(dir, `${session}.jsonl`);
        if (existsSync(file)) return file;
      }
    }
  }
  return null;
}
