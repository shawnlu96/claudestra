/**
 * 本机卡 worktree（worktrees/<卡>、worktrees/rv-<卡>）下的残留进程回收（RTO1）：Bash 工具临时起的 `bun test` 之类，
 * 会话登记表里没有（ORPH1 收不到），worktree 删了它还在 ppid=1 空转。两个入口：
 * - 收卡：卡进入 verified / done / cancelled、调度器退役 worktree 前，cwd 落在本卡执行者或审查员 worktree 下的进程一起收；
 * - 巡检（ORPHAN_EVERY_MS 一次）：ppid=1、cwd 在 worktrees 根下，且对应卡已是终态或 cwd 所在目录已不存在 → 收。
 *   卡状态未知、目录名对不上任何卡、项目队列冻结的一律跳过并记一行。
 * 安全规则与 TERM → 宽限 → KILL 流程都走 proc-reap-core.ts（与出借侧共用）。
 * macOS 实测：cwd 目录被删后 lsof -d cwd 照样报原路径（不带 "(deleted)"），所以「目录已删」按路径不存在判定。
 * 档位 off / observe / on 按卡的项目每次现读（card-proc-reap-policy.ts：恢复键 cardProcReap，缺省 observe；环境变量只当整机紧急关闭）。
 * observe 只记台账（state 目录下的 JSON）并推 PM 摘要（同一进程只推一次），不发任何信号；摘要发出前重新枚举进程表、重核全部资格
 * （REAPALIVE1），只报复查时还在的。off 不枚举、不记、不推、不发信号。
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CARD_REAP_KEY, cardReapModeReader, type CardReapMode } from "./card-proc-reap-policy.js";
import { getMeta } from "./ledger-store.js";
import { STAGES, type LedgerTask } from "./ledger-stages.js";
import { ORPHAN_EVERY_MS, systemProcPorts } from "./lend-proc-reap.js";
import { statePath } from "./paths.js";
import { cwdLinkFree, dirOf, errMsg, isLink, mayTouch, noLinks, procLine, termThenKill, type Pick, type Proc, type ProcPorts } from "./proc-reap-core.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { RETIRE_STAGES } from "./scheduler-sessions.js";
import { writeJsonAtomicSync } from "./state-file.js";

export type { CardReapMode };
/** observe 台账最多留这么多条（只为「同一进程只推一次」去重） */
const LEDGER_CAP = 500;

/** observe 台账：同一进程（pid + cwd）只推 PM 一次 */
export interface ObserveLedger { has(key: string): boolean; add(rows: ObserveRow[]): void }
export interface ObserveRow { key: string; card: string; pid: number; comm: string; at: number; why: string }

export interface CardProcDeps {
  /** 写死一个档位（测试显式控制）；函数 = 每次收卡 / 巡检按卡的项目现读（生产：恢复键 cardProcReap） */
  mode: CardReapMode | ((project: string) => CardReapMode);
  ports: ProcPorts;
  log: (m: string) => void;
  observed: ObserveLedger;
  now: () => number;
  /** 发信号前核调度器租约，失租抛 SchedulerStopped（不吞） */
  active?: () => void | Promise<void>;
  graceMs?: number;
}
/** 调用方（scheduler-retire.ts）手里的东西：worktree 根、PM 通知、本模块的依赖（null = 关掉） */
export interface CardReapHost {
  worktreeRoot: string;
  notifyPm(task: LedgerTask, text: string): Promise<void>;
  procs?: CardProcDeps | null;
  /** registry + tmux 现状（scheduler-retire.ts 的 LiveAgent）：活 agent 还在里面工作的 worktree 不碰 */
  agents?: () => Promise<HostAgent[]>;
}
type HostAgent = { name: string; cwd?: string; status?: string; pending: boolean; window: boolean };

const modeOf = (d: CardProcDeps, project: string): CardReapMode => (typeof d.mode === "function" ? d.mode(project) : d.mode);

const procKey = (p: Proc) => `${p.pid}|${p.cwd}`;

