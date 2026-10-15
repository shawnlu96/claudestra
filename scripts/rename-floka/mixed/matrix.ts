/**
 * 隔离混跑矩阵：在临时 base 下起三台实例 + 本机中心，按 rolloutSteps 的次序一步步切，每一阶段后六向互发并核不变量：
 *   - 六个有向对全部送达（中心 / 客户端混版本均可用）；
 *   - 没开接收的一端只收到旧族（请求签名、台账签名、中心转发头），且没有一条被拒；
 *   - 每台四个 daemon 任何时刻最多一个写者，runtime 两条路径看到的是同一个 server；
 *   - 身份、peer、旧邀请、VAPID、外部配置逐字节不变，任务只增不减，推送订阅不被删改。
 * 调用方负责 base 在系统临时目录下（rollout.ts 的 admitRun）；本模块不读任何真实路径。
 */
import { join } from "node:path";
import { rolloutSteps, CUT_PARTS, SEND_KEYS, type CutPart, type RolloutStep } from "./rollout.ts";
import {
  addTask, contracts, createInstance, cutPart, identitySum, layoutOf, pushRows, rollbackAll, serversSeen, tasks, type MixedInstance,
} from "./instance.ts";
import { exchange, familyOf, reconnect, restartClient, setCenter, startWire, stopWire, type Arrival, type Wire } from "./wire.ts";

export const MACHINES = ["alpha", "beta", "gamma"] as const;

export interface StageReport {
  step: string;
  ok: boolean;
  detail: string[];
  /** 每台客户端与中心之间这条连接的族 */
  center: Record<string, string>;
  failures: string[];
  violations: string[];
  arrivals: Arrival[];
}

export interface World {
  base: string;
  insts: MixedInstance[];
  wire: Wire;
  baseline: Map<string, { identity: string; contracts: Record<string, string>; push: string }>;
  /** 每台应当在的任务（迁移后新增的也算） */
  expectedTasks: Map<string, Set<string>>;
  stages: StageReport[];
  /** runOrder 记下的本次升级次序与注入失败的机器：汇总据此区分「预期内回滚」和「意外失败」 */
  order: string[];
  expectedFaults: Set<string>;
}

export interface RunOptions {
  /** 切到这台的这些分项时注入失败 */
  faults?: Partial<Record<string, CutPart[]>>;
}

const receiving = (i: MixedInstance): boolean => i.rename.signature === "on";

export async function createWorld(base: string): Promise<World> {
  const insts = MACHINES.map((m, n) => createInstance(base, m, n + 1));
  const wire = await startWire(insts);
  const baseline = new Map<string, { identity: string; contracts: Record<string, string>; push: string }>();
  for (const i of insts) baseline.set(i.name, { identity: await identitySum(i), contracts: contracts(i), push: JSON.stringify(pushRows(i)) });
  return { base, insts, wire, baseline, expectedTasks: new Map(insts.map((i) => [i.name, new Set(tasks(i))])), stages: [], order: [], expectedFaults: new Set() };
}

/** 一台实例此刻的不变量 */
async function instanceViolations(w: World, i: MixedInstance): Promise<string[]> {
  const v: string[] = [];
  const b = w.baseline.get(i.name)!;
  if ((await identitySum(i)) !== b.identity) v.push(`${i.name}: 身份变了`);
  const now = contracts(i);
  for (const [k, sum] of Object.entries(b.contracts)) if (now[k] !== sum) v.push(`${i.name}: ${k} 被改`);
  if (JSON.stringify(pushRows(i)) !== b.push) v.push(`${i.name}: 推送订阅被改或删`);
  const have = new Set(tasks(i));
  for (const t of w.expectedTasks.get(i.name)!) if (!have.has(t)) v.push(`${i.name}: 任务 ${t} 丢了`);
  if (i.services.maxLive > 1) v.push(`${i.name}: 同一 daemon 出现 ${i.services.maxLive} 个写者`);
  if (i.services.side() === "mixed") v.push(`${i.name}: 新旧 daemon 混着跑`);
  const servers = new Set(await serversSeen(i));
  if (servers.size !== 1) v.push(`${i.name}: runtime 看到 ${servers.size} 个 server`);
  return v;
}

/** 一轮互发后的不变量：全送达、无拒绝、未开接收的一端只见旧族 */
function arrivalViolations(w: World, arrivals: Arrival[], failures: string[]): string[] {
  const v = [...failures];
  for (const a of arrivals) {
    const to = w.insts.find((i) => i.name === a.to)!;
    if (a.request === "rejected" || a.ledger === "rejected") v.push(`${a.from}→${a.to}: 被拒 (${a.request}/${a.ledger})`);
    if (!receiving(to) && (a.request === "floka" || a.ledger === "floka" || a.flokaHeaders.length)) v.push(`${a.from}→${a.to}: 旧端收到新族`);
  }
  for (const i of w.insts) if (!i.rename.centerReceive && familyOf(w.wire, i) !== "legacy") v.push(`${i.name}: 旧客户端连成了新族`);
  if (arrivals.length !== w.insts.length * (w.insts.length - 1)) v.push(`本轮只到达 ${arrivals.length} 条`);
  return v;
}

/** 记一个阶段：互发一轮、核全部不变量 */
export async function checkpoint(w: World, step: string, ok: boolean, detail: string[]): Promise<StageReport> {
  const { arrivals, failures } = await exchange(w.wire);
  const violations = arrivalViolations(w, arrivals, failures);
  for (const i of w.insts) violations.push(...await instanceViolations(w, i));
  const center = Object.fromEntries(w.insts.map((i) => [i.name, familyOf(w.wire, i)]));
  const s: StageReport = { step, ok, detail, center, failures, violations, arrivals };
  w.stages.push(s);
  return s;
}

