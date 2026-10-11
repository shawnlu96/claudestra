/**
 * kill / remove：按 registry 补完剩下的步骤，而不是以「窗口还在不在」为准。
 *
 * kill 的顺序是 ①置 stopped + 写 pending{op:kill} ②关窗口 ③归档会话 ④删频道 ⑤/agent/cleanup ⑥清标记。
 * 先置 stopped：砍在中间时 launcher 不会把「active 却没窗口」的它当 dead 拉回来。砍在任何一步之后，
 * 再跑 kill（或 repair --apply）都从 ②重走，每一步可重复。删频道因 bridge 不在失败时留下
 * pending{pid:0, left:["channel"]}，别让一个在世的频道被当成已删（tests/resumable-ops.test.ts）。
 */
import { verifyStopEdge, readStopRegistry } from "../lib/fix-strategy-guard-stop.js";
import { removeAgentSettings } from "../lib/agent-settings.js";
import { isPendingLive, newPending } from "../lib/pending-ops.js";
import { isMasterAgent } from "../lib/registry.js";
import { normalizeName, output, type AgentInfo, type Registry } from "./core.js";
import { clearCreateResidue } from "./create-guard.js";
import { channelFailureText, realOpsDeps, type OpsDeps } from "./ops-deps.js";
import { tryLockRestart, unlockRestart } from "./restart-lock.js";

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

/**
 * 出借 B 终态退休（lib/agent-lifecycle-lend.ts 经 LIFE1 collect 调）专用：只退役 registry 记录。会话已由 collect 先归档，这里不再
 * 归档；不关窗口、不删频道 / settings、不 agentCleanup、不碰磁盘、不清大小写变体、不改子 agent 的 parent。只在内部注入，没有 CLI 开关。
 */
export interface ArchiveOnlyRemove {
  /** 这次退休针对的会话：条目现在跑的不是它就拒 */
  sessionId: string;
  /** 重核 B 终态事实（订单 / 代数 / 退出证明 / 保全），不成立就抛 */
  verify(info: AgentInfo): void;
  /** core.saveRegistry 带发布点核验（CAS + verify），不走 deps.saveRegistry */
  save(reg: Registry): Promise<void>;
}

/** force = 频道删不掉（bridge 不在 / Discord 没权限）时放弃这一步，不留欠账 */
export interface KillOptions { force?: boolean; archiveOnly?: ArchiveOnlyRemove; session?: string; fixStop?: string; restartLock?: RestartLock; sessionRegistry?: () => Registry }

/** per-agent restart 互斥（restart-lock.ts）；单测换成内存假件 */
export interface RestartLock { tryLock(name: string): boolean; unlock(name: string): void }
const fileRestartLock: RestartLock = { tryLock: (name) => tryLockRestart(name), unlock: unlockRestart };

/** 条目带着没做完的 rename：kill 会盖掉那个标记，先把台账归属补过来（旧名已被别人占了就只报） */
async function settleRenameLedger(reg: Registry, name: string, deps: OpsDeps, notes: string[]): Promise<void> {
  const p = reg.agents[name]?.pending;
  if (p?.op !== "rename") return;
  if (reg.agents[p.from]) notes.push(`rename（${p.from} → ${name}）没做完且旧名已被新 agent 占用，台账归属没动，要人工核对：ledger task-set --agent`);
  else await deps.renameLedger(p.from, name);
}

/**
 * `kill <name> --session <id>`：只停这一个会话。调用方（换作者的调度，lib/fix-strategy-lifecycle.ts）在子进程起来之前核过的
 * 归属到这里已经旧了，所以整段在 restart 锁内做，每个 await 之后、下一个副作用之前重读 registry：置 stopped 前、关窗口前（窗口
 * id 集合还得和进来时一样，只关当时看到的那几个）、归档 / 删频道前、最后落盘前。拒绝一律 `refused`，文案不含「不存在 / 正在」：
 * lib/scheduler-retire.ts 的 killOutcome 不能把它读成已停或忙。`untouched` = 一个字节都没动。
 */
