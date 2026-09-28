/**
 * `manager repair [--apply]`：把 doctor 报出的半截操作收拾干净。默认只列计划，--apply 才动手。
 *
 * 只处理 registry 里有据可查的残留（lib/pending-ops.ts isAutoRepairable）：没登记的窗口、没登记的频道
 * 只报不碰。每一项动手前按最新 registry 再核一次——计划列出之后状态可能已变（别的命令刚接手、
 * 条目被 resume 成 active），核不上就跳过，绝不按旧快照删东西。
 */
import { describeResidue, isAutoRepairable, isPendingLive, scanResidues, type Residue, type ScanInput } from "../lib/pending-ops.js";
import { output } from "./core.js";
import { clearCreateResidue } from "./create-guard.js";
import { runKill } from "./agent-kill.js";
import { runRename } from "./agent-rename.js";
import { realOpsDeps, type OpsDeps } from "./ops-deps.js";

/** 计划列出之后状态还一致吗 */
async function stillApplies(r: Residue, deps: OpsDeps): Promise<boolean> {
  const a = (await deps.loadRegistry()).agents[r.agent];
  switch (r.kind) {
    case "stale-create":
    case "stale-kill":
    case "stale-rename": {
      const op = r.kind === "stale-create" ? "create" : r.kind === "stale-kill" ? "kill" : "rename";
      return a?.pending?.op === op && !isPendingLive(a.pending, deps.now(), deps.alive);
    }
    case "orphan-window": return a?.status === "stopped" && !a.pending && (await deps.listWindows()).includes(r.agent);
    case "orphan-channel": // 窗口又出现了 = 可能被拉起来在用，频道不能删
      return a?.status === "stopped" && !a.pending && a.channelId === r.channelId && !(await deps.listWindows()).includes(r.agent);
    default: return false;
  }
}

async function fixOne(r: Residue, deps: OpsDeps, force: boolean): Promise<{ ok: boolean; detail: string }> {
  switch (r.kind) {
    case "stale-create": {
      const c = await clearCreateResidue(r.agent, deps, { force });
      return { ok: c.ok, detail: c.ok ? c.steps.join("；") : c.error! };
    }
    case "stale-kill": {
      const reg = await deps.loadRegistry();
      const a = reg.agents[r.agent]!;
      if (a.status !== "stopped") {
        // kill 标记挂在 active 条目上 = 之后被 restart / resume 拉起来了：kill 的意图已作废，只清标记，绝不再杀
        delete a.pending;
        await deps.saveRegistry(reg);
        return { ok: true, detail: `条目是 ${a.status}（已被重新拉起），只清掉旧的 kill 标记` };
      }
      // kill 被砍在关窗之前、窗口里的会话还在跑（用户可能一直在用）：要不要杀交给人，repair 不替他决定
      if ((await deps.listWindows()).includes(r.agent) && !(await deps.windowIsBareShell(r.agent))) {
        return { ok: false, detail: `窗口里还有进程在跑：确认要销毁就再跑 kill ${r.agent}，想留着就 restart ${r.agent}（会清掉这个 kill 标记）` };
      }
      const k = await runKill(r.agent, deps, { force });
      return { ok: k.ok === true && !k.incomplete, detail: String(k.message ?? k.error) };
    }
    case "stale-rename": {
      const n = await runRename(r.from, r.agent, deps);
      return { ok: n.ok === true && !n.incomplete, detail: n.ok ? "窗口 / 台账 / 频道已补改" : String(n.error) };
    }
    case "orphan-window":
      // registry 说 stopped 而窗口里还有进程 = 多半是 registry 漏写了 active、agent 正在用：只报，别关
      if (!(await deps.windowIsBareShell(r.agent))) return { ok: false, detail: `窗口里还有进程在跑，不关——在用就 restart ${r.agent} 把 registry 改回 active，确认不用再手动关` };
      await deps.killWindow(r.agent);
      return { ok: true, detail: "窗口只剩 shell，已关" };
    case "orphan-channel": {
      const d = await deps.deleteChannel(r.channelId);
      if (typeof d === "object") return { ok: false, detail: `删频道失败：${d.error}` };
      await deps.agentCleanup(r.channelId, r.agent);
      return { ok: true, detail: d === "gone" ? "频道早已不在" : "频道已删" };
    }
    default:
      return { ok: false, detail: "不自动处理" };
  }
}

/** force：频道删不掉（bridge 不在 / Discord 没权限）的 create / kill 残留，放弃删频道这一步照样收尾 */
export async function runRepair(apply: boolean, input: ScanInput, deps: OpsDeps, force = false): Promise<Record<string, unknown>> {
  const residues = scanResidues(input).filter((r) => r.kind !== "busy");
  const plan = residues.map((r) => ({ agent: r.agent, kind: r.kind, what: describeResidue(r), auto: isAutoRepairable(r) }));
  const channelsChecked = input.channels !== null;
  if (!apply) {
    return {
      ok: true, dryRun: true, plan, channelsChecked,
      message: plan.length ? `${plan.filter((p) => p.auto).length} 项可自动处理；加 --apply 执行（auto:false 的只报不碰）` : "没有残留",
    };
  }
  const applied: Array<{ agent: string; kind: string; ok: boolean; detail: string }> = [];
  for (const r of residues.filter(isAutoRepairable)) {
    if (!(await stillApplies(r, deps))) {
      applied.push({ agent: r.agent, kind: r.kind, ok: true, detail: "状态已变（别的命令接手 / 已恢复），跳过" });
      continue;
    }
    const res = await fixOne(r, deps, force).catch((e) => ({ ok: false, detail: (e as Error).message }));
    applied.push({ agent: r.agent, kind: r.kind, ...res });
  }
  const skipped = plan.filter((p) => !p.auto);
  return { ok: applied.every((x) => x.ok), applied, ...(skipped.length ? { skipped } : {}), channelsChecked };
}

export async function cmdRepair(args: string[]): Promise<void> {
  const { gatherScanInput } = await import("../lib/doctor-pending.js");
  output(await runRepair(args.includes("--apply"), await gatherScanInput(), realOpsDeps, args.includes("--force")));
}
