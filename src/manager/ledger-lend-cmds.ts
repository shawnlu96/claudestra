import { applyReborrow } from "../lib/lend-reborrow-apply.js";
import { captureReborrowFacts, assertReborrowAuthority, digest, type ReborrowFacts } from "../lib/lend-reborrow-facts.js";
import { prepareReborrowContext } from "../lib/lend-reborrow-context.js";
import { convReborrowKey, reborrowKey, replayReborrow } from "../lib/lend-reborrow-event.js";
import { captureConvReborrowFacts } from "../lib/lend-reborrow-conv.js";
import { reborrowSourceProbe } from "../lib/lend-reborrow-probe.js";
import { prepareReborrowSource, type ReborrowSource, type ReborrowSourceProbe } from "../lib/lend-reborrow-source.js";
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
import { readLend, type BorrowEntry, REPO_RE } from "../lib/lend-config.js";
import { effectiveLend, readLendContext } from "../lib/lend-policy.js";
import { remoteHeadAt, stepOfStage } from "../lib/lend-git.js";
import { writeMaterials } from "../lib/lend-write-materials.js";
import { materialsPolicyPort } from "../lib/recovery-materials-wiring.js";
// macro: the reader location is fixed when Bun transpiles / bundles this entry (a bundle keeps the source tree's src/lib path)
import { cfgReaderPath } from "../lib/recovery-materials-wiring.js" with { type: "macro" };
import { ensureReviewScope } from "../lib/order-deliver-scope.js";
import { isDeliverRequest, LEND_VERSION, parseLendRequest, type LendEndpoint } from "../lib/lend-wire.js";
import { cancelLend, claimLend, leaseLend, listLendOrders, pollLend, reclaimLend, refuse, sweepLend, type LendNotice,
  type OfferInput } from "../lib/ledger-lend.js";

import { heldLease } from "../lib/ledger-lend-lease.js";
import { cliOfferFamily, offerWithAuthorFamily, refreshCliOffer } from "../lib/lend-cli-author-family.js";
import { placementOf } from "../lib/lend-placement-view.js";
import { lendPeerCmds, type BranchState } from "./ledger-lend-peer-cmds.js";
import { RECEIPT_PURPOSE, writeLendDeliver, writeLendResult, type LendDeliverDeps, type LendResultDeps } from "../lib/ledger-lend-result.js";
import { readPeers } from "../lib/peers.js";
import { readPinnedKey } from "../lib/pool-review-proof-admit.js";
import { saveRawResult } from "../lib/pool-review-proof-raw.js";
import { runBounded } from "../lib/run-bounded.js";
import { getEventByDedup, getMeta, getTask, LedgerError } from "../lib/ledger-store.js";
import { scanRelays, settleRelay, takeRelays, type RelaySend } from "../lib/ledger-lend-relay.js";
import { bridgeSend } from "../lib/bridge-client.js";
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
  reborrowSource?: ReborrowSourceProbe;
  borrow(): Promise<BorrowEntry[]>;
  notifyPm(project: string, text: string): Promise<void>;
  /** 审查结论与写单交付共用（报告目录、写报告、签回执）；写单另要查远端 head 与对方指纹（只测审查的注入可以不给） */
  result: LendResultDeps & Partial<Pick<LendDeliverDeps, "remoteHead" | "peerFp">>;
  /** v2 收回核对（i28-W2）：订单分支在远端的状态；不给 = 真 git ls-remote */
  branchState?: (repo: string, branch: string) => Promise<BranchState>;
  /** 槽池放置要的项目调度策略（i28-W5）；不给 = 读真 scheduler.json */
  schedulerPolicy?: (project: string) => { remote?: RemotePolicy; maxActiveWorkers: number } | null;
  /** lend-relay（i28-RS1）：经 send_to_agent 通道发一段（本机 agent 名或 `<worker>@<peer>`）；不给 = 真 bridge route_to_agent 单发 */
  relay?: (target: string, text: string) => Promise<RelaySend>;
  /** lend-relay：卡此刻的规格原文；不给 = 读本机规格文件 */
  readSpec?: (task: LedgerTask) => string | null;
  /** 修复单材料的 CFG recoveryPolicy 模块位置（dispatch-recovery-MATW，单测用）；不给 = CFG 的正式位置（macro 在转译 / 打包时定下的 src/lib），没装就 observe */
  recoveryReader?: URL;
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
      saveRaw: (text) => saveRawResult(statePath("ledger", "lend-raw"), text),
      pinnedKey: readPinnedKey,
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

