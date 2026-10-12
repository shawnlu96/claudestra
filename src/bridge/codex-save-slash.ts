/**
 * ACP 版 Codex 的 /save-compact、/save-clear 斜杠入口（api-slash.ts 一行转进来）：权限和现有 ACP /clear 同一条——只给 owner，
 * 不收附件；开跑后立刻回 202，进度 / 结果发到 agent 频道（网页实时事件 + Discord 抄送），编排在 codex-save.ts。
 * tests/codex-save-slash.test.ts。
 */
import { apiJson } from "./api-respond.js";
import { emitEvent } from "./event-bus.js";
import { agentNameForChannel } from "./jsonl-watcher.js";
import { SLASH_OWNER_ONLY, type SlashDeps, type SlashRequest } from "./api-slash.js";
import { startCodexSave, type CodexSaveDeps } from "./codex-save.js";
import type { CodexSaveKind } from "../lib/codex-save.js";

export async function codexSaveSlash(
  r: SlashRequest, kind: CodexSaveKind, owner: boolean, deps: SlashDeps, save: Partial<CodexSaveDeps> = {},
): Promise<Response> {
  const { agent } = r;
  if (!owner) return apiJson(403, { ok: false, ...SLASH_OWNER_ONLY });
  if (r.hasAttachments) return apiJson(409, { ok: false, error: `/${kind} 不接收附件；什么都没做` });
  const by = r.principal.name || r.tokenId;
  const notify = (text: string) => {
    emitEvent({ agent: agentNameForChannel(agent.channelId) || agent.name, chatId: agent.channelId, type: "chat_message", data: { direction: "out", from: `⚙️ ${kind}`, text } });
    // Discord 抄送只是镜像：失败不影响流程，mirror 内部已记日志
    deps.mirror({ kind: "api", tokenId: r.tokenId, name: by }, agent.channelId, `[⚙️ ${kind}] ${text}`).catch(() => {});
  };
  const started = startCodexSave(kind, { name: agent.name, channelId: agent.channelId }, { notify, ...save });
  if ("error" in started) return apiJson(409, { ok: false, error: started.error });
  deps.record(kind, agent);
  deps.markThinking(agent);
  console.log(`💾 [api] ${kind} 开跑 ${agent.name}（${by}）`);
  void started.run.then((res) => console.log(`💾 [api] ${kind} ${agent.name} ${res.ok ? "完成" : `停在 ${res.stage}：${res.error}`}`), (e) => console.error(`💾 [api] ${kind} ${agent.name} 流程出错：${e instanceof Error ? e.message : e}`));
  return apiJson(202, { ok: true, accepted: true, slash: true, agent: agent.name, acp: true, save: kind });
}
