/**
 * rename.repo(仓库转移后迁移本地 origin)的注入面。本模块不知道任何生产路径,也不碰网络:
 * 读写 remote 走注入的 RepoGit,迁移记录走注入的 RecordStore。验收只在临时 Git 仓 + fake 上跑。
 * 接口里没有「改工作目录 / worktree / hooks 路径」和「调 GitHub」的入口:本地 checkout 原地不动,GitHub 转移由人在网页上做。
 */

import type { TxMode } from "../floka-migration/transaction/types.ts";

/** rename.repo:off 不读也不写,observe 只读出计划(零 Git 写入),on 才改 origin;缺省 / 不认识的值按 off */
export type RepoMode = TxMode;

/** 一个 remote 在本仓配置里的原值(git config 原文,不经 insteadOf 改写) */
export interface RemoteEntry {
  name: string;
  urls: readonly string[];
  pushUrls: readonly string[];
}

export type UrlKey = "url" | "pushurl";

export interface RepoGit {
  /** 只读:本仓配置里全部 remote 的 url / pushurl 原值 */
  listRemotes(): Promise<RemoteEntry[]>;
  /**
   * 唯一的写:把 remote.<name>.<key> 里恰好等于 from 的那一个值换成 to(比较后交换);
   * 当前值不是 from 时必须失败,不许追加新值
   */
  setUrl(remote: string, key: UrlKey, from: string, to: string): Promise<void>;
}

export interface UrlChange {
  remote: string;
  key: UrlKey;
  from: string;
  to: string;
}

export interface MigrationRecord {
  version: 1;
  item: "rename.repo";
  planKey: string;
  from: string;
  to: string;
  /** 每个被改的值的原文:回滚只用它,不靠推算 */
  changes: readonly UrlChange[];
  /** applying:写之前先落盘;applied:全部核对过;rolled-back:原值已全部恢复 */
  status: "applying" | "applied" | "rolled-back";
}

export interface RecordStore {
  load(): Promise<MigrationRecord | null>;
  /** 原子落盘 */
  save(record: MigrationRecord): Promise<void>;
}

export interface Untouched {
  remote: string;
  key: UrlKey;
  url: string;
  reason: string;
}

/** 转移先决条件:本工具不连 GitHub,全部是人工核对项,状态恒为 manual */
export interface Prerequisite {
  id: string;
  check: string;
  status: "manual";
}

export interface RepoPlan {
  version: 1;
  item: "rename.repo";
  from: string;
  to: string;
  /** observe 时 remote 全集的指纹;on 时重读不一致就拒绝执行这份计划 */
  sourceKey: string;
  /** 计划身份:sourceKey + from/to + changes */
  planKey: string;
  remotes: readonly RemoteEntry[];
  changes: readonly UrlChange[];
  untouched: readonly Untouched[];
  prerequisites: readonly Prerequisite[];
  refusals: readonly string[];
}

type RepoStatus = "off" | "observed" | "blocked" | "applied" | "rolled-back";

export interface RepoResult {
  item: "rename.repo";
  mode: RepoMode;
  status: RepoStatus;
  plan?: RepoPlan;
  record?: MigrationRecord;
  refusals: readonly string[];
  /** 恒为 true 的提醒:GitHub 上的转移 / 反向转移不由本工具完成,也不因本地回滚而撤销 */
  githubUntouched: true;
}
