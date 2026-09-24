"use client";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStore, useChatStoreApi } from "../chat-store";
import type { ChatMessage, AssistantSegment } from "../type";
import { Domd } from "@/components/domd";
import { PermissionCard } from "./permission-card";
import { AskQuestionCard } from "./ask-question-card";
import { ReplyComponents } from "./reply-components";
import { BgTaskPanel } from "./bg-task-panel";
import { CcTaskPanel } from "./cc-task-panel";
import { useT, getLang } from "@/lib/i18n";
import { fmtTs } from "../fmt-time";
import { BubbleMenu, SelectModeBar, useBubbleMenuTrigger } from "./bubble-menu";
import { InlineActionContext, type InlineActionCtx } from "@/components/domd/inline-button";
import { replyEchoMessageIds, isEchoSegment } from "../reply-echo";
import { plainLabel } from "@/lib/chat/inline-buttons";
import { agentChipIndex, agentLabelKey, messagePlainText, splitQuoted } from "../message-text";
import { ActiveToolRow, HistoryToolRow, ToolCallsBlock } from "./tool-rows";
import { ClaudeHeader, CompactingLine, ReplyingLine, ThinkingDots, TurnMark, WorkingLine } from "./turn-indicators";
import { QuoteSwipe } from "./quote-swipe";
import { AttachmentStrip } from "./attachments";
import { exitSelectMode, hasLiveSelection, isSelectMode } from "../select-mode";
import { isNearBottom, tailAppendedCount } from "../scroll-follow";
import { installTapRescue } from "@/lib/tap-rescue";
import { devCount } from "../../devtools/dev-mode";
import { ProgressNote } from "./progress-note";
import { NarrationFoldBar, NarrationFolded, useNarrationFold } from "./narration-fold";
import { SourceHeader } from "./source-header";
import { useIsExport } from "../export-context";
import { inRange, selRange } from "../share-mode";
import { ShareCheck, ShareMask, shareRowClass, useShare } from "./share-ui";

/** 触摸期吸底冻结窗口:抬手后 WebKit 提交合成 click 最长等 ~350ms(双击消歧),留余量 */
const TOUCH_HOLD_MS = 500;
const NO_ORDER: string[] = [];

/* 复刻 Claude OS features/chat 的对话观感：assistant 全宽 + ✦ Claude 头，
   user 右对齐圆角矩形，工具调用 active（转圈）/ history（可展开）两态。
   配色走 daisyUI token 跟随明暗主题：✦ 头用 accent，工具活动用 info。 */

/** system 级事件（compact / 斜杠命令 / 中断 / 命令输出）的通用居中分隔条。
 *  与消息气泡视觉解耦：无头像无名字，两侧细线 + 小灰字；点击附带秒级时间。 */
const SystemDivider = memo(function SystemDivider({ m }: { m: ChatMessage }) {
  const t = useT();
  const [showTs, setShowTs] = useState(false);
  // 进场动画只给实时新增(本地 id)——历史加载/对账替换的 h{seq} 节点不播,
  // 否则打开会话/切回对齐时整页一起闪一遍(owner 2026-07-16「更丝滑」)
  const anim = m.id.startsWith("h") ? "" : "chat-msg-in";
  // 历史里的中断记录统一成 TurnMark 同款黄色分隔线(直播/历史视觉一致)
  if (/^已被用户中断/.test(m.content)) return <TurnMark kind="interrupted" animate={!m.id.startsWith("h")} />;
  return (
    <div
      className={`${anim} mb-[22px] flex cursor-pointer select-none items-center gap-3`}
      onClick={() => setShowTs((v) => !v)}
    >
      <span className="h-px flex-1 bg-base-content/10" />
      <span className="max-w-[70%] shrink-0 truncate text-[11px] font-medium tracking-wide text-base-content/35">
        {t(m.content)}
        {showTs && m.ts && (
          <span className="ml-1.5 font-mono text-[10px] tabular-nums opacity-70">{fmtTs(m.ts)}</span>
        )}
      </span>
      <span className="h-px flex-1 bg-base-content/10" />
    </div>
  );
});

/** 过程叙述 ↔ 最终回复 之间的淡分隔线（仅两者都在时出现）。 */
function ReplyDivider() {
  const t = useT();
  return (
    <div className="my-2.5 flex items-center gap-2" aria-hidden>
      <span className="h-px flex-1 bg-base-content/10" />
      <span className="text-[10px] font-medium tracking-wide text-base-content/30">{t("回复")}</span>
      <span className="h-px flex-1 bg-base-content/10" />
    </div>
  );
}

/** 叙述/回复的文本块：点击显示**该段自己**的秒级时间（不是整个回合的开场时间——
 *  长回合一个气泡跨一小时，整体时间对「这句话什么时候说的」没意义）。
 *  streamed 语义 = 「本段还在生长」：只有它用纯文本（DOMD 只读一次,不适合增量
 *  喂字）;已封笔的段立即走 Domd——此前整个回合流式期间全是裸 markdown 星号,
 *  长回合要等几十分钟才「渲染出来」（2026-07-14 owner「渲染速度这么慢」）。
 *  memo：props 全是原始值，定稿段的 Domd（markdown 解析）不再随流式重渲染。 */