async function killSession(name: string, deps: OpsDeps, sessionId: string, opts: KillOptions): Promise<Record<string, unknown>> {
  const refuse = (why: string, untouched: boolean, refused = "identity") =>
    ({ ok: false, agent: name, refused, untouched, error: `${name} 按会话 ${sessionId} 停止被拒：${why}${untouched ? "，未动" : "，已停手"}` });
  const lock = opts.restartLock ?? fileRestartLock;
  if (!lock.tryLock(name)) return refuse("restart 锁被占用", true, "restart-lock");
  try {
    const snapshot = opts.sessionRegistry ?? (() => readStopRegistry<Registry>());
    let expected: string[] | undefined;
    const check = (windows: string[], own?: AgentInfo["pending"]) =>
      verifyStopEdge(snapshot, name, sessionId, windows, expected, own, opts.fixStop);
    let why = check([]);
    if (why) return refuse(why, true);
    const ids = await deps.windowIds(name); expected = [...ids];
    const reg = snapshot(); // 窗口查询返回后同步重读，下面核完立刻置 stopped
    if ((why = check(ids))) return refuse(why, true);
    const info = reg.agents[name];
    if (info.status === "stopped" && !ids.length) return { ok: true, agent: name, alreadyStopped: true, message: `${name} 早已销毁，无事可做。` };
    const own = newPending("kill", {}, deps.now());
    Object.assign(info, { status: "stopped", pending: own });
    await deps.saveRegistry(reg);
    for (const id of ids) {
      if ((why = check(await deps.windowIds(name), own))) return refuse(why, false);
      await deps.killWindowId(id);
      expected = expected.filter((current) => current !== id);
    }
    if ((why = check(await deps.windowIds(name), own))) return refuse(why, false);
    await deps.archive(name, info);
    const notes: string[] = [], left: string[] = [];
    if (info.channelId && !(why = check(await deps.windowIds(name), own))) {
      const r = await deps.deleteChannel(info.channelId);
      if (typeof r === "object") {
        if (opts.force) notes.push(`频道 ${info.channelId} 删不掉，按 --force 放弃（去 Discord 手动删）`);
        else { left.push("channel"); notes.push(channelFailureText(info.channelId, r)); }
      }
      if ((why = check(await deps.windowIds(name), own))) return refuse(why, false);
      await deps.agentCleanup(info.channelId, name);
    }
    const windows = await deps.windowIds(name), last = snapshot();
    if ((why ??= check(windows, own))) return refuse(why, false);
    if (left.length) last.agents[name].pending = { ...own, pid: 0, left };
    else delete last.agents[name].pending;
    await deps.saveRegistry(last);
    if ((why = check(await deps.windowIds(name), last.agents[name].pending))) return refuse(why, false);
    await deps.rescan("remove", name);
    return left.length
      ? { ok: true, agent: name, incomplete: left, notes, message: `${name} 已停止，但频道没删成：${notes.at(-1)}；之后再跑 kill 或 manager repair --apply 补` }
      : { ok: true, agent: name, ...(notes.length ? { notes } : {}), message: `${name} 已销毁。` };
  } finally { lock.unlock(name); }
}

