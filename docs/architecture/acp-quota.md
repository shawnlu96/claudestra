# ACP 额度卡（Codex / Pi）

ACP 会话（Codex 的 codex-acp、Pi 的 ACP 适配器）回合撞了额度，宿主发 `acp_failure{kind:"quota"}`，bridge 出一张「待你处理」卡。
代码：`src/lib/acp/quota-fallback.ts`（纯规则）、`src/lib/acp/config.ts quotaCardChoices`（按钮）、`src/bridge/acp-quota.ts`（取事实）、
`src/bridge/acp-link.ts showQuotaCard`（出卡 / 自动切）。测试：`tests/quota-fallback.test.ts`、`tests/acp-quota-plan.test.ts`、`tests/acp-link.test.ts`。

## 卡上写什么

- 谁到顶：当前模型值 `provider/id` 的 provider（Pi 的 provider 就是那个账号 / 套餐，如 `cc-switch-open-code-go`）；Codex 的模型值不带前缀，一律算 `openai-codex`。
- 原文：provider 回的那句话。认得出 `{type, message}`（或 `error` 里套一层）就写成 `type: message`，否则原样（超过 500 字截断）。完整原文另存 `extra.raw`。
- 重置时间：先从原文解析（`lib/autopilot-run.ts parseResetAt`，认 Claude / Codex 的几种写法）；Codex 解析不出时取 Codex 额度快照里到顶窗口的重置时刻；都没有写「未知」。
- 哪些模型没列、为什么（见下）；备用链 observe 档时写「按备用链会切到 X」。

## 列哪些模型

第一个按钮永远是「等重置」。后面只列真能走通的：

1. **同 provider 的不列**：同一个账号 / 套餐，切过去照样撞墙。provider 取模型值 `provider/id` 斜杠前那段。
   **Codex 的模型 id 不带 provider 前缀**（`gpt-5.6-sol`、`gpt-5.6-luna`）：codex-acp 下拉里的模型全部走本机 `codex login` 的那一个 ChatGPT 账号，
   所以不带斜杠的值一律认作同一个 provider `openai-codex`（`quota-fallback.ts providerOf`）。Codex 会话撞额度时卡上只有「等重置」，
   正文写「没列：openai-codex 的另外 N 个模型（同一个账号 / 套餐，切过去照样撞墙）」。Pi 里写成 `openai-codex/…` 的模型也算这一家。
2. **已知同样到顶的 provider 不列**。判断来源只有两个，都是只读：
   - **Codex 额度快照**：`lib/ai-quota.ts readInventoryQuota().codex`（和网页额度看板同一份：订阅接口实时 / 上次成功快照 / 本机 rollout）。
     提供方明确说已撞限（`limitReached`），或某个窗口用到 100% 且没过重置时刻 → `openai-codex` 到顶，到那个窗口的重置时刻为止。
   - **本 bridge 进程里最近撞过墙的 provider**：任何 ACP agent 报过额度失败就记一笔（provider、时刻、解析到的重置时间），到重置时刻失效；
     原文里解析不出重置时间按 3 小时失效。bridge 重启就清空（宁可多列一个，下次撞墙会再记上）。
3. **同系列优先**：模型 id 去掉版本号后相同（`deepseek-v4.1-flash` 与 `deepseek-v4-flash`、`deepseek-flash`）排最前，其次同一家（id 第一段相同），
   其余按下拉原顺序；同档里版本越接近越前。第一个若是同系列 / 同一家，标「（推荐）」。
4. 一个都不剩：只有「等重置」，正文写「没有别的能用的模型，只能等重置」，并列出被挡掉的原因。

## 自动备用链 `quotaFallback`

写在 `~/.claude-orchestrator/config.json`：

```json
{
  "quotaFallback": {
    "mode": "observe",
    "chain": ["cc-switch-deep-seek", "deepseek-api/deepseek-flash"],
    "projects": { "claudestra": { "mode": "on" } }
  }
}
```

- `chain` 有序，每项是 provider（取这家排最前的能用模型）或完整模型值（也认只写 id）。只在「能列的」模型里找，同 provider / 已知到顶的不会被选中。
- `projects.<项目 id>` 里写了的字段盖过全局的；没写 / 写坏的字段按全局，全局也没有就是 `observe`、空链。每次出卡现读，改完不用重启。
- `off`：只按上面的规则出卡，不提备用链。
- `observe`（缺省）：照常出卡，正文多一行「按备用链会切到 X（现在是 observe 档，没有自动切）」。
- `on`：撞墙就经宿主 `set_config_option(model, X)` 切到链上第一个能用的，然后出一张通知卡（不是额度卡，不卡活），写明从谁切到谁、原因、原文，
  附「切回 <原模型>」和「知道了」。切失败就照常出额度卡，正文末尾写没切成的原因。撞墙的那一轮不会自动重跑：重发消息或说「继续」。
  同一个失败重报不会再切第二次。

## 恢复后不自动切回

原 provider 恢复了也不自动切回（来回切比停一下更糟，而且恢复时刻常常只是估计）。手动切回：

- 自动切换的通知卡上点「切回 <原模型>」；
- 或在设置页这个 agent 的模型下拉里选回原模型（不重启，经宿主 `set_config_option`）。
