import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLatestCodexQuota } from "../src/lib/codex-usage.js";
import { parseUsageCache, readUsageCacheStale } from "../src/lib/usage-cache.js";
import { readInventoryQuota } from "../src/lib/ai-quota.js";
import { remoteViewOf } from "../src/lib/quota-scheduler.js";
import { emptyQuotaState, type QuotaState } from "../src/lib/quota-state.js";
import { newestRateLimitEvent, scanRolloutQuota } from "../src/lib/quota-observation-rollout.js";
import { observationTime } from "../src/lib/quota-observation.js";
import { mergeManualObservation } from "../src/lib/quota-observation-cache.js";
import { selectQuotaLayers } from "../src/lib/quota-layers.js";

const NOW = Date.now();
const DAY = 86400_000;
const temp = () => mkdtempSync(join(tmpdir(), "qobs-"));
const event = (at: number, pct: number) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg",
  payload: { type: "token_count", rate_limits: { primary: { used_percent: pct, window_minutes: 10080 } } } });

function rollout(root: string, n: number, body: string, mtime = NOW - n * 1000) {
  const id = `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const path = join(root, `rollout-2026-10-11T01-00-00-${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id, cwd: "/synthetic" } }) + "\n" + body + "\n");
  utimesSync(path, mtime / 1000, mtime / 1000);
  return path;
}

test("[验收线 1] 七线程前六观测旧或空，第七真正最新90", async () => {
  for (const empty of [false, true]) {
    const root = temp();
    for (let i = 1; i <= 6; i++) rollout(root, i, empty ? "" : event(NOW - DAY, 6));
    const seventh = rollout(root, 7, event(NOW - 100, 90));
    expect((await findLatestCodexQuota(root))?.path).toBe(seventh);
  }
});

const seed = () => ({ sessionPct: 90, weekPct: 90, sessionResets: (NOW + DAY) / 1000, weekResets: (NOW + 7 * DAY) / 1000,
  scrapedAt: NOW - DAY, sessionObservedAt: NOW - DAY, weekObservedAt: NOW - DAY });

async function writeStatus(root: string, payload: unknown) {
  const p = Bun.spawn(["bash", join(import.meta.dir, "../scripts/usage-cache-write.sh")], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)), env: { ...process.env, CLAUDESTRA_STATE_DIR: root },
    stdout: "pipe", stderr: "pipe",
  });
  expect(await p.exited).toBe(0);
  expect(await new Response(p.stdout).text()).toBe("");
}

function state(at: number, pct: number): QuotaState {
  const s = emptyQuotaState();
  s.current.claude = "synthetic";
  s.accounts.synthetic = { provider: "claude", identity: "bound", uncertain: false, rateLimitedUntil: null,
    lastSeenAt: at, health: {}, snapshots: { claude_usage: { observedAt: at, data: { resets: null,
      windows: [{ id: "7d", kind: "weekly", usedPct: pct, resetsAtMs: NOW + 7 * DAY,
        windowMinutes: 10080, severity: null, scopeModel: null }] } } } };
  return s;
}

const inventory = (s: QuotaState, cache: ReturnType<typeof readUsageCacheStale>, now = NOW) => readInventoryQuota({
  now, enabled: () => true, loadState: async () => s, claudeCache: () => cache, codexRollout: async () => null,
});

test("[验收线 2] 真脚本 context-only 保留额度及观测时间，Inventory 不伪新压接口10", async () => {
  const root = temp();
  const path = join(root, "usage-cache.json");
  writeFileSync(path, JSON.stringify(seed()));
  await writeStatus(root, { session_id: "synthetic", context_window: { context_window_size: 200000, used_percentage: 12 } });
  const raw = JSON.parse(readFileSync(path, "utf8"));
  expect(raw).toMatchObject(seed());
  expect(raw.contextUpdatedAt).toBeGreaterThan(NOW - 1000);
  expect(raw.sessions.synthetic.ts).toBe(raw.contextUpdatedAt);
  const q = await inventory(state(NOW - 3 * 3600_000, 10), readUsageCacheStale(Date.now(), path, null), Date.now());
  expect(q.claude.source).toBe("live_stale");
  expect(q.claude.windows[0]?.usedPct).toBe(10);
});

test("[验收线 2] session-only/week-only 更新各自时刻，另一窗原样", async () => {
  for (const slot of ["five_hour", "seven_day"]) {
    const root = temp();
    const path = join(root, "usage-cache.json");
    writeFileSync(path, JSON.stringify(seed()));
    await writeStatus(root, { rate_limits: { [slot]: { used_percentage: 95,
      resets_at: slot === "five_hour" ? seed().sessionResets : seed().weekResets } } });
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const updated = slot === "five_hour" ? "sessionObservedAt" : "weekObservedAt";
    const untouched = slot === "five_hour" ? "weekObservedAt" : "sessionObservedAt";
    expect(raw[updated]).toBeGreaterThan(NOW - 1000);
    expect(raw[untouched]).toBe(NOW - DAY);
  }
});

