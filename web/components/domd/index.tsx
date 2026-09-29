"use client";
/**
 * DOMD（@do-md/core-react）只读封装——Chat 助手消息的 markdown 渲染统一走这里。
 *
 * owner 决策（2026-07-10）：Web 富文本渲染必须用 do-md，不用 react-markdown。
 * 与 Claude OS 一致（features/chat 的 StaticAssistantBody 同款 <Domd editable=false/>），
 * 复用 workspace 的 @do-md 生态。do-md 已发 NPM（@do-md/core-react），直接依赖，
 * 不走 workspace 复制式 .packages/。
 *
 * Claude OS 的封装还挂了 CustomCursor（仅 editable 时用）——Chat 是只读渲染，
 * 这里省掉，纯 Provider + DOMD。Prism 代码高亮（codeTokenizer=tokenize）必须挂，
 * 否则 DOMD 把整块代码降级成纯文本 span、无从上色。token 配色见 ./prism-themes.css，
 * markdown 元素排版见 globals.css 的 .chat-domd。
 */
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { DOMD, DOMDProvider, defaultInlineRules, type InlineRule } from "@do-md/core-react";
import "@do-md/core-react/style.css";
import { tokenize, subscribeGrammarLoad, getGrammarVersion } from "./prism";
import { padTableBlocks } from "./normalize-md";
import { InlineButton, CopyChip, AgentChip, BadgeChip } from "./inline-button";
import { SAFE_NODES } from "./safe-nodes";
import { usePlainReason, type PlainReason, type ProbeMode } from "./use-plain-reason";
import { breakLongRuns } from "./long-runs";
import { useT } from "@/lib/i18n";
import { ErrorBoundary } from "@/lib/error-boundary";
import { reportBoundaryError } from "@/lib/runtime-error";
import "./prism-themes.css";

/**
 * 行内规则(v2.20+):默认集(== 高亮)+ 行内交互 `[[{…}label]]`。
 * 默认(带 #id / 未注册 variant)走 InlineButton;.copy/.agent/.badge 三个
 * variant 走各自 chip(按钮的 .primary/.success 等不在 variants 表里 →
 * do-md 优雅降级回 rule 级 component,即 InlineButton,行为已实证)。
 * 普通 [[wiki]] 无 capture 触发时由 InlineButton 恢复括号视觉。
 */
const INLINE_RULES: InlineRule[] = [
  ...defaultInlineRules,
  {
    open: "[[",
    close: "]]",
    tagName: "span",
    component: InlineButton,
    variants: {
      copy: { component: CopyChip },
      agent: { component: AgentChip },
      badge: { component: BadgeChip },
    },
  },
];

const DOMD_ERR = (err: Error, stack: string) => reportBoundaryError("domd", err, stack);

type ProviderProps = ComponentProps<typeof DOMDProvider>;

export type DomdProps = Omit<ProviderProps, "children"> & {
  /** 包裹 <DOMD/> 的容器类名（排版 scope，如 chat-domd）。 */
  bodyClassName?: string;
  /** 渲染在 Provider 内的附加桥接组件（流式喂字等）。Chat 只读暂不用。 */
  children?: ReactNode;
  /** 退回纯文本时通知调用方（附件预览在顶部显示提示条）；不传就在正文上方显示一行提示 */
  onPlain?: (reason: PlainReason) => void;
  /** 试解析放哪：auto = 超过 4 KB 进 Worker（带时间预算）；流式中的消息每 80 ms 重挂一次，用 sync 免得反复闪纯文本 */
  probe?: ProbeMode;
};

export type { PlainReason };

export const PLAIN_NOTICE: Record<PlainReason, string> = {
  heavy: "内容较大，按纯文本显示",
  complex: "内容结构太复杂，按纯文本显示",
  slow: "内容解析太慢，按纯文本显示",
};

/** reason 为空 = 等试解析结论，先显示纯文本、不提示 */
function PlainBody({ className, text, reason, onPlain }: { className?: string; text: ReactNode; reason?: PlainReason; onPlain?: (r: PlainReason) => void }) {
  const t = useT();
  useEffect(() => void (reason && onPlain?.(reason)), [onPlain, reason]);
  return (
    <div className={className}>
      {reason && !onPlain && <div className="mb-1 text-xs text-base-content/50">{t(PLAIN_NOTICE[reason])}</div>}
      <div className="whitespace-pre-wrap break-words">{typeof text === "string" ? breakLongRuns(text) : text}</div>
    </div>
  );
}

/**
 * 一站式只读 DOMD（Provider + 主体）。默认挂 Prism 高亮。
 * initMd 是初始 markdown（挂载时读一次）——所以调用方对「流式进行中」的消息
 * 先用纯文本渲染，定稿后再挂 Domd（一次性拿全量 content），见 message-list。
 */
export function Domd({ bodyClassName, children, onPlain, probe = "auto", ...provider }: DomdProps) {
  // 表格紧贴上一行时 do-md 认不出来（它要求表格自成块）——渲染前补上那个空行。
  // 见 ./normalize-md：0.2.10 与最新 0.11.2 行为一致，升级救不了，只能归一化。
  const initMd = useMemo(
    () => (typeof provider.initMd === "string" ? padTableBlocks(provider.initMd) : provider.initMd),
    [provider.initMd]
  );
  // 懒加载语法落地后 remount 重新 tokenize——DOMD 只读一次,首渲时 grammar 未到
  // 的 fence(如 ```powershell)先按纯文本显示,这里补一次上色。version 只在
  // 真正有新语法注册时 +1,一个会话最多几次,remount 成本可忽略。
  const [grammarV, setGrammarV] = useState(0);
  useEffect(() => subscribeGrammarLoad(() => setGrammarV(getGrammarVersion())), []);
  const opts = {
    editable: false,
    codeTokenizer: tokenize as ProviderProps["codeTokenizer"],
    inlineRules: INLINE_RULES,
    renderComponent: SAFE_NODES,
    ...provider,
    initMd,
  };
  // 交给 do-md 会卡死或栈溢出的 md 退回纯文本：护栏 + 试解析（./use-plain-reason）
  const reason = usePlainReason(opts, probe);
  const plain = (r?: PlainReason) => <PlainBody className={bodyClassName} text={initMd} reason={r} onPlain={onPlain} />;
  if (reason) return plain(reason === "pending" ? undefined : reason);
  // 渲染里抛的错（栈溢出等）也退回纯文本，并上报一次好补阈值
  return (
    <ErrorBoundary fallback={() => plain("complex")} onError={DOMD_ERR} resetKey={initMd}>
      <DOMDProvider key={grammarV} {...opts}>
        {bodyClassName ? (
          <div className={bodyClassName}>
            <DOMD />
          </div>
        ) : (
          <DOMD />
        )}
        {children}
      </DOMDProvider>
    </ErrorBoundary>
  );
}

export { DOMDProvider as DomdProvider };
export { breakLongRuns };
