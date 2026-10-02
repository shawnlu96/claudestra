import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { getTask } from "../src/lib/ledger-store.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { createCleanedUp, createRetryDelay, retryCleanCreate } from "../src/lib/scheduler-create-retry.js";
import type { EnsureResult } from "../src/lib/worker-session.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const MIN = 60_000;
const CAPACITY = { ok: false, cleanedUp: true, error: "Selected model is at capacity. Please try a different model.\n（已清理：窗口已关；频道已删；占位已删）" };

const registryRow = (f: F) => (name: string): RegistryAgent | undefined => {
  const row = JSON.parse(readFileSync(f.registryPath, "utf8")).agents[name];
  return row && { name, ...row };
};
function dropAgent(f: F, name: string) {
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  delete reg.agents[name];
  writeFileSync(f.registryPath, JSON.stringify(reg));
}

/** The production shape of an ensure: one `manager create` (fake here), then the session id or unknown. */
const ensureVia = (f: F, out: () => Record<string, unknown>, calls: string[] = []) =>
  (task: LedgerTask, role: "author" | "reviewer") => retryCleanCreate({ db: f.db, registryRow: registryRow(f), create: async (...a) => { calls.push(a[1]); return out(); } },
    task, role, async (create): Promise<EnsureResult> => {
      const r = await create("create", role === "author" ? "task-t1" : "agent-rv-t1", "/tmp/x");
      return r.ok === true ? { kind: "unknown", reason: "已建，90 秒内没等到 session id" } : { kind: "unknown", reason: `建失败或结果不明：${String(r.error)}` };
    }, f.tickDeps.now);

const ensureIntents = (f: F) => f.db.query("SELECT status, receipt FROM scheduler_intents WHERE action = 'ensure_session' ORDER BY eventSeq")
  .all() as { status: string; receipt: string | null }[];

describe("i28-SC1 create failed with the scene cleared → cancelled + backoff, not unknown", () => {
  test("cleanedUp flag: only a full clear (window, channel, placeholder, no old row restored) counts", () => {
    expect(createCleanedUp({ ok: true, steps: ["窗口已关", "频道已删", "占位已删"] })).toBe(true);
    expect(createCleanedUp({ ok: true, steps: ["频道早已不在", "占位已删"] })).toBe(true);
    expect(createCleanedUp({ ok: true, steps: ["窗口已关", "频道已删", "同名旧条目已恢复"] })).toBe(false);
    expect(createCleanedUp({ ok: true, steps: ["窗口已关", "没记到频道 id：名为 #x 的频道（若有）要人工核对", "占位已删"] })).toBe(false);
    expect(createCleanedUp({ ok: true, steps: ["占位已被别的进程接手，registry 没动，只按本次的 id 收拾", "本次的频道已删"] })).toBe(false);
    expect(createCleanedUp({ ok: true, steps: [] })).toBe(false);
    expect(createCleanedUp({ ok: false, steps: ["窗口已关", "占位已删"] })).toBe(false);
  });

  test("[验收线 1+2] cancelled not unknown; backoff 2/4/8/15/15 min with no re-plan meanwhile; ≥6 flagged; then the next tick builds", async () => {
    const f = autoFixture();
    try {
      dropAgent(f, "agent-task-one");
      const real = f.tickDeps.ensure;
      let failing = true;
      const calls: string[] = [];
      const fake = ensureVia(f, () => CAPACITY, calls);
      f.tickDeps.ensure = async (task, role, family) => failing ? fake(task, role) : real(task, role, family);
      const restore = () => writeFileSync(f.registryPath, JSON.stringify({ ...JSON.parse(readFileSync(f.registryPath, "utf8")),
        agents: { ...JSON.parse(readFileSync(f.registryPath, "utf8")).agents, "agent-task-one": { runtime: "claude-code", sessionId: "s-one", cwd: f.dir } } }));
      const delays = [2, 4, 8, 15, 15, 15].map((m) => m * MIN);
      for (let i = 0; i < delays.length; i++) {
        const out = await f.tick();
        expect(out.step).toBe("waiting");
        const rows = ensureIntents(f);
        expect(rows).toHaveLength(i + 1);
        expect(rows.at(-1)!.status).toBe("cancelled");
        expect(rows.at(-1)!.receipt).toContain(`第 ${i + 1} 次`);
        expect(rows.at(-1)!.receipt).toContain("Selected model is at capacity");
        expect(rows.at(-1)!.receipt).not.toContain("已清理：");
        expect(rows.at(-1)!.receipt).toContain(`${delays[i] / MIN} 分钟后`);
        expect(rows.at(-1)!.receipt!.includes("⚠ 已连续失败")).toBe(i + 1 >= 6);
        expect(rows.some((r) => r.status === "unknown")).toBe(false);
        // During the backoff the tick does not plan the same ensure_session again.
        const held = await f.tick();
        expect(held.detail).toContain(`连续 ${i + 1} 次失败`);
        expect(held.detail).not.toContain("等 PM 核对");
        f.advance(delays[i] - 5_000);
        await f.tick();
        expect(ensureIntents(f)).toHaveLength(i + 1);
        expect(calls).toHaveLength(i + 1);
        f.advance(5_000);
      }
      failing = false;
      restore();
      expect(await f.tick()).toMatchObject({ step: "session" });
      expect(ensureIntents(f).at(-1)!.status).toBe("done");
      expect(f.notices.some((n) => n.includes("退回人工"))).toBe(false);
    } finally { f.close(); }
  });

  test("[验收线 3] no flag, flag false, or the name still in the registry → unknown for PM, as before", async () => {
    const f = autoFixture();
    try {
      const task = getTask(f.db, "T1")!;
      const no = { ok: false, error: "建频道失败（某错误）" };
      expect(await ensureVia(f, () => no)(task, "author")).toMatchObject({ kind: "unknown" });
      expect(await ensureVia(f, () => ({ ...CAPACITY, cleanedUp: false }))(task, "author")).toMatchObject({ kind: "unknown" });
      expect(await ensureVia(f, () => CAPACITY)(task, "reviewer")).toMatchObject({ kind: "unknown" }); // agent-rv-t1 still in registry
      dropAgent(f, "agent-rv-t1");
      expect(await ensureVia(f, () => CAPACITY)(task, "reviewer")).toMatchObject({ kind: "wait", reason: expect.stringContaining("reviewer agent-rv-t1 第 1 次") });

      dropAgent(f, "agent-task-one");
      f.tickDeps.ensure = async (t, role) => ensureVia(f, () => no)(t, role);
      expect((await f.tick()).step).toBe("held");
      expect(ensureIntents(f).at(-1)!.status).toBe("unknown");
      expect((await f.tick()).detail).toContain("外部结果不明，等 PM 核对");
    } finally { f.close(); }
  });

  test("[验收线 4] create succeeded but no session id within 90 s → still unknown", async () => {
    const f = autoFixture();
    try {
      dropAgent(f, "agent-task-one");
      const task = getTask(f.db, "T1")!;
      expect(await ensureVia(f, () => ({ ok: true, agent: "agent-task-t1" }))(task, "author")).toEqual({ kind: "unknown", reason: "已建，90 秒内没等到 session id" });
      f.tickDeps.ensure = async (t, role) => ensureVia(f, () => ({ ok: true }))(t, role);
      expect((await f.tick()).step).toBe("held");
      expect(ensureIntents(f).at(-1)!.status).toBe("unknown");
    } finally { f.close(); }
  });

  test("delay doubles from 2 min and caps at 15", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => createRetryDelay(n) / MIN)).toEqual([2, 4, 8, 15, 15, 15]);
  });
});