function offerInput(c: LedgerCli, task: LedgerTask, borrow: BorrowEntry | null, requestedFamily = c.p.flags.family): OfferInput {
  const { peer, repo } = offerPeer(c, task);
  const family = cliOfferFamily(c.db, task, requestedFamily);
  const prFlag = c.p.flags.pr ?? task.pr?.match(/(\d+)\/?$/)?.[1];
  const pr = prFlag === undefined ? null : Number(prFlag);
  if (pr !== null && (!Number.isInteger(pr) || pr < 1)) throw new LedgerError("invalid", "--pr 要是 PR 编号");
  const spec = readTextSoft(specPathFor(task, getMeta(c.db, task.project).docsDir));
  if (!spec) throw new LedgerError("invalid", `找不到 ${task.id} 的规格卡原文（对方读不到本机文件，要内联进派单）`);
  return { taskId: task.id, peer, family, repo, pr: stepOfStage(task.stage) === "write" ? null : pr, spec, borrow };
}

/** 写单材料（lib/lend-write-materials.ts，调度服务挂池同一份）：查远端 / 读文件失败一律拒挂，不带半张单出去 */
async function withWrite(c: LedgerCli, task: LedgerTask, input: OfferInput): Promise<{ input: OfferInput; materialsDiag?: string }> {
  const step = stepOfStage(task.stage);
  if (step !== "write" && step !== "fix") return { input };
  const { policy, diag } = step === "fix" ? await materialsPolicyPort(c.deps.lend?.recoveryReader ?? cfgReaderPath()) : { policy: undefined, diag: null };
  const write = await writeMaterials(c.db, task, { peer: input.peer, repo: input.repo, base: c.p.flags.base ?? "main" }, writeDeps(c), policy);
  return { input: write ? { ...input, write } : input, ...(diag ? { materialsDiag: diag } : {}) };
}

/** Dry-run has no canonical CAS behind it: recapture with the function that CAS uses and compare the same way. Reads only. */
function assertDryRunFresh(c: LedgerCli, prepared: ReborrowFacts): void {
  const drift = (why: string): never => { throw new LedgerError("conflict", `dry-run 期间事实漂移：${why}`); };
  let fresh: ReborrowFacts;
  try {
    fresh = (prepared.conv ? captureConvReborrowFacts : captureReborrowFacts)(c.db, prepared.task.id, prepared.lease.peer, prepared.lease.repo);
  } catch (e) {
    if (e instanceof LedgerError && e.code === "conflict") drift(e.message);
    throw e;
  }
  if (fresh.fingerprint !== prepared.fingerprint || digest(fresh) !== digest(prepared)) drift("任务、材料、订单或租约发生变化");
}

