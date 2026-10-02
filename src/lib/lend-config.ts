/**
 * 出借 / 借入声明 lend.json（docs/design/remote-capacity.md §1）：`lend` = 一次授权（借给谁、哪些仓库、各家族几个位、每天几单、到哪天）；
 * `borrow` = 本机哪些项目的单子可以给谁。只管读写与形状校验；授权此刻算不算数（暂停、到期、期限上限）在 lend-grant-rules.ts。
 * 安全取向是 fail-closed：文件缺失 = 缺省（不出借、不借入）；文件无效（JSON 坏、版本不认识、任一条目不合法）= 按「关」处理并由 doctor 报出来，
 * 绝不退回「上次好的值」。v1 文件照读，但出借条目一律迁成暂停（逐单确认已退役，要出借方本人重新授权）；写一律写 v2。
 * 写入只经 updateLend：独占锁（拿不到就拒写，不降级）+ 锁内重读 + tmp/rename 原子写 + 坏文件拒写。tests/lend-config.test.ts、tests/lend-grant.test.ts。
 */
import { CODEX_EFFORT_LEVELS } from "./codex-launch.js";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { FP_RE } from "./relay-protocol.js";
import { assertWritable, readJsonState, readJsonStateSync, writeJsonAtomicSync, type StateRead } from "./state-file.js";

export const LEND_PATH = statePath("lend.json");
const LEND_VERSION = 2;

export const LEND_FAMILIES = ["codex", "claude"] as const;
export type LendFamily = (typeof LEND_FAMILIES)[number];
export const LEND_ROLES = ["review", "write"] as const;
export type LendRole = (typeof LEND_ROLES)[number];
/**
 * 一台机器在槽池里的档位（i28-W9，scheduler-placement.ts）：先在 first 里按在跑最少挑，first 都接不了再看 balance，最后才看 low；off 一律不派。
 * 借入条目的 priority 与 scheduler.json 的 remote.localPriority 用同一套；不写 = balance。
 */
