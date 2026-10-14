/**
 * PMR-2 的 CLI 接线：withPmRails 给每次 `ledger` 调用开干预标记的作用域（lib/pm-rails.ts）；`ledger pm-rails-tick` 由 bridge 定时跑
 * （bridge/pm-rails-service.ts），把 pmRails=on 项目的干预 / 停住 / 每日汇总经本机 owner 通知送出，状态存 statePath("pm-rails.json")。
 * 推不出去不记，下一轮重推；只推 on 期间打的标（lib/pm-rails-notice.ts）。tests/pm-rails*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { isOwnerLike } from "../lib/ledger-checks.js";
import { DAG_START_DEDUP_PREFIX } from "../lib/ledger-autostart-grant.js";
import { cardNames } from "../lib/ledger-card-names.js";
import { effectiveNodes, getDagVersion, getFeature } from "../lib/ledger-feature.js";
import type { LedgerTask } from "../lib/ledger-stages.js";
import { getEventByDedup, getTask, LedgerError } from "../lib/ledger-store.js";
import { statePath } from "../lib/paths.js";
import { pmRailsScope, workflowModes } from "../lib/pm-rails.js";
import { advanceLowWater, cardPushes, digestText, digestWindow, interventionEvents, stalledIntents, type PmRailsProjectState, type PmRailsState } from "../lib/pm-rails-notice.js";
import { cachedPmRailsMode, pmRailsMode } from "../lib/pm-rails-policy.js";
import { peerRestateSkip, startNodePeerWhy } from "../lib/scheduler-spec-resume-text.js";
import { readJsonStateSync, writeJsonAtomicSync } from "../lib/state-file.js";
import type { LedgerCli, LedgerDeps, Result } from "./ledger-context.js";
import type { ParsedArgs } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";
import { isLedgerWrite } from "./write-commands.js";

const PM_RAILS_STATE_PATH = statePath("pm-rails.json");

/** 位置参数、旗标（含 --dedup）、开关都和那一步逐项相等：多一个旗标、少一个、值不同都不算 */
function exactly(p: ParsedArgs, pos: readonly string[], flags: Record<string, string>): boolean {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  return p.bools.size === 0 && same(p.pos, pos) && same(Object.keys(p.flags).sort(), Object.keys(flags).sort())
    && Object.entries(flags).every(([k, v]) => p.flags[k] === v);
}

/** 正文是 startNodePeerWhy(peer, 某个理由)：理由是放置模块给的自由文字，只核模板的头尾 */
function peerWhy(text: string | null | undefined, peer: string): text is string {
  const [head, tail] = startNodePeerWhy(peer, "\u0000").split("\u0000");
  return !!text && text.length > head.length + tail.length && text.startsWith(head) && text.endsWith(tail);
}

/** dag-bind <feature> <key> <卡> --rev <当前 rev>：feature 是建卡时记的那个，节点还没绑卡，卡号就是这个节点的缺省卡号（dag-tools-start.ts） */
function bindStep(db: Database, p: ParsedArgs, task: LedgerTask, dedup: string): boolean {
  const [, featureId, key] = p.pos;
  const f = featureId === task.extra.sharedFeatureId ? getFeature(db, featureId) : null;
  const v = f?.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  const node = v ? effectiveNodes(db, v).find((n) => n.key === key) : undefined;
  if (!f || !node || node.taskId || cardNames(db, f, node.key).taskId !== task.id) return false;
  return exactly(p, ["dag-bind", f.id, node.key, task.id], { rev: String(f.rev), dedup });
}

/**
 * 认 start_node 开 auto 之后自己发的那几步（lib/dag-tools-steps.ts）：子进程带着 start_node 设的出处（START_NODE_ATTEMPT_ENV），等于 dedup
 * `dag-start:<卡>:<attempt>:<步>` 里的 attempt；同一 attempt 的建卡事件在库里；命令按执行用的同一份解析结果逐项等于那一步——peer 卡的
 * 放置说明（startNodePeerWhy 模板）、引用它的 spec→restate、绑本卡的节点。tests/pm-rails.test.ts「验收线 12 / 14 / 19」。
 * 上限：PM 和 start_node 是同一个系统用户，豁免是防手误的护栏、不是安全边界；刻意设置出处环境变量才算伪造，不修，见 docs/architecture/pm-rails.md。
 */
