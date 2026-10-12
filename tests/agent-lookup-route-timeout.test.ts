/**
 * LST-2 r1 P1 timeout-budget：manager list 挂住时，route_to_agent 的 list_unavailable 必须赶在调用方超时之前回去，
 * 调用方才拿到 sent:false（rejected）、step 唤醒重跑还能再发；晚了调用方先超时记 unknown，不再重试，目标却没收到。
 * 整条路径：挂住的 manager（真子进程 + 真预算强杀）→ stub bridge 的 route_to_agent 走 bridge.ts 同一个 routeLookupOrReject
 * → 子进程里真 bridgeSend / step-wake 的 bridgeWake（env -i，BRIDGE_URL 指向 stub）→ 父进程 ledger step 的唤醒记账。
 */
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTE_LIST_BUDGET_MS, routeLookupOrReject } from "../src/bridge/agent-lookup.ts";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.ts";
import { createTask, setMeta } from "../src/lib/ledger-write.ts";
import { REPO_ROOT } from "../src/lib/repo-root.ts";
import { runManagerProcess } from "../src/lib/run-manager.ts";
import { setStepWakeDeliver, STEP_WAKE_OP, type WakeDeliver } from "../src/lib/step-wake.ts";
import { runLedger } from "../src/manager/ledger.ts";
import type { Registry } from "../src/manager/core.ts";

const P = "claude-orchestrator";
const PM = "agent-pm";
const EXE = "agent-task-w1";
const roots: string[] = [];
let db: Database | null = null;
afterEach(() => {
  setStepWakeDeliver(null);
  if (db) closeLedger(":memory:");
  db = null;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** 子进程跑真 step-wake 的 bridgeWake（stepWakeDeliver(true)，bridgeSend 15s），只把结果交回父进程 */
async function childWake(root: string, port: number, agent: string, text: string): Promise<{ status: string; error?: string }> {
  const env = { HOME: root, TMPDIR: root, PATH: process.env.PATH ?? "", CLAUDESTRA_STATE_DIR: join(root, "state"), CLAUDESTRA_RUNTIME_DIR: join(root, "run"),
    BRIDGE_URL: `ws://127.0.0.1:${port}` };
  const script = `const m = await import("${REPO_ROOT}/src/lib/step-wake.ts");
console.log(JSON.stringify(await m.stepWakeDeliver(true)(${JSON.stringify(agent)}, ${JSON.stringify(text)})));`;
  const p = Bun.spawn(["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, "--no-env-file", "-e", script],
    { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const last = out.trim().split("\n").at(-1);
  if (!last) throw new Error(`子进程没有输出：${err.slice(-2000)}`);
  return JSON.parse(last);
}

test("manager list 挂住：调用方拿到 rejected（sent:false）而不是超时 unknown，重跑 step 再唤醒一次就送到", async () => {
  const root = mkdtempSync(join(tmpdir(), "lst2-route-")); roots.push(root);
  const hang = join(root, "hang-manager.ts");
  writeFileSync(hang, "setInterval(() => {}, 1 << 30);\n"); // 挂住的 manager：不输出、不退出，只能被预算强杀
  writeFileSync(join(root, "ok-manager.ts"), `console.log(JSON.stringify({ ok: true, agents: [{ name: "${EXE}", channelId: "c1" }] }));\n`);
  let managerPath = hang;
  const frames: { type: string; targetName: string }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("stub")),
    websocket: { async message(ws, raw) {
      const f = JSON.parse(String(raw));
      frames.push(f);
      const list = () => runManagerProcess(["list"], { bunPath: process.execPath, managerPath, env: { PATH: process.env.PATH }, timeoutMs: ROUTE_LIST_BUDGET_MS });
      const found = await routeLookupOrReject(ws, f.requestId, f.targetName, list);
      if (found) ws.send(JSON.stringify({ type: "response", requestId: f.requestId, result: { delivered: found.targetName } }));
    } } });

  const timings: number[] = [];
  setStepWakeDeliver(async (agent, text) => {
    const t0 = Date.now();
    const r = await childWake(root, server.port!, agent, text);
    timings.push(Date.now() - t0);
    return r as Awaited<ReturnType<WakeDeliver>>;
  });
  db = openLedger(":memory:");
  setMeta(db, { actor: "owner", now: 1_000 }, { project: P, key: "pms", value: [PM] });
  createTask(db, { actor: "owner", now: 1_000 }, { project: P, id: "W1", title: "唤醒", kind: "code" });
  db.query("UPDATE tasks SET stage = 'build' WHERE id = 'W1'").run();
  const reg = { socket: "", agents: { [PM]: { status: "active", projectId: P }, [EXE]: { status: "active", projectId: P } } } as unknown as Registry;
  const run = (...args: string[]) => runLedger(args, { db: db!, actor: PM, projectIds: [P], loadRegistry: async () => structuredClone(reg),
    saveRegistry: async () => {}, now: () => 2_000 }) as Promise<Record<string, any>>;
  const wakes = () => listEvents(db!, { project: P, target: "W1" }).filter((e) => e.kind === "note" && e.data.op === STEP_WAKE_OP && e.data.phase === "result");

  try {
    const first = await run("step", "W1", "write", EXE, "--kind", "agent");
    expect(first).toMatchObject({ ok: true, wake: { sent: false, why: expect.stringContaining("唤醒未送达") } });
    expect(wakes()[0]!.data).toMatchObject({ status: "rejected", error: expect.stringContaining("暂时不可用") });
    expect(timings[0]!).toBeLessThan(10_000); // 连 bridgeSend 默认的 10s 都赶得上，不只是 step-wake 的 15s

    managerPath = join(root, "ok-manager.ts"); // manager 恢复
    expect(await run("step", "W1", "write", EXE, "--kind", "agent")).toMatchObject({ ok: true, wake: { sent: true, agent: EXE } });
    expect(wakes().map((e) => [e.data.attempt, e.data.status])).toEqual([[1, "rejected"], [2, "sent"]]);
    expect(frames.map((f) => [f.type, f.targetName])).toEqual([["route_to_agent", EXE], ["route_to_agent", EXE]]);
  } finally {
    server.stop(true);
  }
}, 60_000);
