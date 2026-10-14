/**
 * 状态根维护面板(免 LLM 管理按钮,management.ts 一行分派)。Discord 管理按钮已按 ALLOWED_USER_IDS 拦过,点击者即 owner。
 * 动作按钮的 id 带进程内密钥的 HMAC(绑定频道 + 动作 + 参数):agent 自己贴的同名按钮核不过;核过后由 bridge 签发单次授权
 * (lib/state-maintenance/grant.ts,actor = owner),再经 runManager 调 `state-maintenance`。执行要两步:先看批准说明再确认。
 * bridge 只拿回 runId 与维护页入口;执行器与维护页在 bridge 之外,停 bridge 不影响。tests/state-maintenance-entry.test.ts。
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { openMaintenance, productionContext, type MaintContext } from "../lib/state-maintenance/context.js";
import { issueGrant, type GrantAction } from "../lib/state-maintenance/grant.js";

const PREFIX = "smaint:";
/** 管理面板入口(management.ts 的面板上同名按钮) */
const PANEL_ID = "smaint:panel";

/** 按钮校验码的密钥只在 bridge 内存里:不落盘(同用户的 agent 读不到),bridge 重启后旧面板作废 */
const MAC_KEY = randomBytes(32);

type RunManager = (...args: string[]) => Promise<any>;
type Reply = { text: string; components?: any[] };

/** 面板上的动作;runask 只出确认说明,不签授权 */
const ACTIONS = ["observe", "mode", "runask", "run", "recover", "note"] as const;
type Action = (typeof ACTIONS)[number];

export function macFor(key: Uint8Array, chatId: string, action: string, arg: string): string {
  return createHmac("sha256", key).update(`${chatId}\0${action}\0${arg}`).digest("hex").slice(0, 20);
}

const button = (chatId: string, action: Action, arg: string, label: string, style = "secondary", key: Uint8Array = MAC_KEY) =>
  ({ id: `${PREFIX}${action}:${arg}:${macFor(key, chatId, action, arg)}`, label, style });

/** 解析并核 HMAC;核不过返回 null */
export function parseButton(id: string, chatId: string, key: Uint8Array = MAC_KEY): { action: Action; arg: string } | null {
  const m = /^smaint:([a-z]+):([A-Za-z0-9._-]*):([0-9a-f]{20})$/.exec(id);
  if (!m || !(ACTIONS as readonly string[]).includes(m[1]!)) return null;
  const want = macFor(key, chatId, m[1]!, m[2]!);
  if (!timingSafeEqual(Buffer.from(want), Buffer.from(m[3]!))) return null;
  return { action: m[1] as Action, arg: m[2]! };
}

interface Status {
  ok: boolean; error?: string; mode: string; problems: string[]; barrier: unknown; pendingNotes: number;
  latestReport: { runId: string; sha256: string; snapshot: string; conflicts: number; createdAt: string } | null;
  runs: { runId: string; phase: string; outcome: string | null; noteOk: boolean | null }[];
}

const RECOVERABLE = new Set(["stopping", "probing", "pre-inventory", "migrating", "verifying", "rolling-back", "recording", "restoring", "failed-holding", "restore-failed"]);