export async function runKill(name: string, deps: OpsDeps, opts: KillOptions = {}): Promise<Record<string, unknown>> {
  if (isMasterAgent(name)) return { ok: false, error: "大总管不能 kill（它由 launcher 守护）" };
  if (opts.session !== undefined) return killSession(name, deps, opts.session, opts);
  let reg = await deps.loadRegistry();
  const info = reg.agents[name];
  const winNames = windowNamesOf(reg, name);
  const hasWindow = (await deps.listWindows()).some((w) => winNames.includes(w));
  if (!info && !hasWindow) return { ok: false, error: `${name} 不存在` };
  if (info?.pending && isPendingLive(info.pending, deps.now(), deps.alive)) {
    return { ok: false, error: `${name} 正在 ${info.pending.op}（pid ${info.pending.pid}），等它结束再试` };
  }
  // 窗口暂时不在可能是 restart 在重建：这时按「没窗口也往下」删频道、置 stopped，会和 restart 打架
  if (deps.restartInProgress(name)) return { ok: false, error: `${name} 正在 restart（窗口在重建），等它结束再 kill` };
  if (info?.pending?.op === "create") {
    const r = await clearCreateResidue(name, deps, { force: opts.force, restoreStopped: true, expect: info.pending }); // 放回的旧条目别是 active，否则 launcher 会拉活
    return r.ok
      ? { ok: true, agent: name, message: `${name} 是做到一半的 create，已清理：${r.steps.join("；")}` }
      : { ok: false, agent: name, error: r.error };
  }
  if (info?.status === "stopped" && !info.pending && !hasWindow) {
    return { ok: true, agent: name, alreadyStopped: true, message: `${name} 早已销毁，无事可做。` };
  }

  const notes: string[] = [];
  if (info) {
    await settleRenameLedger(reg, name, deps, notes);
    info.status = "stopped";
    info.pending = newPending("kill", {}, deps.now());
    await deps.saveRegistry(reg);
  }
  if (hasWindow) await killWindows(winNames, deps);
  // 会话退役 → 归档 jsonl 快照（CC 的 cleanupPeriodDays 会清源文件）
  if (info?.sessionId) await deps.archive(name, info);
  const left: string[] = [];
  if (info?.channelId) {
    const r = await deps.deleteChannel(info.channelId);
    if (typeof r === "object") {
      if (opts.force) notes.push(`频道 ${info.channelId} 删不掉，按 --force 放弃（去 Discord 手动删）`);
      else {
        left.push("channel");
        notes.push(channelFailureText(info.channelId, r));
      }
    }
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
    ? { ok: true, agent: name, incomplete: left, notes, message: `${name} 已停止，但频道没删成：${notes.at(-1)}；之后再跑 kill 或 manager repair --apply 补` }
    : { ok: true, agent: name, ...(notes.length ? { notes } : {}), message: `${name} 已销毁。` };
}

/**
 * 永久移除：kill 收尾 + registry 条目整个删除（列表不再显示）。归档文件保留——删列表 ≠ 删档案，
 * 误删的 agent 用 create + resume --fork 可以重建。
 */
export async function runRemove(name: string, deps: OpsDeps, opts: KillOptions = {}): Promise<Record<string, unknown>> {
  if (isMasterAgent(name)) return { ok: false, error: "大总管不能 remove（它由 launcher 守护）" };
  if (opts.archiveOnly) return removeArchiveOnly(name, deps, opts.archiveOnly);
  const reg = await deps.loadRegistry();
  const info = reg.agents[name];
  const winNames = windowNamesOf(reg, name);
  const hasWindow = (await deps.listWindows()).some((w) => winNames.includes(w));
  if (!info && !hasWindow) return { ok: false, error: `${name} 不存在` };
  if (info?.pending && isPendingLive(info.pending, deps.now(), deps.alive)) {
    return { ok: false, error: `${name} 正在 ${info.pending.op}（pid ${info.pending.pid}），等它结束再试` };
  }
  if (deps.restartInProgress(name)) return { ok: false, error: `${name} 正在 restart（窗口在重建），等它结束再 remove` };
  if (hasWindow) await killWindows(winNames, deps);
  if (info?.sessionId) await deps.archive(name, info);
  const channelId = info?.channelId || (info?.pending?.op === "create" ? info.pending.channelId : undefined);
  if (channelId) {
    const r = await deps.deleteChannel(channelId);
    if (typeof r === "object" && !opts.force) {
      // 条目留成「已停止 + 欠删频道」：launcher 不会把它当 dead 拉回来，doctor / repair 能看到那个频道
      const fresh = await deps.loadRegistry();
      if (fresh.agents[name]) Object.assign(fresh.agents[name], { status: "stopped", pending: { ...newPending("kill", {}, deps.now()), pid: 0, left: ["channel"] } });
      await deps.saveRegistry(fresh);
      return { ok: false, agent: name, error: `${channelFailureText(channelId, r)}。窗口已关、条目置为 stopped 先留着，之后再跑 remove` };
    }
  }
  const fresh = await deps.loadRegistry();
  delete fresh.agents[name];
  dropCaseVariants(fresh, name);
  (await import("./team.js")).repointParentRefs(fresh, name); // 清掉子 agent 指向它的 parent，免得同名重建被旧孤儿认作父
  await deps.saveRegistry(fresh);
  removeAgentSettings(name); // 按 agent 的技能开关随永久删除一起清掉（kill 只是停止，保留）
  await deps.rescan("remove", name);
  if (channelId) await deps.agentCleanup(channelId, name);
  return { ok: true, agent: name, message: `${name} 已永久移除（会话归档保留）。` };
}

/** runRemove 的 archive-only 分支：有窗口 / pending / restart / 会话不符 / 大小写歧义一律拒，不退化成普通 remove */
async function removeArchiveOnly(name: string, deps: OpsDeps, o: ArchiveOnlyRemove): Promise<Record<string, unknown>> {
  const refuse = (why: string) => ({ ok: false, agent: name, error: `${name} archive-only 退役拒绝：${why}` });
  const reg = await deps.loadRegistry();
  const info = reg.agents[name];
  if (!info) return { ok: false, agent: name, error: `${name} 不存在` };
  if (info.pending) return refuse(`条目带未完成的 ${info.pending.op}`);
  if (deps.restartInProgress(name)) return refuse("restart 进行中");
  if (info.status !== "stopped" || info.sessionId !== o.sessionId) return refuse(`条目不是已停的会话 ${o.sessionId}`);
  if (Object.keys(reg.agents).some((k) => k !== name && k.toLowerCase() === name.toLowerCase())) return refuse("registry 有大小写变体，归属不明");
  if ((await deps.listWindows()).some((w) => w.toLowerCase() === name.toLowerCase())) return refuse("窗口还在，不 kill");
  try { o.verify(info); } catch (e) { return refuse((e as Error).message); }
  delete reg.agents[name];
  await o.save(reg);
  return { ok: true, agent: name, archiveOnly: true, message: `${name} registry 记录已退役（archive-only，会话归档保留，未 kill / 未删频道与磁盘）。` };
}

export async function cmdKill(name: string, opts: KillOptions = {}): Promise<void> {
  output(await runKill(normalizeName(name), realOpsDeps, opts));
}

export async function cmdRemove(name: string, opts: KillOptions = {}): Promise<void> {
  output(await runRemove(normalizeName(name), realOpsDeps, opts));
}
