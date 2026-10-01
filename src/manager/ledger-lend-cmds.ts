/**
 * `ledger lend-*`（T93，docs/design/remote-capacity.md §2.2、§3）：
 * - PM：lend-offer / lend-cancel / lend-reoffer 挂单、撤单、重挂；lend-orders 查这张卡的出借单；lend-reclaim 收回写代码（i28-R6）。
 *   挂什么看卡的阶段：review = 审查单，build = 开工单（从 --base 切出借分支），fix = 修复单（只派回持有写租约的出借方，带上一轮审查报告原文）。
 * - bridge 专用（owner 身份，local-api/lend.ts 经 runManager 调）：lend-poll / lend-claim / lend-lease / lend-write / lend-sweep / lend-pin。
 *   每次先把过期的租约结成 unknown 并通知 PM（不自动重派），再按请求做一次 CAS；拒绝码放在 current.lend 里给 bridge 映射。
 * lend-write 的幂等键是请求体原文的 sha256：bridge 把请求体原样当参数传进来；带 deliver 的是写单交付（ledger-lend-result.ts）。
 * tests/ledger-lend.test.ts、tests/ledger-lend-write.test.ts。
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { keyFingerprint, signPurpose } from "../lib/instance-key.js";
import { readLend, type BorrowEntry, type LendFamily, REPO_RE } from "../lib/lend-config.js";
import { effectiveLend, readLendContext } from "../lib/lend-policy.js";
import { remoteHeadAt, stepOfStage } from "../lib/lend-git.js";
import { writeMaterials } from "../lib/lend-write-materials.js";
import { isDeliverRequest, LEND_VERSION, parseLendRequest, type LendEndpoint } from "../lib/lend-wire.js";
import { cancelLend, claimLend, leaseLend, listLendOrders, offerLend, pollLend, reclaimLend, refuse, reofferLend, sweepLend, type LendNotice,
  type OfferInput } from "../lib/ledger-lend.js";

import { heldLease } from "../lib/ledger-lend-lease.js";
import { placementOf } from "../lib/lend-placement-view.js";
import { lendPeerCmds, type BranchState } from "./ledger-lend-peer-cmds.js";
import { RECEIPT_PURPOSE, writeLendDeliver, writeLendResult, type LendDeliverDeps, type LendResultDeps } from "../lib/ledger-lend-result.js";
import { readPeers } from "../lib/peers.js";
import { runBounded } from "../lib/run-bounded.js";
import { getMeta, LedgerError } from "../lib/ledger-store.js";
import { appendEvent } from "../lib/ledger-write.js";
import type { LedgerTask } from "../lib/ledger-stages.js";
import { statePath } from "../lib/paths.js";
import { notifyProjectPm } from "../lib/pm-notify.js";
import { readSchedulerConfig, type RemotePolicy } from "../lib/scheduler-config.js";
import { readEffectiveBorrow } from "../lib/scheduler-pool-borrow.js";
import { writeTextAtomicSync } from "../lib/state-file.js";
import { readTextSoft, specPathFor } from "../lib/task-spec.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** Tests inject all three; production reads lend.json + peers + projects fresh on every call (a revoked borrow applies at once). */
export interface LendCliDeps {
  borrow(): Promise<BorrowEntry[]>;
  notifyPm(project: string, text: string): Promise<void>;
  /** 审查结论与写单交付共用（报告目录、写报告、签回执）；写单另要查远端 head 与对方指纹（只测审查的注入可以不给） */
  result: LendResultDeps & Partial<Pick<LendDeliverDeps, "remoteHead" | "peerFp">>;
  /** v2 收回核对（i28-W2）：订单分支在远端的状态；不给 = 真 git ls-remote */
  branchState?: (repo: string, branch: string) => Promise<BranchState>;
  /** 槽池放置要的项目调度策略（i28-W5）；不给 = 读真 scheduler.json */
  schedulerPolicy?: (project: string) => { remote?: RemotePolicy; maxActiveWorkers: number } | null;
}

