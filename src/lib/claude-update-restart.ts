/**
 * Claude Code 自动升级后的重启波（hardening-CCIDLE1，审计 A15-05）。
 *
 * 以前 launcher 只在升级前读一次 busyAgentWindows，brew / npm 安装 + 体检 await 几分钟后直接金丝雀 + 无条件
 * `manager restart`（全员）+ 给 master 打 /exit——期间开始的正常回合被 gracefulExit 打断。现在：
 * - 身份（registry 会话 + tmux 窗口 id；master 的 pane pid + 窗口里在跑的 Claude 会话 / 进程）在升级前全员空闲那一刻拍下，之后不再换；
 *   master 的 Claude 是送进常驻 shell 的普通命令，pane pid 不随它重开 / 换会话而变，所以必须另绑 Claude 这一代；
 * - 每个目标走 `manager restart --idle-only <身份> -- <名>`（src/manager/restart-idle.ts）：manager 在该 agent 的重启锁里、
 *   开始退出之前再核身份与活动，忙 / 读不出 / 身份变了就跳过、不碰窗口；master 由这里按同一规则核完再打 /exit；
 * - 跳过的目标记进 pending（版本 + 身份），launcher 下一轮只续波、不重装同一版本；金丝雀没过之前其余一律不动；
 * - 失败预算照旧：金丝雀起不来 → 中止其余、告警、不留 pending；金丝雀之后个别起不来 → 记失败、不反复重启。
 * 人工 `manager restart` 不带 --idle-only，语义不变。tests/claude-update-audit-idle*.test.ts。
 */
import { canaryPlan, parseManagerList, restartFailureReason, type RestartRunOutcome } from "./restart-result.js";
import { windowLooksIdle } from "./busy-windows.js";
import { isMasterAgent } from "./registry.js";
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";

/** 计划时拍下的身份：registry 会话 + 同名 tmux 窗口 id（没窗口 = []，同名多份全记上） */
interface WaveTarget { name: string; sessionId: string; windows: string[] }
export interface PendingWave {
  /** 已装好的 Claude Code 版本：续波只认这一版，换了就丢 */
  version: string;
  since: number;
  /** 还没重启的目标 */
  targets: WaveTarget[];
  /** 可当金丝雀的（活着的 CC agent，canaryPlan 同一判据），按 list 顺序 */
  canaries: string[];
  canaryDone: boolean;
  /** master 窗口的 pane pid；null = master 不用（再）重启 */
  master: string | null;
  /** master 窗口里在跑的那一代 Claude（WavePorts.masterRun）；"" = 拍身份时读不出，动手前一律按说不准延后 */
  masterRun?: string;
}
export interface WavePorts {
  masterWindow: string;
  /** 告警里 @ 的人 */
  mention: string;
  session: string;
  manager(args: string[], timeoutMs: number): Promise<RestartRunOutcome>;
  tmux(args: string[]): Promise<string>;
  /** master 窗口里此刻在跑的 Claude：会话 + 进程（换会话 / 重开都会变）；读不出 = ""（或抛） */
  masterRun(): Promise<string>;
  /** 这一代 master Claude（masterRun 的值）的回合代际：会话记录的大小 + 修改时间，同步读，开回合就会变；读不了 = null（master 延后）。不给 = 不核（只合成测试） */
  masterMark?(run: string): string | null;
  /** 这一代 master Claude 此刻是否仍在、仍是那个会话（同步读，lib/claude-update-restart-live.ts）：最后一次 masterRun() 返回过时快照也挡得住。不给 = 不核（只合成测试） */
  masterLive?(run: string): boolean;
  registry(): Promise<{ name: string; status?: string; sessionId?: string }[]>;
  /** 升级前的全员闸（busyAgentWindows） */
  busy(): Promise<string[]>;
  /** 安装 + 体检；返回装好的版本，null = 已中止（自己报过） */
  install(): Promise<string | null>;
  readPending(): PendingWave | null;
  writePending(p: PendingWave | null): void;
  notify(zh: string, en: string): Promise<void>;
  log(msg: string): void;
  /** 压住 dead-agent 巡检的租约 */
  lease(ms: number): void;
  now(): number;
}
export type WaveOutcome =
  | { kind: "busy"; names: string[] }
  | { kind: "aborted" }
  | { kind: "wave"; version: string; restarted: string[]; deferred: string[]; failed: string[]; canaryFailed?: string };
type One = { kind: "ok" } | { kind: "skipped" | "failed"; reason: string };

