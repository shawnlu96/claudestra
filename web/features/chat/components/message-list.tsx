"use client";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStore, useChatStoreApi } from "../chat-store";
import type { ChatMessage, ChatAttachmentView, ToolCallView, AssistantSegment } from "../type";
import { Domd } from "@/components/domd";
import { PermissionCard } from "./permission-card";
import { AskQuestionCard } from "./ask-question-card";
import { ReplyComponents } from "./reply-components";
import { BgTaskPanel } from "./bg-task-panel";
import { CcTaskPanel } from "./cc-task-panel";
import { highlightCode, langForPath } from "../highlight";
import { useT, getLang } from "@/lib/i18n";
import { fmtTs } from "../fmt-time";
import { BubbleMenu, SelectModeBar, useBubbleMenuTrigger } from "./bubble-menu";
import { exitSelectMode, hasLiveSelection, isSelectMode } from "../select-mode";

/* 复刻 Claude OS features/chat 的对话观感：assistant 全宽 + ✦ Claude 头，
   user 右对齐圆角矩形，工具调用 active（转圈）/ history（可展开）两态。
   配色走 daisyUI token 跟随明暗主题：✦ 头用 accent，工具活动用 info。 */

const TOOL_ICONS: Record<string, string> = {
  Read: "📄",
  Write: "📝",
  Edit: "✏️",
  Bash: "💻",
  Grep: "🔍",
  Glob: "📂",
  Task: "🤖",
  Agent: "🤖",
  TodoWrite: "📋",
  Skill: "⚡",
  WebFetch: "🌐",
  WebSearch: "🌐",
};
const toolIcon = (n: string) => TOOL_ICONS[n] || "🔧";

/** formatTool 的 Bash 摘要用 ||command|| 包裹命令，展示时去掉这对标记。 */
function cleanSummary(s: string): string {
  return s.replace(/\|\|/g, " ").replace(/\s+/g, " ").trim();
}

/** 点击切换的时间小签（消息气泡 / 工具行共用）。 */
function TsBadge({ ts, shown }: { ts?: string; shown: boolean }) {
  if (!shown || !ts) return null;
  return (
    <span className="ml-1.5 shrink-0 font-mono text-[10px] tabular-nums opacity-40">
      {fmtTs(ts)}
    </span>
  );
}

/** 流式期间的工具行：紧凑单行，最后一个转圈。点击展开完整入参详情 + 秒级时间。
 *  带边框卡片样式与定稿态/bg 任务卡统一——无边框会和正文混在一起
 *  （2026-07-13 owner 拍板）。
 *  memo：immer 结构共享下旧 tool 对象引用稳定，流式长回合几百张工具卡
 *  只有最新一张需要重渲染（2026-07-13 性能刀）。 */
/** 工具卡三态配色(owner 2026-07-15):运行中蓝 / 完成绿 / 失败红。 */
const TOOL_TONE = {
  running: { box: "border-info/25 bg-info/[0.06]", name: "text-info" },
  done: { box: "border-success/30 bg-success/[0.06]", name: "text-success" },
  error: { box: "border-error/30 bg-error/[0.06]", name: "text-error" },
} as const;

const ActiveToolRow = memo(function ActiveToolRow({ tool, active }: { tool: ToolCallView; active: boolean }) {
  const summary = cleanSummary(tool.summary);
  const [open, setOpen] = useState(false);
  const err = tool.state === "error";
  const tone = TOOL_TONE[tool.state] ?? TOOL_TONE.running;
  return (
    <QuoteSwipe quote={`${tool.name} ${summary}`}>
    <div className={`tool-in rounded-lg border ${tone.box}`}>
      <div
        className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 font-mono text-xs"
        onClick={() => setOpen((v) => !v)}
      >
        {active && tool.state === "running" ? (
          <span className="loading loading-spinner loading-xs text-info" />
        ) : err ? (
          <span className="shrink-0">❌</span>
        ) : (
          <span className="shrink-0 opacity-60">{toolIcon(tool.name)}</span>
        )}
        <span className={`font-semibold ${tone.name}`}>{tool.name}</span>
        {summary && (
          <span className="truncate text-base-content/50 max-w-[60vw] lg:max-w-[40vw]">
            {summary}
          </span>
        )}
        <TsBadge ts={tool.ts} shown={open} />
      </div>
      {open && (
        <div className="px-2.5 pb-2 pt-0.5">
          {tool.detail ? (
            <ToolDetailView name={tool.name} detail={tool.detail} />
          ) : (
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[11px] text-base-content/50">
              {summary || tool.name}
            </pre>
          )}
        </div>
      )}
    </div>
    </QuoteSwipe>
  );
});

