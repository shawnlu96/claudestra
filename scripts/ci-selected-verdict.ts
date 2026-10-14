// 责任选集放行的分片接线与总闸（merge-arch-CISEL1，ci.yml）。判定本身在 src/lib/ci-selected-verdict.ts，这里只读文件、git 与环境。
//   bun scripts/ci-selected-verdict.ts shard <k> <退出码> <shard.log> <files.txt> <plan.json> <plan digest> <输出目录>
//     分片测试步骤里 bun test 失败后才调（off 档根本不调）。写 <输出目录>/receipt.json，日志打一行 `ci-selected:`；
//     只有 CI_SELECTED_GATE=on 且判定放行时以 0 退出（这一片以成功结束），其余都以 1 退出、由调用方按 bun 原来的退出码失败。
//   bun scripts/ci-selected-verdict.ts gate <分片日志目录> <回执目录> <输出目录>
//     check 作业：成功结束却红过的片（日志里 bun 的「N fail」，N > 0）都必须有本次 run / attempt / 检出 / 这份日志的放行回执，缺一份就红。
//     有放行时写 <输出目录>/verdict.json（工件 ci-selected-verdict）并打 `ci-selected: allow=1 out_of_scope=N`。
// 模式来自受信仓库变量 CI_SELECTED_GATE，ci.yml 里先归一成 off / observe / on 三个字面量再给脚本（PR 改不了仓库变量，也带不进别的值）。
// tests/ci-selected-verdict-gate.test.ts。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../src/lib/canonical-json.ts";
import {
  type CiSelectedMode, ciSelectedMode, hasBunFailures, judgeSelected, logDigest, parseReceipt, readResponsibility, RECEIPT_VERSION, receiptDigest,
  receiptProblems, shardComplete, type ShardReceipt, shardLogFailures,
} from "../src/lib/ci-selected-verdict.ts";

