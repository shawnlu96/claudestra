/**
 * app-server 的审批（命令、改文件）→ ACP session/request_permission（宿主接成「待你处理」卡，lib/acp/permissions.ts）。
 * 选项按 CX-0 实测（docs/runtimes/codex-app-server-probe.md Q0-7）：accept / acceptForSession 只在 availableDecisions 里有才给；
 * 「拒绝」发 decline（命令不跑、回合继续，不在列表里也被接受）；cancel 会打断整轮，列表里有才作为第二个拒绝项给。
 * fail closed：宿主回 cancelled、答了不在卡上的 id、请求出错 / 超时 / 宿主断开、session/cancel、回合收尾或适配器收尾时还没答、
 * 出卡时或答复时审批不属于当前回合、带 additionalPermissions（卡上说不清授权范围），一律回 cancel（整轮停下），绝不默认放行，也绝不挂着不答。其余反向请求（加权限、MCP elicitation、requestUserInput）照旧按「不给」答。
 * tests/codex-adapter-approvals.test.ts。
 */
import type { RpcPeer } from "../rpc.js";
import type { AppServer } from "./app-server.js";
import { commandTitle, stripShellPrefix } from "./events.js";
import type { ServerParamsOf } from "./protocol.js";

type Decision = "accept" | "acceptForSession" | "decline" | "cancel";
type Option = { optionId: Decision; name: string; kind: "allow_once" | "allow_always" | "reject_once" };

export interface ApprovalDeps {
  app: Pick<AppServer, "handle">;
  acp: Pick<RpcPeer, "request">;
  /** 审批属于当前会话正在跑的那一轮（不是就当过期，直接 cancel） */
  owns(threadId: string, turnId: string): boolean;
  log(msg: string): void;
  /** 等宿主答复的兜底时限：比宿主自己的 10 分钟（host.ts permissionMs）长，正常由宿主先回 cancelled */
  timeoutMs?: number;
}

const TIMEOUT_MS = 11 * 60_000;
const CANCEL = { decision: "cancel" as const };
const OPTION: Record<Decision, Option> = {
  accept: { optionId: "accept", name: "允许这一次", kind: "allow_once" },
  acceptForSession: { optionId: "acceptForSession", name: "允许，本会话不再问", kind: "allow_always" },
  decline: { optionId: "decline", name: "拒绝（不执行，这一轮继续）", kind: "reject_once" },
  cancel: { optionId: "cancel", name: "拒绝并停下这一轮", kind: "reject_once" },
};

/** 命令审批的选项：只认字符串决定（带策略修订的对象决定不给，宿主卡片答不了），没有可允许的项返回 null */
export function commandOptions(available: unknown[] | null | undefined): Option[] | null {
  const listed = new Set((available ?? []).filter((d): d is string => typeof d === "string"));
  const allow = (["accept", "acceptForSession"] as const).filter((d) => listed.has(d));
  if (!allow.length) return null;
  return [...allow, "decline" as const, ...(listed.has("cancel") ? (["cancel"] as const) : [])].map((d) => OPTION[d]);
}

const FILE_OPTIONS = (["accept", "acceptForSession", "decline", "cancel"] as const).map((d) => OPTION[d]);

type CommandParams = ServerParamsOf<"item/commandExecution/requestApproval">;
type FileParams = ServerParamsOf<"item/fileChange/requestApproval">;

function commandToolCall(p: CommandParams): Record<string, unknown> {
  const net = p.networkApprovalContext;
  const title = net ? `联网：${net.protocol}://${net.host}` : commandTitle(p.command ?? "", p.commandActions ?? []);
  const rawInput = { ...(p.command ? { command: stripShellPrefix(p.command) } : {}), ...(p.cwd ? { cwd: p.cwd } : {}) };
  return { toolCallId: p.itemId, kind: "execute", status: "pending", title, rawInput };
}

