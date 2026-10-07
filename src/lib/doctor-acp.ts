/** Codex / Pi 的 ACP 健康检查；doctor 只读，不试图安装或重启。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAcpReady, probePiAcp, type AcpReady } from "./acp/readiness.js";
import { identityLine } from "./acp/codex-compat.js";
import { adapterFor, readAdapterChoice, type AdapterChoice, type CodexAdapterId } from "./acp/codex-compat-switch.js";
import { readCodexRunningHost } from "./codex-version.js";
import { currentCodexAcp, type AdapterNow } from "./acp/install.js";
import { rangeAllows } from "./acp/resolve.js";
import { probeClaudeVersion } from "./claude-binary.js";
import { defaultRunner } from "./codex-thread.js";
import { readRegistryAgents, type RegistryAgent } from "./registry.js";
import { acpLogDir } from "./log-paths.js";
import { isLendWorkerName } from "./lend-workers-view.js";
import { piAcpClash } from "./runtimes/pi-acp.js";
import type { Check } from "./doctor.js";

/**
 * 本机 codex 与当前适配器是否配套。只报告：宿主对不配套的版本也只是告警、照常起（codex-version.ts），readiness 只在自动安装时
 * 按版本挑适配器，所以这里是能在出事前看到错配的地方。version：null = 探不出，undefined = 没探（CLI 不可用 / 沙箱 stub）不报。
 */
function pairingCheck(version: string | null | undefined, activeAcp: number, adapter: AdapterNow, selfOk = false): Check[] {
  if (version === undefined) return [];
  const group = "Codex ACP";
  // 选了自研且协议判兼容：上游范围只管还跑上游的（出借 worker、切换前起的宿主）；一个都没有就不比
  if (selfOk && !activeAcp) {
    return [{ group, name: "Codex 与适配器配套", status: "ok", detail: "选了自研且按协议判兼容（见「自研适配器组合」），没有在跑上游 codex-acp 的 ACP agent，不比上游范围" }];
  }
  if (!adapter) return [];
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
      + `；${activeAcp} 个${selfOk ? "仍跑上游的" : ""} ACP agent 照常运行（宿主只告警不拒起），但这个组合没经过配套验证`,
    fix: "运行 bun src/manager.ts acp-install 换上能配本机 codex 的最新适配器（npm 上还没有就等上游发版）",
  }];
}

/** 「适配器和 app-server」里怎么称呼：选了自研且判兼容是自研，否则是装着的 codex-acp（沙箱是 stub） */
const adapterLabel = (ready: AcpReady, adapter: AdapterNow) =>
  ready.ok && ready.adapter === "self" ? "自研 Codex 适配器" : adapter && adapter !== "broken" ? `codex-acp ${adapter.version}（配 codex ${adapter.codexRange}）` : "ACP stub";

/** registry 里还算活着的（没写状态的老条目也算）：停掉的出借 worker 动辄上百个，不该进计数 */
const isLive = (a: RegistryAgent) => !a.status || a.status === "active";

