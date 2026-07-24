export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { apiAgentName, bridgeGet } from "@/lib/chat/bridge-api";
import { isAuthed } from "@/lib/api-auth";
import { st } from "@/lib/server-lang";
import type { ChatMessage, ToolCallView, AssistantSegment, ChatAttachmentView } from "@/features/chat/type";
import type { WebComponentRow } from "@/lib/chat/events";
import { attachmentFromPath, extractAttachments } from "@/lib/chat/attachments";

/**
 * 某 agent 的历史消息（打开会话时先拉，刷新不丢）。
 *
 * 2026-07-10 迁移：BFF 直读 jsonl（旧 lib/chat/history.ts）→ Bridge 只读历史
 * API（v2.9+，live+归档合并、对已 kill 的 agent 也有效、解析与 jsonl-watcher
 * 同源）。取 mtime 最新的 session 的最后 300 条。
 */

interface NeutralMessage {
  seq: number;
  ts?: string;
  role: "user" | "assistant" | "system";
  text?: string;
  tools?: { name: string; summary: string; detail?: string; error?: boolean }[];
  /** [fork] reply() 的最终回复正文（后端从 jsonl 的 reply tool_use 提取） */
  replyText?: string;
  /** [fork] reply() 附带的按钮/选单（后端从 reply tool_use 的 input.components 提取） */
  replyComponents?: WebComponentRow[];
  /** [fork] reply() 出站附件文件名（basename;取回走 /api/chat/attachment 的 inbox 后缀兜底） */
  replyFiles?: string[];
  /** [fork] 回合耗时 ms(正常收尾的回合才有)——历史尾轮据此渲染完成标记 */
  turnMs?: number;
  compactSummary?: boolean;
  /** 入站消息发送者标签（<channel> user 属性：API token 名 / Discord 用户名 / 来源 agent） */
  from?: string;
}

/** 本前端自己的 token 名（manager token-add web-ui）——自己发的消息不用再标来源。 */
const SELF_FROM = new Set(["web-ui"]);

// 附件标记解析移到 lib/chat/attachments.ts —— stream 路由(user-in 跨端同步)共用


/**
 * 把中性消息映射成 ChatMessage，并**合并同一回合的连续 assistant 记录**。
 *
 * CC 的 jsonl 里，一个 assistant 回合会被拆成很多条记录——每个 tool_use 单独一条、
 * 每段 text 单独一条。若 1:1 映射成气泡，刷新后一个回合会碎成几十个小气泡
 * （"稀碎"）。实时链路不碎，是因为 ensureLiveAssistant 把整回合的 text/工具都并进
 * 同一个气泡。这里让历史对齐实时：连续的 assistant 记录累积进一个气泡（text 用
 * 空行拼接、工具按序收集），遇到 user / system 分隔线 / compact 边界就断开分组。
 */
/** 在带组件的气泡里找该点击对应的 choiceId + 人类可读 label（不在组里返回 null）。 */
function matchClickedChoice(
  bubble: ChatMessage,
  btnId: string | null,
  selId: string | null,
  selValue: string | null
): { choiceId: string; label: string } | null {
  for (const row of bubble.replyComponents ?? []) {
    if (row.type === "buttons" && btnId) {
      const btn = row.buttons.find((b) => b.id === btnId);
      if (btn) return { choiceId: btnId, label: btn.label };
    }
    if (row.type === "select" && selId && row.id === selId && selValue) {
      const opt = row.options.find((o) => o.value === selValue);
      if (opt) return { choiceId: `${selId}:${selValue}`, label: opt.label };
    }
  }
  return null;
}

