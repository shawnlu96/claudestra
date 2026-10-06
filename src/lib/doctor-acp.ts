/** Codex / Pi 的 ACP 健康检查；doctor 只读，不试图安装或重启。 */
import { checkAcpReady, probePiAcp, type AcpReady } from "./acp/readiness.js";
import { currentCodexAcp, type AdapterNow } from "./acp/install.js";
import { rangeAllows } from "./acp/resolve.js";
import { probeClaudeVersion } from "./claude-binary.js";
import { defaultRunner } from "./codex-thread.js";
import { readRegistryAgents, type RegistryAgent } from "./registry.js";
import { piAcpClash } from "./runtimes/pi-acp.js";
import type { Check } from "./doctor.js";

/**
 * 本机 codex 与当前适配器是否配套。只报告：宿主对不配套的版本也只是告警、照常起（codex-version.ts），readiness 只在自动安装时
 * 按版本挑适配器，所以这里是能在出事前看到错配的地方。version：null = 探不出，undefined = 没探（CLI 不可用 / 沙箱 stub）不报。
 */
function pairingCheck(version: string | null | undefined, activeAcp: number, adapter: AdapterNow): Check[] {
  if (version === undefined || !adapter) return [];
  const group = "Codex ACP";
  if (adapter === "broken") {
    return [{ group, name: "Codex 与适配器配套", status: "warn", detail: "codex-acp 的版本指针或标记坏了，不知道当前用的是哪个适配器",
      fix: "运行 bun src/manager.ts acp-install 重新装上能配本机 codex 的适配器" }];
  }
  const pairs = `codex-acp ${adapter.version} 的配套范围（${adapter.codexRange}）`;
  if (version && rangeAllows(adapter.codexRange, version)) {
    return [{ group, name: "Codex 与适配器配套", status: "ok", detail: `codex ${version} 在 ${pairs}内` }];
  }
  return [{
    group, name: "Codex 与适配器配套", status: "warn",
    detail: `${version ? `本机 codex ${version}` : "读不出本机 codex 的版本"}，不在 ${pairs}内`
      + `；${activeAcp} 个 ACP agent 照常运行（宿主只告警不拒起），但这个组合没经过配套验证`,
    fix: "运行 bun src/manager.ts acp-install 换上能配本机 codex 的最新适配器（npm 上还没有就等上游发版）",
  }];
}

export function acpDoctorChecks(agents: RegistryAgent[], ready: AcpReady, codexVersion?: string | null, adapter: AdapterNow = currentCodexAcp()): Check[] {
  const codex = agents.filter((a) => a.runtime === "codex");
  const pending = codex.filter((a) => a.acpPending);
  const unmigrated = codex.filter((a) => a.transport === undefined && !a.acpPending);
  const restart = codex.filter((a) => a.acpRestartPending);
  const activeAcp = codex.filter((a) => a.transport === "acp");
  const group = "Codex ACP";
  const checks: Check[] = [{
    group, name: "适配器和 app-server", status: ready.ok ? "ok" : activeAcp.length ? "fail" : "warn",
    detail: ready.ok ? `${adapter && adapter !== "broken" ? `codex-acp ${adapter.version}（配 codex ${adapter.codexRange}）` : "ACP stub"} 校验通过，Codex CLI 有 app-server` : ready.reason,
    ...(!ready.ok ? { fix: "运行 bun src/manager.ts migrate --acp；下载仍失败时现有 Codex 留在 tmux" } : {}),
  }];
  checks.push({ group, name: "registry 迁移", status: unmigrated.length ? "warn" : "ok",
    detail: unmigrated.length ? `${unmigrated.length} 个旧 Codex agent 缺 transport 字段` : `${codex.length} 个 Codex agent 的 transport 已明确`,
    ...(unmigrated.length ? { fix: "运行 bun src/manager.ts migrate --acp" } : {}),
  });
  checks.push(...pairingCheck(codexVersion, activeAcp.length, adapter));
  if (pending.length) checks.push({ group, name: "tmux 暂退", status: "warn", detail: `${pending.map((a) => a.name).join(", ")} 等待 ACP 条件恢复`,
    fix: "修好上面的适配器或 CLI 后运行 bun src/manager.ts migrate --acp" });
  if (restart.length) checks.push({ group, name: "待重启", status: "warn", detail: `${restart.map((a) => a.name).join(", ")} 尚未以 registry 的 transport 启动`,
    fix: "运行 bun src/manager.ts migrate --acp 重试" });
  return checks;
}

async function checkCodexAcp(): Promise<Check[]> {
  const [agents, ready] = await Promise.all([readRegistryAgents(), checkAcpReady(false)]);
  const bin = ready.ok ? ready.codexBin : undefined; // 沙箱 stub 没有 codexBin：不探
  const version = bin ? await probeClaudeVersion(defaultRunner, bin).catch(() => null) : undefined; // 探失败 = 「读不出版本」照样报 warn
  return acpDoctorChecks(agents, ready, version);
}

const isPiAcp = (a: RegistryAgent) => a.runtime === "pi" && a.transport === "acp";

/**
 * ACP 版 Pi 的前置条件（没有 transport=acp 的 Pi 就不报）：pi 版本（probePiAcp，迁移 / 启动用的同一道闸），每个 agent 的同名 MCP 与
 * 能力档里的 reply（piAcpClash，transport 命令和启动命令拦的同一处）。不满足的下次重启会被拒起，或起来了模型没有 reply。
 */
export function piAcpDoctorChecks(agents: RegistryAgent[], ready: AcpReady, clash = (a: RegistryAgent) => piAcpClash(a.cwd, process.env, a.piEnv)): Check[] {
  const pi = agents.filter(isPiAcp);
  if (!pi.length) return [];
  const group = "Pi ACP";
  const bad = pi.map((a) => ({ name: a.name, why: clash(a) })).filter((x) => x.why);
  return [
    { group, name: "pi 版本", status: ready.ok ? "ok" : "fail", detail: ready.ok ? `${pi.length} 个 ACP 版 Pi，pi 版本够用` : ready.reason,
      ...(!ready.ok ? { fix: "跑 pi update 后重启这些 agent；要先退回就 bun src/manager.ts migrate --pi <agent> --to tmux" } : {}) },
    { group, name: "同名 MCP / reply 工具", status: bad.length ? "fail" : "ok",
      detail: bad.length ? bad.map((x) => `${x.name}：${x.why}`).join("；") : "没有同名 MCP server，能力档都保留了 reply",
      ...(bad.length ? { fix: "按提示改名 / 删掉同名 server，或在能力档里放开 reply；改好前这些 agent 重启会被拒起" } : {}) },
  ];
}

async function checkPiAcp(): Promise<Check[]> {
  const agents = await readRegistryAgents();
  if (!agents.some(isPiAcp)) return []; // 没有就不探 pi
  return piAcpDoctorChecks(agents, await probePiAcp());
}

export async function checkAcp(): Promise<Check[]> {
  return (await Promise.all([checkCodexAcp(), checkPiAcp()])).flat();
}