/** usesUpstream：选了自研时，哪些活着的 ACP agent 实际还跑上游（缺省全算）；只有它们才跟上游的配套范围比 */
export function acpDoctorChecks(agents: RegistryAgent[], ready: AcpReady, codexVersion?: string | null, adapter: AdapterNow = currentCodexAcp(),
  usesUpstream: (a: RegistryAgent) => boolean = () => true): Check[] {
  const codex = agents.filter((a) => a.runtime === "codex");
  const pending = codex.filter((a) => a.acpPending);
  const unmigrated = codex.filter((a) => a.transport === undefined && !a.acpPending);
  const restart = codex.filter((a) => a.acpRestartPending);
  const activeAcp = codex.filter((a) => a.transport === "acp" && isLive(a));
  const selfOk = ready.ok && ready.adapter === "self";
  const group = "Codex ACP";
  const checks: Check[] = [{
    group, name: "适配器和 app-server", status: ready.ok ? "ok" : activeAcp.length ? "fail" : "warn",
    detail: ready.ok ? `${adapterLabel(ready, adapter)} 校验通过，Codex CLI 有 app-server` : ready.reason,
    ...(!ready.ok ? { fix: "运行 bun src/manager.ts migrate --acp；下载仍失败时现有 Codex 留在 tmux" } : {}),
  }];
  checks.push({ group, name: "registry 迁移", status: unmigrated.length ? "warn" : "ok",
    detail: unmigrated.length ? `${unmigrated.length} 个旧 Codex agent 缺 transport 字段` : `${codex.length} 个 Codex agent 的 transport 已明确`,
    ...(unmigrated.length ? { fix: "运行 bun src/manager.ts migrate --acp" } : {}),
  });
  checks.push(...pairingCheck(codexVersion, (selfOk ? activeAcp.filter(usesUpstream) : activeAcp).length, adapter, selfOk));
  if (pending.length) checks.push({ group, name: "tmux 暂退", status: "warn", detail: `${pending.map((a) => a.name).join(", ")} 等待 ACP 条件恢复`,
    fix: "修好上面的适配器或 CLI 后运行 bun src/manager.ts migrate --acp" });
  if (restart.length) checks.push({ group, name: "待重启", status: "warn", detail: `${restart.map((a) => a.name).join(", ")} 尚未以 registry 的 transport 启动`,
    fix: "运行 bun src/manager.ts migrate --acp 重试" });
  return checks;
}

/**
 * 自研适配器（选择开关里全局或任一 agent 选了 self 才报）：组合身份 + 协议判定，和每个选了自研的 ACP agent 实际在跑哪个。
 * ready 是按「选了自研」跑的那一次就绪判定：adapter=self 即本机 codex 判兼容；upstream + selfRefused 即判不过、宿主会退回上游。
 */
export function selfAdapterChecks(agents: RegistryAgent[], ready: AcpReady, choice: AdapterChoice, running: (agent: string) => CodexAdapterId | undefined,
  evidence: (agent: string) => HostEvidence = (a) => hostRefusedEvidence(a)): Check[] {
  const chosen = agents.filter((a) => a.runtime === "codex" && adapterFor(choice, a.name) === "self");
  if (choice.default !== "self" && !chosen.length) return [];
  const group = "Codex ACP";
  const scope = choice.default === "self" ? "全局选了自研" : `${chosen.map((a) => a.name).join(", ")} 选了自研`;
  const checks: Check[] = [];
  if (ready.ok && ready.compat?.identity) {
    const diff = ready.compat.reasons.length ? `；协议差异 ${ready.compat.reasons.length} 条：${ready.compat.reasons.slice(0, 3).join("；")}` : "";
    checks.push(ready.adapter === "self"
      ? { group, name: "自研适配器组合", status: "ok", detail: `${scope}：${identityLine(ready.compat.identity)}，按 app-server 协议判兼容${diff}` }
      : { group, name: "自研适配器组合", status: "warn", detail: `${scope}，但用不了、宿主会起上游：${ready.selfRefused}（${identityLine(ready.compat.identity)}）`,
        fix: "等自研适配器跟上这版 codex（锁文件见 docs/runtimes/codex-adapter.md），或 bun src/manager.ts codex-adapter rollback 切回上游" });
  } else if (ready.ok) {
    checks.push({ group, name: "自研适配器组合", status: "warn", detail: `${scope}，但${ready.selfRefused ?? "判不出组合身份"}；宿主会起上游`,
      fix: "bun src/manager.ts codex-adapter rollback 切回上游，或修好 codex 后重启这些 agent" });
  }
  // 只看活着的 ACP agent；出借 worker 按设计永远上游（adapter-proc.ts）。跑着上游的分两类：宿主记下（或日志里有）「自研用不了」= 回退，
  // 没有 = 切自研之前就起的老宿主，重启才换
  const onUpstream = chosen.filter((a) => a.transport === "acp" && isLive(a) && !isLendWorkerName(a.name) && running(a.name) === "upstream");
  const fell = onUpstream.filter((a) => evidence(a.name).refused);
  const stale = onUpstream.filter((a) => !fell.includes(a));
  if (fell.length) checks.push({ group, name: "自研适配器回退", status: "warn", detail: `${fell.map((a) => a.name).join(", ")} 选了自研，宿主这次起时判自研用不了、已退回上游`,
    fix: "看这些 agent 的 host.log 里「自研 Codex 适配器用不了」那一行；修好后 restart，或 codex-adapter rollback 不再试自研" });
  if (stale.length) checks.push({ group, name: "待重启才换自研", status: "warn", detail: `${stale.map((a) => a.name).join(", ")} 的宿主是以上游起的（日志里没有自研被拒的记录，多半是切自研之前起的）`,
    fix: "空闲时逐个 bun src/manager.ts restart <agent>，宿主重启后改用自研" });
  return checks;
}

