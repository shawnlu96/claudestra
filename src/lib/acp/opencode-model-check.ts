/**
 * OpenCode 的模型必须真的生效：它不认的模型不报错，会静默回落到缺省的免费 big-pickle（docs/runtimes/opencode-acp.md「失败形状」）。
 * 新建（runtimes/opencode-acp.ts prepareSession）和宿主每次接上会话（host-runtime.ts RUNTIMES.opencode.enforceLaunch）都过这一道。
 * - 逐字相等：registry 写的 id 必须就是会话选项里的值、设完 currentValue 也是它。带斜杠的不做「只给后半段也认」：
 *   `anthropic/x` 会被解析到 `openrouter/anthropic/x`，静默换了 provider，报出全名让人写全。不带 provider 的裸 id 只在恰好一家有它时
 *   换成完整 id（返回值），宿主回写 registry（host.ts applyLaunch）；新建时不放行裸 id。
 * - 值不被接受（本地选项里没有、或 OpenCode 回 -32602 Invalid params，如 Model not found）/ 设完对不上 → AcpIncompatibleError（宿主拒起、不重试）；
 *   RPC 超时、OpenCode 中途崩溃、其它 JSON-RPC 错误 → 普通 Error（宿主退避重起）。
 */
import { configRefusal, currentValueOf, resolveConfigValue } from "./config.js";
import { AcpIncompatibleError } from "./protocol.js";
import type { AcpSession } from "./session.js";

/** JSON-RPC 2.0 的 Invalid params：OpenCode 对不认的模型回这个（tests/fixtures/opencode-acp/model-switch.jsonl） */
const INVALID_PARAMS = -32602;

export async function enforceOpencodeModel(
  s: Pick<AcpSession, "configOptions" | "setConfig">, model: string | undefined, opts: { allowBare?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const given = model?.trim();
  const actual = () => currentValueOf(s.configOptions, "model") ?? "未知";
  if (!given) throw new AcpIncompatibleError(`OpenCode agent 没有登记模型，不起（实际会落到 ${actual()}）`);
  const want = bareToFull(s.configOptions, given, opts.allowBare !== false);
  const refused = configRefusal(s.configOptions, "model", want);
  if (refused) {
    const full = resolveConfigValue(s.configOptions, "model", given);
    const hint = full !== given ? `；要用这个模型请写全 ${full}（逐字匹配，免得被换到别的 provider）` : "";
    throw new AcpIncompatibleError(`OpenCode 模型不被接受：给的 ${given}，实际 ${actual()}（${refused}）${hint}`);
  }
  const r = await s.setConfig("model", want, opts.timeoutMs);
  if (!r.ok && r.code === INVALID_PARAMS) throw new AcpIncompatibleError(`OpenCode 模型不被接受：给的 ${given}，实际 ${actual()}（${r.error}）`);
  if (!r.ok) throw new Error(`OpenCode 设模型 ${want} 时出错（不是模型不被接受，会重试）：${r.error}`);
  if (currentValueOf(s.configOptions, "model") !== want) throw new AcpIncompatibleError(`OpenCode 模型没生效：给的 ${given}，实际 ${actual()}`);
  return want;
}

/**
 * 不带 provider 的裸 id（`big-pickle`，早先 registry 里可能存的就是这种）：选项里恰好一家有它才换成完整 id；带斜杠的一律原样（逐字核对）。
 * 新建时不放行（allowBare=false）：人就在弹窗 / 命令行前，直接报全名让他写全，免得回写 registry 和 manager 落盘抢先后
 */
function bareToFull(opts: AcpSession["configOptions"], id: string, allowBare: boolean): string {
  if (!allowBare || id.includes("/")) return id;
  const full = resolveConfigValue(opts, "model", id);
  return full.includes("/") ? full : id;
}
