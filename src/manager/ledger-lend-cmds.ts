/**
 * `ledger lend-*`（T93，docs/design/remote-capacity.md §2.2、§3）：
 * - PM：lend-offer / lend-cancel / lend-reoffer 挂单、撤单、重挂；lend-orders 查这张卡的出借单。
 * - bridge 专用（owner 身份，local-api/lend.ts 经 runManager 调）：lend-poll / lend-claim / lend-lease / lend-write / lend-sweep。
 *   每次先把过期的租约结成 unknown 并通知 PM（不自动重派），再按请求做一次 CAS；拒绝码放在 current.lend 里给 bridge 映射。
 * lend-write 的幂等键是请求体原文的 sha256：bridge 把请求体原样当参数传进来。tests/ledger-lend.test.ts。
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { signPurpose } from "../lib/instance-key.js";
import { readLend, type BorrowEntry, type LendFamily, REPO_RE } from "../lib/lend-config.js";
import { effectiveLend, readLendContext } from "../lib/lend-policy.js";
import { LEND_VERSION, parseLendRequest, type LendEndpoint } from "../lib/lend-wire.js";
import { cancelLend, claimLend, leaseLend, listLendOrders, offerLend, pollLend, refuse, reofferLend, sweepLend, type LendNotice, type OfferInput } from "../lib/ledger-lend.js";
import { RECEIPT_PURPOSE, writeLendResult, type LendResultDeps } from "../lib/ledger-lend-result.js";
import { getMeta, LedgerError } from "../lib/ledger-store.js";
import type { LedgerTask } from "../lib/ledger-stages.js";
import { statePath } from "../lib/paths.js";
import { notifyProjectPm } from "../lib/pm-notify.js";
import { writeTextAtomicSync } from "../lib/state-file.js";
import { readTextSoft, specPathFor } from "../lib/task-spec.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** Tests inject all three; production reads lend.json + peers + projects fresh on every call (a revoked borrow applies at once). */
export interface LendCliDeps {
  borrow(): Promise<BorrowEntry[]>;
  notifyPm(project: string, text: string): Promise<void>;
  result: LendResultDeps;
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
    },
  };
}

const lendDeps = (c: LedgerCli): LendCliDeps => c.deps.lend ?? realLendDeps(c);
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

function offerInput(c: LedgerCli, task: LedgerTask, borrow: BorrowEntry | null): OfferInput {
  const { peer, repo, family = "codex" } = c.p.flags;
  if (!peer || !PEER_RE.test(peer)) throw new LedgerError("invalid", "--peer <peer 名> 必填");
  if (!repo || !REPO_RE.test(repo)) throw new LedgerError("invalid", "--repo <owner/name> 必填（只给对方 GitHub 坐标）");
  // 表和接口按两家留了位置，这一切片只借 Codex（T93 规格；r1 P2-4）
  if (family !== "codex") throw new LedgerError("invalid", `这一版只借 Codex 审查，--family 只能是 codex（不是 ${family}）`);
  const prFlag = c.p.flags.pr ?? task.pr?.match(/(\d+)\/?$/)?.[1];
  const pr = prFlag === undefined ? null : Number(prFlag);
  if (pr !== null && (!Number.isInteger(pr) || pr < 1)) throw new LedgerError("invalid", "--pr 要是 PR 编号");
  const spec = readTextSoft(specPathFor(task, getMeta(c.db, task.project).docsDir));
  if (!spec) throw new LedgerError("invalid", `找不到 ${task.id} 的规格卡原文（对方读不到本机文件，要内联进派单）`);
  return { taskId: task.id, peer, family: family as LendFamily, repo, pr, spec, borrow };
}

async function offer(c: LedgerCli, again: boolean): Promise<Result> {
  const task = c.task(c.p.pos[1]);
  c.requireManager(task.project, again ? "重挂出借单" : "挂出借单");
  const input = offerInput(c, task, (await borrowOf(c, c.p.flags.peer ?? ""))(task.project));
  const reason = c.p.flags.reason ?? "";
  if (again && !reason.trim()) throw new LedgerError("invalid", "重挂要写 --reason（核对了什么）");
  const o = again ? reofferLend(c.db, c.ctx(), { ...input, reason }) : offerLend(c.db, c.ctx(), input);
  return { ok: true, orderId: o.orderId, peer: o.peer, family: o.family, sha256: o.sha256, supersedes: o.supersedes };
}

