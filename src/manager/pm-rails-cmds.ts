/**
 * PMR-2 的 CLI 接线：withPmRails 给每次 `ledger` 调用开干预标记的作用域（lib/pm-rails.ts）；`ledger pm-rails-tick` 由 bridge 定时跑
 * （bridge/pm-rails-service.ts），把 pmRails=on 项目的干预 / 停住 / 每日汇总经本机 owner 通知送出，状态存 statePath("pm-rails.json")。
 * 推不出去不记，下一轮重推；第一次切到 on 的项目从当时的最新事件号起算，不补推旧账。tests/pm-rails*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { LedgerError } from "../lib/ledger-store.js";
import { statePath } from "../lib/paths.js";
import { pmRailsScope, workflowModes } from "../lib/pm-rails.js";
import { cardPushes, digestText, digestWindow, interventionEvents, maxSeq, stalledIntents, type PmRailsState } from "../lib/pm-rails-notice.js";
import { cachedPmRailsMode, pmRailsMode } from "../lib/pm-rails-policy.js";
import { readJsonStateSync, writeJsonAtomicSync } from "../lib/state-file.js";
import type { LedgerCli, LedgerDeps, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";
import { isWriteInvocation } from "./write-commands.js";

const PM_RAILS_STATE_PATH = statePath("pm-rails.json");

/** 读命令不开作用域（它们不写事件，也省一次快照查询） */
export function withPmRails<T>(deps: LedgerDeps, args: string[], run: () => Promise<T>): Promise<T> {
  if (!isWriteInvocation("ledger", args)) return run();
  const scope = { cmd: args[0] ?? "", mode: cachedPmRailsMode(deps.pmRails?.mode ?? pmRailsMode), modesAtStart: workflowModes(deps.db) };
  return pmRailsScope.run(scope, run);
}

function readState(path: string): PmRailsState {
  const r = readJsonStateSync(path, (v) => !!v && typeof v === "object" && typeof (v as PmRailsState).projects === "object");
  if (r.status === "corrupt") throw new LedgerError("invalid", `${path} 坏了（${r.error}），修好或删掉再跑`);
  return r.status === "ok" ? (r.data as PmRailsState) : { projects: {} };
}

/** 一个项目这一轮：干预合并推送 + 停住提醒；返回发出去的条数。推送失败就停在这里，状态不前进 */
async function projectTick(db: Database, project: string, state: PmRailsState, now: number, send: (t: string) => Promise<boolean>): Promise<number> {
  const st = state.projects[project] ??= { floor: maxSeq(db), cards: {}, stalls: [] };
  let sent = 0;
  for (const p of cardPushes(project, interventionEvents(db, { project, afterSeq: st.floor }), st, now)) {
    if (!(await send(p.text))) return sent;
    st.cards[p.card] = p.lastSeq; sent++;
  }
  const stalls = stalledIntents(db, project, now);
  for (const s of stalls.filter((x) => !st.stalls.includes(x.key))) {
    if (!(await send(s.text))) return sent;
    st.stalls.push(s.key); sent++;
  }
  st.stalls = st.stalls.filter((k) => stalls.some((s) => s.key === k)); // 意图结清 / 状态变了就忘掉，列表不涨
  return sent;
}

async function tick(c: LedgerCli): Promise<Result> {
  const actor = c.deps.actor;
  if (actor !== "owner" && actor !== "master") throw new LedgerError("forbidden", "pm-rails-tick 只给 bridge 定时器（owner 身份）/ master 跑");
  const send = c.deps.notifyOwner;
  if (!send) return { ok: true, sent: 0, why: "这个进程没有 owner 通知通道" };
  const path = c.deps.pmRails?.statePath ?? PM_RAILS_STATE_PATH, now = c.deps.now(), state = readState(path);
  const modeOf = c.deps.pmRails?.mode ?? pmRailsMode;
  const on = c.deps.projectIds.filter((p) => modeOf(p) === "on");
  for (const p of Object.keys(state.projects)) if (!on.includes(p)) delete state.projects[p]; // 关掉再开从开的那一刻起算
  let sent = 0;
  try {
    for (const p of on) sent += await projectTick(c.db, p, state, now, send);
    const w = digestWindow(now, state.digestDay);
    if (w) {
      const text = digestText(w.day, on.flatMap((project) => interventionEvents(c.db, { project, fromTs: w.fromTs, toTs: w.toTs })));
      if (!text || (await send(text))) { state.digestDay = w.day; if (text) sent++; }
    }
  } finally {
    writeJsonAtomicSync(path, state);
  }
  return { ok: true, sent, projects: on };
}

export const PM_RAILS_CMDS: Record<string, CommandSpec> = {
  "pm-rails-tick": { valued: [], usage: "pm-rails-tick（bridge 定时跑：pmRails=on 的项目把人工干预 / 调度停住 / 每日汇总推给本机 owner）", run: tick },
};
