/**
 * channel-server 的压缩相关 MCP 工具（codex-compact N3，docs/runtimes/codex-save-compact-plan.md §2.1 第 3 步）。
 * 写法同 lib/fleet-tool.ts：这里只声明工具、把参数原样交 bridge（ws `save_handoff`），不带任何身份 / 名字 / 路径字段；
 * 存到哪、能不能存，全由 bridge 按连接认出的 agent 判（bridge/handoff-route.ts → lib/agent-handoff.ts）。
 * 存成功只代表交接落盘，不代表压缩完成。tests/compact-tools.test.ts、tests/compact-tool-proxy.test.ts。
 */
import { HANDOFF_MAX_BYTES } from "./agent-handoff.js";

type BridgeRequest = (msg: any, timeoutMs?: number) => Promise<any>;

const SAVE_TIMEOUT_MS = 30_000;

export const SAVE_HANDOFF_TOOL = {
  name: "save_handoff",
  description: `把当前工作的交接（进度、未完事项、关键路径、下一步）存下来，供上下文压缩后的自己接着做。
存到哪由 bridge 按你这条连接认出的 agent 决定，你不能也不需要给路径或名字；同一 agent 的新交接原子替换旧的。
opId 填触发这次保存的指令里给的 op id；text 是 Markdown 正文，非空，不超过 ${HANDOFF_MAX_BYTES} 字节。
存成功只表示交接已落盘，不表示压缩已完成。`,
  inputSchema: {
    type: "object" as const,
    properties: {
      opId: { type: "string", description: "触发这次保存的 op id（指令里给的）" },
      text: { type: "string", description: `交接正文（Markdown），非空，≤ ${HANDOFF_MAX_BYTES} 字节` },
    },
    required: ["opId", "text"],
    additionalProperties: false,
  },
};

/** channel-server 的 case "save_handoff"：只转 opId / text；bridge 报错原样当工具错误返回 */
export async function saveHandoffTool(bridgeRequest: BridgeRequest, args: Record<string, unknown> = {}) {
  try {
    const r = await bridgeRequest({ type: "save_handoff", opId: args.opId, text: args.text }, SAVE_TIMEOUT_MS);
    return { content: [{ type: "text" as const, text: `交接已保存：${r?.path ?? "?"}（op ${r?.opId ?? "?"}，${r?.bytes ?? "?"} 字节，${r?.savedAt ?? ""}）。这只是保存，压缩另行进行。` }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `交接没保存：${(e as Error).message}` }], isError: true };
  }
}
