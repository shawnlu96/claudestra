/**
 * Pi 的 transport 迁移：`manager migrate --pi <agent> [--to tmux]`。只动点名的这一个 agent，生产里现有的 Pi 一律不自动迁。
 * 对照 Codex 的迁移（acp-migration.ts）：就绪检查（pi 版本、同名 MCP）和切换都走 `transport` 的同一条路（switchTransport），
 * acp 起不来就切回 tmux 再起一次，不把能用的 agent 留成死窗口（沙箱里没有 tmux 版 Pi，不回退）。
 * 两种 transport 起 pi 都带 registry 里同一个 --session-id，对话接着走；`--to tmux` 是回退。
 * docs/architecture/pi-acp-migration.md，tests/pi-acp-migration.test.ts。
 */
import { isSandbox } from "../lib/sandbox.js";
import { normalizeTransport, type Transport } from "../lib/runtimes/index.js";
import { switchTransport } from "./acp-lifecycle.js";
import { loadRegistry } from "./core.js";

export const PI_MIGRATE_USAGE = "migrate --pi <agent> [--to acp|tmux]（缺省 acp；--to tmux = 回退）";

type Result = Record<string, unknown>;
type AgentInfo = { runtime?: string; transport?: string; sessionId?: string };

export interface PiMigrateDeps {
  agents(): Promise<Record<string, AgentInfo>>;
  switchTo(name: string, mode: Transport): Promise<Result>;
  sandbox: boolean;
}

const defaultDeps = (): PiMigrateDeps => ({
  agents: async () => (await loadRegistry()).agents as Record<string, AgentInfo>,
  switchTo: switchTransport,
  sandbox: isSandbox(),
});

export function parsePiMigrateArgs(args: string[]): { name: string; to: Transport } | { error: string } {
  const i = args.indexOf("--to");
  const to = i >= 0 ? args[i + 1] : "acp";
  const rest = args.filter((_, j) => i < 0 || (j !== i && j !== i + 1));
  if ((to !== "acp" && to !== "tmux") || rest.length !== 1 || rest[0]!.startsWith("-")) return { error: PI_MIGRATE_USAGE };
  return { name: rest[0]!, to };
}

export async function migratePi(args: string[], deps: PiMigrateDeps = defaultDeps()): Promise<Result> {
  const parsed = parsePiMigrateArgs(args);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const bare = parsed.name.replace(/^agent-/, "");
  const agents = await deps.agents();
  const key = agents[`agent-${bare}`] ? `agent-${bare}` : agents[bare] ? bare : "";
  const info = key ? agents[key]! : undefined;
  if (!info) return { ok: false, error: `agent "${bare}" 不存在` };
  if (info.runtime !== "pi") return { ok: false, error: `${key} 不是 Pi agent（runtime=${info.runtime || "claude-code"}）；Codex 用 migrate --acp` };
  if (parsed.to === "tmux") return deps.switchTo(key, "tmux");
  if (normalizeTransport(info.transport) === "acp") return { ok: true, agent: key, transport: "acp", unchanged: true };
  const r = await deps.switchTo(key, "acp");
  const sessionId = (await deps.agents())[key]?.sessionId;
  if (r.ok) return { ...r, sessionId, sameSession: sessionId === info.sessionId };
  // 没有 restarted 字段 = 切换前就被拒（版本 / 同名 MCP），registry 没动，不用回退
  if (r.restarted === undefined || deps.sandbox) return r;
  const back = await deps.switchTo(key, "tmux");
  return { ok: false, agent: key, transport: back.ok ? "tmux" : "acp", fellBack: back.ok === true, error: r.error, ...(back.ok ? {} : { fallbackError: back.error }) };
}
