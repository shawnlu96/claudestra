/**
 * 订单沙箱回收（lib/sandbox-order-cleanup.ts）：真实私有 socket 的 tmux server、假 bridge（bun 空转）、登记子进程（perl），
 * 全在 /tmp 临时根下。正常终态要真的停掉并确认退出；证据不足的每种情况都要零信号、进程照活、目录不删。
 * tmux 经 lib/tmux-helper.ts 在子进程里起（CLAUDESTRA_RUNTIME_DIR 指向临时根），不连生产 master socket。
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxOrderOwnership, type CleanupDeps, type OrderFacts, type SandboxOrderOwnership } from "../src/lib/sandbox-order-cleanup.ts";
import { ownerRecordId, type SandboxOwnerKey } from "../src/lib/sandbox-order-owner.ts";
import type { WorkerLiveness } from "../src/lib/worker-liveness.ts";
import { testChildEnv } from "./test-env.ts";

const TMUX = join(import.meta.dir, "..", "src", "lib", "tmux-helper.ts");
const pids: number[] = [];
let base = "";
let root = "";
let owners = "";

const alive = (pid: number) => {
  try { return process.kill(pid, 0), true; } catch { return false; /* ESRCH：已退出 */ }
};

function spawnIn(argv: string[], cwd = root): number {
  const p = Bun.spawn(argv, { cwd, stdout: "ignore", stderr: "ignore" });
  pids.push(p.pid);
  return p.pid;
}
const fakeBridge = () => spawnIn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
/** 不理 SIGTERM 的子进程：逼出 SIGKILL 那一步 */
const stubborn = () => spawnIn(["perl", "-e", "$SIG{TERM} = 'IGNORE'; sleep 300"]);
const sleeper = () => spawnIn(["perl", "-e", "sleep 300"]);