function realLendDeps(c: LedgerCli): LendCliDeps {
  return {
    borrow: async () => {
      const [read, ctx] = await Promise.all([readLend(), readLendContext()]);
      return effectiveLend(read, ctx.contacts, ctx.projects).borrow;
    },
    notifyPm: (project, text) => notifyProjectPm(c.db, project, text, { fromName: "lend" }),
    result: {
      reportDir: (o) => statePath("ledger", "reviews", `${o.taskId}-r${o.round}`),
      writeReport: (path, body) => {
        mkdirSync(dirname(path), { recursive: true });
        writeTextAtomicSync(path, body);
      },
      sign: (fields) => signPurpose(RECEIPT_PURPOSE, fields),
      remoteHead: (repo, branch) => remoteHeadAt(repo, branch, runBounded),
      peerFp: async (peer) => {
        const rec = ((await readPeers()).httpPeers ?? []).find((p) => p.name === peer && !p.disabled);
        return rec?.publicKey ? keyFingerprint(rec.publicKey) : null;
      },
    },
  };
}

const lendDeps = (c: LedgerCli): LendCliDeps => c.deps.lend ?? realLendDeps(c);

/** Also the scheduler's pool step (ledger-scheduler-cmds.ts): the same injected / real probes for a write order's materials. */
export function writeDeps(c: LedgerCli): LendDeliverDeps {
  const r = lendDeps(c).result;
  if (!r.remoteHead || !r.peerFp) throw new LedgerError("invalid", "这台机器没接上写单要的远端查询（注入缺 remoteHead / peerFp）");
  return { ...(r as LendDeliverDeps), now: () => c.deps.now() };
}
const PEER_RE = /^[\p{L}\p{N}_.-]{1,64}$/u;

async function borrowOf(c: LedgerCli, peer: string): Promise<(project: string) => BorrowEntry | null> {
  const entry = (await lendDeps(c).borrow()).find((b) => b.peer === peer) ?? null;
  return (project) => (entry?.projects.includes(project) ? entry : null);
}

/** Notices go out after the transaction; a lost one is logged, the order already sits in `unknown` for PM to see. */
async function tell(c: LedgerCli, notices: LendNotice[]): Promise<number> {
  let sent = 0;
  for (const n of notices) {
    try {
      await lendDeps(c).notifyPm(n.project, n.text);
      sent++;
    } catch (e) {
      console.error(`⚠️ 出借通知 PM 失败（${n.taskId}）：${(e as Error).message}`);
    }
  }
  return sent;
}

/** 修复单缺省派回持有写租约的出借方与仓库（「优先派回同一出借方」）；别的单 --peer / --repo 必填 */
function offerPeer(c: LedgerCli, task: LedgerTask): { peer: string; repo: string } {
  const lease = stepOfStage(task.stage) === "fix" ? heldLease(c.db, task) : null;
  const { peer = lease?.peer, repo = lease?.repo } = c.p.flags;
  if (!peer || !PEER_RE.test(peer)) throw new LedgerError("invalid", "--peer <peer 名> 必填");
  if (!repo || !REPO_RE.test(repo)) throw new LedgerError("invalid", "--repo <owner/name> 必填（只给对方 GitHub 坐标）");
  return { peer, repo };
}

function offerInput(c: LedgerCli, task: LedgerTask, borrow: BorrowEntry | null): OfferInput {
  const { family = "codex" } = c.p.flags;
  const { peer, repo } = offerPeer(c, task);
  // 表和接口按两家留了位置，这一切片只借 Codex（T93 规格；r1 P2-4）
  if (family !== "codex") throw new LedgerError("invalid", `这一版只借 Codex，--family 只能是 codex（不是 ${family}）`);
  const prFlag = c.p.flags.pr ?? task.pr?.match(/(\d+)\/?$/)?.[1];
  const pr = prFlag === undefined ? null : Number(prFlag);
  if (pr !== null && (!Number.isInteger(pr) || pr < 1)) throw new LedgerError("invalid", "--pr 要是 PR 编号");
  const spec = readTextSoft(specPathFor(task, getMeta(c.db, task.project).docsDir));
  if (!spec) throw new LedgerError("invalid", `找不到 ${task.id} 的规格卡原文（对方读不到本机文件，要内联进派单）`);
  return { taskId: task.id, peer, family: family as LendFamily, repo, pr: stepOfStage(task.stage) === "write" ? null : pr, spec, borrow };
}

/** 写单材料（lib/lend-write-materials.ts，调度服务挂池同一份）：查远端 / 读文件失败一律拒挂，不带半张单出去 */
async function withWrite(c: LedgerCli, task: LedgerTask, input: OfferInput): Promise<OfferInput> {
  const step = stepOfStage(task.stage);
  if (step !== "write" && step !== "fix") return input;
  const write = await writeMaterials(c.db, task, { peer: input.peer, repo: input.repo, base: c.p.flags.base ?? "main" }, writeDeps(c));
  return write ? { ...input, write } : input;
}

