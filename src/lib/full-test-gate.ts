/**
 * 本机全量 bun test 的准入（docs/architecture/full-test-gate.md）：scripts/test.ts 是执行者，先经 lend-check-permit 拿名额，
 * 再把 bun test 起在自己的进程组里（经 GO_GATE 放行）、等整棵进程树（含脱组后代，full-test-gate-tree.ts）退出后释放。名额判定全在 lend-check-permit（排队、进程身份、批准核验），这里只接线：
 * 宿主策略 → 配置，进程表 → 进程树观察，排队提示 / 超时 / 信号 / 登记。
 * 排队超时或闸拒绝时返回 NOT_STARTED_EXIT，bun test 一律不启动——绝不退回裸跑，也不冒充测试结果。tests/full-test-gate-run.test.ts。
 */
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { classifyTestArgs, FULL_TEST_PERMIT_ENV, isCiEnv } from "./full-test-gate-args.js";
import { approvalVerifier, permitConfig, readGatePolicy, type GatePolicy } from "./full-test-gate-policy.js";
import { mergeTreeRecord, readTreeRecord, treePath, writeTreeRecord } from "./full-test-gate-record.js";
import {
  bootState, currentBoot, identify, liveTree, rememberTree, scanProcesses, type Boot, type LiveTree, type Scan, type TreeRoot,
} from "./full-test-gate-tree.js";
import { observeLendCheckProcess } from "./lend-check-observation.js";
import { lendCheckPermit, type LendCheckConfig, type LendCheckResult } from "./lend-check-permit.js";

/** 测试没启动（排队超时、闸拒绝、排队中被取消以外的失败）；与测试失败的 1 区分开 */
export const NOT_STARTED_EXIT = 75;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const SIGNAL_NO: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
const MINUTE = 60_000;
const ORPHAN_GRACE_MS = 60_000;

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
  /** bun test 退出后等整树后代退出的上限；超时不释放，进程退出后由下一个申请者经进程树确认回收 */
  drainMs?: number;
  /** 认得出的成员都没了、只剩认不出归属的孤儿（unclaimed）时，名额最多再保留多久（见 observeTree） */
  orphanGraceMs?: number;
  /** 运行期间扫进程表、把活成员落盘的间隔 */
  scanMs?: number;
  /** maxWaitMin 的一分钟有多长；只给测试缩短用 */
  minuteMs?: number;
  stderr?: (line: string) => void;
  probe?: Probe;
  /** 进程表；只给测试注入（如在登记窗口里杀掉自己） */
  scan?: Scan;
};

// ── 进程树（src/lib/full-test-gate-tree.ts）：bun test 起在独立进程组，脱组的后代按原始父进程 / 环境标记认，整树没了才算 absent；
// 记录的读写在 src/lib/full-test-gate-record.ts ──
/**
 * bun test 经这层 sh 启动：先从 fd 3 读到监管进程的放行行才 exec，读到 EOF（监管进程在登记完进程树之前就没了）直接退出、
 * 测试不启动。所以「spawning」记录 = 测试从没开始过，也再不会开始。
 */
const GO_GATE = 'IFS= read -r _ <&3 || exit 125; exec 3<&-; exec "$@"';

/**
 * 某个名额的检查树还在不在。没有记录 = 获准后还没走到起进程就没了；spawning = 放行行还没发出，测试没开始也不会再开始
 * （见 GO_GATE；名额只在持有者已死时才被回收，所以这时子进程只可能读到 EOF 退出）；坏记录、读不出进程表 = unknown（保留名额）。
 * 认得出的成员都没了、只剩认不出归属的孤儿：它可能是血缘断了的后代，也可能是本机别的程序（两者从进程表上分不出来），
 * 所以只从「成员都没了」那一刻（quietAt，落盘）起再保留 graceMs，之后按 absent——不拿外人当本次测试的永久存活证据。
 */
export function observeTree(dir: string, id: string, scan: Scan = scanProcesses, graceMs = ORPHAN_GRACE_MS, boot: () => Boot | null = currentBoot): Tree {
  return judgeTree(dir, id, { scan, graceMs, boot, write: true }).tree;
}

