/**
 * cron.json 里一条任务的形状。调度器（src/cron.ts）和 bridge 的 /cron 路由（bridge/cron-routes.ts）都要用，
 * 而 bridge 模块不能 import 入口文件，所以类型放在 lib；src/cron.ts 原样 re-export，老的 import 不用改。
 */
export interface CronJob {
  id: string;
  name: string;
  schedule: string;         // cron 表达式 (分 时 日 月 周)
  prompt: string;           // 发给 agent 的指令
  dir: string;              // 工作目录（targetAgent 模式下未使用，为向后兼容保留字段）
  enabled: boolean;
  reportChannelId?: string; // 结果通知频道（默认用 CONTROL_CHANNEL_ID）
  maxRuntime?: number;      // 最大运行时间（分钟，默认 30）
  lastRun?: string;         // ISO timestamp
  nextRun?: string;         // ISO timestamp
  createdAt: string;        // ISO timestamp
  /**
   * v2.4.18+ 定向到已存在的 agent。设了这个字段就不 spawn 临时 agent，直接把
   * prompt 发到目标 agent 的 tmux window（等同用户在 Discord 里给它敲字）。
   * agent 在自己 session 里回答，完整继承对话历史 / 上下文 / mem0 记忆访问。
   * 不设 = 老行为（每次建临时 agent、跑完销毁）。
   *
   * 值是 agent 短名（不带 "agent-" 前缀，跟 CLI 一致）。
   */
  targetAgent?: string;
  /**
   * v2.21.3+ 临时 agent 的 effort 档(low|medium|high|xhigh|max)。缺省 medium——
   * Fable 5.1 文档:medium ≈ Fable 5 且更便宜;无人值守批处理不值得 xhigh 的
   * 额度与时延。targetAgent 模式下无意义(用目标 agent 自己的档),不传。
   */
  effort?: string;
  /**
   * v2.21.4+ 临时 agent 的归属 project id。不设 = create 按 dir 自动解析——dir 为
   * 家目录时会落进「家目录杂项」这种傘形组(owner 2026-09-04:「你不应该把这个
   * cron job 归到家目录杂项里」)。targetAgent 模式下无意义(目标 agent 自有归属)。
   */
  project?: string;
}
