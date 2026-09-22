// 棘轮语义（纯函数）：check 超标即失败；--update 只收紧；放宽必须在 raised[] 里有记录。
// 缺失的 baseline 条目等于默认上限（size 是文件上限，其余是 0），所以删条目只会更严。
import { capFor, prefixOf } from "./config.ts";
import type { Baseline, Counts, Finding, Raised } from "./types.ts";

const limitOf = (limits: Counts, key: string) => limits[key] ?? capFor(key);
const isSkipped = (key: string, skipped: Set<string>) => skipped.has(prefixOf(key));

/** 当前实测值 vs baseline：failures = 超标；tightenable = 可以用 --update 收紧的项。 */
export function compare(limits: Counts, current: Counts, skipped: Set<string>) {
  const failures: Finding[] = [];
  const tightenable: Finding[] = [];
  for (const [key, cur] of Object.entries(current)) {
    if (isSkipped(key, skipped)) continue;
    const limit = limitOf(limits, key);
    if (cur > limit) failures.push({ key, cur, limit });
  }
  for (const [key, limit] of Object.entries(limits)) {
    if (isSkipped(key, skipped)) continue;
    const cur = current[key] ?? 0;
    if (cur < limit) tightenable.push({ key, cur, limit });
  }
  return { failures: failures.sort(byKey), tightenable: tightenable.sort(byKey) };
}

const byKey = (a: Finding, b: Finding) => a.key.localeCompare(b.key);

/** --update：每项取 min(旧, 当前)，降到默认上限以内的条目删除；永不新增、永不提高。 */
export function tighten(limits: Counts, current: Counts, skipped: Set<string>): Counts {
  const out: Counts = {};
  for (const [key, limit] of Object.entries(limits)) {
    if (isSkipped(key, skipped)) {
      out[key] = limit;
      continue;
    }
    const next = Math.min(limit, current[key] ?? 0);
    if (next > capFor(key)) out[key] = next;
  }
  return sortCounts(out);
}

/** --init：写当前实测值（只保留超过默认上限的项）；被跳过的规则沿用旧 baseline 里的条目。 */
export function initLimits(current: Counts, old: Counts, skipped: Set<string>): Counts {
  const out: Counts = {};
  for (const [key, cur] of Object.entries(current)) {
    if (!isSkipped(key, skipped) && cur > capFor(key)) out[key] = cur;
  }
  for (const [key, v] of Object.entries(old)) if (isSkipped(key, skipped)) out[key] = v;
  return sortCounts(out);
}

/** baseline 相对比较基准变大的每一项（新增 key 按默认上限算 from）。 */
export function loosenings(base: Counts, next: Counts): Raised[] {
  const out: Raised[] = [];
  for (const [key, to] of Object.entries(next)) {
    const from = limitOf(base, key);
    if (to > from) out.push({ key, from, to, why: "" });
  }
  return out;
}

const MIN_WHY = 10;

/**
 * 放宽审计：比较基准版本的 baseline（base）→ 当前 baseline，凡是变大的 key，
 * raised[] 里必须有 from 等于基准值、to 不小于当前值、why ≥10 字的条目。
 */
export function checkRaised(base: Baseline | null, cur: Baseline): string[] {
  if (!base) return [];
  const errs: string[] = [];
  for (const l of loosenings(base.limits, cur.limits)) {
    const ok = cur.raised.some(
      (r) => r.key === l.key && r.from === l.from && r.to >= l.to && [...(r.why ?? "").trim()].length >= MIN_WHY,
    );
    if (!ok) errs.push(`${l.key} ${l.from} → ${l.to}`);
  }
  return errs;
}

export function sortCounts(c: Counts): Counts {
  return Object.fromEntries(Object.entries(c).sort(([a], [b]) => a.localeCompare(b)));
}

/** baseline.json 的最小结构校验：坏文件直接失败，不能被当成「没有 baseline」。 */
export function parseBaseline(text: string): Baseline {
  const b = JSON.parse(text) as Baseline;
  if (b.version !== 1 || typeof b.limits !== "object" || !Array.isArray(b.raised)) {
    throw new Error("baseline.json 结构不对：需要 {version:1, limits:{}, raised:[]}");
  }
  for (const [k, v] of Object.entries(b.limits)) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`baseline.json limits["${k}"] 不是数字`);
  }
  return b;
}
