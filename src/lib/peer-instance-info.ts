/**
 * PEERINFO1：已配对 peer 互相看得到对方的版本、当前提交、更新通道和三个协作开关的档位。
 * 写方：bridge/agents-list-route.ts 只在调用方是 peer 凭据时调 peerInstanceBlock，回包里多一个 `instance`；
 * 读方：lib/peer-presence.ts 的 probeResultOf 用 parseInstanceInfo 解析，记进 peer-presence.json。
 *
 * 字段是固定白名单（buildInstanceInfo 只从各取值函数取这几项，取到的值再逐项校验）：
 * version（package.json）、commit（本机仓库 HEAD，40 位，读不到 null）、channel（自动更新通道，读不到 null）、
 * switches（只 lendUiUpload / lendUsageReport / centerReplicaPull，各取本机档位，读不到就不放这个键）。
 * 不放路径、主机名、用户名、agent 名单、配置原文。
 *
 * 开关是恢复键 peerInstanceInfo（缺省 observe），只管本方回包带不带：off 不带；observe 不带，被探测时记一行「本会带出的字段名」
 * （只记键名，10 分钟最多一行）；on 真带。读方解析不受开关影响。tests/peer-instance-info*.test.ts。
 */
import { readFileSync } from "node:fs";
import { isConfigCorrupt, readConfigSync } from "./config-store.js";
import { explicitLendKeyMode } from "./lend-key-mode.js";
import { PROJECTS_PATH, resolveProjectForRealDir, type ProjectDef } from "./projects.js";
import { isRecoveryMode, readRecoveryFile, recoveryPolicy, RECOVERY_POLICY_PATH, type RecoveryMode } from "./recovery-policy.js";
import { REPO_ROOT } from "./repo-root.js";

const INSTANCE_SWITCH_KEYS = ["lendUiUpload", "lendUsageReport", "centerReplicaPull"] as const;
type InstanceSwitchKey = (typeof INSTANCE_SWITCH_KEYS)[number];

export interface PeerInstanceInfo {
  version: string | null;
  commit: string | null;
  channel: string | null;
  switches: Partial<Record<InstanceSwitchKey, RecoveryMode>>;
}

/** 各字段的取值来源（生产用本机读法；单测注入）。返回什么都只当候选值，过了校验才进 instance */
export interface InstanceSources {
  version: () => unknown;
  commit: () => unknown;
  channel: () => unknown;
  /** 读不到返回 undefined（或抛）：这个键就不放 */
  switchMode: (key: InstanceSwitchKey) => unknown;
}

const COMMIT_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;
const CHANNEL_RE = /^[a-z]{1,16}$/;

const pick = (f: () => unknown, ok: (v: unknown) => boolean): unknown => {
  try { const v = f(); return ok(v) ? v : null; } catch { return null; }
};
const isVersion = (v: unknown) => typeof v === "string" && VERSION_RE.test(v);
const isCommit = (v: unknown) => typeof v === "string" && COMMIT_RE.test(v);
const isChannel = (v: unknown) => typeof v === "string" && CHANNEL_RE.test(v);

/** 只从白名单取值：取值函数带出的多余东西（路径、主机名、对象原文）过不了逐项校验，一律不出去 */
export function buildInstanceInfo(src: InstanceSources): PeerInstanceInfo {
  const switches: PeerInstanceInfo["switches"] = {};
  for (const k of INSTANCE_SWITCH_KEYS) {
    const m = pick(() => src.switchMode(k), isRecoveryMode);
    if (m !== null) switches[k] = m as RecoveryMode;
  }
  return {
    version: pick(src.version, isVersion) as string | null,
    commit: pick(src.commit, isCommit) as string | null,
    channel: pick(src.channel, isChannel) as string | null,
    switches,
  };
}

/** 读方：对方回包里的 instance → 只留白名单字段；形状不对返回 null（整块丢）。switches 里不认识的键忽略（对方更新了的余地） */
export function parseInstanceInfo(raw: unknown): PeerInstanceInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const nullOr = (v: unknown, ok: (v: unknown) => boolean) => v === null || ok(v);
  if (!nullOr(r.version, isVersion) || !nullOr(r.commit, isCommit) || !nullOr(r.channel, isChannel)) return null;
  const sw = r.switches;
  if (!sw || typeof sw !== "object" || Array.isArray(sw)) return null;
  const switches: PeerInstanceInfo["switches"] = {};
  for (const k of INSTANCE_SWITCH_KEYS) {
    if (!Object.hasOwn(sw, k)) continue;
    const m = (sw as Record<string, unknown>)[k];
    if (!isRecoveryMode(m)) return null;
    switches[k] = m;
  }
  return { version: r.version as string | null, commit: r.commit as string | null, channel: r.channel as string | null, switches };
}