/** Explicit recovery stays read-only until --apply; no scope registration or task-head updates are implicit. */
async function reborrow(c: LedgerCli): Promise<Result> {
  const task = c.task(c.p.pos[1]);
  c.requireRealPm(task.project, "接回写租约");
  // Two sources, parsed and deduplicated apart: --reclaim = PM reclaim (v1), --conv-end = formal CONV2 end (CVREBOR1). The seq only selects a proof.
  const conv = c.p.flags["conv-end"] !== undefined, raw = conv ? c.p.flags["conv-end"] : c.p.flags.reclaim;
  if (conv && c.p.flags.reclaim !== undefined) throw new LedgerError("invalid", "--reclaim 与 --conv-end 只能选一个来源");
  const { peer, repo } = offerPeer(c, task), seq = /^[1-9]\d*$/.test(String(raw)) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(seq) || seq < 1) throw new LedgerError("invalid", "续借必填 --reclaim <收回事件 seq> 或 --conv-end <CONV 结束事件 seq>");
  if (c.p.flags.base && c.p.flags.base !== "main") throw new LedgerError("invalid", "续借 PR base 必须是 main");
  const event = getEventByDedup(c.db, (conv ? convReborrowKey : reborrowKey)(task.id, seq));
  const saved = event?.data.lend as { facts: ReborrowFacts; source: ReborrowSource } | undefined;
  if (saved && !!saved.facts?.conv !== conv) throw new LedgerError("conflict", "接续事件来源类型与请求不符");
  const facts: ReborrowFacts = saved?.facts ?? (conv ? captureConvReborrowFacts : captureReborrowFacts)(c.db, task.id, peer, repo);
  if (facts.reclaim.seq !== seq || facts.lease.peer !== peer || facts.lease.repo !== repo ||
    (c.p.flags.family && c.p.flags.family !== facts.family) ||
    (c.p.flags.pr && Number(c.p.flags.pr) !== (saved?.source.pr?.number ?? facts.previous.pr))) {
    throw new LedgerError("conflict", "续借请求与原收回事件、peer、PR 或家族不符");
  }
  const deps = lendDeps(c), wd = writeDeps(c);
  const borrow = (await borrowOf(c, peer))(task.project), pinned = await wd.peerFp(peer);
  assertReborrowAuthority(c.db, facts, c.deps.actor, borrow, pinned, c.deps.now(), !!saved);
  if (saved) {
    const existing = replayReborrow(c.db, facts, saved.source);
    if (!existing?.reborrowBasis) throw new LedgerError("conflict", "原接续审计 basis 无效");
    return { ok: true, duplicate: true, orderId: existing.orderId, status: existing.status, head: existing.head };
  }
  const recovery = await prepareReborrowContext(facts, deps.reborrowSource ?? reborrowSourceProbe(wd));
  // CONV: the original-author gate runs on the real previous family first; only the verified CONV context then supplies the target.
  const original = offerInput(c, task, borrow, facts.conv ? facts.previous.family : facts.family);
  const { input, materialsDiag } = await withWrite(c, task, { ...original, family: facts.family, pr: recovery.source.pr?.number ?? null });
  if (!input.write) throw new LedgerError("invalid", "续借缺少原写单材料");
  const checked = await prepareReborrowSource(facts, deps.reborrowSource ?? reborrowSourceProbe(wd));
  if (JSON.stringify(checked) !== JSON.stringify(recovery.source)) throw new LedgerError("conflict", "材料准备期间远端来源漂移");
  const fresh = await refreshCliOffer(input, task.project, deps);
  const fp = await wd.peerFp(peer);
  assertReborrowAuthority(c.db, facts, c.deps.actor, fresh.borrow, fp, c.deps.now());
  if (!c.p.bools.has("apply")) assertDryRunFresh(c, facts);
  if (!c.p.bools.has("apply")) return { ok: true, dryRun: true, previousOrderId: facts.previous.orderId, gen: facts.previous.leaseGen,
    reclaimSeq: seq, ...(facts.conv ? { source: "conv", intentId: facts.conv.intent.id, originalFamily: facts.conv.from, convFamily: facts.conv.to,
      material: { sha256: facts.conv.material.sha256.slice(0, 12), bytes: facts.conv.material.bytes } } : {}),
    reviewedHead: task.headSHA, remoteHead: recovery.source.remoteHead, providerVerification: "required_at_claim", materialsDiag };
  const o = applyReborrow(c.db, c.ctx(), recovery, fresh, fp);
  return { ok: true, orderId: o.orderId, head: o.head, peer: o.peer, family: o.family, supersedes: o.supersedes,
    branch: o.branch, base: o.base, providerVerification: "required_at_claim", materialsDiag };
}

async function offer(c: LedgerCli, again: boolean): Promise<Result> {
  if (c.p.bools.has("reborrow")) return reborrow(c);
  if (c.p.bools.has("apply") || c.p.flags.reclaim || c.p.flags["conv-end"]) throw new LedgerError("invalid", "--apply / --reclaim / --conv-end 仅用于 --reborrow");
  const task = c.task(c.p.pos[1]);
  c.requireManager(task.project, again ? "重挂出借单" : "挂出借单");
  await ensureReviewScope(c.db, task.id); // 规格外文件在挂池事务外先登记，事务里的审查单只读（i28-ASK2）
  const peer = offerPeer(c, task).peer;
  const { input, materialsDiag } = await withWrite(c, task, offerInput(c, task, (await borrowOf(c, peer))(task.project)));
  const reason = c.p.flags.reason ?? "";
  if (again && !reason.trim()) throw new LedgerError("invalid", "重挂要写 --reason（核对了什么）");
  const fresh = await refreshCliOffer(input, task.project, lendDeps(c));
  const o = offerWithAuthorFamily(c.db, c.ctx(), task, fresh, again ? reason : undefined);
  return { ok: true, orderId: o.orderId, step: o.step, peer: o.peer, family: o.family, sha256: o.sha256, supersedes: o.supersedes,
    ...(o.branch ? { branch: o.branch, base: o.base } : {}), ...(materialsDiag ? { materialsDiag } : {}) };
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
    : writeLendResult(c.db, { actor: `peer:${peer}`, now: c.deps.now() }, peer, payload, sha, lendDeps(c).result,
      { raw, pinned: await lendDeps(c).result.pinnedKey?.(peer) ?? null });
  return { ok: true, v, receipt };
}

