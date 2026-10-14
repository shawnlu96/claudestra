// desktop 作业的范围判定（merge-arch-CIDESK1，ci.yml 的 desktop-scope 作业）：普通 PR 没改 desktop 的输入时，desktop 作业不必上 macOS。
//   bun scripts/ci-desktop-scope.ts        读 CI_DESKTOP_SCOPE / GITHUB_EVENT_NAME / GITHUB_HEAD_REF 与 `git diff HEAD^1 HEAD`，写 GITHUB_OUTPUT 的 run
// 只有 run=false 时 desktop 作业才改在 Ubuntu 上记一条「无需运行」（同名检查照样 success）；其余任何情况——push（main）、补验、列车 PR、
// 改动读不出、判定器自己出错、开关不是 on——都照旧上 macOS 真跑。这份脚本不用 bun install：只 import 仓库里不带依赖的文件。
// tests/ci-desktop-scope.test.ts。
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { globMatch } from "../src/lib/ci-impact-inputs.ts";
import { type ChangedFile, parseNameStatus } from "../src/lib/ci-impact-select.ts";

export type CiDesktopScopeMode = "off" | "observe" | "on";

/**
 * desktop 作业实际读的文件：desktop/ 自己、根目录的依赖声明（它用根 node_modules 里的 tsc）、workflow，以及判定器自己和它 import 的
 * parseNameStatus / globMatch（判定逻辑变了必须真跑）。bunfig.toml 是保守列入：没核实 bun 在 desktop/ 下会不会往上找配置。
 */
export const DESKTOP_INPUTS: readonly string[] = [
  "desktop/**", "package.json", "bun.lock", "bunfig.toml", ".github/**", "scripts/ci-desktop-scope.ts", "src/lib/ci-impact-*.ts",
];
const SHOWN = 5;

/** 仓库变量 CI_DESKTOP_SCOPE 的读法：未设或空 → observe；off / observe / on 原样；其他值一律按 off（照旧跑）。 */
export function ciDesktopScopeMode(raw: unknown): CiDesktopScopeMode {
  if (raw === undefined || raw === null || raw === "") return "observe";
  return raw === "off" || raw === "observe" || raw === "on" ? raw : "off";
}

export interface DesktopScopeFacts {
  event: string;
  headRef: string;
  mode: CiDesktopScopeMode;
  scope?: string;
  /** PR 合并提交相对第一个父提交的改动；null = 读不出。 */
  changes: readonly ChangedFile[] | null;
  /** 读不懂的 diff 记录、或读改动时的失败原因；非空就照旧跑。 */
  bad: readonly string[];
}
export interface DesktopScopeDecision {
  /** desktop 作业要不要真跑（macOS）。只有 on 且 wouldSkip 时是 false。 */
  run: boolean;
  /** 按范围本可以不跑；observe / off 下只记不用。 */
  wouldSkip: boolean;
  reasons: string[];
  line: string;
}

/** 一律跑的原因：不是普通 PR、改动读不出、或命中了 desktop 的输入；都没有就是空（本可跳过）。 */
function mustRunReasons(f: DesktopScopeFacts): string[] {
  if (f.event === "push") return ["push（main）始终跑"];
  if (f.event === "workflow_dispatch") return ["补验始终跑"];
  if (f.event !== "pull_request") return [`事件 ${f.event || "未知"} 始终跑`];
  if (f.headRef.startsWith("train/")) return ["列车 PR 始终跑"];
  if (f.bad.length) return [`改动读不出：${f.bad.slice(0, SHOWN).join("；")}`];
  if (f.changes === null) return ["改动读不出"];
  const hits = [...new Set(f.changes.flatMap((c) => [c.path, ...(c.from ? [c.from] : [])]))].filter((p) => DESKTOP_INPUTS.some((g) => globMatch(g, p)));
  if (!hits.length) return [];
  return [`改了 desktop 输入 ${hits.length} 个：${hits.slice(0, SHOWN).join(", ")}${hits.length > SHOWN ? " …" : ""}`];
}

/** 判定（纯函数）。line 是固定的一行，PM 观察期就抽它。 */
export function decideDesktopScope(f: DesktopScopeFacts): DesktopScopeDecision {
  const must = mustRunReasons(f), wouldSkip = must.length === 0, run = !(wouldSkip && (f.scope === "light" || f.mode === "on"));
  const reasons = wouldSkip ? [`未改 desktop 输入（改动 ${f.changes?.length ?? 0} 个）${run ? `，mode=${f.mode} 照旧跑` : ""}`] : must;
  const verdict = !wouldSkip ? "必须跑" : run ? "本可跳过" : "跳过";
  return { run, wouldSkip, reasons, line: `desktop 范围：mode=${f.mode} 结论=${verdict} 原因=${reasons.join("；")}` };
}

/** PR 合并提交的改动，口径同 scripts/ci-related-plan.ts 的 prSelect；读不出的原因放进 bad。 */
function readChanges(): Pick<DesktopScopeFacts, "changes" | "bad"> {
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  try {
    if (git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").length !== 3) return { changes: null, bad: ["PR 检出不是合并提交"] };
    return parseNameStatus(git("diff", "-z", "--name-status", "-M", "HEAD^1", "HEAD"));
  } catch (e) {
    return { changes: null, bad: [`git diff 失败：${(e as Error).message.replace(/\s+/g, " ").slice(0, 200)}`] };
  }
}

function main(env: Record<string, string | undefined>): void {
  const event = env.GITHUB_EVENT_NAME ?? "", headRef = env.GITHUB_HEAD_REF ?? "", mode = ciDesktopScopeMode(env.CI_DESKTOP_SCOPE);
  // 只有普通 PR 才需要读改动；其余事件不看 diff 就是「必须跑」
  const read = event === "pull_request" && !headRef.startsWith("train/") ? readChanges() : { changes: null, bad: [] };
  const d = decideDesktopScope({ event, headRef, mode, scope: env.CI_PLAN_SCOPE, ...read });
  console.log(d.line);
  console.log(`::notice title=desktop-scope::${d.line}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${d.line}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `run=${d.run}\n`);
}

if (import.meta.main) {
  // 判定器自己出错：作业红、run 输出为空，desktop 作业照旧上 macOS
  try { main(process.env); } catch (e) { console.error(`ci-desktop-scope: ${(e as Error).message}`); process.exit(1); }
}
