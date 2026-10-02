import { createHash } from "node:crypto";
import { bindHash, canonicalJson, checkAsk } from "../lib/ask-bind.js";
import { getAsk, listAsks, patchAsk, MASTER_PROJECT, ownerAnswered, type Ask, type AskBind } from "../lib/ledger-asks.js";
import { STATE_DIR } from "../lib/paths.js";
import { readSharedLedgerBindings, type SharedLedgerBinding } from "../lib/shared-ledger-gate-bindings.js";
import { rebindSharedLedgerBinding } from "../lib/shared-ledger-gate-bindings-rebind.js";
import {
  readSharedLedgerLocalProjects, sharedLedgerProjectChoices, sharedLedgerEligibleProjects, type SharedLedgerLocalProject, type SharedLedgerProjectChoice,
} from "../lib/shared-ledger-local-project.js";
import { askDb, askReadDb, createAsk, type CreateAskInput } from "./asks.js";

const CREATOR = "system:shared-ledger-rebind";
const TTL = 24 * 3600_000;
const SKIP = "sl_rebind_skip";
interface RebindSnapshot { binding: SharedLedgerBinding; choices: SharedLedgerProjectChoice[]; key: string }
export interface SharedLedgerRebindDeps {
  now: () => number;
  bindings: () => SharedLedgerBinding[];
  projects: () => Promise<SharedLedgerLocalProject[]>;
  asks: () => Ask[];
  openAsk: (input: CreateAskInput) => Ask;
  claim: (a: Ask) => boolean;
  rebind: (previous: SharedLedgerBinding, localProjectId: string) => Promise<void>;
  inform: (text: string) => Promise<void>;
}
const bindOf = (snapshot: RebindSnapshot): Omit<AskBind, "paramsHash"> => ({
  action: "shared_ledger_rebind", params: snapshot, approve: snapshot.choices.map(c => c.button),
});
const inFlight = new Set<string>();

/** Pending and answered cards survive bridge restarts in the ask ledger. Only an expired unanswered card is offered again. */
export async function sweepSharedLedgerRebinds(d: SharedLedgerRebindDeps): Promise<void> {
  if (!d.bindings().length) return;
  const projects = await d.projects(), asks = d.asks();
  for (const a of asks.filter(a => a.createdBy === CREATOR && a.state === "answered" && !a.extra.rebindSettled)) {
    await onSharedLedgerRebindAnswered(a, d);
  }
  for (const binding of d.bindings()) {
    if (projects.some(p => p.id === (binding.localProjectId ?? binding.projectId))) continue;
    const key = createHash("sha256").update(canonicalJson(binding)).digest("hex");
    if (d.asks().some(a => a.createdBy === CREATOR && (a.extra.sharedLedgerRebind as RebindSnapshot | undefined)?.key === key
      && (a.state !== "expired" && (a.state !== "open" || a.expiresAt > d.now())))) continue;
    const eligible = sharedLedgerEligibleProjects(projects, d.bindings(), binding);
    const choices = sharedLedgerProjectChoices(eligible, binding.projectId, "sl_rebind");
    if (!choices.length) continue;
    const snapshot = { binding, choices, key }, bind = bindOf(snapshot), expiresAt = d.now() + TTL;
    d.openAsk({
      source: "system", createdBy: CREATOR, project: MASTER_PROJECT, kind: "authorize", title: "共享台账需要绑定本机项目",
      context: `团队 ${binding.teamId} / 共享项目 ${binding.projectId}：本机项目 ${binding.localProjectId ?? binding.projectId} 已不存在。请选择改绑项目。`,
      options: [{ type: "buttons", buttons: [...choices.map(c => ({ id: c.button,
        label: `改绑到 ${c.name.slice(0, 60)}${c.localProjectId === binding.projectId ? "（同名）" : ""}`, style: "success" })),
        { id: SKIP, label: "暂不改绑", style: "secondary" }] }],
      allowText: false, blocking: false, expiresAt, dedupKey: `sl-rebind:${key}:${expiresAt}`,
      bind: { ...bind, paramsHash: bindHash(bind, CREATOR) }, extra: { sharedLedgerRebind: snapshot },
    });
  }
}

/** Owner identity, exact approved snapshot, one selected project and live pins are all required before any write. */
export async function onSharedLedgerRebindAnswered(a: Ask, d: SharedLedgerRebindDeps): Promise<void> {
  if (a.createdBy !== CREATOR || a.state !== "answered" || a.extra.rebindSettled || inFlight.has(a.id)) return;
  const snapshot = a.extra.sharedLedgerRebind as RebindSnapshot | undefined;
  if (!snapshot || !d.claim(a)) return;
  inFlight.add(a.id);
  try {
    const choices = snapshot.choices.filter(c => a.answer?.choices.includes(`[button:${c.button}]`));
    if (!choices.length) return;
    if (choices.length !== 1 || !ownerAnswered(a.answer)
      || !checkAsk({ ...a, fromAgent: CREATOR }, bindHash(bindOf(snapshot), CREATOR), CREATOR, d.now()).ok) {
      return await d.inform("⚠️ 改绑未执行：授权无效或已过期，请重新检查。");
    }
    if (!(await d.projects()).some(p => p.id === choices[0]!.localProjectId)) {
      return await d.inform("⚠️ 改绑未执行：所选本机项目已不存在。");
    }
    try {
      await d.rebind(snapshot.binding, choices[0]!.localProjectId);
    } catch (e) {
      const reason = e instanceof Error && ["绑定已变化，请重新检查", "本机 owner 缺少该共享项目的读取凭据", "所选项目或中心与已有 pins 不符"].includes(e.message)
        ? e.message : "本机共享台账状态无法读取或写入";
      return await d.inform(`⚠️ 改绑未执行：${reason}。`);
    }
    await d.inform(`✅ 共享项目 ${snapshot.binding.projectId} 已改绑到本机项目 ${choices[0]!.name}，可在该项目下打开「团队 · 全部 feature」。`);
  } finally {
    inFlight.delete(a.id);
  }
}

export function liveRebindDeps(inform: SharedLedgerRebindDeps["inform"]): SharedLedgerRebindDeps {
  return {
    now: () => Date.now(), bindings: () => readSharedLedgerBindings(STATE_DIR), projects: () => readSharedLedgerLocalProjects(STATE_DIR),
    asks: () => {
      const db = askReadDb();
      return db ? listAsks(db, { project: MASTER_PROJECT, source: "system" }) : [];
    },
    claim: a => {
      const db = askDb(), current = getAsk(db, a.id);
      if (!current || current.state !== "answered" || current.extra.rebindSettled) return false;
      patchAsk(db, a.id, { extra: { rebindSettled: true } });
      return true;
    },
    openAsk: input => createAsk(input), rebind: (previous, id) => rebindSharedLedgerBinding(previous, id), inform,
  };
}
