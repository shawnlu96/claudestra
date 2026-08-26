/**
 * v2.9+ registry.json 的唯一读取器 —— 收敛此前散在多个文件里的各自 JSON.parse
 * （bg-activity-watcher / stats-dashboard / cli-install / sessions-inventory 各有
 * 一份，字段容错还不一致：cwd||dir 兼容有的做有的没做）。
 *
 * 写路径不在这里：registry 的 owner 是 manager.ts（create/kill/restart 的 CRUD），
 * bridge 侧一律只读。
 */

import { homedir } from "os";
import { join } from "path";
import { readFile } from "fs/promises";

export const REGISTRY_PATH = join(homedir(), ".claude-orchestrator", "registry.json");

export interface RegistryAgent {
  /** tmux 名（registry key，"agent-xxx"） */
  name: string;
  status?: string;
  channelId?: string;
  sessionId?: string;
  /** 归一后的工作目录（历史数据 cwd / dir 两种字段名都存在过） */
  cwd?: string;
  purpose?: string;
  displayName?: string;
  model?: string;
  effort?: string;
  /** create --external 标记：可安全暴露给 API token / peer（R1 守卫） */
  external?: boolean;
}

/** 全量读取（含非 active）。读失败/文件缺失返回空数组，不抛。 */
export async function readRegistryAgents(registryPath = REGISTRY_PATH): Promise<RegistryAgent[]> {
  try {
    const data = JSON.parse(await readFile(registryPath, "utf-8"));
    const agents = data?.agents;
    if (!agents || typeof agents !== "object") return [];
    return Object.entries(agents).map(([name, v]) => {
      const a = v as Record<string, unknown>;
      const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
      return {
        name,
        status: str("status"),
        channelId: str("channelId"),
        sessionId: str("sessionId"),
        cwd: str("cwd") ?? str("dir"),
        purpose: str("purpose"),
        displayName: str("displayName"),
        model: str("model"),
        effort: str("effort"),
        // ⚠ 布尔字段不走 str() 帮手——external 曾因此被整个丢掉(所有 agent 在
        // /peers 界面显示非 external,Codex review 2026-08-26 抓到的)
        external: a.external === true,
      };
    });
  } catch {
    return [];
  }
}

/** active 状态的 agent（bridge 侧最常用的形态） */
export async function readActiveAgents(registryPath = REGISTRY_PATH): Promise<RegistryAgent[]> {
  return (await readRegistryAgents(registryPath)).filter((a) => a.status === "active");
}
