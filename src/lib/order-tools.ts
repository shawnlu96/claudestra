/**
 * channel-server 这一侧的派单工具（M2 执行者 take_order / deliver / ask，M3 审查员在 ORDER_TOOLS 里加项）。
 * 全部走同一种帧 `order_tool {tool, args}`：ACP 回环代理（lib/acp/tool-proxy.ts）与 bridge.ts 各只认这一个类型，加工具不用再碰它们。
 * 这里不校验、不补字段：参数原样交给 bridge，由 bridge 先认身份（requireVerified）再按 T87 的 wire 校验（bridge/order-tools.ts）。
 * tests/order-tools.test.ts。
 */
import { DAG_TOOL_TIMEOUT_MS, DAG_TOOLS } from "./dag-tools.js";
import { FINDING_PITFALL_SCHEMA, MEMORY_REFS_SCHEMA, MEMORY_TOOLS } from "./memory-tools-defs.js";

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
      "Returns {ok, order} with order=null when you have none; when the card's code is written by a lending peer, order=null and `note` says so " +
      "(you only restate and answer PM: no code, no push, no deliver). Only sessions launched by Claudestra (whoami verified=true) may call it.",
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
        disputes: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false,
          properties: { findingId: { type: "string" }, reason: { type: "string", maxLength: 1000 } }, required: ["findingId", "reason"] } },
        selfCheck: { type: "string", description: "按验收线逐条自查的结果（≤4000 字节）" },
        memoryRefs: MEMORY_REFS_SCHEMA,
      },
      required: ["v", "orderId", "head", "evidence", "summary", "selfCheck"],
    },
  },
  {
    name: "ask",
    description:
      "Executor: ask this card's PM a question about your current order. It is recorded in the ledger (asks) and delivered to the PM; " +
      "design/scope: include default and continue immediately; only blocker (credentials, owner decision, security) waits for a PM reply.",
    inputSchema: {
      type: "object" as const,
      properties: {
        v: WIRE_V,
        orderId: ORDER_ID,
        question: { type: "string", description: "问题正文（≤2000 字节）" },
        default: { type: "string", description: "我打算怎么做（design / scope 必填，≤600 字）" },
        class: { type: "string", enum: ["design", "scope", "blocker"], description: "做法选择 / 范围 / 需要人；远端出借单仍按 blocker" },
        options: { type: "array", items: { type: "string" }, description: "可选：候选答案（≤10 项，每项 ≤200 字节）" },
        files: { type: "array", items: { type: "string" }, description: "测试类扩围：要加进本卡范围的文件（仓库相对路径，≤20 项）；全在 tests/ 下且带 reason 的，PM 15 分钟没回自动批准并追加进 fileGlobs" },
        reason: { type: "string", enum: ["superseded_assertion", "new_test"], description: "和 files 一起给：superseded_assertion = 被本规格替代的旧断言；new_test = 为本卡新行为补测试" },
      },
      required: ["v", "orderId", "question"],
    },
  },
  {
    name: "take_review",
    description:
      "Reviewer: fetch the review orders (OrderWire) currently assigned to you — cards in review whose current review / final_review step is yours " +
      "(auto cards: your bound reviewer session). Returns {ok, orders, errors}; orders is empty when you have none. Verified sessions only.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "submit_verdict",
    description:
      "Reviewer: record your verdict for one review order in the ledger. It never moves the stage. head must be the order's head; p0/p1/p2 must equal " +
      "the findings per severity; reportPath is the absolute path of your non-empty report under ledger/reviews/. " +
      "Your session and model family come from your verified identity. Retrying the same verdict is safe; a different second verdict is refused.",
    inputSchema: {
      type: "object" as const,
      properties: {
        v: WIRE_V,
        orderId: { type: "string", description: "take_review 返回的 orderId" },
        head: { type: "string", description: "审查单上的完整 head SHA" },
        verdict: { type: "string", enum: ["pass", "changes", "block"] },
        p0: { type: "number" },
        p1: { type: "number" },
        p2: { type: "number" },
        findings: {
          type: "array",
          description: "逐项结论（≤100 条）；同类问题沿用上一轮的 findingId",
          items: {
            type: "object",
            properties: {
              findingId: { type: "string" }, family: { type: "string" }, severity: { type: "string", enum: ["P0", "P1", "P2"] },
              probe: { type: "string", description: "复现 / 探针（≤4000 字节）" }, description: { type: "string", description: "说明（≤4000 字节）" }, pitfall: FINDING_PITFALL_SCHEMA,
            },
            required: ["findingId", "family", "severity", "probe", "description"],
          },
        },
        reportPath: { type: "string", description: "报告的绝对路径，放在 ledger/reviews/ 下，非空" },
      },
      required: ["v", "orderId", "head", "verdict", "p0", "p1", "p2", "findings", "reportPath"],
    },
  },
  ...DAG_TOOLS,
  ...MEMORY_TOOLS,
];

const NAMES = new Set(ORDER_TOOLS.map((t) => t.name));
export const isOrderTool = (name: string): boolean => NAMES.has(name);

/** bridge 回 {ok:false, code, error} = 拒绝（没写任何东西），标成 isError 让模型看得见 code */
export async function orderTool(bridgeRequest: BridgeRequest, name: string, args: unknown) {
  try {
    const r = await bridgeRequest({ type: "order_tool", tool: name, args: args ?? {} }, DAG_TOOL_TIMEOUT_MS[name] ?? ORDER_TOOL_TIMEOUT_MS);
    return { content: [{ type: "text" as const, text: JSON.stringify(r ?? {}, null, 2) }], ...(r?.ok === false ? { isError: true } : {}) };
  } catch (e) {
    return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
  }
}