const TextBlock = memo(function TextBlock({
  msgId,
  text,
  ts,
  streamed,
  muted,
  fullText,
  foldKey,
}: {
  /** 所属消息 id（长按/右键菜单「删除」用） */
  msgId?: string;
  /** 旁白的收起 / 展开键（消息 id + 段序），只有 muted 段传；规则见 ../narration-fold.ts */
  foldKey?: string;
  text: string;
  ts?: string;
  streamed?: boolean;
  /** 整条消息的正文（长按菜单里的「复制整条」用；只有一段时不传）。 */
  fullText?: string;
  /** 过程叙述（工具间碎碎念）弱化成「旁白」：左竖线+淡色+略小字号，与 reply
   *  正文拉开格式差（owner 2026-07-14:分不清哪些是正文哪些是 console 碎碎念）。 */
  muted?: boolean;
}) {
  // 单击 = 切时间戳（老语义）；**长按 / 右键** = 浮层菜单（复制 / 选择文字 /
  // 引用）。第一版做成「点一下展开一条内联按钮条」被 owner 打回：点击太廉价、
  // 内联条还把下面的排版顶下去（2026-08-22）。菜单见 ./bubble-menu。
  const [showTs, setShowTs] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const press = useBubbleMenuTrigger(() => ({ text, fullText, ts, messageId: msgId, getEl: () => bodyRef.current }));
  const exporting = useIsExport(); // 导出树里旁白强制展开、不出收起条
  const folded = useNarrationFold(muted && !exporting ? foldKey : undefined);
  return (
    <QuoteSwipe quote={text} blockLevel>
      <div
        // 正文不用 cursor-pointer——桌面端整段文字变小手像可点链接(owner 2026-07-24
        // 「点完链接手放哪都是小手」);点击切时间戳的行为保留,光标用默认
        className={`${
          muted
            ? // 首版 13px/60% 被 owner 打回「区分不够」——真因是 DOMD 组件用
              // adoptedStyleSheets 给 .DOMD-Root 钉 16px/深色,wrapper 的字号颜色
              // 根本穿不进去。narration-muted(globals.css)按 specificity 打穿,
              // 这里的 12.5px + 45% 灰才真正落到正文元素上。
              // 12.5px/45% 又被打回「眼睛疼」——回调到 13.5px/50%,靠竖线+字号差保持区分
              // 触屏上收起条常显、会盖住末行右端(peer review #40)→ 只在无 hover 的设备给底部留白
              "narration-muted group relative border-l-2 border-base-content/20 pl-2.5 text-[13.5px] leading-snug text-base-content/50 [@media(hover:none)]:pb-5"
            : ""
        }`}
        onClick={(e) => {
          // 行内 code 的点击已被「点击复制」占用(滚动器委托)——同一下点击再切
          // 时间戳会两件事一起发生,复制浮标和时间戳挤在一起(owner 2026-07-28)
          const el = e.target as HTMLElement;
          if (el.closest?.("code") && !el.closest("pre")) return;
          // 划选后松手、长按松手都算一次 click——这两种都不该顺手切时间戳
          if (hasLiveSelection() || press.consumedClick()) return;
          setShowTs((v) => !v);
        }}
        {...press.handlers}
      >
        {/* 这层 div 是「选择文字」的选区范围;cstra-bubble 让触摸端关掉原生长按 */}
        {folded && foldKey ? <NarrationFolded text={text} foldKey={foldKey} /> : (
        <div ref={bodyRef} className="cstra-bubble">
          {streamed ? (
            // 生长中的段也实时富文本（2026-07-14 owner「边输出边渲染」）：DOMD 只读
            // 一次 → 用 key 按内容长度强制重挂,每次 80ms 合批后重新解析整段。段落
            // 级体量解析是亚毫秒级,memo 隔离其它段;未闭合语法(写到一半的 **/```)
            // 期间样式会短暂跳动,属流式渲染的正常代价。
            <Domd key={text.length} initMd={text} bodyClassName="chat-domd" />
          ) : (
            <Domd initMd={text} bodyClassName="chat-domd" />
          )}
        </div>
        )}
        {showTs && ts && (
          <div className="mt-0.5 font-mono text-[10px] tabular-nums opacity-40">{fmtTs(ts)}</div>
        )}
        {muted && foldKey && !exporting && <NarrationFoldBar foldKey={foldKey} />}
      </div>
    </QuoteSwipe>
  );
});

/**
 * 助手正文：过程叙述 + 最终回复（replyText）分区渲染，中间淡分隔线。
 * 有 segments（叙述/工具的真实交错序）时按段渲染——修「工具全堆气泡顶部、
 * 文本全挤底部」的时间线错乱；无 segments（旧缓存快照）回退 content+toolCalls。
 * 流式进行中文本段用纯文本（DOMD 只读一次不适合增量喂字），定稿/历史走 DOMD。
 * agent chip 名单只订阅压成字符串的 agentLabelKey（D8-4，见 message-text.ts）。
 */
