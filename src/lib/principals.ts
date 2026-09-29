/**
 * v2.6.0+ 多前端身份与授权（设计 docs/design-multi-frontend.md §3.4）。
 *
 * principal = transport-scoped 身份：
 *   discord:<userId>   owner / Discord 用户（现阶段 Discord 主链路鉴权仍走
 *                      ALLOWED_USER_IDS，这里只登记，便于未来统一）
 *   token:<tokenId>    HTTP API 用户（Phase B 的主角）
 *   telegram:<userId>  future
 *
 * 授权模型：
 *   - agents 白名单："*" = 全部普通 agent；master 必须显式列名
 *   - role: "owner" 才有管理能力（v1 管理面不进 API，字段先留位）
 *   - token 的 secret 只在创建时返回一次完整值
 *
 * ⚠️ 共享上下文风险（R1）：token scope 只控制"能不能跟 agent 说话"，管不了
 * agent 上下文里已有什么。CLI 会对未标 external 的 agent 要求 --force。
 */

import { acquireLock } from "./file-lock.js";
import { STATE_DIR } from "./paths.js";
import { bareCanonicalName, isLiteralMaster, isMasterAgent } from "./registry.js";
import { canReadLedger, OWNER_PRINCIPAL_ID } from "./devices.js";
import { timingSafeEqual } from "crypto";
import { readJsonState, readJsonLenient, writeJsonStateGuarded, StateCorruptError } from "./state-file.js";
import { join } from "path";
import { randomBytes } from "crypto";

export interface Principal {
  /** 统一形态："token:tok_xxx" / "discord:<uid>" / "telegram:<uid>" */
  id: string;
  /** owner = 全能力；external = 只有会话权（默认） */
  role: "owner" | "external";
  /** 人类可读名（token 必填，进 agent 看到的 header） */
  name?: string;
  /** agent 白名单。"*" = 全部普通 agent（不含 master，master 需显式） */
  agents: string[];
  /** 仅 token: 类有。Bearer 鉴权用的 secret（hex）。 */
  secret?: string;
  disabled?: boolean;
  createdAt: string;
  /** R2 审计镜像开关（默认 true = API 对话镜像到 agent 的 Discord 频道） */
  mirror?: boolean;
  /**
   * 远程终端授予（B2）。终端把原始按键注入 agent 的 tmux，可 Ctrl-C 逃出 CC TUI
   * 落到宿主 shell、绕过 `--disallowedTools`——能力等级 == 宿主 shell 访问，严格
   * 强于 messaging。因此独立开关、默认关：external token 需 `token-add --terminal`
   * 显式授予，不让一个只读/messaging token 静默拿到 shell。owner 默认允许。
   */
  terminal?: boolean;
  /**
   * v2.11+ HTTP peer 标记：此 token 是签给哪个 peer 实例的（peers.json httpPeers
   * 的 name）。入站注入头据此渲染成「peer 跨机请求」而非「Web 端用户」。
   */
  peer?: string;
  /** 设备凭据（lib/devices.ts）：owner:self / guest:* 这类 principal 靠它们鉴权，没有 secret */
  credentials?: import("./devices.js").DeviceCredential[];
  /** 只出现在请求内生效的视图上（effectivePrincipal）：false = 这条凭据不许碰管理端点 */
  manage?: boolean;
  /** 只出现在请求内生效的视图上：这次请求是哪条凭据 */
  credential?: string;
}

export interface PrincipalsFile {
  principals: Principal[];
}

const CONFIG_DIR = STATE_DIR;
export const PRINCIPALS_PATH = join(CONFIG_DIR, "principals.json");

const isPrincipalsFile = (d: unknown): boolean =>
  !!d && typeof d === "object" && Array.isArray((d as PrincipalsFile).principals);

/**
 * 读者用：永不抛。运行中被写坏 → 沿用上次成功读到的值；冷启动就坏 → 按空（鉴权
 * fail-closed）。都会响亮地报一次；写者不会拿这个结果去覆盖——writePrincipals 会先
 * 确认磁盘上的文件不是坏的。
 */
export async function readPrincipals(path = PRINCIPALS_PATH): Promise<PrincipalsFile> {
  const file = await readJsonLenient<PrincipalsFile>(path, { principals: [] }, { validate: isPrincipalsFile, who: "principals" });
  warnMasterVariants(file);
  return file;
}

