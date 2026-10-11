/**
 * cron 表达式的纯逻辑：解析、匹配、下次触发时间、一轮 tick 里该跑哪些任务。
 * 不读写状态、不起进程——src/cron.ts（daemon 入口）原样再导出，manager 的 cron-add / cron-edit 校验走的也是这里。
 */


interface CronField {
  values: Set<number>;
}

function parseCronField(field: string, min: number, max: number): CronField {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2]) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      for (let i = lo; i <= hi; i += step) values.add(i);
    } else {
      values.add(parseInt(range));
    }
  }

  return { values };
}

export function parseCronExpression(expr: string): {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
} {
  // 支持常用别名
  const aliases: Record<string, string> = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
    "@yearly": "0 0 1 1 *",
  };

  const resolved = aliases[expr.trim()] || expr.trim();
  const parts = resolved.split(/\s+/);

  if (parts.length !== 5) {
    throw new Error(`无效的 cron 表达式: "${expr}" (需要 5 个字段: 分 时 日 月 周)`);
  }

  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dayOfWeek: parseCronField(parts[4], 0, 6),
  };
}

export function cronMatches(expr: string, date: Date): boolean {
  const cron = parseCronExpression(expr);
  return (
    cron.minute.values.has(date.getMinutes()) &&
    cron.hour.values.has(date.getHours()) &&
    cron.dayOfMonth.values.has(date.getDate()) &&
    cron.month.values.has(date.getMonth() + 1) &&
    cron.dayOfWeek.values.has(date.getDay())
  );
}

/** 计算下一次触发时间（从 now 开始，最多往后找 366 天） */
export function nextCronTime(expr: string, from: Date = new Date()): Date {
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  const limit = 366 * 24 * 60; // 最多检查一年
  for (let i = 0; i < limit; i++) {
    if (cronMatches(expr, next)) return next;
    next.setMinutes(next.getMinutes() + 1);
  }

  throw new Error(`无法计算下次触发时间: "${expr}"`);
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