async function offer(c: LedgerCli, again: boolean): Promise<Result> {
  const task = c.task(c.p.pos[1]);
  c.requireManager(task.project, again ? "重挂出借单" : "挂出借单");
  const peer = offerPeer(c, task).peer;
  const input = await withWrite(c, task, offerInput(c, task, (await borrowOf(c, peer))(task.project)));
  const reason = c.p.flags.reason ?? "";
  if (again && !reason.trim()) throw new LedgerError("invalid", "重挂要写 --reason（核对了什么）");
  const o = again ? reofferLend(c.db, c.ctx(), { ...input, reason }) : offerLend(c.db, c.ctx(), input);
  return { ok: true, orderId: o.orderId, step: o.step, peer: o.peer, family: o.family, sha256: o.sha256, supersedes: o.supersedes,
    ...(o.branch ? { branch: o.branch, base: o.base } : {}) };
}

function reclaim(c: LedgerCli): Result {
  const task = c.task(c.p.pos[1]);
  const reason = c.p.flags.reason ?? "";
  if (!reason.trim()) throw new LedgerError("invalid", "收回要写 --reason");
  const r = reclaimLend(c.db, c.ctx(), { taskId: task.id, reason });
  return { ok: true, task: task.id, peer: r.lease?.peer ?? null, cancelled: r.cancelled };
}

function cancel(c: LedgerCli): Result {
  const task = c.task(c.p.pos[1]);
  const reason = c.p.flags.reason ?? "";
  if (!reason.trim()) throw new LedgerError("invalid", "撤单要写 --reason");
  const o = cancelLend(c.db, c.ctx(), { taskId: task.id, reason });
  return { ok: true, orderId: o.orderId, status: o.status };
}

/** 这张卡的出借单 + 当前节点放哪、为什么（i28-W5，与调度器下一轮用同一套规则）；读策略 / 借入名单失败只影响 placement 一栏 */
async function orders(c: LedgerCli): Promise<Result> {
  const task = c.task(c.p.pos[1]);
  const rows = listLendOrders(c.db, task.id).map(({ wire: _w, text: _t, ...o }) => o);
  let placement: Record<string, unknown>;
  try {
    const policy = (c.deps.lend?.schedulerPolicy ?? ((p: string) => readSchedulerConfig().projects[p] ?? null))(task.project);
    const remote = policy?.remote;
    const borrow = remote && remote.mode !== "off" ? await (c.deps.lend?.borrow() ?? readEffectiveBorrow()) : [];
    placement = placementOf(c.db, task, policy, borrow, c.deps.now());
  } catch (e) {
    placement = { error: `算不出放置：${(e as Error).message}` };
  }
  return { ok: true, task: task.id, orders: rows, placement };
}

/** Bridge-only entry: owner identity (the bridge has no channel), `-- <peer> <json>`, expiries swept and told first. */
async function bridgeCall(c: LedgerCli, endpoint: LendEndpoint): Promise<Result> {
  if (c.deps.actor !== "owner") throw new LedgerError("forbidden", "lend 接口命令只给 bridge 用（以 owner 身份调）");
  const [, peer, raw] = c.p.pos;
  if (!peer || !PEER_RE.test(peer)) throw new LedgerError("invalid", "peer 名不合法");
  const notified = await tell(c, sweepLend(c.db, c.ctx()));
  let body: unknown;
  try {
    body = JSON.parse(raw ?? "");
  } catch {
    return refuse("invalid", "请求体不是合法 JSON");
  }
  const req = parseLendRequest(endpoint, body);
  if (!req.ok) return refuse("invalid", req.error);
  const v = LEND_VERSION;
  if (endpoint === "poll") return { ok: true, v, ...pollLend(c.db, peer, req.value as never, await borrowOf(c, peer), c.ctx().now), notified };
  if (endpoint === "claim") {
    const r = claimLend(c.db, c.ctx(), peer, req.value as never, await borrowOf(c, peer));
    return "stale" in r ? refuse("cancelled", "卡已推进，这一单已作废") : { ok: true, v, ...r };
  }
  if (endpoint === "lease") {
    const r = leaseLend(c.db, c.ctx(), peer, req.value as never);
    return { ok: true, v, lease: r.lease, notified: notified + (await tell(c, r.notices)) };
  }
  const sha = createHash("sha256").update(raw as string, "utf8").digest("hex");
  const payload = req.value as Parameters<typeof isDeliverRequest>[0];
  const receipt = isDeliverRequest(payload) ? await writeLendDeliver(c.db, c.ctx(), peer, payload, sha, writeDeps(c))
    : writeLendResult(c.db, { actor: `peer:${peer}`, now: c.deps.now() }, peer, payload, sha, lendDeps(c).result);
  return { ok: true, v, receipt };
}