/** pending 最多留这么久（一周一检的周期）；过了还没等到空闲就丢，交给下一次升级 */
const PENDING_MAX_MS = 7 * 24 * 60 * 60_000;

/**
 * 会话记录文件的「回合代际」：大小 + 修改时间。没路径 / 文件不在 / stat 失败 = null（没有可靠代际，不是「没变」：
 * 活窗口与 master 一律按读不出延后）。manager 复核（restart-idle.ts）与 launcher 的 master 共用
 */
export function transcriptMark(path: string | null): string | null {
  if (!path) return null;
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
}

async function masterPid(p: WavePorts): Promise<string> {
  return (await p.tmux(["display-message", "-p", "-t", p.masterWindow, "#{pane_pid}"])).trim();
}

/** 升级前拍身份。list 失败时 canaries = null（照既有设计无金丝雀继续，但要喊出来） */
async function snapshot(p: WavePorts): Promise<{ targets: WaveTarget[]; canaries: string[] | null; listFailed?: string; master: string | null; masterRun: string }> {
  const windows = new Map<string, string[]>();
  for (const line of (await p.tmux(["list-windows", "-t", p.session, "-F", "#{window_name}\t#{window_id}"])).split("\n")) {
    const [name, id] = line.split("\t");
    if (name?.startsWith("agent-") && id) windows.set(name, [...(windows.get(name) ?? []), id]);
  }
  const reg = await p.registry();
  const session = new Map(reg.map((a) => [a.name, a.sessionId ?? ""]));
  // 与 manager restart 全员目标同一口径：活窗口 + registry 里 active 却没窗口的
  const dead = reg.filter((a) => a.status === "active" && !windows.has(a.name) && !isMasterAgent(a.name)).map((a) => a.name);
  const targets = [...windows.keys(), ...dead].map((name) => ({ name, sessionId: session.get(name) ?? "", windows: windows.get(name) ?? [] }));
  const list = parseManagerList(await p.manager(["list"], 30_000));
  const canaries = list.ok ? list.agents.filter((a) => canaryPlan({ ok: true, agents: [a] }).kind === "canary").map((a) => a.name) : null;
  const master = (await masterPid(p).catch(() => "")) || null;
  return { targets, canaries, listFailed: list.ok ? undefined : list.reason, master, masterRun: master ? await p.masterRun().catch(() => "") : "" };
}

async function restartIdle(p: WavePorts, t: WaveTarget): Promise<One> {
  p.lease(15 * 60_000); // 每个目标前续租：单个重启最多等 5 分钟，整波可能比一份租约长
  let r: RestartRunOutcome;
  try {
    r = await p.manager(["restart", "--idle-only", JSON.stringify({ sessionId: t.sessionId, windows: t.windows }), "--", t.name], 300_000);
  } catch (e) {
    return { kind: "skipped", reason: `restart 拉不起来：${(e as Error).message.slice(0, 200)}` }; // 没碰到窗口，留 pending 下一轮再来
  }
  let row: { ok?: boolean; skipped?: unknown; error?: unknown } | undefined;
  try {
    row = (JSON.parse(r.out || "").results as typeof row[]).find((x) => (x as { name?: string }).name === t.name);
  } catch { /* 输出读不出：下面按失败报 */ }
  if (!row) return { kind: "failed", reason: restartFailureReason(r) ?? "restart 没有该 agent 的结果" };
  if (row.ok === true) return { kind: "ok" };
  if (typeof row.skipped === "string") return { kind: "skipped", reason: row.skipped };
  return { kind: "failed", reason: typeof row.error === "string" ? row.error : "restart 失败" };
}

/**
 * master 同一规则：身份（pane pid + 这一代 Claude）没换、画面明确空闲；回合代际 → 身份 → 画面 → 身份 → 画面 → 身份 → 回合代际，
 * 收尾的身份兜住最后一次画面读取期间换进程 / 换会话；身份不变、同一会话开了回合（哪怕发生在最后一次身份读取里）由首尾两次
 * 同步读的回合代际兜住，核完不再 await 就打 /exit。代际首尾任一读不出（null）= 没有可靠代际，延后，不当「没变」。
 * 最后一次 masterRun() 可能返回读取开始时的过时快照（期间换了一代 Claude）：发键前再同步核这一代进程 + 会话登记（masterLive）；
 * masterLive 夹在首尾代际之间（第 6 轮 live-turn-race），最后一步永远是回合代际
 */
