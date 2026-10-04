/**
 * Codex 版「先存交接」的纯存储（codex-compact N3，docs/runtimes/codex-save-compact-plan.md §2.2）。
 * 落点只有一个：`STATE_DIR/handoff/<registry 名>/HANDOFF.md`，名字由 bridge 按连接认出（bridge/handoff-route.ts），
 * 调用方给不了路径也给不了名字，所以执行者和 PM 互相盖不到、worktree 也改不到主仓交接；不碰 `~/.claude` 下任何东西。
 * - 名字必须在 registry 里、且是一段安全的目录名（registry 的建名黑名单：没有 / . : ~ 空白 控制符）；
 * - 目录 0700（组 / 其他人有权限位就收紧）、文件 0600；handoff 根、agent 目录、HANDOFF.md 任一是软链（或不是目录 / 普通文件）就拒，realpath 再核一次不出根；
 * - 写入走 lib/state-file.ts 的原子写（tmp + rename，noFollow），同 agent 的写者经 lib/file-lock.ts 串行，rename 前核锁；
 * - 文件首行是一行 HTML 注释的元数据（opId / savedAt / agent / bytes），N4 据它和文件时间核这次保存的结果。
 * 保存成功只代表交接落盘，不代表压缩完成。tests/agent-handoff.test.ts。
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { join } from "path";
import { acquireLock } from "./file-lock.js";
import { STATE_DIR } from "./paths.js";
import { AGENT_NAME_BLOCKLIST_RE } from "./registry.js";
import { writeTextAtomicSync } from "./state-file.js";

const HANDOFF_FILE = "HANDOFF.md";
/** 正文上限（UTF-8 字节，不含元数据行） */
export const HANDOFF_MAX_BYTES = 16 * 1024;
const OP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const META_RE = /^<!-- claudestra-handoff (\{.*\}) -->\n/;
const LOCK_WAIT_MS = 5_000;

class HandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffError";
  }
}

export interface HandoffMeta {
  opId: string;
  savedAt: string;
  agent: string;
  bytes: number;
}

export interface SaveHandoffInput {
  /** bridge 按连接认出的 agent 名；调用方给不了 */
  agent: string;
  /** registry 里登记的全部名字（不在里面的一律拒） */
  registered: readonly string[];
  opId: unknown;
  text: unknown;
  /** 缺省 STATE_DIR；测试给临时目录 */
  stateDir?: string;
  now?: () => Date;
}

export const handoffRoot = (stateDir = STATE_DIR): string => join(stateDir, "handoff");

/** 参数校验：opId 是短标识，text 非空、合法 UTF-8（没有孤立代理项）、不超上限 */
function checkHandoffArgs(opId: unknown, text: unknown): { opId: string; text: string; bytes: number } {
  if (typeof opId !== "string" || !OP_ID_RE.test(opId)) throw new HandoffError("opId 要是 1-128 位的字母数字或 _ . : -");
  if (typeof text !== "string" || !text.trim()) throw new HandoffError("交接正文不能为空");
  if (!text.isWellFormed()) throw new HandoffError("交接正文不是合法的 UTF-8（含孤立的代理项）");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > HANDOFF_MAX_BYTES) throw new HandoffError(`交接正文 ${bytes} 字节，超过上限 ${HANDOFF_MAX_BYTES}`);
  return { opId, text, bytes };
}

function safeAgentName(agent: string, registered: readonly string[]): string {
  if (!agent || agent.length > 128 || AGENT_NAME_BLOCKLIST_RE.test(agent)) throw new HandoffError(`agent 名 ${JSON.stringify(agent.slice(0, 60))} 不能安全地当目录名`);
  if (!registered.includes(agent)) throw new HandoffError(`${agent} 不在 registry 里，不能存交接`);
  return agent;
}

/** 建（或核）一个私密目录：是软链 / 不是目录就拒；组和其他人有任何权限位就收成 0700 */
function privateDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new HandoffError(`${path} 不是普通目录（软链或文件），拒绝写交接`);
  if (st.mode & 0o077) chmodSync(path, 0o700);
}

/** 定位本 agent 的交接文件：逐级核目录，realpath 不出 handoff 根；HANDOFF.md 已存在时必须是普通文件 */
function locate(stateDir: string, agent: string): { lock: string; file: string } {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const root = handoffRoot(stateDir);
  privateDir(root);
  const dir = join(root, agent);
  privateDir(dir);
  if (realpathSync(dir) !== join(realpathSync(root), agent)) throw new HandoffError(`${dir} 解析后跑出了 handoff 目录，拒绝写`);
  const file = join(dir, HANDOFF_FILE);
  try {
    const st = lstatSync(file);
    if (!st.isFile()) throw new HandoffError(`${file} 不是普通文件（软链或目录），拒绝覆盖`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return { lock: join(root, `${agent}.lock`), file }; // 锁放在根下：agent 名里没有「.」，撞不上别的 agent 目录
}

function renderHandoff(meta: HandoffMeta, text: string): string {
  return `<!-- claudestra-handoff ${JSON.stringify(meta)} -->\n${text}`;
}

/** 原子写本 agent 的交接；任何一步不对都抛 HandoffError / fs 错误，旧文件原样保留 */
export async function saveAgentHandoff(input: SaveHandoffInput): Promise<HandoffMeta & { path: string }> {
  const { opId, text, bytes } = checkHandoffArgs(input.opId, input.text);
  const agent = safeAgentName(input.agent, input.registered);
  const { lock: lockPath, file } = locate(input.stateDir ?? STATE_DIR, agent);
  const lock = await acquireLock(lockPath, LOCK_WAIT_MS);
  if (!lock) throw new HandoffError(`${agent} 的交接正在被另一个写者占用，没写，稍后再试`);
  try {
    const meta: HandoffMeta = { opId, savedAt: (input.now?.() ?? new Date()).toISOString(), agent, bytes };
    writeTextAtomicSync(file, renderHandoff(meta, text), { mode: 0o600, noFollow: true, commitIf: lock.held });
    return { ...meta, path: file };
  } finally {
    lock.release();
  }
}

/** 读本 agent 的交接（给 N4 核保存结果）：不存在 → null；元数据行坏了抛错 */
export function readAgentHandoff(agent: string, stateDir = STATE_DIR): { meta: HandoffMeta; text: string } | null {
  const file = join(handoffRoot(stateDir), agent, HANDOFF_FILE);
  let raw: string;
  try {
    if (!lstatSync(file).isFile()) throw new HandoffError(`${file} 不是普通文件`);
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const m = META_RE.exec(raw);
  if (!m) throw new HandoffError(`${file} 缺少元数据行`);
  return { meta: JSON.parse(m[1]!) as HandoffMeta, text: raw.slice(m[0].length) };
}