/**
 * observeTree 的判定加理由（sweep 列给人看）。write=false 只读：不落盘新成员 / 剪过的键、不记 quietAt（sweep dry-run 前后闸目录逐字节不变）。
 * 换了一次开机（或旧记录的根早于本次开机）= absent：旧号重启后都是系统进程；要比却读不出开机标识 = unknown
 */
function judgeTree(dir: string, id: string, o: { scan?: Scan; graceMs?: number; boot?: () => Boot | null; write?: boolean } = {}):
  { tree: Tree; why: string } {
  const graceMs = o.graceMs ?? ORPHAN_GRACE_MS;
  const tree = readTreeRecord(dir, id);
  if (tree === "missing") return { tree: "absent", why: "没有进程树记录（获准后没走到起进程）" };
  if (tree === null) return { tree: "unknown", why: "进程树记录读不出 / 格式不对" };
  if (tree.state === "spawning") return { tree: "absent", why: "spawning：放行行没发出，测试没开始也不会开始" };
  const { state: _, ...base } = tree;
  const boot = bootState(base, o.boot ?? currentBoot);
  if (boot === "other") return { tree: "absent", why: base.boot ? "登记于另一次开机" : "旧记录：根启动早于本次开机" };
  if (boot === "unknown") return { tree: "unknown", why: "读不出开机标识" };
  const procs = (o.scan ?? scanProcesses)();
  if (!procs) return { tree: "unknown", why: "读不出进程表" };
  const live = liveTree(base, procs);
  let updated = rememberTree(base, live);
  if (o.write) {
    const w = mergeTreeRecord(dir, id, base, updated);
    if (w.status === "corrupt") return { tree: "unknown", why: "进程树记录读不出 / 格式不对" };
    if (w.status === "missing") return { tree: "absent", why: "进程树记录已被持有者释放删除" };
    if (w.status !== "written") {
      console.error(`[full-test-gate] 写进程树记录失败：${w.status === "failed" ? w.error : "锁等不到"}`);
      return { tree: "unknown", why: "写进程树记录失败" };
    }
    updated = w.tree;
  }
  const keys = `pgid 键 ${live.pgids.length}、sid 键 ${live.sids.length}`;
  if (live.members.length) return { tree: "present", why: `还有成员 ${live.members.map((p) => p.pid).join(",")}（${keys}）` };
  if (!live.unclaimed.length) return { tree: "absent", why: `成员都已退出（${keys}）` };
  const quietAt = updated.quietAt ?? Date.now();
  if (Date.now() - quietAt < graceMs) return { tree: "present", why: `只剩认不出归属的进程 ${live.unclaimed.map((p) => p.pid).join(",")}，宽限内` };
  console.error(`[full-test-gate] 有无法归属的进程仍在，按宽限释放 id=${id}`);
  return { tree: "absent", why: "只剩认不出归属的进程，已过宽限" };
}

function signalPid(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(pid, sig); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") console.error(`[full-test-gate] 转发 ${sig} 失败：${String(e)}`);
  }
}

/** 只读看一眼 permit 库里的名额（status 命令和登记用的「当时在跑几个」）；读不出返回 null，不影响判定 */
export type PermitEntry = { id: string; orderId: string; workerId: string; status: string; owner?: { pid: number; start: string } };
export function readPermitEntries(dir: string): PermitEntry[] | null {
  return readPermitStore(dir)?.entries ?? null;
}

