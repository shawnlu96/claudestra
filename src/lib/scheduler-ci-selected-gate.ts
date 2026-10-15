/**
 * Selected-CI releases require a matching receipt and effective mode on. Out-of-scope failures remain ledger repair facts.
 * The bridge atomically queues a non-urgent digest and its 24-hour notification key before acknowledging. Only then does the
 * scheduler record notified; failed sends and failed confirmation writes can safely retry across process restarts.
 * docs/architecture/ci-selected-gate.md, tests/scheduler-ci-selected-route.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { type CiSelectedMode, ciSelectedMode } from "./ci-selected-verdict.js";
import { type CiSelectedPort, type CiSelectedRead, type CiSelectedReceipt, ghCiSelectedPort, readCiSelectedReceipt,
  readCiSelectedRunReceipt } from "./ci-selected-receipt.js";
import { LedgerReader } from "./ledger-read.js";
import { type ObservedAction, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { runBounded } from "./run-bounded.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergeRun } from "./scheduler-merge.js";
import { isTestProcess } from "./test-guard.js";

const CI_SELECTED_KEY = "ciSelectedGate" as const;
export const CI_SELECTED_OBSERVE = "ci_selected_gate_observe";
export const CI_SELECTED_REPAIR = "ci_selected_repair";
export const CI_SELECTED_REPAIR_NOTIFIED = "ci_selected_repair_notified";
/** 撤销一条「已通知」认领：认领后通知没发出去 */
export const CI_SELECTED_REPAIR_UNSENT = "ci_selected_repair_unsent";
export const REPAIR_NOTIFY_MS = 24 * 3600_000;

const RANK: Record<CiSelectedMode, number> = { off: 0, observe: 1, on: 2 };
/** 有效档：仓库变量（不设 / 未知读作 observe）与恢复键中更严的一个。 */
export function effectiveSelectedMode(repoVariable: unknown, key: RecoveryMode): CiSelectedMode {
  const v = ciSelectedMode(repoVariable);
  return RANK[v] <= RANK[key] ? v : key;
}

export type SelectedDecision = { kind: "plain" } | { kind: "allow"; receipt: CiSelectedReceipt } | { kind: "red"; reason: string; observe: boolean };
const red = (reason: string, observe = false): SelectedDecision => ({ kind: "red", reason, observe });
/** 纯判定：没有放行标记 = plain（与改前一致）；有标记时只有核得上的放行回执 + 有效档 on 才 allow，其余一律红。 */
export function selectedDecision(read: CiSelectedRead, mode: CiSelectedMode): SelectedDecision {
  if (!read.marked) return { kind: "plain" };
  const r = read.receipt;
  if (!r) return red(`CI 带放行标记却没有核得上的回执（${read.problem ?? "读不出"}），缺证据不放行`);
  if (!r.allowed) return red(`放行回执不成立（CI 档 ${r.mode}，范围外失败 ${r.outOfScope.length} 条）`);
  if (mode === "on") return { kind: "allow", receipt: r };
  return red(`CI 按责任选集放行了 ${r.outOfScope.length} 条范围外失败，有效档 ${mode} 不接受`, mode === "observe");
}

/** 观察与待修的台账写口；合并 tick 绑定（bindCiSelectedSink），没绑定时只打日志。 */
export interface CiSelectedSink {
  observe(a: ObservedAction): Promise<void>;
  /** since 起登记、还没被「已通知」盖住的待修事实（同 key、没被「未送达」撤销的已通知认领在事实前 24 小时内或之后就算盖住） */
  pendingRepairs(project: string, since: number): PendingRepair[];
  notify(project: string, text: string, key: string, runUrl: string): Promise<void>;
}
export interface PendingRepair { target: string; key: string; file: string; name: string; runId: number; attempt: number; runUrl: string }
interface Ports { port: CiSelectedPort | null; policy: RecoveryPolicyPort; now: () => number; sink: CiSelectedSink | null }
let ghPort: CiSelectedPort | null = null;
const defaults = (): Ports => ({ port: isTestProcess() ? null : (ghPort ??= ghCiSelectedPort(runBounded)), policy: recoveryPolicy, now: Date.now, sink });
let sink: CiSelectedSink | null = null;
let over: Partial<Ports> = {};
const ports = (): Ports => ({ ...defaults(), ...over });
const said = new Set<string>();
const flushed = new Map<string, number>();
/** Tests: replace some ports until disposed. */
export function useCiSelectedPorts(next: Partial<Ports>): Disposable {
  const before = over;
  over = { ...before, ...next };
  said.clear(); flushed.clear();
  return { [Symbol.dispose]: () => { over = before; said.clear(); flushed.clear(); } };
}

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
const OBSERVED = (e: string, kind: string) => `${e}.kind='note' AND json_extract(${e}.data,'$.op')='recovery_observe'
  AND json_extract(${e}.data,'$.mechanism')='${CI_SELECTED_KEY}' AND json_extract(${e}.data,'$.kind')='${kind}'`;
