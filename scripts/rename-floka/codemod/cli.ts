/**
 * Claudestra → Floka 的机械改名，带允许表。开关 rename.codemod = off / observe / on，缺省 observe（dry-run）：
 * off 什么都不做；observe 只把分类 diff 写到标准输出，不写任何文件；on 把获准的 brand 编辑写进显式给的临时目标根，
 * 源目录三种模式都不动。迁移、验签、协商、持久化转换不在这里做——那些名字归 protocol，只报不改（见 rules.ts）。
 * 用法：bun scripts/rename-floka/codemod/cli.ts --root <目录> [--mode off|observe|on] [--config <json>] [--rules-file <json>]
 *        [--format json|diff]            observe：json 是可交回执行的计划，diff 给人看
 *        --plan <计划> --target <临时目录> --rules <id,id>   on：三样都必须显式给
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { executePlan } from "./apply.ts";
import { buildPlan, renderDiff, type CodemodMode, type Plan } from "./plan.ts";
import type { RuleSet } from "./rules.ts";
import { checkedInput, Refusal, type Env, type FsCtx } from "./scan.ts";

interface CliIo { env?: Env; home?: string; cwd?: string; tmpRoots?: string[] }
export interface CliResult { code: number; stdout: string; stderr: string }

const FLAGS = new Set(["root", "mode", "config", "rules-file", "format", "plan", "target", "rules"]);
const ON_ONLY = ["plan", "target", "rules"] as const;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const key = flag.slice(2);
    const value = argv[i + 1];
    if (!flag.startsWith("--") || !FLAGS.has(key) || value === undefined || Object.hasOwn(out, key)) throw new Error(`invalid_arguments: ${flag}`);
    out[key] = value;
  }
  return out;
}

function parseMode(v: unknown, where: string): CodemodMode {
  if (v === "off" || v === "observe" || v === "on") return v;
  throw new Error(`invalid_mode: ${where} 的 rename.codemod 只能是 off / observe / on`);
}

/** --mode 优先，其次 --config 文件里的 rename.codemod（嵌套或点号键都认），都没有就是 observe。不读真实状态目录里的配置 */
function resolveMode(flag: string | undefined, configPath: string | null): CodemodMode {
  if (flag !== undefined) return parseMode(flag, "--mode");
  if (!configPath) return "observe";
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const v = (raw.rename as Record<string, unknown> | undefined)?.codemod ?? raw["rename.codemod"];
  return v === undefined ? "observe" : parseMode(v, configPath);
}

function readJson<T>(path: string, what: string, cwd: string, ctx: FsCtx): T {
  return JSON.parse(readFileSync(checkedInput(path, what, cwd, ctx), "utf8")) as T;
}

function run(argv: string[], io: CliIo): string {
  const ctx: FsCtx = { env: io.env ?? process.env, home: io.home ?? homedir() };
  const cwd = io.cwd ?? process.cwd();
  const a = parseArgs(argv);
  const mode = resolveMode(a.mode, a.config === undefined ? null : checkedInput(a.config, "--config", cwd, ctx));
  if (mode === "off") return JSON.stringify({ mode, skipped: true });
  const root = resolve(cwd, a.root ?? ".");
  const set = readJson<RuleSet>(a["rules-file"] ?? join(import.meta.dir, "rules.json"), "--rules-file", cwd, ctx);
  if (mode === "observe") {
    const stray = ON_ONLY.find((k) => a[k] !== undefined);
    if (stray) throw new Error(`needs_on: --${stray} 只在 on 模式下生效（observe 不写任何文件）`);
    if (a.format !== undefined && a.format !== "json" && a.format !== "diff") throw new Error("invalid_arguments: --format 只能是 json / diff");
    const plan = buildPlan(root, set, { ...ctx, mode });
    return a.format === "diff" ? renderDiff(plan).trimEnd() : JSON.stringify(plan, null, 2);
  }
  if (a.plan === undefined) throw new Refusal("plan_required", "on 必须用 --plan 交回 observe 生成的计划");
  const plan = readJson<Plan>(a.plan, "--plan", cwd, ctx);
  const approved = a.rules?.split(",").map((s) => s.trim()).filter(Boolean);
  const target = a.target === undefined ? undefined : resolve(cwd, a.target);
  return JSON.stringify(executePlan(root, plan, set, { ...ctx, mode, target, approved, tmpRoots: io.tmpRoots }), null, 2);
}

/** 命令行入口的纯函数形态（测试直接调）。退出码：0 成功（observe 的拒绝项写在计划的 ok 里）；1 拒绝执行；2 参数或输入有错 */
export function runCli(argv: string[], io: CliIo = {}): CliResult {
  try {
    return { code: 0, stdout: `${run(argv, io)}\n`, stderr: "" };
  } catch (e) {
    return { code: e instanceof Refusal ? 1 : 2, stdout: "", stderr: `${(e as Error).message}\n` };
  }
}

if (import.meta.main) {
  const r = runCli(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  // 不调 process.exit：计划有几百 KB，接管道时立刻退出会把没写完的输出截断
  process.exitCode = r.code;
}
