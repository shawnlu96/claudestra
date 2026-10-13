/**
 * 团队详情读中心正文（team-project-TEAMVIS7）：每次读详情读一次，成功的按卡缓存。
 * 中心 403（不在项目成员里）清空整个缓存：别人的正文不能在失去成员资格后还从缓存里显示。
 * 离线 / 限流等读失败：有缓存用缓存（同步时间照旧显示，看得出是旧的），没有就是 unavailable；中心没开能力位不用缓存。
 */
import { teamBodyFailure, type TeamBodyReadWire, type TeamBodyTransport } from "@/lib/api/shared-ledger-team-body";
import type { TeamBodyLoad } from "./team-body-model";

export interface TeamBodyReader {
  load(featureId: string, taskId: string, signal: AbortSignal): Promise<TeamBodyLoad>;
  /** 缓存了几张卡（测试看 403 清缓存） */
  cached(): number;
}

export function teamBodyReader(transport: () => TeamBodyTransport): TeamBodyReader {
  const cache = new Map<string, TeamBodyReadWire>();
  return {
    async load(featureId, taskId, signal) {
      const k = JSON.stringify([featureId, taskId]);
      try {
        const read = await transport().read(featureId, taskId, signal);
        // bridge 已核过卡号；这里再挡一次换了身份后迟到的别的卡
        if (read.featureId !== featureId || read.taskId !== taskId) return { status: "unavailable" };
        cache.set(k, read);
        return { status: "ok", read };
      } catch (e) {
        if (signal.aborted) throw e;
        const failure = teamBodyFailure(e);
        if (failure === "not_member") cache.clear();
        if (failure !== "unavailable") return { status: failure };
        console.warn(`[team] 读正文失败：${(e as Error).message}`);
        const hit = cache.get(k);
        return hit ? { status: "ok", read: hit } : { status: "unavailable" };
      }
    },
    cached: () => cache.size,
  };
}
