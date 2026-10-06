/**
 * MAINP2 验收线 8：合入后核对。台账只读（调用方给 LedgerReader 的 query_only 连接），外部事实由调用方现查 GitHub 后传入；
 * 每条沿用（PM 正式 review_main_carry 与引擎 review_carry）都在钉住当时 main 的临时库里重跑 canonical 证明、比对保存的净 diff 摘要与链。
 * 核不了的一律记问题，从不修数据。tests/review-main-carry-manual-verify.test.ts。
 */
import type { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEvent } from "./ledger-stages.js";
import { getTask, listEvents } from "./ledger-store.js";
import { MAIN_CARRY_OP } from "./review-main-carry-manual.js";
import { reviewMainCarryProof, type MainCarryInput } from "./review-main-carry-proof.js";
import { runBounded } from "./run-bounded.js";

const SHA = /^[a-f0-9]{40}$/;
const PR = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/;
type Hop = { head: string; previousHead: string; mainParent: string };
type Proof = Awaited<ReturnType<typeof reviewMainCarryProof>>;

/** GitHub 现查的事实（scripts/pm-merge-preflight.ts verify 填）；mainContainsMerge = compare(mergeSha...main) 为 identical / ahead */
export interface MergedFacts {
  pr: { state: string; baseRefName: string; headRefOid: string; mergeSha: string | null };
  actualMain: string; mainContainsMerge: boolean;
}
export type GitRead = (args: string[]) => Promise<{ code: number; stdout: string }>;
export interface VerifyPorts {
  repoDir: string; git: GitRead; deployConfigured: boolean;
  /** 在钉住 mainHead 的库里跑 canonical 证明；默认 pinnedProof（临时 bare 库借原库对象，不联网） */
  prove?: (input: MainCarryInput) => Promise<Proof>;
}
export interface VerifyReport { ok: boolean; carries: number; mergeSha: string | null; problems: string[] }

