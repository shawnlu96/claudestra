/**
 * OpenCode 的模型必须真的生效：它不认的模型不报错，会静默回落到缺省的免费 big-pickle（docs/runtimes/opencode-acp.md「失败形状」）。
 * 新建（runtimes/opencode-acp.ts prepareSession）和宿主每次接上会话（host-runtime.ts RUNTIMES.opencode.enforceLaunch）都过这一道。
 * - 逐字相等：registry 写的 id 必须就是会话选项里的值、设完 currentValue 也是它。不做 resolveConfigValue 那种「只给后半段也认」：
 *   `anthropic/x` 会被解析到 `openrouter/anthropic/x`，静默换了 provider；只给后半段的，报出全名让人写全。
 * - 值不被接受 / 设完对不上 → AcpIncompatibleError（宿主拒起、不重试）；RPC 超时、OpenCode 中途崩溃 → 普通 Error（宿主退避重起）。
 */
import { configRefusal, currentValueOf, resolveConfigValue } from "./config.js";
import { AcpIncompatibleError } from "./protocol.js";
import type { AcpSession } from "./session.js";

export async function enforceOpencodeModel(s: Pick<AcpSession, "configOptions" | "setConfig">, model: string | undefined): Promise<void> {
  const want = model?.trim();
  const actual = () => currentValueOf(s.configOptions, "model") ?? "未知";
  if (!want) throw new AcpIncompatibleError(`OpenCode agent 没有登记模型，不起（实际会落到 ${actual()}）`);
  const refused = configRefusal(s.configOptions, "model", want);
  if (refused) {
    const full = resolveConfigValue(s.configOptions, "model", want);
    const hint = full !== want ? `；要用这个模型请写全 ${full}（逐字匹配，免得被换到别的 provider）` : "";
    throw new AcpIncompatibleError(`OpenCode 模型不被接受：给的 ${want}，实际 ${actual()}（${refused}）${hint}`);
  }
  const r = await s.setConfig("model", want);
  if (!r.ok) throw new Error(`OpenCode 设模型 ${want} 时出错（不是模型不被接受，会重试）：${r.error}`);
  if (currentValueOf(s.configOptions, "model") !== want) throw new AcpIncompatibleError(`OpenCode 模型没生效：给的 ${want}，实际 ${actual()}`);
}