async function restartMasterIdle(p: WavePorts, pid: string, run: string): Promise<One> {
  const identity = async (): Promise<string | null> => {
    const now = await masterPid(p);
    if (now !== pid) return `master 进程换了（${pid} → ${now || "无"}）`;
    if (!run) return "master 的 Claude 会话在拍身份时读不出";
    const cur = await p.masterRun();
    return cur === run ? null : `master 的 Claude 换了（${run.slice(0, 8)} → ${cur.slice(0, 8) || "无"}）`;
  };
  const pane = async (): Promise<string | null> => {
    const text = await p.tmux(["capture-pane", "-t", p.masterWindow, "-p"]);
    return text.trim() && windowLooksIdle(undefined, text) ? null : "master 在忙或画面读不出";
  };
  const mark = (): string | null => (run && p.masterMark ? p.masterMark(run) : "");
  const live = (): string | null => (!p.masterLive || p.masterLive(run) ? null : "master 的 Claude 已不是拍身份时那一代（进程 / 会话变了）");
  try {
    const gen = mark();
    const turn = (): string | null => {
      const now = mark();
      if (gen === null || now === null) return "master 的回合代际读不出（会话记录不在或读失败）";
      return now === gen ? null : "master 开了新回合（会话记录有新写入）";
    };
    const why = (await identity()) ?? (await pane()) ?? (await identity()) ?? (await pane()) ?? (await identity()) ?? live() ?? turn();
    if (why) return { kind: "skipped", reason: why };
    // 收尾 live（同步 ps，期间别的进程照样能开回合）在前、回合代际在最后：live 期间开的回合也被末次代际看到；之后不隔 await，发键当下 spawn
    await p.tmux(["send-keys", "-t", p.masterWindow, "/exit", "Enter"]); // 退出后由 launcher 主循环拉起
    return { kind: "ok" };
  } catch (e) {
    return { kind: "skipped", reason: `读 master 失败：${(e as Error).message.slice(0, 200)}` };
  }
}

/** 按 pending 跑一遍：金丝雀先过，再其余，最后 master；跳过的留 pending */
async function runWave(p: WavePorts, w: PendingWave): Promise<WaveOutcome> {
  p.lease(15 * 60_000);
  const restarted: string[] = [];
  const failed: string[] = [];
  let rest = [...w.targets];
  const done = (deferred: WaveTarget[], master: string | null, canaryDone: boolean, canaryFailed?: string): WaveOutcome => {
    p.writePending(!canaryFailed && (deferred.length || master) ? { ...w, targets: deferred, master, canaryDone } : null);
    p.lease(2 * 60_000); // 收尾：留 2 分钟冷却后恢复巡检
    const names = [...deferred.map((t) => t.name), ...(master ? ["master"] : [])];
    return { kind: "wave", version: w.version, restarted, deferred: canaryFailed ? [] : names, failed, ...(canaryFailed ? { canaryFailed } : {}) };
  };
  let canaryDone = w.canaryDone;
  for (const t of canaryDone ? [] : rest.filter((x) => w.canaries.includes(x.name))) {
    const r = await restartIdle(p, t);
    p.log(`🆙 金丝雀 ${t.name}: ${r.kind}${r.kind === "ok" ? "" : ` ${r.reason}`}`);
    if (r.kind === "skipped") continue; // 忙的不当金丝雀，换下一个空闲的
    rest = rest.filter((x) => x !== t);
    if (r.kind === "failed") {
      failed.push(t.name);
      await p.notify(
        `🚨 **升级后金丝雀重启失败**(${t.name} 启动不了),已中止其余 agent 的重启波——它们继续跑旧进程。需人工排查新版 Claude Code ${p.mention}`,
        `🚨 **Post-upgrade canary restart failed** (${t.name} won't start). Remaining agents keep old processes. Manual investigation needed ${p.mention}`,
      ).catch((e) => p.log(`🆙 金丝雀告警没发出去：${(e as Error).message}`));
      return done([], null, false, t.name);
    }
    restarted.push(t.name);
    canaryDone = true;
    break;
  }
  if (!canaryDone) return done(rest, w.master, false); // 候选全在忙：整波等下一轮
  const deferred: WaveTarget[] = [];
  for (const t of rest) {
    const r = await restartIdle(p, t);
    if (r.kind === "ok") restarted.push(t.name);
    else if (r.kind === "failed") failed.push(t.name);
    else deferred.push(t);
    if (r.kind !== "ok") p.log(`🆙 ${t.name} ${r.kind === "failed" ? "重启失败" : "延后"}：${r.reason}`);
  }
  let master = w.master;
  if (master) {
    const r = await restartMasterIdle(p, master, w.masterRun ?? "");
    if (r.kind === "ok") { restarted.push("master"); master = null; } else p.log(`🆙 master 延后：${r.reason}`);
  }
  return done(deferred, master, true);
}

