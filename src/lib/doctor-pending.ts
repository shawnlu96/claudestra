/**
 * doctor 里「做到一半的操作」类检查（doctor.ts 只留调用）：残留的 creating 占位 / 半截 kill / rename、
 * 孤儿窗口、孤儿频道、卡住的 update 标记。判定在 lib/pending-ops.ts 与 lib/update-inflight.ts（纯函数，有单测）；
 * 修复统一指向 `manager repair --apply`（update 指向再跑 update）。都正常时只出一行 ok。
 */
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import type { Check } from "./doctor.js";
import { REGISTRY_PATH } from "./registry.js";
import { TMUX_SOCK, MASTER_SESSION } from "./tmux-helper.js";
import { agentWindowsOrNull } from "./agent-windows.js";
import { bridgeRequest } from "./bridge-client.js";
import { describeResidue, pidAlive, scanResidues, type Residue, type ScanInput } from "./pending-ops.js";
import { launchdStartedAt, readUpdateMarker, updateVerdict, UPDATE_ABANDONED, UPDATE_INFLIGHT } from "./update-inflight.js";

const REPAIR = "bun src/manager.ts repair（先看计划）→ bun src/manager.ts repair --apply";

/** 残留 → doctor 行（纯函数，tests/pending-ops.test.ts） */
export function residueChecks(residues: Residue[], channelsKnown: boolean, windowsKnown = true): Check[] {
  const g = "agent";
  const pick = (...kinds: Residue["kind"][]) => residues.filter((r) => kinds.includes(r.kind));
  const out: Check[] = [];
  const half = pick("stale-create", "stale-kill", "stale-rename");
  const busy = pick("busy");
  const winReg = residues.filter((r) => r.kind === "orphan-window" && r.registered);
  const winFree = residues.filter((r) => r.kind === "orphan-window" && !r.registered);
  const chans = pick("orphan-channel");
  if (half.length) out.push({ group: g, name: "做到一半的操作", status: "warn", detail: half.map(describeResidue).join("；"), fix: REPAIR });
  if (busy.length) out.push({ group: g, name: "进行中的操作", status: "ok", detail: busy.map(describeResidue).join("；") });
  if (winReg.length) out.push({ group: g, name: "孤儿窗口", status: "warn", detail: winReg.map(describeResidue).join("；"), fix: REPAIR });
  if (winFree.length) {
    out.push({ group: g, name: "未登记窗口", status: "warn", detail: `${winFree.map((r) => r.agent).join(", ")} 不在 registry 里（可能是手开的，repair 不碰）`,
      fix: `确认没用后逐个关：tmux -S ${TMUX_SOCK} kill-window -t ${MASTER_SESSION}:<name>` });
  }
  if (chans.length) out.push({ group: g, name: "孤儿频道", status: "warn", detail: chans.map(describeResidue).join("；"), fix: REPAIR });
  if (!channelsKnown) out.push({ group: g, name: "孤儿频道", status: "warn", detail: "bridge 连不上，没查频道", fix: "bridge 起来后再跑 doctor" });
  if (!windowsKnown) out.push({ group: g, name: "孤儿窗口", status: "warn", detail: "tmux 列不出窗口，窗口 / 频道类没查", fix: "tmux 正常后再跑 doctor" });
  if (!out.some((c) => c.status !== "ok")) out.push({ group: g, name: "半截操作", status: "ok", detail: "没有残留（占位 / 半截 kill、rename / 孤儿窗口、频道）" });
  return out;
}

/** 读 registry + tmux + bridge，产出 scanResidues 的输入；repair 与 doctor 共用 */
export async function gatherScanInput(): Promise<ScanInput> {
  let agents: ScanInput["agents"] = {};
  if (existsSync(REGISTRY_PATH)) agents = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")).agents ?? {};
  const windows = (await agentWindowsOrNull())?.map((w) => w.name) ?? null; // null = tmux 出错，窗口 / 频道类检查跳过
  let channels: Set<string> | null = null;
  try {
    const r = await bridgeRequest({ type: "list_channels" });
    channels = new Set(((r?.channels ?? []) as Array<{ id: string }>).map((c) => c.id));
  } catch { /* bridge 不在：channels=null，孤儿频道这一项跳过并如实报出 */ }
  return { agents, windows, channels, now: Date.now(), alive: pidAlive };
}

async function checkUpdateMarker(repoRoot: string): Promise<Check[]> {
  const g = "config";
  const gone = readUpdateMarker(UPDATE_ABANDONED);
  const abandoned: Check[] = gone ? [{ group: g, name: "放弃补完的 update", status: "warn",
    detail: `update → ${gone.targetLabel} 停在 ${gone.step} 时仓库被改到别处，依赖 / daemon 可能不是新代码`,
    fix: `bun src/manager.ts install-cli 重装并 reload daemon（成功的 update 也会顺手清掉），核对后可删 ${UPDATE_ABANDONED}` }] : [];
  const m = readUpdateMarker();
  if (!m) return abandoned;
  const git = (...a: string[]) => spawnSync("git", ["-C", repoRoot, ...a], { encoding: "utf8" });
  const head = git("rev-parse", "HEAD").stdout?.trim() ?? "";
  const ahead = head !== m.target && git("merge-base", "--is-ancestor", m.target, "HEAD").status === 0;
  const { DAEMONS } = await import("./cli-install.js");
  const v = updateVerdict(m, head, Date.now(), pidAlive, Object.fromEntries(DAEMONS.map((x) => [x.label, launchdStartedAt(x.label)])), ahead);
  const what = `update → ${m.targetLabel}（${m.channel}，停在 ${m.step}，${m.startedAt}）`;
  switch (v.action) {
    case "live": return [...abandoned, { group: g, name: "update 进行中", status: "ok", detail: `${what}，pid ${m.pid} 还在跑` }];
    case "clear": return [...abandoned, { group: g, name: "update 标记", status: "ok", detail: `${what}：${v.why}，下次 update 自动清掉` }];
    case "report": return [...abandoned, { group: g, name: "卡住的 update", status: "warn", detail: `${what}：${v.why}`,
      fix: `bun src/manager.ts update（会把标记移到 abandoned 后照常更新；标记文件 ${UPDATE_INFLIGHT}）` }];
    default: return [...abandoned, { group: g, name: "卡住的 update", status: "warn",
      detail: `${what}：${v.action === "finish-reload" ? `这些 daemon 没在 reload 之后重启：${v.stale.join(", ")}` : "切到新版本后没做完（依赖 / 构建 / reload）"}`,
      fix: "bun src/manager.ts update（会从停下的那一步补完）" }];
  }
}

export async function checkPendingOps(repoRoot: string): Promise<Check[]> {
  let input: ScanInput;
  try {
    input = await gatherScanInput();
  } catch (e) {
    return [{ group: "agent", name: "半截操作", status: "warn", detail: `查不了：${(e as Error).message}` }];
  }
  return [...residueChecks(scanResidues(input), input.channels !== null, input.windows !== null), ...(await checkUpdateMarker(repoRoot))];
}
