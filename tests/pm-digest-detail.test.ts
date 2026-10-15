import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditNoticeText } from "../src/lib/ledger-audit.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { classifyPmPush, digestText, type DigestEntry } from "../src/lib/pm-digest.js";
import { PmDigestStore } from "../src/lib/pm-digest-store.js";
import { PmDigest } from "../src/bridge/pm-digest.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";

const P = "proj", PM = "agent-pm", dirs: string[] = [];
const live: PmDigest[] = [];
afterEach(() => { for (const d of live.splice(0)) d.stop(); for (const d of dirs.splice(0)) { closeLedger(join(d, "ledger.sqlite")); rmSync(d, { recursive: true, force: true }); } });
const ws = { send: () => {} } as unknown as LocalEndpoint["ws"];
const pmTo: LocalEndpoint = { kind: "local", agentName: PM, channelId: "ch-pm", ws };
let seq = 0;
const env = (from: Envelope["from"], content: string, oneShot = true): Envelope => ({
  from, to: pmTo, intent: "request", content,
  meta: { messageId: `m${++seq}`, threadId: `t${seq}`, ts: "2026-10-11T00:00:00Z", triggerKind: "agent_tool", ...(oneShot ? { skipInterAgentWatchdog: true } : {}) },
});
const agent = (name: string, text: string) => env({ kind: "local", agentName: name, channelId: "", ws }, text);
const audit = (list: [string, string][]) => env({ kind: "bridge", label: "ledger-audit" },
  auditNoticeText(list.map(([taskId, detail]) => ({ project: P, taskId, detail, suggestion: "核一下" })), "manager ledger audit"));
/** 推送摘要搭的立即送：执行者等回复的消息（owner / peer 的消息不搭） */
const execMsg = () => env({ kind: "local", agentName: "agent-x", channelId: "ch-x", ws }, "执行者问 PM", false);
const POST_VERIFY = "[上线后待办] agents-PV1 已上线，规格要求 PM 接着做：\n- 核对线上摘要\n- 切开关到 on\n做完用 ledger post-verify-done agents-PV1 结掉。";

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "pm-digest-detail-"));
  dirs.push(dir);
  const db = openLedger(join(dir, "ledger.sqlite"));
  setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: [PM] });
  const path = join(dir, "pm-digest.json");
  const store = new PmDigestStore(path, join(dir, "pm-digest-mode.json"));
  await store.setMode(P, "on");
  await store.setPullMode(P, "off"); // 这里测的是推送摘要的拼法
  const sent: string[] = [];
  const raw = async (e: Envelope): Promise<Delivery> => (sent.push(e.content), { envelope: e, outcome: { kind: "sent" } });
  const digest = new PmDigest({ store, now: () => 1_000_000, db: () => db, agents: () => [], heldCarriers: () => new Set() });
  live.push(digest);
  const send = (e: Envelope) => digest.wrap(raw, db, P)(e, pmTo);
  /** 让执行者的一条立即送把队列摘要带出来，返回摘要块（正文之前的部分） */
  const flush = async (): Promise<string> => (await send(execMsg()), sent.at(-1)!.replace(/\n\n执行者问 PM$/, ""));
  return { path, store, sent, send, flush };
}

test("[验收线 1] 两项的巡检推送：摘要里有两张卡号和各自的现象，没有『全部未解决的』那行", async () => {
  const w = await world();
  await w.send(audit([["agents-AA1", "合并 3 天没人收尾"], ["web-BB2", "卡在 review 没有审查员"]]));
  expect(w.sent).toEqual([]);
  const text = await w.flush();
  expect(text).toContain("agents-AA1");
  expect(text).toContain("合并 3 天没人收尾");
  expect(text).toContain("web-BB2");
  expect(text).toContain("卡在 review 没有审查员");
  expect(text).not.toContain("全部未解决的");
  expect(w.store.queued(P)).toEqual([]);
});

test("[验收线 2] 两轮条数相同、内容不同的巡检：摘要里是两行，各带自己的要点", async () => {
  const w = await world();
  await w.send(audit([["agents-AA1", "现象甲"], ["agents-AA2", "现象乙"]]));
  await w.send(audit([["agents-CC3", "现象丙"], ["agents-CC4", "现象丁"]]));
  const lines = (await w.flush()).split("\n");
  expect(lines.filter((l) => /^\d+\. /.test(l))).toHaveLength(2);
  expect(lines.join("\n")).not.toContain("×2");
  const second = lines.findIndex((l) => l.startsWith("2. "));
  expect(lines.slice(1, second).join("\n")).toContain("现象甲");
  expect(lines.slice(1, second).join("\n")).not.toContain("现象丙");
  expect(lines.slice(second).join("\n")).toContain("agents-CC3");
  expect(lines.slice(second).join("\n")).toContain("现象丁");
});

test("[验收线 3] 上线后待办：本行下面列出待办行；同卡同内容两次仍合成一行 ×2", async () => {
  const w = await world();
  await w.send(agent("scheduler", POST_VERIFY));
  await w.send(agent("scheduler", POST_VERIFY));
  const lines = (await w.flush()).split("\n");
  expect(lines.filter((l) => /^\d+\. /.test(l))).toHaveLength(1);
  expect(lines[1]).toContain("agents-PV1");
  expect(lines[1]).toContain("（×2）");
  expect(lines.slice(2)).toEqual(["   - 核对线上摘要", "   - 切开关到 on", "   做完用 ledger post-verify-done agents-PV1 结掉。"]);
});