function AssistantBody({
  m,
  liveEmpty,
  streamingLast,
}: {
  m: ChatMessage;
  liveEmpty: boolean;
  streamingLast: boolean;
}) {
  const segs = m.segments;
  const full = messagePlainText(m); // 长按菜单的「复制整条」用；只有一段时与本段相同,菜单自动不显示
  // 行内按钮(v2.20+,`[[{#id .style}label]]`):DOMD 深处的 InlineButton 经
  // context 拿到本条消息的回投回调;点击复用块级组件的 clickReplyComponent
  // (同 wire `[button:<id>]`、同 replyClicks 状态,rowKey 前缀 `i:` 区分)。
  const store = useChatStoreApi();
  const [inlineBusy, setInlineBusy] = useState(false);
  // agent chip(`[[{.agent}name]]`)的可跳转名单:name / displayName 都认,
  // master 别名映射到前端的 __master__(bridge-api 的 apiAgentName 约定)
  const agentKey = useChatStore((s) => agentLabelKey(s.state.agents));
  const inlineCtx = useMemo<InlineActionCtx>(() => {
    const { labels, resolve } = agentChipIndex(agentKey);
    return {
      clicks: m.replyClicks ?? {},
      busy: inlineBusy,
      onClick: async (id, label) => {
        setInlineBusy(true);
        try {
          await store.clickReplyComponent(m.id, `i:${id}`, id, plainLabel(label), `[button:${id}]`);
        } finally {
          setInlineBusy(false);
        }
      },
      agents: labels,
      openAgent: (label) => {
        const name = resolve(label);
        if (name) void store.openAgent(name);
      },
    };
  }, [m.id, m.replyClicks, inlineBusy, store, agentKey]);
  const hasSegs = !!segs && segs.length > 0;
  const hasNarration = hasSegs || !!m.content;
  const hasReply = !!m.replyText;
  // reply 已按时间序入段（新数据）→ 就地渲染；否则回退到底部钉底（旧快照/纯 reply 无段）
  const hasReplySeg = hasSegs && segs!.some((s) => s.kind === "reply");

  if (m.streamed && liveEmpty && !hasReply && !hasSegs) return <ThinkingDots />;
  if (!hasNarration && !hasReply) return null;

  const narration = hasSegs ? (
    <>
      {segs!.map((seg: AssistantSegment, i) =>
        seg.kind === "text" && seg.progress ? (
          <ProgressNote key={i} text={seg.text} ts={seg.ts ?? m.ts} />
        ) : // agent 把自己刚发的 reply 又当普通文本复述了一遍 → 藏掉这份灰的
        // （判据见 features/chat/reply-echo.ts；owner 2026-09-22 实报同一段话显示两份）
        seg.kind === "text" && isEchoSegment(m, seg.text) ? null : seg.kind === "text" ? (
          // 只有「最后一段且回合仍在流式」在生长——其余段已封笔,立即富文本
          <TextBlock msgId={m.id}
            key={i}
            text={seg.text}
            ts={seg.ts ?? m.ts}
            streamed={m.streamed && i === segs!.length - 1}
            fullText={full}
            muted
            foldKey={`${m.id}:${i}`}
          />
        ) : seg.kind === "reply" ? (
          // 空 reply 段不渲染（否则是一条「回复」分隔线 + 空白块的幽灵气泡）。
          // 源头已在 chat-store.setReplyText 拦截，这里兜历史快照里的旧空段。
          !seg.text?.trim() ? null : (
            <div key={i}>
              {i > 0 && <ReplyDivider />}
              {/* reply 到达即完整,永远直接富文本 */}
              <TextBlock msgId={m.id} text={seg.text} ts={seg.ts ?? m.replyTs ?? m.ts} streamed={false} fullText={full} />
            </div>
          )
        ) : (
          <div key={i} className="my-2 space-y-1">
            {seg.tools.map((t, j) =>
              streamingLast ? (
                <ActiveToolRow
                  key={j}
                  tool={t}
                  active={i === segs!.length - 1 && j === seg.tools.length - 1}
                />
              ) : (
                <HistoryToolRow key={j} tool={t} />
              )
            )}
          </div>
        )
      )}
    </>
  ) : hasNarration && !isEchoSegment(m, m.content) ? (
    <TextBlock msgId={m.id} text={m.content} ts={m.ts} streamed={m.streamed} fullText={full} muted foldKey={`${m.id}:c`} />
  ) : null;

  return (
    <InlineActionContext.Provider value={inlineCtx}>
      {narration}
      {hasReply && !hasReplySeg && (
        <>
          {hasNarration && <ReplyDivider />}
          {/* reply 到达即完整,直接富文本 */}
          <TextBlock msgId={m.id} text={m.replyText!} ts={m.replyTs ?? m.ts} streamed={false} fullText={full} />
        </>
      )}
    </InlineActionContext.Provider>
  );
}

/**
 * memo 是整个会话页的性能命门（2026-07-13「列表滑动卡死」根因）：流式期间每个
 * SSE 事件都会 produce 新 messages 数组，无 memo 时全部气泡（几十个气泡 + 几百
 * 张工具卡 + 全部 Domd markdown）每事件全量 reconcile；immer 结构共享保证未变
 * 消息的对象引用稳定，memo 后每事件只有正在流式的最后一个气泡重渲染。移动端
 * 列表页与会话页并排都在 DOM——会话页的重渲染风暴会卡死列表页的滚动。
 */
