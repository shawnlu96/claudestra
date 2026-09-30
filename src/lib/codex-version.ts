/**
 * Codex agent 的版本（给 lib/update-hints.ts 与网页「更新并重启」用）：
 * - 已装：resolveCodexBinary 解析出 agent 实际启动的那份（不是 ask_codex 用的 ChatGPT.app 内置版），跑 `--version`；
 * - 运行：rollout 首行的 session_meta.cli_version 是**建线程**时的版本，resume 不会改（实测 0.153 建、0.158 续跑仍写 0.153），
 *   所以另记一笔到 <STATE_DIR>/codex-running/<agent>.json：tmux 在适配器 beforeLaunch 里记；ACP 由宿主在每次起 codex-acp
 *   之前记（noteAcpCodexRunning），因为 app-server 是适配器按 CODEX_PATH 起的，适配器退避重起时跑的是那一刻磁盘上的版本；
 * - npm 全局安装与否：决定能不能替用户跑 `npm install -g @openai/codex@latest`（brew 等只给文字提示）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeClaudeVersion } from "./claude-binary.js";
import { resolveCodexBinary } from "./codex-launch.js";
import { defaultRunner, type Runner } from "./codex-thread.js";
import { STATE_DIR } from "./paths.js";
import { CODEX_ACP_PAIRS, CODEX_ACP_VERSION, codexPairsWithAdapter } from "./acp/install.js";

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

/** `codex --version` 的原始输出（如 "codex-cli 0.158.0"）→ "0.158.0" */
const parseCodexVersion = (out: string | undefined): string | undefined => out?.match(/(\d+\.\d+\.\d+)/)?.[1];

/**
 * ACP 宿主每次起适配器之前调：探 CODEX_PATH、记运行版本、不配套就告警。stub（沙箱）没有 codex，不探也不记——
 * manager 的 beforeLaunch 已先写了空记录，网页就不会拿上一次启动的旧值误报「该重启」。
 */
export function noteAcpCodexRunning(o: {
  agent: string;
  codexPath?: string;
  probe: (bin: string) => string;
  log: (msg: string) => void;
  dir?: string;
}): string | undefined {
  if (!o.codexPath) return undefined;
  let out = "";
  try { out = o.probe(o.codexPath).trim(); } catch (e) { o.log(`⚠️ 探不出 codex 版本：${String(e)}`); }
  if (!codexPairsWithAdapter(out)) {
    o.log(`⚠️ 本机 codex 是「${out || "读不出版本"}」，codex-acp ${CODEX_ACP_VERSION} 配套的是 ${CODEX_ACP_PAIRS}：升 codex 要连适配器一起手动对齐（docs/runtimes/codex-acp.md）`);
  }
  const v = parseCodexVersion(out);
  try { recordCodexRunning(o.agent, v, o.dir); } catch (e) { o.log(`⚠️ 记不下 codex 运行版本（网页少一条「重启生效」提示）：${String(e)}`); }
  return v;
}
