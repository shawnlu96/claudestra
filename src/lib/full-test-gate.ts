/**
 * 本机全量 bun test 的准入（docs/architecture/full-test-gate.md）：scripts/test.ts 是执行者，先经 lend-check-permit 拿名额，
 * 再把 bun test 起在自己的进程组里、等整组退出后释放。名额判定全在 lend-check-permit（排队、进程身份、批准核验），这里只接线：
 * 宿主策略 → 配置，进程组 → 进程树观察，排队提示 / 超时 / 信号 / 登记。
 * 排队超时或闸拒绝时返回 NOT_STARTED_EXIT，bun test 一律不启动——绝不退回裸跑，也不冒充测试结果。tests/full-test-gate-run.test.ts。
 */
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { classifyTestArgs, FULL_TEST_PERMIT_ENV, isCiEnv } from "./full-test-gate-args.js";
import { approvalVerifier, permitConfig, readGatePolicy, type GatePolicy } from "./full-test-gate-policy.js";
import { observeLendCheckProcess } from "./lend-check-observation.js";
import { lendCheckPermit, type LendCheckResult } from "./lend-check-permit.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

/** 测试没启动（排队超时、闸拒绝、排队中被取消以外的失败）；与测试失败的 1 区分开 */
export const NOT_STARTED_EXIT = 75;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const SIGNAL_NO: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
const MINUTE = 60_000;

type Env = Record<string, string | undefined>;
type Tree = "absent" | "present" | "unknown";
type Probe = typeof observeLendCheckProcess;
export type GateRunOptions = {
  /** `bun test` 之后的参数，用来判定全量 */
  args: string[];
  /** 真正要起的命令（生产是 [bun, "test", ...args]） */
  command: string[];
  env: Env;
  /** 宿主闸目录（fullTestGateDir()）；测试一律传临时目录 */
  dir: string;
  cwd?: string;
  pollMs?: number;
  noticeMs?: number;
  /** bun test 退出后等整组后代退出的上限；超时不释放，进程退出后由下一个申请者经进程树确认回收 */
  drainMs?: number;
  /** maxWaitMin 的一分钟有多长；只给测试缩短用 */
  minuteMs?: number;
  stderr?: (line: string) => void;
  probe?: Probe;
};

// ── 进程树：bun test 起在独立进程组（pgid = 它的 pid），整组没了才算 absent ──
const treeSchema = z.union([
  z.object({ state: z.literal("spawning") }).strict(),
  z.object({ state: z.literal("running"), pgid: z.number().int().positive(), start: z.string().nullable() }).strict(),
]);

function treePath(dir: string, id: string): string {
  return join(dir, "trees", `${id}.json`);
}

/**
 * 某个名额的检查树还在不在。没有记录 = 获准后还没走到起进程就没了，什么都没起；spawning = 正在起、拿不准，保留名额。
 * 组还在但组长 PID 已换成别的进程：POSIX 不会把仍是活进程组号的 PID 分给新进程，所以原来的组已经没了。
 */
export function observeTree(dir: string, id: string, probe: Probe = observeLendCheckProcess): Tree {
  const read = readJsonStateSync(treePath(dir, id));
  if (read.status === "missing") return "absent";
  if (read.status === "corrupt") return "unknown";
  const tree = treeSchema.safeParse(read.data);
  if (!tree.success || tree.data.state === "spawning") return "unknown";
  const { pgid, start } = tree.data;
  try { process.kill(-pgid, 0); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "absent";
    if (code !== "EPERM") return "unknown"; // EPERM：组里有进程，只是不归我们管
  }
  const leader = probe(pgid);
  return leader.kind === "present" && start !== null && leader.process.start !== start ? "absent" : "present";
}

function groupGone(pgid: number): boolean {
  try { process.kill(-pgid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pgid, sig); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") console.error(`[full-test-gate] 转发 ${sig} 失败：${String(e)}`);
  }
}

/** 只读看一眼 permit 库里的名额（status 命令和登记用的「当时在跑几个」）；读不出返回 null，不影响判定 */
export function readPermitEntries(dir: string): { id: string; orderId: string; workerId: string; status: string }[] | null {
  const path = join(dir, "lend-check-permit.sqlite");
  if (!existsSync(path)) return [];
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout=200");
    const row = db.query("SELECT body FROM check_permit WHERE id=1").get() as { body: string } | null;
    return row ? (JSON.parse(row.body).entries ?? []) : [];
  } catch (e) {
    console.error(`[full-test-gate] 读 permit 库失败（只影响登记里的并发数）：${String(e)}`);
    return null;
  } finally {
    db?.close();
  }
}

