/**
 * i28-R5a：出借 worker 的存活判定与 Codex 额度 / 登录失败（src/lib/lend-health.ts、worker-liveness.ts，lend-drive / lend-loop 接线）。
 * 根因：一次 tmux / ps 读失败被当成「窗口没了」，正在审查的 worker 被判死杀掉（ledger/reviews/i28-R5a-rootcause.md）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { workerName } from "../src/lib/lend-drive.js";
import { DOWN_REASON, MISS_GAP_MS, noteLiveness, PAUSE_FALLBACK_MS, quotaViewOf } from "../src/lib/lend-health.js";
import { advance, getMeta, getOrder, recordAsked } from "../src/lib/lend-journal.js";
import { acpHostVerdict, defaultIo, probeAcpWorker, type LivenessIo } from "../src/lib/worker-liveness.js";
import { FP, harness, polled, sha, toStarted } from "./lend-harness.js";

const W = workerName("o1");
const releases = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.op === "lease" && c.body.action === "release");

describe("i28-R5a 存活：两次否定才判死", () => {
  test("活着的 worker 连跑多轮（超过租约一半）：不判死，照常续租", async () => {
    const h = harness();
    await toStarted(h);
    for (let i = 0; i < 12; i++) { h.advanceTime(30_000); await h.tick(); }
    expect(getOrder(h.db, "o1")!.state).toBe("started");
    expect(h.log.killed).toEqual([]);
  });

  test("单次否定后恢复：不判死，否定记录清零（日志各一行）", async () => {
    const h = harness();
    await toStarted(h);
    h.liveness.set(W, "no_window");
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("started");
    h.liveness.delete(W);
    h.advanceTime(MISS_GAP_MS);
    await h.tick();
    h.liveness.set(W, "no_window");
    h.advanceTime(MISS_GAP_MS);
    await h.tick(); // 清零后这是新的第 1 次
    expect(getOrder(h.db, "o1")!.state).toBe("started");
    expect(h.log.killed).toEqual([]);
    expect(h.log.lines.filter((l) => l.includes("否定 1/2"))).toHaveLength(2);
    expect(h.log.lines.some((l) => l.includes("恢复"))).toBe(true);
  });

  test("读不到（unknown）也清零：否定、unknown、否定 不判死", async () => {
    const h = harness();
    await toStarted(h);
    for (const v of ["no_host", "unknown", "no_host"] as const) {
      h.liveness.set(W, v);
      await h.tick();
      h.advanceTime(MISS_GAP_MS);
    }
    expect(getOrder(h.db, "o1")!.state).toBe("started");
  });

  test("同一轮时间内连问两次不算两次（间隔不足 MISS_GAP_MS）", async () => {
    const h = harness();
    await toStarted(h);
    h.liveness.set(W, "no_window");
    await h.tick();
    h.advanceTime(MISS_GAP_MS - 1);
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("started");
    h.advanceTime(1);
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("stopped");
  });

  test("窗口不在 / 宿主退了：两轮后判死，两种 reason 不同，日志带 agent、session、gen，并向 A 报 stopped", async () => {
    const reasons: string[] = [];
    for (const v of ["no_window", "no_host"] as const) {
      const h = harness();
      await toStarted(h);
      h.liveness.set(W, v);
      await h.tick();
      h.advanceTime(MISS_GAP_MS);
      await h.tick();
      const row = getOrder(h.db, "o1")!;
      expect(row).toMatchObject({ state: "stopped", reason: DOWN_REASON[v] });
      reasons.push(row.reason!);
      expect(releases(h).map((c) => [c.body.reason, c.body.detail])).toEqual([["stopped", DOWN_REASON[v]]]);
      const lines = h.log.lines.filter((l) => l.includes("存活探测否定"));
      expect(lines).toHaveLength(2);
      for (const l of lines) for (const s of [`agent ${W}`, "session thr-1", "gen 1"]) expect(l).toContain(s);
    }
    expect(new Set(reasons).size).toBe(2);
  });

  test("否定记在 journal 里：服务重启（换一份 deps）后第二次否定照样判死", async () => {
    const h = harness();
    await toStarted(h);
    h.liveness.set(W, "no_host");
    await h.tick();
    expect(getMeta(h.db, `alive:o1`)).toContain("no_host");
    h.advanceTime(MISS_GAP_MS);
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("stopped");
  });

  test("换 session / leaseGen / agent 后，上一代留下的否定不算：新身份的第一次否定是 1/2（r1 P2-1）", async () => {
    const h = harness();
    await toStarted(h);
    const row = getOrder(h.db, "o1")!;
    let t = h.d.now();
    expect(noteLiveness(h.db, row, "no_host", t, h.d.log)).toBeNull();
    for (const next of [{ ...row, sessionId: "thr-new" }, { ...row, sessionId: "thr-new", leaseGen: 2 }, { ...row, sessionId: "thr-new", leaseGen: 2, agent: "agent-lend-x" }]) {
      expect(noteLiveness(h.db, next, "no_host", (t += MISS_GAP_MS), h.d.log)).toBeNull();
    }
    expect(noteLiveness(h.db, { ...row, sessionId: "thr-new", leaseGen: 2, agent: "agent-lend-x" }, "no_host", (t += MISS_GAP_MS), h.d.log)).toBe("no_host");
  });

  test("result_pending 失租：窗口已不在就不再调 kill", async () => {
    const h = harness();
    await toStarted(h);
    h.liveness.set(W, "no_window");
    const body = { v: 1, orderId: "o1", gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } };
    advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
    h.A.result = () => "throw";
    h.advanceTime(11 * 60_000);
    await h.tick();
    expect(h.log.killed).toEqual([]);
  });
});

describe("i28-R5a Codex 撞额度 / 登录失败", () => {
  test("撞额度：当轮报 stopped（reason 写额度），暂停借单（不 poll、批了的单也不领），单结束时关掉 worker 的额度卡", async () => {
    const h = harness();
    await toStarted(h);
    h.failures.set(W, { kind: "quota", askId: "ask_q", message: "You've hit your usage limit." });
    await h.tick();
    const row = getOrder(h.db, "o1")!;
    expect(row.state).toBe("stopped");
    expect(row.reason).toContain("撞了 Codex 额度");
    expect(releases(h)).toHaveLength(1);
    expect(h.log.killed).toEqual([W]);
    expect(h.log.closedAsks).toEqual([W]);
    const polls = h.calls.filter((c) => c.op === "poll").length;
    h.advanceTime(60_000);
    await h.tick();
    expect(h.calls.filter((c) => c.op === "poll").length).toBe(polls);
    expect(JSON.parse(getMeta(h.db, "status")!).blocked).toContain("暂停借单");
    h.advanceTime(PAUSE_FALLBACK_MS);
    await h.tick();
    expect(h.calls.filter((c) => c.op === "poll").length).toBe(polls + 1);
  });

  test("撞额度且读得到重置时刻：暂停到重置时刻；之后观测到额度不满就提前恢复", async () => {
    const h = harness();
    await toStarted(h);
    const t0 = h.d.now();
    h.health.quota = { observedAt: t0, full: true, resetsAt: t0 + 5 * 3600_000 };
    h.failures.set(W, { kind: "quota", askId: "ask_q", message: "limit" });
    await h.tick();
    expect(JSON.parse(getMeta(h.db, "pause:codex")!).until).toBe(t0 + 5 * 3600_000);
    h.advanceTime(2 * 3600_000);
    await h.tick();
    expect(JSON.parse(getMeta(h.db, "status")!).blocked).toContain("暂停借单");
    h.health.quota = { observedAt: h.d.now(), full: false, resetsAt: null };
    h.advanceTime(1000);
    await h.tick();
    expect(JSON.parse(getMeta(h.db, "status")!).blocked).toBeNull();
  });

  test("暂停期间已开确认 ask、owner 批了的单：不 claim", async () => {
    const h = harness({ entry: { families: { codex: 3 } } });
    await toStarted(h);
    h.failures.set(W, { kind: "quota", askId: "ask_q", message: "limit" });
    await h.tick();
    recordAsked(h.db, { orderId: "o2", peer: "team-a", fp: FP, family: "codex", preview: { ...polled("o2") } });
    h.asks.set("ask-o2", "approved");
    await h.tick();
    await h.tick();
    expect(h.calls.filter((c) => c.op === "claim" && c.body.orderId === "o2")).toEqual([]);
  });

  test("登录失败：当轮报 stopped（reason 写登录），不暂停借单", async () => {
    const h = harness();
    await toStarted(h);
    h.failures.set(W, { kind: "auth", askId: "ask_a", message: "Authentication required" });
    await h.tick();
    expect(getOrder(h.db, "o1")!.reason).toContain("没登录或登录失效");
    expect(getMeta(h.db, "pause:codex")).toBeNull();
    expect(h.log.closedAsks).toEqual([W]);
  });

  for (const kind of ["auth", "quota"] as const) {
    test(`首条派单一直被明确拒送（submit 停在 null）时撞${kind === "auth" ? "登录失败" : "额度"}：当轮就报 stopped，不再续租占位（r1 P1-3）`, async () => {
      const h = harness();
      await h.tick();
      h.asks.set("ask-o1", "approved");
      h.d.worker.send = async () => ({ ok: false, delivered: false, reason: "bridge unavailable" });
      for (let i = 0; i < 4; i++) await h.tick(); // claim → clone → start → 派单被拒
      expect(getOrder(h.db, "o1")).toMatchObject({ state: "started", submit: null });
      h.failures.set(W, { kind, askId: "ask_f", message: "x" });
      h.advanceTime(60_000);
      await h.tick();
      expect(getOrder(h.db, "o1")!.state).toBe("stopped");
      expect(h.log.killed).toEqual([W]);
      expect(h.log.closedAsks).toEqual([W]);
    });
  }

  test("首条派单一直被拒送、worker 已死：存活探测照样两轮判死（不再被派单早退绕过）", async () => {
    const h = harness();
    await h.tick();
    h.asks.set("ask-o1", "approved");
    h.d.worker.send = async () => ({ ok: false, delivered: false, reason: "bridge unavailable" });
    for (let i = 0; i < 4; i++) await h.tick();
    h.liveness.set(W, "no_host");
    await h.tick();
    h.advanceTime(MISS_GAP_MS);
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "stopped", reason: DOWN_REASON.no_host });
  });

  test("关卡失败：留着收尾，下一轮再关，关成才写收据", async () => {
    const h = harness();
    await toStarted(h);
    h.health.closeOk = false;
    h.failures.set(W, { kind: "auth", askId: "ask_a", message: "x" });
    const r = await h.tick();
    expect(r.failed.map((f) => f.error)[0]).toContain("台账忙");
    expect(h.log.receipts).toEqual([]);
    h.health.closeOk = true;
    await h.tick();
    expect(h.log.closedAsks).toEqual([W]);
    expect(h.log.receipts.map((x) => x.state)).toEqual(["stopped"]);
    expect(releases(h)).toHaveLength(1);
  });

  test("额度视图：有窗口用满且未过重置 = full，取最晚的重置时刻；未知 = null", () => {
    const w = (usedPct: number | null, resetsAtMs: number | null, resetPassed = false) => ({ id: "x", kind: "k", usedPct, resetsAtMs, resetPassed });
    expect(quotaViewOf({ status: "known", source: "live", observedAt: 5, plan: null, reason: null, windows: [w(100, 10), w(100, 20), w(40, 30)] }))
      .toEqual({ observedAt: 5, full: true, resetsAt: 20 });
    expect(quotaViewOf({ status: "known", source: "live", observedAt: 5, plan: null, reason: null, windows: [w(99, 10)] }).full).toBe(false);
    expect(quotaViewOf({ status: "unknown", source: null, observedAt: null, plan: null, reason: "x", windows: [] }).full).toBeNull();
    // 部分窗口没数：没有已知满窗时不能说「不满」（r1 P1-2）；过了重置时刻的窗口（usedPct 被置 null）不算没数
    expect(quotaViewOf({ status: "known", source: "local_cache", observedAt: 5, plan: null, reason: null, windows: [w(20, 10), w(null, 30)] }).full).toBeNull();
    expect(quotaViewOf({ status: "known", source: "local_cache", observedAt: 5, plan: null, reason: null, windows: [w(20, 10), w(null, 30, true)] }).full).toBe(false);
    expect(quotaViewOf({ status: "known", source: "local_cache", observedAt: 5, plan: null, reason: null, windows: [w(100, 10), w(null, 30)] }).full).toBe(true);
  });

  test("暂停后观测到短窗有数、周窗没数：不提前恢复，批了的单也不领（r1 P1-2）", async () => {
    const h = harness({ entry: { families: { codex: 3 } } });
    await toStarted(h);
    const t0 = h.d.now();
    h.failures.set(W, { kind: "quota", askId: "q", message: "weekly limit" });
    h.health.quota = { observedAt: t0, full: true, resetsAt: t0 + 86400_000 };
    await h.tick();
    recordAsked(h.db, { orderId: "o2", peer: "team-a", fp: FP, family: "codex", preview: { ...polled("o2") } }, h.d.now());
    h.asks.set("ask-o2", "approved");
    h.advanceTime(5000);
    h.health.quota = quotaViewOf({ status: "known", source: "local_cache", observedAt: h.d.now(), plan: null, reason: null,
      windows: [{ id: "5h", kind: "k", usedPct: 20, resetsAtMs: t0 + 3600_000, resetPassed: false },
        { id: "7d", kind: "k", usedPct: null, resetsAtMs: t0 + 86400_000, resetPassed: false }] });
    await h.tick();
    await h.tick();
    expect(JSON.parse(getMeta(h.db, "pause:codex")!).until).toBe(t0 + 86400_000);
    expect(h.calls.filter((c) => c.op === "claim" && c.body.orderId === "o2")).toEqual([]);
  });
});

describe("i28-R5a worker-liveness：读失败 = unknown，以宿主进程为准", () => {
  // 生产 / lab 实测的 pane 结构：登录 zsh（pane）→ env -i … bun acp-host.ts（宿主）→ 适配器
  const PS = ["  100     1 -zsh", "  200   100 /opt/bun --no-env-file --config=/dev/null /repo/src/acp-host.ts", "  300   200 /opt/bun /x/codex-acp/dist/index.js"].join("\n");
  test("宿主是 pane 的子进程 / pane 进程本身：running；壳里只剩别的进程：no_host；pane 不在快照：unknown", () => {
    expect(acpHostVerdict([100], PS)).toBe("running");
    expect(acpHostVerdict([200], PS)).toBe("running");
    expect(acpHostVerdict([100], "  100     1 -zsh\n  150   100 vim notes.md")).toBe("no_host");
    expect(acpHostVerdict([100], "  100     1 -zsh")).toBe("no_host");
    expect(acpHostVerdict([999], PS)).toBe("unknown");
    expect(acpHostVerdict([100], "")).toBe("unknown");
  });

  test("看窗口里所有 pane、整棵进程树（r1 P1-1）：宿主在别的 pane / 隔一层 wrapper 都算 running", () => {
    const split = `  90     1 -zsh\n${PS}`;
    expect(acpHostVerdict([90, 100], split)).toBe("running");
    expect(acpHostVerdict([90], split)).toBe("no_host");
    expect(acpHostVerdict([100], "100 1 -zsh\n150 100 /bin/sh wrapper\n160 150 bun /repo/src/acp-host.ts")).toBe("running");
    // 没找到宿主、又有 pane 不在快照里：不知道，不是 no_host
    expect(acpHostVerdict([90, 777], "  90     1 -zsh")).toBe("unknown");
  });

  const io = (over: Partial<LivenessIo>): LivenessIo => ({ windows: async () => ["master", "agent-lend-a"], panePids: async () => [100], ps: async () => PS, ...over });
  test("tmux 列窗口 / 读 pane / ps 任一失败：unknown，不是 no_window（根因：tmuxRaw 失败返回空、listWindows 当成没有窗口）", async () => {
    expect(await probeAcpWorker("agent-lend-a", io({}))).toBe("running");
    expect(await probeAcpWorker("agent-lend-a", io({ windows: async () => { throw new Error("error connecting to socket"); } }))).toBe("unknown");
    expect(await probeAcpWorker("agent-lend-a", io({ panePids: async () => { throw new Error("tmux 超时"); } }))).toBe("unknown");
    expect(await probeAcpWorker("agent-lend-a", io({ ps: async () => { throw new Error("ps exit 1"); } }))).toBe("unknown");
    expect(await probeAcpWorker("agent-lend-b", io({}))).toBe("no_window");
  });
});

describe("i28-R5a worker-liveness：真进程（pane 壳 → 宿主）", () => {
  const kids: ReturnType<typeof Bun.spawn>[] = [];
  afterEach(async () => { for (const k of kids.splice(0)) { k.kill("SIGKILL"); await k.exited; } });

  test("真 ps 快照：宿主活着 = running，宿主退了、壳还在 = no_host", async () => {
    // 外层 sh 当 pane（同生产的 -zsh，命令行里不带宿主路径，所以路径经环境变量给）；内层 perl 的参数带 /src/acp-host.ts 当宿主
    const pane = Bun.spawn(["sh", "-c", 'perl -e "sleep 30" "$HOST_SCRIPT" & wait; sleep 30'],
      { env: { ...process.env, HOST_SCRIPT: "/tmp/r5a/src/acp-host.ts" }, stdout: "ignore", stderr: "ignore" });
    kids.push(pane);
    const host = async () => (await defaultIo.ps()).split("\n").map((l) => l.trim().split(/\s+/)).find((f) => Number(f[1]) === pane.pid && f.join(" ").includes("/src/acp-host.ts"));
    for (const end = Date.now() + 5_000; Date.now() < end && !(await host()); await Bun.sleep(50));
    expect(acpHostVerdict([pane.pid], await defaultIo.ps())).toBe("running");
    process.kill(Number((await host())![0]), "SIGKILL");
    for (const end = Date.now() + 5_000; Date.now() < end && (await host()); await Bun.sleep(50));
    expect(acpHostVerdict([pane.pid], await defaultIo.ps())).toBe("no_host");
  }, 20_000);
});