/** 历史 / 定稿后的工具行：可展开看完整入参详情（detail，老数据回退摘要）。
 *  带边框卡片样式,与流式态/bg 任务卡统一（2026-07-13 owner 拍板:无边框
 *  和正文混在一起;此前「去边框统一」方向反了）。
 *  详情子树**展开才渲染**（2026-07-15 滑动卡顿刀）:非受控 details 收起时
 *  DOM 依然全量存在——几百张卡 × 高亮后数百 span = 数万节点压垮 iOS 滚动
 *  合成;高亮计算也在首渲全量执行。 */
const HistoryToolRow = memo(function HistoryToolRow({ tool }: { tool: ToolCallView }) {
  const summary = cleanSummary(tool.summary);
  const err = tool.state === "error";
  const [open, setOpen] = useState(false);
  const tone = TOOL_TONE[tool.state] ?? TOOL_TONE.done;
  return (
    <QuoteSwipe quote={`${tool.name} ${summary}`}>
    <div className={`rounded-lg border ${tone.box}`}>
      <div
        className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 font-mono text-xs"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="shrink-0 opacity-70">
          {err ? "❌" : toolIcon(tool.name)}
        </span>
        <span className={`font-semibold ${tone.name}`}>{tool.name}</span>
        {summary && (
          <span className="truncate text-base-content/50 max-w-[60vw] lg:max-w-[40vw]">
            {summary.slice(0, 80)}
          </span>
        )}
        <span className={`ml-auto shrink-0 opacity-30 transition-transform ${open ? "rotate-90" : ""}`}>
          ›
        </span>
      </div>
      {open && (
        <div className="px-2.5 pb-2 pt-0.5">
          {tool.ts && (
            <div className="pb-1 font-mono text-[10px] tabular-nums opacity-40">
              🕐 {fmtTs(tool.ts)}
            </div>
          )}
          {tool.detail ? (
            <ToolDetailView name={tool.name} detail={tool.detail} />
          ) : (
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[11px] text-base-content/50">
              {summary || tool.name}
            </pre>
          )}
        </div>
      )}
    </div>
    </QuoteSwipe>
  );
});

/** diff 风格代码块:浅底色 + 左边框标识增删(红=删 / 绿=增),内容语法高亮。
 *  不逐行加 +/- 前缀——高亮 HTML 拆行会截断跨行 token(字符串/注释)。 */
function DiffBlock({ text, kind, lang }: { text: string; kind: "del" | "add"; lang?: string }) {
  const tone = kind === "del" ? "border-error bg-error/10" : "border-success bg-success/10";
  const body = text.replace(/\n+$/, "");
  return (
    <pre
      className={`whitespace-pre-wrap break-all rounded border-l-2 px-1.5 py-1 ${tone}`}
      dangerouslySetInnerHTML={{ __html: highlightCode(body, lang) }}
    />
  );
}

/** 语法高亮代码块（无增删语义的普通详情）。 */
function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  return (
    <pre
      className="whitespace-pre-wrap break-all rounded bg-base-300/40 px-1.5 py-1"
      dangerouslySetInnerHTML={{ __html: highlightCode(text.replace(/\n+$/, ""), lang) }}
    />
  );
}

/** 工具详情渲染:Edit → 红删绿增 diff,Write → 全绿新增,Bash → 命令高亮,
 *  JSON 入参 → json 高亮;全部带语法高亮(按 file_path 扩展名推语言)。
 *  detail 是后端 formatToolDetail 拼的字符串,按自家分隔符解析;截断/格式
 *  不符一律走兜底(owner 2026-07-14:「绿色增加红色删减 + 语法高亮」)。 */
