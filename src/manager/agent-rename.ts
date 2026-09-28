/**
 * rename：tmux 窗口名 + registry key + 台账 + Discord 频道名 + displayName 同步。不重启会话。
 *
 * ①registry 迁移，新条目带 pending{op:rename, from} ②改窗口 ③台账改名 ④改频道名 ⑤清标记。
 * 标记先落盘：砍在之后任一步，再跑 `rename old new`（registry 已没有 old，凭 from===old 认出是补跑）
 * 或 repair 都能补 ②–⑤；没有这个标记的「新名已存在」仍拒绝（不认碰巧同名的条目）。
 */
import { AGENT_PREFIX } from "../lib/tmux-helper.js";
import { isPendingLive, newPending } from "../lib/pending-ops.js";
import { assertValidNewName, normalizeName, output } from "./core.js";
import { realOpsDeps, type OpsDeps } from "./ops-deps.js";

export async function runRename(oldName: string, newName: string, deps: OpsDeps): Promise<Record<string, unknown>> {
  try {
    assertValidNewName(newName);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const oldTmux = normalizeName(oldName);
  const newTmux = normalizeName(newName);
  if (oldTmux === newTmux) return { ok: false, error: "新旧名字相同，没啥可改的" };

  const reg = await deps.loadRegistry();
  const info = reg.agents[oldTmux];
  const target = reg.agents[newTmux];
  const resuming = target?.pending?.op === "rename" && target.pending.from === oldTmux;
  // 补跑期间旧名又被新建的 agent 占了：旧名窗口和台账都是它的，只补频道
  const oldTaken = resuming && !!info;
  const pend = resuming ? target!.pending! : info?.pending;
  if (pend && isPendingLive(pend, deps.now(), deps.alive)) {
    return { ok: false, error: `${resuming ? newTmux : oldTmux} 正在 ${pend.op}（pid ${pend.pid}），等它结束再试` };
  }
  if (!resuming) {
    if (!info) return { ok: false, error: `registry 里没有 ${oldTmux}` };
    if (info.pending) return { ok: false, error: `${oldTmux} 有做到一半的 ${info.pending.op}，先跑 manager repair --apply 收拾` };
    if (target) return { ok: false, error: `${newTmux} 已存在，换个名字` };
  }

  const newChannelName = newTmux.replace(AGENT_PREFIX, "");
  const entry = resuming ? target! : info!;
  const steps: Array<Record<string, unknown>> = [];

  if (!resuming) {
    reg.agents[newTmux] = { ...info!, displayName: newChannelName, pending: newPending("rename", { from: oldTmux }, deps.now()) };
    delete reg.agents[oldTmux];
    (await import("./team.js")).repointParentRefs(reg, oldTmux, newTmux); // 子 agent 的 parent 跟着改名
    await deps.saveRegistry(reg);
  }
  steps.push({ step: "registry", ok: true, ...(resuming ? { skipped: "上次已迁移" } : {}) });

  const windows = await deps.listWindows();
  if (!oldTaken && windows.includes(oldTmux) && !windows.includes(newTmux)) {
    const err = await deps.renameWindow(oldTmux, newTmux).then(() => null, (e) => (e as Error).message);
    steps.push({ step: "tmux rename-window", ok: !err, ...(err ? { raw: `error: ${err}` } : {}) });
  } else {
    steps.push({ step: "tmux rename-window", ok: false, skipped: windows.includes(newTmux) ? "窗口已是新名" : oldTaken ? "旧名已被新 agent 占用" : "tmux window 不存在" });
  }
  if (!oldTaken) await deps.renameLedger(oldTmux, newTmux); // 台账的执行者 / PM 名单跟着改名（重复跑找不到旧名 = 无事）

  let channelDone = true;
  if (entry.channelId) {
    const r = await deps.renameChannel(entry.channelId, newChannelName);
    channelDone = typeof r !== "object";
    steps.push({ step: "discord channel rename", ok: channelDone, ...(typeof r === "object" ? { reason: r.error } : r === "gone" ? { skipped: "频道已不在" } : {}) });
  }
  if (channelDone) {
    const fresh = await deps.loadRegistry();
    if (fresh.agents[newTmux]?.pending?.op === "rename") {
      delete fresh.agents[newTmux].pending;
      await deps.saveRegistry(fresh);
    }
  }
  // agent 名字变了，skill 映射的 agentName 要同步
  await deps.rescan("full");

  return {
    ok: true,
    from: oldTmux,
    to: newTmux,
    channelName: newChannelName,
    steps,
    ...(resuming ? { resumed: true } : {}),
    ...(channelDone ? {} : { incomplete: ["channel"] }),
    hint: channelDone
      ? "Claude Code 内部 session 的显示名会在下次 restart 时更新到新名（现在仍是旧的，不影响功能）。"
      : `频道没改成——bridge 恢复后再跑一次 rename ${oldTmux} ${newTmux}（或 manager repair --apply）即可补上`,
  };
}

export async function cmdRename(oldName: string, newName: string): Promise<void> {
  output(await runRename(oldName, newName, realOpsDeps));
}