function fileToolCall(p: FileParams): Record<string, unknown> {
  const title = p.grantRoot ? `改文件，并允许写 ${p.grantRoot}` : "改文件";
  return { toolCallId: p.itemId, kind: "edit", status: "pending", title, rawInput: { ...(p.reason ? { reason: p.reason } : {}), ...(p.grantRoot ? { grantRoot: p.grantRoot } : {}) } };
}

export class Approvals {
  /** 等宿主答复的审批 → 所属 turnId：cancelAll / cancelTurn 时以 cancel 兑现 */
  private readonly pending = new Map<() => void, string>();

  constructor(private readonly deps: ApprovalDeps) {
    const { app } = deps;
    app.handle("item/commandExecution/requestApproval", (req) => {
      if (!req.ok) return this.refuse(`执行命令的审批参数不合格（${req.problem}）`);
      const options = commandOptions(req.params.availableDecisions);
      if (!options) return this.refuse(`执行命令的审批没有可允许的选项（${JSON.stringify(req.params.availableDecisions ?? null)}）`);
      if (req.params.additionalPermissions != null) return this.refuse("执行命令的审批还申请了额外权限（卡上展示不清范围）");
      return this.ask(req.params, commandToolCall(req.params), options);
    });
    app.handle("item/fileChange/requestApproval", (req) => {
      if (!req.ok) return this.refuse(`改文件的审批参数不合格（${req.problem}）`);
      return this.ask(req.params, fileToolCall(req.params), FILE_OPTIONS);
    });
    app.handle("item/permissions/requestApproval", () => ({ permissions: {}, scope: "turn" as const, strictAutoReview: false as const }));
    app.handle("mcpServer/elicitation/request", () => ({ action: "cancel" as const, content: null, _meta: null }));
    app.handle("item/tool/requestUserInput", () => ({ answers: {} }));
  }

  /** session/cancel、适配器收尾：还在等宿主的审批全部按 cancel 答（app-server 那边的回合才停得下来） */
  cancelAll(): void {
    for (const settle of [...this.pending.keys()]) settle();
  }

  /** 回合收尾：这一轮还没答的审批按 cancel 答，之后宿主迟到的答复不再生效 */
  cancelTurn(turnId: string): void {
    for (const [settle, t] of [...this.pending]) if (t === turnId) settle();
  }

  private refuse(why: string) {
    this.deps.log(`${why}，按拒绝（cancel）答`);
    return CANCEL;
  }

  private ask(p: { threadId: string; turnId: string }, toolCall: Record<string, unknown>, options: Option[]): Promise<{ decision: Decision }> {
    if (!this.deps.owns(p.threadId, p.turnId)) return Promise.resolve(this.refuse(`审批不属于当前在跑的回合（${p.turnId}）`));
    return new Promise((resolve) => {
      let done = false;
      const settle = (d: { decision: Decision }, why?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(cancel);
        if (why) this.deps.log(`审批 ${String(toolCall.toolCallId)} 没拿到答复（${why}），按拒绝（cancel）答`);
        resolve(d);
      };
      const cancel = () => settle(CANCEL, "回合已收尾、被叫停或适配器在收尾");
      const timer = setTimeout(() => settle(CANCEL, "等宿主答复超时"), this.deps.timeoutMs ?? TIMEOUT_MS);
      this.pending.set(cancel, p.turnId);
      this.deps.acp.request("session/request_permission", { sessionId: p.threadId, toolCall, options }).then(
        (r: any) => {
          const id = r?.outcome?.outcome === "selected" ? r.outcome.optionId : undefined;
          const hit = options.find((o) => o.optionId === id);
          if (hit && !this.deps.owns(p.threadId, p.turnId)) return settle(CANCEL, `宿主答复时回合 ${p.turnId} 已经不是当前在跑的那一轮`);
          settle(hit ? { decision: hit.optionId } : CANCEL, hit ? undefined : `宿主回 ${JSON.stringify(r?.outcome ?? r)}`);
        },
        (e: unknown) => settle(CANCEL, e instanceof Error ? e.message : String(e)),
      );
    });
  }
}
