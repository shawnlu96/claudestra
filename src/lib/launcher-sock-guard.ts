/**
 * launcher 的 tmux 套接字护栏（SOCKGUARD1）：连续确认 absent 才新建 master、new-session 前查同路径服务进程、
 * 探测不可信时冻结依赖窗口列表的判断（dead 恢复、自动升级的「全员空闲」）、一次大量 dead 不批量复活、USR1 自愈。
 * 窗口列表只有在连着「真的那个服务」时才可信：连上一个空的新服务，所有 agent 都像死了、都像空闲。
 * 例外「确认新建」：连续 3 次 absent、new-session 前无同路径服务、新建后当场记下服务 pid 和套接字 inode；之后只要 pid、inode
 * 都对得上，窗口列表就是自己刚起的服务（空是真空），dead 恢复不冻结、不受大量 dead 阈值限制（真重启不等人）。
 * 恢复键 tmuxSockHeal（off / observe / on，缺省 observe）每次现读。tests/launcher-sock-guard.test.ts。
 */
import { busyAgentWindows } from "./busy-windows.js";
import { t } from "./i18n.js";
import { notify } from "./notify.js";
import { readProjects, resolveProjectForDir } from "./projects.js";
import { recoveryPolicy, type RecoveryKey } from "./recovery-policy.js";
import { readActiveAgents } from "./registry.js";
import { REPO_ROOT } from "./repo-root.js";
import { LIVE_PROBE_PORTS, masterSessionProbe, planSockHeal, sameSockServers, type SockHealMode, type SockProbe, type TmuxServerProc } from "./tmux-sock-probe.js";

const SOCK_HEAL_KEY: RecoveryKey = "tmuxSockHeal";
const ABSENT_CONFIRM = 3;
const ABSENT_GAP_MS = 2_000;
const HEAL_WAIT_MS = 2_000;
const UNKNOWN_LOG_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;
const CREATED_FREEZE_MS = 10 * 60_000;
const MASS_DEAD_MIN = 10;
const MASS_DEAD_HUMAN_ROUNDS = 3;

export interface SockGuardPorts {
  probe: () => Promise<SockProbe>;
  /** 同路径 tmux 服务进程；null = 进程表读不了 */
  servers: () => Promise<TmuxServerProc[] | null>;
  /** 套接字当前 inode；null = 不在或读不了 */
  inode: () => number | null;
  healMode: () => Promise<SockHealMode>;
  /** 只发 SIGUSR1，别的信号这里没有入口 */
  usr1: (pid: number) => void;
  activeCount: () => Promise<number>;
  busy: (masterWindow: string, key?: string) => Promise<string[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (msg: string) => void;
  alert: (text: string) => Promise<void>;
}

/** exists = 照常；start = 连续 3 次 absent，可以新建；hold = 本轮什么都不做（不新建） */
export type MasterVerdict = "exists" | "start" | "hold";
/** skip = 本轮不恢复；confirmed = 确认新建的服务，恢复不受阈值限制；normal = 照常（受阈值限制） */
export type RestoreMode = "skip" | "confirmed" | "normal";
interface ServerId { pid: number; inode: number }

export class LauncherSockGuard {
  private lastState: SockProbe["state"] | null = null;
  private createdAt = Number.NEGATIVE_INFINITY;
  private readonly said = new Map<string, number>();
  /** USR1 发过仍不通的 pid：不再发，等人处理 */
  private readonly healFailed = new Set<number>();
  private massStreak = 0;
  /** 本次 start 判定是否来自残留套接字；以及允许 created() 记确认新建（只有 check 判了 start 才算） */
  private startStale = false;
  private startApproved = false;
  private confirmed: ServerId | null = null;
  private confirmedAnnounced = false;
  constructor(private readonly p: SockGuardPorts) {}

  async check(): Promise<MasterVerdict> {
    try { return await this.decide(); } catch (e) {
      this.p.log(`🧷 tmux 探测出错，本轮不动：${(e as Error).message}`); // 主循环不能因探测抛错而退出（launcher 退了没人拉大总管）
      return "hold";
    }
  }