export const Message = memo(function Message({ m, streaming, isLast, awaiting }: { m: ChatMessage; streaming: boolean; isLast: boolean; awaiting: boolean }) {
  devCount("bubble-render"); // 开发者面板的「气泡渲染速率」:memo 失效时这里会飙
  // 点击消息（user 气泡 / ✦ 头）切换秒级时间显示；长按/右键出菜单
  const [showTs, setShowTs] = useState(false);
  /** user 气泡本体 —— 长按菜单里「选择文字」要框住的范围。 */
  const bubbleRef = useRef<HTMLDivElement>(null);
  // hook 必须无条件调用(下面有 system/user 两处提前 return),所以正文在长按那一刻
  // 现算,不依赖分支里的局部变量
  const press = useBubbleMenuTrigger(() => ({
    text: splitQuoted(m.content).body,
    ts: m.ts,
    messageId: m.id,
    getEl: () => bubbleRef.current,
  }));
  const t = useT();
  const store = useChatStoreApi();
  // 个人资料：自己的消息(无 from——from 是入站来源标签,别人的消息才带)
  // 旁显示自定义头像+昵称(owner 2026-07-14)。低频变更,全气泡重渲染可接受。
  const profile = useChatStore((s) => s.state.profile);
  if (m.role === "system") return <SystemDivider m={m} />;
  if (m.role === "user") {
    const atts = m.attachments ?? [];
    const isSelf = !m.from;
    // 引用条与正文分开渲染;长按菜单的「复制/引用」只拿正文那一半
    const { quoted: userQuoted, body: userBody } = splitQuoted(m.content);
    const showAvatar = isSelf && !!profile.avatar;
    // v2.20.2+ 外源入站(peer/其它 agent/Discord 用户)与本人区分(owner 实报
    // 「看起来像我说的」):来源 chip + 信息色描边,正文走 Domd 渲染 markdown
    // (peer 的 bug 报告是全格式 markdown,纯文本糊成一坨)。本人消息保持原样。
    const label = isSelf ? profile.nickname : "";
    return (
      // 布局规则(owner 2026-09-24):只有本人靠右,peer / 其它 agent / 别的用户一律靠左;
      // 圆角:靠右的右上角小、靠左的左上角小,其余大——尖角指向说话的一侧
      <div className={`${m.id.startsWith("h") ? "" : "chat-msg-in"} mb-[22px] flex flex-col gap-2 ${isSelf ? "items-end" : "items-start"}`}>
        {/* 头行:昵称 + 头像落在气泡上方,不占气泡宽度(owner 2026-07-14) */}
        {!isSelf && <SourceHeader from={m.from!} />}
        {(label || showAvatar) && (
          <div className="flex items-center gap-1.5">
            {label && <span className="text-[10px] opacity-50">{label}</span>}
            {showAvatar && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={profile.avatar} alt="" className="size-[22px] rounded-full object-cover" />
            )}
          </div>
        )}
        {atts.length > 0 && <AttachmentStrip items={atts} />}
        {m.content && (
          <QuoteSwipe quote={userBody} className="max-w-[85%]">
            <div
              ref={bubbleRef}
              data-bubble="user"
              className={`cstra-bubble break-words border px-[15px] py-[11px] text-[14.5px] leading-[1.6] text-base-content/90 ${
                isSelf
                  ? "whitespace-pre-wrap rounded-[15px_4px_15px_15px] border-base-content/5 bg-base-300"
                  : "rounded-[4px_15px_15px_15px] border-info/25 bg-info/[0.06]"
              }`}
              onClick={() => {
                // 划选后松手、长按松手都算 click——都不该顺手切时间戳
                if (hasLiveSelection() || press.consumedClick()) return;
                setShowTs((v) => !v);
              }}
              {...press.handlers}
            >
              {userQuoted && (
                <div className="mb-2 border-l-2 border-base-content/25 pl-2 text-[12px] leading-snug text-base-content/50">
                  {userQuoted}
                </div>
              )}
              {isSelf ? userBody : <Domd initMd={userBody} bodyClassName="chat-domd" />}
            </div>
          </QuoteSwipe>
        )}
        {/* v2.15+ 发送失败标记:乐观气泡不能装作已送达(2026-07-27 用户丢消息实锤)。
            v2.21.5+ 带「重新发送 / 删除」按钮(owner 2026-09-06:网络不好时点一下就重发,
            含图片附件)——载荷留在 store 的 pendingSends 里,同一气泡原地重发。 */}
        {m.failed && (
          <div className="flex items-center gap-2 pr-1 text-[11px] font-medium text-error">
            <span>⚠️ {t("未送达")}</span>
            <button
              type="button"
              className="rounded-md border border-error/40 px-2 py-0.5 text-error hover:bg-error/10 active:bg-error/15"
              onClick={(e) => {
                e.stopPropagation();
                void store.retrySend(m.id);
              }}
            >
              ↻ {t("重新发送")}
            </button>
            <button
              type="button"
              className="px-1 text-base-content/40 hover:text-base-content/70"
              onClick={(e) => {
                e.stopPropagation();
                store.discardFailed(m.id);
              }}
            >
              {t("删除")}
            </button>
          </div>
        )}
        {showTs && m.ts && (
          <div className="pr-1 font-mono text-[10px] tabular-nums opacity-40">{fmtTs(m.ts)}</div>
        )}
      </div>
    );
  }

  // assistant
  const streamingLast = streaming && isLast;
  const liveEmpty = streamingLast && awaiting && !m.content && !m.segments?.length;
  const hasSegs = !!m.segments?.length;
  return (
    <div className={`${m.id.startsWith("h") ? "" : "chat-msg-in"} mb-[22px] w-full`}>
      {/* 点 ✦ Claude 头显示/隐藏本条消息时间（秒级）。复制整条走正文段的长按菜单 */}
      <div
        className="cursor-pointer"
        onClick={() => {
          if (hasLiveSelection()) return;
          setShowTs((v) => !v);
        }}
      >
        <ClaudeHeader pulsing={liveEmpty} />
      </div>
      {showTs && m.ts && (
        <div className="-mt-1.5 mb-1.5 font-mono text-[10px] tabular-nums opacity-40">
          {fmtTs(m.ts)}
        </div>
      )}
      <div>
        {/* 有 segments（交错序）时工具在段内渲染；旧快照回退整块工具卡 */}
        {!hasSegs && !!m.toolCalls?.length && (
          <ToolCallsBlock tools={m.toolCalls} streamingLast={streamingLast} />
        )}
        <AssistantBody m={m} liveEmpty={liveEmpty} streamingLast={streamingLast} />
      </div>
      {/* agent 出站附件(reply files):图片内联、文件 chip,与 user 气泡同一渲染 */}
      {!!m.attachments?.length && (
        <div className="mt-2">
          <AttachmentStrip items={m.attachments} />
        </div>
      )}
      {!!m.replyComponents?.length && <ReplyComponents m={m} />}
      {/* 直播回合三态标记(owner 2026-07-14:同构格式,绿完成/黄打断/红出错)
          ——小字行跟着本回合气泡走;历史消息不渲染完成(本来就都完成了)。 */}
      {!streamingLast && (m.turnError || m.turnInterrupted || m.turnDone || m.turnBgPending) && (
        <TurnMark
          kind={m.turnError ? "error" : m.turnInterrupted ? "interrupted" : m.turnBgPending ? "bg" : "done"}
          ms={m.turnMs}
          animate={!m.id.startsWith("h")}
        />
      )}
    </div>
  );
});

