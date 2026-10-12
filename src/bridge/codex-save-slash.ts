/**
 * ACP 版 Codex 的 /save-compact、/save-clear 斜杠入口（api-slash.ts 判过 owner 后转进来，和 ACP /clear 同一条权限）：
 * 不收附件；开跑后立刻回 202，进度 / 结果发到 agent 频道（网页实时事件 + Discord 抄送），编排在 codex-save.ts。
 * tests/codex-save-slash.test.ts。
 */
import { apiJson } from "./api-respond.js";
import { emitEvent } from "./event-bus.js";
import { agentNameForChannel } from "./jsonl-watcher.js";
import type { ApiUserEndpoint } from "./router.js";
import { startCodexSave, type CodexSaveDeps, type CodexSaveResult } from "./codex-save.js";
import type { CodexSaveKind } from "../lib/codex-save.js";

interface SaveAgent { name: string; channelId: string }
/** api-slash.ts SlashDeps 里用得到的那几项（不 import 它：会成环） */
export interface CodexSaveSlashDeps {
  mirror: (to: ApiUserEndpoint, agentChannelId: string, text: string) => Promise<void>;
  record: (cmd: string, agent: SaveAgent) => void;
  markThinking: (agent: SaveAgent) => void;
}

export interface CodexSaveSlashRequest { agent: SaveAgent; tokenId: string; by: string; hasAttachments: boolean }

export async function codexSaveSlash(
  r: CodexSaveSlashRequest, kind: CodexSaveKind, deps: CodexSaveSlashDeps, save: Partial<CodexSaveDeps> & { emit?: typeof emitEvent } = {},
): Promise<Response> {
  const { agent, by } = r;
  if (r.hasAttachments) return apiJson(409, { ok: false, error: `/${kind} 不接收附件；什么都没做` });
  // 最后一条带 codexSave（结构化结果：ok / stage / status 504 / code clear_result_unknown）：HTTP 已先回 202，调用方从事件认结局
  const notify = (text: string, result?: CodexSaveResult) => {
    const label = agentNameForChannel(agent.channelId) || agent.name;
    const data = { direction: "out", from: `⚙️ ${kind}`, text, ...(result ? { codexSave: result } : {}) };
    (save.emit ?? emitEvent)({ agent: label, chatId: agent.channelId, type: "chat_message", data });
    // Discord 抄送只是镜像：失败不影响流程，mirror 内部已记日志
    deps.mirror({ kind: "api", tokenId: r.tokenId, name: by }, agent.channelId, `[⚙️ ${kind}] ${text}`).catch(() => {});
  };
  const started = startCodexSave(kind, { name: agent.name, channelId: agent.channelId }, { ...save, notify });
  if ("error" in started) return apiJson(409, { ok: false, error: started.error });
  deps.record(kind, agent);
  deps.markThinking(agent);
  console.log(`💾 [api] ${kind} 开跑 ${agent.name}（${by}）`);
  void started.run.then(
    (res) => console.log(`💾 [api] ${kind} ${agent.name} ${res.ok ? "完成" : `停在 ${res.stage}：${res.error}`}`),
    (e) => console.error(`💾 [api] ${kind} ${agent.name} 流程出错：${e instanceof Error ? e.message : e}`),
  );
  return apiJson(202, { ok: true, accepted: true, slash: true, agent: agent.name, acp: true, save: kind });
}