function ToolDetailView({ name, detail }: { name: string; detail: string }) {
  if (name === "Edit") {
    const m = detail.match(/^([\s\S]*?)─── old ───\n([\s\S]*?)\n─── new ───\n([\s\S]*)$/);
    if (m) {
      const lang = langForPath(m[1]);
      return (
        <div className="max-h-72 space-y-1 overflow-y-auto font-mono text-[11px]">
          <div className="break-all text-base-content/50">{m[1].trim()}</div>
          <DiffBlock text={m[2]} kind="del" lang={lang} />
          <DiffBlock text={m[3]} kind="add" lang={lang} />
        </div>
      );
    }
  }
  if (name === "Write") {
    const idx = detail.indexOf("\n───\n");
    if (idx >= 0) {
      const head = detail.slice(0, idx).trim();
      return (
        <div className="max-h-72 space-y-1 overflow-y-auto font-mono text-[11px]">
          <div className="break-all text-base-content/50">{head}</div>
          <DiffBlock text={detail.slice(idx + 5)} kind="add" lang={langForPath(head)} />
        </div>
      );
    }
  }
  if (name === "Bash") {
    // description ─── command 或纯 command
    const idx = detail.indexOf("\n───\n");
    return (
      <div className="max-h-72 space-y-1 overflow-y-auto font-mono text-[11px]">
        {idx >= 0 && <div className="break-all text-base-content/50">{detail.slice(0, idx).trim()}</div>}
        <CodeBlock text={idx >= 0 ? detail.slice(idx + 5) : detail} lang="bash" />
      </div>
    );
  }
  // MCP 工具等:入参 pretty JSON → json 高亮;其余纯文本
  const looksJson = /^[{[]/.test(detail.trimStart());
  return (
    <div className="max-h-64 overflow-y-auto font-mono text-[11px]">
      <CodeBlock text={detail} lang={looksJson ? "json" : undefined} />
    </div>
  );
}

function ToolCallsBlock({
  tools,
  streamingLast,
}: {
  tools: ToolCallView[];
  streamingLast: boolean;
}) {
  return (
    <div className="mb-2 space-y-1">
      {tools.map((t, i) =>
        streamingLast ? (
          <ActiveToolRow key={i} tool={t} active={i === tools.length - 1} />
        ) : (
          <HistoryToolRow key={i} tool={t} />
        )
      )}
    </div>
  );
}

/** 流式「思考中」三点。 */
function ThinkingDots() {
  return (
    <span className="inline-flex gap-1 py-1.5">
      {[0, 0.2, 0.4].map((d) => (
        <span
          key={d}
          className="chat-dot size-1.5 rounded-full bg-base-content/45"
          style={{ animationDelay: `${d}s` }}
        />
      ))}
    </span>
  );
}

/** ✦ Claude 头（assistant 消息 / 独立思考态共用）。头像/名称可在设置里
 *  自定义(owner 2026-07-14),未设置回落 ✦ + Claude。pulsing = 思考中缓慢
 *  呼吸(owner 2026-07-16 动效)。 */
function ClaudeHeader({ pulsing = false }: { pulsing?: boolean }) {
  const profile = useChatStore((s) => s.state.profile);
  const pulse = pulsing ? "claude-pulse" : "";
  return (
    <div className="mb-[9px] flex items-center gap-2">
      {profile.claudeAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={profile.claudeAvatar} alt="" className={`size-[21px] rounded-md object-cover ${pulse}`} />
      ) : (
        <span className={`flex size-[21px] items-center justify-center rounded-md bg-accent text-[11px] text-white ${pulse}`}>
          ✦
        </span>
      )}
      <span className="text-xs font-semibold text-base-content/60">
        {profile.claudeNickname || "Claude"}
      </span>
    </div>
  );
}

/** 用户气泡里的上传附件回显：图片缩略图 / 文件名 chip。 */
/** 附件文件 chip（非图片 / 图片加载失败的降级）。有 url 可点击下载。 */
function FileChip({ a }: { a: ChatAttachmentView }) {
  const cls =
    "flex max-w-[220px] items-center gap-2 rounded-[12px] border border-base-content/10 bg-base-300 px-3 py-2 text-[12.5px] text-base-content/80";
  return a.url ? (
    <a href={a.url} download={a.name} title={a.name} className={cls}>
      📎 <span className="truncate">{a.name}</span>
    </a>
  ) : (
    <span title={a.name} className={cls}>
      📎 <span className="truncate">{a.name}</span>
    </span>
  );
}

/** 图片附件：内联缩略图,点击全屏预览;加载失败(旧文件被清)降级为文件 chip。 */
function AttachedImage({
  a,
  onPreview,
  imgRef,
}: {
  a: ChatAttachmentView;
  onPreview: () => void;
  imgRef: (el: HTMLImageElement | null) => void;
}) {
  const [err, setErr] = useState(false);
  if (err || !a.url) return <FileChip a={a} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imgRef}
      src={a.url}
      alt={a.name}
      onClick={onPreview}
      onError={() => setErr(true)}
      className="max-h-52 max-w-[220px] cursor-zoom-in rounded-[12px] border border-base-content/10 object-cover"
    />
  );
}

