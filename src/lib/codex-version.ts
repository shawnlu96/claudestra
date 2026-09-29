/**
 * Codex agent 的版本（给 lib/update-hints.ts 与网页「更新并重启」用）：
 * - 已装：resolveCodexBinary 解析出 agent 实际启动的那份（不是 ask_codex 用的 ChatGPT.app 内置版），跑 `--version`；
 * - 运行：rollout 首行的 session_meta.cli_version 是**建线程**时的版本，resume 不会改（实测 0.153 建、0.158 续跑仍写 0.153），
 *   所以启动时（适配器 beforeLaunch）另记一笔到 <STATE_DIR>/codex-running/<agent>.json；
 * - npm 全局安装与否：决定能不能替用户跑 `npm install -g @openai/codex@latest`（brew 等只给文字提示）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeClaudeVersion } from "./claude-binary.js";
import { resolveCodexBinary } from "./codex-launch.js";
import { defaultRunner, type Runner } from "./codex-thread.js";
import { STATE_DIR } from "./paths.js";

/** npm 全局装的 @openai/codex：解析出的路径落在包目录里（bin/codex.js 壳，或包内的原生二进制） */
export function isNpmGlobalCodex(path: string | undefined): boolean {
  return !!path && /\/node_modules\/@openai\/codex\//.test(path);
}

export async function probeCodexInstall(run: Runner = defaultRunner): Promise<{ version?: string; npm: boolean } | null> {
  const found = await resolveCodexBinary(run);
  if (!found) return null;
  return { version: (await probeClaudeVersion(run, found.real)) ?? undefined, npm: isNpmGlobalCodex(found.real) };
}

export async function fetchLatestCodex(): Promise<string | undefined> {
  const r = await fetch("https://registry.npmjs.org/@openai/codex/latest", { signal: AbortSignal.timeout(10_000) });
  const j = (await r.json()) as { version?: unknown };
  return r.ok && typeof j.version === "string" ? j.version.trim() : undefined;
}

const runningPath = (agent: string, dir: string) => join(dir, "codex-running", `${agent}.json`);

/** 启动时记下这次用的版本；探不出来也写（空记录），免得沿用上一次启动的旧值误报「该重启」 */
export function recordCodexRunning(agent: string, version: string | undefined, dir: string = STATE_DIR): void {
  const p = runningPath(agent, dir);
  mkdirSync(join(dir, "codex-running"), { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify({ version, at: new Date().toISOString() }));
  renameSync(`${p}.tmp`, p);
}

export function readCodexRunning(agent: string, dir: string = STATE_DIR): string | undefined {
  try {
    const v = JSON.parse(readFileSync(runningPath(agent, dir), "utf8"))?.version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined; // 没记录（这个功能上线前启动的会话）/ 坏文件：不知道运行版本，只少一条「重启生效」提示
  }
}
