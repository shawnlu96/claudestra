/** registry 唯一写者的会话轮换。ACP /clear 用 expected 旧 id 防重试或并发覆盖别人的线程。 */
import { archiveAgentSession } from "../lib/session-archive.js";
import { isSandbox } from "../lib/sandbox.js";
import { assertSandboxSession } from "../lib/sandbox-sessions.js";
import { loadRegistry, normalizeName, saveRegistry } from "./core.js";

export async function cmdSetSession(args: string[]): Promise<Record<string, unknown>> {
  const [name, newSid] = args;
  if (!name || !newSid) return { ok: false, error: "usage: set-session <name> <sessionId> [--expected <oldId>]" };
  if (!/^[0-9a-f-]{8,64}$/i.test(newSid)) return { ok: false, error: `sessionId 形状非法: ${newSid}` };
  const expected = args[2] === "--expected" ? args[3] : undefined;
  if (args.length > 2 && !expected) return { ok: false, error: "--expected 缺旧 sessionId" };
  const tmuxName = normalizeName(name);
  const reg = await loadRegistry();
  const info = reg.agents[tmuxName];
  if (!info) return { ok: false, error: `${tmuxName} 不在 registry` };
  const oldSid = info.sessionId || null;
  if (expected && oldSid !== expected && oldSid !== newSid) return { ok: false, error: `会话已变化：预期 ${expected}，当前 ${oldSid ?? "无"}` };
  // 沙箱 ACP 的新 id 由隔离 HOME 下的本仓 stub 生成；其它运行时仍须能找到沙箱内会话文件。
  if (!(isSandbox() && info.runtime === "codex" && (info as { transport?: string }).transport === "acp")) assertSandboxSession(newSid);
  if (oldSid === newSid) return { ok: true, name: tmuxName, sessionId: newSid, previousSessionId: oldSid };
  if (oldSid) await archiveAgentSession(tmuxName, info, oldSid).catch((e) => console.warn(`⚠️ 归档旧会话 ${tmuxName} 失败：${e}`));
  info.sessionId = newSid;
  await saveRegistry(reg);
  return { ok: true, name: tmuxName, sessionId: newSid, previousSessionId: oldSid };
}
