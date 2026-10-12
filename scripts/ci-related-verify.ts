// related 运行的汇总核对（merge-arch-SELECT1，ci.yml 的 check 作业）。用法：
//   bun scripts/ci-related-verify.ts <plan.json> <digest> <分片工件目录> <n> <head>
// 只在 plan 作业给出 scope=related 时跑；全量运行照旧走 ci-test-shard.ts verify。核对：plan.json 就是本次运行冻结的那份（digest）；
// 工件恰好 test-shard-1..n；每片开头是 shard / head / plan 三行（plan 行不同 = 跨 manifest 的工件，拒）；分到文件的片第 4 行是本机 Bun 的
// 版本行、跑过的文件恰好是计划分给它的；分不到文件的片只能是显式的 `zero=1`，不能跑任何文件（防空参数 `bun test` 跑全仓）。
// 各片合起来恰好是计划选集——这是 related 覆盖，不是全仓覆盖：结论行写明，覆盖证明（proof 作业）也不会为它出 full manifest。
// tests/ci-related-workflow.test.ts。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CiPlan, planDigest } from "./ci-related-plan.ts";

const GROUP = /^::group::(.+):$/;
const META = [/^shard=/, /^head=/, /^plan=/, /^bun test v/, /^zero=/];
const few = (fs: string[]) => `${fs.length} 个：${fs.slice(0, 5).join(", ")}${fs.length > 5 ? " …" : ""}`;

function checkLog(name: string, log: string, k: number, want: { n: number; head: string; digest: string; bun: string }, mine: string[]): string[] {
  const errs: string[] = [], lines = log.split("\n");
  [`shard=${k}/${want.n}`, `head=${want.head}`, `plan=${want.digest}`].forEach((h, i) => {
    if (lines[i] !== h) errs.push(`${name} 第 ${i + 1} 行应为「${h}」，实际「${lines[i] ?? ""}」`);
  });
  const fourth = mine.length ? (lines[3]?.startsWith(`bun test v${want.bun} `) ? null : `bun test v${want.bun} 的版本行`) : lines[3] === "zero=1" ? null : "zero=1";
  if (fourth) errs.push(`${name} 第 4 行应是 ${fourth}，实际「${lines[3] ?? ""}」`);
  for (const re of META) {
    const at = lines.flatMap((l, j) => (re.test(l) ? [j + 1] : []));
    if (at.length > 1) errs.push(`${name} 里 ${re.source.slice(1)} 行出现了 ${at.length} 次（第 ${at.join(", ")} 行）`);
  }
  if (!mine.length && lines.slice(4).some((l) => l.trim())) errs.push(`${name} 是零执行片，zero=1 之后不能再有输出`);
  const ran = lines.flatMap((l) => GROUP.exec(l)?.[1] ?? []), seen = new Set<string>(), set = new Set(mine);
  const dup = ran.filter((f) => seen.has(f) || !seen.add(f));
  const missing = mine.filter((f) => !seen.has(f)), extra = [...seen].filter((f) => !set.has(f));
  if (dup.length) errs.push(`${name} 重复跑了 ${few(dup)}`);
  if (missing.length) errs.push(`${name} 没跑到分给它的 ${few(missing)}`);
  if (extra.length) errs.push(`${name} 跑了不该它跑的 ${few(extra)}`);
  return errs;
}

/** Errors (empty = the related shards ran exactly the frozen selection). */
export function verifyRelated(planText: string, digest: string, logs: Map<string, string>, want: { n: number; head: string; bun: string }): string[] {
  let plan: CiPlan;
  try { plan = JSON.parse(planText) as CiPlan; } catch { return ["plan.json 读不懂"]; }
  if (planDigest(plan) !== digest) return [`plan.json 的 digest 不是本次运行冻结的 ${digest}`];
  if (plan.scope !== "related") return [`plan scope=${plan.scope}，不该走 related 核对`];
  const errs: string[] = [];
  if (plan.shards.length !== want.n) errs.push(`计划分 ${plan.shards.length} 片，运行是 ${want.n} 片`);
  if (plan.sha.toLowerCase() !== want.head.toLowerCase()) errs.push(`计划算在 ${plan.sha}，运行检出 ${want.head}`);
  const union = plan.shards.flat(), uniq = new Set(union);
  if (!plan.tests.length) errs.push("related 选集为空（不能拿空清单判绿）");
  if (uniq.size !== union.length) errs.push("计划里同一文件分到了多片");
  if ([...uniq].sort().join("\n") !== [...plan.tests].sort().join("\n")) errs.push("各片合起来不等于计划选集");
  const names = Array.from({ length: want.n }, (_, i) => `test-shard-${i + 1}`);
  const extra = [...logs.keys()].filter((x) => !names.includes(x));
  if (extra.length) errs.push(`多出来的工件：${extra.join(", ")}`);
  names.forEach((name, i) => {
    const log = logs.get(name);
    if (log === undefined) errs.push(`缺少工件 ${name}`);
    else errs.push(...checkLog(name, log, i + 1, { ...want, digest }, plan.shards[i] ?? []));
  });
  return errs;
}

function main(args: string[]): void {
  const [planPath, digest, dir, n, head] = args;
  if (!planPath || !digest || !dir || !/^\d+$/.test(n ?? "") || !/^[0-9a-f]{40}$/i.test(head ?? "")) {
    console.error("用法：bun scripts/ci-related-verify.ts <plan.json> <digest> <目录> <n> <head>");
    process.exit(1);
  }
  const logs = new Map(readdirSync(dir).map((name) => {
    const p = join(dir, name, "shard.log");
    return [name, existsSync(p) ? readFileSync(p, "utf8") : ""] as const;
  }));
  const planText = existsSync(planPath) ? readFileSync(planPath, "utf8") : "";
  const errs = verifyRelated(planText, digest, logs, { n: Number(n), head: head!, bun: Bun.version });
  errs.forEach((e) => console.log(`::error::${e}`));
  if (errs.length) process.exit(1);
  const plan = JSON.parse(planText) as CiPlan;
  console.log(`related：${n} 片按计划跑 ${plan.shards.map((s) => s.length).join(" / ")}，合计 ${plan.tests.length} / 全集 ${plan.universe}，不漏不重 · ${digest}` +
    " · 这是相关测试覆盖，不是全仓覆盖：串行 / 人工合入前另做 full 补验");
}

if (import.meta.main) main(process.argv.slice(2));
