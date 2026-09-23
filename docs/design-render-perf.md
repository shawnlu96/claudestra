# 长对话渲染性能：设计与阶梯（分支 `feat/render-perf`）

> 目标：几百到几千条消息的频道，滚动、追加、流式期间不卡。手机（iOS PWA / 原生壳）是主场景。
> 前置：开发者模式面板（`docs/web-dev-mode.md`）——每一级都先量再改，改完同口径对比。

## 现状（v2.25.0，`features/chat/components/message-list.tsx`）

- **渲染窗口**：只挂尾部 `30 + extraVisible` 条，「显示更早」每次 +100，「加载更早」服务端翻页 +300。窗口外的消息在 store 里，不在 DOM。所以「长对话卡」发生在用户点过几次「显示更早」之后：几百个气泡 × 每气泡若干工具卡 + 若干 `Domd`（do-md 的 markdown → React）。
- **气泡**：`Message` 是 `memo`，immer 结构共享保证未变消息引用稳定；流式期间每个 SSE 事件只重渲染最后一个气泡。最后一段生长中的文本用 `key={text.length}` 每 80ms 合批**重挂一次 Domd**（整段重新解析）。
- **滚动**：
  - 吸底 = `ResizeObserver` 观察内容层，`follow` 为真时逐帧 `scrollTop = scrollHeight`；上滑立即退出吸底；触摸期冻结（iOS 丢 click 问题）。
  - 向上翻页 / 「显示更早」= prepend，靠 `scrollHeight` 增量补偿视口（iOS Safari 无 `overflow-anchor`）。
  - 搜索跳转 = `[data-mid]` 定位 + 700ms 二次校正（Domd 异步长高把锚点顶跑）。
  - 回到底部按钮、历史现场按钮是 `sticky`，长按菜单 / 选字条 / 复制浮标是 portal。
- **没有**：虚拟化、`content-visibility`、任何高度缓存。

### 成本模型

| 场景 | 主要成本 | 现状信号 |
|---|---|---|
| 打开长频道 / 点「显示更早」 | 一次挂几十到几百个 Domd（异步渲染，实测 1.4s 614px → 2.4s 18711px） | 进页那一下明显卡（注释里的原话） |
| 滚动 | 大 DOM 的样式重算与光栅化；合成器卡住时 rAF 也迟到 | 09-12 横滑 2 秒 |
| 追加 / 流式 | 最后气泡每 80ms 重挂 Domd；RO 吸底逐帧写 scrollTop；DOM 越大 layout 越贵 | 「滑不动」类事故 |
| 回合结束 / 对账 | `messages` 数组替换；memo 若失效则全量重渲染 | 面板「气泡渲染速率」可直接看 |

## 约束（不能破的）

1. **do-md 必须留**（owner 2026-07-10：Web 富文本渲染用 do-md）。Pretext 的 markdown-chat demo 是「自己把每一行文字画成绝对定位 div」，等于换掉渲染器——Prism 高亮、行内按钮 / chip、表格、代码块复制、长按菜单、选字都会丢。**Pretext 在本方案里只做测高，不做绘制。**
2. `message-list.tsx` 被 guard 锁成只能变短（936 行）：新逻辑进 ≤400 行的新模块，它只留调用。
3. 横滑容器规则（web/CLAUDE.md 容器规则 5b）：任何 fixed 浮层 portal 到 body；滚动只操作 `#cstra-msgs` 本身。
4. iOS 触摸相关的既有修法（触摸期吸底冻结、tap-rescue、touchmove 收键盘）一律保留，虚拟化不能让这些回归。

## 阶梯

每一级有进入条件（基线数字说明它值得）和退出条件（面板同口径对比）。不跳级。

### 0. 基线（本次已做）

面板新增「渲染基准」分区（`features/devtools/bench-section.ts`）：一键把 `#cstra-msgs` 从顶滚到底（rAF 步进，约 1200px/s，最长 12s），记录帧间隔分布（p50 / p95 / 最大 / >50ms 帧数）、DOM 节点、已挂气泡数、long task，结果进事件列表可复制。先在最长的频道点几次「显示更早」再跑，得到：

- 200 / 500 / 1000 条时的滚动帧间隔 p95
- 流式期间的气泡渲染速率、produce 速率
- 打开频道到首屏稳定的时间（`[slide]` / 手工秒表）

### 1. `content-visibility: auto`（已上 CSS，2026-09-23）

每个 `[data-mid]` 包装层 `content-visibility: auto; contain-intrinsic-size: auto 120px`（globals.css）。屏外气泡跳过样式 / 布局 / 绘制，DOM 保留，选字、查找、`[data-mid]` 定位、prepend 的 `scrollHeight` 补偿全部照旧。iOS 18+ 支持。owner 用拖侧栏复现：每个 pointermove 都让全部已挂气泡重新折行，屏幕上其实只有十来条需要——这条 CSS 正对这个。

