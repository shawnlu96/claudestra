/** ACP 传输的桥接策略；不加载 Codex TUI 生命周期。 */
import type { RuntimeControl } from "./types.js";

/**
 * transport=acp 时的策略（T60 试点，docs/runtimes/codex-acp.md）：窗口里是宿主日志，一个键都不发。
 * - 打断走宿主：bridge 发 abort 帧（与 Pi 扩展同一协议），宿主调 session/cancel；
 * - 人类消息到达时不打断：宿主用 _session/steering 插进当前回合，和 Pi 的 steer 一样即时生效；
 * - 忙闲只信宿主上报（prompt 没返回 = 忙）；模型 / 推理强度经 session/set_config_option 改，不重启；
 * - 斜杠命令当 prompt 文本发（/compact 由适配器转成 thread/compact/start）。
 */
export const CODEX_ACP_CONTROL: RuntimeControl = {
  interruptKeys: [],
  preemptOnHumanMessage: false,
  idleSource: "acp",
  modelEnforcement: "config-option",
  paneHeuristics: false,
  abortVia: "extension",
  slashAsPrompt: true,
};
