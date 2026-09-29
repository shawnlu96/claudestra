/**
 * v2.9+ registry.json 的唯一读取器 —— 收敛此前散在多个文件里的各自 JSON.parse
 * （bg-activity-watcher / stats-dashboard / cli-install / sessions-inventory 各有
 * 一份，字段容错还不一致：cwd||dir 兼容有的做有的没做）。
 *
 * 写路径不在这里：registry 的 owner 是 manager.ts（create/kill/restart 的 CRUD），
 * bridge 侧一律只读。
 */

import { statePath } from "./paths.js";
import { readJsonLenient, readJsonStateSync, reportCorrupt } from "./state-file.js";

export const REGISTRY_PATH = statePath("registry.json");

/** v2.23+ agent 运行时。缺失/未知一律当 `claude-code`——宁可走老路，不猜新路 */
export type AgentRuntime = "claude-code" | "pi" | "codex";

/** 从 agent 记录判定运行时（registry 字段缺失 = 历史 agent = Claude Code） */
/**
 * 这个名字指的是不是大总管。
 *
 * ⚠ 两种写法都得认：registry 的**键**是 `agent-master`，而它的 tmux 窗口名（launcher
 * 显式定名为 MASTER_WINDOW_NAME；老窗口由 launcher 迁移）和各处 CLI 参数用的是裸 `master`。只认一种，就会出现「同一个东西在两处对不上」
 * 的分叉——`principals.ts` 的 R1 guard 早就踩过（只认 `master` 时 `*` token 能经
 * `agent-master` 绕过 master 排除），`manager.ts list` 这次踩的是另一头。
 */
export function isMasterAgent(name: string | undefined | null): boolean {
  return isMasterName(name);
}

/**
 * master 的唯一判定：规范形式（canonicalAgentName）再去掉所有空白 → 去掉所有层 agent- 前缀 → master，网页的会话名 __master__ 也算。
 * 请求里的名字会落到不区分大小写的文件系统（APFS：Master 的归档目录就是 master 的）、会被 manager 转小写，
 * 全角写法经 NFKC 也会变回来——判定只要有一处比路由解析「窄」，"*" 就能从那个缺口碰到 master（tests/api-master-scope.test.ts）。
 * 只能放宽不能收窄：放宽只会多挡；唯一靠它放行的 devices.intersectAgents 另要逐字写法（tests/guest-pairing.test.ts）。
 */
export function isMasterName(name: string | undefined | null): boolean {
  if (!name) return false;
  const n = canonicalAgentName(name).replace(/\s/gu, "").replace(/^(agent-)+/, "");
  return n === "master" || n === "__master__";
}

/**
 * agent 名的规范形式：NFKC（全角 → 半角）、去掉零宽等不可见字符（INVISIBLE_NAME_RE 那一套）、去首尾空白、转小写。scope 比对
 * （principals.agentInScope）与 guest 开放名校验（devices.checkGuestAgents）都按它——否则大小写不敏感的文件系统上，各接口认到的范围会不一致。
 */
export function canonicalAgentName(name: string): string {
  return name.normalize("NFKC").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu, "").trim().toLowerCase();
}

/** 去掉一层 agent- 前缀的规范名：scope 比对（principals.agentInScope）与撞名检查（canonicalTwinError）共用 */
export const bareCanonicalName = (name: string): string => canonicalAgentName(name).replace(/^agent-/, "");

/**
 * 名单里「给出大总管」只认的两种逐字写法。isMasterName 是拒绝侧（宽），放行侧（devices.intersectAgents、principals.agentInScope）
 * 只认这个：老版本把 MASTER、全角等变体当普通名字落了盘，按宽判定认成大总管就把一条无害的旧数据升成大总管权限（T42-r2）。
 */
export const isLiteralMaster = (entry: string): boolean => entry === "master" || entry === "agent-master";

/**
 * 新名字跟已有 agent 规范化后同名（cc 与全角 ｃｃ）：scope 与 guest 授权按规范名比，两个 agent 会共用授权，新建 / resume / 改名都拒。
 * 名字本身已在 registry（重建、resume 已有的）不算撞。返回报错文案，没撞为 null。
 */
