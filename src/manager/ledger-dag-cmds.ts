/**
 * `ledger dag-rewrite / dag-approve / dag-bind / dag-show`：子 DAG 的重写、审批、绑卡与查看（T89 = L2，docs/design/feature-dag.md）。
 * 规矩与审批在 lib/ledger-dag-write.ts；这里只解析参数、查发起方频道（审批 ask 的答复要投回发起的 PM），
 * 直接生效的在事务提交后经 deps.notifyOwner（bridge 的系统通知，lib/notify.ts）告诉 owner——送不到就在结果里写「未通知」，由 PM 补发。
 */
import { diffNodes, type DagCancel } from "../lib/ledger-dag-rules.js";
import { approveDag, bindNode, rewriteDag } from "../lib/ledger-dag-write.js";
import { effectiveNodes, getDagVersion, getPendingProposal, projectNodes, resolveFeature, type DagNode, type Feature } from "../lib/ledger-feature.js";
import { storedOrigin } from "../lib/ledger-origin.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const feature = (c: LedgerCli) => resolveFeature(c.db, c.p.pos[1], storedOrigin(c.db));

function json(c: LedgerCli, name: string): unknown {
  try {
    return JSON.parse(c.need(name));
  } catch (e) {
    if (e instanceof LedgerError) throw e;
    throw new LedgerError("invalid", `--${name} 不是合法 JSON：${(e as Error).message}`);
  }
}

/** `--cancel <key>=<原因>`，多个用 JSON 对象 `{"key":"原因"}`（同名旗标写两次只留最后一个，漏掉的会被「没写取消原因」拒掉） */
function cancels(raw: string | undefined): Map<string, string> {
  if (raw === undefined) return new Map();
  if (raw.trim().startsWith("{")) {
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch (e) {
      throw new LedgerError("invalid", `--cancel 不是合法 JSON：${(e as Error).message}`);
    }
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new LedgerError("invalid", "--cancel 的 JSON 要是 {节点 key: 原因}");
    return new Map(Object.entries(o).map(([k, v]) => [k, String(v ?? "").trim()]).filter(([, v]) => v) as [string, string][]);
  }
  const m = /^([^=]+)=(.+)$/s.exec(raw);
  if (!m || !m[2].trim()) throw new LedgerError("invalid", "--cancel 写成 <节点 key>=<原因>（多个用 JSON 对象）");
  return new Map([[m[1].trim(), m[2].trim()]]);
}

function needRev(c: LedgerCli): number {
  const rev = intFlag(c.p, "rev");
  if (rev === undefined) throw new LedgerError("invalid", "要带 --rev（feature-show 里看当前 rev）");
  return rev;
}

/** 只在首次生效时发：重放不重发（首次结果已经说了送没送到） */
async function tellOwner(c: LedgerCli, inform: string | null, duplicate: boolean): Promise<{ notified: boolean; why: string | null }> {
  if (!inform || duplicate) return { notified: false, why: duplicate ? "重放不重发通知" : null };
  if (!c.deps.notifyOwner) return { notified: false, why: "这个进程没有通知通道" };
  try {
    return (await c.deps.notifyOwner(inform)) ? { notified: true, why: null } : { notified: false, why: "bridge 没收下（见 undelivered-alerts.log）" };
  } catch (e) {
    return { notified: false, why: (e as Error).message };
  }
}

async function dagRewrite(c: LedgerCli): Promise<Result> {
  const f = feature(c);
  const reg = await c.deps.loadRegistry();
  const channelId = reg.agents[c.deps.actor]?.channelId || null;
  const r = rewriteDag(c.db, c.ctx(), {
    id: f.id, rev: needRev(c), nodes: json(c, "nodes"), reasonKind: c.need("reason-kind"), reasonText: c.need("reason"),
    cancel: cancels(c.p.flags.cancel), scopeChange: c.p.bools.has("scope-change"), askFrom: { agent: c.deps.actor, channelId },
  });
  const o = r.row;
  const told = await tellOwner(c, o.inform, r.duplicate);
  const next = !o.version ? `待 owner 批（ask ${o.ask?.id ?? o.proposal?.askId}）：答复会投回你，收到后跑 dag-approve`
    : told.notified ? "已生效，已通知 owner"
    : `已生效，未通知 owner（${told.why}）${r.duplicate ? "" : "：把 inform 用 reply 的 ask.kind=inform 转告"}`;
  return {
    ok: true, applied: !!o.version, version: o.version, proposal: o.proposal, askId: o.ask?.id ?? null, inform: o.inform, notified: told.notified, next, event: r.event, duplicate: r.duplicate,
  };
}

