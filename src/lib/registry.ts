/**
 * v2.9+ registry.json 的唯一读取器 —— 收敛此前散在多个文件里的各自 JSON.parse
 * （bg-activity-watcher / stats-dashboard / cli-install / sessions-inventory 各有
 * 一份，字段容错还不一致：cwd||dir 兼容有的做有的没做）。
 *
 * 写路径不在这里：registry 的 owner 是 manager.ts（create/kill/restart 的 CRUD），
 * bridge 侧一律只读。
 */

import { REGISTRY_PATH as STATE_REGISTRY_PATH } from "./paths.js";
import { readFile } from "fs/promises";

export const REGISTRY_PATH = STATE_REGISTRY_PATH;

/** v2.23+ agent 运行时。缺失/未知一律当 `claude-code`——宁可走老路，不猜新路 */
export type AgentRuntime = "claude-code" | "pi" | "codex";

/** 从 agent 记录判定运行时（registry 字段缺失 = 历史 agent = Claude Code） */
/**
 * 这个名字指的是不是大总管。
 *
 * ⚠ 两种写法都得认：registry 的**键**是 `agent-master`，而它的 tmux 窗口名（launcher
 * 显式定名为 MASTER_WINDOW_NAME；老窗口由 launcher 迁移）和各处 CLI 参数用的是裸 `master`。只认一种，就会出现「同一个东西在两处对不上」
 * 的分叉——`principals.ts` 的 R1 guard 早就踩过（只认 `master` 时 `*` token 能经
 * `agent-master` 绕过 master 排除），`manager.ts list` 这次踩的是另一头。
 */
export function isMasterAgent(name: string | undefined | null): boolean {
  return name === "master" || name === "agent-master";
}

export function agentRuntime(info: { runtime?: string } | undefined | null): AgentRuntime {
  const r = info?.runtime;
  return r === "pi" || r === "codex" ? r : "claude-code";
}

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
  /** v2.21+ 归属 project 的 id(projects.json)。⚠ 与遗留的 project 字段无关——那存的是原始 dir */
  projectId?: string;
  /** v2.23+ 运行时（"pi" / "codex" / "claude-code"）。缺失 = 老 agent = claude-code */
  runtime?: string;
  /** v2.23+ Pi 能力档案（Pi agent 专用）：带哪些扩展/技能/工具/MCP。缺失 = 继承全局 */
  piEnv?: Record<string, unknown>;
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
        projectId: str("projectId"),
        // ⚠ 同样是白名单式读取：registry 里写了 runtime 但这里漏读 = 静默丢失，
        // 下游会把 Pi agent 当 Claude Code 起（读成 undefined 不报错，这坑踩过一次）
        runtime: str("runtime"),
        // 嵌套对象：不是对象就当没有（脏数据不能把 bridge 搞崩）
        piEnv: a.piEnv && typeof a.piEnv === "object" ? (a.piEnv as Record<string, unknown>) : undefined,
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
