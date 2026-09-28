/**
 * 用量统计命令（cost / metrics）。
 *
 * 从 manager.ts 逐字搬出（函数体未改，只加 export / 改相对路径）。
 */
import { loadRegistry, output } from "./core.js";
import { currentUsageWindow, type UsageWindowBounds } from "../lib/usage-window.js";

/** bridge 传来的 `--window <dayStart>,<weekStart>,<quota|rolling>`：两边用同一个窗口，别各算各的 */
function parseWindowArg(v: string | undefined): UsageWindowBounds | null {
  const [d, w, src] = (v ?? "").split(",");
  const dayStart = Number(d);
  const weekStart = Number(w);
  if (!Number.isFinite(dayStart) || !Number.isFinite(weekStart) || !d || !w) return null;
  return { dayStart, weekStart, weekSource: src === "quota" ? "quota" : "rolling" };
}

export async function cmdCost(args: string[]) {
  const { rollupJsonl, projectJsonlPath, findJsonlBySessionId, mergeByModel } =
    await import("../lib/jsonl-cost.js");

  // 参数解析。--week = 当前周额度周期（与用量看板同一口径），拿不到重置时刻退回滚动 7 天
  let agentFilter: string | null = null;
  let period: "today" | "week" | null = null;
  let machine = false;
  let win = currentUsageWindow();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--today") {
      period = "today";
    } else if (a === "--week") {
      period = "week";
    } else if (a === "--machine") {
      machine = true;
    } else if (a === "--window" && args[i + 1]) {
      win = parseWindowArg(args[++i]) ?? win;
    } else if (a === "--agent" && args[i + 1]) {
      agentFilter = args[i + 1];
      i++;
    } else if (!a.startsWith("--")) {
      agentFilter = a;
    }
  }

  // 窗口要等参数全解析完再取：--window 可能写在 --week 后面
  const sinceTs = period === "today" ? win.dayStart : period === "week" ? win.weekStart : 0;

  // 全机（所有会话文件、按响应去重）今日 + 本周；bridge 看板在子进程里调它，见 bridge/machine-usage.ts
  if (machine) {
    const { scanMachineUsage } = await import("../lib/machine-usage.js");
    output({ ok: true, machine: await scanMachineUsage(win) });
    return;
  }

  const reg = await loadRegistry();
  const rows: any[] = [];
  for (const [name, info] of Object.entries(reg.agents)) {
    if (agentFilter && name !== agentFilter) continue;
    if (!info.sessionId) continue;
    let path = info.cwd ? projectJsonlPath(info.cwd, info.sessionId) : "";
    if (!path || !(await Bun.file(path).exists())) {
      const found = findJsonlBySessionId(info.sessionId);
      if (found) path = found;
      else continue;
    }
    const usage = await rollupJsonl(path, sinceTs);
    for (const u of usage) {
      rows.push({ agent: name, ...u });
    }
  }

  // 按 agent 汇总
  const byAgent = new Map<string, any>();
  for (const r of rows) {
    const cur = byAgent.get(r.agent) || {
      agent: r.agent, input: 0, cacheCreation: 0, cacheRead: 0, output: 0, requests: 0, models: new Set<string>(),
    };
    cur.input += r.input;
    cur.cacheCreation += r.cacheCreation;
    cur.cacheRead += r.cacheRead;
    cur.output += r.output;
    cur.requests += r.requests;
    cur.models.add(r.model);
    byAgent.set(r.agent, cur);
  }

  const perAgent = [...byAgent.values()].map((x) => ({
    agent: x.agent,
    models: [...x.models],
    input: x.input,
    cacheCreation: x.cacheCreation,
    cacheRead: x.cacheRead,
    output: x.output,
    totalTokens: x.input + x.cacheCreation + x.cacheRead + x.output,
    requests: x.requests,
  }));
  perAgent.sort((a, b) => b.totalTokens - a.totalTokens);

  const total = mergeByModel(rows);

  output({
    ok: true,
    scope: agentFilter ? `agent=${agentFilter}` : "all",
    period: sinceTs ? `since ${new Date(sinceTs).toISOString()}` : "all-time",
    ...(period === "week" ? { weekSource: win.weekSource } : {}),
    perAgent,
    byModel: total,
    grand: {
      input: perAgent.reduce((s, r) => s + r.input, 0),
      cacheCreation: perAgent.reduce((s, r) => s + r.cacheCreation, 0),
      cacheRead: perAgent.reduce((s, r) => s + r.cacheRead, 0),
      output: perAgent.reduce((s, r) => s + r.output, 0),
      totalTokens: perAgent.reduce((s, r) => s + r.totalTokens, 0),
      requests: perAgent.reduce((s, r) => s + r.requests, 0),
    },
  });
}

export async function cmdMetrics(args: string[]) {
  const { readMetrics } = await import("../lib/metrics.js");

  // 参数
  let sinceTs = 0;
  let agentFilter: string | null = null;
  let rawOutput = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--today") {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      sinceTs = d.getTime();
    } else if (a === "--week") {
      sinceTs = Date.now() - 7 * 24 * 3600_000;
    } else if (a === "--since" && args[i + 1]) {
      sinceTs = new Date(args[++i]).getTime();
    } else if (a === "--agent" && args[i + 1]) {
      agentFilter = args[++i];
    } else if (a === "--raw") {
      rawOutput = true;
    }
  }

  let records = await readMetrics(sinceTs);
  if (agentFilter) {
    records = records.filter((r) => r.agent === agentFilter || r.meta?.agent === agentFilter);
  }

  if (rawOutput) {
    output({ ok: true, records });
    return;
  }

  // 按 event 汇总
  const byEvent = new Map<string, number>();
  const byAgent = new Map<string, { [k: string]: number }>();
  for (const r of records) {
    byEvent.set(r.event, (byEvent.get(r.event) || 0) + 1);
    const key = r.agent || r.channelId || "unknown";
    const cur = byAgent.get(key) || {};
    cur[r.event] = (cur[r.event] || 0) + 1;
    byAgent.set(key, cur);
  }

  output({
    ok: true,
    total: records.length,
    period: sinceTs ? `since ${new Date(sinceTs).toISOString()}` : "all-time",
    byEvent: Object.fromEntries(byEvent),
    byAgent: Object.fromEntries(byAgent),
  });
}
