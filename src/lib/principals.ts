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

import { existsSync } from "fs";
import { timingSafeEqual } from "crypto";
import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { homedir } from "os";
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
}

export interface PrincipalsFile {
  principals: Principal[];
}

const CONFIG_DIR = join(homedir(), ".claude-orchestrator");
export const PRINCIPALS_PATH = join(CONFIG_DIR, "principals.json");

export async function readPrincipals(path = PRINCIPALS_PATH): Promise<PrincipalsFile> {
  try {
    if (!existsSync(path)) return { principals: [] };
    const data = JSON.parse(await readFile(path, "utf-8"));
    if (!Array.isArray(data.principals)) return { principals: [] };
    return data as PrincipalsFile;
  } catch {
    return { principals: [] };
  }
}

export async function writePrincipals(data: PrincipalsFile, path = PRINCIPALS_PATH): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  // mode 传给 open(2)，文件在**创建那一刻**就是 0600 —— 先写后 chmod 会留下一个
  // 内容已落盘、权限还是 0644 的窗口，而这个文件里是全部 API/peer token 的明文。
  // （对已存在的文件 mode 不生效，故后面仍补一次 chmod。）
  await writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { await chmod(path, 0o600); } catch { /* best-effort */ }
}

/** 生成一个新 token principal（不落盘，调用方决定何时 write） */
export function newTokenPrincipal(
  name: string,
  agents: string[],
  opts?: { terminal?: boolean; peer?: string },
): Principal {
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
  // [fork] "agent-master" 变体也按 master 处理：API 端点对 agent 名双查
  // 裸名 + agent- 前缀变体，若只认 "master" 本名，"*" token 会经
  // agentInScope(p, "agent-master") 绕过 master 排除（R1 guard 漏洞）。
  const isMaster = agentName === "master" || agentName === "agent-master";
  for (const a of p.agents) {
    if (a === "*") {
      if (!isMaster) return true;
      continue;
    }
    if (a === agentName || `agent-${a}` === agentName || a === `agent-${agentName}`) return true;
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
  const file = await readPrincipals(path);
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
