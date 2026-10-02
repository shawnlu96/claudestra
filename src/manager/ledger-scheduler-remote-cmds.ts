import { localFamiliesFlag } from "../lib/scheduler-local-families-config.js";
/**
 * `ledger scheduler-remote <project> balance|off --reason`：借算力总开关（i28-W5b），只改 scheduler.json 里该项目的 remote.mode。
 * `ledger scheduler-local <project> [--priority first|balance|low|off] [--max-workers N] --reason`：本机档位 / 并发上限 / 作者运行时，没带的不动。
 * 写入、校验、锁、审计都在 lib/scheduler-config-write.ts；网页开关（R7b）以 owner 身份经 runManager 跑这条命令，不在 bridge 直调 lib
 * （bridge 的台账连接只读，写不了审计事件）。path 参数只给测试指向临时文件。tests/scheduler-config-write-cli.test.ts。
 */
import { LedgerError } from "../lib/ledger-store.js";
import { isLegacyRemoteMode, SCHEDULER_CONFIG_PATH } from "../lib/scheduler-config.js";
import { isPriority, PRIORITIES } from "../lib/lend-config.js";
import { setLocalSlots, setRemoteMode, type LocalSlots } from "../lib/scheduler-config-write.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export function schedulerRemoteCmds(path = SCHEDULER_CONFIG_PATH): Record<string, CommandSpec> {
  return {
    "scheduler-remote": {
      valued: ["reason", "dedup"],
      usage: "scheduler-remote <project> balance|off --reason <为什么>（只改 scheduler.json 里该项目的 remote.mode；PM / master / owner）",
      async run(c) {
        const [, project, mode, ...extra] = c.p.pos;
        if (!project || !mode || extra.length) throw new LedgerError("invalid", "用法：scheduler-remote <project> balance|off --reason <为什么>");
        if (mode !== "balance" && mode !== "off") throw new LedgerError("invalid", `模式只能是 balance / off，收到 ${mode}`);
        const r = await setRemoteMode(c.db, c.ctx(), { project, mode, reason: c.need("reason") }, { path });
        return {
          ok: true, project, mode, from: r.from, changed: r.changed, path: r.path, event: r.event,
          ...(r.duplicate ? { duplicate: true } : {}),
          effective: `调度器下一轮（≤ ${r.pollMs ?? "pollMs"} 毫秒）生效`,
          ...(r.changed && isLegacyRemoteMode(r.from) ? { note: `旧写法 ${r.from} 已规整为 balance` } : {}),
        };
      },
    },
    "scheduler-local": {
      valued: ["priority", "max-workers", "author-runtime", "families", "reason", "dedup"],
      usage: "scheduler-local <project> [--priority first|balance|low|off] [--max-workers N] [--author-runtime claude|codex] [--families codex[,claude]|any] --reason <为什么>（PM / master / owner）",
      async run(c) {
        const [, project, ...extra] = c.p.pos;
        if (!project || extra.length) throw new LedgerError("invalid",
          "用法：scheduler-local <project> [--priority …] [--max-workers N] [--author-runtime claude|codex] [--families codex[,claude]|any] --reason <为什么>");
        const { priority, "max-workers": max, "author-runtime": runtime } = c.p.flags;
        if (priority !== undefined && !isPriority(priority)) throw new LedgerError("invalid", `--priority 只能是 ${PRIORITIES.join(" / ")}，收到 ${priority}`);
        if (max !== undefined && !/^\d{1,2}$/.test(max)) throw new LedgerError("invalid", `--max-workers 要是 0..32 的整数，收到 ${max}`);
        if (runtime !== undefined && runtime !== "claude" && runtime !== "codex") throw new LedgerError("invalid", "--author-runtime 只能是 claude / codex");
        let families;
        try { families = localFamiliesFlag(c.p.flags.families); }
        catch (e) { throw new LedgerError("invalid", (e as Error).message); }
        const set: LocalSlots = { ...families, ...(priority !== undefined ? { localPriority: priority } : {}), ...(max !== undefined ? { maxActiveWorkers: Number(max) } : {}),
          ...(runtime !== undefined ? { localAuthorRuntime: runtime } : {}) };
        const r = await setLocalSlots(c.db, c.ctx(), { project, set, reason: c.need("reason") }, { path });
        return { ok: true, project, from: r.from, to: r.to, changed: r.changed, path: r.path, event: r.event, ...(r.duplicate ? { duplicate: true } : {}),
          effective: `调度器下一轮（≤ ${r.pollMs ?? "pollMs"} 毫秒）生效` };
      },
    },
  };
}

export const SCHEDULER_REMOTE_CMDS = schedulerRemoteCmds();
