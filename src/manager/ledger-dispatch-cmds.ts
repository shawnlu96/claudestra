/**
 * 编排班子的确定性步骤（docs 10-ledger「附：编排班子」）：调度助理 / PM 不再手写审查员 prompt、不再手拼记账命令。
 *   review-pack <T>  只读：按规格卡、交付事件、上一轮结论生成审查员 prompt
 *   dispatch <T>     核对 head → 记 dispatch 事件 → 输出同一份审查包（同一轮重复调用幂等，返回原事件）
 *   escalate <T|->   升级给 PM / owner；bridge 的事件路由据此通知 PM
 * 规格卡与上一轮 md 只读、找不到就在 prompt 里注明，不因此失败；head 对不上才拒绝派审（审错版本比不审更糟）。
 */
import { join } from "node:path";
import { resolveBridgePort } from "../lib/bridge-url.js";
import { repoEnvVar } from "../lib/env-file.js";
import type { LedgerEvent, LedgerTask } from "../lib/ledger-stages.js";
import { getMeta, LedgerError, listEvents } from "../lib/ledger-store.js";
import { appendEvent } from "../lib/ledger-write.js";
import { STATE_DIR, statePath, TMUX_SOCK } from "../lib/paths.js";
import { readTextSoft, specPathFor } from "../lib/task-spec.js";
import { lastReviewOf } from "../lib/ledger-handler.js";
import { buildReviewPack, nextReview, reviewPolicy, type PrevReview, type ReviewPack } from "../lib/review-pack.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** 审查结论统一落在这里：<T>-r<N>.md（对抗式 <T>-r<N>-adv.md），临时文件 <T>-r<N>[-adv]-work/ */
const REVIEWS_DIR = statePath("ledger", "reviews");

/** 规格卡：与 bridge 班子路由同一个定位（lib/task-spec.ts） */
const specPathOf = (c: LedgerCli, task: LedgerTask): string | null => specPathFor(task, getMeta(c.db, task.project).docsDir);

/** 执行者的 worktree = registry 里它的工作目录 */
async function worktreeOf(c: LedgerCli, task: LedgerTask): Promise<string | null> {
  if (!task.agent) return null;
  const info = (await c.deps.loadRegistry()).agents[task.agent] as { cwd?: string; dir?: string } | undefined;
  const dir = info?.cwd ?? info?.dir;
  return dir ? dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~") : null;
}

