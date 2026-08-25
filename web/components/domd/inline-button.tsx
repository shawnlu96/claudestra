"use client";
/**
 * DOMD 行内按钮(v2.20+):`[[{#id .style}label]]` → 正文里的真按钮。
 *
 * do-md 0.11.2 InlineRule component 的硬契约(违约会破坏内核的 DOM↔model 映射):
 *   1. domProps 必须 spread 到根元素;
 *   2. children(内核渲染的分隔符+内容)必须原样渲染,不得改写/丢弃;
 *   3. 自己加的装饰元素必须 spread viewOnlyProps,否则下次 reparse 会把装饰
 *      文本读回成输入、无限自我复制。
 * 组件抛错时 DOMD 自动回退内核默认渲染——文档永远安全。
 *
 * 点击回投走与块级组件同一套 wire(`[button:<id>]`)+ 同一份 replyClicks 状态
 * (rowKey 前缀 `i:` 区分行内),上下文由 message-list 的 AssistantBody 注入;
 * 无上下文(非聊天场景)/无合法 id 时退化成普通文本,不产出死按钮。
 */
import { createContext, useContext } from "react";
import { viewOnlyProps, type InlineRuleComponentProps } from "@do-md/core-react";

const ID_RE = /^[\w:-]+$/;
const STYLES = new Set(["primary", "success", "danger", "secondary"]);

export interface InlineActionCtx {
  /** 本条消息的已答状态(与 m.replyClicks 同源;行内按钮键 = `i:<id>`)。 */
  clicks: Record<string, string>;
  /** 有一次回投在途 → 全部行内按钮暂时禁点。 */
  busy: boolean;
  onClick: (id: string, label: string) => void;
}

/** AssistantBody 每条消息包一层 Provider;组件在 DOMD 深处经 context 取回调。 */
export const InlineActionContext = createContext<InlineActionCtx | null>(null);

export function InlineButton({
  domProps,
  children,
  params,
  contentText,
  rawCapture,
}: InlineRuleComponentProps) {
  const ctx = useContext(InlineActionContext);
  const id = params.id;
  if (!id || !ID_RE.test(id) || !ctx) {
    // 兜底成普通文本(渲染 children 保住内核结构)。普通 [[wiki]](作者根本没写
    // {…} capture,不是在尝试按钮语法)在 view 模式下分隔符被内核藏掉,会把
    // 无辜文本的括号吞了——用 viewOnly 装饰恢复括号视觉(Playwright 实证 B 案例)。
    // 写了 capture 但 id 坏/缺 ctx 的,按钮意图明确 → 安静降级成 label 文本。
    const restore = rawCapture === null;
    return (
      <span {...domProps}>
        {restore && <span {...viewOnlyProps}>[[</span>}
        {children}
        {restore && <span {...viewOnlyProps}>]]</span>}
      </span>
    );
  }
  const clicked = ctx.clicks[`i:${id}`] != null;
  const style = params.variant && STYLES.has(params.variant) ? params.variant : "secondary";
  const disabled = clicked || ctx.busy;
  return (
    <span
      {...domProps}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      data-variant={style}
      data-clicked={clicked ? "1" : undefined}
      className={`${domProps.className ?? ""} cstra-inline-btn`}
      onClick={(e) => {
        // TextBlock 的单击切时间戳、长按菜单都不该被按钮点击触发
        e.stopPropagation();
        if (!disabled) ctx.onClick(id, contentText);
      }}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          e.stopPropagation();
          ctx.onClick(id, contentText);
        }
      }}
    >
      {children}
      {clicked && <span {...viewOnlyProps}> ✓</span>}
    </span>
  );
}
