/** Messages ingress; route-owned state and runtime operations are injected to keep dependency direction downward. */
import { followPmDelivery, pmClientFor } from "./local-api/project-pm-delivery.js";
import { peerPmLevel, settleDigestedPeerInfo } from "./api-message-policy.js";
import { peerFileOwner, type FileOwner } from "./api-files.js";
import { apiMirrorBody, withAttachmentLines } from "../lib/inbound-body.js";
import { apiJson, inScopeEitherName, notInScope, heldFields } from "./api-respond.js";
import { isOwnerPrincipal, type Principal } from "../lib/principals.js";
import { listWindows } from "../lib/tmux-helper.js";
import { newThreadId, type Envelope, type ApiUserEndpoint } from "./router.js";
import { handleSlashPassthrough, type SlashDeps } from "./api-slash.js";
import { interceptRemoteReview } from "./remote-review-intake.js";
import { lendScopeAllows } from "./lend-scope.js";
import { trackInboundHandoff } from "./handoff-tracker.js";
import { messageWaitForIdle, parseWaitForIdle } from "./api-message-queue-policy.js";
import { saveUploadToInbox, uploadFailureStage } from "./local-api/media-refresh.js";

export interface PendingApiRequest {
  tokenId: string;
  tokenName: string;
  agentChannelId: string;
  agentName: string; fileOwner?: FileOwner; // 请求那一刻钉住的 peer 指纹，回复登记附件时用（bridge/api-files.ts peerFileOwner）
  threadId: string;
  messageId?: string; waitUntil?: number; // messageId：reply_to / 作废回显的 inReplyTo 按它认领（lib/pending-reply-scope.ts claimApiReply）；waitUntil：同步等到几时
  siblingThreadId?: string; // 它等着时 agent 的回复记到了同一调用方的另一条（那条的 threadId）：Stop 兜底回「没单独答复」的说明，不回空（lib/pending-reply-scope.ts claimApiReply）
  ts: number; acceptsFiles?: boolean; // 请求方（新版 peer）声明看得懂回复里的 files，reply 带附件时据此决定警不警告（bridge/api-reply-files.ts）
  /** wait 模式挂的 resolver（无 wait 则为空） */
  resolve?: (result: ApiReplyResult) => void;
}

export interface ApiReplyResult {
  reply: string | null;
  components?: unknown[];
  files?: { name: string; url: string; media?: string; size?: number; sha256?: string }[]; // 对方 peer 按 lib/peer-reply-files.ts 解析、推给它的 agent
  threadId: string;
  agent: string;
  /** true = agent 没调 reply()，文本来自 Stop-hook drain 兜底（R3）；apiError = 那一轮以 API 错误结束、reply 为 null，error = 错误类型；siblingThreadId = 没单独答，reply 是 bridge 的说明 */
  viaFallback?: boolean; apiError?: boolean; error?: string; siblingThreadId?: string;
}

interface ApiMessageRuntimeDeps {
  clients: Map<string, { ws: unknown; cwd?: string }>;
  deliver: (env: Envelope) => Promise<{ envelope: Envelope; outcome: { kind: string; [k: string]: unknown } }>;
  mirrorApiExchange: (to: ApiUserEndpoint, agentChannelId: string, text: string) => Promise<void>;
  startTypingWithSafety: (channelId: string) => void;
  lastMessageSource: Map<string, string>;
}

interface MessageDeps extends ApiMessageRuntimeDeps {
  findApiAgent: (name: string) => Promise<{ name: string; channelId: string; status?: string } | null>;
  pendingApiRequests: Map<string, PendingApiRequest[]>;
  apiReqKey: (tokenId: string, channelId: string) => string;
  slash: SlashDeps;
}