export const PRIORITIES = ["first", "balance", "low", "off"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const isPriority = (v: unknown): v is Priority => (PRIORITIES as readonly unknown[]).includes(v);

/** 上限：写错一位数（30 写成 300）要被拦下，不是真实容量的约束 */
export const MAX_FAMILY_SLOTS = 16;
export const MAX_ORDERS_PER_DAY = 200;
export const MAX_OPEN = 20;
export const MAX_REPOS = 50;
/** He 10-01 拍板的一次授权缺省：每天 200 单、codex 5 个位 */
export const DEFAULT_ORDERS_PER_DAY = 200;
export const DEFAULT_MAX_OPEN = 3;

/** 一次授权。没暂停的条目 fp / until / grantedAt 必填；v1 迁来的暂停条目可能缺 */
export interface LendEntry {
  /** peers.json 里已握手的 peer 名 */
  peer: string;
  /** 授权时对方的实例指纹：peer 名以后被换成别的实例（删了重加、同名）时对不上 → 这条失效 */
  fp?: string;
  /** 每个模型家族同时在跑的上限 */
  families: Partial<Record<LendFamily, number>>;
  /** 兼容旧消费者的能力字段；出借授权不按它过滤，读取时归一成全部能力。 */
  roles: LendRole[];
  /** GitHub owner/repo 白名单 */
  repos: string[];
  ordersPerDay: number;
  /** 到期时间（ISO），距 grantedAt 不超过 7 天 */
  until?: string;
  grantedAt?: string;
  /** 暂停 = 整条不生效（v1 迁移来的条目、待出借方本人重新授权） */
  paused?: { reason: string };
  /** 出借 worker 用的 Codex 模型 / 推理档；只由出借方本人在授权里写，不写 = 出借方 Codex 的默认配置（lend-grant-spawn.ts lendModelArgs） */
  codexModel?: string;
  codexEffort?: string;
}

export interface BorrowEntry {
  peer: string;
  fp?: string;
  /** projects.json 的项目 id；个人项目永远不能出现（lend-policy.ts isPersonalProject） */
  projects: string[];
  roles: LendRole[];
  maxOpen: number;
  /** 槽池里的档位；不写 = balance */
  priority?: Priority;
}

export interface LendFile {
  version: typeof LEND_VERSION;
  /** 出借总开关，缺省 false；只管 lend 段。借入由 borrow 有没有条目决定（没有 = 什么都不外借） */
  enabled: boolean;
  lend: LendEntry[];
  borrow: BorrowEntry[];
}

export const defaultLendFile = (): LendFile => ({ version: LEND_VERSION, enabled: false, lend: [], borrow: [] });

export type LendRead =
  | { status: "missing"; file: LendFile }
  | { status: "invalid"; error: string; file: LendFile }
  /** migrated = 磁盘上还是 v1，读出来的是迁移结果（下一次写盘落 v2） */
  | { status: "ok"; file: LendFile; migrated?: true };

/** 与 manager/peers.ts validPeerName 同口径：peer 名要进 `x@peer` 寻址 */
const PEER_NAME_RE = /^[\w-]{1,32}$/;
export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** 值会作为 manager create 的 --model 参数：只收小写字母数字、点、横线，首字符不能是 `-`（否则会被当成参数），最长 64 */
const CODEX_MODEL_RE = /^[a-z0-9][a-z0-9.\-]{0,63}$/;
export const isCodexModel = (v: unknown): v is string => typeof v === "string" && CODEX_MODEL_RE.test(v);
/** 档位只认 Codex 原名（codex-launch.ts 的全集），不收 ultracode 之类的折算别名 */
export const isCodexEffort = (v: unknown): v is string => typeof v === "string" && (CODEX_EFFORT_LEVELS as readonly string[]).includes(v);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isStrList = (v: unknown, re: RegExp, max: number): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.length <= max && v.every((x) => typeof x === "string" && re.test(x)) && new Set(v).size === v.length;
const isRoles = (v: unknown): v is LendRole[] =>
  Array.isArray(v) && v.length > 0 && v.every((r) => (LEND_ROLES as readonly unknown[]).includes(r)) && new Set(v).size === v.length;
const isIso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));

function peerProblem(e: Record<string, unknown>): string | null {
  if (typeof e.peer !== "string" || !PEER_NAME_RE.test(e.peer)) return "peer 不是合法的 peer 名";
  if (e.fp !== undefined && (typeof e.fp !== "string" || !FP_RE.test(e.fp))) return "fp 不是实例指纹（xxxx-xxxx-xxxx-xxxx）";
  return null;
}

function slotsProblem(e: Record<string, unknown>): string | null {
  const fam = e.families;
  if (!isObj(fam) || Object.keys(fam).length === 0) return "families 必须是非空对象";
  for (const [k, n] of Object.entries(fam)) {
    if (!(LEND_FAMILIES as readonly string[]).includes(k)) return `families 里有不认识的家族 ${k}`;
    if (!isInt(n, 0, MAX_FAMILY_SLOTS)) return `families.${k} 必须是 0..${MAX_FAMILY_SLOTS} 的整数`;
  }
  if (!isStrList(e.repos, REPO_RE, MAX_REPOS)) return "repos 必须是 GitHub owner/repo 的非空、不重复列表";
  return null;
}

/** v1 条目（逐单确认 / 限时预先授权）：只为读旧文件、迁移用 */
function lendEntryProblemV1(e: unknown): string | null {
  if (!isObj(e)) return "不是对象";
  const p = peerProblem(e) ?? slotsProblem(e);
  if (p) return p;
  const q = e.quota;
  if (!isObj(q) || !isInt(q.ordersPerDay, 1, MAX_ORDERS_PER_DAY)) return `quota.ordersPerDay 必须是 1..${MAX_ORDERS_PER_DAY} 的整数`;
  if (q.tokensPerDay !== null && q.tokensPerDay !== undefined) return "quota.tokensPerDay 在 v1 必须是 null（按 token 限额还没实现）";
  if (e.confirm !== "per-order" && e.confirm !== "auto") return "confirm 只能是 per-order / auto";
  if (e.until !== undefined && !isIso(e.until)) return "until 必须是 ISO 时间";
  return null;
}