/** 新版本已发现：全员闸 → 拍身份 → 安装 → 重启波 */
export async function startUpdateWave(p: WavePorts): Promise<WaveOutcome> {
  const busy = await p.busy();
  if (busy.length) return { kind: "busy", names: busy };
  const snap = await snapshot(p);
  const version = await p.install();
  if (!version) return { kind: "aborted" };
  if (snap.canaries === null) {
    // list 失败时按 25b66f7 的既有设计无金丝雀继续（是否 fail-closed 待 owner 拍板），但必须喊出来
    const why = (snap.listFailed ?? "").slice(0, 300);
    await p.notify(
      `⚠️ 升级后重启波**没有金丝雀**：manager list 失败（${why}），按既有设计继续重启（只重启空闲的），结果另行汇报`,
      `⚠️ Post-upgrade restart wave is running **without a canary**: manager list failed (${why}); proceeding (idle agents only), results to follow`,
    ).catch((e) => p.log(`🆙 无金丝雀告警没发出去：${(e as Error).message}`));
  }
  const canaries = snap.canaries ?? [];
  const w: PendingWave = { version, since: p.now(), targets: snap.targets, canaries, canaryDone: canaries.length === 0, master: snap.master, masterRun: snap.masterRun };
  p.writePending(w); // 先落盘：launcher 中途挂了下一轮也能续上，不再重装
  return runWave(p, w);
}

/** launcher 每轮先调：有 pending 就续波（不安装）；null = 没有要续的 */
export async function continueWave(p: WavePorts, installed: string): Promise<WaveOutcome | null> {
  const w = p.readPending();
  if (!w) return null;
  if (w.version !== installed || p.now() - w.since > PENDING_MAX_MS) {
    p.log(`🆙 丢弃重启波 pending（${w.version}，当前 ${installed}）`);
    p.writePending(null);
    return null;
  }
  return runWave(p, w);
}

/** 波的结果 → #control 文案；续波一轮什么都没发生就不报 */
export function waveReport(o: Extract<WaveOutcome, { kind: "wave" }>, mention: string): [string, string] | null {
  if (o.canaryFailed) return null; // 金丝雀失败已当场告警
  if (!o.restarted.length && !o.failed.length) return null;
  const later = o.deferred.length ? `；在忙的 ${o.deferred.join(", ")} 延后到空闲再重启` : "";
  const laterEn = o.deferred.length ? `; busy ${o.deferred.join(", ")} deferred until idle` : "";
  if (o.failed.length) {
    return [
      `⚠️ **Claude Code 已更新到 v${o.version}，但重启波没有全部成功**：${o.failed.join(", ")} 重启失败${later}\n手动重试：\`bun src/manager.ts restart <name>\` ${mention}`,
      `⚠️ **Claude Code updated to v${o.version}, but the restart wave did not fully succeed**: ${o.failed.join(", ")} failed${laterEn}\nRetry manually: \`bun src/manager.ts restart <name>\` ${mention}`,
    ];
  }
  if (o.deferred.length) {
    return [`🆙 Claude Code v${o.version}：已重启 ${o.restarted.join(", ")}${later} ${mention}`, `🆙 Claude Code v${o.version}: restarted ${o.restarted.join(", ")}${laterEn} ${mention}`];
  }
  return [`✅ **Claude Code 更新完成** v${o.version}，所有 agent 已重启 ${mention}`, `✅ **Claude Code updated** to v${o.version}, all agents restarted ${mention}`];
}

/** pending 落盘（launcher 重启后接着续）；读坏了按没有 */
export function pendingStore(path: string): Pick<WavePorts, "readPending" | "writePending"> {
  return {
    readPending: () => { try { return JSON.parse(readFileSync(path, "utf8")) as PendingWave; } catch { return null; } },
    writePending: (w) => {
      if (!w) { try { unlinkSync(path); } catch { /* 本来就没有 */ } return; }
      writeFileSync(`${path}.tmp`, JSON.stringify(w));
      renameSync(`${path}.tmp`, path);
    },
  };
}
