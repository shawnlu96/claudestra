/**
 * codex app-server 协议里我们真正读写的那一小块，以及 USED 登记表（方法 ↔ schema 定义名、方向、作用域、封闭枚举）。
 * - 入站（通知、请求的回包、反向请求的参数）用宽松对象，只列我们读的字段：多出来的字段不影响我们。
 * - 出站（请求参数、反向请求的回包）用严格对象，只发我们明确设置的字段。
 * 定义名与形状对照 `codex app-server generate-json-schema --experimental` 的产物（锁文件在 tests/fixtures/codex-app-server/）。
 * 改了这里要重跑 `bun scripts/codex-schema/lock.ts`，否则 tests/codex-adapter-schema.test.ts 判锁文件过期。
 */
import { z } from "zod";

const str = z.string();
const int = z.number().int();
/** 可以缺、也可以是 null（schema 里 anyOf [X, null] 且不在 required 里的字段） */
const opt = <T extends z.ZodType>(s: T) => s.nullable().optional();
const loose = z.looseObject;
const strict = z.strictObject;
const turnScoped = { threadId: str, turnId: str };

// ---- 入站 ----

const TurnStatus = z.enum(["completed", "interrupted", "failed", "inProgress"]);
const TurnError = loose({ message: str, codexErrorInfo: z.unknown().optional(), additionalDetails: opt(str) });
const Turn = loose({ id: str, status: TurnStatus, error: opt(TurnError) });
const ThreadStatus = z.discriminatedUnion("type", [
  loose({ type: z.literal("notLoaded") }),
  loose({ type: z.literal("idle") }),
  loose({ type: z.literal("systemError") }),
  loose({ type: z.literal("active") }),
]);
const ThreadOpened = loose({ thread: loose({ id: str }), model: str, modelProvider: str, reasoningEffort: opt(str) });
const Model = loose({
  id: str,
  model: str,
  displayName: str,
  hidden: z.boolean(),
  isDefault: z.boolean(),
  defaultReasoningEffort: str,
  supportedReasoningEfforts: z.array(loose({ reasoningEffort: str })),
});

/**
 * ThreadItem 是开放联合：通知里先按信封（type、id）读，再按 type 查这里的成员 schema；不认识的 type 归 O 类忽略。
 * 只列已经确定要读的成员，其余工具类成员由事件转换那一步补进来并重新生成锁文件。
 */
const ThreadItem = z.discriminatedUnion("type", [
  /** clientId 是投递对账的键（turn/start、turn/steer 的 clientUserMessageId 原样落在这里，delivery.ts） */
  loose({ type: z.literal("userMessage"), id: str, clientId: opt(str) }),
  loose({ type: z.literal("agentMessage"), id: str, text: str }),
  loose({
    type: z.literal("commandExecution"),
    id: str,
    command: str,
    cwd: str,
    status: z.enum(["inProgress", "completed", "failed", "declined"]),
    exitCode: opt(int),
    aggregatedOutput: opt(str),
    commandActions: z.array(loose({ type: str })),
  }),
  loose({
    type: z.literal("mcpToolCall"),
    id: str,
    server: str,
    tool: str,
    arguments: z.unknown(),
    status: z.enum(["inProgress", "completed", "failed"]),
    result: opt(loose({})),
    error: opt(loose({ message: str })),
  }),
  loose({ type: z.literal("contextCompaction"), id: str }),
]);
const ItemEnvelope = loose({ ...turnScoped, item: loose({ type: str, id: str }) });
const Delta = loose({ ...turnScoped, itemId: str, delta: str });
/** thread/items/list 的一项：item 先按信封读，成员再按 ThreadItem 校验（同 item/* 通知） */
const ItemEntry = loose({ turnId: str, item: loose({ type: str, id: str }), startedAtMs: opt(int) });

// ---- 出站 ----

/** 写成只有一个成员的判别联合：投影按 UserInput 的 text 分支对照，而不是把所有输入类型的字段揉在一起 */
const UserText = z.discriminatedUnion("type", [strict({ type: z.literal("text"), text: str, text_elements: z.tuple([]) })]);
const SandboxPolicy = z.discriminatedUnion("type", [
  strict({ type: z.literal("dangerFullAccess") }),
  strict({ type: z.literal("readOnly"), networkAccess: z.boolean() }),
  strict({
    type: z.literal("workspaceWrite"),
    writableRoots: z.array(str),
    networkAccess: z.boolean(),
    excludeTmpdirEnvVar: z.boolean(),
    excludeSlashTmp: z.boolean(),
  }),
]);
const Config = z.record(z.string(), z.unknown());
const OpenThread = { threadId: str, cwd: str, config: Config, excludeTurns: z.literal(true), modelProvider: str };
const Decision = z.enum(["accept", "acceptForSession", "decline", "cancel"]);