export function MessageList() {
  const t = useT();
  const messages = useChatStore((s) => s.state.messages);
  const awaiting = useChatStore((s) => s.state.awaitingChunk);
  const selfSendSeq = useChatStore((s) => s.state.selfSendSeq);
  const streaming = useChatStore((s) => s.state.streaming);
  const replying = useChatStore((s) => s.state.replying);
  const compacting = useChatStore((s) => s.state.compacting);
  const loadingHistory = useChatStore((s) => s.state.loadingHistory);
  const historyHasMore = useChatStore((s) => s.state.historyHasMore);
  const loadingOlder = useChatStore((s) => s.state.loadingOlder);
  const historyNewerHasMore = useChatStore((s) => s.state.historyNewerHasMore);
  const loadingNewer = useChatStore((s) => s.state.loadingNewer);
  const historyError = useChatStore((s) => s.state.historyError);
  const active = useChatStore((s) => s.state.activeAgent);
  const store = useChatStoreApi();
  const pendingPermission = useChatStore((s) => s.state.pendingPermission);
  const pendingAsk = useChatStore((s) => s.state.pendingAsk);
  const bgTaskCount = useChatStore((s) => s.state.bgTasks.length);
  const browsing = useChatStore((s) => s.state.browsing);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  /* v2.24+ 回到底部按钮（owner 2026-09-21：「不要刷出一个新消息就自动回到底部，
     加一个回到底部的按钮，跟 Telegram 一样」）。
     - atBottom：只在布尔翻转时 setState，滚动期间不制造额外渲染；
     - unread：离底期间尾部新增的条数（流式长大同一个气泡不计数——id 没变）。
     两者都另配 ref，供 [active] 那个只建一次的 scroll/RO effect 读取当前值。 */
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [unread, setUnread] = useState(0);
  const unreadRef = useRef(0);
  const tailIdRef = useRef<string | null>(null);
  const setAtBottomBoth = (v: boolean) => {
    if (atBottomRef.current === v) return;
    atBottomRef.current = v;
    setAtBottom(v);
  };
  const clearUnread = () => {
    if (unreadRef.current === 0) return;
    unreadRef.current = 0;
    setUnread(0);
  };
  const goBottom = () => {
    followRef.current = true;
    clearUnread();
    setAtBottomBoth(true);
    const el = scrollerRef.current;
    if (!el) return;
    // 离底很远时 smooth 要缓动好几秒（还会被中途的 resize 打断）——直接跳。
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > 4000;
    el.scrollTo({ top: el.scrollHeight, behavior: far ? "auto" : "smooth" });
  };
  // 触摸期吸底冻结(2026-09-07 真机 [tap-lost] ×2 + WebKit 源码 WebPageCocoa.mm
  // commitPotentialTap):iOS 合成 click 分两步——按下时记下点位的响应节点,抬手后
  // 在同一点重新命中测试,节点不同就 commitPotentialTapFailed,click 根本不派发。
  // 流式期间 ResizeObserver 逐帧 scrollTop=scrollHeight 推着内容走,手指按住的
  // 工具行在抬手前已经挪位 → 「点了没反应」。手指在屏幕上 + 抬起后 TOUCH_HOLD_MS
  // 内不吸底(值 = Infinity 表示仍按着),抬手后由 releaseTouchHold 补一次;
  // follow 语义(上滑退出吸底)不变。snapRef 由 RO effect 填,吸底位移不算用户上滑。
  const touchHoldRef = useRef(0);
  const snapRef = useRef<(() => void) | null>(null);
  /** 收键盘(见容器 JSX 注释):只在滚动意图与点击完成后调,绝不在 touchstart。 */
  const blurComposerIfFocused = () => {
    const ae = document.activeElement;
    if (ae instanceof HTMLElement && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT")) ae.blur();
  };
  const releaseTouchHold = (e: { touches: { length: number } }) => {
    if (e.touches.length) return; // 还有手指没抬
    touchHoldRef.current = Date.now() + TOUCH_HOLD_MS;
    window.setTimeout(() => {
      if (Date.now() < touchHoldRef.current) return; // 期间又按下了
      if (followRef.current && !isSelectMode()) snapRef.current?.();
    }, TOUCH_HOLD_MS + 20);
  };
  /** 搜索跳转的命中气泡短暂高亮(id;动画一遍后清)。 */
  const [flashId, setFlashId] = useState<string | null>(null);
  /** 行内代码点击复制的浮标(tap 点视口坐标;portal 到 body——移动端会话页在
   *  transform 横滑容器里,容器内 fixed 会定位到屏幕外,页面规矩 5b)。 */
  const [copiedTip, setCopiedTip] = useState<{ x: number; y: number; id: number } | null>(null);
  /** 已定位过的跳转锚(sessionId:seq)——窗口数据到位只定位一次,翻页不重跳。 */
  const jumpDoneRef = useRef("");
  // 窗口化初始渲染：打开会话只挂最近 30 个气泡（历史一次挂几十个气泡+几百张
  // 工具卡，手机上进页那一下明显卡），「显示更早」按需展开。extra 按会话重置。
  const [extraVisible, setExtraVisible] = useState(0);
  const prevScrollHeightRef = useRef<number | null>(null);

  /* 滚动方案（抄 claude-os thread.tsx 的两层结构，坑都踩过了别改回去）：
     ① 只在「消息条数/卡片」变化时 smooth 滚底——deps 用 messages.length 而非 messages：
        流式 chunk 每次都替换数组但条数不变，若拿整个数组做 dep，effect 会以 ~百ms 级
        频率重启 smooth 滚动，每次都在缓动起步段就被下一次打断 → 永远停在顶部。
     ② 内容「长高」用 ResizeObserver 吸底跟随（instant，不可打断）——历史加载后 Domd
        富文本是异步渲染的（实测点开 1.4s 时才 614px、2.4s 长到 18711px），流式增量同理；
        follow 语义：用户上翻离底 >90px 就不打扰，回到底部附近恢复吸底。
     ③ 一律 scrollTo/scrollTop 操作本容器，不用 scrollIntoView——它会滚动「所有可滚
        祖先、双轴」，包括 overflow:hidden 的应用壳根：移动端横滑动画中历史恰好落地时，
        根被塞进 scrollLeft，残留量叠在 translate -100% 上 → 会话页「弹过头」渲染不满
        视窗（owner 真机截图 2026-07-11）。 */
  useEffect(() => {
    followRef.current = true; // 切会话恢复吸底
    setExtraVisible(0); // 渲染窗口回到「最近 30 条」
    exitSelectMode(); // 别把冻住的滚动带到下一个会话
    setAtBottomBoth(true);
    clearUnread();
    tailIdRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /* 历史现场定位(搜索跳转):窗口数据到位后滚到命中气泡并高亮一闪。
     命中 seq 可能落在合并气泡内部——取 seq ≤ anchor 的最后一个气泡。
     Domd 富文本异步长高会把锚点顶跑,700ms 后二次校正(不再闪)。 */
  useLayoutEffect(() => {
    if (!browsing) {
      jumpDoneRef.current = "";
      return;
    }
    const key = `${browsing.sessionId}:${browsing.anchorSeq}`;
    if (jumpDoneRef.current === key || loadingHistory || !messages.length) return;
    jumpDoneRef.current = key;
    followRef.current = false; // 历史现场绝不吸底
    let target: string | null = null;
    for (const m of messages) {
      if (!m.id.startsWith("h")) continue;
      const n = Number(m.id.slice(1));
      if (Number.isFinite(n) && n <= browsing.anchorSeq) target = m.id;
    }
    if (!target) return;
    const position = () => {
      const el = scrollerRef.current;
      const node = el?.querySelector(`[data-mid="${target}"]`) as HTMLElement | null;
      if (el && node) {
        el.scrollTop =
          node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 96;
      }
    };
    position();
    // 计时器故意不随依赖清理:messages 每次变化都会触发 cleanup,一清高亮就
    // 永远停在半途;都是一次性小动作,晚触发无害(React 对已卸载组件 no-op)
    setTimeout(() => setFlashId(target), 0);
    setTimeout(position, 700);
    setTimeout(() => setFlashId(null), 2_200);
  }, [browsing, loadingHistory, messages]);

  /* 退出历史现场 → 恢复吸底并落到最新尾部。 */
  const prevBrowsingRef = useRef(false);
  useEffect(() => {
    const was = prevBrowsingRef.current;
    prevBrowsingRef.current = !!browsing;
    if (was && !browsing) {
      followRef.current = true;
      const el = scrollerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [browsing]);

  // 「显示更早」展开后保持视口锚定：内容在上方插入，滚动位置按增量补偿。
  // deps 含 messages.length:loadOlder 服务端分页是异步 prepend(iOS Safari 无
  // overflow-anchor,不补偿视口会被顶飞),prevScrollHeightRef 非空才动、动完即清,
  // 尾部 append 场景 ref 为 null 不受影响。
  useLayoutEffect(() => {
    if (prevScrollHeightRef.current === null) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop += el.scrollHeight - prevScrollHeightRef.current;
    prevScrollHeightRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extraVisible, messages.length]);

  useEffect(() => {
    // 用户上翻阅读时不强拉回底（follow=false）——之前每来一条新消息/卡片都
    // smooth 滚底并强置 follow=true，流式期间用户「滑不动」的元凶之一
    // （2026-07-13 真机）。
    // ⚠ 2026-09-21 owner 再报「刷出一条新消息就被拉回底部，没法看历史」：原来
    //   这里的豁免写的是 `|| awaiting`，而 awaitingChunk **不只**在自己发送时为真
    //   ——syncDelta / loadMessages 的 7 秒对账里「回合进行中但尾部没有直播气泡」
    //   也会把它置真，于是长回合中每一次对账都把人强拉回底部，且顺手把 follow
    //   重置成 true，上翻直接失效。现在判据只认 follow；「自己发送要滚到底」改由
    //   下面的 selfSendSeq effect 单独负责（Telegram 也是这个语义）。
    if (isSelectMode()) return; // 正在选字：滚一下选区就没了
    if (!followRef.current) return;
    if (Date.now() < touchHoldRef.current) return; // 抬手后 releaseTouchHold 补吸底
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length, pendingPermission, pendingAsk, bgTaskCount]);

  /* 自己发送 / 重发 → 无条件回到底部（即便此刻正在上面看历史）。 */
  useEffect(() => {
    if (!selfSendSeq) return;
    goBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfSendSeq]);

  /* 离底期间尾部新增的条数 → 按钮上的角标。
     用「上一次的尾部 id 在新数组里的位置」算增量：流式把同一个气泡越写越长时
     尾部 id 不变 ⇒ 不计数；向上翻页 prepend 也不会误计（尾部 id 仍在末尾）。 */
  useEffect(() => {
    const lastId = messages.length ? messages[messages.length - 1].id : null;
    const prevId = tailIdRef.current;
    tailIdRef.current = lastId;
    if (browsing) return; // 历史现场有自己的「回到最新」
    if (followRef.current || atBottomRef.current) {
      clearUnread();
      return;
    }
    if (!prevId || prevId === lastId) return; // 流式每个 chunk 都进这个 effect，先短路再建 id 数组
    const added = tailAppendedCount(prevId, messages.map((m) => m.id));
    if (added <= 0) return;
    unreadRef.current = Math.min(99, unreadRef.current + added);
    setUnread(unreadRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, browsing]);

  useEffect(() => {
    const el = scrollerRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    // 触摸丢 click 兜底(lib/tap-rescue.ts):回弹 / 减速尾巴 / 吸底期间点工具行也能展开
    const offRescue = installTapRescue(el, { name: "msgs", log: (m) => store.clientLog(m) });
    let lastTop = el.scrollTop;
    const onScroll = () => {
      // 向上滑立即退出吸底（不等离底 >90px）——流式内容持续长高时，90px 缓冲区
      // 内的每次 resize 吸底都会把刚起步的上滑手势拽回去，手感就是「滑不动」
      const up = el.scrollTop < lastTop;
      lastTop = el.scrollTop;
      const nearBottom = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
      followRef.current = !up && nearBottom;
      // 按钮的可见性按「离底」判，与 follow 解耦：向上滑一下就退出吸底，但只有
      // 真的离开底部 90px 才值得弹按钮，否则贴着底微调也会闪一下。
      setAtBottomBoth(nearBottom);
      if (nearBottom) clearUnread();
    };
    el.addEventListener("scroll", onScroll);
    const snap = () => {
      el.scrollTop = el.scrollHeight;
      lastTop = el.scrollTop; // 吸底自身的位移不算「用户上滑」
    };
    snapRef.current = snap;
    const ro = new ResizeObserver(() => {
      if (isSelectMode()) return; // 同上：选字期间新内容长高也不吸底
      if (Date.now() < touchHoldRef.current) return; // 手指在屏幕上:见 touchHoldRef 注释
      if (followRef.current) snap();
    });
    ro.observe(inner);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      snapRef.current = null;
      offRescue();
    };
  }, [active]);
  // 分享模式（hooks 必须在下面的早退之前）：范围规则见 share-mode.ts
  const share = useShare();
  // 只在分享模式开着时算 id 列表——关着时长对话流式每拍白算一遍（peer review #43）
  const order = useMemo(() => (share.on ? messages.map((x) => x.id) : NO_ORDER), [messages, share.on]);
  const shareRange = share.on ? selRange(share.sel, order) : null;

  if (!active) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 opacity-50">
        <p className="text-lg">{t("选择左侧一个会话开始")}</p>
        <p className="text-sm">{t("消息经 Bridge 投递到对应 Claude Code 会话")}</p>
      </div>
    );
  }

  // 首个 chunk 到达前（last 还是用户气泡）单独渲染一条 ✦ Claude + 思考点；
  // 若最后一条已是流式助手，思考点由该消息内部（liveEmpty）渲染，此处不重复。
  const last = messages[messages.length - 1];
  const standaloneThinking =
    awaiting && !(last && last.role === "assistant" && last.streamed);

  // 渲染窗口 = 尾部 30+extra 条（visible 是 messages 的后缀 → 全列表最后一条
  // 就是 visible 最后一条，isLast 语义不变）
  const windowSize = 30 + extraVisible;
  const visible = messages.length > windowSize ? messages.slice(-windowSize) : messages;
  const offset = messages.length - visible.length;
  const hiddenCount = offset;
  // 形态②的复述：历史按 jsonl 记录切段，agent 复述那份会独立成一条纯 text 消息。
  // 整个列表扫一遍（不是 visible——回合边界可能在窗口之外），拿到该藏的 id。
  const echoIds = replyEchoMessageIds(messages);

  return (
    // touch-pan-y + overscroll-contain：到边界时滚动链穿透到不可滚的应用壳被
    // 橡皮筋吃手势（同 sidebar 修法）。09-07 曾改 none 关掉回弹(甩到底后按住时列表
    // 停在越过底部 29px 的橡皮筋位置,松手回弹,内容在 WebKit 提交 tap 前挪走 → click
    // 丢弃),09-11 owner「没回弹总以为是卡住了」→ 回弹恢复,丢 click 改由
    // installTapRescue 兜底(抬手 450ms 无真 click 就向按下时的目标派发合成 click)。收键盘：iOS 在 transform 祖先下滚动聚焦中的
    // 输入框，光标会脱离输入框画在消息区里（2026-07-13 截图）——触摸消息区即 blur，
    // 与主流聊天 App 行为一致。⚠ 不能在 touchstart 收（2026-09-07 真机 [tap-lost]：
    // 键盘开着时 6ms 轻触消息区，元素没动、点位没变，却没有 click——按下瞬间 blur
    // 让键盘开始收起，WebKit 待提交的 tap 随之作废）。改为滚动意图(touchmove)时收、
    // 点击完成(click)后收：滚动场景光标 bug 照样被挡，点击场景 click 先派发再收键盘。
    <div
      ref={scrollerRef}
      id="cstra-msgs"
      className="flex-1 touch-pan-y overflow-y-auto overscroll-contain"
      style={{ WebkitOverflowScrolling: "touch" }}
      onTouchStart={() => {
        touchHoldRef.current = Infinity; // 手指按着:吸底冻结(见 touchHoldRef 注释)
      }}
      onTouchMove={blurComposerIfFocused}
      onTouchEnd={releaseTouchHold}
      onTouchCancel={releaseTouchHold}
      onClick={(e) => {
        blurComposerIfFocused(); // 点击已派发,现在收键盘不影响这次点击
        // 行内代码点击即复制(owner 2026-07-28「小 code block 也要能复制」)。
        // 大代码块(pre 内)有 do-md 自带的复制按钮,不抢;点在链接上不抢;
        // 用户正在选字(划选后松手也触发 click)不抢。
        if (isSelectMode()) return; // 选字期间点哪儿都是在调选区,不抢
        const el = (e.target as HTMLElement).closest?.("code");
        if (!el || el.closest("pre") || (e.target as HTMLElement).closest("a")) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        const text = el.textContent || "";
        if (!text.trim()) return;
        const id = Date.now();
        void navigator.clipboard?.writeText(text).then(() => {
          setCopiedTip({ x: e.clientX, y: e.clientY, id });
          setTimeout(() => setCopiedTip((c) => (c && c.id === id ? null : c)), 1200);
        }).catch(() => {
          // tap-rescue 合成的 click 没有用户激活,iOS 直接拒写剪贴板(2026-09-14 client.log
          // unhandledrejection 实锤)。不提示「已复制」、也别让 rejection 冒到全局;用户再点一次即可。
        });
      }}
    >
      {/* 横向留白对齐 claude-os thread（px-7=28px + 居中限宽），手机端稍收到 24px，
          原 px-4(16px) 太满不透气（owner 反馈）。滚动条落在最外层边缘更干净。
          v2.21.1+ 桌面放宽(owner 2026-08-29「PC 明明可以用更宽的地方」):lg 起
          92% 宽、1600px 封顶——宽屏不再中间一窄条;与 composer 的限宽保持一致。 */}
      <div className="mx-auto flex w-full max-w-3xl flex-col px-6 pb-4 pt-6 sm:px-7 lg:max-w-[min(92%,1600px)]">
        {loadingHistory && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm opacity-40">
            <span className="loading loading-spinner loading-sm" />
            {t("加载历史消息…")}
          </div>
        )}
        {!loadingHistory && messages.length === 0 && historyError && (
          <div className="flex flex-col items-center gap-2 py-8 text-sm opacity-60">
            <span>{t("历史加载失败")}</span>
            <button className="btn btn-sm" onClick={() => store.reloadHistory()}>
              {t("重试")}
            </button>
          </div>
        )}
        {!loadingHistory && messages.length === 0 && !historyError && (
          <div className="py-8 text-center text-sm opacity-40">
            {getLang() === "en" ? `Send the first message to ${active}` : `向 ${active} 发送第一条消息`}
          </div>
        )}
        {hiddenCount > 0 && (
          <button
            className="btn btn-ghost btn-xs mx-auto mb-4 text-base-content/50"
            onClick={() => {
              prevScrollHeightRef.current = scrollerRef.current?.scrollHeight ?? null;
              setExtraVisible((n) => n + 100);
            }}
          >
            {getLang() === "en" ? `Show ${hiddenCount} earlier` : `显示更早的 ${hiddenCount} 条`}
          </button>
        )}
        {/* 本地窗口耗尽 → 继续向服务端翻更早的一页(同 session,seq 向前)。
            prepend 后滚动锚定复用同一套 scrollHeight 增量补偿。 */}
        {hiddenCount === 0 && historyHasMore && (
          <button
            className="btn btn-ghost btn-xs mx-auto mb-4 text-base-content/50"
            disabled={loadingOlder}
            onClick={() => {
              prevScrollHeightRef.current = scrollerRef.current?.scrollHeight ?? null;
              setExtraVisible((n) => n + 300);
              void store.loadOlder();
            }}
          >
            {loadingOlder && <span className="loading loading-spinner loading-xs" />}
            {t("加载更早的消息…")}
          </button>
        )}
        {visible.map((m, i) => (
          // data-mid 包装层:搜索跳转按它定位;命中气泡加一闪动画。普通渲染
          // 是零成本透明块(块级流内,不改 flex-col 布局)。分享模式下加 checkbox
          // (本人右、其余左,share-ui.tsx)与选中底色,范围规则见 share-mode.ts。
          <div key={m.id} data-mid={m.id} className={shareRowClass(m, flashId === m.id, share.on, inRange(shareRange, offset + i))}>
            {share.on && (
              <ShareCheck id={m.id} order={order} checked={inRange(shareRange, offset + i)} side={m.role === "user" && !m.from ? "right" : "left"} />
            )}
            {share.on && <ShareMask id={m.id} order={order} />}
            {echoIds.has(m.id) ? null : (
              <Message
                m={m}
                streaming={streaming}
                isLast={i === visible.length - 1}
                awaiting={awaiting}
              />
            )}
          </div>
        ))}
        {/* 历史现场向下翻页(2026-09-08):命中窗口只到命中后 ~25 条,继续往后看 */}
        {browsing && historyNewerHasMore && (
          <button
            className="btn btn-ghost btn-xs mx-auto mb-4 text-base-content/50"
            disabled={loadingNewer}
            onClick={() => void store.loadNewer()}
          >
            {loadingNewer && <span className="loading loading-spinner loading-xs" />}
            {t("加载更晚的消息…")}
          </button>
        )}
        {/* 活跃会话的面板/交互卡不属于历史现场——浏览模式只藏不清,回来原样恢复 */}
        {!browsing && <CcTaskPanel />}
        {!browsing && <BgTaskPanel />}
        {!browsing && pendingPermission && <PermissionCard p={pendingPermission} />}
        {!browsing && pendingAsk && <AskQuestionCard a={pendingAsk} />}
        {standaloneThinking && !browsing && (
          <div className="chat-msg-in mb-[22px] w-full">
            <ClaudeHeader pulsing />
            {compacting ? <CompactingLine /> : replying ? <ReplyingLine /> : <ThinkingDots />}
          </div>
        )}
        {/* v2.20.2+「正在回复…」:watcher 见到 reply 工具调用(owner:长任务里
            想看到「快回我了」)。有流式气泡时挂在列表尾,无气泡时上面已并入思考区
            v2.21.1+「仍在工作…」(owner 2026-09-02:「调完 reply 就显示完成」):
            reply 到达后 awaiting=false 且气泡有内容 → liveEmpty 与
            standaloneThinking 双双 false,所有进行中指示消失,但 streaming 仍
            true(agent 在继续干活)——实测事件流佐证:chat_message(out) 之后
            还有 tool_start,全程无 done 事件。回合真正结束(done)才收场。 */}
        {!standaloneThinking && streaming && !browsing && (
          <div className="chat-msg-in mb-[22px] w-full">
            {compacting ? <CompactingLine /> : replying ? <ReplyingLine /> : <WorkingLine />}
          </div>
        )}
        {copiedTip &&
          createPortal(
            <div
              className="pointer-events-none fixed z-[999] rounded-full bg-neutral px-2.5 py-1 text-xs text-neutral-content shadow-md"
              style={{ left: copiedTip.x, top: Math.max(8, copiedTip.y - 40), transform: "translateX(-50%)" }}
            >
              ✓ {t("已复制")}
            </div>,
            document.body
          )}
        <BubbleMenu />
        <SelectModeBar />
        {/* v2.24+ 回到底部（非历史现场）：负 margin 让它浮在内容上，不占列表高度。 */}
        {!browsing && !atBottom && (
          <div className="pointer-events-none sticky bottom-3 z-10 -mb-8 flex justify-end">
            <button
              className="btn btn-circle btn-sm pointer-events-auto relative border border-base-300 bg-base-100/95 shadow-md backdrop-blur"
              aria-label={t("回到底部")}
              title={t("回到底部")}
              onClick={goBottom}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M19 12l-7 7-7-7" />
              </svg>
              {unread > 0 && (
                <span className="absolute -right-1 -top-1 min-w-[18px] rounded-full bg-primary px-1 text-[11px] font-medium leading-[18px] text-primary-content">
                  {unread > 98 ? "99+" : unread}
                </span>
              )}
            </button>
          </div>
        )}
        {browsing && (
          <div className="sticky bottom-2 z-10 mt-4 flex justify-center">
            <button
              className="btn btn-sm gap-1.5 rounded-full border border-base-300 bg-base-100/95 shadow-md backdrop-blur"
              onClick={() => void store.returnToLatest()}
            >
              <span className="opacity-60">📍 {t("正在看历史")}</span>
              <span className="font-medium">↓ {t("回到最新")}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
