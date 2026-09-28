/**
 * `ledger` 命令族：内置台账的唯一写入口（docs 10-ledger §2）。PM、执行者、大总管、owner 都在终端跑同一条命令，
 * 身份与时间由命令推导（ledger-identity.ts），库是 statePath("ledger.sqlite")（lib/ledger-store.ts，沙箱随状态目录隔离）。
 * 输出一律一行 JSON；失败 {ok:false, code, error, current?}，code 同 LedgerError（conflict 时 current 是库里的实际值）。
 * 子命令表：写在 ledger-write-cmds.ts，读 / 设置在 ledger-read-cmds.ts，导入在 ledger-import.ts。
 */
import { existsSync } from "node:fs";
import { repoEnvVar } from "../lib/env-file.js";
import { LedgerError, LEDGER_PATH, openLedger } from "../lib/ledger-store.js";
import { renameAgentRefs } from "../lib/ledger-write.js";
import { readProjects } from "../lib/projects.js";
import { readRegistryAgents } from "../lib/registry.js";
import { loadRegistry, output, saveRegistry } from "./core.js";
import { LedgerCli, type LedgerDeps, type Result } from "./ledger-context.js";
import { parseLedgerArgs, resolveActor } from "./ledger-identity.js";
import { importCmd } from "./ledger-import.js";
import { READ_CMDS } from "./ledger-read-cmds.js";
import { WRITE_CMDS, type CommandSpec } from "./ledger-write-cmds.js";

const COMMANDS: Record<string, CommandSpec> = {
  ...WRITE_CMDS,
  ...READ_CMDS,
  import: { valued: ["map", "project"], bools: ["dry-run"], usage: "import <ledger.json> --map <map.json> [--project <id>] [--dry-run]", run: importCmd },
};

export function ledgerUsage(): string {
  return ["ledger <子命令>（全部支持 --project <id>；写命令支持 --dedup <key> 幂等）", ...Object.values(COMMANDS).map((s) => `  ledger ${s.usage}`)].join("\n");
}

/** 解析 → 执行 → 结果对象；不打印，测试直接断言返回值 */
export async function runLedger(args: string[], deps: LedgerDeps): Promise<Result> {
  const sub = args[0] ?? "";
  const spec = COMMANDS[sub];
  if (!spec) return { ok: sub === "" || sub === "help", usage: ledgerUsage(), ...(sub && sub !== "help" ? { error: `未知子命令 ${sub}` } : {}) };
  const p = parseLedgerArgs(args, spec.valued, spec.bools);
  if ("error" in p) return { ok: false, code: "invalid", error: p.error, usage: `ledger ${spec.usage}` };
  try {
    return await spec.run(new LedgerCli(deps, p));
  } catch (e) {
    if (e instanceof LedgerError) return { ok: false, code: e.code, error: e.message, ...(e.current ? { current: e.current } : {}), usage: `ledger ${spec.usage}` };
    return { ok: false, code: "invalid", error: (e as Error).message, usage: `ledger ${spec.usage}` };
  }
}

/** 真实依赖：registry、projects.json、环境里的频道号 → actor */
async function realDeps(): Promise<LedgerDeps | { error: string }> {
  const reg = await loadRegistry();
  const who = resolveActor({ channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: repoEnvVar("CONTROL_CHANNEL_ID") }, reg.agents);
  if (!who.ok) return { error: who.error };
  const projects = await readProjects();
  return {
    db: openLedger(),
    actor: who.actor,
    actorProject: reg.agents[who.actor]?.projectId,
    projectIds: projects.projects.map((x) => x.id),
    loadRegistry,
    saveRegistry,
    now: () => Date.now(),
  };
}

export async function cmdLedger(args: string[]): Promise<void> {
  const deps = await realDeps();
  if ("error" in deps) return output({ ok: false, code: "forbidden", error: deps.error });
  const r = await runLedger(args, deps);
  output(r);
  if (r.ok === false) process.exitCode = 1;
}

/**
 * manager rename 的钩子：台账里的执行者 / PM / PM 名单跟着改名，否则改名后 roleOf 认不出人。
 * 台账库还没建（没用过台账）就什么都不做，免得 rename 顺手建出空库；同步失败只报 stderr，不让 rename 本身失败（registry 已改完）。
 */
export async function renameLedgerAgent(from: string, to: string, path = LEDGER_PATH): Promise<void> {
  if (!existsSync(path)) return;
  try {
    // 只读 registry（loadRegistry 在文件不存在时会顺手建一个空的）；认不出身份就记成 owner——这是 manager 自己跟着 rename 做的同步
    const agents = Object.fromEntries((await readRegistryAgents()).map((a) => [a.name, { channelId: a.channelId }]));
    const who = resolveActor({ channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: repoEnvVar("CONTROL_CHANNEL_ID") }, agents);
    const r = renameAgentRefs(openLedger(path), { actor: who.ok ? who.actor : "owner" }, from, to);
    if (r.tasks.length || r.projects.length) console.error(`台账已同步改名 ${from} → ${to}：任务 ${r.tasks.join(", ") || "无"}；PM 名单 ${r.projects.join(", ") || "无"}`);
  } catch (e) {
    console.error(`⚠️ 台账同步改名失败（${from} → ${to}）：${(e as Error).message}——手动用 ledger task-set --agent / meta --pms 补`);
  }
}
