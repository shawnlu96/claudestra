/**
 * rename.state 状态根迁移的注入面。本模块不知道任何生产路径,也不 import 身份生成器:
 * 旧根 / 新根 / 停写证明 / 文件系统适配器都由调用方显式给,验收只在临时目录。
 */

import type { TxMode, TxReport } from "../transaction/types.ts";

export type NodeKind = "dir" | "file" | "symlink" | "other";

export interface NodeStat {
  kind: NodeKind;
  mode: number;
  uid: number;
  gid: number;
  /** 所在文件系统;跨设备判定只看它 */
  dev: number;
  /** 一致性快照用的元数据(lib/state-maintenance/inventory.ts):前后任一变化即「非一致快照」 */
  ino?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
}

/** 文件系统适配器。读接口找不到返回 null;写接口失败直接抛(由事务执行器补偿) */
export interface StateFs {
  lstat(path: string): Promise<NodeStat | null>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array | null>;
  realpath(path: string): Promise<string | null>;
  /** 清单记 symlink 本身指向什么(不跟随);可选,没有就只记类型 */
  readlink?(path: string): Promise<string | null>;
  /** 原子改名;跨设备由底层报 EXDEV,绝不退化成复制 */
  rename(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, mode: number): Promise<void>;
}

/** 停写证明:返回仍在写 root 的写者描述,空数组 = 全部已停。每次动手前都会再问一遍 */
interface WriterProbe {
  activeWriters(root: string): Promise<string[]>;
}

export interface StateMigrationOptions {
  /** rename.state;缺省 / 不认识的值按 off */
  mode: TxMode | string | undefined;
  oldRoot: string;
  newRoot: string;
  /** 用来算默认根(home 下的旧名 / 新名);任一根不是默认根即为自定义根 */
  home: string;
  /** 自定义根必须原样写在这里才放行(两项都要和 oldRoot / newRoot 逐字相同) */
  approvedCustom?: { oldRoot: string; newRoot: string };
  writers: WriterProbe;
  fs: StateFs;
  /** 事务日志与锁所在目录,必须在两个根之外(observe 不创建) */
  journalDir: string;
  /** 每次迁移 / 回滚一个新 id;同一 id 已结束的事务不会重做 */
  txId: string;
  crashAt?: (point: string) => void;
  lockWaitMs?: number;
}

/** 两个根此刻的形态 */
export type Layout =
  | { kind: "legacy"; newEmptyDir: boolean }
  | { kind: "moved" }
  | { kind: "migrated" }
  | { kind: "missing" }
  | { kind: "conflict"; reasons: string[] };

export interface StateReport extends TxReport {
  /** 事务结束后两个根的形态;off 不看磁盘,记 unchecked */
  layout: Layout["kind"] | "unchecked";
}
