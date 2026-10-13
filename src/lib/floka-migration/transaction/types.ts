/**
 * floka 迁移事务骨架的类型。事务日志只服务于续跑 / 回滚,不是业务台账。
 * 本模块不知道任何生产路径:适配器和状态目录都由调用方注入(验收只在临时目录)。
 */

/** rename.transaction 及各分项开关:off 不执行,observe 只出计划与冲突,on 执行 */
export type TxMode = "off" | "observe" | "on";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * 一个迁移步骤。read / conflicts / done / verify 必须只读;
 * done 判断副作用是否已在,重跑靠它不重复 apply;compensate 拿日志里的无损旧值恢复,必须幂等。
 * read 返回需脱敏的数据会在执行前拒绝;凭据须保存在适配器拥有的受保护备份中,read 仅返回非敏感引用。
 */
export interface TxStep<A> {
  id: string;
  /** 所属分项开关名;分项没批准(缺省 off)时总开关 on 也不执行它 */
  item: string;
  /** 恢复动作的说明,写进日志供人诊断 */
  recovery: string;
  read(adapter: A): Promise<Json>;
  conflicts?(adapter: A, before: Json): Promise<string[]>;
  done(adapter: A): Promise<boolean>;
  apply(adapter: A): Promise<void>;
  verify(adapter: A): Promise<boolean>;
  compensate(adapter: A, before: Json): Promise<void>;
}

export interface TxOptions<A> {
  txId: string;
  /** 总开关 rename.transaction */
  mode: TxMode;
  /** 分项开关;没列出的分项按 off */
  items: Record<string, TxMode | undefined>;
  steps: TxStep<A>[];
  adapter: A;
  /** 事务日志和锁所在目录(注入,observe 不创建) */
  stateDir: string;
  /** 故障注入点:抛出即模拟进程在此处死掉(不补偿、不写日志) */
  crashAt?: (point: string) => void;
  lockWaitMs?: number;
}

export type StepState = "applying" | "applied" | "compensating" | "compensated" | "compensate_failed";
type TxStatus = "off" | "observed" | "committed" | "rolled_back" | "rollback_failed" | "refused";

export interface StepReport {
  id: string;
  item: string;
  mode: TxMode;
  state: StepState | "planned" | "skipped";
  conflicts?: string[];
  error?: string;
}

export interface TxReport {
  txId: string;
  mode: TxMode;
  status: TxStatus;
  steps: StepReport[];
  failedStep?: string;
  error?: string;
}

/** 日志里的一步:旧值必须可无损持久化,beforeSum 是旧值的校验 */
export interface StepRecord {
  id: string;
  item: string;
  state: StepState;
  before: Json;
  beforeSum: string;
  recovery: string;
  error?: string;
}

export type JournalStatus = "running" | "committed" | "rolling_back" | "rolled_back" | "rollback_failed";

export interface Journal {
  version: number;
  txId: string;
  /** 本事务要执行的步骤 id(有序);重跑时步骤清单必须一致 */
  plan: string[];
  status: JournalStatus;
  /** 最后一个已校验提交的步骤下标,-1 = 还没有 */
  commitPoint: number;
  failure?: { step: string; error: string };
  steps: StepRecord[];
}