async function sweep(c: LedgerCli): Promise<Result> {
  if (c.deps.actor !== "owner") throw new LedgerError("forbidden", "lend-sweep 只给 bridge 用（以 owner 身份调）");
  const notices = sweepLend(c.db, c.ctx());
  return { ok: true, expired: notices.length, notified: await tell(c, notices) };
}

/** sent=false = 请求没出这个进程或 bridge 明确拒了（可重试）；sent=true 却没回执 = 可能已送到（不重发） */
async function bridgeRelay(target: string, text: string): Promise<RelaySend> {
  const r = await bridgeSend({ type: "route_to_agent", targetName: target, text, fromName: "lend", oneShot: true, lendSupplement: target.includes("@") }, { timeoutMs: 30_000 });
  if (!r.ok) return { ok: false, error: r.error, maybeSent: r.sent && !r.rejected };
  if (r.result?.ok === false) return r.result as RelaySend;
  if (target.includes("@") && r.result?.remoteAccepted !== true) return { ok: false, error: "bridge 未返回远端接收回执", maybeSent: true };
  return { ok: true };
}

/**
 * i28-RS1（lib/ledger-lend-relay.ts）：持单期间的规格追加 / 复述答复排队（过外发闸，拒了告诉 PM），再逐段经 send_to_agent 发给持单的出借
 * worker；开工单挂出去时给本机复述会话的固定说明也走这里。bridge 定时调（owner 身份）。
 */
async function relay(c: LedgerCli): Promise<Result> {
  if (c.deps.actor !== "owner") throw new LedgerError("forbidden", "lend-relay 只给 bridge 用（以 owner 身份调）");
  const d = lendDeps(c);
  const readSpec = d.readSpec ?? ((t: LedgerTask) => readTextSoft(specPathFor(t, getMeta(c.db, t.project).docsDir)));
  let notified = await tell(c, scanRelays(c.db, c.ctx(), readSpec, (id) => getTask(c.db, id)));
  const sent: string[] = [];
  for (const row of takeRelays(c.db, c.deps.now())) {
    let r: RelaySend;
    try {
      r = await (d.relay ?? bridgeRelay)(row.target, row.text);
    } catch (e) {
      r = { ok: false, error: (e as Error).message, maybeSent: true };
    }
    if (r.ok) sent.push(row.key);
    notified += await tell(c, settleRelay(c.db, c.ctx(), row.key, r));
  }
  return { ok: true, sent, notified };
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
    valued: [...OFFER_FLAGS, "reclaim", "conv-end"], bools: ["reborrow", "apply"],
    usage: "lend-offer <task> --peer <名> --repo <owner/name> [--pr N] [--family codex|claude] [--base main] " +
      "[--reborrow --reclaim seq|--conv-end seq [--apply]]（续借默认 dry-run；把这张卡本轮的审查 / 开工 / 修复挂进出借池，只给这个 peer；修复单缺省派回写租约的出借方；" +
      "--family 缺省 codex，claude 写单须有作者记录及有效 v3 授权；审查须跨模型，security 卡只在本机审）",
    run: (c) => offer(c, false),
  },
  "lend-reoffer": {
    valued: OFFER_FLAGS, usage: "lend-reoffer <task> --peer <名> --repo <owner/name> [--family codex|claude] --reason <核对了什么>（撤掉未结的单、换新单号重挂）",
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
  "lend-relay": { valued: [], usage: "lend-relay（bridge 定时调：持单期间的规格追加 / 复述答复转给出借 worker，复述会话的借出说明）", run: relay },
  ...lendPeerCmds({ deps: lendDeps, tell }),
};