function gitHead(dir: string): string | null {
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

function toPrev(e: LedgerEvent | undefined): PrevReview | null {
  if (!e) return null;
  const d = e.data;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const path = typeof d.path === "string" && d.path ? d.path : null;
  return {
    round: typeof d.round === "number" ? d.round : null, verdict: typeof d.verdict === "string" ? d.verdict : null,
    p0: n(d.p0), p1: n(d.p1), p2: n(d.p2), path, text: e.text, md: readTextSoft(path),
  };
}

interface PackPlan {
  task: LedgerTask;
  round: number;
  adversarial: boolean;
  worktree: string | null;
  deliverEvent: LedgerEvent | undefined;
  /** 规格卡「审查」那一行，记进 dispatch 事件备查（路由 / currentHandler 自己读规格卡，不依赖它） */
  policy: string | null;
  pack: ReviewPack;
}

/**
 * 第几轮 = task.round（进 review 时 +1，与 deliver / review 事件、通知里的「第 N 轮」同一口径），--round 可覆盖；
 * 同一轮的对抗式另起文件 <T>-r<N>-adv.md，不和常规轮的结论撞名。--adversarial 强制对抗式。
 */
async function plan(c: LedgerCli): Promise<PackPlan> {
  const task = c.task(c.p.pos[1]);
  const events = listEvents(c.db, { project: task.project, target: task.id });
  const reviews = events.filter((e) => e.kind === "review");
  const round = intFlag(c.p, "round") ?? Math.max(task.round, 1);
  if (round < 1) throw new LedgerError("invalid", "--round 从 1 起");
  const lastEvent = reviews.at(-1);
  const prev = toPrev(lastEvent);
  const specPath = specPathOf(c, task);
  const specText = readTextSoft(specPath);
  const policy = reviewPolicy(specText);
  const next = nextReview(policy, lastEvent ? lastReviewOf(lastEvent, events) : null);
  const adversarial = c.p.bools.has("adversarial") || next === "adversarial";
  const worktree = await worktreeOf(c, task);
  const deliverEvent = events.findLast((e) => e.kind === "deliver");
  const dd = deliverEvent?.data ?? {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const tag = `${task.id}-r${round}${adversarial ? "-adv" : ""}`;
  const reviewPath = join(REVIEWS_DIR, `${tag}.md`);
  const pack = buildReviewPack({
    task, round, adversarial, worktree, specPath, specText, prev, reviewPath,
    deliver: deliverEvent ? { headSHA: str(dd.headSHA), evidence: str(dd.evidence), text: deliverEvent.text } : null,
    workDir: join(REVIEWS_DIR, `${tag}-work`),
    prod: { stateDir: STATE_DIR, tmuxSocket: TMUX_SOCK, bridgePort: resolveBridgePort({ BRIDGE_PORT: repoEnvVar("BRIDGE_PORT") }) },
  });
  return { task, round, adversarial, worktree, deliverEvent, policy, pack };
}

async function reviewPack(c: LedgerCli): Promise<Result> {
  const p = await plan(c);
  return { ok: true, task: p.task.id, round: p.round, adversarial: p.adversarial, worktree: p.worktree, ...p.pack };
}

/** worktree 当前 HEAD 必须就是台账记的 head（前缀匹配，短 sha 也认）；定位不到 worktree 或台账没记 head 时跳过并注明 */
function checkHead(p: PackPlan, head: (dir: string) => string | null): string | null {
  const want = p.task.headSHA;
  if (!p.worktree || !want) return `没核对 head：${p.worktree ? "台账没记 headSHA" : "定位不到执行者 worktree"}`;
  const got = head(p.worktree);
  if (!got) return `没核对 head：${p.worktree} 不是 git 目录`;
  if (!got.startsWith(want) && !want.startsWith(got)) {
    throw new LedgerError("conflict", `${p.worktree} 的 HEAD 是 ${got.slice(0, 12)}，台账记的交付是 ${want.slice(0, 12)}：执行者交付后又动了分支，先让它重新 deliver`, { head: got, ledgerHead: want });
  }
  return null;
}

async function dispatch(c: LedgerCli): Promise<Result> {
  const p = await plan(c);
  c.requireManager(p.task.project, "派审查员");
  if (p.task.stage !== "review") throw new LedgerError("invalid", `任务 ${p.task.id} 在 ${p.task.stage}，不在 review，不派审查员`, { stage: p.task.stage });
  const headNote = checkHead(p, c.deps.gitHead ?? gitHead);
  const reviewer = p.adversarial ? "adversarial" : "regular";
  // 去重键带 head 和最后一次交付：同一轮重新交付后再派是新的一次派审（交付不带 head 时 head 没变，只能靠交付序号区分），
  // 不能拿回交付之前那条——它已经不算数了（lib/ledger-handler.ts dispatchKindFor）
  const dkey = `${p.task.headSHA ?? "-"}:d${p.deliverEvent?.seq ?? 0}`;
  const ctx = { ...c.ctx(), dedupKey: c.p.flags.dedup ?? `dispatch:${p.task.id}:r${p.round}:${reviewer}:${dkey}` };
  // policy：派审当时规格卡的审查策略，备查；路由 / currentHandler 判断还要不要审时读的是规格卡本身
  const data = { reviewer, round: p.round, head: p.task.headSHA, path: p.pack.reviewPath, policy: p.policy };
  const r = appendEvent(c.db, ctx, { project: p.task.project, target: p.task.id, kind: "dispatch", text: p.pack.description, data });
  return { ok: true, event: r.event, duplicate: r.duplicate, ...(headNote ? { headNote } : {}), ...p.pack };
}

function escalate(c: LedgerCli): Result {
  const t = c.target(c.p.pos[1]);
  const to = c.p.flags.to ?? "pm";
  if (to !== "pm" && to !== "owner") throw new LedgerError("invalid", "--to 只能是 pm / owner");
  if (t.task && to === "pm") c.requireOwnOrManager(t.task, "升级");
  else c.requireManager(t.project, to === "owner" ? "升级给 owner" : "项目级升级");
  const reason = c.need("reason");
  const r = appendEvent(c.db, c.ctx(), { project: t.project, target: t.target, kind: "escalate", text: reason, data: { to, reason } });
  return { ok: true, event: r.event, duplicate: r.duplicate };
}

export const DISPATCH_CMDS: Record<string, CommandSpec> = {
  "review-pack": { valued: ["round"], bools: ["adversarial"], usage: "review-pack <task> [--adversarial] [--round N]（只读：打印审查员 prompt）", run: reviewPack },
  dispatch: { valued: ["round", "dedup"], bools: ["adversarial"], usage: "dispatch <task> [--adversarial] [--round N]（核对 head、记派审、打印 prompt）", run: dispatch },
  escalate: { valued: ["reason", "to", "project", "dedup"], usage: "escalate <task|-> --reason <原因> [--to pm|owner]", run: escalate },
};