// ---- 登记表 ----

type Scope = "thread" | "turn" | "request";
/** L = 生命周期类（校验失败要让回合失败或作废连接），C = 内容类（校验失败把回合标成 degraded） */
type Cls = "L" | "C";
const side = <S extends z.ZodType>(def: string, schema: S) => ({ def, schema });
const call = <P extends z.ZodType, R extends z.ZodType>(p: [string, P], r: [string, R], scope: Scope, timeoutMs: number) => ({
  params: side(...p),
  result: side(...r),
  scope,
  timeoutMs,
});
const note = <P extends z.ZodType>(def: string, schema: P, scope: Scope, cls: Cls) => ({ params: side(def, schema), scope, cls });
const ask = <P extends z.ZodType, R extends z.ZodType>(p: [string, P], r: [string, R], scope: Scope) => ({ params: side(...p), result: side(...r), scope });

/** 我们发给 app-server 的请求。timeoutMs 是缺省时限（I13），调用方可以按回合另给 */
const client = {
  initialize: call(
    [
      "InitializeParams",
      strict({ clientInfo: strict({ name: str, title: str.optional(), version: str }), capabilities: strict({ experimentalApi: z.boolean(), requestAttestation: z.boolean() }) }),
    ],
    ["InitializeResponse", loose({})],
    "request",
    30_000,
  ),
  "account/read": call(
    ["v2/GetAccountParams", strict({ refreshToken: z.boolean() })],
    ["v2/GetAccountResponse", loose({ account: opt(loose({})), requiresOpenaiAuth: z.boolean() })],
    "request",
    20_000,
  ),
  "config/read": call(
    ["v2/ConfigReadParams", strict({ includeLayers: z.literal(false) })],
    ["v2/ConfigReadResponse", loose({ config: loose({ model_provider: opt(str) }) })],
    "request",
    20_000,
  ),
  "model/list": call(
    ["v2/ModelListParams", strict({ cursor: str.nullable(), limit: z.null() })],
    ["v2/ModelListResponse", loose({ data: z.array(Model), nextCursor: opt(str) })],
    "request",
    20_000,
  ),
  "thread/start": call(["v2/ThreadStartParams", strict({ config: Config, modelProvider: z.null(), cwd: str })], ["v2/ThreadStartResponse", ThreadOpened], "thread", 100_000),
  "thread/resume": call(["v2/ThreadResumeParams", strict(OpenThread)], ["v2/ThreadResumeResponse", ThreadOpened], "thread", 100_000),
  "thread/fork": call(["v2/ThreadForkParams", strict(OpenThread)], ["v2/ThreadForkResponse", ThreadOpened], "thread", 100_000),
  "thread/unsubscribe": call(["v2/ThreadUnsubscribeParams", strict({ threadId: str })], ["v2/ThreadUnsubscribeResponse", loose({})], "thread", 20_000),
  "thread/read": call(
    ["v2/ThreadReadParams", strict({ threadId: str, includeTurns: z.literal(false) })],
    ["v2/ThreadReadResponse", loose({ thread: loose({ id: str, status: ThreadStatus }) })],
    "thread",
    20_000,
  ),
  "thread/items/list": call(
    ["v2/ThreadItemsListParams", strict({ threadId: str, sortDirection: z.literal("desc"), limit: int.min(1).max(1000), cursor: str.nullable() })],
    ["v2/ThreadItemsListResponse", loose({ data: z.array(ItemEntry), nextCursor: opt(str) })],
    "thread",
    10_000,
  ),
  "thread/compact/start": call(["v2/ThreadCompactStartParams", strict({ threadId: str })], ["v2/ThreadCompactStartResponse", loose({})], "thread", 30_000),
  "turn/start": call(
    [
      "v2/TurnStartParams",
      strict({
        threadId: str,
        input: z.array(UserText),
        clientUserMessageId: str,
        approvalPolicy: z.enum(["on-request", "never"]),
        approvalsReviewer: z.enum(["user", "auto_review"]),
        sandboxPolicy: SandboxPolicy,
        summary: z.enum(["auto", "none"]),
        effort: str.min(1).nullable(),
        model: str,
      }),
    ],
    ["v2/TurnStartResponse", loose({ turn: Turn })],
    "turn",
    30_000,
  ),
  "turn/steer": call(
    ["v2/TurnSteerParams", strict({ threadId: str, input: z.array(UserText), expectedTurnId: str, clientUserMessageId: str })],
    ["v2/TurnSteerResponse", loose({ turnId: str })],
    "turn",
    120_000,
  ),
  "turn/interrupt": call(["v2/TurnInterruptParams", strict(turnScoped)], ["v2/TurnInterruptResponse", loose({})], "turn", 20_000),
};