test("[验收线 3] 未来低快照不 live、不压正常本机90，保留诊断", async () => {
  const remote = remoteViewOf(state(NOW + DAY, 1), NOW, true);
  expect(remote.claude.endpoints.claude_usage?.stale).toBe(true);
  const c = parseUsageCache(JSON.stringify({ ...seed(), scrapedAt: NOW - 1000,
    sessionObservedAt: NOW - 1000, weekObservedAt: NOW - 1000 }), NOW)!;
  const q = await inventory(state(NOW + DAY, 1), c);
  expect(q.claude.source).toBe("local_cache");
  expect(q.claude.windows[1]?.usedPct).toBe(90);
});

test("[验收线 3] 未来rollout跳过，不能挡住当前正常观测", async () => {
  const root = temp();
  const normal = rollout(root, 1, event(NOW - 1000, 90));
  rollout(root, 2, event(NOW + DAY, 1), NOW + DAY);
  expect((await findLatestCodexQuota(root))?.path).toBe(normal);
});

test("[验收线 1] 文件、目录项、字节预算耗尽时不发布旧best", async () => {
  const root = temp();
  const first = rollout(root, 1, event(NOW - DAY, 6));
  for (let i = 2; i <= 30; i++) rollout(root, i, event(NOW - 1000 + i, 90));
  for (const budget of [{ maxFiles: 6 }, { maxEntries: 10 },
    { maxBytes: Buffer.byteLength(readFileSync(first)) + 1 }]) {
    const diagnostics: string[] = [];
    const result = await scanRolloutQuota(root, { now: NOW, ...budget, diagnostic: (r) => diagnostics.push(r) });
    expect(result.complete).toBe(false);
    expect(result.value).toBeNull();
    expect(result.reason).toStartWith("scan_incomplete");
    expect(diagnostics).toContain(result.reason!);
    expect(await findLatestCodexQuota(root, { now: NOW, ...budget, diagnostic: () => {} })).toBeNull();
  }
});

test("[验收线 1] 观测在旧2MB尾窗之外、mtime不可信仍找到真正最新", async () => {
  const root = temp();
  rollout(root, 1, event(NOW - DAY, 6));
  const latest = rollout(root, 2, event(NOW - 1000, 90) + "\n" +
    JSON.stringify({ type: "response_item", payload: { text: "x".repeat(2 * 1024 * 1024 + 100) } }), NOW - 2 * DAY);
  expect((await findLatestCodexQuota(root, { now: NOW }))?.path).toBe(latest);
});

test("[验收线 2] 局部更新的时间资格一路保留，整份比较不借另一窗时间", async () => {
  const path = join(temp(), "usage-cache.json");
  writeFileSync(path, JSON.stringify({ ...seed(), sessionObservedAt: NOW - 1000, scrapedAt: NOW - 1000 }));
  const cache = readUsageCacheStale(NOW, path, null)!;
  expect(cache.scrapedAt).toBe(NOW - DAY);
  const local = selectQuotaLayers({ now: NOW, enabled: false, remote: null, local: { claudeCache: cache, codexRollout: null } }).providers[0]!;
  expect(local.meters.map((m) => m.observedAt)).toEqual([NOW - 1000, NOW - DAY]);
  expect(local.account).toEqual({ key: null, identity: "unknown" });
  const result = await inventory(state(NOW - 3 * 3600_000, 10), cache);
  expect(result.claude.source).toBe("live_stale");
  const standalone = await inventory(emptyQuotaState(), cache);
  expect(standalone.claude.windows.map((w) => w.observedAt)).toEqual([NOW - 1000, NOW - DAY]);
});

test("[验收线 2] 被单调规则拒绝的值保留旧时间，旧格式迁移只保留原时间下界", async () => {
  const root = temp();
  const path = join(root, "usage-cache.json");
  const old = seed();
  writeFileSync(path, JSON.stringify(old));
  await writeStatus(root, { rate_limits: { five_hour: { used_percentage: 10, resets_at: old.sessionResets } } });
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject(old);
  const { sessionObservedAt, weekObservedAt, ...legacy } = old;
  writeFileSync(path, JSON.stringify(legacy));
  await writeStatus(root, { session_id: "synthetic", context_window: { context_window_size: 200000 } });
  const c = readUsageCacheStale(Date.now(), path, null)!;
  expect(c.sessionObservedAt).toBe(sessionObservedAt);
  expect(c.weekObservedAt).toBe(weekObservedAt);
  expect(c.sessionObservationQualification).toBe("legacy_lower_bound");
  expect(c.weekObservationQualification).toBe("legacy_lower_bound");
});

