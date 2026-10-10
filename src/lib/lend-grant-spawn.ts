/**
 * 收回授权和起出借 worker 两边都「先写自己的、再读对方的」，任何交错下至少一方看得见另一方（规格 i28-W1「PM 已定（10-01 16:30）」）：
 * - 起：manager create 先写 registry 的 creating 占位（带 pid，create-guard.ts beginCreate）= 登记；建完频道、起 tmux 窗口前
 *   lendCreateDenied 现读 journal + lend.json，授权没了就不起（调用方走失败清理，撤占位和频道）。
 * - 收：lend revoke / 改授权写完 lend.json 后 stopRevokedWorkers 读 registry，授权已不覆盖的出借 worker 当场停：在途的 create 发 SIGTERM
 *   等它退出（信号清理撤占位、频道、窗口），再按名字关窗口、确认 no_window，revoke 返回前做完。tests/lend-grant-spawn.test.ts。
 */
import { archiveClaudeWorkerName } from "./lend-claude-worker-archive.js";
import { removeClaudeWorkerConfig } from "./lend-claude-worker.js";
import { Database } from "bun:sqlite";
import { isCodexEffort, isCodexModel, LEND_PATH, readLendSync } from "./lend-config.js";
import { existsSync } from "node:fs";
import { getOrder, LEND_JOURNAL_PATH, LIVE_STATES, type LendState } from "./lend-journal.js";
import { lendStopReason } from "./lend-watchdog.js";
import { isLendWorkerName } from "./runtimes/clean-env.js";
import type { WorkerLiveness } from "./worker-liveness.js";

/** 出借服务起 worker 时带给 manager create 的订单号（lend-deps.ts worker.create） */
export const LEND_ORDER_ENV = "CLAUDESTRA_LEND_ORDER";

/** choice = 这次 create 实际带的 --model / --effort（出借服务在父进程按当时的授权组好） */
export interface CreateGateOpts {
  env?: Record<string, string | undefined>; journal?: string; lendPath?: string; now?: number; choice?: { model?: string; effort?: string };
}

export const CHOICE_CHANGED = "出借 worker 不起：授权里的模型或推理档在起之前改了，本次不起，单子退回发起方重派，下次领单按新授权起";

/** 只读查这张单的 peer / 指纹（manager create 子进程里没有出借服务的 journal 连接）；读失败往外抛，由调用方按不起处理 */
function orderPeer(journal: string, orderId: string): { peer: string; fp: string | null; family: string } | null {
  const db = new Database(journal, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return (db.query("SELECT peer, fp, family FROM lend_orders WHERE orderId = ?").get(orderId) as { peer: string; fp: string | null; family: string } | null) ?? null;
  } finally { db.close(); }
}

const argsOf = (model: string | undefined, effort: string | undefined): string[] =>
  [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];

/**
 * manager create 起窗口前调（同步读，读完到建窗口之间不再看授权）：不是出借 worker → null；是出借 worker → 要带订单号、
 * 这个名字在 journal 里登记的正是这张单、单还在租约里、授权仍覆盖它（lend-watchdog.ts 同一套判定），否则返回不起的原因。
 */
export function lendCreateDenied(name: string, o: CreateGateOpts = {}): string | null {
  if (!isLendWorkerName(name)) return null;
  const order = (o.env ?? process.env)[LEND_ORDER_ENV];
  if (!order) return `${name} 是出借 worker，只能由出借服务带订单号起`;
  const journal = o.journal ?? LEND_JOURNAL_PATH;
  const lendPath = o.lendPath ?? LEND_PATH;
  const why = lendStopReason(name, journal, o.now ?? Date.now(), lendPath, order);
  if (why) return `出借 worker 不起：${why}`;
  // 收回闸口过了再比模型：父进程组参数之后、这里之前出借方改了模型 / 推理档，带着旧参数起就违背「按当下授权起」（tests/lend-grant-model.test.ts）
  let row: ReturnType<typeof orderPeer>;
  try { row = orderPeer(journal, order); } catch (e) { return `出借 worker 不起：读不了出借 journal（${(e as Error).message}）`; }
  if (!row) return `出借 worker 不起：journal 里没有单 ${order}`;
  return JSON.stringify(argsOf(o.choice?.model, o.choice?.effort)) === JSON.stringify((row.family === "claude" ? [] : choiceArgs(row.peer, row.fp, lendPath))) ? null : CHOICE_CHANGED;
}

