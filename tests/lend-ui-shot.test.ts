/**
 * LENDUI1 收图：POST /api/v1/lend/shot 的格式规则（lib/lend-ui-wire.ts）、谁能传与落盘（lib/lend-ui-store.ts）、路由与闸
 * （bridge/local-api/lend-shot.ts）。台账经 `ledger lend-*` CLI（runLedger）跑内存库，工件根是临时目录；拒收一律核「目录逐字节不变」。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLendShotApi, lendShotApi } from "../src/bridge/local-api/lend-shot.js";
import { setRequestContext } from "../src/bridge/request-context.js";
import { stripImageMeta } from "../src/lib/image-meta-strip.js";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { uiDeliverPort } from "../src/lib/ledger-deliver-ui-port.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { readLendUiProvenance } from "../src/lib/lend-ui-provenance.js";
import { LEND_SHOT_LIMITS, lendShotBody, parseLendShot } from "../src/lib/lend-ui-wire.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { parseUiEvidence, uiEvidenceDigest } from "../src/lib/order-deliver-ui.js";
import { messagesOnlyAllows } from "../src/lib/peer-scope-gate.js";
import type { Principal } from "../src/lib/principals.js";
import { RECOVERY_KEYS, recoveryPolicy, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const BASE = "b".repeat(40);
const H2 = "c".repeat(40);
const H3 = "d".repeat(40);
const REPO = "shawnlu96/claudestra";
const FP = "abcd-ef01-2345-6789";
const BR = "lend/T9-abcd";
const WORKER = "agent-lend-0123456789";
let db: Database;
let now: number;
let remote: Record<string, RemoteHead>;
let root: string;
let mode: RecoveryMode;
let logs: string[];
/** 收图读开关的那一刻（已在这一单的串行段里、核过持单之后）要做的事：模拟「处理期间」台账变了 */
let duringReceive: (() => void) | null;
const dir = mkdtempSync(join(tmpdir(), "lend-ui-shot-test-"));
const key = instanceKeySync(dir);
const borrow: BorrowEntry[] = ["mate", "other"].map((peer) => ({ peer, projects: [P], roles: ["review", "write"], maxOpen: 2 }));

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: {
    borrow: async () => borrow, notifyPm: async () => {},
    result: {
      reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, key),
      remoteHead: async (_repo: string, branch: string): Promise<RemoteHead> => remote[branch] ?? { ok: false, error: "没有这个分支" },
      peerFp: async () => FP,
    },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
const call = (ep: string, body: unknown) => run([`lend-${ep}`, "--", "mate", JSON.stringify(body)], "owner");
const deliverBody = (orderId: string, head: string) => ({ v: 1, orderId, gen: 1, branch: BR, pr: 7, session: { id: "sess-1", family: "codex" },
  deliver: { v: 1, orderId, head, evidence: BR, summary: "改了首页", selfCheck: "逐条对了" } });

async function claimed(): Promise<string> {
  const r = await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
  expect(r).toMatchObject({ ok: true });
  expect(await call("claim", { v: 1, orderId: r.orderId, worker: WORKER })).toMatchObject({ ok: true });
  return r.orderId;
}
/** 开工单交付到 review（head H2），写租约留在 mate */
async function built(): Promise<string> {
  const orderId = await claimed();
  remote[BR] = { ok: true, head: H2 };
  expect(await call("write", deliverBody(orderId, H2))).toMatchObject({ ok: true });
  return orderId;
}
/** 审查不过进 fix，修复单派回 mate 并领走；起点 head 是 H2 */
async function fixOrder(): Promise<string> {
  await built();
  const path = join(dir, "T9-r0.md");
  writeFileSync(path, "## P1\n- race-1：并发写丢数据");
  insertEvent(db, { actor: "agent-rev", now }, { project: P, target: "T9", kind: "review", text: "changes",
    data: { round: 0, verdict: "changes", path, findings: [{ findingId: "race-1", family: "concurrency", severity: "P1", probe: "两进程同时写" }] } }, true);
  db.run("UPDATE tasks SET stage = 'fix', round = 1 WHERE id = 'T9'");
  return claimed();
}