function lendEntryProblem(e: unknown): string | null {
  if (!isObj(e)) return "不是对象";
  const p = peerProblem(e) ?? slotsProblem(e);
  if (p) return p;
  if (!isInt(e.ordersPerDay, 1, MAX_ORDERS_PER_DAY)) return `ordersPerDay 必须是 1..${MAX_ORDERS_PER_DAY} 的整数`;
  for (const k of ["until", "grantedAt"] as const) if (e[k] !== undefined && !isIso(e[k])) return `${k} 必须是 ISO 时间`;
  if (e.codexModel !== undefined && !isCodexModel(e.codexModel)) return "codexModel 只能是小写字母、数字、点、横线（首字符不能是 -，最长 64）";
  if (e.codexEffort !== undefined && !isCodexEffort(e.codexEffort)) return `codexEffort 只能是 ${CODEX_EFFORT_LEVELS.join(" / ")}`;
  const known = ["peer", "fp", "families", "roles", "repos", "ordersPerDay", "until", "grantedAt", "paused", "codexModel", "codexEffort"];
  const extra = Object.keys(e).find((k) => !known.includes(k));
  if (extra) return `不认识的字段 ${extra}（逐单确认 confirm / quota 是 v1 的写法，已退役）`;
  if (e.paused !== undefined) {
    const r = isObj(e.paused) ? e.paused.reason : undefined;
    return typeof r === "string" && r.length > 0 && r.length <= 300 ? null : "paused 必须是 { reason: 300 字以内的说明 }";
  }
  if (!e.fp || e.until === undefined || e.grantedAt === undefined) return "授权必须写明 fp（对方实例指纹）、until（到期时间）和 grantedAt";
  return null;
}

function borrowEntryProblem(e: unknown): string | null {
  if (!isObj(e)) return "不是对象";
  const p = peerProblem(e);
  if (p) return p;
  if (!isStrList(e.projects, PROJECT_ID_RE, 100)) return "projects 必须是项目 id 的非空、不重复列表";
  if (!isRoles(e.roles)) return "roles 必须是 review / write 的非空、不重复列表";
  if (!isInt(e.maxOpen, 1, MAX_OPEN)) return `maxOpen 必须是 1..${MAX_OPEN} 的整数`;
  if (e.priority !== undefined && !isPriority(e.priority)) return `priority 只能是 ${PRIORITIES.join(" / ")}`;
  return null;
}

/** 整个文件的结构问题；null = 合法。v1 / v2 都认（v1 按旧规则核，读时迁移）。任何一处不合法都算整份无效（不挑着用：半截声明比没有声明更危险） */
export function lendFileProblem(d: unknown): string | null {
  if (!isObj(d)) return "顶层不是对象";
  if (d.version !== LEND_VERSION && d.version !== 1) return `version 必须是 ${LEND_VERSION}（或待迁移的 1；缺失或不认识的版本按无效处理）`;
  if (typeof d.enabled !== "boolean") return "enabled 必须是 true / false";
  if (!Array.isArray(d.lend)) return "lend 必须是数组";
  if (!Array.isArray(d.borrow)) return "borrow 必须是数组";
  const lendCheck = d.version === 1 ? lendEntryProblemV1 : lendEntryProblem;
  for (const [key, list, check] of [["lend", d.lend, lendCheck], ["borrow", d.borrow, borrowEntryProblem]] as const) {
    const seen = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const p = check(list[i]);
      if (p) return `${key}[${i}]：${p}`;
      const peer = (list[i] as { peer: string }).peer;
      if (seen.has(peer)) return `${key} 里 peer ${peer} 出现了两次`;
      seen.add(peer);
    }
  }
  return null;
}

export const V1_PAUSED_REASON = "升级前的旧条目（逐单确认已退役）：请出借方本人用 lend grant 重新授权";

