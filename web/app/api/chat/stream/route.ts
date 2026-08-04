export const runtime = "nodejs";

import { SSE_DONE, type WebStreamEvent, type AnchoredStreamEvent, type WebAuqQuestion, type WebComponentRow } from "@/lib/chat/events";
import { apiAgentName, bridgeGet, bridgeAuthHeaders, BRIDGE } from "@/lib/chat/bridge-api";
import { extractAttachments } from "@/lib/chat/attachments";
import { isAuthed } from "@/lib/api-auth";
import { serverLang } from "@/lib/server-lang";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

/**
 * 某 agent 的持久输出流（SSE）。
 *
 * 2026-07-10 迁移：旧 /web/stream（web-hub tee）→ upstream 的 /api/v1/events
 * （event-bus SSE）。BFF 在 server 端带 Bearer 订阅（绕开 EventSource 不能带
 * header 的坑），按 agent 过滤 + 把 BridgeEvent 翻译成前端的 WebStreamEvent
 * （协议 v1 不变，前端 stream.ts / chat-store 零改动）。
 *
 * 事件映射：
 *   agent_status thinking → {t:"status",status:"running"}；done → {t:"done"}
 *   tool_start            → {t:"tool", state:"running"}（tool_done 推 tool-state 定稿绿/红）
 *   assistant_text        → {t:"text"}
 *   chat_message(out)     → {t:"reply"}（reply() 的最终回复，挂 replyText 与叙述分区渲染）
 *   question              → {t:"ask"}；question_cleared → {t:"ask-cleared"}（fork 事件）
 *   auto_deny             → {t:"text", "🚫 …"}
 *   bg_task_started/update/completed → {t:"bg-start"/"bg-update"/"bg-done"}（后台任务面板）
 *   session_anomaly(kind=link_down) → {t:"text", "⚠️ 链路已断开 …"}
 *   其余（turn_duration / 其它 session_anomaly 子类型）v1 暂不消费
 *
 * 连流后先补拉 GET /api/v1/agents/:name/pending —— question 事件可能发生在
 * 订阅之前（切会话/刷新/回前台），对应旧 web-hub 的 pendingInteraction replay。
 */

const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "avif", "svg"]);

interface BridgeEvent {
  seq: number;
  ts: string;
  agent: string;
  chatId: string;
  type: string;
  data: Record<string, unknown>;
}

function mapAuqQuestions(raw: unknown): WebAuqQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => ({
    question: String(q?.question ?? ""),
    header: String(q?.header ?? ""),
    multiSelect: !!q?.multiSelect,
    options: Array.isArray(q?.options)
      ? q.options.map((o: { label?: string; description?: string }) => ({
          label: String(o?.label ?? ""),
          description: o?.description ? String(o.description) : undefined,
        }))
      : [],
  }));
}