/** 只读读 permit 库里的策略与名额；库不存在 = 空；读不出返回 null */
function readPermitStore(dir: string): { policy: { mode: string; max: number | null; approval: string | null } | null; entries: PermitEntry[] } | null {
  const path = join(dir, "lend-check-permit.sqlite");
  if (!existsSync(path)) return { policy: null, entries: [] };
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout=200");
    const row = db.query("SELECT body FROM check_permit WHERE id=1").get() as { body: string } | null;
    const body = row ? JSON.parse(row.body) : {};
    return { policy: body.policy ?? null, entries: body.entries ?? [] };
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

/** 策略引用只在 on 档带 source：observe 一律按库里的 observe 缺省口径，policy.json 里留着的 source 不让在册登记时切档报 policy_conflict */
function permitPolicy(policy: GatePolicy): GatePolicy {
  return policy.mode === "on" ? policy : { ...policy, source: null };
}

type Admission = { kind: "registered"; policy: GatePolicy; waitedMs: number } | { kind: "unregistered"; mode: string };

class GateRun {
  private readonly id = `full-${randomUUID()}`;
  private readonly worktree: string;
  private readonly probe: Probe;
  private signal: NodeJS.Signals | null = null;
  private wake: () => void = () => {};
  private readonly scan: Scan;
  /** 起了 bun test 之后：根 + 上次扫到的活成员（登记了的同时落盘在 trees/<id>.json） */
  private tree: TreeRoot | null = null;
  /** 已 spawn、还没认出身份放行的那一小段：信号直接打给它（sh 还停在读放行行，测试不会启动） */
  private spawnedPgid: number | null = null;
  private registered = false;

  constructor(private readonly o: GateRunOptions, private readonly err: (line: string) => void) {
    this.worktree = o.cwd ?? process.cwd();
    this.probe = o.probe ?? observeLendCheckProcess;
    this.scan = o.scan ?? scanProcesses;
  }

  // 排队中：记下信号、叫醒排队循环去撤销；运行中：转发给整组和脱了组的后代（bun test 在独立进程组，终端的 Ctrl-C 到不了它）
  readonly onSignal = (sig: NodeJS.Signals): void => {
    const tree = this.tree;
    if (tree === null && this.spawnedPgid !== null) return signalPid(-this.spawnedPgid, sig);
    if (tree === null) {
      this.signal ??= sig;
      return this.wake();
    }
    signalPid(-tree.pgid, sig);
    // 只转给认得出的成员；认不出归属的孤儿（unclaimed）可能是别人的，不碰
    for (const p of this.track()?.members ?? []) if (p.pgid !== tree.pgid) signalPid(p.pid, sig);
  };

  /** 扫一遍进程表，更新（登记了的同时落盘）活成员；读不出进程表返回 null */
  private track(): LiveTree | null {
    const tree = this.tree;
    const procs = tree && this.scan();
    if (!tree || !procs) return null;
    const live = liveTree(tree, procs);
    const updated = rememberTree(tree, live);
    if (JSON.stringify(updated) !== JSON.stringify(tree)) {
      this.tree = updated;
      if (this.registered) {
        // 与观察者经同一个写入口合并：它们并进来的成员 / 键不被这里整份覆盖掉，并回内存里下次接着用
        const w = mergeTreeRecord(this.o.dir, this.id, tree, updated);
        if (w.status === "written") this.tree = w.tree;
        else this.err(`[full-test-gate] 写进程树记录失败：${w.status === "failed" ? w.error : w.status}`);
      }
    }
    return live;
  }

  private permit(action: "acquire" | "release" | "cancel", policy: GatePolicy): LendCheckResult {
    const request = {
      id: this.id, cost: "full" as const,
      orderId: this.worktree.slice(-1024) || "unknown",
      workerId: (this.o.env.CLAUDESTRA_AGENT || this.o.env.USER || "unknown").slice(0, 1024),
    };
    const deps = { verifyOwnerApproval: approvalVerifier(policy),
      observeCheckTree: (e: { id: string }) => observeTree(this.o.dir, e.id, this.scan, this.o.orphanGraceMs ?? ORPHAN_GRACE_MS) };
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
    let policy = permitPolicy(readGatePolicy(this.o.dir));
    for (const note of policy.notes) this.err(`[full-test-gate] ${note}`);
    let queued = false;
    let lastNotice = -Infinity;
    let failures = 0;
    for (;;) {
      if (this.signal) return this.withdraw(queued ? policy : null, `收到 ${this.signal}，已撤销排队`, exitCodeOf(null, this.signal));
      // 排上队之后沿用排队时的策略：中途换策略要等在册的申请都结束（lend-check-permit 的 policy_conflict），自己撤销也得用原策略
      if (!queued) policy = permitPolicy(readGatePolicy(this.o.dir));
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

  /**
   * 起 bun test（独立进程组）并等它退出。顺序：落盘 spawning → 起 GO_GATE 包着的 bun test（停在读放行行）→ 认出根的身份、
   * 落盘 running → 放行。中间任何一步本进程被 SIGKILL，子进程都读到 EOF、测试不启动。运行期间定时扫进程表、把活成员落盘
   */
  private async supervise(registered: boolean): Promise<number> {
    const path = treePath(this.o.dir, this.id);
    this.registered = registered;
    if (registered) writeTreeRecord(this.o.dir, this.id, { state: "spawning" });
    const child = spawn("/bin/sh", ["-c", GO_GATE, "full-test-gate", ...this.o.command], {
      stdio: ["inherit", "inherit", "inherit", "pipe"], detached: true, cwd: this.o.cwd,
      env: { ...this.o.env, [FULL_TEST_PERMIT_ENV]: registered ? this.id : "unregistered" },
    });
    const exited = waitChild(child);
    if (child.pid === undefined) {
      if (registered) unlinkSync(path); // 没起来：不留 spawning，名额照常释放
      return exited;
    }
    // exec 不改 PID、启动时刻和（macOS 的）唯一 ID，所以 sh 的身份就是 bun test 的。sh 停在读放行行，刚 spawn 还在 exec 的那一下读不到就再读；
    // 一直读不到只记 PID（成员按 PID 认，偏保守）
    this.spawnedPgid = child.pid;
    let self = identify(child.pid, this.scan);
    for (let i = 0; !self && i < 100; i++) { await sleep(10); self = identify(child.pid, this.scan); }
    // detached = setsid：sh 自己就是会话首进程，sid 键的首进程时刻就是它的
    const sid = self?.sid && self.sid > 1 ? self.sid : null;
    const tree: TreeRoot = { pgid: child.pid, start: self?.start ?? null, uniq: self?.uniq ?? null, ver: self?.ver ?? null,
      uid: self?.uid ?? process.getuid?.() ?? null, members: [], boot: currentBoot()?.id ?? null,
      pgids: [{ id: child.pid, leaderStart: self?.start ?? null }],
      sids: sid ? [{ id: sid, leaderStart: sid === child.pid ? self!.start : identify(sid, this.scan)?.start ?? null }] : [] };
    if (registered) writeTreeRecord(this.o.dir, this.id, { state: "running", ...tree });
    this.tree = tree;
    const gate = child.stdio[3] as Writable;
    gate.on("error", () => {}); // sh 已经没了（被信号杀掉）：exited 会报它的退出码
    gate.end("go\n");
    const timer = setInterval(() => this.track(), this.o.scanMs ?? 500);
    try { return await exited; } finally { clearInterval(timer); }
  }

  /** bun test 退出后等整树（含脱组后代）退出再释放；等不到就不释放，本进程退出后由下一个申请者经进程树确认回收 */
  private async finish(policy: GatePolicy): Promise<boolean> {
    const deadline = Date.now() + (this.o.drainMs ?? 10_000);
    const grace = this.o.orphanGraceMs ?? ORPHAN_GRACE_MS;
    const orphansExpired = () => this.tree?.quietAt !== undefined && Date.now() - this.tree.quietAt >= grace;
    const gone = (t: LiveTree | null) => t !== null && t.members.length === 0 && (t.unclaimed.length === 0 || orphansExpired());
    let live = this.track();
    while (!gone(live) && Date.now() < deadline) {
      await sleep(100);
      live = this.track();
    }
    if (live?.unclaimed.length && gone(live)) {
      this.err(`[full-test-gate] bun test 及认得出的后代都已退出；认不出归属的孤儿进程 ${live.unclaimed.map((p) => p.pid).join(",")} ` +
        `超过 ${Math.round(grace / 1000)}s 仍在，有无法归属的进程仍在，按宽限释放（不再算作本次测试）`);
    }
    if (!gone(live)) {
      const which = live === null ? "读不出进程表" : [
        live.members.length ? `还有后代进程 ${live.members.map((p) => p.pid).join(",")}` : "",
        live.unclaimed.length ? `有认不出归属、可能是它脱组后代的孤儿进程 ${live.unclaimed.map((p) => p.pid).join(",")}` : "",
      ].filter(Boolean).join("、");
      const until = live !== null && live.members.length === 0 ? `进程树确认退出（或认不出归属的孤儿超过 ${Math.round(grace / 1000)}s）后回收` : "进程树确认退出后回收";
      this.err(`[full-test-gate] bun test 已退出，但${which}；名额保留到${until}`);
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

export type SweepRow = { id: string; status: string; workerId: string; owner: string; tree: Tree | "-"; why: string; reclaimed?: boolean };
type SweepOptions = { apply?: boolean; scan?: Scan; boot?: () => Boot | null; probe?: Probe; graceMs?: number; workerId?: string };

function ownerState(probe: Probe, owner: PermitEntry["owner"]): string {
  if (!owner) return "未知";
  const seen = probe(owner.pid);
  if (seen.kind === "absent") return `已退出（pid ${owner.pid}）`;
  if (seen.kind === "unknown") return `读不出（pid ${owner.pid}）`;
  return seen.process.start === owner.start ? `在跑（pid ${owner.pid}）` : `已退出（pid ${owner.pid} 已被复用）`;
}

/**
 * `bun run test:gate sweep [--apply]`：逐条列在册登记的进程树判定。缺省只读，不写任何文件。
 * --apply 不另写释放逻辑，也不直接改库：用库里现行的策略发一次申请（lend-check-permit 申请时自带的死持有者回收：持有者已退出且
 * 树判 absent 才回收，present / unknown 不动），随即撤销 / 释放这次申请本身，再在 runs.jsonl 记一条 sweep。
 */
export function sweepGate(dir: string, o: SweepOptions = {}): { rows: SweepRow[]; result?: string } {
  const probe = o.probe ?? observeLendCheckProcess;
  const store = readPermitStore(dir);
  if (store === null) throw new Error("读不出 permit 库");
  const pendingOf = (entries: PermitEntry[]) => entries.filter((e) => e.status === "active" || e.status === "waiting");
  const rows: SweepRow[] = pendingOf(store.entries).map((e) => {
    const judged = e.status === "active" ? judgeTree(dir, e.id, { scan: o.scan, graceMs: o.graceMs, boot: o.boot }) : { tree: "-" as const, why: "排队中，没起过进程" };
    return { id: e.id, status: e.status, workerId: e.workerId, owner: ownerState(probe, e.owner), ...judged };
  });
  if (!o.apply || !rows.length || !store.policy) return { rows };
  // 沿用库里现行的策略（不是 policy.json）：sweep 只回收，不切档，也就不会因为还有 present 的登记撞 policy_conflict 而整笔回滚
  const stored = store.policy;
  const config: LendCheckConfig = { mode: stored.mode as "on" | "observe" };
  let verify: (a: NonNullable<LendCheckConfig["ownerApproval"]>) => boolean = () => false;
  if (stored.approval && stored.max !== null) {
    const [approvedBy, reference] = JSON.parse(stored.approval) as [string, string];
    config.ownerApproval = { maxConcurrentFullChecks: stored.max, approvedBy, reference };
    verify = (a) => a.approvedBy === approvedBy && a.reference === reference && a.maxConcurrentFullChecks === stored.max;
  }
  const deps = { verifyOwnerApproval: verify, observeCheckTree: (e: { id: string }) => observeTree(dir, e.id, o.scan, o.graceMs, o.boot) };
  const request = { id: `sweep-${randomUUID()}`, cost: "full" as const, orderId: "test:gate sweep", workerId: (o.workerId ?? process.env.USER ?? "unknown").slice(0, 1024) || "unknown" };
  const call = (action: "acquire" | "release" | "cancel") => {
    for (let i = 0; ; i++) {
      const r = lendCheckPermit({ directory: dir, config, action, request }, probe, deps);
      if (r.status !== "busy" || i >= 50) return r;
      Bun.sleepSync(20 + Math.random() * 80);
    }
  };
  const acquired = call("acquire");
  let result = `${acquired.status}${acquired.reasonCode ? `:${acquired.reasonCode}` : ""}`;
  if (acquired.status === "granted" || acquired.status === "observed" || acquired.status === "queued") {
    const settled = call(acquired.status === "queued" ? "cancel" : "release");
    result += ` → ${settled.status}${settled.reasonCode ? `:${settled.reasonCode}` : ""}`;
  }
  const after = readPermitEntries(dir);
  const still = new Set(after === null ? rows.map((r) => r.id) : pendingOf(after).map((e) => e.id));
  for (const row of rows) row.reclaimed = !still.has(row.id);
  logRun(dir, { event: "sweep", result, reclaimed: rows.filter((r) => r.reclaimed).map((r) => r.id), kept: rows.filter((r) => !r.reclaimed).map((r) => r.id) });
  return { rows, result };
}