/** 一台机器的整段切换：维护窗口内停写 → state / runtime / services / mcp / receive；任一失败即整机逆序回滚 */
async function cutMachine(w: World, i: MixedInstance, faults: CutPart[]): Promise<{ ok: boolean; detail: string[] }> {
  const detail: string[] = [];
  for (const f of faults) i.faults.add(f);
  i.writers = [];
  let ok = true;
  for (const part of CUT_PARTS) {
    const r = await cutPart(i, part);
    detail.push(`${part}: ${r.detail}`);
    if (!r.ok) {
      ok = false;
      detail.push(...await rollbackAll(i));
      break;
    }
    if (part === "state") {
      // 迁移后新增的任务：之后无论成败、回滚与否都必须还在
      addTask(i, `after-state-${i.seq}`);
      w.expectedTasks.get(i.name)!.add(`after-state-${i.seq}.json`);
    }
  }
  i.faults.clear();
  i.writers = [`bridge:${i.name}`];
  await restartClient(w.wire, i);
  return { ok, detail };
}

/** 跳过（本机没切完）算没完成：ok=false，只有注入失败的机器才在汇总里算预期内 */
async function sendStep(w: World, i: MixedInstance): Promise<{ ok: boolean; detail: string[] }> {
  if (!receiving(i)) return { ok: false, detail: ["跳过：本机未切完，不开新发送"] };
  i.rename = { ...i.rename, ...SEND_KEYS };
  await restartClient(w.wire, i);
  await reconnect(w.wire, i); // 带着上次 welcome 学到的中心能力重连
  return { ok: true, detail: [`center: ${familyOf(w.wire, i)}`] };
}

async function runStep(w: World, s: RolloutStep, o: RunOptions): Promise<StageReport> {
  if (s.kind === "center") {
    await setCenter(w.wire, true);
    return checkpoint(w, s.id, true, ["center: dual"]);
  }
  const i = w.insts.find((x) => x.name === s.machine)!;
  if (s.kind === "send") {
    const r = await sendStep(w, i);
    return checkpoint(w, s.id, r.ok, r.detail);
  }
  const r = await cutMachine(w, i, o.faults?.[i.name] ?? []);
  return checkpoint(w, `cut:${i.name}`, r.ok, r.detail);
}

/** 跑一个升级次序：基线 → 中心双认 → 逐机切 → 新发送 */
export async function runOrder(base: string, order: readonly string[], o: RunOptions = {}): Promise<World> {
  const w = await createWorld(base);
  w.order = [...order];
  for (const [m, parts] of Object.entries(o.faults ?? {})) if (parts?.length) w.expectedFaults.add(m);
  await checkpoint(w, "baseline", true, []);
  // 计划里每台的五个分项合成一个阶段执行（同一维护窗口），其余按计划逐步
  for (const s of rolloutSteps(order)) {
    if (s.kind === "cut" && s.part !== CUT_PARTS[0]) continue;
    await runStep(w, s, o);
  }
  return w;
}

/** 整机回滚一台：分项逆序回滚 + 进程按旧档位重启，然后互发核不变量 */
export async function rollbackMachine(w: World, name: string): Promise<StageReport> {
  const i = w.insts.find((x) => x.name === name)!;
  i.writers = [];
  const detail = await rollbackAll(i);
  i.writers = [`bridge:${i.name}`];
  await restartClient(w.wire, i);
  detail.push(`layout: ${await layoutOf(i)}`, `services: ${i.services.side()}`);
  return checkpoint(w, `rollback:${name}`, detail.every((d) => !/refused|blocked|failed/.test(d)), detail);
}

/** 中心回到旧版本：已切过的客户端必须回到旧族照常可用 */
export async function rollbackCenter(w: World): Promise<StageReport> {
  await setCenter(w.wire, false);
  return checkpoint(w, "rollback:center", true, ["center: legacy"]);
}

export const closeWorld = (w: World): void => stopWire(w.wire);

/**
 * 汇总：给 CLI / 测试看的形状（不含实例对象）。ok 要求不变量全干净，且请求的每台都真的切完、开了新发送；
 * 只有 runOrder 注入了失败的机器，其 cut / send 失败才算预期内（且必须真的失败、回滚干净），其余任何 ok=false 都是意外失败。
 */
export function summarize(w: World): { ok: boolean; unexpected: string[]; stages: Omit<StageReport, "arrivals">[]; roots: string[] } {
  const stages = w.stages.map(({ arrivals: _a, ...s }) => s);
  const unexpected: string[] = [];
  for (const s of stages) for (const v of s.violations) unexpected.push(`${s.step}: ${v}`);
  const machineOf = (step: string): string | undefined => /^(cut|send):(.+)$/.exec(step)?.[2];
  for (const s of stages) {
    const m = machineOf(s.step);
    if (!s.ok && !(m !== undefined && w.expectedFaults.has(m))) unexpected.push(`${s.step}: 意外失败（${s.detail.join("；")}）`);
  }
  for (const m of w.order) {
    for (const kind of ["cut", "send"]) if (!stages.some((s) => s.step === `${kind}:${m}`)) unexpected.push(`${kind}:${m}: 没有执行`);
    if (w.expectedFaults.has(m) && stages.find((s) => s.step === `cut:${m}`)?.ok) unexpected.push(`cut:${m}: 注入了失败却切成功`);
  }
  for (const m of w.expectedFaults) if (!w.order.includes(m)) unexpected.push(`${m}: 注入失败的机器不在升级次序里`);
  return { ok: unexpected.length === 0, unexpected, stages, roots: w.insts.map((i) => join(w.base, i.name)) };
}