test("[验收线 2] 手工读数独立比较窗口，缺窗不刷新旧窗", () => {
  const c = parseUsageCache(JSON.stringify({ ...seed(), sessionObservedAt: NOW - 1000 }), NOW, Infinity)!;
  const m = { sessionPct: null, weekPct: 10, sessionResets: "", weekResets: "", scrapedAt: NOW - 3600_000,
    totalCost: null, apiDuration: null };
  const result = mergeManualObservation(c, m, NOW)!;
  expect(result.sessionPct).toBe(90);
  expect(result.sessionObservedAt).toBe(NOW - 1000);
  expect(result.weekPct).toBe(10);
  expect(result.weekObservedAt).toBe(m.scrapedAt);
  expect(result.scrapedAt).toBe(m.scrapedAt);
  expect(mergeManualObservation(c, { ...m, scrapedAt: NOW + DAY }, NOW)).toEqual(c);
});

test("[验收线 3] 非法观测和时钟回拨不成为有效事实，保留诊断", async () => {
  for (const at of [NaN, Infinity, -1, 0, "today", null]) {
    expect(observationTime(at, NOW)).toMatchObject({ eligible: false, qualification: "invalid" });
    const s = state(at as number, 1);
    expect(remoteViewOf(s, NOW, true).claude.endpoints.claude_usage?.observationQualification).toBe("invalid");
    const q = await inventory(s, parseUsageCache(JSON.stringify(seed()), NOW, Infinity)!);
    expect(q.claude.source).toBe("local_cache");
    expect(q.claude.windows[1]?.usedPct).toBe(90);
  }
  const c = parseUsageCache(JSON.stringify({ ...seed(), sessionObservedAt: NOW + DAY, weekObservedAt: null }), NOW, Infinity)!;
  expect(c.sessionObservationQualification).toBe("future");
  expect(c.weekObservationQualification).toBe("invalid");
  const q = await inventory(emptyQuotaState(), c);
  expect(q.claude.status).toBe("unknown");
  expect(q.claude.observedAt).toBeNull();
  expect(q.claude.reason).toBe("observation_future");
  expect(q.claude.windows.every((w) => w.usedPct === null)).toBe(true);
  const root = temp();
  const path = join(root, "usage-cache.json");
  writeFileSync(path, JSON.stringify({ ...seed(), sessionObservedAt: NOW + DAY, weekObservedAt: NOW + DAY }));
  await writeStatus(root, { rate_limits: { five_hour: { used_percentage: 95, resets_at: seed().sessionResets } } });
  expect(JSON.parse(readFileSync(path, "utf8")).sessionObservedAt).toBe(NOW + DAY);
  expect((await inventory(emptyQuotaState(), readUsageCacheStale(Date.now(), path, null), Date.now())).claude.status).toBe("unknown");
});

test("[验收线 3] 同文件时间回拨、未来、非法记录不挡当前最新有效观测", () => {
  const diagnostics: string[] = [];
  const invalid = JSON.stringify({ timestamp: "not-a-date", type: "event_msg",
    payload: { type: "token_count", rate_limits: { primary: { used_percent: 0 } } } });
  const hit = newestRateLimitEvent([event(NOW - 1000, 90), event(NOW - DAY, 1), event(NOW + DAY, 0), invalid], NOW,
    (r) => diagnostics.push(r));
  expect(hit?.observedAt).toBe(NOW - 1000);
  expect(hit?.rateLimits.primary.used_percent).toBe(90);
  expect(diagnostics).toEqual(["observation_future", "observation_invalid"]);
});

test("[验收线 3] 注入的未来未绑定rollout在选层和Inventory中无资格", async () => {
  const rollout = { source: "codex-rollout" as const, plan: "synthetic", credits: null, limitReached: null,
    observedAt: NOW + DAY, sessionId: "synthetic", cwd: null, agent: null,
    windows: [{ id: "7d", windowMinutes: 10080, pct: 1, resets: "", resetsAtMs: NOW + 7 * DAY, resetPassed: false }] };
  const local = selectQuotaLayers({ now: NOW, enabled: false, remote: null,
    local: { claudeCache: null, codexRollout: rollout } }).providers[0]!;
  expect(local.account).toEqual({ key: null, identity: "unknown" });
  expect(local.source.observedAt).toBeNull();
  expect(local.source.reason).toBe("observation_future");
  expect(local.meters[0]?.used).toBeNull();
  const q = await readInventoryQuota({ now: NOW, enabled: () => false, loadState: async () => emptyQuotaState(),
    claudeCache: () => null, codexRollout: async () => rollout });
  expect(q.codex.status).toBe("unknown");
  expect(q.codex.windows[0]?.observationQualification).toBe("future");
});
