"use client";
import { memo, useState } from "react";
import type { ToolCallView } from "../type";
import { highlightCode, langForPath } from "../highlight";
import { fmtTs } from "../fmt-time";
import { cleanSummary, toolIcon } from "../message-text";
import { QuoteSwipe } from "./quote-swipe";
import { ChevronRightIcon, TriangleAlertIcon } from "./line-icons";
import { useIsExport } from "../export-context";
import { toolGroupLayout } from "../tool-group";
import { useT } from "@/lib/i18n";

/* 消息列表里的工具卡（从 message-list.tsx 原样搬出，D8-9）：流式态 ActiveToolRow /
   定稿态 HistoryToolRow / 详情渲染（diff、语法高亮）。 */

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

export const ActiveToolRow = memo(function ActiveToolRow({ tool, active }: { tool: ToolCallView; active: boolean }) {
  const summary = cleanSummary(tool.summary);
  const [open, setOpen] = useState(false);
  const err = tool.state === "error";
  const tone = TOOL_TONE[tool.state] ?? TOOL_TONE.running;
  return (
    <QuoteSwipe quote={`${tool.name} ${summary}`}>
    <div className={`tool-in rounded-lg border ${tone.box}`}>
      <div
        className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 font-mono cstra-tool-text"
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
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono cstra-tool-sub text-base-content/50">
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
export const HistoryToolRow = memo(function HistoryToolRow({ tool }: { tool: ToolCallView }) {
  const summary = cleanSummary(tool.summary);
  const err = tool.state === "error";
  const [open, setOpen] = useState(false);
  const tone = TOOL_TONE[tool.state] ?? TOOL_TONE.done;
  return (
    <QuoteSwipe quote={`${tool.name} ${summary}`}>
    <div data-tool-row="" className={`rounded-lg border ${tone.box}`}>
      <div
        className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 font-mono cstra-tool-text"
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
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono cstra-tool-sub text-base-content/50">
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
        <div className="max-h-72 space-y-1 overflow-y-auto font-mono cstra-tool-sub">
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
        <div className="max-h-72 space-y-1 overflow-y-auto font-mono cstra-tool-sub">
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
      <div className="max-h-72 space-y-1 overflow-y-auto font-mono cstra-tool-sub">
        {idx >= 0 && <div className="break-all text-base-content/50">{detail.slice(0, idx).trim()}</div>}
        <CodeBlock text={idx >= 0 ? detail.slice(idx + 5) : detail} lang="bash" />
      </div>
    );
  }
  // MCP 工具等:入参 pretty JSON → json 高亮;其余纯文本
  const looksJson = /^[{[]/.test(detail.trimStart());
  return (
    <div className="max-h-64 overflow-y-auto font-mono cstra-tool-sub">
      <CodeBlock text={detail} lang={looksJson ? "json" : undefined} />
    </div>
  );
}

/**
 * 一组连续的工具调用（中间没夹文字）收进一个框：默认只露最新一步，点组头展开全部，再点单张卡看详情。
 * 只有 1 步的不收（框住它只是多一行组头）；有失败的在组头标出来，收起也看得见。导出稿全展开、组头不可点（../tool-group.ts）。
 * open 是本组本地状态：流式期间新工具不断进来，组件按段下标复用，展开态不会被冲掉。
 */
export function ToolGroup({ tools, streaming, activeLast }: { tools: ToolCallView[]; streaming: boolean; activeLast: boolean }) {
  const t = useT();
  const exporting = useIsExport();
  const [open, setOpen] = useState(false);
  const row = (tool: ToolCallView, j: number) =>
    streaming ? <ActiveToolRow key={j} tool={tool} active={activeLast && j === tools.length - 1} /> : <HistoryToolRow key={j} tool={tool} />;
  const layout = toolGroupLayout(tools.length, open, exporting);
  if (!layout.framed) return <div className="my-2 space-y-1">{tools.map(row)}</div>;
  const failed = tools.filter((x) => x.state === "error").length;
  const title = (
    <>
      <span>{t("{n} 步工具调用", { n: tools.length })}</span>
      {failed > 0 && (
        <span className="flex items-center gap-1 text-error">
          <TriangleAlertIcon size={12} className="shrink-0" />
          {t("{n} 步失败", { n: failed })}
        </span>
      )}
    </>
  );
  return (
    <div className="my-2 rounded-xl border border-base-content/10 bg-base-content/[0.02] p-1">
      {layout.toggle ? (
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11px] text-base-content/50 transition-colors hover:bg-base-content/5 hover:text-base-content/80"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRightIcon size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          {title}
          <span className="ml-auto shrink-0">{open ? t("收起列表") : t("展开全部")}</span>
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] text-base-content/50">{title}</div>
      )}
      <div className="space-y-1">{layout.showAll ? tools.map(row) : row(tools[tools.length - 1], tools.length - 1)}</div>
    </div>
  );
}
