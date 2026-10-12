/**
 * QOBS2：活跃 rollout 只续读增量、读的过程中被追加仍判 unknown、文件没变时不重读也不重判。
 * 全部是临时目录里的合成 rollout；读文件走注入端口计字节与调用，不写墙钟断言。
 */
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLatestCodexQuota } from "../src/lib/codex-usage.js";
import { newestRateLimitEvent, scanRolloutQuota } from "../src/lib/quota-observation-rollout.js";
import { ROLLOUT_TAIL_CHECK_BYTES, type RolloutIo } from "../src/lib/quota-observation-rollout-index.js";

const NOW = Date.UTC(2026, 9, 11, 12);
const dirs: string[] = [];
const root = () => { const d = mkdtempSync(join(tmpdir(), "qobs2-inc-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const event = (at: number, pct: number, extra: object = {}) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg",
  payload: { type: "token_count", rate_limits: { primary: { used_percent: pct, window_minutes: 10080 }, ...extra } } }) + "\n";
const meta = (cwd: string) => JSON.stringify({ type: "session_meta", payload: { id: "synthetic", cwd } }) + "\n";
const chatter = (fill: string, n: number) => (JSON.stringify({ type: "response_item", payload: { text: fill.repeat(400) } }) + "\n").repeat(n);
const pathOf = (dir: string, n: number) => join(dir, `rollout-2026-10-11T01-00-00-00000000-0000-0000-0000-${String(n).padStart(12, "0")}.jsonl`);
const quiet = () => {};

/** 读文件端口：照常读盘，记下每次读的位置与长度；onRead 用来在读的过程中动文件 */
function countingIo(onRead?: (path: string) => void) {
  const paths = new Map<number, string>();
  const log = { opens: 0, stats: 0, bytes: 0, reads: [] as Array<{ path: string; position: number; length: number }> };
  const io: RolloutIo = {
    stat: (path) => { log.stats++; return statSync(path); },
    open: (path) => { log.opens++; const fd = openSync(path, "r"); paths.set(fd, path); return fd; },
    read: (fd, buffer, length, position) => {
      const n = readSync(fd, buffer, 0, length, position);
      log.bytes += n;
      log.reads.push({ path: paths.get(fd)!, position, length: n });
      onRead?.(paths.get(fd)!);
      return n;
    },
    close: (fd) => { paths.delete(fd); closeSync(fd); },
  };
  const reset = () => { log.opens = 0; log.stats = 0; log.bytes = 0; log.reads = []; };
  return { io, log, reset };
}

/** 同一份内容放进全新目录整读一遍：没有任何索引可用 */
async function wholeRead(body: Buffer | string, now = NOW) {
  const path = pathOf(root(), 1);
  writeFileSync(path, body);
  const { path: _path, ...value } = (await scanRolloutQuota(join(path, ".."), { now, diagnostic: quiet })).value ?? { path: "" };
  return value;
}
const strip = (value: { path: string } | null) => { const { path: _path, ...rest } = value ?? { path: "" }; return rest; };

test("[验收线 1] 追加后第二次扫描只读增量，结果与整读一致", async () => {
  const dir = root();
  const path = pathOf(dir, 1);
  writeFileSync(path, meta("/合成台账") + chatter("x", 300) + event(NOW - 5000, 10) + chatter("x", 300));
  const { io, log, reset } = countingIo();
  const options = { now: NOW, diagnostic: quiet, io };
  const size = statSync(path).size;
  const cold = await scanRolloutQuota(dir, options);
  expect(cold.value?.rateLimits.primary.used_percent).toBe(10);
  expect(log.bytes).toBe(size);

  for (const [at, pct] of [[NOW - 4000, 20], [NOW - 3000, 30]]) {
    const before = statSync(path).size;
    const added = event(at, pct);
    appendFileSync(path, added);
    reset();
    const warm = await scanRolloutQuota(dir, options);
    expect(warm).toMatchObject({ complete: true, filesRead: 1 });
    expect(warm.value).toMatchObject({ sessionId: "synthetic", cwd: "/合成台账", observedAt: at });
    // 增量加上末尾校验的那几个字节，没有一次读落在旧内容的校验窗之前
    expect(log.bytes).toBeLessThanOrEqual(Buffer.byteLength(added) + ROLLOUT_TAIL_CHECK_BYTES);
    expect(warm.bytesRead).toBe(log.bytes);
    expect(Math.min(...log.reads.map((r) => r.position))).toBeGreaterThanOrEqual(before - ROLLOUT_TAIL_CHECK_BYTES);
    expect(strip(warm.value)).toEqual(await wholeRead(readFileSync(path)));
  }
  reset();
  expect((await scanRolloutQuota(dir, options)).bytesRead).toBe(0);
  expect(log.opens).toBe(0);
});

test("[验收线 1] 末尾校验对不上时整读，结果与整读一致", async () => {
  const dir = root();
  const path = pathOf(dir, 1);
  writeFileSync(path, meta("/before") + chatter("x", 200) + event(NOW - 5000, 10));
  const { io, log, reset } = countingIo();
  const options = { now: NOW, diagnostic: quiet, io };
  await scanRolloutQuota(dir, options);
  const ino = statSync(path).ino;
  // 同一个 inode 原地改写成更长的另一份内容：只看 ino 和 size 像是追加，上次末尾那几个字节已经不是原来的
  const rewritten = meta("/after") + chatter("y", 200) + event(NOW - 6000, 77) + chatter("y", 50);
  writeFileSync(path, rewritten);
  expect(statSync(path).ino).toBe(ino);
  reset();
  const result = await scanRolloutQuota(dir, options);
  expect(result.value).toMatchObject({ cwd: "/after", observedAt: NOW - 6000 });
  expect(result.value?.rateLimits.primary.used_percent).toBe(77);
  expect(log.reads.some((r) => r.position === 0)).toBe(true);
  expect(log.bytes).toBeGreaterThanOrEqual(Buffer.byteLength(rewritten));
  expect(strip(result.value)).toEqual(await wholeRead(rewritten));
});

test("[验收线 1] 只解析完整行：半行留到下次，UTF-8 字符劈在追加边界上也不坏", async () => {
  const dir = root();
  const path = pathOf(dir, 1);
  writeFileSync(path, meta("/half") + event(NOW - 5000, 10));
  const { io, log, reset } = countingIo();
  const options = { now: NOW, diagnostic: quiet, io };
  await scanRolloutQuota(dir, options);
  const line = Buffer.from(event(NOW - 1000, 90, { plan_type: "合成套餐" }));
  const cut = line.indexOf(Buffer.from("合")) + 1; // 劈在一个三字节字符中间
  appendFileSync(path, line.subarray(0, cut));
  const half = await scanRolloutQuota(dir, options);
  expect(half.complete).toBe(true);
  expect(half.value?.rateLimits.primary.used_percent).toBe(10);
  appendFileSync(path, line.subarray(cut));
  reset();
  const whole = await scanRolloutQuota(dir, options);
  expect(whole.value?.rateLimits).toMatchObject({ plan_type: "合成套餐", primary: { used_percent: 90 } });
  expect(log.bytes).toBeLessThanOrEqual(line.length - cut + ROLLOUT_TAIL_CHECK_BYTES);
  expect(strip(whole.value)).toEqual(await wholeRead(readFileSync(path)));
});

test("[验收线 1] 读的过程中被追加仍判 unknown，下一次只补读增量", async () => {
  const dir = root();
  const path = pathOf(dir, 1);
  const quietFile = pathOf(dir, 2);
  writeFileSync(path, meta("/busy") + chatter("x", 300) + event(NOW - 5000, 10));
  writeFileSync(quietFile, meta("/quiet") + event(NOW - 9000, 5));
  const late = event(NOW - 1000, 90);
  let pending = true;
  const { io, log, reset } = countingIo((read) => {
    if (read !== path || !pending) return;
    pending = false;
    appendFileSync(path, late);
  });
  const diagnostics: string[] = [];
  const options = { now: NOW, diagnostic: (r: string) => diagnostics.push(r), io };
  const racing = await scanRolloutQuota(dir, options);
  expect(racing).toMatchObject({ complete: false, value: null, reason: "scan_changed_file" });
  expect(diagnostics).toContain("scan_changed_file");
  expect(await findLatestCodexQuota(dir, { now: NOW, diagnostic: quiet, io: countingIo(() => appendFileSync(path, "\n")).io })).toBeNull();
  const size = statSync(path).size;
  reset();
  const settled = await scanRolloutQuota(dir, options);
  expect(settled.complete).toBe(true);
  expect(settled.value).toMatchObject({ path, cwd: "/busy", observedAt: NOW - 1000 });
  // 第一次读到的那一段不再重读；安静的文件一次也不读
  expect(log.bytes).toBeLessThan(size / 10);
  expect(log.reads.every((r) => r.path === path && r.position >= size - Buffer.byteLength(late) - 2 * ROLLOUT_TAIL_CHECK_BYTES)).toBe(true);
});

test("[验收线 1] 预算中断在半个文件上、之后又被追加：从中断处续读，不回到 0", async () => {
  const dir = root();
  const path = pathOf(dir, 1);
  writeFileSync(path, meta("/budget") + event(NOW - 5000, 10) + chatter("x", 100));
  const { io, log } = countingIo();
  const first = await scanRolloutQuota(dir, { now: NOW, diagnostic: quiet, io, maxBytes: 4096 });
  expect(first).toMatchObject({ complete: false, reason: "scan_incomplete_bytes" });
  appendFileSync(path, event(NOW - 1000, 90));
  const done = await scanRolloutQuota(dir, { now: NOW, diagnostic: quiet, io });
  expect(done.value).toMatchObject({ cwd: "/budget", observedAt: NOW - 1000 });
  expect(log.reads.filter((r) => r.position === 0).length).toBe(1);
  expect(log.bytes).toBeLessThanOrEqual(statSync(path).size + ROLLOUT_TAIL_CHECK_BYTES);
});

test("[验收线 3] 约 1000 个文件 × 300 个事件：文件没变时不重读、不重判", async () => {
  const dir = root();
  const FILES = 1000;
  const EVENTS = 300;
  const stamp = (at: number) => new Date(at).toISOString();
  const line = (at: number, pct: number) => `{"timestamp":"${stamp(at)}","type":"event_msg","payload":{"type":"token_count",` +
    `"rate_limits":{"primary":{"used_percent":${pct},"window_minutes":10080}}}}\n`;
  const AHEAD = 10; // 这几个文件各带一条时间还在未来的事件
  let total = 0;
  for (let f = 0; f < FILES; f++) {
    let body = "";
    for (let e = 0; e < EVENTS - 1; e++) body += line(NOW - 86_400_000 + f * 1000 + e, e % 100);
    body += f < AHEAD ? line(NOW + 60_000 + f, 1) : line(NOW - 1000 + f, 50);
    writeFileSync(pathOf(dir, f + 1), body);
    total += Buffer.byteLength(body);
  }
  let judged = 0;
  const usable = (limits: any) => { judged++; return typeof limits?.primary?.used_percent === "number"; };
  const { io, log, reset } = countingIo();
  const options = { now: NOW, diagnostic: quiet, io };
  const cold = await scanRolloutQuota(dir, options, usable);
  expect(cold).toMatchObject({ complete: true, filesRead: FILES, bytesRead: total });
  expect(cold.value?.path).toBe(pathOf(dir, FILES));
  expect(judged).toBe(FILES * EVENTS - AHEAD);

  for (const now of [NOW, NOW + 1000]) {
    judged = 0;
    reset();
    const warm = await scanRolloutQuota(dir, { ...options, now }, usable);
    expect(warm).toMatchObject({ complete: true, filesRead: 0, bytesRead: 0 });
    expect(warm.value).toEqual(cold.value);
    expect(log.opens).toBe(0);
    expect(log.reads.length).toBe(0);
    expect(judged).toBe(0);
  }
  // 时钟越过那几条未来事件：只判它们，还是不读文件
  judged = 0;
  reset();
  const later = await scanRolloutQuota(dir, { ...options, now: NOW + 120_000 }, usable);
  expect(later.value?.path).toBe(pathOf(dir, AHEAD));
  expect(judged).toBe(AHEAD);
  expect(log.opens).toBe(0);

  // 额度入口的判定是常备的，这些文件里它的最新一条就是留着的那条：换成它来问也一个字节不读
  const quota = countingIo();
  expect((await findLatestCodexQuota(dir, { now: NOW + 120_000, diagnostic: quiet, io: quota.io }))?.path).toBe(pathOf(dir, AHEAD));
  expect(quota.log.opens).toBe(0);
}, 120_000);

test("[验收线 1] 续读后的最新一条照旧全量算法：同一时刻取文件里靠后的那条", async () => {
  const dir = root();
  const path = pathOf(dir, 1);
  writeFileSync(path, meta("/tie") + event(NOW - 1000, 10) + event(NOW + 500, 20));
  const options = { diagnostic: quiet };
  expect((await scanRolloutQuota(dir, { ...options, now: NOW })).value?.rateLimits.primary.used_percent).toBe(10);
  appendFileSync(path, event(NOW + 500, 30) + event(NOW - 1000, 40));
  for (const [now, pct] of [[NOW, 40], [NOW + 500, 30], [NOW, 40]] as const) {
    const lines = readFileSync(path, "utf8").split("\n");
    expect(newestRateLimitEvent(lines, now, quiet)?.rateLimits.primary.used_percent).toBe(pct);
    expect((await scanRolloutQuota(dir, { ...options, now })).value?.rateLimits.primary.used_percent).toBe(pct);
  }
});

test("[验收线 3] 额度入口的三问共用一趟读盘，之后一个字节也不读", async () => {
  const dir = root();
  const sec = (ms: number) => Math.floor(ms / 1000);
  const quota = (at: number, extra: object = {}) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 20, window_minutes: 300, resets_at: sec(NOW + 3_600_000) },
      ...extra } } }) + "\n";
  let total = 0;
  for (let n = 1; n <= 20; n++) {
    // 最新一条没带撞限、更早有一条撞限、再早有一条明确没撞限：三遍扫描都会走到
    const body = meta("/q" + n) + quota(NOW - 9000 - n, { rate_limit_reached_type: null }) +
      quota(NOW - 8000 - n, { rate_limit_reached_type: "rate_limit_reached" }) + chatter("x", 20) + quota(NOW - 7000 - n);
    writeFileSync(pathOf(dir, n), body);
    total += Buffer.byteLength(body);
  }
  const { io, log, reset } = countingIo();
  const first = await findLatestCodexQuota(dir, { now: NOW, diagnostic: quiet, io });
  expect(first).toMatchObject({ path: pathOf(dir, 1), observedAt: NOW - 7001, limitHeld: { observedAt: NOW - 8001 } });
  expect(log.bytes).toBe(total);
  reset();
  expect(await findLatestCodexQuota(dir, { now: NOW + 1000, diagnostic: quiet, io })).toEqual(first);
  expect(log.opens).toBe(0);
});
