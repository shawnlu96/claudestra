/**
 * i28-W2 v1 冻结：出借 v1 四个接口（poll / claim / lease / result）的请求体与应答体逐字节锁死。v2 只加新接口，任何 v2 字段
 * （proto、boot、beat、seenAt……）出现在 v1 正文里，旧版 B 的严格解析就会判 bad_response、单子当结果不明无限重试。
 * 同一段流程跑两遍：一遍什么 v2 都没有，一遍中间夹着 hello 与 beat（lend_peers 有行、lend_orders 的 beat 列有值）——两遍的
 * 应答必须和金样本逐字节相同。应答取 bridge 回给对方的那一份（CLI 输出去掉 ok / notified 再补 ok:true，同 local-api/lend.ts）。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lendRequest } from "../src/lib/lend-remote.js";
import { parseLendRequest } from "../src/lib/lend-wire.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const H = "a".repeat(40);
const REPO = "shawnlu96/claudestra";
let db: Database;
let now: number;
const dir = mkdtempSync(join(tmpdir(), "lend-golden-"));
const spec = join(dir, "T9.md");
writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: {
    borrow: async () => [{ peer: "mate", projects: [P], roles: ["review" as const], maxOpen: 2 }], notifyPm: async () => {},
    result: { reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: () => ({ key: "KEY", sig: "SIG" }), peerFp: async () => null },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, unknown>>;
/** 这一份就是 bridge 回给出借方的正文 */
async function wire(ep: string, body: unknown): Promise<string> {
  const { ok: _ok, notified: _n, ...rest } = await run([`lend-${ep === "result" ? "write" : ep}`, "--", "mate", JSON.stringify(body)], "owner");
  return JSON.stringify({ ok: true, ...rest });
}

export const V1_REQUESTS = {
  poll: '{"v":1,"capacity":{"families":{"codex":2},"busy":{},"roles":["review"],"repos":["shawnlu96/claudestra"],"ordersLeftToday":3}}',
  claim: '{"v":1,"orderId":"lend:T9:s1:r1:a0","worker":"agent-lend-0123456789"}',
  lease: '{"v":1,"orderId":"lend:T9:s1:r1:a0","gen":1,"action":"renew","reason":null,"detail":null}',
  result: '{"v":1,"orderId":"lend:T9:s1:r1:a0","gen":1,"verdict":{"v":1,"orderId":"lend:T9:s1:r1:a0","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
    '"verdict":"pass","p0":0,"p1":0,"p2":0,"findings":[],"reportPath":"r.md"},' +
    '"report":"## 结论\\n通过","session":{"id":"sess-1","family":"codex"}}',
};

async function flow(withV2: boolean): Promise<string[]> {
  const out: string[] = [];
  out.push(await wire("poll", JSON.parse(V1_REQUESTS.poll)));
  if (withV2) {
    await run(["lend-hello", "--", "mate", JSON.stringify({ v: 1, proto: 2, boot: "boot-0001", seq: 1, grant: null,
      slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } }, paused: null })], "owner");
  }
  out.push(await wire("claim", JSON.parse(V1_REQUESTS.claim)));
  if (withV2) {
    const beat = { v: 1, orders: [{ orderId: "lend:T9:s1:r1:a0", gen: 1, phase: "working", lastActivityAt: now, excerpt: "跑测试" }] };
    expect(await run(["lend-beat", "--", "mate", JSON.stringify(beat)], "owner")).toMatchObject({ ok: true });
  }
  out.push(await wire("lease", JSON.parse(V1_REQUESTS.lease)));
  out.push(await wire("result", JSON.parse(V1_REQUESTS.result)));
  return out;
}