/** 把当前图片分享/保存：iOS 上走系统分享面板(可存相册),不支持时新开原图。 */
async function shareImage(url: string, name: string): Promise<void> {
  try {
    const blob = await fetch(url).then((r) => r.blob());
    const file = new File([blob], name || "image.png", { type: blob.type || "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch {
    /* 用户取消分享面板也会 throw,静默 */
  }
  try {
    window.open(url, "_blank");
  } catch {
    /* 忽略 */
  }
}

/** 回合结束标记:居中分隔线样式(owner 2026-07-14:「像中段一样居中、横线
 *  隔开、带颜色和 tick 图标」),三态同构:绿=完成 / 黄=已打断 / 红=出错。
 *  横线用 currentColor 低透明度,自动跟随态色。 */
function TurnMark({ kind, ms, animate = true }: { kind: "done" | "interrupted" | "error"; ms?: number; animate?: boolean }) {
  const t = useT();
  const conf = {
    done: { cls: "text-success", label: "完成", icon: <path d="M8.5 12.5l2.5 2.5 5-5.5" /> },
    interrupted: { cls: "text-warning", label: "已打断", icon: <path d="M5.6 5.6l12.8 12.8" /> },
    error: { cls: "text-error", label: "出错", icon: <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" /> },
  }[kind];
  return (
    <div className={`${animate ? "chat-msg-in" : ""} my-3.5 flex select-none items-center gap-3 ${conf.cls}`}>
      <span className="h-px flex-1 bg-current opacity-20" />
      <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          {conf.icon}
        </svg>
        {t(conf.label)}
        {kind === "done" && typeof ms === "number" && (
          <span className="font-mono text-[10.5px] font-normal tabular-nums opacity-70">
            · {(ms / 1000).toFixed(ms >= 60_000 ? 0 : 1)}s
          </span>
        )}
      </span>
      <span className="h-px flex-1 bg-current opacity-20" />
    </div>
  );
}

function AttachmentStrip({ items }: { items: ChatAttachmentView[] }) {
  const t = useT();
  const images = items.filter((a) => a.kind === "image" && a.url);
  const imgEls = useRef(new Map<string, HTMLImageElement>());

  // PhotoSwipe(2026-07-14 owner 对上一个库的裁决:「太垃圾了」×3):相册级
  // 手势——捏合/双击缩放、拖拽平移、下拉关闭。需要原图尺寸 → 从已加载的缩略
  // 图 naturalWidth/Height 取(strip 里的图必然已加载);动态 import 不进首屏。
  const openViewer = async (index: number) => {
    const { default: PhotoSwipe } = await import("photoswipe");
    const pswp = new PhotoSwipe({
      dataSource: images.map((a) => {
        const el = imgEls.current.get(a.url!);
        return {
          src: a.url!,
          width: el?.naturalWidth || 1600,
          height: el?.naturalHeight || 1200,
          alt: a.name,
        };
      }),
      index,
      bgOpacity: 0.95,
      // 单图不显示箭头;移动端本来就靠手势
      arrowPrev: images.length > 1,
      arrowNext: images.length > 1,
      zoom: false, // 隐藏缩放按钮(手势缩放为主,按钮占位)
      pinchToClose: true,
      closeOnVerticalDrag: true,
      // 单击即关(owner 2026-07-14:「单击一下也关闭」)——默认 tap 是切换控制栏、
      // 点图是缩放,手机上关图片只能下拉,不顺手。双击缩放/捏合仍在。
      tapAction: "close",
      imageClickAction: "close",
      bgClickAction: "close",
    });
    // 自定义「保存」按钮:iOS PWA 里 lightbox 的图长按不出系统菜单,
    // Web Share API 的分享面板才有「存储图像」到相册
    pswp.on("uiRegister", () => {
      pswp.ui?.registerElement({
        name: "save-btn",
        order: 8,
        isButton: true,
        tagName: "button",
        html: t("保存"),
        onClick: () => {
          const slide = pswp.currSlide?.data;
          if (slide?.src) void shareImage(slide.src, String(slide.alt || "image.png"));
        },
      });
    });
    pswp.init();
  };

  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
      {items.map((a, i) =>
        a.kind === "image" ? (
          <AttachedImage
            key={i}
            a={a}
            imgRef={(el) => {
              if (el && a.url) imgEls.current.set(a.url, el);
            }}
            onPreview={() => void openViewer(images.indexOf(a))}
          />
        ) : (
          <FileChip key={i} a={a} />
        )
      )}
    </div>
  );
}

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
/**
 * 消息块左滑引用(owner 2026-07-16):文字段/工具卡/回复/user 气泡左滑露出
 * 引用图标,过阈值松手 → composer 出现引用预览,发送时以 Markdown 引用块
 * 前置(web/Discord 都原生渲染)。方向裁决同终端页手势:竖向先动让给滚动。
 * 跟手位移直接写 DOM style(不 setState——流式期间高频 re-render 是性能命门)。
 */
function QuoteSwipe({ quote, className, children }: { quote: string; className?: string; children: React.ReactNode }) {
  const store = useChatStoreApi();
  const ref = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const st = useRef<{ x: number; y: number; drag: boolean; dead: boolean; startDx: number } | null>(null);
  return (
    <div className={`relative ${className ?? ""}`}>
      <span
        ref={iconRef}
        className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-base-content/50"
        style={{ opacity: 0 }}
        aria-hidden
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M9.5 8C7 8 5 10 5 12.7c0 2 1.5 3.6 3.4 3.6 1.7 0 3-1.3 3-3 0-1.6-1.2-2.8-2.8-2.8-.3 0-.6 0-.8.1C8.2 9.6 9 8.9 10 8.5L9.5 8zm7 0C14 8 12 10 12 12.7c0 2 1.5 3.6 3.4 3.6 1.7 0 3-1.3 3-3 0-1.6-1.2-2.8-2.8-2.8-.3 0-.6 0-.8.1.4-1 1.2-1.7 2.2-2.1L16.5 8z" />
        </svg>
      </span>
      <div
        ref={ref}
        onTouchStart={(e) => {
          // 正在选字(选择模式,或页面上已有选区)时整个手势让开:横向一动就 translateX
          // 整块,字跟着跑,选区永远框不准(2026-08-21 owner iPhone 实测)
          if (isSelectMode() || hasLiveSelection()) {
            st.current = null;
            return;
          }
          const t = e.touches[0];
          st.current = t ? { x: t.clientX, y: t.clientY, drag: false, dead: false, startDx: 0 } : null;
        }}
        onTouchMove={(e) => {
          const s = st.current;
          const el = ref.current;
          if (!s || s.dead || !el) return;
          const t = e.touches[0];
          if (!t) return;
          const dx = t.clientX - s.x;
          const dy = Math.abs(t.clientY - s.y);
          if (!s.drag) {
            // 手势中途冒出选区(长按选字)→ 让开,别在人家拖手柄时把块横着拽走
            if (isSelectMode() || hasLiveSelection()) {
              s.dead = true;
              return;
            }
            // 竖向先动 → 手势让给列表滚动;轻微左滑即接管(阈值太高「不跟手」,
            // owner 2026-07-16 打回过一版 14px)
            if (dy > 10 && dy > -dx) {
              s.dead = true;
              return;
            }
            if (!(dx < -6 && -dx > dy)) return;
            s.drag = true;
            s.startDx = dx; // 从接管点起算,起步不跳变
          }
          e.stopPropagation();
          const raw = Math.min(0, dx - s.startDx);
          // 72px 内 1:1 跟手,超出 sqrt 阻尼(能继续拖但渐重,不再生硬钉死)
          const pull = raw > -72 ? raw : -72 - Math.sqrt(-raw - 72) * 3;
          el.style.transition = "none";
          el.style.transform = `translateX(${pull}px)`;
          if (iconRef.current) iconRef.current.style.opacity = String(Math.min(1, -pull / 44));
        }}
        onTouchEnd={(e) => {
          const s = st.current;
          const el = ref.current;
          st.current = null;
          if (!s?.drag || !el) return;
          const t = e.changedTouches[0];
          const dx = t ? t.clientX - s.x - s.startDx : 0;
          el.style.transition = "transform 0.18s ease-out";
          el.style.transform = "translateX(0)";
          if (iconRef.current) {
            iconRef.current.style.transition = "opacity 0.18s ease-out";
            iconRef.current.style.opacity = "0";
          }
          if (dx < -44) store.setQuote(quote);
        }}
      >
        {children}
      </div>
    </div>
  );
}

const TextBlock = memo(function TextBlock({
  text,
  ts,
  streamed,
  muted,
  fullText,
}: {
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
  const press = useBubbleMenuTrigger(() => ({ text, fullText, ts, getEl: () => bodyRef.current }));
  return (
    <QuoteSwipe quote={text}>
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
              "narration-muted border-l-2 border-base-content/20 pl-2.5 text-[13.5px] leading-snug text-base-content/50"
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
        {showTs && ts && (
          <div className="mt-0.5 font-mono text-[10px] tabular-nums opacity-40">{fmtTs(ts)}</div>
        )}
      </div>
    </QuoteSwipe>
  );
});

/**
 * 助手正文：过程叙述 + 最终回复（replyText）分区渲染，中间淡分隔线。
 * 有 segments（叙述/工具的真实交错序）时按段渲染——修「工具全堆气泡顶部、
 * 文本全挤底部」的时间线错乱；无 segments（旧缓存快照）回退 content+toolCalls。
 * 流式进行中文本段用纯文本（DOMD 只读一次不适合增量喂字），定稿/历史走 DOMD。
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
        seg.kind === "text" ? (
          // 只有「最后一段且回合仍在流式」在生长——其余段已封笔,立即富文本
          <TextBlock
            key={i}
            text={seg.text}
            ts={seg.ts ?? m.ts}
            streamed={m.streamed && i === segs!.length - 1}
            fullText={full}
            muted
          />
        ) : seg.kind === "reply" ? (
          // 空 reply 段不渲染（否则是一条「回复」分隔线 + 空白块的幽灵气泡）。
          // 源头已在 chat-store.setReplyText 拦截，这里兜历史快照里的旧空段。
          !seg.text?.trim() ? null : (
            <div key={i}>
              {i > 0 && <ReplyDivider />}
              {/* reply 到达即完整,永远直接富文本 */}
              <TextBlock text={seg.text} ts={seg.ts ?? m.replyTs ?? m.ts} streamed={false} fullText={full} />
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
  ) : hasNarration ? (
    <TextBlock text={m.content} ts={m.ts} streamed={m.streamed} fullText={full} muted />
  ) : null;

  return (
    <>
      {narration}
      {hasReply && !hasReplySeg && (
        <>
          {hasNarration && <ReplyDivider />}
          {/* reply 到达即完整,直接富文本 */}
          <TextBlock text={m.replyText!} ts={m.replyTs ?? m.ts} streamed={false} fullText={full} />
        </>
      )}
    </>
  );
}

