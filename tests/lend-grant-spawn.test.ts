/**
 * i28-W1 r3 验收线 1（规格「PM 已定（10-01 16:30）」）：起出借 worker 与收回授权两边都先写自己的、再读对方的（src/lib/lend-grant-spawn.ts）。
 * 用可注入的步骤把两边所有交错都走一遍：每种结果都是收回返回之后没有活着的出借 worker；任意一边不做，就有交错漏掉。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LendEntry } from "../src/lib/lend-config.js";
import { isCreateProcess, LEND_ORDER_ENV, lendCreateDenied, stopRevokedWorkers, type StopIo } from "../src/lib/lend-grant-spawn.js";
import { advance, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import type { WorkerLiveness } from "../src/lib/worker-liveness.js";

const W = "agent-lend-x";
const FP = "abcd-ef01-2345-6789";
const GRANT: LendEntry = { peer: "a", fp: FP, families: { codex: 1 }, roles: ["review"], repos: ["o/r"], ordersPerDay: 5,
  grantedAt: new Date(0).toISOString(), until: new Date(6 * 86_400_000).toISOString() };

/** 一张已领、已 clone、已记 worker 名的单（出借服务调 manager create 时 journal 就是这样） */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lend-spawn-"));
  const f = { journal: join(dir, "journal.sqlite"), lendPath: join(dir, "lend.json"), now: 1 };
  const grant = (lend: LendEntry[], enabled = true) => writeFileSync(f.lendPath, JSON.stringify({ version: 2, enabled, lend, borrow: [] }));
  grant([GRANT]);
  const db = openLendJournal(f.journal);
  recordAsked(db, { orderId: "o1", peer: "a", fp: FP, family: "codex", preview: { repo: "o/r", step: "review" } }, 0);
  advance(db, "o1", "asked", "claimed", { leaseUntil: 9e15, leaseGen: 1 });
  advance(db, "o1", "claimed", "cloned", { dir: "/w" });
  patchOrder(db, "o1", ["cloned"], { agent: W });
  db.close();
  return { f, grant, gate: (env: Record<string, string> = { [LEND_ORDER_ENV]: "o1" }, name = W) => lendCreateDenied(name, { ...f, env }) };
}

describe("manager create 起窗口前的核对（lendCreateDenied）", () => {
  test("授权在、订单号对得上：起；不是出借 worker：不管", () => {
    const { gate } = fixture();
    expect(gate()).toBeNull();
    expect(gate({}, "agent-plain")).toBeNull();
  });

  test("没带订单号、订单号不是这个名字登记的那张、授权收回 / 关掉 / 范围收窄：都不起", () => {
    const { gate, grant } = fixture();
    expect(gate({})).toMatch(/只能由出借服务带订单号起/);
    expect(gate({ [LEND_ORDER_ENV]: "o2" })).toMatch(/登记的是单 o1，不是 o2/);
    grant([{ ...GRANT, repos: ["x/y"] }]);
    expect(gate()).toMatch(/出借 worker 不起：.*仓库/);
    grant([GRANT], false);
    expect(gate()).toMatch(/已收回/);
    grant([]);
    expect(gate()).toMatch(/已收回/);
  });
});

/**
 * 一个小世界：registry、tmux 窗口、manager create 进程。create 三步（W1 登记占位 → R1 现核授权 → S 起窗口并提交），
 * 收回两步（W2 写 lend.json → R2 读登记当场停）。create 进程收到 SIGTERM 的处理照 create-guard.ts abortCreate：没提交就撤占位和窗口、退出。
 */
function world(opts: { createGate: boolean; revokeStop: boolean }) {
  const { f, grant, gate } = fixture();
  const registry = new Map<string, { status: string; pid?: number }>();
  const windows = new Set<string>();
  const proc = { pid: 4242, alive: true, committed: false, denied: null as string | null };
  const io: StopIo = {
    workers: async () => [...registry].map(([name, a]) => ({ name, createPid: a.pid })),
    stopReason: (name) => fixtureStop(name),
    isCreate: (pid, name) => pid === proc.pid && proc.alive && name === W,
    signal: () => {
      if (!proc.committed) { registry.delete(W); windows.delete(W); }
      proc.alive = false;
    },
    killWindows: async (name) => void windows.delete(name),
    probe: async (name): Promise<WorkerLiveness> => (windows.has(name) ? "running" : "no_window"),
    markStopped: async (name) => { const a = registry.get(name); if (a?.status === "active") a.status = "stopped"; },
    sleep: async () => {},
  };
  const fixtureStop = (name: string) => gate({ [LEND_ORDER_ENV]: "o1" }, name);
  const steps: Record<string, () => Promise<void>> = {
    W1: async () => void registry.set(W, { status: "creating", pid: proc.pid }),
    R1: async () => {
      if (!proc.alive || !opts.createGate) return;
      proc.denied = gate();
      if (proc.denied) { registry.delete(W); proc.alive = false; }
    },
    S: async () => {
      if (!proc.alive) return;
      windows.add(W);
      registry.set(W, { status: "active" });
      proc.committed = true;
      proc.alive = false; // create 跑完退出，worker 留在窗口里
    },
    W2: async () => grant([]),
    R2: async () => { if (opts.revokeStop) await stopRevokedWorkers(io); },
  };
  return { steps, windows, registry, proc };
}

/** 两条序列（create W1→R1→S，收回 W2→R2）保持各自先后的全部交错：C(5,2) = 10 种 */
function interleavings(a: string[], b: string[]): string[][] {
  if (!a.length) return [b];
  if (!b.length) return [a];
  return [...interleavings(a.slice(1), b).map((x) => [a[0], ...x]), ...interleavings(a, b.slice(1)).map((x) => [b[0], ...x])];
}

