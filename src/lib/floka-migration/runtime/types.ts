/**
 * rename.runtime(runtime 目录别名)的类型。本模块不知道任何生产路径:现存 runtime 目录、别名路径、
 * socket 文件名都由调用方显式传入,文件系统与 tmux server 查询都走注入的接口(验收只在临时目录 + fake)。
 * 接口里没有复制文件和启动 server 的入口:别名只可能是一条软链,server 只可能被查询。
 */

import type { TxMode } from "../transaction/types.ts";

/** rename.runtime:off 不动也不读,observe 只出计划(零写入),on 建别名;缺省 off */
type RuntimeMode = TxMode;

export type EntryKind = "missing" | "symlink" | "dir" | "other";

/** 别名用到的全部文件系统操作;写只有 symlink / unlink / rename / link(硬链,不复制内容),都不跨目录 */
export interface AliasFs {
  /** 不跟随软链看这一项是什么 */
  kind(path: string): Promise<EntryKind>;
  /** 解析软链到底;失效(ENOENT)或成环(ELOOP)时抛带 code 的错 */
  resolve(path: string): Promise<string>;
  /** 跟随软链后的文件标识(dev:ino);不存在返回 null */
  fileId(path: string): Promise<string | null>;
  /** 不跟随软链的这一项自身标识(dev:ino):认「还是不是本次建的那条软链」;不存在返回 null */
  entryId(path: string): Promise<string | null>;
  /**
   * 占住这一项(不跟随软链)并给出它此刻的 entryId;不存在返回 null。占住期间它被删也不会把 inode 号让给后来者
   * (Linux 会立刻复用刚释放的号,只凭 dev:ino 认不出「换成了另一条」)。只读,不写目录;用完必须 release
   */
  hold(path: string): Promise<EntryHold | null>;
  /** 软链自身的目标原文(不解析) */
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** 原子改名;删别名时用来先取走再核对 */
  rename(from: string, to: string): Promise<void>;
  /** 硬链接;目标已存在时失败,用来不覆盖地放回 */
  link(existing: string, path: string): Promise<void>;
}

export interface EntryHold {
  id: string;
  release(): Promise<void>;
}

/** 只读查询:这个 socket 路径后面是哪个 server(连不上返回 null)。生产实现包 tmux-helper 的查询,见 adapters.ts */
export interface ServerProbe {
  identify(socketPath: string): Promise<string | null>;
}

export interface RuntimeAliasInput {
  /** 开关原文;不认识的值按 off */
  mode: unknown;
  /** 现存 runtime 目录(绝对路径) */
  currentDir: string;
  /** 新别名路径(绝对路径),建成后指向现存 runtime 目录 */
  aliasDir: string;
  /** socket 文件名,迁移前后不改 */
  socketName: string;
  fs: AliasFs;
  probe: ServerProbe;
}

export type AliasState = "absent" | "aliased" | "conflict-entry" | "wrong-alias" | "dangling-alias" | "alias-loop" | "unknown";

type RefusalCode =
  | "invalid-path" | "current-missing" | "current-not-dir" | "alias-parent-missing" | "same-path" | "nested-path"
  | "conflict-entry" | "wrong-alias" | "dangling-alias" | "alias-loop"
  | "socket-missing" | "server-unreachable" | "identity-mismatch" | "mode-not-on";

/** scope:path = 入参或目录本身不成立;alias = 别名位置被占;server = socket / server 身份问题 */
export interface Refusal {
  code: RefusalCode;
  scope: "path" | "alias" | "server";
  detail: string;
}

export interface RuntimeAliasPlan {
  currentDir: string;
  /** currentDir 解析软链链之后的真实目录,别名直接指向它 */
  currentReal: string;
  aliasDir: string;
  currentSocket: string;
  aliasSocket: string;
  aliasState: AliasState;
  action: "create-alias" | "none";
  /** 现路径上的 server 身份(server 标识 + socket 文件标识);拿不到为 null */
  identity: string | null;
  refusals: Refusal[];
  /** socket 物理落点变更的维护计划:只输出,本库不执行 */
  maintenance: string[];
}

type RuntimeAliasStatus = "off" | "observed" | "aliased" | "already" | "rolled_back" | "absent" | "refused";

export interface RuntimeAliasReport {
  mode: RuntimeMode;
  status: RuntimeAliasStatus;
  /** 本次调用是否动过文件系统 */
  changed: boolean;
  plan?: RuntimeAliasPlan;
  identityBefore?: string | null;
  identityAfter?: string | null;
  refusals?: Refusal[];
}