/** A bare temporary repo borrowing repoDir's objects, origin bound to the GitHub repository, origin/main pinned to `mainHead`. */
export async function pinnedProof(input: MainCarryInput, command: typeof runBounded = runBounded): Promise<Proof> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const git = async (cwd: string, ...args: string[]) => {
    const r = await command(["git", ...args], { cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 30_000 });
    if (r.timedOut || r.code !== 0) throw new Error(`git ${args[0]} 失败：${r.stderr.trim().split("\n")[0]?.slice(0, 200) ?? ""}`);
    return r.stdout.trim();
  };
  const dir = await mkdtemp(join(tmpdir(), "main-carry-verify-"));
  try {
    const objects = join(await git(input.repoDir, "rev-parse", "--path-format=absolute", "--git-common-dir"), "objects");
    await git(dir, "init", "-q", "--bare");
    await writeFile(join(dir, "objects", "info", "alternates"), `${objects}\n`);
    await git(dir, "remote", "add", "origin", `https://github.com/${input.repository}.git`);
    await git(dir, "update-ref", "refs/remotes/origin/main", input.mainHead);
    return await reviewMainCarryProof({ ...input, repoDir: dir }); // its own complete-byte git reader, as the formal entry uses
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Every carry event that leads to `head`, oldest first: formal PM decisions and the engine's own scheduler carries. */
function carryChain(events: readonly LedgerEvent[], head: string): LedgerEvent[] {
  const all = events.filter((e) => (e.kind === "decision" && e.data.op === MAIN_CARRY_OP) || (e.kind === "scheduler" && e.data.op === "review_carry"));
  const out: LedgerEvent[] = [];
  let at = head, before = Infinity;
  for (let c = all.findLast((e) => e.seq < before && e.data.to === at); c; c = all.findLast((e) => e.seq < before && e.data.to === at)) {
    out.unshift(c);
    [at, before] = [String(c.data.from), c.seq];
  }
  return out;
}

const sameChain = (a: unknown, b: readonly Hop[]): boolean => Array.isArray(a) && a.length === b.length &&
  a.every((h: Hop, i) => h?.head === b[i]!.head && h?.previousHead === b[i]!.previousHead && h?.mainParent === b[i]!.mainParent);

async function checkCarry(c: LedgerEvent, repository: string, ports: VerifyPorts, problems: string[]): Promise<void> {
  const { from, to, mainHead, diffHash } = c.data as Record<string, unknown>;
  const label = `沿用 #${c.seq}（${String(from).slice(0, 12)} → ${String(to).slice(0, 12)}）`;
  if (![from, to, mainHead].every((v) => typeof v === "string" && SHA.test(v)) || typeof diffHash !== "string") {
    problems.push(`${label} 缺 from / to / mainHead / diffHash，核不了`);
    return;
  }
  let proof: Proof;
  try {
    proof = await (ports.prove ?? pinnedProof)({ repoDir: ports.repoDir, repository, base: "main", mainHead: mainHead as string,
      oldHead: from as string, newHead: to as string });
  } catch (e) { problems.push(`${label} 重跑证明失败：${(e as Error).message.slice(0, 200)}`); return; }
  if (!proof.ok) { problems.push(`${label} 重跑证明不成立：${proof.reason}`); return; }
  if (proof.diffHash !== diffHash) problems.push(`${label} 净 diff 摘要与记录不一致`);
  if (c.data.chain !== undefined && !sameChain(c.data.chain, proof.chain)) problems.push(`${label} 记录的链与重跑的链不一致`);
  if (c.kind === "decision" && c.data.chain === undefined) problems.push(`${label} 正式沿用没有保存完整链`);
}

function checkDeploy(db: Database, taskId: string, mergeSha: string | null, configured: boolean, problems: string[]): void {
  const has = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_deploys'").get();
  const rows = has ? db.query("SELECT phase, mergeSha, outcome FROM scheduler_deploys WHERE taskId=? ORDER BY updatedAt").all(taskId) as
    { phase: string; mergeSha: string; outcome: string | null }[] : [];
  for (const r of rows) if (r.mergeSha !== mergeSha) problems.push(`部署记录的合并提交 ${r.mergeSha.slice(0, 12)} 不是 GitHub 的合并提交`);
  if (!configured) return;
  if (!rows.some((r) => r.phase === "deployed" && r.outcome === "success" && r.mergeSha === mergeSha)) {
    problems.push("项目配了部署目标，但台账没有这次合并提交的成功部署记录（部署无法核实）");
  }
}

/** Read-only: the merged PR, actual main, the local merge commit, every carry re-proved, and the deploy record must all agree. */
export async function verifyMergedCarry(db: Database, taskId: string, facts: MergedFacts, ports: VerifyPorts): Promise<VerifyReport> {
  const problems: string[] = [];
  const task = getTask(db, taskId);
  if (!task) return { ok: false, carries: 0, mergeSha: null, problems: [`台账没有 ${taskId}`] };
  const repository = PR.exec(task.pr ?? "")?.[1];
  const { pr } = facts, mergeSha = pr.mergeSha && SHA.test(pr.mergeSha) ? pr.mergeSha : null;
  if (!repository) problems.push("任务没有合法的 GitHub PR");
  if (pr.state !== "MERGED" || pr.baseRefName !== "main") problems.push(`PR 不是已合入 main：${pr.state}/${pr.baseRefName}`);
  if (!mergeSha) problems.push("GitHub 没给出完整的合并提交");
  if (!task.headSHA || pr.headRefOid !== task.headSHA) problems.push(`台账 head ${task.headSHA?.slice(0, 12) ?? "空"} 不是 GitHub 合入的 head ${pr.headRefOid.slice(0, 12)}`);
  if (!SHA.test(facts.actualMain) || !facts.mainContainsMerge) problems.push("合并提交不在 GitHub 当前 main 上");
  if (mergeSha) {
    const r = await ports.git(["rev-list", "--parents", "-n", "1", mergeSha]);
    const [self, ...parents] = r.stdout.trim().toLowerCase().split(/\s+/);
    if (r.code !== 0 || self !== mergeSha || !parents.includes(pr.headRefOid)) problems.push("本地读不到合并提交，或它的父提交不含合入的 head");
  }
  const events = listEvents(db, { project: task.project, target: task.id });
  const chain = task.headSHA ? carryChain(events, task.headSHA) : [];
  const base = chain[0] ? String(chain[0].data.from) : task.headSHA;
  if (!events.some((e) => e.kind === "review" && e.data.head === base && e.data.round === task.round && e.data.verdict === "pass")) {
    problems.push(`沿用链起点 ${base?.slice(0, 12) ?? "空"} 没有本轮 PASS 审查`);
  }
  if (repository) for (const c of chain) await checkCarry(c, repository, ports, problems);
  checkDeploy(db, task.id, mergeSha, ports.deployConfigured, problems);
  return { ok: problems.length === 0, carries: chain.length, mergeSha, problems };
}