/** scripts/ci-related-plan.ts 的 planDigest 同一算法；不 import 它，因为它带着 oxc-parser，而 check 作业不装依赖。 */
const planDigestOf = (p: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(p)).digest("hex")}`;

const parseJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
const readText = (path: string): string | undefined => (path && existsSync(path) ? readFileSync(path, "utf8") : undefined);

function git(args: string[]): string | null {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

/** 测试合并提交（两个父提交）相对第一个父提交改了哪些文件；不是合并提交或读不出 = null（不放行）。 */
function prChanged(): string[] | null {
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"])?.trim().split(" ");
  if (parents?.length !== 3) return null;
  const out = git(["diff", "--name-only", "-z", "--no-renames", "HEAD^1", "HEAD"]);
  return out === null ? null : out.split("\0").filter(Boolean);
}

export interface ShardInput {
  mode: CiSelectedMode; shard: number; exitCode: number; log: string; assigned: string[];
  /** plan.json 的文本与本次运行冻结的 digest；对不上就没有责任选集 */
  planText: string | undefined; planDigest: string;
  changed: string[] | null; typecheck: string;
  run: { runId: number; attempt: number; head: string };
}

/** 一片的回执（纯函数）。applied 只在 on 且放行时为真。 */
export function shardReceipt(x: ShardInput): ShardReceipt {
  const plan = x.planText === undefined ? null : parseJson(x.planText) as { responsibility?: unknown } | null;
  const frozen = plan && typeof plan === "object" && planDigestOf(plan) === x.planDigest ? plan : null;
  const resp = frozen ? readResponsibility(frozen.responsibility) : null;
  // guard / 入口构建在测试步骤之后才跑，红了这一片照样红；web 构建是独立作业，红了照样挂自己的检查
  const steps = { typecheck: x.shard === 1 ? x.typecheck : "skipped", guard: "pending", build: "pending", "web-build": "pending" };
  const v = judgeSelected({ responsibility: resp, failures: shardLogFailures(x.log, x.shard), changed: x.changed, steps,
    complete: shardComplete(x.log, x.assigned, x.exitCode) });
  return { version: RECEIPT_VERSION, kind: "ci-selected-shard", mode: x.mode, shard: x.shard, ...x.run, planDigest: x.planDigest,
    responsibilityDigest: resp?.digest ?? null, logDigest: logDigest(x.log), exitCode: x.exitCode, allow: v.allow, applied: x.mode === "on" && v.allow,
    reason: v.reason, outOfScope: v.outOfScope };
}

export const shardLine = (r: ShardReceipt): string =>
  `ci-selected: shard=${r.shard} mode=${r.mode} allow=${r.allow ? 1 : 0} applied=${r.applied ? 1 : 0} responsibility=${r.responsibilityDigest ?? "none"}`
  + ` out_of_scope=${r.outOfScope.length} reason=${r.reason}`;

export interface GateInput {
  mode: CiSelectedMode;
  run: { runId: number; attempt: number; head: string };
  /** 片号 → shard.log */
  logs: Map<number, string>;
  /** 片号 → receipt.json 解出来的值 */
  receipts: Map<number, unknown>;
}
export interface GateVerdict {
  version: 1; kind: "ci-selected-verdict"; mode: CiSelectedMode; runId: number; attempt: number; head: string;
  responsibilityDigest: string | null; outOfScope: { file: string; name: string }[]; shards: Record<string, string>;
}

/**
 * 总闸（纯函数）：放行了的片 = 成功结束却红过的片，加上任何一份本次 attempt 的 applied 回执声称的片。每一片都要有对得上的回执，
 * 且所有回执出自同一份责任选集。没有放行的片时 verdict 为 null、problems 为空：结论与改前一致。
 */
export function gateVerdict(x: GateInput): { verdict: GateVerdict | null; problems: string[] } {
  const claimed = [...x.receipts].filter(([, r]) => { const p = parseReceipt(r); return p?.applied && p.attempt === x.run.attempt; }).map(([k]) => k);
  const released = [...new Set([...[...x.logs].filter(([, log]) => hasBunFailures(log)).map(([k]) => k), ...claimed])].sort((a, b) => a - b);
  if (!released.length) return { verdict: null, problems: [] };
  const problems = released.flatMap((k) => receiptProblems(x.receipts.get(k), { shard: k, ...x.run, log: x.logs.get(k) }));
  const ok = released.map((k) => parseReceipt(x.receipts.get(k))).filter((r): r is ShardReceipt => r !== null);
  const digests = [...new Set(ok.map((r) => r.responsibilityDigest))];
  if (digests.length > 1) problems.push(`各片回执的责任选集不一致：${digests.join(", ")}`);
  if (x.mode !== "on") problems.push(`CI_SELECTED_GATE=${x.mode}，却有片按放行结束：${released.join(", ")}`);
  const seen = new Set<string>(), outOfScope: GateVerdict["outOfScope"] = [];
  for (const f of ok.flatMap((r) => r.outOfScope)) if (!seen.has(`${f.file}\0${f.name}`)) { seen.add(`${f.file}\0${f.name}`); outOfScope.push(f); }
  const verdict: GateVerdict = { version: 1, kind: "ci-selected-verdict", mode: x.mode, ...x.run, responsibilityDigest: digests[0] ?? null, outOfScope,
    shards: Object.fromEntries(ok.map((r) => [String(r.shard), receiptDigest(r)])) };
  return { verdict, problems };
}

const runOf = (env: Record<string, string | undefined>) => ({ runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT),
  head: git(["rev-parse", "HEAD"])?.trim() ?? "" });

function shardMain(a: string[], env: Record<string, string | undefined>): number {
  const [k, code, logPath, filesPath, planPath, digest, outDir] = a;
  const log = readText(logPath ?? "") ?? "", mode = ciSelectedMode(env.CI_SELECTED_GATE);
  const r = shardReceipt({ mode, shard: Number(k), exitCode: Number(code), log, assigned: (readText(filesPath ?? "") ?? "").split("\n").filter(Boolean),
    planText: readText(planPath ?? ""), planDigest: digest ?? "", changed: prChanged(), typecheck: env.CORE_TYPECHECK ?? "", run: runOf(env) });
  mkdirSync(outDir!, { recursive: true });
  writeFileSync(join(outDir!, "receipt.json"), `${canonicalJson(r)}\n`);
  console.log(shardLine(r));
  for (const f of r.outOfScope) console.log(`ci-selected: out_of_scope ${f.file} > ${f.name}`);
  return r.applied ? 0 : 1;
}

/** 下载目录里每个工件一个子目录：<前缀><k>/<文件>。 */
function readByShard(dir: string, prefix: string, file: string): Map<number, string> {
  if (!existsSync(dir)) return new Map();
  return new Map(readdirSync(dir).flatMap((name) => {
    const k = name.startsWith(prefix) ? Number(name.slice(prefix.length)) : NaN, path = join(dir, name, file);
    return Number.isSafeInteger(k) && k > 0 && existsSync(path) ? [[k, readFileSync(path, "utf8")] as const] : [];
  }));
}

function gateMain(a: string[], env: Record<string, string | undefined>): number {
  const [shardsDir, receiptsDir, outDir] = a, mode = ciSelectedMode(env.CI_SELECTED_GATE);
  const logs = readByShard(shardsDir!, "test-shard-", "shard.log");
  const receipts = new Map([...readByShard(receiptsDir!, "ci-selected-shard-", "receipt.json")].map(([k, t]) => [k, parseJson(t)]));
  const { verdict, problems } = gateVerdict({ mode, run: runOf(env), logs, receipts });
  if (verdict) {
    mkdirSync(outDir!, { recursive: true });
    writeFileSync(join(outDir!, "verdict.json"), `${canonicalJson(verdict)}\n`);
  }
  problems.forEach((p) => console.log(`::error::${p}`));
  if (verdict || mode !== "off") console.log(`ci-selected: allow=${verdict && !problems.length ? 1 : 0} out_of_scope=${verdict?.outOfScope.length ?? 0}`);
  return problems.length ? 1 : 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  let code = 1;
  try {
    if (cmd === "shard" && rest.length === 7) code = shardMain(rest, process.env);
    else if (cmd === "gate" && rest.length === 3) code = gateMain(rest, process.env);
    else console.log("::error::用法：shard <k> <退出码> <shard.log> <files.txt> <plan.json> <digest> <输出目录> | gate <分片日志目录> <回执目录> <输出目录>");
  } catch (e) {
    // 判定出错就不放行：分片按 bun 原来的退出码失败，总闸红
    console.log(`::error::ci-selected ${cmd} 没完成：${(e as Error).message}`);
  }
  process.exit(code);
}
