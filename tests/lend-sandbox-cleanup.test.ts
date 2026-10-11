import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, getOrder, patchOrder } from "../src/lib/lend-journal.ts";
import { settleOrder } from "../src/lib/lend-drive.ts";
import { identityVerdict, ownerRecordId, readSandboxOwner, registerSandboxOwner } from "../src/lib/sandbox-order-owner.ts";
import type { SandboxRetirePort, SandboxRetireRequest } from "../src/lib/lend-sandbox.ts";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.ts";
import { lendDeps } from "../src/lib/lend-deps.ts";
import { testChildEnv } from "./test-env.ts";
import { harness, toStarted } from "./lend-harness.ts";

const roots: string[] = [];
const children: Bun.Subprocess[] = [];
afterEach(async () => { for (const p of children.splice(0)) { p.kill(); await p.exited; } });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("正规结单 observe 保全沙箱事实、不删副本、不假完成，原通知 / 收据仍送达", async () => {
  const h = harness();
  try {
    await toStarted(h);
    const base = mkdtempSync(join(tmpdir(), "sbxc2-settle-")); roots.push(base);
    const root = join(base, "sandbox"), owners = join(base, "owners"); mkdirSync(root);
    const live = getOrder(h.db, "o1")!;
    await registerSandboxOwner(owners, { key: { orderId: live.orderId, worker: live.agent!, generation: live.leaseGen!, scope: "test" },
      root, dirs: [root], resources: [] });
    Object.assign(h.d, { sandbox: { owners, mode: () => "observe", card: () => undefined, active: () => {} } });
    h.registry.clear();
    const row = advance(h.db, "o1", "started", "cancelled", { settle: { notify: null, removeDir: true } }, h.d.now());
    await settleOrder(row, h.d);
    expect(h.log.removed).toEqual([]);
    expect(getOrder(h.db, "o1")!.settle).not.toBeNull();
    expect(h.log.receipts).toHaveLength(1);
    expect(h.log.lines.join("\n")).toContain("仅观察");
  } finally { h.db.close(); }
});

async function fixture(mode: "on" | "observe" | "off" = "on", child = false, terminal: "cancelled" | "stopped" | "acked" = "cancelled") {
  const h = harness(); await toStarted(h); h.registry.clear();
  const base = mkdtempSync("/tmp/s2c-"); roots.push(base);
  const root = join(base, "sandbox"), owners = join(base, "owners"); mkdirSync(root);
  const live = getOrder(h.db, "o1")!;
  const key = { orderId: live.orderId, worker: live.agent!, generation: live.leaseGen!, scope: "test" };
  const p = child ? Bun.spawn(["perl", "-e", "sleep 300", "fake-secret-never-log"], { cwd: root, stdout: "ignore", stderr: "ignore" }) : null;
  if (p) children.push(p);
  await registerSandboxOwner(owners, { key, root, dirs: [root], resources: p ? [{ kind: "child", pid: p.pid }] : [] });
  const requests: SandboxRetireRequest[] = [];
  const retire: SandboxRetirePort = async (r) => { requests.push(r); return { status: "done" }; };
  h.d.sandbox = { owners, mode: () => mode, card: () => undefined, active: () => {}, retire };
  if (terminal === "acked") advance(h.db, "o1", "started", "result_pending", {}, h.d.now());
  const row = advance(h.db, "o1", terminal === "acked" ? "result_pending" : "started", terminal,
    { settle: { notify: null, removeDir: terminal !== "stopped" } }, h.d.now());
  const file = join(owners, "records", `${ownerRecordId(key)}.json`);
  return { h, row, root, owners, file, requests, p };
}

test("on 无端口只报告，off 原收尾；失败 / 抛错保留待办，下一轮可重试", async () => {
  for (const mode of ["on", "off"] as const) {
    const f = await fixture(mode);
    try {
      delete f.h.d.sandbox!.retire;
      await settleOrder(f.row, f.h.d);
      expect(f.h.log.removed).toEqual(mode === "off" ? ["o1"] : []);
      if (mode === "on") expect(f.h.log.lines.join("\n")).toContain("回收入口未接");
    } finally { f.h.db.close(); }
  }
  const f = await fixture();
  try {
    f.h.d.sandbox!.retire = async () => { throw new Error("executor failed"); };
    await settleOrder(f.row, f.h.d);
    expect(f.h.log.removed).toEqual([]);
    expect(getOrder(f.h.db, "o1")!.settle).not.toBeNull();
    f.h.d.sandbox!.retire = async (r) => { f.requests.push(r); return { status: "done" }; };
    await settleOrder(getOrder(f.h.db, "o1")!, f.h.d);
    expect(f.requests).toHaveLength(1);
    expect(f.h.log.removed).toEqual(["o1"]);
    expect(getOrder(f.h.db, "o1")!.settle).toBeNull();
  } finally { f.h.db.close(); }
});

