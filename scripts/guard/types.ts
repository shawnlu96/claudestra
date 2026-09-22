/** 仓库相对路径 → 文件内容。规则只吃这个，不碰磁盘，方便用内存 fixture 测。 */
export type Files = Map<string, string>;
/** baseline key → 数值。key 形如 `size:src/manager.ts`、`dup:total`、`deps:<边>`。 */
export type Counts = Record<string, number>;

export interface RuleResult {
  counts: Counts;
  /** 规则因依赖缺席（解析器 / knip）没有测量时的一行说明；此时它名下的 key 不检查、不改动。 */
  skipped?: string;
  /** 给人看的细节（按文件分布等），失败时打印。 */
  detail?: string[];
}

export interface Raised {
  key: string;
  from: number;
  to: number;
  why: string;
  date?: string;
}

export interface Baseline {
  version: 1;
  init?: { commit: string; date: string; unmeasured?: string[] };
  limits: Counts;
  raised: Raised[];
}

export interface Finding {
  key: string;
  cur: number;
  limit: number;
}
