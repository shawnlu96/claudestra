# Web 开发者模式 · 可视化临时调试范式

**简体中文** · [English](./web-dev-mode.en.md)

> 适用对象：所有在 `web/` 上做 UI / 交互 / 性能调整的 agent 与人。
> 一句话规则：**凡是「改个数值看效果」的活，先把参数暴露到开发者面板让用户自己拖，再把定稿写死进代码。** 不要「改一版 → build → 用户看 → 再对话 → 再改」地循环。

## 为什么

2026-09-22 之前，web 客户端的每一次 UI 微调和真机排障都是对话驱动的：agent 猜一个值、用户 build 后看、描述感受、agent 再猜。一次间距调整要来回三五轮；每次 PWA 容器问题都要临时手写一个诊断浮层再删掉（`web/CLAUDE.md` 容器规则 6）。开发者模式把这两件事变成常驻基建：

- **可视化调参**：参数变成面板上的滑块 / 开关 / 颜色，用户在手机上拖到满意，把值贴回来；
- **常驻读数**：帧率、帧间隔、提交突发、DOM 数、视口实测值、事件列表不用再手写；
- **零成本给普通用户**：面板走 `next/dynamic`，关着时 bundle 里没有它。

## 怎么开

| 入口 | 说明 |
|---|---|
| 设置 → 实验 → 「开发者模式」 | 切换即时生效，不用刷新 |
| URL `?dev=1` / `?dev=0` | 给自动化截图、给别人手机一次性打开;写入同一个 localStorage 键 `cstra_devmode` |
| 控制台 `window.__cstraDev` | `setDevMode / devEvent / recentDevEvents / allCounters / registerDevSection` |

开着时右下角是一个徽章 `🛠 60fps · gap 17ms · burst 0`,点开是面板;`html[data-dev]` 属性同时打上。

## 面板已内置的东西（别重复做）

| 分区 | 内容 |
|---|---|
| stats.js 三格 | FPS / MS / 帧间隔（第三格是自定义 panel，合成器卡住时 rAF 也会迟到） |
| 性能 | 最大帧间隔、输入到下一帧（pointerdown→双 rAF 手测；Safari 没有 Event Timing API）、long task（Safari 没有 → n/a）、DOM 节点数、已渲染消息数（`[data-mid]`）、气泡渲染速率、store produce 速率、提交突发次数 |
| 渲染基准 | 「滚到顶」→「开始滚动基准」：rAF 步进把消息列表匀速滚到底（速度可调）；「开始侧栏基准」：宽屏上程序化让侧栏宽度 240–480px 摆动几秒（量右侧内容整体重排）。结果一行进事件列表：帧间隔 p50 / p95 / 最大、>50ms / >100ms 帧数、DOM 节点、已挂气泡、long task。改渲染前后用它同口径对比（`docs/design-render-perf.md`） |
| Store | activeAgent / agents / messages / streaming / syncState / streamDown / loadingHistory / bgTasks |
| 视口 | `navigator.standalone`、inner、visualViewport、安全区 `env()` 实测、layoutMode、`data-streaming`、hash；开关：底部对齐线（`fixed bottom:0` 红线）、元素轮廓 |
| 动作 | 清空事件、重置计数、复制事件到剪贴板、刷新、关闭开发者模式 |
| 最近事件 | 三个常驻探针（运行时错误 / 横滑动画 / React 提交突发）与 `store.clientLog` 的双写，最新在下 |

## 范式一：可视化调参（UI / 动画 / 阈值）

**1. 把待调的值收进一个对象，代码读对象而不是常量。**

```ts
// features/chat/components/composer.tsx
const TUNE = { bottomPad: 12, slideMs: 300, followThreshold: 80 };
```

CSS 类的值走 CSS 变量：代码里写 `var(--cstra-composer-pad, 12px)`，面板改 `document.documentElement.style.setProperty(...)`。

**2. 注册一个分区，带日期和事由注释。** 模块顶层注册即可，面板晚开会回放已有注册；面板已开时新注册会触发重建。

```ts
import { registerDevSection } from "@/features/devtools/dev-registry";
import type GUI from "lil-gui";

// dev-section: 2026-09-22 composer 底部间距 / 横滑时长调参（owner 反馈键盘期太挤），收敛后删
registerDevSection("composer-tune", ({ gui, onTick }) => {
  const f = (gui as GUI).addFolder("Composer");
  f.add(TUNE, "bottomPad", 0, 40, 1).onChange((v: number) =>
    document.documentElement.style.setProperty("--cstra-composer-pad", `${v}px`)
  );
  f.add(TUNE, "slideMs", 100, 800, 10);
  f.add(TUNE, "followThreshold", 0, 300, 10);
  // 只读读数：字符串控件 + listen + disable，每秒 onTick 刷新
  const r = { 当前偏移: "-" };
  f.add(r, "当前偏移").listen().disable();
  onTick(() => { r.当前偏移 = `${Math.round(measureOffset())}px`; });
  return () => f.destroy();
});
```