屏外行的高度由 `contain-intrinsic-size` 决定：渲染过的行记住上次真实高度，从没渲染过的（「显示更早」prepend 进来的）先占 120px，宽度变过的行保留旧宽度下的高度。差值只在**向上滑**进该行时露出：Chrome / Firefox 有 `overflow-anchor` 自动锚定，iOS Safari 没有，会顿一下。

- 后续升级点（不满意再做，接口不变，都是往 `contain-intrinsic-size` 写一个数）：① 占位值按每条消息字符数 / 工具卡数粗估；② Pretext 按块 `prepare()` 一次、换宽只重跑 `layout()` 刷新全部行；③ Safari 的 `scrollTop` 补偿（`contentvisibilityautostatechange` / RO 盯视口上方的行）。
- 验收：面板「侧栏基准」（程序化摆动侧栏宽度）与「滚动基准」前后对比；真机向上滑看有无可感知的跳。

### 1.5 流式与对账的重渲染

- 面板「气泡渲染速率」在流式期间若接近气泡总数，说明 memo 在某条路径失效：查 `messages` 之外还有哪个 prop 每事件变化（`streaming` / `awaiting` 是全局布尔，会让**所有** `Message` 的 props 变 → 只在翻转时变化，正常）。
- 生长段的 `key={text.length}` 重挂：改成 120ms 合批或只对最后一段限流；对超过 N KB 的生长段退化为纯文本，定稿再 Domd。

### 2. 虚拟化 + Pretext 测高（大改，只在 1 不够时做）

**什么时候才需要**：1 之后 DOM 节点本身（几千气泡 × 几十节点）仍让样式重算 / 内存超标，或者要取消「显示更早」让整段历史可连续滚动。

**结构**（全部在新模块 `features/chat/virtual/`）：

- `row-height.ts`：每条消息的高度来源，三级：**已测量**（挂载时 `ResizeObserver`，按消息 id + 宽度缓存）> **Pretext 估算** > 常数兜底。估算 = 用 marked 或 do-md 的 lexer 把 markdown 切块，段落 / 标题 / 列表项用 `prepareRichInline`（字体、字号、`line-height: 1.72`、`.chat-domd` 的块间距全部从一处常量表读，CSS 变量也从它生成，避免「量的和画的不是一个字体」），代码块 / 表格用 `prepareWithSegments(…, { whiteSpace: "pre-wrap" })`；工具卡按固定行高 × 行数；图片 / 表格宽度未知的块给保守估值 + 挂载后校正。`prepare()` 每条消息只做一次，换宽只重跑 `layout()`。
- `virtual-list.tsx`：`@tanstack/react-virtual`（变高 + `measureElement`）承载，`estimateSize` 走 `row-height`。overscan 按屏高 1.5 倍。
- `scroll-model.ts`（纯函数，可单测）：吸底、prepend 锚定（按消息 id + 偏移，不再按 `scrollHeight` 差）、跳转到 seq、`findScrollAnchor` 风格的「宽度变化时钉住正在读的那条」。
- 保留的东西必须逐项重接：触摸期冻结、tap-rescue、sticky 按钮（改成 portal 或列表外的绝对定位）、`[data-mid]` 搜索定位（改为 `scrollToIndex` + 挂载后微调）、选字模式（虚拟化下滚出屏的选区会断——选字期间冻结窗口）。

**Pretext 的边界**（来自其 markdown-chat 文档「Not covered」）：流式中的 markdown 不稳定（一个 `**` 会改前面的解析）——生长中的最后气泡不走估算，永远实测；晚加载的 web 字体要 `clearCache()` 重 prepare；图片 / 嵌入 / 数学要挂载后校正。它自己的 demo 放弃了「估算高度」路线是因为它能画出精确高度，我们不能（渲染器是 do-md），所以**估算 + 实测缓存**是我们的必然形态，代价是首次滚过未测行时有小幅修正。

- 进入条件：阶段 1 后仍有 DOM > 3 万节点或内存 / 样式重算问题；或产品上要「全历史连续滚」。
- 退出条件：1000+ 条频道滚动 p95 < 32ms、跳转 / prepend 无可见跳动、iOS 真机触摸回归清单全过。

### 3. 之后再说

- 服务端历史分页改为按高度预算而非条数。
- Domd 增量喂字（do-md 侧的能力，非本仓）。

## 验收口径（面板读数）

| 指标 | 基线 | 阶段 1 目标 | 阶段 2 目标 |
|---|---|---|---|
| 滚动帧间隔 p95（500 条） | 待测 | 减半 | < 32ms |
| 「显示更早」后首帧 | 待测 | 明显下降 | 不适用（无窗口） |
| 流式期间气泡渲染速率 | 待测 | ≈ 1/s 量级 | 同左 |
| DOM 节点（500 条） | 待测 | 不变（DOM 保留） | 常数级 |
