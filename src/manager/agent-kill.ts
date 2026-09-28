/**
 * kill / remove：按 registry 补完剩下的步骤，而不是以「窗口还在不在」为准。
 *
 * kill 的顺序是 ①置 stopped + 写 pending{op:kill} ②关窗口 ③归档会话 ④删频道 ⑤/agent/cleanup ⑥清标记。
 * 先置 stopped：砍在中间时 launcher 不会把「active 却没窗口」的它当 dead 拉回来。砍在任何一步之后，
 * 再跑 kill（或 repair --apply）都从 ②重走，每一步可重复。删频道因 bridge 不在失败时留下
 * pending{pid:0, left:["channel"]}，别让一个在世的频道被当成已删（tests/resumable-ops.test.ts）。
 */
import { isPendingLive, newPending } from "../lib/pending-ops.js";
import { isMasterAgent } from "../lib/registry.js";
import { normalizeName, output, type Registry } from "./core.js";
import { clearCreateResidue } from "./create-guard.js";
import { realOpsDeps, type OpsDeps } from "./ops-deps.js";

/** 要关的窗口：本名，加上 rename 做到一半时还叫旧名的那个（旧名已不在 registry 才算它的） */
function windowNamesOf(reg: Registry, name: string): string[] {
  const p = reg.agents[name]?.pending;
  return p?.op === "rename" && !reg.agents[p.from] ? [name, p.from] : [name];
}

async function killWindows(names: string[], deps: OpsDeps): Promise<boolean> {
  const live = await deps.listWindows();
  const hit = names.filter((n) => live.includes(n));
  for (const n of hit) await deps.killWindow(n);
  return hit.length > 0;
}

/** 同名大小写变体（历史遗留）一并清掉 */
function dropCaseVariants(reg: Registry, name: string): void {
  for (const key of Object.keys(reg.agents)) if (key.toLowerCase() === name && key !== name) delete reg.agents[key];
}

export async function runKill(name: string, deps: OpsDeps): Promise<Record<string, unknown>> {
  if (isMasterAgent(name)) return { ok: false, error: "大总管不能 kill（它由 launcher 守护）" };
  let reg = await deps.loadRegistry();
  const info = reg.agents[name];
  const winNames = windowNamesOf(reg, name);
  const hasWindow = (await deps.listWindows()).some((w) => winNames.includes(w));
  if (!info && !hasWindow) return { ok: false, error: `${name} 不存在` };
  if (info?.pending && isPendingLive(info.pending, deps.now(), deps.alive)) {
    return { ok: false, error: `${name} 正在 ${info.pending.op}（pid ${info.pending.pid}），等它结束再试` };
  }
  if (info?.pending?.op === "create") {
    const r = await clearCreateResidue(name, deps);
    return r.ok
      ? { ok: true, agent: name, message: `${name} 是做到一半的 create，已清理：${r.steps.join("；")}` }
      : { ok: false, agent: name, error: r.error };
  }
  if (info?.status === "stopped" && !info.pending && !hasWindow) {
    return { ok: true, agent: name, alreadyStopped: true, message: `${name} 早已销毁，无事可做。` };
  }

  if (info) {
    info.status = "stopped";
    info.pending = newPending("kill", {}, deps.now());
    await deps.saveRegistry(reg);
  }
  if (hasWindow) await killWindows(winNames, deps);
  // 会话退役 → 归档 jsonl 快照（CC 的 cleanupPeriodDays 会清源文件）
  if (info?.sessionId) await deps.archive(name, info.cwd, info.sessionId);
  const left: string[] = [];
  if (info?.channelId) {
    const r = await deps.deleteChannel(info.channelId);
    if (typeof r === "object") left.push("channel");
    // 清掉 inter-agent / cross-peer pending，免得同名 resume 后吃陈年 pushback；bridge 没启就没有这些内存态
    await deps.agentCleanup(info.channelId, name);
  }

  reg = await deps.loadRegistry();
  const cur = reg.agents[name];
  if (cur) {
    cur.status = "stopped";
    if (left.length) cur.pending = { ...newPending("kill", {}, deps.now()), pid: 0, left };
    else delete cur.pending;
  }
  dropCaseVariants(reg, name);
  await deps.saveRegistry(reg);
  await deps.rescan("remove", name);
  return left.length
    ? { ok: true, agent: name, incomplete: left, message: `${name} 已停止，但频道没删成（bridge 不在？）——bridge 恢复后再跑一次 kill 或 manager repair --apply` }
    : { ok: true, agent: name, message: `${name} 已销毁。` };
}

/**
 * 永久移除：kill 收尾 + registry 条目整个删除（列表不再显示）。归档文件保留——删列表 ≠ 删档案，
 * 误删的 agent 用 create + resume --fork 可以重建。
 */
export async function runRemove(name: string, deps: OpsDeps): Promise<Record<string, unknown>> {
  if (isMasterAgent(name)) return { ok: false, error: "大总管不能 remove（它由 launcher 守护）" };
  const reg = await deps.loadRegistry();
  const info = reg.agents[name];
  const winNames = windowNamesOf(reg, name);
  const hasWindow = (await deps.listWindows()).some((w) => winNames.includes(w));
  if (!info && !hasWindow) return { ok: false, error: `${name} 不存在` };
  if (info?.pending && isPendingLive(info.pending, deps.now(), deps.alive)) {
    return { ok: false, error: `${name} 正在 ${info.pending.op}（pid ${info.pending.pid}），等它结束再试` };
  }
  if (hasWindow) await killWindows(winNames, deps);
  if (info?.sessionId) await deps.archive(name, info.cwd, info.sessionId);
  const channelId = info?.channelId || (info?.pending?.op === "create" ? info.pending.channelId : undefined);
  if (channelId) {
    const r = await deps.deleteChannel(channelId);
    if (typeof r === "object") {
      // 条目留成「已停止 + 欠删频道」：launcher 不会把它当 dead 拉回来，doctor / repair 能看到那个频道
      const fresh = await deps.loadRegistry();
      if (fresh.agents[name]) Object.assign(fresh.agents[name], { status: "stopped", pending: { ...newPending("kill", {}, deps.now()), pid: 0, left: ["channel"] } });
      await deps.saveRegistry(fresh);
      return { ok: false, agent: name, error: `删频道 ${channelId} 失败（${r.error}）：窗口已关、条目置为 stopped 先留着，bridge 恢复后再跑 remove` };
    }
  }
  const fresh = await deps.loadRegistry();
  delete fresh.agents[name];
  dropCaseVariants(fresh, name);
  (await import("./team.js")).repointParentRefs(fresh, name); // 清掉子 agent 指向它的 parent，免得同名重建被旧孤儿认作父
  await deps.saveRegistry(fresh);
  await deps.rescan("remove", name);
  if (channelId) await deps.agentCleanup(channelId, name);
  return { ok: true, agent: name, message: `${name} 已永久移除（会话归档保留）。` };
}

export async function cmdKill(name: string): Promise<void> {
  output(await runKill(normalizeName(name), realOpsDeps));
}

export async function cmdRemove(name: string): Promise<void> {
  output(await runRemove(normalizeName(name), realOpsDeps));
}