// ── PNG 夹具：块 = 长度 + 类型 + 数据 + CRC（收图不验 CRC，填 0） ──
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type: string, data: Uint8Array): Buffer {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "latin1");
  b.set(data, 8);
  return b;
}
function ihdr(w: number, h: number, len = 13): Buffer {
  const d = Buffer.alloc(len);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  return chunk("IHDR", d);
}
const END = chunk("IEND", Buffer.alloc(0));
const png = (seed: string, w = 390, h = 844): Buffer => Buffer.concat([SIG, ihdr(w, h), chunk("IDAT", Buffer.from(seed)), END]);
/** 带 tEXt 块和 IEND 之后的尾巴：落盘后两者都不该在 */
const dirty = (seed: string): Buffer => Buffer.concat([SIG, ihdr(390, 844), chunk("tEXt", Buffer.from("Comment\0SECRET-NOTE")), chunk("IDAT", Buffer.from(seed)), END,
  Buffer.from("TRAILING-ZIP")]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const imported = () => uiDeliverPort({ root }).roots.imported;
const orderDir = (orderId: string, peer = "mate") => join(imported(), peer, orderId.replaceAll(":", "_"));
/** 目录树逐字节 + 权限 + 修改时间；根还没建 = "none" */
function tree(at = root): string {
  if (!existsSync(at)) return "none";
  const walk = (d: string): string[] => readdirSync(d).sort().flatMap((n) => {
    const p = join(d, n), st = lstatSync(p);
    return st.isDirectory() ? [`${p}/`, ...walk(p)] : [`${p} ${st.mode.toString(8)} ${st.mtimeMs} ${st.isSymbolicLink() ? "link" : sha(readFileSync(p))}`];
  });
  return walk(at).join("\n");
}

const mate = { id: "token:t", role: "external", agents: [], createdAt: "", peer: "mate" } as unknown as Principal;
const api = () => lendShotApi({ refusal: () => null, db: () => db, log: (l) => logs.push(l), now: () => now, importedRoot: imported(),
  mode: () => { duringReceive?.(); return mode; } });
interface Slot { view?: string; size?: string; phase?: string; head?: string; gen?: number }
const shotBody = (orderId: string, bytes: Uint8Array, s: Slot = {}) => lendShotBody({ orderId, gen: s.gen ?? 1, head: s.head ?? H2, view: s.view ?? "home",
  size: s.size ?? "390x844", phase: (s.phase ?? "before") as "before" }, bytes);
async function post(body: string, principal = mate, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, any> }> {
  const res = await api()(new Request("http://x/api/v1/lend/shot", { method: "POST", body, headers }), "/lend/shot", principal);
  return { status: res!.status, body: await res!.json() as Record<string, any> };
}
const upload = (orderId: string, bytes: Uint8Array, s: Slot = {}, principal = mate) => post(shotBody(orderId, bytes, s), principal);

function newCard(template: "ui" | "code" = "ui") {
  const spec = join(dir, "T9.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", spec, agent: "agent-dev" } as never);
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T9'");
  db.run(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('T9', ?, ?, 3, 'manual', 'codex', '', 1, 1, 1)`, [P, template]);
}

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  remote = { main: { ok: true, head: BASE } };
  root = join(mkdtempSync(join(tmpdir(), "lend-ui-root-")), "ui-artifacts");
  mode = "observe";
  logs = [];
  duringReceive = null;
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  newCard();
});
afterEach(() => closeLedger(":memory:"));

describe("[验收线 1] 收图成功", () => {
  test("开工单：落盘的是去元数据后的字节，0600，provenance 记来源与槽位；重传、冲突、第 17 个槽位", async () => {
    const orderId = await claimed();
    const input = dirty("before-pixels");
    const kept = (stripImageMeta(input) as { data: Uint8Array }).data;
    const r = await upload(orderId, input);
    expect(r).toEqual({ status: 200, body: { ok: true, v: 1, ref: "s01.png", sha256: sha(kept), bytes: kept.length, width: 390, height: 844 } });
    const file = join(orderDir(orderId), "s01.png");
    const stored = readFileSync(file);
    expect(stored.equals(kept)).toBe(true);
    expect([stored.includes("tEXt"), stored.includes("SECRET-NOTE"), stored.includes("TRAILING-ZIP"), input.includes("SECRET-NOTE")]).toEqual([false, false, false, true]);
    expect(sha(stored)).toBe(r.body.sha256);
    expect([statSync(file).mode & 0o777, statSync(join(orderDir(orderId), "provenance.json")).mode & 0o777]).toEqual([0o600, 0o600]);
    for (const d of [imported(), join(imported(), "mate"), orderDir(orderId)]) expect(statSync(d).mode & 0o777).toBe(0o700);
    expect((await upload(orderId, png("after-pixels"), { phase: "after" })).body).toMatchObject({ ok: true, ref: "s02.png" });
    const prov = readLendUiProvenance(orderDir(orderId));
    expect(prov).toMatchObject({ status: "ok", data: { v: 1, peer: "mate", worker: WORKER, orderId, head: H2, files: {
      "s01.png": { sha256: sha(kept), bytes: kept.length, width: 390, height: 844, view: "home", size: "390x844", phase: "before", receivedAt: now },
      "s02.png": { sha256: sha(png("after-pixels")), view: "home", size: "390x844", phase: "after" } } } });
    expect(readdirSync(orderDir(orderId)).sort()).toEqual(["provenance.json", "s01.png", "s02.png"]);

    const before = tree();
    now += 5000;
    expect((await upload(orderId, input)).body).toEqual(r.body); // 同槽位同字节：原来的 ref，不重写（修改时间在 tree 里）
    expect((await upload(orderId, kept)).body).toEqual(r.body); // 「同字节」按落盘字节算：只差元数据 / 尾巴的重传也是同一张
    expect((await upload(orderId, png("other-pixels"))).body).toMatchObject({ ok: false, code: "conflict" });
    expect(await upload(orderId, png("x"), { view: "list", head: H3 })).toMatchObject({ status: 409, body: { code: "conflict" } });
    expect(tree()).toBe(before);
    expect(logs.map((l) => l.split(" ")[4])).toEqual(["s01.png", "s02.png"]); // 收图日志按 ref 计数：重传、冲突都不多记

    for (let i = 0; i < 7; i++) for (const phase of ["before", "after"]) expect((await upload(orderId, png(`v${i}-${phase}`), { view: `v${i}`, phase })).body.ok).toBe(true);
    expect(Object.keys((readLendUiProvenance(orderDir(orderId)) as { data: { files: object } }).data.files)).toHaveLength(LEND_SHOT_LIMITS.slots);
    expect(readdirSync(orderDir(orderId))).toContain("s16.png");
    const full = tree();
    expect(await upload(orderId, png("one-too-many"), { view: "extra" })).toMatchObject({ status: 409, body: { code: "conflict" } });
    expect(tree()).toBe(full);
  });

  test("修复单同样收：文件在这一单自己的目录下；清单规则认这两张图", async () => {
    const orderId = await fixOrder();
    const shots = [];
    for (const phase of ["before", "after"] as const) {
      const r = await upload(orderId, png(`fix-${phase}`), { head: H3, phase });
      expect(r.status).toBe(200);
      shots.push({ view: "home", size: "390x844", phase, ref: r.body.ref as string, sha256: r.body.sha256 as string });
    }
    expect(shots.map((s) => s.ref)).toEqual(["s01.png", "s02.png"]);
    expect(readLendUiProvenance(orderDir(orderId))).toMatchObject({ status: "ok", data: { orderId, head: H3, worker: WORKER } });
    const e = { v: 1 as const, taskId: "T9", head: H3, specRev: 1, round: 2, source: "imported" as const, summary: "首页前后", shots };
    expect(parseUiEvidence({ ...e, digest: uiEvidenceDigest(e) }).shots).toHaveLength(2); // 回的 ref 就是清单认的相对路径
  });
});

describe("[验收线 1] 两次写之间断掉留下的残留", () => {
  test("没记进 provenance 的 sNN.png 是残留：槽号只看 provenance，重传拿到同一个号并覆盖它，provenance 与文件一致", async () => {
    const orderId = await claimed();
    expect((await upload(orderId, png("b"))).body.ref).toBe("s01.png");
    writeFileSync(join(orderDir(orderId), "s02.png"), "写完图、没写上记录就断了"); // 图已 rename、provenance 还是旧的
    const r = await upload(orderId, png("a"), { phase: "after" });
    expect(r.body).toMatchObject({ ok: true, ref: "s02.png", sha256: sha(png("a")) });
    expect(readFileSync(join(orderDir(orderId), "s02.png")).equals(png("a"))).toBe(true);
    const files = (readLendUiProvenance(orderDir(orderId)) as { data: { files: Record<string, { sha256: string }> } }).data.files;
    expect(Object.entries(files).map(([ref, f]) => [ref, f.sha256 === sha(readFileSync(join(orderDir(orderId), ref)))])).toEqual([["s01.png", true], ["s02.png", true]]);
  });

  test("provenance.json 读不出 / 不是 JSON / 字段不对 / 是软链 → unavailable，零写入，不自动修", async () => {
    const orderId = await claimed();
    expect((await upload(orderId, png("b"))).status).toBe(200);
    const at = join(orderDir(orderId), "provenance.json"), good = readFileSync(at, "utf8");
    for (const bad of ["{ 坏的", JSON.stringify({ ...JSON.parse(good), extra: 1 }), good.replace('"s01.png"', '"../x.png"'), good.replace('"before"', '"during"')]) {
      writeFileSync(at, bad);
      const before = tree();
      expect(await upload(orderId, png("a"), { phase: "after" })).toMatchObject({ status: 503, body: { ok: false, code: "unavailable" } });
      expect(tree()).toBe(before);
    }
    const elsewhere = join(mkdtempSync(join(tmpdir(), "lend-ui-elsewhere-")), "p.json");
    writeFileSync(elsewhere, good);
    rmSync(at);
    symlinkSync(elsewhere, at);
    const before = tree();
    expect(await upload(orderId, png("a"), { phase: "after" })).toMatchObject({ status: 503, body: { code: "unavailable" } });
    expect([tree(), readFileSync(elsewhere, "utf8")]).toEqual([before, good]);
  });
});

describe("[验收线 1] 来源记录里收图规则产生不了的值", () => {
  test("bytes / 宽 / 高越过收图上限、槽号有缺口、两个 ref 同一槽位 → 同槽位重传和新槽位都回 unavailable，零写入", async () => {
    const orderId = await claimed();
    expect((await upload(orderId, png("b"))).body.ref).toBe("s01.png");
    expect((await upload(orderId, png("a"), { phase: "after" })).body.ref).toBe("s02.png");
    const at = join(orderDir(orderId), "provenance.json"), good = JSON.parse(readFileSync(at, "utf8"));
    const s01 = (over: Record<string, unknown>) => ({ ...good, files: { ...good.files, "s01.png": { ...good.files["s01.png"], ...over } } });
    const damaged: Record<string, unknown> = {
      "宽 4097": s01({ width: LEND_SHOT_LIMITS.width + 1 }), "宽 0": s01({ width: 0 }),
      "高 16385": s01({ height: LEND_SHOT_LIMITS.height + 1 }), "高 0": s01({ height: 0 }),
      "bytes 超 1 MiB": s01({ bytes: LEND_SHOT_LIMITS.png + 1 }), "bytes 0": s01({ bytes: 0 }),
      "槽号有缺口": { ...good, files: { "s02.png": good.files["s02.png"] } },
      "两个 ref 同一槽位": s01({ phase: "after" }),
    };
    for (const [what, bad] of Object.entries(damaged)) {
      writeFileSync(at, `${JSON.stringify(bad, null, 2)}\n`);
      const before = tree();
      for (const again of [upload(orderId, png("a"), { phase: "after" }), upload(orderId, png("n"), { view: "settings" })]) {
        const r = await again;
        expect({ what, status: r.status, code: r.body.code }).toEqual({ what, status: 503, code: "unavailable" });
      }
      expect(tree()).toBe(before);
    }
    writeFileSync(at, `${JSON.stringify(s01({ width: LEND_SHOT_LIMITS.width, height: LEND_SHOT_LIMITS.height, bytes: LEND_SHOT_LIMITS.png }), null, 2)}\n`);
    expect((await upload(orderId, png("b"))).body).toMatchObject({ ok: true, ref: "s01.png", width: LEND_SHOT_LIMITS.width }); // 上限本身是合法值
  });
});

describe("[验收线 2] 拒收零写入", () => {
  test("两次上传排队，第一次处理期间撤单 → 第二次轮到时重核，回 not_held，目录不变", async () => {
    const orderId = await claimed();
    let after = "";
    duringReceive = () => {
      duringReceive = () => { after = tree(); }; // 第二次若走到这里就是没重核
      db.run("UPDATE lend_orders SET status = 'cancelled' WHERE orderId = ?", [orderId]);
    };
    const [first, second] = await Promise.all([upload(orderId, png("b")), upload(orderId, png("a"), { phase: "after" })]);
    expect([first.status, second.status, second.body.code, after]).toEqual([200, 409, "not_held", ""]);
    expect(readdirSync(orderDir(orderId)).sort()).toEqual(["provenance.json", "s01.png"]);
    expect(logs).toHaveLength(1);
  });


  test("不是 PNG / PNG 结构不对 / 尺寸越界 / 过大 / base64 不规范 / 字段与槽位不合规则", async () => {
    const orderId = await claimed();
    expect((await upload(orderId, png("kept"))).status).toBe(200);
    const before = tree();
    const ok = JSON.parse(shotBody(orderId, png("p"), { phase: "after" })) as Record<string, unknown>;
    const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
    const withPng = (b: Uint8Array) => ({ ...ok, png: b64(b) });
    const big = Buffer.concat([SIG, ihdr(390, 844), chunk("IDAT", Buffer.alloc(LEND_SHOT_LIMITS.png)), END]);
    const { png: _png, ...noPng } = ok;
    const cases: [string, unknown, number][] = [
      ["jpeg", withPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9])), 400],
      ["webp", withPng(Buffer.from("RIFF\x04\0\0\0WEBPVP8 ", "latin1")), 400],
      ["svg", withPng(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")), 400],
      ["随机字节", withPng(Buffer.from(sha(Buffer.from("noise")), "hex")), 400],
      ["首块不是 IHDR", withPng(Buffer.concat([SIG, chunk("tEXt", Buffer.alloc(13)), ihdr(390, 844), END])), 400],
      ["IHDR 不是 13 字节", withPng(Buffer.concat([SIG, ihdr(390, 844, 12), chunk("IDAT", Buffer.from("p")), END])), 400],
      ["走不到 IEND", withPng(Buffer.concat([SIG, ihdr(390, 844), chunk("IDAT", Buffer.from("p"))])), 400],
      ["块长度越界", withPng(Buffer.concat([SIG, ihdr(390, 844), chunk("IDAT", Buffer.from("p")).subarray(0, 10)])), 400],
      ["宽 0", withPng(png("p", 0, 844)), 400], ["宽 4097", withPng(png("p", 4097, 844)), 400],
      ["高 0", withPng(png("p", 390, 0)), 400], ["高 16385", withPng(png("p", 390, 16385)), 400],
      ["解码后超 1 MiB", withPng(big), 413],
      ["base64 没填充", { ...ok, png: b64(png("pp")).replace(/=+$/, "") }, 400], ["url-safe base64", { ...ok, png: `${b64(png("p")).slice(0, -4)}-_==` }, 400],
      ["base64 带换行", { ...ok, png: `${b64(png("p"))}\n` }, 400], ["base64 尾位非零", { ...ok, png: `${b64(png("ppp")).slice(0, -4)}QR==` }, 400],
      ["空图", { ...ok, png: "" }, 400], ["png 不是字符串", { ...ok, png: 7 }, 400],
      ["多字段", { ...ok, path: "../../x.png" }, 400], ["带摘要", { ...ok, sha256: sha(png("p")) }, 400], ["少字段", noPng, 400],
      ["gen 是字符串", { ...ok, gen: "1" }, 400], ["v 不是 1", { ...ok, v: 2 }, 400], ["head 大写", { ...ok, head: H2.toUpperCase() }, 400],
      ["head 短", { ...ok, head: H2.slice(0, 12) }, 400], ["view 带斜杠", { ...ok, view: "a/b" }, 400], ["view 空", { ...ok, view: "" }, 400],
      ["size 不是 WxH", { ...ok, size: "390" }, 400], ["size 0 开头", { ...ok, size: "0390x844" }, 400], ["phase 不认识", { ...ok, phase: "during" }, 400],
      ["数组", [ok], 400], ["不是 JSON", "{", 400],
    ];
    for (const [why, body, status] of cases) {
      const r = await post(typeof body === "string" ? body : JSON.stringify(body));
      expect({ why, status: r.status, code: r.body.code }).toEqual({ why, status, code: status === 413 ? "too_large" : "invalid" });
      expect(tree()).toBe(before);
    }
    expect(parseLendShot(ok)).toMatchObject({ ok: true }); // 反例都只差一处：原样的这一份是合法的
    expect(logs).toHaveLength(1);
  });

  test("请求体超过 1.5 MiB：Content-Length 先挡，头不带 / 说小了按实际字节挡，都是 413", async () => {
    const orderId = await claimed();
    const small = shotBody(orderId, png("p"));
    expect(await post(small, mate, { "content-length": String(LEND_SHOT_LIMITS.body + 1) })).toMatchObject({ status: 413, body: { ok: false, code: "too_large" } });
    const padded = `${small.slice(0, -1)}, "pad": "${"x".repeat(LEND_SHOT_LIMITS.body)}"}`;
    expect(await post(padded)).toMatchObject({ status: 413, body: { code: "too_large" } });
    expect(await post(padded, mate, { "content-length": "10" })).toMatchObject({ status: 413, body: { code: "too_large" } });
    expect(tree()).toBe("none");
  });

  test("不是持单 peer、代数旧、起点 head、租约过期、写租约不在它名下、非 ui 卡、已撤单 → 不建目录", async () => {
    const orderId = await claimed();
    const other = { ...mate, peer: "other" } as Principal;
    expect(await upload(orderId, png("p"), {}, other)).toMatchObject({ status: 409, body: { ok: false, code: "not_held" } });
    expect(await upload(orderId, png("p"), { gen: 2 })).toMatchObject({ status: 409, body: { code: "not_held" } });
    expect(await upload("lend:T9:s1:r0:a9", png("p"))).toMatchObject({ status: 409, body: { code: "not_held" } });
    expect(await upload(orderId, png("p"), { head: BASE })).toMatchObject({ status: 400, body: { code: "invalid" } });
    db.run("UPDATE lend_write_leases SET peer = 'other' WHERE taskId = 'T9'");
    expect(await upload(orderId, png("p"))).toMatchObject({ status: 409, body: { code: "not_held" } });
    db.run("UPDATE lend_write_leases SET peer = 'mate', state = 'ended' WHERE taskId = 'T9'");
    expect(await upload(orderId, png("p"))).toMatchObject({ status: 409, body: { code: "not_held" } });
    db.run("UPDATE lend_write_leases SET state = 'held' WHERE taskId = 'T9'");
    db.run("UPDATE task_workflows SET template = 'code' WHERE taskId = 'T9'");
    expect(await upload(orderId, png("p"))).toMatchObject({ status: 400, body: { code: "invalid" } });
    db.run("UPDATE task_workflows SET template = 'ui' WHERE taskId = 'T9'");
    db.run("UPDATE tasks SET specRev = 2 WHERE id = 'T9'"); // 卡已不是这一单切出来时的样子
    expect(await upload(orderId, png("p"))).toMatchObject({ status: 409, body: { code: "not_held" } });
    db.run("UPDATE tasks SET specRev = 1 WHERE id = 'T9'");
    const saved = now;
    now = listLendOrders(db, "T9")[0]!.leaseUntil! + 1;
    expect(await upload(orderId, png("p"))).toMatchObject({ status: 409, body: { code: "not_held" } });
    now = saved;
    expect(await run(["lend-reclaim", "T9", "--reason", "收回"])).toMatchObject({ ok: true });
    expect(await upload(orderId, png("p"))).toMatchObject({ status: 409, body: { code: "not_held" } });
    expect(tree()).toBe("none");
    expect(logs).toEqual([]);
  });

  test("单已交付、审查单 → 拒，已有目录与 provenance 逐字节不变", async () => {
    const orderId = await claimed();
    expect((await upload(orderId, png("kept"))).status).toBe(200);
    const before = tree();
    remote[BR] = { ok: true, head: H2 };
    expect(await call("write", deliverBody(orderId, H2))).toMatchObject({ ok: true });
    expect(await upload(orderId, png("late"), { phase: "after" })).toMatchObject({ status: 409, body: { code: "not_held" } });
    const offered = await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO, "--family", "claude"]); // 卡在 review：这一张是审查单
    const review = offered.orderId as string;
    expect(await call("claim", { v: 1, orderId: review, worker: WORKER })).toMatchObject({ ok: true });
    expect(listLendOrders(db, "T9").find((o) => o.orderId === review)).toMatchObject({ step: "review", status: "claimed" });
    expect(await upload(review, png("p"), { head: H3 })).toMatchObject({ status: 400, body: { code: "invalid" } });
    expect(tree()).toBe(before);
  });

  test("目标目录任一层是软链 / 不是目录 → unavailable，不跟随，软链指向的位置没有新文件", async () => {
    const orderId = await claimed();
    const [peerDir, order] = [join(imported(), "mate"), orderDir(orderId)];
    for (const layer of [imported(), peerDir, order]) {
      root = join(mkdtempSync(join(tmpdir(), "lend-ui-root-")), "ui-artifacts");
      const at = layer.replace(/^.*\/ui-artifacts/, root), elsewhere = mkdtempSync(join(tmpdir(), "lend-ui-elsewhere-"));
      mkdirSync(join(at, ".."), { recursive: true });
      symlinkSync(elsewhere, at);
      const before = tree();
      expect(await upload(orderId, png("p"))).toMatchObject({ status: 503, body: { ok: false, code: "unavailable" } });
      expect([readdirSync(elsewhere), tree()]).toEqual([[], before]);
    }
    root = join(mkdtempSync(join(tmpdir(), "lend-ui-root-")), "ui-artifacts");
    mkdirSync(imported(), { recursive: true });
    writeFileSync(join(imported(), "mate"), "不是目录");
    const before = tree();
    const r = await upload(orderId, png("p"));
    expect(r).toMatchObject({ status: 503, body: { code: "unavailable" } });
    expect(r.body.error).not.toContain(root); // 回包不带本机路径
    expect(tree()).toBe(before);
  });

  test("已收过图的目录事后成了软链：同槽位同图的重传也拒，不顺着软链读来源记录；新槽位同样拒", async () => {
    const orderId = await claimed();
    expect((await upload(orderId, png("p"))).body).toMatchObject({ ok: true, ref: "s01.png" });
    const [peerDir, order] = [join(imported(), "mate"), orderDir(orderId)];
    for (const layer of [order, peerDir, imported()]) {
      const moved = join(mkdtempSync(join(tmpdir(), "lend-ui-elsewhere-")), "moved");
      renameSync(layer, moved);
      symlinkSync(moved, layer);
      const [before, kept] = [tree(), tree(moved)];
      logs = [];
      for (const r of [await upload(orderId, png("p")), await upload(orderId, png("q"), { phase: "after" })]) {
        expect(r).toMatchObject({ status: 503, body: { ok: false, code: "unavailable" } });
        expect(r.body.error).not.toContain(root);
      }
      expect([tree(), tree(moved), logs]).toEqual([before, kept, []]);
      rmSync(layer);
      renameSync(moved, layer);
    }
    expect((await upload(orderId, png("p"))).body).toMatchObject({ ok: true, ref: "s01.png" }); // 目录换回真目录，重传照旧认
  });

  test("lendUiShots：off 回 403 零写入；observe / on 照收，各一行日志，没有图片内容", async () => {
    const orderId = await claimed();
    mode = "off";
    expect(await upload(orderId, png("p"))).toMatchObject({ status: 403, body: { ok: false, code: "shots_off" } });
    expect([tree(), logs]).toEqual(["none", []]);
    const text = { before: shotBody(orderId, png("b")), after: shotBody(orderId, png("a"), { phase: "after" }) };
    mode = "observe";
    expect((await post(text.before)).status).toBe(200);
    mode = "on";
    expect((await post(text.after)).status).toBe(200);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain(`mate ${orderId} s01.png ${png("b").length} 字节 390x844 lendUiShots=observe`);
    expect(logs[1]).toContain("s02.png");
    expect(logs[1]).toContain("lendUiShots=on");
    for (const l of logs) for (const t of Object.values(text)) expect(l).not.toContain((JSON.parse(t) as { png: string }).png.slice(0, 24));
  });
});

describe("[验收线 2] 闸与路由", () => {
  const peer = (p: string | undefined): Principal => ({ id: "token:t", role: "external", agents: [], createdAt: "", ...(p ? { peer: p } : {}) }) as Principal;
  const req = (e2e: boolean, headers: Record<string, string> = {}, method = "POST") => {
    const r = new Request("http://x/api/v1/lend/shot", { method, ...(method === "POST" ? { body: "{}" } : {}), headers });
    setRequestContext(r, { source: "peer-ingress", clientIp: null, https: false, ...(e2e ? { e2e: { peerFp: "f" } } : {}) });
    return r;
  };
  const status = async (r: Promise<Response | null>) => {
    const res = await r;
    return res ? [res.status, ((await res.json()) as { code?: string }).code] : null;
  };
  const signed = { "x-claudestra-key": "k".repeat(43), "x-claudestra-sig": "s" };

  test("非 peer、邀请 token、非 E2E、没钉钥（签了也不算）一律 401，碰不到台账", async () => {
    expect(await status(handleLendShotApi(req(true, signed), "/lend/shot", peer(undefined)))).toEqual([401, "unauthorized"]);
    expect(await status(handleLendShotApi(req(true, signed), "/lend/shot", peer("invite:x")))).toEqual([401, "unauthorized"]);
    expect(await status(handleLendShotApi(req(false, signed), "/lend/shot", peer("mate")))).toEqual([401, "unauthorized"]);
    expect(await status(handleLendShotApi(req(true, signed), "/lend/shot", peer("never-pinned")))).toEqual([401, "unauthorized"]);
    expect(await status(handleLendShotApi(req(true), "/lend/shot", peer("never-pinned")))).toEqual([401, "unauthorized"]);
  });

  test("只认 POST /lend/shot 这一条；messages-only token 的白名单只多这一个词", async () => {
    expect(await handleLendShotApi(req(true, signed), "/lend/shot/x", peer("mate"))).toBeNull();
    expect(await handleLendShotApi(req(true, signed), "/lend/shots", peer("mate"))).toBeNull();
    expect((await handleLendShotApi(req(true, signed, "GET"), "/lend/shot", peer("mate")))!.status).toBe(405);
    expect(messagesOnlyAllows("POST", "/api/v1/lend/shot")).toBe(true);
    expect([messagesOnlyAllows("POST", "/api/v1/lend/shot/x"), messagesOnlyAllows("GET", "/api/v1/lend/shot"), messagesOnlyAllows("POST", "/api/v1/lend/shots")])
      .toEqual([false, false, false]);
  });
});

describe("[验收线 5] 恢复键 lendUiShots", () => {
  test("恰好一次、紧跟 auditIdleFacts；没配是 observe；策略文件坏了按 off", () => {
    expect(RECOVERY_KEYS.filter((k) => k === "lendUiShots")).toHaveLength(1);
    expect(RECOVERY_KEYS.indexOf("lendUiShots")).toBe(RECOVERY_KEYS.indexOf("auditIdleFacts") + 1);
    const path = join(mkdtempSync(join(tmpdir(), "lend-ui-policy-")), "recovery-policy.json");
    expect(recoveryPolicy(P, "lendUiShots", path)).toMatchObject({ mode: "observe", source: "default" });
    writeFileSync(path, JSON.stringify({ projects: { [P]: { keys: { lendUiShots: "on" } } } }));
    expect(recoveryPolicy(P, "lendUiShots", path).mode).toBe("on");
    expect(recoveryPolicy(P, "uiDelivery", path).mode).toBe("observe"); // 两个键各管各的
    writeFileSync(path, "{ 坏的");
    expect(recoveryPolicy(P, "lendUiShots", path)).toMatchObject({ mode: "off", source: "error" });
  });
});