test("acked / stopped 都经结单端口，stopped 保留原副本语义；无绑定历史不追认", async () => {
  for (const terminal of ["acked", "stopped"] as const) {
    const f = await fixture("on", false, terminal);
    try {
      await settleOrder(f.row, f.h.d);
      expect(f.requests[0]!.order.state).toBe(terminal);
      expect(f.h.log.removed).toEqual(terminal === "stopped" ? [] : ["o1"]);
      expect(getOrder(f.h.db, "o1")!.settle).toBeNull();
    } finally { f.h.db.close(); }
  }
  const f = await fixture();
  try {
    rmSync(f.file);
    await settleOrder(f.row, f.h.d);
    expect(f.requests).toEqual([]); expect(f.h.log.removed).toEqual([]);
    expect(f.h.log.lines.join("\n")).toContain("legacy 只读保留");
  } finally { f.h.db.close(); }
});

test("活性未知 / 活 worker / 换代 / 本机卡 / 台账失读 / pending / 属主损坏 / 保全失败均不调端口不删除", async () => {
  for (const scenario of ["unknown", "running", "generation", "card", "ledger", "pending", "corrupt", "archive"] as const) {
    const f = await fixture();
    try {
      if (scenario === "unknown" || scenario === "running") f.h.liveness.set(f.row.agent!, scenario);
      if (scenario === "generation") patchOrder(f.h.db, "o1", ["cancelled"], { leaseGen: 2 }, f.h.d.now());
      if (scenario === "card") f.h.d.sandbox!.card = () => ({ agent: f.row.agent!, taskId: "RLOCK1" }) as never;
      if (scenario === "ledger") f.h.d.sandbox!.card = () => { throw new Error("ledger read failed"); };
      if (scenario === "pending") patchOrder(f.h.db, "o1", ["cancelled"], { payload: { result: "pending" } }, f.h.d.now());
      if (scenario === "corrupt") writeFileSync(f.file, "invalid");
      if (scenario === "archive") writeFileSync(join(f.owners, "archive"), "not a directory");
      await settleOrder(getOrder(f.h.db, "o1")!, f.h.d);
      expect(f.requests).toEqual([]);
      expect(f.h.log.removed).toEqual([]);
      expect(getOrder(f.h.db, "o1")!.settle).not.toBeNull();
    } finally { f.h.db.close(); }
  }
});

test("原始身份与保全字节传入端口，不写命令行 / 凭据；PID 复用拒绝", async () => {
  const f = await fixture("on", true);
  try {
    await settleOrder(f.row, f.h.d);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.owner.resources[0]!.pid).toBe(f.p!.pid);
    const raw = readFileSync(f.requests[0]!.evidence.path, "utf8");
    expect(raw).not.toContain("fake-secret-never-log");
    expect(f.requests[0]!.observations).toEqual([{ pid: f.p!.pid, verdict: "same" }]);
    const record = JSON.parse(readFileSync(f.file, "utf8")); record.resources[0].startedAt -= 1000;
    writeFileSync(f.file, JSON.stringify(record));
    f.requests.length = 0; f.h.log.removed.length = 0;
    patchOrder(f.h.db, "o1", ["cancelled"], { settle: { notify: null, removeDir: true } }, f.h.d.now());
    await settleOrder(getOrder(f.h.db, "o1")!, f.h.d);
    expect(f.requests).toEqual([]); expect(f.h.log.removed).toEqual([]);
  } finally { f.h.db.close(); }
});

test("未知 legacy / 已删根不追认；沙箱 stop retained 不清 settle；失租向外抛", async () => {
  const f = await fixture();
  try {
    rmSync(f.root, { recursive: true });
    await settleOrder(f.row, f.h.d);
    expect(f.requests).toEqual([]); expect(f.h.log.removed).toEqual([]);
    expect(existsSync(f.file)).toBe(true);
    f.h.d.sandbox!.active = () => { throw new SchedulerStopped(); };
    await expect(settleOrder(getOrder(f.h.db, "o1")!, f.h.d)).rejects.toBeInstanceOf(SchedulerStopped);
  } finally { f.h.db.close(); }
});

