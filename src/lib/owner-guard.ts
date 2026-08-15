/**
 * v2.19.0 认主守卫 —— 结构性地杜绝「双响」（两个实例同时当主）。
 *
 * 通用前提：`~/.claude-orchestrator/` 是这套系统的**权威状态目录**（registry
 * 里是 agent 名、cwd、sessionId 和 Discord channelId）。只要它被整体复制到另一
 * 台机器——备份还原、机器迁移、dotfiles 同步、灾备热备——那台机器上的守护进程
 * 一旦自启，就会拿着**别人的** registry 当权威：往别人的频道发通知、照着别人的
 * agent 清单拉起一整队重复会话、和原机抢同一批 Discord 链路。谁都不知道消息被
 * 处理了两遍。
 *
 * 2026-08-15 实锤（本仓库 owner 的部署）：一台作为热备的 MacBook 每 6 小时
 * rsync 一次主机的状态目录；它某次开机后 launchd 自动拉起三件套，于是
 *   - wedge-watcher 对着本地不存在的窗口，往**主机的**频道播报虚假掉线，
 *     每小时一条，连发 8 条；
 *   - launcher 照着同步来的 registry「恢复 dead agent」，拉起 14 个重复会话。
 * 而那套灾备脚本第一步恰恰就是「防双响检查」——但它只拦手动接管这条路，
 * 开机自启从后门绕了过去。
 *
 * 结论：防线不能建立在「外部编排（launchd / systemd / 人）永远不出错」这个
 * 前提上，得让**代码自己认主**：
 *
 *   `~/.claude-orchestrator/owner.json` 记着主实例的 UUID + hostname。
 *   - 文件不存在 → 本机就是主，写下标记，照常启动（全新安装无感）；
 *   - 标记匹配本机 → 照常启动；
 *   - 不匹配 → **拒绝启动**，打印为什么、以及怎么合法接管。
 *
 * 合法接管：`CLAUDESTRA_TAKEOVER=1`。它会把标记改写成本机，从此本机是主 ——
 * 与「先把老主停掉」这个人工步骤配合使用（灾备脚本、迁移流程各自在外部实现，
 * 本模块只负责认主这一件事，不关心你的接管流程长什么样）。
 *
 * 为什么同时记 UUID 和 hostname：只认 hostname 的话，主机自己改个名（macOS 跟
 * DHCP 走的场景很常见）就会把自己锁在门外，那是比双响更糟的故障。UUID 稳定，
 * 两者任一匹配即放行；两者都不匹配才是「另一台机器」。
 */

import { hostname } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const DIR = join(process.env.HOME || "~", ".claude-orchestrator");
const MARKER = join(DIR, "owner.json");

export interface OwnerMarker {
  uuid: string;
  host: string;
  /** 写入时间，纯人类可读用途 */
  at: string;
}

/** 机器稳定标识：macOS 取 IOPlatformUUID，Linux 取 /etc/machine-id，取不到留空 */
export function machineUuid(): string {
  try {
    if (process.platform === "darwin") {
      const out = Bun.spawnSync(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]).stdout.toString();
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return m?.[1] ?? "";
    }
    if (existsSync("/etc/machine-id")) return readFileSync("/etc/machine-id", "utf8").trim();
  } catch {
    /* 取不到就只靠 hostname */
  }
  return "";
}

export function readOwnerMarker(): OwnerMarker | null {
  try {
    const m = JSON.parse(readFileSync(MARKER, "utf8")) as OwnerMarker;
    return typeof m?.host === "string" ? m : null;
  } catch {
    return null;
  }
}

export function writeOwnerMarker(): OwnerMarker {
  const m: OwnerMarker = { uuid: machineUuid(), host: hostname(), at: new Date().toISOString() };
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(MARKER, JSON.stringify(m, null, 2) + "\n");
  } catch {
    /* 写不进去不阻塞启动——守卫是加固，不是硬依赖 */
  }
  return m;
}

export type OwnerVerdict =
  | { ok: true; reason: "first-run" | "match" | "takeover" }
  | { ok: false; reason: "foreign"; owner: OwnerMarker };

/** 纯判定（可单测）：给定标记与本机身份，能不能以「主」的身份启动 */
export function ownerVerdict(
  marker: OwnerMarker | null,
  self: { uuid: string; host: string },
  takeover: boolean,
): OwnerVerdict {
  if (!marker) return { ok: true, reason: "first-run" };
  // UUID 优先；主机改名不该把自己锁在门外
  if (marker.uuid && self.uuid && marker.uuid === self.uuid) return { ok: true, reason: "match" };
  if (!marker.uuid && marker.host === self.host) return { ok: true, reason: "match" };
  if (marker.uuid && self.uuid && marker.uuid !== self.uuid) {
    return takeover ? { ok: true, reason: "takeover" } : { ok: false, reason: "foreign", owner: marker };
  }
  // UUID 缺失（老标记 / 取不到）→ 退回 hostname 比对
  if (marker.host === self.host) return { ok: true, reason: "match" };
  return takeover ? { ok: true, reason: "takeover" } : { ok: false, reason: "foreign", owner: marker };
}

/**
 * daemon 入口调用：不是主就**不要启动**。
 *
 * 不匹配时不是立刻 exit —— 三个 plist 都是 `KeepAlive=true, ThrottleInterval=10`，
 * 秒退会变成每 10 秒刷一屏日志。先睡 5 分钟再退，把噪音压到每小时 12 行，
 * 同时留出「人改了标记 / 加了 TAKEOVER 后下一次重启即生效」的窗口。
 */
export async function assertPrimaryOrExit(daemon: string): Promise<void> {
  const self = { uuid: machineUuid(), host: hostname() };
  const takeover = process.env.CLAUDESTRA_TAKEOVER === "1";
  const v = ownerVerdict(readOwnerMarker(), self, takeover);

  if (v.ok) {
    if (v.reason === "first-run") {
      const m = writeOwnerMarker();
      console.log(`🔐 [${daemon}] 首次运行，本机登记为主：${m.host} (${m.uuid.slice(0, 8) || "no-uuid"})`);
    } else if (v.reason === "takeover") {
      const m = writeOwnerMarker();
      console.log(`🔐 [${daemon}] CLAUDESTRA_TAKEOVER=1 —— 已把主机标记改写为本机：${m.host}`);
    }
    return;
  }

  console.error(
    `🔒 [${daemon}] 拒绝启动：本机不是这套 Claudestra 的主机。\n` +
      `   标记里的主机: ${v.owner.host} (uuid ${v.owner.uuid.slice(0, 8) || "-"}, 写于 ${v.owner.at})\n` +
      `   本机:         ${self.host} (uuid ${self.uuid.slice(0, 8) || "-"})\n` +
      `   多半是热备机器上的 launchd 自启撞上了 rsync 过来的配置（registry / channelId 都是主机的）,\n` +
      `   照常启动会造成「双响」：重复拉起 agent、往主机的频道发假告警、抢同一批 Discord 链路。\n` +
      `   要在本机正式接管：先确认主机已停，再带 CLAUDESTRA_TAKEOVER=1 启动（failover.sh 已带）。`,
  );
  await Bun.sleep(5 * 60_000);
  process.exit(0);
}