/** 台账落在 state 目录下的 JSON；读不出就当空（最多多推一次，不影响信号） */
export function fileObserveLedger(path = statePath("card-proc-reap-observed.json")): ObserveLedger {
  const read = (): ObserveRow[] => {
    try { const v = JSON.parse(readFileSync(path, "utf8")); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  return {
    has: (key) => read().some((r) => r.key === key),
    add: (rows) => writeJsonAtomicSync(path, [...read(), ...rows].slice(-LEDGER_CAP)),
  };
}

/** 生产依赖：只对真正的 state worktrees 根生效（测试用临时根、没注入 procs 的不去碰本机进程表） */
function defaultCardProcs(host: CardReapHost): CardProcDeps | null {
  if (host.procs !== undefined) return host.procs;
  if (resolve(host.worktreeRoot) !== resolve(statePath("worktrees"))) return null;
  const agents = host.agents;
  const log = (m: string) => console.log(`[scheduler] ${m}`);
  return { mode: cardReapModeReader(log), ports: systemProcPorts(), log, observed: fileObserveLedger(),
    now: Date.now, active: agents ? async () => void (await agents()) : undefined }; // agents() 走 whileOwned：失租即抛
}

/** worktrees 根的真实路径（每层都不是软链）；根不存在 = null */
function realRoot(root: string): string | null {
  const abs = resolve(root);
  return existsSync(abs) ? noLinks(abs) : null;
}

/** 卡目录本身若在，不能是软链、真实路径就是它；不在 = 没软链可言 */
function dirSafe(real: string, dir: string): string | null {
  const p = join(real, dir);
  if (isLink(p)) return "是软链，拒绝回收";
  try { if (existsSync(p)) noLinks(p); } catch (e) { return errMsg(e); }
  return null;
}

/** 同一件事（目录 / 进程）一次回收里只记一行 */
function onceLog(d: CardProcDeps, head: string): (what: string, why: string) => void {
  const seen = new Set<string>();
  return (what, why) => { if (!seen.has(what)) { seen.add(what); d.log(`${head} ${what}：${why}`); } };
}

/** 根还是当初那个真实路径（没被删、没变成软链） */
function rootStill(root: string, real: string): boolean {
  try { return realRoot(root) === real; } catch { return false; }
}

/** 进程的完整 cwd 从根往下现存各层都不是软链（已删的 cwd 查仍在的祖先）；不是就记一行 */
function cwdOk(real: string, p: Proc, skip: (what: string, why: string) => void): boolean {
  const bad = cwdLinkFree(real, p.cwd);
  if (bad) skip(`pid=${p.pid}`, bad);
  return !bad;
}

/** 没停的 agent 的 cwd 落在哪些一级目录下（停 = stopped 且没有 pending、没有窗口，与 scheduler-retire.ts 的 stopped 同义） */
async function heldDirs(host: CardReapHost, real: string): Promise<Map<string, string>> {
  const held = new Map<string, string>();
  for (const a of (await host.agents?.()) ?? []) {
    if ((a.status === "stopped" && !a.pending && !a.window) || !a.cwd) continue;
    let cwd = resolve(a.cwd);
    try { cwd = realpathSync(cwd); } catch { /* 目录没了：按写的比 */ }
    const dir = dirOf(real, cwd);
    if (dir) held.set(dir, a.name);
  }
  return held;
}

/** 卡 id → 调度器给它建的两个 worktree 目录名（与 scheduler-retire.ts 的 worktreeDirs 同一套规则） */
function cardDirNames(taskId: string): string[] {
  const low = taskId.toLowerCase();
  if (!/^[\w.-]+$/.test(low) || /^\.+$/.test(low)) return [];
  return [low, `rv-${low}`];
}

/** observe 看到的一个对象：进程 + 归属卡 + 为什么算残留 */
type Found = Pick & { task: LedgerTask; why: string };
/** 现建资格判定（根 / 软链 / 活 agent 占用 / 卡状态 / 冻结 / 档位全部现读）再枚举一次进程表，返回此刻够格的对象 */
type Scan = () => Promise<Found[]>;

/** 还是当初那个进程、还归那张卡：pid / uid / cwd / 命令都没变，存活时间没倒退（倒退 = pid 被新进程复用） */
function sameProc(a: Found, b: Found): boolean {
  return a.p.pid === b.p.pid && a.p.uid === b.p.uid && a.p.cwd === b.p.cwd && a.p.comm === b.p.comm
    && a.task.id === b.task.id && a.task.project === b.task.project
    && (a.p.ageSec === null || b.p.ageSec === null || b.p.ageSec >= a.p.ageSec);
}

/**
 * observe：只记录、零信号；同一进程只推 PM 一次。每个项目的摘要发出前 rescan 一次，只报复查时仍是同一进程、仍够格的；
 * 复查不到的不报也不记台账，一组全空不发。复查或推送失败都不记台账，下轮再试；失租原样抛。
 */
async function observe(first: Found[], rescan: Scan, host: CardReapHost, d: CardProcDeps): Promise<number> {
  for (const { p, owner } of first) d.log(procLine(p, owner, "无（observe）", "只记录"));
  const byProject = new Map<string, Found[]>();
  for (const x of first) if (!d.observed.has(procKey(x.p))) byProject.set(x.task.project, [...(byProject.get(x.task.project) ?? []), x]);
  for (const [project, group] of byProject) {
    let step = "发送前复查失败";
    try {
      const now = await rescan();
      const alive = group.flatMap((x) => now.filter((y) => sameProc(x, y)).slice(0, 1));
      const dropped = group.filter((x) => !alive.some((y) => y.p.pid === x.p.pid));
      if (dropped.length) d.log(`残留进程 observe 发送前复查（项目 ${project}）：${dropped.length} 个已退出或身份 / 资格已变，不报：pid=${dropped.map((x) => x.p.pid).join(",")}`);
      if (!alive.length) continue;
      const lines = alive.map(({ p, owner, why }) => `- pid=${p.pid} ${owner} 命令=${basename(p.comm).slice(0, 40)} 存活=${p.ageSec ?? "?"}s（${why}）`);
      const text = `[调度引擎] 卡 worktree 下有 ${alive.length} 个残留进程（observe 模式：只记录，没发信号；这是发送前刚复查进程表的快照，`
        + `你查看时可能已经退出；要回收：ledger scheduler-recovery ${project} on --key ${CARD_REAP_KEY} --reason <为什么>）：\n${lines.join("\n")}`;
      step = "摘要没推出去";
      await host.notifyPm(alive[0].task, text);
      d.observed.add(alive.map(({ p, task, why }) => ({ key: procKey(p), card: task.id, pid: p.pid, comm: basename(p.comm).slice(0, 40), at: d.now(), why })));
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      d.log(`残留进程 observe ${step}（项目 ${project}，没记已通知，下轮再试）：${errMsg(e)}`);
    }
  }
  return 0;
}

/**
 * 收卡：cwd 落在这张卡执行者 / 审查员 worktree（含子目录）下的同 uid 进程，TERM → 宽限 → KILL（observe 只记录）。
 * 档位按卡的项目现读。除失租外的失败只记日志，不挡收卡；返回发了 TERM 的个数。
 */
export async function reapCardProcs(task: LedgerTask, host: CardReapHost): Promise<number> {
  const d = defaultCardProcs(host);
  if (!d || d.mode === "off") return 0;
  try {
    const mode = modeOf(d, task.project);
    if (mode === "off") return 0;
    const skip = onceLog(d, "收卡回收跳过");
    const owner = `卡=${task.id}`;
    const picker = async (): Promise<((ps: Proc[]) => Pick[]) | null> => { // 根、活 agent 占用现读
      const real = realRoot(host.worktreeRoot);
      if (!real) return null;
      const held = await heldDirs(host, real);
      return (ps) => { // TERM 前、KILL 前各挑一次，每次都重查根、卡目录与完整 cwd（宽限期间可能被换成软链）
        if (!rootStill(host.worktreeRoot, real)) return skip("worktrees 根", "已不在或变成软链"), [];
        const names = cardDirNames(task.id).filter((n) => {
          const bad = dirSafe(real, n) ?? (held.has(n) ? `${held.get(n)} 还在这里工作（agent 没停）` : null);
          if (bad) skip(`worktrees/${n}`, bad);
          return !bad;
        });
        return ps.flatMap((p) => (names.includes(dirOf(real, p.cwd) ?? "") && cwdOk(real, p, skip) ? [{ p, owner }] : []));
      };
    };
    if (mode === "observe") {
      const scan: Scan = async () => { // 先枚举、后读现状：判定用的是进程表之后的根 / 占用 / 档位
        if (modeOf(d, task.project) !== "observe") return [];
        const ps = (await d.ports.list()).filter((p) => mayTouch(p, d.ports));
        const pick = modeOf(d, task.project) === "observe" ? await picker() : null;
        return pick ? pick(ps).map((x) => ({ ...x, task, why: `卡已 ${task.stage}` })) : [];
      };
      return await observe(await scan(), scan, host, d);
    }
    const pick = await picker();
    return pick ? await termThenKill(pick, d) : 0;
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    d.log(`回收 ${task.id} 的残留进程失败（不挡收卡）：${errMsg(e)}`);
    return 0;
  }
}

type DirOwner = { task: LedgerTask; frozen: boolean } | { skip: string };

/** worktree 目录名 → 卡（两张卡撞同一个目录名（大小写不同）= 拿不准），外加台账里有卡的全部项目 */
function dirOwners(db: Database): { dirs: Map<string, DirOwner>; projects: Set<string> } {
  const tasks = db.query("SELECT id, project, stage FROM tasks").all() as LedgerTask[];
  const frozen = new Map<string, boolean>();
  const dirs = new Map<string, DirOwner>();
  for (const task of tasks) {
    if (!frozen.has(task.project)) frozen.set(task.project, getMeta(db, task.project).queueFrozen.frozen);
    for (const n of cardDirNames(task.id)) {
      dirs.set(n, dirs.has(n) ? { skip: "目录名对上不止一张卡，拿不准" } : { task, frozen: frozen.get(task.project)! });
    }
  }
  return { dirs, projects: new Set(frozen.keys()) };
}

/** 这个目录能不能巡检收；不能 = 原因（都值得记一行） */
function patrolCheck(real: string, dir: string, owners: Map<string, DirOwner>, held: Map<string, string>): DirOwner {
  const o = owners.get(dir);
  if (!o) return { skip: "目录名对不上任何卡" };
  if ("skip" in o) return o;
  if (!(STAGES as readonly string[]).includes(o.task.stage)) return { skip: `卡 ${o.task.id} 状态未知（${String(o.task.stage)}）` };
  if (o.frozen) return { skip: `卡 ${o.task.id} 所在项目队列冻结` };
  if (held.has(dir)) return { skip: `${held.get(dir)} 还在这里工作（agent 没停）` };
  const bad = dirSafe(real, dir);
  return bad ? { skip: bad } : o;
}

const lastPatrol = new Map<string, number>();

/**
 * 周期巡检（自带节流，同一 worktrees 根 ORPHAN_EVERY_MS 一次）：ppid=1、cwd 在 worktrees 根下、并且卡已终态或 cwd 已不存在 → 回收。
 * 档位按每张卡的项目现读：on 的项目走 TERM → 宽限 → KILL，observe 的只记录，off 的项目不看、不记；全是 off 就不枚举进程表。
 * 卡状态未知 / 目录名对不上 / 冻结 / 软链：零信号，记一行。失租外的失败只记日志；返回发了 TERM 的个数。
 */
export async function patrolCardProcs(db: Database, host: CardReapHost): Promise<number> {
  const d = defaultCardProcs(host);
  if (!d || d.mode === "off") return 0;
  const key = resolve(host.worktreeRoot), now = d.now();
  if (now - (lastPatrol.get(key) ?? -Infinity) < ORPHAN_EVERY_MS) return 0;
  lastPatrol.set(key, now);
  try {
    let projects: Set<string>;
    try { projects = dirOwners(db).projects; } catch (e) { d.log(`卡残留进程巡检本轮跳过：台账读不到（${errMsg(e)}）`); return 0; }
    const wanted = new Set([...projects].map((p) => modeOf(d, p)));
    const skip = onceLog(d, "卡残留进程巡检跳过");
    /** 现建 want 档的判定：根、活 agent 占用、卡状态 / 冻结、档位都现读；别的档位的项目的目录不看、不记 */
    const decider = async (want: CardReapMode): Promise<((ps: Proc[]) => Found[]) | null> => {
      const real = realRoot(host.worktreeRoot);
      if (!real) return null;
      const held = await heldDirs(host, real), owners = dirOwners(db).dirs;
      const modes = new Map<string, CardReapMode>();
      const mine = (project: string) => modes.get(project) ?? modes.set(project, modeOf(d, project)).get(project)!;
      return (ps) => { // TERM 前、KILL 前各判一次，每次都重查根、目录与完整 cwd；每个目录 / 进程只记一行
        if (!rootStill(host.worktreeRoot, real)) return skip("worktrees 根", "已不在或变成软链"), [];
        const checked = new Map<string, DirOwner | null>();
        const check = (dir: string): DirOwner | null => {
          if (!checked.has(dir)) {
            const o = owners.get(dir);
            checked.set(dir, o && "task" in o && mine(o.task.project) !== want ? null : patrolCheck(real, dir, owners, held));
          }
          const c = checked.get(dir)!;
          if (c && "skip" in c) skip(`worktrees/${dir}`, c.skip);
          return c;
        };
        return ps.flatMap((p) => {
          const dir = p.ppid === 1 ? dirOf(real, p.cwd) : null;
          const c = dir === null ? null : check(dir);
          if (!c || "skip" in c || !cwdOk(real, p, skip)) return [];
          const done = RETIRE_STAGES.includes(c.task.stage), gone = !existsSync(p.cwd);
          return done || gone ? [{ p, owner: `卡=${c.task.id}`, task: c.task, why: done ? `卡已 ${c.task.stage}` : "cwd 目录已删" }] : [];
        });
      };
    };
    let sent = 0;
    if (wanted.has("on")) {
      const pick = await decider("on");
      if (pick) sent = await termThenKill(pick, d);
    }
    if (wanted.has("observe")) {
      const scan: Scan = async () => { // 先枚举、后读现状：判定用的是进程表之后的台账 / 占用 / 档位
        const ps = (await d.ports.list()).filter((p) => mayTouch(p, d.ports));
        return (await decider("observe"))?.(ps) ?? [];
      };
      await observe(await scan(), scan, host, d);
    }
    return sent;
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    d.log(`卡残留进程巡检失败：${errMsg(e)}`);
    return 0;
  }
}

/** 测试用：清节流 */
export function resetCardPatrolClock(): void { lastPatrol.clear(); }
