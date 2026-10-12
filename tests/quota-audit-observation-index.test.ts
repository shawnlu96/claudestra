import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, unlinkSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLatestCodexQuota } from "../src/lib/codex-usage.js";
import { scanRolloutQuota } from "../src/lib/quota-observation-rollout.js";

const NOW = Date.now();
const root = () => mkdtempSync(join(tmpdir(), "qobs-index-"));
const event = (at: number, pct: number) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg",
  payload: { type: "token_count", rate_limits: { primary: { used_percent: pct, window_minutes: 10080 } } } });
function file(dir: string, n: number, body: string) {
  const path = join(dir, `rollout-2026-10-11T01-00-00-00000000-0000-0000-0000-${String(n).padStart(12, "0")}.jsonl`);
  writeFileSync(path, body + "\n");
  return path;
}

test("[验收线 1] 默认参数超过256个rollout仍找到最新观测", async () => {
  const dir = root();
  for (let n = 1; n <= 256; n++) file(dir, n, event(NOW - 86400000, 6));
  const newest = file(dir, 257, event(NOW - 1000, 90));
  expect((await findLatestCodexQuota(dir))?.path).toBe(newest);
});

test("[验收线 1] 默认参数十个4MB文件首次找到最新观测", async () => {
  const dir = root();
  const padding = JSON.stringify({ type: "response_item", payload: { text: "x".repeat(4 * 1024 * 1024) } });
  let newest = "";
  for (let n = 1; n <= 10; n++) newest = file(dir, n, padding + "\n" + event(NOW - 1000 + n, n));
  expect((await findLatestCodexQuota(dir))?.path).toBe(newest);
});

test("[验收线 1] 未变文件不重复读取，新增改写删除均更新索引", async () => {
  const dir = root();
  const older = file(dir, 1, event(NOW - 2000, 10));
  const newest = file(dir, 2, event(NOW - 1000, 90));
  expect((await scanRolloutQuota(dir, { now: NOW })).filesRead).toBe(2);
  const warm = await scanRolloutQuota(dir, { now: NOW });
  expect(warm.value?.path).toBe(newest);
  expect(warm.bytesRead).toBe(0);
  expect(warm.filesRead).toBe(0);
  appendFileSync(older, event(NOW - 500, 95) + "\n");
  const changed = await scanRolloutQuota(dir, { now: NOW });
  expect(changed.value?.path).toBe(older);
  expect(changed.filesRead).toBe(1);
  unlinkSync(older);
  expect((await scanRolloutQuota(dir, { now: NOW })).value?.path).toBe(newest);
  const added = file(dir, 3, event(NOW - 100, 80));
  expect((await scanRolloutQuota(dir, { now: NOW })).value?.path).toBe(added);
});

test("[验收线 3] 缓存每次重判时钟和usable，等长同mtime改写失效", async () => {
  const dir = root();
  const older = file(dir, 1, event(NOW - 2000, 10));
  const newer = file(dir, 2, event(NOW - 1000, 90));
  const future = file(dir, 3, event(NOW + 1000, 1));
  const options = { now: NOW, diagnostic: () => {} };
  expect((await scanRolloutQuota(dir, options)).value?.path).toBe(newer);
  expect((await scanRolloutQuota(dir, { ...options, now: NOW - 1500 })).value?.path).toBe(older);
  expect((await scanRolloutQuota(dir, { ...options, now: NOW + 1000 })).value?.path).toBe(future);
  expect((await scanRolloutQuota(dir, options, (rl: any) => rl.primary.used_percent === 10)).value?.path).toBe(older);
  const before = statSync(newer);
  writeFileSync(newer, event(NOW - 1000, 80) + "\n");
  utimesSync(newer, before.atime, before.mtime);
  const rewritten = await scanRolloutQuota(dir, options);
  expect(rewritten.value?.rateLimits.primary.used_percent).toBe(80);
  expect(rewritten.filesRead).toBe(1);
});

test("[验收线 1] 字节预算中断保留索引进度但不发布best，跨文件和单个大文件最终完整", async () => {
  for (const single of [false, true]) {
    const dir = root();
    if (single) file(dir, 1, event(NOW - 1000, 90) + "\n" + " ".repeat(8000) + "\n");
    else for (let n = 1; n <= 20; n++) file(dir, n, event(NOW - 1000 + n, n));
    const options = { now: NOW, maxBytes: 1000, diagnostic: () => {} };
    let result = await scanRolloutQuota(dir, options);
    expect(result.complete).toBe(false);
    expect(result.value).toBeNull();
    for (let n = 0; n < 20 && !result.complete; n++) result = await scanRolloutQuota(dir, options);
    expect(result.complete).toBe(true);
    expect(result.value?.rateLimits.primary.used_percent).toBe(single ? 90 : 20);
    expect((await scanRolloutQuota(dir, options)).bytesRead).toBe(0);
  }
});

test("[验收线 1] 超过默认64MB预算的归档下一次完成，后续零读取", async () => {
  const dir = root();
  const padding = JSON.stringify({ type: "response_item", payload: { text: "x".repeat(4 * 1024 * 1024) } });
  let newest = "";
  for (let n = 1; n <= 17; n++) newest = file(dir, n, padding + "\n" + event(NOW - 1000 + n, 90));
  const first = await scanRolloutQuota(dir, { now: NOW, diagnostic: () => {} });
  expect(first).toMatchObject({ complete: false, value: null, reason: "scan_incomplete_bytes" });
  expect(first.bytesRead).toBe(64 * 1024 * 1024);
  expect((await findLatestCodexQuota(dir))?.path).toBe(newest);
  const warm = await scanRolloutQuota(dir, { now: NOW });
  expect(warm.complete).toBe(true);
  expect(warm.bytesRead).toBe(0);
});

test("[验收线 1] 分块恢复保留UTF8和metadata，未完成文件改写必须重建", async () => {
  const dir = root();
  const meta = JSON.stringify({ type: "session_meta", payload: { id: "synthetic", cwd: "/合成台账" } });
  const path = file(dir, 1, meta + "\n" + event(NOW - 1000, 90));
  const options = { now: NOW, maxBytes: 1, diagnostic: () => {} };
  let result = await scanRolloutQuota(dir, options);
  expect(result.value).toBeNull();
  for (let n = 0; n < 500 && !result.complete; n++) result = await scanRolloutQuota(dir, options);
  expect(result.value).toMatchObject({ sessionId: "synthetic", cwd: "/合成台账" });
  writeFileSync(path, meta + "\n" + event(NOW - 1000, 10) + "\n");
  expect((await scanRolloutQuota(dir, options)).value).toBeNull();
  writeFileSync(path, meta + "\n" + event(NOW - 1000, 80) + "\n");
  expect((await scanRolloutQuota(dir, { now: NOW })).value?.rateLimits.primary.used_percent).toBe(80);
});
