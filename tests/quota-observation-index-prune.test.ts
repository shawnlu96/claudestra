/**
 * QOBS2：索引每个文件只留「当前已能用的最新一条」和「时间还在未来的事件」，结果与旧全量算法逐条相同。
 * 旧全量算法 = 把文件的每一行交给 newestRateLimitEvent（每次对全部事件重判时间与可用性）。合成 rollout，临时目录。
 * 「最新一条」按判定各算各的：额度入口要最新可用、最近撞限、最近明确没撞限三个事实，一个文件里它们可以是三条不同的事件。
 * 常备判定 4 种（默认 + 额度入口 3 种），临时判定最多再跟 4 种，所以每个文件未来事件之外最多留 8 条，与事件总数无关。
 */
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLatestCodexQuota } from "../src/lib/codex-usage.js";
import { newestRateLimitEvent, scanRolloutQuota } from "../src/lib/quota-observation-rollout.js";
import { rolloutIndexResidue } from "../src/lib/quota-observation-rollout-index.js";

const NOW = Date.UTC(2026, 9, 11, 12);
const MIN = 60_000;
const dirs: string[] = [];
const root = () => { const d = mkdtempSync(join(tmpdir(), "qobs2-prune-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

type Limits = { pct?: unknown; reached?: unknown };
/** at：毫秒时刻；字符串原样当 timestamp（非法时间）；null = 没有 timestamp 键 */
const event = (at: number | string | null, limits: Limits = {}) => JSON.stringify({
  ...(at === null ? {} : { timestamp: typeof at === "number" ? new Date(at).toISOString() : at }), type: "event_msg",
  payload: { type: "token_count", rate_limits: { primary: { used_percent: "pct" in limits ? limits.pct : 20, window_minutes: 10080 },
    ...("reached" in limits ? { rate_limit_reached_type: limits.reached } : {}) } } }) + "\n";
const meta = (n: number) => JSON.stringify({ type: "session_meta", payload: { id: "sid-" + n, cwd: "/synthetic/" + n } }) + "\n";
const name = (n: number) => `rollout-2026-10-11T01-00-00-00000000-0000-0000-0000-${String(n).padStart(12, "0")}.jsonl`;

const MAX_TRACKED = 8;
/** 未来事件之外，留下的条数不超过在跟的判定数（每种判定最多 1 条），在跟的判定数有固定上限 */
function expectBounded(dir: string) {
  for (const residue of rolloutIndexResidue(dir)) {
    expect(residue.kept).toBeLessThanOrEqual(residue.selectors);
    expect(residue.selectors).toBeLessThanOrEqual(MAX_TRACKED);
  }
}

const selectors = {
  any: () => true,
  numeric: (rl: any) => typeof rl?.primary?.used_percent === "number",
  reached: (rl: any) => typeof rl?.rate_limit_reached_type === "string" && rl.rate_limit_reached_type !== "",
  cleared: (rl: any) => rl?.rate_limit_reached_type === null,
  // 第五种临时判定：挤掉最久没用的那种，被挤掉的下次再问要从 0 重读，结果仍须一致
  high: (rl: any) => rl?.primary?.used_percent >= 50,
};

/** 旧全量算法：逐文件对全部行重判，文件之间严格更晚才替换（目录顺序里靠前的赢平手） */
function fullAlgorithm(dir: string, now: number, usable: (rl: unknown) => boolean) {
  const diagnostics: string[] = [];
  let best: Record<string, unknown> | null = null;
  for (const file of readdirSync(dir)) {
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    const head = JSON.parse(lines[0]).payload;
    const hit = newestRateLimitEvent(lines, now, (r) => diagnostics.push(r), usable);
    if (hit && (!best || hit.observedAt > (best.observedAt as number))) best = { ...hit, path: join(dir, file), sessionId: head.id, cwd: head.cwd };
  }
  return { value: best, diagnostics: diagnostics.sort() };
}

async function indexed(dir: string, now: number, usable: (rl: unknown) => boolean) {
  const diagnostics: string[] = [];
  const result = await scanRolloutQuota(dir, { now, diagnostic: (r) => diagnostics.push(r) }, usable);
  expect(result.complete).toBe(true);
  return { value: result.value as Record<string, unknown> | null, diagnostics: diagnostics.sort() };
}

/** 一组含过去、未来、非法时间、同刻并列、各判定可用与不可用的事件 */
const BODIES: string[][] = [
  [event(NOW - 9 * MIN, { pct: 10 }), event(NOW - 3 * MIN, { pct: 30, reached: "rate_limit_reached" }), event(NOW - 6 * MIN, { pct: 20, reached: null }),
    event(NOW + 2 * MIN, { pct: 40 }), event("not-a-time", { pct: 99 }), event(NOW + 5 * MIN, { pct: 50, reached: null })],
  [event(NOW - 3 * MIN, { pct: 31 }), event(NOW - 3 * MIN, { pct: 32 }), event(null, { pct: 98 }), event(NOW + 2 * MIN, { pct: "n/a" }),
    event(NOW + 2 * MIN, { pct: 41, reached: "workspace_owner_usage_limit_reached" }), event("1970-01-01T00:00:00.000Z", { pct: 97 })],
  [event(NOW + 8 * MIN, { pct: 60 }), event(NOW + 4 * MIN, { pct: 61, reached: "" }), event(NOW + 4 * MIN, { pct: "n/a", reached: null })],
  [event(NOW - 20 * MIN, { pct: "n/a" }), event("", { pct: 96 })],
  [],
];
const CLOCKS = [NOW, NOW + MIN, NOW + 2 * MIN, NOW + 3 * MIN, NOW - 4 * MIN, NOW - 30 * MIN, NOW + 4 * MIN, NOW + 5 * MIN,
  NOW - MIN, NOW + 9 * MIN, NOW + 9 * MIN, NOW];

test("[验收线 2] 过去、未来、非法时间事件在多个 now 下：裁剪后的索引与旧全量算法逐条相同", async () => {
  for (const [key, usable] of Object.entries(selectors)) {
    const all = root();
    const singles = BODIES.map(() => root());
    BODIES.forEach((body, i) => {
      for (const dir of [all, singles[i]]) writeFileSync(join(dir, name(i + 1)), meta(i + 1) + body.join(""));
    });
    for (const now of CLOCKS) {
      for (const dir of [all, ...singles]) {
        expect({ key, now: now - NOW, ...(await indexed(dir, now, usable)) }).toEqual({ key, now: now - NOW, ...fullAlgorithm(dir, now, usable) });
      }
      // 常驻事件数有上界：未来事件之外每种判定最多 1 条，未来的那些一条不多留
      for (const [i, dir] of singles.entries()) {
        expectBounded(dir);
        const ahead = BODIES[i].filter((line) => Date.parse(JSON.parse(line).timestamp) > now).length;
        expect(rolloutIndexResidue(dir)[0].future).toBeLessThanOrEqual(ahead);
      }
      expectBounded(all);
    }
  }
});

test("[验收线 2] 一个文件里上千条过去的事件：每种判定只剩 1 条，未来的随时钟越过逐条并掉", async () => {
  const dir = root();
  let body = meta(1);
  for (let n = 0; n < 2000; n++) body += event(NOW - 2000 * MIN + n * MIN, { pct: n % 100, ...(n % 7 ? {} : { reached: n % 2 ? null : "rate_limit_reached" }) });
  body += event(NOW + MIN, { pct: 1 }) + event(NOW + 2 * MIN, { pct: 2 }) + event("bad", { pct: 3 });
  writeFileSync(join(dir, name(1)), body);
  const residue = () => { expectBounded(dir); return rolloutIndexResidue(dir).map((r) => r.future); };
  for (const [key, usable] of Object.entries(selectors)) {
    expect({ key, ...(await indexed(dir, NOW, usable)) }).toEqual({ key, ...fullAlgorithm(dir, NOW, usable) });
  }
  expect((await indexed(dir, NOW, selectors.any)).value?.observedAt).toBe(NOW - MIN);
  expect(residue()).toEqual([2]);
  expect((await indexed(dir, NOW + MIN, selectors.any)).value?.observedAt).toBe(NOW + MIN);
  expect(residue()).toEqual([1]);
  expect(await indexed(dir, NOW + 3 * MIN, selectors.any)).toEqual(fullAlgorithm(dir, NOW + 3 * MIN, selectors.any));
  expect(residue()).toEqual([0]);
});

/** 固定种子的伪随机：时刻取自很小的集合，逼出同刻并列、时钟回拨、追加与晋升交错 */
function lcg(seed: number) {
  let s = seed >>> 0;
  return (n: number) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return Math.floor((s / 2 ** 32) * n); };
}

test("[验收线 2] 追加、时钟前后跳、多种判定交错：每一步都与旧全量算法逐条相同", async () => {
  const keys = Object.keys(selectors) as Array<keyof typeof selectors>;
  for (let seed = 1; seed <= 12; seed++) {
    const pick = lcg(seed);
    const dir = root();
    const times = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4].map((k) => NOW + k * MIN);
    const random = () => {
      const at = pick(10) === 0 ? ["bad", null, ""][pick(3)] : times[pick(times.length)];
      const limits: Limits = { pct: pick(6) === 0 ? "n/a" : pick(100) };
      if (pick(3) === 0) limits.reached = [null, "rate_limit_reached", ""][pick(3)];
      return event(at, limits);
    };
    const files = 1 + pick(4);
    for (let f = 1; f <= files; f++) writeFileSync(join(dir, name(f)), meta(f) + Array.from({ length: pick(8) }, random).join(""));
    for (let step = 0; step < 40; step++) {
      if (pick(3) === 0) appendFileSync(join(dir, name(1 + pick(files))), Array.from({ length: 1 + pick(3) }, random).join(""));
      const now = NOW + (pick(12) - 6) * MIN;
      const key = keys[pick(keys.length)];
      expect({ seed, step, key, ...(await indexed(dir, now, selectors[key])) }).toEqual({ seed, step, key, ...fullAlgorithm(dir, now, selectors[key]) });
      expectBounded(dir);
    }
  }
});

test("[验收线 2] 额度入口的结果：续读、裁剪过的索引与全新整读相同", async () => {
  const sec = (ms: number) => Math.floor(ms / 1000);
  const quota = (at: number, extra: object = {}) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 20, window_minutes: 300, resets_at: sec(NOW + 60 * MIN) },
      secondary: { used_percent: 40, window_minutes: 10080, resets_at: sec(NOW + 600 * MIN) }, ...extra } } }) + "\n";
  const dir = root();
  const a = join(dir, name(1));
  const b = join(dir, name(2));
  writeFileSync(a, meta(1) + quota(NOW - 9 * MIN, { rate_limit_reached_type: "rate_limit_reached" }) + quota(NOW - 8 * MIN));
  writeFileSync(b, meta(2) + quota(NOW - 7 * MIN));
  const steps: Array<[string, string, number]> = [
    [b, "", NOW], [b, quota(NOW - 6 * MIN), NOW], [a, quota(NOW - 5 * MIN, { rate_limit_reached_type: null }), NOW],
    [b, quota(NOW + 2 * MIN, { rate_limit_reached_type: "workspace_member_usage_limit_reached" }) + quota(NOW - 4 * MIN), NOW],
    [a, "", NOW + 3 * MIN], [a, quota(NOW + 2 * MIN), NOW - 6 * MIN - 1], [a, "", NOW + 3 * MIN],
  ];
  for (const [path, added, now] of steps) {
    if (added) appendFileSync(path, added);
    const fresh = root();
    cpSync(dir, fresh, { recursive: true });
    const warm = await findLatestCodexQuota(dir, { now, diagnostic: () => {} });
    const cold = await findLatestCodexQuota(fresh, { now, diagnostic: () => {} });
    expect(warm).not.toBeNull();
    expect({ ...warm, path: warm!.path.replace(dir, fresh) }).toEqual(cold!);
    expectBounded(dir);
  }
});