test("[验收线 3] 监工巡检列出两行要点；出借服务的进度同步仍只一行、没有 detail", async () => {
  const w = await world();
  await w.send(agent("supervise-watch", "[监工巡检 · 新异常 2 条]\n- agent-a 静默 40 分钟\n- agent-b 的卡两轮没动"));
  await w.send(agent("lend-service", "出借：Sekai 领了开工单\n单号 lend:agents-X1:s1:r0:a0"));
  const queue = w.store.queued(P);
  expect(queue.map((e) => e.detail)).toEqual([["- agent-a 静默 40 分钟", "- agent-b 的卡两轮没动"], undefined]);
  expect("detail" in queue[1]!).toBe(false);
  expect((await w.flush()).split("\n").slice(1)).toEqual([
    "1. supervise-watch · [监工巡检 · 新异常 2 条]", "   - agent-a 静默 40 分钟", "   - agent-b 的卡两轮没动",
    "2. lend-service · 出借：Sekai 领了开工单",
  ]);
});

test("[验收线 4] 没有 detail 的旧队列条目照常读出、送出；detail 不是字符串数组按损坏处理", async () => {
  const w = await world();
  const old = { id: "old1", project: P, kind: "audit", source: "ledger-audit", firstLine: "[🔎 台账巡检] 新发现 1 条", at: 1 };
  writeFileSync(w.path, JSON.stringify({ queue: [old], log: [] }));
  expect(w.store.queued(P)).toEqual([old as DigestEntry]);
  expect((await w.flush()).split("\n").slice(1)).toEqual(["1. ledger-audit · [🔎 台账巡检] 新发现 1 条"]);
  expect(w.store.queued(P)).toEqual([]);

  for (const detail of ["一行", [1], [null], {}, null]) {
    const bad = JSON.stringify({ queue: [{ ...old, detail }], log: [] });
    writeFileSync(w.path, bad);
    expect(w.store.queued(P)).toEqual([]); // 读者按空
    const before = w.sent.length;
    await w.send(agent("scheduler", POST_VERIFY)); // 写者拒写：这条照常立即送，不吞
    expect(w.sent.slice(before)).toEqual([POST_VERIFY]);
    expect(readFileSync(w.path, "utf-8")).toBe(bad);
  }
  writeFileSync(w.path, JSON.stringify({ queue: [{ ...old, detail: ["a", "b"] }, { ...old, id: "old2", detail: [] }], log: [] }));
  expect(w.store.queued(P).map((e) => e.detail)).toEqual([["a", "b"], []]);
});

test("detail 最多 6 行、每行截断，多出的写『还有 N 条』；巡检的收尾行不算在内", () => {
  const body = auditNoticeText(Array.from({ length: 9 }, (_, i) => ({ project: P, taskId: `agents-T${i}AA`, detail: i ? "现象" : "长".repeat(300), suggestion: "核一下" })), "cmd");
  const v = classifyPmPush({ fromKind: "bridge", sender: "ledger-audit", intent: "notification", triggerKind: "bridge_synth", oneShot: true, body });
  if (v.send !== "digest") throw new Error("应进摘要");
  expect(v.detail).toHaveLength(7);
  expect(v.detail![0]!.length).toBe(120);
  expect(v.detail![5]).toContain("agents-T5AA");
  expect(v.detail![6]).toBe("还有 3 条");
  expect(v.firstLine).toContain("新发现 9 条");
  const text = digestText([{ id: "a", project: P, kind: v.kind, source: v.source, firstLine: v.firstLine, detail: v.detail, at: 1 }]);
  expect(text.split("\n")).toHaveLength(9);
  expect(text.split("\n").at(-1)).toBe("   还有 3 条");
});

test("归类不变：只有首行的推送没有 detail；非 supervise-watch 的 sync 多行也不取", () => {
  const base = { intent: "request", triggerKind: "agent_tool", oneShot: true } as const;
  const one = classifyPmPush({ ...base, fromKind: "local", sender: "scheduler", body: "[上线后待办] agents-PV1 上线后 PM 步骤已过期，之后不再提醒" });
  const sync = classifyPmPush({ ...base, fromKind: "local", sender: "agent-w", body: "agents-AAA1 进度：写完了一半\n第二行\n第三行" });
  expect(one).toEqual({ send: "digest", reason: "调度器上线后待办提醒", kind: "post-verify", source: "scheduler", card: "agents-PV1", firstLine: "[上线后待办] agents-PV1 上线后 PM 步骤已过期，之后不再提醒" });
  expect(sync).toEqual({ send: "digest", reason: "agent oneShot 进度同步", kind: "sync", source: "agent-w", card: "agents-AAA1", firstLine: "agents-AAA1 进度：写完了一半" });
  // 同卡、要点不同的两条上线后待办不合并
  const e = (id: string, detail: string[]): DigestEntry => ({ id, project: P, kind: "post-verify", source: "scheduler", card: "agents-PV1", firstLine: "[上线后待办] agents-PV1 已上线", detail, at: 1 });
  expect(digestText([e("a", ["- 甲"]), e("b", ["- 乙"]), e("c", ["- 甲"])]).split("\n").slice(1))
    .toEqual(["1. scheduler · agents-PV1 · [上线后待办] agents-PV1 已上线（×2）", "   - 甲", "2. scheduler · agents-PV1 · [上线后待办] agents-PV1 已上线", "   - 乙"]);
});