export function runLogPath(dir: string): string {
  return join(dir, "runs.jsonl");
}

function logRun(dir: string, record: Record<string, unknown>): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(runLogPath(dir), JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
  } catch (e) {
    console.error(`[full-test-gate] 写登记失败（不影响本次测试）：${String(e)}`);
  }
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? 128 + (SIGNAL_NO[signal ?? ""] ?? 1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 值得重试的结果：库忙，或 permit 读不出进程身份 / 打不开库（过载时 ps 超时就会这样，下一次通常就好） */
function transient(r: LendCheckResult): boolean {
  return r.status === "busy" || r.reasonCode === "store_or_identity";
}

/** 起子进程并等它退出；error（起不来）当 127 */
function waitChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once("error", (e) => { console.error(`[full-test-gate] 起 bun test 失败：${String(e)}`); resolve(127); });
    child.once("exit", (code, signal) => resolve(exitCodeOf(code, signal)));
  });
}

/**
 * 不占名额的调用（CI、带文件）：同一前台进程组直接跑，终端的 Ctrl-C 照常直达 bun test，这里只接住免得先于它退出；
 * kill 给本进程的 TERM / HUP 转给它
 */
async function runPlain(command: string[], env: Env, cwd?: string): Promise<number> {
  const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", env, cwd });
  const forward = (sig: NodeJS.Signals) => {
    if (sig === "SIGINT") return;
    try { child.kill(sig); } catch (e) { console.error(`[full-test-gate] 转发 ${sig} 失败：${String(e)}`); }
  };
  for (const s of SIGNALS) process.on(s, forward);
  try { return await waitChild(child); } finally { for (const s of SIGNALS) process.off(s, forward); }
}

export async function runFullTestGate(o: GateRunOptions): Promise<number> {
  // CI 短路：不读宿主策略、不碰 permit 库，与改前的 `bun test` 逐字一致（ci.yml 的 --shard 发现探针和日志格式都靠它）
  if (isCiEnv(o.env)) return runPlain(o.command, o.env, o.cwd);
  const err = o.stderr ?? ((line: string) => console.error(line));
  const run = classifyTestArgs(o.args);
  if (run.kind === "error") { err(`[full-test-gate] ${run.message}；测试未启动`); return 2; }
  // 子进程带上标记，tests/preload.ts 认出它就不再自己申请
  if (run.kind !== "full") return runPlain(o.command, { ...o.env, [FULL_TEST_PERMIT_ENV]: run.kind }, o.cwd);
  const ctx = new GateRun(o, err);
  for (const s of SIGNALS) process.on(s, ctx.onSignal);
  try { return await ctx.run(); } finally { for (const s of SIGNALS) process.off(s, ctx.onSignal); }
}

type Admission = { kind: "registered"; policy: GatePolicy; waitedMs: number } | { kind: "unregistered"; mode: string };

class GateRun {
  private readonly id = `full-${randomUUID()}`;
  private readonly worktree: string;
  private readonly probe: Probe;
  private signal: NodeJS.Signals | null = null;
  private wake: () => void = () => {};
  private pgid: number | null = null;

  constructor(private readonly o: GateRunOptions, private readonly err: (line: string) => void) {
    this.worktree = o.cwd ?? process.cwd();
    this.probe = o.probe ?? observeLendCheckProcess;
  }

  // 排队中：记下信号、叫醒排队循环去撤销；运行中：转发给整组（bun test 在独立进程组，终端的 Ctrl-C 到不了它）
  readonly onSignal = (sig: NodeJS.Signals): void => {
    if (this.pgid !== null) return signalGroup(this.pgid, sig);
    this.signal ??= sig;
    this.wake();
  };

  private permit(action: "acquire" | "release" | "cancel", policy: GatePolicy): LendCheckResult {
    const request = {
      id: this.id, cost: "full" as const,
      orderId: this.worktree.slice(-1024) || "unknown",
      workerId: (this.o.env.CLAUDESTRA_AGENT || this.o.env.USER || "unknown").slice(0, 1024),
    };
    const deps = { verifyOwnerApproval: approvalVerifier(policy), observeCheckTree: (e: { id: string }) => observeTree(this.o.dir, e.id, this.probe) };
    return lendCheckPermit({ directory: this.o.dir, config: permitConfig(policy), action, request }, this.probe, deps);
  }