/** app-server 发给我们的请求（反向请求）；没登记的一律回 -32601 */
const server = {
  "item/commandExecution/requestApproval": ask(
    ["CommandExecutionRequestApprovalParams", loose({ ...turnScoped, itemId: str, availableDecisions: opt(z.array(z.unknown())), command: opt(str), cwd: opt(str), reason: opt(str) })],
    ["CommandExecutionRequestApprovalResponse", strict({ decision: Decision })],
    "turn",
  ),
  "item/fileChange/requestApproval": ask(
    ["FileChangeRequestApprovalParams", loose({ ...turnScoped, itemId: str, reason: opt(str), grantRoot: opt(str) })],
    ["FileChangeRequestApprovalResponse", strict({ decision: Decision })],
    "turn",
  ),
  "item/permissions/requestApproval": ask(
    ["PermissionsRequestApprovalParams", loose({ ...turnScoped, itemId: str })],
    ["PermissionsRequestApprovalResponse", strict({ permissions: strict({}), scope: z.literal("turn"), strictAutoReview: z.literal(false) })],
    "turn",
  ),
  "mcpServer/elicitation/request": ask(
    ["McpServerElicitationRequestParams", loose({ threadId: str, turnId: opt(str), serverName: str })],
    ["McpServerElicitationRequestResponse", strict({ action: z.literal("cancel"), content: z.null(), _meta: z.null() })],
    "thread",
  ),
  "item/tool/requestUserInput": ask(["ToolRequestUserInputParams", loose({ ...turnScoped, itemId: str })], ["ToolRequestUserInputResponse", strict({ answers: strict({}) })], "turn"),
};

const notifications = {
  "turn/started": note("v2/TurnStartedNotification", loose({ threadId: str, turn: Turn }), "turn", "L"),
  "turn/completed": note("v2/TurnCompletedNotification", loose({ threadId: str, turn: Turn }), "turn", "L"),
  error: note("v2/ErrorNotification", loose({ ...turnScoped, error: TurnError, willRetry: z.boolean() }), "turn", "L"),
  "thread/status/changed": note("v2/ThreadStatusChangedNotification", loose({ threadId: str, status: ThreadStatus }), "thread", "L"),
  "thread/compacted": note("v2/ContextCompactedNotification", loose(turnScoped), "turn", "L"),
  "item/started": note("v2/ItemStartedNotification", ItemEnvelope, "turn", "C"),
  "item/completed": note("v2/ItemCompletedNotification", ItemEnvelope, "turn", "C"),
  "item/agentMessage/delta": note("v2/AgentMessageDeltaNotification", Delta, "turn", "C"),
  "item/commandExecution/outputDelta": note("v2/CommandExecutionOutputDeltaNotification", Delta, "turn", "C"),
  "turn/plan/updated": note("v2/TurnPlanUpdatedNotification", loose({ ...turnScoped, plan: z.array(loose({ step: str, status: z.enum(["pending", "inProgress", "completed"]) })) }), "turn", "C"),
  "thread/tokenUsage/updated": note(
    "v2/ThreadTokenUsageUpdatedNotification",
    loose({ ...turnScoped, tokenUsage: loose({ last: loose({ totalTokens: int }), modelContextWindow: opt(int) }) }),
    "turn",
    "C",
  ),
};

export const USED = {
  client,
  server,
  notifications,
  /** 不挂在某个方法上、但要锁定投影的入站定义 */
  extraInbound: { "v2/ThreadItem": ThreadItem },
  /** 封闭枚举 / 联合：多一个或少一个值都要先改适配器（漂移门判红）；schema 里其余的枚举按开放处理 */
  closed: ["v2/TurnStatus", "v2/ThreadStatus", "v2/CommandExecutionStatus", "v2/McpToolCallStatus", "v2/TurnPlanStepStatus"],
  /** 我们发的通知（不带参数） */
  clientNotifications: ["initialized"],
  /** 这些 item 类型的 item/* 事件属于生命周期类（I10） */
  lifecycleItems: ["contextCompaction"],
};

export type ClientMethod = keyof typeof client;
export type ParamsOf<M extends ClientMethod> = z.input<(typeof client)[M]["params"]["schema"]>;
export type ResultOf<M extends ClientMethod> = z.infer<(typeof client)[M]["result"]["schema"]>;
export type ServerMethod = keyof typeof server;
export type ServerParamsOf<M extends ServerMethod> = z.infer<(typeof server)[M]["params"]["schema"]>;
export type ServerResultOf<M extends ServerMethod> = z.input<(typeof server)[M]["result"]["schema"]>;
export type NotificationMethod = keyof typeof notifications;