  private async decide(): Promise<MasterVerdict> {
    this.startApproved = false;
    let stale = false;
    for (let i = 0; i < ABSENT_CONFIRM; i++) {
      if (i) await this.p.sleep(ABSENT_GAP_MS);
      const probe = await this.observe();
      if (probe.state === "exists") return "exists";
      if (probe.state === "unknown") {
        await this.onUnknown(probe);
        return "hold";
      }
      stale ||= probe.stale;
    }
    this.p.log(`🧷 tmux 探测连续 ${ABSENT_CONFIRM} 次 absent${stale ? "（残留套接字）" : ""}，允许新建 master`);
    this.startStale = stale;
    this.startApproved = true;
    return "start";
  }

  /** startMaster 在 new-session 之后调：新服务可连、同路径服务恰好一个、套接字有 inode，才记成「确认新建」 */
  async created(): Promise<void> {
    if (!this.startApproved) return;
    this.startApproved = false;
    const probe = await this.observe();
    const servers = await this.p.servers();
    const inode = this.p.inode();
    if (probe.state !== "exists" || servers?.length !== 1 || inode === null) {
      this.confirmed = null;
      this.p.log(`🧷 新建后核不出新服务（探测 ${probe.state}，服务 ${servers?.length ?? "?"} 个，inode ${inode ?? "无"}），不算确认新建`);
      return;
    }
    this.confirmed = { pid: servers[0].pid, inode };
    this.confirmedAnnounced = false;
    this.p.log(`🧷 确认新建 master：服务 pid ${this.confirmed.pid}，套接字 inode ${inode}`);
    if (this.startStale) await this.alert(t("🧷 残留套接字：无服务进程、无持有者，已新建 master。", "🧷 Stale socket: no server, no holder; created a new master."));
  }

  /** startMaster 在 new-session 之前调：有同路径服务进程（或查不了）就不建。放行即记下新建时刻（冻结 10 分钟） */
  async claimCreate(): Promise<boolean> {
    const servers = await this.p.servers();
    if (servers === null) {
      this.once("create:ps", HOUR_MS, () => this.p.log("🧷 new-session 前读不了进程表，本轮不新建 master"));
      return false;
    }
    if (servers.length) {
      const pids = servers.map((s) => s.pid).join(",");
      await this.alertOnce(`create:${pids}`, t(
        `⚠️ launcher 本要新建 master，但同路径 tmux 服务进程还在（pid ${pids}），不新建。等它的套接字恢复，或人工确认后处理。`,
        `⚠️ launcher was about to create master, but a tmux server on the same socket path is still running (pid ${pids}); not creating.`,
      ));
      return false;
    }
    this.createdAt = this.p.now();
    return true;
  }

  /** 依赖窗口列表的判断此刻该不该冻结；返回原因，null = 不冻结 */
  frozen(): string | null {
    if (this.lastState !== "exists") return `tmux 探测 ${this.lastState ?? "未做"}`;
    if (this.p.now() - this.createdAt < CREATED_FREEZE_MS) return "10 分钟内新建过 master";
    return null;
  }

  /** restoreDeadAgents 入口：探测不是 exists 一律跳过；确认新建且 pid / inode 都对得上 = confirmed；否则按冻结规则 */
  async restoreMode(source: string): Promise<RestoreMode> {
    const skip = (why: string): RestoreMode => {
      this.once(`restore:${why}`, UNKNOWN_LOG_MS, () => this.p.log(`🔁 [${source}] 跳过 dead 恢复：${why}`));
      return "skip";
    };
    if (this.lastState !== "exists") return skip(`tmux 探测 ${this.lastState ?? "未做"}`);
    if (this.confirmed && await this.stillConfirmed()) return "confirmed";
    const why = this.frozen();
    return why ? skip(why) : "normal";
  }

  /** 自动升级的「全员空闲」判断：冻结时按「有人在忙」答，调用方照旧 30 分钟后重试 */
  async busy(masterWindow: string, key?: string): Promise<string[]> {
    const why = this.frozen();
    if (!why) return this.p.busy(masterWindow, key);
    this.once(`busy:${why}`, UNKNOWN_LOG_MS, () => this.p.log(`🆙 自动升级按「有人在忙」处理：${why}`));
    return [`tmux（${why}）`];
  }