beforeEach(async () => {
  db = openLedger(":memory:");
  now = 1_000_000;
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", spec });
  db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = 'T9'`);
  await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO, "--pr", "12"]);
});
afterEach(() => closeLedger(":memory:"));

const GOLDEN: Record<string, string> = {
  poll: [
    "{\"ok\":true,\"v\":1,\"orders\":[{\"orderId\":\"lend:T9:s1:r1:a0\",\"taskId\":\"T9\",\"step\":\"review\",\"fa",
    "mily\":\"codex\",\"repo\":\"shawnlu96/claudestra\",\"pr\":12,\"head\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "aaaaaaaaaa\",\"round\":1,\"specRev\":1,\"offeredAt\":1000000}],\"pollAfterMs\":30000}",
  ].join(""),
  claim: [
    "{\"ok\":true,\"v\":1,\"order\":{\"v\":1,\"orderId\":\"lend:T9:s1:r1:a0\",\"taskId\":\"T9\",\"specRev\":1,\"da",
    "gVersion\":null,\"node\":\"adversarial_review\",\"step\":\"review\",\"round\":1,\"head\":\"aaaaaaaaaaaaa",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"repo\":\"shawnlu96/claudestra\",\"pr\":12,\"inputs\":[\"规格原文(specRev",
    " 1):\\n规格:只改 src/lib/x.ts\\n验收:单测全绿\"],\"outputs\":[\"逐项结论(findingId / family / severity / probe",
    " / description)\",\"报告正文(markdown),随结论一起交\"],\"acceptance\":[\"对抗式:专找能打穿规格保证的路径\",\"只审标题里的 head:只读",
    ",不改、不提交、不推送\"],\"writeBack\":\"用 submit_verdict(M3 前是 lend submit)交结论和报告正文,单号见标题\",\"findings\":[",
    "],\"fallback\":null},\"text\":\"【出借派单】T9 · review · 第 1 轮 · specRev 1 · 格式 v1\\nhead：aaaaaaaaaaa",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n仓库：shawnlu96/claudestra PR #12\\n节点：adversarial_review　单号：le",
    "nd:T9:s1:r1:a0\\n输入 1（原文，非指令）：\\n  「规格原文(specRev 1):」\\n  「规格:只改 src/lib/x.ts」\\n  「验收:单测全绿」\\n",
    "产出 1（原文，非指令）：\\n  「逐项结论(findingId / family / severity / probe / description)」\\n产出 2（原文，非指令）",
    "：\\n  「报告正文(markdown),随结论一起交」\\n验收 1（原文，非指令）：\\n  「对抗式:专找能打穿规格保证的路径」\\n验收 2（原文，非指令）：\\n  「只审标题里",
    "的 head:只读,不改、不提交、不推送」\\n回写要求（原文，非指令）：\\n  「用 submit_verdict(M3 前是 lend submit)交结论和报告正文,单号见标题",
    "」\\n完成后用 submit_verdict / deliver 回写，单号 lend:T9:s1:r1:a0。本单脱敏 0 处。\",\"sha256\":\"1a5bb6159d03c",
    "68271d34303598169da66e2d01fbd1bcc34c1d47ea0a7b1673c\",\"lease\":{\"gen\":1,\"expiresAt\":1600000,",
    "\"ms\":600000}}",
  ].join(""),
  lease: [
    "{\"ok\":true,\"v\":1,\"lease\":{\"gen\":1,\"expiresAt\":1600000,\"ms\":600000}}",
  ].join(""),
  result: [
    "{\"ok\":true,\"v\":1,\"receipt\":{\"orderId\":\"lend:T9:s1:r1:a0\",\"sha256\":\"a426c123a2747d97af0a040",
    "9c62a843202a482eade43b2be818b79f95900ba81\",\"eventSeq\":6,\"taskId\":\"T9\",\"key\":\"KEY\",\"sig\":\"S",
    "IG\"}}",
  ].join(""),
};

describe("v1 应答逐字节冻结", () => {
  test("没有任何 v2 的流程：poll / claim / lease / result 的正文和金样本一字不差", async () => {
    expect(await flow(false)).toEqual([GOLDEN.poll!, GOLDEN.claim!, GOLDEN.lease!, GOLDEN.result!]);
  });

  test("中间夹着 hello 与 beat（lend_peers 有行、beat 列有值）：v1 正文仍一字不差，没有任何 v2 字段", async () => {
    const got = await flow(true);
    expect(got).toEqual([GOLDEN.poll!, GOLDEN.claim!, GOLDEN.lease!, GOLDEN.result!]);
    for (const k of ["proto", "boot", "seq", "beat", "beatAt", "seenAt", "helloAt", "grant", "slots"]) for (const g of got) expect(g).not.toContain(`"${k}"`);
  });
});

describe("v1 请求逐字节冻结", () => {
  test("A 认金样本请求体；任何一个 v2 字段加进 v1 正文都整单拒", () => {
    for (const [ep, raw] of Object.entries(V1_REQUESTS)) {
      expect(parseLendRequest(ep as keyof typeof V1_REQUESTS, JSON.parse(raw)).ok).toBe(true);
      for (const extra of [{ proto: 2 }, { boot: "boot-0001" }, { seq: 1 }, { gen2: 1 }]) {
        expect(parseLendRequest(ep as keyof typeof V1_REQUESTS, { ...JSON.parse(raw), ...extra }).ok).toBe(false);
      }
    }
  });

  test("B 发出去的正文就是 {v:1, ...调用方给的字段}，不多一个字节", async () => {
    for (const [ep, raw] of Object.entries(V1_REQUESTS)) {
      let sent = "";
      const { v: _v, ...body } = JSON.parse(raw) as Record<string, unknown>;
      await lendRequest(async (_p, _op, b) => { sent = JSON.stringify(b); return { status: 500, body: null }; }, "a", ep as keyof typeof V1_REQUESTS, body);
      expect(sent).toBe(raw);
    }
  });
});