/** 已报过的「principal + 写法」：每个进程只报一次，别让每次鉴权都刷一行 */
const warnedVariants = new Set<string>();

/**
 * 名单（principal 的 agents 与各凭据的 grant）里的大总管变体：老版本签码时把 MASTER、全角等当普通名字落了盘，现在不给任何权限。
 * 只告警、不改盘（principals.json 由 owner 处置），写明是哪个 principal（T42-r2）。
 */
export function warnMasterVariants(file: PrincipalsFile, warn: (msg: string) => void = console.warn): void {
  for (const p of file.principals) {
    for (const a of new Set([...(p.agents ?? []), ...(p.credentials ?? []).flatMap((c) => c.grant?.agents ?? [])])) {
      if (!isMasterAgent(a) || isLiteralMaster(a) || warnedVariants.has(`${p.id}\0${a}`)) continue;
      warnedVariants.add(`${p.id}\0${a}`);
      warn(`⚠️ [principals] ${p.id}（${p.name}）的名单里有大总管的变体写法 ${JSON.stringify(a)}：不给任何权限，按无效条目处理；要开放大总管请写逐字的 master`);
    }
  }
}

/** 写者用：损坏时抛 StateCorruptError，而不是返回空。 */
export async function readPrincipalsStrict(path = PRINCIPALS_PATH): Promise<PrincipalsFile> {
  const r = await readJsonState(path, isPrincipalsFile);
  if (r.status === "ok") return r.data as PrincipalsFile;
  if (r.status === "missing") return { principals: [] };
  throw new StateCorruptError(path, r.error);
}

/** principals.json 的跨进程写锁（lib/file-lock.ts 的目录锁）；manager 写 principals 的命令整条持有（manager.ts） */
export const principalsLockPath = (path = PRINCIPALS_PATH): string => `${path}.lock`;

/**
 * principals.json 的读改写统一入口：锁内 strict 读 → mutate → changed 才写。bridge 的设备凭据续期 / 配对 / 撤销都走这里——
 * 各自「读 → await → 写」时，续期拿着撤销前的旧副本晚一步写回，会把刚撤销的凭据复活（codex 复核）。
 * 锁是 advisory：拿不到时 onBusy="skip" 直接返回 null（续期这种可有可无的写），默认 "proceed" 降级照写并告警。
 */
export async function updatePrincipals<T>(
  mutate: (file: PrincipalsFile) => { changed: boolean; result: T },
  opts: { path?: string; waitMs?: number; onBusy?: "proceed" | "skip" } = {},
): Promise<T | null> {
  const path = opts.path ?? PRINCIPALS_PATH;
  const lock = await acquireLock(principalsLockPath(path), opts.waitMs ?? 5_000);
  if (!lock && opts.onBusy === "skip") return null;
  if (!lock) console.warn("⚠️ principals.json 写锁未拿到，降级继续（可能与并发写者互相覆盖）");
  try {
    const file = await readPrincipalsStrict(path);
    const { changed, result } = mutate(file);
    if (changed) await writePrincipals(file, path);
    return result;
  } finally {
    lock?.release();
  }
}

export async function writePrincipals(data: PrincipalsFile, path = PRINCIPALS_PATH): Promise<void> {
  // 整份 API/peer token 的明文：0600 在 open(2) 时就生效；tmp+rename 原子写——
  // 原地覆写的半写状态会被别的进程读成「损坏」（peers.json 踩过同一个坑）；
  // 磁盘上已是坏文件就拒写并备份，绝不拿「读成空」的结果去覆盖。
  await writeJsonStateGuarded(path, data, { mode: 0o600, validate: isPrincipalsFile });
}

/** 老 Next 前端替 owner 持有的 token 名：isOwnerPrincipal 凭它认 owner，所以新签的凭据（token、guest）一律不许再叫这个 */
const LEGACY_OWNER_TOKEN_NAME = "web-ui";

/** 名字撞上保留名 → 给人看的拒绝原因，否则 null。大小写、首尾空白都不算区别 */
export function reservedNameError(name: string): string | null {
  if (name.trim().toLowerCase() !== LEGACY_OWNER_TOKEN_NAME) return null;
  return `"${LEGACY_OWNER_TOKEN_NAME}" 是保留名（老 web 前端的 owner 凭据靠这个名字认 owner 身份），请换一个名字`;
}