/** 宿主最近一次启动的日志证据：这一次有没有走过「自研用不了、退回上游」的分支 */
export interface HostEvidence { refused: boolean }
const HOST_START = "ACP 宿主启动：";
const SELF_REFUSED = "自研 Codex 适配器用不了";
const tsOf = (line: string) => Date.parse(line.slice(0, 24));

/** 起之前判协议的那行（pickCodexAdapter）紧挨在启动行前面、同一时刻写（acp-host.ts）；起来后接不上线程再退一次的那行在启动行之后 */
export function hostEvidence(log: string): HostEvidence {
  const lines = log.split("\n");
  let s = lines.length - 1;
  while (s >= 0 && !lines[s]!.includes(HOST_START)) s--;
  if (s < 0) return { refused: false };
  const startedAt = tsOf(lines[s]!);
  // 只认同一时刻（5 秒内）写的：再往前是上一个宿主的日志
  const before = lines.slice(Math.max(0, s - 3), s).some((l) => l.includes(SELF_REFUSED) && Math.abs(tsOf(l) - startedAt) <= 5_000);
  return { refused: before || lines.slice(s + 1).some((l) => l.includes(SELF_REFUSED)) };
}

/**
 * 读整份连同轮转出去的 .1（appendLogLine 只留一代）：启动行和启动前的拒绝行在开头，截尾就丢证据。再轮转一次照样会丢，
 * 所以只给不记 selfRefused 的老宿主兜底（hostRefusedEvidence）。只对还跑上游的活 agent 读，doctor 也不常跑
 */
export function readHostEvidence(agent: string, file = join(acpLogDir(agent), "host.log")): HostEvidence {
  return hostEvidence([`${file}.1`, file].map(readOrEmpty).join("\n"));
}
function readOrEmpty(file: string): string {
  try { return readFileSync(file, "utf8"); } catch { return ""; /* 没有这份（没轮转过 / 没以 ACP 起过 / 被清）：没有回退的证据，归到「待重启」 */ }
}

/** 宿主这一代有没有走过自研拒绝分支：新宿主每次起适配器前把 selfRefused 写进运行记录（不随日志轮转丢）；老宿主的记录没这个字段，退回读日志 */
export function hostRefusedEvidence(agent: string, dir?: string, file?: string): HostEvidence {
  const r = readCodexRunningHost(agent, dir).selfRefused;
  return r === undefined ? readHostEvidence(agent, file) : { refused: r };
}

async function checkCodexAcp(): Promise<Check[]> {
  const choice = readAdapterChoice();
  const agents = await readRegistryAgents();
  const anySelf = choice.default === "self" || agents.some((a) => a.runtime === "codex" && adapterFor(choice, a.name) === "self");
  const ready = await checkAcpReady(false, anySelf ? { selected: () => "self" } : {});
  const bin = ready.ok ? ready.codexBin : undefined; // 沙箱 stub 没有 codexBin：不探
  const version = bin ? await probeClaudeVersion(defaultRunner, bin).catch(() => null) : undefined; // 探失败 = 「读不出版本」照样报 warn
  const running = (a: string) => readCodexRunningHost(a).adapter;
  const usesUpstream = (a: RegistryAgent) => isLendWorkerName(a.name) || adapterFor(choice, a.name) === "upstream" || running(a.name) === "upstream";
  return [...acpDoctorChecks(agents, ready, version, currentCodexAcp(), usesUpstream), ...selfAdapterChecks(agents, ready, choice, running)];
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