/** instance 里会出现的字段名（observe 日志用：只有键名，不带值） */
function instanceFieldNames(info: PeerInstanceInfo): string[] {
  return ["version", "commit", "channel", ...Object.keys(info.switches).map((k) => `switches.${k}`)];
}

// ── 本机读法 ──

/** 本机 claudestra 仓库（REPO_ROOT）所属项目；解析不出 = null */
function localProjectId(): string | null {
  try {
    const projects = (JSON.parse(readFileSync(PROJECTS_PATH, "utf8")) as { projects?: ProjectDef[] }).projects;
    return Array.isArray(projects) ? resolveProjectForRealDir(projects, REPO_ROOT)?.id ?? null : null;
  } catch { return null; }
}

/** 本机档位：项目解析不出 / 恢复策略坏 = 读不到（不放这个键）；两个出借外发键沿用它们自己的「只认显式值」读法 */
function localSwitchMode(key: InstanceSwitchKey): RecoveryMode | undefined {
  const project = localProjectId();
  if (!project) return undefined;
  const p = recoveryPolicy(project, key);
  if (p.source === "error") return undefined;
  return key === "centerReplicaPull" ? p.mode : explicitLendKeyMode(key);
}

function localVersion(): unknown {
  return (JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, "utf8")) as { version?: unknown }).version;
}

function localCommit(): string | null {
  const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "ignore", timeout: 5_000 });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

function localChannel(): string | null {
  return isConfigCorrupt() ? null : (readConfigSync().autoUpdate.channel ?? "release");
}

const LOCAL_SOURCES: InstanceSources = { version: localVersion, commit: localCommit, channel: localChannel, switchMode: localSwitchMode };
const INFO_CACHE_MS = 30_000;
let cache: { at: number; info: PeerInstanceInfo } | null = null;

/** 本机 instance（每个 peer 每分钟探一次，短缓存省掉重复的 git 子进程） */
function localInstanceInfo(now = Date.now()): PeerInstanceInfo {
  if (!cache || now - cache.at > INFO_CACHE_MS) cache = { at: now, info: buildInstanceInfo(LOCAL_SOURCES) };
  return cache.info;
}

/**
 * 恢复键 peerInstanceInfo 的本机档位：只认本机仓库所属项目 keys.peerInstanceInfo 的显式值，没设 / 项目解析不出 = 缺省 observe
 * （项目整体 mode 是 on 也不跟着带出去，切 on 由 PM / owner 单独定）；恢复策略文件坏 = off（往外发的东西，读不准就不发）。
 */
export function peerInstanceInfoMode(policyPath = RECOVERY_POLICY_PATH): RecoveryMode {
  const f = readRecoveryFile(policyPath);
  if (f.status === "corrupt") return "off";
  const project = localProjectId();
  if (!project || f.status !== "ok" || !Object.hasOwn(f.data.projects, project)) return "observe";
  const m = f.data.projects[project].keys?.peerInstanceInfo;
  return isRecoveryMode(m) ? m : "observe";
}

// ── 写方：回包带不带 ──

export const OBSERVE_LOG_EVERY_MS = 10 * 60_000;

export interface InstanceBlockDeps {
  mode?: () => RecoveryMode;
  info?: () => PeerInstanceInfo;
  log?: (line: string) => void;
  now?: () => number;
}

let lastObserveLogAt = -Infinity;
/** 单测用：清掉 observe 日志的限频记录 */
export function resetInstanceObserveLog(): void { lastObserveLogAt = -Infinity; }

/** peer 回包里的 instance：on 才返回；observe 只记一行键名（10 分钟最多一行）；off / 出错 = undefined，回包与改前逐字相同 */
export function peerInstanceBlock(peer: string, d: InstanceBlockDeps = {}): PeerInstanceInfo | undefined {
  try {
    const mode = (d.mode ?? peerInstanceInfoMode)();
    if (mode === "off") return undefined;
    const info = (d.info ?? localInstanceInfo)();
    if (mode === "on") return info;
    const now = (d.now ?? Date.now)();
    if (now - lastObserveLogAt < OBSERVE_LOG_EVERY_MS) return undefined;
    lastObserveLogAt = now;
    (d.log ?? console.log)(`🪪 [peerInstanceInfo=observe] peer ${peer} 探测本会带出的字段名：${instanceFieldNames(info).join(", ")}（没带）`);
    return undefined;
  } catch (e) {
    console.warn(`⚠️ [peerInstanceInfo] 组装失败，本次不带: ${e instanceof Error ? e.name : "Error"}`);
    return undefined;
  }
}
