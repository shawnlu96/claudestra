/**
 * `manager restart --expect <json>`（i28-S1c）：监护拉起的重启在子进程拿到该 agent 的重启锁之后、碰窗口之前，按监护的同一套条件再核一次，
 * 不成立就跳过（不碰窗口，结果带 skipped 原因，监护照 skipped 记账、不占重启额度）。复核四条，读失败一律跳过：
 * 1. 还在监护名单里，会话、在途的活都没换（stillSupervised，与调度服务认领后的复核同一个判定，开关关了也算不在）；
 * 2. 再探一次活（同一个探测、同一个否定判据）仍是监护确认的那种否定，unknown = 跳过；
 * 3. 探活之后再核一次名单（探活要等，期间活可能交了）。
 * 不带 --expect 什么都不读，restart 行为不变。线格式见 lib/agent-supervisor-expect.ts；tests/restart-expect.test.ts。
 */
import { restoreSkip, type RestoreDeps, type RestoreRow } from "./restart-expect-restore.js";
import type { Database } from "bun:sqlite";
import { parseExpect } from "../lib/agent-supervisor-expect.js";
import { readActivity } from "../lib/agent-supervisor-activity.js";
import { downOf } from "../lib/agent-supervisor-judge.js";
import { lookAt, probeSupervised, type LookIo } from "../lib/agent-supervisor-probe.js";
import { readCallRows, readHeld, stillSupervised, type CallRow, type ScopeInput } from "../lib/agent-supervisor-scope.js";
import { LedgerReader } from "../lib/ledger-read.js";
import { readRegistryAgentsSync, type RegistryAgent } from "../lib/registry.js";
import { readSchedulerConfig, type SchedulerConfig } from "../lib/scheduler-config.js";

export interface RecheckDeps extends LookIo {
  /** 读不了就抛：抛 = 跳过 */
  config(): SchedulerConfig;
  registry(): RegistryAgent[];
  /** 台账只读连接；null = 没有台账（读不了），跳过 */
  db(): Database | null;
  calls(): CallRow[];
  held: ScopeInput["held"];
  close(): void;
}

interface ExpectSkip { name: string; ok: false; skipped: string; error: string }

/** 这个进程里按 --expect 复核通过、真的往下走去碰窗口的目标（manager 子进程一条命令一个进程） */
const passed = new Set<string>();

/** `--` 之前的 `--expect <json>`：没带 = undefined（restart 行为不变）；带了却没有值、或者没有用 `--` 指定一个名字 = ""（解析时整条拒） */
export function expectArg(args: string[]): string | undefined {
  const dd = args.indexOf("--");
  const head = dd < 0 ? args : args.slice(0, dd);
  const i = head.indexOf("--expect");
  if (i < 0) return undefined;
  return dd < 0 || !args[dd + 1] ? "" : (head[i + 1] ?? "");
}

function productionDeps(): RecheckDeps {
  const reader = new LedgerReader();
  return {
    config: () => readSchedulerConfig(),
    registry: () => readRegistryAgentsSync(),
    db: () => reader.get(),
    calls: () => readCallRows(),
    held: readHeld(),
    probe: probeSupervised,
    activity: (agent) => readActivity(agent),
    now: () => Date.now(),
    close: () => reader.close(),
  };
}

/** 按 expect 的四条核一遍：null = 前提还成立，可以重启；否则是跳过的原因 */
async function recheck(target: string, raw: string, deps: RecheckDeps): Promise<string | null> {
  const p = parseExpect(raw, target);
  if (!p.ok) return p.reason;
  const want = p.expect;
  const config = deps.config();
  const db = deps.db();
  if (!db) return "台账读不了";
  const scope = (): ScopeInput => ({ config, registry: deps.registry(), db, calls: deps.calls(), held: deps.held, now: deps.now() });
  const s = stillSupervised(scope(), want);
  if (!s) return "不在监护范围了（会话或在途的活变了，或监护已关）";
  const look = await lookAt(s, deps, (config.supervise?.stuckMin ?? 0) * 60_000);
  if (downOf(look)?.kind !== want.down) return `再探一次不是 ${want.down} 了（${look.liveness}${look.stuckSince === null ? "" : "，卡住"}）`;
  return stillSupervised(scope(), want) ? null : "探活期间不在监护范围了（会话或在途的活变了）";
}

/**
 * manager.ts cmdRestart 拿到重启锁之后一行调用：没带 --expect = null（照常重启）；带了就复核，不成立返回该 agent 的结果条目（跳过）。
 * 复核里任何读失败、异常都按跳过：宁可这次不重启（下一轮监护还会再看），不能在前提不明时动窗口。
 */
export async function expectSkip(target: string, raw: string | undefined, deps?: RecheckDeps, restore?: string, restoreDeps?: RestoreDeps, initial?: RestoreRow): Promise<ExpectSkip | null> {
  if (restore !== undefined) {
    const skip = await restoreSkip(target, restore, restoreDeps, initial);
    if (skip) return skip;
    if (raw === undefined) return passed.add(target), null;
  }
  if (raw === undefined) return null;
  const d = deps ?? productionDeps();
  let why: string | null;
  try {
    why = await recheck(target, raw, d);
  } catch (e) {
    why = `复核读失败：${(e as Error).message.slice(0, 200)}`;
  } finally {
    d.close();
  }
  if (!why) return passed.add(target), null;
  console.error(`[restart] ${target} 按 --expect 复核不重启：${why}`);
  return { name: target, ok: false, skipped: why, error: `已跳过（--expect 复核）：${why}` };
}

/**
 * 带 --expect 时，复核通过之前就被拒的结果都没碰窗口（做到一半的 create / rename / kill、registry 缺字段、另一个 restart 拿着锁、
 * 拿锁后复核前的异常）：一律改记 skipped，监护照 skipped 记账、不占重启额度。复核通过之后的失败照旧是失败；不带 --expect 原样返回。
 */
export function markExpectSkips<T extends { name: string; ok: boolean; error?: string; skipped?: string }>(results: T[], raw: string | undefined): T[] {
  if (raw === undefined) return results;
  return results.map((r) => (r.ok || r.skipped !== undefined || passed.has(r.name) ? r : { ...r, skipped: `复核前已拒：${r.error ?? "没有结果"}` }));
}

/** 带 --expect 时目标已经不在（registry 和窗口里都没有）：补一条该目标的 skipped 结果，不带就什么都不加（输出原样） */
export const expectMissing = (target: string, raw: string | undefined): { results?: ExpectSkip[] } =>
  raw === undefined ? {} : { results: [{ name: target, ok: false, skipped: `${target} 不存在`, error: `${target} 不存在` }] };