/** 引用回复格式(左滑引用):「> 引用\n\n正文」→ 拆成引用条 + 正文。 */
function splitQuoted(content: string): { quoted?: string; body: string } {
  const qm = content.match(/^> (.+?)\n\n([\s\S]*)$/);
  return { quoted: qm?.[1], body: qm ? qm[2] : content };
}

/**
 * 整条 assistant 消息的纯文本（「复制整条」用）：按段序取叙述 + reply，工具卡
 * 不进剪贴板（复制回复是为了转发文字，不是转发执行日志）。
 * 去重是必须的——旧快照里 reply 既可能在段里、又挂在 replyText 上（AssistantBody
 * 的两条渲染路径），不去重就会复制两遍。
 */
function messagePlainText(m: ChatMessage): string {
  const parts: string[] = [];
  const push = (t?: string) => {
    const v = t?.trim();
    if (v && !parts.includes(v)) parts.push(v);
  };
  if (m.segments?.length) {
    for (const seg of m.segments) if (seg.kind !== "tools") push(seg.text);
  } else {
    push(m.content);
  }
  push(m.replyText);
  return parts.join("\n\n");
}

/**
 * memo 是整个会话页的性能命门（2026-07-13「列表滑动卡死」根因）：流式期间每个
 * SSE 事件都会 produce 新 messages 数组，无 memo 时全部气泡（几十个气泡 + 几百
 * 张工具卡 + 全部 Domd markdown）每事件全量 reconcile；immer 结构共享保证未变
 * 消息的对象引用稳定，memo 后每事件只有正在流式的最后一个气泡重渲染。移动端
 * 列表页与会话页并排都在 DOM——会话页的重渲染风暴会卡死列表页的滚动。
 */
