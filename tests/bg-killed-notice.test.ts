/** BGW-1 接线：执行者会话出现「上一轮后台任务没跑完」→ 经 deliver 发一条信息类提醒；去重 / 冷却 / 只对执行者 / 忙则押后 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bgKilledTicker, type BgKilledAgent, type BgKilledDeps } from "../src/bridge/bg-killed-notice.ts";
import { BG_KILLED_COOLDOWN_MS, BG_KILLED_FRESH_MS } from "../src/lib/bg-killed.ts";
import type { Envelope } from "../src/bridge/router.ts";

const dir = mkdtempSync(join(tmpdir(), "bgw1-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const note = (ids: string[], at = T0) => JSON.stringify({
  type: "user", origin: { kind: "task-notification" }, timestamp: new Date(at).toISOString(),
  message: {
    role: "user",
    content: ["<task-notification>", ...ids.map((i) => `<task-id>${i}</task-id>`),
      "<status>stopped</status>", `<summary>${ids.length} background shell command tasks didn't finish before the previous session ended.</summary>`,
      "</task-notification>"].join("\n"),
  },
}) + "\n";

let seq = 0;
function rig(names: string[], over: Partial<BgKilledDeps> = {}) {
  const agents: BgKilledAgent[] = names.map((name) => ({ name, channelId: `ch-${name}`, cwd: "/x", sessionId: `s${++seq}` }));
  const file = (a: BgKilledAgent) => join(dir, `${a.sessionId}.jsonl`);
  for (const a of agents) writeFileSync(file(a), JSON.stringify({ type: "assistant" }) + "\n");
  const sent: Envelope[] = [];
  const held: Envelope[] = [];
  const clients = new Map(agents.map((a) => [a.channelId, { ws: {} as never, channelId: a.channelId }]));
  const clock = { t: T0 };
  const tick = bgKilledTicker({
    clients, hold: (e) => held.push(e), lastMessageSource: { set: () => undefined },
    deliver: async (e) => (sent.push(e), { outcome: { kind: "sent" } }),
    agents: async () => agents, busy: async () => false, now: () => clock.t, jsonlPath: file, statePath: join(dir, `state-${seq}.json`), ...over,
  });
  return { agents, file, sent, held, clients, clock, tick, write: (a: BgKilledAgent, s: string) => appendFileSync(file(a), s) };
}

describe("bgKilledTicker", () => {
  test("执行者会话出现通知 → 一条信息类提醒（taskId + 信号不会再来），走 deliver 到该 agent", async () => {
    const r = rig(["agent-task-a"]);
    await r.tick(); // 首次挂上会话
    r.write(r.agents[0], note(["bamzw177e", "bqkfq1e4n", "__orphan_summary__:shell"]));
    await r.tick();
    expect(r.sent).toHaveLength(1);
    const e = r.sent[0];
    expect(e.intent).toBe("notification");
    expect(e.from).toEqual({ kind: "bridge", label: "bg-killed" });
    expect(e.to).toMatchObject({ kind: "local", channelId: "ch-agent-task-a", agentName: "agent-task-a" });
    for (const s of ["bamzw177e", "bqkfq1e4n", "信号不会再来", "重跑", "交付"]) expect(e.content).toContain(s);
    expect(e.content).not.toContain("__orphan_summary");
  });

  test("重复信号不刷屏：同一批 taskId 只一次；冷却内的新批次攒到冷却过后合成一条", async () => {
    const r = rig(["agent-task-a"]);
    await r.tick();
    r.write(r.agents[0], note(["t1"]));
    await r.tick();
    r.write(r.agents[0], note(["t1"])); // 同一批又报一次
    await r.tick();
    expect(r.sent).toHaveLength(1);
    r.clock.t += 60_000; // 会话又重启，杀了新一批
    r.write(r.agents[0], note(["t2"], r.clock.t));
    await r.tick();
    r.write(r.agents[0], note(["t3"], r.clock.t));
    await r.tick();
    expect(r.sent).toHaveLength(1);
    r.clock.t = T0 + BG_KILLED_COOLDOWN_MS;
    await r.tick();
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1].content).toContain("t2、t3");
    await r.tick();
    expect(r.sent).toHaveLength(2);
  });

  test("负例：master 与人类会话收到同样的通知也不提醒", async () => {
    const r = rig(["agent-master", "master", "agent-claudestra-debug", "agent-future_data"]);
    await r.tick();
    for (const a of r.agents) r.write(a, note(["t1"]));
    await r.tick();
    expect(r.sent).toHaveLength(0);
    expect(r.held).toHaveLength(0);
  });

  test("执行者正忙：进押后队列（回合结束再投），不直接打断", async () => {
    const r = rig(["agent-task-a"], { busy: async () => true });
    await r.tick();
    r.write(r.agents[0], note(["t1"]));
    await r.tick();
    await r.tick();
    expect(r.sent).toHaveLength(0);
    expect(r.held).toHaveLength(1);
    expect(r.held[0].meta.waitForIdle).toBe(true);
  });

  test("channel-server 还没连上：先不发，连上后补发一次", async () => {
    const r = rig(["agent-task-a"]);
    const c = r.clients.get("ch-agent-task-a")!;
    r.clients.delete("ch-agent-task-a");
    await r.tick();
    r.write(r.agents[0], note(["t1"]));
    await r.tick();
    expect(r.sent).toHaveLength(0);
    r.clients.set("ch-agent-task-a", c);
    await r.tick();
    await r.tick();
    expect(r.sent).toHaveLength(1);
  });

  test("bridge 重启后首读：已在文件里的新鲜通知照发，陈旧的不补发", async () => {
    const r = rig(["agent-task-a", "agent-task-b"]);
    r.write(r.agents[0], note(["fresh"], T0 - 60_000));
    r.write(r.agents[1], note(["stale"], T0 - BG_KILLED_FRESH_MS - 1));
    await r.tick();
    expect(r.sent.map((e) => (e.to as { agentName?: string }).agentName)).toEqual(["agent-task-a"]);
  });

  test("notice-completed：completed 通知（description 带这句话）不提醒，也不占 taskId 的去重", async () => {
    const r = rig(["agent-task-a"]);
    await r.tick();
    r.write(r.agents[0], JSON.stringify({
      type: "user", origin: { kind: "task-notification" }, timestamp: new Date(T0).toISOString(),
      message: { role: "user", content: "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n"
        + "<summary>Background command \"Inspect tasks that didn't finish before the previous session ended\" completed (exit code 0)</summary>\n</task-notification>" },
    }) + "\n");
    await r.tick();
    expect(r.sent).toHaveLength(0);
    r.write(r.agents[0], note(["t1"]));
    await r.tick();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].content).toContain("t1");
  });

  test("notice-tail：1 分钟前的被杀通知后面又写了 30 条约 20KB 的记录，首扫也要投出", async () => {
    const r = rig(["agent-task-a"]);
    r.write(r.agents[0], note(["deep"], T0 - 60_000));
    const pad = "x".repeat(20_000);
    for (let i = 0; i < 30; i++) {
      r.write(r.agents[0], JSON.stringify({ type: "user", timestamp: new Date(T0 - 50_000 + i * 1000).toISOString(), toolUseResult: { stdout: pad } }) + "\n");
    }
    await r.tick();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].content).toContain("deep");
  });

  test("bg-killed-dedup-restart：bridge 重启（新 ticker、同一状态文件）不再提醒同一 taskId", async () => {
    const r = rig(["agent-task-a"]);
    r.write(r.agents[0], note(["t1"], T0 - 60_000));
    await r.tick();
    expect(r.sent).toHaveLength(1);
    const again: Envelope[] = [];
    const t2 = bgKilledTicker({
      clients: r.clients, hold: () => undefined, lastMessageSource: { set: () => undefined },
      deliver: async (e) => (again.push(e), { outcome: { kind: "sent" } }),
      agents: async () => r.agents, busy: async () => false, now: () => r.clock.t + 30_000, jsonlPath: r.file, statePath: join(dir, `state-${seq}.json`),
    });
    await t2();
    await t2();
    expect(again).toHaveLength(0);
  });
});