/**
 * Pending facts have no successful intake confirmation of the same key in their preceding 24-hour window or later.
 * Legacy claim withdrawals remain readable; new confirmations are written only after the bridge has durably queued the notice.
 */
const PENDING_SQL = `SELECT e.target, e.data FROM events e WHERE e.project=? AND e.ts>=? AND ${OBSERVED("e", CI_SELECTED_REPAIR)}
  AND NOT EXISTS (SELECT 1 FROM events n WHERE n.project=e.project AND n.ts>=e.ts-${REPAIR_NOTIFY_MS} AND ${OBSERVED("n", CI_SELECTED_REPAIR_NOTIFIED)}
    AND json_extract(n.data,'$.key')=json_extract(e.data,'$.key')
    AND NOT EXISTS (SELECT 1 FROM events u WHERE u.project=n.project AND u.ts>=n.ts AND ${OBSERVED("u", CI_SELECTED_REPAIR_UNSENT)}
      AND json_extract(u.data,'$.claim')=json_extract(n.data,'$.claim'))) ORDER BY e.seq LIMIT 200`;
const pendingRow = (target: string, raw: string): PendingRepair | null => {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    return typeof d.key === "string" && typeof d.file === "string" && typeof d.name === "string" ? { target, key: d.key, file: d.file, name: d.name,
      runId: Number(d.runId), attempt: Number(d.attempt), runUrl: typeof d.runUrl === "string" ? d.runUrl : "" } : null;
  } catch { return null; } // 读不懂的事实不补送（只是台账里的一行，不影响合并）
};
/** 绑定写口的 pendingRepairs（只读查询；tests 直接对台账跑）。 */
export const pendingRepairsIn = (db: Database, project: string, since: number): PendingRepair[] =>
  (db.query(PENDING_SQL).all(project, since) as { target: string; data: string }[]).map((r) => pendingRow(r.target, r.data))
    .filter((r): r is PendingRepair => r !== null);
let reader: LedgerReader | null = null;
/** The pass's ledger connection is not handed here: reads (pending repairs) use the read-only reader, writes the leased manager. */
const readDb = () => {
  const db = (reader ??= new LedgerReader()).get();
  if (!db) throw new Error("台账读不了");
  return db;
};
/** One merge tick's writer (`using` in mergeTick), cleared when the tick ends so no later driver writes through it. */
export function bindCiSelectedSink(manager: Manager, assertActive: () => void): Disposable {
  const mine: CiSelectedSink = {
    observe: async (a) => {
      assertActive();
      const r = await manager("ledger", "scheduler-recovery-observe", a.target, "--mechanism", a.mechanism, "--action-key", a.actionKey,
        "--action", a.action, "--data", JSON.stringify(a.data ?? {}));
      if (r.ok !== true) throw new Error(String(r.error ?? "scheduler-recovery-observe 失败"));
    },
    pendingRepairs: (project, since) => pendingRepairsIn(readDb(), project, since),
    // Bridge owns the digest file: enqueue and deduplicate there, never from the scheduler process.
    notify: async (project, _text, key, runUrl) => {
      const { bridgeSend } = await import("./bridge-client.js");
      assertActive();
      const r = await bridgeSend({ type: "ci_selected_repair", project, key, runUrl }, { timeoutMs: 30_000,
        stillActive: () => { try { assertActive(); return true; } catch { return false; } } }); // lost lease means no new frame
      if (!r.ok) throw new Error(`待修摘要入队失败：${r.error}`);
    },
  };
  sink = mine;
  return { [Symbol.dispose]: () => { if (sink === mine) sink = null; } };
}

