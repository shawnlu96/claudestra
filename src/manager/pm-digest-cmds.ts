/**
 * PM 推送摘要（agents-PMDIG1，docs/architecture/pm-digest.md）的 manager 命令：
 * - `ledger pm-digest [--list]`：只读，最近 24 小时给当班 PM 的推送里立即送 / 可合并各多少、来源与理由分布、队里还剩几条；--list 列出条目；
 * - `ledger pm-digest-pull <on|off>`：摘要队列只供拉取（缺省 on）还是旧的推送摘要，切换要项目真 PM。
 * - `ledger pm-digest-mode <on|observe|off>`：项目开关（缺省 observe），项目真 PM / master / owner 才能切。
 * - `ledger pm-peer-inbox [on|off]`：peer 机器消息先投调度助理（DPR-1，缺省 off），不带模式只读；切换要项目真 PM（调度助理自己切不了）。
 * - `ledger pm-hold [off|hold|batch] [--every <分钟>]`：PM 暂存（lib/pm-hold.ts），不带模式只读状态；切换同上要项目真 PM。
 * - `ledger pm-todo [--all]`：只读，PM 按需拉的上线后待办（lib/pm-todo.ts）；缺省只列观察期已到的，--all 连没到的一起列；摘要队列有条目时带条数。
 */
import { pmRouteStats } from "../lib/pm-route-stats.js";
import { LedgerError } from "../lib/ledger-store.js";
import { PM_DIGEST_LOG_MS, PmDigestStore, type DigestRecord } from "../lib/pm-digest-store.js";
import { digestText, type DigestMode } from "../lib/pm-digest.js";
import { PM_HOLD_DEFAULT_MIN, PmHoldStore } from "../lib/pm-hold.js";
import { readPostVerifySpec } from "../lib/scheduler-post-verify-ledger.js";
import { pmTodos } from "../lib/pm-todo.js";
import type { LedgerCli } from "./ledger-context.js";
import { PM_JOB_CMDS } from "./pm-job-cmds.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const tally = (rows: readonly DigestRecord[], key: (r: DigestRecord) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
};

export function pmDigestStats(store: PmDigestStore, project: string, now: number) {
  const s = store.read(), rows = s.log.filter((r) => r.project === project && now - r.at < PM_DIGEST_LOG_MS);
  const digestRows = rows.filter((r) => !r.routeOnly);
  const merge = digestRows.filter((r) => r.send === "digest");
  return {
    project, mode: store.mode(project), hours: 24, routeMode: store.routeMode(project), route: pmRouteStats(rows),
    now: digestRows.length - merge.length, digest: merge.length,
    bySource: { now: tally(digestRows.filter((r) => r.send === "now"), (r) => r.source), digest: tally(merge, (r) => r.source) },
    byReason: tally(digestRows, (r) => `${r.send}:${r.reason}`),
    queued: s.queue.filter((e) => e.project === project).length,
  };
}