  /** 一轮 dead ≥ 10 且超过 active 一半：这轮不复活（true），告警；连续 3 轮再告一次等人。低于阈值清零（false）。
   *  confirmed（确认新建的服务）不受阈值限制，第一次恢复发一条说明 */
  async massDead(names: string[], mode: RestoreMode = "normal"): Promise<boolean> {
    if (mode === "confirmed") {
      this.massStreak = 0;
      if (!this.confirmedAnnounced) {
        this.confirmedAnnounced = true;
        await this.alert(t(`🔁 确认新建后恢复 ${names.length} 个 agent`, `🔁 Restoring ${names.length} agent(s) after a confirmed new master`));
      }
      return false;
    }
    let active: number;
    try { active = await this.p.activeCount(); } catch (e) {
      this.p.log(`🔁 读不了 registry active 数，本轮不复活：${(e as Error).message}`);
      return true;
    }
    if (names.length < MASS_DEAD_MIN || names.length <= active / 2) {
      this.massStreak = 0;
      return false;
    }
    this.massStreak++;
    const head = names.slice(0, 5).join(" / ");
    this.p.log(`🔁 一次发现 ${names.length} 个 dead（active ${active}），第 ${this.massStreak} 轮，不批量复活`);
    if (this.massStreak === 1) {
      await this.alert(t(
        `⚠️ launcher 一次发现 ${names.length} 个 dead agent（active ${active}）：${head}…\n像是连到了别的 tmux 服务，本轮不批量复活，下一轮重新判断。`,
        `⚠️ launcher found ${names.length} dead agents at once (active ${active}): ${head}…\nLooks like a different tmux server; not mass-restoring this round, will re-check next round.`,
      ));
    } else if (this.massStreak === MASS_DEAD_HUMAN_ROUNDS) {
      await this.alert(t(
        `⚠️ 连续 ${MASS_DEAD_HUMAN_ROUNDS} 轮都发现 ${names.length} 个 dead，launcher 不自动复活，等人处理。确认是真重启后：bun src/manager.ts restart`,
        `⚠️ ${names.length} dead agents for ${MASS_DEAD_HUMAN_ROUNDS} rounds in a row; launcher won't auto-restore. If this really was a reboot: bun src/manager.ts restart`,
      ));
    }
    return true;
  }

  /** 当前同路径服务恰好一个，且 pid、inode 都与确认新建时一致；任一不一致或查不出就作废确认 */
  private async stillConfirmed(): Promise<boolean> {
    const servers = await this.p.servers();
    const inode = this.p.inode();
    const ok = servers?.length === 1 && servers[0].pid === this.confirmed?.pid && inode === this.confirmed?.inode;
    if (!ok) {
      this.p.log(`🧷 确认新建作废：服务 ${servers?.map((x) => x.pid).join(",") ?? "?"}、inode ${inode ?? "无"} 与新建时（pid ${this.confirmed?.pid}、inode ${this.confirmed?.inode}）不一致`);
      this.confirmed = null;
    }
    return ok;
  }

  private async observe(): Promise<SockProbe> {
    const probe = await this.p.probe();
    const was = this.lastState;
    this.lastState = probe.state;
    if (was === null || (was === "exists") !== (probe.state === "exists")) {
      const servers = probe.servers ?? await this.p.servers();
      const pids = servers === null ? "?" : servers.map((s) => s.pid).join(",") || "无";
      this.p.log(`🧷 tmux 探测 ${was ?? "(启动)"} → ${probe.state}（${probe.why}；服务 pid ${pids}；套接字 inode ${probe.inode ?? "无"}；code ${probe.code ?? "null"}）`);
    }
    return probe;
  }