type Who = Pick<MergeRun, "project" | "taskId">;
const short = (s: string) => s.slice(0, 12);
const failText = (e: unknown) => (e as Error)?.message?.replace(/\s+/g, " ").slice(0, 200) ?? String(e);
const remember = (key: string): boolean => {
  if (said.has(key)) return false;
  if (said.size >= 500) said.clear();
  said.add(key);
  return true;
};

/** 一次写失败不改变合并路径的回答：打日志、答 false（调用方不确认去重，下次重试）；只有停手（租约丢了）才往外抛。没绑写口只记日志、答 true。 */
async function write(what: string, who: Who, f: (s: CiSelectedSink) => Promise<void>): Promise<boolean> {
  const s = ports().sink;
  if (!s) return console.log(`🧾 [ci-selected] ${who.taskId} ${what}（合并 tick 没有绑定台账写口，只记日志）`), true;
  try { await f(s); return true; } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [ci-selected] ${who.taskId} ${what}没写下（不影响合并判定，下次重试）：${failText(e)}`);
    return false;
  }
}
const once = async (key: string, f: () => Promise<boolean>): Promise<void> => {
  if (said.has(key)) return;
  if (await f()) remember(key);
};

const failures = (r: CiSelectedReceipt) => r.outOfScope.map((f) => `${f.file} > ${f.name}`).join("；").slice(0, 300);

/** observe：一条恢复观察，按 run + attempt + head 去重（进程内先挡一次，台账 dedup 再挡）。 */
async function noteObserve(who: Who, r: CiSelectedReceipt): Promise<void> {
  const actionKey = `observe.${r.runId}.${r.attempt}.${short(r.head)}`;
  await once(`${who.project} ${who.taskId} ${actionKey}`, () => write("放行观察", who, (s) => s.observe({ project: who.project, mechanism: CI_SELECTED_KEY, target: who.taskId, actionKey,
    action: `放行合并（run ${r.runId} attempt ${r.attempt}，head ${short(r.head)}，范围外失败：${failures(r)}）`,
    data: { kind: CI_SELECTED_OBSERVE, head: r.head, runId: r.runId, attempt: r.attempt, runUrl: r.runUrl, outOfScope: r.outOfScope, wouldAllow: true } })));
}

const repairKey = (file: string, name: string): string => createHash("sha256").update(`${file}\0${name}`).digest("hex").slice(0, 16);
/**
 * on 接受放行：每个范围外失败一条待修事实（全部写下才确认本次放行已登记），这次真登记了就立刻补送，否则按 10 分钟节流补送。
 * 不碰 CIF8 已知偶发清单、不开修复节点。
 */
async function registerRepairs(who: Who, r: CiSelectedReceipt): Promise<void> {
  const release = `${who.project} ${who.taskId} repair.${r.runId}.${r.attempt}`, fresh = !said.has(release);
  await once(release, () => write("待修登记", who, async (s) => {
    for (const f of r.outOfScope) {
      const key = repairKey(f.file, f.name);
      await s.observe({ project: who.project, mechanism: CI_SELECTED_KEY, target: who.taskId, actionKey: `repair.${key}.${r.runId}.${r.attempt}`,
        action: `登记待修：${f.file} > ${f.name}（run ${r.runId}）`.slice(0, 300),
        data: { kind: CI_SELECTED_REPAIR, key, file: f.file, name: f.name, runId: r.runId, attempt: r.attempt, runUrl: r.runUrl, head: r.head } });
    }
  }));
  if (fresh && said.has(release)) await flushRepairs(who);
  else await maybeFlush(who);
}

const FLUSH_MS = 10 * 60_000;
/** 只认 GitHub Actions 的 run 页地址（字符集卡死）；别的形状不进正文，只写 run 号 */
const RUN_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/;
/** Human-readable diagnostics for injected sinks; production sends structured key and URL to the bridge intake. */
const repairNotice = (ps: readonly PendingRepair[]): string => {
  const last = ps.at(-1)!, link = RUN_URL_RE.test(last.runUrl) ? last.runUrl : `run ${last.runId}`;
  return `[CI 放行待修] ${link} 待修键 ${last.key} 登记 ${ps.length} 次；文件与用例名在台账 ${CI_SELECTED_REPAIR} 事实里，进不进已知偶发清单、开不开修复节点由 PM 定`;
};
/** Queue first with a durable bridge-side key; a failed ledger confirmation must not cause a second digest entry. */
async function flushRepairs(who: Who): Promise<void> {
  const now = ports().now();
  flushed.set(who.project, now);
  await write("待修通知", who, async (s) => {
    let failed: unknown = null;
    const byKey = new Map<string, PendingRepair[]>();
    for (const p of s.pendingRepairs(who.project, now - REPAIR_NOTIFY_MS)) byKey.set(p.key, [...byKey.get(p.key) ?? [], p]);
    for (const [key, ps] of byKey) {
      const last = ps.at(-1)!;
      try {
        await s.notify(who.project, repairNotice(ps), key, last.runUrl);
        await s.observe({ project: who.project, mechanism: CI_SELECTED_KEY, target: last.target,
          actionKey: `notified.${key}.${last.runId}.${last.attempt}`,
          action: `待修已入 PM 摘要：${last.file} > ${last.name}（run ${last.runId}）`.slice(0, 300),
          data: { kind: CI_SELECTED_REPAIR_NOTIFIED, key, file: last.file, name: last.name, runId: last.runId,
            attempt: last.attempt, runUrl: last.runUrl, facts: ps.map((p) => ({ target: p.target, runId: p.runId, attempt: p.attempt })) } });
      } catch (e) {
        if (e instanceof SchedulerStopped) throw e;
        failed ??= e; // pending remains durable; the bridge's persisted key makes a retry safe even after a lost acknowledgement
      }
    }
    if (failed) throw failed;
  });
}
/** 合并 tick 里顺带补送：绑了写口才做，每个项目最多 10 分钟一次；补送失败只打日志，不影响这次 inspect 的回答。 */
async function maybeFlush(who: Who): Promise<void> {
  if (!ports().sink) return;
  if (ports().now() - (flushed.get(who.project) ?? -Infinity) < FLUSH_MS) return;
  await flushRepairs(who);
}

/** 有效档：仓库变量读不出时按 off（最严）；恢复键读不出时 recoveryPolicy 自己答 off。 */
async function modeOf(port: CiSelectedPort, repo: string, project: string): Promise<CiSelectedMode> {
  const key = ports().policy(project, CI_SELECTED_KEY);
  try { return effectiveSelectedMode(await port.variable(repo), key.source === "error" ? "off" : key.mode); }
  catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [ci-selected] ${repo} 仓库变量读不出，按 off：${failText(e)}`);
    return "off";
  }
}

