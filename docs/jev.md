# 在 Floka 里调用 Jev（TypeSafe System One）

> 给想在自己功能里用 Jev 的开发者（含 Shawn 侧）。背景与候选场景见 [design-jev-integration.md](./design-jev-integration.md)。

## 一句话

Jev 不生成文本。给它一份 `state`（字符串 / JSON）和若干**类型化问题**，它并行作答，返回结构化结果：

| 问题 | 建法 | 答案 |
|---|---|---|
| 是 / 否 | `noul("Does this convey urgency?", { true: "…", false: "…" })` | `{ noul: 0.93 }`（是的概率） |
| 单选 | `choice("What is it about?", { billing: "…", technical: null, other: null })` | `{ choice: "billing", probabilities, confidence }` |
| 打分 | `score("How frustrated?", ["Calm", "Frustrated", "Very angry"])` | `{ score: 1.05, legend, probabilities, confidence }` |

## 用法（`src/lib/jev.ts`）

```ts
import { choice, jevAsk, JevError, noul } from "../lib/jev.js";

const r = await jevAsk(
  { text: reply, agent: name },                       // state：把上下文放成命名字段
  {
    kind: choice("What does `text` ask of the owner?", { needs_decision: "…", asks_question: "…", blocked: "…", fyi: "…" }),
    urgent: noul("Does `text` need attention within the hour?"),
  },
  { timeoutMs: 8000 },                                // 可选：model（钉 jev-1.13.0）/ retries / signal
);
r.answers.kind.choice;        // "needs_decision" | "asks_question" | "blocked" | "fyi"（按问题推断类型）
r.answers.kind.confidence;    // 0..1，分布集中度，不是「对不对」
r.answers.urgent.noul;        // 0..1
r.usage.input_tokens; r.costUsd; r.latencyMs; r.model;
```

- **同一 state 的问题合在一次调用**：模型只读一遍 state，多问几乎不加钱、不加时。
- **没配 key 抛 `JevError("not_configured")`**——调用方必须按「没有 Jev」降级（照旧行为），别让核心链路依赖它。
  其它 code：`unauthorized` / `invalid_request`（422，看 message）/ `rate_limited`（已按 retry-after 重试过）/ `overloaded` / `timeout` / `network` / `bad_response` / `http`。
- key 来源：设置 → 连接与集成 → 集成 → Jev（写 `~/.claude-orchestrator/config.json` 的 `jevApiKey`），兜底 env `TYPESAFE_API_KEY`。**只在 bridge 进程用，别传到浏览器。**
- 阈值：用 `confidence`（choice / score）和 `noul` 距 0.5 的远近做「敢不敢自动动」的第二道门；低于阈值走人工 / 现状。阈值在自家数据上定，别抄 cookbook。
- 中文：Jev 英文最好，中文「能处理但不等同」。问题用英文写、state 里的中文原文照放；上线前先在真实样本上看 confidence 分布。
- 成本：只算输入 token，$0.042 / Mtok；一条 400 token 的回复 + 3 个问题 ≈ 0.00003 美元。限速 250k tok/s、1200 req/min（会变）。

## 测试与验证

- 单测：`tests/jev-client.test.ts` 用假 fetch 覆盖请求形状、429 退避、错误映射。你的功能测试也注入 `deps`（`readKey` / `fetch` / `sleep`），不要真打网络。
- 连通：设置页「测试连接」= `POST /api/v1/jev/test`（`src/bridge/local-api/jev.ts`），固定英文样例，回答案与耗时。
- 上线前先跑影子模式（只记日志不改行为），对照实际结果再切开关。

## 不要

- 不要让 Jev 生成文案、摘要、代码（它做不了）。
- 不要把问题写成「返回 JSON」式的开放问题——每题一个窄判断，criteria 写清各选项的含义，留「都不是」。
- 不要把 key 放进 URL / 日志 / 前端。
