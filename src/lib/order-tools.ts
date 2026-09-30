/**
 * channel-server 这一侧的派单工具（M2 执行者 take_order / deliver / ask，M3 审查员在 ORDER_TOOLS 里加项）。
 * 全部走同一种帧 `order_tool {tool, args}`：ACP 回环代理（lib/acp/tool-proxy.ts）与 bridge.ts 各只认这一个类型，加工具不用再碰它们。
 * 这里不校验、不补字段：参数原样交给 bridge，由 bridge 先认身份（requireVerified）再按 T87 的 wire 校验（bridge/order-tools.ts）。
 * tests/order-tools.test.ts。
 */
type BridgeRequest = (msg: any, timeoutMs?: number) => Promise<any>;

/** bridge 要查一次远端分支 head（git ls-remote）再跑 manager 写台账，比普通工具慢 */
const ORDER_TOOL_TIMEOUT_MS = 60_000;

const WIRE_V = { type: "number", enum: [1], description: "wire 版本，固定 1" };
const ORDER_ID = { type: "string", description: "take_order 返回的 orderId" };

export const ORDER_TOOLS = [
  {
    name: "take_order",
    description:
      "Executor: fetch your current work order (OrderWire) from the ledger — the card whose current build/fix step is assigned to you. " +
      "Returns {ok, order} with order=null when you have none. Only sessions launched by Claudestra (whoami verified=true) may call it.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "deliver",
    description:
      "Executor: deliver your current order (same effect as `ledger deliver --from build|fix --head`). head must be the full SHA the card's branch " +
      "has on origin right now — push first; the bridge checks it. Retrying with the same orderId + head returns the same result.",
    inputSchema: {
      type: "object" as const,
      properties: {
        v: WIRE_V,
        orderId: ORDER_ID,
        head: { type: "string", description: "完整 40 位 commit SHA，等于 origin 上本卡分支的当前 head" },
        evidence: { type: "string", description: "证据报告的文件路径（只收路径）" },
        summary: { type: "string", description: "一句话交付说明（≤500 字节）" },
        selfCheck: { type: "string", description: "按验收线逐条自查的结果（≤4000 字节）" },
      },
      required: ["v", "orderId", "head", "evidence", "summary", "selfCheck"],
    },
  },
  {
    name: "ask",
    description:
      "Executor: ask this card's PM a question about your current order. It is recorded in the ledger (asks) and delivered to the PM; " +
      "the answer arrives as a normal agent message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        v: WIRE_V,
        orderId: ORDER_ID,
        question: { type: "string", description: "问题正文（≤2000 字节）" },
        options: { type: "array", items: { type: "string" }, description: "可选：候选答案（≤10 项，每项 ≤200 字节）" },
      },
      required: ["v", "orderId", "question"],
    },
  },
];

const NAMES = new Set(ORDER_TOOLS.map((t) => t.name));
export const isOrderTool = (name: string): boolean => NAMES.has(name);

/** bridge 回 {ok:false, code, error} = 拒绝（没写任何东西），标成 isError 让模型看得见 code */
export async function orderTool(bridgeRequest: BridgeRequest, name: string, args: unknown) {
  try {
    const r = await bridgeRequest({ type: "order_tool", tool: name, args: args ?? {} }, ORDER_TOOL_TIMEOUT_MS);
    return { content: [{ type: "text" as const, text: JSON.stringify(r ?? {}, null, 2) }], ...(r?.ok === false ? { isError: true } : {}) };
  } catch (e) {
    return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
  }
}
