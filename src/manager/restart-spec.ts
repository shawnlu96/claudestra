/** 沿用 registry 的原线程和运行配置，通用重启与空闲迁移共用同一份 launch spec。 */
import { resolveBridgeUrl } from "../lib/bridge-url.js";
import { normalizePiEnvProfile } from "../lib/pi-env.js";
import type { LaunchSpec } from "../lib/runtimes/index.js";
import type { loadRegistry } from "./core.js";
export function restartSpec(tmuxName: string, info: Awaited<ReturnType<typeof loadRegistry>>["agents"][string]): LaunchSpec {
  if (!info?.sessionId || !info.channelId) throw new Error("缺少 sessionId / channelId，拒绝启动");
  const displayName = info.displayName || tmuxName.replace(/^agent-/, "");
  const purposeForInject = info.purpose && !info.purpose.startsWith("resumed:") ? info.purpose : undefined;
  return {
      mode: "resume",
      channelId: info.channelId,
      bridgeUrl: resolveBridgeUrl(),
      sessionId: info.sessionId,
      displayName,
      effort: info.effort,
      // 老 agent（feature 前建的）info.permissionMode 为空 → 启动器回退 bypassPermissions
      permissionMode: info.permissionMode,
      // v2.4.20+ 显式 --model 覆盖 --resume 钉死的会话原模型（"改全局无效"的解法）
      model: info.model,
      purpose: purposeForInject,
      agentName: tmuxName,
      ...(info.cwd ? { cwd: info.cwd } : {}),
      extras: {
        disallowedPreset: info.disallowedPreset,
        disallowedRaw: info.disallowedRaw,
        // v2.23+ 能力档案、编排班子角色（lib/team-roles.ts）随 registry 复现，否则重启后静默变回「继承全局」/ 丢角色
        piEnv: normalizePiEnvProfile(info.piEnv), role: info.role,
      },
    };
}