export function pmDigestCmds(store = new PmDigestStore()): Record<string, CommandSpec> {
  return {
    "pm-digest": { valued: ["project"], bools: ["list"], usage: "pm-digest [--project <id>] [--list]（只读：最近 24 小时给当班 PM 的推送立即送 / 可合并分布；--list 列出队里等拉的条目）",
      run: async (c: LedgerCli) => {
        const project = c.project(), queued = store.queued(project);
        return { ok: true, ...pmDigestStats(store, project, c.deps.now()), pull: store.pullMode(project),
          ...(c.p.bools.has("list") && queued.length ? { list: digestText(queued).split("\n") } : {}) };
      } },
    "pm-digest-pull": { valued: ["project"], bools: [], usage: "pm-digest-pull <on|off> [--project <id>]（on 缺省：摘要队列只供拉取；off：旧的推送摘要）",
      run: async (c: LedgerCli) => {
        const project = c.project(), mode = c.p.pos[1];
        if (mode !== "on" && mode !== "off") throw new LedgerError("invalid", "开关只能是 on / off");
        c.requireRealPm(project, "切 PM 摘要拉取开关");
        const from = store.pullMode(project);
        await store.setPullMode(project, mode);
        return { ok: true, project, from, pull: mode };
      } },
    "pm-route-mode": { valued: ["project"], bools: [], usage: "pm-route-mode <on|observe|off> [--project <id>]（独立分流开关，缺省 observe）",
      run: async (c: LedgerCli) => {
        const project = c.project(), mode = c.p.pos[1];
        if (mode !== "on" && mode !== "observe" && mode !== "off") throw new LedgerError("invalid", "开关只能是 on / observe / off");
        c.requireRealPm(project, "切 PM 分流开关");
        const from = store.routeMode(project);
        await store.setRouteMode(project, mode);
        return { ok: true, project, from, routeMode: mode };
      } },
    "pm-peer-inbox": { valued: ["project"], bools: [], usage: "pm-peer-inbox [on|off] [--project <id>]（peer 机器消息先投调度助理，缺省 off；不带模式只读）",
      run: async (c: LedgerCli) => {
        const project = c.project(), mode = c.p.pos[1], from = store.peerInbox(project);
        if (mode === undefined) return { ok: true, project, peerInbox: from };
        if (mode !== "on" && mode !== "off") throw new LedgerError("invalid", "开关只能是 on / off");
        c.requireRealPm(project, "切 peer 消息转调度助理开关");
        await store.setPeerInbox(project, mode);
        return { ok: true, project, from, peerInbox: mode };
      } },
    "pm-hold": { valued: ["project", "every"], bools: [], usage: "pm-hold [off|hold|batch] [--every <分钟>] [--project <id>]（PM 暂存；不带模式只读状态）",
      run: async (c: LedgerCli) => {
        const project = c.project(), mode = c.p.pos[1], hold = new PmHoldStore();
        const queued = (): number => hold.queue().filter((e) => e.project === project).length;
        if (mode === undefined) return { ok: true, project, ...hold.setting(project), queued: queued() };
        if (mode !== "off" && mode !== "hold" && mode !== "batch") throw new LedgerError("invalid", "模式只能是 off / hold / batch");
        const every = c.p.flags.every === undefined ? PM_HOLD_DEFAULT_MIN : Number(c.p.flags.every);
        if (!Number.isInteger(every) || every < 1 || every > 1440) throw new LedgerError("invalid", "--every 是 1–1440 的整数分钟");
        c.requireRealPm(project, "切 PM 暂存开关");
        const from = hold.setting(project).mode;
        hold.setSetting(project, { mode, everyMin: every, since: c.deps.now() });
        return { ok: true, project, from, mode, everyMin: every, queued: queued() };
      } },
    "pm-digest-mode": { valued: ["project"], bools: [], usage: "pm-digest-mode <on|observe|off> [--project <id>]（PM 推送摘要开关，缺省 observe）",
      run: async (c: LedgerCli) => {
        const project = c.project(), mode = c.p.pos[1];
        if (mode !== "on" && mode !== "observe" && mode !== "off") throw new LedgerError("invalid", "开关只能是 on / observe / off");
        c.requireRealPm(project, "切 PM 推送摘要开关");
        const from = store.mode(project);
        await store.setMode(project, mode as DigestMode);
        return { ok: true, project, from, mode };
      } },
    "pm-todo": { valued: ["project"], bools: ["all"], usage: "pm-todo [--all] [--project <id>]（只读：上线后待办，缺省只列观察期已到的）",
      run: async (c: LedgerCli) => {
        const project = c.project(), all = pmTodos(c.db, project, (id) => readPostVerifySpec(id)?.text, c.deps.now());
        const todos = c.p.bools.has("all") ? all : all.filter((t) => t.due);
        // 拉取模式下摘要队列不再推给 PM，这里带上条数，PM 拉待办时顺带看到（oneShot 进度同步里偶有要处理的）
        const digest = store.queued(project).length;
        return { ok: true, project, due: all.filter((t) => t.due).length, waiting: all.filter((t) => !t.due).length, todos,
          ...(todos.some((t) => t.dedupKey) ? { todoDoneHint: "ledger note <卡> --dedup pm-todo-done:<dedupKey> --text 已处理" } : {}),
          ...(digest ? { digest, digestHint: "ledger pm-digest --list" } : {}) };
      } },
  };
}

export const PM_DIGEST_CMDS = { ...pmDigestCmds(), ...PM_JOB_CMDS }; // 并入 PM 处理员的 pm-job / pm-job-mode（PMJOB1）