**3. 让用户拖。** 告诉用户开 `?dev=1`，哪个分区、哪几个滑块。要拿回最终值有两种方式：用户直接念数字；或在 `onChange` 里 `devEvent("tune", JSON.stringify(TUNE))`，用户点面板「复制事件」整段贴回来。

**4. 定稿写死，删干净。** 把值写回常量 / CSS，删掉 `registerDevSection` 调用、`TUNE` 对象暴露和注释。`bun test` 里有一条守卫（`tests/web-dev-sections.test.ts`）：`features/devtools` 之外任何 `registerDevSection(` 调用，上方 3 行内必须有 `dev-section: YYYY-MM-DD` 注释，否则测试失败——这是为了让遗留的临时分区在 CI 上显形，不是让你把注释写上就永远留着。

## 范式二：排障读数（不调参，只看值）

需要看某个内部状态的实时值（滚动位置、某个 ref、某个定时器状态）时，同样注册分区，只放只读控件 + `onTick`，或者干脆 `devEvent("scroll", ...)` 打进事件列表。**不要再手写临时 `<div style="position:fixed">` 浮层**——那正是这套东西要取代的。

事件双写规则：`devEvent(kind, msg)` 只进面板事件环（200 条，关着也在攒，开销可忽略）；要同时留服务端取证走 `postClientLog(msg)`（`lib/client-log.ts`，前端唯一打点出口，内部已经双写）。

## 范式三：性能基线（改渲染前先量）

任何「感觉卡」的改动，先用面板量一组基线再动手，改完用同样的口径对比：

| 指标 | 看什么 |
|---|---|
| 最大帧间隔 | 滚动 / 追加消息时是否 >100ms;合成器卡住时它比 FPS 更早说话 |
| 输入到下一帧 | 点按后多久上屏（INP 的手工近似） |
| 气泡渲染速率 | 流式输出时如果全部气泡都在重渲染，memo 失效 |
| produce 速率 | store 每秒改几次；和气泡渲染速率一起看 |
| 提交突发 | 非零就是同步提交链（#185 类问题），事件列表里有 roots / hook 序号 |
| DOM 节点 / 已渲染消息 | 长会话卡顿的规模基数 |

## 约束

- **dev-only 代码只能在 `web/features/devtools/`**，或在业务代码里以一行 `devCount("x")`（开着才计数）/ `if (isDevMode())` 接入。不引新的调试库；stats.js 与 lil-gui 已经在了。
- 大文件（chat.tsx / chat-store.ts / message-list.tsx）被 guard 锁成只能变短：往里加接入点要同时省出等量的行；能从已有的全局信号拿到的（`cstra:commit-burst` 事件、`__cstraProduceTrail`）就别加计数点。
- 仓库根的 `scripts/guard` 同样管这里：新文件 ≤400 行、函数 ≤100 行（useEffect 回调也算函数）、`catch` 必须写清为什么丢了没事。面板本体因此拆成 dev-meters / dev-panel-sections / dev-overlay 三块。
- 面板 portal 到 `document.body`，任何浮层都不要塞进 `chat.tsx` 的横滑 transform 容器（容器规则 5b）。
- 分区里不要写 localStorage；调参是一次性的，定稿进代码。
- `PerformanceObserver` / `visualViewport` / `navigator.standalone` 在 Safari 上缺哪些已在内置分区标出 n/a，注册新读数时同样做能力检测，别让面板在 iOS 上抛错。
- 上线前 `cd web && npm run build` 照常；面板对普通用户不可见也不装载，但 `isDevMode()` 分支里的代码仍会编译，保持它们纯粹。

## 相关文件

```
web/features/devtools/
  dev-mode.ts       总开关（纯逻辑，bun test）
  dev-events.ts     事件环 / 计数器 / 速率采样
  dev-registry.ts   registerDevSection
  dev-mount.tsx     开关 → 动态加载
  dev-meters.ts     stats.js 三格 / 帧间隔 / 输入延迟 / long task 采样 hook
  dev-panel-sections.ts 内置四个分区
  dev-overlay.tsx   面板壳：徽章、lil-gui 生命周期、事件列表
tests/web-dev-mode.test.ts       开关解析 / 事件环 / 计数 / 注册表
tests/web-dev-sections.test.ts   临时分区注释守卫
```