/**
 * 起出借 worker 时给 manager create 追加的 --model / --effort（lend-deps.ts worker.create）：gate 之后、create 之前现读 lend.json，
 * 按 journal 里这张单的 peer / 指纹找授权条目——不用领单时的快照，也不看订单 / hello / beat 里对方说了什么（模型只由出借方在授权里定）。
 * 没授权 / 文件无效 / 指纹对不上 = 不加参数，起不起由 manager create 的 lendCreateDenied 现核；读出的值再核一遍字符集，参数按数组传。
 * tests/lend-grant-model.test.ts。
 */
export function lendModelArgs(db: Database, orderId: string, lendPath = LEND_PATH): string[] {
  const row = getOrder(db, orderId);
  return row?.family === "codex" ? choiceArgs(row.peer, row.fp, lendPath) : [];
}

/** 这个 peer 当下授权里的模型 / 推理档参数：出借服务组 create 参数和 manager create 最终闸口用同一个算法 */
function choiceArgs(peer: string, fp: string | null, lendPath: string): string[] {
  const read = readLendSync(lendPath);
  if (read.status !== "ok" || !read.file.enabled) return [];
  const e = read.file.lend.find((x) => x.peer === peer);
  if (!e || (fp && e.fp !== fp)) return [];
  return argsOf(isCodexModel(e.codexModel) ? e.codexModel : undefined, isCodexEffort(e.codexEffort) ? e.codexEffort : undefined);
}

/** registry 里的一个出借 worker；createPid = 还在建（creating 占位里记的 manager create 进程），正式条目没有 */
export interface LendWorkerSeen { name: string; createPid?: number }

