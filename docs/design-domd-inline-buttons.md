# 设计方案：DOMD 行内可点按钮（+ 前置的 0.11.2 升级）

状态：**已实现**（owner 2026-08-26 拍板动手；PR-1 升级与 bug ① 已先行上线）。
实现落点：`src/lib/inline-buttons.ts` + `web/lib/chat/inline-buttons.ts`（共享解析,
逐字节一致）、`web/components/domd/inline-button.tsx`（InlineButton + context）、
`deliverToUser` Discord 出站拆分、历史路由 `i:<id>` 已答态还原。

> **语法勘误（实现时发现）**：do-md 的 `{…}` capture 紧跟**开分隔符**
> （`[[{#id .style}label]]`），不是本文首版写的 Pandoc 尾置
> （`[[label]]{#id .style}`）。README 实例 `=={bg=red}x==`、
> `<{.mention id=1}Name>` 与 Playwright 实证均确认。下文 §3/§4 的旧写法
> 保留作评审记录,以勘误为准。

## 0. 一句话

利用 `@do-md/core-react` **0.11.2** 新增的 `inlineRules` + `component` 能力，让 agent
在 markdown 正文里**内联写可点按钮**（如「确认后我就发布 [[确认]]{#release_go .success}」），
DOMD 把它渲染成真正的交互按钮，点击回投 `[button:<id>]`——与现有结构化 `components`
同一套 wire。**硬前提是先把 DOMD 从我们锁的 0.2.10 升到 0.11.2**（0.2.10 没有任何
自定义渲染入口）。

## 1. 背景与动机

- 现状：交互按钮是**结构化 `components` 字段**（`reply-components.tsx`），块级排在消息
  下方，跟 Discord 共用 wire。优点是跨平台；局限是**按钮只能整块堆在消息末尾，无法与
  正文内联**（句子中间放一个按钮做不到）。
- DOMD 行内渲染唯一能带来的**新能力**就是「按钮内联进正文」。若只是想让现有按钮更好看，
  不需要动 DOMD（它们本来就是 React）。

## 2. 升级验证结果（0.2.10 → 0.11.2，已在本分支跑过）

隔离 worktree + surgical 换包 + Playwright 渲染我方真实 `Domd` 封装：

| 检查 | 结果 |
|---|---|
| `tsc --noEmit` 对我方全部代码 | ✅ 零错误（DOMDProvider 的 `editable`/`initMd`/`codeTokenizer` 签名兼容） |
| `style.css` 的 `.DOMD-*` 类名 diff | ✅ **无删除**，仅新增 `DOMD-InlineRule`；我方 globals.css 只引用 `.DOMD-Root`，完好 |
| 表格渲染（+ 我方 padTableBlocks 归一化） | ✅ 4 单元格正常 |
| 代码块 prism 高亮 | ✅ 31 个 token span（tokenizer 集成不变） |
| 粗体 / 行内码 / 有序无序列表 / 标题 / 引用 | ✅ 全部渲染 |
| 运行时 peer deps（immer ^10‖^11、react ≥18） | ✅ 本仓 immer 11 / react 19 满足 |

**未覆盖（合并前需补的完整回归）**：真实 `/chat` 页（登录态 + SSE）、流式增量 remount、
明暗主题切换、iOS 真机、`fetch_messages`/历史大文件路径。以上都不涉及 DOMD 的解析核心，
风险低，但要在合并升级前正式过一轮。

结论：**升级本身低风险、可推进**；建议作为独立 PR 先合并（验证清单跑完），再做行内按钮。

## 3. 行内按钮语法设计

复用 DOMD 的 `InlineRule`（Pandoc/Djot 微语法 `{…}`）：

```
[[按钮文字]]{#<按钮id> .<样式>}
```

- `[[…]]` 内容 = 按钮 label（可含行内 markdown）。
- `#<id>` = 按钮 id → 回投 `[button:<id>]`。id 白名单校验 `^[\w:-]+$`。
- `.<样式>` = variant，映射到现有 `BTN_STYLE`：`primary` / `success` / `danger` / `secondary`（缺省 secondary）。

示例：`发布前确认：[[确认发布]]{#release_go .success} [[取消]]{#release_cancel .secondary}`

**范围**：本方案只做**按钮**。select / multiselect 内联语义复杂（选项、min/max、提交），
维持结构化 `components`，不进本期。

## 4. 渲染与点击接线

DOMD 的 `inlineRules[].component` 是 view 层组件（`editable=false` 下正常触发），
拿到 `params`（`#id` / `.variant`）、`contentText`（label）、`children`：

```tsx
// components/domd/inline-button.tsx（新增）
function InlineButton({ params, children, domProps }: InlineRuleComponentProps) {
  const ctx = useReplyClickCtx();           // 见下：从 Provider 注入
  const id = params.id;                      // "#release_go" → "release_go"
  const style = params.variant ?? "secondary";
  if (!id || !ctx) return <span {...domProps}>{children}</span>; // 兜底成普通文本
  const clicked = ctx.clickedIds.has(id);
  return (
    <button
      className={`btn btn-xs ${BTN_STYLE[style]}`}
      disabled={clicked || ctx.busy}
      onClick={() => ctx.onClick(id, textOf(children), `[button:${id}]`)}
    >
      {children}{clicked && " ✓"}
    </button>
  );
}
```

**上下文注入**：inline component 渲染在 DOMD 内部深处，拿不到消息 id / store。
`Domd` 封装接受可选 `replyClick?: { onClick, clickedIds, busy }`，用 React context 往下传；
`message-list.tsx` 渲染 assistant 正文时把该消息的回投回调 + 已点状态传进去。
复用现有 `chat-store.clickReplyComponent(messageId, choiceId, label, wire)`。

## 5. 与「多 select row 锁死」bug（①）的关系

行内按钮**必须**支持**每个按钮独立的已点状态**——同一条消息可能有多个内联按钮。
这正是 bug ①（`replyClickedId?: string` 单值、`disabled` 消息级）的痛点。
**依赖项**：先把 `replyClickedId: string` 改成 `Record<rowId/btnId, choiceId>`、
`disabled` 下沉到按钮级（即修复 ①）。行内按钮直接复用这套 per-id 状态。
→ **① 应在行内按钮之前做**，两者共用同一份状态模型。

## 6. Discord 跨平台策略（关键决策点）

Discord 消息正文里**塞不了原生按钮**。两条路：

- **方案 A（推荐）·发送时解析拆分**：agent 只写一种语法。出站到 Discord 时，
  从文本里解析出 `[[label]]{#id .style}`，**从正文剥离**并转成一个 `components` 按钮行
  追加到消息（现有块级按钮）；出站到 web 时保留内联。→ 作者体验统一，两端都能点。
  实现点：在 `deliver`/`renderContent` 出站分流处按 adapter 类型处理（Discord adapter
  拆分，web 保留）。
- **方案 B·web-only 糖**：内联按钮仅 web 生效，Discord 忽略（或原样显示文本）。
  实现简单，但作者要区分「给谁看」，且 Discord 用户看到裸 `[[…]]{…}`。

倾向 A：契合现有「wire 统一、adapter 分流」的架构（`bridge/adapters.ts`）。

## 7. 安全

- DOMD 的声明式 `attrs` 已禁 `on*` / `javascript:`；我们走的是 `component`（React），
  onClick 是我方代码，React 自动转义 label，**无 XSS**。
- id 白名单 `^[\w:-]+$`；未知 variant 落 secondary；无 id 的 `[[…]]{}` 兜底成普通文本
  （不产出死按钮）。

## 8. 兼容与回滚

- 结构化 `components` 字段**完全不变**，行内是**附加能力**。
- 回滚 = 移除 inlineRule 注册；已发历史里的 `[[…]]{…}` 退化成普通文本，不炸。

## 9. 落地顺序（建议）

1. **PR-1｜升级**：`@do-md/core-react` → 0.11.2，跑完第 2 节的完整回归清单，合并。
2. **PR-2｜修 ①**：`replyClickedId` → per-id 状态（独立价值，也是行内按钮的前置）。
3. **PR-3｜行内按钮**：注册 inlineRule + `InlineButton` 组件 + context 注入 + Discord 出站拆分（方案 A）。

## 10. 待定 / 开放问题

- select 内联是否要（本期不做）。
- 行内按钮在**流式渲染中途**（`[[` 写了一半）的过渡态——DOMD 未闭合语法本就会短暂
  跳动，与现有富文本流式一致，可接受。
- 方案 A 的 Discord 拆分对「一条消息多个内联按钮跨多行」的边界处理需在 PR-3 细化。

## 11. 实现纪要（2026-08-26）

- 语法（勘误后）：`[[{#id .style}label]]`。fenced code / inline code span 里是字面量。
- Playwright 实证（真实 web 封装 + 0.11.2）：带 capture 触发、符号在 view 模式隐藏
  （innerText 只剩 label）；普通 `[[wiki]]` 无 capture 也会触发规则并吞括号——
  InlineButton 在 `rawCapture === null` 时用 viewOnlyProps 装饰恢复括号视觉；
  写了 capture 但 id 坏/无 context 的安静降级成 label 文本（不产出死按钮）。
- Discord 出站：`deliverToUser` 只在 discord transport 拆分；容量 = 5 行 − 已有
  components 行,每行 5 钮,超容量保留字面量;正文剥空时兜底 "👇"。
- 已答态与块级组件同一份 `replyClicks`,rowKey 前缀 `i:`;历史还原在 BFF 的
  `[button:id]` 匹配里加行内回退分支。
- 复制整条 → `inlineButtonsToText`（按钮退化成 `[label]`）。
