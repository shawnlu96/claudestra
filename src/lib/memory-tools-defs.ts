/**
 * 项目记忆三个 MCP 工具的定义与 deliver / submit_verdict 新增字段的 schema（lib/order-tools.ts 展开进 ORDER_TOOLS）。
 * 单独成文件、不依赖台账：channel-server 引 order-tools 时不会把 sqlite 一侧的逻辑（memory-tools.ts）带进去。
 */
import { MEMORY_REF_USES } from "./memory-tools-wire.js";

export const WIRE_V = 1;
/** 工具能打的 mark（fixed / reopen 只给调度器） */
export const TOOL_MARKS = ["confirm", "dispute", "retract", "supersede", "link_fix", "unlink_fix"] as const;

/** deliver 的 memoryRefs 一项 */
export const MEMORY_REFS_SCHEMA = {
  type: "array", maxItems: 20, description: "可选：单子「项目记忆」一节里各条怎么用（wrong 必须带 note，会自动转为争议给 PM）",
  items: { type: "object", additionalProperties: false, required: ["id", "use"],
    properties: { id: { type: "string" }, use: { type: "string", enum: [...MEMORY_REF_USES] }, note: { type: "string", maxLength: 300 } } },
};

/** submit_verdict 逐项结论的 pitfall */
export const FINDING_PITFALL_SCHEMA = {
  type: "boolean", description: "可选，只给 P1：这不只是本卡的错、是会再犯的坑（调度器据此记一条坑）。出借给别人的审查单不要带（对方旧版不认）",
};

const V = { type: "number", enum: [WIRE_V], description: "wire 版本，固定 1" };
export const MEMORY_TOOLS = [
  {
    name: "record_memory",
    description: "Record a project-memory pitfall (or a summary supplement) in the ledger. Executor / reviewer: pass your current orderId (the memory anchors to that card; " +
      "executor entries start as candidate until the PM confirms). PM / owner: orderId or project. Your identity comes from your verified session. " +
      "memoryLint refuses progress notes, code-readable facts, spec restatements / typo / naming nits, local-environment quirks, unsourced guesses, secrets / paths / " +
      "personal or business content, duplicates (use mark_memory confirm instead) and over-long text (never truncated).",
    inputSchema: {
      type: "object" as const,
      properties: {
        v: V,
        kind: { type: "string", enum: ["pitfall", "summary"] },
        title: { type: "string", description: "一句话（≤80 字节）" },
        symptom: { type: "string", description: "坑：症状（≤300 字节）" },
        rule: { type: "string", description: "坑：怎么避免（≤300 字节）" },
        body: { type: "string", description: "总结补充正文（≤600 字节，要带 orderId）" },
        files: { type: "array", maxItems: 20, items: { type: "string" }, description: "仓库相对路径或 glob" },
        family: { type: "string", description: "坑的归一化 family（[\\w.-]{1,64}），沿用审查 finding 的 family" },
        fixable: { type: "boolean", description: "坑：true = 代码缺陷、能被某张卡修掉；false = 规矩 / 环境特性" },
        orderId: { type: "string", description: "你当前的单（take_order / take_review 的 orderId）" },
        project: { type: "string", description: "不带 orderId 时的项目（只有 PM / owner）" },
      },
      required: ["v", "kind", "title"],
    },
  },
  {
    name: "mark_memory",
    description: "Mark a project memory: confirm (PM / owner; reviewer for pitfalls) / dispute (anyone with a role; reason required) / retract (PM / owner, or its author " +
      "within 24h; reason required) / supersede (PM / owner, by = new memory id) / link_fix · unlink_fix (PM / owner, taskId = the fixing card). " +
      "fixed / reopen are scheduler-only. Executor / reviewer: pass your current orderId so your role can be recognised.",
    inputSchema: {
      type: "object" as const,
      properties: {
        v: V,
        memoryId: { type: "string" },
        mark: { type: "string", enum: [...TOOL_MARKS] },
        reason: { type: "string", description: "≤300 字节；dispute / retract 必填" },
        by: { type: "string", description: "supersede 指向的新记忆 id" },
        taskId: { type: "string", description: "link_fix / unlink_fix：修它的卡" },
        orderId: { type: "string", description: "执行者 / 审查员：你当前的单" },
      },
      required: ["v", "memoryId", "mark"],
    },
  },
  {
    name: "show_memory",
    description: "Read one project memory in full (title, body, files, sources, current status and the history of marks). Orders only carry a short summary.",
    inputSchema: { type: "object" as const, properties: { v: V, id: { type: "string", description: "记忆 id，如 ab12-m6" } }, required: ["v", "id"] },
  },
];

