/**
 * cron 表达式的纯逻辑：解析、匹配、下次触发时间、一轮 tick 里该跑哪些任务。
 * 不读写状态、不起进程——src/cron.ts（daemon 入口）原样再导出，manager 的 cron-add / cron-edit 校验走的也是这里。
 */

interface CronField {
  values: Set<number>;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

interface FieldSpec {
  key: keyof ParsedCron;
  label: string;
  min: number;
  max: number;
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { key: "minute", label: "分", min: 0, max: 59 },
  { key: "hour", label: "时", min: 0, max: 23 },
  { key: "dayOfMonth", label: "日", min: 1, max: 31 },
  { key: "month", label: "月", min: 1, max: 12 },
  { key: "dayOfWeek", label: "周", min: 0, max: 6 },
];

// 支持常用别名
const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
};

const MINUTE_MS = 60_000;
/** 报错里回显的正文上限：坏记录每分钟进一次 daemon 日志，不能把整段正文都带上 */
const ECHO_MAX = 80;

const echo = (text: string): string => (text.length > ECHO_MAX ? `${text.slice(0, ECHO_MAX)}…` : text);

function invalid(expr: string, why: string): Error {
  return new Error(`无效的 cron 表达式: "${echo(expr)}" (${why})`);
}

/** 纯十进制数字才算数；parseInt / Number 会放过 "5abc"、"1e1"、"0x10"、空串 */
function toInt(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * 一个字段里逗号分开的一段：`*`、`a`、`a-b`，后面可带 `/步长`。先把步长和边界验完再展开——
 * 步长 ≥ 1、lo ≤ hi 且都在 [min, max] 内，展开的循环最多走 max - min + 1 步，也一定至少产出 lo。
 * `a/n`（单值带步长）沿用旧行为：只取 a。
 */
function expandPart(part: string, spec: FieldSpec, expr: string, into: Set<number>): void {
  const fail = (why: string) => invalid(expr, `${spec.label}字段 "${echo(part)}": ${why}`);
  const slash = part.indexOf("/");
  const range = slash < 0 ? part : part.slice(0, slash);
  let step = 1;
  if (slash >= 0) {
    const parsed = toInt(part.slice(slash + 1));
    if (parsed === null || parsed < 1) throw fail("步长必须是正整数");
    step = parsed;
  }

  let lo = spec.min;
  let hi = spec.max;
  if (range !== "*") {
    const dash = range.indexOf("-");
    const from = toInt(dash < 0 ? range : range.slice(0, dash));
    const to = dash < 0 ? from : toInt(range.slice(dash + 1));
    if (from === null || to === null) throw fail("只能是 *、数字、a-b，可带 /步长");
    if (from < spec.min || to > spec.max) throw fail(`超出范围 ${spec.min}-${spec.max}`);
    if (from > to) throw fail("范围的起点大于终点");
    lo = from;
    hi = to;
  }
  for (let i = lo; i <= hi; i += step) into.add(i);
}

function parseCronField(field: string, spec: FieldSpec, expr: string): CronField {
  const values = new Set<number>();
  for (const part of field.split(",")) expandPart(part, spec, expr, values);
  return { values };
}

export function parseCronExpression(expr: string): ParsedCron {
  if (typeof expr !== "string") throw new Error("无效的 cron 表达式: 不是字符串");
  const trimmed = expr.trim();
  const parts = (ALIASES[trimmed] || trimmed).split(/\s+/);

  if (parts.length !== 5) {
    throw invalid(expr, "需要 5 个字段: 分 时 日 月 周");
  }

  const parsed = {} as ParsedCron;
  FIELD_SPECS.forEach((spec, i) => {
    parsed[spec.key] = parseCronField(parts[i]!, spec, expr);
  });
  return parsed;
}

/** 按本地日历判断（cron 的时区语义 = 进程本地时区）；日、周同时指定是 AND。 */
function matchesParsed(cron: ParsedCron, date: Date): boolean {
  return (
    cron.minute.values.has(date.getMinutes()) &&
    cron.hour.values.has(date.getHours()) &&
    cron.dayOfMonth.values.has(date.getDate()) &&
    cron.month.values.has(date.getMonth() + 1) &&
    cron.dayOfWeek.values.has(date.getDay())
  );
}

export function cronMatches(expr: string, date: Date): boolean {
  return matchesParsed(parseCronExpression(expr), date);
}

/**
 * 计算下一次触发时间（from 所在分钟之后，最多往后找 366 天）。
 * 沿 epoch 分钟逐个往后走、每一分钟按本地日历匹配，和 daemon 的 tick 是同一条时间线：
 * 本地 setMinutes(+1) 在夏令时回拨那天会从 01:59 直接落到第二个 02:00，漏掉重复的那一小时。
 */
export function nextCronTime(expr: string, from: Date = new Date()): Date {
  const cron = parseCronExpression(expr);
  const fromMs = from.getTime();
  if (!Number.isFinite(fromMs)) throw new Error(`无法计算下次触发时间: "${echo(expr)}" (起点不是有效时间)`);
  const start = (Math.floor(fromMs / MINUTE_MS) + 1) * MINUTE_MS;

  const limit = 366 * 24 * 60; // 最多检查一年
  const probe = new Date(start);
  for (let i = 0; i < limit; i++) {
    probe.setTime(start + i * MINUTE_MS);
    if (matchesParsed(cron, probe)) return new Date(probe.getTime());
  }

  throw new Error(`无法计算下次触发时间: "${echo(expr)}"`);
}

/**
 * 一轮 tick 里到点的任务。每条记录各自 try：一条坏表达式只进 errors，不挡后面合法的任务。
 */
export function dueCronJobs<T extends { enabled: boolean; schedule: string }>(
  jobs: readonly T[],
  now: Date,
): { due: T[]; errors: { job: T; error: Error }[] } {
  const due: T[] = [];
  const errors: { job: T; error: Error }[] = [];
  for (const job of jobs) {
    if (!job.enabled) continue;
    try {
      if (cronMatches(job.schedule, now)) due.push(job);
    } catch (err) {
      errors.push({ job, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }
  return { due, errors };
}
