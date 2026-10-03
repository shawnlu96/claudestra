import { FEATURE_DEPS_TOOL } from "./ledger-feature-deps-tool.js";
/**
 * 子 DAG 与开卡的 MCP 工具定义（i28-L5，docs/architecture/dag-tools.md）：plan_feature / rewrite_dag / start_node / show_dag。
 * 和派单工具走同一条管道（lib/order-tools.ts 的 order_tool 帧 → bridge 认身份 → bridge/dag-tools.ts），这里只放 schema 与说明：
 * 说明写给模型看，要让 PM 不记 CLI 也知道「拆活 → 看车道 → 开工」这条路。channel-server 不做校验，参数原样交给 bridge。
 */

const NODE = {
  type: "object",
  properties: {
    key: { type: "string", description: "节点 key（字母数字开头，≤40 位）；开工后卡号 = <feature 短名>-<key>" },
    oneLine: { type: "string", description: "一句话说这个节点做什么（≤60 字）" },
    deps: { type: "array", items: { type: "string" }, description: "依赖的节点 key" },
    estimate: { type: "string", description: "粗估（「半天」「S」这类短文本）" },
    fileGlobs: {
      type: "array", items: { type: "string" }, minItems: 1,
      description: "必填、非空：这个节点会改的文件范围（相对仓库根，可带 *，如 src/lib/foo*.ts）。并行车道与调度器的文件锁都按它判重叠",
    },
  },
  required: ["key", "oneLine", "fileGlobs"],
};

const FEATURE_ID = { type: "string", description: "feature id（写全带本机前缀，或只写短名，如 i28）" };
const REASON_KIND = { type: "string", enum: ["new_issue", "requirement_change", "p1_fallback"], description: "为什么改：发现新问题 / 需求变了 / P1 退路" };
const REASON = { type: "string", description: "原因原文（owner 原话或审查结论），必填" };

export const DAG_TOOLS = [
  FEATURE_DEPS_TOOL,
  {
    name: "plan_feature",
    description:
      "PM / master: plan a feature as a sub-DAG of nodes in one call. New feature (slug) → creates it and its v1 DAG; existing feature without a DAG → v1; " +
      "existing DAG → rewrites it to exactly this node list (reasonKind + reason required; bound cards are kept by key). Every node MUST carry non-empty fileGlobs. " +
      "Returns the DAG plus parallel lanes: which nodes can start right now together (deps met, files not overlapping each other or running cards) and who waits on whom. " +
      "Then call start_node for each node in lanes.startNow.",
    inputSchema: {
      type: "object" as const,
      properties: {
        featureId: { ...FEATURE_ID, description: "已有 feature 的 id；和 slug 二选一" },
        slug: { type: "string", description: "新建 feature 的短名（如 i28，卡号前缀）；和 featureId 二选一" },
        title: { type: "string", description: "feature 名字（新建时必填，项目内唯一）" },
        ownerWords: { type: "string", description: "owner 原话（新建时记下）" },
        project: { type: "string", description: "项目 id（新建时用；缺省为你所在的项目）" },
        nodes: { type: "array", items: NODE, description: "整版节点" },
        reasonKind: REASON_KIND,
        reason: REASON,
      },
      required: ["nodes"],
    },
  },
  {
    name: "rewrite_dag",
    description:
      "PM / master: change an existing sub-DAG — add / update / remove planned nodes, split one (remove + add + update dependents), or cancel an in-progress node. " +
      "reasonKind + reason are required; cancelling an in-progress node needs its own reason in cancel. Everything applies at once without notifying the owner, " +
      "except scopeChange (changes the feature's scope or overhauls a mechanism — your call), which waits for owner approval. " +
      "Completed nodes cannot change. New or updated nodes must carry fileGlobs. Returns the result (applied now, or pending owner approval) plus lanes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        featureId: FEATURE_ID,
        reasonKind: REASON_KIND,
        reason: REASON,
        add: { type: "array", items: NODE, description: "新加的节点" },
        update: { type: "array", items: NODE, description: "按 key 整个替换的节点（绑的卡保留）" },
        remove: { type: "array", items: { type: "string" }, description: "移出的没开始 / 计划中节点 key" },
        cancel: { type: "object", additionalProperties: { type: "string" }, description: "{节点 key: 取消原因}：移出进行中的节点" },
        scopeChange: { type: "boolean", description: "改 feature 范围或大改机制（PM 判断，要 owner 批）；不带则直接生效、不通知 owner" },
      },
      required: ["featureId", "reasonKind", "reason"],
    },
  },
  {
    name: "start_node",
    description:
      "PM / master: start one planned node as an auto card in one step — creates the ledger card (<feature slug>-<key>), a git worktree (base default origin/main, " +
      "node_modules symlinked), the executor brief, the executor agent, records its fileGlobs, turns the scheduler workflow to auto, and binds the node. " +
      "The scheduler then dispatches the restate order itself; do not message the executor. Needs the spec card at ledger/docs/tasks/<card>.md or pass spec. " +
      "Any failure rolls back what was done and reports failedStep. Slow (starts an agent): up to a few minutes. " +
      "placement (default auto) picks this machine or a borrowed peer by the slot pool rules; peer:<name> pins it there (no local worktree / agent, " +
      "restate skipped) and is refused when that peer cannot take writing now. " +
      "template picks the workflow template (default code, always its latest version); ui adds the before/after screenshot gate " +
      "(PM accepts; `ledger ui-owner-visual <card> on` hands an overall-look card to the owner), security keeps local-only cross-model review.",
    inputSchema: {
      type: "object" as const,
      properties: {
        featureId: FEATURE_ID,
        key: { type: "string", description: "要开工的节点 key" },
        base: { type: "string", description: "worktree 的起点，缺省 origin/main" },
        branch: { type: "string", description: "分支名，缺省 feat/<卡号小写>" },
        taskId: { type: "string", description: "卡号，缺省 <feature 短名>-<key>" },
        title: { type: "string", description: "卡标题，缺省节点的 oneLine" },
        item: { type: "string", description: "挂到哪个事项，缺省与 feature 短名同名的事项（有的话）" },
        spec: { type: "string", description: "规格卡正文：规格卡还没写时给，会写进 ledger/docs/tasks/<卡号>.md" },
        repo: { type: "string", description: "项目目录之一（缺省项目第一个 git 目录）" },
        placement: { type: "string", description: "放哪：auto（缺省，按槽池规则；算出本机就和不带一样）| local | peer:<名>（固定给这个 peer，过不了硬约束就拒）" },
        template: { type: "string", enum: ["code", "ui", "security"], description: "流程模板，缺省 code；总是该模板的最高版（v3）" },
      },
      required: ["featureId", "key"],
    },
  },
  {
    name: "show_dag",
    description:
      "Read a feature's sub-DAG: the current (or given) version with each node's card, stage, executor agent and fileGlobs, the pending rewrite if any, and lanes. " +
      "diff: [a, b] compares two versions (numbers or \"pending\") instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        featureId: FEATURE_ID,
        version: { type: "number", description: "看哪一版，缺省当前版" },
        diff: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2, description: "[a, b]：两版差异（版本号或 pending，写成字符串），b 缺省当前版" },
      },
      required: ["featureId"],
    },
  },
];

/** start_node 要起一个 agent（manager create 等 Claude Code 就绪），比派单工具慢得多 */
export const DAG_TOOL_TIMEOUT_MS: Readonly<Record<string, number>> = { start_node: 300_000, plan_feature: 90_000, rewrite_dag: 90_000 };