  /** 撤销 / 释放：库忙、读本进程身份失败（机器过载时 ps 会超时）就重试，别的结果原样返回 */
  private async settle(action: "release" | "cancel", policy: GatePolicy): Promise<LendCheckResult> {
    for (let i = 0; ; i++) {
      const r = this.permit(action, policy);
      if (!transient(r) || i >= 100) return r;
      await sleep(r.status === "busy" ? 20 + Math.random() * 80 : 200);
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => { clearTimeout(t); resolve(); };
    });
  }

  async run(): Promise<number> {
    const admission = await this.admit();
    if (typeof admission === "number") return admission;
    const policy = admission.kind === "registered" ? admission.policy : null;
    if (this.signal) {
      if (policy) await this.settle("release", policy);
      this.err(`[full-test-gate] 测试未启动：收到 ${this.signal}`);
      return exitCodeOf(null, this.signal);
    }
    const startedAt = Date.now();
    const code = await this.supervise(policy !== null);
    if (!policy) return code;
    const released = await this.finish(policy);
    logRun(this.o.dir, { event: "end", id: this.id, mode: policy.mode, worktree: this.worktree, code, durationMs: Date.now() - startedAt, released });
    return code;
  }

  /** 排队直到获准；返回数字 = 不启动测试时的退出码 */
  private async admit(): Promise<Admission | number> {
    const startedAt = Date.now();
    const noticeMs = this.o.noticeMs ?? 30_000;
    let policy = readGatePolicy(this.o.dir);
    for (const note of policy.notes) this.err(`[full-test-gate] ${note}`);
    let queued = false;
    let lastNotice = -Infinity;
    let failures = 0;
    for (;;) {
      if (this.signal) return this.withdraw(queued ? policy : null, `收到 ${this.signal}，已撤销排队`, exitCodeOf(null, this.signal));
      // 排上队之后沿用排队时的策略：中途换策略要等在册的申请都结束（lend-check-permit 的 policy_conflict），自己撤销也得用原策略
      if (!queued) policy = readGatePolicy(this.o.dir);
      if (policy.mode === "off") return { kind: "unregistered", mode: "off" };
      const r = this.permit("acquire", policy);
      const waitedMs = Date.now() - startedAt;
      if (r.allowed && (r.status === "granted" || r.status === "observed")) {
        this.recordStart(policy, waitedMs, queued);
        return { kind: "registered", policy, waitedMs };
      }
      // 库忙、读不出进程身份（过载时 ps 超时）先重试；observe 遇到这些也返回 allowed（不阻塞的兜底），照样先重试，免得登记被挤掉
      failures = r.reasonCode === "store_or_identity" ? failures + 1 : 0;
      const retry = r.status === "busy" || (r.reasonCode === "store_or_identity" && failures < 10);
      if (r.allowed && !retry) {
        this.err(`[full-test-gate] observe 登记没成功（${r.reasonCode ?? r.status}），不阻塞，照常跑`);
        return { kind: "unregistered", mode: policy.mode };
      }
      if (r.status === "queued") {
        if (!queued) logRun(this.o.dir, { event: "queued", id: this.id, mode: policy.mode, max: policy.max, worktree: this.worktree, position: r.position });
        queued = true;
      } else if (!retry && r.status !== "policy_conflict") {
        return this.withdraw(queued ? policy : null, `全量测试闸拒绝（${r.reasonCode ?? r.status}：${r.reason ?? ""}）`, NOT_STARTED_EXIT);
      }
      if (waitedMs >= policy.maxWaitMin * (this.o.minuteMs ?? MINUTE)) {
        logRun(this.o.dir, { event: "timeout", id: this.id, mode: policy.mode, worktree: this.worktree, waitedMs });
        return this.withdraw(queued ? policy : null, `排队超过 ${policy.maxWaitMin} 分钟，已撤销排队`, NOT_STARTED_EXIT);
      }
      if (Date.now() - lastNotice >= noticeMs) {
        lastNotice = Date.now();
        const where = r.status === "queued" ? `队列位置=${r.position}` : r.status === "policy_conflict" ? "等策略切换（在册的申请跑完后生效）" : "permit 暂时不可用，重试中";
        this.err(`[full-test-gate] 排队中 mode=${policy.mode} max=${policy.max} ${where} 已等 ${Math.round(waitedMs / 1000)}s ` +
          `worktree=${this.worktree} id=${this.id}`);
      }
      await this.pause(r.status === "busy" ? 20 + Math.random() * 80 : (this.o.pollMs ?? 2000));
    }
  }

  private async withdraw(policy: GatePolicy | null, why: string, code: number): Promise<number> {
    if (policy) {
      const r = await this.settle("cancel", policy);
      if (r.status !== "cancelled" && r.status !== "closed") this.err(`[full-test-gate] 撤销排队没成功（${r.reasonCode ?? r.status}）`);
      logRun(this.o.dir, { event: "cancelled", id: this.id, mode: policy.mode, worktree: this.worktree, why });
    }
    this.err(`[full-test-gate] 测试未启动：${why}`);
    return code;
  }

  /** 登记谁、何时、当时在跑几个、on 档下会排第几（observe 档给 PM 估「开 on 会排多久」） */
  private recordStart(policy: GatePolicy, waitedMs: number, queued: boolean): void {
    const entries = readPermitEntries(this.o.dir);
    const running = entries?.filter((e) => e.status === "active").length ?? null;
    const others = running === null ? null : Math.max(0, running - 1);
    const wouldQueueAt = others === null ? null : others >= policy.max ? others - policy.max + 1 : 0;
    logRun(this.o.dir, { event: "start", id: this.id, mode: policy.mode, max: policy.max, worktree: this.worktree,
      workerId: this.o.env.CLAUDESTRA_AGENT || this.o.env.USER || null, running, wouldQueueAt, waitedMs });
    if (queued) this.err(`[full-test-gate] 获准 mode=${policy.mode} max=${policy.max}，等待 ${Math.round(waitedMs / 1000)}s`);
    else if (policy.mode === "observe" && wouldQueueAt) {
      this.err(`[full-test-gate] observe：同时在跑 ${running} 个全量，on 档（max=${policy.max}）下会排第 ${wouldQueueAt}；不阻塞`);
    }
  }

  /** 起 bun test（独立进程组）并等它退出 */
  private async supervise(registered: boolean): Promise<number> {
    const path = treePath(this.o.dir, this.id);
    if (registered) writeJsonAtomicSync(path, { state: "spawning" });
    const child = spawn(this.o.command[0]!, this.o.command.slice(1), {
      stdio: "inherit", detached: true, cwd: this.o.cwd, env: { ...this.o.env, [FULL_TEST_PERMIT_ENV]: registered ? this.id : "unregistered" },
    });
    const exited = waitChild(child);
    if (child.pid !== undefined) {
      this.pgid = child.pid;
      if (registered) {
        const seen = this.probe(child.pid);
        writeJsonAtomicSync(path, { state: "running", pgid: child.pid, start: seen.kind === "present" ? seen.process.start : null });
      }
    } else if (registered) unlinkSync(path); // 没起来：不留 spawning，名额照常释放
    return exited;
  }

  /** bun test 退出后等整组后代退出再释放；等不到就不释放，本进程退出后由下一个申请者经进程树确认回收 */
  private async finish(policy: GatePolicy): Promise<boolean> {
    const pgid = this.pgid;
    const deadline = Date.now() + (this.o.drainMs ?? 10_000);
    while (pgid !== null && !groupGone(pgid) && Date.now() < deadline) await sleep(100);
    if (pgid !== null && !groupGone(pgid)) {
      this.err(`[full-test-gate] bun test 已退出，但进程组 ${pgid} 里还有后代进程；名额保留到它们退出后回收`);
      return false;
    }
    const r = await this.settle("release", policy);
    if (r.status !== "released" && r.status !== "closed") {
      this.err(`[full-test-gate] 释放名额没成功（${r.reasonCode ?? r.status}）；本进程退出后由下一个申请者经进程树确认回收`);
      return false;
    }
    try { unlinkSync(treePath(this.o.dir, this.id)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.err(`[full-test-gate] 删进程树记录失败：${String(e)}`);
    }
    return true;
  }
}
