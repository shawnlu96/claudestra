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

**结果（owner 实测 2026-09-23）**：约 10 万像素高的对话，反复拖侧栏——改前 FPS 跌到 40 左右（基准 120），改后基本不动。重排成本被压到视口附近那十来条。

**owner 决定（2026-09-23，两项都是「先不做」）**：
- 不做「拖拽预览线 + 松手才应用宽度」：实时重排的体验明显好于松手再变，性能已经够，不为此牺牲手感。
- 不引 Pretext 做高度估值：占位值 120px + 浏览器记住的上次高度已经够用，不为几像素的差值增加一个依赖和一套测量代码。

留作升级点（只有向上滑进未渲染行的顿跳真被投诉时再做，接口不变，都是往 `contain-intrinsic-size` 写一个数）：① 占位值按每条消息字符数 / 工具卡数粗估；② Pretext 按块 `prepare()` 一次、换宽只重跑 `layout()`；③ Safari 的 `scrollTop` 补偿（`contentvisibilityautostatechange` / RO 盯视口上方的行）。

- 验收方式（已固化）：面板「侧栏基准」（程序化摆动侧栏宽度）与「滚动基准」前后对比；真机向上滑看有无可感知的跳。

### 1.5 流式期间的 JS 成本（先量，多半不做）

owner 2026-09-23 指出：流式不是重排问题——块级流里后面的兄弟长高不需要重排前面的兄弟，屏外行又有 `content-visibility`，历史多长与此无关。这一级只剩两处 JS 成本，都与**生长中那一段的长度**成正比，不与历史长度成正比：

- 生长段的 `key={text.length}` 每 80ms 卸载再重挂 Domd（整段重新解析 + React 树重建 + Prism 重新高亮）。几百字亚毫秒；几 KB 带代码块可能到十几毫秒。
- 每个 SSE 事件替换 `messages` → `MessageList` 重渲染一次 → 几百个 memo 气泡 props 比较 + `replyEchoMessageIds` 扫全列表。O(n) 轻操作。

**判据**：等一次带大代码块的长回复，看面板「最大帧间隔」与 long task。流式期间帧间隔一直 <16ms、long task 为 0 → 划掉本级；出现 >50ms 的帧才动手：80ms 合批放宽到 120ms，或超过 N KB 的生长段先纯文本、定稿再 Domd。面板「气泡渲染速率」流式期间若接近气泡总数说明 memo 失效，那是 bug 不是优化项。

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

## 封板记录（2026-09-23，owner 决定暂停到此）

**已落地**（分支 `feat/render-perf`，共 6 个提交）：
- 阶段 0：面板「渲染基准」——滚动基准 + 侧栏基准（`features/devtools/bench-section.ts` / `bench-stats.ts`）。
- 阶段 1：`#cstra-msgs [data-mid] { content-visibility: auto; contain-intrinsic-size: auto 120px }`（`globals.css`）。实测 10 万 px 高的对话反复拖侧栏，FPS 从 ~40 回到基准 120。

**owner 决定先不做**：拖拽预览线（手感差）；Pretext 估高（不为几像素加依赖）；面板 1s tick 的优化（关着时零成本，见下）。

**审计结论**（供下次直接引用，不必重查）：
- 气泡组件内没有 canvas / 定时器 / rAF；只有 CSS 无限动画，屏外行与后台页浏览器都不绘制。页面级定时器里该判可见的（15s agents 轮询、7s 对账心跳）已判；流看门狗故意常驻。
- 流式文本 80ms 合批（`chat-store` `pendingText`），每次 flush 只重渲染最后一个气泡、只重挂最后一个文本段的 Domd；成本正比于该段长度，不正比于历史。
- 唯一随历史线性增长的 per-flush 开销：`MessageList` 每次渲染调 `replyEchoMessageIds(messages)` 扫整个列表做正则归一化，无缓存。修法：结果只取决于「该消息 + 同回合前面的 reply」，按消息对象 `WeakMap` 缓存。**先用面板 long task 证实再做。**
- 一次性尖峰：Prism 懒加载到新语法时 `Domd` 的 `key={grammarV}` 让窗口内所有 Domd 同时重挂（一个会话几次）。
- 开发者模式关着时：面板 + stats.js + lil-gui 在独立 chunk（约 45KB），不在 /chat 初始脚本里；主 bundle 只多 1–2KB 纯逻辑；`postClientLog` 的事件环双写是唯一常驻动作（低频，故意保留）。

**下次从哪接**：先跑一次带大代码块的长回复看面板「最大帧间隔」/ long task。有 >50ms 帧 → 先做 `replyEchoMessageIds` 缓存，再考虑生长段 Domd 合批放宽；向上滑进「显示更早」那批行有可感知顿跳 → 阶段 1 升级点（占位粗估 / Pretext / Safari 补偿）；DOM 节点本身成问题（> 3 万）或要全历史连续滚 → 阶段 2。

## 验收口径（面板读数）

| 指标 | 基线 | 阶段 1 目标 | 阶段 2 目标 |
|---|---|---|---|
| 拖侧栏 FPS（10 万 px 高的对话，120Hz 屏） | ~40 | 基本不掉（已达成） | 不适用 |
| 滚动帧间隔 p95（500 条） | 待测 | 减半 | < 32ms |
| 「显示更早」后首帧 | 待测 | 明显下降 | 不适用（无窗口） |
| 流式期间气泡渲染速率 | 待测 | ≈ 1/s 量级 | 同左 |
| DOM 节点（500 条） | 待测 | 不变（DOM 保留） | 常数级 |
