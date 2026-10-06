/** 切 ACP 前的共同闸门：Codex 的迁移、create、restart、doctor 用同一判据；Pi 只看 pi 版本（checkAcpReadyFor）。 */
import { resolveCodexBinary } from "../codex-launch.js";
import { defaultRunner, type Runner } from "../codex-thread.js";
import { isSandbox } from "../sandbox.js";
import { probeClaudeVersion } from "../claude-binary.js";
import { piBinName } from "../pi-env.js";
import { isNewerVersion } from "../update-hints.js";
import { codexAcpInstalled, codexPairsWithAdapter, reconcileCodexAcp } from "./install.js";
import { identityLine, probeCodexCompat, selectedCodexAdapter, type CodexCompat } from "./codex-compat.js";
import { repoStubPath } from "./stub.js";

/** compat：自研适配器生效时本机 codex 的协议判定（含组合身份） */
export type AcpReady = { ok: true; codexBin?: string; compat?: CodexCompat } | { ok: false; reason: string };

export interface AcpReadyDeps {
  env?: Record<string, string | undefined>;
  resolveBin?: () => Promise<string | null>;
  run?: Runner;
  installed?: () => ReturnType<typeof codexAcpInstalled>;
  /** 按磁盘上的 codex 对账（装能配它的适配器并切指针）；参数是探 codex 版本的函数。缺省 reconcileCodexAcp */
  install?: (codexVersion: () => Promise<string | undefined>) => ReturnType<typeof reconcileCodexAcp>;
  pairs?: (codexVersion: string | undefined) => boolean;
  stub?: () => string | null;
  selected?: () => "upstream" | "self";
  compat?: (codexBin: string) => CodexCompat;
}

/** 只看 app-server 子命令本身的 help；旧 CLI 把未知子命令当提示词，exit 0 也会打印顶层 help。 */
function supportsCodexAppServer(result: { ok: boolean; out: string; err: string }): boolean {
  return result.ok && /Usage:\s*codex app-server\b/i.test(`${result.out}\n${result.err}`);
}

export async function probeAcpCli(deps: AcpReadyDeps = {}): Promise<AcpReady> {
  const env = deps.env ?? process.env;
  if (isSandbox(env)) return (deps.stub ?? repoStubPath)() ? { ok: true } : { ok: false, reason: "沙箱 ACP stub 不在本仓" };
  let bin: string | null;
  try { bin = await (deps.resolveBin ?? (async () => (await resolveCodexBinary(defaultRunner, env))?.real ?? null))(); }
  catch (e) { console.error(`[acp] Codex 路径解析失败: ${String(e)}`); bin = null; }
  if (!bin) return { ok: false, reason: "找不到 Codex CLI" };
  const probe = await (deps.run ?? defaultRunner)([bin, "app-server", "--help"], 8_000);
  if (!supportsCodexAppServer(probe)) return { ok: false, reason: "Codex CLI 太旧或缺少 app-server" };
  return { ok: true, codexBin: bin };
}

/**
 * autoInstall：没装、坏了、或已装的不配本机 codex 时，按磁盘上的 codex 对账（reconcileCodexAcp：registry 不通就用本地
 * 已装且配套的版本）。对账失败但已装的完好时照常就绪（宿主对错配只告警，见 codex-version.ts）——离线绝不能把一台本来能跑
 * 的机器判成未就绪。
 */
export async function checkAcpReady(autoInstall = false, deps: AcpReadyDeps = {}): Promise<AcpReady> {
  const cli = await probeAcpCli(deps);
  if (!cli.ok || isSandbox(deps.env ?? process.env)) return cli;
  if ((deps.selected ?? selectedCodexAdapter)() === "self") return selfAdapterReady(cli, deps);
  const have = (deps.installed ?? codexAcpInstalled)();
  if (!autoInstall) return have.ok ? cli : { ok: false, reason: have.hint };
  const bin = cli.codexBin;
  const probe = async () => (bin ? (await probeClaudeVersion(deps.run ?? defaultRunner, bin).catch(() => null)) ?? undefined : undefined);
  const version = await probe();
  if (have.ok && (!version || (deps.pairs ?? codexPairsWithAdapter)(version))) return cli;
  const installed = await (deps.install ?? ((codexVersion) => reconcileCodexAcp({ codexVersion })))(probe);
  if (installed.ok) return cli;
  if (have.ok) {
    console.warn(`⚠️ [acp] 没换上配 codex ${version} 的适配器，沿用已装的 codex-acp ${have.version}：${installed.error}`);
    return cli;
  }
  return { ok: false, reason: installed.error };
}

/**
 * 自研适配器在仓库里、不用装，也不看上游指针：只按协议判本机 codex。不兼容 = 未就绪；判不出照常就绪只告警
 * （和上游离线时不把能跑的机器判成未就绪同一个取舍）。组合身份打进日志，换了就是没验证过的组合。
 */
function selfAdapterReady(cli: { ok: true; codexBin?: string }, deps: AcpReadyDeps): AcpReady {
  if (!cli.codexBin) return cli;
  const c = (deps.compat ?? probeCodexCompat)(cli.codexBin);
  if (c.verdict === "incompatible") return { ok: false, reason: `本机 codex ${c.codexVersion} 按 app-server 协议判定和自研适配器不兼容：${c.reasons.slice(0, 3).join("；")}` };
  if (c.identity) console.log(`[acp] ${identityLine(c.identity)}${c.reasons.length ? `；协议差异 ${c.reasons.length} 条，需真实组合验证` : ""}`);
  else console.warn(`⚠️ [acp] 判不出本机 codex 和自研适配器是否兼容，照常就绪：${c.reasons.join("；")}`);
  return { ...cli, compat: c };
}

/** Pi 走 acp 的最低版本：内置 MCP（挂载扩展借它的 createMcpExtension 连 channel-server）是 0.99.0 才有（pi CHANGELOG） */
const PI_ACP_MIN_VERSION = "0.99.0";

/** Pi 的适配器在仓库里、不用装；只要 pi 在、版本够。读不出版本号（格式变了）按够了放行，真起不来宿主会报 */
export async function probePiAcp(run: Runner = defaultRunner): Promise<AcpReady> {
  const r = await run([piBinName(), "--version"], 8_000);
  if (!r.ok) return { ok: false, reason: `找不到 pi 或它起不来（${piBinName()}；可用 PI_BIN 指定路径）` };
  const v = `${r.out}\n${r.err}`.match(/(\d+\.\d+\.\d+)/)?.[1];
  return v && isNewerVersion(PI_ACP_MIN_VERSION, v) ? { ok: false, reason: `pi ${v} 太旧：acp 要 ${PI_ACP_MIN_VERSION} 以上（内置 MCP）` } : { ok: true };
}

/** 按运行时分派的就绪闸（transport 命令用）：pi 看版本，其余照旧走 Codex 的判据 */
export function checkAcpReadyFor(runtime: string | undefined, autoInstall = false, deps: AcpReadyDeps = {}): Promise<AcpReady> {
  return runtime === "pi" ? probePiAcp(deps.run) : checkAcpReady(autoInstall, deps);
}
