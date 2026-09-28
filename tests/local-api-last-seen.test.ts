/**
 * 协作视图「上次以来」（T12c）：lib/last-seen.ts 的只往前走、bridge/local-api/last-seen.ts 的门与项目校验、
 * 以及台账总览 ?since= 下发的 sinceEvents（lib/ledger-since.ts）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLedgerFeedForTest } from "../src/bridge/ledger-feed.js";
import { setWebStatePathForTest } from "../src/bridge/local-api/db.js";
import { handleLocalApi, LOCAL_API_FEATURES } from "../src/bridge/local-api/index.js";
import { setLedgerApiProjectsForTest } from "../src/bridge/local-api/ledger.js";
import { effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import { getLastSeen, markSeen } from "../src/lib/last-seen.js";
import { SINCE_EVENTS_LIMIT, sinceEvents } from "../src/lib/ledger-since.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask } from "../src/lib/ledger-write.js";
import type { Principal } from "../src/lib/principals.js";
import { closeWebState, openWebState } from "../src/lib/web-state.js";
import { seedLedger, tempLedgerPath } from "./ledger-test-helpers.js";

const at = "2026-09-28T00:00:00Z";
const cred = (id: string, grant: Grant): DeviceCredential => ({ id, v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const FULL: Grant = { agents: ["*"], terminal: true, manage: true };
const phone = effectivePrincipal({ principal: OWNER_BASE, credential: cred("dev_phone", FULL) });
const laptop = effectivePrincipal({ principal: OWNER_BASE, credential: cred("dev_laptop", { ...FULL, terminal: false }) });
const oldToken: Principal = { id: "token:tok_old", role: "external", agents: ["*"], createdAt: at };

const DENIED: [string, Principal][] = [
  ["owner 设备 · 部分 scope", effectivePrincipal({ principal: OWNER_BASE, credential: cred("dev_p", { agents: ["worker"], terminal: true, manage: true }) })],
  ["owner 设备 · manage 关", effectivePrincipal({ principal: OWNER_BASE, credential: cred("dev_m", { agents: ["*"], terminal: false, manage: false }) })],
  ["guest", effectivePrincipal({ principal: { id: "guest:g", role: "external", agents: ["*"], createdAt: at }, credential: cred("dev_g", FULL) })],
  ["peer token", { id: "token:tok_peer", role: "external", agents: ["*"], peer: "P", createdAt: at }],
];

const root = mkdtempSync(join(tmpdir(), "last-seen-"));
const webPath = join(root, "web-state.sqlite");
const ledgerPath = tempLedgerPath();

beforeAll(() => {
  writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "P", dirs: [] }, { id: "q", name: "Q", dirs: [] }] }));
  setLedgerApiProjectsForTest(join(root, "projects.json"));
  setWebStatePathForTest(webPath);
  seedLedger(ledgerPath);
  const db = openLedger(ledgerPath);
  // 导入回填的事件（approxTime）不算「离开期间发生的」；非建任务的 task 事件不上摘要
  appendEvent(db, { actor: "import", now: 1000, approxTime: true }, { project: "p", target: "T1", kind: "verify", text: "回填", data: { result: "pass" } });
  appendEvent(db, { actor: "agent-pm", now: 1100 }, { project: "p", target: "T1", kind: "verify", text: "\n  线上验证失败：首屏白屏\n第二行不下发", data: { result: "fail", secret: "x" } });
  appendEvent(db, { actor: "agent-pm", now: 1200 }, { project: "p", target: "", kind: "note", text: "项目级的不算" });
  createTask(db, { actor: "owner", now: 1300 }, { project: "p", id: "T9", title: "新派", kind: "code", agent: "agent-x" });
  closeLedger(ledgerPath);
  setLedgerFeedForTest({ path: ledgerPath, emit: () => {} });
});
afterAll(() => {
  setLedgerApiProjectsForTest(undefined);
  setLedgerFeedForTest(undefined);
  closeWebState(webPath);
  setWebStatePathForTest(undefined);
});

async function call(path: string, p: Principal = phone, method = "GET"): Promise<Response> {
  const r = new Request(`http://bridge.local/api/v1${path}`, { method });
  return (await handleLocalApi(r, new URL(r.url), p))!;
}

describe("lib/last-seen", () => {
  test("没记过 → null；只往前走：更早的 now 不会把它拨回去；按 principal × scope 分开", () => {
    const db = openWebState(":memory:");
    try {
      expect(getLastSeen(db, "owner:self", "collab:p")).toBeNull();
      expect(markSeen(db, "owner:self", "collab:p", 500)).toBe(500);
      expect(markSeen(db, "owner:self", "collab:p", 300)).toBe(500);
      expect(markSeen(db, "owner:self", "collab:p", 900)).toBe(900);
      expect(getLastSeen(db, "owner:self", "collab:q")).toBeNull();
      expect(getLastSeen(db, "token:tok_old", "collab:p")).toBeNull();
    } finally {
      closeWebState(":memory:");
    }
  });
});

describe("GET/PUT /me/last-seen/:project", () => {
  test("能力表里有 last-seen；不能读台账的凭据一律 403（在查项目之前）", async () => {
    expect(LOCAL_API_FEATURES).toContain("last-seen");
    for (const [, p] of DENIED) {
      expect((await call("/me/last-seen/p", p)).status).toBe(403);
      expect((await call("/me/last-seen/nope", p, "PUT")).status).toBe(403);
    }
  });

  test("项目不在 projects.json → 404；其它方法 → 405；坏编码 → 400", async () => {
    expect((await call("/me/last-seen/nope")).status).toBe(404);
    expect((await call("/me/last-seen/p", phone, "POST")).status).toBe(405);
    expect((await call("/me/last-seen/%E0%A4%A", phone)).status).toBe(400);
  });

  test("PUT 用服务端时刻；owner 的两台设备是同一个 principal，互相看得到；老 * token 单独一份；项目之间互不影响", async () => {
    const first = (await (await call("/me/last-seen/p")).json()) as { lastSeen: number | null; now: number };
    expect(first.lastSeen).toBeNull();
    const before = Date.now();
    const put = (await (await call("/me/last-seen/p", phone, "PUT")).json()) as { ok: boolean; lastSeen: number; now: number };
    expect(put.ok).toBe(true);
    expect(put.lastSeen).toBeGreaterThanOrEqual(before);
    expect(put.lastSeen).toBe(put.now);
    expect(((await (await call("/me/last-seen/p", laptop)).json()) as { lastSeen: number }).lastSeen).toBe(put.lastSeen);
    expect(((await (await call("/me/last-seen/p", oldToken)).json()) as { lastSeen: null }).lastSeen).toBeNull();
    expect(((await (await call("/me/last-seen/q")).json()) as { lastSeen: null }).lastSeen).toBeNull();
  });
});

describe("GET /ledger/:project?since=", () => {
  test("不带 since 不下发 sinceEvents；带了只给之后的任务事件（导入回填、项目级、非建任务的 task 事件都不算）", async () => {
    expect(((await (await call("/ledger/p")).json()) as Record<string, unknown>).sinceEvents).toBeUndefined();
    expect(((await (await call("/ledger/p?since=abc")).json()) as Record<string, unknown>).sinceEvents).toBeUndefined();
    const body = (await (await call("/ledger/p?since=500")).json()) as { sinceEvents: { ts: number; target: string; kind: string; text: string; data: Record<string, unknown> }[] };
    expect(body.sinceEvents.map((e) => [e.ts, e.target, e.kind])).toEqual([
      [520, "T1", "review"],
      [520, "T1", "stage"],
      [600, "T2", "task"],
      [1100, "T1", "verify"],
      [1300, "T9", "task"],
    ]);
  });

  test("text 只留首个非空行，data 只留摘要要的键", async () => {
    const body = (await (await call("/ledger/p?since=1050")).json()) as { sinceEvents: { kind: string; text: string; data: Record<string, unknown> }[] };
    const verify = body.sinceEvents.find((e) => e.kind === "verify")!;
    expect(verify.text).toBe("线上验证失败：首屏白屏");
    expect(verify.data).toEqual({ result: "fail" });
  });

  test("上限 SINCE_EVENTS_LIMIT 条，保留最新的，seq 升序", () => {
    const path = tempLedgerPath();
    const db = openLedger(path);
    try {
      createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "t", kind: "code", agent: "a" });
      for (let i = 0; i < SINCE_EVENTS_LIMIT + 30; i++) appendEvent(db, { actor: "a", now: 10 + i }, { project: "p", target: "T1", kind: "verify", data: { result: "pass" } });
      const got = sinceEvents(db, "p", 0);
      expect(got.length).toBe(SINCE_EVENTS_LIMIT);
      expect(got.at(-1)!.ts).toBe(10 + SINCE_EVENTS_LIMIT + 29);
      expect(got[0].seq).toBeLessThan(got[1].seq);
    } finally {
      closeLedger(path);
    }
  });
});
