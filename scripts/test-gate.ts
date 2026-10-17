// 本机全量测试闸的策略（docs/architecture/full-test-gate.md），`bun run test:gate`：
//   status                                                     当前策略、在册名额、登记摘要
//   set <off|observe|on> [--max N] [--max-wait-min N] [--source REF]   写 policy.json（max / maxWaitMin 没给沿用原值；source 只在 on 档沿用，
//                                                              off / observe 显式给 --source 才写）；on 必须有 source
//   sweep [--apply]                                            列在册登记的进程树判定（缺省只读）；--apply 经 permit 申请时的死持有者回收清掉 absent 的
// 闸目录跟宿主状态根走（不看 CLAUDESTRA_STATE_DIR），与 scripts/test.ts 同一处。
import { readFileSync } from "node:fs";
import { readJsonStateSync } from "../src/lib/state-file.ts";
import { fullTestGateDir, parseGatePolicy, policyPath, readGatePolicy, writeGatePolicy, type GatePolicyFile } from "../src/lib/full-test-gate-policy.ts";
import { readPermitEntries, runLogPath, sweepGate } from "../src/lib/full-test-gate.ts";

const USAGE = "用法：bun run test:gate status | set <off|observe|on> [--max N] [--max-wait-min N] [--source REF] | sweep [--apply]";
const dir = fullTestGateDir();

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function positiveInt(flag: string, v: string | undefined): number {
  if (!v || !/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))) fail(`${flag} 要正整数`);
  return Number(v);
}

function set(args: string[]): void {
  const mode = args[0];
  if (mode !== "off" && mode !== "observe" && mode !== "on") fail(USAGE);
  const read = readJsonStateSync(policyPath(dir));
  if (read.status === "corrupt") console.error(`原 policy.json 读不出（${read.error}），整份重写`);
  const prev = read.status === "ok" ? parseGatePolicy(read.data) : null;
  // 切到 off / observe 不带旧 source：库里 observe 的批准引用是缺省口径，沿用旧 source 会让在册登记时的全量撞 policy_conflict
  const { source: prevSource, ...kept } = prev ?? {};
  const next: GatePolicyFile = { ...kept, mode, ...(mode === "on" && prevSource ? { source: prevSource } : {}) };
  for (let i = 1; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (flag === "--max") next.max = positiveInt(flag, value);
    else if (flag === "--max-wait-min") next.maxWaitMin = positiveInt(flag, value);
    else if (flag === "--source" && value?.trim()) next.source = value.trim();
    else fail(USAGE);
  }
  if (mode === "on" && !next.source) fail("on 必须带 --source <批准出处>（缺了会按 observe 处理，不会限流）");
  writeGatePolicy(dir, next);
  console.log(`已写 ${policyPath(dir)}：${JSON.stringify(next)}`);
}

function status(): void {
  const policy = readGatePolicy(dir);
  console.log(`闸目录：${dir}`);
  console.log(`生效策略：mode=${policy.mode} max=${policy.max} maxWaitMin=${policy.maxWaitMin} source=${policy.source ?? "-"}`);
  for (const note of policy.notes) console.log(`  注意：${note}`);
  const entries = readPermitEntries(dir);
  if (entries === null) console.log("在册名额：读不出 permit 库");
  else {
    console.log(`在册名额：运行 ${entries.filter((e) => e.status === "active").length}，排队 ${entries.filter((e) => e.status === "waiting").length}`);
    for (const e of entries) console.log(`  ${e.status.padEnd(7)} ${e.id} ${e.workerId} ${e.orderId}`);
  }
  let lines: string[] = [];
  try { lines = readFileSync(runLogPath(dir), "utf8").split("\n").filter(Boolean); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.log(`登记读不出：${String(e)}`);
  }
  const starts = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).filter((r) => r.event === "start"); // 半行（并发追加被截断）跳过
  if (!starts.length) return console.log("登记：暂无");
  const peak = Math.max(...starts.map((r) => r.running ?? 0));
  const wouldQueue = starts.filter((r) => (r.wouldQueueAt ?? 0) > 0).length;
  const waited = starts.map((r) => r.waitedMs ?? 0);
  console.log(`登记：全量 ${starts.length} 次，同时在跑峰值 ${peak}，按 max=${policy.max} 会排队 ${wouldQueue} 次，` +
    `实际最长等待 ${Math.round(Math.max(...waited) / 1000)}s（明细 ${runLogPath(dir)}）`);
}

function sweep(args: string[]): void {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) fail(USAGE);
  const apply = args[0] === "--apply";
  let report: ReturnType<typeof sweepGate>;
  try { report = sweepGate(dir, { apply }); } catch (e) { fail(String(e)); }
  console.log(`闸目录：${dir}${apply ? "" : "（dry-run，只读；--apply 才回收）"}`);
  if (!report.rows.length) return console.log("在册登记：无");
  for (const r of report.rows) {
    const done = r.reclaimed === undefined ? "" : r.reclaimed ? "  → 已回收" : "  → 未回收";
    console.log(`  ${r.status.padEnd(7)} ${r.id} ${r.workerId}  持有者 ${r.owner}  树 ${r.tree}：${r.why}${done}`);
  }
  if (report.result) console.log(`回收申请：${report.result}（已记入 ${runLogPath(dir)}）`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "status" && rest.length === 0) status();
else if (cmd === "sweep") sweep(rest);
else if (cmd === "set") set(rest);
else fail(USAGE);
