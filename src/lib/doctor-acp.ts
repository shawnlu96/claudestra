/** Codex ACP 迁移健康检查；doctor 只读，不试图安装或重启。 */
import { checkAcpReady, type AcpReady } from "./acp/readiness.js";
import { CODEX_ACP_PAIRS, CODEX_ACP_VERSION, codexPairsWithAdapter } from "./acp/install.js";
import { probeClaudeVersion } from "./claude-binary.js";
import { defaultRunner } from "./codex-thread.js";
import { readRegistryAgents, type RegistryAgent } from "./registry.js";
import type { Check } from "./doctor.js";

/**
 * 本机 codex 与固定版本适配器是否配套。只报告：宿主对不配套的版本也只是告警、照常起（acp-host.ts），readiness 不看版本，
 * 所以这里是唯一能在出事前看到错配的地方。version：null = 探不出，undefined = 没探（CLI 不可用 / 沙箱 stub）不报。
 */
function pairingCheck(version: string | null | undefined, activeAcp: number): Check[] {
  if (version === undefined) return [];
  const group = "Codex ACP";
  if (version && codexPairsWithAdapter(version)) {
    return [{ group, name: "Codex 与适配器配套", status: "ok", detail: `codex ${version} 在 codex-acp ${CODEX_ACP_VERSION} 的配套范围（${CODEX_ACP_PAIRS}）内` }];
  }
  return [{
    group, name: "Codex 与适配器配套", status: "warn",
    detail: `${version ? `本机 codex ${version}` : "读不出本机 codex 的版本"}，codex-acp ${CODEX_ACP_VERSION} 配套的是 ${CODEX_ACP_PAIRS}`
      + `；${activeAcp} 个 ACP agent 照常运行（宿主只告警不拒起），但这个组合没经过配套验证`,
    fix: `等适配器升级（lib/acp/install.ts 的版本、sha256 与 CODEX_ACP_PAIRS 一起改），或把 codex 换回 ${CODEX_ACP_PAIRS}；网页不会提示升到不配套的版本`,
  }];
}

export function acpDoctorChecks(agents: RegistryAgent[], ready: AcpReady, codexVersion?: string | null): Check[] {
  const codex = agents.filter((a) => a.runtime === "codex");
  const pending = codex.filter((a) => a.acpPending);
  const unmigrated = codex.filter((a) => a.transport === undefined && !a.acpPending);
  const restart = codex.filter((a) => a.acpRestartPending);
  const activeAcp = codex.filter((a) => a.transport === "acp");
  const group = "Codex ACP";
  const checks: Check[] = [{
    group, name: "适配器和 app-server", status: ready.ok ? "ok" : activeAcp.length ? "fail" : "warn",
    detail: ready.ok ? "固定版本适配器 sha256 正确，Codex CLI 有 app-server" : ready.reason,
    ...(!ready.ok ? { fix: "运行 bun src/manager.ts migrate --acp；下载仍失败时现有 Codex 留在 tmux" } : {}),
  }];
  checks.push({ group, name: "registry 迁移", status: unmigrated.length ? "warn" : "ok",
    detail: unmigrated.length ? `${unmigrated.length} 个旧 Codex agent 缺 transport 字段` : `${codex.length} 个 Codex agent 的 transport 已明确`,
    ...(unmigrated.length ? { fix: "运行 bun src/manager.ts migrate --acp" } : {}),
  });
  checks.push(...pairingCheck(codexVersion, activeAcp.length));
  if (pending.length) checks.push({ group, name: "tmux 暂退", status: "warn", detail: `${pending.map((a) => a.name).join(", ")} 等待 ACP 条件恢复`,
    fix: "修好上面的适配器或 CLI 后运行 bun src/manager.ts migrate --acp" });
  if (restart.length) checks.push({ group, name: "待重启", status: "warn", detail: `${restart.map((a) => a.name).join(", ")} 尚未以 registry 的 transport 启动`,
    fix: "运行 bun src/manager.ts migrate --acp 重试" });
  return checks;
}

export async function checkCodexAcp(): Promise<Check[]> {
  const [agents, ready] = await Promise.all([readRegistryAgents(), checkAcpReady(false)]);
  const bin = ready.ok ? ready.codexBin : undefined; // 沙箱 stub 没有 codexBin：不探
  const version = bin ? await probeClaudeVersion(defaultRunner, bin).catch(() => null) : undefined; // 探失败 = 「读不出版本」照样报 warn
  return acpDoctorChecks(agents, ready, version);
}