function toChatMessages(items: NeutralMessage[], opts?: { tail?: boolean }): ChatMessage[] {
  const out: ChatMessage[] = [];
  let group: ChatMessage | null = null; // 当前正在累积的 assistant 回合气泡
  // 最近一条带组件的 assistant 气泡：后续 user 的按钮点击 payload 命中其组件
  // → 标 replyClickedId（刷新后「已答」态不丢，禁用+高亮所选，对齐直播行为）
  let lastWithComponents: ChatMessage | null = null;

  for (const m of items) {
    // compact 生成的长摘要不是真实用户输入（guide §6 建议默认折叠），v1 先不展示
    if (m.compactSummary) continue;
    // CRLF 归一：channel 注入链路会把 \n 变 \r\n,而前端乐观消息是 textarea 的
    // \n——不归一,乐观/历史对账精确匹配必失败 → 同一条消息双份渲染
    // (2026-07-15 真机截图,qingniao-backend)
    if (m.text) m.text = m.text.replace(/\r\n?/g, "\n");

    if (m.role === "system") {
      // system 级事件（compact 边界 / 斜杠命令记录 / 命令输出）→ 居中分隔条，
      // 渲染交给前端 SystemDivider。剥掉老 bridge 自带的「── ──」装饰（兼容）。
      group = null;
      const text = (m.text || "上下文已压缩").replace(/^[─—\s]+|[─—\s]+$/g, "");
      out.push({ id: `h${m.seq}`, role: "system", content: text, ts: m.ts });
      continue;
    }

    const toolCalls: ToolCallView[] | undefined = m.tools?.length
      ? m.tools.map((t) => ({ name: t.name, summary: t.summary, state: t.error ? ("error" as const) : ("done" as const), ts: m.ts, ...(t.detail ? { detail: t.detail } : {}) }))
      : undefined;
    if (!m.text && !toolCalls && !m.replyText) continue;

    if (m.role === "user") {
      group = null; // 用户消息断开 assistant 分组
      // CC 写入的中断标记不是用户打的字 → 渲染成轻分隔线
      if (/^\[Request interrupted/.test(m.text || "")) {
        out.push({ id: `h${m.seq}`, role: "system", content: "已被用户中断", ts: m.ts });
        continue;
      }
      // TUI 斜杠命令记录（如 clear 后新会话首条 <command-name>/clear</command-name>）
      // 不是用户打的字 → 渲染成轻分隔线
      const cmdMatch = (m.text || "").match(/^<command-name>(\/[\w-]+)<\/command-name>/);
      if (cmdMatch) {
        out.push({ id: `h${m.seq}`, role: "system", content: cmdMatch[1], ts: m.ts });
        continue;
      }
      const from = m.from && !SELF_FROM.has(m.from) ? m.from : undefined;
      // 按钮/选单点击的机器 payload → 渲染成组件里的 label，与 live 乐观气泡**同形**
      // （形态不一致会让乐观/历史对账失败,乐观 label 气泡被当「未送达」挂到列表
      // 末尾——出现在后续回复之后,2026-07-16 真机截图）;组件气泡不在本页时才
      // 兜底 🔘 id。并回填该气泡的 replyClickedId（已答态跨刷新持久）。
      const btnMatch = (m.text || "").match(/^\[button:([\w-]+)\]$/);
      const selMatch = (m.text || "").match(/^\[select:([\w-]+):(.+)\]$/);
      let clickLabel: string | null = null;
      if ((btnMatch || selMatch) && lastWithComponents) {
        const clicked = matchClickedChoice(
          lastWithComponents,
          btnMatch?.[1] ?? null,
          selMatch?.[1] ?? null,
          selMatch?.[2] ?? null
        );
        if (clicked) {
          clickLabel = clicked.label;
          if (!lastWithComponents.replyClickedId) lastWithComponents.replyClickedId = clicked.choiceId;
        }
      }
      const raw = btnMatch || selMatch
        ? clickLabel ?? `🔘 ${btnMatch ? btnMatch[1] : selMatch![2]}`
        : m.text || "";
      const { content, attachments } = extractAttachments(raw);
      out.push({ id: `h${m.seq}`, role: "user", content, ts: m.ts, from, ...(attachments ? { attachments } : {}) });
      continue;
    }

    // assistant：累积进当前回合气泡（首条建组并入 out，后续 mutate 同一引用）。
    // segments 保留叙述/工具的真实交错序——不然长回合渲染成「一坨工具卡在顶 +
    // 一坨文本在底」，时间线全乱（2026-07-12 真机反馈）。
    // agent 出站附件（reply files）：basename → 附件视图,累积到回合气泡
    const replyAtts = (m.replyFiles ?? [])
      .map((f) => attachmentFromPath(f))
      .filter((a): a is ChatAttachmentView => !!a);
    if (!group) {
      group = { id: `h${m.seq}`, role: "assistant", content: m.text || "", toolCalls, ts: m.ts, segments: [] };
      if (m.replyText) group.replyText = m.replyText;
      if (m.replyComponents?.length) group.replyComponents = m.replyComponents;
      if (replyAtts.length) group.attachments = replyAtts;
      out.push(group);
    } else {
      if (m.text) group.content = group.content ? `${group.content}\n\n${m.text}` : m.text;
      if (toolCalls) group.toolCalls = [...(group.toolCalls ?? []), ...toolCalls];
      if (m.replyText) group.replyText = group.replyText ? `${group.replyText}\n${m.replyText}` : m.replyText;
      // 同一回合多条 reply 的组件累积（通常只一组）
      if (m.replyComponents?.length) group.replyComponents = [...(group.replyComponents ?? []), ...m.replyComponents];
      if (replyAtts.length) group.attachments = [...(group.attachments ?? []), ...replyAtts];
    }
    if (typeof m.turnMs === "number") group.turnMs = m.turnMs;
    // reply 的时间与气泡开场 ts 分开记（长回合里回复晚得多），取首条 reply 记录的 ts
    if (m.replyText && !group.replyTs && m.ts) group.replyTs = m.ts;
    const segs = group.segments as AssistantSegment[];
    if (m.text) {
      const tail = segs[segs.length - 1];
      if (tail?.kind === "text") tail.text += `\n\n${m.text}`;
      else segs.push({ kind: "text", text: m.text, ts: m.ts });
    }
    // reply 按时间序插进段序列（渲染层不再钉底——reply 后叙述可能还在继续）
    if (m.replyText) segs.push({ kind: "reply", text: m.replyText, ts: m.ts });
    if (toolCalls) {
      const tail = segs[segs.length - 1];
      if (tail?.kind === "tools") tail.tools.push(...toolCalls);
      else segs.push({ kind: "tools", tools: toolCalls });
    }
    if (group.replyComponents?.length) lastWithComponents = group;
  }
  // 完成标记只给「历史尾轮」:最后一条消息是 assistant 且回合正常收尾
  // (turnMs 来自 turn_duration,进行中/被打断的回合没有)。切后台错过 done
  // 事件后刷新重载,完成态不再蒸发;中间轮不标,不刷屏。
  // before 分页片段(opts.tail=false)不标——片段尾不是全局尾轮。
  if (opts?.tail !== false) {
    const tail = out[out.length - 1];
    if (tail?.role === "assistant" && typeof tail.turnMs === "number") tail.turnDone = true;
  }
  return out;
}

export async function GET(request: Request) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  if (!agent) {
    return NextResponse.json({ error: "missing agent" }, { status: 400 });
  }
  const name = encodeURIComponent(apiAgentName(agent));
  // 向上分页(owner 2026-07-16「往上滑看全部历史」):before=<seq> + session=<sid>
  // → 钉在同一 session 往前翻(seq 空间 per-session,不能跨 session 混用)
  const before = url.searchParams.get("before");
  const pinnedSession = url.searchParams.get("session");

  try {
    if (before && /^\d+$/.test(before) && pinnedSession) {
      const page = await bridgeGet<{ ok: boolean; messages: NeutralMessage[] }>(
        `/agents/${name}/history/${encodeURIComponent(pinnedSession)}?limit=300&before=${before}`,
        { timeoutMs: 10_000 }
      );
      const items = page.messages || [];
      return NextResponse.json({
        data: toChatMessages(items, { tail: false }),
        sessionId: pinnedSession,
        // 粗判:拿满一页 ≈ 还有更早(边界恰好取空一次,可接受)
        hasMore: items.length >= 300,
      });
    }

    // 1) session 清单（mtime 降序，[0] = 最新）
    const list = await bridgeGet<{
      ok: boolean;
      sessions: { sessionId: string; source: string }[];
    }>(`/agents/${name}/history`, { timeoutMs: 8000 });
    const sessions = list.sessions ?? [];
    if (!sessions.length) return NextResponse.json({ data: [] });

    // 2) 依次试最新的几个 session，读到一个成功的就返回。/clear 轮转中途最新
    //    session 可能正被拷贝/刚建空 → 单读失败就整个历史空白；回退到次新的保连续性。
    //    最多试 3 个（够覆盖一次轮转），全失败才报错。
    let lastErr: Error | null = null;
    for (const s of sessions.slice(0, 3)) {
      try {
        const page = await bridgeGet<{ ok: boolean; messages: NeutralMessage[] }>(
          `/agents/${name}/history/${encodeURIComponent(s.sessionId)}?limit=500`,
          { timeoutMs: 10_000 }
        );
        const items = page.messages || [];
        return NextResponse.json({
          data: toChatMessages(items),
          sessionId: s.sessionId,
          hasMore: items.length >= 500,
        });
      } catch (e) {
        lastErr = e as Error;
        // not found（轮转竞态）→ 试下一个；其它错误也顺延，全败再抛
      }
    }
    throw lastErr ?? new Error("no readable session");
  } catch (e) {
    const msg = (e as Error).message;
    // agent 尚无历史（新建）不是错误
    if (/not found/i.test(msg)) return NextResponse.json({ data: [] });
    return NextResponse.json({ error: `${await st("读取历史失败", "Failed to read history")}: ${msg}` }, { status: 502 });
  }
}