async function sweep(c: LedgerCli): Promise<Result> {
  if (c.deps.actor !== "owner") throw new LedgerError("forbidden", "lend-sweep 只给 bridge 用（以 owner 身份调）");
  const notices = sweepLend(c.db, c.ctx());
  return { ok: true, expired: notices.length, notified: await tell(c, notices) };
}

const FP_RE = /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/;

/** 对方公钥刚钉住：借它算力的每个项目记一条项目级事件（同一把钥匙只记一次）；不借给我们的 peer 不记 */
async function pinned(c: LedgerCli): Promise<Result> {
  if (c.deps.actor !== "owner") throw new LedgerError("forbidden", "lend-pin 只给 bridge 用（以 owner 身份调）");
  const [, peer, fp, how] = c.p.pos;
  if (!peer || !PEER_RE.test(peer) || !fp || !FP_RE.test(fp) || (how !== "first" && how !== "repin")) throw new LedgerError("invalid", "lend-pin -- <peer> <指纹> first|repin");
  const projects = (await lendDeps(c).borrow()).find((b) => b.peer === peer)?.projects ?? [];
  const text = `出借方 ${peer} 的实例公钥${how === "first" ? "首次钉住" : "按配对记录的指纹改钉"}：${fp}（之后换钥匙一律拒）`;
  const ctx = { ...c.ctx(), dedupKey: `lend-pin:${peer}:${fp}` };
  const data = { lend: { op: "pin", peer, fingerprint: fp, first: how === "first" } };
  const written = projects.filter((project) => !appendEvent(c.db, ctx, { project, target: "", kind: "note", text, data }).duplicate);
  return { ok: true, projects: written };
}

const OFFER_FLAGS = ["peer", "repo", "pr", "family", "reason", "project", "base"];
const bridgeSpec = (endpoint: LendEndpoint, what: string): CommandSpec => ({
  valued: [], usage: `lend-${endpoint === "result" ? "write" : endpoint} <peer> <json>（bridge 专用：${what}）`, run: (c) => bridgeCall(c, endpoint),
});

export const LEND_CMDS: Record<string, CommandSpec> = {
  "lend-offer": {
    valued: OFFER_FLAGS,
    usage: "lend-offer <task> --peer <名> --repo <owner/name> [--pr N] [--family codex] [--base main]（把这张卡本轮的审查 / 开工 / 修复挂进出借池，只给这个 peer；修复单缺省派回写租约的出借方）",
    run: (c) => offer(c, false),
  },
  "lend-reoffer": {
    valued: OFFER_FLAGS, usage: "lend-reoffer <task> --peer <名> --repo <owner/name> --reason <核对了什么>（撤掉未结的单、换新单号重挂）",
    run: (c) => offer(c, true),
  },
  "lend-cancel": { valued: ["reason", "project"], usage: "lend-cancel <task> --reason <原因>（撤掉未结的出借单，之后到的结论一律不入账）", run: cancel },
  "lend-orders": { valued: ["project"], usage: "lend-orders <task>（这张卡的出借单）", run: orders },
  "lend-reclaim": { valued: ["reason", "project"], usage: "lend-reclaim <task> --reason <原因>（收回写代码：撤掉未结的写单、结束写租约，卡退回本机）", run: reclaim },
  "lend-poll": bridgeSpec("poll", "对方拉挂给它的单"),
  "lend-claim": bridgeSpec("claim", "对方领单，拿到完整派单和租约"),
  "lend-lease": bridgeSpec("lease", "续租 / 释放"),
  "lend-write": bridgeSpec("result", "对方交审查结论 / 写单交付，核对完才入账"),
  "lend-pin": { valued: [], usage: "lend-pin -- <peer> <指纹> first|repin（bridge 专用：对方公钥刚钉住，记台账）", run: pinned },
  "lend-sweep": { valued: [], usage: "lend-sweep（bridge 定时调：过期租约结成 unknown 并通知 PM，推送超时的池单撤回）", run: sweep },
  ...lendPeerCmds({ deps: lendDeps, tell }),
};
