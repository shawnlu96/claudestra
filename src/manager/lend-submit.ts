/**
 * `manager lend submit <orderId> --verdict pass|changes|block --findings '<json>'|--findings-file <f> --report <f>`：出借 worker 交审查结论。
 * 逻辑与绑定规则在 lib/lend-submit.ts；这里只接真实依赖（registry、tmux 窗口、ps）。不过认主守卫：调用方是出借 worker 自己，
 * 它的环境是白名单（lib/runtimes/clean-env.ts），没有频道号可认；能不能交由 journal + 会话 + 进程祖先判。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LEND_JOURNAL_PATH, openLendJournal } from "../lib/lend-journal.js";
import { ancestorsIn, submitLendResult, type SubmitterDeps } from "../lib/lend-submit.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { tmuxRaw, windowTarget } from "../lib/tmux-helper.js";
import { output } from "./core.js";
import { parseLedgerArgs } from "./ledger-identity.js";

const USAGE = "usage: lend submit <orderId> --verdict pass|changes|block (--findings '<json 数组>' | --findings-file <文件>) --report <报告文件>";

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
};

export async function cmdLendSubmit(args: string[]): Promise<void> {
  const p = parseLedgerArgs(args, ["verdict", "findings", "findings-file", "report"]);
  if ("error" in p) return output({ ok: false, error: `${p.error}；${USAGE}` });
  const [orderId] = p.pos;
  const f = p.flags;
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