function startNodeStep(db: Database, p: ParsedArgs, from: string | undefined): boolean {
  const dedup = p.flags.dedup ?? "";
  if (!dedup.startsWith(DAG_START_DEDUP_PREFIX)) return false;
  const [taskId, attempt, step, ...rest] = dedup.slice(DAG_START_DEDUP_PREFIX.length).split(":");
  if (!from || from !== attempt) return false; // 不是 start_node 本次起的子进程：PM 照抄同一条命令补步骤照标
  const key = (s: string) => `${DAG_START_DEDUP_PREFIX}${taskId}:${attempt}:${s}`;
  const born = getEventByDedup(db, key("task-new"));
  const task = getTask(db, taskId);
  if (rest.length || !task || !born || born.kind !== "task" || born.target !== taskId || born.data.op !== "new") return false;
  if (step === "bind") return task.stage !== "cancelled" && bindStep(db, p, task, dedup);
  // peer 卡只认建卡时就定下的放置（建卡事件里的 extra.placement，且没改过），建卡后没推过阶段：本机卡后改成 peer 不能复用这两个键
  const placed0 = (born.data.patch as { extra?: { placement?: unknown } } | undefined)?.extra?.placement;
  const peer = placed0 === task.extra.placement ? /^peer:(.+)$/.exec(String(placed0 ?? ""))?.[1] : undefined;
  const staged = db.query("SELECT 1 FROM events WHERE project = ? AND target = ? AND kind = 'stage' AND seq > ? LIMIT 1").get(task.project, taskId, born.seq);
  if (!peer || staged || task.stage !== "spec") return false;
  if (step === "placement") return peerWhy(p.pos[2], peer) && exactly(p, ["decision", taskId, p.pos[2]], { dedup });
  const placed = getEventByDedup(db, key("placement"));
  if (step !== "restate" || placed?.kind !== "decision" || placed.target !== taskId || !peerWhy(placed.text, peer)) return false;
  return exactly(p, ["stage", taskId], { ...peerRestateSkip(placed.text).stage, dedup });
}

/** 读命令、调度服务、owner、start_node 开卡步骤不开作用域：读不写事件，调度 / owner 从来不是 PM 角色（也省下调度 tick 每条命令的快照查询） */
export function withPmRails<T>(deps: LedgerDeps, args: string[], p: ParsedArgs, run: () => Promise<T>): Promise<T> {
  if (!isLedgerWrite(args, p) || deps.actor === "scheduler" || isOwnerLike(deps.actor) || startNodeStep(deps.db, p, deps.startNodeAttempt)) return run();
  const scope = { cmd: args[0] ?? "", mode: cachedPmRailsMode(deps.pmRails?.mode ?? pmRailsMode), modesAtStart: workflowModes(deps.db) };
  return pmRailsScope.run(scope, run);
}

/** 文件坏了不猜：报错里给出按当前最大事件号重建的内容（直接删掉会把 on 期间的历史干预重推一遍） */
function readState(db: Database, path: string, projects: readonly string[]): PmRailsState {
  const r = readJsonStateSync(path, (v) => !!v && typeof v === "object" && typeof (v as PmRailsState).projects === "object");
  if (r.status === "corrupt") {
    const after = (db.query("SELECT MAX(seq) AS n FROM events").get() as { n: number | null }).n ?? 0;
    const rebuilt = { projects: Object.fromEntries(projects.map((p) => [p, { after, cards: {}, stalls: [] }])) };
    throw new LedgerError("invalid", `${path} 坏了（${r.error}）。别直接删（会把历史干预重推一遍），修好或按当前低水位重建：${JSON.stringify(rebuilt)}`);
  }
  return r.status === "ok" ? (r.data as PmRailsState) : { projects: {} };
}

/** 一个项目这一轮：干预合并推送 + 停住提醒；返回发出去的条数。推送失败就停在这里，状态不前进 */
async function projectTick(db: Database, project: string, state: PmRailsState, now: number, send: (t: string) => Promise<boolean>): Promise<number> {
  const prev = state.projects[project] as Partial<PmRailsProjectState> | undefined; // r1 写的旧文件没有 after
  const st: PmRailsProjectState = { after: prev?.after ?? 0, cards: prev?.cards ?? {}, stalls: prev?.stalls ?? [] };
  let sent = 0;
  const events = interventionEvents(db, { project, afterSeq: st.after });
  try {
    for (const p of cardPushes(project, events, st, now)) {
      if (!(await send(p.text))) return sent;
      st.cards[p.card] = p.lastSeq; sent++;
    }
  } finally {
    state.projects[project] = advanceLowWater(events, st); // 推失败提前返回也落一次：已推的那几条不重推
  }
  const cur = state.projects[project];
  const stalls = stalledIntents(db, project, now);
  for (const s of stalls.filter((x) => !cur.stalls.includes(x.key))) {
    if (!(await send(s.text))) return sent;
    cur.stalls.push(s.key); sent++;
  }
  cur.stalls = cur.stalls.filter((k) => stalls.some((s) => s.key === k)); // 意图结清 / 状态变了就忘掉，列表不涨
  return sent;
}

async function tick(c: LedgerCli): Promise<Result> {
  const actor = c.deps.actor;
  if (actor !== "owner" && actor !== "master") throw new LedgerError("forbidden", "pm-rails-tick 只给 bridge 定时器（owner 身份）/ master 跑");
  const send = c.deps.notifyOwner;
  if (!send) return { ok: true, sent: 0, why: "这个进程没有 owner 通知通道" };
  const modeOf = c.deps.pmRails?.mode ?? pmRailsMode;
  const on = c.deps.projectIds.filter((p) => modeOf(p) === "on");
  const path = c.deps.pmRails?.statePath ?? PM_RAILS_STATE_PATH, now = c.deps.now(), state = readState(c.db, path, on);
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