const Message = memo(function Message({
  m,
  streaming,
  isLast,
  awaiting,
}: {
  m: ChatMessage;
  streaming: boolean;
  isLast: boolean;
  awaiting: boolean;
}) {
  // 点击消息（user 气泡 / ✦ 头）切换秒级时间显示；长按/右键出菜单
  const [showTs, setShowTs] = useState(false);
  /** user 气泡本体 —— 长按菜单里「选择文字」要框住的范围。 */
  const bubbleRef = useRef<HTMLDivElement>(null);
  // hook 必须无条件调用(下面有 system/user 两处提前 return),所以正文在长按那一刻
  // 现算,不依赖分支里的局部变量
  const press = useBubbleMenuTrigger(() => ({
    text: splitQuoted(m.content).body,
    ts: m.ts,
    getEl: () => bubbleRef.current,
  }));
  const t = useT();
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
    const label = m.from || (isSelf ? profile.nickname : "");
    return (
      <div className={`${m.id.startsWith("h") ? "" : "chat-msg-in"} mb-[22px] flex flex-col items-end gap-2`}>
        {/* 头行:昵称 + 头像落在气泡上方,不占气泡宽度(owner 2026-07-14) */}
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
              className="cstra-bubble whitespace-pre-wrap break-words rounded-[15px_15px_4px_15px] border border-base-content/5 bg-base-300 px-[15px] py-[11px] text-[14.5px] leading-[1.6] text-base-content/90"
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
              {userBody}
            </div>
          </QuoteSwipe>
        )}
        {/* v2.15+ 发送失败标记:乐观气泡不能装作已送达(2026-07-27 用户丢消息实锤) */}
        {m.failed && (
          <div className="pr-1 text-[11px] font-medium text-error">⚠️ {t("未送达——请重新发送")}</div>
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
      {!streamingLast && (m.turnError || m.turnInterrupted || m.turnDone) && (
        <TurnMark
          kind={m.turnError ? "error" : m.turnInterrupted ? "interrupted" : "done"}
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
  const streaming = useChatStore((s) => s.state.streaming);
  const loadingHistory = useChatStore((s) => s.state.loadingHistory);
  const historyHasMore = useChatStore((s) => s.state.historyHasMore);
  const loadingOlder = useChatStore((s) => s.state.loadingOlder);
  const historyError = useChatStore((s) => s.state.historyError);
  const active = useChatStore((s) => s.state.activeAgent);
  const store = useChatStoreApi();
  const pendingPermission = useChatStore((s) => s.state.pendingPermission);
  const pendingAsk = useChatStore((s) => s.state.pendingAsk);
  const bgTaskCount = useChatStore((s) => s.state.bgTasks.length);
  const browsing = useChatStore((s) => s.state.browsing);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
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
    // （2026-07-13 真机）。awaiting=true 是自己刚发送 → 仍然滚底。
    if (isSelectMode()) return; // 正在选字：滚一下选区就没了
    if (!followRef.current && !awaiting) return;
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    followRef.current = true;
  }, [messages.length, awaiting, pendingPermission, pendingAsk, bgTaskCount]);

  useEffect(() => {
    const el = scrollerRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    let lastTop = el.scrollTop;
    const onScroll = () => {
      // 向上滑立即退出吸底（不等离底 >90px）——流式内容持续长高时，90px 缓冲区
      // 内的每次 resize 吸底都会把刚起步的上滑手势拽回去，手感就是「滑不动」
      const up = el.scrollTop < lastTop;
      lastTop = el.scrollTop;
      followRef.current = !up && el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    };
    el.addEventListener("scroll", onScroll);
    const ro = new ResizeObserver(() => {
      if (isSelectMode()) return; // 同上：选字期间新内容长高也不吸底
      if (followRef.current) {
        el.scrollTop = el.scrollHeight;
        lastTop = el.scrollTop; // 吸底自身的位移不算「用户上滑」
      }
    });
    ro.observe(inner);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [active]);

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
  const hiddenCount = messages.length - visible.length;

  return (
    // touch-pan-y + overscroll-contain：到边界时滚动链穿透到不可滚的应用壳被
    // 橡皮筋吃手势（同 sidebar 修法）。onTouchStart 收键盘：iOS 在 transform
    // 祖先下滚动聚焦中的输入框，光标会脱离输入框画在消息区里（2026-07-13 截图）
    // ——触摸消息区即 blur，与主流聊天 App 行为一致。
    <div
      ref={scrollerRef}
      id="cstra-msgs"
      className="flex-1 touch-pan-y overflow-y-auto overscroll-contain"
      style={{ WebkitOverflowScrolling: "touch" }}
      onTouchStart={() => {
        const ae = document.activeElement;
        if (ae instanceof HTMLElement && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT")) {
          ae.blur();
        }
      }}
      onClick={(e) => {
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
        });
      }}
    >
      {/* 横向留白对齐 claude-os thread（px-7=28px + 居中限宽），手机端稍收到 24px，
          原 px-4(16px) 太满不透气（owner 反馈）。滚动条落在最外层边缘更干净。 */}
      <div className="mx-auto flex max-w-3xl flex-col px-6 pb-4 pt-6 sm:px-7">
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
          // 是零成本透明块(块级流内,不改 flex-col 布局)。
          <div key={m.id} data-mid={m.id} className={flashId === m.id ? "cstra-flash" : undefined}>
            <Message
              m={m}
              streaming={streaming}
              isLast={i === visible.length - 1}
              awaiting={awaiting}
            />
          </div>
        ))}
        {/* 活跃会话的面板/交互卡不属于历史现场——浏览模式只藏不清,回来原样恢复 */}
        {!browsing && <CcTaskPanel />}
        {!browsing && <BgTaskPanel />}
        {!browsing && pendingPermission && <PermissionCard p={pendingPermission} />}
        {!browsing && pendingAsk && <AskQuestionCard a={pendingAsk} />}
        {standaloneThinking && !browsing && (
          <div className="chat-msg-in mb-[22px] w-full">
            <ClaudeHeader pulsing />
            <ThinkingDots />
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
