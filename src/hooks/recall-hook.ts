#!/usr/bin/env bun
/**
 * Claude Code Hook — SessionStart 记忆召回(v2.21.5+)
 *
 * startup / resume / clear / compact 时往开场 context 注入两段:
 *   1. HANDOFF.md —— 上次会话在本项目 auto-memory 目录留下的进度交接(save-compact 写,
 *      覆盖式,14 天内的才注入;compact 时跳过——压缩摘要比它新)。
 *   2. `## mem0 recall` —— ~/mem0-mcp/recall.py 按工作目录选出的最相关 + 最近记忆
 *      (agent-mem0 维护;直连 pgvector 不经 MCP,通常 <1s)。
 *
 * 铁律:永远 exit 0、永远不拖死会话启动——任何一段失败都静默略过,
 * recall.py 超过 10s 直接 kill。stdout 就是注入的文本(SessionStart 的 hook 契约)。
 * subagent(带 agent_id)不注入:它们的 context 是主会话派生的,重复灌只是浪费。
 *
 * 注册:setup.ts / manager install-cli / manager install-hooks(共用 lib/session-recall.ts)。
 */
import { existsSync, statSync, readFileSync } from "fs";
import {
  HANDOFF_MAX_AGE_DAYS,
  handoffPath,
  recallPythonPath,
  recallScriptPath,
} from "../lib/session-recall.js";

const RECALL_TIMEOUT_MS = 10_000;
const HANDOFF_MAX_CHARS = 6_000;

async function readHandoff(cwd: string): Promise<string> {
  try {
    const p = handoffPath(cwd);
    if (!existsSync(p)) return "";
    const st = statSync(p);
    const ageDays = (Date.now() - st.mtimeMs) / 86_400_000;
    if (ageDays > HANDOFF_MAX_AGE_DAYS) return "";
    let text = readFileSync(p, "utf-8").trim();
    if (!text) return "";
    if (text.length > HANDOFF_MAX_CHARS) text = text.slice(0, HANDOFF_MAX_CHARS) + "\n…(truncated)";
    // 本地时间——文件正文里 save-compact 写的也是本地时间,别一个 UTC 一个本地
    const d = st.mtime;
    const pad = (n: number) => String(n).padStart(2, "0");
    const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `## HANDOFF · 上次会话交接(写于 ${when},${Math.floor(ageDays)} 天前)\n${text}`;
  } catch {
    return "";
  }
}

async function runRecall(cwd: string): Promise<string> {
  const script = recallScriptPath();
  if (!existsSync(script)) return "";
  try {
    const proc = Bun.spawn([recallPythonPath(), script, "--cwd", cwd], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    // 超时链要闭合(Codex review 2026-09-06):python 卡在 DB 上时 SIGTERM 未必退,
    // 1s 后补 SIGKILL;两个定时器都在 finally 清。
    let killer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* 已退出 */ }
      killer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* 已退出 */ } }, 1_000);
    }, RECALL_TIMEOUT_MS);
    try {
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out.trim();
    } finally {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
    }
  } catch {
    return "";
  }
}

async function main() {
  let data: any = {};
  try {
    const input = await Bun.stdin.text();
    if (input.trim()) data = JSON.parse(input);
  } catch {
    /* 没有/坏的 stdin 也照跑——用 process.cwd() */
  }
  if (data?.agent_id) return;
  const cwd: string = typeof data?.cwd === "string" && data.cwd ? data.cwd : process.cwd();
  const source: string = typeof data?.source === "string" ? data.source : "";

  // HANDOFF 先写出去再等 recall——recall 超时/挂掉也不影响交接注入
  let wrote = false;
  if (source !== "compact") {
    const h = await readHandoff(cwd);
    if (h) { process.stdout.write(h + "\n"); wrote = true; }
  }
  const r = await runRecall(cwd);
  if (r) process.stdout.write((wrote ? "\n" : "") + r + "\n");
}

main()
  .catch(() => { /* 铁律:hook 失败不能影响会话 */ })
  .finally(() => process.exit(0));