/** 生成一个新 token principal（不落盘，调用方决定何时 write）。保留名直接抛：签发路径漏查也签不出冒认 owner 的 token */
export function newTokenPrincipal(
  name: string,
  agents: string[],
  opts?: { terminal?: boolean; peer?: string },
): Principal {
  const reserved = reservedNameError(name);
  if (reserved) throw new Error(reserved);
  const tokenId = `tok_${randomBytes(4).toString("hex")}`;
  return {
    id: `token:${tokenId}`,
    role: "external",
    name,
    agents,
    secret: randomBytes(32).toString("hex"),
    disabled: false,
    createdAt: new Date().toISOString(),
    mirror: true,
    ...(opts?.terminal ? { terminal: true } : {}),
    ...(opts?.peer ? { peer: opts.peer } : {}),
  };
}

/** token principal 的短 id（"token:tok_xxx" → "tok_xxx"） */
export function tokenIdOf(p: Principal): string {
  return p.id.startsWith("token:") ? p.id.slice(6) : p.id;
}

/**
 * 常数时间比较两个 secret。
 * 256 位随机 token 用朴素 === 比较在实践中很难被计时攻击撬开，但这里是**唯一**的
 * 鉴权判据、又是纯粹的一行改动，没有理由留着不一致（web 侧的 api-auth 早就用了
 * timingSafeEqual）。长度不同直接返回 false —— 长度本身不是秘密。
 */
function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Bearer secret → principal（禁用的不算） */
export function findByBearer(file: PrincipalsFile, secret: string): Principal | null {
  if (!secret) return null;
  const p = file.principals.find(
    (x) =>
      x.id.startsWith("token:") &&
      typeof x.secret === "string" &&
      secretEquals(x.secret, secret) &&
      !x.disabled,
  );
  return p ?? null;
}

/** 聊天身份 api:<tokenId> 反查 principal：token 类是 "token:<id>"，owner:self / guest:* 的 tokenId 就是完整 id */
export function findByTokenId(file: PrincipalsFile, tokenId: string): Principal | null {
  return file.principals.find((x) => x.id === `token:${tokenId}` || x.id === tokenId) ?? null;
}

/** 按 token 短 id 或 name 找（CLI revoke/show 用） */
export function findToken(file: PrincipalsFile, idOrName: string): Principal | null {
  return (
    file.principals.find(
      (x) => x.id === `token:${idOrName}` || x.id === idOrName ||
             (x.id.startsWith("token:") && x.name === idOrName),
    ) ?? null
  );
}

/**
 * scope 检查。registry 名带 "agent-" 前缀（如 "agent-worker"），token 里可能
 * 存的是用户输入的裸名（"worker"）—— 双向兼容。
 * "*" 只覆盖普通 agent；master（含 "master" 本名）必须显式列出。
 */
export function agentInScope(p: Principal, agentName: string): boolean {
  if (p.disabled) return false;
  // "agent-master" 变体也按 master 处理：API 端点对 agent 名双查
  // 裸名 + agent- 前缀变体，若只认 "master" 本名，"*" token 会经
  // agentInScope(p, "agent-master") 绕过 master 排除（R1 guard 漏洞）。
  const isMaster = isMasterAgent(agentName);
  // v2.15+ peer token 永不含 master（owner 2026-07-27:「大总管不可能被 peer
  // 分享出去」）。历史 token 显式列了 master（老版本 --force 能签出）也在
  // 这里截断——签发侧和消费侧双闸。
  if (p.peer && isMaster) return false;
  const want = bareCanonicalName(agentName);
  for (const a of p.agents) {
    if (a === "*") {
      if (!isMaster) return true;
      continue;
    }
    // 普通 agent 按规范名比（CC / 全角 / 零宽变体 = 同一个）；大总管只认逐字列出的 master / agent-master，老条目里的 MASTER 之类
    // 变体不给任何权限（等于无效条目，readPrincipals 告警）——请求里的名字是哪种写法都一样，isMasterAgent 已认作大总管
    if (isMaster ? isLiteralMaster(a) : bareCanonicalName(a) === want) return true;
  }
  return false;
}

/**
 * 远程终端授权（B2）。终端 = 宿主 shell 访问级别（可从 CC 逃到裸 shell、绕过
 * `--disallowedTools`），严格强于 messaging，故在 agentInScope 之外**额外**要求
 * 显式 terminal 授予，不让只读/messaging token 静默获得 shell。owner 默认允许。
 */
