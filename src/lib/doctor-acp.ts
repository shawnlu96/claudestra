/** Codex ACP 迁移健康检查；doctor 只读，不试图安装或重启。 */
import { checkAcpReady, type AcpReady } from "./acp/readiness.js";
import { readRegistryAgents, type RegistryAgent } from "./registry.js";
import type { Check } from "./doctor.js";

export function acpDoctorChecks(agents: RegistryAgent[], ready: AcpReady): Check[] {
  const codex = agents.filter((a) => a.runtime === "codex");
  const pending = codex.filter((a) => a.acpPending);
  const unmigrated = codex.filter((a) => a.transport === undefined && !a.acpPending);
  const restart = codex.filter((a) => a.acpRestartPending);
  const activeAcp = codex.filter((a) => a.transport === "acp");
  const group = "Codex ACP";
  const checks: Check[] = [{
    group, name: "适配器和 app-server", status: ready.ok ? "ok" : activeAcp.length ? "fail" : "warn",
    detail: ready.ok ? "固定版本适配器 sha256 正确，Codex CLI 有 app-server" : ready.reason,
    ...(!ready.ok ? { fix: "运行 bun src/manager.ts migrate；下载仍失败时现有 Codex 留在 tmux" } : {}),
  }];
  checks.push({ group, name: "registry 迁移", status: unmigrated.length ? "warn" : "ok",
    detail: unmigrated.length ? `${unmigrated.length} 个旧 Codex agent 缺 transport 字段` : `${codex.length} 个 Codex agent 的 transport 已明确`,
    ...(unmigrated.length ? { fix: "运行 bun src/manager.ts migrate" } : {}),
  });
  if (pending.length) checks.push({ group, name: "tmux 暂退", status: "warn", detail: `${pending.map((a) => a.name).join(", ")} 等待 ACP 条件恢复`,
    fix: "修好上面的适配器或 CLI 后运行 bun src/manager.ts migrate" });
  if (restart.length) checks.push({ group, name: "待重启", status: "warn", detail: `${restart.map((a) => a.name).join(", ")} 尚未以 registry 的 transport 启动`,
    fix: "运行 bun src/manager.ts migrate 重试" });
  return checks;
}

export async function checkCodexAcp(): Promise<Check[]> {
  const [agents, ready] = await Promise.all([readRegistryAgents(), checkAcpReady(false)]);
  return acpDoctorChecks(agents, ready);
}
