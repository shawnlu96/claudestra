/**
 * i28-M8 deliver 查 PR：合并驱动只认 task.pr 上完整的 PR URL（scheduler-merge.ts），执行者手填总漏，所以交付时 bridge 自己查。
 * - findPrRows：在调用方 cwd 认出 origin 的 owner/repo，跑 `gh pr list --repo <它> --head <branch> --state open`，输出严格解析
 *   （不是数组、字段缺、多字段、类型不对都拒），任何一行 PR 不在 origin 仓也拒。
 * - pickPr：恰好一个、非跨仓、base 是 main、headRefOid 等于交付 head、url 是完整 PR URL 才通过；其余一律拒，调用方什么都不写。
 * - prConflict：卡上已有的完整 URL 和查到的不同 → 拒（PR 换了要 PM 处理）；空或非完整（如 `306`）可被替换。
 *   lib/ledger-write.ts deliver 在写入的同一事务里再核一次，MCP 侧的预检只为早给原因。tests/order-deliver-pr.test.ts。
 */
import { LedgerError } from "./ledger-store.js";
import type { BoundedResult } from "./run-bounded.js";

/** 完整 PR URL（owner 名按 GitHub 规则，仓库名不许 . / ..）；末尾斜杠允许，比较前去掉 */
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?\/)[\w.-]{1,100}\/pull\/[1-9]\d{0,6}\/?$/;
/** git 分支名里能出现、又不会被当成选项或路径穿越的字符；台账写 branch 时不校验形状，查 origin / gh 前都兜一次 */
export const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const BASE = "main";
const FIELDS = ["url", "headRefOid", "baseRefName", "isCrossRepository"] as const;

export interface PrRow {
  url: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
}

export type PrRows = { ok: true; rows: PrRow[] } | { ok: false; error: string };
export type PrPick = { ok: true; url: string } | { ok: false; code: "pr_missing" | "pr_ambiguous" | "pr_invalid" | "pr_head_mismatch"; error: string };

/** 完整 PR URL 的规范形（去末尾斜杠）；不是完整 URL = null */
export function fullPrUrl(s: string | null | undefined): string | null {
  return typeof s === "string" && PR_URL.test(s) ? s.replace(/\/$/, "") : null;
}

/** 卡上已有的 pr 与要写的冲突吗：已有完整 URL 且不同才算；空 / 非完整的旧值（`306`、`#306`）可被替换 */
export function prConflict(existing: string | null | undefined, found: string): boolean {
  const cur = fullPrUrl(existing);
  return cur !== null && cur !== fullPrUrl(found);
}

/** `ledger deliver --pr` 在事务里的那一步（lib/ledger-write.ts deliver）：不是完整 URL → invalid；卡上已是另一个完整 URL → conflict，不覆盖；
 *  卡上空或非完整 → 写规范形；相同 → 不动。抛错时整笔交付回滚 */
export function deliverPrPatch(task: { id: string; pr: string | null }, pr: string | undefined): { pr?: string } {
  if (pr === undefined) return {};
  const url = fullPrUrl(pr);
  if (!url) throw new LedgerError("invalid", "--pr 要是完整的 https://github.com/<owner>/<repo>/pull/<n>");
  if (prConflict(task.pr, url)) throw new LedgerError("conflict", `任务 ${task.id} 的 PR 已是 ${task.pr}，和这次的 ${url} 不同：PR 换了要 PM 处理，不覆盖`, { pr: task.pr });
  return fullPrUrl(task.pr) ? {} : { pr: url };
}

function asRow(v: unknown): PrRow | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== FIELDS.length || !FIELDS.every((k) => k in o)) return null;
  const { url, headRefOid, baseRefName, isCrossRepository } = o;
  if (typeof url !== "string" || typeof headRefOid !== "string" || typeof baseRefName !== "string" || typeof isCrossRepository !== "boolean") return null;
  return { url, headRefOid, baseRefName, isCrossRepository };
}

/** 解析 gh 的输出：超时 / 非零退出 / 不是 JSON 数组 / 任何一行形状不对 → 失败（不挑出能用的几行） */
export function parseGhPrList(r: BoundedResult): PrRows {
  if (r.timedOut) return { ok: false, error: "gh pr list 超时，查不到这个分支的 PR" };
  if (r.code !== 0) return { ok: false, error: `gh pr list 失败（exit ${r.code}）：${r.stderr.trim().split("\n").pop()?.slice(0, 200) ?? ""}` };
  let data: unknown;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    // 输出不是 JSON：按查询失败拒交付，原因写进回执，不会静默放过
    return { ok: false, error: "gh pr list 的输出不是 JSON" };
  }
  if (!Array.isArray(data)) return { ok: false, error: "gh pr list 的输出不是数组" };
  const rows = data.map(asRow);
  if (rows.some((x) => x === null)) return { ok: false, error: "gh pr list 的输出字段缺失或类型不对" };
  return { ok: true, rows: rows as PrRow[] };
}

type Runner = (argv: string[], o: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs: number }) => Promise<BoundedResult>;