/**
 * v1 → v2：出借条目一律迁成暂停（逐单确认、限时预先授权都一样，按 He 10-01 拍板），字段原样搬、不补 until / grantedAt，
 * 所以迁移本身放宽不了任何边界；借入条目原样保留。纯函数，对同一份 v1 跑几次结果都一样。
 */
export function migrateV1(d: Record<string, unknown>): LendFile {
  const lend = (d.lend as Record<string, unknown>[]).map((e): LendEntry => ({
    peer: e.peer as string, ...(e.fp ? { fp: e.fp as string } : {}), families: e.families as LendEntry["families"], roles: [...LEND_ROLES],
    repos: e.repos as string[], ordersPerDay: (e.quota as { ordersPerDay: number }).ordersPerDay, ...(e.until ? { until: e.until as string } : {}),
    paused: { reason: V1_PAUSED_REASON },
  }));
  return { version: LEND_VERSION, enabled: d.enabled as boolean, lend, borrow: d.borrow as BorrowEntry[] };
}

function toRead(r: StateRead): LendRead {
  if (r.status === "missing") return { status: "missing", file: defaultLendFile() };
  if (r.status === "corrupt") return { status: "invalid", error: r.error, file: defaultLendFile() };
  const problem = lendFileProblem(r.data);
  if (problem) return { status: "invalid", error: problem, file: defaultLendFile() };
  const d = r.data as Record<string, unknown>;
  if (d.version === 1) return { status: "ok", file: migrateV1(d), migrated: true };
  const file = d as unknown as LendFile;
  return { status: "ok", file: { ...file, lend: file.lend.map((e) => ({ ...e, roles: [...LEND_ROLES] })) } };
}

/** 读：缺失 → 缺省；无效 → 缺省（= 关）并带原因；不抛。每次都读磁盘，不缓存（改完马上生效，坏了马上按关） */
export async function readLend(path = LEND_PATH): Promise<LendRead> {
  return toRead(await readJsonState(path));
}

/** 同步版：出借 worker 的宿主看门狗用（lend-watchdog.ts 是同步检查） */
export function readLendSync(path = LEND_PATH): LendRead {
  return toRead(readJsonStateSync(path));
}

/**
 * 加锁读改写。拿不到锁、磁盘上是无效文件、改完不合法、提交时锁已不归自己 —— 一律抛错不写。
 * mutate 可以就地改 file（可以是 async：要在锁内重读 peers / projects 再决定），返回值原样带出；内容没变就不写。
 * 核锁与 rename 在同一段同步代码里（writeJsonAtomicSync 的 commitIf）：held() 刚续过租，别的进程回收不了；
 * 中间只要隔一个 await，挂起过期的旧写者恢复后就会盖掉新写者已提交的内容（tests/lend-config.test.ts「P1-2」）。
 */
export async function updateLend<T>(mutate: (file: LendFile) => T | Promise<T>, path = LEND_PATH, lockMs = 10_000): Promise<T> {
  const lock = await acquireLock(`${path}.lock`, lockMs);
  if (!lock) throw new Error(`lend.json 正被别的进程占着（${Math.round(lockMs / 1000)} 秒没拿到锁），这次没改，稍后重试`);
  try {
    const cur = await readLend(path);
    if (cur.status === "invalid") throw new Error(`lend.json 无效（${cur.error}），已按「关」处理；修好或删掉 ${path} 后重试`);
    const file = cur.file;
    const before = JSON.stringify(file);
    const out = await mutate(file);
    if (JSON.stringify(file) === before) return out;
    const problem = lendFileProblem(file);
    if (problem) throw new Error(`改完的内容不合法（${problem}），没写`);
    await assertWritable(path, (d) => lendFileProblem(d) === null);
    try {
      writeJsonAtomicSync(path, file, { mode: 0o600, trailingNewline: true, commitIf: lock.held });
    } catch (e) {
      if (!lock.held()) throw new Error("提交前发现 lend.json 的锁已被别人回收（进程被挂起太久？），这次没写，重试即可");
      throw e;
    }
    return out;
  } finally {
    lock.release();
  }
}
