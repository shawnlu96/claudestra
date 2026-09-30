/**
 * 出借 / 借入声明 lend.json（docs/design/remote-capacity.md §1）：`lend` = 本机借给谁、出几个位；`borrow` = 本机哪些项目的单子可以给谁。
 * 只管读写与校验，领单循环不在这里。安全取向是 fail-closed：文件缺失 = 缺省（不出借、不借入）；文件无效（JSON 坏、版本不认识、
 * 任一条目不合法）= 按「关」处理并由 doctor 报出来，绝不退回「上次好的值」（readJsonLenient 那样会让坏文件继续生效）。
 * 写入只经 updateLend：独占锁（拿不到就拒写，不降级）+ 锁内重读 + tmp/rename 原子写 + 坏文件拒写。tests/lend-config.test.ts。
 */
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { FP_RE } from "./relay-protocol.js";
import { assertWritable, readJsonState, writeJsonAtomicSync } from "./state-file.js";

export const LEND_PATH = statePath("lend.json");
const LEND_VERSION = 1;

export const LEND_FAMILIES = ["codex", "claude"] as const;
export type LendFamily = (typeof LEND_FAMILIES)[number];
const LEND_ROLES = ["review", "write"] as const;
export type LendRole = (typeof LEND_ROLES)[number];
export type LendConfirm = "per-order" | "auto";

/** 上限：写错一位数（30 写成 300）要被拦下，不是真实容量的约束 */
export const MAX_FAMILY_SLOTS = 16;
export const MAX_ORDERS_PER_DAY = 200;
export const MAX_OPEN = 20;
export const MAX_REPOS = 50;
export const DEFAULT_ORDERS_PER_DAY = 5;
export const DEFAULT_MAX_OPEN = 3;

export interface LendEntry {
  /** peers.json 里已握手的 peer 名 */
  peer: string;
  /** 写入时对方的实例指纹：peer 名以后被换成别的实例（删了重加、同名）时对不上 → 这条失效 */
  fp?: string;
  /** 每个模型家族同时在跑的上限 */
  families: Partial<Record<LendFamily, number>>;
  roles: LendRole[];
  /** GitHub owner/repo 白名单 */
  repos: string[];
  /** tokensPerDay 预留，v1 不执行 */
  quota: { ordersPerDay: number; tokensPerDay: null };
  confirm: LendConfirm;
  /** 可选：到期自动停（ISO） */
  until?: string;
}

export interface BorrowEntry {
  peer: string;
  fp?: string;
  /** projects.json 的项目 id；个人项目永远不能出现（lend-policy.ts isPersonalProject） */
  projects: string[];
  roles: LendRole[];
  maxOpen: number;
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
  | { status: "ok"; file: LendFile };

/** 与 manager/peers.ts validPeerName 同口径：peer 名要进 `x@peer` 寻址 */
const PEER_NAME_RE = /^[\w-]{1,32}$/;
export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

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

function lendEntryProblem(e: unknown): string | null {
  if (!isObj(e)) return "不是对象";
  const p = peerProblem(e);
  if (p) return p;
  const fam = e.families;
  if (!isObj(fam) || Object.keys(fam).length === 0) return "families 必须是非空对象";
  for (const [k, n] of Object.entries(fam)) {
    if (!(LEND_FAMILIES as readonly string[]).includes(k)) return `families 里有不认识的家族 ${k}`;
    if (!isInt(n, 0, MAX_FAMILY_SLOTS)) return `families.${k} 必须是 0..${MAX_FAMILY_SLOTS} 的整数`;
  }
  if (!isRoles(e.roles)) return "roles 必须是 review / write 的非空、不重复列表";
  if (!isStrList(e.repos, REPO_RE, MAX_REPOS)) return "repos 必须是 GitHub owner/repo 的非空、不重复列表";
  const q = e.quota;
  if (!isObj(q) || !isInt(q.ordersPerDay, 1, MAX_ORDERS_PER_DAY)) return `quota.ordersPerDay 必须是 1..${MAX_ORDERS_PER_DAY} 的整数`;
  if (q.tokensPerDay !== null && q.tokensPerDay !== undefined) return "quota.tokensPerDay 在 v1 必须是 null（按 token 限额还没实现）";
  if (e.confirm !== "per-order" && e.confirm !== "auto") return "confirm 只能是 per-order / auto";
  if (e.until !== undefined && !isIso(e.until)) return "until 必须是 ISO 时间";
  return null;
}

function borrowEntryProblem(e: unknown): string | null {
  if (!isObj(e)) return "不是对象";
  const p = peerProblem(e);
  if (p) return p;
  if (!isStrList(e.projects, PROJECT_ID_RE, 100)) return "projects 必须是项目 id 的非空、不重复列表";
  if (!isRoles(e.roles)) return "roles 必须是 review / write 的非空、不重复列表";
  if (!isInt(e.maxOpen, 1, MAX_OPEN)) return `maxOpen 必须是 1..${MAX_OPEN} 的整数`;
  return null;
}

/** 整个文件的结构问题；null = 合法。任何一处不合法都算整份无效（不挑着用：半截声明比没有声明更危险） */
export function lendFileProblem(d: unknown): string | null {
  if (!isObj(d)) return "顶层不是对象";
  if (d.version !== LEND_VERSION) return `version 必须是 ${LEND_VERSION}（缺失或不认识的版本按无效处理）`;
  if (typeof d.enabled !== "boolean") return "enabled 必须是 true / false";
  if (!Array.isArray(d.lend)) return "lend 必须是数组";
  if (!Array.isArray(d.borrow)) return "borrow 必须是数组";
  for (const [key, list, check] of [["lend", d.lend, lendEntryProblem], ["borrow", d.borrow, borrowEntryProblem]] as const) {
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

/** 读：缺失 → 缺省；无效 → 缺省（= 关）并带原因；不抛。每次都读磁盘，不缓存（改完马上生效，坏了马上按关） */
export async function readLend(path = LEND_PATH): Promise<LendRead> {
  const r = await readJsonState(path);
  if (r.status === "missing") return { status: "missing", file: defaultLendFile() };
  if (r.status === "corrupt") return { status: "invalid", error: r.error, file: defaultLendFile() };
  const problem = lendFileProblem(r.data);
  if (problem) return { status: "invalid", error: problem, file: defaultLendFile() };
  return { status: "ok", file: r.data as LendFile };
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