export function terminalAllowed(p: Principal, agentName: string): boolean {
  if (!agentInScope(p, agentName)) return false;
  return p.role === "owner" || p.terminal === true;
}

/**
 * 「owner 本人」的唯一定义（推送的 owner 身份表 push/dispatcher.ownerChatIds、@ 委托标记的来源判定 lib/delegate-marker.ts 共用）：
 * owner 所有设备共用的 owner:self（受限设备的 role 会降成 external，所以按 id 认，不看 role）；
 * 过渡期名为 web-ui 的老 token 也算——那是旧 Next 前端替 owner 自己的浏览器持有的凭据，推送一直按 owner 对待，
 * 两处不一致会让同一个人推送照发、@ 却被中和。peer token 与停用的永远不算。
 */
export function isOwnerPrincipal(p: Pick<Principal, "id" | "name" | "disabled" | "peer">): boolean {
  if (p.peer || p.disabled) return false;
  return p.id === OWNER_PRINCIPAL_ID || (p.name === LEGACY_OWNER_TOKEN_NAME && p.id.startsWith("token:"));
}

/** 批量管理（bridge/fleet：往一批会话发键、群发）：owner 本人且是全 scope 的 manage 凭据；guest、部分 scope 的设备、peer 一律不给 */
export function canRunFleet(p: Principal): boolean {
  return isOwnerPrincipal(p) && canReadLedger(p);
}

/**
 * Discord snowflake 校验：17-20 位纯数字。
 * `.env.example` 里的占位符（`your-discord-user-id`）过得了 `filter(Boolean)`，
 * 手动安装路径（`cp .env.example .env`）会把它当真 id 一路写进 principals.json
 * 变成一条永久的假 owner。这里是那条链路上唯一的把关点。
 */
export function isDiscordSnowflake(s: string): boolean {
  return /^\d{17,20}$/.test(s.trim());
}

/**
 * v2.6.0+ C2-3：把 .env 的 ALLOWED_USER_IDS 同步成 discord:<uid> role:owner
 * principals（principals.json 成为身份真源，.env 保留作 seed/fallback）。
 * 幂等：已存在的 discord principal 不覆盖（用户手动改过 role/disabled 要保留）。
 * 非法 id（占位符、笔误）直接跳过，不落盘。
 * 返回 true = 文件有变化（已落盘）。
 */
export async function syncDiscordOwnersFromEnv(
  allowedIds: string[],
  path = PRINCIPALS_PATH,
): Promise<boolean> {
  if (allowedIds.length === 0) return false;
  // strict：principals.json 坏了就抛，绝不「读成空 → 追加 owner → 写回」抹掉全部 token
  const file = await readPrincipalsStrict(path);
  let changed = false;
  for (const uid of allowedIds) {
    if (!isDiscordSnowflake(uid)) {
      console.warn(
        `⚠️ ALLOWED_USER_IDS 里的 "${uid}" 不是合法的 Discord 用户 ID（应为 17-20 位数字），已跳过。\n` +
          `   在 Discord 里开启 设置 → 高级 → 开发者模式，右键自己的头像 → 复制用户 ID。`,
      );
      continue;
    }
    const id = `discord:${uid}`;
    if (file.principals.some((p) => p.id === id)) continue;
    file.principals.push({
      id,
      role: "owner",
      agents: ["*", "master"],
      createdAt: new Date().toISOString(),
    });
    changed = true;
  }
  if (changed) await writePrincipals(file, path);
  return changed;
}

/** principals 里未禁用的 discord principal 的 uid 列表 */
export function listDiscordPrincipalIds(file: PrincipalsFile): string[] {
  return file.principals
    .filter((p) => p.id.startsWith("discord:") && !p.disabled)
    .map((p) => p.id.slice(8));
}

/**
 * 内存滑动窗口限流（纯逻辑，可测）。默认 30 次 / 60s。
 * bridge 每个 principal 一个实例；重启清零（可接受）。
 */
export class SlidingWindowLimiter {
  private hits: number[] = [];
  constructor(
    private readonly limit = 30,
    private readonly windowMs = 60_000,
  ) {}

  /** 记一次调用。true = 放行，false = 超限 */
  tryAcquire(now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    while (this.hits.length > 0 && this.hits[0] <= cutoff) this.hits.shift();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }

  /** 当前窗口内已用次数（诊断用） */
  used(now = Date.now()): number {
    const cutoff = now - this.windowMs;
    return this.hits.filter((t) => t > cutoff).length;
  }
}
