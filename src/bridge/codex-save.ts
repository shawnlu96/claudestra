/**
 * Codex（ACP）版 /save-compact、/save-clear 的编排（入口是 api-slash.ts，只给 owner）：
 * 1. 独占一轮 op_turn 让 Codex 把交接写进 lib/codex-save.ts 定的文件，等宿主报这一槽的结局；
 * 2. 结局是 done 且文件核对过（首行带本轮 opId）才往下走，否则停在原地告诉 owner——落盘失败绝不压缩 / 清空；
 * 3. save-compact：独占槽发 /compact（自研适配器转 thread/compact/start，等压缩回合收尾）；
 *    save-clear：acpClear 换会话（结果不明 = 504 语义：不重试、不重清），成功后新会话第一轮带上交接原文。
 * 整个流程在 HTTP 回 202 之后跑（落盘回合要几分钟），进度和失败都发到 agent 频道。同一 agent 同时只跑一个。
 * tests/codex-save.test.ts、tests/codex-save-slash.test.ts。
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { acpClear, acpOpTurn, acpSlash, acpSlotStatus } from "./acp-link.js";
import { checkHandoff, codexHandoffPath, codexRestorePrompt, codexSavePrompt, type CodexSaveKind } from "../lib/codex-save.js";
import type { HostSlotState } from "../lib/acp/turn.js";

type CallResult = { ok: boolean; error?: string; uncertain?: true; slot?: HostSlotState; sessionId?: string };

/** ACP 通道（生产 = acp-link；单测注入假的） */
export interface CodexSaveLink {
  opTurn(channelId: string, text: string, opId: string): Promise<CallResult>;
  slash(channelId: string, text: string, opId: string): Promise<CallResult>;
  slotStatus(channelId: string, opId: string, ref: { hostId?: string; gen?: number }, waitMs: number): Promise<CallResult>;
  /** then = 换代成功后宿主排在队首的第一轮（恢复入站之前，lib/acp/clear.ts）；结果不明 / 失败时宿主不提交 */
  clear(channelId: string, then: { text: string; opId: string }): Promise<CallResult>;
}

export interface CodexSaveDeps {
  link?: CodexSaveLink;
  /** 往 agent 频道发一行（网页 + Discord）；失败只记日志。最后一行带上结构化结果（504 / clear_result_unknown 等），给调用方认 */
  notify(text: string, result?: CodexSaveResult): void;
  readHandoff?: (path: string) => Promise<string | null>;
  /** 每一槽最多等多久（毫秒）：超时停在原地，不往下走 */
  slotBudgetMs?: number;
  /** 单次 slot_status 等待；宿主没在这么久里回就再问一次 */
  pollMs?: number;
}

export interface CodexSaveAgent {
  name: string;
  channelId: string;
}

export type CodexSaveResult =
  | { ok: true; kind: CodexSaveKind; path: string; sessionId?: string }
  | { ok: false; kind: CodexSaveKind; stage: "save" | "compact" | "clear" | "restore"; error: string; status?: 504; code?: "clear_result_unknown" };

const LINK: CodexSaveLink = {
  opTurn: acpOpTurn, slash: acpSlash, clear: acpClear,
  slotStatus: (ch, opId, ref, waitMs) => acpSlotStatus(ch, opId, ref, waitMs || undefined), // 0 = 不等，只查一次（不能当 0ms 超时）
};
const SLOT_BUDGET_MS = 30 * 60_000;
const POLL_MS = 5 * 60_000;
const running = new Set<string>();

const readOrNull = (path: string) => readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
  if (e.code === "ENOENT") return null;
  throw e;
});

/** 交一槽给宿主并等它的结局；只有 done 才算成，其余（失败 / 被打断 / 宿主不认 / 等超时）都给原因 */
async function runSlot(link: CodexSaveLink, ch: string, opId: string, submit: Promise<CallResult>, budgetMs: number, pollMs: number): Promise<string | null> {
  const sub = await submit;
  if (!sub.ok || !sub.slot) return `没交给宿主：${sub.error ?? "宿主没回槽信息"}`;
  const ref = { hostId: sub.slot.hostId, gen: "gen" in sub.slot ? sub.slot.gen : undefined };
  const deadline = Date.now() + budgetMs;
  for (let slot = sub.slot; ; ) {
    if (slot.state === "ended") return slot.outcome === "done" ? null : `这一轮${slot.outcome === "cancelled" ? "被打断" : slot.outcome === "revoked" ? "被撤掉" : "失败"}了`;
    if (slot.state === "gone") return "宿主不认这一轮了（宿主重启过？）";
    const left = deadline - Date.now();
    if (left <= 0) return `等了 ${Math.round(budgetMs / 60_000)} 分钟这一轮还没结束`;
    const r = await link.slotStatus(ch, opId, ref, Math.min(pollMs, left));
    if (r.ok && r.slot) slot = r.slot;
    else if (!r.uncertain) return `查不到这一轮的状态：${r.error ?? "宿主答非所问"}`;
  }
}

