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
import { InlineButton } from "./inline-button";
import "./prism-themes.css";

/**
 * 行内规则(v2.20+):默认集(== 高亮)+ 行内按钮 `[[{#id .style}label]]`。
 * [[ 首字符与内建 link 语法撞车属 reserved delimiter——do-md 只在带 {…}
 * capture 时触发自定义规则,普通 [[wiki]] 不受影响(Playwright 实证)。
 */
const INLINE_RULES: InlineRule[] = [
  ...defaultInlineRules,
  { open: "[[", close: "]]", tagName: "span", component: InlineButton },
];

type ProviderProps = ComponentProps<typeof DOMDProvider>;

export type DomdProps = Omit<ProviderProps, "children"> & {
  /** 包裹 <DOMD/> 的容器类名（排版 scope，如 chat-domd）。 */
  bodyClassName?: string;
  /** 渲染在 Provider 内的附加桥接组件（流式喂字等）。Chat 只读暂不用。 */
  children?: ReactNode;
};

/**
 * 一站式只读 DOMD（Provider + 主体）。默认挂 Prism 高亮。
 * initMd 是初始 markdown（挂载时读一次）——所以调用方对「流式进行中」的消息
 * 先用纯文本渲染，定稿后再挂 Domd（一次性拿全量 content），见 message-list。
 */
export function Domd({ bodyClassName, children, ...provider }: DomdProps) {
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
  return (
    <DOMDProvider
      key={grammarV}
      editable={false}
      codeTokenizer={tokenize as ProviderProps["codeTokenizer"]}
      inlineRules={INLINE_RULES}
      {...provider}
      initMd={initMd}
    >
      {bodyClassName ? (
        <div className={bodyClassName}>
          <DOMD />
        </div>
      ) : (
        <DOMD />
      )}
      {children}
    </DOMDProvider>
  );
}

export { DOMDProvider as DomdProvider };
