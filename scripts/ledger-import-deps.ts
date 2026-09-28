#!/usr/bin/env bun
/**
 * 一次性：把 PM 手写的 mockups/T12/v4-data/deps.json 导进台账的依赖边（T8h）。由 PM 在自己的会话里跑，
 * 写入逐条走 `bun src/manager.ts ledger dep-add`，身份、权限、环检测都和手敲命令一样；dedupKey = deps-json:<from>><to>，重跑幂等。
 * 默认不导 json 里的 state（大多能按阶段推导，导成手动值会把状态冻住），只打印「json 写的 vs 推导的」对照；--keep-state 才存成手动值。
 * 两端不是本项目已有任务的边跳过并列出（如 owner 这类人节点——人用任务的 assigneeKind=human 表示）；branches_example 是审查分叉，由推导给出，不导。
 *
 * 用法：bun scripts/ledger-import-deps.ts <deps.json> --project <id> [--keep-state] [--dry-run]
 * 沙箱：CLAUDESTRA_STATE_DIR=<临时目录> 让读库与 CLI 写入都指向那里的 ledger.sqlite。
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveBunPath } from "../src/lib/bun-path.js";
import { DEP_KINDS, DEP_STATES, DEP_WHEN_MAX, derivedState, type DepKind, type DepState } from "../src/lib/ledger-deps.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { LEDGER_PATH, listDeps, toTask } from "../src/lib/ledger-store.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";

interface JsonEdge {
  from?: unknown;
  to?: unknown;
  when?: unknown;
  state?: unknown;
  kind?: unknown;
}

export interface PlannedDep {
  from: string;
  to: string;
  when: string;
  kind: DepKind;
  /** 要存成手动值的状态（--keep-state 时 = json 的 state），默认 null */
  state: DepState | null;
  jsonState: string | null;
  derived: DepState;
  dedup: string;
}

export interface ImportPlan {
  add: PlannedDep[];
  skipped: { from: string; to: string; reason: string }[];
  ignored: string[];
}

type PlanTask = Pick<LedgerTask, "id" | "project" | "kind" | "stage"> & { stageBefore?: LedgerTask["stageBefore"] };

function skipReason(project: string, from: PlanTask | undefined, to: PlanTask | undefined, ids: [string, string]): string | null {
  const missing = ids.filter((_, i) => ![from, to][i]);
  if (missing.length) return `台账里没有任务 ${missing.join("、")}`;
  const other = [from, to].find((t) => t?.project !== project);
  return other ? `跨项目：${other.id} 在 ${other.project}，依赖只能连本项目 ${project} 的任务` : null;
}

/**
 * 纯函数：json + 全部任务 + 本项目已有的边 → 要加的边 / 跳过的边（带原因）/ 不导的段。
 * 已有的边、json 里重复的边都跳过：重跑不靠 dedupKey 的「已导过」判断，PM 删掉的边也就不会被误报成已导。
 */
export function planDepImport(
  json: unknown,
  project: string,
  tasks: readonly PlanTask[],
  existing: readonly { from: string; to: string }[] = [],
  opts: { keepState?: boolean } = {},
): ImportPlan {
  const obj = (json ?? {}) as { edges?: unknown };
  if (!Array.isArray(obj.edges)) throw new Error("deps.json 里没有 edges 数组");
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set(existing.map((d) => `${d.from}>${d.to}`));
  const inJson = new Set<string>();
  const plan: ImportPlan = { add: [], skipped: [], ignored: Object.keys(obj).filter((k) => k !== "edges" && !k.startsWith("_")) };
  for (const raw of obj.edges as JsonEdge[]) {
    const from = String(raw.from ?? "");
    const to = String(raw.to ?? "");
    const when = typeof raw.when === "string" ? raw.when.trim() : "";
    const kind = (raw.kind ?? "blocks") as DepKind;
    const jsonState = typeof raw.state === "string" ? raw.state : null;
    const pair = `${from}>${to}`;
    const reason =
      skipReason(project, byId.get(from), byId.get(to), [from, to]) ??
      (inJson.has(pair) ? "json 里重复出现，只导第一条"
      : seen.has(pair) ? "台账里已有这条边（要改用 dep-set）"
      : !when ? "没有条件"
      : [...when].length > DEP_WHEN_MAX ? `条件超过 ${DEP_WHEN_MAX} 字`
      : !DEP_KINDS.includes(kind) ? `kind 不认识：${String(raw.kind)}`
      : opts.keepState && jsonState !== null && !DEP_STATES.includes(jsonState as DepState) ? `state 不认识：${jsonState}`
      : null);
    inJson.add(pair);
    if (reason) {
      plan.skipped.push({ from, to, reason });
      continue;
    }
    const state = opts.keepState && jsonState !== null ? (jsonState as DepState) : null;
    plan.add.push({ from, to, when, kind, state, jsonState, derived: derivedState(kind, byId.get(from)), dedup: `deps-json:${from}>${to}` });
  }
  return plan;
}

