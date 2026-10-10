/**
 * PM 推送摘要（agents-PMDIG1，docs/architecture/pm-digest.md）的 manager 命令：
 * - `ledger pm-digest`：只读，最近 24 小时给当班 PM 的推送里立即送 / 可合并各多少、来源与理由分布、队里还剩几条；
 * - `ledger pm-digest-mode <on|observe|off>`：项目开关（缺省 observe），项目真 PM / master / owner 才能切。
 */
import { LedgerError } from "../lib/ledger-store.js";
import { PM_DIGEST_LOG_MS, PmDigestStore, type DigestRecord } from "../lib/pm-digest-store.js";
import type { DigestMode } from "../lib/pm-digest.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const tally = (rows: readonly DigestRecord[], key: (r: DigestRecord) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
};

export function pmDigestStats(store: PmDigestStore, project: string, now: number) {
  const s = store.read(), rows = s.log.filter((r) => r.project === project && now - r.at < PM_DIGEST_LOG_MS);
  const merge = rows.filter((r) => r.send === "digest");
  return {
    project, mode: store.mode(project), hours: 24,
    now: rows.length - merge.length, digest: merge.length,
    bySource: { now: tally(rows.filter((r) => r.send === "now"), (r) => r.source), digest: tally(merge, (r) => r.source) },
    byReason: tally(rows, (r) => `${r.send}:${r.reason}`),
    queued: s.queue.filter((e) => e.project === project).length,
  };
}

function pmDigestCmds(store = new PmDigestStore()): Record<string, CommandSpec> {
  return {
    "pm-digest": { valued: ["project"], bools: [], usage: "pm-digest [--project <id>]（只读：最近 24 小时给当班 PM 的推送立即送 / 可合并分布）",
      run: async (c: LedgerCli) => ({ ok: true, ...pmDigestStats(store, c.project(), c.deps.now()) }) },
    "pm-digest-mode": { valued: ["project"], bools: [], usage: "pm-digest-mode <on|observe|off> [--project <id>]（PM 推送摘要开关，缺省 observe）",
      run: async (c: LedgerCli) => {
        const project = c.project(), mode = c.p.pos[1];
        if (mode !== "on" && mode !== "observe" && mode !== "off") throw new LedgerError("invalid", "开关只能是 on / observe / off");
        c.requireRealPm(project, "切 PM 推送摘要开关");
        const from = store.mode(project);
        store.setMode(project, mode as DigestMode);
        return { ok: true, project, from, mode };
      } },
  };
}

export const PM_DIGEST_CMDS = pmDigestCmds();