const ORDERS = interleavings(["W1", "R1", "S"], ["W2", "R2"]);

async function run(order: string[], opts = { createGate: true, revokeStop: true }) {
  const w = world(opts);
  for (const s of order) await w.steps[s]();
  return w;
}

describe("两边先写自己的、再读对方的：所有交错下收回返回后都没有活着的出借 worker", () => {
  test("覆盖规格要求的四种读写顺序（R1 在 W2 前 / 后 × R2 在 W1 前 / 后），连同起窗口落在哪一步，共 10 种", () => {
    expect(ORDERS).toHaveLength(10);
    const key = (o: string[]) => `${o.indexOf("R1") < o.indexOf("W2") ? "R1<W2" : "W2<R1"} ${o.indexOf("R2") < o.indexOf("W1") ? "R2<W1" : "W1<R2"}`;
    expect(new Set(ORDERS.map(key))).toEqual(new Set(["R1<W2 W1<R2", "W2<R1 W1<R2", "W2<R1 R2<W1"])); // R1<W2 且 R2<W1 自相矛盾，不可能出现
  });

  for (const order of ORDERS) {
    test(order.join(" → "), async () => {
      const w = await run(order);
      expect(w.windows.has(W)).toBe(false);
      expect(w.registry.get(W)?.status ?? "gone").not.toBe("active");
      // 至少一方看见了另一方：要么 create 自己拦下，要么收回停掉了它（或在它起窗口前发了信号）
      expect(!!w.proc.denied || !w.proc.committed || !w.windows.has(W)).toBe(true);
    });
  }

  test("反例：只做收回一侧（create 不核）→ 收回先读完登记、create 后登记的交错里 worker 活着", async () => {
    const left = [];
    for (const o of ORDERS) if ((await run(o, { createGate: false, revokeStop: true })).windows.has(W)) left.push(o.join(" "));
    expect(left).toEqual(["W2 R2 W1 R1 S"]);
  });

  test("反例：只做起 worker 一侧（收回不当场停）→ create 先核过授权的交错里 worker 活着，要等下个 pass", async () => {
    const left = [];
    for (const o of ORDERS) if ((await run(o, { createGate: true, revokeStop: false })).windows.has(W)) left.push(o.join(" "));
    expect(left).toEqual(["W1 R1 S W2 R2", "W1 R1 W2 S R2", "W1 R1 W2 R2 S"]);
  });
});

describe("stopRevokedWorkers 细节", () => {
  function fakeIo(over: Partial<StopIo> & { live?: Set<number>; windows?: Set<string> } = {}) {
    const live = over.live ?? new Set<number>();
    const windows = over.windows ?? new Set<string>();
    const log: string[] = [];
    const io: StopIo = {
      workers: async () => [],
      stopReason: () => "收回",
      isCreate: (pid) => live.has(pid),
      signal: (pid, sig) => void log.push(`${sig} ${pid}`),
      killWindows: async (n) => { log.push(`kill ${n}`); windows.delete(n); },
      probe: async (n) => (windows.has(n) ? "running" : "no_window"),
      markStopped: async (n) => void log.push(`stopped ${n}`),
      sleep: async () => {},
      ...over,
    };
    return { io, log, live, windows };
  }

  test("授权仍覆盖的不动；在途 create 不理 SIGTERM 就 SIGKILL，再关窗口确认", async () => {
    const t = fakeIo({ workers: async () => [{ name: "agent-lend-a", createPid: 7 }, { name: "agent-lend-b" }], live: new Set([7]),
      stopReason: (n) => (n === "agent-lend-a" ? "收回" : null) });
    t.io.signal = (pid, sig) => { t.log.push(`${sig} ${pid}`); if (sig === "SIGKILL") t.live.delete(pid); };
    expect(await stopRevokedWorkers(t.io)).toEqual({ stopped: ["agent-lend-a"], unconfirmed: [] });
    expect(t.log).toEqual(["SIGTERM 7", "SIGKILL 7", "kill agent-lend-a", "stopped agent-lend-a"]);
  });

  test("pid 已不是这次 create（退出 / 被复用）：不发信号，只按名字关窗口；关不掉、读不到 tmux 都报没确认", async () => {
    const t = fakeIo({ workers: async () => [{ name: "agent-lend-a", createPid: 9 }, { name: "agent-lend-b" }] });
    t.io.killWindows = async (n) => void t.log.push(`kill ${n}`);
    t.io.probe = async (n): Promise<WorkerLiveness> => (n === "agent-lend-a" ? "running" : "unknown");
    const r = await stopRevokedWorkers(t.io);
    expect(t.log).toEqual(["kill agent-lend-a", "kill agent-lend-b"]);
    expect(r.stopped).toEqual([]);
    expect(r.unconfirmed.map((u) => u.why)).toEqual(["关窗口之后窗口还在", "读不到 tmux，没法确认已退出"]);
  });
});

describe("isCreateProcess：只认给这个名字跑的 manager create", () => {
  test("命令行对得上才算；名字不对、进程已退出都不算", async () => {
    const p = Bun.spawn(["sh", "-c", "sleep 30; :", "bun", "/x/src/manager.ts", "create", W, "/w"]);
    try {
      await Bun.sleep(100); // sh 的 argv 原样进 ps 命令行：形状同 runManagerProcess 起的 bun …/manager.ts create <name> <dir>
      expect(isCreateProcess(p.pid, W)).toBe(true);
      expect(isCreateProcess(p.pid, "agent-lend-other")).toBe(false);
    } finally { p.kill(); await p.exited; }
    expect(isCreateProcess(p.pid, W)).toBe(false);
    expect(isCreateProcess(0, W)).toBe(false);
  });
});