  private async onUnknown(probe: SockProbe): Promise<void> {
    this.once(`unknown:${probe.why}`, UNKNOWN_LOG_MS, () =>
      this.p.log(`🧷 tmux 探测 unknown，不新建 master：${probe.why}（code ${probe.code ?? "null"}，${probe.ms}ms，stderr ${probe.stderr || "无"}）`));
    const plan = planSockHeal(probe, await this.p.healMode());
    if (plan.kind === "none") return;
    if (plan.kind === "alert") return this.alertOnce(`heal:${plan.why}`, `⚠️ ${plan.why}`);
    if (plan.kind === "observe") {
      this.once(`observe:${plan.pid}`, HOUR_MS, () => this.p.log(`🧷 ${SOCK_HEAL_KEY}=observe：本会对 pid ${plan.pid} 发 USR1 让它重建套接字`));
      return;
    }
    if (this.healFailed.has(plan.pid)) return this.alertOnce(`healfail:${plan.pid}`, t(
      `⚠️ tmux 服务 pid ${plan.pid} 发过 USR1 仍连不上，launcher 不再发信号、不新建，等人处理。`,
      `⚠️ tmux server pid ${plan.pid} still unreachable after USR1; launcher stops signalling and won't create a new one.`,
    ));
    this.p.log(`🧷 ${SOCK_HEAL_KEY}=on：对 pid ${plan.pid} 发 USR1`);
    try { this.p.usr1(plan.pid); } catch (e) { this.p.log(`🧷 USR1 发送失败：${(e as Error).message}`); } // 进程刚好退出（ESRCH）：下面再探一次照常判
    await this.p.sleep(HEAL_WAIT_MS);
    const after = await this.observe();
    if (after.state === "exists") {
      this.p.log(`🧷 USR1 后 master 恢复（pid ${plan.pid}，inode ${after.inode ?? "无"}）`);
      await this.alert(t(`🩹 tmux 套接字已由老服务 pid ${plan.pid} 重建，master 恢复。`, `🩹 tmux socket rebuilt by server pid ${plan.pid}; master is back.`));
      return;
    }
    this.healFailed.add(plan.pid);
    await this.alertOnce(`healfail:${plan.pid}`, t(
      `⚠️ 对 tmux 服务 pid ${plan.pid} 发 USR1 后仍不通（${after.why}），launcher 停手、不新建，等人处理。`,
      `⚠️ tmux server pid ${plan.pid} still unreachable after USR1 (${after.why}); launcher stops and won't create a new one.`,
    ));
  }

  /** 同一 key 在 windowMs 内只做一次 */
  private once(key: string, windowMs: number, fn: () => void): void {
    const last = this.said.get(key);
    if (last !== undefined && this.p.now() - last < windowMs) return;
    this.said.set(key, this.p.now());
    fn();
  }

  private async alertOnce(key: string, text: string): Promise<void> {
    let due = false;
    this.once(key, HOUR_MS, () => { due = true; });
    if (due) await this.alert(text);
  }

  private async alert(text: string): Promise<void> {
    this.p.log(text);
    await this.p.alert(text).catch((e) => this.p.log(`告警发送失败（已记在上一行日志）：${(e as Error).message}`));
  }
}

/** 恢复键按本仓所属项目读；读不了 / 不认识的档位 = off（不发信号也不新建，只告警，最保守） */
async function liveHealMode(): Promise<SockHealMode> {
  try {
    const project = resolveProjectForDir((await readProjects()).projects, REPO_ROOT)?.id;
    if (!project) return "observe";
    const p = recoveryPolicy(project, SOCK_HEAL_KEY);
    return p.source !== "error" && (p.mode === "on" || p.mode === "observe" || p.mode === "off") ? p.mode : "off";
  } catch {
    return "off"; // projects.json / 策略文件读坏：按 off，只告警不发信号
  }
}

const LIVE_GUARD_PORTS: SockGuardPorts = {
  probe: () => masterSessionProbe(),
  servers: async () => {
    try { return sameSockServers(await LIVE_PROBE_PORTS.ps(), LIVE_PROBE_PORTS.sockPath); } catch { return null; /* 调用方把 null 当「查不了」，不新建 */ }
  },
  inode: () => {
    try { return LIVE_PROBE_PORTS.stat(LIVE_PROBE_PORTS.sockPath).ino; } catch { return null; /* 套接字不在 / 读不了：调用方当「核不上」，回到冻结规则 */ }
  },
  healMode: liveHealMode,
  usr1: (pid) => process.kill(pid, "SIGUSR1"),
  activeCount: async () => (await readActiveAgents()).length,
  busy: (w, key) => busyAgentWindows(w, key),
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
  log: (msg) => console.log(msg),
  alert: (text) => notify({ source: "launcher", chatId: process.env.CONTROL_CHANNEL_ID || "", text }).then(() => {}),
};

export const sockGuard = new LauncherSockGuard(LIVE_GUARD_PORTS);
