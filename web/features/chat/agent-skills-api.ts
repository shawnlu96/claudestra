/**
 * 按会话启停技能的接口 +「有改动、还没重启」小 store（纯逻辑在 agent-skills-logic.ts）。
 * 改完要重启才生效（CC 运行中不重读 --settings），所以谁有改动没重启记在这里：关掉弹窗再打开还在，刷新页面会丢，可接受。
 */
import { useSyncExternalStore } from "react";
import { api } from "@/lib/api/client";
import { apiAgentName } from "@/lib/chat/agents";
import type { AgentSkillView, SkillState } from "./agent-skills-logic";

// ── 「有改动、还没重启」的会话（重启成功后清掉） ──
const pending = new Set<string>();
const subs = new Set<() => void>();
let snap = 0;
const emit = () => {
  snap++;
  subs.forEach((f) => f());
};
export function markSkillsPending(agent: string, on: boolean): void {
  if (on ? pending.has(agent) : !pending.has(agent)) return;
  if (on) pending.add(agent);
  else pending.delete(agent);
  emit();
}
const isSkillsPending = (agent: string): boolean => pending.has(agent);
export function useSkillsPending(agent: string): boolean {
  useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => snap,
    () => 0,
  );
  return isSkillsPending(agent);
}

// ── 接口 ──
const agentPath = (name: string) => `/agents/${encodeURIComponent(apiAgentName(name))}/skill-settings`;
export function fetchAgentSkills(name: string): Promise<{ ok: boolean; runtime: string; view: AgentSkillView }> {
  return api(agentPath(name), { timeoutMs: 10_000 });
}
export function setAgentSkill(name: string, skill: string, state: SkillState): Promise<{ ok: boolean; error?: string }> {
  return api(agentPath(name), { method: "POST", json: { skill, state }, timeoutMs: 30_000 });
}