export function panelFor(s: Status, chatId: string, key: Uint8Array = MAC_KEY): Reply {
  const lines = [`**🧰 状态根维护** 档位 \`${s.mode}\``];
  if (s.problems.length) lines.push(`⚠️ 维护根:${s.problems.join(";")}`);
  if (s.barrier) lines.push("🚧 维护屏障生效中");
  const r = s.latestReport;
  lines.push(r ? `最近预演 \`${r.runId}\`:${r.snapshot},冲突 ${r.conflicts}(${r.createdAt})` : "还没有预演报告");
  for (const x of s.runs) lines.push(`运行 \`${x.runId}\`:${x.phase} / ${x.outcome ?? "进行中"}${x.noteOk === false ? "(指针留存未完成)" : ""}`);
  if (s.pendingNotes) lines.push(`待补 ledger 指针 ${s.pendingNotes} 条`);
  const btns: any[] = [{ id: PANEL_ID, label: "刷新", style: "secondary" }];
  for (const m of ["off", "observe", "on"].filter((m) => m !== s.mode)) btns.push(button(chatId, "mode", m, `切到 ${m}`, m === "on" ? "danger" : "secondary", key));
  if (s.mode !== "off") btns.push(button(chatId, "observe", "", "预演(observe)", "primary", key));
  if (s.mode === "on" && r && !r.conflicts) btns.push(button(chatId, "runask", `${r.runId}.${r.sha256.slice(0, 16)}`, "批准维护窗口…", "danger", key));
  const extra: any[] = s.runs.filter((x) => RECOVERABLE.has(x.phase) || x.noteOk === false).slice(-3)
    .map((x) => button(chatId, "recover", x.runId, `恢复 ${x.runId.slice(-6)}`, "danger", key));
  if (s.pendingNotes) extra.push(button(chatId, "note", "", "补记指针", "secondary", key));
  return { text: lines.join("\n"), components: [{ type: "buttons", buttons: btns.slice(0, 5) }, ...(extra.length ? [{ type: "buttons", buttons: extra.slice(0, 5) }] : [])] };
}

const fmt = (r: any): string => (r?.ok ? "✅ " : "❌ ") + JSON.stringify(r ?? {}, null, 1).slice(0, 1500);

/** 签授权 + 调 manager;授权的 actor 是 bridge 判定的点击者(此入口只有 owner) */
async function act(ctx: MaintContext, runManager: RunManager, action: GrantAction, binding: Record<string, string>, args: string[]): Promise<Reply> {
  openMaintenance(ctx);
  const token = issueGrant(ctx.maintRoot, { action, actor: "owner", binding });
  return { text: fmt(await runManager("state-maintenance", ...args, "--grant", token)) };
}

export async function handleStateMaintButton(id: string, chatId: string, runManager: RunManager, ctx: MaintContext = productionContext()): Promise<Reply> {
  if (id === PANEL_ID) {
    const s = (await runManager("state-maintenance", "status")) as Status;
    return s?.ok ? panelFor(s, chatId) : { text: `❌ ${s?.error ?? "读不到维护状态"}` };
  }
  const b = parseButton(id, chatId);
  if (!b) return { text: "❌ 按钮校验不过(不是 bridge 贴出的维护面板,或 bridge 重启过),什么都没做;请重新打开面板" };
  try {
    if (b.action === "mode") return await act(ctx, runManager, "mode", { mode: b.arg }, ["mode", b.arg]);
    if (b.action === "observe") return await act(ctx, runManager, "observe", {}, ["observe"]);
    if (b.action === "recover") return await act(ctx, runManager, "recover", { runId: b.arg }, ["recover", b.arg]);
    if (b.action === "note") return await act(ctx, runManager, "note", {}, ["note-retry"]);
    const s = (await runManager("state-maintenance", "status")) as Status;
    const r = s?.latestReport;
    const [reportRunId, shaPrefix] = b.arg.split(/\.(?=[0-9a-f]{16}$)/);
    if (!r || r.runId !== reportRunId || !r.sha256.startsWith(shaPrefix ?? "")) return { text: "❌ 报告已变,请重新打开面板" };
    if (b.action === "runask") {
      return { text: `⚠️ 批准维护窗口:系统将停止 launcher / scheduler / cron / bridge、全部会话,停写确认后按报告 \`${r.runId}\` 迁移状态根,`
        + "失败自动回滚;维护页链接会回到这里。确认现在执行?", components: [{ type: "buttons", buttons: [button(chatId, "run", b.arg, "✅ 批准并执行", "danger")] }] };
    }
    return await act(ctx, runManager, "run", { reportRunId: r.runId, reportSha256: r.sha256 }, ["run", r.runId, r.sha256]);
  } catch (e) {
    return { text: `❌ ${(e as Error).message}` };
  }
}
