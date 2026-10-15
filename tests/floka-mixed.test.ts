/**
 * rename-floka-MIX1：三机混版本与回滚的隔离验收矩阵。全部在 /tmp 下新建的目录里：三台临时实例（真实状态 / runtime 迁移库、
 * 假的单写者服务控制器）、本机回环上的真中心与三个真中继客户端。不读写真实状态目录，不连真实中心或 peer。
 * 用 /tmp 而不是 $TMPDIR：macOS 的 $TMPDIR 很长，会被事务日志的凭据遮蔽误认成密钥，STATE 迁移因此拒绝。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitRun, NOT_COVERED, parseRollout, rolloutPlan, rolloutSteps, upgradeOrders, CUT_PARTS } from "../scripts/rename-floka/mixed/rollout.ts";
import { cardMerges, preflight, PRIOR_CARDS, DAEMONS } from "../scripts/rename-floka/mixed/preflight.ts";
import { closeWorld, MACHINES, rollbackCenter, rollbackMachine, runOrder, checkpoint, createWorld, type World } from "../scripts/rename-floka/mixed/matrix.ts";
import { addTask, dataRoot, launchMcp, layoutOf, OLD_SESSION, pushRows, serversSeen, tasks } from "../scripts/rename-floka/mixed/instance.ts";
import { exchange, familyOf } from "../scripts/rename-floka/mixed/wire.ts";
import { mixedCommand } from "../scripts/rename-floka/mixed/cli.ts";
import { createPushSender } from "../src/bridge/push/sender.ts";
import { testChildEnv } from "./test-env.ts";

const TMP = realpathSync(existsSync("/tmp") ? "/tmp" : tmpdir());
const REPO = join(import.meta.dir, "..");
const LONG = 60_000;

const bases: string[] = [];
const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) closeWorld(w);
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function base(): string {
  const b = realpathSync(mkdtempSync(join(TMP, "floka-mixed-test-")));
  bases.push(b);
  return b;
}

async function order(o: readonly string[], faults?: Record<string, ("state" | "runtime" | "services")[]>): Promise<World> {
  const w = await runOrder(base(), o, faults ? { faults } : {});
  worlds.push(w);
  return w;
}

const inst = (w: World, name: string) => w.insts.find((i) => i.name === name)!;
const stage = (w: World, step: string) => w.stages.find((s) => s.step === step)!;
const allViolations = (w: World) => w.stages.flatMap((s) => s.violations.map((v) => `${s.step}: ${v}`));

describe("[验收线 1] rename.rollout 与滚动计划", () => {
  test("缺省 observe；off / observe / on 以外按 off；off 没有步骤，observe / on 是同一份计划", () => {
    expect(parseRollout(undefined)).toEqual({ mode: "observe", problems: [] });
    expect(parseRollout({ rename: {} }).mode).toBe("observe");
    for (const raw of ["ON", true, 1, {}]) {
      const r = parseRollout({ rename: { rollout: raw } });
      expect(r.mode).toBe("off");
      expect(r.problems).toHaveLength(1);
    }
    const order = ["beta", "gamma", "alpha"];
    expect(rolloutPlan({ rename: { rollout: "off" } }, order).steps).toEqual([]);
    expect(rolloutPlan({}, order).steps).toEqual(rolloutPlan({ rename: { rollout: "on" } }, order).steps);
  });

  test("次序：中心先双认 → 逐机 state / runtime / services / mcp / receive → 三台都切完才开新发送", () => {
    const steps = rolloutSteps(["gamma", "alpha", "beta"]);
    expect(steps[0]).toMatchObject({ id: "center:dual", set: { centerReceive: "on", centerSend: "on" } });
    const cuts = steps.filter((s) => s.kind === "cut").map((s) => s.id);
    expect(cuts).toEqual(["gamma", "alpha", "beta"].flatMap((m) => CUT_PARTS.map((p) => `cut:${m}:${p}`)));
    const firstSend = steps.findIndex((s) => s.kind === "send");
    expect(steps.slice(firstSend).every((s) => s.kind === "send")).toBe(true);
    // 接收档不含任何发送开关；新发送只出现在最后一段
    for (const s of steps.slice(0, firstSend)) expect(JSON.stringify(s.set)).not.toMatch(/"(peerRequestSend|ledgerSend)"|"send":"on"/);
    for (const s of steps) expect(s.rollback.length).toBeGreaterThan(0);
    expect(() => rolloutSteps(["alpha", "alpha", "beta"])).toThrow();
  });

  test("三机全部 6 个升级次序", () => {
    const orders = upgradeOrders(MACHINES);
    expect(orders).toHaveLength(6);
    expect(new Set(orders.map((o) => o.join())).size).toBe(6);
  });
});

describe("[验收线 1] 临时三实例：全部升级次序，中心 / 客户端混版本均可用", () => {
  for (const o of upgradeOrders(MACHINES)) {
    test(`升级次序 ${o.join("→")}`, async () => {
      const w = await order(o);
      expect(allViolations(w)).toEqual([]);
      expect(w.stages.map((s) => s.step)).toEqual(["baseline", "center:dual", ...o.map((m) => `cut:${m}`), ...o.map((m) => `send:${m}`)]);
      for (const s of w.stages) {
        expect(s.ok).toBe(true);
        expect(s.failures).toEqual([]);
        expect(s.arrivals).toHaveLength(6);
      }
      // 新发送之前：任何一端都只收到旧族（请求签名、台账签名、转发头），中心连接也都是旧族
      for (const s of w.stages.filter((s) => !s.step.startsWith("send:"))) {
        expect(s.arrivals.every((a) => a.request === "claudestra" && a.ledger === "claudestra" && a.flokaHeaders.length === 0)).toBe(true);
        expect(Object.values(s.center).every((f) => f === "legacy")).toBe(true);
      }
      // 每开一台的新发送：只有它发出的变新族，其余照旧
      for (const [k, m] of o.entries()) {
        const s = stage(w, `send:${m}`);
        const senders = new Set(o.slice(0, k + 1));
        for (const a of s.arrivals) expect(a.request).toBe(senders.has(a.from) ? "floka" : "claudestra");
        expect(s.center[m]).toBe("floka");
        for (const later of o.slice(k + 1)) expect(s.center[later]).toBe("legacy");
      }
    }, LONG);
  }

  test("对照：不经协商硬发新族给未升级的一端，一律被拒（旧端只认旧族不是巧合）", async () => {
    const w = await createWorld(base());
    worlds.push(w);
    const r = await exchange(w.wire, "floka");
    expect(r.arrivals).toHaveLength(6);
    expect(r.arrivals.every((a) => a.request === "rejected" && a.ledger === "rejected")).toBe(true);
    expect(r.failures).toHaveLength(6);
    const ok = await checkpoint(w, "after-forced", true, []);
    expect(ok.violations).toEqual([]);
  }, LONG);

  test("新客户端 × 旧中心：切完三台后中心回旧版本，已切的客户端回旧族照常互通", async () => {
    const w = await order(["alpha", "beta", "gamma"]);
    const s = await rollbackCenter(w);
    expect(s.violations).toEqual([]);
    expect(Object.values(s.center)).toEqual(["legacy", "legacy", "legacy"]);
    expect(s.arrivals.every((a) => a.request === "floka" && a.ledger === "floka")).toBe(true); // 实例之间的协商不经中心
  }, LONG);
});

describe("[验收线 2] 注入服务切换与迁移失败：单写者 / 单 server，身份与新增任务保留", () => {
  test("services 健康检查失败：整机逆序回滚，四个 daemon 始终一个写者，迁移后新增的任务回到旧根", async () => {
    const w = await order(["alpha", "beta", "gamma"], { beta: ["services"] });
    expect(allViolations(w)).toEqual([]);
    const cut = stage(w, "cut:beta");
    expect(cut.ok).toBe(false);
    expect(cut.detail).toContain("services: blocked → rolled-back");
    expect(cut.detail).toEqual(expect.arrayContaining(["runtime:rolled_back", "state:committed/legacy"]));
    const beta = inst(w, "beta");
    expect(beta.services.maxLive).toBe(1);
    expect(beta.services.side()).toBe("old");
    expect(await layoutOf(beta)).toBe("legacy");
    expect(tasks(beta)).toContain("after-state-1.json");
    expect(await serversSeen(beta)).toEqual(["tmux-server:beta"]);
    // 其余两台照常切完并开新发送；beta 仍是旧端：发给它的全是旧族，它发出的也全是旧族
    const last = w.stages.at(-1)!;
    for (const a of last.arrivals) {
      const fam = a.to === "beta" || a.from === "beta" ? "claudestra" : "floka";
      expect([a.request, a.ledger]).toEqual([fam, fam]);
    }
    expect(stage(w, "send:beta").detail[0]).toContain("跳过");
  }, LONG);

  test("state 搬根后建别名失败：库补偿搬回，后面的分项一个都不动", async () => {
    const w = await order(["alpha", "beta", "gamma"], { alpha: ["state"] });
    expect(allViolations(w)).toEqual([]);
    const cut = stage(w, "cut:alpha");
    expect(cut.ok).toBe(false);
    expect(cut.detail).toHaveLength(1);
    expect(cut.detail[0]).toMatch(/^state: rolled_back\/legacy/);
    const alpha = inst(w, "alpha");
    expect(await layoutOf(alpha)).toBe("legacy");
    expect(alpha.services.side()).toBe("old");
    expect(existsSync(alpha.newRoot)).toBe(false);
  }, LONG);

  test("runtime 经别名看到另一个 server：拒绝并撤别名，state 回滚时新增任务保留", async () => {
    const w = await order(["gamma", "beta", "alpha"], { gamma: ["runtime"] });
    expect(allViolations(w)).toEqual([]);
    const cut = stage(w, "cut:gamma");
    expect(cut.ok).toBe(false);
    expect(cut.detail).toEqual(["state: committed/migrated", "runtime: refused", "state:committed/legacy"]);
    const gamma = inst(w, "gamma");
    expect(await serversSeen(gamma)).toEqual(["tmux-server:gamma"]);
    expect(existsSync(gamma.runtime.alias)).toBe(false);
    expect(tasks(gamma)).toEqual(["after-state-1.json", "t1.json"]);
  }, LONG);

  test("迁移后新增任务的完整回滚：任务、新族会话记录、身份、旧会话都在；回滚后它只收旧族", async () => {
    const w = await order(["alpha", "beta", "gamma"]);
    const alpha = inst(w, "alpha");
    expect(await layoutOf(alpha)).toBe("migrated");
    addTask(alpha, "t-post");
    w.expectedTasks.get("alpha")!.add("t-post.json");
    const fresh = "0b0b0b0b-0000-4000-8000-000000000002";
    expect(launchMcp(alpha, "new", fresh)).toMatchObject({ name: "floka", recordSession: { sessionId: fresh } });
    expect(launchMcp(alpha, "resume", OLD_SESSION)).toMatchObject({ name: "claudestra", source: "legacy" });

    const s = await rollbackMachine(w, "alpha");
    expect(s.violations).toEqual([]);
    expect(s.ok).toBe(true);
    expect(s.detail).toEqual(["receive:off", "mcp:off", "services:rolled-back", "runtime:rolled_back", "state:committed/legacy",
      "layout: legacy", "services: old"]);
    expect(dataRoot(alpha)).toBe(alpha.oldRoot);
    expect(existsSync(alpha.newRoot)).toBe(false);
    expect(tasks(alpha)).toEqual(["after-state-1.json", "t-post.json", "t1.json"]);
    expect(alpha.services.maxLive).toBe(1);
    expect(await serversSeen(alpha)).toEqual(["tmux-server:alpha"]);
    // 已按新族起过的会话续接仍是新族（MCP1：回滚不改会话记录）；老会话与新起的会话都是旧族
    expect(launchMcp(alpha, "resume", fresh)).toMatchObject({ name: "floka", source: "session" });
    expect(launchMcp(alpha, "resume", OLD_SESSION).name).toBe("claudestra");
    expect(launchMcp(alpha, "new", "0c0c0c0c-0000-4000-8000-000000000003").name).toBe("claudestra");
    expect(familyOf(w.wire, alpha)).toBe("legacy");
    for (const a of s.arrivals.filter((a) => a.to === "alpha" || a.from === "alpha")) expect([a.request, a.ledger]).toEqual(["claudestra", "claudestra"]);
    for (const a of s.arrivals.filter((a) => a.to !== "alpha" && a.from !== "alpha")) expect(a.request).toBe("floka");
  }, LONG);
});

describe("[验收线 3] 推送：订阅与凭据不被改名删除，不声称换域 / VAPID 兼容", () => {
  test("切换与回滚前后订阅逐行相同；假推送服务按订阅原 VAPID 钥匙投递，没有一条被判失效", async () => {
    const w = await order(["beta", "alpha", "gamma"]);
    const before = new Map(w.insts.map((i) => [i.name, pushRows(i)]));
    await rollbackMachine(w, "beta");
    expect(allViolations(w)).toEqual([]);
    for (const i of w.insts) {
      const rows = pushRows(i);
      expect(rows).toEqual(before.get(i.name)!);
      expect(rows).toHaveLength(1);
      const vapid = JSON.parse(readFileSync(join(dataRoot(i), "push-vapid.json"), "utf8")) as { publicKey: string };
      expect(rows[0]!.vapidKey).toBe(vapid.publicKey);
      const sent: string[] = [];
      const sender = createPushSender({
        relay: () => null,
        direct: () => ({ vapidPublicKey: vapid.publicKey, apns: null, webPush: async (sub) => { sent.push(sub.endpoint); return 201; } }),
      });
      const r = await sender.sendWebPush(rows[0]!, "{}");
      expect(r).toMatchObject({ ok: true, gone: false, vapidKey: vapid.publicKey });
      expect(sent).toEqual([rows[0]!.endpoint]);
      expect(pushRows(i)).toEqual(rows);
    }
  }, LONG);

  test("计划照实写出不覆盖的：真实三机、换域、换 VAPID；不出现「兼容」的声称", () => {
    const plan = rolloutPlan({}, ["alpha", "beta", "gamma"]);
    expect(plan.notCovered).toEqual(NOT_COVERED);
    expect(plan.notCovered.some((n) => n.includes("不换域名"))).toBe(true);
    expect(plan.notCovered.some((n) => n.includes("VAPID") && n.includes("不声称"))).toBe(true);
    expect(plan.notCovered.some((n) => n.includes("真实三机未升级"))).toBe(true);
    expect(JSON.stringify(plan.steps)).not.toMatch(/vapid|domain|域名/i);
  });
});

describe("[验收线 4] 隔离：on 只放行临时三实例 + 本机假中心，混跑无生产访问", () => {
  const roots = (b: string) => MACHINES.map((m) => join(b, m));
  const tmpRoots = [TMP];
  test("admitRun：off / observe 不执行；临时目录外、根越界、非回环中心一律拒", () => {
    const b = join(TMP, "floka-mixed-x");
    const ok = { base: b, tmpRoots, roots: roots(b), center: "ws://127.0.0.1/v1/ws" };
    expect(admitRun("on", ok)).toEqual({ ok: true });
    for (const mode of ["off", "observe"] as const) expect(admitRun(mode, ok).ok).toBe(false);
    const refused = [
      { ...ok, base: TMP },
      { ...ok, base: join(REPO, "x"), roots: roots(join(REPO, "x")) },
      { ...ok, base: "relative/x", roots: ["relative/x/alpha"] },
      { ...ok, roots: [...roots(b), join(TMP, "elsewhere")] },
      { ...ok, roots: [join(b, "..", "escape")] },
      { ...ok, center: "wss://relay.example.com/v1/ws" },
      { ...ok, center: "ws://localhost/v1/ws" },
      { ...ok, center: "not a url" },
    ];
    for (const t of refused) expect(admitRun("on", t)).toMatchObject({ ok: false, reason: expect.stringContaining("not_isolated") });
  });

  // Bun 自己的转译缓存会写 HOME（macOS ~/Library/Caches/bun），关掉它才能证明产品代码一个字节都没写 HOME
  test("CLI 子进程：临时 HOME 下跑一个次序，HOME 与 --tmp 都原样，运行目录跑完即删", async () => {
    const b = base();
    // 子进程的 TMPDIR 另给一个：test-guard 会在 TMPDIR 里建自己的 runtime 目录，不混进要证明为空的 --tmp
    const home = join(b, "home"), tmp = join(b, "tmp"), sys = join(b, "sys");
    for (const d of [home, tmp, sys]) mkdirSync(d);
    const proc = Bun.spawn([process.execPath, "--no-env-file", join(REPO, "scripts/rename-floka/mixed/cli.ts"), "run", "--mode", "on",
      "--order", "gamma,alpha,beta", "--tmp", tmp], { env: testChildEnv({ HOME: home, TMPDIR: sys, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }), stdout: "pipe", stderr: "pipe" });
    const [out, code] = [await new Response(proc.stdout).text(), await proc.exited];
    expect(code).toBe(0);
    const r = JSON.parse(out) as { ran: boolean; ok: boolean; orders: { order: string[]; ok: boolean }[] };
    expect(r).toMatchObject({ ran: true, ok: true, orders: [{ order: ["gamma", "alpha", "beta"], ok: true }] });
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
  }, LONG);

  test("CLI：observe（缺省）与越界的 --tmp 都不建任何目录", async () => {
    const b = base();
    const r1 = await mixedCommand(["run", "--tmp", b], REPO);
    expect(r1).toMatchObject({ code: 0, out: { mode: "observe", ran: false } });
    const r2 = await mixedCommand(["run", "--mode", "on", "--tmp", REPO], REPO);
    expect(r2).toMatchObject({ code: 1, out: { ran: false, reason: expect.stringContaining("not_isolated") } });
    expect(readdirSync(b)).toEqual([]);
    expect(readdirSync(REPO).some((n) => n.startsWith("floka-mixed-"))).toBe(false);
    const plan = await mixedCommand(["plan"], REPO);
    expect((plan.out as unknown[]).length).toBe(6);
  });
});

describe("[验收线 4] 开工前核：未核项不得填通过", () => {
  test("没有证据：卡、中心证明、拓扑都是 unverified，ready=false", () => {
    const r = preflight({});
    expect(r.ready).toBe(false);
    expect(r.items.every((i) => i.status === "unverified")).toBe(true);
    expect(r.items.filter((i) => i.id.startsWith("card:"))).toHaveLength(PRIOR_CARDS.length);
  });

  test("证据齐全才 ready；格式不对判 fail；三机差异写进结论", () => {
    const merged = Object.fromEntries(PRIOR_CARDS.map((c) => [c, "abcdef1"]));
    const machine = (version: string) => ({ daemons: [...DAEMONS], version });
    const topology = { machines: { a: machine("2.33.0"), b: machine("2.33.0"), c: machine("2.32.1") } };
    const centerProof = { repo: "private/relay", commit: "0123abc", families: ["legacy", "floka"] };
    const good = preflight({ merged, centerProof, topology });
    expect(good.ready).toBe(true);
    expect(good.items.find((i) => i.id === "topology:diff")!.detail).toContain("c=2.32.1");
    expect(DAEMONS).toEqual(["bridge", "cron", "scheduler", "launcher"]);
    for (const bad of [
      { merged: { ...merged, LEDGER1: null } },
      { centerProof: { ...centerProof, families: ["legacy"] } },
      { centerProof: { repo: "x", commit: "HEAD", families: ["legacy", "floka"] } },
      { topology: { machines: { a: machine("1"), b: machine("1") } } },
      { topology: { machines: { a: machine("1"), b: machine("1"), c: { daemons: ["bridge", "cron", "scheduler"], version: "1" } } } },
    ]) {
      const r = preflight({ merged, centerProof, topology, ...bad });
      expect(r.ready).toBe(false);
      expect(r.items.some((i) => i.status === "fail")).toBe(true);
    }
    const noVersion = preflight({ merged, centerProof, topology: { machines: { a: { daemons: [...DAEMONS] }, b: machine("1"), c: machine("1") } } });
    expect(noVersion.items.find((i) => i.id === "topology:diff")!.status).toBe("unverified");
    expect(noVersion.ready).toBe(false);
  });

  test("卡名按合入标题认：大小写不敏感，STATE1 不认 STATE10", () => {
    const m = cardMerges([
      { sha: "aaaaaaa", subject: "Merge pull request #1 from x/lend/rename-floka-STATE10-b1a2" },
      { sha: "bbbbbbb", subject: "Merge pull request #2 from x/feat/rename-floka-state1" },
      { sha: "ccccccc", subject: "Merge pull request #3 from x/lend/rename-floka-LEDGER1-9109" },
    ]);
    expect(m.STATE1).toBe("bbbbbbb");
    expect(m.LEDGER1).toBe("ccccccc");
    expect(m.E2E1).toBeNull();
  });
});
