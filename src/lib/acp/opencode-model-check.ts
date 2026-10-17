/**
 * OpenCode 的模型必须真的生效：它不认的模型不报错，会静默回落到缺省的免费 big-pickle（docs/runtimes/opencode-acp.md「失败形状」）。
 * 新建（runtimes/opencode-acp.ts prepareSession）和宿主每次接上会话（host-runtime.ts RUNTIMES.opencode.enforceLaunch）都过这一道：
 * set_config_option 之后按会话自己报的 currentValue 核对，对不上就抛 AcpIncompatibleError（宿主据此拒起、不重试）。
 */
import { currentValueOf, resolveConfigValue } from "./config.js";
import { AcpIncompatibleError } from "./protocol.js";
import type { AcpSession } from "./session.js";

export async function enforceOpencodeModel(s: Pick<AcpSession, "configOptions" | "setConfig">, model: string | undefined): Promise<void> {
  const want = model?.trim();
  const actual = () => currentValueOf(s.configOptions, "model") ?? "未知";
  if (!want) throw new AcpIncompatibleError(`OpenCode agent 没有登记模型，不起（实际会落到 ${actual()}）`);
  const r = await s.setConfig("model", want);
  const value = resolveConfigValue(s.configOptions, "model", want);
  if (r.ok && currentValueOf(s.configOptions, "model") === value) return;
  throw new AcpIncompatibleError(`OpenCode 模型没生效：给的 ${want}，实际 ${actual()}${r.ok ? "" : `（${r.error}）`}`);
}