export async function handleApiMessages(
  req: Request, url: URL, principal: Principal, tokenId: string, msgMatch: RegExpMatchArray, deps: MessageDeps,
): Promise<Response> {
  const { findApiAgent } = deps;
  const agentParam = decodeURIComponent(msgMatch[1]);
  if (!inScopeEitherName(principal, agentParam) && !(await lendScopeAllows(req, principal, agentParam))) return notInScope(agentParam);
  const agent = await findApiAgent(agentParam);
  if (!agent) return apiJson(404, { ok: false, error: `agent "${agentParam}" not found` });
  const client = agent.status === "creating" ? undefined : deps.clients.get(agent.channelId) ?? pmClientFor(agent.name, deps.clients); // creating agents cannot receive messages
  if (!client) {
    // ws 不在 ≠ agent 死了。channel-server 是独立子进程，被顶替/重启时 ws 会短暂
    // 缺席，而 tmux window 里的 Claude Code 照常跑着上一回合（2026-07-25 owner:
    // 「提示已断开，我进 console 看你还在进行上一轮对话」）。window 还在就报可重试的
    // 503，别把「链路重连中」说成「会话不存在」。
    const alive = agent.status !== "creating" && (await listWindows().catch((): string[] => [])).includes(agent.name);
    if (alive) {
      return apiJson(503, {
        ok: false,
        retryable: true,
        error: `agent "${agent.name}" 消息链路重连中（会话仍在运行），请稍后重试`,
      });
    }
    return apiJson(409, { ok: false, error: `agent "${agent.name}" is offline (no active session)` });
  }

  const body = await readMessageBody(req, agent.name);
  if (body instanceof Response) return body;
  const { text, waitSec, acceptsFiles, level, attachments } = body;
  // 仓库方审查结论交调度器入账、不起 PM 回合（bridge/remote-review-intake.ts）；不命中照原路投
  const remote = await interceptRemoteReview({ peer: principal.peer, agent: agent.name, text, attachments: attachments.length },
    deps.mirrorApiExchange.bind(null, { kind: "api", tokenId, name: principal.name || tokenId }, agent.channelId)); if (remote) return remote;
  if (!attachments.length) { const r = await (await import("./ask-entry.js")).answerFromChat({ agent: agent.name, text, principal, askId: url.searchParams.get("ask") }); if (r) return r; }

  // Web 斜杠直通只给 owner（bridge/api-slash.ts）：能直通就注入 TUI 并在这里返回（非 owner → 403）；不是命令 → 按普通消息往下投
  const slashRes = await handleSlashPassthrough({ principal, tokenId, agent, text, hasAttachments: attachments.length > 0 }, deps.slash);
  if (slashRes) return slashRes;

  return deliverApiMessage({ principal, tokenId, agent, client, text, waitSec, acceptsFiles, level, attachments, waitForIdle: messageWaitForIdle(body.waitForIdle) }, deps);
}

type MessageBody = { text: string; waitSec: number; acceptsFiles: boolean; level: unknown; attachments: string[]; waitForIdle: boolean };

async function readMessageBody(req: Request, agentName: string): Promise<MessageBody | Response> {
  let text = "";
  let waitForIdle = false; let waitSec = 0; let acceptsFiles = false; let level: unknown; // level：peer 标的 PM 级别（api-message-policy.ts）
  const attachments: string[] = [];
  const contentType = req.headers.get("Content-Type") || "";
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      text = String(form.get("text") || "");
      waitSec = Number(form.get("wait") || 0);
      waitForIdle = parseWaitForIdle(form.has("waitForIdle") ? form.get("waitForIdle") : undefined, true);
      // 不用 `f is File` 类型谓词：Bun 的全局 File 与 node:buffer 的 File 在类型
      // 上不兼容（缺 webkitRelativePath/slice），谓词写法会被 tsc 拒。运行时判据
      // 仍是 instanceof File，只是把窄化交给 typeof 排除字符串项。
      const files = form
        .getAll("files")
        .filter((f) => typeof f !== "string" && f instanceof File)
        .slice(0, 5) as unknown as File[];
      for (const f of files) {
        if (f.size > 10 * 1024 * 1024) return apiJson(413, { ok: false, error: `file "${f.name}" exceeds 10MB` });
        if (f.size === 0) return apiJson(400, { ok: false, error: `file "${f.name || "(unnamed)"}" is empty` }); // Bun 解析空分片会丢文件名
        const saved = await saveUploadToInbox(f, agentName).catch((e: unknown) => e as Error); // 原子占名 + 记归属（local-api/media-refresh.ts）
        if (typeof saved !== "string") { // 报错只带客户端给的文件名，不回显落盘路径
          const stage = uploadFailureStage(saved); console.error(`[api] 附件${stage === "read" ? "读取" : "落盘"}失败 agent=${agentName}:`, saved?.message);
          return apiJson(stage === "read" ? 400 : 500, { ok: false, error: `could not ${stage} file "${f.name}"` });
        }
        attachments.push(saved);
      }
    } else {
      const body = (await req.json()) as { text?: string; wait?: number; acceptsReplyFiles?: unknown; level?: unknown; waitForIdle?: unknown };
      text = String(body.text || "");
      waitForIdle = parseWaitForIdle(body.waitForIdle, false);
      waitSec = Number(body.wait || 0); acceptsFiles = body.acceptsReplyFiles === true; level = body.level;
    }
  } catch {
    return apiJson(400, { ok: false, error: "invalid body (JSON {text, wait?, waitForIdle?: boolean} or multipart with text/files and waitForIdle=true/false)" });
  }
  if (!text.trim() && attachments.length === 0) return apiJson(400, { ok: false, error: "text is required" });
  waitSec = Math.min(Math.max(waitSec, 0), 300);
  return { text, waitSec, acceptsFiles, level, attachments, waitForIdle };
}

type ReadyMessage = MessageBody & {
  principal: Principal; tokenId: string; agent: { name: string; channelId: string }; client: { ws: unknown; cwd?: string };
};