/** BridgeEvent → WebStreamEvent（null = 该事件 v1 不消费）。 */
function translate(evt: BridgeEvent, lang: "zh" | "en"): WebStreamEvent | null {
  const d = evt.data || {};
  switch (evt.type) {
    case "agent_status":
      // trigger=interrupt 的 done → 前端给该回合标「⊘ 已打断」而非「✓ 完成」
      return d.status === "done"
        ? { t: "done", ...(d.trigger === "interrupt" ? { interrupted: true } : {}) }
        : { t: "status", status: "running" };
    case "tool_start":
      return {
        t: "tool",
        name: String(d.name ?? "?"),
        summary: String(d.summary ?? ""),
        state: "running",
        // id：tool_done 的失败态按它找回这张卡
        ...(typeof d.toolId === "string" && d.toolId ? { id: d.toolId } : {}),
        // 完整入参详情（后端 formatToolDetail，截断 4k）——工具卡点开展示
        ...(typeof d.detail === "string" && d.detail ? { detail: d.detail } : {}),
      };
    case "tool_done":
      // 成功/失败都推 tool-state——工具卡三态背景(运行蓝/完成绿/失败红,
      // owner 2026-07-15)需要 done 信号,不然直播里的卡永远停在蓝色
      return typeof d.toolId === "string" && d.toolId
        ? { t: "tool-state", id: d.toolId, state: d.error ? "error" : "done" }
        : null;
    case "assistant_text":
      return { t: "text", text: String(d.text ?? "") };
    case "chat_message": {
      // direction=in 且来源是用户(Web api/Discord user)→ user-in:另一端
      // 用户的发言实时画进本端视图(owner 2026-07-24:手机发的话电脑端要等对齐
      // 才出现)。agent/bridge 注入不算用户消息;本端自己的回声由前端对账去重。
      if (d.direction === "in") {
        const src = String(d.srcKind ?? "");
        if ((src === "api" || src === "user") && typeof d.text === "string" && d.text.trim()) {
          // 剥附件注入块([用户上传了…]/[attachment:…]) → 干净正文 + 附件数组。
          // 不剥的话:①另一端渲染出整块路径文字 ②本端回声与乐观消息文本不一致,
          // 对账去重失配 → 同一条消息双份(2026-07-24 用户截图实锤)
          const { content, attachments } = extractAttachments(d.text);
          if (!content && !attachments?.length) return null;
          return { t: "user-in", text: content, ...(attachments?.length ? { attachments } : {}) };
        }
        return null;
      }
      if (d.direction !== "out") return null;
      // reply() 的最终回复 → 独立 reply 事件（挂 replyText，与过程叙述分区、
      // 走 Domd 富文本、且回合 done 之后到达也能定稿——修「回复完又冒一条纯文本」）
      // components：reply 附带的按钮/选单（后端 #29 起 chat_message 事件带上），原样透传
      // files：agent 出站附件（bridge 已拷贝进 inbox，attachment=落盘文件名）→
      // 前端走 /api/chat/attachment/<name> 内联显示（owner:「你也可以给我发图片」）
      const atts = Array.isArray(d.files)
        ? (d.files as { name?: string; attachment?: string }[])
            .filter((f) => f?.attachment)
            .map((f) => ({
              name: String(f.name || f.attachment),
              kind: IMG_EXT.has(String(f.attachment).split(".").pop()?.toLowerCase() || "") ? ("image" as const) : ("file" as const),
              url: `/api/chat/attachment/${encodeURIComponent(String(f.attachment))}`,
            }))
        : [];
      return {
        t: "reply",
        text: String(d.text ?? ""),
        ...(Array.isArray(d.components) ? { components: d.components as WebComponentRow[] } : {}),
        ...(atts.length ? { attachments: atts } : {}),
      };
    }
    case "question":
      return { t: "ask", id: `auq-${evt.seq}`, questions: mapAuqQuestions(d.questions) };
    case "question_cleared":
      return { t: "ask-cleared" };
    case "auto_deny":
      // 服务端按用户语言偏好生成(单用户部署;带变量串前端字典翻不了)
      return {
        t: "text",
        text:
          lang === "en"
            ? `🚫 An action was blocked by auto mode${d.reason ? `: ${String(d.reason)}` : ""}`
            : `🚫 一个操作被 auto 模式拦下${d.reason ? `：${String(d.reason)}` : ""}`,
      };
    // 链路掉线告警(v2.14+):tmux 里 Claude Code 活着,但 channel-server
    // 没连上 bridge —— 消息进不来也出不去。此前这条只发 Discord 频道,Web 端
    // 用户一无所知,只能干等(owner 2026-07-25 连踩一天)。翻成一条醒目的系统
    // 文本,复用现有渲染管线。其它 session_anomaly 子类型仍不消费。
    case "session_anomaly": {
      // v2.15+ stalled:输出 token 长时间冻结(thinking-telemetry 的卡死判定)
      if (d.kind === "stalled") {
        const mins = Number(d.minutes) || 0;
        return {
          t: "text",
          text:
            lang === "en"
              ? `🧊 Possible stall — output token count has been frozen for ${mins} min mid-turn. Consider Interrupt and retry.`
              : `🧊 疑似卡死 —— 回合进行中，输出 token 计数已 ${mins} 分钟纹丝不动。建议点「停止」中断后重试。`,
        };
      }
      // v2.16.2「Switch model?」弹窗待决(watcher 判定非用户意图,不代按)——
      // web 用户此前零提示只看到卡死;文本指引去模型下拉重选(会带意图,必被代按)
      if (d.kind === "switch_model_prompt") {
        const fams = Array.isArray(d.families) ? (d.families as string[]).join("/") : "?";
        return {
          t: "text",
          text:
            lang === "en"
              ? `🎛 Claude Code is showing a "Switch model?" dialog (${fams}) that doesn't match any user-initiated switch — not auto-confirmed. Re-pick the model from the dropdown to complete it, or use the Discord buttons.`
              : `🎛 会话弹出了「Switch model?」确认框（涉及 ${fams}），不是你发起的切换，我没有代按。要切就去右上模型下拉重选一次（会自动确认），或到 Discord 点按钮。`,
        };
      }
      // v2.16+ 模型漂移(CC 用量保护静默降级)——web 端也要看得见
      if (d.kind === "model_drift") {
        return {
          t: "text",
          text:
            lang === "en"
              ? `⚠️ Model drift — expected \`${String(d.expected ?? "?")}\` but the session is actually using \`${String(d.actual ?? "?")}\` (likely Claude Code usage-protection downgrade). Restart to pull it back.`
              : `⚠️ 模型漂移 —— 预期 \`${String(d.expected ?? "?")}\`，会话实际在用 \`${String(d.actual ?? "?")}\`（多半是 Claude Code 用量保护静默降级）。restart 可拉回。`,
        };
      }
      if (d.kind !== "link_down") return null;
      const mins = Number(d.minutes) || 0;
      return {
        t: "text",
        text:
          lang === "en"
            ? `⚠️ Link down for ${mins} min — Claude Code is running in tmux, but its channel-server is not connected to the bridge, so messages cannot get in or out. Restarting this agent fixes it.`
            : `⚠️ 链路已断开 ${mins} 分钟 —— tmux 里 Claude Code 还在跑，但它的 channel-server 没连上 bridge，消息进不来也出不去。重启这个 agent 可修复。`,
      };
    }
    // v2.15+ 思考遥测(transient,3s 一条)——思考徽章的实时数据
    case "thinking_telemetry":
      return {
        t: "telemetry",
        ...(typeof d.elapsedRaw === "string" && d.elapsedRaw ? { elapsed: d.elapsedRaw } : {}),
        ...(typeof d.tokens === "number" ? { tokens: d.tokens } : {}),
        ...(typeof d.effort === "string" && d.effort ? { effort: d.effort } : {}),
      };
    case "bg_task_started":
      return {
        t: "bg-start",
        id: String(d.id ?? ""),
        kind: d.kind === "shell" ? "shell" : "subagent",
        title: String(d.title ?? ""),
      };
    case "bg_task_update":
      // items 缺失（老 bridge）→ 无内容可渲染，丢弃（避免空更新扰动 UI）
      if (!Array.isArray(d.items) || d.items.length === 0) return null;
      return { t: "bg-update", id: String(d.id ?? ""), items: (d.items as unknown[]).map(String) };
    case "bg_task_completed":
      return { t: "bg-done", id: String(d.id ?? ""), durationMs: typeof d.durationMs === "number" ? d.durationMs : undefined };
    case "turn_duration":
      // 回合耗时 → 完成标记行的「· 12.3s」(2026-07-14 owner:完成要有明确提示)
      return typeof d.durationMs === "number" ? { t: "turn", ms: d.durationMs } : null;
    case "compact_done":
      // jsonl compact_boundary → 系统分隔线 + ctx 徽章即时回落（不等 15s 轮询）
      return {
        t: "compact",
        pre: typeof d.preTokens === "number" ? d.preTokens : 0,
        post: typeof d.postTokens === "number" ? d.postTokens : 0,
      };
    default:
      return null;
  }
}

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return new Response("未登录", { status: 401 });
  }
  const lang = await serverLang();
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  if (!agent) return new Response("missing agent", { status: 400 });
  // 断点续传:前端带上最后收到的 eid → bridge 环形缓冲重放 seq>since 的事件,
  // 回前台/断流重连不用全量重拉历史(owner 2026-07-16「catch up 更快更丝滑」)
  const since = url.searchParams.get("since");
  const apiName = apiAgentName(agent);
  // 事件里的 agent 字段是 registry 名（agent-xxx）或 "master"
  const nameVariants = new Set([apiName, `agent-${apiName}`]);

  let upstream: Response;
  try {
    upstream = await fetch(
      `${BRIDGE}/api/v1/events${since && /^\d+$/.test(since) ? `?since=${since}` : ""}`,
      {
        headers: { ...bridgeAuthHeaders(), Accept: "text/event-stream" },
        signal: request.signal,
      }
    );
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause;
    console.error(`[stream] Bridge events fetch 失败 agent=${agent}:`, (e as Error).message, "| cause:", cause);
    return new Response(`${lang === "en" ? "Bridge unreachable" : "Bridge 不可达"}: ${(e as Error).message}`, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => "");
    console.error(`[stream] Bridge events 非 2xx agent=${agent}: status=${upstream.status} body=${body.slice(0, 200)}`);
    return new Response(lang === "en" ? "Bridge events unavailable" : "Bridge events 不可用", { status: 502 });
  }
  const upstreamBody = upstream.body;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (evt: AnchoredStreamEvent | typeof SSE_DONE) => {
        try {
          const payload = evt === SSE_DONE ? SSE_DONE : JSON.stringify(evt);
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          /* 已关闭 */
        }
      };
      // 10s 心跳(曾 30s):前端假死流看门狗按「25s 无字节」判死,心跳周期必须
      // 显著短于判死阈值,不然活流被误杀
      heartbeat = setInterval(() => send(SSE_DONE), 10_000);

      // 连流即补拉当前挂起态（question 事件 + 回合进行态可能早于本次订阅：
      // 切会话 / 刷新 / 回前台）。thinking 时先补一条 status:running，让 composer
      // 立刻进入「停止」态（对应旧 web-hub 的 pendingInteraction replay）。
      try {
        const pending = await bridgeGet<{
          ok: boolean;
          question: { questions: unknown; ts: number } | null;
          thinking?: boolean;
        }>(`/agents/${encodeURIComponent(apiName)}/pending`, { timeoutMs: 5000 });
        if (pending.thinking) {
          send({ t: "status", status: "running" });
        }
        if (pending.question) {
          send({
            t: "ask",
            id: `auq-pending-${pending.question.ts}`,
            questions: mapAuqQuestions(pending.question.questions),
          });
        }
      } catch {
        /* pending 补拉失败不阻塞流 */
      }

      // bg 任务 replay：SSE 只带增量,刷新/重连后活跃任务面板会空——连流即补拉
      // 快照,合成 bg-start + bg-update 下发（已积累的尾部行一次性给到）。
      try {
        const bg = await bridgeGet<{
          ok: boolean;
          tasks: { id: string; kind: "subagent" | "shell"; title: string; lines: string[] }[];
        }>(`/agents/${encodeURIComponent(apiName)}/bg-tasks`, { timeoutMs: 5000 });
        for (const t of bg.tasks || []) {
          send({ t: "bg-start", id: t.id, kind: t.kind, title: t.title });
          if (t.lines?.length) send({ t: "bg-update", id: t.id, items: t.lines });
        }
        // 快照全集下发（空数组也发）：前端把不在此列的 running 卡标完成——
        // bridge 重启丢 bg_task_completed 事件时,幽灵「working」卡靠它收敛
        send({ t: "bg-sync", ids: (bg.tasks || []).map((t) => t.id) });
      } catch {
        /* bg 补拉失败不阻塞流 */
      }

      const reader = upstreamBody.getReader();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";
          for (const frame of frames) {
            const dataLines = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            let evt: BridgeEvent;
            try {
              evt = JSON.parse(dataLines.join("\n")) as BridgeEvent;
            } catch {
              continue; // 心跳/坏帧
            }
            if (!nameVariants.has(evt.agent)) continue;
            const mapped = translate(evt, lang);
            // eid = bridge seq:前端的断点续传锚(下次重连 ?since=<eid>)
            if (mapped) send({ ...mapped, eid: evt.seq });
          }
        }
      } catch {
        /* 上游断开（bridge 重启等）→ 结束本流，前端重连 */
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