/** 私有 socket 上起一个 tmux server（pane 里跑 sleep），返回 server pid 与 socket */
async function privateTmux(): Promise<{ pid: number; socket: string }> {
  const run = join(root, "run");
  mkdirSync(run);
  const script = join(base, "tmux.ts");
  writeFileSync(script, `import { tmuxRawStrict } from ${JSON.stringify(TMUX)};
await tmuxRawStrict(["new-session", "-d", "-s", "sbx", "sleep 300"]);
console.log(await tmuxRawStrict(["display-message", "-p", "#{pid}"]));`);
  const p = Bun.spawn([process.execPath, script], { env: testChildEnv({ CLAUDESTRA_RUNTIME_DIR: run, CLAUDESTRA_STATE_DIR: join(base, "state") }), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`私有 tmux 没起来：${err}`);
  const pid = Number(out.trim());
  pids.push(pid);
  return { pid, socket: join(run, "master.sock") };
}

const key = (orderId = "o-1", generation = 2): SandboxOwnerKey => ({ orderId, worker: "agent-lend-x", generation, scope: "write" });
const ended: OrderFacts = { state: "acked", generation: 2, resultPending: false };

interface Harness { own: SandboxOrderOwnership; signals: Array<[number, string]> }
function harness(facts: () => OrderFacts | null = () => ended, live: WorkerLiveness = "no_window", extra: Partial<CleanupDeps> = {}): Harness {
  const signals: Array<[number, string]> = [];
  const own = sandboxOrderOwnership({
    dir: owners,
    orderFacts: async () => facts(),
    workerLiveness: async () => live,
    signal: (pid, sig) => (signals.push([pid, sig]), void process.kill(pid, sig)),
    graceMs: 1_500,
    killWaitMs: 2_000,
    ...extra,
  });
  return { own, signals };
}

/** 一套完整沙箱：tmux + bridge + 两个子进程（一个不理 TERM） */
async function fullSandbox(h: Harness, k = key()) {
  const tmux = await privateTmux();
  const bridge = fakeBridge();
  const kids = [sleeper(), stubborn()];
  await h.own.register({ key: k, root, resources: [{ kind: "tmux", pid: tmux.pid, socket: tmux.socket }, { kind: "bridge", pid: bridge }] });
  for (const c of kids) await h.own.addChild(k, c);
  return { tmux, bridge, kids, all: [tmux.pid, bridge, ...kids] };
}

beforeEach(() => {
  base = mkdtempSync("/tmp/sbc-");
  root = join(base, "root");
  owners = join(base, "owners");
  mkdirSync(root);
  writeFileSync(join(root, "bridge.log"), "log line\n");
});

afterAll(() => {
  for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
});

test("正常终态：bridge → 子进程 → tmux 依次停掉并确认退出，私有 socket 删掉，日志 / 根目录 / 属主记录保留；重复清理零信号", async () => {
  const h = harness();
  const s = await fullSandbox(h);
  const rep = await h.own.cleanup(key());
  expect(rep.status).toBe("done");
  expect(rep.resources.map((r) => [r.kind, r.outcome])).toEqual([["bridge", "stopped"], ["child", "stopped"], ["child", "stopped"], ["tmux", "stopped"]]);
  for (const pid of s.all) expect(alive(pid)).toBe(false);
  expect(h.signals.filter(([, sig]) => sig === "SIGKILL").map(([pid]) => pid)).toEqual([s.kids[1]]);
  expect(h.signals.every(([pid]) => s.all.includes(pid))).toBe(true);
  expect(existsSync(s.tmux.socket)).toBe(false);
  expect(readFileSync(join(root, "bridge.log"), "utf8")).toBe("log line\n");
  expect(existsSync(rep.archive!)).toBe(true);
  const rec = JSON.parse(readFileSync(join(owners, "records", `${ownerRecordId(key())}.json`), "utf8"));
  expect(rec.cleanup).toMatchObject({ attempts: 1, done: true });

  const before = h.signals.length;
  const again = await h.own.cleanup(key());
  expect(again).toMatchObject({ status: "done", signals: 0 });
  expect(again.resources.every((r) => r.outcome === "already_exited")).toBe(true);
  expect(h.signals.length).toBe(before);
}, 30_000);

/** 每个拒绝场景：报 refused、零信号、进程都还活着、根目录在 */
async function expectRefused(h: Harness, all: number[], k = key(), reason?: string) {
  const rep = await h.own.cleanup(k);
  expect(rep).toMatchObject({ status: "refused", signals: 0, resources: [] });
  if (reason) expect(rep.reason).toContain(reason);
  expect(h.signals).toEqual([]);
  for (const pid of all) expect(alive(pid)).toBe(true);
  expect(existsSync(join(root, "bridge.log"))).toBe(true);
}

test("活单 / 未知单 / 待交结果 / 已换代：一律零动作", async () => {
  let facts: OrderFacts | null = { ...ended, state: "started" };
  const h = harness(() => facts);
  const s = await fullSandbox(h);
  await expectRefused(h, s.all, key(), "不是终态");
  facts = { ...ended, state: "result_pending" };
  await expectRefused(h, s.all, key(), "不是终态");
  facts = null;
  await expectRefused(h, s.all, key(), "未知");
  facts = { ...ended, resultPending: true };
  await expectRefused(h, s.all, key(), "待交");
  facts = { ...ended, generation: 3 };
  await expectRefused(h, s.all, key(), "换代");
  const throws = harness(() => { throw new Error("journal locked"); });
  await expectRefused(throws, s.all, key(), "读不了");
}, 30_000);

test("worker 活性：running / unknown / no_host 都不动；没有记录（普通 agent）也不动", async () => {
  const h0 = harness();
  const s = await fullSandbox(h0);
  for (const live of ["running", "unknown", "no_host"] as const) await expectRefused(harness(undefined, live), s.all, key(), live);
  await expectRefused(harness(), s.all, { ...key(), worker: "agent-someone" }, "没有属主记录");
}, 30_000);

test("pid 复用：登记的启动时刻对不上 = 原进程已退，不给现在占着这个 pid 的进程发信号", async () => {
  const h = harness();
  const pid = sleeper();
  await h.own.register({ key: key(), root, resources: [{ kind: "bridge", pid }] });
  const file = join(owners, "records", `${ownerRecordId(key())}.json`);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  rec.resources[0].startedAt -= 3_600_000;
  writeFileSync(file, JSON.stringify(rec));
  const rep = await h.own.cleanup(key());
  expect(rep).toMatchObject({ status: "done", signals: 0, resources: [{ kind: "bridge", pid, outcome: "pid_reused" }] });
  expect(h.signals).toEqual([]);
  expect(alive(pid)).toBe(true);
  // 启动时刻一致但命令对不上：说不清，整单拒绝
  rec.resources[0].startedAt += 3_600_000;
  rec.resources[0].commandHash = "f".repeat(64);
  rec.cleanup = undefined;
  writeFileSync(file, JSON.stringify(rec));
  await expectRefused(h, [pid], key(), "身份说不清");
}, 30_000);

test("tmux 登记身份对不上（pid 复用）而 socket 上仍有 server：不发信号、不删 socket，报 partial", async () => {
  const h = harness();
  const tmux = await privateTmux();
  await h.own.register({ key: key(), root, resources: [{ kind: "tmux", pid: tmux.pid, socket: tmux.socket }] });
  const file = join(owners, "records", `${ownerRecordId(key())}.json`);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  rec.resources[0].startedAt -= 3_600_000;
  writeFileSync(file, JSON.stringify(rec));
  const rep = await h.own.cleanup(key());
  expect(rep).toMatchObject({ status: "partial", signals: 0, resources: [{ kind: "tmux", outcome: "stop_failed", detail: expect.stringContaining("在听") }] });
  expect(h.signals).toEqual([]);
  expect(alive(tmux.pid) && existsSync(tmux.socket)).toBe(true);
}, 30_000);

test("根目录被换成软链 / 记录损坏 / 属主目录读不了 / 另一单声称同一进程：零动作", async () => {
  const h = harness();
  const s = await fullSandbox(h);
  renameSync(root, `${root}.real`);
  symlinkSync(`${root}.real`, root);
  await expectRefused(h, s.all, key());
  rmSync(root);
  renameSync(`${root}.real`, root);

  const file = join(owners, "records", `${ownerRecordId(key())}.json`);
  const good = readFileSync(file, "utf8");
  // 另一单的记录（手工写入，绕过登记）声称同一个 bridge
  const other = { ...JSON.parse(good), key: key("o-other"), root: realpathSync(mkdtempSync("/tmp/sbc-o-")) };
  const otherFile = join(owners, "records", `${ownerRecordId(other.key)}.json`);
  writeFileSync(otherFile, JSON.stringify(other));
  await expectRefused(h, s.all, key(), "也登记在");
  writeFileSync(otherFile, "{broken");
  await expectRefused(h, s.all, key(), "说不清的记录");
  rmSync(otherFile);

  writeFileSync(file, "{broken");
  await expectRefused(h, s.all, key(), "损坏");
  writeFileSync(file, good);

  renameSync(owners, `${owners}.real`);
  await expectRefused(h, s.all, key());
  renameSync(`${owners}.real`, owners);
  expect((await h.own.cleanup(key())).status).toBe("done");
}, 40_000);

test("tmux socket 被换成指向别处的软链：不认这是私有 socket，零动作", async () => {
  const h = harness();
  const s = await fullSandbox(h);
  const elsewhere = mkdtempSync("/tmp/sbc-x-");
  renameSync(s.tmux.socket, join(elsewhere, "master.sock"));
  symlinkSync(join(elsewhere, "master.sock"), s.tmux.socket);
  await expectRefused(h, s.all, key(), "软链");
  rmSync(s.tmux.socket);
  renameSync(join(elsewhere, "master.sock"), s.tmux.socket);
  expect((await h.own.cleanup(key())).status).toBe("done");
}, 30_000);

test("证据保全失败：零动作；修好后才清", async () => {
  const h = harness();
  const s = await fullSandbox(h);
  writeFileSync(join(owners, "archive"), "not a dir");
  await expectRefused(h, s.all, key(), "保全失败");
  rmSync(join(owners, "archive"));
  expect((await h.own.cleanup(key())).status).toBe("done");
}, 30_000);

test("停进程失败：报 partial 不报完成，记下失败；之后重试才 done", async () => {
  let deny = true;
  const h = harness(undefined, "no_window", {
    signal: (pid, sig) => {
      if (deny) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      process.kill(pid, sig);
    },
  });
  const pid = sleeper();
  const kid = sleeper();
  await h.own.register({ key: key(), root, resources: [{ kind: "bridge", pid }, { kind: "child", pid: kid }] });
  const rep = await h.own.cleanup(key());
  expect(rep.status).toBe("partial");
  expect(rep.resources.map((r) => r.outcome)).toEqual(["stop_failed", "stop_failed"]);
  expect(alive(pid) && alive(kid)).toBe(true);
  const rec = JSON.parse(readFileSync(join(owners, "records", `${ownerRecordId(key())}.json`), "utf8"));
  expect(rec.cleanup).toMatchObject({ attempts: 1, done: false });
  deny = false;
  expect((await h.own.cleanup(key())).status).toBe("done");
  expect(alive(pid) || alive(kid)).toBe(false);
}, 30_000);

test("自有临时目录：进程全停之后才删，只删登记的那个；停进程失败整批保留；目录被换 / 换成软链零动作", async () => {
  let deny = true;
  const h = harness(undefined, "no_window", {
    signal: (pid, sig) => {
      if (deny) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      process.kill(pid, sig);
    },
  });
  const place = mkdtempSync("/tmp/sbc-place-");
  const sibling = mkdtempSync("/tmp/sbc-place-"); // 同前缀、未登记：不许被顺手删
  writeFileSync(join(place, "measure.bin"), "x");
  const pid = sleeper();
  await h.own.register({ key: key(), root, resources: [{ kind: "child", pid }], dirs: [place] });
  const kept = await h.own.cleanup(key());
  expect(kept.status).toBe("partial");
  expect(kept.resources.at(-1)).toMatchObject({ kind: "dir", outcome: "kept" });
  expect(existsSync(join(place, "measure.bin"))).toBe(true);

  // 同名目录换了一个（dev/ino 不同）：说不清，零动作
  renameSync(place, `${place}.old`);
  mkdirSync(place);
  deny = false;
  await expectRefused(harness(), [pid], key(), "不是登记的那个");
  rmSync(place, { recursive: true });
  symlinkSync(`${place}.old`, place);
  await expectRefused(harness(), [pid], key());
  rmSync(place);
  renameSync(`${place}.old`, place);

  const rep = await h.own.cleanup(key());
  expect(rep.status).toBe("done");
  expect(rep.resources.map((r) => r.outcome)).toEqual(["stopped", "removed"]);
  expect(existsSync(place)).toBe(false);
  expect(existsSync(sibling)).toBe(true);
  expect(alive(pid)).toBe(false);
  expect((await h.own.cleanup(key())).resources.map((r) => r.outcome)).toEqual(["already_exited", "already_removed"]);
}, 30_000);

test("只有目录的订单（place / validation 类）：后补登记的目录同样只在证据齐时删", async () => {
  const h = harness(() => ({ ...ended, state: "started" }));
  const measure = mkdtempSync("/tmp/sbc-disk-");
  await h.own.register({ key: key(), root, resources: [], dirs: [] }).catch((e: Error) => expect(e.message).toContain("没有可登记"));
  await h.own.register({ key: key(), root, resources: [], dirs: [measure] });
  const extra = mkdtempSync("/tmp/sbc-val-");
  await h.own.addDir(key(), extra);
  await expectRefused(h, [], key(), "不是终态");
  expect(existsSync(measure) && existsSync(extra)).toBe(true);
  const ok = await harness().own.cleanup(key());
  expect(ok).toMatchObject({ status: "done", signals: 0 });
  expect(existsSync(measure) || existsSync(extra)).toBe(false);
});

test("复核：TTL 到了只列出该复核的 key，坏记录单列；属主目录读不了是 unknown", async () => {
  const h = harness(undefined, "no_window", { now: () => 1_000 });
  await h.own.register({ key: key(), root, resources: [{ kind: "bridge", pid: sleeper() }] });
  writeFileSync(join(owners, "records", "legacy.json"), "{}");
  expect(h.own.review(1_500, 1_000)).toEqual({ status: "ok", due: [], unknown: [{ id: "legacy", reason: expect.any(String) }] });
  expect(h.own.review(2_000, 1_000).due).toEqual([key()]);
  rmSync(owners, { recursive: true });
  expect(h.own.review(2_000, 1_000)).toMatchObject({ status: "unknown", due: [], unknown: [] });
});