/** 一条边对应的 CLI 参数（manager.ts 之后的部分） */
export function depAddArgs(d: PlannedDep): string[] {
  return ["ledger", "dep-add", d.from, d.to, "--when", d.when, "--kind", d.kind, ...(d.state ? ["--state", d.state] : []), "--dedup", d.dedup];
}

function report(plan: ImportPlan): void {
  console.log(`要导 ${plan.add.length} 条，跳过 ${plan.skipped.length} 条${plan.ignored.length ? `，不导的段：${plan.ignored.join(", ")}（审查分叉由推导给出）` : ""}`);
  for (const d of plan.add) {
    const mark = d.jsonState === null || d.jsonState === d.derived ? "  " : "≠ ";
    console.log(`${mark}${d.from} → ${d.to} [${d.kind}] json:${d.jsonState ?? "-"} 推导:${d.derived}${d.state ? ` 存手动:${d.state}` : ""}  ${d.when}`);
  }
  for (const s of plan.skipped) console.log(`跳过 ${s.from} → ${s.to}：${s.reason}`);
}

/**
 * 只读取规划要的数据，不在库旁边留下文件：没有 -wal 时用 immutable 打开（纯 readonly 在缺 -wal / -shm 时打不开，
 * 而读写打开会建出这两个文件）；已有 -wal 时说明有进程开着库，普通 readonly 就能读到 WAL 里的最新提交。
 */
function readForPlan(path: string, project: string): { tasks: PlanTask[]; deps: { from: string; to: string }[] } {
  const db = existsSync(`${path}-wal`) ? new Database(path, { readonly: true }) : new Database(`file:${path}?immutable=1`, { readonly: true });
  try {
    const tasks = (db.query("SELECT * FROM tasks").all() as Record<string, unknown>[]).map(toTask);
    return { tasks, deps: listDeps(db, project) };
  } finally {
    db.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const usage = "用法: bun scripts/ledger-import-deps.ts <deps.json> --project <id> [--keep-state] [--dry-run]";
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { project: { type: "string" }, "keep-state": { type: "boolean" }, "dry-run": { type: "boolean" } } });
  } catch (e) {
    console.error(`${(e as Error).message}\n${usage}`);
    return 2;
  }
  const [file, ...extra] = parsed.positionals;
  const project = parsed.values.project;
  if (!file || extra.length || !project) {
    console.error(usage);
    return 2;
  }
  if (!existsSync(LEDGER_PATH)) {
    console.error(`台账库不存在：${LEDGER_PATH}`);
    return 1;
  }
  const { tasks, deps } = readForPlan(LEDGER_PATH, project);
  const plan = planDepImport(JSON.parse(readFileSync(file, "utf8")), project, tasks, deps, { keepState: parsed.values["keep-state"] });
  report(plan);
  if (parsed.values["dry-run"]) return 0;
  let failed = 0;
  for (const d of plan.add) {
    const p = Bun.spawnSync([resolveBunPath(), "src/manager.ts", ...depAddArgs(d)], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    const line = p.stdout.toString().trim().split("\n").at(-1) ?? "";
    let r: { ok?: boolean; duplicate?: boolean; dep?: unknown; error?: string } = {};
    try {
      r = JSON.parse(line) as typeof r;
    } catch {
      // CLI 没吐 JSON（崩在解析前）：按失败处理，下面打印 stderr
    }
    if (p.exitCode !== 0 || r.ok !== true) {
      failed++;
      console.log(`✗ ${d.from} → ${d.to} ${r.error ?? (line || p.stderr.toString().trim())}`);
    } else if (r.duplicate && r.dep === null) {
      console.log(`- ${d.from} → ${d.to} 曾导入、后来被删，不补回（要补就手动 dep-add）`);
    } else {
      console.log(`✓ ${d.from} → ${d.to}${r.duplicate ? "（已导过）" : ""}`);
    }
  }
  console.log(failed ? `${failed} 条失败` : "完成");
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
