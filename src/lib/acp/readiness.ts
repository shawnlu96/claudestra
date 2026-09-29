/** Codex 切 ACP 前的共同闸门：迁移、create、restart 和 doctor 使用同一判据。 */
import { resolveCodexBinary } from "../codex-launch.js";
import { defaultRunner, type Runner } from "../codex-thread.js";
import { isSandbox } from "../sandbox.js";
import { codexAcpInstalled, installCodexAcp } from "./install.js";
import { repoStubPath } from "./stub.js";

export type AcpReady = { ok: true; codexBin?: string } | { ok: false; reason: string };

export interface AcpReadyDeps {
  env?: Record<string, string | undefined>;
  resolveBin?: () => Promise<string | null>;
  run?: Runner;
  installed?: () => ReturnType<typeof codexAcpInstalled>;
  install?: () => ReturnType<typeof installCodexAcp>;
  stub?: () => string | null;
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

export async function checkAcpReady(autoInstall = false, deps: AcpReadyDeps = {}): Promise<AcpReady> {
  const cli = await probeAcpCli(deps);
  if (!cli.ok || isSandbox(deps.env ?? process.env)) return cli;
  const have = (deps.installed ?? codexAcpInstalled)();
  if (have.ok) return cli;
  if (!autoInstall) return { ok: false, reason: have.hint };
  const installed = await (deps.install ?? installCodexAcp)();
  return installed.ok ? cli : { ok: false, reason: installed.error };
}