const newOpId = (agent: string, step: string) => `${step}-${agent.replace(/[^\w.-]/g, "_").slice(0, 60)}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

/**
 * 开跑完整流程（不等它结束）。不能开时给原因、什么都没发：同一 agent 已有一个在跑、名字不能当目录。
 * ponytail: 单飞只在进程内，bridge 重启后旧流程就断了（槽结局没人接，不会误压缩），要跨重启续接再落盘。
 */
export function startCodexSave(kind: CodexSaveKind, agent: CodexSaveAgent, deps: CodexSaveDeps): { run: Promise<CodexSaveResult> } | { error: string } {
  let path: string;
  try {
    path = codexHandoffPath(agent.name);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (running.has(agent.name)) return { error: `${agent.name} 已有一个 save-compact / save-clear 在跑，等它结束再点` };
  running.add(agent.name);
  return { run: runCodexSave(kind, agent, path, deps).finally(() => running.delete(agent.name)) };
}

async function runCodexSave(kind: CodexSaveKind, agent: CodexSaveAgent, path: string, deps: CodexSaveDeps): Promise<CodexSaveResult> {
  const link = deps.link ?? LINK;
  const budget = deps.slotBudgetMs ?? SLOT_BUDGET_MS;
  const poll = deps.pollMs ?? POLL_MS;
  const ch = agent.channelId;
  const fail = (stage: "save" | "compact" | "clear" | "restore", error: string, extra: { status?: 504; code?: "clear_result_unknown" } = {}): CodexSaveResult => {
    const res: CodexSaveResult = { ok: false, kind, stage, error, ...extra };
    deps.notify(`⚠️ /${kind} 停在「${STAGE_LABEL[stage]}」${extra.code ? `（${extra.status} ${extra.code}）` : ""}：${error}`, res);
    return res;
  };
  const done = (text: string, res: CodexSaveResult) => (deps.notify(text, res), res);

  const saveOp = newOpId(agent.name, "save");
  deps.notify(`💾 /${kind}：先让 Codex 把交接存到 ${path}，存好才${kind === "save-compact" ? "压缩" : "换新会话"}`);
  const saveErr = await runSlot(link, ch, saveOp, link.opTurn(ch, codexSavePrompt(kind, path, saveOp), saveOp), budget, poll);
  if (saveErr) return fail("save", `${saveErr}；没有${kind === "save-compact" ? "压缩" : "清空"}`);
  const raw = await (deps.readHandoff ?? readOrNull)(path).catch((e: unknown) => new Error(`读交接文件失败：${e instanceof Error ? e.message : e}`));
  const check = raw instanceof Error ? { ok: false as const, why: raw.message } : checkHandoff(raw, saveOp);
  if (!check.ok) return fail("save", `${check.why}；没有${kind === "save-compact" ? "压缩" : "清空"}`);

  if (kind === "save-compact") {
    const compactOp = newOpId(agent.name, "compact");
    const err = await runSlot(link, ch, compactOp, link.slash(ch, "/compact", compactOp), budget, poll);
    if (err) return fail("compact", `${err}；交接已存在 ${path}`);
    return done(`✅ /save-compact 完成：交接在 ${path}，上下文已压缩`, { ok: true, kind, path });
  }

  const restoreOp = newOpId(agent.name, "restore");
  const cleared = await link.clear(ch, { text: codexRestorePrompt(path, check.content), opId: restoreOp });
  if (!cleared.ok) {
    return cleared.uncertain
      ? fail("clear", `${cleared.error ?? "换会话结果不明"}（没有重试）`, { status: 504, code: "clear_result_unknown" })
      : fail("clear", `${cleared.error ?? "换会话失败"}；交接已存在 ${path}`);
  }
  // 回读槽已由宿主在换代时排进队首：这里只按 opId 查它、等它的结局（宿主不认 then 的老版本会回 gone）
  const err = await runSlot(link, ch, restoreOp, link.slotStatus(ch, restoreOp, {}, 0), budget, poll);
  if (err) return fail("restore", `已换到新会话，但带交接的第一轮没跑成（${err}）；交接原文在 ${path}`);
  return done(`✅ /save-clear 完成：已换到新会话，第一轮已带上交接（${path}）`, { ok: true, kind, path, sessionId: cleared.sessionId });
}

const STAGE_LABEL = { save: "存交接", compact: "压缩", clear: "换会话", restore: "新会话回读交接" } as const;
