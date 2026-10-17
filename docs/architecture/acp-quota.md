# ACP 额度卡（Codex / Pi）

ACP 会话（Codex 的 codex-acp、Pi 的 ACP 适配器）回合撞了额度，宿主发 `acp_failure{kind:"quota"}`，bridge 出一张「待你处理」卡。
代码：`src/lib/acp/quota-fallback.ts`（纯规则）、`src/lib/acp/config.ts quotaCardChoices`（按钮）、`src/bridge/acp-quota.ts`（取事实）、
`src/bridge/acp-link.ts showQuotaCard`（出卡 / 自动切）。测试：`tests/quota-fallback.test.ts`、`tests/acp-quota-plan.test.ts`、`tests/acp-link.test.ts`。

## 卡上写什么

网页卡只显示正文前 3 行（手机上第 1 行还会折），所以顺序固定：

1. 谁到顶 + 原文摘要（≤80 字）+ 重置时间：`cc-switch-open-code-go 额度到顶：GoUsageLimitError: Go usage limit exceeded；重置 未知`
2. `推荐切到 X`（第一个不是同系列 / 同一家时写「可以切到 X」），或 `只能等重置（原因）`
3. 配了备用链才有：observe「按备用链会切到 X（observe 档，没有自动切）」；on 档没切的原因（审查 / 出借会话、切了没成）；链里没有能用的
4. 之后：当前模型和完整原文、哪些模型没列及原因、怎么切回

- 谁到顶：当前模型值 `provider/id` 的 provider（Pi 的 provider 就是那个账号 / 套餐，如 `cc-switch-open-code-go`）。模型 id 不带前缀（Codex）时写「Codex 当前账号」，见下。
- 原文：provider 回的那句话。认得出 `{type, message}`（或 `error` 里套一层）就写成 `type: message`，否则原样；两种都截到 500 字。完整原文另存 `extra.raw`。
- 重置时间：先从原文解析（`lib/autopilot-run.ts parseResetAt`，认 Claude / Codex 的几种写法）；当前模型确认是 `openai-codex/…` 时再取 Codex 额度快照里到顶窗口的重置时刻；都没有写「未知」。

## 列哪些模型

第一个按钮永远是「等重置」。后面只列真能走通的：

1. **同 provider 的不列**：同一个账号 / 套餐，切过去照样撞墙。provider 取模型值 `provider/id` 斜杠前那段。
   **Codex 的模型 id 不带 provider 前缀**（`gpt-5.6-sol`、`gpt-5.6-luna`）：一个 Codex 会话的模型下拉全部走同一个 provider（适配器的
   `model_provider`，缺省是本机 `codex login` 的 ChatGPT 账号），所以不带斜杠的值互相算同一家（`quota-fallback.ts providerOf` 归到 `openai-codex`）。
   Codex 会话撞额度时卡上只有「等重置」，第 2 行写「只能等重置（同一个账号的另外 N 个模型也用不了）」。
   但 bridge 读不到适配器的 `model_provider`（可能是 cc-switch 之类的第三方），所以不带前缀时**不确认**是 ChatGPT 账号：卡上写「Codex 当前账号」，
   不记进下面的「本机撞墙」记录，也不套用 Codex 额度快照的重置时间。Pi 里明写 `openai-codex/…` 的模型才确认是这一家。
2. **已知同样到顶的 provider 不列**。判断来源只有两个，都是只读：
   - **Codex 额度快照**：`lib/ai-quota.ts readInventoryQuota().codex`（和网页额度看板同一份：订阅接口实时 / 上次成功快照 / 本机 rollout）。
     提供方明确说已撞限（`limitReached`），或某个窗口用到 100% 且没过重置时刻 → `openai-codex` 到顶，到那个窗口的重置时刻为止。
   - **本 bridge 进程里最近撞过墙的 provider**：任何 ACP agent 报过额度失败（且当前模型带 provider 前缀）就记一笔（provider、时刻、解析到的重置时间），到重置时刻失效；
     原文里解析不出重置时间按 3 小时失效。bridge 重启就清空（宁可多列一个，下次撞墙会再记上）。
3. **同系列优先**：模型 id 去掉版本号后相同（`deepseek-v4.1-flash` 与 `deepseek-v4-flash`、`deepseek-flash`）排最前，其次同一家（id 第一段相同），
   其余按下拉原顺序；同档里版本越接近越前。第一个若是同系列 / 同一家，标「（推荐）」。
4. 一个都不剩：只有「等重置」，正文第 2 行写「只能等重置（原因）」：同账号的模型也用不了、哪些 provider 也到顶、或下拉里没有别家的模型。

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
- `on`：审查会话（registry role=reviewer、`agent-rv-*` / `agent-cv-*`）和出借 worker（`agent-lend-*`）不自动切，只出普通额度卡、第 3 行写原因
  （换模型可能悄悄变成同族审查；出借的活不该花本机别家 provider 的额度）。其余会话撞墙就经宿主 `set_config_option(model, X)` 切到链上第一个能用的，然后出一张通知卡（不是额度卡，不卡活），写明从谁切到谁、原因、原文，
  附「切回 <原模型>」和「知道了」。切失败就照常出额度卡，第 3 行写没切成的原因。撞墙的那一轮不会自动重跑：重发消息或说「继续」。
  同一个失败重报（同一个 failure key）不再试切换，切成了没成都一样。

## 恢复后不自动切回

原 provider 恢复了也不自动切回（来回切比停一下更糟，而且恢复时刻常常只是估计）。手动切回：

- 自动切换的通知卡上点「切回 <原模型>」；
- 或在设置页这个 agent 的模型下拉里选回原模型（不重启，经宿主 `set_config_option`）。

## 同一个失败重报

宿主可能把同一个失败报好几次。原文、选项值都没变、卡还没人答，就沿用原卡和它的代际（按钮不作废）。只比选项值、不比按钮文字：
「等重置（11:00）」上的时刻会随时间变（原文写「2 小时后」时晚一分钟重报就不一样）。

## 已知限制

- **通知卡上的「切回」有效期按通知正文算**（不是额度卡，`openRuntimeAsk` 按正文里认得出的时刻算过期）。原 provider 重置前按「切回」会再撞一次墙；
  on 档下又会按链切走。每次都要一次真的失败，不会无限来回；卡上写了「原 provider 重置前切回会再撞一次墙」。
- **Pi 适配器的额度判定本来就宽**（`pi-adapter/map.ts` 认 quota / credits / balance 等字样）：每分钟限流这类也可能被判成额度用完，
  解析不出重置时间时这家会在本机被当成到顶 3 小时，on 档还会切走、不切回。
- **并发出卡**：出卡要先读额度快照（异步），两次失败挨得很近时，先到的那次可能后出卡、顶掉后一次的卡，卡上的「当前模型」可能已经过时。
  选项不受影响（刚切去的那家已经在撞墙记录里）。
- **撞墙记录不会因为之后成功而提前清掉**，只到重置时刻（或 3 小时）失效；Codex 快照说已撞限但没有重置时间时，要等下一次观测才解除。