const TIMEOUT_MS = 15_000;
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO = "(?!\\.\\.?(?:\\.git)?$)[\\w.-]{1,100}?";
/** origin 只认这两种写法（.git 后缀可选）；ssh://、带凭据、别的主机一律不认，宁可拒交付也不猜 */
const ORIGIN_RE = [new RegExp(`^https://github\\.com/(${OWNER})/(${REPO})(?:\\.git)?$`), new RegExp(`^git@github\\.com:(${OWNER})/(${REPO})(?:\\.git)?$`)];

/** `git remote get-url origin` 的输出 → `owner/repo`；不是 GitHub 或格式不对 = null */
export function parseOriginRepo(url: string): string | null {
  const s = url.trim();
  for (const re of ORIGIN_RE) {
    const m = re.exec(s);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

/** 完整 PR URL 属于 owner/repo 吗（GitHub 的 owner / 仓库名不分大小写） */
export function prInRepo(url: string, repo: string): boolean {
  const full = fullPrUrl(url);
  const m = full ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/.exec(full) : null;
  return m !== null && m[1].toLowerCase() === repo.toLowerCase();
}

async function originRepo(cwd: string, run: Runner): Promise<{ ok: true; repo: string } | { ok: false; error: string }> {
  const r = await run(["git", "remote", "get-url", "origin"], { cwd, timeoutMs: TIMEOUT_MS });
  if (r.timedOut) return { ok: false, error: "git remote get-url origin 超时，认不出 origin 仓，没法查 PR" };
  if (r.code !== 0) return { ok: false, error: `git remote get-url origin 失败（exit ${r.code}），认不出 origin 仓，没法查 PR` };
  const repo = parseOriginRepo(r.stdout);
  if (!repo) return { ok: false, error: `origin ${r.stdout.trim().slice(0, 120)} 不是 GitHub 仓库地址（https://github.com/<owner>/<repo> 或 git@github.com:<owner>/<repo>），没法查 PR` };
  return { ok: true, repo };
}

/** bridge 的真实 findPr：在调用方工作目录里认出 origin 仓，再显式 `--repo` 跑 gh（argv 不经 shell，分支名先过 BRANCH）。
 *  不带 --repo 时 gh 会听 GH_REPO / repo set-default，镜像仓同名分支的 PR 就会被当成本卡的写进 task.pr；所以 env 去掉 GH_REPO，
 *  查到的每一行还要在 origin 仓里，有一行不在就整次拒 */
export async function findPrRows(cwd: string | undefined, branch: string, run: Runner): Promise<PrRows> {
  if (!cwd) return { ok: false, error: "registry 里没有调用方的工作目录，没法查 PR" };
  if (!BRANCH.test(branch)) return { ok: false, error: `台账里的分支名 ${branch.slice(0, 80)} 不合法` };
  const origin = await originRepo(cwd, run);
  if (!origin.ok) return origin;
  const argv = ["gh", "pr", "list", "--repo", origin.repo, "--head", branch, "--state", "open", "--json", FIELDS.join(",")];
  const env: Record<string, string | undefined> = { ...process.env, GH_PROMPT_DISABLED: "1" };
  delete env.GH_REPO;
  const res = parseGhPrList(await run(argv, { cwd, env, timeoutMs: TIMEOUT_MS }));
  if (!res.ok) return res;
  const stray = res.rows.find((p) => !prInRepo(p.url, origin.repo));
  if (stray) return { ok: false, error: `PR 不在 origin 仓 ${origin.repo}：gh 返回了 ${stray.url.slice(0, 200)}` };
  return res;
}

/** 从查到的 open PR 里挑出交付对应的那一个 */
export function pickPr(rows: PrRow[], branch: string, head: string): PrPick {
  if (rows.length === 0) return { ok: false, code: "pr_missing", error: `分支 ${branch} 在 origin 上没有 open 的 PR：先开 PR（base ${BASE}）再 deliver，链接由 deliver 自动登记` };
  if (rows.length > 1) return { ok: false, code: "pr_ambiguous", error: `分支 ${branch} 有 ${rows.length} 个 open 的 PR，认不出是哪个：关掉多余的再 deliver` };
  const [p] = rows;
  const url = fullPrUrl(p.url);
  if (!url) return { ok: false, code: "pr_invalid", error: "gh 给的 PR 链接不是完整的 https://github.com/<owner>/<repo>/pull/<n>" };
  if (p.isCrossRepository) return { ok: false, code: "pr_invalid", error: `${url} 是从 fork 发的跨仓 PR，分支要在 origin 上` };
  if (p.baseRefName !== BASE) return { ok: false, code: "pr_invalid", error: `${url} 的 base 是 ${p.baseRefName.slice(0, 80)}，不是 ${BASE}` };
  if (!SHA40.test(p.headRefOid) || p.headRefOid !== head) {
    return { ok: false, code: "pr_head_mismatch", error: `${url} 的 head 是 ${p.headRefOid.slice(0, 40)}，不是 ${head}：GitHub 可能还没同步，稍后重试` };
  }
  return { ok: true, url };
}