/** 读一次、判一次、记该记的；"wait" = GitHub 读不出，这一轮不当绿也不当红。 */
async function decide(who: Who, repo: string, read: () => Promise<CiSelectedRead>): Promise<SelectedDecision | "wait"> {
  const port = ports().port;
  if (!port) return { kind: "plain" };
  let got: CiSelectedRead;
  try { got = await read(); } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [ci-selected] ${who.taskId} 放行回执读不出，本轮等：${failText(e)}`);
    return "wait";
  }
  if (!got.marked) return { kind: "plain" };
  const d = selectedDecision(got, await modeOf(port, repo, who.project));
  if (d.kind === "red") console.log(`🧾 [ci-selected] ${who.taskId} run ${got.runId ?? "?"} 当红：${d.reason}`);
  if (d.kind === "red" && d.observe && got.receipt) await noteObserve(who, got.receipt);
  if (d.kind === "allow") await registerRepairs(who, d.receipt);
  return d;
}

const repoOf = (prRef: string): string | null => /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/.exec(prRef)?.[1] ?? null;
const allGreen = (checks: PrSnapshot["checks"]) => checks.length > 0 && checks.every((c) => c.bucket === "pass" || c.bucket === "skipping");
/** 把这次 run 的检查（必需的、或链接指向这个 run 的）改记成 bucket：fail 走现有 ci_fail，pending 让驱动这一轮等。 */
function mark(checks: PrSnapshot["checks"], required: string, bucket: "fail" | "pending", runId?: number): PrSnapshot["checks"] {
  const names = required.split(","), runPath = runId ? `/actions/runs/${runId}/` : null;
  return checks.map((c) => names.includes(c.name) || (runPath && c.link?.includes(runPath)) ? { ...c, bucket } : c);
}

/**
 * 合并驱动的一行接线（driveMerge）：全绿的快照才去读回执。只包 gh 版 external（mergeExternal 标了 ciSelected）；注入的 external
 * （测试世界）和没有端口（测试进程没注入）时原样返回同一个对象，不碰 GitHub。
 */
export function withCiSelectedGate(base: MergeExternal, run: Pick<MergeRun, "project" | "taskId" | "requiredChecks">): MergeExternal {
  if (base.ciSelected !== true || !ports().port) return base;
  const inspect = base.inspect.bind(base);
  return { ...base, async inspect(prRef) {
    const pr = await inspect(prRef), repo = repoOf(prRef), port = ports().port;
    await maybeFlush(run);
    if (!repo || !port || pr.state !== "OPEN" || !allGreen(pr.checks)) return pr;
    let runId: number | undefined;
    const d = await decide(run, repo, async () => { const r = await readCiSelectedReceipt(port, repo, pr.head); runId = r.runId; return r; });
    if (d === "wait") return { ...pr, checks: mark(pr.checks, run.requiredChecks, "pending") };
    return d.kind === "red" ? { ...pr, checks: mark(pr.checks, run.requiredChecks, "fail", runId) } : pr;
  } };
}

/** ci-full 补验的一行接线（fullRecheck 的 pass 处）：null = 照常；"wait" = 读不出，等；其余 = 红的理由（走补验的 run_failed）。 */
export async function ciSelectedFullPass(run: Who, subject: { repo: string; merge: string }, runId: number): Promise<null | "wait" | string> {
  const port = ports().port;
  if (!port) return null;
  const d = await decide(run, subject.repo, () => readCiSelectedRunReceipt(port, subject.repo, runId, subject.merge));
  return d === "wait" ? "wait" : d.kind === "red" ? `run ${runId} ${d.reason}` : null;
}

export type SelectedPreflight = { ok: true; line: string | null } | { ok: false; reason: string };
/**
 * PM 预检（scripts/pm-merge-preflight.ts）：同一个读口、同一个有效档。没有放行标记 = 不加任何东西（与改前一致）；
 * 有标记时只有 on + 核得上的回执才通过（多一行说明），其余拒绝。只读：不记观察、不登记待修（那是调度器合并路径的事）。
 */
export async function ciSelectedPreflight(x: { repo: string; head: string; project: string }, port: CiSelectedPort,
  policy: RecoveryPolicyPort = recoveryPolicy): Promise<SelectedPreflight> {
  const read = await readCiSelectedReceipt(port, x.repo, x.head);
  if (!read.marked) return { ok: true, line: null };
  const key = policy(x.project, CI_SELECTED_KEY);
  let raw: string | null | undefined;
  try { raw = await port.variable(x.repo); } catch { raw = undefined; } // 仓库变量读不出按 off（最严），下面的理由里写明
  const mode = raw === undefined ? "off" : effectiveSelectedMode(raw, key.source === "error" ? "off" : key.mode);
  const d = selectedDecision(read, mode);
  if (d.kind === "allow") return { ok: true, line: `CI 责任选集放行：有效档 on，接受；范围外失败 ${d.receipt.outOfScope.length} 条待修（${d.receipt.runUrl}）` };
  return { ok: false, reason: d.kind === "red" ? `${d.reason}${raw === undefined ? "（仓库变量读不出，按 off）" : ""}` : "放行回执读不出" };
}