function dagApprove(c: LedgerCli): Result {
  const r = approveDag(c.db, c.ctx(), { id: feature(c).id });
  const o = r.row;
  if (!o.applied) return { ok: false, code: o.proposal.state === "rejected" ? "rejected" : "conflict", error: o.why, proposal: o.proposal, event: r.event, duplicate: r.duplicate };
  return { ok: true, version: o.version, proposal: o.proposal, event: r.event, duplicate: r.duplicate };
}

function dagBind(c: LedgerCli): Result {
  const [, , key, taskId] = c.p.pos;
  if (!key || !taskId) throw new LedgerError("invalid", "dag-bind <feature> <节点 key> <任务 id>");
  const r = bindNode(c.db, c.ctx(), { id: feature(c).id, rev: needRev(c), key, taskId });
  return { ok: true, node: r.row, event: r.event, duplicate: r.duplicate };
}

/** 版本号或 pending → 节点（已并上绑卡）与这一版记下的取消 */
function versionNodes(c: LedgerCli, f: Feature, raw: string): { nodes: DagNode[]; cancels: DagCancel[]; version: number } {
  if (raw === "pending") {
    const p = getPendingProposal(c.db, f.id);
    if (!p) throw new LedgerError("not_found", `feature ${f.id} 没有待批的重写`);
    return { nodes: p.nodes, cancels: p.cancels, version: p.version };
  }
  if (!/^\d+$/.test(raw)) throw new LedgerError("invalid", `--diff 的版本要是数字或 pending，收到 ${raw}`);
  const v = getDagVersion(c.db, f.id, Number(raw));
  if (!v) throw new LedgerError("not_found", `feature ${f.id} 没有 v${raw}`);
  return { nodes: effectiveNodes(c.db, v), cancels: v.cancels, version: v.version };
}

/** a → b 的差异；取消原因取 (a, b] 之间各版（含 pending）记下的 */
function diff(c: LedgerCli, f: Feature, a: string, b: string): Result {
  const from = versionNodes(c, f, a);
  const to = versionNodes(c, f, b);
  const between: DagCancel[] = [];
  for (let v = from.version + 1; v <= to.version; v++) {
    between.push(...(v === to.version ? to.cancels : (getDagVersion(c.db, f.id, v)?.cancels ?? [])));
  }
  return { ok: true, feature: f.id, from: from.version, to: to.version, diff: diffNodes(from.nodes, to.nodes, between) };
}

/** 某一版的快照（缺省当前版），附任务卡现读的状态；同时给出 pending 提案。--diff a b 看两版差异 */
function dagShow(c: LedgerCli): Result {
  const f = feature(c);
  if (c.p.flags.diff !== undefined) return diff(c, f, c.p.flags.diff, c.p.pos[2] ?? String(f.currentVersion));
  const n = intFlag(c.p, "version") ?? f.currentVersion;
  const v = n ? getDagVersion(c.db, f.id, n) : null;
  if (!v) throw new LedgerError("not_found", f.currentVersion ? `feature ${f.id} 没有 v${n}（当前 v${f.currentVersion}）` : `feature ${f.id} 还没建 DAG（先 dag-init）`);
  const p = getPendingProposal(c.db, f.id);
  const pending = p ? { ...p, nodes: projectNodes(c.db, p.nodes) } : null;
  return { ok: true, feature: f.id, current: f.currentVersion, version: { ...v, nodes: projectNodes(c.db, effectiveNodes(c.db, v)) }, pending };
}

export const DAG_CMDS: Record<string, CommandSpec> = {
  "dag-rewrite": {
    valued: ["rev", "nodes", "reason-kind", "reason", "cancel", "project", "dedup"],
    bools: ["scope-change"],
    usage: "dag-rewrite <feature> --rev <n> --nodes '<json>' --reason-kind new_issue|requirement_change|p1_fallback --reason <原文> "
      + "[--cancel <key>=<原因> | --cancel '{\"key\":\"原因\"}'] [--scope-change]",
    run: dagRewrite,
  },
  "dag-approve": { valued: ["project", "dedup"], usage: "dag-approve <feature>（owner 答了审批 ask 之后跑：批准就生效，驳回 / 过期就作废）", run: dagApprove },
  "dag-bind": { valued: ["rev", "project", "dedup"], usage: "dag-bind <feature> <节点 key> <任务 id> --rev <n>（计划节点开工绑卡，不产生新版本）", run: dagBind },
  "dag-show": { valued: ["version", "diff", "project"], usage: "dag-show <feature> [--version N] | --diff <a> [b]（a/b 为版本号或 pending，b 缺省当前版）", run: dagShow },
};
