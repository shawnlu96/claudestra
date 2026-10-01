/**
 * i28-W3 `manager lend inbox`（src/manager/lend-inbox.ts）：只认 bridge 的身份（带频道号、带 LEND_WORKER_MARK 都拒），参数 / 正文按 A 的推送格式严格解析，
 * 再核一遍 peer 记录与「fp 正是这个 peer 钉在 peers.json 的公钥指纹」，过不了整批 no_grant；收下的进 journal（source = push）。
 * 外加跨进程并发：几个子进程同时往同一个 journal 收单，BEGIN IMMEDIATE 下合计不超过空位。lend.json / 联系人 / peer 记录都注入，不碰 STATE_DIR。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { instanceKeySync, keyFingerprint } from "../src/lib/instance-key.js";
import type { LendFile } from "../src/lib/lend-config.js";
import { getMeta, getOrder, openLendJournal, setMeta } from "../src/lib/lend-journal.js";
import { TICK_KEY } from "../src/lib/lend-inbox.js";
import type { HttpPeer } from "../src/lib/peers.js";
import { LEND_WORKER_MARK } from "../src/lib/runtimes/clean-env.js";
import { lendInbox, type InboxDeps } from "../src/manager/lend-inbox.js";

const dir = mkdtempSync(join(tmpdir(), "lend-inbox-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const key = instanceKeySync(join(dir, "key"))!;
const FP = keyFingerprint(key.publicKey);
const HEAD = "e".repeat(40);
const NOW = Date.now();
const summary = (orderId: string) => ({ orderId, taskId: "T93", step: "review", family: "codex", repo: "shawnlu96/claudestra", pr: 270, head: HEAD, round: 1, specRev: 1, offeredAt: 1 });
const offer = (...ids: string[]) => JSON.stringify({ v: 1, proto: 2, orders: ids.map(summary) });
const lendFile = (slots = 2): LendFile => ({ version: 2, enabled: true, borrow: [], lend: [{ peer: "team-a", fp: FP, families: { codex: slots }, roles: ["review"],
  repos: ["shawnlu96/claudestra"], ordersPerDay: 50, grantedAt: new Date(NOW - 1000).toISOString(), until: new Date(NOW + 86_400_000).toISOString() }] });
const peerRec = (over: Partial<HttpPeer> = {}) => ({ name: "team-a", addedAt: "x", fp: FP, baseUrl: "relay://x", outToken: "t", publicKey: key.publicKey,
  e2e: { idk: "i", ek: {} }, ...over }) as unknown as HttpPeer;

let n = 0;
function deps(over: Partial<InboxDeps> = {}, rec: HttpPeer | null = peerRec()): InboxDeps & { journalPath: string } {
  const journalPath = join(dir, `j${++n}.sqlite`);
  const db = openLendJournal(journalPath);
  setMeta(db, TICK_KEY, String(Date.now()));
  db.close();
  return { env: {}, findPeer: async () => rec, journalPath, readLend: async () => ({ status: "ok", file: lendFile() }),
    context: async () => ({ contacts: [{ name: "team-a", fp: FP }], projects: [] }), ...over };
}
const rowOf = (path: string, id: string) => {
  const db = openLendJournal(path);
  try { return getOrder(db, id); } finally { db.close(); }
};

describe("身份", () => {
  test("带频道号（agent 会话里）或带 LEND_WORKER_MARK（出借 worker）→ forbidden，不碰 journal", async () => {
    for (const env of [{ DISCORD_CHANNEL_ID: "123" }, { [LEND_WORKER_MARK]: "1" }]) {
      const d = deps({ env });
      expect(await lendInbox(["--", "team-a", FP, offer("o1")], d)).toMatchObject({ ok: false, code: "forbidden" });
      expect(rowOf(d.journalPath, "o1")).toBeNull();
    }
  });

  test("owner 身份（频道号空着）照收", async () => {
    const d = deps({ env: { DISCORD_CHANNEL_ID: "" } });
    expect(await lendInbox(["--", "team-a", FP, offer("o1")], d)).toEqual({ ok: true, accepted: ["o1"], refused: [] });
    expect(rowOf(d.journalPath, "o1")).toMatchObject({ state: "asked", peer: "team-a", fp: FP, preview: { source: "push" } });
  });
});

describe("参数与正文", () => {
  test("少了 --、多了参数、peer 名 / 指纹不合法、不是 JSON、正文多字段 / 少字段 / 空单 → invalid", async () => {
    const bad: string[][] = [
      ["team-a", FP, offer("o1")], ["--", "team-a", FP, offer("o1"), "x"], ["--", "a b", FP, offer("o1")], ["--", "team-a", "nope", offer("o1")],
      ["--", "team-a", FP, "{"], ["--", "team-a", FP, JSON.stringify({ v: 1, proto: 2, orders: [summary("o1")], extra: 1 })],
      ["--", "team-a", FP, JSON.stringify({ v: 1, proto: 2, orders: [] })], ["--", "team-a", FP, JSON.stringify({ v: 1, orders: [summary("o1")] })],
    ];
    for (const args of bad) expect(await lendInbox(args, deps())).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("再核一遍 peer 记录与钉住的指纹", () => {
  test("没有记录、禁用、没钉公钥、没 E2E、fp 不是钉住那把钥匙的指纹 → 整批 no_grant，一行不记", async () => {
    const other = keyFingerprint(instanceKeySync(join(dir, "other"))!.publicKey);
    const cases: [HttpPeer | null, string][] = [
      [null, FP], [peerRec({ publicKey: undefined }), FP], [peerRec({ e2e: undefined }), FP], [peerRec({ outToken: undefined }), FP], [peerRec(), other],
    ];
    for (const [rec, fp] of cases) {
      const d = deps({}, rec);
      expect(await lendInbox(["--", "team-a", fp, offer("o1", "o2")], d)).toEqual({ ok: true, accepted: [],
        refused: [{ orderId: "o1", code: "no_grant" }, { orderId: "o2", code: "no_grant" }] });
      expect(rowOf(d.journalPath, "o1")).toBeNull();
    }
  });

  test("拒收的推送也记 pushAt（doctor 据此认出名字对不上的授权）", async () => {
    const d = deps({ readLend: async () => ({ status: "ok", file: { ...lendFile(), lend: [] } }) });
    await lendInbox(["--", "team-a", FP, offer("o1")], d);
    const db = openLendJournal(d.journalPath);
    expect(Number(getMeta(db, "pushAt:team-a"))).toBeGreaterThan(0);
    db.close();
  });
});

describe("跨进程并发", () => {
  test("四个子进程同时往同一个 journal 收单（各 3 张、空位 2）：合计正好收 2 张", async () => {
    const journalPath = deps().journalPath;
    const src = resolve(import.meta.dir, "../src");
    const script = (i: number) => `
      import { admitOrders } from "${src}/lib/lend-inbox.ts";
      import { openLendJournal } from "${src}/lib/lend-journal.ts";
      const db = openLendJournal(${JSON.stringify(journalPath)});
      const file = ${JSON.stringify(lendFile(2))};
      const r = await admitOrders({ db, now: () => Date.now(), readLend: async () => ({ status: "ok", file }),
        context: async () => ({ contacts: [{ name: "team-a", fp: ${JSON.stringify(FP)} }], projects: [] }) },
        { peer: "team-a", fp: ${JSON.stringify(FP)} }, ${JSON.stringify(["a", "b", "c"].map((x) => summary(`p${i}${x}`)))}, "push");
      console.log(JSON.stringify(r.accepted.length));`;
    const procs = [0, 1, 2, 3].map((i) => Bun.spawn([process.execPath, "-e", script(i)], { stdout: "pipe", stderr: "pipe", env: process.env }));
    const counts = await Promise.all(procs.map(async (p) => Number((await new Response(p.stdout).text()).trim())));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
    const db = openLendJournal(journalPath);
    expect((db.query("SELECT COUNT(*) AS n FROM lend_orders").get() as { n: number }).n).toBe(2);
    db.close();
  }, 30_000);
});