test("生产 facts 装配默认 observe、没有执行端口，LIFE1 失读明确拒绝", () => {
  const h = harness();
  try {
    const d = lendDeps(h.db, { get: () => undefined } as never, () => {}, undefined);
    expect(d.sandbox!.mode()).toBe("observe");
    expect(d.sandbox!.retire).toBeUndefined();
    expect(() => d.sandbox!.card("agent-lend-x")).toThrow("cardWorkerIndex 不可读");
  } finally { h.db.close(); }
});

test("shared socket 不属于根，真实进程仍活也拒绝端口", async () => {
  const f = await fixture("on", true);
  const socket = join(f.owners, "shared.sock"), server = Bun.listen({ unix: socket, socket: { data() {} } });
  try {
    const record = JSON.parse(readFileSync(f.file, "utf8"));
    Object.assign(record.resources[0], { kind: "tmux", socket });
    writeFileSync(f.file, JSON.stringify(record));
    await settleOrder(f.row, f.h.d);
    expect(f.requests).toEqual([]); expect(f.h.log.removed).toEqual([]);
    expect(f.h.log.lines.join("\n")).toContain("不是本单私有对象");
  } finally { server.stop(true); f.h.db.close(); }
});

test("真实同一 PID 跨 Tokyo / UTC 子进程身份不变；无版本旧记录一律 unknown", async () => {
  const f = await fixture("on", true);
  try {
    const record = JSON.parse(readFileSync(f.file, "utf8")), resource = record.resources[0];
    expect(resource.identityVersion).toBe(2);
    const source = new URL("../src/lib/sandbox-order-owner.ts", import.meta.url).pathname;
    const code = `import { probeProcess, identityVerdict } from ${JSON.stringify(source)};
      const r = JSON.parse(process.argv[1]), p = await probeProcess(r.pid);
      console.log(JSON.stringify({ startedAt: p.startedAt, verdict: identityVerdict(r, p) }));`;
    const results = [];
    for (const TZ of ["Asia/Tokyo", "UTC"]) {
      const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", code, JSON.stringify(resource)], {
        env: testChildEnv({ TZ }), stdout: "pipe", stderr: "pipe",
      });
      const raw = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      results.push(JSON.parse(raw));
    }
    expect(results).toEqual([{ startedAt: resource.startedAt, verdict: "same" }, { startedAt: resource.startedAt, verdict: "same" }]);
    delete resource.identityVersion;
    expect(identityVerdict(resource, { state: "gone" })).toBe("unknown");
    writeFileSync(f.file, JSON.stringify(record));
    expect(readSandboxOwner(f.owners, record.key).status).toBe("ok");
    await settleOrder(f.row, f.h.d);
    expect(f.requests).toEqual([]); expect(f.h.log.removed).toEqual([]);
    resource.identityVersion = 1; writeFileSync(f.file, JSON.stringify(record));
    expect(readSandboxOwner(f.owners, record.key).status).toBe("unknown");
  } finally { f.h.db.close(); }
});

test("起 worker 失败走 released 正规收尾，先保全再交端口", async () => {
  const h = harness(), root = mkdtempSync("/tmp/s2r-"); roots.push(root);
  const owners = join(root, "owners"), sandbox = join(root, "sandbox"); mkdirSync(sandbox);
  const seen: string[] = [];
  h.d.sandbox = { owners, mode: () => "on", card: () => undefined, active: () => {}, retire: async (r) => {
    expect(existsSync(r.evidence.path)).toBe(true); seen.push(r.order.state); return { status: "done" };
  } };
  h.d.worker.create = async (worker, _dir, _purpose, _gate, orderId) => {
    const row = getOrder(h.db, orderId)!;
    await registerSandboxOwner(owners, { key: { orderId, worker, generation: row.leaseGen!, scope: "failed-start" },
      root: sandbox, resources: [], dirs: [sandbox] });
    return { ok: false, error: "fixture startup failed" };
  };
  try {
    for (let i = 0; i < 5; i++) await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("released");
    expect(seen).toEqual(["released"]);
    expect(h.log.removed).toEqual(["o1"]);
    expect(h.log.receipts).toHaveLength(1);
  } finally { h.db.close(); }
});
