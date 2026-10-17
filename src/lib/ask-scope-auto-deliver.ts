import { isDeepStrictEqual } from "node:util";
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask, listEvents } from "./ledger-store.js";
import { getAsk } from "./ledger-asks.js";
import type { ScopeDiff, ScopeFile } from "./order-deliver-scope-git.js";
import { cardGlobs, privateCardRepo } from "./card-repo.js";
import type { RecoveryMode, RecoveryPolicyPort } from "./recovery-policy.js";
import { headScan, JUDGE_GLOBS } from "./skip-effects-auto-scope.js";
import { ASK_SCOPE_RULE } from "./ask-scope-auto.js";
import { scopeMatches } from "./ask-scope-auto-plan.js";
import { judgeScopeFile } from "./ask-scope-auto-diff.js";
import { checkTestScopeSize, type TestScopeEvidence } from "./order-ask-test-scope-size.js";
import type { ScopeProof } from "./ask-scope-auto-proof.js";
import { scopeProtected, type ScopeGrant } from "./ask-scope-registry.js";

interface CheckedFile { path: string; added: number | null; deleted: number | null; askId: string; kind: string; check: string; granted: boolean; reason: string | null }
interface Candidate { askId: string; grant: ScopeGrant }

function grantsFor(db: Database, task: LedgerTask): Candidate[] {
  return listEvents(db, { target: task.id }).filter((e) => e.data.op === "ask_scope_auto" && e.data.rule === ASK_SCOPE_RULE
    && e.data.specRev === task.specRev && e.project === task.project && e.target === task.id && e.actor === "system:ask-scope-auto").flatMap((e) => {
    const askId = String(e.data.askId), ask = getAsk(db, askId);
    if (ask?.state !== "answered" || ask.taskId !== task.id || ask.extra.askScopeAuto !== true || !Array.isArray(e.data.grants)
      || !isDeepStrictEqual(e.data.grants, ask.extra.scopeGrants)) return [];
    return (e.data.grants as ScopeGrant[]).map((grant) => ({ askId, grant }));
  });
}

async function proofOf(diff: ScopeDiff, task: LedgerTask, head: string, mergeBase: string): Promise<ScopeProof> {
  const objects = diff.objects!, globs = cardGlobs(task);
  const [oldPaths, paths] = await Promise.all([objects.list(mergeBase, "src"), objects.list(head, "src")]);
  const old = new Set(oldPaths), next = new Set(paths);
  const wanted = [...new Set([...paths, ...oldPaths])].filter((p) => scopeMatches(p, globs));
  if (wanted.length > 512) throw new Error("本卡定义文件过多，转人工核对");
  const sources = new Map<string, string>(), baseSources = new Map<string, string>();
  let bytes = 0;
  for (const path of wanted) {
    const text = await objects.show(next.has(path) ? head : mergeBase, path);
    bytes += Buffer.byteLength(text);
    if (bytes > 4 * 1024 * 1024) throw new Error("本卡定义超过核对上限");
    if (next.has(path)) sources.set(path, text);
    if (old.has(path)) {
      const prior = next.has(path) ? await objects.show(mergeBase, path) : text;
      bytes += Buffer.byteLength(prior);
      if (bytes > 4 * 1024 * 1024) throw new Error("本卡定义超过核对上限");
      baseSources.set(path, prior);
    }
  }
  return { globs, sources, baseSources, newFiles: new Set(paths.filter((p) => !old.has(p))) };
}

async function checkCandidates(diff: ScopeDiff, task: LedgerTask, head: string, candidates: Candidate[], files: ScopeFile[]): Promise<CheckedFile[]> {
  const objects = diff.objects!, mergeBase = await objects.mergeBase(diff.base, head);
  const proof = await proofOf(diff, task, head, mergeBase), out: CheckedFile[] = [];
  for (const file of files) {
    const candidate = candidates.find((c) => c.grant.path === file.path);
    if (!candidate) continue;
    const { askId, grant } = candidate;
    let reason: string | null = null;
    if (file.added === null || file.deleted === null) reason = "二进制改动";
    else if (proof.newFiles.has(file.path)) reason = "目标文件必须已存在";
    else if (grant.kind === "wire" && (file.deleted !== 0 || file.added < 2 || file.added > 4)) reason = "接线新增/删除行数超出承诺";
    else if (["manager", "skip-commands", "command-rules", "services"].includes(grant.kind) && file.deleted !== 0) reason = "登记命令只能新增";
    else {
      const [base, next] = await Promise.all([objects.show(mergeBase, file.path), objects.show(head, file.path)]);
      if (grant.kind === "effects" && !proof.scan) proof.scan = await headScan(objects, head);
      reason = judgeScopeFile(grant, base, next, proof);
    }
    out.push({ ...file, askId, kind: grant.kind, check: grant.check, granted: !reason, reason });
  }
  if (await objects.prHead() !== head) throw new Error("PR head 已漂移");
  return out;
}

/** Called beside SKIPAUTO1. Keep the original file list so a later policy rollback cannot hide delivered changes. */
export async function checkDeliveredScope(db: Database, task: LedgerTask, head: string, diff: ScopeDiff, files: ScopeFile[], policy: RecoveryPolicyPort):
  Promise<{ askScopeAuto?: { rule: string; caseFold: RecoveryMode; head: string; base: string; files: CheckedFile[] }; askScopeTests?: TestScopeEvidence }> {
  const tests = await checkTestScopeSize(db, task, head, diff);
  const candidates = grantsFor(db, task).filter((c) => files.some((f) => f.path === c.grant.path));
  if (!candidates.length || policy(task.project, "askScopeAuto").mode !== "on") return tests;
  // The registry's protection switch belongs to Claudestra, including cards in other local projects.
  const caseFold = policy("claude-orchestrator", "askScopeCaseFold").mode;
  let checked: CheckedFile[];
  try {
    if (!diff.filesComplete || !diff.objects || privateCardRepo(task)) throw new Error("完整 diff / Git 对象不可用或不是本仓卡");
    if (diff.files.some((f) => scopeProtected(f.path))) throw new Error("本次交付修改了自动授权判定器或权限基线");
    if (candidates.some((c) => c.grant.kind === "effects") && diff.files.some((f) => scopeMatches(f.path, JUDGE_GLOBS))) {
      throw new Error("本次交付修改了 skip-effects 扫描规则");
    }
    checked = await checkCandidates(diff, task, head, candidates, files);
    const current = getTask(db, task.id);
    if (!current || current.specRev !== task.specRev || policy(task.project, "askScopeAuto").mode !== "on") throw new Error("核对期间规格或开关已变化");
    if (policy("claude-orchestrator", "askScopeCaseFold").mode !== caseFold) throw new Error("核对期间折叠口径已变化");
    const active = grantsFor(db, current);
    if (candidates.some((c) => !active.some((a) => a.askId === c.askId && isDeepStrictEqual(a.grant, c.grant)))) throw new Error("核对期间自动答已撤回");
  } catch (e) {
    checked = candidates.map(({ askId, grant }) => ({ ...files.find((f) => f.path === grant.path)!, askId,
      kind: grant.kind, check: grant.check, granted: false, reason: (e as Error).message.slice(0, 300) }));
  }
  return { ...tests, askScopeAuto: { rule: ASK_SCOPE_RULE, caseFold, head, base: diff.base, files: checked } };
}

export { describeDeliveredScope } from "./ask-scope-auto-display.js";