async function deliverApiMessage(input: ReadyMessage, deps: MessageDeps): Promise<Response> {
  const { principal, tokenId, agent, client, text, waitSec, acceptsFiles, level, attachments, waitForIdle } = input;
  const { pendingApiRequests, apiReqKey } = deps;
  const tokenName = principal.name || tokenId;
  const threadId = newThreadId();
  const env: Envelope = {
    from: { kind: "api", tokenId, name: tokenName, ...(principal.peer ? { peer: principal.peer } : {}),
      ...(isOwnerPrincipal(principal) ? { owner: true } : {}), ...(principal.credential ? { credential: principal.credential } : {}) },
    to: { kind: "local", agentName: agent.name, channelId: agent.channelId, ws: client.ws as any, cwd: client.cwd },
    intent: "request",
    content: withAttachmentLines(text, attachments), // 附件照 Discord 入口写进正文：Pi 只认正文，历史/直播靠它还原缩略图
    meta: {
      messageId: `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      triggerKind: "system",
      ts: new Date().toISOString(),
      threadId,
      ...(waitForIdle ? { waitForIdle: true } : {}),
      attachments: attachments.length ? attachments : undefined,
      // API 请求不需要 inter-agent watchdog（有自己的 wait/轮询语义）
      skipInterAgentWatchdog: true, ...peerPmLevel(principal, level), // 只有已认证 peer 的 info 进 meta（降级，不能升级）
    },
  };

  // 挂 pending（无论是否 wait —— deliverToApi 靠它关联 threadId / R3 兜底靠它找 waiter）
  const key = apiReqKey(tokenId, agent.channelId);
  const entry: PendingApiRequest = {
    tokenId,
    tokenName,
    agentChannelId: agent.channelId,
    agentName: agent.name,
    threadId,
    messageId: env.meta.messageId, waitUntil: waitSec > 0 ? Date.now() + waitSec * 1000 : undefined, // 投递前就标：停字的抢占在 deliver 里跑，resolve 这时还没挂（pi-abort holdStopWait）
    ts: Date.now(), acceptsFiles, fileOwner: await peerFileOwner(principal),
  };
  const queue = pendingApiRequests.get(key) || [];
  queue.push(entry);
  pendingApiRequests.set(key, queue);

  const delivery = await deps.deliver(env);
  if (delivery.outcome.kind !== "sent") {
    const idx = queue.indexOf(entry);
    if (idx >= 0) queue.splice(idx, 1);
    const reason = delivery.outcome.kind === "dropped" ? (delivery.outcome as any).reason : (delivery.outcome as any).error?.message;
    return apiJson(502, { ok: false, error: `delivery failed: ${reason || "unknown"}` });
  }

  followPmDelivery(agent, delivery); const quiet = settleDigestedPeerInfo(delivery, pendingApiRequests, entry); // 转交给当班 PM 时，typing / 来源 / 交接记录都记在实际收件人名下；quiet = 摘要收下的 peer info，没有回合
  if (principal.peer && !quiet) trackInboundHandoff(threadId, principal.peer, agent.name, text.length); // 交接记录（bridge/handoff-tracker.ts）
  // R2 入站镜像：只是 Discord 抄送，失败不影响已完成的投递；mirrorApiExchange 内部已 try/catch 记日志，这里的 catch 只防未来改动漏抛
  deps.mirrorApiExchange({ kind: "api", tokenId, name: tokenName }, agent.channelId, `[🌐 API←${tokenName}] ${apiMirrorBody(text, attachments.length)}`).catch(() => {});
  if (!quiet && !delivery.outcome.heldBy && delivery.outcome.note !== "guarded" && delivery.outcome.note !== "queued") deps.startTypingWithSafety(agent.channelId); // 押住了 / 被守门隔离了就没有回合
  if (!quiet) deps.lastMessageSource.set(agent.channelId, "agent"); // API 触发的 turn 不发 Stop 完成通知 @ owner（回复走 API 回路 + R2 镜像已可见）

  // No new turn exists for queued / guarded messages; keep their pending thread for the later reply.
  if (quiet || waitSec === 0 || delivery.outcome.heldBy || delivery.outcome.note === "guarded" || delivery.outcome.note === "queued") {
    const held = {
      ...(delivery.outcome.note === "queued" ? { queued: true } : {}), ...heldFields(delivery.outcome.heldBy, principal),
      ...(delivery.outcome.note === "guarded" ? { guarded: true, messageId: env.meta.messageId } : {}),
    };
    return apiJson(202, { ok: true, accepted: true, threadId, agent: agent.name, ...held, hint: `poll GET /api/v1/threads/${threadId} or subscribe /api/v1/events` });
  }

  const result = await new Promise<ApiReplyResult | null>((resolve) => {
    entry.resolve = resolve;
    setTimeout(() => resolve(null), waitSec * 1000);
  });
  if (!result) {
    entry.resolve = undefined; // 超时后 deliverToApi/R3 仍会把结果写进 apiThreadResults
    return apiJson(202, { ok: true, accepted: true, timedOut: true, threadId, agent: agent.name, hint: `poll GET /api/v1/threads/${threadId}` });
  }
  return apiJson(200, { ok: true, ...result });
}