export function canonicalTwinError(name: string, existing: string[]): string | null {
  if (existing.includes(name)) return null;
  const want = bareCanonicalName(name);
  const twin = existing.find((n) => bareCanonicalName(n) === want);
  return twin ? `${name} 跟已有的 ${twin} 只差大小写 / 全角 / 不可见字符，授权会按同一个名字算，换个名字` : null;
}

/**
 * agent 名里不许出现的字符（manager 新建 / resume / 改名与台账的负责人校验共用这一份）：空白、shell 元字符、控制字符，
 * 以及 `/` `\` `:` `~`——agent 名会拼进归档目录、截图文件路径，带分隔符就能写到预期之外的位置；
 * `.`——tmux 在目标串里按 `.` 切 pane，带点的窗口按名字永远找不到（tests/resumable-ops.test.ts）；
 * 不可见字符（INVISIBLE_NAME_RE）让两个看起来一样的名字成了两个人。CJK 等 Unicode 字母允许。
 */
export const AGENT_NAME_BLOCKLIST_RE = /[\s"'`$;&|<>()*?{}\\/:~.\x00-\x1f\x7f\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/u;
/**
 * 不可见字符：\p{Cf}（零宽、方向控制）只是一部分，变体选择符 FE0F（Mn）、韩文填充符 U+3164（Lo）、CGJ 等在
 * Default_Ignorable_Code_Point 里，盲文空格 U+2800 两边都不在、单列。带 FE0F 的 emoji 名字因此被拒（PM 09-29 定，可接受）。
 * 只管新建 / resume / 改名与台账写入；kill / restart 走宽松归一，老名字照旧能操作。
 */
const INVISIBLE_NAME_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/u;

/** 名字里第一个不可见字符的报错（写出 U+XXXX，终端里看不出哪儿不对）；没有为 null */
export function invisibleNameError(name: string): string | null {
  const ch = INVISIBLE_NAME_RE.exec(name)?.[0];
  if (ch === undefined) return null;
  const code = `U+${(ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}`;
  return `名字不能含不可见字符（零宽连接符等），这里有 ${code}，请换一个名字（emoji 后面常带不可见的变体选择符 U+FE0F，去掉再试）`;
}

/**
 * 保留给身份的名字：台账（lib/ledger-stages.ts roleOf）把 actor "owner" / "master" 直接当角色。
 * registry 键带 agent- 前缀，推导出的 actor 本不会撞上，但 agent-master 在别处（isMasterAgent）已被当成大总管——
 * 新建 / resume / 改名一律不许用这两个名字（manager/core.ts assertValidNewName），doctor 对已有的 agent-owner 报警。
 */
export function isReservedAgentName(name: string): boolean {
  const bare = name.trim().toLowerCase().replace(/^agent-/, "");
  return bare === "owner" || bare === "master";
}

export function agentRuntime(info: { runtime?: string } | undefined | null): AgentRuntime {
  const r = info?.runtime;
  return r === "pi" || r === "codex" ? r : "claude-code";
}

export interface RegistryAgent {
  /** tmux 名（registry key，"agent-xxx"） */
  name: string;
  status?: string;
  channelId?: string;
  sessionId?: string;
  /** 归一后的工作目录（历史数据 cwd / dir 两种字段名都存在过） */
  cwd?: string;
  purpose?: string;
  displayName?: string;
  /** owner 2026-09-27「显示名」：用户给会话起的别名，默认空；web 侧栏 / 顶栏显示「显示名 | name」 */
  label?: string;
  model?: string;
  effort?: string;
  /** create --external 标记：可安全暴露给 API token / peer（R1 守卫） */
  external?: boolean;
  /** v2.21+ 归属 project 的 id(projects.json)。⚠ 与遗留的 project 字段无关——那存的是原始 dir */
  projectId?: string;
  /** v2.23+ 运行时（"pi" / "codex" / "claude-code"）。缺失 = 老 agent = claude-code */
  runtime?: string;
  /** v2.23+ Pi 能力档案（Pi agent 专用）：带哪些扩展/技能/工具/MCP。缺失 = 继承全局 */
  piEnv?: Record<string, unknown>;
  /** 派发者的 registry 键（`agent-xxx` 或 `master`）：侧栏把它挂在派发者下面（manager/team.ts 写入）。展示用，不参与授权 */
  parent?: string;
  /** 任务短名（≤40 字），侧栏执行者那行的小标 */
  task?: string;
}

/** registry.json 的内容 → 规范化后的 agent 列表（纯函数；结构不对返回空数组） */
export function normalizeRegistryAgents(data: unknown): RegistryAgent[] {
  const agents = (data as { agents?: unknown } | null)?.agents;
  if (!agents || typeof agents !== "object") return [];
  try {
    return normalizeEntries(agents as Record<string, unknown>);
  } catch {
    return []; // 条目是 null 之类的脏数据：与原先「解析抛错 → 空数组」一致，不把 bridge 搞崩
  }
}

function normalizeEntries(agents: Record<string, unknown>): RegistryAgent[] {
  return Object.entries(agents).map(([name, v]) => {
    const a = v as Record<string, unknown>;
    const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
    return {
      name,
      status: str("status"),
      channelId: str("channelId"),
      sessionId: str("sessionId"),
      cwd: str("cwd") ?? str("dir"),
      purpose: str("purpose"),
      displayName: str("displayName"),
      label: str("label"),
      model: str("model"),
      effort: str("effort"),
      // ⚠ 布尔字段不走 str() 帮手——external 曾因此被整个丢掉(所有 agent 在
      // /peers 界面显示非 external,Codex review 2026-08-26 抓到的)
      external: a.external === true,
      projectId: str("projectId"),
      // ⚠ 同样是白名单式读取：registry 里写了 runtime 但这里漏读 = 静默丢失，
      // 下游会把 Pi agent 当 Claude Code 起（读成 undefined 不报错，这坑踩过一次）
      runtime: str("runtime"),
      // 嵌套对象：不是对象就当没有（脏数据不能把 bridge 搞崩）
      piEnv: a.piEnv && typeof a.piEnv === "object" ? (a.piEnv as Record<string, unknown>) : undefined,
      parent: str("parent"),
      task: str("task"),
    };
  });
}

/**
 * 全量读取（含非 active）。永不抛：文件缺失 → 空数组；文件损坏 → stderr 报一次（按 mtime
 * 去重），沿用本进程上次成功读到的内容（没有就空数组）——以前损坏被静默当成「没有 agent」。
 */
export async function readRegistryAgents(registryPath = REGISTRY_PATH): Promise<RegistryAgent[]> {
  // saveRegistry（manager/core.ts）是不设防的原子写：损坏时的日志不能说「写者拒绝覆盖」
  return normalizeRegistryAgents(await readJsonLenient<unknown>(registryPath, null, { who: "registry", writersGuarded: false }));
}

// 同步读者的「上次成功值」（async 版的缓存在 state-file 里，二者互不影响）
const lastGoodSync = new Map<string, unknown>();

/** 同步版（bridge 里不方便 await 的地方用；语义同 readRegistryAgents） */
export function readRegistryAgentsSync(registryPath = REGISTRY_PATH): RegistryAgent[] {
  const r = readJsonStateSync(registryPath);
  if (r.status === "ok") {
    lastGoodSync.set(registryPath, r.data);
    return normalizeRegistryAgents(r.data);
  }
  if (r.status === "missing") return [];
  reportCorrupt(registryPath, r.error, "registry", false);
  return normalizeRegistryAgents(lastGoodSync.get(registryPath) ?? null);
}

/** active 状态的 agent（bridge 侧最常用的形态） */
export async function readActiveAgents(registryPath = REGISTRY_PATH): Promise<RegistryAgent[]> {
  return (await readRegistryAgents(registryPath)).filter((a) => a.status === "active");
}
