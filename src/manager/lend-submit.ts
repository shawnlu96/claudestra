/**
 * `manager lend submit <orderId> --verdict pass|changes|block --findings '<json>'|--findings-file <f> --report <f>`：出借 worker 交审查结论；
 * 写单（i28-R6）是 `lend submit <orderId> --summary-file <f> --self-check-file <f>`：交工作副本当前的 HEAD 与一行摘要、自查。
 * 逻辑与绑定规则在 lib/lend-submit.ts；这里只接真实依赖（registry、tmux 窗口、ps）。不过认主守卫：调用方是出借 worker 自己，
 * 它的环境是白名单（lib/runtimes/clean-env.ts），没有频道号可认；能不能交由 journal + 会话 + 进程祖先判。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LEND_JOURNAL_PATH, openLendJournal } from "../lib/lend-journal.js";
import { ancestorsIn, submitLendResult, submitLendWork, type SubmitterDeps } from "../lib/lend-submit.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { tmuxRaw, windowTarget } from "../lib/tmux-helper.js";
import { output } from "./core.js";
import { parseLedgerArgs } from "./ledger-identity.js";

const USAGE = "usage: lend submit <orderId> --verdict pass|changes|block (--findings '<json 数组>' | --findings-file <文件>) --report <报告文件>" +
  " | lend submit <orderId> --summary-file <一行摘要> --self-check-file <自查>（开工 / 修复单）";

async function ps(): Promise<string> {
  const proc = Bun.spawn(["ps", "-eo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

const realDeps: SubmitterDeps = {
  cwd: process.cwd(),
  pid: process.pid,
  agentSession: (agent) => readRegistryAgentsSync().find((a) => a.name === agent)?.sessionId,
  panePid: async (agent) => {
    const n = parseInt((await tmuxRaw(["list-panes", "-t", windowTarget(agent), "-F", "#{pane_pid}"])).trim().split("\n")[0] || "", 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  },
  ancestors: async (pid) => ancestorsIn(await ps(), pid),
  headOf: async (dir) => {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: dir, stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 ? out : null;
  },
};

/** 写单交活：两份文件读成文本（不从命令行收正文），交给 submitLendWork 核 */
async function submitWork(orderId: string, f: Record<string, string | undefined>): Promise<void> {
  let summary: string;
  let selfCheck: string;
  try {
    summary = readFileSync(resolve(f["summary-file"]!), "utf8");
    selfCheck = readFileSync(resolve(f["self-check-file"]!), "utf8");
  } catch (e) {
    return output({ ok: false, error: `读摘要 / 自查失败：${(e as Error).message}；${USAGE}` });
  }
  const db = openLendJournal();
  try {
    const r = await submitLendWork(db, orderId, { summary, selfCheck }, realDeps);
    output(r.ok ? { ok: true, duplicate: r.duplicate, message: r.duplicate ? "这份交付已经交过，不用再交" : "交付已记下，出借服务会推送、开 PR 并转给对方" } : r);
  } catch (e) {
    output({ ok: false, error: (e as Error).message });
  } finally { db.close(); }
}

export async function cmdLendSubmit(args: string[]): Promise<void> {
  const p = parseLedgerArgs(args, ["verdict", "findings", "findings-file", "report", "summary-file", "self-check-file"]);
  if ("error" in p) return output({ ok: false, error: `${p.error}；${USAGE}` });
  const [orderId] = p.pos;
  const f = p.flags;
  if (f["summary-file"] !== undefined || f["self-check-file"] !== undefined) {
    if (!orderId || p.pos.length !== 1 || !f["summary-file"] || !f["self-check-file"] || f.verdict || f.report || f.findings || f["findings-file"]) return output({ ok: false, error: USAGE });
    if (!existsSync(LEND_JOURNAL_PATH)) return output({ ok: false, error: "本机没有出借 journal：这台机器没在出借" });
    return submitWork(orderId, f);
  }
  if (!orderId || p.pos.length !== 1 || !f.verdict || !f.report || (f.findings === undefined) === (f["findings-file"] === undefined)) {
    return output({ ok: false, error: USAGE });
  }
  if (!existsSync(LEND_JOURNAL_PATH)) return output({ ok: false, error: "本机没有出借 journal：这台机器没在出借" });
  let findings: unknown;
  let report: string;
  try {
    findings = JSON.parse(f.findings ?? readFileSync(resolve(f["findings-file"]!), "utf8"));
    report = readFileSync(resolve(f.report), "utf8");
  } catch (e) {
    return output({ ok: false, error: `读结论失败：${(e as Error).message}；${USAGE}` });
  }
  const db = openLendJournal();
  try {
    const r = await submitLendResult(db, orderId, { verdict: f.verdict, findings, report }, realDeps);
    output(r.ok ? { ok: true, duplicate: r.duplicate, sha256: r.sha, message: r.duplicate ? "这份结论已经交过，不用再交" : "结论已记下，调度服务会转给对方" } : r);
  } catch (e) {
    output({ ok: false, error: (e as Error).message });
  } finally { db.close(); }
}