export interface StopIo {
  /** registry 里所有 agent-lend-* 条目（含 creating 占位） */
  workers(): Promise<LendWorkerSeen[]>;
  /** 该停的原因；null = 授权仍覆盖这张单 */
  stopReason(name: string): string | null;
  /** 这个 pid 还活着、而且确实是给这个名字跑的 manager create（防 pid 复用误发信号） */
  isCreate(pid: number, name: string): boolean;
  signal(pid: number, sig: "SIGTERM" | "SIGKILL"): void;
  killWindows(name: string): Promise<void>;
  probe(name: string): Promise<WorkerLiveness>;
  /** 正式条目改成 stopped：窗口没了也别被 restart 之类拉回来 */
  markStopped(name: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface StopReport { stopped: string[]; unconfirmed: { name: string; why: string }[] }

/** create 收到信号后清理最多 10 秒就退出（create-guard.ts abortCreate）；多等一点，还在就 SIGKILL */
export const TERM_WAIT_MS = 12_000;
const KILL_WAIT_MS = 2_000;
const POLL_MS = 200;

async function waitExit(pid: number, name: string, io: StopIo, ms: number): Promise<boolean> {
  for (let t = 0; t < ms; t += POLL_MS) {
    if (!io.isCreate(pid, name)) return true;
    await io.sleep(POLL_MS);
  }
  return !io.isCreate(pid, name);
}

/**
 * 先让在途的 create 进程退出（之后它不会再建窗口），再关同名窗口并确认 no_window——正式条目和被 SIGKILL 的 create 留下的窗口都这样关。
 * 订单的账（stopped / 通知）不在这里记：调度服务下一轮按收回收尾时看到 worker 已不在。
 */
export async function stopRevokedWorkers(io: StopIo): Promise<StopReport> {
  const out: StopReport = { stopped: [], unconfirmed: [] };
  for (const w of await io.workers()) {
    if (!io.stopReason(w.name)) continue;
    const before = await io.probe(w.name);
    const creating = !!w.createPid && io.isCreate(w.createPid, w.name);
    // create 可能在首份窗口快照之后建窗并退出；确认它已退出后再读窗口，才能静默跳过。
    if (before === "no_window" && !creating && (await io.probe(w.name)) === "no_window") {
      await io.markStopped(w.name);
      continue;
    }
    if (w.createPid && creating) {
      io.signal(w.createPid, "SIGTERM");
      if (!(await waitExit(w.createPid, w.name, io, TERM_WAIT_MS))) {
        io.signal(w.createPid, "SIGKILL");
        await waitExit(w.createPid, w.name, io, KILL_WAIT_MS);
      }
    }
    // 关窗口前置 stopped：ACP 宿主据此（加上自己收到停止信号）认出是本机在收、回合中断不报失败（lib/acp/host.ts fail()）；也免得窗口没了被 restart 拉回来
    await io.markStopped(w.name);
    await archiveClaudeWorkerName(w.name);
    await io.killWindows(w.name);
    const left = await io.probe(w.name);
    if (left !== "no_window") {
      out.unconfirmed.push({ name: w.name, why: left === "unknown" ? "读不到 tmux，没法确认已退出" : "关窗口之后窗口还在" });
      continue;
    }
    removeClaudeWorkerConfig(w.name);
    out.stopped.push(w.name);
  }
  return out;
}

/**
 * 关掉的窗口在 journal 里有没有没结束的单（这个名字最新的一张在 LIVE_STATES）：有 = 停掉了在跑的活，没有 = 只是已结束单的残留窗口。
 * 只看 journal 不看窗口——窗口在不在说明不了单还在不在跑。journal 读不了按在跑算：宁可多说一句停掉，不把真在跑的说成残留。
 */
export function workerOrderLive(agent: string, journal = LEND_JOURNAL_PATH): boolean {
  if (!existsSync(journal)) return false;
  try {
    const db = new Database(journal, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      const row = db.query("SELECT state FROM lend_orders WHERE agent = ? ORDER BY createdAt DESC LIMIT 1").get(agent) as { state: LendState } | null;
      return !!row && LIVE_STATES.includes(row.state);
    } finally { db.close(); }
  } catch (e) {
    console.error(`[lend] 读 journal 判断 ${agent} 的单是否在跑失败，按在跑算：${(e as Error).message}`);
    return true;
  }
}

/** grant / revoke 输出里的那段：在跑被停的和残留窗口分开说，残留的不说「停掉」 */
export function stopReportText(r: StopReport, orderLive: (agent: string) => boolean): string {
  const live = r.stopped.filter((n) => orderLive(n));
  const left = r.stopped.filter((n) => !live.includes(n));
  return (live.length ? `；已停掉在跑的 ${live.length} 个：${live.join("、")}` : "") +
    (left.length ? `；清理了 ${left.length} 个已结束单的残留窗口：${left.join("、")}` : "") +
    (r.unconfirmed.length ? `；没能确认停掉：${r.unconfirmed.map((u) => `${u.name}（${u.why}）`).join("、")}` : "");
}

/** ps 看这个 pid 的命令行：是 manager.ts create <name> 才算（读失败 = 不是，不发信号；窗口照样按名字关） */
export function isCreateProcess(pid: number, name: string): boolean {
  if (!(pid > 0)) return false;
  try {
    const r = Bun.spawnSync(["ps", "-ww", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const cmd = r.stdout.toString();
    return r.exitCode === 0 && cmd.includes("manager.ts") && / create /.test(cmd) && cmd.includes(` ${name} `);
  } catch (e) {
    console.error(`[lend] 读进程 ${pid} 的命令行失败：${(e as Error).message}`);
    return false;
  }
}