function cancel(c: LedgerCli): Result {
  const task = c.task(c.p.pos[1]);
  const reason = c.p.flags.reason ?? "";
  if (!reason.trim()) throw new LedgerError("invalid", "撤单要写 --reason");
  const o = cancelLend(c.db, c.ctx(), { taskId: task.id, reason });
  return { ok: true, orderId: o.orderId, status: o.status };
}

function orders(c: LedgerCli): Result {
  const task = c.task(c.p.pos[1]);
  return { ok: true, task: task.id, orders: listLendOrders(c.db, task.id).map(({ wire: _w, text: _t, ...o }) => o) };
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
  if (endpoint === "poll") return { ok: true, v, ...pollLend(c.db, peer, req.value as never, await borrowOf(c, peer)), notified };
  if (endpoint === "claim") {
    const r = claimLend(c.db, c.ctx(), peer, req.value as never, await borrowOf(c, peer));
    return "stale" in r ? refuse("cancelled", "卡已推进，这一单已作废") : { ok: true, v, ...r };
  }
  if (endpoint === "lease") {
    const r = leaseLend(c.db, c.ctx(), peer, req.value as never);
    return { ok: true, v, lease: r.lease, notified: notified + (await tell(c, r.notices)) };
  }
  const sha = createHash("sha256").update(raw as string, "utf8").digest("hex");
  const receipt = writeLendResult(c.db, { actor: `peer:${peer}`, now: c.deps.now() }, peer, req.value as never, sha, lendDeps(c).result);
  return { ok: true, v, receipt };
}

async function sweep(c: LedgerCli): Promise<Result> {
  if (c.deps.actor !== "owner") throw new LedgerError("forbidden", "lend-sweep 只给 bridge 用（以 owner 身份调）");
  const notices = sweepLend(c.db, c.ctx());
  return { ok: true, expired: notices.length, notified: await tell(c, notices) };
}

const OFFER_FLAGS = ["peer", "repo", "pr", "family", "reason", "project"];
const bridgeSpec = (endpoint: LendEndpoint, what: string): CommandSpec => ({
  valued: [], usage: `lend-${endpoint === "result" ? "write" : endpoint} <peer> <json>（bridge 专用：${what}）`, run: (c) => bridgeCall(c, endpoint),
});

export const LEND_CMDS: Record<string, CommandSpec> = {
  "lend-offer": {
    valued: OFFER_FLAGS, usage: "lend-offer <task> --peer <名> --repo <owner/name> [--pr N] [--family codex]（把本轮审查挂进出借池，只给这个 peer）",
    run: (c) => offer(c, false),
  },
  "lend-reoffer": {
    valued: OFFER_FLAGS, usage: "lend-reoffer <task> --peer <名> --repo <owner/name> --reason <核对了什么>（撤掉未结的单、换新单号重挂）",
    run: (c) => offer(c, true),
  },
  "lend-cancel": { valued: ["reason", "project"], usage: "lend-cancel <task> --reason <原因>（撤掉未结的出借单，之后到的结论一律不入账）", run: cancel },
  "lend-orders": { valued: ["project"], usage: "lend-orders <task>（这张卡的出借单）", run: orders },
  "lend-poll": bridgeSpec("poll", "对方拉挂给它的单"),
  "lend-claim": bridgeSpec("claim", "对方领单，拿到完整派单和租约"),
  "lend-lease": bridgeSpec("lease", "续租 / 释放"),
  "lend-write": bridgeSpec("result", "对方交审查结论，核对完才入账"),
  "lend-sweep": { valued: [], usage: "lend-sweep（bridge 定时调：过期租约结成 unknown 并通知 PM）", run: sweep },
};
